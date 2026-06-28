import { Router, type Response } from 'express';
import { requireAuth, type AuthenticatedLocals } from '../../middleware/requireAuth.js';
import { UnauthorizedError } from '../../errors/index.js';
import { logger } from '../../logger.js';

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

export class UsageSseBroadcaster {
  private readonly listeners = new Map<string, Set<(event: UsageSseEventPayload) => void>>();

  subscribe(userId: string, listener: (event: UsageSseEventPayload) => void): () => void {
    const listeners = this.listeners.get(userId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(userId, listeners);

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
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
}

export const defaultUsageSseBroadcaster = new UsageSseBroadcaster();

export function createUsageSseRouter(deps: UsageSseDeps = {}): Router {
  const router = Router();
  const broadcaster = deps.broadcaster ?? new UsageSseBroadcaster();

  router.get('/', requireAuth, async (req, res: Response<unknown, AuthenticatedLocals>, next) => {
    const user = res.locals.authenticatedUser;
    if (!user) {
      next(new UnauthorizedError());
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const writeSse = (event: string, payload: unknown): void => {
      const data = JSON.stringify(payload);
      res.write(`event: ${event}\n`);
      res.write(`data: ${data}\n\n`);
    };

    writeSse('connected', { userId: user.id, connectedAt: new Date().toISOString() });

    const unsubscribe = broadcaster.subscribe(user.id, (event) => {
      writeSse('usage', event);
    });

    req.on('close', () => {
      unsubscribe();
      logger.info('[usage.sse] client disconnected', { userId: user.id });
    });

    req.on('aborted', () => {
      unsubscribe();
    });
  });

  return router;
}

export default createUsageSseRouter;
