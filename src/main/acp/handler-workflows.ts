import { createHmac, randomBytes, randomUUID } from 'node:crypto'

import type {
  AcpCreateSessionRequest,
  AcpCreateSessionResponse,
  AcpContinueInterruptedTurnRequest,
  AcpPromptRequest,
  AcpResumeSessionRequest,
  AcpSaveAsSkillRequest,
  AcpStateSnapshot
} from '../../shared/acp'
import { createLogger, diagnosticErrorFields, errorLogFields } from '../logger'
import type { TaskNotificationService } from '../notifications/task-notifications'
import type { AcpCreateSessionWorkflow } from './create-session-workflow'
import { continueInterruptedTurn, SAVE_AS_SKILL_PROMPT } from './interrupted-turn-continuation'
import type { PersistedChatSession } from '../../shared/session-persistence'
import {
  getActiveConversationContext,
  resolveMessageBranchPath
} from '../../shared/conversation-graph'
import { hasCurrentRunningDelegatedAttempt } from '../../shared/delegated-work-projection'
import { buildSessionHistoryReplay } from '../../shared/session-history-replay'
import type { HistoryReplayDescriptor, HistoryReplayTarget } from '../../shared/history-preamble'

const log = createLogger('acp')
const resumeLogHashKey = randomBytes(32)
const SAFE_RESUME_RPC_CODES = new Set([-32700, -32600, -32601, -32602, -32603, -32002])
const SAFE_RESUME_ERROR_KINDS = new Set([
  'resource_not_found',
  'not_found',
  'session_not_found',
  'conversation_not_found',
  'session_missing',
  'conversation_missing',
  'session_resume_failed',
  'conversation_restore_failed'
])
const SAFE_RESUME_SERVICES = new Set(['session', 'provider', 'mcp', 'transport'])
const SAVE_AS_SKILL_REPLAY_TARGETS = new Set<HistoryReplayTarget>([
  'claude-code',
  'opencode',
  'codex-response',
  'codex-bridge'
])

type AcpHandlerWorkflowRuntime = {
  getSnapshot(): AcpStateSnapshot
  hasLiveSession(projectId: string, sessionId: string): boolean
  resumeSession(request: AcpResumeSessionRequest): Promise<AcpCreateSessionResponse>
  sendPrompt(request: AcpPromptRequest): Promise<unknown>
  getLatestUserPrompt(sessionId: string, promptMessageId: string): AcpPromptRequest | undefined
  startContinuation(request: AcpPromptRequest): Promise<void>
}

type PromptNotifications = Pick<TaskNotificationService, 'trackPrompt' | 'untrackPrompt'>

type SessionArchiveAvailability = {
  withSessionAvailable<Result>(
    projectId: string,
    sessionId: string,
    operation: () => Promise<Result>
  ): Promise<Result>
  withSessionAvailableById<Result>(
    sessionId: string,
    operation: () => Promise<Result>
  ): Promise<Result>
}

type AcpHandlerWorkflows = {
  createSession(request: AcpCreateSessionRequest): Promise<AcpCreateSessionResponse>
  resumeSession(request: AcpResumeSessionRequest): Promise<AcpCreateSessionResponse>
  continueInterruptedTurn(request: AcpContinueInterruptedTurnRequest): Promise<AcpStateSnapshot>
  saveAsSkill(request: AcpSaveAsSkillRequest): Promise<AcpStateSnapshot>
  sendPrompt(request: AcpPromptRequest): Promise<AcpStateSnapshot>
}

type InterruptedTurnSessionSource = {
  loadSession(projectId: string, sessionId: string): Promise<PersistedChatSession | undefined>
}

