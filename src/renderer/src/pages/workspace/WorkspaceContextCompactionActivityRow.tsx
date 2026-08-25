/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4
 * component: system milestone · genre: modern-minimal · theme: Open Science
 * states: completed · in-progress · failed · cancelled
 * contrast: pass (40–41)
 */
import { MessageScrollerItem } from '@/components/ui/message-scroller'
import { cn } from '@/lib/utils'
import type { ToolActivity } from '@/stores/session-store'
import { CircleAlert, CircleMinus, LoaderCircle, Minimize2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { formatActivityTitle, isActivityActive } from './workspace-conversation-items'

type WorkspaceContextCompactionActivityRowProps = {
  activity: ToolActivity
  contentPaddingClassName?: string
}

// Marks the exact transcript boundary where earlier context stops being available verbatim.
const WorkspaceContextCompactionActivityRow = ({
  activity,
  contentPaddingClassName
}: WorkspaceContextCompactionActivityRowProps): React.JSX.Element => {
  const { t } = useTranslation()
  const isActive = isActivityActive(activity)
  const isFailed = activity.status === 'failed'
  const isCancelled = activity.title.trim() === 'Context compaction cancelled'
  const note = isActive
    ? t('Summarizing earlier context…')
    : isFailed || isCancelled
      ? t('Earlier context is unchanged.')
      : t('Earlier context was summarized so the session can continue.')
  const iconClassName = cn(
    'size-3.5 shrink-0',
    isActive
      ? 'animate-spin text-status-info-foreground motion-reduce:animate-none dark:text-status-info-dark-foreground'
      : isFailed
        ? 'text-status-failure-foreground dark:text-status-failure-dark-foreground'
        : isCancelled
          ? 'text-muted-foreground'
          : 'text-status-success-foreground dark:text-status-success-dark-foreground'
  )
  const iconProps = { className: iconClassName, strokeWidth: 2.2, 'aria-hidden': true } as const

  return (
    <MessageScrollerItem messageId={`compaction-activity-${activity.id}`} className="min-w-0">
      <div className={cn('px-4 pb-0.5 pt-2.5 md:px-6', contentPaddingClassName)}>
        <div
          className="flex min-w-0 items-center gap-3 py-1.5"
          data-testid="context-compaction-activity"
          role={isActive ? 'status' : undefined}
          aria-live={isActive ? 'polite' : undefined}
        >
          <span className="hidden h-px min-w-4 flex-1 bg-border-200 sm:block" aria-hidden="true" />
          <span className="flex min-w-0 max-w-[44rem] items-center gap-2">
            <span className="grid size-7 shrink-0 place-items-center rounded-full border border-border-200 bg-bg-000">
              {isActive ? (
                <LoaderCircle {...iconProps} />
              ) : isFailed ? (
                <CircleAlert {...iconProps} />
              ) : isCancelled ? (
                <CircleMinus {...iconProps} />
              ) : (
                <Minimize2 {...iconProps} />
              )}
            </span>
            <span className="min-w-0">
              <span className="block text-[13px] font-medium leading-5 text-text-000">
                {formatActivityTitle(activity, undefined, t)}
              </span>
              <span className="block text-[12px] leading-4 text-muted-foreground">{note}</span>
            </span>
          </span>
          <span className="hidden h-px min-w-4 flex-1 bg-border-200 sm:block" aria-hidden="true" />
        </div>
      </div>
    </MessageScrollerItem>
  )
}

export { WorkspaceContextCompactionActivityRow }
