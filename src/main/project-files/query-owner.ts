import { Prisma, type ManagedFile } from '@prisma/client'

import type {
  ArtifactGroupPage,
  GetProjectFilesOverviewRequest,
  HostArtifactCatalogItem,
  ListArtifactGroupsRequest,
  ListProjectFilesRequest,
  ProjectFileItem,
  ProjectFilesOverview,
  ProjectFilesPage,
  SearchArtifactsRequest,
  SearchArtifactsResult
} from '../../shared/project-files'
import type { ProjectFilesClient, ProjectFilesClientProvider } from './mutation-projection'
import { readProjectFilesIndexComplete } from './index-state'
import {
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
} from './query-support'

// Owns read-model orchestration, including completeness reads from the durable projection state.
class ProjectFilesQueryOwner {
  constructor(
    private readonly getClient: ProjectFilesClientProvider,
    private readonly dataRoot: string,
    private readonly beforeRead: (client: ProjectFilesClient) => Promise<void>
  ) {}

  async getOverview(
    request: string | GetProjectFilesOverviewRequest
  ): Promise<ProjectFilesOverview> {
    const { projectId, search: rawSearch } =
      typeof request === 'string' ? { projectId: request, search: undefined } : request
    requireIdentifier(projectId, 'projectId')
    const search = normalizeSearch(rawSearch)
    const client = await this.getClient()
    await this.beforeRead(client)
    const [totalCount, uploadCount, artifactCount, artifactGroupCount, isIndexComplete] = search
      ? await getMatchingOverviewCounts(client, projectId, search)
      : await Promise.all([
          client.managedFile.count({ where: { projectId, deletedAt: null } }),
          client.managedFile.count({ where: { projectId, source: 'upload', deletedAt: null } }),
          client.managedFile.count({ where: { projectId, source: 'artifact', deletedAt: null } }),
          client.managedFileSessionSync.count({
            where: { projectId, deletedAt: null, artifactCount: { gt: 0 } }
          }),
          readProjectFilesIndexComplete(client, [projectId])
        ])

    return {
      totalCount,
      uploadCount,
      artifactCount,
      artifactGroupCount,
      isIndexComplete
    }
  }

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
    await this.beforeRead(client)
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
      ? await listMatchingFiles(client, request.projectId, source, sessionId, search, cursor, limit)
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
    await this.beforeRead(client)
    const excludedSessionIds = search?.excludedSessionIds ?? []
    const [primaryRows, primaryTotalCount, otherRows, isIndexComplete] = await Promise.all([
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
        : Promise.resolve([]),
      readProjectFilesIndexComplete(client, [request.primaryProjectId, ...otherProjectIds])
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
      isIndexComplete
    }
  }

