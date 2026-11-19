import type { ModelProtocol, ModelReasoningEffort } from '@aipoch/providers'
import { getCustomProviderBaseUrlError } from './provider-url-policy'

// Shared, renderer-safe contract for the optional Lab enterprise provider.
//
// Lab is an app-managed provider: main owns the server address, the OAuth tokens and the model
// catalog projected from /api/me/bootstrap. The renderer only ever receives the status view below
// (never a token or refresh token). Model ids are namespaced as `lab:<public model id>` so they can
// never collide with a personal provider's model id; the wire id is stripped again in main before a
// request reaches the gateway.

export const LAB_PROVIDER_ID = 'builtin-lab'
export const LAB_CLIENT_ID = 'open-science-desktop'
export const LAB_MODEL_ID_PREFIX = 'lab:'
export const LAB_CALLBACK_PATH = '/oauth/callback'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export type LabConnectionState =
  | 'unconfigured'
  | 'signedOut'
  | 'signingIn'
  | 'authenticated'
  | 'expired'
  | 'unreachable'
  | 'blocked'

export type LabErrorCode =
  | 'server-url-missing'
  | 'server-url-invalid'
  | 'server-url-insecure'
  | 'server-url-query'
  | 'server-url-credentials'
  | 'network'
  | 'timeout'
  | 'unauthorized'
  | 'license-inactive'
  | 'seat-required'
  | 'org-inactive'
  | 'account-disabled'
  | 'device-limit'
  | 'rate-limited'
  | 'server-error'
  | 'invalid-response'
  | 'cancelled'
  | 'expired'
  | 'unknown'

export class LabApiError extends Error {
  constructor(
    readonly code: LabErrorCode,
    message: string,
    readonly status?: number,
    readonly reason?: string
  ) {
    super(message)
    this.name = 'LabApiError'
  }
}

export type LabModelSummary = Readonly<{
  id: string
  name: string
  protocols: readonly ModelProtocol[]
  streaming: boolean
}>

export type LabView = Readonly<{
  state: LabConnectionState
  serverUrl?: string
  accountId?: string
  accountName?: string
  orgId?: string
  deviceName?: string
  deviceId?: string
  modelCount?: number
  models?: readonly LabModelSummary[]
  usage?: LabUsage
  error?: Readonly<{ code: LabErrorCode; message?: string }>
  sessionExpiresAt?: number
}>

export type LabUsageQuota = Readonly<{
  limit: number
  used: number
  remaining: number
  unlimited: boolean
}>

export type LabUsageAmount = Readonly<{
  limit: number
  used: number
  remaining: number
}>

export type LabUsageToken = Readonly<{
  available: boolean
  reason?: string
  name?: string
  status?: string
  expiresAt?: string | null
  quota?: LabUsageQuota
}>

export type LabUsageOrg = Readonly<{
  available: boolean
  reason?: string
  unlimited: boolean
  quota?: LabUsageQuota
  stale: boolean
  syncedAt?: string | null
}>

export type LabUsage = Readonly<{
  available: boolean
  reason?: string
  token: LabUsageToken
  org: LabUsageOrg
  effective?: Readonly<{ remaining: number; limitedBy: string }>
  display?: Readonly<{
    perUnit: number
    exchangeRate: number
    currency: string
    cny: Readonly<{ token?: LabUsageAmount; org?: LabUsageAmount }>
    usd: Readonly<{ token?: LabUsageAmount; org?: LabUsageAmount }>
  }>
  fetchedAt?: string | null
  stale: boolean
}>

export type SetLabServerRequest = Readonly<{ serverUrl: string }>

// Test-connection may probe an unsaved draft address without changing the stored deployment.
export type LabCheckRequest = Readonly<{ serverUrl?: string }>

// Cosmetic device identity posted with a login attempt. All fields are optional and the server never
// uses them for authentication or quota decisions.
export type LabDeviceInfo = Record<string, string | boolean>

export type LabSignInChallenge = Readonly<{
  authorizationUrl: string
  expiresAt: number
}>

// Raw per-model capability document from Lab. It is deliberately kept open-ended so a newer
// server can add fields without breaking older clients; consumers narrow it with
// readLabModelCapabilities and never guess from a model name.
export type LabModelCapabilities = Readonly<Record<string, unknown>>

export type LabModelCapabilityProfile = Readonly<{
  reasoningValues?: readonly ModelReasoningEffort[]
  reasoningToggle?: boolean
  inputModalities: readonly string[]
  contextWindow?: number
  maxOutputTokens?: number
}>

const LAB_REASONING_EFFORTS = new Set<string>([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra'
])

const positiveInteger = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return Math.floor(value)
}

