import { ApiRegistry, ApiRegistryEntry, EndpointPricing } from '../types/gateway.js';

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
    this.byId.set(entry.id, entry);
    this.bySlug.set(entry.slug, entry);
  }

  resolve(slugOrId: string): ApiRegistryEntry | undefined {
    return this.byId.get(slugOrId) ?? this.bySlug.get(slugOrId);
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
  // Normalize: strip leading slash for comparison
  const normalised = path.startsWith('/') ? path : `/${path}`;

  // Try exact prefix match (longest first)
  const sorted = [...endpoints]
    .filter((e) => e.path !== '*')
    .sort((a, b) => b.path.length - a.path.length);

  for (const ep of sorted) {
    const epPath = ep.path.startsWith('/') ? ep.path : `/${ep.path}`;
    if (normalised.startsWith(epPath)) {
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

const SEED_ENTRIES: ApiRegistryEntry[] = [
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

export function createApiRegistry(
  entries: ApiRegistryEntry[] = SEED_ENTRIES,
): InMemoryApiRegistry {
  return new InMemoryApiRegistry(entries);
}
