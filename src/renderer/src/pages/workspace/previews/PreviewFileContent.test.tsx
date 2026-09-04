// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PreviewFileItem } from '@/stores/preview-workbench-store'
import type { PreviewFileRendererProps } from './preview-types'
import { createCachedImageFetchResponse } from './cached-preview-image.test-support'
import { createManagedPreviewTestTransport } from './managed-preview-test-support'
import { PreviewFileContent } from './PreviewFileContent'
import type { PreviewDownloadVersionContext } from './preview-runtime-context'

const highlightSpy = vi.hoisted(() => vi.fn())
const registerPreviewFrameSpy = vi.hoisted(() => vi.fn())

vi.mock('../preview-actions/preview-action-hooks', () => ({
  useRegisterPreviewContextMenuFrame: registerPreviewFrameSpy
}))

const addModel = vi.fn()
const setStyle = vi.fn()
const addSurface = vi.fn()
const removeAllSurfaces = vi.fn()
const zoomTo = vi.fn()
const renderViewer = vi.fn()
const resizeViewer = vi.fn()
const clearViewer = vi.fn()
const createViewer = vi.fn(() => ({
  addModel,
  setStyle,
  addSurface,
  removeAllSurfaces,
  zoomTo,
  render: renderViewer,
  resize: resizeViewer,
  clear: clearViewer
}))

vi.mock('3dmol', () => ({
  createViewer,
  SurfaceType: {
    VDW: 'VDW'
  }
}))

vi.mock('@/components/streamdown/code-highlighter-runtime', () => ({
  code: {
    supportsLanguage: (language: string) =>
      ['bash', 'css', 'javascript', 'jsx', 'python', 'r', 'typescript', 'tsx'].includes(language),
    getThemes: () => ['github-light', 'github-dark'],
    highlight: (
      options: { code: string; language: string },
      callback?: (result: { tokens: Array<Array<Record<string, unknown>>> }) => void
    ) => {
      highlightSpy(options)
      if (options.code === 'print("fresh")') {
        const staleResult = {
          tokens: [[{ content: 'print("stale")', color: '#24292f' }]]
        }
        callback?.(staleResult)
        return null
      }
      const firstToken = options.language === 'r' ? 'library' : 'import'
      const result = {
        tokens: [
          [
            {
              content: firstToken,
              color: '#0969da',
              htmlStyle: { color: '#0969da', '--shiki-dark': '#79c0ff' }
            },
            { content: options.code.slice(firstToken.length), color: '#24292f' }
          ]
        ]
      }
      callback?.(result)
      return null
    }
  }
}))

let previewElementWidth = 640
let previewElementHeight = 480
let resizeObserverCallbacks: ResizeObserverCallback[] = []
let restorePdbLayoutMocks: (() => void) | undefined

const createFileItem = (overrides: Partial<PreviewFileItem>): PreviewFileItem => ({
  id: 'file-1',
  projectId: 'project-1',
  sessionId: 'session-1',
  title: 'data.json',
  type: 'file',
  source: 'artifact',
  path: '/workspace/data.json',
  name: 'data.json',
  format: 'json',
  managedFileId: 'file-1',
  ...overrides
})

const installPdbLayoutMocks = (): (() => void) => {
  const originalResizeObserver = globalThis.ResizeObserver
  const originalClientWidthDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'clientWidth'
  )
  const originalClientHeightDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'clientHeight'
  )

  previewElementWidth = 640
  previewElementHeight = 480
  resizeObserverCallbacks = []
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => previewElementWidth
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => previewElementHeight
  })
  globalThis.ResizeObserver = class {
    observe = vi.fn()
    unobserve = vi.fn()
    disconnect = vi.fn()

    constructor(callback: ResizeObserverCallback) {
      resizeObserverCallbacks.push(callback)
    }
  } as unknown as typeof ResizeObserver

  return () => {
    if (originalResizeObserver) {
      globalThis.ResizeObserver = originalResizeObserver
    } else {
      delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver
    }
    if (originalClientWidthDescriptor) {
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidthDescriptor)
    } else {
      delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
    }
    if (originalClientHeightDescriptor) {
      Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeightDescriptor)
    } else {
      delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
    }
  }
}

