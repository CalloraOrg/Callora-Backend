import { createRateLimiter } from "./rateLimiter.js";

describe("InMemoryRateLimiter", () => {
  beforeEach(() => {
    // Use modern fake timers so Date.now() and time advances are deterministic
    // cast to any to satisfy TS defs in this project
    jest.useFakeTimers("modern" as unknown as any);
    jest.setSystemTime(new Date("2026-03-30T00:00:00.000Z").getTime());
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("allows up to maxRequests then rejects until window elapses", () => {
    const maxRequests = 2;
    const windowMs = 1000;
    const rl = createRateLimiter(maxRequests, windowMs);
    const apiKey = "test-key";

    const r1 = rl.check(apiKey);
    expect(r1.allowed).toBe(true);

    const r2 = rl.check(apiKey);
    expect(r2.allowed).toBe(true);

    // third request should be rejected
    const r3 = rl.check(apiKey);
    expect(r3.allowed).toBe(false);
    expect(r3.retryAfterMs).toBe(windowMs);

    // advance time by less than window -> still rejected
    jest.advanceTimersByTime(500);
    const r4 = rl.check(apiKey);
    expect(r4.allowed).toBe(false);

    // advance to end of window -> tokens should be refilled
    jest.advanceTimersByTime(500);
    const r5 = rl.check(apiKey);
    expect(r5.allowed).toBe(true);
  });
});
