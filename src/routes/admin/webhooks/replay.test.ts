/**
 * Tests for POST /api/admin/webhooks/replay
 *
 * Coverage:
 *   - Successful replay from DLQ
 *   - Authorization (API key + JWT)
 *   - Missing deliveryId validation
 *   - Non-existent deliveryId
 *   - Admin audit logging
 *   - Standardized error envelope
 *   - Secrets never exposed in response
 *   - Dispatch is triggered (fire-and-forget)
 */

jest.mock('better-sqlite3', () => {
    return class MockDatabase {
        prepare() { return { get: () => null }; }
        exec() { }
        close() { }
    };
});

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { errorHandler } from '../../../middleware/errorHandler.js';
import { WebhookStore } from '../../../webhooks/webhook.store.js';
import { dispatchWebhook } from '../../../webhooks/webhook.dispatcher.js';
import { createAdminWebhookReplayRouter } from './replay.js';
import type { DeadLetterEntry } from '../../../webhooks/webhook.types.js';

jest.mock('../../../logger', () => {
    const actual = jest.requireActual('../../../logger');
    return {
        ...actual,
        logger: {
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            audit: jest.fn(),
        },
    };
});

jest.mock('../../../webhooks/webhook.dispatcher.js', () => ({
    dispatchWebhook: jest.fn(async () => undefined),
}));

import { logger } from '../../../logger.js';

