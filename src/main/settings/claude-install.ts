import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type {
  ClaudeInstallLogEvent,
  ClaudeInstallResult,
  ClaudeInstallSource,
  NpmAvailability
} from '../../shared/settings'
import { CLAUDE_INSTALL_SOURCES } from '../../shared/settings'
import { augmentedPathEnv } from './shell-path'

const execFileAsync = promisify(execFile)

// Constructs and runs the one-click claude installer for a chosen source, streaming output back so
// the UI can show live progress and never spin silently. Command construction is pure and testable;
// the spawn is injectable for the same reason.

// How a source is actually executed. The official script is piped through a shell; the npm source
// runs a plain global install against the user's configured registry.
type InstallSpawnSpec = {
  command: string
  args: string[]
}

const INSTALL_SPAWN_SPECS: Record<ClaudeInstallSource, InstallSpawnSpec> = {
  npm: {
    command: 'npm',
    args: ['i', '-g', '@anthropic-ai/claude-code']
  },
  'official-script': {
    command: 'bash',
    args: ['-lc', 'curl -fsSL https://claude.ai/install.sh | bash']
  }
}

// Default guard so a hung network install cannot block the wizard forever.
const DEFAULT_INSTALL_TIMEOUT_MS = 5 * 60 * 1000

export type RunInstallOptions = {
  source: ClaudeInstallSource
  installId: string
  onLog: (event: ClaudeInstallLogEvent) => void
  timeoutMs?: number
  // Injectable spawn so tests can drive stdout/stderr/exit without a real process.
  spawnImpl?: (command: string, args: string[]) => ChildProcessWithoutNullStreams
}

// Returns the exact spawn command/args for a source (also the source of the copyable display text).
const getInstallSpawnSpec = (source: ClaudeInstallSource): InstallSpawnSpec =>
  INSTALL_SPAWN_SPECS[source]

// Real installer spawn with piped stdio. PATH is augmented so a GUI-launched app can still find npm.
const defaultInstallSpawn = (command: string, args: string[]): ChildProcessWithoutNullStreams =>
  spawn(command, args, {
    stdio: 'pipe',
    windowsHide: true,
    env: augmentedPathEnv()
  }) as ChildProcessWithoutNullStreams

// Runs an install source to completion, forwarding every stdout/stderr chunk through onLog and
// enforcing a timeout. Resolves (never rejects) with a structured result the service can act on.
const runInstall = ({
  source,
  installId,
  onLog,
  timeoutMs = DEFAULT_INSTALL_TIMEOUT_MS,
  spawnImpl = defaultInstallSpawn
}: RunInstallOptions): Promise<ClaudeInstallResult> => {
  const spec = getInstallSpawnSpec(source)

  onLog({ installId, stream: 'system', chunk: `$ ${spec.command} ${spec.args.join(' ')}` })

  return new Promise<ClaudeInstallResult>((resolve) => {
    let child: ChildProcessWithoutNullStreams

    try {
      child = spawnImpl(spec.command, spec.args)
    } catch (error) {
      resolve({
        installId,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      })

      return
    }

    let settled = false
    let timedOut = false

    // Ensures we resolve exactly once across exit/error/timeout races.
    const settle = (result: ClaudeInstallResult): void => {
      if (settled) return

      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    const timer = setTimeout(() => {
      timedOut = true
      onLog({ installId, stream: 'system', chunk: 'Install timed out; terminating.' })
      child.kill()
    }, timeoutMs)

    child.stdout.on('data', (data: Buffer) => {
      onLog({ installId, stream: 'stdout', chunk: data.toString('utf8') })
    })

    child.stderr.on('data', (data: Buffer) => {
      onLog({ installId, stream: 'stderr', chunk: data.toString('utf8') })
    })

    child.on('error', (error) => {
      settle({ installId, ok: false, error: error.message })
    })

    child.on('exit', (code) => {
      settle({
        installId,
        ok: !timedOut && code === 0,
        exitCode: code ?? undefined,
        timedOut: timedOut || undefined
      })
    })
  })
}

// Reports whether npm is on PATH so the UI can default to/enable the npm source. PATH is augmented
// with common node locations so a GUI-launched app doesn't falsely report npm as missing.
const detectNpmAvailable = async (
  runNpm: () => Promise<unknown> = () =>
    execFileAsync('npm', ['--version'], { timeout: 10_000, env: augmentedPathEnv() })
): Promise<NpmAvailability> => {
  try {
    await runNpm()

    return { available: true }
  } catch {
    return { available: false }
  }
}

export {
  CLAUDE_INSTALL_SOURCES,
  DEFAULT_INSTALL_TIMEOUT_MS,
  detectNpmAvailable,
  getInstallSpawnSpec,
  runInstall
}
