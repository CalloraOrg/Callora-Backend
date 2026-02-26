import { Router } from 'express';
import healthRouter from './health.js';
import apisRouter from './apis.js';
import usageRouter from './usage.js';

const router = Router();

router.use('/health', healthRouter);
router.use('/apis', apisRouter);
router.use('/usage', usageRouter);

export default router;
