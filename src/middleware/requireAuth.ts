import type { NextFunction, Request, Response } from "express";
import jwt from "jsonswebtoken";
import crypto from "node:crypto";

import type { AuthenticatedUser } from "../types/auth.js";
import { UnauthorizedError } from "../errors/index.js";
import { logger } from "../logger.js";

// Re-export the locals shape for files that import it from this module
export type AuthenticatedLocals = {
  authenticatedUser?: AuthenticatedUser;
  authenticatedService?: AuthenticatedService;
};

/** Restrict accepted signing algorithms to prevent algorithm-confusion attacks. */
const ALLOWED_ALGORITHMS: jsonswebtoken.Algorithm[] = ["HS256"];

/**
 * Authenticated service principal derived from a bearer token.
 * Service principals are not users; they carry explicit scopes.
 */
export interface AuthenticatedService {
  id: string;
  scopes: string[];
  isService: true;
}

export interface ResolvedRequestUserId {
  userId?: string;
  error?: UnauthorizedError;
}

/**
 * Compute the HMAC-SHA256 signature for a forwarded user identity.
 */
export function computeGatewaySignature(
  secret: string,
  userId: string,
  timestamp?: string,
): string {
  const payload = timestamp ? `${timestamp}.${userId}` : userId;
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * Timing-safe verification of internal gateway signature.
 */
export function verifyGatewaySignature(
  userId: string,
  signatureHeader?: string,
  timestampHeader?: string,
): boolean {
  const secret =
    process.env.FORWARDED_USER_ID_SECRET ||
    process.env.INTERNAL_GATEWAY_SECRET;

  if (!secret || !signatureHeader) {
    return false;
  }

  const rawSig = signatureHeader.startsWith("sha256=")
    ? signatureHeader.slice("sha256=".length)
    : signatureHeader;

  // Verify against plain userId and against timestamp.userId if timestampHeader is present
  const candidates = [computeGatewaySignature(secret, userId)];
  if (timestampHeader) {
    candidates.push(computeGatewaySignature(secret, userId, timestampHeader));
  }

  return candidates.some((expectedSig) => {
    if (rawSig.length !== expectedSig.length) return false;
    if (!/^[0-9a-f]+$/i.test(rawSig)) return false;
    return crypto.timingSafeEqual(
      Buffer.from(rawSig, "hex"),
      Buffer.from(expectedSig, "hex"),
    );
  });
}

/**
 * Extract granted scopes from a decoded JWT payload.
 * Accepts `scope` (comma/space-separated string) and `scopes` (string array).
 */
export function extractScopes(payload: Record<unknown>): string[] {
  const scopes: string[] = [];

  const rawScope = payload.scope;
  if (typeof rawScope === "string") {
    for (const part of rawScope.split(/[\s,]+/)) {
      if (part) scopes.push(part);
    }
  }

  const rawScopes = payload.scopes;
  if (Array.isArray(rawScopes)) {
    for (const entry of rawScopes) {
      if (typeof entry === "string" && entry) {
        scopes.push(entry);
      }
    }
  }

  return scopes;
}

export function resolveRequestUserId(req: Request): ResolvedRequestUserId {
  const authHeader = req.header("authorization");
  if (authHeader !== undefined) {
    if (!authHeader.startsWith("Bearer ")) {
      return {
        error: new UnauthorizedError(
          "Invalid authorization header",
          "INVALID_AUTH_HEADER",
        ),
      };
    }

    const token = authHeader.slice("Bearer ".length).trim();
    if (!token) {
      return {
        error: new UnauthorizedError("Missing token", "MISSING_TOKEN"),
      };
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      logger.error("[requireAuth] JWT_SECRET is not configured");
      return { error: new UnauthorizedError() };
    }

    try {
      const decoded = jwt.verify(token, secret, {
        algorithms: ALLOWED_ALGORITHMS,
      });

      if (typeof decoded === "string" || !decoded) {
        logger.warn("[requireAuth] Token payload is not a valid object");
        return {
          error: new UnauthorizedError("Invalid token", "INVALID_TOKEN"),
        };
      }

      const payload = decoded as Record<unknown>;
      const uid = payload.userId || payload.sub;

      if (typeof uid !== "string" || uid.trim() === "") {
        logger.warn("[requireAuth] Token missing required userId or sub claim");
        return {
          error: new UnauthorizedError(
            "Token missing required claims",
            "MISSING_CLAIMS",
          ),
        };
      }

      return { userId: uid };
    } catch (err) {
      const code =
        err instanceof jwt.TokenExpiredError
          ? "TOKEN_EXPIRED"
          : err instanceof jwt.NotBeforeError
            ? "TOKEN_NOT_ACTIVE"
            : "INVALID_TOKEN";

      logger.warn("[requireAuth] JWT verification failed", { code });
      return {
        error: new UnauthorizedError(
          code === "TOKEN_EXPIRED" ? "Token expired" : "Invalid token",
          code,
        ),
      };
    }
  }

  // Only accept x-user-id if TRUST_FORWARDED_USER_ID is explicitly enabled AND a valid internal gateway signature is present
  const trustForwardedUserId = process.env.TRUST_FORWARDED_USER_ID === "true";
  if (trustForwardedUserId) {
    const forwardedUserId = req.header("x-user-id")?.trim();
    const gatewaySignature =
      req.header("x-gateway-signature") || req.header("x-internal-signature");
    const timestampHeader =
      req.header("x-gateway-timestamp") || req.header("x-callora-timestamp");

    if (
      forwardedUserId &&
      verifyGatewaySignature(forwardedUserId, gatewaySignature, timestampHeader)
    ) {
      return { userId: forwardedUserId };
    }
  }

  return {};
}

/**
 * Resolve an authenticated service principal from the Bearer token,
 * if the token carries the `type: "service"` claim. Returns null for
 * ordinary user tokens.
 */
export function resolveRequestService(req: Request): AuthenticatedService | null {
  const authHeader = req.header("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) return null;

  const secret = process.env.JWT_SECRET;
  if (!secret) return null;

  try {
    const decoded = jwt.verify(token, secret, {
      algorithms: ALLOWED_ALGORITHMS,
    });

    if (typeof decoded === "string" || !decoded) return null;

    const payload = decoded as Record<unknown>;
    if (payload.type !== "service") return null;

    const uid = payload.userId || payload.sub;
    if (typeof uid !== "string" || uid.trim() === "") return null;

    return {
      id: uid,
      scopes: extractScopes(payload),
      isService: true,
    };
  } catch {
    return null;
  }
}

export const requireAuth = (
  req: Request,
  res: Response<unknown, AuthenticatedLocals>,
  next: NextFunction,
): void => {
  const { userId, error } = resolveRequestUserId(req);
  if (error) {
    next(error);
    return;
  }

  if (!userId) {
    next(new UnauthorizedError());
    return;
  }

  const service = resolveRequestService(req);

  res.locals.authenticatedUser = { id: userId };
  if (service) {
    res.locals.authenticatedService = service;
  }
  req.developerId = userId; // Keep req.developerId backwards compatibility since main branch router depends on it
  next();
};
