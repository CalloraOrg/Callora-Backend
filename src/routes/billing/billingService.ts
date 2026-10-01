import type { Request } from "express";
import { InternalServerError } from "../../errors/index.js";
import type { BillingService } from "../../services/billing.js";

export function getBillingService(req: Request): BillingService {
  if (!req.app?.locals?.dbPool) {
    throw new InternalServerError("Database pool is not configured");
  }

  const billingService = req.app.locals.billingService as BillingService | undefined;
  if (!billingService) {
    throw new InternalServerError("Billing service is not configured");
  }
  return billingService;
}
