import { describe, expect, it, vi } from 'vitest'

import {
  createReviewerPagedContentResolver,
  type ReviewerPagedPreviewDependencies,
  type ReviewerPreviewWindow
} from './paged-preview-resolver'

const request = {
  artifactVersionId: 'version-1',
  path: '/managed/report.docx',
  filename: 'report.docx',
  format: 'docx' as const,
  pages: [2],
  includePreview: true,
  maxBytes: 10_000,
  verifiedObservation: {
    device: 1,
    inode: 2,
    sizeBytes: 100,
    modifiedAtMs: 3,
    changedAtMs: 4
  },
  verifiedChecksum: 'verified-checksum'
}

const setup = (): {
  dependencies: ReviewerPagedPreviewDependencies
  previewWindow: ReviewerPreviewWindow
  executeJavaScript: ReturnType<typeof vi.fn>
  capturePage: ReturnType<typeof vi.fn>
  rendererGone: () => void
} => {
  let destroyed = false
  const executeJavaScript = vi
    .fn()
    .mockResolvedValueOnce({ pageCount: 3, pageCountComplete: false })
    .mockResolvedValueOnce({
      pageNumber: 2,
      text: 'Rendered page two',
      rect: { x: 1, y: 2, width: 300, height: 400 }
    })
  const capturePage = vi.fn().mockResolvedValue({
    getSize: () => ({ width: 300, height: 400 }),
    resize: vi.fn(),
    toJPEG: () => Buffer.from('page-two')
  })
  let onRendererGone: (() => void) | undefined
  const previewWindow: ReviewerPreviewWindow = {
    webContents: {
      id: 42,
      getOSProcessId: () => 99,
      once: vi.fn((_event, listener) => {
        onRendererGone = listener
      }),
      removeListener: vi.fn(),
      executeJavaScript,
      capturePage
    },
    loadURL: vi.fn().mockResolvedValue(undefined),
    isDestroyed: () => destroyed,
    destroy: vi.fn(() => {
      destroyed = true
    })
  }
  const dependencies: ReviewerPagedPreviewDependencies = {
    createWindow: vi.fn(() => previewWindow),
    createSessionId: () => 'session-1',
    createRuntimeUrl: (sessionId) => `preview://${sessionId}`,
    acquireResource: vi.fn().mockResolvedValue({
      id: 'resource-1',
      url: 'managed://resource-1',
      size: 100,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      version: 1
    }),
    releaseResource: vi.fn(),
    renderPdfPages: vi.fn()
  }
  return {
    dependencies,
    previewWindow,
    executeJavaScript,
    capturePage,
    rendererGone: () => onRendererGone?.()
  }
}

