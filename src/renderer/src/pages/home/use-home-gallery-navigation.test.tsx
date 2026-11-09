// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent } from '@testing-library/dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useHomeGalleryNavigation } from './use-home-gallery-navigation'

type Box = { top: number; bottom: number; height: number }

const geometry = {
  scrollTop: 0,
  scrollHeight: 1200,
  clientHeight: 500,
  scroll: { top: 0, bottom: 500, height: 500 } as Box,
  section: { top: 180, bottom: 1100, height: 920 } as Box,
  bar: { top: 420, bottom: 460, height: 40 } as Box,
  card: { top: 300, bottom: 500, height: 200 } as Box
}

const rect = (box: Box): DOMRect =>
  ({
    top: box.top,
    bottom: box.bottom,
    left: 0,
    right: 300,
    width: 300,
    height: box.height,
    x: 0,
    y: box.top,
    toJSON: () => ({})
  }) as DOMRect

let container: HTMLDivElement
let root: Root
let scrolledTo: number | undefined
let originalRect: typeof HTMLElement.prototype.getBoundingClientRect

const Probe = (): React.JSX.Element => {
  const { scrollRef, contentRef, projectsRef, galleryRef, showJump, scrollToGallery } =
    useHomeGalleryNavigation()
  return (
    <div ref={scrollRef} data-scroll>
      <div ref={contentRef}>
        <div ref={projectsRef} />
        <section ref={galleryRef}>
          <div data-gallery-bar>
            <h2>Use Case Gallery</h2>
          </div>
          <article />
        </section>
      </div>
      {showJump ? <button type="button" onClick={scrollToGallery} /> : null}
    </div>
  )
}

beforeEach(() => {
  geometry.scrollTop = 0
  geometry.scrollHeight = 1200
  geometry.clientHeight = 500
  geometry.scroll = { top: 0, bottom: 500, height: 500 }
  geometry.section = { top: 180, bottom: 1100, height: 920 }
  geometry.bar = { top: 420, bottom: 460, height: 40 }
  geometry.card = { top: 300, bottom: 500, height: 200 }
  scrolledTo = undefined
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn()
      disconnect = vi.fn()
    }
  )
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
  originalRect = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (this.hasAttribute('data-scroll')) return rect(geometry.scroll)
    if (this.hasAttribute('data-gallery-bar')) return rect(geometry.bar)
    if (this.tagName === 'SECTION') return rect(geometry.section)
    if (this.tagName === 'ARTICLE') return rect(geometry.card)
    return originalRect.call(this)
  }
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  HTMLElement.prototype.getBoundingClientRect = originalRect
  vi.unstubAllGlobals()
})

const render = async (): Promise<void> => {
  await act(async () => root.render(<Probe />))
  const scroll = container.querySelector('[data-scroll]') as HTMLDivElement
  Object.defineProperty(scroll, 'scrollTop', {
    configurable: true,
    get: () => geometry.scrollTop,
    set: (value: number) => {
      geometry.scrollTop = value
    }
  })
  Object.defineProperty(scroll, 'scrollHeight', {
    configurable: true,
    get: () => geometry.scrollHeight
  })
  Object.defineProperty(scroll, 'clientHeight', {
    configurable: true,
    get: () => geometry.clientHeight
  })
  scroll.scrollTo = ((optionsOrX: ScrollToOptions | number, y?: number) => {
    scrolledTo = typeof optionsOrX === 'number' ? optionsOrX : optionsOrX.top
    void y
  }) as typeof scroll.scrollTo
  await act(async () => scroll.dispatchEvent(new Event('scroll')))
}

const jump = (): HTMLButtonElement | null => container.querySelector('button')

it('hides the home dots while most of the first case row is visible', async () => {
  await render()
  expect(jump()).toBeNull()
})

it('shows the home dots once half of the first case row is outside the viewport', async () => {
  geometry.card = { top: 400, bottom: 600, height: 200 }
  await render()
  expect(jump()).toBeTruthy()

  geometry.card = { top: -120, bottom: 80, height: 200 }
  await act(async () => {
    container.querySelector('[data-scroll]')!.dispatchEvent(new Event('scroll'))
  })
  expect(jump()).toBeTruthy()
})

it('scrolls the gallery heading to the top of the home viewport', async () => {
  geometry.card = { top: 400, bottom: 600, height: 200 }
  geometry.scrollTop = 20
  // The probe heading is the section's first child and has no padding, so its layout top is the section top.
  geometry.bar = { top: geometry.section.top, bottom: geometry.section.top + 40, height: 40 }
  await render()
  await act(async () => fireEvent.click(jump()!))
  expect(scrolledTo).toBe(20 + geometry.section.top - geometry.scroll.top)
})

it('scrolls back to the gallery heading after that heading has stuck to the top', async () => {
  geometry.scrollTop = 500
  geometry.scroll = { top: 0, bottom: 500, height: 500 }
  geometry.section = { top: -240, bottom: 680, height: 920 }
  geometry.bar = { top: 0, bottom: 40, height: 40 }
  geometry.card = { top: -120, bottom: 80, height: 200 }
  await render()
  await act(async () => fireEvent.click(jump()!))
  expect(scrolledTo).toBe(500 - 240)
})
