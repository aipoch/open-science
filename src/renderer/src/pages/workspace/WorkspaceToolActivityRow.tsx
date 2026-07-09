import type { ToolActivity } from '@/stores/session-store'

import { WorkspaceActivityIcon } from './WorkspaceActivityIcon'
import { formatActivityTitle, isActivityActive } from './workspace-conversation-items'
import { getActivitySurfaceClassName } from './workspace-tool-activity-style'

type WorkspaceToolActivityRowProps = {
  activity: ToolActivity
}

// Renders a compact non-search tool activity with live status semantics while it is running.
const WorkspaceToolActivityRow = ({
  activity
}: WorkspaceToolActivityRowProps): React.JSX.Element => {
  const isActive = isActivityActive(activity)

  return (
    <div
      className={getActivitySurfaceClassName(activity)}
      data-testid="tool-chip"
      role={isActive ? 'status' : undefined}
      aria-live={isActive ? 'polite' : undefined}
    >
      <span className="mt-0.5 inline-flex shrink-0 items-center md:mt-0">
        <WorkspaceActivityIcon activity={activity} />
      </span>
      <span className="min-w-0 flex-1 truncate text-left">{formatActivityTitle(activity)}</span>
    </div>
  )
}

export { WorkspaceToolActivityRow }
