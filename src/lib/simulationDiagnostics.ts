export interface SimulationDetails {
  errorCode?: string | number;
  errorMessage?: string;
  events?: unknown[];
  footprint?: unknown;
}

export interface RedactedSimulationDetails {
  errorCode?: string | number;
  errorMessage?: string;
  eventCount?: number;
  footprintPresent?: boolean;
}

const SENSITIVE_KEY_PATTERN = /(address|account|balance|secret|key|xdr|hash|signature|source|destination|contract)/i;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function pickFirst(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function findNested(record: Record<string, unknown>, keys: string[], depth = 0): unknown {
  const direct = pickFirst(record, keys);
  if (direct !== undefined || depth >= 3) return direct;

  for (const value of Object.values(record)) {
    const child = asRecord(value);
    if (!child) continue;
    const nested = findNested(child, keys, depth + 1);
    if (nested !== undefined) return nested;
  }

  return undefined;
}

function normalizeMessage(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.replace(/\s+/g, ' ').trim();
    return trimmed || undefined;
  }
  if (value instanceof Error) return normalizeMessage(value.message);
  return undefined;
}

function normalizeErrorCode(value: unknown): string | number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  return undefined;
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[TRUNCATED]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > 80 ? `${value.slice(0, 77)}...` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();

  if (Array.isArray(value)) {
    return value.slice(0, 10).map((entry) => sanitizeValue(entry, depth + 1));
  }

  const record = asRecord(value);
  if (!record) return String(value);

  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    sanitized[key] = SENSITIVE_KEY_PATTERN.test(key) ? '[REDACTED]' : sanitizeValue(child, depth + 1);
  }
  return sanitized;
}

export function extractSimulationDetails(payload: unknown): SimulationDetails {
  const record = asRecord(payload);
  if (!record) {
    return {
      errorMessage: normalizeMessage(payload) ?? 'Malformed simulation diagnostics',
    };
  }

  const errorRecord = asRecord(findNested(record, ['error'])) ?? record;
  const events = findNested(record, ['events']);
  const footprint = findNested(record, ['footprint', 'transactionData', 'transaction_data']);
  const errorCode = normalizeErrorCode(findNested(errorRecord, ['code', 'errorCode', 'error_code']));
  const errorMessage =
    normalizeMessage(findNested(errorRecord, ['message', 'errorMessage', 'detail', 'details', 'title'])) ??
    normalizeMessage(findNested(record, ['message', 'errorMessage', 'detail', 'details', 'title']));

  return {
    ...(errorCode !== undefined ? { errorCode } : {}),
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    ...(Array.isArray(events) ? { events: sanitizeValue(events) as unknown[] } : {}),
    ...(footprint !== undefined ? { footprint: sanitizeValue(footprint) } : {}),
  };
}

export function redactSimulationDetails(details: unknown): RedactedSimulationDetails {
  const normalized = extractSimulationDetails(details);
  return {
    ...(normalized.errorCode !== undefined ? { errorCode: normalized.errorCode } : {}),
    ...(normalized.errorMessage !== undefined ? { errorMessage: normalized.errorMessage } : {}),
    eventCount: Array.isArray(normalized.events) ? normalized.events.length : 0,
    footprintPresent: normalized.footprint !== undefined,
  };
}
