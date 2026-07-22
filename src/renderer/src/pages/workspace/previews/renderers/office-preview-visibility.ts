// Native WebContentsView instances do not participate in DOM clipping or z-index, so hide the
// child unless its host is fully visible and is not covered by another modal or overlay.
const isOfficePreviewHostVisible = (host: HTMLElement, rect: DOMRect): boolean => {
  if (
    document.visibilityState === 'hidden' ||
    !host.isConnected ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    rect.left < 0 ||
    rect.top < 0 ||
    rect.right > window.innerWidth ||
    rect.bottom > window.innerHeight
  ) {
    return false
  }

  for (let ancestor = host.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const style = window.getComputedStyle(ancestor)
    const clips = [style.overflow, style.overflowX, style.overflowY].some((value) =>
      /^(auto|clip|hidden|scroll)$/.test(value)
    )
    if (!clips) continue
    const ancestorRect = ancestor.getBoundingClientRect()
    if (
      rect.left < ancestorRect.left ||
      rect.top < ancestorRect.top ||
      rect.right > ancestorRect.right ||
      rect.bottom > ancestorRect.bottom
    ) {
      return false
    }
  }

  const activeModal = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[role="dialog"], [role="alertdialog"], [aria-modal="true"]'
    )
  ).find((element) => {
    const style = window.getComputedStyle(element)
    return style.display !== 'none' && style.visibility !== 'hidden'
  })
  if (activeModal && !activeModal.contains(host)) return false

  const overlaySelector = [
    '[role="menu"]',
    '[role="listbox"]',
    '[role="tooltip"]',
    '[data-radix-popper-content-wrapper]',
    '[data-side][data-align]'
  ].join(', ')
  const overlappingOverlay = Array.from(
    document.querySelectorAll<HTMLElement>(overlaySelector)
  ).some((element) => {
    if (element === host || element.contains(host) || host.contains(element)) return false
    const style = window.getComputedStyle(element)
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.pointerEvents === 'none'
    ) {
      return false
    }
    const overlayRect = element.getBoundingClientRect()
    return (
      overlayRect.width > 0 &&
      overlayRect.height > 0 &&
      overlayRect.left < rect.right &&
      overlayRect.right > rect.left &&
      overlayRect.top < rect.bottom &&
      overlayRect.bottom > rect.top
    )
  })
  if (overlappingOverlay) return false

  // react-resizable-panels disables pointer events on the active panel while dragging its separator.
  // The DOM hit test then cannot see this host even though the native preview remains visible.
  const panel = host.closest<HTMLElement>('[data-panel]')
  const isPanelResizeActive =
    panel !== null &&
    window.getComputedStyle(panel).pointerEvents === 'none' &&
    document.querySelector('[data-separator="active"]') !== null
  if (isPanelResizeActive) return true

  const elementsFromPoint = document.elementsFromPoint?.bind(document)
  if (!elementsFromPoint) return true
  const centerX = rect.left + rect.width / 2
  const centerY = rect.top + rect.height / 2
  const topElement = elementsFromPoint(centerX, centerY).find((element) => {
    const style = window.getComputedStyle(element)
    return style.pointerEvents !== 'none' && style.visibility !== 'hidden'
  })
  return !topElement || topElement === host || host.contains(topElement)
}

export { isOfficePreviewHostVisible }
