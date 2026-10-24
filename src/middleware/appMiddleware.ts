import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { getEmbeddedAssets } from '../lib/embeddedAssets.js';
import { envelopeValidator } from "../middleware/envelopeValidator.js";
import {
  requestIdMiddleware,
  responseEnrichMiddleware,
} from "../middleware/requestId.js";
import { createDocsRouter } from '../routes/docs.js';
//import { envelopeValidator } from '../middleware/envelopeValidator.js';
import OpenApiValidator from "express-openapi-validator";
import path from "path";
import { config } from "../config/index.js";
import { metricsMiddleware } from "../metrics.js";
import { createAccessLogMiddleware } from "../middleware/accessLog.js";
import { auditEnrichMiddleware } from "../middleware/auditEnrich.js";
import { demoGuard } from "../middleware/demoGuard.js";
import {
  createResponseValidatorMiddleware,
  envelopeMiddleware,
} from "../middleware/envelope.js";
import { createMemoryAccountingMiddleware } from "../middleware/memoryAccounting.js";
import { createRouteBodyLimitMiddleware } from "../middleware/routeBodyLimit.js";
//import * as OpenApiValidator from 'express-openapi-validator';


export function registerAppMiddleware(app: express.Express): void {
  // Public documentation routes (own CSP; mounted ahead of the global Helmet policy)
  app.use(createDocsRouter());

  // Production-safe security headers with environment-based configuration
  const isProduction = process.env.NODE_ENV === "production";
  const isDevelopment = process.env.NODE_ENV === "development";

  // Apply Helmet with production-safe defaults
  app.use(
    helmet({
      // Content Security Policy - stricter in production
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"], // Allow inline styles for development
          scriptSrc: ["'self'"],
          imgSrc: ["'self'", "data:", "https:"],
          connectSrc: ["'self'", ...(isDevelopment ? ["ws:", "wss:"] : [])],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          mediaSrc: ["'self'"],
          frameSrc: ["'none'"],
        },
      },
      // Cross-Origin Embedder Policy
      crossOriginEmbedderPolicy: isProduction
        ? { policy: "require-corp" }
        : false,
      // HSTS - only in production with HTTPS
      hsts: isProduction
        ? {
          maxAge: 31536000, // 1 year
          includeSubDomains: true,
          preload: true,
        }
        : false,
      // Other security headers
      referrerPolicy: { policy: "strict-origin-when-cross-origin" },
      permittedCrossDomainPolicies: false,
      // Allow dev tools in development
      hidePoweredBy: !isDevelopment,
    }),
  );

  app.use(requestIdMiddleware);
  app.use(createResponseValidatorMiddleware());
  app.use(envelopeMiddleware);
  app.use(responseEnrichMiddleware);
  const memoryAccountingMiddleware = createMemoryAccountingMiddleware(
    config.memoryAccounting,
  );
  app.use(memoryAccountingMiddleware);
  app.use(metricsMiddleware);

  app.use(
    createAccessLogMiddleware({
      sampleRate: config.accessLog.sampleRate,
      redactFields: config.accessLog.redactFields,
    }),
  );

  // Parse allowed origins with validation
  const allowedOrigins = (
    process.env.CORS_ALLOWED_ORIGINS ?? "http://localhost:5173"
  )
    .split(",")
    .map((o: string) => o.trim())
    .filter((o: string) => o.length > 0);

  // Validate origins in production
  if (isProduction && allowedOrigins.length === 0) {
    console.warn("WARNING: No CORS_ALLOWED_ORIGINS configured in production");
  }

  // Regex for localhost with optional port (e.g., http://localhost:5173)
  const localhostRegex = /^http:\/\/localhost(:\d+)?$/;

  app.use(
    cors({
      origin: (
        origin: string | undefined,
        callback: (err: Error | null, allow?: boolean) => void,
      ) => {
        // Allow requests with no origin (mobile apps, curl, etc.)
        if (!origin) {
          return callback(null, true);
        }

        // Check if origin is in allowlist
        if (allowedOrigins.includes(origin)) {
          return callback(null, true);
        }

        // In development, allow localhost with any port using strict regex
        if (isDevelopment && localhostRegex.test(origin)) {
          return callback(null, true);
        }

        // Log blocked attempts in production
        if (isProduction) {
          console.warn(`CORS blocked origin: ${origin}`);
        }

        // Pass false instead of Error to prevent Express from returning 500
        callback(null, false);
      },
      methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "x-admin-api-key",
        "x-request-id", // Added for tracing
      ],
      credentials: true,
      exposedHeaders: ["X-Request-Id", "Retry-After", "ETag", "X-Correlation-Id", "RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset"],
      // Reduce preflight cache time in production for security
      maxAge: isProduction ? 600 : 86400, // 10 minutes vs 24 hours
      optionsSuccessStatus: 204, // No content for preflight
    }),
  );
  const requestBodyLimit = process.env.REQUEST_BODY_LIMIT ?? "100kb";
  app.use(demoGuard);
  app.use(createRouteBodyLimitMiddleware(config.routeBodyLimits));
  app.use(express.json({ limit: requestBodyLimit }));
  app.use(express.urlencoded({ extended: false, limit: requestBodyLimit }));
  // Attach req.auditContext (IP, UA, tenantId, correlationId, bodyHash) for all routes.
  app.use(auditEnrichMiddleware);

  // OpenAPI contract validation — only validates paths defined in the spec.
  // Security is handled by custom middleware, not the validator.
  // Skip in test environment to avoid interfering with integration tests.
  const embeddedOpenApi = getEmbeddedAssets()?.openapi;
  if (process.env.NODE_ENV !== "test") {
    app.use(
      OpenApiValidator.middleware({
        apiSpec: embeddedOpenApi
          ? JSON.parse(embeddedOpenApi)
          : path.resolve(process.cwd(), "docs/openapi.json"),
        validateRequests: true,
        // Response validation is disabled in demo mode, where some responses
        // intentionally omit optional contract fields (see README).
        validateResponses: !config.demoMode,
        validateSecurity: false,
        ignoreUndocumented: true,
      }),
    );
  }

  // Register envelope validator after body parser but before routes
  app.use(envelopeValidator);

}
