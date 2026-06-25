/**
 * Tiered rate-limit policy tests (issue #389).
 *
 * Verifies that StoreBackedRateLimiter / InMemoryRateLimiter correctly
 * resolve per-tier ceilings (free/pro/enterprise), honour custom overrides,
 * and fall back to the default policy for unknown tiers.
 */

import {
  InMemoryRateLimiter,
  DEFAULT_TIER_POLICIES,
  type PlanTier,
  type TierPolicy,
} from './rateLimiter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Rapidly consume `n` tokens for a given key. */
async function consumeTokens(
  limiter: InMemoryRateLimiter,
  apiKey: string,
  n: number,
  tier?: string,
) {
  for (let i = 0; i < n; i++) {
    await limiter.check(apiKey, tier);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Tiered rate limiting', () => {
  const DEFAULT_MAX = 10; // low ceiling for faster tests
  const DEFAULT_WINDOW = 60_000;

  // ── Default tier ceilings ──────────────────────────────────────────────────

  it('uses the free-tier ceiling when tier="free"', async () => {
    const limiter = new InMemoryRateLimiter(DEFAULT_MAX, DEFAULT_WINDOW);
    const freeMax = DEFAULT_TIER_POLICIES.free.maxRequests;

    await consumeTokens(limiter, 'key-free', freeMax, 'free');

    const result = await limiter.check('key-free', 'free');
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('uses the pro-tier ceiling when tier="pro"', async () => {
    const limiter = new InMemoryRateLimiter(DEFAULT_MAX, DEFAULT_WINDOW);
    const proMax = DEFAULT_TIER_POLICIES.pro.maxRequests;

    // Exhaust free ceiling should still leave room in pro
    await consumeTokens(limiter, 'key-pro', DEFAULT_TIER_POLICIES.free.maxRequests, 'pro');

    const result = await limiter.check('key-pro', 'pro');
    expect(result.allowed).toBe(true);
  });

  it('uses the enterprise-tier ceiling when tier="enterprise"', async () => {
    const limiter = new InMemoryRateLimiter(DEFAULT_MAX, DEFAULT_WINDOW);
    const enterpriseMax = DEFAULT_TIER_POLICIES.enterprise.maxRequests;

    // Pro ceiling reached, but enterprise still has room
    await consumeTokens(limiter, 'key-ent', DEFAULT_TIER_POLICIES.pro.maxRequests, 'enterprise');

    const result = await limiter.check('key-ent', 'enterprise');
    expect(result.allowed).toBe(true);
  });

  // ── Default fallback (no tier) ─────────────────────────────────────────────

  it('falls back to the constructor default when no tier is provided', async () => {
    const limiter = new InMemoryRateLimiter(DEFAULT_MAX, DEFAULT_WINDOW);

    await consumeTokens(limiter, 'key-none', DEFAULT_MAX);

    const result = await limiter.check('key-none');
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('falls back to the constructor default for an unknown tier', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const limiter = new InMemoryRateLimiter(DEFAULT_MAX, DEFAULT_WINDOW);

    await consumeTokens(limiter, 'key-unknown', DEFAULT_MAX, 'platinum');

    const result = await limiter.check('key-unknown', 'platinum');
    expect(result.allowed).toBe(false);

    // A warning must have been emitted
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unknown tier "platinum"'),
    );

    warnSpy.mockRestore();
  });

  // ── Custom overrides ───────────────────────────────────────────────────────

  it('honours custom tier policy overrides', async () => {
    const customPolicies: Partial<Record<PlanTier, TierPolicy>> = {
      free: { maxRequests: 5, windowMs: 60_000 },
    };

    const limiter = new InMemoryRateLimiter(DEFAULT_MAX, DEFAULT_WINDOW, customPolicies);

    await consumeTokens(limiter, 'key-custom', 5, 'free');

    const result = await limiter.check('key-custom', 'free');
    expect(result.allowed).toBe(false);
  });

  it('preserves non-overridden tiers when custom policies are provided', async () => {
    const customPolicies: Partial<Record<PlanTier, TierPolicy>> = {
      free: { maxRequests: 5, windowMs: 60_000 },
    };

    const limiter = new InMemoryRateLimiter(DEFAULT_MAX, DEFAULT_WINDOW, customPolicies);

    // Pro should still use the default 500
    await consumeTokens(limiter, 'key-pro-default', 100, 'pro');

    const result = await limiter.check('key-pro-default', 'pro');
    expect(result.allowed).toBe(true);
  });

  // ── Allowed response shape ─────────────────────────────────────────────────

  it('returns the correct shape on allowed requests', async () => {
    const limiter = new InMemoryRateLimiter(DEFAULT_MAX, DEFAULT_WINDOW);

    const result = await limiter.check('key-shape', 'free');

    expect(result.allowed).toBe(true);
    // retryAfterMs should be 0 or absent when allowed
    expect(result.retryAfterMs ?? 0).toBe(0);
  });

  // ── Buckets are per-key, not per-tier ──────────────────────────────────────

  it('tracks rate-limit buckets per API key, not per tier', async () => {
    const limiter = new InMemoryRateLimiter(DEFAULT_MAX, DEFAULT_WINDOW);

    // Exhaust key-a under free
    await consumeTokens(limiter, 'key-a', DEFAULT_TIER_POLICIES.free.maxRequests, 'free');
    const resultA = await limiter.check('key-a', 'free');
    expect(resultA.allowed).toBe(false);

    // key-b under the same tier should still have tokens
    const resultB = await limiter.check('key-b', 'free');
    expect(resultB.allowed).toBe(true);
  });
});
