import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';

import { BadRequestError } from '../errors/index.js';
import { requireAuth, type AuthenticatedLocals } from '../middleware/requireAuth.js';
import { BillingService } from '../services/billing.js';
import { createSorobanRpcBillingClient } from '../services/sorobanBilling.js';

const router = Router();

function createRouteBillingService(pool: Pool): BillingService {
  const sorobanClient = createSorobanRpcBillingClient({
    rpcUrl: process.env.SOROBAN_BILLING_RPC_URL ?? process.env.SOROBAN_RPC_URL ?? 'http://localhost:8000',
    contractId: process.env.SOROBAN_BILLING_CONTRACT_ID ?? 'vault_contract',
    sourceAccount: process.env.SOROBAN_BILLING_SOURCE_ACCOUNT,
    networkPassphrase: process.env.SOROBAN_BILLING_NETWORK_PASSPHRASE,
    requestTimeoutMs: Number(process.env.SOROBAN_BILLING_RPC_TIMEOUT_MS ?? 5_000),
    balanceFunctionName: process.env.SOROBAN_BILLING_BALANCE_FN ?? 'balance',
    deductFunctionName: process.env.SOROBAN_BILLING_DEDUCT_FN ?? 'deduct',
  });

  return new BillingService(pool, sorobanClient);
}

router.post(
  '/deduct',
  requireAuth,
  async (
    req: Request,
    res: Response<unknown, AuthenticatedLocals>,
    next
  ) => {
    try {
      const user = res.locals.authenticatedUser;
      if (!user) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const {
        requestId,
        apiId,
        endpointId,
        apiKeyId,
        amountUsdc,
        idempotencyKey,
      } = req.body as Record<string, unknown>;

      if (!requestId || typeof requestId !== 'string' || requestId.trim() === '') {
        next(new BadRequestError('requestId is required and must be a non-empty string'));
        return;
      }

      if (!apiId || typeof apiId !== 'string' || apiId.trim() === '') {
        next(new BadRequestError('apiId is required and must be a non-empty string'));
        return;
      }

      if (!endpointId || typeof endpointId !== 'string' || endpointId.trim() === '') {
        next(new BadRequestError('endpointId is required and must be a non-empty string'));
        return;
      }

      if (!apiKeyId || typeof apiKeyId !== 'string' || apiKeyId.trim() === '') {
        next(new BadRequestError('apiKeyId is required and must be a non-empty string'));
        return;
      }

      if (!amountUsdc || typeof amountUsdc !== 'string') {
        next(new BadRequestError('amountUsdc is required and must be a string'));
        return;
      }

      const amount = Number(amountUsdc);
      if (!Number.isFinite(amount) || amount <= 0) {
        next(new BadRequestError('amountUsdc must be a positive number'));
        return;
      }

      if (
        idempotencyKey !== undefined &&
        (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '')
      ) {
        next(new BadRequestError('idempotencyKey must be a non-empty string when provided'));
        return;
      }

      const pool = req.app.locals.dbPool as Pool | undefined;
      if (!pool) {
        res.status(500).json({ error: 'Database not available' });
        return;
      }

      const billingService = createRouteBillingService(pool);

      const result = await billingService.deduct({
        requestId: requestId.trim(),
        userId: user.id,
        apiId: apiId.trim(),
        endpointId: endpointId.trim(),
        apiKeyId: apiKeyId.trim(),
        amountUsdc: amountUsdc.trim(),
        idempotencyKey:
          typeof idempotencyKey === 'string' ? idempotencyKey.trim() : undefined,
      });

      if (!result.success) {
        const message = result.error ?? 'Billing deduction failed';
        const statusCode = message.toLowerCase().includes('insufficient balance') ? 402 : 500;

        res.status(statusCode).json({
          error: 'Billing deduction failed',
          details: message,
        });
        return;
      }

      res.status(200).json({
        success: true,
        usageEventId: result.usageEventId,
        stellarTxHash: result.stellarTxHash,
        alreadyProcessed: result.alreadyProcessed,
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/request/:requestId',
  requireAuth,
  async (
    req: Request,
    res: Response<unknown, AuthenticatedLocals>,
    next
  ) => {
    try {
      const user = res.locals.authenticatedUser;
      if (!user) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const { requestId } = req.params;
      if (!requestId || requestId.trim() === '') {
        next(new BadRequestError('requestId is required and must be a non-empty string'));
        return;
      }

      const pool = req.app.locals.dbPool as Pool | undefined;
      if (!pool) {
        res.status(500).json({ error: 'Database not available' });
        return;
      }

      const billingService = createRouteBillingService(pool);
      const result = await billingService.getByRequestId(requestId.trim());

      if (!result) {
        res.status(404).json({
          error: 'Billing request not found',
          requestId: requestId.trim(),
        });
        return;
      }

      res.status(200).json({
        success: true,
        usageEventId: result.usageEventId,
        stellarTxHash: result.stellarTxHash,
        alreadyProcessed: result.alreadyProcessed,
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
