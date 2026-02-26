import {
  Server,
  Networks,
  TransactionBuilder,
  Operation,
  Address,
  nativeToScVal,
  xdr,
  BASE_FEE,
} from '@stellar/stellar-sdk';

export type StellarNetwork = 'testnet' | 'mainnet';

export interface BuildDepositParams {
  userPublicKey: string;
  vaultContractId: string;
  amountUsdc: string;
  network: StellarNetwork;
  sourceAccount?: string;
}

export interface SorobanInvokeArg {
  type: 'address' | 'i128' | 'string';
  value: string;
}

export interface TransactionOperation {
  type: 'invoke_contract';
  contractId: string;
  function: string;
  args: SorobanInvokeArg[];
}

export interface UnsignedTransaction {
  xdr: string;
  network: string;
  operation: TransactionOperation;
  fee: string;
  timeout: number;
}

export class InvalidContractIdError extends Error {
  constructor(contractId: string) {
    super(`Invalid contract ID format: ${contractId}`);
    this.name = 'InvalidContractIdError';
  }
}

export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

export class TransactionBuilderService {
  private static readonly TRANSACTION_TIMEOUT = 300; // 5 minutes
  private static readonly USDC_STROOPS_MULTIPLIER = 10_000_000;

  async buildDepositTransaction(
    params: BuildDepositParams
  ): Promise<UnsignedTransaction> {
    // Step 1: Initialize Stellar SDK with network
    const { networkPassphrase, horizonUrl } = this.getNetworkConfig(params.network);

    const server = new Server(horizonUrl);

    // Step 2: Load source account from network
    const sourceKey = params.sourceAccount ?? params.userPublicKey;
    let sourceAccount;

    try {
      sourceAccount = await server.loadAccount(sourceKey);
    } catch (error) {
      throw new NetworkError(
        `Failed to load source account from Stellar network: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }

    // Step 3: Convert USDC amount to smallest units (stroops)
    const amountStroops = this.convertUsdcToStroops(params.amountUsdc);

    // Step 4: Build Soroban contract invocation
    let contractAddress: Address;
    let userAddress: Address;

    try {
      contractAddress = new Address(params.vaultContractId);
      userAddress = new Address(params.userPublicKey);
    } catch (error) {
      throw new InvalidContractIdError(params.vaultContractId);
    }

    const operation = Operation.invokeContractFunction({
      contract: contractAddress.toString(),
      function: 'deposit',
      args: [
        nativeToScVal(userAddress, { type: 'address' }),
        nativeToScVal(amountStroops, { type: 'i128' }),
      ],
    });

    // Step 5: Build transaction
    const transaction = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(TransactionBuilderService.TRANSACTION_TIMEOUT)
      .build();

    // Step 6: Verify unsigned (no signatures)
    if (transaction.signatures.length !== 0) {
      throw new Error('Transaction should not have signatures');
    }

    // Step 7: Convert to XDR
    const xdrString = transaction.toXDR();

    // Step 8: Construct response
    return {
      xdr: xdrString,
      network: params.network,
      operation: {
        type: 'invoke_contract',
        contractId: params.vaultContractId,
        function: 'deposit',
        args: [
          { type: 'address', value: params.userPublicKey },
          { type: 'i128', value: String(amountStroops) },
        ],
      },
      fee: BASE_FEE,
      timeout: TransactionBuilderService.TRANSACTION_TIMEOUT,
    };
  }

  private getNetworkConfig(network: StellarNetwork): {
    networkPassphrase: string;
    horizonUrl: string;
  } {
    if (network === 'testnet') {
      return {
        networkPassphrase: Networks.TESTNET,
        horizonUrl: 'https://horizon-testnet.stellar.org',
      };
    } else {
      return {
        networkPassphrase: Networks.PUBLIC,
        horizonUrl: 'https://horizon.stellar.org',
      };
    }
  }

  private convertUsdcToStroops(amountUsdc: string): bigint {
    // USDC has 7 decimals, so multiply by 10^7
    const amountFloat = parseFloat(amountUsdc);
    const amountStroops = Math.floor(
      amountFloat * TransactionBuilderService.USDC_STROOPS_MULTIPLIER
    );

    if (amountStroops <= 0) {
      throw new Error('Amount in stroops must be greater than zero');
    }

    return BigInt(amountStroops);
  }
}
