import { Router, type Response } from 'express';
import { requireAuth, type AuthenticatedLocals } from '../../middleware/requireAuth.js';
import { TooManyRequestsError, UnauthorizedError } from '../../errors/index.js';
import { logger } from '../../logger.js';
import { getRequestId } from '../../utils/asyncContext.js';
import {
  incrementUsageSseActiveConnections,
  decrementUsageSseActiveConnections,
} from '../../metrics.js';

export const DEFAULT_USAGE_SSE_BUFFER_SIZE = 100;
export const DEFAULT_USAGE_SSE_HEARTBEAT_INTERVAL_MS = 20_000;
export const DEFAULT_USAGE_SSE_MAX_CONNECTIONS_PER_USER = 5;
export const DEFAULT_USAGE_SSE_RETRY_MS = 3_000;

export interface UsageSseBroadcasterOptions {
  maxBufferSize?: number;
}

export interface UsageSseDeps {
  broadcaster?: UsageSseBroadcaster;
  heartbeatIntervalMs?: number;
  maxConnectionsPerUser?: number;
  retryMs?: number;
}

export interface UsageSseEventPayload {
  id: string;
  requestId: string;
  apiKeyId: string;
  apiKeyPrefix?: string;
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
  private readonly eventBuffer = new Map<string, UsageSseEventPayload[]>();
  private readonly maxBufferSize: number;

  constructor(options: UsageSseBroadcasterOptions = {}) {
    const configured =
      options.maxBufferSize ??
      Number(process.env.USAGE_SSE_BUFFER_SIZE ?? DEFAULT_USAGE_SSE_BUFFER_SIZE);
    this.maxBufferSize =
      Number.isFinite(configured) && configured >= 0
        ? Math.floor(configured)
        : DEFAULT_USAGE_SSE_BUFFER_SIZE;
  }

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
    if (this.maxBufferSize > 0) {
      const buffer = this.eventBuffer.get(userId) ?? [];
      buffer.push(event);
      while (buffer.length > this.maxBufferSize) {
        buffer.shift();
      }
      this.eventBuffer.set(userId, buffer);
    }

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

  /**
   * Returns events emitted for `userId` strictly after `lastEventId` in
   * chronological order. Unknown IDs return an empty array without throwing.
   */
  getEventsAfter(userId: string, lastEventId: string): UsageSseEventPayload[] {
    if (!lastEventId) {
      return [];
    }
    const buffer = this.eventBuffer.get(userId);
    if (!buffer || buffer.length === 0) {
      return [];
    }
    const index = buffer.findIndex((evt) => evt.id === lastEventId);
    if (index === -1) {
      return [];
    }
    return buffer.slice(index + 1);
  }

  /** Number of buffered events currently retained for `userId`. */
  bufferedEventCount(userId: string): number {
    return this.eventBuffer.get(userId)?.length ?? 0;
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
    this.eventBuffer.clear();
  }
}

export const defaultUsageSseBroadcaster = new UsageSseBroadcaster();

export function createUsageSseRouter(deps: UsageSseDeps = {}): Router {
  const router = Router();
  const broadcaster = deps.broadcaster ?? defaultUsageSseBroadcaster;
  const heartbeatIntervalMs =
    deps.heartbeatIntervalMs ??
    Number(process.env.USAGE_SSE_HEARTBEAT_INTERVAL_MS ?? DEFAULT_USAGE_SSE_HEARTBEAT_INTERVAL_MS);
  const maxConnectionsPerUser =
    deps.maxConnectionsPerUser ??
    Number(
      process.env.USAGE_SSE_MAX_CONNECTIONS_PER_USER ??
        DEFAULT_USAGE_SSE_MAX_CONNECTIONS_PER_USER,
    );
  const retryMs =
    deps.retryMs ??
    Number(process.env.USAGE_SSE_RETRY_MS ?? DEFAULT_USAGE_SSE_RETRY_MS);

  router.get('/', requireAuth, (req, res: Response<unknown, AuthenticatedLocals>, next) => {
    const user = res.locals.authenticatedUser;
    if (!user) {
      next(new UnauthorizedError());
      return;
    }

    if (
      Number.isFinite(maxConnectionsPerUser) &&
      maxConnectionsPerUser > 0 &&
      broadcaster.listenerCount(user.id) >= maxConnectionsPerUser
    ) {
      next(
        new TooManyRequestsError(
          'Too many concurrent SSE connections for this user',
        ),
      );
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

    if (Number.isFinite(retryMs) && retryMs > 0) {
      res.write(`retry: ${Math.floor(retryMs)}\n`);
    }
    writeSse('connected', { userId: user.id, connectedAt: new Date().toISOString() });

    const lastEventId = req.header('last-event-id')?.trim();
    if (lastEventId) {
      const missedEvents = broadcaster.getEventsAfter(user.id, lastEventId);
      for (const missed of missedEvents) {
        writeSse('usage', missed);
      }
    }

    const unsubscribe = broadcaster.subscribe(user.id, (event) => {
      writeSse('usage', event);
    });
    incrementUsageSseActiveConnections();

    const heartbeatTimer =
      Number.isFinite(heartbeatIntervalMs) && heartbeatIntervalMs > 0
        ? setInterval(() => {
            if (!res.writableEnded && !res.destroyed) {
              res.write(': ping\n\n');
            }
          }, heartbeatIntervalMs)
        : null;
    heartbeatTimer?.unref?.();

    let disconnected = false;
    const disconnect = (reason: 'close' | 'aborted' | 'response-close'): void => {
      if (disconnected) {
        return;
      }
      disconnected = true;

      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
      unsubscribe();
      decrementUsageSseActiveConnections();
      logger.info('[usage.sse] client disconnected', {
        userId: user.id,
        requestId,
        reason,
      });
    };

    req.once('close', () => disconnect('close'));
    req.once('aborted', () => disconnect('aborted'));
    req.on('error', () => disconnect('aborted'));
    res.once('close', () => disconnect('response-close'));
    res.on('error', () => disconnect('response-close'));
  });

  return router;
}

export default createUsageSseRouter;
