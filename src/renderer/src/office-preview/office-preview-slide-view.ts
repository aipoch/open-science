import type { OfficePreviewFrameBridge } from './office-preview-frame-bridge'

type SlideBox = { slideIndex: number; x: number; y: number; width: number; height: number }

const readSlideBox = (root: ParentNode): SlideBox | undefined => {
  const active = root.querySelector<HTMLElement>('.pptx-review-thumbnail[data-active]')
  const stage = root.querySelector<HTMLElement>('.pptx-review-stage')
  if (!active || !stage) return undefined
  const slideIndex = Number(active.getAttribute('data-slide'))
  // The stage includes padding, centering space and scrollbars. Only the fitted
  // slide wrapper shares the model's origin and aspect ratio.
  const wrapper =
    stage.querySelector<HTMLElement>(`[data-slide-index="${slideIndex}"]`) ??
    stage.firstElementChild
  if (!(wrapper instanceof HTMLElement)) return undefined
  const rect = wrapper.getBoundingClientRect()
  if (!Number.isInteger(slideIndex) || rect.width <= 0 || rect.height <= 0) return undefined
  return { slideIndex, x: rect.left, y: rect.top, width: rect.width, height: rect.height }
}

const sameBox = (a: SlideBox | undefined, b: SlideBox): boolean =>
  a !== undefined &&
  a.slideIndex === b.slideIndex &&
  Math.abs(a.x - b.x) < 0.5 &&
  Math.abs(a.y - b.y) < 0.5 &&
  Math.abs(a.width - b.width) < 0.5 &&
  Math.abs(a.height - b.height) < 0.5

// Reports the visible slide box so the host can map model geometry onto the sandboxed frame.
const installPptxSlideView = (
  bridge: OfficePreviewFrameBridge,
  root: HTMLElement,
  view: Window = window
): (() => void) => {
  let last: SlideBox | undefined
  let frame: number | undefined
  const flush = (): void => {
    frame = undefined
    const next = readSlideBox(root)
    if (!next || sameBox(last, next)) return
    last = next
    bridge.reportSlideView(next)
  }
  const schedule = (): void => {
    if (frame === undefined) frame = view.requestAnimationFrame(flush)
  }
  const mutations = new MutationObserver(schedule)
  mutations.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['style', 'data-active']
  })
  view.addEventListener('resize', schedule)
  root.addEventListener('scroll', schedule, true)
  const removeGoto = bridge.onGotoSlide((slideIndex) => {
    root.querySelector<HTMLElement>(`.pptx-review-thumbnail[data-slide="${slideIndex}"]`)?.click()
  })
  schedule()
  return () => {
    if (frame !== undefined) view.cancelAnimationFrame(frame)
    mutations.disconnect()
    view.removeEventListener('resize', schedule)
    root.removeEventListener('scroll', schedule, true)
    removeGoto()
  }
}

export { installPptxSlideView, readSlideBox }
