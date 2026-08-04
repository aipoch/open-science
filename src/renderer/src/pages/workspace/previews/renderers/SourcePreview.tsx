import type { ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

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

// Shared source renderer for text-like previews so line numbers stay aligned across formats.
export const SourcePreviewContent = ({
  content,
  pagination,
  topContent,
  lineClassName,
  language
}: SourcePreviewContentProps): React.JSX.Element => {
  const lineNumberWidth = `${Math.max(String(content.replace(/\0/g, '').split(/\r?\n/).length).length, 2) + 1}ch`

  return (
    <div className="flex size-full flex-col overflow-hidden bg-bg-10">
      {topContent}
      {pagination && (pagination.hasPrevious || pagination.hasNext) ? (
        <div className="flex shrink-0 items-center justify-between border-b border-border-300 bg-bg-000 px-3 py-1.5 text-[12px] text-text-300">
          <span>Page {pagination.pageNumber}</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="rounded p-1 hover:bg-bg-200 disabled:opacity-40"
              aria-label="Previous preview page"
              title="Previous page"
              disabled={!pagination.hasPrevious}
              onClick={pagination.previousPage}
            >
              <ChevronLeft className="size-3.5" aria-hidden />
            </button>
            <button
              type="button"
              className="rounded p-1 hover:bg-bg-200 disabled:opacity-40"
              aria-label="Next preview page"
              title="Next page"
              disabled={!pagination.hasNext}
              onClick={pagination.nextPage}
            >
              <ChevronRight className="size-3.5" aria-hidden />
            </button>
          </div>
        </div>
      ) : null}
      <pre className="m-0 min-h-0 flex-1 overflow-auto bg-bg-000 p-0 font-mono text-[12px] leading-5 text-text-000">
        <code className="block min-w-full py-3">
          <HighlightedCodeLines
            code={content}
            language={language}
            rowClassName="grid min-w-full gap-3 px-3 hover:bg-bg-200/70"
            rowStyle={{ gridTemplateColumns: `${lineNumberWidth} minmax(0, 1fr)` }}
            contentClassName={cn('text-[12px] leading-5', lineClassName)}
          />
        </code>
      </pre>
    </div>
  )
}
