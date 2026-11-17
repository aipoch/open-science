import { randomUUID } from 'node:crypto'
import {
  capturePosixProcessTreeIdentity,
  createPosixProcessTreeOwnership,
  trackOwnedPosixProcessTree,
  releasePosixProcessTree,
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

export class VerificationProcessTimeoutError extends UpdateLifecycleError {
  // Progress written before the deadline; diagnostics redact and shorten it like exit stderr.
  stderr = ''
  constructor() {
    super('install-failed', 'Installation verification exceeded its time limit.')
  }
}

/** Bounded subprocesses keep cancellation and recovery UI responsive. Never invokes a shell. */
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
    // Interactive authentication may hand ownership of a browser to the user after the CLI exits.
    // A natural exit with any code ends that ownership. Interrupted commands still require teardown.
    preserveChildrenOnExit?: boolean
  } = {}
): Promise<{ stdout: string; stderr: string }> {
  options.signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const jobName = `Local\\OpenScience.Delegation.${randomUUID()}`
    const ownership = createPosixProcessTreeOwnership(options.env)
    const preserveChildrenOnExit = options.preserveChildrenOnExit === true
    // Darwin commands such as ps can exit before kernel identity capture. Hold the same process
    // behind fd3 until tracking is installed; stdin stays dedicated to the target command.
    // Linux pins /proc birth in this JS turn, including an exited, not-yet-reaped zombie.
    const gateLaunch = process.platform === 'darwin'
    const child =
      process.platform === 'win32' && !preserveChildrenOnExit
        ? spawnWindowsOwnedProcess(jobName, command, args, {
            cwd: options.cwd,
            env: options.env ?? process.env,
            shell: options.shell,
            stdio: 'pipe'
          })
        : spawn(
            gateLaunch ? '/bin/sh' : command,
            gateLaunch
              ? [
                  '-c',
                  'IFS= read -r start <&3 && [ "$start" = start ] || exit 125; exec 3<&-; exec "$@"',
                  'open-science-verification-start',
                  ...(options.shell
                    ? ['/bin/sh', '-c', [command, ...args].join(' ')]
                    : [command, ...args])
                ]
              : args,
            {
              cwd: options.cwd,
              detached: process.platform !== 'win32',
              env: ownership.env,
              shell: gateLaunch ? false : options.shell,
              windowsHide: true,
              stdio: gateLaunch
                ? [options.stdin ?? 'ignore', 'pipe', 'pipe', 'pipe']
                : [options.stdin ?? 'ignore', 'pipe', 'pipe']
            }
          )
    const launchGate = gateLaunch ? child.stdio[3] : undefined
    if (process.platform === 'win32' && !preserveChildrenOnExit)
      registerProcessTreeOwnership(child, {
        terminate: async () => ({ reaped: await reapWindowsOwnedJob(jobName) }),
        settled: () => undefined
      })
    else trackOwnedPosixProcessTree(child, ownership.token)
    const stdout: Buffer[] = [],
      stderr: Buffer[] = []
    let size = 0
    let failure: unknown
    let settlement: Promise<void> | undefined
    let completed = false
    const settle = (code: number | null, signal?: NodeJS.Signals | null): Promise<void> => {
      settlement ??= (async () => {
        let settled = true
        if (preserveChildrenOnExit && code !== null && !failure) {
          releasePosixProcessTree(child)
        } else {
          let deadline: NodeJS.Timeout | undefined
          const result = await Promise.race([
            terminateProcessTree(child, 'SIGKILL'),
            new Promise<{ reaped: false }>((resolve) => {
              deadline = setTimeout(() => resolve({ reaped: false }), 5000)
            })
          ])
          clearTimeout(deadline)
          settled = result.reaped
        }
        child.stdin?.destroy()
        completed = true
        launchGate?.destroy()
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', abort)
        if (!settled) {
          if (options.cwd) unsettledDirectories.add(options.cwd)
          child.stdout?.destroy()
          child.stderr?.destroy()
          child.unref()
          reject(new VerificationProcessUnsettledError(options.cwd))
          return
        }
        if (failure) {
          if (failure instanceof VerificationProcessTimeoutError)
            failure.stderr = Buffer.concat(stderr).toString()
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
      launchGate?.destroy()
      failure ??= error
      void settle(null)
    }
    const abort = (): void => stop(options.signal?.reason ?? new Error('Verification cancelled.'))
    options.signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(
      () => stop(new VerificationProcessTimeoutError()),
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
    launchGate?.on('error', stop)
    if (options.signal?.aborted) abort()
    else if (gateLaunch && child.pid !== undefined) {
      if (launchGate && 'end' in launchGate && capturePosixProcessTreeIdentity(child))
        launchGate.end('start\n')
      else {
        if (launchGate && 'end' in launchGate) launchGate.end()
        stop(
          new UpdateLifecycleError(
            'install-failed',
            'Verification process ownership could not be registered.'
          )
        )
      }
    }
  })
}
