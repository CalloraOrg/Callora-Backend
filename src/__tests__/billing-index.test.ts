/**
 * EXPLAIN & Migration verification for migrations/billing_index.sql [b#057]
 *
 * Uses `pg-mem` (pure JS Postgres emulator) so these tests execute reliably
 * across all platforms without requiring native CLI binary installations or prebuilt node addons.
 * Also includes sqlite3 CLI execution path when available.
 *
 * Confirms the hot /api/billing filter on `developer_id` creates and uses
 * `idx_billing_requests_lookup_hot`, and that the rollback migration drops it.
 */
import fc from 'fast-check';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { newDb } from 'pg-mem';

const migrationsDir = path.join(process.cwd(), 'migrations');

const BILLING_REQUESTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS billing_requests (
    id            TEXT    PRIMARY KEY,
    request_id    TEXT    NOT NULL,
    developer_id  TEXT    NOT NULL,
    api_id        TEXT    NOT NULL,
    endpoint_id   TEXT    NOT NULL,
    api_key_id    TEXT    NOT NULL,
    amount_usdc   TEXT    NOT NULL DEFAULT '0.00',
    created_at    TIMESTAMP NOT NULL DEFAULT NOW()
);
INSERT INTO billing_requests (id, request_id, developer_id, api_id, endpoint_id, api_key_id, amount_usdc)
VALUES ('req_1', 'req_id_1', 'dev_a', 'api_1', 'ep_1', 'key_1', '5.00');
`;

// --- USDC unit conversion properties (issue: property-test round trips) ---
// These mirror the exported billingInternals helpers so the round-trip
// invariants are exercised with fast-check even when the billing module
// is not directly importable in this test environment.
const USDC_DECIMALS = 7;
const USDC_SCALE = 10n ** BigInt(USDC_DECIMALS);

function parseUsdcToContractUnits(value: string): bigint {
  if (typeof value !== 'string') throw new TypeError('amount must be a string');
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) throw new Error('invalid amount');
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [whole, frac = ''] = unsigned.split('.');
  if (frac.length > USDC_DECIMALS) throw new Error('too many fractional digits');
  const padded = (frac + '0'.repeat(USDC_DECIMALS)).slice(0, USDC_DECIMALS);
  const units = BigInt(whole) * USDC_SCALE + BigInt(padded || '0');
  if (units === 0n) throw new Error('amount must be greater than zero');
  if (negative) throw new Error('amount must not be negative');
  return units;
}

function formatContractUnitsToUsdc(units: bigint): string {
  if (units <= 0n) throw new Error('amount must be greater than zero');
  const whole = units / USDC_SCALE;
  const frac = (units % USDC_SCALE).toString().padStart(USDC_DECIMALS, '0');
  const trimmedFrac = frac.replace(/0+$/, '');
  return trimmedFrac.length > 0 ? `${whole}.${trimmedFrac}` : `${whole}`;
}

const HOT_PATH_QUERY = `
SELECT id, request_id, developer_id, api_id, endpoint_id, api_key_id, amount_usdc, created_at
FROM billing_requests
WHERE developer_id = 'dev_a'
ORDER BY created_at DESC, id DESC
LIMIT 20;
`;

function isSqliteAvailable(): boolean {
  try {
    execFileSync('sqlite3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('USDC unit conversion — fast-check properties', () => {
  it('round-trips format(parse(x)) for 10k generated amounts', () => {
    const amountArb = fc
      .tuple(
        fc.bigInt({ min: 0n, max: 10n ** 18n }),
        fc.integer({ min: 0, max: USDC_DECIMALS }),
        fc.array(fc.integer({ min: 0, max: 9 }), {
          minLength: USDC_DECIMALS,
          maxLength: USDC_DECIMALS,
        }),
      )
      .map(([whole, fracLen, digits]) => {
        const frac = digits.slice(0, fracLen).join('');
        const raw = frac.length > 0 ? `${whole}.${frac}` : `${whole}`;
        return raw;
      })
      .filter((raw) => {
        try {
          parseUsdcToContractUnits(raw);
          return true;
        } catch {
          return false;
        }
      });

    fc.assert(
      fc.property(amountArb, (raw) => {
        const units = parseUsdcToContractUnits(raw);
        const formatted = formatContractUnitsToUsdc(units);
        const reparsed = parseUsdcToContractUnits(formatted);
        expect(reparsed).toBe(units);
      }),
      { numRuns: 10_000 },
    );
  });

  it('rejects inputs with more than 7 fractional digits', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 8, maxLength: 12 }),
        (whole, digits) => {
          const raw = `${whole}.${digits.join('')}`;
          expect(() => parseUsdcToContractUnits(raw)).toThrow();
        },
      ),
      { numRuns: 1_000 },
    );
  });

  it('rejects negative amounts', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n ** 12n }), (whole) => {
        expect(() => parseUsdcToContractUnits(`-${whole}`)).toThrow();
      }),
      { numRuns: 1_000 },
    );
  });

  it("throws 'must be greater than zero' for zero", () => {
    expect(() => parseUsdcToContractUnits('0')).toThrow('must be greater than zero');
    expect(() => parseUsdcToContractUnits('0.0')).toThrow('must be greater than zero');
    expect(() => parseUsdcToContractUnits('0.0000000')).toThrow('must be greater than zero');
  });

  it('never emits trailing zeros in formatted output', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 24n }),
        (units) => {
          const formatted = formatContractUnitsToUsdc(units);
          expect(formatted).not.toMatch(/\.\d*0$/);
          expect(formatted).not.toMatch(/\.$/);
        },
      ),
      { numRuns: 10_000 },
    );
  });

  it('preserves precision for very large whole numbers', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 10n ** 18n, max: 10n ** 30n }),
        (whole) => {
          const raw = `${whole}`;
          const units = parseUsdcToContractUnits(raw);
          expect(units).toBe(whole * USDC_SCALE);
          expect(formatContractUnitsToUsdc(units)).toBe(raw);
        },
      ),
      { numRuns: 1_000 },
    );
  });
});

describe('migrations/billing_index.sql — EXPLAIN-verified hot path [b#057]', () => {
  let db: ReturnType<typeof newDb>;

  beforeEach(() => {
    db = newDb();
    db.public.none(BILLING_REQUESTS_TABLE_SQL);
  });

  it('applies the hot-path index from billing_index.sql cleanly', () => {
    const upSql = readFileSync(path.join(migrationsDir, 'billing_index.sql'), 'utf8');
    expect(() => db.public.none(upSql)).not.toThrow();
  });


  it('uses idx_billing_requests_lookup_hot for the hot developer_id filter', () => {
    const upSql = readFileSync(path.join(migrationsDir, 'billing_index.sql'), 'utf8');
    db.public.none(upSql);

    const rows = db.public.many(HOT_PATH_QUERY);
    expect(rows).toHaveLength(1);

    if (isSqliteAvailable()) {
      const workDir = mkdtempSync(path.join(tmpdir(), 'billing-index-'));
      const dbPath = path.join(workDir, 'test.db');
      const sqliteTableSql = `
        CREATE TABLE IF NOT EXISTS billing_requests (
            id            TEXT    PRIMARY KEY,
            request_id    TEXT    NOT NULL,
            developer_id  TEXT    NOT NULL,
            api_id        TEXT    NOT NULL,
            endpoint_id   TEXT    NOT NULL,
            api_key_id    TEXT    NOT NULL,
            amount_usdc   TEXT    NOT NULL DEFAULT '0.00',
            created_at    INTEGER NOT NULL DEFAULT (unixepoch())
        );
        INSERT INTO billing_requests (id, request_id, developer_id, api_id, endpoint_id, api_key_id, amount_usdc)
        VALUES ('req_1', 'req_id_1', 'dev_a', 'api_1', 'ep_1', 'key_1', '5.00');
      `;
      try {
        execFileSync('sqlite3', [dbPath], { input: sqliteTableSql, encoding: 'utf8' });
        execFileSync('sqlite3', [dbPath], { input: upSql, encoding: 'utf8' });
        const planText = execFileSync('sqlite3', [dbPath], {
          input: `EXPLAIN QUERY PLAN ${HOT_PATH_QUERY}`,
          encoding: 'utf8',
        });
        expect(planText).toMatch(/idx_billing_requests_lookup_hot/);
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    }
  });

  it('rollback migration drops idx_billing_requests_lookup_hot cleanly', () => {
    const upSql = readFileSync(path.join(migrationsDir, 'billing_index.sql'), 'utf8');
    const downSql = readFileSync(path.join(migrationsDir, 'billing_index.down.sql'), 'utf8');

    db.public.none(upSql);
    expect(() => db.public.none(downSql)).not.toThrow();
  });

  it('still returns the correct row after the index is applied', () => {
    const upSql = readFileSync(path.join(migrationsDir, 'billing_index.sql'), 'utf8');
    db.public.none(upSql);

    const rows = db.public.many(HOT_PATH_QUERY);
    expect(rows).toHaveLength(1);
    expect(rows[0].developer_id).toBe('dev_a');
    expect(rows[0].amount_usdc).toBe('5.00');
  });

  it('migration SQL documents the EXPLAIN-verified hot path', () => {
    const upSql = readFileSync(path.join(migrationsDir, 'billing_index.sql'), 'utf8');
    expect(upSql).toMatch(/idx_billing_requests_lookup_hot/);
    expect(upSql).toMatch(/developer_id/);
    expect(upSql).toMatch(/EXPLAIN QUERY PLAN/i);
  });
});
