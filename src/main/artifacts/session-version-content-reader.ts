import type { PrismaClient } from '@prisma/client'
import type { PersistedChatSession } from '../../shared/session-persistence'

export type ResolvePublishedSessionVersionsByContentRequest = {
  projectId: string
  appSessionId: string
  contents: readonly { checksum: string; sizeBytes: number }[]
}
export type PublishedSessionContentVersion = {
  projectId: string
  sessionId: string
  artifactId: string
  versionId: string
  name: string
  checksum: string
  size: number
  mimeType?: string
  state: 'finalized'
  isPublished: true
}

/** Main-only bounded content lookup; no sender identities, paths or cross-Session search. */
export async function readPublishedSessionVersionsByContent(
  dependencies: {
    getClient(): Promise<PrismaClient>
    loadSession?(projectId: string, sessionId: string): Promise<PersistedChatSession | undefined>
  },
  request: ResolvePublishedSessionVersionsByContentRequest
): Promise<PublishedSessionContentVersion[]> {
  const { projectId, appSessionId, contents } = request
  const id = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/
  if (
    !id.test(projectId) ||
    !id.test(appSessionId) ||
    !Array.isArray(contents) ||
    contents.length > 100 ||
    contents.some(
      (content) =>
        !content ||
        !/^[a-f0-9]{64}$/.test(content.checksum) ||
        !Number.isSafeInteger(content.sizeBytes) ||
        content.sizeBytes < 0
    )
  )
    throw new Error('Invalid bounded Session content lookup.')
  const session = await dependencies.loadSession?.(projectId, appSessionId)
  if (session?.projectId !== projectId || session.id !== appSessionId)
    throw new Error('Session ownership authority is unavailable.')
  if (!contents.length) return []
  const client = await dependencies.getClient()
  const scope = { projectId, sessionId: appSessionId }
  const [deleting, sync] = await Promise.all([
    client.projectDeletionIntent.findUnique({ where: { projectId }, select: { projectId: true } }),
    client.managedFileSessionSync.findUnique({
      where: { projectId_sessionId: scope },
      select: { deletedAt: true, deleteOperationId: true }
    })
  ])
  if (deleting || sync?.deletedAt || sync?.deleteOperationId) return []
  const publication = {
    state: 'finalized',
    OR: [{ originKind: { not: 'agent_generated' } }, { managedVisibleAt: { not: null } }]
  }
  const versions = await client.artifactVersion.findMany({
    where: {
      ...publication,
      AND: [
        {
          OR: contents.map(({ checksum, sizeBytes }) => ({
            checksum,
            sizeBytes: BigInt(sizeBytes)
          }))
        }
      ],
      artifact: {
        is: {
          ...scope,
          originSession: { is: { state: 'active', deletedAt: null, deletionOperationId: null } },
          currentVersion: { is: publication }
        }
      }
    },
    select: {
      id: true,
      artifactId: true,
      filename: true,
      checksum: true,
      sizeBytes: true,
      contentType: true
    },
    orderBy: { id: 'asc' },
    take: 1001
  })
  // Never truncate into an apparently unique match.
  if (versions.length > 1000) throw new Error('Session content lookup exceeds its result limit.')
  const deleted = await client.managedFile.findMany({
    where: {
      projectId,
      source: 'artifact',
      sourceFileId: { in: versions.map((version) => version.artifactId) },
      OR: [{ deletedAt: { not: null } }, { deleteOperationId: { not: null } }]
    },
    select: { sourceFileId: true }
  })
  const hidden = new Set(deleted.map((file) => file.sourceFileId))
  return versions
    .filter((version) => !hidden.has(version.artifactId))
    .map((version) => ({
      ...scope,
      artifactId: version.artifactId,
      versionId: version.id,
      name: version.filename,
      checksum: version.checksum,
      size: Number(version.sizeBytes),
      ...(version.contentType ? { mimeType: version.contentType } : {}),
      state: 'finalized',
      isPublished: true
    }))
}
