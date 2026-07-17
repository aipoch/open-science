import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { augmentedPathEnv } from './shell-path'

const execFileAsync = promisify(execFile)

// Resolves opencode's global config path ($XDG_CONFIG_HOME/opencode or ~/.config/opencode).
const opencodeUserConfigPath = (): string =>
  join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode', 'opencode.json')

// Reads the user's own opencode config so the app can MERGE its provider/model onto it rather than
// replacing it. Best-effort: returns undefined when the file is absent or unreadable. opencode's
// auth.json (from `opencode auth login`) is loaded by opencode itself and is never read or touched.
export const readOpencodeUserConfig = async (): Promise<Record<string, unknown> | undefined> => {
  try {
    const parsed = JSON.parse(await readFile(opencodeUserConfigPath(), 'utf8')) as unknown

    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

export type OpencodeDetectResult = {
  resolvedPath: string
  version?: string
}

// Reads the opencode binary's reported version (`opencode --version`). Best-effort with a short
// timeout so a hung binary can't stall detection; undefined when it can't be read.
const readOpencodeVersion = async (executablePath: string): Promise<string | undefined> => {
  try {
    const { stdout } = await execFileAsync(executablePath, ['--version'], {
      env: augmentedPathEnv(process.env),
      windowsHide: true,
      timeout: 5000
    })

    // opencode prints just the version (e.g. "1.18.3"); take the first non-empty token.
    return stdout.trim().split(/\s+/)[0] || undefined
  } catch {
    return undefined
  }
}

// Best-effort PATH lookup for the opencode binary + its version. Returns undefined when it isn't
// installed / not on PATH. Uses the augmented PATH so a Finder-launched packaged app (whose PATH omits
// Homebrew/user bins) can still find a user-installed opencode.
export const detectOpencode = async (): Promise<OpencodeDetectResult | undefined> => {
  const lookup = process.platform === 'win32' ? 'where' : 'which'

  try {
    const { stdout } = await execFileAsync(lookup, ['opencode'], {
      env: augmentedPathEnv(process.env),
      windowsHide: true
    })

    const resolvedPath = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean)

    if (!resolvedPath) return undefined

    return { resolvedPath, version: await readOpencodeVersion(resolvedPath) }
  } catch {
    return undefined
  }
}
