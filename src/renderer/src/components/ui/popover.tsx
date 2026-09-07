import * as React from 'react'
import { Popover as PopoverPrimitive } from 'radix-ui'

import { cn } from '@/lib/utils'
import { useChildLayerDismissalGuard } from './use-child-layer-dismissal-guard'

const Popover = PopoverPrimitive.Root
const PopoverAnchor = PopoverPrimitive.Anchor
const PopoverClose = PopoverPrimitive.Close
const PopoverTrigger = PopoverPrimitive.Trigger

function PopoverContent({
  className,
  sideOffset = 4,
  ref,
  onInteractOutside,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>): React.JSX.Element {
  const { setContentRef, onInteractOutside: guardChildDismissal } = useChildLayerDismissalGuard(ref)

  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={setContentRef}
        sideOffset={sideOffset}
        className={cn(
          'z-50 rounded-md bg-text-000 p-2 text-xs text-bg-000 shadow-md outline-none',
          className
        )}
        {...props}
        onInteractOutside={(event) => {
          guardChildDismissal(event)
          onInteractOutside?.(event)
        }}
      />
    </PopoverPrimitive.Portal>
  )
}

export { Popover, PopoverAnchor, PopoverClose, PopoverContent, PopoverTrigger }
