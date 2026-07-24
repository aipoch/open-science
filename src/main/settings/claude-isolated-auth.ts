import { spawn, type SpawnOptions } from 'node:child_process'

import { resolveClaudeExecutableForSpawn } from '../acp/claude-executable'
import { augmentedPathEnv } from './shell-path'

// On Windows, resolveClaudeExecutableForSpawn converts claude.cmd to its underlying cli.js entry.
// child_process.spawn cannot run .js files directly; use process.execPath (Electron as Node).
const spawnClaude = (
  resolvedPath: string,
  args: string[],
  options: SpawnOptions
): ReturnType<typeof spawn> => {
  if (/\.(js|mjs)$/i.test(resolvedPath)) {
    // Electron acts as a Node runtime only when ELECTRON_RUN_AS_NODE=1 is set.
    const env = { ...(options.env as NodeJS.ProcessEnv), ELECTRON_RUN_AS_NODE: '1' }
    return spawn(process.execPath, [resolvedPath, ...args], { ...options, env })
  }
  return spawn(resolvedPath, args, options)
}

// Claude-isolated auth lifecycle. Mirrors CodexAuthController in shape (getStatus / loginIsolated /
// cancelLogin / logoutIsolated). The credential material is a long-lived OAuth token minted by
// `claude setup-token`, obtained one of two ways:
//   - loginIsolatedBrowser(): the app runs `claude setup-token` under the isolated CLAUDE_CONFIG_DIR,
//     which opens the browser for OAuth and prints the token to stdout; the app captures and stores
//     it — no manual copy/paste (mirrors the codex-isolated browser sign-in).
//   - loginIsolated(token): the user pastes a token they minted themselves (kept as a fallback).
// Either way the token is encrypted at rest via the same provider.keyRef mechanism as other providers
// (encryptKey / tryDecryptKey in repository.ts) and is injected as the bearer at spawn time by
// provider-env.ts.
//
// The controller never touches ~/.claude or the OS credential store: the app-owned CLAUDE_CONFIG_DIR
// plus the bearer token give Claude Code everything it needs, on every platform.

export type ClaudeIsolatedAuthStatus = {
  // Mirrors CodexAuthStatus shape so the IPC/service/UI plumbing stays identical between the two
  // subscription providers. `supported` is always true here (no ACP capability to probe), so it
  // exists only for parity with the codex status field the renderer already knows how to render.
  supported: boolean
  authenticated: boolean
  message?: string
  // Set when the user explicitly cancelled the browser sign-in (not a timeout or error). The service
  // uses this to suppress writing a lastValidationFailure so the card does not show a spurious warning.
  cancelled?: boolean
}

// The minimum surface the controller needs from its host: where to read/write the encrypted token,
// and whether encryption is available (so a missing keychain can be surfaced as a clear error
// instead of a silent failure on save).
export type ClaudeIsolatedTokenStore = {
  // Returns the decrypted token when one is stored, undefined when none. Must NOT throw on a missing
  // token (a fresh install has nothing stored); it MAY throw when the stored ciphertext is malformed,
  // and the controller surfaces that as the controller-level failure the UI can render.
  loadToken: () => Promise<string | undefined>
  // Persists the encrypted token. The host is expected to use the same encryptKey() pipeline as the
  // rest of the app so secrets stay under the OS keychain.
  saveToken: (token: string) => Promise<void>
  // Drops the encrypted token so the next read returns undefined.
  clearToken: () => Promise<void>
  // Whether safeStorage is usable on this machine. Required to encrypt anything; reported as a
  // dedicated status message so the Settings UI can surface "unlock the keychain" rather than the
  // opaque storage failure.
  isEncryptionAvailable: () => boolean
}

export type ClaudeIsolatedAuthControllerOptions = {
  store: ClaudeIsolatedTokenStore
  // Absolute path or resolver for the `claude` executable used by the browser sign-in to run
  // `claude setup-token`. Optional so paste-only callers can omit it; the browser flow reports a
  // clear "not configured" error when absent.
  claudePath?: string | (() => string | Promise<string>)
  // The app-owned CLAUDE_CONFIG_DIR the browser sign-in runs `claude setup-token` under, so the OAuth
  // lands in isolated storage instead of ~/.claude. Optional for the same reason as claudePath.
  configDir?: string
  // Bounds the browser sign-in (opens a browser + waits for the human). Defaults to 5 minutes.
  loginTimeoutMs?: number
}

// Lifts a stored token's load result into the renderer-visible status. `undefined` is "no token" and
// always becomes authenticated: false; a thrown load (a malformed keyRef) becomes the dedicated
// failure message so the Settings card says something more useful than "spawn failed".
const statusFromLoad = (loadResult: {
  token?: string
  error?: string
}): ClaudeIsolatedAuthStatus => {
  if (loadResult.token) return { supported: true, authenticated: true }
  if (loadResult.error) {
    return { supported: true, authenticated: false, message: loadResult.error }
  }
  return { supported: true, authenticated: false }
}

