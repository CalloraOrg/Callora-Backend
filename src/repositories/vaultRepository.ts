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

    return { ...vault };
  }

  async findByUserId(userId: string, network: string): Promise<Vault | null> {
    const key = createVaultKey(userId, network);
    const vaultId = this.vaultIdByUserAndNetwork.get(key);

    if (!vaultId) {
      return null;
    }

    const vault = this.vaultsById.get(vaultId);
    return vault ? { ...vault } : null;
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
    return { ...updatedVault };
  }
}
