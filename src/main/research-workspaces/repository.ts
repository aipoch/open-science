import { randomUUID } from 'node:crypto'
import type { PrismaClient, ResearchWorkspace } from '@prisma/client'
import {
  replayViewStateSchema,
  replayQuestionContextSchema,
  type ReplayQuestionContext,
  type GetReplayQuestionContextRequest,
  type ResearchWorkspaceRequest,
  type ResearchReplayViewSnapshot,
  type SaveResearchReplayViewRequest,
  type SaveResearchReplayViewResult
} from '../../shared/research-workspace'

export type ResearchWorkspaceClient = Pick<
  PrismaClient,
  | '$transaction'
  | 'project'
  | 'session'
  | 'pendingSessionReconciliation'
  | 'researchWorkspace'
  | 'replayQuestionContext'
>
export type ResearchWorkspaceClientProvider = () => Promise<ResearchWorkspaceClient>
export const replayViewSnapshot = (
  row: ResearchWorkspace | null
): ResearchReplayViewSnapshot | undefined => {
  if (!row?.viewJson || row.viewRevision <= 0) return undefined
  try {
    return {
      state: replayViewStateSchema.parse(JSON.parse(row.viewJson)),
      revision: row.viewRevision
    }
  } catch {
    return undefined
  }
}

export class ResearchWorkspaceRepository {
  constructor(readonly getClient: ResearchWorkspaceClientProvider) {}

  async saveQuestionContext(context: ReplayQuestionContext): Promise<void> {
    const client = await this.getClient()
    // Parse into a stable key order so a retry with equivalent object-property order is idempotent.
    const contextJson = JSON.stringify(replayQuestionContextSchema.parse(context))
    await client.$transaction(async (tx) => {
      const project = await tx.project.findFirst({
        where: { id: context.projectId, deletedAt: null }
      })
      if (!project) throw new Error('The research Project is unavailable.')
      const row = await tx.replayQuestionContext.upsert({
        where: { id: context.id },
        create: {
          id: context.id,
          projectId: context.projectId,
          sourceSessionId: context.sourceSessionId,
          contextJson
        },
        update: {}
      })
      if (row.contextJson !== contextJson)
        throw new Error('The Replay question reference already contains different context.')
    })
  }

  async getQuestionContext(
    request: GetReplayQuestionContextRequest
  ): Promise<ReplayQuestionContext | undefined> {
    const client = await this.getClient()
    const row = await client.replayQuestionContext.findFirst({
      where: { ...request, project: { deletedAt: null } }
    })
    return row ? replayQuestionContextSchema.parse(JSON.parse(row.contextJson)) : undefined
  }

  async listQuestionContexts(request: ResearchWorkspaceRequest): Promise<ReplayQuestionContext[]> {
    const client = await this.getClient()
    const rows = await client.replayQuestionContext.findMany({
      where: { ...request, project: { deletedAt: null } },
      orderBy: { id: 'asc' }
    })
    return rows.map((row) => replayQuestionContextSchema.parse(JSON.parse(row.contextJson)))
  }

  async get(request: ResearchWorkspaceRequest): Promise<ResearchWorkspace | null> {
    const client = await this.getClient()
    return client.researchWorkspace.findUnique({ where: { projectId_sourceSessionId: request } })
  }

  async list(projectId: string): Promise<ResearchWorkspace[]> {
    const client = await this.getClient()
    return client.researchWorkspace.findMany({
      where: { projectId, project: { deletedAt: null } },
      orderBy: { sourceSessionId: 'asc' }
    })
  }

  async discussionWasDeleted(
    projectId: string,
    sessionId: string,
    authorityMissing: boolean
  ): Promise<boolean> {
    const client = await this.getClient()
    const tombstone = await client.session.findFirst({
      where: { id: sessionId, projectId, deletedAtMs: { not: null } },
      select: { id: true }
    })
    if (tombstone) return true
    // The Session owner persists this intent before unlinking JSON. It closes the crash window
    // before projection commit / deletion callbacks have written their final tombstones.
    if (!authorityMissing) return false
    return Boolean(
      await client.pendingSessionReconciliation.findFirst({
        where: { sessionId, projectId, operation: 'delete' },
        select: { sessionId: true }
      })
    )
  }

  async reserve(
    request: ResearchWorkspaceRequest,
    title: string,
    replace?: { expectedDiscussionSessionId: string; expectedRevision: number }
  ): Promise<ResearchWorkspace> {
    const client = await this.getClient()
    return client.$transaction(async (tx) => {
      const project = await tx.project.findFirst({
        where: { id: request.projectId, deletedAt: null, archivedAt: null }
      })
      if (!project) throw new Error('The research Project is unavailable or archived.')
      const row = await tx.researchWorkspace.upsert({
        where: { projectId_sourceSessionId: request },
        create: request,
        update: {}
      })
      if (
        replace &&
        (row.discussionSessionId !== replace.expectedDiscussionSessionId ||
          row.linkRevision !== replace.expectedRevision)
      )
        throw new Error('The research Discussion changed. Reload before creating a replacement.')
      if (row.discussionSessionId && !replace) return row
      return tx.researchWorkspace.update({
        where: { projectId_sourceSessionId: request },
        data: {
          discussionSessionId: randomUUID(),
          discussionState: 'creating',
          discussionTitle: title,
          discussionCreatedAt: new Date(),
          linkRevision: { increment: 1 }
        }
      })
    })
  }

  async complete(row: ResearchWorkspace): Promise<void> {
    const client = await this.getClient()
    const result = await client.researchWorkspace.updateMany({
      where: {
        projectId: row.projectId,
        sourceSessionId: row.sourceSessionId,
        discussionSessionId: row.discussionSessionId,
        discussionState: 'creating',
        linkRevision: row.linkRevision
      },
      data: { discussionState: 'ready', linkRevision: { increment: 1 } }
    })
    if (result.count !== 1) throw new Error('The research Discussion changed during creation.')
  }

  async saveView(request: SaveResearchReplayViewRequest): Promise<SaveResearchReplayViewResult> {
    const client = await this.getClient()
    return client.$transaction(async (tx) => {
      const project = await tx.project.findFirst({
        where: { id: request.projectId, deletedAt: null }
      })
      if (!project) throw new Error('The research Project is unavailable.')
      const identity = { projectId: request.projectId, sourceSessionId: request.sourceSessionId }
      await tx.researchWorkspace.upsert({
        where: { projectId_sourceSessionId: identity },
        create: identity,
        update: {}
      })
      const result = await tx.researchWorkspace.updateMany({
        where: { ...identity, viewRevision: request.expectedRevision },
        data: { viewJson: JSON.stringify(request.state), viewRevision: { increment: 1 } }
      })
      if (result.count === 1) return { status: 'saved', revision: request.expectedRevision + 1 }
      const row = await tx.researchWorkspace.findUnique({
        where: { projectId_sourceSessionId: identity }
      })
      return { status: 'conflict', snapshot: replayViewSnapshot(row) ?? null }
    })
  }

  // Retain identity for recovery/UI, but never resurrect a deliberately deleted pending Discussion.
  async sessionsDeleted(sessionIds: readonly string[]): Promise<void> {
    if (!sessionIds.length) return
    const client = await this.getClient()
    await client.researchWorkspace.updateMany({
      where: { discussionSessionId: { in: [...sessionIds] }, discussionState: { not: 'deleted' } },
      data: { discussionState: 'deleted', linkRevision: { increment: 1 } }
    })
  }
}
