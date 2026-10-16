/**
 * src/services/disputeService.ts
 *
 * Dispute-resolution state machine for failed billing deductions.
 *
 * State transitions:
 *   (none) ──openDispute()──► OPEN ──resolveDispute('REFUNDED')──► REFUNDED
 *                               └──resolveDispute('UPHELD')────► UPHELD
 *
 * Every transition appends an immutable row to `dispute_events` (audit trail).
 * Resolving an already-resolved dispute is rejected with 409 ConflictError.
 * Opening a second dispute for the same usage_event_id is also 409 ConflictError.
 */

import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../errors/index.js';

export type MaybePromise<T> = T | Promise<T>;

function isPromiseLike<T>(val: MaybePromise<T>): val is Promise<T> {
  return Boolean(val && typeof (val as Promise<T>).then === 'function');
}

function chainMaybePromise<T, R>(
  val: MaybePromise<T>,
  fn: (resolved: T) => MaybePromise<R>,
): MaybePromise<R> {
  if (isPromiseLike(val)) {
    return val.then((resolved) => fn(resolved));
  }
  return fn(val);
}

// ---------------------------------------------------------------------------
// Types & Schemas
// ---------------------------------------------------------------------------

export type DisputeStatus = 'OPEN' | 'REFUNDED' | 'UPHELD';
export type DisputeAction = 'OPENED' | 'RESOLVED' | 'NOTE_ADDED';

export interface Dispute {
  id: string;
  usage_event_id: string;
  opened_by: string;
  reason: string;
  status: DisputeStatus;
  resolved_by: string | null;
  resolution_notes: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface DisputeEvent {
  id: string;
  dispute_id: string;
  actor: string;
  action: DisputeAction;
  notes?: string;
  created_at: string;
}

export const openDisputeSchema = z.object({
  usage_event_id: z.string().trim().min(1, 'usage_event_id is required'),
  reason: z.string().trim().min(1, 'reason is required').max(1000, 'reason must be at most 1000 characters'),
});

export const resolveDisputeSchema = z.object({
  resolution: z.enum(['REFUNDED', 'UPHELD'], {
    error: 'resolution must be REFUNDED or UPHELD',
  }),
  notes: z.string().trim().max(1000).optional(),
});

export type OpenDisputeInput = z.infer<typeof openDisputeSchema>;
export type ResolveDisputeInput = z.infer<typeof resolveDisputeSchema>;

// ---------------------------------------------------------------------------
// Repository interface
// ---------------------------------------------------------------------------

export interface DisputeRepository {
  create(input: OpenDisputeInput, openedBy: string): MaybePromise<Dispute>;
  findById(id: string): MaybePromise<Dispute | undefined>;
  findByUser(userId: string): MaybePromise<Dispute[]>;
  listAll(): MaybePromise<Dispute[]>;
  resolve(
    id: string,
    resolution: 'REFUNDED' | 'UPHELD',
    resolvedBy: string,
    notes?: string,
  ): MaybePromise<Dispute>;
  appendEvent(event: Omit<DisputeEvent, 'id' | 'created_at'>): MaybePromise<DisputeEvent>;
  getEvents(disputeId: string): MaybePromise<DisputeEvent[]>;
}

// ---------------------------------------------------------------------------
// In-memory implementation (used in tests and dev)
// ---------------------------------------------------------------------------

export class InMemoryDisputeRepository implements DisputeRepository {
  private disputes = new Map<string, Dispute>();
  private byUsageEvent = new Map<string, string>(); // usage_event_id → dispute.id
  private events: DisputeEvent[] = [];

  create(input: OpenDisputeInput, openedBy: string): Dispute {
    if (this.byUsageEvent.has(input.usage_event_id)) {
      throw new ConflictError(
        `A dispute already exists for usage_event_id '${input.usage_event_id}'`,
        'DISPUTE_ALREADY_EXISTS',
      );
    }

    const dispute: Dispute = {
      id: uuidv4(),
      usage_event_id: input.usage_event_id,
      opened_by: openedBy,
      reason: input.reason,
      status: 'OPEN',
      resolved_by: null,
      resolution_notes: null,
      created_at: new Date().toISOString(),
      resolved_at: null,
    };

    this.disputes.set(dispute.id, dispute);
    this.byUsageEvent.set(input.usage_event_id, dispute.id);
    return { ...dispute };
  }

  findById(id: string): Dispute | undefined {
    const d = this.disputes.get(id);
    return d ? { ...d } : undefined;
  }

  findByUser(userId: string): Dispute[] {
    return Array.from(this.disputes.values())
      .filter((d) => d.opened_by === userId)
      .map((d) => ({ ...d }));
  }

  listAll(): Dispute[] {
    return Array.from(this.disputes.values()).map((d) => ({ ...d }));
  }

