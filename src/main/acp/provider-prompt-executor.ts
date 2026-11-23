import { harnessTurnAdapter } from './harness-turn-adapter'
import type {
  ActiveSession,
  ContentBlock,
  PromptResponse,
  SessionNotification
} from '@agentclientprotocol/sdk'
import { setTimeout as wait } from 'node:timers/promises'

import { toAcpTurnTokenUsage } from '../../shared/acp'
import type { AgentFrameworkId } from '../../shared/settings'
import { requireTracingFramework } from './task-run-tracing'
import { HARNESS_TRACE_ENABLED } from '../harness-acp/config'
import type { AcpBackendGenerationOwner } from './backend-generation-owner'
import { createClaudeTranscriptReader } from './claude-transcript-reader'
import { createClaudeCodeTurnAdapter } from './claude-turn-adapter'
import { codeBuddyTurnAdapter } from './codebuddy-turn-adapter'
import { createCodexTurnAdapter } from './codex-turn-adapter'
import { AcpOpenCodeTurnAdapter } from './opencode-turn-adapter'
import { fetchOpenCodeUsageSnapshot } from './opencode-turn-usage'
import { piTurnAdapter } from './pi-turn-adapter'
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
  isUserStopped?: () => boolean
  beforeDispatch: () => Promise<'active' | 'cancelled'>
  authorizeHarnessTracing?: true | (() => Promise<boolean>)
  signal?: AbortSignal
  cancellationCheckpoint?: () => Promise<'active' | 'cancelled'>
  captureStop: (response: PromptResponse) => boolean
  onDispatchAttempt?: () => void
  onDispatched?: () => void
  onAccepted: () => void | Promise<void>
  routeNotification: (notification: SessionNotification) => void
  reportBestEffortFailure?: (stage: ProviderPromptObservationStage, error: unknown) => void
  preDispatchModelCalls?: readonly AcpProviderModelCallUsage[]
}>

type AcpProviderPromptExecutorOptions = Readonly<{
  backendGeneration: Pick<AcpBackendGenerationOwner, 'openCodeUsageApi'> &
    Readonly<{ current: Pick<AcpBackendGenerationOwner['current'], 'adapter'> }>
  opencodeUsageFetch?: typeof fetch
  recoverOutputTruncation?: boolean
}>

