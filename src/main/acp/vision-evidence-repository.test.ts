import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { VisionEvidenceRepository } from './vision-evidence-repository'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const IDENTITY = 'c'.repeat(64)

describe('VisionEvidenceRepository', () => {
  let root: string
  let client: PrismaClient
  let repository: VisionEvidenceRepository

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vision-evidence-'))
    client = createProjectDbClient(root)
    await migrateApplicationDatabase(client)
    repository = new VisionEvidenceRepository(async () => client)
    await client.project.create({ data: { id: 'project-1', name: 'Project' } })
    await client.fileOriginSession.create({
      data: { projectId: 'project-1', sessionId: 'session-1' }
    })
    await client.uploadFile.create({
      data: {
        id: 'upload-file-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        filename: 'chart.png',
        originalFilename: 'chart.png'
      }
    })
    await client.uploadVersion.create({
      data: {
        id: 'upload-version-1',
        uploadFileId: 'upload-file-1',
        versionNumber: 1,
        state: 'ready',
        contentStorageKey: 'uploads/chart.png',
        filename: 'chart.png',
        originalFilename: 'chart.png',
        contentType: 'image/png',
        sizeBytes: 5n,
        checksum: HASH_A
      }
    })
  })

  afterEach(async () => {
    await client.$disconnect()
    await rm(root, { recursive: true, force: true })
  })

  it('persists validated evidence and invalidates it when the extractor changes', async () => {
    await repository.save({
      identityKey: IDENTITY,
      projectId: 'project-1',
      sessionId: 'session-1',
      source: { kind: 'upload-version', uploadVersionId: 'upload-version-1' },
      imageChecksum: HASH_A,
      mimeType: 'image/png',
      extractorFingerprint: HASH_A,
      evidenceSchemaVersion: 2,
      evidenceJson: '{"summary":"chart"}'
    })

    await expect(
      repository.find({
        identityKey: IDENTITY,
        imageChecksum: HASH_A,
        extractorFingerprint: HASH_A,
        evidenceSchemaVersion: 2
      })
    ).resolves.toBe('{"summary":"chart"}')
    await expect(
      repository.find({
        identityKey: IDENTITY,
        imageChecksum: HASH_A,
        extractorFingerprint: HASH_B,
        evidenceSchemaVersion: 2
      })
    ).resolves.toBeUndefined()
  })

  it('cascades uploaded evidence when its UploadVersion is removed', async () => {
    await repository.save({
      identityKey: IDENTITY,
      projectId: 'project-1',
      sessionId: 'session-1',
      source: { kind: 'upload-version', uploadVersionId: 'upload-version-1' },
      imageChecksum: HASH_A,
      mimeType: 'image/png',
      extractorFingerprint: HASH_A,
      evidenceSchemaVersion: 2,
      evidenceJson: '{"summary":"chart"}'
    })

    await client.uploadVersion.delete({ where: { id: 'upload-version-1' } })

    await expect(client.visionEvidence.count()).resolves.toBe(0)
  })

  it('cleans message-image evidence by Session id', async () => {
    await repository.save({
      identityKey: IDENTITY,
      projectId: 'project-1',
      sessionId: 'session-1',
      source: { kind: 'message-image', messageId: 'message-1', imageId: 'image-1' },
      imageChecksum: HASH_A,
      mimeType: 'image/png',
      extractorFingerprint: HASH_A,
      evidenceSchemaVersion: 2,
      evidenceJson: '{"summary":"chart"}'
    })

    await repository.deleteSessions(['session-1'])

    await expect(client.visionEvidence.count()).resolves.toBe(0)
  })

  it('does not recreate evidence for a soft-deleted Project', async () => {
    await client.project.update({ where: { id: 'project-1' }, data: { deletedAt: new Date() } })

    await repository.save({
      identityKey: IDENTITY,
      projectId: 'project-1',
      sessionId: 'session-1',
      source: { kind: 'message-image', messageId: 'message-1', imageId: 'image-1' },
      imageChecksum: HASH_A,
      mimeType: 'image/png',
      extractorFingerprint: HASH_A,
      evidenceSchemaVersion: 2,
      evidenceJson: '{"summary":"chart"}'
    })

    await expect(client.visionEvidence.count()).resolves.toBe(0)
  })
})
