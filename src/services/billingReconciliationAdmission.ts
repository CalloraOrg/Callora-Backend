import { createHash } from 'node:crypto'

export interface ProviderBillingEvent {
  tenantId: string
  providerEventId: string
  invoiceId: string
  developerId: string
  amountMinor: bigint | number | string
  currency: string
  occurredAt: string
  payload: Record<string, unknown>
}

export interface BillingReconciliationRecord {
  tenantId: string
  providerEventId: string
  invoiceId: string
  developerId: string
  fingerprint: string
  status: 'applied' | 'replay'
  appliedAt: string
  ledgerEntryId: string
}

export interface BillingConflictAudit {
  tenantId: string
  providerEventId: string
  existingFingerprint: string
  receivedFingerprint: string
  reason: 'payload_mismatch' | 'identity_mismatch'
  observedAt: string
}

export interface BillingAdmissionResult {
  outcome: 'applied' | 'replay'
  record: BillingReconciliationRecord
}

export class BillingConflictError extends Error {
  readonly code = 'BILLING_RECONCILIATION_CONFLICT'
  readonly statusCode = 409

  constructor(public readonly audit: BillingConflictAudit) {
    super('Provider billing event conflicts with an existing reconciliation record')
    this.name = 'BillingConflictError'
  }
}

export interface BillingAdmissionTransaction {
  findReconciliation(tenantId: string, providerEventId: string): Promise<BillingReconciliationRecord | undefined>
  applyLedgerMutation(event: ProviderBillingEvent): Promise<{ ledgerEntryId: string }>
  insertReconciliation(record: BillingReconciliationRecord): Promise<void>
  insertConflictAudit(audit: BillingConflictAudit): Promise<void>
}

export interface BillingAdmissionStore {
  withTransaction<T>(callback: (transaction: BillingAdmissionTransaction) => Promise<T>): Promise<T>
}

export function providerEventFingerprint(event: ProviderBillingEvent): string {
  const canonical = JSON.stringify({
    tenantId: event.tenantId,
    providerEventId: event.providerEventId,
    invoiceId: event.invoiceId,
    developerId: event.developerId,
    amountMinor: String(event.amountMinor),
    currency: event.currency.toUpperCase(),
    occurredAt: event.occurredAt,
    payload: canonicalize(event.payload),
  })
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

export async function admitBillingEvent(
  store: BillingAdmissionStore,
  event: ProviderBillingEvent,
  now: () => Date = () => new Date()
): Promise<BillingAdmissionResult> {
  validateProviderEvent(event)
  const fingerprint = providerEventFingerprint(event)

  return store.withTransaction(async transaction => {
    const existing = await transaction.findReconciliation(event.tenantId, event.providerEventId)
    if (existing) {
      if (existing.fingerprint !== fingerprint || existing.invoiceId !== event.invoiceId || existing.developerId !== event.developerId) {
        const audit: BillingConflictAudit = {
          tenantId: event.tenantId,
          providerEventId: event.providerEventId,
          existingFingerprint: existing.fingerprint,
          receivedFingerprint: fingerprint,
          reason: existing.fingerprint === fingerprint ? 'identity_mismatch' : 'payload_mismatch',
          observedAt: now().toISOString(),
        }
        await transaction.insertConflictAudit(audit)
        throw new BillingConflictError(audit)
      }
      return { outcome: 'replay', record: { ...existing, status: 'replay' } }
    }

    const ledger = await transaction.applyLedgerMutation(event)
    const record: BillingReconciliationRecord = {
      tenantId: event.tenantId,
      providerEventId: event.providerEventId,
      invoiceId: event.invoiceId,
      developerId: event.developerId,
      fingerprint,
      status: 'applied',
      appliedAt: now().toISOString(),
      ledgerEntryId: ledger.ledgerEntryId,
    }
    await transaction.insertReconciliation(record)
    return { outcome: 'applied', record }
  })
}

export class InMemoryBillingAdmissionStore implements BillingAdmissionStore, BillingAdmissionTransaction {
  private readonly records = new Map<string, BillingReconciliationRecord>()
  private readonly conflicts: BillingConflictAudit[] = []
  private readonly ledger = new Map<string, number>()
  private nextLedgerEntry = 1
  private transactionTail: Promise<void> = Promise.resolve()

  withTransaction<T>(callback: (transaction: BillingAdmissionTransaction) => Promise<T>): Promise<T> {
    const run = this.transactionTail.then(() => this.executeTransaction(callback))
    this.transactionTail = run.then(() => undefined, () => undefined)
    return run
  }

  private async executeTransaction<T>(callback: (transaction: BillingAdmissionTransaction) => Promise<T>): Promise<T> {
    const records = new Map(this.records)
    const ledger = new Map(this.ledger)
    const conflicts = this.conflicts.length
    try {
      return await callback(this)
    } catch (error) {
      this.records.clear(); for (const [key, value] of records) this.records.set(key, value)
      this.ledger.clear(); for (const [key, value] of ledger) this.ledger.set(key, value)
      this.conflicts.splice(conflicts)
      throw error
    }
  }

  async findReconciliation(tenantId: string, providerEventId: string) { return this.records.get(key(tenantId, providerEventId)) }
  async applyLedgerMutation(event: ProviderBillingEvent) {
    const current = this.ledger.get(event.developerId) ?? 0
    this.ledger.set(event.developerId, current + Number(event.amountMinor))
    return { ledgerEntryId: `ledger-${this.nextLedgerEntry++}` }
  }
  async insertReconciliation(record: BillingReconciliationRecord) { this.records.set(key(record.tenantId, record.providerEventId), { ...record }) }
  async insertConflictAudit(audit: BillingConflictAudit) { this.conflicts.push({ ...audit }) }
  getBalance(developerId: string) { return this.ledger.get(developerId) ?? 0 }
  getConflicts() { return this.conflicts.map(conflict => ({ ...conflict })) }
  getRecord(tenantId: string, providerEventId: string) { return this.records.get(key(tenantId, providerEventId)) }
  clear() { this.records.clear(); this.conflicts.length = 0; this.ledger.clear(); this.nextLedgerEntry = 1 }
}

function key(tenantId: string, providerEventId: string) { return `${tenantId}:${providerEventId}` }

function validateProviderEvent(event: ProviderBillingEvent): void {
  if (!event.tenantId.trim() || !event.providerEventId.trim() || !event.invoiceId.trim() || !event.developerId.trim()) throw new Error('Billing event identity is required')
  if (!Number.isSafeInteger(Number(event.amountMinor)) || Number(event.amountMinor) < 0) throw new Error('Billing amount must be a non-negative safe integer')
  if (!/^[A-Z]{3}$/.test(event.currency.toUpperCase())) throw new Error('Billing currency must be an ISO-4217 code')
  if (Number.isNaN(Date.parse(event.occurredAt))) throw new Error('Billing event occurredAt must be an ISO timestamp')
  if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) throw new Error('Billing event payload must be an object')
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalize(item)]))
  return value
}
