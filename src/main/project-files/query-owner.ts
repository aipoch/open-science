import type { ManagedFile } from '@prisma/client'

import type {
  ArtifactGroupPage,
  GetProjectFilesOverviewRequest,
  HostArtifactCatalogItem,
  ListArtifactGroupsRequest,
  ListProjectFilesRequest,
  ProjectFileItem,
  ProjectFilesOverview,
  ProjectFilesPage,
  ResolveProjectFileRequest,
  SearchArtifactsRequest,
  SearchArtifactsResult
} from '../../shared/project-files'
import type { ProjectFilesClient, ProjectFilesClientProvider } from './mutation-projection'
import {
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
  queryAuthoritativeFiles,
  requireIdentifier,
  toOriginProjection,
  toProjectFileItem,
  toSafeCount
} from './query-support'
import { normalizeArtifactFilename } from '../artifacts/provenance-version-writer'

type ProjectFilesIndexCompletenessReader = (projectId: string) => boolean

const isExplicitVersionVisible = async (
  client: ProjectFilesClient,
  identity: {
    source: 'artifact' | 'upload'
    projectId: string
    sessionId: string
    sourceFileId: string
  }
): Promise<boolean> => {
  const [project, deletionIntent, origin, sync, projection] = await Promise.all([
    client.project.findUnique({
      where: { id: identity.projectId },
      select: { archivedAt: true }
    }),
    client.projectDeletionIntent.findUnique({
      where: { projectId: identity.projectId },
      select: { projectId: true }
    }),
    client.fileOriginSession.findUnique({
      where: {
        projectId_sessionId: {
          projectId: identity.projectId,
          sessionId: identity.sessionId
        }
      },
      select: { state: true, deletedAt: true, deletionOperationId: true }
    }),
    client.managedFileSessionSync.findUnique({
      where: {
        projectId_sessionId: {
          projectId: identity.projectId,
          sessionId: identity.sessionId
        }
      },
      select: { deletedAt: true, deleteOperationId: true }
    }),
    client.managedFile.findUnique({
      where: {
        projectId_source_sourceFileId: {
          projectId: identity.projectId,
          source: identity.source,
          sourceFileId: identity.sourceFileId
        }
      },
      select: { deletedAt: true, deleteOperationId: true }
    })
  ])

  return !(
    project?.archivedAt ||
    deletionIntent ||
    !origin ||
    origin.state === 'deleting' ||
    origin.deletionOperationId ||
    sync?.deletedAt ||
    sync?.deleteOperationId ||
    projection?.deletedAt ||
    projection?.deleteOperationId
  )
}

// Owns the read-model orchestration while completeness remains authoritative in the mutation owner.
class ProjectFilesQueryOwner {
  constructor(
    private readonly getClient: ProjectFilesClientProvider,
    private readonly readIndexComplete: ProjectFilesIndexCompletenessReader
  ) {}

