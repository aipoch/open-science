import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrismaClient } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactPreviewResult, ReadArtifactPreviewRequest } from '../../shared/artifacts'
import type { ResearchDraftPayload } from '../../shared/research-draft'
import type { ResearchSubmissionPayload } from '../../shared/research-submission'
import { createUploadVersionReference, type UploadedAttachment } from '../../shared/uploads'
import { createElectronCallerContext } from '../caller-context'
import { ApplicationCallerLeaseRegistry } from '../caller-lifecycle'
import { ManagedFileVersionService } from '../managed-file-versions/service'
import { ManagedPreviewResources } from '../managed-preview-resources'
import { ManagedFileIndexRepository } from '../project-files/repository'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { createUploadCommandOwner } from './command-owner'
import { UploadRepository } from './repository'
import { stageUploadFixtures } from './repository.test-utils'
import { openUploadPreviewVersion } from './research-preview'

describe('private research upload preview', () => {
  let root: string
  let client: PrismaClient
  let uploads: UploadRepository
  let versions: ManagedFileVersionService
  let attachment: UploadedAttachment
  const bytes = 'Bytes retained through process termination.\n'
  const getClient = async (): Promise<PrismaClient> => client
  const draftPayload = (): ResearchDraftPayload => ({
    doc: { nodes: [{ type: 'text', text: 'Unsent research question' }] },
    annotations: [],
    attachments: [attachment],
    transfers: [],
    automaticReadingEnabled: true,
    editRevision: 1,
    intentId: 'question'
  })
  const createReaders = (): void => {
    uploads = new UploadRepository(root, { getClient })
    versions = new ManagedFileVersionService({ storageRoot: root, getClient })
  }
  const read = (
    overrides: Partial<ReadArtifactPreviewRequest> = {}
  ): Promise<ArtifactPreviewResult> => {
    const owner = createUploadCommandOwner(uploads, {
      openLatestManagedFile: (request) =>
        versions.openLatest({
          source: 'upload',
          projectId: request.projectId!,
          fileId: request.fileId!
        }),
      openManagedFileVersion: (request) =>
        openUploadPreviewVersion(versions, getClient, {
          ...request,
          projectId: request.projectId!,
          fileId: request.fileId!
        })
    })
    const callerContext = createElectronCallerContext(1)
    const callerLease = new ApplicationCallerLeaseRegistry().acquire(callerContext).lease
    return owner.readPreview({
      callerContext,
      callerLease,
      args: [
        {
          projectId: 'project',
          sessionId: attachment.sessionId,
          fileId: attachment.id,
          versionId: attachment.versionId,
          path: attachment.path,
          encoding: 'utf8',
          ...overrides
        }
      ]
    })
  }
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'research-upload-preview-'))
    client = createProjectDbClient(root)
    await migrateApplicationDatabase(client)
    await client.project.createMany({
      data: [
        { id: 'project', name: 'Project' },
        { id: 'other-project', name: 'Other Project' }
      ]
    })
    createReaders()
    const staged = await stageUploadFixtures(uploads, {
      files: [{ name: 'evidence.txt', content: Buffer.from(bytes).toString('base64') }]
    })
    ;[attachment] = await uploads.finalizePendingSessionUploads(
      'research-draft-draft',
      staged,
      'project',
      { deferVisibility: true }
    )
    await client.researchDraft.create({
      data: {
        id: 'draft',
        projectId: 'project',
        sourceSessionId: 'imported-source',
        editorId: 'window',
        revision: 1,
        requestHash: 'hash',
        payloadJson: JSON.stringify(draftPayload())
      }
    })
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await client?.$disconnect()
    if (root) await rm(root, { recursive: true, force: true })
  })

  it('reads the durable exact attachment after restart without publishing it or enabling latest reads', async () => {
    await client.$disconnect()
    client = createProjectDbClient(root)
    createReaders()
    await uploads.recoverStagingUploads()
    const files = new ManagedFileIndexRepository(getClient, root, versions, uploads)
    await expect(read()).resolves.toMatchObject({ content: bytes })
    // Raw renderer paths never select the bytes: logical File/Version identity does.
    await expect(read({ path: '/not/the/attachment' })).resolves.toMatchObject({ content: bytes })
    expect(
      (await files.listFiles({ projectId: 'project', collection: { kind: 'all' }, limit: 100 }))
        .items
    ).toEqual([])
    expect(
      (await client.uploadFile.findUniqueOrThrow({ where: { id: attachment.id } })).currentVersionId
    ).toBeNull()
    await expect(read({ versionId: undefined })).rejects.toMatchObject({
      code: 'VERSION_NOT_FOUND'
    })
    await expect(
      read({ projectId: undefined, fileId: undefined, versionId: undefined })
    ).rejects.toThrow(/logical identity/)
    // The stable version locator still derives the full scope after a renderer restart.
    await expect(
      read({
        projectId: undefined,
        sessionId: undefined,
        fileId: undefined,
        versionId: undefined,
        path: createUploadVersionReference(attachment.versionId!, {
          projectId: 'project',
          sessionId: attachment.sessionId,
          fileId: attachment.id
        })
      })
    ).resolves.toMatchObject({ content: bytes })
  })

  it('rejects cross-project, cross-session, cross-file and different-version requests', async () => {
    for (const overrides of [
      { projectId: 'other-project' },
      { sessionId: 'other-session' },
      { fileId: 'another-file' },
      { versionId: 'another-version' }
    ])
      await expect(read(overrides)).rejects.toThrow()
    expect(await client.managedFile.count()).toBe(0)
  })

  it('keeps published attachment reads independent of research journals', async () => {
    const staged = await stageUploadFixtures(uploads, {
      files: [{ name: 'ordinary.txt', content: Buffer.from(bytes).toString('base64') }]
    })
    ;[attachment] = await uploads.finalizePendingSessionUploads(
      'ordinary-session',
      staged,
      'project'
    )
    await client.researchDraft.deleteMany()
    const unpublished = vi.spyOn(versions, 'openUnpublishedVersion')
    await expect(read()).resolves.toMatchObject({ content: bytes })
    await expect(read({ versionId: undefined })).resolves.toMatchObject({ content: bytes })
    expect(unpublished).not.toHaveBeenCalled()
  })

  it('serves the exact private attachment through the real preview range lease and retains window ownership', async () => {
    const resources = new ManagedPreviewResources({
      resolvePath: async () => {
        throw new Error('Private uploads never resolve a renderer path.')
      },
      openLatestManagedFile: (source, request) => versions.openLatest({ source, ...request }),
      openManagedFileVersion: (source, request) =>
        source === 'upload'
          ? openUploadPreviewVersion(versions, getClient, request)
          : versions.openVersion(
              { source, projectId: request.projectId, fileId: request.fileId },
              request.versionId
            )
    })
    const resource = await resources.acquire(17, {
      source: 'upload',
      projectId: 'project',
      fileId: attachment.id,
      versionId: attachment.versionId!
    })
    try {
      const range = { resourceId: resource.id, begin: 0, end: Buffer.byteLength(bytes) }
      await expect(resources.readRange(17, range)).resolves.toMatchObject({
        data: new Uint8Array(Buffer.from(bytes))
      })
      await expect(resources.readRange(18, range)).rejects.toThrow()
      await expect(
        resources.acquire(17, {
          source: 'upload',
          projectId: 'other-project',
          fileId: attachment.id,
          versionId: attachment.versionId!
        })
      ).rejects.toThrow()
      expect(await client.managedFile.count()).toBe(0)
    } finally {
      resources.release(17, { resourceId: resource.id })
    }
  })

  it('requires an active, valid, exactly matching persisted reference in the same Project', async () => {
    await client.researchDraft.update({ where: { id: 'draft' }, data: { state: 'discarded' } })
    await expect(read()).rejects.toMatchObject({ code: 'VERSION_NOT_FOUND' })
    await client.researchDraft.update({
      where: { id: 'draft' },
      data: { state: 'active', projectId: 'other-project' }
    })
    await expect(read()).rejects.toMatchObject({ code: 'VERSION_NOT_FOUND' })
    await client.researchDraft.update({
      where: { id: 'draft' },
      data: {
        projectId: 'project',
        payloadJson: JSON.stringify({
          ...draftPayload(),
          attachments: [{ ...attachment, sessionId: 'other-session' }]
        })
      }
    })
    await expect(read()).rejects.toMatchObject({ code: 'VERSION_NOT_FOUND' })
    await client.researchDraft.update({
      where: { id: 'draft' },
      data: {
        payloadJson: JSON.stringify({
          ...draftPayload(),
          attachments: [{ ...attachment, id: 'other-file' }]
        })
      }
    })
    await expect(read()).rejects.toMatchObject({ code: 'VERSION_NOT_FOUND' })
    await client.researchDraft.update({
      where: { id: 'draft' },
      data: { payloadJson: JSON.stringify({ attachments: [attachment] }) }
    })
    await expect(read()).rejects.toMatchObject({ code: 'VERSION_NOT_FOUND' })
  })

  it('retains exact read-back when a recoverable queued or cancelled question owns the attachment', async () => {
    await client.researchDraft.deleteMany()
    const payload: ResearchSubmissionPayload = {
      text: 'Saved question',
      attachments: [attachment],
      annotations: [],
      permissionProfile: 'ask',
      agentConfiguration: { providerId: 'codex', reasoningEffort: 'default' },
      forcedSkillIds: []
    }
    await client.researchSubmission.create({
      data: {
        id: 'question',
        projectId: 'project',
        sourceSessionId: 'imported-source',
        messageId: 'message',
        requestHash: 'hash',
        payloadJson: JSON.stringify(payload),
        state: 'queued'
      }
    })
    await expect(read()).resolves.toMatchObject({ content: bytes })
    await client.researchSubmission.update({
      where: { id: 'question' },
      data: { state: 'cancelled' }
    })
    await expect(read()).resolves.toMatchObject({ content: bytes })
  })

  it('rejects ordinary unpublished owners and incomplete writes even with a copied draft reference', async () => {
    await client.fileOriginSession.create({
      data: { projectId: 'project', sessionId: 'ordinary-session', state: 'active' }
    })
    await client.uploadFile.update({
      where: { id: attachment.id },
      data: { sessionId: 'ordinary-session' }
    })
    attachment = { ...attachment, sessionId: 'ordinary-session' }
    await client.researchDraft.update({
      where: { id: 'draft' },
      data: { payloadJson: JSON.stringify(draftPayload()) }
    })
    await expect(read()).rejects.toMatchObject({ code: 'VERSION_NOT_FOUND' })
    await client.uploadFile.update({
      where: { id: attachment.id },
      data: { sessionId: 'research-draft-draft' }
    })
    attachment = { ...attachment, sessionId: 'research-draft-draft' }
    await client.researchDraft.update({
      where: { id: 'draft' },
      data: { payloadJson: JSON.stringify(draftPayload()) }
    })
    await client.uploadVersion.update({
      where: { id: attachment.versionId },
      data: { state: 'staging' }
    })
    await expect(read()).rejects.toMatchObject({ code: 'VERSION_NOT_FOUND' })
  })

  it('keeps deletion and checksum verification enforced for private reads', async () => {
    await client.fileOriginSession.update({
      where: { projectId_sessionId: { projectId: 'project', sessionId: attachment.sessionId } },
      data: {
        state: 'deleting',
        deletionOperationId: 'delete-operation',
        retainedReviewIdsJson: '[]'
      }
    })
    await expect(read()).rejects.toMatchObject({ code: 'FILE_DELETED' })
    await client.fileOriginSession.update({
      where: { projectId_sessionId: { projectId: 'project', sessionId: attachment.sessionId } },
      data: { state: 'active', deletionOperationId: null, retainedReviewIdsJson: null }
    })
    await chmod(attachment.path, 0o600)
    await writeFile(attachment.path, 'corrupted bytes')
    await expect(read()).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
  })

  it('closes the lease if the last durable reference is discarded while it opens', async () => {
    const open = versions.openUnpublishedVersion.bind(versions)
    const close = vi.fn()
    vi.spyOn(versions, 'openUnpublishedVersion').mockImplementation(async (...args) => {
      const lease = await open(...args)
      close.mockImplementation(() => lease.close())
      await client.researchDraft.update({ where: { id: 'draft' }, data: { state: 'discarded' } })
      return { ...lease, close }
    })
    await expect(read()).rejects.toMatchObject({ code: 'VERSION_NOT_FOUND' })
    expect(close).toHaveBeenCalledOnce()
  })
})
