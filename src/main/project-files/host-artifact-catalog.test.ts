import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { Prisma, PrismaClient } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { ManagedFileVersionService } from '../managed-file-versions/service'
import { ImmutableInputAuthority } from '../immutable-input-authority'
import { HostArtifactsService } from '../notebook/host-artifacts-service'
import { UploadRepository } from '../uploads/repository'
import { ManagedFileIndexRepository } from './repository'

const checksum = (value: string): string => createHash('sha256').update(value).digest('hex')

describe('ManagedFileIndexRepository host Artifact catalog', () => {
  let root: string
  let client: PrismaClient
  let repository: ManagedFileIndexRepository

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'open-science-host-artifacts-'))
    client = createProjectDbClient(root)
    await migrateApplicationDatabase(client)
    repository = new ManagedFileIndexRepository(
      () => Promise.resolve(client),
      root,
      new ManagedFileVersionService({
        storageRoot: root,
        getClient: () => Promise.resolve(client)
      }),
      new UploadRepository(root, { getClient: () => Promise.resolve(client) })
    )
    await client.fileOriginSession.createMany({
      data: [
        { projectId: 'project-a', sessionId: 'session-a' },
        { projectId: 'project-a', sessionId: 'session-b' },
        { projectId: 'project-b', sessionId: 'session-c' }
      ]
    })
  })

  afterEach(async () => {
    await client.$disconnect()
    await rm(root, { recursive: true, force: true })
  })

  const createArtifactVersion = async (
    projectId: string,
    sessionId: string,
    artifactId: string,
    versionId: string,
    versionNumber = 1,
    options: {
      managedVisibleAt?: Date | null
      agentFrameId?: string
      rootFrameId?: string
      state?: 'pending' | 'finalized'
    } = {}
  ): Promise<void> => {
    const agentFrameId = options.agentFrameId ?? 'agent-frame'
    const rootFrameId = options.rootFrameId ?? `root-${versionId}`
    await client.artifactLineage.upsert({
      where: {
        projectId_sessionId_normalizedFilename: {
          projectId,
          sessionId,
          normalizedFilename: `${artifactId}.csv`
        }
      },
      create: {
        id: artifactId,
        projectId,
        sessionId,
        normalizedFilename: `${artifactId}.csv`,
        filename: `${artifactId}.csv`,
        createdAt: new Date('2026-07-01T00:00:00.000Z')
      },
      update: {}
    })
    const data: Prisma.ArtifactVersionUncheckedCreateInput = {
      id: versionId,
      artifactId,
      versionNumber,
      filename: `${artifactId}.csv`,
      artifactRunId: `run-${versionId}`,
      writeOperationId: `write-${versionId}`,
      writeRequestChecksum: 'a'.repeat(64),
      rootFrameId,
      agentFrameId,
      messageBranchId: 'branch',
      runtimeSegmentId: 'runtime',
      promptMessageId: 'prompt',
      state: options.state ?? 'finalized',
      managedVisibleAt:
        options.managedVisibleAt === undefined
          ? new Date(`2026-08-0${versionNumber}T00:00:01.000Z`)
          : options.managedVisibleAt,
      contentStorageKey: `artifacts/${projectId}/${sessionId}/${versionId}/content`,
      evidenceStorageKey: `artifacts/${projectId}/${sessionId}/${versionId}/evidence.json`,
      evidenceSchemaVersion: 1,
      contentType: 'text/csv',
      sizeBytes: 10n,
      checksum: checksum(versionId),
      evidenceJson: '{}',
      evidenceChecksum: 'b'.repeat(64),
      createdAt: new Date(`2026-08-0${versionNumber}T00:00:00.000Z`)
    }
    await client.artifactVersion.create({ data })
    await client.artifactLineage.update({
      where: { id: artifactId },
      data: { currentVersionId: versionId }
    })
  }

  const createUploadVersion = async (
    projectId: string,
    sessionId: string,
    uploadId: string,
    versionId: string,
    createdAt: Date | null = new Date('2026-08-03T00:00:00.000Z')
  ): Promise<void> => {
    await client.uploadFile.create({
      data: {
        id: uploadId,
        projectId,
        sessionId,
        filename: `${uploadId}.pdf`,
        originalFilename: `${uploadId}.pdf`,
        createdAt: new Date('2026-07-02T00:00:00.000Z'),
        versions: {
          create: {
            id: versionId,
            versionNumber: 1,
            state: 'ready',
            contentStorageKey: `uploads/${projectId}/${sessionId}/${versionId}`,
            filename: `${uploadId}.pdf`,
            originalFilename: `${uploadId}.pdf`,
            contentType: 'application/pdf',
            sizeBytes: 12n,
            checksum: checksum(versionId),
            createdAt,
            registeredAt: new Date('2026-08-04T00:00:00.000Z')
          }
        }
      }
    })
    await client.uploadFile.update({
      where: { id: uploadId },
      data: { currentVersionId: versionId }
    })
  }

  it.each(['artifact', 'upload'] as const)(
    'keeps the listed %s Version content when a newer Version is published before artifactPath',
    async (source) => {
      await client.project.create({ data: { id: 'project-a', name: 'Project A' } })
      const service = new HostArtifactsService(
        repository,
        new ImmutableInputAuthority({
          storageRoot: root,
          managedFileVersions: new ManagedFileVersionService({
            storageRoot: root,
            getClient: () => Promise.resolve(client)
          })
        })
      )
      const context = { projectId: 'project-a', sessionId: 'reading-session' }
      const publish = async (versionNumber: number): Promise<void> => {
        const versionId = `${source}-v${versionNumber}`
        const content = `value\nv${versionNumber}\n`
        const contentStorageKey = `${source}s/project-a/session-a/file/${versionId}/content`
        const path = join(root, ...contentStorageKey.split('/'))
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, content)
        const metadata = {
          contentStorageKey,
          checksum: checksum(content),
          sizeBytes: BigInt(Buffer.byteLength(content))
        }
        if (source === 'artifact') {
          await createArtifactVersion('project-a', 'session-a', 'file', versionId, versionNumber)
          await client.artifactVersion.update({ where: { id: versionId }, data: metadata })
        } else {
          if (versionNumber === 1) {
            await createUploadVersion('project-a', 'session-a', 'file', versionId)
          } else {
            const first = await client.uploadVersion.findUniqueOrThrow({
              where: { id: 'upload-v1' }
            })
            await client.uploadVersion.create({
              data: { ...first, ...metadata, id: versionId, versionNumber }
            })
          }
          await client.uploadVersion.update({ where: { id: versionId }, data: metadata })
          await client.uploadFile.update({
            where: { id: 'file' },
            data: { currentVersionId: versionId }
          })
        }
      }

      await publish(1)
      const listed = await service.list({}, context)
      const versionId = listed.artifacts[0]!.latestVersionId
      expect(versionId).toBe(`${source}-v1`)
      await publish(2)
      expect((await service.list({}, context)).artifacts[0]!.latestVersionId).toBe(`${source}-v2`)

      const path = await service.resolvePath(versionId, context)
      await expect(readFile(path, 'utf8')).resolves.toBe('value\nv1\n')
      expect(await service.resolvePath(versionId, context)).toBe(path)
      const latestPath = await service.resolvePath(`${source}-v2`, context)
      expect(latestPath).not.toBe(path)
      await expect(readFile(latestPath, 'utf8')).resolves.toBe('value\nv2\n')
    }
  )

  it('resolves default catalog entries from DB heads when ManagedFile projections are stale', async () => {
    await createArtifactVersion('project-a', 'session-a', 'artifact-a', 'artifact-v1', 1)
    await createArtifactVersion('project-a', 'session-a', 'artifact-a', 'artifact-v2', 2)
    await createUploadVersion('project-a', 'session-b', 'upload-a', 'upload-v1')
    await client.uploadVersion.create({
      data: {
        id: 'upload-v2',
        uploadFileId: 'upload-a',
        versionNumber: 2,
        state: 'ready',
        contentStorageKey: 'uploads/project-a/session-b/upload-v2',
        filename: 'upload-a-v2.pdf',
        originalFilename: 'upload-a-v2.pdf',
        contentType: 'application/pdf',
        sizeBytes: 22n,
        checksum: checksum('upload-v2'),
        createdAt: new Date('2026-08-04T00:00:00.000Z')
      }
    })
    await client.uploadFile.update({
      where: { id: 'upload-a' },
      data: { currentVersionId: 'upload-v2' }
    })
    await client.managedFile.createMany({
      data: [
        {
          source: 'artifact',
          sourceFileId: 'artifact-a',
          sourceVersionId: 'artifact-v1',
          checksum: checksum('artifact-v1'),
          projectId: 'project-a',
          sessionId: 'session-a',
          displayName: 'stale-artifact.csv',
          storageKey: 'artifact-a',
          mimeType: 'text/plain',
          sizeBytes: 1n,
          sortAtMs: 1n
        },
        {
          source: 'upload',
          sourceFileId: 'upload-a',
          sourceVersionId: 'upload-v1',
          checksum: checksum('upload-v1'),
          projectId: 'project-a',
          sessionId: 'session-b',
          displayName: 'stale-upload.pdf',
          storageKey: 'upload-a',
          mimeType: 'text/plain',
          sizeBytes: 1n,
          sortAtMs: 2n
        }
      ]
    })

    await expect(repository.readHostArtifactCatalog({ projectId: 'project-a' })).resolves.toEqual([
      expect.objectContaining({
        source: 'upload',
        versionId: 'upload-v2',
        filename: 'upload-a-v2.pdf',
        checksum: checksum('upload-v2'),
        sizeBytes: 22
      }),
      expect.objectContaining({
        source: 'artifact',
        versionId: 'artifact-v2',
        filename: 'artifact-a.csv',
        checksum: checksum('artifact-v2'),
        rootFrameId: 'root-artifact-v2'
      })
    ])
  })

  it('lists current DB heads when ManagedFile projections are missing', async () => {
    await createArtifactVersion('project-a', 'session-a', 'artifact-a', 'artifact-v1', 1)
    await createUploadVersion('project-a', 'session-b', 'upload-a', 'upload-v1')

    await expect(repository.readHostArtifactCatalog({ projectId: 'project-a' })).resolves.toEqual([
      expect.objectContaining({
        source: 'upload',
        sourceFileId: 'upload-a',
        versionId: 'upload-v1'
      }),
      expect.objectContaining({
        source: 'artifact',
        sourceFileId: 'artifact-a',
        versionId: 'artifact-v1'
      })
    ])
  })

  it('does not infer a head from finalized rows when currentVersionId is unset', async () => {
    await createArtifactVersion('project-a', 'session-a', 'artifact-a', 'artifact-v1', 1)
    await createUploadVersion('project-a', 'session-b', 'upload-a', 'upload-v1')
    await client.artifactLineage.update({
      where: { id: 'artifact-a' },
      data: { currentVersionId: null }
    })
    await client.uploadFile.update({
      where: { id: 'upload-a' },
      data: { currentVersionId: null }
    })
    await client.managedFile.createMany({
      data: [
        {
          source: 'artifact',
          sourceFileId: 'artifact-a',
          projectId: 'project-a',
          sessionId: 'session-a',
          displayName: 'artifact-a.csv',
          storageKey: 'artifacts/project-a/session-a/legacy-artifact-a.csv',
          sizeBytes: 10n,
          sortAtMs: 1n
        },
        {
          source: 'upload',
          sourceFileId: 'upload-a',
          projectId: 'project-a',
          sessionId: 'session-b',
          displayName: 'upload-a.csv',
          storageKey: 'uploads/project-a/session-b/legacy-upload-a.csv',
          sizeBytes: 10n,
          sortAtMs: 1n
        }
      ]
    })

    await expect(repository.readHostArtifactCatalog({ projectId: 'project-a' })).resolves.toEqual(
      []
    )
    await expect(
      repository.listFiles({ projectId: 'project-a', collection: { kind: 'all' }, limit: 10 })
    ).resolves.toMatchObject({ items: [], totalCount: 0 })
  })

  it('hides compatibility-failed generated heads without hiding legacy or user edits', async () => {
    await createArtifactVersion(
      'project-a',
      'session-a',
      'catalog-failed',
      'catalog-failed-v1',
      1,
      { managedVisibleAt: null }
    )
    await client.artifactLineage.create({
      data: {
        id: 'catalog-legacy',
        projectId: 'project-a',
        sessionId: 'session-a',
        normalizedFilename: 'catalog-legacy.csv',
        filename: 'catalog-legacy.csv'
      }
    })
    await client.artifactVersion.create({
      data: {
        id: 'catalog-legacy-v1',
        artifactId: 'catalog-legacy',
        versionNumber: 1,
        filename: 'catalog-legacy.csv',
        originKind: 'legacy',
        state: 'finalized',
        contentStorageKey: 'artifacts/project-a/session-a/catalog-legacy-v1/content',
        contentType: 'text/csv',
        sizeBytes: 11n,
        checksum: checksum('catalog-legacy-v1'),
        createdAt: new Date('2026-08-02T00:00:00.000Z')
      }
    })
    await client.artifactLineage.update({
      where: { id: 'catalog-legacy' },
      data: { currentVersionId: 'catalog-legacy-v1' }
    })

    await client.artifactLineage.create({
      data: {
        id: 'catalog-edit',
        projectId: 'project-a',
        sessionId: 'session-a',
        normalizedFilename: 'catalog-edit.csv',
        filename: 'catalog-edit.csv'
      }
    })
    await client.artifactVersion.create({
      data: {
        id: 'catalog-edit-v1',
        artifactId: 'catalog-edit',
        versionNumber: 1,
        filename: 'catalog-edit.csv',
        originKind: 'legacy',
        state: 'finalized',
        contentStorageKey: 'artifacts/project-a/session-a/catalog-edit-v1/content',
        contentType: 'text/csv',
        sizeBytes: 12n,
        checksum: checksum('catalog-edit-v1'),
        createdAt: new Date('2026-08-02T00:00:00.000Z')
      }
    })
    await client.artifactVersion.create({
      data: {
        id: 'catalog-edit-v2',
        artifactId: 'catalog-edit',
        versionNumber: 2,
        filename: 'catalog-edit.csv',
        originKind: 'user_edit',
        basedOnVersionId: 'catalog-edit-v1',
        storageTag: 'edit1234',
        storedFilename: '{edit1234}_catalog-edit.csv',
        state: 'finalized',
        contentStorageKey: 'artifacts/project-a/session-a/catalog-edit-v2/content',
        contentType: 'text/csv',
        sizeBytes: 13n,
        checksum: checksum('catalog-edit-v2'),
        createdAt: new Date('2026-08-03T00:00:00.000Z')
      }
    })
    await client.artifactLineage.update({
      where: { id: 'catalog-edit' },
      data: { currentVersionId: 'catalog-edit-v2' }
    })

    const files = await repository.listFiles({
      projectId: 'project-a',
      collection: { kind: 'sessionArtifacts', sessionId: 'session-a' },
      limit: 10
    })
    expect(files.items.map((item) => item.sourceFileId).sort()).toEqual([
      'catalog-edit',
      'catalog-legacy'
    ])

    const search = await repository.searchArtifacts({
      primaryProjectId: 'project-a',
      otherProjectIds: [],
      filenameContains: 'catalog-',
      primaryLimit: 10,
      otherLimit: 0
    })
    expect(search.primary.items.map((item) => item.sourceFileId).sort()).toEqual([
      'catalog-edit',
      'catalog-legacy'
    ])

    const hostCatalog = await repository.readHostArtifactCatalog({ projectId: 'project-a' })
    expect(hostCatalog.map((item) => item.sourceFileId).sort()).toEqual([
      'catalog-edit',
      'catalog-legacy'
    ])
  })

  it('does not resurrect native heads across authoritative deletion membership gates', async () => {
    await createArtifactVersion('project-a', 'session-a', 'artifact-a', 'artifact-v1')
    await createUploadVersion('project-a', 'session-b', 'upload-a', 'upload-v1')
    await client.managedFile.create({
      data: {
        source: 'artifact',
        sourceFileId: 'artifact-a',
        sourceVersionId: 'artifact-v1',
        checksum: checksum('artifact-v1'),
        projectId: 'project-a',
        sessionId: 'session-a',
        displayName: 'artifact-a.csv',
        storageKey: 'artifact-a',
        mimeType: 'text/csv',
        sizeBytes: 10n,
        sortAtMs: 1n,
        deletedAt: new Date('2026-08-05T00:00:00.000Z'),
        deleteOperationId: 'delete-artifact-a'
      }
    })
    await client.managedFileSessionSync.create({
      data: {
        projectId: 'project-a',
        sessionId: 'session-b',
        filesRevision: 1,
        groupSortAtMs: 1n,
        uploadCount: 1,
        deletedAt: new Date('2026-08-05T00:00:00.000Z'),
        deleteOperationId: 'delete-session-b'
      }
    })

    const expectCatalogIds = async (expected: string[]): Promise<void> => {
      const files = await repository.listFiles({
        projectId: 'project-a',
        collection: { kind: 'all' },
        limit: 10
      })
      expect(files.items.map((item) => item.sourceFileId).sort()).toEqual(expected)
      const search = await repository.searchArtifacts({
        primaryProjectId: 'project-a',
        otherProjectIds: [],
        filenameContains: 'artifact-a',
        primaryLimit: 10,
        otherLimit: 0
      })
      expect(search.primary.items.map((item) => item.sourceFileId).sort()).toEqual(
        expected.filter((id) => id.startsWith('artifact-'))
      )
      const hostCatalog = await repository.readHostArtifactCatalog({ projectId: 'project-a' })
      expect(hostCatalog.map((item) => item.sourceFileId).sort()).toEqual(expected)
    }

    await expectCatalogIds([])

    await client.managedFile.deleteMany({ where: { projectId: 'project-a' } })
    await client.managedFileSessionSync.deleteMany({ where: { projectId: 'project-a' } })
    await client.project.create({
      data: {
        id: 'project-a',
        name: 'Archived project',
        archivedAt: new Date('2026-08-05T00:00:00.000Z')
      }
    })
    await expectCatalogIds([])

    await client.project.update({ where: { id: 'project-a' }, data: { archivedAt: null } })
    await client.projectDeletionIntent.create({ data: { projectId: 'project-a' } })
    await expectCatalogIds([])

    await client.projectDeletionIntent.delete({ where: { projectId: 'project-a' } })
    await client.fileOriginSession.updateMany({
      where: { projectId: 'project-a' },
      data: {
        state: 'deleting',
        deletionOperationId: 'delete-origin',
        retainedReviewIdsJson: '[]'
      }
    })
    await expectCatalogIds([])

    await client.fileOriginSession.updateMany({
      where: { projectId: 'project-a' },
      data: {
        state: 'deleted',
        deletedAt: new Date('2026-08-05T00:00:00.000Z'),
        deletionOperationId: null,
        retainedReviewIdsJson: null
      }
    })
    await expectCatalogIds(['artifact-a', 'upload-a'])
  })

  it('applies publication gates and keeps a deleted origin readable by explicit Version lookup', async () => {
    await createArtifactVersion('project-a', 'session-a', 'artifact-a', 'artifact-v1')

    await client.artifactVersion.update({
      where: { id: 'artifact-v1' },
      data: { state: 'pending' }
    })
    await expect(
      repository.readHostArtifactCatalog({ projectId: 'project-a', versionId: 'artifact-v1' })
    ).resolves.toEqual([])

    await client.artifactVersion.update({
      where: { id: 'artifact-v1' },
      data: { state: 'finalized' }
    })
    await client.managedFile.create({
      data: {
        source: 'artifact',
        sourceFileId: 'artifact-a',
        sourceVersionId: 'artifact-v1',
        checksum: checksum('artifact-v1'),
        projectId: 'project-a',
        sessionId: 'session-a',
        displayName: 'artifact-a.csv',
        storageKey: 'artifact-a',
        mimeType: 'text/csv',
        sizeBytes: 10n,
        sortAtMs: 1n,
        deletedAt: new Date('2026-08-05T00:00:00.000Z'),
        deleteOperationId: 'delete-artifact-a'
      }
    })
    await expect(
      repository.readHostArtifactCatalog({ projectId: 'project-a', versionId: 'artifact-v1' })
    ).resolves.toEqual([])

    await client.managedFile.deleteMany({ where: { projectId: 'project-a' } })
    await client.fileOriginSession.update({
      where: { projectId_sessionId: { projectId: 'project-a', sessionId: 'session-a' } },
      data: {
        state: 'deleted',
        deletedAt: new Date('2026-08-05T00:00:00.000Z')
      }
    })
    await expect(
      repository.readHostArtifactCatalog({ projectId: 'project-a', versionId: 'artifact-v1' })
    ).resolves.toEqual([
      expect.objectContaining({
        source: 'artifact',
        sourceFileId: 'artifact-a',
        versionId: 'artifact-v1'
      })
    ])
  })

  it('projects latest generated Artifacts and Uploads from the current Project catalog', async () => {
    await createArtifactVersion('project-a', 'session-a', 'artifact-a', 'artifact-version-a')
    await createUploadVersion('project-a', 'session-b', 'upload-a', 'upload-version-a')
    await createArtifactVersion('project-b', 'session-c', 'artifact-b', 'artifact-version-b')
    await client.managedFile.createMany({
      data: [
        {
          source: 'artifact',
          sourceFileId: 'artifact-a',
          sourceVersionId: 'artifact-version-a',
          checksum: checksum('artifact-version-a'),
          projectId: 'project-a',
          sessionId: 'session-a',
          displayName: 'artifact-a.csv',
          storageKey: 'artifact-a',
          mimeType: 'text/csv',
          sizeBytes: 10n,
          sortAtMs: BigInt(Date.parse('2026-08-01T00:00:00.000Z'))
        },
        {
          source: 'upload',
          sourceFileId: 'upload-a',
          sourceVersionId: 'upload-version-a',
          checksum: checksum('upload-version-a'),
          projectId: 'project-a',
          sessionId: 'session-b',
          displayName: 'upload-a.pdf',
          storageKey: 'upload-a',
          mimeType: 'application/pdf',
          sizeBytes: 12n,
          sortAtMs: BigInt(Date.parse('2026-08-03T00:00:00.000Z'))
        },
        {
          source: 'artifact',
          sourceFileId: 'artifact-b',
          sourceVersionId: 'artifact-version-b',
          checksum: checksum('artifact-version-b'),
          projectId: 'project-b',
          sessionId: 'session-c',
          displayName: 'artifact-b.csv',
          storageKey: 'artifact-b',
          mimeType: 'text/csv',
          sizeBytes: 10n,
          sortAtMs: 4n
        }
      ]
    })

    await expect(repository.readHostArtifactCatalog({ projectId: 'project-a' })).resolves.toEqual([
      expect.objectContaining({
        source: 'upload',
        sourceFileId: 'upload-a',
        createdAt: '2026-08-03T00:00:00.000Z',
        sourceCreatedAt: '2026-08-03T00:00:00.000Z',
        sourceFileCreatedAt: '2026-07-02T00:00:00.000Z',
        rootFrameId: null,
        agentFrameId: null
      }),
      expect.objectContaining({
        source: 'artifact',
        sourceFileId: 'artifact-a',
        createdAt: '2026-08-01T00:00:00.000Z',
        sourceCreatedAt: '2026-08-01T00:00:00.000Z',
        sourceFileCreatedAt: '2026-07-01T00:00:00.000Z',
        rootFrameId: 'root-artifact-version-a',
        agentFrameId: 'agent-frame'
      })
    ])
  })

  it('resolves historical Version ids inside one Project and fails closed on source collisions', async () => {
    await createArtifactVersion('project-a', 'session-a', 'artifact-a', 'history-v1', 1)
    await createArtifactVersion('project-a', 'session-a', 'artifact-a', 'history-v2', 2)
    await createArtifactVersion('project-b', 'session-c', 'artifact-b', 'other-project-v1')

    await expect(
      repository.readHostArtifactCatalog({ projectId: 'project-a', versionId: 'history-v1' })
    ).resolves.toEqual([
      expect.objectContaining({
        sourceFileId: 'artifact-a',
        versionId: 'history-v1',
        versionNumber: 1,
        createdAt: '2026-08-01T00:00:00.000Z',
        sourceCreatedAt: '2026-08-01T00:00:00.000Z',
        sourceFileCreatedAt: '2026-07-01T00:00:00.000Z',
        rootFrameId: 'root-history-v1',
        agentFrameId: 'agent-frame'
      })
    ])
    await expect(
      repository.readHostArtifactCatalog({ projectId: 'project-a', versionId: 'other-project-v1' })
    ).resolves.toEqual([])

    await createUploadVersion(
      'project-a',
      'session-b',
      'upload-null-created-at',
      'upload-null-created-at-v1',
      null
    )
    const nullableUpload = await repository.readHostArtifactCatalog({
      projectId: 'project-a',
      versionId: 'upload-null-created-at-v1'
    })
    expect(nullableUpload).toEqual([
      expect.objectContaining({
        versionId: 'upload-null-created-at-v1',
        createdAt: '2026-08-04T00:00:00.000Z',
        sourceFileCreatedAt: '2026-07-02T00:00:00.000Z'
      })
    ])
    expect(nullableUpload[0]).not.toHaveProperty('sourceCreatedAt')

    await createArtifactVersion('project-a', 'session-a', 'collision-artifact', 'collision')
    await createUploadVersion('project-a', 'session-b', 'collision-upload', 'collision')
    await expect(
      repository.readHostArtifactCatalog({ projectId: 'project-a', versionId: 'collision' })
    ).rejects.toThrow('ambiguous across generated Artifacts and Uploads')
  })

  it('excludes pending Artifact Versions from exact identity lookups', async () => {
    await createArtifactVersion(
      'project-a',
      'session-a',
      'pending-artifact',
      'pending-version',
      1,
      { agentFrameId: 'child-frame', rootFrameId: 'root-frame', state: 'pending' }
    )

    await expect(
      repository.readHostArtifactCatalog({
        projectId: 'project-a',
        versionId: 'pending-version'
      })
    ).resolves.toEqual([])
    await expect(
      repository.readHostArtifactCatalog({
        projectId: 'project-a',
        versionId: 'pending-version',
        finalizedArtifactsOnly: true
      })
    ).resolves.toEqual([])
  })

  it('projects producer provenance from the latest generated Version only', async () => {
    await createArtifactVersion('project-a', 'session-a', 'artifact-a', 'artifact-a-v1', 1, {
      agentFrameId: 'frame-a',
      rootFrameId: 'shared-root'
    })
    await createArtifactVersion('project-a', 'session-a', 'artifact-a', 'artifact-a-v2', 2, {
      agentFrameId: 'frame-b',
      rootFrameId: 'shared-root'
    })
    await client.managedFile.create({
      data: {
        source: 'artifact',
        sourceFileId: 'artifact-a',
        sourceVersionId: 'artifact-a-v2',
        checksum: checksum('artifact-a-v2'),
        projectId: 'project-a',
        sessionId: 'session-a',
        displayName: 'artifact-a.csv',
        storageKey: 'artifact-a',
        mimeType: 'text/csv',
        sizeBytes: 10n,
        sortAtMs: BigInt(Date.parse('2026-08-02T00:00:00.000Z'))
      }
    })

    await expect(repository.readHostArtifactCatalog({ projectId: 'project-a' })).resolves.toEqual([
      expect.objectContaining({
        versionId: 'artifact-a-v2',
        rootFrameId: 'shared-root',
        agentFrameId: 'frame-b',
        createdAt: '2026-08-02T00:00:00.000Z',
        sourceCreatedAt: '2026-08-02T00:00:00.000Z',
        sourceFileCreatedAt: '2026-07-01T00:00:00.000Z'
      })
    ])
    await expect(
      repository.readHostArtifactCatalog({ projectId: 'project-a', versionId: 'artifact-a-v1' })
    ).resolves.toEqual([
      expect.objectContaining({
        versionId: 'artifact-a-v1',
        rootFrameId: 'shared-root',
        agentFrameId: 'frame-a'
      })
    ])
  })
})
