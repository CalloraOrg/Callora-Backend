import { Request, Response } from 'express';
import { DepositController } from './depositController.js';
import { TransactionBuilderService, InvalidContractIdError, NetworkError, SimulationError } from '../services/transactionBuilder.js';
import { AmountValidator } from '../validators/amountValidator.js';
import type { VaultRepository } from '../repositories/vaultRepository.js';
import type { UserRepository } from '../repositories/userRepository.js';

// Mock the AmountValidator (fully auto-mocked — it only has static methods, no error classes)
jest.mock('../validators/amountValidator.js');
const MockedAmountValidator = AmountValidator as jest.Mocked<typeof AmountValidator>;

// Mock the TransactionBuilderService but PRESERVE real error classes so instanceof checks work
jest.mock('../services/transactionBuilder.js', () => {
  const actual = jest.requireActual('../services/transactionBuilder.js');
  const mockBuildDepositTransaction = jest.fn();
  function MockTransactionBuilderService(this: unknown) {}
  MockTransactionBuilderService.prototype.buildDepositTransaction = mockBuildDepositTransaction;
  return {
    ...actual,
    TransactionBuilderService: MockTransactionBuilderService,
  };
});

// Mock config to fix stellar.network so the controller's network-mismatch guard passes
jest.mock('../config/index.js', () => ({
  config: {
    stellar: { network: 'testnet' },
  },
}));

