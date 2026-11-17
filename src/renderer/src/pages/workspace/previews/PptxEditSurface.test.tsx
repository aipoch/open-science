// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { PreviewFileItem } from '@/stores/preview-workbench-contract'
import type { DeckOutline } from '../../../../../shared/pptx-edit'
import { PptxEditSurface } from './PptxEditSurface'
import type { PptxEditSession } from './use-pptx-edit-session'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string | number>) =>
      key.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values?.[name] ?? ''))
  })
}))

vi.mock('./renderers/OfficePreview', () => ({
  OfficePreviewContent: ({
    staged
  }: {
    staged?: { key: string; slideIndex: number; onSlideView: (view: unknown) => void }
  }) => {
    const report = (slideIndex: number): void =>
      staged?.onSlideView({ sessionId: 's', slideIndex, x: 0, y: 0, width: 914.4, height: 514.35 })
    return (
      <>
        <button
          type="button"
          data-testid="staged-preview"
          data-key={staged?.key}
          data-slide={staged?.slideIndex}
          onClick={() => report(staged?.slideIndex ?? 0)}
        />
        {/* Stands in for the user paging forward inside the preview frame. */}
        <button
          type="button"
          data-testid="staged-next"
          onClick={() => report((staged?.slideIndex ?? 0) + 1)}
        />
      </>
    )
  }
}))

beforeAll(() => {
  HTMLElement.prototype.setPointerCapture = vi.fn()
})
afterEach(cleanup)

const outline = {
  slideSize: { cx: 9_144_000, cy: 5_143_500 },
  layouts: [],
  slides: [
    {
      slideId: 256,
      index: 0,
      part: 'ppt/slides/slide1.xml',
      notes: '',
      shapes: [
        {
          shapeId: 2,
          name: 'Title',
          kind: 'text',
          text: 'Hello',
          frame: { x: 914_400, y: 457_200, w: 1_828_800, h: 914_400, rotationDeg: 0 }
        }
      ]
    }
  ]
} as unknown as DeckOutline

const frame = { x: 914_400, y: 457_200, w: 1_828_800, h: 914_400, rotationDeg: 0 }

const richOutline = {
  slideSize: { cx: 9_144_000, cy: 5_143_500 },
  layouts: [],
  slides: [
    {
      slideId: 256,
      index: 0,
      part: 'ppt/slides/slide1.xml',
      notes: 'Opening',
      shapes: [
        { shapeId: 3, name: 'Grid', kind: 'table', frame, table: [['A', 'B']] },
        { shapeId: 4, name: 'Logo', kind: 'picture', frame: { ...frame, y: 2_000_000 } }
      ]
    },
    {
      slideId: 257,
      index: 1,
      part: 'ppt/slides/slide2.xml',
      notes: '',
      shapes: [
        {
          shapeId: 5,
          name: 'Sales',
          kind: 'chart',
          frame,
          chart: { title: 'Sales', series: [{ name: 'North', categories: ['Q1'] }] }
        }
      ]
    }
  ]
} as unknown as DeckOutline

const richSession = (overrides: Partial<PptxEditSession> = {}): PptxEditSession =>
  createSession({ view: { stagedKey: 'edit-1:1', outline: richOutline } as never, ...overrides })

const shapeAt = (shapeId: number): HTMLElement =>
  document.querySelector(`[data-shape-id="${shapeId}"]`) as HTMLElement

const item = { id: 'i', name: 'deck.pptx' } as unknown as PreviewFileItem

const createSession = (overrides: Partial<PptxEditSession> = {}): PptxEditSession =>
  ({
    phase: 'ready',
    view: { stagedKey: 'edit-1:1', outline },
    state: { operations: [], redo: [] },
    failed: false,
    dirty: false,
    canUndo: false,
    canRedo: false,
    addOperation: vi.fn().mockResolvedValue(true),
    addOperations: vi.fn().mockResolvedValue(true),
    undo: vi.fn().mockResolvedValue(true),
    redo: vi.fn().mockResolvedValue(true),
    ...overrides
  }) as unknown as PptxEditSession

