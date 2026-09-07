import { randomUUID } from 'node:crypto'

import type { PersistedChatSession } from '../../shared/session-persistence'
import type { ProjectFileSource } from '../../shared/project-files'
import { PENDING_UPLOAD_SESSION_ID } from '../../shared/uploads'
import { createLogger } from '../logger'
import {
  buildProjectCollisionFilters,
  describeError,
  extractSessionFiles,
  type LegacyArtifactVersionAdopter,
  type LegacyUploadVersionUpgrader,
  fileIdentity,
  getChangedSources,
  isFileProjectionCurrent,
  normalizeRevision,
  sessionKey,
  type IndexedFileInput,
  type ProjectFilesClient,
  type ProjectFilesClientProvider
} from './mutation-projection'

const log = createLogger('project-files')

// Valid persisted revisions are non-negative. A collision loser stores this sentinel so it cannot
// take the revision fast path and can claim the canonical row after its current owner is deleted.
const RETRYABLE_COLLISION_REVISION = -1

type ManagedFileSoftDeleteToken = string
type ManagedFileSyncOptions = { force?: boolean }

// Callers must not widen failures already recorded against known projects into a global outage.
class ProjectFilesReconciliationError extends AggregateError {
  constructor(
    errors: unknown[],
    readonly projectIds: readonly string[]
  ) {
    super(errors, 'Project file reconciliation failed.')
  }
}

// Owns every Project Files projection mutation and its completeness state. The public repository
// delegates here while retaining the stable caller interface and the query orchestration for FI2.
class ProjectFilesMutationOwner {
  private readonly incompleteSessions = new Map<string, string>()
  private readonly incompleteProjects = new Set<string>()
  private isReconciliationIncomplete = false

  constructor(
    private readonly getClient: ProjectFilesClientProvider,
    private readonly dataRoot: string,
    private readonly legacyArtifactVersionAdopter: LegacyArtifactVersionAdopter,
    private readonly legacyUploadVersionUpgrader: LegacyUploadVersionUpgrader
  ) {}

