import assert from 'node:assert/strict';
import { MockSorobanBilling } from './billingService.js';

describe('MockSorobanBilling.deductCredit — non-positive quantity rejection', () => {
  test('rejects zero amount and leaves balance unchanged', async () => {
    const billing = new MockSorobanBilling({ dev1: 100 });

    const result = await billing.deductCredit('dev1', 0);

    assert.equal(result.success, false);
    assert.equal(billing.getBalance('dev1'), 100);
  });

  test('rejects negative amount and leaves balance unchanged', async () => {
    const billing = new MockSorobanBilling({ dev1: 100 });

    const result = await billing.deductCredit('dev1', -10);

    assert.equal(result.success, false);
    assert.equal(billing.getBalance('dev1'), 100);
  });

  test('negative amount does not increase balance (was a data-integrity bug)', async () => {
    const billing = new MockSorobanBilling({ dev1: 50 });

    await billing.deductCredit('dev1', -20);

    // Balance must not have grown — a negative deduction is not a top-up
    assert.equal(billing.getBalance('dev1'), 50);
  });

  test('returns current balance in the rejection result', async () => {
    const billing = new MockSorobanBilling({ dev1: 75 });

    const zeroResult = await billing.deductCredit('dev1', 0);
    assert.equal(zeroResult.success, false);
    assert.equal(zeroResult.balance, 75);

    const negResult = await billing.deductCredit('dev1', -5);
    assert.equal(negResult.success, false);
    assert.equal(negResult.balance, 75);
  });

  test('rejects zero for a developer with zero balance', async () => {
    const billing = new MockSorobanBilling({ dev1: 0 });

    const result = await billing.deductCredit('dev1', 0);

    assert.equal(result.success, false);
    assert.equal(billing.getBalance('dev1'), 0);
  });

  test('rejects zero for an unknown developer (balance defaults to 0)', async () => {
    const billing = new MockSorobanBilling();

    const result = await billing.deductCredit('unknown', 0);

    assert.equal(result.success, false);
    assert.equal(result.balance, 0);
  });

  test('rejects negative fractional amount', async () => {
    const billing = new MockSorobanBilling({ dev1: 100 });

    const result = await billing.deductCredit('dev1', -0.001);

    assert.equal(result.success, false);
    assert.equal(billing.getBalance('dev1'), 100);
  });
});

describe('MockSorobanBilling.deductCredit — valid positive amounts', () => {
  test('succeeds and reduces balance when funds are sufficient', async () => {
    const billing = new MockSorobanBilling({ dev1: 100 });

    const result = await billing.deductCredit('dev1', 30);

    assert.equal(result.success, true);
    assert.equal(result.balance, 70);
    assert.equal(billing.getBalance('dev1'), 70);
  });

  test('fails gracefully when funds are insufficient', async () => {
    const billing = new MockSorobanBilling({ dev1: 5 });

    const result = await billing.deductCredit('dev1', 10);

    assert.equal(result.success, false);
    assert.equal(result.balance, 5);
    assert.equal(billing.getBalance('dev1'), 5);
  });

  test('allows deduction to exact zero balance', async () => {
    const billing = new MockSorobanBilling({ dev1: 10 });

    const result = await billing.deductCredit('dev1', 10);

    assert.equal(result.success, true);
    assert.equal(result.balance, 0);
  });

  test('subsequent rejection after valid deduction reports updated balance', async () => {
    const billing = new MockSorobanBilling({ dev1: 50 });

    await billing.deductCredit('dev1', 50); // drains to 0
    const result = await billing.deductCredit('dev1', 0);

    assert.equal(result.success, false);
    assert.equal(result.balance, 0);
  });
});

describe('MockSorobanBilling.checkBalance', () => {
  test('returns 0 for unknown developers', async () => {
    const billing = new MockSorobanBilling();
    assert.equal(await billing.checkBalance('nobody'), 0);
  });

  test('reflects balance after successful deduction', async () => {
    const billing = new MockSorobanBilling({ dev1: 80 });

    await billing.deductCredit('dev1', 30);

    assert.equal(await billing.checkBalance('dev1'), 50);
  });

  test('is unchanged after a rejected deduction', async () => {
    const billing = new MockSorobanBilling({ dev1: 80 });

    await billing.deductCredit('dev1', -10);
    await billing.deductCredit('dev1', 0);

    assert.equal(await billing.checkBalance('dev1'), 80);
  });
});
