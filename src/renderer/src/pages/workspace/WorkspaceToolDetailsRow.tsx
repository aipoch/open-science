import type { ToolActivity } from '@/stores/session-store'

import { usePreviewFileContent } from './previews/usePreviewFileContent'

// Byte cap for inline tool-output image previews. Co-located here (rather than in preview-support,
// which #147 refactored into format detection) since it's specific to this panel's base64 read.
const PREVIEW_PANEL_IMAGE_MAX_BYTES = 10 * 1024 * 1024
import type {
  ToolActivityDetails,
  ToolCodeSection,
  ToolDetailSection,
  ToolImageSection
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

// Loads an image artifact's bytes through the same reader the artifact preview gallery uses and
// renders it inline; falls back to filename/path text while loading or if the read fails.
const WorkspaceToolImageOutput = ({
  section
}: {
  section: ToolImageSection
}): React.JSX.Element => {
  const state = usePreviewFileContent({
    path: section.path,
    maxBytes: PREVIEW_PANEL_IMAGE_MAX_BYTES,
    encoding: 'base64'
  })
  const caption = [section.name, section.sizeLabel].filter(Boolean).join(' · ')

  if (state.status === 'ready' && state.preview.encoding === 'base64' && !state.preview.truncated) {
    return (
      <div className="space-y-1">
        <img
          data-testid="tool-output-image"
          src={`data:${section.mimeType};base64,${state.preview.content}`}
          alt={section.name ?? 'Tool output image'}
          className="max-h-64 max-w-full rounded-md border border-border-200 object-contain"
          draggable={false}
        />
        {caption ? <div className="text-[11px] text-text-300">{caption}</div> : null}
      </div>
    )
  }

  const fallbackText =
    state.status === 'loading' ? 'Loading preview…' : (section.name ?? section.path)

  return <div className="text-[12px] text-text-300">{fallbackText}</div>
}

// Renders one detail section as a diff, an image preview, a collapsible code panel, or a plain
// code block.
const renderSection = (section: ToolDetailSection, index: number): React.JSX.Element => {
  if (section.kind === 'diff') {
    return (
      <div key={index} className="space-y-1">
        <div className={sectionLabelClassName}>{section.label}</div>
        <WorkspaceToolDiffBlock section={section} />
      </div>
    )
  }

  if (section.kind === 'image') {
    return (
      <div key={index} className="space-y-1">
        <div className={sectionLabelClassName}>{section.label}</div>
        <WorkspaceToolImageOutput section={section} />
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
