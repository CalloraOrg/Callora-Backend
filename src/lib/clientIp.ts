import type { Request } from 'express';

/**
 * Proxy headers checked when trustProxy is enabled, ordered by reliability.
 * The same list is used by the IP-allowlist middleware and the request logger
 * so client-IP extraction is consistent across the stack.
 */
export const DEFAULT_PROXY_HEADERS = [
  'x-forwarded-for',     // Standard – RFC 7239
  'x-real-ip',           // Nginx
  'x-client-ip',         // Apache
  'x-forwarded',         // Non-standard but widely used
  'x-cluster-client-ip', // Load balancers
  'x-aws-client-ip',      // AWS ALB
  'cf-connecting-ip',    // Cloudflare
] as const;

/** Returns true for a plausible IPv4 or IPv6 address string. */
export function isValidIp(ip: string): boolean {
  if (!ip || typeof ip !== 'string') {
    return false;
  }
  const trimmed = ip.trim();
  if (!trimmed) {
    return false;
  }

  // IPv4 address with optional port suffix is not accepted here.
  const ipv4 = /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)$/;
  if (ipv4.test(trimmed)) {
    return true;
  }

  // IPv6 address (compressed forms included). Use the built-in URL checker via
  // a simple regex that covers the common cases and rejects obvious garbage.
  const ipv6 = /^(?:[0-9a-fA-F]{1,4}:|:)(?:[0-9a-fA-F]{1,4}:)*(?:[0-9a-fA-F]{1,4}|:)$/;
  if (trimmed.includes(':') && ipv6.test(trimmed)) {
    return true;
  }

  return false;
}

export type TrustProxy = number;

/**
 * Derive the client IP from trusted proxy hops.
 *
 * @param req - Express request
 * @param trustedProxyHops - Number of trusted reverse proxies in front of the
 *   application. 0 means no proxy is trusted and the socket address is used.
 *   N means the entry N positions from the right of the forwarded chain is
 *   selected.
 * @param headers - Ordered list of proxy headers to consider.
 */
export function getClientIp(
  req: Request,
  trustedProxyHops: TrustProxy = 0,
  headers: readonly string[] = DEFAULT_PROXY_HEADERS,
): string {
  const socketIp = getSocketIp(req);

  if (!trustedProxyHops || trustedProxyHops <= 0) {
    return socketIp;
  }

  for (const headerName of headers) {
    const rawValue = req.headers[headerName.toLowerCase()];
    const value = Array.isArray(rawValue) ? rawValue.join(','): rawValue;
    if (typeof value !== 'string' || !value.trim()) {
      continue;
    }

    const entries = value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    if (entries.length < trustedProxyHops) {
      // Header is shorter than the trusted hop count; fail closed.
      continue;
    }

    const index = entries.length - trustedProxyHops;
    const candidate = entries[index];
    if (candidate && isValidIp(candidate)) {
      return candidate;
    }
  }

  return socketIp;
}

function getSocketIp(req: Request): string {
  const socketAddress = req.socket?.remoteAddress;
  if (typeof socketAddress === 'string' && socketAddress) {
    return socketAddress;
  }
  if (typeof req.ip === 'string' && req.ip) {
    return req.ip;
  }
  return '';
}
