import {
  Horizon,
  TransactionBuilder,
  Operation,
  Address,
  Memo,
  nativeToScVal,
  rpc,
  Transaction,
} from '@stellar/stellar-sdk';
import { assembleTransaction } from '@stellar/stellar-sdk/rpc';
import { config } from '../config/index.js';
import { withRetry } from '../lib/retry.js';
import {
  extractSimulationDetails,
  type SimulationDetails,
} from '../lib/simulationDiagnostics.js';
import { PostgresSequenceStore } from './postgresSequenceStore.js';
import { SequenceAllocationError, type SequenceStore } from './sequenceManager.js';

export type StellarNetwork = 'testnet' | 'mainnet';

export interface BuildDepositParams {
  userStellarAddress: string;
  vaultContractId: string;
  amountUsdc: string;
  network?: StellarNetwork;
  sourceAccount?: string;
  memoText?: string | null;
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

export interface TransactionMemo {
  type: 'text';
  value: string;
}

export interface UnsignedTransaction {
  xdr: string;
  network: string;
  operation: TransactionOperation;
  fee: string;
  timeout: number;
  resourceFee: string;
  minResourceFee: string;
  latestLedger: number;
  memo?: TransactionMemo;
}

/* -------------------------------------------------------------------------- */
/* Error definitions                                                          */
/* -------------------------------------------------------------------------- */

export class InvalidContractIdError extends Error {
  constructor(contractId: string) {
    super(`Invalid contract ID format: ${contractId}`);
    this.name = 'InvalidContractIdError';
  }
}

export class InvalidStellarAddressError extends Error {
  constructor(field: string, value: string) {
    super(`Invalid ${field}: ${value}`);
    this.name = 'InvalidStellarAddressError';
  }
}

export class InvalidAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAmountError';
  }
}

export class InvalidMemoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMemoError';
  }
}

export class SourceAccountNotFoundError extends Error {
  constructor(accountId: string) {
    super(`Source account was not found on the configured Stellar network: ${accountId}`);
    this.name = 'SourceAccountNotFoundError';
  }
}

export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

export class TransactionBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransactionBuildError';
  }
}

export class SimulationError extends TransactionBuildError {
  public readonly simulationDetails: SimulationDetails;

  constructor(message: string, simulationDetails: unknown) {
    super(message);
    this.name = 'SimulationError';
    this.simulationDetails = extractSimulationDetails(simulationDetails);
  }
}

export class StellarAddressRequiredError extends Error {
  constructor() {
    super('User does not have a Stellar address configured');
    this.name = 'StellarAddressRequiredError';
  }
}

/* -------------------------------------------------------------------------- */
/* Service implementation                                                     */
/* -------------------------------------------------------------------------- */

interface HorizonAccountLoader {
  loadAccount(accountId: string): Promise<unknown>;
}

interface NormalizedMemo {
  sdkMemo: ReturnType<typeof Memo.text>;
  value: string;
}

export interface TransactionBuilderServiceOptions {
  createServer?: (horizonUrl: string) => HorizonAccountLoader;
  createRpcServer?: (rpcUrl: string) => rpc.Server;
  sequenceStore?: SequenceStore | false;
  sequenceAllocationTimeoutMs?: number;
  baseFee?: string | number;
  timeoutSeconds?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  isBackendOwnedAccount?: (accountId: string) => boolean;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;

function isHorizonTransientError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return false;
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return !msg.includes('404') && !msg.includes('not found') && !msg.includes('resource missing');
}

function isRpcTransientError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return false;
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    msg.includes('timeout') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('econnrefused') ||
    msg.includes('network') ||
    msg.includes('503') ||
    msg.includes('502') ||
    msg.includes('504')
  );
}

export class TransactionBuilderService {
  private static readonly DEFAULT_TRANSACTION_TIMEOUT = 300;
  private static readonly USDC_STROOPS_MULTIPLIER = 10_000_000n;
  private static readonly MAX_USDC_STROOPS = 1_000_000_000n * 10_000_000n;

