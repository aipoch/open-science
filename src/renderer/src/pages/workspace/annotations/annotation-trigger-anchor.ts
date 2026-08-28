/**
 * Placement for the transient "Annotate" trigger button shown next to a live
 * text selection. The trigger anchors beside the selection's visible end —
 * the last line for a forward drag and the first line for a backward drag —
 * so it stays near the text the user is looking at instead of jumping to the
 * selection's bounding-box corner.
 *
 * The trigger is portalled to the document so message and preview overflow
 * cannot clip it. Its viewport position is recomputed from the live Range on
 * scroll and resize, which keeps it attached without putting it back inside a
 * potentially clipped or covered stacking context.
 */

type SelectionTriggerViewport = Readonly<{
  width: number
  height: number
  triggerWidth: number
  triggerHeight: number
}>

const TRIGGER_ANCHOR_OFFSET = 6
const TRIGGER_VIEWPORT_MARGIN = 8

const hasUsableAnchorGeometry = (rect: Pick<DOMRect, 'width' | 'height'>): boolean =>
  rect.width > 0 || rect.height > 0

const rangeAnchorRect = (range: Range, backward: boolean): DOMRect | undefined => {
  const rects = (
    typeof range.getClientRects === 'function' ? Array.from(range.getClientRects()) : []
  ).filter(hasUsableAnchorGeometry)
  const bounding =
    typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : undefined
  const anchor = rects.length > 0 ? (backward ? rects[0] : rects[rects.length - 1]) : bounding
  return anchor && hasUsableAnchorGeometry(anchor) ? anchor : undefined
}

const rectsIntersect = (
  left: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>,
  right: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>
): boolean =>
  left.right > right.left &&
  left.left < right.right &&
  left.bottom > right.top &&
  left.top < right.bottom

const isRangeConnected = (range: Range): boolean => range.commonAncestorContainer.isConnected

const isRangeTriggerVisible = (
  range: Range,
  backward: boolean,
  viewport: Pick<SelectionTriggerViewport, 'width' | 'height'>
): boolean => {
  // A cloned Range survives message remounts. Removing the quoted nodes either
  // leaves the clone on a disconnected tree or collapses it onto a connected
  // parent; neither should keep the portalled trigger at the fallback margin.
  if (!isRangeConnected(range) || range.collapsed) return false
  const anchorRect = rangeAnchorRect(range, backward)
  // Geometry is unavailable for connected jsdom ranges. Those environments
  // often still expose a zero-size DOMRect; treat that as missing so placement
  // keeps its existing fallback. Live browser text selections provide a box.
  if (!anchorRect) return true
  const viewportRect = {
    left: 0,
    right: viewport.width,
    top: 0,
    bottom: viewport.height,
    width: viewport.width,
    height: viewport.height
  }
  // A zero-size window is layout-unusable, not an off-screen selection. jsdom
  // and pre-layout browsers report that; hiding the trigger would drop a live draft.
  if (hasUsableAnchorGeometry(viewportRect) && !rectsIntersect(anchorRect, viewportRect)) {
    return false
  }

  let ancestor =
    range.commonAncestorContainer instanceof Element
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement
  while (ancestor && ancestor !== document.body) {
    const style = window.getComputedStyle(ancestor)
    const clips = [style.overflow, style.overflowX, style.overflowY].some((overflow) =>
      /^(auto|clip|hidden|scroll)$/.test(overflow)
    )
    if (clips) {
      const ancestorRect = ancestor.getBoundingClientRect()
      // Same missing-geometry fallback as the Range itself: an overflow ancestor
      // with a zero-size box cannot clip a selection that still exists in the tree.
      if (hasUsableAnchorGeometry(ancestorRect) && !rectsIntersect(anchorRect, ancestorRect)) {
        return false
      }
    }
    ancestor = ancestor.parentElement
  }
  return true
}

const isBackwardSelection = (selected: Selection): boolean => {
  const { anchorNode, anchorOffset, focusNode, focusOffset } = selected
  if (!anchorNode || !focusNode) return false
  if (anchorNode === focusNode) return focusOffset < anchorOffset
  const relation = anchorNode.compareDocumentPosition(focusNode)
  return (relation & Node.DOCUMENT_POSITION_PRECEDING) !== 0
}

const anchorRangeTrigger = (
  range: Range,
  backward: boolean,
  viewport: SelectionTriggerViewport
): { left: number; top: number } => {
  // jsdom and detached ranges expose neither geometry method.
  const anchorRect = rangeAnchorRect(range, backward)
  const desiredLeft = (anchorRect?.right ?? 0) + TRIGGER_ANCHOR_OFFSET
  const below = (anchorRect?.bottom ?? 0) + TRIGGER_ANCHOR_OFFSET
  const above = (anchorRect?.top ?? 0) - viewport.triggerHeight - TRIGGER_ANCHOR_OFFSET
  const desiredTop =
    below + viewport.triggerHeight + TRIGGER_VIEWPORT_MARGIN <= viewport.height ? below : above
  return {
    left: Math.max(
      TRIGGER_VIEWPORT_MARGIN,
      Math.min(desiredLeft, viewport.width - viewport.triggerWidth - TRIGGER_VIEWPORT_MARGIN)
    ),
    top: Math.max(
      TRIGGER_VIEWPORT_MARGIN,
      Math.min(desiredTop, viewport.height - viewport.triggerHeight - TRIGGER_VIEWPORT_MARGIN)
    )
  }
}

export { anchorRangeTrigger, isBackwardSelection, isRangeTriggerVisible }
