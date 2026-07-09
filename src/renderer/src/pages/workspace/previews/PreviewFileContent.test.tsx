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
      encoding: 'utf8'
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

  it('renders HTML previews inside a scriptless sandboxed iframe', async () => {
    vi.mocked(window.api.artifacts.readPreview).mockResolvedValue({
      content:
        '<!doctype html><h1>Report</h1><script>window.top.location="https://example.com"</script>',
      encoding: 'utf8',
      size: 88,
      truncated: false
    })

    await renderFile(createFileItem({ format: 'html', name: 'report.html' }))

    const iframe = container.querySelector('iframe')
    expect(iframe).not.toBeNull()
    expect(iframe?.getAttribute('sandbox')).toBe('')
    expect(iframe?.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(iframe?.getAttribute('srcdoc')).toContain('<h1>Report</h1>')
  })

  it('can switch HTML previews to numbered source', async () => {
    vi.mocked(window.api.artifacts.readPreview).mockResolvedValue({
      content: '<!doctype html>\n<h1>Report</h1>',
      encoding: 'utf8',
      size: 31,
      truncated: false
    })

    await renderFile(createFileItem({ format: 'html', name: 'report.html' }))

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Show HTML source"]')?.click()
    })

    expect(container.querySelector('[data-testid="source-line-number"]')?.textContent).toBe('1')
    expect(container.textContent).toContain('<h1>Report</h1>')
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
      encoding: 'utf8'
    })
    expect(window.api.artifacts.readPreview).not.toHaveBeenCalled()
    expect(container.textContent).toContain('uploaded content')
  })
})
