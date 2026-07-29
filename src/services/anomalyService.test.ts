import {
  anomalyDedupKey,
  buildExpectedWindowStarts,
  computeBaselineMean,
  createAnomalyDedupStore,
  detectDeveloperAnomaly,
  floorToWindowStart,
  isAnomalousTraffic,
  mergeWindowCounts,
  runAnomalyScan,
  toAnomalyEventData,
  validateDetectionConfig,
  type WindowCount,
} from './anomalyService.js';

const WINDOW_MS = 5 * 60 * 1000;
const BASELINE_WINDOWS = 12;
const MULTIPLIER = 5;

const config = {
  multiplier: MULTIPLIER,
  baselineWindows: BASELINE_WINDOWS,
  windowMs: WINDOW_MS,
};

const windowAt = (index: number, calls: number, anchor: Date): WindowCount => ({
  windowStart: new Date(anchor.getTime() + index * WINDOW_MS),
  calls,
});

const buildSeries = (
  baselineCalls: number,
  currentCalls: number,
  anchor = new Date('2026-06-01T11:00:00.000Z'),
): WindowCount[] => {
  const now = new Date(anchor.getTime() + (BASELINE_WINDOWS + 1) * WINDOW_MS);
  const starts = buildExpectedWindowStarts(now, config);
  return starts.map((windowStart, index) => ({
    windowStart,
    calls: index < BASELINE_WINDOWS ? baselineCalls : currentCalls,
  }));
};

describe('anomalyService pure helpers', () => {
  it('computes baseline mean over trailing windows', () => {
    expect(computeBaselineMean([10, 20, 30])).toBe(20);
    expect(computeBaselineMean([])).toBe(0);
  });

  it('floors timestamps to fixed window boundaries', () => {
    const date = new Date('2026-06-01T12:07:30.000Z');
    expect(floorToWindowStart(date, WINDOW_MS).toISOString()).toBe(
      '2026-06-01T12:05:00.000Z',
    );
  });

  it('flags traffic above multiplier * baseline', () => {
    expect(isAnomalousTraffic(10, 51, 5)).toBe(true);
    expect(isAnomalousTraffic(10, 50, 5)).toBe(false);
    expect(isAnomalousTraffic(0, 1, 5)).toBe(true);
    expect(isAnomalousTraffic(0, 0, 5)).toBe(false);
  });

  it('rejects invalid detection config at the boundary', () => {
    expect(() => validateDetectionConfig({ ...config, multiplier: 0 })).toThrow(
      'multiplier must be a positive finite number',
    );
    expect(() => validateDetectionConfig({ ...config, baselineWindows: 0 })).toThrow(
      'baselineWindows must be a positive integer',
    );
    expect(() => isAnomalousTraffic(1, -1, 5)).toThrow('currentCalls must be non-negative');
  });

  it('fills missing windows with zero counts', () => {
    const anchor = new Date('2026-06-01T12:00:00.000Z');
    const expected = [
      anchor,
      new Date(anchor.getTime() + WINDOW_MS),
      new Date(anchor.getTime() + 2 * WINDOW_MS),
    ];
    const merged = mergeWindowCounts(expected, [windowAt(1, 7, anchor)]);
    expect(merged).toEqual([
      { windowStart: expected[0], calls: 0 },
      { windowStart: expected[1], calls: 7 },
      { windowStart: expected[2], calls: 0 },
    ]);
  });

  it('detects a 5x baseline spike for one developer', () => {
    const finding = detectDeveloperAnomaly('dev_1', buildSeries(10, 51), config);
    expect(finding).toMatchObject({
      developerId: 'dev_1',
      currentCalls: 51,
      baselineMean: 10,
      multiplier: 5,
    });
    expect(finding?.ratio).toBeCloseTo(5.1, 4);
  });

  it('returns null when traffic stays within the multiplier', () => {
    expect(detectDeveloperAnomaly('dev_1', buildSeries(10, 50), config)).toBeNull();
  });

  it('returns null when there is insufficient history', () => {
    const anchor = new Date('2026-06-01T12:00:00.000Z');
    const shortSeries = [windowAt(0, 1, anchor), windowAt(1, 100, anchor)];
    expect(detectDeveloperAnomaly('dev_1', shortSeries, config)).toBeNull();
  });

  it('builds stable dedup keys and event payloads', () => {
    const finding = detectDeveloperAnomaly('dev_1', buildSeries(2, 20), config)!;
    const key = anomalyDedupKey('dev_1', finding.windowStart);
    expect(key).toContain('dev_1:');

    const data = toAnomalyEventData(finding, WINDOW_MS);
    expect(data.windowEnd).toBe(
      new Date(finding.windowStart.getTime() + WINDOW_MS).toISOString(),
    );
    expect(data.windowMs).toBe(WINDOW_MS);
  });
});

