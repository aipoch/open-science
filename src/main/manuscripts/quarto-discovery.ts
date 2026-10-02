import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import type { QuartoDetection } from '../../shared/manuscripts'

const execFileAsync = promisify(execFile)
const PROBE_TIMEOUT_MS = 10_000

type QuartoExec = (
  command: string,
  args: readonly string[],
  options: {
    timeout: number
    windowsHide: boolean
    env: NodeJS.ProcessEnv
    shell: false
  }
) => Promise<{ stdout: string; stderr: string }>

type DiscoverQuartoDeps = Readonly<{
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  home?: string
  candidatePaths?: readonly string[]
  exec?: QuartoExec
}>

const unavailable = (): QuartoDetection => ({
  available: false,
  reason:
    'Quarto was not found. Install Quarto and ensure "quarto" is on PATH, then retry. Other preview and export formats are unaffected.'
})

const defaultCandidates = (
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string
): string[] => {
  const executable = platform === 'win32' ? 'quarto.exe' : 'quarto'
  const candidates = [
    env.QUARTO_PATH?.trim(),
    executable,
    join('/usr/local/bin', executable),
    join('/opt/homebrew/bin', executable),
    join('/usr/bin', executable),
    join('/opt/quarto/bin', executable),
    join(home, 'Applications', 'quarto', 'bin', executable)
  ]
  if (platform === 'darwin') candidates.push('/Applications/quarto/bin/quarto')
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
    candidates.push(
      join(localAppData, 'Programs', 'Quarto', 'bin', executable),
      join(env.ProgramFiles ?? 'C:\\Program Files', 'Quarto', 'bin', executable)
    )
  }
  return candidates.filter((candidate): candidate is string => Boolean(candidate))
}

const discoverQuarto = async (deps: DiscoverQuartoDeps = {}): Promise<QuartoDetection> => {
  const platform = deps.platform ?? process.platform
  const env = deps.env ?? process.env
  const candidates = deps.candidatePaths ?? defaultCandidates(platform, env, deps.home ?? homedir())
  const exec: QuartoExec = (command, args, options) =>
    deps.exec
      ? deps.exec(command, args, options)
      : execFileAsync(command, [...args], options).then(({ stdout, stderr }) => ({
          stdout: String(stdout),
          stderr: String(stderr)
        }))

  for (const candidate of [...new Set(candidates)]) {
    if (!candidate.trim()) continue
    try {
      const { stdout, stderr } = await exec(candidate, ['--version'], {
        timeout: PROBE_TIMEOUT_MS,
        windowsHide: true,
        env,
        shell: false
      })
      const version = `${stdout}\n${stderr}`.trim().split(/\r?\n/u)[0]?.trim()
      if (!version || !/\d+\.\d+\.\d+/u.test(version)) continue
      return { available: true, path: candidate, version }
    } catch {
      // Optional external-tool discovery is best-effort; a broken candidate never blocks the others.
    }
  }
  return unavailable()
}

export { discoverQuarto }
export type { DiscoverQuartoDeps, QuartoExec }
