/**
 * Health Check Configuration
 * 
 * Centralizes health check configuration from environment variables
 */

import { Pool } from 'pg';
import { env } from './env.js';
import type { HealthCheckConfig } from '../services/healthCheck.js';

let dbPool: Pool | null = null;

function getDbPool(): Pool {
  if (!dbPool) {
    dbPool = new Pool({
      host: env.DB_HOST,
      port: env.DB_PORT,
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      database: env.DB_NAME,
      max: env.DB_POOL_MAX,
      idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: env.DB_CONN_TIMEOUT_MS,
    });
  }
  return dbPool;
}

export function buildHealthCheckConfig(): HealthCheckConfig | undefined {
  // Only enable detailed health checks if database is explicitly configured
  if (env.DB_HOST === 'localhost' && env.DB_NAME === 'callora') {
    return undefined;
  }

  const healthConfig: HealthCheckConfig = {
    version: env.APP_VERSION,
    database: {
      pool: getDbPool(),
      timeout: env.HEALTH_CHECK_DB_TIMEOUT,
    },
  };

  if (env.SOROBAN_RPC_ENABLED && env.SOROBAN_RPC_URL) {
    healthConfig.sorobanRpc = {
      url: env.SOROBAN_RPC_URL,
      timeout: env.SOROBAN_RPC_TIMEOUT,
    };
  }

  if (env.HORIZON_ENABLED && env.HORIZON_URL) {
    healthConfig.horizon = {
      url: env.HORIZON_URL,
      timeout: env.HORIZON_TIMEOUT,
    };
  }

  return healthConfig;
}

export async function closeDbPool(): Promise<void> {
  if (dbPool) {
    await dbPool.end();
    dbPool = null;
  }
}