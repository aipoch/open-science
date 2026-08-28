import type { ToolActivity } from '@/stores/session-store'
import type { NotebookRunRecord } from '../../../../shared/notebook'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { ExtensionPreservingFileName } from './ExtensionPreservingFileName'
import {
  formatNotebookRunFigureMeta,
  formatNotebookRunOutputLineMeta
} from './notebook-run-figures'
import { NotebookToolFigureOutputs } from './NotebookToolFigureOutputs'
import { notebookRunStatusLabel } from './notebook-cell-utils'
import { useNearViewport } from './previews/useNearViewport'
import type {
  ToolActivityDetails,
  ToolCodeSection,
  ToolDetailSection
} from './workspace-tool-activity-details'
import { WorkspaceToolActivityRowButton } from './WorkspaceToolActivityRowButton'
import { WorkspaceToolCodeBlock } from './WorkspaceToolCodeBlock'
import { WorkspaceToolDiffBlock } from './WorkspaceToolDiffBlock'
import type { ToolExecutionPhase } from './tool-execution-phase'
import type { SessionTextAnnotationItemType } from '../../../../shared/annotations'
import type { AnnotationPort } from './annotations/annotation-port'
import { TextAnnotationSurface } from './annotations/TextAnnotationSurface'

type WorkspaceToolDetailsRowProps = {
  activity: ToolActivity
  phase?: ToolExecutionPhase
  details: ToolActivityDetails
  notebookRun?: NotebookRunRecord
  isExpanded: boolean
  onNotebookRunNearViewport?: (runId: string, isNearViewport: boolean) => void
  onToggle: (activityId: string, nextExpanded: boolean) => void
  annotationPort?: AnnotationPort
  annotationItemType?: SessionTextAnnotationItemType
  revealRequest?: Readonly<{ requestId: number; itemId: string; sectionId?: string }>
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
  'Skill',
  'Tool search',
  'Tools found',
  'Web Fetch',
  'Write file'
])

// Renders a code block plus its optional truncation note.
const renderCodeBody = (
  section: ToolCodeSection,
  t: (key: string) => string,
  annotationContext: Pick<
    WorkspaceToolDetailsRowProps,
    'activity' | 'annotationPort' | 'annotationItemType'
  >
): React.JSX.Element => {
  const body = <WorkspaceToolCodeBlock code={section.text} language={section.language} />
  const sectionId = section.label.trim().toLowerCase()
  const annotatableBody = annotationContext.annotationPort ? (
    <TextAnnotationSurface
      source={{
        kind: 'session-item',
        sessionId: annotationContext.annotationPort.sessionId,
        itemType: annotationContext.annotationItemType ?? 'tool-activity',
        itemId: annotationContext.activity.id,
        sectionId
      }}
      activeAnnotations={annotationContext.annotationPort.activeAnnotations}
      onAdd={annotationContext.annotationPort.onAdd}
      onUpdateNote={annotationContext.annotationPort.onUpdateNote}
      onError={annotationContext.annotationPort.onError}
    >
      {body}
    </TextAnnotationSurface>
  ) : (
    body
  )

  return (
    <>
      {annotatableBody}
      {section.truncated ? (
        <div className="text-[11px] text-text-300">{t('Output truncated')}</div>
      ) : null}
    </>
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
  onToggle,
  annotationPort,
  annotationItemType,
  revealRequest
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
  const annotationContext = {
    activity,
    annotationPort,
    annotationItemType
  }
  const collapsibleSectionRefs = useRef(new Map<string, HTMLDetailsElement>())
  useLayoutEffect(() => {
    if (!revealRequest?.sectionId) return
    const detailsElement = collapsibleSectionRefs.current.get(revealRequest.sectionId)
    if (detailsElement) detailsElement.open = true
  }, [revealRequest])

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
      const diffBody = <WorkspaceToolDiffBlock section={section} />
      return (
        <div key={index} className="space-y-1">
          <div className={sectionLabelClassName}>{translateKnownCopy(section.label)}</div>
          {annotationPort ? (
            <TextAnnotationSurface
              source={{
                kind: 'session-item',
                sessionId: annotationPort.sessionId,
                itemType: annotationItemType ?? 'tool-activity',
                itemId: activity.id,
                sectionId: `diff:${index}`
              }}
              activeAnnotations={annotationPort.activeAnnotations}
              onAdd={annotationPort.onAdd}
              onUpdateNote={annotationPort.onUpdateNote}
              onError={annotationPort.onError}
            >
              {diffBody}
            </TextAnnotationSurface>
          ) : (
            diffBody
          )}
        </div>
      )
    }

    // Collapsible sections (e.g. notebook output) start closed so the code stays the focus.
    if (section.collapsible) {
      const sectionId = section.label.trim().toLowerCase()
      return (
        <details
          key={index}
          ref={(element) => {
            if (element) collapsibleSectionRefs.current.set(sectionId, element)
            else collapsibleSectionRefs.current.delete(sectionId)
          }}
          data-tool-section-id={sectionId}
          className="space-y-1"
        >
          <summary className={`${sectionLabelClassName} cursor-pointer select-none`}>
            {translateKnownCopy(section.label)}
          </summary>
          <div className="mt-1">{renderCodeBody(section, t, annotationContext)}</div>
        </details>
      )
    }

    return (
      <div key={index} className="space-y-1">
        <div className={sectionLabelClassName}>{translateKnownCopy(section.label)}</div>
        {renderCodeBody(section, t, annotationContext)}
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
