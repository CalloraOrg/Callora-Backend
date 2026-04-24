import type { Request, Response, NextFunction } from 'express';
import { RefreshTokenService } from '../services/refreshTokenService.js';
import type { RefreshTokenRepository } from '../repositories/refreshTokenRepository.js';
import { logger } from '../logger.js';
import { UnauthorizedError } from '../errors/index.js';

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
   * Refresh access token using a valid refresh token
   * POST /auth/refresh
   */
  async refreshToken(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { refreshToken } = req.body;

      if (!refreshToken) {
        next(new UnauthorizedError('Refresh token is required', 'MISSING_REFRESH_TOKEN'));
        return;
      }

      // Verify the refresh token structure and signature
      const tokenPayload = this.refreshTokenService.verifyRefreshToken(refreshToken);
      if (!tokenPayload) {
        next(new UnauthorizedError('Invalid or expired refresh token', 'INVALID_REFRESH_TOKEN'));
        return;
      }

      // Find the stored refresh token record
      const storedToken = await this.refreshTokenRepository.findRefreshTokenById(
        tokenPayload.tokenId,
        tokenPayload.userId
      );

      if (!storedToken) {
        logger.warn('[AuthController] Refresh token not found in database', {
          tokenId: tokenPayload.tokenId,
          userId: tokenPayload.userId
        });
        next(new UnauthorizedError('Invalid refresh token', 'INVALID_REFRESH_TOKEN'));
        return;
      }

      // Check if token is revoked or expired
      if (storedToken.isRevoked) {
        logger.warn('[AuthController] Attempted to use revoked refresh token', {
          tokenId: tokenPayload.tokenId,
          userId: tokenPayload.userId
        });
        next(new UnauthorizedError('Refresh token has been revoked', 'REVOKED_TOKEN'));
        return;
      }

      if (this.refreshTokenService.isTokenExpired(storedToken.expiresAt)) {
        logger.warn('[AuthController] Attempted to use expired refresh token', {
          tokenId: tokenPayload.tokenId,
          userId: tokenPayload.userId
        });
        next(new UnauthorizedError('Refresh token has expired', 'EXPIRED_TOKEN'));
        return;
      }

      // Verify the token hash matches (prevents token substitution attacks)
      if (!this.refreshTokenService.verifyTokenHash(refreshToken, storedToken.tokenHash)) {
        logger.warn('[AuthController] Refresh token hash mismatch', {
          tokenId: tokenPayload.tokenId,
          userId: tokenPayload.userId
        });
        next(new UnauthorizedError('Invalid refresh token', 'INVALID_REFRESH_TOKEN'));
        return;
      }

      // Update last used timestamp
      await this.refreshTokenRepository.updateLastUsed(storedToken.id, storedToken.userId);

      // Generate new access token
      const newAccessToken = this.refreshTokenService.refreshAccessToken(
        storedToken.userId,
        undefined // walletAddress not available in refresh flow
      );

      logger.info('[AuthController] Access token refreshed successfully', {
        userId: storedToken.userId,
        tokenId: storedToken.id
      });

      res.json({
        accessToken: newAccessToken,
        tokenType: 'Bearer'
      });

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
        res.json({ message: 'Token revoked successfully' });
        return;
      }

      // Verify token hash before revoking
      if (!this.refreshTokenService.verifyTokenHash(refreshToken, storedToken.tokenHash)) {
        logger.warn('[AuthController] Token hash mismatch during revocation', {
          tokenId: tokenPayload.tokenId,
          userId: tokenPayload.userId
        });
        // Still return success to avoid token enumeration attacks
        res.json({ message: 'Token revoked successfully' });
        return;
      }

      await this.refreshTokenRepository.revokeRefreshToken(storedToken.id, storedToken.userId);

      logger.info('[AuthController] Refresh token revoked successfully', {
        userId: storedToken.userId,
        tokenId: storedToken.id
      });

      res.json({ message: 'Token revoked successfully' });

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
      // This endpoint should be protected by requireAuth middleware
      const userId = (req as any).developerId || res.locals.authenticatedUser?.id;

      if (!userId) {
        next(new UnauthorizedError('User not authenticated', 'NOT_AUTHENTICATED'));
        return;
      }

      await this.refreshTokenRepository.revokeAllUserTokens(userId);

      logger.info('[AuthController] All refresh tokens revoked for user', { userId });

      res.json({ message: 'All tokens revoked successfully' });

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
      const userId = (req as any).developerId || res.locals.authenticatedUser?.id;

      if (!userId) {
        next(new UnauthorizedError('User not authenticated', 'NOT_AUTHENTICATED'));
        return;
      }

      const activeTokenCount = await this.refreshTokenRepository.countActiveTokens(userId);

      res.json({
        activeRefreshTokens: activeTokenCount,
        maxAllowedTokens: 5 // Configurable limit
      });

    } catch (error) {
      logger.error('[AuthController] Error getting token info', { error });
      next(new UnauthorizedError('Failed to get token info', 'TOKEN_INFO_FAILED'));
    }
  }
}
