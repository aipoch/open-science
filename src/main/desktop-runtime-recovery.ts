import { isRuntimeProcessAlive } from './runtime-stop-confirmation'
import { setTimeout as delay } from 'node:timers/promises'
import type { ChildProcess } from 'node:child_process'
import type { DesktopRuntimeClient } from './desktop-runtime-client'
import type { ServiceLifetimeRecord } from './local-service-lifetime'
import type { DesktopRuntimeRecoveryState } from '../shared/desktop-runtime-recovery'

export class RuntimeRecoveryStoppedError extends Error {
  constructor(
    message: string,
    readonly reason: 'crash-limit' | 'service-stopped' = 'service-stopped'
  ) {
    super(message)
  }
}

/** A user action can authorize only its exact observed stop, never a later generation's stop. */
export function assertDesktopRuntimeRestartAllowed(
  intent: ServiceLifetimeRecord | undefined,
  authorization: ServiceLifetimeRecord | undefined,
  blocked: boolean
): void {
  if (blocked || (intent?.stopping && JSON.stringify(intent) !== JSON.stringify(authorization)))
    throw new RuntimeRecoveryStoppedError('The local service was intentionally stopped.')
}

/** One recovery round ends only after activation and renderer state synchronization. */
export function createDesktopRuntimeRecovery(options: {
  client: DesktopRuntimeClient
  startedProcess?: ChildProcess
  connect(signal: AbortSignal): Promise<DesktopRuntimeClient>
  repair?(signal: AbortSignal): Promise<DesktopRuntimeClient>
  activate(
    client: DesktopRuntimeClient,
    signal: AbortSignal,
    readyForSnapshots: () => void
  ): Promise<void>
  discard?(client: DesktopRuntimeClient): void
  onState(state: DesktopRuntimeRecoveryState): void
  timeoutMs?: number
  automatic?: boolean
  reviewRestart?(generation: string): Promise<ServiceLifetimeRecord | undefined>
  restart?(
    signal: AbortSignal,
    authorization?: ServiceLifetimeRecord
  ): Promise<DesktopRuntimeClient>
}): {
  state(): DesktopRuntimeRecoveryState
  disconnect(client: DesktopRuntimeClient): void
  reconnect(): Promise<DesktopRuntimeRecoveryState>
  setClosing(closing: boolean): void
  setShutdownProgress(active: boolean): void
} {
  let processId = options.client.processId()
  let generation = options.client.runtimeInfo().generation
  let current = options.client
  let pendingCandidate: DesktopRuntimeClient | undefined
  let repairing = false
  let state: DesktopRuntimeRecoveryState = {
    phase: 'connected',
    epoch: 0,
    closing: false,
    generation
  }
  let attempt: Promise<DesktopRuntimeRecoveryState> | undefined
  let cancellation: AbortController | undefined
  const publish = (next: DesktopRuntimeRecoveryState): void => {
    state = next
    options.onState(next)
  }
  const childAlive = (): boolean => isRuntimeProcessAlive(processId)
  let roundDeadline = 0
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let restartAuthorization: Promise<ServiceLifetimeRecord | undefined> | undefined
  let pendingRestartedGeneration: string | undefined
  let crashedGeneration: string | undefined
  let crashes: number[] = []
  const schedule = (): void => {
    if (!options.automatic || state.closing || stopped || state.phase === 'connected') return
    roundDeadline ||= Date.now() + (options.timeoutMs ?? 12_000)
    if (Date.now() >= roundDeadline) {
      publish({
        ...state,
        phase: childAlive() ? 'disconnected' : 'unavailable',
        reason: 'recovery-timeout'
      })
      return
    }
    clearTimeout(retryTimer)
    retryTimer = setTimeout(() => {
      void owner.reconnect(true)
    }, 250)
    retryTimer.unref?.()
  }
  const owner = {
    state: () => state,
    setShutdownProgress: (active: boolean) => publish({ ...state, shutdownProgress: active }),
    disconnect: (client: DesktopRuntimeClient) => {
      if (client !== current && client !== pendingCandidate) return
      // Retiring the failed original process is part of this explicit repair. Its exit must
      // not cancel the replacement; a pending replacement disconnect still cancels normally.
      if (repairing && client === current) return
      cancellation?.abort()
      // Keep the lost connection observable if quit is canceled; schedule() still
      // prevents reconnecting while shutdown owns the attachment.
      if (state.phase === 'connected') restartAuthorization = undefined
      publish({
        ...state,
        reason: stopped ? state.reason : childAlive() ? 'connection-lost' : 'process-exited',
        phase:
          options.automatic && !stopped
            ? 'reconnecting'
            : childAlive()
              ? 'disconnected'
              : 'unavailable',
        epoch: state.epoch + 1
      })
      schedule()
    },
    setClosing: (closing: boolean) => {
      if (closing) {
        cancellation?.abort()
        clearTimeout(retryTimer)
      }
      publish({ ...state, closing })
      if (!closing) schedule()
    },
    reconnect: (automatic = false): Promise<DesktopRuntimeRecoveryState> => {
      if (attempt) return attempt
      if (state.closing || state.phase === 'connected') return Promise.resolve(state)
      if (!automatic) {
        // Capture the exact generation at the explicit action, before activation can replace
        // index.ts's client. Every retry retains this same proof until the round settles.
        const reviewedGeneration = generation
        const hadExited = !childAlive()
        // Reconnect while A is alive cannot consent to a stop that arrives later, even if an
        // asynchronous read would return that stop before this round attempts a restart.
        restartAuthorization = hadExited
          ? options
              .reviewRestart?.(reviewedGeneration)
              .then((intent) =>
                intent?.stopping && intent.generation === reviewedGeneration
                  ? Object.freeze({ ...intent })
                  : undefined
              )
          : undefined
        void restartAuthorization?.catch(() => undefined)
        stopped = false
        crashes = []
        roundDeadline = Date.now() + (options.timeoutMs ?? 30_000)
      }
      if (!childAlive() && !options.restart) {
        publish({ ...state, phase: 'unavailable' })
        return Promise.resolve(state)
      }
      if (automatic && Date.now() >= roundDeadline) {
        publish({
          ...state,
          phase: childAlive() ? 'disconnected' : 'unavailable',
          reason: 'recovery-timeout'
        })
        return Promise.resolve(state)
      }
      const controller = new AbortController()
      cancellation = controller
      const timer = setTimeout(() => controller.abort(), Math.max(1, roundDeadline - Date.now()))
      timer.unref()
      publish({ ...state, phase: 'reconnecting', epoch: state.epoch + 1, diagnostics: undefined })
      // Defer execution until attempt is assigned. A synchronous crash-limit/stop rejection must
      // not clear the slot before assignment leaves a settled Promise permanently occupying it.
      attempt = Promise.resolve().then(async () => {
        let candidate: DesktopRuntimeClient | undefined
        try {
          const authorization = restartAuthorization
            ? await abortable(restartAuthorization, controller.signal)
            : undefined
          controller.signal.throwIfAborted()
          const restarting = !childAlive()
          if (restarting && crashedGeneration !== generation) {
            crashedGeneration = generation
            crashes = crashes.filter((time) => Date.now() - time < 300_000)
            crashes.push(Date.now())
          }
          if (automatic && restarting && crashes.length >= 3) {
            stopped = true
            throw new RuntimeRecoveryStoppedError(
              'The local service exited three times within five minutes.',
              'crash-limit'
            )
          }
          const connection = (async () => {
            if (restarting && options.restart)
              return options.restart(controller.signal, authorization)
            if (!automatic && options.repair) {
              try {
                return await options.connect(
                  AbortSignal.any([controller.signal, AbortSignal.timeout(2000)])
                )
              } catch {
                controller.signal.throwIfAborted()
                repairing = true
                return options.repair(controller.signal)
              }
            }
            return options.connect(controller.signal)
          })()
          void connection.then(
            (late) => {
              if (controller.signal.aborted) late.close()
            },
            () => undefined
          )
          candidate = await abortable(connection, controller.signal)
          pendingCandidate = candidate
          if (controller.signal.aborted) throw new Error('Desktop reconnect canceled.')
          if (restarting || (!automatic && options.repair && candidate.processId() !== processId)) {
            processId = candidate.processId()
            generation = candidate.runtimeInfo().generation
            pendingRestartedGeneration = generation
          }
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
              publish({ ...state, phase: 'reconciling', generation })
            }),
            controller.signal
          )
          if (controller.signal.aborted) throw new Error('Desktop reconnect canceled.')
          current = candidate
          candidate = undefined
          roundDeadline = 0
          publish({
            ...state,
            phase: 'connected',
            reason: undefined,
            diagnostics: undefined,
            ...(pendingRestartedGeneration
              ? { restartedGeneration: pendingRestartedGeneration }
              : {})
          })
          pendingRestartedGeneration = undefined
          restartAuthorization = undefined
        } catch (error) {
          if (error instanceof RuntimeRecoveryStoppedError) stopped = true
          if (candidate) options.discard?.(candidate)
          candidate?.close()
          if (
            !controller.signal.aborted &&
            error instanceof Error &&
            /(?:403|ENOENT|ECONNREFUSED|original desktop backend)/.test(error.message)
          )
            publish({ ...state, phase: 'unavailable' })
          publish({
            ...state,
            reason:
              error instanceof RuntimeRecoveryStoppedError
                ? error.reason
                : Date.now() >= roundDeadline
                  ? 'recovery-timeout'
                  : state.reason,
            diagnostics: JSON.stringify(
              {
                generation,
                pid: processId,
                reason:
                  error instanceof RuntimeRecoveryStoppedError ? error.reason : 'attempt-failed',
                timedOut: Date.now() >= roundDeadline,
                crashesInWindow: crashes.length
              },
              null,
              2
            ),
            phase:
              options.automatic && !stopped && Date.now() < roundDeadline
                ? 'reconnecting'
                : state.phase === 'unavailable' || !childAlive()
                  ? 'unavailable'
                  : 'disconnected'
          })
        } finally {
          clearTimeout(timer)
          repairing = false
          pendingCandidate = undefined
          cancellation = undefined
          attempt = undefined
          schedule()
        }
        return state
      })
      return attempt
    }
  }
  return owner
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
