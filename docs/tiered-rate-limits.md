# Tiered Rate Limits

> **Issue:** #389 — Tiered rate-limit policies driven by API key plan tier.

## Overview

API keys can now carry a **plan tier** (`free`, `pro`, or `enterprise`) that
determines the per-key rate-limit ceiling.  This replaces the previous
flat-rate approach where every key shared the same `maxRequests` value.

## Default Tier Policies

| Tier         | Max Requests / min | Window |
|------------- |-------------------:|--------|
| `free`       |                100 | 60 s   |
| `pro`        |                500 | 60 s   |
| `enterprise` |              5 000 | 60 s   |

When a key has **no tier** (or the tier is not recognised), the limiter falls
back to the constructor-level defaults (typically the `free` ceiling) and emits
a `console.warn`.

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

2. **Proxy & gateway routes** pass the tier into `rateLimiter.check(apiKey, tier)`.

3. **`StoreBackedRateLimiter.resolvePolicy(tier)`** looks up the
   `TierPolicy` for the given tier.  If the tier is unknown it logs a
   warning and falls back to the constructor defaults.

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
