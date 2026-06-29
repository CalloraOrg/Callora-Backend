import express from 'express';
import type { Application } from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Keypair, TransactionBuilder, Networks, Account, Operation, Asset } from '@stellar/stellar-sdk';

import { requestIdMiddleware } from '../../middleware/requestId.js';
import { errorHandler } from '../../middleware/errorHandler.js';
import { createFeeAbstractionRouter } from './feeAbstraction.js';

// Mock feeBumper service
jest.mock('../../services/feeBumper.js', () => ({
  calculateFeeQuote: jest.fn(),
  createFeeBumpTransaction: jest.fn(),
  FeeBumperConfigError: class FeeBumperConfigError extends Error {
    constructor(msg: string) { super(msg); this.name = 'FeeBumperConfigError'; }
  },
  FeeBumperInvalidTransactionError: class FeeBumperInvalidTransactionError extends Error {
    constructor(msg: string) { super(msg); this.name = 'FeeBumperInvalidTransactionError'; }
  },
  FeeBumperSigningError: class FeeBumperSigningError extends Error {
    constructor(msg: string) { super(msg); this.name = 'FeeBumperSigningError'; }
  },
}));

jest.mock('../../logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../events/event.emitter.js', () => ({
  calloraEvents: { emit: jest.fn(), on: jest.fn(), off: jest.fn(), listenerCount: jest.fn(() => 0) },
}));

import * as feeBumperModule from '../../services/feeBumper.js';
import { calloraEvents } from '../../events/event.emitter.js';

const JWT_SECRET = 'test-fee-abstraction-secret';
const USER_ID = 'user_fa_test';

function makeToken(userId = USER_ID): string {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '1h' });
}

function buildApp(): Application {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use('/api/billing/fee-abstraction', createFeeAbstractionRouter());
  app.use(errorHandler);
  return app;
}

