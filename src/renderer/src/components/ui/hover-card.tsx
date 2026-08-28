import * as React from 'react'
import { HoverCard as HoverCardPrimitive } from 'radix-ui'

import { cn } from '@/lib/utils'

const HoverCard = HoverCardPrimitive.Root
const HoverCardTrigger = HoverCardPrimitive.Trigger

// Wraps Radix hover card content with the app's compact visual treatment. Unlike a tooltip,
// hover card content is allowed to be interactive (links, buttons, inline editors).
function HoverCardContent({
  className,
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Content>): React.JSX.Element {
  return (
    <HoverCardPrimitive.Portal>
      <HoverCardPrimitive.Content
        data-slot="hovercard-content"
        sideOffset={sideOffset}
        className={cn(
          'z-50 max-w-[min(20rem,calc(100vw-1rem))] overflow-hidden rounded-md border border-border bg-popover px-3 py-1.5 text-xs whitespace-normal break-words text-popover-foreground shadow-md',
          className
        )}
        {...props}
      />
    </HoverCardPrimitive.Portal>
  )
}

export { HoverCard, HoverCardContent, HoverCardTrigger }
