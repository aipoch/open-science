import { z } from 'zod'

// Transport and persistence contain structured diagnostics, never upstream response prose.
export const imageErrorParameterSchema = z.enum([
  'prompt',
  'model',
  'size',
  'area',
  'aspect_ratio',
  'quality',
  'complexity',
  'background',
  'output_format',
  'output_compression',
  'seed',
  'negative_prompt',
  'prompt_extend',
  'prompt_extend_mode',
  'enable_thinking',
  'watermark',
  'min_generation_area',
  'disable_prompt_enhanced',
  'image',
  'images',
  'markup'
])
export const imageProviderRequestIdSchema = z
  .string()
  .regex(/^(?:(?:req_)?[a-f0-9]{24,64}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i)
export const imageModelErrorSchema = z
  .object({
    code: z.enum([
      'NOT_CONFIGURED',
      'UNSUPPORTED_OPTION',
      'PROVIDER_ERROR',
      'OUTCOME_UNKNOWN',
      'AUTHENTICATION_FAILED',
      'ACCESS_DENIED',
      'QUOTA_EXCEEDED',
      'RATE_LIMITED',
      'CONTENT_BLOCKED',
      'INVALID_REQUEST',
      'SOURCE_UNAVAILABLE',
      'SOURCE_LIMIT_EXCEEDED',
      'STORAGE_FULL',
      'EDIT_CONTEXT_CHANGED',
      'CANCELLED',
      'TIMED_OUT'
    ]),
    httpStatus: z.number().int().min(100).max(599).optional(),
    providerCode: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/)
      .optional(),
    requestId: imageProviderRequestIdSchema.optional(),
    parameter: imageErrorParameterSchema.optional()
  })
  .strict()
export type ImageErrorDetail = z.infer<typeof imageModelErrorSchema>
export type ImageModelErrorCode = ImageErrorDetail['code']
