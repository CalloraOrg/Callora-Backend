export type VaultId = string;

export interface Vault {
  id: VaultId;
  userId: string;
  contractId: string;
  network: string;
  balanceSnapshot: bigint;
  lastSyncedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateVaultInput {
  userId: string;
  contractId: string;
  network: string;
}

export interface VaultRepository {
  create(userId: string, contractId: string, network: string): Promise<Vault>;
  findByUserId(userId: string, network: string): Promise<Vault | null>;
  updateBalanceSnapshot(id: VaultId, balance: bigint, lastSyncedAt: Date): Promise<Vault>;
}

export class DuplicateVaultError extends Error {
  constructor(userId: string, network: string) {
    super(`Vault already exists for user "${userId}" on network "${network}".`);
    this.name = 'DuplicateVaultError';
  }
}

export class VaultNotFoundError extends Error {
  constructor(id: VaultId) {
    super(`Vault "${id}" was not found.`);
    this.name = 'VaultNotFoundError';
  }
}

const createVaultKey = (userId: string, network: string): string =>
  `${userId}::${network}`;

const cloneDate = (value: Date | null): Date | null =>
  value ? new Date(value.getTime()) : null;

const cloneVault = (vault: Vault): Vault => ({
  ...vault,
  lastSyncedAt: cloneDate(vault.lastSyncedAt),
  createdAt: new Date(vault.createdAt.getTime()),
  updatedAt: new Date(vault.updatedAt.getTime()),
});

export class InMemoryVaultRepository implements VaultRepository {
  private readonly vaultsById = new Map<VaultId, Vault>();
  private readonly vaultIdByUserAndNetwork = new Map<string, VaultId>();
  private nextId = 1;

  async create(userId: string, contractId: string, network: string): Promise<Vault> {
    const key = createVaultKey(userId, network);
    if (this.vaultIdByUserAndNetwork.has(key)) {
      throw new DuplicateVaultError(userId, network);
    }

    const now = new Date();
    const vault: Vault = {
      id: String(this.nextId++),
      userId,
      contractId,
      network,
      balanceSnapshot: 0n,
      lastSyncedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    this.vaultsById.set(vault.id, vault);
    this.vaultIdByUserAndNetwork.set(key, vault.id);

    return cloneVault(vault);
  }

  async findByUserId(userId: string, network: string): Promise<Vault | null> {
    const key = createVaultKey(userId, network);
    const vaultId = this.vaultIdByUserAndNetwork.get(key);

    if (!vaultId) {
      return null;
    }

    const vault = this.vaultsById.get(vaultId);
    return vault ? cloneVault(vault) : null;
  }

  async updateBalanceSnapshot(
    id: VaultId,
    balance: bigint,
    lastSyncedAt: Date
  ): Promise<Vault> {
    if (balance < 0n) {
      throw new Error('balanceSnapshot must be a non-negative integer in smallest units.');
    }

    const existingVault = this.vaultsById.get(id);
    if (!existingVault) {
      throw new VaultNotFoundError(id);
    }

    const updatedVault: Vault = {
      ...existingVault,
      balanceSnapshot: balance,
      lastSyncedAt: new Date(lastSyncedAt.getTime()),
      updatedAt: new Date(),
    };

    this.vaultsById.set(id, updatedVault);
    return cloneVault(updatedVault);
  }
}

export interface VaultQueryResultRow {
  id: string | number;
  user_id: string | number;
  stellar_vault_contract_id: string;
  network: string;
  balance_snapshot: string | number | bigint;
  last_synced_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface VaultQueryable {
  query<R = VaultQueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount?: number | null }>;
}

const toDate = (val: Date | string): Date =>
  val instanceof Date ? new Date(val.getTime()) : new Date(val);

const mapVaultRow = (row: VaultQueryResultRow): Vault => ({
  id: String(row.id),
  userId: String(row.user_id),
  contractId: row.stellar_vault_contract_id,
  network: row.network,
  balanceSnapshot:
    typeof row.balance_snapshot === 'bigint'
      ? row.balance_snapshot
      : BigInt(Math.trunc(Number(row.balance_snapshot))),
  lastSyncedAt: row.last_synced_at ? toDate(row.last_synced_at) : null,
  createdAt: toDate(row.created_at),
  updatedAt: toDate(row.updated_at),
});

const isUniqueViolation = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: string }).code;
  if (code === '23505') return true;
  const msg = (err as { message?: string }).message ?? '';
  return /duplicate key|unique constraint/i.test(msg);
};

export class PgVaultRepository implements VaultRepository {
  constructor(private readonly db: VaultQueryable) {}

  async create(userId: string, contractId: string, network: string): Promise<Vault> {
    try {
      const result = await this.db.query<VaultQueryResultRow>(
        `INSERT INTO vaults (user_id, stellar_vault_contract_id, network, balance_snapshot, last_synced_at, created_at, updated_at)
         VALUES ($1, $2, $3, 0, NULL, NOW(), NOW())
         RETURNING id, user_id, stellar_vault_contract_id, network, balance_snapshot, last_synced_at, created_at, updated_at`,
        [userId, contractId, network],
      );
      return mapVaultRow(result.rows[0]);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new DuplicateVaultError(userId, network);
      }
      throw err;
    }
  }

  async findByUserId(userId: string, network: string): Promise<Vault | null> {
    const result = await this.db.query<VaultQueryResultRow>(
      `SELECT id, user_id, stellar_vault_contract_id, network, balance_snapshot, last_synced_at, created_at, updated_at
       FROM vaults
       WHERE user_id = $1 AND network = $2
       LIMIT 1`,
      [userId, network],
    );
    if (result.rows.length === 0) {
      return null;
    }
    return mapVaultRow(result.rows[0]);
  }

  async updateBalanceSnapshot(
    id: VaultId,
    balance: bigint,
    lastSyncedAt: Date,
  ): Promise<Vault> {
    if (balance < 0n) {
      throw new Error('balanceSnapshot must be a non-negative integer in smallest units.');
    }

    const numericId = Number(id);
    if (!Number.isInteger(numericId) || numericId <= 0) {
      throw new VaultNotFoundError(id);
    }

    const result = await this.db.query<VaultQueryResultRow>(
      `UPDATE vaults
       SET balance_snapshot = $2,
           last_synced_at = $3,
           updated_at = NOW()
       WHERE id = $1
       RETURNING id, user_id, stellar_vault_contract_id, network, balance_snapshot, last_synced_at, created_at, updated_at`,
      [numericId, balance.toString(), new Date(lastSyncedAt.getTime())],
    );

    if (result.rows.length === 0) {
      throw new VaultNotFoundError(id);
    }

    return mapVaultRow(result.rows[0]);
  }
}

