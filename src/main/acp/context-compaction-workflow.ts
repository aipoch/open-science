import { randomUUID } from 'node:crypto'
import type { ActiveSession, PromptResponse, SessionNotification } from '@agentclientprotocol/sdk'

import type { AcpCompactSessionRequest, AcpRuntimeEvent } from '../../shared/acp'
import type { AgentFramework } from '../agent-framework'
import { createLogger, errorLogFields } from '../logger'
import type { ContextUsageTracker, SessionEstimateInput } from './context-usage-tracker'
import type { AcpPromptContentOwner } from './prompt-content-owner'
import type { RuntimeEventInput } from './runtime-snapshot-owner'
import type {
  AcpPromptSessionInteractionScope,
  AcpSessionInteractionOwner
} from './session-interaction-owner'

type AcpContextCompactionSessions = Readonly<{
  activeSession: (sessionId: string) => ActiveSession | undefined
  currentFramework: () => AgentFramework
}>

type AcpContextCompactionWorkflowOptions = Readonly<{
  sessions: AcpContextCompactionSessions
  interactions: Pick<AcpSessionInteractionOwner, 'claim' | 'current' | 'release' | 'supersede'>
  context: Pick<
    ContextUsageTracker,
    'checkpointSession' | 'resetAfterCompaction' | 'restoreSession' | 'usage'
  >
  promptContent: Pick<AcpPromptContentOwner, 'resetSession'>
  contextEstimateInput: (sessionId: string) => SessionEstimateInput
  selectedContextWindow: (sessionId: string) => number | undefined
  routeHiddenNotification: (notification: SessionNotification, sessionId: string) => void
  pushEvent: (event: RuntimeEventInput) => void
  emitState: () => void
  errorMessage: (error: unknown) => string
}>

type AcpAutomaticCompactionRequest = Readonly<{
  sessionId: string
  session: ActiveSession
  interaction: AcpPromptSessionInteractionScope
}>

type CompactionReason = NonNullable<AcpRuntimeEvent['compactionReason']>

const log = createLogger('acp-context-compaction-workflow')

class AcpContextCompactionWorkflow {
  constructor(private readonly options: AcpContextCompactionWorkflowOptions) {}

  async compact(request: AcpCompactSessionRequest): Promise<PromptResponse> {
    const { interactions, sessions } = this.options
    const session = sessions.activeSession(request.sessionId)
    if (!session) throw new Error(`ACP session not found: ${request.sessionId}`)
    const currentInteraction = interactions.current(request.sessionId)
    if (currentInteraction?.kind === 'compaction') {
      throw new Error('Context compaction is already running for this session')
    }
    if (currentInteraction && request.reason !== 'overflow-recovery') {
      throw new Error('An ACP prompt is already running for this session')
    }
    if (request.reason === 'overflow-recovery' && currentInteraction) {
      interactions.supersede(currentInteraction)
    }

    const interaction = interactions.claim({ sessionId: request.sessionId, kind: 'compaction' })
    try {
      this.safeProjection('compaction state callback failed', this.options.emitState)
      return await this.runNative(session, request.sessionId, request.reason ?? 'manual')
    } finally {
      interactions.release(interaction)
      this.safeProjection('compaction state callback failed', this.options.emitState)
    }
  }

  async compactAutomatic(
    request: AcpAutomaticCompactionRequest
  ): Promise<PromptResponse | undefined> {
    if (
      this.options.interactions.current(request.sessionId) !== request.interaction ||
      this.options.sessions.activeSession(request.sessionId) !== request.session ||
      !this.shouldCompactAutomatically(request.sessionId)
    ) {
      return undefined
    }
    return this.runNative(request.session, request.sessionId, 'automatic')
  }

  async compactIfIdle(sessionId: string): Promise<PromptResponse | undefined> {
    if (this.options.interactions.current(sessionId)) return undefined
    if (!this.shouldCompactAutomatically(sessionId)) return undefined
    const session = this.options.sessions.activeSession(sessionId)
    if (!session) return undefined
    const { interactions } = this.options
    const interaction = interactions.claim({ sessionId, kind: 'compaction' })
    try {
      this.safeProjection('compaction state callback failed', this.options.emitState)
      return await this.runNative(session, sessionId, 'automatic')
    } catch {
      return undefined
    } finally {
      interactions.release(interaction)
      this.safeProjection('compaction state callback failed', this.options.emitState)
    }
  }

