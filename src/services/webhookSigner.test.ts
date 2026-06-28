/**
 * webhookSigner.test.ts
 *
 * Unit + integration tests for:
 *   - WebhookSignerService (key generation, rotation, grace window, audit log)
 *   - POST /api/admin/webhooks/rotate-key route
 *   - GET  /api/admin/webhooks/grace-window route
 *   - InMemoryWebhookKeyStore
 *
 * Coverage target: ≥90% of changed lines.
 */

import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import {
  WebhookSignerService,
  InMemoryWebhookKeyStore,
  generateSigningSecret,
  hashSecret,
  resolveGraceWindowMs,
  type RotationResult,
  type WebhookSignerDeps,
} from '../../src/services/webhookSigner.js';
import { createWebhookKeysRouter } from '../../src/routes/admin/webhookKeys.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake admin Express app that skips IP allowlist + auth middleware. */
function buildTestApp(deps?: Partial<WebhookSignerDeps>) {
  const app = express();
  app.use(express.json());

  // Simulate adminAuth by injecting a fixed actor
  app.use((_req, res, next) => {
    res.locals.adminActor = 'test-admin';
    next();
  });

  app.use('/api/admin/webhooks', createWebhookKeysRouter(deps));
  return app;
}

/** Advance a fake clock by `ms` milliseconds. */
function advanceClock(base: Date, ms: number): Date {
  return new Date(base.getTime() + ms);
}

// ---------------------------------------------------------------------------
// generateSigningSecret
// ---------------------------------------------------------------------------

describe('generateSigningSecret()', () => {
  it('returns a 64-char hex string (256-bit key)', () => {
    const secret = generateSigningSecret();
    expect(secret).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(secret)).toBe(true);
  });

  it('is unique across calls', () => {
    const a = generateSigningSecret();
    const b = generateSigningSecret();
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// hashSecret
// ---------------------------------------------------------------------------

describe('hashSecret()', () => {
  it('returns the SHA-256 hex of the input', () => {
    const raw = 'my-test-secret';
    const expected = crypto.createHash('sha256').update(raw).digest('hex');
    expect(hashSecret(raw)).toBe(expected);
  });

  it('is deterministic', () => {
    const raw = generateSigningSecret();
    expect(hashSecret(raw)).toBe(hashSecret(raw));
  });
});

// ---------------------------------------------------------------------------
// resolveGraceWindowMs
// ---------------------------------------------------------------------------

describe('resolveGraceWindowMs()', () => {
  const ORIGINAL_ENV = process.env.WEBHOOK_SECRET_ROTATION_GRACE_MS;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.WEBHOOK_SECRET_ROTATION_GRACE_MS;
    } else {
      process.env.WEBHOOK_SECRET_ROTATION_GRACE_MS = ORIGINAL_ENV;
    }
  });

  it('returns the override when provided', () => {
    expect(resolveGraceWindowMs(30_000)).toBe(30_000);
  });

  it('reads from env var when no override', () => {
    process.env.WEBHOOK_SECRET_ROTATION_GRACE_MS = '7200000';
    expect(resolveGraceWindowMs()).toBe(7_200_000);
  });

  it('returns 86_400_000 when env var is missing', () => {
    delete process.env.WEBHOOK_SECRET_ROTATION_GRACE_MS;
    expect(resolveGraceWindowMs()).toBe(86_400_000);
  });

  it('ignores non-numeric env var and falls back to default', () => {
    process.env.WEBHOOK_SECRET_ROTATION_GRACE_MS = 'bad-value';
    expect(resolveGraceWindowMs()).toBe(86_400_000);
  });

  it('ignores zero or negative overrides and falls back to env', () => {
    delete process.env.WEBHOOK_SECRET_ROTATION_GRACE_MS;
    expect(resolveGraceWindowMs(0)).toBe(86_400_000);
    expect(resolveGraceWindowMs(-1)).toBe(86_400_000);
  });
});

// ---------------------------------------------------------------------------
// InMemoryWebhookKeyStore
// ---------------------------------------------------------------------------

