import { Prisma, type FileOriginSession, type ManagedFile } from '@prisma/client'

import { createArtifactVersionLocator } from '../../shared/artifact-provenance'
import type {
  ListArtifactGroupsRequest,
  ListProjectFilesRequest,
  ProjectFileItem,
  ProjectFileOriginSession,
  ProjectFileSource
} from '../../shared/project-files'
import { createUploadVersionReference } from '../../shared/uploads'
import type { ProjectFilesClient } from './mutation-projection'

const MAX_PAGE_LIMIT = 100

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

type CatalogCursor = { sortAtMs: string; seq: number }

type AuthoritativeCatalogQuery = {
  projectIds: string[]
  source?: ProjectFileSource
  sourceFileId?: string
  sessionId?: string
  search?: NormalizedSearch
  cursor?: CatalogCursor
  limit?: number
}

type AuthoritativeOverviewCounts = {
  totalCount: bigint
  uploadCount: bigint
  artifactCount: bigint
  artifactGroupCount: bigint
}

type AuthoritativeArtifactGroupRow = {
  sessionId: string
  groupSortAtMs: bigint
  artifactCount: bigint
}

const normalizeLimit = (limit: number): number => {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new Error(`Project files page limit must be between 1 and ${MAX_PAGE_LIMIT}.`)
  }
  return limit
}

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

const foldAsciiCase = (value: string): string =>
  value.replace(/[A-Z]/g, (character) => character.toLowerCase())

const requireIdentifier = (value: string, field: string): void => {
  if (!value.trim()) throw new Error(`Project files ${field} is required.`)
}

// Native lineage/currentVersion rows are the catalog authority. ManagedFile remains a rebuildable
// compatibility projection, so legacy rows participate only when no native logical identity exists.
const authoritativeCatalogCte = (projectIds: string[]): Prisma.Sql => {
  const projectScopeRows = Prisma.join(projectIds.map((projectId) => Prisma.sql`(${projectId})`))
  return Prisma.sql`
  WITH "CatalogProjectScope"("projectId") AS (
    VALUES ${projectScopeRows}
  ),
  "BlockedCatalogProject" AS (
    SELECT intent."projectId" AS "projectId"
    FROM "ProjectDeletionIntent" AS intent
    WHERE intent."projectId" IN (SELECT scope."projectId" FROM "CatalogProjectScope" AS scope)

    UNION

    SELECT project."id" AS "projectId"
    FROM "Project" AS project
    WHERE project."id" IN (SELECT scope."projectId" FROM "CatalogProjectScope" AS scope)
      AND project."archivedAt" IS NOT NULL
  ),
  "BlockedCatalogSession" AS (
    SELECT sync."projectId" AS "projectId", sync."sessionId" AS "sessionId"
    FROM "ManagedFileSessionSync" AS sync
    WHERE sync."projectId" IN (SELECT scope."projectId" FROM "CatalogProjectScope" AS scope)
      AND (sync."deletedAt" IS NOT NULL OR sync."deleteOperationId" IS NOT NULL)

    UNION

    SELECT origin."projectId" AS "projectId", origin."sessionId" AS "sessionId"
    FROM "FileOriginSession" AS origin
    WHERE origin."projectId" IN (SELECT scope."projectId" FROM "CatalogProjectScope" AS scope)
      AND (
        origin."state" = 'deleting'
        OR origin."deletionOperationId" IS NOT NULL
      )
  ),
  "BlockedCatalogFile" AS (
    SELECT file."projectId" AS "projectId", file."source" AS "source",
      file."sourceFileId" AS "sourceFileId"
    FROM "ManagedFile" AS file
    WHERE file."projectId" IN (SELECT scope."projectId" FROM "CatalogProjectScope" AS scope)
      AND (file."deletedAt" IS NOT NULL OR file."deleteOperationId" IS NOT NULL)
  ),
  "AuthoritativeFile" AS (
    SELECT
      CAST(lineage.rowid * 2 AS INTEGER) AS "seq",
      'artifact' AS "source",
      lineage."id" AS "sourceFileId",
      version."id" AS "sourceVersionId",
      version."checksum" AS "checksum",
      lineage."projectId" AS "projectId",
      lineage."sessionId" AS "sessionId",
      version."messageId" AS "messageId",
      lineage."filename" AS "displayName",
      version."contentStorageKey" AS "storageKey",
      version."contentType" AS "mimeType",
      version."sizeBytes" AS "sizeBytes",
      CAST(version."createdAt" AS INTEGER) AS "mtimeMs",
      CAST(version."createdAt" AS INTEGER) AS "sortAtMs",
      lineage."createdAt" AS "createdAt",
      lineage."updatedAt" AS "updatedAt",
      NULL AS "deletedAt",
      NULL AS "deleteOperationId"
    FROM "ArtifactLineage" AS lineage
    INNER JOIN "ArtifactVersion" AS version
      ON version."artifactId" = lineage."id"
      AND version."id" = lineage."currentVersionId"
    WHERE lineage."projectId" IN (SELECT scope."projectId" FROM "CatalogProjectScope" AS scope)
      AND version."state" IN ('pending', 'finalized')
      AND (
        version."originKind" <> 'legacy'
        OR NOT EXISTS (
          SELECT 1 FROM "ManagedFile" AS projected
          WHERE projected."projectId" = lineage."projectId"
            AND projected."source" = 'artifact'
            AND projected."sourceFileId" = lineage."id"
        )
      )
      AND (version."originKind" <> 'agent_generated' OR version."managedVisibleAt" IS NOT NULL)
      AND NOT EXISTS (
        SELECT 1 FROM "BlockedCatalogProject" AS blocked
        WHERE blocked."projectId" = lineage."projectId"
      )
      AND NOT EXISTS (
        SELECT 1 FROM "BlockedCatalogSession" AS blocked
        WHERE blocked."projectId" = lineage."projectId"
          AND blocked."sessionId" = lineage."sessionId"
      )
      AND NOT EXISTS (
        SELECT 1 FROM "BlockedCatalogFile" AS blocked
        WHERE blocked."projectId" = lineage."projectId"
          AND blocked."source" = 'artifact'
          AND blocked."sourceFileId" = lineage."id"
      )

    UNION ALL

    SELECT
      CAST(upload.rowid * 2 + 1 AS INTEGER) AS "seq",
      'upload' AS "source",
      upload."id" AS "sourceFileId",
      version."id" AS "sourceVersionId",
      version."checksum" AS "checksum",
      upload."projectId" AS "projectId",
      upload."sessionId" AS "sessionId",
      NULL AS "messageId",
      COALESCE(NULLIF(version."originalFilename", ''), version."filename") AS "displayName",
      version."contentStorageKey" AS "storageKey",
      version."contentType" AS "mimeType",
      version."sizeBytes" AS "sizeBytes",
      CAST(COALESCE(version."createdAt", version."registeredAt") AS INTEGER) AS "mtimeMs",
      CAST(COALESCE(version."createdAt", version."registeredAt") AS INTEGER) AS "sortAtMs",
      upload."createdAt" AS "createdAt",
      upload."updatedAt" AS "updatedAt",
      NULL AS "deletedAt",
      NULL AS "deleteOperationId"
    FROM "UploadFile" AS upload
    INNER JOIN "UploadVersion" AS version
      ON version."uploadFileId" = upload."id"
      AND version."id" = upload."currentVersionId"
    WHERE upload."projectId" IN (SELECT scope."projectId" FROM "CatalogProjectScope" AS scope)
      AND version."state" = 'ready'
      AND NOT EXISTS (
        SELECT 1 FROM "BlockedCatalogProject" AS blocked
        WHERE blocked."projectId" = upload."projectId"
      )
      AND NOT EXISTS (
        SELECT 1 FROM "BlockedCatalogSession" AS blocked
        WHERE blocked."projectId" = upload."projectId"
          AND blocked."sessionId" = upload."sessionId"
      )
      AND NOT EXISTS (
        SELECT 1 FROM "BlockedCatalogFile" AS blocked
        WHERE blocked."projectId" = upload."projectId"
          AND blocked."source" = 'upload'
          AND blocked."sourceFileId" = upload."id"
      )

    UNION ALL

    SELECT
      -file."seq" AS "seq",
      file."source", file."sourceFileId", file."sourceVersionId", file."checksum",
      file."projectId", file."sessionId", file."messageId", file."displayName",
      file."storageKey", file."mimeType", file."sizeBytes", file."mtimeMs", file."sortAtMs",
      file."createdAt", file."updatedAt", file."deletedAt", file."deleteOperationId"
    FROM "ManagedFile" AS file
    WHERE file."projectId" IN (SELECT scope."projectId" FROM "CatalogProjectScope" AS scope)
      AND file."sourceVersionId" IS NOT NULL
      AND file."deletedAt" IS NULL
      AND file."deleteOperationId" IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM "BlockedCatalogProject" AS blocked
        WHERE blocked."projectId" = file."projectId"
      )
      AND NOT EXISTS (
        SELECT 1 FROM "BlockedCatalogSession" AS blocked
        WHERE blocked."projectId" = file."projectId"
          AND blocked."sessionId" = file."sessionId"
      )
      AND (
        (file."source" = 'artifact' AND NOT EXISTS (
          SELECT 1 FROM "ArtifactLineage" AS lineage
          INNER JOIN "ArtifactVersion" AS version
            ON version."artifactId" = lineage."id"
            AND version."id" = lineage."currentVersionId"
          WHERE lineage."projectId" = file."projectId"
            AND lineage."id" = file."sourceFileId"
            AND lineage."currentVersionId" IS NOT NULL
            AND version."originKind" <> 'legacy'
        ))
        OR
        (file."source" = 'upload' AND NOT EXISTS (
          SELECT 1 FROM "UploadFile" AS upload
          WHERE upload."projectId" = file."projectId"
            AND upload."id" = file."sourceFileId"
            AND upload."currentVersionId" IS NOT NULL
        ))
      )
  )
`
}

