import { createHash } from 'node:crypto'

export type DurableDeliveryStatus = 'pending' | 'processing' | 'retrying' | 'delivered' | 'dead'

export interface DurableDeliveryInput {
  tenantId: string
  eventKey: string
  destination: string
  body: string
  maxAttempts?: number
  baseDelayMs?: number
}

export interface DurableDeliveryRecord extends DurableDeliveryInput {
  payloadHash: string
  status: DurableDeliveryStatus
  attemptCount: number
  workerId: string | null
  leaseExpiresAt: number | null
  nextAttemptAt: number
  lastError: string | null
  deliveredAt: number | null
  createdAt: number
  updatedAt: number
}

export type DeliveryCreateResult = { outcome: 'created'; record: DurableDeliveryRecord } | { outcome: 'duplicate'; record: DurableDeliveryRecord } | { outcome: 'conflict'; record: DurableDeliveryRecord }

export interface DurableDeliveryStats { pending: number; processing: number; retrying: number; delivered: number; dead: number }

export class DeliveryConflictError extends Error {
  readonly statusCode = 409
  constructor() { super('A delivery event key already contains a different payload'); this.name = 'DeliveryConflictError' }
}

export interface DurableDeliveryStore {
  create(input: DurableDeliveryInput, now?: number): Promise<DeliveryCreateResult>
  claim(tenantId: string, eventKey: string, workerId: string, now?: number, leaseMs?: number): Promise<DurableDeliveryRecord | undefined>
  renew(record: DurableDeliveryRecord, workerId: string, now?: number, leaseMs?: number): Promise<boolean>
  complete(record: DurableDeliveryRecord, workerId: string, now?: number): Promise<boolean>
  fail(record: DurableDeliveryRecord, workerId: string, error: string, now?: number): Promise<DurableDeliveryRecord | undefined>
  get(tenantId: string, eventKey: string): Promise<DurableDeliveryRecord | undefined>
  stats(): Promise<DurableDeliveryStats>
}

export class InMemoryDurableDeliveryStore implements DurableDeliveryStore {
  private readonly records = new Map<string, DurableDeliveryRecord>()

  async create(input: DurableDeliveryInput, now = Date.now()): Promise<DeliveryCreateResult> {
    validateInput(input)
    const identity = key(input.tenantId, input.eventKey)
    const payloadHash = hash(input.body)
    const existing = this.records.get(identity)
    if (existing) {
      return { outcome: existing.payloadHash === payloadHash ? 'duplicate' : 'conflict', record: clone(existing) }
    }
    const record: DurableDeliveryRecord = {
      ...input,
      maxAttempts: normalizeAttempts(input.maxAttempts),
      baseDelayMs: normalizeDelay(input.baseDelayMs),
      payloadHash,
      status: 'pending',
      attemptCount: 0,
      workerId: null,
      leaseExpiresAt: null,
      nextAttemptAt: now,
      lastError: null,
      deliveredAt: null,
      createdAt: now,
      updatedAt: now,
    }
    this.records.set(identity, record)
    return { outcome: 'created', record: clone(record) }
  }

  async claim(tenantId: string, eventKey: string, workerId: string, now = Date.now(), leaseMs = 30_000): Promise<DurableDeliveryRecord | undefined> {
    if (!workerId.trim() || leaseMs <= 0) throw new Error('workerId and leaseMs are required')
    const record = this.records.get(key(tenantId, eventKey))
    if (!record || record.status === 'delivered' || record.status === 'dead') return undefined
    const leaseExpired = record.status === 'processing' && (record.leaseExpiresAt ?? 0) <= now
    if (record.status === 'processing' && !leaseExpired) return undefined
    if ((record.status === 'pending' || record.status === 'retrying' || leaseExpired) && record.nextAttemptAt > now) return undefined
    record.status = 'processing'
    record.workerId = workerId
    record.leaseExpiresAt = now + leaseMs
    record.attemptCount += 1
    record.updatedAt = now
    return clone(record)
  }

  async renew(record: DurableDeliveryRecord, workerId: string, now = Date.now(), leaseMs = 30_000): Promise<boolean> {
    const current = this.records.get(key(record.tenantId, record.eventKey))
    if (!current || current.status !== 'processing' || current.workerId !== workerId || current.leaseExpiresAt! < now) return false
    current.leaseExpiresAt = now + leaseMs
    current.updatedAt = now
    return true
  }

  async complete(record: DurableDeliveryRecord, workerId: string, now = Date.now()): Promise<boolean> {
    const current = this.records.get(key(record.tenantId, record.eventKey))
    if (!current || current.status !== 'processing' || current.workerId !== workerId || current.payloadHash !== record.payloadHash) return false
    current.status = 'delivered'
    current.workerId = null
    current.leaseExpiresAt = null
    current.deliveredAt = now
    current.updatedAt = now
    return true
  }

  async fail(record: DurableDeliveryRecord, workerId: string, error: string, now = Date.now()): Promise<DurableDeliveryRecord | undefined> {
    const current = this.records.get(key(record.tenantId, record.eventKey))
    if (!current || current.status !== 'processing' || current.workerId !== workerId) return undefined
    current.lastError = sanitizeError(error)
    current.workerId = null
    current.leaseExpiresAt = null
    current.status = current.attemptCount >= current.maxAttempts ? 'dead' : 'retrying'
    current.nextAttemptAt = current.status === 'dead' ? now : now + current.baseDelayMs * 2 ** Math.max(0, current.attemptCount - 1)
    current.updatedAt = now
    return clone(current)
  }

  async get(tenantId: string, eventKey: string) { const record = this.records.get(key(tenantId, eventKey)); return record ? clone(record) : undefined }
  async stats(): Promise<DurableDeliveryStats> {
    const stats: DurableDeliveryStats = { pending: 0, processing: 0, retrying: 0, delivered: 0, dead: 0 }
    for (const record of this.records.values()) stats[record.status] += 1
    return stats
  }
}

export async function enqueueDurableDelivery(store: DurableDeliveryStore, input: DurableDeliveryInput, now?: number): Promise<DurableDeliveryRecord> {
  const result = await store.create(input, now)
  if (result.outcome === 'conflict') throw new DeliveryConflictError()
  return result.record
}

function key(tenantId: string, eventKey: string) { return `${tenantId}:${eventKey}` }
function hash(body: string) { return createHash('sha256').update(body, 'utf8').digest('hex') }
function clone(record: DurableDeliveryRecord): DurableDeliveryRecord { return { ...record } }
function normalizeAttempts(value: number | undefined) { if (value === undefined) return 5; if (!Number.isInteger(value) || value < 1 || value > 20) throw new Error('maxAttempts must be between 1 and 20'); return value }
function normalizeDelay(value: number | undefined) { if (value === undefined) return 1_000; if (!Number.isInteger(value) || value < 1 || value > 3_600_000) throw new Error('baseDelayMs is outside the supported range'); return value }
function sanitizeError(value: string) { return value.replace(/https?:\/\/[^\s]+/gi, '[url]').slice(0, 1_000) }
function validateInput(input: DurableDeliveryInput) {
  if (!input.tenantId.trim() || !input.eventKey.trim() || !input.destination.trim()) throw new Error('tenantId, eventKey, and destination are required')
  if (typeof input.body !== 'string' || input.body.length === 0) throw new Error('delivery body is required')
  try { JSON.parse(input.body) } catch { throw new Error('delivery body must be valid JSON') }
}