describe('InMemoryWebhookKeyStore', () => {
  let store: InMemoryWebhookKeyStore;

  beforeEach(() => {
    store = new InMemoryWebhookKeyStore();
  });

  it('returns null when no active key exists', async () => {
    expect(await store.getActiveKey()).toBeNull();
  });

  it('inserts and retrieves an active key', async () => {
    const key = {
      id: 'k1',
      key_hash: hashSecret('raw'),
      status: 'active' as const,
      created_at: new Date().toISOString(),
      expires_at: null,
      created_by: 'admin',
    };
    await store.insertKey(key);
    const found = await store.getActiveKey();
    expect(found?.id).toBe('k1');
  });

  it('demoteActiveKey returns null when no active key', async () => {
    const result = await store.demoteActiveKey(new Date());
    expect(result).toBeNull();
  });

  it('demoteActiveKey transitions active → previous with expiry', async () => {
    await store.insertKey({
      id: 'k1',
      key_hash: 'aaa',
      status: 'active',
      created_at: new Date().toISOString(),
      expires_at: null,
      created_by: 'admin',
    });
    const expiry = new Date(Date.now() + 60_000);
    const demoted = await store.demoteActiveKey(expiry);
    expect(demoted?.status).toBe('previous');
    expect(demoted?.expires_at).toBe(expiry.toISOString());
    expect(await store.getActiveKey()).toBeNull();
  });

  it('getValidPreviousKeys returns only keys within grace window', async () => {
    const now = new Date('2025-01-01T12:00:00Z');
    const future = new Date(now.getTime() + 1_000);
    const past = new Date(now.getTime() - 1_000);

    await store.insertKey({ id: 'k-future', key_hash: 'aaa', status: 'previous', created_at: now.toISOString(), expires_at: future.toISOString(), created_by: 'admin' });
    await store.insertKey({ id: 'k-past',   key_hash: 'bbb', status: 'previous', created_at: now.toISOString(), expires_at: past.toISOString(),   created_by: 'admin' });

    const valid = await store.getValidPreviousKeys(now);
    expect(valid.map((k) => k.id)).toContain('k-future');
    expect(valid.map((k) => k.id)).not.toContain('k-past');
  });

  it('expireStaleKeys moves expired previous keys to expired status', async () => {
    const past = new Date(Date.now() - 1_000);
    await store.insertKey({ id: 'k1', key_hash: 'aaa', status: 'previous', created_at: new Date().toISOString(), expires_at: past.toISOString(), created_by: 'admin' });
    await store.expireStaleKeys(new Date());
    const keys = store._getKeys();
    expect(keys.find((k) => k.id === 'k1')?.status).toBe('expired');
  });

  it('insertAuditEntry records an audit row', async () => {
    const entry = {
      id: 'a1',
      new_key_id: 'k1',
      previous_key_id: null,
      grace_window_ms: 3600,
      expires_at: new Date().toISOString(),
      rotated_by: 'admin',
      rotated_at: new Date().toISOString(),
      correlation_id: null,
    };
    await store.insertAuditEntry(entry);
    expect(store._getAuditLog()).toHaveLength(1);
    expect(store._getAuditLog()[0].id).toBe('a1');
  });
});

// ---------------------------------------------------------------------------
// WebhookSignerService
// ---------------------------------------------------------------------------

