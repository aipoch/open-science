import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { Prisma, type FileOriginSession, type ManagedFile, type PrismaClient } from '@prisma/client'

import type {
  ArtifactGroupPage,
  GetProjectFilesOverviewRequest,
  ListArtifactGroupsRequest,
  ListProjectFilesRequest,
  ProjectFileItem,
  ProjectFilesOverview,
  ProjectFilesPage,
  ProjectFileSource,
  ProjectFileOriginSession,
  SearchArtifactsRequest,
  SearchArtifactsResult
} from '../../shared/project-files'
import { createArtifactVersionLocator } from '../../shared/artifact-provenance'
import type { PersistedChatSession } from '../../shared/session-persistence'
import {
  createUploadVersionReference,
  DEFAULT_UPLOAD_PROJECT_NAME,
  getUploadedAttachmentName,
  PENDING_UPLOAD_SESSION_ID
} from '../../shared/uploads'

const ARTIFACTS_DIR = 'artifacts'
const UPLOADS_DIR = 'uploads'
const PENDING_ARTIFACT_DIR = '.pending'
const MAX_PAGE_LIMIT = 100
// Valid persisted revisions are non-negative. A collision loser stores this sentinel so it cannot
// take the revision fast path and can claim the canonical row after its current owner is deleted.
const RETRYABLE_COLLISION_REVISION = -1

type ProjectFilesClient = Pick<
  PrismaClient,
  | 'managedFile'
  | 'managedFileSessionSync'
  | 'fileOriginSession'
  | 'artifactLineage'
  | 'uploadFile'
  | '$queryRaw'
  | '$transaction'
>
type ProjectFilesClientProvider = () => Promise<ProjectFilesClient>
type ProjectFilesClientFactory = (configRoot: string) => Promise<ProjectFilesClient>

type IndexedFileInput = {
  source: ProjectFileSource
  sourceFileId: string
  sourceVersionId?: string
  checksum?: string
  projectId: string
  sessionId: string
  messageId?: string
  displayName: string
  storageKey: string
  mimeType?: string
  sizeBytes: bigint
  mtimeMs?: bigint
  sortAtMs: bigint
}

type IndexedFileCandidate = Omit<IndexedFileInput, 'storageKey' | 'sizeBytes' | 'mtimeMs'> & {
  path: string
}

type FileCursor = {
  version: 2
  kind: 'all' | 'uploads' | 'sessionArtifacts'
  projectId: string
  sessionId?: string
  queryKey: string
  sortAtMs: string
  seq: number
}

type GroupCursor = {
  version: 2
  kind: 'artifactGroups'
  projectId: string
  queryKey: string
  groupSortAtMs: string
  sessionId: string
}

type SearchArtifactCursor = {
  version: 2
  kind: 'globalArtifacts'
  primaryProjectId: string
  queryKey: string
  sortAtMs: string
  seq: number
}

type NormalizedSearch = {
  filenameContains?: string
  excludedSessionIds: string[]
  queryKey: string
}

type SearchArtifactGroupRow = {
  sessionId: string
  groupSortAtMs: bigint
  artifactCount: bigint
}

type SearchOverviewRow = {
  totalCount: bigint
  uploadCount: bigint
  artifactCount: bigint
  artifactGroupCount: bigint
}

type ManagedFileSoftDeleteToken = string
type ManagedFileSyncOptions = { force?: boolean }

// Owns the query-optimized DB projection used by Files while leaving file bytes under the existing
// managed roots. Session JSON remains authoritative; this index is repairable derived state.
class ManagedFileIndexRepository {
  private readonly incompleteSessions = new Map<string, string>()
  private isReconciliationIncomplete = false

  constructor(
    private readonly getClient: ProjectFilesClientProvider,
    private readonly dataRoot: string
  ) {}

