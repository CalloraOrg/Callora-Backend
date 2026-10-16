import type { NextFunction, Request, Response } from 'express';
import { Address } from '@stellar/stellar-sdk';
import {
  BadRequestError,
  ConflictError,
  InternalServerError,
  NotFoundError,
  UnauthorizedError,
  isAppError,
} from '../errors/index.js';
import type { AuthenticatedLocals } from '../middleware/requireAuth.js';
import { DuplicateVaultError, type VaultRepository } from '../repositories/vaultRepository.js';
import { InvalidContractIdError } from '../services/transactionBuilder.js';
import { parseNetworkWithDefault } from '../validators/networkSchema.js';

export class VaultController {
  constructor(private readonly vaultRepository: VaultRepository) { }

  /**
   * Registers a new vault for the authenticated user on the requested Stellar network.
   * POST /api/vault
   */
  async createVault(
    req: Request,
    res: Response<unknown, AuthenticatedLocals>,
    next: NextFunction,
  ): Promise<void> {
    const user = res.locals.authenticatedUser;
    if (!user) {
      next(new UnauthorizedError('Authentication required'));
      return;
    }

    const body = (req.body ?? {}) as { contractId?: unknown; network?: unknown };
    const rawContractId = typeof body.contractId === 'string' ? body.contractId.trim() : '';

    try {
      this.validateContractId(rawContractId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : `Invalid contract ID format: ${String(body.contractId ?? '')}`;
      next(new BadRequestError(msg, 'INVALID_CONTRACT_ID'));
      return;
    }

    const rawNetwork = body.network === undefined ? 'testnet' : body.network;
    if (rawNetwork !== 'testnet' && rawNetwork !== 'mainnet') {
      next(
        new BadRequestError(
          'network must be either "testnet" or "mainnet"',
          'INVALID_NETWORK',
        ),
      );
      return;
    }

    try {
      const vault = await this.vaultRepository.create(user.id, rawContractId, rawNetwork);
      res.status(201).json({
        id: vault.id,
        contractId: vault.contractId,
        network: vault.network,
      });
    } catch (error) {
      if (error instanceof DuplicateVaultError) {
        next(new ConflictError(error.message, 'DUPLICATE_VAULT'));
        return;
      }
      next(
        isAppError(error)
          ? error
          : new InternalServerError(
              'Failed to create vault',
              'VAULT_CREATION_FAILED',
            ),
      );
    }
  }

  /**
   * Returns the authenticated user's vault balance for the requested Stellar network.
   * Accepted query values for `network` are `testnet` and `mainnet`.
   * When omitted, `network` defaults to `testnet`.
   */
  async getBalance(
    req: Request,
    res: Response<unknown, AuthenticatedLocals>,
    next: NextFunction,
  ): Promise<void> {
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

      // Format balance from stroops (bigint) to USDC string (7 decimals)
      const balanceUsdc = this.formatStroopsToUsdc(vault.balanceSnapshot);

      const data = {
        balance_usdc: balanceUsdc,
        contractId: vault.contractId,
        network: vault.network,
        lastSyncedAt: vault.lastSyncedAt ? vault.lastSyncedAt.toISOString() : null,
      };

      res.status(200).json(data);
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

  private validateContractId(contractId: string): void {
    if (!contractId || !contractId.startsWith('C')) {
      throw new InvalidContractIdError(contractId);
    }
    try {
      new Address(contractId);
    } catch {
      throw new InvalidContractIdError(contractId);
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
