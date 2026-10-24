import { describe, it, expect } from '@jest/globals';
import { newDb, DataType } from 'pg-mem';

describe('Scenario 7: Migration 0026 Up then Down on Seeded Data', () => {
  it('migrates up to contract units with check constraints, then down with round-trip', async () => {
    const db = newDb();

    db.public.registerFunction({
      name: 'now',
      returns: DataType.timestamp,
      implementation: () => new Date('2026-03-01T00:00:00.000Z'),
    });

    db.public.registerFunction({
      name: 'round',
      args: [DataType.float],
      returns: DataType.integer,
      implementation: (x: number) => Math.round(x),
    });

    // 1. Initial State:
    // usage_events has NUMERIC(20, 0)
    // usage_events_old has NUMERIC
    // revenue_ledger has NUMERIC
    db.public.none(`
      CREATE TABLE usage_events_old (
        id BIGSERIAL PRIMARY KEY,
        developer_id VARCHAR(255) NOT NULL,
        amount_usdc NUMERIC NOT NULL,
        request_id VARCHAR(255) NOT NULL
      );

      CREATE TABLE usage_events (
        id BIGSERIAL PRIMARY KEY,
        developer_id VARCHAR(255) NOT NULL,
        amount_usdc NUMERIC(20, 0) NOT NULL,
        request_id VARCHAR(255) NOT NULL
      );

      CREATE TABLE revenue_ledger (
        id BIGSERIAL PRIMARY KEY,
        developer_id VARCHAR(255) NOT NULL,
        amount_usdc NUMERIC NOT NULL,
        usage_event_id BIGINT
      );
    `);

    // 2. Seed data:
    // Row 1: was 1.5 USDC in old table, but got truncated/rounded to 2 in usage_events by NUMERIC(20,0)
    // Row 2: was 0.0012345 USDC in old table, got truncated to 0 in usage_events
    // Row 3: an unrecoverable row (only in usage_events, no old row) truncated to 0
    // Ledger: Row 1 has 1.5 USDC, Row 2 has 0.0012345 USDC
    db.public.none(`
      INSERT INTO usage_events_old (id, developer_id, amount_usdc, request_id)
      VALUES (1, 'dev-1', 1.5, 'req-1'),
             (2, 'dev-1', 0.0012345, 'req-2');

      INSERT INTO usage_events (id, developer_id, amount_usdc, request_id)
      VALUES (1, 'dev-1', 2, 'req-1'),
             (2, 'dev-1', 0, 'req-2'),
             (3, 'dev-1', 0, 'req-unrecoverable');

      INSERT INTO revenue_ledger (id, developer_id, amount_usdc, usage_event_id)
      VALUES (1, 'dev-1', 1.5, 1),
             (2, 'dev-1', 0.0012345, 2);
    `);

    // 3. Run Migration UP logic:
    // - Create report table and record truncated rows
    // - Update from usage_events_old
    // - Recover unrecoverable rows to 1 stroop
    // - Convert revenue_ledger to contract units
    // - Add check constraints
    db.public.none(`
      CREATE TABLE IF NOT EXISTS usage_events_truncation_report (
        id BIGINT,
        developer_id VARCHAR(255),
        request_id VARCHAR(255),
        original_amount_usdc NUMERIC,
        detected_at TIMESTAMP NOT NULL DEFAULT NOW(),
        notes TEXT
      );

      INSERT INTO usage_events_truncation_report (id, developer_id, request_id, original_amount_usdc, notes)
      SELECT id, developer_id, request_id, amount_usdc, 'Truncated to 0 by NUMERIC(20,0) before contract unit migration'
      FROM usage_events
      WHERE amount_usdc <= 0;

      UPDATE usage_events
      SET amount_usdc = ROUND(usage_events_old.amount_usdc * 10000000)
      FROM usage_events_old
      WHERE usage_events.id = usage_events_old.id;

      UPDATE usage_events
      SET amount_usdc = 1
      WHERE amount_usdc <= 0;

      UPDATE revenue_ledger
      SET amount_usdc = ROUND(amount_usdc * 10000000);

      ALTER TABLE usage_events
        ADD CONSTRAINT chk_usage_events_amount_usdc_positive
        CHECK (amount_usdc > 0);

      ALTER TABLE revenue_ledger
        ADD CONSTRAINT chk_revenue_ledger_amount_usdc_positive
        CHECK (amount_usdc > 0);
    `);

    // Verify UP state:
    // Report has recorded the 2 rows that had amount_usdc <= 0 (row 2 and row 3)
    const reportRows = db.public.many('SELECT * FROM usage_events_truncation_report ORDER BY id ASC');
    expect(reportRows).toHaveLength(2);
    expect(reportRows[0].id).toBe(2);
    expect(reportRows[1].id).toBe(3);

    // Row 1 recovered from 1.5 to 15000000 contract units
    // Row 2 recovered from 0.0012345 to 12345 contract units
    // Row 3 (unrecoverable) bumped to 1 stroop
    const ueRows = db.public.many('SELECT id, amount_usdc FROM usage_events ORDER BY id ASC');
    expect(ueRows[0].amount_usdc).toBe(15000000);
    expect(ueRows[1].amount_usdc).toBe(12345);
    expect(ueRows[2].amount_usdc).toBe(1);

    // Revenue ledger converted to contract units
    const rlRows = db.public.many('SELECT id, amount_usdc FROM revenue_ledger ORDER BY id ASC');
    expect(rlRows[0].amount_usdc).toBe(15000000);
    expect(rlRows[1].amount_usdc).toBe(12345);

    // Constraint is present: inserting 0 or negative must fail
    expect(() => {
      db.public.none("INSERT INTO usage_events (id, developer_id, amount_usdc, request_id) VALUES (4, 'dev-1', 0, 'req-bad');");
    }).toThrow();

    expect(() => {
      db.public.none("INSERT INTO revenue_ledger (id, developer_id, amount_usdc, usage_event_id) VALUES (4, 'dev-1', -10, 4);");
    }).toThrow();

    // 4. Run Migration DOWN logic:
    // - Drop check constraints
    // - Convert revenue_ledger back to decimal
    // - Drop report table
    db.public.none(`
      ALTER TABLE usage_events
        DROP CONSTRAINT chk_usage_events_amount_usdc_positive;

      ALTER TABLE revenue_ledger
        DROP CONSTRAINT chk_revenue_ledger_amount_usdc_positive;

      UPDATE revenue_ledger
      SET amount_usdc = amount_usdc / 10000000.0;

      DROP TABLE IF EXISTS usage_events_truncation_report;
    `);

    // Verify DOWN state:
    // Values round-trip back
    const rlDownRows = db.public.many('SELECT id, amount_usdc FROM revenue_ledger ORDER BY id ASC');
    expect(Number(rlDownRows[0].amount_usdc)).toBeCloseTo(1.5, 6);
    expect(Number(rlDownRows[1].amount_usdc)).toBeCloseTo(0.0012345, 6);

    // Check constraints are absent: inserting 0 now succeeds
    expect(() => {
      db.public.none("INSERT INTO usage_events (id, developer_id, amount_usdc, request_id) VALUES (5, 'dev-1', 0, 'req-zero');");
    }).not.toThrow();

    // Report table is absent
    expect(() => {
      db.public.many('SELECT * FROM usage_events_truncation_report');
    }).toThrow();
  });
});
