import { packageReproducibilitySchema, type PackageReproducibility } from './reproducibility'
import { Prisma, type PrismaClient } from '@prisma/client'
import { resolveManagedProjectFileAnnotationIdentity } from '../../shared/annotations'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SessionPackageManifest, SessionPackageRequest } from '../../shared/session-package'
import type { PersistedChatSession } from '../../shared/session-persistence'
import {
  createArtifactVersionLocator,
  parseArtifactVersionLocator,
  type PersistedArtifactExecutionSnapshot
} from '../../shared/artifact-provenance'
import { createUploadVersionReference, parseUploadVersionReference } from '../../shared/uploads'
import { canonicalJson, sha256, type CanonicalJson } from '../artifacts/provenance-canonical'
import { sealArtifactReproducibilityRecipe } from '../artifacts/artifact-reproducibility-recipe'
import { resolveStorageKey } from '../artifacts/provenance-storage'
import { packageHistorySchema, type PackageHistory } from './history-schema'
import { assertPackageSourcePath, readPackageJson } from './archive'
import { NotebookRunRepository } from '../notebook/repository'
import { createFrameNotebookLane } from '../notebook/lane-identity'
import type { NotebookRunDocument } from '../../shared/notebook'
import { executionEvidenceSchema } from './execution-evidence'
import { copyFileWithinBudget } from '../bounded-file-io'
import { assertPackageCapacity } from './capacity'

// A package contract is an allowlist, not an arbitrary database dump. Schema changes must opt in
// here rather than silently exporting new columns (which could carry local authority or secrets).
const COLUMNS = {
  FileOriginSession:
    'projectId sessionId titleSnapshot state deletedAt deletionOperationId retainedReviewIdsJson createdAt updatedAt',
  Review:
    'id projectId sessionId turnMessageId scope lifecycle outcome errorMessage model reviewerLog createdAt updatedAt',
  Finding:
    'id reviewId status resolution claim evidence locator artifactVersionId artifactBindingState sortIndex reflagCount',
  ReviewFindingDisposition:
    'id sourceFindingId causeReviewId sequence trigger outcome note assessedArtifactVersionId assessmentSnapshot createdAt',
  ReviewScopeSnapshot:
    'id projectId sessionId reviewId scopeTurnMessageId state snapshotJson checksum storageKey schemaVersion blockCount createdAt',
  UploadFile:
    'id projectId sessionId filename originalFilename currentVersionId createdAt updatedAt',
  UploadVersion:
    'id uploadFileId versionNumber state originKind basedOnVersionId storageTag storedFilename writeOperationId contentStorageKey filename originalFilename contentType sizeBytes checksum createdAt registeredAt updatedAt',
  ArtifactVersionInput:
    'id artifactVersionId ordinal inputFileVersionId sourceKind sourceFileId sourceArtifactVersionId sourceUploadVersionId sourceVersionNumber sourceCreatedAt sourceProjectId sourceSessionId filename contentType sizeBytes checksum storageKey strongestAssociation',
  ArtifactMessageSnapshot:
    'id projectId sessionId rootFrameId agentFrameId messageBranchId terminalMessageId state storageKey checksum messageCount createdAt updatedAt',
  ArtifactLineage:
    'id projectId sessionId normalizedFilename filename currentVersionId createdAt updatedAt',
  ArtifactVersion:
    'id artifactId versionNumber filename originKind basedOnVersionId storageTag storedFilename artifactRunId writeOperationId writeRequestChecksum rootFrameId agentFrameId messageBranchId runtimeSegmentId promptMessageId notebookSessionId producerRunId producerRunIndex messageId messageSnapshotId state managedVisibleAt contentStorageKey evidenceStorageKey contentType sizeBytes checksum evidenceJson evidenceChecksum evidenceSchemaVersion executionSnapshotJson executionSnapshotChecksum executionSnapshotStorageKey executionSnapshotSchemaVersion createdAt updatedAt'
} as const
export type NativeTable = keyof typeof COLUMNS
export type NativeRow = Record<string, string | number | boolean | null>
export type PackageRecords = {
  schemaVersion: 1
  tables: Record<NativeTable, NativeRow[]>
  history?: PackageHistory
  reproducibility?: PackageReproducibility
}
const tableNames = Object.keys(COLUMNS) as NativeTable[]
export const packageNativeTables: readonly NativeTable[] = tableNames
const encodeRow = (table: NativeTable, row: object): NativeRow => {
  const source = row as Record<string, unknown>
  return Object.fromEntries(
    COLUMNS[table].split(' ').map((key) => {
      const value = source[key]
      return [
        key,
        value instanceof Date
          ? value.toISOString()
          : typeof value === 'bigint'
            ? value.toString()
            : (value ?? null)
      ]
    })
  ) as NativeRow
}

