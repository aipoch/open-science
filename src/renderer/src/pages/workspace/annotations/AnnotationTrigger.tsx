import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Pencil } from 'lucide-react'

import { PopoverAnchor } from '@/components/ui/popover'
import { anchorRangeTrigger, isRangeTriggerVisible } from './annotation-trigger-anchor'

const FALLBACK_TRIGGER_WIDTH = 82
const FALLBACK_TRIGGER_HEIGHT = 24

const observeSelectionMutations = (range: Range, onMutate: () => void): (() => void) => {
  if (typeof MutationObserver === 'undefined') return () => {}
  const node = range.commonAncestorContainer
  const element = node instanceof Element ? node : node.parentElement
  if (!element?.isConnected) return () => {}
  const observers: MutationObserver[] = []
  const observe = (target: Node, options: MutationObserverInit): void => {
    const observer = new MutationObserver(onMutate)
    observer.observe(target, options)
    observers.push(observer)
  }
  observe(element, { childList: true, characterData: true, subtree: true })
  let ancestor = element.parentElement
  while (ancestor) {
    observe(ancestor, { childList: true })
    if (ancestor === document.body) break
    ancestor = ancestor.parentElement
  }
  return () => {
    for (const observer of observers) observer.disconnect()
  }
}

const AnnotationTrigger = ({
  range,
  backward,
  hidden,
  label,
  onActivate
}: {
  range: Range
  backward: boolean
  hidden: boolean
  label: string
  onActivate: () => void
}): React.ReactPortal => {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const [position, setPosition] = useState({ left: 0, top: 0, ready: false, visible: true })

  const updatePosition = useCallback((): void => {
    const trigger = triggerRef.current
    const next = anchorRangeTrigger(range, backward, {
      width: window.innerWidth,
      height: window.innerHeight,
      triggerWidth: trigger?.offsetWidth || FALLBACK_TRIGGER_WIDTH,
      triggerHeight: trigger?.offsetHeight || FALLBACK_TRIGGER_HEIGHT
    })
    const visible = isRangeTriggerVisible(range, backward, {
      width: window.innerWidth,
      height: window.innerHeight
    })
    setPosition((current) =>
      current.ready &&
      current.left === next.left &&
      current.top === next.top &&
      current.visible === visible
        ? current
        : { ...next, ready: true, visible }
    )
  }, [backward, range])

  useLayoutEffect(() => {
    updatePosition()
    document.addEventListener('scroll', updatePosition, true)
    window.addEventListener('resize', updatePosition)
    const stopObserving = observeSelectionMutations(range, updatePosition)
    return () => {
      document.removeEventListener('scroll', updatePosition, true)
      window.removeEventListener('resize', updatePosition)
      stopObserving()
    }
  }, [range, updatePosition])

  return createPortal(
    <>
      <PopoverAnchor asChild>
        <span
          className="pointer-events-none fixed z-[100] h-7 w-px"
          style={{ left: position.left, top: position.top }}
          aria-hidden="true"
        />
      </PopoverAnchor>
      {hidden || !position.visible ? null : (
        <button
          ref={triggerRef}
          type="button"
          data-annotation-trigger="true"
          className="fixed z-[100] inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-[11px] font-semibold leading-4 text-primary-foreground shadow-md focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          style={{
            left: position.left,
            top: position.top,
            visibility: position.ready ? 'visible' : 'hidden'
          }}
          // Preserve the cloned Range until click opens the editor. Native
          // selection collapse during pointerdown must not re-enter a surface.
          onMouseUp={(event) => event.stopPropagation()}
          onKeyUp={(event) => event.stopPropagation()}
          onClick={onActivate}
        >
          <Pencil className="size-3" aria-hidden="true" />
          {label}
        </button>
      )}
    </>,
    document.body
  )
}

export { AnnotationTrigger }
