/**
 * Dashboard ↔ metric-registration alignment.
 *
 * Grafana dashboards under docs/ query Prometheus metric names that must match
 * the names actually registered in code. A dashboard panel that references a
 * metric which is never registered (or never exposed by GET /api/metrics)
 * silently renders "No data" during incidents.
 *
 * These tests parse every PromQL expression in the committed dashboard JSON
 * files, extract the metric selectors, and assert that each one is:
 *   1. registered somewhere in the codebase (src/metrics.ts or
 *      src/metrics/registry.ts), and
 *   2. actually exposed by the /api/metrics endpoint (the registry that
 *      Prometheus scrapes).
 *
 * See docs/dashboards/README.md for the panel → metric mapping.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import client from 'prom-client';
import { register } from '../metrics.js';
// Import for side effects: registers every histogram defined in registry.ts.
import '../metrics/registry.js';

interface GrafanaTarget {
  expr?: string;
}

interface GrafanaPanel {
  title?: string;
  panels?: GrafanaPanel[];
  targets?: GrafanaTarget[];
}

interface GrafanaDashboard {
  title?: string;
  panels?: GrafanaPanel[];
}

const REPO_ROOT = resolve(__dirname, '..', '..');

const DASHBOARD_FILES = [
  resolve(REPO_ROOT, 'docs', 'dashboards', 'soroban-billing.json'),
  resolve(REPO_ROOT, 'docs', 'grafana-dashboard-billing-deduct.json'),
] as const;

/** PromQL keywords/aggregators that are never metric names. */
const PROMQL_KEYWORDS = new Set([
  'by',
  'without',
  'on',
  'ignoring',
  'group_left',
  'group_right',
  'offset',
  'bool',
  'and',
  'or',
  'unless',
  'inf',
  'nan',
]);

/**
 * Extract the metric selector names from a PromQL expression.
 *
 * The parse strips template variables, label matchers, aggregation `by`/`without`
 * clauses and function call names, leaving only what Prometheus would treat as
 * a metric selector. This intentionally avoids treating functions such as
 * `histogram_quantile`, `rate`, or `sum` as metrics.
 */
export function extractMetricNames(expr: string): string[] {
  const withoutStrings = expr.replace(/\{[^}]*\}/g, '');
  const withoutVariables = withoutStrings.replace(/\$[A-Za-z0-9_]+/g, '');
  const withoutGrouping = withoutVariables.replace(
    /\b(by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)/g,
    '',
  );
  const withoutFunctions = withoutGrouping.replace(
    /([A-Za-z_:][A-Za-z0-9_:]*)\s*\(/g,
    '(',
  );

  const identifiers = withoutFunctions.match(/[A-Za-z_:][A-Za-z0-9_:]*/g) ?? [];
  return [...new Set(identifiers.filter((id) => !PROMQL_KEYWORDS.has(id)))];
}

function flattenPanels(panels: GrafanaPanel[] = []): GrafanaPanel[] {
  return panels.flatMap((panel) => [panel, ...flattenPanels(panel.panels)]);
}

function collectMetricNamesFromDashboard(file: string): Map<string, string[]> {
  const dashboard = JSON.parse(readFileSync(file, 'utf8')) as GrafanaDashboard;
  const references = new Map<string, string[]>();

  for (const panel of flattenPanels(dashboard.panels)) {
    for (const target of panel.targets ?? []) {
      if (!target.expr) continue;
      for (const name of extractMetricNames(target.expr)) {
        const panels = references.get(name) ?? [];
        if (panel.title && !panels.includes(panel.title)) panels.push(panel.title);
        references.set(name, panels);
      }
    }
  }

  return references;
}

/**
 * Build the set of metric names a registry emits, expanding histogram and
 * summary base names into their `_bucket` / `_sum` / `_count` series.
 */
async function collectEmittedMetricNames(
  registry: client.Registry,
): Promise<Set<string>> {
  const metrics = await registry.getMetricsAsJSON();
  const names = new Set<string>();

  for (const metric of metrics) {
    names.add(metric.name);
    // prom-client types `type` as an enum but emits a lowercase string at runtime.
    const type = metric.type as unknown as string;
    if (type === 'histogram') {
      names.add(`${metric.name}_bucket`);
      names.add(`${metric.name}_sum`);
      names.add(`${metric.name}_count`);
    } else if (type === 'summary') {
      names.add(`${metric.name}_sum`);
      names.add(`${metric.name}_count`);
    }
  }

  return names;
}

/** Every metric name registered in either code registry. */
async function collectCodeMetricNames(): Promise<Set<string>> {
  const served = await collectEmittedMetricNames(register);
  const defaults = await collectEmittedMetricNames(client.register);
  return new Set([...served, ...defaults]);
}

describe('dashboard PromQL metric extraction', () => {
  it('extracts the metric selector and ignores PromQL functions/keywords', () => {
    const expr =
      'histogram_quantile(0.95, sum by (le) (rate(billing_deduct_duration_seconds_bucket{route="/api/billing/deduct"}[$__rate_interval])))';
    expect(extractMetricNames(expr)).toEqual(['billing_deduct_duration_seconds_bucket']);
  });

  it('extracts multiple metrics from a success-ratio expression', () => {
    const expr =
      'sum(rate(http_requests_total{route="/api/billing/deduct",status_code="200"}[$__rate_interval])) / sum(rate(http_requests_total{route="/api/billing/deduct"}[$__rate_interval]))';
    expect(extractMetricNames(expr)).toEqual(['http_requests_total']);
  });

  it('does not treat function or label names as metrics', () => {
    const expr =
      'sum by (status_code) (increase(http_requests_total{route="/api/billing/deduct"}[$__range]))';
    expect(extractMetricNames(expr)).toEqual(['http_requests_total']);
  });
});

describe('dashboard metric alignment', () => {
  it.each(DASHBOARD_FILES)(
    'references only metrics registered in code: %s',
    async (file) => {
      const registered = await collectCodeMetricNames();
      const references = collectMetricNamesFromDashboard(file);
      const unknown = [...references.keys()].filter((name) => !registered.has(name));

      expect(unknown).toEqual([]);
    },
  );

  it.each(DASHBOARD_FILES)(
    'references only metrics exposed by GET /api/metrics: %s',
    async (file) => {
      const exposed = await collectEmittedMetricNames(register);
      const references = collectMetricNamesFromDashboard(file);
      const missing = [...references.keys()].filter((name) => !exposed.has(name));

      expect(missing).toEqual([]);
    },
  );

  it('finds at least one metric reference in each dashboard', () => {
    for (const file of DASHBOARD_FILES) {
      const references = collectMetricNamesFromDashboard(file);
      expect(references.size).toBeGreaterThan(0);
    }
  });
});
