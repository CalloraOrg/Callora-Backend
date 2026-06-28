import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import type { Pool } from "pg";
import { z } from "zod";

import {
  BadGatewayError,
  BadRequestError,
  GatewayTimeoutError,
  InternalServerError,
  PaymentRequiredError,
  UnauthorizedError,
} from "../../../errors/index.js";
import { logger } from "../../../logger.js";
import {
  requireAuth,
  type AuthenticatedLocals,
} from "../../../middleware/requireAuth.js";
import { idempotencyMiddleware } from "../../../middleware/idempotency.js";
import { validate } from "../../../middleware/validate.js";
import {
  BillingService,
  type BillingDeductRequest,
} from "../../../services/billing.js";
import {
  createSorobanRpcBillingClient,
  SorobanRpcError,
} from "../../../services/sorobanBilling.js";

const MAX_BULK_DEDUCT_ENTRIES = 100;
const amountUsdcPattern = /^\d+(\.\d{1,7})?$/;

const bulkDeductEntrySchema = z.object({
  requestId: z.string().trim().min(1, "requestId is required"),
  apiId: z.string().trim().min(1, "apiId is required"),
  endpointId: z.string().trim().min(1, "endpointId is required"),
  apiKeyId: z.string().trim().min(1, "apiKeyId is required"),
  amountUsdc: z
    .string()
    .trim()
    .refine(
      (value: string) => amountUsdcPattern.test(value) && Number(value) > 0,
      "amountUsdc must be a positive number with at most 7 decimal places",
    ),
});

const bulkDeductBodySchema = z
  .object({
    entries: z
      .array(bulkDeductEntrySchema)
      .min(1, "At least one billing deduction entry is required")
      .max(
        MAX_BULK_DEDUCT_ENTRIES,
        `Cannot deduct more than ${MAX_BULK_DEDUCT_ENTRIES} entries at once`,
      ),
    idempotencyKey: z.string().trim().min(1).max(255).optional(),
  })
  .superRefine(
    (body: { entries: Array<{ requestId: string }> }, ctx: z.RefinementCtx) => {
      const seenRequestIds = new Set<string>();

      body.entries.forEach((entry: { requestId: string }, index: number) => {
        if (seenRequestIds.has(entry.requestId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["entries", index, "requestId"],
            message: "requestId values must be unique within the batch",
          });
          return;
        }

        seenRequestIds.add(entry.requestId);
      });
    },
  );

type BulkDeductBody = z.infer<typeof bulkDeductBodySchema>;

type BulkBillingService = Pick<BillingService, "deductBulk">;

interface BulkDeductRouterOptions {
  createBillingService?: (pool: Pool) => BulkBillingService;
}

function getPool(req: Request): Pool {
  const pool = req.app?.locals?.dbPool as Pool | undefined;
  if (!pool) {
    throw new InternalServerError("Database pool is not configured");
  }
  return pool;
}

function createRouteBillingService(pool: Pool): BillingService {
  const sorobanClient = createSorobanRpcBillingClient({
    rpcUrl:
      process.env.SOROBAN_BILLING_RPC_URL ??
      process.env.SOROBAN_RPC_URL ??
      "http://localhost:8000",
    contractId: process.env.SOROBAN_BILLING_CONTRACT_ID ?? "vault_contract",
    sourceAccount: process.env.SOROBAN_BILLING_SOURCE_ACCOUNT,
    networkPassphrase: process.env.SOROBAN_BILLING_NETWORK_PASSPHRASE,
    requestTimeoutMs: Number(
      process.env.SOROBAN_BILLING_RPC_TIMEOUT_MS ?? 5_000,
    ),
    balanceFunctionName: process.env.SOROBAN_BILLING_BALANCE_FN ?? "balance",
    deductFunctionName: process.env.SOROBAN_BILLING_DEDUCT_FN ?? "deduct",
  });

  return new BillingService(pool, sorobanClient);
}

function mapBulkEntries(
  userId: string,
  body: BulkDeductBody,
): BillingDeductRequest[] {
  return body.entries.map((entry: BulkDeductBody["entries"][number]) => ({
    requestId: entry.requestId,
    userId,
    apiId: entry.apiId,
    endpointId: entry.endpointId,
    apiKeyId: entry.apiKeyId,
    amountUsdc: entry.amountUsdc,
  }));
}

function mapBulkFailure(error?: string, simulationDetails?: unknown): Error {
  if (simulationDetails) {
    return new BadGatewayError("Soroban simulation failed");
  }

  if (!error) {
    return new PaymentRequiredError("Bulk billing deduction failed");
  }

  const lower = error.toLowerCase();

  if (lower.includes("insufficient balance")) {
    return new PaymentRequiredError(error);
  }

  if (lower.includes("timeout")) {
    return new GatewayTimeoutError(error);
  }

  if (lower.includes("balance check failed")) {
    return new BadGatewayError(error);
  }

  if (lower.includes("single user")) {
    return new BadRequestError(error);
  }

  return new PaymentRequiredError(error);
}

export function createBulkDeductRouter(
  options: BulkDeductRouterOptions = {},
): Router {
  const router = Router();
  const createBillingService =
    options.createBillingService ?? createRouteBillingService;

  router.post(
    "/bulk",
    requireAuth,
    idempotencyMiddleware,
    validate({ body: bulkDeductBodySchema }),
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

        const body = bulkDeductBodySchema.parse(req.body);
        const billingService = createBillingService(getPool(req));
        const result = await billingService.deductBulk(
          mapBulkEntries(user.id, body),
          body.idempotencyKey ?? req.get("Idempotency-Key") ?? undefined,
        );

        if (!result.success) {
          logger.warn({
            event: "billing.bulk_deduct.failed",
            correlationId: req.id ?? "unknown",
            userId: user.id,
            entryCount: body.entries.length,
            error: result.error,
            simulationDetails: result.simulationDetails,
          });
          next(mapBulkFailure(result.error, result.simulationDetails));
          return;
        }

        logger.info({
          event: "billing.bulk_deduct.succeeded",
          correlationId: req.id ?? "unknown",
          userId: user.id,
          entryCount: result.entryCount,
          deductedCount: result.deductedCount,
          totalDeductedAmountUsdc: result.totalDeductedAmountUsdc,
          stellarTxHash: result.stellarTxHash,
        });

        res.status(200).json({
          success: true,
          entryCount: result.entryCount,
          deductedCount: result.deductedCount,
          totalDeductedAmountUsdc: result.totalDeductedAmountUsdc,
          stellarTxHash: result.stellarTxHash,
          results: result.results,
        });
      } catch (error) {
        if (error instanceof SorobanRpcError) {
          switch (error.category) {
            case "INSUFFICIENT_BALANCE":
              next(new PaymentRequiredError(error.message));
              return;
            case "TIMEOUT":
              next(new GatewayTimeoutError(error.message));
              return;
            case "CONTRACT_ERROR":
            case "NETWORK_ERROR":
              next(new BadGatewayError(error.message));
              return;
          }
        }

        next(error);
      }
    },
  );

  return router;
}

export default createBulkDeductRouter();
