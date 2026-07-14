import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { ClaudeDetectResult } from '../../shared/settings'
import { augmentedPathEnv } from './shell-path'

const execFileAsync = promisify(execFile)

// Detects a runnable claude executable across the locations a GUI app might miss because its PATH
// differs from the user's login shell. Injectable deps (including the host platform) keep the probe
// order and platform-specific rules unit-testable.

export type ClaudeDetectDeps = {
  // Environment used to read PATH; injected so tests can drive candidate discovery.
  env: NodeJS.ProcessEnv
  // Home directory for the ~/.local/bin fallback.
  homePath: string
  // Host platform. Selects candidate filenames, well-known dirs, and the executability check.
  platform: NodeJS.Platform
  // Resolves whether a candidate file exists and is executable.
  isExecutable: (path: string) => Promise<boolean>
  // Runs `<path> --version` and returns the trimmed version string, or undefined on failure.
  getVersion: (path: string) => Promise<string | undefined>
  // Extra bin directories to probe (e.g. `npm prefix -g`); resolved lazily and tolerant of failure.
  resolveNpmBinDirs: () => Promise<string[]>
  // Extra fixed directories to probe (e.g. the app-managed install dir), searched after PATH/home.
  extraDirs?: string[]
}

// Path semantics follow the injected platform, not the host running the code. Production wires
// deps.platform to process.platform (so this is a no-op there), but pinning it lets the unit tests
// exercise the win32 rules deterministically on a posix CI runner and vice versa.
const pathFor = (platform: NodeJS.Platform): path.PlatformPath =>
  platform === 'win32' ? path.win32 : path.posix

// Candidate binary filenames for claude, in probe order. Windows resolves a bare command through
// PATHEXT, so an npm-installed `claude.cmd`, a native `claude.exe`, or a `.bat` shim must each be
// tried explicitly; the extensionless name is kept last as a catch-all. Unix has only `claude`.
const claudeBinaryNames = (platform: NodeJS.Platform): string[] =>
  platform === 'win32' ? ['claude.cmd', 'claude.exe', 'claude.bat', 'claude'] : ['claude']

// Common non-PATH install locations by platform. Unix: Homebrew + /usr/local. Windows: npm's global
// bin (%APPDATA%\npm) and the native installer's Programs dir. `~/.local/bin` (the install script's
// target on every OS) is added separately by collectCandidateDirs.
const wellKnownDirs = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] => {
  if (platform === 'win32') {
    const p = pathFor(platform)
    const dirs: string[] = []

    if (env.APPDATA) dirs.push(p.join(env.APPDATA, 'npm'))
    if (env.LOCALAPPDATA) dirs.push(p.join(env.LOCALAPPDATA, 'Programs', 'claude'))

    return dirs
  }

  return ['/opt/homebrew/bin', '/usr/local/bin']
}

// Builds the ordered list of directories to search for the claude binary.
const collectCandidateDirs = async (deps: ClaudeDetectDeps): Promise<string[]> => {
  const p = pathFor(deps.platform)
  const pathDirs = (deps.env.PATH ?? '').split(p.delimiter).filter((dir) => dir.length > 0)
  const npmBinDirs = await deps.resolveNpmBinDirs().catch(() => [])
  const localBin = p.join(deps.homePath, '.local', 'bin')

  // De-duplicate while preserving first-seen order so the first real hit wins.
  return Array.from(
    new Set([
      ...pathDirs,
      localBin,
      ...(deps.extraDirs ?? []),
      ...wellKnownDirs(deps.platform, deps.env),
      ...npmBinDirs
    ])
  )
}

// Probes each candidate directory × filename, returning the first executable whose `--version`
// succeeds.
const detectClaude = async (
  deps: ClaudeDetectDeps = createDefaultDetectDeps()
): Promise<ClaudeDetectResult> => {
  const p = pathFor(deps.platform)
  const candidateDirs = await collectCandidateDirs(deps)
  const binaryNames = claudeBinaryNames(deps.platform)

  for (const dir of candidateDirs) {
    for (const name of binaryNames) {
      const candidate = p.join(dir, name)

      if (!(await deps.isExecutable(candidate))) continue

      const version = await deps.getVersion(candidate)

      // A path that exists but cannot report a version is not a usable claude; keep searching.
      if (version === undefined) continue

      return { found: true, path: candidate, version }
    }
  }

  return { found: false }
}

// Real filesystem executable check. On Windows the POSIX execute bit is meaningless — access(X_OK)
// returns true for essentially any readable file — so existence plus a known executable extension
// (already encoded in the candidate filenames) is the reliable signal; elsewhere require X_OK.
const isExecutableFile =
  (platform: NodeJS.Platform) =>
  async (path: string): Promise<boolean> => {
    try {
      await access(path, platform === 'win32' ? constants.F_OK : constants.X_OK)

      return true
    } catch {
      return false
    }
  }

// Parses the first version-looking token out of `claude --version` output.
const parseVersion = (output: string): string | undefined => {
  const match = output.match(/\d+\.\d+\.[\w.-]+/)

  return match ? match[0] : output.trim() || undefined
}

// Real `<path> --version` runner. On Windows a `.cmd`/`.bat` shim cannot be launched by execFile
// directly (Node refuses to run batch files without a shell since v18.20/20.12), so route it through
// the shell with the path quoted to survive spaces; native `.exe`/Unix binaries run without a shell.
const runClaudeVersion =
  (platform: NodeJS.Platform) =>
  async (path: string): Promise<string | undefined> => {
    try {
      const { stdout } =
        platform === 'win32'
          ? await execFileAsync(`"${path}"`, ['--version'], {
              timeout: 10_000,
              shell: true,
              windowsHide: true
            })
          : await execFileAsync(path, ['--version'], { timeout: 10_000 })

      return parseVersion(stdout)
    } catch {
      return undefined
    }
  }

// Resolves the npm global bin directory if npm is present. PATH is augmented with common node
// locations so a GUI-launched app can still locate npm. On Windows npm is a `.cmd` shim (needs a
// shell) and places global binaries directly in the prefix; Unix nests them under `<prefix>/bin`.
const resolveNpmBinDirs = (platform: NodeJS.Platform) => async (): Promise<string[]> => {
  try {
    const { stdout } =
      platform === 'win32'
        ? await execFileAsync('npm', ['prefix', '-g'], {
            timeout: 10_000,
            shell: true,
            windowsHide: true,
            env: augmentedPathEnv()
          })
        : await execFileAsync('npm', ['prefix', '-g'], {
            timeout: 10_000,
            env: augmentedPathEnv()
          })
    const prefix = stdout.trim()

    if (!prefix) return []

    return platform === 'win32' ? [prefix] : [pathFor(platform).join(prefix, 'bin')]
  } catch {
    return []
  }
}

// Production dependency bundle wired to real fs/child_process for the current host platform.
const createDefaultDetectDeps = (): ClaudeDetectDeps => {
  const platform = process.platform

  return {
    env: process.env,
    homePath: homedir(),
    platform,
    isExecutable: isExecutableFile(platform),
    getVersion: runClaudeVersion(platform),
    resolveNpmBinDirs: resolveNpmBinDirs(platform)
  }
}

export { collectCandidateDirs, createDefaultDetectDeps, detectClaude, parseVersion }
