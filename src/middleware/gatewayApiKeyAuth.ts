import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';

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
  onUnauthorized?: (res: Response, message: string) => void;
  onNotFound?: (res: Response, message: string) => void;
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
  user: Record<string, unknown> | null;
  vault: Record<string, unknown> | null;
}

const SHA256_HEX_LENGTH = 64;

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

function unauthorized(res: Response, message: string): void {
  res.status(401).json({ error: message });
}

function notFound(res: Response, message: string): void {
  res.status(404).json({ error: message });
}

function forbidden(res: Response, message: string): void {
  res.status(403).json({ error: message });
}

export function extractApiKey(req: Request): ExtractedApiKey {
  const authorization = req.header('authorization');
  if (authorization) {
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (match && match[1].trim()) {
      return { apiKey: match[1].trim(), source: 'authorization' };
    }
  }

  const xApiKey = req.header('x-api-key');
  if (typeof xApiKey === 'string' && xApiKey.trim() !== '') {
    return { apiKey: xApiKey.trim(), source: 'x-api-key' };
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

export function createGatewayApiKeyAuthMiddleware<
  TApi = Record<string, unknown>,
  TEndpoint = Record<string, unknown>,
  TUser = Record<string, unknown>,
  TVault = Record<string, unknown> | null,
>(
  options: GatewayApiKeyAuthOptions<TApi, TEndpoint, TUser, TVault>,
): RequestHandler {
  const handleUnauthorized = options.onUnauthorized ?? unauthorized;
  const handleNotFound = options.onNotFound ?? notFound;
  const handleForbidden = forbidden;

  return async (req, res, next) => {
    const extracted = extractApiKey(req);
    if (!extracted.apiKey) {
      handleUnauthorized(res, extracted.error ?? 'Unauthorized: missing API key');
      return;
    }

    const resolvedContext = await options.resolveApiContext(req);
    if (!resolvedContext) {
      handleNotFound(res, 'Not Found: unknown API');
      return;
    }

    const prefix = extracted.apiKey.slice(0, API_KEY_PREFIX_LENGTH);
    const candidates = await options.getApiKeyCandidates(prefix, req);
    if (candidates.length === 0) {
      handleUnauthorized(res, 'Unauthorized: API key not found');
      return;
    }

    let matchedCandidate: GatewayAuthCandidate<TUser, TVault> | null = null;
    for (const candidate of candidates) {
      if (matchesStoredHash(extracted.apiKey, candidate.apiKeyRecord.keyHash)) {
        matchedCandidate = candidate;
        break;
      }
    }

    if (!matchedCandidate) {
      handleUnauthorized(res, 'Unauthorized: invalid API key');
      return;
    }

    if (matchedCandidate.apiKeyRecord.revoked) {
      handleForbidden(res, 'Unauthorized: API key has been revoked');
      return;
    }

    if (!matchedCandidate.user || matchedCandidate.vault === undefined) {
      handleUnauthorized(res, 'Unauthorized: API key context is incomplete');
      return;
    }

    if (String(matchedCandidate.apiKeyRecord.apiId) !== options.getApiId(resolvedContext.api)) {
      handleUnauthorized(res, 'Unauthorized: API key does not grant access to this API');
      return;
    }

    req.apiKeyValue = extracted.apiKey;
    req.apiKeyRecord = matchedCandidate.apiKeyRecord as unknown as Record<string, unknown>;
    req.user = matchedCandidate.user as Record<string, unknown>;
    req.vault = matchedCandidate.vault as Record<string, unknown> | null;
    req.api = resolvedContext.api as Record<string, unknown>;
    req.endpoint = resolvedContext.endpoint as Record<string, unknown>;

    next();
  };
}

export function createMapBackedGatewayApiKeyAuthMiddleware<
  TApi = Record<string, unknown>,
  TEndpoint = Record<string, unknown>,
>(
  options: Omit<GatewayApiKeyAuthOptions<TApi, TEndpoint>, 'getApiKeyCandidates'> & {
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
  options: Omit<GatewayApiKeyAuthOptions<TApi, TEndpoint>, 'getApiKeyCandidates'> & {
    db: GatewayAuthQueryable;
    vaultNetwork?: string | ((req: Request) => string | null | undefined);
  },
): RequestHandler {
  return createGatewayApiKeyAuthMiddleware({
    ...options,
    async getApiKeyCandidates(prefix: string, req: Request) {
      const network =
        typeof options.vaultNetwork === 'function'
          ? options.vaultNetwork(req)
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
        },
        user: row.user ?? {},
        vault: row.vault,
      }));
    },
  });
}
