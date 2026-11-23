import { ApplicationCommandError } from '../../shared/application-command-contract'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ArtifactVersion, Prisma, PrismaClient } from '@prisma/client'
import { writeDurableJsonFile } from '@aipoch/durable-files'
import {
  assertProjectRecordPath,
  getProjectRecordRoot,
  listProjectRecordIds,
  getProjectRecordRoute,
  PROJECT_RECORD_DIRECTORY,
  readProjectRecordManifest
} from '../storage/data-location-identity'

type Client = Prisma.TransactionClient
type Row = Record<string, unknown>
// A closed set of research metadata, never provider history, credentials or global settings.
const scopes = {
  ArtifactLineage: '"projectId" = ?',
  ArtifactVersion: '"artifactId" IN (SELECT "id" FROM "ArtifactLineage" WHERE "projectId" = ?)',
  ArtifactVersionInput:
    '"artifactVersionId" IN (SELECT v."id" FROM "ArtifactVersion" v JOIN "ArtifactLineage" a ON a."id" = v."artifactId" WHERE a."projectId" = ?)',
  ArtifactLiteratureManifest:
    '"artifactVersionId" IN (SELECT v."id" FROM "ArtifactVersion" v JOIN "ArtifactLineage" a ON a."id" = v."artifactId" WHERE a."projectId" = ?)',
  ArtifactMessageSnapshot: '"projectId" = ?',
  FileOriginSession: '"projectId" = ?',
  UploadFile: '"projectId" = ?',
  UploadVersion: '"uploadFileId" IN (SELECT "id" FROM "UploadFile" WHERE "projectId" = ?)',
  ContentBlob: 'instr("storageKey", ?) = 1',
  PdfDocument:
    '"id" IN (SELECT "pdfDocumentId" FROM "ContentBlob" WHERE instr("storageKey", ?) = 1)',
  Review: '"projectId" = ?',
  Finding: '"reviewId" IN (SELECT "id" FROM "Review" WHERE "projectId" = ?)',
  ReviewScopeSnapshot: '"projectId" = ?',
  ReviewFindingDisposition:
    '"sourceFindingId" IN (SELECT f."id" FROM "Finding" f JOIN "Review" r ON r."id" = f."reviewId" WHERE r."projectId" = ?)'
} as const
const mutations = new Set([
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany'
])
const encode = (value: unknown): unknown => {
  if (typeof value === 'bigint') return { $integer: String(value) }
  if (value instanceof Date) return { $date: value.toISOString() }
  if (Array.isArray(value)) return value.map(encode)
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v)]))
  return value
}
const decode = (value: unknown): unknown => {
  if (value && typeof value === 'object' && '$integer' in value)
    return BigInt(String(value.$integer))
  if (value && typeof value === 'object' && '$date' in value) return new Date(String(value.$date))
  return value
}

const suppressed = new Set<string>()
const clients = new WeakMap<object, PrismaClient>()

export type CommittedReviewProjection = {
  [Model in 'review' | 'finding' | 'reviewFindingDisposition']: Pick<
    PrismaClient[Model],
    'findMany'
  >
}

// Used only to preserve Review lifecycle and history when the portable authority is unavailable.
// Give the reader only query delegates, with one committed SQLite snapshot for summaries and Checks.
export const readCommittedReviewProjection = <Result>(
  client: CommittedReviewProjection,
  read: (projection: CommittedReviewProjection) => Promise<Result>
): Promise<Result> => {
  const underlying = clients.get(client)
  const query = (tx: CommittedReviewProjection): Promise<Result> =>
    read({
      review: tx.review,
      finding: tx.finding,
      reviewFindingDisposition: tx.reviewFindingDisposition
    })
  return underlying ? underlying.$transaction(query) : query(client)
}
const checkpointKey = (storageRoot: string, projectId: string): string =>
  JSON.stringify([storageRoot, projectId])
export const suspendProjectRecordIndexCheckpoints = (
  storageRoot: string,
  projectId: string
): void => {
  suppressed.add(checkpointKey(storageRoot, projectId))
}
export const resumeProjectRecordIndexCheckpoints = (
  storageRoot: string,
  projectId: string
): void => {
  suppressed.delete(checkpointKey(storageRoot, projectId))
}

const fingerprint = (root: string, text: string): string =>
  `${root}:${createHash('sha256').update(text).digest('hex')}`
