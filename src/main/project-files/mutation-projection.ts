import { open, realpath } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'

import { Prisma, type ManagedFile, type PrismaClient } from '@prisma/client'

import type { ProjectFileSource } from '../../shared/project-files'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { DEFAULT_UPLOAD_PROJECT_ID, PENDING_UPLOAD_SESSION_ID } from '../../shared/uploads'
import type {
  AdoptedLegacyArtifact,
  AdoptLegacyArtifactRequest
} from '../managed-file-versions/service'
import { sha256 } from '../artifacts/provenance-canonical'
import { LOCAL_RESOURCE_BUDGETS, assertWithinResourceBudget } from '../resource-budget'

const ARTIFACTS_DIR = 'artifacts'
const UPLOADS_DIR = 'uploads'
const PENDING_ARTIFACT_DIR = '.pending'

type ProjectFilesClient = Pick<
  PrismaClient,
  | 'managedFile'
  | 'managedFileSessionSync'
  | 'fileOriginSession'
  | 'artifactLineage'
  | 'uploadFile'
  | 'artifactVersion'
  | 'uploadVersion'
  | 'project'
  | 'projectDeletionIntent'
  | '$queryRaw'
  | '$transaction'
>
type ProjectFilesClientProvider = () => Promise<ProjectFilesClient>
type ProjectFilesClientFactory = (configRoot: string) => Promise<ProjectFilesClient>
type LegacyArtifactVersionAdopter = {
  adoptLegacyArtifact(request: AdoptLegacyArtifactRequest): Promise<AdoptedLegacyArtifact>
}
type LegacyUploadVersionUpgrader = {
  upgradeLegacySessionUploads(
    session: PersistedChatSession,
    options: { mode: 'project-files-sync' }
  ): Promise<PersistedChatSession>
}

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

const normalizeRevision = (revision: number | undefined): number =>
  Number.isInteger(revision) && (revision ?? 0) >= 0 ? (revision ?? 0) : 0

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

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const getLegacyUploadStorageSessionId = (storageKey: string): string | undefined => {
  const segments = storageKey.split('/')
  return segments[0] === UPLOADS_DIR &&
    segments[1] === DEFAULT_UPLOAD_PROJECT_ID &&
    segments.length >= 4
    ? segments[2]
    : undefined
}

