import {
  DisputeService,
  InMemoryDisputeRepository,
  type DisputeRepository,
  type DisputeEvent,
  type Dispute,
  type OpenDisputeInput,
} from './disputeService.js';
import { refundsCache } from './refundsCacheWarm.js';

function makeSvc() {
  const repo = new InMemoryDisputeRepository();
  return { svc: new DisputeService(repo), repo };
}

describe('DisputeService', () => {
  afterEach(() => {
    refundsCache.clear();
  });

  describe('open → resolve', () => {
    it('opens a dispute and resolves it to REFUNDED', () => {
      const { svc, repo } = makeSvc();

      const opened = svc.openDispute(
        { usage_event_id: 'evt-1303', reason: 'Incorrect charge' },
        'developer-1',
      );

      expect(opened.status).toBe('OPEN');

      const resolved = svc.resolveDispute(
        opened.id,
        { resolution: 'REFUNDED' },
        'admin-1',
      );

      expect(resolved.status).toBe('REFUNDED');
      expect(resolved.resolved_by).toBe('admin-1');
      expect(resolved.resolved_at).not.toBeNull();

      const events = repo.getEvents(opened.id);
      expect(events.map((event) => event.action)).toEqual([
        'OPENED',
        'RESOLVED',
      ]);
    });
  });

  describe('resolving twice', () => {
    it('throws ConflictError when a resolved dispute is resolved again', () => {
      const { svc } = makeSvc();

      const dispute = svc.openDispute(
        { usage_event_id: 'evt-1303-conflict', reason: 'Incorrect charge' },
        'developer-1',
      );

      svc.resolveDispute(
        dispute.id,
        { resolution: 'UPHELD' },
        'admin-1',
      );

      expect(() =>
        svc.resolveDispute(
          dispute.id,
          { resolution: 'REFUNDED' },
          'admin-2',
        ),
      ).toThrow(/already UPHELD/);
    });
  });

  describe('developer ownership', () => {
    it('throws ForbiddenError when a non-owner accesses a dispute', () => {
      const { svc } = makeSvc();

      const dispute = svc.openDispute(
        { usage_event_id: 'evt-1303-owner', reason: 'Incorrect charge' },
        'owner-1',
      );

      expect(() =>
        svc.getDisputeForDeveloper(dispute.id, 'other-user'),
      ).toThrow(/do not have access to this dispute/);
    });
  });

  describe('event creation ordering', () => {
    it('resolves the dispute before creating the RESOLVED event', () => {
      const calls: string[] = [];

      const baseRepo = new InMemoryDisputeRepository();
      const repo: DisputeRepository = {
        create(input: OpenDisputeInput, openedBy: string): Dispute {
          return baseRepo.create(input, openedBy);
        },
        findById(id: string): Dispute | undefined {
          return baseRepo.findById(id);
        },
        findByUsageEventId(usageEventId: string): Dispute | undefined {
          return baseRepo.findByUsageEventId(usageEventId);
        },
        findByUser(userId: string): Dispute[] {
          return baseRepo.findByUser(userId);
        },
        listAll(): Dispute[] {
          return baseRepo.listAll();
        },
        resolve(
          id: string,
          resolution: 'REFUNDED' | 'UPHELD',
          resolvedBy: string,
        ): Dispute {
          calls.push('resolve');
          return baseRepo.resolve(id, resolution, resolvedBy);
        },
        appendEvent(
          event: Omit<DisputeEvent, 'id' | 'created_at'>,
        ): DisputeEvent {
          calls.push('appendEvent');
          return baseRepo.appendEvent(event);
        },
        getEvents(disputeId: string): DisputeEvent[] {
          return baseRepo.getEvents(disputeId);
        },
      };

      const svc = new DisputeService(repo);
      const dispute = svc.openDispute(
        { usage_event_id: 'evt-1303-order', reason: 'Incorrect charge' },
        'developer-1',
      );

      calls.length = 0;

      svc.resolveDispute(
        dispute.id,
        { resolution: 'REFUNDED' },
        'admin-1',
      );

      expect(calls).toEqual(['resolve', 'appendEvent']);
    });
  });

  describe('refund cache invalidation', () => {
    it('invalidates the cache when a dispute becomes REFUNDED', () => {
      const { svc } = makeSvc();
      refundsCache.set('all', ['cached-refunds']);

      const dispute = svc.openDispute(
        { usage_event_id: 'evt-1303-refund', reason: 'Incorrect charge' },
        'developer-1',
      );

      svc.resolveDispute(
        dispute.id,
        { resolution: 'REFUNDED' },
        'admin-1',
      );

      expect(refundsCache.size).toBe(0);
    });

    it('does not invalidate the cache when a dispute becomes UPHELD', () => {
      const { svc } = makeSvc();
      refundsCache.set('all', ['cached-refunds']);

      const dispute = svc.openDispute(
        { usage_event_id: 'evt-1303-upheld', reason: 'Incorrect charge' },
        'developer-1',
      );

      svc.resolveDispute(
        dispute.id,
        { resolution: 'UPHELD' },
        'admin-1',
      );

      expect(refundsCache.size).toBe(1);
      expect(refundsCache.get('all')).toEqual(['cached-refunds']);
    });
  });
});
