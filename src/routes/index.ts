import { Router } from 'express';
import healthRouter from './health.js';
import apisRouter from './apis.js';
import usageRouter from './usage.js';
import billingRouter from './billing.js';

const router = Router();

router.use('/health', healthRouter);
router.use('/apis', apisRouter);
router.use('/usage', usageRouter);
router.use('/billing', billingRouter);

export default router;