const mockedDispatchWebhook = jest.mocked(dispatchWebhook);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ADMIN_KEY = 'test-replay-admin-key';
const JWT_SECRET = 'test-replay-jwt-secret';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDlqEntry(overrides: Partial<DeadLetterEntry> = {}): DeadLetterEntry {
    return {
        deliveryId: 'dlq-replay-001',
        config: {
            developerId: 'dev-replay-1',
            url: 'https://hooks.example.com/receive',
            events: ['new_api_call'],
            createdAt: new Date('2026-06-01T00:00:00.000Z'),
        },
        payload: {
            event: 'new_api_call',
            timestamp: '2026-06-01T12:00:00.000Z',
            developerId: 'dev-replay-1',
            data: { apiId: 'api_123', creditsUsed: 5 },
        },
        failedAt: '2026-06-01T12:00:05.000Z',
        lastError: 'HTTP 503 Service Unavailable',
        attempts: 5,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

function buildApp() {
    const app = express();
    app.use(express.json());

    // Simulate the two adminAuth paths used by the real middleware
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

    app.use('/api/admin/webhooks/replay', createAdminWebhookReplayRouter());
    app.use(errorHandler);
    return app;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let app: ReturnType<typeof buildApp>;

beforeEach(() => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    process.env.JWT_SECRET = JWT_SECRET;
    WebhookStore.clear();
    WebhookStore.clearDlq();
    WebhookStore.clearFailedDeliveries();
    jest.clearAllMocks();
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

describe('POST /api/admin/webhooks/replay — authorization', () => {
    it('returns 200 with a valid admin API key', async () => {
        WebhookStore.addToDlq(makeDlqEntry({ deliveryId: 'dlq-auth-1' }));

        const res = await request(app)
            .post('/api/admin/webhooks/replay')
            .send({ deliveryId: 'dlq-auth-1' })
            .set('x-admin-api-key', ADMIN_KEY);

        expect(res.status).toBe(200);
    });

    it('returns 200 with a valid admin JWT', async () => {
        WebhookStore.addToDlq(makeDlqEntry({ deliveryId: 'dlq-auth-2' }));
        const token = jwt.sign({ role: 'admin', sub: 'admin-user' }, JWT_SECRET, { expiresIn: '1h' });

        const res = await request(app)
            .post('/api/admin/webhooks/replay')
            .send({ deliveryId: 'dlq-auth-2' })
            .set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(200);
    });

    it('returns 401 with no credentials', async () => {
        const res = await request(app)
            .post('/api/admin/webhooks/replay')
            .send({ deliveryId: 'dlq-auth-3' });

        expect(res.status).toBe(401);
        expect(res.body.code).toBe('UNAUTHORIZED');
    });

    it('returns 401 with a wrong API key', async () => {
        const res = await request(app)
            .post('/api/admin/webhooks/replay')
            .send({ deliveryId: 'dlq-auth-4' })
            .set('x-admin-api-key', 'definitely-wrong');

        expect(res.status).toBe(401);
    });

    it('returns 401 with a non-admin JWT role', async () => {
        const token = jwt.sign({ role: 'developer', sub: 'user-1' }, JWT_SECRET, { expiresIn: '1h' });

        const res = await request(app)
            .post('/api/admin/webhooks/replay')
            .send({ deliveryId: 'dlq-auth-5' })
            .set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(401);
    });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('POST /api/admin/webhooks/replay — input validation', () => {
    it('returns 400 when request body is missing entirely', async () => {
        const res = await request(app)
            .post('/api/admin/webhooks/replay')
            .set('x-admin-api-key', ADMIN_KEY);

        expect(res.status).toBe(400);
        // express.json() sets req.body to {} even without a body,
        // so the deliveryId check catches it with INVALID_DELIVERY_ID.
        expect(res.body.error.code).toBe('INVALID_DELIVERY_ID');
    });

    it('returns 400 when deliveryId is missing', async () => {
        const res = await request(app)
            .post('/api/admin/webhooks/replay')
            .send({})
            .set('x-admin-api-key', ADMIN_KEY);

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('INVALID_DELIVERY_ID');
        expect(res.body.error.message).toContain('deliveryId');
    });

    it('returns 400 when deliveryId is not a string', async () => {
        const res = await request(app)
            .post('/api/admin/webhooks/replay')
            .send({ deliveryId: 12345 })
            .set('x-admin-api-key', ADMIN_KEY);

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('INVALID_DELIVERY_ID');
    });

    it('returns 400 when deliveryId is an empty string', async () => {
        const res = await request(app)
            .post('/api/admin/webhooks/replay')
            .send({ deliveryId: '' })
            .set('x-admin-api-key', ADMIN_KEY);

        expect(res.status).toBe(400);
    });

    it('returns 400 when deliveryId is only whitespace', async () => {
        const res = await request(app)
            .post('/api/admin/webhooks/replay')
            .send({ deliveryId: '   ' })
            .set('x-admin-api-key', ADMIN_KEY);

        expect(res.status).toBe(400);
    });
});

// ---------------------------------------------------------------------------
// Not found
// ---------------------------------------------------------------------------

describe('POST /api/admin/webhooks/replay — DLQ entry not found', () => {
    it('returns 404 when no DLQ entry exists for the given deliveryId', async () => {
        const res = await request(app)
            .post('/api/admin/webhooks/replay')
            .send({ deliveryId: 'nonexistent-delivery' })
            .set('x-admin-api-key', ADMIN_KEY);

        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('DLQ_ENTRY_NOT_FOUND');
        expect(res.body.error.message).toContain('nonexistent-delivery');
    });

    it('returns 404 when the DLQ is empty', async () => {
        const res = await request(app)
            .post('/api/admin/webhooks/replay')
            .send({ deliveryId: 'any-delivery' })
            .set('x-admin-api-key', ADMIN_KEY);

        expect(res.status).toBe(404);
    });
});

// ---------------------------------------------------------------------------
// Successful replay
// ---------------------------------------------------------------------------

describe('POST /api/admin/webhooks/replay — successful replay', () => {
    it('returns a 200 with replay metadata', async () => {
        const entry = makeDlqEntry({
            deliveryId: 'dlq-success-1',
            config: {
                developerId: 'dev-success',
                url: 'https://hooks.example.com/success',
                events: ['settlement_completed'],
                createdAt: new Date('2026-06-01T00:00:00.000Z'),
            },
            payload: {
                event: 'settlement_completed',
                timestamp: '2026-06-01T12:00:00.000Z',
                developerId: 'dev-success',
                data: { settlementId: 'stl_001', amount: '100.00' },
            },
        });
        WebhookStore.addToDlq(entry);

        const res = await request(app)
            .post('/api/admin/webhooks/replay')
            .send({ deliveryId: 'dlq-success-1' })
            .set('x-admin-api-key', ADMIN_KEY);

        expect(res.status).toBe(200);

        const { data } = res.body;
        expect(data.deliveryId).toBe('dlq-success-1');
        expect(data.status).toBe('replayed');
        expect(data.targetUrl).toBe('https://hooks.example.com/success');
        expect(data.event).toBe('settlement_completed');
        expect(data.developerId).toBe('dev-success');
        expect(data.replayedAt).toBeDefined();
        expect(data.replayedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('triggers dispatchWebhook with the stored config and payload', async () => {
        const entry = makeDlqEntry({ deliveryId: 'dlq-trigger-1' });
        WebhookStore.addToDlq(entry);

        await request(app)
            .post('/api/admin/webhooks/replay')
            .send({ deliveryId: 'dlq-trigger-1' })
            .set('x-admin-api-key', ADMIN_KEY);

        expect(mockedDispatchWebhook).toHaveBeenCalledTimes(1);
        expect(mockedDispatchWebhook).toHaveBeenCalledWith(
            entry.config,
            entry.payload,
        );
    });

    it('replays successfully even with secret_current on the config', async () => {
        const entry = makeDlqEntry({
            deliveryId: 'dlq-secret-1',
            config: {
                developerId: 'dev-secret',
                url: 'https://hooks.example.com/secret',
                events: ['new_api_call'],
                secret_current: 'whsec_test_secret_value',
                createdAt: new Date('2026-06-01T00:00:00.000Z'),
            },
        });
        WebhookStore.addToDlq(entry);

        const res = await request(app)
            .post('/api/admin/webhooks/replay')
            .send({ deliveryId: 'dlq-secret-1' })
            .set('x-admin-api-key', ADMIN_KEY);

        expect(res.status).toBe(200);

        // Secret must not appear in the response body
        expect(JSON.stringify(res.body)).not.toContain('whsec_test_secret_value');
    });

    it('logs an audit event on successful replay', async () => {
        WebhookStore.addToDlq(makeDlqEntry({ deliveryId: 'dlq-audit-1' }));

        await request(app)
            .post('/api/admin/webhooks/replay')
            .send({ deliveryId: 'dlq-audit-1' })
            .set('x-admin-api-key', ADMIN_KEY);

        expect(logger.audit).toHaveBeenCalledWith(
            'WEBHOOK_REPLAYED',
            'admin-api-key',
            expect.objectContaining({
                deliveryId: 'dlq-audit-1',
                developerId: 'dev-replay-1',
                event: 'new_api_call',
                targetUrl: 'https://hooks.example.com/receive',
            }),
        );
    });

    it('handles dispatch rejection gracefully (fire-and-forget)', async () => {
        mockedDispatchWebhook.mockRejectedValueOnce(new Error('network error'));

        WebhookStore.addToDlq(makeDlqEntry({ deliveryId: 'dlq-error-1' }));

        const res = await request(app)
            .post('/api/admin/webhooks/replay')
            .send({ deliveryId: 'dlq-error-1' })
            .set('x-admin-api-key', ADMIN_KEY);

        // Even if the dispatch fails asynchronously, the endpoint returns 200
        expect(res.status).toBe(200);
    });
});

// ---------------------------------------------------------------------------
// Response shape (standardized envelope)
// ---------------------------------------------------------------------------

describe('POST /api/admin/webhooks/replay — response shape', () => {
    it('wraps the result in a { data } envelope on success', async () => {
        WebhookStore.addToDlq(makeDlqEntry({ deliveryId: 'dlq-env-1' }));

        const res = await request(app)
            .post('/api/admin/webhooks/replay')
            .send({ deliveryId: 'dlq-env-1' })
            .set('x-admin-api-key', ADMIN_KEY);

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('data');
        expect(res.body.data).toHaveProperty('deliveryId');
        expect(res.body.data).toHaveProperty('status', 'replayed');
    });

    it('returns a standardized error envelope on 400', async () => {
        const res = await request(app)
            .post('/api/admin/webhooks/replay')
            .send({})
            .set('x-admin-api-key', ADMIN_KEY);

        expect(res.status).toBe(400);
        expect(res.body.error).toHaveProperty('code');
        expect(res.body.error).toHaveProperty('message');
    });

    it('returns a standardized error envelope on 404', async () => {
        const res = await request(app)
            .post('/api/admin/webhooks/replay')
            .send({ deliveryId: 'does-not-exist' })
            .set('x-admin-api-key', ADMIN_KEY);

        expect(res.status).toBe(404);
        expect(res.body.error).toHaveProperty('code', 'DLQ_ENTRY_NOT_FOUND');
        expect(res.body.error).toHaveProperty('message');
    });

    it('returns a standardized error envelope on internal error', async () => {
        // Force WebhookStore.getFromDlq to throw
        jest.spyOn(WebhookStore, 'getFromDlq').mockImplementationOnce(() => {
            throw new Error('unexpected error');
        });

        const res = await request(app)
            .post('/api/admin/webhooks/replay')
            .send({ deliveryId: 'dlq-crash-1' })
            .set('x-admin-api-key', ADMIN_KEY);

        expect(res.status).toBe(500);
        expect(res.body.error).toHaveProperty('code');
        expect(res.body.error).toHaveProperty('message');
    });
});