  /**
   * Rebuilds one session's file projection when its filesRevision changes.
   *
   * Metadata rows, per-session counts, the revision ledger, and soft deletion of removed files are
   * committed atomically. The returned sources drive narrow renderer invalidations. Any failure is
   * remembered in memory so overview cannot claim that the index is complete before a later retry.
   */
  async syncSession(
    session: PersistedChatSession,
    options: ManagedFileSyncOptions = {}
  ): Promise<ProjectFileSource[]> {
    const revision = normalizeRevision(session.filesRevision)
    try {
      const client = await this.getClient()
      const currentSync = await client.managedFileSessionSync.findUnique({
        where: { projectId_sessionId: { projectId: session.projectId, sessionId: session.id } }
      })

      if (
        !options.force &&
        currentSync?.filesRevision === revision &&
        currentSync.deletedAt === null &&
        (await this.isFileProjectionCurrent(client, session.projectId, session.id))
      ) {
        this.incompleteSessions.delete(sessionKey(session.projectId, session.id))
        return []
      }

      const extraction = await this.extractSessionFiles(session)
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
            console.warn('Skipping duplicate file reference owned by another active session', {
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
                  sourceVersionId: file.sourceVersionId,
                  checksum: file.checksum,
                  sessionId: file.sessionId,
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

        const transactionChangedSources = getChangedSources(existingRows, [
          ...acceptedFiles,
          ...preservedRows
        ])

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

  // Marks both file rows and the session ledger with one operation token. The token scopes rollback
  // to this deletion attempt, so a concurrent or later delete cannot be accidentally restored.
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
    // Keep completeness markers through this reversible phase. A complete reconciliation clears the
    // marker after durable JSON deletion; compensation therefore retains the original index state.
    return token
  }

  // Restores only rows written by the matching soft-delete operation.
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

  // Project deletion uses the same reversible metadata-first ordering as session deletion; bytes are
  // intentionally retained under the managed roots.
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
    // Project markers remain until deletion is durable, so a failed directory removal can restore the
    // rows without incorrectly upgrading a partial projection to complete.
    return token
  }

  // Rolls back one failed project deletion without reviving rows from another operation.
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

  /**
   * Reconciles indexed ledgers against a complete durable session scan.
   *
   * This must never run after a partial directory read: an absent JSON entry is interpreted as a
   * deletion and its index rows are soft-deleted. The operation-level token used by soft deletion
   * allows the persistence coordinator to restore exactly this attempt if durable deletion fails.
   */
  async reconcileActiveSessions(sessions: PersistedChatSession[]): Promise<void> {
    try {
      const client = await this.getClient()
      const activeKeys = new Set(
        sessions.map((session) => sessionKey(session.projectId, session.id))
      )
      const indexedSessions = await client.managedFileSessionSync.findMany({
        select: { projectId: true, sessionId: true, deletedAt: true }
      })
      const retainedOrigins = await client.fileOriginSession.findMany({
        where: { state: { in: ['deleting', 'deleted'] } },
        select: { projectId: true, sessionId: true }
      })
      const retainedKeys = new Set(
        retainedOrigins.map((origin) => sessionKey(origin.projectId, origin.sessionId))
      )

      for (const indexed of indexedSessions) {
        const key = sessionKey(indexed.projectId, indexed.sessionId)
        const isActive = activeKeys.has(key) || retainedKeys.has(key)

        if (isActive && indexed.deletedAt !== null) {
          // A complete scan proves that JSON survived an interrupted deletion. Restore all metadata for
          // that owner before startup sync order can let another active session claim its unique rows.
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
      }
      for (const origin of retainedOrigins) {
        await this.rebuildRetainedOriginProjection(client, origin.projectId, origin.sessionId)
      }
      // A first sync can fail before a ledger row exists. Once a complete scan proves that JSON is
      // gone, its transient failure marker must not keep the project permanently incomplete.
      for (const key of this.incompleteSessions.keys()) {
        if (!activeKeys.has(key)) this.incompleteSessions.delete(key)
      }
      this.isReconciliationIncomplete = false
    } catch (error) {
      this.isReconciliationIncomplete = true
      throw error
    }
  }

  // Reconstructs Files metadata from SQLite authority when a deleted Session JSON can no longer be
  // used for repair. Missing content bytes do not erase the row: opening it can still show the
  // captured Provenance and an explicit content-unavailable state.
  private async rebuildRetainedOriginProjection(
    client: ProjectFilesClient,
    projectId: string,
    sessionId: string
  ): Promise<void> {
    const [lineages, uploads] = await Promise.all([
      client.artifactLineage.findMany({
        where: { projectId, sessionId },
        include: {
          versions: {
            where: { state: 'finalized' },
            orderBy: [{ versionNumber: 'desc' }, { id: 'desc' }],
            take: 1
          }
        }
      }),
      client.uploadFile.findMany({
        where: { projectId, sessionId },
        include: {
          versions: {
            where: { state: 'ready' },
            orderBy: [{ versionNumber: 'desc' }, { id: 'desc' }],
            take: 1
          }
        }
      })
    ])
    const artifactFiles: IndexedFileInput[] = lineages.flatMap((lineage) => {
      const version = lineage.versions[0]
      return version
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
      const version = upload.versions[0]
      const createdAt = version?.createdAt ?? version?.registeredAt
      return version && createdAt
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
    // Legacy retained origins may predate ArtifactVersion/UploadVersion authority while their
    // existing ManagedFile projection is still valid. Do not erase that projection during upgrade.
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

  // A partial filesystem scan cannot identify which project was omitted, so this marker is global
  // until a later complete scan synchronizes every session and reconciliation succeeds.
  markReconciliationIncomplete(): void {
    this.isReconciliationIncomplete = true
  }

  // Counts are always queryable, but isIndexComplete distinguishes an authoritative result from a
  // usable partial projection after scan, sync, or reconciliation failure.
  async getOverview(
    request: string | GetProjectFilesOverviewRequest
  ): Promise<ProjectFilesOverview> {
    const { projectId, search: rawSearch } =
      typeof request === 'string' ? { projectId: request, search: undefined } : request
    requireIdentifier(projectId, 'projectId')
    const search = normalizeSearch(rawSearch)
    const client = await this.getClient()
    const [totalCount, uploadCount, artifactCount, artifactGroupCount] = search
      ? await getMatchingOverviewCounts(client, projectId, search)
      : await Promise.all([
          client.managedFile.count({ where: { projectId, deletedAt: null } }),
          client.managedFile.count({ where: { projectId, source: 'upload', deletedAt: null } }),
          client.managedFile.count({ where: { projectId, source: 'artifact', deletedAt: null } }),
          client.managedFileSessionSync.count({
            where: { projectId, deletedAt: null, artifactCount: { gt: 0 } }
          })
        ])

    return {
      totalCount,
      uploadCount,
      artifactCount,
      artifactGroupCount,
      isIndexComplete:
        !this.isReconciliationIncomplete &&
        ![...this.incompleteSessions.keys()].some((key) => key.startsWith(`${projectId}:`))
    }
  }

  /**
   * Pages one logical collection with a stable (sortAtMs, seq) keyset.
   *
   * Cursors are bound to project, collection kind, and optional session. This prevents a renderer
   * bug or stale filter request from reusing a cursor against a different query.
   */
  async listFiles(request: ListProjectFilesRequest): Promise<ProjectFilesPage> {
    requireIdentifier(request.projectId, 'projectId')
    const collection = request.collection as { kind?: unknown; sessionId?: unknown }
    let normalizedCollection: ListProjectFilesRequest['collection']
    if (collection.kind === 'all') {
      normalizedCollection = { kind: 'all' }
    } else if (collection.kind === 'uploads') {
      normalizedCollection = { kind: 'uploads' }
    } else if (collection.kind === 'sessionArtifacts' && typeof collection.sessionId === 'string') {
      requireIdentifier(collection.sessionId, 'sessionId')
      normalizedCollection = { kind: 'sessionArtifacts', sessionId: collection.sessionId }
    } else {
      throw new Error('Project files collection is invalid.')
    }
    const normalizedRequest = { ...request, collection: normalizedCollection }
    const client = await this.getClient()
    const limit = normalizeLimit(request.limit)
    const search = normalizeSearch(request.search)
    const source =
      normalizedCollection.kind === 'all'
        ? undefined
        : normalizedCollection.kind === 'uploads'
          ? 'upload'
          : 'artifact'
    const sessionId =
      normalizedCollection.kind === 'sessionArtifacts' ? normalizedCollection.sessionId : undefined
    if (sessionId && search?.excludedSessionIds.includes(sessionId)) {
      return { items: [], totalCount: 0 }
    }
    const cursor = request.cursor ? decodeFileCursor(request.cursor, normalizedRequest) : undefined
    const where: Prisma.ManagedFileWhereInput = {
      projectId: request.projectId,
      ...(source ? { source } : {}),
      deletedAt: null,
      ...(sessionId !== undefined
        ? { sessionId }
        : search?.excludedSessionIds.length
          ? { sessionId: { notIn: search.excludedSessionIds } }
          : {}),
      ...(cursor
        ? {
            OR: [
              { sortAtMs: { lt: BigInt(cursor.sortAtMs) } },
              { sortAtMs: BigInt(cursor.sortAtMs), seq: { lt: cursor.seq } }
            ]
          }
        : {})
    }
    const [rows, totalCount] = search
      ? await this.listMatchingFiles(
          client,
          request.projectId,
          source,
          sessionId,
          search,
          cursor,
          limit
        )
      : await Promise.all([
          client.managedFile.findMany({
            where,
            orderBy: [{ sortAtMs: 'desc' }, { seq: 'desc' }],
            take: limit + 1
          }),
          client.managedFile.count({
            where: {
              projectId: request.projectId,
              ...(source ? { source } : {}),
              deletedAt: null,
              ...(sessionId !== undefined ? { sessionId } : {})
            }
          })
        ])
    const pageRows = rows.slice(0, limit)
    const lastRow = pageRows.at(-1)
    const origins = await client.fileOriginSession.findMany({
      where: {
        projectId: request.projectId,
        sessionId: { in: [...new Set(pageRows.map((row) => row.sessionId))] }
      }
    })
    const originsBySession = new Map(origins.map((origin) => [origin.sessionId, origin]))

    return {
      items: pageRows.map((row) =>
        toProjectFileItem(row, this.dataRoot, originsBySession.get(row.sessionId))
      ),
      totalCount,
      nextCursor:
        rows.length > limit && lastRow
          ? encodeCursor({
              version: 2,
              kind: normalizedCollection.kind,
              projectId: request.projectId,
              sessionId,
              queryKey: search?.queryKey ?? '',
              sortAtMs: lastRow.sortAtMs.toString(),
              seq: lastRow.seq
            })
          : undefined
    }
  }

  // Global search keeps its cross-project scope deliberately bounded: the primary project is
  // independently paged while every other project shares a small latest-artifact sample.
  async searchArtifacts(request: SearchArtifactsRequest): Promise<SearchArtifactsResult> {
    requireIdentifier(request.primaryProjectId, 'primaryProjectId')
    if (!Array.isArray(request.otherProjectIds)) {
      throw new Error('Project files otherProjectIds must be an array.')
    }
    const otherProjectIds = [...new Set(request.otherProjectIds)]
      .filter((projectId) => projectId !== request.primaryProjectId)
      .map((projectId) => {
        requireIdentifier(projectId, 'otherProjectId')
        return projectId
      })
    if (!Number.isInteger(request.otherLimit) || request.otherLimit < 0 || request.otherLimit > 5) {
      throw new Error('Project files otherLimit must be between 0 and 5.')
    }

    const primaryLimit = normalizeLimit(request.primaryLimit)
    const search = normalizeSearch({
      filenameContains: request.filenameContains ?? '',
      ...(request.excludedSessionIds === undefined
        ? {}
        : { excludedSessionIds: request.excludedSessionIds })
    })
    const cursor = request.primaryCursor
      ? decodeSearchArtifactCursor(request.primaryCursor, request.primaryProjectId, search)
      : undefined
    const client = await this.getClient()
    const excludedSessionIds = search?.excludedSessionIds ?? []
    const [primaryRows, primaryTotalCount, otherRows] = await Promise.all([
      listMatchingArtifacts(
        client,
        request.primaryProjectId,
        search,
        excludedSessionIds,
        cursor,
        primaryLimit
      ),
      countMatchingArtifacts(client, request.primaryProjectId, search, excludedSessionIds),
      request.otherLimit > 0 && otherProjectIds.length > 0
        ? listOtherProjectArtifacts(
            client,
            otherProjectIds,
            search,
            excludedSessionIds,
            request.otherLimit
          )
        : Promise.resolve([])
    ])
    const primaryPageRows = primaryRows.slice(0, primaryLimit)
    const lastPrimaryRow = primaryPageRows.at(-1)
    const rows = [...primaryPageRows, ...otherRows]
    const origins =
      rows.length === 0
        ? []
        : await client.fileOriginSession.findMany({
            where: {
              OR: [
                ...new Map(rows.map((row) => [`${row.projectId}:${row.sessionId}`, row])).values()
              ].map((row) => ({ projectId: row.projectId, sessionId: row.sessionId }))
            }
          })
    const originsBySession = new Map(
      origins.map((origin) => [`${origin.projectId}:${origin.sessionId}`, origin])
    )
    const toItem = (row: ManagedFile): ProjectFileItem =>
      toProjectFileItem(
        row,
        this.dataRoot,
        originsBySession.get(`${row.projectId}:${row.sessionId}`)
      )

    return {
      primary: {
        items: primaryPageRows.map(toItem),
        totalCount: primaryTotalCount,
        nextCursor:
          primaryRows.length > primaryLimit && lastPrimaryRow
            ? encodeCursor({
                version: 2,
                kind: 'globalArtifacts',
                primaryProjectId: request.primaryProjectId,
                queryKey: search?.queryKey ?? '',
                sortAtMs: lastPrimaryRow.sortAtMs.toString(),
                seq: lastPrimaryRow.seq
              })
            : undefined
      },
      other: otherRows.map(toItem),
      isIndexComplete: [request.primaryProjectId, ...otherProjectIds].every(
        (projectId) =>
          !this.isReconciliationIncomplete &&
          ![...this.incompleteSessions.keys()].some((key) => key.startsWith(`${projectId}:`))
      )
    }
  }

  // Pages session headers independently from files. groupSortAtMs is changed only by artifact
  // mutations, while sessionId provides deterministic ordering when timestamps collide.
  async listArtifactGroups(request: ListArtifactGroupsRequest): Promise<ArtifactGroupPage> {
    requireIdentifier(request.projectId, 'projectId')
    const client = await this.getClient()
    const limit = normalizeLimit(request.limit)
    const search = normalizeSearch(request.search)
    const cursor = request.cursor ? decodeGroupCursor(request.cursor, request) : undefined
    const groupWhere: Prisma.ManagedFileSessionSyncWhereInput = {
      projectId: request.projectId,
      deletedAt: null,
      artifactCount: { gt: 0 },
      ...(search?.excludedSessionIds.length
        ? { sessionId: { notIn: search.excludedSessionIds } }
        : {})
    }
    const where: Prisma.ManagedFileSessionSyncWhereInput = {
      ...groupWhere,
      ...(cursor
        ? {
            OR: [
              { groupSortAtMs: { lt: BigInt(cursor.groupSortAtMs) } },
              {
                groupSortAtMs: BigInt(cursor.groupSortAtMs),
                sessionId: { lt: cursor.sessionId }
              }
            ]
          }
        : {})
    }
    const [rows, totalCount] = search
      ? await listMatchingArtifactGroups(client, request.projectId, search, cursor, limit)
      : await Promise.all([
          client.managedFileSessionSync.findMany({
            where,
            orderBy: [{ groupSortAtMs: 'desc' }, { sessionId: 'desc' }],
            take: limit + 1
          }),
          client.managedFileSessionSync.count({
            where: groupWhere
          })
        ])
    const pageRows = rows.slice(0, limit)
    const lastRow = pageRows.at(-1)
    const origins = await client.fileOriginSession.findMany({
      where: {
        projectId: request.projectId,
        sessionId: { in: pageRows.map((row) => row.sessionId) }
      }
    })
    const originsBySession = new Map(origins.map((origin) => [origin.sessionId, origin]))

    return {
      items: pageRows.map((row) => ({
        sessionId: row.sessionId,
        artifactCount: toSafeCount(row.artifactCount, 'artifact group count'),
        ...toOriginProjection(originsBySession.get(row.sessionId))
      })),
      totalCount,
      nextCursor:
        rows.length > limit && lastRow
          ? encodeCursor({
              version: 2,
              kind: 'artifactGroups',
              projectId: request.projectId,
              queryKey: search?.queryKey ?? '',
              groupSortAtMs: lastRow.groupSortAtMs.toString(),
              sessionId: lastRow.sessionId
            })
          : undefined
    }
  }

  // Search keeps the same collection predicates and keyset ordering as the unfiltered path. The
  // paired count query intentionally omits only the cursor so totalCount describes every match.
  private async listMatchingFiles(
    client: ProjectFilesClient,
    projectId: string,
    source: ProjectFileSource | undefined,
    sessionId: string | undefined,
    search: NormalizedSearch,
    cursor: FileCursor | undefined,
    limit: number
  ): Promise<[ManagedFile[], number]> {
    const sourcePredicate =
      source === undefined ? Prisma.empty : Prisma.sql`AND "source" = ${source}`
    const sessionPredicate =
      sessionId === undefined ? Prisma.empty : Prisma.sql`AND "sessionId" = ${sessionId}`
    const exclusionPredicate = excludedSessionIdsPredicate(
      Prisma.sql`"sessionId"`,
      search.excludedSessionIds
    )
    const cursorPredicate = cursor
      ? Prisma.sql`AND ("sortAtMs" < ${BigInt(cursor.sortAtMs)} OR ("sortAtMs" = ${BigInt(cursor.sortAtMs)} AND "seq" < ${cursor.seq}))`
      : Prisma.empty
    const [rows, totalCount] = await Promise.all([
      client.$queryRaw<ManagedFile[]>(Prisma.sql`
        SELECT
          "seq", "source", "sourceFileId", "sourceVersionId", "checksum",
          "projectId", "sessionId", "messageId",
          "displayName", "storageKey", "mimeType", "sizeBytes", "mtimeMs", "sortAtMs",
          "createdAt", "updatedAt", "deletedAt", "deleteOperationId"
        FROM "ManagedFile"
        WHERE "projectId" = ${projectId}
          ${sourcePredicate}
          AND "deletedAt" IS NULL
          ${sessionPredicate}
          ${filenameContainsPredicate(Prisma.sql`"displayName"`, search)}
          ${exclusionPredicate}
          ${cursorPredicate}
        ORDER BY "sortAtMs" DESC, "seq" DESC
        LIMIT ${limit + 1}
      `),
      countMatchingFiles(client, projectId, search, source, sessionId)
    ])
    return [rows, totalCount]
  }

  // Extracts finalized uploads and managed artifacts from authoritative session JSON. Identity is
  // deduplicated first by source id and then by storage key to normalize legacy duplicate metadata.
  private async isFileProjectionCurrent(
    client: ProjectFilesClient,
    projectId: string,
    sessionId: string
  ): Promise<boolean> {
    const [lineages, rows] = await Promise.all([
      client.artifactLineage.findMany({
        where: { projectId, sessionId },
        include: {
          versions: {
            where: { state: 'finalized' },
            orderBy: [{ versionNumber: 'desc' }, { id: 'desc' }],
            take: 1
          }
        }
      }),
      client.managedFile.findMany({
        where: { projectId, sessionId, deletedAt: null },
        select: {
          source: true,
          sourceFileId: true,
          sourceVersionId: true,
          sessionId: true,
          storageKey: true
        }
      })
    ])
    const expectedArtifacts = new Map(
      lineages.flatMap((lineage) => {
        const version = lineage.versions[0]
        return version ? [[lineage.id, version.id] as const] : []
      })
    )
    const projectedArtifacts = rows.filter(
      (row) => row.source === 'artifact' && row.sourceVersionId !== null
    )
    if (
      projectedArtifacts.length !== expectedArtifacts.size ||
      projectedArtifacts.some(
        (row) => expectedArtifacts.get(row.sourceFileId) !== row.sourceVersionId
      )
    ) {
      return false
    }

    const hasMismatchedLegacyUploadOwner = rows.some((row) => {
      if (row.source !== 'upload' || row.sourceVersionId !== null) return false
      const storageSessionId = getLegacyUploadStorageSessionId(row.storageKey)
      return storageSessionId !== undefined && storageSessionId !== row.sessionId
    })
    if (hasMismatchedLegacyUploadOwner) return false

    // A native Upload row is owned by its source Session, even when another Session references it.
    // Detect old derived rows that copied the referencing Session so one startup sync repairs their
    // locator scope instead of repeatedly sending unauthorized preview requests.
    const nativeUploadIds = [
      ...new Set(
        rows
          .filter((row) => row.source === 'upload' && row.sourceVersionId !== null)
          .map((row) => row.sourceFileId)
      )
    ]
    if (nativeUploadIds.length === 0) return true
    const ownedUploads = await client.uploadFile.findMany({
      where: { id: { in: nativeUploadIds }, projectId, sessionId },
      select: { id: true }
    })
    return ownedUploads.length === nativeUploadIds.length
  }

  private async extractSessionFiles(
    session: PersistedChatSession
  ): Promise<{ files: IndexedFileInput[]; errors: string[] }> {
    const files: IndexedFileInput[] = []
    const errors: string[] = []
    const artifactMessageIds = new Map<string, string>()
    // File failures are isolated so one stale legacy reference cannot block every readable file in
    // the session. The caller keeps the ledger retryable and exposes the partial state in overview.
    const collectFile = async (candidate: IndexedFileCandidate): Promise<void> => {
      try {
        const file = await this.toIndexedFile(candidate)
        if (file) files.push(file)
      } catch (error) {
        errors.push(describeError(error))
      }
    }

    // Project Files is a Project-scoped library, not an active-conversation projection. Preserve
    // files referenced by every immutable Message Branch so switching revisions cannot hide an Upload
    // or Artifact from this Session or from another Session's @ picker. Active messages are applied
    // last because their streamed/finalized payload may be newer than the persisted graph node.
    const messagesById = new Map(
      [...(session.conversationGraph?.messages ?? []), ...session.messages].map((message) => [
        message.id,
        message
      ])
    )
    for (const message of messagesById.values()) {
      for (const artifactId of message.artifactIds ?? []) {
        artifactMessageIds.set(artifactId, message.id)
      }

      if (message.role !== 'user') continue
      for (const upload of message.uploads ?? []) {
        if (upload.sessionId === PENDING_UPLOAD_SESSION_ID) continue
        if (upload.versionId) {
          try {
            const client = await this.getClient()
            const file = await client.uploadFile.findFirst({
              where: {
                id: upload.id,
                projectId: session.projectId,
                sessionId: upload.sessionId
              },
              include: {
                versions: {
                  where: { id: upload.versionId, state: 'ready' },
                  take: 1
                }
              }
            })
            const version = file?.versions[0]
            if (!file || !version) {
              throw new Error(`Upload Version is unavailable: ${upload.versionId}`)
            }
            files.push({
              source: 'upload',
              sourceFileId: file.id,
              sourceVersionId: version.id,
              checksum: version.checksum,
              projectId: session.projectId,
              sessionId: upload.sessionId,
              messageId: message.id,
              displayName: version.originalFilename || version.filename,
              storageKey: version.contentStorageKey,
              mimeType: version.contentType ?? undefined,
              sizeBytes: version.sizeBytes,
              mtimeMs: version.createdAt ? BigInt(version.createdAt.getTime()) : undefined,
              sortAtMs: BigInt(message.updatedAt || message.createdAt)
            })
          } catch (error) {
            errors.push(describeError(error))
          }
          continue
        }
        if (!upload.path) {
          errors.push(`Legacy upload identity is unavailable: ${upload.id}`)
          continue
        }
        await collectFile({
          source: 'upload',
          sourceFileId: upload.id,
          sourceVersionId: upload.versionId,
          checksum: upload.sha256 ?? upload.checksum,
          projectId: session.projectId,
          sessionId: upload.sessionId,
          messageId: message.id,
          displayName: getUploadedAttachmentName(upload),
          path: upload.path,
          mimeType: upload.mimeType,
          sortAtMs: BigInt(message.updatedAt || message.createdAt)
        })
      }
    }

    // Native Artifact identity and version order live in SQLite. Session JSON is intentionally a
    // compatibility projection and can lag a newly finalized Version or retain an older branch's
    // descriptor, so it must not choose the Files tile content for a provenance lineage.
    const authoritativeArtifactIds = new Set<string>()
    try {
      const client = await this.getClient()
      const lineages = await client.artifactLineage.findMany({
        where: { projectId: session.projectId, sessionId: session.id },
        include: {
          versions: {
            where: { state: 'finalized' },
            orderBy: [{ versionNumber: 'desc' }, { id: 'desc' }],
            take: 1
          }
        }
      })

      for (const lineage of lineages) {
        authoritativeArtifactIds.add(lineage.id)
        const version = lineage.versions[0]
        if (!version) continue
        const createdAtMs = BigInt(version.createdAt.getTime())
        files.push({
          source: 'artifact',
          sourceFileId: lineage.id,
          sourceVersionId: version.id,
          checksum: version.checksum,
          projectId: session.projectId,
          sessionId: session.id,
          messageId: version.messageId ?? undefined,
          displayName: version.filename || lineage.filename,
          storageKey: version.contentStorageKey,
          mimeType: version.contentType ?? undefined,
          sizeBytes: version.sizeBytes,
          mtimeMs: createdAtMs,
          sortAtMs: createdAtMs
        })
      }
    } catch (error) {
      errors.push(`Artifact Version catalog is unavailable: ${describeError(error)}`)
    }

    for (const artifact of session.artifacts ?? []) {
      if (artifact.kind !== 'managed-file' || isPendingArtifactPath(artifact.path)) continue
      if (artifact.artifactId || artifact.versionId) {
        if (!artifact.artifactId || !authoritativeArtifactIds.has(artifact.artifactId)) {
          errors.push(
            `Artifact Version identity is unavailable: ${artifact.versionId ?? artifact.id}`
          )
        }
        continue
      }
      const artifactSortAtMs = artifact.mtimeMs ?? session.updatedAt
      if (!Number.isFinite(artifactSortAtMs)) {
        errors.push('Managed artifact modification time must be finite.')
        continue
      }
      await collectFile({
        source: 'artifact',
        sourceFileId: artifact.artifactId ?? artifact.id,
        sourceVersionId: artifact.versionId,
        checksum: artifact.sha256,
        projectId: session.projectId,
        sessionId: session.id,
        messageId: artifactMessageIds.get(artifact.id),
        displayName: artifact.name || basename(artifact.path),
        path: artifact.path,
        mimeType: artifact.mimeType,
        // Filesystem mtimes can include fractional milliseconds; the DB keyset stores integer millis.
        sortAtMs: BigInt(Math.trunc(artifactSortAtMs))
      })
    }

    const filesById = new Map(
      files.map((file) => [fileIdentity(file.source, file.sourceFileId), file])
    )
    return {
      files: [
        ...new Map(
          [...filesById.values()].map((file) => [fileIdentity(file.source, file.storageKey), file])
        ).values()
      ],
      errors
    }
  }

  /**
   * Validates and snapshots one managed file without moving its bytes.
   *
   * Both the requested path and its canonical realpath must remain inside the source root, closing
   * absolute-path, traversal, and symlink escape cases. Missing or unreadable managed files make the
   * session sync incomplete so the previous projection remains visible and the revision is retried.
   */
  private async toIndexedFile(input: IndexedFileCandidate): Promise<IndexedFileInput | undefined> {
    const managedRoot = resolve(
      this.dataRoot,
      input.source === 'artifact' ? ARTIFACTS_DIR : UPLOADS_DIR
    )
    const requestedPath = resolve(input.path)

    if (!isPathInsideRoot(managedRoot, requestedPath)) {
      console.warn('Skipping file outside managed storage', {
        projectId: input.projectId,
        sessionId: input.sessionId,
        source: input.source
      })
      return undefined
    }

    let canonicalRoot: string
    let canonicalPath: string
    try {
      ;[canonicalRoot, canonicalPath] = await Promise.all([
        realpath(managedRoot),
        realpath(requestedPath)
      ])
    } catch (error) {
      throw new Error(
        `Managed ${input.source} file is not currently readable: ${describeError(error)}`
      )
    }

    if (!isPathInsideRoot(canonicalRoot, canonicalPath)) {
      console.warn('Skipping file whose canonical path leaves managed storage', {
        projectId: input.projectId,
        sessionId: input.sessionId,
        source: input.source
      })
      return undefined
    }

    const fileStat = await stat(canonicalPath)
    if (!fileStat.isFile()) {
      throw new Error(`Managed ${input.source} path is not a file.`)
    }

    return {
      source: input.source,
      sourceFileId: input.sourceFileId,
      sourceVersionId: input.sourceVersionId,
      checksum: input.checksum,
      projectId: input.projectId,
      sessionId: input.sessionId,
      messageId: input.messageId,
      displayName: input.displayName,
      // Canonical paths are only for trust checks. Persist the logical path relative to the data root so
      // macOS /var -> /private/var aliases never introduce `..` segments into storageKey.
      storageKey: relative(this.dataRoot, requestedPath).split(sep).join('/'),
      mimeType: input.mimeType,
      sizeBytes: BigInt(fileStat.size),
      mtimeMs: BigInt(Math.trunc(fileStat.mtimeMs)),
      sortAtMs: input.sortAtMs
    }
  }
}

// Builds the index with the SQLite client rooted at the fixed config directory while resolving
// managed file bytes from the separately relocatable data directory.
const createManagedFileIndexRepository = (
  getClientForRoot: ProjectFilesClientFactory,
  configRoot: string,
  dataRoot: string
): ManagedFileIndexRepository =>
  new ManagedFileIndexRepository(() => getClientForRoot(configRoot), dataRoot)

const normalizeRevision = (revision: number | undefined): number =>
  Number.isInteger(revision) && (revision ?? 0) >= 0 ? (revision ?? 0) : 0

const normalizeLimit = (limit: number): number => {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new Error(`Project files page limit must be between 1 and ${MAX_PAGE_LIMIT}.`)
  }
  return limit
}

// Normalizes untrusted IPC input once so SQL predicates and cursor identity share the same bounded
// filename query and archive exclusion set. An empty object deliberately uses the indexed path.
const normalizeSearch = (search: unknown): NormalizedSearch | undefined => {
  if (search === undefined) return undefined
  if (!isRecord(search) || typeof search.filenameContains !== 'string') {
    throw new Error('Project files search is invalid.')
  }
  const filenameContains = search.filenameContains.trim()
  if (filenameContains && filenameContains.length > 256) {
    throw new Error('Project files search must be at most 256 characters.')
  }
  const excludedSessionIds = normalizeExcludedSessionIds(search.excludedSessionIds)
  if (!filenameContains && excludedSessionIds.length === 0) return undefined
  return {
    ...(filenameContains ? { filenameContains } : {}),
    excludedSessionIds,
    queryKey: `${filenameContains ? foldAsciiCase(filenameContains) : ''}\u0000${excludedSessionIds.join('\u0000')}`
  }
}

const normalizeExcludedSessionIds = (value: unknown): string[] => {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((sessionId) => typeof sessionId !== 'string')) {
    throw new Error('Project files excludedSessionIds must be an array of identifiers.')
  }
  return [...new Set(value)].sort().map((sessionId) => {
    requireIdentifier(sessionId, 'excludedSessionId')
    return sessionId
  })
}

// SQLite's built-in lower() folds ASCII only. Bind cursors with the same transformation so query
// identity never promises broader Unicode case-insensitivity than the SQL predicate provides.
const foldAsciiCase = (value: string): string =>
  value.replace(/[A-Z]/g, (character) => character.toLowerCase())

// Every search query shares the same SQLite ASCII-folding behavior while selecting its own column
// alias. Keeping the predicate in one fragment prevents counts and pages from drifting apart.
const filenameContainsPredicate = (
  displayNameColumn: Prisma.Sql,
  search: NormalizedSearch | undefined
): Prisma.Sql =>
  search?.filenameContains
    ? Prisma.sql`AND instr(lower(${displayNameColumn}), lower(${search.filenameContains})) > 0`
    : Prisma.empty

const excludedSessionIdsPredicate = (
  sessionIdColumn: Prisma.Sql,
  excludedSessionIds: string[]
): Prisma.Sql =>
  excludedSessionIds.length > 0
    ? Prisma.sql`AND ${sessionIdColumn} NOT IN (${Prisma.join(excludedSessionIds)})`
    : Prisma.empty

const requireIdentifier = (value: string, field: string): void => {
  if (!value.trim()) throw new Error(`Project files ${field} is required.`)
}

// One conditional aggregate keeps the debounced all-source search from scanning the same project
// four times merely to populate the toolbar count and overview state.
const getMatchingOverviewCounts = async (
  client: ProjectFilesClient,
  projectId: string,
  search: NormalizedSearch
): Promise<[number, number, number, number]> => {
  const rows = await client.$queryRaw<SearchOverviewRow[]>(Prisma.sql`
    SELECT
      COUNT(file."seq") AS "totalCount",
      COALESCE(SUM(CASE WHEN file."source" = 'upload' THEN 1 ELSE 0 END), 0) AS "uploadCount",
      COALESCE(SUM(CASE WHEN file."source" = 'artifact' THEN 1 ELSE 0 END), 0) AS "artifactCount",
      COUNT(DISTINCT CASE
        WHEN file."source" = 'artifact' AND sync."sessionId" IS NOT NULL THEN file."sessionId"
      END) AS "artifactGroupCount"
    FROM "ManagedFile" AS file
    LEFT JOIN "ManagedFileSessionSync" AS sync
      ON sync."projectId" = file."projectId"
      AND sync."sessionId" = file."sessionId"
      AND sync."deletedAt" IS NULL
    WHERE file."projectId" = ${projectId}
      AND file."deletedAt" IS NULL
      ${filenameContainsPredicate(Prisma.sql`file."displayName"`, search)}
      ${excludedSessionIdsPredicate(Prisma.sql`file."sessionId"`, search.excludedSessionIds)}
  `)
  const counts = rows[0]

  return [
    toSafeCount(counts?.totalCount ?? 0n, 'search result count'),
    toSafeCount(counts?.uploadCount ?? 0n, 'upload search result count'),
    toSafeCount(counts?.artifactCount ?? 0n, 'artifact search result count'),
    toSafeCount(counts?.artifactGroupCount ?? 0n, 'artifact group count')
  ]
}

// Mirrors the optional source and session constraints used by listMatchingFiles so each collection
// reports its own complete match count rather than the current page size.
const countMatchingFiles = async (
  client: ProjectFilesClient,
  projectId: string,
  search: NormalizedSearch,
  source?: ProjectFileSource,
  sessionId?: string
): Promise<number> => {
  const sourcePredicate = source === undefined ? Prisma.empty : Prisma.sql`AND "source" = ${source}`
  const sessionPredicate =
    sessionId === undefined ? Prisma.empty : Prisma.sql`AND "sessionId" = ${sessionId}`
  const rows = await client.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
    SELECT COUNT(*) AS "count"
    FROM "ManagedFile"
    WHERE "projectId" = ${projectId}
      AND "deletedAt" IS NULL
      ${sourcePredicate}
      ${sessionPredicate}
      ${filenameContainsPredicate(Prisma.sql`"displayName"`, search)}
      ${excludedSessionIdsPredicate(Prisma.sql`"sessionId"`, search.excludedSessionIds)}
  `)
  return toSafeCount(rows[0]?.count ?? 0n, 'search result count')
}

// The global-search projection is intentionally Artifact-only. Keep its predicate and keyset local
// instead of widening listFiles' collections, whose cursor contract serves the Files surface.
const listMatchingArtifacts = async (
  client: ProjectFilesClient,
  projectId: string,
  search: NormalizedSearch | undefined,
  excludedSessionIds: string[],
  cursor: SearchArtifactCursor | undefined,
  limit: number
): Promise<ManagedFile[]> => {
  const filenamePredicate = filenameContainsPredicate(Prisma.sql`"displayName"`, search)
  const exclusionPredicate = excludedSessionIdsPredicate(
    Prisma.sql`"sessionId"`,
    excludedSessionIds
  )
  const cursorPredicate = cursor
    ? Prisma.sql`AND ("sortAtMs" < ${BigInt(cursor.sortAtMs)} OR ("sortAtMs" = ${BigInt(cursor.sortAtMs)} AND "seq" < ${cursor.seq}))`
    : Prisma.empty

  return client.$queryRaw<ManagedFile[]>(Prisma.sql`
    SELECT
      "seq", "source", "sourceFileId", "sourceVersionId", "checksum",
      "projectId", "sessionId", "messageId",
      "displayName", "storageKey", "mimeType", "sizeBytes", "mtimeMs", "sortAtMs",
      "createdAt", "updatedAt", "deletedAt", "deleteOperationId"
    FROM "ManagedFile"
    WHERE "projectId" = ${projectId}
      AND "source" = 'artifact'
      AND "deletedAt" IS NULL
      ${filenamePredicate}
      ${exclusionPredicate}
      ${cursorPredicate}
    ORDER BY "sortAtMs" DESC, "seq" DESC
    LIMIT ${limit + 1}
  `)
}

const countMatchingArtifacts = async (
  client: ProjectFilesClient,
  projectId: string,
  search: NormalizedSearch | undefined,
  excludedSessionIds: string[]
): Promise<number> => {
  const filenamePredicate = filenameContainsPredicate(Prisma.sql`"displayName"`, search)
  const exclusionPredicate = excludedSessionIdsPredicate(
    Prisma.sql`"sessionId"`,
    excludedSessionIds
  )
  const rows = await client.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
    SELECT COUNT(*) AS "count"
    FROM "ManagedFile"
    WHERE "projectId" = ${projectId}
      AND "source" = 'artifact'
      AND "deletedAt" IS NULL
      ${filenamePredicate}
      ${exclusionPredicate}
  `)
  return toSafeCount(rows[0]?.count ?? 0n, 'artifact search result count')
}

const listOtherProjectArtifacts = async (
  client: ProjectFilesClient,
  projectIds: string[],
  search: NormalizedSearch | undefined,
  excludedSessionIds: string[],
  limit: number
): Promise<ManagedFile[]> => {
  const filenamePredicate = filenameContainsPredicate(Prisma.sql`"displayName"`, search)
  const exclusionPredicate = excludedSessionIdsPredicate(
    Prisma.sql`"sessionId"`,
    excludedSessionIds
  )

  return client.$queryRaw<ManagedFile[]>(Prisma.sql`
    SELECT
      "seq", "source", "sourceFileId", "sourceVersionId", "checksum",
      "projectId", "sessionId", "messageId",
      "displayName", "storageKey", "mimeType", "sizeBytes", "mtimeMs", "sortAtMs",
      "createdAt", "updatedAt", "deletedAt", "deleteOperationId"
    FROM "ManagedFile"
    WHERE "projectId" IN (${Prisma.join(projectIds)})
      AND "source" = 'artifact'
      AND "deletedAt" IS NULL
      ${filenamePredicate}
      ${exclusionPredicate}
    ORDER BY "sortAtMs" DESC, "seq" DESC
    LIMIT ${limit}
  `)
}

// Counts only session groups that still own at least one active artifact matching the search.
const countMatchingArtifactGroups = async (
  client: ProjectFilesClient,
  projectId: string,
  search: NormalizedSearch
): Promise<number> => {
  const rows = await client.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
    SELECT COUNT(DISTINCT sync."sessionId") AS "count"
    FROM "ManagedFileSessionSync" AS sync
    INNER JOIN "ManagedFile" AS file
      ON file."projectId" = sync."projectId" AND file."sessionId" = sync."sessionId"
    WHERE sync."projectId" = ${projectId}
      AND sync."deletedAt" IS NULL
      AND file."source" = 'artifact'
      AND file."deletedAt" IS NULL
      ${filenameContainsPredicate(Prisma.sql`file."displayName"`, search)}
      ${excludedSessionIdsPredicate(Prisma.sql`sync."sessionId"`, search.excludedSessionIds)}
  `)
  return toSafeCount(rows[0]?.count ?? 0n, 'artifact group count')
}

// Applies the group-header keyset after filtering artifacts, preserving independent pagination for
// session headers while returning per-group match counts instead of catalog artifact counts.
const listMatchingArtifactGroups = async (
  client: ProjectFilesClient,
  projectId: string,
  search: NormalizedSearch,
  cursor: GroupCursor | undefined,
  limit: number
): Promise<[SearchArtifactGroupRow[], number]> => {
  const cursorPredicate = cursor
    ? Prisma.sql`AND (sync."groupSortAtMs" < ${BigInt(cursor.groupSortAtMs)} OR (sync."groupSortAtMs" = ${BigInt(cursor.groupSortAtMs)} AND sync."sessionId" < ${cursor.sessionId}))`
    : Prisma.empty
  return Promise.all([
    client.$queryRaw<SearchArtifactGroupRow[]>(Prisma.sql`
      SELECT
        sync."sessionId" AS "sessionId",
        sync."groupSortAtMs" AS "groupSortAtMs",
        COUNT(file."seq") AS "artifactCount"
      FROM "ManagedFileSessionSync" AS sync
      INNER JOIN "ManagedFile" AS file
        ON file."projectId" = sync."projectId" AND file."sessionId" = sync."sessionId"
      WHERE sync."projectId" = ${projectId}
        AND sync."deletedAt" IS NULL
        AND file."source" = 'artifact'
        AND file."deletedAt" IS NULL
        ${filenameContainsPredicate(Prisma.sql`file."displayName"`, search)}
        ${excludedSessionIdsPredicate(Prisma.sql`sync."sessionId"`, search.excludedSessionIds)}
        ${cursorPredicate}
      GROUP BY sync."sessionId", sync."groupSortAtMs"
      ORDER BY sync."groupSortAtMs" DESC, sync."sessionId" DESC
      LIMIT ${limit + 1}
    `),
    countMatchingArtifactGroups(client, projectId, search)
  ])
}

const sessionKey = (projectId: string, sessionId: string): string => `${projectId}:${sessionId}`

// Serializes only renderer-visible metadata. Normalizing nullable Prisma values and optional session
// values to null keeps persisted rows and desired inputs comparable through one shared projection.
const getFileProjectionKey = (file: ManagedFile | IndexedFileInput): string =>
  JSON.stringify([
    file.sourceFileId,
    file.sourceVersionId ?? null,
    file.checksum ?? null,
    file.messageId ?? null,
    file.displayName,
    file.storageKey,
    file.mimeType ?? null,
    file.sizeBytes.toString(),
    file.mtimeMs?.toString() ?? null,
    file.sortAtMs.toString()
  ])

// Compares normalized metadata rather than row identity so renderer events are emitted only when a
// source's visible projection changed; DB timestamps and sequence values do not cause false refreshes.
const getChangedSources = (
  existingRows: ManagedFile[],
  desiredFiles: Array<ManagedFile | IndexedFileInput>
): ProjectFileSource[] =>
  (['artifact', 'upload'] as const).filter((source) => {
    const existingProjection = existingRows
      .filter((row) => row.source === source && row.deletedAt === null)
      .map(getFileProjectionKey)
      .sort()
    const desiredProjection = desiredFiles
      .filter((file) => file.source === source)
      .map(getFileProjectionKey)
      .sort()

    return JSON.stringify(existingProjection) !== JSON.stringify(desiredProjection)
  })

const fileIdentity = (source: string, value: string): string => `${source}:${value}`

// Fetches all project-scoped id/path candidates in two batched predicates per source. The sync loop
// uses these rows to preserve canonical ownership across legacy sessions without issuing per-file reads.
const buildProjectCollisionFilters = (files: IndexedFileInput[]): Prisma.ManagedFileWhereInput[] =>
  (['artifact', 'upload'] as const).flatMap((source) => {
    const sourceFiles = files.filter((file) => file.source === source)
    if (sourceFiles.length === 0) return []

    return [
      {
        source,
        sourceFileId: { in: [...new Set(sourceFiles.map((file) => file.sourceFileId))] }
      },
      {
        source,
        storageKey: { in: [...new Set(sourceFiles.map((file) => file.storageKey))] }
      }
    ]
  })

// relative() must produce a non-empty descendant path. Checking both logical and canonical paths in
// toIndexedFile prevents lexical traversal as well as symlink escapes.
const isPathInsideRoot = (root: string, filePath: string): boolean => {
  const relativePath = relative(root, filePath)
  return (
    relativePath !== '' &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  )
}

const isPendingArtifactPath = (path: string): boolean =>
  path.split(/[\\/]+/).includes(PENDING_ARTIFACT_DIR)

const getLegacyUploadStorageSessionId = (storageKey: string): string | undefined => {
  const segments = storageKey.split('/')
  return segments[0] === UPLOADS_DIR &&
    segments[1] === DEFAULT_UPLOAD_PROJECT_NAME &&
    segments.length >= 4
    ? segments[2]
    : undefined
}

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

// Cursors are opaque transport tokens, not security credentials; decoders below provide the required
// collection and shape validation before any value reaches Prisma.
const encodeCursor = (cursor: FileCursor | GroupCursor | SearchArtifactCursor): string =>
  Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')

const parseCursor = (cursor: string): unknown => {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown
  } catch {
    throw new Error('Invalid project files cursor.')
  }
}

// Cursor payloads are untrusted IPC input. Validate both shape and query ownership before converting
// numeric strings back to bigint values in the repository query.
const decodeFileCursor = (cursor: string, request: ListProjectFilesRequest): FileCursor => {
  const value = parseCursor(cursor)
  const expectedSessionId =
    request.collection.kind === 'sessionArtifacts' ? request.collection.sessionId : undefined
  const expectedQueryKey = normalizeSearch(request.search)?.queryKey ?? ''

  if (
    !isRecord(value) ||
    value.version !== 2 ||
    value.kind !== request.collection.kind ||
    value.projectId !== request.projectId ||
    value.sessionId !== expectedSessionId ||
    typeof value.queryKey !== 'string' ||
    typeof value.sortAtMs !== 'string' ||
    !/^-?\d+$/.test(value.sortAtMs) ||
    typeof value.seq !== 'number' ||
    !Number.isInteger(value.seq)
  ) {
    throw new Error('Project files cursor does not match the requested collection.')
  }
  if (value.queryKey !== expectedQueryKey) {
    throw new Error('Project files cursor does not match the requested search.')
  }

  return value as FileCursor
}

const decodeGroupCursor = (cursor: string, request: ListArtifactGroupsRequest): GroupCursor => {
  const value = parseCursor(cursor)
  const expectedQueryKey = normalizeSearch(request.search)?.queryKey ?? ''

  if (
    !isRecord(value) ||
    value.version !== 2 ||
    value.kind !== 'artifactGroups' ||
    value.projectId !== request.projectId ||
    typeof value.queryKey !== 'string' ||
    typeof value.groupSortAtMs !== 'string' ||
    !/^-?\d+$/.test(value.groupSortAtMs) ||
    typeof value.sessionId !== 'string'
  ) {
    throw new Error('Project files cursor does not match the requested collection.')
  }
  if (value.queryKey !== expectedQueryKey) {
    throw new Error('Project files cursor does not match the requested search.')
  }

  return value as GroupCursor
}

const decodeSearchArtifactCursor = (
  cursor: string,
  primaryProjectId: string,
  search: NormalizedSearch | undefined
): SearchArtifactCursor => {
  const value = parseCursor(cursor)
  const expectedQueryKey = search?.queryKey ?? ''

  if (
    !isRecord(value) ||
    value.version !== 2 ||
    value.kind !== 'globalArtifacts' ||
    value.primaryProjectId !== primaryProjectId ||
    typeof value.queryKey !== 'string' ||
    typeof value.sortAtMs !== 'string' ||
    !/^-?\d+$/.test(value.sortAtMs) ||
    typeof value.seq !== 'number' ||
    !Number.isInteger(value.seq)
  ) {
    throw new Error('Project files cursor does not match the global artifact search.')
  }
  if (value.queryKey !== expectedQueryKey) {
    throw new Error('Project files cursor does not match the requested search.')
  }

  return value as SearchArtifactCursor
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const toSafeNumber = (value: bigint, field: string): number => {
  const number = Number(value)
  if (!Number.isSafeInteger(number)) throw new Error(`Managed file ${field} exceeds IPC range.`)
  return number
}

// Raw SQL aggregates may be bigint or number depending on the SQLite expression and test adapter.
const toSafeCount = (value: bigint | number, field: string): number =>
  typeof value === 'number' ? value : toSafeNumber(value, field)

// Carries durable source-session metadata independently from the live renderer session store.
const toOriginProjection = (
  origin: FileOriginSession | undefined
): { originSession?: ProjectFileOriginSession } =>
  origin
    ? {
        originSession: {
          state: origin.state as ProjectFileOriginSession['state'],
          ...(origin.titleSnapshot ? { title: origin.titleSnapshot } : {}),
          ...(origin.deletedAt ? { deletedAt: origin.deletedAt.toISOString() } : {})
        }
      }
    : {}

// Reconstructs an absolute managed path only after trusted indexing produced the storageKey. Bigint
// fields are range-checked here before the renderer-visible DTO crosses Electron IPC.
const toProjectFileItem = (
  row: ManagedFile,
  dataRoot: string,
  origin?: FileOriginSession
): ProjectFileItem => ({
  id: row.source === 'upload' ? `upload:${row.sourceFileId}` : row.sourceFileId,
  source: row.source as ProjectFileSource,
  sourceFileId: row.sourceFileId,
  sourceVersionId: row.sourceVersionId ?? undefined,
  checksum: row.checksum ?? undefined,
  projectId: row.projectId,
  sessionId: row.sessionId,
  messageId: row.messageId ?? undefined,
  name: row.displayName,
  path:
    row.source === 'upload' && row.sourceVersionId
      ? createUploadVersionReference(row.sourceVersionId, {
          projectId: row.projectId,
          sessionId: row.sessionId
        })
      : row.source === 'artifact' && row.sourceVersionId
        ? createArtifactVersionLocator({
            projectId: row.projectId,
            appSessionId: row.sessionId,
            artifactId: row.sourceFileId,
            versionId: row.sourceVersionId
          })
        : join(dataRoot, ...row.storageKey.split('/')),
  mimeType: row.mimeType ?? undefined,
  size: toSafeNumber(row.sizeBytes, 'size'),
  mtimeMs: row.mtimeMs === null ? undefined : toSafeNumber(row.mtimeMs, 'mtime'),
  sortAtMs: toSafeNumber(row.sortAtMs, 'sort time'),
  ...toOriginProjection(origin)
})

export { createManagedFileIndexRepository, ManagedFileIndexRepository }
export type {
  ManagedFileSoftDeleteToken,
  ProjectFilesClient,
  ProjectFilesClientFactory,
  ProjectFilesClientProvider
}
