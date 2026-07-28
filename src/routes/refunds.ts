import { Router } from 'express';
import { defaultDisputeService } from '../services/disputeService.js';
import { refundsCache } from '../services/refundsCacheWarm.js';
import { successEnvelope, getRequestId } from '../lib/envelope.js';

const router = Router();

router.get('/', (req, res) => {
  const requestId = getRequestId(req);
  const cached = refundsCache.get('all');
  if (cached !== undefined) {
    res.json(successEnvelope(cached, requestId));
    return;
  }

  const all = defaultDisputeService.listAll();
  const refunds = all.filter((d) => d.status === 'REFUNDED');
  refundsCache.set('all', refunds);

  res.json(successEnvelope(refunds, requestId));
});

export default router;
