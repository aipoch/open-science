import type { PromptResponse } from '@agentclientprotocol/sdk'

import {
  ACP_PROMPT_FAILED_EVENT_TITLE,
  type AcpModelCallUsage,
  type AcpRuntimeEventInput,
  type AcpTerminalContextWindow,
  type AcpTurnTokenUsage
} from '../../shared/acp'
import { isMediaOverflowError } from '../../shared/media-overflow'
import { createLogger, errorLogFields } from '../logger'
import type { ContextWindowTurnHandle } from './context-usage-tracker'
import type { AcpPermissionContext } from './permission-context'
import type { PreparedPromptHandle } from './prompt-preparation-owner'
import { describePromptError, isProviderPromptError } from './prompt-error'
import type { ProviderPromptOutcome } from './provider-prompt-executor'
import type { AcpProviderModelCallUsage } from './provider-turn-adapter'
import type { AcpPromptSessionInteractionScope } from './session-interaction-owner'
import type { AcpSessionInteractionOwner as InteractionOwner } from './session-interaction-owner'
import type { TurnSkillHandle, TurnSkillOutcome } from './turn-skill-owner'
const log = createLogger('acp')
type LogFields = Record<string, unknown>
type LogLevel = 'error' | 'info' | 'warn'
type RuntimeEventInput = AcpRuntimeEventInput
export type AcpPromptFinalizationOutcome =
  ProviderPromptOutcome | Readonly<{ kind: 'failed'; error: unknown }>
export type AcpPromptFinalizationHandles = Readonly<{
  sessionId: string
  promptMessageId?: string
  interaction: AcpPromptSessionInteractionScope
  interactions: Pick<InteractionOwner, 'captureTerminal' | 'current' | 'release' | 'settle'>
  permission: Pick<AcpPermissionContext, 'clearCorrelationsForSession'>
  prepared?: Pick<PreparedPromptHandle, 'close'>
  context?: ContextWindowTurnHandle
  skill: Pick<TurnSkillHandle, 'close' | 'reloadDecision'>
  model?: string
  emitUserMessage: () => void
  emitArtifact: (onPublished: () => void) => Promise<void>
  disposeArtifact: () => Promise<void>
  failPendingSkillActivities: () => void
  recordContextUsed: (used: number) => boolean
  errorMessage: (error: unknown) => string
  errorKind: (error: unknown) => string | undefined
  pushEvent: (event: RuntimeEventInput) => void
  emitState: () => void
  beforeInteractionRelease: () => void
  afterInteractionRelease: () => Promise<void>
  onPromptEnded: () => void
  generationActivityChanged: () => void
  autoCompactIfNeeded: () => Promise<unknown>
}>
type ObservedPromptStop = Readonly<{
  response: PromptResponse
  turnUsage?: Extract<ProviderPromptOutcome, { kind: 'stopped' }>['facts']['turnUsage']
  modelTurnCount?: number
  modelCalls?: ReadonlyArray<AcpProviderModelCallUsage>
  terminalContextWindow?: AcpTerminalContextWindow
}>

type LogicalTurnUsage = Readonly<{
  turnUsage?: AcpTurnTokenUsage
  modelCalls?: ReadonlyArray<AcpProviderModelCallUsage>
  unavailable?: true
  modelCallsUnavailable?: true
}>

const MAX_LOGICAL_TURN_USAGE_ENTRIES = 500

const inferredCallContextUsedTokens = (call: AcpProviderModelCallUsage): number | undefined => {
  if (call.contextUsedTokens !== undefined) return call.contextUsedTokens
  if (call.cachedReadTokens === undefined) return undefined
  const used = call.inputTokens + call.cachedReadTokens
  return Number.isSafeInteger(used) ? used : undefined
}

