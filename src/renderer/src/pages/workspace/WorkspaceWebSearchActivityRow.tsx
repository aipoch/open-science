import { useId, useLayoutEffect, useRef, useState } from 'react'
import { ErrorNotice } from '@/components/error-notice'
import { ExternalTextLink } from '@/components/ExternalTextLink'
import { Button } from '@/components/ui/button'
import { formatDateTime } from '@/lib/format-datetime'
import { cn } from '@/lib/utils'
import { useTranslation } from 'react-i18next'

import type { ToolActivity } from '@/stores/session-store-contract'
import { resolveLocaleFromTags } from '../../../../shared/locale'

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

const SearchExcerpt = ({ text }: { text: string }): React.JSX.Element => {
  const { t } = useTranslation()
  const id = useId()
  const excerptRef = useRef<HTMLParagraphElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)

  useLayoutEffect(() => {
    const excerpt = excerptRef.current
    if (!excerpt || expanded) return
    const measure = (): void => setOverflows(excerpt.scrollHeight > excerpt.clientHeight + 1)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(excerpt)
    return () => observer.disconnect()
  }, [expanded, text])

  return (
    <>
      <p
        id={id}
        ref={excerptRef}
        className={cn('whitespace-pre-wrap [overflow-wrap:anywhere]', !expanded && 'line-clamp-3')}
      >
        {text}
      </p>
      {overflows ? (
        <Button
          type="button"
          size="xs"
          variant="link"
          className="mt-0.5 h-auto min-h-6 px-0 py-0 text-[11px]"
          aria-controls={id}
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? t('Show less') : t('Show more')}
        </Button>
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
  const { t, i18n } = useTranslation()
  const locale = resolveLocaleFromTags([i18n.resolvedLanguage ?? i18n.language])
  const { builtin, query, webResult, resultCount, results } = details
  const subtitleRef = useRef<HTMLSpanElement>(null)
  const [queryTruncated, setQueryTruncated] = useState(false)
  const [showAll, setShowAll] = useState(false)

  useLayoutEffect(() => {
    const subtitle = subtitleRef.current
    if (!isExpanded || !subtitle) return
    const measure = (): void => setQueryTruncated(subtitle.scrollWidth > subtitle.clientWidth)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(subtitle)
    return () => observer.disconnect()
  }, [builtin, isExpanded, query])

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
      : undefined
  const duration = webResult ? `${Math.round(webResult.duration_ms)} ms` : undefined
  const visibleResults = showAll ? results : results.slice(0, 8)
  const searchService = webResult?.provider?.id === 'exa' ? 'Exa' : undefined

  return (
    <WorkspaceToolActivityRowButton
      activity={activity}
      phase={phase}
      label={t('Web Search')}
      subtitle={query || undefined}
      subtitleRef={builtin ? subtitleRef : undefined}
      metaLabel={
        builtin
          ? [status, duration].filter(Boolean).join(' · ')
          : phase === 'closed'
            ? t('request ended')
            : formatResultCountLabel(resultCount, t)
      }
      isExpanded={isExpanded}
      canExpand={Boolean(builtin || query || resultCount)}
      panelClassName={cn(
        'mx-1 mb-1.5 min-w-0 space-y-2 border border-border-200 bg-bg-000 text-[12.5px] leading-5 md:ml-[30px]',
        builtin ? 'rounded-lg px-2.5 py-2' : 'rounded-[10px] px-3.5 py-3 shadow-card'
      )}
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
          {queryTruncated && query ? (
            <p className="select-text whitespace-pre-wrap [overflow-wrap:anywhere]">{query}</p>
          ) : null}
          {!stopped && !failed && !pending ? (
            unavailable ? (
              <p className="text-text-100">{t('Result unavailable')}</p>
            ) : resultCount === 0 ? (
              <p>{t('No results found')}</p>
            ) : (
              <>
                <div className="divide-y divide-border-200">
                  {visibleResults.map((source) => {
                    const publishedDate = source.publishedAt
                      ? formatDateTime(source.publishedAt, locale, 'date')
                      : ''
                    return (
                      <article
                        key={source.url}
                        data-testid="web-search-source"
                        className="min-w-0 space-y-0.5 py-2 first:pt-0 last:pb-0"
                      >
                        <ExternalTextLink
                          href={source.url}
                          className="inline [overflow-wrap:anywhere] [&>svg]:ml-0.5 [&>svg]:inline-block [&>svg]:align-text-bottom"
                        >
                          {source.title}
                        </ExternalTextLink>
                        <p className="text-xs text-text-100 [overflow-wrap:anywhere]">
                          {new URL(source.url).hostname}
                          {publishedDate ? (
                            <>
                              {' · '}
                              <time dateTime={source.publishedAt} title={source.publishedAt}>
                                {publishedDate}
                              </time>
                            </>
                          ) : null}
                        </p>
                        {source.snippet ? <SearchExcerpt text={source.snippet} /> : null}
                      </article>
                    )
                  })}
                </div>
                {!showAll && results.length > visibleResults.length ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="link"
                    className="px-0"
                    onClick={() => setShowAll(true)}
                  >
                    {t('Show all results')}
                  </Button>
                ) : null}
                {webResult.results_truncated ? (
                  <p className="text-text-100">{t('The returned search results are truncated.')}</p>
                ) : null}
              </>
            )
          ) : null}
          {webResult && !unavailable && !stopped && !pending ? (
            <p className="text-xs text-text-100 [overflow-wrap:anywhere]">
              {searchService ? `${searchService} · ` : null}
              <time dateTime={webResult.retrieved_at} title={webResult.retrieved_at}>
                {formatDateTime(webResult.retrieved_at, locale, 'dateTime') ||
                  webResult.retrieved_at}
              </time>
            </p>
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
