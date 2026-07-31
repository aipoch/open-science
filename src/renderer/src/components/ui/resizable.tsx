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
  ...props
}: React.ComponentProps<typeof Separator> & {
  withHandle?: boolean
}): React.JSX.Element {
  return (
    <Separator
      data-slot="resizable-handle"
      className={cn(
        // Wide after-hit area makes CSS :hover match the draggable edge; default tick is thin and centered.
        'relative flex w-px items-center justify-center bg-transparent outline-none',
        "after:absolute after:inset-y-0 after:left-1/2 after:w-3 after:-translate-x-1/2 after:content-['']",
        'before:pointer-events-none before:absolute before:top-1/2 before:left-1/2 before:z-10 before:h-8 before:w-0.5 before:-translate-x-1/2 before:-translate-y-1/2 before:rounded-full before:bg-text-300 before:opacity-0',
        'hover:before:opacity-60 focus-visible:before:opacity-60 data-[separator=active]:before:opacity-60',
        className
      )}
      {...props}
    >
      {withHandle ? (
        <div className="z-10 flex h-6 w-4 items-center justify-center rounded-sm border border-border bg-card">
          <GripVertical className="size-3 text-muted-foreground" aria-hidden="true" />
        </div>
      ) : null}
    </Separator>
  )
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup }
