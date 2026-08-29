import { join } from 'node:path'

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
  isIndexComplete: boolean | bigint
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

const getMatchingOverviewCounts = async (
  client: ProjectFilesClient,
  projectId: string,
  search: NormalizedSearch
): Promise<[number, number, number, number, boolean]> => {
  const rows = await client.$queryRaw<SearchOverviewRow[]>(Prisma.sql`
    SELECT
      COUNT(file."seq") AS "totalCount",
      COALESCE(SUM(CASE WHEN file."source" = 'upload' THEN 1 ELSE 0 END), 0) AS "uploadCount",
      COALESCE(SUM(CASE WHEN file."source" = 'artifact' THEN 1 ELSE 0 END), 0) AS "artifactCount",
      COUNT(DISTINCT CASE
        WHEN file."source" = 'artifact' AND sync."sessionId" IS NOT NULL THEN file."sessionId"
      END) AS "artifactGroupCount",
      CASE WHEN
        EXISTS (
          SELECT 1 FROM "ManagedFileIndexState"
          WHERE "id" = 'project-files-index'
            AND "isReconciliationComplete" = true
        )
        AND NOT EXISTS (
          SELECT 1 FROM "ManagedFileSessionSync" AS incomplete
          WHERE incomplete."projectId" = ${projectId}
            AND incomplete."filesRevision" < 0
            AND incomplete."deletedAt" IS NULL
        )
      THEN true ELSE false END AS "isIndexComplete"
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
    toSafeCount(counts?.artifactGroupCount ?? 0n, 'artifact group count'),
    counts?.isIndexComplete === true || counts?.isIndexComplete === 1n
  ]
}

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

const listMatchingFiles = async (
  client: ProjectFilesClient,
  projectId: string,
  source: ProjectFileSource | undefined,
  sessionId: string | undefined,
  search: NormalizedSearch,
  cursor: FileCursor | undefined,
  limit: number
): Promise<[ManagedFile[], number]> => {
  const sourcePredicate = source === undefined ? Prisma.empty : Prisma.sql`AND "source" = ${source}`
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

export {
  countMatchingArtifacts,
  decodeFileCursor,
  decodeGroupCursor,
  decodeSearchArtifactCursor,
  encodeCursor,
  getMatchingOverviewCounts,
  listMatchingArtifactGroups,
  listMatchingArtifacts,
  listMatchingFiles,
  listOtherProjectArtifacts,
  normalizeLimit,
  normalizeSearch,
  requireIdentifier,
  toOriginProjection,
  toProjectFileItem,
  toSafeCount
}