export const captureNativeRecords = async (
  client: PrismaClient,
  request: SessionPackageRequest,
  additionalVersionIds: readonly string[] = []
): Promise<PackageRecords> => {
  const scope = { projectId: request.projectId, sessionId: request.sessionId }
  const artifactIds = new Set(
    (
      await client.artifactVersion.findMany({ where: { artifact: scope }, select: { id: true } })
    ).map((row) => row.id)
  )
  const uploadIds = new Set(
    (
      await client.uploadVersion.findMany({ where: { uploadFile: scope }, select: { id: true } })
    ).map((row) => row.id)
  )
  const reviewIds = new Set(
    (await client.review.findMany({ where: scope, select: { id: true } })).map((row) => row.id)
  )
  for (const row of await client.artifactVersion.findMany({
    where: { id: { in: [...additionalVersionIds] } },
    select: { id: true }
  }))
    artifactIds.add(row.id)
  for (const row of await client.uploadVersion.findMany({
    where: { id: { in: [...additionalVersionIds] } },
    select: { id: true }
  }))
    uploadIds.add(row.id)
  if (additionalVersionIds.some((id) => !artifactIds.has(id) && !uploadIds.has(id)))
    throw new Error('Session or Notebook references missing file evidence.')
  // Traverse exact upstream versions and derivations, never an entire foreign conversation or its
  // unrelated outputs. Review dispositions and their cause Reviews belong to the same closure.
  for (;;) {
    const count = artifactIds.size + uploadIds.size + reviewIds.size
    if (count > 10000)
      throw new Error('Session package dependency closure exceeds the record limit.')
    const versions = await client.artifactVersion.findMany({
      where: { id: { in: [...artifactIds] } }
    })
    const uploads = await client.uploadVersion.findMany({ where: { id: { in: [...uploadIds] } } })
    const inputs = await client.artifactVersionInput.findMany({
      where: { artifactVersionId: { in: [...artifactIds] } }
    })
    const findings = await client.finding.findMany({
      where: {
        OR: [{ reviewId: { in: [...reviewIds] } }, { artifactVersionId: { in: [...artifactIds] } }]
      }
    })
    const dispositions = await client.reviewFindingDisposition.findMany({
      where: { sourceFindingId: { in: findings.map((row) => row.id) } }
    })
    const reviews = await client.review.findMany({ where: { id: { in: [...reviewIds] } } })
    for (const review of reviews) {
      const scope = JSON.parse(review.scope)
      for (const id of scope.artifactVersionIds ?? []) {
        if (typeof id !== 'string') throw new Error('Invalid Review Artifact reference.')
        artifactIds.add(id)
      }
      const sourceIds: string[] = scope.sourceDocumentVersionIds ?? []
      if (!Array.isArray(sourceIds) || sourceIds.some((id) => typeof id !== 'string'))
        throw new Error('Invalid Review source reference.')
      for (const row of await client.artifactVersion.findMany({
        where: { id: { in: sourceIds } },
        select: { id: true }
      }))
        artifactIds.add(row.id)
      for (const row of await client.uploadVersion.findMany({
        where: { id: { in: sourceIds } },
        select: { id: true }
      }))
        uploadIds.add(row.id)
      if (sourceIds.some((id) => !artifactIds.has(id) && !uploadIds.has(id)))
        throw new Error('Review references missing source evidence.')
    }
    for (const row of versions) if (row.basedOnVersionId) artifactIds.add(row.basedOnVersionId)
    for (const row of uploads) if (row.basedOnVersionId) uploadIds.add(row.basedOnVersionId)
    for (const row of inputs) {
      if (row.sourceArtifactVersionId) artifactIds.add(row.sourceArtifactVersionId)
      if (row.sourceUploadVersionId) uploadIds.add(row.sourceUploadVersionId)
    }
    for (const row of findings) {
      reviewIds.add(row.reviewId)
      if (row.artifactVersionId) artifactIds.add(row.artifactVersionId)
    }
    for (const row of dispositions) {
      if (row.causeReviewId) reviewIds.add(row.causeReviewId)
      if (row.assessedArtifactVersionId) artifactIds.add(row.assessedArtifactVersionId)
    }
    if (count === artifactIds.size + uploadIds.size + reviewIds.size) break
  }
  const versions = await client.artifactVersion.findMany({
    where: { id: { in: [...artifactIds] } },
    orderBy: { id: 'asc' }
  })
  const uploadVersions = await client.uploadVersion.findMany({
    where: { id: { in: [...uploadIds] } },
    orderBy: { id: 'asc' }
  })
  if (versions.length !== artifactIds.size || uploadVersions.length !== uploadIds.size)
    throw new Error('Session package references a missing immutable Version.')
  if (
    versions.some((row) => row.state === 'staging') ||
    uploadVersions.some((row) => row.state !== 'ready')
  )
    throw new Error('Wait for file writes to finish before exporting.')
  const lineages = await client.artifactLineage.findMany({
    where: { id: { in: versions.map((row) => row.artifactId) } },
    orderBy: { id: 'asc' }
  })
  const uploads = await client.uploadFile.findMany({
    where: { id: { in: uploadVersions.map((row) => row.uploadFileId) } },
    orderBy: { id: 'asc' }
  })
  const inputs = await client.artifactVersionInput.findMany({
    where: { artifactVersionId: { in: [...artifactIds] } },
    orderBy: { id: 'asc' }
  })
  const messageSnapshots = await client.artifactMessageSnapshot.findMany({
    where: {
      id: { in: versions.flatMap((row) => (row.messageSnapshotId ? [row.messageSnapshotId] : [])) }
    },
    orderBy: { id: 'asc' }
  })
  const origins = await client.fileOriginSession.findMany({
    where: {
      OR: [...lineages, ...uploads, ...messageSnapshots].map((row) => ({
        projectId: row.projectId,
        sessionId: row.sessionId
      }))
    },
    orderBy: [{ projectId: 'asc' }, { sessionId: 'asc' }]
  })
  const reviews = await client.review.findMany({
    where: { id: { in: [...reviewIds] } },
    orderBy: { id: 'asc' }
  })
  if (reviews.some((row) => row.lifecycle === 'running'))
    throw new Error('Wait for Reviews to finish before exporting.')
  const findings = await client.finding.findMany({
    where: { reviewId: { in: reviews.map((row) => row.id) } },
    orderBy: { id: 'asc' }
  })
  const dispositions = await client.reviewFindingDisposition.findMany({
    where: { sourceFindingId: { in: findings.map((row) => row.id) } },
    orderBy: { id: 'asc' }
  })
  const reviewSnapshots = await client.reviewScopeSnapshot.findMany({
    where: { reviewId: { in: reviews.map((row) => row.id) } },
    orderBy: { id: 'asc' }
  })
  return {
    schemaVersion: 1,
    tables: {
      UploadFile: uploads.map((row) => encodeRow('UploadFile', row)),
      UploadVersion: uploadVersions.map((row) => encodeRow('UploadVersion', row)),
      ArtifactVersionInput: inputs.map((row) => encodeRow('ArtifactVersionInput', row)),
      ArtifactMessageSnapshot: messageSnapshots.map((row) =>
        encodeRow('ArtifactMessageSnapshot', row)
      ),
      Review: reviews.map((row) => encodeRow('Review', row)),
      Finding: findings.map((row) => encodeRow('Finding', row)),
      ReviewFindingDisposition: dispositions.map((row) =>
        encodeRow('ReviewFindingDisposition', row)
      ),
      ReviewScopeSnapshot: reviewSnapshots.map((row) => encodeRow('ReviewScopeSnapshot', row)),
      FileOriginSession: origins.map((row) => encodeRow('FileOriginSession', row)),
      ArtifactLineage: lineages.map((row) => encodeRow('ArtifactLineage', row)),
      ArtifactVersion: versions.map((row) => encodeRow('ArtifactVersion', row))
    }
  }
}

