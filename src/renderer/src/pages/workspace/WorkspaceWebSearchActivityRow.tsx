import { useTranslation } from 'react-i18next'

import type { ToolActivity } from '@/stores/session-store'

import type { AnnotationPort } from './annotations/annotation-port'
import { TextAnnotationSurface } from './annotations/TextAnnotationSurface'
import { WorkspaceToolActivityRowButton } from './WorkspaceToolActivityRowButton'
import type { ToolExecutionPhase } from './tool-execution-phase'
import type { WebSearchDetails } from './workspace-web-search-details'

type WorkspaceWebSearchActivityRowProps = {
  activity: ToolActivity
  phase?: ToolExecutionPhase
  details: WebSearchDetails
  isExpanded: boolean
  onToggleSearch: (activityId: string, nextExpanded: boolean) => void
  annotationPort?: AnnotationPort
}

// Formats the compact right-side count label while preserving zero-result visibility.
const formatResultCountLabel = (
  resultCount: number,
  t: (key: string, options?: Record<string, unknown>) => string
): string => (resultCount === 1 ? t('1 result') : t('{{count}} results', { count: resultCount }))

// Renders the expanded payload: the query followed by compact title/url result pairs.
const renderSearchDetailsBody = (
  activity: ToolActivity,
  details: WebSearchDetails,
  t: ReturnType<typeof useTranslation>['t'],
  annotationPort?: AnnotationPort
): React.JSX.Element => {
  const annotate = (children: React.ReactNode, sectionId: string): React.JSX.Element =>
    annotationPort ? (
      <TextAnnotationSurface
        source={{
          kind: 'session-item',
          sessionId: annotationPort.sessionId,
          itemType: 'tool-activity',
          itemId: activity.id,
          sectionId
        }}
        activeAnnotations={annotationPort.activeAnnotations}
        onAdd={annotationPort.onAdd}
        onUpdateNote={annotationPort.onUpdateNote}
        onError={annotationPort.onError}
      >
        {children}
      </TextAnnotationSurface>
    ) : (
      <>{children}</>
    )

  return (
    <>
      <div className="grid grid-cols-[auto_1fr] items-start gap-x-4 gap-y-1.5">
        <span className="pt-px text-text-100">{t('query')}</span>
        {annotate(
          <span className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-text-000">
            {details.query}
          </span>,
          'query'
        )}
      </div>
      {details.results.length > 0 ? (
        <div className="mt-2.5 space-y-1.5">
          {details.results.map((result) => (
            <div key={result.url} className="text-xs">
              {annotate(
                <a
                  href={result.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="break-words text-text-000 hover:underline"
                  onClick={(event) => {
                    const selection = window.getSelection()
                    if (
                      selection &&
                      !selection.isCollapsed &&
                      selection.anchorNode &&
                      selection.focusNode &&
                      event.currentTarget.contains(selection.anchorNode) &&
                      event.currentTarget.contains(selection.focusNode)
                    ) {
                      event.preventDefault()
                    }
                  }}
                >
                  {result.title}
                </a>,
                `result:${encodeURIComponent(result.url)}:title`
              )}
              <div className="truncate text-[10px] text-text-100">{result.url}</div>
            </div>
          ))}
        </div>
      ) : null}
    </>
  )
}

// Renders one web-search activity row with an optional expandable result summary.
const WorkspaceWebSearchActivityRow = ({
  activity,
  phase,
  details,
  isExpanded,
  onToggleSearch,
  annotationPort
}: WorkspaceWebSearchActivityRowProps): React.JSX.Element => {
  const { t } = useTranslation()

  return (
    <WorkspaceToolActivityRowButton
      activity={activity}
      phase={phase}
      label={t('Web Search')}
      subtitle={details.query || undefined}
      metaLabel={
        phase === 'closed' ? t('request ended') : formatResultCountLabel(details.resultCount, t)
      }
      isExpanded={isExpanded}
      // Rows without any query or result metadata remain visible but non-interactive.
      canExpand={Boolean(details.query || details.resultCount)}
      panelClassName="mx-1 mb-1.5 rounded-[10px] border border-border-200 bg-bg-000 px-3.5 py-3 text-[12.5px] leading-5 shadow-card md:ml-[30px]"
      panelTestId="tool-search-details"
      onToggle={onToggleSearch}
    >
      {renderSearchDetailsBody(activity, details, t, annotationPort)}
    </WorkspaceToolActivityRowButton>
  )
}

export { WorkspaceWebSearchActivityRow }
