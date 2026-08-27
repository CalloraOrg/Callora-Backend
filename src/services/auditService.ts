import { v4 as uuidv4 } from "uuid";
import { writeQuery } from "../db.js";
import {
  computeAuditIntegrityHash,
  redactPrivilegedValue,
} from "./tamperEvidentAudit.js";

export interface AuditRowInput {
  actor: string;
  action: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  tenantId?: string | null;
  correlationId?: string | null;
  clientIp?: string | null;
  userAgent?: string | null;
  bodyHash?: string | null;
  target?: string | null;
  outcome?: "success" | "failure";
}

export interface AuditRow extends AuditRowInput {
  id: string;
  createdAt: string;
}

function sanitizeWebhookConfig(
  config: Record<string, unknown>,
): Record<string, unknown> {
  return redactPrivilegedValue(config) as Record<string, unknown>;
}

export async function appendAuditRow(input: AuditRowInput): Promise<AuditRow> {
  const id = uuidv4();
  const now = new Date().toISOString();

  const details: Record<string, unknown> = {};

  if (input.before !== null && input.before !== undefined) {
    details.before = sanitizeWebhookConfig(input.before);
  }

  if (input.after !== null && input.after !== undefined) {
    details.after = sanitizeWebhookConfig(input.after);
  }

  if (input.tenantId) {
    details.tenantId = input.tenantId;
  }

  if (input.clientIp) {
    details.clientIp = input.clientIp;
  }

  if (input.userAgent) {
    details.userAgent = input.userAgent;
  }

  if (input.bodyHash) {
    details.bodyHash = input.bodyHash;
  }

  if (input.correlationId) {
    details.correlationId = input.correlationId;
  }

  const target = input.target ?? null;
  const outcome = input.outcome ?? "success";

  const result = await writeQuery<{
    sequence_no: number;
    previous_hash: string;
    integrity_hash: string;
  }>(
    `
      WITH audit_lock AS (
        SELECT pg_advisory_xact_lock(hashtext('callora:audit_logs'))
      ), previous AS (
        SELECT COALESCE(
          (SELECT integrity_hash FROM audit_logs ORDER BY sequence_no DESC LIMIT 1),
          'GENESIS'
        ) AS previous_hash
        FROM audit_lock
      ), inserted AS (
        INSERT INTO audit_logs (
          id, event, actor, tenant_id, client_ip, user_agent, correlation_id,
          body_hash, details, created_at, target, outcome, previous_hash,
          integrity_hash
        )
        SELECT
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
          previous.previous_hash,
          encode(digest(concat_ws('|', $1, $2, $3, COALESCE($4, ''),
            COALESCE($11, ''), $12, COALESCE($7, ''), COALESCE($9, ''),
            $10, previous.previous_hash), 'sha256'), 'hex')
        FROM previous
        RETURNING sequence_no, previous_hash, integrity_hash
      )
      SELECT sequence_no, previous_hash, integrity_hash FROM inserted
    `,
    [
      id,
      input.action,
      input.actor,
      input.tenantId ?? null,
      input.clientIp ?? null,
      input.userAgent ?? null,
      input.correlationId ?? null,
      input.bodyHash ?? null,
      JSON.stringify(details),
      now,
      target,
      outcome,
    ],
  );

  const inserted = result.rows[0];
  const previousHash = inserted?.previous_hash ?? "GENESIS";
  const sequenceNo = inserted?.sequence_no ?? 0;
  const integrityHash =
    inserted?.integrity_hash ??
    computeAuditIntegrityHash(
      {
        id,
        event: input.action,
        actor: input.actor,
        tenantId: input.tenantId ?? null,
        target,
        outcome,
        correlationId: input.correlationId ?? null,
        details,
        createdAt: now,
      },
      previousHash,
    );

  return {
    id,
    createdAt: now,
    actor: input.actor,
    action: input.action,
    before: input.before,
    after: input.after,
    tenantId: input.tenantId ?? null,
    correlationId: input.correlationId ?? null,
    clientIp: input.clientIp ?? null,
    userAgent: input.userAgent ?? null,
    bodyHash: input.bodyHash ?? null,
    target,
    outcome,
    sequenceNo,
    previousHash,
    integrityHash,
  };
}
