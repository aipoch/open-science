// @vitest-environment jsdom
import { act } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useFollowScrollBottom } from './use-follow-scroll-bottom'

const Harness = ({
  enabled,
  contentHeight
}: {
  enabled: boolean
  contentHeight: number
}): React.JSX.Element => {
  const viewportRef = useFollowScrollBottom(enabled)
  return (
    <div data-testid="viewport" ref={viewportRef}>
      <div data-testid="content" style={{ height: contentHeight }} />
    </div>
  )
}

const setScrollGeometry = (
  element: HTMLElement,
  geometry: { clientHeight: number; scrollHeight: number; scrollTop: number }
): void => {
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: geometry.clientHeight },
    scrollHeight: { configurable: true, value: geometry.scrollHeight },
    scrollTop: { configurable: true, writable: true, value: geometry.scrollTop }
  })
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('useFollowScrollBottom', () => {
  it('pins new content to the bottom while following', () => {
    const view = render(<Harness enabled contentHeight={1000} />)
    const viewport = screen.getByTestId('viewport')
    setScrollGeometry(viewport, { clientHeight: 400, scrollHeight: 1000, scrollTop: 0 })

    view.rerender(<Harness enabled contentHeight={1000} />)
    expect(viewport.scrollTop).toBe(600)

    setScrollGeometry(viewport, { clientHeight: 400, scrollHeight: 1400, scrollTop: 600 })
    view.rerender(<Harness enabled contentHeight={1400} />)
    expect(viewport.scrollTop).toBe(1000)
  })

  it('pauses after the user leaves the bottom and resumes when they return', () => {
    const view = render(<Harness enabled contentHeight={1000} />)
    const viewport = screen.getByTestId('viewport')
    setScrollGeometry(viewport, { clientHeight: 400, scrollHeight: 1000, scrollTop: 0 })
    view.rerender(<Harness enabled contentHeight={1000} />)
    expect(viewport.scrollTop).toBe(600)

    viewport.scrollTop = 120
    fireEvent.scroll(viewport)

    setScrollGeometry(viewport, { clientHeight: 400, scrollHeight: 1600, scrollTop: 120 })
    view.rerender(<Harness enabled contentHeight={1600} />)
    expect(viewport.scrollTop).toBe(120)

    viewport.scrollTop = 1200
    fireEvent.scroll(viewport)

    setScrollGeometry(viewport, { clientHeight: 400, scrollHeight: 2000, scrollTop: 1200 })
    view.rerender(<Harness enabled contentHeight={2000} />)
    expect(viewport.scrollTop).toBe(1600)
  })

  it('does not chase content while follow is disabled', () => {
    const view = render(<Harness enabled={false} contentHeight={1000} />)
    const viewport = screen.getByTestId('viewport')
    setScrollGeometry(viewport, { clientHeight: 400, scrollHeight: 1000, scrollTop: 40 })

    view.rerender(<Harness enabled={false} contentHeight={1600} />)
    setScrollGeometry(viewport, { clientHeight: 400, scrollHeight: 1600, scrollTop: 40 })
    view.rerender(<Harness enabled={false} contentHeight={1600} />)
    expect(viewport.scrollTop).toBe(40)
  })

  it('catches up when follow is re-enabled after staying at the bottom', async () => {
    vi.stubGlobal(
      'requestAnimationFrame',
      (callback: FrameRequestCallback): number =>
        window.setTimeout(() => callback(performance.now()), 0) as unknown as number
    )
    vi.stubGlobal('cancelAnimationFrame', (frameId: number): void => {
      window.clearTimeout(frameId)
    })

    const view = render(<Harness enabled contentHeight={1000} />)
    const viewport = screen.getByTestId('viewport')
    setScrollGeometry(viewport, { clientHeight: 400, scrollHeight: 1000, scrollTop: 0 })
    view.rerender(<Harness enabled contentHeight={1000} />)
    expect(viewport.scrollTop).toBe(600)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    view.rerender(<Harness enabled={false} contentHeight={1000} />)
    setScrollGeometry(viewport, { clientHeight: 400, scrollHeight: 1800, scrollTop: 600 })
    view.rerender(<Harness enabled={false} contentHeight={1800} />)
    expect(viewport.scrollTop).toBe(600)

    view.rerender(<Harness enabled contentHeight={1800} />)
    expect(viewport.scrollTop).toBe(1400)
  })
})
