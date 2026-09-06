import * as React from 'react'

function forwardContentRef(
  ref: React.Ref<HTMLDivElement> | undefined,
  node: HTMLDivElement | null
): void | (() => void) {
  if (typeof ref === 'function') return ref(node)
  if (ref) ref.current = node
}

// A modal child disables pointer events on its parent. A repeated trigger click
// then hits the backdrop, and Radix can defer the parent's outside event until
// after the child unmounts. Remember the gesture, not the child's later DOM state.
export function useChildLayerDismissalGuard(forwardedRef: React.Ref<HTMLDivElement> | undefined): {
  setContentRef: React.RefCallback<HTMLDivElement>
  onInteractOutside: (event: {
    detail: { originalEvent: Event }
    preventDefault: () => void
  }) => void
} {
  const contentRef = React.useRef<HTMLDivElement>(null)
  const childDismissals = React.useRef(new WeakSet<Event>())
  const setContentRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      contentRef.current = node
      const cleanup = forwardContentRef(forwardedRef, node)
      if (typeof cleanup === 'function') {
        return () => {
          contentRef.current = null
          cleanup()
        }
      }
      return undefined
    },
    [forwardedRef]
  )

  React.useEffect(() => {
    const ownerDocument = contentRef.current?.ownerDocument ?? document
    const rememberChildInteraction = (event: PointerEvent): void => {
      if (
        contentRef.current?.querySelector(
          '[data-slot="select-trigger"][data-state="open"], [aria-haspopup="menu"][data-state="open"], [aria-haspopup="dialog"][data-state="open"]'
        )
      ) {
        childDismissals.current.add(event)
      }
    }
    ownerDocument.addEventListener('pointerdown', rememberChildInteraction, true)
    return () => ownerDocument.removeEventListener('pointerdown', rememberChildInteraction, true)
  }, [])

  return {
    setContentRef,
    onInteractOutside: (event) => {
      if (childDismissals.current.has(event.detail.originalEvent)) event.preventDefault()
    }
  }
}