  async readHostArtifactCatalog(request: {
    projectId: string
    versionId?: string
    finalizedArtifactsOnly?: boolean
  }): Promise<HostArtifactCatalogItem[]> {
    requireIdentifier(request.projectId, 'projectId')
    const client = await this.getClient()
    if (request.versionId !== undefined) {
      requireIdentifier(request.versionId, 'versionId')
      const [artifactVersions, uploadVersions] = await Promise.all([
        client.artifactVersion.findMany({
          where: {
            id: request.versionId,
            state: request.finalizedArtifactsOnly ? 'finalized' : { in: ['pending', 'finalized'] },
            artifact: { is: { projectId: request.projectId } }
          },
          include: { artifact: true },
          take: 2
        }),
        client.uploadVersion.findMany({
          where: {
            id: request.versionId,
            state: 'ready',
            uploadFile: { is: { projectId: request.projectId } }
          },
          include: { uploadFile: true },
          take: 2
        })
      ])
      if (artifactVersions.length + uploadVersions.length > 1) {
        throw new Error('Artifact Version id is ambiguous across generated Artifacts and Uploads.')
      }
      const artifactVersion = artifactVersions[0]
      if (artifactVersion) {
        return [
          {
            source: 'artifact',
            sourceFileId: artifactVersion.artifactId,
            versionId: artifactVersion.id,
            versionNumber: artifactVersion.versionNumber,
            checksum: artifactVersion.checksum,
            projectId: artifactVersion.artifact.projectId,
            sessionId: artifactVersion.artifact.sessionId,
            filename: artifactVersion.filename,
            contentType: artifactVersion.contentType ?? undefined,
            sizeBytes: toSafeCount(artifactVersion.sizeBytes, 'host Artifact size'),
            sortAtMs: artifactVersion.createdAt.getTime(),
            createdAt: artifactVersion.createdAt.toISOString(),
            sourceCreatedAt: artifactVersion.createdAt.toISOString(),
            sourceFileCreatedAt: artifactVersion.artifact.createdAt.toISOString(),
            rootFrameId: artifactVersion.rootFrameId,
            agentFrameId: artifactVersion.agentFrameId
          }
        ]
      }
      const uploadVersion = uploadVersions[0]
      const uploadTime = uploadVersion?.createdAt ?? uploadVersion?.registeredAt
      return uploadVersion && uploadTime
        ? [
            {
              source: 'upload',
              sourceFileId: uploadVersion.uploadFileId,
              versionId: uploadVersion.id,
              versionNumber: uploadVersion.versionNumber,
              checksum: uploadVersion.checksum,
              projectId: uploadVersion.uploadFile.projectId,
              sessionId: uploadVersion.uploadFile.sessionId,
              filename: uploadVersion.originalFilename || uploadVersion.filename,
              contentType: uploadVersion.contentType ?? undefined,
              sizeBytes: toSafeCount(uploadVersion.sizeBytes, 'host Upload size'),
              sortAtMs: uploadTime.getTime(),
              createdAt: uploadTime.toISOString(),
              ...(uploadVersion.createdAt
                ? { sourceCreatedAt: uploadVersion.createdAt.toISOString() }
                : {}),
              sourceFileCreatedAt: uploadVersion.uploadFile.createdAt.toISOString(),
              rootFrameId: null,
              agentFrameId: null
            }
          ]
        : []
    }

    // ponytail: fuzzy search needs the whole current Project catalog; move filtering into SQLite
    // only if measured Project sizes make this bounded metadata scan material.
    const rows = await client.managedFile.findMany({
      where: {
        projectId: request.projectId,
        deletedAt: null,
        sourceVersionId: { not: null },
        source: { in: ['artifact', 'upload'] }
      },
      orderBy: [{ sortAtMs: 'desc' }, { seq: 'desc' }]
    })
    const artifactVersionIds = rows.flatMap((row) =>
      row.source === 'artifact' && row.sourceVersionId ? [row.sourceVersionId] : []
    )
    const uploadVersionIds = rows.flatMap((row) =>
      row.source === 'upload' && row.sourceVersionId ? [row.sourceVersionId] : []
    )
    const [artifactVersions, uploadVersions] = await Promise.all([
      artifactVersionIds.length === 0
        ? Promise.resolve([])
        : client.artifactVersion.findMany({
            where: {
              id: { in: artifactVersionIds },
              state: { in: ['pending', 'finalized'] },
              artifact: { is: { projectId: request.projectId } }
            },
            select: {
              id: true,
              rootFrameId: true,
              agentFrameId: true,
              createdAt: true,
              artifact: { select: { createdAt: true } }
            }
          }),
      uploadVersionIds.length === 0
        ? Promise.resolve([])
        : client.uploadVersion.findMany({
            where: {
              id: { in: uploadVersionIds },
              state: 'ready',
              uploadFile: { is: { projectId: request.projectId } }
            },
            select: {
              id: true,
              createdAt: true,
              registeredAt: true,
              uploadFile: { select: { createdAt: true } }
            }
          })
    ])
    const artifactMetadata = new Map(
      artifactVersions.map(
        (version) =>
          [
            version.id,
            {
              rootFrameId: version.rootFrameId,
              agentFrameId: version.agentFrameId,
              createdAt: version.createdAt.toISOString(),
              sourceCreatedAt: version.createdAt.toISOString(),
              sourceFileCreatedAt: version.artifact.createdAt.toISOString()
            }
          ] as const
      )
    )
    const uploadMetadata = new Map(
      uploadVersions.map(
        (version) =>
          [
            version.id,
            {
              createdAt: (version.createdAt ?? version.registeredAt).toISOString(),
              ...(version.createdAt ? { sourceCreatedAt: version.createdAt.toISOString() } : {}),
              sourceFileCreatedAt: version.uploadFile.createdAt.toISOString()
            }
          ] as const
      )
    )

    return rows.flatMap((row) => {
      if (!row.sourceVersionId) return []
      const artifact =
        row.source === 'artifact' ? artifactMetadata.get(row.sourceVersionId) : undefined
      const upload = row.source === 'upload' ? uploadMetadata.get(row.sourceVersionId) : undefined
      const metadata = artifact ?? upload
      if (!metadata) return []
      return [
        {
          source: row.source as 'artifact' | 'upload',
          sourceFileId: row.sourceFileId,
          versionId: row.sourceVersionId,
          checksum: row.checksum ?? undefined,
          projectId: row.projectId,
          sessionId: row.sessionId,
          filename: row.displayName,
          contentType: row.mimeType ?? undefined,
          sizeBytes: toSafeCount(row.sizeBytes, 'host managed file size'),
          sortAtMs: toSafeCount(row.sortAtMs, 'host managed file sort time'),
          createdAt: metadata.createdAt,
          ...(metadata.sourceCreatedAt ? { sourceCreatedAt: metadata.sourceCreatedAt } : {}),
          sourceFileCreatedAt: metadata.sourceFileCreatedAt,
          rootFrameId: artifact?.rootFrameId ?? null,
          agentFrameId: artifact?.agentFrameId ?? null
        }
      ]
    })
  }

  async listArtifactGroups(request: ListArtifactGroupsRequest): Promise<ArtifactGroupPage> {
    requireIdentifier(request.projectId, 'projectId')
    const client = await this.getClient()
    await this.beforeRead(client)
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
}

export { ProjectFilesQueryOwner }
