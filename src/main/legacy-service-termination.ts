import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createLogger } from '@aipoch/diagnostics/node'
import { isRuntimeProcessAlive } from './runtime-stop-confirmation'
import { acquireRuntimeDirectorySync, RuntimeOwnershipConflict } from './runtime-ownership'

const run = promisify(execFile)

export type InspectedProcess = { commandLine: string; parentPid?: number }

export type LegacyTerminationDeps = {
  inspect(pid: number): Promise<InspectedProcess | undefined>
  isAlive(pid: number): boolean
  signal(pid: number, mode: 'terminate' | 'kill'): Promise<void>
  lockHeld(configRoot: string): boolean
  selfPid: number
  graceMs: number
  settleMs: number
}

/** Matches the bundled or development runtime entry launched as a service. */
export function looksLikeOpenScienceRuntime(commandLine: string): boolean {
  const normalized = commandLine.replace(/\\/g, '/')
  return /(?:^|[\s"'])[^\s"']*\/backend\/(?:out\/backend\/)?index\.cjs(?:["']|\s|$)/.test(
    normalized
  )
}

/** Matches the main process of an installed Open-Science desktop app, never its helpers. */
export function looksLikeOpenScienceDesktop(commandLine: string): boolean {
  const normalized = commandLine.replace(/\\/g, '/')
  if (/\s--type=/.test(normalized)) return false
  return /(?:Open[- ]Science(?: \(DEV\))?\.app\/Contents\/MacOS\/Open[- ]Science|\/Open[- ]Science\.exe|\/open-science)(?:["']|\s|$)/i.test(
    normalized
  )
}

export type LegacyServiceKind = 'node' | 'electron'

async function inspectProcess(pid: number): Promise<InspectedProcess | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
  try {
    if (process.platform === 'win32') {
      const { stdout } = await run(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { "$($p.ParentProcessId)|$($p.CommandLine)" }`
        ],
        { timeout: 5000, windowsHide: true }
      )
      const line = stdout.trim()
      const split = line.indexOf('|')
      if (split < 0) return undefined
      return { parentPid: Number(line.slice(0, split)), commandLine: line.slice(split + 1) }
    }
    const { stdout } = await run('ps', ['-p', String(pid), '-o', 'ppid=', '-o', 'command='], {
      timeout: 5000
    })
    const match = /^\s*(\d+)\s+(.+)$/s.exec(stdout.trim())
    return match ? { parentPid: Number(match[1]), commandLine: match[2] } : undefined
  } catch {
    return undefined
  }
}

async function signalProcess(pid: number, mode: 'terminate' | 'kill'): Promise<void> {
  if (process.platform === 'win32') {
    if (mode === 'terminate') process.kill(pid)
    else
      await run('taskkill', ['/PID', String(pid), '/T', '/F'], {
        timeout: 10_000,
        windowsHide: true
      })
    return
  }
  process.kill(pid, mode === 'terminate' ? 'SIGTERM' : 'SIGKILL')
}

function lockHeld(configRoot: string): boolean {
  try {
    acquireRuntimeDirectorySync(configRoot).release()
    return false
  } catch (error) {
    if (error instanceof RuntimeOwnershipConflict) return true
    throw error
  }
}

export const defaultLegacyTerminationDeps: LegacyTerminationDeps = {
  inspect: inspectProcess,
  isAlive: isRuntimeProcessAlive,
  signal: signalProcess,
  lockHeld,
  selfPid: process.pid,
  graceMs: 8000,
  settleMs: 8000
}

export class LegacyTerminationError extends Error {
  constructor(
    readonly code: 'identity-unproven' | 'not-stopped',
    detail: string
  ) {
    super(`The older service could not be stopped automatically. ${detail}`)
  }
}

/**
 * Stops a legacy service only after proving that the recorded PID is a live Open-Science runtime
 * that currently holds the runtime lock. Returns once the lock is acquirable again.
 */
export async function terminateVerifiedLegacyRuntime(
  options: { configRoot: string; generation: string; pid: number; kind?: LegacyServiceKind },
  overrides: Partial<LegacyTerminationDeps> = {}
): Promise<void> {
  const deps = {
    ...defaultLegacyTerminationDeps,
    ...(options.kind === 'electron' ? { graceMs: 15_000 } : {}),
    ...overrides
  }
  const matches =
    options.kind === 'electron' ? looksLikeOpenScienceDesktop : looksLikeOpenScienceRuntime
  const logger = createLogger('desktop-runtime-client')
  const { configRoot, pid } = options
  const released = async (timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs
    do {
      if (!deps.isAlive(pid) && !deps.lockHeld(configRoot)) return true
      await new Promise((resolve) => setTimeout(resolve, 50))
    } while (Date.now() < deadline)
    return false
  }
  if (!deps.isAlive(pid)) {
    if (await released(deps.settleMs)) return
    throw new LegacyTerminationError('not-stopped', 'The data folder is still locked.')
  }
  const info = await deps.inspect(pid)
  const proven =
    pid !== deps.selfPid &&
    info !== undefined &&
    info.parentPid !== deps.selfPid &&
    matches(info.commandLine) &&
    deps.lockHeld(configRoot)
  if (!proven) {
    logger.warn('legacy-stop', { step: 'identity', result: 'unproven', runtimePid: pid })
    // The process may have exited between the check and now; only the lock decides.
    if (!deps.isAlive(pid) && (await released(deps.settleMs))) return
    throw new LegacyTerminationError('identity-unproven', 'Its identity could not be confirmed.')
  }
  logger.info('legacy-stop', { step: 'terminate', runtimePid: pid })
  await deps.signal(pid, 'terminate')
  if (await released(deps.graceMs)) return
  // Re-prove identity: the PID must not have been recycled while waiting.
  const again = await deps.inspect(pid)
  if (again && matches(again.commandLine)) {
    logger.warn('legacy-stop', { step: 'kill', runtimePid: pid })
    await deps.signal(pid, 'kill')
  }
  if (await released(deps.settleMs)) return
  throw new LegacyTerminationError('not-stopped', 'The process did not exit.')
}
