import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { augmentedPathEnv } from './shell-path'

const execFileAsync = promisify(execFile)

export type CursorDetectResult = {
  resolvedPath: string
  version?: string
  // True when `agent status` reports an authenticated Cursor login.
  loggedIn?: boolean
}

// Detects a runnable Cursor Agent CLI (`agent` / `cursor-agent`) across PATH and well-known install
// locations a GUI app might miss. Injectable deps keep probe order and platform rules unit-testable,
// mirroring opencode-detect.ts.
export type CursorDetectDeps = {
  env: NodeJS.ProcessEnv
  homePath: string
  platform: NodeJS.Platform
  isExecutable: (path: string) => Promise<boolean>
  getVersion: (path: string) => Promise<string | undefined>
  getLoginStatus: (path: string) => Promise<boolean | undefined>
}

const pathFor = (platform: NodeJS.Platform): path.PlatformPath =>
  platform === 'win32' ? path.win32 : path.posix

// Candidate binary filenames. Windows resolves through PATHEXT, so probe `.cmd`/`.exe`/`.bat`
// explicitly; Unix has the bare names. Prefer `agent` (the ACP entry documented by Cursor) over the
// `cursor-agent` alias.
const cursorBinaryNames = (platform: NodeJS.Platform): string[] =>
  platform === 'win32'
    ? ['agent.cmd', 'agent.exe', 'cursor-agent.cmd', 'cursor-agent.exe', 'agent.bat', 'agent']
    : ['agent', 'cursor-agent']

const wellKnownDirs = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] => {
  const p = pathFor(platform)

  if (platform === 'win32') {
    const dirs: string[] = []
    if (env.LOCALAPPDATA) dirs.push(p.join(env.LOCALAPPDATA, 'cursor-agent'))
    if (env.APPDATA) dirs.push(p.join(env.APPDATA, 'npm'))
    return dirs
  }

  return ['/opt/homebrew/bin', '/usr/local/bin']
}

const collectCandidateDirs = async (deps: CursorDetectDeps): Promise<string[]> => {
  const p = pathFor(deps.platform)
  const pathDirs = (deps.env.PATH ?? '').split(p.delimiter).filter((dir) => dir.length > 0)

  return Array.from(
    new Set([
      ...pathDirs,
      p.join(deps.homePath, '.local', 'bin'),
      ...wellKnownDirs(deps.platform, deps.env)
    ])
  )
}

const detectCursor = async (
  deps: CursorDetectDeps = createDefaultDetectDeps()
): Promise<CursorDetectResult | undefined> => {
  const p = pathFor(deps.platform)
  const candidateDirs = await collectCandidateDirs(deps)
  const binaryNames = cursorBinaryNames(deps.platform)

  for (const dir of candidateDirs) {
    for (const name of binaryNames) {
      const candidate = p.join(dir, name)

      if (!(await deps.isExecutable(candidate))) continue

      const version = await deps.getVersion(candidate)
      if (version === undefined) continue

      const loggedIn = await deps.getLoginStatus(candidate)

      return {
        resolvedPath: candidate,
        version,
        ...(loggedIn !== undefined ? { loggedIn } : {})
      }
    }
  }

  return undefined
}

const isExecutableFile =
  (platform: NodeJS.Platform) =>
  async (filePath: string): Promise<boolean> => {
    try {
      await access(filePath, platform === 'win32' ? constants.F_OK : constants.X_OK)
      return true
    } catch {
      return false
    }
  }

// Cursor prints a date-style version such as `2026.07.23-e383d2b`. Accept the first non-empty line.
const parseVersion = (output: string): string | undefined => {
  const line = output
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0)

  return line || undefined
}

const runWithShellIfNeeded = async (
  platform: NodeJS.Platform,
  filePath: string,
  args: string[]
): Promise<string> => {
  const needsShell = platform === 'win32' && /\.(cmd|bat)$/i.test(filePath)
  const { stdout } = needsShell
    ? await execFileAsync(`"${filePath}"`, args, {
        timeout: 10_000,
        shell: true,
        windowsHide: true,
        env: augmentedPathEnv(process.env)
      })
    : await execFileAsync(filePath, args, {
        timeout: 10_000,
        windowsHide: true,
        env: augmentedPathEnv(process.env)
      })

  return stdout
}

const runCursorVersion =
  (platform: NodeJS.Platform) =>
  async (filePath: string): Promise<string | undefined> => {
    try {
      return parseVersion(await runWithShellIfNeeded(platform, filePath, ['--version']))
    } catch {
      return undefined
    }
  }

// `agent status` prints a checkmark line containing "Logged in" when authenticated.
const runCursorLoginStatus =
  (platform: NodeJS.Platform) =>
  async (filePath: string): Promise<boolean | undefined> => {
    try {
      const stdout = await runWithShellIfNeeded(platform, filePath, ['status'])
      if (/logged in/i.test(stdout)) return true
      if (/not logged in|log in|unauthor/i.test(stdout)) return false
      return undefined
    } catch {
      return undefined
    }
  }

const createDefaultDetectDeps = (): CursorDetectDeps => {
  const platform = process.platform

  return {
    env: process.env,
    homePath: homedir(),
    platform,
    isExecutable: isExecutableFile(platform),
    getVersion: runCursorVersion(platform),
    getLoginStatus: runCursorLoginStatus(platform)
  }
}

export { collectCandidateDirs, createDefaultDetectDeps, detectCursor, parseVersion }