describe('PreviewFileContent', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    restorePdbLayoutMocks = undefined
    window.api = {
      artifacts: {
        openFile: vi.fn().mockResolvedValue(undefined),
        readPreview: vi.fn().mockResolvedValue({
          content: '',
          encoding: 'utf8',
          size: 0,
          truncated: false
        }),
        finalizeRunArtifacts: vi.fn()
      },
      uploads: {
        deleteUpload: vi.fn(),
        finalizeSession: vi.fn(),
        readPreview: vi.fn().mockResolvedValue({
          content: '',
          encoding: 'utf8',
          size: 0,
          truncated: false
        })
      }
    } as unknown as Window['api']
    const transport = createManagedPreviewTestTransport({
      read: (source, request) =>
        source === 'upload'
          ? window.api.uploads.readPreview(request)
          : window.api.artifacts.readPreview(request)
    })
    window.api.previewResources = {
      acquire: vi.fn(transport.acquire),
      readRange: vi.fn(),
      release: vi.fn(transport.release)
    }
    vi.stubGlobal('fetch', vi.fn(transport.fetch))
    vi.clearAllMocks()
    highlightSpy.mockClear()
    registerPreviewFrameSpy.mockClear()
  })

  it('downloads the selected historical version from the unsupported-preview fallback menu', async () => {
    const saveManagedFile = vi.fn().mockResolvedValue({ saved: false })
    window.api.saveManagedFile = saveManagedFile
    const unsupportedItem: PreviewFileItem = {
      id: 'upload:upload-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      title: 'archive.bin',
      type: 'file',
      source: 'upload',
      path: 'upload-version:stale-projection',
      name: 'archive.bin',
      format: 'unknown',
      managedFileId: 'upload-1',
      selectedVersionId: 'upload-v5',
      versionNumber: 5
    }

    await renderFile(unsupportedItem, {
      downloadVersionContext: {
        versionId: 'upload-v5',
        versionNumber: 5,
        latestVersionId: 'upload-v7',
        latestVersionNumber: 7
      }
    })
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Download options for archive.bin"]')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await Promise.resolve()
    })
    expect(saveManagedFile).not.toHaveBeenCalled()

    const selectedVersion = [
      ...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')
    ].find((item) => item.textContent === 'Download version v5')
    expect(selectedVersion).toBeDefined()
    await act(async () => {
      selectedVersion?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(saveManagedFile).toHaveBeenCalledWith({
      source: 'upload',
      projectId: 'project-1',
      fileId: 'upload-1',
      versionId: 'upload-v5',
      suggestedName: 'archive.bin'
    })
  })

  it('does not download a managed fallback while version context is pending', async () => {
    const saveManagedFile = vi.fn().mockResolvedValue({ saved: false })
    window.api.saveManagedFile = saveManagedFile

    await renderFile(
      createFileItem({
        source: 'upload',
        projectId: 'project-1',
        managedFileId: 'upload-1',
        selectedVersionId: 'upload-v5',
        path: 'upload-version:stale-projection',
        name: 'archive.bin',
        title: 'archive.bin',
        format: 'unknown'
      })
    )

    const trigger = container.querySelector<HTMLButtonElement>('button')
    expect(trigger?.disabled).toBe(true)
    await act(async () => {
      trigger?.click()
      await Promise.resolve()
    })

    expect(saveManagedFile).not.toHaveBeenCalled()
    expect(document.body.querySelector('[role="menuitem"]')).toBeNull()
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    container.remove()
    restorePdbLayoutMocks?.()
    restorePdbLayoutMocks = undefined
    vi.unstubAllGlobals()
  })

  const renderFile = async (
    item: PreviewFileItem,
    options: Omit<PreviewFileRendererProps, 'item'> & {
      downloadVersionContext?: PreviewDownloadVersionContext
      onRetry?: () => Promise<void>
    } = {}
  ): Promise<void> => {
    root = createRoot(container)
    await act(async () => {
      root.render(<PreviewFileContent item={item} {...options} />)
    })
  }

  it.each([
    ['markdown', 'notes.md'],
    ['text', 'notes.txt'],
    ['code', 'analysis.py'],
    ['fasta', 'sequence.fasta']
  ] as const)('enables text annotations for %s previews', async (format, name) => {
    vi.mocked(window.api.artifacts.readPreview).mockResolvedValue({
      content: 'selectable preview evidence',
      encoding: 'utf8',
      size: 27,
      truncated: false
    })

    await renderFile(
      createFileItem({
        format,
        name,
        projectId: 'project-1',
        selectedVersionId: 'version-2'
      }),
      { onAddAnnotation: vi.fn(() => undefined) }
    )

    await vi.waitFor(() =>
      expect(
        container.querySelector('[data-preview-text-annotation-surface="true"]')
      ).not.toBeNull()
    )
  })

  it('waits for an Artifact Version to publish before rendering Markdown', async () => {
    vi.useFakeTimers()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.mocked(window.api.previewResources.acquire).mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'preview-resources:acquire': ManagedFileVersionError: Managed file has no published version."
      )
    )
    vi.mocked(window.api.artifacts.readPreview).mockResolvedValue({
      content: '# Published report',
      encoding: 'utf8',
      size: 18,
      truncated: false
    })

    try {
      await renderFile(createFileItem({ format: 'markdown', name: 'report.md' }))

      expect(window.api.previewResources.acquire).toHaveBeenCalledOnce()
      await act(async () => vi.advanceTimersByTimeAsync(200))

      expect(container.textContent).toContain('Published report')
      expect(window.api.previewResources.acquire).toHaveBeenCalledTimes(2)
      expect(consoleError).not.toHaveBeenCalledWith(
        'Failed to read file preview',
        expect.anything()
      )
    } finally {
      consoleError.mockRestore()
      vi.useRealTimers()
    }
  })

  it('enables annotations for HTML Source but not HTML Render', async () => {
    vi.mocked(window.api.artifacts.readPreview).mockResolvedValue({
      content: '<main>selectable source</main>',
      encoding: 'utf8',
      size: 30,
      truncated: false
    })

    await renderFile(
      createFileItem({ format: 'html', name: 'report.html', projectId: 'project-1' }),
      { onAddAnnotation: vi.fn(() => undefined) }
    )

    expect(container.querySelector('iframe')).not.toBeNull()
    expect(container.querySelector('[data-preview-text-annotation-surface="true"]')).toBeNull()

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Show HTML source"]')?.click()
    })

    await vi.waitFor(() =>
      expect(
        container.querySelector('[data-preview-text-annotation-surface="true"]')
      ).not.toBeNull()
    )
  })

  it('does not expose text annotation surfaces for CSV previews', async () => {
    vi.mocked(window.api.artifacts.readPreview).mockResolvedValue({
      content: 'sample,value\ncontrol,1',
      encoding: 'utf8',
      size: 22,
      truncated: false
    })

    await renderFile(
      createFileItem({ format: 'csv', name: 'results.csv', projectId: 'project-1' }),
      { onAddAnnotation: vi.fn(() => undefined) }
    )

    expect(container.querySelector('table')).not.toBeNull()
    expect(container.querySelector('[data-preview-text-annotation-surface="true"]')).toBeNull()
  })

  it('reuses a loaded image when its preview is unmounted and mounted again', async () => {
    const fetchImage = vi.fn().mockResolvedValue(createCachedImageFetchResponse())
    vi.stubGlobal('fetch', fetchImage)
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL = vi.fn(() => 'blob:cached-chart')
        static revokeObjectURL = vi.fn()
      }
    )
    const image = createFileItem({
      format: 'image',
      name: 'chart.png',
      path: '/workspace/chart.png',
      mimeType: 'image/png',
      size: 2048,
      mtimeMs: 1710000000100
    })

    await renderFile(image)
    await vi.waitFor(() => expect(container.querySelector('img')).not.toBeNull())

    await act(async () => root.render(<div />))
    await act(async () => root.render(<PreviewFileContent item={image} />))
    await vi.waitFor(() => expect(container.querySelector('img')).not.toBeNull())

    expect(window.api.previewResources.acquire).toHaveBeenCalledTimes(1)
    expect(fetchImage).toHaveBeenCalledTimes(1)
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
  })

  it('shows the format-aware quiet progress state while a file is loading', async () => {
    vi.mocked(window.api.artifacts.readPreview).mockReturnValue(new Promise(() => undefined))

    await renderFile(
      createFileItem({ format: 'text', name: 'notes.txt', projectId: 'project-1' }),
      { onAddAnnotation: vi.fn(() => undefined) }
    )

    const status = container.querySelector('[data-preview-status="loading"]')
    expect(status?.getAttribute('role')).toBe('status')
    expect(status?.textContent).toContain('TXT')
    expect(status?.textContent).toContain('Preparing text file')
    expect(status?.textContent).toContain('notes.txt')
    expect(status?.querySelectorAll('[data-preview-activity-dot]')).toHaveLength(3)
    expect(status?.querySelector('[data-preview-progress]')).not.toBeNull()
    expect(container.querySelector('[data-preview-text-annotation-surface="true"]')).toBeNull()
  })

  it('restarts a failed preview when Retry is selected', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.mocked(window.api.artifacts.readPreview)
      .mockRejectedValueOnce(new Error('temporary read failure'))
      .mockResolvedValueOnce({
        content: 'recovered preview',
        encoding: 'utf8',
        size: 17,
        truncated: false
      })

    await renderFile(createFileItem({ format: 'text', name: 'notes.txt' }))
    await vi.waitFor(() => expect(container.textContent).toContain("File couldn't be read"))

    const retry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Retry'
    )
    expect(retry).toBeDefined()

    await act(async () => {
      retry?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    await vi.waitFor(() => expect(container.textContent).toContain('recovered preview'))
    expect(window.api.artifacts.readPreview).toHaveBeenCalledTimes(2)
    consoleError.mockRestore()
  })

  it('waits for managed logical identity refresh before restarting a failed preview', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let finishIdentityRefresh: (() => void) | undefined
    const onRetry = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishIdentityRefresh = resolve
        })
    )
    vi.mocked(window.api.artifacts.readPreview)
      .mockRejectedValueOnce(new Error('stale managed identity'))
      .mockResolvedValueOnce({
        content: 'logical preview',
        encoding: 'utf8',
        size: 15,
        truncated: false
      })

    await renderFile(createFileItem({ format: 'text', name: 'notes.txt' }), { onRetry })
    await vi.waitFor(() => expect(container.textContent).toContain("File couldn't be read"))
    const retry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Retry'
    )

    await act(async () => {
      retry?.click()
      retry?.click()
      await Promise.resolve()
    })

    expect(onRetry).toHaveBeenCalledOnce()
    expect(window.api.artifacts.readPreview).toHaveBeenCalledTimes(1)

    await act(async () => {
      finishIdentityRefresh?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    await vi.waitFor(() => expect(container.textContent).toContain('logical preview'))
    expect(window.api.artifacts.readPreview).toHaveBeenCalledTimes(2)
    consoleError.mockRestore()
  })

  it('retries with the refreshed logical identity instead of the stale physical path', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const legacyItem = createFileItem({
      managedFileId: undefined,
      path: '/stale/notes.txt',
      format: 'text',
      name: 'notes.txt'
    })
    const canonicalItem = {
      ...legacyItem,
      managedFileId: 'canonical-artifact-id',
      path: 'artifact-version:project-1/session-1/canonical-artifact-id/version-3'
    }
    vi.mocked(window.api.artifacts.readPreview).mockResolvedValue({
      content: 'logical preview',
      encoding: 'utf8',
      size: 15,
      truncated: false
    })
    const RetryHarness = (): React.JSX.Element => {
      const [currentItem, setCurrentItem] = useState(legacyItem)
      return (
        <PreviewFileContent
          item={currentItem}
          onRetry={async () => setCurrentItem(canonicalItem)}
        />
      )
    }

    root = createRoot(container)
    await act(async () => root.render(<RetryHarness />))
    await vi.waitFor(() => expect(container.textContent).toContain("File couldn't be read"))
    const retry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Retry'
    )

    await act(async () => {
      retry?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    await vi.waitFor(() => expect(container.textContent).toContain('logical preview'))
    expect(window.api.previewResources.acquire).toHaveBeenCalledOnce()
    expect(window.api.previewResources.acquire).toHaveBeenCalledWith({
      source: 'artifact',
      projectId: 'project-1',
      fileId: 'canonical-artifact-id',
      maxBytes: expect.any(Number)
    })
    consoleError.mockRestore()
  })

  it('formats valid JSON previews with indentation', async () => {
    vi.mocked(window.api.artifacts.readPreview).mockResolvedValue({
      content: '{"name":"sample","values":[1,true]}',
      encoding: 'utf8',
      size: 36,
      truncated: false
    })

    await renderFile(createFileItem({ format: 'json', name: 'data.json' }))

    expect(window.api.previewResources.acquire).toHaveBeenCalledWith({
      source: 'artifact',
      projectId: 'project-1',
      fileId: 'file-1',
      maxBytes: 1024 * 1024
    })
    expect(container.querySelector('pre')?.textContent).toContain('"name": "sample"')
    expect(container.querySelector('pre')?.textContent).toContain('"values": [')
  })

  it('renders line numbers next to text previews', async () => {
    vi.mocked(window.api.artifacts.readPreview).mockResolvedValue({
      content: 'alpha\nbeta',
      encoding: 'utf8',
      size: 10,
      truncated: false
    })

    await renderFile(createFileItem({ format: 'text', name: 'notes.txt' }))

    expect(container.querySelector('[data-testid="source-line-number"]')?.textContent).toBe('1')
    expect(container.textContent).toContain('alpha')
    expect(container.textContent).toContain('beta')
  })

  it('does not run highlight byte sizing for plain text previews', async () => {
    const OriginalTextEncoder = globalThis.TextEncoder
    const textEncoderSpy = vi.fn()
    vi.stubGlobal(
      'TextEncoder',
      class extends OriginalTextEncoder {
        constructor() {
          textEncoderSpy()
          super()
        }
      }
    )
    vi.mocked(window.api.artifacts.readPreview).mockResolvedValue({
      content: 'alpha\nbeta',
      encoding: 'utf8',
      size: 10,
      truncated: false
    })

    await renderFile(createFileItem({ format: 'text', name: 'notes.txt' }))

    expect(textEncoderSpy).not.toHaveBeenCalled()
    expect(highlightSpy).not.toHaveBeenCalled()
  })

  it('keeps source preview line numbers inside the grid column and inherited typography', async () => {
    vi.mocked(window.api.artifacts.readPreview).mockResolvedValue({
      content: Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n'),
      encoding: 'utf8',
      size: 86,
      truncated: false
    })

    await renderFile(createFileItem({ format: 'text', name: 'notes.txt' }))

    const lineNumber = container.querySelector<HTMLElement>('[data-testid="source-line-number"]')
    const row = lineNumber?.parentElement as HTMLElement | null
    expect(row?.style.gridTemplateColumns).toBe('3ch minmax(0, 1fr)')
    expect(lineNumber?.style.minWidth).toBe('')
    expect(row?.parentElement?.className).not.toContain('text-[13px]')
  })

  it('renders Python file previews with GitHub-style syntax tokens', async () => {
    vi.mocked(window.api.artifacts.readPreview).mockResolvedValue({
      content: 'import pandas as pd',
      encoding: 'utf8',
      size: 19,
      truncated: false
    })

    await renderFile(createFileItem({ format: 'code', name: 'analysis.py' }))

    await vi.waitFor(() =>
      expect(highlightSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'import pandas as pd',
          language: 'python'
        })
      )
    )
    const token = container.querySelector('[data-testid="source-code-token"]') as HTMLElement
    expect(token?.textContent).toBe('import')
    expect(token?.style.color).toBe('rgb(9, 105, 218)')
    expect(token?.style.getPropertyValue('--shiki-dark')).toBe('#79c0ff')
    expect(container.querySelector('[data-testid="source-line-number"]')?.textContent).toBe('1')
  })

  it('renders R file previews with R syntax tokens', async () => {
    vi.mocked(window.api.artifacts.readPreview).mockResolvedValue({
      content: 'library(ggplot2)',
      encoding: 'utf8',
      size: 16,
      truncated: false
    })

    await renderFile(createFileItem({ format: 'code', name: 'plot.r' }))

    await vi.waitFor(() =>
      expect(highlightSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'library(ggplot2)',
          language: 'r'
        })
      )
    )
  })

  it('falls back to the current source when cached highlight tokens belong to another file', async () => {
    vi.mocked(window.api.artifacts.readPreview).mockResolvedValue({
      content: 'print("fresh")',
      encoding: 'utf8',
      size: 14,
      truncated: false
    })

    await renderFile(createFileItem({ format: 'code', name: 'analysis.py' }))

    await vi.waitFor(() => expect(highlightSpy).toHaveBeenCalled())
    expect(container.textContent).toContain('print("fresh")')
    expect(container.textContent).not.toContain('print("stale")')
    expect(container.querySelector('[data-testid="source-code-token"]')).toBeNull()
  })

  it('renders large code previews as plain source without running syntax highlighting', async () => {
    const largeSource = Array.from(
      { length: 14_000 },
      (_, index) => `import pandas as pd # ${index}`
    ).join('\n')
    vi.mocked(window.api.artifacts.readPreview).mockResolvedValue({
      content: largeSource,
      encoding: 'utf8',
      size: largeSource.length,
      truncated: false
    })

    await renderFile(createFileItem({ format: 'code', name: 'large.py' }))

    expect(container.textContent).toContain('import pandas as pd # 13999')
    expect(highlightSpy).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="source-code-token"]')).toBeNull()
  })

  it('renders a truncated TSV table with bounded rows and columns', async () => {
    const headers = Array.from({ length: 26 }, (_, index) => `column-${index + 1}`)
    const rows = Array.from({ length: 101 }, (_, rowIndex) =>
      headers.map((_, columnIndex) => `r${rowIndex + 1}c${columnIndex + 1}`).join('\t')
    )
    vi.mocked(window.api.artifacts.readPreview).mockResolvedValue({
      content: [headers.join('\t'), ...rows].join('\n'),
      encoding: 'utf8',
      size: 10_000,
      truncated: true
    })

    await renderFile(createFileItem({ format: 'csv', name: 'measurements.tsv' }))

    expect(container.textContent).toContain('100+ rows · 26 columns')
    expect(container.textContent).toContain('Showing 100 rows · 24 columns')
    expect(container.textContent).toContain('2 more columns hidden in this preview')
    expect(container.textContent).toContain('r1c1')
    expect(container.textContent).not.toContain('r101c1')
  })

  it('shows the parser error without discarding CSV rows that can still be previewed', async () => {
    vi.mocked(window.api.artifacts.readPreview).mockResolvedValue({
      content: 'sample,value\ncontrol,1\n"incomplete,2',
      encoding: 'utf8',
      size: 37,
      truncated: false
    })

    await renderFile(createFileItem({ format: 'csv', name: 'results.csv' }))

    expect(container.textContent).toContain('control')
    expect(container.querySelector('.text-danger-000')?.textContent).not.toBe('')
  })

  it('loads the next bounded page of a large text preview on demand', async () => {
    vi.mocked(window.api.artifacts.readPreview).mockImplementation(async (request) =>
      request.offset === 5
        ? ({
            content: 'second page',
            encoding: 'utf8',
            size: 16,
            offset: 5,
            truncated: false
          } as never)
        : ({
            content: 'first',
            encoding: 'utf8',
            size: 16,
            offset: 0,
            nextOffset: 5,
            truncated: true
          } as never)
    )

    await renderFile(
      createFileItem({ format: 'text', name: 'large.txt', path: '/workspace/large.txt' })
    )
    expect(container.textContent).toContain('first')

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Next preview page"]')?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(fetch).toHaveBeenLastCalledWith(
      'open-science-preview://resource-2/file-1',
      expect.objectContaining({ headers: { Range: expect.stringMatching(/^bytes=5-/u) } })
    )
    expect(container.textContent).toContain('second page')
    expect(container.textContent).not.toContain('first')
  })

  // Degradation for design §20.4: a session-referenced file deleted from disk (or on a
  // disconnected drive) must surface a handled "unavailable" state instead of crashing or
  // blanking - readManagedFilePreview rejects with ENOENT, and the renderer must catch it.
  it('shows an unavailable message instead of crashing when the file no longer exists on disk', async () => {
    const enoent = Object.assign(new Error('ENOENT: no such file or directory'), {
      code: 'ENOENT'
    })
    vi.mocked(window.api.artifacts.readPreview).mockRejectedValue(enoent)

    await renderFile(
      createFileItem({ format: 'text', name: 'gone.txt', path: '/workspace/gone.txt' })
    )

    expect(container.textContent).toContain('This file is no longer available')
    expect(container.querySelector('pre')).toBeNull()

    const retry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Retry'
    )
    expect(retry).toBeDefined()

    await act(async () => {
      retry?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(window.api.artifacts.readPreview).toHaveBeenCalledTimes(2)
    expect(window.api.artifacts.openFile).not.toHaveBeenCalled()
  })

  it('keeps the unavailable classification when a managed fetch returns 404 after acquire', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 404 }))

    await renderFile(
      createFileItem({ format: 'text', name: 'gone.txt', path: '/workspace/gone.txt' })
    )

    expect(container.textContent).toContain('This file is no longer available')
    expect(container.querySelector('pre')).toBeNull()
    expect(consoleError).not.toHaveBeenCalledWith('Failed to read file preview', expect.anything())
    expect(window.api.previewResources.release).toHaveBeenCalledWith({
      resourceId: 'resource-1'
    })

    consoleError.mockRestore()
  })

  it('renders line numbers next to formatted JSON previews', async () => {
    vi.mocked(window.api.artifacts.readPreview).mockResolvedValue({
      content: '{"name":"sample","values":[1,true]}',
      encoding: 'utf8',
      size: 36,
      truncated: false
    })

    await renderFile(createFileItem({ format: 'json', name: 'data.json' }))

    expect(container.querySelector('[data-testid="source-line-number"]')?.textContent).toBe('1')
    expect(container.textContent).toContain('"name": "sample"')
  })

  it('uses paged source instead of parsing truncated JSON', async () => {
    vi.mocked(window.api.artifacts.readPreview).mockResolvedValue({
      content: '{"partial":',
      encoding: 'utf8',
      size: 20,
      offset: 0,
      nextOffset: 11,
      truncated: true
    })

    await renderFile(createFileItem({ format: 'json', name: 'large.json' }))

    expect(container.querySelector('[aria-label="Next preview page"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="source-line-number"]')).not.toBeNull()
    expect(container.textContent).not.toContain('Invalid JSON')
  })

  it('uses paged source instead of rich rendering for truncated Markdown', async () => {
    vi.mocked(window.api.artifacts.readPreview).mockResolvedValue({
      content: '# Partial report',
      encoding: 'utf8',
      size: 40,
      offset: 0,
      nextOffset: 16,
      truncated: true
    })

    await renderFile(createFileItem({ format: 'markdown', name: 'large.md' }))

    expect(container.querySelector('[aria-label="Next preview page"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="source-line-number"]')).not.toBeNull()
  })

  it('uses paged source instead of parsing a truncated molecule record', async () => {
    vi.mocked(window.api.artifacts.readPreview).mockResolvedValue({
      content: 'partial molecule record',
      encoding: 'utf8',
      size: 40,
      offset: 0,
      nextOffset: 23,
      truncated: true
    })

    await renderFile(createFileItem({ format: 'molecule', name: 'large.mol' }))

    expect(container.querySelector('[aria-label="Next preview page"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="source-line-number"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Structure preview of large.mol"]')).toBeNull()
  })

  it('renders HTML from a managed stream inside a script sandbox', async () => {
    await renderFile(createFileItem({ format: 'html', name: 'report.html' }))

    const iframe = container.querySelector('iframe')
    expect(iframe).not.toBeNull()
    expect(iframe?.getAttribute('sandbox')).toBe('allow-scripts')
    expect(iframe?.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(iframe?.getAttribute('src')).toBe('open-science-preview://resource-1/file-1')
    expect(iframe?.hasAttribute('srcdoc')).toBe(false)
    expect(window.api.artifacts.readPreview).not.toHaveBeenCalled()
    expect(registerPreviewFrameSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        frameUrl: 'open-science-preview://resource-1/file-1',
        enabled: true,
        frameRef: expect.objectContaining({ current: iframe })
      })
    )
  })

  it.each(['artifact', 'upload'] as const)(
    'keeps the HTML %s preview usable when its logical identity is missing',
    async (source) => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

      await renderFile(
        createFileItem({
          id: source === 'upload' ? 'upload:legacy-html' : 'legacy-artifact-version',
          source,
          format: 'html',
          name: 'legacy.html',
          title: 'legacy.html',
          path: '/managed/must-not-be-read-by-path/legacy.html',
          managedFileId: undefined
        })
      )

      expect(container.querySelector('iframe')).toBeNull()
      expect(container.textContent).toContain("HTML couldn't be read for preview")
      expect(container.querySelector('[aria-label="Show rendered HTML"]')).not.toBeNull()
      expect(container.querySelector('[aria-label="Show HTML source"]')).not.toBeNull()
      expect(window.api.previewResources.acquire).not.toHaveBeenCalled()
      expect(window.api.artifacts.readPreview).not.toHaveBeenCalled()
      expect(window.api.uploads.readPreview).not.toHaveBeenCalled()

      await act(async () => {
        container.querySelector<HTMLButtonElement>('[aria-label="Show HTML source"]')?.click()
      })

      await vi.waitFor(() =>
        expect(
          container.querySelector('[aria-label="Show HTML source"]')?.getAttribute('aria-pressed')
        ).toBe('true')
      )
      expect(container.textContent).toContain("HTML couldn't be read for preview")
      expect(window.api.previewResources.acquire).not.toHaveBeenCalled()
      expect(window.api.artifacts.readPreview).not.toHaveBeenCalled()
      expect(window.api.uploads.readPreview).not.toHaveBeenCalled()

      consoleError.mockRestore()
    }
  )

  it('falls back when the managed HTML URL cannot be loaded', async () => {
    await renderFile(createFileItem({ format: 'html', name: 'report.html' }))
    const iframe = container.querySelector('iframe')

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: 'open-science-preview-load-error',
          source: iframe?.contentWindow ?? null
        })
      )
    })

    expect(container.querySelector('iframe')).toBeNull()
    expect(container.textContent).toContain("HTML couldn't be read for preview")
    expect(window.api.previewResources.release).toHaveBeenCalledWith({
      resourceId: 'resource-1'
    })

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Show HTML source"]')?.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(window.api.artifacts.readPreview).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'file-1', projectId: 'project-1', offset: 0 })
    )
  })

  it('can switch HTML previews to numbered source', async () => {
    vi.mocked(window.api.artifacts.readPreview).mockResolvedValue({
      content: '<!doctype html>\n<h1>Report</h1>',
      encoding: 'utf8',
      size: 31,
      truncated: false
    })

    await renderFile(createFileItem({ format: 'html', name: 'report.html' }))

    vi.mocked(window.api.artifacts.readPreview).mockClear()

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Show HTML source"]')?.click()
    })

    expect(container.querySelector('[data-testid="source-line-number"]')?.textContent).toBe('1')
    expect(container.textContent).toContain('<h1>Report</h1>')
    expect(window.api.artifacts.readPreview).toHaveBeenCalledTimes(1)
    expect(registerPreviewFrameSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ frameUrl: '', enabled: false })
    )
  })

  it('renders FASTA previews as plain text with line numbers', async () => {
    vi.mocked(window.api.artifacts.readPreview).mockResolvedValue({
      content: '>seq1\nACGT\n>seq2\nTTAA',
      encoding: 'utf8',
      size: 22,
      truncated: false
    })

    await renderFile(createFileItem({ format: 'fasta', name: 'sample.fasta' }))

    expect(container.textContent).toContain('1')
    expect(container.textContent).toContain('>seq1')
    expect(container.textContent).toContain('2')
    expect(container.textContent).toContain('ACGT')
    expect(container.textContent).not.toContain('Sequences')
    expect(container.textContent).not.toContain('GC')
  })

  describe('PDB previews', () => {
    beforeEach(() => {
      restorePdbLayoutMocks = installPdbLayoutMocks()
    })

    it('uses paged source instead of constructing a partial 3D model', async () => {
      vi.mocked(window.api.artifacts.readPreview).mockResolvedValue({
        content: 'ATOM      1  N   MET A',
        encoding: 'utf8',
        size: 48,
        offset: 0,
        nextOffset: 23,
        truncated: true
      })

      await renderFile(createFileItem({ format: 'pdb', name: 'large.pdb' }))

      expect(createViewer).not.toHaveBeenCalled()
      expect(container.querySelector('[aria-label="Next preview page"]')).not.toBeNull()
      expect(container.querySelector('[data-testid="source-line-number"]')).not.toBeNull()
    })

    it('renders PDB previews with 3Dmol style controls and model metadata', async () => {
      const pdbContent = [
        'ATOM      1  N   MET A   1      20.154  34.198  27.426  1.00 45.22           N',
        'ATOM      2  CA  MET A   1      21.567  34.361  27.100  1.00 44.13           C',
        'ATOM      3  N   GLY A   2      22.154  35.198  27.426  1.00 45.22           N',
        'ATOM      4  CA  GLY A   2      23.567  35.361  27.100  1.00 44.13           C',
        'END'
      ].join('\n')
      vi.mocked(window.api.artifacts.readPreview).mockResolvedValue({
        content: pdbContent,
        encoding: 'utf8',
        size: pdbContent.length,
        truncated: false
      })

      await renderFile(
        createFileItem({
          format: 'pdb' as PreviewFileItem['format'],
          name: 'protein.pdb'
        })
      )

      expect(container.textContent).toContain('Using 3Dmol.js viewer')
      expect(container.textContent).toContain('4 atoms')
      expect(container.querySelector('button[aria-pressed="true"]')?.textContent).toBe('Cartoon')
      expect(container.textContent).toContain('Drag to rotate')
      expect(container.textContent).toContain('Scroll to zoom')
      expect(createViewer).toHaveBeenCalledTimes(1)
      expect(addModel).toHaveBeenCalledWith(pdbContent, 'pdb', {
        assignBonds: true,
        noComputeSecondaryStructure: false
      })
      expect(setStyle).toHaveBeenCalledWith(
        {},
        {
          cartoon: { color: 'spectrum' },
          stick: { colorscheme: 'Jmol', opacity: 0.22, radius: 0.035 }
        }
      )
      expect(zoomTo).toHaveBeenCalled()
      expect(renderViewer).toHaveBeenCalled()
    })

    it('defaults small-molecule PDB previews to stick instead of cartoon', async () => {
      const pdbContent = [
        'HETATM    1  C1  UNL     1       4.821   1.926  -1.639  1.00  0.00           C',
        'HETATM    2  O1  UNL     1       5.761  -1.624  -0.292  1.00  0.00           O',
        'CONECT    1    2',
        'END'
      ].join('\n')
      vi.mocked(window.api.artifacts.readPreview).mockResolvedValue({
        content: pdbContent,
        encoding: 'utf8',
        size: pdbContent.length,
        truncated: false
      })

      await renderFile(
        createFileItem({
          format: 'pdb' as PreviewFileItem['format'],
          name: 'cefradine.pdb'
        })
      )

      const cartoonButton = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Cartoon'
      )

      expect(cartoonButton).not.toBeUndefined()
      expect(cartoonButton?.getAttribute('aria-disabled')).toBe('true')
      expect(cartoonButton?.title).toBe('Cartoon requires a protein or nucleic-acid backbone')
      expect(cartoonButton?.getAttribute('aria-describedby')).toBeTruthy()
      expect(container.querySelector('button[aria-pressed="true"]')?.textContent).toBe('Stick')
      expect(setStyle).toHaveBeenCalledWith({}, { stick: { radius: 0.18, colorscheme: 'Jmol' } })
    })

    it('does not enable cartoon for ligand atoms that happen to be named CA', async () => {
      const pdbContent = [
        'ATOM      1 CA   UNL A   1       4.821   1.926  -1.639  1.00  0.00          Ca',
        'ATOM      2 CA   UNL A   2       5.761  -1.624  -0.292  1.00  0.00          Ca',
        'END'
      ].join('\n')
      vi.mocked(window.api.artifacts.readPreview).mockResolvedValue({
        content: pdbContent,
        encoding: 'utf8',
        size: pdbContent.length,
        truncated: false
      })

      await renderFile(
        createFileItem({
          format: 'pdb' as PreviewFileItem['format'],
          name: 'calcium-ligand.pdb'
        })
      )

      const cartoonButton = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Cartoon'
      )

      expect(cartoonButton?.getAttribute('aria-disabled')).toBe('true')
      expect(container.querySelector('button[aria-pressed="true"]')?.textContent).toBe('Stick')
    })

    it('renders PDB surfaces after 3Dmol finishes generating them', async () => {
      const pdbContent = [
        'ATOM      1  N   MET A   1      20.154  34.198  27.426  1.00 45.22           N',
        'ATOM      2  CA  MET A   1      21.567  34.361  27.100  1.00 44.13           C',
        'END'
      ].join('\n')
      let resolveSurface!: () => void
      addSurface.mockReturnValueOnce(
        new Promise<void>((resolve) => {
          resolveSurface = resolve
        })
      )
      vi.mocked(window.api.artifacts.readPreview).mockResolvedValue({
        content: pdbContent,
        encoding: 'utf8',
        size: pdbContent.length,
        truncated: false
      })

      await renderFile(
        createFileItem({
          format: 'pdb' as PreviewFileItem['format'],
          name: 'protein.pdb'
        })
      )

      renderViewer.mockClear()
      await act(async () => {
        Array.from(container.querySelectorAll('button'))
          .find((button) => button.textContent === 'Surface')
          ?.click()
      })

      expect(addSurface).toHaveBeenCalledWith(
        'VDW',
        expect.objectContaining({ colorscheme: 'Jmol' }),
        {}
      )
      expect(renderViewer).toHaveBeenCalledTimes(1)

      await act(async () => {
        resolveSurface()
      })

      expect(renderViewer).toHaveBeenCalledTimes(2)
    })

    it('does not render a stale PDB surface after switching styles', async () => {
      const pdbContent = [
        'ATOM      1  N   MET A   1      20.154  34.198  27.426  1.00 45.22           N',
        'ATOM      2  CA  MET A   1      21.567  34.361  27.100  1.00 44.13           C',
        'END'
      ].join('\n')
      let resolveSurface!: () => void
      addSurface.mockReturnValueOnce(
        new Promise<void>((resolve) => {
          resolveSurface = resolve
        })
      )
      vi.mocked(window.api.artifacts.readPreview).mockResolvedValue({
        content: pdbContent,
        encoding: 'utf8',
        size: pdbContent.length,
        truncated: false
      })

      await renderFile(
        createFileItem({
          format: 'pdb' as PreviewFileItem['format'],
          name: 'protein.pdb'
        })
      )

      renderViewer.mockClear()
      await act(async () => {
        Array.from(container.querySelectorAll('button'))
          .find((button) => button.textContent === 'Surface')
          ?.click()
      })
      expect(renderViewer).toHaveBeenCalledTimes(1)

      await act(async () => {
        Array.from(container.querySelectorAll('button'))
          .find((button) => button.textContent === 'Stick')
          ?.click()
      })
      expect(renderViewer).toHaveBeenCalledTimes(2)

      await act(async () => {
        resolveSurface()
      })

      expect(renderViewer).toHaveBeenCalledTimes(2)
    })

    it('waits for the PDB viewer to have layout size before first render', async () => {
      const pdbContent = [
        'ATOM      1  N   MET A   1      20.154  34.198  27.426  1.00 45.22           N',
        'ATOM      2  CA  MET A   1      21.567  34.361  27.100  1.00 44.13           C',
        'END'
      ].join('\n')
      previewElementWidth = 0
      previewElementHeight = 0
      vi.mocked(window.api.artifacts.readPreview).mockResolvedValue({
        content: pdbContent,
        encoding: 'utf8',
        size: pdbContent.length,
        truncated: false
      })

      await renderFile(
        createFileItem({
          format: 'pdb' as PreviewFileItem['format'],
          name: 'protein.pdb'
        })
      )

      expect(createViewer).toHaveBeenCalledTimes(1)
      expect(renderViewer).not.toHaveBeenCalled()

      previewElementWidth = 720
      previewElementHeight = 480
      await act(async () => {
        for (const callback of resizeObserverCallbacks) {
          callback([], {} as ResizeObserver)
        }
      })

      expect(resizeViewer).toHaveBeenCalled()
      expect(renderViewer).toHaveBeenCalled()
    })
  })

  it('reads upload-sourced text previews through a managed upload resource', async () => {
    vi.mocked(window.api.uploads.readPreview).mockResolvedValue({
      content: 'uploaded content',
      encoding: 'utf8',
      size: 16,
      truncated: false
    })

    await renderFile(
      createFileItem({
        id: 'upload:file-1',
        source: 'upload',
        format: 'text',
        name: 'notes.txt',
        path: '/Users/example/.open-science/uploads/default-project/session-1/notes.txt'
      })
    )

    expect(window.api.previewResources.acquire).toHaveBeenCalledWith({
      source: 'upload',
      projectId: 'project-1',
      fileId: 'file-1',
      maxBytes: 1024 * 1024
    })
    expect(window.api.artifacts.readPreview).not.toHaveBeenCalled()
    expect(container.textContent).toContain('uploaded content')
  })
})
