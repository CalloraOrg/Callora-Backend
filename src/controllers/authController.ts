import type { Request, Response, NextFunction } from 'express';
import { RefreshTokenService } from '../services/refreshTokenService.js';
import type { RefreshTokenRepository } from '../repositories/refreshTokenRepository.js';
import { logger } from '../logger.js';
import { UnauthorizedError } from '../errors/index.js';
import { getClientIp, DEFAULT_PROXY_HEADERS } from '../lib/clientIp.js';
import { successEnvelope, getRequestId } from '../lib/envelope.js';

export interface AuthControllerOptions {
  refreshTokenService: RefreshTokenService;
  refreshTokenRepository: RefreshTokenRepository;
}

export class AuthController {
  private readonly refreshTokenService: RefreshTokenService;
  private readonly refreshTokenRepository: RefreshTokenRepository;

  constructor(options: AuthControllerOptions) {
    this.refreshTokenService = options.refreshTokenService;
    this.refreshTokenRepository = options.refreshTokenRepository;
  }

  /**
   * Wallet-based login with IP-based rate limiting applied at the route level.
   * Returns JWT on successful signature verification.
   *
   * POST /auth/wallet
   * Rate limited to 5 requests per minute per IP by loginThrottle middleware.
   */
  async walletLogin(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { walletAddress, signature, message } = req.body;

      if (!walletAddress || !signature || !message) {
        next(new UnauthorizedError('Missing required fields', 'MISSING_AUTH_FIELDS'));
        return;
      }

      // Extract client IP for structured logging
      const clientIp = getClientIp(req, process.env.TRUST_PROXY_HEADERS === 'true', DEFAULT_PROXY_HEADERS);

      logger.info('[AuthController] Wallet login attempt', {
        walletAddress,
        clientIp,
      });

      // TODO: Implement actual Stellar signature verification
      // This would typically call a service to verify the wallet signature
      // against the message and derive a user ID for JWT generation

      next(new UnauthorizedError('Wallet login not fully implemented', 'AUTH_NOT_IMPLEMENTED'));

    } catch (error) {
      logger.error('[AuthController] Error during wallet login', { error });
      next(new UnauthorizedError('Login failed', 'REFRESH_FAILED'));
    }
  }

  /**
    * Refresh access token using a valid refresh token.
   *
   * The entire rotation is a single compare-and-set on the primary database:
   * the old token is revoked and the new one inserted in one transaction.
   * Exactly one concurrent request with the same token succeeds; the rest
   * receive REVOKED_TOKEN and trigger a full family revocation (theft signal).
   *
   * Policy: a legitimate double-submit (network retry with the same token)
   * also revokes the whole family. Clients must re-authenticate on a genuine
   * collision. This matches common OAuth 2.0 guidance.
   *
   * POST /auth/refresh
   */
  async refreshToken(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { refreshToken } = req.body;

      if (!refreshToken) {
        next(new UnauthorizedError('Refresh token is required', 'MISSING_REFRESH_TOKEN'));
        return;
      }
      
      const requestId = getRequestId(req);

      // Verify the refresh token structure and signature (JWT layer).
      const tokenPayload = this.refreshTokenService.verifyRefreshToken(refreshToken);
      if (!tokenPayload) {
        next(new UnauthorizedError('Invalid or expired refresh token', 'INVALID_REFRESH_TOKEN'));
        return;
      }

      // Atomic compare-and-set: consume the old token and insert the new one in
      // a single primary-side transaction.  No replica reads are used here.
      const result = await this.refreshTokenService.atomicRotateRefreshToken(
        refreshToken,
        tokenPayload,
        undefined, // walletAddress not available in refresh flow
        this.refreshTokenRepository,
      );

      if (result.outcome === 'success') {
        logger.info('[AuthController] Token pair rotated successfully (atomic CAS)', {
          userId: tokenPayload.userId,
          consumedTokenId: tokenPayload.tokenId,
        });

        res.json(successEnvelope({
          accessToken: result.tokens.accessToken,
          refreshToken: result.tokens.refreshToken,
          tokenType: 'Bearer'
        }, requestId));
        return;
      }

      // Map failure outcomes to error codes.
      if (result.outcome === 'revoked') {
        logger.warn('[AuthController] Theft signal: revoked token presented again — all user tokens revoked', {
          tokenId: tokenPayload.tokenId,
          userId: tokenPayload.userId,
        });
        next(new UnauthorizedError('Refresh token has been revoked', 'REVOKED_TOKEN'));
        return;
      }

      if (result.outcome === 'expired') {
        logger.warn('[AuthController] Attempted to use expired refresh token', {
          tokenId: tokenPayload.tokenId,
          userId: tokenPayload.userId,
        });
        next(new UnauthorizedError('Refresh token has expired', 'EXPIRED_TOKEN'));
        return;
      }

      // 'not_found' and 'hash_mismatch' both map to INVALID_REFRESH_TOKEN.
      logger.warn('[AuthController] Refresh token validation failed', {
        outcome: result.outcome,
        tokenId: tokenPayload.tokenId,
        userId: tokenPayload.userId,
      });
      next(new UnauthorizedError('Invalid refresh token', 'INVALID_REFRESH_TOKEN'));

    } catch (error) {
      logger.error('[AuthController] Error refreshing token', { error });
      next(new UnauthorizedError('Token refresh failed', 'REFRESH_FAILED'));
    }
  }

  /**
   * Revoke a refresh token
   * POST /auth/revoke
   */
  async revokeToken(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { refreshToken } = req.body;

      if (!refreshToken) {
        next(new UnauthorizedError('Refresh token is required', 'MISSING_REFRESH_TOKEN'));
        return;
      }

      const requestId = getRequestId(req);

      const tokenPayload = this.refreshTokenService.verifyRefreshToken(refreshToken);
      if (!tokenPayload) {
        next(new UnauthorizedError('Invalid refresh token', 'INVALID_REFRESH_TOKEN'));
        return;
      }

      const storedToken = await this.refreshTokenRepository.findRefreshTokenById(
        tokenPayload.tokenId,
        tokenPayload.userId
      );

      if (!storedToken) {
        logger.warn('[AuthController] Attempted to revoke non-existent refresh token', {
          tokenId: tokenPayload.tokenId,
          userId: tokenPayload.userId
        });
        // Still return success to avoid token enumeration attacks
        res.json(successEnvelope({ message: 'Token revoked successfully' }, requestId));
        return;
      }

      // Verify token hash before revoking
      if (!this.refreshTokenService.verifyTokenHash(refreshToken, storedToken.tokenHash)) {
        logger.warn('[AuthController] Token hash mismatch during revocation', {
          tokenId: tokenPayload.tokenId,
          userId: tokenPayload.userId
        });
        // Still return success to avoid token enumeration attacks
        res.json(successEnvelope({ message: 'Token revoked successfully' }, requestId));
        return;
      }

      await this.refreshTokenRepository.revokeRefreshToken(storedToken.id, storedToken.userId);

      logger.info('[AuthController] Refresh token revoked successfully', {
        userId: storedToken.userId,
        tokenId: storedToken.id
      });

      res.json(successEnvelope({ message: 'Token revoked successfully' }, requestId));

    } catch (error) {
      logger.error('[AuthController] Error revoking token', { error });
      next(new UnauthorizedError('Token revocation failed', 'REVOKE_FAILED'));
    }
  }

  /**
   * Revoke all refresh tokens for the authenticated user
   * POST /auth/revoke-all
   */
  async revokeAllTokens(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.developerId || res.locals.authenticatedUser?.id;

      if (!userId) {
        next(new UnauthorizedError('User not authenticated', 'NOT_AUTHENTICATED'));
        return;
      }

      const requestId = getRequestId(req);

      await this.refreshTokenRepository.revokeAllUserTokens(userId);

      logger.info('[AuthController] All refresh tokens revoked for user', { userId });

      res.json(successEnvelope({ message: 'All tokens revoked successfully' }, requestId));

    } catch (error) {
      logger.error('[AuthController] Error revoking all tokens', { error });
      next(new UnauthorizedError('Token revocation failed', 'REVOKE_FAILED'));
    }
  }

  /**
   * Get token usage information for the authenticated user
   * GET /auth/tokens
   */
  async getTokenInfo(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.developerId || res.locals?.authenticatedUser?.id;

      if (!userId) {
        next(new UnauthorizedError('User not authenticated', 'NOT_AUTHENTICATED'));
        return;
      }

      const requestId = getRequestId(req);

      const activeTokenCount = await this.refreshTokenRepository.countActiveTokens(userId);

      res.json(successEnvelope({
        activeRefreshTokens: activeTokenCount,
        maxAllowedTokens: 5
      }, requestId));

    } catch (error) {
      logger.error('[AuthController] Error getting token info', { error });
      next(new UnauthorizedError('Failed to get token info', 'TOKEN_INFO_FAILED'));
    }
  }
}
