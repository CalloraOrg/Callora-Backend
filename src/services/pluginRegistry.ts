/**
 * src/services/pluginRegistry.ts
 *
 * In-memory plugin registry for the community marketplace.
 * Manages plugin manifests, installation state, and provides
 * a sandboxed execution stub for billing rule hooks.
 */

import { z } from 'zod';
import { ConflictError, NotFoundError, BadRequestError } from '../errors/index.js';

// ---------------------------------------------------------------------------
// Manifest schema (Zod)
// ---------------------------------------------------------------------------

export const pluginManifestSchema = z.object({
  /** Unique plugin identifier (lowercase, alphanumeric + hyphens) */
  id: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'id must be lowercase alphanumeric and hyphens'),
  name: z.string().min(1).max(128),
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/, 'version must be semver (e.g. 1.0.0)'),
  description: z.string().max(512).optional(),
  author: z.string().max(128).optional(),
  /**
   * Declared billing rule hooks the plugin wishes to register.
   * Currently a list of event names (informational / sandbox only).
   */
  hooks: z
    .array(z.enum(['before_charge', 'after_charge', 'on_refund', 'on_quota_exceeded']))
    .min(1, 'at least one hook must be declared'),
  /**
   * Optional URL pointing to the plugin source (audit trail).
   */
  source_url: z.string().url().optional(),
});

export type PluginManifest = z.infer<typeof pluginManifestSchema>;

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type PluginStatus = 'available' | 'installed';

export interface PluginRecord {
  manifest: PluginManifest;
  status: PluginStatus;
  /** User ID of the installer, or null if not yet installed */
  installed_by: string | null;
  /** ISO-8601 install timestamp, or null if not installed */
  installed_at: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Repository interface (dependency-injectable for tests)
// ---------------------------------------------------------------------------

export interface PluginRepository {
  list(): PluginRecord[];
  findById(id: string): PluginRecord | undefined;
  register(manifest: PluginManifest): PluginRecord;
  install(id: string, userId: string): PluginRecord;
  uninstall(id: string, userId: string): PluginRecord;
  delete(id: string): void;
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

export class InMemoryPluginRepository implements PluginRepository {
  private readonly store = new Map<string, PluginRecord>();

  list(): PluginRecord[] {
    return Array.from(this.store.values());
  }

  findById(id: string): PluginRecord | undefined {
    return this.store.get(id);
  }

  register(manifest: PluginManifest): PluginRecord {
    if (this.store.has(manifest.id)) {
      throw new ConflictError(`Plugin '${manifest.id}' is already registered`, 'CONFLICT');
    }
    const record: PluginRecord = {
      manifest,
      status: 'available',
      installed_by: null,
      installed_at: null,
      created_at: new Date().toISOString(),
    };
    this.store.set(manifest.id, record);
    return record;
  }

  install(id: string, userId: string): PluginRecord {
    const record = this.store.get(id);
    if (!record) {
      throw new NotFoundError(`Plugin '${id}' not found`);
    }
    if (record.status === 'installed') {
      throw new ConflictError(`Plugin '${id}' is already installed`, 'CONFLICT');
    }
    const updated: PluginRecord = {
      ...record,
      status: 'installed',
      installed_by: userId,
      installed_at: new Date().toISOString(),
    };
    this.store.set(id, updated);
    return updated;
  }

  uninstall(id: string, userId: string): PluginRecord {
    const record = this.store.get(id);
    if (!record) {
      throw new NotFoundError(`Plugin '${id}' not found`);
    }
    if (record.status !== 'installed') {
      throw new BadRequestError(`Plugin '${id}' is not installed`, 'BAD_REQUEST');
    }
    const updated: PluginRecord = {
      ...record,
      status: 'available',
      installed_by: userId,
      installed_at: null,
    };
    this.store.set(id, updated);
    return updated;
  }

  delete(id: string): void {
    if (!this.store.has(id)) {
      throw new NotFoundError(`Plugin '${id}' not found`);
    }
    this.store.delete(id);
  }
}

// ---------------------------------------------------------------------------
// Sandboxed execution stub
// ---------------------------------------------------------------------------

export type HookEvent = PluginManifest['hooks'][number];

export interface HookContext {
  userId: string;
  pluginId: string;
  hook: HookEvent;
  payload?: Record<string, unknown>;
}

/**
 * Sandboxed hook executor (stub).
 *
 * In a production system this would run plugin code inside a Worker thread
 * or isolated VM context with strict resource limits. For now it validates
 * that the hook is declared in the manifest and logs the invocation — no
 * arbitrary code execution occurs.
 *
 * Returns a stable audit-friendly result object.
 */
export function executeHook(
  record: PluginRecord,
  hook: HookEvent,
  context: Pick<HookContext, 'userId' | 'payload'>,
): { ok: boolean; hook: HookEvent; pluginId: string; sandboxed: true } {
  if (!record.manifest.hooks.includes(hook)) {
    throw new BadRequestError(
      `Plugin '${record.manifest.id}' does not declare hook '${hook}'`,
      'BAD_REQUEST',
    );
  }
  if (record.status !== 'installed') {
    throw new BadRequestError(
      `Plugin '${record.manifest.id}' must be installed before hooks can be fired`,
      'BAD_REQUEST',
    );
  }

  // Stub: log the invocation. Real impl would sandbox plugin code here.
  return { ok: true, hook, pluginId: record.manifest.id, sandboxed: true };
}

// ---------------------------------------------------------------------------
// Singleton default instance
// ---------------------------------------------------------------------------

export const defaultPluginRepository: PluginRepository = new InMemoryPluginRepository();
