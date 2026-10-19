import { useOverlayPortalContainer } from './overlay-portal-container'
import { useOverlayLayer } from './overlay-layer'
import * as React from 'react'
import { Tooltip as TooltipPrimitive } from 'radix-ui'

import { cn } from '@/lib/utils'

function TooltipProvider({
  delayDuration = 200,
  skipDelayDuration = 300,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>): React.JSX.Element {
  return (
    <TooltipPrimitive.Provider
      delayDuration={delayDuration}
      skipDelayDuration={skipDelayDuration}
      {...props}
    />
  )
}
const Tooltip = TooltipPrimitive.Root
const TooltipTrigger = TooltipPrimitive.Trigger

// Wraps Radix tooltip content with the app's compact visual treatment.
function TooltipContent({
  className,
  style,
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>): React.JSX.Element {
  const layer = useOverlayLayer()
  const portalContainer = useOverlayPortalContainer()
  return (
    <TooltipPrimitive.Portal container={portalContainer}>
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
