import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Prisma, PrismaClient } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createProjectDbClient, ensureProjectSchema } from '../projects/prisma-client'
import { ManagedFileIndexRepository } from './repository'

const checksum = (value: string): string => createHash('sha256').update(value).digest('hex')

describe('ManagedFileIndexRepository host Artifact catalog', () => {
  let root: string
  let client: PrismaClient
  let repository: ManagedFileIndexRepository

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'open-science-host-artifacts-'))
    client = createProjectDbClient(root)
    await ensureProjectSchema(client)
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
    versionNumber = 1
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
        filename: `${artifactId}.csv`
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
      rootFrameId: `root-${versionId}`,
      agentFrameId: 'agent-frame',
      messageBranchId: 'branch',
      runtimeSegmentId: 'runtime',
      promptMessageId: 'prompt',
      state: 'finalized',
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
    versionId: string
  ): Promise<void> => {
    await client.uploadFile.create({
      data: {
        id: uploadId,
        projectId,
        sessionId,
        filename: `${uploadId}.pdf`,
        originalFilename: `${uploadId}.pdf`,
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
            createdAt: new Date('2026-08-03T00:00:00.000Z')
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
        rootFrameId: null
      }),
      expect.objectContaining({
        source: 'artifact',
        sourceFileId: 'artifact-a',
        rootFrameId: 'root-artifact-version-a'
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
        rootFrameId: 'root-history-v1'
      })
    ])
    await expect(
      repository.readHostArtifactCatalog({ projectId: 'project-a', versionId: 'other-project-v1' })
    ).resolves.toEqual([])

    await createArtifactVersion('project-a', 'session-a', 'collision-artifact', 'collision')
    await createUploadVersion('project-a', 'session-b', 'collision-upload', 'collision')
    await expect(
      repository.readHostArtifactCatalog({ projectId: 'project-a', versionId: 'collision' })
    ).rejects.toThrow('ambiguous across generated Artifacts and Uploads')
  })
})
