/// <reference types="jest" />
import type { Server } from 'http';
import type { Socket } from 'net';
import {
  createGracefulShutdownHandler,
  createInFlightDrainTracker,
  type DrainableSubsystem,
} from './shutdown.js';

describe('shutdown module', () => {
  describe('createGracefulShutdownHandler', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it('should close server and database resources on clean shutdown', async () => {
      const closeServer = jest.fn((callback: (err?: Error) => void) => callback());
      const closeDatabase = jest.fn(async () => Promise.resolve());
      const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

      const shutdown = createGracefulShutdownHandler({
        server: { close: closeServer } as unknown as Server,
        activeConnections: new Set(),
        closeDatabase,
        logger,
        timeoutMs: 100,
      });

      const exitCode = await shutdown('SIGTERM');

      expect(exitCode).toBe(0);
      expect(closeServer).toHaveBeenCalledTimes(1);
      expect(closeDatabase).toHaveBeenCalledTimes(1);
      expect(logger.log).toHaveBeenCalledWith(
        expect.stringContaining('Received SIGTERM')
      );
      expect(logger.log).toHaveBeenCalledWith(
        expect.stringContaining('Shutdown complete')
      );
    });

    it('should handle SIGINT signal', async () => {
      const closeServer = jest.fn((callback: (err?: Error) => void) => callback());
      const closeDatabase = jest.fn(async () => Promise.resolve());
      const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

      const shutdown = createGracefulShutdownHandler({
        server: { close: closeServer } as unknown as Server,
        activeConnections: new Set(),
        closeDatabase,
        logger,
        timeoutMs: 100,
      });

      const exitCode = await shutdown('SIGINT');

      expect(exitCode).toBe(0);
      expect(logger.log).toHaveBeenCalledWith(
        expect.stringContaining('Received SIGINT')
      );
    });

    it('should stop and drain subsystems before closing database', async () => {
      let closeCallback: ((err?: Error) => void) | undefined;
      let resolveDrain: (() => void) | undefined;
      const closeServer = jest.fn((callback: (err?: Error) => void) => {
        closeCallback = callback;
      });
      const closeDatabase = jest.fn(async () => Promise.resolve());
      const beginShutdown = jest.fn();
      const awaitIdle = jest.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveDrain = resolve;
          })
      );
      const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

      const shutdown = createGracefulShutdownHandler({
        server: { close: closeServer } as unknown as Server,
        activeConnections: new Set(),
        closeDatabase,
        logger,
        timeoutMs: 100,
        subsystems: [{ name: 'test-job', beginShutdown, awaitIdle }],
      });

      const promise = shutdown('SIGTERM');
      await Promise.resolve();

      // Subsystem should be stopped
      expect(beginShutdown).toHaveBeenCalledTimes(1);
      expect(awaitIdle).toHaveBeenCalledTimes(1);
      expect(closeDatabase).not.toHaveBeenCalled();

      // Server closed, but database still waiting for subsystem drain
      closeCallback?.();
      await Promise.resolve();
      expect(closeDatabase).not.toHaveBeenCalled();

      // Complete the drain
      resolveDrain?.();
      const exitCode = await promise;

      expect(exitCode).toBe(0);
      expect(closeDatabase).toHaveBeenCalledTimes(1);
      expect(logger.log).toHaveBeenCalledWith(
        expect.stringContaining('Stopping 1 subsystem')
      );
      expect(logger.log).toHaveBeenCalledWith(
        expect.stringContaining('Draining 1 subsystem')
      );
    });

    it('should destroy lingering connections after timeout', async () => {
      jest.useFakeTimers();

      const destroy = jest.fn();
      const socket = { destroy } as unknown as Socket;
      const closeServer = jest.fn((_callback: (err?: Error) => void) => {
        // Server never closes to simulate hang
      });
      const closeDatabase = jest.fn(async () => Promise.resolve());
      const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

      const shutdown = createGracefulShutdownHandler({
        server: { close: closeServer } as unknown as Server,
        activeConnections: new Set([socket]),
        closeDatabase,
        logger,
        timeoutMs: 50,
      });

      void shutdown('SIGTERM');
      jest.advanceTimersByTime(50);

      expect(destroy).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('forcefully closing 1 connection')
      );
    });

    it('should return exit code 1 when database closing fails', async () => {
      const closeServer = jest.fn((callback: (err?: Error) => void) => callback());
      const closeDatabase = jest.fn(async () => {
        throw new Error('Database connection error');
      });
      const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

      const shutdown = createGracefulShutdownHandler({
        server: { close: closeServer } as unknown as Server,
        activeConnections: new Set(),
        closeDatabase,
        logger,
        timeoutMs: 100,
      });

      const exitCode = await shutdown('SIGTERM');

      expect(exitCode).toBe(1);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Error closing database'),
        expect.any(Error)
      );
    });

    it('should return exit code 1 when server closing fails', async () => {
      const closeServer = jest.fn((callback: (err?: Error) => void) => {
        callback(new Error('Server close error'));
      });
      const closeDatabase = jest.fn(async () => Promise.resolve());
      const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

      const shutdown = createGracefulShutdownHandler({
        server: { close: closeServer } as unknown as Server,
        activeConnections: new Set(),
        closeDatabase,
        logger,
        timeoutMs: 100,
      });

      const exitCode = await shutdown('SIGTERM');

      expect(exitCode).toBe(1);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Error closing HTTP server'),
        expect.any(Error)
      );
    });

    it('should reuse in-flight shutdown promise on repeated signals', async () => {
      let closeCallback: ((err?: Error) => void) | undefined;
      const closeServer = jest.fn((callback: (err?: Error) => void) => {
        closeCallback = callback;
      });
      const closeDatabase = jest.fn(async () => Promise.resolve());
      const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

      const shutdown = createGracefulShutdownHandler({
        server: { close: closeServer } as unknown as Server,
        activeConnections: new Set(),
        closeDatabase,
        logger,
        timeoutMs: 100,
      });

      const first = shutdown('SIGTERM');
      const second = shutdown('SIGINT');

      // Should only close server once
      expect(closeServer).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Shutdown already in progress')
      );

      closeCallback?.();

      const [firstCode, secondCode] = await Promise.all([first, second]);

      expect(firstCode).toBe(0);
      expect(secondCode).toBe(0);
      expect(closeDatabase).toHaveBeenCalledTimes(1);
    });

    it('should handle subsystem beginShutdown failure', async () => {
      const closeServer = jest.fn((callback: (err?: Error) => void) => callback());
      const closeDatabase = jest.fn(async () => Promise.resolve());
      const beginShutdown = jest.fn(async () => {
        throw new Error('Shutdown failed');
      });
      const awaitIdle = jest.fn(async () => Promise.resolve());
      const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

      const shutdown = createGracefulShutdownHandler({
        server: { close: closeServer } as unknown as Server,
        activeConnections: new Set(),
        closeDatabase,
        logger,
        timeoutMs: 100,
        subsystems: [{ name: 'failing-subsystem', beginShutdown, awaitIdle }],
      });

      const exitCode = await shutdown('SIGTERM');

      expect(exitCode).toBe(1);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to stop subsystem'),
        expect.any(Error)
      );
    });

    it('should handle subsystem drain timeout', async () => {
      jest.useFakeTimers();

      const closeServer = jest.fn((callback: (err?: Error) => void) => callback());
      const closeDatabase = jest.fn(async () => Promise.resolve());
      const beginShutdown = jest.fn();
      const awaitIdle = jest.fn(
        () => new Promise<void>(() => {
          // Never resolves
        })
      );
      const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

      const shutdown = createGracefulShutdownHandler({
        server: { close: closeServer } as unknown as Server,
        activeConnections: new Set(),
        closeDatabase,
        logger,
        timeoutMs: 100,
        subsystems: [{ name: 'slow-subsystem', beginShutdown, awaitIdle }],
      });

      const promise = shutdown('SIGTERM');

      // Fast-forward past drain timeout
      jest.advanceTimersByTime(100);
      await Promise.resolve();

      // Should still complete and close database
      const exitCode = await promise;
      expect(exitCode).toBe(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Subsystem drain timeout')
      );
      expect(closeDatabase).toHaveBeenCalledTimes(1);
    });

    it('should log shutdown phases with structured messages', async () => {
      const closeServer = jest.fn((callback: (err?: Error) => void) => callback());
      const closeDatabase = jest.fn(async () => Promise.resolve());
      const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

      const shutdown = createGracefulShutdownHandler({
        server: { close: closeServer } as unknown as Server,
        activeConnections: new Set(),
        closeDatabase,
        logger,
        timeoutMs: 100,
      });

      await shutdown('SIGTERM');

      // Verify structured logging of phases
      expect(logger.log).toHaveBeenCalledWith(
        expect.stringContaining('[shutdown:signal_received]')
      );
      expect(logger.log).toHaveBeenCalledWith(
        expect.stringContaining('[shutdown:server_closing]')
      );
      expect(logger.log).toHaveBeenCalledWith(
        expect.stringContaining('[shutdown:database_closing]')
      );
      expect(logger.log).toHaveBeenCalledWith(
        expect.stringContaining('[shutdown:complete]')
      );
    });

    it('should use 30000ms default timeout when not specified', async () => {
      jest.useFakeTimers();

      const destroy = jest.fn();
      const socket = { destroy } as unknown as Socket;
      const closeServer = jest.fn((_callback: (err?: Error) => void) => {
        // Never closes
      });
      const closeDatabase = jest.fn(async () => Promise.resolve());

      const shutdown = createGracefulShutdownHandler({
        server: { close: closeServer } as unknown as Server,
        activeConnections: new Set([socket]),
        closeDatabase,
      });

      void shutdown('SIGTERM');

      // Should not destroy before 30s
      jest.advanceTimersByTime(29_000);
      expect(destroy).not.toHaveBeenCalled();

      // Should destroy after 30s
      jest.advanceTimersByTime(1_000);
      expect(destroy).toHaveBeenCalledTimes(1);
    });
  });

  describe('createInFlightDrainTracker', () => {
    it('should track in-flight requests and become idle when complete', async () => {
      const tracker = createInFlightDrainTracker('test-gateway');
      const next = jest.fn();
      const listeners = new Map<string, () => void>();
      const res = {
        setHeader: jest.fn(),
        once: jest.fn((event: string, handler: () => void) => {
          listeners.set(event, handler);
          return res;
        }),
      } as any;

      // Start a request
      tracker.middleware({} as any, res, next);
      expect(next).toHaveBeenCalledTimes(1);

      // Begin shutdown
      tracker.subsystem.beginShutdown();
      const idlePromise = tracker.subsystem.awaitIdle();

      let settled = false;
      void idlePromise.then(() => {
        settled = true;
      });
      await Promise.resolve();

      // Should not be idle yet
      expect(settled).toBe(false);

      // Complete the request
      listeners.get('finish')?.();
      await idlePromise;
      expect(settled).toBe(true);
    });

    it('should set Connection: close header when draining', () => {
      const tracker = createInFlightDrainTracker('test-gateway');
      const res = {
        setHeader: jest.fn(),
        once: jest.fn(() => res),
      } as any;

      // Begin shutdown
      tracker.subsystem.beginShutdown();

      // New requests should get Connection: close
      tracker.middleware({} as any, res, jest.fn());
      expect(res.setHeader).toHaveBeenCalledWith('Connection', 'close');
    });

    it('should resolve immediately if no active requests', async () => {
      const tracker = createInFlightDrainTracker('test-gateway');

      tracker.subsystem.beginShutdown();
      await expect(tracker.subsystem.awaitIdle()).resolves.toBeUndefined();
    });

    it('should handle multiple concurrent requests', async () => {
      const tracker = createInFlightDrainTracker('test-gateway');
      const listeners1 = new Map<string, () => void>();
      const listeners2 = new Map<string, () => void>();

      const res1 = {
        setHeader: jest.fn(),
        once: jest.fn((event: string, handler: () => void) => {
          listeners1.set(event, handler);
          return res1;
        }),
      } as any;

      const res2 = {
        setHeader: jest.fn(),
        once: jest.fn((event: string, handler: () => void) => {
          listeners2.set(event, handler);
          return res2;
        }),
      } as any;

      // Start two requests
      tracker.middleware({} as any, res1, jest.fn());
      tracker.middleware({} as any, res2, jest.fn());

      tracker.subsystem.beginShutdown();
      const idlePromise = tracker.subsystem.awaitIdle();

      let settled = false;
      void idlePromise.then(() => {
        settled = true;
      });

      // Complete first request
      listeners1.get('finish')?.();
      await Promise.resolve();
      expect(settled).toBe(false);

      // Complete second request
      listeners2.get('finish')?.();
      await idlePromise;
      expect(settled).toBe(true);
    });

    it('should handle request completion via close event', async () => {
      const tracker = createInFlightDrainTracker('test-gateway');
      const listeners = new Map<string, () => void>();
      const res = {
        setHeader: jest.fn(),
        once: jest.fn((event: string, handler: () => void) => {
          listeners.set(event, handler);
          return res;
        }),
      } as any;

      tracker.middleware({} as any, res, jest.fn());
      tracker.subsystem.beginShutdown();

      // Complete via close instead of finish
      listeners.get('close')?.();
      await expect(tracker.subsystem.awaitIdle()).resolves.toBeUndefined();
    });

    it('should not double-decrement on both finish and close', async () => {
      const tracker = createInFlightDrainTracker('test-gateway');
      const listeners = new Map<string, () => void>();
      const res = {
        setHeader: jest.fn(),
        once: jest.fn((event: string, handler: () => void) => {
          listeners.set(event, handler);
          return res;
        }),
      } as any;

      tracker.middleware({} as any, res, jest.fn());
      tracker.subsystem.beginShutdown();

      // Fire both events
      listeners.get('finish')?.();
      listeners.get('close')?.();

      // Should still become idle (not stuck waiting for negative count)
      await expect(tracker.subsystem.awaitIdle()).resolves.toBeUndefined();
    });

    it('should provide descriptive subsystem name', () => {
      const tracker = createInFlightDrainTracker('my-custom-tracker');
      expect(tracker.subsystem.name).toBe('my-custom-tracker');
    });
  });
});
