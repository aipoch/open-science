import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

type SourcePreviewContentProps = {
  content: string
  truncated?: boolean
  topContent?: ReactNode
  lineClassName?: string
}

// Shared source renderer for text-like previews so line numbers stay aligned across formats.
export const SourcePreviewContent = ({
  content,
  truncated = false,
  topContent,
  lineClassName
}: SourcePreviewContentProps): React.JSX.Element => {
  const lines = content.replace(/\0/g, '').split(/\r?\n/)
  const lineNumberWidth = `${Math.max(String(lines.length).length, 2) + 1}ch`

  return (
    <div className="flex size-full flex-col overflow-hidden bg-bg-10">
      {topContent}
      {truncated ? (
        <div className="shrink-0 border-b border-border-300 bg-bg-000 px-3 py-2 text-[12px] text-text-300">
          Preview truncated because the file is large
        </div>
      ) : null}
      <pre className="m-0 min-h-0 flex-1 overflow-auto bg-bg-000 p-0 font-mono text-[12px] leading-5 text-text-000">
        <code className="block min-w-full py-3">
          {lines.map((line, index) => (
            <span
              key={index}
              className="grid min-w-full gap-3 px-3 hover:bg-bg-200/70"
              style={{ gridTemplateColumns: `${lineNumberWidth} minmax(0, 1fr)` }}
            >
              <span
                data-testid="source-line-number"
                className="select-none text-right text-text-300"
                aria-hidden="true"
              >
                {index + 1}
              </span>
              <span className={cn('whitespace-pre-wrap break-words text-text-000', lineClassName)}>
                {line || '\u00a0'}
              </span>
            </span>
          ))}
        </code>
      </pre>
    </div>
  )
}
