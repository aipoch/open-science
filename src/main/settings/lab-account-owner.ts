import type {
  LabBootstrap,
  LabCheckRequest,
  LabErrorCode,
  LabUsage,
  LabView
} from '../../shared/lab'
import { getLabServerUrlError, labModelSummaries, normalizeLabServerUrl } from '../../shared/lab'
import { LAB_PROVIDER_ID } from '../../shared/settings-runtime'
import { isCurrentInFlight } from '../../shared/in-flight-promise'

import { createLogger, diagnosticErrorFields } from '@aipoch/diagnostics/node'

import type {
  ListOrgCasesQuery,
  OrgCaseDetail,
  OrgCaseDownloadTicket,
  OrgCasesPage
} from '../../shared/org-cases'
import { LabApi, LabApiError, type UploadOrgCaseInput } from './lab-api'
import { LabCredentialStore, type LabPreviousSelection } from './lab-credential-store'
import { LabOAuthController } from './lab-oauth'
import { assertLabModelCatalog, assertLabServerUrlLength } from './lab-resource-limits'
import { buildLabProviderRecord } from './lab-provider'
import { ProviderRuntimeProjectionOwner } from './provider-runtime-projection'
import type { SettingsRepository } from './repository'
import type { StoredProvider } from './types'
import type { LabSignInChallenge } from '../../shared/lab'

// Owns the optional Lab connection: encrypted credentials, the strictly single-flight token refresh,
// the status state machine and the derived `builtin-lab` provider record. Every network call is
// bounded; failures only change this owner's status and never touch another provider or the app
// startup path.

export type LabAccountOwnerOptions = {
  configRoot: string
  repository: SettingsRepository
  onChange?: () => void
  now?: () => number
  credentials?: LabCredentialStore
  api?: LabApi
  oauth?: LabOAuthController
}

const toViewError = (error: unknown): { code: LabErrorCode; message?: string } => {
  if (error instanceof LabApiError) return { code: error.code, message: error.message }
  return { code: 'unknown', message: error instanceof Error ? error.message : undefined }
}

const isUnauthorized = (error: unknown): boolean =>
  error instanceof LabApiError && (error.code === 'unauthorized' || error.code === 'expired')

const log = createLogger('lab')

const hostOf = (value: string | undefined): string | undefined => {
  if (!value) return undefined
  try {
    return new URL(value).host
  } catch {
    return undefined
  }
}

class StaleLabConnectionError extends Error {}

export class LabAccountOwner {
  private readonly repository: SettingsRepository
  private readonly credentials: LabCredentialStore
  private readonly api: LabApi
  private readonly oauth: LabOAuthController
  private readonly now: () => number
  private readonly onChange?: () => void
  private readonly projection = new ProviderRuntimeProjectionOwner()

  private view: LabView = { state: 'unconfigured' }
  private initializePromise: Promise<void> | undefined
  private initialized = false
  private access: { token: string; expiresAt: number; serverUrl: string } | undefined
  private refreshState:
    { promise: Promise<string>; generation: number; serverUrl: string } | undefined
  private refreshGeneration = 0
  private loginAttempt = 0
  private activeLoginAttempt: number | undefined
  // Distinguishes concurrent quota reads on the same connection. A slower earlier response must
  // not overwrite a newer snapshot.
  private usageRequest = 0
  private pendingSessionClear: Promise<void> | undefined

  constructor(options: LabAccountOwnerOptions) {
    this.repository = options.repository
    this.now = options.now ?? Date.now
    this.onChange = options.onChange
    this.credentials =
      options.credentials ?? new LabCredentialStore(options.configRoot, { now: this.now })
    this.api = options.api ?? new LabApi({ now: this.now })
    this.oauth =
      options.oauth ??
      new LabOAuthController({ api: this.api, credentials: this.credentials, now: this.now })
  }

  getView(): LabView {
    return this.view
  }

  // Called once during app startup and never awaited by the bootstrap path. A failure only changes
  // the Lab status; it cannot block startup, the provider list or a personal conversation.
  initialize(): Promise<void> {
    if (this.initialized) return Promise.resolve()
    this.initializePromise ??= this.restore().finally(() => {
      this.initialized = true
      this.initializePromise = undefined
    })
    return this.initializePromise
  }

