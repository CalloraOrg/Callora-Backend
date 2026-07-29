# Error Code Catalog System

This document describes the canonical error code catalog system used in the Callora Backend.

## Overview

The error code catalog provides a single source of truth for all machine-readable error codes emitted by the backend. The system uses a YAML catalog as the authoritative source, with automatic code generation for TypeScript enums, documentation, and OpenAPI schemas.

## Architecture

### Components

1. **YAML Catalog** (`docs/error-codes.yaml`)
   - Human-readable source of truth
   - Contains code, section, and description for each error
   - Edited manually by developers

2. **TypeScript Enum** (`src/errors/codes.ts`)
   - Auto-generated from YAML
   - Provides type-safe error code constants
   - Includes JSDoc comments with descriptions

3. **Generation Script** (`scripts/generate-error-codes.mjs`)
   - Parses YAML catalog
   - Generates TypeScript enum
   - Updates markdown documentation
   - Updates OpenAPI schema

4. **CI Gate**
   - Validates catalog consistency
   - Ensures generated files are up-to-date
   - Runs in CI/CD pipeline

## YAML Catalog Format

The catalog is structured as a list of error code entries:

```yaml
error_codes:
  - code: ERROR_CODE_NAME
    section: Category Name
    description: Human-readable explanation

  - code: ANOTHER_ERROR
    section: Category Name
    description: When this error occurs
```

### Field Definitions

- **`code`** (required): Error code identifier in SCREAMING_SNAKE_CASE
- **`section`** (required): Category for documentation grouping
- **`description`** (required): Human-readable explanation of when this error occurs

### Validation Rules

1. **Code Format**: Must be SCREAMING_SNAKE_CASE (uppercase letters, numbers, underscores)
2. **Uniqueness**: No duplicate codes allowed
3. **Completeness**: All three fields (code, section, description) required
4. **Consistency**: Code value must match the enum key

## Generated Outputs

### 1. TypeScript Enum (`src/errors/codes.ts`)

```typescript
export const ErrorCode = {
  /** Human-readable description from YAML */
  ERROR_CODE_NAME: "ERROR_CODE_NAME",

  /** Another description */
  ANOTHER_ERROR: "ANOTHER_ERROR",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export function isErrorCode(value: unknown): value is ErrorCode {
  // Type guard implementation
}
```

Features:
- Const assertion for strict typing
- JSDoc comments with descriptions
- Type guard function
- Warning header about auto-generation

### 2. Markdown Documentation (`docs/error-codes.md`)

The script injects a generated table between markers:

```markdown
<!-- BEGIN GENERATED ERROR CODES -->
## Canonical error code catalog

| Code | Catalog section |
|---|---|
| `ERROR_CODE_NAME` | Category Name |
| `ANOTHER_ERROR` | Category Name |
<!-- END GENERATED ERROR CODES -->
```

### 3. OpenAPI Schema (`docs/openapi.json`)

Adds ErrorCode enum to OpenAPI components:

```json
{
  "components": {
    "schemas": {
      "ErrorCode": {
        "type": "string",
        "enum": ["ERROR_CODE_NAME", "ANOTHER_ERROR"],
        "description": "Canonical Callora backend error code."
      },
      "ErrorResponse": {
        "properties": {
          "code": {
            "$ref": "#/components/schemas/ErrorCode"
          }
        }
      }
    }
  }
}
```

## Workflows

### Adding a New Error Code

1. **Edit YAML catalog**:
   ```bash
   vim docs/error-codes.yaml
   ```

2. **Add entry**:
   ```yaml
   - code: MY_NEW_ERROR
     section: My Feature
     description: Occurs when my feature fails validation
   ```

3. **Generate code**:
   ```bash
   npm run error-codes:generate
   ```

4. **Verify changes**:
   ```bash
   git diff src/errors/codes.ts docs/error-codes.md docs/openapi.json
   ```

5. **Commit all files**:
   ```bash
   git add docs/error-codes.yaml src/errors/codes.ts docs/error-codes.md docs/openapi.json
   git commit -m "feat: add MY_NEW_ERROR code"
   ```

### Modifying an Existing Code

1. **Edit the YAML entry** (description or section only - never change the code value)
2. **Regenerate**: `npm run error-codes:generate`
3. **Commit**: Include all updated files

**WARNING**: Changing a code value is a breaking change for API clients. Deprecate the old code and add a new one instead.

### Removing a Code

1. **Deprecation first**: Mark as deprecated in description
2. **Wait for migration**: Allow time for clients to update
3. **Remove from YAML**: After deprecation period
4. **Regenerate**: `npm run error-codes:generate`

## Using Error Codes in Code

### Importing

```typescript
import { ErrorCode } from './errors/codes.js';
```

### In Error Classes

```typescript
throw new BadRequestError('Invalid input', ErrorCode.VALIDATION_ERROR);
```

### Type-Safe Checks

