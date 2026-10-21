import { createRequire } from 'node:module';
import { PrismaPg } from '@prisma/adapter-pg';
import { ServiceUnavailableError } from '../errors/index.js';

type PrismaClientLike = {
  $disconnect: () => Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
};

let prisma: PrismaClientLike | undefined;
const nodeRequire: NodeRequire =
  typeof require === 'function'
    ? require
    : createRequire(`${process.cwd()}/package.json`);

type PrismaClientConstructor = new (options?: unknown) => PrismaClientLike;

function getPrismaClient(): PrismaClientLike {
  if (process.env.DEMO_MODE === 'true') {
    throw new ServiceUnavailableError('Database service is unavailable in demo mode');
  }

  if (!prisma) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL environment variable is required");
    }
    const adapter = new PrismaPg({ connectionString });
    try {
      const { PrismaClient } = nodeRequire('../generated/prisma/client.js') as {
        PrismaClient: PrismaClientConstructor;
      };
      prisma = new PrismaClient({ adapter }) as unknown as PrismaClientLike;
    } catch (err: unknown) {
      if (
        (err as { code?: string })?.code === 'MODULE_NOT_FOUND' ||
        (err instanceof Error && err.message.includes('Cannot find module'))
      ) {
        throw new ServiceUnavailableError('Database service is unavailable in demo mode');
      }
      throw err;
    }
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
    if (prop === '$disconnect') {
      return disconnectPrisma;
    }
    const client = getPrismaClient();
    const value = Reflect.get(client, prop, receiver);
    return typeof value === "function" ? value.bind(client) : value;
  },
});
