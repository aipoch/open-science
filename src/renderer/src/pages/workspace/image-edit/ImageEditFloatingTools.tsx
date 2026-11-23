import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { fitContainedImageRect } from '../annotations/image-annotation-geometry'

// Keep controls in screen coordinates so zooming never scales buttons or their hit targets.
export function ImageEditFloatingTools({
  viewport,
  naturalSize,
  hidden,
  children
}: {
  viewport: HTMLDivElement | null
  naturalSize?: { width: number; height: number }
  hidden: boolean
  children: ReactNode
}): React.JSX.Element {
  const toolbar = useRef<HTMLDivElement>(null)
  const outline = useRef<HTMLDivElement>(null)
  const [hovered, setHovered] = useState(false)
  const [selected, setSelected] = useState(true)
  const width = naturalSize?.width
  const height = naturalSize?.height
  useLayoutEffect(() => {
    const tools = toolbar.current
    const selection = outline.current
    if (!viewport || !tools || !selection || !width || !height || hidden) return
    const image = viewport.querySelector<HTMLImageElement>('[data-image-edit-surface] img')
    if (!image) return
    const measure = (): void => {
      const bounds = viewport.getBoundingClientRect()
      const viewportWidth = viewport.clientWidth
      const viewportHeight = viewport.clientHeight
      if (!bounds.width || !bounds.height || !viewportWidth || !viewportHeight) return
      // Use decoded dimensions when available so the outline follows the pixels actually painted.
      const imageSize =
        image.naturalWidth > 0 && image.naturalHeight > 0
          ? { width: image.naturalWidth, height: image.naturalHeight }
          : { width, height }
      const imageRect = fitContainedImageRect(image.getBoundingClientRect(), imageSize)
      if (!imageRect) return
      // Screen bounds already include the dialog entrance scale. Remove it from CSS offsets
      // and sizes because the dialog also transforms the outline and toolbar themselves.
      const toLocalX = viewportWidth / bounds.width
      const toLocalY = viewportHeight / bounds.height
      const rect = {
        left: (imageRect.left - bounds.left) * toLocalX,
        top: (imageRect.top - bounds.top) * toLocalY,
        width: imageRect.width * toLocalX,
        height: imageRect.height * toLocalY
      }
      const gap = 12
      const toolHeight = tools.offsetHeight
      const above = rect.top - toolHeight - gap
      const below = rect.top + rect.height + gap
      // Prefer the space above the image; fall below it, then inside its lower edge when full bleed.
      // Reserve the bottom zoom controls when the toolbar must sit inside the image.
      const top =
        above >= gap
          ? above
          : below + toolHeight <= viewportHeight - gap
            ? below
            : Math.min(viewportHeight - toolHeight - 56, rect.top + rect.height - toolHeight - gap)
      const toolWidth = tools.offsetWidth
      const left = Math.max(
        gap,
        Math.min(viewportWidth - toolWidth - gap, rect.left + (rect.width - toolWidth) / 2)
      )
      // ResizeObserver runs before paint; apply the positions in that layout pass.
      Object.assign(selection.style, {
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        visibility: 'visible'
      })
      Object.assign(tools.style, {
        left: `${left}px`,
        top: `${Math.max(gap, Math.min(viewportHeight - toolHeight - 56, top))}px`,
        visibility: 'visible'
      })
    }
    const inside = (event: PointerEvent): boolean => {
      const rect = selection.getBoundingClientRect()
      return (
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom
      )
    }
    const move = (event: PointerEvent): void => setHovered(inside(event))
    const leave = (): void => setHovered(false)
    const select = (event: PointerEvent): void => {
      if (
        event.target instanceof Element &&
        event.target.closest('button, [data-image-floating-tools]')
      )
        return
      setSelected(inside(event))
    }
    const focus = (event: FocusEvent): void => {
      if (event.target instanceof Element && event.target.closest('[data-image-edit-surface]'))
        setSelected(true)
    }
    const resize = new ResizeObserver(measure)
    resize.observe(viewport)
    resize.observe(tools)
    resize.observe(image)
    const mutations = new MutationObserver(measure)
    const transform = viewport.querySelector('.react-transform-component')
    if (transform) mutations.observe(transform, { attributes: true, attributeFilter: ['style'] })
    image.addEventListener('load', measure)
    viewport.addEventListener('pointermove', move)
    viewport.addEventListener('pointerleave', leave)
    viewport.addEventListener('pointerdown', select, true)
    viewport.addEventListener('focusin', focus)
    measure()
    return () => {
      resize.disconnect()
      mutations.disconnect()
      selection.style.visibility = ''
      tools.style.visibility = ''
      image.removeEventListener('load', measure)
      viewport.removeEventListener('pointermove', move)
      viewport.removeEventListener('pointerleave', leave)
      viewport.removeEventListener('pointerdown', select, true)
      viewport.removeEventListener('focusin', focus)
    }
  }, [viewport, width, height, hidden])
  return (
    <>
      {!hidden ? (
        <div
          ref={outline}
          aria-hidden="true"
          data-testid="image-selection-outline"
          data-selected={selected}
          data-hovered={hovered}
          className="image-edit-selection pointer-events-none invisible absolute z-[5]"
        />
      ) : null}
      <div
        ref={toolbar}
        data-image-floating-tools
        className="invisible absolute z-20 max-w-[calc(100%-1.5rem)]"
      >
        {children}
      </div>
    </>
  )
}
