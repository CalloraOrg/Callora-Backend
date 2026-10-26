import { createHash } from "node:crypto";
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
} from "@stellar/stellar-sdk";
import type { Transaction } from "@stellar/stellar-sdk";
import type { SimulationDetails } from "../lib/simulationDiagnostics.js";
import type { VaultRepository } from "../repositories/vaultRepository.js";
import type {
  SorobanBalanceResult,
  SorobanClient,
  SorobanDeductResult,
} from "./billing.js";
import {
  SorobanRpcError,
  classifySorobanRpcError,
  normalizeSorobanBillingError,
} from "./sorobanBilling.js";

/**
 * Real Soroban billing client.
 *
 * Implements the `SorobanClient` interface against the deployed vault ABI
 * (`CalloraOrg/Callora-Contracts` `contracts/vault`):
 *
 * - `balance(env) -> i128` takes no arguments; the result is decoded with
 *   `scValToNative` and returned as a decimal string of contract units.
 * - `deduct(env, caller: Address, amount: i128, request_id: u64)` is built as
 *   a real `invokeHostFunction` operation, simulated and assembled with
 *   `rpc.assembleTransaction`, signed with the backend's authorized-caller
 *   key (`SOROBAN_BILLING_BACKEND_SECRET_KEY`), submitted with
 *   `sendTransaction`, and confirmed by polling `getTransaction` until the
 *   bounded deadline.
 *
 * Error mapping (stable categories consumed by `BillingService` and the
 * billing routes):
 *
 * - `VaultError::InsufficientBalance` (5) → `INSUFFICIENT_BALANCE`
 * - `VaultError::Unauthorized` (3), `VaultError::Paused` (4),
 *   `VaultError::ExceedsMaxDeduct` (7) and any other coded contract failure
 *   → `CONTRACT_ERROR` with the numeric code in `simulationDetails.errorCode`
 * - transport failures → `NETWORK_ERROR`
 * - anything that outlives the polling/RPC budget → `TIMEOUT`
 *
 * Polling budget: every public call runs against a single deadline of
 * `requestTimeoutMs` (the configured `SOROBAN_BILLING_RPC_TIMEOUT_MS`), so
 * one `deductBalance` invocation — simulate, assemble, send and poll — can
 * never outlive `SOROBAN_BILLING_RPC_TIMEOUT_MS × attempts`, the total time
 * `BillingService` may spend on the HTTP request.
 *
 * Idempotency: the on-chain `request_id` is the row-scoped
 * `usage_events.onchain_request_id` (allocated from a Postgres sequence when
 * the Phase 1 row is inserted). Every retry of the same row re-sends the same
 * u64. When the vault reports a request id as already processed
 * (`VaultError::DuplicateRequestId` = 29) the client returns the hash of the
 * original submission it made in this process (confirming it first), or, if
 * the original hash is unknown, fails with `TIMEOUT` so the row stays pending
 * for reconciliation instead of being voided or double charged.
 *
 * No secrets are ever logged: failures carry a normalized message only, and
 * the signed XDR is never emitted.
 */

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 200;
const DEDUCT_TIMEBOUND_SECONDS = 60;
const MAX_U64 = 18_446_744_073_709_551_615n;

/** Vault contract error discriminants (Callora-Contracts `src/errors.rs`). */
export const VAULT_ERROR_NAMES = {
  3: "Unauthorized",
  4: "Paused",
  5: "InsufficientBalance",
  7: "ExceedsMaxDeduct",
  29: "DuplicateRequestId",
} as const;

const INSUFFICIENT_BALANCE_CODE = 5;
const DUPLICATE_REQUEST_ID_CODE = 29;

