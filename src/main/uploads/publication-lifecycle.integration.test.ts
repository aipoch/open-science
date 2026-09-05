import type { PrismaClient } from '@prisma/client'
import { createHash } from 'node:crypto'
import type { ReadStream } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { STANDALONE_UPLOAD_SESSION_ID, type UploadedAttachment } from '../../shared/uploads'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { createElectronCallerContext } from '../caller-context'
import { ApplicationCallerLeaseRegistry } from '../caller-lifecycle'
import { ManagedFileVersionService } from '../managed-file-versions/service'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { createUploadCommandOwner } from './command-owner'
import { UploadRepository } from './repository'
import { stageUploadFixtures } from './repository.test-utils'

describe('upload publication lifecycle (SQLite + filesystem)', () => {
  let root: string
  let client: PrismaClient
  const projectId = 'project-1'
  const sessionId = 'session-1'
  const content = 'lifecycle evidence\n'
  const deletedAt = new Date('2026-09-05T00:00:00Z')

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'open-science-upload-lifecycle-'))
    client = createProjectDbClient(root)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: projectId, name: 'Publication target' } })
  })

  afterEach(async () => {
    await client.$disconnect()
    await rm(root, { recursive: true, force: true })
  })

  const stage = (repository: UploadRepository): Promise<UploadedAttachment[]> =>
    stageUploadFixtures(repository, {
      files: [
        {
          name: 'evidence.txt',
          mimeType: 'text/plain',
          content: Buffer.from(content).toString('base64')
        }
      ]
    })

  const block = async (barrier: string): Promise<void> => {
    if (barrier === 'missing project') {
      await client.project.delete({ where: { id: projectId } })
    } else if (barrier === 'archived project') {
      await client.project.update({ where: { id: projectId }, data: { archivedAt: deletedAt } })
    } else if (barrier === 'project deletion intent') {
      await client.projectDeletionIntent.create({ data: { projectId } })
    } else {
      await client.fileOriginSession.upsert({
        where: { projectId_sessionId: { projectId, sessionId } },
        create: { projectId, sessionId, state: 'deleted', deletedAt },
        update: { state: 'deleted', deletedAt }
      })
    }
  }

  const sessionWithUpload = (upload: UploadedAttachment): PersistedChatSession => ({
    id: sessionId,
    projectId,
    title: 'Legacy session',
    cwd: root,
    status: 'idle',
    messages: [
      {
        id: 'message-1',
        role: 'user',
        content: 'Evidence',
        status: 'complete',
        eventIds: [],
        uploads: [upload],
        createdAt: 1,
        updatedAt: 1
      }
    ],
    createdAt: 1,
    updatedAt: 1
  })

  it('publishes an active project and origin through the public repository', async () => {
    const repository = new UploadRepository(root, { getClient: async () => client })
    const [published] = await repository.finalizePendingSessionUploads(
      sessionId,
      await stage(repository),
      projectId
    )
    await expect(readFile(published.path, 'utf8')).resolves.toBe(content)
    const service = new ManagedFileVersionService({
      storageRoot: root,
      getClient: async () => client
    })
    await expect(
      service.inspect({ source: 'upload', projectId, fileId: published.id })
    ).resolves.toMatchObject({ canEdit: true })
  })

  it.each(['missing project', 'archived project', 'project deletion intent', 'deleted origin'])(
    'rejects a new upload behind a persisted %s barrier',
    async (barrier) => {
      const repository = new UploadRepository(root, { getClient: async () => client })
      const attachments = await stage(repository)
      await block(barrier)

      const [result] = await Promise.allSettled([
        repository.finalizePendingSessionUploads(sessionId, attachments, projectId)
      ])
      // If the regression returns, verify its reported consequence rather than accepting an
      // unrelated I/O or fixture failure as reproduction evidence.
      if (result.status === 'fulfilled') {
        await expect(readFile(result.value[0].path, 'utf8')).resolves.toBe(content)
        const service = new ManagedFileVersionService({
          storageRoot: root,
          getClient: async () => client
        })
        const inspection = service.inspect({
          source: 'upload',
          projectId,
          fileId: attachments[0].id
        })
        if (barrier === 'missing project' || barrier === 'project deletion intent') {
          await expect(inspection).rejects.toMatchObject({
            code: barrier === 'missing project' ? 'FILE_NOT_FOUND' : 'FILE_DELETED'
          })
        } else {
          await expect(inspection).resolves.toMatchObject({
            canEdit: false,
            unavailableReason:
              barrier === 'deleted origin' ? 'FILE_DELETED' : 'PROJECT_NOT_WRITABLE'
          })
        }
      }
      expect
        .soft(result.status, 'publication must reject the persisted lifecycle barrier')
        .toBe('rejected')
      expect.soft(await client.uploadVersion.count({ where: { state: 'ready' } })).toBe(0)
      expect.soft(await client.managedFile.count({ where: { deletedAt: null } })).toBe(0)
    }
  )

  it.each(['missing project', 'archived project', 'project deletion intent', 'deleted origin'])(
    'does not advance ready/head when %s appears after registration',
    async (barrier) => {
      let blocked = false
      const repository = new UploadRepository(root, {
        // Existing dependency boundary: act only after a real staging transaction has committed,
        // before completion obtains its client. No transaction or filesystem operation is mocked.
        getClient: async () => {
          if (!blocked && (await client.uploadVersion.count({ where: { state: 'staging' } }))) {
            blocked = true
            await block(barrier)
          }
          return client
        }
      })
      const [result] = await Promise.allSettled([
        repository.finalizePendingSessionUploads(sessionId, await stage(repository), projectId)
      ])
      expect(blocked).toBe(true)
      expect.soft(result.status).toBe('rejected')
      expect.soft(await client.uploadVersion.count({ where: { state: 'ready' } })).toBe(0)
      expect
        .soft(await client.uploadFile.count({ where: { currentVersionId: { not: null } } }))
        .toBe(0)
      expect.soft(await client.managedFile.count({ where: { deletedAt: null } })).toBe(0)

      // Restart with an ordinary client supplier: recovery must respect the same durable barrier.
      const restarted = new UploadRepository(root, { getClient: async () => client })
      await restarted.recoverStagingUploads().catch(() => undefined)
      expect.soft(await client.uploadVersion.count({ where: { state: 'ready' } })).toBe(0)
      expect.soft(await client.managedFile.count({ where: { deletedAt: null } })).toBe(0)
    }
  )

  it('rejects standalone save when its project is deleted while the local stream is copying', async () => {
    const sourcePath = join(root, 'local.txt')
    await writeFile(sourcePath, content)
    let deletedDuringCopy = false
    const repository = new UploadRepository(root, {
      getClient: async () => client,
      createLocalReadStream: () =>
        Readable.from(
          (async function* () {
            yield Buffer.from(content.slice(0, 1))
            await client.project.delete({ where: { id: projectId } })
            deletedDuringCopy = true
            yield Buffer.from(content.slice(1))
          })()
        ) as ReadStream
    })
    const owner = createUploadCommandOwner(repository)
    const leases = new ApplicationCallerLeaseRegistry()
    const callerContext = createElectronCallerContext(1)
    const owned = leases.acquire(callerContext)
    try {
      const [result] = await Promise.allSettled([
        owner.stageLocalPath({
          callerContext,
          callerLease: owned.lease,
          args: [{ transferId: 'standalone-copy', projectId, sourcePath, name: 'local.txt' }]
        })
      ])
      expect(deletedDuringCopy).toBe(true)
      expect.soft(result.status).toBe('rejected')
      expect.soft(await client.uploadVersion.count({ where: { state: 'ready' } })).toBe(0)
      expect
        .soft(
          await client.managedFile.count({
            where: { sessionId: STANDALONE_UPLOAD_SESSION_ID, deletedAt: null }
          })
        )
        .toBe(0)
      await expect(readFile(sourcePath, 'utf8')).resolves.toBe(content)
    } finally {
      owner.releaseCaller(owned.lease)
    }
  })

  it('does not resurrect a deleted Files projection when retrying an existing immutable upload', async () => {
    const repository = new UploadRepository(root, { getClient: async () => client })
    const [published] = await repository.finalizePendingSessionUploads(
      sessionId,
      await stage(repository),
      projectId
    )
    await block('deleted origin')
    await client.managedFile.updateMany({ data: { deletedAt, deleteOperationId: 'delete-1' } })

    await repository
      .finalizePendingSessionUploads(sessionId, [published], projectId)
      .catch(() => undefined)

    await expect(client.managedFile.findFirstOrThrow()).resolves.toMatchObject({
      deletedAt,
      deleteOperationId: 'delete-1'
    })
    expect(await client.uploadVersion.count({ where: { state: 'ready' } })).toBe(1)
    await expect(readFile(published.path, 'utf8')).resolves.toBe(content)
  })

  it.each(['archived project', 'project deletion intent', 'deleted origin'])(
    'preserves legacy session evidence behind a %s barrier without publishing Files',
    async (barrier) => {
      const oldRepository = new UploadRepository(root)
      const [legacy] = await oldRepository.finalizePendingSessionUploads(
        sessionId,
        await stage(oldRepository),
        projectId
      )
      await block(barrier)
      const repository = new UploadRepository(root, { getClient: async () => client })
      const upgraded = await repository.upgradeLegacySessionUploads(sessionWithUpload(legacy), {
        mode: 'live-save'
      })
      const reference = upgraded.messages[0].uploads![0]
      const version = await client.uploadVersion.findUniqueOrThrow({
        where: { id: reference.versionId }
      })
      expect.soft(version).toMatchObject({ state: 'ready', originKind: 'legacy' })
      expect
        .soft(await client.uploadFile.findFirstOrThrow())
        .toMatchObject({ currentVersionId: null })
      expect.soft(await client.managedFile.count()).toBe(0)
      await expect(
        readFile(join(root, ...version.contentStorageKey.split('/')), 'utf8')
      ).resolves.toBe(content)
      await expect(readFile(legacy.path, 'utf8')).resolves.toBe(content)
      const retry = await repository.upgradeLegacySessionUploads(sessionWithUpload(legacy), {
        mode: 'live-save'
      })
      expect(retry.messages[0].uploads![0].versionId).toBe(reference.versionId)
      expect(await client.managedFile.count()).toBe(0)
    }
  )

  it('does not grant pending uploads historical authority through legacy upgrade', async () => {
    const repository = new UploadRepository(root, { getClient: async () => client })
    const [pending] = await stage(repository)
    await block('deleted origin')
    await expect(
      repository.upgradeLegacySessionUploads(sessionWithUpload(pending), { mode: 'live-save' })
    ).rejects.toThrow(/lifecycle/)
    expect(await client.uploadVersion.count()).toBe(0)
  })

  it('preserves a Files tombstone committed between staging and completion', async () => {
    let tombstoned = false
    const repository = new UploadRepository(root, {
      getClient: async () => {
        const version = await client.uploadVersion.findFirst({ where: { state: 'staging' } })
        if (!tombstoned && version) {
          tombstoned = true
          await client.managedFile.create({
            data: {
              projectId,
              sessionId,
              source: 'upload',
              sourceFileId: version.uploadFileId,
              sourceVersionId: version.id,
              displayName: version.filename,
              storageKey: version.contentStorageKey,
              sizeBytes: version.sizeBytes,
              sortAtMs: 1n,
              deletedAt,
              deleteOperationId: 'delete-during-publication'
            }
          })
        }
        return client
      }
    })
    await expect(
      repository.finalizePendingSessionUploads(sessionId, await stage(repository), projectId)
    ).rejects.toThrow(/lifecycle/)
    expect(tombstoned).toBe(true)
    expect(await client.uploadVersion.count({ where: { state: 'ready' } })).toBe(0)
    await expect(client.managedFile.findFirstOrThrow()).resolves.toMatchObject({
      deletedAt,
      deleteOperationId: 'delete-during-publication'
    })
  })

  it('publishes recovered legacy evidence after its project is unarchived', async () => {
    const oldRepository = new UploadRepository(root)
    const [legacy] = await oldRepository.finalizePendingSessionUploads(
      sessionId,
      await stage(oldRepository),
      projectId
    )
    await block('archived project')
    const repository = new UploadRepository(root, { getClient: async () => client })
    const upgraded = await repository.upgradeLegacySessionUploads(sessionWithUpload(legacy), {
      mode: 'live-save'
    })
    await repository.upgradeLegacySessionUploads(upgraded, { mode: 'live-save' })
    expect(await client.managedFile.count()).toBe(0)
    expect((await client.uploadFile.findFirstOrThrow()).currentVersionId).toBeNull()
    await client.project.update({ where: { id: projectId }, data: { archivedAt: null } })

    await repository.upgradeLegacySessionUploads(upgraded, { mode: 'live-save' })

    const versionId = upgraded.messages[0].uploads![0].versionId
    expect
      .soft(await client.uploadFile.findFirstOrThrow())
      .toMatchObject({ currentVersionId: versionId })
    expect.soft(await client.managedFile.count({ where: { deletedAt: null } })).toBe(1)
  })

  it.each(['archived project', 'project deletion intent'])(
    'recovers a pre-existing legacy staging row behind a %s barrier',
    async (barrier) => {
      const oldRepository = new UploadRepository(root)
      const [legacy] = await oldRepository.finalizePendingSessionUploads(
        sessionId,
        await stage(oldRepository),
        projectId
      )
      await client.fileOriginSession.create({ data: { projectId, sessionId } })
      await client.uploadFile.create({
        data: {
          id: legacy.id,
          projectId,
          sessionId,
          filename: legacy.name,
          originalFilename: legacy.originalName,
          versions: {
            create: {
              id: 'interrupted-legacy-version',
              versionNumber: 1,
              state: 'staging',
              contentStorageKey: `uploads/${projectId}/${sessionId}/${legacy.id}/versions/interrupted-legacy-version/content`,
              filename: legacy.name,
              originalFilename: legacy.originalName,
              sizeBytes: BigInt(Buffer.byteLength(content)),
              checksum: createHash('sha256').update(content).digest('hex')
            }
          }
        }
      })
      expect((await client.uploadVersion.findFirstOrThrow()).originKind).toBe('user_upload')
      await block(barrier)
      const repository = new UploadRepository(root, { getClient: async () => client })

      const wrongPath = join(root, 'uploads', 'default-project', sessionId, 'unrelated.txt')
      await writeFile(wrongPath, content)
      await expect(
        repository.upgradeLegacySessionUploads(sessionWithUpload({ ...legacy, path: wrongPath }), {
          mode: 'live-save'
        })
      ).rejects.toThrow(/lifecycle/)
      expect(await client.uploadVersion.count({ where: { state: 'ready' } })).toBe(0)

      await expect(
        repository.upgradeLegacySessionUploads(
          sessionWithUpload({ ...legacy, checksum: '0'.repeat(64) }),
          { mode: 'live-save' }
        )
      ).rejects.toThrow(/lifecycle/)
      expect(await client.uploadVersion.count({ where: { state: 'ready' } })).toBe(0)

      await expect(
        repository.upgradeLegacySessionUploads(sessionWithUpload(legacy), {
          mode: 'live-save'
        })
      ).resolves.toMatchObject({
        messages: [{ uploads: [{ versionId: 'interrupted-legacy-version' }] }]
      })

      expect(await client.uploadVersion.count()).toBe(1)
      expect(await client.managedFile.count()).toBe(0)
    }
  )
})
