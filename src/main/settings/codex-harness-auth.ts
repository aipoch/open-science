import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { CodexSubscriptionTransport } from '../../shared/settings'
import { registerOwnedPosixProcessGroup, terminateProcessTree } from '../process-tree'
import {
  createCodexAuthEnvironment,
  resolveCodexHarnessEndpoint,
  resolveCodexStoredAuthMode
} from './codex-auth'
import { codexSubscriptionStorageDir } from './codex-paths'
import { spawnCodexWithInstallAdmission } from './managed-codex'
import type { SystemProxyEnvironment } from './system-proxy'

export type CodexHarnessAuthOptions = Readonly<{
  storageRoot: string
  nativePath?: string
  resolveNativePath?: () => Promise<string | undefined>
  transport?: CodexSubscriptionTransport
  resolveProxyEnvironment?: () => Promise<SystemProxyEnvironment | undefined>
}>

export type CodexHarnessConnection = Readonly<{
  endpoint: string
  accessToken: string
  accountId: string
}>

export class CodexHarnessCompatibilityError extends Error {}

const AUTH_ERROR = 'The Codex subscription sign-in is unavailable. Reconnect Codex in Settings.'
const REFRESH_ERROR = 'Codex subscription authentication could not be refreshed.'
const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
const headerValue = (value: unknown): value is string =>
  typeof value === 'string' && /^[\x21-\x7e]+$/.test(value)