const CONTRACT_ERROR_PATTERN = /Error\(\s*Contract\s*,\s*#(\d+)\s*\)/;

/**
 * Thin view of `rpc.Server` so tests can stub the RPC without the network.
 * The real `rpc.Server` satisfies it structurally.
 */
export interface SorobanVaultBillingServer {
  getAccount(address: string): Promise<Account>;
  simulateTransaction(
    tx: Transaction,
  ): Promise<rpc.Api.SimulateTransactionResponse>;
  sendTransaction(
    tx: Transaction,
  ): Promise<rpc.Api.SendTransactionResponse>;
  getTransaction(hash: string): Promise<rpc.Api.GetTransactionResponse>;
}

export interface SorobanVaultBillingClientOptions {
  /** Soroban RPC endpoint, e.g. https://soroban-testnet.stellar.org */
  rpcUrl: string;
  /** Fallback vault contract id (single-vault deployments). */
  contractId: string;
  /** Backend authorized-caller secret (SOROBAN_BILLING_BACKEND_SECRET_KEY). */
  secretKey: string;
  /** Network passphrase, e.g. "Test SDF Network ; September 2015". */
  networkPassphrase: string;
  /** Network name used for VaultRepository lookups (default "testnet"). */
  network?: string;
  /** Optional per-user vault lookup; falls back to `contractId`. */
  vaultRepository?: Pick<VaultRepository, "findByUserId">;
  /** Total RPC/polling budget per call (SOROBAN_BILLING_RPC_TIMEOUT_MS). */
  requestTimeoutMs?: number;
  /** Delay between getTransaction polls (default 200ms). */
  pollIntervalMs?: number;
  /** Balance view name (SOROBAN_BILLING_BALANCE_FN, default "balance"). */
  balanceFunctionName?: string;
  /** Deduct entrypoint (SOROBAN_BILLING_DEDUCT_FN, default "deduct"). */
  deductFunctionName?: string;
  /** Injected RPC server (tests). Defaults to `new rpc.Server(rpcUrl)`. */
  server?: SorobanVaultBillingServer;
}

/** Extract the numeric discriminant from a `Error(Contract, #N)` message. */
export function extractVaultErrorCode(message: string): number | undefined {
  const match = CONTRACT_ERROR_PATTERN.exec(message);
  if (!match) return undefined;
  const code = Number(match[1]);
  return Number.isInteger(code) ? code : undefined;
}

/**
 * Resolve the u64 that will be sent as `request_id`.
 *
 * Prefers the row-scoped `onchain_request_id` allocated from the Postgres
 * sequence; falls back to a deterministic u64 derived from the idempotency
 * key so direct callers still retry with the same id. Zero — the vault's
 * "no idempotency" sentinel — is never produced.
 */
export function resolveOnchainRequestId(
  onchainRequestId: string | undefined,
  idempotencyKey: string | undefined,
): bigint {
  if (onchainRequestId !== undefined && onchainRequestId !== null && onchainRequestId !== "") {
    const id = BigInt(onchainRequestId);
    if (id <= 0n || id > MAX_U64) {
      throw new Error(
        `onchain_request_id must be a u64 in [1, 2^64-1], received "${onchainRequestId}"`,
      );
    }
    return id;
  }

  if (idempotencyKey !== undefined && idempotencyKey !== "") {
    const digest = createHash("sha256").update(idempotencyKey).digest();
    // Map the digest into [1, 2^64-1] — never 0.
    return (digest.readBigUInt64BE(0) % (MAX_U64 - 1n)) + 1n;
  }

  throw new Error(
    "deductBalance requires an onchain_request_id or an idempotencyKey to derive the vault u64 request id",
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SorobanVaultBillingClient implements SorobanClient {
  private readonly server: SorobanVaultBillingServer;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly network: string;
  private cachedKeypair: Keypair | undefined;
  /** Hashes of submissions whose outcome is not yet known, keyed by u64 id. */
  private readonly submittedTxByRequestId = new Map<string, string>();

  constructor(private readonly options: SorobanVaultBillingClientOptions) {
    this.server =
      options.server ?? new rpc.Server(options.rpcUrl, { allowHttp: true });
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.network = options.network ?? "testnet";
  }

  private keypair(): Keypair {
    if (!this.cachedKeypair) {
      this.cachedKeypair = Keypair.fromSecret(this.options.secretKey);
    }
    return this.cachedKeypair;
  }

  private get backendPublicKey(): string {
    return this.keypair().publicKey();
  }

  /**
   * Resolve the vault contract for a user: their registered vault from
   * `VaultRepository.findByUserId`, falling back to the configured
   * `SOROBAN_BILLING_CONTRACT_ID` for single-vault deployments.
   */
  private async resolveContractId(userId: string): Promise<string> {
    const repository = this.options.vaultRepository;
    if (!repository) return this.options.contractId;

    try {
      const vault = await repository.findByUserId(userId, this.network);
      if (vault?.contractId) return vault.contractId;
    } catch {
      // A lookup failure must not hard-block billing; fall back to the
      // configured single-vault contract id below.
    }
    return this.options.contractId;
  }

  /**
   * Run one RPC call under the shared deadline. Anything that outlives the
   * budget becomes `TIMEOUT`; transport failures become `NETWORK_ERROR`
   * (or a better guess from the message).
   */
  private async rpcCall<T>(label: string, deadline: number, fn: () => Promise<T>): Promise<T> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new SorobanRpcError(
        `${label} exceeded the ${this.timeoutMs}ms Soroban RPC budget`,
        "TIMEOUT",
      );
    }

    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new SorobanRpcError(
                  `${label} timed out after ${remaining}ms`,
                  "TIMEOUT",
                ),
              ),
            remaining,
          );
        }),
      ]);
    } catch (error) {
      if (error instanceof SorobanRpcError) throw error;
      const message = normalizeSorobanBillingError(
        error,
        `${label} failed: Soroban RPC request failed`,
      );
      throw new SorobanRpcError(message, classifySorobanRpcError(message));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Map a failed simulation / contract rejection to a stable category. */
  private mapContractFailure(message: string): SorobanRpcError {
    const code = extractVaultErrorCode(message);
    const details: SimulationDetails = {
      errorCode: code !== undefined ? code : message.slice(0, 300),
      errorMessage: message.slice(0, 300),
    };

    if (code === INSUFFICIENT_BALANCE_CODE) {
      return new SorobanRpcError(message, "INSUFFICIENT_BALANCE", details);
    }
    if (code !== undefined) {
      // Paused (4), Unauthorized (3), ExceedsMaxDeduct (7) and any other
      // typed VaultError → CONTRACT_ERROR with the numeric code exposed.
      return new SorobanRpcError(message, "CONTRACT_ERROR", details);
    }
    return new SorobanRpcError(message, classifySorobanRpcError(message), details);
  }

  async getBalance(userId: string): Promise<SorobanBalanceResult> {
    const deadline = Date.now() + this.timeoutMs;
    const contractId = await this.resolveContractId(userId);
    const functionName = this.options.balanceFunctionName ?? "balance";

    const contract = new Contract(contractId);
    // balance(env) takes no arguments; a vacant source account is fine for a
    // read-only simulation.
    const source = new Account(this.backendPublicKey, "0");
    const transaction = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: this.options.networkPassphrase,
    })
      .addOperation(contract.call(functionName))
      .setTimeout(30)
      .build();

    const simulation = await this.rpcCall(
      `simulate ${functionName}`,
      deadline,
      () => this.server.simulateTransaction(transaction),
    );

    if (rpc.Api.isSimulationError(simulation)) {
      throw this.mapContractFailure(simulation.error);
    }
    if (!simulation.result) {
      throw new SorobanRpcError(
        `${functionName} simulation returned no result`,
        "NETWORK_ERROR",
      );
    }

    const native = scValToNative(simulation.result.retval);
    if (typeof native !== "bigint") {
      throw new SorobanRpcError(
        `${functionName} did not return an i128 value`,
        "CONTRACT_ERROR",
      );
    }
    if (native < 0n) {
      throw new SorobanRpcError(
        `${functionName} returned a negative balance`,
        "CONTRACT_ERROR",
      );
    }

    return { balance: native.toString() };
  }

  async deductBalance(
    userId: string,
    amount: string,
    idempotencyKey?: string,
    onchainRequestId?: string,
  ): Promise<SorobanDeductResult> {
    const requestId = resolveOnchainRequestId(onchainRequestId, idempotencyKey);
    const requestKey = requestId.toString();
    const units = BigInt(amount);
    if (units <= 0n) {
      throw new Error(`deduct amount must be positive, received "${amount}"`);
    }

    const deadline = Date.now() + this.timeoutMs;
    const contractId = await this.resolveContractId(userId);
    const functionName = this.options.deductFunctionName ?? "deduct";

    // 1. Load the backend account for a fresh sequence number.
    const account = await this.rpcCall("load backend account", deadline, () =>
      this.server.getAccount(this.backendPublicKey),
    );

    // 2. Build deduct(caller: Address, amount: i128, request_id: u64).
    const contract = new Contract(contractId);
    const transaction = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.options.networkPassphrase,
    })
      .addOperation(
        contract.call(
          functionName,
          new Address(this.backendPublicKey).toScVal(),
          nativeToScVal(units, { type: "i128" }),
          nativeToScVal(requestId, { type: "u64" }),
        ),
      )
      .setTimeout(DEDUCT_TIMEBOUND_SECONDS)
      .build();

    // 3. Simulate and assemble (footprint, resource fee, auth entries).
    const simulation = await this.rpcCall(`simulate ${functionName}`, deadline, () =>
      this.server.simulateTransaction(transaction),
    );

    if (rpc.Api.isSimulationError(simulation)) {
      const failure = this.mapContractFailure(simulation.error);
      const code =
        typeof failure.simulationDetails?.errorCode === "number"
          ? failure.simulationDetails.errorCode
          : undefined;

      if (code === DUPLICATE_REQUEST_ID_CODE) {
        // The vault already processed this request id: never double charge.
        return this.resolveDuplicate(requestId, deadline, failure);
      }
      // Nothing was submitted.
      throw failure;
    }

    let prepared: Transaction;
    try {
      prepared = rpc.assembleTransaction(transaction, simulation).build();
    } catch (error) {
      const message = normalizeSorobanBillingError(
        error,
        "Failed to assemble the deduct transaction",
      );
      throw new SorobanRpcError(message, classifySorobanRpcError(message));
    }

    // 4. Sign with the backend's authorized-caller key.
    prepared.sign(this.keypair());

    // 5. Submit.
    const sent = await this.rpcCall("send deduct transaction", deadline, () =>
      this.server.sendTransaction(prepared),
    );

    if (sent.status === "TRY_AGAIN_LATER") {
      // Transient by design: BillingService retries with the same request id.
      throw new SorobanRpcError(
        "sendTransaction returned TRY_AGAIN_LATER",
        "NETWORK_ERROR",
      );
    }
    if (sent.status === "ERROR") {
      let resultName = "";
      try {
        resultName = sent.errorResult?.result().switch().name ?? "";
      } catch {
        resultName = "";
      }
      throw new SorobanRpcError(
        `sendTransaction failed${resultName ? `: ${resultName}` : ""}`,
        "NETWORK_ERROR",
      );
    }

    // PENDING (or DUPLICATE — an earlier submission of the same envelope):
    // remember the hash so a retry that hits DuplicateRequestId can resolve
    // the original transaction instead of guessing.
    const hash = sent.hash;
    this.submittedTxByRequestId.set(requestKey, hash);

    // 6. Poll for the final status under the shared deadline.
    const txHash = await this.pollForReceipt(hash, deadline);
    this.submittedTxByRequestId.delete(requestKey);
    return { txHash };
  }

  /**
   * The vault reports this request id as already processed. Confirm the
   * submission we made earlier in this process and return its hash; if we
   * have no hash to check, surface an unknown-outcome TIMEOUT so the row
   * stays pending for reconciliation (never voided, never double charged).
   */
  private async resolveDuplicate(
    requestId: bigint,
    deadline: number,
    failure: SorobanRpcError,
  ): Promise<SorobanDeductResult> {
    const knownHash = this.submittedTxByRequestId.get(requestId.toString());
    if (!knownHash) {
      throw new SorobanRpcError(
        `Vault reports request id ${requestId} as already processed; the original transaction hash is unknown in this process`,
        "TIMEOUT",
        failure.simulationDetails,
      );
    }

    const txHash = await this.pollForReceipt(knownHash, deadline);
    this.submittedTxByRequestId.delete(requestId.toString());
    return { txHash };
  }

  /**
   * Poll getTransaction until SUCCESS, FAILED, or the deadline. A NOT_FOUND
   * that persists past the deadline is a TIMEOUT, never a success.
   */
  private async pollForReceipt(hash: string, deadline: number): Promise<string> {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new SorobanRpcError(
          `Transaction ${hash} not confirmed within the ${this.timeoutMs}ms polling budget`,
          "TIMEOUT",
        );
      }

      const response = await this.rpcCall(`poll transaction ${hash}`, deadline, () =>
        this.server.getTransaction(hash),
      );

      if (response.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        return response.txHash || hash;
      }
      if (response.status === rpc.Api.GetTransactionStatus.FAILED) {
        throw new SorobanRpcError(
          `Transaction ${hash} failed on-chain`,
          "CONTRACT_ERROR",
          { errorMessage: `Transaction ${hash} failed on-chain` },
        );
      }

      // NOT_FOUND — still pending. Wait, then re-check until the deadline.
      await sleep(Math.min(this.pollIntervalMs, Math.max(remaining, 0)));
    }
  }
}

export function createSorobanVaultBillingClient(
  options: SorobanVaultBillingClientOptions,
): SorobanVaultBillingClient {
  return new SorobanVaultBillingClient(options);
}
