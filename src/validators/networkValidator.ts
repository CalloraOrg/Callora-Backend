import { z } from 'zod';

export const networkSchema = z.enum(['testnet', 'mainnet'], {
  error: 'network must be either "testnet" or "mainnet"',
});

export const optionalNetworkQuerySchema = z.object({
  network: networkSchema.optional(),
});

export type StellarNetwork = z.infer<typeof networkSchema>;
