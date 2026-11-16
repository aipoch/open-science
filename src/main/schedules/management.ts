import { ApplicationCommandError } from '../../shared/application-command-contract'
import type { ArchiveCoordinator } from '../archive/coordinator'
import type { SessionPersistenceCommands } from '../session-persistence/coordinator'
import { withDataRootWrite } from '../storage/migration-state'
import type {
  ScheduleCreateRequest,
  ScheduleHistoryRequest,
  ScheduleRun,
  ScheduleEditRequest,
  ScheduleDeleteRequest,
  ScheduleListRequest,
  ScheduleView,
  ScheduleSummary,
  ScheduleTurnOrigin
} from '../../shared/session-schedules'
import type { ScheduleRepository } from './repository'
import { createLogger } from '@aipoch/diagnostics/node'

const log = createLogger('schedule-management')

export class ScheduleManagement {
  constructor(
    private readonly repository: ScheduleRepository,
    private readonly sessions: Pick<SessionPersistenceCommands, 'loadSessionForContinuation'>,
    private readonly archive: ArchiveCoordinator,
    private readonly changed: (projectId: string, sessionId: string | null) => void
  ) {}
  history(request: ScheduleHistoryRequest): Promise<ScheduleRun[]> {
    return this.repository.history(request)
  }
  list(request: ScheduleListRequest, scheduleId?: string): Promise<ScheduleView[]> {
    return this.repository.list(request, scheduleId)
  }
  summaries(request: ScheduleListRequest, scheduleId?: string): Promise<ScheduleSummary[]> {
    return this.repository.list(request, scheduleId, true)
  }
  async get(request: ScheduleHistoryRequest): Promise<ScheduleView | null> {
    const rows = await this.repository.list(
      { projectId: request.projectId, sessionId: request.sessionId ?? undefined },
      request.scheduleId
    )
    return rows.find((row) => row.target.sessionId === request.sessionId) ?? null
  }
  originForOccurrence(
    id: string,
    projectId: string,
    sessionId: string
  ): Promise<ScheduleTurnOrigin> {
    return this.repository.originForOccurrence(id, projectId, sessionId)
  }
  create(
    request: ScheduleCreateRequest,
    guard?: () => void,
    originPromptId?: string
  ): Promise<ScheduleView> {
    const target = request.target
    if (target.sessionId === null)
      return withDataRootWrite(() =>
        this.archive.withProjectAvailable(target.projectId, async () => {
          if (request.draft.action.kind !== 'send_session_message')
            throw new ApplicationCommandError(
              'schedule-target-unavailable',
              'A script requires a Notebook session.'
            )
          const row = await this.repository.create(request, guard)
          log.info('schedule created', {
            scheduleId: row.id,
            projectId: target.projectId,
            actionKind: request.draft.action.kind,
            ruleKind: request.draft.rule.kind,
            independent: true
          })
          this.changed(target.projectId, null)
          return row
        })
      )
    return withDataRootWrite(() =>
      this.archive.withSessionAvailable(target.projectId, target.sessionId, async () => {
        const session = await this.sessions.loadSessionForContinuation(
          target.projectId,
          target.sessionId
        )
        const graph = session.conversationGraph
        if (
          session.archivedAt !== undefined ||
          session.packageOrigin ||
          !graph ||
          graph.activeFrameId !== target.agentFrameId ||
          graph.frames.find((frame) => frame.id === target.agentFrameId)?.activeBranchId !==
            target.messageBranchId
        )
          throw new ApplicationCommandError(
            'schedule-target-unavailable',
            'The scheduled conversation is unavailable or its branch changed.'
          )
        const row = await this.repository.create(request, guard, originPromptId)
        log.info('schedule created', {
          scheduleId: row.id,
          projectId: target.projectId,
          sessionId: target.sessionId,
          actionKind: request.draft.action.kind,
          ruleKind: request.draft.rule.kind,
          independent: false
        })
        this.changed(target.projectId, target.sessionId)
        return row
      })
    )
  }
  delete(request: ScheduleDeleteRequest): Promise<void> {
    return withDataRootWrite(() =>
      this.archive.withProjectAvailable(request.projectId, async () => {
        await this.repository.delete(request)
        log.info('schedule deleted', {
          scheduleId: request.scheduleId,
          projectId: request.projectId,
          sessionId: request.sessionId
        })
        this.changed(request.projectId, request.sessionId)
      })
    )
  }
  edit(request: ScheduleEditRequest, guard?: () => void): Promise<ScheduleView> {
    const edit = async (): Promise<ScheduleView> => {
      const row = await this.repository.edit(request, guard)
      log.info('schedule edited', {
        scheduleId: row.id,
        projectId: request.projectId,
        sessionId: request.sessionId,
        changeKind: request.change.kind,
        revision: row.revision
      })
      this.changed(request.projectId, request.sessionId)
      return row
    }
    return withDataRootWrite(() =>
      request.sessionId === null
        ? this.archive.withProjectAvailable(request.projectId, edit)
        : this.archive.withSessionAvailable(request.projectId, request.sessionId, edit)
    )
  }
}
