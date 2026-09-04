/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Pencil, type LucideIcon } from 'lucide-react'

import { PopoverAnchor } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { anchorRangeTrigger, isRangeTriggerVisible } from './annotation-trigger-anchor'

const FALLBACK_TRIGGER_WIDTH = 82
const FALLBACK_TRIGGER_HEIGHT = 32

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

type AnnotationTriggerAction = Readonly<{
  id: string
  label: string
  icon: LucideIcon
  showLabel?: boolean
  primary?: boolean
  disabled?: boolean
  availableWhenAnnotationBlocked?: boolean
  onActivate: () => void
}>

const AnnotationTrigger = ({
  range,
  backward,
  hidden,
  label,
  onActivate,
  actions,
  actionMenuLabel
}: {
  range: Range
  backward: boolean
  hidden: boolean
  label: string
  onActivate: () => void
  actions?: readonly AnnotationTriggerAction[]
  actionMenuLabel?: string
}): React.ReactPortal => {
  const triggerRef = useRef<HTMLElement | null>(null)
  const capturedTextRef = useRef(range.toString())
  const [position, setPosition] = useState({ left: 0, top: 0, ready: false, visible: true })

  const updatePosition = useCallback((): void => {
    const trigger = triggerRef.current
    const next = anchorRangeTrigger(range, backward, {
      width: window.innerWidth,
      height: window.innerHeight,
      triggerWidth: trigger?.offsetWidth || FALLBACK_TRIGGER_WIDTH,
      triggerHeight: trigger?.offsetHeight || FALLBACK_TRIGGER_HEIGHT
    })
    const visible =
      range.toString() === capturedTextRef.current &&
      isRangeTriggerVisible(range, backward, {
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
    capturedTextRef.current = range.toString()
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
      {hidden || !position.visible ? null : actions ? (
        <TooltipProvider delayDuration={300}>
          <div
            ref={(element) => {
              triggerRef.current = element
            }}
            role="toolbar"
            aria-label={actionMenuLabel ?? label}
            data-selection-action-menu="true"
            className="fixed z-[100] flex items-center gap-0.5 rounded-md border border-border bg-popover p-0.5 text-popover-foreground shadow-menu"
            style={{
              left: position.left,
              top: position.top,
              visibility: position.ready ? 'visible' : 'hidden'
            }}
            onMouseUp={(event) => event.stopPropagation()}
            onKeyUp={(event) => event.stopPropagation()}
          >
            {actions.map((action) => {
              const Icon = action.icon
              const button = (
                <button
                  key={action.showLabel ? action.id : undefined}
                  type="button"
                  data-selection-action={action.id}
                  data-annotation-trigger={action.id === 'annotate' ? 'true' : undefined}
                  disabled={action.disabled}
                  className={cn(
                    'inline-flex h-6 items-center justify-center rounded text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50',
                    action.showLabel ? 'gap-1 px-2' : 'w-7',
                    action.primary
                      ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                  )}
                  // Keep the PDF.js selection alive and run before its
                  // pointerup Text Layer reconciliation can remove the menu.
                  onPointerDown={(event) => {
                    if (event.button !== 0 || action.disabled) return
                    event.preventDefault()
                    action.onActivate()
                  }}
                  // Keyboard and assistive-technology clicks do not have a
                  // preceding pointerdown. Pointer clicks were handled above.
                  onClick={(event) => {
                    if (event.detail === 0 && !action.disabled) action.onActivate()
                  }}
                >
                  <Icon className="size-3.5" aria-hidden="true" />
                  {action.showLabel ? (
                    action.label
                  ) : (
                    <span className="sr-only">{action.label}</span>
                  )}
                </button>
              )
              if (action.showLabel) return button
              return (
                <Tooltip key={action.id}>
                  <TooltipTrigger asChild>{button}</TooltipTrigger>
                  <TooltipContent className="z-[110]">{action.label}</TooltipContent>
                </Tooltip>
              )
            })}
          </div>
        </TooltipProvider>
      ) : (
        <button
          ref={(element) => {
            triggerRef.current = element
          }}
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
          // PDF.js also mutates its Text Layer from pointerup; open before that
          // can remove this portalled button and prevent mouseup from clicking it.
          onPointerDown={(event) => {
            if (event.button !== 0) return
            event.preventDefault()
            onActivate()
          }}
          onMouseUp={(event) => event.stopPropagation()}
          onKeyUp={(event) => event.stopPropagation()}
          // Keyboard and assistive-technology clicks do not have a preceding
          // pointerdown. Mouse/touch clicks were already handled above.
          onClick={(event) => {
            if (event.detail === 0) onActivate()
          }}
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
export type { AnnotationTriggerAction }
