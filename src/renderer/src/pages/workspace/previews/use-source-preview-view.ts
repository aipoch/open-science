import { useEffect, type RefObject } from 'react'
import type { SourcePreviewViewUpdate } from '../../../../../shared/source-preview'

// Native views sit above DOM content. Keep their geometry synchronized with layout, scrolling,
// inactive tab ancestors and portal overlays; send IPC only when the effective rectangle changes.
export const useSourcePreviewView = (
  host: RefObject<HTMLDivElement | null>,
  request: Omit<SourcePreviewViewUpdate, 'bounds'>,
  enabled: boolean,
  loaded: boolean
): void => {
  const { instanceId, sourceUrl, attempt } = request
  useEffect(() => {
    const updateView = window.api?.sourcePreview?.updateView
    if (!enabled || !updateView) return
    let frame = 0
    let previous = ''
    const synchronize = (): void => {
      const element = host.current
      let bounds: SourcePreviewViewUpdate['bounds'] = null
      if (element && loaded && !element.closest('[hidden], [inert]')) {
        const rect = element.getBoundingClientRect()
        const overlays = document.querySelectorAll(
          '[role="dialog"], [role="alertdialog"], [role="menu"], [role="tooltip"], [data-radix-popper-content-wrapper]'
        )
        const occluded = [...overlays].some((overlay) => {
          if (overlay.contains(element) || overlay.getClientRects().length === 0) return false
          if (overlay.matches('[role="dialog"], [role="alertdialog"]')) return true
          const other = overlay.getBoundingClientRect()
          return (
            other.left < rect.right &&
            other.right > rect.left &&
            other.top < rect.bottom &&
            other.bottom > rect.top
          )
        })
        const x = Math.max(0, rect.left)
        const y = Math.max(0, rect.top)
        const right = Math.min(window.innerWidth, rect.right)
        const bottom = Math.min(window.innerHeight, rect.bottom)
        if (
          !occluded &&
          right > x &&
          bottom > y &&
          getComputedStyle(element).visibility !== 'hidden'
        ) {
          // A dialog/portal without a standard role must not leave an invisible native click target.
          const points = [
            [(x + right) / 2, y + 2],
            [(x + right) / 2, bottom - 2],
            [x + 2, (y + bottom) / 2],
            [right - 2, (y + bottom) / 2],
            [(x + right) / 2, (y + bottom) / 2]
          ]
          if (points.every(([px, py]) => element.contains(document.elementFromPoint(px, py)))) {
            bounds = { x, y, width: right - x, height: bottom - y }
          }
        }
      }
      const next = JSON.stringify(bounds)
      if (next !== previous) {
        previous = next
        updateView({ instanceId, sourceUrl, attempt, bounds })
      }
      frame = requestAnimationFrame(synchronize)
    }
    synchronize()
    return () => {
      cancelAnimationFrame(frame)
    }
  }, [host, instanceId, sourceUrl, attempt, enabled, loaded])
}
