import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import type {
  ClaudeInstallLogEvent,
  ClaudeInstallResult,
  ClaudeInstallSource,
  NpmAvailability
} from '../../shared/settings'
import { augmentedPathEnv } from './shell-path'

const execFileAsync = promisify(execFile)

// Constructs and runs the one-click claude installer for a chosen source, streaming output back so
// the UI can show live progress and never spin silently. Command construction is pure and testable;
// the spawn is injectable for the same reason.

// How a source is actually executed. `shell` is set when the command must go through the OS shell:
// the official script is always piped through one (bash/PowerShell), and on Windows even `npm` needs
// a shell because it is an `npm.cmd` batch shim that spawn cannot launch directly.
type InstallSpawnSpec = {
  command: string
  args: string[]
  shell?: boolean
}

// Builds the exact spawn command/args for a source on a given platform. Windows: npm runs through the
// shell (npm.cmd), and the official installer is the PowerShell script (install.ps1); other platforms
// keep npm bare and pipe the shell script through bash. On Unix, npm's global install is redirected to
// a user-writable `~/.local` prefix so it never needs sudo (the system prefix is often root-owned); the
// resulting `~/.local/bin/claude` is already probed by detection and on the augmented PATH. Windows'
// global npm bin (%APPDATA%\npm) is already user-writable, so no prefix override is needed there. All
// args are hard-coded constants, so shell use here carries no injection risk.
const getInstallSpawnSpec = (
  source: ClaudeInstallSource,
  platform: NodeJS.Platform = process.platform,
  homePath: string = homedir()
): InstallSpawnSpec => {
  const isWindows = platform === 'win32'

  if (source === 'npm') {
    return {
      command: 'npm',
      args: isWindows
        ? ['i', '-g', '@anthropic-ai/claude-code']
        : ['i', '-g', '@anthropic-ai/claude-code', '--prefix', join(homePath, '.local')],
      shell: isWindows
    }
  }

  return isWindows
    ? {
        command: 'powershell',
        args: [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          'irm https://claude.ai/install.ps1 | iex'
        ]
      }
    : {
        command: 'bash',
        args: ['-lc', 'curl -fsSL https://claude.ai/install.sh | bash']
      }
}

// Default guard so a hung network install cannot block the wizard forever.
const DEFAULT_INSTALL_TIMEOUT_MS = 5 * 60 * 1000

// Cap on retained installer output used only for region-block detection (keeps memory bounded on a
// chatty install while still holding enough tail to spot the HTML signature).
const REGION_BLOCK_SCAN_LIMIT = 16 * 1024

// Signatures of the official installer being served a region-block HTML page instead of the shell
// script: `curl … | bash` then pipes HTML into bash, which fails with a syntax error near `<`. Any of
// these in the output means the download was blocked, not that the machine is misconfigured.
const REGION_BLOCK_MARKERS = [
  '<!doctype html',
  '<html',
  'app unavailable in region',
  'syntax error near unexpected token'
]

// Whether installer output looks like the region-block HTML page (used to trigger the npm fallback).
const isRegionBlockedOutput = (text: string): boolean => {
  const haystack = text.toLowerCase()

  return REGION_BLOCK_MARKERS.some((marker) => haystack.includes(marker))
}

export type RunInstallOptions = {
  source: ClaudeInstallSource
  installId: string
  onLog: (event: ClaudeInstallLogEvent) => void
  timeoutMs?: number
  // Injectable spawn so tests can drive stdout/stderr/exit without a real process. `options` carries
  // the spec's `shell` flag through to the real spawn.
  spawnImpl?: (
    command: string,
    args: string[],
    options?: { shell?: boolean }
  ) => ChildProcessWithoutNullStreams
}

// Options for the region-block-aware install. Extends the run options with an injectable npm probe so
// the fallback's availability check can be driven in tests without shelling out to a real npm.
export type RunInstallWithFallbackOptions = RunInstallOptions & {
  npmProbe?: () => Promise<unknown>
}

// Real installer spawn with piped stdio. PATH is augmented so a GUI-launched app can still find npm,
// and `shell` is honoured so Windows npm.cmd / PowerShell specs run.
const defaultInstallSpawn = (
  command: string,
  args: string[],
  options?: { shell?: boolean }
): ChildProcessWithoutNullStreams =>
  spawn(command, args, {
    stdio: 'pipe',
    windowsHide: true,
    shell: options?.shell,
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
      child = spawnImpl(spec.command, spec.args, { shell: spec.shell })
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
    // Bounded tail of stdout+stderr, scanned on failure to spot a region-block HTML page.
    let captured = ''

    const capture = (chunk: string): void => {
      captured = (captured + chunk).slice(-REGION_BLOCK_SCAN_LIMIT)
    }

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
      const chunk = data.toString('utf8')
      capture(chunk)
      onLog({ installId, stream: 'stdout', chunk })
    })

    child.stderr.on('data', (data: Buffer) => {
      const chunk = data.toString('utf8')
      capture(chunk)
      onLog({ installId, stream: 'stderr', chunk })
    })

    child.on('error', (error) => {
      settle({ installId, ok: false, error: error.message })
    })

    child.on('exit', (code) => {
      const ok = !timedOut && code === 0

      settle({
        installId,
        ok,
        exitCode: code ?? undefined,
        timedOut: timedOut || undefined,
        // Only the official script can be served the region-block page; flag it so callers can retry
        // with npm instead of surfacing a cryptic `syntax error near '<'`.
        regionBlocked:
          !ok && source === 'official-script' && isRegionBlockedOutput(captured) ? true : undefined
      })
    })
  })
}

// Reports whether npm is on PATH so the UI can default to/enable the npm source. PATH is augmented
// with common node locations so a GUI-launched app doesn't falsely report npm as missing.
const detectNpmAvailable = async (
  runNpm: () => Promise<unknown> = () =>
    execFileAsync('npm', ['--version'], {
      timeout: 10_000,
      // On Windows npm is an `npm.cmd` shim that execFile can't launch without a shell.
      shell: process.platform === 'win32',
      windowsHide: true,
      env: augmentedPathEnv()
    })
): Promise<NpmAvailability> => {
  try {
    await runNpm()

    return { available: true }
  } catch {
    return { available: false }
  }
}

// Runs the chosen install source and, when the official script comes back region-blocked, transparently
// retries with npm (which after the ~/.local prefix change needs no sudo). The fallback only fires when
// npm is actually available, so a machine without npm still gets the original, honest failure plus its
// copyable manual commands. Deps mirror runInstall/detectNpmAvailable so the whole flow stays testable.
const runInstallWithFallback = async ({
  source,
  installId,
  onLog,
  timeoutMs,
  spawnImpl,
  npmProbe
}: RunInstallWithFallbackOptions): Promise<ClaudeInstallResult> => {
  const result = await runInstall({ source, installId, onLog, timeoutMs, spawnImpl })

  if (result.ok || source !== 'official-script' || !result.regionBlocked) return result

  const { available } = await detectNpmAvailable(npmProbe)

  if (!available) return result

  onLog({
    installId,
    stream: 'system',
    chunk: 'Official installer looks unavailable in your region; falling back to npm…'
  })

  return runInstall({ source: 'npm', installId, onLog, timeoutMs, spawnImpl })
}

export {
  DEFAULT_INSTALL_TIMEOUT_MS,
  detectNpmAvailable,
  getInstallSpawnSpec,
  isRegionBlockedOutput,
  runInstall,
  runInstallWithFallback
}
