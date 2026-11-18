import { readBoundedResponseText } from '@aipoch/providers/transport'
import {
  imageErrorParameterSchema,
  imageProviderRequestIdSchema,
  type ImageModelErrorCode
} from '../../shared/image-model-error'
import { ImageModelError } from './contract'

const codes: Record<string, ImageModelErrorCode> = {
  invalid_api_key: 'AUTHENTICATION_FAILED',
  invalidapikey: 'AUTHENTICATION_FAILED',
  authenticationerror: 'AUTHENTICATION_FAILED',
  authentication_error: 'AUTHENTICATION_FAILED',
  modelnotopen: 'ACCESS_DENIED',
  modelnotfound: 'ACCESS_DENIED',
  model_not_found: 'ACCESS_DENIED',
  'model.accessdenied': 'ACCESS_DENIED',
  'operationdenied.servicenotopen': 'ACCESS_DENIED',
  'operationdenied.permissiondenied': 'ACCESS_DENIED',
  'invalidendpointormodel.notfound': 'ACCESS_DENIED',
  'invalidendpointormodel.modelidaccessdisabled': 'ACCESS_DENIED',
  accessdenied: 'ACCESS_DENIED',
  access_denied: 'ACCESS_DENIED',
  insufficient_quota: 'QUOTA_EXCEEDED',
  quotaexceeded: 'QUOTA_EXCEEDED',
  accountquotaexceeded: 'QUOTA_EXCEEDED',
  setlimitexceeded: 'QUOTA_EXCEEDED',
  arrearage: 'QUOTA_EXCEEDED',
  credit_balance_exhausted: 'QUOTA_EXCEEDED',
  organization_spend_limit_exceeded: 'QUOTA_EXCEEDED',
  project_spend_limit_exceeded: 'QUOTA_EXCEEDED',
  organization_usage_limit_exceeded: 'QUOTA_EXCEEDED',
  'throttling.allocationquota': 'QUOTA_EXCEEDED',
  rate_limit_exceeded: 'RATE_LIMITED',
  accountratelimitexceeded: 'RATE_LIMITED',
  modelaccountconcurrentrequestslimitexceeded: 'RATE_LIMITED',
  modelaccountipmratelimitexceeded: 'RATE_LIMITED',
  serveroverloaded: 'RATE_LIMITED',
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
  inputimageriskdetection: 'CONTENT_BLOCKED',
  outputimageriskdetection: 'CONTENT_BLOCKED',
  inputtextriskdetection: 'CONTENT_BLOCKED',
  invalidparameter: 'INVALID_REQUEST',
  'invalidparameter.unsupportedparameter': 'INVALID_REQUEST',
  missingparameter: 'INVALID_REQUEST',
  invalid_request_error: 'INVALID_REQUEST',
  server_is_overloaded: 'OUTCOME_UNKNOWN',
  internalerror: 'OUTCOME_UNKNOWN',
  serviceunavailable: 'OUTCOME_UNKNOWN',
  internalserviceerror: 'OUTCOME_UNKNOWN',
  modelloading: 'OUTCOME_UNKNOWN',
  serviceconnectionrefused: 'OUTCOME_UNKNOWN',
  noavailableservice: 'OUTCOME_UNKNOWN',
  requestcanceled: 'OUTCOME_UNKNOWN'
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
const httpCodes: Partial<Record<number, ImageModelErrorCode>> = {
  400: 'INVALID_REQUEST',
  401: 'AUTHENTICATION_FAILED',
  402: 'QUOTA_EXCEEDED',
  403: 'ACCESS_DENIED',
  404: 'ACCESS_DENIED',
  413: 'INVALID_REQUEST',
  415: 'INVALID_REQUEST',
  422: 'INVALID_REQUEST',
  429: 'RATE_LIMITED'
}
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

// Use codes, not provider prose: relays may echo secrets or the full prompt in message fields.
export function readImageProviderError(
  value: unknown,
  adapter: string,
  status = 200,
  headers?: Headers
): ImageModelError | undefined {
  const body = record(value)
  const base = adapter === 'minimax' ? record(body?.base_resp) : undefined
  const item = Array.isArray(body?.data) ? record(body.data[0]) : undefined
  const error = record(body?.error)
  const itemError = record(item?.error)
  const knownCode = [error?.code, itemError?.code, body?.code, error?.type, itemError?.type].find(
    (value): value is string =>
      typeof value === 'string' && Boolean(lookup(codes, value.toLowerCase()))
  )
  // MiniMax H3 reports per-image codes separately from the aggregate error.
  // The top-level message may end in a documented numeric code. Keep only allowlisted codes.
  const miniCode =
    adapter === 'minimax'
      ? [
          base?.status_code,
          itemError?.code,
          error?.code,
          typeof error?.message === 'string'
            ? /\((\d{4})\)\s*$/.exec(error.message)?.[1]
            : undefined
        ].find(
          (code): code is string | number =>
            (typeof code === 'string' || typeof code === 'number') &&
            Object.hasOwn(minimaxCodes, code)
        )
      : undefined
  const requestId = [
    headers?.get('x-request-id'),
    headers?.get('x-tt-logid'),
    body?.request_id,
    body?.requestId,
    error?.request_id
  ].find((value): value is string => imageProviderRequestIdSchema.safeParse(value).success)
  const parameter = imageErrorParameterSchema.safeParse(error?.param ?? body?.param).data
  const upstreamCode = miniCode ? String(miniCode) : knownCode
  const explicitError =
    (typeof base?.status_code === 'number' && base.status_code !== 0) ||
    body?.error != null ||
    item?.error != null ||
    (typeof body?.code === 'string' && (!item || Boolean(lookup(codes, body.code.toLowerCase()))))
  if (status < 400 && !explicitError) return undefined
  const codeKey = knownCode?.toLowerCase()
  const upstreamCategory = codeKey ? lookup(codes, codeKey) : undefined
  const httpCategory =
    adapter === 'minimax' && status === 422 && (error || itemError)
      ? 'CONTENT_BLOCKED'
      : httpCodes[status]
  const code =
    status >= 500 || status === 408 || status === 499
      ? 'OUTCOME_UNKNOWN'
      : ((miniCode ? minimaxCodes[Number(miniCode)] : undefined) ??
        (codeKey !== 'invalid_request_error' ? upstreamCategory : undefined) ??
        httpCategory ??
        upstreamCategory ??
        'PROVIDER_ERROR')
  return new ImageModelError(
    code,
    code === 'OUTCOME_UNKNOWN'
      ? 'The image provider may have processed the request. Do not retry automatically.'
      : `The image provider rejected the request (${code}). Correct the cause before submitting again.`,
    status >= 400 ? status : undefined,
    {
      ...(upstreamCode ? { providerCode: upstreamCode } : {}),
      ...(requestId ? { requestId } : {}),
      ...(parameter ? { parameter } : {})
    }
  )
}

export async function readImageHttpError(
  response: Response,
  adapter: string,
  signal: AbortSignal
): Promise<ImageModelError> {
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
    // An unavailable or oversized error body does not erase the HTTP status.
    await response.body?.cancel().catch(() => undefined)
  }
  return (
    readImageProviderError(body, adapter, response.status, response.headers) ??
    new ImageModelError(
      'PROVIDER_ERROR',
      'The image provider rejected the request.',
      response.status
    )
  )
}
