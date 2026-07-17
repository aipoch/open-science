// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { readManagedFileBytes } from './managed-file-bytes'

describe('readManagedFileBytes', () => {
  const acquire = vi.fn()
  const readRange = vi.fn()
  const release = vi.fn()

  beforeEach(() => {
    vi.resetAllMocks()
    window.api = {
      previewResources: { acquire, readRange, release }
    } as unknown as Window['api']
    acquire.mockResolvedValue({
      id: 'office-resource',
      url: 'open-science-preview://office-resource/report.docx',
      size: 3,
      mimeType: 'application/octet-stream',
      version: 1
    })
    readRange.mockResolvedValue({
      begin: 0,
      end: 3,
      total: 3,
      data: new Uint8Array([1, 2, 3])
    })
    release.mockResolvedValue(undefined)
  })

  it('reads and releases an owner-scoped artifact capability', async () => {
    await expect(
      readManagedFileBytes('/artifacts/report.docx', 'artifact', 10 * 1024 * 1024)
    ).resolves.toEqual(new Uint8Array([1, 2, 3]))
    expect(acquire).toHaveBeenCalledWith({
      source: 'artifact',
      path: '/artifacts/report.docx'
    })
    expect(readRange).toHaveBeenCalledWith({
      resourceId: 'office-resource',
      begin: 0,
      end: 3
    })
    expect(release).toHaveBeenCalledWith({ resourceId: 'office-resource' })
  })

  it('preserves the upload source when acquiring finalized files', async () => {
    await readManagedFileBytes('/uploads/session-1/results.xlsx', 'upload', 50 * 1024 * 1024)

    expect(acquire).toHaveBeenCalledWith({
      source: 'upload',
      path: '/uploads/session-1/results.xlsx'
    })
  })

  it('rejects an oversized file before transferring any ranges', async () => {
    acquire.mockResolvedValue({
      id: 'large-office-resource',
      url: 'open-science-preview://large-office-resource/report.docx',
      size: 11,
      mimeType: 'application/octet-stream',
      version: 1
    })

    await expect(readManagedFileBytes('/artifacts/report.docx', 'artifact', 10)).rejects.toThrow(
      /too large/i
    )

    expect(readRange).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledWith({ resourceId: 'large-office-resource' })
  })

  it('assembles files from main-process bounded ranges', async () => {
    const chunkSize = 1024 * 1024
    acquire.mockResolvedValue({
      id: 'chunked-office-resource',
      url: 'open-science-preview://chunked-office-resource/report.xlsx',
      size: chunkSize + 2,
      mimeType: 'application/octet-stream',
      version: 1
    })
    readRange.mockImplementation(async ({ begin, end }) => ({
      begin,
      end,
      total: chunkSize + 2,
      data: new Uint8Array(end - begin).fill(begin === 0 ? 1 : 2)
    }))

    const bytes = await readManagedFileBytes('/artifacts/report.xlsx', 'artifact', 50 * 1024 * 1024)

    expect(readRange).toHaveBeenCalledTimes(2)
    expect(readRange).toHaveBeenNthCalledWith(2, {
      resourceId: 'chunked-office-resource',
      begin: chunkSize,
      end: chunkSize + 2
    })
    expect(bytes[0]).toBe(1)
    expect(bytes[chunkSize]).toBe(2)
  })
})
