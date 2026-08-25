import type { ToolActivity } from '@/stores/session-store'
import type { NotebookRunRecord } from '../../../../shared/notebook'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

import { ExtensionPreservingFileName } from './ExtensionPreservingFileName'
import {
  formatNotebookRunFigureMeta,
  formatNotebookRunOutputLineMeta
} from './notebook-run-figures'
import { NotebookToolFigureOutputs } from './NotebookToolFigureOutputs'
import { notebookRunStatusLabel } from './notebook-cell-utils'
import { usePreviewFileContent } from './previews/usePreviewFileContent'
import { useNearViewport } from './previews/useNearViewport'

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
import type { ToolExecutionPhase } from './tool-execution-phase'

type WorkspaceToolDetailsRowProps = {
  activity: ToolActivity
  phase?: ToolExecutionPhase
  details: ToolActivityDetails
  notebookRun?: NotebookRunRecord
  isExpanded: boolean
  onNotebookRunNearViewport?: (runId: string, isNearViewport: boolean) => void
  onToggle: (activityId: string, nextExpanded: boolean) => void
}

// Section label styling shared by static headers and collapsible toggles.
const sectionLabelClassName = 'text-[11px] font-medium uppercase tracking-wide text-text-300'

const TRANSLATABLE_TOOL_DETAIL_COPY = new Set([
  'Agent SDK',
  'Code',
  'Command',
  'Content',
  'Error',
  'File',
  'Input',
  'Log',
  'Manage packages',
  'Notebook run',
  'Output',
  'Packages',
  'Prompt',
  'Request',
  'Result',
  'Shell',
  'Tool search',
  'Tools found',
  'Web Fetch',
  'Write file'
])

// Renders a code block plus its optional truncation note.
const renderCodeBody = (
  section: ToolCodeSection,
  t: (key: string) => string
): React.JSX.Element => (
  <>
    <WorkspaceToolCodeBlock code={section.text} language={section.language} />
    {section.truncated ? (
      <div className="text-[11px] text-text-300">{t('Output truncated')}</div>
    ) : null}
  </>
)

// Loads an image artifact's bytes through the same reader the artifact preview gallery uses and
// renders it inline; falls back to filename/path text while loading or if the read fails.
const WorkspaceToolImageOutput = ({
  section
}: {
  section: ToolImageSection
}): React.JSX.Element => {
  const { t } = useTranslation()
  const state = usePreviewFileContent({
    path: section.path,
    maxBytes: PREVIEW_PANEL_IMAGE_MAX_BYTES,
    encoding: 'base64'
  })
  if (state.status === 'ready' && state.preview.encoding === 'base64' && !state.preview.truncated) {
    return (
      <div className="space-y-1">
        <img
          data-testid="tool-output-image"
          src={`data:${section.mimeType};base64,${state.preview.content}`}
          alt={section.name ?? t('Tool output image')}
          className="max-h-64 max-w-full rounded-md border border-border-200 object-contain"
          draggable={false}
        />
        {section.name || section.sizeLabel ? (
          <div className="flex min-w-0 items-center gap-1 text-[11px] text-text-300">
            {section.name ? <ExtensionPreservingFileName name={section.name} /> : null}
            {section.name && section.sizeLabel ? <span className="shrink-0">·</span> : null}
            {section.sizeLabel ? <span className="shrink-0">{section.sizeLabel}</span> : null}
          </div>
        ) : null}
      </div>
    )
  }

  const fallbackText =
    state.status === 'loading'
      ? t('Loading preview…')
      : (section.name ?? (section.path.split(/[\\/]/u).at(-1) || section.path))

  return (
    <div className="text-[12px] text-text-300">
      {state.status === 'loading' ? (
        fallbackText
      ) : (
        <ExtensionPreservingFileName name={fallbackText} />
      )}
    </div>
  )
}

