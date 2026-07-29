// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

import type { UploadedAttachment } from '../../../../shared/uploads'
import { stageComposerFile, type UploadStagingApi } from './composer-upload-transfer'

const attachment: UploadedAttachment = {
  id: 'upload-1',
  sessionId: '.pending',
  name: 'dataset.csv',
  originalName: 'dataset.csv',
  path: '/uploads/dataset.csv',
  mimeType: 'text/csv',
  size: 10
}

const createApi = (overrides: Partial<UploadStagingApi> = {}): UploadStagingApi => ({
  stageLocalFile: vi.fn().mockResolvedValue(null),
  beginTransfer: vi.fn(async (request) => ({
    transferId: request.transferId,
    name: request.name,
    receivedBytes: 0,
    totalBytes: request.size
  })),
  appendTransfer: vi.fn(async (request) => ({
    transferId: request.transferId,
    name: 'dataset.csv',
    receivedBytes: request.offset + request.chunk.byteLength,
    totalBytes: 10
  })),
  getTransferStatus: vi.fn().mockResolvedValue(null),
  finishTransfer: vi.fn().mockResolvedValue(attachment),
  abortTransfer: vi.fn().mockResolvedValue(undefined),
  deleteUpload: vi.fn().mockResolvedValue(undefined),
  onTransferProgress: vi.fn(() => vi.fn()),
  ...overrides
})

describe('stageComposerFile', () => {
  it('prefers the desktop native-path adapter without reading File bytes', async () => {
    const file = new File(['0123456789'], 'dataset.csv', { type: 'text/csv' })
    const arrayBuffer = vi.spyOn(file, 'arrayBuffer')
    const api = createApi({ stageLocalFile: vi.fn().mockResolvedValue(attachment) })

    await expect(
      stageComposerFile(file, api, { transferId: 'transfer-1', name: file.name })
    ).resolves.toEqual(attachment)

    expect(api.stageLocalFile).toHaveBeenCalledWith(file, {
      transferId: 'transfer-1',
      name: 'dataset.csv',
      mimeType: 'text/csv',
      size: 10
    })
    expect(arrayBuffer).not.toHaveBeenCalled()
    expect(api.beginTransfer).not.toHaveBeenCalled()
  })

  it('falls back to bounded chunks when no native path is available', async () => {
    const file = new File(['0123456789'], 'dataset.csv', { type: 'text/csv' })
    const api = createApi()
    const received: number[] = []

    await stageComposerFile(file, api, {
      transferId: 'transfer-2',
      name: file.name,
      chunkBytes: 4,
      onProgress: (progress) => received.push(progress.receivedBytes)
    })

    expect(api.appendTransfer).toHaveBeenCalledTimes(3)
    expect(
      vi
        .mocked(api.appendTransfer)
        .mock.calls.map(([request]) => [request.offset, request.chunk.byteLength])
    ).toEqual([
      [0, 4],
      [4, 4],
      [8, 2]
    ])
    expect(received).toEqual([0, 4, 8, 10])
    expect(api.finishTransfer).toHaveBeenCalledWith({ transferId: 'transfer-2' })
  })

  it('deletes a finalized upload when cancellation wins the finish race', async () => {
    const file = new File(['0123456789'], 'dataset.csv', { type: 'text/csv' })
    const controller = new AbortController()
    let resolveFinish: ((value: UploadedAttachment) => void) | undefined
    const finish = new Promise<UploadedAttachment>((resolve) => {
      resolveFinish = resolve
    })
    const api = createApi({ finishTransfer: vi.fn(() => finish) })

    const staging = stageComposerFile(file, api, {
      transferId: 'transfer-cancelled-during-finish',
      name: file.name,
      signal: controller.signal
    })

    await vi.waitFor(() => expect(api.finishTransfer).toHaveBeenCalledOnce())
    controller.abort()
    resolveFinish?.(attachment)

    await expect(staging).rejects.toMatchObject({ name: 'AbortError' })
    expect(api.deleteUpload).toHaveBeenCalledWith({ path: attachment.path })
    expect(api.abortTransfer).toHaveBeenCalledWith({
      transferId: 'transfer-cancelled-during-finish'
    })
  })
})