  resolve(
    id: string,
    resolution: 'REFUNDED' | 'UPHELD',
    resolvedBy: string,
    notes?: string,
  ): Dispute {
    const existing = this.disputes.get(id);
    if (!existing) {
      throw new NotFoundError(`Dispute '${id}' not found`);
    }
    if (existing.status !== 'OPEN') {
      throw new ConflictError(
        `Dispute '${id}' is already ${existing.status} and cannot be resolved again`,
        'DISPUTE_ALREADY_RESOLVED',
      );
    }

    const updated: Dispute = {
      ...existing,
      status: resolution,
      resolved_by: resolvedBy,
      resolution_notes: notes ?? existing.resolution_notes ?? null,
      resolved_at: new Date().toISOString(),
    };

    this.disputes.set(id, updated);
    return { ...updated };
  }

  appendEvent(event: Omit<DisputeEvent, 'id' | 'created_at'>): DisputeEvent {
    const record: DisputeEvent = {
      ...event,
      id: uuidv4(),
      created_at: new Date().toISOString(),
    };
    this.events.push(record);
    return { ...record };
  }

  getEvents(disputeId: string): DisputeEvent[] {
    return this.events
      .filter((e) => e.dispute_id === disputeId)
      .map((e) => ({ ...e }));
  }
}

// ---------------------------------------------------------------------------
// Postgres-backed implementation (targets migrations/0019_disputes.sql)
// ---------------------------------------------------------------------------

export interface DisputeQueryResult<R = Record<string, unknown>> {
  rows: R[];
  rowCount?: number | null;
}

export interface DisputeDb {
  query<R = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<DisputeQueryResult<R>>;
}

interface DisputeRow {
  id: string;
  usage_event_id: string;
  opened_by: string;
  reason: string;
  status: DisputeStatus;
  resolved_by: string | null;
  resolution_notes: string | null;
  created_at: Date | string;
  resolved_at: Date | string | null;
}

interface DisputeEventRow {
  id: string;
  dispute_id: string;
  actor: string;
  action: DisputeAction;
  notes: string | null;
  created_at: Date | string;
}

function toIsoTimestamp(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function mapDisputeRow(row: DisputeRow): Dispute {
  return {
    id: row.id,
    usage_event_id: row.usage_event_id,
    opened_by: row.opened_by,
    reason: row.reason,
    status: row.status,
    resolved_by: row.resolved_by ?? null,
    resolution_notes: row.resolution_notes ?? null,
    created_at: toIsoTimestamp(row.created_at) ?? new Date().toISOString(),
    resolved_at: toIsoTimestamp(row.resolved_at),
  };
}

function mapDisputeEventRow(row: DisputeEventRow): DisputeEvent {
  return {
    id: row.id,
    dispute_id: row.dispute_id,
    actor: row.actor,
    action: row.action,
    ...(row.notes !== null && row.notes !== undefined ? { notes: row.notes } : {}),
    created_at: toIsoTimestamp(row.created_at) ?? new Date().toISOString(),
  };
}

function isUniqueViolationError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const pgErr = err as { code?: string; message?: string; constraint?: string };
  if (pgErr.code === '23505') return true;
  if (typeof pgErr.constraint === 'string' && pgErr.constraint.includes('usage_event')) {
    return true;
  }
  if (
    typeof pgErr.message === 'string' &&
    /duplicate key|unique constraint|uq_disputes_usage_event/i.test(pgErr.message)
  ) {
    return true;
  }
  return false;
}

export class PgDisputeRepository implements DisputeRepository {
  constructor(private readonly db: DisputeDb) {}

  async create(input: OpenDisputeInput, openedBy: string): Promise<Dispute> {
    const id = uuidv4();
    const nowIso = new Date().toISOString();
    try {
      const result = await this.db.query<DisputeRow>(
        `INSERT INTO disputes (
           id, usage_event_id, opened_by, reason, status, resolved_by, resolution_notes, created_at, resolved_at
         ) VALUES ($1, $2, $3, $4, 'OPEN', NULL, NULL, $5, NULL)
         RETURNING id, usage_event_id, opened_by, reason, status, resolved_by, resolution_notes, created_at, resolved_at`,
        [id, input.usage_event_id, openedBy, input.reason, nowIso],
      );
      return mapDisputeRow(result.rows[0]);
    } catch (err) {
      if (isUniqueViolationError(err)) {
        throw new ConflictError(
          `A dispute already exists for usage_event_id '${input.usage_event_id}'`,
          'DISPUTE_ALREADY_EXISTS',
        );
      }
      throw err;
    }
  }