const snapshot = async (
  client: Client,
  storageRoot: string,
  projectIds: ReadonlySet<string>
): Promise<Map<string, string>> => {
  const published = new Map<string, string>()
  for (const projectId of projectIds) {
    const root = await activeRecordRoot(client, storageRoot, projectId)
    if (!root) continue
    const tables: Record<string, Row[]> = {}
    for (const [table, where] of Object.entries(scopes)) {
      tables[table] = await client.$queryRawUnsafe<Row[]>(
        `SELECT * FROM "${table}" WHERE ${where}`,
        ['ContentBlob', 'PdfDocument'].includes(table) ? `artifacts/${projectId}/` : projectId
      )
    }
    // Preserve the identity and facts of referenced sources even if their owning project is not
    // reopened. This does not claim that external source bytes are still present.
    const append = async (table: string, field: string, values: unknown[]): Promise<boolean> => {
      const primary = table === 'ArtifactLiteratureManifest' ? 'artifactVersionId' : 'id'
      const existing = new Set(tables[table].map((row) => row[primary]))
      const missing = [...new Set(values)].filter((value) => value != null)
      if (!missing.length) return false
      const rows = await client.$queryRawUnsafe<Row[]>(
        `SELECT * FROM "${table}" WHERE "${field}" IN (${missing.map(() => '?').join(',')})`,
        ...missing
      )
      const added = rows.filter((row) => !existing.has(row[primary]))
      tables[table].push(...added)
      return added.length > 0
    }
    for (;;) {
      const before = tables.ArtifactVersion.length + tables.ArtifactVersionInput.length
      await append(
        'ArtifactVersion',
        'id',
        tables.ArtifactVersionInput.map((row) => row.sourceArtifactVersionId)
      )
      await append(
        'ArtifactLineage',
        'id',
        tables.ArtifactVersion.map((row) => row.artifactId)
      )
      await append(
        'ArtifactVersion',
        'artifactId',
        tables.ArtifactLineage.map((row) => row.id)
      )
      await append(
        'ArtifactVersionInput',
        'artifactVersionId',
        tables.ArtifactVersion.map((row) => row.id)
      )
      if (before === tables.ArtifactVersion.length + tables.ArtifactVersionInput.length) break
    }
    await append(
      'UploadVersion',
      'id',
      tables.ArtifactVersionInput.map((row) => row.sourceUploadVersionId)
    )
    await append(
      'UploadFile',
      'id',
      tables.UploadVersion.map((row) => row.uploadFileId)
    )
    await append(
      'UploadVersion',
      'uploadFileId',
      tables.UploadFile.map((row) => row.id)
    )
    await append(
      'ArtifactMessageSnapshot',
      'id',
      tables.ArtifactVersion.map((row) => row.messageSnapshotId)
    )
    await append(
      'ArtifactLiteratureManifest',
      'artifactVersionId',
      tables.ArtifactVersion.map((row) => row.id)
    )
    await append(
      'ContentBlob',
      'id',
      [...tables.ArtifactVersion, ...tables.UploadVersion].map((row) => row.contentBlobId)
    )
    await append(
      'PdfDocument',
      'id',
      tables.ContentBlob.map((row) => row.pdfDocumentId)
    )
    for (const row of [
      ...tables.ArtifactLineage,
      ...tables.UploadFile,
      ...tables.ArtifactMessageSnapshot,
      ...tables.ArtifactVersionInput.map((row) => ({
        projectId: row.sourceProjectId,
        sessionId: row.sourceSessionId
      }))
    ]) {
      if (
        !tables.FileOriginSession.some(
          (origin) => origin.projectId === row.projectId && origin.sessionId === row.sessionId
        )
      ) {
        tables.FileOriginSession.push(
          ...(await client.$queryRawUnsafe<Row[]>(
            'SELECT * FROM "FileOriginSession" WHERE "projectId" = ? AND "sessionId" = ?',
            row.projectId,
            row.sessionId
          ))
        )
      }
    }
    const text = JSON.stringify(encode({ version: 1, projectId, tables })) + '\n'
    await writeDurableJsonFile(
      assertProjectRecordPath(root, join(root, 'artifact-index.json')),
      text
    )
    published.set(projectId, fingerprint(root, text))
  }
  return published
}

// Restore metadata only. Missing/corrupt immutable bytes remain unavailable through the ordinary
// checksum-verified readers; rebuilding never invents content or generation evidence.
export const restoreProjectRecordIndexes = async (
  client: PrismaClient,
  storageRoot: string,
  projectId: string
): Promise<void> => {
  client = clients.get(client) ?? client
  await client.$transaction((tx) =>
    restoreProjectRecordIndexesWithinTransaction(tx, storageRoot, projectId)
  )
}

type IndexTable = keyof typeof scopes

// These fields identify the row's authority even when its mutable projection is older on disk.
const restoreIdentities: Record<IndexTable, readonly string[]> = {
  ArtifactLineage: ['projectId', 'sessionId', 'normalizedFilename'],
  ArtifactVersion: ['artifactId', 'versionNumber', 'basedOnVersionId'],
  ArtifactVersionInput: [
    'artifactVersionId',
    'sourceProjectId',
    'sourceSessionId',
    'sourceArtifactVersionId',
    'sourceUploadVersionId'
  ],
  ArtifactLiteratureManifest: [],
  ArtifactMessageSnapshot: ['projectId', 'sessionId', 'storageKey'],
  FileOriginSession: ['projectId', 'sessionId'],
  UploadFile: ['projectId', 'sessionId'],
  UploadVersion: ['uploadFileId', 'versionNumber', 'basedOnVersionId'],
  ContentBlob: ['storageKey', 'checksum', 'sizeBytes'],
  PdfDocument: ['checksum', 'sizeBytes'],
  Review: ['projectId', 'sessionId', 'turnMessageId'],
  Finding: ['reviewId'],
  ReviewScopeSnapshot: ['projectId', 'sessionId', 'reviewId'],
  ReviewFindingDisposition: ['sourceFindingId', 'causeReviewId', 'sequence']
}

