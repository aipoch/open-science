import type { PersistedChatSession } from '../../shared/session-persistence'
import {
  researchWorkspaceRequestSchema,
  researchWorkspaceListRequestSchema,
  ensureResearchDiscussionRequestSchema,
  saveResearchReplayViewRequestSchema,
  saveReplayQuestionContextRequestSchema,
  getReplayQuestionContextRequestSchema,
  type SaveReplayQuestionContextRequest,
  type GetReplayQuestionContextRequest,
  type ReplayQuestionContext,
  type ResearchWorkspaceRequest,
  type ResearchWorkspaceListRequest,
  type ResearchWorkspaceSnapshot,
  type EnsureResearchDiscussionRequest,
  type SaveResearchReplayViewRequest,
  type SaveResearchReplayViewResult
} from '../../shared/research-workspace'
import { ResearchWorkspaceRepository, replayViewSnapshot } from './repository'

type SessionRead =
  { status: 'found'; session: PersistedChatSession } | { status: 'missing' | 'unreadable' }
export type ResearchWorkspaceSessions = {
  read(projectId: string, sessionId: string): Promise<SessionRead>
  save(session: PersistedChatSession): Promise<PersistedChatSession>
}
type ProjectAdmission = <T>(projectId: string, operation: () => Promise<T>) => Promise<T>
type DataRootAdmission = <T>(operation: () => Promise<T>) => Promise<T>

export class ResearchWorkspaceService {
  private readonly pending = new Map<string, Promise<unknown>>()
  constructor(
    private readonly repository: ResearchWorkspaceRepository,
    private readonly sessions: ResearchWorkspaceSessions,
    private readonly withProjectAvailable: ProjectAdmission,
    private readonly withDataRootWrite: DataRootAdmission = (operation) => operation()
  ) {}

  async get(input: ResearchWorkspaceRequest): Promise<ResearchWorkspaceSnapshot> {
    const request = researchWorkspaceRequestSchema.parse(input)
    const client = await this.repository.getClient()
    const [project, row, source] = await Promise.all([
      client.project.findFirst({ where: { id: request.projectId, deletedAt: null } }),
      this.repository.get(request),
      this.sessions.read(request.projectId, request.sourceSessionId)
    ])
    const sourceStatus = !project
      ? 'missing'
      : source.status !== 'found'
        ? source.status
        : !source.session.packageOrigin
          ? 'not-imported'
          : project.archivedAt || source.session.archivedAt !== undefined
            ? 'archived'
            : 'available'
    const discussion = row?.discussionSessionId
      ? await this.sessions.read(request.projectId, row.discussionSessionId)
      : undefined
    const discussionDeleted = row?.discussionSessionId
      ? row.discussionState === 'deleted' ||
        (await this.repository.discussionWasDeleted(
          request.projectId,
          row.discussionSessionId,
          discussion?.status === 'missing'
        ))
      : false
    const discussionStatus = !discussion
      ? 'none'
      : discussionDeleted || !project
        ? 'missing'
        : discussion.status !== 'found'
          ? discussion.status === 'missing' && row?.discussionState === 'creating'
            ? 'creating'
            : discussion.status
          : discussion.session.packageOrigin
            ? 'unreadable'
            : project.archivedAt || discussion.session.archivedAt !== undefined
              ? 'archived'
              : 'available'
    return {
      ...request,
      sourceStatus,
      ...(source.status === 'found' ? { sourceTitle: source.session.title } : {}),
      ...(row?.discussionSessionId ? { discussionSessionId: row.discussionSessionId } : {}),
      discussionStatus,
      ...(discussion?.status === 'found' &&
      (discussionStatus === 'available' || discussionStatus === 'archived')
        ? { discussionSession: discussion.session }
        : {}),
      linkRevision: row?.linkRevision ?? 0,
      ...(replayViewSnapshot(row) ? { view: replayViewSnapshot(row) } : {})
    }
  }

  // Sidebar reads use the metadata projection only. A selected entry always revalidates authoritative
  // JSON through get/ensure; an unavailable projection never authorizes creation or execution.
  async list(input: ResearchWorkspaceListRequest): Promise<ResearchWorkspaceSnapshot[]> {
    const { projectId } = researchWorkspaceListRequestSchema.parse(input)
    const client = await this.repository.getClient()
    const [rows, project] = await Promise.all([
      this.repository.list(projectId),
      client.project.findFirst({ where: { id: projectId, deletedAt: null } })
    ])
    if (!project || !rows.length) return []
    const catalog = await client.session.findMany({
      where: {
        projectId,
        id: {
          in: rows.flatMap((row) => [
            row.sourceSessionId,
            ...(row.discussionSessionId ? [row.discussionSessionId] : [])
          ])
        }
      },
      select: { id: true, title: true, archivedAtMs: true, deletedAtMs: true }
    })
    const byId = new Map(catalog.map((session) => [session.id, session]))
    return rows.map((row) => {
      const source = byId.get(row.sourceSessionId)
      const discussion = row.discussionSessionId ? byId.get(row.discussionSessionId) : undefined
      return {
        projectId,
        sourceSessionId: row.sourceSessionId,
        sourceStatus: !source
          ? 'unreadable'
          : source.deletedAtMs !== null
            ? 'missing'
            : project.archivedAt || source.archivedAtMs !== null
              ? 'archived'
              : 'available',
        ...(source ? { sourceTitle: source.title } : {}),
        ...(row.discussionSessionId ? { discussionSessionId: row.discussionSessionId } : {}),
        discussionStatus: !row.discussionSessionId
          ? 'none'
          : row.discussionState === 'deleted' || discussion?.deletedAtMs != null
            ? 'missing'
            : !discussion
              ? row.discussionState === 'creating'
                ? 'creating'
                : 'unreadable'
              : project.archivedAt || discussion.archivedAtMs !== null
                ? 'archived'
                : 'available',
        linkRevision: row.linkRevision,
        ...(replayViewSnapshot(row) ? { view: replayViewSnapshot(row) } : {})
      }
    })
  }

