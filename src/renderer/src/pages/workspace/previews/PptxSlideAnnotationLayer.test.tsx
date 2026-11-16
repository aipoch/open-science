// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { OfficePreviewSlideView } from '../../../../../shared/office-preview'
import type { DeckOutline } from '../../../../../shared/pptx-edit'
import { PptxSlideAnnotationLayer } from './PptxSlideAnnotationLayer'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

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
          frame: { x: 914_400, y: 457_200, w: 1_828_800, h: 914_400, rotationDeg: 0 }
        }
      ]
    }
  ]
} as unknown as DeckOutline

const slideView: OfficePreviewSlideView = {
  sessionId: 's',
  slideIndex: 0,
  x: 0,
  y: 0,
  width: 914.4,
  height: 514.35
}

const setup = (active = true): { onPick: ReturnType<typeof vi.fn>; layer: HTMLElement } => {
  const onPick = vi.fn()
  render(
    <PptxSlideAnnotationLayer
      outline={outline}
      slideIndex={0}
      slideView={slideView}
      markers={[{ id: 'a1', number: 1, shapeId: 2 }]}
      active={active}
      disabled={false}
      onPick={onPick}
    />
  )
  return { onPick, layer: screen.getByTestId('pptx-slide-annotation-layer') }
}

const gesture = (layer: HTMLElement, from: [number, number], to: [number, number]): void => {
  fireEvent.pointerDown(layer, { clientX: from[0], clientY: from[1], button: 0, pointerId: 1 })
  fireEvent.pointerUp(layer, { clientX: to[0], clientY: to[1], pointerId: 1 })
}

describe('PptxSlideAnnotationLayer', () => {
  it('picks the shape under a click', () => {
    const { onPick, layer } = setup()
    gesture(layer, [100, 60], [100, 60])
    expect(onPick).toHaveBeenCalledWith({ shapeId: 2 })
  })

  it('picks the whole slide when a click misses every shape', () => {
    const { onPick, layer } = setup()
    gesture(layer, [800, 450], [800, 450])
    expect(onPick).toHaveBeenCalledWith({})
  })

  it('picks a normalized region for a drag', () => {
    const { onPick, layer } = setup()
    gesture(layer, [91.44, 51.435], [457.2, 257.175])
    const region = onPick.mock.calls[0][0].region
    expect(region.x).toBeCloseTo(0.1)
    expect(region.y).toBeCloseTo(0.1)
    expect(region.width).toBeCloseTo(0.4)
    expect(region.height).toBeCloseTo(0.4)
  })

  it('ignores gestures while annotating is off and still draws markers', () => {
    const { onPick, layer } = setup(false)
    gesture(layer, [100, 60], [100, 60])
    expect(onPick).not.toHaveBeenCalled()
    expect(layer.querySelector('[data-annotation-marker="a1"]')).not.toBeNull()
  })
})
