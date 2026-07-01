/**
 * src/services/disputeService.ts
 *
 * In-memory dispute store with state machine and audit trail.
 *
 * State machine:
 *   OPEN → REFUNDED  (admin action)
 *   OPEN → UPHELD    (admin action)
 *
 * dispute_events audit trail records every transition.
 */

import { z } from 'zod';
import { ConflictError, NotFoundError, ForbiddenError } from '../errors/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DisputeStatus = 'OPEN' | 'REFUNDED' | 'UPHELD';

export interface Dispute {
  id: string;
  usage_event_id: string;
  opened_by: string;       // developer user_id
  reason: string;
  status: DisputeStatus;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}

export interface DisputeEvent {
  id: string;
  dispute_id: string;
  actor: string;
  action: string;
  details?: Record<string, unknown>;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

export const openDisputeSchema = z.object({
  usage_event_id: z.string().min(1, 'usage_event_id is required'),
  reason: z.string().min(1).max(1000),
});

export const resolveDisputeSchema = z.object({
  resolution: z.enum(['REFUNDED', 'UPHELD']),
  notes: z.string().max(1000).optional(),
});

export type OpenDisputeInput = z.infer<typeof openDisputeSchema>;
export type ResolveDisputeInput = z.infer<typeof resolveDisputeSchema>;

// ---------------------------------------------------------------------------
// Repository interface
// ---------------------------------------------------------------------------

export interface DisputeRepository {
  create(input: OpenDisputeInput, openedBy: string): Dispute;
  findById(id: string): Dispute | undefined;
  findByUsageEventId(usageEventId: string): Dispute | undefined;
  findByUser(userId: string): Dispute[];
  listAll(): Dispute[];
  resolve(id: string, resolution: 'REFUNDED' | 'UPHELD', resolvedBy: string): Dispute;
  appendEvent(event: Omit<DisputeEvent, 'id' | 'created_at'>): DisputeEvent;
  getEvents(disputeId: string): DisputeEvent[];
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

let _counter = 0;
function nextId(prefix: string): string {
  return `${prefix}_${Date.now()}_${++_counter}`;
}

export class InMemoryDisputeRepository implements DisputeRepository {
  private readonly disputes = new Map<string, Dispute>();
  private readonly events: DisputeEvent[] = [];

  create(input: OpenDisputeInput, openedBy: string): Dispute {
    // One open dispute per usage_event_id
    const existing = this.findByUsageEventId(input.usage_event_id);
    if (existing) {
      throw new ConflictError(
        `A dispute already exists for usage_event_id '${input.usage_event_id}'`,
        'CONFLICT',
      );
    }

    const dispute: Dispute = {
      id: nextId('disp'),
      usage_event_id: input.usage_event_id,
      opened_by: openedBy,
      reason: input.reason,
      status: 'OPEN',
      created_at: new Date().toISOString(),
      resolved_at: null,
      resolved_by: null,
    };
    this.disputes.set(dispute.id, dispute);
    return dispute;
  }

  findById(id: string): Dispute | undefined {
    return this.disputes.get(id);
  }

  findByUsageEventId(usageEventId: string): Dispute | undefined {
    for (const d of this.disputes.values()) {
      if (d.usage_event_id === usageEventId) return d;
    }
    return undefined;
  }

  findByUser(userId: string): Dispute[] {
    return Array.from(this.disputes.values()).filter(d => d.opened_by === userId);
  }

  listAll(): Dispute[] {
    return Array.from(this.disputes.values());
  }

  resolve(id: string, resolution: 'REFUNDED' | 'UPHELD', resolvedBy: string): Dispute {
    const dispute = this.disputes.get(id);
    if (!dispute) throw new NotFoundError(`Dispute '${id}' not found`);
    if (dispute.status !== 'OPEN') {
      throw new ConflictError(`Dispute '${id}' is already ${dispute.status}`, 'CONFLICT');
    }

    const updated: Dispute = {
      ...dispute,
      status: resolution,
      resolved_at: new Date().toISOString(),
      resolved_by: resolvedBy,
    };
    this.disputes.set(id, updated);
    return updated;
  }

  appendEvent(event: Omit<DisputeEvent, 'id' | 'created_at'>): DisputeEvent {
    const full: DisputeEvent = {
      ...event,
      id: nextId('devt'),
      created_at: new Date().toISOString(),
    };
    this.events.push(full);
    return full;
  }

  getEvents(disputeId: string): DisputeEvent[] {
    return this.events.filter(e => e.dispute_id === disputeId);
  }
}

// ---------------------------------------------------------------------------
// Service layer (enforces RBAC + audit trail)
// ---------------------------------------------------------------------------

export class DisputeService {
  constructor(private readonly repo: DisputeRepository) {}

  openDispute(input: OpenDisputeInput, openedBy: string): Dispute {
    const dispute = this.repo.create(input, openedBy);
    this.repo.appendEvent({
      dispute_id: dispute.id,
      actor: openedBy,
      action: 'OPENED',
      details: { usage_event_id: input.usage_event_id, reason: input.reason },
    });
    return dispute;
  }

  resolveDispute(
    disputeId: string,
    input: ResolveDisputeInput,
    adminActor: string,
  ): Dispute {
    const dispute = this.repo.resolve(disputeId, input.resolution, adminActor);
    this.repo.appendEvent({
      dispute_id: dispute.id,
      actor: adminActor,
      action: 'RESOLVED',
      details: { resolution: input.resolution, notes: input.notes },
    });
    return dispute;
  }

  getDisputeForDeveloper(disputeId: string, userId: string): Dispute {
    const dispute = this.repo.findById(disputeId);
    if (!dispute) throw new NotFoundError(`Dispute '${disputeId}' not found`);
    if (dispute.opened_by !== userId) {
      throw new ForbiddenError('You do not have access to this dispute');
    }
    return dispute;
  }

  listForDeveloper(userId: string): Dispute[] {
    return this.repo.findByUser(userId);
  }

  listAll(): Dispute[] {
    return this.repo.listAll();
  }

  getEvents(disputeId: string): DisputeEvent[] {
    return this.repo.getEvents(disputeId);
  }
}

// ---------------------------------------------------------------------------
// Singleton default instances
// ---------------------------------------------------------------------------

export const defaultDisputeRepository = new InMemoryDisputeRepository();
export const defaultDisputeService = new DisputeService(defaultDisputeRepository);
