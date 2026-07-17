// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ManagedPreviewResource } from '../../../../../shared/preview-resources'
import { createManagedPdfLoadingTask } from './managed-pdf-document'

const resource: ManagedPreviewResource = {
  id: 'resource-1',
  url: 'open-science-preview://resource-1/report.pdf',
  size: 8 * 1024 * 1024,
  mimeType: 'application/pdf',
  version: 1
}

describe('createManagedPdfLoadingTask', () => {
  beforeEach(() => {
    window.api = {
      previewResources: {
        acquire: vi.fn(),
        readRange: vi.fn().mockResolvedValue({
          begin: 65536,
          end: 131072,
          total: resource.size,
          data: new Uint8Array(64 * 1024).fill(1)
        }),
        release: vi.fn()
      }
    } as unknown as Window['api']
  })

  it('feeds PDF.js bounded range requests without a whole-file data payload', async () => {
    const loadingTask = { promise: Promise.resolve({}), destroy: vi.fn() }
    const getDocument = vi.fn().mockReturnValue(loadingTask)

    const result = createManagedPdfLoadingTask(resource, getDocument)
    const options = getDocument.mock.calls[0]?.[0]
    const onDataRange = vi.spyOn(options.range, 'onDataRange')

    options.range.requestDataRange(65536, 131072)
    await vi.waitFor(() => expect(onDataRange).toHaveBeenCalled())

    expect(result).toBe(loadingTask)
    expect(options).toMatchObject({
      length: resource.size,
      rangeChunkSize: 64 * 1024,
      disableStream: true,
      disableAutoFetch: true
    })
    expect(options).not.toHaveProperty('data')
    expect(window.api.previewResources.readRange).toHaveBeenCalledWith({
      resourceId: 'resource-1',
      begin: 65536,
      end: 131072
    })
    expect(onDataRange).toHaveBeenCalledWith(
      65536,
      expect.objectContaining({ byteLength: 64 * 1024 })
    )
  })

  it('splits a large PDF.js range into bounded IPC chunks before delivering it', async () => {
    const chunkBytes = 1024 * 1024
    vi.mocked(window.api.previewResources.readRange).mockImplementation(async ({ begin, end }) => ({
      begin,
      end,
      total: resource.size,
      data: new Uint8Array(end - begin).fill(begin / chunkBytes + 1)
    }))
    const getDocument = vi.fn().mockReturnValue({ promise: Promise.resolve({}), destroy: vi.fn() })

    createManagedPdfLoadingTask(resource, getDocument)
    const range = getDocument.mock.calls[0]?.[0].range
    const onDataRange = vi.spyOn(range, 'onDataRange')

    range.requestDataRange(0, chunkBytes * 2 + 3)
    await vi.waitFor(() => expect(onDataRange).toHaveBeenCalled())

    expect(window.api.previewResources.readRange).toHaveBeenCalledTimes(3)
    expect(window.api.previewResources.readRange).toHaveBeenNthCalledWith(1, {
      resourceId: resource.id,
      begin: 0,
      end: chunkBytes
    })
    expect(window.api.previewResources.readRange).toHaveBeenNthCalledWith(2, {
      resourceId: resource.id,
      begin: chunkBytes,
      end: chunkBytes * 2
    })
    expect(window.api.previewResources.readRange).toHaveBeenNthCalledWith(3, {
      resourceId: resource.id,
      begin: chunkBytes * 2,
      end: chunkBytes * 2 + 3
    })
    expect(onDataRange).toHaveBeenCalledWith(
      0,
      expect.objectContaining({ byteLength: chunkBytes * 2 + 3 })
    )
  })

  it('stops scheduling IPC chunks after the range transport is aborted', async () => {
    let resolveFirstChunk:
      | ((value: Awaited<ReturnType<Window['api']['previewResources']['readRange']>>) => void)
      | undefined
    vi.mocked(window.api.previewResources.readRange).mockReturnValue(
      new Promise((resolve) => {
        resolveFirstChunk = resolve
      })
    )
    const getDocument = vi.fn().mockReturnValue({ promise: Promise.resolve({}), destroy: vi.fn() })

    createManagedPdfLoadingTask(resource, getDocument)
    const range = getDocument.mock.calls[0]?.[0].range
    const onDataRange = vi.spyOn(range, 'onDataRange')

    range.requestDataRange(0, 2 * 1024 * 1024)
    await vi.waitFor(() => expect(window.api.previewResources.readRange).toHaveBeenCalledTimes(1))
    range.abort()
    resolveFirstChunk?.({
      begin: 0,
      end: 1024 * 1024,
      total: resource.size,
      data: new Uint8Array(1024 * 1024)
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(window.api.previewResources.readRange).toHaveBeenCalledTimes(1)
    expect(onDataRange).not.toHaveBeenCalled()
  })

  it('destroys the PDF loading task only once when a range read and caller both fail it', async () => {
    vi.mocked(window.api.previewResources.readRange).mockRejectedValue(new Error('read failed'))
    const destroy = vi.fn().mockResolvedValue(undefined)
    const getDocument = vi.fn().mockReturnValue({ promise: Promise.resolve({}), destroy })

    const loadingTask = createManagedPdfLoadingTask(resource, getDocument)
    const range = getDocument.mock.calls[0]?.[0].range
    range.requestDataRange(0, 64 * 1024)
    await vi.waitFor(() => expect(destroy).toHaveBeenCalledTimes(1))
    await loadingTask.destroy()

    expect(destroy).toHaveBeenCalledTimes(1)
  })
})
