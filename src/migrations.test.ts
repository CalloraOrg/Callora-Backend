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
const auditUpMigrationPath = path.join(
  migrationDir,
  '0002_create_audit_logs.up.sql'
);
const auditDownMigrationPath = path.join(
  migrationDir,
  '0002_create_audit_logs.down.sql'
);

function read(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

describe('Issue #9 migrations', () => {
  it('creates api_keys table with required columns and constraints', () => {
    const sql = read(upMigrationPath);

    expect(sql).toMatch(/create table api_keys/i);
    expect(sql).toMatch(/\buser_id\b/i);
    expect(sql).toMatch(/\bapi_id\b/i);
    expect(sql).toMatch(/\bkey_hash\b/i);
    expect(sql).toMatch(/\bprefix\b/i);
    expect(sql).toMatch(/\bscopes\b/i);
    expect(sql).toMatch(/\brate_limit_per_minute\b/i);
    expect(sql).toMatch(/\bcreated_at\b/i);
    expect(sql).toMatch(/\blast_used_at\b/i);
    expect(sql).toMatch(/unique\s*\(\s*user_id\s*,\s*api_id\s*\)/i);
    expect(sql).toMatch(
      /create index idx_api_keys_user_prefix on api_keys\s*\(\s*user_id\s*,\s*prefix\s*\)/i
    );

    expect(sql).not.toMatch(/\bapi_key\b/i);
    expect(sql).not.toMatch(/\braw_key\b/i);
  });

  it('creates vaults table with required columns and constraints', () => {
    const sql = read(upMigrationPath);

    expect(sql).toMatch(/create table vaults/i);
    expect(sql).toMatch(/\buser_id\b/i);
    expect(sql).toMatch(/\bstellar_vault_contract_id\b/i);
    expect(sql).toMatch(/\bnetwork\b/i);
    expect(sql).toMatch(/\bbalance_snapshot\b/i);
    expect(sql).toMatch(/\blast_synced_at\b/i);
    expect(sql).toMatch(/\bcreated_at\b/i);
    expect(sql).toMatch(/\bupdated_at\b/i);
    expect(sql).toMatch(/unique\s*\(\s*user_id\s*,\s*network\s*\)/i);
  });

  it('includes rollback migration for both tables', () => {
    const sql = read(downMigrationPath);

    expect(sql).toMatch(/drop table if exists vaults/i);
    expect(sql).toMatch(/drop table if exists api_keys/i);
  });
});

describe('Issue #54 migrations', () => {
  it('creates append-only audit_logs table with required fields and indexes', () => {
    const sql = read(auditUpMigrationPath);

    expect(sql).toMatch(/create table audit_logs/i);
    expect(sql).toMatch(/\bactor_user_id\b/i);
    expect(sql).toMatch(/\baction\b/i);
    expect(sql).toMatch(/\bresource\b/i);
    expect(sql).toMatch(/\bcreated_at\b/i);
    expect(sql).toMatch(/\bip\b/i);

    expect(sql).toMatch(/create index idx_audit_logs_actor_user_id_created_at/i);
    expect(sql).toMatch(/create index idx_audit_logs_action_created_at/i);
    expect(sql).toMatch(/create index idx_audit_logs_resource_created_at/i);

    expect(sql).toMatch(/create trigger trg_prevent_audit_logs_update/i);
    expect(sql).toMatch(/create trigger trg_prevent_audit_logs_delete/i);
  });

  it('includes rollback migration for audit_logs and append-only guards', () => {
    const sql = read(auditDownMigrationPath);

    expect(sql).toMatch(/drop trigger if exists trg_prevent_audit_logs_delete/i);
    expect(sql).toMatch(/drop trigger if exists trg_prevent_audit_logs_update/i);
    expect(sql).toMatch(/drop function if exists prevent_audit_logs_mutation/i);
    expect(sql).toMatch(/drop table if exists audit_logs/i);
  });
});