  async syncSession(
    session: PersistedChatSession,
    options: ManagedFileSyncOptions = {}
  ): Promise<ProjectFileSource[]> {
    try {
      const client = await this.getClient()
      const revision = normalizeRevision(session.filesRevision)
      const currentSync = await client.managedFileSessionSync.findUnique({
        where: { projectId_sessionId: { projectId: session.projectId, sessionId: session.id } }
      })
      if (
        !options.force &&
        currentSync?.filesRevision === revision &&
        currentSync.deletedAt === null &&
        (await isFileProjectionCurrent(client, session.projectId, session.id))
      ) {
        this.incompleteSessions.delete(sessionKey(session.projectId, session.id))
        return []
      }

      const hasLegacyUploadReferences = [
        ...session.messages,
        ...(session.conversationGraph?.messages ?? [])
      ].some((message) =>
        message.uploads?.some(
          (upload) => !upload.versionId && upload.sessionId !== PENDING_UPLOAD_SESSION_ID
        )
      )
      const projectionBeforeUpgrade = hasLegacyUploadReferences
        ? await client.managedFile.findMany({
            where: { projectId: session.projectId, sessionId: session.id }
          })
        : undefined
      if (hasLegacyUploadReferences) {
        session = await this.legacyUploadVersionUpgrader.upgradeLegacySessionUploads(session, {
          mode: 'project-files-sync'
        })
      }

      const extraction = await extractSessionFiles(
        this.getClient,
        this.dataRoot,
        this.legacyArtifactVersionAdopter,
        session
      )
      const { files } = extraction
      const hasIncompleteFiles = extraction.errors.length > 0
      const now = new Date()

      const changedSources = await client.$transaction(async (tx) => {
        const existingRows = await tx.managedFile.findMany({
          where: { projectId: session.projectId, sessionId: session.id }
        })
        const collisionFilters = buildProjectCollisionFilters(files)
        const collisionRows =
          collisionFilters.length > 0
            ? await tx.managedFile.findMany({
                where: { projectId: session.projectId, OR: collisionFilters }
              })
            : []
        const rowsById = new Map(
          collisionRows.map((row) => [fileIdentity(row.source, row.sourceFileId), row])
        )
        const rowsByPath = new Map(
          collisionRows.map((row) => [fileIdentity(row.source, row.storageKey), row])
        )
        const retainedSeqs = new Set<number>()
        const retainedSources = new Map<number, ProjectFileSource>()
        const acceptedFiles: IndexedFileInput[] = []
        let hasActiveCollision = false

        for (const file of files) {
          const idKey = fileIdentity(file.source, file.sourceFileId)
          const pathKey = fileIdentity(file.source, file.storageKey)
          const idRow = rowsById.get(idKey)
          const pathRow = rowsByPath.get(pathKey)
          const activeOtherSessionRow = [idRow, pathRow].find(
            (row) => row && row.sessionId !== session.id && row.deletedAt === null
          )

          // Project-scoped unique keys represent one canonical file. A second active session may carry
          // a legacy duplicate reference, but it must not steal ownership or make migration unretryable.
          if (activeOtherSessionRow) {
            hasActiveCollision = true
            log.warn('skipping duplicate file reference owned by another active session', {
              projectId: file.projectId,
              sessionId: file.sessionId,
              canonicalSessionId: activeOtherSessionRow.sessionId,
              source: file.source
            })
            continue
          }

          // A legacy collision can point the two unique keys at different rows. Keep the stable file-id
          // row and remove only the duplicate metadata row before updating the canonical record.
          if (idRow && pathRow && idRow.seq !== pathRow.seq) {
            await tx.managedFile.delete({ where: { seq: pathRow.seq } })
            rowsById.delete(fileIdentity(pathRow.source, pathRow.sourceFileId))
            rowsByPath.delete(pathKey)
            retainedSeqs.delete(pathRow.seq)
            retainedSources.delete(pathRow.seq)
          }

          const existing = idRow ?? pathRow
          if (existing) {
            rowsById.delete(fileIdentity(existing.source, existing.sourceFileId))
            rowsByPath.delete(fileIdentity(existing.source, existing.storageKey))
          }
          const row = existing
            ? await tx.managedFile.update({
                where: { seq: existing.seq },
                data: {
                  sourceFileId: file.sourceFileId,
                  sourceVersionId: file.sourceVersionId ?? null,
                  checksum: file.checksum ?? null,
                  sessionId: file.sessionId,
                  messageId: file.messageId ?? null,
                  displayName: file.displayName,
                  storageKey: file.storageKey,
                  mimeType: file.mimeType ?? null,
                  sizeBytes: file.sizeBytes,
                  mtimeMs: file.mtimeMs ?? null,
                  sortAtMs: file.sortAtMs,
                  deletedAt: null,
                  deleteOperationId: null
                }
              })
            : await tx.managedFile.create({ data: file })

          rowsById.set(idKey, row)
          rowsByPath.set(pathKey, row)
          // Cross-Session references preserve the source owner's row, but they are not members of the
          // referencing Session's ledger or Artifact group.
          if (file.sessionId === session.id) {
            retainedSeqs.add(row.seq)
            retainedSources.set(row.seq, file.source)
          }
          acceptedFiles.push(file)
        }

        // A partial scan cannot prove that an existing row was removed from the session. Preserve the
        // last readable projection while still committing newly readable files from this attempt.
        const preservedRows = hasIncompleteFiles
          ? existingRows.filter((row) => row.deletedAt === null && !retainedSeqs.has(row.seq))
          : []
        for (const row of preservedRows) {
          retainedSeqs.add(row.seq)
          retainedSources.set(row.seq, row.source as ProjectFileSource)
        }

        const transactionChangedSources = getChangedSources(
          projectionBeforeUpgrade ?? existingRows,
          [...acceptedFiles, ...preservedRows]
        )

        await tx.managedFile.updateMany({
          where: {
            projectId: session.projectId,
            sessionId: session.id,
            ...(retainedSeqs.size > 0 ? { seq: { notIn: [...retainedSeqs] } } : {})
          },
          data: { deletedAt: now }
        })

        const artifactCount = [...retainedSources.values()].filter(
          (source) => source === 'artifact'
        ).length
        const uploadCount = retainedSources.size - artifactCount
        const groupSortAtMs =
          currentSync && !transactionChangedSources.includes('artifact')
            ? currentSync.groupSortAtMs
            : BigInt(session.updatedAt)

        await tx.managedFileSessionSync.upsert({
          where: { projectId_sessionId: { projectId: session.projectId, sessionId: session.id } },
          create: {
            projectId: session.projectId,
            sessionId: session.id,
            filesRevision:
              hasActiveCollision || hasIncompleteFiles ? RETRYABLE_COLLISION_REVISION : revision,
            groupSortAtMs,
            artifactCount,
            uploadCount,
            syncedAt: now
          },
          update: {
            filesRevision:
              hasActiveCollision || hasIncompleteFiles ? RETRYABLE_COLLISION_REVISION : revision,
            groupSortAtMs,
            artifactCount,
            uploadCount,
            syncedAt: now,
            deletedAt: null,
            deleteOperationId: null
          }
        })

        return transactionChangedSources
      })

      const key = sessionKey(session.projectId, session.id)
      if (hasIncompleteFiles) {
        this.incompleteSessions.set(key, extraction.errors.join('; '))
      } else {
        this.incompleteSessions.delete(key)
      }
      return changedSources
    } catch (error) {
      this.incompleteSessions.set(sessionKey(session.projectId, session.id), describeError(error))
      throw error
    }
  }

