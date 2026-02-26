import { Router, Request, Response } from 'express';
import { auditService } from '../index.js';
import { AuditAction } from '../audit.js';

const router = Router();

function getRequestIp(req: Request): string | undefined {
    const forwarded = req.header('x-forwarded-for');
    if (typeof forwarded === 'string' && forwarded.trim().length > 0) {
        return forwarded.split(',')[0].trim();
    }

    if (req.ip && req.ip.trim().length > 0) {
        return req.ip;
    }

    return undefined;
}

function recordAudit(
    req: Request,
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

function sanitizePrefix(prefix: string | undefined): string {
    if (!prefix) {
        return 'unknown';
    }

    const normalized = prefix.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16);
    return normalized.length > 0 ? normalized : 'unknown';
}

router.post('/', (req: Request, res: Response) => {
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

router.post('/:apiId/revoke', (req: Request, res: Response) => {
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

export default router;
