export type AuditAction =
  | 'user.login'
  | 'api_key.create'
  | 'api_key.revoke'
  | 'api.publish'
  | 'api.update'
  | 'settlement.run';

export interface AuditLogEntry {
  id: number;
  actorUserId: number;
  action: AuditAction;
  resource: string;
  ip?: string;
  createdAt: string;
}

interface AuditEventInput {
  actorUserId: number;
  action: AuditAction;
  resource: string;
  ip?: string;
}

interface AuditListFilters {
  actorUserId?: number;
  action?: AuditAction;
  resource?: string;
}

export class AuditService {
  private entries: AuditLogEntry[] = [];
  private nextId = 1;

  record(event: AuditEventInput): AuditLogEntry {
    const entry: AuditLogEntry = {
      id: this.nextId,
      actorUserId: event.actorUserId,
      action: event.action,
      resource: event.resource,
      ip: event.ip,
      createdAt: new Date().toISOString()
    };

    this.entries.push(entry);
    this.nextId += 1;

    // Emit a structured log line for external aggregation.
    console.info(
      JSON.stringify({
        event_type: 'audit_log',
        actor_user_id: entry.actorUserId,
        action: entry.action,
        resource: entry.resource,
        ip: entry.ip,
        timestamp: entry.createdAt
      })
    );

    return entry;
  }

  list(filters: AuditListFilters = {}): AuditLogEntry[] {
    return this.entries.filter((entry) => {
      if (
        typeof filters.actorUserId === 'number' &&
        entry.actorUserId !== filters.actorUserId
      ) {
        return false;
      }

      if (filters.action && entry.action !== filters.action) {
        return false;
      }

      if (filters.resource && entry.resource !== filters.resource) {
        return false;
      }

      return true;
    });
  }

  clearForTests(): void {
    this.entries = [];
    this.nextId = 1;
  }
}
