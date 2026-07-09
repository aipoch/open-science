import type { ToolActivity } from '@/stores/session-store'

import type { ToolActivityDetails, ToolDetailSection } from './workspace-tool-activity-details'
import { WorkspaceToolActivityRowButton } from './WorkspaceToolActivityRowButton'
import { WorkspaceToolCodeBlock } from './WorkspaceToolCodeBlock'
import { WorkspaceToolDiffBlock } from './WorkspaceToolDiffBlock'

type WorkspaceToolDetailsRowProps = {
  activity: ToolActivity
  details: ToolActivityDetails
  isExpanded: boolean
  onToggle: (activityId: string, nextExpanded: boolean) => void
}

// Renders one detail section as either a highlighted code block or a compact diff block.
const renderSection = (section: ToolDetailSection, index: number): React.JSX.Element => (
  <div key={index} className="space-y-1">
    <div className="text-[11px] font-medium uppercase tracking-wide text-text-300">
      {section.label}
    </div>
    {section.kind === 'diff' ? (
      <WorkspaceToolDiffBlock section={section} />
    ) : (
      <>
        <WorkspaceToolCodeBlock code={section.text} language={section.language} />
        {section.truncated ? (
          <div className="text-[11px] text-text-300">Output truncated</div>
        ) : null}
      </>
    )}
  </div>
)

// Renders a non-search tool call with an expandable panel showing input, output, or diffs.
const WorkspaceToolDetailsRow = ({
  activity,
  details,
  isExpanded,
  onToggle
}: WorkspaceToolDetailsRowProps): React.JSX.Element => (
  <WorkspaceToolActivityRowButton
    activity={activity}
    label={details.displayName}
    subtitle={details.subtitle}
    metaLabel={details.metaLabel}
    isExpanded={isExpanded}
    panelClassName="mx-1 mb-1.5 space-y-2.5 md:ml-[30px]"
    panelTestId="tool-details"
    onToggle={onToggle}
  >
    {details.sections.map(renderSection)}
  </WorkspaceToolActivityRowButton>
)

export { WorkspaceToolDetailsRow }
