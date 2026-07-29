/**
 * webhookSigner.ts
 *
 * Manages the *platform-level* webhook signing key lifecycle:
 *   - Generates cryptographically-random HMAC-SHA256 secrets.
 *   - Stores key metadata (hash, status, expiry) via an injected KeyStore.
 *   - Returns BOTH the active and the still-valid previous key on `getActiveSecrets()`
 *     so callers can verify against either during the grace window.
 *   - Dispatches a rotation notification and writes an audit log entry on each rotation.
 *
 * Security properties:
 *   - Raw key material is returned ONLY at generation time; the store persists
 *     only the SHA-256 hash, so a DB breach cannot expose live secrets.
 *   - The returned `rawSecret` on rotation must be distributed to subscribers
 *     immediately; it is unrecoverable afterward.
 *   - Grace-window duration is read from the `WEBHOOK_SECRET_ROTATION_GRACE_MS`
 *     environment variable (default: 86 400 000 ms = 24 h).
 */

import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../logger.js';
import { getRequestId } from '../logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default grace window: 24 hours in milliseconds. */
const DEFAULT_GRACE_WINDOW_MS = 86_400_000;

/** Number of random bytes for the signing key (256-bit entropy). */
const KEY_BYTES = 32;

// ---------------------------------------------------------------------------
// Types & interfaces (dependency-injection friendly)
// ---------------------------------------------------------------------------

export type KeyStatus = 'active' | 'previous' | 'expired';

/** Persisted representation of one signing key (no raw secret stored). */
export interface WebhookSigningKey {
  id: string;
  key_hash: string;     // SHA-256 hex of the raw secret
  status: KeyStatus;
  created_at: string;   // ISO-8601
  expires_at: string | null;
  created_by: string;
}

/** Audit log entry written on every rotation. */
export interface WebhookKeyRotationAudit {
  id: string;
  new_key_id: string;
  previous_key_id: string | null;
  grace_window_ms: number;
  expires_at: string;   // ISO-8601 — when the previous key becomes invalid
  rotated_by: string;
  rotated_at: string;   // ISO-8601
  correlation_id: string | null;
}

/**
 * Minimal DB/cache abstraction — swap the in-memory implementation for a
 * real Postgres/SQLite adapter without touching service logic.
 */
export interface WebhookKeyStore {
  /**
   * Returns the single key currently marked `active`, or null if no key
   * has ever been generated.
   */
  getActiveKey(): Promise<WebhookSigningKey | null>;

  /**
   * Returns all keys with status `'previous'` whose `expires_at` is still
   * in the future (i.e. still within their grace window).
   */
  getValidPreviousKeys(now: Date): Promise<WebhookSigningKey[]>;

  /**
   * Persist a new key row.  The caller is responsible for setting status,
   * expires_at, etc. before calling this.
   */
  insertKey(key: WebhookSigningKey): Promise<void>;

  /**
   * Transition the current active key to `'previous'` and set its expiry.
   * No-op when there is no active key (first-ever rotation).
   */
  demoteActiveKey(expiresAt: Date): Promise<WebhookSigningKey | null>;

  /**
   * Expire all `'previous'` keys whose `expires_at` is in the past.
   * Called lazily on each read to keep the store clean.
   */
  expireStaleKeys(now: Date): Promise<void>;

  /**
   * Append a rotation audit record.
   */
  insertAuditEntry(entry: WebhookKeyRotationAudit): Promise<void>;
}

/** What callers get back from `rotateKey()`. */
export interface RotationResult {
  /** The new active key's metadata (no raw secret). */
  newKey: WebhookSigningKey;
  /** Raw secret — ONLY available here; not stored anywhere after this call. */
  rawSecret: string;
  /** The demoted previous key (if any). */
  previousKey: WebhookSigningKey | null;
  /** Grace window applied, in milliseconds. */
  graceWindowMs: number;
  /** UTC timestamp when the old key becomes invalid. */
  previousKeyExpiresAt: string | null;
}

