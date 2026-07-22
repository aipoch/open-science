// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { OfficePreviewRuntimeError, runOfficePreview } from './office-preview-runtime'

const mocks = vi.hoisted(() => ({
  validate: vi.fn(),
  render: vi.fn()
}))

vi.mock('../pages/workspace/previews/office-package', () => ({
  validateOfficePackage: mocks.validate
}))
vi.mock('../pages/workspace/previews/office-renderers', () => ({
  renderOfficeFile: mocks.render
}))

describe('runOfficePreview', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.render.mockResolvedValue(vi.fn())
  })

  it('reads, validates, and renders inside the isolated runtime', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const disposeRender = vi.fn()
    mocks.render.mockImplementation(async (options) => {
      options.onStatus?.({
        phase: 'rendering',
        title: 'Rendering the preview',
        description: 'Building the document view.'
      })
      return disposeRender
    })
    const fetchFile = vi.fn().mockResolvedValue(
      new Response(bytes, {
        status: 200,
        headers: { 'content-length': String(bytes.byteLength) }
      })
    )
    const reportState = vi.fn()
    const container = document.createElement('div')
    const start = {
      sessionId: 'session-1',
      resource: {
        id: 'resource-1',
        url: 'open-science-preview://resource-1/report.docx',
        size: bytes.byteLength,
        mimeType: 'application/octet-stream',
        version: 1
      },
      extension: 'docx' as const,
      name: 'report.docx',
      attempt: 0
    }

    const cleanup = await runOfficePreview({ start, container, fetchFile, reportState })

    expect(fetchFile).toHaveBeenCalledWith(
      start.resource.url,
      expect.objectContaining({
        cache: 'no-store',
        signal: expect.any(AbortSignal)
      })
    )
    expect(mocks.validate).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      'docx',
      expect.any(AbortSignal)
    )
    expect(mocks.render).toHaveBeenCalledWith(
      expect.objectContaining({
        bytes: expect.any(Uint8Array),
        extension: 'docx',
        name: 'report.docx',
        container,
        signal: expect.any(AbortSignal)
      })
    )
    expect(reportState.mock.calls.map(([state]) => state.phase)).toEqual([
      'reading',
      'validating',
      'parsing',
      'rendering',
      'ready'
    ])

    cleanup()
    expect(disposeRender).toHaveBeenCalledOnce()
  })

  it('classifies managed-resource read failures before package parsing', async () => {
    const start = {
      sessionId: 'session-1',
      resource: {
        id: 'resource-1',
        url: 'open-science-preview://resource-1/report.xlsx',
        size: 10,
        mimeType: 'application/octet-stream',
        version: 1
      },
      extension: 'xlsx' as const,
      name: 'report.xlsx',
      attempt: 0
    }

    await expect(
      runOfficePreview({
        start,
        container: document.createElement('div'),
        fetchFile: vi.fn().mockResolvedValue(new Response(null, { status: 410 })),
        reportState: vi.fn()
      })
    ).rejects.toMatchObject({ code: 'FILE_READ_FAILED' })
    expect(mocks.validate).not.toHaveBeenCalled()
  })

  it('preserves stable package-validation error codes', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    mocks.validate.mockRejectedValue(
      new OfficePreviewRuntimeError('RESOURCE_LIMIT_EXCEEDED', 'Package expansion limit exceeded')
    )
    const start = {
      sessionId: 'session-1',
      resource: {
        id: 'resource-1',
        url: 'open-science-preview://resource-1/report.docx',
        size: bytes.byteLength,
        mimeType: 'application/octet-stream',
        version: 1
      },
      extension: 'docx' as const,
      name: 'report.docx',
      attempt: 0
    }

    await expect(
      runOfficePreview({
        start,
        container: document.createElement('div'),
        fetchFile: vi.fn().mockResolvedValue(new Response(bytes)),
        reportState: vi.fn()
      })
    ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' })
    expect(mocks.render).not.toHaveBeenCalled()
  })
})
