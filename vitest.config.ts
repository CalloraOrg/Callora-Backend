import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration.
 *
 * This project runs its tests through Jest (see package.json and
 * jest.config.js). The `vitest` dependency and this config are only
 * kept for the optional `coverage:repos` script, which uses Vitest's v9
 * coverage provider to enforce the 95% minimum coverage threshold for
 * `src/repositories/**`. The main test suites (`test`, `test:unit`,
 * `test:integration`, `test:coverage`) are run with Jest and do not
 * use this file.
 *
 * See README.md > Testing for prerequisites and how to run each
 * script.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/repositories/**/*.ts'],
      // Enforce the 95% minimum coverage requirement for repos
      thresholds: {
        statements: 95,
        branches: 95,
        functions: 95,
        lines: 95,
      },
    },
  },
});