```typescript
if (error.code === ErrorCode.INSUFFICIENT_BALANCE) {
  // Handle insufficient balance
}
```

### Runtime Validation

```typescript
import { isErrorCode } from './errors/codes.js';

if (isErrorCode(unknownValue)) {
  // unknownValue is now typed as ErrorCode
}
```

## CI/CD Integration

### Pre-commit Hook

Add to `.git/hooks/pre-commit`:

```bash
#!/bin/bash
npm run error-codes:check || {
  echo "Error codes are out of sync. Run: npm run error-codes:generate"
  exit 1
}
```

### GitHub Actions

Add to `.github/workflows/ci.yml`:

```yaml
- name: Check error code generation
  run: npm run error-codes:check
```

### package.json Scripts

```json
{
  "scripts": {
    "error-codes:generate": "node scripts/generate-error-codes.mjs",
    "error-codes:check": "node scripts/generate-error-codes.mjs --check",
    "prebuild": "npm run error-codes:check"
  }
}
```

## Testing

### Unit Tests

Run script tests:

```bash
node scripts/generate-error-codes.test.mjs
```

### Coverage

Test scenarios:
- ✅ Valid YAML parsing
- ✅ Duplicate detection
- ✅ Format validation
- ✅ TypeScript generation
- ✅ Markdown update
- ✅ OpenAPI schema update
- ✅ Check mode validation
- ✅ Missing catalog handling
- ✅ Idempotency

### Integration Tests

```bash
# Generate and verify
npm run error-codes:generate
npm run error-codes:check # Should pass

# Modify generated file
echo "// test" >> src/errors/codes.ts
npm run error-codes:check # Should fail
```

## Migration from Legacy System

### Before (Manual TypeScript)

```typescript
// src/errors/errorCatalog.ts
export const ErrorCode = {
  // HTTP status derived
  BAD_REQUEST: "BAD_REQUEST",
  UNAUTHORIZED: "UNAUTHORIZED",
  // ... manually maintained
} as const;
```

### After (YAML + Codegen)

```yaml
# docs/error-codes.yaml
error_codes:
  - code: BAD_REQUEST
    section: HTTP status derived
    description: The request is invalid
```

Generated TypeScript is identical, but source of truth is YAML.

## Benefits

1. **Single Source of Truth**: YAML catalog is the definitive reference
2. **Type Safety**: Generated TypeScript enum provides compile-time checks
3. **Documentation**: Automatically updates docs and OpenAPI
4. **Consistency**: CI gate prevents drift between catalog and code
5. **Review**: YAML diffs are easier to review than TypeScript
6. **Validation**: Format and uniqueness checks prevent errors
7. **Maintainability**: Clear separation of data and code

## Troubleshooting

### "Duplicate error codes" Error

**Cause**: Same code appears multiple times in YAML

**Solution**: Search for duplicates and remove/rename

```bash
grep -n "code: YOUR_CODE" docs/error-codes.yaml
```

### "Invalid error code format" Error

**Cause**: Code doesn't match SCREAMING_SNAKE_CASE

**Solution**: Use only uppercase letters, numbers, and underscores

```yaml
# Bad
- code: myError
- code: My-Error
- code: my_error

# Good
- code: MY_ERROR
```

### "No error codes found" Error

**Cause**: YAML syntax error or empty catalog

**Solution**: Validate YAML syntax

```bash
# Install yamllint
pip install yamllint

# Validate
yamllint docs/error-codes.yaml
```

### Generated Files Out of Sync

**Cause**: Manual edits to generated files

**Solution**: Regenerate from YAML

```bash
npm run error-codes:generate
```

### CI Check Fails

**Cause**: Generated files not committed

**Solution**: Run generation and commit all changes

```bash
npm run error-codes:generate
git add src/errors/codes.ts docs/error-codes.md docs/openapi.json
git commit --amend --no-edit
```

## Security Considerations

1. **No Secrets in Errors**: Never include sensitive data in error descriptions
2. **Client-Safe Messages**: Descriptions may appear in client-facing documentation
3. **Stable Codes**: Error codes are part of the public API contract
4. **Audit Trail**: All changes tracked in git history

## Performance

- **Build Time**: ~50ms to parse YAML and generate files
- **Runtime**: Zero overhead - generated code is identical to hand-written
- **CI Time**: Check mode adds ~30ms to builds

## Future Enhancements

Potential improvements:
- [ ] Add i18n support for error messages
- [ ] Generate error code documentation site
- [ ] Add severity levels to catalog
- [ ] Generate Prometheus metrics labels
- [ ] Add suggested HTTP status codes to catalog
- [ ] Validate error usage in codebase

## References

- [Error Response Format](./error-codes.md) - Full error documentation
- [YAML Specification](https://yaml.org/spec/1.2.2/)
- [TypeScript Enums](https://www.typescriptlang.org/docs/handbook/enums.html)
- [OpenAPI Schema Objects](https://swagger.io/specification/#schema-object)
