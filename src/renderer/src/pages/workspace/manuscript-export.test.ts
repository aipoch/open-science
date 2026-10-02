import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PreviewFileItem } from '@/stores/preview-workbench-store'
import { exportManuscript, readManuscriptText } from './manuscript-export'

const item = (overrides: Partial<PreviewFileItem> = {}): PreviewFileItem => ({
  id: 'artifact-version:project-1/session-1/artifact-1/version-1',
  projectId: 'project-1',
  sessionId: 'session-1',
  title: 'paper.qmd',
  type: 'file',
  source: 'artifact',
  path: 'artifact-version:project-1/session-1/artifact-1/version-1',
  name: 'paper.qmd',
  format: 'markdown',
  managedFileId: 'artifact-1',
  selectedVersionId: 'version-1',
  ...overrides
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('workspace manuscript export', () => {
  it('reads the pinned preview source and renders through the manuscript command', async () => {
    const readPreview = vi.fn(async () => ({
      content: '---\ntitle: Paper\n---\n# Results\n',
      encoding: 'utf8' as const,
      size: 32,
      truncated: false
    }))
    const render = vi.fn(async () => ({
      filename: 'paper.pdf',
      mimeType: 'application/pdf',
      dataBase64: Buffer.from('pdf bytes').toString('base64'),
      references: []
    }))
    const saveBlobFile = vi.fn(async () => ({ saved: true, filePath: '/tmp/paper.pdf' }))
    vi.stubGlobal('window', {
      api: { artifacts: { readPreview }, manuscripts: { render }, saveBlobFile }
    })

    await expect(exportManuscript(item(), 'pdf')).resolves.toEqual({
      saved: true,
      filePath: '/tmp/paper.pdf'
    })
    expect(readPreview).toHaveBeenCalledWith({
      path: item().path,
      projectId: 'project-1',
      sessionId: 'session-1',
      fileId: 'artifact-1',
      versionId: 'version-1',
      maxBytes: 5 * 1024 * 1024,
      encoding: 'utf8'
    })
    expect(render).toHaveBeenCalledWith({
      projectId: 'project-1',
      appSessionId: 'session-1',
      content: '---\ntitle: Paper\n---\n# Results\n',
      format: 'pdf',
      filename: 'paper.qmd'
    })
    expect(saveBlobFile).toHaveBeenCalledWith({
      suggestedName: 'paper.pdf',
      mimeType: 'application/pdf',
      data: expect.any(ArrayBuffer)
    })
    const saveCall = saveBlobFile.mock.calls[0] as unknown as [{ data: ArrayBuffer }] | undefined
    expect(new TextDecoder().decode(saveCall?.[0].data)).toBe('pdf bytes')
  })

  it('rejects a manuscript too large for the bounded preview read', async () => {
    vi.stubGlobal('window', {
      api: {
        artifacts: {
          readPreview: vi.fn(async () => ({
            content: '# Paper\n',
            encoding: 'utf8' as const,
            size: 10,
            truncated: true
          }))
        }
      }
    })

    await expect(readManuscriptText(item())).rejects.toThrow(/too large/iu)
  })
})