  async softDeleteSession(
    projectId: string,
    sessionId: string
  ): Promise<ManagedFileSoftDeleteToken> {
    const client = await this.getClient()
    const deletedAt = new Date()
    const token = randomUUID()

    await client.$transaction([
      client.managedFile.updateMany({
        where: { projectId, sessionId, deletedAt: null },
        data: { deletedAt, deleteOperationId: token }
      }),
      client.managedFileSessionSync.updateMany({
        where: { projectId, sessionId, deletedAt: null },
        data: { deletedAt, deleteOperationId: token }
      })
    ])
    return token
  }

  async restoreSession(
    projectId: string,
    sessionId: string,
    token: ManagedFileSoftDeleteToken
  ): Promise<void> {
    const client = await this.getClient()

    await client.$transaction([
      client.managedFile.updateMany({
        where: { projectId, sessionId, deleteOperationId: token },
        data: { deletedAt: null, deleteOperationId: null }
      }),
      client.managedFileSessionSync.updateMany({
        where: { projectId, sessionId, deleteOperationId: token },
        data: { deletedAt: null, deleteOperationId: null }
      })
    ])
  }

  async softDeleteProject(projectId: string): Promise<ManagedFileSoftDeleteToken> {
    const client = await this.getClient()
    const deletedAt = new Date()
    const token = randomUUID()

    await client.$transaction([
      client.managedFile.updateMany({
        where: { projectId, deletedAt: null },
        data: { deletedAt, deleteOperationId: token }
      }),
      client.managedFileSessionSync.updateMany({
        where: { projectId, deletedAt: null },
        data: { deletedAt, deleteOperationId: token }
      })
    ])
    return token
  }

  async restoreProject(projectId: string, token: ManagedFileSoftDeleteToken): Promise<void> {
    const client = await this.getClient()

    await client.$transaction([
      client.managedFile.updateMany({
        where: { projectId, deleteOperationId: token },
        data: { deletedAt: null, deleteOperationId: null }
      }),
      client.managedFileSessionSync.updateMany({
        where: { projectId, deleteOperationId: token },
        data: { deletedAt: null, deleteOperationId: null }
      })
    ])
  }