  private async restore(): Promise<void> {
    let hadSession = false
    const generation = this.refreshGeneration
    const loginAttempt = this.loginAttempt
    try {
      const snapshot = await this.credentials.readCredentialSnapshot()
      // A server switch or a sign-in can advance the connection while this disk read is in flight.
      // Never let that older snapshot replace the newer connection.
      if (generation !== this.refreshGeneration || loginAttempt !== this.loginAttempt) return
      if (!snapshot.serverUrl) {
        this.publish({ state: 'unconfigured' })
        return
      }
      const serverUrl = snapshot.serverUrl
      const session = snapshot.session
      if (!session) {
        const hadCredentials = await this.credentials.hasStoredCredentials()
        this.publish({
          state: hadCredentials ? 'expired' : 'signedOut',
          serverUrl,
          ...(hadCredentials ? { error: { code: 'expired' as const } } : {})
        })
        return
      }
      hadSession = true
      this.access = {
        token: session.accessToken,
        expiresAt: session.tokenExpiresAt,
        serverUrl
      }
      this.publish({ state: 'signedOut', serverUrl })
      const bootstrap = await this.bootstrapWithAuth()
      if (generation !== this.refreshGeneration || loginAttempt !== this.loginAttempt) return
      await this.applyBootstrap(serverUrl, bootstrap, generation)
    } catch (error) {
      log.warn('lab restore failed', {
        state: this.view.state,
        ...diagnosticErrorFields(error)
      })
      if (generation !== this.refreshGeneration) return
      const serverUrl = this.view.serverUrl
      if (isUnauthorized(error)) {
        await this.clearInvalidSession()
        this.publish({
          state: 'expired',
          ...(serverUrl ? { serverUrl } : {}),
          error: toViewError(error)
        })
      } else {
        this.publish({
          state: hadSession || this.view.state === 'authenticated' ? 'unreachable' : 'signedOut',
          ...(serverUrl ? { serverUrl } : {}),
          error: toViewError(error)
        })
      }
    }
  }

  async setServerUrl(serverUrlValue: string): Promise<LabView> {
    const errorCode = getLabServerUrlError(serverUrlValue)
    if (errorCode) return this.publishError(errorCode)
    const serverUrl = normalizeLabServerUrl(serverUrlValue)
    try {
      assertLabServerUrlLength(serverUrl)
    } catch {
      return this.publishError('server-url-invalid')
    }
    const previous = (await this.credentials.readDocument()).serverUrl
    if (previous !== serverUrl) {
      // Bump the connection generation first so an in-flight refresh from the old institution cannot
      // commit, then atomically swap the address and drop the old token pair.
      this.refreshGeneration += 1
      this.access = undefined
      this.loginAttempt += 1
      this.activeLoginAttempt = undefined
      await this.oauth.cancelLogin().catch(() => undefined)
      await this.credentials.replaceServer(serverUrl)
      // Switching institutions must not silently reuse a same-named model from the previous
      // institution. Reset only fixed Lab task bindings to inherit; personal bindings stay put.
      await this.removeProviderRecord('inherit')
      this.publish({ state: 'signedOut', serverUrl })
    } else {
      await this.credentials.saveServerUrl(serverUrl)
      this.publish({ ...this.view, serverUrl })
    }
    return this.view
  }

