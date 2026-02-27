import type { Request, Response } from 'express';
import type { AuthenticatedLocals } from '../middleware/requireAuth.js';
import { AmountValidator } from '../validators/amountValidator.js';
import {
  TransactionBuilderService,
  type StellarNetwork,
  InvalidContractIdError,
  NetworkError,
} from '../services/transactionBuilder.js';
import type { VaultRepository } from '../repositories/vaultRepository.js';

export interface DepositPrepareRequest {
  amount_usdc: string;
  network?: string;
  source_account?: string;
}

export interface DepositPrepareResponse {
  xdr: string;
  network: string;
  contractId: string;
  amount: string;
  operation: {
    type: 'invoke_contract';
    function: 'deposit';
    args: Array<{
      type: string;
      value: string;
    }>;
  };
  metadata: {
    fee: string;
    timeout: number;
  };
}

export class VaultNotFoundError extends Error {
  constructor(userId: string, network: string) {
    super(`Vault not found for user on network '${network}'. Please create a vault first.`);
    this.name = 'VaultNotFoundError';
  }
}

export class DepositController {
  constructor(
    private readonly vaultRepository: VaultRepository,
    private readonly transactionBuilder: TransactionBuilderService
  ) {}

  async prepareDeposit(
    req: Request,
    res: Response<unknown, AuthenticatedLocals>
  ): Promise<void> {
    try {
      // Step 1: Extract authenticated user
      const user = res.locals.authenticatedUser;
      if (!user) {
        res.status(401).json({
          error: 'Authentication required',
          code: 'UNAUTHORIZED',
        });
        return;
      }

      // Step 2: Parse and validate request body
      const requestBody = req.body as DepositPrepareRequest;

      if (!requestBody.amount_usdc) {
        res.status(400).json({
          error: 'amount_usdc is required',
          code: 'MISSING_AMOUNT',
        });
        return;
      }

      if (typeof requestBody.amount_usdc !== 'string') {
        res.status(400).json({
          error: 'amount_usdc must be a string',
          code: 'INVALID_AMOUNT_TYPE',
        });
        return;
      }

      // Step 3: Validate amount format
      const validation = AmountValidator.validateUsdcAmount(requestBody.amount_usdc);
      if (!validation.valid) {
        res.status(400).json({
          error: validation.error,
          code: 'INVALID_AMOUNT_FORMAT',
          provided: requestBody.amount_usdc,
        });
        return;
      }

      // Step 4: Validate and default network
      const network = (requestBody.network ?? 'testnet') as StellarNetwork;
      if (network !== 'testnet' && network !== 'mainnet') {
        res.status(400).json({
          error: 'network must be either "testnet" or "mainnet"',
          code: 'INVALID_NETWORK',
          provided: requestBody.network,
        });
        return;
      }

      // Step 5: Validate source account if provided
      if (requestBody.source_account) {
        if (!this.isValidStellarPublicKey(requestBody.source_account)) {
          res.status(400).json({
            error: 'source_account must be a valid Stellar public key (G...)',
            code: 'INVALID_SOURCE_ACCOUNT',
            provided: requestBody.source_account,
          });
          return;
        }
      }

      // Step 6: Retrieve user's vault
      const vault = await this.vaultRepository.findByUserId(user.id, network);
      if (!vault) {
        res.status(404).json({
          error: `Vault not found for user on network '${network}'. Please create a vault first.`,
          code: 'VAULT_NOT_FOUND',
        });
        return;
      }

      // Step 7: Build unsigned transaction
      const unsignedTx = await this.transactionBuilder.buildDepositTransaction({
        userPublicKey: user.id, // Assuming user.id is the Stellar public key
        vaultContractId: vault.contractId,
        amountUsdc: validation.normalizedAmount!,
        network,
        sourceAccount: requestBody.source_account,
      });

      // Step 8: Construct and return response
      const response: DepositPrepareResponse = {
        xdr: unsignedTx.xdr,
        network: unsignedTx.network,
        contractId: vault.contractId,
        amount: validation.normalizedAmount!,
        operation: {
          type: unsignedTx.operation.type,
          function: unsignedTx.operation.function as 'deposit',
          args: unsignedTx.operation.args,
        },
        operation: unsignedTx.operation as DepositPrepareResponse['operation'],
        metadata: {
          fee: unsignedTx.fee,
          timeout: unsignedTx.timeout,
        },
      };

      res.status(200).json(response);
    } catch (error) {
      this.handleError(error, res);
    }
  }

  private isValidStellarPublicKey(key: string): boolean {
    // Stellar public keys start with 'G' and are 56 characters long
    return /^G[A-Z0-9]{55}$/.test(key);
  }

  private handleError(error: unknown, res: Response): void {
    if (error instanceof VaultNotFoundError) {
      res.status(404).json({
        error: error.message,
        code: 'VAULT_NOT_FOUND',
      });
    } else if (error instanceof InvalidContractIdError) {
      res.status(500).json({
        error: 'Invalid vault contract configuration. Please contact support.',
        code: 'INVALID_CONTRACT_ID',
      });
    } else if (error instanceof NetworkError) {
      res.status(503).json({
        error: 'Unable to connect to Stellar network. Please try again later.',
        code: 'NETWORK_UNAVAILABLE',
        network: error.message,
      });
    } else {
      // Generic error - don't reveal sensitive details
      res.status(500).json({
        error: 'Failed to prepare deposit transaction',
        code: 'INTERNAL_ERROR',
      });
    }
  }
}