const authoritativeCatalogPredicates = (
  query: Omit<AuthoritativeCatalogQuery, 'projectIds' | 'limit'>
): Prisma.Sql => {
  const sourcePredicate = query.source
    ? Prisma.sql`AND file."source" = ${query.source}`
    : Prisma.empty
  const sourceFilePredicate = query.sourceFileId
    ? Prisma.sql`AND file."sourceFileId" = ${query.sourceFileId}`
    : Prisma.empty
  const sessionPredicate = query.sessionId
    ? Prisma.sql`AND file."sessionId" = ${query.sessionId}`
    : Prisma.empty
  const filenamePredicate = query.search?.filenameContains
    ? Prisma.sql`AND instr(lower(file."displayName"), lower(${query.search.filenameContains})) > 0`
    : Prisma.empty
  const excludedSessionsPredicate = query.search?.excludedSessionIds.length
    ? Prisma.sql`AND file."sessionId" NOT IN (${Prisma.join(query.search.excludedSessionIds)})`
    : Prisma.empty
  const cursorPredicate = query.cursor
    ? Prisma.sql`AND (
        file."sortAtMs" < ${BigInt(query.cursor.sortAtMs)}
        OR (file."sortAtMs" = ${BigInt(query.cursor.sortAtMs)} AND file."seq" < ${query.cursor.seq})
      )`
    : Prisma.empty
  return Prisma.sql`
    ${sourcePredicate}
    ${sourceFilePredicate}
    ${sessionPredicate}
    ${filenamePredicate}
    ${excludedSessionsPredicate}
    ${cursorPredicate}
  `
}

