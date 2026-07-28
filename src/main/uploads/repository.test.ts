import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createUploadVersionReference, PENDING_UPLOAD_SESSION_ID } from '../../shared/uploads'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { createProjectDbClient, ensureProjectSchema } from '../projects/prisma-client'
import { UploadRepository } from './repository'
import { stageUploadFixtures } from './repository.test-utils'

let storageRoot: string | undefined
let disconnect: (() => Promise<void>) | undefined

const createStorageRoot = async (): Promise<string> => {
  storageRoot = await mkdtemp(join(tmpdir(), 'open-science-uploads-'))
  return storageRoot
}

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
    await ensureProjectSchema(client)
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

    const scopedReference = createUploadVersionReference(finalized[0].versionId ?? '', {
      projectId: 'project-1',
      sessionId: 'session-1'
    })
    await expect(
      repository.resolveSessionUploadPath('session-1', { path: scopedReference }, 'project-1')
    ).resolves.toBe(finalized[0].path)
    await expect(
      repository.resolveSessionUploadPath('session-1', { path: scopedReference }, 'project-2')
    ).rejects.toThrow(/different project/i)
    await expect(
      repository.resolveManagedUploadPath({
        path: createUploadVersionReference(finalized[0].versionId ?? '')
      })
    ).rejects.toThrow(/Project scope/i)

    const files = await client.uploadFile.findMany({
      where: { projectId: 'project-1', sessionId: 'session-1' },
      include: { versions: true }
    })
    expect(files).toHaveLength(2)
    expect(files.every((file) => file.versions[0]?.state === 'ready')).toBe(true)
    expect(files.every((file) => file.versions[0]?.versionNumber === 1)).toBe(true)

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
    await ensureProjectSchema(client)
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

  it('recovers a staging Upload Version from the original pending bytes', async () => {
    const root = await createStorageRoot()
    const client = createProjectDbClient(root)
    disconnect = () => client.$disconnect()
    await ensureProjectSchema(client)
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

    const [recovered] = await repository.finalizePendingSessionUploads(
      'session-1',
      [pending],
      'project-1'
    )

    expect(recovered).toMatchObject({ versionId, versionNumber: 1, checksum })
    await expect(
      client.uploadVersion.findUniqueOrThrow({ where: { id: versionId } })
    ).resolves.toMatchObject({ state: 'ready' })
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
    await expect(readFile(recovered.path, 'utf8')).resolves.toBe('sample,value\na,1\n')
  })

  it('recovers a post-rename staging Upload Version during startup reconciliation', async () => {
    const root = await createStorageRoot()
    const client = createProjectDbClient(root)
    disconnect = () => client.$disconnect()
    await ensureProjectSchema(client)
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
    await mkdir(dirname(finalPath), { recursive: true })
    await writeFile(finalPath, content)
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

    await repository.recoverStagingUploads()

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
    ).resolves.toMatchObject({ sourceVersionId: versionId })
  })

  it('upgrades a legacy session upload before writing a path-free Session projection', async () => {
    const root = await createStorageRoot()
    const client = createProjectDbClient(root)
    disconnect = () => client.$disconnect()
    await ensureProjectSchema(client)
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
    expect(upload?.versionId).toMatch(/^[0-9a-f-]{36}$/u)
    expect(upload).not.toHaveProperty('path')
    expect(upload).not.toHaveProperty('createdAt')
    await expect(readFile(legacyPath, 'utf8')).resolves.toBe('sample,value\na,1\n')
    const version = await client.uploadVersion.findUniqueOrThrow({
      where: { id: upload?.versionId }
    })
    expect(version).toMatchObject({ state: 'ready', createdAt: null })
  })

  it('reads bounded previews only from managed uploads', async () => {
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

    const preview = await repository.readManagedUploadPreview({
      path: attachment.path,
      maxBytes: 5,
      encoding: 'utf8'
    })

    expect(preview).toEqual({
      content: 'hello',
      encoding: 'utf8',
      size: 'hello upload'.length,
      truncated: true
    })
    await expect(
      repository.readManagedUploadPreview({ path: join(root, 'outside.txt') })
    ).rejects.toThrow(/outside upload storage/)
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
    await ensureProjectSchema(client)
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
