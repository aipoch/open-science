import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { augmentedPathEnv } from './shell-path'

const execFileAsync = promisify(execFile)

// Best-effort PATH lookup for the opencode binary. Returns the resolved absolute path, or undefined
// when it isn't installed / not on PATH. Uses the augmented PATH so a Finder-launched packaged app
// (whose PATH omits Homebrew/user bins) can still find a user-installed opencode.
export const detectOpencode = async (): Promise<string | undefined> => {
  const lookup = process.platform === 'win32' ? 'where' : 'which'

  try {
    const { stdout } = await execFileAsync(lookup, ['opencode'], {
      env: augmentedPathEnv(process.env),
      windowsHide: true
    })

    return (
      stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) ?? undefined
    )
  } catch {
    return undefined
  }
}
