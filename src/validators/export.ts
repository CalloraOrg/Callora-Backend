import { z } from 'zod';

export const exportsQuerySchema = z.object({
  limit: z
    .string()
    .regex(/^\d+$/, 'limit must be an integer')
    .optional()
    .transform((val) => (val !== undefined ? Number(val) : 20))
    .pipe(z.number().int())
    .transform((val) => Math.min(Math.max(val, 1), 100)),
  offset: z
    .string()
    .regex(/^\d+$/, 'offset must be a non-negative integer')
    .optional()
    .transform((val) => (val !== undefined ? Number(val) : 0))
    .pipe(z.number().int().min(0)),
  cursor: z.string().trim().min(1).max(2048).optional(),
  developerId: z.string().trim().min(1).max(255).optional(),
  format: z.enum(['csv', 'json']).optional(),
});

export type ExportsQueryInput = z.infer<typeof exportsQuerySchema>;