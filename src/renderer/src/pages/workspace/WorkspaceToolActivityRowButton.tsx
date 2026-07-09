import type { ReactNode } from 'react'

import type { ToolActivity } from '@/stores/session-store'

import { WorkspaceActivityIcon } from './WorkspaceActivityIcon'
import { isActivityActive } from './workspace-conversation-items'
import { getActivitySurfaceClassName } from './workspace-tool-activity-style'

type WorkspaceToolActivityRowButtonProps = {
  activity: ToolActivity
  label: string
  subtitle?: string
  metaLabel?: string
  isExpanded: boolean
  canExpand?: boolean
  panelClassName: string
  panelTestId: string
  onToggle: (activityId: string, nextExpanded: boolean) => void
  children: ReactNode
}

// Tool call ids are protocol-safe tokens, so a sanitized prefix keeps aria-controls deterministic.
const createRowDetailsDomId = (activityId: string): string =>
  `tool-details-${activityId.replace(/[^A-Za-z0-9_-]/gu, '_') || 'row'}`

// The shared expandable row shell: icon + "label · subtitle" + right meta, with its detail panel.
const WorkspaceToolActivityRowButton = ({
  activity,
  label,
  subtitle,
  metaLabel,
  isExpanded,
  canExpand = true,
  panelClassName,
  panelTestId,
  onToggle,
  children
}: WorkspaceToolActivityRowButtonProps): React.JSX.Element => {
  const isActive = isActivityActive(activity)
  const detailsDomId = createRowDetailsDomId(activity.id)

  return (
    <>
      <button
        type="button"
        className={getActivitySurfaceClassName(activity)}
        data-testid="tool-chip"
        aria-expanded={canExpand ? isExpanded : undefined}
        aria-controls={canExpand ? detailsDomId : undefined}
        disabled={!canExpand}
        aria-live={isActive ? 'polite' : undefined}
        onClick={() => onToggle(activity.id, !isExpanded)}
      >
        <span className="mt-0.5 inline-flex shrink-0 items-center md:mt-0">
          <WorkspaceActivityIcon activity={activity} />
        </span>
        <span className="min-w-0 flex-1 text-left md:flex md:items-center md:gap-2">
          <span className="block shrink-0 text-text-000">{label}</span>
          {subtitle ? (
            <>
              <span className="hidden shrink-0 text-text-300 md:inline">·</span>
              <span className="mt-0.5 block min-w-0 truncate font-normal text-text-100 md:mt-0">
                {subtitle}
              </span>
            </>
          ) : null}
        </span>
        {metaLabel ? (
          <span className="mt-0.5 shrink-0 whitespace-nowrap text-[12px] tabular-nums text-text-100 md:mt-0">
            {metaLabel}
          </span>
        ) : null}
      </button>
      {canExpand && isExpanded ? (
        <div id={detailsDomId} data-testid={panelTestId} className={panelClassName}>
          {children}
        </div>
      ) : null}
    </>
  )
}

export { WorkspaceToolActivityRowButton }