  async reconcileActiveSessions(sessions: PersistedChatSession[]): Promise<void> {
    await this.reconcileSessions(sessions)
  }

  async reconcileProjectSessions(
    projectId: string,
    sessions: PersistedChatSession[]
  ): Promise<void> {
    if (sessions.some((session) => session.projectId !== projectId)) {
      throw new Error('Cannot reconcile Project files with a Session owned by another Project.')
    }
    await this.reconcileSessions(sessions, projectId)
  }

  private async reconcileSessions(
    sessions: PersistedChatSession[],
    projectId?: string
  ): Promise<void> {
    let scopedFailure = false
    const failures: unknown[] = []
    const failedProjects = new Set<string>()
    try {
      const client = await this.getClient()
      const activeKeys = new Set(
        sessions.map((session) => sessionKey(session.projectId, session.id))
      )
      const indexedSessions = await client.managedFileSessionSync.findMany({
        ...(projectId ? { where: { projectId } } : {}),
        select: { projectId: true, sessionId: true, deletedAt: true }
      })
      const retainedOrigins = await client.fileOriginSession.findMany({
        where: {
          ...(projectId ? { projectId } : {}),
          state: { in: ['deleting', 'deleted'] }
        },
        select: { projectId: true, sessionId: true }
      })
      const retainedKeys = new Set(
        retainedOrigins.map((origin) => sessionKey(origin.projectId, origin.sessionId))
      )

      for (const indexed of indexedSessions) {
        try {
          const key = sessionKey(indexed.projectId, indexed.sessionId)
          const isActive = activeKeys.has(key) || retainedKeys.has(key)

          if (isActive && indexed.deletedAt !== null) {
            await client.$transaction([
              client.managedFile.updateMany({
                where: {
                  projectId: indexed.projectId,
                  sessionId: indexed.sessionId,
                  deletedAt: { not: null }
                },
                data: { deletedAt: null, deleteOperationId: null }
              }),
              client.managedFileSessionSync.updateMany({
                where: {
                  projectId: indexed.projectId,
                  sessionId: indexed.sessionId,
                  deletedAt: { not: null }
                },
                data: { deletedAt: null, deleteOperationId: null }
              })
            ])
          } else if (!isActive && indexed.deletedAt === null) {
            await this.softDeleteSession(indexed.projectId, indexed.sessionId)
          }
        } catch (error) {
          failures.push(error)
          failedProjects.add(indexed.projectId)
        }
      }
      for (const origin of retainedOrigins) {
        try {
          await this.rebuildRetainedOriginProjection(client, origin.projectId, origin.sessionId)
        } catch (error) {
          failures.push(error)
          failedProjects.add(origin.projectId)
        }
      }
      for (const key of this.incompleteSessions.keys()) {
        if (
          (!projectId || key.startsWith(`${projectId}:`)) &&
          !activeKeys.has(key) &&
          ![...failedProjects].some((id) => key.startsWith(`${id}:`))
        ) {
          this.incompleteSessions.delete(key)
        }
      }
      for (const id of [...this.incompleteProjects]) {
        if ((!projectId || projectId === id) && !failedProjects.has(id))
          this.incompleteProjects.delete(id)
      }
      for (const id of failedProjects) this.incompleteProjects.add(id)
      if (failures.length) {
        scopedFailure = true
        throw new ProjectFilesReconciliationError(failures, [...failedProjects])
      }
      if (projectId) this.incompleteProjects.delete(projectId)
      else {
        this.incompleteProjects.clear()
        this.isReconciliationIncomplete = false
      }
    } catch (error) {
      if (!scopedFailure) this.markReconciliationIncomplete(projectId)
      throw error
    }
  }