export const parseNativeRecords = (value: unknown): PackageRecords => {
  if (
    !value ||
    typeof value !== 'object' ||
    !('schemaVersion' in value) ||
    value.schemaVersion !== 1 ||
    !('tables' in value) ||
    !value.tables ||
    typeof value.tables !== 'object'
  )
    throw new Error('Unsupported package records.')
  const tables = value.tables as Record<string, unknown>
  if ('reproducibility' in value && value.reproducibility !== undefined)
    packageReproducibilitySchema.parse(value.reproducibility)
  if ('history' in value && value.history !== undefined) packageHistorySchema.parse(value.history)
  if (Object.keys(tables).length !== tableNames.length)
    throw new Error('Unsupported package record tables.')
  let count = 0
  for (const table of tableNames) {
    const rows = tables[table]
    if (!Array.isArray(rows)) throw new Error('Missing package record table.')
    count += rows.length
    if (count > 10000) throw new Error('Session package contains too many records.')
    const columns = COLUMNS[table].split(' ')
    for (const row of rows) {
      if (
        !row ||
        typeof row !== 'object' ||
        Object.keys(row).length !== columns.length ||
        columns.some((key) => !Object.hasOwn(row, key))
      )
        throw new Error('Unsupported package record columns.')
      if (
        Object.values(row).some(
          (item) => item !== null && !['string', 'number', 'boolean'].includes(typeof item)
        )
      )
        throw new Error('Invalid package record value.')
    }
  }
  return value as PackageRecords
}

