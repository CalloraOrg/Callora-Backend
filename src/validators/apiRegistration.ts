import { z } from 'zod';
import { httpMethodEnum } from '../db/schema.js';

const pricePerCallUsdcPattern = /^(0|[1-9]\d*)(\.\d+)?$/;

const apiEndpointRegistrationSchema = z.object({
  path: z
    .string()
    .trim()
    .min(1, 'Path is required')
    .refine((value) => value.startsWith('/'), 'Path must start with /'),
  method: z.enum(httpMethodEnum),
  price_per_call_usdc: z
    .string()
    .trim()
    .refine(
      (value) => pricePerCallUsdcPattern.test(value),
      'Price per call must be a non-negative decimal string',
    ),
  description: z.string().trim().min(1).optional(),
});

export const apiRegistrationSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  description: z.string().trim().min(1).optional(),
  base_url: z.url({ protocol: /^https?$/ }),
  category: z.string().trim().min(1, 'Category is required'),
  endpoints: z.array(apiEndpointRegistrationSchema).min(1, 'At least one endpoint is required'),
});

export type ApiRegistrationInput = z.infer<typeof apiRegistrationSchema>;
