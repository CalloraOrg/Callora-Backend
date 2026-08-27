import assert from "node:assert/strict";

jest.mock("../db.js", () => ({
  writeQuery: jest.fn(),
}));

import { writeQuery } from "../db.js";
import { appendAuditRow, type AuditRowInput } from "./auditService.js";

const mockWriteQuery = writeQuery as jest.MockedFunction<typeof writeQuery>;

beforeEach(() => {
  mockWriteQuery.mockResolvedValue({ rows: [] });
});

afterEach(() => {
  jest.clearAllMocks();
});

describe("appendAuditRow", () => {
  const baseInput: AuditRowInput = {
    actor: "dev-123",
    action: "WEBHOOK_REGISTERED",
    before: null,
    after: {
      developerId: "dev-123",
      url: "https://example.com",
      events: ["new_api_call"],
    },
  };

  it("inserts a row with all required fields", async () => {
    const result = await appendAuditRow(baseInput);

    assert.ok(result.id);
    assert.equal(result.actor, "dev-123");
    assert.equal(result.action, "WEBHOOK_REGISTERED");
    assert.ok(result.createdAt);
  });

  it("calls writeQuery with correct SQL and params", async () => {
    await appendAuditRow(baseInput);

    assert.equal(mockWriteQuery.mock.calls.length, 1);
    const call = mockWriteQuery.mock.calls[0]!;
    const sql = call[0] as string;
    const params = call![1];
    assert.ok(sql.includes("INSERT INTO audit_logs"));
    assert.equal(params[1]!, "WEBHOOK_REGISTERED");
    assert.equal(params[2]!, "dev-123");
  });

  it("includes tenantId when provided", async () => {
    await appendAuditRow({ ...baseInput, tenantId: "tenant-abc" });

    const call = mockWriteQuery.mock.calls[0]!;
    const params = call[1]!;
    assert.equal(params[3], "tenant-abc");
  });

  it("passes null for tenantId when not provided", async () => {
    await appendAuditRow(baseInput);

    const call = mockWriteQuery.mock.calls[0]!;
    const params = call[1]!;
    assert.equal(params[3], null);
  });

  it("includes correlationId when provided", async () => {
    await appendAuditRow({ ...baseInput, correlationId: "req-xyz" });

    const call = mockWriteQuery.mock.calls[0]!;
    const params = call[1]!;
    assert.equal(params[6], "req-xyz");
  });

  it("includes clientIp when provided", async () => {
    await appendAuditRow({ ...baseInput, clientIp: "192.168.1.1" });

    const call = mockWriteQuery.mock.calls[0]!;
    const params = call[1]!;
    assert.equal(params[4], "192.168.1.1");
  });

  it("includes userAgent when provided", async () => {
    await appendAuditRow({ ...baseInput, userAgent: "Mozilla/5.0" });

    const call = mockWriteQuery.mock.calls[0]!;
    const params = call[1]!;
    assert.equal(params[5], "Mozilla/5.0");
  });

  it("includes bodyHash when provided", async () => {
    await appendAuditRow({ ...baseInput, bodyHash: "abc123" });

    const call = mockWriteQuery.mock.calls[0]!;
    const params = call[1]!;
    assert.equal(params[7], "abc123");
  });

  it("serializes details JSON with before and after", async () => {
    await appendAuditRow(baseInput);

    const call = mockWriteQuery.mock.calls[0]!;
    const params = call[1]!;
    const details = JSON.parse(params[8] as string);
    assert.equal(details.before, undefined);
    assert.ok(details.after);
    assert.equal(details.after.developerId, "dev-123");
  });

  it("masks secret_current in before/after details", async () => {
    await appendAuditRow({
      ...baseInput,
      before: {
        secret_current: "sk_live_abc123def456",
        url: "https://example.com",
      },
      after: {
        secret_current: "sk_live_xyz789abc012",
        url: "https://example.com",
      },
    });

    const call = mockWriteQuery.mock.calls[0]!;
    const params = call[1]!;
    const details = JSON.parse(params[8] as string);
    assert.equal(details.before.secret_current, "[REDACTED]");
    assert.equal(details.after.secret_current, "[REDACTED]");
  });

  it("masks secret in before/after details", async () => {
    await appendAuditRow({
      ...baseInput,
      before: { secret: "sk_live_abc123def456" },
      after: { secret: "sk_live_xyz789abc012" },
    });

    const call = mockWriteQuery.mock.calls[0]!;
    const params = call[1]!;
    const details = JSON.parse(params[8] as string);
    assert.equal(details.before.secret, "[REDACTED]");
    assert.equal(details.after.secret, "[REDACTED]");
  });

  it("handles short secrets by masking entirely", async () => {
    await appendAuditRow({
      ...baseInput,
      before: { secret_current: "short" },
      after: { secret_current: "short" },
    });

    const call = mockWriteQuery.mock.calls[0]!;
    const params = call[1]!;
    const details = JSON.parse(params[8] as string);
    assert.equal(details.before.secret_current, "[REDACTED]");
    assert.equal(details.after.secret_current, "[REDACTED]");
  });

  it("returns the row with id, createdAt, and all input fields", async () => {
    const result = await appendAuditRow(baseInput);

    assert.ok(result.id);
    assert.ok(result.createdAt);
    assert.equal(result.actor, "dev-123");
    assert.equal(result.action, "WEBHOOK_REGISTERED");
    assert.equal(result.before, null);
    assert.deepEqual(result.after, {
      developerId: "dev-123",
      url: "https://example.com",
      events: ["new_api_call"],
    });
  });

  it("includes null fields when before and after are both null", async () => {
    await appendAuditRow({
      actor: "dev-123",
      action: "WEBHOOK_DELETED",
      before: null,
      after: null,
    });

    const call = mockWriteQuery.mock.calls[0]!;
    const params = call[1]!;
    const details = JSON.parse(params[8] as string);
    assert.equal(details.before, undefined);
    assert.equal(details.after, undefined);
  });
});
