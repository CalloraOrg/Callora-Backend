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
  'cf-connecting-ip',    // Cloudflare
  'x-aws-client-ip',     // AWS ALB
] as const;

/** Returns true for a plausible IPv4 or IPv6 address string. */
export function isValidIp(ip: string): boolean {
  const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/;
  const ipv6 = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;
  return ipv4.test(ip) || ipv6.test(ip) || ip.includes(':');
}

/**
 * Extracts the real client IP from an Express request.
 *
 * When `trustProxy` is false (the default) the direct socket address is
 * returned, making IP spoofing via headers impossible.
 *
 * When `trustProxy` is true the proxy headers listed in `proxyHeaders` are
 * consulted in order; the first valid IP wins.  For `x-forwarded-for` only
 * the leftmost entry is used because that is the original client address —
 * subsequent entries are added by intermediary proxies and must not be trusted
 * as the client origin.
 *
 * @param req          Express request object
 * @param trustProxy   Whether to honour proxy forwarding headers
 * @param proxyHeaders Ordered list of headers to inspect (defaults to {@link DEFAULT_PROXY_HEADERS})
 */
export function getClientIp(
  req: Request,
  trustProxy = false,
  proxyHeaders: readonly string[] = DEFAULT_PROXY_HEADERS,
): string {
  if (trustProxy) {
    for (const header of proxyHeaders) {
      const value = req.headers[header.toLowerCase()];
      if (typeof value === 'string' && value.trim()) {
        const firstIp = value.split(',')[0].trim();
        if (isValidIp(firstIp)) return firstIp;
      }
    }
  }

  return req.ip ?? req.socket?.remoteAddress ?? '';
}
