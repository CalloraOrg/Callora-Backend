import { Repository } from 'typeorm';
import { Developer } from '../../src/models/Developer';
import { Api } from '../../src/models/Api';
import { DeveloperRepository } from '../../src/repositories/DeveloperRepository';
import { DatabaseError, NotFoundError } from '../../src/errors/RepositoryError';

describe('DeveloperRepository', () => {
  let repository: DeveloperRepository;
  let mockDeveloperRepo: jest.Mocked<Repository<Developer>>;
  let mockApiRepo: jest.Mocked<Repository<Api>>;

  beforeEach(() => {
    mockDeveloperRepo = {
      create: jest.fn(),
      save: jest.fn(),
      findOne: jest.fn(),
      find: jest.fn(),
    } as unknown as jest.Mocked<Repository<Developer>>;

    mockApiRepo = {
      find: jest.fn(),
    } as unknown as jest.Mocked<Repository<Api>>;

    repository = new DeveloperRepository(mockDeveloperRepo, mockApiRepo);
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('should create a developer successfully', async () => {
      const mockDeveloper = {
        id: '123',
        user_id: 'user-456',
        created_at: new Date(),
        updated_at: new Date(),
      } as Developer;

      mockDeveloperRepo.create.mockReturnValue(mockDeveloper);
      mockDeveloperRepo.save.mockResolvedValue(mockDeveloper);

      const result = await repository.create({ user_id: 'user-456' });

      expect(result).toEqual(mockDeveloper);
      expect(mockDeveloperRepo.create).toHaveBeenCalledWith({
        user_id: 'user-456',
      });
      expect(mockDeveloperRepo.save).toHaveBeenCalledWith(mockDeveloper);
    });

    it('should throw DatabaseError on failure', async () => {
      mockDeveloperRepo.create.mockReturnValue({} as Developer);
      mockDeveloperRepo.save.mockRejectedValue(new Error('DB connection failed'));

      await expect(repository.create({ user_id: 'user-456' })).rejects.toThrow(
        DatabaseError
      );
    });
  });

  describe('findByUserId', () => {
    it('should find developer by user_id', async () => {
      const mockDeveloper = {
        id: '123',
        user_id: 'user-456',
        created_at: new Date(),
        updated_at: new Date(),
      } as Developer;

      mockDeveloperRepo.findOne.mockResolvedValue(mockDeveloper);

      const result = await repository.findByUserId('user-456');

      expect(result).toEqual(mockDeveloper);
      expect(mockDeveloperRepo.findOne).toHaveBeenCalledWith({
        where: { user_id: 'user-456' },
      });
    });

    it('should return null when developer not found', async () => {
      mockDeveloperRepo.findOne.mockResolvedValue(null);

      const result = await repository.findByUserId('nonexistent');

      expect(result).toBeNull();
    });

    it('should throw DatabaseError on query failure', async () => {
      mockDeveloperRepo.findOne.mockRejectedValue(new Error('Query failed'));

      await expect(repository.findByUserId('user-456')).rejects.toThrow(
        DatabaseError
      );
    });
  });

  describe('findById', () => {
    it('should find developer by id', async () => {
      const mockDeveloper = {
        id: '123',
        user_id: 'user-456',
        created_at: new Date(),
        updated_at: new Date(),
      } as Developer;

      mockDeveloperRepo.findOne.mockResolvedValue(mockDeveloper);

      const result = await repository.findById('123');

      expect(result).toEqual(mockDeveloper);
      expect(mockDeveloperRepo.findOne).toHaveBeenCalledWith({
        where: { id: '123' },
      });
    });

    it('should return null when developer not found', async () => {
      mockDeveloperRepo.findOne.mockResolvedValue(null);

      const result = await repository.findById('nonexistent');

      expect(result).toBeNull();
    });

    it('should throw DatabaseError on query failure', async () => {
      mockDeveloperRepo.findOne.mockRejectedValue(new Error('Query failed'));

      await expect(repository.findById('123')).rejects.toThrow(DatabaseError);
    });
  });

  describe('update', () => {
    it('should update developer successfully', async () => {
      const existingDeveloper = {
        id: '123',
        user_id: 'user-456',
        created_at: new Date(),
        updated_at: new Date(),
      } as Developer;

      const updatedDeveloper = {
        ...existingDeveloper,
        user_id: 'user-789',
      } as Developer;

      mockDeveloperRepo.findOne.mockResolvedValue(existingDeveloper);
      mockDeveloperRepo.save.mockResolvedValue(updatedDeveloper);

      const result = await repository.update('123', { user_id: 'user-789' });

      expect(result.user_id).toBe('user-789');
      expect(mockDeveloperRepo.save).toHaveBeenCalled();
    });

    it('should throw NotFoundError when developer does not exist', async () => {
      mockDeveloperRepo.findOne.mockResolvedValue(null);

      await expect(
        repository.update('nonexistent', { user_id: 'user-789' })
      ).rejects.toThrow(NotFoundError);
    });

    it('should throw DatabaseError on update failure', async () => {
      const existingDeveloper = {
        id: '123',
        user_id: 'user-456',
        created_at: new Date(),
        updated_at: new Date(),
      } as Developer;

      mockDeveloperRepo.findOne.mockResolvedValue(existingDeveloper);
      mockDeveloperRepo.save.mockRejectedValue(new Error('Update failed'));

      await expect(
        repository.update('123', { user_id: 'user-789' })
      ).rejects.toThrow(DatabaseError);
    });

    it('should handle update with no changes', async () => {
      const existingDeveloper = {
        id: '123',
        user_id: 'user-456',
        created_at: new Date(),
        updated_at: new Date(),
      } as Developer;

      mockDeveloperRepo.findOne.mockResolvedValue(existingDeveloper);
      mockDeveloperRepo.save.mockResolvedValue(existingDeveloper);

      const result = await repository.update('123', {});

      expect(result).toEqual(existingDeveloper);
      expect(mockDeveloperRepo.save).toHaveBeenCalledWith(existingDeveloper);
    });
  });

  describe('listApis', () => {
    it('should list all APIs for a developer', async () => {
      const mockDeveloper = {
        id: '123',
        user_id: 'user-456',
        created_at: new Date(),
        updated_at: new Date(),
      } as Developer;

      const mockApis = [
        {
          id: 'api-1',
          developer_id: '123',
          name: 'API 1',
          created_at: new Date(),
          updated_at: new Date(),
        },
        {
          id: 'api-2',
          developer_id: '123',
          name: 'API 2',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ] as Api[];

      mockDeveloperRepo.findOne.mockResolvedValue(mockDeveloper);
      mockApiRepo.find.mockResolvedValue(mockApis);

      const result = await repository.listApis('123');

      expect(result).toEqual(mockApis);
      expect(mockApiRepo.find).toHaveBeenCalledWith({
        where: { developer_id: '123' },
        order: { created_at: 'DESC' },
      });
    });

    it('should return empty array when developer has no APIs', async () => {
      const mockDeveloper = {
        id: '123',
        user_id: 'user-456',
        created_at: new Date(),
        updated_at: new Date(),
      } as Developer;

      mockDeveloperRepo.findOne.mockResolvedValue(mockDeveloper);
      mockApiRepo.find.mockResolvedValue([]);

      const result = await repository.listApis('123');

      expect(result).toEqual([]);
    });

    it('should throw NotFoundError when developer does not exist', async () => {
      mockDeveloperRepo.findOne.mockResolvedValue(null);

      await expect(repository.listApis('nonexistent')).rejects.toThrow(
        NotFoundError
      );
    });

    it('should throw DatabaseError on query failure', async () => {
      const mockDeveloper = {
        id: '123',
        user_id: 'user-456',
        created_at: new Date(),
        updated_at: new Date(),
      } as Developer;

      mockDeveloperRepo.findOne.mockResolvedValue(mockDeveloper);
      mockApiRepo.find.mockRejectedValue(new Error('Query failed'));

      await expect(repository.listApis('123')).rejects.toThrow(DatabaseError);
    });
  });
});
