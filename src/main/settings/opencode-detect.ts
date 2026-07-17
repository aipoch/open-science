import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { augmentedPathEnv } from './shell-path'

const execFileAsync = promisify(execFile)

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
