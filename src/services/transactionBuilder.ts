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
  private static readonly TRANSACTION_TIMEOUT = 300;
  private static readonly USDC_STROOPS_MULTIPLIER = 10_000_000;
  private static readonly BASE_FEE = '100';

  async buildDepositTransaction(
    params: BuildDepositParams,
  ): Promise<UnsignedTransaction> {
    if (!/^C[A-Z0-9]{10,}$/.test(params.vaultContractId)) {
      throw new InvalidContractIdError(params.vaultContractId);
    }

    const sourceAccount = params.sourceAccount ?? params.userPublicKey;
    if (!/^G[A-Z0-9]{55}$/.test(sourceAccount)) {
      throw new NetworkError('invalid source account for selected network');
    }

    const amountStroops = this.convertUsdcToStroops(params.amountUsdc);

    const operation: TransactionOperation = {
      type: 'invoke_contract',
      contractId: params.vaultContractId,
      function: 'deposit',
      args: [
        { type: 'address', value: params.userPublicKey },
        { type: 'i128', value: String(amountStroops) },
      ],
    };

    const deterministicPayload = JSON.stringify({
      sourceAccount,
      network: params.network,
      fee: TransactionBuilderService.BASE_FEE,
      timeout: TransactionBuilderService.TRANSACTION_TIMEOUT,
      operation,
    });

    const xdr = Buffer.from(deterministicPayload, 'utf8').toString('base64');

    return {
      xdr,
      network: params.network,
      operation,
      fee: TransactionBuilderService.BASE_FEE,
      timeout: TransactionBuilderService.TRANSACTION_TIMEOUT,
    };
  }

  private convertUsdcToStroops(amountUsdc: string): bigint {
    const amountFloat = Number.parseFloat(amountUsdc);
    const amountStroops = Math.floor(
      amountFloat * TransactionBuilderService.USDC_STROOPS_MULTIPLIER,
    );

    if (!Number.isFinite(amountStroops) || amountStroops <= 0) {
      throw new Error('Amount in stroops must be greater than zero');
    }

    return BigInt(amountStroops);
  }
}