  async check(request?: LabCheckRequest): Promise<LabView> {
    const hasDraft = request !== undefined && Object.hasOwn(request, 'serverUrl')
    const draftServerUrl = request?.serverUrl?.trim()
    if (hasDraft) {
      if (!draftServerUrl) {
        return { ...this.view, error: { code: 'server-url-missing' } }
      }
      const errorCode = getLabServerUrlError(draftServerUrl)
      if (errorCode) {
        return { ...this.view, serverUrl: draftServerUrl, error: { code: errorCode } }
      }
      const normalizedDraft = normalizeLabServerUrl(draftServerUrl)
      const saved = (await this.credentials.readDocument()).serverUrl
      if (!saved || normalizeLabServerUrl(saved) !== normalizedDraft) {
        // Probe the draft only; never clear the current login or model catalog for a test.
        try {
          await this.api.clientBootstrap(normalizedDraft)
          return { state: 'signedOut', serverUrl: normalizedDraft }
        } catch (error) {
          return { state: 'unreachable', serverUrl: normalizedDraft, error: toViewError(error) }
        }
      }
    }
    const snapshot = await this.credentials.readCredentialSnapshot()
    const document = { serverUrl: snapshot.serverUrl }
    if (!document.serverUrl) return this.publish({ state: 'unconfigured' })
    const session = snapshot.session
    const generation = this.refreshGeneration
    if (!session) {
      // Without credentials, still prove the address is reachable through the public client
      // bootstrap endpoint so "Test connection" can distinguish a typo from an offline server.
      try {
        await this.api.clientBootstrap(document.serverUrl)
        // The probe may finish after a switch or a new login. Its success must not republish the
        // old institution as the current signedOut connection.
        if (!this.isCurrentConnection(generation, document.serverUrl)) return this.view
        return this.publish({ state: 'signedOut', serverUrl: document.serverUrl })
      } catch (error) {
        return this.handleRequestFailure(error, document.serverUrl, generation)
      }
    }
    try {
      const bootstrap = await this.bootstrapWithAuth()
      return await this.applyBootstrap(document.serverUrl, bootstrap, generation)
    } catch (error) {
      return this.handleRequestFailure(error, document.serverUrl, generation)
    }
  }

  async beginLogin(): Promise<LabSignInChallenge> {
    // Register the attempt before reading the saved address: Cancel/leaving the panel may arrive
    // while that read is still pending, and it must invalidate this flow before OAuth starts.
    const attempt = ++this.loginAttempt
    this.activeLoginAttempt = attempt
    let serverUrl: string | undefined
    try {
      const document = await this.credentials.readDocument()
      if (this.activeLoginAttempt !== attempt) {
        throw new LabApiError('cancelled', 'Lab sign-in was cancelled.')
      }
      serverUrl = document.serverUrl
      if (!serverUrl) {
        throw new LabApiError('server-url-missing', 'Configure the Lab server address first.')
      }
      const challenge = await this.oauth.beginLogin(serverUrl)
      // Cancel covers the whole attempt, including the window where a fast browser callback has
      // already saved a session but openExternal has not returned yet.
      if (this.activeLoginAttempt !== attempt) {
        throw new LabApiError('cancelled', 'Lab sign-in was cancelled.')
      }
      this.publish({ state: 'signingIn', serverUrl })
      return challenge
    } catch (error) {
      if (this.activeLoginAttempt === attempt) {
        this.activeLoginAttempt = undefined
        this.publish({
          state: 'signedOut',
          ...(serverUrl ? { serverUrl } : {}),
          error: toViewError(error)
        })
      }
      throw error
    }
  }

  async waitLogin(): Promise<LabView> {
    const document = await this.credentials.readDocument()
    const serverUrl = document.serverUrl
    const attempt = this.activeLoginAttempt
    let generation = this.refreshGeneration
    try {
      const session = await this.oauth.waitForLogin()
      if (attempt !== undefined && this.activeLoginAttempt !== attempt) {
        throw new LabApiError('cancelled', 'Lab sign-in was cancelled.')
      }
      this.access = {
        token: session.accessToken,
        expiresAt: session.tokenExpiresAt,
        serverUrl: serverUrl!
      }
      this.refreshGeneration += 1
      generation = this.refreshGeneration
      await this.credentials.clearPreviousSelection().catch(() => undefined)
      const bootstrap = await this.bootstrapWithAuth()
      if (attempt !== undefined && this.activeLoginAttempt !== attempt) {
        throw new LabApiError('cancelled', 'Lab sign-in was cancelled.')
      }
      return await this.applyBootstrap(serverUrl!, bootstrap, generation)
    } catch (error) {
      return this.handleRequestFailure(error, serverUrl, generation)
    } finally {
      if (attempt !== undefined && this.activeLoginAttempt === attempt) {
        this.activeLoginAttempt = undefined
      }
    }
  }