const sumTurnUsage = (
  left: AcpTurnTokenUsage,
  right: AcpTurnTokenUsage
): AcpTurnTokenUsage | undefined => {
  const inputTokens = left.inputTokens + right.inputTokens
  const cacheTokens = left.cacheTokens + right.cacheTokens
  const outputTokens = left.outputTokens + right.outputTokens
  const hasCacheBreakdown =
    left.cachedReadTokens !== undefined &&
    left.cachedWriteTokens !== undefined &&
    right.cachedReadTokens !== undefined &&
    right.cachedWriteTokens !== undefined
  const cachedReadTokens = (left.cachedReadTokens ?? 0) + (right.cachedReadTokens ?? 0)
  const cachedWriteTokens = (left.cachedWriteTokens ?? 0) + (right.cachedWriteTokens ?? 0)
  const hasTurnCount = left.turnCount !== undefined && right.turnCount !== undefined
  const turnCount = (left.turnCount ?? 0) + (right.turnCount ?? 0)

  if (
    !Number.isSafeInteger(inputTokens) ||
    !Number.isSafeInteger(cacheTokens) ||
    !Number.isSafeInteger(outputTokens) ||
    !Number.isSafeInteger(cachedReadTokens) ||
    !Number.isSafeInteger(cachedWriteTokens) ||
    !Number.isSafeInteger(turnCount)
  ) {
    return undefined
  }

  return {
    inputTokens,
    cacheTokens,
    ...(hasCacheBreakdown ? { cachedReadTokens, cachedWriteTokens } : {}),
    outputTokens,
    ...(hasTurnCount ? { turnCount } : {})
  }
}

export class AcpPromptOutcomeFinalizer {
  // Detached ask-user replies resume as new provider prompts but keep the original Message identity.
  // Retain a bounded running total so every later stop describes that complete visible user turn.
  private readonly logicalTurnUsage = new Map<string, LogicalTurnUsage>()

  private accumulateTurnUsage(
    sessionId: string,
    promptMessageId: string | undefined,
    turnUsage: AcpTurnTokenUsage | undefined,
    modelCalls: ReadonlyArray<AcpProviderModelCallUsage> | undefined
  ): LogicalTurnUsage {
    if (!promptMessageId) return turnUsage ? { turnUsage } : { unavailable: true }

    const key = `${sessionId.length}:${sessionId}${promptMessageId}`
    const previous = this.logicalTurnUsage.get(key)
    const accumulated =
      !turnUsage || previous?.unavailable
        ? undefined
        : previous?.turnUsage
          ? sumTurnUsage(previous.turnUsage, turnUsage)
          : turnUsage
    const accumulatedModelCalls =
      !accumulated || !modelCalls || previous?.modelCallsUnavailable
        ? undefined
        : previous?.modelCalls
          ? [...previous.modelCalls, ...modelCalls]
          : [...modelCalls]
    const next: LogicalTurnUsage = accumulated
      ? {
          turnUsage: accumulated,
          ...(accumulatedModelCalls
            ? { modelCalls: accumulatedModelCalls }
            : { modelCallsUnavailable: true as const })
        }
      : { unavailable: true, modelCallsUnavailable: true }

    // Refresh insertion order so an active continuation is never the oldest retained entry.
    this.logicalTurnUsage.delete(key)
    this.logicalTurnUsage.set(key, next)
    if (this.logicalTurnUsage.size > MAX_LOGICAL_TURN_USAGE_ENTRIES) {
      const oldestKey = this.logicalTurnUsage.keys().next().value
      if (oldestKey) this.logicalTurnUsage.delete(oldestKey)
    }
    return next
  }

