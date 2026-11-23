# Quarantined tests

`jest.quarantine.json` lists Jest suites that were failing when the repository was audited
(stale mocks after refactors, merge leftovers such as undefined variables in test helpers,
specs for routers that are no longer mounted, tests requiring PostgreSQL). They are excluded
from `npm test` and CI so the signal stays trustworthy; the source files are untouched.

- Run them anyway: `JEST_RUN_QUARANTINED=1 npx jest <path>`
- When you fix a suite, delete its line from `jest.quarantine.json`.

## Running the whole quarantine

Run every listed suite in a separate Jest process with a 120-second default timeout:

```sh
npm run test:quarantine
```

Use `--filter <substring>` to run matching paths, `--timeout-ms <milliseconds>` (or
`QUARANTINE_SUITE_TIMEOUT_MS`) to change the per-suite limit, and `--json <file>` to
write a machine-readable report. The runner is informational by default; add `--strict`
to exit non-zero if any suite fails, times out, or is missing.

The proposed scheduled workflow runs this command weekly and uploads the JSON report
as an artifact, without adding the quarantined suites to the normal test job.
