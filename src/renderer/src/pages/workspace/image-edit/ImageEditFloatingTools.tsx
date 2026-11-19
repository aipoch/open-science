import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  fitContainedImageRect,
  type ImageAnnotationRect
} from '../annotations/image-annotation-geometry'

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
  const [geometry, setGeometry] = useState<{
    image: ImageAnnotationRect
    left: number
    top: number
  }>()
  const [hovered, setHovered] = useState(false)
  const [selected, setSelected] = useState(true)
  const width = naturalSize?.width
  const height = naturalSize?.height
  useLayoutEffect(() => {
    if (!viewport || !toolbar.current || !width || !height || hidden) return
    const tools = toolbar.current
    let imageRect: ImageAnnotationRect | undefined
    const measure = (): void => {
      const image = viewport.querySelector('[data-image-edit-surface] img')
      if (!image) return
      const bounds = viewport.getBoundingClientRect()
      imageRect = fitContainedImageRect(image.getBoundingClientRect(), { width, height })
      if (!imageRect) return
      const rect = {
        ...imageRect,
        left: imageRect.left - bounds.left,
        top: imageRect.top - bounds.top
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
          : below + toolHeight <= bounds.height - gap
            ? below
            : Math.min(bounds.height - toolHeight - 56, rect.top + rect.height - toolHeight - gap)
      const next = {
        image: rect,
        left: Math.max(
          gap,
          Math.min(
            bounds.width - tools.offsetWidth - gap,
            rect.left + (rect.width - tools.offsetWidth) / 2
          )
        ),
        top: Math.max(gap, Math.min(bounds.height - toolHeight - 56, top))
      }
      setGeometry((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next))
    }
    const inside = (event: PointerEvent): boolean =>
      Boolean(
        imageRect &&
        event.clientX >= imageRect.left &&
        event.clientX <= imageRect.left + imageRect.width &&
        event.clientY >= imageRect.top &&
        event.clientY <= imageRect.top + imageRect.height
      )
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
    const mutations = new MutationObserver(measure)
    const transform = viewport.querySelector('.react-transform-component')
    if (transform) mutations.observe(transform, { attributes: true, attributeFilter: ['style'] })
    viewport.addEventListener('pointermove', move)
    viewport.addEventListener('pointerleave', leave)
    viewport.addEventListener('pointerdown', select, true)
    viewport.addEventListener('focusin', focus)
    measure()
    return () => {
      resize.disconnect()
      mutations.disconnect()
      viewport.removeEventListener('pointermove', move)
      viewport.removeEventListener('pointerleave', leave)
      viewport.removeEventListener('pointerdown', select, true)
      viewport.removeEventListener('focusin', focus)
    }
  }, [viewport, width, height, hidden])
  return (
    <>
      {geometry && !hidden ? (
        <div
          aria-hidden="true"
          data-testid="image-selection-outline"
          data-selected={selected}
          data-hovered={hovered}
          className="image-edit-selection pointer-events-none absolute z-[5]"
          style={geometry.image}
        />
      ) : null}
      <div
        ref={toolbar}
        data-image-floating-tools
        className="absolute z-20 max-w-[calc(100%-1.5rem)]"
        style={{
          left: geometry?.left,
          top: geometry?.top,
          visibility: hidden || !geometry ? 'hidden' : undefined
        }}
      >
        {children}
      </div>
    </>
  )
}
