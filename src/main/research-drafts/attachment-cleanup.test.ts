import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrismaClient } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { UploadedAttachment } from '../../shared/uploads'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { UploadRepository } from '../uploads/repository'
import { stageUploadFixtures } from '../uploads/repository.test-utils'
import { ManagedFileIndexRepository } from '../project-files/repository'
import { ManagedFileVersionService } from '../managed-file-versions/service'
import { initDataRoot } from '../storage-root'
import { SessionRepository } from '../session-persistence/repository'
import { SessionPersistenceCoordinator } from '../session-persistence/coordinator'
import { toPersistedUploadedAttachment } from '../../shared/uploads'
import { ContentRepository } from '../storage/content-repository'
import { ResearchAttachmentCleanup } from './attachment-cleanup'

const source: PersistedChatSession = {
  id: 'source',
  projectId: 'project',
  title: 'Read-only source',
  cwd: '',
  messages: [],
  status: 'idle',
  createdAt: 1,
  updatedAt: 1,
  packageOrigin: {
    importId: 'import',
    sourceProjectId: 'foreign',
    sourceSessionId: 'foreign-session',
    importedAt: 1,
    manifestChecksum: 'a'.repeat(64)
  }
}
describe('private research-draft attachment cleanup', () => {
  let root: string
  let client: PrismaClient
  let attachment: UploadedAttachment
  let sessions: PersistedChatSession[]
  let singleEditor: boolean
  let complete: boolean
  let cleanup: ResearchAttachmentCleanup
  let uploads: UploadRepository
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'research-attachment-cleanup-'))
    initDataRoot(root)
    client = createProjectDbClient(root)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project', name: 'Project' } })
    uploads = new UploadRepository(root, { getClient: async () => client })
    const staged = await stageUploadFixtures(uploads, {
      files: [{ name: 'draft.csv', content: Buffer.from('draft-only bytes').toString('base64') }]
    })
    ;[attachment] = await uploads.finalizePendingSessionUploads(
      'research-draft-discarded',
      staged,
      'project',
      { deferVisibility: true }
    )
    const content = new ContentRepository({ storageRoot: root, getClient: async () => client })
    sessions = [source]
    singleEditor = true
    complete = true
    cleanup = new ResearchAttachmentCleanup(
      async () => client,
      async () => ({ complete, sessions }),
      (request) => content.sweep(request),
      () => singleEditor
    )
  })
  afterEach(async () => {
    await client?.$disconnect()
    if (root) await rm(root, { recursive: true, force: true })
  })
  it('releases an unpublished research-only Version and sweeps its bytes through the content owner', async () => {
    await access(attachment.path)
    expect(await cleanup.release('project', 'discarded', [attachment])).toEqual({
      removedVersionIds: [attachment.versionId],
      retainedVersionIds: []
    })
    expect(await client.uploadVersion.count()).toBe(0)
    expect(await client.uploadFile.count()).toBe(0)
    await expect(access(attachment.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('keeps ready draft bytes private through restart and publishes them when a real message is saved', async () => {
    const getClient = async (): Promise<PrismaClient> => client
    const files = new ManagedFileIndexRepository(
      getClient,
      root,
      new ManagedFileVersionService({ storageRoot: root, getClient }),
      uploads
    )
    expect(
      (await files.listFiles({ projectId: 'project', collection: { kind: 'all' }, limit: 100 }))
        .items
    ).toEqual([])
    await new UploadRepository(root, { getClient }).recoverStagingUploads()
    expect(
      (await files.listFiles({ projectId: 'project', collection: { kind: 'all' }, limit: 100 }))
        .items
    ).toEqual([])
    await access(attachment.path)
    const sessionRepository = new SessionRepository(root)
    const persistence = new SessionPersistenceCoordinator(
      sessionRepository,
      files,
      undefined,
      undefined,
      uploads
    )
    const discussion: PersistedChatSession = {
      ...source,
      id: 'discussion',
      packageOrigin: undefined,
      filesRevision: 1,
      messages: [
        {
          id: 'question',
          role: 'user',
          status: 'complete',
          eventIds: [],
          content: 'Discuss this file',
          createdAt: 2,
          updatedAt: 2,
          uploads: [toPersistedUploadedAttachment(attachment)]
        }
      ]
    }
    await persistence.saveSession(discussion)
    const visible = await files.listFiles({
      projectId: 'project',
      collection: { kind: 'all' },
      limit: 100
    })
    expect(visible.items).toHaveLength(1)
    expect(visible.items[0]).toMatchObject({
      sourceFileId: attachment.id,
      sourceVersionId: attachment.versionId
    })
    expect((await cleanup.release('project', 'discarded', [attachment])).removedVersionIds).toEqual(
      []
    )
    await access(attachment.path)
  })
  it('retains bytes referenced by another draft and even a cancelled recoverable question', async () => {
    await client.researchDraft.create({
      data: {
        id: 'other',
        projectId: 'project',
        sourceSessionId: 'source',
        editorId: 'other-window',
        revision: 1,
        payloadJson: JSON.stringify({ attachments: [attachment] }),
        requestHash: 'hash'
      }
    })
    expect((await cleanup.release('project', 'discarded', [attachment])).removedVersionIds).toEqual(
      []
    )
    await client.researchDraft.update({ where: { id: 'other' }, data: { state: 'discarded' } })
    await client.researchSubmission.create({
      data: {
        id: 'cancelled-question',
        projectId: 'project',
        sourceSessionId: 'source',
        messageId: 'message',
        requestHash: 'hash',
        payloadJson: JSON.stringify({ attachments: [attachment] }),
        state: 'cancelled'
      }
    })
    expect((await cleanup.release('project', 'discarded', [attachment])).removedVersionIds).toEqual(
      []
    )
    await access(attachment.path)
  })
  it('retains every managed upload that another Files surface could have observed', async () => {
    await client.managedFile.create({
      data: {
        source: 'upload',
        sourceFileId: attachment.id,
        sourceVersionId: attachment.versionId,
        projectId: 'project',
        sessionId: attachment.sessionId,
        displayName: attachment.name,
        storageKey: 'observed',
        sizeBytes: 16,
        sortAtMs: 1
      }
    })
    expect(
      (await cleanup.release('project', 'discarded', [attachment])).retainedVersionIds
    ).toEqual([attachment.versionId])
    await access(attachment.path)
  })
  it('fails closed for additional windows, unreadable scans, ordinary Sessions, and foreign ownership', async () => {
    singleEditor = false
    expect((await cleanup.release('project', 'discarded', [attachment])).removedVersionIds).toEqual(
      []
    )
    singleEditor = true
    complete = false
    expect((await cleanup.release('project', 'discarded', [attachment])).removedVersionIds).toEqual(
      []
    )
    complete = true
    sessions = [{ ...source, packageOrigin: undefined }]
    expect((await cleanup.release('project', 'discarded', [attachment])).removedVersionIds).toEqual(
      []
    )
    sessions = [source]
    expect(
      (await cleanup.release('project', 'another-draft', [attachment])).removedVersionIds
    ).toEqual([])
    await access(attachment.path)
  })
  it('preserves a source message or saved evidence reference to the same immutable version', async () => {
    sessions = [
      {
        ...source,
        messages: [
          {
            id: 'message',
            role: 'user',
            status: 'complete',
            eventIds: [],
            content: `Evidence ${attachment.versionId}`,
            createdAt: 1,
            updatedAt: 1
          }
        ]
      }
    ]
    expect((await cleanup.release('project', 'discarded', [attachment])).removedVersionIds).toEqual(
      []
    )
    sessions = [source]
    await client.replayQuestionContext.create({
      data: {
        id: 'reference',
        projectId: 'project',
        sourceSessionId: 'source',
        contextJson: JSON.stringify({ versionId: attachment.versionId })
      }
    })
    expect((await cleanup.release('project', 'discarded', [attachment])).removedVersionIds).toEqual(
      []
    )
    await access(attachment.path)
  })
})
