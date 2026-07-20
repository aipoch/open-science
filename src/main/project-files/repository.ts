import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { ManagedFile, Prisma, PrismaClient } from '@prisma/client'

import type {
  ArtifactGroupPage,
  ListArtifactGroupsRequest,
  ListProjectFilesRequest,
  ProjectFileItem,
  ProjectFilesOverview,
  ProjectFilesPage,
  ProjectFileSource
} from '../../shared/project-files'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { getUploadedAttachmentName, PENDING_UPLOAD_SESSION_ID } from '../../shared/uploads'

const ARTIFACTS_DIR = 'artifacts'
const UPLOADS_DIR = 'uploads'
const PENDING_ARTIFACT_DIR = '.pending'
const MAX_PAGE_LIMIT = 100
// Valid persisted revisions are non-negative. A collision loser stores this sentinel so it cannot
// take the revision fast path and can claim the canonical row after its current owner is deleted.
const RETRYABLE_COLLISION_REVISION = -1

type ProjectFilesClient = Pick<
  PrismaClient,
  'managedFile' | 'managedFileSessionSync' | '$transaction'
>
type ProjectFilesClientProvider = () => Promise<ProjectFilesClient>

type IndexedFileInput = {
  source: ProjectFileSource
  sourceFileId: string
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

type FileCursor = {
  version: 1
  kind: 'uploads' | 'sessionArtifacts'
  projectId: string
  sessionId?: string
  sortAtMs: string
  seq: number
}

type GroupCursor = {
  version: 1
  kind: 'artifactGroups'
  projectId: string
  groupSortAtMs: string
  sessionId: string
}

type ManagedFileSoftDeleteToken = string

class ManagedFileSyncIncompleteError extends Error {}

// Owns the query-optimized DB projection used by Files while leaving file bytes under the existing
// managed roots. Session JSON remains authoritative; this index is repairable derived state.
class ManagedFileIndexRepository {
  private readonly incompleteSessions = new Map<string, string>()
  private isReconciliationIncomplete = false

  constructor(
    private readonly getClient: ProjectFilesClientProvider,
    private readonly storageRoot: string
  ) {}

  /**
   * Rebuilds one session's file projection when its filesRevision changes.
   *
   * Metadata rows, per-session counts, the revision ledger, and soft deletion of removed files are
   * committed atomically. The returned sources drive narrow renderer invalidations. Any failure is
   * remembered in memory so overview cannot claim that the index is complete before a later retry.
   */
  async syncSession(session: PersistedChatSession): Promise<ProjectFileSource[]> {
    const revision = normalizeRevision(session.filesRevision)
    try {
      const client = await this.getClient()
      const currentSync = await client.managedFileSessionSync.findUnique({
        where: { projectId_sessionId: { projectId: session.projectId, sessionId: session.id } }
      })

      if (currentSync?.filesRevision === revision && currentSync.deletedAt === null) {
        this.incompleteSessions.delete(sessionKey(session.projectId, session.id))
        return []
      }

      const files = await this.extractSessionFiles(session)
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
          retainedSeqs.add(row.seq)
          retainedSources.set(row.seq, file.source)
          acceptedFiles.push(file)
        }

        const transactionChangedSources = getChangedSources(existingRows, acceptedFiles)

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
            filesRevision: hasActiveCollision ? RETRYABLE_COLLISION_REVISION : revision,
            groupSortAtMs,
            artifactCount,
            uploadCount,
            syncedAt: now
          },
          update: {
            filesRevision: hasActiveCollision ? RETRYABLE_COLLISION_REVISION : revision,
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

      this.incompleteSessions.delete(sessionKey(session.projectId, session.id))
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
    this.incompleteSessions.delete(sessionKey(projectId, sessionId))
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
    for (const key of this.incompleteSessions.keys()) {
      if (key.startsWith(`${projectId}:`)) this.incompleteSessions.delete(key)
    }
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
        where: { deletedAt: null },
        select: { projectId: true, sessionId: true }
      })

      for (const indexed of indexedSessions) {
        if (!activeKeys.has(sessionKey(indexed.projectId, indexed.sessionId))) {
          await this.softDeleteSession(indexed.projectId, indexed.sessionId)
        }
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

  // A partial filesystem scan cannot identify which project was omitted, so this marker is global
  // until a later complete scan synchronizes every session and reconciliation succeeds.
  markReconciliationIncomplete(): void {
    this.isReconciliationIncomplete = true
  }

  // Counts are always queryable, but isIndexComplete distinguishes an authoritative result from a
  // usable partial projection after scan, sync, or reconciliation failure.
  async getOverview(projectId: string): Promise<ProjectFilesOverview> {
    requireIdentifier(projectId, 'projectId')
    const client = await this.getClient()
    const [totalCount, uploadCount, artifactCount, artifactGroupCount] = await Promise.all([
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
    if (collection.kind === 'uploads') {
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
    const source = normalizedCollection.kind === 'uploads' ? 'upload' : 'artifact'
    const sessionId =
      normalizedCollection.kind === 'sessionArtifacts' ? normalizedCollection.sessionId : undefined
    const cursor = request.cursor ? decodeFileCursor(request.cursor, normalizedRequest) : undefined
    const where: Prisma.ManagedFileWhereInput = {
      projectId: request.projectId,
      source,
      deletedAt: null,
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(cursor
        ? {
            OR: [
              { sortAtMs: { lt: BigInt(cursor.sortAtMs) } },
              { sortAtMs: BigInt(cursor.sortAtMs), seq: { lt: cursor.seq } }
            ]
          }
        : {})
    }
    const [rows, totalCount] = await Promise.all([
      client.managedFile.findMany({
        where,
        orderBy: [{ sortAtMs: 'desc' }, { seq: 'desc' }],
        take: limit + 1
      }),
      client.managedFile.count({
        where: {
          projectId: request.projectId,
          source,
          deletedAt: null,
          ...(sessionId !== undefined ? { sessionId } : {})
        }
      })
    ])
    const pageRows = rows.slice(0, limit)
    const lastRow = pageRows.at(-1)

    return {
      items: pageRows.map((row) => toProjectFileItem(row, this.storageRoot)),
      totalCount,
      nextCursor:
        rows.length > limit && lastRow
          ? encodeCursor({
              version: 1,
              kind: normalizedCollection.kind,
              projectId: request.projectId,
              sessionId,
              sortAtMs: lastRow.sortAtMs.toString(),
              seq: lastRow.seq
            })
          : undefined
    }
  }

  // Pages session headers independently from files. groupSortAtMs is changed only by artifact
  // mutations, while sessionId provides deterministic ordering when timestamps collide.
  async listArtifactGroups(request: ListArtifactGroupsRequest): Promise<ArtifactGroupPage> {
    requireIdentifier(request.projectId, 'projectId')
    const client = await this.getClient()
    const limit = normalizeLimit(request.limit)
    const cursor = request.cursor ? decodeGroupCursor(request.cursor, request) : undefined
    const where: Prisma.ManagedFileSessionSyncWhereInput = {
      projectId: request.projectId,
      deletedAt: null,
      artifactCount: { gt: 0 },
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
    const [rows, totalCount] = await Promise.all([
      client.managedFileSessionSync.findMany({
        where,
        orderBy: [{ groupSortAtMs: 'desc' }, { sessionId: 'desc' }],
        take: limit + 1
      }),
      client.managedFileSessionSync.count({
        where: { projectId: request.projectId, deletedAt: null, artifactCount: { gt: 0 } }
      })
    ])
    const pageRows = rows.slice(0, limit)
    const lastRow = pageRows.at(-1)

    return {
      items: pageRows.map((row) => ({
        sessionId: row.sessionId,
        artifactCount: row.artifactCount
      })),
      totalCount,
      nextCursor:
        rows.length > limit && lastRow
          ? encodeCursor({
              version: 1,
              kind: 'artifactGroups',
              projectId: request.projectId,
              groupSortAtMs: lastRow.groupSortAtMs.toString(),
              sessionId: lastRow.sessionId
            })
          : undefined
    }
  }

  // Extracts finalized uploads and managed artifacts from authoritative session JSON. Identity is
  // deduplicated first by source id and then by storage key to normalize legacy duplicate metadata.
  private async extractSessionFiles(session: PersistedChatSession): Promise<IndexedFileInput[]> {
    const files: IndexedFileInput[] = []
    const artifactMessageIds = new Map<string, string>()

    for (const message of session.messages) {
      for (const artifactId of message.artifactIds ?? []) {
        artifactMessageIds.set(artifactId, message.id)
      }

      if (message.role !== 'user') continue
      for (const upload of message.uploads ?? []) {
        if (upload.sessionId === PENDING_UPLOAD_SESSION_ID) continue
        const file = await this.toIndexedFile({
          source: 'upload',
          sourceFileId: upload.id,
          projectId: session.projectId,
          sessionId: session.id,
          messageId: message.id,
          displayName: getUploadedAttachmentName(upload),
          path: upload.path,
          mimeType: upload.mimeType,
          sortAtMs: BigInt(message.updatedAt || message.createdAt)
        })
        if (file) files.push(file)
      }
    }

    for (const artifact of session.artifacts ?? []) {
      if (artifact.kind !== 'managed-file' || isPendingArtifactPath(artifact.path)) continue
      const file = await this.toIndexedFile({
        source: 'artifact',
        sourceFileId: artifact.id,
        projectId: session.projectId,
        sessionId: session.id,
        messageId: artifactMessageIds.get(artifact.id),
        displayName: artifact.name || basename(artifact.path),
        path: artifact.path,
        mimeType: artifact.mimeType,
        sortAtMs: BigInt(artifact.mtimeMs ?? session.updatedAt)
      })
      if (file) files.push(file)
    }

    const filesById = new Map(
      files.map((file) => [fileIdentity(file.source, file.sourceFileId), file])
    )
    return [
      ...new Map(
        [...filesById.values()].map((file) => [fileIdentity(file.source, file.storageKey), file])
      ).values()
    ]
  }

  /**
   * Validates and snapshots one managed file without moving its bytes.
   *
   * Both the requested path and its canonical realpath must remain inside the source root, closing
   * absolute-path, traversal, and symlink escape cases. Missing or unreadable managed files make the
   * session sync incomplete so the previous projection remains visible and the revision is retried.
   */
  private async toIndexedFile(input: {
    source: ProjectFileSource
    sourceFileId: string
    projectId: string
    sessionId: string
    messageId?: string
    displayName: string
    path: string
    mimeType?: string
    sortAtMs: bigint
  }): Promise<IndexedFileInput | undefined> {
    const managedRoot = resolve(
      this.storageRoot,
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
      throw new ManagedFileSyncIncompleteError(
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
      throw new ManagedFileSyncIncompleteError(`Managed ${input.source} path is not a file.`)
    }

    return {
      source: input.source,
      sourceFileId: input.sourceFileId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      messageId: input.messageId,
      displayName: input.displayName,
      // Canonical paths are only for trust checks. Persist the logical path relative to the configured
      // root so macOS /var -> /private/var aliases never introduce `..` segments into storageKey.
      storageKey: relative(this.storageRoot, requestedPath).split(sep).join('/'),
      mimeType: input.mimeType,
      sizeBytes: BigInt(fileStat.size),
      mtimeMs: BigInt(Math.trunc(fileStat.mtimeMs)),
      sortAtMs: input.sortAtMs
    }
  }
}

const normalizeRevision = (revision: number | undefined): number =>
  Number.isInteger(revision) && (revision ?? 0) >= 0 ? (revision ?? 0) : 0

const normalizeLimit = (limit: number): number => {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new Error(`Project files page limit must be between 1 and ${MAX_PAGE_LIMIT}.`)
  }
  return limit
}

const requireIdentifier = (value: string, field: string): void => {
  if (!value.trim()) throw new Error(`Project files ${field} is required.`)
}

const sessionKey = (projectId: string, sessionId: string): string => `${projectId}:${sessionId}`

// Compares normalized metadata rather than row identity so renderer events are emitted only when a
// source's visible projection changed; DB timestamps and sequence values do not cause false refreshes.
const getChangedSources = (
  existingRows: ManagedFile[],
  desiredFiles: IndexedFileInput[]
): ProjectFileSource[] =>
  (['artifact', 'upload'] as const).filter((source) => {
    const existingProjection = existingRows
      .filter((row) => row.source === source && row.deletedAt === null)
      .map((row) =>
        JSON.stringify([
          row.sourceFileId,
          row.messageId,
          row.displayName,
          row.storageKey,
          row.mimeType,
          row.sizeBytes.toString(),
          row.mtimeMs?.toString() ?? null,
          row.sortAtMs.toString()
        ])
      )
      .sort()
    const desiredProjection = desiredFiles
      .filter((file) => file.source === source)
      .map((file) =>
        JSON.stringify([
          file.sourceFileId,
          file.messageId ?? null,
          file.displayName,
          file.storageKey,
          file.mimeType ?? null,
          file.sizeBytes.toString(),
          file.mtimeMs?.toString() ?? null,
          file.sortAtMs.toString()
        ])
      )
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

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

// Cursors are opaque transport tokens, not security credentials; decoders below provide the required
// collection and shape validation before any value reaches Prisma.
const encodeCursor = (cursor: FileCursor | GroupCursor): string =>
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

  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.kind !== request.collection.kind ||
    value.projectId !== request.projectId ||
    value.sessionId !== expectedSessionId ||
    typeof value.sortAtMs !== 'string' ||
    !/^-?\d+$/.test(value.sortAtMs) ||
    typeof value.seq !== 'number' ||
    !Number.isInteger(value.seq)
  ) {
    throw new Error('Project files cursor does not match the requested collection.')
  }

  return value as FileCursor
}

const decodeGroupCursor = (cursor: string, request: ListArtifactGroupsRequest): GroupCursor => {
  const value = parseCursor(cursor)

  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.kind !== 'artifactGroups' ||
    value.projectId !== request.projectId ||
    typeof value.groupSortAtMs !== 'string' ||
    !/^-?\d+$/.test(value.groupSortAtMs) ||
    typeof value.sessionId !== 'string'
  ) {
    throw new Error('Project files cursor does not match the requested collection.')
  }

  return value as GroupCursor
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const toSafeNumber = (value: bigint, field: string): number => {
  const number = Number(value)
  if (!Number.isSafeInteger(number)) throw new Error(`Managed file ${field} exceeds IPC range.`)
  return number
}

// Reconstructs an absolute managed path only after a storageKey has been produced by trusted indexing.
// Bigint fields are range-checked before crossing Electron IPC, which serializes the numeric DTO.
const toProjectFileItem = (row: ManagedFile, storageRoot: string): ProjectFileItem => ({
  id: row.source === 'upload' ? `upload:${row.sourceFileId}` : row.sourceFileId,
  source: row.source as ProjectFileSource,
  sourceFileId: row.sourceFileId,
  projectId: row.projectId,
  sessionId: row.sessionId,
  messageId: row.messageId ?? undefined,
  name: row.displayName,
  path: join(storageRoot, ...row.storageKey.split('/')),
  mimeType: row.mimeType ?? undefined,
  size: toSafeNumber(row.sizeBytes, 'size'),
  mtimeMs: row.mtimeMs === null ? undefined : toSafeNumber(row.mtimeMs, 'mtime'),
  sortAtMs: toSafeNumber(row.sortAtMs, 'sort time')
})

export { ManagedFileIndexRepository, ManagedFileSyncIncompleteError }
export type { ManagedFileSoftDeleteToken, ProjectFilesClient, ProjectFilesClientProvider }
