import { Keypair } from '@stellar/stellar-sdk';
import { AuthController } from './authController.js';
import { RefreshTokenService } from '../services/refreshTokenService.js';
import type { RefreshTokenRepository } from '../repositories/refreshTokenRepository.js';
import type { UserRepository, UserDto } from '../repositories/userRepository.js';
import { WalletNonceStore } from '../services/walletNonceStore.js';
import type { RefreshToken } from '../types/auth.js';

describe('AuthController — Wallet Login & Challenge Nonce', () => {
  let authController: AuthController;
  let refreshTokenService: RefreshTokenService;
  let mockRefreshTokenRepo: jest.Mocked<RefreshTokenRepository>;
  let mockUserRepo: jest.Mocked<UserRepository>;
  let walletNonceStore: WalletNonceStore;

  const JWT_SECRET = 'test-secret-key-at-least-32-chars-long';

  beforeEach(() => {
    refreshTokenService = new RefreshTokenService({
      jwtSecret: JWT_SECRET,
      accessTokenExpiry: '15m',
      refreshTokenExpiry: '7d',
    });

    mockRefreshTokenRepo = {
      createRefreshToken: jest.fn().mockImplementation((r: RefreshToken) => Promise.resolve(r)),
      findRefreshTokenById: jest.fn().mockResolvedValue(null),
      revokeRefreshToken: jest.fn().mockResolvedValue(true),
      revokeAllUserTokens: jest.fn().mockResolvedValue(1),
      countActiveTokensByUser: jest.fn().mockResolvedValue(0),
    };

    mockUserRepo = {
      create: jest.fn().mockImplementation(({ stellarAddress }: { stellarAddress: string }) =>
        Promise.resolve<UserDto>({
          id: 'user-uuid-1',
          stellarAddress,
          createdAt: new Date(),
        })
      ),
      findByStellarAddress: jest.fn().mockResolvedValue(null),
      findById: jest.fn().mockResolvedValue(null),
      update: jest.fn(),
      list: jest.fn().mockResolvedValue({ users: [], total: 0 }),
    };

    walletNonceStore = new WalletNonceStore();

    authController = new AuthController({
      refreshTokenService,
      refreshTokenRepository: mockRefreshTokenRepo,
      userRepository: mockUserRepo,
      walletNonceStore,
    });
  });

  describe('GET /auth/wallet/nonce', () => {
    it('returns 400 when walletAddress query param is missing', async () => {
      const req: any = { query: {} };
      const res: any = { json: jest.fn() };
      const next = jest.fn();

      await authController.getWalletNonce(req, res, next);

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'MISSING_AUTH_FIELDS',
        })
      );
    });

    it('returns 401 when walletAddress is not a valid ed25519 Stellar public key', async () => {
      const req: any = { query: { walletAddress: 'not-a-valid-stellar-key' } };
      const res: any = { json: jest.fn() };
      const next = jest.fn();

      await authController.getWalletNonce(req, res, next);

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'INVALID_WALLET_ADDRESS',
        })
      );
    });

    it('returns 200 with nonce, message, and expiresAt for a valid Stellar address', async () => {
      const keypair = Keypair.random();
      const req: any = { query: { walletAddress: keypair.publicKey() } };
      const res: any = { json: jest.fn() };
      const next = jest.fn();

      await authController.getWalletNonce(req, res, next);

      expect(res.json).toHaveBeenCalled();
      const payload = res.json.mock.calls[0][0];
      expect(payload.success).toBe(true);
      expect(payload.data.nonce).toBeDefined();
      expect(payload.data.message).toContain(payload.data.nonce);
      expect(payload.data.expiresAt).toBeDefined();
    });
  });

  describe('POST /auth/wallet', () => {
    it('returns 401 when required fields are missing', async () => {
      const req: any = { body: {} };
      const res: any = { json: jest.fn() };
      const next = jest.fn();

      await authController.walletLogin(req, res, next);

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'MISSING_AUTH_FIELDS',
        })
      );
    });

    it('returns 401 when walletAddress is malformed', async () => {
      const req: any = {
        body: {
          walletAddress: 'invalid-stellar-address',
          signature: 'abcd'.repeat(32),
          message: 'Sign this message: 1234',
        },
      };
      const res: any = { json: jest.fn() };
      const next = jest.fn();

      await authController.walletLogin(req, res, next);

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'INVALID_WALLET_ADDRESS',
        })
      );
    });

    it('returns 401 when challenge nonce is unknown or invalid', async () => {
      const keypair = Keypair.random();
      const req: any = {
        body: {
          walletAddress: keypair.publicKey(),
          signature: 'ab'.repeat(64),
          message: 'Sign this message to authenticate with Callora: ' + '0'.repeat(64),
        },
      };
      const res: any = { json: jest.fn() };
      const next = jest.fn();

      await authController.walletLogin(req, res, next);

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'INVALID_WALLET_NONCE',
        })
      );
    });

    it('returns 401 when challenge nonce has expired', async () => {
      const keypair = Keypair.random();
      const challenge = walletNonceStore.generateNonce(keypair.publicKey(), -1000); // already expired

      const sig = keypair.sign(Buffer.from(challenge.message)).toString('hex');
      const req: any = {
        body: {
          walletAddress: keypair.publicKey(),
          signature: sig,
          message: challenge.message,
        },
      };
      const res: any = { json: jest.fn() };
      const next = jest.fn();

      await authController.walletLogin(req, res, next);

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'EXPIRED_WALLET_NONCE',
        })
      );
    });

    it('returns 401 when message has been tampered with', async () => {
      const keypair = Keypair.random();
      const challenge = walletNonceStore.generateNonce(keypair.publicKey());

      const tamperedMessage = challenge.message + ' extra';
      const sig = keypair.sign(Buffer.from(tamperedMessage)).toString('hex');

      const req: any = {
        body: {
          walletAddress: keypair.publicKey(),
          signature: sig,
          message: tamperedMessage,
        },
      };
      const res: any = { json: jest.fn() };
      const next = jest.fn();

      await authController.walletLogin(req, res, next);

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'TAMPERED_WALLET_MESSAGE',
        })
      );
    });

    it('returns 401 when signature verification fails (wrong key)', async () => {
      const keypair1 = Keypair.random();
      const keypair2 = Keypair.random();
      const challenge = walletNonceStore.generateNonce(keypair1.publicKey());

      // Signed with keypair2, but claimed as keypair1
      const sig = keypair2.sign(Buffer.from(challenge.message)).toString('hex');

      const req: any = {
        body: {
          walletAddress: keypair1.publicKey(),
          signature: sig,
          message: challenge.message,
        },
      };
      const res: any = { json: jest.fn() };
      const next = jest.fn();

      await authController.walletLogin(req, res, next);

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'INVALID_WALLET_SIGNATURE',
        })
      );
    });

    it('returns 401 on nonce replay (second login with same nonce)', async () => {
      const keypair = Keypair.random();
      const challenge = walletNonceStore.generateNonce(keypair.publicKey());
      const sig = keypair.sign(Buffer.from(challenge.message)).toString('hex');

      const req1: any = {
        body: {
          walletAddress: keypair.publicKey(),
          signature: sig,
          message: challenge.message,
        },
      };
      const res1: any = { json: jest.fn() };
      const next1 = jest.fn();

      await authController.walletLogin(req1, res1, next1);
      expect(res1.json).toHaveBeenCalled();

      // Second attempt with exact same nonce
      const req2: any = {
        body: {
          walletAddress: keypair.publicKey(),
          signature: sig,
          message: challenge.message,
        },
      };
      const res2: any = { json: jest.fn() };
      const next2 = jest.fn();

      await authController.walletLogin(req2, res2, next2);
      expect(next2).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'REUSED_WALLET_NONCE',
        })
      );
    });

    it('creates new user on first login and issues token pair', async () => {
      const keypair = Keypair.random();
      const challenge = walletNonceStore.generateNonce(keypair.publicKey());
      const sig = keypair.sign(Buffer.from(challenge.message)).toString('hex');

      mockUserRepo.findByStellarAddress.mockResolvedValue(null);

      const req: any = {
        body: {
          walletAddress: keypair.publicKey(),
          signature: sig,
          message: challenge.message,
        },
      };
      const res: any = { json: jest.fn() };
      const next = jest.fn();

      await authController.walletLogin(req, res, next);

      expect(mockUserRepo.findByStellarAddress).toHaveBeenCalledWith(keypair.publicKey());
      expect(mockUserRepo.create).toHaveBeenCalledWith({ stellarAddress: keypair.publicKey() });
      expect(mockRefreshTokenRepo.createRefreshToken).toHaveBeenCalled();

      expect(res.json).toHaveBeenCalled();
      const envelope = res.json.mock.calls[0][0];
      expect(envelope.success).toBe(true);
      expect(envelope.data.accessToken).toBeDefined();
      expect(envelope.data.refreshToken).toBeDefined();
      expect(envelope.data.tokenType).toBe('Bearer');
    });

    it('reuses existing user on repeat login', async () => {
      const keypair = Keypair.random();
      const challenge = walletNonceStore.generateNonce(keypair.publicKey());
      const sig = keypair.sign(Buffer.from(challenge.message)).toString('base64'); // test base64 signature

      mockUserRepo.findByStellarAddress.mockResolvedValue({
        id: 'existing-user-uuid',
        stellarAddress: keypair.publicKey(),
        createdAt: new Date(),
      });

      const req: any = {
        body: {
          walletAddress: keypair.publicKey(),
          signature: sig,
          message: challenge.message,
        },
      };
      const res: any = { json: jest.fn() };
      const next = jest.fn();

      await authController.walletLogin(req, res, next);

      expect(mockUserRepo.findByStellarAddress).toHaveBeenCalledWith(keypair.publicKey());
      expect(mockUserRepo.create).not.toHaveBeenCalled();

      expect(res.json).toHaveBeenCalled();
      const envelope = res.json.mock.calls[0][0];
      expect(envelope.success).toBe(true);
      expect(envelope.data.accessToken).toBeDefined();
    });
  });
});
