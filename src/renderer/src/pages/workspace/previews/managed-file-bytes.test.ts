// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { readManagedFileBytes } from './managed-file-bytes'

describe('readManagedFileBytes', () => {
  const artifactReadBytes = vi.fn()
  const uploadReadBytes = vi.fn()

  beforeEach(() => {
    vi.resetAllMocks()
    window.api = {
      artifacts: { readBytes: artifactReadBytes },
      uploads: { readBytes: uploadReadBytes }
    } as unknown as Window['api']
  })

  it('decodes bytes from the managed artifact IPC', async () => {
    artifactReadBytes.mockResolvedValue({ data: 'AQID', size: 3 })

    await expect(readManagedFileBytes('/artifacts/report.docx', 'artifact')).resolves.toEqual(
      new Uint8Array([1, 2, 3])
    )
    expect(artifactReadBytes).toHaveBeenCalledWith({ path: '/artifacts/report.docx' })
    expect(uploadReadBytes).not.toHaveBeenCalled()
  })

  it('decodes bytes from the finalized upload IPC', async () => {
    uploadReadBytes.mockResolvedValue({ data: 'BAU=', size: 2 })

    await expect(
      readManagedFileBytes('/uploads/session-1/results.xlsx', 'upload')
    ).resolves.toEqual(new Uint8Array([4, 5]))
    expect(uploadReadBytes).toHaveBeenCalledWith({ path: '/uploads/session-1/results.xlsx' })
    expect(artifactReadBytes).not.toHaveBeenCalled()
  })

  it('forwards an optional byte limit to the main process before reading', async () => {
    artifactReadBytes.mockResolvedValue({ data: 'AQID', size: 3 })

    await readManagedFileBytes('/artifacts/report.docx', 'artifact', 10 * 1024 * 1024)

    expect(artifactReadBytes).toHaveBeenCalledWith({
      path: '/artifacts/report.docx',
      maxBytes: 10 * 1024 * 1024
    })
  })
})
