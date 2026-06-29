import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { Pool } from 'pg';

import {
  BadGatewayError,
  BadRequestError,
  GatewayTimeoutError,
  InternalServerError,
  NotFoundError,
  PaymentRequiredError,
  UnauthorizedError,
} from '../errors/index.js';
import { requireAuth, type AuthenticatedLocals } from '../middleware/requireAuth.js';
import { idempotencyMiddleware } from '../middleware/idempotency.js';
import { billingDeductHistogramMiddleware } from '../middleware/metricsHistogram.js';
import { BillingService, type BillingDeductResult } from '../services/billing.js';
import { createSorobanRpcBillingClient, SorobanRpcError } from '../services/sorobanBilling.js';
import { redactSimulationDetails } from '../lib/simulationDiagnostics.js';
import creditsRouter from './billing/credits.js';
import { createFeeAbstractionRouter } from './billing/feeAbstraction.js';

const router = Router();

// Mount credits sub-router
router.use('/credits', creditsRouter);

// Mount fee-abstraction sub-router
router.use('/fee-abstraction', createFeeAbstractionRouter());

interface BillingDeductBody {
  requestId?: unknown;
  apiId?: unknown;
  endpointId?: unknown;
  apiKeyId?: unknown;
  amountUsdc?: unknown;
  idempotencyKey?: unknown;
}

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

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BadRequestError(`${field} is required`);
  }
  return value.trim();
}

function requirePositiveAmount(value: unknown): string {
  const amount = requireString(value, 'amountUsdc');
  if (!/^\d+(\.\d{1,7})?$/.test(amount) || Number(amount) <= 0) {
    throw new BadRequestError('amountUsdc must be a positive number with at most 7 decimal places');
  }
  return amount;
}

function getPool(req: Request): Pool {
  const pool = req.app?.locals?.dbPool as Pool | undefined;
  if (!pool) {
    throw new InternalServerError('Database pool is not configured');
  }
  return pool;
}

function sendSimulationFailure(
  res: Response,
  result: Pick<BillingDeductResult, 'error' | 'simulationDetails'>
): void {
  console.warn('Soroban simulation diagnostics:', result.simulationDetails);
  res.status(502).json({
    error: 'Soroban simulation failed',
    code: 'SIMULATION_FAILED',
    simulationDetails: redactSimulationDetails(result.simulationDetails),
  });
}

router.post(
  '/deduct',
  requireAuth,
  idempotencyMiddleware,
  billingDeductHistogramMiddleware,
  async (
    req: Request,
    res: Response<unknown, AuthenticatedLocals>,
    next: NextFunction
  ) => {
    try {
      const user = res.locals.authenticatedUser;
      if (!user) {
        next(new UnauthorizedError());
        return;
      }

      const body = req.body as BillingDeductBody;
      const requestId = requireString(body.requestId, 'requestId');
      const apiId = requireString(body.apiId, 'apiId');
      const endpointId = requireString(body.endpointId, 'endpointId');
      const apiKeyId = requireString(body.apiKeyId, 'apiKeyId');
      const amountUsdc = requirePositiveAmount(body.amountUsdc);
      const idempotencyKey =
        typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim() !== ''
          ? body.idempotencyKey.trim()
          : req.get('Idempotency-Key') ?? undefined;

      const billingService = createRouteBillingService(getPool(req));
      const result = await billingService.deduct({
        requestId,
        userId: user.id,
        apiId,
        endpointId,
        apiKeyId,
        amountUsdc,
        idempotencyKey,
      });

      if (!result.success) {
        if (result.simulationDetails) {
          sendSimulationFailure(res, result);
          return;
        }

        next(new PaymentRequiredError(result.error ?? 'Billing deduction failed', 'BILLING_DEDUCTION_FAILED'));
        return;
      }

      res.status(200).json({
        success: true,
        usageEventId: result.usageEventId,
        stellarTxHash: result.stellarTxHash,
        alreadyProcessed: result.alreadyProcessed,
      });
    } catch (error) {
      if (error instanceof SorobanRpcError) {
        if (error.simulationDetails) {
          console.warn('Soroban simulation diagnostics:', error.simulationDetails);
          res.status(502).json({
            error: 'Soroban simulation failed',
            code: 'SIMULATION_FAILED',
            simulationDetails: redactSimulationDetails(error.simulationDetails),
          });
          return;
        }

        switch (error.category) {
          case 'INSUFFICIENT_BALANCE':
            next(new PaymentRequiredError(error.message, 'INSUFFICIENT_BALANCE'));
            return;
          case 'TIMEOUT':
            next(new GatewayTimeoutError(error.message, 'SOROBAN_RPC_TIMEOUT'));
            return;
          case 'CONTRACT_ERROR':
          case 'NETWORK_ERROR':
            next(new BadGatewayError(error.message, 'SOROBAN_RPC_ERROR'));
            return;
        }
      }
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
    next: NextFunction
  ) => {
    try {
      const user = res.locals.authenticatedUser;
      if (!user) {
        next(new UnauthorizedError());
        return;
      }

      const requestId = requireString(req.params.requestId, 'requestId');
      const billingService = createRouteBillingService(getPool(req));
      const result = await billingService.getByRequestId(requestId);

      if (!result) {
        next(new NotFoundError('Billing request not found', 'BILLING_REQUEST_NOT_FOUND'));
        return;
      }

      res.status(200).json({
        success: result.success,
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
