import { z } from 'zod'

// Transport and persistence contain classifications only, never upstream response text.
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
      'CANCELLED',
      'TIMED_OUT'
    ]),
    httpStatus: z.number().int().min(100).max(599).optional()
  })
  .strict()
export type ImageErrorDetail = z.infer<typeof imageModelErrorSchema>
export type ImageModelErrorCode = ImageErrorDetail['code']
