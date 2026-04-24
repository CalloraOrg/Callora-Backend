/**
 * Client Usage Examples
 * 
 * Shows how to use the health check and billing endpoints from a client.
 */

import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';

// ============================================================================
// HEALTH CHECK EXAMPLES
// ============================================================================

/**
 * Check application health
 */
async function checkHealth() {
  try {
    const response = await axios.get(`${API_BASE_URL}/api/health`);
    
    console.log('Health Status:', response.data.status);
    console.log('Components:', response.data.checks);
    
    if (response.data.status === 'degraded') {
      console.warn('⚠️  System is degraded');
    } else if (response.data.status === 'ok') {
      console.log('✅ System is healthy');
    }
    
    return response.data;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 503) {
      console.error('🔴 System is down:', error.response.data);
    } else {
      console.error('Error checking health:', error);
    }
    throw error;
  }
}

// ============================================================================
// BILLING EXAMPLES
// ============================================================================

/**
 * Deduct balance with automatic retry and idempotency
 */
async function deductBalanceWithRetry(
  userId: string,
  apiId: string,
  endpointId: string,
  apiKeyId: string,
  amountUsdc: string,
  maxRetries: number = 3
) {
  // Generate idempotency key once
  const requestId = `req_${uuidv4()}`;
  
  console.log(`Deducting ${amountUsdc} USDC from user ${userId}`);
  console.log(`Request ID: ${requestId}`);
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await axios.post(`${API_BASE_URL}/api/billing/deduct`, {
        requestId,
        userId,
        apiId,
        endpointId,
        apiKeyId,
        amountUsdc,
      });
      
      if (response.data.alreadyProcessed) {
        console.log('✅ Request already processed (no double charge)');
      } else {
        console.log('✅ Balance deducted successfully');
      }
      
      console.log('Usage Event ID:', response.data.usageEventId);
      console.log('Stellar TX:', response.data.stellarTxHash);
      
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 400) {
          // Bad request - don't retry
          console.error('❌ Invalid request:', error.response.data);
          throw error;
        }
        
        if (attempt < maxRetries) {
          // Retry with exponential backoff
          const delay = Math.pow(2, attempt - 1) * 1000;
          console.log(`⚠️  Attempt ${attempt} failed, retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          console.error('❌ All retry attempts failed');
          throw error;
        }
      } else {
        throw error;
      }
    }
  }
}

/**
 * Check billing request status
 */
async function checkBillingStatus(requestId: string) {
  try {
    const response = await axios.get(`${API_BASE_URL}/api/billing/status/${requestId}`);
    
    console.log('Request Status:', response.data);
    return response.data;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 404) {
      console.log('Request not found (not yet processed)');
      return null;
    }
    throw error;
  }
}

/**
 * Demonstrate idempotency - same request_id returns same result
 */
async function demonstrateIdempotency() {
  const requestId = `req_demo_${Date.now()}`;
  
  console.log('\n=== Demonstrating Idempotency ===\n');
  
  // First request
  console.log('First request:');
  const result1 = await axios.post(`${API_BASE_URL}/api/billing/deduct`, {
    requestId,
    userId: 'user_demo',
    apiId: 'api_demo',
    endpointId: 'endpoint_demo',
    apiKeyId: 'key_demo',
    amountUsdc: '0.01',
  });
  
  console.log('Status:', result1.status);
  console.log('Already Processed:', result1.data.alreadyProcessed);
  console.log('Usage Event ID:', result1.data.usageEventId);
  
  // Second request with same request_id
  console.log('\nSecond request (same request_id):');
  const result2 = await axios.post(`${API_BASE_URL}/api/billing/deduct`, {
    requestId, // Same request_id
    userId: 'user_demo',
    apiId: 'api_demo',
    endpointId: 'endpoint_demo',
    apiKeyId: 'key_demo',
    amountUsdc: '0.01',
  });
  
  console.log('Status:', result2.status);
  console.log('Already Processed:', result2.data.alreadyProcessed);
  console.log('Usage Event ID:', result2.data.usageEventId);
  
  // Verify same usage event
  if (result1.data.usageEventId === result2.data.usageEventId) {
    console.log('\n✅ Idempotency verified: Same usage event returned');
    console.log('✅ No double charge occurred');
  }
}

/**
 * Concurrent requests with same request_id
 */
async function demonstrateConcurrentIdempotency() {
  const requestId = `req_concurrent_${Date.now()}`;
  
  console.log('\n=== Demonstrating Concurrent Idempotency ===\n');
  
  // Send 5 concurrent requests with same request_id
  const promises = Array.from({ length: 5 }, (_, i) =>
    axios.post(`${API_BASE_URL}/api/billing/deduct`, {
      requestId,
      userId: 'user_concurrent',
      apiId: 'api_concurrent',
      endpointId: 'endpoint_concurrent',
      apiKeyId: 'key_concurrent',
      amountUsdc: '0.01',
    }).then(res => ({
      index: i + 1,
      usageEventId: res.data.usageEventId,
      alreadyProcessed: res.data.alreadyProcessed,
    }))
  );
  
  const results = await Promise.all(promises);
  
  console.log('Results:');
  results.forEach(result => {
    console.log(`  Request ${result.index}: Event ${result.usageEventId}, Already Processed: ${result.alreadyProcessed}`);
  });
  
  // Verify all have same usage event ID
  const uniqueEventIds = new Set(results.map(r => r.usageEventId));
  if (uniqueEventIds.size === 1) {
    console.log('\n✅ All concurrent requests returned same usage event');
    console.log('✅ Only one charge occurred');
  }
}

// ============================================================================
// MONITORING EXAMPLES
// ============================================================================

/**
 * Continuous health monitoring
 */
async function monitorHealth(intervalMs: number = 30000) {
  console.log(`Starting health monitoring (every ${intervalMs}ms)...`);
  
  setInterval(async () => {
    try {
      const health = await checkHealth();
      
      // Alert on degraded or down status
      if (health.status === 'degraded') {
        console.warn('⚠️  ALERT: System degraded');
        // Send alert to monitoring system
      } else if (health.status === 'down') {
        console.error('🔴 ALERT: System down');
        // Send critical alert to monitoring system
      }
    } catch (error) {
      console.error('Health check failed:', error);
    }
  }, intervalMs);
}

// ============================================================================
// MAIN EXAMPLES
// ============================================================================

async function main() {
  try {
    // Check health
    console.log('=== Health Check ===');
    await checkHealth();
    
    // Deduct balance with retry
    console.log('\n=== Billing Deduction ===');
    await deductBalanceWithRetry(
      'user_alice',
      'api_weather',
      'endpoint_forecast',
      'key_xyz789',
      '0.01'
    );
    
    // Demonstrate idempotency
    await demonstrateIdempotency();
    
    // Demonstrate concurrent idempotency
    await demonstrateConcurrentIdempotency();
    
    // Start health monitoring (commented out for example)
    // monitorHealth(30000);
    
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

// Run examples if executed directly
if (require.main === module) {
  main();
}

export {
  checkHealth,
  deductBalanceWithRetry,
  checkBillingStatus,
  demonstrateIdempotency,
  demonstrateConcurrentIdempotency,
  monitorHealth,
};
