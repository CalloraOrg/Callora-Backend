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
  test('registers a new plugin and returns a record with status "available"', () => {
    const repo = makeRepo();
    const manifest = makeManifest();
    const record = repo.register(manifest);

    assert.equal(record.manifest.id, 'test-plugin');
    assert.equal(record.status, 'available');
    assert.equal(record.installed_by, null);
    assert.equal(record.installed_at, null);
    assert.ok(record.created_at);
  });

  test('newly registered plugin is returned by list()', () => {
    const repo = makeRepo();
    repo.register(makeManifest({ id: 'plugin-a' }));
    repo.register(makeManifest({ id: 'plugin-b' }));

    const list = repo.list();
    assert.equal(list.length, 2);
    assert.ok(list.some((r) => r.manifest.id === 'plugin-a'));
    assert.ok(list.some((r) => r.manifest.id === 'plugin-b'));
  });

  test('findById returns the registered plugin', () => {
    const repo = makeRepo();
    repo.register(makeManifest({ id: 'find-me' }));
    const found = repo.findById('find-me');
    assert.ok(found);
    assert.equal(found.manifest.id, 'find-me');
  });

  test('findById returns undefined for unknown id', () => {
    const repo = makeRepo();
    const found = repo.findById('does-not-exist');
    assert.equal(found, undefined);
  });

  test('throws ConflictError when registering a duplicate id', () => {
    const repo = makeRepo();
    repo.register(makeManifest({ id: 'dup-plugin' }));
    assertThrowsName(
      () => repo.register(makeManifest({ id: 'dup-plugin' })),
      'ConflictError',
      'dup-plugin',
    );
  });

  test('created_at is a valid ISO-8601 string', () => {
    const repo = makeRepo();
    const record = repo.register(makeManifest());
    assert.ok(!isNaN(Date.parse(record.created_at)), 'created_at should be valid ISO-8601');
  });

  test('list() returns empty array when no plugins are registered', () => {
    const repo = makeRepo();
    assert.deepEqual(repo.list(), []);
  });
});

// ---------------------------------------------------------------------------
// InMemoryPluginRepository — install
// ---------------------------------------------------------------------------

describe('InMemoryPluginRepository.install', () => {
  test('transitions plugin status from "available" to "installed"', () => {
    const repo = makeRepo();
    repo.register(makeManifest({ id: 'installable' }));
    const record = repo.install('installable', 'user-1');

    assert.equal(record.status, 'installed');
    assert.equal(record.installed_by, 'user-1');
    assert.ok(record.installed_at);
    assert.ok(!isNaN(Date.parse(record.installed_at!)));
  });

  test('installed_at is a valid ISO-8601 timestamp', () => {
    const repo = makeRepo();
    repo.register(makeManifest({ id: 'ts-check' }));
    const record = repo.install('ts-check', 'user-x');
    assert.ok(record.installed_at);
    assert.ok(!isNaN(Date.parse(record.installed_at)));
  });

  test('throws NotFoundError when installing a non-existent plugin', () => {
    const repo = makeRepo();
    assertThrowsName(() => repo.install('ghost-plugin', 'user-1'), 'NotFoundError', 'ghost-plugin');
  });

  test('throws ConflictError when installing an already-installed plugin', () => {
    const repo = makeRepo();
    repo.register(makeManifest({ id: 'already-installed' }));
    repo.install('already-installed', 'user-1');
    assertThrowsName(
      () => repo.install('already-installed', 'user-2'),
      'ConflictError',
    );
  });

  test('state persists — findById reflects installed status after install', () => {
    const repo = makeRepo();
    repo.register(makeManifest({ id: 'persistent' }));
    repo.install('persistent', 'user-99');

    const found = repo.findById('persistent')!;
    assert.equal(found.status, 'installed');
    assert.equal(found.installed_by, 'user-99');
  });
});

// ---------------------------------------------------------------------------
// InMemoryPluginRepository — uninstall
// ---------------------------------------------------------------------------

describe('InMemoryPluginRepository.uninstall', () => {
  test('transitions plugin status back to "available" after uninstall', () => {
    const repo = makeRepo();
    repo.register(makeManifest({ id: 'revert-me' }));
    repo.install('revert-me', 'user-1');
    const record = repo.uninstall('revert-me', 'user-1');

    assert.equal(record.status, 'available');
    assert.equal(record.installed_at, null);
  });

  test('uninstalled plugin is re-installable', () => {
    const repo = makeRepo();
    repo.register(makeManifest({ id: 'reinstallable' }));
    repo.install('reinstallable', 'user-1');
    repo.uninstall('reinstallable', 'user-1');
    const reinstalled = repo.install('reinstallable', 'user-2');

    assert.equal(reinstalled.status, 'installed');
    assert.equal(reinstalled.installed_by, 'user-2');
  });

  test('throws NotFoundError when uninstalling a non-existent plugin', () => {
    const repo = makeRepo();
    assertThrowsName(() => repo.uninstall('phantom', 'user-1'), 'NotFoundError');
  });

  test('throws BadRequestError when uninstalling a plugin that is not installed', () => {
    const repo = makeRepo();
    repo.register(makeManifest({ id: 'not-installed' }));
    assertThrowsName(
      () => repo.uninstall('not-installed', 'user-1'),
      'BadRequestError',
      'not-installed',
    );
  });

  test('findById reflects "available" status after uninstall', () => {
    const repo = makeRepo();
    repo.register(makeManifest({ id: 'state-check' }));
    repo.install('state-check', 'user-1');
    repo.uninstall('state-check', 'user-1');

    const found = repo.findById('state-check')!;
    assert.equal(found.status, 'available');
    assert.equal(found.installed_at, null);
  });
});