  async getOverview(
    request: string | GetProjectFilesOverviewRequest
  ): Promise<ProjectFilesOverview> {
    const { projectId, search: rawSearch } =
      typeof request === 'string' ? { projectId: request, search: undefined } : request
    requireIdentifier(projectId, 'projectId')
    const search = normalizeSearch(rawSearch)
    const client = await this.getClient()
    const [totalCount, uploadCount, artifactCount, artifactGroupCount] =
      await getAuthoritativeOverviewCounts(client, projectId, search)

    return {
      totalCount,
      uploadCount,
      artifactCount,
      artifactGroupCount,
      isIndexComplete: this.readIndexComplete(projectId)
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
    const [rows, totalCount] = await listAuthoritativeFiles(client, {
      projectIds: [request.projectId],
      source,
      sessionId,
      search,
      cursor,
      limit: limit + 1
    })
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
      items: pageRows.map((row) => toProjectFileItem(row, originsBySession.get(row.sessionId))),
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

  async resolveFile(request: ResolveProjectFileRequest): Promise<ProjectFileItem | undefined> {
    requireIdentifier(request.projectId, 'projectId')
    requireIdentifier(request.sessionId, 'sessionId')
    if (request.source !== 'artifact' && request.source !== 'upload') {
      throw new Error('Project file source is invalid.')
    }
    if (!request.name.trim() || request.name.length > 1024) {
      throw new Error('Project file name is invalid.')
    }
    if (request.fileIdHint !== undefined) requireIdentifier(request.fileIdHint, 'fileIdHint')
    if (request.identityHint !== 'logical' && request.identityHint !== 'legacy') {
      throw new Error('Project file identity hint is invalid.')
    }

    const client = await this.getClient()
    const normalizedName = normalizeArtifactFilename(request.name)
    const queryArtifactByScopedName = async (): Promise<ManagedFile[]> => {
      const lineage = await client.artifactLineage.findUnique({
        where: {
          projectId_sessionId_normalizedFilename: {
            projectId: request.projectId,
            sessionId: request.sessionId,
            normalizedFilename: normalizedName
          }
        },
        select: { id: true }
      })
      return lineage
        ? await queryAuthoritativeFiles(client, {
            projectIds: [request.projectId],
            source: 'artifact',
            sourceFileId: lineage.id,
            sessionId: request.sessionId,
            limit: 1
          })
        : []
    }

    // Logical ids remain authoritative across mentions. A path-only Artifact id is only a weak
    // pre-adoption hint: resolve its Session-unique filename first so an identical id and filename
    // already owned by another Session cannot capture the restored tab.
    let rows =
      request.source === 'artifact' && request.identityHint === 'legacy'
        ? await queryArtifactByScopedName()
        : request.fileIdHint
          ? await queryAuthoritativeFiles(client, {
              projectIds: [request.projectId],
              source: request.source,
              sourceFileId: request.fileIdHint,
              limit: 1
            })
          : []
    if (
      rows.length === 0 &&
      request.source === 'artifact' &&
      request.identityHint === 'legacy' &&
      request.fileIdHint
    ) {
      rows = await queryAuthoritativeFiles(client, {
        projectIds: [request.projectId],
        source: 'artifact',
        sourceFileId: request.fileIdHint,
        sessionId: request.sessionId,
        limit: 1
      })
    }
    const row = rows[0]
    if (!row) return undefined
    const origin = await client.fileOriginSession.findUnique({
      where: {
        projectId_sessionId: { projectId: row.projectId, sessionId: row.sessionId }
      }
    })
    return toProjectFileItem(row, origin ?? undefined)
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
    const [primaryResult, otherRows] = await Promise.all([
      listAuthoritativeFiles(client, {
        projectIds: [request.primaryProjectId],
        source: 'artifact',
        search,
        cursor,
        limit: primaryLimit + 1
      }),
      request.otherLimit > 0
        ? queryAuthoritativeFiles(client, {
            projectIds: otherProjectIds,
            source: 'artifact',
            search,
            limit: request.otherLimit
          })
        : Promise.resolve([])
    ])
    const [primaryRows, primaryTotalCount] = primaryResult
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
    const toItem = (row: (typeof rows)[number]): ProjectFileItem =>
      toProjectFileItem(row, originsBySession.get(`${row.projectId}:${row.sessionId}`))

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
      isIndexComplete: [request.primaryProjectId, ...otherProjectIds].every((projectId) =>
        this.readIndexComplete(projectId)
      )
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
            state: 'finalized',
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
        const visible = await isExplicitVersionVisible(client, {
          source: 'artifact',
          sourceFileId: artifactVersion.artifactId,
          projectId: artifactVersion.artifact.projectId,
          sessionId: artifactVersion.artifact.sessionId
        })
        if (!visible) return []
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
      if (uploadVersion && uploadTime) {
        const visible = await isExplicitVersionVisible(client, {
          source: 'upload',
          sourceFileId: uploadVersion.uploadFileId,
          projectId: uploadVersion.uploadFile.projectId,
          sessionId: uploadVersion.uploadFile.sessionId
        })
        if (!visible) return []
      }
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

    const rows = await listAuthoritativeManagedFiles(client, [request.projectId])
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
    const limit = normalizeLimit(request.limit)
    const search = normalizeSearch(request.search)
    const cursor = request.cursor ? decodeGroupCursor(request.cursor, request) : undefined
    const [rows, totalCount] = await listAuthoritativeArtifactGroups(client, {
      projectId: request.projectId,
      search,
      cursor,
      limit: limit + 1
    })
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
        artifactCount: toSafeCount(row.artifactCount, 'catalog artifact group size'),
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
export type { ProjectFilesIndexCompletenessReader }
