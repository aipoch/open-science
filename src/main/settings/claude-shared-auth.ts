import { resolveClaudeExecutableForSpawn } from '../acp/claude-executable'
import { spawnClaudeCli, waitForAbortableOperation } from './claude-cli-process'
import { getUserClaudeConfigDir } from './provider-env'
import { augmentedPathEnv } from './shell-path'

// Claude-shared auth lifecycle: browser OAuth via `claude auth login --claudeai`. Mirrors
// CodexAuthController in shape (getStatus / loginShared / cancelLogin / logoutShared) but calls
// the Claude CLI directly instead of going through an ACP adapter. Credentials are stored in
// ~/.claude by the CLI; the app never touches them.

export type ClaudeSharedAuthStatus = {
  supported: boolean
  authenticated: boolean
  message?: string
  // Set when the user explicitly cancelled the browser sign-in (not a timeout or error).
  cancelled?: boolean
}

type ClaudeSharedAuthControllerOptions = {
  // Absolute path to the claude executable, or a resolver called before each spawn. A resolver lets
  // callers use the persisted detection result without a synchronous construction-time read.
  claudePath: string | (() => string | Promise<string>)
  loginTimeoutMs?: number
  statusTimeoutMs?: number
}

// Checks whether the user is signed in by running `claude auth status`.
const checkAuthStatus = async (
  claudePath: string,
  timeoutMs: number
): Promise<ClaudeSharedAuthStatus> => {
  const abort = new AbortController()
  const timeout = setTimeout(() => abort.abort('timeout'), timeoutMs)

  try {
    const result = await waitForAbortableOperation(
      new Promise<{ authenticated: boolean; message?: string }>((resolve, reject) => {
        const proc = spawnClaudeCli(
          resolveClaudeExecutableForSpawn(claudePath),
          ['auth', 'status', '--json'],
          {
            env: { ...augmentedPathEnv(process.env), CLAUDE_CONFIG_DIR: getUserClaudeConfigDir() },
            signal: abort.signal as AbortSignal
          }
        )

        let stdout = ''
        let stderr = ''

        proc.stdout?.on('data', (chunk) => {
          stdout += chunk.toString()
        })
        proc.stderr?.on('data', (chunk) => {
          stderr += chunk.toString()
        })

        proc.on('error', reject)
        proc.on('close', (code) => {
          if (code === 0) {
            try {
              const status = JSON.parse(stdout)
              // `claude auth status --json` outputs {"loggedIn":true,"authMethod":...}.
              // The field is `loggedIn`, not `authenticated`.
              resolve({
                authenticated: status.loggedIn === true,
                message: status.message
              })
            } catch {
              resolve({ authenticated: false, message: 'Could not parse auth status' })
            }
          } else {
            resolve({ authenticated: false, message: stderr || 'Auth status check failed' })
          }
        })
      }),
      abort.signal
    )

    return { supported: true, ...result }
  } catch (error) {
    if (abort.signal.aborted) {
      return {
        supported: true,
        authenticated: false,
        message: abort.signal.reason === 'timeout' ? 'Auth status check timed out' : 'Cancelled'
      }
    }
    return {
      supported: true,
      authenticated: false,
      message: error instanceof Error ? error.message : 'Auth status check failed'
    }
  } finally {
    clearTimeout(timeout)
  }
}

// Runs `claude auth login --claudeai` which opens the browser for OAuth login.
const runBrowserLogin = async (
  claudePath: string,
  signal: AbortSignal
): Promise<ClaudeSharedAuthStatus> => {
  try {
    const result = await waitForAbortableOperation(
      new Promise<{ success: boolean; message?: string }>((resolve, reject) => {
        const proc = spawnClaudeCli(
          resolveClaudeExecutableForSpawn(claudePath),
          ['auth', 'login', '--claudeai'],
          {
            env: (() => {
              const env: NodeJS.ProcessEnv = {
                ...augmentedPathEnv(process.env),
                CLAUDE_CONFIG_DIR: getUserClaudeConfigDir()
              }
              // Suppress flags that prevent browser OAuth from opening; same pattern as claude-isolated-auth.
              delete env.NO_BROWSER
              delete env.CI
              return env
            })(),
            signal: signal as AbortSignal
          }
        )

        let stderr = ''

        proc.stderr?.on('data', (chunk) => {
          stderr += chunk.toString()
        })

        proc.on('error', reject)
        proc.on('close', (code) => {
          if (code === 0) {
            resolve({ success: true })
          } else {
            resolve({ success: false, message: stderr || 'Browser login failed' })
          }
        })
      }),
      signal
    )

    if (result.success) {
      return { supported: true, authenticated: true }
    }
    return { supported: true, authenticated: false, message: result.message }
  } catch (error) {
    if (signal.aborted) {
      return {
        supported: true,
        authenticated: false,
        message: signal.reason === 'timeout' ? 'Browser login timed out' : 'Login cancelled',
        cancelled: signal.reason === 'user-cancel'
      }
    }
    return {
      supported: true,
      authenticated: false,
      message: error instanceof Error ? error.message : 'Browser login failed'
    }
  }
}