// Renders a non-search tool call with an expandable panel showing input, output, or diffs.
const WorkspaceToolDetailsRow = ({
  activity,
  phase,
  details,
  notebookRun,
  isExpanded,
  onNotebookRunNearViewport,
  onToggle
}: WorkspaceToolDetailsRowProps): React.JSX.Element => {
  const { t } = useTranslation()
  const [setRowElement, isNearViewport] = useNearViewport<HTMLButtonElement>()
  const notebookRunId = details.notebookRunId
  const notebookFigureMeta = notebookRun ? formatNotebookRunFigureMeta(notebookRun, t) : undefined
  const notebookOutputLineMeta = notebookRun
    ? formatNotebookRunOutputLineMeta(notebookRun, t)
    : undefined
  const notebookRunStatus = notebookRun ? notebookRunStatusLabel(notebookRun.status) : undefined
  const notebookTerminalMeta = notebookRunStatus
    ? t(notebookRunStatus)
    : notebookRun?.status === 'completed'
      ? t('done')
      : details.metaLabel
  const notebookRunMeta = notebookFigureMeta
    ? [
        notebookFigureMeta,
        notebookRunStatus ? t(notebookRunStatus) : (notebookOutputLineMeta ?? notebookTerminalMeta)
      ]
        .filter(Boolean)
        .join(' · ')
    : notebookRunStatus
      ? t(notebookRunStatus)
      : undefined
  const translateKnownCopy = (value: string): string =>
    TRANSLATABLE_TOOL_DETAIL_COPY.has(value) ? t(value) : value

  // Keep every near row registered even after hydration so the owner's LRU cannot evict a figure
  // that remains visible. The owner batches targeted IPC reads and trims records after rows leave.
  useEffect(() => {
    if (!notebookRunId || !onNotebookRunNearViewport) return undefined

    onNotebookRunNearViewport(notebookRunId, isNearViewport)
    return () => {
      if (isNearViewport) onNotebookRunNearViewport(notebookRunId, false)
    }
  }, [isNearViewport, notebookRunId, onNotebookRunNearViewport])

  const renderSection = (section: ToolDetailSection, index: number): React.JSX.Element => {
    if (section.kind === 'diff') {
      return (
        <div key={index} className="space-y-1">
          <div className={sectionLabelClassName}>{translateKnownCopy(section.label)}</div>
          <WorkspaceToolDiffBlock section={section} />
        </div>
      )
    }

    if (section.kind === 'image') {
      return (
        <div key={index} className="space-y-1">
          <div className={sectionLabelClassName}>{translateKnownCopy(section.label)}</div>
          <WorkspaceToolImageOutput section={section} />
        </div>
      )
    }

    // Collapsible sections (e.g. notebook output) start closed so the code stays the focus.
    if (section.collapsible) {
      return (
        <details key={index} className="space-y-1">
          <summary className={`${sectionLabelClassName} cursor-pointer select-none`}>
            {translateKnownCopy(section.label)}
          </summary>
          <div className="mt-1">{renderCodeBody(section, t)}</div>
        </details>
      )
    }

    return (
      <div key={index} className="space-y-1">
        <div className={sectionLabelClassName}>{translateKnownCopy(section.label)}</div>
        {renderCodeBody(section, t)}
      </div>
    )
  }

  return (
    <>
      <WorkspaceToolActivityRowButton
        activity={activity}
        phase={phase}
        label={translateKnownCopy(details.displayName)}
        subtitle={
          details.displayName === 'Write file' && details.subtitle ? (
            <ExtensionPreservingFileName name={details.subtitle} />
          ) : (
            details.subtitle
          )
        }
        metaLabel={
          phase === 'prepared'
            ? t('code shown')
            : phase === 'awaiting-approval'
              ? t('waiting for your approval')
              : phase === 'declined'
                ? t('declined by you')
                : phase === 'closed'
                  ? t('request ended')
                  : (notebookRunMeta ?? details.metaLabel)
        }
        isExpanded={isExpanded}
        panelClassName="mx-1 mb-1.5 space-y-2.5 md:ml-[30px]"
        panelTestId="tool-details"
        buttonRef={setRowElement}
        onToggle={onToggle}
      >
        {details.sections.map(renderSection)}
      </WorkspaceToolActivityRowButton>
      {notebookRun ? <NotebookToolFigureOutputs run={notebookRun} /> : null}
    </>
  )
}

export { WorkspaceToolDetailsRow }
