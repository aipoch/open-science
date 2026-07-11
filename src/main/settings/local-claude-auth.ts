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

// Returns spawn-env overrides for the local provider, copying OAuth credentials into the app dir when
// there is no token to inject. Best-effort: any failure yields no overrides rather than throwing.
const resolveLocalClaudeAuth = async ({
  userClaudeDir,
  appConfigDir
}: ResolveLocalClaudeAuthOptions): Promise<LocalClaudeAuthEnv> => {
  const { token, baseUrl } = await readUserClaudeEnv(userClaudeDir)

  if (token) {
    const env: LocalClaudeAuthEnv = { ANTHROPIC_AUTH_TOKEN: token }
    if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl
    return env
  }

  // No token → reuse the OAuth login by copying its credentials into the app config dir. claude only
  // consults these when no token is injected (i.e. when local is the active provider).
  const credentialsSource = join(userClaudeDir, '.credentials.json')

  if (await fileExists(credentialsSource)) {
    try {
      await copyFile(credentialsSource, join(appConfigDir, '.credentials.json'))
    } catch {
      // A failed copy just means local login isn't available; surface nothing here.
    }
  }

  return {}
}

// The machine's own Claude config dir.
const defaultUserClaudeDir = (): string => join(homedir(), '.claude')

export { defaultUserClaudeDir, resolveLocalClaudeAuth }
