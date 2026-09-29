import type { Request } from 'express';

export type TrustProxyOption = boolean | number;

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
 * Extracts the real client IP from an Express request.
 *
 * Trust semantics follow Express' `trust proxy` model:
 * - `false` (default): all forwarded headers are ignored and the direct
 *   socket address is returned, making header spoofing impossible.
 * - `true`: trust all hops (equivalent to a hop count of `Infinity`).
 * - `number N >= 1`: trust the last N hops. The client address is taken
 *   N entries from the right of the forwarded chain. With one trusted hop,
 *   `'1.1.1.1, 2.2.2.2'` yields `2.2.2.2`. This prevents a client from
 *   spoofing the leftmost entry to bypass the admin IP-allowlist or per-IP
 *   rate limits.
 *
 * Because the client address is selected from the right of the chain,
 * spoofed leftmost entries cannot influence the result as long as the
 * configured hop count matches the actual number of trusted proxies.
 *
 * @param req          Express request object
 * @param trustProxy   False (no trust), true (trust all), or a hop count >= 1
 * @param proxyHeaders Ordered list of headers to inspect (defaults to {@link DEFAULT_PROXY_HEADERS})
 */
export function getClientIp(
  req: Request,
  trustProxy: TrustProxyOption = false,
  proxyHeaders: readonly string[] = DEFAULT_PROXY_HEADERS,
): string {
  const hops = normalizeTrustProxy(trustProxy);

  if (hops > 0) {
    for (const header of proxyHeaders) {
      const value = req.headers[header.toLowerCase()];
      if (typeof value !== 'string' || !value.trim()) continue;

      const entries = value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);

      if (entries.length === 0) continue;

      // Select the entry `hops` positions from the right. When the chain is
      // shorter than the configured hop count, the leftmost entry is the
      // best available candidate.
      const index = Math.max(0, entries.length - hops);
      const candidate = entries[index];
      if (candidate && isValidIp(candidate)) return candidate;
    }
  }

  return req.ip ?? req.socket?.remoteAddress ?? '';
}

/**
 * Normalises the `trustProxy` option into a non-negative hop count.
 * `false` -> 0, `true` -> Infinity, and any number >= 1 -> that number.
 */
function normalizeTrustProxy(trustProxy: TrustProxyOption): number {
  if (trustProxy === true) return Number.POSITIVE_INFINITY;
  if (trustProxy === false) return 0;
  if (typeof trustProxy === 'number' && Number.isFinite(trustProxy) && trustProxy >= 1) {
    return Math.floor(trustProxy);
  }
  return 0;
}
