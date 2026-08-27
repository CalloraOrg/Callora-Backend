import { describe, expect, it } from 'vitest'
import { BillingConflictError, InMemoryBillingAdmissionStore, admitBillingEvent } from './billingReconciliationAdmission.js'

const event = (n: number, overrides: Record<string, unknown> = {}) => ({
  tenantId: 'tenant-matrix', providerEventId: `provider-${n}`, invoiceId: `invoice-${n}`,
  developerId: 'developer-matrix', amountMinor: n * 100, currency: 'USD',
  occurredAt: `2026-08-27T10:${String(n).padStart(2, '0')}:00.000Z`, payload: { n, tags: ['billing', 'provider'] }, ...overrides,
})

describe('billing admission mutation matrix', () => {
  it.each(Array.from({ length: 20 }, (_, index) => index + 1))('applies distinct provider event %i once', async n => {
    const store = new InMemoryBillingAdmissionStore()
    const first = await admitBillingEvent(store, event(n))
    const second = await admitBillingEvent(store, event(n))
    expect(first.outcome).toBe('applied')
    expect(second.outcome).toBe('replay')
    expect(store.getBalance('developer-matrix')).toBe(n * 100)
  })

  it('serializes concurrent identical submissions to one ledger mutation', async () => {
    const store = new InMemoryBillingAdmissionStore()
    const results = await Promise.all(Array.from({ length: 25 }, () => admitBillingEvent(store, event(21))))
    expect(results.filter(result => result.outcome === 'applied')).toHaveLength(1)
    expect(results.filter(result => result.outcome === 'replay')).toHaveLength(24)
    expect(store.getBalance('developer-matrix')).toBe(2100)
  })

  it('serializes concurrent conflicting submissions and audits each loser', async () => {
    const store = new InMemoryBillingAdmissionStore()
    await admitBillingEvent(store, event(22))
    const results = await Promise.allSettled(Array.from({ length: 5 }, (_, index) => admitBillingEvent(store, event(22, { amountMinor: 2201 + index }))))
    expect(results.every(result => result.status === 'rejected')).toBe(true)
    expect(results.every(result => result.status === 'rejected' && result.reason instanceof BillingConflictError)).toBe(true)
    expect(store.getConflicts()).toHaveLength(5)
    expect(store.getBalance('developer-matrix')).toBe(2200)
  })

  it.each([
    ['tenant', { tenantId: 'tenant-other' }],
    ['provider id', { providerEventId: 'provider-other' }],
    ['invoice', { invoiceId: 'invoice-other' }],
    ['developer', { developerId: 'developer-other' }],
  ])('keeps %s identity independent', async (_label, change) => {
    const store = new InMemoryBillingAdmissionStore()
    await admitBillingEvent(store, event(23))
    const result = await admitBillingEvent(store, event(23, change))
    expect(result.outcome).toBe('applied')
  })

  it.each([
    ['zero amount', { amountMinor: 0 }],
    ['largest safe amount', { amountMinor: Number.MAX_SAFE_INTEGER }],
    ['lowercase currency', { currency: 'eur' }],
    ['empty metadata', { payload: {} }],
    ['nested metadata', { payload: { nested: { z: 1, a: [true, null, 'x'] } } }],
  ])('accepts valid boundary %s', async (_label, change) => {
    const store = new InMemoryBillingAdmissionStore()
    await expect(admitBillingEvent(store, event(24, change))).resolves.toMatchObject({ outcome: 'applied' })
  })

  it.each([
    ['unsafe amount', { amountMinor: Number.MAX_SAFE_INTEGER + 1 }],
    ['negative string amount', { amountMinor: '-1' }],
    ['invalid currency length', { currency: 'US' }],
    ['numeric currency', { currency: 840 }],
    ['invalid time', { occurredAt: '2026-99-99' }],
    ['null payload', { payload: null }],
  ])('rejects invalid boundary %s', async (_label, change) => {
    const store = new InMemoryBillingAdmissionStore()
    await expect(admitBillingEvent(store, event(25, change))).rejects.toThrow()
    expect(store.getBalance('developer-matrix')).toBe(0)
  })

  it('rolls back a failed ledger mutation and permits a retry', async () => {
    const store = new InMemoryBillingAdmissionStore()
    const failingStore = {
      ...store,
      applyLedgerMutation: async () => { throw new Error('ledger unavailable') },
    } as any
    await expect(admitBillingEvent(failingStore, event(26))).rejects.toThrow('ledger unavailable')
    await expect(admitBillingEvent(store, event(26))).resolves.toMatchObject({ outcome: 'applied' })
    expect(store.getBalance('developer-matrix')).toBe(2600)
  })

  it('preserves the first ledger entry id on every replay', async () => {
    const store = new InMemoryBillingAdmissionStore()
    const first = await admitBillingEvent(store, event(27))
    for (let index = 0; index < 10; index++) {
      const replay = await admitBillingEvent(store, event(27))
      expect(replay.record.ledgerEntryId).toBe(first.record.ledgerEntryId)
    }
  })

  it('does not report a conflict as a replay when only payload changes', async () => {
    const store = new InMemoryBillingAdmissionStore()
    await admitBillingEvent(store, event(28))
    const result = await Promise.allSettled([admitBillingEvent(store, event(28, { payload: { n: 28, changed: true } }))])
    expect(result[0].status).toBe('rejected')
    expect((result[0] as PromiseRejectedResult).reason).toBeInstanceOf(BillingConflictError)
  })

  it('maintains balances independently for tenants and developers', async () => {
    const store = new InMemoryBillingAdmissionStore()
    await admitBillingEvent(store, event(29, { tenantId: 'a', developerId: 'dev-a', amountMinor: 10 }))
    await admitBillingEvent(store, event(29, { tenantId: 'b', developerId: 'dev-b', amountMinor: 20 }))
    expect(store.getBalance('dev-a')).toBe(10)
    expect(store.getBalance('dev-b')).toBe(20)
  })

  it('returns a copy of conflict audit records', async () => {
    const store = new InMemoryBillingAdmissionStore()
    await admitBillingEvent(store, event(30))
    await expect(admitBillingEvent(store, event(30, { amountMinor: 3001 }))).rejects.toThrow()
    const conflicts = store.getConflicts()
    conflicts[0].tenantId = 'mutated'
    expect(store.getConflicts()[0].tenantId).toBe('tenant-matrix')
  })

  it('can be cleared between isolated test lifecycles', async () => {
    const store = new InMemoryBillingAdmissionStore()
    await admitBillingEvent(store, event(31))
    store.clear()
    expect(store.getBalance('developer-matrix')).toBe(0)
    expect(store.getRecord('tenant-matrix', 'provider-31')).toBeUndefined()
    await expect(admitBillingEvent(store, event(31))).resolves.toMatchObject({ outcome: 'applied' })
  })
})
