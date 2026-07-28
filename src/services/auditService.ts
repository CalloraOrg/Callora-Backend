import { v4 as uuidv4 } from 'uuid';
import { writeQuery } from '../db.js';

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
}

export interface AuditRow extends AuditRowInput {
  id: string;
  createdAt: string;
}

function maskSecret(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.length <= 8) return '****';
  return value.slice(0, 4) + '****' + value.slice(-4);
}

function sanitizeWebhookConfig(config: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (key === 'secret' || key === 'secret_current' || key === 'secret_previous') {
      sanitized[key] = maskSecret(typeof value === 'string' ? value : undefined);
    } else if (key === 'previous_expires_at' && value instanceof Date) {
      sanitized[key] = value.toISOString();
    } else if (typeof value === 'function') {
      sanitized[key] = '[Function]';
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
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

  await writeQuery(
    `
      INSERT INTO audit_logs (id, event, actor, tenant_id, client_ip, user_agent, correlation_id, body_hash, details, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
    ],
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
  };
}
