import type { ChildProcess } from 'node:child_process'

const EXIT_TIMEOUT_MS = 5000

export class ResearchVideoEncoderCleanupError extends Error {
  constructor(readonly exited: Promise<void>) {
    super('Film encoder or verifier did not confirm shutdown. Try again after it exits.')
  }
}

const pendingExits = new Set<ResearchVideoEncoderCleanupError>()

export function assertVideoEncoderReady(): void {
  const pending = pendingExits.values().next().value
  if (pending) throw pending
}

export function ownVideoProcess(child: ChildProcess): { stop(): Promise<void>; unref(): void } {
  let exited = false
  const done = new Promise<void>((resolve) => {
    const finish = (): void => {
      exited = true
      resolve()
    }
    child.once('exit', finish)
    child.once('close', () => {
      if (child.pid === undefined) finish() // Spawn failed; there is no process to reap.
    })
  })
  // An abort and a later failed SIGKILL can both emit error. Neither proves exit.
  child.on('error', () => {})
  return {
    stop() {
      if (!exited && child.pid !== undefined) {
        try {
          child.kill('SIGKILL')
        } catch {
          // Wait for the exit event even if the signal could not be delivered.
        }
      }
      child.stdin?.destroy()
      child.stdout?.destroy()
      child.stderr?.destroy()
      return done
    },
    unref() {
      if (!exited) child.unref()
    }
  }
}

// Wake on cancellation even when sending a signal to the process fails silently.
export async function waitForVideoProcess<T>(result: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: () => void
  const cancelled = new Promise<never>((_, reject) => {
    abort = () =>
      reject(
        Object.assign(new Error('The operation was aborted', { cause: signal.reason }), {
          name: 'AbortError',
          code: 'ABORT_ERR'
        })
      )
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
  try {
    return await Promise.race([result, cancelled])
  } finally {
    signal.removeEventListener('abort', abort!)
  }
}

export async function reapVideoProcesses(
  children: ReturnType<typeof ownVideoProcess>[],
  removeOnLateExit?: () => Promise<void>
): Promise<void> {
  if (!children.length) return
  const exited = Promise.all(children.map((child) => child.stop())).then(() => {})
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ResearchVideoEncoderCleanupError(exited)),
          EXIT_TIMEOUT_MS
        )
      })
    ])
  } catch (error) {
    if (error instanceof ResearchVideoEncoderCleanupError) {
      pendingExits.add(error)
      for (const child of children) child.unref()
      void exited.then(async () => {
        pendingExits.delete(error)
        await removeOnLateExit?.().catch(() => {})
      })
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}
