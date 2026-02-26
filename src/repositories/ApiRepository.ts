import { pool } from '../db';

export interface ApiRecord {
id: number;
name: string;
endpoint: string;
}

export class ApiRepository {
async create(data: Omit<ApiRecord, 'id'>): Promise<ApiRecord> {
    const result = await pool.query(
      'INSERT INTO apis (name, endpoint) VALUES ($1, $2) RETURNING *',
      [data.name, data.endpoint]
    );
    return result.rows[0];
  }

  async findById(id: number): Promise<ApiRecord | null> {
    const result = await pool.query('SELECT * FROM apis WHERE id = $1', [id]);
    return result.rows[0] || null;
  }

  async findAll(): Promise<ApiRecord[]> {
    const result = await pool.query('SELECT * FROM apis ORDER BY id ASC');
    return result.rows;
  }

  async update(id: number, data: Partial<ApiRecord>): Promise<ApiRecord | null> {
    const result = await pool.query(
      'UPDATE apis SET name = COALESCE($1, name), endpoint = COALESCE($2, endpoint) WHERE id = $3 RETURNING *',
      [data.name, data.endpoint, id]
    );
    return result.rows[0] || null;
  }
}