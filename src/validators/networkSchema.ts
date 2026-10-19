import { z } from 'zod';
import { config } from '../config/index.js';

export const networkSchema = z.enum(['testnet', 'mainnet']);

export const stellarNetworkQuerySchema = z.object({
  network: networkSchema.optional(),
});

export function parseNetworkWithDefault(
  input: unknown,
  defaultNetwork: 'testnet' | 'mainnet' = config.stellar.network,
): 'testnet' | 'mainnet' {
  const parsed = stellarNetworkQuerySchema.parse(input);
  return parsed.network ?? defaultNetwork;
}
