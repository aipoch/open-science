import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { PENDING_UPLOAD_SESSION_ID } from '../../shared/uploads'
import { UploadRepository } from './repository'
import { stageUploadFixtures } from './repository.test-utils'

let storageRoot: string | undefined

const createStorageRoot = async (): Promise<string> => {
  storageRoot = await mkdtemp(join(tmpdir(), 'open-science-upload-characterization-'))
  return storageRoot
}

afterEach(async () => {
  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true })
    storageRoot = undefined
  }
})

describe('upload repository public characterization', () => {
  it('resumes an incomplete remote transfer while making matching begin requests idempotent', async () => {
    const root = await createStorageRoot()
    const repository = new UploadRepository(root)
    const content = Buffer.from('sample,value\na,1\n')
    const request = {
      transferId: 'remote-retry',
      name: 'dataset.csv',
      mimeType: 'text/csv',
      size: content.byteLength
    }

    const initial = await repository.beginTransfer(request)

    await expect(repository.beginTransfer(request)).resolves.toEqual(initial)
    await expect(repository.beginTransfer({ ...request, size: request.size + 1 })).rejects.toThrow(
      /metadata does not match/i
    )

    const splitAt = 8
    await repository.appendTransfer({
      transferId: request.transferId,
      offset: 0,
      chunk: content.subarray(0, splitAt)
    })

    await expect(repository.finishTransfer({ transferId: request.transferId })).rejects.toThrow(
      /incomplete/i
    )
    await expect(repository.getTransferStatus({ transferId: request.transferId })).resolves.toEqual(
      {
        transferId: request.transferId,
        name: request.name,
        receivedBytes: splitAt,
        totalBytes: content.byteLength
      }
    )

    await repository.appendTransfer({
      transferId: request.transferId,
      offset: splitAt,
      chunk: content.subarray(splitAt)
    })
    const attachment = await repository.finishTransfer({ transferId: request.transferId })

    expect(attachment).toMatchObject({
      sessionId: PENDING_UPLOAD_SESSION_ID,
      name: request.name,
      originalName: request.name,
      mimeType: request.mimeType,
      size: content.byteLength
    })
    await repository.abortTransfer({ transferId: request.transferId })
    await repository.abortTransfer({ transferId: request.transferId })
    await expect(readFile(attachment.path)).resolves.toEqual(content)
    await expect(
      repository.getTransferStatus({ transferId: request.transferId })
    ).resolves.toBeNull()
  })

  it('cleans a failed local staging attempt and permits the same transfer id to retry', async () => {
    const root = await createStorageRoot()
    const repository = new UploadRepository(root)
    const sourcePath = join(root, 'dataset.csv')
    const content = Buffer.from('sample,value\na,1\n')
    const request = {
      transferId: 'local-retry',
      sourcePath,
      name: 'dataset.csv',
      mimeType: 'text/csv',
      size: content.byteLength
    }
    await writeFile(sourcePath, content)

    await expect(repository.stageLocalFile({ ...request, size: request.size + 1 })).rejects.toThrow(
      /changed before it could be staged/i
    )
    await expect(
      stat(join(root, 'uploads', 'default-project', '.staging', `${request.transferId}.part`))
    ).rejects.toMatchObject({ code: 'ENOENT' })

    const attachment = await repository.stageLocalFile(request)

    expect(attachment).toMatchObject({
      sessionId: PENDING_UPLOAD_SESSION_ID,
      name: request.name,
      size: content.byteLength
    })
    await expect(readFile(attachment.path)).resolves.toEqual(content)
  })

  it('makes pending deletion retries harmless without widening cleanup authority', async () => {
    const root = await createStorageRoot()
    const repository = new UploadRepository(root)
    const outsidePath = join(root, 'outside.txt')
    await writeFile(outsidePath, 'caller-owned')
    const [attachment] = await stageUploadFixtures(repository, {
      files: [{ name: 'remove-me.txt', content: Buffer.from('temporary').toString('base64') }]
    })

    await repository.deleteUpload({ path: attachment.path })
    await repository.deleteUpload({ path: attachment.path })

    await expect(stat(attachment.path)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(repository.deleteUpload({ path: outsidePath })).rejects.toThrow(
      /outside upload storage/i
    )
    await expect(readFile(outsidePath, 'utf8')).resolves.toBe('caller-owned')
  })
})
