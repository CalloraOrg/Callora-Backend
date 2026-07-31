import { z } from 'zod';

/**
 * Strict integer-string validator for query-param coercions.
 * Rejects non-digit characters so `limit=abc` fails with a clear message.
 */
const strictIntegerString = (field: string) =>
  z
    .string()
    .trim()
    .regex(/^\d+$/, `${field} must be an integer`);

export const exportsQuerySchema = z.object({
  limit: strictIntegerString('limit')
    .optional()
    .transform((val) => (val === undefined ? 20 : Number.parseInt(val, 10)))
    .pipe(z.number().int().min(1).max(100)),
  offset: strictIntegerString('offset')
    .optional()
    .transform((val) => (val === undefined ? 0 : Number.parseInt(val, 10)))
    .pipe(z.number().int().min(0)),
  cursor: z.string().trim().min(1).max(2048).optional(),
  developerId: z.string().trim().min(1).max(255).optional(),
  format: z.enum(['csv', 'json']).optional(),
});

export type ExportsQueryInput = z.infer<typeof exportsQuerySchema>;
