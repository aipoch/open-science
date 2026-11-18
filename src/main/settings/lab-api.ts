import { fetchProviderRequest, readBoundedResponseText } from '@aipoch/providers/transport'

import type {
  LabBootstrap,
  LabBootstrapModel,
  LabDeviceInfo,
  LabErrorCode,
  LabUsage
} from '../../shared/lab'
import { LAB_CLIENT_ID, readLabUsage } from '../../shared/lab'
import {
  ORG_CASE_DEFAULT_PAGE_SIZE,
  ORG_CASE_MAX_PAGE_SIZE,
  ORG_CASE_MAX_QUERY_LENGTH,
  isValidOrgCaseId,
  normalizeOrgCaseSearchQuery,
  parseOrgCaseDetailResponse,
  parseOrgCaseDownloadTicket,
  parseOrgCasesPage,
  type OrgCaseDetail,
  type OrgCaseDownloadTicket,
  type OrgCasesPage
} from '../../shared/org-cases'
import { netFetchStandard } from '../network-fetch'
import { LAB_RESOURCE_LIMITS } from './lab-resource-limits'

// Small, bounded HTTP client for the Lab API. It never retries: a retried registration or token
// exchange would be wrong (one-time codes) and a retried refresh can revoke the whole client session.
// Every method has a deadline and a response-size cap, and no token is ever written to a log.

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

type FetchLike = typeof globalThis.fetch

type LabApiOptions = {
  fetch?: FetchLike
  now?: () => number
}

export type LabTokenResponse = Readonly<{
  accessToken: string
  refreshToken: string
  expiresIn: number
  tokenExpiresAt: number
  sessionExpiresAt?: string
}>

export type RegisterLoginAttemptInput = Readonly<{
  serverUrl: string
  redirectUri: string
  state: string
  codeChallenge: string
  installationId: string
  deviceName?: string
  deviceInfo?: LabDeviceInfo
  signal?: AbortSignal
}>

export type ExchangeCodeInput = Readonly<{
  serverUrl: string
  code: string
  redirectUri: string
  codeVerifier: string
}>