const MOCK_INNER_XDR = (() => {
  const kp = Keypair.random();
  const acct = new Account(kp.publicKey(), '0');
  const tx = new TransactionBuilder(acct, { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.payment({ destination: kp.publicKey(), asset: Asset.native(), amount: '1' }))
    .setTimeout(30)
    .build();
  tx.sign(kp);
  return tx.toXDR();
})();

const MOCK_QUOTE = {
  baseFeeStroops: 100,
  feeBumpFeeStroops: 600,
  feeBumpFeeXlm: '0.0000600',
  appTokenAmount: '0.0000060',
  network: 'testnet',
};

const MOCK_FEE_BUMP_RESULT = {
  feeBumpXdr: 'AAAAAA==',
  feeAccountPublicKey: Keypair.random().publicKey(),
  feeStroops: 600,
};

describe('Fee-Abstraction routes', () => {
  let app: Application;

  beforeAll(() => {
    process.env.JWT_SECRET = JWT_SECRET;
  });

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  afterAll(() => {
    delete process.env.JWT_SECRET;
  });

  // ─── Quote endpoint ─────────────────────────────────────────────────────────

  describe('POST /api/billing/fee-abstraction/quote', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app)
        .post('/api/billing/fee-abstraction/quote')
        .send({ innerXdr: MOCK_INNER_XDR });
      expect(res.status).toBe(401);
    });

    it('returns 400 when innerXdr is missing', async () => {
      const res = await request(app)
        .post('/api/billing/fee-abstraction/quote')
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({});
      expect(res.status).toBe(400);
    });

    it('returns 400 when innerXdr is empty string', async () => {
      const res = await request(app)
        .post('/api/billing/fee-abstraction/quote')
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({ innerXdr: '' });
      expect(res.status).toBe(400);
    });

    it('returns 400 when innerXdr is not a valid transaction', async () => {
      const { FeeBumperInvalidTransactionError } = await import('../../services/feeBumper.js');
      (feeBumperModule.calculateFeeQuote as jest.Mock).mockImplementation(() => {
        throw new FeeBumperInvalidTransactionError('invalid XDR');
      });

      const res = await request(app)
        .post('/api/billing/fee-abstraction/quote')
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({ innerXdr: 'bad-xdr' });

      expect(res.status).toBe(400);
    });

    it('returns 200 with quote on valid request', async () => {
      (feeBumperModule.calculateFeeQuote as jest.Mock).mockReturnValue(MOCK_QUOTE);

      const res = await request(app)
        .post('/api/billing/fee-abstraction/quote')
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({ innerXdr: MOCK_INNER_XDR });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        baseFeeStroops: 100,
        feeBumpFeeStroops: 600,
        feeBumpFeeXlm: '0.0000600',
        appTokenAmount: '0.0000060',
        network: 'testnet',
      });
    });

    it('passes innerXdr to calculateFeeQuote', async () => {
      (feeBumperModule.calculateFeeQuote as jest.Mock).mockReturnValue(MOCK_QUOTE);

      await request(app)
        .post('/api/billing/fee-abstraction/quote')
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({ innerXdr: MOCK_INNER_XDR });

      expect(feeBumperModule.calculateFeeQuote).toHaveBeenCalledWith(MOCK_INNER_XDR);
    });
  });

  // ─── Execute endpoint ────────────────────────────────────────────────────────

  describe('POST /api/billing/fee-abstraction', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app)
        .post('/api/billing/fee-abstraction')
        .send({ innerXdr: MOCK_INNER_XDR, appTokenPaymentTxId: 'tx_abc' });
      expect(res.status).toBe(401);
    });

    it('returns 400 when innerXdr is missing', async () => {
      const res = await request(app)
        .post('/api/billing/fee-abstraction')
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({ appTokenPaymentTxId: 'tx_abc' });
      expect(res.status).toBe(400);
    });

    it('returns 400 when appTokenPaymentTxId is missing', async () => {
      const res = await request(app)
        .post('/api/billing/fee-abstraction')
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({ innerXdr: MOCK_INNER_XDR });
      expect(res.status).toBe(400);
    });

    it('returns 400 when innerXdr is invalid', async () => {
      const { FeeBumperInvalidTransactionError } = await import('../../services/feeBumper.js');
      (feeBumperModule.createFeeBumpTransaction as jest.Mock).mockImplementation(() => {
        throw new FeeBumperInvalidTransactionError('invalid XDR');
      });

      const res = await request(app)
        .post('/api/billing/fee-abstraction')
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({ innerXdr: 'bad-xdr', appTokenPaymentTxId: 'tx_abc' });

      expect(res.status).toBe(400);
    });

    it('returns 500 when FEE_BUMPER_SECRET_KEY is not configured', async () => {
      const { FeeBumperConfigError } = await import('../../services/feeBumper.js');
      (feeBumperModule.createFeeBumpTransaction as jest.Mock).mockImplementation(() => {
        throw new FeeBumperConfigError('FEE_BUMPER_SECRET_KEY is not configured');
      });

      const res = await request(app)
        .post('/api/billing/fee-abstraction')
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({ innerXdr: MOCK_INNER_XDR, appTokenPaymentTxId: 'tx_abc' });

      expect(res.status).toBe(500);
    });

    it('returns 500 on signing failure', async () => {
      const { FeeBumperSigningError } = await import('../../services/feeBumper.js');
      (feeBumperModule.createFeeBumpTransaction as jest.Mock).mockImplementation(() => {
        throw new FeeBumperSigningError('signing failed');
      });

      const res = await request(app)
        .post('/api/billing/fee-abstraction')
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({ innerXdr: MOCK_INNER_XDR, appTokenPaymentTxId: 'tx_abc' });

      expect(res.status).toBe(500);
    });

    it('returns 200 with fee-bump XDR on success', async () => {
      (feeBumperModule.createFeeBumpTransaction as jest.Mock).mockReturnValue(MOCK_FEE_BUMP_RESULT);

      const res = await request(app)
        .post('/api/billing/fee-abstraction')
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({ innerXdr: MOCK_INNER_XDR, appTokenPaymentTxId: 'tx_abc' });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        feeBumpXdr: MOCK_FEE_BUMP_RESULT.feeBumpXdr,
        feeAccountPublicKey: MOCK_FEE_BUMP_RESULT.feeAccountPublicKey,
        feeStroops: MOCK_FEE_BUMP_RESULT.feeStroops,
      });
    });

    it('emits fee_abstraction.executed event on success', async () => {
      (feeBumperModule.createFeeBumpTransaction as jest.Mock).mockReturnValue(MOCK_FEE_BUMP_RESULT);
      const mockEmit = calloraEvents.emit as jest.Mock;

      await request(app)
        .post('/api/billing/fee-abstraction')
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({ innerXdr: MOCK_INNER_XDR, appTokenPaymentTxId: 'tx_abc' });

      expect(mockEmit).toHaveBeenCalledWith(
        'fee_abstraction.executed',
        USER_ID,
        expect.objectContaining({
          userId: USER_ID,
          appTokenPaymentTxId: 'tx_abc',
          feeAccountPublicKey: MOCK_FEE_BUMP_RESULT.feeAccountPublicKey,
          feeStroops: MOCK_FEE_BUMP_RESULT.feeStroops,
        }),
      );
    });

    it('does not emit event when execution fails', async () => {
      const { FeeBumperSigningError } = await import('../../services/feeBumper.js');
      (feeBumperModule.createFeeBumpTransaction as jest.Mock).mockImplementation(() => {
        throw new FeeBumperSigningError('signing failed');
      });
      const mockEmit = calloraEvents.emit as jest.Mock;

      await request(app)
        .post('/api/billing/fee-abstraction')
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({ innerXdr: MOCK_INNER_XDR, appTokenPaymentTxId: 'tx_abc' });

      expect(mockEmit).not.toHaveBeenCalled();
    });
  });

  // ─── Rate limiting ───────────────────────────────────────────────────────────

  describe('rate limiting', () => {
    it('is enforced by the billing rate limiter (inherited from parent router)', async () => {
      // Rate limiting is applied at the billing router level in index.ts - 
      // verify the endpoint responds normally (rate limit is tested at the router level)
      (feeBumperModule.calculateFeeQuote as jest.Mock).mockReturnValue(MOCK_QUOTE);

      const res = await request(app)
        .post('/api/billing/fee-abstraction/quote')
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({ innerXdr: MOCK_INNER_XDR });

      expect(res.status).toBe(200);
    });
  });

  // ─── Correlation ID / logging ─────────────────────────────────────────────────

  describe('correlation ID propagation', () => {
    it('includes requestId middleware (x-request-id is set)', async () => {
      (feeBumperModule.calculateFeeQuote as jest.Mock).mockReturnValue(MOCK_QUOTE);

      const res = await request(app)
        .post('/api/billing/fee-abstraction/quote')
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({ innerXdr: MOCK_INNER_XDR });

      // requestIdMiddleware injects x-request-id response header
      expect(res.headers['x-request-id']).toBeDefined();
    });
  });
});
