import type { ToolActivity } from '@/stores/session-store'

import { WorkspaceToolActivityRowButton } from './WorkspaceToolActivityRowButton'
import type { WebSearchDetails } from './workspace-web-search-details'

type WorkspaceWebSearchActivityRowProps = {
  activity: ToolActivity
  details: WebSearchDetails
  isExpanded: boolean
  onToggleSearch: (activityId: string, nextExpanded: boolean) => void
}

// Formats the compact right-side count label while preserving zero-result visibility.
const formatResultCountLabel = (resultCount: number): string =>
  resultCount === 1 ? '1 result' : `${resultCount} results`

// Renders the expanded payload: the query followed by compact title/url result pairs.
const renderSearchDetailsBody = (details: WebSearchDetails): React.JSX.Element => (
  <>
    <div className="grid grid-cols-[auto_1fr] items-start gap-x-4 gap-y-1.5">
      <span className="pt-px text-text-100">query</span>
      <span className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-text-000">
        {details.query}
      </span>
    </div>
    {details.results.length > 0 ? (
      <div className="mt-2.5 space-y-1.5">
        {details.results.map((result) => (
          <div key={result.url} className="text-xs">
            <a
              href={result.url}
              target="_blank"
              rel="noopener noreferrer"
              className="break-words text-text-000 hover:underline"
            >
              {result.title}
            </a>
            <div className="truncate text-[10px] text-text-100">{result.url}</div>
          </div>
        ))}
      </div>
    ) : null}
  </>
)

// Renders one web-search activity row with an optional expandable result summary.
const WorkspaceWebSearchActivityRow = ({
  activity,
  details,
  isExpanded,
  onToggleSearch
}: WorkspaceWebSearchActivityRowProps): React.JSX.Element => (
  <WorkspaceToolActivityRowButton
    activity={activity}
    label="Web Search"
    subtitle={details.query || undefined}
    metaLabel={formatResultCountLabel(details.resultCount)}
    isExpanded={isExpanded}
    // Rows without any query or result metadata remain visible but non-interactive.
    canExpand={Boolean(details.query || details.resultCount)}
    panelClassName="mx-1 mb-1.5 rounded-[10px] border border-border-200 bg-bg-000 px-3.5 py-3 text-[12.5px] leading-5 shadow-card md:ml-[30px]"
    panelTestId="tool-search-details"
    onToggle={onToggleSearch}
  >
    {renderSearchDetailsBody(details)}
  </WorkspaceToolActivityRowButton>
)

export { WorkspaceWebSearchActivityRow }
