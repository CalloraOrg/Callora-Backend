import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { pool } from '../db';
import { ApiRepository } from './ApiRepository';

const repo = new ApiRepository();

describe('ApiRepository', () => {
  // 1. Setup Phase: Create the table before any tests run
  beforeAll(async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS apis (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        endpoint VARCHAR(255) UNIQUE NOT NULL
      );
    `);
  });

  // 2. Isolation Phase: Truncate the table before EACH test so data doesn't bleed
  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE apis RESTART IDENTITY CASCADE;');
  });

  // 3. Teardown Phase: Close the connection pool
  afterAll(async () => {
    await pool.end();
  });

  it('should create a new API record', async () => {
    const api = await repo.create({ name: 'Auth API', endpoint: '/auth' });
    expect(api).toHaveProperty('id');
    expect(api.name).toBe('Auth API');
    expect(api.endpoint).toBe('/auth');
  });

  it('should throw an error on duplicate endpoint (Edge Case)', async () => {
    await repo.create({ name: 'Billing API', endpoint: '/billing' });

    // Attempting to create another API with the exact same endpoint should fail the UNIQUE constraint
    await expect(repo.create({ name: 'Duplicate API', endpoint: '/billing' }))
      .rejects.toThrow(/duplicate key value/);
  });

  it('should read an existing API by ID', async () => {
    const created = await repo.create({ name: 'Usage API', endpoint: '/usage' });
    const found = await repo.findById(created.id);
    expect(found).toEqual(created);
  });

  it('should return null for a non-existent ID (Edge Case)', async () => {
    const found = await repo.findById(9999);
    expect(found).toBeNull();
  });

  it('should list all APIs', async () => {
    await repo.create({ name: 'API 1', endpoint: '/api1' });
    await repo.create({ name: 'API 2', endpoint: '/api2' });

    const list = await repo.findAll();
    expect(list).toHaveLength(2);
    expect(list[0].name).toBe('API 1');
  });

  it('should update an API successfully', async () => {
    const created = await repo.create({ name: 'Old Name', endpoint: '/old' });
    const updated = await repo.update(created.id, { name: 'New Name' });

    expect(updated?.name).toBe('New Name');
    expect(updated?.endpoint).toBe('/old'); // Ensure un-updated fields stay the same
  });

  it('should return null when updating a non-existent ID', async () => {
    const updated = await repo.update(9999, { name: 'Ghost Name' });
    expect(updated).toBeNull();
  });
});