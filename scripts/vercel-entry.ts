// Entry bundled into the Vercel serverless function (see scripts/build-vercel.mjs).
import type { IncomingMessage, ServerResponse } from "http";
import app from "../src/index.js";
import { initializeDb } from "../src/db/index.js";
import { errorEnvelope, getRequestId } from "../src/lib/envelope.js";

let isReady = false;
let initPromise: Promise<void> | null = null;
let lastFailureTime = 0;
const DEFAULT_BACKOFF_MS = 5000;

/**
 * Reset readiness state. Exported for tests.
 */
export function resetReadinessState(): void {
  isReady = false;
  initPromise = null;
  lastFailureTime = 0;
}

/**
 * Check if the instance database is currently marked ready.
 */
export function isDbReady(): boolean {
  return isReady;
}

/**
 * Self-healing database readiness check.
 *
 * Memoises success across warm invocations. If initialization fails, the memo
 * is cleared, a structured error is logged, and subsequent requests back off
 * (at most one attempt per backoffMs, default 5s) instead of stampeding the
 * database or caching permanent failure.
 */
export async function ensureReady(backoffMs = DEFAULT_BACKOFF_MS): Promise<boolean> {
  if (isReady) return true;

  const now = Date.now();
  if (lastFailureTime > 0 && now - lastFailureTime < backoffMs && now >= lastFailureTime) {
    return false;
  }

  if (!initPromise) {
    initPromise = (async () => {
      try {
        await initializeDb();
        isReady = true;
        initPromise = null;
      } catch (error) {
        lastFailureTime = Date.now();
        initPromise = null;
        isReady = false;
        console.error(
          JSON.stringify({
            level: "error",
            event: "demo_db_init_failed",
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString(),
          }),
        );
        throw error;
      }
    })();
  }

  try {
    await initPromise;
    return true;
  } catch {
    return false;
  }
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const reqObj = req as unknown as { headers: Record<string, string | string[] | undefined> };
  const requestId = getRequestId(reqObj);

  const ready = await ensureReady();
  if (!ready) {
    const envelope = errorEnvelope(
      "SERVICE_INITIALIZING",
      "Service is initializing. Please retry shortly.",
      requestId,
    );
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("X-Request-Id", requestId);
    res.setHeader("Retry-After", "5");
    res.end(JSON.stringify(envelope));
    return;
  }

  try {
    (app as unknown as (req: IncomingMessage, res: ServerResponse) => void)(req, res);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "vercel_handler_sync_error",
        requestId,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: new Date().toISOString(),
      }),
    );
    if (!res.headersSent) {
      const envelope = errorEnvelope(
        "INTERNAL_SERVER_ERROR",
        "Internal server error",
        requestId,
      );
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("X-Request-Id", requestId);
      res.end(JSON.stringify(envelope));
    }
  }
}
