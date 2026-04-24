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

export const requireAuth = (
  req: Request,
  res: Response<unknown, AuthenticatedLocals>,
  next: NextFunction,
): void => {
  let userId: string | undefined;

  const authHeader = req.header("authorization");
  if (authHeader !== undefined) {
    if (authHeader.startsWith("Bearer ")) {
      const token = authHeader.slice("Bearer ".length).trim();

      if (!token) {
        next(new UnauthorizedError("Missing token", "MISSING_TOKEN"));
        return;
      }

      const secret = process.env.JWT_SECRET;
      if (!secret) {
        logger.error("[requireAuth] JWT_SECRET is not configured");
        next(new UnauthorizedError());
        return;
      }

      try {
        const decoded = jwt.verify(token, secret, {
          algorithms: ALLOWED_ALGORITHMS,
        });

        // jwt.verify can return a plain string for unsigned payloads
        if (typeof decoded === "string" || !decoded) {
          logger.warn("[requireAuth] Token payload is not a valid object");
          next(new UnauthorizedError("Invalid token", "INVALID_TOKEN"));
          return;
        }

        const uid = (decoded as Record<string, unknown>).userId;
        if (typeof uid !== "string" || uid.trim() === "") {
          logger.warn("[requireAuth] Token missing required userId claim");
          next(
            new UnauthorizedError(
              "Token missing required claims",
              "MISSING_CLAIMS",
            ),
          );
          return;
        }

        userId = uid;
      } catch (err) {
        // Log the failure reason but never the token contents
        const code =
          err instanceof jwt.TokenExpiredError
            ? "TOKEN_EXPIRED"
            : err instanceof jwt.NotBeforeError
              ? "TOKEN_NOT_ACTIVE"
              : "INVALID_TOKEN";

        logger.warn("[requireAuth] JWT verification failed", { code });
        next(
          new UnauthorizedError(
            code === "TOKEN_EXPIRED" ? "Token expired" : "Invalid token",
            code,
          ),
        );
        return;
      }
    } else {
      next(new UnauthorizedError("Invalid authorization header", "INVALID_AUTH_HEADER"));
      return;
    }
  } else {
    const forwardedUserId = req.header("x-user-id");
    userId = forwardedUserId?.trim();
  }

  if (!userId) {
    next(new UnauthorizedError());
    return;
  }

  res.locals.authenticatedUser = { id: userId };
  req.developerId = userId; // Keep req.developerId backwards compatibility since main branch router depends on it
  next();
};
