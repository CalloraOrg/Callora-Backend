import { Router } from 'express';
import { plansAccessLog } from '../middleware/accessLog.js';

const router = Router();

// Apply the plans structured access log to all routes in this router
router.use(plansAccessLog);

// Mock implementation of a /api/plans endpoint
router.get('/', (req, res) => {
  res.status(200).json({ plans: [] });
});

export default router;
