import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { RefreshTokenService } from '../services/refreshTokenService.js';
import type { RefreshTokenRepository } from '../repositories/refreshTokenRepository.js';
import { logger } from '../logger.js';
import { UnauthorizedError } from '../errors/index.js';
import { getClientIp, DEFAULT_PROXY_HEADERS } from '../lib/clientIp.js';
import { successEnvelope, getRequestId } from '../lib/envelope.js';

export const DEFAULT_CHALLENGE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
export const MAX_FUTURE_SKEW_MS = 60 * 1000; // 60 seconds

export interface WalletChallengeOptions {
  timestamp?: number | Date;
  nonce?: string;
}

/**
 * Builds a canonical wallet login challenge message containing the wallet
 * address, a unique nonce, and an ISO-8601 timestamp.
 */
export function createWalletLoginChallenge(
  walletAddress: string,
  options: WalletChallengeOptions = {},
): string {
  const ts =
    options.timestamp instanceof Date
      ? options.timestamp.toISOString()
      : typeof options.timestamp === 'number'
        ? new Date(options.timestamp).toISOString()
        : new Date().toISOString();
  const nonce = options.nonce ?? crypto.randomUUID();
  return `Callora Wallet Login\nWallet: ${walletAddress}\nNonce: ${nonce}\nTimestamp: ${ts}`;
}

/**
 * Decodes a hex or base64 encoded 64-byte Ed25519 signature.
 */
function decodeSignature(signature: string): Buffer | null {
  const trimmed = signature.trim();
  if (!trimmed) return null;

  if (/^[0-9a-fA-F]{128}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }

  // Validate base64 / base64url alphabet before decoding
  if (!/^[A-Za-z0-9+/=_-]+$/.test(trimmed)) {
    return null;
  }

  try {
    const normalized = trimmed.replace(/-/g, '+').replace(/_/g, '/');
    const buf = Buffer.from(normalized, 'base64');
    if (buf.length !== 64) {
      return null;
    }
    return buf;
  } catch {
    return null;
  }
}

/**
 * Extracts timestamp / expiry / nonce metadata from a login message when present.
 */
function parseChallengeMetadata(message: string): {
  timestampMs?: number;
  expiresAtMs?: number;
  nonce?: string;
  walletInMessage?: string;
} {
  const trimmed = message.trim();

  // 1. JSON challenge format
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const result: {
        timestampMs?: number;
        expiresAtMs?: number;
        nonce?: string;
        walletInMessage?: string;
      } = {};
      if (typeof parsed.nonce === 'string' && parsed.nonce.trim()) {
        result.nonce = parsed.nonce.trim();
      }
      if (typeof parsed.walletAddress === 'string' && parsed.walletAddress.trim()) {
        result.walletInMessage = parsed.walletAddress.trim();
      } else if (typeof parsed.wallet === 'string' && parsed.wallet.trim()) {
        result.walletInMessage = parsed.wallet.trim();
      }
      const rawTs = parsed.timestamp ?? parsed.issuedAt;
      if (typeof rawTs === 'number' && Number.isFinite(rawTs)) {
        result.timestampMs = rawTs < 1e12 ? rawTs * 1000 : rawTs;
      } else if (typeof rawTs === 'string') {
        const num = Number(rawTs);
        result.timestampMs = Number.isFinite(num)
          ? (num < 1e12 ? num * 1000 : num)
          : Date.parse(rawTs);
      }
      const rawExp = parsed.expiresAt ?? parsed.exp;
      if (typeof rawExp === 'number' && Number.isFinite(rawExp)) {
        result.expiresAtMs = rawExp < 1e12 ? rawExp * 1000 : rawExp;
      } else if (typeof rawExp === 'string') {
        const num = Number(rawExp);
        result.expiresAtMs = Number.isFinite(num)
          ? (num < 1e12 ? num * 1000 : num)
          : Date.parse(rawExp);
      }
      return result;
    } catch {
      // Fall through to text parsing
    }
  }

  const result: {
    timestampMs?: number;
    expiresAtMs?: number;
    nonce?: string;
    walletInMessage?: string;
  } = {};

  const walletMatch = trimmed.match(/(?:^|\n)\s*Wallet\s*:\s*(\S+)/i);
  if (walletMatch) {
    result.walletInMessage = walletMatch[1].trim();
  }

  const nonceMatch = trimmed.match(/(?:^|\n)\s*Nonce\s*:\s*(\S+)/i);
  if (nonceMatch) {
    result.nonce = nonceMatch[1].trim();
  }

  const expiresMatch = trimmed.match(/(?:^|\n)\s*Expires(?:\s*At)?\s*:\s*([^\n\r]+)/i);
  if (expiresMatch) {
    const raw = expiresMatch[1].trim();
    const num = Number(raw);
    const ms = Number.isFinite(num) ? (num < 1e12 ? num * 1000 : num) : Date.parse(raw);
    if (Number.isFinite(ms)) {
      result.expiresAtMs = ms;
    }
  }

  const tsLabelMatch = trimmed.match(/(?:^|\n)\s*(?:Timestamp|Issued(?:\s*At)?)\s*:\s*([^\n\r]+)/i);
  if (tsLabelMatch) {
    const raw = tsLabelMatch[1].trim();
    const num = Number(raw);
    const ms = Number.isFinite(num) ? (num < 1e12 ? num * 1000 : num) : Date.parse(raw);
    if (Number.isFinite(ms)) {
      result.timestampMs = ms;
      return result;
    }
  }

  // ISO-8601 timestamp anywhere in the challenge string
  const isoMatch = trimmed.match(
    /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\b/,
  );
  if (isoMatch) {
    const ms = Date.parse(isoMatch[0]);
    if (Number.isFinite(ms)) {
      result.timestampMs = ms;
      return result;
    }
  }

  // Epoch ms (13 digits) or seconds (10 digits)
  const epochMatch = trimmed.match(/\b(\d{13}|\d{10})\b/);
  if (epochMatch) {
    const num = Number(epochMatch[1]);
    if (Number.isFinite(num)) {
      result.timestampMs = epochMatch[1].length === 10 ? num * 1000 : num;
    }
  }

  return result;
}

