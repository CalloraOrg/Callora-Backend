import { createRequire } from 'node:module';
import { PrismaPg } from '@prisma/adapter-pg';

type PrismaClientLike = {
  $disconnect: () => Promise<void>;
  [key: string]: unknown;
};

let prisma: PrismaClientLike | undefined;
const nodeRequire: NodeRequire =
  typeof require === 'function'
    ? require
    : createRequire(`${process.cwd()}/package.json`);

type PrismaClientConstructor = new (options?: unknown) => PrismaClientLike;

function getPrismaClient(): PrismaClientLike {
  if (!prisma) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL environment variable is required");
    }
    const adapter = new PrismaPg({ connectionString });
    const { PrismaClient } = nodeRequire('../generated/prisma/client.js') as {
      PrismaClient: PrismaClientConstructor;
    };
    prisma = new PrismaClient({ adapter }) as unknown as PrismaClientLike;
  }
  return prisma;
}

export async function disconnectPrisma(): Promise<void> {
  if (!prisma) {
    return;
  }
  await prisma.$disconnect();
}

export default new Proxy({} as PrismaClientLike, {
  get(_target, prop, receiver) {
    const client = getPrismaClient();
    const value = Reflect.get(client, prop, receiver);
    return typeof value === "function" ? value.bind(client) : value;
  },
});