export const nativeStorageKeys = (records: PackageRecords): string[] => [
  ...new Set(
    Object.values(records.tables).flatMap((rows) =>
      rows.flatMap((row) =>
        Object.entries(row).flatMap(([key, value]) =>
          /(?:StorageKey|storageKey)$/.test(key) && typeof value === 'string' ? [value] : []
        )
      )
    )
  )
]

export const notebookStorageKeys = async (
  storageRoot: string,
  request: SessionPackageRequest
): Promise<string[]> => {
  const keys: string[] = []
  let visited = 0
  const visit = async (key: string, depth = 0): Promise<void> => {
    if (++visited > 10000 || depth > 64)
      throw new Error('Session package directory traversal exceeds its limit.')
    const entries = await assertPackageSourcePath(storageRoot, key)
      .then(() =>
        readdir(resolveStorageKey(storageRoot, key), {
          withFileTypes: true
        })
      )
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return []
        throw error
      })
    for (const entry of entries) {
      const child = `${key}/${entry.name}`
      if (entry.isDirectory()) await visit(child, depth + 1)
      else if (entry.isFile()) keys.push(child)
      else throw new Error('Session package source contains a link or special file.')
      if (keys.length > 10000) throw new Error('Session package contains too many files.')
    }
  }
  await visit(`notebooks/${request.projectId}/${request.sessionId}`)
  return keys.sort()
}

export const notebookDocumentIdentity = (
  key: string
): { projectId: string; sessionId: string; frameId?: string } | undefined => {
  const match = /^notebooks\/([^/]+)\/([^/]+)\/(?:frames\/([^/]+)\/)?run\.json$/.exec(key)
  return match ? { projectId: match[1], sessionId: match[2], frameId: match[3] } : undefined
}

export const readPackageNotebooks = async (
  storageRoot: string,
  keys: readonly string[]
): Promise<NotebookRunDocument[]> => {
  const repository = new NotebookRunRepository(storageRoot)
  const documents: NotebookRunDocument[] = []
  for (const key of keys) {
    const identity = notebookDocumentIdentity(key)
    if (!identity) continue
    // Bound JSON before calling the existing strict ownership/shape reader, which also validates
    // working-file paths. A user's data/run.json is ordinary evidence, not a Notebook document.
    await readPackageJson(resolveStorageKey(storageRoot, key))
    const document = await repository.findExisting(
      identity.projectId,
      identity.sessionId,
      identity.frameId
        ? createFrameNotebookLane(identity.projectId, identity.sessionId, identity.frameId)
        : undefined
    )
    if (!document) throw new Error('Notebook history is missing.')
    if (document.runs.length > 10000) throw new Error('Notebook history exceeds the package limit.')
    if (document.runs.some((run) => run.status === 'running' || run.status === 'queued'))
      throw new Error('Wait for Notebook runs to finish before exporting.')
    documents.push(document)
  }
  return documents
}

export const sessionFileVersionIds = (session: PersistedChatSession): string[] => {
  const ids = new Set<string>()
  if (session.runtimeContext?.plan) ids.add(session.runtimeContext.plan.artifactVersionId)
  for (const binding of session.runtimeContext?.pdfContext?.bindings ?? [])
    ids.add(binding.sourceVersionId)
  for (const message of session.conversationGraph?.messages ?? session.messages) {
    for (const binding of message.pdfContext?.bindings ?? []) ids.add(binding.sourceVersionId)
    for (const annotation of message.annotations ?? []) {
      if (annotation.kind === 'pdf' || annotation.kind === 'image-point')
        ids.add(annotation.source.versionId)
      else if (annotation.source.kind === 'project-file') {
        const identity = resolveManagedProjectFileAnnotationIdentity(annotation.source)
        if (!identity)
          throw new Error('Legacy file references must have immutable Versions before packaging.')
        ids.add(identity.versionId)
      }
    }
    for (const upload of message.uploads ?? []) {
      if (!upload.versionId)
        throw new Error('Legacy attachments must have immutable Versions before packaging.')
      ids.add(upload.versionId)
    }
    for (const part of message.parts ?? []) {
      if (part.type === 'artifact' && part.source !== 'linked-folder') {
        if (!part.versionId)
          throw new Error('Legacy file references must have immutable Versions before packaging.')
        ids.add(part.versionId)
      }
    }
    for (const id of message.delegatedInputVersionIds ?? []) ids.add(id)
  }
  return [...ids]
}