  async findById(id: string): Promise<Dispute | undefined> {
    const result = await this.db.query<DisputeRow>(
      `SELECT id, usage_event_id, opened_by, reason, status, resolved_by, resolution_notes, created_at, resolved_at
       FROM disputes
       WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? mapDisputeRow(result.rows[0]) : undefined;
  }

  async findByUser(userId: string): Promise<Dispute[]> {
    const result = await this.db.query<DisputeRow>(
      `SELECT id, usage_event_id, opened_by, reason, status, resolved_by, resolution_notes, created_at, resolved_at
       FROM disputes
       WHERE opened_by = $1
       ORDER BY created_at DESC`,
      [userId],
    );
    return result.rows.map(mapDisputeRow);
  }

  async listAll(): Promise<Dispute[]> {
    const result = await this.db.query<DisputeRow>(
      `SELECT id, usage_event_id, opened_by, reason, status, resolved_by, resolution_notes, created_at, resolved_at
       FROM disputes
       ORDER BY created_at DESC`,
    );
    return result.rows.map(mapDisputeRow);
  }

  async resolve(
    id: string,
    resolution: 'REFUNDED' | 'UPHELD',
    resolvedBy: string,
    notes?: string,
  ): Promise<Dispute> {
    const existing = await this.findById(id);
    if (!existing) {
      throw new NotFoundError(`Dispute '${id}' not found`);
    }
    if (existing.status !== 'OPEN') {
      throw new ConflictError(
        `Dispute '${id}' is already ${existing.status} and cannot be resolved again`,
        'DISPUTE_ALREADY_RESOLVED',
      );
    }

    const nowIso = new Date().toISOString();
    const updated = await this.db.query<DisputeRow>(
      `UPDATE disputes
       SET status = $2,
           resolved_by = $3,
           resolution_notes = $4,
           resolved_at = $5
       WHERE id = $1 AND status = 'OPEN'
       RETURNING id, usage_event_id, opened_by, reason, status, resolved_by, resolution_notes, created_at, resolved_at`,
      [id, resolution, resolvedBy, notes ?? existing.resolution_notes ?? null, nowIso],
    );

    if (!updated.rows[0]) {
      throw new ConflictError(
        `Dispute '${id}' is already resolved and cannot be resolved again`,
        'DISPUTE_ALREADY_RESOLVED',
      );
    }

    return mapDisputeRow(updated.rows[0]);
  }

  async appendEvent(
    event: Omit<DisputeEvent, 'id' | 'created_at'>,
  ): Promise<DisputeEvent> {
    const id = uuidv4();
    const nowIso = new Date().toISOString();
    const result = await this.db.query<DisputeEventRow>(
      `INSERT INTO dispute_events (id, dispute_id, actor, action, notes, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, dispute_id, actor, action, notes, created_at`,
      [id, event.dispute_id, event.actor, event.action, event.notes ?? null, nowIso],
    );
    return mapDisputeEventRow(result.rows[0]);
  }

  async getEvents(disputeId: string): Promise<DisputeEvent[]> {
    const result = await this.db.query<DisputeEventRow>(
      `SELECT id, dispute_id, actor, action, notes, created_at
       FROM dispute_events
       WHERE dispute_id = $1
       ORDER BY created_at ASC`,
      [disputeId],
    );
    return result.rows.map(mapDisputeEventRow);
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class DisputeService {
  constructor(private readonly repo: DisputeRepository) {}

  openDispute(input: OpenDisputeInput, actor: string): MaybePromise<Dispute> {
    return chainMaybePromise(this.repo.create(input, actor), (dispute) =>
      chainMaybePromise(
        this.repo.appendEvent({
          dispute_id: dispute.id,
          actor,
          action: 'OPENED',
          notes: input.reason,
        }),
        () => dispute,
      ),
    );
  }

  resolveDispute(
    id: string,
    input: ResolveDisputeInput,
    adminActor: string,
  ): MaybePromise<Dispute> {
    return chainMaybePromise(
      this.repo.resolve(id, input.resolution, adminActor, input.notes),
      (dispute) =>
        chainMaybePromise(
          this.repo.appendEvent({
            dispute_id: dispute.id,
            actor: adminActor,
            action: 'RESOLVED',
            notes: input.notes ?? `Resolved as ${input.resolution}`,
          }),
          () => dispute,
        ),
    );
  }

  /** Developer-scoped fetch — throws ForbiddenError if not the owner. */
  getDisputeForDeveloper(id: string, developerId: string): MaybePromise<Dispute> {
    return chainMaybePromise(this.repo.findById(id), (dispute) => {
      if (!dispute) {
        throw new NotFoundError(`Dispute '${id}' not found`);
      }
      if (dispute.opened_by !== developerId) {
        throw new ForbiddenError('You do not have access to this dispute');
      }
      return dispute;
    });
  }

  getEvents(disputeId: string): MaybePromise<DisputeEvent[]> {
    return this.repo.getEvents(disputeId);
  }

  listForDeveloper(developerId: string): MaybePromise<Dispute[]> {
    return this.repo.findByUser(developerId);
  }

  listAll(): MaybePromise<Dispute[]> {
    return this.repo.listAll();
  }
}

export const defaultDisputeRepository = new InMemoryDisputeRepository();
export const defaultDisputeService = new DisputeService(defaultDisputeRepository);
