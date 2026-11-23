import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'

import type { LabSignInChallenge } from '../../shared/lab'
import { LAB_CALLBACK_PATH } from '../../shared/lab'
import { desktopShellInteraction } from '../desktop-interaction'
import openScienceLogoSvg from '../remote-access/open-science-logo.svg?raw'
import { runtimeMetadataIfConfigured } from '../runtime-metadata'
import { LabApi, LabApiError, type LabTokenResponse } from './lab-api'
import { collectLabDeviceInfo } from './lab-device-info'
import type { LabCredentialStore, LabStoredSession } from './lab-credential-store'
import { LAB_RESOURCE_LIMITS } from './lab-resource-limits'

// Browser-based Lab sign-in: system browser + a loopback callback on an explicitly allocated
// 127.0.0.1 port, PKCE S256, state matching and a five-minute window. The tokens are exchanged and
// stored entirely in main; the renderer only sees the authorization URL and the resulting status.

const callbackPage = (accepted: boolean): string => {
  const title = accepted ? 'Return to Open-Science' : 'Sign-in failed'
  const message = accepted
    ? 'Authorization received. You can close this tab.'
    : 'Return to Lab settings in Open-Science and try signing in again.'
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${title}</title>
  <style>
    /* Mirror the renderer's default palette from src/renderer/src/assets/main.css. */
    :root {
      color-scheme: light dark;
      --background: #fafaf8;
      --foreground: #202321;
      --muted-foreground: hsl(90 3% 34%);
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --background: #1a1a18;
        --foreground: #e8e6df;
        --muted-foreground: hsl(45 5% 78%);
      }
    }
    * { box-sizing: border-box }
    body {
      margin: 0;
      min-block-size: 100vh;
      min-block-size: 100svh;
      display: grid;
      place-items: center;
      padding: 32px 24px;
      font: 15px/1.6 system-ui, sans-serif;
      background: var(--background);
      color: var(--foreground);
    }
    main { width: min(100%, 440px); text-align: center; margin-block-end: 6vh }
    .logo { display: grid; place-items: center; width: 72px; height: 72px; margin: 0 auto 20px }
    .logo svg { display: block; width: 100%; height: auto }
    h1 { margin: 0 0 10px; font-size: clamp(24px, 5vw, 30px); font-weight: 650; line-height: 1.2; letter-spacing: -.035em }
    p { margin: 0; color: var(--muted-foreground) }
  </style>
</head>
<body>
  <main>
    <div class="logo" aria-hidden="true">${openScienceLogoSvg}</div>
    <h1>${title}</h1>
    <p>${message}</p>
  </main>
  ${accepted ? '<script>window.close()</script>' : ''}
</body>
</html>`
}

const base64Url = (bytes: number): string => randomBytes(bytes).toString('base64url')

const codeChallengeFor = (verifier: string): string =>
  createHash('sha256').update(verifier).digest('base64url')

// The Node backend bundle is built without Electron, so the default browser opener goes through the
// desktop host abstraction. The desktop app supplies it directly, the runtime bridges it to Desktop,
// and a CLI-only host fails closed with a typed "requires the desktop app" error.
const defaultOpenExternal = async (url: string): Promise<void> => {
  await desktopShellInteraction().openExternal(url)
}

type CallbackResult = Readonly<{ code?: string; error?: string }>

class LabLoopbackCallbackHost {
  private server: Server | undefined
  private redirectUri: string | undefined
  private pending:
    | {
        state: string
        resolve: (result: CallbackResult) => void
        reject: (error: Error) => void
        timer?: ReturnType<typeof setTimeout>
      }
    | undefined

  async start(): Promise<string> {
    if (this.redirectUri) return this.redirectUri
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== LAB_CALLBACK_PATH) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('Not found')
        return
      }
      const state = url.searchParams.get('state') ?? ''
      const pending = this.pending
      if (!pending || pending.state !== state) {
        response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
        response.end(callbackPage(false))
        return
      }
      this.pending = undefined
      if (pending.timer) clearTimeout(pending.timer)
      const error = url.searchParams.get('error') ?? undefined
      const code = url.searchParams.get('code')?.trim() || undefined
      const accepted = Boolean(code && !error)
      response.writeHead(accepted ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' })
      response.end(callbackPage(accepted))
      pending.resolve({ ...(code ? { code } : {}), ...(error ? { error } : {}) })
    })
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      await this.close()
      throw new LabApiError('server-error', 'The Lab sign-in callback could not start.')
    }
    this.redirectUri = `http://127.0.0.1:${address.port}${LAB_CALLBACK_PATH}`
    return this.redirectUri
  }

  waitFor(state: string, timeoutMs: number): Promise<CallbackResult> {
    if (this.pending) throw new Error('A Lab sign-in callback is already pending.')
    return new Promise<CallbackResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = undefined
        reject(new LabApiError('expired', 'The Lab sign-in request expired.'))
      }, timeoutMs)
      timer.unref?.()
      this.pending = { state, resolve, reject, timer }
    })
  }

  async close(): Promise<void> {
    const pending = this.pending
    this.pending = undefined
    if (pending) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(new LabApiError('cancelled', 'Lab sign-in was cancelled.'))
    }
    const server = this.server
    this.server = undefined
    this.redirectUri = undefined
    if (!server?.listening) return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  }
}