// Decoding a local token is used only for expiry/routing, never as signature verification. The
// authenticated provider verifies the bearer token. No claim, credential, or runtime output is logged.
const tokenClaims = (token: unknown): Record<string, unknown> | undefined => {
  if (!headerValue(token) || token.length > 128 * 1024) return undefined
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  try {
    return object(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')))
  } catch {
    return undefined
  }
}

const readCredential = async (
  home: string
): Promise<{ accessToken: string; accountId: string; expiresAt: number }> => {
  try {
    const auth = object(JSON.parse(await readFile(join(home, 'auth.json'), 'utf8')))
    const tokens = object(auth?.tokens)
    if (!auth) throw new Error()
    const mode = resolveCodexStoredAuthMode(auth)
    if (mode !== 'chatgpt' && mode !== 'chatgptAuthTokens')
      throw new CodexHarnessCompatibilityError(
        'The Codex profile authentication is not supported by the built-in Agent.'
      )
    if (!headerValue(tokens?.access_token) || !headerValue(tokens?.refresh_token)) throw new Error()
    const claims = tokenClaims(tokens.access_token)
    const identityClaims = tokenClaims(tokens.id_token)
    if (!claims || !identityClaims) throw new Error()
    const claimedAccount = object(claims['https://api.openai.com/auth'])?.chatgpt_account_id
    const accountId = tokens.account_id ?? claimedAccount
    if (!headerValue(accountId)) throw new Error()
    if (claimedAccount !== undefined && claimedAccount !== accountId) throw new Error()
    const expiresAt =
      typeof claims.exp === 'number' && Number.isFinite(claims.exp) ? claims.exp * 1000 : 0
    return { accessToken: tokens.access_token, accountId, expiresAt }
  } catch (error) {
    if (error instanceof CodexHarnessCompatibilityError) throw error
    throw new Error(AUTH_ERROR)
  }
}

// The Settings auth lifecycle serializes this operation against login/import/logout and validates
// its account revision before admitting a request. Codex remains the only OAuth refresh/persistence
// implementation; this helper never copies a credential to a second profile or refreshes it itself.
const refreshWithCodex = async (
  options: CodexHarnessAuthOptions,
  signal: AbortSignal
): Promise<void> => {
  if (!options.nativePath) throw new Error(REFRESH_ERROR)
  signal.throwIfAborted()
  const proxyEnv = await options.resolveProxyEnvironment?.()
  signal.throwIfAborted()
  const home = codexSubscriptionStorageDir(options.storageRoot)
  const env = createCodexAuthEnvironment('isolated', options.storageRoot, process.env, proxyEnv)
  // Neither another Codex login nor a development-only refresh destination may redirect this
  // profile's token exchange. The refresh token is only sent by Codex to its own authority.
  delete env.CODEX_ACCESS_TOKEN
  delete env.CODEX_REFRESH_TOKEN_URL_OVERRIDE
  env.HOME = home
  env.USERPROFILE = home
  const javascript = /\.[cm]?js$/i.test(options.nativePath)
  if (javascript && process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
  const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(options.nativePath)
  const command = javascript
    ? process.execPath
    : shell
      ? `"${options.nativePath}"`
      : options.nativePath
  const args = [
    ...(javascript ? [options.nativePath] : []),
    'app-server',
    '-c',
    'cli_auth_credentials_store="file"'
  ]
  const child = spawnCodexWithInstallAdmission([options.nativePath], () =>
    spawn(command, args, {
      env,
      cwd: home,
      shell,
      stdio: 'pipe',
      detached: process.platform !== 'win32',
      windowsHide: true
    })
  )
  if (process.platform !== 'win32') registerOwnedPosixProcessGroup(child)
  child.stderr.resume()
  let buffer = ''
  try {
    await new Promise<void>((resolve, reject) => {
      const fail = (): void => {
        cleanup()
        reject(new Error(REFRESH_ERROR))
      }
      const aborted = (): void => {
        cleanup()
        reject(signal.reason ?? new Error(REFRESH_ERROR))
      }
      let timer = setTimeout(fail, 10_000)
      const cleanup = (): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', aborted)
      }
      const send = (id: number, method: string, params: unknown): void => {
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
          if (error) fail()
        })
      }
      signal.addEventListener('abort', aborted, { once: true })
      child.once('error', fail)
      child.once('close', fail)
      child.stdin.on('error', fail)
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        if (buffer.length > 256 * 1024) return fail()
        let newline: number
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          let response: Record<string, unknown> | undefined
          try {
            response = object(JSON.parse(line))
          } catch {
            return fail()
          }
          if (response?.id !== 1 && response?.id !== 2) continue
          if (response.error) return fail()
          if (response.id === 1) {
            if (signal.aborted) return aborted()
            child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`)
            // Once sent, token rotation must finish and persist even when the model request is
            // cancelled. Killing Codex here could leave only an already-consumed refresh token.
            signal.removeEventListener('abort', aborted)
            clearTimeout(timer)
            timer = setTimeout(fail, 60_000)
            // Verified against rust-v0.157.1 account_processor.rs:1041 and
            // login/src/auth/manager.rs:3090: refresh is independent of includeToken and persists.
            send(2, 'getAuthStatus', { includeToken: false, refreshToken: true })
          } else {
            cleanup()
            resolve()
          }
        }
      })
      if (signal.aborted) return aborted()
      send(1, 'initialize', { clientInfo: { name: 'open-science-harness-auth', version: '1' } })
    })
  } finally {
    child.stdin.end()
    await terminateProcessTree(child)
  }
}

// Cheap capability projection: no subprocess, refresh or credential mutation during Settings reads.
// The request path uses the same profile parser and additionally refreshes expired tokens.
export const inspectCodexHarnessAvailability = async (
  options: CodexHarnessAuthOptions
): Promise<boolean> => {
  try {
    const { credential } = await readHarnessProfile(options)
    if (credential.expiresAt > Date.now() || options.resolveNativePath) return true
    if (!options.nativePath) return false
    await access(
      options.nativePath,
      /\.[cm]?js$/i.test(options.nativePath) ? constants.R_OK : constants.X_OK
    )
    return true
  } catch {
    return false
  }
}

const readHarnessProfile = async (
  options: CodexHarnessAuthOptions
): Promise<{ endpoint: string; credential: Awaited<ReturnType<typeof readCredential>> }> => {
  const home = codexSubscriptionStorageDir(options.storageRoot)
  let config = ''
  try {
    config = await readFile(join(home, 'config.toml'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(AUTH_ERROR)
  }
  let endpoint: string
  try {
    endpoint = resolveCodexHarnessEndpoint(config, options.transport)
  } catch (error) {
    throw new CodexHarnessCompatibilityError((error as Error).message)
  }
  return { endpoint, credential: await readCredential(home) }
}

export const readCodexHarnessConnection = async (
  options: CodexHarnessAuthOptions,
  signal: AbortSignal
): Promise<CodexHarnessConnection> => {
  signal.throwIfAborted()
  const home = codexSubscriptionStorageDir(options.storageRoot)
  const { endpoint, credential: initial } = await readHarnessProfile(options)
  signal.throwIfAborted()
  if (initial.expiresAt > Date.now())
    return { endpoint, accessToken: initial.accessToken, accountId: initial.accountId }
  const nativePath = options.resolveNativePath
    ? await options.resolveNativePath()
    : options.nativePath
  signal.throwIfAborted()
  await refreshWithCodex({ ...options, nativePath }, signal)
  const refreshed = await readCredential(home)
  signal.throwIfAborted()
  if (refreshed.accountId !== initial.accountId || refreshed.expiresAt <= Date.now())
    throw new Error(REFRESH_ERROR)
  return { endpoint, accessToken: refreshed.accessToken, accountId: refreshed.accountId }
}
