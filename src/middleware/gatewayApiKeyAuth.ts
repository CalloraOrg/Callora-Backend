import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler } from 'express';
import { ForbiddenError, NotFoundError, UnauthorizedError } from '../errors/index.js';
import { recordApiKeyLookup } from '../metrics.js';

export const API_KEY_PREFIX_LENGTH = 16;

export interface GatewayApiKeyRecord {
  id: string;
  userId: string;
  apiId: string;
  prefix: string;
  keyHash: string;
  revoked?: boolean;
  scopes?: string[];
  rateLimitPerMinute?: number | null;
  createdAt?: Date | string;
  lastUsedAt?: Date | string | null;
  tier?: string;
  expiresAt?: Date | string | null;
}

export interface GatewayAuthCandidate<
  TUser = Record<string, unknown>,
  TVault = Record<string, unknown> | null,
> {
  apiKeyRecord: GatewayApiKeyRecord;
  user: TUser;
  vault: TVault;
}

export interface GatewayResolvedContext<
  TApi = Record<string, unknown>,
  TEndpoint = Record<string, unknown>,
> {
  api: TApi;
  endpoint: TEndpoint;
}

export interface GatewayApiKeyAuthOptions<
  TApi = Record<string, unknown>,
  TEndpoint = Record<string, unknown>,
  TUser = Record<string, unknown>,
  TVault = Record<string, unknown> | null,
> {
  getApiKeyCandidates(prefix: string, req: Request): Promise<GatewayAuthCandidate<TUser, TVault>[]>;
  resolveApiContext(req: Request): Promise<GatewayResolvedContext<TApi, TEndpoint> | null> | GatewayResolvedContext<TApi, TEndpoint> | null;
  getApiId(api: TApi): string;
  /** If set, the middleware rejects keys that do not include this scope.
   *  Keys with scopes containing '*' are always allowed.
   *  Keys with empty/null scopes default to ['read']. */
  requiredScope?: string;
  onUnauthorized?: (next: NextFunction, message: string) => void;
  onNotFound?: (next: NextFunction, message: string) => void;
}

export interface ExtractedApiKey {
  apiKey: string | null;
  source: 'authorization' | 'x-api-key' | null;
  error?: string;
}

export interface InMemoryGatewayApiKey {
  key: string;
  developerId: string;
  apiId: string;
  revoked?: boolean;
  scopes?: string[];
  tier?: string;
}

export interface GatewayAuthQueryable {
  query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface DatabaseGatewayApiKeyRow {
  api_key_id: string | number;
  user_id: string | number;
  api_id: string | number;
  prefix: string;
  key_hash: string;
  revoked: boolean;
  scopes: string[] | null;
  rate_limit_per_minute: number | null;
  created_at: string | Date | null;
  last_used_at: string | Date | null;
  plan_tier: string | null;
  user: Record<string, unknown> | null;
  vault: Record<string, unknown> | null;
}

const SHA256_HEX_LENGTH = 64;

const DEFAULT_CACHE_MAX_ENTRIES = 500;
const DEFAULT_CACHE_TTL_MS = 5_000;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sha256Base64(value: string): string {
  return createHash('sha256').update(value).digest('base64');
}

function legacyBase64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

function matchesStoredHash(apiKey: string, storedHash: string): boolean {
  const candidates = [sha256Hex(apiKey), sha256Base64(apiKey)];

  if (storedHash.length !== SHA256_HEX_LENGTH) {
    candidates.push(legacyBase64(apiKey));
  }

  return candidates.some((candidate) => timingSafeStringEqual(candidate, storedHash));
}

function unauthorized(next: NextFunction, message: string): void {
  next(new UnauthorizedError(message));
}

function notFound(next: NextFunction, message: string): void {
  next(new NotFoundError(message));
}

function forbidden(next: NextFunction, message: string): void {
  next(new ForbiddenError(message));
}

/**
 * Simple short-lived LRU cache keyed by the SHA-256 hex of an API key.
 * Used to short-circuit repeated verifications of the same key within a
 * short window, avoiding repeated bcrypt comparisons. Revoked keys are
 * evicted immediately via invalidate().
 */
export interface ApiKeyVerificationCache {
  get(keyHash: string): GatewayAuthCandidate | undefined;
  set(keyHash: string, candidate: GatewayAuthCandidate): void;
  invalidate(keyHash: string): void;
  clear(): void;
  size(): number;
}

export function createApiKeyVerificationCache(
  maxEntries = DEFAULT_CACHE_MAX_ENTRIES,
  ttlMs = DEFAULT_CACHE_TTL_MS,
): ApiKeyVerificationCache {
  interface Entry {
    candidate: GatewayAuthCandidate;
    expiresAt: number;
  }

  const entries = new Map<string, Entry>();

  function evictExpired() {
    const now = Date.now();
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now) {
        entries.delete(key);
      }
    }
  }

  return {
    get(keyHash) {
      const entry = entries.get(keyHash);
      if (!entry) {
        return undefined;
      }
      if (entry.expiresAt <= Date.now()) {
        entries.delete(keyHash);
        return undefined;
      }
      // Refresh LRU order.
      entries.delete(keyHash);
      entries.set(keyHash, entry);
      return entry.candidate;
    },
    set(keyHash, candidate) {
      if (maxEntries <= 0) {
        return;
      }
      evictExpired();
      if (entries.has(keyHash)) {
        entries.delete(keyHash);
      }
      entries.set(keyHash, { candidate, expiresAt: Date.now() + ttlMs });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        entries.delete(oldest);
      }
    },
    invalidate(keyHash) {
      entries.delete(keyHash);
    },
    clear() {
      entries.clear();
    },
    size() {
      return entries.size;
    },
  };
}