// `claude setup-token` prints human-readable lines around the token; the token itself is a single
// `sk-ant-...` bearer. Scan the captured output for that shape rather than assuming the token is the
// only thing printed, so surrounding banner/hint lines don't get folded into the credential.
const extractSetupToken = (output: string): string | undefined => {
  const match = output.match(/sk-ant-[A-Za-z0-9_-]+/)
  return match?.[0]
}

const abortError = (message: string): Error => {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

const waitForAbort = (signal: AbortSignal): Promise<never> =>
  new Promise((_, reject) => {
    if (signal.aborted) reject(abortError(String(signal.reason ?? 'aborted')))
    signal.addEventListener('abort', () => reject(abortError(String(signal.reason ?? 'aborted'))))
  })

const waitForOperation = <Value>(operation: Promise<Value>, signal: AbortSignal): Promise<Value> =>
  Promise.race([operation, waitForAbort(signal)])

// Runs `claude setup-token` under the isolated CLAUDE_CONFIG_DIR. The CLI opens the browser for OAuth
// and, on success, prints the long-lived token to stdout. We capture stdout, extract the token, and
// return it for the controller to persist. Failure (non-zero exit, no token in output) surfaces the
// stderr text so the Settings card shows something actionable.
const runSetupTokenLogin = async (
  claudePath: string,
  configDir: string,
  signal: AbortSignal
): Promise<{ token?: string; message?: string }> =>
  waitForOperation(
    new Promise<{ token?: string; message?: string }>((resolve, reject) => {
      // This flow's whole point is to pop the browser, so strip any inherited signals that could tell
      // the CLI to suppress it (NO_BROWSER from a codex spawn context, CI from a headless launcher).
      // Without the browser there is no fallback URL on stdout, so the login would hang to timeout.
      const env: NodeJS.ProcessEnv = {
        ...augmentedPathEnv(process.env),
        CLAUDE_CONFIG_DIR: configDir
      }
      delete env.NO_BROWSER
      delete env.CI

      const proc = spawnClaude(resolveClaudeExecutableForSpawn(claudePath), ['setup-token'], {
        env,
        signal: signal as AbortSignal
      })

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
        const token = extractSetupToken(stdout)
        if (code === 0 && token) {
          resolve({ token })
        } else if (token) {
          // Some CLI builds print the token then exit non-zero on a follow-up step; if we got a token
          // we still treat it as a success candidate (the service re-probes before marking verified).
          resolve({ token })
        } else {
          resolve({ message: stderr.trim() || `setup-token exited with code ${code}` })
        }
      })
    }),
    signal
  )

// The single long-lived-OAuth-token auth flow. Storage is delegated to the host so the controller
// stays pure and unit-testable (mirroring how CodexAuthController takes openSession).
export class ClaudeIsolatedAuthController {
  private readonly store: ClaudeIsolatedTokenStore
  private readonly _claudePath?: string | (() => string | Promise<string>)
  private readonly configDir?: string
  private readonly loginTimeoutMs: number
  private activeLogin: AbortController | undefined

  constructor(options: ClaudeIsolatedAuthControllerOptions) {
    this.store = options.store
    this._claudePath = options.claudePath
    this.configDir = options.configDir
    this.loginTimeoutMs = options.loginTimeoutMs ?? 5 * 60_000 // 5 minutes
  }

  private async resolveClaude(): Promise<string | undefined> {
    if (!this._claudePath) return undefined
    return typeof this._claudePath === 'function' ? this._claudePath() : this._claudePath
  }

  // Read-only status check: a stored, decryptable token means authenticated; nothing stored or a
  // malformed ref means signed out. Mirrors CodexAuthController.getStatus in shape (no I/O beyond
  // the token load), so the renderer can render one row for both subscription providers.
  async getStatus(): Promise<ClaudeIsolatedAuthStatus> {
    try {
      const token = await this.store.loadToken()

      return statusFromLoad({ token })
    } catch (error) {
      return {
        supported: true,
        authenticated: false,
        message: error instanceof Error ? error.message : 'Stored Claude token could not be read.'
      }
    }
  }