type ProviderTurnObservationInput = Readonly<{
  providerSessionId: string
  cwd: string
  frameworkId: AgentFrameworkId
  reportBestEffortFailure?: (stage: ProviderPromptObservationStage, error: unknown) => void
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
const HARNESS_TRACE_AUTHORIZATION_TIMEOUT_MS = 250
const NOOP_PROBE: AcpProviderTurnProbe = Object.freeze({
  finalize: () => EMPTY_FACTS,
  cancel: () => undefined
})

async function authorizeHarnessPrompt(
  content: ProviderPromptExecutionInput['content'],
  authorize: ProviderPromptExecutionInput['authorizeHarnessTracing'],
  signal: AbortSignal | undefined
): Promise<ProviderPromptExecutionInput['content']> {
  let enabled = authorize === true
  if (typeof authorize === 'function' && !signal?.aborted) {
    const lookupLifetime = new AbortController()
    const lookupSignal = signal
      ? AbortSignal.any([signal, lookupLifetime.signal])
      : lookupLifetime.signal
    try {
      enabled =
        (await Promise.race([
          authorize(),
          wait(HARNESS_TRACE_AUTHORIZATION_TIMEOUT_MS, false, { signal: lookupSignal, ref: false })
        ])) === true && !signal?.aborted
    } catch {
      // Project settings are optional diagnostics authority. Continue the turn without exporting.
    } finally {
      lookupLifetime.abort()
    }
  }
  const first: ContentBlock | undefined =
    typeof content === 'string' ? { type: 'text', text: content } : content[0]
  if (!first || (!enabled && !Object.hasOwn(first._meta ?? {}, HARNESS_TRACE_ENABLED)))
    return content
  const meta: Record<string, unknown> = { ...first._meta }
  delete meta[HARNESS_TRACE_ENABLED]
  if (enabled) meta[HARNESS_TRACE_ENABLED] = true
  return [{ ...first, _meta: meta }, ...(typeof content === 'string' ? [] : content.slice(1))]
}

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
    ...(facts.compaction ? { compaction: Object.freeze({ ...facts.compaction }) } : {}),
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

  async beginObservation(input: ProviderTurnObservationInput): Promise<AcpProviderTurnProbe> {
    const token = Symbol(input.providerSessionId)
    let probe = NOOP_PROBE
    try {
      probe = await this.adapterFor(input.frameworkId).begin({
        providerSessionId: input.providerSessionId,
        cwd: input.cwd
      })
    } catch (error) {
      reportBestEffort(input.reportBestEffortFailure, 'begin', error)
    }
    this.observations.set(input.providerSessionId, {
      token,
      probe,
      report: input.reportBestEffortFailure
    })
    let open = true
    const release = (): void => {
      if (this.observations.get(input.providerSessionId)?.token === token) {
        this.observations.delete(input.providerSessionId)
      }
    }
    return {
      observe: (message) => {
        if (open) this.observeProviderMessage(message)
      },
      finalize: async ({ response }) => {
        if (!open) return EMPTY_FACTS
        open = false
        release()
        try {
          return normalizeFacts(response, await probe.finalize({ response }))
        } catch (error) {
          reportBestEffort(input.reportBestEffortFailure, 'finalize', error)
          return normalizeFacts(response, EMPTY_FACTS)
        }
      },
      cancel: async () => {
        if (!open) return
        open = false
        release()
        try {
          await probe.cancel()
        } catch (error) {
          reportBestEffort(input.reportBestEffortFailure, 'cancel', error)
        }
      }
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

      let content = input.content
      if (input.authorizeHarnessTracing === true) requireTracingFramework(input.frameworkId)
      if (input.frameworkId === 'open-science-agent') {
        content = await authorizeHarnessPrompt(content, input.authorizeHarnessTracing, input.signal)
        // Stop aborts the lookup before ACP confirms whether it cancelled the prompt.
        const cancelled =
          input.signal?.aborted && (await input.cancellationCheckpoint?.()) !== 'active'
        if (cancelled || !input.isCurrent()) {
          await cancelProbe()
          return Object.freeze({ kind: 'not-dispatched' })
        }
      }

      let promptRequest: Promise<unknown>
      try {
        input.onDispatchAttempt?.()
        promptRequest = input.session.prompt(content)
        input.onDispatched?.()
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

        if (!accepted && input.isCurrent()) {
          accepted = true
          try {
            await input.onAccepted()
          } catch (error) {
            reportBestEffort(input.reportBestEffortFailure, 'accepted', error)
          }
        }
        // Acceptance can await durable delivery; the same owner must still hold the message.
        if (!input.isCurrent()) {
          if (message.kind !== 'stop') continue
          await cancelProbe()
          return Object.freeze({ kind: 'superseded', response: message.response })
        }

        if (message.kind !== 'stop') {
          try {
            probe.observe?.(message.notification)
          } catch (error) {
            reportBestEffort(input.reportBestEffortFailure, 'observe', error)
          }
          const update = message.notification.update.sessionUpdate
          if (
            (update === 'agent_message_chunk' || update === 'agent_thought_chunk') &&
            input.isUserStopped?.()
          )
            continue
          input.routeNotification(message.notification)
          continue
        }
        const providerError = adapter.getPromptError?.(message.response)
        if (providerError) throw providerError
        // A native terminal ends the wait. Only an accepted Stop of this prompt changes
        // a normal finish to a local interruption. Provider errors and limits keep their outcome.
        const terminal: PromptResponse =
          message.response.stopReason === 'end_turn' && input.isUserStopped?.()
            ? { ...message.response, stopReason: 'cancelled' }
            : message.response
        if (!input.captureStop(terminal)) {
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
        // OpenCode v1 can return end_turn even when the model stopped at its output limit.
        const response: PromptResponse =
          this.options.recoverOutputTruncation &&
          terminal.stopReason === 'end_turn' &&
          facts.outputTruncated
            ? { ...message.response, stopReason: 'max_tokens' }
            : terminal
        return Object.freeze({
          kind: 'stopped',
          response,
          facts: withPreDispatchModelCalls(
            normalizeFacts(response, facts),
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
    if (frameworkId === 'claude-code') {
      const configDir = this.options.backendGeneration.current.adapter.claudeConfigDir
      return createClaudeCodeTurnAdapter({
        ...(configDir ? { readTranscriptMessages: createClaudeTranscriptReader(configDir) } : {})
      })
    }
    if (frameworkId === 'codex') return createCodexTurnAdapter()
    if (frameworkId === 'codebuddy') return codeBuddyTurnAdapter
    // Pi ACP returns aggregate usage on PromptResponse; it has no OpenCode usage API to probe.
    if (frameworkId === 'pi') return piTurnAdapter
    if (frameworkId === 'open-science-agent') return harnessTurnAdapter

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
export type {
  ProviderPromptExecutionInput,
  ProviderPromptObservationStage,
  ProviderPromptOutcome,
  ProviderTurnObservationInput
}
