/**
 * Usage anomaly detection for per-developer 5-minute traffic windows.
 *
 * Baseline = arithmetic mean of the trailing N windows (default 12). The most
 * recent completed window is compared against `baseline * multiplier`; when
 * traffic exceeds that threshold an anomaly is returned for event emission.
 */

import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { calloraEvents } from '../events/event.emitter.js';
import { getOrCreateRequestId } from '../utils/asyncContext.js';
import { logger } from '../logger.js';
import type { UsageAnomalyDetectedData } from '../webhooks/webhook.types.js';
import {
  recordUsageAnomalyDetectorAnomaly,
  recordUsageAnomalyDetectorRun,
} from '../metrics.js';

export const DEFAULT_BASELINE_WINDOWS = 12;
export const DEFAULT_WINDOW_MS = 5 * 60 * 1000;
export const DEFAULT_MULTIPLIER = 5;

export interface WindowCount {
  windowStart: Date;
  calls: number;
}

export interface AnomalyDetectionConfig {
  multiplier: number;
  baselineWindows: number;
  windowMs: number;
}

export interface UsageAnomalyFinding {
  developerId: string;
  windowStart: Date;
  currentCalls: number;
  baselineMean: number;
  multiplier: number;
  ratio: number;
}

export interface AnomalyScanResult {
  developersScanned: number;
  anomaliesDetected: number;
  anomaliesEmitted: number;
}

export interface AnomalyDedupStore {
  has(key: string): boolean;
  set(key: string): void;
}

export interface AnomalyServiceDeps {
  pool: Pool;
  config: AnomalyDetectionConfig;
  dedup: AnomalyDedupStore;
  now?: () => Date;
  emit?: typeof calloraEvents.emit;
  log?: Pick<typeof logger, 'error' | 'info'>;
}

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

/** Aligns a timestamp to the start of its fixed-size window (UTC epoch ms). */
export function floorToWindowStart(date: Date, windowMs: number): Date {
  if (!Number.isInteger(windowMs) || windowMs <= 0) {
    throw new Error('windowMs must be a positive integer');
  }
  const ms = Math.floor(date.getTime() / windowMs) * windowMs;
  return new Date(ms);
}

/** Mean of the supplied call counts; returns 0 for an empty array. */
export function computeBaselineMean(counts: number[]): number {
  if (counts.length === 0) {
    return 0;
  }
  return counts.reduce((sum, count) => sum + count, 0) / counts.length;
}

/**
 * Returns true when `currentCalls` exceeds `baselineMean * multiplier`.
 * A zero baseline flags any positive traffic as anomalous.
 */
export function isAnomalousTraffic(
  baselineMean: number,
  currentCalls: number,
  multiplier: number,
): boolean {
  validateDetectionConfig({ multiplier, baselineWindows: 1, windowMs: 1 });
  if (currentCalls < 0) {
    throw new Error('currentCalls must be non-negative');
  }
  if (baselineMean === 0) {
    return currentCalls > 0;
  }
  return currentCalls > baselineMean * multiplier;
}

export function validateDetectionConfig(config: AnomalyDetectionConfig): void {
  if (!Number.isFinite(config.multiplier) || config.multiplier <= 0) {
    throw new Error('multiplier must be a positive finite number');
  }
  if (!Number.isInteger(config.baselineWindows) || config.baselineWindows <= 0) {
    throw new Error('baselineWindows must be a positive integer');
  }
  if (!Number.isInteger(config.windowMs) || config.windowMs <= 0) {
    throw new Error('windowMs must be a positive integer');
  }
}

/**
 * Builds window starts for baseline + the most recently completed window.
 * Oldest window first; the last entry is the window under test.
 */
export function buildExpectedWindowStarts(
  now: Date,
  config: Pick<AnomalyDetectionConfig, 'baselineWindows' | 'windowMs'>,
): Date[] {
  validateDetectionConfig({
    multiplier: 1,
    baselineWindows: config.baselineWindows,
    windowMs: config.windowMs,
  });
  const currentStart = floorToWindowStart(now, config.windowMs);
  const lastCompletedStart = new Date(currentStart.getTime() - config.windowMs);
  const starts: Date[] = [];
  for (let i = config.baselineWindows; i >= 0; i -= 1) {
    starts.push(new Date(lastCompletedStart.getTime() - i * config.windowMs));
  }
  return starts;
}

/** Fills gaps in the series with zero-call windows so the baseline stays correct. */
export function mergeWindowCounts(
  expectedStarts: Date[],
  actual: WindowCount[],
): WindowCount[] {
  const byStart = new Map(actual.map((w) => [w.windowStart.getTime(), w.calls]));
  return expectedStarts.map((windowStart) => ({
    windowStart,
    calls: byStart.get(windowStart.getTime()) ?? 0,
  }));
}

/**
 * Scores one developer's window series. Requires `baselineWindows + 1` points
 * (trailing baseline windows plus the window under test).
 */
export function detectDeveloperAnomaly(
  developerId: string,
  windows: WindowCount[],
  config: AnomalyDetectionConfig,
): UsageAnomalyFinding | null {
  validateDetectionConfig(config);

  if (windows.length < config.baselineWindows + 1) {
    return null;
  }

  const sorted = [...windows].sort(
    (a, b) => a.windowStart.getTime() - b.windowStart.getTime(),
  );
  const historical = sorted.slice(0, config.baselineWindows);
  const current = sorted[sorted.length - 1];
  const baselineMean = computeBaselineMean(historical.map((w) => w.calls));

  if (!isAnomalousTraffic(baselineMean, current.calls, config.multiplier)) {
    return null;
  }

  const ratio =
    baselineMean === 0 ? Number.POSITIVE_INFINITY : current.calls / baselineMean;

  return {
    developerId,
    windowStart: current.windowStart,
    currentCalls: current.calls,
    baselineMean: round4(baselineMean),
    multiplier: config.multiplier,
    ratio: Number.isFinite(ratio) ? round4(ratio) : ratio,
  };
}

