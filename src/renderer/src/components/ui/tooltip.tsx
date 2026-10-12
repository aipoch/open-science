import { useOverlayLayer } from './overlay-layer'
import * as React from 'react'
import { Tooltip as TooltipPrimitive } from 'radix-ui'

import { cn } from '@/lib/utils'

// Chromium can preserve :focus-visible when a modal menu returns focus after a pointer
// dismissal. Track the initiating input once per document without changing focus return.
const inputModes = new WeakMap<Document, { pointer: boolean; users: number; dispose: () => void }>()

function trackTooltipInput(ownerDocument: Document): () => void {
  let mode = inputModes.get(ownerDocument)
  if (!mode) {
    const next = { pointer: false, users: 0, dispose: () => {} }
    const pointer = (): void => {
      next.pointer = true
    }
    const keyboard = (): void => {
      next.pointer = false
    }
    ownerDocument.addEventListener('pointerdown', pointer, true)
    ownerDocument.addEventListener('keydown', keyboard, true)
    next.dispose = () => {
      ownerDocument.removeEventListener('pointerdown', pointer, true)
      ownerDocument.removeEventListener('keydown', keyboard, true)
    }
    mode = next
    inputModes.set(ownerDocument, mode)
  }
  mode.users += 1
  return () => {
    mode.users -= 1
    if (mode.users === 0) {
      mode.dispose()
      inputModes.delete(ownerDocument)
    }
  }
}

function TooltipProvider({
  delayDuration = 200,
  skipDelayDuration = 300,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>): React.JSX.Element {
  React.useEffect(() => trackTooltipInput(document), [])
  return (
    <TooltipPrimitive.Provider
      delayDuration={delayDuration}
      skipDelayDuration={skipDelayDuration}
      {...props}
    />
  )
}
const Tooltip = TooltipPrimitive.Root
function TooltipTrigger({
  onFocus,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>): React.JSX.Element {
  return (
    <TooltipPrimitive.Trigger
      {...props}
      onFocus={(event) => {
        onFocus?.(event)
        if (inputModes.get(event.currentTarget.ownerDocument)?.pointer) {
          event.preventDefault()
        }
      }}
    />
  )
}

// Wraps Radix tooltip content with the app's compact visual treatment.
function TooltipContent({
  className,
  style,
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>): React.JSX.Element {
  const layer = useOverlayLayer()
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          '[[aria-hidden=true]_&]:hidden hover-bubble origin-(--radix-tooltip-content-transform-origin) z-50 max-w-[min(20rem,calc(100vw-1rem))] overflow-hidden rounded-md bg-text-000 px-2 py-1 text-xs whitespace-normal break-words text-bg-000 shadow-md',
          className
        )}
        {...props}
        style={layer > 40 ? { ...style, zIndex: layer + 10 } : style}
      />
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }
