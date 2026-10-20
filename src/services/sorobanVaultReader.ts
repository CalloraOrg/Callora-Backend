import {
  Account,
  Address,
  Contract,
  Keypair,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import type { StellarNetwork } from '../config/index.js';

export interface OnchainVaultState {
  balance: bigint;
  maxDeduct: bigint;
  paused: boolean;
  usdcToken: string;
  settlement: string;
  ledger: number;
}

export interface VaultStateReader {
  readVault(contractId: string, network: StellarNetwork): Promise<OnchainVaultState>;
}

type RpcServer = InstanceType<typeof rpc.Server>;

const VIEW_METHODS = [
  'balance',
  'get_max_deduct',
  'is_paused',
  'get_usdc_token',
  'get_settlement',
] as const;

export class SorobanVaultReader implements VaultStateReader {
  private readonly cache = new Map<
    string,
    { expiresAt: number; state: OnchainVaultState }
  >();
  private readonly inFlight = new Map<string, Promise<OnchainVaultState>>();

  constructor(
    private readonly serverForNetwork: (network: StellarNetwork) => RpcServer,
    private readonly networkPassphrases: Record<StellarNetwork, string>,
    private readonly cacheTtlMs = 10_000,
    private readonly timeoutMs = 2_000,
  ) {}

  async readVault(
    contractId: string,
    network: StellarNetwork,
  ): Promise<OnchainVaultState> {
    const key = `${network}:${contractId}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return { ...cached.state };
    }

    const pending = this.inFlight.get(key);
    if (pending) {
      return { ...(await pending) };
    }

    const request = this.loadVault(contractId, network);
    this.inFlight.set(key, request);
    try {
      const state = await request;
      this.cache.set(key, {
        state,
        expiresAt: Date.now() + this.cacheTtlMs,
      });
      return { ...state };
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async loadVault(
    contractId: string,
    network: StellarNetwork,
  ): Promise<OnchainVaultState> {
    const server = this.serverForNetwork(network);
    const contract = new Contract(contractId);
    const sourceAccount = new Account(Keypair.random().publicKey(), '0');
    const result = await Promise.all(
      VIEW_METHODS.map((method) =>
        this.withTimeout(
          this.simulateView(server, contract, sourceAccount, method, network),
        ),
      ),
    );
    const [balance, maxDeduct, paused, usdcToken, settlement] = result.map(
      (entry) => entry.value,
    );

    if (typeof paused !== 'boolean') {
      throw new Error('Vault is_paused view returned a non-boolean value.');
    }

    return {
      balance: this.toBigInt(balance, 'balance'),
      maxDeduct: this.toBigInt(maxDeduct, 'get_max_deduct'),
      paused,
      usdcToken: this.toAddressString(usdcToken, 'get_usdc_token'),
      settlement: this.toAddressString(settlement, 'get_settlement'),
      ledger: Math.max(...result.map((entry) => entry.ledger)),
    };
  }

  private async simulateView(
    server: RpcServer,
    contract: Contract,
    sourceAccount: Account,
    method: (typeof VIEW_METHODS)[number],
    network: StellarNetwork,
  ): Promise<{ value: unknown; ledger: number }> {
    const transaction = new TransactionBuilder(sourceAccount, {
      fee: '100',
      networkPassphrase: this.networkPassphrases[network],
    })
      .addOperation(contract.call(method))
      .setTimeout(30)
      .build();
    const simulation = await server.simulateTransaction(transaction);
    if ('error' in simulation) {
      throw new Error(`Vault ${method} simulation failed: ${simulation.error}`);
    }
    if (!simulation.result) {
      throw new Error(`Vault ${method} simulation returned no result.`);
    }

    return {
      value: scValToNative(simulation.result.retval),
      ledger: simulation.latestLedger,
    };
  }

  private async withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timeoutId: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error('Soroban vault RPC request timed out.')),
            this.timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  private toBigInt(value: unknown, method: string): bigint {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number' && Number.isSafeInteger(value)) {
      return BigInt(value);
    }
    throw new Error(`Vault ${method} view returned an invalid integer.`);
  }

  private toAddressString(value: unknown, method: string): string {
    if (typeof value === 'string') return value;
    if (
      value &&
      typeof value === 'object' &&
      'toString' in value &&
      typeof value.toString === 'function'
    ) {
      return value.toString();
    }
    throw new Error(`Vault ${method} view returned an invalid address.`);
  }
}

export function createSorobanVaultReader(
  networks: Record<
    StellarNetwork,
    { sorobanRpcUrl: string; networkPassphrase: string }
  >,
  timeoutMs = 2_000,
  createServer: (url: string, timeoutMs: number) => RpcServer = (
    url,
    timeout,
  ) => new rpc.Server(url, { timeout }),
): SorobanVaultReader {
  const servers = new Map<StellarNetwork, RpcServer>();
  return new SorobanVaultReader(
    (network) => {
      let server = servers.get(network);
      if (!server) {
        server = createServer(networks[network].sorobanRpcUrl, timeoutMs);
        servers.set(network, server);
      }
      return server;
    },
    {
      testnet: networks.testnet.networkPassphrase,
      mainnet: networks.mainnet.networkPassphrase,
    },
    10_000,
    timeoutMs,
  );
}

export function contractInstanceLedgerKey(contractId: string): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
}
