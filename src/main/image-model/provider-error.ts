import { readBoundedResponseText } from '@aipoch/providers/transport'
import type { ImageModelErrorCode } from '../../shared/image-model-error'
import { ImageModelError } from './contract'

const codes: Record<string, ImageModelErrorCode> = {
  invalid_api_key: 'AUTHENTICATION_FAILED',
  invalidapikey: 'AUTHENTICATION_FAILED',
  accessdenied: 'ACCESS_DENIED',
  access_denied: 'ACCESS_DENIED',
  insufficient_quota: 'QUOTA_EXCEEDED',
  arrearage: 'QUOTA_EXCEEDED',
  credit_balance_exhausted: 'QUOTA_EXCEEDED',
  organization_spend_limit_exceeded: 'QUOTA_EXCEEDED',
  project_spend_limit_exceeded: 'QUOTA_EXCEEDED',
  organization_usage_limit_exceeded: 'QUOTA_EXCEEDED',
  'throttling.allocationquota': 'QUOTA_EXCEEDED',
  rate_limit_exceeded: 'RATE_LIMITED',
  rate_limit_error: 'RATE_LIMITED',
  slow_down: 'RATE_LIMITED',
  'throttling.ratequota': 'RATE_LIMITED',
  moderation_blocked: 'CONTENT_BLOCKED',
  content_policy_violation: 'CONTENT_BLOCKED',
  datainspectionfailed: 'CONTENT_BLOCKED',
  data_inspection_failed: 'CONTENT_BLOCKED',
  inputimagesensitivecontentdetected: 'CONTENT_BLOCKED',
  outputimagesensitivecontentdetected: 'CONTENT_BLOCKED',
  inputtextsensitivecontentdetected: 'CONTENT_BLOCKED',
  invalidparameter: 'INVALID_REQUEST',
  invalid_request_error: 'INVALID_REQUEST'
}
const lookup = (
  values: Record<string, ImageModelErrorCode>,
  key: string
): ImageModelErrorCode | undefined => (Object.hasOwn(values, key) ? values[key] : undefined)
const minimaxCodes: Record<number, ImageModelErrorCode> = {
  1000: 'OUTCOME_UNKNOWN',
  1001: 'OUTCOME_UNKNOWN',
  1024: 'OUTCOME_UNKNOWN',
  1033: 'OUTCOME_UNKNOWN',
  2066: 'OUTCOME_UNKNOWN',
  1002: 'RATE_LIMITED',
  1045: 'RATE_LIMITED',
  1004: 'AUTHENTICATION_FAILED',
  2049: 'AUTHENTICATION_FAILED',
  1008: 'QUOTA_EXCEEDED',
  2053: 'QUOTA_EXCEEDED',
  1026: 'CONTENT_BLOCKED',
  1027: 'CONTENT_BLOCKED',
  2013: 'INVALID_REQUEST',
  2014: 'INVALID_REQUEST',
  2022: 'INVALID_REQUEST'
}
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

// Use codes, not provider prose: relays may echo secrets or the full prompt in message fields.
export function readImageProviderError(
  value: unknown,
  adapter: string,
  status = 200
): ImageModelError | undefined {
  const body = record(value)
  const base = adapter === 'minimax' ? record(body?.base_resp) : undefined
  const miniCode = typeof base?.status_code === 'number' ? base.status_code : 0
  const item = Array.isArray(body?.data) ? record(body.data[0]) : undefined
  const rawError = body?.error ?? item?.error
  const error = record(rawError)
  const providerCode = error?.code ?? body?.code
  const providerType = error?.type
  const explicitError =
    miniCode !== 0 ||
    rawError != null ||
    (typeof providerCode === 'string' &&
      (!item || Boolean(lookup(codes, providerCode.toLowerCase()))))
  if (status < 400 && !explicitError) return undefined
  let code: ImageModelErrorCode
  if (status >= 500 || status === 408) code = 'OUTCOME_UNKNOWN'
  else
    code =
      (miniCode ? minimaxCodes[miniCode] : undefined) ??
      (typeof providerCode === 'string' ? lookup(codes, providerCode.toLowerCase()) : undefined) ??
      (typeof providerType === 'string' ? lookup(codes, providerType.toLowerCase()) : undefined) ??
      (status === 401
        ? 'AUTHENTICATION_FAILED'
        : status === 403
          ? 'ACCESS_DENIED'
          : status === 402
            ? 'QUOTA_EXCEEDED'
            : status === 429
              ? 'RATE_LIMITED'
              : status === 400 || status === 422
                ? 'INVALID_REQUEST'
                : 'PROVIDER_ERROR')
  return new ImageModelError(
    code,
    code === 'OUTCOME_UNKNOWN'
      ? 'The image provider may have processed the request. Do not retry automatically.'
      : `The image provider rejected the request (${code}). Correct the cause before submitting again.`,
    status
  )
}

export async function readImageHttpError(
  response: Response,
  adapter: string,
  signal: AbortSignal
): Promise<ImageModelError> {
  if (response.status >= 500 || response.status === 408) {
    await response.body?.cancel().catch(() => undefined)
    return readImageProviderError(undefined, adapter, response.status)!
  }
  let body: unknown
  try {
    body = JSON.parse(
      await readBoundedResponseText(
        response,
        16 * 1024,
        'Image error response',
        undefined,
        AbortSignal.any([signal, AbortSignal.timeout(5000)])
      )
    )
  } catch {
    // An unavailable or oversized error body does not erase an explicit HTTP rejection.
    await response.body?.cancel().catch(() => undefined)
  }
  return (
    readImageProviderError(body, adapter, response.status) ??
    new ImageModelError(
      'PROVIDER_ERROR',
      'The image provider rejected the request.',
      response.status
    )
  )
}