  async cancelLogin(): Promise<LabView> {
    const wasLoginActive = this.activeLoginAttempt !== undefined || this.view.state === 'signingIn'
    if (!wasLoginActive) {
      // A late cancel (e.g. panel unmount after the login already completed) must not turn a
      // healthy authenticated session into signedOut.
      await this.oauth.cancelLogin().catch(() => undefined)
      return this.view
    }
    if (wasLoginActive) {
      // Cancel covers the whole sign-in flow, including the window before beginLogin publishes
      // signingIn and the catalog load after the browser callback. Advance the attempt and
      // generation so old results cannot publish, and remove any session the callback saved.
      this.loginAttempt += 1
      this.activeLoginAttempt = undefined
      this.refreshGeneration += 1
      this.access = undefined
    }
    await this.oauth.cancelLogin()
    if (wasLoginActive) await this.credentials.clearSession().catch(() => undefined)
    const document = await this.credentials.readDocument()
    return this.publish({
      state: document.serverUrl ? 'signedOut' : 'unconfigured',
      ...(document.serverUrl ? { serverUrl: document.serverUrl } : {}),
      error: { code: 'cancelled' }
    })
  }

  async refreshCatalog(): Promise<LabView> {
    const document = await this.credentials.readDocument()
    if (!document.serverUrl) return this.publish({ state: 'unconfigured' })
    const generation = this.refreshGeneration
    try {
      const bootstrap = await this.bootstrapWithAuth()
      return await this.applyBootstrap(document.serverUrl, bootstrap, generation)
    } catch (error) {
      return this.handleRequestFailure(error, document.serverUrl, generation)
    }
  }

  async logout(): Promise<LabView> {
    const document = await this.credentials.readDocument()
    const serverUrl = document.serverUrl
    let token: string | undefined
    if (serverUrl) {
      token = await this.getAccessToken(false, serverUrl).catch(() => undefined)
    }
    await this.oauth.cancelLogin().catch(() => undefined)
    await this.credentials.clearSession().catch(() => undefined)
    this.access = undefined
    this.refreshState = undefined
    this.refreshGeneration += 1
    this.loginAttempt += 1
    this.activeLoginAttempt = undefined
    await this.removeProviderRecord()
    const view = this.publish({
      state: serverUrl ? 'signedOut' : 'unconfigured',
      ...(serverUrl ? { serverUrl } : {})
    })
    if (serverUrl && token) {
      await this.api.logout(serverUrl, token).catch(() => undefined)
    }
    return view
  }

  // Resolves a live bearer token for the provider bridges. Refreshes are strictly single-flight and
  // never retried after a failure: the server rotates refresh tokens and a duplicate request can
  // revoke the whole client session, so a failed refresh means "sign in again".
  async listCases(query: ListOrgCasesQuery = {}, signal?: AbortSignal): Promise<OrgCasesPage> {
    return this.withAuthorizedCaseRequest(signal, (serverUrl, accessToken) =>
      this.api.listCases(serverUrl, accessToken, query, signal)
    )
  }

  async getCase(caseId: string, signal?: AbortSignal): Promise<OrgCaseDetail> {
    return this.withAuthorizedCaseRequest(signal, (serverUrl, accessToken) =>
      this.api.getCase(serverUrl, accessToken, caseId, signal)
    )
  }

  async getCaseDownload(caseId: string, signal?: AbortSignal): Promise<OrgCaseDownloadTicket> {
    return this.withAuthorizedCaseRequest(signal, (serverUrl, accessToken) =>
      this.api.getCaseDownload(serverUrl, accessToken, caseId, signal)
    )
  }

  async uploadCase(input: UploadOrgCaseInput, signal?: AbortSignal): Promise<OrgCaseDetail> {
    return this.withAuthorizedCaseRequest(signal, (serverUrl, accessToken) =>
      this.api.uploadCase(serverUrl, accessToken, input, signal)
    )
  }

