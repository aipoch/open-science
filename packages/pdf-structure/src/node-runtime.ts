import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { PdfStructureProcessRuntime } from './types.js'

// An IPC acknowledgement follows the supervisor's child/Worker exit barriers, never stdout.
export const createPdfStructureNodeRuntime = (
  options: { env?: NodeJS.ProcessEnv; detached?: boolean } = {}
): PdfStructureProcessRuntime => {
  const ownership = new WeakMap<
    ChildProcessWithoutNullStreams,
    { closed: boolean; confirmed: boolean }
  >()
  return {
    spawn(entry) {
      const env = { ...process.env, ...options.env }
      delete env.NODE_OPTIONS
      const child = spawn(process.execPath, [entry], {
        env,
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        detached: options.detached,
        windowsHide: true
      }) as ChildProcessWithoutNullStreams
      const state = { closed: false, confirmed: false }
      ownership.set(child, state)
      child.on('message', (message) => {
        if (
          message &&
          typeof message === 'object' &&
          'type' in message &&
          message.type === 'pdf:stopped'
        )
          state.confirmed = true
      })
      child.once('error', () => {
        // A failed spawn never acquired a supervisor or its descendants.
        if (!child.pid) state.confirmed = true
      })
      child.once('close', () => {
        state.closed = true
      })
      return child
    },
    async stop(child) {
      const state = ownership.get(child)
      if (!state) throw new Error('PDF worker termination is unconfirmed.')
      if (state.closed) {
        if (!state.confirmed) throw new Error('PDF worker termination is unconfirmed.')
        return
      }
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          clearTimeout(deadline)
          child.removeListener('close', closed)
        }
        const failed = (): void => {
          cleanup()
          reject(new Error('PDF worker termination is unconfirmed.'))
        }
        const closed = (): void => {
          cleanup()
          if (state.confirmed) resolve()
          else reject(new Error('PDF worker termination is unconfirmed.'))
        }
        const deadline = setTimeout(failed, 5_000)
        child.once('close', closed)
        // The supervisor may finish on its own while the stop request is in flight.
        // Wait for its close and acknowledgement even if delivery races with exit.
        try {
          if (!state.confirmed && child.connected) child.send({ type: 'pdf:stop' }, () => {})
        } catch {
          failed()
        }
      })
    }
  }
}

export const nodeProcessRuntime = createPdfStructureNodeRuntime()
