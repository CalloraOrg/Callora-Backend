import { Router, type Request, type Response } from 'express';
import { requireAuth, type AuthenticatedLocals } from '../../middleware/requireAuth.js';
import { calloraEvents } from '../../events/event.emitter.js';
import { logger } from '../../logger.js';
import type {
  CalloraEventListener,
  CalloraEventName,
  CalloraEventUnsubscribe,
} from '../../events/event.emitter.js';

const SSE_USAGE_EVENT: CalloraEventName = 'new_api_call';
const DEFAULT_HEARTBEAT_MS = 30_000;

interface UsageSseEventBus {
  on(
    event: typeof SSE_USAGE_EVENT,
    listener: CalloraEventListener<typeof SSE_USAGE_EVENT>,
  ): CalloraEventUnsubscribe;
}

export interface UsageSseRouterDeps {
  /** Event emitter to subscribe to. Defaults to the global calloraEvents singleton. */
  events?: UsageSseEventBus;
  /** Heartbeat interval in milliseconds to keep proxies from closing idle streams. */
  heartbeatIntervalMs?: number;
}

function writeSseHeaders(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Express 4 does not expose flushHeaders on Response; safe to call if present.
  if (typeof (res as { flushHeaders?: () => void }).flushHeaders === 'function') {
    (res as { flushHeaders: () => void }).flushHeaders();
  }
}

function formatSseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function formatSseComment(comment: string): string {
  return `: ${comment}\n\n`;
}

export function createUsageSseRouter(deps: UsageSseRouterDeps = {}): Router {
  const router = Router();
  const events = deps.events ?? calloraEvents;
  const heartbeatIntervalMs = deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;

  router.get('/', requireAuth, (req: Request, res: Response<unknown, AuthenticatedLocals>) => {
    const user = res.locals.authenticatedUser;
    if (!user) {
      // Defensive guard: requireAuth already rejects unauthenticated requests.
      res.status(401).json({ message: 'Unauthorized', code: 'UNAUTHORIZED' });
      return;
    }

    writeSseHeaders(res);

    const sendEvent = (event: string, data: unknown) => {
      if (res.writableEnded || res.destroyed) return;
      res.write(formatSseEvent(event, data));
    };

    // Subscribe to live usage events for this developer only.
    const unsubscribe = events.on(SSE_USAGE_EVENT, (developerId, data) => {
      if (developerId !== user.id) return;
      sendEvent(SSE_USAGE_EVENT, data);
    });

    // Periodic heartbeat comment to keep the connection alive behind proxies.
    const heartbeat = setInterval(() => {
      if (res.writableEnded || res.destroyed) return;
      res.write(formatSseComment('heartbeat'));
    }, heartbeatIntervalMs);

    // Notify the client that the stream is ready.
    sendEvent('connected', { stream: 'usage', developerId: user.id });

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
      if (!res.writableEnded && !res.destroyed) {
        res.end();
      }
    };

    req.on('close', cleanup);
    req.on('aborted', cleanup);
    req.on('error', (err) => {
      // Client disconnects are expected for long-lived SSE streams; do not log as errors.
      const code = (err as { code?: string }).code;
      if (code === 'ECONNABORTED' || code === 'ECONNRESET' || err.message === 'aborted') {
        cleanup();
        return;
      }
      logger.error('[usage-sse] request error', { developerId: user.id, error: err.message, code });
      cleanup();
    });

    res.on('error', (err) => {
      logger.error('[usage-sse] response error', { developerId: user.id, error: err.message });
      cleanup();
    });

    logger.info('[usage-sse] client connected', { developerId: user.id });
  });

  return router;
}

export default createUsageSseRouter;
