export interface AuthenticatedUser {
  id: string;
}

export interface AuthenticatedRequestContext {
  user: AuthenticatedUser;
}

export interface RefreshTokenPayload {
  userId: string;
  tokenId: string;
  type: 'refresh';
}

export interface AccessTokenPayload {
  userId: string;
  walletAddress?: string;
  type: 'access';
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface RefreshToken {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
  lastUsedAt?: Date;
  isRevoked: boolean;
}
