import { InMemoryApiRegistry } from '../data/apiRegistry.js';
import { calloraEvents } from '../events/event.emitter.js';
import { RevenueSettlementService } from '../services/revenueSettlementService.js';
import { InMemorySettlementStore } from '../services/settlementStore.js';
import { InMemoryUsageStore } from '../services/usageStore.js';
import type { SorobanSettlementClient } from '../services/sorobanSettlement.js';
import type { SettlementStore } from '../types/developer.js';
import type { ApiRegistry, UsageEvent, UsageStore } from '../types/gateway.js';

// 1 USDC = 10_000_000 contract units
const USDC = (n: number): bigint => BigInt(Math.round(n * 10_000_000));
jest.mock('../events/event.emitter.js', () => ({
  calloraEvents: {
    emit: jest.fn(),
  },
}));

const mockedEmit = jest.mocked(calloraEvents.emit);

function recordUsageEvent(
  store: UsageStore,
  event: { id: string; requestId: string; apiId: string; amountUsdc: bigint },
): void {
  const recorded: UsageEvent = {
    id: event.id,
    requestId: event.requestId,
    apiKeyId: `key-${event.id}`,
    apiId: event.apiId,
    endpointId: `${event.apiId}-endpoint`,
    userId: 'consumer-1',
    amountUsdc: event.amountUsdc,
    timestamp: new Date().toISOString(),
    statusCode: 200,
  };
  store.record(recorded);
}