export function extractApiKey(req: Request): ExtractedApiKey {
  const xApiKey = req.header('x-api-key');
  if (typeof xApiKey === 'string' && xApiKey.trim() !== '') {
    return { apiKey: xApiKey.trim(), source: 'x-api-key' };
  }

  const authorization = req.header('authorization');
  if (authorization) {
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (match && match[1].trim()) {
      return { apiKey: match[1].trim(), source: 'authorization' };
    }
  }

  if (authorization) {
    return {
      apiKey: null,
      source: null,
      error: 'Unauthorized: malformed Authorization header',
    };
  }

  return {
    apiKey: null,
    source: null,
    error: 'Unauthorized: missing API key',
  };
}

export interface GatewayApiKeyAuthMiddlewareOptions<
  TApi = Record<string, unknown>,
  TEndpoint = Record<string, unknown>,
  TUser = Record<string, unknown>,
  TVault = Record<string, unknown> | null,
> extends GatewayApiKeyAuthOptions<TApi, TEndpoint, TUser, TVault> {
  /** Optional cache for recently verified keys. Defaults to an internal LRU. */
  verificationCache?: ApiKeyVerificationCache | null;
}

export function createGatewayApiKeyAuthMiddleware<
  TApi = Record<string, unknown>,
  TEndpoint = Record<string, unknown>,
  TUser = Record<string, unknown>,
  TVault = Record<string, unknown> | null,
>(
  options: GatewayApiKeyAuthMiddlewareOptions<TApi, TEndpoint, TUser, TVault>,
): RequestHandler {
  const handleUnauthorized = options.onUnauthorized ?? unauthorized;
  const handleNotFound = options.onNotFound ?? notFound;
  const handleForbidden = forbidden;
  const verificationCache =
    options.verificationCache === null
      ? null
      : options.verificationCache ?? createApiKeyVerificationCache();

  return async (req, res, next) => {
    const extracted = extractApiKey(req);
    if (!extracted.apiKey) {
      // No key was provided or the header format was invalid
      recordApiKeyLookup('miss');
      handleUnauthorized(next, extracted.error ?? 'Unauthorized: missing API key');
      return;
    }

    const resolvedContext = await options.resolveApiContext(req);
    if (!resolvedContext) {
      recordApiKeyLookup('miss');
      handleNotFound(next, 'Not Found: unknown API');
      return;
    }

    const keyHash = sha256Hex(extracted.apiKey);

    // Fast path: a previously verified key within the cache TTL.
    // This avoids any bcrypt work for repeated requests and keeps the
    // event loop free.
    let matchedCandidate: GatewayAuthCandidate<TUser, TVault> | null = null;
    if (verificationCache) {
      const cached = verificationCache.get(keyHash);
      if (cached) {
        matchedCandidate = cached as GatewayAuthCandidate<TUser, TVault>;
      }
    }

    if (!matchedCandidate) {
      const prefix = extracted.apiKey.slice(0, API_KEY_PREFIX_LENGTH);
      const candidates = await options.getApiKeyCandidates(prefix, req);
      if (candidates.length === 0) {
        recordApiKeyLookup('miss');
        handleUnauthorized(next, 'Unauthorized: API key not found');
        return;
      }

      for (const candidate of candidates) {
        if (matchesStoredHash(extracted.apiKey, candidate.apiKeyRecord.keyHash)) {
          matchedCandidate = candidate;
          break;
        }
      }
    }

    if (!matchedCandidate) {
      recordApiKeyLookup('miss');
      handleUnauthorized(next, 'Unauthorized: invalid API key');
      return;
    }

    if (matchedCandidate.apiKeyRecord.revoked) {
      // The key exists but was explicitly revoked by the developer.
      // Evict from the cache immediately so a revoked candidate can never
      // be served from the fast path.
      verificationCache?.invalidate(keyHash);
      recordApiKeyLookup('revoked');
      handleForbidden(next, 'Unauthorized: API key has been revoked');
      return;
    }

    if (matchedCandidate.apiKeyRecord.expiresAt) {
      const expiresAt = new Date(matchedCandidate.apiKeyRecord.expiresAt);
      if (expiresAt.getTime() < Date.now()) {
        // The key exists but its expiration timestamp has passed.
        verificationCache?.invalidate(keyHash);
        recordApiKeyLookup('expired');
        handleUnauthorized(next, 'Unauthorized: API key has expired');
        return;
      }
    }

    if (!matchedCandidate.user || matchedCandidate.vault === undefined) {
      recordApiKeyLookup('miss');
      handleUnauthorized(next, 'Unauthorized: API key context is incomplete');
      return;
    }

    if (String(matchedCandidate.apiKeyRecord.apid) !== options.getApiId(resolvedContext.api)) {
      recordApiKeyLookup('miss');
      handleUnauthorized(next, 'Unauthorized: API key does not grant access to this API');
      return;
    }

    if (options.requiredScope) {
      const keyScopes = matchedCandidate.apiKeyRecord.scopes ?? [];
      const effectiveScopes = keyScopes.length === 0 ? ['read'] : keyScopes;
      if (!effectiveScopes.includes('*') && !effectiveScopes.includes(options.requiredScope)) {
        handleForbidden(next, 'Forbidden: API key lacks required scope');
        return;
      }
    }

    // Only cache successful verifications after all checks passed.
    if (verificationCache) {
      verificationCache.set(keyHash, matchedCandidate);
    }

    req.apiKeyValue = extracted.apiKey;
    req.apiKeyRecord = matchedCandidate.apiKeyRecord as unknown as Record<string, unknown>;
    req.user = matchedCandidate.user as Record<string, unknown>;
    req.vault = matchedCandidate.vault as Record<string, unknown> | null;
    req.api = resolvedContext.api as Record<string, unknown>;
    req.endpoint = resolvedContext.endpoint as Record<string, unknown>;

    res.locals = res.locals || {};
    res.locals.apiKeyTier = matchedCandidate.apiKeyRecord.tier;

    next();
  };
}

