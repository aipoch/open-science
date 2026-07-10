import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { ClaudeDetectResult } from '../../shared/settings'

const execFileAsync = promisify(execFile)

// Detects a runnable claude executable across the locations a GUI app might miss because its PATH
// differs from the user's login shell. Injectable deps keep the probe order unit-testable.

export type ClaudeDetectDeps = {
  // Environment used to read PATH; injected so tests can drive candidate discovery.
  env: NodeJS.ProcessEnv
  // Home directory for the ~/.local/bin fallback.
  homePath: string
  // Resolves whether a candidate file exists and is executable.
  isExecutable: (path: string) => Promise<boolean>
  // Runs `<path> --version` and returns the trimmed version string, or undefined on failure.
  getVersion: (path: string) => Promise<string | undefined>
  // Extra bin directories to probe (e.g. `npm prefix -g`); resolved lazily and tolerant of failure.
  resolveNpmBinDirs: () => Promise<string[]>
}

const CLAUDE_BINARY = 'claude'

// Common non-PATH install locations, in the order the design specifies.
const WELL_KNOWN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin']

// Builds the ordered list of directories to search for the claude binary.
const collectCandidateDirs = async (deps: ClaudeDetectDeps): Promise<string[]> => {
  const pathDirs = (deps.env.PATH ?? '').split(delimiter).filter((dir) => dir.length > 0)
  const npmBinDirs = await deps.resolveNpmBinDirs().catch(() => [])
  const localBin = join(deps.homePath, '.local', 'bin')

  // De-duplicate while preserving first-seen order so the first real hit wins.
  return Array.from(new Set([...pathDirs, localBin, ...WELL_KNOWN_DIRS, ...npmBinDirs]))
}

// Probes each candidate directory, returning the first executable whose `--version` succeeds.
const detectClaude = async (
  deps: ClaudeDetectDeps = createDefaultDetectDeps()
): Promise<ClaudeDetectResult> => {
  const candidateDirs = await collectCandidateDirs(deps)

  for (const dir of candidateDirs) {
    const candidate = join(dir, CLAUDE_BINARY)

    if (!(await deps.isExecutable(candidate))) continue

    const version = await deps.getVersion(candidate)

    // A path that exists but cannot report a version is not a usable claude; keep searching.
    if (version === undefined) continue

    return { found: true, path: candidate, version }
  }

  return { found: false }
}

// Real filesystem executable check used in production.
const isExecutableFile = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.X_OK)

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

// Real `<path> --version` runner used in production.
const runClaudeVersion = async (path: string): Promise<string | undefined> => {
  try {
    const { stdout } = await execFileAsync(path, ['--version'], { timeout: 10_000 })

    return parseVersion(stdout)
  } catch {
    return undefined
  }
}

// Resolves the npm global bin directory (`npm prefix -g` -> `<prefix>/bin`) if npm is present.
const resolveNpmBinDirs = async (): Promise<string[]> => {
  try {
    const { stdout } = await execFileAsync('npm', ['prefix', '-g'], { timeout: 10_000 })
    const prefix = stdout.trim()

    return prefix ? [join(prefix, 'bin')] : []
  } catch {
    return []
  }
}

// Production dependency bundle wired to real fs/child_process.
const createDefaultDetectDeps = (): ClaudeDetectDeps => ({
  env: process.env,
  homePath: homedir(),
  isExecutable: isExecutableFile,
  getVersion: runClaudeVersion,
  resolveNpmBinDirs
})

export { collectCandidateDirs, createDefaultDetectDeps, detectClaude, parseVersion }
