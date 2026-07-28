import { z } from 'zod';

const slugPattern = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/;
const tenantIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/;

const trimmedString = (fieldName: string, maxLength: number) =>
  z
    .string({
      error: (issue) =>
        issue.input === undefined ? `${fieldName} is required` : `${fieldName} must be a string`,
    })
    .trim()
    .min(1, `${fieldName} is required`)
    .max(maxLength, `${fieldName} must be ${maxLength} characters or fewer`);

export const tenantIdSchema = z
  .string({
    error: (issue) =>
      issue.input === undefined ? 'tenantId is required' : 'tenantId must be a string',
  })
  .trim()
  .regex(tenantIdPattern, 'tenantId must be 3-64 characters using letters, numbers, underscores, or hyphens');

export const tenantSlugSchema = z
  .string({
    error: () => 'slug must be a string',
  })
  .trim()
  .toLowerCase()
  .regex(slugPattern, 'slug must be 3-63 lowercase letters, numbers, or hyphens without edge hyphens');

const tenantMetadataValueSchema = z.union([
  z.string().max(256, 'metadata values must be 256 characters or fewer'),
  z.number().finite('metadata numbers must be finite'),
  z.boolean(),
]);

export const tenantMetadataSchema = z
  .record(z.string().min(1).max(64), tenantMetadataValueSchema)
  .refine((metadata) => Object.keys(metadata).length <= 20, {
    message: 'metadata can contain at most 20 keys',
  });

export const createTenantSchema = z
  .object({
    name: trimmedString('name', 120),
    slug: tenantSlugSchema.optional(),
    contactEmail: z.string().trim().email('contactEmail must be a valid email address').max(254).optional(),
    plan: z.enum(['starter', 'growth', 'enterprise']).default('starter'),
    metadata: tenantMetadataSchema.optional(),
  })
  .strict();

export const updateTenantSchema = z
  .object({
    name: trimmedString('name', 120).optional(),
    contactEmail: z.string().trim().email('contactEmail must be a valid email address').max(254).optional(),
    plan: z.enum(['starter', 'growth', 'enterprise']).optional(),
    metadata: tenantMetadataSchema.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: 'At least one tenant field must be provided',
  });

export const tenantParamsSchema = z.object({
  tenantId: tenantIdSchema,
});

export type CreateTenantInput = z.infer<typeof createTenantSchema>;
export type UpdateTenantInput = z.infer<typeof updateTenantSchema>;
export type TenantParamsInput = z.infer<typeof tenantParamsSchema>;
