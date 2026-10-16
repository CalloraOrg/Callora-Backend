import { ApiRegistry, ApiRegistryEntry, EndpointPricing, PaginatedApiList } from '../types/gateway.js';
import { validateUpstreamBaseUrl } from '../lib/upstreamTarget.js';
import { decodeCursor, encodeCursor } from '../lib/cursorPagination.js';
import { BadRequestError } from '../errors/index.js';

/**
 * In-memory API registry.
 * In production this would query a database table.
 */
export class InMemoryApiRegistry implements ApiRegistry {
  private byId = new Map<string, ApiRegistryEntry>();
  private bySlug = new Map<string, ApiRegistryEntry>();

  constructor(entries: ApiRegistryEntry[] = []) {
    for (const entry of entries) {
      this.register(entry);
    }
  }

  register(entry: ApiRegistryEntry): void {
    const normalizedEntry: ApiRegistryEntry = {
      ...entry,
      base_url: validateUpstreamBaseUrl(entry.base_url),
    };

    this.byId.set(normalizedEntry.id, normalizedEntry);
    this.bySlug.set(normalizedEntry.slug, normalizedEntry);
  }

  delete(slugOrId: string): boolean {
    const existing = this.byId.get(slugOrId) ?? this.bySlug.get(slugOrId);
    if (!existing) {
      return false;
    }
    this.byId.delete(existing.id);
    this.bySlug.delete(existing.slug);
    return true;
  }

  unregister(slugOrId: string): boolean {
    return this.delete(slugOrId);
  }

  resolve(slugOrId: string): ApiRegistryEntry | undefined {
    return this.byId.get(slugOrId) ?? this.bySlug.get(slugOrId);
  }

  list(cursor?: string | null, limit = 20): PaginatedApiList {
    // Collect all entries sorted by created_at (desc), then id (desc) for stability
    const sorted = [...this.byId.values()].sort((a, b) => {
      const aTime = a.created_at?.getTime() ?? 0;
      const bTime = b.created_at?.getTime() ?? 0;
      if (bTime !== aTime) return bTime - aTime;
      return b.id.localeCompare(a.id);
    });

    // If cursor is provided, advance to the first entry strictly after (timestamp, id)
    // in keyset order so deleting the cursor entry between calls never restarts pagination.
    let startIndex = 0;
    if (cursor !== undefined && cursor !== null && cursor !== '') {
      const decoded = decodeCursor(cursor);
      if (!decoded) {
        throw new BadRequestError('Invalid pagination cursor', 'INVALID_CURSOR');
      }
      const cursorTime = decoded.timestamp.getTime();
      const nextIndex = sorted.findIndex((e) => {
        const eTime = e.created_at?.getTime() ?? 0;
        if (eTime !== cursorTime) return eTime < cursorTime;
        return e.id.localeCompare(decoded.id) < 0;
      });
      startIndex = nextIndex === -1 ? sorted.length : nextIndex;
    }

    const page = sorted.slice(startIndex, startIndex + limit);

    // Compute next cursor from the last entry in the page
    let nextCursor: string | null = null;
    if (page.length === limit && startIndex + limit < sorted.length) {
      const lastEntry = page[page.length - 1];
      nextCursor = encodeCursor(
        lastEntry.created_at ?? new Date(0),
        lastEntry.id,
      );
    }

    return { entries: page, nextCursor };
  }
}

/**
 * Find the price for a given path in an API entry's endpoints.
 * Falls back to the wildcard "*" endpoint if no exact match, or 0 if none defined.
 */
export function resolveEndpointPrice(
  endpoints: EndpointPricing[],
  path: string,
): EndpointPricing {
  const ensureLeadingSlash = (value: string): string =>
    value.startsWith('/') ? value : `/${value}`;

  const normaliseSegmentPath = (value: string): string => {
    const withoutQuery = (value.split('?')[0] ?? '').trim();
    const withLeading = ensureLeadingSlash(withoutQuery);
    if (withLeading.length > 1) {
      return withLeading.replace(/\/+$/, '');
    }
    return withLeading;
  };

  const normalised = normaliseSegmentPath(path);

  // Try segment-aligned prefix match (longest segment path first, tie-broken by raw normalized length)
  const sorted = [...endpoints]
    .filter((e) => e.path !== '*')
    .sort((a, b) => {
      const segDiff =
        normaliseSegmentPath(b.path).length - normaliseSegmentPath(a.path).length;
      if (segDiff !== 0) {
        return segDiff;
      }
      return ensureLeadingSlash(b.path).length - ensureLeadingSlash(a.path).length;
    });

  for (const ep of sorted) {
    const epPath = normaliseSegmentPath(ep.path);
    if (epPath === '/') {
      if (normalised.startsWith('/')) {
        return ep;
      }
      continue;
    }
    if (normalised === epPath || normalised.startsWith(`${epPath}/`)) {
      return ep;
    }
  }

  // Fall back to wildcard
  const wildcard = endpoints.find((e) => e.path === '*');
  if (wildcard) return wildcard;

  // No pricing configured — default free
  return { endpointId: 'default', path: '*', priceUsdc: 0 };
}

// ── Mock data for development / testing ─────────────────────────────────────

const DEV_SEED_ENTRIES: ApiRegistryEntry[] = [
  {
    id: 'api_001',
    slug: 'weather-api',
    base_url: 'http://localhost:4000',
    developerId: 'dev_001',
    endpoints: [
      { endpointId: 'ep_weather_current', path: '/current', priceUsdc: 0.01 },
      { endpointId: 'ep_weather_forecast', path: '/forecast', priceUsdc: 0.05 },
      { endpointId: 'ep_weather_default', path: '*', priceUsdc: 0.005 },
    ],
  },
  {
    id: 'api_002',
    slug: 'translation-api',
    base_url: 'http://localhost:4001',
    developerId: 'dev_002',
    endpoints: [
      { endpointId: 'ep_translate', path: '/translate', priceUsdc: 0.02 },
      { endpointId: 'ep_translate_default', path: '*', priceUsdc: 0.01 },
    ],
  },
];

/**
 * Seed entries are only used outside of production. In production the
 * registry must be populated from a trusted source, and the upstream
 * allowlist must be provided explicitly via UPSTREAM_HOST_ALLOWLIST.
 */
const SEED_ENTRIES: ApiRegistryEntry[] =
  process.env.NODE_ENV === 'production' ? [] : DEV_SEED_ENTRIES;

export function createApiRegistry(
  entries: ApiRegistryEntry[] = SEED_ENTRIES,
): InMemoryApiRegistry {
  return new InMemoryApiRegistry(entries);
}