const isFileProjectionCurrent = async (
  client: ProjectFilesClient,
  projectId: string,
  sessionId: string
): Promise<boolean> => {
  const [lineages, uploads, rows] = await Promise.all([
    client.artifactLineage.findMany({
      where: { projectId, sessionId },
      include: { currentVersion: true }
    }),
    client.uploadFile.findMany({
      where: { projectId, sessionId },
      include: { currentVersion: true }
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
  if (
    rows.some(
      (row) =>
        (row.source === 'artifact' || row.source === 'upload') && row.sourceVersionId === null
    )
  ) {
    return false
  }
  const expectedArtifacts = new Map(
    lineages.flatMap((lineage) => {
      const version = lineage.currentVersion
      return version?.state === 'finalized' ? [[lineage.id, version.id] as const] : []
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

  const expectedUploads = new Map(
    uploads.flatMap((upload) => {
      const version = upload.currentVersion
      return version?.state === 'ready' ? [[upload.id, version.id] as const] : []
    })
  )
  const projectedOwnedUploads = rows.filter(
    (row) => row.source === 'upload' && row.sourceVersionId !== null && row.sessionId === sessionId
  )
  if (
    projectedOwnedUploads.length !== expectedUploads.size ||
    projectedOwnedUploads.some(
      (row) => expectedUploads.get(row.sourceFileId) !== row.sourceVersionId
    )
  ) {
    return false
  }

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

const extractSessionFiles = async (
  getClient: ProjectFilesClientProvider,
  dataRoot: string,
  legacyArtifactVersionAdopter: LegacyArtifactVersionAdopter,
  session: PersistedChatSession
): Promise<{ files: IndexedFileInput[]; errors: string[] }> => {
  const files: IndexedFileInput[] = []
  const errors: string[] = []
  const artifactMessageIds = new Map<string, string>()
  // File failures are isolated so one stale legacy reference cannot block every readable file in
  // the session. The caller keeps the ledger retryable and exposes the partial state in overview.
  const collectFile = async (candidate: IndexedFileCandidate): Promise<void> => {
    try {
      const file = await toIndexedFile(dataRoot, legacyArtifactVersionAdopter, candidate)
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
          const client = await getClient()
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
              },
              currentVersion: true
            }
          })
          const referencedVersion = file?.versions[0]
          const version = file?.currentVersion
          if (!file || !referencedVersion || !version || version.state !== 'ready') {
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
      errors.push(`Legacy Upload must be upgraded before Project Files indexing: ${upload.id}`)
    }
  }

  // Native Artifact identity and version order live in SQLite. Session JSON is intentionally a
  // compatibility projection and can lag a newly finalized Version or retain an older branch's
  // descriptor, so it must not choose the Files tile content for a provenance lineage.
  const authoritativeArtifactIds = new Set<string>()
  const explicitlyVersionedArtifactIds = new Set(
    (session.artifacts ?? [])
      .map((artifact) => artifact.artifactId)
      .filter((artifactId): artifactId is string => artifactId !== undefined)
  )
  try {
    const client = await getClient()
    const lineages = await client.artifactLineage.findMany({
      where: { projectId: session.projectId, sessionId: session.id },
      include: { currentVersion: true }
    })

    for (const lineage of lineages) {
      authoritativeArtifactIds.add(lineage.id)
      const version = lineage.currentVersion
      if (!version || version.state !== 'finalized') continue
      if (version.originKind === 'legacy' && !explicitlyVersionedArtifactIds.has(lineage.id)) {
        continue
      }
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
 * Adopts one legacy Artifact into immutable v1 storage before indexing it.
 *
 * Both the requested path and its canonical realpath must remain inside the source root, closing
 * absolute-path, traversal, and symlink escape cases. Missing or unreadable managed files make the
 * session sync incomplete so the previous projection remains visible and the revision is retried.
 */
const toIndexedFile = async (
  dataRoot: string,
  legacyArtifactVersionAdopter: LegacyArtifactVersionAdopter,
  input: IndexedFileCandidate
): Promise<IndexedFileInput | undefined> => {
  if (input.source !== 'artifact') {
    throw new Error('Only legacy Artifacts can enter the Project Files adoption boundary.')
  }
  const managedRoot = resolve(dataRoot, ARTIFACTS_DIR)
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

  const handle = await open(canonicalPath, 'r')
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) throw new Error('Managed artifact path is not a file.')
    const sizeBytes = Number(before.size)
    assertWithinResourceBudget('file', sizeBytes, LOCAL_RESOURCE_BUDGETS.artifactFileBytes)
    const content = await handle.readFile()
    const after = await handle.stat({ bigint: true })
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      content.byteLength !== sizeBytes
    ) {
      throw new Error('Managed artifact changed during legacy Version adoption.')
    }
    const actualChecksum = sha256(content)
    if (input.checksum && input.checksum !== actualChecksum) {
      throw new Error('Managed artifact checksum changed before legacy Version adoption.')
    }
    const adopted = await legacyArtifactVersionAdopter.adoptLegacyArtifact({
      projectId: input.projectId,
      sessionId: input.sessionId,
      sourceFileId: input.sourceFileId,
      logicalFilename: input.displayName,
      content,
      contentType: input.mimeType,
      messageId: input.messageId
    })
    if (adopted.checksum !== actualChecksum) {
      throw new Error('Managed artifact Version checksum does not match the adopted source.')
    }
    return {
      source: input.source,
      sourceFileId: adopted.fileId,
      sourceVersionId: adopted.versionId,
      checksum: adopted.checksum,
      projectId: input.projectId,
      sessionId: input.sessionId,
      messageId: input.messageId,
      displayName: input.displayName,
      storageKey: adopted.storageRef,
      mimeType: adopted.contentType,
      sizeBytes: BigInt(adopted.sizeBytes),
      mtimeMs: BigInt(adopted.createdAt.getTime()),
      sortAtMs: input.sortAtMs
    }
  } finally {
    await handle.close()
  }
}

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

export {
  buildProjectCollisionFilters,
  describeError,
  extractSessionFiles,
  fileIdentity,
  getChangedSources,
  isFileProjectionCurrent,
  normalizeRevision,
  sessionKey
}
export type {
  IndexedFileInput,
  LegacyArtifactVersionAdopter,
  LegacyUploadVersionUpgrader,
  ProjectFilesClient,
  ProjectFilesClientFactory,
  ProjectFilesClientProvider
}
