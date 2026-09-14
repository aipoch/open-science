// Red-frame markers for the settings visual preview. One fixed-position outline + numbered chip
// per change whose target region is currently rendered (targets carry data-visual-change
// attributes from the change implementations themselves). Positions track getBoundingClientRect
// through scroll (capture), resize, and a rAF loop while visible, so frames stay correct after
// scrolling, resizing, and dialog open/close. Rendered through a portal because the settings
// dialog is transformed, which would break fixed positioning.

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

import { SETTINGS_VISUAL_CHANGES } from './changes'

type MarkerFrame = {
  changeId: string
  index: number
  top: number
  left: number
  width: number
  height: number
}

const collectFrames = (): MarkerFrame[] =>
  SETTINGS_VISUAL_CHANGES.flatMap((change, index) =>
    Array.from(document.querySelectorAll<HTMLElement>(change.targetSelector))
      .filter((element) => element.isConnected)
      .flatMap((element) => {
        const rect = element.getBoundingClientRect()
        if (rect.width < 2 || rect.height < 2) return []
        return [
          {
            changeId: change.id,
            index,
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height
          }
        ]
      })
  )

const sameFrames = (left: MarkerFrame[], right: MarkerFrame[]): boolean =>
  left.length === right.length &&
  left.every((frame, position) => {
    const other = right[position]
    return (
      other !== undefined &&
      other.changeId === frame.changeId &&
      other.top === frame.top &&
      other.left === frame.left &&
      other.width === frame.width &&
      other.height === frame.height
    )
  })

export const VisualPreviewMarkers = ({
  visible,
  chipLabel
}: {
  visible: boolean
  chipLabel: (index: number) => string
}): React.JSX.Element | null => {
  const [frames, setFrames] = useState<MarkerFrame[]>([])

  useEffect(() => {
    // Hidden markers simply skip collection; the render path ignores stale frames while hidden.
    if (!visible) return
    let raf = 0
    const update = (): void => {
      const next = collectFrames()
      setFrames((current) => (sameFrames(current, next) ? current : next))
    }
    const loop = (): void => {
      update()
      raf = window.requestAnimationFrame(loop)
    }
    raf = window.requestAnimationFrame(loop)
    // Immediate correction between frames on scroll (capture, so nested scrollers count) and
    // resize; dialog open/close is caught by the rAF loop within a frame or two.
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      window.cancelAnimationFrame(raf)
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [visible])

  if (!visible || frames.length === 0) return null

  return createPortal(
    <div aria-hidden="true" data-slot="settings-visual-preview-markers">
      {frames.map((frame) => (
        <div
          key={`${frame.changeId}:${frame.left}:${frame.top}`}
          className="pointer-events-none fixed z-[110]"
          style={{
            top: frame.top - 4,
            left: frame.left - 4,
            width: frame.width + 8,
            height: frame.height + 8
          }}
        >
          <div className="absolute inset-0 rounded-md border-2 border-red-500/90 shadow-[0_0_0_1px_rgba(255,255,255,0.35)]" />
          <span className="absolute -top-2.5 left-1 rounded-sm bg-red-600 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white shadow">
            {chipLabel(frame.index + 1)}
          </span>
        </div>
      ))}
    </div>,
    document.body
  )
}
