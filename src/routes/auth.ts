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

router.post('/login', (req: Request, res: Response) => {
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

export default router;