  private async withAuthorizedCaseRequest<T>(
    signal: AbortSignal | undefined,
    execute: (serverUrl: string, accessToken: string) => Promise<T>
  ): Promise<T> {
    if (signal?.aborted) {
      throw new LabApiError('cancelled', 'The Lab request was cancelled.')
    }
    const expectedServerUrl = this.view.serverUrl
    const startGeneration = this.refreshGeneration
    if (!expectedServerUrl || this.view.state !== 'authenticated') {
      throw new LabApiError('unauthorized', 'Sign in to Lab first.')
    }
    const token = await this.getAccessToken(false, expectedServerUrl)
    if (signal?.aborted) {
      throw new LabApiError('cancelled', 'The Lab request was cancelled.')
    }
    if (this.refreshGeneration !== startGeneration || this.view.serverUrl !== expectedServerUrl) {
      throw new LabApiError('cancelled', 'The Lab session changed.')
    }
    try {
      return await execute(expectedServerUrl, token)
    } catch (error) {
      if (signal?.aborted || (error instanceof LabApiError && error.code === 'cancelled')) {
        throw new LabApiError('cancelled', 'The Lab request was cancelled.')
      }
      if (this.refreshGeneration !== startGeneration || this.view.serverUrl !== expectedServerUrl) {
        throw new LabApiError('cancelled', 'The Lab session changed.')
      }
      if (!(error instanceof LabApiError) || error.code !== 'unauthorized') {
        throw error
      }
      const latest = this.access
      const expectedNormalized = normalizeLabServerUrl(expectedServerUrl)
      const alreadyRotated =
        latest &&
        normalizeLabServerUrl(latest.serverUrl) === expectedNormalized &&
        latest.token !== token &&
        latest.expiresAt > this.now()
      const refreshed = alreadyRotated
        ? latest.token
        : await this.getAccessToken(true, expectedServerUrl)
      if (signal?.aborted) {
        throw new LabApiError('cancelled', 'The Lab request was cancelled.')
      }
      if (this.refreshGeneration !== startGeneration || this.view.serverUrl !== expectedServerUrl) {
        throw new LabApiError('cancelled', 'The Lab session changed.')
      }
      try {
        return await execute(expectedServerUrl, refreshed)
      } catch (retryError) {
        if (
          signal?.aborted ||
          (retryError instanceof LabApiError && retryError.code === 'cancelled')
        ) {
          throw new LabApiError('cancelled', 'The Lab request was cancelled.')
        }
        if (
          this.refreshGeneration !== startGeneration ||
          this.view.serverUrl !== expectedServerUrl
        ) {
          throw new LabApiError('cancelled', 'The Lab session changed.')
        }
        if (retryError instanceof LabApiError && retryError.code === 'unauthorized') {
          await this.expire('unauthorized', startGeneration)
        }
        throw retryError
      }
    }
  }

  async getAccessToken(forceRefresh = false, expectedServerUrl?: string): Promise<string> {
    const resolvedServerUrl =
      expectedServerUrl ??
      this.view.serverUrl ??
      (await this.credentials.readDocument().catch(() => undefined))?.serverUrl
    if (!resolvedServerUrl) {
      throw new LabApiError('unauthorized', 'The Lab connection changed. Sign in again.')
    }
    const expected = normalizeLabServerUrl(resolvedServerUrl)
    const current = this.view.serverUrl ? normalizeLabServerUrl(this.view.serverUrl) : undefined
    if (current !== undefined && current !== expected) {
      throw new LabApiError('unauthorized', 'The Lab connection changed. Sign in again.')
    }
    if (current === undefined) this.view = { ...this.view, serverUrl: resolvedServerUrl }
    if (!this.access) {
      const snapshot = await this.credentials.readCredentialSnapshot()
      if (
        snapshot.session &&
        snapshot.serverUrl &&
        normalizeLabServerUrl(snapshot.serverUrl) === expected &&
        snapshot.session.tokenExpiresAt - this.now() > 60_000
      ) {
        this.access = {
          token: snapshot.session.accessToken,
          expiresAt: snapshot.session.tokenExpiresAt,
          serverUrl: snapshot.serverUrl
        }
      }
    }
    const cached = this.access
    if (
      !forceRefresh &&
      cached &&
      normalizeLabServerUrl(cached.serverUrl) === expected &&
      cached.expiresAt - this.now() > 60_000
    )
      return cached.token
    const generation = this.refreshGeneration
    if (
      this.refreshState &&
      this.refreshState.generation === generation &&
      this.refreshState.serverUrl === expected
    ) {
      return this.refreshState.promise
    }
    const pending = this.refreshAccessToken(generation, expected)
    this.refreshState = { promise: pending, generation, serverUrl: expected }
    try {
      return await pending
    } finally {
      if (isCurrentInFlight(this.refreshState?.promise, pending)) this.refreshState = undefined
    }
  }

