/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 */
import { MessageScrollerItem } from '@/components/ui/message-scroller'
import { cn } from '@/lib/utils'

import { WorkspaceToolActivityRow } from './WorkspaceToolActivityRow'

type WorkspaceContextCompactionActivityRowProps = React.ComponentProps<
  typeof WorkspaceToolActivityRow
> & {
  contentPaddingClassName?: string
}

// Context compaction is a control lifecycle, so it gets a quiet status block without tool controls.
const WorkspaceContextCompactionActivityRow = ({
  activity,
  contentPaddingClassName
}: WorkspaceContextCompactionActivityRowProps): React.JSX.Element => (
  <MessageScrollerItem messageId={`compaction-activity-${activity.id}`} className="min-w-0">
    <div className={cn('px-4 pb-0.5 pt-2.5 md:px-6', contentPaddingClassName)}>
      <div
        className="w-full overflow-hidden rounded-[14px] bg-bg-200/70 px-1.5 py-1"
        data-testid="context-compaction-activity"
      >
        <WorkspaceToolActivityRow activity={activity} />
      </div>
    </div>
  </MessageScrollerItem>
)

export { WorkspaceContextCompactionActivityRow }
