import { MemoryForwardedIdentityReplayStore, PostgresForwardedIdentityReplayStore, getForwardedIdentityReplayStore } from "./forwardedIdentityReplayStore.js";

test("bounded memory evicts expired records, never live records", async () => {
  const store = new MemoryForwardedIdentityReplayStore(2);
  expect(await store.claim("a", 100, 0)).toBe(true);
  expect(await store.claim("b", 20, 0)).toBe(true);
  expect(await store.claim("a", 1000, 1)).toBe(false);
  await expect(store.claim("c", 200, 20)).rejects.toThrow("capacity");
  expect(await store.claim("c", 200, 21)).toBe(true);
  expect(await store.claim("a", 100, 100)).toBe(false);
  expect(await store.claim("a", 200, 101)).toBe(true);
});
test("postgres uses parameterized primary-store claims and checks RETURNING", async () => {
  const query = jest.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ signature: "abc" }] })
    .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
  const store = new PostgresForwardedIdentityReplayStore(query);
  expect(await store.claim("abc", 2000, 1000)).toBe(true);
  expect(await store.claim("abc", 2000, 1000)).toBe(false);
  expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining("ON CONFLICT (signature)"), ["abc", new Date(2000), new Date(1000)]);
});
test("postgres failures propagate without accepting a claim", async () => {
  const store = new PostgresForwardedIdentityReplayStore(jest.fn().mockRejectedValue(new Error("offline")));
  await expect(store.claim("a", 2000, 1000)).rejects.toThrow("offline");
});
test("store selection is cached, configured and rejects invalid values", () => {
  const original = { ...process.env };
  try {
    process.env.FORWARDED_IDENTITY_REPLAY_STORE = "postgres";
    expect(getForwardedIdentityReplayStore()).toBeInstanceOf(PostgresForwardedIdentityReplayStore);
    expect(getForwardedIdentityReplayStore()).toBe(getForwardedIdentityReplayStore());
    process.env.FORWARDED_IDENTITY_REPLAY_STORE = "invalid";
    expect(() => getForwardedIdentityReplayStore()).toThrow();
    process.env.FORWARDED_IDENTITY_REPLAY_STORE = "memory";
    expect(getForwardedIdentityReplayStore()).toBeInstanceOf(MemoryForwardedIdentityReplayStore);
  } finally { process.env = original; }
});


test("configured postgres store uses the existing primary query helper", async () => {
  const original = { ...process.env };
  const query = jest.fn().mockResolvedValue({ rows: [{ signature: "a" }] });
  jest.doMock("../db.js", () => ({ query }));
  try {
    process.env.FORWARDED_IDENTITY_REPLAY_STORE = "postgres";
    expect(await getForwardedIdentityReplayStore().claim("a", 2000, 1000)).toBe(true);
    expect(query).toHaveBeenCalledTimes(2);
  } finally { process.env = original; jest.dontMock("../db.js"); }
});
