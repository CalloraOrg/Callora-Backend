/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  setupFiles: ["<rootDir>/jest.env-setup.cjs"],
  testMatch: ["**/?(*.)+(spec|test).ts"],
  // Exclude tests that use Node.js native test runner
  testPathIgnorePatterns: ["/node_modules/", "event.emitter.test.ts"],
  setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],
  moduleNameMapper: {
    "^(.*/)?generated/prisma/client(\\.js)?$":
      "<rootDir>/src/test-support/prismaClient.jest.ts",
    "^(\\.{1,2}/.*)\\.js$": "$1",
    "^uuid$": "<rootDir>/src/test-support/uuid.jest.cjs",
  },
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        useESM: false,
        tsconfig: {
          module: "commonjs",
          moduleResolution: "node",
          isolatedModules: true,
        },
      },
    ],
  },
  // Transform selected ESM packages (e.g. uuid) so Jest can parse them
  transformIgnorePatterns: ["node_modules/(?!(uuid)/)"],
  // Parallel execution settings
  maxWorkers: "50%", // Use 50% of available CPU cores
  // Ensure proper cleanup between tests
  clearMocks: true,
  resetMocks: false,
  restoreMocks: true,
  // Isolate modules between test files to prevent shared state
  resetModules: false, // Keep false to avoid performance hit, rely on proper cleanup
};
