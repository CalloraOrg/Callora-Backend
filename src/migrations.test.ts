import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const migrationDir = path.join(process.cwd(), 'migrations');
const upMigrationPath = path.join(
  migrationDir,
  '0001_create_api_keys_and_vaults.up.sql'
);
const downMigrationPath = path.join(
  migrationDir,
  '0001_create_api_keys_and_vaults.down.sql'
);

function read(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

describe('Issue #9 migrations', () => {
  it('creates api_keys table with required columns and constraints', () => {
    const sql = read(upMigrationPath);

    assert.match(sql, /create table api_keys/i);
    assert.match(sql, /\buser_id\b/i);
    assert.match(sql, /\bapi_id\b/i);
    assert.match(sql, /\bkey_hash\b/i);
    assert.match(sql, /\bprefix\b/i);
    assert.match(sql, /\bscopes\b/i);
    assert.match(sql, /\brate_limit_per_minute\b/i);
    assert.match(sql, /\bcreated_at\b/i);
    assert.match(sql, /\blast_used_at\b/i);
    assert.match(sql, /unique\s*\(\s*user_id\s*,\s*api_id\s*\)/i);
    assert.match(
      sql,
      /create index idx_api_keys_user_prefix on api_keys\s*\(\s*user_id\s*,\s*prefix\s*\)/i
    );

    assert.doesNotMatch(sql, /\bapi_key\b/i);
    assert.doesNotMatch(sql, /\braw_key\b/i);
  });

  it('creates vaults table with required columns and constraints', () => {
    const sql = read(upMigrationPath);

    assert.match(sql, /create table vaults/i);
    assert.match(sql, /\buser_id\b/i);
    assert.match(sql, /\bstellar_vault_contract_id\b/i);
    assert.match(sql, /\bnetwork\b/i);
    assert.match(sql, /\bbalance_snapshot\b/i);
    assert.match(sql, /\blast_synced_at\b/i);
    assert.match(sql, /\bcreated_at\b/i);
    assert.match(sql, /\bupdated_at\b/i);
    assert.match(sql, /unique\s*\(\s*user_id\s*,\s*network\s*\)/i);
  });

  it('includes rollback migration for both tables', () => {
    const sql = read(downMigrationPath);

    assert.match(sql, /drop table if exists vaults/i);
    assert.match(sql, /drop table if exists api_keys/i);
  });
});