describe('WebhookSignerService', () => {
  let store: InMemoryWebhookKeyStore;
  let notifyAdmin: jest.Mock;
  let fakeNow: Date;
  let service: WebhookSignerService;

  function buildService(overrides?: Partial<WebhookSignerDeps>) {
    return new WebhookSignerService({
      store,
      notifyAdmin,
      now: () => fakeNow,
      graceWindowMs: 60_000, // 1 minute for fast tests
      ...overrides,
    });
  }

  beforeEach(() => {
    store = new InMemoryWebhookKeyStore();
    notifyAdmin = jest.fn().mockResolvedValue(undefined);
    fakeNow = new Date('2025-06-01T10:00:00Z');
    service = buildService();
  });

  // ── rotateKey ─────────────────────────────────────────────────────────────

  describe('rotateKey()', () => {
    it('returns a rawSecret of 64 hex chars', async () => {
      const result = await service.rotateKey('admin');
      expect(result.rawSecret).toHaveLength(64);
      expect(/^[0-9a-f]+$/.test(result.rawSecret)).toBe(true);
    });

    it('new key is persisted with status "active"', async () => {
      await service.rotateKey('admin');
      const active = await store.getActiveKey();
      expect(active?.status).toBe('active');
    });

    it('hash of rawSecret matches persisted key_hash', async () => {
      const result = await service.rotateKey('admin');
      expect(result.newKey.key_hash).toBe(hashSecret(result.rawSecret));
    });

    it('previousKey is null on first rotation', async () => {
      const result = await service.rotateKey('admin');
      expect(result.previousKey).toBeNull();
      expect(result.previousKeyExpiresAt).toBeNull();
    });

    it('second rotation demotes first key to previous', async () => {
      const r1 = await service.rotateKey('admin');
      const r2 = await service.rotateKey('admin');
      expect(r2.previousKey?.id).toBe(r1.newKey.id);
      expect(r2.previousKey?.status).toBe('previous');
    });

    it('previous key expires at now + graceWindowMs', async () => {
      await service.rotateKey('admin');
      const r2 = await service.rotateKey('admin');
      const expected = new Date(fakeNow.getTime() + 60_000).toISOString();
      expect(r2.previousKeyExpiresAt).toBe(expected);
    });

    it('reflects graceWindowMs in result', async () => {
      const result = await service.rotateKey('admin');
      expect(result.graceWindowMs).toBe(60_000);
    });

    it('writes an audit log entry', async () => {
      await service.rotateKey('admin');
      expect(store._getAuditLog()).toHaveLength(1);
    });

    it('audit entry references correct key IDs', async () => {
      const r1 = await service.rotateKey('admin');
      const r2 = await service.rotateKey('admin');
      const log = store._getAuditLog();
      expect(log[1].new_key_id).toBe(r2.newKey.id);
      expect(log[1].previous_key_id).toBe(r1.newKey.id);
    });

    it('calls notifyAdmin with the rotation result', async () => {
      const result = await service.rotateKey('admin');
      expect(notifyAdmin).toHaveBeenCalledTimes(1);
      expect(notifyAdmin).toHaveBeenCalledWith(result);
    });

    it('does NOT rethrow when notifyAdmin rejects', async () => {
      notifyAdmin.mockRejectedValue(new Error('SMTP down'));
      await expect(service.rotateKey('admin')).resolves.toBeDefined();
    });

    it('generates a unique key on every call', async () => {
      const r1 = await service.rotateKey('admin');
      fakeNow = advanceClock(fakeNow, 1);
      const r2 = await service.rotateKey('admin');
      expect(r1.rawSecret).not.toBe(r2.rawSecret);
      expect(r1.newKey.id).not.toBe(r2.newKey.id);
    });
  });

  // ── getActiveKeyHashes ───────────────────────────────────────────────────

  describe('getActiveKeyHashes()', () => {
    it('returns empty array before any rotation', async () => {
      expect(await service.getActiveKeyHashes()).toEqual([]);
    });

    it('returns only active key hash after first rotation', async () => {
      const r = await service.rotateKey('admin');
      const hashes = await service.getActiveKeyHashes();
      expect(hashes).toContain(hashSecret(r.rawSecret));
      expect(hashes).toHaveLength(1);
    });

    it('returns both active and previous hashes within grace window', async () => {
      const r1 = await service.rotateKey('admin');
      const r2 = await service.rotateKey('admin');
      const hashes = await service.getActiveKeyHashes();
      expect(hashes).toContain(hashSecret(r1.rawSecret)); // previous — still valid
      expect(hashes).toContain(hashSecret(r2.rawSecret)); // active
      expect(hashes).toHaveLength(2);
    });

    it('excludes previous key after grace window expires', async () => {
      const r1 = await service.rotateKey('admin');
      await service.rotateKey('admin');

      // Advance clock past grace window
      const afterGrace = advanceClock(fakeNow, 60_001);
      const hashes = await service.getActiveKeyHashes(afterGrace);
      expect(hashes).not.toContain(hashSecret(r1.rawSecret));
      expect(hashes).toHaveLength(1); // only new active key
    });

    it('expires stale previous keys lazily on read', async () => {
      await service.rotateKey('admin');
      await service.rotateKey('admin');

      const afterGrace = advanceClock(fakeNow, 60_001);
      await service.getActiveKeyHashes(afterGrace);

      const keys = store._getKeys();
      const expiredKeys = keys.filter((k) => k.status === 'expired');
      expect(expiredKeys).toHaveLength(1);
    });
  });

  // ── edge cases ───────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('three consecutive rotations: only current + most-recent-previous remain valid', async () => {
      const r1 = await service.rotateKey('admin');
      fakeNow = advanceClock(fakeNow, 1);
      const r2 = await service.rotateKey('admin');
      fakeNow = advanceClock(fakeNow, 1);
      await service.rotateKey('admin');

      const hashes = await service.getActiveKeyHashes();
      // r1 was demoted when r2 was generated; then r2 was demoted when r3 was generated.
      // The store only keeps one "previous" slot active — the most recently demoted key (r2).
      // r1 was overwritten/expired — confirm it is NOT present.
      expect(hashes).not.toContain(hashSecret(r1.rawSecret));
      expect(hashes).toContain(hashSecret(r2.rawSecret));
    });

    it('audit log grows by one entry per rotation', async () => {
      await service.rotateKey('admin');
      await service.rotateKey('admin');
      await service.rotateKey('admin');
      expect(store._getAuditLog()).toHaveLength(3);
    });
  });
});