// A bootstrap model entry as returned by GET /api/me/bootstrap. Only the fields this client uses
// are typed; unknown fields are ignored.
export type LabBootstrapModel = Readonly<{
  id: string
  name?: string
  protocol?: string
  protocols?: readonly string[]
  streaming?: boolean
  enabled?: boolean
  available?: boolean
  capabilities?: LabModelCapabilities
}>

export type LabBootstrap = Readonly<{
  user: Readonly<{ id: string; display_name?: string; org_id?: string }>
  device: Readonly<{ id: string; name?: string }>
  models: readonly LabBootstrapModel[]
  default_model_id?: string | null
  model_base_url?: string
}>

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

// Server-address policy: reuse the existing provider URL policy (http/https only, no query or
// fragment, no embedded credentials), plus the Lab rule that a non-loopback address must be https.
export const getLabServerUrlError = (value: string): LabErrorCode | undefined => {
  const trimmed = value.trim()
  if (!trimmed) return 'server-url-missing'
  const baseError = getCustomProviderBaseUrlError(trimmed)
  if (baseError !== undefined) {
    if (baseError === 'Remove credentials from the Base URL and use the API key field.')
      return 'server-url-credentials'
    if (baseError === 'Base URL must not include query parameters or fragments.')
      return 'server-url-query'
    if (baseError === 'Base URL must be a valid HTTP or HTTPS URL.') return 'server-url-invalid'
    // PROVIDER_TRANSPORT_ERROR: the shared policy rejects insecure remote URLs.
    return 'server-url-insecure'
  }
  const { protocol, hostname } = new URL(trimmed)
  if (protocol !== 'https:' && !LOOPBACK_HOSTS.has(hostname)) {
    return 'server-url-insecure'
  }
  return undefined
}

export const normalizeLabServerUrl = (value: string): string => value.trim().replace(/\/+$/u, '')

export const labModelIdFromBootstrap = (modelId: string): string =>
  `${LAB_MODEL_ID_PREFIX}${modelId}`

export const labModelWireId = (modelId: string): string =>
  modelId.startsWith(LAB_MODEL_ID_PREFIX) ? modelId.slice(LAB_MODEL_ID_PREFIX.length) : modelId

export const labModelLabel = (modelId: string): string => labModelWireId(modelId)

// Legacy bootstrap catalogs may omit protocol metadata. An explicit declaration must match a
// route the gateway can serve.
export const labProtocolsToEndpoints = (model: LabBootstrapModel): ModelProtocol[] => {
  if (model.protocol === undefined && model.protocols === undefined) return ['chat-completions']
  const declared = [...(model.protocols ?? []), ...(model.protocol ? [model.protocol] : [])]
  const endpoints: ModelProtocol[] = []
  for (const protocol of declared) {
    const normalized = protocol.toLowerCase()
    if (normalized === 'openai' || normalized === 'chat-completions') {
      if (!endpoints.includes('chat-completions')) endpoints.push('chat-completions')
    } else if (normalized === 'openai-response' || normalized === 'responses') {
      if (!endpoints.includes('responses')) endpoints.push('responses')
    }
  }
  return endpoints
}

export const labAvailableModels = (
  models: readonly LabBootstrapModel[]
): Array<LabBootstrapModel & { endpoints: ModelProtocol[] }> =>
  models.flatMap((model) => {
    if (model.enabled === false || model.available === false) return []
    const endpoints = labProtocolsToEndpoints(model)
    return endpoints.length > 0 ? [{ ...model, endpoints }] : []
  })

export const isLabDeploymentUrl = (serverUrl: string, candidate: string): boolean => {
  try {
    const server = new URL(serverUrl)
    const target = new URL(candidate)
    if (server.origin !== target.origin) return false
    const prefix = server.pathname.replace(/\/+$/u, '')
    return prefix === '' || target.pathname === prefix || target.pathname.startsWith(`${prefix}/`)
  } catch {
    return false
  }
}

export const joinLabBaseUrl = (serverUrl: string, modelBaseUrl: string | undefined): string => {
  const server = normalizeLabServerUrl(serverUrl)
  const base = (modelBaseUrl ?? '/v1').trim() || '/v1'
  let resolved: URL
  try {
    if (base.startsWith('//')) throw new Error('protocol-relative')
    // Leading slashes are relative to the deployment root, not the host root, so preserve the
    // configured deployment path when resolving `/v1` under `https://host/deployment`.
    resolved = /^https?:\/\//iu.test(base)
      ? new URL(base)
      : new URL(base.replace(/^\/+/, ''), `${server}/`)
  } catch {
    throw new Error('Lab model_base_url must stay on the configured deployment.')
  }
  if (!isLabDeploymentUrl(server, resolved.toString())) {
    throw new Error('Lab model_base_url must stay on the configured deployment.')
  }
  return resolved.toString().replace(/\/+$/u, '')
}

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const readUsageQuota = (raw: unknown): LabUsageQuota | undefined => {
  if (!isRecord(raw)) return undefined
  const limit = finiteNumber(raw.limit)
  const used = finiteNumber(raw.used)
  const remaining = finiteNumber(raw.remaining)
  if (limit === undefined || used === undefined || remaining === undefined) return undefined
  return { limit, used, remaining, unlimited: raw.unlimited === true }
}