  async finalize(
    handles: AcpPromptFinalizationHandles,
    outcome: AcpPromptFinalizationOutcome
  ): Promise<PromptResponse> {
    let artifactPublished = false
    let artifactRetryAttempted = false
    let skillOutcome: TurnSkillOutcome = 'failed'
    let observedStop: ObservedPromptStop | undefined
    const sessionId = handles.sessionId
    const { context, interaction, interactions, permission } = handles
    const eventIdentity = handles.promptMessageId
      ? { promptMessageId: handles.promptMessageId }
      : {}
    const interactionCurrent = (): boolean => interactions.current(sessionId) === interaction
    const logFields = (data: LogFields): LogFields => ({ sessionId, ...data })
    const clearPermission = (): void => permission.clearCorrelationsForSession(sessionId)
    const safeLog = (level: LogLevel, message: string, data: LogFields): void => {
      try {
        log[level](message, logFields(data))
      } catch {
        // Logging must not replace the outcome being handled.
      }
    }
    const safeCleanup = (message: string, action: () => void): void => {
      try {
        action()
      } catch (error) {
        safeLog('error', message, errorLogFields(error))
      }
    }
    const emitArtifact = async (): Promise<void> => {
      await handles.emitArtifact(() => (artifactPublished = true))
      artifactPublished = true
    }
    const retryArtifact = async (): Promise<void> => {
      artifactRetryAttempted = true
      try {
        await emitArtifact()
      } catch (error) {
        safeLog('error', 'artifact emit after prompt failure failed', errorLogFields(error))
      }
    }
    const publishObservedStop = (): boolean => {
      if (!observedStop) return false
      const terminal = interactions.settle(interaction, {
        ...(observedStop.turnUsage ? { turnUsage: observedStop.turnUsage } : {}),
        ...(observedStop.modelTurnCount === undefined
          ? {}
          : { modelTurnCount: observedStop.modelTurnCount })
      })
      if (!terminal) return false
      const logicalUsage = this.accumulateTurnUsage(
        sessionId,
        handles.promptMessageId,
        terminal.turnUsage,
        observedStop.modelCalls
      )
      const modelCallUsage: AcpModelCallUsage[] | undefined =
        handles.promptMessageId && logicalUsage.modelCalls
          ? logicalUsage.modelCalls.map((call, index) => ({
              id: `${handles.promptMessageId}:model-call:${index}`,
              index,
              ...call
            }))
          : undefined
      handles.pushEvent({
        kind: 'stop',
        level: 'info',
        sessionId,
        ...eventIdentity,
        timestamp: terminal.timestamp,
        title: 'Prompt stopped',
        text: observedStop.response.stopReason,
        turnUsage: logicalUsage.turnUsage,
        ...(modelCallUsage ? { modelCallUsage } : {}),
        ...(observedStop.terminalContextWindow
          ? { terminalContextWindow: observedStop.terminalContextWindow }
          : {}),
        raw: observedStop.response
      })
      return true
    }
    try {
      if (outcome.kind === 'failed') throw outcome.error
      if (outcome.kind === 'superseded') return outcome.response
      if (outcome.kind === 'not-dispatched') {
        skillOutcome = 'cancelled'
        const response: PromptResponse = { stopReason: 'cancelled' }
        const capturedContext = context?.captureTerminal()
        observedStop = {
          response,
          ...(capturedContext
            ? {
                terminalContextWindow: {
                  termination: { kind: 'stop', stopReason: response.stopReason },
                  ...capturedContext
                }
              }
            : {})
        }
        if (!interactions.captureTerminal(interaction, 'cancelled')) return response
        handles.emitUserMessage()
        await emitArtifact()
        safeLog('info', 'prompt stopped', { stopReason: response.stopReason })
        context?.fail()
        publishObservedStop()
        return response
      }
      const { response, facts } = outcome
      skillOutcome = response.stopReason === 'cancelled' ? 'cancelled' : 'completed'
      const providerContextReconciled =
        facts.contextUsedTokens !== undefined && handles.recordContextUsed(facts.contextUsedTokens)
      const capturedContext = context?.captureTerminal(providerContextReconciled)
      observedStop = {
        response,
        ...(facts.turnUsage ? { turnUsage: facts.turnUsage } : {}),
        ...(facts.modelTurnCount === undefined ? {} : { modelTurnCount: facts.modelTurnCount }),
        ...(facts.modelCalls
          ? {
              modelCalls: facts.modelCalls.map((call) => ({
                ...call,
                ...(inferredCallContextUsedTokens(call) === undefined
                  ? {}
                  : { contextUsedTokens: inferredCallContextUsedTokens(call) }),
                ...(capturedContext?.contextWindow.size === undefined
                  ? {}
                  : { contextWindowSize: capturedContext.contextWindow.size })
              }))
            }
          : {}),
        ...(capturedContext
          ? {
              terminalContextWindow: {
                termination: { kind: 'stop', stopReason: response.stopReason },
                ...capturedContext,
                ...(facts.lastModelStepUsage ? { modelStepUsage: facts.lastModelStepUsage } : {})
              }
            }
          : {})
      }
      if (context?.complete()) handles.emitState()
      await emitArtifact()
      safeLog('info', 'prompt stopped', { stopReason: response.stopReason })
      publishObservedStop()
      // Automatic compact is a follow-on provider prompt. Awaiting it here keeps the current
      // sendPrompt admission lease and `promptInFlight` until compact finishes, so a queued
      // follow-up `acp:send-prompt` never replies. Compact after the prompt interaction releases.
      return response
    } catch (error) {
      if (observedStop) {
        context?.complete()
        if (!artifactPublished) await retryArtifact()
        if (publishObservedStop()) {
          safeLog('warn', 'prompt terminal finalization failed', errorLogFields(error))
        }
        throw error
      }
      if (!interactionCurrent()) {
        context?.supersede()
        throw error
      }
      if (!interactions.captureTerminal(interaction, 'error')) throw error
      const capturedContext = context?.captureTerminal()
      context?.fail()
      safeCleanup('skill activity cleanup failed', handles.failPendingSkillActivities)
      safeLog('error', 'prompt failed', errorLogFields(error))
      const text = describePromptError(error, { model: handles.model })
      const recoverable =
        isMediaOverflowError(text) ||
        isMediaOverflowError(handles.errorMessage(error)) ||
        isMediaOverflowError(handles.errorKind(error))
          ? 'context-overflow'
          : undefined
      const terminal = interactions.settle(interaction, {})
      if (!terminal) throw error
      handles.pushEvent({
        kind: 'error',
        level: 'error',
        recoverable,
        providerError: isProviderPromptError(error),
        sessionId,
        ...eventIdentity,
        timestamp: terminal.timestamp,
        title: ACP_PROMPT_FAILED_EVENT_TITLE,
        text,
        ...(capturedContext
          ? {
              terminalContextWindow: {
                termination: { kind: 'error' },
                ...capturedContext
              }
            }
          : {})
      })
      throw error
    } finally {
      safeCleanup('prompt preparation cleanup failed', () => handles.prepared?.close())
      if (!artifactPublished && !artifactRetryAttempted) await retryArtifact()
      try {
        await handles.disposeArtifact()
      } catch (error) {
        safeCleanup('Artifact cleanup event failed', () =>
          handles.pushEvent({
            kind: 'error',
            level: 'error',
            sessionId,
            ...eventIdentity,
            title: 'Artifact cleanup failed',
            text: handles.errorMessage(error)
          })
        )
      }
      const ownsInteraction = interactionCurrent()
      if (ownsInteraction) {
        safeCleanup('interaction pre-release failed', handles.beforeInteractionRelease)
        safeCleanup('permission cleanup failed', clearPermission)
      }
      safeCleanup('context cleanup failed', () => context?.supersede())
      safeCleanup('interaction cleanup failed', () => interactions.release(interaction))
      if (ownsInteraction) {
        safeCleanup('prompt-end callback failed', handles.onPromptEnded)
        try {
          await handles.afterInteractionRelease()
        } catch (error) {
          safeLog('error', 'interaction post-release failed', errorLogFields(error))
        }
      }
      safeCleanup('emitState after prompt turn failed', handles.emitState)
      safeCleanup('prompt skill cleanup failed', () => handles.skill.close(skillOutcome))
      if (handles.skill.reloadDecision.kind === 'continue')
        safeCleanup('activity callback failed', handles.generationActivityChanged)
    }
  }
}