// ---------------------------------------------------------------------------
// HTTP route: POST /api/admin/webhooks/rotate-key
// ---------------------------------------------------------------------------

describe('POST /api/admin/webhooks/rotate-key', () => {
  let app: ReturnType<typeof buildTestApp>;
  let store: InMemoryWebhookKeyStore;
  let notifyAdmin: jest.Mock;

  beforeEach(() => {
    store = new InMemoryWebhookKeyStore();
    notifyAdmin = jest.fn().mockResolvedValue(undefined);
    app = buildTestApp({ store, notifyAdmin, graceWindowMs: 60_000 });
  });

  it('returns 200 with the expected shape', async () => {
    const res = await request(app).post('/api/admin/webhooks/rotate-key').send();
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      newKeyId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      rawSecret: expect.stringMatching(/^[0-9a-f]{64}$/),
      graceWindowMs: 60_000,
      previousKeyId: null,
      previousKeyExpiresAt: null,
      rotatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });

  it('rawSecret is a valid 64-char hex string', async () => {
    const res = await request(app).post('/api/admin/webhooks/rotate-key').send();
    expect(res.body.data.rawSecret).toHaveLength(64);
  });

  it('successive calls return different rawSecrets', async () => {
    const r1 = await request(app).post('/api/admin/webhooks/rotate-key').send();
    const r2 = await request(app).post('/api/admin/webhooks/rotate-key').send();
    expect(r1.body.data.rawSecret).not.toBe(r2.body.data.rawSecret);
    expect(r1.body.data.newKeyId).not.toBe(r2.body.data.newKeyId);
  });

  it('second call includes previousKeyId from first rotation', async () => {
    const r1 = await request(app).post('/api/admin/webhooks/rotate-key').send();
    const r2 = await request(app).post('/api/admin/webhooks/rotate-key').send();
    expect(r2.body.data.previousKeyId).toBe(r1.body.data.newKeyId);
    expect(r2.body.data.previousKeyExpiresAt).toBeTruthy();
  });

  it('calls notifyAdmin once per rotation', async () => {
    await request(app).post('/api/admin/webhooks/rotate-key').send();
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
  });

  it('persists an audit log entry per rotation', async () => {
    await request(app).post('/api/admin/webhooks/rotate-key').send();
    await request(app).post('/api/admin/webhooks/rotate-key').send();
    expect(store._getAuditLog()).toHaveLength(2);
  });

  it('returns 400 for non-JSON Content-Type with body', async () => {
    const res = await request(app)
      .post('/api/admin/webhooks/rotate-key')
      .set('Content-Type', 'text/plain')
      .send('bad body');
    expect(res.status).toBe(400);
  });

  it('accepts empty JSON body ({})', async () => {
    const res = await request(app)
      .post('/api/admin/webhooks/rotate-key')
      .set('Content-Type', 'application/json')
      .send({});
    expect(res.status).toBe(200);
  });

  it('accepts no body at all', async () => {
    const res = await request(app)
      .post('/api/admin/webhooks/rotate-key');
    expect(res.status).toBe(200);
  });

  it('returns 500 when the store throws an unexpected error', async () => {
    const brokenStore = new InMemoryWebhookKeyStore();
    jest.spyOn(brokenStore, 'insertKey').mockRejectedValue(new Error('DB exploded'));

    const brokenApp = buildTestApp({ store: brokenStore, graceWindowMs: 60_000 });
    const res = await request(brokenApp).post('/api/admin/webhooks/rotate-key').send();
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// HTTP route: GET /api/admin/webhooks/grace-window
// ---------------------------------------------------------------------------

describe('GET /api/admin/webhooks/grace-window', () => {
  it('returns the configured grace window', async () => {
    const app = buildTestApp({ graceWindowMs: 3_600_000 });
    const res = await request(app).get('/api/admin/webhooks/grace-window');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      graceWindowMs: 3_600_000,
      graceWindowHours: 1,
    });
  });

  it('returns default when no override is given', async () => {
    delete process.env.WEBHOOK_SECRET_ROTATION_GRACE_MS;
    const app = buildTestApp({ store: new InMemoryWebhookKeyStore() });
    const res = await request(app).get('/api/admin/webhooks/grace-window');
    expect(res.status).toBe(200);
    expect(res.body.data.graceWindowMs).toBe(86_400_000);
  });
});

// ---------------------------------------------------------------------------
// Grace-window integration: dual-key verification scenario
// ---------------------------------------------------------------------------

describe('Grace window — dual-key verification', () => {
  it('both old and new raw secrets are valid during grace window', async () => {
    const store = new InMemoryWebhookKeyStore();
    const fakeNow = { value: new Date('2025-06-01T10:00:00Z') };
    const service = new WebhookSignerService({
      store,
      graceWindowMs: 60_000,
      now: () => fakeNow.value,
    });

    const r1 = await service.rotateKey('admin');
    const r2 = await service.rotateKey('admin');

    // Both keys should be in the active hashes list
    const hashes = await service.getActiveKeyHashes(fakeNow.value);
    expect(hashes).toContain(hashSecret(r1.rawSecret));
    expect(hashes).toContain(hashSecret(r2.rawSecret));
  });

  it('old key is no longer active after grace window ends', async () => {
    const store = new InMemoryWebhookKeyStore();
    const clock = { value: new Date('2025-06-01T10:00:00Z') };
    const service = new WebhookSignerService({
      store,
      graceWindowMs: 60_000,
      now: () => clock.value,
    });

    const r1 = await service.rotateKey('admin');
    await service.rotateKey('admin');

    // Advance past grace window
    const afterGrace = new Date(clock.value.getTime() + 60_001);
    const hashes = await service.getActiveKeyHashes(afterGrace);
    expect(hashes).not.toContain(hashSecret(r1.rawSecret));
  });

  it('new key is valid immediately after rotation', async () => {
    const store = new InMemoryWebhookKeyStore();
    const service = new WebhookSignerService({ store, graceWindowMs: 60_000 });

    const r1 = await service.rotateKey('admin');
    const hashes = await service.getActiveKeyHashes();
    expect(hashes).toContain(hashSecret(r1.rawSecret));
  });
});