export const remapStorageKey = (key: string, identities: Record<string, string>): string => {
  const segments = key.split('/')
  const map = (index: number): void => {
    segments[index] = identities[segments[index]] ?? segments[index]
  }
  map(1)
  if (!(segments[0] === 'execution-file-evidence' && segments[2] === 'blobs')) map(2)
  if (segments[0] === 'execution-file-evidence') {
    const activity = segments.findIndex((segment) => segment.startsWith('activity-'))
    if (activity >= 0) {
      const id = segments[activity].slice('activity-'.length)
      if (identities[id]) segments[activity] = `activity-${identities[id]}`
    }
  }
  if (segments[0] === 'artifacts' && segments[3] === '.provenance') {
    if (['message-snapshots', 'review-scope-snapshots'].includes(segments[4])) {
      const id = segments[5]?.replace(/\.json$/, '')
      if (id && identities[id]) segments[5] = `${identities[id]}.json`
    } else {
      map(4)
      if (segments[5] === 'versions') map(6)
    }
  } else if (segments[0] === 'uploads' && segments[4] === 'versions') {
    map(3)
    map(5)
  } else if (
    ['notebooks', 'execution-file-evidence'].includes(segments[0]) &&
    segments[3] === 'frames'
  ) {
    map(4)
  }
  // Data filenames are not identities, even when a researcher named a file after a Session id.
  return segments.join('/')
}

// A dependency package may include an older pinned Version without the source file's newer head.
// The original head remains in records.json; native navigation uses the newest included Version.
export const projectIncludedHeads = (source: PackageRecords): PackageRecords => {
  const records = structuredClone(source)
  for (const [files, versions, ownerKey] of [
    [records.tables.ArtifactLineage, records.tables.ArtifactVersion, 'artifactId'],
    [records.tables.UploadFile, records.tables.UploadVersion, 'uploadFileId']
  ] as const) {
    for (const file of files) {
      const included = versions.filter((version) => version[ownerKey] === file.id)
      if (!included.some((version) => version.id === file.currentVersionId)) {
        file.currentVersionId =
          included.sort((a, b) => Number(b.versionNumber) - Number(a.versionNumber))[0]?.id ?? null
      }
    }
  }
  return records
}

export const mapPackageReferences = (
  value: unknown,
  identities: Record<string, string>,
  key = '',
  checksums: Record<string, string> = {}
): unknown => {
  if (key === 'sourceScope' || key === 'sourceSessionCheck') return value
  if (['content', 'text', 'script', 'code', 'outputs', 'structuredOutputEvidence'].includes(key))
    return value
  if (typeof value === 'string') {
    if (/(?:Checksum|checksum)$/.test(key)) return checksums[value] ?? value
    if (key === 'path') {
      const artifact = parseArtifactVersionLocator(value)
      if (artifact)
        return createArtifactVersionLocator(
          mapPackageReferences(artifact, identities) as typeof artifact
        )
      const upload = parseUploadVersionReference(value)
      if (upload) {
        const mapped = mapPackageReferences(upload, identities) as typeof upload
        return createUploadVersionReference(
          mapped.versionId,
          mapped.projectId && mapped.sessionId
            ? { projectId: mapped.projectId, sessionId: mapped.sessionId, fileId: mapped.fileId }
            : undefined
        )
      }
    }
    if (key === 'id' || /(?:Ids?|_ids?)$/.test(key)) {
      if (identities[value]) return identities[value]
      const tagged =
        /^(artifact-version:|artifact-publication:|file-generation:|registered-input:(?:artifact-version|upload-version):)(.+)$/.exec(
          value
        )
      return tagged && identities[tagged[2]] ? `${tagged[1]}${identities[tagged[2]]}` : value
    }
    if (/(?:StorageKey|storageKey|storage_key)$/.test(key))
      return remapStorageKey(value, identities)
    if (
      [
        'path',
        'cwd',
        'cwdBefore',
        'cwdAfter',
        'notebookSessionRoot',
        'dataRoot',
        'workspaceCwd'
      ].includes(key) &&
      value.startsWith('$DATA/')
    )
      return `$DATA/${remapStorageKey(value.slice(6), identities)}`
    return value
  }
  if (Array.isArray(value))
    return value.map((item) => mapPackageReferences(item, identities, key, checksums))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        name,
        mapPackageReferences(item, identities, name, checksums)
      ])
    )
  return value
}