describe('Reviewer paged preview resolver', () => {
  it('captures only the requested rendered Office page and releases its capability', async () => {
    const { dependencies, previewWindow, capturePage } = setup()
    const resolver = createReviewerPagedContentResolver(dependencies)

    await expect(resolver(request)).resolves.toEqual({
      pageCount: 3,
      pageCountComplete: false,
      pages: [{ pageNumber: 2, text: 'Rendered page two' }],
      media: [
        { pageNumber: 2, data: Buffer.from('page-two').toString('base64'), mimeType: 'image/jpeg' }
      ]
    })
    expect(dependencies.acquireResource).toHaveBeenCalledWith(
      42,
      '/managed/report.docx',
      'report.docx',
      request.verifiedObservation,
      'verified-checksum',
      40 * 1024 * 1024
    )
    expect(capturePage).toHaveBeenCalledWith({ x: 1, y: 2, width: 300, height: 400 })
    expect(previewWindow.destroy).toHaveBeenCalledOnce()
    expect(dependencies.releaseResource).toHaveBeenCalledWith(42, 'resource-1')
  })

  it('destroys the renderer and releases its capability when target preparation fails', async () => {
    const { dependencies, previewWindow, executeJavaScript } = setup()
    executeJavaScript
      .mockReset()
      .mockResolvedValueOnce({ pageCount: 3 })
      .mockRejectedValueOnce(new Error('render failed'))

    await expect(createReviewerPagedContentResolver(dependencies)(request)).rejects.toThrow(
      'render failed'
    )
    expect(previewWindow.destroy).toHaveBeenCalledOnce()
    expect(dependencies.releaseResource).toHaveBeenCalledWith(42, 'resource-1')
  })

  it('uses the bounded main-process PDF renderer without creating an Office window', async () => {
    const { dependencies } = setup()
    vi.mocked(dependencies.renderPdfPages).mockResolvedValue({
      pageCount: 2,
      media: [],
      budgetExhaustedPages: [2]
    })

    await expect(
      createReviewerPagedContentResolver(dependencies)({
        ...request,
        path: '/managed/scanned.pdf',
        filename: 'scanned.pdf',
        format: 'pdf'
      })
    ).resolves.toMatchObject({
      pageCount: 2,
      pages: [{ pageNumber: 2, text: '' }],
      limitations: [{ kind: 'budget-exhausted', subjectId: 'version-1' }]
    })
    expect(dependencies.createWindow).not.toHaveBeenCalled()
  })

  it('returns a typed partial limitation when the rendered DOCX target does not exist', async () => {
    const { dependencies, executeJavaScript } = setup()
    executeJavaScript.mockReset().mockResolvedValueOnce({ pageCount: 1, availablePages: [] })

    await expect(createReviewerPagedContentResolver(dependencies)(request)).resolves.toMatchObject({
      pageCount: 1,
      pages: [],
      limitations: [{ kind: 'truncated', subjectId: 'version-1' }]
    })
    expect(executeJavaScript).toHaveBeenCalledOnce()
  })

  it('returns a typed budget limitation before rendering an excessive DOCX page target', async () => {
    const { dependencies } = setup()

    await expect(
      createReviewerPagedContentResolver(dependencies)({ ...request, pages: [513] })
    ).resolves.toMatchObject({
      pages: [],
      limitations: [{ kind: 'budget-exhausted', subjectId: 'version-1' }]
    })
    expect(dependencies.createWindow).not.toHaveBeenCalled()
  })

  it('propagates an aborted request without creating a renderer', async () => {
    const { dependencies } = setup()
    const controller = new AbortController()
    const reason = new Error('cancelled')
    controller.abort(reason)

    await expect(
      createReviewerPagedContentResolver(dependencies)({
        ...request,
        signal: controller.signal
      })
    ).rejects.toBe(reason)
    expect(dependencies.createWindow).not.toHaveBeenCalled()
  })

  it('destroys the renderer and releases its acquired capability when aborted during rendering', async () => {
    const { dependencies, previewWindow, executeJavaScript } = setup()
    executeJavaScript.mockReset().mockImplementation(() => new Promise(() => undefined))
    const controller = new AbortController()
    const reason = new Error('cancelled during render')
    const result = createReviewerPagedContentResolver(dependencies)({
      ...request,
      signal: controller.signal
    })
    await vi.waitFor(() => expect(executeJavaScript).toHaveBeenCalledOnce())

    controller.abort(reason)

    await expect(result).rejects.toBe(reason)
    expect(previewWindow.destroy).toHaveBeenCalledOnce()
    expect(dependencies.releaseResource).toHaveBeenCalledWith(42, 'resource-1')
  })

  it('releases its capability when the isolated renderer exits', async () => {
    const { dependencies, previewWindow, executeJavaScript, rendererGone } = setup()
    executeJavaScript.mockReset().mockImplementation(() => new Promise(() => undefined))
    const result = createReviewerPagedContentResolver(dependencies)(request)
    await vi.waitFor(() => expect(executeJavaScript).toHaveBeenCalledOnce())

    rendererGone()

    await expect(result).rejects.toThrow(/renderer exited unexpectedly/i)
    expect(previewWindow.destroy).toHaveBeenCalledOnce()
    expect(dependencies.releaseResource).toHaveBeenCalledWith(42, 'resource-1')
  })

  it.each(['abort', 'crash'] as const)(
    'releases a capability that arrives after lifecycle %s',
    async (failure) => {
      const { dependencies, previewWindow, rendererGone } = setup()
      let resolveAcquisition!: (
        resource: Awaited<ReturnType<typeof dependencies.acquireResource>>
      ) => void
      vi.mocked(dependencies.acquireResource).mockReturnValue(
        new Promise((resolve) => {
          resolveAcquisition = resolve
        })
      )
      const controller = new AbortController()
      const result = createReviewerPagedContentResolver(dependencies)({
        ...request,
        signal: controller.signal
      })
      await vi.waitFor(() => expect(dependencies.acquireResource).toHaveBeenCalledOnce())

      if (failure === 'abort') controller.abort(new Error('cancelled before acquire'))
      else rendererGone()
      await expect(result).rejects.toThrow()

      resolveAcquisition({
        id: 'late-resource',
        url: 'managed://late-resource',
        size: 100,
        mimeType: 'application/octet-stream',
        version: 1
      })
      await vi.waitFor(() =>
        expect(dependencies.releaseResource).toHaveBeenCalledWith(42, 'late-resource')
      )
      expect(previewWindow.destroy).toHaveBeenCalledOnce()
    }
  )
})
