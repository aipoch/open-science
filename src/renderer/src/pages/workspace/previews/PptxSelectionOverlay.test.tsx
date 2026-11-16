// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DeckOutline } from '../../../../../shared/pptx-edit'
import { PptxSelectionOverlay, type PptxSelectionOverlayProps } from './PptxSelectionOverlay'

afterEach(cleanup)

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) => key.replace('{{name}}', values?.name ?? '')
  })
}))

const outline: DeckOutline = {
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
} as DeckOutline

const slideView = { sessionId: 's', slideIndex: 0, x: 0, y: 0, width: 914.4, height: 514.35 }

const setup = (overrides: Partial<PptxSelectionOverlayProps> = {}): PptxSelectionOverlayProps => {
  const props: PptxSelectionOverlayProps = {
    outline,
    slideIndex: 0,
    slideView,
    selectedShapeId: undefined,
    disabled: false,
    onSelect: vi.fn(),
    onFrameChange: vi.fn(),
    onEditText: vi.fn(),
    ...overrides
  }
  render(<PptxSelectionOverlay {...props} />)
  return props
}

describe('PptxSelectionOverlay', () => {
  it('positions a shape box from model geometry', () => {
    setup()
    const box = screen.getByRole('button', { name: 'Slide shape Title' })
    expect(box.style.left).toBe('91.44px')
    expect(box.style.width).toBe('182.88px')
  })

  it('commits a drag as one frame change', () => {
    const props = setup()
    const box = screen.getByRole('button', { name: 'Slide shape Title' })
    box.setPointerCapture = vi.fn()
    fireEvent.pointerDown(box, { button: 0, clientX: 10, clientY: 10, pointerId: 1 })
    fireEvent.pointerMove(box, { clientX: 20, clientY: 10, pointerId: 1 })
    fireEvent.pointerUp(box, { clientX: 20, clientY: 10, pointerId: 1 })
    expect(props.onSelect).toHaveBeenCalledWith(2)
    expect(props.onFrameChange).toHaveBeenCalledWith(2, expect.objectContaining({ x: 1_014_400 }))
  })

  it('edits text on double click and ignores input while disabled', () => {
    const props = setup()
    fireEvent.doubleClick(screen.getByRole('button', { name: 'Slide shape Title' }))
    expect(props.onEditText).toHaveBeenCalledWith(2)
  })

  it('opens editors for tables and charts but not pictures', () => {
    const frame = { x: 0, y: 0, w: 914_400, h: 914_400, rotationDeg: 0 }
    const shapes = [
      { shapeId: 3, name: 'Grid', kind: 'table', frame, table: [['A']] },
      { shapeId: 4, name: 'Sales', kind: 'chart', frame, chart: { series: [] } },
      { shapeId: 5, name: 'Logo', kind: 'picture', frame }
    ]
    const props = setup({
      outline: { ...outline, slides: [{ ...outline.slides[0], shapes }] } as DeckOutline
    })
    for (const name of ['Grid', 'Sales', 'Logo']) {
      fireEvent.doubleClick(screen.getByRole('button', { name: `Slide shape ${name}` }))
    }
    expect(vi.mocked(props.onEditText).mock.calls).toEqual([[3], [4]])
  })
})

it('highlights hovered elements without selecting them and clears the highlight on leave', () => {
  const props = setup()
  const box = screen.getByRole('button', { name: 'Slide shape Title' })
  fireEvent.pointerEnter(box)
  expect(box.hasAttribute('data-hovered')).toBe(true)
  expect(box.className).toContain('outline-primary')
  expect(props.onSelect).not.toHaveBeenCalled()
  fireEvent.pointerLeave(box)
  expect(box.hasAttribute('data-hovered')).toBe(false)
  expect(box.className).not.toContain('outline-primary')
})
it('updates selected bounds when the edited shape dimensions change', () => {
  const props = setup({ selectedShapeId: 2 })
  cleanup()
  const { rerender } = render(<PptxSelectionOverlay {...props} />)
  const next = structuredClone(outline)
  next.slides[0].shapes[0].frame!.w = 3657600
  next.slides[0].shapes[0].frame!.h = 1828800
  rerender(<PptxSelectionOverlay {...props} outline={next} />)
  const box = screen.getByRole('button', { name: 'Slide shape Title' })
  expect(box.style.width).toBe('365.76px')
  expect(box.style.height).toBe('182.88px')
  expect(box.getAttribute('aria-pressed')).toBe('true')
})
