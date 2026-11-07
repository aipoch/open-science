import { createAgentRunner, type AgentStep, type TurnOutcome } from '@aipoch/agent-harness'
import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'
import {
  requestHarnessModel,
  type HarnessModelObserver,
  type HarnessModelResult
} from './harness-model-request'
import { preferredEndpoint, providerValidationFailed } from '../../shared/settings'
import { ProviderRuntimeProjectionOwner } from './provider-runtime-projection'
import type { ProviderTransportOwner, HarnessProviderLease } from './provider-transport-owner'
import type { SettingsRepository } from './repository'
import type { StoredProvider } from './types'

export type HarnessSessionRequest = Readonly<{
  providerId: string
  model: string
  maxSteps: number
}>
type StepModel = Readonly<{
  route: HarnessProviderLease['route']
  request(
    body: Readonly<Record<string, unknown>>,
    observe: HarnessModelObserver
  ): Promise<HarnessModelResult>
}>
export type HarnessSession = Readonly<{
  route: HarnessProviderLease['route']
  signal: AbortSignal
  run(
    step: (signal: AbortSignal, index: number, model: StepModel) => ReturnType<AgentStep>
  ): Promise<TurnOutcome>
  dispose(): Promise<void>
}>
type Entry = {
  providerId: string
  reconcile(current?: StoredProvider): void
  dispose(): Promise<void>
}

// Validation timestamps and display copy are not configuration or credential changes.
const configuration = (provider: StoredProvider): object => {
  return Object.fromEntries(
    Object.entries(provider).filter(
      ([key]) =>
        ![
          'name',
          'keyMask',
          'lastValidatedAt',
          'lastValidatedTarget',
          'lastValidationFailure'
        ].includes(key)
    )
  )
}
const usable = (
  provider: StoredProvider | undefined,
  model: string
): provider is StoredProvider => {
  if (
    !provider ||
    !['custom', 'official', 'xai-subscription'].includes(provider.type) ||
    provider.disconnectedAt !== undefined
  )
    return false
  const endpoints = new ProviderRuntimeProjectionOwner().resolveProviderApiEndpoints(
    provider,
    model
  )
  const endpoint = preferredEndpoint(endpoints, ['responses', 'chat-completions', 'messages'])
  return !!endpoint && !providerValidationFailed(provider, { model, endpoint })
}

/** Main-only account and lifetime composition; the package owns turn admission and draining. */
export class HarnessSessionOwner {
  private readonly entries = new Set<Entry>()
  private readonly closing = new Set<Promise<void>>()
  private readonly projection = new ProviderRuntimeProjectionOwner()
  private readonly unsubscribe: () => void
  private disposed = false
  private disposal?: Promise<void>

  constructor(
    private readonly repository: SettingsRepository,
    private readonly transports: Pick<ProviderTransportOwner, 'acquireHarness'>
  ) {
    this.unsubscribe = repository.subscribeProviders((changes) => {
      for (const entry of this.entries) {
        const change = changes.find(({ id }) => id === entry.providerId)
        if (change) entry.reconcile(change.current)
      }
    })
  }

