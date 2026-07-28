import { Router, type Response, type NextFunction, type Request } from 'express';
import { z } from 'zod';
import { UnauthorizedError, InternalServerError } from '../../../errors/index.js';
import { requireAuth, type AuthenticatedLocals } from '../../../middleware/requireAuth.js';
import { validate } from '../../../middleware/validate.js';
import { BillingService } from '../../../services/billing.js';
import { createSorobanRpcBillingClient } from '../../../services/sorobanBilling.js';
import { logger } from '../../../logger.js';
import type { Pool } from 'pg';

const router = Router();

export interface BulkDeductItemResult {
  requestId: string;
  success: boolean;
  usageEventId?: string;
  stellarTxHash?: string;
  alreadyProcessed?: boolean;
  error?: string;
}

const bulkItemSchema = z.object({
  requestId: z.string().min(1, 'requestId is required'),
  apiId: z.string().min(1, 'apiId is required'),
  endpointId: z.string().min(1, 'endpointId is required'),
  apiKeyId: z.string().min(1, 'apiKeyId is required'),
  amountUsdc: z.string()
    .regex(/^\d+(\.\d{1,7})?$/, 'amountUsdc must be a positive decimal with at most 7 fractional digits')
    .refine((val) => Number(val) > 0, 'amountUsdc must be greater than zero'),
  idempotencyKey: z.string().optional(),
}).strict();

const bulkDeductSchema = z.object({
  items: z.array(bulkItemSchema)
    .min(1, 'At least one item is required')
    .max(100, 'Batch size limit of 100 items exceeded'),
}).strict();

function getPool(req: Request): Pool {
  const pool = req.app?.locals?.dbPool as Pool | undefined;
  if (!pool) {
    throw new InternalServerError('Database pool is not configured');
  }
  return pool;
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

/**
 * POST /api/billing/deduct/bulk
 *
 * Performs batch billing deductions (up to 100 requests) sequentially.
 *
 * Request body structure:
 * {
 *   "items": [
 *     {
 *       "requestId": "req_1",
 *       "apiId": "api_1",
 *       "endpointId": "ep_1",
 *       "apiKeyId": "key_1",
 *       "amountUsdc": "0.0100000",
 *       "idempotencyKey": "idem_1"
 *     }
 *   ]
 * }
 */
router.post(
  '/',
  requireAuth,
  validate({ body: bulkDeductSchema }),
  async (
    req: Request,
    res: Response<unknown, AuthenticatedLocals>,
    next: NextFunction
  ): Promise<void> => {
    try {
      const user = res.locals.authenticatedUser;
      if (!user) {
        next(new UnauthorizedError());
        return;
      }

      const { items } = req.body as z.infer<typeof bulkDeductSchema>;
      const billingService = createRouteBillingService(getPool(req));
      const results: BulkDeductItemResult[] = [];

      for (const item of items) {
        try {
          const result = await billingService.deduct({
            requestId: item.requestId,
            userId: user.id,
            apiId: item.apiId,
            endpointId: item.endpointId,
            apiKeyId: item.apiKeyId,
            amountUsdc: item.amountUsdc,
            idempotencyKey: item.idempotencyKey,
          });

          if (result.success) {
            results.push({
              requestId: item.requestId,
              success: true,
              usageEventId: result.usageEventId,
              stellarTxHash: result.stellarTxHash,
              alreadyProcessed: result.alreadyProcessed,
            });
          } else {
            results.push({
              requestId: item.requestId,
              success: false,
              error: result.error ?? 'Deduction failed',
            });
          }
        } catch (itemError) {
          logger.error(`Error processing bulk deduct item ${item.requestId}:`, itemError);
          results.push({
            requestId: item.requestId,
            success: false,
            error: itemError instanceof Error ? itemError.message : 'Unknown error',
          });
        }
      }

      res.status(200).json({ results });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
