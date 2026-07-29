import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import type { Pool } from "pg";
import { encodeCursor, parseCursor } from "../lib/cursorPagination.js";

import {
  BadGatewayError,
  BadRequestError,
  GatewayTimeoutError,
  InternalServerError,
  NotFoundError,
  PaymentRequiredError,
  UnauthorizedError,
} from "../errors/index.js";
import {
  requireAuth,
  type AuthenticatedLocals,
} from "../middleware/requireAuth.js";
import { idempotencyMiddleware } from "../middleware/idempotency.js";
import { billingDeductHistogramMiddleware } from "../middleware/metricsHistogram.js";
import {
  BillingService,
  type BillingDeductResult,
} from "../services/billing.js";
import {
  createSorobanRpcBillingClient,
  SorobanRpcError,
} from "../services/sorobanBilling.js";
import { redactSimulationDetails } from "../lib/simulationDiagnostics.js";
import { billingAccessLogMiddleware } from "../middleware/accessLog.js";
import creditsRouter from "./billing/credits.js";
import deductRouter from "./billing/deduct.js";
import disputesRouter from "./billing/disputes.js";
import refundRouter from "./billing/refund.js";
import { createFeeAbstractionRouter } from "./billing/feeAbstraction.js";
import { createBillingForecastRouter } from "./billing/forecast.js";
import { etagMiddleware } from "../middleware/etag.js";
import { createTimeoutMiddleware } from "../middleware/timeout.js";
import { config } from "../config/index.js";

const router = Router();

router.use(billingAccessLogMiddleware);
router.use(createTimeoutMiddleware({ timeoutMs: config.billingTimeoutMs }));

router.use("/credits", creditsRouter);
router.use("/disputes", disputesRouter);
router.use("/deduct", deductRouter);
router.use("/refund", refundRouter);
router.use("/fee-abstraction", createFeeAbstractionRouter());
router.use("/forecast", createBillingForecastRouter());

interface BillingDeductBody {
  requestId?: unknown;
  developerId?: unknown;
  apiId?: unknown;
  endpointId?: unknown;
  apiKeyId?: unknown;
  amountUsdc?: unknown;
  idempotencyKey?: unknown;
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

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new BadRequestError(`${field} is required`);
  }
  return value.trim();
}

function requirePositiveAmount(value: unknown): string {
  const amount = requireString(value, "amountUsdc");
  if (!/^\d+(\.\d{1,7})?$/.test(amount) || Number(amount) <= 0) {
    throw new BadRequestError(
      "amountUsdc must be a positive number with at most 7 decimal places",
    );
  }
  return amount;
}

function getPool(req: Request): Pool {
  const pool = req.app?.locals?.dbPool as Pool | undefined;
  if (!pool) {
    throw new InternalServerError("Database pool is not configured");
  }
  return pool;
}

function sendSimulationFailure(
  res: Response,
  result: Pick<BillingDeductResult, "error" | "simulationDetails">,
): void {
  console.warn("Soroban simulation diagnostics:", result.simulationDetails);
  res.status(502).json({
    error: "Soroban simulation failed",
    code: "SIMULATION_FAILED",
    simulationDetails: redactSimulationDetails(result.simulationDetails),
  });
}

