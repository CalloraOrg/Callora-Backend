import { describe, expect, it } from 'vitest'
import { BillingConflictError, InMemoryBillingAdmissionStore, admitBillingEvent, providerEventFingerprint } from './billingReconciliationAdmission.js'

const base = (overrides: Record<string, unknown> = {}) => ({
  tenantId: 'tenant-a', providerEventId: 'evt-001', invoiceId: 'invoice-1', developerId: 'dev-1', amountMinor: 1250,
  currency: 'usd', occurredAt: '2026-08-27T10:00:00.000Z', payload: { lineItems: [{ amount: 1250, sku: 'api' }], metadata: { region: 'us' } }, ...overrides,
})

describe('billing reconciliation admission', () => {
  it('applies a provider event and writes the ledger record', async () => {
    const store = new InMemoryBillingAdmissionStore()
    const result = await admitBillingEvent(store, base())
    expect(result.outcome).toBe('applied')
    expect(store.getBalance('dev-1')).toBe(1250)
    expect(store.getRecord('tenant-a', 'evt-001')?.fingerprint).toBe(providerEventFingerprint(base()))
  })

  it('returns the original result on an identical replay', async () => {
    const store = new InMemoryBillingAdmissionStore()
    const first = await admitBillingEvent(store, base())
    const replay = await admitBillingEvent(store, base())
    expect(replay.outcome).toBe('replay')
    expect(replay.record.ledgerEntryId).toBe(first.record.ledgerEntryId)
    expect(store.getBalance('dev-1')).toBe(1250)
  })

  it.each([
    ['amount', { amountMinor: 1251 }],
    ['invoice', { invoiceId: 'invoice-2' }],
    ['developer', { developerId: 'dev-2' }],
    ['payload', { payload: { lineItems: [{ amount: 999 }] } }],
    ['timestamp', { occurredAt: '2026-08-27T11:00:00.000Z' }],
  ])('audits and rejects a conflicting %s replay', async (_name, change) => {
    const store = new InMemoryBillingAdmissionStore()
    await admitBillingEvent(store, base())
    await expect(admitBillingEvent(store, base(change))).rejects.toBeInstanceOf(BillingConflictError)
    expect(store.getBalance('dev-1')).toBe(1250)
    expect(store.getConflicts()).toHaveLength(1)
    expect(store.getConflicts()[0].providerEventId).toBe('evt-001')
  })

  it('does not allow a cross-tenant event to replay', async () => {
    const store = new InMemoryBillingAdmissionStore()
    await admitBillingEvent(store, base())
    const result = await admitBillingEvent(store, base({ tenantId: 'tenant-b' }))
    expect(result.outcome).toBe('applied')
    expect(store.getBalance('dev-1')).toBe(2500)
  })

  it('keeps the same provider event isolated by tenant', async () => {
    const store = new InMemoryBillingAdmissionStore()
    await admitBillingEvent(store, base({ tenantId: 'tenant-a' }))
    await admitBillingEvent(store, base({ tenantId: 'tenant-b', developerId: 'dev-2' }))
    expect(store.getRecord('tenant-a', 'evt-001')).toBeDefined()
    expect(store.getRecord('tenant-b', 'evt-001')).toBeDefined()
  })

  it.each([
    ['empty tenant', { tenantId: '' }],
    ['empty event id', { providerEventId: '' }],
    ['empty invoice', { invoiceId: ' ' }],
    ['negative amount', { amountMinor: -1 }],
    ['fractional amount', { amountMinor: 1.5 }],
    ['invalid currency', { currency: 'dollars' }],
    ['invalid timestamp', { occurredAt: 'not-a-date' }],
    ['array payload', { payload: [] }],
  ])('rejects %s before opening a transaction', async (_name, invalid) => {
    const store = new InMemoryBillingAdmissionStore()
    await expect(admitBillingEvent(store, base(invalid))).rejects.toThrow()
    expect(store.getConflicts()).toHaveLength(0)
  })

  it('rolls back both ledger and reconciliation record when insert fails', async () => {
    const store = new InMemoryBillingAdmissionStore()
    const failing = { ...store, insertReconciliation: async () => { throw new Error('write failed') } } as any
    await expect(admitBillingEvent(failing, base())).rejects.toThrow('write failed')
    expect(store.getBalance('dev-1')).toBe(0)
    expect(store.getRecord('tenant-a', 'evt-001')).toBeUndefined()
  })

  it('uses canonical payload ordering for fingerprints', () => {
    expect(providerEventFingerprint(base({ payload: { b: 2, a: 1 } }))).toBe(providerEventFingerprint(base({ payload: { a: 1, b: 2 } })))
  })

  it('keeps amount representation stable across string and bigint inputs', () => {
    expect(providerEventFingerprint(base({ amountMinor: '1250' }))).toBe(providerEventFingerprint(base({ amountMinor: 1250n })))
  })

  it('records sanitized conflict metadata without the raw payload', async () => {
    const store = new InMemoryBillingAdmissionStore()
    await admitBillingEvent(store, base({ payload: { secret: 'do-not-store' } }))
    await expect(admitBillingEvent(store, base({ payload: { secret: 'changed' } }))).rejects.toThrow()
    expect(JSON.stringify(store.getConflicts())).not.toContain('do-not-store')
    expect(JSON.stringify(store.getConflicts())).not.toContain('changed')
  })

  it('does not mutate the event object while canonicalizing it', async () => {
    const store = new InMemoryBillingAdmissionStore()
    const input = base({ payload: { z: 1, a: 2 } })
    const snapshot = JSON.stringify(input)
    await admitBillingEvent(store, input)
    expect(JSON.stringify(input)).toBe(snapshot)
  })

  it('supports independent events for one invoice', async () => {
    const store = new InMemoryBillingAdmissionStore()
    await admitBillingEvent(store, base({ providerEventId: 'evt-1', amountMinor: 10 }))
    await admitBillingEvent(store, base({ providerEventId: 'evt-2', amountMinor: 20 }))
    expect(store.getBalance('dev-1')).toBe(30)
  })

  it('reports identity mismatch when a same fingerprint has changed identity', async () => {
    const store = new InMemoryBillingAdmissionStore()
    await admitBillingEvent(store, base())
    const altered = base({ invoiceId: 'invoice-2', payload: base().payload })
    await expect(admitBillingEvent(store, altered)).rejects.toMatchObject({ audit: { reason: 'payload_mismatch' } })
  })
})