const withDeadline = async <T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
  parent?: AbortSignal
): Promise<T> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(timeoutMessage)), timeoutMs)
  timer.unref?.()
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal
  try {
    return await work(signal)
  } catch (error) {
    if (parent?.aborted) throw new LabApiError('cancelled', 'The Lab request was cancelled.')
    if (controller.signal.aborted) throw new LabApiError('timeout', timeoutMessage)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const errorCodeFrom = (status: number, body: unknown): { code: LabErrorCode; reason?: string } => {
  const record = isRecord(body) ? body : {}
  const errorValue = record.error
  const errorRecord = isRecord(errorValue) ? errorValue : undefined
  const oauthError = typeof errorValue === 'string' ? errorValue : undefined
  const rawReason =
    typeof record.reason === 'string'
      ? record.reason
      : typeof errorRecord?.code === 'string'
        ? errorRecord.code
        : typeof record.code === 'string'
          ? record.code
          : undefined
  const description =
    typeof record.error_description === 'string'
      ? record.error_description
      : typeof errorRecord?.message === 'string'
        ? errorRecord.message
        : undefined
  const reason = rawReason?.toUpperCase()

  if (reason === 'LICENSE_INACTIVE') return { code: 'license-inactive', reason }
  if (reason === 'SEAT_REQUIRED') return { code: 'seat-required', reason }
  if (reason === 'ORG_INACTIVE') return { code: 'org-inactive', reason }
  if (reason === 'ACCOUNT_DISABLED') return { code: 'account-disabled', reason }
  if (oauthError === 'invalid_grant' || oauthError === 'invalid_client') {
    return { code: 'unauthorized', reason }
  }
  const deviceLimitText = `${oauthError ?? ''} ${description ?? ''}`.toLowerCase()
  if (deviceLimitText.includes('device limit')) return { code: 'device-limit', reason }
  if (status === 401) return { code: 'unauthorized', reason }
  if (status === 429) return { code: 'rate-limited', reason }
  if (status >= 500) return { code: 'server-error', reason }
  return { code: 'server-error', reason }
}

export class LabApi {
  private readonly fetch: FetchLike
  private readonly now: () => number

  constructor(options: LabApiOptions = {}) {
    const baseFetch = options.fetch ?? (netFetchStandard as unknown as FetchLike)
    // Never send Chromium cookies or let Electron net.fetch silently follow 3xx redirects with Bearer auth.
    this.fetch = (input, init) =>
      baseFetch(input, {
        ...init,
        credentials: 'omit',
        redirect: 'error'
      })
    this.now = options.now ?? Date.now
  }

  async registerLoginAttempt(input: RegisterLoginAttemptInput): Promise<{
    requestId: string
    authorizationUrl: string
    expiresAt: number
  }> {
    const body = await this.request(
      `${input.serverUrl}/api/auth/login-attempts`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: LAB_CLIENT_ID,
          redirect_uri: input.redirectUri,
          state: input.state,
          code_challenge: input.codeChallenge,
          code_challenge_method: 'S256',
          installation_id: input.installationId,
          ...(input.deviceName ? { device_name: input.deviceName } : {}),
          ...(input.deviceInfo ? { device_info: input.deviceInfo } : {})
        })
      },
      LAB_RESOURCE_LIMITS.loginAttemptTimeoutMs,
      { signal: input.signal }
    )
    if (
      typeof body.request_id !== 'string' ||
      typeof body.authorization_url !== 'string' ||
      typeof body.expires_at !== 'string' ||
      Number.isNaN(Date.parse(body.expires_at))
    ) {
      throw new LabApiError('invalid-response', 'Lab returned an invalid sign-in challenge.')
    }
    return {
      requestId: body.request_id,
      authorizationUrl: body.authorization_url,
      expiresAt: Date.parse(body.expires_at)
    }
  }

  async exchangeCode(input: ExchangeCodeInput): Promise<LabTokenResponse> {
    const body = await this.request(
      `${input.serverUrl}/oauth/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: LAB_CLIENT_ID,
          code: input.code,
          redirect_uri: input.redirectUri,
          code_verifier: input.codeVerifier
        }).toString()
      },
      LAB_RESOURCE_LIMITS.tokenTimeoutMs
    )
    return this.readTokenResponse(body)
  }

  async refreshToken(serverUrl: string, refreshToken: string): Promise<LabTokenResponse> {
    const body = await this.request(
      `${serverUrl}/oauth/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: LAB_CLIENT_ID,
          refresh_token: refreshToken
        }).toString()
      },
      LAB_RESOURCE_LIMITS.tokenTimeoutMs
    )
    return this.readTokenResponse(body)
  }

  // Public reachability probe used by "Test connection" before sign-in. It does not authenticate and
  // returns no user or model data.
  async clientBootstrap(serverUrl: string): Promise<void> {
    const body = await this.request(
      `${serverUrl}/api/client/bootstrap`,
      { method: 'GET' },
      LAB_RESOURCE_LIMITS.bootstrapTimeoutMs
    )
    if (body.service !== 'open-science-lab' || typeof body.protocol_version !== 'string') {
      throw new LabApiError(
        'invalid-response',
        'The address did not return an Open-Science Lab service identity.'
      )
    }
  }

  async usage(serverUrl: string, accessToken: string): Promise<LabUsage> {
    const body = await this.request(
      `${serverUrl}/api/me/usage`,
      { method: 'GET', headers: { authorization: `Bearer ${accessToken}` } },
      LAB_RESOURCE_LIMITS.usageTimeoutMs
    )
    const usage = readLabUsage(body)
    if (!usage) throw new LabApiError('invalid-response', 'Lab returned invalid usage data.')
    return usage
  }

  async logout(serverUrl: string, accessToken: string): Promise<void> {
    await this.request(
      `${serverUrl}/api/me/logout`,
      { method: 'POST', headers: { authorization: `Bearer ${accessToken}` } },
      LAB_RESOURCE_LIMITS.logoutTimeoutMs,
      { allowEmpty: true }
    )
  }

  async bootstrap(serverUrl: string, accessToken: string): Promise<LabBootstrap> {
    const body = await this.request(
      `${serverUrl}/api/me/bootstrap`,
      { method: 'GET', headers: { authorization: `Bearer ${accessToken}` } },
      LAB_RESOURCE_LIMITS.bootstrapTimeoutMs
    )
    const user = isRecord(body.user) ? body.user : undefined
    const device = isRecord(body.device) ? body.device : undefined
    if (typeof user?.id !== 'string' || typeof device?.id !== 'string') {
      throw new LabApiError('invalid-response', 'Lab returned an invalid bootstrap response.')
    }
    const models: LabBootstrapModel[] = Array.isArray(body.models)
      ? body.models.flatMap((candidate): LabBootstrapModel[] => {
          if (!isRecord(candidate) || typeof candidate.id !== 'string') return []
          return [
            {
              id: candidate.id,
              ...(typeof candidate.name === 'string' ? { name: candidate.name } : {}),
              ...(typeof candidate.protocol === 'string' ? { protocol: candidate.protocol } : {}),
              ...(Array.isArray(candidate.protocols)
                ? {
                    protocols: candidate.protocols.filter(
                      (protocol): protocol is string => typeof protocol === 'string'
                    )
                  }
                : {}),
              ...(typeof candidate.streaming === 'boolean'
                ? { streaming: candidate.streaming }
                : {}),
              ...(typeof candidate.enabled === 'boolean' ? { enabled: candidate.enabled } : {}),
              ...(typeof candidate.available === 'boolean'
                ? { available: candidate.available }
                : {}),
              ...(isRecord(candidate.capabilities) ? { capabilities: candidate.capabilities } : {})
            }
          ]
        })
      : []
    return {
      user: {
        id: user.id,
        ...(typeof user.display_name === 'string' ? { display_name: user.display_name } : {}),
        ...(typeof user.org_id === 'string' ? { org_id: user.org_id } : {})
      },
      device: {
        id: device.id,
        ...(typeof device.name === 'string' ? { name: device.name } : {})
      },
      models,
      ...(typeof body.default_model_id === 'string' || body.default_model_id === null
        ? { default_model_id: body.default_model_id }
        : {}),
      ...(typeof body.model_base_url === 'string' ? { model_base_url: body.model_base_url } : {})
    }
  }

  private readTokenResponse(body: Record<string, unknown>): LabTokenResponse {
    if (
      typeof body.access_token !== 'string' ||
      !body.access_token ||
      typeof body.refresh_token !== 'string' ||
      !body.refresh_token
    ) {
      throw new LabApiError('invalid-response', 'Lab returned an invalid token response.')
    }
    const expiresIn =
      typeof body.expires_in === 'number' && Number.isFinite(body.expires_in)
        ? Math.max(1, body.expires_in)
        : 900
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresIn,
      tokenExpiresAt: this.now() + expiresIn * 1000,
      ...(typeof body.session_expires_at === 'string'
        ? { sessionExpiresAt: body.session_expires_at }
        : {})
    }
  }

  async listCases(
    serverUrl: string,
    accessToken: string,
    query: { q?: string; page?: number; pageSize?: number } = {},
    signal?: AbortSignal
  ): Promise<OrgCasesPage> {
    const url = new URL(`${serverUrl}/api/cases`)
    const normalizedQuery = normalizeOrgCaseSearchQuery(query.q)
    if (normalizedQuery) {
      if (normalizedQuery.includes('\0')) {
        throw new LabApiError('invalid-response', 'Search query must not contain NUL characters.')
      }
      if (Array.from(normalizedQuery).length > ORG_CASE_MAX_QUERY_LENGTH) {
        throw new LabApiError('invalid-response', 'Search query exceeds maximum length.')
      }
      url.searchParams.set('q', normalizedQuery)
    }
    const page =
      typeof query.page === 'number' && Number.isInteger(query.page) && query.page >= 1
        ? query.page
        : 1
    const pageSize =
      typeof query.pageSize === 'number' &&
      Number.isInteger(query.pageSize) &&
      query.pageSize >= 1 &&
      query.pageSize <= ORG_CASE_MAX_PAGE_SIZE
        ? query.pageSize
        : ORG_CASE_DEFAULT_PAGE_SIZE
    url.searchParams.set('page', String(page))
    url.searchParams.set('page_size', String(pageSize))
    const body = await this.request(
      url.toString(),
      { method: 'GET', headers: { authorization: `Bearer ${accessToken}` } },
      LAB_RESOURCE_LIMITS.bootstrapTimeoutMs,
      { signal, maxResponseBytes: Math.max(LAB_RESOURCE_LIMITS.maxResponseBytes, 1024 * 1024) }
    )
    const parsed = parseOrgCasesPage(body)
    if (!parsed) {
      throw new LabApiError('invalid-response', 'Lab returned invalid organization cases data.')
    }
    return parsed
  }

  async getCase(
    serverUrl: string,
    accessToken: string,
    caseId: string,
    signal?: AbortSignal
  ): Promise<OrgCaseDetail> {
    if (!isValidOrgCaseId(caseId)) {
      throw new LabApiError('invalid-response', 'Invalid organization case identifier.')
    }
    const body = await this.request(
      `${serverUrl}/api/cases/${encodeURIComponent(caseId)}`,
      { method: 'GET', headers: { authorization: `Bearer ${accessToken}` } },
      LAB_RESOURCE_LIMITS.bootstrapTimeoutMs,
      { signal }
    )
    const parsed = parseOrgCaseDetailResponse(body)
    if (!parsed) {
      throw new LabApiError('invalid-response', 'Lab returned invalid organization case details.')
    }
    return parsed
  }

  async getCaseDownload(
    serverUrl: string,
    accessToken: string,
    caseId: string,
    signal?: AbortSignal
  ): Promise<OrgCaseDownloadTicket> {
    if (!isValidOrgCaseId(caseId)) {
      throw new LabApiError('invalid-response', 'Invalid organization case identifier.')
    }
    const body = await this.request(
      `${serverUrl}/api/cases/${encodeURIComponent(caseId)}/download`,
      { method: 'GET', headers: { authorization: `Bearer ${accessToken}` } },
      LAB_RESOURCE_LIMITS.usageTimeoutMs,
      { signal }
    )
    const parsed = parseOrgCaseDownloadTicket(body)
    if (!parsed) {
      throw new LabApiError(
        'invalid-response',
        'Lab returned an invalid organization case download ticket.'
      )
    }
    return parsed
  }

  private async request(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    options: { allowEmpty?: boolean; signal?: AbortSignal; maxResponseBytes?: number } = {}
  ): Promise<Record<string, unknown>> {
    return withDeadline(
      async (signal) => {
        let response: Response
        try {
          response = await fetchProviderRequest(this.fetch, url, { ...init, signal })
        } catch (error) {
          if (error instanceof LabApiError) throw error
          if (error instanceof TypeError && /redirect/i.test(error.message)) {
            throw new LabApiError('server-error', 'The Lab server returned an unexpected redirect.')
          }
          throw new LabApiError('network', 'The Lab server could not be reached.')
        }
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel()
          throw new LabApiError('server-error', 'The Lab server returned an unexpected redirect.')
        }
        let text: string
        try {
          text = await readBoundedResponseText(
            response,
            options.maxResponseBytes ?? LAB_RESOURCE_LIMITS.maxResponseBytes,
            'Lab response',
            undefined,
            signal
          )
        } catch {
          if (signal.aborted)
            throw new LabApiError('timeout', 'The Lab server did not respond in time.')
          throw new LabApiError('invalid-response', 'Lab returned an unreadable response.')
        }
        if (!response.ok) {
          let parsed: unknown
          try {
            parsed = text ? JSON.parse(text) : undefined
          } catch {
            parsed = undefined
          }
          const { code, reason } = errorCodeFrom(response.status, parsed)
          throw new LabApiError(code, 'The Lab request failed.', response.status, reason)
        }
        if (!text && options.allowEmpty) return {}
        try {
          const parsed: unknown = JSON.parse(text)
          if (!isRecord(parsed)) throw new Error('not an object')
          return parsed
        } catch {
          throw new LabApiError('invalid-response', 'Lab returned an invalid response.')
        }
      },
      timeoutMs,
      'The Lab request timed out.',
      options.signal
    )
  }
}
