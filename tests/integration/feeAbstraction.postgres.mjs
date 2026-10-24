#!/usr/bin/env node
// Native PostgreSQL race regression for fee-abstraction quote consumption (src/services/feeAbstractionPayment.ts).
// Runs against the compiled dist/ of the repository containing this file. Not a jest test (jest matches *.test.ts).
// Usage: node tests/integration/feeAbstraction.postgres.mjs --dsn <postgres-url> --disposable
// The database MUST be fresh and disposable: the operator asserts this with --disposable. The harness creates
// and drops only its own schema (callora_race_<random>); it never touches other schemas.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspect } from 'node:util';

function usage() {
  return 'usage: node tests/integration/feeAbstraction.postgres.mjs --dsn <postgres-url> --disposable';
}

const args = process.argv.slice(2);
const dsnIndex = args.indexOf('--dsn');
const dsn = dsnIndex === -1 ? undefined : args[dsnIndex + 1];
if (!dsn || dsn.startsWith('--') || !args.includes('--disposable')) {
  console.error(usage());
  process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const requireFromRoot = createRequire(path.join(root, 'package.json'));
const { Pool, Client } = requireFromRoot('pg');
const { consumeQuoteAndSign } = await import(
  pathToFileURL(path.join(root, 'dist/src/services/feeAbstractionPayment.js')).href
);

const SCHEMA = `callora_race_${randomBytes(4).toString('hex')}`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GATE_KEY = 14990003;
const STEP_DEADLINE_MS = 15_000;
const WATCHDOG_MS = 240_000;
const FEE = 100n;
const APP_TOKEN_UNITS = 5n;
const NETWORK = 'testnet';
const USER_ID = randomUUID();
const CONN = { connectionString: dsn, options: `-c search_path=${SCHEMA}` };
const LOCK_ROW_SQL = 'SELECT id FROM fee_abstraction_quotes WHERE id = $1 FOR UPDATE';
const PENDING = { status: 'pending', app_token_payment_tx_id: null, consumed_at_set: false };

const failures = [];
const cleanupErrors = [];
const ctx = {};
let schemaCreated = false;
let gateInstalled = false;

const watchdog = setTimeout(() => {
  console.error(`WATCHDOG: exceeded ${WATCHDOG_MS} ms; forcing exit`);
  process.exit(3);
}, WATCHDOG_MS);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hex64 = () => randomBytes(32).toString('hex');
const sameInts = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// Public error contract: AppError flags itself with isAppError and exposes statusCode/code.
// instanceof is avoided: it depends on module identity across dist imports.
function assertAppError(err, statusCode, code, label) {
  assert.ok(err?.isAppError === true, `${label}: expected AppError, got ${describeError(err)}`);
  assert.equal(err.statusCode, statusCode, `${label}: statusCode`);
  assert.equal(err.code, code, `${label}: code`);
}

function describeError(err) {
  if (!(err instanceof Error)) return inspect(err);
  const tags = [];
  if (typeof err.statusCode === 'number') tags.push(`HTTP ${err.statusCode}`);
  if (typeof err.severity === 'string') tags.push(`pg ${err.severity} ${err.code ?? ''}`.trim());
  return `${err.name}: ${err.message}${tags.length ? ` [${tags.join(', ')}]` : ''}`;
}

function withDeadline(promise, label, ms = STEP_DEADLINE_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`deadline ${ms} ms exceeded: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const settle = (promise) =>
  promise.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));

function describeOutcomes(outcomes) {
  return outcomes
    .map((o) => (o.ok ? `committed feeBumpXdr=${o.value.feeBumpXdr}` : describeError(o.error)))
    .join(' | ');
}

async function drainAttempts(attempts, label) {
  try {
    await withDeadline(Promise.all(attempts), label);
  } catch (err) {
    cleanupErrors.push(`${label}: ${describeError(err)}`);
  }
}

async function connect(name) {
  const client = new Client({ ...CONN, application_name: `callora-race-${name}` });
  await client.connect();
  return client;
}

async function openControl(name) {
  const client = await connect(name);
  const { rows } = await client.query('SELECT pg_backend_pid() AS pid');
  return { client, pid: rows[0].pid, inTx: false };
}

async function releaseControl(control) {
  try {
    if (control.inTx) {
      await control.client.query('ROLLBACK');
      control.inTx = false;
    }
    await control.client.query('SELECT pg_advisory_unlock_all()');
  } catch (err) {
    cleanupErrors.push(`control ${control.pid} release: ${describeError(err)}`);
  } finally {
    await withDeadline(control.client.end(), `control ${control.pid} end`, 5_000).catch((err) =>
      cleanupErrors.push(`control ${control.pid} end: ${describeError(err)}`),
    );
  }
}

async function holdRowLock(control, quoteId) {
  await control.client.query('BEGIN');
  control.inTx = true;
  await control.client.query(LOCK_ROW_SQL, [quoteId]);
}

async function seedQuote(ttl) {
  const { rows } = await ctx.setup.query(
    `INSERT INTO fee_abstraction_quotes
       (user_id, inner_tx_hash, fee_stroops, app_token_amount, network, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'pending', clock_timestamp() + $6::interval)
     RETURNING id`,
    [USER_ID, hex64(), FEE.toString(), APP_TOKEN_UNITS.toString(), NETWORK, ttl],
  );
  assert.match(rows[0].id, UUID_RE);
  return rows[0].id;
}

async function quoteState(quoteId) {
  const { rows } = await ctx.setup.query(
    `SELECT status, app_token_payment_tx_id, consumed_at IS NOT NULL AS consumed_at_set
       FROM fee_abstraction_quotes WHERE id = $1`,
    [quoteId],
  );
  return rows[0];
}

async function claimCount(paymentTxHash) {
  const { rows } = await ctx.setup.query(
    'SELECT count(*)::int AS n FROM fee_abstraction_quotes WHERE app_token_payment_tx_id = $1',
    [paymentTxHash],
  );
  return rows[0].n;
}

const consumeInput = (quoteId, paymentTxHash) => ({
  quoteId,
  userId: USER_ID,
  paymentTxHash,
  feeStroops: FEE,
});

// Synthetic signer: records every sign call; optionally throws on the first call only.
function makeSign(log, label, failIfFirst = false) {
  return () => {
    const isFirst = log.length === 0;
    log.push(label);
    if (failIfFirst && isFirst) throw new Error(`synthetic signing failure: ${label}`);
    return { feeBumpXdr: `signed:${label}`, feeAccountPublicKey: 'GSYNTHETICFEEACCOUNT', feeStroops: FEE };
  };
}

// Pool backends whose UPDATE/SELECT touches the quote table and are waiting on a lock.
async function blockedBackends() {
  const { rows } = await ctx.monitor.query(`
    SELECT a.pid, a.wait_event_type, a.wait_event, pg_blocking_pids(a.pid) AS blockers,
           left(a.query, 90) AS query
      FROM pg_stat_activity a
     WHERE a.datname = current_database()
       AND a.application_name = 'callora-race-pool'
       AND a.state = 'active'
       AND a.wait_event_type = 'Lock'
       AND a.query ~* 'fee_abstraction_quotes'
       AND (a.query ~* '^\\s*UPDATE\\s+fee_abstraction_quotes'
            OR a.query ~* '^\\s*SELECT\\y.*\\yFOR\\s+UPDATE\\y')
     ORDER BY a.pid`);
  return rows;
}

async function dumpActivity() {
  const { rows } = await ctx.monitor.query(`
    SELECT pid, application_name, state, wait_event_type, wait_event,
           pg_blocking_pids(pid) AS blockers, left(query, 90) AS query
      FROM pg_stat_activity
     WHERE datname = current_database() AND backend_type = 'client backend'
     ORDER BY pid`);
  return inspect(rows, { depth: 4, breakLength: 160 });
}

// Bounded monitor loop: poll pg_stat_activity until `ready(rows)` holds with exactly `count` waiters.
async function waitForBlocked(label, count, ready = () => true) {
  const deadline = Date.now() + STEP_DEADLINE_MS;
  for (;;) {
    const rows = await blockedBackends();
    if (rows.length === count && ready(rows)) return rows;
    if (Date.now() >= deadline) {
      const activity = await dumpActivity().catch((err) => `(activity dump failed: ${describeError(err)})`);
      throw new Error(
        `timed out waiting for ${label} (${count} blocked backend(s))\n` +
          `last blocked observation: ${inspect(rows, { depth: 4 })}\n` +
          `pg_stat_activity:\n${activity}`,
      );
    }
    await sleep(25);
  }
}

function describeWaiters(rows) {
  return rows
    .map((r) => `pid=${r.pid} wait=${r.wait_event_type}/${r.wait_event} blockers=[${r.blockers}] query="${r.query}"`)
    .join('; ');
}

function assertDistinctBackends(label, rows, extraPids) {
  const pids = rows.map((r) => r.pid);
  assert.equal(new Set(pids).size, pids.length, `${label}: waiter pids must be distinct: [${pids}]`);
  for (const pid of extraPids) {
    assert.ok(!pids.includes(pid), `${label}: waiter pid ${pid} collides with control/monitor pid`);
  }
  for (const row of rows) {
    assert.ok(row.blockers.length > 0, `${label}: pid ${row.pid} reports no blocking pid`);
  }
}

// Scenario 1: control holds the row lock; two concurrent consumes queue behind it.
async function scenarioSameQuoteRowLock() {
  const quoteId = await seedQuote('1 hour');
  const control = await openControl('s1-rowlock');
  const signLog = [];
  const payments = { first: hex64(), second: hex64() };
  const attempts = [];
  try {
    await holdRowLock(control, quoteId);
    attempts.push(settle(consumeQuoteAndSign(ctx.pool, consumeInput(quoteId, payments.first), makeSign(signLog, 'first'))));
    attempts.push(settle(consumeQuoteAndSign(ctx.pool, consumeInput(quoteId, payments.second), makeSign(signLog, 'second'))));
    const waiters = await waitForBlocked('s1 two consumes behind control row lock', 2);
    assertDistinctBackends('s1', waiters, [control.pid, ctx.monitorPid]);
    assert.ok(
      new Set(waiters.flatMap((r) => r.blockers)).has(control.pid),
      `s1: no waiter is blocked by control pid ${control.pid}: ${describeWaiters(waiters)}`,
    );
    console.log(`  s1 control pid=${control.pid} waiters: ${describeWaiters(waiters)}`);

    await control.client.query('COMMIT');
    control.inTx = false;
    const outcomes = await withDeadline(Promise.all(attempts), 's1 outcomes');
    const winners = outcomes.filter((o) => o.ok);
    const losers = outcomes.filter((o) => !o.ok);
    console.log(`  s1 outcomes: ${describeOutcomes(outcomes)}`);

    assert.equal(winners.length, 1, `s1: expected exactly one signed commit: ${describeOutcomes(outcomes)}`);
    assert.equal(losers.length, 1, `s1: expected exactly one loser: ${describeOutcomes(outcomes)}`);
    assertAppError(losers[0].error, 409, 'CONFLICT', 's1 loser');
    assert.equal(signLog.length, 1, `s1: sign must run exactly once, ran for [${signLog}]`);
    assert.equal(winners[0].value.feeBumpXdr, `signed:${signLog[0]}`);
    assert.deepEqual(await quoteState(quoteId), {
      status: 'consumed',
      app_token_payment_tx_id: payments[signLog[0]],
      consumed_at_set: true,
    });
  } finally {
    await releaseControl(control);
    await drainAttempts(attempts, 's1 drain');
  }
}

// Scenario 2: the first queued sign callback throws after its UPDATE; the second must succeed after rollback.
async function scenarioRollbackRelease() {
  const quoteId = await seedQuote('1 hour');
  const control = await openControl('s2-rollback');
  const signLog = [];
  const payments = { first: hex64(), second: hex64() };
  const attempts = [];
  try {
    await holdRowLock(control, quoteId);
    attempts.push(settle(consumeQuoteAndSign(ctx.pool, consumeInput(quoteId, payments.first), makeSign(signLog, 'first', true))));
    attempts.push(settle(consumeQuoteAndSign(ctx.pool, consumeInput(quoteId, payments.second), makeSign(signLog, 'second', true))));
    const waiters = await waitForBlocked('s2 two consumes behind control row lock', 2);
    assertDistinctBackends('s2', waiters, [control.pid, ctx.monitorPid]);
    assert.ok(
      new Set(waiters.flatMap((r) => r.blockers)).has(control.pid),
      `s2: no waiter is blocked by control pid ${control.pid}: ${describeWaiters(waiters)}`,
    );
    console.log(`  s2 control pid=${control.pid} waiters: ${describeWaiters(waiters)}`);

    await control.client.query('COMMIT');
    control.inTx = false;
    const outcomes = await withDeadline(Promise.all(attempts), 's2 outcomes');
    const winners = outcomes.filter((o) => o.ok);
    const losers = outcomes.filter((o) => !o.ok);
    console.log(`  s2 outcomes: ${describeOutcomes(outcomes)}`);

    assert.equal(signLog.length, 2, `s2: both attempts must reach sign, got [${signLog}]`);
    assert.equal(winners.length, 1, `s2: expected exactly one committed quote: ${describeOutcomes(outcomes)}`);
    assert.equal(losers.length, 1, `s2: expected exactly one failed attempt: ${describeOutcomes(outcomes)}`);
    assert.match(losers[0].error.message, /synthetic signing failure/, `s2: failed attempt must surface the signing error`);
    assert.notEqual(losers[0].error.statusCode, 409, 's2: signing failure must not be mapped to 409');
    const failedLabel = signLog[0];
    const winnerLabel = signLog[1];
    assert.equal(winners[0].value.feeBumpXdr, `signed:${winnerLabel}`);
    assert.deepEqual(await quoteState(quoteId), {
      status: 'consumed',
      app_token_payment_tx_id: payments[winnerLabel],
      consumed_at_set: true,
    });
    assert.equal(await claimCount(payments[failedLabel]), 0, 's2: failed attempt left a payment claim behind');
  } finally {
    await releaseControl(control);
    await drainAttempts(attempts, 's2 drain');
  }
}

// Scenario 3: same payment on two quotes. Quote 1 holds its unique-index entry uncommitted while a test-only
// trigger blocks on an advisory gate; quote 2 must wait on quote 1's transaction and then map 23505 to 402.
async function scenarioSamePaymentAcrossQuotes() {
  const firstQuote = await seedQuote('1 hour');
  const secondQuote = await seedQuote('1 hour');
  assert.match(firstQuote, UUID_RE);
  const payment = hex64();
  const signLog = [];
  const attempts = [];
  const control = await openControl('s3-gate');
  try {
    gateInstalled = true;
    await ctx.setup.query(
      `CREATE FUNCTION race_gate() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN PERFORM pg_advisory_xact_lock(${GATE_KEY}); RETURN NULL; END $$`,
    );
    await ctx.setup.query(
      `CREATE TRIGGER race_gate_first AFTER UPDATE ON fee_abstraction_quotes
         FOR EACH ROW WHEN (NEW.id = '${firstQuote}'::uuid) EXECUTE FUNCTION race_gate()`,
    );
    await control.client.query('SELECT pg_advisory_lock($1)', [GATE_KEY]);

    attempts.push(settle(consumeQuoteAndSign(ctx.pool, consumeInput(firstQuote, payment), makeSign(signLog, 'first'))));
    const [gated] = await waitForBlocked('s3 first quote at advisory gate', 1, (rows) =>
      rows[0].wait_event === 'advisory' && sameInts(rows[0].blockers, [control.pid]),
    );
    console.log(`  s3 gated first quote: ${describeWaiters([gated])}`);

    attempts.push(settle(consumeQuoteAndSign(ctx.pool, consumeInput(secondQuote, payment), makeSign(signLog, 'second'))));
    const waiters = await waitForBlocked('s3 second quote behind unique-index entry', 2, (rows) => {
      const second = rows.find((r) => r.pid !== gated.pid);
      return second?.wait_event === 'transactionid' && sameInts(second.blockers, [gated.pid]);
    });
    assertDistinctBackends('s3', waiters, [control.pid, ctx.monitorPid]);
    console.log(`  s3 waiters: ${describeWaiters(waiters)}`);

    const released = await control.client.query('SELECT pg_advisory_unlock($1) AS released', [GATE_KEY]);
    assert.equal(released.rows[0].released, true, 's3: control did not hold the advisory gate');

    const outcomes = await withDeadline(Promise.all(attempts), 's3 outcomes');
    console.log(`  s3 outcomes: ${describeOutcomes(outcomes)}`);
    const [firstOutcome, secondOutcome] = outcomes;
    assert.ok(firstOutcome.ok, `s3: first quote must commit: ${describeError(firstOutcome.error)}`);
    assert.equal(secondOutcome.ok, false, 's3: second quote must not commit on the same payment');
    assertAppError(secondOutcome.error, 402, 'PAYMENT_REQUIRED', 's3 loser');
    assert.match(secondOutcome.error.message, /already backs another fee-abstraction quote/);
    assert.deepEqual(signLog, ['first'], 's3: only the first quote may sign');
    assert.deepEqual(await quoteState(firstQuote), { status: 'consumed', app_token_payment_tx_id: payment, consumed_at_set: true });
    assert.deepEqual(await quoteState(secondQuote), PENDING, 's3: second quote must remain pending');
    assert.equal(await claimCount(payment), 1, 's3: payment must back exactly one quote');
  } finally {
    await releaseControl(control);
    await drainAttempts(attempts, 's3 drain');
    if (gateInstalled) {
      try {
        await ctx.setup.query('DROP TRIGGER IF EXISTS race_gate_first ON fee_abstraction_quotes');
        await ctx.setup.query('DROP FUNCTION IF EXISTS race_gate()');
        gateInstalled = false;
      } catch (err) {
        cleanupErrors.push(`drop race gate: ${describeError(err)}`);
      }
    }
  }
}

// Scenario 4: quote expires (DB clock) while its consume waits on a row lock that is released without updating the row.
async function scenarioExpiryWhileWaiting() {
  const control = await openControl('s4-expiry');
  const signLog = [];
  const attempts = [];
  let quoteId = null;
  try {
    quoteId = await seedQuote('1 second');
    await holdRowLock(control, quoteId);
    attempts.push(settle(consumeQuoteAndSign(ctx.pool, consumeInput(quoteId, hex64()), makeSign(signLog, 'expiry'))));
    const [waiter] = await waitForBlocked('s4 consume behind control row lock', 1, (rows) =>
      sameInts(rows[0].blockers, [control.pid]),
    );
    console.log(`  s4 control pid=${control.pid} waiter: ${describeWaiters([waiter])}`);

    const { rows: pre } = await ctx.setup.query(
      'SELECT clock_timestamp() < expires_at AS before_expiry FROM fee_abstraction_quotes WHERE id = $1',
      [quoteId],
    );
    assert.equal(pre[0].before_expiry, true, 's4 precondition: waiter must block before expiry; run is inconclusive');

    // Let real DB time pass expiry in the monitor session while the waiter stays blocked.
    await ctx.monitor.query(
      `SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM (expires_at - clock_timestamp())))::double precision + 0.2)
         FROM fee_abstraction_quotes WHERE id = $1`,
      [quoteId],
    );
    const { rows: post } = await ctx.monitor.query(
      'SELECT clock_timestamp() > expires_at AS expired FROM fee_abstraction_quotes WHERE id = $1',
      [quoteId],
    );
    assert.equal(post[0].expired, true, 's4: DB clock must be past quote expiry');
    const stillBlocked = await blockedBackends();
    assert.ok(stillBlocked.some((r) => r.pid === waiter.pid), `s4: waiter ${waiter.pid} must still be blocked after expiry`);

    // Release the lock WITHOUT updating the quote row.
    await control.client.query('ROLLBACK');
    control.inTx = false;

    const outcome = await withDeadline(attempts[0], 's4 outcome');
    if (outcome.ok) {
      assert.fail(
        `s4: expired quote committed after row-lock wait (expected 409): sign calls=${signLog.length}, feeBumpXdr=${outcome.value.feeBumpXdr}`,
      );
    }
    assertAppError(outcome.error, 409, 'CONFLICT', 's4 outcome');
    assert.deepEqual(signLog, [], 's4: expired quote must not sign');
    assert.deepEqual(await quoteState(quoteId), PENDING, 's4: expired quote must remain pending');
  } finally {
    await releaseControl(control);
    await drainAttempts(attempts, 's4 drain');
  }
}

async function runScenario(name, fn) {
  const started = Date.now();
  try {
    await fn();
    console.log(`PASS ${name} (${Date.now() - started} ms)`);
  } catch (err) {
    failures.push({ name, message: describeError(err) });
    console.log(`FAIL ${name}\n  ${describeError(err)}`);
    if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
  }
}

async function setUp() {
  ctx.setup = await connect('setup');
  await ctx.setup.query("SET lock_timeout = '10s'");
  ctx.monitor = await connect('monitor');
  ctx.monitorPid = (await ctx.monitor.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  ctx.pool = new Pool({ ...CONN, max: 6, application_name: 'callora-race-pool' });
  ctx.pool.on('error', (err) => cleanupErrors.push(`idle pool client: ${describeError(err)}`));

  const version = (await ctx.setup.query('SHOW server_version')).rows[0].server_version;
  console.log(`server_version=${version} schema=${SCHEMA} monitorPid=${ctx.monitorPid}`);

  await ctx.setup.query(`CREATE SCHEMA ${SCHEMA}`);
  schemaCreated = true;
  const migration = await readFile(path.join(root, 'migrations/0034_fee_abstraction_quotes.sql'), 'utf8');
  await ctx.setup.query(migration);
}

async function tearDown() {
  if (schemaCreated) {
    await withDeadline(ctx.setup.query(`DROP SCHEMA ${SCHEMA} CASCADE`), 'drop schema').catch((err) =>
      cleanupErrors.push(`drop schema: ${describeError(err)}`),
    );
  }
  if (ctx.pool) {
    await withDeadline(ctx.pool.end(), 'pool end', 10_000).catch((err) =>
      cleanupErrors.push(`pool end: ${describeError(err)}`),
    );
  }
  for (const client of [ctx.monitor, ctx.setup]) {
    if (client) {
      await withDeadline(client.end(), 'client end', 5_000).catch((err) =>
        cleanupErrors.push(`client end: ${describeError(err)}`),
      );
    }
  }
}

async function run() {
  try {
    await setUp();
    await runScenario('1 samequote: row lock, one signed commit, loser 409', scenarioSameQuoteRowLock);
    await runScenario('2 rollbackrelease: sign failure rolls back, second attempt commits', scenarioRollbackRelease);
    await runScenario('3 same payment across 2 quotes: real unique-index race, loser 402', scenarioSamePaymentAcrossQuotes);
    await runScenario('4 expiry while waiting: expired quote must not commit', scenarioExpiryWhileWaiting);
  } catch (err) {
    failures.push({ name: 'setup', message: describeError(err) });
    console.log(`FAIL setup\n  ${describeError(err)}`);
  } finally {
    await tearDown();
  }
  clearTimeout(watchdog);

  const issues = [
    ...failures.map((f) => `${f.name}: ${f.message}`),
    ...cleanupErrors.map((m) => `cleanup: ${m}`),
  ];
  if (issues.length === 0) {
    console.log('NATIVE RACE PROOF PASSED: 4/4 scenarios');
  } else {
    console.log(`NATIVE RACE PROOF FAILED: ${issues.length} issue(s)`);
    for (const issue of issues) console.log(` - ${issue}`);
  }
  process.exit(issues.length === 0 ? 0 : 1);
}

run();
