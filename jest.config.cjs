/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/?(*.)+(spec|test).ts'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        // Use a separate tsconfig for tests that targets CommonJS so Jest's
        // CJS runtime can execute the compiled output. The production tsconfig
        // keeps "module": "NodeNext" for the actual build.
        tsconfig: './tsconfig.test.json',
      },
    ],
  },
  // Strip .js extensions from imports so Jest resolves TypeScript source files.
  // Required because the source uses NodeNext-style explicit extensions.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
