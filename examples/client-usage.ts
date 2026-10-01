/**
 * Client Usage Examples
 * 
 * Shows how to use the health check and billing endpoints from a client.
 */

import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';

/**
 * The billing API wraps successful responses in a `{ success: true, data }`
 * envelope and failures in `{ success: false, error }`. These helpers keep the
 * examples aligned with the documented envelope fields.
 */
interface SuccessEnvelope<T> {
  success: true;
  data: T;
}

interface ErrorEnvelope {
  success: false;
  error: {
    code: string;
    message: string;
  };
}

interface DeductResult {
  usageEventId: string;
  stellarTxHash?: string;
  alreadyProcessed: boolean;
}

interface HealthResult {
  status: 'ok' | 'degraded' | 'down';
  checks: Record<string, unknown>;
}

function unwrap<T>(payload: SuccessEnvelope<T> | T): T {
  if (payload && typeof payload === 'object' && 'success' in payload && (payload as SuccessEnvelope<T>).success) {
    return (payload as SuccessEnvelope<T>).data;
  }
  return payload as T;
}

function describeError(error: unknown): string {
  if (axios.isAxiosError(error) && error.response?.data) {
    const body = error.response.data as Partial<ErrorEnvelope>;
    if (body.error) {
      return `${body.error.code}: ${body.error.message}`;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

// ============================================================================
// HEALTH CHECK EXAMPLES
// ============================================================================

/**
 * Check application health
 */
async function checkHealth() {
  try {
    const response = await axios.get(`${API_BASE_URL}/api/health`);
    const health = unwrap<HealthResult>(response.data);
    
    console.log('Health Status:', health.status);
    console.log('Components:', health.checks);
    
    if (health.status === 'degraded') {
      console.warn('⚠️  System is degraded');
    } else if (health.status === 'ok') {
      console.log('✅ System is healthy');
    }
    
    return health;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 503) {
      console.error('🔴 System is down:', describeError(error));
    } else {
      console.error('Error checking health:', describeError(error));
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
  // Generate idempotency key once; it is sent via the Idempotency-Key header.
  const idempotencyKey = `req_${uuidv4()}`;
  
  console.log(`Deducting ${amountUsdc} USDC from user ${userId}`);
  console.log(`Idempotency-Key: ${idempotencyKey}`);
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await axios.post(
        `${API_BASE_URL}/api/billing/deduct`,
        {
          userId,
          apiId,
          endpointId,
          apiKeyId,
          amountUsdc,
        },
        {
          headers: { 'Idempotency-Key': idempotencyKey },
        }
      );
      
      const result = unwrap<DeductResult>(response.data);
      
      if (result.alreadyProcessed) {
        console.log('✅ Request already processed (no double charge)');
      } else {
        console.log('✅ Balance deducted successfully');
      }
      
      console.log('Usage Event ID:', result.usageEventId);
      console.log('Stellar TX:', result.stellarTxHash);
      
      return result;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 400) {
          // Bad request - don't retry
          console.error('❌ Invalid request:', describeError(error));
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
    const status = unwrap<DeductResult>(response.data);
    
    console.log('Request Status:', status);
    return status;
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
  const idempotencyKey = `req_demo_${Date.now()}`;
  
  console.log('\n=== Demonstrating Idempotency ===\n');
  
  const body = {
    userId: 'user_demo',
    apiId: 'api_demo',
    endpointId: 'endpoint_demo',
    apiKeyId: 'key_demo',
    amountUsdc: '0.01',
  };
  const headers = { 'Idempotency-Key': idempotencyKey };
  
  // First request
  console.log('First request:');
  const result1 = await axios.post(`${API_BASE_URL}/api/billing/deduct`, body, { headers });
  const first = unwrap<DeductResult>(result1.data);
  
  console.log('Status:', result1.status);
  console.log('Already Processed:', first.alreadyProcessed);
  console.log('Usage Event ID:', first.usageEventId);
  
  // Second request with same Idempotency-Key
  console.log('\nSecond request (same Idempotency-Key):');
  const result2 = await axios.post(`${API_BASE_URL}/api/billing/deduct`, body, { headers });
  const second = unwrap<DeductResult>(result2.data);
  
  console.log('Status:', result2.status);
  console.log('Already Processed:', second.alreadyProcessed);
  console.log('Usage Event ID:', second.usageEventId);
  
  // Verify same usage event
  if (first.usageEventId === second.usageEventId) {
    console.log('\n✅ Idempotency verified: Same usage event returned');
    console.log('✅ No double charge occurred');
  }
}

/**
 * Concurrent requests with same request_id
 */
async function demonstrateConcurrentIdempotency() {
  const idempotencyKey = `req_concurrent_${Date.now()}`;
  
  console.log('\n=== Demonstrating Concurrent Idempotency ===\n');
  
  const body = {
    userId: 'user_concurrent',
    apiId: 'api_concurrent',
    endpointId: 'endpoint_concurrent',
    apiKeyId: 'key_concurrent',
    amountUsdc: '0.01',
  };
  const headers = { 'Idempotency-Key': idempotencyKey };
  
  // Send 5 concurrent requests with the same Idempotency-Key
  const promises = Array.from({ length: 5 }, (_, i) =>
    axios.post(`${API_BASE_URL}/api/billing/deduct`, body, { headers }).then(res => {
      const result = unwrap<DeductResult>(res.data);
      return {
        index: i + 1,
        usageEventId: result.usageEventId,
        alreadyProcessed: result.alreadyProcessed,
      };
    })
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
      console.error('Health check failed:', describeError(error));
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
    console.error('Error:', describeError(error));
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
