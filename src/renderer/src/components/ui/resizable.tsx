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
        'relative flex w-px items-center justify-center bg-[#ddd8cf] shadow-[1px_0_3px_rgba(30,28,24,0.08)] outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-3 after:-translate-x-1/2',
        className
      )}
      {...props}
    >
      {withHandle ? (
        <div className="z-10 flex h-6 w-4 items-center justify-center rounded-sm border border-[#ddd8cf] bg-white">
          <GripVertical className="size-3 text-[#9a9a9a]" aria-hidden="true" />
        </div>
      ) : null}
    </Separator>
  )
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup }
