import { LocalOcrControl } from '@/components/local-ocr-control'
/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V5 */
import {
  BookOpenText,
  FileText,
  Highlighter,
  Inbox,
  Link2,
  Search,
  TriangleAlert
} from 'lucide-react'
import { LiteratureToolReferenceList } from './LiteratureToolReferenceList'
import { LiteratureCandidateStatus } from './LiteratureCandidateStatus'
import { useTranslation } from 'react-i18next'

import { ErrorNotice } from '@/components/error-notice'

import type { LiteratureToolSummary } from './literature-tool-presentation'
import { ExtensionPreservingFileName } from './ExtensionPreservingFileName'

const annotationKindLabel = (kind: string | undefined, t: (key: string) => string): string => {
  switch (kind) {
    case 'highlight':
      return t('Highlight')
    case 'underline':
      return t('Underline')
    case 'squiggly':
      return t('Wavy underline')
    case 'strikethrough':
      return t('Strikethrough')
    case 'area':
      return t('Area')
    case 'page-note':
      return t('Page note')
    case 'document-note':
      return t('Document note')
    case 'text':
      return t('Text')
    case 'region':
      return t('Area')
    default:
      return t('Annotations')
  }
}

const WorkspaceLiteratureToolCard = ({
  summary,
  activityId,
  isApproval = false
}: {
  summary: LiteratureToolSummary
  activityId?: string
  isApproval?: boolean
}): React.JSX.Element => {
  const { t } = useTranslation()
  const annotation = summary.annotation
  const isLibrary = summary.libraryScope !== undefined
  const canOpenInbox = summary.action === 'save' && (summary.savedCount ?? 0) > 0
  const Icon = annotation
    ? Highlighter
    : summary.action === 'save'
      ? Inbox
      : summary.action === 'search'
        ? Search
        : summary.action === 'format'
          ? FileText
          : BookOpenText
  const title =
    annotation?.operation === 'list'
      ? t('Notes & Annotations')
      : annotation?.operation === 'locate'
        ? t('Target')
        : annotation?.operation === 'create'
          ? t('Created')
          : summary.action === 'save' && !canOpenInbox && summary.existingItemIds?.length
            ? t('Already in library')
            : summary.pdfElements
              ? t('PDF figures and tables')
              : summary.action === 'save'
                ? canOpenInbox
                  ? summary.pdfDownloaded
                    ? t('PDF downloaded to Inbox')
                    : t('Saved to Inbox')
                  : t('Save')
                : summary.action === 'search'
                  ? t('Search')
                  : summary.action === 'format'
                    ? t('Format')
                    : t('Read')
  const subtitle = canOpenInbox
    ? summary.pdfDownloaded
      ? t('PDF downloaded to Inbox')
      : t('Saved to Inbox')
    : annotation
      ? (annotation.documentId ?? t('Notes & Annotations'))
      : isLibrary
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
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-2">
        <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Icon className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1 basis-28">
          <div className="text-[13px] font-medium text-text-000">{title}</div>
          {summary.action !== 'save' || isApproval ? (
            <div className="text-xs text-text-200">{subtitle}</div>
          ) : null}
        </div>
        <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">
          {!summary.documentNames.length &&
          !summary.itemTitles?.length &&
          summary.documentCount > 0 ? (
            <span className="text-[11px] tabular-nums text-text-300">
              {t('{{count}} linked PDFs', {
                count: summary.documentCount,
                defaultValue_one: '{{count}} linked PDF'
              })}
            </span>
          ) : null}
          {isLibrary && summary.action === 'search' && searchRangeLabel ? (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium tabular-nums text-primary">
              {searchRangeLabel}
            </span>
          ) : null}
          {summary.existingItemIds && summary.existingItemIds.length > 0 ? (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium tabular-nums text-primary">
              {t('Already in library: {{total}}', { total: summary.existingItemIds.length })}
            </span>
          ) : null}
          {isLibrary &&
          (summary.action === 'format' ||
            summary.action === 'read' ||
            (isApproval && summary.action === 'save')) &&
          summary.itemCount !== undefined ? (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium tabular-nums text-primary">
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

      {annotation ? (
        <div className="space-y-2 text-[12px] leading-5 text-text-200">
          {annotation.operation === 'list' ? (
            <>
              <div className="flex items-center justify-between text-[11px] text-text-300">
                <span>{t('Annotations')}</span>
                <span className="tabular-nums">
                  {annotation.total ?? annotation.annotations?.length ?? 0}
                </span>
              </div>
              {annotation.readOnly ? (
                <div className="text-[11px] text-text-300">{t('Read-only')}</div>
              ) : null}
              {annotation.annotations?.length ? (
                <div className="space-y-1.5">
                  {annotation.annotations.map((item, index) => (
                    <div key={item.id ?? index} className="rounded-md bg-bg-200 px-2.5 py-2">
                      <div className="flex items-center gap-2 text-[11px] text-text-300">
                        <span>{annotationKindLabel(item.kind, t)}</span>
                        {item.pageNumber ? (
                          <span>{t('Page {{page}}', { page: item.pageNumber })}</span>
                        ) : null}
                      </div>
                      {item.quote ? (
                        <p className="mt-1 break-words text-text-100">{item.quote}</p>
                      ) : null}
                      {item.note ? <p className="mt-1 break-words">{item.note}</p> : null}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-[11px] text-text-300">{t('No annotations yet.')}</div>
              )}
            </>
          ) : annotation.operation === 'locate' ? (
            <>
              <div className="text-[11px] font-medium uppercase tracking-wide text-text-300">
                {t('Target')}
              </div>
              <div className="space-y-1.5">
                {annotation.targets?.map((target, index) => (
                  <div key={target.targetRef ?? index} className="rounded-md bg-bg-200 px-2.5 py-2">
                    <div className="flex items-center gap-2 text-[11px] text-text-300">
                      <span>{annotationKindLabel(target.kind, t)}</span>
                      {target.pageNumber ? (
                        <span>{t('Page {{page}}', { page: target.pageNumber })}</span>
                      ) : null}
                    </div>
                    {target.quote ? (
                      <p className="mt-1 break-words text-text-100">{target.quote}</p>
                    ) : null}
                  </div>
                ))}
              </div>
            </>
          ) : annotation.created ? (
            <div className="rounded-md bg-bg-200 px-2.5 py-2">
              <div className="flex items-center gap-2 text-[11px] text-text-300">
                <span>{annotationKindLabel(annotation.created.kind, t)}</span>
                {annotation.created.pageNumber ? (
                  <span>{t('Page {{page}}', { page: annotation.created.pageNumber })}</span>
                ) : null}
              </div>
              {annotation.created.note ? (
                <p className="mt-1 break-words text-text-100">{annotation.created.note}</p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {!annotation &&
      !isApproval &&
      summary.action === 'save' &&
      (summary.candidateIds?.length || (summary.savedCount ?? 0) > 0) ? (
        <LiteratureCandidateStatus candidateIds={summary.candidateIds} activityId={activityId} />
      ) : null}

      {!annotation && summary.pdfElements ? (
        <div className="space-y-2 text-[12px] leading-5 text-text-200">
          {summary.pdfElements.elementCount !== undefined ? (
            <p>{t('Elements: {{total}}', { total: summary.pdfElements.elementCount })}</p>
          ) : null}
          {summary.pdfElements.checkedPages !== undefined ? (
            <p>
              {t('Parsed pages: {{parsed}} / {{checked}}', {
                parsed: summary.pdfElements.parsedPages ?? 0,
                checked: summary.pdfElements.checkedPages
              })}
            </p>
          ) : null}
          {summary.pdfElements.caption ? (
            <p className="line-clamp-4 break-words text-text-100">{summary.pdfElements.caption}</p>
          ) : null}
          {summary.pdfElements.imageIncluded ? <p>{t('Image delivered')}</p> : null}
          {summary.pdfElements.incomplete ? (
            <ErrorNotice
              inline
              icon={TriangleAlert}
              tone="amber"
              description={t(
                'Some PDF content could not be extracted or delivered. Check the original PDF.'
              )}
            />
          ) : null}
          {summary.pdfElements.limitations?.length ? (
            <details className="text-[11px] text-text-300">
              <summary className="w-fit cursor-pointer rounded-sm hover:text-text-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                {t('Extraction notes')}
              </summary>
              <div className="mt-1.5 space-y-2">
                {summary.pdfElements.limitations.map((limitation, index) => (
                  <div key={index} className="space-y-1">
                    {summary.action === 'search' && (limitation.caption || limitation.pageStart) ? (
                      <p className="break-words text-text-200">
                        {limitation.pageStart
                          ? limitation.pageEnd && limitation.pageEnd !== limitation.pageStart
                            ? t('Pages {{start}}–{{end}}', {
                                start: limitation.pageStart,
                                end: limitation.pageEnd
                              })
                            : t('Page {{page}}', { page: limitation.pageStart })
                          : null}
                        {limitation.pageStart && limitation.caption ? ' · ' : null}
                        {limitation.caption}
                      </p>
                    ) : null}
                    {limitation.tableStructureConflict ? (
                      <p>
                        {t(
                          'Extracted merged cells conflict with source rows or columns. Check the image or original PDF.'
                        )}
                      </p>
                    ) : null}
                    {limitation.otherLimitations ? (
                      <p>{t('Some evidence is unavailable or incomplete.')}</p>
                    ) : null}
                  </div>
                ))}
              </div>
            </details>
          ) : null}
        </div>
      ) : null}

      {summary.textCoverage?.some((coverage) => coverage.missing.length > 0) ? (
        <LocalOcrControl compact />
      ) : null}
      {summary.textCoverage?.map((coverage, index) => (
        <div key={index} className="space-y-1 text-[11px] text-muted-foreground">
          {coverage.name ? <p className="break-words">{coverage.name}</p> : null}
          <p>
            {t('Pages with text: {{parsed}} / {{total}}', {
              parsed: coverage.parsed,
              total: coverage.total
            })}
          </p>
          {coverage.ocr > 0 ? (
            <p>{t('OCR was used. Verify recognized text against the PDF.')}</p>
          ) : null}
          {coverage.unverified?.length ? (
            <ErrorNotice
              inline
              icon={TriangleAlert}
              tone="amber"
              description={t(
                'Image content needs source verification. Pages with text do not establish complete evidence.'
              )}
            />
          ) : null}
          {coverage.missing.length > 0 ? (
            <ErrorNotice
              inline
              icon={TriangleAlert}
              tone="amber"
              description={t(
                'Text is incomplete. Unread pages: {{pages}}. Check the source PDF or retry reading.',
                {
                  pages:
                    coverage.missing.slice(0, 20).join(', ') +
                    (coverage.missing.length > 20 ? '…' : '')
                }
              )}
            />
          ) : null}
        </div>
      ))}

      {!annotation && summary.action === 'save' ? (
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
              inline
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
          {!isApproval && summary.existingItemIds?.length ? (
            <LiteratureToolReferenceList
              itemIds={summary.existingItemIds}
              activityId={activityId}
            />
          ) : null}
        </>
      ) : null}

      {!annotation && summary.query ? (
        <div className="min-w-0 rounded-md bg-bg-200 px-2.5 py-2">
          <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-text-300">
            {t('Query')}
          </div>
          <p className="line-clamp-3 break-words text-[12px] leading-5 text-text-100">
            {summary.query}
          </p>
        </div>
      ) : null}

      {!annotation && isLibrary && summary.action === 'search' && summary.hasMore ? (
        <div className="text-[11px] text-text-300">{t('More results are available')}</div>
      ) : null}

      {!annotation && (summary.documentNames.length > 0 || summary.itemTitles?.length) ? (
        <div className="flex min-w-0 items-center gap-2 border-t border-border-200 pt-2 text-xs text-text-300">
          <Link2 className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="shrink-0">{t('Sources')}</span>
          <span aria-hidden="true">·</span>
          <span className="min-w-0 truncate text-text-100">
            {summary.documentNames.length > 0
              ? summary.documentNames.map((name, index) => (
                  <span key={name}>
                    {index > 0 ? ' · ' : null}
                    <ExtensionPreservingFileName name={name} />
                  </span>
                ))
              : summary.itemTitles?.join(' · ')}
          </span>
        </div>
      ) : null}

      {!annotation && summary.hasMore && !(isLibrary && summary.action === 'search') ? (
        <div className="text-[11px] text-text-300">
          {isLibrary || summary.pdfElements
            ? t('More results are available')
            : t('More pages are available')}
        </div>
      ) : null}
      {!annotation && summary.error ? (
        <div className="rounded-md bg-destructive/10 px-2.5 py-2 text-[11px] text-destructive">
          {summary.error}
        </div>
      ) : null}
    </>
  )

  const className =
    'flex min-w-0 flex-col gap-2 rounded-lg border border-border-200 bg-bg-000 p-2.5 text-left'

  return (
    <section
      data-testid="literature-tool-card"
      aria-label={
        annotation ? t('Notes & Annotations') : isLibrary ? t('Literature library') : t('Reading')
      }
      className={className}
    >
      {content}
    </section>
  )
}

export { WorkspaceLiteratureToolCard }
