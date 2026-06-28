/**
 * Tests for GET /api/admin/webhooks/monitor
 *
 * Coverage:
 *   - Successful admin access (API key + JWT)
 *   - Unauthorized access (no credentials, wrong credentials)
 *   - Last-100 failure limit is enforced
 *   - Accurate DLQ depth is returned
 *   - Per-subscription statistics are correct
 *   - Empty dataset (no failures, no subscriptions, DLQ depth 0)
 *   - Standardized error response shape
 *   - Secrets are never exposed in the response
 */

jest.mock('better-sqlite3', () => {
    return class MockDatabase {
        prepare() { return { get: () => null }; }
        exec() {}
        close() {}
    };
});

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { errorHandler } from '../../middleware/errorHandler.js';
import { WebhookStore } from '../../webhooks/webhook.store.js';
import { createAdminWebhooksRouter } from './webhooks.js';
import type { FailedDeliveryEntry } from '../../webhooks/webhook.store.js';
import type { DeadLetterEntry } from '../../webhooks/webhook.types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ADMIN_KEY = 'test-monitor-admin-key';
const JWT_SECRET = 'test-monitor-jwt-secret';

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

function buildApp() {
    const app = express();
    app.use(express.json());

    // Simulate the two adminAuth paths used by the real middleware:
    //   1. x-admin-api-key header
    //   2. Bearer JWT with role=admin
    // Unauthorised requests fall through to a 401 without setting adminActor.
    app.use((req, res, next) => {
        const apiKey = req.headers['x-admin-api-key'];
        if (apiKey === ADMIN_KEY) {
            res.locals.adminActor = 'admin-api-key';
            return next();
        }

        const auth = req.headers['authorization'];
        if (auth?.startsWith('Bearer ')) {
            try {
                const payload = jwt.verify(auth.slice(7), JWT_SECRET) as { role?: string };
                if (payload.role === 'admin') {
                    res.locals.adminActor = 'admin-jwt';
                    return next();
                }
            } catch {
                // fall through
            }
        }

        res.status(401).json({
            code: 'UNAUTHORIZED',
            message: 'Unauthorized: admin access required',
            requestId: 'test',
        });
    });

    app.use('/api/admin/webhooks', createAdminWebhooksRouter());
    app.use(errorHandler);
    return app;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFailure(overrides: Partial<FailedDeliveryEntry> = {}): FailedDeliveryEntry {
    return {
        deliveryId: `d-${Math.random().toString(36).slice(2)}`,
        developerId: 'dev-1',
        event: 'new_api_call',
        url: 'https://example.com/hook',
        failedAt: new Date().toISOString(),
        lastError: 'HTTP 503 Service Unavailable',
        attempts: 5,
        ...overrides,
    };
}

function makeDlqEntry(overrides: Partial<DeadLetterEntry> = {}): DeadLetterEntry {
    return {
        deliveryId: `dlq-${Math.random().toString(36).slice(2)}`,
        config: {
            developerId: 'dev-1',
            url: 'https://example.com/hook',
            events: ['new_api_call'],
            createdAt: new Date(),
        },
        payload: {
            event: 'new_api_call',
            timestamp: new Date().toISOString(),
            developerId: 'dev-1',
            data: {},
        },
        failedAt: new Date().toISOString(),
        lastError: 'timeout',
        attempts: 5,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Test setup / teardown
// ---------------------------------------------------------------------------

let app: ReturnType<typeof buildApp>;

beforeEach(() => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    process.env.JWT_SECRET = JWT_SECRET;
    WebhookStore.clear();
    WebhookStore.clearDlq();
    WebhookStore.clearFailedDeliveries();
    app = buildApp();
});

afterEach(() => {
    delete process.env.ADMIN_API_KEY;
    delete process.env.JWT_SECRET;
    jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

describe('GET /api/admin/webhooks/monitor — authorization', () => {
    it('returns 200 with a valid admin API key', async () => {
        const res = await request(app)
            .get('/api/admin/webhooks/monitor')
            .set('x-admin-api-key', ADMIN_KEY);

        expect(res.status).toBe(200);
        expect(res.body.data).toBeDefined();
    });

    it('returns 200 with a valid admin JWT', async () => {
        const token = jwt.sign({ role: 'admin', sub: 'admin-user' }, JWT_SECRET, { expiresIn: '1h' });

        const res = await request(app)
            .get('/api/admin/webhooks/monitor')
            .set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(200);
        expect(res.body.data).toBeDefined();
    });

    it('returns 401 with no credentials', async () => {
        const res = await request(app).get('/api/admin/webhooks/monitor');

        expect(res.status).toBe(401);
        expect(res.body.code).toBe('UNAUTHORIZED');
    });

    it('returns 401 with a wrong API key', async () => {
        const res = await request(app)
            .get('/api/admin/webhooks/monitor')
            .set('x-admin-api-key', 'definitely-wrong');

        expect(res.status).toBe(401);
    });

    it('returns 401 with a non-admin JWT role', async () => {
        const token = jwt.sign({ role: 'developer', sub: 'user-1' }, JWT_SECRET, { expiresIn: '1h' });

        const res = await request(app)
            .get('/api/admin/webhooks/monitor')
            .set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(401);
    });
});

// ---------------------------------------------------------------------------
// Empty dataset
// ---------------------------------------------------------------------------

describe('GET /api/admin/webhooks/monitor — empty dataset', () => {
    it('returns well-formed empty snapshot when nothing is registered', async () => {
        const res = await request(app)
            .get('/api/admin/webhooks/monitor')
            .set('x-admin-api-key', ADMIN_KEY);

        expect(res.status).toBe(200);
        const { data } = res.body;

        expect(data.failedDeliveries).toEqual([]);
        expect(data.dlqDepth).toBe(0);
        expect(data.subscriptions).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Failed deliveries
// ---------------------------------------------------------------------------

describe('GET /api/admin/webhooks/monitor — failed deliveries', () => {
    it('returns recorded failures, most-recent first', async () => {
        const older = makeFailure({ developerId: 'dev-1', failedAt: '2026-06-01T10:00:00.000Z' });
        const newer = makeFailure({ developerId: 'dev-2', failedAt: '2026-06-01T11:00:00.000Z' });
        WebhookStore.recordFailedDelivery(older);
        WebhookStore.recordFailedDelivery(newer);

        const res = await request(app)
            .get('/api/admin/webhooks/monitor')
            .set('x-admin-api-key', ADMIN_KEY);

        expect(res.status).toBe(200);
        const { failedDeliveries } = res.body.data;

        // Newest first
        expect(failedDeliveries[0].developerId).toBe('dev-2');
        expect(failedDeliveries[1].developerId).toBe('dev-1');
    });

    it('caps the returned list at 100 even when more failures exist', async () => {
        // Record 150 failures
        for (let i = 0; i < 150; i++) {
            WebhookStore.recordFailedDelivery(makeFailure({ developerId: `dev-${i}` }));
        }

        const res = await request(app)
            .get('/api/admin/webhooks/monitor')
            .set('x-admin-api-key', ADMIN_KEY);

        expect(res.status).toBe(200);
        expect(res.body.data.failedDeliveries.length).toBeLessThanOrEqual(100);
    });

    it('includes the expected operational fields on each failure entry', async () => {
        const failure = makeFailure({
            deliveryId: 'uuid-001',
            developerId: 'dev-abc',
            event: 'settlement_completed',
            url: 'https://hooks.example.com/recv',
            failedAt: '2026-06-28T00:00:00.000Z',
            lastError: 'HTTP 500 Internal Server Error',
            attempts: 5,
        });
        WebhookStore.recordFailedDelivery(failure);

        const res = await request(app)
            .get('/api/admin/webhooks/monitor')
            .set('x-admin-api-key', ADMIN_KEY);

        const entry = res.body.data.failedDeliveries[0];
        expect(entry.deliveryId).toBe('uuid-001');
        expect(entry.developerId).toBe('dev-abc');
        expect(entry.event).toBe('settlement_completed');
        expect(entry.url).toBe('https://hooks.example.com/recv');
        expect(entry.failedAt).toBe('2026-06-28T00:00:00.000Z');
        expect(entry.lastError).toBe('HTTP 500 Internal Server Error');
        expect(entry.attempts).toBe(5);
    });

    it('does not expose raw payload data in failure entries', async () => {
        WebhookStore.recordFailedDelivery(makeFailure());

        const res = await request(app)
            .get('/api/admin/webhooks/monitor')
            .set('x-admin-api-key', ADMIN_KEY);

        const entry = res.body.data.failedDeliveries[0];
        // FailedDeliveryEntry must not contain a 'payload' or 'config' field
        expect(entry).not.toHaveProperty('payload');
        expect(entry).not.toHaveProperty('config');
        expect(entry).not.toHaveProperty('secret');
    });
});

// ---------------------------------------------------------------------------
// DLQ depth
// ---------------------------------------------------------------------------

describe('GET /api/admin/webhooks/monitor — DLQ depth', () => {
    it('reports dlqDepth 0 when the DLQ is empty', async () => {
        const res = await request(app)
            .get('/api/admin/webhooks/monitor')
            .set('x-admin-api-key', ADMIN_KEY);

        expect(res.body.data.dlqDepth).toBe(0);
    });

    it('reflects the accurate DLQ depth at request time', async () => {
        WebhookStore.addToDlq(makeDlqEntry({ deliveryId: 'dlq-1' }));
        WebhookStore.addToDlq(makeDlqEntry({ deliveryId: 'dlq-2' }));
        WebhookStore.addToDlq(makeDlqEntry({ deliveryId: 'dlq-3' }));

        const res = await request(app)
            .get('/api/admin/webhooks/monitor')
            .set('x-admin-api-key', ADMIN_KEY);

        expect(res.body.data.dlqDepth).toBe(3);
    });

    it('updates immediately after DLQ changes without background recomputation', async () => {
        WebhookStore.addToDlq(makeDlqEntry({ deliveryId: 'live-1' }));

        const first = await request(app)
            .get('/api/admin/webhooks/monitor')
            .set('x-admin-api-key', ADMIN_KEY);

        expect(first.body.data.dlqDepth).toBe(1);

        WebhookStore.addToDlq(makeDlqEntry({ deliveryId: 'live-2' }));

        const second = await request(app)
            .get('/api/admin/webhooks/monitor')
            .set('x-admin-api-key', ADMIN_KEY);

        expect(second.body.data.dlqDepth).toBe(2);
    });
});

// ---------------------------------------------------------------------------
// Per-subscription statistics
// ---------------------------------------------------------------------------

describe('GET /api/admin/webhooks/monitor — subscriptions', () => {
    it('returns an empty subscriptions array when no webhooks are registered', async () => {
        const res = await request(app)
            .get('/api/admin/webhooks/monitor')
            .set('x-admin-api-key', ADMIN_KEY);

        expect(res.body.data.subscriptions).toEqual([]);
    });

    it('returns one entry per registered subscription with operational fields', async () => {
        const createdAt = new Date('2026-06-01T00:00:00.000Z');
        WebhookStore.register({
            developerId: 'sub-dev-1',
            url: 'https://recv.example.com/a',
            events: ['new_api_call', 'settlement_completed'],
            createdAt,
        });

        const res = await request(app)
            .get('/api/admin/webhooks/monitor')
            .set('x-admin-api-key', ADMIN_KEY);

        const { subscriptions } = res.body.data;
        expect(subscriptions).toHaveLength(1);

        const sub = subscriptions[0];
        expect(sub.developerId).toBe('sub-dev-1');
        expect(sub.url).toBe('https://recv.example.com/a');
        expect(sub.events).toEqual(['new_api_call', 'settlement_completed']);
        expect(sub.registeredAt).toBe('2026-06-01T00:00:00.000Z');
    });

    it('returns one entry per developer when multiple subscriptions are registered', async () => {
        WebhookStore.register({
            developerId: 'sub-dev-a',
            url: 'https://a.example.com/hook',
            events: ['new_api_call'],
            createdAt: new Date(),
        });
        WebhookStore.register({
            developerId: 'sub-dev-b',
            url: 'https://b.example.com/hook',
            events: ['settlement_completed'],
            createdAt: new Date(),
        });

        const res = await request(app)
            .get('/api/admin/webhooks/monitor')
            .set('x-admin-api-key', ADMIN_KEY);

        const devIds = res.body.data.subscriptions.map((s: { developerId: string }) => s.developerId);
        expect(devIds).toContain('sub-dev-a');
        expect(devIds).toContain('sub-dev-b');
    });

    it('does not expose signing secrets in subscription stats', async () => {
        WebhookStore.register({
            developerId: 'secret-dev',
            url: 'https://example.com/hook',
            events: ['new_api_call'],
            secret_current: 'super-secret-value',
            createdAt: new Date(),
        });

        const res = await request(app)
            .get('/api/admin/webhooks/monitor')
            .set('x-admin-api-key', ADMIN_KEY);

        const sub = res.body.data.subscriptions[0];
        expect(sub).not.toHaveProperty('secret');
        expect(sub).not.toHaveProperty('secret_current');
        expect(sub).not.toHaveProperty('secret_previous');
        // Values should not appear anywhere in the response body
        expect(JSON.stringify(res.body)).not.toContain('super-secret-value');
    });
});

// ---------------------------------------------------------------------------
// Response shape (standardized envelope)
// ---------------------------------------------------------------------------

describe('GET /api/admin/webhooks/monitor — response shape', () => {
    it('wraps the snapshot in a { data } envelope', async () => {
        const res = await request(app)
            .get('/api/admin/webhooks/monitor')
            .set('x-admin-api-key', ADMIN_KEY);

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('data');
        expect(res.body.data).toHaveProperty('failedDeliveries');
        expect(res.body.data).toHaveProperty('dlqDepth');
        expect(res.body.data).toHaveProperty('subscriptions');
    });

    it('returns a standardized error envelope on internal error', async () => {
        // Force an error by making getWebhookMonitorSnapshot throw
        jest.spyOn(
            await import('../../services/webhookMonitor.js'),
            'getWebhookMonitorSnapshot',
        ).mockImplementation(() => { throw new Error('boom'); });

        const res = await request(app)
            .get('/api/admin/webhooks/monitor')
            .set('x-admin-api-key', ADMIN_KEY);

        expect(res.status).toBe(500);
        expect(res.body).toHaveProperty('code');
        expect(res.body).toHaveProperty('message');
        expect(res.body).toHaveProperty('requestId');
    });
});
