import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { PENDING_UPLOAD_SESSION_ID } from '../../shared/uploads'
import { UploadRepository } from './repository'

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
  it('stages uploaded files under the default project pending directory', async () => {
    const root = await createStorageRoot()
    const repository = new UploadRepository(root)

    const [attachment] = await repository.stageFiles({
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

  it('finalizes pending uploads into the real session directory without changing ids', async () => {
    const root = await createStorageRoot()
    const repository = new UploadRepository(root)
    const [attachment] = await repository.stageFiles({
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
    const [attachment] = await repository.stageFiles({
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
    const [attachment] = await repository.stageFiles({
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
    const [attachment] = await repository.stageFiles({
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
})