export const prepareNativeImport = async (
  sourceDirectory: string,
  destinationRoot: string,
  manifest: SessionPackageManifest,
  records: PackageRecords,
  projectId: string,
  sessionId: string,
  session?: PersistedChatSession,
  signal?: AbortSignal,
  onProgress?: (progress: import('../../shared/session-package').PackageProgress) => void
): Promise<{
  records: PackageRecords
  identities: Record<string, string>
  checksums: Record<string, string>
}> => {
  const identities: Record<string, string> = Object.create(null)
  const checksums: Record<string, string> = Object.create(null)
  const mapReferences = (value: unknown, ids = identities): unknown =>
    mapPackageReferences(value, ids, '', checksums)
  identities[manifest.source.projectId] = projectId
  identities[manifest.source.sessionId] = sessionId
  const context = session?.runtimeContext
  const contextIds = [
    context?.sideChat?.id,
    ...(context?.sideChat?.entries.map((entry) => entry.id) ?? []),
    ...(context?.pdfContext?.bindings.map((binding) => binding.bindingId) ?? []),
    ...(context?.delegatedWork?.records.flatMap((record) =>
      record.attempts.map((attempt) => attempt.id)
    ) ?? [])
  ]
  for (const id of contextIds) if (id) identities[id] ??= randomUUID()
  const graph = session?.conversationGraph
  if (graph)
    for (const entities of [
      graph.frames,
      graph.branches,
      graph.messages,
      graph.runtimeSegments,
      graph.activities,
      graph.activityGroups
    ]) {
      for (const entity of entities) identities[entity.id] ??= randomUUID()
    }
  for (const rows of Object.values(records.tables)) {
    for (const row of rows) {
      if (typeof row.projectId === 'string') identities[row.projectId] ??= projectId
      if (typeof row.sessionId === 'string') identities[row.sessionId] ??= randomUUID()
      if (typeof row.id === 'string') identities[row.id] ??= randomUUID()
      if (typeof row.writeOperationId === 'string')
        identities[row.writeOperationId] ??= randomUUID()
      for (const key of ['artifactRunId', 'producerRunId'])
        if (typeof row[key] === 'string') identities[row[key]] ??= randomUUID()
    }
  }
  for (const entry of manifest.inventory) {
    if (!entry.storageKey || !notebookDocumentIdentity(entry.storageKey)) continue
    const document = (await readPackageJson(join(sourceDirectory, entry.path))) as {
      runs?: { runId?: string; cellId?: string }[]
    }
    for (const run of document.runs ?? []) {
      if (typeof run.runId === 'string') identities[run.runId] ??= randomUUID()
      if (typeof run.cellId === 'string') identities[run.cellId] ??= randomUUID()
    }
  }
  const sidecars = new Map<string, ReturnType<typeof executionEvidenceSchema.parse>>()
  for (const entry of manifest.inventory) {
    if (
      !entry.storageKey?.startsWith('execution-file-evidence/') ||
      !entry.storageKey.endsWith('/evidence.json')
    )
      continue
    const value = executionEvidenceSchema.parse(
      await readPackageJson(join(sourceDirectory, entry.path))
    )
    for (const id of [
      value.activityId,
      value.evidenceId,
      ...value.relations.flatMap((relation) =>
        relation.generation ? [relation.generation.generationId] : []
      )
    ])
      identities[id] ??= randomUUID()
    sidecars.set(entry.storageKey, value)
  }
  const transformedSidecars = new Map<string, string>()
  for (const entry of manifest.inventory) {
    const value = entry.storageKey ? sidecars.get(entry.storageKey) : undefined
    if (!value) continue
    const json = canonicalJson(mapReferences(value) as CanonicalJson)
    checksums[entry.checksum] = sha256(json)
    transformedSidecars.set(entry.storageKey!, json)
  }
  const contentEntries = manifest.inventory.filter((entry) => entry.storageKey)
  const totalBytes = contentEntries.reduce((sum, entry) => sum + entry.sizeBytes, 0)
  await assertPackageCapacity(dirname(destinationRoot), totalBytes)
  let completedBytes = 0
  let completedFiles = 0
  for (const entry of contentEntries) {
    if (!entry.storageKey) continue
    const target = resolveStorageKey(
      destinationRoot,
      remapStorageKey(entry.storageKey!, identities)
    )
    await mkdir(dirname(target), { recursive: true })
    await copyFileWithinBudget(
      join(sourceDirectory, entry.path),
      target,
      entry.sizeBytes,
      signal,
      (bytes) =>
        onProgress?.({
          phase: 'importing',
          completedBytes: completedBytes + bytes,
          totalBytes,
          completedFiles,
          totalFiles: contentEntries.length,
          currentFile: entry.storageKey
        })
    )
    completedBytes += entry.sizeBytes
    completedFiles += 1
    const sidecar = transformedSidecars.get(entry.storageKey)
    if (sidecar) await writeFile(target, sidecar)
    if (notebookDocumentIdentity(entry.storageKey)) {
      const document = mapReferences(await readPackageJson(target), identities) as Record<
        string,
        unknown
      >
      const rootKey = remapStorageKey(entry.storageKey, identities).slice(0, -'/run.json'.length)
      document.notebookSessionRoot = `$DATA/${rootKey}`
      document.workspaceCwd = `$DATA/${rootKey}`
      document.dataRoot = `$DATA/${rootKey}/data`
      document.kernel = { runtimeRoot: '$DATA/runtime' }
      if (!Array.isArray(document.runs)) throw new Error('Invalid Notebook run history.')
      for (const run of document.runs) {
        if (run.status === 'running' || run.status === 'queued')
          throw new Error('Wait for Notebook runs to finish before exporting.')
        for (const file of run.workingFiles ?? []) {
          if (typeof file.relativePath !== 'string')
            throw new Error('Notebook file has no portable relative path.')
          const key = `${rootKey}/${file.relativePath.replaceAll('\\', '/')}`
          resolveStorageKey(destinationRoot, key)
          file.path = `$DATA/${key}`
        }
      }
      await writeFile(target, JSON.stringify(document))
    }
  }
  // Byte totals describe copying only. Derived evidence still needs validation after the last
  // file, so discard counters before the unmeasurable work rather than leaving the UI at 100%.
  onProgress?.({ phase: 'validating' })
  const mapped = projectIncludedHeads(mapReferences(records, identities) as PackageRecords)
  for (const row of mapped.tables.ArtifactMessageSnapshot) {
    if (typeof row.storageKey !== 'string') throw new Error('Invalid Message snapshot storage key.')
    const file = resolveStorageKey(destinationRoot, row.storageKey)
    const json = canonicalJson(
      mapReferences(JSON.parse(await readFile(file, 'utf8')), identities) as CanonicalJson
    )
    row.checksum = sha256(json)
    await writeFile(file, json)
  }
  for (const rows of Object.values(mapped.tables)) {
    for (const row of rows) {
      for (const jsonKey of [
        'scope',
        'locator',
        'reviewerLog',
        'assessmentSnapshot',
        'retainedReviewIdsJson'
      ]) {
        if (typeof row[jsonKey] === 'string')
          row[jsonKey] = JSON.stringify(mapReferences(JSON.parse(row[jsonKey]), identities))
      }
    }
  }
  for (const row of mapped.tables.ReviewScopeSnapshot) {
    if (typeof row.snapshotJson !== 'string' || typeof row.storageKey !== 'string')
      throw new Error('Invalid Review snapshot.')
    row.snapshotJson = canonicalJson(
      mapReferences(JSON.parse(row.snapshotJson), identities) as CanonicalJson
    )
    row.checksum = sha256(row.snapshotJson)
    await writeFile(resolveStorageKey(destinationRoot, row.storageKey), row.snapshotJson)
  }
  for (const row of mapped.tables.ArtifactVersion) {
    for (const [jsonKey, hashKey, storageKey] of [
      ['executionSnapshotJson', 'executionSnapshotChecksum', 'executionSnapshotStorageKey'],
      ['evidenceJson', 'evidenceChecksum', 'evidenceStorageKey']
    ]) {
      if (typeof row[jsonKey] !== 'string') continue
      const value = mapReferences(JSON.parse(row[jsonKey]), identities) as Record<
        string,
        CanonicalJson
      >
      if (jsonKey === 'executionSnapshotJson') {
        // The source snapshot was validated before remapping. Its derived local graph now has
        // different identities, so seal the recipe again before computing the outer checksum.
        const snapshot = value as unknown as PersistedArtifactExecutionSnapshot
        if (snapshot.analysisRevision && snapshot.provenanceGraph) {
          // Preserve the source analyzer revisions; remapping does not rerun analysis.
          const fields = {
            schemaVersion: snapshot.analysisRevision.schemaVersion,
            ...(snapshot.analysisRevision.dependencyAnalyzer
              ? { dependencyAnalyzer: snapshot.analysisRevision.dependencyAnalyzer }
              : {}),
            lineageBuilder: snapshot.analysisRevision.lineageBuilder,
            graphChecksum: sha256(canonicalJson(value.provenanceGraph))
          }
          snapshot.analysisRevision = { ...fields, revisionId: sha256(canonicalJson(fields)) }
        }
        if (snapshot.reproducibilityRecipe && snapshot.provenanceGraph)
          snapshot.reproducibilityRecipe = sealArtifactReproducibilityRecipe({
            ...snapshot,
            provenanceGraph: snapshot.provenanceGraph
          })
      }
      if (
        jsonKey === 'evidenceJson' &&
        row.executionSnapshotChecksum &&
        value.execution_snapshot_checksum
      )
        value.execution_snapshot_checksum = row.executionSnapshotChecksum
      const json = canonicalJson(value)
      row[jsonKey] = json
      row[hashKey] = sha256(json)
      if (typeof row[storageKey] === 'string')
        await writeFile(resolveStorageKey(destinationRoot, row[storageKey]), json)
    }
  }
  for (const version of mapped.reproducibility?.versions ?? []) {
    version.entityIds = Object.fromEntries(
      Object.entries(version.entityIds).map(([sourceId, localId]) => [
        sourceId,
        mapPackageReferences(localId, identities, 'entityId') as string
      ])
    )
    version.metadataKeys = version.metadataKeys.map((key) => remapStorageKey(key, identities))
    for (const output of version.outputs)
      output.storageKey = remapStorageKey(output.storageKey, identities)
  }
  return { records: mapped, identities, checksums }
}

