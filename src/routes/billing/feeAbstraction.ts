import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { Asset, StrKey } from '@stellar/stellar-sdk';

import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  InternalServerError,
  NotFoundError,
  UnauthorizedError,
} from '../../errors/index.js';
import { requireAuth, type AuthenticatedLocals } from '../../middleware/requireAuth.js';
import { validate } from '../../middleware/validate.js';
import { logger } from '../../logger.js';
import { calloraEvents } from '../../events/event.emitter.js';
import { env } from '../../config/env.js';
import { config } from '../../config/index.js';
import {
  calculateFeeQuote,
  createFeeBumpTransaction,
  FeeBumperConfigError,
  FeeBumperInvalidTransactionError,
  FeeBumperSigningError,
} from '../../services/feeBumper.js';
import {
  consumeQuoteAndSign,
  createFeeQuote,
  formatAppTokenAmount,
  innerTransactionHash,
  loadFeeQuote,
  loadSenderAddress,
  quotePaymentMemoHash,
  verifyAppTokenPayment,
} from '../../services/feeAbstractionPayment.js';

/** Public JSON and event payloads carry stroops as numbers: refuse rather than round. */
function stroopsToJsonNumber(stroops: bigint): number {
  if (stroops > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`fee stroops ${stroops} exceed Number.MAX_SAFE_INTEGER`);
  }
  return Number(stroops);
}

export interface FeeAbstractionPaymentSettings {
  horizonUrl: string;
  treasuryAddress: string;
  appTokenAssetCode: string;
  appTokenIssuer: string;
  quoteTtlSeconds: number;
  verifyTimeoutMs: number;
}

export interface FeeAbstractionRouterOptions {
  /** Chain transport for Horizon payment verification; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Overrides the env-derived payment settings. */
  payment?: Partial<FeeAbstractionPaymentSettings>;
}

function envPaymentSettings(): FeeAbstractionPaymentSettings {
  return {
    horizonUrl: config.stellar.horizonUrl,
    treasuryAddress: env.FEE_ABSTRACTION_TREASURY_ADDRESS ?? '',
    appTokenAssetCode: env.FEE_ABSTRACTION_APP_TOKEN_ASSET_CODE,
    appTokenIssuer: env.FEE_ABSTRACTION_APP_TOKEN_ISSUER ?? '',
    quoteTtlSeconds: env.FEE_ABSTRACTION_QUOTE_TTL_SECONDS,
    verifyTimeoutMs: env.FEE_ABSTRACTION_PAYMENT_VERIFY_TIMEOUT_MS,
  };
}

/** The app-token asset must be a valid Stellar credit asset (code + issuer), checked by the SDK. */
function isValidAppTokenAsset(code: string, issuer: string): boolean {
  try {
    return new Asset(code, issuer).code === code;
  } catch {
    return false;
  }
}

/** Fails closed: payments cannot be quoted or executed without real trust anchors. */
function resolvePaymentSettings(overrides: Partial<FeeAbstractionPaymentSettings> | undefined): FeeAbstractionPaymentSettings {
  const settings = { ...envPaymentSettings(), ...overrides };
  const missing: string[] = [];
  if (!StrKey.isValidEd25519PublicKey(settings.treasuryAddress)) {
    missing.push('FEE_ABSTRACTION_TREASURY_ADDRESS');
  }
  if (!StrKey.isValidEd25519PublicKey(settings.appTokenIssuer)) {
    missing.push('FEE_ABSTRACTION_APP_TOKEN_ISSUER');
  } else if (!isValidAppTokenAsset(settings.appTokenAssetCode, settings.appTokenIssuer)) {
    missing.push('FEE_ABSTRACTION_APP_TOKEN_ASSET_CODE');
  }
  if (missing.length > 0) {
    throw new InternalServerError(
      `Fee-abstraction payments are not configured: ${missing.join(', ')} must be set to a Stellar public key`,
    );
  }
  if (config.billingTimeoutMs > 0 && settings.verifyTimeoutMs >= config.billingTimeoutMs) {
    throw new InternalServerError(
      `Fee-abstraction verification budget (${settings.verifyTimeoutMs} ms) must be below the billing request deadline (${config.billingTimeoutMs} ms)`,
    );
  }
  return settings;
}

