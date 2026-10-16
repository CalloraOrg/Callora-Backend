import { ApiRegistry, ApiRegistryEntry, EndpointPricing, PaginatedApiList } from '../types/gateway.js';
import { validateUpstreamBaseUrl } from '../lib/upstreamTarget.js';
import { decodeCursor, encodeCursor } from '../lib/cursorPagination.js';

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

  resolve(slugOrId: string): ApiRegistryEntry | undefined {
    return this.byId.get(slugOrId) ?? this.bySlug.get(slugOrId);
  }

  list(cursor?: string | null, limit = 20): PaginatedApiList {
    // Collect all entries sorted by created_at (desc), then id for stability
    const sorted = [...this.byId.values()].sort((a, b) => {
      const aTime = a.created_at?.getTime() ?? 0;
      const bTime = b.created_at?.getTime() ?? 0;
      if (bTime !== aTime) return bTime - aTime;
      return b.id.localeCompare(a.id);
    });

    // If cursor is provided, skip entries until we find the cursor position
    let startIndex = 0;
    if (cursor) {
      const decoded = decodeCursor(cursor);
      if (decoded) {
        startIndex = sorted.findIndex(
          (e) =>
            (e.created_at?.getTime() ?? 0) === decoded.timestamp.getTime() &&
            e.id === decoded.id,
        );
        if (startIndex === -1) startIndex = 0;
        else startIndex += 1; // skip past the cursor entry
      }
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
 * Find the price for a given path (and optional HTTP method) in an API entry's endpoints.
 * Prefers longer path prefix matches first, and for equal path specificity prefers
 * method-specific matches over method-agnostic ones.
 * Falls back to the wildcard "*" endpoint if no exact match, or 0 if none defined.
 */
export function resolveEndpointPrice(
  endpoints: EndpointPricing[],
  path: string,
  method?: string,
): EndpointPricing {
  const normalisePath = (value: string): string =>
    value.startsWith('/') ? value : `/${value}`;
  const normalised = normalisePath(path);
  const normalisedMethod = method?.trim().toUpperCase();

  const matchesMethod = (ep: EndpointPricing): boolean => {
    if (!ep.method) return true;
    if (!normalisedMethod) return false;
    return ep.method.trim().toUpperCase() === normalisedMethod;
  };

  const isExactMethodMatch = (ep: EndpointPricing): boolean =>
    Boolean(ep.method && normalisedMethod && ep.method.trim().toUpperCase() === normalisedMethod);

  // Try prefix matches (longest path first; method-specific before method-agnostic at equal length)
  const sorted = [...endpoints]
    .filter((e) => e.path !== '*' && matchesMethod(e))
    .sort((a, b) => {
      const lenDiff = normalisePath(b.path).length - normalisePath(a.path).length;
      if (lenDiff !== 0) return lenDiff;
      return Number(isExactMethodMatch(b)) - Number(isExactMethodMatch(a));
    });

  const applyMethodOverride = (ep: EndpointPricing): EndpointPricing => {
    if (!normalisedMethod || !ep.pricePerMethodUsdc) return ep;
    for (const [m, p] of Object.entries(ep.pricePerMethodUsdc)) {
      if (m.trim().toUpperCase() === normalisedMethod && typeof p === 'number') {
        return { ...ep, priceUsdc: p };
      }
    }
    return ep;
  };

  for (const ep of sorted) {
    const epPath = normalisePath(ep.path);
    if (normalised.startsWith(epPath)) {
      return applyMethodOverride(ep);
    }
  }

  // Fall back to wildcard (prefer method-specific wildcard over method-agnostic wildcard)
  if (normalisedMethod) {
    const methodWildcard = endpoints.find(
      (e) => e.path === '*' && isExactMethodMatch(e),
    );
    if (methodWildcard) return applyMethodOverride(methodWildcard);
  }
  const wildcard = endpoints.find((e) => e.path === '*' && !e.method);
  if (wildcard) return applyMethodOverride(wildcard);

  // No pricing configured — default free
  return { endpointId: 'default', path: '*', priceUsdc: 0 };
}

/**
 * Convert an ApiWithEndpoints record from apiRepository into an ApiRegistryEntry,
 * preserving each endpoint's HTTP method and price.
 */
export function toApiRegistryEntry(api: {
  id: number | string;
  name: string;
  base_url: string;
  developer_id: number | string;
  created_at?: Date;
  endpoints: Array<{
    id: number | string;
    path: string;
    method?: string | null;
    price_per_call_usdc: string | number;
  }>;
}): ApiRegistryEntry {
  const slug = api.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return {
    id: String(api.id),
    slug: slug || String(api.id),
    base_url: api.base_url,
    developerId: String(api.developer_id),
    ...(api.created_at ? { created_at: api.created_at } : {}),
    endpoints: api.endpoints.map((ep) => ({
      endpointId: String(ep.id),
      path: ep.path,
      ...(ep.method ? { method: ep.method.trim().toUpperCase() } : {}),
      priceUsdc: Number(ep.price_per_call_usdc),
    })),
  };
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
