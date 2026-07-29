import { InMemorySettlementStore, createSettlementStore } from '../services/settlementStore.js';
import type { Settlement } from '../types/developer.js';

describe('InMemorySettlementStore', () => {
  let store: InMemorySettlementStore;

  beforeEach(() => {
    store = createSettlementStore();
  });

  describe('Persistence Semantics', () => {
    it('creates and retrieves settlements correctly', () => {
      const settlement: Settlement = {
        id: 'stl_123',
        developerId: 'dev_1',
        amount: 100.50,
        status: 'pending',
        tx_hash: null,
        created_at: '2024-01-01T00:00:00.000Z',
      };

      store.create(settlement);
      const settlements = store.getDeveloperSettlements('dev_1');

      expect(settlements).toHaveLength(1);
      expect(settlements[0]).toEqual(settlement);
    });

    it('maintains settlement order by creation date (newest first)', () => {
      const older: Settlement = {
        id: 'stl_older',
        developerId: 'dev_1',
        amount: 50,
        status: 'pending',
        tx_hash: null,
        created_at: '2024-01-01T00:00:00.000Z',
      };

      const newer: Settlement = {
        id: 'stl_newer',
        developerId: 'dev_1',
        amount: 75,
        status: 'pending',
        tx_hash: null,
        created_at: '2024-01-02T00:00:00.000Z',
      };

      store.create(older);
      store.create(newer);

      const settlements = store.getDeveloperSettlements('dev_1');

      expect(settlements).toHaveLength(2);
      expect(settlements[0].id).toBe('stl_newer'); // First (newest)
      expect(settlements[1].id).toBe('stl_older'); // Second (older)
    });

    it('isolates settlements by developer ID', () => {
      const settlement1: Settlement = {
        id: 'stl_1',
        developerId: 'dev_1',
        amount: 100,
        status: 'pending',
        tx_hash: null,
        created_at: '2024-01-01T00:00:00.000Z',
      };

      const settlement2: Settlement = {
        id: 'stl_2',
        developerId: 'dev_2',
        amount: 200,
        status: 'pending',
        tx_hash: null,
        created_at: '2024-01-01T00:00:00.000Z',
      };

      store.create(settlement1);
      store.create(settlement2);

      const dev1Settlements = store.getDeveloperSettlements('dev_1');
      const dev2Settlements = store.getDeveloperSettlements('dev_2');

      expect(dev1Settlements).toHaveLength(1);
      expect(dev1Settlements[0].id).toBe('stl_1');

      expect(dev2Settlements).toHaveLength(1);
      expect(dev2Settlements[0].id).toBe('stl_2');
    });

    it('returns empty array for developer with no settlements', () => {
      const settlements = store.getDeveloperSettlements('nonexistent_dev');
      expect(settlements).toEqual([]);
    });

    it('clears all settlements', () => {
      const settlement: Settlement = {
        id: 'stl_1',
        developerId: 'dev_1',
        amount: 100,
        status: 'pending',
        tx_hash: null,
        created_at: '2024-01-01T00:00:00.000Z',
      };

      store.create(settlement);
      expect(store.getDeveloperSettlements('dev_1')).toHaveLength(1);

      store.clear();
      expect(store.getDeveloperSettlements('dev_1')).toEqual([]);
    });
  });

  describe('Deduplication Keys', () => {
    it('allows multiple settlements with same developer but different IDs', () => {
      const settlement1: Settlement = {
        id: 'stl_1',
        developerId: 'dev_1',
        amount: 100,
        status: 'pending',
        tx_hash: null,
        created_at: '2024-01-01T00:00:00.000Z',
      };

      const settlement2: Settlement = {
        id: 'stl_2',
        developerId: 'dev_1',
        amount: 150,
        status: 'pending',
        tx_hash: null,
        created_at: '2024-01-01T01:00:00.000Z',
      };

      store.create(settlement1);
      store.create(settlement2);

      const settlements = store.getDeveloperSettlements('dev_1');
      expect(settlements).toHaveLength(2);
    });

    it('stores settlements with identical IDs separately (no built-in deduplication)', () => {
      const settlement: Settlement = {
        id: 'duplicate_id',
        developerId: 'dev_1',
        amount: 100,
        status: 'pending',
        tx_hash: null,
        created_at: '2024-01-01T00:00:00.000Z',
      };

      const duplicate: Settlement = {
        id: 'duplicate_id',
        developerId: 'dev_1',
        amount: 200, // Different amount
        status: 'pending',
        tx_hash: null,
        created_at: '2024-01-01T01:00:00.000Z',
      };

      store.create(settlement);
      store.create(duplicate);

      const settlements = store.getDeveloperSettlements('dev_1');
      expect(settlements).toHaveLength(2);
      
      // Both settlements are stored, last one comes first in ordering
      expect(settlements[0].amount).toBe(200);
      expect(settlements[1].amount).toBe(100);
    });
  });

  describe('Status Transitions', () => {
    let settlement: Settlement;

    beforeEach(() => {
      settlement = {
        id: 'stl_123',
        developerId: 'dev_1',
        amount: 100,
        status: 'pending',
        tx_hash: null,
        created_at: '2024-01-01T00:00:00.000Z',
      };
      store.create(settlement);
    });

    it('updates status from pending to completed with transaction hash', () => {
      store.updateStatus('stl_123', 'completed', '0xtxhash123');

      const settlements = store.getDeveloperSettlements('dev_1');
      expect(settlements[0].status).toBe('completed');
      expect(settlements[0].tx_hash).toBe('0xtxhash123');
    });

    it('updates status from pending to failed without transaction hash', () => {
      store.updateStatus('stl_123', 'failed');

      const settlements = store.getDeveloperSettlements('dev_1');
      expect(settlements[0].status).toBe('failed');
      expect(settlements[0].tx_hash).toBe(null);
    });

    it('allows transition from completed to failed', () => {
      // First mark as completed
      store.updateStatus('stl_123', 'completed', '0xtxhash123');
      
      // Then mark as failed (e.g., if transaction was reversed)
      store.updateStatus('stl_123', 'failed');

      const settlements = store.getDeveloperSettlements('dev_1');
      expect(settlements[0].status).toBe('failed');
      expect(settlements[0].tx_hash).toBe('0xtxhash123'); // tx_hash preserved
    });

    it('allows transition from failed to completed', () => {
      // First mark as failed
      store.updateStatus('stl_123', 'failed');
      
      // Then retry and mark as completed
      store.updateStatus('stl_123', 'completed', '0xretrytx');

      const settlements = store.getDeveloperSettlements('dev_1');
      expect(settlements[0].status).toBe('completed');
      expect(settlements[0].tx_hash).toBe('0xretrytx');
    });

    it('preserves transaction hash when not provided in update', () => {
      store.updateStatus('stl_123', 'completed', '0xoriginaltx');
      store.updateStatus('stl_123', 'failed'); // No tx_hash provided

      const settlements = store.getDeveloperSettlements('dev_1');
      expect(settlements[0].status).toBe('failed');
      expect(settlements[0].tx_hash).toBe('0xoriginaltx'); // Preserved
    });

    it('handles update for non-existent settlement gracefully', () => {
      // Should not throw error
      expect(() => {
        store.updateStatus('nonexistent', 'completed', '0xtxhash');
      }).not.toThrow();

      // Original settlement should be unchanged
      const settlements = store.getDeveloperSettlements('dev_1');
      expect(settlements[0].status).toBe('pending');
      expect(settlements[0].tx_hash).toBe(null);
    });

    it('allows setting transaction hash to null explicitly', () => {
      store.updateStatus('stl_123', 'completed', '0xtxhash');
      store.updateStatus('stl_123', 'failed', null);

      const settlements = store.getDeveloperSettlements('dev_1');
      expect(settlements[0].status).toBe('failed');
      expect(settlements[0].tx_hash).toBe(null);
    });
  });

  describe('Data Integrity and Corruption Resistance', () => {
    it('maintains data consistency after multiple operations', () => {
      const settlements: Settlement[] = [
        {
          id: 'stl_1',
          developerId: 'dev_1',
          amount: 100,
          status: 'pending',
          tx_hash: null,
          created_at: '2024-01-01T00:00:00.000Z',
        },
        {
          id: 'stl_2',
          developerId: 'dev_1',
          amount: 200,
          status: 'pending',
          tx_hash: null,
          created_at: '2024-01-02T00:00:00.000Z',
        },
        {
          id: 'stl_3',
          developerId: 'dev_2',
          amount: 300,
          status: 'pending',
          tx_hash: null,
          created_at: '2024-01-03T00:00:00.000Z',
        },
      ];

      // Create all settlements
      settlements.forEach(s => store.create(s));

      // Update some statuses
      store.updateStatus('stl_1', 'completed', '0xtx1');
      store.updateStatus('stl_2', 'failed');
      store.updateStatus('stl_3', 'completed', '0xtx3');

      // Verify all data is intact
      const dev1Settlements = store.getDeveloperSettlements('dev_1');
      const dev2Settlements = store.getDeveloperSettlements('dev_2');

      expect(dev1Settlements).toHaveLength(2);
      expect(dev2Settlements).toHaveLength(1);

      // Check specific settlement data
      const stl1 = dev1Settlements.find(s => s.id === 'stl_1');
      expect(stl1).toEqual({
        id: 'stl_1',
        developerId: 'dev_1',
        amount: 100,
        status: 'completed',
        tx_hash: '0xtx1',
        created_at: '2024-01-01T00:00:00.000Z',
      });

      const stl2 = dev1Settlements.find(s => s.id === 'stl_2');
      expect(stl2).toEqual({
        id: 'stl_2',
        developerId: 'dev_1',
        amount: 200,
        status: 'failed',
        tx_hash: null,
        created_at: '2024-01-02T00:00:00.000Z',
      });
    });

    it('handles edge case values correctly', () => {
      const edgeCaseSettlement: Settlement = {
        id: '',
        developerId: '',
        amount: 0,
        status: 'pending',
        tx_hash: null,
        created_at: '',
      };

      store.create(edgeCaseSettlement);
      const settlements = store.getDeveloperSettlements('');

      expect(settlements).toHaveLength(1);
      expect(settlements[0]).toEqual(edgeCaseSettlement);
    });

    it('handles very large amounts correctly', () => {
      const largeAmountSettlement: Settlement = {
        id: 'stl_large',
        developerId: 'dev_1',
        amount: Number.MAX_SAFE_INTEGER,
        status: 'pending',
        tx_hash: null,
        created_at: '2024-01-01T00:00:00.000Z',
      };

      store.create(largeAmountSettlement);
      const settlements = store.getDeveloperSettlements('dev_1');

      expect(settlements[0].amount).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('handles negative amounts (though business logic should prevent this)', () => {
      const negativeAmountSettlement: Settlement = {
        id: 'stl_negative',
        developerId: 'dev_1',
        amount: -100,
        status: 'pending',
        tx_hash: null,
        created_at: '2024-01-01T00:00:00.000Z',
      };

      store.create(negativeAmountSettlement);
      const settlements = store.getDeveloperSettlements('dev_1');

      expect(settlements[0].amount).toBe(-100);
    });
  });

  describe('Concurrency Expectations', () => {
    it('documents that InMemorySettlementStore is NOT thread-safe', () => {
      // This test documents the expected behavior under concurrent access
      // InMemorySettlementStore uses a simple array and has no locking mechanisms
      
      const settlement1: Settlement = {
        id: 'stl_1',
        developerId: 'dev_1',
        amount: 100,
        status: 'pending',
        tx_hash: null,
        created_at: '2024-01-01T00:00:00.000Z',
      };

      const settlement2: Settlement = {
        id: 'stl_2',
        developerId: 'dev_1',
        amount: 200,
        status: 'pending',
        tx_hash: null,
        created_at: '2024-01-01T01:00:00.000Z',
      };

      // Simulate concurrent operations
      store.create(settlement1);
      store.create(settlement2);

      // In a real concurrent scenario, race conditions could occur:
      // 1. Two threads creating settlements simultaneously
      // 2. One thread updating status while another reads
      // 3. Array modifications happening simultaneously
      
      // Current implementation provides no guarantees for such scenarios
      const settlements = store.getDeveloperSettlements('dev_1');
      expect(settlements).toHaveLength(2);
      
      // Note: For production use with concurrent access, a database-backed
      // implementation with proper transaction isolation would be required
    });

    it('handles rapid sequential operations correctly', () => {
      const operations = [];
      
      // Create many settlements rapidly
      for (let i = 0; i < 100; i++) {
        const settlement: Settlement = {
          id: `stl_${i}`,
          developerId: `dev_${i % 10}`, // 10 different developers
          amount: i * 10,
          status: 'pending',
          tx_hash: null,
          created_at: new Date(Date.now() + i).toISOString(), // Sequential timestamps
        };
        
        operations.push(() => store.create(settlement));
      }

      // Execute all operations
      operations.forEach(op => op());

      // Verify all settlements are stored correctly
      let totalSettlements = 0;
      for (let dev = 0; dev < 10; dev++) {
        const devSettlements = store.getDeveloperSettlements(`dev_${dev}`);
        totalSettlements += devSettlements.length;
      }

      expect(totalSettlements).toBe(100);
    });
  });

  describe('Integration with RevenueSettlementService', () => {
    it('maintains settlement IDs expected by RevenueSettlementService', () => {
      // RevenueSettlementService creates IDs with prefix 'stl_' + UUID
      const serviceStyleId = `stl_${crypto.randomUUID()}`;
      
      const settlement: Settlement = {
        id: serviceStyleId,
        developerId: 'dev_1',
        amount: 100.50,
        status: 'pending',
        tx_hash: null,
        created_at: new Date().toISOString(),
      };

      store.create(settlement);
      store.updateStatus(serviceStyleId, 'completed', '0xmocktx');

      const settlements = store.getDeveloperSettlements('dev_1');
      expect(settlements[0].id).toBe(serviceStyleId);
      expect(settlements[0].status).toBe('completed');
      expect(settlements[0].tx_hash).toBe('0xmocktx');
    });

    it('supports the settlement lifecycle used by RevenueSettlementService', () => {
      const settlementId = `stl_${crypto.randomUUID()}`;
      
      // Step 1: Create pending settlement (as done in RevenueSettlementService.runBatch)
      const settlement: Settlement = {
        id: settlementId,
        developerId: 'dev_1',
        amount: 150.75,
        status: 'pending',
        tx_hash: null,
        created_at: new Date().toISOString(),
      };
      store.create(settlement);

      // Step 2: Update to completed with transaction hash (successful settlement)
      store.updateStatus(settlementId, 'completed', '0xsuccessful_tx');

      // Verify the final state matches what RevenueSettlementService expects
      const settlements = store.getDeveloperSettlements('dev_1');
      expect(settlements).toHaveLength(1);
      expect(settlements[0]).toEqual({
        id: settlementId,
        developerId: 'dev_1',
        amount: 150.75,
        status: 'completed',
        tx_hash: '0xsuccessful_tx',
        created_at: settlement.created_at,
      });
    });
  });
});