  async isUsable(): Promise<boolean> {
    try {
      await this.getAccessToken()
      return true
    } catch {
      return false
    }
  }

  async capturePreviousSelection(selection: LabPreviousSelection): Promise<void> {
    if (selection.providerId === LAB_PROVIDER_ID) return
    await this.credentials.savePreviousSelection(selection)
  }

  async dispose(): Promise<void> {
    await Promise.all([this.oauth.dispose(), this.pendingSessionClear])
  }

  private async refreshAccessToken(generation: number, expectedServerUrl: string): Promise<string> {
    const snapshot = await this.credentials.readCredentialSnapshot()
    if (!snapshot.serverUrl || !snapshot.session) {
      this.expire('unauthorized', generation)
      throw new LabApiError('unauthorized', 'Sign in to Lab to continue.')
    }
    if (
      normalizeLabServerUrl(snapshot.serverUrl) !== expectedServerUrl ||
      generation !== this.refreshGeneration
    ) {
      throw new LabApiError('unauthorized', 'The Lab connection changed. Sign in again.')
    }
    try {
      const tokens = await this.api.refreshToken(snapshot.serverUrl, snapshot.session.refreshToken)
      // Re-check before persisting: a switch or logout may have happened while the request was in
      // flight. A stale result must never overwrite the current session.
      const after = await this.credentials.readCredentialSnapshot()
      if (
        generation !== this.refreshGeneration ||
        !after.serverUrl ||
        normalizeLabServerUrl(after.serverUrl) !== expectedServerUrl
      ) {
        throw new StaleLabConnectionError('The Lab connection changed while refreshing.')
      }
      await this.credentials.saveSession(
        {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          tokenExpiresAt: tokens.tokenExpiresAt,
          ...(tokens.sessionExpiresAt ? { sessionExpiresAt: tokens.sessionExpiresAt } : {})
        },
        snapshot.serverUrl
      )
      this.access = {
        token: tokens.accessToken,
        expiresAt: tokens.tokenExpiresAt,
        serverUrl: snapshot.serverUrl
      }
      return tokens.accessToken
    } catch (error) {
      if (error instanceof StaleLabConnectionError) {
        throw new LabApiError('unauthorized', 'The Lab connection changed. Sign in again.')
      }
      const current = await this.credentials.readCredentialSnapshot()
      if (
        generation !== this.refreshGeneration ||
        !current.serverUrl ||
        normalizeLabServerUrl(current.serverUrl) !== expectedServerUrl
      ) {
        throw new LabApiError('unauthorized', 'The Lab connection changed. Sign in again.')
      }
      // A failed refresh for the current connection (including a lost response) requires a fresh
      // browser sign-in. A stale refresh must not clear a newer session.
      this.expire(error instanceof LabApiError ? error.code : 'unauthorized', generation)
      throw new LabApiError('unauthorized', 'Sign in to Lab again.')
    }
  }

  private expire(code: LabErrorCode, generation?: number): Promise<void> {
    if (generation !== undefined && generation !== this.refreshGeneration) {
      return Promise.resolve()
    }
    this.access = undefined
    this.refreshGeneration += 1
    const serverUrl = this.view.serverUrl
    this.publish({ state: 'expired', ...(serverUrl ? { serverUrl } : {}), error: { code } })
    const clear = this.credentials
      .clearSession()
      .catch(() => undefined)
      .finally(() => {
        if (this.pendingSessionClear === clear) this.pendingSessionClear = undefined
      })
    this.pendingSessionClear = clear
    return clear
  }

  private async bootstrapWithAuth(): Promise<LabBootstrap> {
    const document = await this.credentials.readDocument()
    if (!document.serverUrl)
      throw new LabApiError('server-url-missing', 'No Lab server configured.')
    const token = await this.getAccessToken(false, document.serverUrl)
    try {
      return await this.api.bootstrap(document.serverUrl, token)
    } catch (error) {
      if (!(error instanceof LabApiError) || error.code !== 'unauthorized') throw error
    }
    const refreshed = await this.getAccessToken(true, document.serverUrl)
    return this.api.bootstrap(document.serverUrl, refreshed)
  }

