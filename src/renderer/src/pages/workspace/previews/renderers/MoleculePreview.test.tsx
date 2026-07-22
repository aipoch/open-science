// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PreviewFileItem } from '@/stores/preview-workbench-store'

const mocks = vi.hoisted(() => ({
  state: { current: undefined as unknown },
  fromSmiles: vi.fn(),
  fromMolfile: vi.fn()
}))

vi.mock('../usePreviewFileContent', () => ({
  usePreviewFileContent: (): unknown => mocks.state.current
}))
vi.mock('openchemlib', () => ({
  Molecule: {
    fromSmiles: mocks.fromSmiles,
    fromMolfile: mocks.fromMolfile
  }
}))

import { MoleculePreviewRenderer } from './MoleculePreview'

const item = (name: string): PreviewFileItem => ({
  id: `artifact:${name}`,
  sessionId: 'session-1',
  title: name,
  type: 'file',
  path: `/workspace/${name}`,
  name,
  format: 'molecule'
})

const readyState = (content: string, overrides: Record<string, unknown> = {}): unknown => ({
  status: 'ready',
  preview: { content, encoding: 'utf8', truncated: false, ...overrides },
  pagination: {
    pageNumber: 1,
    hasPrevious: false,
    hasNext: false,
    previousPage: vi.fn(),
    nextPage: vi.fn()
  }
})

describe('MoleculePreviewRenderer', () => {
  let container: HTMLDivElement
  let root: Root
  let restoreLayout: (() => void) | undefined

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    mocks.fromSmiles.mockReset()
    mocks.fromMolfile.mockReset()
    const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
    const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => 640
    })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => 400
    })
    restoreLayout = () => {
      if (width) Object.defineProperty(HTMLElement.prototype, 'clientWidth', width)
      else delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
      if (height) Object.defineProperty(HTMLElement.prototype, 'clientHeight', height)
      else delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
    }
  })

  afterEach(async () => {
    await act(async () => root?.unmount())
    container.remove()
    restoreLayout?.()
  })

  const render = async (file: PreviewFileItem): Promise<void> => {
    root = createRoot(container)
    await act(async () => {
      root.render(<MoleculePreviewRenderer item={file} />)
      await Promise.resolve()
    })
  }

  it('renders SMILES through OpenChemLib with the available canvas size', async () => {
    const toSVG = vi.fn(() => '<svg data-testid="molecule-svg"></svg>')
    mocks.fromSmiles.mockReturnValue({ toSVG })
    mocks.state.current = readyState('CCO')

    await render(item('ethanol.smi'))
    await vi.waitFor(() => expect(mocks.fromSmiles).toHaveBeenCalledWith('CCO'))

    expect(toSVG).toHaveBeenCalledWith(
      640,
      400,
      expect.stringMatching(/^mol-/),
      expect.objectContaining({ autoCrop: true, autoCropMargin: 16 })
    )
    expect(container.querySelector('[data-testid="molecule-svg"]')).not.toBeNull()
  })

  it('shows an in-place rendering error when OpenChemLib rejects a molecule', async () => {
    mocks.fromSmiles.mockImplementation(() => {
      throw new Error('invalid SMILES')
    })
    mocks.state.current = readyState('not-a-smiles')

    await render(item('broken.smi'))
    await vi.waitFor(() => expect(container.textContent).toContain('invalid SMILES'))

    expect(container.textContent).toContain('Structure could not be rendered')
  })

  it('uses source content rather than attempting to parse an incomplete molecule fragment', async () => {
    mocks.state.current = readyState('partial molfile', { truncated: true })

    await render(item('large.sdf'))

    expect(container.textContent).toContain('partial molfile')
    expect(mocks.fromMolfile).not.toHaveBeenCalled()
  })

  it('uses the structure fallback for non-UTF8 previews', async () => {
    mocks.state.current = readyState('AAECAw==', { encoding: 'base64' })

    await render(item('binary.mol'))

    expect(container.textContent).toContain("Structure file couldn't be read for preview")
    expect(mocks.fromMolfile).not.toHaveBeenCalled()
  })
})