export const prepareNativePublication = (
  records: PackageRecords
): ((client: Prisma.TransactionClient) => Promise<void>) => {
  const statements: { sql: string; values: NativeRow[string][] }[] = []
  for (const table of tableNames) {
    const columns = COLUMNS[table].split(' ')
    const model = Prisma.dmmf.datamodel.models.find((candidate) => candidate.name === table)!
    const fields = columns.map((column) => model.fields.find((field) => field.name === column)!)
    const prefix = `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(',')}) VALUES `
    const tuple = `(${columns.map(() => '?').join(',')})`
    let batch: NativeRow[string][] = []
    let batchBytes = 0
    const flush = (): void => {
      if (!batch.length) return
      statements.push({
        sql:
          prefix +
          Array(batch.length / columns.length)
            .fill(tuple)
            .join(','),
        values: batch
      })
      batch = []
      batchBytes = 0
    }
    for (const row of records.tables[table]) {
      const values = columns.map((column, index) => {
        const value = row[column]
        if (value === null) return null
        const field = fields[index]
        if (field.type === 'DateTime') {
          if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
            throw new Error('Invalid package timestamp.')
          return Date.parse(value)
        }
        if (field.type === 'BigInt') {
          if (
            typeof value !== 'string' ||
            !/^\d+$/.test(value) ||
            !Number.isSafeInteger(Number(value))
          )
            throw new Error('Invalid package byte count.')
          return Number(value)
        }
        return value
      })
      const bytes = values.reduce<number>(
        (sum, value) => sum + (typeof value === 'string' ? Buffer.byteLength(value) : 8),
        0
      )
      // Stay below SQLite's conservative 999-variable ceiling and bound ordinary batches. An
      // individually large, already-validated metadata row remains a single statement.
      if (batch.length + values.length > 900 || batchBytes + bytes > 256 * 1024) flush()
      batch.push(...values)
      batchBytes += bytes
    }
    flush()
  }
  // Conversion and allocation finish before the sole application connection is acquired. No file
  // work, pacing or yields inside this atomic publication; the existing witness owns recovery.
  return async (client) => {
    await client.$executeRawUnsafe('PRAGMA defer_foreign_keys = ON')
    for (const statement of statements)
      await client.$executeRawUnsafe(statement.sql, ...statement.values)
  }
}
