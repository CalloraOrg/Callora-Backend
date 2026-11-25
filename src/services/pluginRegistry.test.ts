/**
 * src/services/pluginRegistry.test.ts
 *
 * Service-level tests for InMemoryPluginRepository and executeHook.
 * Covers:
 *   - Plugin lifecycle transitions: register → install → uninstall → delete
 *   - executeHook preconditions (undeclared hooks, uninstalled plugins)
 *   - pluginManifestSchema validation (valid & invalid inputs)
 *
 * Closes #1302
 */

import assert from 'node:assert/strict';
import {
  InMemoryPluginRepository,
  executeHook,
  pluginManifestSchema,
  type PluginManifest,
  type PluginRecord,
} from './pluginRegistry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns a valid plugin manifest, overrideable per-test */
function makeManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: 'test-plugin',
    name: 'Test Plugin',
    version: '1.0.0',
    hooks: ['before_charge'],
    ...overrides,
  };
}

/** Creates a fresh repository (no shared state between tests) */
function makeRepo() {
  return new InMemoryPluginRepository();
}

/**
 * Asserts that fn throws an error whose .name matches errorName.
 * We avoid `instanceof` to sidestep CJS/ESM prototype-chain issues in ts-jest.
 */
async function assertRejectsName(
  fn: () => Promise<unknown>,
  errorName: string,
  msgFragment?: string,
): Promise<void> {
  let threw = false;
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    threw = true;
    caught = err;
  }
  assert.ok(threw, `Expected function to reject with ${errorName}, but it did not`);
  const err = caught as Error;
  assert.equal(
    err.name,
    errorName,
    `Expected error.name to be "${errorName}", got "${err.name}"`,
  );
  if (msgFragment) {
    assert.ok(
      err.message.includes(msgFragment),
      `Expected error.message to include "${msgFragment}", got: "${err.message}"`,
    );
  }
}

function assertThrowsName(fn: () => unknown, errorName: string, msgFragment?: string): void {
  let threw = false;
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    threw = true;
    caught = err;
  }
  assert.ok(threw, `Expected function to throw ${errorName}, but it did not throw`);
  const err = caught as Error;
  assert.equal(
    err.name,
    errorName,
    `Expected error.name to be "${errorName}", got "${err.name}"`,
  );
  if (msgFragment) {
    assert.ok(
      err.message.includes(msgFragment),
      `Expected error.message to include "${msgFragment}", got: "${err.message}"`,
    );
  }
}

// ---------------------------------------------------------------------------
// pluginManifestSchema validation
// ---------------------------------------------------------------------------

