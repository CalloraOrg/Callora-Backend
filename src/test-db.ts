// Test script to verify database schema and migration
import { sql } from 'drizzle-orm';
import { logger } from './logger.js';
import { db, schema, initializeDb } from './db/index.js';

/**
 * Reliable reset for SQLite state
 */
export async function resetDb() {
  logger.info('Resetting database state...');
  
  // Disable foreign key constraints temporarily for truncating
  await db.run(sql.raw('PRAGMA foreign_keys = OFF'));
  
  try {
    // Get all user tables, excluding internal ones
    await db.run(sql.raw(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'drizzle_%'"
    ));
    
    // Result handling depends on the driver, better-sqlite3 .run() returns an object with changes/lastInsertRowid
    // But we need the rows. Drizzle's db.run might not return rows for some drivers.
    // Let's use db.all or db.select if available, or just stick to a known list if dynamic is tricky with the current drizzle-orm/better-sqlite3 setup.
    // Wait, src/db/index.ts uses better-sqlite3 directly too.
    
    // In drizzle-orm/better-sqlite3, db.run() returns { changes: number, lastInsertRowid: number | bigint }.
    // To get results, we should use db.all() or similar if using raw SQL.
    
    // Let's check src/db/index.ts again. It uses sqlite.prepare(...).get().
    // We can use the underlying sqlite instance if we want to be sure.
    
    const tables = ['api_endpoints', 'apis', 'developers']; // Fallback/default
    
    // Try to get tables dynamically
    try {
      // In Drizzle Better-SQLite3, db.all() returns the rows for a query
      const tablesResult = await db.all(sql.raw(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'drizzle_%'"
      ));
      
      if (Array.isArray(tablesResult)) {
        const dynamicTables = (tablesResult as any[]).map(r => r.name as string);
        if (dynamicTables.length > 0) {
          logger.info(`Found ${dynamicTables.length} tables to reset: ${dynamicTables.join(', ')}`);
          // Use dynamic tables
          for (const table of dynamicTables) {
            await db.run(sql.raw(`DELETE FROM "${table}"`));
            try {
              await db.run(sql.raw(`DELETE FROM sqlite_sequence WHERE name = '${table}'`));
            } catch (_e) {
              // Ignore if sqlite_sequence doesn't exist or doesn't have the table
            }
          }
        }
      }
    } catch (err) {
      logger.warn('Failed to fetch tables dynamically, falling back to hardcoded list:', (err as Error).message);
      for (const table of tables) {
        await db.run(sql.raw(`DELETE FROM "${table}"`));
        try {
          await db.run(sql.raw(`DELETE FROM sqlite_sequence WHERE name = '${table}'`));
        } catch (_e) {}
      }
    }

    logger.info('✅ Database reset successfully');
  } catch (error) {
    logger.error('❌ Database reset failed:', error);
    throw error;
  } finally {
    await db.run(sql.raw('PRAGMA foreign_keys = ON'));
  }
}

async function runTests() {
  try {
    logger.info('Testing database initialization...');
    await initializeDb();
    
    await resetDb();
    
    // Test creating a sample API
    logger.info('Testing API creation...');
    const [newApi] = await db.insert(schema.apis)
      .values({
        developer_id: 1,
        name: 'Test API',
        description: 'A test API for validation',
        base_url: 'https://api.example.com',
        category: 'test',
        status: 'draft'
      })
      .returning();
    
    logger.info('Created API:', newApi);
    
    // Test creating a sample endpoint
    logger.info('Testing endpoint creation...');
    const [newEndpoint] = await db.insert(schema.apiEndpoints)
      .values({
        api_id: newApi.id,
        path: '/users',
        method: 'GET',
        price_per_call_usdc: '0.005',
        description: 'Get all users'
      })
      .returning();
    
    logger.info('Created endpoint:', newEndpoint);
    
    // Test querying
    logger.info('Testing queries...');
    const apis = await db.select().from(schema.apis);
    const endpoints = await db.select().from(schema.apiEndpoints);
    
    logger.info('All APIs:', apis);
    logger.info('All endpoints:', endpoints);
    
    logger.info('✅ All tests passed! Database setup is working correctly.');
    
  } catch (error) {
    logger.error('❌ Test failed:', error);
    process.exit(1);
  }
}

// Execute if run directly
const isMain = process.argv[1] && (
  process.argv[1].endsWith('test-db.ts') ||
  process.argv[1].endsWith('test-db')
) && !process.argv[1].includes('jest');

if (isMain) {
  runTests().then(() => process.exit(0));
}
