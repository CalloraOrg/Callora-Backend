/// <reference types="jest" />
/**
 * Documentation consistency guard for graceful shutdown.
 *
 * `docs/graceful-shutdown.md` previously claimed that quotas, proxy,
 * refresh-token and "workers" were all drained, but `shutdownSubsystems` in
 * `src/index.ts` only registered a subset of them. Operators size
 * `terminationGracePeriodSeconds` from that document, so silently drifting away
 * from the code is a production-visible defect.
 *
 * These tests parse the real wiring out of `src/index.ts` (as text — the entry
 * point is not imported so this suite stays independent of app startup) and
 * fail when the document, the handler contract, or the README disagree with it.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const repoRoot = join(__dirname, '..', '..');

const read = (relativePath: string): string =>
  readFileSync(join(repoRoot, relativePath), 'utf8');

const INDEX_SOURCE = read('src/index.ts');
const SHUTDOWN_SOURCE = read('src/lifecycle/shutdown.ts');
const DOC_SOURCE = read('docs/graceful-shutdown.md');
const README_SOURCE = read('README.md');

/** Splits a comma separated expression on commas that are not nested. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';

  for (const char of text) {
    if ('{[('.includes(char)) {
      depth += 1;
    } else if ('}])'.includes(char)) {
      depth -= 1;
    }

    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  parts.push(current);

  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/** Maps every `createInFlightDrainTracker` variable to its registered name. */
function drainTrackerNames(source: string): Map<string, string> {
  const names = new Map<string, string>();
  const pattern =
    /(?:const|let)\s+(\w+)\s*=\s*createInFlightDrainTracker\(\s*['"]([^'"]+)['"]\s*\)/g;

  for (const match of source.matchAll(pattern)) {
    names.set(match[1], match[2]);
  }

  return names;
}

/** Returns the raw source of the `shutdownSubsystems` initializer. */
function shutdownSubsystemsInitializer(source: string): string {
  const declarationIndex = source.indexOf(
    'shutdownSubsystems: DrainableSubsystem[] =',
  );
  if (declarationIndex === -1) {
    throw new Error(
      'Could not find `shutdownSubsystems: DrainableSubsystem[] =` in src/index.ts',
    );
  }

  // Start after the `=` so the empty brackets of the `DrainableSubsystem[]`
  // type annotation are not mistaken for the array literal.
  const assignmentIndex = source.indexOf('=', declarationIndex);
  const start = source.indexOf('[', assignmentIndex);
  if (assignmentIndex === -1 || start === -1) {
    throw new Error('Could not find the shutdownSubsystems array literal');
  }

  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === '[') {
      depth += 1;
    } else if (char === ']') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start + 1, index);
      }
    }
  }

  throw new Error('Unterminated shutdownSubsystems array literal');
}

/**
 * Resolves the subsystem names registered with the shutdown handler, in the
 * order the handler will stop them.
 *
 * Covers both the array literal and any `shutdownSubsystems.push(...)` calls
 * that might be added later.
 */
function registeredSubsystemNames(source: string): string[] {
  const trackerNames = drainTrackerNames(source);
  const entries: string[] = splitTopLevel(shutdownSubsystemsInitializer(source));

  for (const match of source.matchAll(
    /shutdownSubsystems\.push\(\s*(\{[\s\S]*?\})\s*\)/g,
  )) {
    entries.push(match[1]);
  }

  return entries.map((entry) => {
    const tracker = entry.match(/(\w+)\.subsystem\b/);
    if (tracker) {
      const name = trackerNames.get(tracker[1]);
      if (!name) {
        throw new Error(
          `shutdownSubsystems references ${tracker[1]}.subsystem, but no createInFlightDrainTracker("${tracker[1]}") declaration was found`,
        );
      }
      return name;
    }

    const named = entry.match(/name:\s*['"]([^'"]+)['"]/);
    if (!named) {
      throw new Error(`Unparseable shutdownSubsystems entry: ${entry}`);
    }

    return named[1];
  });
}

/** Reads the canonical ordered subsystem list out of the documentation. */
function documentedSubsystemNames(): string[] {
  const block = DOC_SOURCE.match(
    /<!--\s*shutdown-subsystem-order:start\s*-->([\s\S]*?)<!--\s*shutdown-subsystem-order:end\s*-->/,
  );

  if (!block) {
    throw new Error(
      'docs/graceful-shutdown.md is missing the `shutdown-subsystem-order` block',
    );
  }

  const names = [...block[1].matchAll(/^\s*\d+\.\s+([\w-]+)\s*$/gm)].map(
    (match) => match[1],
  );

  if (names.length === 0) {
    throw new Error('The documented shutdown subsystem list is empty');
  }

  return names;
}

