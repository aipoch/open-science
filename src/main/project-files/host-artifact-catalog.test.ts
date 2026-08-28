import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Prisma, PrismaClient } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
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
    repository = new ManagedFileIndexRepository(() => Promise.resolve(client), root)
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
    agentFrameId = 'agent-frame',
    rootFrameId = `root-${versionId}`,
    state: 'pending' | 'finalized' = 'finalized'
  ): Promise<void> => {
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
      state,
      contentStorageKey: `artifacts/${projectId}/${sessionId}/${versionId}/content`,
      evidenceStorageKey: `artifacts/${projectId}/${sessionId}/${versionId}/evidence.json`,
      contentType: 'text/csv',
      sizeBytes: 10n,
      checksum: checksum(versionId),
      evidenceJson: '{}',
      evidenceChecksum: 'b'.repeat(64),
      createdAt: new Date(`2026-08-0${versionNumber}T00:00:00.000Z`)
    }
    await client.artifactVersion.create({ data })
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
  }

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

  it('excludes pending Artifact Versions from finalized-only exact identity lookups', async () => {
    await createArtifactVersion(
      'project-a',
      'session-a',
      'pending-artifact',
      'pending-version',
      1,
      'child-frame',
      'root-frame',
      'pending'
    )

    await expect(
      repository.readHostArtifactCatalog({
        projectId: 'project-a',
        versionId: 'pending-version'
      })
    ).resolves.toHaveLength(1)
    await expect(
      repository.readHostArtifactCatalog({
        projectId: 'project-a',
        versionId: 'pending-version',
        finalizedArtifactsOnly: true
      })
    ).resolves.toEqual([])
  })

  it('projects producer provenance from the latest generated Version only', async () => {
    await createArtifactVersion(
      'project-a',
      'session-a',
      'artifact-a',
      'artifact-a-v1',
      1,
      'frame-a',
      'shared-root'
    )
    await createArtifactVersion(
      'project-a',
      'session-a',
      'artifact-a',
      'artifact-a-v2',
      2,
      'frame-b',
      'shared-root'
    )
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
