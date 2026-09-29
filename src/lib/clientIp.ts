import type { Request } from 'express';

import ipRangeCheck from 'ip-range-check';

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
  'cf-connecting-ip',    // Cloudflare
  'x-aws-client-ip',     // AWS ALB
] as const;

/** Returns true for a plausible IPv4 or IPv6 address string. */
export function isValidIp(ip: string): boolean {
  const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/;
  const ipv6 = /^([0-9a-fA-F]{0,4}:){2}{2,7}[0-9a-fA-F]{0,4}$/;
  return ipv4.test(ip) || ipv6.test(ip) || ip.includes(':');
}

/**
 * Trust proxy configuration.
 *
 * - `false` (default): no proxy headers are trusted; the socket address is used.
 * - `number`: the number of trusted proxy hops between the client and the
 *   application. The client IP selected from the forwarded chain is taken
 *   that many positions from the right.
 * - `string[]`: a list of trusted proxy CIDRs. The forwarded chain is walked
 *   from the right, skipping addresses that fall within the trusted CIDRs,
 *   until the first untrusted address is found.
 */
export type TrustProxy = boolean | number | readonly string[];

/** Normalises an IP for comparison (lowercase, no brackets/port). */
function normalizeIp(ip: string): string {
  let value = ip.trim().toLowerCase();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end !== -1) {
      value = value.slice(1, end);
    }
  } else if (/^\d+\.\d+\.\d+\.\d+:/.test(value)) {
    // IPv4 with port
    value = value.split(':')[0];
  }
  return value;
}

/** Returns true when the IP falls within any of the trusted proxy CIDRs. */
function isTrustedProxyIp(ip: string, trustedCidrs: readonly string[]): boolean {
  if (trustedCidrs.length === 0) return false;
  try {
    return ipRangeCheck(ip, trustedCidrs as string[]);
  } catch {
    return false;
  }
}

/**
 * Selects the client IP from a forwarded-for chain given a trust configuration.
 *
 * The chain is the comma-separated value of a forwarded header, ordered
 * client-first. The rightmost entry is the address added by the closest
 * trusted proxy, so it is the only one that can be trusted by default.
 */
export function selectClientIpWithTrust(
  chain: readonly string[],
  trustProxy: TrustProxy,
): string | undefined {
  if (chain.length === 0) return undefined;

  if (trustProxy === true) {
    // Backwards-compatible boolean: trust exactly one hop.
    trustProxy = 1;
  }

  if (trustProxy === false) {
    return undefined;
  }

  if (typeof trustProxy === 'number') {
    if (!Number.isFinite(trustProxy) || trustProxy < 1) return undefined;
    const index = chain.length - trustProxy;
    if (index < 0 || index >= chain.length) return undefined;
    return chain[index];
  }

  // CIDR list: walk from the right, skipping trusted proxies.
  const trustedCidrs = trustProxy as readonly string[];
  for (let i = chain.length - 1; i >= 0; i--) {
    const candidate = chain[i];
    if (!isTrustedProxyIp(candidate, trustedCidrs)) {
      return candidate;
    }
  }

  // Every hop is trusted; fall back to the leftmost entry.
  return chain[0];
}

/**
 * Extracts the real client IP from an Express request.
 *
 * When `trustProxy` is false (the default) the direct socket address is
 * returned, making IP spoofing via headers impossible.
 *
 * When `trustProxy` is a number or a CIDR list, the proxy headers listed in
 * `proxyHeaders` are consulted in order; the first header that yields a valid
 * client IP wins. For `x-forwarded-for` the entry is selected from the right
 * according to the trust configuration, so client-controlled leftmost entries
 * cannot be used to spoof an address.
 *
 * @param req          Express request object
 * @param trustProxy   Trust configuration (false | hop count | trusted CIDRs)
 * @param proxyHeaders Ordered list of headers to inspect (defaults to {@link DEFAULT_PROXY_HEADERS})
 */
export function getClientIp(
  req: Request,
  trustProxy: TrustProxy = false,
  proxyHeaders: readonly string[] = DEFAULT_PROXY_HEADERS,
): string {
  const socketIp = req.ip ?? req.socket?.remoteAddress ?? '';

  if (trustProxy !== false) {
    for (const header of proxyHeaders) {
      const value = req.headers[header.toLowerCase()];
      if (typeof value !== 'string' || !value.trim()) continue;

      const chain = value
        .split(',')
        .map((entry) => normalizeIp(entry))
        .filter((entry) => isValidIp(entry));

      if (chain.length === 0) continue;

      const selected = selectClientIpWithTrust(chain, trustProxy);
      if (selected && isValidIp(selected)) return selected;
    }
  }

  return socketIp;
}
