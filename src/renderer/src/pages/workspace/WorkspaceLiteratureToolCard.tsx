/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 */
import { BookOpenText, Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { LiteratureToolSummary } from './literature-tool-presentation'
import { ExtensionPreservingFileName } from './ExtensionPreservingFileName'

const WorkspaceLiteratureToolCard = ({
  summary
}: {
  summary: LiteratureToolSummary
}): React.JSX.Element => {
  const { t } = useTranslation()
  const Icon = summary.action === 'search' ? Search : BookOpenText
  const title = summary.action === 'search' ? t('Search') : t('Read')
  const pageLabel =
    summary.pageStart && summary.pageEnd
      ? summary.pageStart === summary.pageEnd
        ? t('Page {{page}}', { page: summary.pageStart })
        : t('Pages {{start}}–{{end}}', { start: summary.pageStart, end: summary.pageEnd })
      : undefined

  return (
    <section
      data-testid="literature-tool-card"
      aria-label={t('Reading')}
      className="flex min-w-0 flex-col gap-2.5 rounded-lg border border-border-200 bg-bg-000 p-3"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Icon className="size-3.5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-text-000">{title}</div>
          <div className="truncate text-[11px] text-text-300">{t('Linked PDFs')}</div>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
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
          ) : pageLabel ? (
            <span className="rounded-md bg-bg-200 px-1.5 py-0.5 text-[10px] tabular-nums text-text-200">
              {pageLabel}
            </span>
          ) : null}
        </div>
      </div>

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
      ) : summary.documentCount > 0 ? (
        <div className="text-[11px] tabular-nums text-text-300">
          {t('{{count}} linked PDFs', {
            count: summary.documentCount,
            defaultValue_one: '{{count}} linked PDF'
          })}
        </div>
      ) : null}

      {summary.hasMore ? (
        <div className="text-[11px] text-text-300">{t('More pages are available')}</div>
      ) : null}
      {summary.error ? (
        <div className="rounded-md bg-destructive/10 px-2.5 py-2 text-[11px] text-destructive">
          {summary.error}
        </div>
      ) : null}
    </section>
  )
}

export { WorkspaceLiteratureToolCard }
