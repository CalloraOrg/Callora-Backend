import { createHash } from "node:crypto";

/** The fields that must be present on every privileged audit record. */
export interface PrivilegedAuditRecord {
  id: string;
  sequenceNo: number;
  event: string;
  actor: string;
  tenantId: string | null;
  target: string | null;
  outcome: "success" | "failure";
  correlationId: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
  previousHash: string;
  integrityHash: string;
}

export interface AuditChainIssue {
  sequenceNo: number;
  id: string;
  reason: "sequence_gap" | "previous_hash_mismatch" | "integrity_hash_mismatch";
  expected: string;
  actual: string;
}

export interface AuditChainVerification {
  valid: boolean;
  checked: number;
  issues: AuditChainIssue[];
}

/**
 * Keep the hash input deliberately explicit and stable. Changing field order
 * or encoding is a chain-format migration, not a harmless implementation
 * detail; the verifier and SQL writer must use the same representation.
 */
export function canonicalAuditPayload(
  record: Pick<
    PrivilegedAuditRecord,
    | "id"
    | "event"
    | "actor"
    | "tenantId"
    | "target"
    | "outcome"
    | "correlationId"
    | "details"
    | "createdAt"
  >,
  previousHash: string,
): string {
  return [
    record.id,
    record.event,
    record.actor,
    record.tenantId ?? "",
    record.target ?? "",
    record.outcome,
    record.correlationId ?? "",
    record.details === null ? "" : JSON.stringify(record.details),
    record.createdAt,
    previousHash,
  ].join("|");
}

export function computeAuditIntegrityHash(
  record: Pick<
    PrivilegedAuditRecord,
    | "id"
    | "event"
    | "actor"
    | "tenantId"
    | "target"
    | "outcome"
    | "correlationId"
    | "details"
    | "createdAt"
  >,
  previousHash: string,
): string {
  return createHash("sha256")
    .update(canonicalAuditPayload(record, previousHash), "utf8")
    .digest("hex");
}

/** Verify both links in the chain and return every detected discrepancy. */
export function verifyAuditChain(
  records: readonly PrivilegedAuditRecord[],
): AuditChainVerification {
  const issues: AuditChainIssue[] = [];
  const ordered = [...records].sort(
    (left, right) => left.sequenceNo - right.sequenceNo,
  );
  let previousHash = "GENESIS";
  let expectedSequence = ordered[0]?.sequenceNo ?? 1;

  for (const record of ordered) {
    if (record.sequenceNo !== expectedSequence) {
      issues.push({
        sequenceNo: record.sequenceNo,
        id: record.id,
        reason: "sequence_gap",
        expected: String(expectedSequence),
        actual: String(record.sequenceNo),
      });
    }

    if (record.previousHash !== previousHash) {
      issues.push({
        sequenceNo: record.sequenceNo,
        id: record.id,
        reason: "previous_hash_mismatch",
        expected: previousHash,
        actual: record.previousHash,
      });
    }

    const expectedHash = computeAuditIntegrityHash(record, record.previousHash);
    if (record.integrityHash !== expectedHash) {
      issues.push({
        sequenceNo: record.sequenceNo,
        id: record.id,
        reason: "integrity_hash_mismatch",
        expected: expectedHash,
        actual: record.integrityHash,
      });
    }

    previousHash = record.integrityHash;
    expectedSequence = record.sequenceNo + 1;
  }

  return { valid: issues.length === 0, checked: ordered.length, issues };
}

const SECRET_KEY =
  /(?:^|_)(?:secret|token|password|private[_-]?key|api[_-]?key)(?:$|_)/i;

/** Redact nested operator input before it enters details or logs. */
export function redactPrivilegedValue(
  value: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (value === null || value === undefined || typeof value !== "object")
    return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value))
    return value.map((entry) => redactPrivilegedValue(entry, seen));

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = key
      .replace(/([a-z])([A-Z])/g, "$1_$2")
      .replace(/[^a-zA-Z0-9_]/g, "_");
    if (SECRET_KEY.test(normalizedKey)) {
      output[key] = "[REDACTED]";
    } else {
      output[key] = redactPrivilegedValue(entry, seen);
    }
  }
  return output;
}

export interface AuditRecordStore {
  append(record: PrivilegedAuditRecord): Promise<void>;
  list(tenantId?: string | null): Promise<PrivilegedAuditRecord[]>;
}

/** Deterministic append-only store used by unit tests and local development. */
export class InMemoryAuditRecordStore implements AuditRecordStore {
  private readonly records: PrivilegedAuditRecord[] = [];

  private clone(record: PrivilegedAuditRecord): PrivilegedAuditRecord {
    return JSON.parse(JSON.stringify(record)) as PrivilegedAuditRecord;
  }

  async append(record: PrivilegedAuditRecord): Promise<void> {
    if (this.records.some((existing) => existing.id === record.id)) {
      throw new Error("audit record id already exists");
    }
    if (this.records.length > 0) {
      const last = this.records[this.records.length - 1]!;
      if (
        record.sequenceNo !== last.sequenceNo + 1 ||
        record.previousHash !== last.integrityHash
      ) {
        throw new Error("audit record does not extend the current chain");
      }
    }
    this.records.push(this.clone(record));
  }

  async list(tenantId?: string | null): Promise<PrivilegedAuditRecord[]> {
    return this.records
      .filter(
        (record) => tenantId === undefined || record.tenantId === tenantId,
      )
      .map((record) => this.clone(record));
  }
}