const safeRead = (value: object, key: string): unknown => {
  try {
    return (value as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

const resolveSaveAsSkillReplay = (
  value: unknown
): {
  descriptor: HistoryReplayDescriptor
  supportsImageInput?: boolean
  contextReset: boolean
} => {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Save as skill history replay policy is invalid.')
  }
  const target = safeRead(value, 'target')
  if (
    typeof target !== 'string' ||
    !SAVE_AS_SKILL_REPLAY_TARGETS.has(target as HistoryReplayTarget)
  ) {
    throw new Error('Save as skill history replay target is invalid.')
  }
  const contextWindow = safeRead(value, 'contextWindow')
  if (
    contextWindow !== undefined &&
    (typeof contextWindow !== 'number' || !Number.isFinite(contextWindow) || contextWindow <= 0)
  ) {
    throw new Error('Save as skill history replay context window is invalid.')
  }
  const supportsImageInput = safeRead(value, 'supportsImageInput')
  if (supportsImageInput !== undefined && typeof supportsImageInput !== 'boolean') {
    throw new Error('Save as skill image replay policy is invalid.')
  }
  const contextReset = safeRead(value, 'contextReset')
  if (contextReset !== undefined && contextReset !== true) {
    throw new Error('Save as skill context reset policy is invalid.')
  }

  return {
    descriptor: {
      target: target as HistoryReplayTarget,
      ...(typeof contextWindow === 'number' ? { contextWindow } : {})
    },
    ...(typeof supportsImageInput === 'boolean' ? { supportsImageInput } : {}),
    contextReset: contextReset === true
  }
}

const normalizedDiagnosticToken = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
  return normalized || undefined
}

const resumeSessionHash = (sessionId: string): string =>
  createHmac('sha256', resumeLogHashKey).update(sessionId).digest('hex').slice(0, 12)

const resumeErrorDiagnosticFields = (error: unknown): Record<string, unknown> => {
  const fields: Record<string, unknown> = diagnosticErrorFields(error)
  if (typeof error !== 'object' || error === null) return fields

  const code = safeRead(error, 'code')
  if (typeof code === 'number' && Number.isFinite(code)) {
    fields.rpcCode = SAFE_RESUME_RPC_CODES.has(code) ? code : 'other'
  }

  const data = safeRead(error, 'data')
  if (typeof data !== 'object' || data === null) return fields

  const errorKind = normalizedDiagnosticToken(safeRead(data, 'errorKind'))
  if (errorKind) fields.errorKind = SAFE_RESUME_ERROR_KINDS.has(errorKind) ? errorKind : 'other'
  const service = normalizedDiagnosticToken(safeRead(data, 'service'))
  if (service) fields.service = SAFE_RESUME_SERVICES.has(service) ? service : 'other'
  return fields
}

const logResumeDiagnostic = (
  level: 'info' | 'error',
  message: string,
  data: Record<string, unknown>
): void => {
  try {
    log[level](message, data)
  } catch {
    // Diagnostics must never change the Resume result observed by the caller.
  }
}

// Owns the application side effects shared by Electron and its captured Web compatibility adapter.
// Transport handlers translate untrusted payloads before invoking this narrow interface.
const createAcpHandlerWorkflows = (
  runtime: AcpHandlerWorkflowRuntime,
  createSessionWorkflow: AcpCreateSessionWorkflow,
  taskNotifications?: PromptNotifications,
  archiveAvailability?: SessionArchiveAvailability,
  interruptedTurnSessions?: InterruptedTurnSessionSource
): AcpHandlerWorkflows => ({
  async createSession(request): Promise<AcpCreateSessionResponse> {
    try {
      return await createSessionWorkflow.create(request)
    } catch (error) {
      // Persist create failures without letting a broken diagnostic sink mask the authoritative error.
      try {
        log.error('acp:create-session failed', errorLogFields(error))
      } catch {
        /* diagnostics must never mask the real error */
      }
      throw error
    }
  },

  async resumeSession(request): Promise<AcpCreateSessionResponse> {
    const startedAt = Date.now()
    const context = {
      operationId: randomUUID(),
      sessionHash: resumeSessionHash(request.sessionId)
    }
    logResumeDiagnostic('info', 'acp:resume-session started', context)

    try {
      const resume = (): Promise<AcpCreateSessionResponse> => runtime.resumeSession(request)
      const result = archiveAvailability
        ? request.projectName
          ? await archiveAvailability.withSessionAvailable(
              request.projectName,
              request.sessionId,
              resume
            )
          : await archiveAvailability.withSessionAvailableById(request.sessionId, resume)
        : await resume()
      logResumeDiagnostic('info', 'acp:resume-session completed', {
        ...context,
        durationMs: Math.max(0, Date.now() - startedAt),
        frameworkId: result.frameworkId,
        contextReset: result.contextReset === true
      })
      return result
    } catch (error) {
      logResumeDiagnostic('error', 'acp:resume-session failed', {
        ...context,
        durationMs: Math.max(0, Date.now() - startedAt),
        ...resumeErrorDiagnosticFields(error)
      })
      throw error
    }
  },

  async continueInterruptedTurn(request): Promise<AcpStateSnapshot> {
    if (!interruptedTurnSessions) {
      throw new Error('Interrupted turn continuation is not available.')
    }
    const run = (): Promise<AcpStateSnapshot> =>
      continueInterruptedTurn(
        {
          runtime,
          loadSession: (projectId, sessionId) =>
            interruptedTurnSessions.loadSession(projectId, sessionId),
          notifications: taskNotifications
        },
        request
      )
    return archiveAvailability
      ? archiveAvailability.withSessionAvailable(request.projectId, request.sessionId, run)
      : run()
  },

  async saveAsSkill(request): Promise<AcpStateSnapshot> {
    const save = async (): Promise<AcpStateSnapshot> => {
      if (!interruptedTurnSessions) throw new Error('Save as skill is not available.')
      const replayPolicy = resolveSaveAsSkillReplay(request.historyReplay)
      const session = await interruptedTurnSessions.loadSession(
        request.projectId,
        request.sessionId
      )
      if (!session || session.projectId !== request.projectId || session.id !== request.sessionId) {
        throw new Error('Save as skill Session is unavailable.')
      }
      const preparedControlRun =
        session.status === 'running' &&
        session.activeRun?.promptMessageId === request.promptMessageId
      const recoveredPreparedControlRun =
        session.resumeRecovery?.kind === 'resume-required' &&
        session.resumeRecovery.promptMessageId === request.promptMessageId &&
        !session.pendingHistoryReplay &&
        runtime.hasLiveSession(session.projectId, session.id)
      if (
        session.pendingHistoryReplay ||
        (session.resumeRecovery && !recoveredPreparedControlRun)
      ) {
        throw new Error('Save as skill requires a prepared Session.')
      }
      if (hasCurrentRunningDelegatedAttempt(session)) {
        throw new Error('Save as skill is unavailable while delegated work is still running.')
      }
      const graph = session.conversationGraph
      const frame = graph?.frames.find(({ id }) => id === graph.activeFrameId)
      if (
        !graph ||
        !frame ||
        frame.id !== request.agentFrameId ||
        frame.activeBranchId !== request.messageBranchId
      ) {
        throw new Error('Save as skill stopped because the active conversation branch changed.')
      }
      const activeBranchMessages = resolveMessageBranchPath(graph, frame.activeBranchId)
      const controlMessage = activeBranchMessages.at(-1)
      const previousMessage = activeBranchMessages.at(-2)
      if (
        (!preparedControlRun && !recoveredPreparedControlRun) ||
        controlMessage?.id !== request.promptMessageId ||
        controlMessage.role !== 'user' ||
        controlMessage.turnIntent !== 'save-as-skill' ||
        previousMessage?.role !== 'agent' ||
        previousMessage.status !== 'complete'
      ) {
        throw new Error('Save as skill requires a prepared control turn.')
      }
      const historyReplay = buildSessionHistoryReplay(
        activeBranchMessages
          .slice(0, -1)
          .filter((message) => message.turnIntent !== 'save-as-skill'),
        replayPolicy.descriptor,
        session.projectId,
        replayPolicy.supportsImageInput
      )
      if (!historyReplay) {
        throw new Error('Save as skill conversation history could not be replayed.')
      }
      await runtime.sendPrompt({
        sessionId: session.id,
        text: SAVE_AS_SKILL_PROMPT,
        suppressUserMessage: true,
        forcedSkillIds: ['customize'],
        provenanceContext: getActiveConversationContext(graph, request.promptMessageId),
        resumeFallback: {
          historyPreamble: historyReplay.historyPreamble,
          historyAttachments: historyReplay.historyAttachments,
          historyImages: historyReplay.historyImages
        },
        ...(replayPolicy.contextReset
          ? {
              historyPreamble: historyReplay.historyPreamble,
              historyAttachments: historyReplay.historyAttachments,
              historyImages: historyReplay.historyImages,
              contextReset: true
            }
          : {})
      })
      return runtime.getSnapshot()
    }
    return archiveAvailability
      ? archiveAvailability.withSessionAvailable(request.projectId, request.sessionId, save)
      : save()
  },

  async sendPrompt(request): Promise<AcpStateSnapshot> {
    // Track before invoking so the terminal event can name this prompt. A rejected admission rolls
    // back only its own token, preserving any older in-flight prompt tracked for the same Session.
    const tracked = taskNotifications?.trackPrompt(request)
    try {
      await runtime.sendPrompt(request)
    } catch (error) {
      if (tracked) taskNotifications?.untrackPrompt(request.sessionId, tracked)
      throw error
    }
    return runtime.getSnapshot()
  }
})

export { createAcpHandlerWorkflows }
export type { AcpHandlerWorkflows }