export function createMapBackedGatewayApiKeyAuthMiddleware<
  TApi = Record<string, unknown>,
  TEndpoint = Record<string, unknown>,
>(
  options: Omit<GatewayApiKeyAuthMiddlewareOptions<TApi, TEndpoint>, 'getApiKeyCandidates'> & {
    apiKeys?: Map<string, InMemoryGatewayApiKey>;
  },
): RequestHandler {
  return createGatewayApiKeyAuthMiddleware({
    ...options,
    async getApiKeyCandidates(prefix: string) {
      const apiKeys = options.apiKeys ?? new Map<string, InMemoryGatewayApiKey>();

      return Array.from(apiKeys.entries())
        .filter(([rawKey]) => rawKey.startsWith(prefix))
        .map(([rawKey, record]) => ({
          apiKeyRecord: {
            id: record.key,
            userId: record.developerId,
            apiId: record.apiId,
            prefix: rawKey.slice(0, API_KEY_PREFIX_LENGTH),
            keyHash: sha256Hex(rawKey),
            revoked: record.revoked ?? false,
            scopes: record.scopes,
            tier: record.tier,
          },
          user: { id: record.developerId },
          vault: null,
        }));
    },
  });
}

export function createDatabaseGatewayApiKeyAuthMiddleware<
  TApi = Record<string, unknown>,
  TEndpoint = Record<string, unknown>,
>(
  options: Omit<GatewayApiKeyAuthMiddlewareOptions<TApi, TEndpoint>, 'getApiKeyCandidates'> & {
    db: GatewayAuthQueryable;
    vaultNetwork?: string | ((req: Request) => string | null | undefined);
  },
): RequestHandler {
  return createGatewayApiKeyAuthMiddleware({
    ...options,
    async getApiKeyCandidates(prefix: string, req: Request) {
      const network =
        typeof options.vaultNetwork === 'function'
          ? options.vaultNetworkhreq)
          : options.vaultNetwork;

      const result = await options.db.query<DatabaseGatewayApiKeyRow>(
        `
          SELECT
            ak.id AS api_key_id,
            ak.user_id,
            ak.api_id,
            ak.prefix,
            ak.key_hash,
            COALESCE(ak.revoked, FALSE) AS revoked,
            ak.scopes,
            ak.rate_limit_per_minute,
            ak.created_at,
            ak.last_used_at,
            ak.plan_tier,
            row_to_json(u) AS "user",
            row_to_json(v) AS vault
          FROM api_keys ak
          JOIN users u ON u.id = ak.user_id
          LEFT JOIN LATERAL (
            SELECT *
            FROM vaults v
            WHERE v.user_id = ak.user_id
              AND ($2::text IS NULL OR v.network = $2::text)
            ORDER BY
              CASE WHEN $2::text IS NOT NULL AND v.network = $2::text THEN 0 ELSE 1 END,
              v.id ASC
            LIMIT 1
          ) v ON TRUE
          WHERE ak.prefix = $1
        `,
        [prefix, network ?? null],
      );

      return result.rows.map((row) => ({
        apiKeyRecord: {
          id: String(row.api_key_id),
          userId: String(row.user_id),
          apiId: String(row.api_id),
          prefix: row.prefix,
          keyHash: row.key_hash,
          revoked: row.revoked,
          scopes: row.scopes ?? [],
          rateLimitPerMinute: row.rate_limit_per_minute,
          createdAt: row.created_at ?? undefined,
          lastUsedAt: row.last_used_at ?? undefined,
          tier: row.plan_tier ?? undefined,
        },
        user: row.user ?? {},
        vault: row.vault,
      }));
    },
  });
}
