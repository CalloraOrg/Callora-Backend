import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";

import type { AuthenticatedUser } from "../types/auth.js";
import { UnauthorizedError } from "../errors/index.js";
import { logger } from "../logger.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { getForwardedIdentityReplayStore } from "../services/forwardedIdentityReplayStore.js";

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

/** Gateway helper. `now` is epoch milliseconds; the header is integer Unix seconds. */
export function signForwardedIdentity({ secret, method, path, userId, now = Date.now() }: {
  secret: string; method: string; path: string; userId: string; now?: number;
}): { signature: string; timestamp: string } {
  const timestamp = String(Math.floor(now / 1000));
  const exactPath = path.split("?")[0];
  if (!secret || !/^[A-Z]+$/.test(method) || !exactPath.startsWith("/") ||
      /[\r\n]/.test(exactPath + userId) || !userId || userId !== userId.trim() ||
      !Number.isSafeInteger(now) || now < 0) {
    throw new Error("Invalid forwarded identity signing input");
  }
  const payload = `v1\n${timestamp}\n${method}\n${exactPath}\n${userId}`;
  return { timestamp, signature: `v1=${crypto.createHmac("sha256", secret).update(payload).digest("hex")}` };
}

function matchesSignature(raw: string, expected: string): boolean {
  return /^[0-9a-f]{64}$/i.test(raw) && crypto.timingSafeEqual(
    Buffer.from(raw, "hex"), Buffer.from(expected, "hex"),
  );
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

// Cache the in-flight claim as well as its result: limiters and auth must not
// consume the same signature twice, even when invoked concurrently on one request.
const identities = new WeakMap<Request, Promise<ResolvedRequestUserId>>();
export function resolveRequestUserId(req: Request): Promise<ResolvedRequestUserId> {
  const cached = identities.get(req);
  if (cached) return cached;
  const result = resolveIdentity(req);
  identities.set(req, result);
  return result;
}

async function resolveIdentity(req: Request): Promise<ResolvedRequestUserId> {
  if (req.header("authorization") !== undefined) {
    const result = resolveRequestJwtUserId(req);
    return result.userId ? { userId: result.userId } : result;
  }
  if (process.env.TRUST_FORWARDED_USER_ID !== "true") return {};
  const userId = req.header("x-user-id")?.trim();
  if (!userId) return {};
  const reject = (reason: string, code: "UNAUTHORIZED" | "STALE_FORWARDED_IDENTITY" | "REPLAYED_FORWARDED_IDENTITY" = "UNAUTHORIZED"): ResolvedRequestUserId => {
    logger.warn("[requireAuth] Forwarded identity rejected", { reason, code });
    return { error: new UnauthorizedError("Invalid forwarded identity", code) };
  };
  const secret = process.env.FORWARDED_USER_ID_SECRET || process.env.INTERNAL_GATEWAY_SECRET;
  const signature = req.header("x-gateway-signature") || req.header("x-internal-signature");
  const timestamp = req.header("x-gateway-timestamp") || req.header("x-callora-timestamp");
  if (!secret || !signature || /[\r\n]/.test(userId)) return reject("missing_or_invalid_credentials");
  const now = Date.now();
  const tolerance = Number(process.env.FORWARDED_IDENTITY_TOLERANCE_SECONDS ?? 60);
  if (!Number.isSafeInteger(tolerance) || tolerance < 1 || tolerance > 3600) return reject("invalid_tolerance");
  let raw: string;
  let expiresAt: number;
  if (signature.startsWith("v1=")) {
    if (!timestamp || !/^(0|[1-9][0-9]{0,12})$/.test(timestamp)) {
      return reject("malformed_timestamp", "STALE_FORWARDED_IDENTITY");
    }
    const seconds = Number(timestamp);
    if (Math.abs(Math.floor(now / 1000) - seconds) > tolerance) {
      return reject("timestamp_outside_window", "STALE_FORWARDED_IDENTITY");
    }
    const path = req.originalUrl?.split("?")[0];
    if (!path?.startsWith("/") || /[\r\n]/.test(path) || !/^[A-Z]+$/.test(req.method)) return reject("invalid_request_target");
    raw = signature.slice(3);
    const expected = signForwardedIdentity({ secret, method: req.method, path, userId, now: seconds * 1000 });
    if (!matchesSignature(raw, expected.signature.slice(3))) return reject("signature_mismatch");
    // Include the entire last valid second, also for future-dated signatures.
    expiresAt = (seconds + tolerance + 1) * 1000 - 1;
  } else {
    if (process.env.FORWARDED_IDENTITY_ALLOW_LEGACY !== "true" || process.env.NODE_ENV === "production") return reject("legacy_disabled");
    logger.warn("[requireAuth] Deprecated legacy forwarded identity enabled; migrate to v1");
    raw = signature.startsWith("sha256=") ? signature.slice(7) : signature;
    const payloads = [userId, ...(timestamp ? [`${timestamp}.${userId}`] : [])];
    if (!payloads.some(payload => matchesSignature(raw, crypto.createHmac("sha256", secret).update(payload).digest("hex")))) return reject("signature_mismatch");
    expiresAt = now + tolerance * 1000;
  }
  try {
    if (!await getForwardedIdentityReplayStore().claim(raw.toLowerCase(), expiresAt, now)) {
      return reject("signature_already_used", "REPLAYED_FORWARDED_IDENTITY");
    }
  } catch {
    // Never fall back to a per-process store on database failure.
    return reject("replay_store_unavailable");
  }
  return { userId };
}

export const requireAuth = asyncHandler(async (
  req: Request,
  res: Response<unknown, AuthenticatedLocals>,
  next: NextFunction,
): Promise<void> => {
  const { userId, error } = await resolveRequestUserId(req);
  if (error) { next(error); return; }
  if (!userId) { next(new UnauthorizedError()); return; }
  res.locals.authenticatedUser = { id: userId };
  req.developerId = userId;
  next();
});
