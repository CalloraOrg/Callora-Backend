import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";

import type { AuthenticatedUser } from "../types/auth.js";
import { UnauthorizedError } from "../errors/index.js";
import { logger } from "../logger.js";

// Re-export the locals shape for files that import it from this module
export type AuthenticatedLocals = {
  authenticatedUser?: AuthenticatedUser;
};

/** Restrict accepted signing algorithms to prevent algorithm-confusion attacks. */
const ALLOWED_ALGORITHMS: jwt.Algorithm[] = ["HS256"];

export interface ResolvedRequestUserId {
  userId?: string;
  error?: UnauthorizedError;
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

  const forwardedUserId = req.header("x-user-id")?.trim();
  return forwardedUserId ? { userId: forwardedUserId } : {};
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
