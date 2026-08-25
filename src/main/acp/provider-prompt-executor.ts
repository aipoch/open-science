import type {
  ActiveSession,
  ContentBlock,
  PromptResponse,
  SessionNotification
} from '@agentclientprotocol/sdk'

import { toAcpTurnTokenUsage } from '../../shared/acp'
import type { AgentFrameworkId } from '../../shared/settings'
import type { AcpBackendGenerationOwner } from './backend-generation-owner'
import { claudeCodeTurnAdapter } from './claude-turn-adapter'
import { codeBuddyTurnAdapter } from './codebuddy-turn-adapter'
import { createCodexTurnAdapter } from './codex-turn-adapter'
import { AcpOpenCodeTurnAdapter } from './opencode-turn-adapter'
import { fetchOpenCodeUsageSnapshot } from './opencode-turn-usage'
import type {
  AcpProviderModelCallUsage,
  AcpProviderTurnAdapter,
  AcpProviderTurnProbe,
  AcpProviderTurnResult
} from './provider-turn-adapter'

type ProviderPromptObservationStage = 'accepted' | 'begin' | 'cancel' | 'finalize' | 'observe'

type ProviderPromptExecutionInput = Readonly<{
  session: Pick<ActiveSession, 'sessionId' | 'prompt' | 'nextUpdate'>
  content: string | ContentBlock[]
  cwd: string
  frameworkId: AgentFrameworkId
  isCurrent: () => boolean
  beforeDispatch: () => Promise<'active' | 'cancelled'>
  captureStop: () => boolean
  onAccepted: () => void | Promise<void>
  routeNotification: (notification: SessionNotification) => void
  reportBestEffortFailure?: (stage: ProviderPromptObservationStage, error: unknown) => void
  preDispatchModelCalls?: readonly AcpProviderModelCallUsage[]
}>

type AcpProviderPromptExecutorOptions = Readonly<{
  backendGeneration: Pick<AcpBackendGenerationOwner, 'openCodeUsageApi'>
  opencodeUsageFetch?: typeof fetch
}>

type ProviderPromptOutcome =
  | Readonly<{ kind: 'not-dispatched' }>
  | Readonly<{ kind: 'superseded'; response: PromptResponse }>
  | Readonly<{ kind: 'stopped'; response: PromptResponse; facts: AcpProviderTurnResult }>

type ActiveObservation = Readonly<{
  token: symbol
  probe: AcpProviderTurnProbe
  report?: ProviderPromptExecutionInput['reportBestEffortFailure']
}>

const EMPTY_FACTS: AcpProviderTurnResult = Object.freeze({})
const NOOP_PROBE: AcpProviderTurnProbe = Object.freeze({
  finalize: () => EMPTY_FACTS,
  cancel: () => undefined
})

const reportBestEffort = (
  report: ProviderPromptExecutionInput['reportBestEffortFailure'],
  stage: ProviderPromptObservationStage,
  error: unknown
): void => {
  try {
    report?.(stage, error)
  } catch {
    // Diagnostics must not replace the provider outcome.
  }
}

const normalizeFacts = (
  response: PromptResponse,
  facts: AcpProviderTurnResult
): AcpProviderTurnResult => {
  const turnUsage = facts.turnUsage ?? toAcpTurnTokenUsage(response.usage)
  return Object.freeze({
    ...(turnUsage ? { turnUsage: Object.freeze({ ...turnUsage }) } : {}),
    ...(facts.modelTurnCount === undefined ? {} : { modelTurnCount: facts.modelTurnCount }),
    ...(facts.modelCalls
      ? { modelCalls: Object.freeze(facts.modelCalls.map((call) => Object.freeze({ ...call }))) }
      : {}),
    ...(facts.contextUsedTokens === undefined
      ? {}
      : { contextUsedTokens: facts.contextUsedTokens }),
    ...(facts.lastModelStepUsage
      ? { lastModelStepUsage: Object.freeze({ ...facts.lastModelStepUsage }) }
      : {})
  })
}

const withPreDispatchModelCalls = (
  facts: AcpProviderTurnResult,
  preDispatch: readonly AcpProviderModelCallUsage[] | undefined
): AcpProviderTurnResult => {
  if (
    !preDispatch?.length ||
    !facts.turnUsage ||
    facts.modelTurnCount === undefined ||
    !facts.modelCalls
  ) {
    return facts
  }
  const calls = [...preDispatch, ...facts.modelCalls]
  const sum = (key: 'inputTokens' | 'cacheTokens' | 'outputTokens'): number =>
    calls.reduce((total, call) => total + call[key], 0)
  const optionalSum = (key: 'cachedReadTokens' | 'cachedWriteTokens'): number | undefined =>
    calls.every((call) => call[key] !== undefined)
      ? calls.reduce((total, call) => total + (call[key] ?? 0), 0)
      : undefined
  const inputTokens = sum('inputTokens')
  const cacheTokens = sum('cacheTokens')
  const outputTokens = sum('outputTokens')
  const cachedReadTokens = optionalSum('cachedReadTokens')
  const cachedWriteTokens = optionalSum('cachedWriteTokens')
  if (
    !Number.isSafeInteger(inputTokens) ||
    !Number.isSafeInteger(cacheTokens) ||
    !Number.isSafeInteger(outputTokens) ||
    (cachedReadTokens !== undefined && !Number.isSafeInteger(cachedReadTokens)) ||
    (cachedWriteTokens !== undefined && !Number.isSafeInteger(cachedWriteTokens))
  ) {
    return facts
  }
  return Object.freeze({
    ...facts,
    turnUsage: Object.freeze({
      inputTokens,
      cacheTokens,
      ...(cachedReadTokens === undefined ? {} : { cachedReadTokens }),
      ...(cachedWriteTokens === undefined ? {} : { cachedWriteTokens }),
      outputTokens
    }),
    modelTurnCount: facts.modelTurnCount + preDispatch.length,
    modelCalls: Object.freeze(calls.map((call) => Object.freeze({ ...call })))
  })
}