export class ClaudeSharedAuthController {
  private readonly _claudePath: string | (() => string | Promise<string>)
  private readonly loginTimeoutMs: number
  private readonly statusTimeoutMs: number
  private activeLogin: AbortController | undefined

  constructor(options: ClaudeSharedAuthControllerOptions) {
    this._claudePath = options.claudePath
    this.loginTimeoutMs = options.loginTimeoutMs ?? 5 * 60_000 // 5 minutes
    this.statusTimeoutMs = options.statusTimeoutMs ?? 30_000 // 30 seconds
  }

  private async resolveClaude(): Promise<string> {
    return typeof this._claudePath === 'function' ? this._claudePath() : this._claudePath
  }

  async getStatus(): Promise<ClaudeSharedAuthStatus> {
    try {
      return checkAuthStatus(await this.resolveClaude(), this.statusTimeoutMs)
    } catch (error) {
      return {
        supported: true,
        authenticated: false,
        message: error instanceof Error ? error.message : 'Could not resolve Claude path'
      }
    }
  }

  async loginShared(): Promise<ClaudeSharedAuthStatus> {
    // Re-entrancy guard: only one browser login at a time.
    if (this.activeLogin) {
      return {
        supported: true,
        authenticated: false,
        message: 'Another sign-in is already in progress'
      }
    }

    const abort = new AbortController()
    this.activeLogin = abort
    const timeout = setTimeout(() => abort.abort('timeout'), this.loginTimeoutMs)

    try {
      const claudePath = await this.resolveClaude()
      return await runBrowserLogin(claudePath, abort.signal)
    } catch (error) {
      if (abort.signal.aborted) {
        return {
          supported: true,
          authenticated: false,
          message:
            abort.signal.reason === 'timeout' ? 'Browser sign-in timed out.' : 'Sign-in cancelled.',
          cancelled: abort.signal.reason === 'user-cancel'
        }
      }
      return {
        supported: true,
        authenticated: false,
        message: error instanceof Error ? error.message : 'Could not resolve Claude path'
      }
    } finally {
      clearTimeout(timeout)
      this.activeLogin = undefined
    }
  }

  cancelLogin(): void {
    this.activeLogin?.abort('user-cancel')
  }

  async logoutShared(): Promise<ClaudeSharedAuthStatus> {
    const abort = new AbortController()
    const timeout = setTimeout(() => abort.abort('timeout'), this.statusTimeoutMs)

    try {
      const claudePath = await this.resolveClaude()
      const result = await waitForAbortableOperation(
        new Promise<{ success: boolean; message?: string }>((resolve, reject) => {
          const proc = spawnClaudeCli(
            resolveClaudeExecutableForSpawn(claudePath),
            ['auth', 'logout'],
            {
              env: {
                ...augmentedPathEnv(process.env),
                CLAUDE_CONFIG_DIR: getUserClaudeConfigDir()
              },
              signal: abort.signal as AbortSignal
            }
          )

          let stderr = ''

          proc.stderr?.on('data', (chunk) => {
            stderr += chunk.toString()
          })

          proc.on('error', reject)
          proc.on('close', (code) => {
            if (code === 0) {
              resolve({ success: true })
            } else {
              resolve({ success: false, message: stderr || 'Logout failed' })
            }
          })
        }),
        abort.signal
      )

      if (result.success) {
        return { supported: true, authenticated: false }
      }
      return { supported: true, authenticated: false, message: result.message }
    } catch (error) {
      return {
        supported: true,
        authenticated: false,
        message: error instanceof Error ? error.message : 'Logout failed'
      }
    } finally {
      clearTimeout(timeout)
    }
  }
}

export type ClaudeSharedAuthControllerPort = Pick<
  ClaudeSharedAuthController,
  'getStatus' | 'loginShared' | 'cancelLogin' | 'logoutShared'
>
