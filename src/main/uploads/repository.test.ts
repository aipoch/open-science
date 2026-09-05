import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, sep } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PENDING_UPLOAD_SESSION_ID, type PersistedUploadedAttachment } from '../../shared/uploads'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import {
  OrphanLegacyUploadAuthorityMissingError,
  UnsafeLegacyUploadResidualError,
  UploadRepository
} from './repository'
import { VerifiedLegacyCleanupOwner } from './verified-legacy-cleanup-owner'
import { stageUploadFixtures } from './repository.test-utils'

let storageRoot: string | undefined
let disconnect: (() => Promise<void>) | undefined

const createStorageRoot = async (): Promise<string> => {
  storageRoot = await mkdtemp(join(tmpdir(), 'open-science-uploads-'))
  return storageRoot
}

const createSessionWithGraphUpload = (
  primaryUpload: PersistedUploadedAttachment,
  graphUpload: PersistedUploadedAttachment
): PersistedChatSession => ({
  id: 'session-1',
  projectId: 'project-1',
  title: 'Conflicting Upload references',
  cwd: '/workspace',
  status: 'idle',
  messages: [
    {
      id: 'message-primary',
      role: 'user',
      content: 'Primary upload',
      status: 'complete',
      eventIds: [],
      uploads: [primaryUpload],
      createdAt: 1,
      updatedAt: 1
    }
  ],
  conversationGraph: {
    schemaVersion: 1,
    rootFrameId: 'frame-root',
    activeFrameId: 'frame-root',
    frames: [
      {
        id: 'frame-root',
        originBindingState: 'root',
        kind: 'root',
        status: 'completed',
        activeBranchId: 'branch-root',
        createdAt: 1,
        completedAt: 1
      }
    ],
    branches: [
      {
        id: 'branch-root',
        agentFrameId: 'frame-root',
        headMessageId: 'message-graph',
        createdAt: 1,
        updatedAt: 1
      }
    ],
    messages: [
      {
        id: 'message-graph',
        agentFrameId: 'frame-root',
        introducedOnBranchId: 'branch-root',
        role: 'user',
        content: 'Graph upload',
        status: 'complete',
        eventIds: [],
        uploads: [graphUpload],
        createdAt: 1,
        updatedAt: 1
      }
    ],
    activities: [],
    activityGroups: [],
    runtimeSegments: []
  },
  createdAt: 1,
  updatedAt: 1
})

afterEach(async () => {
  await disconnect?.()
  disconnect = undefined
  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true })
    storageRoot = undefined
  }
})

