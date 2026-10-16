import dns from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import ipRangeCheck from 'ip-range-check';

const BLOCKED_IP_RANGES = [
  '10.0.0.0/8',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10',
  '198.18.0.0/15',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
] as const;

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1'] as const;

export const DEFAULT_UPSTREAM_HOST_ALLOWLIST: readonly string[] = [];

export const DEVELOPMENT_UPSTREAM_HOST_ALLOWLIST: readonly string[] = [
  '*',
  ...LOOPBACK_HOSTS,
] as const;

export interface UpstreamTargetValidationOptions {
  allowedHosts?: readonly string[];
}

function isDevelopmentOrTestEnvironment(): boolean {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  return nodeEnv === 'development' || nodeEnv === 'test';
}

export function getDefaultUpstreamHostAllowlist(): readonly string[] {
  return isDevelopmentOrTestEnvironment()
    ? DEVELOPMENT_UPSTREAM_HOST_ALLOWLIST
    : DEFAULT_UPSTREAM_HOST_ALLOWLIST;
}

function normalizeHost(host: string): string {
  const trimmed = host.trim().toLowerCase();

  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function normalizeAllowEntry(entry: string): string {
  return normalizeHost(entry).replace(/\.$/, '');
}

export function parseUpstreamHostAllowlist(rawValue: string | undefined): string[] {
  const entries = (rawValue ?? '')
    .split(',')
    .map((entry) => normalizeAllowEntry(entry))
    .filter(Boolean);

  if (entries.length === 0) {
    return [...getDefaultUpstreamHostAllowlist()];
  }

  return [...new Set(entries)];
}

function getAllowedHosts(options?: UpstreamTargetValidationOptions): readonly string[] {
  return options?.allowedHosts !== undefined
    ? options.allowedHosts.map((entry) => normalizeAllowEntry(entry))
    : getDefaultUpstreamHostAllowlist();
}

function matchesAllowEntry(host: string, entry: string): boolean {
  if (entry === '*') {
    return true;
  }

  if (entry.startsWith('*.')) {
    const suffix = entry.slice(2);
    return host === suffix || host.endsWith(`.${suffix}`);
  }

  return host === entry;
}

function isExplicitlyAllowed(host: string, allowlist: readonly string[]): boolean {
  return allowlist.some((entry) => entry !== '*' && matchesAllowEntry(host, entry));
}

function isAllowedHost(host: string, allowlist: readonly string[]): boolean {
  return allowlist.some((entry) => matchesAllowEntry(host, entry));
}

function isBlockedIpAddress(host: string): boolean {
  return isIP(host) !== 0 && ipRangeCheck(host, [...BLOCKED_IP_RANGES]);
}

function isLoopbackHost(host: string): boolean {
  return (LOOPBACK_HOSTS as readonly string[]).includes(host);
}

const INTERNAL_QUERY_PARAM_NAMES = new Set([
  'api_key',
  'apikey',
  'x-api-key',
  'x_api_key',
]);

/**
 * Sanitizes a raw query string (without leading '?') by stripping gateway-internal
 * authentication query parameters while preserving original percent-encoding and
 * parameter ordering for all remaining parameters.
 */
export function sanitizeUpstreamQueryString(rawQuery?: string): string {
  if (!rawQuery) {
    return '';
  }

  const withoutPrefix = rawQuery.startsWith('?') ? rawQuery.slice(1) : rawQuery;
  if (!withoutPrefix) {
    return '';
  }

  const keptSegments = withoutPrefix
    .split('&')
    .filter((segment) => {
      if (!segment) {
        return false;
      }
      const eqIndex = segment.indexOf('=');
      const rawKey = eqIndex >= 0 ? segment.slice(0, eqIndex) : segment;
      let decodedKey = rawKey;
      try {
        decodedKey = decodeURIComponent(rawKey);
      } catch {
        // Preserve raw key if malformed percent-encoding is encountered
      }
      return !INTERNAL_QUERY_PARAM_NAMES.has(decodedKey.trim().toLowerCase());
    });

  return keptSegments.join('&');
}

function parseAndValidateBaseUrl(
  rawUrl: string,
  options?: UpstreamTargetValidationOptions,
  allowQueryString = false,
): { canonicalUrl: string; host: string; allowlist: readonly string[] } {
  const trimmedUrl = rawUrl.trim();
  let parsed: URL;

  try {
    parsed = new URL(trimmedUrl);
  } catch {
    throw new Error('base_url must be a valid absolute URL.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('base_url must use http or https.');
  }

  if (!parsed.hostname) {
    throw new Error('base_url must include a hostname.');
  }

  if (parsed.username || parsed.password) {
    throw new Error('base_url must not include embedded credentials.');
  }

  if (parsed.hash || (!allowQueryString && parsed.search)) {
    throw new Error('base_url must not include query strings or fragments.');
  }

  const allowlist = getAllowedHosts(options);
  const normalizedHost = normalizeHost(parsed.hostname);

  if (!isAllowedHost(normalizedHost, allowlist)) {
    throw new Error(
      `base_url host "${normalizedHost}" is not in the configured upstream allowlist.`,
    );
  }

  if (isBlockedIpAddress(normalizedHost) && !isExplicitlyAllowed(normalizedHost, allowlist)) {
    throw new Error(
      `base_url host "${normalizedHost}" resolves to a private or loopback IP range and is not allowed.`,
    );
  }

  if (isLoopbackHost(normalizedHost) && !isDevelopmentOrTestEnvironment()) {
    throw new Error(
      `base_url host "${normalizedHost}" is a loopback host and is not allowed in this environment.`,
    );
  }

  return {
    canonicalUrl: trimmedUrl,
    host: normalizedHost,
    allowlist,
  };
}

export function validateUpstreamBaseUrl(
  rawUrl: string,
  options?: UpstreamTargetValidationOptions,
): string {
  return parseAndValidateBaseUrl(rawUrl, options, false).canonicalUrl;
}

export async function validateResolvedUpstreamTarget(
  rawUrl: string,
  options?: UpstreamTargetValidationOptions,
): Promise<string> {
  const { canonicalUrl, host, allowlist } = parseAndValidateBaseUrl(rawUrl, options, true);

  if (isIP(host) !== 0) {
    return canonicalUrl;
  }

  let addresses: LookupAddress[];

  try {
    addresses = await dns.lookup(host, { all: true });
  } catch {
    throw new Error(`base_url host "${host}" could not be resolved.`);
  }

  if (!addresses.length) {
    throw new Error(`base_url host "${host}" did not resolve to an address.`);
  }

  for (const address of addresses) {
    if (isBlockedIpAddress(address.address) && !isExplicitlyAllowed(host, allowlist)) {
      throw new Error(
        `base_url host "${host}" resolves to a private or loopback IP range and is not allowed.`,
      );
    }
  }

  return canonicalUrl;
}

export function buildUpstreamTargetUrl(
  baseUrl: string,
  path: string,
  rawQuery?: string,
): string {
  const parsed = new URL(baseUrl);
  if (parsed.search || parsed.hash) {
    throw new Error('base_url must not include query strings or fragments.');
  }

  const normalizedPath = path.replace(/^\/+/, '');

  if (normalizedPath) {
    const basePath = parsed.pathname.endsWith('/')
      ? parsed.pathname
      : `${parsed.pathname}/`;
    parsed.pathname = `${basePath}${normalizedPath}`;
  }

  const baseTarget = parsed.toString();
  const sanitizedQuery = sanitizeUpstreamQueryString(rawQuery);

  return sanitizedQuery ? `${baseTarget}?${sanitizedQuery}` : baseTarget;
}

