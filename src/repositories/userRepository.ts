import type { Pool } from 'pg';
import { NotFoundError } from '../errors/index.js';
import { pool } from '../db.js';
import type { PaginationParams } from '../lib/pagination.js';

export interface UserDto {
  id: string;
  stellarAddress: string;
  createdAt: Date;
}

export interface UserListItem {
  id: string;
  stellar_address: string;
  created_at: Date;
}

export interface CreateUserInput {
  stellarAddress: string;
}

export interface UpdateUserInput {
  stellarAddress?: string;
}

interface UserRow {
  id: string;
  stellar_address: string;
  created_at: Date | string;
}

interface CountRow {
  count: string;
}

export interface FindUsersResult {
  users: UserListItem[];
  total: number;
}

export interface UserRepository {
  create(user: CreateUserInput): Promise<UserDto>;
  findByStellarAddress(address: string): Promise<UserDto | null>;
  findById(id: string): Promise<UserDto | null>;
  update(id: string, data: UpdateUserInput): Promise<UserDto>;
  list(params: PaginationParams): Promise<FindUsersResult>;
}

export interface UserRepositoryQueryable {
  query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

const mapUserRow = (row: UserRow): UserDto => ({
  id: row.id,
  stellarAddress: row.stellar_address,
  createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
});

const mapUserListRow = (row: UserRow): UserListItem => ({
  id: row.id,
  stellar_address: row.stellar_address,
  created_at: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
});

const assertNonEmpty = (value: string, fieldName: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${fieldName} is required.`);
  }

  return trimmed;
};

export class PgUserRepository implements UserRepository {
  constructor(private readonly db: UserRepositoryQueryable = pool as Pool) {}

  async create(user: CreateUserInput): Promise<UserDto> {
    const stellarAddress = assertNonEmpty(user.stellarAddress, 'stellarAddress');
    const result = await this.db.query<UserRow>(
      `
        INSERT INTO users (stellar_address)
        VALUES ($1)
        RETURNING id, stellar_address, created_at
      `,
      [stellarAddress],
    );

    return mapUserRow(result.rows[0]!);
  }

  async findByStellarAddress(address: string): Promise<UserDto | null> {
    const stellarAddress = assertNonEmpty(address, 'stellarAddress');
    const result = await this.db.query<UserRow>(
      `
        SELECT id, stellar_address, created_at
        FROM users
        WHERE stellar_address = $1
        LIMIT 1
      `,
      [stellarAddress],
    );

    return result.rows[0] ? mapUserRow(result.rows[0]) : null;
  }

  async findById(id: string): Promise<UserDto | null> {
    const userId = assertNonEmpty(id, 'id');
    const result = await this.db.query<UserRow>(
      `
        SELECT id, stellar_address, created_at
        FROM users
        WHERE id = $1
        LIMIT 1
      `,
      [userId],
    );

    return result.rows[0] ? mapUserRow(result.rows[0]) : null;
  }

  async update(id: string, data: UpdateUserInput): Promise<UserDto> {
    const userId = assertNonEmpty(id, 'id');
    const updates: string[] = [];
    const values: unknown[] = [];

    if (data.stellarAddress !== undefined) {
      values.push(assertNonEmpty(data.stellarAddress, 'stellarAddress'));
      updates.push(`stellar_address = $${values.length}`);
    }

    if (updates.length === 0) {
      const existingUser = await this.findById(userId);
      if (!existingUser) {
        throw new NotFoundError(`User "${userId}" was not found.`);
      }

      return existingUser;
    }

    values.push(userId);
    const result = await this.db.query<UserRow>(
      `
        UPDATE users
        SET ${updates.join(', ')}
        WHERE id = $${values.length}
        RETURNING id, stellar_address, created_at
      `,
      values,
    );

    if (!result.rows[0]) {
      throw new NotFoundError(`User "${userId}" was not found.`);
    }

    return mapUserRow(result.rows[0]);
  }

  async list(params: PaginationParams): Promise<FindUsersResult> {
    const [usersResult, totalResult] = await Promise.all([
      this.db.query<UserRow>(
        `
        SELECT id, stellar_address, created_at
        FROM users
        ORDER BY created_at DESC
        LIMIT $2
        OFFSET $1
      `,
        [params.offset, params.limit],
      ),
      this.db.query<CountRow>('SELECT COUNT(*)::text AS count FROM users'),
    ]);

    return {
      users: usersResult.rows.map(mapUserListRow),
      total: Number(totalResult.rows[0]?.count ?? 0),
    };
  }
}

export const defaultUserRepository = new PgUserRepository();

export async function findUsers(params: PaginationParams): Promise<FindUsersResult> {
  return defaultUserRepository.list(params);
}