describe('pluginManifestSchema', () => {
  const validManifest = {
    id: 'my-plugin',
    name: 'My Plugin',
    version: '2.3.4',
    hooks: ['before_charge'] as const,
  };

  test('accepts a fully valid manifest', () => {
    const result = pluginManifestSchema.safeParse(validManifest);
    assert.ok(result.success, `Expected success but got: ${JSON.stringify((result as { error?: unknown }).error)}`);
  });

  test('accepts all valid hook names', () => {
    const hooks: PluginManifest['hooks'] = [
      'before_charge',
      'after_charge',
      'on_refund',
      'on_quota_exceeded',
    ];
    const result = pluginManifestSchema.safeParse({ ...validManifest, hooks });
    assert.ok(result.success);
  });

  test('accepts optional fields: description, author, source_url', () => {
    const full = {
      ...validManifest,
      description: 'A great plugin',
      author: 'Shantel Peters',
      source_url: 'https://example.com/plugin',
    };
    const result = pluginManifestSchema.safeParse(full);
    assert.ok(result.success);
  });

  // --- id validations ---

  test('rejects id shorter than 3 characters', () => {
    const result = pluginManifestSchema.safeParse({ ...validManifest, id: 'ab' });
    assert.ok(!result.success, 'Expected failure for short id');
  });

  test('rejects id longer than 64 characters', () => {
    const result = pluginManifestSchema.safeParse({
      ...validManifest,
      id: 'a'.repeat(65),
    });
    assert.ok(!result.success, 'Expected failure for long id');
  });

  test('rejects id with uppercase letters', () => {
    const result = pluginManifestSchema.safeParse({
      ...validManifest,
      id: 'MyPlugin',
    });
    assert.ok(!result.success, 'Expected failure for uppercase id');
  });

  test('rejects id with underscores', () => {
    const result = pluginManifestSchema.safeParse({
      ...validManifest,
      id: 'my_plugin',
    });
    assert.ok(!result.success, 'Expected failure for underscore in id');
  });

  test('rejects id with leading hyphen', () => {
    const result = pluginManifestSchema.safeParse({
      ...validManifest,
      id: '-my-plugin',
    });
    assert.ok(!result.success, 'Expected failure for leading hyphen');
  });

  test('rejects id with trailing hyphen', () => {
    const result = pluginManifestSchema.safeParse({
      ...validManifest,
      id: 'my-plugin-',
    });
    assert.ok(!result.success, 'Expected failure for trailing hyphen');
  });

  test('rejects id with spaces', () => {
    const result = pluginManifestSchema.safeParse({
      ...validManifest,
      id: 'my plugin',
    });
    assert.ok(!result.success, 'Expected failure for space in id');
  });

  test('accepts id with valid hyphen-separated segments', () => {
    const result = pluginManifestSchema.safeParse({
      ...validManifest,
      id: 'my-awesome-plugin-123',
    });
    assert.ok(result.success);
  });

  // --- version validations ---

  test('rejects version without semver format (missing patch)', () => {
    const result = pluginManifestSchema.safeParse({
      ...validManifest,
      version: '1.0',
    });
    assert.ok(!result.success, 'Expected failure for 1.0 (missing patch)');
  });

  test('rejects version with non-numeric parts', () => {
    const result = pluginManifestSchema.safeParse({
      ...validManifest,
      version: '1.0.x',
    });
    assert.ok(!result.success, 'Expected failure for non-numeric version part');
  });

  test('rejects version with pre-release suffix', () => {
    const result = pluginManifestSchema.safeParse({
      ...validManifest,
      version: '1.0.0-beta',
    });
    assert.ok(!result.success, 'Expected failure for pre-release version');
  });

  test('accepts version 0.0.0', () => {
    const result = pluginManifestSchema.safeParse({
      ...validManifest,
      version: '0.0.0',
    });
    assert.ok(result.success);
  });

  test('accepts version with large numbers', () => {
    const result = pluginManifestSchema.safeParse({
      ...validManifest,
      version: '100.200.300',
    });
    assert.ok(result.success);
  });

  // --- hooks validations ---

  test('rejects manifest with zero hooks', () => {
    const result = pluginManifestSchema.safeParse({
      ...validManifest,
      hooks: [],
    });
    assert.ok(!result.success, 'Expected failure for empty hooks array');
  });

  test('rejects manifest with unknown hook name', () => {
    const result = pluginManifestSchema.safeParse({
      ...validManifest,
      hooks: ['before_charge', 'unknown_hook'],
    });
    assert.ok(!result.success, 'Expected failure for unknown hook');
  });

  // --- source_url validations ---

  test('rejects source_url that is not a valid URL', () => {
    const result = pluginManifestSchema.safeParse({
      ...validManifest,
      source_url: 'not-a-url',
    });
    assert.ok(!result.success, 'Expected failure for invalid source_url');
  });

  test('accepts absent source_url (optional field)', () => {
    const result = pluginManifestSchema.safeParse(validManifest);
    assert.ok(result.success);
  });
});

// ---------------------------------------------------------------------------
// InMemoryPluginRepository — register
// ---------------------------------------------------------------------------

