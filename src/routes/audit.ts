import { Router, Request, Response } from 'express';
import { auditService } from '../index.js';

const router = Router();

router.get('/', (req: Request, res: Response) => {
  const actorUserId = parseOptionalNumber(req.query.user_id);
  const action = parseAction(req.query.action);
  const resource =
    typeof req.query.resource === 'string' ? req.query.resource : undefined;

  const logs = auditService.list({ actorUserId, action, resource });

  res.json({ logs });
});

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

function parseAction(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const allowedActions = new Set([
    'user.login',
    'api_key.create',
    'api_key.revoke',
    'api.publish',
    'api.update',
    'settlement.run'
  ]);

  return allowedActions.has(value)
    ? value
    : undefined;
}

export default router;
