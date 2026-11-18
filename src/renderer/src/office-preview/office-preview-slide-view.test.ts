// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { OfficePreviewFrameBridge } from './office-preview-frame-bridge'
import { installPptxSlideView, readSlideBox } from './office-preview-slide-view'

const buildDeck = (): HTMLElement => {
  const root = document.createElement('div')
  root.innerHTML = `
    <div class="pptx-review-thumbnail" data-slide="0"></div>
    <div class="pptx-review-thumbnail" data-slide="1" data-active></div>
    <div class="pptx-review-content"><div class="pptx-review-stage"><div class="slide" data-slide-index="1"></div></div><aside>Notes</aside></div>`
  document.body.append(root)
  const stage = root.querySelector('.pptx-review-stage') as HTMLElement
  stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 900, height: 500 }) as DOMRect
  const slide = root.querySelector('.slide') as HTMLElement
  slide.getBoundingClientRect = () => ({ left: 10, top: 20, width: 640, height: 360 }) as DOMRect
  return root
}

const createBridge = (): {
  bridge: OfficePreviewFrameBridge
  reportSlideView: ReturnType<typeof vi.fn>
  gotoListener: () => ((slideIndex: number) => void) | undefined
} => {
  let listener: ((slideIndex: number) => void) | undefined
  const reportSlideView = vi.fn()
  const bridge = {
    reportSlideView,
    onGotoSlide: (next: (slideIndex: number) => void) => {
      listener = next
      return () => {
        listener = undefined
      }
    }
  } as unknown as OfficePreviewFrameBridge
  return { bridge, reportSlideView, gotoListener: () => listener }
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('office preview slide view', () => {
  it('reads the active slide index and rendered box', () => {
    expect(readSlideBox(buildDeck())).toEqual({
      slideIndex: 1,
      x: 10,
      y: 20,
      width: 640,
      height: 360
    })
  })

  it('returns nothing before a slide is rendered', () => {
    expect(readSlideBox(document.createElement('div'))).toBeUndefined()
  })

  it('reports the box once and navigates by clicking the thumbnail', async () => {
    const root = buildDeck()
    const { bridge, reportSlideView, gotoListener } = createBridge()
    const dispose = installPptxSlideView(bridge, root, window)
    await new Promise((resolve) => requestAnimationFrame(resolve))
    expect(reportSlideView).toHaveBeenCalledTimes(1)
    expect(reportSlideView).toHaveBeenCalledWith({
      slideIndex: 1,
      x: 10,
      y: 20,
      width: 640,
      height: 360
    })

    const click = vi.fn()
    root.querySelector('[data-slide="0"]')!.addEventListener('click', click)
    gotoListener()?.(0)
    expect(click).toHaveBeenCalledTimes(1)

    dispose()
    expect(gotoListener()).toBeUndefined()
  })
})

it('reads the fitted single-slide wrapper even without a list index', () => {
  const root = buildDeck()
  root.querySelector('.slide')!.removeAttribute('data-slide-index')
  expect(readSlideBox(root)).toEqual({ slideIndex: 1, x: 10, y: 20, width: 640, height: 360 })
})
it('does not report the stage or notes before the slide mounts', () => {
  const root = buildDeck()
  root.querySelector('.slide')!.remove()
  expect(readSlideBox(root)).toBeUndefined()
})
