import prisma from '../lib/prisma.js';
import type { User } from '../generated/prisma/client.js';
import type { PaginationParams } from '../lib/pagination.js';

export type UserListItem = Pick<User, 'id' | 'stellar_address' | 'created_at'>;

interface FindUsersResult {
  users: UserListItem[];
  total: number;
}

export async function findUsers(params: PaginationParams): Promise<FindUsersResult> {

interface PaginatedUsers {
  users: Pick<User, 'id' | 'stellar_address' | 'created_at'>[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export async function findUsers(page: number, limit: number): Promise<PaginatedUsers> {
  const skip = (page - 1) * limit;

  const [users, total] = await prisma.$transaction([
    prisma.user.findMany({
      select: {
        id: true,
        stellar_address: true,
        created_at: true,
      },
      orderBy: { created_at: 'desc' },
      skip: params.offset,
      take: params.limit,
      skip,
      take: limit,
    }),
    prisma.user.count(),
  ]);

  return { users, total };
  return {
    users,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}
