import { KeySemaphore } from './keySemaphore.js';

describe('KeySemaphore', () => {
  describe('basic concurrency enforcement', () => {
    test('enforces max concurrency per key', async () => {
      const semaphore = new KeySemaphore(2, 1000);
      const activeAtPeak: number[] = [];

      // Fire 3 concurrent tasks for the same key — only 2 should run at once
      await Promise.all([
        semaphore.withSlot('key-a', async () => {
          activeAtPeak.push(semaphore.getCurrentActiveSlotCounts()['key-a'] ?? 0);
          await new Promise((r) => setTimeout(r, 30));
        }),
        semaphore.withSlot('key-a', async () => {
          activeAtPeak.push(semaphore.getCurrentActiveSlotCounts()['key-a'] ?? 0);
          await new Promise((r) => setTimeout(r, 30));
        }),
        semaphore.withSlot('key-a', async () => {
          activeAtPeak.push(semaphore.getCurrentActiveSlotCounts()['key-a'] ?? 0);
          await new Promise((r) => setTimeout(r, 30));
        }),
      ]);

      // The semaphore should never exceed maxConcurrency per key
      expect(activeAtPeak.every((c) => c <= 2)).toBe(true);
      expect(semaphore.getTotalActiveSlotCount()).toBe(0);
    });

    test('isolates concurrency limits between keys', async () => {
      const semaphore = new KeySemaphore(1, 1000);
      let peakTotal = 0;

      await Promise.all([
        semaphore.withSlot('key-a', async () => {
          peakTotal = Math.max(peakTotal, semaphore.getTotalActiveSlotCount());
          await new Promise((r) => setTimeout(r, 30));
        }),
        semaphore.withSlot('key-b', async () => {
          peakTotal = Math.max(peakTotal, semaphore.getTotalActiveSlotCount());
          await new Promise((r) => setTimeout(r, 30));
        }),
      ]);

      // Two different keys should both be active concurrently
      expect(peakTotal).toBe(2);
    });

    test('queues work beyond the limit rather than dropping it', async () => {
      const semaphore = new KeySemaphore(1, 1000);
      const order: number[] = [];

      await Promise.all([
        semaphore.withSlot('key-fifo', async () => {
          order.push(1);
          await new Promise((r) => setTimeout(r, 20));
        }),
        semaphore.withSlot('key-fifo', async () => {
          order.push(2);
        }),
        semaphore.withSlot('key-fifo', async () => {
          order.push(3);
        }),
      ]);

      // All three tasks ran, in FIFO order, despite a limit of one slot
      expect(order).toEqual([1, 2, 3]);
      expect(semaphore.getActiveSlotCount('key-fifo')).toBe(0);
    });
  });

  describe('slot counting', () => {
    test('getCurrentActiveSlotCounts returns only active keys', async () => {
      const semaphore = new KeySemaphore(5, 1000);

      expect(semaphore.getCurrentActiveSlotCounts()).toEqual({});

      await semaphore.withSlot('key-x', async () => {
        const counts = semaphore.getCurrentActiveSlotCounts();
        expect(counts['key-x']).toBe(1);
        expect(Object.keys(counts)).toHaveLength(1);
      });

      expect(semaphore.getCurrentActiveSlotCounts()).toEqual({});
    });

    test('getActiveSlotCount returns count for specific key', async () => {
      const semaphore = new KeySemaphore(5, 1000);

      expect(semaphore.getActiveSlotCount('key-y')).toBe(0);

      await semaphore.withSlot('key-y', async () => {
        expect(semaphore.getActiveSlotCount('key-y')).toBe(1);
      });

      expect(semaphore.getActiveSlotCount('key-y')).toBe(0);
    });

    test('getTotalActiveSlotCount sums all active slots', async () => {
      const semaphore = new KeySemaphore(3, 1000);

      let total = 0;
      await Promise.all([
        semaphore.withSlot('key-1', async () => {
          total = semaphore.getTotalActiveSlotCount();
          await new Promise((r) => setTimeout(r, 30));
        }),
        semaphore.withSlot('key-2', async () => {
          total = semaphore.getTotalActiveSlotCount();
          await new Promise((r) => setTimeout(r, 30));
        }),
        semaphore.withSlot('key-3', async () => {
          total = semaphore.getTotalActiveSlotCount();
          await new Promise((r) => setTimeout(r, 30));
        }),
      ]);

      expect(total).toBe(3);
      expect(semaphore.getTotalActiveSlotCount()).toBe(0);
    });
  });

  describe('isAtLimit', () => {
    test('returns true when key is at its concurrency limit', async () => {
      const semaphore = new KeySemaphore(1, 1000);

      await semaphore.withSlot('key-limit', async () => {
        expect(semaphore.isAtLimit('key-limit')).toBe(true);
      });

      expect(semaphore.isAtLimit('key-limit')).toBe(false);
    });

    test('returns false when key is under its concurrency limit', async () => {
      const semaphore = new KeySemaphore(2, 1000);

      await semaphore.withSlot('key-under', async () => {
        expect(semaphore.isAtLimit('key-under')).toBe(false);
      });
    });
  });

  describe('maxConcurrency', () => {
    test('exposes the configured per-key ceiling', () => {
      expect(new KeySemaphore(7, 1000).maxConcurrency).toBe(7);
    });
  });

  describe('slot release', () => {
    test('releases slot after successful task completion', async () => {
      const semaphore = new KeySemaphore(1, 1000);

      await semaphore.withSlot('key-release', async () => {
        // slot held here
      });

      // Should be able to acquire the slot again
      await semaphore.withSlot('key-release', async () => {
        expect(semaphore.getActiveSlotCount('key-release')).toBe(1);
      });

      expect(semaphore.getActiveSlotCount('key-release')).toBe(0);
    });

    test('releases slot on error', async () => {
      const semaphore = new KeySemaphore(1, 1000);

      await expect(
        semaphore.withSlot('key-err', async () => {
          throw new Error('test error');
        }),
      ).rejects.toThrow('test error');

      expect(semaphore.getActiveSlotCount('key-err')).toBe(0);

      // Should be able to acquire the slot again
      await semaphore.withSlot('key-err', async () => {
        expect(semaphore.getActiveSlotCount('key-err')).toBe(1);
      });
    });
  });

  describe('clear', () => {
    test('resets all state', async () => {
      const semaphore = new KeySemaphore(2, 1000);

      // Acquire a slot so we have state
      await semaphore.withSlot('key-clr', async () => {
        expect(semaphore.getActiveSlotCount('key-clr')).toBe(1);
      });

      semaphore.clear();
      expect(semaphore.getTotalActiveSlotCount()).toBe(0);
      expect(semaphore.getActiveSlotCount('key-clr')).toBe(0);
      expect(semaphore.getCurrentActiveSlotCounts()).toEqual({});
    });
  });
});