class AcpProviderPromptExecutor {
  private readonly observations = new Map<string, ActiveObservation>()

  constructor(private readonly options: AcpProviderPromptExecutorOptions) {}

  observeProviderMessage(message: unknown): void {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) return
    const providerSessionId = (message as { sessionId?: unknown }).sessionId
    if (typeof providerSessionId !== 'string') return
    const observation = this.observations.get(providerSessionId)
    if (!observation?.probe.observe) return
    try {
      observation.probe.observe(message)
    } catch (error) {
      reportBestEffort(observation.report, 'observe', error)
    }
  }

  async execute(input: ProviderPromptExecutionInput): Promise<ProviderPromptOutcome> {
    const providerSessionId = input.session.sessionId
    const token = Symbol(providerSessionId)
    const adapter = this.adapterFor(input.frameworkId)
    let probe = NOOP_PROBE
    try {
      probe = await adapter.begin({ providerSessionId, cwd: input.cwd })
    } catch (error) {
      reportBestEffort(input.reportBestEffortFailure, 'begin', error)
    }

    this.observations.set(providerSessionId, {
      token,
      probe,
      report: input.reportBestEffortFailure
    })
    let probeState: 'open' | 'cancelled' | 'finalized' = 'open'
    const releaseObservation = (): void => {
      if (this.observations.get(providerSessionId)?.token === token) {
        this.observations.delete(providerSessionId)
      }
    }
    const cancelProbe = async (): Promise<void> => {
      if (probeState !== 'open') return
      probeState = 'cancelled'
      releaseObservation()
      try {
        await probe.cancel()
      } catch (error) {
        reportBestEffort(input.reportBestEffortFailure, 'cancel', error)
      }
    }

    try {
      const dispatch = await input.beforeDispatch()
      if (dispatch === 'cancelled' || !input.isCurrent()) {
        await cancelProbe()
        return Object.freeze({ kind: 'not-dispatched' })
      }

      let promptRequest: Promise<unknown>
      try {
        promptRequest = input.session.prompt(input.content)
      } catch (error) {
        await cancelProbe()
        throw error
      }
      const promptFailure = promptRequest.then(
        () => new Promise<never>(() => undefined),
        (error) => Object.freeze({ kind: 'provider-rejection' as const, error })
      )
      let accepted = false

      for (;;) {
        const message = await Promise.race([input.session.nextUpdate(), promptFailure])
        if (message.kind === 'provider-rejection') throw message.error

        if (!input.isCurrent()) {
          if (message.kind !== 'stop') continue
          await cancelProbe()
          return Object.freeze({ kind: 'superseded', response: message.response })
        }

        if (!accepted) {
          accepted = true
          try {
            await input.onAccepted()
          } catch (error) {
            reportBestEffort(input.reportBestEffortFailure, 'accepted', error)
          }
        }
        if (message.kind !== 'stop') {
          try {
            probe.observe?.(message.notification)
          } catch (error) {
            reportBestEffort(input.reportBestEffortFailure, 'observe', error)
          }
          input.routeNotification(message.notification)
          continue
        }
        if (!input.captureStop()) {
          await cancelProbe()
          return Object.freeze({ kind: 'superseded', response: message.response })
        }

        probeState = 'finalized'
        releaseObservation()
        let facts = EMPTY_FACTS
        try {
          facts = await probe.finalize({ response: message.response })
        } catch (error) {
          reportBestEffort(input.reportBestEffortFailure, 'finalize', error)
        }
        return Object.freeze({
          kind: 'stopped',
          response: message.response,
          facts: withPreDispatchModelCalls(
            normalizeFacts(message.response, facts),
            input.preDispatchModelCalls
          )
        })
      }
    } finally {
      await cancelProbe()
      releaseObservation()
    }
  }

  private adapterFor(frameworkId: AgentFrameworkId): AcpProviderTurnAdapter {
    if (frameworkId === 'claude-code') return claudeCodeTurnAdapter
    if (frameworkId === 'codex') return createCodexTurnAdapter()
    if (frameworkId === 'codebuddy') return codeBuddyTurnAdapter

    // Capture one generation's immutable API before adapter.begin awaits. Re-reading the owner for
    // the final snapshot could mix credentials or lose usage after a generation switch.
    const usageApi = this.options.backendGeneration.openCodeUsageApi()
    return new AcpOpenCodeTurnAdapter((providerSessionId, cwd) =>
      usageApi
        ? fetchOpenCodeUsageSnapshot(
            usageApi,
            providerSessionId,
            cwd,
            this.options.opencodeUsageFetch
          )
        : Promise.resolve(undefined)
    )
  }
}

export { AcpProviderPromptExecutor }
export type { ProviderPromptExecutionInput, ProviderPromptObservationStage, ProviderPromptOutcome }
