import { z } from 'zod';

export const quotaRequestSchema = z.object({
  requested_tier: z.enum(['free', 'pro', 'enterprise'], {
    message: 'requested_tier must be one of: free, pro, enterprise',
  }),
  reason: z.string().min(10, 'reason must be at least 10 characters').max(1000, 'reason must not exceed 1000 characters'),
  requested_overrides: z
    .object({
      monthly_call_limit: z.number().int().positive().optional(),
      rate_limit_max_requests: z.number().int().positive().optional(),
    })
    .optional(),
});

export type QuotaRequestInput = z.infer<typeof quotaRequestSchema>;