const renderSurface = (session: PptxEditSession, saving = false): void => {
  render(<PptxEditSurface item={item} source="artifact" session={session} saving={saving} />)
}

describe('PptxEditSurface', () => {
  it('renders nothing until the session has a view', () => {
    renderSurface(createSession({ view: undefined }))
    expect(screen.queryByTestId('pptx-edit-surface')).toBeNull()
  })

  it('opens the staged revision and applies toolbar operations', () => {
    const session = createSession()
    renderSurface(session)
    expect(screen.getByTestId('staged-preview').getAttribute('data-key')).toBe('edit-1:1')
    fireEvent.click(screen.getByLabelText('Add slide'))
    expect(session.addOperations).toHaveBeenCalledWith([{ op: 'addSlide', afterSlideId: 256 }])
    fireEvent.click(screen.getByLabelText('Duplicate slide'))
    expect(session.addOperations).toHaveBeenCalledWith([{ op: 'duplicateSlide', slideId: 256 }])
    fireEvent.click(screen.getByLabelText('Add text box'))
    expect(session.addOperations).toHaveBeenCalledWith([
      expect.objectContaining({ op: 'addTextbox', slideId: 256 })
    ])
  })

  it('disables every tool while busy and shows failures', () => {
    renderSurface(createSession({ failed: true, canUndo: true }), true)
    expect(screen.getByLabelText('Add slide')).toHaveProperty('disabled', true)
    expect(screen.getByLabelText('Undo')).toHaveProperty('disabled', true)
    expect(screen.getByRole('alert').textContent).toBe('That change could not be applied.')
  })

  it('routes undo and redo to the session', () => {
    const session = createSession({ canUndo: true, canRedo: true })
    renderSurface(session)
    fireEvent.click(screen.getByLabelText('Undo'))
    fireEvent.click(screen.getByLabelText('Redo'))
    expect(session.undo).toHaveBeenCalledTimes(1)
    expect(session.redo).toHaveBeenCalledTimes(1)
  })

  it('reorders and deletes slides and follows the moved slide', async () => {
    const session = richSession()
    renderSurface(session)
    expect(screen.getByLabelText('Move slide earlier')).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByLabelText('Move slide later'))
    expect(session.addOperations).toHaveBeenCalledWith([
      { op: 'moveSlide', slideId: 256, toIndex: 1 }
    ])
    await waitFor(() =>
      expect(screen.getByTestId('staged-preview').getAttribute('data-slide')).toBe('1')
    )
    fireEvent.click(screen.getByLabelText('Delete slide'))
    expect(session.addOperations).toHaveBeenLastCalledWith([{ op: 'deleteSlide', slideId: 257 }])
    await waitFor(() =>
      expect(screen.getByTestId('staged-preview').getAttribute('data-slide')).toBe('0')
    )
  })

  it('returns to the previous slide when a structural edit is rejected', async () => {
    renderSurface(richSession({ addOperations: vi.fn().mockResolvedValue(false) }))
    fireEvent.click(screen.getByLabelText('Duplicate slide'))
    await waitFor(() =>
      expect(screen.getByTestId('staged-preview').getAttribute('data-slide')).toBe('0')
    )
  })

  it('keeps the last slide', () => {
    renderSurface(createSession())
    expect(screen.getByLabelText('Delete slide')).toHaveProperty('disabled', true)
  })

  it('edits speaker notes', () => {
    const session = richSession()
    renderSurface(session)
    fireEvent.click(screen.getByLabelText('Edit speaker notes'))
    const notes = screen.getByLabelText('Speaker notes') as HTMLTextAreaElement
    expect(notes.value).toBe('Opening')
    fireEvent.change(notes, { target: { value: 'Welcome' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(session.addOperations).toHaveBeenCalledWith([
      { op: 'setNotes', slideId: 256, text: 'Welcome' }
    ])
  })

  it('edits table cells on double click as one batch', () => {
    const session = richSession()
    renderSurface(session)
    fireEvent.click(screen.getByTestId('staged-preview'))
    fireEvent.doubleClick(shapeAt(3))
    expect(screen.getByRole('dialog', { name: 'Edit table' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Row 1, column 2'), { target: { value: 'Beta' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(session.addOperations).toHaveBeenCalledWith([
      {
        op: 'setTableCellText',
        slideId: 256,
        shapeId: 3,
        row: 0,
        col: 1,
        paragraphs: [{ runs: [{ text: 'Beta' }] }]
      }
    ])
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('edits chart labels and explains that the data is unchanged', () => {
    const session = richSession()
    renderSurface(session)
    fireEvent.click(screen.getByTestId('staged-next'))
    fireEvent.doubleClick(shapeAt(5))
    expect(screen.getByText(/chart data stays the same/)).toBeTruthy()
    expect(screen.queryByLabelText('Value axis title')).toBeNull()
    fireEvent.change(screen.getByLabelText('Category 1'), { target: { value: 'Spring' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(session.addOperations).toHaveBeenLastCalledWith([
      { op: 'setChartText', slideId: 257, shapeId: 5, target: 'category', index: 0, text: 'Spring' }
    ])
  })

  const choosePicture = (session: PptxEditSession, file: File): void => {
    renderSurface(session)
    fireEvent.click(screen.getByTestId('staged-preview'))
    const logo = shapeAt(4)
    fireEvent.pointerDown(logo, { button: 0, clientX: 5, clientY: 5, pointerId: 1 })
    fireEvent.pointerUp(logo, { clientX: 5, clientY: 5, pointerId: 1 })
    expect(screen.getByLabelText('Replace image')).toHaveProperty('disabled', false)
    fireEvent.change(screen.getByTestId('pptx-image-input'), { target: { files: [file] } })
  }

  it('replaces the selected picture with a chosen image', async () => {
    const session = richSession()
    choosePicture(session, new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' }))
    await waitFor(() =>
      expect(session.addOperations).toHaveBeenCalledWith([
        { op: 'replaceImage', slideId: 256, shapeId: 4, mime: 'image/png', dataBase64: 'AQID' }
      ])
    )
  })

  it('rejects unsupported image types before sending them', async () => {
    const session = richSession()
    choosePicture(session, new File(['<svg/>'], 'a.svg', { type: 'image/svg+xml' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Choose a PNG, JPEG, or GIF image.')
    expect(session.addOperations).not.toHaveBeenCalled()
  })

  it('explains when the edited presentation would be too large', () => {
    renderSurface(createSession({ failed: true, failure: 'too-large' }))
    expect(screen.getByRole('alert').textContent).toBe(
      'That image is too large for this presentation.'
    )
  })

  it('offers image replacement only for pictures', () => {
    renderSurface(richSession())
    expect(screen.getByLabelText('Replace image')).toHaveProperty('disabled', true)
  })
})

it('submits text and fitted dimensions as a single undo step', () => {
  const session = createSession()
  renderSurface(session)
  fireEvent.click(screen.getByTestId('staged-preview'))
  fireEvent.doubleClick(screen.getByRole('button', { name: 'Slide shape Title' }))
  fireEvent.change(screen.getByLabelText('Font size'), { target: { value: '72' } })
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
  expect(session.addOperations).toHaveBeenLastCalledWith([
    expect.objectContaining({
      op: 'setText',
      slideId: 256,
      shapeId: 2,
      frame: expect.objectContaining({ x: 914400, y: 457200 }),
      paragraphs: [{ runs: [{ text: 'Hello', sizePt: 72 }] }]
    })
  ])
})
