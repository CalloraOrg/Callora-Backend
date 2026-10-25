import { z } from 'zod';


export const successEnvelopeSchema = z.object({
  success: z.literal(true),
  data: z.unknown(),
  meta: z.record(z.string(), z.unknown()).optional(),
  requestId: z.string(),
  timestamp: z.string().datetime(),
});

/**
 * Optional, additive member of `error` describing a failed Soroban
 * simulation. Only the redacted summary fields are representable here, so a
 * client can rely on `error.simulationDetails` never containing addresses,
 * balances, XDR or signatures.
 */
export const simulationDetailsSchema = z.object({
  errorCode: z.union([z.string(), z.number()]).optional(),
  errorMessage: z.string().optional(),
  eventCount: z.number().optional(),
  footprintPresent: z.boolean().optional(),
});

export const featureErrorDetailsSchema = z.object({
  feature: z.string().max(200),
});

export const errorDetailsSchema = z.union([z.array(z.object({
  field: z.string(),
  message: z.string(),
  code: z.string(),
})), featureErrorDetailsSchema]);

export type FeatureErrorDetails = z.infer<typeof featureErrorDetailsSchema>;

export const errorEnvelopeSchema = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: errorDetailsSchema.optional(),
    retryAfterMs: z.number().optional(),
    simulationDetails: simulationDetailsSchema.optional(),
  }),
  requestId: z.string(),
  timestamp: z.string().datetime(),
});

export const envelopeSchema = z.union([successEnvelopeSchema, errorEnvelopeSchema]);

export type SuccessEnvelope<T = unknown> = z.infer<typeof successEnvelopeSchema> & { data: T };
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
export type Envelope<T = unknown> = SuccessEnvelope<T> | ErrorEnvelope;

export interface EnvelopeMeta {
  [key: string]: unknown;
}
