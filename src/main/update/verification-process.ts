import { randomUUID } from 'node:crypto'
import {
  registerOwnedPosixProcessGroup,
  terminateProcessTree,
  registerProcessTreeOwnership
} from '../process-tree'
import { spawnWindowsOwnedProcess, reapWindowsOwnedJob } from '../process-tree-windows'
import { spawn } from 'node:child_process'
import { UpdateLifecycleError } from '../../shared/update'

const unsettledDirectories = new Set<string>()
export function verificationDirectoryIsSettled(directory: string): boolean {
  return ![...unsettledDirectories].some(
    (path) =>
      path === directory || path.startsWith(`${directory}/`) || path.startsWith(`${directory}\\`)
  )
}
export class VerificationProcessUnsettledError extends UpdateLifecycleError {
  constructor(readonly directory?: string) {
    super(
      'install-failed',
      'The verification process tree could not be confirmed stopped. Its temporary files were retained.'
    )
  }
}

export class VerificationProcessExitError extends UpdateLifecycleError {
  constructor(
    readonly command: string,
    readonly exitCode: number | null,
    readonly stderr = '',
    readonly signal?: NodeJS.Signals | null,
    readonly stdout = ''
  ) {
    super('install-failed', `Installation verification failed (${command}, exit ${exitCode}).`)
  }
}

/** Bounded subprocesses keep cancellation and recovery UI responsive. */
export async function runVerificationProcess(
  command: string,
  args: string[],
  options: {
    signal?: AbortSignal
    cwd?: string
    timeoutMs?: number
    maxBytes?: number
    env?: NodeJS.ProcessEnv
    shell?: boolean
    stdin?: 'pipe'
  } = {}
): Promise<{ stdout: string; stderr: string }> {
  options.signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const jobName = `Local\\OpenScience.Delegation.${randomUUID()}`
    const child =
      process.platform === 'win32'
        ? spawnWindowsOwnedProcess(jobName, command, args, {
            cwd: options.cwd,
            env: options.env ?? process.env,
            shell: options.shell,
            stdio: 'pipe'
          })
        : spawn(command, args, {
            cwd: options.cwd,
            detached: true,
            env: options.env,
            shell: options.shell,
            windowsHide: true,
            stdio: [options.stdin ?? 'ignore', 'pipe', 'pipe']
          })
    if (process.platform === 'win32')
      registerProcessTreeOwnership(child, {
        terminate: async () => ({ reaped: await reapWindowsOwnedJob(jobName) }),
        settled: () => undefined
      })
    else registerOwnedPosixProcessGroup(child)
    const stdout: Buffer[] = [],
      stderr: Buffer[] = []
    let size = 0
    let failure: unknown
    let settlement: Promise<void> | undefined
    let completed = false
    const settle = (code: number | null, signal?: NodeJS.Signals | null): Promise<void> => {
      settlement ??= (async () => {
        let deadline: NodeJS.Timeout | undefined
        const result = await Promise.race([
          terminateProcessTree(child, 'SIGKILL'),
          new Promise<{ reaped: false }>((resolve) => {
            deadline = setTimeout(() => resolve({ reaped: false }), 5000)
          })
        ])
        if (deadline) clearTimeout(deadline)
        child.stdin?.destroy()
        completed = true
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', abort)
        if (!result.reaped) {
          if (options.cwd) unsettledDirectories.add(options.cwd)
          child.stdout?.destroy()
          child.stderr?.destroy()
          child.unref()
          reject(new VerificationProcessUnsettledError(options.cwd))
          return
        }
        if (failure) {
          reject(failure)
          return
        }
        if (code !== 0) {
          // The existing output budget bounds this evidence. Keep it out of the display message;
          // diagnostic callers redact and shorten it through runtimeChildProcessErrorFields.
          reject(
            new VerificationProcessExitError(
              command,
              code,
              Buffer.concat(stderr).toString(),
              signal,
              Buffer.concat(stdout).toString()
            )
          )
          return
        }
        resolve({
          stdout: Buffer.concat(stdout).toString(),
          stderr: Buffer.concat(stderr).toString()
        })
      })()
      return settlement
    }
    const stop = (error: unknown): void => {
      if (completed) return
      failure ??= error
      void settle(null)
    }
    const abort = (): void => stop(options.signal?.reason ?? new Error('Verification cancelled.'))
    options.signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(
      () =>
        stop(
          Object.assign(
            new UpdateLifecycleError(
              'install-failed',
              'Installation verification exceeded its time limit.'
            ),
            { code: 'ETIMEDOUT' }
          )
        ),
      options.timeoutMs ?? 120_000
    )
    const collect = (chunks: Buffer[], chunk: Buffer): void => {
      size += chunk.length
      if (size > (options.maxBytes ?? 32 * 1024 * 1024))
        stop(
          new UpdateLifecycleError(
            'install-failed',
            'Installation verification output exceeded its limit.'
          )
        )
      else chunks.push(chunk)
    }
    child.stdout!.on('data', (chunk: Buffer) => collect(stdout, chunk))
    child.stderr!.on('data', (chunk: Buffer) => collect(stderr, chunk))
    child.stdin?.on('error', stop)
    child.on('error', (error) => {
      failure ??= error
    })
    child.on('close', (code, signal) => {
      void settle(code, signal)
    })
    if (options.signal?.aborted) abort()
  })
}
