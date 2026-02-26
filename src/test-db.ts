// Test script to verify database schema and migration
import('./db/index.js').then(async ({ initializeDb, db, schema }) => {
  try {
    console.log('Testing database initialization...');
    await initializeDb();
    
    // Test creating a sample API
    console.log('Testing API creation...');
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
    
    console.log('Created API:', newApi);
    
    // Test creating a sample endpoint
    console.log('Testing endpoint creation...');
    const [newEndpoint] = await db.insert(schema.apiEndpoints)
      .values({
        api_id: newApi.id,
        path: '/users',
        method: 'GET',
        price_per_call_usdc: '0.005',
        description: 'Get all users'
      })
      .returning();
    
    console.log('Created endpoint:', newEndpoint);
    
    // Test querying
    console.log('Testing queries...');
    const apis = await db.select().from(schema.apis);
    const endpoints = await db.select().from(schema.apiEndpoints);
    
    console.log('All APIs:', apis);
    console.log('All endpoints:', endpoints);
    
    console.log('✅ All tests passed! Database setup is working correctly.');
    
  } catch (error) {
    console.error('❌ Test failed:', error);
  } finally {
    process.exit(0);
  }
}).catch(console.error);