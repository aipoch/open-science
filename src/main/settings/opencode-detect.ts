import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { augmentedPathEnv } from './shell-path'

const execFileAsync = promisify(execFile)

export type OpencodeDetectResult = {
  resolvedPath: string
  version?: string
}

// Detects a runnable opencode executable across the locations a GUI app might miss because its PATH
// differs from the user's login shell — including the app-managed install dir, which a bare PATH
// lookup would never find. Injectable deps (including the host platform) keep the probe order and
// platform-specific rules unit-testable, mirroring claude-detect.ts.
export type OpencodeDetectDeps = {
  env: NodeJS.ProcessEnv
  homePath: string
  platform: NodeJS.Platform
  isExecutable: (path: string) => Promise<boolean>
  getVersion: (path: string) => Promise<string | undefined>
  resolveNpmBinDirs: () => Promise<string[]>
  // Extra fixed directories to probe (e.g. the app-managed install dir), searched after PATH/home.
  extraDirs?: string[]
}

// Path semantics follow the injected platform, not the host, so win32 rules can be exercised on posix.
const pathFor = (platform: NodeJS.Platform): path.PlatformPath =>
  platform === 'win32' ? path.win32 : path.posix

// Candidate binary filenames for opencode, in probe order. Windows resolves a bare command through
// PATHEXT, so an npm-installed `opencode.cmd`, a native `opencode.exe`, or a `.bat` shim must each be
// tried explicitly; the extensionless name is kept last as a catch-all. Unix has only `opencode`.
const opencodeBinaryNames = (platform: NodeJS.Platform): string[] =>
  platform === 'win32' ? ['opencode.cmd', 'opencode.exe', 'opencode.bat', 'opencode'] : ['opencode']

// Common non-PATH install locations by platform. Windows: npm's global bin (%APPDATA%\npm). Unix:
// Homebrew + /usr/local. `~/.local/bin` and `~/.opencode/bin` (install-script targets) are added
// separately by collectCandidateDirs.
const wellKnownDirs = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] => {
  if (platform === 'win32') {
    const p = pathFor(platform)

    return env.APPDATA ? [p.join(env.APPDATA, 'npm')] : []
  }

  return ['/opt/homebrew/bin', '/usr/local/bin']
}

// Builds the ordered list of directories to search for the opencode binary.
const collectCandidateDirs = async (deps: OpencodeDetectDeps): Promise<string[]> => {
  const p = pathFor(deps.platform)
  const pathDirs = (deps.env.PATH ?? '').split(p.delimiter).filter((dir) => dir.length > 0)
  const npmBinDirs = await deps.resolveNpmBinDirs().catch(() => [])

  // De-duplicate while preserving first-seen order so the first real hit wins.
  return Array.from(
    new Set([
      ...pathDirs,
      p.join(deps.homePath, '.local', 'bin'),
      p.join(deps.homePath, '.opencode', 'bin'),
      ...(deps.extraDirs ?? []),
      ...wellKnownDirs(deps.platform, deps.env),
      ...npmBinDirs
    ])
  )
}

// Probes each candidate directory × filename, returning the first executable whose `--version`
// succeeds. Returns undefined when opencode is not installed anywhere we look.
const detectOpencode = async (
  deps: OpencodeDetectDeps = createDefaultDetectDeps()
): Promise<OpencodeDetectResult | undefined> => {
  const p = pathFor(deps.platform)
  const candidateDirs = await collectCandidateDirs(deps)
  const binaryNames = opencodeBinaryNames(deps.platform)

  for (const dir of candidateDirs) {
    for (const name of binaryNames) {
      const candidate = p.join(dir, name)

      if (!(await deps.isExecutable(candidate))) continue

      const version = await deps.getVersion(candidate)

      // A path that exists but cannot report a version is not a usable opencode; keep searching.
      if (version === undefined) continue

      return { resolvedPath: candidate, version }
    }
  }

  return undefined
}

// Real filesystem executable check. On Windows the POSIX execute bit is meaningless, so existence
// plus a known executable extension (encoded in the candidate filenames) is the reliable signal;
// elsewhere require X_OK.
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

// Parses the first version-looking token out of `opencode --version` output (it prints just "1.18.3").
const parseVersion = (output: string): string | undefined => {
  const match = output.match(/\d+\.\d+\.[\w.-]+/)

  return match ? match[0] : output.trim() || undefined
}

// Real `<path> --version` runner. On Windows a `.cmd`/`.bat` shim cannot be launched by execFile
// directly, so route it through the shell with the path quoted; native `.exe`/Unix binaries run
// without a shell. Short timeout so a hung binary can't stall detection.
const runOpencodeVersion =
  (platform: NodeJS.Platform) =>
  async (path: string): Promise<string | undefined> => {
    try {
      const { stdout } =
        platform === 'win32'
          ? await execFileAsync(`"${path}"`, ['--version'], {
              timeout: 5000,
              shell: true,
              windowsHide: true,
              env: augmentedPathEnv(process.env)
            })
          : await execFileAsync(path, ['--version'], {
              timeout: 5000,
              windowsHide: true,
              env: augmentedPathEnv(process.env)
            })

      return parseVersion(stdout)
    } catch {
      return undefined
    }
  }

// Resolves the npm global bin directory if npm is present. On Windows npm is a `.cmd` shim (needs a
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
const createDefaultDetectDeps = (): OpencodeDetectDeps => {
  const platform = process.platform

  return {
    env: process.env,
    homePath: homedir(),
    platform,
    isExecutable: isExecutableFile(platform),
    getVersion: runOpencodeVersion(platform),
    resolveNpmBinDirs: resolveNpmBinDirs(platform)
  }
}

export { collectCandidateDirs, createDefaultDetectDeps, detectOpencode, parseVersion }
