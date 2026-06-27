import { v4 as uuidv4 } from 'uuid';
import { logger } from '../logger.js';
import { NotFoundError, ConflictError } from '../errors/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QuotaRequestStatus = 'pending' | 'approved' | 'rejected';

export interface QuotaRequest {
  id: string;
  developerId: string;
  requestedTier: string;
  reason: string;
  requestedOverrides?: {
    monthlyCallLimit?: number;
    rateLimitMaxRequests?: number;
  };
  status: QuotaRequestStatus;
  adminNotes?: string;
  createdAt: Date;
  resolvedAt?: Date;
  resolvedBy?: string;
}

export interface CreateQuotaRequestInput {
  developerId: string;
  requestedTier: string;
  reason: string;
  requestedOverrides?: {
    monthlyCallLimit?: number;
    rateLimitMaxRequests?: number;
  };
}

export interface QuotaRequestStore {
  create(input: CreateQuotaRequestInput): Promise<QuotaRequest>;
  findById(id: string): Promise<QuotaRequest | undefined>;
  list(filter?: { status?: QuotaRequestStatus }): Promise<QuotaRequest[]>;
  update(
    id: string,
    changes: Partial<QuotaRequest>,
  ): Promise<QuotaRequest | undefined>;
}

// ---------------------------------------------------------------------------
// In-memory store (matches InMemoryUsageEventsRepository pattern)
// ---------------------------------------------------------------------------

export class InMemoryQuotaRequestStore implements QuotaRequestStore {
  private readonly requests = new Map<string, QuotaRequest>();

  async create(input: CreateQuotaRequestInput): Promise<QuotaRequest> {
    const request: QuotaRequest = {
      id: uuidv4(),
      developerId: input.developerId,
      requestedTier: input.requestedTier,
      reason: input.reason,
      requestedOverrides: input.requestedOverrides,
      status: 'pending',
      createdAt: new Date(),
    };
    this.requests.set(request.id, request);
    return request;
  }

  async findById(id: string): Promise<QuotaRequest | undefined> {
    return this.requests.get(id);
  }

  async list(filter?: { status?: QuotaRequestStatus }): Promise<QuotaRequest[]> {
    const all = Array.from(this.requests.values());
    if (filter?.status) {
      return all.filter((r) => r.status === filter.status);
    }
    return all;
  }

  async update(
    id: string,
    changes: Partial<QuotaRequest>,
  ): Promise<QuotaRequest | undefined> {
    const existing = this.requests.get(id);
    if (!existing) return undefined;
    const updated = { ...existing, ...changes };
    this.requests.set(id, updated);
    return updated;
  }
}

// ---------------------------------------------------------------------------
// Singleton instance
// ---------------------------------------------------------------------------

let storeInstance: QuotaRequestStore | undefined;

export function getQuotaRequestStore(): QuotaRequestStore {
  if (!storeInstance) {
    storeInstance = new InMemoryQuotaRequestStore();
  }
  return storeInstance;
}

export function setQuotaRequestStore(store: QuotaRequestStore): void {
  storeInstance = store;
}

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

export async function createQuotaRequest(input: CreateQuotaRequestInput): Promise<QuotaRequest> {
  const store = getQuotaRequestStore();
  const request = await store.create(input);

  logger.audit('QUOTA_REQUEST_CREATED', input.developerId, {
    requestId: request.id,
    requestedTier: input.requestedTier,
    reason: input.reason,
  });

  logger.info('Quota request submitted', {
    requestId: request.id,
    developerId: input.developerId,
    requestedTier: input.requestedTier,
  });

  return request;
}

export async function getQuotaRequest(requestId: string): Promise<QuotaRequest> {
  const store = getQuotaRequestStore();
  const request = await store.findById(requestId);
  if (!request) {
    throw new NotFoundError('Quota request not found', 'QUOTA_REQUEST_NOT_FOUND');
  }
  return request;
}

export async function listQuotaRequests(filter?: {
  status?: QuotaRequestStatus;
}): Promise<QuotaRequest[]> {
  const store = getQuotaRequestStore();
  return store.list(filter);
}

export async function approveQuotaRequest(
  requestId: string,
  adminActor: string,
  adminNotes?: string,
  updateOverrides?: (developerUserId: string, overrides: Record<string, unknown>) => Promise<void>,
): Promise<QuotaRequest> {
  const store = getQuotaRequestStore();
  const request = await store.findById(requestId);
  if (!request) {
    throw new NotFoundError('Quota request not found', 'QUOTA_REQUEST_NOT_FOUND');
  }
  if (request.status !== 'pending') {
    throw new ConflictError(
      `Quota request is already ${request.status}`,
      'QUOTA_REQUEST_ALREADY_RESOLVED',
    );
  }

  const updated = await store.update(requestId, {
    status: 'approved',
    adminNotes,
    resolvedAt: new Date(),
    resolvedBy: adminActor,
  });

  const persist = updateOverrides ?? updateDeveloperPlanOverrides;
  await persist(request.developerId, {
    plan_tier: request.requestedTier,
    ...(request.requestedOverrides?.monthlyCallLimit
      ? { monthly_call_limit: request.requestedOverrides.monthlyCallLimit }
      : {}),
    ...(request.requestedOverrides?.rateLimitMaxRequests
      ? { rate_limit_max_requests: request.requestedOverrides.rateLimitMaxRequests }
      : {}),
  });

  logger.audit('QUOTA_REQUEST_APPROVED', adminActor, {
    requestId,
    developerId: request.developerId,
    tier: request.requestedTier,
    adminNotes,
  });

  return updated!;
}

export async function rejectQuotaRequest(
  requestId: string,
  adminActor: string,
  adminNotes?: string,
): Promise<QuotaRequest> {
  const store = getQuotaRequestStore();
  const request = await store.findById(requestId);
  if (!request) {
    throw new NotFoundError('Quota request not found', 'QUOTA_REQUEST_NOT_FOUND');
  }
  if (request.status !== 'pending') {
    throw new ConflictError(
      `Quota request is already ${request.status}`,
      'QUOTA_REQUEST_ALREADY_RESOLVED',
    );
  }

  const updated = await store.update(requestId, {
    status: 'rejected',
    adminNotes,
    resolvedAt: new Date(),
    resolvedBy: adminActor,
  });

  logger.audit('QUOTA_REQUEST_REJECTED', adminActor, {
    requestId,
    developerId: request.developerId,
    reason: request.reason,
    adminNotes,
  });

  return updated!;
}

async function updateDeveloperPlanOverrides(
  developerUserId: string,
  overrides: Record<string, unknown>,
): Promise<void> {
  const { eq } = await import('drizzle-orm');
  const { db, schema } = await import('../db/index.js');

  const existing = await db
    .select({ plan_overrides: schema.developers.plan_overrides })
    .from(schema.developers)
    .where(eq(schema.developers.user_id, developerUserId))
    .limit(1);

  const currentOverrides = existing[0]?.plan_overrides
    ? JSON.parse(existing[0].plan_overrides)
    : {};

  const merged = { ...currentOverrides, ...overrides, updated_at: new Date().toISOString() };

  await db
    .update(schema.developers)
    .set({ plan_overrides: JSON.stringify(merged) })
    .where(eq(schema.developers.user_id, developerUserId));
}
