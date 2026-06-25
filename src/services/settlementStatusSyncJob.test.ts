import { RevenueSettlementService } from './revenueSettlementService.js';
import { InMemorySettlementStore } from './settlementStore.js';
import { InMemoryUsageStore } from './usageStore.js';
import { InMemoryApiRegistry } from '../data/apiRegistry.js';
import type { SorobanSettlementClient } from './sorobanSettlement.js';

describe('settlementStatusSyncJob - reconcilePendingSettlements', () => {
  let usageStore: InMemoryUsageStore;
  let settlementStore: InMemorySettlementStore;
  let apiRegistry: InMemoryApiRegistry;
  let client: SorobanSettlementClient;
  let service: RevenueSettlementService;
  let warnSpy: jest.SpyInstance;

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
    ]);

    client = {
      distribute: jest.fn(async () => ({
        success: true,
        txHash: '0xmock',
      })),
    };

    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  describe('a) normal tx_failed WITH result_codes — maps to correct status', () => {
    it('updates settlement to failed when Horizon returns tx_failed with result_codes', async () => {
      settlementStore.create({
        id: 'stl_1',
        developerId: 'dev_1',
        amount: 12,
        status: 'pending',
        tx_hash: 'tx-with-codes',
        created_at: '2026-04-01T00:00:00.000Z',
      });

      service = new RevenueSettlementService(usageStore, settlementStore, apiRegistry, client, {
        fetchImpl: jest.fn(async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            successful: false,
            result_codes: {
              transaction: 'tx_bad_seq',
            },
          }),
        })) as unknown as typeof fetch,
        horizonUrl: 'https://horizon-testnet.stellar.org/',
      });

      const result = await service.reconcilePendingSettlements();

      expect(result).toEqual({ checked: 1, completed: 0, failed: 1, errors: 0 });
      expect(settlementStore.getDeveloperSettlements('dev_1')[0]).toMatchObject({
        status: 'failed',
        tx_hash: 'tx-with-codes',
      });
      // No WARN for missing result_codes since it's present
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ settlementId: 'stl_1' }),
        expect.stringContaining('missing result_codes')
      );
    });
  });

  describe('b) tx_failed WITHOUT result_codes — falls back to failed_unknown', () => {
    it('updates settlement to failed and logs warning when result_codes is missing', async () => {
      settlementStore.create({
        id: 'stl_2',
        developerId: 'dev_1',
        amount: 12,
        status: 'pending',
        tx_hash: 'tx-no-codes',
        created_at: '2026-04-01T00:00:00.000Z',
      });

      service = new RevenueSettlementService(usageStore, settlementStore, apiRegistry, client, {
        fetchImpl: jest.fn(async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            successful: false,
            // No result_codes field
          }),
        })) as unknown as typeof fetch,
        horizonUrl: 'https://horizon-testnet.stellar.org/',
      });

      const result = await service.reconcilePendingSettlements();

      expect(result).toEqual({ checked: 1, completed: 0, failed: 1, errors: 0 });
      expect(settlementStore.getDeveloperSettlements('dev_1')[0]).toMatchObject({
        status: 'failed',
        tx_hash: 'tx-no-codes',
      });
      // WARN logged about missing result_codes
      expect(warnSpy).toHaveBeenCalledWith(
        { settlementId: 'stl_2' },
        'Horizon returned tx_failed but missing result_codes'
      );
    });
  });

  describe('c) result_codes present but transaction field missing', () => {
    it('updates settlement to failed and logs warning when transaction code is missing', async () => {
      settlementStore.create({
        id: 'stl_3',
        developerId: 'dev_1',
        amount: 12,
        status: 'pending',
        tx_hash: 'tx-empty-codes',
        created_at: '2026-04-01T00:00:00.000Z',
      });

      service = new RevenueSettlementService(usageStore, settlementStore, apiRegistry, client, {
        fetchImpl: jest.fn(async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            successful: false,
            result_codes: {
              // Empty result_codes object, no transaction field
              operations: [],
            },
          }),
        })) as unknown as typeof fetch,
        horizonUrl: 'https://horizon-testnet.stellar.org/',
      });

      const result = await service.reconcilePendingSettlements();

      expect(result).toEqual({ checked: 1, completed: 0, failed: 1, errors: 0 });
      expect(settlementStore.getDeveloperSettlements('dev_1')[0]).toMatchObject({
        status: 'failed',
      });
      // WARN logged about missing transaction code
      expect(warnSpy).toHaveBeenCalledWith(
        { settlementId: 'stl_3' },
        'Horizon returned tx_failed but missing result_codes'
      );
    });
  });

  describe('d) completely null/undefined Horizon response', () => {
    it('updates settlement to failed when fetchHorizonStatus returns null', async () => {
      settlementStore.create({
        id: 'stl_4',
        developerId: 'dev_1',
        amount: 12,
        status: 'pending',
        tx_hash: 'tx-not-found',
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

      expect(result).toEqual({ checked: 1, completed: 0, failed: 1, errors: 0 });
      expect(settlementStore.getDeveloperSettlements('dev_1')[0]).toMatchObject({
        status: 'failed',
      });
      // WARN logged about transaction not found
      expect(warnSpy).toHaveBeenCalledWith(
        { settlementId: 'stl_4' },
        'Horizon did not find transaction'
      );
    });
  });

  describe('e) one bad settlement does not abort the batch', () => {
    it('continues processing other settlements when one throws an exception', async () => {
      settlementStore.create({
        id: 'stl_5a',
        developerId: 'dev_1',
        amount: 12,
        status: 'pending',
        tx_hash: 'tx-ok-1',
        created_at: '2026-04-01T00:00:00.000Z',
      });

      settlementStore.create({
        id: 'stl_5b',
        developerId: 'dev_1',
        amount: 12,
        status: 'pending',
        tx_hash: 'tx-throws',
        created_at: '2026-04-01T00:00:01.000Z',
      });

      settlementStore.create({
        id: 'stl_5c',
        developerId: 'dev_1',
        amount: 12,
        status: 'pending',
        tx_hash: 'tx-ok-2',
        created_at: '2026-04-01T00:00:02.000Z',
      });

      let callCount = 0;
      const fetchMock = jest.fn(async () => {
        callCount++;
        if (callCount === 2) {
          // Second call (stl_5b) throws
          throw new TypeError('Network error');
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ successful: true }),
        };
      });

      service = new RevenueSettlementService(usageStore, settlementStore, apiRegistry, client, {
        fetchImpl: fetchMock as unknown as typeof fetch,
        horizonUrl: 'https://horizon-testnet.stellar.org/',
      });

      const result = await service.reconcilePendingSettlements();

      // stl_5a and stl_5c should be completed, stl_5b should error but not abort
      expect(result).toEqual({ checked: 3, completed: 2, failed: 0, errors: 1 });
      expect(settlementStore.getDeveloperSettlements('dev_1')[0]).toMatchObject({
        id: 'stl_5c',
        status: 'completed',
      });
      expect(settlementStore.getDeveloperSettlements('dev_1')[1]).toMatchObject({
        id: 'stl_5b',
        status: 'pending',
      });
      expect(settlementStore.getDeveloperSettlements('dev_1')[2]).toMatchObject({
        id: 'stl_5a',
        status: 'completed',
      });
      // WARN logged for stl_5b failure
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ settlementId: 'stl_5b' }),
        'Failed to sync settlement status — skipping'
      );
    });
  });

  describe('f) successful tx_success response still works (regression)', () => {
    it('updates settlement to completed when Horizon returns successful=true', async () => {
      settlementStore.create({
        id: 'stl_6',
        developerId: 'dev_1',
        amount: 12,
        status: 'pending',
        tx_hash: 'tx-success',
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

      expect(result).toEqual({ checked: 1, completed: 1, failed: 0, errors: 0 });
      expect(settlementStore.getDeveloperSettlements('dev_1')[0]).toMatchObject({
        status: 'completed',
        tx_hash: 'tx-success',
      });
      // No WARN logged for successful transactions
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('g) malformed Horizon response (non-object)', () => {
    it('falls back gracefully when Horizon response is not an object', async () => {
      settlementStore.create({
        id: 'stl_7',
        developerId: 'dev_1',
        amount: 12,
        status: 'pending',
        tx_hash: 'tx-malformed',
        created_at: '2026-04-01T00:00:00.000Z',
      });

      service = new RevenueSettlementService(usageStore, settlementStore, apiRegistry, client, {
        fetchImpl: jest.fn(async () => ({
          ok: true,
          status: 200,
          json: async () => 'not an object',
        })) as unknown as typeof fetch,
        horizonUrl: 'https://horizon-testnet.stellar.org/',
      });

      const result = await service.reconcilePendingSettlements();

      // Should not crash, settlement stays pending, error counted
      expect(result).toEqual({ checked: 1, completed: 0, failed: 0, errors: 1 });
      expect(settlementStore.getDeveloperSettlements('dev_1')[0]).toMatchObject({
        status: 'pending',
      });
      // WARN logged about unexpected response
      expect(warnSpy).toHaveBeenCalledWith(
        { settlementId: 'stl_7' },
        'Unexpected Horizon response shape — leaving settlement pending'
      );
    });
  });

  describe('Additional: batch continues when updateStatus fails', () => {
    it('counts error but continues to next settlement when updateStatus throws', async () => {
      settlementStore.create({
        id: 'stl_8a',
        developerId: 'dev_1',
        amount: 12,
        status: 'pending',
        tx_hash: 'tx-db-fail',
        created_at: '2026-04-01T00:00:00.000Z',
      });

      settlementStore.create({
        id: 'stl_8b',
        developerId: 'dev_1',
        amount: 12,
        status: 'pending',
        tx_hash: 'tx-ok',
        created_at: '2026-04-01T00:00:01.000Z',
      });

      const updateStatusSpy = jest
        .spyOn(settlementStore, 'updateStatus')
        .mockImplementation((id) => {
          if (id === 'stl_8a') {
            throw new Error('Database connection lost');
          }
          // For stl_8b, call original
          InMemorySettlementStore.prototype.updateStatus.call(settlementStore, id, 'completed');
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

      expect(result).toEqual({ checked: 2, completed: 1, failed: 0, errors: 1 });
      expect(settlementStore.getDeveloperSettlements('dev_1')[0]).toMatchObject({
        id: 'stl_8b',
        status: 'completed',
      });
      // stl_8a still pending because updateStatus failed
      expect(settlementStore.getDeveloperSettlements('dev_1')[1]).toMatchObject({
        id: 'stl_8a',
        status: 'pending',
      });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ settlementId: 'stl_8a' }),
        expect.stringContaining('Failed to update settlement')
      );

      updateStatusSpy.mockRestore();
    });
  });

  describe('Additional: no horizonUrl configured', () => {
    it('returns empty result when Horizon URL is not configured', async () => {
      settlementStore.create({
        id: 'stl_9',
        developerId: 'dev_1',
        amount: 12,
        status: 'pending',
        tx_hash: 'tx-9',
        created_at: '2026-04-01T00:00:00.000Z',
      });

      service = new RevenueSettlementService(usageStore, settlementStore, apiRegistry, client, {
        // No horizonUrl
      });

      const result = await service.reconcilePendingSettlements();

      // Skipped because Horizon not configured
      expect(result).toEqual({ checked: 0, completed: 0, failed: 0, errors: 0 });
      // Settlement still pending
      expect(settlementStore.getDeveloperSettlements('dev_1')[0]).toMatchObject({
        status: 'pending',
      });
    });
  });

  describe('Additional: transient errors retry and succeed', () => {
    it('retries transient Horizon errors with backoff and completes once successful', async () => {
      settlementStore.create({
        id: 'stl_10',
        developerId: 'dev_1',
        amount: 12,
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

      expect(result).toEqual({ checked: 1, completed: 1, failed: 0, errors: 0 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(settlementStore.getDeveloperSettlements('dev_1')[0]).toMatchObject({
        status: 'completed',
      });

      setTimeoutSpy.mockRestore();
    });
  });
});