  async open(request: HarnessSessionRequest, lifetime: AbortSignal): Promise<HarnessSession> {
    if (this.disposed) throw new Error('Harness session owner is disposed')
    lifetime.throwIfAborted()
    const { providerId, model, maxSteps } = request
    if (!providerId.trim() || !model.trim())
      throw new Error('Harness requires an explicit provider and model')
    const runner = createAgentRunner({ maxSteps })
    const controller = new AbortController()
    let baseline: StoredProvider | undefined
    let lease: HarnessProviderLease | undefined
    let closePromise: Promise<void> | undefined
    let acquisitionFinished!: () => void
    const acquired = new Promise<void>((resolve) => {
      acquisitionFinished = resolve
    })
    const currentMatches = (current?: StoredProvider): boolean =>
      !!baseline &&
      usable(current, model) &&
      isDeepStrictEqual(configuration(baseline), configuration(current))
    const dispose = (): Promise<void> => {
      if (closePromise) return closePromise
      closePromise = Promise.resolve().then(async () => {
        await acquired
        // Revoke the connection while draining: a revoked account must admit no new requests.
        const results = await Promise.allSettled([drained, lease?.release()])
        lifetime.removeEventListener('abort', onAbort)
        this.entries.delete(entry)
        const failures = results
          .filter((result) => result.status === 'rejected')
          .map((result) => result.reason)
        if (failures.length) throw new AggregateError(failures, 'Harness session cleanup failed')
      })
      this.closing.add(closePromise)
      const pending = closePromise
      void pending.then(
        () => this.closing.delete(pending),
        () => undefined
      )
      const drained = runner.dispose()
      controller.abort()
      return pending
    }
    const onAbort = (): void => {
      void dispose()
    }
    const entry: Entry = {
      providerId,
      dispose,
      reconcile: (current) => {
        if (!currentMatches(current)) void dispose()
      }
    }
    this.entries.add(entry)
    lifetime.addEventListener('abort', onAbort, { once: true })
    try {
      baseline = (await this.repository.getSettings()).providers.find(({ id }) => id === providerId)
      controller.signal.throwIfAborted()
      if (!usable(baseline, model)) throw new Error('Harness provider is unavailable')
      const target = this.projection.resolveProviderTarget(baseline, { kind: 'required', model })
      if (baseline.type !== 'xai-subscription' && baseline.keyRef && !target.provider.key)
        throw new Error('Harness provider credentials are unavailable')
      lease = await this.transports.acquireHarness(target, controller.signal)
      const current = (await this.repository.getSettings()).providers.find(
        ({ id }) => id === providerId
      )
      if (!currentMatches(current))
        throw new Error('Harness provider configuration changed during acquisition')
      controller.signal.throwIfAborted()
      const connection = Object.freeze({ route: lease.route, connection: lease.connection })
      return Object.freeze({
        route: lease.route,
        signal: controller.signal,
        run: async (step): Promise<TurnOutcome> => {
          controller.signal.throwIfAborted()
          const turnId = randomUUID()
          let admitted = false
          try {
            const outcome = await runner.run(async (signal, index) => {
              admitted = true
              const stepController = new AbortController()
              const requestSignal = AbortSignal.any([signal, stepController.signal])
              let pending: Promise<HarnessModelResult> | undefined
              const model = Object.freeze({
                route: connection.route,
                request: (
                  body: Readonly<Record<string, unknown>>,
                  observe: HarnessModelObserver
                ): Promise<HarnessModelResult> => {
                  requestSignal.throwIfAborted()
                  if (pending) throw new Error('Harness permits one model request per step')
                  pending = requestHarnessModel({
                    model: connection,
                    turnId,
                    step: index,
                    body,
                    signal: requestSignal,
                    observe
                  })
                  void pending.catch(() => undefined)
                  return pending
                }
              })
              try {
                const result = await step(signal, index, model)
                await pending
                return result
              } catch (error) {
                stepController.abort()
                try {
                  await pending
                } catch (requestError) {
                  if (requestError !== error)
                    throw new AggregateError([error, requestError], 'Harness step failed')
                }
                throw error
              } finally {
                stepController.abort()
              }
            })
            if (outcome === 'cancelled') await dispose()
            return outcome
          } catch (error) {
            // Admission rejection while another run is active must not cancel that run.
            if (admitted) {
              try {
                await dispose()
              } catch (cleanupError) {
                throw new AggregateError([error, cleanupError], 'Harness turn and cleanup failed')
              }
            }
            throw error
          }
        },
        dispose
      })
    } catch (error) {
      acquisitionFinished()
      try {
        await dispose()
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Harness session acquisition and cleanup failed'
        )
      }
      throw error
    } finally {
      acquisitionFinished()
    }
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.disposed = true
    this.unsubscribe()
    let resolve!: () => void
    let reject!: (error: unknown) => void
    this.disposal = new Promise<void>((done, failed) => {
      resolve = done
      reject = failed
    })
    const pending = [...this.entries].map((entry) => entry.dispose())
    void Promise.allSettled(new Set([...pending, ...this.closing])).then((results) => {
      const failures = results
        .filter((result) => result.status === 'rejected')
        .map((result) => result.reason)
      if (failures.length) reject(new AggregateError(failures, 'Harness sessions failed to close'))
      else resolve()
    })
    return this.disposal
  }
}