const normalizeCatalogRows = (rows: Array<ManagedFile & { seq: number | bigint }>): ManagedFile[] =>
  rows.map((row) => ({
    ...row,
    seq: typeof row.seq === 'bigint' ? toSafeNumber(row.seq, 'catalog sequence') : row.seq
  }))

const queryAuthoritativeFiles = async (
  client: ProjectFilesClient,
  query: AuthoritativeCatalogQuery
): Promise<ManagedFile[]> => {
  if (query.projectIds.length === 0) return []
  const predicates = authoritativeCatalogPredicates(query)
  const limit = query.limit === undefined ? Prisma.empty : Prisma.sql`LIMIT ${query.limit}`
  const rows = await client.$queryRaw<Array<ManagedFile & { seq: number | bigint }>>(Prisma.sql`
    ${authoritativeCatalogCte(query.projectIds)}
    SELECT file.*
    FROM "AuthoritativeFile" AS file
    WHERE 1 = 1
      ${predicates}
    ORDER BY file."sortAtMs" DESC, file."seq" DESC
    ${limit}
  `)
  return normalizeCatalogRows(rows)
}

const countAuthoritativeFiles = async (
  client: ProjectFilesClient,
  query: Omit<AuthoritativeCatalogQuery, 'cursor' | 'limit'>
): Promise<number> => {
  if (query.projectIds.length === 0) return 0
  const predicates = authoritativeCatalogPredicates(query)
  const rows = await client.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
    ${authoritativeCatalogCte(query.projectIds)}
    SELECT COUNT(*) AS "count"
    FROM "AuthoritativeFile" AS file
    WHERE 1 = 1
      ${predicates}
  `)
  return toSafeCount(rows[0]?.count ?? 0n, 'catalog count')
}

const getAuthoritativeOverviewCounts = async (
  client: ProjectFilesClient,
  projectId: string,
  search: NormalizedSearch | undefined
): Promise<[number, number, number, number]> => {
  const predicates = authoritativeCatalogPredicates({ search })
  const rows = await client.$queryRaw<AuthoritativeOverviewCounts[]>(Prisma.sql`
    ${authoritativeCatalogCte([projectId])}
    SELECT
      COUNT(*) AS "totalCount",
      COALESCE(SUM(CASE WHEN file."source" = 'upload' THEN 1 ELSE 0 END), 0) AS "uploadCount",
      COALESCE(SUM(CASE WHEN file."source" = 'artifact' THEN 1 ELSE 0 END), 0) AS "artifactCount",
      COUNT(DISTINCT CASE WHEN file."source" = 'artifact' THEN file."sessionId" END)
        AS "artifactGroupCount"
    FROM "AuthoritativeFile" AS file
    WHERE 1 = 1
      ${predicates}
  `)
  const counts = rows[0]
  return [
    toSafeCount(counts?.totalCount ?? 0n, 'catalog total count'),
    toSafeCount(counts?.uploadCount ?? 0n, 'catalog upload count'),
    toSafeCount(counts?.artifactCount ?? 0n, 'catalog artifact count'),
    toSafeCount(counts?.artifactGroupCount ?? 0n, 'catalog artifact group count')
  ]
}

const listAuthoritativeFiles = async (
  client: ProjectFilesClient,
  query: AuthoritativeCatalogQuery & { limit: number }
): Promise<[ManagedFile[], number]> =>
  Promise.all([
    queryAuthoritativeFiles(client, query),
    countAuthoritativeFiles(client, {
      projectIds: query.projectIds,
      source: query.source,
      sessionId: query.sessionId,
      search: query.search
    })
  ])

const listAuthoritativeArtifactGroups = async (
  client: ProjectFilesClient,
  input: {
    projectId: string
    search: NormalizedSearch | undefined
    cursor: GroupCursor | undefined
    limit: number
  }
): Promise<[AuthoritativeArtifactGroupRow[], number]> => {
  const predicates = authoritativeCatalogPredicates({ source: 'artifact', search: input.search })
  const cursorPredicate = input.cursor
    ? Prisma.sql`WHERE (
        groups."groupSortAtMs" < ${BigInt(input.cursor.groupSortAtMs)}
        OR (
          groups."groupSortAtMs" = ${BigInt(input.cursor.groupSortAtMs)}
          AND groups."sessionId" < ${input.cursor.sessionId}
        )
      )`
    : Prisma.empty
  const [rows, totalCount] = await Promise.all([
    client.$queryRaw<AuthoritativeArtifactGroupRow[]>(Prisma.sql`
      ${authoritativeCatalogCte([input.projectId])},
      "ArtifactGroup" AS (
        SELECT
          file."sessionId" AS "sessionId",
          MAX(file."sortAtMs") AS "groupSortAtMs",
          COUNT(*) AS "artifactCount"
        FROM "AuthoritativeFile" AS file
        WHERE 1 = 1
          ${predicates}
        GROUP BY file."sessionId"
      )
      SELECT groups.*
      FROM "ArtifactGroup" AS groups
      ${cursorPredicate}
      ORDER BY groups."groupSortAtMs" DESC, groups."sessionId" DESC
      LIMIT ${input.limit}
    `),
    (async () => {
      const countRows = await client.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
        ${authoritativeCatalogCte([input.projectId])}
        SELECT COUNT(DISTINCT file."sessionId") AS "count"
        FROM "AuthoritativeFile" AS file
        WHERE 1 = 1
          ${predicates}
      `)
      return toSafeCount(countRows[0]?.count ?? 0n, 'catalog artifact group count')
    })()
  ])
  return [rows, totalCount]
}

