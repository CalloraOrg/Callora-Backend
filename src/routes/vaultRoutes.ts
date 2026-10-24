import express from "express";
import { config } from "../config/index.js";
import { DepositController } from "../controllers/depositController.js";
import { VaultController } from "../controllers/vaultController.js";
import { requireAuth, type AuthenticatedLocals } from "../middleware/requireAuth.js";
import { validate } from "../middleware/validate.js";
import type { VaultRepository } from "../repositories/vaultRepository.js";
import { createSorobanVaultReader, type VaultStateReader } from "../services/sorobanVaultReader.js";
import { TransactionBuilderService } from "../services/transactionBuilder.js";
import { stellarNetworkQuerySchema } from "../validators/networkSchema.js";

export function registerVaultRoutes(app: express.Express, vaultRepository: VaultRepository, injectedReader?: VaultStateReader): void {
  // Initialize deposit and vault controllers
  const transactionBuilder = new TransactionBuilderService();
  const depositController = new DepositController(
    vaultRepository,
    transactionBuilder,
  );
  const vaultReader =
    injectedReader ??
    createSorobanVaultReader(
      config.stellar.networks,
      config.sorobanRpc?.timeout ?? 2_000,
    );
  const vaultController = new VaultController(
    vaultRepository,
    vaultReader,
    config.vaultSnapshotMaxAgeMs,
  );
  // Deposit transaction preparation endpoint
  app.post(
    "/api/vault/deposit/prepare",
    requireAuth,
    (req, res: express.Response<unknown, AuthenticatedLocals>) => {
      depositController.prepareDeposit(req, res);
    },
  );

  /**
   * GET /api/vault/balance
   *
   * Returns the authenticated user's vault balance for the requested Stellar network.
   *
   * Query params:
   *   network - optional Stellar network identifier (`testnet` or `mainnet`)
   *             default: the configured Stellar network
   */
  // Vault balance endpoint
  app.get(
    "/api/vault/balance",
    requireAuth,
    validate({ query: stellarNetworkQuerySchema }),
    (req, res: express.Response<unknown, AuthenticatedLocals>, next) => {
      vaultController.getBalance(req, res, next);
    },
  );

  const onchainVaultAuth =
    config.demoMode
      ? (req: express.Request, res: express.Response, next: express.NextFunction) => {
          if (!req.headers.authorization) {
            next();
            return;
          }
          requireAuth(req, res, next);
        }
      : requireAuth;
  app.get(
    "/api/vault/onchain",
    onchainVaultAuth,
    validate({ query: stellarNetworkQuerySchema }),
    (req, res: express.Response<unknown, AuthenticatedLocals>, next) => {
      vaultController.getOnchain(req, res, next);
    },
  );

}
