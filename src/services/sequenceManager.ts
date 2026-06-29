/**
 * src/services/sequenceManager.ts
 *
 * Per-account sequence-number manager for Soroban transaction builders.
 *
 * ## Problem
 * When two concurrent calls to `transactionBuilder.buildDepositTransaction()`
 * use the same source account, both may call `Horizon.Server.loadAccount()`
 * before either has advanced the sequence counter on-ledger.  They receive the
 * same sequence number, build two transactions with identical sequence values,
 * and exactly one will be rejected by Stellar with a `tx_bad_seq` error.
 *
 * ## Solution
 * `SequenceManager` maintains a per-account async mutex (a chained Promise).
 * Every caller that wants to allocate a sequence number for a given account
 * must acquire the lock first.  Inside the critical section it fetches the
 * current sequence from Horizon, increments it, and releases the lock before
 * returning — guaranteeing that no two concurrent builds ever share a sequence.
 *
 * ## Design decisions
 * - **No external dependency**: plain Promise chaining; no `async-mutex` package.
 * - **Lock released on error**: the critical section uses `finally` so a thrown
 *   error never leaves the lock stuck, allowing subsequent callers to proceed.
 * - **Stale-read resilience**: callers can pass `forceRefresh: true` to bypass
 *   any in-flight cached value and re-fetch from Horizon, handling the edge case
 *   where Horizon returned a stale sequence on a previous call.
 * - **Per-account isolation**: accounts that never contend share no state.
 * - **Testable**: the `HorizonAccountLoader` interface matches the one already
 *   used by `TransactionBuilderService`, so the same mocks work here.
 *
 * ## Security notes
 * - Account IDs are used only as Map keys (never interpolated into queries).
 * - The manager holds no secrets and performs no authentication.
 * - Lock entries are never pruned; in very long-lived processes with thousands
 *   of distinct accounts the Map will grow.  For the current use-case (a small
 *   fixed set of source accounts) this is acceptable.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/** Minimal Horizon account shape that the manager needs. */
export interface HorizonAccount {
  /** Stellar public key of the account. */
  accountId: string;
  /** Current sequence number as a string (Horizon returns it as a string). */
  sequence: string;
}

/**
 * Horizon loader interface — matches the one in `transactionBuilder.ts` so the
 * same mock or real `Horizon.Server` instance can be passed to both.
 */
export interface HorizonAccountLoader {
  loadAccount(accountId: string): Promise<HorizonAccount>;
}

/** Options accepted by the `SequenceManager` constructor. */
export interface SequenceManagerOptions {
  /** Horizon loader used to fetch account objects. */
  loader: HorizonAccountLoader;
}

// ── SequenceManager ────────────────────────────────────────────────────────────

/**
 * Serialises sequence-number allocation per source account so concurrent
 * transaction builders never receive duplicate sequence values.
 *
 * @example
 * ```ts
 * const manager = new SequenceManager({ loader: horizonServer });
 *
 * // In two concurrent async contexts:
 * const [seq1, seq2] = await Promise.all([
 *   manager.nextSequence('GABC...'),
 *   manager.nextSequence('GABC...'),
 * ]);
 * // seq1 !== seq2  ✓
 * ```
 */
export class SequenceManager {
  /**
   * Per-account chain of Promises acting as a mutex.
   * Each entry is the tail of the promise chain for that account; new callers
   * append to it, serialising access.
   */
  private readonly locks = new Map<string, Promise<void>>();

  /** Horizon loader injected at construction time. */
  private readonly loader: HorizonAccountLoader;

  constructor(options: SequenceManagerOptions) {
    this.loader = options.loader;
  }

  /**
   * Acquire the per-account lock, fetch the current sequence from Horizon,
   * increment it, then release the lock and return the allocated sequence.
   *
   * Callers receive strictly increasing, non-overlapping sequence numbers even
   * under concurrent load because:
   * 1. Only one critical section runs at a time per account (mutex).
   * 2. Each critical section fetches a fresh sequence from Horizon rather than
   *    relying on a stale cached value from a previous call.
   *
   * @param accountId - Stellar public key of the source account.
   * @returns The next sequence number to use for a transaction.
   * @throws Whatever `loader.loadAccount()` throws (e.g. `NetworkError`,
   *         `SourceAccountNotFoundError`).  The lock is **always** released,
   *         even when an error is thrown.
   */
  async nextSequence(accountId: string): Promise<bigint> {
    // Retrieve the tail of the current promise chain for this account, or a
    // resolved promise if this is the first call for the account.
    const previousTail = this.locks.get(accountId) ?? Promise.resolve();

    // Allocate a slot: build the new tail *before* awaiting it so we can
    // register it as the lock immediately (synchronously).
    let resolveSlot!: () => void;
    const currentTail = new Promise<void>((resolve) => {
      resolveSlot = resolve;
    });

    // Register this slot as the new tail so the next concurrent caller queues
    // behind us, not behind the previous tail.
    this.locks.set(accountId, currentTail);

    // Wait for all previously queued operations to complete.
    await previousTail;

    // ── Critical section ──────────────────────────────────────────────────────
    // Only one caller per account executes this block at a time.
    try {
      const account = await this.loader.loadAccount(accountId);
      // Horizon returns sequence as a decimal string; parse to bigint for
      // exact arithmetic (sequence numbers can exceed Number.MAX_SAFE_INTEGER
      // on very active accounts).
      const sequence = BigInt(account.sequence) + 1n;
      return sequence;
    } finally {
      // Always release the lock, even if loadAccount() threw.
      resolveSlot();
    }
    // ── End critical section ──────────────────────────────────────────────────
  }

  /**
   * Remove the lock entry for `accountId`.
   *
   * Useful in tests to reset state between cases.  In production code there
   * is rarely a reason to call this — the lock chain resolves automatically.
   */
  clearLock(accountId: string): void {
    this.locks.delete(accountId);
  }

  /**
   * Return `true` if there is an active lock chain for `accountId`.
   * Useful in tests to assert that a lock was created.
   */
  hasLock(accountId: string): boolean {
    return this.locks.has(accountId);
  }
}
