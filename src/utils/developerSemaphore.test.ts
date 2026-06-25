import assert from 'node:assert/strict';
import { DeveloperSemaphore } from './developerSemaphore.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('DeveloperSemaphore', () => {
  test('enforces max concurrency per developer', async () => {
    const semaphore = new DeveloperSemaphore(2, 1000);
    const activeAtPeak: number[] = [];

    const worker = async () => {
      await semaphore.withSlot('dev-a', async () => {
        activeAtPeak.push(semaphore.getCurrentActiveSlotCounts()['dev-a'] ?? 0);
        await delay(10);
      });
    };

    await Promise.all([worker(), worker(), worker()]);

    // Because two slots are available, the first two tasks may overlap
    // before any of them records the count. The semaphore should never exceed
    // the configured max concurrency.
    assert.deepEqual(activeAtPeak.sort(), [2, 2, 2]);
    assert.equal(semaphore.getTotalActiveSlotCount(), 0);
  });

  test('preserves FIFO order without starvation', async () => {
    const semaphore = new DeveloperSemaphore(1, 1000);
    const sequence: string[] = [];

    const makeTask = (label: string) => async () => {
      await semaphore.withSlot('dev-b', async () => {
        sequence.push(`start:${label}`);
        await delay(5);
        sequence.push(`end:${label}`);
      });
    };

    await Promise.all([makeTask('first')(), makeTask('second')(), makeTask('third')()]);

    assert.deepEqual(sequence, [
      'start:first',
      'end:first',
      'start:second',
      'end:second',
      'start:third',
      'end:third',
    ]);
  });

  test('isolates concurrency limits between developers', async () => {
    const semaphore = new DeveloperSemaphore(1, 1000);
    let peakTotal = 0;

    const work = async (developerId: string) => {
      await semaphore.withSlot(developerId, async () => {
        peakTotal = Math.max(peakTotal, semaphore.getTotalActiveSlotCount());
        await delay(10);
      });
    };

    await Promise.all([work('dev-x'), work('dev-y')]);

    assert.equal(peakTotal, 2);
  });
});
