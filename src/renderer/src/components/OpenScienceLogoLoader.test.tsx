// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { OpenScienceLogoLoader } from './OpenScienceLogoLoader'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type TestMediaQuery = {
  matches: boolean
  listeners: Set<(event: MediaQueryListEvent) => void>
  addEventListener: ReturnType<typeof vi.fn>
  removeEventListener: ReturnType<typeof vi.fn>
}

const createTestMediaQuery = (matches: boolean): TestMediaQuery => {
  const listeners = new Set<(event: MediaQueryListEvent) => void>()

  return {
    matches,
    listeners,
    addEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener)
    }),
    removeEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener)
    })
  }
}

describe('OpenScienceLogoLoader', () => {
  let container: HTMLDivElement
  let root: Root
  let devicePixelRatioDescriptor: PropertyDescriptor | undefined
  let didUnmount: boolean

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    devicePixelRatioDescriptor = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio')
    didUnmount = false
  })

  afterEach(() => {
    if (!didUnmount) act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()

    if (devicePixelRatioDescriptor) {
      Object.defineProperty(window, 'devicePixelRatio', devicePixelRatioDescriptor)
    }
  })

  it('draws, reacts to motion and DPR changes, and releases browser observers', () => {
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 })

    const context = {
      arc: vi.fn(),
      beginPath: vi.fn(),
      clearRect: vi.fn(),
      fill: vi.fn(),
      fillStyle: '',
      globalAlpha: 1,
      globalCompositeOperation: 'source-over',
      restore: vi.fn(),
      save: vi.fn()
    } as unknown as CanvasRenderingContext2D
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context)
    let cssSize = 224
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
      bottom: cssSize,
      height: cssSize,
      left: 0,
      right: cssSize,
      top: 0,
      width: cssSize,
      x: 0,
      y: 0,
      toJSON: () => undefined
    }))
    let computedColor = 'rgb(12, 34, 56)'
    vi.spyOn(window, 'getComputedStyle').mockImplementation(
      () => ({ color: computedColor }) as CSSStyleDeclaration
    )

    const motionQuery = createTestMediaQuery(false)
    const resolutionQueries: TestMediaQuery[] = []
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => {
        if (query.includes('prefers-reduced-motion'))
          return motionQuery as unknown as MediaQueryList

        const resolutionQuery = createTestMediaQuery(false)
        resolutionQueries.push(resolutionQuery)
        return resolutionQuery as unknown as MediaQueryList
      })
    )

    let resizeCallback: ResizeObserverCallback | undefined
    const observe = vi.fn()
    const disconnectResize = vi.fn()
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallback = callback
        }

        observe = observe
        disconnect = disconnectResize
      }
    )

    let themeCallback: MutationCallback | undefined
    const observeTheme = vi.fn()
    const disconnectTheme = vi.fn()
    vi.stubGlobal(
      'MutationObserver',
      class {
        constructor(callback: MutationCallback) {
          themeCallback = callback
        }

        observe = observeTheme
        disconnect = disconnectTheme
      }
    )

    let nextAnimationFrameId = 1
    const animationFrames = new Map<number, FrameRequestCallback>()
    const requestAnimationFrame = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        const id = nextAnimationFrameId++
        animationFrames.set(id, callback)
        return id
      })
    const cancelAnimationFrame = vi
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation((id) => {
        animationFrames.delete(id)
      })

    act(() => root.render(<OpenScienceLogoLoader />))

    const canvas = container.querySelector<HTMLCanvasElement>('canvas')
    expect(canvas).not.toBeNull()
    expect(canvas?.width).toBe(224)
    expect(canvas?.height).toBe(224)
    expect(observe).toHaveBeenCalledWith(canvas)
    expect(requestAnimationFrame).toHaveBeenCalledOnce()

    const firstFrame = animationFrames.entries().next().value as
      [number, FrameRequestCallback] | undefined
    if (firstFrame) animationFrames.delete(firstFrame[0])
    act(() => firstFrame?.[1](1000))
    expect(context.clearRect).toHaveBeenCalled()
    expect(context.fillStyle).toBe(computedColor)

    const clearCountAfterFirstFrame = vi.mocked(context.clearRect).mock.calls.length
    const earlyFrame = animationFrames.entries().next().value as
      [number, FrameRequestCallback] | undefined
    if (earlyFrame) animationFrames.delete(earlyFrame[0])
    act(() => earlyFrame?.[1](1010))
    expect(vi.mocked(context.clearRect)).toHaveBeenCalledTimes(clearCountAfterFirstFrame)

    const budgetedFrame = animationFrames.entries().next().value as
      [number, FrameRequestCallback] | undefined
    if (budgetedFrame) animationFrames.delete(budgetedFrame[0])
    act(() => budgetedFrame?.[1](1034))
    expect(vi.mocked(context.clearRect).mock.calls.length).toBeGreaterThan(
      clearCountAfterFirstFrame
    )

    // Reduced motion cancels the loop and immediately draws the complete static mark.
    const clearCountBeforeReducedMotion = vi.mocked(context.clearRect).mock.calls.length
    const arcCountBeforeReducedMotion = vi.mocked(context.arc).mock.calls.length
    const fillCountBeforeReducedMotion = vi.mocked(context.fill).mock.calls.length
    const requestCountBeforeReducedMotion = requestAnimationFrame.mock.calls.length
    motionQuery.matches = true
    act(() => {
      for (const listener of motionQuery.listeners) {
        listener({ matches: true } as MediaQueryListEvent)
      }
    })
    expect(cancelAnimationFrame).toHaveBeenCalled()
    expect(requestAnimationFrame).toHaveBeenCalledTimes(requestCountBeforeReducedMotion)
    expect(vi.mocked(context.clearRect).mock.calls.length).toBeGreaterThan(
      clearCountBeforeReducedMotion
    )
    expect(vi.mocked(context.arc).mock.calls.length).toBeGreaterThan(arcCountBeforeReducedMotion)
    expect(vi.mocked(context.fill).mock.calls.length).toBeGreaterThan(fillCountBeforeReducedMotion)

    // A display-scale change rebuilds the backing store even when the CSS geometry is unchanged.
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 })
    act(() => {
      for (const listener of resolutionQueries[0]?.listeners ?? []) {
        listener({ matches: false } as MediaQueryListEvent)
      }
    })
    expect(canvas?.width).toBe(448)
    expect(canvas?.height).toBe(448)
    expect(resolutionQueries).toHaveLength(2)
    expect(resolutionQueries[0]?.listeners).toHaveLength(0)

    const clearCountBeforeTheme = vi.mocked(context.clearRect).mock.calls.length
    computedColor = 'rgb(65, 43, 21)'
    act(() => themeCallback?.([], {} as MutationObserver))
    expect(vi.mocked(context.clearRect).mock.calls.length).toBeGreaterThan(clearCountBeforeTheme)
    expect(context.fillStyle).toBe(computedColor)

    cssSize = 200
    act(() => resizeCallback?.([], {} as ResizeObserver))
    expect(canvas?.width).toBe(400)
    expect(canvas?.height).toBe(400)

    // Restart the loop so unmount must cancel an actively scheduled frame.
    motionQuery.matches = false
    act(() => {
      for (const listener of motionQuery.listeners) {
        listener({ matches: false } as MediaQueryListEvent)
      }
    })
    expect(animationFrames.size).toBe(1)
    act(() => root.unmount())
    didUnmount = true

    expect(animationFrames.size).toBe(0)
    expect(disconnectResize).toHaveBeenCalledOnce()
    expect(disconnectTheme).toHaveBeenCalledOnce()
    expect(motionQuery.removeEventListener).toHaveBeenCalled()
    expect(resolutionQueries[1]?.removeEventListener).toHaveBeenCalled()
    expect(motionQuery.listeners).toHaveLength(0)
    expect(resolutionQueries[1]?.listeners).toHaveLength(0)
  })
})
