/**
 * Express middleware that records per-route latency+status samples into
 * SloAnalysisWindows for configured (method, route) pairs; populates the
 * global registry consumed by the worker.
 *
 * Only routes that have been explicitly configured via `initSloRecorder`
 * are recorded — unconfigured routes fast-return after a `Map.get` lookup
 * so the middleware adds at most a few microseconds to the request
 * pipeline.
 *
 * The middleware reuses the same route-normalisation helper as
 * `metricsMiddleware` (`normalizeRouteForMetrics`) so that the route label
 * stored in the recorder matches the label emitted to Prometheus,
 * allowing operators to cross-check the two observability streams.
 */

import type { Request, Response, NextFunction } from 'express';
import { performance } from 'node:perf_hooks';

import { logger } from '../logger.js';
import { normalizeRouteForMetrics, recordSloRecorderSample } from '../metrics.js';
import {
  createSloAnalysisWindow,
  sloConfigKey,
  type SloRouteConfig,
  SloAnalysisWindow,
} from '../services/sloService.js';

// ─────────────────────────────────────────────────────────────────────────────
// Internal state
// ─────────────────────────────────────────────────────────────────────────────

interface RecorderState {
  configsByKey: ReadonlyMap<string, SloRouteConfig>;
  windowsByKey: ReadonlyMap<string, SloAnalysisWindow>;
}

let state: RecorderState = {
  configsByKey: new Map(),
  windowsByKey: new Map(),
};

export interface SloRecorderInitOptions {
  configs: readonly SloRouteConfig[];
  observationWindowMs: number;
}

/**
 * Replace the global recorder state. Safe to call multiple times — each call
 * discards all previously buffered samples.
 *
 * Throws on invalid options so misconfiguration is caught at boot.
 */
export function initSloRecorder(options: SloRecorderInitOptions): void {
  if (
    !Number.isFinite(options.observationWindowMs) ||
    options.observationWindowMs <= 0
  ) {
    throw new Error('observationWindowMs must be a positive number');
  }
  if (!Array.isArray(options.configs)) {
    throw new Error('configs must be an array');
  }

  const configsByKey = new Map<string, SloRouteConfig>();
  const windowsByKey = new Map<string, SloAnalysisWindow>();

  for (const config of options.configs) {
    if (
      !config ||
      typeof config.method !== 'string' ||
      typeof config.route !== 'string'
    ) {
      throw new Error('Invalid SLO route config: method and route must be strings');
    }
    if (!config.method || !config.route) {
      throw new Error('Invalid SLO route config: method and route must be non-empty');
    }
    const key = sloConfigKey(config.method, config.route);
    if (configsByKey.has(key)) {
      logger.warn(
        `[sloAlertRecorder] Duplicate SLO config for ${key}; keeping the first entry.`,
      );
      continue;
    }
    configsByKey.set(key, config);
    windowsByKey.set(
      key,
      createSloAnalysisWindow({ windowMs: options.observationWindowMs }),
    );
  }

  state = { configsByKey, windowsByKey };
}

/** Reset the recorder entirely (used between test cases). */
export function resetSloRecorder(): void {
  state = {
    configsByKey: new Map(),
    windowsByKey: new Map(),
  };
}

/** Returns the analysis window for a given (method, route) – undefined when unconfigured. */
export function getSloWindow(method: string, route: string): SloAnalysisWindow | undefined {
  return state.windowsByKey.get(sloConfigKey(method, route));
}

/** Read-only snapshot of all configured route windows for the worker. */
export function getAllSloWindows(): ReadonlyMap<string, SloAnalysisWindow> {
  return state.windowsByKey;
}

/** Read-only snapshot of all configured route configs for the worker. */
export function getSloConfigs(): ReadonlyMap<string, SloRouteConfig> {
  return state.configsByKey;
}

// ─────────────────────────────────────────────────────────────────────────────
// Express middleware
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-request middleware. Records (statusCode, durationMs) for configured
 * routes on response finish. Any exception thrown during sampling is logged
 * and swallowed so the recorder can never break the request pipeline.
 */
export const sloRecorderMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const startMark = performance.now();

  // Capture finish instead of awaiting a Promise. Using `.once` keeps the
  // listener footprint minimal and matches `metricsMiddleware` semantics.
  res.once('finish', () => {
    try {
      const routePattern = normalizeRouteForMetrics(
        req.route?.path,
        req.baseUrl,
        req.path,
      );
      const key = sloConfigKey(req.method, routePattern);
      const window = state.windowsByKey.get(key);
      if (!window) {
        // Not an SLO-managed route – pay nothing beyond a Map miss.
        return;
      }
      const durationMs = performance.now() - startMark;
      window.addSample(res.statusCode, durationMs);
      recordSloRecorderSample(key);
    } catch (err) {
      logger.error('[sloAlertRecorder] Failed to record sample', err);
    }
  });

  next();
};
