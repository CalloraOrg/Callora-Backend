import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";

import type { AuthenticatedUser } from "../types/auth.js";
import { UnauthorizedError } from "../errors/index.js";
import { logger } from "../logger.js";

// Re-export the locals shape for files that import it from this module
export type AuthenticatedLocals = {
  authenticatedUser?: AuthenticatedUser;
};

/** Restrict accepted signing algorithms to prevent algorithm-confusion attacks. */
export const ALLOWED_ALGORITHMS: jwt.Algorithm[] = ["HS256"];

export interface ResolvedRequestUserId {
  userId?: string;
  error?: UnauthorizedError;
}

export interface ResolvedRequestJwtUserId extends ResolvedRequestUserId {
  subject?: string;
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

/** Resolve only cryptographically verified JWT claims, never forwarded headers. */
export function resolveRequestJwtUserId(req: Request): ResolvedRequestJwtUserId {
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

      const payload = decoded as Record<string, unknown>;
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

      const subject = typeof payload.sub === "string" && payload.sub.trim() !== ""
        ? payload.sub
        : undefined;
      return { userId: uid, subject };
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

  return {};
}

export function resolveRequestUserId(req: Request): ResolvedRequestUserId {
  if (req.header("authorization") !== undefined) {
    const result = resolveRequestJwtUserId(req);
    return result.userId ? { userId: result.userId } : result;
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

  res.locals.authenticatedUser = { id: userId };
  req.developerId = userId; // Keep req.developerId backwards compatibility since main branch router depends on it
  next();
};