describe('createAnomalyDedupStore', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(1_000_000);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('deduplicates keys within the configured window', () => {
    const dedup = createAnomalyDedupStore(1_000);
    expect(dedup.has('dev:window')).toBe(false);
    dedup.set('dev:window');
    expect(dedup.has('dev:window')).toBe(true);

    jest.setSystemTime(1_001_500);
    expect(dedup.has('dev:window')).toBe(false);
  });
});

describe('runAnomalyScan', () => {
  const anchor = new Date('2026-06-01T11:00:00.000Z');
  const now = new Date(anchor.getTime() + (BASELINE_WINDOWS + 1) * WINDOW_MS);

  const makePool = (options: {
    developers?: string[];
    countsByDeveloper?: Record<string, WindowCount[]>;
  }) => ({
    query: jest.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('DISTINCT developer_id')) {
        return { rows: (options.developers ?? []).map((developer_id) => ({ developer_id })) };
      }

      const developerId = params[0] as string;
      const rows = (options.countsByDeveloper?.[developerId] ?? []).map((window) => ({
        window_start: window.windowStart,
        calls: window.calls,
      }));
      return { rows };
    }),
  });

  it('emits usage.anomaly.detected once per developer window', async () => {
    const emit = jest.fn();
    const dedup = createAnomalyDedupStore(WINDOW_MS);
    const series = buildSeries(10, 100, anchor);

    const result = await runAnomalyScan({
      pool: makePool({
        developers: ['dev_1'],
        countsByDeveloper: { dev_1: series },
      }) as never,
      config,
      dedup,
      now: () => now,
      emit: emit as never,
      log: { info: jest.fn(), error: jest.fn() },
    });

    expect(result).toEqual({
      developersScanned: 1,
      anomaliesDetected: 1,
      anomaliesEmitted: 1,
    });
    expect(emit).toHaveBeenCalledWith(
      'usage.anomaly.detected',
      'dev_1',
      expect.objectContaining({
        currentCalls: 100,
        baselineMean: 10,
        multiplier: MULTIPLIER,
      }),
    );

    emit.mockClear();
    const secondPass = await runAnomalyScan({
      pool: makePool({
        developers: ['dev_1'],
        countsByDeveloper: { dev_1: series },
      }) as never,
      config,
      dedup,
      now: () => now,
      emit: emit as never,
      log: { info: jest.fn(), error: jest.fn() },
    });

    expect(secondPass.anomaliesDetected).toBe(1);
    expect(secondPass.anomaliesEmitted).toBe(0);
    expect(emit).not.toHaveBeenCalled();
  });

  it('scopes detection per developer independently', async () => {
    const emit = jest.fn();
    const dedup = createAnomalyDedupStore(WINDOW_MS);

    await runAnomalyScan({
      pool: makePool({
        developers: ['dev_spike', 'dev_normal'],
        countsByDeveloper: {
          dev_spike: buildSeries(10, 100, anchor),
          dev_normal: buildSeries(10, 12, anchor),
        },
      }) as never,
      config,
      dedup,
      now: () => now,
      emit: emit as never,
      log: { info: jest.fn(), error: jest.fn() },
    });

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('usage.anomaly.detected', 'dev_spike', expect.any(Object));
  });

  it('returns zero counts when developer lookup fails', async () => {
    const pool = {
      query: jest.fn().mockRejectedValue(new Error('db down')),
    };

    const result = await runAnomalyScan({
      pool: pool as never,
      config,
      dedup: createAnomalyDedupStore(WINDOW_MS),
      now: () => now,
      emit: jest.fn() as never,
      log: { info: jest.fn(), error: jest.fn() },
    });

    expect(result).toEqual({
      developersScanned: 0,
      anomaliesDetected: 0,
      anomaliesEmitted: 0,
    });
  });
});
