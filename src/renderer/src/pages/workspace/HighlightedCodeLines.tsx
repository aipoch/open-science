import type { HighlightResult } from '@streamdown/code'
import type { BundledLanguage } from 'shiki'
import { useEffect, useState } from 'react'

import { cn } from '@/lib/utils'
import { useCodeHighlighter } from '@/components/streamdown/use-code-highlighter'

const MAX_HIGHLIGHT_BYTES = 256 * 1024

type HighlightedCodeLinesProps = {
  code: string
  language?: string
  highlightLine?: number
  rowClassName?: string
  rowStyle?: React.CSSProperties
  lineNumberClassName?: string
  contentClassName?: string
}

// Shiki font-style bitmask: Italic = 1, Bold = 2, Underline = 4.
const fontStyleToCss = (fontStyle: number | undefined): React.CSSProperties => {
  if (!fontStyle) return {}

  const style: React.CSSProperties = {}

  if (fontStyle & 1) style.fontStyle = 'italic'
  if (fontStyle & 2) style.fontWeight = 600
  if (fontStyle & 4) style.textDecoration = 'underline'

  return style
}

// Shared read-only line renderer for preview surfaces. It keeps highlighting optional so large,
// unknown, or unsupported languages fall back to selectable plain text without blocking preview.
const HighlightedCodeLines = ({
  code,
  language,
  highlightLine,
  rowClassName,
  rowStyle,
  lineNumberClassName,
  contentClassName
}: HighlightedCodeLinesProps): React.JSX.Element => {
  const [highlighted, setHighlighted] = useState<{ key: string; result: HighlightResult } | null>(
    null
  )
  const source = code.replace(/\0/g, '').replace(/\r\n/g, '\n')
  const highlightKey = language ? `${language}\0${source}` : ''
  const lines = source.length > 0 ? source.split(/\r?\n/) : ['']
  const isWithinHighlightLimit = language
    ? new TextEncoder().encode(source).byteLength <= MAX_HIGHLIGHT_BYTES
    : false
  const highlighter = useCodeHighlighter(Boolean(language) && isWithinHighlightLimit)
  const shouldHighlight = Boolean(
    isWithinHighlightLimit && language && highlighter?.supportsLanguage(language as BundledLanguage)
  )

  useEffect(() => {
    if (!shouldHighlight) return

    let active = true
    const apply = (result: HighlightResult): void => {
      if (active) setHighlighted({ key: highlightKey, result })
    }
    const immediate = highlighter?.highlight(
      {
        code: source,
        language: language as BundledLanguage,
        themes: highlighter.getThemes()
      },
      apply
    )

    if (immediate) queueMicrotask(() => apply(immediate))

    return () => {
      active = false
    }
  }, [highlightKey, language, shouldHighlight, source, highlighter])

  const tokens =
    highlighted?.key === highlightKey &&
    highlighted.result.tokens
      .map((line) => line.map((token) => token.content).join(''))
      .join('\n') === source
      ? highlighted.result.tokens
      : undefined
  const lineNumberStyle = rowStyle
    ? undefined
    : { minWidth: `${String(lines.length).length + 2}ch` }

  return (
    <>
      {lines.map((line, index) => {
        return (
          <div
            key={`${index}-${line}`}
            className={cn(rowClassName, highlightLine === index + 1 && 'bg-danger-900')}
            style={rowStyle}
          >
            <span
              data-testid="source-line-number"
              className={cn('select-none text-right text-text-300', lineNumberClassName)}
              style={lineNumberStyle}
              aria-hidden="true"
            >
              {index + 1}
            </span>
            <span className={cn('whitespace-pre-wrap break-words text-text-000', contentClassName)}>
              {tokens?.[index]?.map((token, tokenIndex) => (
                <span
                  key={tokenIndex}
                  data-testid="source-code-token"
                  className="dark:[color:var(--shiki-dark)]!"
                  // Dual-theme Shiki output stores theme colors in token.htmlStyle; keep the dark
                  // override class aligned with existing tool-call code blocks.
                  style={{
                    color: token.color,
                    ...(token.htmlStyle as React.CSSProperties | undefined),
                    ...fontStyleToCss(token.fontStyle)
                  }}
                >
                  {token.content}
                </span>
              )) ??
                (line || '\u00a0')}
            </span>
          </div>
        )
      })}
    </>
  )
}

export { HighlightedCodeLines }