router.get(
  "/",
  requireAuth,
  etagMiddleware,
  async (
    req: Request,
    res: Response<unknown, AuthenticatedLocals>,
    next: NextFunction,
  ) => {
    try {
      const user = res.locals.authenticatedUser;
      if (!user) {
        next(new UnauthorizedError());
        return;
      }

      const pool = getPool(req);
      const limit = Number(req.query.limit ?? 20);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        next(new BadRequestError("limit must be an integer between 1 and 100"));
        return;
      }

      const cursor = parseCursor(req.query.cursor);
      if (req.query.cursor !== undefined && !cursor) {
        next(new BadRequestError("Invalid cursor"));
        return;
      }

      const query = {
        text: `
          SELECT id, request_id, developer_id, api_id, endpoint_id, api_key_id, amount_usdc, created_at
          FROM billing_requests
          WHERE developer_id = $1
          ${cursor ? "AND (created_at < $2 OR (created_at = $2 AND id < $3))" : ""}
          ORDER BY created_at DESC, id DESC
          LIMIT $4
        `,
        values: cursor
          ? [user.id, cursor.timestamp, cursor.id, limit + 1]
          : [user.id, limit + 1],
      };

      const result = await pool.query(query);
      const rows = result.rows as Array<{
        id: string;
        request_id: string;
        developer_id: string;
        api_id: string;
        endpoint_id: string;
        api_key_id: string;
        amount_usdc: string;
        created_at: Date;
      }>;

      const hasMore = rows.length > limit;
      const data = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore && data.length > 0
        ? encodeCursor(data[data.length - 1].created_at, data[data.length - 1].id)
        : null;

      res.status(200).json({
        data: data.map((row) => ({
          id: row.id,
          requestId: row.request_id,
          developerId: row.developer_id,
          apiId: row.api_id,
          endpointId: row.endpoint_id,
          apiKeyId: row.api_key_id,
          amountUsdc: row.amount_usdc,
          createdAt: row.created_at.toISOString(),
        })),
        meta: {
          limit,
          nextCursor,
          hasMore,
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  "/deduct",
  requireAuth,
  idempotencyMiddleware,
  billingDeductHistogramMiddleware,
  async (
    req: Request,
    res: Response<unknown, AuthenticatedLocals>,
    next: NextFunction,
  ) => {
    try {
      const user = res.locals.authenticatedUser;
      if (!user) {
        next(new UnauthorizedError());
        return;
      }

      const body = req.body as BillingDeductBody;
      const requestId = requireString(body.requestId, "requestId");
      const apiId = requireString(body.apiId, "apiId");
      const endpointId = requireString(body.endpointId, "endpointId");
      const apiKeyId = requireString(body.apiKeyId, "apiKeyId");
      const amountUsdc = requirePositiveAmount(body.amountUsdc);
      const idempotencyKey =
        typeof body.idempotencyKey === "string" &&
        body.idempotencyKey.trim() !== ""
          ? body.idempotencyKey.trim()
          : (req.get("Idempotency-Key") ?? undefined);
      const developerId = Object.prototype.hasOwnProperty.call(
        body,
        "developerId",
      )
        ? requireString(body.developerId, "developerId")
        : user.id;

      const billingService = createRouteBillingService(getPool(req));
      const result = await billingService.deduct({
        requestId,
        userId: developerId,
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

        next(
          new PaymentRequiredError(
            result.error ?? "Billing deduction failed",
            "BILLING_DEDUCTION_FAILED",
          ),
        );
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
          console.warn(
            "Soroban simulation diagnostics:",
            error.simulationDetails,
          );
          res.status(502).json({
            error: "Soroban simulation failed",
            code: "SIMULATION_FAILED",
            simulationDetails: redactSimulationDetails(error.simulationDetails),
          });
          return;
        }

        switch (error.category) {
          case "INSUFFICIENT_BALANCE":
            next(
              new PaymentRequiredError(error.message, "INSUFFICIENT_BALANCE"),
            );
            return;
          case "TIMEOUT":
            next(new GatewayTimeoutError(error.message, "SOROBAN_RPC_TIMEOUT"));
            return;
          case "CONTRACT_ERROR":
          case "NETWORK_ERROR":
            next(new BadGatewayError(error.message, "SOROBAN_RPC_ERROR"));
            return;
        }
      }
      next(error);
    }
  },
);

router.get(
  "/request/:requestId",
  requireAuth,
  etagMiddleware,
  async (
    req: Request,
    res: Response<unknown, AuthenticatedLocals>,
    next: NextFunction,
  ) => {
    try {
      const user = res.locals.authenticatedUser;
      if (!user) {
        next(new UnauthorizedError());
        return;
      }

      const requestId = requireString(req.params.requestId, "requestId");
      const billingService = createRouteBillingService(getPool(req));
      const result = await billingService.getByRequestId(requestId);

      if (!result) {
        next(
          new NotFoundError(
            "Billing request not found",
            "BILLING_REQUEST_NOT_FOUND",
          ),
        );
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
  },
);

export default router;
