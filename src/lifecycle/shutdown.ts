/**
 * Graceful Shutdown Module
 *
 * Handles SIGTERM/SIGINT signals by:
 * 1. Stopping acceptance of new requests
 * 2. Draining in-flight requests (up to 30s)
 * 3. Stopping background subsystems (jobs, dispatchers)
 * 4. Closing database pools
 * 5. Exiting with appropriate code
 *
 * @module lifecycle/shutdown
 */

import type { Server } from 'http';
import type { Socket } from 'net';
import type { RequestHandler } from 'express';
import { logger } from '../logger.js';

/**
 * Subsystem that can be gracefully shut down and drained.
 *
 * Subsystems must implement:
 * - `beginShutdown`: Signal to stop accepting new work
 * - `awaitIdle`: Wait for in-flight work to complete
 */
export interface DrainableSubsystem {
  /** Human-readable name for logging */
  name: string;
  /** Signal the subsystem to stop accepting new work */
  beginShutdown: () => void | Promise<void>;
  /** Wait for all in-flight work to complete */
  awaitIdle: () => Promise<void>;
}

/**
 * Configuration for graceful shutdown handler
 */
export interface GracefulShutdownOptions {
  /** HTTP server instance */
  server: Server;
  /** Set of active socket connections to forcefully close after timeout */
  activeConnections: Set<Socket>;
  /** Callback to close all database pools and resources */
  closeDatabase: () => Promise<void>;
  /** Logger instance (defaults to console) */
  logger?: Pick<typeof console, 'log' | 'warn' | 'error'>;
  /** Maximum time to wait for graceful drain (default: 30000ms) */
  timeoutMs?: number;
  /** List of subsystems to drain before database closure */
  subsystems?: DrainableSubsystem[];
}

/**
 * Shutdown phase for structured logging
 */
enum ShutdownPhase {
  SIGNAL_RECEIVED = 'signal_received',
  SUBSYSTEMS_STOPPING = 'subsystems_stopping',
  SERVER_CLOSING = 'server_closing',
  SUBSYSTEMS_DRAINING = 'subsystems_draining',
  TIMEOUT_REACHED = 'timeout_reached',
  DATABASE_CLOSING = 'database_closing',
  COMPLETE = 'complete',
  ERROR = 'error',
}

/**
 * Creates a graceful shutdown handler that coordinates orderly shutdown
 * of the HTTP server, background subsystems, and database resources.
 *
 * @param options - Shutdown configuration
 * @returns Shutdown handler function that accepts signals
 *
 * @example
 * ```typescript
 * const shutdown = createGracefulShutdownHandler({
 *   server,
 *   activeConnections,
 *   closeDatabase: async () => { await pool.end(); },
 *   timeoutMs: 30_000,
 *   subsystems: [jobScheduler, webhookDispatcher],
 * });
 *
 * process.once('SIGTERM', () => shutdown('SIGTERM').then(process.exit));
 * ```
 */
