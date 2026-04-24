/// <reference types="jest" />
import request from 'supertest';
import type { Server } from 'http';
import app, { createGracefulShutdownHandler } from './index.js';

jest.mock('./db/index.js', () => ({
  db: {},
  initializeDb: jest.fn(),
  schema: {},
}));
describe('Health API', () => {
  it('should return ok status', async () => {
    const response = await request(app).get('/api/health');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });
});

describe('graceful shutdown', () => {
  it('closes server and database resources', async () => {
    const closeServer = jest.fn((callback: (err?: Error) => void) => callback());
    const closeDatabase = jest.fn(async () => Promise.resolve());
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

    const shutdown = createGracefulShutdownHandler({
      server: { close: closeServer } as unknown as Server,
      activeConnections: new Set(),
      closeDatabase,
      logger,
      timeoutMs: 50,
    });

    await expect(shutdown('SIGTERM')).resolves.toBe(0);
    expect(closeServer).toHaveBeenCalledTimes(1);
    expect(closeDatabase).toHaveBeenCalledTimes(1);
  });

  it('reuses in-flight shutdown promise on repeated signals', async () => {
    let closeCallback: ((err?: Error) => void) | undefined;
    const closeServer = jest.fn((callback: (err?: Error) => void) => {
      closeCallback = callback;
    });
    const closeDatabase = jest.fn(async () => Promise.resolve());

    const shutdown = createGracefulShutdownHandler({
      server: { close: closeServer } as unknown as Server,
      activeConnections: new Set(),
      closeDatabase,
      timeoutMs: 50,
    });

    const first = shutdown('SIGTERM');
    const second = shutdown('SIGINT');

    expect(closeServer).toHaveBeenCalledTimes(1);
    closeCallback?.();

    await expect(first).resolves.toBe(0);
    await expect(second).resolves.toBe(0);
    expect(closeDatabase).toHaveBeenCalledTimes(1);
  });
});
