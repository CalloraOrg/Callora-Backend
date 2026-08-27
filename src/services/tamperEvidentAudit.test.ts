import assert from "node:assert/strict";
import {
  InMemoryAuditRecordStore,
  canonicalAuditPayload,
  computeAuditIntegrityHash,
  redactPrivilegedValue,
  verifyAuditChain,
  type PrivilegedAuditRecord,
} from "./tamperEvidentAudit.js";

const makeRecord = (
  sequenceNo: number,
  previousHash: string,
  overrides: Partial<PrivilegedAuditRecord> = {},
): PrivilegedAuditRecord => {
  const base = {
    id: `audit-${sequenceNo}`,
    sequenceNo,
    event: "ADMIN_API_UPDATE",
    actor: "operator-1",
    tenantId: "tenant-a",
    target: "/api/admin/apis/api-1",
    outcome: "success" as const,
    correlationId: `request-${sequenceNo}`,
    details: { before: { enabled: false }, after: { enabled: true } },
    createdAt: `2026-08-27T10:0${sequenceNo}:00.000Z`,
    previousHash,
    integrityHash: "",
  };
  const record = { ...base, ...overrides };
  return {
    ...record,
    integrityHash:
      overrides.integrityHash ??
      computeAuditIntegrityHash(record, previousHash),
  };
};

describe("tamper-evident audit chain", () => {
  it("uses an explicit, deterministic canonical payload", () => {
    const record = makeRecord(1, "GENESIS");
    assert.equal(
      canonicalAuditPayload(record, "GENESIS"),
      [
        "audit-1",
        "ADMIN_API_UPDATE",
        "operator-1",
        "tenant-a",
        "/api/admin/apis/api-1",
        "success",
        "request-1",
        JSON.stringify(record.details),
        "2026-08-27T10:01:00.000Z",
        "GENESIS",
      ].join("|"),
    );
  });

  it("produces a stable SHA-256 digest for the same record", () => {
    const first = makeRecord(1, "GENESIS");
    const second = makeRecord(1, "GENESIS");
    assert.match(first.integrityHash, /^[a-f0-9]{64}$/);
    assert.equal(first.integrityHash, second.integrityHash);
  });

  it("changes the digest when actor, outcome, target, or details change", () => {
    const original = makeRecord(1, "GENESIS");
    for (const change of [
      { actor: "operator-2" },
      { outcome: "failure" as const },
      { target: "/api/admin/apis/api-2" },
      { details: { before: { enabled: true }, after: { enabled: false } } },
    ]) {
      const changed = { ...original, ...change };
      assert.notEqual(
        computeAuditIntegrityHash(changed, "GENESIS"),
        original.integrityHash,
      );
    }
  });

  it("accepts a valid multi-row chain", () => {
    const first = makeRecord(1, "GENESIS");
    const second = makeRecord(2, first.integrityHash);
    const third = makeRecord(3, second.integrityHash);

    assert.deepEqual(verifyAuditChain([third, first, second]), {
      valid: true,
      checked: 3,
      issues: [],
    });
  });

  it("detects a changed field even when the previous link is intact", () => {
    const first = makeRecord(1, "GENESIS");
    const second = makeRecord(2, first.integrityHash);
    const tampered = { ...second, actor: "attacker" };
    const result = verifyAuditChain([first, tampered]);

    assert.equal(result.valid, false);
    assert.equal(result.checked, 2);
    assert.equal(result.issues[0]?.reason, "integrity_hash_mismatch");
    assert.equal(result.issues[0]?.id, second.id);
  });

  it("detects a replaced predecessor through the next row link", () => {
    const first = makeRecord(1, "GENESIS");
    const second = makeRecord(2, first.integrityHash);
    const replacement = { ...first, actor: "attacker" };
    const result = verifyAuditChain([replacement, second]);

    assert.equal(result.valid, false);
    assert.ok(
      result.issues.some((issue) => issue.reason === "integrity_hash_mismatch"),
    );
  });

  it("detects missing sequence positions", () => {
    const first = makeRecord(1, "GENESIS");
    const third = makeRecord(3, first.integrityHash);
    const result = verifyAuditChain([first, third]);

    assert.equal(result.valid, false);
    assert.deepEqual(result.issues[0], {
      sequenceNo: 3,
      id: "audit-3",
      reason: "sequence_gap",
      expected: "2",
      actual: "3",
    });
  });

  it("reports an empty chain as valid without fabricating records", () => {
    assert.deepEqual(verifyAuditChain([]), {
      valid: true,
      checked: 0,
      issues: [],
    });
  });
});