export function createGracefulShutdownHandler({
  server,
  activeConnections,
  closeDatabase,
  logger: log = console,
  timeoutMs = 30_000,
  subsystems = [],
}: GracefulShutdownOptions): (signal: NodeJS.Signals) => Promise<number> {
  let inFlight: Promise<number> | null = null;

  return (signal: NodeJS.Signals): Promise<number> => {
    // Prevent concurrent shutdown attempts
    if (inFlight) {
      log.warn('Shutdown already in progress, ignoring duplicate signal');
      return inFlight;
    }

    inFlight = new Promise<number>((resolve) => {
      const startTime = Date.now();
      
      log.log(`[shutdown:${ShutdownPhase.SIGNAL_RECEIVED}] Received ${signal}, initiating graceful shutdown`);

      // Set timeout to forcefully destroy connections after grace period
      const forceCloseTimeout = setTimeout(() => {
        const duration = Date.now() - startTime;
        log.warn(
          `[shutdown:${ShutdownPhase.TIMEOUT_REACHED}] Graceful drain exceeded ${timeoutMs}ms, forcefully closing ${activeConnections.size} connection(s) (elapsed: ${duration}ms)`
        );
        
        for (const socket of activeConnections) {
          socket.destroy();
        }
      }, timeoutMs);

      /**
       * Phase 1: Stop all subsystems from accepting new work
       */
      const stopSubsystems = async (): Promise<boolean> => {
        if (subsystems.length === 0) {
          return true;
        }

        log.log(
          `[shutdown:${ShutdownPhase.SUBSYSTEMS_STOPPING}] Stopping ${subsystems.length} subsystem(s): ${subsystems.map((s) => s.name).join(', ')}`
        );

        let allStopped = true;

        for (const subsystem of subsystems) {
          try {
            await subsystem.beginShutdown();
            log.log(`[shutdown:${ShutdownPhase.SUBSYSTEMS_STOPPING}] Stopped subsystem: ${subsystem.name}`);
          } catch (error) {
            allStopped = false;
            log.error(`[shutdown:${ShutdownPhase.ERROR}] Failed to stop subsystem ${subsystem.name}:`, error);
          }
        }

        return allStopped;
      };

      /**
       * Phase 2: Wait for subsystems to drain in-flight work
       */
      const drainSubsystems = async (): Promise<boolean> => {
        if (subsystems.length === 0) {
          return true;
        }

        log.log(
          `[shutdown:${ShutdownPhase.SUBSYSTEMS_DRAINING}] Draining ${subsystems.length} subsystem(s) (timeout: ${timeoutMs}ms)`
        );

        const drainPromises = subsystems.map(async (subsystem) => {
          try {
            await subsystem.awaitIdle();
            log.log(`[shutdown:${ShutdownPhase.SUBSYSTEMS_DRAINING}] Drained subsystem: ${subsystem.name}`);
          } catch (error) {
            log.error(`[shutdown:${ShutdownPhase.ERROR}] Error draining subsystem ${subsystem.name}:`, error);
            throw error;
          }
        });

        const results = await Promise.race([
          Promise.allSettled(drainPromises),
          new Promise<'timeout'>((timeoutResolve) => {
            setTimeout(() => timeoutResolve('timeout'), timeoutMs);
          }),
        ]);

        if (results === 'timeout') {
          log.warn(
            `[shutdown:${ShutdownPhase.TIMEOUT_REACHED}] Subsystem drain timeout after ${timeoutMs}ms`
          );
          return false;
        }

        let allDrained = true;
        for (const [index, result] of results.entries()) {
          if (result.status === 'rejected') {
            allDrained = false;
            log.error(
              `[shutdown:${ShutdownPhase.ERROR}] Subsystem ${subsystems[index]?.name ?? 'unknown'} drain failed:`,
              result.reason
            );
          }
        }

        return allDrained;
      };

      /**
       * Phase 3: Close HTTP server (stops accepting new connections)
       */
      const closeServer = (): Promise<boolean> => {
        log.log(`[shutdown:${ShutdownPhase.SERVER_CLOSING}] Closing HTTP server`);

        return new Promise<boolean>((closeResolve) => {
          server.close((error?: Error) => {
            if (error) {
              log.error(`[shutdown:${ShutdownPhase.ERROR}] Error closing HTTP server:`, error);
              closeResolve(false);
              return;
            }

            log.log(`[shutdown:${ShutdownPhase.SERVER_CLOSING}] HTTP server closed successfully`);
            closeResolve(true);
          });
        });
      };

      /**
       * Execute shutdown phases in sequence
       */
      void (async () => {
        let exitCode = 0;

        try {
          // Phase 1 & 2: Stop and drain subsystems
          const subsystemsStopped = await stopSubsystems();
          const serverClosed = await closeServer();
          const subsystemsDrained = await drainSubsystems();

          // Clear the force-close timeout since we completed gracefully
          clearTimeout(forceCloseTimeout);

          // Phase 3: Close database resources
          log.log(`[shutdown:${ShutdownPhase.DATABASE_CLOSING}] Closing database pools`);
          
          try {
            await closeDatabase();
            log.log(`[shutdown:${ShutdownPhase.DATABASE_CLOSING}] Database pools closed successfully`);
          } catch (dbError) {
            log.error(`[shutdown:${ShutdownPhase.ERROR}] Error closing database:`, dbError);
            exitCode = 1;
          }

          // Determine exit code based on phase results
          if (!subsystemsStopped || !serverClosed || !subsystemsDrained) {
            exitCode = 1;
          }

          const duration = Date.now() - startTime;
          log.log(
            `[shutdown:${ShutdownPhase.COMPLETE}] Shutdown complete (exit_code: ${exitCode}, duration: ${duration}ms)`
          );
        } catch (error) {
          clearTimeout(forceCloseTimeout);
          log.error(`[shutdown:${ShutdownPhase.ERROR}] Unexpected error during shutdown:`, error);
          exitCode = 1;
        }

        resolve(exitCode);
      })();
    });

    return inFlight;
  };
}

/**
 * Creates an in-flight request tracker that integrates with Express middleware
 * and provides a drainable subsystem interface.
 *
 * @param name - Human-readable name for logging
 * @returns Object containing middleware and subsystem interface
 *
 * @example
 * ```typescript
 * const tracker = createInFlightDrainTracker('api-gateway');
 * app.use(tracker.middleware);
 *
 * const shutdown = createGracefulShutdownHandler({
 *   subsystems: [tracker.subsystem],
 *   // ...
 * });
 * ```
 */
export function createInFlightDrainTracker(name: string): {
  middleware: RequestHandler;
  subsystem: DrainableSubsystem;
} {
  let activeRequestCount = 0;
  let acceptingRequests = true;
  const idleWaiters = new Set<() => void>();

  const notifyIfIdle = () => {
    if (activeRequestCount === 0) {
      for (const resolve of idleWaiters) {
        resolve();
      }
      idleWaiters.clear();
    }
  };

  const middleware: RequestHandler = (_req, res, next) => {
    activeRequestCount += 1;
    let requestSettled = false;

    const markComplete = () => {
      if (requestSettled) {
        return;
      }

      requestSettled = true;
      activeRequestCount = Math.max(0, activeRequestCount - 1);
      
      logger.info(
        `[drain-tracker:${name}] Request completed (active: ${activeRequestCount})`
      );
      
      notifyIfIdle();
    };

    // Signal clients to close connection after response (no keep-alive)
    if (!acceptingRequests) {
      res.setHeader('Connection', 'close');
      logger.info(`[drain-tracker:${name}] Draining mode: setting Connection: close header`);
    }

    // Track request completion via both finish and close events
    res.once('finish', markComplete);
    res.once('close', markComplete);

    next();
  };

  return {
    middleware,
    subsystem: {
      name,
      beginShutdown() {
        acceptingRequests = false;
        logger.info(
          `[drain-tracker:${name}] Shutdown initiated (active requests: ${activeRequestCount})`
        );
      },
      awaitIdle() {
        if (activeRequestCount === 0) {
          logger.info(`[drain-tracker:${name}] Already idle, no requests to drain`);
          return Promise.resolve();
        }

        logger.info(
          `[drain-tracker:${name}] Waiting for ${activeRequestCount} in-flight request(s) to complete`
        );

        return new Promise<void>((resolve) => {
          idleWaiters.add(resolve);
        });
      },
    },
  };
}
