/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V5 */
import { BookOpenText, FileText, Inbox, Search, TriangleAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import { useNavigationStore } from '@/stores/navigation-store'

import type { LiteratureToolSummary } from './literature-tool-presentation'
import { ExtensionPreservingFileName } from './ExtensionPreservingFileName'

const WorkspaceLiteratureToolCard = ({
  summary
}: {
  summary: LiteratureToolSummary
}): React.JSX.Element => {
  const { t } = useTranslation()
  const isLibrary = summary.libraryScope !== undefined
  const canOpenInbox = summary.action === 'save' && (summary.savedCount ?? 0) > 0
  const Icon =
    summary.action === 'save'
      ? Inbox
      : summary.action === 'search'
        ? Search
        : summary.action === 'format'
          ? FileText
          : BookOpenText
  const title =
    summary.action === 'save'
      ? t('Save')
      : summary.action === 'search'
        ? t('Search')
        : summary.action === 'format'
          ? t('Format')
          : t('Read')
  const subtitle = isLibrary
    ? summary.action === 'format'
      ? [summary.styleId?.toUpperCase(), summary.locale].filter(Boolean).join(' · ') ||
        t('Citation')
      : summary.action === 'save'
        ? t('Literature library')
        : summary.libraryScope === 'project'
          ? t('This project')
          : summary.libraryScope === 'collection'
            ? t('Collections')
            : summary.libraryScope === 'items'
              ? t('Selected references')
              : t('All references')
    : t('Linked PDFs')
  const pageLabel =
    summary.pageStart && summary.pageEnd
      ? summary.pageStart === summary.pageEnd
        ? t('Page {{page}}', { page: summary.pageStart })
        : t('Pages {{start}}–{{end}}', { start: summary.pageStart, end: summary.pageEnd })
      : undefined
  const searchRangeLabel =
    summary.resultStart !== undefined && summary.resultEnd !== undefined
      ? summary.totalCount !== undefined
        ? t('Results {{start}}–{{end}} of {{total}}', {
            start: summary.resultStart,
            end: summary.resultEnd,
            total: summary.totalCount
          })
        : t('Results {{start}}–{{end}}', { start: summary.resultStart, end: summary.resultEnd })
      : summary.resultCount === 0 || summary.totalCount !== undefined
        ? t('{{count}} results', {
            count: summary.resultCount === 0 ? 0 : summary.totalCount,
            defaultValue_one: '{{count}} result'
          })
        : summary.requestedStart !== undefined
          ? summary.requestedEnd !== undefined
            ? t('Requested results {{start}}–{{end}}', {
                start: summary.requestedStart,
                end: summary.requestedEnd
              })
            : t('Starting at result {{start}}', { start: summary.requestedStart })
          : undefined

  const content = (
    <>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Icon className="size-3.5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1 basis-28">
          <div className="text-[13px] font-medium text-text-000">{title}</div>
          <div className="truncate text-[11px] text-text-300">{subtitle}</div>
        </div>
        <div className="flex max-w-full shrink-0 flex-wrap justify-end gap-1">
          {isLibrary && summary.action === 'search' && searchRangeLabel ? (
            <span className="rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-primary">
              {searchRangeLabel}
            </span>
          ) : null}
          {isLibrary && summary.action === 'save' && summary.savedCount !== undefined ? (
            <span className="text-[11px] tabular-nums text-text-200">
              {t('Pending review: {{total}}', { total: summary.savedCount })}
            </span>
          ) : null}
          {summary.existingItemIds && summary.existingItemIds.length > 0 ? (
            <span className="text-[11px] tabular-nums text-text-200">
              {t('Already in library: {{total}}', { total: summary.existingItemIds.length })}
            </span>
          ) : null}
          {isLibrary &&
          (summary.action === 'format' || summary.action === 'read') &&
          summary.itemCount !== undefined ? (
            <span className="rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-primary">
              {t('{{count}} references', {
                count: summary.itemCount,
                defaultValue_one: '{{count}} reference'
              })}
            </span>
          ) : null}
          {summary.retrievalMode === 'bm25' ? (
            <span className="rounded-md bg-bg-200 px-1.5 py-0.5 text-[10px] font-medium text-text-200">
              {t('BM25')}
            </span>
          ) : summary.retrievalMode === 'fallback' ? (
            <span className="rounded-md bg-bg-200 px-1.5 py-0.5 text-[10px] font-medium text-text-200">
              {t('Fallback')}
            </span>
          ) : null}
          {summary.passageCount !== undefined ? (
            <span className="rounded-md bg-bg-200 px-1.5 py-0.5 text-[10px] tabular-nums text-text-200">
              {t('{{count}} passages', {
                count: summary.passageCount,
                defaultValue_one: '{{count}} passage'
              })}
            </span>
          ) : null}
          {pageLabel ? (
            <span className="rounded-md bg-bg-200 px-1.5 py-0.5 text-[10px] tabular-nums text-text-200">
              {pageLabel}
            </span>
          ) : null}
        </div>
      </div>

      {summary.action === 'save' ? (
        <>
          {summary.duplicateCount ? (
            <p className="text-[11px] text-text-300">
              {t('Repeated inputs: {{total}}', { total: summary.duplicateCount })}
            </p>
          ) : null}
          {summary.otherCount ? (
            <p className="text-[11px] text-text-300">
              {t('Other results: {{total}}', { total: summary.otherCount })}
            </p>
          ) : null}
          {summary.notAttemptedCount ? (
            <p className="text-[11px] text-text-300">
              {t('Not attempted: {{total}}', { total: summary.notAttemptedCount })}
            </p>
          ) : null}
          {summary.failedInputIndex !== undefined || summary.cancelled ? (
            <ErrorNotice
              icon={TriangleAlert}
              tone="amber"
              description={
                summary.cancelled
                  ? t('Saving stopped. Completed results are kept.')
                  : t('Could not save reference {{number}}. Earlier results are kept.', {
                      number: summary.failedInputIndex! + 1
                    })
              }
            />
          ) : null}
          {canOpenInbox || summary.existingItemIds?.length ? (
            <div className="flex flex-wrap gap-2">
              {canOpenInbox ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => useNavigationStore.getState().openLibrary('user')}
                >
                  {t('Open Inbox')}
                </Button>
              ) : null}
              {summary.existingItemIds?.map((id, index) => (
                <Button
                  key={id}
                  variant="outline"
                  size="sm"
                  onClick={() => useNavigationStore.getState().openLiteratureItem(id, 'user')}
                >
                  {t('Open existing reference {{number}}', { number: index + 1 })}
                </Button>
              ))}
            </div>
          ) : null}
        </>
      ) : null}

      {summary.query ? (
        <div className="min-w-0 rounded-md bg-bg-200 px-2.5 py-2">
          <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-text-300">
            {t('Query')}
          </div>
          <p className="line-clamp-3 break-words text-[12px] leading-5 text-text-100">
            {summary.query}
          </p>
        </div>
      ) : null}

      {isLibrary && summary.action === 'search' && summary.hasMore ? (
        <div className="text-[11px] text-text-300">{t('More results are available')}</div>
      ) : null}

      {summary.documentNames.length > 0 ? (
        <div className="flex min-w-0 items-center gap-2 text-[11px] text-text-300">
          <span className="shrink-0">{t('Sources')}</span>
          <span aria-hidden="true">·</span>
          <span className="min-w-0 truncate text-text-100">
            {summary.documentNames.map((name, index) => (
              <span key={name}>
                {index > 0 ? ' · ' : null}
                <ExtensionPreservingFileName name={name} />
              </span>
            ))}
          </span>
        </div>
      ) : summary.itemTitles && summary.itemTitles.length > 0 ? (
        <div className="flex min-w-0 items-center gap-2 text-[11px] text-text-300">
          <span className="shrink-0">{t('Sources')}</span>
          <span aria-hidden="true">·</span>
          <span className="min-w-0 truncate text-text-100">{summary.itemTitles.join(' · ')}</span>
        </div>
      ) : summary.documentCount > 0 ? (
        <div className="text-[11px] tabular-nums text-text-300">
          {t('{{count}} linked PDFs', {
            count: summary.documentCount,
            defaultValue_one: '{{count}} linked PDF'
          })}
        </div>
      ) : null}

      {summary.hasMore && !(isLibrary && summary.action === 'search') ? (
        <div className="text-[11px] text-text-300">
          {isLibrary ? t('More results are available') : t('More pages are available')}
        </div>
      ) : null}
      {summary.error ? (
        <div className="rounded-md bg-destructive/10 px-2.5 py-2 text-[11px] text-destructive">
          {summary.error}
        </div>
      ) : null}
    </>
  )

  const className =
    'flex min-w-0 flex-col gap-2.5 rounded-lg border border-border-200 bg-bg-000 p-3 text-left'

  return (
    <section
      data-testid="literature-tool-card"
      aria-label={isLibrary ? t('Literature library') : t('Reading')}
      className={className}
    >
      {content}
    </section>
  )
}

export { WorkspaceLiteratureToolCard }
