import type { Request } from "express";
import crypto from "node:crypto";
import { resolveRequestUserId, signForwardedIdentity } from "./requireAuth.js";
import { getRateLimitKey } from "./rateLimit.js";
import { logger } from "../logger.js";
import { getForwardedIdentityReplayStore, MemoryForwardedIdentityReplayStore } from "../services/forwardedIdentityReplayStore.js";

const now = 1_800_000_000_000;
const secret = "forwarded-test-secret";
const original = { ...process.env };
let sequence = 0;
function signed(overrides: Partial<Parameters<typeof signForwardedIdentity>[0]> = {}) {
  const userId = `user-${++sequence}`;
  return { userId, ...signForwardedIdentity({ secret, method: "GET", path: "/api/usage", userId, now, ...overrides }) };
}
function req(headers: Record<string, string> = {}, method = "GET", path = "/api/usage"): Request {
  return { method, originalUrl: path, ip: "192.0.2.1", headers,
    header: (name: string) => headers[name], socket: { remoteAddress: "192.0.2.1" } } as unknown as Request;
}
function forwarded(s = signed(), method = "GET", path = "/api/usage") {
  return req({ "x-user-id": s.userId, "x-gateway-signature": s.signature, "x-gateway-timestamp": s.timestamp }, method, path);
}
beforeEach(() => {
  process.env.TRUST_FORWARDED_USER_ID = "true";
  process.env.FORWARDED_USER_ID_SECRET = secret;
  delete process.env.FORWARDED_IDENTITY_ALLOW_LEGACY;
  delete process.env.FORWARDED_IDENTITY_TOLERANCE_SECONDS;
  delete process.env.FORWARDED_IDENTITY_REPLAY_STORE;
  delete process.env.FORWARDED_IDENTITY_REPLAY_MAX_ENTRIES;
  jest.spyOn(Date, "now").mockReturnValue(now);
});
afterEach(() => { process.env = { ...original }; jest.restoreAllMocks(); });

