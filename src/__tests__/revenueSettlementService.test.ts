import { InMemoryApiRegistry } from '../data/apiRegistry.js';
import { RevenueSettlementService } from '../services/revenueSettlementService.js';
import { InMemorySettlementStore } from '../services/settlementStore.js';
import { InMemoryUsageStore } from '../services/usageStore.js';
import type { SorobanSettlementClient } from '../services/sorobanSettlement.js';
import type { SettlementStore } from '../types/developer.js';
import type { ApiRegistry, UsageEvent, UsageStore } from '../types/gateway.js';

describe('RevenueSettlementService', () => {
  let usageStore: InMemoryUsageStore;
  let settlementStore: InMemorySettlementStore;
  let apiRegistry: ApiRegistry;
  let distributeMock: jest.MockedFunction<SorobanSettlementClient['distribute']>;
  let client: SorobanSettlementClient;
  let service: RevenueSettlementService;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
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

    distributeMock = jest.fn(async (developerId: string, _amountUsdc: number) => ({
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
    recordUsageEvent(usageStore, { id: 'e1', requestId: 'r1', apiId: 'api_1', amountUsdc: 4 });
    recordUsageEvent(usageStore, { id: 'e2', requestId: 'r2', apiId: 'api_1', amountUsdc: 2 });

    const result = await service.runBatch();

    expect(result).toEqual({ processed: 2, settledAmount: 6, errors: 0 });
    expect(distributeMock).toHaveBeenCalledWith('dev_1', 6);

    const settlements = settlementStore.getDeveloperSettlements('dev_1');
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({
      developerId: 'dev_1',
      amount: 6,
      status: 'completed',
      tx_hash: '0xmocktx_dev_1',
    });

    expect(usageStore.getUnsettledEvents()).toHaveLength(0);
  });

  it('skips developers whose accumulated payout is below the threshold', async () => {
    recordUsageEvent(usageStore, { id: 'e1', requestId: 'r1', apiId: 'api_1', amountUsdc: 3 });

    const result = await service.runBatch();

    expect(result).toEqual({ processed: 0, settledAmount: 0, errors: 0 });
    expect(distributeMock).not.toHaveBeenCalled();
    expect(settlementStore.getDeveloperSettlements('dev_1')).toHaveLength(0);
    expect(usageStore.getUnsettledEvents()).toHaveLength(1);
  });

  it('respects the max events per batch limit per developer', async () => {
    for (let i = 0; i < 15; i++) {
      recordUsageEvent(usageStore, {
        id: `e${i}`,
        requestId: `r${i}`,
        apiId: 'api_1',
        amountUsdc: 1,
      });
    }

    const result = await service.runBatch();

    expect(result).toEqual({ processed: 10, settledAmount: 10, errors: 0 });
    expect(distributeMock).toHaveBeenCalledWith('dev_1', 10);
    expect(usageStore.getUnsettledEvents()).toHaveLength(5);
  });

  it('ignores orphaned and non-positive events when building settlements', async () => {
    recordUsageEvent(usageStore, { id: 'e1', requestId: 'r1', apiId: 'api_unknown', amountUsdc: 10 });
    recordUsageEvent(usageStore, { id: 'e2', requestId: 'r2', apiId: 'api_1', amountUsdc: 0 });
    recordUsageEvent(usageStore, { id: 'e3', requestId: 'r3', apiId: 'api_1', amountUsdc: -5 });
    recordUsageEvent(usageStore, { id: 'e4', requestId: 'r4', apiId: 'api_2', amountUsdc: 7 });

    const result = await service.runBatch();

    expect(result).toEqual({ processed: 1, settledAmount: 7, errors: 0 });
    expect(distributeMock).toHaveBeenCalledTimes(1);
    expect(distributeMock).toHaveBeenCalledWith('dev_2', 7);
    expect(usageStore.getUnsettledEvents().map((event) => event.id).sort()).toEqual(['e1']);
  });

  it('records a failed settlement and leaves events unsettled when payout returns a failure', async () => {
    distributeMock.mockResolvedValueOnce({
      success: false,
      error: 'simulation failed',
    });

    recordUsageEvent(usageStore, { id: 'e1', requestId: 'r1', apiId: 'api_1', amountUsdc: 10 });

    const result = await service.runBatch();

    expect(result).toEqual({ processed: 0, settledAmount: 0, errors: 1 });
    expect(settlementStore.getDeveloperSettlements('dev_1')[0]).toMatchObject({
      status: 'failed',
      tx_hash: null,
    });
    expect(usageStore.getUnsettledEvents()).toHaveLength(1);
  });

  it('records a failed settlement and leaves events unsettled when payout throws', async () => {
    distributeMock.mockRejectedValueOnce(new Error('rpc timeout'));

    recordUsageEvent(usageStore, { id: 'e1', requestId: 'r1', apiId: 'api_1', amountUsdc: 10 });

    const result = await service.runBatch();

    expect(result).toEqual({ processed: 0, settledAmount: 0, errors: 1 });
    expect(settlementStore.getDeveloperSettlements('dev_1')[0]).toMatchObject({
      status: 'failed',
      tx_hash: null,
    });
    expect(usageStore.getUnsettledEvents()).toHaveLength(1);
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

    recordUsageEvent(usageStore, { id: 'e1', requestId: 'r1', apiId: 'api_1', amountUsdc: 6 });
    recordUsageEvent(usageStore, { id: 'e2', requestId: 'r2', apiId: 'api_2', amountUsdc: 7 });

    const result = await service.runBatch();

    expect(result).toEqual({ processed: 1, settledAmount: 7, errors: 1 });
    expect(settlementStore.getDeveloperSettlements('dev_1')).toHaveLength(0);
    expect(settlementStore.getDeveloperSettlements('dev_2')[0]).toMatchObject({
      status: 'completed',
      tx_hash: '0xmocktx_dev_2',
    });
    expect(usageStore.getUnsettledEvents().map((event) => event.id)).toEqual(['e1']);

    createSpy.mockRestore();
  });

  it('rolls a settlement back to failed and clears tx hash if marking events settled fails after payout', async () => {
    const markAsSettledSpy = jest
      .spyOn(usageStore, 'markAsSettled')
      .mockImplementation(() => {
        throw new Error('write conflict');
      });

    recordUsageEvent(usageStore, { id: 'e1', requestId: 'r1', apiId: 'api_1', amountUsdc: 10 });

    const result = await service.runBatch();

    expect(result).toEqual({ processed: 0, settledAmount: 0, errors: 1 });

    const settlements = settlementStore.getDeveloperSettlements('dev_1');
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({
      status: 'failed',
      tx_hash: null,
    });

    expect(usageStore.getUnsettledEvents()).toHaveLength(1);
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

    recordUsageEvent(usageStore, { id: 'e1', requestId: 'r1', apiId: 'api_1', amountUsdc: 6 });
    recordUsageEvent(usageStore, { id: 'e2', requestId: 'r2', apiId: 'api_2', amountUsdc: 7 });

    const result = await service.runBatch();

    expect(result).toEqual({ processed: 1, settledAmount: 7, errors: 1 });
    expect(settlementStore.getDeveloperSettlements('dev_1')[0]).toMatchObject({
      status: 'pending',
      tx_hash: null,
    });
    expect(settlementStore.getDeveloperSettlements('dev_2')[0]).toMatchObject({
      status: 'completed',
      tx_hash: '0xmocktx_dev_2',
    });
    expect(usageStore.getUnsettledEvents().map((event) => event.id)).toEqual(['e1']);

    updateStatusSpy.mockRestore();
  });
});

function recordUsageEvent(
  usageStore: UsageStore,
  overrides: Pick<UsageEvent, 'id' | 'requestId' | 'apiId' | 'amountUsdc'>
): void {
  usageStore.record({
    id: overrides.id,
    requestId: overrides.requestId,
    apiKey: 'key_1',
    apiKeyId: 'key_1',
    apiId: overrides.apiId,
    endpointId: 'endpoint_1',
    userId: 'caller_1',
    amountUsdc: overrides.amountUsdc,
    statusCode: 200,
    timestamp: new Date().toISOString(),
  });
}
