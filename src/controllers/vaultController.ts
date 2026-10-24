import type { NextFunction, Request, Response } from 'express';
import {
  InternalServerError,
  NotFoundError,
  UnauthorizedError,
  isAppError,
} from '../errors/index.js';
import type { AuthenticatedLocals } from '../middleware/requireAuth.js';
import type { VaultRepository } from '../repositories/vaultRepository.js';
import { parseNetworkWithDefault } from '../validators/networkSchema.js';
import { successEnvelope, getRequestId } from '../lib/envelope.js';
import type { VaultStateReader } from '../services/sorobanVaultReader.js';
import { config } from '../config/index.js';

export class VaultController {
  constructor(
    private readonly vaultRepository: VaultRepository,
    private readonly vaultReader?: VaultStateReader,
    private readonly snapshotMaxAgeMs = 60_000,
    private readonly demoTestnetContractId =
      config.stellar.networks.testnet.vaultContractId,
  ) {}

  /**
   * Returns the authenticated user's vault balance for the requested Stellar network.
   * Accepted query values for `network` are `testnet` and `mainnet`.
   * When omitted, `network` defaults to the configured Stellar network.
   */
  async getBalance(
    req: Request,
    res: Response<unknown, AuthenticatedLocals>,
    next: NextFunction,
  ): Promise<void> {
    const requestId = getRequestId(req);
    const user = res.locals.authenticatedUser;
    if (!user) {
      next(new UnauthorizedError('Authentication required'));
      return;
    }

    const network = parseNetworkWithDefault(req.query);

    try {
      const vault = await this.vaultRepository.findByUserId(user.id, network);
      if (!vault) {
        next(
          new NotFoundError(
            `Vault not found for user on network '${network}'. Please create a vault first.`,
            'VAULT_NOT_FOUND',
          ),
        );
        return;
      }

      let balanceSnapshot = vault.balanceSnapshot;
      let lastSyncedAt = vault.lastSyncedAt;
      let stale =
        !lastSyncedAt ||
        !Number.isFinite(lastSyncedAt.getTime()) ||
        Date.now() - lastSyncedAt.getTime() > this.snapshotMaxAgeMs;

      if (stale && this.vaultReader) {
        let onchainBalance: bigint | undefined;
        try {
          onchainBalance = (await this.vaultReader.readVault(
            vault.contractId,
            network,
          )).balance;
        } catch {
          stale = true;
        }
        if (onchainBalance !== undefined) {
          const updated = await this.vaultRepository.updateBalanceSnapshot(
            vault.id,
            onchainBalance,
            new Date(),
          );
          balanceSnapshot = updated.balanceSnapshot;
          lastSyncedAt = updated.lastSyncedAt;
          stale = false;
        }
      }

      const data = {
        balance_usdc: this.formatStroopsToUsdc(balanceSnapshot),
        contractId: vault.contractId,
        network: vault.network,
        lastSyncedAt: lastSyncedAt ? lastSyncedAt.toISOString() : null,
        stale,
      };

      res.status(200).json(successEnvelope(data, requestId));
    } catch (error) {
      next(
        isAppError(error)
          ? error
          : new InternalServerError(
              'Failed to retrieve vault balance',
              'VAULT_BALANCE_RETRIEVAL_FAILED',
            ),
      );
    }
  }

  async getOnchain(
    req: Request,
    res: Response<unknown, AuthenticatedLocals>,
    next: NextFunction,
  ): Promise<void> {
    const requestId = getRequestId(req);
    const user = res.locals.authenticatedUser;
    const demoPublicRead =
      config.demoMode &&
      !req.headers.authorization &&
      !user;
    let contractId: string | undefined;
    let network: 'testnet' | 'mainnet';

    try {
      if (demoPublicRead) {
        network = 'testnet';
        contractId = this.demoTestnetContractId;
      } else {
        if (!user) {
          next(new UnauthorizedError('Authentication required'));
          return;
        }
        network = parseNetworkWithDefault(req.query);
        const vault = await this.vaultRepository.findByUserId(user.id, network);
        if (!vault) {
          next(
            new NotFoundError(
              `Vault not found for user on network '${network}'. Please create a vault first.`,
              'VAULT_NOT_FOUND',
            ),
          );
          return;
        }
        contractId = vault.contractId;
      }

      if (!contractId || !this.vaultReader) {
        next(
          new InternalServerError(
            'On-chain vault reader is not configured',
            'VAULT_BALANCE_RETRIEVAL_FAILED',
          ),
        );
        return;
      }

      const state = await this.vaultReader.readVault(contractId, network);
      res.status(200).json(
        successEnvelope(
          {
            contractId,
            network,
            balanceUsdc: this.formatStroopsToUsdc(state.balance),
            maxDeductUsdc: this.formatStroopsToUsdc(state.maxDeduct),
            paused: state.paused,
            usdcToken: state.usdcToken,
            settlement: state.settlement,
            ledger: state.ledger,
          },
          requestId,
        ),
      );
    } catch (error) {
      next(
        isAppError(error)
          ? error
          : new InternalServerError(
              'Failed to retrieve on-chain vault state',
              'VAULT_BALANCE_RETRIEVAL_FAILED',
            ),
      );
    }
  }

  private formatStroopsToUsdc(stroops: bigint): string {
    const isNegative = stroops < 0n;
    const absStroops = isNegative ? -stroops : stroops;

    // Pad with leading zeros if less than 1 USDC (10,000,000 stroops)
    const paddedStr = absStroops.toString().padStart(8, '0');

    // Insert decimal point 7 places from the right
    const decimalIndex = paddedStr.length - 7;
    const result = `${paddedStr.slice(0, decimalIndex)}.${paddedStr.slice(decimalIndex)}`;

    return isNegative ? `-${result}` : result;
  }
}
