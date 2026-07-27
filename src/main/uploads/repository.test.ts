import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PENDING_UPLOAD_SESSION_ID } from '../../shared/uploads'
import { UploadRepository } from './repository'
import { stageUploadFixtures } from './repository.test-utils'

let storageRoot: string | undefined

const createStorageRoot = async (): Promise<string> => {
  storageRoot = await mkdtemp(join(tmpdir(), 'open-science-uploads-'))
  return storageRoot
}

afterEach(async () => {
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
