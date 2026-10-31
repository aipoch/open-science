import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { UpdateLifecycleError } from '../../shared/update'

const unsettled = new Set<ChildProcess>()

export function windowsInstallationProcessHelper(): string {
  return process.resourcesPath
    ? join(process.resourcesPath, 'windows-installation-processes.exe')
    : join(
        __dirname,
        '../../../out/windows-installer',
        process.arch,
        'windows-installation-processes.exe'
      )
}

export class WindowsInstallationQueryError extends UpdateLifecycleError {
  constructor(
    readonly stage: string,
    readonly diagnostic: { code?: string; exitCode?: number | null; stderr?: string },
    cause?: unknown
  ) {
    super('installation-busy', `Installation occupancy check failed (${stage}).`, undefined, {
      cause
    })
  }
}

// Only the helper's fixed stage/type/code record is retained. Never log arbitrary subprocess text.
export function installationQueryStderr(stderr: string): string {
  return stderr
    .split(/[\r\n]/)
    .filter((line) => /^stage=[a-z-]+;type=[A-Za-z]+;code=-?\d+$/.test(line))
    .join('\n')
    .slice(0, 1024)
}

export function queryWindowsInstallationDirectSync(root: string): string {
  const result = spawnSync(windowsInstallationProcessHelper(), ['query', root], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 16 * 1024 * 1024
  })
  if (result.error || result.status !== 0)
    throw new WindowsInstallationQueryError(
      'direct-query',
      {
        code: (result.error as NodeJS.ErrnoException | undefined)?.code,
        exitCode: result.status,
        stderr: installationQueryStderr(result.stderr ?? '')
      },
      result.error
    )
  return result.stdout
}

/** This fixed helper never starts descendants. Node retains its Windows process handle, so its
 * cancellation/timeout uses that handle and never needs the optional process-tree addon or WMI. */
async function runDirect(
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
  deadlineAt?: number
): Promise<string> {
  signal?.throwIfAborted()
  if (unsettled.size) throw new WindowsInstallationQueryError('direct-stop-unsettled', {})
  return new Promise((resolve, reject) => {
    const child = spawn(windowsInstallationProcessHelper(), args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const stdout: Buffer[] = []
    let stdoutBytes = 0,
      stderr = '',
      failure: unknown
    let stopDeadline: NodeJS.Timeout | undefined
    const stop = (reason: unknown): void => {
      failure ??= reason
      if (stopDeadline) return
      unsettled.add(child)
      child.kill()
      stopDeadline = setTimeout(
        () => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', abort)
          child.stdout.destroy()
          child.stderr.destroy()
          child.unref()
          reject(new WindowsInstallationQueryError('direct-stop-unsettled', {}, failure))
        },
        deadlineAt === undefined ? 5000 : Math.max(0, deadlineAt - Date.now())
      )
    }
    const abort = (): void => stop(signal?.reason ?? new Error('Installation query cancelled.'))
    signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(
      () => stop(new WindowsInstallationQueryError('direct-timeout', {})),
      timeoutMs
    )
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > 16 * 1024 * 1024)
        stop(new WindowsInstallationQueryError('direct-output-limit', {}))
      else stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4096)
    })
    child.on('error', (cause: NodeJS.ErrnoException) => {
      failure ??= new WindowsInstallationQueryError('direct-spawn', { code: cause.code }, cause)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (stopDeadline) clearTimeout(stopDeadline)
      unsettled.delete(child)
      signal?.removeEventListener('abort', abort)
      if (failure) reject(failure)
      else if (code !== 0)
        reject(
          new WindowsInstallationQueryError('direct-query', {
            exitCode: code,
            stderr: installationQueryStderr(stderr)
          })
        )
      else resolve(Buffer.concat(stdout).toString('utf8'))
    })
    if (signal?.aborted) abort()
  })
}

export function queryWindowsInstallationDirect(
  root: string,
  signal?: AbortSignal
): Promise<string> {
  return runDirect(['query', root], 15_000, signal)
}

/** Observes the installer mutex; acquisition here is immediately released and never grants a
 * replacement writer. NSIS must acquire its own existing mutex before touching installation files. */
export async function isWindowsInstallationWriterActive(
  mutexName: string,
  signal?: AbortSignal
): Promise<boolean> {
  if (!/^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i.test(mutexName))
    throw new Error('Invalid installer mutex identity.')
  const result: unknown = JSON.parse(await runDirect(['writer-active', mutexName], 5000, signal))
  if (
    !result ||
    typeof result !== 'object' ||
    !('active' in result) ||
    typeof result.active !== 'boolean'
  )
    throw new WindowsInstallationQueryError('writer-output', {})
  return result.active
}

/** Caller must hold the installation's update operation. File-use PIDs alone never grant close
 * authority: the helper binds the canonical executable in this root to a retained process handle. */
export async function closeWindowsInstallationProcesses(
  root: string,
  options: {
    excludedProcessIds: number[]
    timeoutMs: number
    deadlineAt?: number
    signal?: AbortSignal
  }
): Promise<{ graceful: number[]; forced: number[] }> {
  options.signal?.throwIfAborted()
  if (
    !Number.isInteger(options.timeoutMs) ||
    options.timeoutMs < 0 ||
    options.timeoutMs > 30_000 ||
    (options.deadlineAt !== undefined && !Number.isSafeInteger(options.deadlineAt)) ||
    !options.excludedProcessIds.every((pid) => Number.isSafeInteger(pid) && pid > 0)
  )
    throw new Error('Invalid installation close options.')
  const deadlineAt = options.deadlineAt ?? Date.now() + options.timeoutMs + 1000
  const remaining = deadlineAt - Date.now()
  if (remaining <= 0) throw new WindowsInstallationQueryError('close-deadline', {})
  // Both native grace/force/reap and helper cleanup consume this one deadline. An unsettled
  // retained helper handle keeps the global fence; expiry never grants permission to restore.
  const output = await runDirect(
    [
      'close',
      root,
      options.excludedProcessIds.join(','),
      String(options.timeoutMs),
      String(deadlineAt)
    ],
    remaining,
    undefined,
    deadlineAt
  )
  options.signal?.throwIfAborted()
  const result: unknown = JSON.parse(output)
  const pids = (value: unknown): value is number[] =>
    Array.isArray(value) && value.every((pid) => Number.isSafeInteger(pid) && pid > 0)
  if (
    !result ||
    typeof result !== 'object' ||
    !('graceful' in result) ||
    !('forced' in result) ||
    !pids(result.graceful) ||
    !pids(result.forced)
  )
    throw new WindowsInstallationQueryError('close-output', {})
  return { graceful: result.graceful, forced: result.forced }
}
