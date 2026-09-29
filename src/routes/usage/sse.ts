import { Router, type Response } from 'express';
import { requireAuth, type AuthenticatedLocals } from '../../middleware/requireAuth.js';
import { UnauthorizedError } from '../../errors/index.js';
import { logger } from '../../logger.js';
import { getRequestId } from '../../utils/asyncContext.js';

export interface UsageSseDeps {
  broadcaster?: UsageSseBroadcaster;
}

export interface UsageSseEventPayload {
  id: string;
  requestId: string;
  apiKey: string;
  apiKeyId: string;
  apiId: string;
  endpointId: string;
  userId: string;
  amountUsdc: number;
  statusCode: number;
  timestamp: string;
}

export type UsageSseListener = (event: UsageSseEventPayload) => void;

export class UsageSseBroadcaster {
  private readonly listeners = new Map<string, Set<UsageSseListener>>();

  /**
   * Register `listener` for `userId` and return an idempotent unsubscribe.
   *
   * Buckets are keyed strictly by user id, so a stream can only ever observe
   * events emitted for its own user. The returned unsubscribe is safe to call
   * more than once (clients disconnect can surface as `close`, `aborted` and
   * response `close`) and it only ever drops the bucket it was created with,
   * never a newer bucket registered by a later stream for the same user.
   */
  subscribe(userId: string, listener: UsageSseListener): () => void {
    const listeners = this.listeners.get(userId) ?? new Set<UsageSseListener>();
    listeners.add(listener);
    this.listeners.set(userId, listeners);

    let unsubscribed = false;
    return () => {
      if (unsubscribed) {
        return;
      }
      unsubscribed = true;

      listeners.delete(listener);
      if (listeners.size === 0 && this.listeners.get(userId) === listeners) {
        this.listeners.delete(userId);
      }
    };
  }

  emitForUser(userId: string, event: UsageSseEventPayload): void {
    const listeners = this.listeners.get(userId);
    if (!listeners || listeners.size === 0) {
      return;
    }

    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        logger.error('[usage.sse] failed to dispatch event', { userId, error });
      }
    }
  }

  /** Number of live streams currently attached to `userId`. */
  listenerCount(userId: string): number {
    return this.listeners.get(userId)?.size ?? 0;
  }

  /** Number of user ids currently tracked; `0` means nothing is subscribed. */
  trackedUserCount(): number {
    return this.listeners.size;
  }

  clear(): void {
    this.listeners.clear();
  }
}

export const defaultUsageSseBroadcaster = new UsageSseBroadcaster();

export function createUsageSseRouter(deps: UsageSseDeps = {}): Router {
  const router = Router();
  const broadcaster = deps.broadcaster ?? defaultUsageSseBroadcaster;

  router.get('/', requireAuth, async (req, res: Response<unknown, AuthenticatedLocals>, next) => {
    const user = res.locals.authenticatedUser;
    if (!user) {
      next(new UnauthorizedError());
      return;
    }

    const requestId = req.id ?? getRequestId();

    logger.info('[usage.sse] client connected', {
      userId: user.id,
      requestId,
    });

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const writeSse = (event: string, payload: unknown): void => {
      if (res.writableEnded || res.destroyed) {
        return;
      }

      const data = JSON.stringify(payload);
      if (payload !== null && typeof payload === 'object' && 'id' in payload) {
        res.write(`id: ${(payload as { id: string }).id}\n`);
      }
      res.write(`event: ${event}\n`);
      res.write(`data: ${data}\n\n`);
    };

    writeSse('connected', { userId: user.id, connectedAt: new Date().toISOString() });

    const unsubscribe = broadcaster.subscribe(user.id, (event) => {
      writeSse('usage', event);
    });

    let disconnected = false;
    const disconnect = (reason: 'close' | 'aborted' | 'response-close'): void => {
      if (disconnected) {
        return;
      }
      disconnected = true;

      unsubscribe();
      logger.info('[usage.sse] client disconnected', {
        userId: user.id,
        requestId,
        reason,
      });
    };

    req.once('close', () => disconnect('close'));
    req.once('aborted', () => disconnect('aborted'));
    res.once('close', () => disconnect('response-close'));
  });

  return router;
}

export default createUsageSseRouter;