type PendingLogin = {
  serverUrl: string
  state: string
  verifier: string
  expiresAt: number
  host: LabLoopbackCallbackHost
  redirectUri?: string
  abort: AbortController
  completion?: Promise<LabStoredSession>
}

export type LabOAuthControllerOptions = {
  api: LabApi
  credentials: LabCredentialStore
  openExternal?: (url: string) => Promise<void>
  now?: () => number
  createCallbackHost?: () => LabLoopbackCallbackHost
}

export class LabOAuthController {
  private readonly api: LabApi
  private readonly credentials: LabCredentialStore
  private readonly openExternal: (url: string) => Promise<void>
  private readonly now: () => number
  private readonly createCallbackHost: () => LabLoopbackCallbackHost
  private pending: PendingLogin | undefined
  private disposed = false

  constructor(options: LabOAuthControllerOptions) {
    this.api = options.api
    this.credentials = options.credentials
    this.openExternal = options.openExternal ?? defaultOpenExternal
    this.now = options.now ?? Date.now
    this.createCallbackHost = options.createCallbackHost ?? (() => new LabLoopbackCallbackHost())
  }

  async beginLogin(serverUrl: string): Promise<LabSignInChallenge> {
    this.assertOpen()
    await this.cancelLogin()
    const host = this.createCallbackHost()
    const state = base64Url(24)
    const verifier = base64Url(32)
    // Register the attempt before starting the callback host as well as before any network work:
    // Cancel must be able to find and abort the attempt while the listener is starting.
    const pending: PendingLogin = {
      serverUrl,
      state,
      verifier,
      expiresAt: this.now() + LAB_RESOURCE_LIMITS.loginWindowMs,
      host,
      abort: new AbortController()
    }
    this.pending = pending
    try {
      const redirectUri = await host.start()
      this.assertPending(pending)
      pending.redirectUri = redirectUri
      const installationId = await this.credentials.ensureInstallationId()
      this.assertPending(pending)
      const appVersion = runtimeMetadataIfConfigured()?.version
      const deviceInfo = collectLabDeviceInfo({
        appVersion,
        locale: Intl.DateTimeFormat().resolvedOptions().locale,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
      })
      const attempt = await this.api.registerLoginAttempt({
        serverUrl,
        redirectUri,
        state,
        codeChallenge: codeChallengeFor(verifier),
        installationId,
        deviceName: typeof deviceInfo.hostname === 'string' ? deviceInfo.hostname : undefined,
        deviceInfo,
        signal: pending.abort.signal
      })
      this.assertPending(pending)
      const authorizationUrl = new URL(attempt.authorizationUrl)
      const server = new URL(serverUrl)
      if (
        authorizationUrl.protocol !== 'https:' &&
        !(authorizationUrl.protocol === 'http:' && server.protocol === 'http:')
      ) {
        throw new LabApiError('invalid-response', 'Lab returned an insecure authorization address.')
      }
      if (authorizationUrl.origin !== server.origin) {
        throw new LabApiError('invalid-response', 'Lab returned an unexpected authorization host.')
      }
      const expiresAt = Math.min(attempt.expiresAt, this.now() + LAB_RESOURCE_LIMITS.loginWindowMs)
      if (!Number.isFinite(expiresAt) || expiresAt <= this.now()) {
        throw new LabApiError('expired', 'The Lab sign-in request expired.')
      }
      // Register the callback waiter before opening the browser: a fast browser callback must find
      // the pending attempt, and a cancel during this window must find and close it too.
      pending.expiresAt = expiresAt
      pending.completion = this.completeLogin(pending, redirectUri)
      // The renderer may cancel or navigate away before it calls waitForLogin; observe the rejection
      // here so a timed-out callback never becomes an unhandled rejection. waitForLogin still sees it.
      void pending.completion.catch(() => undefined)
      try {
        await this.openExternal(attempt.authorizationUrl)
      } catch (error) {
        await this.cancelLogin()
        throw error
      }
      this.assertPending(pending)
      return { authorizationUrl: attempt.authorizationUrl, expiresAt }
    } catch (error) {
      if (this.pending === pending) this.pending = undefined
      await host.close()
      throw error
    }
  }

