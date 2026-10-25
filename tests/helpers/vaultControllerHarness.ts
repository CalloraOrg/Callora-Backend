import express from 'express';
import request from 'supertest';
import { VaultController } from '../../src/../src/controllers/vaultController.js';
import {
  InMemoryVaultRepository,
  type VaultRepository,
} from '../../src/repositories/vaultRepository.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import { requestIdMiddleware } from '../../src/middleware/requestId.js';
import { validate } from '../../src/middleware/validate.js';
import { stellarNetworkQuerySchema } from '../../src/validators/networkSchema.js';
import type {
  OnchainVaultState,
  VaultStateReader,
} from '../../src/services/sorobanVaultReader.js';

export const state: OnchainVaultState = {
  balance: 1_234_567n,
  maxDeduct: 23_456_789n,
  paused: true,
  usdcToken: 'GUSDC',
  settlement: 'GSETTLEMENT',
  ledger: 987654,
};

export function createApp(
  repository: VaultRepository,
  reader?: VaultStateReader,
  snapshotMaxAgeMs = 60_000,
  demoTestnetContractId?: string,
) {
  const app = express();
  app.use(requestIdMiddleware);
  app.use((req, res, next) => {
    const userId = req.headers['x-user-id'];
    if (typeof userId === 'string' && userId.length > 0) {
      res.locals.authenticatedUser = { id: userId, email: `${userId}@example.com` };
    }
    next();
  });
  const controller = new VaultController(
    repository,
    reader,
    snapshotMaxAgeMs,
    demoTestnetContractId,
  );
  app.get(
    '/api/vault/balance',
    validate({ query: stellarNetworkQuerySchema }),
    controller.getBalance.bind(controller),
  );
  app.get(
    '/api/vault/onchain',
    validate({ query: stellarNetworkQuerySchema }),
    controller.getOnchain.bind(controller),
  );
  app.use(errorHandler);
  return app;
}
