import { Router } from 'express';
import type { Response } from 'express';
import { requireAuth, type AuthenticatedLocals } from '../middleware/requireAuth.js';
import type { UsageEventsRepository } from '../repositories/usageEventsRepository.js';
import type { VaultRepository } from '../repositories/vaultRepository.js';

export interface Transaction {
  id: string;
  amount: string;
  date: Date;
  type: 'deposit' | 'charge' | 'withdrawal';
  tx_hash?: string;
  description?: string;
}

const parseNonNegativeIntegerParam = (
  value: unknown
): { value?: number; invalid: boolean } => {
  if (typeof value !== 'string' || value.trim() === '') {
    return { value: undefined, invalid: false };
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
    return { value: undefined, invalid: true };
  }
  return { value: parsed, invalid: false };
};

const parseDate = (value: unknown): Date | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
};

export const createBillingRouter = (
  usageEventsRepository: UsageEventsRepository,
  vaultRepository: VaultRepository
) => {
  const router = Router();

  router.get(
    '/transactions',
    requireAuth,
    async (req, res: Response<unknown, AuthenticatedLocals>) => {
      const user = res.locals.authenticatedUser;
      if (!user) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      // Parse and validate query parameters
      const from = parseDate(req.query.from);
      const to = parseDate(req.query.to);

      if (!from || !to) {
        res.status(400).json({ error: 'from and to are required ISO date values' });
        return;
      }

      if (from > to) {
        res.status(400).json({ error: 'from must be before or equal to to' });
        return;
      }

      const typeParam = req.query.type;
      if (typeParam && typeof typeParam === 'string') {
        if (!['deposit', 'charge', 'withdrawal'].includes(typeParam)) {
          res.status(400).json({ error: 'type must be one of: deposit, charge, withdrawal' });
          return;
        }
      }

      const limitParam = parseNonNegativeIntegerParam(req.query.limit);
      if (limitParam.invalid) {
        res.status(400).json({ error: 'limit must be a non-negative integer' });
        return;
      }

      const offsetParam = parseNonNegativeIntegerParam(req.query.offset);
      if (offsetParam.invalid) {
        res.status(400).json({ error: 'offset must be a non-negative integer' });
        return;
      }

      const limit = limitParam.value ?? 50;
      const offset = offsetParam.value ?? 0;
      const type = typeParam as 'deposit' | 'charge' | 'withdrawal' | undefined;

      // Fetch transactions from both repositories
      const transactions: Transaction[] = [];

      // Fetch charges from usage events if type allows
      if (!type || type === 'charge') {
        const billingTxs = await usageEventsRepository.findBillingTransactions({
          userId: user.id,
          from,
          to,
          type,
          limit,
          offset,
        });
        transactions.push(...billingTxs.map(tx => ({
          ...tx,
          type: 'charge' as const,
        })));
      }

      // Fetch deposits/withdrawals from vault if type allows
      if (!type || type === 'deposit' || type === 'withdrawal') {
        const vaultTxs = await vaultRepository.findTransactions(user.id, from, to);
        const filteredVaultTxs = type
          ? vaultTxs.filter(tx => tx.type === type)
          : vaultTxs;
        transactions.push(...filteredVaultTxs);
      }

      // Sort by date descending (newest first)
      transactions.sort((a, b) => b.date.getTime() - a.date.getTime());

      // Apply pagination to merged results
      const paginatedTransactions = transactions.slice(offset, offset + limit);

      res.json({
        data: paginatedTransactions,
        pagination: {
          limit,
          offset,
          total: transactions.length,
        },
      });
    }
  );

  return router;
};