  // Browser sign-in: runs `claude setup-token` under the isolated config dir, which opens the browser
  // for OAuth and prints the long-lived token on success. We capture the token and persist it via the
  // same store the paste flow uses, so the rest of the pipeline (probe, verified markers) is identical.
  // Re-entrancy is guarded so a double-click can't spawn two logins racing for the same config dir.
  async loginIsolatedBrowser(): Promise<ClaudeIsolatedAuthStatus> {
    // Fast synchronous guards — evaluated before any await so the re-entrancy check and capability
    // checks are not races.
    if (!this._claudePath || !this.configDir) {
      return {
        supported: true,
        authenticated: false,
        message: 'Browser sign-in is unavailable: the Claude executable was not found.'
      }
    }

    if (!this.store.isEncryptionAvailable()) {
      return {
        supported: true,
        authenticated: false,
        message: 'Secure credential storage is unavailable. Unlock the system keychain and retry.'
      }
    }

    if (this.activeLogin) {
      return {
        supported: true,
        authenticated: false,
        message: 'Another sign-in is already in progress.'
      }
    }

    // Claim the in-progress slot synchronously (before any await) so cancelLogin() can abort it
    // immediately if called right after loginIsolatedBrowser() — same pattern as loginShared().
    const abort = new AbortController()
    this.activeLogin = abort
    const timeout = setTimeout(() => abort.abort('timeout'), this.loginTimeoutMs)

    try {
      // Resolve path inside the try block so an abort that races the resolution is still caught.
      const claudePath = await this.resolveClaude()
      if (!claudePath) {
        return {
          supported: true,
          authenticated: false,
          message: 'Browser sign-in is unavailable: the Claude executable was not found.'
        }
      }

      const result = await runSetupTokenLogin(claudePath, this.configDir, abort.signal)

      if (!result.token) {
        return {
          supported: true,
          authenticated: false,
          message:
            result.message ??
            'Browser sign-in did not return a token. If your browser did not open, use "Use setup token" instead.'
        }
      }

      // Reuse the paste path's persistence + roundtrip verification so both flows converge on the same
      // stored-and-verified state.
      return await this.loginIsolated(result.token)
    } catch (error) {
      if (abort.signal.aborted) {
        return {
          supported: true,
          authenticated: false,
          message:
            abort.signal.reason === 'timeout'
              ? 'Browser sign-in timed out. If your browser did not open, use "Use setup token" instead.'
              : 'Sign-in cancelled.',
            cancelled: abort.signal.reason === 'user-cancel'
        }
      }
      return {
        supported: true,
        authenticated: false,
        message: error instanceof Error ? error.message : 'Browser sign-in failed.'
      }
    } finally {
      clearTimeout(timeout)
      this.activeLogin = undefined
    }
  }

  // Persists a freshly-pasted setup-token. The controller proves only that encrypted storage
  // roundtrips; the SettingsService subsequently runs Claude with the token before reporting the
  // provider as verified.
  async loginIsolated(token: string): Promise<ClaudeIsolatedAuthStatus> {
    const trimmed = token.trim()

    if (!trimmed) {
      return {
        supported: true,
        authenticated: false,
        message: 'Paste the token printed by `claude setup-token`.'
      }
    }

    if (!this.store.isEncryptionAvailable()) {
      return {
        supported: true,
        authenticated: false,
        message: 'Secure credential storage is unavailable. Unlock the system keychain and retry.'
      }
    }

    try {
      await this.store.saveToken(trimmed)
    } catch (error) {
      return {
        supported: true,
        authenticated: false,
        message: error instanceof Error ? error.message : 'Could not save the Claude token.'
      }
    }

    // Re-read after save so corrupted ciphertext or a failed write surfaces before the service runs
    // the external credential probe.
    try {
      const reloaded = await this.store.loadToken()

      if (reloaded === undefined) {
        return {
          supported: true,
          authenticated: false,
          message: 'Saved token could not be re-read. Retry the paste.'
        }
      }
      if (reloaded !== trimmed) {
        return {
          supported: true,
          authenticated: false,
          message: 'Saved token did not roundtrip cleanly. Retry the paste.'
        }
      }
    } catch (error) {
      return {
        supported: true,
        authenticated: false,
        message: error instanceof Error ? error.message : 'Stored token could not be re-read.'
      }
    }

    return { supported: true, authenticated: true }
  }

  // Aborts an in-flight browser sign-in (the `claude setup-token` subprocess). The paste flow has no
  // in-flight work, so this is a no-op there; the shared name keeps the controller's port symmetric
  // with CodexAuthController so the renderer wires one "Cancel sign-in" affordance per provider.
  cancelLogin(): void {
    this.activeLogin?.abort('user-cancel')
  }

  // Drops the stored token so the next getStatus reports authenticated: false. Errors surface as a
  // timeout-style message rather than a generic throw so the Settings sign-out never wedges the UI
  // on a transient store failure.
  async logoutIsolated(): Promise<ClaudeIsolatedAuthStatus> {
    try {
      await this.store.clearToken()
    } catch (error) {
      return {
        supported: true,
        authenticated: false,
        message: error instanceof Error ? error.message : 'Could not clear the stored Claude token.'
      }
    }

    return { supported: true, authenticated: false }
  }
}

// The renderer-visible port the service exposes; keeping the same name as CodexAuthControllerPort
// lets the onboarding/settings UI branch on provider type without learning a second vocabulary.
export type ClaudeIsolatedAuthControllerPort = Pick<
  ClaudeIsolatedAuthController,
  'getStatus' | 'loginIsolatedBrowser' | 'loginIsolated' | 'cancelLogin' | 'logoutIsolated'
>
