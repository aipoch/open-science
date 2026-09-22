// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useHorizontalScrollFade } from './use-horizontal-scroll-fade'

const TestStrip = ({ revision = 0 }: { revision?: number }): React.JSX.Element => {
  const ref = useHorizontalScrollFade<HTMLDivElement>()
  return <div ref={ref} data-testid="strip" data-revision={revision} />
}

const ConditionalStrip = ({ visible }: { visible: boolean }): React.JSX.Element | null => {
  const ref = useHorizontalScrollFade<HTMLDivElement>()
  return visible ? <div ref={ref} data-testid="conditional-strip" /> : null
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

  it('does not recreate the resize observer on unrelated rerenders', () => {
    const observe = vi.fn()
    const disconnect = vi.fn()
    const ResizeObserverStub = class {
      constructor(callback: ResizeObserverCallback) {
        void callback
      }

      observe = observe
      disconnect = disconnect
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)

    const { rerender, unmount } = render(<TestStrip revision={0} />)
    rerender(<TestStrip revision={1} />)

    expect(observe).toHaveBeenCalledTimes(1)
    expect(disconnect).toHaveBeenCalledTimes(0)
    unmount()
    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  it('binds the observer when the strip mounts after an initially empty render', () => {
    const observe = vi.fn()
    const ResizeObserverStub = class {
      constructor(callback: ResizeObserverCallback) {
        void callback
      }

      observe = observe

      disconnect(): void {
        // no-op
      }
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)

    const { rerender } = render(<ConditionalStrip visible={false} />)
    rerender(<ConditionalStrip visible />)

    expect(observe).toHaveBeenCalledTimes(1)
  })
})
