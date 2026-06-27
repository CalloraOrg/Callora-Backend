/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/?(*.)+(spec|test).ts"],
  testPathIgnorePatterns: ["/node_modules/"],
  // Strip .js extensions from imports so Jest's CommonJS resolver can find
  // the TypeScript source files (ESM-style imports end with .js but Jest
  // needs the extensionless path to locate the .ts file via ts-jest).
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        tsconfig: {
          module: "commonjs",
          moduleResolution: "node16",
          isolatedModules: true,
        },
      },
    ],
  },
};