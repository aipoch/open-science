// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ResizableBottomPanel } from './ResizableBottomPanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const dispatchPointer = (target: EventTarget, type: string, init: PointerEventInit): void => {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, ...init }))
}

describe('ResizableBottomPanel pointer drag', () => {
  let container: HTMLDivElement
  let root: Root
  let originalInnerHeight: number

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    originalInnerHeight = window.innerHeight
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1000 })
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    vi.unstubAllGlobals()
    container.remove()
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight })
  })

  it('keeps one observer when streamed children update', () => {
    const observers: {
      observe: ReturnType<typeof vi.fn>
      unobserve: ReturnType<typeof vi.fn>
      disconnect: ReturnType<typeof vi.fn>
    }[] = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn()
        unobserve = vi.fn()
        disconnect = vi.fn()
        constructor() {
          observers.push(this)
        }
      }
    )
    const renderPanel = (index: number, key = 'same'): void =>
      act(() =>
        root.render(
          <ResizableBottomPanel
            ariaLabel="Resize permission panel"
            testId="panel"
            scrollTestId="scroll"
          >
            <div key={key}>{`Content ${index}`}</div>
          </ResizableBottomPanel>
        )
      )
    renderPanel(0)
    const firstChild = container.querySelector('[data-testid="scroll"]')!.firstElementChild
    for (let i = 1; i <= 20; i++) renderPanel(i)
    expect(observers).toHaveLength(1)
    expect(observers[0]!.observe).toHaveBeenCalledTimes(3)
    renderPanel(21, 'replacement')
    expect(observers).toHaveLength(1)
    expect(observers[0]!.unobserve).toHaveBeenCalledWith(firstChild)
    expect(observers[0]!.observe).toHaveBeenCalledTimes(4)
  })

  it('uses the latest dragged height when the existing observer reports smaller bounds', () => {
    const callbacks: ResizeObserverCallback[] = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn()
        unobserve = vi.fn()
        disconnect = vi.fn()
        constructor(callback: ResizeObserverCallback) {
          callbacks.push(callback)
        }
      }
    )
    act(() => {
      root.render(
        <ResizableBottomPanel ariaLabel="Resize panel" testId="panel" scrollTestId="scroll">
          <div>content</div>
        </ResizableBottomPanel>
      )
    })
    const panel = container.querySelector('[data-testid="panel"]') as HTMLDivElement
    const handle = container.querySelector('[role="separator"]') as HTMLDivElement
    panel.getBoundingClientRect = () =>
      ({ height: Number.parseFloat(panel.style.height) || 320 }) as DOMRect
    act(() => {
      handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    })
    expect(panel.style.height).toBe('352px')
    expect(callbacks).toHaveLength(1)
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 400 })
    act(() => callbacks[0]!([], {} as ResizeObserver))
    expect(panel.style.height).toBe('280px')
    expect(handle.getAttribute('aria-valuemax')).toBe('280')
  })

  it('stops resizing after the captured pointer is lost', () => {
    act(() => {
      root.render(
        <ResizableBottomPanel
          ariaLabel="Resize permission panel"
          testId="permission-composer"
          scrollTestId="permission-composer-scroll"
        >
          <div>content</div>
        </ResizableBottomPanel>
      )
    })

    const panel = container.querySelector('[data-testid="permission-composer"]') as HTMLDivElement
    const handle = container.querySelector(
      '[aria-label="Resize permission panel"]'
    ) as HTMLButtonElement
    const scroll = container.querySelector(
      '[data-testid="permission-composer-scroll"]'
    ) as HTMLDivElement

    panel.getBoundingClientRect = () =>
      ({
        height: 320,
        width: 400,
        top: 200,
        bottom: 520,
        left: 0,
        right: 400,
        x: 0,
        y: 200,
        toJSON() {
          return {}
        }
      }) as DOMRect
    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, value: 280 },
      scrollHeight: { configurable: true, value: 280 }
    })

    act(() => {
      dispatchPointer(handle, 'pointerdown', {
        pointerId: 1,
        isPrimary: true,
        button: 0,
        clientY: 200,
        pointerType: 'mouse'
      })
      dispatchPointer(handle, 'pointermove', {
        pointerId: 1,
        isPrimary: true,
        button: 0,
        clientY: 120,
        pointerType: 'mouse'
      })
    })
    expect(panel.style.height).toBe('400px')

    act(() => {
      dispatchPointer(handle, 'lostpointercapture', {
        pointerId: 1,
        isPrimary: true,
        pointerType: 'mouse'
      })
      dispatchPointer(handle, 'pointermove', {
        pointerId: 1,
        isPrimary: true,
        button: 0,
        clientY: 0,
        pointerType: 'mouse'
      })
    })
    expect(panel.style.height).toBe('400px')
  })
})
