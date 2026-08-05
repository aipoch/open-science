import type { PromptResponse } from '@agentclientprotocol/sdk'

import { ACP_PROMPT_FAILED_EVENT_TITLE, type AcpRuntimeEvent } from '../../shared/acp'
import { isMediaOverflowError } from '../../shared/media-overflow'
import { createLogger, errorLogFields } from '../logger'
import type { ContextUsageTurnHandle } from './context-usage-tracker'
import type { AcpPermissionContext } from './permission-context'
import type { PreparedPromptHandle } from './prompt-preparation-owner'
import { describePromptError, isProviderPromptError } from './prompt-error'
import type { ProviderPromptOutcome } from './provider-prompt-executor'
import type { AcpPromptSessionInteractionScope } from './session-interaction-owner'
import type { AcpSessionInteractionOwner as InteractionOwner } from './session-interaction-owner'
import type { TurnSkillHandle, TurnSkillOutcome } from './turn-skill-owner'
const log = createLogger('acp')
type LogFields = Record<string, unknown>
type LogLevel = 'error' | 'info' | 'warn'
type RuntimeEventInput = Omit<AcpRuntimeEvent, 'id' | 'timestamp'> & Partial<AcpRuntimeEvent>
export type AcpPromptFinalizationOutcome =
  ProviderPromptOutcome | Readonly<{ kind: 'failed'; error: unknown }>
export type AcpPromptFinalizationHandles = Readonly<{
  sessionId: string
  promptMessageId?: string
  interaction: AcpPromptSessionInteractionScope
  interactions: Pick<InteractionOwner, 'captureTerminal' | 'current' | 'release' | 'settle'>
  permission: Pick<AcpPermissionContext, 'clearCorrelationsForSession'>
  prepared?: Pick<PreparedPromptHandle, 'close'>
  context?: ContextUsageTurnHandle
  skill: Pick<TurnSkillHandle, 'close' | 'reloadDecision'>
  model?: string
  emitUserMessage: () => void
  emitArtifact: (onPublished: () => void) => Promise<void>
  disposeArtifact: () => Promise<void>
  failPendingSkillActivities: () => void
  recordContextUsed: (used: number) => void
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
}>
export class AcpPromptOutcomeFinalizer {
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
      handles.pushEvent({
        kind: 'stop',
        level: 'info',
        sessionId,
        ...eventIdentity,
        timestamp: terminal.timestamp,
        title: 'Prompt stopped',
        text: observedStop.response.stopReason,
        turnUsage: terminal.turnUsage,
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
        observedStop = { response }
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
      observedStop = {
        response,
        ...(facts.turnUsage ? { turnUsage: facts.turnUsage } : {}),
        ...(facts.modelTurnCount === undefined ? {} : { modelTurnCount: facts.modelTurnCount })
      }
      if (facts.contextUsedTokens !== undefined) handles.recordContextUsed(facts.contextUsedTokens)
      if (context?.complete()) handles.emitState()
      await emitArtifact()
      safeLog('info', 'prompt stopped', { stopReason: response.stopReason })
      publishObservedStop()
      try {
        await handles.autoCompactIfNeeded()
      } catch (error) {
        safeLog('warn', 'automatic context compaction failed', errorLogFields(error))
      }
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
        text
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
        try {
          await handles.afterInteractionRelease()
        } catch (error) {
          safeLog('error', 'interaction post-release failed', errorLogFields(error))
        }
        safeCleanup('prompt-end callback failed', handles.onPromptEnded)
      }
      safeCleanup('emitState after prompt turn failed', handles.emitState)
      safeCleanup('prompt skill cleanup failed', () => handles.skill.close(skillOutcome))
      if (handles.skill.reloadDecision.kind === 'continue')
        safeCleanup('activity callback failed', handles.generationActivityChanged)
    }
  }
}