  constructor(private readonly options: TransactionBuilderServiceOptions = {}) {}

  async buildDepositTransaction(
    params: BuildDepositParams
  ): Promise<UnsignedTransaction> {
    const selectedNetwork = params.network ?? config.stellar.network;

    if (selectedNetwork !== 'testnet' && selectedNetwork !== 'mainnet') {
      throw new NetworkError(`Unsupported Stellar network: ${String(selectedNetwork)}`);
    }

    if (selectedNetwork !== config.stellar.network) {
      throw new NetworkError(
        `Configured network is '${config.stellar.network}' but request used '${selectedNetwork}'. Cross-network mixing is not allowed.`
      );
    }

    const expectedVaultContractId = config.stellar.networks[selectedNetwork].vaultContractId;
    if (expectedVaultContractId && expectedVaultContractId !== params.vaultContractId) {
      throw new NetworkError(
        `Vault contract ID does not match configured ${selectedNetwork} contract ID.`
      );
    }

    const { networkPassphrase, horizonUrl, sorobanRpcUrl } = this.getNetworkConfig(selectedNetwork);
    const fee = this.resolveFee();
    const timeout = this.resolveTimeout();
    const server = this.createServer(horizonUrl);
    const rpcServer = this.createRpcServer(sorobanRpcUrl);

    const sourceKey = params.sourceAccount ?? params.userStellarAddress;
    const amountStroops = this.convertUsdcToStroops(params.amountUsdc);
    const contractAddress = this.parseContractAddress(params.vaultContractId);
    const userAddress = this.parseStellarAddress(params.userStellarAddress, 'user stellar address');
    this.parseStellarAddress(sourceKey, 'source account');
    const memo = this.createMemo(params.memoText);

    let sourceAccount: unknown;

    try {
      sourceAccount = await withRetry(
        () => server.loadAccount(sourceKey),
        {
          maxAttempts: (this.options.maxRetries ?? DEFAULT_MAX_RETRIES) + 1,
          baseDelayMs: this.options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
          shouldRetry: isHorizonTransientError,
        }
      );

      const isBackendAccount = this.options.isBackendOwnedAccount?.(sourceKey) ?? false;
      const sequenceStore =
        this.options.sequenceStore === undefined
          ? process.env.NODE_ENV === 'test'
            ? undefined
            : new PostgresSequenceStore()
          : this.options.sequenceStore || undefined;

      if (sequenceStore && isBackendAccount) {
        const accountSequence = (sourceAccount as { sequence?: unknown }).sequence;
        const ledgerNextSequence = BigInt(String(accountSequence)) + 1n;
        const reservedSequence = await this.withSequenceAllocationTimeout(
          sequenceStore.allocate(sourceKey, ledgerNextSequence)
        );
        (sourceAccount as { sequence: string }).sequence = (reservedSequence - 1n).toString();
      }
    } catch (error) {
      throw this.mapLoadAccountError(sourceKey, error);
    }

    let operation;
    try {
      operation = Operation.invokeContractFunction({
        contract: contractAddress.toString(),
        function: 'deposit',
        args: [
          nativeToScVal(userAddress, { type: 'address' }),
          nativeToScVal(amountStroops, { type: 'i128' }),
        ],
      });
    } catch (error) {
      const details = (error as { details?: unknown }).details;
      if (details) {
        throw new SimulationError(
          `Soroban simulation failed: ${this.getErrorMessage(error)}`,
          details
        );
      }
      throw new TransactionBuildError(
        `Failed to assemble Stellar contract invocation: ${this.getErrorMessage(error)}`
      );
    }

    let transaction: Transaction;
    try {
      let builder = new TransactionBuilder(
        sourceAccount as ConstructorParameters<typeof TransactionBuilder>[0],
        {
          fee,
          networkPassphrase,
        }
      ).addOperation(operation);

      if (memo) {
        builder = builder.addMemo(memo.sdkMemo);
      }

      transaction = builder.setTimeout(timeout).build();

      if (transaction.signatures.length !== 0) {
        throw new TransactionBuildError('Transaction should not have signatures');
      }
    } catch (error) {
      if (error instanceof TransactionBuildError) {
        throw error;
      }
      throw new TransactionBuildError(
        `Failed to build Stellar transaction: ${this.getErrorMessage(error)}`
      );
    }

    const { preparedTx, simulationResult } = await this.simulateAndPrepareTransaction(
      rpcServer,
      transaction,
      networkPassphrase
    );

    return {
      xdr: preparedTx.toXDR(),
      network: selectedNetwork,
      operation: {
        type: 'invoke_contract',
        contractId: params.vaultContractId,
        function: 'deposit',
        args: [
          { type: 'address', value: params.userStellarAddress },
          { type: 'i128', value: amountStroops.toString() },
        ],
      },
      fee,
      timeout,
      resourceFee: simulationResult.minResourceFee ?? '0',
      minResourceFee: simulationResult.minResourceFee ?? '0',
      latestLedger: simulationResult.latestLedger ?? 0,
      ...(memo
        ? {
            memo: {
              type: 'text' as const,
              value: memo.value,
            },
          }
        : {}),
    };
  }

