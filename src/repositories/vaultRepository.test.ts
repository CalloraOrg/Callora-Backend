import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DuplicateVaultError,
  InMemoryVaultRepository,
  VaultNotFoundError,
} from './vaultRepository.js';

test('create stores a vault with default snapshot values', async () => {
  const repository = new InMemoryVaultRepository();

  const vault = await repository.create('user-1', 'contract-1', 'testnet');

  assert.equal(vault.userId, 'user-1');
  assert.equal(vault.contractId, 'contract-1');
  assert.equal(vault.network, 'testnet');
  assert.equal(vault.balanceSnapshot, 0n);
  assert.equal(vault.lastSyncedAt, null);
  assert.ok(vault.createdAt instanceof Date);
  assert.ok(vault.updatedAt instanceof Date);
});

test('create enforces one vault per user and network', async () => {
  const repository = new InMemoryVaultRepository();
  await repository.create('user-1', 'contract-1', 'testnet');

  await assert.rejects(
    repository.create('user-1', 'contract-2', 'testnet'),
    DuplicateVaultError
  );
});

test('create allows multiple vaults for same user on different networks', async () => {
  const repository = new InMemoryVaultRepository();

  const testnetVault = await repository.create('user-1', 'contract-1', 'testnet');
  const mainnetVault = await repository.create('user-1', 'contract-1', 'mainnet');

  assert.notEqual(testnetVault.id, mainnetVault.id);
});

test('findByUserId returns the matching network vault', async () => {
  const repository = new InMemoryVaultRepository();
  await repository.create('user-1', 'contract-1', 'testnet');
  const mainnetVault = await repository.create('user-1', 'contract-2', 'mainnet');

  const result = await repository.findByUserId('user-1', 'mainnet');

  assert.deepEqual(result, mainnetVault);
});

test('findByUserId returns null when user has no vault for a network', async () => {
  const repository = new InMemoryVaultRepository();
  await repository.create('user-1', 'contract-1', 'testnet');

  const result = await repository.findByUserId('user-1', 'mainnet');

  assert.equal(result, null);
});

test('findByUserId returns null when index is stale', async () => {
  const repository = new InMemoryVaultRepository();
  const vault = await repository.create('user-1', 'contract-1', 'testnet');

  // Simulates storage inconsistency and validates defensive null fallback.
  (repository as unknown as { vaultsById: Map<string, unknown> }).vaultsById.delete(
    vault.id
  );

  const result = await repository.findByUserId('user-1', 'testnet');

  assert.equal(result, null);
});

test('updateBalanceSnapshot updates balance and last synced timestamp', async () => {
  const repository = new InMemoryVaultRepository();
  const vault = await repository.create('user-1', 'contract-1', 'testnet');
  const syncedAt = new Date('2026-02-25T10:00:00.000Z');

  const updated = await repository.updateBalanceSnapshot(vault.id, 15000000n, syncedAt);

  assert.equal(updated.balanceSnapshot, 15000000n);
  assert.deepEqual(updated.lastSyncedAt, syncedAt);
  assert.ok(updated.updatedAt.getTime() >= vault.updatedAt.getTime());
});

test('updateBalanceSnapshot throws for unknown vault id', async () => {
  const repository = new InMemoryVaultRepository();
  const syncedAt = new Date('2026-02-25T10:00:00.000Z');

  await assert.rejects(
    repository.updateBalanceSnapshot('does-not-exist', 100n, syncedAt),
    VaultNotFoundError
  );
});

test('updateBalanceSnapshot rejects negative balances', async () => {
  const repository = new InMemoryVaultRepository();
  const vault = await repository.create('user-1', 'contract-1', 'testnet');
  const syncedAt = new Date('2026-02-25T10:00:00.000Z');

  await assert.rejects(
    repository.updateBalanceSnapshot(vault.id, -1n, syncedAt),
    /non-negative integer/
  );
});