const versionContentFacts = ['checksum', 'sizeBytes', 'contentStorageKey'] as const
const publishedVersionStates = {
  ArtifactVersion: ['pending', 'finalized'],
  UploadVersion: ['ready']
} as const

const foreignSourceFacts: Partial<Record<IndexTable, readonly string[]>> = {
  ArtifactVersion: [...versionContentFacts, 'evidenceChecksum', 'executionSnapshotChecksum'],
  UploadVersion: versionContentFacts,
  ArtifactVersionInput: ['checksum', 'sizeBytes', 'storageKey'],
  ArtifactLiteratureManifest: ['checksum']
}

const scopeParents: Partial<Record<IndexTable, readonly [IndexTable, string]>> = {
  ArtifactVersion: ['ArtifactLineage', 'artifactId'],
  ArtifactVersionInput: ['ArtifactVersion', 'artifactVersionId'],
  ArtifactLiteratureManifest: ['ArtifactVersion', 'artifactVersionId'],
  UploadVersion: ['UploadFile', 'uploadFileId'],
  Finding: ['Review', 'reviewId'],
  ReviewScopeSnapshot: ['Review', 'reviewId'],
  ReviewFindingDisposition: ['Finding', 'sourceFindingId']
}

// Review history is always local to the Project being checkpointed. The provenance collector
// only appends foreign Artifact and Upload sources and their supporting records.
const projectOnlyIndexTables = new Set<IndexTable>([
  'Review',
  'Finding',
  'ReviewScopeSnapshot',
  'ReviewFindingDisposition'
])

const pruneScopeConflicts: Partial<Record<IndexTable, string>> = {
  ArtifactMessageSnapshot: `SELECT 1 FROM "ArtifactVersion" v
    JOIN "ArtifactLineage" a ON a."id" = v."artifactId"
    WHERE v."messageSnapshotId" = "ArtifactMessageSnapshot"."id"
      AND a."projectId" <> "ArtifactMessageSnapshot"."projectId"`,
  Review: `SELECT 1 FROM "ReviewScopeSnapshot" s
    WHERE s."reviewId" = "Review"."id" AND s."projectId" <> "Review"."projectId"`,
  ReviewScopeSnapshot: `SELECT 1 FROM "Review" r
    WHERE r."id" = "ReviewScopeSnapshot"."reviewId"
      AND r."projectId" <> "ReviewScopeSnapshot"."projectId"`
}

type RestoredScope = { projectId: string; sessionId: string }
const sameRestoredScope = (
  left: RestoredScope | undefined,
  right: RestoredScope | undefined
): boolean =>
  left !== undefined &&
  right !== undefined &&
  left.projectId === right.projectId &&
  left.sessionId === right.sessionId
const indexTables = Object.keys(scopes) as IndexTable[]
const isIndexRow = (value: unknown): value is Row =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const assertSameIndexIdentity = (
  table: IndexTable,
  fields: readonly string[],
  existing: Row,
  row: Row
): void => {
  for (const key of fields) {
    if (key in row && existing[key] !== row[key])
      throw new Error(`Conflicting project Artifact index identity: ${table}.${key}`)
  }
}

