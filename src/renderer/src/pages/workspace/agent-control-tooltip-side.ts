type TooltipSide = 'left' | 'right' | 'top'
type HorizontalRect = Pick<DOMRect, 'left' | 'right'>

// max-w-72 content + 8px side offset + 8px collision padding.
const MINIMUM_SIDE_SPACE = 304

const resolveAgentControlTooltipSide = (
  preferredSide: 'left' | 'right',
  triggerRect: HorizontalRect,
  boundaryRect: HorizontalRect,
  allowHorizontalFlip = true
): TooltipSide => {
  const available = {
    left: Math.max(0, triggerRect.left - boundaryRect.left),
    right: Math.max(0, boundaryRect.right - triggerRect.right)
  }
  if (available[preferredSide] >= MINIMUM_SIDE_SPACE) return preferredSide

  // Submenu controls reserve the opposite side for their expanded menu. Moving their tooltip
  // there would place two portals on top of each other, so fall back vertically instead.
  if (!allowHorizontalFlip) return 'top'

  const oppositeSide = preferredSide === 'left' ? 'right' : 'left'
  if (available[oppositeSide] >= MINIMUM_SIDE_SPACE) return oppositeSide

  return 'top'
}

export { resolveAgentControlTooltipSide, type TooltipSide }
