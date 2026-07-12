import type { ToolActivity } from '@/stores/session-store'

import type {
  ToolActivityDetails,
  ToolCodeSection,
  ToolDetailSection
} from './workspace-tool-activity-details'
import { WorkspaceToolActivityRowButton } from './WorkspaceToolActivityRowButton'
import { WorkspaceToolCodeBlock } from './WorkspaceToolCodeBlock'
import { WorkspaceToolDiffBlock } from './WorkspaceToolDiffBlock'

type WorkspaceToolDetailsRowProps = {
  activity: ToolActivity
  details: ToolActivityDetails
  isExpanded: boolean
  onToggle: (activityId: string, nextExpanded: boolean) => void
}

// Section label styling shared by static headers and collapsible toggles.
const sectionLabelClassName = 'text-[11px] font-medium uppercase tracking-wide text-text-300'

// Renders a code block plus its optional truncation note.
const renderCodeBody = (section: ToolCodeSection): React.JSX.Element => (
  <>
    <WorkspaceToolCodeBlock code={section.text} language={section.language} />
    {section.truncated ? <div className="text-[11px] text-text-300">Output truncated</div> : null}
  </>
)

// Renders one detail section as a diff, a collapsible code panel, or a plain code block.
const renderSection = (section: ToolDetailSection, index: number): React.JSX.Element => {
  if (section.kind === 'diff') {
    return (
      <div key={index} className="space-y-1">
        <div className={sectionLabelClassName}>{section.label}</div>
        <WorkspaceToolDiffBlock section={section} />
      </div>
    )
  }

  // Collapsible sections (e.g. notebook output) start closed so the code stays the focus.
  if (section.collapsible) {
    return (
      <details key={index} className="space-y-1">
        <summary className={`${sectionLabelClassName} cursor-pointer select-none`}>
          {section.label}
        </summary>
        <div className="mt-1">{renderCodeBody(section)}</div>
      </details>
    )
  }

  return (
    <div key={index} className="space-y-1">
      <div className={sectionLabelClassName}>{section.label}</div>
      {renderCodeBody(section)}
    </div>
  )
}

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
