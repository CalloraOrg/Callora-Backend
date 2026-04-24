/**
 * Health Check Service
 * 
 * Provides comprehensive health monitoring for all system components.
 * Designed for load balancer integration and monitoring systems.
 */

import type { Pool } from 'pg';

export type ComponentStatus = 'ok' | 'degraded' | 'down';

export interface HealthCheckResult {
  status: ComponentStatus;
  version?: string;
  timestamp: string;
  checks: {
    api: ComponentStatus;
    database: ComponentStatus;
    soroban_rpc?: ComponentStatus;
    horizon?: ComponentStatus;
  };
}

export interface ComponentCheck {
  status: ComponentStatus;
  responseTime?: number;
  error?: string;
}

export interface HealthCheckConfig {
  version?: string;
  database: {
    pool: Pool;
    timeout?: number;
  };
  sorobanRpc?: {
    url: string;
    timeout?: number;
  };
  horizon?: {
    url: string;
    timeout?: number;
  };
}

const DEFAULT_DB_TIMEOUT = 2000;
const DEFAULT_EXTERNAL_TIMEOUT = 2000;
const DEGRADED_THRESHOLD_DB = 1000;
const DEGRADED_THRESHOLD_EXTERNAL = 2000;

/**
 * Checks database health by executing SELECT 1
 * Uses connection pool for efficiency
 */
export async function checkDatabase(
  pool: Pool,
  timeoutMs: number = DEFAULT_DB_TIMEOUT
): Promise<ComponentCheck> {
  const startTime = Date.now();

  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Database check timeout')), timeoutMs);
    });

    const queryPromise = pool.query('SELECT 1 as result');
    const result = await Promise.race([queryPromise, timeoutPromise]);

    const responseTime = Date.now() - startTime;

    if (result.rows[0]?.result === 1) {
      return {
        status: responseTime > DEGRADED_THRESHOLD_DB ? 'degraded' : 'ok',
        responseTime,
      };
    }

    return {
      status: 'down',
      responseTime,
      error: 'Unexpected query result',
    };
  } catch (error) {
    const responseTime = Date.now() - startTime;
    return {
      status: 'down',
      responseTime,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Checks Soroban RPC health via getHealth JSON-RPC method
 * Safe to call even if service is unreachable
 */
export async function checkSorobanRpc(
  url: string,
  timeoutMs: number = DEFAULT_EXTERNAL_TIMEOUT
): Promise<ComponentCheck> {
  const startTime = Date.now();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getHealth',
        params: [],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const responseTime = Date.now() - startTime;

    if (response.ok) {
      await response.json(); // Validate JSON response
      return {
        status: responseTime > DEGRADED_THRESHOLD_EXTERNAL ? 'degraded' : 'ok',
        responseTime,
      };
    }

    return {
      status: 'degraded',
      responseTime,
      error: `HTTP ${response.status}`,
    };
  } catch (error) {
    const responseTime = Date.now() - startTime;
    const errorMessage =
      error instanceof Error
        ? error.name === 'AbortError'
          ? 'Timeout'
          : error.message
        : 'Unknown error';

    return {
      status: 'down',
      responseTime,
      error: errorMessage,
    };
  }
}

/**
 * Checks Horizon API health via root endpoint ping
 * Safe to call even if service is unreachable
 */
export async function checkHorizon(
  url: string,
  timeoutMs: number = DEFAULT_EXTERNAL_TIMEOUT
): Promise<ComponentCheck> {
  const startTime = Date.now();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const responseTime = Date.now() - startTime;

    if (response.ok) {
      return {
        status: responseTime > DEGRADED_THRESHOLD_EXTERNAL ? 'degraded' : 'ok',
        responseTime,
      };
    }

    return {
      status: 'degraded',
      responseTime,
      error: `HTTP ${response.status}`,
    };
  } catch (error) {
    const responseTime = Date.now() - startTime;
    const errorMessage =
      error instanceof Error
        ? error.name === 'AbortError'
          ? 'Timeout'
          : error.message
        : 'Unknown error';

    return {
      status: 'down',
      responseTime,
      error: errorMessage,
    };
  }
}

/**
 * Determines overall system status based on component checks
 * Critical components (api, database) down → 'down'
 * Any component degraded/down → 'degraded'
 * All healthy → 'ok'
 */
export function determineOverallStatus(checks: {
  api: ComponentStatus;
  database: ComponentStatus;
  soroban_rpc?: ComponentStatus;
  horizon?: ComponentStatus;
}): ComponentStatus {
  // Critical components must be 'ok'
  if (checks.api === 'down' || checks.database === 'down') {
    return 'down';
  }

  // Check for any degraded or down components
  const allStatuses = Object.values(checks);
  if (allStatuses.includes('degraded') || allStatuses.includes('down')) {
    return 'degraded';
  }

  return 'ok';
}

/**
 * Performs comprehensive health check of all configured components
 * Returns detailed status suitable for load balancers and monitoring
 */
export async function performHealthCheck(
  config: HealthCheckConfig
): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = {
    api: 'ok', // API is healthy if we can respond
    database: 'down', // Default to down until checked
  };

  // Check database (critical component)
  const dbCheck = await checkDatabase(
    config.database.pool,
    config.database.timeout
  );
  checks.database = dbCheck.status;

  // Check Soroban RPC (optional component)
  if (config.sorobanRpc) {
    const sorobanCheck = await checkSorobanRpc(
      config.sorobanRpc.url,
      config.sorobanRpc.timeout
    );
    checks.soroban_rpc = sorobanCheck.status;
  }

  // Check Horizon (optional component)
  if (config.horizon) {
    const horizonCheck = await checkHorizon(
      config.horizon.url,
      config.horizon.timeout
    );
    checks.horizon = horizonCheck.status;
  }

  const overallStatus = determineOverallStatus(checks);

  return {
    status: overallStatus,
    version: config.version,
    timestamp: new Date().toISOString(),
    checks,
  };
}
