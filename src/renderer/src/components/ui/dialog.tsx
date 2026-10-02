import * as React from 'react'
import { Dialog as DialogPrimitive } from 'radix-ui'

import { useChildLayerDismissalGuard } from './use-child-layer-dismissal-guard'

import { OverlayLayerProvider, useOverlayLayer } from './overlay-layer'

function Root(props: React.ComponentProps<typeof DialogPrimitive.Root>): React.JSX.Element {
  const parentLayer = useOverlayLayer()
  return (
    <OverlayLayerProvider value={parentLayer + 20}>
      <DialogPrimitive.Root {...props} />
    </OverlayLayerProvider>
  )
}
function Overlay({
  style,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>): React.JSX.Element {
  const layer = useOverlayLayer()
  return <DialogPrimitive.Overlay {...props} style={{ ...style, zIndex: layer }} />
}

function Content({
  ref,
  style,
  onInteractOutside,
  onEscapeKeyDown,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content>): React.JSX.Element {
  const layer = useOverlayLayer()
  const { setContentRef, onInteractOutside: guardChildDismissal } = useChildLayerDismissalGuard(ref)
  return (
    <DialogPrimitive.Content
      {...props}
      ref={setContentRef}
      style={{ ...style, zIndex: layer }}
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
const Trigger = DialogPrimitive.Trigger
const Close = DialogPrimitive.Close
const Portal = DialogPrimitive.Portal
const Title = DialogPrimitive.Title
const Description = DialogPrimitive.Description

export { Root, Trigger, Close, Portal, Overlay, Title, Description, Content }
