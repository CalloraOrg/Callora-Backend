import type { Request, Response } from 'express';
import type { AuthenticatedLocals } from '../middleware/requireAuth.js';
import { AmountValidator } from '../validators/amountValidator.js';
import { isValidStellarPublicKey } from '../validators/stellarAddress.js';
import { successEnvelope, errorEnvelope, getRequestId } from '../lib/envelope.js';
import {
  TransactionBuilderService,
  type StellarNetwork,
  InvalidContractIdError,
  InvalidAmountError,
  InvalidMemoError,
  InvalidStellarAddressError,
  NetworkError,
  SourceAccountNotFoundError,
  TransactionBuildError,
  SimulationError,
} from '../services/transactionBuilder.js';
import type { VaultRepository } from '../repositories/vaultRepository.js';
import { config } from '../config/index.js';
import { redactSimulationDetails } from '../lib/simulationDiagnostics.js';

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
      const requestId = getRequestId(req);

      // Step 1: Extract authenticated user
      const user = res.locals.authenticatedUser;
      if (!user) {
        res.status(401).json(
          errorEnvelope('UNAUTHORIZED', 'Authentication required', requestId)
        );
        return;
      }

      // Step 2: Parse and validate request body
      const requestBody = req.body as DepositPrepareRequest;

      if (!requestBody.amount_usdc) {
        res.status(400).json(
          errorEnvelope('MISSING_AMOUNT', 'amount_usdc is required', requestId)
        );
        return;
      }

      if (typeof requestBody.amount_usdc !== 'string') {
        res.status(400).json(
          errorEnvelope(
            'INVALID_AMOUNT_TYPE',
            'amount_usdc must be a string',
            requestId
          )
        );
        return;
      }

      // Step 3: Validate amount format
      const validation = AmountValidator.validateUsdcAmount(requestBody.amount_usdc);
      if (!validation.valid) {
        res.status(400).json(
          errorEnvelope(
            'INVALID_AMOUNT_FORMAT',
            validation.error!,
            requestId,
            { provided: requestBody.amount_usdc }
          )
        );
        return;
      }

      // Step 4: Validate and default network
      const network = (requestBody.network ?? config.stellar.network) as StellarNetwork;
      if (network !== 'testnet' && network !== 'mainnet') {
        res.status(400).json(
          errorEnvelope(
            'INVALID_NETWORK',
            'network must be either "testnet" or "mainnet"',
            requestId,
            { provided: requestBody.network }
          )
        );
        return;
      }

      if (network !== config.stellar.network) {
        res.status(400).json(
          errorEnvelope(
            'NETWORK_MISMATCH',
            `Configured network is '${config.stellar.network}'. Cross-network requests are not allowed.`,
            requestId,
            {
              provided: network,
              configured: config.stellar.network,
            }
          )
        );
        return;
      }

      // Step 5: Validate source account if provided
      if (requestBody.source_account) {
        if (!isValidStellarPublicKey(requestBody.source_account)) {
          res.status(400).json(
            errorEnvelope(
              'INVALID_SOURCE_ACCOUNT',
              'source_account must be a valid Stellar public key (G...)',
              requestId,
              { provided: requestBody.source_account }
            )
          );
          return;
        }
      }

      // Step 6: Retrieve user's vault
      const vault = await this.vaultRepository.findByUserId(user.id, network);
      if (!vault) {
        res.status(404).json(
          errorEnvelope(
            'VAULT_NOT_FOUND',
            `Vault not found for user on network '${network}'. Please create a vault first.`,
            requestId
          )
        );
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
        metadata: {
          fee: unsignedTx.fee,
          timeout: unsignedTx.timeout,
        },
      };

      res.status(200).json(successEnvelope(response, requestId));
    } catch (error) {
      this.handleError(error, res, getRequestId(req));
    }
  }

  private handleError(error: unknown, res: Response, requestId: string): void {
    if (error instanceof VaultNotFoundError) {
      res.status(404).json(
        errorEnvelope('VAULT_NOT_FOUND', error.message, requestId)
      );
    } else if (
      error instanceof InvalidAmountError ||
      error instanceof InvalidMemoError ||
      error instanceof InvalidStellarAddressError
    ) {
      res.status(400).json(
        errorEnvelope(
          'INVALID_TRANSACTION_INPUT',
          error.message,
          requestId
        )
      );
    } else if (error instanceof SourceAccountNotFoundError) {
      res.status(400).json(
        errorEnvelope(
          'SOURCE_ACCOUNT_NOT_FOUND',
          error.message,
          requestId
        )
      );
    } else if (error instanceof InvalidContractIdError) {
      res.status(500).json(
        errorEnvelope(
          'INVALID_CONTRACT_ID',
          'Invalid vault contract configuration. Please contact support.',
          requestId
        )
      );
    } else if (error instanceof NetworkError) {
      res.status(503).json({
        error: 'Unable to connect to Stellar network. Please try again later.',
        code: 'NETWORK_UNAVAILABLE',
        network: error.message,
      });
    } else if (error instanceof SimulationError) {
      // Log full diagnostics at warning level, but only expose a redacted summary.
      console.warn('Soroban simulation diagnostics:', error.simulationDetails);
      const redacted = redactSimulationDetails(error.simulationDetails);
      res.status(502).json({
        error: 'Soroban simulation failed. See diagnostics for details.',
        code: 'SIMULATION_FAILED',
        simulationDetails: redacted,
      });
    } else if (error instanceof TransactionBuildError) {
      res.status(502).json(
        errorEnvelope(
          'TRANSACTION_BUILD_FAILED',
          'Failed to build Stellar transaction. Please try again later.',
          requestId
        )
      );
    } else {
      // Generic error - don't reveal sensitive details
      res.status(500).json(
        errorEnvelope(
          'INTERNAL_ERROR',
          'Failed to prepare deposit transaction',
          requestId
        )
      );
    }
  }

}
