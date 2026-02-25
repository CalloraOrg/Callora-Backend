/** Represents a registered API key mapping to a developer and API. */
export interface ApiKey {
  key: string;
  developerId: string;
  apiId: string;
}

/** A single recorded usage event from a proxied request. */
export interface UsageEvent {
  id: string;
  requestId: string;
  apiKey: string;
  apiKeyId: string;
  apiId: string;
  endpointId: string;
  userId: string;         // developerId of the caller
  amountUsdc: number;     // endpoint price charged
  statusCode: number;
  timestamp: string;      // ISO-8601
  settlementId?: string;  // ID of the settlement batch if paid out
}

/** Result of a billing deduction attempt. */
export interface BillingResult {
  success: boolean;
  balance?: number;
}

/** Result of a rate-limit check. */
export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs?: number;
}

/** Pricing for a single endpoint within an API. */
export interface EndpointPricing {
  endpointId: string;
  /** Path pattern to match (e.g. "/data", "/translate"). Use "*" as default. */
  path: string;
  priceUsdc: number;
}

/** Interface for billing / credit deduction (e.g. Soroban). */
export interface BillingService {
  deductCredit(developerId: string, amount: number): Promise<BillingResult>;
  /** Check balance without deducting. */
  checkBalance(developerId: string): Promise<number>;
}

/** Interface for rate limiting. */
export interface RateLimiter {
  check(apiKey: string): RateLimitResult;
}

/** Interface for recording and querying usage events. */
export interface UsageStore {
  /** Record an event. Returns false if requestId already exists (idempotent). */
  record(event: UsageEvent): boolean;
  hasEvent(requestId: string): boolean;
  getEvents(apiKey?: string): UsageEvent[];
  getUnsettledEvents(): UsageEvent[];
  markAsSettled(eventIds: string[], settlementId: string): void;
}

/** A registered API with its upstream base URL and endpoint pricing. */
export interface ApiRegistryEntry {
  id: string;
  slug: string;
  base_url: string;
  developerId: string;
  endpoints: EndpointPricing[];
}

/** Registry for resolving API slugs / IDs to their upstream entries. */
export interface ApiRegistry {
  resolve(slugOrId: string): ApiRegistryEntry | undefined;
}

/** Configuration for proxy behaviour. */
export interface ProxyConfig {
  /** Upstream request timeout in milliseconds (default: 30000). */
  timeoutMs: number;
  /** Request headers to strip before forwarding to upstream. */
  stripHeaders: string[];
  /** Status code ranges to record metering for. Default: 2xx only. */
  recordableStatuses: (code: number) => boolean;
}

/** Dependencies injected into the gateway router factory. */
export interface GatewayDeps {
  billing: BillingService;
  rateLimiter: RateLimiter;
  usageStore: UsageStore;
  upstreamUrl: string;
  apiKeys: Map<string, ApiKey>;
}

/** Dependencies injected into the proxy router factory. */
export interface ProxyDeps {
  billing: BillingService;
  rateLimiter: RateLimiter;
  usageStore: UsageStore;
  registry: ApiRegistry;
  apiKeys: Map<string, ApiKey>;
  proxyConfig?: Partial<ProxyConfig>;
}
