# Schema Drift Audit & Fixes

This document outlines the schema drift issues identified in the Callora-Backend project and provides fixes to ensure data integrity and consistency.

## Issues Identified

### 🚨 Critical Issues

1. **Multiple ORM Systems**: The project uses both Drizzle (SQLite) and Prisma (PostgreSQL) with completely different schemas
2. **Database Provider Mismatch**: Drizzle configured for SQLite, Prisma for PostgreSQL
3. **Entity Definition Conflicts**: 
   - Drizzle has: `developers`, `apis`, `apiEndpoints`
   - Prisma has: only `User` with `stellar_address`
4. **Unused Configuration**: Prisma client initialized but not actively used in main application flow

### ⚠️ Configuration Issues

1. **Multiple Database Connection Patterns**: SQLite (Drizzle), PostgreSQL (pg pool), and Prisma connections
2. **Migration Gaps**: Schema entities exist without corresponding migrations
3. **Type Safety Gaps**: Missing type exports for some entities

## Fixes Applied

### 1. Schema Drift Detection Tests

Created comprehensive tests in `src/__tests__/schema-drift.test.ts` that:
- Detect ORM configuration conflicts
- Validate entity consistency across schemas
- Check for unused imports and connection patterns
- Verify migration and type safety consistency

### 2. Validation Script

Added `scripts/schema-drift-validator.mjs` to:
- Automatically detect schema drift issues
- Provide detailed reports with recommendations
- Exit with error codes for CI/CD integration

### 3. Consolidation Script

Added `scripts/consolidate-schema.mjs` to:
- Safely remove unused Prisma configuration
- Consolidate to Drizzle + SQLite (primary ORM)
- Update package.json and clean up imports
- Create backups before making changes

## Recommended Actions

### Immediate (Required)

1. **Run the validation script**:
   ```bash
   node scripts/schema-drift-validator.mjs
   ```

2. **Consolidate schema configuration**:
   ```bash
   node scripts/consolidate-schema.mjs
   ```

3. **Update dependencies**:
   ```bash
   npm install
   ```

4. **Run tests**:
   ```bash
   npm test
   ```

### Manual Review Required

1. **Database Connection Strings**: Ensure `DATABASE_URL` points to SQLite database
2. **Test Coverage**: Verify all database operations work with consolidated schema
3. **Documentation**: Update any references to Prisma in documentation
4. **CI/CD**: Update deployment scripts to use Drizzle migrations

## Schema Consolidation Details

### Before (Problematic)
```
├── drizzle.config.ts          # SQLite configuration
├── prisma.config.ts           # PostgreSQL configuration  
├── src/db/schema.ts           # Drizzle entities
├── prisma/schema.prisma       # Prisma entities (different)
├── src/db/index.ts            # Drizzle connection
├── src/db.ts                  # PostgreSQL pool
└── src/lib/prisma.ts          # Prisma client
```

### After (Consolidated)
```
├── drizzle.config.ts          # SQLite configuration
├── src/db/schema.ts           # Unified schema definitions
├── src/db/index.ts            # Single database connection
└── scripts/schema-drift-validator.mjs  # Ongoing validation
```

## Security & Data Integrity Notes

### Critical Security Considerations

1. **Database Access**: Ensure SQLite file has proper permissions
2. **Migration Safety**: Always backup database before running migrations
3. **Connection Pooling**: SQLite doesn't need pooling, remove any pool configurations

### Data Integrity Safeguards

1. **Type Safety**: All entities now have proper TypeScript exports
2. **Migration Validation**: Scripts validate schema before applying changes
3. **Backup Protection**: All changes create automatic backups

## Testing Strategy

### Unit Tests
- Schema drift detection tests run on every commit
- Type safety validation for all entities
- Import consistency checks

### Integration Tests  
- Database connection validation
- Migration testing with rollback capabilities
- Cross-ORM compatibility tests (if needed)

### CI/CD Integration
Add to your CI pipeline:
```yaml
- name: Validate Schema Drift
  run: node scripts/schema-drift-validator.mjs
```

## Migration Commands

### Generate New Migrations
```bash
npm run db:generate
```

### Apply Migrations
```bash
npm run db:migrate
```

### Open Database Studio
```bash
npm run db:studio
```

## Troubleshooting

### Common Issues

1. **Import Errors**: Run consolidation script to clean up imports
2. **Type Errors**: Check schema drift test output for missing types
3. **Connection Issues**: Verify DATABASE_URL environment variable

### Recovery

If issues occur after consolidation:
1. Restore from `.schema-backup/` directory
2. Re-run validation script
3. Test database operations manually

## Future Considerations

1. **ORM Choice**: Drizzle + SQLite is recommended for simplicity
2. **Database Scaling**: Consider PostgreSQL if scaling requirements change
3. **Schema Evolution**: Use validation script to prevent future drift

## Files Modified

- ✅ `src/__tests__/schema-drift.test.ts` - New comprehensive tests
- ✅ `scripts/schema-drift-validator.mjs` - Validation script
- ✅ `scripts/consolidate-schema.mjs` - Consolidation script
- ✅ `package.json` - Updated dependencies and scripts
- 🔄 `src/db/index.ts` - Cleaned up imports (if consolidation run)
- 🔄 `src/index.ts` - Removed Prisma references (if consolidation run)

## Validation Results

After running the validation script, you should see:
```
✅ No schema drift issues detected!
```

If issues are found, the script will provide detailed recommendations for fixing them.
