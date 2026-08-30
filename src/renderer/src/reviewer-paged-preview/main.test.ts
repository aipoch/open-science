// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

const renderTargetedOfficeFile = vi.fn()

vi.mock('../pages/workspace/previews/office-renderers', () => ({ renderTargetedOfficeFile }))

const rect = { x: 10, y: 20, width: 300, height: 400 }
const mount = (element: HTMLElement): HTMLElement => {
  element.scrollIntoView = vi.fn()
  element.getBoundingClientRect = () => ({
    ...rect,
    top: rect.y,
    left: rect.x,
    right: rect.x + rect.width,
    bottom: rect.y + rect.height,
    toJSON: () => rect
  })
  return element
}

describe('Reviewer paged preview runtime', () => {
  beforeEach(async () => {
    vi.resetModules()
    window.history.replaceState({}, '', '/?sessionId=session-1')
    document.body.innerHTML = '<div id="reviewer-paged-preview-root"></div>'
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { 'content-length': '3' }
        })
      )
    )
    renderTargetedOfficeFile.mockReset().mockImplementation(async ({ extension, targetPages }) => ({
      pageCount: 2,
      pageCountComplete: true,
      availablePages: [2],
      preparePage: vi.fn(async () => {
        const page = mount(document.createElement(extension === 'docx' ? 'section' : 'div'))
        page.textContent = extension === 'docx' ? 'target page two' : 'target slide two'
        return page
      }),
      dispose: vi.fn(),
      admittedTargets: targetPages
    }))
  })

  it.each([
    ['docx', 'target page two'],
    ['pptx', 'target slide two']
  ] as const)('returns only requested rendered %s target', async (format, expectedText) => {
    await import('./main')
    const initialization = await window.__openScienceReviewerPagedPreview.initialize({
      sessionId: 'session-1',
      resource: {
        id: 'resource-1',
        url: 'open-science-preview://resource-1/report',
        size: 3,
        mimeType: 'application/octet-stream',
        version: 1
      },
      format,
      pages: [2]
    })

    expect(initialization).toEqual({
      pageCount: 2,
      pageCountComplete: true,
      availablePages: [2]
    })
    expect(renderTargetedOfficeFile).toHaveBeenCalledWith(
      expect.objectContaining({ extension: format, targetPages: [2] })
    )
    await expect(
      window.__openScienceReviewerPagedPreview.preparePage({ pageNumber: 2 })
    ).resolves.toMatchObject({ pageNumber: 2, text: expectedText, rect })
    await expect(
      window.__openScienceReviewerPagedPreview.preparePage({ pageNumber: 1 })
    ).rejects.toThrow(/not admitted/i)
  })
})
