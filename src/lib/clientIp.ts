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
 * - `true`: treats the immediate peer as a trusted proxy (equivalent to
 *   a hop count of 1).
 * - `number`: the number of trusted proxy hops in front of the app.
 *
 * For the `x-forwarded-for` chain the client IP selected is the entry that
 * many positions from the right (the leftmost entries are client-controlled
 * and must not be trusted). Other single-value proxy headers are only
 * consulted when the chain is exhausted, and the socket address is the
 * final fallback.
 *
 * @param req          Express request object
 * @param trustProxy   Whether to honour proxy forwarding headers, or how
 *                     many trusted proxy hops to skip from the right
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

      // The client is `trustedHops` positions from the right of the chain.
      // When the chain is shorter than the configured hop count the
      // client address is unknown, so we move on to the next source.
      const index = entries.length - hops;
      if (index < 0) continue;

      const candidate = entries[index];
      if (isValidIp(candidate)) return candidate;
    }
  }

  return req.ip ?? req.socket?.remoteAddress ?? '';
}

/** Normalizes the trust-proxy option into a non-negative hop count. */
function normalizeTrustProxy(trustProxy: TrustProxyOption): number {
  if (trustProxy === true) return 1;
  if (typeof trustProxy === 'number' && Number.isFinite(trustProxy)) {
    return Math.max(0, Math.floor(trustProxy));
  }
  return 0;
}
