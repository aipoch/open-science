// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PreviewFileItem } from '@/stores/preview-workbench-store'
import { PreviewFileContent } from './PreviewFileContent'

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

let previewElementWidth = 640
let previewElementHeight = 480
let resizeObserverCallbacks: ResizeObserverCallback[] = []
let restorePdbLayoutMocks: (() => void) | undefined

const createFileItem = (overrides: Partial<PreviewFileItem>): PreviewFileItem => ({
  id: 'file-1',
  sessionId: 'session-1',
  title: 'data.json',
  type: 'file',
  path: '/workspace/data.json',
  name: 'data.json',
  format: 'json',
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
      previewResources: {
        acquire: vi.fn().mockResolvedValue({
          id: 'resource-1',
          url: 'open-science-preview://resource-1/report.html',
          size: 88,
          mimeType: 'text/html; charset=utf-8',
          version: 1
        }),
        readRange: vi.fn(),
        release: vi.fn().mockResolvedValue(undefined)
      },
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
        stageFiles: vi.fn(),
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
    vi.clearAllMocks()
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    container.remove()
    restorePdbLayoutMocks?.()
    restorePdbLayoutMocks = undefined
  })

  const renderFile = async (item: PreviewFileItem): Promise<void> => {
    root = createRoot(container)
    await act(async () => {
      root.render(<PreviewFileContent item={item} />)
    })
  }

  it('shows the format-aware quiet progress state while a file is loading', async () => {
    vi.mocked(window.api.artifacts.readPreview).mockReturnValue(new Promise(() => undefined))

    await renderFile(createFileItem({ format: 'text', name: 'notes.txt' }))

    const status = container.querySelector('[data-preview-status="loading"]')
    expect(status?.getAttribute('role')).toBe('status')
    expect(status?.textContent).toContain('TXT')
    expect(status?.textContent).toContain('Preparing text file')
    expect(status?.textContent).toContain('notes.txt')
    expect(status?.querySelectorAll('[data-preview-activity-dot]')).toHaveLength(3)
    expect(status?.querySelector('[data-preview-progress]')).not.toBeNull()
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

  it('formats valid JSON previews with indentation', async () => {
    vi.mocked(window.api.artifacts.readPreview).mockResolvedValue({
      content: '{"name":"sample","values":[1,true]}',
      encoding: 'utf8',
      size: 36,
      truncated: false
    })

    await renderFile(createFileItem({ format: 'json', name: 'data.json' }))

    expect(window.api.artifacts.readPreview).toHaveBeenCalledWith({
      path: '/workspace/data.json',
      maxBytes: 1024 * 1024,
      encoding: 'utf8',
      offset: 0
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

    expect(window.api.artifacts.readPreview).toHaveBeenLastCalledWith({
      path: '/workspace/large.txt',
      maxBytes: 1024 * 1024,
      encoding: 'utf8',
      offset: 5
    })
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
    expect(iframe?.getAttribute('src')).toBe('open-science-preview://resource-1/report.html')
    expect(iframe?.hasAttribute('srcdoc')).toBe(false)
    expect(window.api.artifacts.readPreview).not.toHaveBeenCalled()
  })

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
      expect.objectContaining({ path: '/workspace/data.json', offset: 0 })
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

  it('reads upload-sourced text previews through the uploads API', async () => {
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

    expect(window.api.uploads.readPreview).toHaveBeenCalledWith({
      path: '/Users/example/.open-science/uploads/default-project/session-1/notes.txt',
      maxBytes: 1024 * 1024,
      encoding: 'utf8',
      offset: 0
    })
    expect(window.api.artifacts.readPreview).not.toHaveBeenCalled()
    expect(container.textContent).toContain('uploaded content')
  })
})