describe('RevenueSettlementService', () => {
  let usageStore: InMemoryUsageStore;
  let settlementStore: InMemorySettlementStore;
  let apiRegistry: ApiRegistry;
  let distributeMock: jest.MockedFunction<SorobanSettlementClient['distribute']>;
  let client: SorobanSettlementClient;
  let service: RevenueSettlementService;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    mockedEmit.mockClear();
    usageStore = new InMemoryUsageStore();
    settlementStore = new InMemorySettlementStore();
    apiRegistry = new InMemoryApiRegistry([
      {
        id: 'api_1',
        slug: 'api-1',
        base_url: 'http://localhost',
        developerId: 'dev_1',
        endpoints: [],
      },
      {
        id: 'api_2',
        slug: 'api-2',
        base_url: 'http://localhost',
        developerId: 'dev_2',
        endpoints: [],
      },
    ]);

    distributeMock = jest.fn(async (developerId: string, _amountUsdc: bigint) => ({
      success: true,
      txHash: `0xmocktx_${developerId}`,
    }));
    client = { distribute: distributeMock };

    service = new RevenueSettlementService(usageStore, settlementStore, apiRegistry, client, {
      minPayoutUsdc: 5,
      maxEventsPerBatch: 10,
    });

    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('aggregates events and pays out when the minimum is met', async () => {
    recordUsageEvent(usageStore, { id: 'e1', requestId: 'r1', apiId: 'api_1', amountUsdc: USDC(4) });
    recordUsageEvent(usageStore, { id: 'e2', requestId: 'r2', apiId: 'api_1', amountUsdc: USDC(2) });

    const result = await service.runBatch();

    expect(result).toEqual({ processed: 2, settledAmount: USDC(6), errors: 0 });
    expect(distributeMock).toHaveBeenCalledWith('dev_1', USDC(6));

    const settlements = settlementStore.getDeveloperSettlements('dev_1');
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({
      developerId: 'dev_1',
      amount: USDC(6),
      status: 'completed',
      tx_hash: '0xmocktx_dev_1',
    });
    expect(settlements[0]?.completed_at).toBeTruthy();

    expect(usageStore.getUnsettledEvents()).toHaveLength(0);
    expect(mockedEmit).toHaveBeenCalledTimes(1);
    expect(mockedEmit).toHaveBeenCalledWith(
      'settlement_completed',
      'dev_1',
      expect.objectContaining({
        settlementId: settlements[0]?.id,
        amount: '6.0000000',  // formatUnitsToUsdcFixed — canonical 7-decimal webhook format
        asset: 'USDC',
        txHash: '0xmocktx_dev_1',
        settledAt: expect.any(String),
      }),
    );
  });

  it('skips developers whose accumulated payout is below the threshold', async () => {
    recordUsageEvent(usageStore, { id: 'e1', requestId: 'r1', apiId: 'api_1', amountUsdc: USDC(3) });

    const result = await service.runBatch();

    expect(result).toEqual({ processed: 0, settledAmount: 0n, errors: 0 });
    expect(distributeMock).not.toHaveBeenCalled();
    expect(settlementStore.getDeveloperSettlements('dev_1')).toHaveLength(0);
    expect(usageStore.getUnsettledEvents()).toHaveLength(1);
    expect(mockedEmit).not.toHaveBeenCalled();
  });

  it('respects the max events per batch limit per developer', async () => {
    for (let i = 0; i < 15; i++) {
      recordUsageEvent(usageStore, {
        id: `e${i}`,
        requestId: `r${i}`,
        apiId: 'api_1',
        amountUsdc: USDC(1),
      });
    }

    const result = await service.runBatch();

    expect(result).toEqual({ processed: 10, settledAmount: USDC(10), errors: 0 });
    expect(distributeMock).toHaveBeenCalledWith('dev_1', USDC(10));
    expect(usageStore.getUnsettledEvents()).toHaveLength(5);
  });

  it('ignores orphaned and non-positive events when building settlements', async () => {
    recordUsageEvent(usageStore, { id: 'e1', requestId: 'r1', apiId: 'api_unknown', amountUsdc: USDC(10) });
    recordUsageEvent(usageStore, { id: 'e2', requestId: 'r2', apiId: 'api_1', amountUsdc: 0n });
    recordUsageEvent(usageStore, { id: 'e3', requestId: 'r3', apiId: 'api_1', amountUsdc: 0n });
    recordUsageEvent(usageStore, { id: 'e4', requestId: 'r4', apiId: 'api_2', amountUsdc: USDC(7) });

    const result = await service.runBatch();

    expect(result).toEqual({ processed: 1, settledAmount: USDC(7), errors: 0 });
    expect(distributeMock).toHaveBeenCalledTimes(1);
    expect(distributeMock).toHaveBeenCalledWith('dev_2', USDC(7));
    expect(usageStore.getUnsettledEvents().map((event) => event.id).sort()).toEqual(['e1']);
  });

  it('records a failed settlement and leaves events unsettled when payout returns a failure', async () => {
    distributeMock.mockResolvedValueOnce({
      success: false,
      error: 'simulation failed',
    });

    recordUsageEvent(usageStore, { id: 'e1', requestId: 'r1', apiId: 'api_1', amountUsdc: USDC(10) });

    const result = await service.runBatch();

    expect(result).toEqual({ processed: 0, settledAmount: 0n, errors: 1 });
    expect(settlementStore.getDeveloperSettlements('dev_1')[0]).toMatchObject({
      status: 'failed',
      tx_hash: null,
    });
    expect(usageStore.getUnsettledEvents()).toHaveLength(1);
    expect(mockedEmit).not.toHaveBeenCalled();
  });

  it('records a failed settlement and leaves events unsettled when payout throws', async () => {
    distributeMock.mockRejectedValueOnce(new Error('rpc timeout'));

    recordUsageEvent(usageStore, { id: 'e1', requestId: 'r1', apiId: 'api_1', amountUsdc: USDC(10) });

    const result = await service.runBatch();

    expect(result).toEqual({ processed: 0, settledAmount: 0n, errors: 1 });
    expect(settlementStore.getDeveloperSettlements('dev_1')[0]).toMatchObject({
      status: 'failed',
      tx_hash: null,
    });
    expect(usageStore.getUnsettledEvents()).toHaveLength(1);
    expect(mockedEmit).not.toHaveBeenCalled();
  });

  it('continues processing other developers when settlement creation fails for one developer', async () => {
    const createSpy = jest
      .spyOn(settlementStore, 'create')
      .mockImplementation((settlement) => {
        if (settlement.developerId === 'dev_1') {
          throw new Error('database unavailable');
        }

        InMemorySettlementStore.prototype.create.call(settlementStore, settlement);
      });

    recordUsageEvent(usageStore, { id: 'e1', requestId: 'r1', apiId: 'api_1', amountUsdc: USDC(6) });
    recordUsageEvent(usageStore, { id: 'e2', requestId: 'r2', apiId: 'api_2', amountUsdc: USDC(7) });

    const result = await service.runBatch();

    expect(result).toEqual({ processed: 1, settledAmount: USDC(7), errors: 1 });
    expect(settlementStore.getDeveloperSettlements('dev_1')).toHaveLength(0);
    expect(settlementStore.getDeveloperSettlements('dev_2')[0]).toMatchObject({
      status: 'completed',
      tx_hash: '0xmocktx_dev_2',
    });
    expect(settlementStore.getDeveloperSettlements('dev_2')[0]?.completed_at).toBeTruthy();
    expect(usageStore.getUnsettledEvents().map((event) => event.id)).toEqual(['e1']);

    createSpy.mockRestore();
  });

  it('rolls a settlement back to failed and clears tx hash if marking events settled fails after payout', async () => {
    const markAsSettledSpy = jest
      .spyOn(usageStore, 'markAsSettled')
      .mockImplementation(() => {
        throw new Error('write conflict');
      });

    recordUsageEvent(usageStore, { id: 'e1', requestId: 'r1', apiId: 'api_1', amountUsdc: USDC(10) });

    const result = await service.runBatch();

    expect(result).toEqual({ processed: 0, settledAmount: 0n, errors: 1 });

    const settlements = settlementStore.getDeveloperSettlements('dev_1');
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({
      status: 'failed',
      tx_hash: null,
    });

    expect(usageStore.getUnsettledEvents()).toHaveLength(1);
    expect(mockedEmit).not.toHaveBeenCalled();
    markAsSettledSpy.mockRestore();
  });

  it('counts an error but continues when failed-status persistence also throws', async () => {
    distributeMock.mockResolvedValueOnce({
      success: false,
      error: 'soroban rejected transaction',
    });

    const settlementStoreWithFailure = settlementStore as SettlementStore;
    const updateStatusSpy = jest
      .spyOn(settlementStoreWithFailure, 'updateStatus')
      .mockImplementation((id, status, txHash) => {
        if (status === 'failed') {
          throw new Error('status update failed');
        }

        InMemorySettlementStore.prototype.updateStatus.call(settlementStore, id, status, txHash);
      });

    service = new RevenueSettlementService(usageStore, settlementStore, apiRegistry, client, {
      minPayoutUsdc: 5,
      maxEventsPerBatch: 10,
    });

    recordUsageEvent(usageStore, { id: 'e1', requestId: 'r1', apiId: 'api_1', amountUsdc: USDC(6) });
    recordUsageEvent(usageStore, { id: 'e2', requestId: 'r2', apiId: 'api_2', amountUsdc: USDC(7) });

    const result = await service.runBatch();

    expect(result).toEqual({ processed: 1, settledAmount: USDC(7), errors: 1 });
    expect(settlementStore.getDeveloperSettlements('dev_1')[0]).toMatchObject({
      status: 'pending',
      tx_hash: null,
    });
    expect(settlementStore.getDeveloperSettlements('dev_2')[0]).toMatchObject({
      status: 'completed',
      tx_hash: '0xmocktx_dev_2',
    });
    expect(settlementStore.getDeveloperSettlements('dev_2')[0]?.completed_at).toBeTruthy();
    expect(usageStore.getUnsettledEvents().map((event) => event.id)).toEqual(['e1']);

    updateStatusSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Issue #1512 regression tests
  // -------------------------------------------------------------------------

  it('10,000 events of 0.0000001 USDC each — payout is exactly 10000 contract units = "0.001" USDC', async () => {
    // Regression proof for float drift: 10_000 × 0.0000001 floats give
    // 0.0010000000000000002 but bigint gives exactly 10000 units.
    for (let i = 0; i < 10_000; i++) {
      recordUsageEvent(usageStore, {
        id: `e${i}`,
        requestId: `r${i}`,
        apiId: 'api_1',
        amountUsdc: 1n,  // 1 contract unit = 0.0000001 USDC
      });
    }

    // minPayout = 5 USDC = 50_000_000 units — won't fire. Lower the threshold.
    service = new RevenueSettlementService(usageStore, settlementStore, apiRegistry, client, {
      minPayoutUsdc: 0.0000001,  // 1 unit
      maxEventsPerBatch: 10_000,
    });

    const result = await service.runBatch();

    expect(result.settledAmount).toBe(10_000n);
    expect(distributeMock).toHaveBeenCalledWith('dev_1', 10_000n);
    expect(mockedEmit).toHaveBeenCalledWith(
      'settlement_completed',
      'dev_1',
      expect.objectContaining({ amount: '0.0010000' }),
    );
  });

  it('minPayout boundary — payout happens when totalAmount === minPayout (≥ semantics)', async () => {
    // minPayout = 5 USDC = 50_000_000 units
    // Events total exactly 5 USDC — should trigger payout
    recordUsageEvent(usageStore, { id: 'e1', requestId: 'r1', apiId: 'api_1', amountUsdc: USDC(3) });
    recordUsageEvent(usageStore, { id: 'e2', requestId: 'r2', apiId: 'api_1', amountUsdc: USDC(2) });

    const result = await service.runBatch();

    expect(result.processed).toBe(2);
    expect(distributeMock).toHaveBeenCalledWith('dev_1', USDC(5));
  });

  it('payout amount passed to the client is a bigint equal to the sum of claimed rows', async () => {
    recordUsageEvent(usageStore, { id: 'e1', requestId: 'r1', apiId: 'api_1', amountUsdc: USDC(3.5) });
    recordUsageEvent(usageStore, { id: 'e2', requestId: 'r2', apiId: 'api_1', amountUsdc: USDC(2.5) });

    await service.runBatch();

    const [, callAmount] = distributeMock.mock.calls[0] as [string, bigint];
    expect(typeof callAmount).toBe('bigint');
    expect(callAmount).toBe(USDC(6));
  });

  it('amount above 2^53 units is exact', async () => {
    const hugeAmount = BigInt(2 ** 53) + 1n;
    recordUsageEvent(usageStore, { id: 'e1', requestId: 'r1', apiId: 'api_1', amountUsdc: hugeAmount });

    service = new RevenueSettlementService(usageStore, settlementStore, apiRegistry, client, {
      minPayoutUsdc: 0.0000001,
      maxEventsPerBatch: 1,
    });

    await service.runBatch();

    expect(distributeMock).toHaveBeenCalledWith('dev_1', hugeAmount);
    expect(settlementStore.getDeveloperSettlements('dev_1')[0].amount).toBe(hugeAmount);
  });

  it('settlement_completed webhook payload has decimal string amount', async () => {
    recordUsageEvent(usageStore, { id: 'e1', requestId: 'r1', apiId: 'api_1', amountUsdc: USDC(7) });
    recordUsageEvent(usageStore, { id: 'e2', requestId: 'r2', apiId: 'api_1', amountUsdc: 1n });  // 0.0000001

    await service.runBatch();

    expect(mockedEmit).toHaveBeenCalledWith(
      'settlement_completed',
      'dev_1',
      expect.objectContaining({ amount: '7.0000001' }),
    );
  });

  it('reconciles pending settlements to completed when Horizon confirms the transaction', async () => {
    settlementStore.create({
      id: 'stl_1',
      developerId: 'dev_1',
      amount: USDC(12),
      status: 'pending',
      tx_hash: 'tx-confirmed',
      created_at: '2026-04-01T00:00:00.000Z',
    });

    service = new RevenueSettlementService(usageStore, settlementStore, apiRegistry, client, {
      fetchImpl: jest.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ successful: true }),
      })) as unknown as typeof fetch,
      horizonUrl: 'https://horizon-testnet.stellar.org/',
    });

    const result = await service.reconcilePendingSettlements();

    expect(result).toEqual({ checked: 1, completed: 1, failed: 0, retried: 0, errors: 0 });
    expect(settlementStore.getDeveloperSettlements('dev_1')[0]).toMatchObject({
      status: 'completed',
      tx_hash: 'tx-confirmed',
    });
    expect(settlementStore.getDeveloperSettlements('dev_1')[0]?.completed_at).toBeTruthy();
  });

  it('reconciles pending settlements to failed when Horizon reports an unsuccessful transaction', async () => {
    settlementStore.create({
      id: 'stl_1',
      developerId: 'dev_1',
      amount: USDC(12),
      status: 'pending',
      tx_hash: 'tx-failed',
      created_at: '2026-04-01T00:00:00.000Z',
    });

    service = new RevenueSettlementService(usageStore, settlementStore, apiRegistry, client, {
      fetchImpl: jest.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ successful: false }),
      })) as unknown as typeof fetch,
      horizonUrl: 'https://horizon-testnet.stellar.org/',
    });

    const result = await service.reconcilePendingSettlements();

    expect(result).toEqual({ checked: 1, completed: 0, failed: 1, retried: 0, errors: 0 });
    expect(settlementStore.getDeveloperSettlements('dev_1')[0]).toMatchObject({
      status: 'failed',
      tx_hash: 'tx-failed',
      completed_at: null,
    });
  });

  it('treats missing Horizon transactions as failed settlements', async () => {
    settlementStore.create({
      id: 'stl_1',
      developerId: 'dev_1',
      amount: USDC(12),
      status: 'pending',
      tx_hash: 'tx-missing',
      created_at: '2026-04-01T00:00:00.000Z',
    });

    service = new RevenueSettlementService(usageStore, settlementStore, apiRegistry, client, {
      fetchImpl: jest.fn(async () => ({
        ok: false,
        status: 404,
        json: async () => ({}),
      })) as unknown as typeof fetch,
      horizonUrl: 'https://horizon-testnet.stellar.org/',
    });

    const result = await service.reconcilePendingSettlements();

    expect(result).toEqual({ checked: 1, completed: 0, failed: 1, retried: 0, errors: 0 });
    expect(settlementStore.getDeveloperSettlements('dev_1')[0]?.status).toBe('failed');
  });

  it('retries transient Horizon errors with backoff and completes once Horizon succeeds', async () => {
    settlementStore.create({
      id: 'stl_1',
      developerId: 'dev_1',
      amount: USDC(12),
      status: 'pending',
      tx_hash: 'tx-retry',
      created_at: '2026-04-01T00:00:00.000Z',
    });

    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ successful: true }),
      });

    const setTimeoutSpy = jest
      .spyOn(global, 'setTimeout')
      .mockImplementation(((fn: (...args: unknown[]) => void) => {
        fn();
        return 0 as unknown as NodeJS.Timeout;
      }) as typeof setTimeout);

    service = new RevenueSettlementService(usageStore, settlementStore, apiRegistry, client, {
      fetchImpl: fetchMock as unknown as typeof fetch,
      horizonUrl: 'https://horizon-testnet.stellar.org/',
      horizonMaxRetries: 1,
      horizonRetryBaseDelayMs: 1,
    });

    const result = await service.reconcilePendingSettlements();

    expect(result).toEqual({ checked: 1, completed: 1, failed: 0, retried: 0, errors: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    setTimeoutSpy.mockRestore();
  });

  it('does not flip settlement status when Horizon transient errors exhaust retries', async () => {
    settlementStore.create({
      id: 'stl_1',
      developerId: 'dev_1',
      amount: USDC(12),
      status: 'pending',
      tx_hash: 'tx-still-pending',
      created_at: '2026-04-01T00:00:00.000Z',
    });

    const setTimeoutSpy = jest
      .spyOn(global, 'setTimeout')
      .mockImplementation(((fn: (...args: unknown[]) => void) => {
        fn();
        return 0 as unknown as NodeJS.Timeout;
      }) as typeof setTimeout);

    service = new RevenueSettlementService(usageStore, settlementStore, apiRegistry, client, {
      fetchImpl: jest.fn(async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
      horizonUrl: 'https://horizon-testnet.stellar.org/',
      horizonMaxRetries: 1,
      horizonRetryBaseDelayMs: 1,
    });

    const result = await service.reconcilePendingSettlements();

    expect(result).toEqual({ checked: 1, completed: 0, failed: 0, retried: 0, errors: 1 });
    expect(settlementStore.getDeveloperSettlements('dev_1')[0]).toMatchObject({
      status: 'pending',
      tx_hash: 'tx-still-pending',
      completed_at: null,
    });
    setTimeoutSpy.mockRestore();
  });
});
