/**
 * Health Check Service
 * 
 * Provides comprehensive health monitoring for all system components.
 * Designed for load balancer integration and monitoring systems.
 */

import type { Pool } from 'pg';
import { rpc, xdr } from '@stellar/stellar-sdk';
import { config as appConfig } from '../config/index.js';
import { contractInstanceLedgerKey } from './sorobanVaultReader.js';

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

export interface SorobanRpcProbeServer {
  getHealth(): Promise<unknown>;
  getNetwork(): Promise<{ passphrase: string }>;
  getLedgerEntries(...keys: xdr.LedgerKey[]): Promise<{ entries: unknown[] }>;
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
    networkPassphrase?: string;
    vaultContractId?: string;
    createServer?: (url: string, timeoutMs: number) => SorobanRpcProbeServer;
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

function createTimeoutPromise(timeoutMs: number, message: string): {
  promise: Promise<never>;
  cancel: () => void;
} {
  let timeoutId: NodeJS.Timeout | undefined;

  return {
    promise: new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
    cancel: () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    },
  };
}

/**
 * Checks database health by executing SELECT 1
 * Uses connection pool for efficiency
 */
export async function checkDatabase(
  pool: Pool,
  timeoutMs: number = DEFAULT_DB_TIMEOUT
): Promise<ComponentCheck> {
  const startTime = Date.now();
  const timeout = createTimeoutPromise(timeoutMs, 'Database check timeout');

  try {
    const queryPromise = pool.query('SELECT 1 as result');
    const result = await Promise.race([queryPromise, timeout.promise]);

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
  } finally {
    timeout.cancel();
  }
}

/**
 * Checks Soroban RPC health via getHealth JSON-RPC method
 * Safe to call even if service is unreachable
 */
export async function checkSorobanRpc(
  url: string,
  timeoutMs: number = DEFAULT_EXTERNAL_TIMEOUT,
  options: {
    networkPassphrase?: string;
    vaultContractId?: string;
    createServer?: (url: string, timeoutMs: number) => SorobanRpcProbeServer;
  } = {},
): Promise<ComponentCheck> {
  const startTime = Date.now();

  try {
    const server = options.createServer?.(url, timeoutMs) ??
      new rpc.Server(url, { timeout: timeoutMs });
    await server.getHealth();

    const expectedPassphrase =
      options.networkPassphrase ?? appConfig.stellar.networkPassphrase;
    const network = await server.getNetwork();
    if (network.passphrase !== expectedPassphrase) {
      return {
        status: 'degraded',
        responseTime: Date.now() - startTime,
        error: 'network_mismatch',
      };
    }

    const contractId =
      options.vaultContractId ?? appConfig.stellar.vaultContractId;
    if (contractId) {
      const contractEntry = await server.getLedgerEntries(
        contractInstanceLedgerKey(contractId),
      );
      if (contractEntry.entries.length === 0) {
        return {
          status: 'degraded',
          responseTime: Date.now() - startTime,
          error: 'vault_contract_missing',
        };
      }
    }

    return {
      status:
        Date.now() - startTime > DEGRADED_THRESHOLD_EXTERNAL
          ? 'degraded'
          : 'ok',
      responseTime: Date.now() - startTime,
    };
  } catch (error) {
    const responseTime = Date.now() - startTime;
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (/^HTTP \d+$/.test(message)) {
      return {
        status: 'degraded',
        responseTime,
        error: message,
      };
    }
    return {
      status: 'down',
      responseTime,
      error:
        error instanceof Error
          ? error.name === 'AbortError'
            ? 'Timeout'
            : error.message
          : message,
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
 * Performs comprehensive health check of all configured components.
 *
 * Returns detailed status suitable for load balancers and monitoring.
 *
 * @param config       - Health check configuration (pools, URLs, timeouts).
 * @param abortSignal  - Optional signal from the per-request timeout middleware.
 *                       When the signal fires, any pending component checks that
 *                       respect it will be abandoned early — preventing the full
 *                       per-component timeout from stalling a response that was
 *                       already marked as timed-out by the caller.
 */
export async function performHealthCheck(
  config: HealthCheckConfig,
  abortSignal?: AbortSignal,
): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = {
    api: 'ok', // API is healthy if we can respond
    database: 'down', // Default to down until checked
  };

  // If the per-request abort signal has already fired before we start, bail
  // immediately so the timeout middleware can send its own 504 without racing
  // against a partial response from here.
  if (abortSignal?.aborted) {
    throw new DOMException('Request aborted before health check started', 'AbortError');
  }

  const [dbCheck, sorobanCheck, horizonCheck] = await Promise.all([
    checkDatabase(config.database.pool, config.database.timeout),
    config.sorobanRpc
      ? checkSorobanRpc(
          config.sorobanRpc.url,
          config.sorobanRpc.timeout,
          {
            networkPassphrase: config.sorobanRpc.networkPassphrase,
            vaultContractId: config.sorobanRpc.vaultContractId,
            createServer: config.sorobanRpc.createServer,
          },
        )
      : Promise.resolve(undefined),
    config.horizon
      ? checkHorizon(config.horizon.url, config.horizon.timeout)
      : Promise.resolve(undefined),
  ]);

  checks.database = dbCheck.status;

  if (sorobanCheck) {
    checks.soroban_rpc = sorobanCheck.status;
  }

  if (horizonCheck) {
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
