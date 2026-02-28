import { createSettlementStore } from '../services/settlementStore.js';
import { createUsageStore } from '../services/usageStore.js';
import { createSorobanSettlementClient } from '../services/sorobanSettlement.js';
import { RevenueSettlementService } from '../services/revenueSettlementService.js';
import { InMemoryApiRegistry } from '../data/apiRegistry.js';
import { SettlementStore } from '../types/developer.js';
import { ApiRegistry, UsageStore } from '../types/gateway.js';

describe('RevenueSettlementService', () => {
  let usageStore: UsageStore;
  let settlementStore: SettlementStore;
  let apiRegistry: ApiRegistry;
  let client: ReturnType<typeof createSorobanSettlementClient>;
  let service: RevenueSettlementService;

  beforeEach(() => {
    usageStore = createUsageStore();
    settlementStore = createSettlementStore();
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
    client = createSorobanSettlementClient(0); // 0% failure rate
    service = new RevenueSettlementService(usageStore, settlementStore, apiRegistry, client, {
      minPayoutUsdc: 5.0,
      maxEventsPerBatch: 10,
    });
  });

  it('aggregates events and pays out when minimum is met', async () => {
    // dev_1 has 2 events totaling 6.0 USDC
    usageStore.record({
      id: 'e1',
      requestId: 'r1',
      apiKey: 'k1',
      apiKeyId: 'k1',
      apiId: 'api_1',
      endpointId: 'ep1',
      userId: 'dev_1',
      amountUsdc: 4.0,
      statusCode: 200,
      timestamp: new Date().toISOString(),
    });
    usageStore.record({
      id: 'e2',
      requestId: 'r2',
      apiKey: 'k1',
      apiKeyId: 'k1',
      apiId: 'api_1',
      endpointId: 'ep1',
      userId: 'dev_1',
      amountUsdc: 2.0,
      statusCode: 200,
      timestamp: new Date().toISOString(),
    });

    const result = await service.runBatch();

    expect(result.processed).toBe(2);
    expect(result.settledAmount).toBe(6.0);
    expect(result.errors).toBe(0);

    // Verify settlement record is created and completed
    const settlements = settlementStore.getDeveloperSettlements('dev_1');
    expect(settlements).toHaveLength(1);
    expect(settlements[0].amount).toBe(6.0);
    expect(settlements[0].status).toBe('completed');
    expect(settlements[0].tx_hash).toMatch(/0xmocktx/);

    // Verify events are marked as settled
    const unsettled = usageStore.getUnsettledEvents();
    expect(unsettled).toHaveLength(0);
  });

  it('skips developer if minimum payout is not met', async () => {
    // dev_1 has 1 event for 3.0 USDC (min is 5.0)
    usageStore.record({
      id: 'e1',
      requestId: 'r1',
      apiKey: 'k1',
      apiKeyId: 'k1',
      apiId: 'api_1',
      endpointId: 'ep1',
      userId: 'dev_1',
      amountUsdc: 3.0,
      statusCode: 200,
      timestamp: new Date().toISOString(),
    });

    const result = await service.runBatch();

    expect(result.processed).toBe(0);
    expect(result.settledAmount).toBe(0);
    expect(result.errors).toBe(0);

    // No settlement created
    const settlements = settlementStore.getDeveloperSettlements('dev_1');
    expect(settlements).toHaveLength(0);

    // Event is still unsettled
    const unsettled = usageStore.getUnsettledEvents();
    expect(unsettled).toHaveLength(1);
  });

  it('respects max events per batch limit', async () => {
    // Create 15 events for dev_1, each 1.0 USDC
    for (let i = 0; i < 15; i++) {
      usageStore.record({
        id: `e${i}`,
        requestId: `r${i}`,
        apiKey: 'k1',
        apiKeyId: 'k1',
        apiId: 'api_1',
        endpointId: 'ep1',
        userId: 'dev_1',
        amountUsdc: 1.0,
        statusCode: 200,
        timestamp: new Date().toISOString(),
      });
    }

    const result = await service.runBatch();

    // Should only process the max of 10 events
    expect(result.processed).toBe(10);
    expect(result.settledAmount).toBe(10.0);

    const unsettled = usageStore.getUnsettledEvents();
    expect(unsettled).toHaveLength(5); // 5 events left for next batch
  });

  it('handles Soroban settlement failures without losing events', async () => {
    // Set mock client to 100% failure rate
    client = createSorobanSettlementClient(1.0);
    service = new RevenueSettlementService(usageStore, settlementStore, apiRegistry, client, {
      minPayoutUsdc: 5.0,
    });

    usageStore.record({
      id: 'e1',
      requestId: 'r1',
      apiKey: 'k1',
      apiKeyId: 'k1',
      apiId: 'api_1',
      endpointId: 'ep1',
      userId: 'dev_1',
      amountUsdc: 10.0,
      statusCode: 200,
      timestamp: new Date().toISOString(),
    });

    const result = await service.runBatch();

    // Contract distribution failed
    expect(result.processed).toBe(0);
    expect(result.errors).toBe(1);

    // Settlement record is marked as failed
    const settlements = settlementStore.getDeveloperSettlements('dev_1');
    expect(settlements).toHaveLength(1);
    expect(settlements[0].status).toBe('failed');

    // UsageEvent is STILL unsettled, ready for next batch retry
    const unsettled = usageStore.getUnsettledEvents();
    expect(unsettled).toHaveLength(1);
    expect(unsettled[0].settlementId).toBeUndefined();
  });

  it('ignores orphaned events (API deleted/not found)', async () => {
    // api_unknown is not in registry
    usageStore.record({
      id: 'e1',
      requestId: 'r1',
      apiKey: 'k1',
      apiKeyId: 'k1',
      apiId: 'api_unknown',
      endpointId: 'ep1',
      userId: 'dev_old',
      amountUsdc: 10.0,
      statusCode: 200,
      timestamp: new Date().toISOString(),
    });

    const result = await service.runBatch();

    expect(result.processed).toBe(0);

    // Still unsettled in the store, just skipped
    expect(usageStore.getUnsettledEvents()).toHaveLength(1);
  });
});
