import type { Request, Response, NextFunction } from 'express';
import ipRangeCheck from 'ip-range-check';
import { logger } from './logging.js';
import { getClientIp, isValidIp, DEFAULT_PROXY_HEADERS, TrustProxyOption } from '../lib/clientIp.js';

/**
 * Configuration for IP allowlist middleware
 */
export interface IpAllowlistConfig {
  /** List of allowed IP ranges in CIDR notation */
  allowedRanges: string[];
  /**
   * Whether to trust proxy headers for IP resolution, and how many hops to
   * trust.
   *
   * Security note: set this to a non-zero value only when the service sits
   * behind a trusted reverse proxy that you control.  When `false` (the
   * default) the direct socket address is used, making header-spoofing
   * impossible.  A number specifies how many trusted proxy hops sit in
   * front of the app.
   * See FORWARDED_HEADER_POLICY.md for the full trust-boundary policy.
   */
  trustProxy?: TrustProxyOption;
  /** Custom proxy headers to check (in order of priority) */
  proxyHeaders?: string[];
  /** Whether to enable the allowlist (defaults to true) */
  enabled?: boolean;
}

/**
 * Creates IP allowlist middleware for protecting sensitive endpoints.
 *
 * IP resolution follows the trust-boundary policy in FORWARDED_HEADER_POLICY.md:
 * - When trustProxy is false, the direct socket address is used (spoof-proof).
 * - When trustProxy is a hop count, the client address is taken that many
 *   positions from the right of the forwarded chain, so client-controlled
 *   leftmost entries cannot spoof the resolved IP.
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

    // Resolve client IP per trust-boundary policy: when trustProxy is false
    // getClientIp returns req.ip (socket address), ignoring all forwarded headers.
    const clientIp = getClientIp(req, trustProxy, proxyHeaders);

    if (!isValidIp(clientIp)) {
      logger.warn(
        {
          ip: clientIk,
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

/** Parses the TRUST_PROXY_HEADERS env variable into a trust-proxy option. */
function parseTrustProxyEnv(): TrustProxyOption {
  const raw = process.env.TRUST_PROXY_HEADERS;
  if (raw === undefined) return false;

  const trimmed = raw.trim();
  if (trimmed === '') return false;
  if (trimmed === 'true') return 1;
  if (trimmed === 'false') return false;

  const hops = Number(trimmed);
  if (Number.isFinite(hops) && hops >= 0) return Math.floor(hops);

  logger.warn(
    { value: raw },
    'Invalid TRUST_PROXY_HEADERS value; defaulting to no trusted proxy hops',
  );
  return false;
}

/**
 * Pre-configured IP allowlist for admin endpoints.
 * Uses environment variables for configuration.
 */
export function createAdminIpAllowlist() {
  const allowedRanges = process.env.ADMIN_IP_ALLOWED_RANGES?.split(',').map(r => r.trim()) ?? [];
  const trustProxy = parseTrustProxyEnv();
  const enabled = process.env.ADMIN_IP_ALLOWLIST_ENABLED !== 'false';

  if (allowedRanges.length === 0) {
    logger.warn('tminAdmin IP allowlist is empty - allowing all IPs');
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
  const trustProxy = parseTrustProxyEnv();
  const enabled = process.env.GATEWAY_IP_ALLOWLIST_ENABLED !== 'false';

  if (allowedRanges.length === 0) {
    logger.warn('Gateway IP allowlist is empty - allowing all IPs');
    return (_req: Request, _res: Response, next: NextFunction): void => next();
  }

  return createIpAllowlist({ allowedRanges, trustProxy, enabled });
}
