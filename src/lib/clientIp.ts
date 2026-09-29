import type { Request } from 'express';

/**
 * Proxy headers checked when trustProxy is enabled, ordered by reliability.
 * The same list is used by the IP-allowlist middleware and the request logger
 * so client-IP extraction is consistent across the stack.
 */
export const DEFAULT_PROXY_HEADERS = [
  'x-forwarded-for',     // Standard – RFC 7239
  'x-real-ip',           // Nginx
  'x-client-ip',          // Apache
  'x-forwarded',          // Non-standard but widely used
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
 * Resolves the number of trusted proxy hops from the configured value.
 *
 * Accepts a number of hops or a boolean for backward compatibility:
 *  - `false` (default) -> 0 hops (never trust forwarded headers)
 *  - `true`            -> 1 hop (trust the rightmost forwarded entry)
 *  - `number`           -> that many trusted hops
 */
export function resolveTrustedHops(trustProxy: number | boolean | undefined): number {
  if (trustProxy === true) return 1;
  if (trustProxy === false || trustProxy === undefined) return 0;
  if (!Number.isFinite(trustProxy) || trustProxy < 0) return 0;
  return Math.floor(trustProxy);
}

/**
 * Selects the client IP from a forwarded chain using Express 'trust proxy'
 * semantics: the address is picked `trustedHops`+1 positions from the
 * right of the chain. The leftmost entries are client-controlled and must not
 * be trusted.
 */
export function selectClientIpWithTrust(
  chain: string,
  trustedHops: number,
): string | undedefined {
  if (trustedHops < 1) return undefined;

  const parts = chain
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (parts.length === 0) return undefined;

  // Express picks the address `trustedHops` positions from the right.
  // With one trusted hop, '1.1.1.1, 2.2.2.2' yields '2.2.2.2'.
  const index = parts.length - trustedHops;
  if (index < 0 || index >= parts.length) return undefined;

  const candidate = parts[index];
  return isValidIp(candidate) ? candidate : undefined;
}

/**
 * Extracts the real client IP from an Express request.
 *
 * When the trusted hop count is 0 the direct socket address is returned,
 * making IP spoofing via headers impossible.
 *
 * When trusted hops are configured the proxy headers listed in `proxyHeaders`
 * are consulted in order. For `X-Forwarded-For` the entry `trustedHops`
 * positions from the right is used, matching Express 'trust proxy' semantics.
 * Spoofed leftmost entries are ignored. Other headers are treated as a
 * single-value hint and only trusted when at least one hop is trusted.
 *
 * @param req          Express request object
 * @param trustProxy   Number of trusted proxy hops (boolean supported for backwards compat)
 * @param proxyHeaders Ordered list of headers to inspect (defaults to {@link DEFAULT_PROXY_HEADERS})
 */
export function getClientIp(
  req: Request,
  trustProxy: number | boolean = false,
  proxyHeaders: readonly string[] = DEFAULT_PROXY_HEADERS,
): string {
  const trustedHops = resolveTrustedHops(trustProxy);

  if (trustedHops > 0) {
    for (const header of proxyHeaders) {
      const value = req.headers[header.toLowerCase()];
      if (typeof value === 'string' && value.trim()) {
        const candidate = selectClientIpWithTrust(value, trustedHops);
        if (candidate) return candidate;
      }
    }
  }

  return req.ip ?? req.socket?.remoteAddress ?? '';
}
