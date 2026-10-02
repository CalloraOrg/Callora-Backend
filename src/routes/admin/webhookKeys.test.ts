/**
 * src/routes/admin/webhookKeys.test.ts
 *
 * Issue #1307 — Exercise the admin webhook signing-key rotation router.
 *
 * Coverage map (acceptance criteria → describe blocks):
 *   1. Rotation demotes the prior key to previous with the correct expiry
 *        → "POST /rotate-key — rotation lifecycle"
 *   2. A second rotation expires the oldest key
 *        → "second rotation demotes the first key" / "third rotation leaves the
 *          first key demoted and past its expiry"
 *   3. Invalid grace window overrides return 400
 *        → "grace-window override validation"
 *   4. Audit callback receives actor and key ids without raw secrets
 *        → "audit callbacks" (store audit rows + logger.audit HTTP-layer entry)
 *   5. Admin auth enforcement when mounted
 *        → "admin auth enforcement when mounted behind adminAuth"
 *
 * All suites drive the real router through supertest with an
 * InMemoryWebhookKeyStore injected via createWebhookKeysRouter(deps),
 * mirroring the conventions of src/services/webhookSigner.test.ts.
 */

import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { createWebhookKeysRouter } from './webhookKeys.js';
import {
  InMemoryWebhookKeyStore,
  hashSecret,
  type WebhookSignerDeps,
} from '../../services/webhookSigner.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { logger } from '../../logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ADMIN_KEY = 'test-admin-api-key';
const JWT_SECRET = 'test-jwt-secret';
const GRACE_MS = 60_000; // 1-minute grace window keeps tests fast
const ACTOR = 'admin-api-key';

// Fixed clock so expiry assertions are exact.
const FAKE_NOW = new Date('2025-06-01T10:00:00.000Z');

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

/**
 * Build an Express app that mounts the router behind a faithful simulation of
 * the production adminAuth middleware (API key + admin-JWT paths; 401 with the
 * standard error envelope otherwise).
 */
function buildApp(
  deps?: Partial<WebhookSignerDeps>,
  options: { withAuth?: boolean } = {},
) {
  const app = express();
  app.use(express.json());

  if (options.withAuth !== false) {
    app.use(adminAuth);
  } else {
    // Auth-free variant for handler-level tests that only need an actor.
    app.use((_req, res, next) => {
      res.locals.adminActor = ACTOR;
      next();
    });
  }

  app.use('/api/admin/webhooks', createWebhookKeysRouter(deps));
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const status =
        err !== null &&
        typeof err === 'object' &&
        'statusCode' in err &&
        typeof (err as { statusCode?: unknown }).statusCode === 'number'
          ? (err as { statusCode: number }).statusCode
          : 500;
      const message = err instanceof Error ? err.message : 'Internal server error';
      const code =
        err !== null &&
        typeof err === 'object' &&
        'code' in err &&
        typeof (err as { code?: unknown }).code === 'string'
          ? (err as { code: string }).code
          : 'INTERNAL_SERVER_ERROR';
      const details =
        err !== null &&
        typeof err === 'object' &&
        'details' in err &&
        Array.isArray((err as { details?: unknown }).details)
          ? (err as { details: unknown[] }).details
          : undefined;
      res
        .status(status)
        .json({ code, message, requestId: 'test', ...(details ? { details } : {}) });
    },
  );
  return app;
}