describe('DepositController', () => {
  let depositController: DepositController;
  let mockVaultRepository: jest.Mocked<VaultRepository>;
  let mockTransactionBuilder: jest.Mocked<TransactionBuilderService>;
  let mockUserRepository: jest.Mocked<UserRepository>;
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

    mockUserRepository = {
      findById: jest.fn(),
    } as unknown as jest.Mocked<UserRepository>;

    // Create controller instance with mocked userRepository
    depositController = new DepositController(mockVaultRepository, mockTransactionBuilder, mockUserRepository);

    // Create mock request/response objects
    mockReq = {
      body: {},
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

    // Setup default TransactionBuilder mock
    mockTransactionBuilder.buildDepositTransaction.mockResolvedValue({
      xdr: 'AAAAAgAAAAA...mocked-xdr...',
      network: 'testnet',
      operation: {
        type: 'invoke_contract',
        contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        function: 'deposit',
        args: [
          { type: 'address', value: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
          { type: 'i128', value: '100000000' },
        ],
      },
      fee: '100',
      timeout: 300,
      resourceFee: '123456',
      minResourceFee: '100000',
      latestLedger: 12345678,
    });

    // Setup default UserRepository mock
    mockUserRepository.findById.mockResolvedValue({
      id: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      stellarAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      createdAt: new Date(),
    });
  });

  describe('prepareDeposit', () => {
    const validRequest = {
      amount_usdc: '10.00',
      network: 'testnet',
      source_account: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    };

    it('should successfully prepare a deposit transaction', async () => {
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

      // Act
      await depositController.prepareDeposit(mockReq as Request, mockRes as Response);

      // Assert
      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            xdr: expect.any(String),
            network: 'testnet',
            contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            amount: '10.0000000',
            operation: {
              type: 'invoke_contract',
              function: 'deposit',
              args: expect.arrayContaining([
                expect.objectContaining({ type: 'address' }),
                expect.objectContaining({ type: 'i128' }),
              ]),
            },
            metadata: {
              fee: '100',
              timeout: 300,
              resourceFee: '123456',
              minResourceFee: '100000',
              latestLedger: 12345678,
            },
          }),
          requestId: expect.any(String),
          timestamp: expect.any(String),
        })
      );
      
      // Verify TransactionBuilder was called with userStellarAddress from userRepository
      expect(mockTransactionBuilder.buildDepositTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          userStellarAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          vaultContractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          amountUsdc: '10.0000000',
          network: 'testnet',
          sourceAccount: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        })
      );
    });

    it('should return 401 when user is not authenticated', async () => {
      // Arrange
      mockReq.body = validRequest;
      mockRes.locals = { authenticatedUser: null };

      // Act
      await depositController.prepareDeposit(mockReq as Request, mockRes as Response);

      // Assert
      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        error: 'Authentication required',
        code: 'UNAUTHORIZED',
        requestId: expect.any(String),
        timestamp: expect.any(String),
      });
    });

    it('should return 400 when amount_usdc is missing', async () => {
      // Arrange
      mockReq.body = { ...validRequest, amount_usdc: undefined };
      mockRes.locals = mockLocals;

      // Act
      await depositController.prepareDeposit(mockReq as Request, mockRes as Response);

      // Assert
      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        error: 'amount_usdc is required',
        code: 'MISSING_AMOUNT',
        requestId: expect.any(String),
        timestamp: expect.any(String),
      });
    });

    it('should return 400 when amount_usdc is not a string', async () => {
      // Arrange
      mockReq.body = { ...validRequest, amount_usdc: 10.00 };
      mockRes.locals = mockLocals;

      // Act
      await depositController.prepareDeposit(mockReq as Request, mockRes as Response);

      // Assert
      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        error: 'amount_usdc must be a string',
        code: 'INVALID_AMOUNT_TYPE',
        requestId: expect.any(String),
        timestamp: expect.any(String),
      });
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
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        error: 'Amount must be positive and have at most 7 decimal places',
        code: 'INVALID_AMOUNT_FORMAT',
        provided: '10.00',
        requestId: expect.any(String),
        timestamp: expect.any(String),
      });
    });

    it('should return 400 when network is invalid', async () => {
      // Arrange
      mockReq.body = { ...validRequest, network: 'invalid' };
      mockRes.locals = mockLocals;

      // Act
      await depositController.prepareDeposit(mockReq as Request, mockRes as Response);

      // Assert
      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        error: 'network must be either "testnet" or "mainnet"',
        code: 'INVALID_NETWORK',
        provided: 'invalid',
        requestId: expect.any(String),
        timestamp: expect.any(String),
      });
    });

    it('should default to testnet when network is not provided', async () => {
      // Arrange
      mockReq.body = { ...validRequest, network: undefined };
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

      // Act
      await depositController.prepareDeposit(mockReq as Request, mockRes as Response);

      // Assert
      expect(mockVaultRepository.findByUserId).toHaveBeenCalledWith(
        mockLocals.authenticatedUser.id,
        'testnet'
      );
    });

    it('should return 400 when source_account is invalid', async () => {
      // Arrange
      mockReq.body = { ...validRequest, source_account: 'invalid-key' };
      mockRes.locals = mockLocals;

      // Act
      await depositController.prepareDeposit(mockReq as Request, mockRes as Response);

      // Assert
      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        error: 'source_account must be a valid Stellar public key (G...)',
        code: 'INVALID_SOURCE_ACCOUNT',
        provided: 'invalid-key',
        requestId: expect.any(String),
        timestamp: expect.any(String),
      });
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
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        error: "Vault not found for user on network 'testnet'. Please create a vault first.",
        code: 'VAULT_NOT_FOUND',
        requestId: expect.any(String),
        timestamp: expect.any(String),
      });
    });

    it('should return 400 when user does not have a Stellar address configured', async () => {
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
      
      // User without stellar address
      mockUserRepository.findById.mockResolvedValue({
        id: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        stellarAddress: '',
        createdAt: new Date(),
      });

      // Act
      await depositController.prepareDeposit(mockReq as Request, mockRes as Response);

      // Assert
      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        error: 'User does not have a Stellar address configured. Please update your profile.',
        code: 'STELLAR_ADDRESS_REQUIRED',
        requestId: expect.any(String),
        timestamp: expect.any(String),
      });
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
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        error: 'Invalid vault contract configuration. Please contact support.',
        code: 'INVALID_CONTRACT_ID',
        requestId: expect.any(String),
        timestamp: expect.any(String),
      });
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
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        error: 'Unable to connect to Stellar network. Please try again later.',
        code: 'NETWORK_UNAVAILABLE',
        network: 'Failed to connect to Stellar network',
        requestId: expect.any(String),
        timestamp: expect.any(String),
      });
    });

    it('should handle SimulationError from TransactionBuilder', async () => {
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
        new SimulationError('Soroban simulation failed', {
          errorCode: 8,
          errorMessage: 'BelowMinDeposit',
          events: [],
          footprint: { readOnly: [], readWrite: [] },
        })
      );

      // Act
      await depositController.prepareDeposit(mockReq as Request, mockRes as Response);

      // Assert
      expect(mockRes.status).toHaveBeenCalledWith(502);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            code: 'SIMULATION_FAILED',
            message: 'Soroban simulation failed. See diagnostics for details.',
            simulationDetails: expect.objectContaining({
              errorCode: 8,
              errorMessage: 'BelowMinDeposit',
            }),
          }),
        })
      );
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
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        error: 'Failed to prepare deposit transaction',
        code: 'INTERNAL_ERROR',
        requestId: expect.any(String),
        timestamp: expect.any(String),
      });
    });

    it('should work with mainnet network', async () => {
      // Arrange - override the config mock to simulate a mainnet-configured server
      const configMock = jest.requireMock('../config/index.js');
      configMock.config.stellar.network = 'mainnet';

      mockReq.body = { ...validRequest, network: 'mainnet' };
      mockRes.locals = mockLocals;
      
      mockVaultRepository.findByUserId.mockResolvedValue({
        id: 'vault-123',
        userId: mockLocals.authenticatedUser.id,
        network: 'mainnet',
        contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        balanceSnapshot: 0n,
        lastSyncedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      mockTransactionBuilder.buildDepositTransaction.mockResolvedValue({
        xdr: 'AAAAAgAAAAA...mainnet-xdr...',
        network: 'mainnet',
        operation: {
          type: 'invoke_contract',
          contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          function: 'deposit',
          args: [
            { type: 'address', value: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
            { type: 'i128', value: '100000000' },
          ],
        },
        fee: '100',
        timeout: 300,
        resourceFee: '123456',
        minResourceFee: '100000',
        latestLedger: 12345678,
      });

      // Act
      await depositController.prepareDeposit(mockReq as Request, mockRes as Response);

      // Assert
      expect(mockVaultRepository.findByUserId).toHaveBeenCalledWith(
        mockLocals.authenticatedUser.id,
        'mainnet'
      );
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            network: 'mainnet',
          }),
        })
      );

      // Restore config mock to testnet for subsequent tests
      configMock.config.stellar.network = 'testnet';
    });

    it('should work without source_account (uses user stellar address from profile)', async () => {
      // Arrange
      mockReq.body = { ...validRequest, source_account: undefined };
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

      // Act
      await depositController.prepareDeposit(mockReq as Request, mockRes as Response);

      // Assert
      expect(mockTransactionBuilder.buildDepositTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          userStellarAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          vaultContractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          amountUsdc: '10.0000000',
          network: 'testnet',
          sourceAccount: undefined,
        })
      );
    });

    it('should validate Stellar public key format correctly', async () => {
      // Test valid keys — exactly G + 55 uppercase alphanumeric = 56 chars
      const validKeys = [
        'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      ];

      validKeys.forEach((key) => {
        expect(depositController['isValidStellarPublicKey'](key)).toBe(true);
      });

      // Test invalid keys
      const invalidKeys = [
        'invalid',
        'XAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', // Wrong prefix
        'GAAAAAAAAA', // Too short
        'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', // Too long (58)
        'gaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', // Lowercase
      ];

      invalidKeys.forEach((key) => {
        expect(depositController['isValidStellarPublicKey'](key)).toBe(false);
      });
    });
  });
});