  private async simulateAndPrepareTransaction(
    rpcServer: rpc.Server,
    transaction: Transaction,
    networkPassphrase: string
  ): Promise<{
    preparedTx: Transaction;
    simulationResult: rpc.Api.SimulateTransactionSuccessResponse;
  }> {
    let simulatedTx: rpc.Api.SimulateTransactionResponse;

    try {
      simulatedTx = await withRetry(
        () => rpcServer.simulateTransaction(transaction),
        {
          maxAttempts: (this.options.maxRetries ?? DEFAULT_MAX_RETRIES) + 1,
          baseDelayMs: this.options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
          shouldRetry: isRpcTransientError,
        }
      );
    } catch (error) {
      throw new SimulationError(
        `Soroban simulation failed: ${this.getErrorMessage(error)}`,
        error
      );
    }

    if (!rpc.Api.isSimulationSuccess(simulatedTx)) {
      throw new SimulationError(
        'Soroban simulation failed',
        simulatedTx
      );
    }

    let preparedTx: Transaction;

    try {
      const builder = assembleTransaction(transaction, simulatedTx);
      preparedTx = builder.build();
    } catch (error) {
      throw new SimulationError(
        `Soroban assembleTransaction failed: ${this.getErrorMessage(error)}`,
        error
      );
    }

    if (preparedTx.signatures.length !== 0) {
      throw new TransactionBuildError('Prepared transaction should not have signatures');
    }

    return {
      preparedTx,
      simulationResult: simulatedTx,
    };
  }

  private getNetworkConfig(network: StellarNetwork): {
    networkPassphrase: string;
    horizonUrl: string;
    sorobanRpcUrl: string;
  } {
    const networkConfig = config.stellar.networks[network];
    return {
      networkPassphrase: networkConfig.networkPassphrase,
      horizonUrl: networkConfig.horizonUrl,
      sorobanRpcUrl: networkConfig.sorobanRpcUrl,
    };
  }

  private createServer(horizonUrl: string): HorizonAccountLoader {
    return this.options.createServer?.(horizonUrl) ?? new Horizon.Server(horizonUrl);
  }

  private createRpcServer(rpcUrl: string): rpc.Server {
    return this.options.createRpcServer?.(rpcUrl) ?? new rpc.Server(rpcUrl, { allowHttp: true });
  }

  private resolveFee(): string {
    const configuredFee = this.options.baseFee ?? config.stellar.baseFee;
    const parsedFee =
      typeof configuredFee === 'number'
        ? configuredFee
        : /^\d+$/.test(configuredFee)
        ? Number.parseInt(configuredFee, 10)
        : Number.NaN;

    if (!Number.isSafeInteger(parsedFee) || parsedFee <= 0) {
      throw new TransactionBuildError('Invalid Stellar base fee configuration');
    }

    return String(parsedFee);
  }

