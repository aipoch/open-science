type OfficePreviewHostVisibility = {
  visible: boolean
  obscuredByOverlay: boolean
}

const HIDDEN_VISIBILITY: OfficePreviewHostVisibility = {
  visible: false,
  obscuredByOverlay: false
}

// Native WebContentsView instances do not participate in DOM clipping or z-index, so visibility
// decisions use explicit overlay geometry instead of document-wide pointer-event hit testing.
const getOfficePreviewHostVisibility = (
  host: HTMLElement,
  rect: DOMRect
): OfficePreviewHostVisibility => {
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
    return HIDDEN_VISIBILITY
  }

  const containingModal = host.closest<HTMLElement>(
    '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]'
  )
  for (let ancestor = host.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const style = window.getComputedStyle(ancestor)
    const clips = [style.overflow, style.overflowX, style.overflowY].some((value) =>
      /^(auto|clip|hidden|scroll)$/.test(value)
    )
    if (clips) {
      const ancestorRect = ancestor.getBoundingClientRect()
      if (
        rect.left < ancestorRect.left ||
        rect.top < ancestorRect.top ||
        rect.right > ancestorRect.right ||
        rect.bottom > ancestorRect.bottom
      ) {
        return HIDDEN_VISIBILITY
      }
    }

    // A fixed modal establishes the preview's active visual boundary. Ancestors from its former
    // panel position must not make the viewport-sized surface appear clipped.
    if (ancestor === containingModal) break
  }

  const obscuredByModal = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[role="dialog"], [role="alertdialog"], [aria-modal="true"]'
    )
  ).some((element) => {
    const style = window.getComputedStyle(element)
    return style.display !== 'none' && style.visibility !== 'hidden' && !element.contains(host)
  })
  if (obscuredByModal) {
    return { visible: false, obscuredByOverlay: true }
  }

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
    if (style.display === 'none' || style.visibility === 'hidden') {
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
  if (overlappingOverlay) return { visible: false, obscuredByOverlay: true }

  return { visible: true, obscuredByOverlay: false }
}

const isOfficePreviewHostVisible = (host: HTMLElement, rect: DOMRect): boolean =>
  getOfficePreviewHostVisibility(host, rect).visible

export { getOfficePreviewHostVisibility, isOfficePreviewHostVisible }
export type { OfficePreviewHostVisibility }