  private shouldCompactAutomatically(sessionId: string): boolean {
    const strategy = this.options.sessions.currentFramework().contextCompaction
    if (strategy.kind !== 'native-command' || strategy.triggerAtPercent === undefined) return false
    const usage = this.options.context.usage(sessionId)
    if (!usage || usage.size === undefined || usage.size <= 0 || usage.used < 0) return false
    if (usage.breakdown?.status === 'preflight') return false
    return (usage.used / usage.size) * 100 >= strategy.triggerAtPercent
  }

  private async runNative(
    session: ActiveSession,
    sessionId: string,
    reason: CompactionReason
  ): Promise<PromptResponse> {
    const strategy = this.options.sessions.currentFramework().contextCompaction
    if (strategy.kind !== 'native-command') {
      throw new Error(
        `${this.options.sessions.currentFramework().displayName} manages context compaction automatically.`
      )
    }
    const checkpoint = this.options.context.checkpointSession(sessionId)
    const restoreContext = (): void => this.options.context.restoreSession(sessionId, checkpoint)
    const toolCallId = `context-compaction:${randomUUID()}`
    this.publishEvent({
      kind: 'compaction',
      compactionReason: reason,
      level: 'info',
      sessionId,
      status: 'in_progress',
      title: 'Compacting context',
      toolCallId
    })

    try {
      let failureText: string | undefined
      const promptFailure = new Promise<never>((_, reject) => {
        session.prompt([{ type: 'text', text: strategy.command }]).catch(reject)
      })
      for (;;) {
        const message = await Promise.race([session.nextUpdate(), promptFailure])
        if (message.kind === 'stop') {
          if (message.response.stopReason === 'cancelled') {
            restoreContext()
            this.publishEvent({
              kind: 'compaction',
              compactionReason: reason,
              level: 'info',
              sessionId,
              status: 'cancelled',
              title: 'Context compaction cancelled',
              toolCallId
            })
            return message.response
          }
          if (message.response.stopReason !== 'end_turn') {
            throw new Error(
              `Context compaction stopped before completion: ${message.response.stopReason}`
            )
          }
          if (failureText) throw new Error(failureText)
          this.options.context.resetAfterCompaction(
            sessionId,
            this.options.contextEstimateInput(sessionId),
            checkpoint,
            this.options.selectedContextWindow(sessionId)
          )
          this.options.promptContent.resetSession(sessionId)
          this.publishEvent({
            kind: 'compaction',
            compactionReason: reason,
            level: 'info',
            sessionId,
            status: 'completed',
            title: 'Context compacted',
            toolCallId
          })
          return message.response
        }

        const update = message.notification.update
        if (
          !failureText &&
          strategy.failureTextPrefix &&
          update.sessionUpdate === 'agent_message_chunk' &&
          update.content.type === 'text' &&
          update.content.text.trimStart().startsWith(strategy.failureTextPrefix)
        ) {
          failureText = update.content.text.trim()
        }
        this.options.routeHiddenNotification(message.notification, sessionId)
      }
    } catch (error) {
      restoreContext()
      this.publishEvent({
        kind: 'compaction',
        compactionReason: reason,
        level: 'error',
        sessionId,
        status: 'failed',
        title: 'Context compaction failed',
        text: this.options.errorMessage(error),
        toolCallId
      })
      throw error
    }
  }

  private publishEvent(event: RuntimeEventInput): void {
    this.safeProjection('compaction event callback failed', () => this.options.pushEvent(event))
  }

  private safeProjection(message: string, action: () => void): void {
    try {
      action()
    } catch (error) {
      try {
        log.error(message, errorLogFields(error))
      } catch {
        // Diagnostics must not replace the compaction lifecycle.
      }
    }
  }
}

export { AcpContextCompactionWorkflow }
export type { AcpAutomaticCompactionRequest, AcpContextCompactionWorkflowOptions }
