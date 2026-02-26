// Test script to verify database schema and migration
import { logger } from './logger.js';
import('./db/index.js').then(async ({ initializeDb, db, schema }) => {
  try {
    logger.info('Testing database initialization...');
    await initializeDb();
    
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
  } finally {
    process.exit(0);
  }
}).catch(logger.error);
