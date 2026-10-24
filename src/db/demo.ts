import type Database from "better-sqlite3";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { getEmbeddedAssets } from "../lib/embeddedAssets.js";

export type MigrationDialect = "sqlite" | "postgres" | "both";

/**
 * Explicit migration classification manifest.
 * Used when a migration file does not contain a `-- dialect: <dialect>` header comment.
 * In demo mode, only Postgres-only migrations are skipped.
 */
export const MIGRATION_DIALECT_MANIFEST: Record<string, MigrationDialect> = {
  "0000_initial_apis_tables.sql": "both",
  "0001_create_api_keys_and_vaults.up.sql": "postgres",
  "001_create_usage_events.sql": "postgres",
  "0002_add_expires_at_to_api_keys.up.sql": "postgres",
  "002_create_settlements.sql": "postgres",
  "003_create_revenue_ledger.sql": "postgres",
  "0004_create_developers.sql": "both",
  "004_create_idempotency_store.sql": "postgres",
  "0005_add_api_key_revocation.sql": "postgres",
  "005_add_persistent_store_columns.sql": "postgres",
  "0006_api_key_prefix_unique.sql": "postgres",
  "0007_add_plan_tier_to_api_keys.sql": "postgres",
  "0007_api_key_scopes.sql": "postgres",
  "0008_settlement_status_check.sql": "postgres",
  "0009_quota_notifications_sent.sql": "postgres",
  "0010_create_reconciliation_runs.sql": "both",
  "0011_partition_usage_events.sql": "postgres",
  "0012_api_endpoints_cascade.sql": "both",
  "0013_schema_versions.sql": "both",
  "0014_create_invoices.sql": "postgres",
  "0014_credits.sql": "both",
  "0014_webhook_keys.sql": "both",
  "0015_apis_soft_delete.sql": "both",
  "0016_audit_enrichment.sql": "both",
  "0017_developer_exports.sql": "both",
  "0018_subscriptions.sql": "both",
  "0019_disputes.sql": "both",
  "0020_subscription_retry_policy.sql": "both",
  "0021_plans_table.sql": "both",
  "0022_tamper_evident_audit.sql": "postgres",
  "0023_transaction_sequences.sql": "postgres",
  "0024_hash_api_keys.sql": "postgres",
  "0025_idempotency_store_scope.sql": "postgres",
  "0026_forwarded_identity_replays.sql": "postgres",
  "0027_usage_events_deduction_status.sql": "postgres",
  "0028_idempotency_lease.sql": "postgres",
  "0029_drop_billing_requests_index.sql": "both",
  "0030_usage_events_amount_units.sql": "postgres",
  "0031_settlement_retry_policy.sql": "postgres",
};

/**
 * Determine the dialect for a migration file.
 * A header comment (`-- dialect: sqlite|postgres|both`) takes precedence.
 * Falls back to the manifest, and defaults to "both" (SQLite-applicable).
 */
export function getMigrationDialect(file: string, content: string): MigrationDialect {
  const match = content.match(/--\s*dialect:\s*(sqlite|postgres|both)\b/i);
  if (match) {
    return match[1].toLowerCase() as MigrationDialect;
  }
  if (file in MIGRATION_DIALECT_MANIFEST) {
    return MIGRATION_DIALECT_MANIFEST[file];
  }
  return "both";
}

/**
 * Demo / serverless bootstrap.
 *
 * The `migrations/` folder contains a mix of SQLite and PostgreSQL migrations.
 * In demo mode we apply SQLite-applicable migrations against an ephemeral SQLite
 * database and skip files that are explicitly classified as Postgres-only.
 * Any genuine SQLite failure causes the bootstrap to fail naming the broken file.
 * Then seed an idempotent catalog so the public endpoints return real content.
 */
export function bootstrapDemoDb(sqlite: Database.Database, migrationDir: string): void {
  const embedded = getEmbeddedAssets()?.migrations;
  const files = (embedded ? Object.keys(embedded) : readdirSync(migrationDir))
    .filter((f) => f.endsWith(".sql") && !f.endsWith(".down.sql") && /^\d+/.test(f))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10) || a.localeCompare(b));

  let applied = 0;
  let skipped = 0;
  let failed = 0;

  for (const file of files) {
    const content = embedded ? embedded[file] : readFileSync(join(migrationDir, file), "utf8");
    const dialect = getMigrationDialect(file, content);

    if (dialect === "postgres") {
      skipped++;
      continue;
    }

    try {
      sqlite.exec(content);
      applied++;
    } catch (error) {
      failed++;
      console.error(
        `[demo] failed to apply SQLite-applicable migration ${file} (applied: ${applied}, skipped: ${skipped}, failed: ${failed}):`,
        error,
      );
      throw new Error(
        `Failed to apply SQLite-applicable migration "${file}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  console.log(
    `[demo] migrations summary: applied ${applied}/${files.length} migrations (${skipped} skipped, ${failed} failed)`,
  );

  // Idempotent developer seed: does not assume developer_id = 1
  const existingDev = sqlite
    .prepare("SELECT id FROM developers WHERE user_id = ?")
    .get("demo-dev") as { id: number | bigint } | undefined;

  let devId: number;
  if (!existingDev) {
    const devResult = sqlite
      .prepare(
        "INSERT INTO developers (user_id, name, website, description, category) VALUES (?,?,?,?,?)",
      )
      .run(
        "demo-dev",
        "Callora Demo Labs",
        "https://callora.example",
        "Demo developer account",
        "data",
      );
    devId = Number(devResult.lastInsertRowid);
  } else {
    devId = Number(existingDev.id);
  }

  const findApi = sqlite.prepare("SELECT id FROM apis WHERE developer_id = ? AND name = ?");
  const insertApi = sqlite.prepare(
    "INSERT INTO apis (developer_id, name, description, base_url, category, status) VALUES (?,?,?,?,?, 'active')",
  );
  const findEp = sqlite.prepare(
    "SELECT id FROM api_endpoints WHERE api_id = ? AND path = ? AND method = ?",
  );
  const insertEp = sqlite.prepare(
    "INSERT INTO api_endpoints (api_id, path, method, price_per_call_usdc, description) VALUES (?,?,?,?,?)",
  );

  const seed: Array<[string, string, string, string, Array<[string, string, string, string]>]> = [
    [
      "Stellar Price Oracle",
      "Real-time XLM and asset price feeds",
      "https://oracle.example/v1",
      "finance",
      [
        ["/price/{asset}", "GET", "0.002", "Latest price for an asset"],
        ["/history", "GET", "0.01", "Historical OHLC data"],
      ],
    ],
    [
      "Soroban Contract Analytics",
      "Invocation and fee analytics for Soroban contracts",
      "https://analytics.example/v1",
      "analytics",
      [["/contracts/{id}/stats", "GET", "0.005", "Contract usage statistics"]],
    ],
    [
      "Geo Lookup",
      "IP to location lookup",
      "https://geo.example/v1",
      "data",
      [["/ip/{address}", "GET", "0.001", "Resolve an IP address"]],
    ],
  ];

  for (const [name, desc, url, cat, eps] of seed) {
    const existingApi = findApi.get(devId, name) as { id: number | bigint } | undefined;
    let apiId: number;
    if (!existingApi) {
      apiId = Number(insertApi.run(devId, name, desc, url, cat).lastInsertRowid);
    } else {
      apiId = Number(existingApi.id);
    }

    for (const [p, m, price, d] of eps) {
      const existingEp = findEp.get(apiId, p, m);
      if (!existingEp) {
        insertEp.run(apiId, p, m, price, d);
      }
    }
  }

  console.log("[demo] seeded demo catalog");
}
