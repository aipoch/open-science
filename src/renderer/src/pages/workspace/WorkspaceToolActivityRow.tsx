import type { ToolActivity } from '@/stores/session-store'
import { useTranslation } from 'react-i18next'

import { WorkspaceActivityIcon } from './WorkspaceActivityIcon'
import { formatActivityTitle, isActivityActive } from './workspace-conversation-items'
import { getActivitySurfaceClassName } from './workspace-tool-activity-style'
import type { ToolExecutionPhase } from './tool-execution-phase'

type WorkspaceToolActivityRowProps = {
  activity: ToolActivity
  phase?: ToolExecutionPhase
}

// Renders a compact non-search tool activity with live status semantics while it is running.
const WorkspaceToolActivityRow = ({
  activity,
  phase
}: WorkspaceToolActivityRowProps): React.JSX.Element => {
  const { t } = useTranslation()
  const isActive = phase ? phase === 'executing' : isActivityActive(activity)

  return (
    <div
      className={getActivitySurfaceClassName(activity, phase)}
      data-testid="tool-chip"
      role={isActive ? 'status' : undefined}
      aria-live={isActive ? 'polite' : undefined}
    >
      <span className="mt-0.5 inline-flex shrink-0 items-center md:mt-0">
        <WorkspaceActivityIcon activity={activity} phase={phase} />
      </span>
      <span
        className={`min-w-0 flex-1 truncate text-left ${phase === 'declined' ? 'text-text-000' : ''}`}
      >
        {formatActivityTitle(activity, phase, t)}
      </span>
    </div>
  )
}

export { WorkspaceToolActivityRow }
