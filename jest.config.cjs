export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      useESM: true,
      tsconfig: {
        module: 'ESNext',
        moduleResolution: 'Bundler',
      },
    }],
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/index.ts',
  ],
  coverageThreshold: {
    global: {
      lines: 95,
      functions: 95,
      branches: 95,
      statements: 95,
    },
  },
  testMatch: ['**/tests/integration/**/*.test.ts'],
};
