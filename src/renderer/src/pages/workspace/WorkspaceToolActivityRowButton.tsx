import type { ReactNode, Ref } from 'react'

import type { ToolActivity } from '@/stores/session-store'

import { WorkspaceActivityIcon } from './WorkspaceActivityIcon'
import { WorkspaceCollapsiblePanel } from './WorkspaceCollapsiblePanel'
import { isActivityActive } from './workspace-conversation-items'
import { getActivitySurfaceClassName } from './workspace-tool-activity-style'
import type { ToolExecutionPhase } from './tool-execution-phase'

type WorkspaceToolActivityRowButtonProps = {
  activity: ToolActivity
  phase?: ToolExecutionPhase
  label: string
  subtitle?: ReactNode
  metaLabel?: string
  isExpanded: boolean
  canExpand?: boolean
  panelClassName: string
  panelTestId: string
  buttonRef?: Ref<HTMLButtonElement>
  onToggle: (activityId: string, nextExpanded: boolean) => void
  children: ReactNode
}

// Tool call ids are protocol-safe tokens, so a sanitized prefix keeps aria-controls deterministic.
const createRowDetailsDomId = (activityId: string): string =>
  `tool-details-${activityId.replace(/[^A-Za-z0-9_-]/gu, '_') || 'row'}`

// The shared expandable row shell: icon + "label · subtitle" + right meta, with its detail panel.
const WorkspaceToolActivityRowButton = ({
  activity,
  phase,
  label,
  subtitle,
  metaLabel,
  isExpanded,
  canExpand = true,
  panelClassName,
  panelTestId,
  buttonRef,
  onToggle,
  children
}: WorkspaceToolActivityRowButtonProps): React.JSX.Element => {
  const isActive = phase ? phase === 'executing' : isActivityActive(activity)
  const detailsDomId = createRowDetailsDomId(activity.id)

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={getActivitySurfaceClassName(activity, phase)}
        data-testid="tool-chip"
        aria-expanded={canExpand ? isExpanded : undefined}
        aria-controls={canExpand ? detailsDomId : undefined}
        disabled={!canExpand}
        aria-live={isActive ? 'polite' : undefined}
        onClick={() => onToggle(activity.id, !isExpanded)}
      >
        <span className="mt-0.5 inline-flex shrink-0 items-center md:mt-0">
          <WorkspaceActivityIcon activity={activity} phase={phase} />
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
      <WorkspaceCollapsiblePanel isOpen={canExpand && isExpanded}>
        <div id={detailsDomId} data-testid={panelTestId} className={panelClassName}>
          {children}
        </div>
      </WorkspaceCollapsiblePanel>
    </>
  )
}

export { WorkspaceToolActivityRowButton }