function getPool(req: Request): Pool {
  const pool = req.app?.locals?.dbPool as Pool | undefined;
  if (!pool) {
    throw new InternalServerError('Database pool is not configured');
  }
  return pool;
}

export function createFeeAbstractionRouter(options: FeeAbstractionRouterOptions = {}): Router {
  const router = Router();

  const quoteBodySchema = z.object({
    innerXdr: z.string().min(1, 'innerXdr is required'),
  });

  const executeBodySchema = z.object({
    quoteId: z.uuid('quoteId must be a UUID'),
    innerXdr: z.string().min(1, 'innerXdr is required'),
    appTokenPaymentTxId: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, 'appTokenPaymentTxId must be a 64-character hex transaction hash'),
  });

  /**
   * POST /api/billing/fee-abstraction/quote
   * Persists a pending single-use quote and returns the payment instructions bound to it.
   */
  router.post(
    '/quote',
    requireAuth,
    validate({ body: quoteBodySchema }),
    async (
      req: Request,
      res: Response<unknown, AuthenticatedLocals>,
      next: NextFunction,
    ): Promise<void> => {
      try {
        const user = res.locals.authenticatedUser;
        if (!user) {
          next(new UnauthorizedError());
          return;
        }

        const settings = resolvePaymentSettings(options.payment);
        const pool = getPool(req);
        const senderAddress = await loadSenderAddress(pool, user.id);
        if (!senderAddress || !StrKey.isValidEd25519PublicKey(senderAddress)) {
          throw new ForbiddenError('A valid Stellar account must be bound to this user before quoting');
        }
        const { innerXdr } = req.body as z.infer<typeof quoteBodySchema>;

        logger.info('Fee-abstraction quote requested', { userId: user.id });

        const quote = calculateFeeQuote(innerXdr);
        const now = new Date();
        const { id, expiresAt } = await createFeeQuote(pool, {
          userId: user.id,
          innerTxHash: innerTransactionHash(innerXdr, quote.network),
          feeStroops: quote.feeBumpFeeStroops,
          appTokenAmountUnits: BigInt(quote.appTokenAmount),
          network: quote.network,
          ttlSeconds: settings.quoteTtlSeconds,
          now,
        });

        res.status(200).json({
          quoteId: id,
          expiresAt: expiresAt.toISOString(),
          baseFeeStroops: stroopsToJsonNumber(quote.baseFeeStroops),
          feeBumpFeeStroops: stroopsToJsonNumber(quote.feeBumpFeeStroops),
          feeBumpFeeXlm: quote.feeBumpFeeXlm,
          appTokenAmount: formatAppTokenAmount(BigInt(quote.appTokenAmount)),
          appTokenAssetCode: settings.appTokenAssetCode,
          appTokenIssuer: settings.appTokenIssuer,
          treasuryAddress: settings.treasuryAddress,
          paymentMemoHashHex: quotePaymentMemoHash(id).toString('hex'),
          network: quote.network,
        });
      } catch (err) {
        if (err instanceof FeeBumperInvalidTransactionError) {
          next(new BadRequestError(err.message, 'VALIDATION_ERROR'));
          return;
        }
        next(err);
      }
    },
  );

  /**
   * POST /api/billing/fee-abstraction
   * Verifies the quote's app-token payment on-chain, consumes the quote, and signs the
   * fee-bump at the quoted fee. Nothing is signed unless every check passes.
   */
  router.post(
    '/',
    requireAuth,
    validate({ body: executeBodySchema }),
    async (
      req: Request,
      res: Response<unknown, AuthenticatedLocals>,
      next: NextFunction,
    ): Promise<void> => {
      try {
        const user = res.locals.authenticatedUser;
        if (!user) {
          next(new UnauthorizedError());
          return;
        }

        const { quoteId, innerXdr, appTokenPaymentTxId } = req.body as z.infer<typeof executeBodySchema>;
        const paymentTxHash = appTokenPaymentTxId.toLowerCase();
        const settings = resolvePaymentSettings(options.payment);
        const pool = getPool(req);

        logger.info('Fee-abstraction execution requested', {
          userId: user.id,
          quoteId,
          appTokenPaymentTxId: paymentTxHash,
        });

        const quote = await loadFeeQuote(pool, quoteId);
        if (!quote || quote.userId !== user.id) {
          throw new NotFoundError('Fee-abstraction quote not found');
        }
        if (quote.status !== 'pending') {
          throw new ConflictError('Fee-abstraction quote has already been used');
        }
        // Fast-fail before chain I/O; the authoritative expiry check is the database clock in consume.
        if (quote.expiresAt.getTime() <= Date.now()) {
          throw new ConflictError('Fee-abstraction quote has expired; request a new quote');
        }
        if (quote.network !== config.stellar.network) {
          throw new ConflictError('Fee-abstraction quote was issued for a different network');
        }
        if (innerTransactionHash(innerXdr, quote.network) !== quote.innerTxHash) {
          throw new BadRequestError('innerXdr does not match the quoted transaction', 'VALIDATION_ERROR');
        }

        // Reject policy drift: the fee the quote charged must be the fee the signer will charge.
        const current = calculateFeeQuote(innerXdr);
        if (
          current.feeBumpFeeStroops !== quote.feeStroops ||
          BigInt(current.appTokenAmount) !== quote.appTokenAmountUnits
        ) {
          throw new ConflictError('Fee quote no longer matches the transaction; request a new quote');
        }

        const senderAddress = await loadSenderAddress(pool, user.id);
        if (!senderAddress) {
          throw new ForbiddenError('No Stellar account is bound to this user');
        }

        await verifyAppTokenPayment(
          {
            paymentTxHash,
            quoteId,
            senderAddress,
            treasuryAddress: settings.treasuryAddress,
            assetCode: settings.appTokenAssetCode,
            assetIssuer: settings.appTokenIssuer,
            amountUnits: quote.appTokenAmountUnits,
            quotedAt: quote.createdAt,
          },
          {
            horizonUrl: settings.horizonUrl,
            timeoutMs: settings.verifyTimeoutMs,
            fetchImpl: options.fetchImpl,
            signal: req.abortSignal,
          },
        );

        const result = await consumeQuoteAndSign(
          pool,
          {
            quoteId,
            userId: user.id,
            paymentTxHash,
            feeStroops: quote.feeStroops,
            signal: req.abortSignal,
          },
          () => createFeeBumpTransaction(innerXdr),
        );

        logger.info('Fee-bump transaction created', {
          userId: user.id,
          feeAccount: result.feeAccountPublicKey,
          feeStroops: result.feeStroops,
        });

        // Emit fee_abstraction.executed event
        calloraEvents.emit('fee_abstraction.executed', user.id, {
          userId: user.id,
          appTokenPaymentTxId: paymentTxHash,
          feeAccountPublicKey: result.feeAccountPublicKey,
          feeStroops: stroopsToJsonNumber(result.feeStroops),
          feeBumpXdr: result.feeBumpXdr,
        });

        res.status(200).json({
          feeBumpXdr: result.feeBumpXdr,
          feeAccountPublicKey: result.feeAccountPublicKey,
          feeStroops: stroopsToJsonNumber(result.feeStroops),
        });
      } catch (err) {
        if (err instanceof FeeBumperInvalidTransactionError) {
          next(new BadRequestError(err.message, 'VALIDATION_ERROR'));
          return;
        }
        if (err instanceof FeeBumperConfigError) {
          logger.error('Fee-bumper configuration error', err);
          next(new InternalServerError('Fee-bumper service is not configured'));
          return;
        }
        if (err instanceof FeeBumperSigningError) {
          logger.error('Fee-bumper signing error', err);
          next(new InternalServerError('Fee-bumper signing failed'));
          return;
        }
        next(err);
      }
    },
  );

  return router;
}

export default createFeeAbstractionRouter;
