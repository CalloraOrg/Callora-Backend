import { z } from 'zod';

export const webhookManagementEvents = [
  'new_api_call',
  'settlement_completed',
  'low_balance_alert',
  'usage_event.created',
] as const;

export const webhookDeliveryEvents = [
  ...webhookManagementEvents,
  'quota.threshold.reached',
  'invoice_created',
  'usage.anomaly.detected',
  'fee_abstraction.executed',
] as const;

const developerIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;

export const webhookDeveloperIdSchema = z
  .string({
    required_error: 'developerId is required',
    invalid_type_error: 'developerId must be a string',
  })
  .trim()
  .regex(
    developerIdPattern,
    'developerId must be 3-128 characters using letters, numbers, underscores, or hyphens',
  );

export const webhookDeveloperParamsSchema = z.object({
  developerId: webhookDeveloperIdSchema,
});

export const webhookRetryPolicySchema = z
  .object({
    maxRetries: z
      .number({ invalid_type_error: 'maxRetries must be a number' })
      .int('maxRetries must be an integer between 0 and 10')
      .min(0, 'maxRetries must be an integer between 0 and 10')
      .max(10, 'maxRetries must be an integer between 0 and 10')
      .optional(),
    baseDelayMs: z
      .number({ invalid_type_error: 'baseDelayMs must be a number' })
      .int('baseDelayMs must be an integer between 100 and 60000')
      .min(100, 'baseDelayMs must be an integer between 100 and 60000')
      .max(60_000, 'baseDelayMs must be an integer between 100 and 60000')
      .optional(),
  })
  .strict()
  .refine((policy) => Object.keys(policy).length > 0, {
    message: 'retryPolicy must include maxRetries or baseDelayMs when provided',
  });

export const registerWebhookSchema = z
  .object({
    developerId: webhookDeveloperIdSchema,
    url: z
      .string({
        required_error: 'url is required',
        invalid_type_error: 'url must be a string',
      })
      .trim()
      .url('url must be a valid absolute URL')
      .max(2_048, 'url must be 2048 characters or fewer'),
    events: z
      .array(z.enum(webhookManagementEvents), {
        required_error: 'events is required',
        invalid_type_error: 'events must be an array',
      })
      .min(1, 'events must include at least one event')
      .max(webhookManagementEvents.length, `events can include at most ${webhookManagementEvents.length} items`)
      .refine((events) => new Set(events).size === events.length, {
        message: 'events must not contain duplicates',
      }),
    secret: z
      .string({ invalid_type_error: 'secret must be a string' })
      .trim()
      .min(8, 'secret must be at least 8 characters')
      .max(256, 'secret must be 256 characters or fewer')
      .optional(),
    retryPolicy: webhookRetryPolicySchema.optional(),
  })
  .strict();

export const updateWebhookRetryPolicySchema = z
  .object({
    retryPolicy: webhookRetryPolicySchema.optional(),
  })
  .strict();

export const webhookDeliveryPayloadSchema = z
  .object({
    event: z.enum(webhookDeliveryEvents),
    timestamp: z.string().datetime('timestamp must be an ISO-8601 datetime'),
    developerId: webhookDeveloperIdSchema,
    data: z.record(z.string(), z.unknown()),
  })
  .strict();

export type RegisterWebhookInput = z.infer<typeof registerWebhookSchema>;
export type UpdateWebhookRetryPolicyInput = z.infer<typeof updateWebhookRetryPolicySchema>;
export type WebhookDeveloperParamsInput = z.infer<typeof webhookDeveloperParamsSchema>;
export type WebhookDeliveryPayloadInput = z.infer<typeof webhookDeliveryPayloadSchema>;
