import type { ComponentProps, ReactNode } from 'react'

import { cn } from '@/lib/utils'

type SettingsPanelHeaderProps = ComponentProps<'div'> & {
  // Primary panel action (e.g. New / Import), pinned to the row's trailing edge.
  action?: ReactNode
  // Optional panel-scoped search or filter control, rendered before the action.
  search?: ReactNode
}

// Slim panel toolbar: search + primary action on the trailing edge, no title — the dialog header
// bar is the single panel title. Panels compose this instead of hand-rolling their own toolbars.
const SettingsPanelHeader = ({
  action,
  search,
  className,
  ...props
}: SettingsPanelHeaderProps): React.JSX.Element => (
  <div
    data-slot="settings-panel-header"
    className={cn('flex flex-wrap items-center justify-end gap-2', className)}
    {...props}
  >
    {search}
    {action}
  </div>
)

export { SettingsPanelHeader }
export type { SettingsPanelHeaderProps }