describe('upload repository', () => {
  it('stages a local file by path without loading its bytes into the renderer', async () => {
    const root = await createStorageRoot()
    const repository = new UploadRepository(root)
    const sourcePath = join(root, 'dataset.csv')
    const content = Buffer.from('sample,value\na,1\nb,2\n')
    const progress: number[] = []

    await writeFile(sourcePath, content)

    const attachment = await repository.stageLocalFile(
      {
        transferId: 'local-transfer-1',
        sourcePath,
        name: 'dataset.csv',
        mimeType: 'text/csv',
        size: content.byteLength
      },
      ({ receivedBytes }) => progress.push(receivedBytes)
    )

    expect(attachment).toMatchObject({
      sessionId: PENDING_UPLOAD_SESSION_ID,
      name: 'dataset.csv',
      originalName: 'dataset.csv',
      mimeType: 'text/csv',
      size: content.byteLength
    })
    await expect(readFile(attachment.path)).resolves.toEqual(content)
    expect(progress.at(-1)).toBe(content.byteLength)
  })

  it('cancels a local-path upload before asynchronous source validation finishes', async () => {
    const root = await createStorageRoot()
    const repository = new UploadRepository(root)
    const sourcePath = join(root, 'dataset.csv')
    const content = Buffer.from('sample,value\na,1\n')
    await writeFile(sourcePath, content)

    const stagePromise = repository.stageLocalFile({
      transferId: 'local-transfer-cancel-early',
      sourcePath,
      name: 'dataset.csv',
      mimeType: 'text/csv',
      size: content.byteLength
    })
    const stageRejection = expect(stagePromise).rejects.toThrow(/upload cancelled/i)
    await repository.abortTransfer({ transferId: 'local-transfer-cancel-early' })

    await stageRejection
    await expect(
      stat(join(root, 'uploads', 'default-project', PENDING_UPLOAD_SESSION_ID, 'dataset.csv'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('interrupts a stalled local source stream and waits for staging cleanup', async () => {
    const root = await createStorageRoot()
    const sourcePath = join(root, 'slow-dataset.csv')
    const content = Buffer.from('sample,value\na,1\n')
    const stalledSource = new Readable({ read: () => undefined })
    let sourceSignal: AbortSignal | undefined
    const repository = new UploadRepository(root, {
      createLocalReadStream: (_path, options) => {
        sourceSignal = options.signal
        options.signal.addEventListener(
          'abort',
          () => stalledSource.destroy(new Error('Source stream aborted.')),
          { once: true }
        )
        return stalledSource as never
      }
    })
    await writeFile(sourcePath, content)

    const stagePromise = repository.stageLocalFile({
      transferId: 'local-transfer-stalled',
      sourcePath,
      name: 'slow-dataset.csv',
      mimeType: 'text/csv',
      size: content.byteLength
    })
    const stageRejection = expect(stagePromise).rejects.toThrow(/source stream aborted/i)
    await vi.waitFor(() => expect(sourceSignal).toBeDefined())

    await repository.abortTransfer({ transferId: 'local-transfer-stalled' })

    expect(sourceSignal?.aborted).toBe(true)
    await stageRejection
    await expect(
      stat(join(root, 'uploads', 'default-project', '.staging', 'local-transfer-stalled.part'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('stages uploaded files under the default project pending directory', async () => {
    const root = await createStorageRoot()
    const repository = new UploadRepository(root)

    const [attachment] = await stageUploadFixtures(repository, {
      files: [
        {
          name: 'paste.png',
          mimeType: 'image/png',
          content: Buffer.from('png-bytes').toString('base64')
        }
      ]
    })

    expect(attachment).toMatchObject({
      sessionId: PENDING_UPLOAD_SESSION_ID,
      name: 'paste.png',
      originalName: 'paste.png',
      mimeType: 'image/png',
      size: 'png-bytes'.length
    })
    expect(attachment.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    )
    expect(attachment.path).toBe(
      join(root, 'uploads', 'default-project', PENDING_UPLOAD_SESSION_ID, 'paste.png')
    )
    await expect(readFile(attachment.path, 'utf8')).resolves.toBe('png-bytes')
  })

  it('resolves a pending upload for send-time inspection', async () => {
    const root = await createStorageRoot()
    const client = createProjectDbClient(root)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project one' } })
    const repository = new UploadRepository(root, {
      getClient: () => Promise.resolve(client)
    })
    const [attachment] = await stageUploadFixtures(repository, {
      files: [
        {
          name: 'paper.pdf',
          mimeType: 'application/pdf',
          content: Buffer.from('pending-pdf').toString('base64')
        }
      ]
    })

    await expect(
      repository.resolveManagedUploadPath(
        { path: attachment.path },
        { projectId: 'project-1', sessionId: PENDING_UPLOAD_SESSION_ID }
      )
    ).resolves.toBe(await realpath(attachment.path))
    await expect(
      repository.resolveManagedUploadPath(
        { path: attachment.path },
        { projectId: 'project-1', sessionId: '.other-temporary-scope' }
      )
    ).rejects.toThrow('Invalid upload path segment')
  })

  it('removes unindexed pending drafts during restart recovery without touching finalized uploads', async () => {
    const root = await createStorageRoot()
    const beforeRestart = new UploadRepository(root)
    const [finalizedDraft, orphanedDraft] = await stageUploadFixtures(beforeRestart, {
      files: [
        { name: 'keep.txt', content: Buffer.from('keep').toString('base64') },
        { name: 'discard.txt', content: Buffer.from('discard').toString('base64') }
      ]
    })
    const [finalized] = await beforeRestart.finalizePendingSessionUploads('session-1', [
      finalizedDraft
    ])

    const afterRestart = new UploadRepository(root)
    await afterRestart.recoverStagingUploads()

    await expect(stat(orphanedDraft.path)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(finalized.path, 'utf8')).resolves.toBe('keep')
  })

  it('does not recreate a missing data root during startup recovery', async () => {
    const parent = await createStorageRoot()
    const missingRoot = join(parent, 'missing-data-root')
    const repository = new UploadRepository(missingRoot)

    await expect(stat(missingRoot)).rejects.toMatchObject({ code: 'ENOENT' })

    await repository.recoverStagingUploads()

    await expect(stat(missingRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('stages pathless files in bounded, offset-checked chunks', async () => {
    const root = await createStorageRoot()
    const repository = new UploadRepository(root)
    const content = Buffer.from('sample,value\na,1\nb,2\n')

    await repository.beginTransfer({
      transferId: 'chunk-transfer-1',
      name: 'dataset.csv',
      mimeType: 'text/csv',
      size: content.byteLength
    })
    await repository.appendTransfer({
      transferId: 'chunk-transfer-1',
      offset: 0,
      chunk: content.subarray(0, 10)
    })

    await expect(
      repository.appendTransfer({
        transferId: 'chunk-transfer-1',
        offset: 0,
        chunk: content.subarray(10)
      })
    ).rejects.toThrow(/offset/i)

    await repository.appendTransfer({
      transferId: 'chunk-transfer-1',
      offset: 10,
      chunk: content.subarray(10)
    })
    await expect(repository.getTransferStatus({ transferId: 'chunk-transfer-1' })).resolves.toEqual(
      {
        transferId: 'chunk-transfer-1',
        name: 'dataset.csv',
        receivedBytes: content.byteLength,
        totalBytes: content.byteLength
      }
    )

    const attachment = await repository.finishTransfer({ transferId: 'chunk-transfer-1' })

    await expect(readFile(attachment.path)).resolves.toEqual(content)
    await expect(
      repository.getTransferStatus({ transferId: 'chunk-transfer-1' })
    ).resolves.toBeNull()
  })

  it('aborts chunk transfers and clears crash-orphaned partial files', async () => {
    const root = await createStorageRoot()
    const stagingDir = join(root, 'uploads', 'default-project', '.staging')
    const stalePath = join(stagingDir, 'stale.part')
    await mkdir(stagingDir, { recursive: true })
    await writeFile(stalePath, 'orphan')
    const repository = new UploadRepository(root)

    await repository.beginTransfer({ transferId: 'cancel-me', name: 'data.csv', size: 2 })
    await expect(
      repository.appendTransfer({
        transferId: 'cancel-me',
        offset: 0,
        chunk: new Uint8Array()
      })
    ).rejects.toThrow(/must not be empty/i)
    await repository.abortTransfer({ transferId: 'cancel-me' })

    await expect(repository.getTransferStatus({ transferId: 'cancel-me' })).resolves.toBeNull()
    await expect(stat(join(stagingDir, 'cancel-me.part'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(stalePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects staging a file whose content exceeds the size limit', async () => {
    const root = await createStorageRoot()
    const repository = new UploadRepository(root, { maxFileBytes: 16 })
    const oversized = Buffer.alloc(17)

    await expect(
      stageUploadFixtures(repository, {
        files: [{ name: 'huge.bin', content: oversized.toString('base64') }]
      })
    ).rejects.toThrow(/16 B per-file limit/)
  })

  it('finalizes pending uploads into the real session directory without changing ids', async () => {
    const root = await createStorageRoot()
    const repository = new UploadRepository(root)
    const [attachment] = await stageUploadFixtures(repository, {
      files: [
        {
          name: 'notes.txt',
          mimeType: 'text/plain',
          content: Buffer.from('hello upload').toString('base64')
        }
      ]
    })

    const [finalized] = await repository.finalizePendingSessionUploads('session-1', [attachment])

    expect(finalized).toMatchObject({
      id: attachment.id,
      sessionId: 'session-1',
      name: 'notes.txt',
      mimeType: 'text/plain',
      size: 'hello upload'.length
    })
    expect(finalized.path).toBe(join(root, 'uploads', 'default-project', 'session-1', 'notes.txt'))
    await expect(readFile(finalized.path, 'utf8')).resolves.toBe('hello upload')
    await expect(stat(attachment.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps finalized uploads reusable for the same session', async () => {
    const root = await createStorageRoot()
    const repository = new UploadRepository(root)
    const [attachment] = await stageUploadFixtures(repository, {
      files: [
        {
          name: 'notes.txt',
          mimeType: 'text/plain',
          content: Buffer.from('hello upload').toString('base64')
        }
      ]
    })
    const [finalized] = await repository.finalizePendingSessionUploads('session-1', [attachment])

    const [again] = await repository.finalizePendingSessionUploads('session-1', [finalized])

    expect(again).toMatchObject({
      id: attachment.id,
      sessionId: 'session-1',
      name: 'notes.txt',
      path: finalized.path,
      size: 'hello upload'.length
    })
    await expect(readFile(again.path, 'utf8')).resolves.toBe('hello upload')
  })

  it('registers each upload as an independent SQLite file with immutable v1 bytes', async () => {
    const root = await createStorageRoot()
    const client = createProjectDbClient(root)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project one' } })
    const repository = new UploadRepository(root, {
      getClient: () => Promise.resolve(client)
    })
    const [first, second] = await stageUploadFixtures(repository, {
      files: [
        { name: 'data.csv', mimeType: 'text/csv', content: Buffer.from('a,1').toString('base64') },
        { name: 'data.csv', mimeType: 'text/csv', content: Buffer.from('a,2').toString('base64') }
      ]
    })

    const finalized = await repository.finalizePendingSessionUploads(
      'session-1',
      [first, second],
      'project-1'
    )

    expect(finalized[0]).toMatchObject({
      id: first.id,
      versionNumber: 1,
      checksum: '0fa951528f20c6c5de84056f96dce80c86e13b50daddfff3fba669f8b0d6ec9a'
    })
    expect(finalized[0].versionId).toMatch(/^[0-9a-f-]{36}$/u)
    expect(finalized[0].createdAt).toMatch(/Z$/u)
    expect(finalized[0].path).toBe(
      join(
        root,
        'uploads',
        'project-1',
        'session-1',
        first.id,
        'versions',
        finalized[0].versionId ?? '',
        'content'
      )
    )
    expect(finalized[1].id).toBe(second.id)
    expect(finalized[1].id).not.toBe(finalized[0].id)
    expect(finalized[1].versionId).not.toBe(finalized[0].versionId)

    await expect(
      repository.resolveSessionUploadPath(
        'session-1',
        { path: `upload-version:${finalized[0].versionId ?? ''}` },
        'project-1'
      )
    ).rejects.toThrow(/managed file lease/i)

    const files = await client.uploadFile.findMany({
      where: { projectId: 'project-1', sessionId: 'session-1' },
      include: { versions: true }
    })
    expect(files).toHaveLength(2)
    expect(files.every((file) => file.versions[0]?.state === 'ready')).toBe(true)
    expect(files.every((file) => file.versions[0]?.versionNumber === 1)).toBe(true)
    expect(files.every((file) => file.currentVersionId === file.versions[0]?.id)).toBe(true)

    const [again] = await repository.finalizePendingSessionUploads(
      'session-1',
      [finalized[0]],
      'project-1'
    )
    expect(again.versionId).toBe(finalized[0].versionId)
    await expect(client.uploadVersion.count({ where: { uploadFileId: first.id } })).resolves.toBe(1)
  })

  it('resolves same-content uploads independently by their owning Session without a Project hint', async () => {
    const root = await createStorageRoot()
    const client = createProjectDbClient(root)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project one' } })
    const repository = new UploadRepository(root, {
      getClient: () => Promise.resolve(client)
    })
    const content = Buffer.from('sample,value\na,1\n')
    const [firstPending] = await stageUploadFixtures(repository, {
      files: [{ name: 'dataset.csv', mimeType: 'text/csv', content: content.toString('base64') }]
    })
    const [first] = await repository.finalizePendingSessionUploads(
      'session-1',
      [firstPending],
      'project-1'
    )
    const [secondPending] = await stageUploadFixtures(repository, {
      files: [{ name: 'dataset.csv', mimeType: 'text/csv', content: content.toString('base64') }]
    })
    const [second] = await repository.finalizePendingSessionUploads(
      'session-2',
      [secondPending],
      'project-1'
    )

    expect(second.id).not.toBe(first.id)
    expect(second.versionId).not.toBe(first.versionId)
    expect(second.checksum).toBe(first.checksum)
    await expect(
      repository.resolveSessionUploadPath('session-2', { path: second.path })
    ).resolves.toBe(await realpath(second.path))
    await expect(
      repository.resolveSessionUploadPath('session-1', { path: second.path })
    ).rejects.toThrow(/different (?:project or )?session/i)
  })

  it('recovers a staging Upload Version from pending bytes before startup draft cleanup', async () => {
    const root = await createStorageRoot()
    const client = createProjectDbClient(root)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project one' } })
    const repository = new UploadRepository(root, { getClient: () => Promise.resolve(client) })
    const [pending] = await stageUploadFixtures(repository, {
      files: [
        {
          name: 'recover.csv',
          mimeType: 'text/csv',
          content: Buffer.from('sample,value\na,1\n').toString('base64')
        }
      ]
    })
    const versionId = 'upload-version-recovery-1'
    const checksum = '5fe3f7b7e3492c63599954312dcb1e1d78488782753b6d3068c8d03292c7c1f6'
    const storageKey = [
      'uploads',
      'project-1',
      'session-1',
      pending.id,
      'versions',
      versionId,
      'content'
    ].join('/')
    await client.fileOriginSession.create({
      data: { projectId: 'project-1', sessionId: 'session-1' }
    })
    await client.uploadFile.create({
      data: {
        id: pending.id,
        projectId: 'project-1',
        sessionId: 'session-1',
        filename: pending.name,
        originalFilename: pending.originalName,
        versions: {
          create: {
            id: versionId,
            versionNumber: 1,
            state: 'staging',
            contentStorageKey: storageKey,
            filename: pending.name,
            originalFilename: pending.originalName,
            contentType: pending.mimeType,
            sizeBytes: BigInt(pending.size),
            checksum,
            createdAt: new Date('2026-07-27T12:00:00.000Z')
          }
        }
      }
    })

    await repository.recoverStagingUploads()

    await expect(
      client.uploadVersion.findUniqueOrThrow({ where: { id: versionId } })
    ).resolves.toMatchObject({ state: 'ready' })
    await expect(
      client.uploadFile.findUniqueOrThrow({ where: { id: pending.id } })
    ).resolves.toMatchObject({ currentVersionId: versionId })
    await expect(
      client.managedFile.findUniqueOrThrow({
        where: {
          projectId_source_sourceFileId: {
            projectId: 'project-1',
            source: 'upload',
            sourceFileId: pending.id
          }
        }
      })
    ).resolves.toMatchObject({ sourceVersionId: versionId, storageKey })
    await expect(readFile(join(root, ...storageKey.split('/')), 'utf8')).resolves.toBe(
      'sample,value\na,1\n'
    )
    await expect(stat(pending.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('recovers a post-rename staging Upload Version during startup reconciliation', async () => {
    const root = await createStorageRoot()
    const client = createProjectDbClient(root)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project one' } })
    const repository = new UploadRepository(root, { getClient: () => Promise.resolve(client) })
    const content = Buffer.from('already renamed')
    const versionId = 'upload-version-post-rename'
    const storageKey = [
      'uploads',
      'project-1',
      'session-1',
      'upload-post-rename',
      'versions',
      versionId,
      'content'
    ].join('/')
    const finalPath = join(root, ...storageKey.split('/'))
    const legacyPath = join(root, 'uploads', 'default-project', 'session-1', 'renamed.txt')
    await mkdir(dirname(legacyPath), { recursive: true })
    await mkdir(dirname(finalPath), { recursive: true })
    await writeFile(legacyPath, content)
    await rename(legacyPath, finalPath)
    await client.fileOriginSession.create({
      data: { projectId: 'project-1', sessionId: 'session-1' }
    })
    await client.uploadFile.create({
      data: {
        id: 'upload-post-rename',
        projectId: 'project-1',
        sessionId: 'session-1',
        filename: 'renamed.txt',
        originalFilename: 'renamed.txt',
        versions: {
          create: {
            id: versionId,
            versionNumber: 1,
            state: 'staging',
            contentStorageKey: storageKey,
            filename: 'renamed.txt',
            originalFilename: 'renamed.txt',
            contentType: 'text/plain',
            sizeBytes: BigInt(content.byteLength),
            checksum: 'b8fb24fd80ab4f7629f7322c583aaa3429c0d7e06fc36d501ad3184a5ee76fe1'
          }
        }
      }
    })
    const newerContent = Buffer.from('newer ready version')
    const newerVersionId = 'upload-version-newer-ready'
    const newerStorageKey = [
      'uploads',
      'project-1',
      'session-1',
      'upload-post-rename',
      'versions',
      newerVersionId,
      'content'
    ].join('/')
    const newerPath = join(root, ...newerStorageKey.split('/'))
    await mkdir(dirname(newerPath), { recursive: true })
    await writeFile(newerPath, newerContent)
    await client.uploadVersion.create({
      data: {
        id: newerVersionId,
        uploadFileId: 'upload-post-rename',
        versionNumber: 2,
        state: 'ready',
        originKind: 'legacy',
        contentStorageKey: newerStorageKey,
        filename: 'renamed.txt',
        originalFilename: 'renamed.txt',
        contentType: 'text/plain',
        sizeBytes: BigInt(newerContent.byteLength),
        checksum: createHash('sha256').update(newerContent).digest('hex')
      }
    })
    await client.uploadFile.update({
      where: { id: 'upload-post-rename' },
      data: { currentVersionId: newerVersionId }
    })

    await repository.recoverStagingUploads()

    await expect(readFile(legacyPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(finalPath)).resolves.toEqual(content)
    await expect(
      client.uploadVersion.findUniqueOrThrow({ where: { id: versionId } })
    ).resolves.toMatchObject({ state: 'ready' })
    await expect(
      client.managedFile.findUniqueOrThrow({
        where: {
          projectId_source_sourceFileId: {
            projectId: 'project-1',
            source: 'upload',
            sourceFileId: 'upload-post-rename'
          }
        }
      })
    ).resolves.toMatchObject({ sourceVersionId: newerVersionId, storageKey: newerStorageKey })
    await expect(
      client.uploadFile.findUniqueOrThrow({ where: { id: 'upload-post-rename' } })
    ).resolves.toMatchObject({ currentVersionId: newerVersionId })
  })

  it('recovers and removes a deterministic live-copy temp left before its final rename', async () => {
    const root = await createStorageRoot()
    const client = createProjectDbClient(root)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project one' } })
    const repository = new UploadRepository(root, { getClient: () => Promise.resolve(client) })
    const content = Buffer.from('copied before crash')
    const checksum = createHash('sha256').update(content).digest('hex')
    const versionId = 'upload-version-live-copy-crash'
    const storageKey = [
      'uploads',
      'project-1',
      'session-1',
      'upload-live-copy-crash',
      'versions',
      versionId,
      'content'
    ].join('/')
    const finalPath = join(root, ...storageKey.split('/'))
    const temporaryPath = `${finalPath}.live-copy.tmp`
    const legacyPath = join(root, 'uploads', 'default-project', 'session-1', 'legacy.txt')
    await mkdir(dirname(finalPath), { recursive: true })
    await mkdir(dirname(legacyPath), { recursive: true })
    await writeFile(temporaryPath, content)
    await writeFile(legacyPath, content)
    await client.fileOriginSession.create({
      data: { projectId: 'project-1', sessionId: 'session-1' }
    })
    await client.uploadFile.create({
      data: {
        id: 'upload-live-copy-crash',
        projectId: 'project-1',
        sessionId: 'session-1',
        filename: 'legacy.txt',
        originalFilename: 'legacy.txt',
        versions: {
          create: {
            id: versionId,
            versionNumber: 1,
            state: 'staging',
            contentStorageKey: storageKey,
            filename: 'legacy.txt',
            originalFilename: 'legacy.txt',
            contentType: 'text/plain',
            sizeBytes: BigInt(content.byteLength),
            checksum
          }
        }
      }
    })

    await repository.recoverStagingUploads()

    await expect(readFile(finalPath)).resolves.toEqual(content)
    await expect(readFile(temporaryPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(legacyPath)).resolves.toEqual(content)
    await expect(
      client.uploadVersion.findUniqueOrThrow({ where: { id: versionId } })
    ).resolves.toMatchObject({ state: 'ready' })
  })

  it('upgrades a legacy session upload before writing a path-free Session projection', async () => {
    const root = await createStorageRoot()
    const client = createProjectDbClient(root)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project one' } })
    const repository = new UploadRepository(root, { getClient: () => Promise.resolve(client) })
    const legacyPath = join(root, 'uploads', 'default-project', 'session-1', 'legacy.csv')
    await mkdir(dirname(legacyPath), { recursive: true })
    await writeFile(legacyPath, 'sample,value\na,1\n')
    const session: PersistedChatSession = {
      id: 'session-1',
      projectId: 'project-1',
      title: 'Legacy upload',
      cwd: '/workspace',
      status: 'idle',
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'Inspect this',
          status: 'complete',
          eventIds: [],
          uploads: [
            {
              id: 'legacy-upload-1',
              sessionId: 'session-1',
              name: 'legacy.csv',
              originalName: 'legacy.csv',
              path: legacyPath,
              mimeType: 'text/csv',
              size: 17
            }
          ],
          createdAt: 1,
          updatedAt: 1
        }
      ],
      createdAt: 1,
      updatedAt: 1
    }

    const upgraded = await repository.upgradeLegacySessionUploads(session)
    const upload = upgraded.messages[0].uploads?.[0]

    expect(upload).toMatchObject({
      id: 'legacy-upload-1',
      versionNumber: 1,
      sha256: '5fe3f7b7e3492c63599954312dcb1e1d78488782753b6d3068c8d03292c7c1f6'
    })
    const versionId = upload?.versionId
    expect(versionId).toMatch(/^[0-9a-f-]{36}$/u)
    if (!versionId) throw new Error('Legacy upload upgrade did not create a Version identity.')
    expect(upload).not.toHaveProperty('path')
    expect(upload).not.toHaveProperty('createdAt')
    await expect(readFile(legacyPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    const version = await client.uploadVersion.findUniqueOrThrow({
      where: { id: versionId }
    })
    expect(version).toMatchObject({ state: 'ready', createdAt: null })

    await expect(readFile(join(root, version.contentStorageKey), 'utf8')).resolves.toBe(
      'sample,value\na,1\n'
    )

    // A crash before Session JSON persistence leaves the original path-only projection on disk.
    // Retrying it must recover from the already-ready Version without recreating legacy bytes.
    const retried = await repository.upgradeLegacySessionUploads(session)
    expect(retried.messages[0].uploads?.[0]?.versionId).toBe(versionId)
    await expect(
      client.uploadVersion.count({ where: { uploadFileId: 'legacy-upload-1' } })
    ).resolves.toBe(1)
    await expect(readFile(legacyPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves the live legacy source until a later reconciliation observes the path-free projection', async () => {
    const root = await createStorageRoot()
    const client = createProjectDbClient(root)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project one' } })
    const repository = new UploadRepository(root, { getClient: () => Promise.resolve(client) })
    const content = 'sample,value\na,1\n'
    const legacyPath = join(root, 'uploads', 'default-project', 'session-1', 'legacy.csv')
    await mkdir(dirname(legacyPath), { recursive: true })
    await writeFile(legacyPath, content)
    const session: PersistedChatSession = {
      id: 'session-1',
      projectId: 'project-1',
      title: 'Live legacy upload',
      cwd: '/workspace',
      status: 'idle',
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'Inspect this',
          status: 'complete',
          eventIds: [],
          uploads: [
            {
              id: 'legacy-upload-live',
              sessionId: 'session-1',
              name: 'legacy.csv',
              originalName: 'legacy.csv',
              path: legacyPath,
              mimeType: 'text/csv',
              size: Buffer.byteLength(content)
            }
          ],
          createdAt: 1,
          updatedAt: 1
        }
      ],
      createdAt: 1,
      updatedAt: 1
    }

    const durable = await repository.upgradeLegacySessionUploads(session, { mode: 'live-save' })
    const versionId = durable.messages[0].uploads?.[0]?.versionId

    expect(versionId).toBeTruthy()
    expect(durable.messages[0].uploads?.[0]).not.toHaveProperty('path')
    await expect(readFile(legacyPath, 'utf8')).resolves.toBe(content)
    const durableVersion = await client.uploadVersion.findUniqueOrThrow({
      where: { id: versionId! },
      select: { contentStorageKey: true }
    })
    await expect(readFile(join(root, durableVersion.contentStorageKey), 'utf8')).resolves.toBe(
      content
    )

    await repository.upgradeLegacySessionUploads(durable)

    await expect(readFile(legacyPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retains orphan bytes without authority but drops a positively absent legacy reference', async () => {
    const root = await createStorageRoot()
    const client = createProjectDbClient(root)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project one' } })
    const repository = new UploadRepository(root, { getClient: () => Promise.resolve(client) })
    const content = 'sample,value\na,1\n'
    const legacyPath = join(root, 'uploads', 'default-project', 'session-1', 'legacy.csv')
    await mkdir(dirname(legacyPath), { recursive: true })
    await writeFile(legacyPath, content)
    const session: PersistedChatSession = {
      id: 'session-1',
      projectId: 'project-1',
      title: 'Orphaned legacy upload',
      cwd: '/workspace',
      status: 'idle',
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'Inspect this',
          status: 'complete',
          eventIds: [],
          uploads: [
            {
              id: 'missing-upload-authority',
              sessionId: 'session-1',
              name: 'legacy.csv',
              originalName: 'legacy.csv',
              path: legacyPath,
              mimeType: 'text/csv',
              size: Buffer.byteLength(content)
            }
          ],
          createdAt: 1,
          updatedAt: 1
        }
      ],
      createdAt: 1,
      updatedAt: 1
    }

    await expect(
      repository.upgradeLegacySessionUploads(session, { mode: 'orphan-recovery' })
    ).rejects.toThrow(/legacy Upload authority is unavailable/i)

    await expect(readFile(legacyPath, 'utf8')).resolves.toBe(content)
    await expect(
      client.uploadFile.findUnique({ where: { id: 'missing-upload-authority' } })
    ).resolves.toBeNull()
    await expect(client.uploadVersion.count()).resolves.toBe(0)
    await expect(client.managedFile.count()).resolves.toBe(0)

    await rm(legacyPath)
    const versionsRoot = join(
      root,
      'uploads',
      'project-1',
      'session-1',
      'missing-upload-authority',
      'versions'
    )
    const externalEmptyDir = join(root, 'external-empty')
    await mkdir(dirname(versionsRoot), { recursive: true })
    await mkdir(externalEmptyDir)
    await symlink(externalEmptyDir, versionsRoot)
    await expect(
      repository.upgradeLegacySessionUploads(session, { mode: 'orphan-recovery' })
    ).rejects.toThrow(/legacy Upload authority is unavailable/i)
    await rm(versionsRoot)

    const liveCopyPath = join(versionsRoot, 'unknown-version', 'content.live-copy.tmp')
    await mkdir(dirname(liveCopyPath), { recursive: true })
    await writeFile(liveCopyPath, content)
    await expect(
      repository.upgradeLegacySessionUploads(session, { mode: 'orphan-recovery' })
    ).rejects.toThrow(/legacy Upload authority is unavailable/i)
    await rm(liveCopyPath)

    const cleaned = await repository.upgradeLegacySessionUploads(session, {
      mode: 'orphan-recovery'
    })

    expect(cleaned.messages[0].uploads).toEqual([])
    await expect(
      client.uploadFile.findUnique({ where: { id: 'missing-upload-authority' } })
    ).resolves.toBeNull()
  })

  it('rejects conflicting orphan locators before a cached absence can drop graph bytes', async () => {
    const root = await createStorageRoot()
    const client = createProjectDbClient(root)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project one' } })
    const repository = new UploadRepository(root, { getClient: () => Promise.resolve(client) })
    const uploadId = 'conflicting-orphan-upload'
    const absentPath = join(root, 'uploads', 'default-project', 'session-1', 'absent.csv')
    const presentPath = join(root, 'uploads', 'default-project', 'session-1', 'present.csv')
    const presentContent = Buffer.from('present graph bytes')
    await mkdir(dirname(presentPath), { recursive: true })
    await writeFile(presentPath, presentContent)
    const primaryUpload: PersistedUploadedAttachment = {
      id: uploadId,
      sessionId: 'session-1',
      name: 'absent.csv',
      originalName: 'absent.csv',
      path: absentPath,
      mimeType: 'text/csv',
      size: presentContent.byteLength
    }
    const graphUpload: PersistedUploadedAttachment = {
      ...primaryUpload,
      name: 'present.csv',
      originalName: 'present.csv',
      path: presentPath
    }
    const session = createSessionWithGraphUpload(primaryUpload, graphUpload)

    let rejection: unknown
    try {
      await repository.upgradeLegacySessionUploads(session, { mode: 'orphan-recovery' })
    } catch (error) {
      rejection = error
    }

    expect(rejection).toBeInstanceOf(Error)
    expect(rejection).not.toBeInstanceOf(OrphanLegacyUploadAuthorityMissingError)
    expect((rejection as Error).message).toMatch(/conflicting immutable identity/i)
    expect(session.messages[0].uploads?.[0]?.path).toBe(absentPath)
    expect(session.conversationGraph?.messages[0].uploads?.[0]?.path).toBe(presentPath)
    await expect(readFile(presentPath)).resolves.toEqual(presentContent)
    await expect(readFile(absentPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(client.uploadFile.count()).resolves.toBe(0)
    await expect(client.uploadVersion.count()).resolves.toBe(0)
    await expect(client.managedFile.count()).resolves.toBe(0)
    await expect(client.managedFileSessionSync.count()).resolves.toBe(0)
    await expect(client.fileOriginSession.count()).resolves.toBe(0)
  })

  it('rejects conflicting authoritative locators before publishing or rewriting either reference', async () => {
    const root = await createStorageRoot()
    const client = createProjectDbClient(root)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project one' } })
    const repository = new UploadRepository(root, { getClient: () => Promise.resolve(client) })
    const uploadId = 'conflicting-existing-upload'
    const versionId = 'conflicting-existing-version'
    const firstContent = Buffer.from('first locator bytes')
    const secondContent = Buffer.from('second locator bytes')
    const checksum = createHash('sha256').update(firstContent).digest('hex')
    const firstPath = join(root, 'uploads', 'default-project', 'session-1', 'first.csv')
    const secondPath = join(root, 'uploads', 'default-project', 'session-1', 'second.csv')
    const contentStorageKey = [
      'uploads',
      'project-1',
      'session-1',
      uploadId,
      'versions',
      versionId,
      'content'
    ].join('/')
    const finalPath = join(root, ...contentStorageKey.split('/'))
    await mkdir(dirname(firstPath), { recursive: true })
    await writeFile(firstPath, firstContent)
    await writeFile(secondPath, secondContent)
    await client.fileOriginSession.create({
      data: { projectId: 'project-1', sessionId: 'session-1' }
    })
    await client.uploadFile.create({
      data: {
        id: uploadId,
        projectId: 'project-1',
        sessionId: 'session-1',
        filename: 'first.csv',
        originalFilename: 'first.csv',
        versions: {
          create: {
            id: versionId,
            versionNumber: 1,
            state: 'staging',
            contentStorageKey,
            filename: 'first.csv',
            originalFilename: 'first.csv',
            contentType: 'text/csv',
            sizeBytes: BigInt(firstContent.byteLength),
            checksum
          }
        }
      }
    })
    const primaryUpload: PersistedUploadedAttachment = {
      id: uploadId,
      sessionId: 'session-1',
      name: 'first.csv',
      originalName: 'first.csv',
      path: firstPath,
      mimeType: 'text/csv',
      size: firstContent.byteLength
    }
    const graphUpload: PersistedUploadedAttachment = {
      ...primaryUpload,
      name: 'second.csv',
      originalName: 'second.csv',
      path: secondPath,
      size: secondContent.byteLength
    }
    const session = createSessionWithGraphUpload(primaryUpload, graphUpload)

    let rejection: unknown
    try {
      await repository.upgradeLegacySessionUploads(session, { mode: 'orphan-recovery' })
    } catch (error) {
      rejection = error
    }

    expect(rejection).toBeInstanceOf(Error)
    expect(rejection).not.toBeInstanceOf(OrphanLegacyUploadAuthorityMissingError)
    expect((rejection as Error).message).toMatch(/conflicting immutable identity/i)
    expect(session.messages[0].uploads?.[0]?.path).toBe(firstPath)
    expect(session.conversationGraph?.messages[0].uploads?.[0]?.path).toBe(secondPath)
    await expect(readFile(firstPath)).resolves.toEqual(firstContent)
    await expect(readFile(secondPath)).resolves.toEqual(secondContent)
    await expect(readFile(finalPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      client.uploadVersion.findUniqueOrThrow({ where: { id: versionId } })
    ).resolves.toMatchObject({ state: 'staging' })
    await expect(client.uploadFile.count()).resolves.toBe(1)
    await expect(client.uploadVersion.count()).resolves.toBe(1)
    await expect(client.managedFile.count()).resolves.toBe(0)
    await expect(client.managedFileSessionSync.count()).resolves.toBe(0)
    await expect(client.fileOriginSession.count()).resolves.toBe(1)
  })

  it('restores missing ready content only from a checksum-verified legacy copy', async () => {
    const root = await createStorageRoot()
    const client = createProjectDbClient(root)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project one' } })
    const repository = new UploadRepository(root, { getClient: () => Promise.resolve(client) })
    const content = Buffer.from('sample,value\na,1\n')
    const checksum = createHash('sha256').update(content).digest('hex')
    const checksumMismatch = Buffer.alloc(content.byteLength, 'x')
    const uploadId = 'legacy-upload-ready'
    const versionId = 'legacy-ready-version-1'
    const filename = 'legacy.csv'
    const contentStorageKey = [
      'uploads',
      'project-1',
      'session-1',
      uploadId,
      'versions',
      versionId,
      'content'
    ].join('/')
    const finalPath = join(root, ...contentStorageKey.split('/'))
    const legacyPath = join(root, 'uploads', 'default-project', 'session-1', filename)
    await mkdir(dirname(legacyPath), { recursive: true })
    await writeFile(legacyPath, checksumMismatch)
    await client.fileOriginSession.create({
      data: { projectId: 'project-1', sessionId: 'session-1' }
    })
    await client.uploadFile.create({
      data: {
        id: uploadId,
        projectId: 'project-1',
        sessionId: 'session-1',
        filename,
        originalFilename: filename,
        versions: {
          create: {
            id: versionId,
            versionNumber: 1,
            state: 'ready',
            contentStorageKey,
            filename,
            originalFilename: filename,
            contentType: 'text/csv',
            sizeBytes: BigInt(content.byteLength),
            checksum
          }
        }
      }
    })
    const session: PersistedChatSession = {
      id: 'session-1',
      projectId: 'project-1',
      title: 'Legacy ready upload',
      cwd: '/workspace',
      status: 'idle',
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'Inspect this',
          status: 'complete',
          eventIds: [],
          uploads: [
            {
              id: uploadId,
              versionId,
              versionNumber: 1,
              sessionId: 'session-1',
              name: filename,
              originalName: filename,
              mimeType: 'text/csv',
              size: content.byteLength,
              checksum,
              sha256: checksum
            }
          ],
          createdAt: 1,
          updatedAt: 1
        }
      ],
      createdAt: 1,
      updatedAt: 1
    }
    const cleanupInput = {
      projectId: 'project-1',
      sessionId: 'session-1',
      uploadFileId: uploadId,
      versionId,
      filename
    }
    const hardLinkUnavailable = vi.fn(async () => {
      throw Object.assign(new Error('Hard links are unavailable.'), { code: 'EPERM' })
    })
    const publishReadyContentNoReplace = async (
      _rootPath: string,
      parentPath: string,
      sourceName: string,
      destinationName: string
    ): Promise<void> => {
      const sourcePath = join(parentPath, sourceName)
      await copyFile(sourcePath, join(parentPath, destinationName), constants.COPYFILE_EXCL)
      await rm(sourcePath)
    }
    const fallbackCleanupOwner = new VerifiedLegacyCleanupOwner(
      root,
      {
        getClient: () => Promise.resolve(client),
        linkReadyContent: hardLinkUnavailable,
        publishReadyContentNoReplace
      },
      {
        resolveManagedUploadPath: (...args) => repository.resolveManagedUploadPath(...args)
      }
    )

    await expect(
      repository.upgradeLegacySessionUploads(session, { mode: 'reconcile' })
    ).resolves.toMatchObject({ messages: [{ uploads: [{ versionId }] }] })
    await expect(readFile(finalPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(legacyPath)).resolves.toEqual(checksumMismatch)

    await writeFile(legacyPath, content)
    const unsupportedPublicationOwner = new VerifiedLegacyCleanupOwner(
      root,
      {
        getClient: () => Promise.resolve(client),
        linkReadyContent: async () => {
          throw Object.assign(new Error('Hard links are unavailable.'), { code: 'EPERM' })
        },
        publishReadyContentNoReplace: () => {
          throw Object.assign(new Error('Atomic publication is unavailable.'), {
            code: 'ENOTSUP'
          })
        }
      },
      {
        resolveManagedUploadPath: (...args) => repository.resolveManagedUploadPath(...args)
      }
    )
    await expect(
      unsupportedPublicationOwner.removeVerifiedLegacyCopy(cleanupInput)
    ).resolves.toEqual({
      status: 'unsafe-residual',
      reason: 'atomic no-replace publication is unavailable on the storage filesystem'
    })
    await expect(readFile(finalPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(legacyPath)).resolves.toEqual(content)

    const staleRecoveryTemporaryPath = `${finalPath}.legacy-recovery.copy.00000000-0000-4000-8000-000000000001.tmp`
    const freshRecoveryTemporaryPath = `${finalPath}.legacy-recovery.copy.00000000-0000-4000-8000-000000000002.tmp`
    await mkdir(dirname(finalPath), { recursive: true })
    await writeFile(staleRecoveryTemporaryPath, content.subarray(0, 1))
    await writeFile(freshRecoveryTemporaryPath, content.subarray(0, 2))
    const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1_000)
    await utimes(staleRecoveryTemporaryPath, staleTime, staleTime)
    await expect(fallbackCleanupOwner.removeVerifiedLegacyCopy(cleanupInput)).resolves.toEqual({
      status: 'removed'
    })
    expect(hardLinkUnavailable).toHaveBeenCalledOnce()
    await expect(readFile(finalPath)).resolves.toEqual(content)
    await expect(readFile(legacyPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(staleRecoveryTemporaryPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(freshRecoveryTemporaryPath)).resolves.toEqual(content.subarray(0, 2))
    await rm(freshRecoveryTemporaryPath)

    await expect(
      repository.upgradeLegacySessionUploads(session, { mode: 'reconcile' })
    ).resolves.toMatchObject({ messages: [{ uploads: [{ versionId }] }] })
    await expect(readFile(finalPath)).resolves.toEqual(content)

    await rm(finalPath)
    await writeFile(legacyPath, content)
    const racedContent = Buffer.alloc(content.byteLength, 'y')
    const inPlaceRaceRepository = new UploadRepository(root, {
      getClient: () => Promise.resolve(client),
      renameLegacyForCleanup: async (source, destination) => {
        await writeFile(source, racedContent)
        await rename(source, destination)
      }
    })
    await expect(
      inPlaceRaceRepository.upgradeLegacySessionUploads(session, { mode: 'reconcile' })
    ).resolves.toMatchObject({ messages: [{ uploads: [{ versionId }] }] })
    await expect(readFile(finalPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(legacyPath)).resolves.toEqual(racedContent)

    await writeFile(legacyPath, content)
    const finalRaceContent = Buffer.alloc(content.byteLength, 'z')
    const finalRaceCleanupOwner = new VerifiedLegacyCleanupOwner(
      root,
      {
        getClient: () => Promise.resolve(client),
        linkReadyContent: hardLinkUnavailable,
        publishReadyContentNoReplace,
        copyReadyContent: async (source, destination, mode) => {
          await copyFile(source, destination, mode)
          await writeFile(finalPath, finalRaceContent)
        }
      },
      {
        resolveManagedUploadPath: (...args) => repository.resolveManagedUploadPath(...args)
      }
    )
    await expect(finalRaceCleanupOwner.removeVerifiedLegacyCopy(cleanupInput)).resolves.toEqual({
      status: 'unsafe-residual',
      reason: 'the deterministic legacy path changed while restoring Version content'
    })
    await expect(readFile(finalPath)).resolves.toEqual(finalRaceContent)
    await expect(readFile(legacyPath)).resolves.toEqual(content)
    await rm(finalPath)

    const finalParent = dirname(finalPath)
    const outsideFinalParent = join(root, 'outside-ready-version')
    await rm(finalParent, { recursive: true, force: true })
    await mkdir(outsideFinalParent)
    await symlink(
      outsideFinalParent,
      finalParent,
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    await writeFile(legacyPath, content)
    await expect(fallbackCleanupOwner.removeVerifiedLegacyCopy(cleanupInput)).resolves.toEqual({
      status: 'unsafe-residual',
      reason: 'the ready Version content parent contains a symbolic link or escapes storage'
    })
    await expect(readFile(finalPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(legacyPath)).resolves.toEqual(content)
    expect(hardLinkUnavailable).toHaveBeenCalledTimes(2)
    await expect(readFile(join(outsideFinalParent, 'content'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await expect(stat(outsideFinalParent)).resolves.toMatchObject({})
    await rm(finalParent)

    const movedFinalParent = join(root, 'moved-ready-version')
    const raceCleanupOwner = new VerifiedLegacyCleanupOwner(
      root,
      {
        getClient: () => Promise.resolve(client),
        linkReadyContent: hardLinkUnavailable,
        publishReadyContentNoReplace,
        copyReadyContent: async (source, destination, mode) => {
          await copyFile(source, destination, mode)
          const destinationName = basename(String(destination))
          await rename(finalParent, movedFinalParent)
          await symlink(
            outsideFinalParent,
            finalParent,
            process.platform === 'win32' ? 'junction' : 'dir'
          )
          await copyFile(
            join(movedFinalParent, destinationName),
            join(outsideFinalParent, destinationName)
          )
        }
      },
      {
        resolveManagedUploadPath: (...args) => repository.resolveManagedUploadPath(...args)
      }
    )
    await expect(raceCleanupOwner.removeVerifiedLegacyCopy(cleanupInput)).resolves.toEqual({
      status: 'unsafe-residual',
      reason: 'the ready Version content parent changed before publication'
    })
    await expect(readFile(join(outsideFinalParent, 'content'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await expect(readFile(legacyPath)).resolves.toEqual(content)
    expect(hardLinkUnavailable).toHaveBeenCalledTimes(3)
    await rm(finalParent)
    await rm(movedFinalParent, { recursive: true, force: true })
  })

  it('removes a verified legacy copy when reusing an existing ready Upload Version', async () => {
    const root = await createStorageRoot()
    const client = createProjectDbClient(root)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project one' } })
    const repository = new UploadRepository(root, { getClient: () => Promise.resolve(client) })
    const content = Buffer.from('sample,value\na,1\n')
    const checksum = '5fe3f7b7e3492c63599954312dcb1e1d78488782753b6d3068c8d03292c7c1f6'
    const versionId = 'legacy-ready-version-1'
    const contentStorageKey = [
      'uploads',
      'project-1',
      'session-1',
      'legacy-upload-ready',
      'versions',
      versionId,
      'content'
    ].join('/')
    const finalPath = join(root, ...contentStorageKey.split('/'))
    const legacyPath = join(root, 'uploads', 'default-project', 'session-1', 'legacy.csv')
    const cleanupPrivateDir = `${legacyPath}.legacy-cleanup.private`
    const cleanupPrivatePath = join(cleanupPrivateDir, 'candidate')
    const unrelatedPath = join(root, 'uploads', 'default-project', 'session-1', 'other.csv')
    await mkdir(dirname(finalPath), { recursive: true })
    await mkdir(dirname(legacyPath), { recursive: true })
    await writeFile(finalPath, content)
    await writeFile(legacyPath, content)
    await writeFile(unrelatedPath, content)
    await client.fileOriginSession.create({
      data: { projectId: 'project-1', sessionId: 'session-1' }
    })
    await client.uploadFile.create({
      data: {
        id: 'legacy-upload-ready',
        projectId: 'project-1',
        sessionId: 'session-1',
        filename: 'legacy.csv',
        originalFilename: 'legacy.csv',
        versions: {
          create: {
            id: versionId,
            versionNumber: 1,
            state: 'ready',
            contentStorageKey,
            filename: 'legacy.csv',
            originalFilename: 'legacy.csv',
            contentType: 'text/csv',
            sizeBytes: BigInt(content.byteLength),
            checksum
          }
        }
      }
    })
    const session: PersistedChatSession = {
      id: 'session-1',
      projectId: 'project-1',
      title: 'Legacy ready upload',
      cwd: '/workspace',
      status: 'idle',
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'Inspect this',
          status: 'complete',
          eventIds: [],
          uploads: [
            {
              id: 'legacy-upload-ready',
              sessionId: 'session-1',
              name: 'legacy.csv',
              originalName: 'legacy.csv',
              path: legacyPath,
              mimeType: 'text/csv',
              size: content.byteLength
            }
          ],
          createdAt: 1,
          updatedAt: 1
        }
      ],
      createdAt: 1,
      updatedAt: 1
    }

    const upgraded = await repository.upgradeLegacySessionUploads(session)

    expect(upgraded.messages[0].uploads?.[0]?.versionId).toBe(versionId)
    await expect(
      client.uploadVersion.count({ where: { uploadFileId: 'legacy-upload-ready' } })
    ).resolves.toBe(1)
    await expect(readFile(legacyPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(finalPath)).resolves.toEqual(content)
    await expect(readFile(unrelatedPath)).resolves.toEqual(content)

    await writeFile(legacyPath, content)
    const reconciled = await repository.upgradeLegacySessionUploads(upgraded)
    expect(reconciled.messages[0].uploads?.[0]?.versionId).toBe(versionId)
    await expect(readFile(legacyPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(finalPath)).resolves.toEqual(content)

    await expect(repository.upgradeLegacySessionUploads(reconciled)).resolves.toMatchObject({
      messages: [{ uploads: [{ versionId }] }]
    })
    await expect(readFile(unrelatedPath)).resolves.toEqual(content)

    const replacement = Buffer.from('different bytes at the historical path')
    await writeFile(legacyPath, replacement)
    await expect(repository.upgradeLegacySessionUploads(reconciled)).resolves.toMatchObject({
      messages: [{ uploads: [{ versionId }] }]
    })
    await expect(readFile(legacyPath)).resolves.toEqual(replacement)
    await expect(readFile(finalPath)).resolves.toEqual(content)
    await expect(
      repository.upgradeLegacySessionUploads(reconciled, { mode: 'terminal-delete' })
    ).rejects.toBeInstanceOf(UnsafeLegacyUploadResidualError)
    await expect(readFile(legacyPath)).resolves.toEqual(replacement)

    await writeFile(legacyPath, content)
    const disappearingSourceRepository = new UploadRepository(root, {
      getClient: () => Promise.resolve(client),
      getLegacyFileChecksum: async (path) => {
        await rm(path, { force: true })
        throw Object.assign(new Error('Legacy source disappeared during verification.'), {
          code: 'ENOENT'
        })
      }
    })
    await expect(
      disappearingSourceRepository.upgradeLegacySessionUploads(reconciled)
    ).resolves.toMatchObject({ messages: [{ uploads: [{ versionId }] }] })
    await expect(readFile(legacyPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(finalPath)).resolves.toEqual(content)

    await writeFile(legacyPath, content)
    const displacedLegacyPath = `${legacyPath}.verified-before-race`
    const renameRaceReplacement = Buffer.from('replacement installed after legacy verification')
    const renameRaceRepository = new UploadRepository(root, {
      getClient: () => Promise.resolve(client),
      renameLegacyForCleanup: async (source, destination) => {
        await rename(source, displacedLegacyPath)
        await writeFile(source, renameRaceReplacement)
        await rename(source, destination)
      }
    })

    await expect(
      renameRaceRepository.upgradeLegacySessionUploads(reconciled)
    ).resolves.toMatchObject({ messages: [{ uploads: [{ versionId }] }] })
    await expect(readFile(legacyPath)).resolves.toEqual(renameRaceReplacement)
    await expect(readFile(displacedLegacyPath)).resolves.toEqual(content)
    await expect(stat(cleanupPrivateDir)).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await expect(readFile(finalPath)).resolves.toEqual(content)

    await writeFile(legacyPath, content)
    const sameInodeReplacement = Buffer.alloc(content.byteLength, 'x')
    const inPlaceRaceRepository = new UploadRepository(root, {
      getClient: () => Promise.resolve(client),
      renameLegacyForCleanup: async (source, destination) => {
        await writeFile(source, sameInodeReplacement)
        await rename(source, destination)
      }
    })

    await expect(
      inPlaceRaceRepository.upgradeLegacySessionUploads(reconciled)
    ).resolves.toMatchObject({ messages: [{ uploads: [{ versionId }] }] })
    await expect(readFile(legacyPath)).resolves.toEqual(sameInodeReplacement)
    await expect(stat(cleanupPrivateDir)).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await expect(readFile(finalPath)).resolves.toEqual(content)

    await writeFile(legacyPath, content)
    const collidingPrivateBytes = Buffer.from('concurrent private claim')
    const privateClaimRaceRepository = new UploadRepository(root, {
      getClient: () => Promise.resolve(client),
      getLegacyFileChecksum: async () => {
        await mkdir(cleanupPrivateDir)
        await writeFile(cleanupPrivatePath, collidingPrivateBytes)
        return checksum
      }
    })

    await expect(
      privateClaimRaceRepository.upgradeLegacySessionUploads(reconciled)
    ).rejects.toThrow(/private claim is already occupied/i)
    await expect(readFile(cleanupPrivatePath)).resolves.toEqual(collidingPrivateBytes)
    await expect(readFile(legacyPath)).resolves.toEqual(content)
    await expect(readFile(finalPath)).resolves.toEqual(content)
    await rm(cleanupPrivateDir, { recursive: true, force: true })

    await writeFile(legacyPath, content)
    const crashAfterRename = new Error('simulated crash after legacy quarantine rename')
    const crashRepository = new UploadRepository(root, {
      getClient: () => Promise.resolve(client),
      renameLegacyForCleanup: async (source, destination) => {
        await rename(source, destination)
        throw crashAfterRename
      }
    })

    await expect(crashRepository.upgradeLegacySessionUploads(reconciled)).rejects.toBe(
      crashAfterRename
    )
    await expect(readFile(legacyPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(cleanupPrivatePath)).resolves.toEqual(content)

    const recoveryRepository = new UploadRepository(root, {
      getClient: () => Promise.resolve(client)
    })
    await expect(recoveryRepository.upgradeLegacySessionUploads(reconciled)).resolves.toMatchObject(
      {
        messages: [{ uploads: [{ versionId }] }]
      }
    )
    await expect(readFile(cleanupPrivatePath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(cleanupPrivateDir)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(finalPath)).resolves.toEqual(content)

    await writeFile(legacyPath, content)
    const sameContentDisplacedPath = `${legacyPath}.same-content-crash-original`
    let replacementIdentity: Awaited<ReturnType<typeof lstat>> | undefined
    const sameContentCrash = new Error('simulated crash before private inode revalidation')
    const sameContentCrashRepository = new UploadRepository(root, {
      getClient: () => Promise.resolve(client),
      renameLegacyForCleanup: async (source, destination) => {
        await rename(source, sameContentDisplacedPath)
        await writeFile(source, content)
        replacementIdentity = await lstat(source)
        await rename(source, destination)
        throw sameContentCrash
      }
    })

    await expect(sameContentCrashRepository.upgradeLegacySessionUploads(reconciled)).rejects.toBe(
      sameContentCrash
    )
    await expect(readFile(legacyPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(cleanupPrivatePath)).resolves.toEqual(content)

    let reverifiedIdentity: Awaited<ReturnType<typeof lstat>> | undefined
    const witnessResetRepository = new UploadRepository(root, {
      getClient: () => Promise.resolve(client),
      getLegacyFileChecksum: async (path) => {
        reverifiedIdentity = await lstat(path)
        return checksum
      }
    })
    await expect(
      witnessResetRepository.upgradeLegacySessionUploads(reconciled)
    ).resolves.toMatchObject({ messages: [{ uploads: [{ versionId }] }] })
    expect(replacementIdentity).toBeDefined()
    expect(reverifiedIdentity?.dev).toBe(replacementIdentity?.dev)
    expect(reverifiedIdentity?.ino).toBe(replacementIdentity?.ino)
    await expect(readFile(sameContentDisplacedPath)).resolves.toEqual(content)
    await expect(readFile(legacyPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(cleanupPrivateDir)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(finalPath)).resolves.toEqual(content)

    const isolatedPrivateBytes = Buffer.from('unverified quarantined bytes')
    await mkdir(cleanupPrivateDir)
    await writeFile(cleanupPrivatePath, isolatedPrivateBytes)
    await writeFile(legacyPath, renameRaceReplacement)
    await expect(
      recoveryRepository.upgradeLegacySessionUploads(reconciled, { mode: 'terminal-delete' })
    ).rejects.toThrow(/could not safely restore a private candidate/i)
    await expect(readFile(cleanupPrivatePath)).resolves.toEqual(isolatedPrivateBytes)
    await expect(readFile(legacyPath)).resolves.toEqual(renameRaceReplacement)
    await expect(readFile(finalPath)).resolves.toEqual(content)

    const missingVersionPath = join(root, 'uploads', 'default-project', 'session-1', 'missing.csv')
    await writeFile(missingVersionPath, content)
    const pathFreeUpload = reconciled.messages[0].uploads?.[0]
    if (!pathFreeUpload) throw new Error('Expected the reconciled path-free Upload projection.')
    const missingVersionSession: PersistedChatSession = {
      ...reconciled,
      messages: [
        {
          ...reconciled.messages[0],
          uploads: [
            {
              ...pathFreeUpload,
              id: 'missing-upload',
              versionId: 'missing-version',
              name: 'missing.csv',
              originalName: 'missing.csv'
            }
          ]
        }
      ]
    }
    await expect(repository.upgradeLegacySessionUploads(missingVersionSession)).rejects.toThrow(
      /Version authority is unavailable/i
    )
    await expect(readFile(missingVersionPath)).resolves.toEqual(content)

    await writeFile(legacyPath, content)
    const unavailableAuthorityRepository = new UploadRepository(root, {
      getClient: () => Promise.reject(new Error('Upload authority unavailable.'))
    })
    await expect(
      unavailableAuthorityRepository.upgradeLegacySessionUploads(reconciled)
    ).rejects.toThrow('Upload authority unavailable.')
  })

  it('requires a trusted Session-to-Project binding for legacy cross-Project paths', async () => {
    const root = await createStorageRoot()
    const repository = new UploadRepository(root)
    const [staged] = await stageUploadFixtures(repository, {
      files: [{ name: 'legacy.csv', content: Buffer.from('a,b\n1,2').toString('base64') }]
    })
    const [finalized] = await repository.finalizePendingSessionUploads('session-1', [staged])

    await expect(
      repository.resolveManagedUploadPath(
        { path: finalized.path },
        { projectId: 'default-project', sessionId: 'session-1' }
      )
    ).resolves.toBe(await realpath(finalized.path))
    await expect(
      repository.resolveManagedUploadPath(
        { path: finalized.path },
        { projectId: 'other-project', sessionId: 'session-1' }
      )
    ).rejects.toThrow(/different project or session/i)
    await expect(
      repository.resolveManagedUploadPath(
        { path: finalized.path },
        { projectId: 'default-project' }
      )
    ).resolves.toBe(await realpath(finalized.path))
    await expect(
      repository.resolveManagedUploadPath(
        { path: finalized.path },
        { projectId: 'default-project', sessionId: 'session-2' }
      )
    ).rejects.toThrow(/different project or session/i)
    await expect(
      repository.resolveManagedUploadPath({ path: finalized.path }, { projectId: 'other-project' })
    ).rejects.toThrow(/different project or session/i)

    const client = createProjectDbClient(root)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project one' } })
    await client.fileOriginSession.create({
      data: { projectId: 'other-project', sessionId: 'session-1' }
    })
    const repositoryWithTrustedOrigins = new UploadRepository(root, {
      getClient: () => Promise.resolve(client)
    })

    await expect(
      repositoryWithTrustedOrigins.resolveManagedUploadPath(
        { path: finalized.path },
        { projectId: 'other-project', sessionId: 'session-1' }
      )
    ).resolves.toBe(await realpath(finalized.path))
    await expect(
      repositoryWithTrustedOrigins.resolveManagedUploadPath(
        { path: finalized.path },
        { projectId: 'other-project' }
      )
    ).resolves.toBe(await realpath(finalized.path))
    await expect(
      repositoryWithTrustedOrigins.resolveManagedUploadPath(
        { path: finalized.path },
        { projectId: 'unrelated-project' }
      )
    ).rejects.toThrow(/different project or session/i)

    await client.fileOriginSession.create({
      data: { projectId: 'duplicate-import-project', sessionId: 'session-1' }
    })
    await expect(
      repositoryWithTrustedOrigins.resolveManagedUploadPath(
        { path: finalized.path },
        { projectId: 'other-project' }
      )
    ).rejects.toThrow(/different project or session/i)
  })

  it('uses project Files membership to preview a legacy upload across Sessions', async () => {
    const root = await createStorageRoot()
    const legacyRepository = new UploadRepository(root)
    const [staged] = await stageUploadFixtures(legacyRepository, {
      files: [{ name: 'paper.pdf', content: Buffer.from('legacy pdf').toString('base64') }]
    })
    const [finalized] = await legacyRepository.finalizePendingSessionUploads('source-session', [
      staged
    ])
    const client = createProjectDbClient(root)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project one' } })
    await client.managedFile.create({
      data: {
        source: 'upload',
        sourceFileId: finalized.id,
        projectId: 'project-files-a',
        sessionId: 'source-session',
        displayName: 'paper.pdf',
        storageKey: relative(root, finalized.path).split(sep).join('/'),
        sizeBytes: BigInt(finalized.size),
        sortAtMs: 1n
      }
    })
    const repository = new UploadRepository(root, {
      getClient: () => Promise.resolve(client)
    })

    await expect(
      repository.resolveManagedUploadPath(
        { path: finalized.path },
        { projectId: 'project-files-a', sessionId: 'referencing-session' }
      )
    ).resolves.toBe(await realpath(finalized.path))
    await expect(
      repository.resolveManagedUploadPath(
        { path: finalized.path },
        { projectId: 'unrelated-project', sessionId: 'referencing-session' }
      )
    ).rejects.toThrow(/different project or session/i)
  })

  it('removes staged uploads only from the managed upload tree', async () => {
    const root = await createStorageRoot()
    const repository = new UploadRepository(root)
    const [attachment] = await stageUploadFixtures(repository, {
      files: [
        {
          name: 'remove-me.txt',
          content: Buffer.from('temporary').toString('base64')
        }
      ]
    })

    await repository.deleteUpload({ path: attachment.path })

    await expect(stat(attachment.path)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(repository.deleteUpload({ path: join(root, 'outside.txt') })).rejects.toThrow(
      /outside upload storage/
    )
  })

  it('rejects deletion of finalized uploads while keeping their bytes readable', async () => {
    const root = await createStorageRoot()
    const repository = new UploadRepository(root)
    const [staged] = await stageUploadFixtures(repository, {
      files: [{ name: 'keep.txt', content: Buffer.from('durable upload').toString('base64') }]
    })
    const [finalized] = await repository.finalizePendingSessionUploads('session-1', [staged])

    await expect(repository.deleteUpload({ path: finalized.path })).rejects.toThrow(
      /outside pending upload storage/
    )
    await expect(readFile(finalized.path, 'utf8')).resolves.toBe('durable upload')
  })
})
