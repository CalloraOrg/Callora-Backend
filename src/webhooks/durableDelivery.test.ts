import { describe, expect, it } from 'vitest'
import { DeliveryConflictError, InMemoryDurableDeliveryStore, enqueueDurableDelivery } from './durableDelivery.js'

const input = (overrides: Record<string, unknown> = {}) => ({ tenantId: 'tenant-a', eventKey: 'event-1', destination: 'https://example.test/hook', body: JSON.stringify({ event: 'invoice.paid', amount: 100 }), ...overrides })

describe('durable webhook delivery', () => {
  it('creates a pending delivery', async () => {
    const store = new InMemoryDurableDeliveryStore()
    const record = await enqueueDurableDelivery(store, input(), 1_000)
    expect(record.status).toBe('pending')
    expect(record.attemptCount).toBe(0)
    expect(record.nextAttemptAt).toBe(1_000)
  })

  it('deduplicates an identical event key', async () => {
    const store = new InMemoryDurableDeliveryStore()
    const first = await enqueueDurableDelivery(store, input(), 1_000)
    const second = await enqueueDurableDelivery(store, input(), 2_000)
    expect(second.payloadHash).toBe(first.payloadHash)
    expect((await store.stats()).pending).toBe(1)
  })

  it('rejects a reused key with a changed payload', async () => {
    const store = new InMemoryDurableDeliveryStore()
    await enqueueDurableDelivery(store, input(), 1_000)
    await expect(enqueueDurableDelivery(store, input({ body: JSON.stringify({ changed: true }) }), 2_000)).rejects.toBeInstanceOf(DeliveryConflictError)
  })

  it('claims a pending event once for one worker', async () => {
    const store = new InMemoryDurableDeliveryStore()
    await enqueueDurableDelivery(store, input(), 1_000)
    const a = await store.claim('tenant-a', 'event-1', 'worker-a', 1_000, 100)
    const b = await store.claim('tenant-a', 'event-1', 'worker-b', 1_001, 100)
    expect(a?.workerId).toBe('worker-a')
    expect(b).toBeUndefined()
  })

  it('allows another worker after lease expiry', async () => {
    const store = new InMemoryDurableDeliveryStore()
    await enqueueDurableDelivery(store, input(), 1_000)
    await store.claim('tenant-a', 'event-1', 'worker-a', 1_000, 100)
    const recovered = await store.claim('tenant-a', 'event-1', 'worker-b', 1_100, 100)
    expect(recovered?.workerId).toBe('worker-b')
    expect(recovered?.attemptCount).toBe(2)
  })

  it('renews only the current worker lease', async () => {
    const store = new InMemoryDurableDeliveryStore()
    await enqueueDurableDelivery(store, input(), 1_000)
    const claim = await store.claim('tenant-a', 'event-1', 'worker-a', 1_000, 100)
    expect(await store.renew(claim!, 'worker-b', 1_050, 100)).toBe(false)
    expect(await store.renew(claim!, 'worker-a', 1_050, 100)).toBe(true)
  })

  it('marks a delivery delivered only for its claimant', async () => {
    const store = new InMemoryDurableDeliveryStore()
    await enqueueDurableDelivery(store, input(), 1_000)
    const claim = await store.claim('tenant-a', 'event-1', 'worker-a', 1_000, 100)
    expect(await store.complete(claim!, 'worker-b', 1_050)).toBe(false)
    expect(await store.complete(claim!, 'worker-a', 1_050)).toBe(true)
    expect((await store.stats()).delivered).toBe(1)
    expect(await store.claim('tenant-a', 'event-1', 'worker-c', 2_000)).toBeUndefined()
  })

  it('moves failures to retrying with exponential delay', async () => {
    const store = new InMemoryDurableDeliveryStore()
    await enqueueDurableDelivery(store, input({ baseDelayMs: 100 }), 1_000)
    const claim = await store.claim('tenant-a', 'event-1', 'worker-a', 1_000)
    const failed = await store.fail(claim!, 'worker-a', 'timeout', 1_010)
    expect(failed?.status).toBe('retrying')
    expect(failed?.nextAttemptAt).toBe(1_110)
    expect(await store.claim('tenant-a', 'event-1', 'worker-b', 1_109)).toBeUndefined()
    expect(await store.claim('tenant-a', 'event-1', 'worker-b', 1_110)).toBeDefined()
  })

  it('moves a delivery to dead after the configured attempt budget', async () => {
    const store = new InMemoryDurableDeliveryStore()
    await enqueueDurableDelivery(store, input({ maxAttempts: 2, baseDelayMs: 1 }), 1_000)
    const first = await store.claim('tenant-a', 'event-1', 'worker-a', 1_000)
    await store.fail(first!, 'worker-a', 'bad gateway', 1_001)
    const second = await store.claim('tenant-a', 'event-1', 'worker-b', 1_003)
    const dead = await store.fail(second!, 'worker-b', 'bad gateway again', 1_004)
    expect(dead?.status).toBe('dead')
    expect((await store.stats()).dead).toBe(1)
  })

  it('keeps tenant namespaces independent', async () => {
    const store = new InMemoryDurableDeliveryStore()
    await enqueueDurableDelivery(store, input(), 1_000)
    await enqueueDurableDelivery(store, input({ tenantId: 'tenant-b' }), 1_000)
    expect((await store.stats()).pending).toBe(2)
  })

  it('rejects malformed payloads and invalid retry settings', async () => {
    const store = new InMemoryDurableDeliveryStore()
    await expect(enqueueDurableDelivery(store, input({ body: '{' }))).rejects.toThrow('valid JSON')
    await expect(enqueueDurableDelivery(store, input({ maxAttempts: 0 }))).rejects.toThrow('maxAttempts')
    await expect(enqueueDurableDelivery(store, input({ baseDelayMs: 0 }))).rejects.toThrow('baseDelayMs')
  })

  it('sanitizes URLs in terminal error metadata', async () => {
    const store = new InMemoryDurableDeliveryStore()
    await enqueueDurableDelivery(store, input({ maxAttempts: 1 }), 1_000)
    const claim = await store.claim('tenant-a', 'event-1', 'worker-a', 1_000)
    const dead = await store.fail(claim!, 'worker-a', 'failed https://secret.example/token', 1_001)
    expect(dead?.lastError).toBe('failed [url]')
  })

  it('does not expose mutable internal records', async () => {
    const store = new InMemoryDurableDeliveryStore()
    const created = await enqueueDurableDelivery(store, input(), 1_000)
    created.status = 'delivered'
    expect((await store.get('tenant-a', 'event-1'))?.status).toBe('pending')
  })
})
