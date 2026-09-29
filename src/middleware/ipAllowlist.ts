import type { Request, Response, NextFunction } from 'express';
import ipRangeCheck from 'ip-range-check';
import { logger } from './logging.js';import { getClientIp, isValidId, DEFAULT_PROXY_HEADERS, type TrustProxy } from '../lib/clientIp.js';

/**
 * Configuration for IP allowlist middleware
 */
export interface IpAllowlistConfig {
  /** List of allowed IP ranges in CIDR notation */
  allowedRanges: string[];
  /**
   * Number of trusted proxy hops to skip when resolving the client IP.
   *
   * Security note: set this to a positive number only when the service
   * sits behind that many trusted reverse proxies that you control.
   * When 0 (the default) the direct socket address is used, making
   * header-spoofing impossible. `true` is accepted as an alias for
   * a single trusted hop.
   * See FORWARDED_HEADER_POLICY.md for the full trust-boundary policy.
   */
  trustProxy?: TrustProxy;
  /** Custom proxy headers to check (in order of priority) */
  proxyHeaders?: string[];
  /** Whether to enable the allowlist (defaults to true) */
  enabled?: boolean;
}

/**
 * Creates IP allowlist middleware for protecting sensitive endpoints.
 *
 * IP resolution follows the trust-boundary policy in FORWARDED_HEADER_POLICY.md:
 * - When trustProxy is 0, the direct socket address is used (spoof-proof).
 * - When trustProxy is N, the entry N positions from the right of
 *   X-Forwarded-For is used, matching Express' `trust proxy` semantics.
 */
export function createIpAllowlist(config: IpAllowlistConfig) {
  const {
    allowedRanges,
    trustProxy = false,
    proxyHeaders = DEFAULT_PROXY_HEADERS,
    enabled = true,
  } = config;

  if (!Array.isArray(allowedRanges) || allowedRanges.length === 0) {
    throw new Error('IP allowlist must have at least one allowed range');
  }

  logger.info(
    {
      allowedRangesCount: allowedRanges.length,
      trustProxy,
      proxyHeaders,
      enabled,
    },
    'IP allowlist middleware configured',
  );

  return (req: Request, res: Response, next: NextFunction): void => {
    if (!enabled) {
      next();
      return;
    }

    // Resolve client IP per trust-boundary policy: when trustProxy is 0, getClientIp
    // returns req.ip (socket address), ignoring all forwarded headers.
    const clientIp = getClientIp(req, trustProxy, proxyHeaders);

    if (!isValidIp(clientIp)) {
      logger.warn(
        {
          ip: clientIp,
          userAgent: req.get('User-Agent'),
          path: req.path,
        },
        'Invalid IP format detected',
      );
      res.status(400).json({
        error: 'Bad Request: invalid client IP format',
        code: 'INVALID_IP_FORMAT',
      });
      return;
    }

    if (!ipRangeCheck(clientIp, allowedRanges)) {
      logger.warn(
        {
          clientIp,
          path: req.path,
          method: req.method,
          userAgent: req.get('User-Agent'),
          timestamp: new Date().toISOString(),
        },
        'IP allowlist blocked request',
      );
      res.status(403).json({
        error: 'Forbidden: IP address not allowed',
        code: 'IP_NOT_ALLOWED',
      });
      return;
    }

    logger.debug(
      {
        clientIp,
        path: req.path,
        method: req.method,
      },
      'IP allowlist check passed',
    );

    next();
  };
}

/**
 * Parses the TRUST_PROXY_HEADERS environment variable into a trust
 * configuration. Accepts `true`/`false` as well as a non-negative integer
 * hop count. Unrecognized values fall back to no trust.
 */
function parseTrustProxyEnv(value: string | undefined): TrustProxy {
  if (value === undefined || value.trim() === '') return false;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  const parsed = Number(normalized);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  return false;
}

/**
 * Pre-configured IP allowlist for admin endpoints.
 * Uses environment variables for configuration.
 */
export function createAdminIpAllowlist() {
  const allowedRanges = process.env.ADMIN_IP_ALLOWED_RANGES?.split(',').map(r => r.trim()) ?? [];
  const trustProxy = parseTrustProxyEnv(process.env.TRUST_PROXY_HEADERS);
  const enabled = process.env.ADMIN_IP_ALLOWLIST_ENABLED !== 'false';

  if (allowedRanges.length === 0) {
    logger.warn('Admin IP allowlist is empty - allowing all IPs');
    return (_req: Request, _res: Response, next: NextFunction): void => next();
  }

  return createIpAllowlist({ allowedRanges, trustProxy, enabled });
}

/**
 * Pre-configured IP allowlist for gateway endpoints.
 * Uses environment variables for configuration.
 */
export function createGatewayIpAllowlist() {
  const allowedRanges = process.env.GATEWAY_IP_ALLOWED_RANGES?.split(',').map(r => r.trim()) ?? [];
  const trustProxy = parseTrustProxyEnv(process.env.TRUST_PROXY_HEADERS);
  const enabled = process.env.GATEWAY_IP_ALLOWLIST_ENABLED !== 'false';

  if (allowedRanges.length === 0) {
    logger.warn('Gateway IP allowlist is empty - allowing all IPs');
    return (_req: Request, _res: Response, next: NextFunction): void => next();
  }

  return createIpAllowlist({ allowedRanges, trustProxy, enabled });
}