describe("privileged audit redaction", () => {
  it("redacts secrets recursively while preserving safe context", () => {
    const input = {
      route: "/api/admin/keys",
      credentials: {
        apiKey: "live-key",
        nested: { refresh_token: "refresh-secret", label: "primary" },
      },
      before: [{ password: "old", enabled: false }],
    };
    assert.deepEqual(redactPrivilegedValue(input), {
      route: "/api/admin/keys",
      credentials: {
        apiKey: "[REDACTED]",
        nested: { refresh_token: "[REDACTED]", label: "primary" },
      },
      before: [{ password: "[REDACTED]", enabled: false }],
    });
  });

  it("does not mutate the source object during redaction", () => {
    const source = { after: { secret: "do-not-change", enabled: true } };
    const redacted = redactPrivilegedValue(source);
    assert.equal(source.after.secret, "do-not-change");
    assert.equal(
      (redacted as { after: { secret: string } }).after.secret,
      "[REDACTED]",
    );
  });

  it("handles circular operator details without throwing", () => {
    const source: { self?: unknown; token: string } = { token: "secret" };
    source.self = source;
    assert.deepEqual(redactPrivilegedValue(source), {
      token: "[REDACTED]",
      self: "[Circular]",
    });
  });
});

describe("append-only in-memory store", () => {
  it("accepts the first record at the genesis boundary", async () => {
    const store = new InMemoryAuditRecordStore();
    const first = makeRecord(1, "GENESIS");
    await store.append(first);
    assert.deepEqual(await store.list(), [first]);
  });

  it("requires every appended row to extend the chain", async () => {
    const store = new InMemoryAuditRecordStore();
    const first = makeRecord(1, "GENESIS");
    await store.append(first);
    await assert.rejects(
      store.append(makeRecord(3, first.integrityHash)),
      /does not extend/,
    );
    await assert.rejects(
      store.append(makeRecord(2, "wrong-predecessor")),
      /does not extend/,
    );
  });

  it("rejects duplicate IDs", async () => {
    const store = new InMemoryAuditRecordStore();
    const first = makeRecord(1, "GENESIS");
    await store.append(first);
    await assert.rejects(store.append(first), /id already exists/);
  });

  it("returns defensive copies so callers cannot rewrite stored rows", async () => {
    const store = new InMemoryAuditRecordStore();
    const first = makeRecord(1, "GENESIS");
    await store.append(first);
    const result = await store.list();
    result[0]!.details!.after = { enabled: false };
    const reread = await store.list();
    assert.deepEqual(reread[0]!.details!.after, { enabled: true });
  });

  it("filters records by tenant without leaking another tenant", async () => {
    const store = new InMemoryAuditRecordStore();
    const first = makeRecord(1, "GENESIS", { tenantId: "tenant-a" });
    const second = makeRecord(2, first.integrityHash, { tenantId: "tenant-b" });
    await store.append(first);
    await store.append(second);
    assert.deepEqual(
      (await store.list("tenant-a")).map((row) => row.id),
      ["audit-1"],
    );
    assert.deepEqual(
      (await store.list("tenant-b")).map((row) => row.id),
      ["audit-2"],
    );
    assert.deepEqual(
      (await store.list("tenant-c")).map((row) => row.id),
      [],
    );
  });
});
