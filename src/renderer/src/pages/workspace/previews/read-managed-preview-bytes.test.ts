// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { readManagedPreviewBytes } from './read-managed-preview-bytes'

describe('readManagedPreviewBytes', () => {
  const acquire = vi.fn()
  const readRange = vi.fn()
  const release = vi.fn()

  beforeEach(() => {
    acquire.mockReset()
    readRange.mockReset()
    release.mockReset().mockResolvedValue(undefined)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        previewResources: {
          acquire,
          readRange,
          release
        }
      }
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reads multi-chunk ranges (Uint8Array and IPC indexed byte objects) and always releases the resource', async () => {
    const chunkSize = 1024 * 1024
    const totalSize = chunkSize + 4
    const firstChunk = new Uint8Array(chunkSize).fill(7)
    firstChunk[0] = 0x50
    firstChunk[1] = 0x4b
    const secondChunkSerialized: Record<number, number> = {
      0: 10,
      1: 20,
      2: 30,
      3: 40
    }

    acquire.mockResolvedValue({
      id: 'res-docx-1',
      size: totalSize,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    })
    readRange
      .mockResolvedValueOnce({
        resourceId: 'res-docx-1',
        begin: 0,
        end: chunkSize,
        data: firstChunk
      })
      .mockResolvedValueOnce({
        resourceId: 'res-docx-1',
        begin: chunkSize,
        end: totalSize,
        data: secondChunkSerialized
      })

    const result = await readManagedPreviewBytes({
      source: 'artifact',
      projectId: 'project-1',
      fileId: 'artifact-1',
      versionId: 'version-2'
    })

    expect(acquire).toHaveBeenCalledWith({
      source: 'artifact',
      projectId: 'project-1',
      fileId: 'artifact-1',
      versionId: 'version-2'
    })
    expect(readRange).toHaveBeenCalledTimes(2)
    expect(result.byteLength).toBe(totalSize)
    expect(result[0]).toBe(0x50)
    expect(result[1]).toBe(0x4b)
    expect(result[chunkSize - 1]).toBe(7)
    expect(Array.from(result.slice(chunkSize))).toEqual([10, 20, 30, 40])
    expect(release).toHaveBeenCalledWith({ resourceId: 'res-docx-1' })
  })

  it('releases the acquired resource when cancelled or when a range response is malformed', async () => {
    acquire.mockResolvedValue({
      id: 'res-docx-2',
      size: 8,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    })

    await expect(
      readManagedPreviewBytes(
        {
          source: 'upload',
          projectId: 'project-1',
          fileId: 'upload-1'
        },
        () => true
      )
    ).rejects.toThrow('Managed preview read cancelled.')
    expect(release).toHaveBeenCalledWith({ resourceId: 'res-docx-2' })

    release.mockClear()
    readRange.mockResolvedValueOnce({
      resourceId: 'res-docx-2',
      begin: 0,
      end: 8,
      data: { 0: 999 }
    })

    await expect(
      readManagedPreviewBytes({
        source: 'upload',
        projectId: 'project-1',
        fileId: 'upload-1'
      })
    ).rejects.toThrow('Managed preview range response did not match the requested chunk.')
    expect(release).toHaveBeenCalledWith({ resourceId: 'res-docx-2' })
  })
})
