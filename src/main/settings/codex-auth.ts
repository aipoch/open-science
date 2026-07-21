import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'

import * as acp from '@agentclientprotocol/sdk'

import { codexSubscriptionStorageDir } from '../agent-framework/codex'
import { terminateProcessTree } from '../process-tree'
import { augmentedPathEnv } from './shell-path'

export type CodexAuthMode = 'shared' | 'isolated'

export type CodexAuthStatus = {
  mode: CodexAuthMode
  supported: boolean
  authenticated: boolean
  message?: string
}

type CodexAuthenticationStatus = {
  type?: 'unauthenticated' | 'api-key' | 'chat-gpt' | 'gateway'
  email?: string
  name?: string
}

export type CodexAuthSession = {
  initialize: () => Promise<{ authMethods?: { id: string }[] }>
  status: () => Promise<CodexAuthenticationStatus>
  authenticateChatGpt: () => Promise<void>
  logout: () => Promise<void>
  close: () => Promise<void>
}

export type CodexAuthLaunch = {
  adapterPath: string
  nativePath?: string
  mode: CodexAuthMode
  storageRoot: string
}

type CodexAuthControllerOptions = {
  openSession: (mode: CodexAuthMode) => Promise<CodexAuthSession>
  loginTimeoutMs?: number
}

const CODEX_ENV_KEYS = [
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
  'CODEX_CONFIG',
  'CODEX_HOME',
  'CODEX_PATH',
  'MODEL_PROVIDER',
  'DEFAULT_AUTH_REQUEST',
  'NO_BROWSER'
] as const

