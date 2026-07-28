import {
  createTenantSchema,
  tenantParamsSchema,
  updateTenantSchema,
} from './tenants.js';

describe('tenant validators', () => {
  it('normalizes valid create tenant input and applies default plan', () => {
    const parsed = createTenantSchema.parse({
      name: '  GrantFox Ops  ',
      slug: 'GrantFox-Ops',
      contactEmail: 'ops@grantfox.test',
      metadata: { campaign: 'fwc26', priority: 1, active: true },
    });

    expect(parsed).toEqual({
      name: 'GrantFox Ops',
      slug: 'grantfox-ops',
      contactEmail: 'ops@grantfox.test',
      plan: 'starter',
      metadata: { campaign: 'fwc26', priority: 1, active: true },
    });
  });

  it('rejects unknown create fields', () => {
    const result = createTenantSchema.safeParse({
      name: 'GrantFox Ops',
      unsafeRole: 'admin',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.code).toBe('unrecognized_keys');
    }
  });

  it('rejects invalid contact email', () => {
    const result = createTenantSchema.safeParse({
      name: 'GrantFox Ops',
      contactEmail: 'not-email',
    });

    expect(result.success).toBe(false);
  });

  it('rejects metadata with too many keys', () => {
    const metadata = Object.fromEntries(
      Array.from({ length: 21 }, (_, index) => [`k${index}`, `v${index}`]),
    );

    const result = createTenantSchema.safeParse({
      name: 'GrantFox Ops',
      metadata,
    });

    expect(result.success).toBe(false);
  });

  it('requires at least one update field', () => {
    const result = updateTenantSchema.safeParse({});

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe('At least one tenant field must be provided');
    }
  });

  it('accepts bounded tenant route params', () => {
    expect(tenantParamsSchema.parse({ tenantId: 'tenant_123' })).toEqual({ tenantId: 'tenant_123' });
    expect(tenantParamsSchema.safeParse({ tenantId: 'no' }).success).toBe(false);
  });
});
