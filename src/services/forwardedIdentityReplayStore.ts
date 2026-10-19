/** Atomically reserve a signature digest through its inclusive validity window. */
export interface ForwardedIdentityReplayStore {
  claim(signature: string, expiresAt: number, now: number): Promise<boolean>;
}

/** Bounded LRU. Expired entries are evicted; live entries are never sacrificed. */
export class MemoryForwardedIdentityReplayStore implements ForwardedIdentityReplayStore {
  private readonly entries = new Map<string, number>();

  constructor(private readonly capacity = 10_000) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("Invalid replay capacity");
  }

  async claim(signature: string, expiresAt: number, now: number): Promise<boolean> {
    for (const [key, expiry] of this.entries) {
      if (expiry < now) this.entries.delete(key);
    }
    const existing = this.entries.get(signature);
    if (existing !== undefined) {
      this.entries.delete(signature);
      this.entries.set(signature, existing);
      return false;
    }
    // Fail closed: evicting a live LRU entry would make its signature replayable.
    if (this.entries.size >= this.capacity) throw new Error("Replay cache capacity exceeded");
    this.entries.set(signature, expiresAt);
    return true;
  }
}

export interface ReplayQuery {
  (sql: string, values: unknown[]): Promise<{ rows: unknown[] }>;
}

/** Uses the primary pool, with a unique key making cross-instance claims atomic. */
export class PostgresForwardedIdentityReplayStore implements ForwardedIdentityReplayStore {
  constructor(private readonly query: ReplayQuery) {}

  async claim(signature: string, expiresAt: number, now: number): Promise<boolean> {
    await this.query(
      "DELETE FROM forwarded_identity_replays WHERE expires_at < $1",
      [new Date(now)],
    );
    const result = await this.query(
      `INSERT INTO forwarded_identity_replays (signature, expires_at) VALUES ($1, $2)
       ON CONFLICT (signature) DO UPDATE SET expires_at = EXCLUDED.expires_at
       WHERE forwarded_identity_replays.expires_at < $3
       RETURNING signature`,
      [signature, new Date(expiresAt), new Date(now)],
    );
    return result.rows.length === 1;
  }
}

let configured: { key: string; store: ForwardedIdentityReplayStore } | undefined;
export function getForwardedIdentityReplayStore(): ForwardedIdentityReplayStore {
  const mode = process.env.FORWARDED_IDENTITY_REPLAY_STORE ?? "memory";
  const capacity = Number(process.env.FORWARDED_IDENTITY_REPLAY_MAX_ENTRIES ?? 10_000);
  const key = `${mode}:${capacity}`;
  if (configured?.key === key) return configured.store;
  if (mode !== "memory" && mode !== "postgres") throw new Error("Invalid replay store");
  const store = mode === "postgres"
    ? new PostgresForwardedIdentityReplayStore(async (sql, values) => {
        const { query } = await import("../db.js");
        return query(sql, values);
      })
    : new MemoryForwardedIdentityReplayStore(capacity);
  configured = { key, store };
  return store;
}
