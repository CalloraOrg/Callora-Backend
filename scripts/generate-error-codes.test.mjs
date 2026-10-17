/**
 * Tests for error code generation script
 *
 * Run with: node --test scripts/generate-error-codes.test.mjs
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
function test(name, fn) {
  tests.push({ name, fn });
}

const tests = [];

// Test 1: Parse valid YAML catalog
test("parses valid YAML catalog with all fields", () => {
  createTestEnv();
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
  writeTestOpenApi();

  const yaml = `	e
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

// Test 5: Generate markdown catalogue at docs/error-code-catalog.md
test("generates markdown catalogue at docs/error-code-catalog.md", () => {
  createTestEnv();
  writeTestOpenApi();

  const yaml = `
error_codes:
  - code: DOC_TEST_ERROR
    section: Documentation Test
    description: Test error for docs

  - code: DOC_TEST_ERROR_TWO
    section: Documentation Test
    description: Second test error for docs
`;

  writeTestYaml(yaml);
  const result = runCodegen();

  assert.strictEqual(result.success, true, "Should succeed");

  const catalogPath = path.join(testDir, "docs", "error-code-catalog.md");
  assert.ok(fs.existsSync(catalogPath), "Markdown catalogue should exist");

  const catalog = fs.readFileSync(catalogPath, "utf8");

  assert.ok(
    catalog.includes("AUTO-GENERATED"),
    "Should include auto-generated notice"
  );
  assert.ok(
    catalog.includes("DO NOT EDIT MANUALLY"),
    "Should include edit warning"
  );
  assert.ok(
    catalog.includes("docs/error-codes.yaml"),
    "Should reference the YAML source"
  );
  assert.ok(catalog.includes("DOC_TEST_ERROR"), "Should include error code");
  assert.ok(
    catalog.includes("DOC_TEST_ERROR_TWO"),
    "Should include second error code"
  );
  assert.ok(
    catalog.includes("Documentation Test"),
    "Should include section"
  );
  assert.ok(
    catalog.includes("Test error for docs"),
    "Should include description"
  );
  assert.ok(
    catalog.includes("| Code | Catalog section | Description |"),
    "Should include table header"
  );

  cleanupTestEnv();
});

// Test 6: Update OpenAPI schema
test("updates OpenAPI schema with error codes", () => {
  createTestEnv();
  writeTestOpenApi();

  const yaml = `	e
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

// Test 7: Check mode detects outdated generated files
test("check mode detects outdated generated files", () => {
  createTestEnv();
  writeTestOpenApi();

  const yaml = `	e
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

// Test 8: Check mode detects stale markdown catalogue
test("check mode detects stale markdown catalogue", () => {
  createTestEnv();
  writeTestOpenApi();

  const yaml = `
error_codes:
  - code: STALE_MARKDOWN_TEST
    section: Stale Markdown
    description: Test for stale markdown detection
`;

  writeTestYaml(yaml);

  // Generate once
  runCodegen();

  // Modify the generated markdown catalogue
  const catalogPath = path.join(testDir, "docs", "error-code-catalog.md");
  fs.appendFileSync(catalogPath, "\n## Manual addition\n");

  // Run in check mode
  const script = path.join(root, "scripts", "generate-error-codes.mjs");
  try {
    execSync(`node "${script}" --check`, {
      cwd: testDir,
      encoding: "utf8",
      stdio: "pipe",
    });
    assert.fail("Check mode should have failed on stale markdown");
  } catch (error) {
    assert.ok(error.status !== 0, "Should exit with non-zero code");
  }

  cleanupTestEnv();
});

// Test 9: Handle missing YAML catalog
test("handles missing YAML catalog gracefully", () => {
  createTestEnv();
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

// Test 10: Validate required fields in YAML entries
test("validates required fields in YAML entries", () => {
  createTestEnv();
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

// Test 11: Idempotency - running twice produces same output
test("running generation twice produces identical output", () => {
  createTestEnv();
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
  const firstCodes = fs.readFileSync(
    path.join(testDir, "src", "errors", "codes.ts"),
    "utf8"
  );
  const firstCatalog = fs.readFileSync(
    path.join(testDir, "docs", "error-code-catalog.md"),
    "utf8"
  );

  // Second run
  runCodegen();
  const secondCodes = fs.readFileSync(
    path.join(testDir, "src", "errors", "codes.ts"),
    "utf8"
  );
  const secondCatalog = fs.readFileSync(
    path.join(testDir, "docs", "error-code-catalog.md"),
    "utf8"
  );

  assert.strictEqual(firstCodes, secondCodes, "TypeScript output should be identical");
  assert.strictEqual(firstCatalog, secondCatalog, "Markdown output should be identical");

  cleanupTestEnv();
});

// Test 12: Check mode fails when legacy hand-written docs exists
test("check mode fails when legacy hand-written docs exist", () => {
  createTestEnv();
  writeTestOpenApi();

  const yaml = `
error_codes:
  - code: LEGACY_DOCS_TEST
    section: Legacy Docs
    description: Test for legacy docs detection
`;

  writeTestYaml(yaml);

  // Generate once so generated files are up to date
  runCodegen();

  // Create the legacy hand-written duplicate
  fs.writeFileSync(
    path.join(testDir, "docs", "error-codes.md"),
    "# Error Codes\n\nLegacy hand-written duplicate.\n"
  );

  // Run in check mode
  const script = path.join(root, "scripts", "generate-error-codes.mjs");
  try {
    execSync(`node "${script}" --check`, {
      cwd: testDir,
      encoding: "utf8",
      stdio: "pipe",
    });
    assert.fail("Check mode should have failed when legacy docs exist");
  } catch (error) {
    assert.ok(error.status !== 0, "Should exit with non-zero code");
  }

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
