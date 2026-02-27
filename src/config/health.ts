/**
 * Health Check Configuration
 * 
 * Centralizes health check configuration from environment variables
 */

import { Pool } from 'pg';
import type { HealthCheckConfig } from '../services/healthCheck.js';

let dbPool: Pool | null = null;

/**
 * Creates or returns existing database connection pool
 */
function getDbPool(): Pool {
  if (!dbPool) {
    dbPool = new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres',
      database: process.env.DB_NAME || 'callora',
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  }
  return dbPool;
}

/**
 * Builds health check configuration from environment variables
 */
export function buildHealthCheckConfig(): HealthCheckConfig | undefined {
  // Only enable detailed health checks if database is configured
  if (!process.env.DB_HOST && !process.env.DB_NAME) {
    return undefined;
  }

  const config: HealthCheckConfig = {
    version: process.env.APP_VERSION || '1.0.0',
    database: {
      pool: getDbPool(),
      timeout: parseInt(process.env.HEALTH_CHECK_DB_TIMEOUT || '2000', 10),
    },
  };

  // Add Soroban RPC if enabled
  if (process.env.SOROBAN_RPC_ENABLED === 'true' && process.env.SOROBAN_RPC_URL) {
    config.sorobanRpc = {
      url: process.env.SOROBAN_RPC_URL,
      timeout: parseInt(process.env.SOROBAN_RPC_TIMEOUT || '2000', 10),
    };
  }

  // Add Horizon if enabled
  if (process.env.HORIZON_ENABLED === 'true' && process.env.HORIZON_URL) {
    config.horizon = {
      url: process.env.HORIZON_URL,
      timeout: parseInt(process.env.HORIZON_TIMEOUT || '2000', 10),
    };
  }

  return config;
}

/**
 * Closes database pool gracefully
 */
export async function closeDbPool(): Promise<void> {
  if (dbPool) {
    await dbPool.end();
    dbPool = null;
  }
}
