import { Router } from "express";
import type { NextFunction, Request, Response } from "express";

import {
  BadGatewayError,
  BadRequestError,
  GatewayTimeoutError,
  NotFoundError,
  PaymentRequiredError,
  SimulationFailedError,
  UnauthorizedError,
} from "../../errors/index.js";
import { logger } from "../../logger.js";
import {
  requireAuth,
  type AuthenticatedLocals,
} from "../../middleware/requireAuth.js";
import { idempotencyMiddleware } from "../../middleware/idempotency.js";
import { billingDeductHistogramMiddleware } from "../../middleware/metricsHistogram.js";
import { SorobanRpcError } from "../../services/sorobanBilling.js";
import { redactSimulationDetails } from "../../lib/simulationDiagnostics.js";
import { getBillingService } from "./billingService.js";
import bulkDeductRouter from "./deduct/bulk.js";

const router = Router();

interface BillingDeductBody {
  requestId?: unknown;
  developerId?: unknown;
  apiId?: unknown;
  endpointId?: unknown;
  apiKeyId?: unknown;
  amountUsdc?: unknown;
  idempotencyKey?: unknown;
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

// idempotencyMiddleware declares an optional 4th `opts` parameter, giving it
// an arity of 4. Express treats any 4-arg middleware function as an
// error handler (function(err, req, res, next)), so registering it directly
// causes thrown errors (e.g. validation errors) to be misrouted into it
// instead of the real error handler, surfacing as 500s. Wrap it to a 3-arg
// function so Express dispatches it as normal middleware.
const idempotencyHandler = (
  req: Request,
  res: Response<unknown, AuthenticatedLocals>,
  next: NextFunction,
) => idempotencyMiddleware(req, res, next);

/**
 * Record a simulation failure server-side with redacted diagnostics.
 *
 * Raw RPC payloads contain account addresses, balances, XDR and signatures,
 * so they are never logged verbatim — only the summary produced by
 * {@link redactSimulationDetails} is emitted.
 */
function logSimulationFailure(details: unknown): void {
  logger.warn("[billing/deduct] Soroban simulation failed", {
    simulationDetails: redactSimulationDetails(details),
  });
}

/**
 * Build the error that carries a simulation failure out of the route.
 *
 * `SimulationFailedError` is a `BadGatewayError` (502) with the canonical
 * `SIMULATION_FAILED` code and redacted `simulationDetails`. Because it is
 * thrown rather than written directly to the response, the global error
 * handler renders it with {@link buildErrorEnvelope}, so clients always
 * receive the standard envelope and a `requestId` they can correlate with
 * support.
 */
function simulationFailureError(
  message: string,
  details: unknown,
): SimulationFailedError {
  logSimulationFailure(details);
  return new SimulationFailedError(message, details);
}

router.post(
  "/",
  requireAuth,
  idempotencyHandler,
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

      const billingService = getBillingService(req);
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
          next(
            simulationFailureError(
              result.error ?? "Soroban simulation failed",
              result.simulationDetails,
            ),
          );
          return;
        }

        if (result.reconciliationRequired) {
          res.status(409).json({
            error: "Billing deduction pending reconciliation",
            code: "RECONCILIATION_REQUIRED",
            reconciliationRequired: true,
            usageEventId: result.usageEventId,
          });
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
          next(
            simulationFailureError(error.message, error.simulationDetails),
          );
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
      const billingService = getBillingService(req);
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

router.use("/bulk", bulkDeductRouter);

export default router;