  private assertPending(pending: PendingLogin): void {
    if (this.pending !== pending) throw new LabApiError('cancelled', 'Lab sign-in was cancelled.')
  }

  async waitForLogin(): Promise<LabStoredSession> {
    this.assertOpen()
    const pending = this.pending
    if (!pending?.completion) throw new LabApiError('cancelled', 'No Lab sign-in is pending.')
    try {
      return await pending.completion
    } finally {
      if (this.pending === pending) this.pending = undefined
    }
  }

  async cancelLogin(): Promise<void> {
    const pending = this.pending
    this.pending = undefined
    if (!pending) return
    pending.abort.abort()
    await pending.host.close()
    // Observe the rejection so cancel does not surface as an unhandled rejection.
    await pending.completion?.catch(() => undefined)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.cancelLogin()
  }

  private async completeLogin(
    pending: PendingLogin,
    redirectUri: string
  ): Promise<LabStoredSession> {
    try {
      const timeoutMs = Math.max(1_000, pending.expiresAt - this.now())
      const result = await pending.host.waitFor(pending.state, timeoutMs)
      if (result.error) {
        throw result.error === 'access_denied'
          ? new LabApiError('cancelled', 'Lab sign-in was cancelled.')
          : new LabApiError('unauthorized', 'Lab sign-in failed.')
      }
      if (!result.code)
        throw new LabApiError('invalid-response', 'Lab returned no authorization code.')
      const tokens = await this.api.exchangeCode({
        serverUrl: pending.serverUrl,
        code: result.code,
        redirectUri,
        codeVerifier: pending.verifier,
        signal: pending.abort.signal
      })
      // Cancellation (or a server switch) while the code was being exchanged must not persist a
      // credential pair for an attempt that is no longer current.
      if (this.pending !== pending) throw new LabApiError('cancelled', 'Lab sign-in was cancelled.')
      const session = toStoredSession(tokens)
      await this.credentials.saveSession(session, pending.serverUrl)
      return session
    } finally {
      await pending.host.close()
    }
  }

  private assertOpen(): void {
    if (this.disposed) throw new LabApiError('unknown', 'Lab authentication is disposed.')
  }
}

export const toStoredSession = (tokens: LabTokenResponse): LabStoredSession => ({
  accessToken: tokens.accessToken,
  refreshToken: tokens.refreshToken,
  tokenExpiresAt: tokens.tokenExpiresAt,
  ...(tokens.sessionExpiresAt ? { sessionExpiresAt: tokens.sessionExpiresAt } : {})
})

export { LabLoopbackCallbackHost }
