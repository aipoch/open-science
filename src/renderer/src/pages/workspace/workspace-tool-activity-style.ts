import { cn } from '@/lib/utils'
import type { ToolActivity } from '@/stores/session-store'

import { isActivityActive } from './workspace-conversation-items'

// Centralizes compact activity-row styling so search and generic tool rows stay visually aligned.
const getActivitySurfaceClassName = (activity: ToolActivity): string =>
  cn(
    'flex w-full min-h-[44px] items-start gap-2 rounded-lg py-2 pl-1.5 pr-2.5 text-[13px] transition-colors md:min-h-0 md:items-center md:py-[5px]',
    activity.status === 'failed'
      ? 'text-danger-000 hover:bg-danger-900'
      : isActivityActive(activity)
        ? 'text-text-000 hover:bg-bg-300'
        : 'text-text-100 hover:bg-bg-200'
  )

export { getActivitySurfaceClassName }