describe('InMemoryPluginRepository.register', () => {
  test('registers a new plugin and returns a record with status "available"', async () => {
    const repo = makeRepo();
    const manifest = makeManifest();
    const record = repo.register(manifest, 'owner-1');
    const record = await repo.register(manifest, 'owner-1');

    assert.equal(record.manifest.id, 'test-plugin');
    assert.equal(record.status, 'available');
    assert.equal(record.installed_by, null);
    assert.equal(record.installed_at, null);
    assert.ok(record.created_at);
  });

  test('newly registered plugin is returned by list()', async () => {
    const repo = makeRepo();
    repo.register(makeManifest({ id: 'plugin-a' }), 'owner-1');
    repo.register(makeManifest({ id: 'plugin-b' }), 'owner-1');
    await repo.register(makeManifest({ id: 'plugin-a' }), 'owner-1');
    await repo.register(makeManifest({ id: 'plugin-b' }), 'owner-1');

    const list = await repo.list();
    assert.equal(list.length, 2);
    assert.ok(list.some((r) => r.manifest.id === 'plugin-a'));
    assert.ok(list.some((r) => r.manifest.id === 'plugin-b'));
  });

  test('findById returns the registered plugin', async () => {
    const repo = makeRepo();
    repo.register(makeManifest({ id: 'find-me' }), 'owner-1');
    await repo.register(makeManifest({ id: 'find-me' }), 'owner-1');
    const found = await repo.findById('find-me');
    assert.ok(found);
    assert.equal(found.manifest.id, 'find-me');
  });

  test('findById returns undefined for unknown id', async () => {
    const repo = makeRepo();
    const found = await repo.findById('does-not-exist');
    assert.equal(found, undefined);
  });

  test('throws ConflictError when registering a duplicate id', async () => {
    const repo = makeRepo();
    repo.register(makeManifest({ id: 'dup-plugin' }), 'owner-1');
    await repo.register(makeManifest({ id: 'dup-plugin' }), 'owner-1');
    await assertRejectsName(
      () => repo.register(makeManifest({ id: 'dup-plugin' }), 'owner-1'),
      'ConflictError',
      'dup-plugin',
    );
  });

  test('created_at is a valid ISO-8601 string', async () => {
    const repo = makeRepo();
    const record = repo.register(makeManifest(), 'owner-1');
    const record = await repo.register(makeManifest(), 'owner-1');
    assert.ok(!isNaN(Date.parse(record.created_at)), 'created_at should be valid ISO-8601');
  });

  test('list() returns empty array when no plugins are registered', async () => {
    const repo = makeRepo();
    assert.deepEqual(await repo.list(), []);
  });
});

// ---------------------------------------------------------------------------
// InMemoryPluginRepository — install
// ---------------------------------------------------------------------------

describe('InMemoryPluginRepository.install', () => {
  test('transitions plugin status from "available" to "installed"', async () => {
    const repo = makeRepo();
    repo.register(makeManifest({ id: 'installable' }), 'owner-1');
    await repo.register(makeManifest({ id: 'installable' }), 'owner-1');
    const record = await repo.install('installable', 'user-1');

    assert.equal(record.status, 'installed');
    assert.equal(record.installed_by, 'user-1');
    assert.ok(record.installed_at);
    assert.ok(!isNaN(Date.parse(record.installed_at!)));
  });

  test('installed_at is a valid ISO-8601 timestamp', async () => {
    const repo = makeRepo();
    repo.register(makeManifest({ id: 'ts-check' }), 'owner-1');
    await repo.register(makeManifest({ id: 'ts-check' }), 'owner-1');
    const record = await repo.install('ts-check', 'user-x');
    assert.ok(record.installed_at);
    assert.ok(!isNaN(Date.parse(record.installed_at)));
  });

  test('throws NotFoundError when installing a non-existent plugin', async () => {
    const repo = makeRepo();
    await assertRejectsName(() => repo.install('ghost-plugin', 'user-1'), 'NotFoundError', 'ghost-plugin');
  });

  test('throws ConflictError when installing an already-installed plugin', async () => {
    const repo = makeRepo();
    repo.register(makeManifest({ id: 'already-installed' }), 'owner-1');
    await repo.register(makeManifest({ id: 'already-installed' }), 'owner-1');
    await repo.install('already-installed', 'user-1');
    await assertRejectsName(
      () => repo.install('already-installed', 'user-2'),
      'ConflictError',
    );
  });

  test('state persists — findById reflects installed status after install', async () => {
    const repo = makeRepo();
    repo.register(makeManifest({ id: 'persistent' }), 'owner-1');
    await repo.register(makeManifest({ id: 'persistent' }), 'owner-1');
    await repo.install('persistent', 'user-99');

    const found = (await repo.findById('persistent'))!;
    assert.equal(found.status, 'installed');
    assert.equal(found.installed_by, 'user-99');
  });
});