export const restoreProjectRecordIndexesWithinTransaction = async (
  tx: Prisma.TransactionClient,
  storageRoot: string,
  projectId: string,
  checkpointText?: string
): Promise<void> => {
  // A caller supplying the already-read checkpoint validates its path before reading it.
  if (checkpointText === undefined) {
    const root = getProjectRecordRoot(storageRoot, projectId)
    if (!root) return
    try {
      checkpointText = await readFile(
        assertProjectRecordPath(root, join(root, 'artifact-index.json')),
        'utf8'
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
  const document: unknown = JSON.parse(checkpointText)
  if (
    !isIndexRow(document) ||
    document.version !== 1 ||
    document.projectId !== projectId ||
    !isIndexRow(document.tables)
  )
    throw new Error('Invalid project Artifact index.')

  const ownedIds = new Map<IndexTable, string[]>()
  const scopesByTable = new Map<IndexTable, Map<string, RestoredScope>>()
  const referencedSnapshots: Array<{ id: string; scope: RestoredScope }> = []
  const restoredVersions = { ArtifactVersion: [] as string[], UploadVersion: [] as string[] }
  const [priorDeferral] = await tx.$queryRawUnsafe<{ defer_foreign_keys: bigint }[]>(
    'PRAGMA defer_foreign_keys'
  )
  await tx.$executeRawUnsafe('PRAGMA defer_foreign_keys = ON')
  for (const table of indexTables) {
    const rows = document.tables[table]
    if (!Array.isArray(rows)) throw new Error('Incomplete project Artifact index.')
    const columns = await tx.$queryRawUnsafe<Array<{ name: string; pk: number }>>(
      `PRAGMA table_info("${table}")`
    )
    const names = new Set(columns.map((c) => c.name))
    const primary = columns
      .filter((c) => c.pk)
      .sort((a, b) => Number(a.pk) - Number(b.pk))
      .map((c) => c.name)
    const seen = new Set<string>()
    const rowScopes = new Map<string, RestoredScope>()
    const keep: string[] = []
    ownedIds.set(table, keep)
    scopesByTable.set(table, rowScopes)
    for (const encodedRow of rows) {
      if (!isIndexRow(encodedRow)) throw new Error('Invalid project Artifact index row.')
      const keys = Object.keys(encodedRow)
      if (keys.some((key) => !names.has(key)))
        throw new Error('Invalid project Artifact index columns.')
      const row = Object.fromEntries(keys.map((key) => [key, decode(encodedRow[key])]))
      const identity = primary.map((key) => row[key])
      const [id] = identity
      if (typeof id !== 'string' || !identity.every((key) => typeof key === 'string'))
        throw new Error(`Invalid project Artifact index identity: ${table}`)
      const serializedId = JSON.stringify(identity)
      if (seen.has(serializedId))
        throw new Error(`Duplicate project Artifact index identity: ${table}`)
      seen.add(serializedId)

      // Ownership follows the restored parent chain. Earlier parents have already been checked
      // against their live identities in this transaction.
      let scope: RestoredScope | undefined
      const parent = scopeParents[table]
      if (parent) {
        const parentId = row[parent[1]]
        if (typeof parentId === 'string') scope = scopesByTable.get(parent[0])?.get(parentId)
        if (
          !scope ||
          (table === 'ReviewScopeSnapshot' &&
            (scope.projectId !== row.projectId || scope.sessionId !== row.sessionId))
        )
          throw new Error(`Conflicting project Artifact index parent: ${table}.${parent[1]}`)
      } else if (table !== 'ContentBlob' && table !== 'PdfDocument') {
        if (typeof row.projectId !== 'string' || typeof row.sessionId !== 'string')
          throw new Error(`Invalid project Artifact index scope: ${table}`)
        scope = { projectId: row.projectId, sessionId: row.sessionId }
      }
      if (projectOnlyIndexTables.has(table) && scope?.projectId !== projectId)
        throw new Error(`Conflicting project Artifact index scope: ${table}`)
      if (scope) rowScopes.set(id, scope)
      if (table === 'ReviewFindingDisposition' && row.causeReviewId != null) {
        const cause =
          typeof row.causeReviewId === 'string'
            ? scopesByTable.get('Review')?.get(row.causeReviewId)
            : undefined
        if (!sameRestoredScope(cause, scope))
          throw new Error(
            'Conflicting project Artifact index parent: ReviewFindingDisposition.causeReviewId'
          )
      }
      if (table === 'ArtifactVersion' && scope && row.messageSnapshotId != null) {
        if (typeof row.messageSnapshotId !== 'string')
          throw new Error(
            'Invalid project Artifact index parent: ArtifactVersion.messageSnapshotId'
          )
        referencedSnapshots.push({ id: row.messageSnapshotId, scope })
      }

      const owned =
        table === 'ContentBlob'
          ? typeof row.storageKey === 'string' &&
            row.storageKey.startsWith(`artifacts/${projectId}/`)
          : scope?.projectId === projectId
      const isVersion = table === 'ArtifactVersion' || table === 'UploadVersion'
      const identityFields = restoreIdentities[table]
      const fields = owned
        ? [...identityFields, ...(isVersion ? ['state', ...versionContentFacts] : [])]
        : [...identityFields, ...(foreignSourceFacts[table] ?? [])]
      if (fields.length) {
        const [existing] = await tx.$queryRawUnsafe<Row[]>(
          `SELECT ${fields.map((key) => `"${key}"`).join(',')} FROM "${table}" WHERE ${primary.map((key) => `"${key}" = ?`).join(' AND ')}`,
          ...identity
        )
        if (existing) {
          assertSameIndexIdentity(table, owned ? identityFields : fields, existing, row)
          if (!owned) continue
          if (isVersion) {
            const states = publishedVersionStates[table]
            if (
              states.some((state) => state === existing.state) &&
              states.some((state) => state === (row.state ?? existing.state))
            )
              assertSameIndexIdentity(table, versionContentFacts, existing, row)
          }
        }
      }
      if (owned) keep.push(id)

      const updates = owned
        ? keys
            .filter((key) => !primary.includes(key))
            .map((key) => `"${key}"=excluded."${key}"`)
            .join(',')
        : ''
      await tx.$executeRawUnsafe(
        `INSERT INTO "${table}" (${keys.map((key) => `"${key}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')}) ON CONFLICT (${primary.map((key) => `"${key}"`).join(',')}) ${updates ? `DO UPDATE SET ${updates}` : 'DO NOTHING'}`,
        ...keys.map((key) => row[key])
      )
      if (isVersion) restoredVersions[table].push(id)
    }
  }

  // The application registry enforces this relationship during publication rather than with a
  // foreign key. Older Versions can omit the link, and a missing blob is reported by readers.
  for (const table of ['ArtifactVersion', 'UploadVersion'] as const) {
    const ids = restoredVersions[table]
    if (!ids.length) continue
    const states = publishedVersionStates[table]
    const [conflict] = await tx.$queryRawUnsafe<Row[]>(
      `SELECT v."id" FROM "${table}" v JOIN "ContentBlob" b ON v."contentBlobId" = b."id"
       WHERE v."id" IN (SELECT value FROM json_each(?))
         AND v."state" IN (${states.map(() => '?').join(',')})
         AND (v."contentStorageKey" <> b."storageKey"
           OR v."checksum" <> b."checksum" OR v."sizeBytes" <> b."sizeBytes")
       LIMIT 1`,
      JSON.stringify(ids),
      ...states
    )
    if (conflict)
      throw new Error(`Conflicting project Artifact index content binding: ${table}.contentBlobId`)
  }

  for (const { id, scope } of referencedSnapshots) {
    const snapshot = scopesByTable.get('ArtifactMessageSnapshot')?.get(id)
    if (!sameRestoredScope(snapshot, scope))
      throw new Error(
        'Conflicting project Artifact index parent: ArtifactVersion.messageSnapshotId'
      )
  }

  // A crash can leave a newer index transaction than the last acknowledged checkpoint. Remove
  // those extra project-owned projections so the disk record remains the authority on restart.
  for (const table of [
    'ArtifactVersionInput',
    'ArtifactLiteratureManifest',
    'ArtifactVersion',
    'ArtifactLineage',
    'ArtifactMessageSnapshot',
    'Finding',
    'ReviewFindingDisposition',
    'ReviewScopeSnapshot',
    'Review'
  ] as const) {
    const key = table === 'ArtifactLiteratureManifest' ? 'artifactVersionId' : 'id'
    const ids = ownedIds.get(table)!
    const keep = ids.length ? ` AND "${key}" NOT IN (${ids.map(() => '?').join(',')})` : ''
    const where = `(${scopes[table]})${keep}`
    // Both schema links allow a delete to change another row implicitly. Treat mismatched local
    // scopes as conflicts before a stale projection can clear or remove another Project's data.
    const foreignDependent = pruneScopeConflicts[table]
    if (foreignDependent) {
      const [conflict] = await tx.$queryRawUnsafe<Row[]>(
        `SELECT 1 FROM "${table}" WHERE ${where} AND EXISTS (${foreignDependent}) LIMIT 1`,
        projectId,
        ...ids
      )
      if (conflict) throw new Error(`Conflicting project Artifact index prune scope: ${table}`)
    }
    await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE ${where}`, projectId, ...ids)
  }
  if (!Number(priorDeferral.defer_foreign_keys)) {
    // Replay needs deferral for cyclic record relationships. Validate the replay before restoring
    // the caller's constraint mode, or a later mutation could publish an invalid checkpoint
    // before its deferred constraint failure is reported at COMMIT.
    const conflict = await tx.$queryRawUnsafe<Row[]>(
      'SELECT 1 FROM pragma_foreign_key_check LIMIT 1'
    )
    if (conflict.length) throw new Error('Project Artifact index has inconsistent references.')
    await tx.$executeRawUnsafe('PRAGMA defer_foreign_keys = OFF')
  }
}

type Operation = { model: string; method: string; args: unknown[] }
const operation = Symbol('project-record-operation')
const ownerSelects: Record<string, object> = {
  artifactLineage: { projectId: true },
  artifactMessageSnapshot: { projectId: true },
  fileOriginSession: { projectId: true },
  uploadFile: { projectId: true },
  review: { projectId: true },
  reviewScopeSnapshot: { projectId: true },
  managedFileVersionWriteOperation: { projectId: true },
  artifactVersion: { artifact: { select: { projectId: true } } },
  artifactVersionInput: {
    artifactVersion: { select: { artifact: { select: { projectId: true } } } }
  },
  artifactLiteratureManifest: {
    artifactVersion: { select: { artifact: { select: { projectId: true } } } }
  },
  uploadVersion: { uploadFile: { select: { projectId: true } } },
  finding: { review: { select: { projectId: true } } },
  reviewFindingDisposition: {
    sourceFinding: { select: { review: { select: { projectId: true } } } }
  },
  contentBlob: { storageKey: true }
}
const parentRelations: Record<string, { field: string; relation: string; model: string }> = {
  artifactVersion: { field: 'artifactId', relation: 'artifact', model: 'artifactLineage' },
  artifactVersionInput: {
    field: 'artifactVersionId',
    relation: 'artifactVersion',
    model: 'artifactVersion'
  },
  artifactLiteratureManifest: {
    field: 'artifactVersionId',
    relation: 'artifactVersion',
    model: 'artifactVersion'
  },
  uploadVersion: { field: 'uploadFileId', relation: 'uploadFile', model: 'uploadFile' },
  finding: { field: 'reviewId', relation: 'review', model: 'review' },
  reviewFindingDisposition: {
    field: 'sourceFindingId',
    relation: 'sourceFinding',
    model: 'finding'
  }
}

const record = (value: unknown): Row | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : undefined

const values = (value: unknown): unknown[] => (Array.isArray(value) ? value : [value])

const exactStrings = (value: unknown): string[] => {
  const filter = record(value)
  return values(filter?.in ?? filter?.equals ?? value).filter(
    (item): item is string => typeof item === 'string'
  )
}

const projectFromStorageKey = (storageKey: string): string | undefined =>
  /^artifacts\/([^/]+)\//.exec(storageKey)?.[1]

const collectOwners = (value: unknown, owners: Set<string>): void => {
  for (const item of values(value)) {
    const row = record(item)
    if (!row) continue
    if (typeof row.projectId === 'string') owners.add(row.projectId)
    if (typeof row.storageKey === 'string') {
      const id = projectFromStorageKey(row.storageKey)
      if (id) owners.add(id)
    }
    for (const child of Object.values(row)) {
      if (record(child)) collectOwners(child, owners)
    }
  }
}

const delegateFor = (
  client: Client,
  model: string
): Record<string, (...args: unknown[]) => Promise<unknown>> =>
  (client as unknown as Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>)[
    model
  ]

// Only follow ownership predicates. A sourceProjectId, source storage key, or relation elsewhere
// in an operation can express a provenance dependency without making that Project the owner.
const collectRequestedOwners = async (
  tx: Client,
  model: string,
  input: unknown,
  owners: Set<string>
): Promise<void> => {
  const row = record(input)
  if (!row) return
  const parent = parentRelations[model]
  if (parent) {
    const ids = exactStrings(row[parent.field])
    if (ids.length)
      collectOwners(
        await delegateFor(tx, parent.model).findMany({
          where: { id: { in: ids } },
          select: ownerSelects[parent.model]
        }),
        owners
      )
    const relation = record(row[parent.relation])
    await collectRequestedOwners(
      tx,
      parent.model,
      relation?.is ?? relation?.connect ?? relation,
      owners
    )
    // Parent IDs also appear in compound unique selectors on child models.
    for (const [key, value] of Object.entries(row)) {
      if (key.startsWith(`${parent.field}_`)) await collectRequestedOwners(tx, model, value, owners)
    }
  } else if (model === 'contentBlob') {
    for (const key of [
      ...exactStrings(row.storageKey),
      ...exactStrings(record(row.storageKey)?.startsWith)
    ]) {
      const id = projectFromStorageKey(key)
      if (id) owners.add(id)
    }
  } else {
    const ids = exactStrings(row.projectId)
    for (const id of ids) owners.add(id)
    for (const [key, value] of Object.entries(row)) {
      if (key.startsWith('projectId_')) await collectRequestedOwners(tx, model, value, owners)
    }
    const sessionIds = exactStrings(row.sessionId)
    if (!ids.length && sessionIds.length && model !== 'managedFileVersionWriteOperation') {
      collectOwners(
        await tx.session.findMany({
          where: { id: { in: sessionIds } },
          select: { projectId: true }
        }),
        owners
      )
    }
    if (
      model === 'artifactLineage' ||
      model === 'uploadFile' ||
      model === 'artifactMessageSnapshot'
    ) {
      const origin = record(row.originSession)
      await collectRequestedOwners(
        tx,
        'fileOriginSession',
        origin?.is ?? origin?.connect ?? origin,
        owners
      )
    }
  }
  for (const branch of [...values(row.AND), ...values(row.OR)]) {
    await collectRequestedOwners(tx, model, branch, owners)
  }
}

const activeRecordRoute = (
  storageRoot: string,
  id: string
): ReturnType<typeof getProjectRecordRoute> => {
  if (suppressed.has(checkpointKey(storageRoot, id))) return undefined
  const route = getProjectRecordRoute(storageRoot, id)
  return route?.detached ? undefined : route
}

async function activeRecordRoot(
  client: Client,
  storageRoot: string,
  id: string
): Promise<string | undefined> {
  const route = activeRecordRoute(storageRoot, id)
  if (!route) return undefined
  if (await client.projectDeletionIntent.findUnique({ where: { projectId: id } })) return undefined
  try {
    return getProjectRecordRoot(storageRoot, id)
  } catch (error) {
    throw new ApplicationCommandError(
      (error as NodeJS.ErrnoException).code === 'ENOENT' &&
        (error as NodeJS.ErrnoException).path === route.folder
        ? 'project-folder-not-found'
        : 'project-folder-unavailable',
      `Project Artifact records are unavailable: ${id}`,
      undefined,
      { cause: error }
    )
  }
}

export class ProjectArtifactIndexUnavailableError extends ApplicationCommandError {
  constructor(
    readonly projectId: string,
    cause: unknown
  ) {
    super(
      'project-folder-unavailable',
      `Project Artifact records are unavailable: ${projectId}`,
      undefined,
      {
        cause
      }
    )
    this.name = 'ProjectArtifactIndexUnavailableError'
  }
}

// The live Artifact turn uses this projection only to prepare publication recovery after
// checkpoint replay fails. Publication itself must still reconcile the portable authority.
export const readCommittedArtifactRunVersions = async (
  client: PrismaClient,
  scope: { projectId: string; appSessionId: string; artifactRunId: string }
): Promise<ArtifactVersion[] | undefined> => {
  return clients.get(client)?.artifactVersion.findMany({
    where: {
      originKind: 'agent_generated',
      artifactRunId: scope.artifactRunId,
      artifact: { is: { projectId: scope.projectId, sessionId: scope.appSessionId } }
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
  })
}

const readCheckpoint = async (root: string): Promise<string | undefined> => {
  try {
    return await readFile(assertProjectRecordPath(root, join(root, 'artifact-index.json')), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export const restoreLocatedProjectRecordIndexes = async (
  tx: Client,
  storageRoot: string,
  id: string,
  folder: string
): Promise<void> => {
  try {
    if (readProjectRecordManifest(folder)?.projectId !== id)
      throw new Error('Project record identity is missing or does not match.')
    const text = await readCheckpoint(join(folder, PROJECT_RECORD_DIRECTORY))
    if (text !== undefined)
      await restoreProjectRecordIndexesWithinTransaction(tx, storageRoot, id, text)
  } catch (cause) {
    throw new ProjectArtifactIndexUnavailableError(id, cause)
  }
}

const reconciliation = new WeakMap<object, (ids: Iterable<string>) => Promise<void>>()

// Raw SQL and folder admission supply scope explicitly, since SQL text is not an ownership API.
export const reconcileProjectRecordIndexes = (
  client: object,
  ids: Iterable<string>
): Promise<void> => reconciliation.get(client)?.(ids) ?? Promise.resolve()

export const withProjectRecordIndexes = (
  client: PrismaClient,
  storageRoot: string
): PrismaClient => {
  const synchronized = new Map<string, string>()
  const tracked = (op: Operation): boolean => Object.hasOwn(ownerSelects, op.model)
  const run = (context: Client, op: Operation): Promise<unknown> =>
    delegateFor(context, op.model)[op.method](...op.args)

  const runTransaction = async (
    callback: (
      tx: Client,
      ensure: (ids: Iterable<string>) => Promise<void>,
      assertReplayed: () => void
    ) => Promise<unknown>,
    options?: unknown
  ): Promise<unknown> => {
    // A signature is acknowledged only after SQLite commits. In particular, an index published
    // immediately before a failed commit must still be replayed on the next scoped operation.
    const acknowledged = new Map<string, string>()
    const result = await client.$transaction(
      async (tx) => {
        const checked = new Map<string, Promise<void>>()
        let queued = Promise.resolve()
        let failedRestore: Error | undefined
        const assertReplayed = (): void => {
          if (failedRestore) throw failedRestore
        }
        const ensure = async (ids: Iterable<string>): Promise<void> => {
          assertReplayed()
          for (const id of ids) {
            let pending = checked.get(id)
            if (!pending) {
              pending = queued.then(async () => {
                try {
                  const root = await activeRecordRoot(tx, storageRoot, id)
                  if (!root) return
                  const text = await readCheckpoint(root)
                  if (text === undefined) return
                  const signature = fingerprint(root, text)
                  if (synchronized.get(id) === signature) return
                  try {
                    await restoreProjectRecordIndexesWithinTransaction(tx, storageRoot, id, text)
                  } catch (error) {
                    // A caller may catch a delegate error. Once replay starts, a failed replay
                    // still requires rolling back the enclosing transaction.
                    failedRestore = new ProjectArtifactIndexUnavailableError(id, error)
                    throw failedRestore
                  }
                  acknowledged.set(id, signature)
                } catch (error) {
                  if (error instanceof ApplicationCommandError) throw error
                  throw new ProjectArtifactIndexUnavailableError(id, error)
                }
              })
              checked.set(id, pending)
              // Replay projects in order even when a callback issues operations concurrently.
              queued = pending.catch(() => undefined)
            }
            await pending
          }
        }
        const value = await callback(tx, ensure, assertReplayed)
        assertReplayed()
        return value
      },
      options as {
        maxWait?: number
        timeout?: number
        isolationLevel?: Prisma.TransactionIsolationLevel
      }
    )
    for (const [id, signature] of acknowledged) synchronized.set(id, signature)
    return result
  }

  const invoke = async (
    tx: Client,
    op: Operation,
    touched: Set<string>,
    ensure: (ids: Iterable<string>) => Promise<void>
  ): Promise<unknown> => {
    if (!tracked(op)) return run(tx, op)
    const args = record(op.args[0]) ?? {}
    const writing = mutations.has(op.method)
    const select = ownerSelects[op.model]
    const delegate = delegateFor(tx, op.model)
    const requested = new Set<string>()
    const dataOwners = new Set<string>()
    await collectRequestedOwners(tx, op.model, args.where, requested)
    for (const data of [...values(args.data), ...values(args.create), ...values(args.update)])
      await collectRequestedOwners(tx, op.model, data, dataOwners)
    const where = record(args.where)
    const hasFilter = where && Object.values(where).some((value) => value !== undefined)
    const selectsRows = !['create', 'createMany'].includes(op.method)
    if (
      selectsRows &&
      !hasFilter &&
      op.model !== 'contentBlob' &&
      op.model !== 'managedFileVersionWriteOperation'
    ) {
      // An unfiltered research-catalog operation genuinely ranges over every active record.
      for (const id of listProjectRecordIds(storageRoot)) requested.add(id)
    }
    await ensure([...requested, ...dataOwners])

    const matchOwners = async (): Promise<Set<string>> => {
      const matched = new Set<string>()
      const method = ['update', 'delete', 'upsert', 'findUnique', 'findUniqueOrThrow'].includes(
        op.method
      )
        ? 'findUnique'
        : 'findMany'
      collectOwners(await delegate[method]({ where: args.where, select }), matched)
      return matched
    }
    if (selectsRows && (writing || (hasFilter && (!requested.size || where.OR)))) {
      const matched = await matchOwners()
      await ensure(matched)
      // Recovery can replace the rows matched by the original selector.
      if (writing) for (const id of await matchOwners()) touched.add(id)
    }

    const result = await run(tx, op)
    if (writing) {
      for (const id of dataOwners) touched.add(id)
      const ids = values(result).flatMap((value) => exactStrings(record(value)?.id))
      if (ids.length && op.method !== 'delete')
        collectOwners(await delegate.findMany({ where: { id: { in: ids } }, select }), touched)
      if (op.method === 'update' || op.method === 'updateMany' || op.method === 'upsert') {
        for (const id of await matchOwners()) touched.add(id)
      }
      await ensure(touched)
    }
    return result
  }

  const transaction = async (input: unknown, options?: unknown): Promise<unknown> => {
    let published = new Map<string, string>()
    const result = await runTransaction(async (tx, ensure, assertReplayed) => {
      const touched = new Set<string>()
      let value: unknown
      if (Array.isArray(input)) {
        const results: unknown[] = []
        for (const item of input) {
          const op = item[operation] as Operation | undefined
          if (!op)
            throw new Error('Project record transactions require operations from the same client.')
          results.push(await invoke(tx, op, touched, ensure))
        }
        value = results
      } else {
        const scoped = new Proxy(tx, {
          get(target, name) {
            const delegate = Reflect.get(target, name)
            if (typeof name !== 'string' || !delegate || typeof delegate !== 'object')
              return typeof delegate === 'function' ? delegate.bind(target) : delegate
            return new Proxy(delegate, {
              get(model, method) {
                const fn = Reflect.get(model, method)
                return typeof fn === 'function'
                  ? (...args: unknown[]) =>
                      invoke(tx, { model: name, method: String(method), args }, touched, ensure)
                  : fn
              }
            })
          }
        })
        reconciliation.set(scoped, ensure)
        value = await (input as (tx: Client) => Promise<unknown>)(scoped)
      }
      assertReplayed()
      const checkpointProjects = [...touched].filter((id) => activeRecordRoute(storageRoot, id))
      // A single SQLite commit cannot atomically publish two independent portable authorities.
      if (checkpointProjects.length > 1)
        throw new Error('A research record transaction must belong to one Project.')
      published = await snapshot(tx, storageRoot, new Set(checkpointProjects))
      return value
    }, options)
    for (const [id, signature] of published) synchronized.set(id, signature)
    return result
  }

  const wrapped = new Proxy(client, {
    get(target, name) {
      if (name === '$transaction') return transaction
      const delegate = Reflect.get(target, name)
      if (
        typeof name !== 'string' ||
        name.startsWith('$') ||
        !delegate ||
        typeof delegate !== 'object'
      )
        return typeof delegate === 'function' ? delegate.bind(target) : delegate
      return new Proxy(delegate, {
        get(model, method) {
          const fn = Reflect.get(model, method)
          if (typeof fn !== 'function') return fn
          return (...args: unknown[]) => {
            const op: Operation = { model: name, method: String(method), args }
            let promise: Promise<unknown> | undefined
            const execute = (): Promise<unknown> =>
              (promise ??= !tracked(op)
                ? run(target, op)
                : mutations.has(op.method)
                  ? transaction([lazy]).then((items) => (items as unknown[])[0])
                  : runTransaction((tx, ensure) => invoke(tx, op, new Set(), ensure)))
            const lazy = {
              [operation]: op,
              [Symbol.toStringTag]: 'PrismaPromise',
              then: (...a: Parameters<Promise<unknown>['then']>) => execute().then(...a),
              catch: (...a: Parameters<Promise<unknown>['catch']>) => execute().catch(...a),
              finally: (...a: Parameters<Promise<unknown>['finally']>) => execute().finally(...a)
            }
            return lazy
          }
        }
      })
    }
  }) as PrismaClient
  clients.set(wrapped, client)
  reconciliation.set(wrapped, (ids) =>
    runTransaction((_tx, ensure) => ensure(ids)).then(() => undefined)
  )
  return wrapped
}
