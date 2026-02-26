import { Router } from 'express';
import healthRouter from './health.js';
import apisRouter from './apis.js';
import usageRouter from './usage.js';
import auditRouter from './audit.js';
import authRouter from './auth.js';
import apiKeysRouter from './apiKeys.js';
import settlementsRouter from './settlements.js';

const router = Router();

router.use('/health', healthRouter);
router.use('/apis', apisRouter);
router.use('/usage', usageRouter);
router.use('/audit-logs', auditRouter);
router.use('/auth', authRouter);
router.use('/keys', apiKeysRouter);
router.use('/settlements', settlementsRouter);

export default router;
