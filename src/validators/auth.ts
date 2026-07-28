/**
 * Zod validation schemas for the /api/auth endpoints.
 *
 * These schemas are consumed by `bodyValidator` in `authRoutes.ts`.
 * Any validation failure is converted into a structured HTTP 400 response
 * by the global `ValidationError` / `errorHandler` pipeline:
 *
 * ```json
 * {
 *   "success": false,
 *   "error": {
 *     "code": "VALIDATION_ERROR",
 *     "message": "Request validation failed",
 *     "details": [
 *       { "field": "body.walletAddress", "message": "Wallet address is required", "code": "TOO_SMALL" }
 *     ]
 *   },
 *   "requestId": "...",
 *   "timestamp": "..."
 * }
 * ```
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// POST /auth/wallet
// ---------------------------------------------------------------------------

/**
 * Body schema for wallet-based login.
 *
 * All three fields are required non-empty strings:
 * - `walletAddress` – the Stellar public key (G… address) initiating the login
 * - `signature`     – the hex/base64 signature produced by the wallet
 * - `message`       – the exact message that was signed
 */
export const walletLoginSchema = z.object({
  walletAddress: z.string().min(1, 'Wallet address is required'),
  signature: z.string().min(1, 'Signature is required'),
  message: z.string().min(1, 'Message is required'),
});

export type WalletLoginInput = z.infer<typeof walletLoginSchema>;

// ---------------------------------------------------------------------------
// POST /auth/refresh  &  POST /auth/revoke
// ---------------------------------------------------------------------------

/**
 * Body schema for endpoints that accept a single refresh token.
 * Used by both `POST /auth/refresh` and `POST /auth/revoke`.
 *
 * - `refreshToken` – the opaque refresh token string issued at login
 */
export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

export type RefreshTokenInput = z.infer<typeof refreshTokenSchema>;