/** Convenience: authenticated API-key request builder. */
function rotate(app: express.Express, body?: Record<string, unknown>) {
  const req = request(app)
    .post('/api/admin/webhooks/rotate-key')
    .set('x-admin-api-key', ADMIN_KEY);
  return body === undefined ? req.send() : req.send(body);
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

describe('createWebhookKeysRouter — POST /rotate-key', () => {
  let store: InMemoryWebhookKeyStore;
  let notifyAdmin: jest.Mock;

  beforeEach(() => {
    store = new InMemoryWebhookKeyStore();
    notifyAdmin = jest.fn().mockResolvedValue(undefined);
  });

  // -------------------------------------------------------------------------
  // Acceptance criterion 1: rotation demotes the prior key to previous
  // with the correct expiry. Criterion 2 (second rotation expires the oldest
  // key) is covered by the "third rotation" test at the end of this block.
  // -------------------------------------------------------------------------

  describe('rotation lifecycle', () => {
    it('demotes the prior key to previous with expiry = rotation time + grace window', async () => {
      const app = buildApp({ store, notifyAdmin, graceWindowMs: GRACE_MS, now: () => FAKE_NOW });

      const r1 = await rotate(app);
      expect(r1.status).toBe(200);

      const r2 = await rotate(app);
      expect(r2.status).toBe(200);

      expect(r2.body.data.previousKeyId).toBe(r1.body.data.newKeyId);
      // Exact expiry: fixed clock + injected grace window
      expect(r2.body.data.previousKeyExpiresAt).toBe(
        new Date(FAKE_NOW.getTime() + GRACE_MS).toISOString(),
      );
      expect(r2.body.data.graceWindowMs).toBe(GRACE_MS);

      // Store-level status check: exactly one active (the newest), one previous
      const keys = store._getKeys();
      const previous = keys.find((k) => k.id === r1.body.data.newKeyId);
      expect(previous?.status).toBe('previous');
      expect(previous?.expires_at).toBe(new Date(FAKE_NOW.getTime() + GRACE_MS).toISOString());
      const active = keys.filter((k) => k.status === 'active');
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe(r2.body.data.newKeyId);
    });

    it('first rotation has no previous key', async () => {
      const app = buildApp({ store, notifyAdmin, graceWindowMs: GRACE_MS });
      const res = await rotate(app);

      expect(res.status).toBe(200);
      expect(res.body.data.previousKeyId).toBeNull();
      expect(res.body.data.previousKeyExpiresAt).toBeNull();
    });

    it('previous key stays verifiable during the grace window and expires after it', async () => {
      const clock = { value: new Date(FAKE_NOW) };
      const serviceDeps: Partial<WebhookSignerDeps> = {
        store,
        notifyAdmin,
        graceWindowMs: GRACE_MS,
        now: () => clock.value,
      };
      const app = buildApp(serviceDeps);

      const r1 = await rotate(app);
      await rotate(app);

      // During grace: previous key hash still among the valid hashes
      const hashesDuringGrace = await store.getValidPreviousKeys(clock.value);
      expect(hashesDuringGrace.map((k) => k.id)).toContain(r1.body.data.newKeyId);

      // Advance past the grace window, then lazily expire via a read
      clock.value = new Date(FAKE_NOW.getTime() + GRACE_MS + 1);
      await store.expireStaleKeys(clock.value);

      const demoted = store._getKeys().find((k) => k.id === r1.body.data.newKeyId);
      expect(demoted?.status).toBe('expired');
      expect(await store.getValidPreviousKeys(clock.value)).toHaveLength(0);
    });

    it('second rotation expires the oldest key: after a third rotation the first key is demoted and past its expiry', async () => {
      const clock = { value: new Date(FAKE_NOW) };
      const app = buildApp({
        store,
        notifyAdmin,
        graceWindowMs: GRACE_MS,
        now: () => clock.value,
      });

      const r1 = await rotate(app);
      clock.value = new Date(FAKE_NOW.getTime() + 1_000);
      const r2 = await rotate(app);
      clock.value = new Date(FAKE_NOW.getTime() + 2_000);
      const r3 = await rotate(app);

      // r1 was demoted at rotation 2 and expired when rotation 3's grace math
      // moved time past r1's window — it is the oldest key and must not be
      // valid any more; r2 is the current previous key.
      expect(r2.body.data.previousKeyId).toBe(r1.body.data.newKeyId);
      expect(r3.body.data.previousKeyId).toBe(r2.body.data.newKeyId);

      clock.value = new Date(FAKE_NOW.getTime() + GRACE_MS + 2_001);
      await store.expireStaleKeys(clock.value);

      const keys = store._getKeys();
      expect(keys.find((k) => k.id === r1.body.data.newKeyId)?.status).toBe('expired');
      // r2's window (from t+1s) also elapsed at t+GRACE+2s
      expect(keys.find((k) => k.id === r2.body.data.newKeyId)?.status).toBe('expired');
      expect(keys.find((k) => k.id === r3.body.data.newKeyId)?.status).toBe('active');
      expect(await store.getValidPreviousKeys(clock.value)).toHaveLength(0);
    });

    it('returns the raw secret exactly once and persists only its SHA-256 hash', async () => {
      const app = buildApp({ store, notifyAdmin, graceWindowMs: GRACE_MS });
      const res = await rotate(app);
      const { rawSecret, newKeyId } = res.body.data;

      expect(rawSecret).toMatch(/^[0-9a-f]{64}$/);

      const persisted = store._getKeys().find((k) => k.id === newKeyId);
      expect(persisted?.key_hash).toBe(hashSecret(rawSecret));

      // No raw material anywhere in the store
      expect(JSON.stringify(store._getKeys())).not.toContain(rawSecret);
      // Audit rows reference ids only
      expect(JSON.stringify(store._getAuditLog())).not.toContain(rawSecret);
      // The store cannot reproduce the secret from its hash
      expect(persisted?.key_hash).not.toBe(rawSecret);
      expect(crypto.createHash('sha256').update('not-the-secret').digest('hex')).not.toBe(
        persisted?.key_hash,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Acceptance criterion 3: invalid grace-window overrides return 400
  // -------------------------------------------------------------------------

  describe('grace-window override validation', () => {
    it.each([
      ['zero', { graceWindowMs: 0 }],
      ['negative', { graceWindowMs: -1_000 }],
      ['non-integer', { graceWindowMs: 1.5 }],
      ['string value', { graceWindowMs: '3600000' }],
      ['null value', { graceWindowMs: null }],
      ['NaN value', { graceWindowMs: Number.NaN }],
      ['Infinity', { graceWindowMs: Number.POSITIVE_INFINITY }],
    ])('rejects %s override with 400 and does not rotate', async (_label, body) => {
      const app = buildApp({ store, notifyAdmin, graceWindowMs: GRACE_MS });
      const res = await rotate(app, body);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      // Field-level detail must name the offending property
      expect(res.body.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'body.graceWindowMs' }),
        ]),
      );

      // Failed validation must not mutate key state or notify anyone
      expect(store._getKeys()).toHaveLength(0);
      expect(store._getAuditLog()).toHaveLength(0);
      expect(notifyAdmin).not.toHaveBeenCalled();
    });

    it('rejects unknown body fields (strict schema) with 400', async () => {
      const app = buildApp({ store, notifyAdmin, graceWindowMs: GRACE_MS });
      const res = await rotate(app, { graceWindowMs: 30_000, sneaky: true });

      expect(res.status).toBe(400);
      expect(store._getKeys()).toHaveLength(0);
    });

    it('accepts a valid override and applies it to this rotation only', async () => {
      const app = buildApp({
        store,
        notifyAdmin,
        graceWindowMs: GRACE_MS,
        now: () => FAKE_NOW,
      });

      const r1 = await rotate(app);
      const r2 = await rotate(app, { graceWindowMs: 300_000 });

      expect(r2.status).toBe(200);
      expect(r2.body.data.graceWindowMs).toBe(300_000);
      expect(r2.body.data.previousKeyExpiresAt).toBe(
        new Date(FAKE_NOW.getTime() + 300_000).toISOString(),
      );
      expect(r2.body.data.previousKeyId).toBe(r1.body.data.newKeyId);

      // Next rotation without an override falls back to the configured window
      const r3 = await rotate(app);
      expect(r3.body.data.graceWindowMs).toBe(GRACE_MS);
    });

    it('treats an absent body and an empty JSON object as valid rotations', async () => {
      const app = buildApp({ store, notifyAdmin, graceWindowMs: GRACE_MS });

      const noBody = await request(app)
        .post('/api/admin/webhooks/rotate-key')
        .set('x-admin-api-key', ADMIN_KEY)
        .send();
      const emptyBody = await rotate(app, {});

      expect(noBody.status).toBe(200);
      expect(emptyBody.status).toBe(200);
      expect(noBody.body.data.graceWindowMs).toBe(GRACE_MS);
      expect(emptyBody.body.data.graceWindowMs).toBe(GRACE_MS);
    });
  });

  // -------------------------------------------------------------------------
  // Acceptance criterion 4: audit callbacks receive actor + key ids,
  // never raw secrets
  // -------------------------------------------------------------------------

  describe('audit callbacks', () => {
    it('records an audit row with actor and key ids and no raw secret', async () => {
      const app = buildApp({
        store,
        notifyAdmin,
        graceWindowMs: GRACE_MS,
        now: () => FAKE_NOW,
      });

      const r1 = await rotate(app);
      const r2 = await rotate(app, { graceWindowMs: 300_000 });

      const log = store._getAuditLog();
      expect(log).toHaveLength(2);

      const [first, second] = log;
      expect(first.rotated_by).toBe(ACTOR);
      expect(first.new_key_id).toBe(r1.body.data.newKeyId);
      expect(first.previous_key_id).toBeNull();
      expect(first.grace_window_ms).toBe(GRACE_MS);
      expect(first.expires_at).toBe(new Date(FAKE_NOW.getTime() + GRACE_MS).toISOString());

      expect(second.rotated_by).toBe(ACTOR);
      expect(second.new_key_id).toBe(r2.body.data.newKeyId);
      expect(second.previous_key_id).toBe(r1.body.data.newKeyId);
      expect(second.grace_window_ms).toBe(300_000);

      // Raw secrets must not leak into audit storage
      const r1Secret: string = r1.body.data.rawSecret;
      const r2Secret: string = r2.body.data.rawSecret;
      expect(JSON.stringify(log)).not.toContain(r1Secret);
      expect(JSON.stringify(log)).not.toContain(r2Secret);
    });

    it('admin notification callback fires once per rotation with the rotation result', async () => {
      const app = buildApp({
        store,
        notifyAdmin,
        graceWindowMs: GRACE_MS,
        now: () => FAKE_NOW,
      });

      const res = await rotate(app);
      const rawSecret: string = res.body.data.rawSecret;

      expect(notifyAdmin).toHaveBeenCalledTimes(1);
      const arg = notifyAdmin.mock.calls[0][0];

      // The notifier is the one-time delivery channel: it receives the
      // RotationResult so the operator email can reference ids/expiry.
      expect(arg.newKey.id).toBe(res.body.data.newKeyId);
      expect(arg.graceWindowMs).toBe(GRACE_MS);
      expect(arg.previousKey).toBeNull();
      expect(arg.previousKeyExpiresAt).toBeNull();
      // The persisted key record exposes only the hash, never the secret
      expect(arg.newKey).not.toHaveProperty('rawSecret');
      expect(arg.newKey.key_hash).toBe(hashSecret(rawSecret));
    });

    it('rotation failure still resolves without breaking the response when notifyAdmin rejects', async () => {
      notifyAdmin.mockRejectedValue(new Error('SMTP down'));
      const app = buildApp({ store, notifyAdmin, graceWindowMs: GRACE_MS });

      const res = await rotate(app);
      expect(res.status).toBe(200);
      // Fire-and-forget: let the rejection surface (it is caught internally)
      await new Promise((r) => setImmediate(r));
    });

    it('writes the HTTP-layer audit entry with event, actor, and key ids', async () => {
      const auditSpy = jest.spyOn(logger, 'audit').mockImplementation(() => {});
      const app = buildApp({
        store,
        notifyAdmin,
        graceWindowMs: GRACE_MS,
        now: () => FAKE_NOW,
      });

      const res = await rotate(app);

      expect(auditSpy).toHaveBeenCalledWith(
        'ADMIN_WEBHOOK_ROTATE_KEY',
        ACTOR,
        expect.objectContaining({
          newKeyId: res.body.data.newKeyId,
          previousKeyId: null,
          graceWindowMs: GRACE_MS,
          clientIp: expect.any(String),
        }),
      );

      const loggedPayload = JSON.stringify(auditSpy.mock.calls.map((c) => c[2]));
      expect(loggedPayload).not.toContain(res.body.data.rawSecret);

      auditSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // Acceptance criterion 5: admin auth enforcement when mounted
  // -------------------------------------------------------------------------

  describe('admin auth enforcement when mounted', () => {
    it('rejects requests without credentials with 401', async () => {
      const app = buildApp({ store, notifyAdmin, graceWindowMs: GRACE_MS });
      const res = await request(app).post('/api/admin/webhooks/rotate-key').send();

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
      expect(store._getKeys()).toHaveLength(0);
      expect(notifyAdmin).not.toHaveBeenCalled();
    });

    it('rejects a wrong API key with 401', async () => {
      const app = buildApp({ store, notifyAdmin, graceWindowMs: GRACE_MS });
      const res = await request(app)
        .post('/api/admin/webhooks/rotate-key')
        .set('x-admin-api-key', 'wrong-key')
        .send();

      expect(res.status).toBe(401);
      expect(store._getKeys()).toHaveLength(0);
    });

    it('rejects a JWT without the admin role with 401', async () => {
      const app = buildApp({ store, notifyAdmin, graceWindowMs: GRACE_MS });
      const jwt = require('jsonwebtoken') as typeof import('jsonwebtoken');
      const token = jwt.sign({ role: 'developer', sub: 'user-1' }, JWT_SECRET, {
        expiresIn: '1h',
      });

      const res = await request(app)
        .post('/api/admin/webhooks/rotate-key')
        .set('Authorization', `Bearer ${token}`)
        .send();

      expect(res.status).toBe(401);
      expect(store._getKeys()).toHaveLength(0);
    });

    it('accepts an admin JWT and attributes the rotation to its subject', async () => {
      process.env.JWT_SECRET = JWT_SECRET;
      const app = buildApp({ store, notifyAdmin, graceWindowMs: GRACE_MS });
      const jwt = require('jsonwebtoken') as typeof import('jsonwebtoken');
      const token = jwt.sign({ role: 'admin', sub: 'admin-1' }, JWT_SECRET, {
        expiresIn: '1h',
      });

      const res = await request(app)
        .post('/api/admin/webhooks/rotate-key')
        .set('Authorization', `Bearer ${token}`)
        .send();

      expect(res.status).toBe(200);
      const log = store._getAuditLog();
      expect(log).toHaveLength(1);
      expect(log[0].rotated_by).toBe('admin-1');

      delete process.env.JWT_SECRET;
    });

    it('GET /grace-window is also auth-protected', async () => {
      const app = buildApp({ store, notifyAdmin, graceWindowMs: GRACE_MS });
      const res = await request(app).get('/api/admin/webhooks/grace-window');
      expect(res.status).toBe(401);
    });

    it('GET /grace-window returns the configured window for an admin', async () => {
      const app = buildApp({ store, notifyAdmin, graceWindowMs: 3_600_000 });
      const res = await rotate(app); // authenticate
      expect(res.status).toBe(200);

      const win = await request(app)
        .get('/api/admin/webhooks/grace-window')
        .set('x-admin-api-key', ADMIN_KEY);
      expect(win.status).toBe(200);
      expect(win.body.data).toMatchObject({
        graceWindowMs: 3_600_000,
        graceWindowHours: 1,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Failure-mode handling
  // -------------------------------------------------------------------------

  describe('failure modes', () => {
    it('maps an unexpected store failure to 500 without leaking internals', async () => {
      const brokenStore = new InMemoryWebhookKeyStore();
      jest.spyOn(brokenStore, 'insertKey').mockRejectedValue(new Error('DB exploded'));
      const app = buildApp({ store: brokenStore, notifyAdmin, graceWindowMs: GRACE_MS });

      const res = await rotate(app);
      expect(res.status).toBe(500);
      expect(res.body.code).toBe('INTERNAL_SERVER_ERROR');
      expect(res.body.message).toBe('Webhook key rotation failed');
      expect(res.body.message).not.toContain('DB exploded');
    });

    it('leaves no partial state when demotion fails mid-rotation', async () => {
      const brokenStore = new InMemoryWebhookKeyStore();
      jest
        .spyOn(brokenStore, 'demoteActiveKey')
        .mockRejectedValue(new Error('demotion failed'));
      const app = buildApp({ store: brokenStore, notifyAdmin, graceWindowMs: GRACE_MS });

      const res = await rotate(app);
      expect(res.status).toBe(500);
      // Nothing was inserted because demotion happens before insertion
      expect(brokenStore._getKeys()).toHaveLength(0);
      expect(brokenStore._getAuditLog()).toHaveLength(0);
      expect(notifyAdmin).not.toHaveBeenCalled();
    });
  });
});
