import { z } from 'zod';

export const networkSchema = z.enum(['testnet', 'mainnet']);

export const stellarNetworkQuerySchema = z.object({
  network: networkSchema.optional(),
});

export function parseNetworkWithDefault(input: unknown): 'testnet' | 'mainnet' {
  const parsed = stellarNetworkQuerySchema.parse(input);
  return parsed.network ?? 'testnet';
}
