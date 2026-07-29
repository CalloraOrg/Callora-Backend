/**
 * Tests for error code generation script
 *
 * Run with: node scripts/generate-error-codes.test.mjs
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const testDir = path.join(root, "test-temp-error-codes");

// Test utilities
function createTestEnv() {
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
  fs.mkdirSync(testDir, { recursive: true });
  fs.mkdirSync(path.join(testDir, "docs"), { recursive: true });
  fs.mkdirSync(path.join(testDir, "src", "errors"), { recursive: true });
}

function cleanupTestEnv() {
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

function writeTestYaml(content) {
  fs.writeFileSync(path.join(testDir, "docs", "error-codes.yaml"), content);
}

function writeTestDocs() {
  fs.writeFileSync(
    path.join(testDir, "docs", "error-codes.md"),
    "# Error Codes\n\nTest doc\n"
  );
}

function writeTestOpenApi() {
  const openApi = {
    openapi: "3.0.0",
    info: { title: "Test API", version: "1.0.0" },
    components: {
      schemas: {
        ErrorResponse: {
          type: "object",
          properties: {
            code: { type: "string" },
            message: { type: "string" },
          },
        },
      },
    },
  };
  fs.writeFileSync(
    path.join(testDir, "docs", "openapi.json"),
    JSON.stringify(openApi, null, 2)
  );
}

function runCodegen(cwd = testDir) {
  const script = path.join(root, "scripts", "generate-error-codes.mjs");
  try {
    execSync(`node "${script}"`, {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
    });
    return { success: true, error: null };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Tests
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

// Test 1: Parse valid YAML catalog
test("parses valid YAML catalog with all fields", () => {
  createTestEnv();
  writeTestDocs();
  writeTestOpenApi();

  const yaml = `
error_codes:
  - code: TEST_ERROR_ONE
    section: Test Section
    description: Test description one

  - code: TEST_ERROR_TWO
    section: Test Section
    description: Test description two
`;

  writeTestYaml(yaml);
  const result = runCodegen();

  assert.strictEqual(result.success, true, "Should succeed");

  const generated = fs.readFileSync(
    path.join(testDir, "src", "errors", "codes.ts"),
    "utf8"
  );

  assert.ok(generated.includes("TEST_ERROR_ONE"), "Should include TEST_ERROR_ONE");
  assert.ok(generated.includes("TEST_ERROR_TWO"), "Should include TEST_ERROR_TWO");
  assert.ok(
    generated.includes("Test description one"),
    "Should include description"
  );

  cleanupTestEnv();
});

// Test 2: Reject duplicate error codes
test("rejects duplicate error codes", () => {
  createTestEnv();
  writeTestDocs();
  writeTestOpenApi();

  const yaml = `
error_codes:
  - code: DUPLICATE_CODE
    section: Test Section
    description: First occurrence

  - code: DUPLICATE_CODE
    section: Test Section
    description: Second occurrence
`;

  writeTestYaml(yaml);
  const result = runCodegen();

  assert.strictEqual(result.success, false, "Should fail on duplicates");
  assert.ok(
    result.error.includes("Duplicate"),
    "Error should mention duplicates"
  );

  cleanupTestEnv();
});

// Test 3: Validate code format (SCREAMING_SNAKE_CASE)
test("validates error code format", () => {
  createTestEnv();
  writeTestDocs();
  writeTestOpenApi();

  const yaml = `
error_codes:
  - code: invalidCode
    section: Test Section
    description: Invalid format
`;

  writeTestYaml(yaml);
  const result = runCodegen();

  assert.strictEqual(result.success, false, "Should fail on invalid format");
  assert.ok(
    result.error.includes("SCREAMING_SNAKE_CASE") || result.error.includes("Invalid"),
    "Error should mention format requirement"
  );

  cleanupTestEnv();
});

// Test 4: Generate TypeScript with correct structure
test("generates TypeScript enum with correct structure", () => {
  createTestEnv();
  writeTestDocs();
  writeTestOpenApi();

  const yaml = `
error_codes:
  - code: SAMPLE_ERROR
    section: Sample
    description: A sample error for testing
`;

  writeTestYaml(yaml);
  const result = runCodegen();

  assert.strictEqual(result.success, true, "Should succeed");

  const generated = fs.readFileSync(
    path.join(testDir, "src", "errors", "codes.ts"),
    "utf8"
  );

  // Check structure
  assert.ok(generated.includes("export const ErrorCode ="), "Should export ErrorCode");
  assert.ok(generated.includes('SAMPLE_ERROR: "SAMPLE_ERROR"'), "Should include code entry");
  assert.ok(generated.includes("} as const;"), "Should use as const");
  assert.ok(
    generated.includes("export type ErrorCode"),
    "Should export type"
  );
  assert.ok(
    generated.includes("export function isErrorCode"),
    "Should export type guard"
  );
  assert.ok(
    generated.includes("AUTO-GENERATED"),
    "Should include generation notice"
  );
  assert.ok(
    generated.includes("DO NOT EDIT"),
    "Should include edit warning"
  );

  cleanupTestEnv();
});

// Test 5: Update documentation
test("updates markdown documentation", () => {
  createTestEnv();
  writeTestDocs();
  writeTestOpenApi();

  const yaml = `
error_codes:
  - code: DOC_TEST_ERROR
    section: Documentation Test
    description: Test error for docs
`;

  writeTestYaml(yaml);
  const result = runCodegen();

  assert.strictEqual(result.success, true, "Should succeed");

  const docs = fs.readFileSync(
    path.join(testDir, "docs", "error-codes.md"),
    "utf8"
  );

  assert.ok(
    docs.includes("<!-- BEGIN GENERATED ERROR CODES -->"),
    "Should have start marker"
  );
  assert.ok(
    docs.includes("<!-- END GENERATED ERROR CODES -->"),
    "Should have end marker"
  );
  assert.ok(
    docs.includes("DOC_TEST_ERROR"),
    "Should include error code"
  );
  assert.ok(
    docs.includes("Documentation Test"),
    "Should include section"
  );

  cleanupTestEnv();
});

// Test 6: Update OpenAPI schema
test("updates OpenAPI schema with error codes", () => {
  createTestEnv();
  writeTestDocs();
  writeTestOpenApi();

  const yaml = `
error_codes:
  - code: API_TEST_ERROR
    section: API Test
    description: Test error for OpenAPI
`;

  writeTestYaml(yaml);
  const result = runCodegen();

  assert.strictEqual(result.success, true, "Should succeed");

  const openApi = JSON.parse(
    fs.readFileSync(path.join(testDir, "docs", "openapi.json"), "utf8")
  );

  assert.ok(
    openApi.components.schemas.ErrorCode,
    "Should create ErrorCode schema"
  );
  assert.strictEqual(
    openApi.components.schemas.ErrorCode.type,
    "string",
    "ErrorCode should be string type"
  );
  assert.ok(
    Array.isArray(openApi.components.schemas.ErrorCode.enum),
    "ErrorCode should have enum"
  );
  assert.ok(
    openApi.components.schemas.ErrorCode.enum.includes("API_TEST_ERROR"),
    "Enum should include test error"
  );

  cleanupTestEnv();
});

// Test 7: Check mode detects outdated files
test("check mode detects outdated generated files", () => {
  createTestEnv();
  writeTestDocs();
  writeTestOpenApi();

  const yaml = `
error_codes:
  - code: CHECK_MODE_TEST
    section: Check Mode
    description: Test for check mode
`;

  writeTestYaml(yaml);

  // Generate once
  runCodegen();

  // Modify the generated file
  const generatedPath = path.join(testDir, "src", "errors", "codes.ts");
  fs.appendFileSync(generatedPath, "\n// Manual modification\n");

  // Run in check mode
  const script = path.join(root, "scripts", "generate-error-codes.mjs");
  try {
    execSync(`node "${script}" --check`, {
      cwd: testDir,
      encoding: "utf8",
      stdio: "pipe",
    });
    assert.fail("Check mode should have failed");
  } catch (error) {
    assert.ok(error.status !== 0, "Should exit with non-zero code");
  }

  cleanupTestEnv();
});

// Test 8: Handle missing YAML catalog
test("handles missing YAML catalog gracefully", () => {
  createTestEnv();
  writeTestDocs();
  writeTestOpenApi();

  // Don't create the YAML file
  const result = runCodegen();

  assert.strictEqual(result.success, false, "Should fail");
  assert.ok(
    result.error.includes("catalog") || result.error.includes("found"),
    "Error should mention missing catalog"
  );

  cleanupTestEnv();
});

// Test 9: Validate required fields
test("validates required fields in YAML entries", () => {
  createTestEnv();
  writeTestDocs();
  writeTestOpenApi();

  const yaml = `
error_codes:
  - code: VALID_CODE
    section: Valid
    description: Has all fields

  - section: Missing Code
    description: This entry lacks a code field
`;

  writeTestYaml(yaml);
  const result = runCodegen();

  // Should still parse the valid entry
  assert.strictEqual(result.success, true, "Should succeed with valid entries");

  const generated = fs.readFileSync(
    path.join(testDir, "src", "errors", "codes.ts"),
    "utf8"
  );

  assert.ok(generated.includes("VALID_CODE"), "Should include valid code");

  cleanupTestEnv();
});

// Test 10: Idempotency - running twice produces same output
test("running generation twice produces identical output", () => {
  createTestEnv();
  writeTestDocs();
  writeTestOpenApi();

  const yaml = `
error_codes:
  - code: IDEMPOTENT_ERROR
    section: Idempotency
    description: Test idempotency
`;

  writeTestYaml(yaml);

  // First run
  runCodegen();
  const firstRun = fs.readFileSync(
    path.join(testDir, "src", "errors", "codes.ts"),
    "utf8"
  );

  // Second run
  runCodegen();
  const secondRun = fs.readFileSync(
    path.join(testDir, "src", "errors", "codes.ts"),
    "utf8"
  );

  assert.strictEqual(firstRun, secondRun, "Output should be identical");

  cleanupTestEnv();
});

// Run all tests
console.log("Running error code generation tests...\n");

let passed = 0;
let failed = 0;

for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (error) {
    console.error(`✗ ${name}`);
    console.error(`  ${error.message}`);
    if (error.stack) {
      console.error(error.stack.split("\n").slice(1, 4).join("\n"));
    }
    failed++;
  }
}

console.log(`\n${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}
