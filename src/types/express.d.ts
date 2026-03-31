import type { AuthenticatedUser } from "./auth";

declare global {
  namespace Express {
    /**
     * Locals available on Response.locals throughout the app.
     * Add other commonly used locals here to avoid per-file casts.
     */
    interface Locals {
      authenticatedUser?: AuthenticatedUser;
      // dbPool is set in `app.ts` during initialization and is useful in handlers
      dbPool?: unknown;
    }

    interface Request {
      id: string;
      developerId?: string;
      user?: Record<string, unknown>;
      vault?: Record<string, unknown> | null;
      api?: Record<string, unknown>;
      endpoint?: Record<string, unknown>;
      apiKeyRecord?: Record<string, unknown>;
      apiKeyValue?: string;
    }
  }
}

export {};
