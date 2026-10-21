import { Request, Response } from 'express';
import { DepositController } from './depositController.js';
import { TransactionBuilderService, InvalidContractIdError, NetworkError } from '../services/transactionBuilder.js';
import { AmountValidator } from '../validators/amountValidator.js';
import type { VaultRepository } from '../repositories/vaultRepository.js';

// Mock the AmountValidator (fully auto-mocked — it only has static methods, no error classes)
jest.mock('../validators/amountValidator.js');
const MockedAmountValidator = AmountValidator as jest.Mocked<typeof AmountValidator>;


// Mock config to fix stellar.network so the controller's network-mismatch guard passes
jest.mock('../config/index.js', () => {
  const actual = jest.requireActual('../config/index.js');
  return {
    ...actual,
    config: {
      ...actual.config,
      stellar: { ...actual.config.stellar, network: 'testnet' },
    },
  };
});

describe('DepositController', () => {
  let depositController: DepositController;
  let mockVaultRepository: jest.Mocked<VaultRepository>;
  let mockTransactionBuilder: jest.Mocked<TransactionBuilderService>;
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockLocals: { authenticatedUser: { id: string; email: string } };

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Create mock dependencies
    mockVaultRepository = {
      findByUserId: jest.fn(),
    } as unknown as jest.Mocked<VaultRepository>;

    mockTransactionBuilder = {
      buildDepositTransaction: jest.fn(),
    } as unknown as jest.Mocked<TransactionBuilderService>;

    // Create controller instance
    depositController = new DepositController(mockVaultRepository, mockTransactionBuilder);

    // Create mock request/response objects
    mockReq = {
      body: {},
      headers: {},
    };

    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      locals: {},
    };

    mockLocals = {
      authenticatedUser: {
        id: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        email: 'test@example.com',
      },
    };

    // Setup default AmountValidator mock
    MockedAmountValidator.validateUsdcAmount.mockReturnValue({
      valid: true,
      normalizedAmount: '10.0000000',
    });

  });

  describe('prepareDeposit', () => {
    const validRequest = {
      amount_usdc: '10.00',
      network: 'testnet',
      source_account: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    };


    it('should return 401 when user is not authenticated', async () => {
      // Arrange
      mockReq.body = validRequest;
      mockRes.locals = { authenticatedUser: null };

      // Act
      await depositController.prepareDeposit(mockReq as Request, mockRes as Response);

      // Assert
      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: 'UNAUTHORIZED' }),
      }));
    });

    it('should return 400 when amount_usdc is missing', async () => {
      // Arrange
      mockReq.body = { ...validRequest, amount_usdc: undefined };
      mockRes.locals = mockLocals;

      // Act
      await depositController.prepareDeposit(mockReq as Request, mockRes as Response);

      // Assert
      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: 'MISSING_AMOUNT' }),
      }));
    });

    it('should return 400 when amount_usdc is not a string', async () => {
      // Arrange
      mockReq.body = { ...validRequest, amount_usdc: 10.00 };
      mockRes.locals = mockLocals;

      // Act
      await depositController.prepareDeposit(mockReq as Request, mockRes as Response);

      // Assert
      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: 'INVALID_AMOUNT_TYPE' }),
      }));
    });

    it('should return 400 when amount validation fails', async () => {
      // Arrange
      mockReq.body = validRequest;
      mockRes.locals = mockLocals;
      
      MockedAmountValidator.validateUsdcAmount.mockReturnValue({
        valid: false,
        error: 'Amount must be positive and have at most 7 decimal places',
      });

      // Act
      await depositController.prepareDeposit(mockReq as Request, mockRes as Response);

      // Assert
      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        error: expect.objectContaining({
          code: 'INVALID_AMOUNT_FORMAT',
          details: [expect.objectContaining({ field: 'body.amount_usdc', code: 'INVALID_AMOUNT_FORMAT' })],
        }),
        provided: '10.00',
      }));
    });

    it('should return 400 when network is invalid', async () => {
      // Arrange
      mockReq.body = { ...validRequest, network: 'invalid' };
      mockRes.locals = mockLocals;

      // Act
      await depositController.prepareDeposit(mockReq as Request, mockRes as Response);

      // Assert
      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        error: expect.objectContaining({
          code: 'INVALID_NETWORK',
          details: [expect.objectContaining({ field: 'body.network', code: 'INVALID_NETWORK' })],
        }),
        provided: 'invalid',
      }));
    });


    it('should return 400 when source_account is invalid', async () => {
      // Arrange
      mockReq.body = { ...validRequest, source_account: 'invalid-key' };
      mockRes.locals = mockLocals;

      // Act
      await depositController.prepareDeposit(mockReq as Request, mockRes as Response);

      // Assert
      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        error: expect.objectContaining({
          code: 'INVALID_SOURCE_ACCOUNT',
          details: [expect.objectContaining({ field: 'body.source_account', code: 'INVALID_SOURCE_ACCOUNT' })],
        }),
        provided: 'invalid-key',
      }));
    });

    it('should return 404 when vault is not found', async () => {
      // Arrange
      mockReq.body = validRequest;
      mockRes.locals = mockLocals;
      
      mockVaultRepository.findByUserId.mockResolvedValue(null);

      // Act
      await depositController.prepareDeposit(mockReq as Request, mockRes as Response);

      // Assert
      expect(mockRes.status).toHaveBeenCalledWith(404);
      expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: 'VAULT_NOT_FOUND' }),
      }));
    });

    it('should handle InvalidContractIdError from TransactionBuilder', async () => {
      // Arrange
      mockReq.body = validRequest;
      mockRes.locals = mockLocals;
      
      mockVaultRepository.findByUserId.mockResolvedValue({
        id: 'vault-123',
        userId: mockLocals.authenticatedUser.id,
        network: 'testnet',
        contractId: 'invalid-contract-id',
        balanceSnapshot: 0n,
        lastSyncedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      mockTransactionBuilder.buildDepositTransaction.mockRejectedValue(
        new InvalidContractIdError('invalid-contract-id')
      );

      // Act
      await depositController.prepareDeposit(mockReq as Request, mockRes as Response);

      // Assert
      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: 'INVALID_CONTRACT_ID' }),
      }));
    });

    it('should handle NetworkError from TransactionBuilder', async () => {
      // Arrange
      mockReq.body = validRequest;
      mockRes.locals = mockLocals;
      
      mockVaultRepository.findByUserId.mockResolvedValue({
        id: 'vault-123',
        userId: mockLocals.authenticatedUser.id,
        network: 'testnet',
        contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        balanceSnapshot: 0n,
        lastSyncedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      mockTransactionBuilder.buildDepositTransaction.mockRejectedValue(
        new NetworkError('Failed to connect to Stellar network')
      );

      // Act
      await depositController.prepareDeposit(mockReq as Request, mockRes as Response);

      // Assert
      expect(mockRes.status).toHaveBeenCalledWith(503);
      expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
        code: 'NETWORK_UNAVAILABLE',
      }));
    });

    it('should handle generic errors gracefully', async () => {
      // Arrange
      mockReq.body = validRequest;
      mockRes.locals = mockLocals;
      
      mockVaultRepository.findByUserId.mockResolvedValue({
        id: 'vault-123',
        userId: mockLocals.authenticatedUser.id,
        network: 'testnet',
        contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        balanceSnapshot: 0n,
        lastSyncedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      mockTransactionBuilder.buildDepositTransaction.mockRejectedValue(
        new Error('Unexpected error')
      );

      // Act
      await depositController.prepareDeposit(mockReq as Request, mockRes as Response);

      // Assert
      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: 'INTERNAL_ERROR' }),
      }));
    });



  });
});