const listAuthoritativeManagedFiles = async (
  client: ProjectFilesClient,
  projectIds: string[]
): Promise<ManagedFile[]> => queryAuthoritativeFiles(client, { projectIds })

const encodeCursor = (cursor: FileCursor | GroupCursor | SearchArtifactCursor): string =>
  Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')

const parseCursor = (cursor: string): unknown => {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown
  } catch {
    throw new Error('Invalid project files cursor.')
  }
}

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

const toSafeCount = (value: bigint | number, field: string): number =>
  typeof value === 'number' ? value : toSafeNumber(value, field)

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

const toProjectFileItem = (row: ManagedFile, origin?: FileOriginSession): ProjectFileItem => {
  const versionId = row.sourceVersionId
  if (!versionId) throw new Error('Managed file projection has no current Version identity.')
  const source = row.source as ProjectFileSource
  return {
    id: source === 'upload' ? `upload:${row.sourceFileId}` : row.sourceFileId,
    source,
    sourceFileId: row.sourceFileId,
    sourceVersionId: versionId,
    checksum: row.checksum ?? undefined,
    projectId: row.projectId,
    sessionId: row.sessionId,
    messageId: row.messageId ?? undefined,
    name: row.displayName,
    path:
      source === 'upload'
        ? createUploadVersionReference(versionId, {
            projectId: row.projectId,
            sessionId: row.sessionId,
            fileId: row.sourceFileId
          })
        : createArtifactVersionLocator({
            projectId: row.projectId,
            appSessionId: row.sessionId,
            artifactId: row.sourceFileId,
            versionId
          }),
    mimeType: row.mimeType ?? undefined,
    size: toSafeNumber(row.sizeBytes, 'size'),
    mtimeMs: row.mtimeMs === null ? undefined : toSafeNumber(row.mtimeMs, 'mtime'),
    sortAtMs: toSafeNumber(row.sortAtMs, 'sort time'),
    ...toOriginProjection(origin)
  }
}

export {
  decodeFileCursor,
  decodeGroupCursor,
  decodeSearchArtifactCursor,
  encodeCursor,
  getAuthoritativeOverviewCounts,
  listAuthoritativeArtifactGroups,
  listAuthoritativeFiles,
  listAuthoritativeManagedFiles,
  normalizeLimit,
  normalizeSearch,
  requireIdentifier,
  queryAuthoritativeFiles,
  toOriginProjection,
  toProjectFileItem,
  toSafeCount
}
