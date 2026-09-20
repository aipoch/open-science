// @vitest-environment jsdom
import { act } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import * as followScroll from './follow-notebook-scroll'
import { useFollowScrollBottom } from './use-follow-scroll-bottom'

const Harness = ({
  enabled,
  contentHeight,
  viewportKey = 'viewport',
  contentKey = 'content',
  visible = true
}: {
  enabled: boolean
  contentHeight: number
  viewportKey?: string
  contentKey?: string
  visible?: boolean
}): React.JSX.Element => {
  const viewportRef = useFollowScrollBottom(enabled)
  if (!visible) return <></>
  return (
    <div key={viewportKey} data-testid="viewport" ref={viewportRef}>
      <div key={contentKey} data-testid="content" style={{ height: contentHeight }} />
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

const stubResizeObserver = (): (() => void) => {
  const callbacks: ResizeObserverCallback[] = []
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        callbacks.push(callback)
      }
      observe = vi.fn()
      disconnect = vi.fn()
    }
  )
  return () => {
    for (const callback of callbacks) callback([], {} as ResizeObserver)
  }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useFollowScrollBottom', () => {
  it('keeps one observer while streamed content updates and still follows resize notifications', () => {
    const observers: { callback: ResizeObserverCallback; disconnect: ReturnType<typeof vi.fn> }[] =
      []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        disconnect = vi.fn()
        constructor(callback: ResizeObserverCallback) {
          observers.push({ callback, disconnect: this.disconnect })
        }
        observe = vi.fn()
        unobserve = vi.fn()
      }
    )
    const view = render(<Harness enabled contentHeight={1000} />)
    const viewport = screen.getByTestId('viewport')
    for (let i = 0; i < 20; i++) view.rerender(<Harness enabled contentHeight={1000 + i} />)
    expect(observers).toHaveLength(1)
    setScrollGeometry(viewport, { clientHeight: 400, scrollHeight: 1800, scrollTop: 0 })
    act(() => observers[0]!.callback([], {} as ResizeObserver))
    expect(viewport.scrollTop).toBe(1400)
    view.unmount()
    expect(observers[0]!.disconnect).toHaveBeenCalledOnce()
  })

  it('does not reread the bottom geometry for unchanged DOM targets on ordinary rerenders', () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn()
        disconnect = vi.fn()
      }
    )
    const followBottomSpy = vi.spyOn(followScroll, 'followScrollBottomTop')
    const view = render(<Harness enabled contentHeight={1000} />)
    followBottomSpy.mockClear()

    for (let i = 0; i < 20; i++) view.rerender(<Harness enabled contentHeight={1000} />)

    expect(followBottomSpy).not.toHaveBeenCalled()
  })

  it('rebinds replaced DOM targets and cleans up when the viewport disappears', () => {
    const observers: { observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] =
      []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn()
        disconnect = vi.fn()
        constructor() {
          observers.push(this)
        }
      }
    )
    const view = render(<Harness enabled contentHeight={1000} />)
    view.rerender(<Harness enabled contentHeight={1000} contentKey="next-content" />)
    expect(observers).toHaveLength(2)
    expect(observers[0]!.disconnect).toHaveBeenCalledOnce()
    expect(observers[1]!.observe).toHaveBeenCalledWith(screen.getByTestId('content'))
    view.rerender(
      <Harness enabled contentHeight={1000} viewportKey="next-viewport" contentKey="next-content" />
    )
    expect(observers).toHaveLength(3)
    expect(observers[1]!.disconnect).toHaveBeenCalledOnce()
    expect(observers[2]!.observe).toHaveBeenCalledWith(screen.getByTestId('viewport'))
    view.rerender(<Harness enabled contentHeight={1000} visible={false} />)
    expect(observers[2]!.disconnect).toHaveBeenCalledOnce()
    view.unmount()
    expect(observers[2]!.disconnect).toHaveBeenCalledOnce()
  })

  it('pins new content to the bottom while following', () => {
    const notifyResize = stubResizeObserver()
    const view = render(<Harness enabled contentHeight={1000} />)
    const viewport = screen.getByTestId('viewport')
    setScrollGeometry(viewport, { clientHeight: 400, scrollHeight: 1000, scrollTop: 0 })

    view.rerender(<Harness enabled contentHeight={1000} />)
    notifyResize()
    expect(viewport.scrollTop).toBe(600)

    setScrollGeometry(viewport, { clientHeight: 400, scrollHeight: 1400, scrollTop: 600 })
    view.rerender(<Harness enabled contentHeight={1400} />)
    notifyResize()
    expect(viewport.scrollTop).toBe(1000)
  })

  it('pauses after the user leaves the bottom and resumes when they return', () => {
    const notifyResize = stubResizeObserver()
    const view = render(<Harness enabled contentHeight={1000} />)
    const viewport = screen.getByTestId('viewport')
    setScrollGeometry(viewport, { clientHeight: 400, scrollHeight: 1000, scrollTop: 0 })
    view.rerender(<Harness enabled contentHeight={1000} />)
    notifyResize()
    expect(viewport.scrollTop).toBe(600)

    viewport.scrollTop = 120
    fireEvent.scroll(viewport)

    setScrollGeometry(viewport, { clientHeight: 400, scrollHeight: 1600, scrollTop: 120 })
    view.rerender(<Harness enabled contentHeight={1600} />)
    notifyResize()
    expect(viewport.scrollTop).toBe(120)

    viewport.scrollTop = 1200
    fireEvent.scroll(viewport)

    setScrollGeometry(viewport, { clientHeight: 400, scrollHeight: 2000, scrollTop: 1200 })
    view.rerender(<Harness enabled contentHeight={2000} />)
    notifyResize()
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

  it('does not scroll a disabled viewport when ResizeObserver is unavailable', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    const view = render(<Harness enabled contentHeight={1000} />)
    const viewport = screen.getByTestId('viewport')
    setScrollGeometry(viewport, { clientHeight: 400, scrollHeight: 1000, scrollTop: 40 })

    view.rerender(<Harness enabled={false} contentHeight={1000} />)

    expect(viewport.scrollTop).toBe(40)
  })

  it('catches up when follow is re-enabled after staying at the bottom', async () => {
    const notifyResize = stubResizeObserver()
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
    notifyResize()
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