/** Variables whose `beginShutdown()` is invoked by the shutdown wiring. */
function drainedJobVariables(source: string): Set<string> {
  const variables = new Set<string>();
  for (const match of source.matchAll(/(\w+)\.beginShutdown\(\)/g)) {
    variables.add(match[1]);
  }
  return variables;
}

/** Variables whose `stop()` is invoked by `closeAllDataResources`. */
function stoppedJobVariables(source: string): string[] {
  const variables: string[] = [];
  for (const match of source.matchAll(/(\w+)\??\.stop\(\)/g)) {
    if (!variables.includes(match[1])) {
      variables.push(match[1]);
    }
  }
  return variables;
}

/** `settlementStatusSyncJob` -> `settlement-status-sync` */
function toJobLabel(variable: string): string {
  return variable
    .replace(/(Job|Worker)$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase();
}

describe('graceful shutdown documentation', () => {
  describe('registered subsystems', () => {
    it('documents exactly the subsystems registered in src/index.ts, in order', () => {
      expect(documentedSubsystemNames()).toEqual(registeredSubsystemNames(INDEX_SOURCE));
    });

    it('registers each subsystem once', () => {
      const registered = registeredSubsystemNames(INDEX_SOURCE);
      expect(new Set(registered).size).toBe(registered.length);
      expect(new Set(documentedSubsystemNames()).size).toBe(registered.length);
    });

    it('keeps every registered subsystem name in the document body', () => {
      for (const name of registeredSubsystemNames(INDEX_SOURCE)) {
        expect(DOC_SOURCE).toContain(`\`${name}\``);
      }
    });
  });

  describe('intentionally undrained jobs', () => {
    const drained = drainedJobVariables(INDEX_SOURCE);
    const stoppedOnly = stoppedJobVariables(INDEX_SOURCE).filter(
      (variable) => !drained.has(variable),
    );

    it('finds jobs that are stopped but never drained', () => {
      // Guards the guard: if this becomes empty the assertions below would
      // silently pass without checking anything.
      expect(stoppedOnly.length).toBeGreaterThan(0);
    });

    it('explains every job that is stopped without being drained', () => {
      for (const variable of stoppedOnly) {
        expect(DOC_SOURCE).toContain(`\`${toJobLabel(variable)}\``);
      }
    });

    it('states that undrained jobs are cancelled after the drain window', () => {
      expect(DOC_SOURCE).toMatch(/cancelled, not drained/i);
      expect(DOC_SOURCE).toMatch(/after\s+the\s+drain window/i);
    });

    it('names the trackers that are not wired into shutdownSubsystems', () => {
      expect(DOC_SOURCE).toContain('`api-keys`');
      expect(DOC_SOURCE).toContain('`quotas`');
    });
  });

  describe('timeout', () => {
    it('uses the 30 s default documented by the handler tests', () => {
      expect(SHUTDOWN_SOURCE).toMatch(/timeoutMs\s*=\s*30_000/);
    });

    it('wires 30_000 ms from src/index.ts', () => {
      expect(INDEX_SOURCE).toMatch(/timeoutMs:\s*30_000/);
    });

    it('documents the same timeout value', () => {
      expect(DOC_SOURCE).toMatch(/timeoutMs/);
      expect(DOC_SOURCE).toContain('30_000');
    });
  });

  describe('exit codes', () => {
    const codeExitCodes = new Set(
      [...SHUTDOWN_SOURCE.matchAll(/exitCode\s*=\s*(\d+)/g)].map((match) => match[1]),
    );
    const documentedExitCodes = new Set(
      [...DOC_SOURCE.matchAll(/\|\s*`(\d+)`\s*\|/g)].map((match) => match[1]),
    );

    it('resolves only 0 and 1 from the handler', () => {
      expect([...codeExitCodes].sort()).toEqual(['0', '1']);
    });

    it('documents exactly those exit codes', () => {
      expect([...documentedExitCodes].sort()).toEqual([...codeExitCodes].sort());
    });

    it('explains what each exit code means', () => {
      expect(DOC_SOURCE).toMatch(/clean shutdown/i);
      expect(DOC_SOURCE).toMatch(/Errors?|failed|threw/i);
    });
  });

  describe('README', () => {
    it('references the graceful shutdown document', () => {
      expect(README_SOURCE).toContain('docs/graceful-shutdown.md');
    });

    it('documents the shutdown expectations section', () => {
      expect(README_SOURCE).toContain('## Production Shutdown Expectations');
    });

    it('lists the registered subsystems it promises to drain', () => {
      const section = README_SOURCE.split('## Production Shutdown Expectations')[1]
        ?.split('\n## ')[0];
      expect(section).toBeDefined();

      for (const name of registeredSubsystemNames(INDEX_SOURCE)) {
        expect(section).toContain(`\`${name}\``);
      }
    });
  });
});
