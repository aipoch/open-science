import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

// GUI apps (launched from Finder or electron-vite dev) start without a login shell, so their PATH
// often omits the directories where node/npm and user-installed CLIs live. Augmenting PATH with these
// common locations keeps npm detection and one-click installs from spuriously failing with
// "npm not found" on machines where npm is present but not on the inherited PATH.
const EXTRA_PATH_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin')]

// Returns a copy of `env` whose PATH is the user's PATH followed by the well-known dirs (appended, so
// the user's own resolution order still wins) with duplicates removed.
const augmentedPathEnv = (env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const existing = (env.PATH ?? '').split(delimiter).filter((dir) => dir.length > 0)
  const merged = Array.from(new Set([...existing, ...EXTRA_PATH_DIRS]))

  return { ...env, PATH: merged.join(delimiter) }
}

export { EXTRA_PATH_DIRS, augmentedPathEnv }