// ---------------------------------------------------------------------------
// InMemoryPluginRepository — uninstall
// ---------------------------------------------------------------------------

describe('InMemoryPluginRepository.uninstall', () => {
  test('transitions plugin status back to "available" after uninstall', async () => {
    const repo = makeRepo();
    repo.register(makeManifest({ id: 'revert-me' }), 'owner-1');
    await repo.register(makeManifest({ id: 'revert-me' }), 'owner-1');
    await repo.install('revert-me', 'user-1');
    const record = await repo.uninstall('revert-me', 'user-1');

    assert.equal(record.status, 'available');
    assert.equal(record.installed_at, null);
  });

  test('uninstalled plugin is re-installable', async () => {
    const repo = makeRepo();
    repo.register(makeManifest({ id: 'reinstallable' }), 'owner-1');
    await repo.register(makeManifest({ id: 'reinstallable' }), 'owner-1');
    await repo.install('reinstallable', 'user-1');
    await repo.uninstall('reinstallable', 'user-1');
    const reinstalled = await repo.install('reinstallable', 'user-2');

    assert.equal(reinstalled.status, 'installed');
    assert.equal(reinstalled.installed_by, 'user-2');
  });

  test('throws NotFoundError when uninstalling a non-existent plugin', async () => {
    const repo = makeRepo();
    await assertRejectsName(() => repo.uninstall('phantom', 'user-1'), 'NotFoundError');
  });

  test('throws BadRequestError when uninstalling a plugin that is not installed', async () => {
    const repo = makeRepo();
    repo.register(makeManifest({ id: 'not-installed' }), 'owner-1');
    await repo.register(makeManifest({ id: 'not-installed' }), 'owner-1');
    await assertRejectsName(
      () => repo.uninstall('not-installed', 'user-1'),
      'BadRequestError',
      'not-installed',
    );
  });

  test('findById reflects "available" status after uninstall', async () => {
    const repo = makeRepo();
    repo.register(makeManifest({ id: 'state-check' }), 'owner-1');
    await repo.register(makeManifest({ id: 'state-check' }), 'owner-1');
    await repo.install('state-check', 'user-1');
    await repo.uninstall('state-check', 'user-1');

    const found = (await repo.findById('state-check'))!;
    assert.equal(found.status, 'available');
    assert.equal(found.installed_at, null);
  });
});

// ---------------------------------------------------------------------------
// InMemoryPluginRepository — delete
// ---------------------------------------------------------------------------

describe('InMemoryPluginRepository.delete', () => {
  test('removes plugin from the registry', async () => {
    const repo = makeRepo();
    repo.register(makeManifest({ id: 'delete-me' }), 'owner-1');
    repo.delete('delete-me', 'owner-1');
    await repo.register(makeManifest({ id: 'delete-me' }), 'owner-1');
    await repo.delete('delete-me', 'owner-1');

    assert.equal(await repo.findById('delete-me'), undefined);
    assert.equal((await repo.list()).length, 0);
  });

  test('throws NotFoundError when deleting a non-existent plugin', async () => {
    const repo = makeRepo();
    assertThrowsName(() => repo.delete('nowhere', 'owner-1'), 'NotFoundError');
    await assertRejectsName(() => repo.delete('nowhere', 'owner-1'), 'NotFoundError');
  });

  test('cannot delete the same plugin twice', async () => {
    const repo = makeRepo();
    repo.register(makeManifest({ id: 'once-only' }), 'owner-1');
    repo.delete('once-only', 'owner-1');
    assertThrowsName(() => repo.delete('once-only', 'owner-1'), 'NotFoundError');
    await repo.register(makeManifest({ id: 'once-only' }), 'owner-1');
    await repo.delete('once-only', 'owner-1');
    await assertRejectsName(() => repo.delete('once-only', 'owner-1'), 'NotFoundError');
  });

  test('deleting one plugin does not affect others', async () => {
    const repo = makeRepo();
    repo.register(makeManifest({ id: 'keep-me' }), 'owner-1');
    repo.register(makeManifest({ id: 'remove-me' }), 'owner-1');
    repo.delete('remove-me', 'owner-1');
    await repo.register(makeManifest({ id: 'keep-me' }), 'owner-1');
    await repo.register(makeManifest({ id: 'remove-me' }), 'owner-1');
    await repo.delete('remove-me', 'owner-1');

    const list = await repo.list();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.manifest.id, 'keep-me');
  });
});

