import { createLogger, diagnosticErrorFields } from '@aipoch/diagnostics/node'
import { normalizePermissionProfile } from '../../shared/permission-profiles'
import type { ScheduleRunSessions } from './run-session'
import { scheduleScriptSubmissionId } from '../background-result-delivery/notebook-adapter'
import { markTrustedNotebookBindingPermissionPrompts } from '../notebook/runtime-binding-admission'
import type { SessionPersistenceCommands } from '../session-persistence/coordinator'
import type { NotebookRuntimeService } from '../notebook/runtime-service'
import { NotebookBackgroundRunError } from '../../shared/notebook'
import { getActiveConversationContext } from '../../shared/conversation-graph'
import { scheduleActionSchema } from '../../shared/session-schedules'
import type { createAcpRuntime } from '../acp/runtime-composition'
import {
  freshSessionAttachment,
  type SessionAgentTargetResolver
} from '../acp/session-agent-target'
import type { ArchiveCoordinator } from '../archive/coordinator'
import type { ScheduleExecution } from './dispatcher'
import { SessionPromptAdmissionError } from '../acp/runtime-activity-port'
import { ScheduleBusyError, ScheduleObservationError, ScheduleRejectedError } from './dispatcher'

type Dependencies = {
  runSessions: Pick<ScheduleRunSessions, 'prepare' | 'find'>
  sessions: Pick<SessionPersistenceCommands, 'loadSessionForContinuation'>
  runtime: Pick<
    ReturnType<typeof createAcpRuntime>,
    'getState' | 'hasLiveSession' | 'resumeSession' | 'sendApplicationPrompt'
  >
  notebook: Pick<
    NotebookRuntimeService,
    'getBackgroundRun' | 'executeBackground' | 'executeShellBackground'
  >
  archive: Pick<ArchiveCoordinator, 'assertSessionAvailable' | 'admitSessionWork'>
  resolveAgentTarget: SessionAgentTargetResolver
}
export function createScheduleExecution({
  sessions,
  runSessions,
  runtime,
  notebook,
  archive,
  resolveAgentTarget
}: Dependencies): ScheduleExecution {
  return {
    async inspect(work) {
      const { projectId } = work.schedule
      const sessionId = work.schedule.sessionId ?? work.runSessionId
      if (!sessionId) throw new Error('Missing scheduled run session identity.')
      // Inspection must not quarantine a Session or mistake an unreadable file for missing evidence.
      const session = await runSessions.find(projectId, sessionId).catch((cause) => {
        throw new ScheduleObservationError('Scheduled Session evidence is unavailable.', { cause })
      })
      if (!session) return { kind: 'missing' }
      if (work.promptMessageId) {
        const message = session.conversationGraph?.messages.find(
          (m) => m.id === work.promptMessageId
        )
        if (!message) return { kind: 'missing' }
        if (
          message.attribution?.feature !== 'schedule' ||
          message.attribution.occurrenceId !== work.id ||
          (work.schedule.messageBranchId !== null &&
            message.introducedOnBranchId !== work.schedule.messageBranchId)
        )
          throw new Error('The scheduled message identity conflicts with its occurrence.')
        const outcome = message.turnOutcome
        if (outcome)
          return {
            kind: outcome.kind === 'completed' ? 'succeeded' : 'failed',
            reason:
              outcome.kind === 'completed'
                ? undefined
                : outcome.kind === 'cancelled'
                  ? 'cancelled'
                  : 'failed'
          }
        return session.activeRun?.promptMessageId === message.id
          ? {
              kind: 'running',
              waiting: ['waiting-permission', 'waiting-plan-approval', 'waiting-for-user'].includes(
                session.status
              )
            }
          : { kind: 'failed', reason: 'interrupted' }
      }
      try {
        const result = await notebook.getBackgroundRun({
          projectId,
          sessionId,
          workspaceCwd: session.cwd,
          submissionIdentity: scheduleScriptSubmissionId(work.id),
          ...(work.scriptRunId ? { runId: work.scriptRunId } : {})
        })
        const status = result.receipt.status
        const error =
          status === 'failed' ? result.run?.outputs?.findLast((o) => o.type === 'error') : undefined
        if (error?.message)
          createLogger('schedule-execution').warn('scheduled script failed', {
            scheduleId: work.scheduleId,
            occurrenceId: work.id,
            runId: result.receipt.runId,
            ...diagnosticErrorFields(new Error(error.message))
          })
        return {
          kind:
            status === 'queued' || status === 'running'
              ? 'running'
              : status === 'completed'
                ? 'succeeded'
                : 'failed',
          runId: result.receipt.runId,
          reason: status === 'failed' ? 'failed' : status === 'cancelled' ? 'cancelled' : undefined
        }
      } catch (error) {
        if (
          error instanceof NotebookBackgroundRunError &&
          error.detail.code === 'BACKGROUND_RUN_NOT_FOUND'
        )
          return { kind: 'missing' }
        if (
          error instanceof NotebookBackgroundRunError &&
          error.detail.stage === 'query' &&
          error.detail.retryable
        )
          throw new ScheduleObservationError(error.message, { cause: error })
        throw error
      }
    },
    async dispatch(work, authorize, assertPreparationCurrent) {
      const { projectId } = work.schedule
      const sessionId = work.schedule.sessionId ?? work.runSessionId
      if (!sessionId) throw new Error('Missing scheduled run session identity.')
      if (work.runSessionId)
        await runSessions.prepare(
          projectId,
          sessionId,
          work.schedule.name,
          assertPreparationCurrent,
          normalizePermissionProfile(work.schedule.permissionProfile)
        )
      await archive.assertSessionAvailable(projectId, sessionId)
      const release = archive.admitSessionWork(projectId, sessionId)
      try {
        const session = await sessions.loadSessionForContinuation(projectId, sessionId)
        if (session.archivedAt !== undefined || session.packageOrigin)
          throw new Error('The scheduled conversation is no longer writable.')
        const action = scheduleActionSchema.parse(JSON.parse(work.actionSnapshot))
        if (action.kind === 'run_script') {
          const request = markTrustedNotebookBindingPermissionPrompts(
            {
              projectId,
              sessionId,
              workspaceCwd: session.cwd,
              background: true,
              executionInvocationId: scheduleScriptSubmissionId(work.id),
              timeoutMs: action.timeoutMs
            },
            'none'
          )
          await authorize()
          const receipt =
            action.language === 'shell'
              ? await notebook.executeShellBackground({ ...request, command: action.code })
              : await notebook.executeBackground({
                  ...request,
                  code: action.code,
                  language: action.language
                })
          return { kind: 'running', runId: receipt.runId }
        }
        if (!work.promptMessageId) throw new Error('Missing scheduled prompt identity.')
        if (
          session.activeRun ||
          session.promptPreparation ||
          session.resumeRecovery ||
          session.status.startsWith('waiting-') ||
          runtime.getState().promptInFlightSessionIds.includes(sessionId)
        )
          throw new ScheduleBusyError('The conversation is busy.')
        if (!session.conversationGraph)
          throw new Error('This conversation has no durable message branch.')
        const context = getActiveConversationContext(
          session.conversationGraph,
          work.promptMessageId
        )
        const agentFrameId = work.schedule.agentFrameId ?? session.conversationGraph.rootFrameId
        const messageBranchId =
          work.schedule.messageBranchId ??
          session.conversationGraph.branches.find(
            (b) => b.agentFrameId === agentFrameId && !b.parentBranchId
          )?.id
        if (context.agentFrameId !== agentFrameId || context.messageBranchId !== messageBranchId)
          throw new Error('The scheduled conversation branch has changed.')
        if (!runtime.hasLiveSession(projectId, sessionId)) {
          const agentTarget = await resolveAgentTarget(session)
          await runtime.resumeSession({
            sessionId,
            projectId,
            cwd: session.cwd,
            providerSessionId: session.providerSessionId,
            providerContinuityToken: session.providerContinuityToken,
            permissionProfile: session.permissionProfile,
            memoryEnabled: session.memoryEnabled !== false,
            ...(work.runSessionId && !session.providerSessionId && !session.messages.length
              ? { [freshSessionAttachment]: true }
              : {}),
            previousFrameworkId: session.agentFrameworkId,
            previousBackendId: session.agentBackendId,
            specialistId: session.specialistId,
            ...(session.specialistBindingPending ? { specialistBindingPending: true } : {}),
            agentTarget
          })
        }
        const latest = await sessions.loadSessionForContinuation(projectId, sessionId)
        if (!latest.conversationGraph)
          throw new Error('The scheduled conversation path is unavailable.')
        const provenanceContext = getActiveConversationContext(
          latest.conversationGraph,
          work.promptMessageId
        )
        if (
          provenanceContext.agentFrameId !== agentFrameId ||
          provenanceContext.messageBranchId !== messageBranchId
        )
          throw new Error('The scheduled conversation branch changed during restoration.')
        await runtime.sendApplicationPrompt(
          { sessionId, text: action.message, provenanceContext, permissionPrompts: 'none' },
          {
            kind: 'application',
            feature: 'schedule',
            purpose: 'scheduled-wake',
            scheduleId: work.scheduleId,
            occurrenceId: work.id,
            scheduledAt: work.scheduledAt.getTime()
          },
          { beforeSessionWrite: () => authorize(latest.revision) }
        )
        return await this.inspect(work)
      } catch (error) {
        if (error instanceof SessionPromptAdmissionError)
          throw new ScheduleRejectedError(error.message, true, { cause: error })
        if (
          error instanceof NotebookBackgroundRunError &&
          error.detail.stage === 'pre-admission' &&
          !error.detail.retryable
        )
          throw new ScheduleRejectedError(error.message, false, { cause: error })
        throw error
      } finally {
        release()
      }
    }
  }
}