  private resolveTimeout(): number {
    const timeout =
      this.options.timeoutSeconds ??
      config.stellar.transactionTimeout ??
      TransactionBuilderService.DEFAULT_TRANSACTION_TIMEOUT;

    if (!Number.isSafeInteger(timeout) || timeout <= 0) {
      throw new TransactionBuildError('Invalid Stellar transaction timeout configuration');
    }

    return timeout;
  }

  private parseContractAddress(contractId: string): Address {
    try {
      return new Address(contractId);
    } catch {
      throw new InvalidContractIdError(contractId);
    }
  }

  private parseStellarAddress(value: string, field: string): Address {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new InvalidStellarAddressError(field, String(value));
    }

    try {
      return new Address(value);
    } catch {
      throw new InvalidStellarAddressError(field, value);
    }
  }

  private createMemo(memoText?: string | null): NormalizedMemo | undefined {
    if (memoText === undefined || memoText === null) {
      return undefined;
    }

    if (typeof memoText !== 'string') {
      throw new InvalidMemoError('Memo must be a string when provided');
    }

    const trimmedMemo = memoText.trim();
    if (trimmedMemo.length === 0) {
      return undefined;
    }

    if (Buffer.byteLength(trimmedMemo, 'utf8') > 28) {
      throw new InvalidMemoError('Memo must be 28 bytes or fewer');
    }

    return {
      sdkMemo: Memo.text(trimmedMemo),
      value: trimmedMemo,
    };
  }

  private convertUsdcToStroops(amountUsdc: string): bigint {
    if (typeof amountUsdc !== 'string') {
      throw new InvalidAmountError('Amount must be a string');
    }

    if (!/^\d+\.\d{7}$/.test(amountUsdc)) {
      throw new InvalidAmountError(
        'Amount must have exactly 7 decimal places (e.g., "100.0000000")'
      );
    }

    const [wholePart, fractionalPart] = amountUsdc.split('.');
    const amountStroops =
      BigInt(wholePart) * TransactionBuilderService.USDC_STROOPS_MULTIPLIER +
      BigInt(fractionalPart);

    if (amountStroops <= 0n) {
      throw new InvalidAmountError('Amount must be greater than zero');
    }

    if (amountStroops > TransactionBuilderService.MAX_USDC_STROOPS) {
      throw new InvalidAmountError('Amount exceeds maximum limit of 1,000,000,000 USDC');
    }

    return amountStroops;
  }

  private mapLoadAccountError(accountId: string, error: unknown): Error {
    if (error instanceof SequenceAllocationError) {
      return new NetworkError(error.message);
    }

    const message = this.getErrorMessage(error).toLowerCase();

    if (
      message.includes('404') ||
      message.includes('not found') ||
      message.includes('resource missing')
    ) {
      return new SourceAccountNotFoundError(accountId);
    }

    return new NetworkError(
      `Failed to load source account from Stellar network: ${this.getErrorMessage(error)}`
    );
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message.trim()) {
      return error.message;
    }

    if (typeof error === 'string' && error.trim()) {
      return error;
    }

    return 'Unknown error';
  }

  private async withSequenceAllocationTimeout(allocation: Promise<bigint>): Promise<bigint> {
    let timeoutId: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        allocation,
        new Promise<bigint>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(
              new SequenceAllocationError(
                'Timed out while reserving a durable Stellar sequence number'
              )
            );
          }, this.options.sequenceAllocationTimeoutMs ?? 5_000);
        }),
      ]);
    } catch (error) {
      if (error instanceof SequenceAllocationError) {
        throw error;
      }
      throw new SequenceAllocationError(
        `Failed to reserve a durable Stellar sequence number: ${this.getErrorMessage(error)}`
      );
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }
}