test("canonical payload matches an independently constructed HMAC", () => {
  const result = signForwardedIdentity({ secret, method: "POST", path: "/api/a%2Fb?ignored=1", userId: "user", now });
  const digest = crypto.createHmac("sha256", secret).update("v1\n1800000000\nPOST\n/api/a%2Fb\nuser").digest("hex");
  expect(result).toEqual({ timestamp: "1800000000", signature: `v1=${digest}` });
});
test("accepts fresh identity and memoizes the same in-flight result for limiters", async () => {
  const s = signed(); const request = forwarded(s);
  const first = resolveRequestUserId(request);
  expect(resolveRequestUserId(request)).toBe(first);
  expect(await first).toEqual({ userId: s.userId });
  expect(await getRateLimitKey(request)).toBe(`user:${s.userId}`);
  expect((await resolveRequestUserId(forwarded(s))).error?.code).toBe("REPLAYED_FORWARDED_IDENTITY");
});
test("concurrent requests reserve the signature atomically", async () => {
  const s = signed(); const results = await Promise.all([resolveRequestUserId(forwarded(s)), resolveRequestUserId(forwarded(s))]);
  expect(results.filter(x => x.userId)).toHaveLength(1);
  expect(results.filter(x => x.error?.code === "REPLAYED_FORWARDED_IDENTITY")).toHaveLength(1);
});
test.each([-61, 61])("rejects clock skew of %i seconds", async skew => {
  const s = signed({ now: now + skew * 1000 });
  expect((await resolveRequestUserId(forwarded(s))).error?.code).toBe("STALE_FORWARDED_IDENTITY");
});
test.each([-60, 60])("accepts inclusive clock boundary %i", async skew => {
  const s = signed({ now: now + skew * 1000 });
  expect((await resolveRequestUserId(forwarded(s))).userId).toBe(s.userId);
});
test("retains a future signature until its last valid millisecond", async () => {
  const s = signed({ now: now + 60_000 });
  expect((await resolveRequestUserId(forwarded(s))).userId).toBe(s.userId);
  jest.spyOn(Date, "now").mockReturnValue(now + 120_999);
  expect((await resolveRequestUserId(forwarded(s))).error?.code).toBe("REPLAYED_FORWARDED_IDENTITY");
  jest.spyOn(Date, "now").mockReturnValue(now + 121_000);
  expect((await resolveRequestUserId(forwarded(s))).error?.code).toBe("STALE_FORWARDED_IDENTITY");
});
test.each(["", "abc", "1.5", "1e9", "-1", "+1800000000", "01800000000", "1800000000 ", "999999999999999999999"])("rejects malformed timestamp %s", async timestamp => {
  expect((await resolveRequestUserId(forwarded({ ...signed(), timestamp }))).error?.code).toBe("STALE_FORWARDED_IDENTITY");
});
test.each(["v1=xyz", "v1=", `v1=${"a".repeat(63)}`, `v1=${"a".repeat(66)}`, `v2=${"a".repeat(64)}`])("rejects malformed signature %s without throwing", async signature => {
  expect((await resolveRequestUserId(forwarded({ ...signed(), signature }))).error?.code).toBe("UNAUTHORIZED");
});
test.each([["POST", "/api/billing/deduct"], ["POST", "/api/usage"], ["GET", "/usage"], ["GET", "/api/usage/"]])("binds %s %s", async (method, path) => {
  expect((await resolveRequestUserId(forwarded(signed(), method, path))).error?.code).toBe("UNAUTHORIZED");
});
test("query is excluded, encoded original path is preserved", async () => {
  const s = signed({ path: "/api/a%2Fb" });
  expect((await resolveRequestUserId(forwarded(s, "GET", "/api/a%2Fb?x=1"))).userId).toBe(s.userId);
  expect((await resolveRequestUserId(forwarded(s, "GET", "/api/a/b"))).error).toBeDefined();
});
test("hex casing cannot bypass replay detection", async () => {
  const s = signed(); await resolveRequestUserId(forwarded(s));
  expect((await resolveRequestUserId(forwarded({ ...s, signature: `v1=${s.signature.slice(3).toUpperCase()}` }))).error?.code).toBe("REPLAYED_FORWARDED_IDENTITY");
});
test("ignores headers when trust is unset", async () => {
  delete process.env.TRUST_FORWARDED_USER_ID;
  expect(await resolveRequestUserId(forwarded())).toEqual({});
});
test("does not fall back from invalid JWT to a valid forwarded identity", async () => {
  const request = forwarded(); request.headers.authorization = "Basic invalid";
  expect((await resolveRequestUserId(request)).error?.code).toBe("INVALID_AUTH_HEADER");
});
test("rejects missing secret, signature and user", async () => {
  expect(await resolveRequestUserId(req())).toEqual({});
  expect((await resolveRequestUserId(req({ "x-user-id": "user" }))).error).toBeDefined();
  delete process.env.FORWARDED_USER_ID_SECRET; delete process.env.INTERNAL_GATEWAY_SECRET;
  expect((await resolveRequestUserId(forwarded())).error).toBeDefined();
});
test("legacy is disabled by default and allowed only outside production with explicit opt-in", async () => {
  const userId = `legacy-${++sequence}`;
  const signature = crypto.createHmac("sha256", secret).update(userId).digest("hex");
  const headers = { "x-user-id": userId, "x-internal-signature": `sha256=${signature}` };
  expect((await resolveRequestUserId(req(headers))).error?.code).toBe("UNAUTHORIZED");
  process.env.FORWARDED_IDENTITY_ALLOW_LEGACY = "true";
  expect((await resolveRequestUserId(req(headers))).userId).toBe(userId);
  process.env.NODE_ENV = "production";
  expect((await resolveRequestUserId(req(headers))).error?.code).toBe("UNAUTHORIZED");
});
test("honors configured timestamp tolerance", async () => {
  process.env.FORWARDED_IDENTITY_TOLERANCE_SECONDS = "10";
  expect((await resolveRequestUserId(forwarded(signed({ now: now - 11_000 })))).error?.code).toBe("STALE_FORWARDED_IDENTITY");
});
test("fails closed on store error, without logging signature", async () => {
  const s = signed(); const warning = jest.spyOn(logger, "warn");
  jest.spyOn(getForwardedIdentityReplayStore(), "claim").mockRejectedValueOnce(new Error("offline"));
  expect((await resolveRequestUserId(forwarded(s))).error?.code).toBe("UNAUTHORIZED");
  expect(JSON.stringify(warning.mock.calls)).not.toContain(s.signature.slice(3));
});
test.each([0, -1, 1.5, NaN])("rejects invalid memory capacity %s", capacity => {
  expect(() => new MemoryForwardedIdentityReplayStore(capacity)).toThrow();
});
