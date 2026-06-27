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
   * Refresh access token using a valid refresh token.
   *
   * On success the consumed refresh token is revoked and a fresh token pair
   * (access + refresh) is returned. Single-use enforcement means a reused
   * token is an unambiguous theft signal: all tokens for the user are
   * immediately revoked and the request is rejected with 401.
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

      // Reuse detection — token is already revoked, which means it was
      // previously rotated. Presenting it again is a theft signal.
      // Revoke all user tokens and reject the request.
      if (storedToken.isRevoked) {
        await this.refreshTokenService.handleReuse(storedToken, this.refreshTokenRepository);
        logger.warn('[AuthController] Theft signal: revoked token presented again — all user tokens revoked', {
          tokenId: tokenPayload.tokenId,
          userId: tokenPayload.userId,
          familyId: storedToken.familyId
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

      // Rotate: revoke consumed token, issue fresh access + refresh token pair
      // in the same family so the entire lineage is covered by theft detection.
      const newTokenPair = await this.refreshTokenService.rotateRefreshToken(
        storedToken,
        storedToken.userId,
        undefined, // walletAddress not available in refresh flow
        this.refreshTokenRepository
      );

      logger.info('[AuthController] Token pair rotated successfully', {
        userId: storedToken.userId,
        consumedTokenId: storedToken.id,
        familyId: storedToken.familyId
      });

      res.json({
        accessToken: newTokenPair.accessToken,
        refreshToken: newTokenPair.refreshToken,
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
        maxAllowedTokens: 5
      });

    } catch (error) {
      logger.error('[AuthController] Error getting token info', { error });
      next(new UnauthorizedError('Failed to get token info', 'TOKEN_INFO_FAILED'));
    }
  }
}
