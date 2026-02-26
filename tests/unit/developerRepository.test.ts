import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { InMemoryDeveloperRepository } from '../../src/repositories/developerRepository.js';
import { NotFoundError } from '../../src/errors/index.js';
import type { Api } from '../../src/db/schema.js';

describe('DeveloperRepository', () => {
  let repository: InMemoryDeveloperRepository;

  beforeEach(() => {
    repository = new InMemoryDeveloperRepository();
  });

  describe('create', () => {
    it('should create a developer successfully with minimal data', async () => {
      const result = await repository.create({ user_id: 'user-456' });

      assert.strictEqual(result.id, 1);
      assert.strictEqual(result.user_id, 'user-456');
      assert.strictEqual(result.name, null);
      assert.strictEqual(result.website, null);
      assert.strictEqual(result.description, null);
      assert.strictEqual(result.category, null);
      assert.ok(result.created_at instanceof Date);
      assert.ok(result.updated_at instanceof Date);
      assert.strictEqual(result.created_at.getTime(), result.updated_at.getTime());
    });

    it('should create a developer with all fields', async () => {
      const result = await repository.create({
        user_id: 'user-456',
        name: 'Test Developer',
        website: 'https://example.com',
        description: 'A test developer',
        category: 'fintech',
      });

      assert.strictEqual(result.user_id, 'user-456');
      assert.strictEqual(result.name, 'Test Developer');
      assert.strictEqual(result.website, 'https://example.com');
      assert.strictEqual(result.description, 'A test developer');
      assert.strictEqual(result.category, 'fintech');
    });

    it('should create multiple developers with auto-incrementing IDs', async () => {
      const dev1 = await repository.create({ user_id: 'user-1' });
      const dev2 = await repository.create({ user_id: 'user-2' });
      const dev3 = await repository.create({ user_id: 'user-3' });

      assert.strictEqual(dev1.id, 1);
      assert.strictEqual(dev2.id, 2);
      assert.strictEqual(dev3.id, 3);
    });

    it('should create developer with only name field', async () => {
      const result = await repository.create({
        user_id: 'user-456',
        name: 'Only Name',
      });

      assert.strictEqual(result.name, 'Only Name');
      assert.strictEqual(result.website, null);
      assert.strictEqual(result.description, null);
      assert.strictEqual(result.category, null);
    });

    it('should create developer with empty string values', async () => {
      const result = await repository.create({
        user_id: 'user-456',
        name: '',
        website: '',
        description: '',
        category: '',
      });

      assert.strictEqual(result.name, '');
      assert.strictEqual(result.website, '');
      assert.strictEqual(result.description, '');
      assert.strictEqual(result.category, '');
    });
  });

  describe('findByUserId', () => {
    it('should find developer by user_id', async () => {
      await repository.create({ user_id: 'user-456' });

      const result = await repository.findByUserId('user-456');

      assert.ok(result !== null);
      assert.strictEqual(result?.user_id, 'user-456');
    });

    it('should return null when developer not found', async () => {
      const result = await repository.findByUserId('nonexistent');

      assert.strictEqual(result, null);
    });

    it('should find correct developer among multiple', async () => {
      await repository.create({ user_id: 'user-1', name: 'Dev 1' });
      await repository.create({ user_id: 'user-2', name: 'Dev 2' });
      await repository.create({ user_id: 'user-3', name: 'Dev 3' });

      const result = await repository.findByUserId('user-2');

      assert.ok(result !== null);
      assert.strictEqual(result?.name, 'Dev 2');
    });

    it('should return a copy of the developer object', async () => {
      const created = await repository.create({ user_id: 'user-456', name: 'Original' });
      const found = await repository.findByUserId('user-456');

      assert.ok(found !== null);
      // Modify the returned object
      if (found) {
        found.name = 'Modified';
      }

      // Original should be unchanged
      const foundAgain = await repository.findByUserId('user-456');
      assert.strictEqual(foundAgain?.name, 'Original');
    });
  });

  describe('findById', () => {
    it('should find developer by id', async () => {
      const created = await repository.create({ user_id: 'user-456' });

      const result = await repository.findById(created.id);

      assert.ok(result !== null);
      assert.strictEqual(result?.id, created.id);
      assert.strictEqual(result?.user_id, 'user-456');
    });

    it('should return null when developer not found', async () => {
      const result = await repository.findById(999);

      assert.strictEqual(result, null);
    });

    it('should return null for negative ID', async () => {
      const result = await repository.findById(-1);

      assert.strictEqual(result, null);
    });

    it('should return null for zero ID', async () => {
      const result = await repository.findById(0);

      assert.strictEqual(result, null);
    });

    it('should find correct developer among multiple', async () => {
      const dev1 = await repository.create({ user_id: 'user-1', name: 'Dev 1' });
      const dev2 = await repository.create({ user_id: 'user-2', name: 'Dev 2' });
      const dev3 = await repository.create({ user_id: 'user-3', name: 'Dev 3' });

      const result = await repository.findById(dev2.id);

      assert.ok(result !== null);
      assert.strictEqual(result?.name, 'Dev 2');
    });

    it('should return a copy of the developer object', async () => {
      const created = await repository.create({ user_id: 'user-456', name: 'Original' });
      const found = await repository.findById(created.id);

      assert.ok(found !== null);
      // Modify the returned object
      if (found) {
        found.name = 'Modified';
      }

      // Original should be unchanged
      const foundAgain = await repository.findById(created.id);
      assert.strictEqual(foundAgain?.name, 'Original');
    });
  });

  describe('update', () => {
    it('should update developer name successfully', async () => {
      const created = await repository.create({ user_id: 'user-456', name: 'Original' });

      const result = await repository.update(created.id, {
        name: 'Updated Name',
      });

      assert.strictEqual(result.name, 'Updated Name');
      assert.strictEqual(result.user_id, 'user-456');
      assert.ok(result.updated_at.getTime() > created.updated_at.getTime());
    });

    it('should update multiple fields successfully', async () => {
      const created = await repository.create({ user_id: 'user-456' });

      const result = await repository.update(created.id, {
        name: 'Updated Name',
        website: 'https://updated.com',
        description: 'Updated description',
        category: 'updated-category',
      });

      assert.strictEqual(result.name, 'Updated Name');
      assert.strictEqual(result.website, 'https://updated.com');
      assert.strictEqual(result.description, 'Updated description');
      assert.strictEqual(result.category, 'updated-category');
      assert.strictEqual(result.user_id, 'user-456');
    });

    it('should update only provided fields', async () => {
      const created = await repository.create({
        user_id: 'user-456',
        name: 'Original Name',
        website: 'https://original.com',
        description: 'Original description',
        category: 'original-category',
      });

      const result = await repository.update(created.id, {
        name: 'Updated Name',
      });

      assert.strictEqual(result.name, 'Updated Name');
      assert.strictEqual(result.website, 'https://original.com');
      assert.strictEqual(result.description, 'Original description');
      assert.strictEqual(result.category, 'original-category');
    });

    it('should throw NotFoundError when developer does not exist', async () => {
      await assert.rejects(
        async () => repository.update(999, { name: 'Test' }),
        (error: Error) => {
          assert.ok(error instanceof NotFoundError);
          assert.ok(error.message.includes('999'));
          return true;
        }
      );
    });

    it('should handle update with no changes', async () => {
      const created = await repository.create({ user_id: 'user-456', name: 'Original' });

      const result = await repository.update(created.id, {});

      assert.strictEqual(result.id, created.id);
      assert.strictEqual(result.user_id, created.user_id);
      assert.strictEqual(result.name, 'Original');
      assert.ok(result.updated_at.getTime() > created.updated_at.getTime());
    });

    it('should update field to null by setting empty string', async () => {
      const created = await repository.create({
        user_id: 'user-456',
        name: 'Original Name',
        website: 'https://original.com',
      });

      const result = await repository.update(created.id, {
        name: '',
        website: '',
      });

      assert.strictEqual(result.name, '');
      assert.strictEqual(result.website, '');
    });

    it('should update website only', async () => {
      const created = await repository.create({
        user_id: 'user-456',
        name: 'Name',
        website: 'https://old.com',
      });

      const result = await repository.update(created.id, {
        website: 'https://new.com',
      });

      assert.strictEqual(result.website, 'https://new.com');
      assert.strictEqual(result.name, 'Name');
    });

    it('should update description only', async () => {
      const created = await repository.create({
        user_id: 'user-456',
        description: 'Old description',
      });

      const result = await repository.update(created.id, {
        description: 'New description',
      });

      assert.strictEqual(result.description, 'New description');
    });

    it('should update category only', async () => {
      const created = await repository.create({
        user_id: 'user-456',
        category: 'old-category',
      });

      const result = await repository.update(created.id, {
        category: 'new-category',
      });

      assert.strictEqual(result.category, 'new-category');
    });

    it('should preserve created_at timestamp on update', async () => {
      const created = await repository.create({ user_id: 'user-456' });
      const originalCreatedAt = created.created_at.getTime();

      const result = await repository.update(created.id, { name: 'Updated' });

      assert.strictEqual(result.created_at.getTime(), originalCreatedAt);
    });
  });

  describe('listApis', () => {
    it('should list all APIs for a developer', async () => {
      const developer = await repository.create({ user_id: 'user-456' });

      const api1: Api = {
        id: 1,
        developer_id: developer.id,
        name: 'API 1',
        description: null,
        base_url: 'https://api1.com',
        logo_url: null,
        category: null,
        status: 'active',
        created_at: new Date('2024-01-01'),
        updated_at: new Date('2024-01-01'),
      };

      const api2: Api = {
        id: 2,
        developer_id: developer.id,
        name: 'API 2',
        description: null,
        base_url: 'https://api2.com',
        logo_url: null,
        category: null,
        status: 'active',
        created_at: new Date('2024-01-02'),
        updated_at: new Date('2024-01-02'),
      };

      repository.addApi(api1);
      repository.addApi(api2);

      const result = await repository.listApis(developer.id);

      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].name, 'API 2'); // Sorted by created_at DESC
      assert.strictEqual(result[1].name, 'API 1');
    });

    it('should return empty array when developer has no APIs', async () => {
      const developer = await repository.create({ user_id: 'user-456' });

      const result = await repository.listApis(developer.id);

      assert.deepStrictEqual(result, []);
    });

    it('should throw NotFoundError when developer does not exist', async () => {
      await assert.rejects(
        async () => repository.listApis(999),
        (error: Error) => {
          assert.ok(error instanceof NotFoundError);
          assert.ok(error.message.includes('999'));
          return true;
        }
      );
    });

    it('should only return APIs for the specified developer', async () => {
      const developer1 = await repository.create({ user_id: 'user-1' });
      const developer2 = await repository.create({ user_id: 'user-2' });

      const api1: Api = {
        id: 1,
        developer_id: developer1.id,
        name: 'API 1',
        description: null,
        base_url: 'https://api1.com',
        logo_url: null,
        category: null,
        status: 'active',
        created_at: new Date(),
        updated_at: new Date(),
      };

      const api2: Api = {
        id: 2,
        developer_id: developer2.id,
        name: 'API 2',
        description: null,
        base_url: 'https://api2.com',
        logo_url: null,
        category: null,
        status: 'active',
        created_at: new Date(),
        updated_at: new Date(),
      };

      repository.addApi(api1);
      repository.addApi(api2);

      const result = await repository.listApis(developer1.id);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].name, 'API 1');
    });

    it('should sort APIs by created_at in descending order', async () => {
      const developer = await repository.create({ user_id: 'user-456' });

      const api1: Api = {
        id: 1,
        developer_id: developer.id,
        name: 'Oldest API',
        description: null,
        base_url: 'https://api1.com',
        logo_url: null,
        category: null,
        status: 'active',
        created_at: new Date('2024-01-01'),
        updated_at: new Date('2024-01-01'),
      };

      const api2: Api = {
        id: 2,
        developer_id: developer.id,
        name: 'Middle API',
        description: null,
        base_url: 'https://api2.com',
        logo_url: null,
        category: null,
        status: 'active',
        created_at: new Date('2024-01-15'),
        updated_at: new Date('2024-01-15'),
      };

      const api3: Api = {
        id: 3,
        developer_id: developer.id,
        name: 'Newest API',
        description: null,
        base_url: 'https://api3.com',
        logo_url: null,
        category: null,
        status: 'active',
        created_at: new Date('2024-01-30'),
        updated_at: new Date('2024-01-30'),
      };

      repository.addApi(api1);
      repository.addApi(api2);
      repository.addApi(api3);

      const result = await repository.listApis(developer.id);

      assert.strictEqual(result.length, 3);
      assert.strictEqual(result[0].name, 'Newest API');
      assert.strictEqual(result[1].name, 'Middle API');
      assert.strictEqual(result[2].name, 'Oldest API');
    });

    it('should return copies of API objects', async () => {
      const developer = await repository.create({ user_id: 'user-456' });

      const api: Api = {
        id: 1,
        developer_id: developer.id,
        name: 'Original API',
        description: null,
        base_url: 'https://api.com',
        logo_url: null,
        category: null,
        status: 'active',
        created_at: new Date(),
        updated_at: new Date(),
      };

      repository.addApi(api);

      const result = await repository.listApis(developer.id);
      
      // Modify returned object
      result[0].name = 'Modified API';

      // Get again and verify original is unchanged
      const result2 = await repository.listApis(developer.id);
      assert.strictEqual(result2[0].name, 'Original API');
    });

    it('should handle APIs with same created_at timestamp', async () => {
      const developer = await repository.create({ user_id: 'user-456' });
      const sameDate = new Date('2024-01-01T12:00:00Z');

      const api1: Api = {
        id: 1,
        developer_id: developer.id,
        name: 'API 1',
        description: null,
        base_url: 'https://api1.com',
        logo_url: null,
        category: null,
        status: 'active',
        created_at: sameDate,
        updated_at: sameDate,
      };

      const api2: Api = {
        id: 2,
        developer_id: developer.id,
        name: 'API 2',
        description: null,
        base_url: 'https://api2.com',
        logo_url: null,
        category: null,
        status: 'active',
        created_at: sameDate,
        updated_at: sameDate,
      };

      repository.addApi(api1);
      repository.addApi(api2);

      const result = await repository.listApis(developer.id);

      assert.strictEqual(result.length, 2);
      // Both should be present, order doesn't matter when timestamps are equal
      const names = result.map(api => api.name).sort();
      assert.deepStrictEqual(names, ['API 1', 'API 2']);
    });
  });

  describe('addApi helper method', () => {
    it('should add API to internal storage', async () => {
      const developer = await repository.create({ user_id: 'user-456' });

      const api: Api = {
        id: 1,
        developer_id: developer.id,
        name: 'Test API',
        description: 'Test description',
        base_url: 'https://test.com',
        logo_url: 'https://logo.com',
        category: 'test',
        status: 'draft',
        created_at: new Date(),
        updated_at: new Date(),
      };

      repository.addApi(api);

      const apis = await repository.listApis(developer.id);
      assert.strictEqual(apis.length, 1);
      assert.strictEqual(apis[0].id, 1);
      assert.strictEqual(apis[0].name, 'Test API');
      assert.strictEqual(apis[0].description, 'Test description');
      assert.strictEqual(apis[0].base_url, 'https://test.com');
      assert.strictEqual(apis[0].logo_url, 'https://logo.com');
      assert.strictEqual(apis[0].category, 'test');
      assert.strictEqual(apis[0].status, 'draft');
    });
  });
});
