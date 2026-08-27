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
  const rects = typeof range.getClientRects === 'function' ? Array.from(range.getClientRects()) : []
  const bounding =
    typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : undefined
  const anchorRect = rects.length > 0 ? (backward ? rects[0] : rects[rects.length - 1]) : bounding
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

export { anchorRangeTrigger, isBackwardSelection }