export interface AuthControllerOptions {
  refreshTokenService: RefreshTokenService;
  refreshTokenRepository: RefreshTokenRepository;
  challengeWindowMs?: number;
  now?: () => number;
}

export class AuthController {
  private readonly refreshTokenService: RefreshTokenService;
  private readonly refreshTokenRepository: RefreshTokenRepository;
  private readonly challengeWindowMs: number;
  private readonly now: () => number;
  private readonly consumedChallenges = new Map<string, number>();

  constructor(options: AuthControllerOptions) {
    this.refreshTokenService = options.refreshTokenService;
    this.refreshTokenRepository = options.refreshTokenRepository;
    this.challengeWindowMs = options.challengeWindowMs ?? DEFAULT_CHALLENGE_WINDOW_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Wallet-based login with IP-based rate limiting applied at the route level.
   * Verifies the Stellar Ed25519 signature against the login message and
   * returns an access + refresh JWT pair on success.
   *
   * POST /auth/wallet
   * Rate limited to 5 requests per minute per IP by loginThrottle middleware.
   */
  async walletLogin(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { walletAddress, signature, message } = req.body ?? {};

      if (
        typeof walletAddress !== 'string' ||
        typeof signature !== 'string' ||
        typeof message !== 'string' ||
        !walletAddress.trim() ||
        !signature.trim() ||
        !message.trim()
      ) {
        next(new UnauthorizedError('Missing required fields', 'MISSING_AUTH_FIELDS'));
        return;
      }

      const trimmedWallet = walletAddress.trim();
      const clientIp = getClientIp(req, process.env.TRUST_PROXY_HEADERS === 'true', DEFAULT_PROXY_HEADERS);
      const requestId = getRequestId(req);

      logger.info('[AuthController] Wallet login attempt', {
        walletAddress: trimmedWallet,
        clientIp,
      });

      if (!StrKey.isValidEd25519PublicKey(trimmedWallet)) {
        logger.warn('[AuthController] Invalid Stellar wallet address', {
          walletAddress: trimmedWallet,
          clientIp,
        });
        next(new UnauthorizedError('Invalid Stellar wallet address', 'INVALID_TOKEN'));
        return;
      }

      const metadata = parseChallengeMetadata(message);
      if (metadata.walletInMessage && metadata.walletInMessage !== trimmedWallet) {
        logger.warn('[AuthController] Challenge wallet mismatch', {
          walletAddress: trimmedWallet,
          challengeWallet: metadata.walletInMessage,
          clientIp,
        });
        next(new UnauthorizedError('Challenge wallet address mismatch', 'INVALID_TOKEN'));
        return;
      }

      const currentTimeMs = this.now();
      if (metadata.expiresAtMs !== undefined && currentTimeMs > metadata.expiresAtMs) {
        logger.warn('[AuthController] Expired login challenge', {
          walletAddress: trimmedWallet,
          clientIp,
        });
        next(new UnauthorizedError('Login challenge has expired', 'TOKEN_EXPIRED'));
        return;
      }

      if (metadata.timestampMs !== undefined) {
        const ageMs = currentTimeMs - metadata.timestampMs;
        if (ageMs > this.challengeWindowMs || ageMs < -MAX_FUTURE_SKEW_MS) {
          logger.warn('[AuthController] Login challenge outside replay window', {
            walletAddress: trimmedWallet,
            ageMs,
            challengeWindowMs: this.challengeWindowMs,
            clientIp,
          });
          next(new UnauthorizedError('Login challenge has expired', 'TOKEN_EXPIRED'));
          return;
        }
      }

      const signatureBuffer = decodeSignature(signature);
      if (!signatureBuffer) {
        logger.warn('[AuthController] Malformed wallet signature encoding', {
          walletAddress: trimmedWallet,
          clientIp,
        });
        next(new UnauthorizedError('Invalid wallet signature', 'INVALID_TOKEN'));
        return;
      }

      let signatureValid = false;
      try {
        const keypair = Keypair.fromPublicKey(trimmedWallet);
        signatureValid = keypair.verify(Buffer.from(message, 'utf8'), signatureBuffer);
      } catch {
        signatureValid = false;
      }

      if (!signatureValid) {
        logger.warn('[AuthController] Stellar signature verification failed', {
          walletAddress: trimmedWallet,
          clientIp,
        });
        next(new UnauthorizedError('Invalid wallet signature', 'INVALID_TOKEN'));
        return;
      }

      // Prune expired replay entries and reject replayed challenges/signatures
      for (const [key, exp] of this.consumedChallenges.entries()) {
        if (exp <= currentTimeMs) {
          this.consumedChallenges.delete(key);
        }
      }

      const challengeDigest = crypto
        .createHash('sha256')
        .update(`${trimmedWallet}:${message}:${signature.trim()}`)
        .digest('hex');
      const nonceKey = metadata.nonce ? `${trimmedWallet}:nonce:${metadata.nonce}` : null;

      if (
        this.consumedChallenges.has(challengeDigest) ||
        (nonceKey !== null && this.consumedChallenges.has(nonceKey))
      ) {
        logger.warn('[AuthController] Replayed wallet login challenge rejected', {
          walletAddress: trimmedWallet,
          clientIp,
        });
        next(new UnauthorizedError('Login challenge has already been used', 'INVALID_TOKEN'));
        return;
      }

      const replayExpiry = metadata.expiresAtMs ?? currentTimeMs + this.challengeWindowMs;
      this.consumedChallenges.set(challengeDigest, replayExpiry);
      if (nonceKey !== null) {
        this.consumedChallenges.set(nonceKey, replayExpiry);
      }

      const userId = trimmedWallet;
      const tokenPair = this.refreshTokenService.createTokenPair(userId, trimmedWallet);
      const refreshTokenRecord = this.refreshTokenService.createRefreshTokenRecord(
        userId,
        tokenPair.refreshToken,
      );
      await this.refreshTokenRepository.createRefreshToken(refreshTokenRecord);

      logger.info('[AuthController] Wallet login succeeded', {
        userId,
        walletAddress: trimmedWallet,
        tokenId: refreshTokenRecord.id,
        clientIp,
      });

      res.status(200).json(
        successEnvelope(
          {
            accessToken: tokenPair.accessToken,
            refreshToken: tokenPair.refreshToken,
            tokenType: 'Bearer',
          },
          requestId,
        ),
      );
    } catch (error) {
      logger.error('[AuthController] Error during wallet login', { error });
      next(new UnauthorizedError('Login failed', 'REFRESH_FAILED'));
    }
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
      
      const requestId = getRequestId(req);

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

      res.json(successEnvelope({
        accessToken: newTokenPair.accessToken,
        refreshToken: newTokenPair.refreshToken,
        tokenType: 'Bearer'
      }, requestId));

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
