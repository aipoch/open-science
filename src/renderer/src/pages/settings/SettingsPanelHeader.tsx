import type { ComponentProps, ReactNode } from 'react'

import { cn } from '@/lib/utils'

type SettingsPanelHeaderProps = ComponentProps<'header'> & {
  title: string
  description?: ReactNode
  // Primary panel action (e.g. New / Import), pinned to the header's trailing edge.
  action?: ReactNode
  // Optional panel-scoped search or filter control, rendered before the action.
  search?: ReactNode
}

// One fixed panel-header layout: title + description on the left, optional search and primary
// action on the right. Panels compose this instead of hand-rolling their own header bars.
const SettingsPanelHeader = ({
  title,
  description,
  action,
  search,
  className,
  ...props
}: SettingsPanelHeaderProps): React.JSX.Element => (
  <header
    data-slot="settings-panel-header"
    className={cn('flex flex-wrap items-start justify-between gap-3', className)}
    {...props}
  >
    <div className="min-w-0 flex-1 basis-60">
      <h2 className="break-words text-base font-semibold text-foreground">{title}</h2>
      {description ? (
        <p className="mt-0.5 max-w-2xl break-words text-[13px] leading-5 text-muted-foreground">
          {description}
        </p>
      ) : null}
    </div>
    {search || action ? (
      <div className="flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-2">
        {search}
        {action}
      </div>
    ) : null}
  </header>
)

export { SettingsPanelHeader }
export type { SettingsPanelHeaderProps }
