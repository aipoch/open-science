// Claude-isolated auth lifecycle. Mirrors CodexAuthController in shape (getStatus / loginIsolated /
// cancelLogin / logoutIsolated) but the credential material is a user-pasted long-lived OAuth token
// (`claude setup-token`) instead of an ACP-mediated browser sign-in. The token is encrypted at rest
// via the same provider.keyRef mechanism as other providers (encryptKey / tryDecryptKey in
// repository.ts) and is injected as `CLAUDE_CODE_OAUTH_TOKEN` at spawn time by provider-env.ts.
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
}

// Lifts a stored token's load result into the renderer-visible status. `undefined` is "no token" and
// always becomes authenticated: false; a thrown load (a malformed keyRef) becomes the dedicated
// failure message so the Settings card says something more useful than "spawn failed".
const statusFromLoad = (
  loadResult: { token?: string; error?: string }
): ClaudeIsolatedAuthStatus => {
  if (loadResult.token) return { supported: true, authenticated: true }
  if (loadResult.error) {
    return { supported: true, authenticated: false, message: loadResult.error }
  }
  return { supported: true, authenticated: false }
}

// The single long-lived-OAuth-token auth flow. Storage is delegated to the host so the controller
// stays pure and unit-testable (mirroring how CodexAuthController takes openSession).
export class ClaudeIsolatedAuthController {
  private readonly store: ClaudeIsolatedTokenStore

  constructor(options: ClaudeIsolatedAuthControllerOptions) {
    this.store = options.store
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

  // Persists a freshly-pasted setup-token. The token itself is opaque to Open Science — Claude Code
  // validates it on first use — so the only validation done here is "non-empty / trimmed". A missing
  // token is the only failure mode (encryption/credential-store problems bubble up from saveToken).
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
        message:
          error instanceof Error
            ? error.message
            : 'Could not save the Claude token.'
      }
    }

    return { supported: true, authenticated: true }
  }

  // loginIsolated has no browser flow to cancel (the paste is one-shot), but the same name keeps the
  // controller's port symmetric with CodexAuthController — both expose it so the renderer can wire
  // one "Cancel sign-in" affordance per provider without branching on the provider type.
  cancelLogin(): void {
    // no-op: paste-based login has no in-flight work to abandon.
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
        message:
          error instanceof Error
            ? error.message
            : 'Could not clear the stored Claude token.'
      }
    }

    return { supported: true, authenticated: false }
  }
}

// The renderer-visible port the service exposes; keeping the same name as CodexAuthControllerPort
// lets the onboarding/settings UI branch on provider type without learning a second vocabulary.
export type ClaudeIsolatedAuthControllerPort = Pick<
  ClaudeIsolatedAuthController,
  'getStatus' | 'loginIsolated' | 'cancelLogin' | 'logoutIsolated'
>