  // Quota is optional information: a slow/failed usage request must never fail a Lab login or
  // catalog refresh. Fetch it after publishing the authenticated view and update the view later.
  private async loadUsage(serverUrl: string, generation: number): Promise<LabUsage | undefined> {
    if (generation !== this.refreshGeneration) return undefined
    const cached = this.access
    if (
      !cached ||
      normalizeLabServerUrl(cached.serverUrl) !== normalizeLabServerUrl(serverUrl) ||
      cached.expiresAt <= this.now()
    )
      return undefined
    try {
      // Reuse the access token that just authenticated the catalog. Calling getAccessToken() here
      // would eagerly refresh inside the 60-second lead window and could turn an otherwise valid
      // session into expired when the refresh fails.
      const usage = await this.api.usage(serverUrl, cached.token)
      return this.isCurrentConnection(generation, serverUrl) ? usage : undefined
    } catch {
      return undefined
    }
  }

  private refreshUsageInBackground(serverUrl: string, generation: number): void {
    const request = ++this.usageRequest
    void this.loadUsage(serverUrl, generation)
      .then((usage) => {
        if (
          request === this.usageRequest &&
          usage &&
          this.isCurrentConnection(generation, serverUrl) &&
          this.view.state === 'authenticated'
        ) {
          this.publish({ ...this.view, usage })
        }
      })
      .catch(() => undefined)
  }

  private async applyBootstrap(
    serverUrl: string,
    bootstrap: LabBootstrap,
    generation: number
  ): Promise<LabView> {
    if (!this.isCurrentConnection(generation, serverUrl)) return this.view
    assertLabModelCatalog(bootstrap.models)
    const record = {
      ...buildLabProviderRecord(serverUrl, bootstrap),
      // A successful bootstrap is the Lab account's validation proof. Without it the renderer's
      // authentication recovery cannot distinguish a fresh sign-in from the failed attempt.
      lastValidatedAt: this.now()
    }
    const existing = (await this.repository.getSettings()).providers.find(
      (provider) => provider.id === LAB_PROVIDER_ID
    )
    try {
      await this.repository.upsertProvider(record, undefined, undefined, {
        expectedLabCatalogToken: existing?.labCatalogToken,
        // Evaluate the connection generation inside the serialized repository mutation, not
        // before the asynchronous settings read: a new login may win between those two steps.
        isCurrent: () => this.isCurrentConnection(generation, serverUrl)
      })
    } catch (error) {
      // A concurrent catalog write or login won the race; never overwrite its record.
      if (
        !this.isCurrentConnection(generation, serverUrl) ||
        (error instanceof Error && error.message.startsWith('Lab catalog changed'))
      ) {
        return this.view
      }
      throw error
    }
    if (!this.isCurrentConnection(generation, serverUrl)) {
      // A switch or logout raced this catalog response. Remove only the record derived from the
      // stale server; never delete a newer institution's record.
      const current = (await this.repository.getSettings()).providers.find(
        (provider) => provider.id === LAB_PROVIDER_ID
      )
      // Only the exact catalog write we performed may be removed. A newer login at the same address
      // has a different token and must never be deleted by this stale cleanup.
      if (current?.labCatalogToken && current.labCatalogToken === record.labCatalogToken) {
        // This branch is only reachable after the connection became stale, so an isCurrent guard
        // here would always reject the rollback. The unique catalog token is the exact write
        // identity and protects any newer login's record.
        await this.repository.deleteProvider(LAB_PROVIDER_ID, 'inherit', {
          expectedLabCatalogToken: record.labCatalogToken
        })
      }
      return this.view
    }
    const models = labModelSummaries(bootstrap.models)
    const view = this.publish({
      state: 'authenticated',
      serverUrl,
      accountId: bootstrap.user.id,
      accountName: bootstrap.user.display_name,
      orgId: bootstrap.user.org_id,
      deviceName: bootstrap.device.name,
      deviceId: bootstrap.device.id,
      modelCount: models.length,
      models,
      ...(this.view.sessionExpiresAt ? { sessionExpiresAt: this.view.sessionExpiresAt } : {})
    })
    this.refreshUsageInBackground(serverUrl, generation)
    return view
  }