// ---------------------------------------------------------------------------
// InMemoryPluginRepository — delete
// ---------------------------------------------------------------------------

describe('InMemoryPluginRepository.delete', () => {
  test('removes plugin from the registry', () => {
    const repo = makeRepo();
    repo.register(makeManifest({ id: 'delete-me' }));
    repo.delete('delete-me');

    assert.equal(repo.findById('delete-me'), undefined);
    assert.equal(repo.list().length, 0);
  });

  test('throws NotFoundError when deleting a non-existent plugin', () => {
    const repo = makeRepo();
    assertThrowsName(() => repo.delete('nowhere'), 'NotFoundError');
  });

  test('cannot delete the same plugin twice', () => {
    const repo = makeRepo();
    repo.register(makeManifest({ id: 'once-only' }));
    repo.delete('once-only');
    assertThrowsName(() => repo.delete('once-only'), 'NotFoundError');
  });

  test('deleting one plugin does not affect others', () => {
    const repo = makeRepo();
    repo.register(makeManifest({ id: 'keep-me' }));
    repo.register(makeManifest({ id: 'remove-me' }));
    repo.delete('remove-me');

    const list = repo.list();
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

  test('executeHook succeeds for installed plugin and fails after uninstall', () => {
    const repo = makeRepo();
    repo.register(makeManifest({ id: 'lifecycle-plugin', hooks: ['before_charge'] }));
    repo.install('lifecycle-plugin', 'user-1');

    // Succeeds while installed
    const installed = repo.findById('lifecycle-plugin')!;
    const result = executeHook(installed, 'before_charge', { userId: 'user-1' });
    assert.equal(result.ok, true);

    // Uninstall and hook should now throw
    repo.uninstall('lifecycle-plugin', 'user-1');
    const uninstalled = repo.findById('lifecycle-plugin')!;
    assertThrowsName(
      () => executeHook(uninstalled, 'before_charge', { userId: 'user-1' }),
      'BadRequestError',
    );
  });

  test('executeHook succeeds after re-install following uninstall', () => {
    const repo = makeRepo();
    repo.register(makeManifest({ id: 'reinstall-hook', hooks: ['after_charge'] }));
    repo.install('reinstall-hook', 'user-a');
    repo.uninstall('reinstall-hook', 'user-a');
    repo.install('reinstall-hook', 'user-b');

    const record = repo.findById('reinstall-hook')!;
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
  test('register → install → uninstall → re-install cycle', () => {
    const repo = makeRepo();

    // 1. Register
    const registered = repo.register(makeManifest({ id: 'full-cycle' }));
    assert.equal(registered.status, 'available');

    // 2. Install
    const installed = repo.install('full-cycle', 'user-a');
    assert.equal(installed.status, 'installed');

    // 3. Uninstall
    const uninstalled = repo.uninstall('full-cycle', 'user-a');
    assert.equal(uninstalled.status, 'available');
    assert.equal(uninstalled.installed_at, null);

    // 4. Re-install by a different user
    const reinstalled = repo.install('full-cycle', 'user-b');
    assert.equal(reinstalled.status, 'installed');
    assert.equal(reinstalled.installed_by, 'user-b');
  });

  test('register → delete — subsequent operations throw NotFoundError', () => {
    const repo = makeRepo();
    repo.register(makeManifest({ id: 'deletable' }));
    repo.delete('deletable');

    assertThrowsName(() => repo.install('deletable', 'u1'), 'NotFoundError');
    assertThrowsName(() => repo.delete('deletable'), 'NotFoundError');
  });

  test('multiple plugins are independently tracked', () => {
    const repo = makeRepo();
    repo.register(makeManifest({ id: 'plugin-x', hooks: ['before_charge'] }));
    repo.register(makeManifest({ id: 'plugin-y', hooks: ['on_refund'] }));

    repo.install('plugin-x', 'user-1');
    // plugin-y remains available

    const x = repo.findById('plugin-x')!;
    const y = repo.findById('plugin-y')!;
    assert.equal(x.status, 'installed');
    assert.equal(y.status, 'available');
  });

  test('before_charge hook is guarded: only fires when plugin is installed', () => {
    // Simulates the billing route concern: uninstalled plugins cannot hook billing
    const repo = makeRepo();
    repo.register(makeManifest({ id: 'billing-guard', hooks: ['before_charge'] }));

    // Attempt to fire hook before install — must throw
    const available = repo.findById('billing-guard')!;
    assertThrowsName(
      () => executeHook(available, 'before_charge', { userId: 'u1' }),
      'BadRequestError',
    );

    // After install — hook fires correctly
    repo.install('billing-guard', 'u1');
    const installed = repo.findById('billing-guard')!;
    const result = executeHook(installed, 'before_charge', { userId: 'u1' });
    assert.equal(result.ok, true);
  });
});