export const createCodexAuthEnvironment = (
  mode: CodexAuthMode,
  storageRoot: string,
  sourceEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv => {
  const env = augmentedPathEnv(sourceEnv)
  for (const key of CODEX_ENV_KEYS) delete env[key]

  if (mode === 'isolated') env.CODEX_HOME = codexSubscriptionStorageDir(storageRoot)
  return env
}

const abortError = (message: string): Error => {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

const waitForAbort = (signal: AbortSignal): Promise<never> =>
  new Promise((_, reject) => {
    if (signal.aborted) {
      reject(abortError(String(signal.reason ?? 'cancelled')))
      return
    }
    signal.addEventListener(
      'abort',
      () => reject(abortError(String(signal.reason ?? 'cancelled'))),
      { once: true }
    )
  })

const waitForOperation = <Value>(operation: Promise<Value>, signal: AbortSignal): Promise<Value> =>
  Promise.race([operation, waitForAbort(signal)])

const capabilityFailure = (mode: CodexAuthMode): CodexAuthStatus => ({
  mode,
  supported: false,
  authenticated: false,
  message: 'The installed codex-acp does not advertise ChatGPT authentication.'
})

// Any stored credential counts as authenticated, not just a ChatGPT login: a profile holding an
// API key (or gateway auth) runs fine at runtime, so reporting it as signed out would be a false
// negative that blocks an otherwise working provider.
const isAuthenticated = (status: CodexAuthenticationStatus): boolean =>
  status.type === 'chat-gpt' || status.type === 'api-key' || status.type === 'gateway'

const toPublicStatus = (
  mode: CodexAuthMode,
  supported: boolean,
  status: CodexAuthenticationStatus
): CodexAuthStatus =>
  supported
    ? {
        mode,
        supported: true,
        authenticated: isAuthenticated(status)
      }
    : capabilityFailure(mode)

export class CodexAuthController {
  private readonly openSession: (mode: CodexAuthMode) => Promise<CodexAuthSession>
  private readonly loginTimeoutMs: number
  private activeLogin: AbortController | undefined

  constructor(options: CodexAuthControllerOptions) {
    this.openSession = options.openSession
    this.loginTimeoutMs = options.loginTimeoutMs ?? 5 * 60_000
  }

  async getStatus(mode: CodexAuthMode): Promise<CodexAuthStatus> {
    const authSession = await this.openSession(mode)
    try {
      const initialized = await authSession.initialize()
      const supported = initialized.authMethods?.some((method) => method.id === 'chat-gpt') ?? false
      if (!supported) return capabilityFailure(mode)

      return toPublicStatus(mode, true, await authSession.status())
    } finally {
      await authSession.close()
    }
  }

  async loginIsolated(): Promise<CodexAuthStatus> {
    if (this.activeLogin) {
      return {
        mode: 'isolated',
        supported: true,
        authenticated: false,
        message: 'A Codex sign-in is already in progress.'
      }
    }

    const abort = new AbortController()
    this.activeLogin = abort
    const timeout = setTimeout(() => abort.abort('timeout'), this.loginTimeoutMs)
    let authSession: CodexAuthSession | undefined

    try {
      const sessionPromise = this.openSession('isolated')
      void sessionPromise
        .then(async (session) => {
          if (abort.signal.aborted && authSession !== session) await session.close()
        })
        .catch(() => undefined)
      authSession = await waitForOperation(sessionPromise, abort.signal)
      const initialized = await waitForOperation(authSession.initialize(), abort.signal)
      const supported = initialized.authMethods?.some((method) => method.id === 'chat-gpt') ?? false
      if (!supported) return capabilityFailure('isolated')

      const current = await waitForOperation(authSession.status(), abort.signal)
      if (!isAuthenticated(current)) {
        await waitForOperation(authSession.authenticateChatGpt(), abort.signal)
      }

      return toPublicStatus(
        'isolated',
        true,
        await waitForOperation(authSession.status(), abort.signal)
      )
    } catch (error) {
      if (abort.signal.aborted) {
        return {
          mode: 'isolated',
          supported: true,
          authenticated: false,
          message:
            abort.signal.reason === 'timeout'
              ? 'Codex sign-in timed out after five minutes.'
              : 'Codex sign-in was cancelled.'
        }
      }
      throw error
    } finally {
      clearTimeout(timeout)
      this.activeLogin = undefined
      await authSession?.close()
    }
  }

  cancelLogin(): void {
    this.activeLogin?.abort('cancelled')
  }

  async logoutIsolated(): Promise<CodexAuthStatus> {
    const authSession = await this.openSession('isolated')
    try {
      const initialized = await authSession.initialize()
      const supported = initialized.authMethods?.some((method) => method.id === 'chat-gpt') ?? false
      if (!supported) return capabilityFailure('isolated')

      await authSession.logout()
      return { mode: 'isolated', supported: true, authenticated: false }
    } finally {
      await authSession.close()
    }
  }
}

export type CodexAuthControllerPort = Pick<
  CodexAuthController,
  'getStatus' | 'loginIsolated' | 'cancelLogin' | 'logoutIsolated'
>

export const openCodexAuthSession = async ({
  adapterPath,
  nativePath,
  mode,
  storageRoot
}: CodexAuthLaunch): Promise<CodexAuthSession> => {
  const isJavaScript = /\.[cm]?js$/i.test(adapterPath)
  const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(adapterPath)
  const command = isJavaScript ? process.execPath : needsShell ? `"${adapterPath}"` : adapterPath
  const args = isJavaScript ? [adapterPath] : []
  const env = createCodexAuthEnvironment(mode, storageRoot)
  if (isJavaScript) env.ELECTRON_RUN_AS_NODE = '1'
  if (nativePath) env.CODEX_PATH = nativePath

  const child = spawn(command, args, {
    env,
    shell: needsShell,
    stdio: 'pipe',
    windowsHide: true
  })
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
  )
  const connection = acp.client({ name: 'open-science-auth' }).connect(stream)

  return {
    initialize: () =>
      connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientInfo: { name: 'open-science-auth', version: '0.0.0' },
        clientCapabilities: {}
      }),
    status: () => connection.agent.request<CodexAuthenticationStatus>('authentication/status', {}),
    authenticateChatGpt: () =>
      connection.agent
        .request(acp.methods.agent.authenticate, { methodId: 'chat-gpt' })
        .then(() => undefined),
    logout: () =>
      connection.agent
        .request<Record<string, never>>('authentication/logout', {})
        .then(() => undefined),
    close: async () => {
      connection.close()
      child.stdin.end()
      await terminateProcessTree(child)
    }
  }
}