  private async rebuildRetainedOriginProjection(
    client: ProjectFilesClient,
    projectId: string,
    sessionId: string
  ): Promise<void> {
    const [lineages, uploads] = await Promise.all([
      client.artifactLineage.findMany({
        where: { projectId, sessionId },
        include: { currentVersion: true }
      }),
      client.uploadFile.findMany({
        where: { projectId, sessionId },
        include: { currentVersion: true }
      })
    ])
    const artifactFiles: IndexedFileInput[] = lineages.flatMap((lineage) => {
      const version = lineage.currentVersion
      return version?.state === 'finalized'
        ? [
            {
              source: 'artifact' as const,
              sourceFileId: lineage.id,
              sourceVersionId: version.id,
              checksum: version.checksum,
              projectId,
              sessionId,
              messageId: version.messageId ?? undefined,
              displayName: lineage.filename,
              storageKey: version.contentStorageKey,
              mimeType: version.contentType ?? undefined,
              sizeBytes: version.sizeBytes,
              mtimeMs: BigInt(version.createdAt.getTime()),
              sortAtMs: BigInt(version.createdAt.getTime())
            }
          ]
        : []
    })
    const uploadFiles: IndexedFileInput[] = uploads.flatMap((upload) => {
      const version = upload.currentVersion
      const createdAt = version?.createdAt ?? version?.registeredAt
      return version?.state === 'ready' && createdAt
        ? [
            {
              source: 'upload' as const,
              sourceFileId: upload.id,
              sourceVersionId: version.id,
              checksum: version.checksum,
              projectId,
              sessionId,
              displayName: version.filename,
              storageKey: version.contentStorageKey,
              mimeType: version.contentType ?? undefined,
              sizeBytes: version.sizeBytes,
              mtimeMs: BigInt(createdAt.getTime()),
              sortAtMs: BigInt(createdAt.getTime())
            }
          ]
        : []
    })
    const files = [...artifactFiles, ...uploadFiles]
    if (files.length === 0) return
    const groupSortAtMs = files.reduce(
      (latest, file) => (file.sortAtMs > latest ? file.sortAtMs : latest),
      BigInt(0)
    )

    await client.$transaction(async (tx) => {
      for (const file of files) {
        await tx.managedFile.upsert({
          where: {
            projectId_source_sourceFileId: {
              projectId,
              source: file.source,
              sourceFileId: file.sourceFileId
            }
          },
          create: file,
          update: {
            sourceVersionId: file.sourceVersionId,
            checksum: file.checksum,
            sessionId,
            messageId: file.messageId,
            displayName: file.displayName,
            storageKey: file.storageKey,
            mimeType: file.mimeType,
            sizeBytes: file.sizeBytes,
            mtimeMs: file.mtimeMs,
            sortAtMs: file.sortAtMs,
            deletedAt: null,
            deleteOperationId: null
          }
        })
      }
      await tx.managedFileSessionSync.upsert({
        where: { projectId_sessionId: { projectId, sessionId } },
        create: {
          projectId,
          sessionId,
          filesRevision: 0,
          groupSortAtMs,
          artifactCount: artifactFiles.length,
          uploadCount: uploadFiles.length
        },
        update: {
          groupSortAtMs,
          artifactCount: artifactFiles.length,
          uploadCount: uploadFiles.length,
          deletedAt: null,
          deleteOperationId: null
        }
      })
    })
  }

  markReconciliationIncomplete(projectId?: string): void {
    if (projectId) this.incompleteProjects.add(projectId)
    else this.isReconciliationIncomplete = true
  }

  isIndexComplete(projectId: string): boolean {
    return (
      !this.isReconciliationIncomplete &&
      !this.incompleteProjects.has(projectId) &&
      ![...this.incompleteSessions.keys()].some((key) => key.startsWith(`${projectId}:`))
    )
  }
}

export { ProjectFilesMutationOwner, ProjectFilesReconciliationError }
export type { ManagedFileSoftDeleteToken, ManagedFileSyncOptions }
