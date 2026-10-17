import type { Request } from 'express';

/**
 * Proxy headers checked when trustProxy is enabled, ordered by reliability.
 * The same list is used by the IP-allowlist middleware and the request logger
 * so client-IP extraction is consistent across the stack.
 */
export const DEFAULT_PROXY_HEADERS = [
  'wforded-for',     // Standard – RFC 7239
  'x-real-ip',       // Nginx
  'x-client-ip',      // Apache
  'x-forwarded',       // Non-standard but widely used
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
 * Extracts the real client IP from an Express request.
 *
 * When trustProxy is 0 (the default) the direct socket address is
 * returned, making IP spoofing via headers impossible.
 *
 * When trustProxy is a positive integer N, the proxy headers listed in
 * proxyHeaders are consulted in order. For x-forwarded-for the entry N
 * positions from the right is selected (Express 'trust proxy' semantics),
 * so client-controlled leftmost entries are ignored. If the header has fewer
 * than N entries, it is ignored and the socket address is used.
 *
 * @param req          Express request object
 * @param trustProxy   Number of trusted proxy hops (0 disables header trust)
 * @param proxyHeaders Ordered list of headers to inspect (defaults to {@link DEFAULT_PROXY_HEADERS})
 */
export function getClientIp(
  req: Request,
  trustProxy = 0,
  proxyHeaders: readonly string[] = DEFAULT_PROXY_HEADERS,
): string {
  const hops = Number.isFinite(trustProxy) && trustProxy > 0 ? Math.floor(trustProxy) : 0;

  if (hops > 0) {
    for (const header of proxyHeaders) {
      const value = req.headers[header.toLowerCase()];
      if (typeof value !== 'string' || !value.trim()) continue;

      const entries = value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);

      // Select the entry that many positions from the right. If there are
      // fewer entries than trusted hops, the header is untrustworthy.
      if (entries.length < hops) continue;

      const candidate = entries[entries.length - hops];
      if (candidate && isValidIp(candidate)) return candidate;
    }
  }

  return req.ip ?? req.socket?.remoteAddress ?? '';
}
