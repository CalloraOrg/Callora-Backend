import express from 'express';
import { AuditAction, AuditService } from './audit.js';

const app = express();
const PORT = process.env.PORT ?? 3000;

export const auditService = new AuditService();

app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'callora-backend' });
});

app.get('/api/apis', (_req, res) => {
  res.json({ apis: [] });
});

app.get('/api/usage', (_req, res) => {
  res.json({ calls: 0, period: 'current' });
});

app.get('/api/audit-logs', (req, res) => {
  const actorUserId = parseOptionalNumber(req.query.user_id);
  const action = parseAction(req.query.action);
  const resource =
    typeof req.query.resource === 'string' ? req.query.resource : undefined;

  const logs = auditService.list({ actorUserId, action, resource });

  res.json({ logs });
});

app.post('/api/auth/login', (req, res) => {
  const actorUserId = parseRequiredUserId(req.body?.user_id);

  if (actorUserId === null) {
    res.status(400).json({ error: 'user_id must be a positive integer' });
    return;
  }

  const entry = recordAudit(req, {
    actorUserId,
    action: 'user.login',
    resource: 'auth/session'
  });

  res.status(200).json({ ok: true, audit_log_id: entry.id });
});

app.post('/api/keys', (req, res) => {
  const actorUserId = parseRequiredUserId(req.body?.user_id);
  const apiId = parseRequiredUserId(req.body?.api_id);

  if (actorUserId === null || apiId === null) {
    res
      .status(400)
      .json({ error: 'user_id and api_id must be positive integers' });
    return;
  }

  const providedPrefix =
    typeof req.body?.prefix === 'string' ? req.body.prefix : undefined;
  const prefix = sanitizePrefix(providedPrefix);

  const entry = recordAudit(req, {
    actorUserId,
    action: 'api_key.create',
    resource: `api_key:${apiId}:${prefix}`
  });

  res.status(201).json({ ok: true, api_id: apiId, key_prefix: prefix, audit_log_id: entry.id });
});

app.post('/api/keys/:apiId/revoke', (req, res) => {
  const actorUserId = parseRequiredUserId(req.body?.user_id);
  const apiId = parseRequiredUserId(req.params.apiId);

  if (actorUserId === null || apiId === null) {
    res
      .status(400)
      .json({ error: 'user_id and apiId must be positive integers' });
    return;
  }

  const providedPrefix =
    typeof req.body?.prefix === 'string' ? req.body.prefix : undefined;
  const prefix = sanitizePrefix(providedPrefix);

  const entry = recordAudit(req, {
    actorUserId,
    action: 'api_key.revoke',
    resource: `api_key:${apiId}:${prefix}`
  });

  res.status(200).json({ ok: true, api_id: apiId, key_prefix: prefix, audit_log_id: entry.id });
});

app.post('/api/apis/:apiId/publish', (req, res) => {
  const actorUserId = parseRequiredUserId(req.body?.user_id);
  const apiId = parseRequiredUserId(req.params.apiId);

  if (actorUserId === null || apiId === null) {
    res
      .status(400)
      .json({ error: 'user_id and apiId must be positive integers' });
    return;
  }

  const entry = recordAudit(req, {
    actorUserId,
    action: 'api.publish',
    resource: `api:${apiId}`
  });

  res.status(200).json({ ok: true, api_id: apiId, audit_log_id: entry.id });
});

app.put('/api/apis/:apiId', (req, res) => {
  const actorUserId = parseRequiredUserId(req.body?.user_id);
  const apiId = parseRequiredUserId(req.params.apiId);

  if (actorUserId === null || apiId === null) {
    res
      .status(400)
      .json({ error: 'user_id and apiId must be positive integers' });
    return;
  }

  const entry = recordAudit(req, {
    actorUserId,
    action: 'api.update',
    resource: `api:${apiId}`
  });

  res.status(200).json({ ok: true, api_id: apiId, audit_log_id: entry.id });
});

app.post('/api/settlements/run', (req, res) => {
  const actorUserId = parseRequiredUserId(req.body?.user_id);

  if (actorUserId === null) {
    res.status(400).json({ error: 'user_id must be a positive integer' });
    return;
  }

  const runId =
    typeof req.body?.run_id === 'string' && req.body.run_id.trim().length > 0
      ? req.body.run_id.trim()
      : 'manual';

  const entry = recordAudit(req, {
    actorUserId,
    action: 'settlement.run',
    resource: `settlement:${runId}`
  });

  res.status(200).json({ ok: true, run_id: runId, audit_log_id: entry.id });
});

function recordAudit(
  req: express.Request,
  event: { actorUserId: number; action: AuditAction; resource: string }
) {
  return auditService.record({
    actorUserId: event.actorUserId,
    action: event.action,
    resource: event.resource,
    ip: getRequestIp(req)
  });
}

function parseRequiredUserId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return parsed > 0 ? parsed : null;
  }

  return null;
}

function parseOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'undefined') {
    return undefined;
  }

  const parsed = parseRequiredUserId(value);
  return parsed === null ? undefined : parsed;
}

function parseAction(value: unknown): AuditAction | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const allowedActions = new Set<AuditAction>([
    'user.login',
    'api_key.create',
    'api_key.revoke',
    'api.publish',
    'api.update',
    'settlement.run'
  ]);

  return allowedActions.has(value as AuditAction)
    ? (value as AuditAction)
    : undefined;
}

function sanitizePrefix(prefix: string | undefined): string {
  if (!prefix) {
    return 'unknown';
  }

  const normalized = prefix.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16);
  return normalized.length > 0 ? normalized : 'unknown';
}

function getRequestIp(req: express.Request): string | undefined {
  const forwarded = req.header('x-forwarded-for');
  if (typeof forwarded === 'string' && forwarded.trim().length > 0) {
    return forwarded.split(',')[0].trim();
  }

  if (req.ip && req.ip.trim().length > 0) {
    return req.ip;
  }

  return undefined;
}

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`Callora backend listening on http://localhost:${PORT}`);
  });
}

export default app;
