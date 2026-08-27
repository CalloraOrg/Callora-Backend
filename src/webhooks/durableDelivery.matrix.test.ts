import { describe, expect, it } from 'vitest'
import { DeliveryConflictError, InMemoryDurableDeliveryStore, enqueueDurableDelivery } from './durableDelivery.js'

const makeInput = (n: number, overrides: Record<string, unknown> = {}) => ({
  tenantId: `tenant-${n % 3}`, eventKey: `event-${n}`, destination: `https://hooks.example.test/${n}`,
  body: JSON.stringify({ event: 'invoice.paid', id: n, amount: n * 10 }), maxAttempts: 3, baseDelayMs: 10, ...overrides,
})

describe('durable delivery state transition matrix', () => {
  it.each(Array.from({ length: 15 }, (_, index) => index + 1))('keeps event %i pending until claimed', async n => {
    const store = new InMemoryDurableDeliveryStore()
    const record = await enqueueDurableDelivery(store, makeInput(n), 100)
    expect(record.status).toBe('pending')
    expect((await store.stats()).pending).toBe(1)
  })

  it('prevents two workers from claiming a pending row concurrently', async () => {
    const store = new InMemoryDurableDeliveryStore()
    await enqueueDurableDelivery(store, makeInput(20), 0)
    const claims = await Promise.all([
      store.claim('tenant-2', 'event-20', 'worker-a', 0),
      store.claim('tenant-2', 'event-20', 'worker-b', 0),
    ])
    expect(claims.filter(Boolean)).toHaveLength(1)
  })

  it('does not let a stale worker acknowledge a recovered lease', async () => {
    const store = new InMemoryDurableDeliveryStore()
    await enqueueDurableDelivery(store, makeInput(21), 0)
    const first = await store.claim('tenant-0', 'event-21', 'worker-a', 0, 5)
    const second = await store.claim('tenant-0', 'event-21', 'worker-b', 5, 5)
    expect(await store.complete(first!, 'worker-a', 6)).toBe(false)
    expect(await store.complete(second!, 'worker-b', 6)).toBe(true)
  })

  it.each([
    [1, 10], [2, 20], [3, 40], [4, 80], [5, 160],
  ])('uses bounded exponential delay after attempt %i', async (attempt, delay) => {
    const store = new InMemoryDurableDeliveryStore()
    await enqueueDurableDelivery(store, makeInput(22, { maxAttempts: 10, baseDelayMs: 10 }), 0)
    let claim = await store.claim('tenant-1', 'event-22', 'worker-0', 0)
    for (let index = 1; index < attempt; index++) {
      await store.fail(claim!, `failure-${index}`, 'x', claim!.nextAttemptAt)
      claim = await store.claim('tenant-1', 'event-22', `worker-${index}`, claim!.nextAttemptAt)
    }
    const failed = await store.fail(claim!, 'x', 1000)
    expect(failed?.nextAttemptAt).toBe(1000 + delay)
  })

  it('does not claim retryable work before nextAttemptAt', async () => {
    const store = new InMemoryDurableDeliveryStore()
    await enqueueDurableDelivery(store, makeInput(23), 0)
    const claim = await store.claim('tenant-2', 'event-23', 'worker-a', 0)
    const failed = await store.fail(claim!, 'worker-a', 'timeout', 1)
    expect(await store.claim('tenant-2', 'event-23', 'worker-b', failed!.nextAttemptAt - 1)).toBeUndefined()
  })

  it('does not permit completion after the lease expires', async () => {
    const store = new InMemoryDurableDeliveryStore()
    await enqueueDurableDelivery(store, makeInput(24), 0)
    const claim = await store.claim('tenant-0', 'event-24', 'worker-a', 0, 10)
    expect(await store.complete(claim!, 'worker-a', 11)).toBe(false)
  })

  it('keeps delivered rows out of all future states', async () => {
    const store = new InMemoryDurableDeliveryStore()
    await enqueueDurableDelivery(store, makeInput(25), 0)
    const claim = await store.claim('tenant-1', 'event-25', 'worker-a', 0)
    await store.complete(claim!, 'worker-a', 1)
    expect(await store.claim('tenant-1', 'event-25', 'worker-b', 2)).toBeUndefined()
    expect(await store.fail(claim!, 'worker-a', 'late', 3)).toBeUndefined()
  })

  it('makes only one successful record for duplicate enqueue races', async () => {
    const store = new InMemoryDurableDeliveryStore()
    const records = await Promise.all(Array.from({ length: 30 }, () => enqueueDurableDelivery(store, makeInput(26), 0)))
    expect(records).toHaveLength(30)
    expect((await store.stats()).pending).toBe(1)
  })

  it('rejects changed payload in duplicate enqueue races', async () => {
    const store = new InMemoryDurableDeliveryStore()
    await enqueueDurableDelivery(store, makeInput(27), 0)
    await expect(enqueueDurableDelivery(store, makeInput(27, { body: '{"amount":999}' }), 0)).rejects.toBeInstanceOf(DeliveryConflictError)
  })

  it('reports each lifecycle state in stats', async () => {
    const store = new InMemoryDurableDeliveryStore()
    await enqueueDurableDelivery(store, makeInput(28), 0)
    await enqueueDurableDelivery(store, makeInput(29), 0)
    const processing = await store.claim('tenant-1', 'event-28', 'worker-a', 0)
    const dead = await store.claim('tenant-2', 'event-29', 'worker-b', 0)
    await store.fail(dead!, 'worker-b', 'fatal', 0)
    await store.complete(processing!, 'worker-a', 1)
    expect(await store.stats()).toEqual({ pending: 0, processing: 0, retrying: 1, delivered: 1, dead: 0 })
  })

  it('requires a claimant for state transitions', async () => {
    const store = new InMemoryDurableDeliveryStore()
    await enqueueDurableDelivery(store, makeInput(30), 0)
    const claim = await store.claim('tenant-0', 'event-30', 'worker-a', 0)
    expect(await store.renew(claim!, 'other', 1)).toBe(false)
    expect(await store.fail(claim!, 'other', 'timeout', 1)).toBeUndefined()
    expect((await store.get('tenant-0', 'event-30'))?.status).toBe('processing')
  })

  it('retains retry error context without retaining network URLs', async () => {
    const store = new InMemoryDurableDeliveryStore()
    await enqueueDurableDelivery(store, makeInput(31), 0)
    const claim = await store.claim('tenant-1', 'event-31', 'worker-a', 0)
    const failed = await store.fail(claim!, 'worker-a', 'POST https://internal/token timed out', 1)
    expect(failed?.lastError).toBe('POST [url] timed out')
  })

  it('supports a fresh event after a previous event reaches dead state', async () => {
    const store = new InMemoryDurableDeliveryStore()
    await enqueueDurableDelivery(store, makeInput(32, { maxAttempts: 1 }), 0)
    const claim = await store.claim('tenant-2', 'event-32', 'worker-a', 0)
    await store.fail(claim!, 'worker-a', 'fatal', 1)
    const fresh = await enqueueDurableDelivery(store, makeInput(33), 1)
    expect(fresh.status).toBe('pending')
    expect((await store.stats()).dead).toBe(1)
  })
})
