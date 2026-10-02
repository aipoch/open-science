import type { PrismaClient, SessionReplayProgress } from '@prisma/client'
import {
  replayViewStateSchema,
  sessionDiscussionSnapshotSchema,
  type SessionDiscussionSnapshot,
  type GetSessionDiscussionSnapshotRequest,
  type SessionReplayRequest,
  type ResearchReplayViewSnapshot,
  type SaveResearchReplayViewRequest,
  type SaveResearchReplayViewResult
} from '../../shared/session-replay'

export type SessionReplayClient = Pick<
  PrismaClient,
  '$transaction' | 'project' | 'sessionReplayProgress' | 'sessionDiscussionSnapshot'
>
export type SessionReplayClientProvider = () => Promise<SessionReplayClient>
export const replayViewSnapshot = (
  row: SessionReplayProgress | null
): ResearchReplayViewSnapshot | undefined => {
  if (!row?.stateJson || row.revision <= 0) return undefined
  try {
    return {
      state: replayViewStateSchema.parse(JSON.parse(row.stateJson)),
      revision: row.revision
    }
  } catch {
    return undefined
  }
}

export class SessionReplayRepository {
  constructor(readonly getClient: SessionReplayClientProvider) {}

  async saveSelectionSnapshot(context: SessionDiscussionSnapshot): Promise<void> {
    const client = await this.getClient()
    // Parse into a stable key order so a retry with equivalent object-property order is idempotent.
    const contextJson = JSON.stringify(sessionDiscussionSnapshotSchema.parse(context))
    await client.$transaction(async (tx) => {
      const project = await tx.project.findFirst({
        where: { id: context.projectId, deletedAt: null }
      })
      if (!project) throw new Error('The research Project is unavailable.')
      const row = await tx.sessionDiscussionSnapshot.upsert({
        where: { id: context.id },
        create: {
          id: context.id,
          sourceProjectId: context.projectId,
          sourceSessionId: context.sourceSessionId,
          contextJson
        },
        update: {}
      })
      if (row.contextJson !== contextJson)
        throw new Error('The discussion snapshot already contains different context.')
    })
  }

  async getSelectionSnapshot(
    request: GetSessionDiscussionSnapshotRequest
  ): Promise<SessionDiscussionSnapshot | undefined> {
    const client = await this.getClient()
    const row = await client.sessionDiscussionSnapshot.findFirst({
      where: {
        id: request.id,
        sourceProjectId: request.projectId,
        sourceProject: { deletedAt: null }
      }
    })
    return row ? sessionDiscussionSnapshotSchema.parse(JSON.parse(row.contextJson)) : undefined
  }

  async listSelectionSnapshots(
    request: SessionReplayRequest
  ): Promise<SessionDiscussionSnapshot[]> {
    const client = await this.getClient()
    const rows = await client.sessionDiscussionSnapshot.findMany({
      where: {
        sourceProjectId: request.projectId,
        sourceSessionId: request.sourceSessionId,
        sourceProject: { deletedAt: null }
      },
      orderBy: { id: 'asc' }
    })
    return rows.map((row) => sessionDiscussionSnapshotSchema.parse(JSON.parse(row.contextJson)))
  }

  async get(request: SessionReplayRequest): Promise<SessionReplayProgress | null> {
    const client = await this.getClient()
    return client.sessionReplayProgress.findUnique({
      where: {
        projectId_sessionId: { projectId: request.projectId, sessionId: request.sourceSessionId }
      }
    })
  }

  async list(projectId: string): Promise<SessionReplayProgress[]> {
    const client = await this.getClient()
    return client.sessionReplayProgress.findMany({
      where: { projectId, project: { deletedAt: null } },
      orderBy: { sessionId: 'asc' }
    })
  }

  async saveView(request: SaveResearchReplayViewRequest): Promise<SaveResearchReplayViewResult> {
    const client = await this.getClient()
    return client.$transaction(async (tx) => {
      const project = await tx.project.findFirst({
        where: { id: request.projectId, deletedAt: null }
      })
      if (!project) throw new Error('The research Project is unavailable.')
      const identity = { projectId: request.projectId, sessionId: request.sourceSessionId }
      await tx.sessionReplayProgress.upsert({
        where: { projectId_sessionId: identity },
        create: identity,
        update: {}
      })
      const result = await tx.sessionReplayProgress.updateMany({
        where: { ...identity, revision: request.expectedRevision },
        data: { stateJson: JSON.stringify(request.state), revision: { increment: 1 } }
      })
      if (result.count === 1) return { status: 'saved', revision: request.expectedRevision + 1 }
      const row = await tx.sessionReplayProgress.findUnique({
        where: { projectId_sessionId: identity }
      })
      return { status: 'conflict', snapshot: replayViewSnapshot(row) ?? null }
    })
  }
}
