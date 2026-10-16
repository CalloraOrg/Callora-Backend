import { logger } from '../logger.js';

interface RevocationEntry {
  revokedAt: number;
  expiresAt: number | null;
}

export class TokenRevocationService {
  private readonly revokedTokens = new Map<string, RevocationEntry>();
  private sweeperTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly defaultTtlMs: number | null = null,
    private readonly sweepIntervalMs: number = 60_000,
  ) {
    this.startSweeper();
  }

  revoke(tokenHash: string, expiresAt?: number | null): void {
    const now = Date.now();
    const effectiveExpiresAt =
      typeof expiresAt === 'number' && expiresAt > 0
        ? expiresAt
        : null;

    this.revokedTokens.set(tokenHash, {
      revokedAt: now,
      expiresAt: effectiveExpiresAt,
    });

    logger.info('[TokenRevocation] Token revoked', {
      tokenHash,
      expiresAt: effectiveExpiresAt,
    });
  }

  isRevoked(tokenHash: string): boolean {
    const entry = this.revokedTokens.get(tokenHash);
    if (!entry) {
      return false;
    }

    if (entry.expiresAt !== null && entry.expiresAt < Date.now()) {
      this.revokedTokens.delete(tokenHash);
      return false;
    }

    return true;
  }

  reinstate(tokenHash: string): void {
    this.revokedTokens.delete(tokenHash);
    logger.info('[TokenRevocation] Token reinstated', { tokenHash });
  }

  revokeAll(developerId: string, tokenHashes: string[]): number {
    let revokedCount = 0;
    for (const tokenHash of tokenHashes) {
      this.revoke(tokenHash);
      revokedCount++;
    }
    logger.info('[TokenRevocation] All tokens revoked for developer', {
      developerId,
      count: revokedCount,
    });
    return revokedCount;
  }

  getRevokedCount(): number {
    this.cleanupExpired();
    return this.revokedTokens.size;
  }

  clear(): void {
    this.revokedTokens.clear();
  }

  stopSweeper(): void {
    if (this.sweeperTimer) {
      clearInterval(this.sweeperTimer);
      this.sweeperTimer = null;
    }
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [tokenHash, entry] of this.revokedTokens) {
      if (entry.expiresAt !== null && entry.expiresAt < now) {
        this.revokedTokens.delete(tokenHash);
      }
    }
  }

  private startSweeper(): void {
    this.sweeperTimer = setInterval(() => {
      this.cleanupExpired();
    }, this.sweepIntervalMs);
    this.sweeperTimer.unref?.();
  }
}

let revocationService: TokenRevocationService | null = null;

export function getTokenRevocationService(config?: {
  defaultTtlMs?: number | null;
  sweepIntervalMs?: number;
}): TokenRevocationService {
  if (!revocationService) {
    revocationService = new TokenRevocationService(
      config?.defaultTtlMs ?? null,
      config?.sweepIntervalMs ?? 60_000,
    );
  }
  return revocationService;
}

export function resetTokenRevocationService(): void {
  if (revocationService) {
    revocationService.stopSweeper();
  }
  revocationService = null;
}