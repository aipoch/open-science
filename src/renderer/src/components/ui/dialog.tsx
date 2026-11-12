import * as React from 'react'
import { X } from 'lucide-react'
import { Button } from './button'
import { dialogOverlayClassName } from './dialog-chrome'
import { Dialog as DialogPrimitive } from 'radix-ui'

import { useChildLayerDismissalGuard } from './use-child-layer-dismissal-guard'

import { OverlayLayerProvider, useOverlayLayer } from './overlay-layer'

function Root({
  layer,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root> & { layer?: number }): React.JSX.Element {
  const parentLayer = useOverlayLayer()
  return (
    <OverlayLayerProvider value={layer ?? parentLayer + 20}>
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

/** Resource and review details share one responsive, right-aligned dialog surface. */
function DrawerContent({
  title,
  closeLabel,
  closeDisabled,
  headerActions,
  children,
  ...props
}: Omit<React.ComponentProps<typeof Content>, 'className' | 'title'> & {
  title: string
  closeLabel: string
  headerActions?: React.ReactNode
  closeDisabled?: boolean
}): React.JSX.Element {
  return (
    <DialogPrimitive.Portal>
      <Overlay className={dialogOverlayClassName} />
      <Content
        aria-describedby={undefined}
        {...props}
        className="fixed inset-y-0 right-0 flex w-full data-[state=closed]:pointer-events-none flex-col border-l border-border bg-card text-foreground shadow-dialog outline-none sm:w-[min(46rem,calc(100vw-4rem))] data-[state=open]:animate-in data-[state=open]:slide-in-from-right data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right motion-reduce:animate-none"
      >
        <div className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border px-5">
          <DialogPrimitive.Title className="min-w-0 flex-1 truncate text-sm font-semibold">
            {title}
          </DialogPrimitive.Title>
          {headerActions}
          <DialogPrimitive.Close asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={closeLabel}
              title={closeLabel}
              disabled={closeDisabled}
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </DialogPrimitive.Close>
        </div>
        {children}
      </Content>
    </DialogPrimitive.Portal>
  )
}

// Keep Radix's API and behavior, with composition and child-layer protection at every
// Dialog boundary. Callers still own styles and any stricter dismissal policy.
const Trigger = DialogPrimitive.Trigger
const Close = DialogPrimitive.Close
const Portal = DialogPrimitive.Portal
const Title = DialogPrimitive.Title
const Description = DialogPrimitive.Description

export { DrawerContent, Root, Trigger, Close, Portal, Overlay, Title, Description, Content }
