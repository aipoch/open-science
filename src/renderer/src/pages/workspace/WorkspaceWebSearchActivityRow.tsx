import { ErrorNotice } from '@/components/error-notice'
import { ExternalTextLink } from '@/components/ExternalTextLink'
import { useTranslation } from 'react-i18next'

import type { ToolActivity } from '@/stores/session-store-contract'

import type { AnnotationPort } from './annotations/annotation-port'
import { TextAnnotationSurface } from './annotations/TextAnnotationSurface'
import {
  WorkspaceWebActivityDetails,
  WorkspaceWebActivityFact
} from './WorkspaceWebActivityDetails'
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
        onRemove={annotationPort.onRemove}
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
  const { builtin, query, webResult, resultCount, results } = details
  const cancelled = phase === 'cancelled' || webResult?.error?.code === 'CANCELLED'
  const stopped = cancelled || phase === 'declined' || phase === 'closed' || phase === 'interrupted'
  const failed = !stopped && (phase === 'failed' || webResult?.status === 'error')
  const pending = !stopped && !failed && phase !== 'completed' && activity.status !== 'completed'
  const unavailable = !webResult || webResult.result_kind === 'restricted_grounded_result'
  const status = cancelled
    ? t('Cancelled')
    : phase === 'declined'
      ? t('Declined')
      : stopped
        ? t('request ended')
        : failed
          ? t('Failed')
          : pending
            ? t('Searching the web…')
            : unavailable
              ? t('Completed')
              : formatResultCountLabel(resultCount, t)
  const errorDescription =
    webResult?.error?.code === 'RATE_LIMITED'
      ? t(
          'The search service is temporarily limiting requests. Wait a moment, then ask to try again.'
        )
      : t('The web search could not finish. Check the connection, then ask to try again.')

  return (
    <WorkspaceToolActivityRowButton
      activity={activity}
      phase={phase}
      label={t('Web Search')}
      subtitle={query || undefined}
      metaLabel={
        builtin
          ? status
          : phase === 'closed'
            ? t('request ended')
            : formatResultCountLabel(resultCount, t)
      }
      isExpanded={isExpanded}
      canExpand={Boolean(builtin || query || resultCount)}
      panelClassName="mx-1 mb-1.5 min-w-0 space-y-2 rounded-[10px] border border-border-200 bg-bg-000 px-3.5 py-3 text-[12.5px] leading-5 shadow-card md:ml-[30px]"
      panelTestId="tool-search-details"
      onToggle={onToggleSearch}
    >
      {builtin ? (
        <>
          {failed ? (
            <ErrorNotice
              inline
              title={t('The web search could not finish')}
              description={errorDescription}
            />
          ) : stopped ? (
            <p role="status">{status}</p>
          ) : null}
          {query ? (
            <p className="select-text whitespace-pre-wrap [overflow-wrap:anywhere]">
              <span className="mr-1 text-text-100">{t('Query')}</span>
              {query}
            </p>
          ) : null}
          {!stopped && !failed && !pending ? (
            unavailable ? (
              <p className="text-text-100">{t('Result unavailable')}</p>
            ) : resultCount === 0 ? (
              <p>{t('No search results were returned. Try different search terms.')}</p>
            ) : (
              <>
                <div className="divide-y divide-border-200">
                  {results.map((source) => (
                    <article
                      key={source.url}
                      data-testid="web-search-source"
                      className="min-w-0 space-y-0.5 py-2 first:pt-0 last:pb-0"
                    >
                      <ExternalTextLink href={source.url} className="[overflow-wrap:anywhere]">
                        {source.title}
                      </ExternalTextLink>
                      <p className="text-xs text-text-100 [overflow-wrap:anywhere]">
                        {new URL(source.url).hostname}
                      </p>
                      {source.snippet ? (
                        <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                          {source.snippet}
                        </p>
                      ) : null}
                    </article>
                  ))}
                </div>
                {webResult.results_truncated ? (
                  <p className="text-text-100">{t('The returned search results are truncated.')}</p>
                ) : null}
              </>
            )
          ) : null}
          {failed && webResult?.error ? (
            <WorkspaceWebActivityDetails>
              <dl>
                <WorkspaceWebActivityFact label={t('Error')}>
                  {webResult.error.code}
                </WorkspaceWebActivityFact>
              </dl>
            </WorkspaceWebActivityDetails>
          ) : null}
        </>
      ) : (
        renderSearchDetailsBody(activity, details, t, annotationPort)
      )}
    </WorkspaceToolActivityRowButton>
  )
}

export { WorkspaceWebSearchActivityRow }
