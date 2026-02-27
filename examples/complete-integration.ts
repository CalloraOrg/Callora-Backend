/**
 * Complete Integration Example
 * 
 * Shows how to integrate both health check and billing idempotency
 * features into a production application.
 */

import express from 'express';
import { Pool } from 'pg';
import dotenv from 'dotenv';
import { BillingService, type SorobanClient } from '../src/services/billing.js';
import { buildHealthCheckConfig, closeDbPool } from '../src/config/health.js';
import { performHealthCheck } from '../src/services/healthCheck.js';

// Load environment variables
dotenv.config();

// Initialize database pool
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'callora',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Mock Soroban client (replace with real implementation)
class MockSorobanClient implements SorobanClient {
  async deductBalance(userId: string, amount: string): Promise<string> {
    // In production, this would call the actual Soroban smart contract
    console.log(`Deducting ${amount} USDC from user ${userId}`);
    return `tx_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  }
}

// Initialize services
const sorobanClient = new MockSorobanClient();
const billingService = new BillingService(pool, sorobanClient);
const healthCheckConfig = buildHealthCheckConfig();

// Create Express app
const app = express();
app.use(express.json());

// ============================================================================
// HEALTH CHECK ENDPOINT
// ============================================================================

/**
 * GET /api/health
 * 
 * Returns detailed health status of all system components.
 * Used by load balancers and monitoring systems.
 * 
 * Response codes:
 * - 200: All critical components healthy
 * - 503: One or more critical components down
 */
app.get('/api/health', async (_req, res) => {
  if (!healthCheckConfig) {
    // Fallback to simple health check
    return res.json({ status: 'ok', service: 'callora-backend' });
  }

  try {
    const healthStatus = await performHealthCheck(healthCheckConfig);
    const statusCode = healthStatus.status === 'down' ? 503 : 200;
    res.status(statusCode).json(healthStatus);
  } catch (error) {
    // Never expose internal errors in health check
    res.status(503).json({
      status: 'down',
      timestamp: new Date().toISOString(),
      checks: {
        api: 'ok',
        database: 'down',
      },
    });
  }
});

// ============================================================================
// BILLING ENDPOINTS
// ============================================================================

/**
 * POST /api/billing/deduct
 * 
 * Idempotent billing deduction endpoint.
 * Uses request_id as idempotency key to prevent double charges.
 * 
 * Request body:
 * {
 *   "requestId": "req_abc123",      // Required: Unique idempotency key
 *   "userId": "user_alice",
 *   "apiId": "api_weather",
 *   "endpointId": "endpoint_forecast",
 *   "apiKeyId": "key_xyz789",
 *   "amountUsdc": "0.01"
 * }
 * 
 * Response:
 * {
 *   "usageEventId": "1",
 *   "stellarTxHash": "tx_stellar_abc...",
 *   "alreadyProcessed": false
 * }
 */
app.post('/api/billing/deduct', async (req, res) => {
  const { requestId, userId, apiId, endpointId, apiKeyId, amountUsdc } = req.body;

  // Validate required fields
  if (!requestId) {
    return res.status(400).json({
      error: 'request_id is required for idempotency',
      code: 'MISSING_REQUEST_ID',
    });
  }

  if (!userId || !apiId || !endpointId || !apiKeyId || !amountUsdc) {
    return res.status(400).json({
      error: 'Missing required fields',
      code: 'INVALID_REQUEST',
    });
  }

  // Validate amount
  const amount = parseFloat(amountUsdc);
  if (isNaN(amount) || amount <= 0) {
    return res.status(400).json({
      error: 'Invalid amount',
      code: 'INVALID_AMOUNT',
    });
  }

  try {
    const result = await billingService.deduct({
      requestId,
      userId,
      apiId,
      endpointId,
      apiKeyId,
      amountUsdc,
    });

    if (!result.success) {
      return res.status(500).json({
        error: result.error || 'Billing deduction failed',
        code: 'DEDUCTION_FAILED',
      });
    }

    // Return 200 for duplicate requests, 201 for new requests
    const statusCode = result.alreadyProcessed ? 200 : 201;

    return res.status(statusCode).json({
      usageEventId: result.usageEventId,
      stellarTxHash: result.stellarTxHash,
      alreadyProcessed: result.alreadyProcessed,
    });
  } catch (error) {
    console.error('Billing deduction error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * GET /api/billing/status/:requestId
 * 
 * Check the status of a billing request by request_id.
 * Useful for checking if a request was already processed.
 */
app.get('/api/billing/status/:requestId', async (req, res) => {
  const { requestId } = req.params;

  if (!requestId) {
    return res.status(400).json({
      error: 'request_id is required',
      code: 'MISSING_REQUEST_ID',
    });
  }

  try {
    const result = await billingService.getByRequestId(requestId);

    if (!result) {
      return res.status(404).json({
        error: 'Request not found',
        code: 'NOT_FOUND',
      });
    }

    return res.json({
      usageEventId: result.usageEventId,
      stellarTxHash: result.stellarTxHash,
      processed: true,
    });
  } catch (error) {
    console.error('Status check error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  }
});

// ============================================================================
// ERROR HANDLING
// ============================================================================

// 404 handler
app.use((_req, res) => {
  res.status(404).json({
    error: 'Not found',
    code: 'NOT_FOUND',
  });
});

// Global error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
  });
});

// ============================================================================
// SERVER STARTUP
// ============================================================================

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`✅ Health check: http://localhost:${PORT}/api/health`);
  console.log(`💰 Billing: http://localhost:${PORT}/api/billing/deduct`);
  
  if (healthCheckConfig) {
    console.log('✅ Detailed health checks enabled');
    if (healthCheckConfig.sorobanRpc) {
      console.log('  - Soroban RPC monitoring enabled');
    }
    if (healthCheckConfig.horizon) {
      console.log('  - Horizon monitoring enabled');
    }
  }
});

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================

async function gracefulShutdown(signal: string) {
  console.log(`\n${signal} received, shutting down gracefully...`);

  // Stop accepting new connections
  server.close(() => {
    console.log('HTTP server closed');
  });

  // Close database pool
  try {
    await closeDbPool();
    console.log('Database pool closed');
  } catch (error) {
    console.error('Error closing database pool:', error);
  }

  // Exit process
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
  gracefulShutdown('UNHANDLED_REJECTION');
});

export default app;