  private async handleRequestFailure(
    error: unknown,
    serverUrl: string | undefined,
    generation?: number
  ): Promise<LabView> {
    if (
      generation !== undefined &&
      !this.isCurrentConnection(generation, serverUrl ?? this.view.serverUrl ?? '')
    ) {
      // A stale request may fail after a switch or logout. It must not overwrite the current view.
      return this.view
    }
    const code = error instanceof LabApiError ? error.code : 'unknown'
    log.warn('lab request failed', {
      code,
      ...(error instanceof LabApiError && error.status ? { status: error.status } : {}),
      ...(error instanceof LabApiError && error.reason ? { reason: error.reason } : {}),
      ...(hostOf(serverUrl) ? { server: hostOf(serverUrl) } : {})
    })
    if (code === 'cancelled') {
      return this.publish({
        state: 'signedOut',
        ...(serverUrl ? { serverUrl } : {}),
        error: { code: 'cancelled' }
      })
    }
    if (isUnauthorized(error)) {
      if (generation !== undefined && generation !== this.refreshGeneration) return this.view
      await this.clearInvalidSession()
      return this.publish({
        state: 'expired',
        ...(serverUrl ? { serverUrl } : {}),
        error: { code: 'expired' }
      })
    }
    const blocked: LabErrorCode[] = [
      'license-inactive',
      'seat-required',
      'org-inactive',
      'account-disabled',
      'device-limit'
    ]
    return this.publish({
      state: blocked.includes(code) ? 'blocked' : 'unreachable',
      ...(serverUrl ? { serverUrl } : {}),
      error: { code }
    })
  }

  private async clearInvalidSession(): Promise<void> {
    this.access = undefined
    this.refreshGeneration += 1
    await this.credentials.clearSession().catch(() => undefined)
  }

  private async removeProviderRecord(
    scenarioModelHandling: 'preserve' | 'inherit' = 'preserve'
  ): Promise<void> {
    const settings = await this.repository.getSettings()
    const existing = settings.providers.find((provider) => provider.id === LAB_PROVIDER_ID)
    const previous = await this.credentials.readPreviousSelection().catch(() => undefined)
    const fallback =
      settings.activeProviderId === LAB_PROVIDER_ID
        ? this.pickFallback(settings.providers, previous)
        : undefined
    // Restore the active pointer in the same mutation that deletes the Lab record. Reading the
    // settings here and calling setActiveProvider afterwards would race a user's newer selection.
    await this.repository.deleteProvider(LAB_PROVIDER_ID, scenarioModelHandling, {
      ...(fallback
        ? {
            restoreActive: {
              providerId: fallback.provider.id,
              ...(fallback.model ? { model: fallback.model } : {})
            }
          }
        : {})
    })
    if (existing) await this.credentials.clearPreviousSelection().catch(() => undefined)
  }

  private isCurrentConnection(generation: number, serverUrl: string): boolean {
    if (generation !== this.refreshGeneration) return false
    if (!this.view.serverUrl) return true
    return normalizeLabServerUrl(this.view.serverUrl) === normalizeLabServerUrl(serverUrl)
  }

  private pickFallback(
    providers: readonly StoredProvider[],
    previous: LabPreviousSelection | undefined
  ): { provider: StoredProvider; model?: string } | undefined {
    const candidates = providers.filter((provider) => provider.id !== LAB_PROVIDER_ID)
    const remembered = previous
      ? candidates.find((provider) => provider.id === previous.providerId)
      : undefined
    const provider = remembered ?? candidates[0]
    if (!provider) return undefined
    // Reuse the normal runtime catalog resolution so built-in subscription catalogs (for example
    // Codex models) are considered, not only fetchedModels/provider.model.
    const restoredModel = this.projection.resolveActiveModel(
      provider,
      remembered ? previous?.model : undefined
    )
    return { provider, ...(restoredModel ? { model: restoredModel } : {}) }
  }

  private publish(view: LabView): LabView {
    this.view = Object.freeze(view)
    this.onChange?.()
    return this.view
  }

  private publishError(code: LabErrorCode): LabView {
    return this.publish({ ...this.view, error: { code } })
  }
}
