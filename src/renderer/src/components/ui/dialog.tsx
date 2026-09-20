import * as React from 'react'
import { Dialog as DialogPrimitive } from 'radix-ui'

import { useChildLayerDismissalGuard } from './use-child-layer-dismissal-guard'

function Content({
  ref,
  onInteractOutside,
  onEscapeKeyDown,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content>): React.JSX.Element {
  const { setContentRef, onInteractOutside: guardChildDismissal } = useChildLayerDismissalGuard(ref)
  return (
    <DialogPrimitive.Content
      {...props}
      ref={setContentRef}
      onEscapeKeyDown={(event) => {
        // Guard before caller effects as well as Radix's default dismissal.
        if (event.isComposing) {
          event.preventDefault()
          return
        }
        onEscapeKeyDown?.(event)
      }}
      onInteractOutside={(event) => {
        guardChildDismissal(event)
        onInteractOutside?.(event)
      }}
    />
  )
}

// Keep Radix's API and behavior, with composition and child-layer protection at every
// Dialog boundary. Callers still own styles and any stricter dismissal policy.
const Root = DialogPrimitive.Root
const Trigger = DialogPrimitive.Trigger
const Close = DialogPrimitive.Close
const Portal = DialogPrimitive.Portal
const Overlay = DialogPrimitive.Overlay
const Title = DialogPrimitive.Title
const Description = DialogPrimitive.Description

export { Root, Trigger, Close, Portal, Overlay, Title, Description, Content }
