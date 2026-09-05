import * as React from 'react'
import { GripVertical } from 'lucide-react'
import { Group, Panel, Separator } from 'react-resizable-panels'

import { cn } from '@/lib/utils'

function ResizablePanelGroup({
  className,
  ...props
}: React.ComponentProps<typeof Group>): React.JSX.Element {
  return (
    <Group
      data-slot="resizable-panel-group"
      className={cn('flex h-full w-full', className)}
      {...props}
    />
  )
}

function ResizablePanel({
  className,
  ...props
}: React.ComponentProps<typeof Panel>): React.JSX.Element {
  return <Panel data-slot="resizable-panel" className={cn('min-w-0', className)} {...props} />
}

function ResizableHandle({
  withHandle,
  className,
  children,
  ...props
}: React.ComponentProps<typeof Separator> & {
  withHandle?: boolean
}): React.JSX.Element {
  return (
    <Separator
      // The library caches keyboard panel associations at registration, excluding disabled edges.
      // Re-register when enabled so an initially collapsed panel supports keyboard resizing.
      key={props.disabled ? 'disabled' : 'enabled'}
      data-slot="resizable-handle"
      className={cn(
        // Wide after-hit area makes CSS :hover match the draggable edge; default tick is thin and centered.
        'relative flex w-px items-center justify-center bg-transparent outline-none aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full',
        "after:absolute after:inset-y-0 after:left-1/2 after:w-3 after:-translate-x-1/2 after:content-[''] aria-[orientation=horizontal]:after:inset-x-0 aria-[orientation=horizontal]:after:inset-y-auto aria-[orientation=horizontal]:after:top-1/2 aria-[orientation=horizontal]:after:h-3 aria-[orientation=horizontal]:after:w-auto aria-[orientation=horizontal]:after:-translate-y-1/2 aria-[orientation=horizontal]:after:translate-x-0",
        'before:pointer-events-none before:absolute before:top-1/2 before:left-1/2 before:z-10 before:h-8 before:w-0.5 before:-translate-x-1/2 before:-translate-y-1/2 before:rounded-full before:bg-text-300 before:opacity-0 aria-[orientation=horizontal]:before:h-0.5 aria-[orientation=horizontal]:before:w-8',
        'hover:before:opacity-60 focus-visible:before:opacity-60 data-[separator=active]:before:opacity-60',
        className
      )}
      {...props}
    >
      {children}
      {withHandle ? (
        <div className="z-10 flex h-6 w-4 items-center justify-center rounded-sm border border-border bg-card">
          <GripVertical className="size-3 text-muted-foreground" aria-hidden="true" />
        </div>
      ) : null}
    </Separator>
  )
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup }
