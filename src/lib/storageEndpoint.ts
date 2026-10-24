import { isIP } from 'node:net';
import ipRangeCheck from 'ip-range-check';

const BLOCKED_IP_RANGES = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '::/128',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
  'ff00::/8',
];

export interface StorageEndpointOptions {
  production?: boolean;
  allowedHosts?: readonly string[];
}

function normalizedHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
}

function mappedIpv4(hostname: string): string | undefined {
  const match = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(hostname);
  if (match) return match[1];
  const hexMatch = /^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/i.exec(hostname);
  if (!hexMatch) return undefined;
  const high = Number.parseInt(hexMatch[1], 16);
  const low = Number.parseInt(hexMatch[2], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

function isBlockedIp(hostname: string): boolean {
  const mappedAddress = mappedIpv4(hostname);
  if (mappedAddress) return true;
  const address = hostname;
  return isIP(address) !== 0 && ipRangeCheck(address, BLOCKED_IP_RANGES);
}

function matchesAllowedHost(hostname: string, allowedHosts: readonly string[]): boolean {
  return allowedHosts.some((entry) => {
    const allowed = normalizedHost(entry.trim());
    if (!allowed) return false;
    if (allowed.startsWith('*.')) {
      const suffix = allowed.slice(1);
      return hostname.endsWith(suffix) && hostname !== suffix.slice(1);
    }
    return hostname === allowed;
  });
}

export function validateStorageEndpoint(
  rawUrl: string,
  options: StorageEndpointOptions = {},
): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error('s3Endpoint must be a valid absolute URL.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('s3Endpoint must use http or https.');
  }
  if (options.production && parsed.protocol !== 'https:') {
    throw new Error('s3Endpoint must use HTTPS in production.');
  }
  if (!parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('s3Endpoint must include a hostname and must not include credentials, query strings, or fragments.');
  }

  const hostname = normalizedHost(parsed.hostname);
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    isBlockedIp(hostname)
  ) {
    throw new Error('s3Endpoint must not target a private, loopback, link-local, or reserved host.');
  }

  if (options.allowedHosts?.length && !matchesAllowedHost(hostname, options.allowedHosts)) {
    throw new Error(`s3Endpoint host "${hostname}" is not in the configured export allowlist.`);
  }

  return parsed.toString().replace(/\/$/, '');
}