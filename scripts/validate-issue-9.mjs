import fs from 'node:fs';
import path from 'node:path';

const cwd = process.cwd();
const upPath = path.join(cwd, 'migrations', '0001_create_api_keys_and_vaults.up.sql');
const downPath = path.join(cwd, 'migrations', '0001_create_api_keys_and_vaults.down.sql');

function assertMatch(sql, regex, message) {
  if (!regex.test(sql)) {
    throw new Error(message);
  }
}

function assertNoMatch(sql, regex, message) {
  if (regex.test(sql)) {
    throw new Error(message);
  }
}

const up = fs.readFileSync(upPath, 'utf8');
const down = fs.readFileSync(downPath, 'utf8');

assertMatch(up, /create table api_keys/i, 'api_keys table is missing');
assertMatch(up, /\buser_id\b/i, 'api_keys.user_id is missing');
assertMatch(up, /\bapi_id\b/i, 'api_keys.api_id is missing');
assertMatch(up, /\bkey_hash\b/i, 'api_keys.key_hash is missing');
assertMatch(up, /\bprefix\b/i, 'api_keys.prefix is missing');
assertMatch(up, /\bscopes\b/i, 'api_keys.scopes is missing');
assertMatch(up, /\brate_limit_per_minute\b/i, 'api_keys.rate_limit_per_minute is missing');
assertMatch(up, /\bcreated_at\b/i, 'api_keys.created_at is missing');
assertMatch(up, /\blast_used_at\b/i, 'api_keys.last_used_at is missing');
assertMatch(up, /unique\s*\(\s*user_id\s*,\s*api_id\s*\)/i, 'api_keys unique(user_id, api_id) is missing');
assertMatch(
  up,
  /create index idx_api_keys_user_prefix on api_keys\s*\(\s*user_id\s*,\s*prefix\s*\)/i,
  'api_keys index(user_id, prefix) is missing'
);
assertNoMatch(up, /\bapi_key\b/i, 'raw api_key column detected');
assertNoMatch(up, /\braw_key\b/i, 'raw_key column detected');

assertMatch(up, /create table vaults/i, 'vaults table is missing');
assertMatch(up, /\buser_id\b/i, 'vaults.user_id is missing');
assertMatch(up, /\bstellar_vault_contract_id\b/i, 'vaults.stellar_vault_contract_id is missing');
assertMatch(up, /\bnetwork\b/i, 'vaults.network is missing');
assertMatch(up, /\bbalance_snapshot\b/i, 'vaults.balance_snapshot is missing');
assertMatch(up, /\blast_synced_at\b/i, 'vaults.last_synced_at is missing');
assertMatch(up, /\bcreated_at\b/i, 'vaults.created_at is missing');
assertMatch(up, /\bupdated_at\b/i, 'vaults.updated_at is missing');
assertMatch(up, /unique\s*\(\s*user_id\s*,\s*network\s*\)/i, 'vaults unique(user_id, network) is missing');

assertMatch(down, /drop table if exists vaults/i, 'down migration must drop vaults');
assertMatch(down, /drop table if exists api_keys/i, 'down migration must drop api_keys');

console.log('Issue #9 migration validation passed.');
