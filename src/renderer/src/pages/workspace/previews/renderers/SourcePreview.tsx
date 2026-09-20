import { useMemo, useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'
import type { PreviewPagination } from '../usePreviewFileContent'
import { HighlightedCodeLines } from '../../HighlightedCodeLines'

type SourcePreviewContentProps = {
  content: string
  pagination?: PreviewPagination
  topContent?: ReactNode
  lineClassName?: string
  language?: string
}

const PREVIEW_SOURCE_MAX_LINES = 2000

// Shared source renderer for text-like previews so line numbers stay aligned across formats.
export const SourcePreviewContent = ({
  content,
  pagination,
  topContent,
  lineClassName,
  language
}: SourcePreviewContentProps): React.JSX.Element => {
  const { t } = useTranslation()
  const lines = useMemo(() => content.replace(/\0/g, '').split(/\r?\n/), [content])
  const lastSlice = Math.floor((lines.length - 1) / PREVIEW_SOURCE_MAX_LINES)
  const pageKey = pagination?.pageKey ?? pagination?.pageNumber
  const initialSlice = pagination?.showLastLines ? lastSlice : 0
  const [position, setPosition] = useState({ content, pageKey, slice: initialSlice })
  const active =
    position.content === content && position.pageKey === pageKey
      ? position
      : { content, pageKey, slice: initialSlice }
  if (active !== position) setPosition(active)
  const slice = Math.min(active.slice, lastSlice)
  const firstIndex = slice * PREVIEW_SOURCE_MAX_LINES
  const visibleLines = lines.slice(firstIndex, firstIndex + PREVIEW_SOURCE_MAX_LINES)
  const startingLineNumber = (pagination?.startingLineNumber ?? 1) + firstIndex
  const endingLineNumber = startingLineNumber + visibleLines.length - 1
  const lineNumberWidth = `${Math.max(String(endingLineNumber).length, 2) + 1}ch`
  const hasPrevious = slice > 0 || Boolean(pagination?.hasPrevious)
  const hasNext = slice < lastSlice || Boolean(pagination?.hasNext)
  const partialContext = lastSlice > 0 || Boolean(pagination?.hasPrevious || pagination?.hasNext)
  const previous = (): void => {
    if (slice > 0) setPosition({ ...active, slice: slice - 1 })
    else pagination?.previousPage()
  }
  const next = (): void => {
    if (slice < lastSlice) setPosition({ ...active, slice: slice + 1 })
    else pagination?.nextPage()
  }

  return (
    <div className="flex size-full flex-col overflow-hidden bg-bg-10">
      {topContent}
      {hasPrevious || hasNext ? (
        <div className="flex shrink-0 items-center justify-between border-b border-border-300 bg-bg-000 px-3 py-1.5 text-[12px] text-text-300">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <span>
              {t('Lines {{start}}–{{end}}', { start: startingLineNumber, end: endingLineNumber })}
            </span>
            {pagination?.byteStart !== undefined && pagination.byteEnd !== undefined ? (
              <span>
                {t('Loaded bytes {{start}}–{{end}}', {
                  start: pagination.byteStart + 1,
                  end: pagination.byteEnd
                })}
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="rounded p-1 hover:bg-bg-200 disabled:opacity-40"
              aria-label={t('Previous preview page')}
              title={t('Previous page')}
              disabled={!hasPrevious}
              onClick={previous}
            >
              <ChevronLeft className="size-3.5" aria-hidden />
            </button>
            <button
              type="button"
              className="rounded p-1 hover:bg-bg-200 disabled:opacity-40"
              aria-label={t('Next preview page')}
              title={t('Next page')}
              disabled={!hasNext}
              onClick={next}
            >
              <ChevronRight className="size-3.5" aria-hidden />
            </button>
          </div>
        </div>
      ) : null}
      {slice === 0 && pagination?.startsMidLine ? (
        <div className="shrink-0 border-b border-border-300 px-3 py-1 text-[12px] text-text-300">
          {t('First line is continued from the previous page')}
        </div>
      ) : null}
      {partialContext && language ? (
        <div className="shrink-0 px-3 py-1 text-[12px] text-text-300">
          {t('Partial source context; syntax highlighting is unavailable')}
        </div>
      ) : null}
      <pre
        key={`${pageKey}-${slice}`}
        className="m-0 min-h-0 flex-1 overflow-auto bg-bg-000 p-0 font-mono text-[12px] leading-5 text-text-000"
      >
        <code className="block min-w-full py-3">
          <HighlightedCodeLines
            code={visibleLines.join('\n')}
            startingLineNumber={startingLineNumber}
            language={partialContext ? undefined : language}
            rowClassName="grid min-w-full gap-3 px-3 hover:bg-bg-200/70"
            rowStyle={{ gridTemplateColumns: `${lineNumberWidth} minmax(0, 1fr)` }}
            contentClassName={cn('text-[12px] leading-5', lineClassName)}
          />
        </code>
      </pre>
      {slice === lastSlice && pagination?.endsMidLine ? (
        <div className="shrink-0 border-t border-border-300 px-3 py-1 text-[12px] text-text-300">
          {t('Last line continues on the next page')}
        </div>
      ) : null}
    </div>
  )
}
