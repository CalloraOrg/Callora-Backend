export type User = {
  id: string;
  stellar_address: string;
  created_at: Date;
};

type UserRecord = User;

export class PrismaClient {
  readonly user = {
    findMany: async (): Promise<UserRecord[]> => [],
    count: async (): Promise<number> => 0,
  };

  constructor(_options?: unknown) { }

  async $transaction<T extends readonly unknown[]>(operations: T): Promise<{ [K in keyof T]: Awaited<T[K]> }> {
    return Promise.all(operations) as Promise<{ [K in keyof T]: Awaited<T[K]> }>;
  }
}