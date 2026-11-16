import type { ModelProtocol } from '@aipoch/providers'
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

export type LabModelSummary = Readonly<{
  id: string
  name: string
  protocols: readonly ModelProtocol[]
  streaming: boolean
}>

export type LabView = Readonly<{
  state: LabConnectionState
  serverUrl?: string
  accountName?: string
  orgId?: string
  deviceName?: string
  deviceId?: string
  modelCount?: number
  models?: readonly LabModelSummary[]
  error?: Readonly<{ code: LabErrorCode; message?: string }>
  sessionExpiresAt?: number
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
}>

export type LabBootstrap = Readonly<{
  user: Readonly<{ id: string; display_name?: string; org_id?: string }>
  device: Readonly<{ id: string; name?: string }>
  models: readonly LabBootstrapModel[]
  default_model_id?: string | null
  model_base_url?: string
}>

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

export const isLoopbackLabServerUrl = (value: string): boolean => {
  try {
    return LOOPBACK_HOSTS.has(new URL(value).hostname.toLowerCase())
  } catch {
    return false
  }
}

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
  if (!isLoopbackLabServerUrl(trimmed) && !trimmed.startsWith('https://')) {
    return 'server-url-insecure'
  }
  return undefined
}

export const normalizeLabServerUrl = (value: string): string => value.trim().replace(/\/+$/u, '')

export const labModelId = (modelId: string): string =>
  modelId.startsWith(LAB_MODEL_ID_PREFIX) ? modelId : `${LAB_MODEL_ID_PREFIX}${modelId}`

export const labModelWireId = (modelId: string): string =>
  modelId.startsWith(LAB_MODEL_ID_PREFIX) ? modelId.slice(LAB_MODEL_ID_PREFIX.length) : modelId

export const labModelLabel = (modelId: string): string => labModelWireId(modelId)

export const labModelIdFromBootstrap = (modelId: string): string => labModelId(modelId)

// The gateway serves only POST /v1/chat/completions and POST /v1/responses. Bootstrap advertises
// either protocol ids; anything unknown is ignored rather than guessed.
export const labProtocolsToEndpoints = (model: LabBootstrapModel): ModelProtocol[] => {
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

export const labProviderApiEndpoints = (models: readonly LabBootstrapModel[]): ModelProtocol[] => {
  const endpoints: ModelProtocol[] = []
  for (const model of models) {
    for (const endpoint of labProtocolsToEndpoints(model)) {
      if (!endpoints.includes(endpoint)) endpoints.push(endpoint)
    }
  }
  // No protocol metadata at all is treated as the broadly compatible chat route.
  return endpoints.length > 0 ? endpoints : ['chat-completions']
}

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

export const labModelSummaries = (
  models: readonly LabBootstrapModel[]
): readonly LabModelSummary[] =>
  Object.freeze(
    models
      .filter((model) => model.enabled !== false && model.available !== false)
      .map((model) =>
        Object.freeze({
          id: labModelId(model.id),
          name: model.name?.trim() || model.id,
          protocols: Object.freeze(labProtocolsToEndpoints(model)),
          streaming: model.streaming !== false
        })
      )
  )

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// Maps a gateway error body to the token-free message forwarded through the provider bridge. Only
// stable gateway codes are echoed; unknown upstream details fall back to the caller's generic text.
export const mapLabGatewayError = (
  status: number,
  parsed: unknown
): Readonly<{ code: string; message: string }> | undefined => {
  const record = isRecord(parsed) ? parsed : undefined
  const errorRecord = record && isRecord(record.error) ? record.error : undefined
  const code = typeof errorRecord?.code === 'string' ? errorRecord.code : undefined
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
    case 'RATE_LIMITED':
    case 'UPSTREAM_RATE_LIMITED':
      return { code, message: 'Too many Lab requests. Try again in a moment.' }
    default:
      return undefined
  }
}
