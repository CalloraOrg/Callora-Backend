import type { Request, Response, NextFunction } from 'express';
import ipRangeCheck from 'ip-range-check';
import { logger } from './logging.js';
import { getClientIp, isValidIp, DEFAULT_PROXY_HEADERS } from '../lib/clientIp.js';

/**
 * Configuration for IP allowlist middleware
 */
export interface IpAllowlistConfig {
  /** List of allowed IP ranges in CIDR notation */
  allowedRanges: string[];
  /** Whether to trust proxy headers for IP resolution */
  trustProxy?: boolean;
  /** Custom proxy headers to check (in order of priority) */
  proxyHeaders?: string[];
  /** Whether to enable the allowlist (defaults to true) */
  enabled?: boolean;
}

/**
 * Creates IP allowlist middleware for protecting sensitive endpoints
 * 
 * Security considerations:
 * - Always validate IP format before range checking
 * - Handle IPv6 addresses properly
 * - Prevent IP spoofing through proxy header manipulation
 * - Log blocked attempts for security monitoring
 */
export function createIpAllowlist(config: IpAllowlistConfig) {
  const {
    allowedRanges,
    trustProxy = false,
    proxyHeaders = DEFAULT_PROXY_HEADERS,
    enabled = true,
  } = config;

  // Validate configuration
  if (!Array.isArray(allowedRanges) || allowedRanges.length === 0) {
    throw new Error('IP allowlist must have at least one allowed range');
  }

  // Log configuration for security audit
  logger.info(
    'IP allowlist middleware configured', {
      allowedRangesCount: allowedRanges.length,
      trustProxy,
      proxyHeaders,
      enabled,
    }
  );

  return (req: Request, res: Response, next: NextFunction): void => {
    // Skip IP checking if allowlist is disabled
    if (!enabled) {
      next();
      return;
    }

    const clientIp = getClientIp(req, trustProxy, proxyHeaders);

    // Validate extracted IP format
    if (!isValidIp(clientIp)) {
      logger.warn(
        'Invalid IP format detected', {
          ip: clientIp,
          userAgent: req.get('User-Agent'),
          path: req.path,
        }
      );
      
      res.status(400).json({ 
        error: 'Bad Request: invalid client IP format',
        code: 'INVALID_IP_FORMAT'
      });
      return;
    }

    // Check if IP is in allowed ranges
    const isAllowed = ipRangeCheck(clientIp, allowedRanges);

    if (!isAllowed) {
      // Log blocked attempt for security monitoring
      logger.warn(
        'IP allowlist blocked request', {
          clientIp,
          path: req.path,
          method: req.method,
          userAgent: req.get('User-Agent'),
          timestamp: new Date().toISOString(),
        }
      );

      res.status(403).json({ 
        error: 'Forbidden: IP address not allowed',
        code: 'IP_NOT_ALLOWED'
      });
      return;
    }

    // Log successful allowlist check for audit trail
    logger.debug(
      'IP allowlist check passed', {
        clientIp,
        path: req.path,
        method: req.method,
      }
    );

    next();
  };
}

/**
 * Pre-configured IP allowlist for admin endpoints
 * Uses environment variables for configuration
 */
export function createAdminIpAllowlist() {
  const allowedRanges = process.env.ADMIN_IP_ALLOWED_RANGES?.split(',').map(r => r.trim()) || [];
  const trustProxy = process.env.TRUST_PROXY_HEADERS === 'true';
  const enabled = process.env.ADMIN_IP_ALLOWLIST_ENABLED !== 'false';

  if (allowedRanges.length === 0) {
    logger.warn('Admin IP allowlist is empty - allowing all IPs');
    return (_req: Request, _res: Response, next: NextFunction): void => {
      next();
    };
  }

  return createIpAllowlist({
    allowedRanges,
    trustProxy,
    enabled,
  });
}

/**
 * Pre-configured IP allowlist for gateway endpoints
 * Uses environment variables for configuration
 */
export function createGatewayIpAllowlist() {
  const allowedRanges = process.env.GATEWAY_IP_ALLOWED_RANGES?.split(',').map(r => r.trim()) || [];
  const trustProxy = process.env.TRUST_PROXY_HEADERS === 'true';
  const enabled = process.env.GATEWAY_IP_ALLOWLIST_ENABLED !== 'false';

  if (allowedRanges.length === 0) {
    logger.warn('Gateway IP allowlist is empty - allowing all IPs');
    return (_req: Request, _res: Response, next: NextFunction): void => {
      next();
    };
  }

  return createIpAllowlist({
    allowedRanges,
    trustProxy,
    enabled,
  });
}