  ensureDiscussion(input: EnsureResearchDiscussionRequest): Promise<ResearchWorkspaceSnapshot> {
    const request = ensureResearchDiscussionRequestSchema.parse(input)
    const identity = { projectId: request.projectId, sourceSessionId: request.sourceSessionId }
    const key = `${request.projectId}:${request.sourceSessionId}`
    const previous = this.pending.get(key) ?? Promise.resolve()
    const operation = previous
      .catch(() => undefined)
      .then(() =>
        this.withProjectAvailable(request.projectId, async () => {
          const current = await this.get(identity)
          if (current.discussionStatus === 'available') {
            const row = await this.repository.get(identity)
            // A JSON save can succeed before its response or the link acknowledgement reaches us.
            if (row?.discussionState === 'creating') await this.repository.complete(row)
            return this.get(identity)
          }
          if (current.discussionStatus === 'archived' || current.discussionStatus === 'unreadable')
            throw new Error('The research Discussion is unavailable or archived.')
          if (current.sourceStatus !== 'available')
            throw new Error('The imported research is unavailable or archived.')
          if (current.discussionStatus === 'missing' && !request.recreateMissing)
            throw new Error(
              'The research Discussion was deleted. Explicitly create a new Discussion to continue.'
            )
          if (request.recreateMissing && current.discussionStatus !== 'missing')
            throw new Error('Only a deleted research Discussion can be replaced.')
          const row = await this.repository.reserve(
            identity,
            request.title ?? current.sourceTitle ?? request.sourceSessionId,
            request.recreateMissing
          )
          if (
            !row.discussionSessionId ||
            row.discussionState !== 'creating' ||
            !row.discussionCreatedAt
          )
            throw new Error('The research Discussion cannot be prepared.')
          const existing = await this.sessions.read(request.projectId, row.discussionSessionId)
          if (existing.status === 'unreadable')
            throw new Error('The research Discussion cannot be read.')
          if (existing.status === 'found' && existing.session.packageOrigin)
            throw new Error('A research Discussion must be writable.')
          if (existing.status === 'missing') {
            // This intentionally contains no source configuration, history, provider identity or live
            // handles. The ordinary first-send path supplies the receiving installation's preferences.
            await this.sessions.save({
              id: row.discussionSessionId,
              projectId: request.projectId,
              title: row.discussionTitle ?? current.sourceTitle ?? request.sourceSessionId,
              cwd: '',
              status: 'idle',
              messages: [],
              createdAt: row.discussionCreatedAt.getTime(),
              updatedAt: row.discussionCreatedAt.getTime()
            })
          }
          await this.repository.complete(row)
          return this.get(identity)
        })
      )
    this.pending.set(key, operation)
    void operation
      .finally(() => {
        if (this.pending.get(key) === operation) this.pending.delete(key)
      })
      .catch(() => undefined)
    return operation
  }

  async saveView(input: SaveResearchReplayViewRequest): Promise<SaveResearchReplayViewResult> {
    const request = saveResearchReplayViewRequestSchema.parse(input)
    return this.withDataRootWrite(async () => {
      const source = await this.sessions.read(request.projectId, request.sourceSessionId)
      if (source.status !== 'found' || !source.session.packageOrigin)
        throw new Error('The imported research cannot be read.')
      return this.repository.saveView(request)
    })
  }

  async saveQuestionContext(input: SaveReplayQuestionContextRequest): Promise<void> {
    const request = saveReplayQuestionContextRequestSchema.parse(input)
    return this.withDataRootWrite(async () => {
      const saved = await this.repository.getQuestionContext({
        projectId: request.projectId,
        id: request.context.id
      })
      // Exact retries remain possible after source removal. A new reference always needs a readable source.
      if (!saved) {
        const source = await this.sessions.read(request.projectId, request.sourceSessionId)
        if (source.status !== 'found' || !source.session.packageOrigin)
          throw new Error('The imported research cannot be read.')
      }
      await this.repository.saveQuestionContext(request.context)
    })
  }

  getQuestionContext(
    input: GetReplayQuestionContextRequest
  ): Promise<ReplayQuestionContext | undefined> {
    return this.repository.getQuestionContext(getReplayQuestionContextRequestSchema.parse(input))
  }

  listQuestionContexts(input: ResearchWorkspaceRequest): Promise<ReplayQuestionContext[]> {
    return this.repository.listQuestionContexts(researchWorkspaceRequestSchema.parse(input))
  }
}