// ---------------------------------------------------------------------------
// executeHook — preconditions
// ---------------------------------------------------------------------------

describe('executeHook', () => {
  /** Helper: build an installed PluginRecord for hook tests */
  function makeInstalledRecord(hooks: PluginManifest['hooks'] = ['before_charge']): PluginRecord {
    return {
      manifest: makeManifest({ id: 'hook-plugin', hooks }),
      owner_id: 'owner-1',
      status: 'installed',
      installed_by: 'user-42',
      installed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    };
  }

  /** Helper: build an available (not installed) PluginRecord */
  function makeAvailableRecord(hooks: PluginManifest['hooks'] = ['before_charge']): PluginRecord {
    return {
      manifest: makeManifest({ id: 'available-plugin', hooks }),
      owner_id: 'owner-1',
      status: 'available',
      installed_by: null,
      installed_at: null,
      created_at: new Date().toISOString(),
    };
  }

  // --- happy path ---

  test('returns ok result for a declared hook on an installed plugin', () => {
    const record = makeInstalledRecord(['before_charge']);
    const result = executeHook(record, 'before_charge', { userId: 'user-1', payload: {} });

    assert.equal(result.ok, true);
    assert.equal(result.hook, 'before_charge');
    assert.equal(result.pluginId, 'hook-plugin');
    assert.equal(result.sandboxed, true);
  });

  test('executes each declared hook independently', () => {
    const record = makeInstalledRecord(['before_charge', 'after_charge', 'on_refund', 'on_quota_exceeded']);

    for (const hook of ['before_charge', 'after_charge', 'on_refund', 'on_quota_exceeded'] as const) {
      const result = executeHook(record, hook, { userId: 'user-1' });
      assert.equal(result.ok, true, `Hook '${hook}' should succeed`);
      assert.equal(result.hook, hook);
    }
  });

  // --- undeclared hook → BAD_REQUEST ---

  test('throws BadRequestError with BAD_REQUEST code when hook is undeclared in manifest', () => {
    // Plugin only declares 'before_charge'; we attempt 'on_refund'
    const record = makeInstalledRecord(['before_charge']);

    let threw = false;
    try {
      executeHook(record, 'on_refund', { userId: 'user-1' });
    } catch (err) {
      threw = true;
      const e = err as Error & { code?: string; statusCode?: number };
      assert.equal(e.name, 'BadRequestError', `Expected BadRequestError, got ${e.name}`);
      assert.equal(e.code, 'BAD_REQUEST', `Expected code BAD_REQUEST, got ${e.code}`);
      assert.ok(e.message.includes('hook-plugin'), 'message should include plugin id');
      assert.ok(e.message.includes('on_refund'), 'message should include hook name');
    }
    assert.ok(threw, 'Expected executeHook to throw for undeclared hook');
  });

  test('throws BadRequestError for "after_charge" when only "before_charge" is declared', () => {
    const record = makeInstalledRecord(['before_charge']);
    assertThrowsName(
      () => executeHook(record, 'after_charge', { userId: 'u1' }),
      'BadRequestError',
    );
  });

  test('throws BadRequestError for "on_quota_exceeded" when not declared', () => {
    const record = makeInstalledRecord(['before_charge', 'after_charge']);
    assertThrowsName(
      () => executeHook(record, 'on_quota_exceeded', { userId: 'u1' }),
      'BadRequestError',
    );
  });

  test('throws BadRequestError for "on_refund" when only "after_charge" is declared', () => {
    const record = makeInstalledRecord(['after_charge']);
    assertThrowsName(
      () => executeHook(record, 'on_refund', { userId: 'u1' }),
      'BadRequestError',
    );
  });

  // --- uninstalled plugin → BAD_REQUEST ---

  test('throws BadRequestError when plugin is not installed (status: "available")', () => {
    const record = makeAvailableRecord(['before_charge']);

    let threw = false;
    try {
      executeHook(record, 'before_charge', { userId: 'user-1' });
    } catch (err) {
      threw = true;
      const e = err as Error & { code?: string; statusCode?: number };
      assert.equal(e.name, 'BadRequestError', `Expected BadRequestError, got ${e.name}`);
      assert.equal(e.code, 'BAD_REQUEST', `Expected code BAD_REQUEST, got ${e.code}`);
      assert.ok(e.message.includes('available-plugin'), 'message should include plugin id');
    }
    assert.ok(threw, 'Expected executeHook to throw for uninstalled plugin');
  });

  test('uninstalled plugin with declared hook still throws BadRequestError', () => {
    const record: PluginRecord = {
      manifest: makeManifest({ id: 'order-test', hooks: ['before_charge'] }),
      owner_id: 'owner-1',
      status: 'available',
      installed_by: null,
      installed_at: null,
      created_at: new Date().toISOString(),
    };

    // Hook IS declared but plugin not installed — must still throw
    assertThrowsName(
      () => executeHook(record, 'before_charge', { userId: 'u1' }),
      'BadRequestError',
    );
  });

  // --- integration: repository round-trip into executeHook ---

  test('executeHook succeeds for installed plugin and fails after uninstall', async () => {
    const repo = makeRepo();
    repo.register(makeManifest({ id: 'lifecycle-plugin', hooks: ['before_charge'] }), 'owner-1');
    await repo.register(makeManifest({ id: 'lifecycle-plugin', hooks: ['before_charge'] }), 'owner-1');
    await repo.install('lifecycle-plugin', 'user-1');

    // Succeeds while installed
    const installed = (await repo.findById('lifecycle-plugin'))!;
    const result = executeHook(installed, 'before_charge', { userId: 'user-1' });
    assert.equal(result.ok, true);

    // Uninstall and hook should now throw
    await repo.uninstall('lifecycle-plugin', 'user-1');
    const uninstalled = (await repo.findById('lifecycle-plugin'))!;
    assertThrowsName(
      () => executeHook(uninstalled, 'before_charge', { userId: 'user-1' }),
      'BadRequestError',
    );
  });

  test('executeHook succeeds after re-install following uninstall', async () => {
    const repo = makeRepo();
    repo.register(makeManifest({ id: 'reinstall-hook', hooks: ['after_charge'] }), 'owner-1');
    await repo.register(makeManifest({ id: 'reinstall-hook', hooks: ['after_charge'] }), 'owner-1');
    await repo.install('reinstall-hook', 'user-a');
    await repo.uninstall('reinstall-hook', 'user-a');
    await repo.install('reinstall-hook', 'user-b');

    const record = (await repo.findById('reinstall-hook'))!;
    const result = executeHook(record, 'after_charge', { userId: 'user-b' });
    assert.equal(result.ok, true);
  });

  test('executeHook result contains correct pluginId', () => {
    const record = makeInstalledRecord(['on_refund']);
    const result = executeHook(record, 'on_refund', { userId: 'user-7', payload: { amount: 500 } });
    assert.equal(result.pluginId, 'hook-plugin');
  });

  test('executeHook accepts optional payload and works with or without it', () => {
    const record = makeInstalledRecord(['before_charge']);

    // With payload
    const withPayload = executeHook(record, 'before_charge', {
      userId: 'u1',
      payload: { amount: 100, currency: 'USD' },
    });
    assert.equal(withPayload.ok, true);

    // Without payload
    const withoutPayload = executeHook(record, 'before_charge', { userId: 'u1' });
    assert.equal(withoutPayload.ok, true);
  });

  test('executeHook always returns sandboxed: true', () => {
    const record = makeInstalledRecord(['before_charge']);
    const result = executeHook(record, 'before_charge', { userId: 'u1' });
    assert.equal(result.sandboxed, true);
  });
});

