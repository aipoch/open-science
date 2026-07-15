import { MessageScrollerItem } from '@/components/ui/message-scroller'
import { cn } from '@/lib/utils'
import { ChevronRight } from 'lucide-react'

import { WorkspaceToolActivityRow } from './WorkspaceToolActivityRow'
import { WorkspaceToolDetailsRow } from './WorkspaceToolDetailsRow'
import { WorkspaceWebSearchActivityRow } from './WorkspaceWebSearchActivityRow'
import {
  buildToolActivityDetails,
  isNotebookExecuteActivity
} from './workspace-tool-activity-details'
import {
  formatActivityGroupTitle,
  formatStepCount,
  getRenderableActivityEntries,
  isSearchActivity
} from './workspace-tool-activity-groups'
import type {
  ActivityExpansionOverrides,
  ConversationActivityGroupItem
} from './workspace-tool-activity-groups'
import { formatWebSearchDetails } from './workspace-web-search-details'

type WorkspaceActivityGroupProps = {
  group: ConversationActivityGroupItem
  isExpanded: boolean
  onToggleGroup: (groupId: string) => void
  expansionOverrides: ActivityExpansionOverrides
  onToggleRow: (activityId: string, nextExpanded: boolean) => void
}

// Renders adjacent tool calls as one collapsible transcript row group.
const WorkspaceActivityGroup = ({
  group,
  isExpanded,
  onToggleGroup,
  expansionOverrides,
  onToggleRow
}: WorkspaceActivityGroupProps): React.JSX.Element => {
  // ToolSearch wrapper rows are hidden when concrete search rows are present.
  const renderableActivityEntries = getRenderableActivityEntries(group.activities)
  const visibleActivities = renderableActivityEntries.map(({ activity }) => activity)

  return (
    <MessageScrollerItem key={group.id} messageId={group.id} className="min-w-0">
      <div className="px-4 pb-1 pt-5 md:px-6">
        <div
          className="w-full overflow-hidden rounded-[14px] bg-bg-200/70 px-1.5 py-1"
          data-testid="tool-group"
        >
          <button
            type="button"
            aria-expanded={isExpanded}
            data-testid="tool-group-header"
            className="flex w-full items-center gap-2 rounded-lg py-[5px] pl-1.5 pr-2.5 text-[13px] transition-colors hover:bg-bg-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
            onClick={() => onToggleGroup(group.id)}
          >
            <span
              className={cn(
                'inline-flex w-4 shrink-0 items-center justify-center text-text-100 transition-transform duration-200',
                isExpanded ? 'rotate-90' : undefined
              )}
            >
              <ChevronRight className="size-3.5" strokeWidth={2.2} aria-hidden="true" />
            </span>
            <span className="min-w-0 truncate text-left font-medium text-text-000">
              {formatActivityGroupTitle(group.activities)}
            </span>
            <span className="ml-auto shrink-0 whitespace-nowrap text-[12px] tabular-nums text-text-100">
              {formatStepCount(visibleActivities)}
            </span>
          </button>
          {isExpanded ? (
            <div className="grid grid-rows-[1fr] transition-[grid-template-rows] duration-200 ease-out">
              <div className="min-h-0 overflow-hidden">
                {renderableActivityEntries.map(({ activity, activityIndex }) => {
                  // Search rows get bespoke query/result details; other tools reuse the shared builder.
                  const isSearch = isSearchActivity(activity, group.activities, activityIndex)
                  const searchDetails = isSearch ? formatWebSearchDetails(activity) : undefined
                  const toolDetails = isSearch ? undefined : buildToolActivityDetails(activity)
                  // Notebook cells lead with their code, so show it unfolded unless the user collapsed it.
                  const isRowExpanded =
                    expansionOverrides[activity.id] ?? isNotebookExecuteActivity(activity)

                  return (
                    <div key={activity.id} className="w-full overflow-hidden">
                      {searchDetails ? (
                        <WorkspaceWebSearchActivityRow
                          activity={activity}
                          details={searchDetails}
                          isExpanded={isRowExpanded}
                          onToggleSearch={onToggleRow}
                        />
                      ) : toolDetails ? (
                        <WorkspaceToolDetailsRow
                          activity={activity}
                          details={toolDetails}
                          isExpanded={isRowExpanded}
                          onToggle={onToggleRow}
                        />
                      ) : (
                        <WorkspaceToolActivityRow activity={activity} />
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </MessageScrollerItem>
  )
}

export { WorkspaceActivityGroup }