const readUsageAmount = (raw: unknown): LabUsageAmount | undefined => {
  if (!isRecord(raw)) return undefined
  const limit = finiteNumber(raw.limit)
  const used = finiteNumber(raw.used)
  const remaining = finiteNumber(raw.remaining)
  if (limit === undefined || used === undefined || remaining === undefined) return undefined
  return { limit, used, remaining }
}

const readUsageAmounts = (
  raw: unknown
): Readonly<{ token?: LabUsageAmount; org?: LabUsageAmount }> => {
  if (!isRecord(raw)) return {}
  const token = readUsageAmount(raw.token)
  const org = readUsageAmount(raw.org)
  return { ...(token ? { token } : {}), ...(org ? { org } : {}) }
}

// Keeps the optional usage payload render-safe: malformed nested values are omitted rather than
// making the whole Lab connection fail. The server's `available:false` state is preserved.
export const readLabUsage = (raw: unknown): LabUsage | undefined => {
  if (!isRecord(raw)) return undefined
  const tokenRecord = isRecord(raw.token) ? raw.token : {}
  const orgRecord = isRecord(raw.org) ? raw.org : {}
  const tokenQuota = readUsageQuota(tokenRecord.quota)
  const orgQuota = readUsageQuota(orgRecord.quota)
  const token = {
    available: tokenRecord.available === true,
    ...(typeof tokenRecord.reason === 'string' ? { reason: tokenRecord.reason } : {}),
    ...(typeof tokenRecord.name === 'string' ? { name: tokenRecord.name } : {}),
    ...(typeof tokenRecord.status === 'string' ? { status: tokenRecord.status } : {}),
    ...(tokenRecord.expires_at === null || typeof tokenRecord.expires_at === 'string'
      ? { expiresAt: tokenRecord.expires_at }
      : {}),
    ...(tokenQuota ? { quota: tokenQuota } : {})
  }
  const org = {
    available: orgRecord.available === true,
    ...(typeof orgRecord.reason === 'string' ? { reason: orgRecord.reason } : {}),
    unlimited: orgRecord.unlimited === true,
    ...(orgQuota ? { quota: orgQuota } : {}),
    stale: orgRecord.stale === true,
    ...(orgRecord.synced_at === null || typeof orgRecord.synced_at === 'string'
      ? { syncedAt: orgRecord.synced_at }
      : {})
  }
  const effectiveRaw = isRecord(raw.effective) ? raw.effective : undefined
  const effectiveRemaining = finiteNumber(effectiveRaw?.remaining)
  const displayRaw = isRecord(raw.display) ? raw.display : undefined
  const display =
    displayRaw &&
    finiteNumber(displayRaw.per_unit) !== undefined &&
    finiteNumber(displayRaw.exchange_rate) !== undefined &&
    typeof displayRaw.currency === 'string'
      ? {
          perUnit: finiteNumber(displayRaw.per_unit)!,
          exchangeRate: finiteNumber(displayRaw.exchange_rate)!,
          currency: displayRaw.currency,
          cny: readUsageAmounts(displayRaw.cny),
          usd: readUsageAmounts(displayRaw.usd)
        }
      : undefined
  return {
    available: raw.available === true,
    ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}),
    token,
    org,
    ...(effectiveRemaining !== undefined && typeof effectiveRaw?.limited_by === 'string'
      ? { effective: { remaining: effectiveRemaining, limitedBy: effectiveRaw.limited_by } }
      : {}),
    ...(display ? { display } : {}),
    ...(raw.fetched_at === null || typeof raw.fetched_at === 'string'
      ? { fetchedAt: raw.fetched_at }
      : {}),
    stale: raw.stale === true
  }
}

