import { access, copyFile, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Resolves credentials for the "local" provider — reusing the machine's own Claude login while running
// under the app-owned config dir. Two auth shapes are supported:
//   - a token in ~/.claude/settings.json `env` (ANTHROPIC_AUTH_TOKEN [+ ANTHROPIC_BASE_URL]) → returned
//     as spawn-env overrides for this run (read live, never duplicated into our own settings), and
//   - an OAuth login (~/.claude/.credentials.json) → copied into the app config dir so claude can use it.
//
// This runs only when the local provider is active; custom providers inject their own endpoint/token, so
// the app dir's settings.json stays free of an `env` block and their endpoint always wins.

export type LocalClaudeAuthEnv = {
  ANTHROPIC_BASE_URL?: string
  ANTHROPIC_AUTH_TOKEN?: string
}

export type LocalClaudeAuthResolution = {
  envOverrides: LocalClaudeAuthEnv
  // Recent Claude Code builds can keep OAuth only in the OS credential store. That login is scoped to
  // Claude's implicit default config context and becomes invisible as soon as CLAUDE_CONFIG_DIR is set,
  // even when it points at ~/.claude. In that case the caller must omit CLAUDE_CONFIG_DIR entirely.
  useDefaultConfigDir: boolean
}

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

// Reads the ANTHROPIC_* token/base URL out of the user's ~/.claude/settings.json `env` block, if any.
const readUserClaudeEnv = async (
  userClaudeDir: string
): Promise<{ token?: string; baseUrl?: string }> => {
  try {
    const raw = await readFile(join(userClaudeDir, 'settings.json'), 'utf8')
    const parsed = JSON.parse(raw) as { env?: Record<string, unknown> }
    const env = parsed.env

    if (env && typeof env === 'object') {
      const token =
        typeof env.ANTHROPIC_AUTH_TOKEN === 'string' ? env.ANTHROPIC_AUTH_TOKEN : undefined
      const baseUrl =
        typeof env.ANTHROPIC_BASE_URL === 'string' ? env.ANTHROPIC_BASE_URL : undefined
      return { token, baseUrl }
    }
  } catch {
    // Missing/unreadable settings.json → no env-block auth.
  }

  return {}
}

export type ResolveLocalClaudeAuthOptions = {
  userClaudeDir: string
  appConfigDir: string
}

// Resolves how the local provider should reuse the machine login. Portable auth stays in the app-owned
// config context; OS-credential-store auth falls back to Claude's implicit default config context.
const resolveLocalClaudeAuth = async ({
  userClaudeDir,
  appConfigDir
}: ResolveLocalClaudeAuthOptions): Promise<LocalClaudeAuthResolution> => {
  const { token, baseUrl } = await readUserClaudeEnv(userClaudeDir)

  if (token) {
    const env: LocalClaudeAuthEnv = { ANTHROPIC_AUTH_TOKEN: token }
    if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl
    return { envOverrides: env, useDefaultConfigDir: false }
  }

  // No token → reuse the OAuth login by copying its credentials into the app config dir. claude only
  // consults these when no token is injected (i.e. when local is the active provider).
  const credentialsSource = join(userClaudeDir, '.credentials.json')

  if (await fileExists(credentialsSource)) {
    try {
      await copyFile(credentialsSource, join(appConfigDir, '.credentials.json'))
      return { envOverrides: {}, useDefaultConfigDir: false }
    } catch {
      // Fall through to the default config context, where Claude can still read its native auth store.
    }
  }

  // No portable token/file usually means OAuth lives in Keychain/Credential Manager/libsecret. Do not
  // copy or expose that secret; let Claude access it through its normal, implicit config context.
  return { envOverrides: {}, useDefaultConfigDir: true }
}

// Applies the resolution to a provider env. Deleting (rather than rewriting) CLAUDE_CONFIG_DIR is
// intentional: current Claude Code treats any explicit value as a separate auth context.
const applyLocalClaudeAuth = async (
  providerEnv: Record<string, string>,
  options: ResolveLocalClaudeAuthOptions
): Promise<Record<string, string>> => {
  const resolution = await resolveLocalClaudeAuth(options)
  const env: Record<string, string> = { ...providerEnv, ...resolution.envOverrides }

  if (resolution.useDefaultConfigDir) {
    delete env.CLAUDE_CONFIG_DIR
  }

  return env
}

// The machine's own Claude config dir.
const defaultUserClaudeDir = (): string => join(homedir(), '.claude')

export { applyLocalClaudeAuth, defaultUserClaudeDir, resolveLocalClaudeAuth }
