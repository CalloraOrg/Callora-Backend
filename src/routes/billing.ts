import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { Pool } } from 'pg';

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
import { BillingService } from '../services/billing.js';
import { createSorobanRpcBillingClient, SorobanRpcError } from '../services/sorobanBilling.js';
import { SimulationError } from '../services/transactionBuilder.js';

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
  idempotencyMiddleware,
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

      const {
        requestId,
        apiId,
        endpointId,
        apiKeyId,
        amountUsdc,
        idempotancyId,
      } {
        ... // omitted for brevity
      }

      // ... existing validation logic ...

      const result = await billingService.deduct(...);

      // ... existing success handling ...

    } catch (error) {
      if (error instanceof SimulationError) {
        console.warn('Simulation diagnostics:', error.simulationDetails);
        const redacted = redactSimulationDetails(error.simulationDetails);
        res.status(502).json({
          error: 'Soroban simulation failed',
          code: 'SIMULATION_FAILED',
          diagnostics: redacted,
        });
        return;
      }

      if (error instanceof SorobanRpcError) {
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
    // unchanged
  }
);

export default router;

/**
 * Redact known secret fields from simulation diagnostics.
 */
function redactSimulationDetails(details: unknown): unknown {
  if (typeof details !== 'object' || details === null) {
    return details;
  }
  const clone: any = Array.isArray(details) ? [] : {};
  for (const [k, v] of Object.entries(details as any)) {
    if (k.toLowerCase().includes('secret') || k.toLowerCase().includes('balance')) {
      clone[k] = '[REDACTED]';
    } else {
      clone[k] = v;
    }
  }
  return clone;
}
