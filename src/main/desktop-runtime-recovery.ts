import { isRuntimeProcessAlive } from './runtime-stop-confirmation'
import { setTimeout as delay } from 'node:timers/promises'
import type { ChildProcess } from 'node:child_process'
import type { DesktopRuntimeClient } from './desktop-runtime-client'
import type { DesktopRuntimeRecoveryState } from '../shared/desktop-runtime-recovery'

/** Owns one manual attempt; never discovers, starts, signals, or retries a backend operation. */
export function createDesktopRuntimeRecovery(options: {
  client: DesktopRuntimeClient
  startedProcess?: ChildProcess
  connect(signal: AbortSignal): Promise<DesktopRuntimeClient>
  activate(
    client: DesktopRuntimeClient,
    signal: AbortSignal,
    readyForSnapshots: () => void
  ): Promise<void>
  discard?(client: DesktopRuntimeClient): void
  onState(state: DesktopRuntimeRecoveryState): void
  timeoutMs?: number
}): {
  state(): DesktopRuntimeRecoveryState
  disconnect(client: DesktopRuntimeClient): void
  reconnect(): Promise<DesktopRuntimeRecoveryState>
  setClosing(closing: boolean): void
} {
  const processId = options.client.processId()
  const generation = options.client.runtimeInfo().generation
  let current = options.client
  let pendingCandidate: DesktopRuntimeClient | undefined
  let state: DesktopRuntimeRecoveryState = { phase: 'connected', epoch: 0, closing: false }
  let attempt: Promise<DesktopRuntimeRecoveryState> | undefined
  let cancellation: AbortController | undefined
  const publish = (next: DesktopRuntimeRecoveryState): void => {
    state = next
    options.onState(next)
  }
  const childAlive = (): boolean => isRuntimeProcessAlive(processId)
  return {
    state: () => state,
    disconnect: (client) => {
      if (client !== current && client !== pendingCandidate) return
      cancellation?.abort()
      publish({
        ...state,
        phase: childAlive() ? 'disconnected' : 'unavailable',
        epoch: state.epoch + 1
      })
    },
    setClosing: (closing) => {
      if (closing) cancellation?.abort()
      publish({ ...state, closing })
    },
    reconnect: () => {
      if (attempt) return attempt
      if (state.closing || state.phase === 'connected' || state.phase === 'unavailable')
        return Promise.resolve(state)
      if (!childAlive()) {
        publish({ ...state, phase: 'unavailable' })
        return Promise.resolve(state)
      }
      const controller = new AbortController()
      cancellation = controller
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 12_000)
      timer.unref()
      publish({ ...state, phase: 'reconnecting', epoch: state.epoch + 1 })
      attempt = (async () => {
        let candidate: DesktopRuntimeClient | undefined
        try {
          const connection = options.connect(controller.signal)
          void connection.then(
            (late) => {
              if (controller.signal.aborted) late.close()
            },
            () => undefined
          )
          candidate = await abortable(connection, controller.signal)
          pendingCandidate = candidate
          if (controller.signal.aborted) throw new Error('Desktop reconnect canceled.')
          if (
            candidate.processId() !== processId ||
            candidate.runtimeInfo().generation !== generation ||
            !childAlive()
          ) {
            publish({ ...state, phase: 'unavailable' })
            throw new Error('The original desktop backend is no longer available.')
          }
          // A new socket can authenticate while its predecessor still owns cleanup. Do not
          // expose a usable conversation or cache spectator authority before that fence settles.
          await waitForDesktopRuntimeControl(candidate, controller.signal)
          await abortable(
            options.activate(candidate, controller.signal, () => {
              controller.signal.throwIfAborted()
              if (cancellation !== controller) throw new Error('Desktop attempt superseded.')
              publish({ ...state, phase: 'reconciling' })
            }),
            controller.signal
          )
          if (controller.signal.aborted) throw new Error('Desktop reconnect canceled.')
          current = candidate
          candidate = undefined
          publish({ ...state, phase: 'connected' })
        } catch (error) {
          if (candidate) options.discard?.(candidate)
          candidate?.close()
          if (
            !controller.signal.aborted &&
            error instanceof Error &&
            /(?:403|ENOENT|ECONNREFUSED|original desktop backend)/.test(error.message)
          )
            publish({ ...state, phase: 'unavailable' })
          if (state.phase !== 'unavailable')
            publish({ ...state, phase: childAlive() ? 'disconnected' : 'unavailable' })
        } finally {
          clearTimeout(timer)
          pendingCandidate = undefined
          cancellation = undefined
          attempt = undefined
        }
        return state
      })()
      return attempt
    }
  }
}

/** The attached Runtime has started stopping and must be replaced, never reused. */
export class RuntimeStoppingError extends Error {
  constructor() {
    super('The Runtime is shutting down and cannot be reused.')
    this.name = 'RuntimeStoppingError'
  }
}

/** Refresh only attachment authority; never replay a command or bypass a live controller. */
export async function waitForDesktopRuntimeControl(
  client: DesktopRuntimeClient,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  if (client.runtimeInfo().controlReason === 'runtime-stopping') throw new RuntimeStoppingError()
  while (client.runtimeInfo().controlReason === 'operation-pending') {
    await delay(100, undefined, { signal })
    await abortable(client.refreshControl(), signal)
    if (client.runtimeInfo().controlReason === 'runtime-stopping') throw new RuntimeStoppingError()
  }
  signal.throwIfAborted()
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => reject(new Error('Desktop reconnect canceled.'))
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
  })
}
