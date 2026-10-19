import type { RequestHandler } from "express";
import { config } from "../config/index.js";
import { ErrorCode } from "../errors/codes.js";
import { errorEnvelope, getRequestId } from "../lib/envelope.js";

/** Paths are matched as Express prefixes, including subpaths but not lookalikes. */
export const DEMO_UNSUPPORTED_ROUTES = [
  { prefix: "/api/billing", methods: ["*"], feature: "billing" },
  { prefix: "/api/invoices", methods: ["*"], feature: "invoices" },
  { prefix: "/api/usage", methods: ["*"], feature: "usage" },
  { prefix: "/api/exports", methods: ["*"], feature: "exports" },
  { prefix: "/api/admin/usage", methods: ["*"], feature: "admin usage" },
  { prefix: "/api/admin/db/explain", methods: ["*"], feature: "database explain" },
  { prefix: "/api/vault/deposit/prepare", methods: ["POST"], feature: "vault deposit" },
  { prefix: "/api/vault/onchain", methods: ["GET", "HEAD"], feature: "on-chain vault" },
  { prefix: "/api/vault/balance", methods: ["GET", "HEAD"], feature: "vault balance" },
  { prefix: "/api/audit", methods: ["POST", "PUT", "PATCH", "DELETE"], feature: "audit persistence" },
  { prefix: "/api/credits", methods: ["*"], feature: "credits" },
  { prefix: "/api/refunds", methods: ["*"], feature: "refunds" },
  { prefix: "/api/health/health", methods: ["GET", "HEAD"], feature: "dependency health" },
  { prefix: "/api/health/dependencies", methods: ["GET", "HEAD"], feature: "dependency health" },
] as const;

export const demoGuard: RequestHandler = (req, res, next) => {
  if (!config.demoMode) {
    next();
    return;
  }
  const path = req.path.toLowerCase();
  const match = DEMO_UNSUPPORTED_ROUTES.find(({ prefix, methods }) =>
    (path === prefix || path.startsWith(`${prefix}/`)) &&
    (methods as readonly string[]).some((method) => method === "*" || method === req.method),
  );
  if (!match) {
    next();
    return;
  }
  res.status(503).json(errorEnvelope(
    ErrorCode.DEMO_MODE_UNSUPPORTED,
    "This feature is unavailable in demo mode.",
    getRequestId(req),
    { feature: match.feature },
  ));
};
