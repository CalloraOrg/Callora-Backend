import { Router, Request, Response } from 'express';
import { requireAuth, type AuthenticatedLocals } from '../middleware/requireAuth.js';
import { getSettlements, getRevenueSummary } from '../data/developerData.js';
import { DeveloperRevenueResponse } from '../types/developer.js';

const router = Router();

/**
 * GET /api/developers/revenue
 *
 * Returns the authenticated developer's revenue summary and
 * a paginated list of settlements.
 *
 * Query params:
 *   limit  – number of settlements to return (default 20, max 100)
 *   offset – pagination offset (default 0)
 */
router.get('/revenue', requireAuth, (req: Request, res: Response<unknown, AuthenticatedLocals>) => {
  const user = res.locals.authenticatedUser;
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const developerId = user.id;

  // Parse & clamp query params
  let limit = parseInt(req.query.limit as string, 10);
  if (isNaN(limit) || limit < 1) limit = 20;
  if (limit > 100) limit = 100;

  let offset = parseInt(req.query.offset as string, 10);
  if (isNaN(offset) || offset < 0) offset = 0;

  const summary = getRevenueSummary(developerId);
  const { settlements, total } = getSettlements(developerId, limit, offset);

  const body: DeveloperRevenueResponse = {
    summary,
    settlements,
    pagination: { limit, offset, total },
  };

  res.json(body);
});

export default router;