export function anomalyDedupKey(developerId: string, windowStart: Date): string {
  return `${developerId}:${windowStart.toISOString()}`;
}

export function toAnomalyEventData(
  finding: UsageAnomalyFinding,
  windowMs: number,
): UsageAnomalyDetectedData {
  const windowEnd = new Date(finding.windowStart.getTime() + windowMs);
  return {
    windowStart: finding.windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    currentCalls: finding.currentCalls,
    baselineMean: finding.baselineMean,
    multiplier: finding.multiplier,
    ratio: finding.ratio,
    windowMs,
  };
}

export async function fetchActiveDeveloperIds(pool: Pool, since: Date): Promise<string[]> {
  const result = await pool.query<{ developer_id: string }>(
    `SELECT DISTINCT developer_id
     FROM usage_events
     WHERE created_at >= $1
       AND developer_id IS NOT NULL
       AND developer_id <> ''`,
    [since],
  );
  return result.rows.map((row) => row.developer_id);
}

export async function fetchDeveloperWindowCounts(
  pool: Pool,
  developerId: string,
  from: Date,
  to: Date,
  windowMs: number,
): Promise<WindowCount[]> {
  validateDetectionConfig({
    multiplier: 1,
    baselineWindows: 1,
    windowMs,
  });

  const windowSeconds = windowMs / 1000;
  const result = await pool.query<{ window_start: Date | string; calls: number }>(
    `SELECT
       to_timestamp(floor(extract(epoch from created_at) / $4) * $4) AS window_start,
       COUNT(*)::int AS calls
     FROM usage_events
     WHERE developer_id = $1
       AND created_at >= $2
       AND created_at < $3
     GROUP BY 1
     ORDER BY 1`,
    [developerId, from, to, windowSeconds],
  );

  return result.rows.map((row) => ({
    windowStart: new Date(row.window_start),
    calls: Number(row.calls),
  }));
}

/**
 * Runs one anomaly-detection pass across all developers with recent usage.
 * Emits `usage.anomaly.detected` per developer/window at most once per dedup key.
 */
export async function runAnomalyScan(deps: AnomalyServiceDeps): Promise<AnomalyScanResult> {
  const log = deps.log ?? logger;
  const emit = deps.emit ?? calloraEvents.emit.bind(calloraEvents);
  const now = deps.now ?? (() => new Date());
  const { pool, config, dedup } = deps;

  validateDetectionConfig(config);
  recordUsageAnomalyDetectorRun();

  const correlationId = getOrCreateRequestId(randomUUID);
  const currentTime = now();
  const expectedStarts = buildExpectedWindowStarts(currentTime, config);
  const from = expectedStarts[0];
  const to = new Date(
    expectedStarts[expectedStarts.length - 1].getTime() + config.windowMs,
  );

  let developerIds: string[];
  try {
    developerIds = await fetchActiveDeveloperIds(pool, from);
  } catch (error) {
    log.error('[anomalyService] Failed to list active developers', {
      correlationId,
      error,
    });
    return { developersScanned: 0, anomaliesDetected: 0, anomaliesEmitted: 0 };
  }

  let anomaliesDetected = 0;
  let anomaliesEmitted = 0;

  for (const developerId of developerIds) {
    let actualWindows: WindowCount[];
    try {
      actualWindows = await fetchDeveloperWindowCounts(
        pool,
        developerId,
        from,
        to,
        config.windowMs,
      );
    } catch (error) {
      log.error('[anomalyService] Failed to fetch window counts', {
        correlationId,
        developerId,
        error,
      });
      continue;
    }

    const windows = mergeWindowCounts(expectedStarts, actualWindows);
    const finding = detectDeveloperAnomaly(developerId, windows, config);
    if (!finding) {
      continue;
    }

    anomaliesDetected += 1;
    const dedupKey = anomalyDedupKey(developerId, finding.windowStart);
    if (dedup.has(dedupKey)) {
      continue;
    }
    dedup.set(dedupKey);

    const data = toAnomalyEventData(finding, config.windowMs);
    emit('usage.anomaly.detected', developerId, data);
    recordUsageAnomalyDetectorAnomaly();

    log.info('[anomalyService] Emitted usage.anomaly.detected', {
      correlationId,
      developerId,
      windowStart: data.windowStart,
      currentCalls: data.currentCalls,
      baselineMean: data.baselineMean,
      multiplier: data.multiplier,
      ratio: data.ratio,
    });
    anomaliesEmitted += 1;
  }

  return {
    developersScanned: developerIds.length,
    anomaliesDetected,
    anomaliesEmitted,
  };
}

export function createAnomalyDedupStore(windowMs: number): AnomalyDedupStore {
  if (!Number.isInteger(windowMs) || windowMs <= 0) {
    throw new Error('windowMs must be a positive integer');
  }

  const store = new Map<string, number>();

  return {
    has(key: string): boolean {
      const expiry = store.get(key);
      if (expiry === undefined) {
        return false;
      }
      if (Date.now() > expiry) {
        store.delete(key);
        return false;
      }
      return true;
    },

    set(key: string): void {
      store.set(key, Date.now() + windowMs);
    },
  };
}