/** Dependency bundle injected into WebhookSignerService. */
export interface WebhookSignerDeps {
  store: WebhookKeyStore;
  /** Called after a successful rotation to notify admin (fire-and-forget). */
  notifyAdmin?: (result: RotationResult) => Promise<void>;
  /** Overrideable clock — defaults to `() => new Date()`. */
  now?: () => Date;
  /** Grace window override in milliseconds. Defaults to WEBHOOK_SECRET_ROTATION_GRACE_MS env var. */
  graceWindowMs?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a cryptographically-random hex secret. */
export function generateSigningSecret(): string {
  return crypto.randomBytes(KEY_BYTES).toString('hex');
}

/** SHA-256 hex hash of the raw secret — stored instead of plaintext. */
export function hashSecret(rawSecret: string): string {
  return crypto.createHash('sha256').update(rawSecret).digest('hex');
}

/** Read grace window from env (ms). Returns parsed int or default. */
export function resolveGraceWindowMs(override?: number): number {
  if (override !== undefined && Number.isFinite(override) && override > 0) {
    return override;
  }
  const env = parseInt(process.env.WEBHOOK_SECRET_ROTATION_GRACE_MS ?? '', 10);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_GRACE_WINDOW_MS;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class WebhookSignerService {
  private readonly store: WebhookKeyStore;
  private readonly notifyAdmin: (result: RotationResult) => Promise<void>;
  private readonly clock: () => Date;
  private readonly graceWindowMs: number;

  constructor(deps: WebhookSignerDeps) {
    this.store = deps.store;
    this.notifyAdmin = deps.notifyAdmin ?? (() => Promise.resolve());
    this.clock = deps.now ?? (() => new Date());
    this.graceWindowMs = resolveGraceWindowMs(deps.graceWindowMs);
  }

  /**
   * Rotate the platform webhook signing key.
   *
   * Steps:
   *   1. Generate a new random secret + hash.
   *   2. Demote the current active key → `previous` with an expiry timestamp.
   *   3. Persist the new active key.
   *   4. Write an audit log entry.
   *   5. Fire-and-forget admin notification.
   *
   * @param actor  - Admin identifier from `res.locals.adminActor`.
   * @returns      RotationResult containing the raw secret (one-time exposure).
   */
  async rotateKey(actor: string): Promise<RotationResult> {
    const now = this.clock();
    const correlationId = getRequestId() ?? null;
    const expiresAt = new Date(now.getTime() + this.graceWindowMs);

    // 1. Generate new key material
    const rawSecret = generateSigningSecret();
    const newKeyId = uuidv4();
    const newKey: WebhookSigningKey = {
      id: newKeyId,
      key_hash: hashSecret(rawSecret),
      status: 'active',
      created_at: now.toISOString(),
      expires_at: null,           // active key has no expiry
      created_by: actor,
    };

    // 2. Demote existing active key
    const previousKey = await this.store.demoteActiveKey(expiresAt);

    // 3. Persist new active key
    await this.store.insertKey(newKey);

    // 4. Audit log
    const auditEntry: WebhookKeyRotationAudit = {
      id: uuidv4(),
      new_key_id: newKeyId,
      previous_key_id: previousKey?.id ?? null,
      grace_window_ms: this.graceWindowMs,
      expires_at: expiresAt.toISOString(),
      rotated_by: actor,
      rotated_at: now.toISOString(),
      correlation_id: correlationId,
    };
    await this.store.insertAuditEntry(auditEntry);

    logger.audit('WEBHOOK_KEY_ROTATED', actor, {
      newKeyId,
      previousKeyId: previousKey?.id ?? null,
      graceWindowMs: this.graceWindowMs,
      previousKeyExpiresAt: expiresAt.toISOString(),
      correlationId,
    });

    const result: RotationResult = {
      newKey,
      rawSecret,
      previousKey: previousKey ?? null,
      graceWindowMs: this.graceWindowMs,
      previousKeyExpiresAt: previousKey ? expiresAt.toISOString() : null,
    };

    // 5. Notify admin (fire-and-forget — failure must not roll back rotation)
    this.notifyAdmin(result).catch((err: unknown) => {
      logger.error('Webhook key rotation: admin notification failed', err);
    });

    return result;
  }

  /**
   * Return all currently-valid raw key hashes (active + unexpired previous).
   * Used by signature-verification middleware to accept either key.
   *
   * Note: hashes — not raw secrets — are what lives in the store.
   */
  async getActiveKeyHashes(now?: Date): Promise<string[]> {
    const ts = now ?? this.clock();

    // Clean up expired keys lazily on each read
    await this.store.expireStaleKeys(ts);

    const active = await this.store.getActiveKey();
    const previous = await this.store.getValidPreviousKeys(ts);

    const hashes: string[] = [];
    if (active) hashes.push(active.key_hash);
    for (const k of previous) hashes.push(k.key_hash);
    return hashes;
  }
}

// ---------------------------------------------------------------------------
// Default in-memory store (suitable for tests and single-process deploys)
// ---------------------------------------------------------------------------

/**
 * In-memory implementation of WebhookKeyStore.
 * Replace with a SQLite/Postgres-backed implementation for production persistence.
 */
export class InMemoryWebhookKeyStore implements WebhookKeyStore {
  private keys: WebhookSigningKey[] = [];
  private auditLog: WebhookKeyRotationAudit[] = [];

  async getActiveKey(): Promise<WebhookSigningKey | null> {
    return this.keys.find((k) => k.status === 'active') ?? null;
  }

  async getValidPreviousKeys(now: Date): Promise<WebhookSigningKey[]> {
    return this.keys.filter(
      (k) =>
        k.status === 'previous' &&
        k.expires_at !== null &&
        new Date(k.expires_at).getTime() >= now.getTime(),
    );
  }

  async insertKey(key: WebhookSigningKey): Promise<void> {
    this.keys.push({ ...key });
  }

  async demoteActiveKey(expiresAt: Date): Promise<WebhookSigningKey | null> {
    const idx = this.keys.findIndex((k) => k.status === 'active');
    if (idx === -1) return null;
    this.keys[idx] = {
      ...this.keys[idx],
      status: 'previous',
      expires_at: expiresAt.toISOString(),
    };
    return { ...this.keys[idx] };
  }

  async expireStaleKeys(now: Date): Promise<void> {
    for (const key of this.keys) {
      if (
        key.status === 'previous' &&
        key.expires_at !== null &&
        new Date(key.expires_at).getTime() < now.getTime()
      ) {
        key.status = 'expired';
      }
    }
  }

  async insertAuditEntry(entry: WebhookKeyRotationAudit): Promise<void> {
    this.auditLog.push({ ...entry });
  }

  /** Test helper — inspect stored keys. */
  _getKeys(): WebhookSigningKey[] {
    return [...this.keys];
  }

  /** Test helper — inspect audit log. */
  _getAuditLog(): WebhookKeyRotationAudit[] {
    return [...this.auditLog];
  }

  /** Test helper — reset state. */
  _reset(): void {
    this.keys = [];
    this.auditLog = [];
  }
}