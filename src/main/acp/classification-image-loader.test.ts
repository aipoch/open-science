import sharp from 'sharp'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { UploadedAttachment } from '../../shared/uploads'
import { UploadRepository } from '../uploads/repository'
import { stageUploadFixtures } from '../uploads/repository.test-utils'
import { AcpClassificationImageLoader } from './classification-image-loader'

const imageBytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } })
  .png()
  .toBuffer()
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const createRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'acp-classification-images-'))
  roots.push(root)
  return root
}

describe('classification image loading', () => {
  it('reads the current managed head for classification', async () => {
    const close = vi.fn()
    const lease = {
      size: imageBytes.byteLength,
      readRange: vi.fn(async () => imageBytes),
      verifyUnchanged: vi.fn(),
      close
    }
    const openLatest = vi.fn(async () => lease)
    const loader = new AcpClassificationImageLoader({
      uploadRepository: {} as UploadRepository,
      managedFileVersions: { openLatest } as never
    })
    const attachment: UploadedAttachment = {
      id: 'upload-file-1',
      versionId: 'stale-attachment-version',
      sessionId: 'session-1',
      name: 'current-image.png',
      originalName: 'current-image.png',
      path: 'upload-version:stale-attachment-version',
      mimeType: 'image/png',
      size: imageBytes.byteLength,
      createdAt: '2026-10-15T00:00:00.000Z'
    }

    const images = await loader.load({
      appSessionId: 'session-1',
      projectId: 'project-1',
      currentUploads: [attachment],
      signal: new AbortController().signal
    })

    expect(images).toHaveLength(1)
    expect(openLatest).toHaveBeenCalledWith({
      source: 'upload',
      projectId: 'project-1',
      fileId: 'upload-file-1'
    })
    expect(close).toHaveBeenCalledOnce()
  })

  it('reads an unpublished current upload through the scoped upload capability', async () => {
    const uploads = new UploadRepository(await createRoot())
    const openLatest = vi.fn(async () => {
      throw new Error('Unpublished uploads have no managed-file head.')
    })
    const loader = new AcpClassificationImageLoader({
      uploadRepository: uploads,
      managedFileVersions: { openLatest } as never
    })
    const [attachment] = await stageUploadFixtures(uploads, {
      files: [
        { name: 'current-image.png', mimeType: 'image/png', content: imageBytes.toString('base64') }
      ]
    })

    const images = await loader.load({
      appSessionId: 'session-1',
      projectId: 'project-1',
      currentUploads: [attachment!],
      signal: new AbortController().signal
    })

    expect(images).toHaveLength(1)
    expect(images[0]).toMatchObject({ mimeType: 'image/png' })
    expect(Buffer.from(images[0]!.data, 'base64').byteLength).toBe(images[0]!.byteLength)
    expect(openLatest).not.toHaveBeenCalled()
  })
})
