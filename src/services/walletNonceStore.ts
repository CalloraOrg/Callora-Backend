import crypto from 'crypto';

export interface WalletNonceEntry {
  nonce: string;
  walletAddress: string;
  message: string;
  expiresAt: Date;
  used: boolean;
}

export class WalletNonceStore {
  private readonly nonces = new Map<string, WalletNonceEntry>();
  private readonly defaultTtlMs: number;

  constructor(defaultTtlMs = 5 * 60 * 1000) {
    this.defaultTtlMs = defaultTtlMs;
  }

  generateNonce(walletAddress: string, ttlMs?: number): { nonce: string; message: string; expiresAt: Date } {
    const nonce = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + (ttlMs ?? this.defaultTtlMs));
    const message = `Sign this message to authenticate with Callora: ${nonce}`;
    const entry: WalletNonceEntry = {
      nonce,
      walletAddress,
      message,
      expiresAt,
      used: false,
    };
    this.nonces.set(nonce, entry);
    return { nonce, message, expiresAt };
  }

  validateAndConsume(walletAddress: string, message: string): {
    valid: boolean;
    code?: 'INVALID_WALLET_NONCE' | 'EXPIRED_WALLET_NONCE' | 'REUSED_WALLET_NONCE' | 'TAMPERED_WALLET_MESSAGE' | 'INVALID_WALLET_ADDRESS';
    error?: string;
  } {
    // Extract 64-character hex nonce from message
    const match = message.match(/\b([a-f0-9]{64})\b/i);
    if (!match) {
      return {
        valid: false,
        code: 'INVALID_WALLET_NONCE',
        error: 'No valid challenge nonce found in message',
      };
    }

    const nonce = match[1].toLowerCase();
    const entry = this.nonces.get(nonce);
    if (!entry) {
      return {
        valid: false,
        code: 'INVALID_WALLET_NONCE',
        error: 'Challenge nonce not found or unknown',
      };
    }

    if (entry.walletAddress.trim() !== walletAddress.trim()) {
      return {
        valid: false,
        code: 'INVALID_WALLET_ADDRESS',
        error: 'Challenge nonce was not issued for this wallet address',
      };
    }

    if (entry.used) {
      return {
        valid: false,
        code: 'REUSED_WALLET_NONCE',
        error: 'Challenge nonce has already been consumed',
      };
    }

    if (Date.now() > entry.expiresAt.getTime()) {
      return {
        valid: false,
        code: 'EXPIRED_WALLET_NONCE',
        error: 'Challenge nonce has expired',
      };
    }

    if (entry.message.trim() !== message.trim()) {
      return {
        valid: false,
        code: 'TAMPERED_WALLET_MESSAGE',
        error: 'Signed message does not match server-issued challenge',
      };
    }

    // Mark as consumed (single-use guarantee against replay)
    entry.used = true;
    return { valid: true };
  }

  clear(): void {
    this.nonces.clear();
  }
}

export const defaultWalletNonceStore = new WalletNonceStore();
