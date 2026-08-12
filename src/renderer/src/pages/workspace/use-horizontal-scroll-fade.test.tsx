// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { useHorizontalScrollFade } from './use-horizontal-scroll-fade'

const TestStrip = (): React.JSX.Element => {
  const ref = useHorizontalScrollFade<HTMLDivElement>()
  return <div ref={ref} data-testid="strip" />
}

const setScrollGeometry = (
  element: HTMLElement,
  geometry: { clientWidth: number; scrollWidth: number; scrollLeft: number }
): void => {
  Object.defineProperties(element, {
    clientWidth: { configurable: true, value: geometry.clientWidth },
    scrollWidth: { configurable: true, value: geometry.scrollWidth },
    scrollLeft: { configurable: true, writable: true, value: geometry.scrollLeft }
  })
}

afterEach(cleanup)

describe('useHorizontalScrollFade', () => {
  it('shows only the edge that still has hidden content', () => {
    render(<TestStrip />)
    const strip = screen.getByTestId('strip')

    setScrollGeometry(strip, { clientWidth: 100, scrollWidth: 300, scrollLeft: 0 })
    fireEvent.scroll(strip)
    expect(strip.dataset.scrollFade).toBe('right')

    strip.scrollLeft = 100
    fireEvent.scroll(strip)
    expect(strip.dataset.scrollFade).toBe('both')

    strip.scrollLeft = 200
    fireEvent.scroll(strip)
    expect(strip.dataset.scrollFade).toBe('left')
  })

  it('keeps all content fully visible when the strip does not overflow', () => {
    render(<TestStrip />)
    const strip = screen.getByTestId('strip')

    setScrollGeometry(strip, { clientWidth: 300, scrollWidth: 300, scrollLeft: 0 })
    fireEvent.scroll(strip)

    expect(strip.dataset.scrollFade).toBe('none')
  })
})