// Narrows a Lab capability document to the values this client actually consumes. Unknown fields
// and unknown effort values are dropped; absence of a capability document must fall back to the
// legacy behavior (no effort control, no image input, runtime default context).
export const readLabModelCapabilities = (raw: unknown): LabModelCapabilityProfile | undefined => {
  if (!isRecord(raw)) return undefined
  // Lab publishes the models.dev/OpenCode shape:
  //   reasoning_options: [{ type: 'effort', values: [...] }, { type: 'toggle' }]
  // Only explicit known fields and effort values are consumed.
  const options = Array.isArray(raw.reasoning_options) ? raw.reasoning_options.filter(isRecord) : []
  const effortOption = options.find(
    (option) => option.type === 'effort' && Array.isArray(option.values)
  )
  const toggleOption = options.some((option) => option.type === 'toggle')
  const rawValues = Array.isArray(effortOption?.values) ? effortOption.values : []
  const reasoningValues = [
    ...new Set(
      rawValues.filter(
        (value): value is ModelReasoningEffort =>
          typeof value === 'string' && LAB_REASONING_EFFORTS.has(value)
      )
    )
  ]
  const modalities =
    isRecord(raw.modalities) && Array.isArray(raw.modalities.input)
      ? raw.modalities.input
          .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
          .map((value) => value.trim().toLowerCase())
      : []
  const limit = isRecord(raw.limit) ? raw.limit : undefined
  const contextWindow = positiveInteger(limit?.context)
  const maxOutputTokens = positiveInteger(limit?.output)
  return {
    ...(reasoningValues.length > 0 ? { reasoningValues: Object.freeze(reasoningValues) } : {}),
    ...(toggleOption ? { reasoningToggle: true } : {}),
    inputModalities: Object.freeze([...new Set(modalities)]),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {})
  }
}

export const labModelSummaries = (
  models: readonly LabBootstrapModel[]
): readonly LabModelSummary[] =>
  Object.freeze(
    labAvailableModels(models).map((model) =>
      Object.freeze({
        id: labModelIdFromBootstrap(model.id),
        name: model.name?.trim() || model.id,
        protocols: Object.freeze(model.endpoints),
        streaming: model.streaming !== false
      })
    )
  )

// Maps a gateway error body to the token-free message forwarded through the provider bridge. Only
// stable gateway codes are echoed; unknown upstream details fall back to the caller's generic text.
export const mapLabGatewayError = (
  status: number,
  parsed: unknown
): Readonly<{ code: string; message: string }> | undefined => {
  const record = isRecord(parsed) ? parsed : undefined
  const errorRecord = record && isRecord(record.error) ? record.error : undefined
  const code = typeof errorRecord?.code === 'string' ? errorRecord.code : undefined
  // Upstream credential failures can arrive as 401/403 from the gateway. Keep the Lab sign-in
  // fallback for a 401 without an upstream-specific code, but don't mislabel a channel credential.
  if (code === 'authentication_error' || code === 'invalid_api_key') {
    return {
      code,
      message: 'The upstream credential is invalid. Check the Lab channel configuration.'
    }
  }
  if (status === 401) {
    return { code: 'unauthorized', message: 'Your Lab sign-in expired. Sign in again.' }
  }
  switch (code) {
    case 'LICENSE_INACTIVE':
      return { code, message: "Your organization's Lab license is inactive." }
    case 'SEAT_REQUIRED':
      return { code, message: 'A Lab seat is required for this account.' }
    case 'ORG_INACTIVE':
      return { code, message: 'Your organization is inactive.' }
    case 'ACCOUNT_DISABLED':
      return { code, message: 'This account is disabled.' }
    case 'MODEL_NOT_ALLOWED':
      return { code, message: 'The Lab server did not allow this model.' }
    case 'MODEL_PROTOCOL_NOT_SUPPORTED':
      return { code, message: 'This Lab model does not support the selected protocol.' }
    case 'MODEL_NOT_AVAILABLE':
    case 'MODEL_NOT_CONFIGURED':
      return { code, message: 'This Lab model is not available right now.' }
    case 'model_not_found':
      return {
        code,
        message:
          'The model has no available upstream channel right now (it may not be published or its channel may be disabled).'
      }
    case 'insufficient_quota':
      return { code, message: 'The upstream subscription or quota is exhausted.' }
    case 'context_length_exceeded':
      return { code, message: 'The context exceeds the model context window.' }
    case 'UPSTREAM_TOKEN_INVALID':
      return {
        code,
        message:
          'This model key is invalid or out of quota. Ask an admin to top it up, then enable it.'
      }
    case 'RATE_LIMITED':
    case 'UPSTREAM_RATE_LIMITED':
      return { code, message: 'Too many Lab requests. Try again in a moment.' }
    case 'UPSTREAM_ERROR':
      return {
        code,
        message: 'The Lab server could not reach the model provider. Check the Lab channel status.'
      }
    default:
      return undefined
  }
}
