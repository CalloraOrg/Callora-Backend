# Tiered Rate Limits

> **Issue:** #389 — Tiered rate-limit policies driven by API key plan tier.

## Overview

API keys can now carry a **plan tier** (`free`, `pro`, or `enterprise`) that
determines the per-key rate-limit ceiling.  This replaces the previous
flat-rate approach where every key shared the same `maxRequests` value.

This service is one layer in the [combined rate-limit catalogue](./gateway-rate-limiting.md#combined-limiter-catalogue), which documents route order, user/IP/key identities, environment settings, storage sharing, outage behavior and response headers. A tier policy applies only when a caller supplies that tier to `check(apiKey, tier)`; it does not override the independent gateway-user or REST budgets.

## Default Tier Policies

| Tier         | Max Requests / min | Window |
|------------- |-------------------:|--------|
| `free`       |                100 | 60 s   |
| `pro`        |                500 | 60 s   |
| `enterprise` |              5 000 | 60 s   |

When a key has **no tier**, the limiter silently falls back to constructor-level defaults. An unrecognised nonempty tier uses the same fallback and emits a `console.warn`. The configured server defaults to `RATE_LIMIT_MAX_REQUESTS=5` and `RATE_LIMIT_WINDOW_MS=60000`; this fallback is distinct from the free-tier ceiling of 100. The service factory alone defaults to 100 when no constructor max is supplied.

## Database

Migration **0007** adds a `plan_tier` column to `api_keys`:

```sql
ALTER TABLE api_keys
  ADD COLUMN plan_tier VARCHAR(20) NOT NULL DEFAULT 'free'
  CHECK (plan_tier IN ('free', 'pro', 'enterprise'));
```

Rollback: `ALTER TABLE api_keys DROP COLUMN plan_tier;`

## How It Works

1. **Gateway middleware** (`gatewayApiKeyAuth.ts`) queries `ak.plan_tier` and
   maps it to `apiKeyRecord.tier`.  It also sets `res.locals.apiKeyTier` for
   downstream handlers.

2. **Proxy routes** call `rateLimiter.check(apiKeyRecord.id, res.locals.apiKeyTier)`. The legacy gateway calls `rateLimiter.check(rawApiKey)` **without a tier**, so it uses constructor defaults even for a key carrying a tier. The different key arguments also mean the two routes do not necessarily share a bucket for the same credential.

3. **`StoreBackedRateLimiter.resolvePolicy(tier)`** looks up the
   `TierPolicy` for the given tier.  If the tier is unknown it logs a
   warning and falls back to the constructor defaults.

The service resets its allowance as a whole after `windowMs`; it does not continuously refill like the gateway-user token bucket. `RATE_LIMIT_STORE=postgres` selects shared transactional storage for this service only. The other middleware retains process-local state; see the combined catalogue for outage controls and multi-instance limitations.

## Custom Overrides

Pass a partial `tierPolicies` map when constructing a limiter to override
individual tiers:

```typescript
import { createRateLimiter } from './services/rateLimiter.js';

const limiter = createRateLimiter(100, 60_000, {
  free: { maxRequests: 50, windowMs: 60_000 },   // tighter free tier
});
```

Or via `RateLimiterConfig.tierPolicies` when using `createConfiguredRateLimiter`.

## Testing

```bash
# Run all rate-limiter tests (existing + tiered)
npm test -- rateLimiter

# Run only the tiered suite
npm test -- rateLimiter.tiered.test.ts
```
