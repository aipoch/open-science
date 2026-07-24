import { code } from '@streamdown/code'
import type { HighlightResult } from '@streamdown/code'
import { cn } from '@/lib/utils'
import { Copy } from 'lucide-react'
import { Fragment, useCallback, useEffect, useState } from 'react'
import type { BundledLanguage } from 'shiki'

type WorkspaceToolCodeBlockProps = {
  code: string
  language?: string
  className?: string
  // When true, renders a copy button overlaying the top-right corner. Defaults false to avoid
  // changing the transcript's code-block appearance; the permission dialog opts in.
  copyable?: boolean
}

type HighlightState = {
  key: string
  result: HighlightResult
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

// Keys a highlight request to its exact input so stale tokens never paint newer code.
const createHighlightKey = (code: string, language: string | undefined): string =>
  language ? `${language}${code}` : ''

// Renders code with lazy Shiki highlighting, falling back to plain text before tokens resolve.
const WorkspaceToolCodeBlock = ({
  code: source,
  language,
  className,
  copyable = false
}: WorkspaceToolCodeBlockProps): React.JSX.Element => {
  const [highlighted, setHighlighted] = useState<HighlightState | null>(null)
  const [copied, setCopied] = useState(false)
  const highlightKey = createHighlightKey(source, language)

  const copyCode = useCallback(async () => {
    if (!navigator.clipboard) return

    try {
      await navigator.clipboard.writeText(source)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard access can be denied outside a trusted user gesture; leave the control usable.
    }
  }, [source])

  useEffect(() => {
    if (!language || !code.supportsLanguage(language as BundledLanguage)) return

    let active = true
    const apply = (result: HighlightResult): void => {
      if (active) setHighlighted({ key: highlightKey, result })
    }
    // The highlighter loads languages/themes asynchronously; cached hits return immediately instead.
    const immediate = code.highlight(
      { code: source, language: language as BundledLanguage, themes: code.getThemes() },
      apply
    )

    if (immediate) queueMicrotask(() => apply(immediate))

    return () => {
      active = false
    }
  }, [source, language, highlightKey])

  // Only paint tokens that were produced for the currently rendered code and language.
  const tokens = highlighted?.key === highlightKey ? highlighted.result.tokens : undefined

  return (
    <pre
      data-testid="tool-code-block"
      data-language={language}
      className={cn(
        'relative max-h-[320px] overflow-auto rounded-md border border-border-200 bg-bg-000 px-3 py-2.5',
        className
      )}
    >
      {copyable && (
        <button
          type="button"
          data-testid="code-copy-button"
          aria-label={copied ? 'Copied' : 'Copy code'}
          onClick={() => void copyCode()}
          className="absolute right-2 top-2 rounded bg-bg-100/80 p-1.5 text-text-200 hover:bg-bg-200 hover:text-text-100"
        >
          <Copy className="size-3.5" aria-hidden />
        </button>
      )}
      <code className="block whitespace-pre font-mono text-[12px] leading-relaxed text-text-000">
        {tokens
          ? tokens.map((line, lineIndex) => (
              <Fragment key={lineIndex}>
                {line.map((token, tokenIndex) => (
                  <span
                    key={tokenIndex}
                    // Dual-theme Shiki output puts the color (and a --shiki-dark var) in htmlStyle,
                    // not token.color, so apply htmlStyle and fall back to color for single themes.
                    style={{
                      color: token.color,
                      ...(token.htmlStyle as React.CSSProperties | undefined),
                      ...fontStyleToCss(token.fontStyle)
                    }}
                  >
                    {token.content}
                  </span>
                ))}
                {lineIndex < tokens.length - 1 ? '\n' : null}
              </Fragment>
            ))
          : source}
      </code>
    </pre>
  )
}

export { WorkspaceToolCodeBlock }
