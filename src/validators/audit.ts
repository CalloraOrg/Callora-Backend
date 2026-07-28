import { z } from 'zod';

const coerceInt = (val: string | undefined): number => {
  if (val === undefined) return 20;
  const num = Number(val);
  if (Number.isNaN(num) || !Number.isInteger(num)) {
    return NaN;
  }
  return num;
};

export const auditQuerySchema = z.object({
  limit: z
    .string()
    .optional()
    .default('20')
    .transform(coerceInt)
    .refine((val) => !Number.isNaN(val), { message: 'Limit must be an integer' })
    .refine((val) => val >= 1 && val <= 100, { message: 'Limit must be between 1 and 100' }),
  cursor: z.string().optional(),
  event: z.string().optional().transform((val) => val?.trim() || undefined),
  tenant_id: z.string().optional().transform((val) => val?.trim() || undefined),
  actor: z.string().optional().transform((val) => val?.trim() || undefined),
  from: z
    .string()
    .optional()
    .refine((val) => val === undefined || val.trim() === '' || !Number.isNaN(new Date(val).getTime()), {
      message: 'Invalid "from" date',
    })
    .transform((val) => {
      if (val === undefined || val.trim() === '') return undefined;
      return new Date(val);
    }),
  to: z
    .string()
    .optional()
    .refine((val) => val === undefined || val.trim() === '' || !Number.isNaN(new Date(val).getTime()), {
      message: 'Invalid "to" date',
    })
    .transform((val) => {
      if (val === undefined || val.trim() === '') return undefined;
      return new Date(val);
    }),
}).refine((data) => {
  if (data.from && data.to && data.from.getTime() > data.to.getTime()) {
    return false;
  }
  return true;
}, {
  message: '"from" must be before or equal to "to"',
  path: ['from'],
});

export type AuditQueryInput = z.infer<typeof auditQuerySchema>;
