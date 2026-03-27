import { Router } from 'express';
import { requireAuth, type AuthenticatedLocals } from '../middleware/requireAuth.js';
import { BillingService, type SorobanClient } from '../services/billing.js';
import { BadRequestError } from '../errors/index.js';
import type { Pool } from 'pg';

// Simple Soroban client implementation for billing deductions
class BillingSorobanClient implements SorobanClient {
  async deductBalance(userId: string, amount: string): Promise<string> {
    // In a real implementation, this would interact with the Stellar blockchain
    // For testing purposes, we return a mock transaction hash
    return `tx_billing_${userId}_${amount}_${Date.now()}`;
  }
}

const router = Router();

// POST /api/billing/deduct - Deduct balance for API usage
router.post('/deduct', requireAuth, async (
  req: express.Request,
  res: express.Response<unknown, AuthenticatedLocals>,
  next
) => {
  try {
    const user = res.locals.authenticatedUser;
    if (!user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { requestId, apiId, endpointId, apiKeyId, amountUsdc } = req.body as Record<string, unknown>;

    // Validate required fields
    if (!requestId || typeof requestId !== 'string' || requestId.trim() === '') {
      next(new BadRequestError('requestId is required and must be a non-empty string'));
      return;
    }

    if (!apiId || typeof apiId !== 'string' || apiId.trim() === '') {
      next(new BadRequestError('apiId is required and must be a non-empty string'));
      return;
    }

    if (!endpointId || typeof endpointId !== 'string' || endpointId.trim() === '') {
      next(new BadRequestError('endpointId is required and must be a non-empty string'));
      return;
    }

    if (!apiKeyId || typeof apiKeyId !== 'string' || apiKeyId.trim() === '') {
      next(new BadRequestError('apiKeyId is required and must be a non-empty string'));
      return;
    }

    if (!amountUsdc || typeof amountUsdc !== 'string') {
      next(new BadRequestError('amountUsdc is required and must be a string'));
      return;
    }

    // Validate amount is a valid positive number
    const amount = parseFloat(amountUsdc);
    if (isNaN(amount) || amount <= 0) {
      next(new BadRequestError('amountUsdc must be a positive number'));
      return;
    }

    // Get database pool from app locals (should be set in app.ts)
    const pool = req.app.locals.dbPool as Pool;
    if (!pool) {
      res.status(500).json({ error: 'Database not available' });
      return;
    }

    const sorobanClient = new BillingSorobanClient();
    const billingService = new BillingService(pool, sorobanClient);

    const result = await billingService.deduct({
      requestId: requestId.trim(),
      userId: user.id,
      apiId: apiId.trim(),
      endpointId: endpointId.trim(),
      apiKeyId: apiKeyId.trim(),
      amountUsdc: amountUsdc.trim(),
    });

    if (!result.success) {
      res.status(500).json({
        error: 'Billing deduction failed',
        details: result.error,
      });
      return;
    }

    res.status(200).json({
      success: true,
      usageEventId: result.usageEventId,
      stellarTxHash: result.stellarTxHash,
      alreadyProcessed: result.alreadyProcessed,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/billing/request/:requestId - Get billing request status
router.get('/request/:requestId', requireAuth, async (
  req: express.Request,
  res: express.Response<unknown, AuthenticatedLocals>,
  next
) => {
  try {
    const user = res.locals.authenticatedUser;
    if (!user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { requestId } = req.params;

    if (!requestId || typeof requestId !== 'string' || requestId.trim() === '') {
      next(new BadRequestError('requestId is required and must be a non-empty string'));
      return;
    }

    // Get database pool from app locals
    const pool = req.app.locals.dbPool as Pool;
    if (!pool) {
      res.status(500).json({ error: 'Database not available' });
      return;
    }

    const sorobanClient = new BillingSorobanClient();
    const billingService = new BillingService(pool, sorobanClient);

    const result = await billingService.getByRequestId(requestId.trim());

    if (!result) {
      res.status(404).json({
        error: 'Billing request not found',
        requestId: requestId.trim(),
      });
      return;
    }

    res.status(200).json({
      success: true,
      usageEventId: result.usageEventId,
      stellarTxHash: result.stellarTxHash,
      alreadyProcessed: result.alreadyProcessed,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
