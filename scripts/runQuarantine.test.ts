import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { pathToFileURL } from 'node:url';

const runnerUrl = pathToFileURL(path.resolve('scripts/run-quarantine.mjs')).href;

function runHelper(expression: string): string {
  const source = `import * as runner from ${JSON.stringify(runnerUrl)};\nconsole.log(JSON.stringify(${expression}));`;
  return execFileSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8',
  }).trim();
}

describe('quarantine runner helpers', () => {
  it('matches path substrings and treats an empty filter as matching all suites', () => {
    expect(runHelper('runner.matchesFilter("src/lib/hopByHop.test.ts", "hopByHop")')).toBe('true');
    expect(runHelper('runner.matchesFilter("src/lib/hopByHop.test.ts", "")')).toBe('true');
    expect(runHelper('runner.matchesFilter("src/lib/hopByHop.test.ts", "missing")')).toBe('false');
  });

  it('classifies timeout results independently of the child exit code', () => {
    expect(runHelper('runner.classifyResult({ timedOut: true, exitCode: null })')).toBe('"TIMEOUT"');
    expect(runHelper('runner.classifyResult({ timedOut: false, exitCode: 0 })')).toBe('"PASS"');
    expect(runHelper('runner.classifyResult({ timedOut: false, exitCode: 1 })')).toBe('"FAIL"');
  });

  it('formats a table with one row per suite and a summary', () => {
    const report = runHelper(
      'runner.formatReport([{ suite: "one.test.ts", status: "PASS", durationMs: 15 }, { suite: "two.test.ts", status: "TIMEOUT", durationMs: 1000 }])',
    );
    expect(report).toContain('| one.test.ts | PASS    | 15ms     |');
    expect(report).toContain('| two.test.ts | TIMEOUT | 1000ms   |');
    expect(report).toContain('Summary: 1 passed, 0 failed, 1 timed out, 0 skipped (2 suites)');
  });
});