// ---------------------------------------------------------------------------
// Full lifecycle state machine
// ---------------------------------------------------------------------------

describe('Plugin full lifecycle state machine', () => {
  test('register → install → uninstall → re-install cycle', async () => {
    const repo = makeRepo();

    // 1. Register
    const registered = repo.register(makeManifest({ id: 'full-cycle' }), 'owner-1');
    const registered = await repo.register(makeManifest({ id: 'full-cycle' }), 'owner-1');
    assert.equal(registered.status, 'available');

    // 2. Install
    const installed = await repo.install('full-cycle', 'user-a');
    assert.equal(installed.status, 'installed');

    // 3. Uninstall
    const uninstalled = await repo.uninstall('full-cycle', 'user-a');
    assert.equal(uninstalled.status, 'available');
    assert.equal(uninstalled.installed_at, null);

    // 4. Re-install by a different user
    const reinstalled = await repo.install('full-cycle', 'user-b');
    assert.equal(reinstalled.status, 'installed');
    assert.equal(reinstalled.installed_by, 'user-b');
  });

  test('register → delete — subsequent operations throw NotFoundError', async () => {
    const repo = makeRepo();
    repo.register(makeManifest({ id: 'deletable' }), 'owner-1');
    repo.delete('deletable', 'owner-1');
    await repo.register(makeManifest({ id: 'deletable' }), 'owner-1');
    await repo.delete('deletable', 'owner-1');

    await assertRejectsName(() => repo.install('deletable', 'u1'), 'NotFoundError');
    await assertRejectsName(() => repo.delete('deletable', 'owner-1'), 'NotFoundError');
    assertThrowsName(() => repo.delete('deletable', 'owner-1'), 'NotFoundError');
  });

  test('multiple plugins are independently tracked', async () => {
    const repo = makeRepo();
    repo.register(makeManifest({ id: 'plugin-x', hooks: ['before_charge'] }), 'owner-1');
    repo.register(makeManifest({ id: 'plugin-y', hooks: ['on_refund'] }), 'owner-1');
    await repo.register(makeManifest({ id: 'plugin-x', hooks: ['before_charge'] }), 'owner-1');
    await repo.register(makeManifest({ id: 'plugin-y', hooks: ['on_refund'] }), 'owner-1');

    await repo.install('plugin-x', 'user-1');
    // plugin-y remains available

    const x = (await repo.findById('plugin-x'))!;
    const y = (await repo.findById('plugin-y'))!;
    assert.equal(x.status, 'installed');
    assert.equal(y.status, 'available');
  });

  test('before_charge hook is guarded: only fires when plugin is installed', async () => {
    // Simulates the billing route concern: uninstalled plugins cannot hook billing
    const repo = makeRepo();
    repo.register(makeManifest({ id: 'billing-guard', hooks: ['before_charge'] }), 'owner-1');
    await repo.register(makeManifest({ id: 'billing-guard', hooks: ['before_charge'] }), 'owner-1');

    // Attempt to fire hook before install — must throw
    const available = (await repo.findById('billing-guard'))!;
    assertThrowsName(
      () => executeHook(available, 'before_charge', { userId: 'u1' }),
      'BadRequestError',
    );

    // After install — hook fires correctly
    await repo.install('billing-guard', 'u1');
    const installed = (await repo.findById('billing-guard'))!;
    const result = executeHook(installed, 'before_charge', { userId: 'u1' });
    assert.equal(result.ok, true);
  });
});
