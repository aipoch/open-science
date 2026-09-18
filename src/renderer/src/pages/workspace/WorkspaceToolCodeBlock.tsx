import type { HighlightResult } from '@streamdown/code'
import { cn } from '@/lib/utils'
import { Check, CircleAlert, Copy } from 'lucide-react'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { BundledLanguage } from 'shiki'

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useCodeHighlighter } from '@/components/streamdown/use-code-highlighter'

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
  const { t } = useTranslation()
  const [highlighted, setHighlighted] = useState<HighlightState | null>(null)
  const copyIdentity = useMemo(() => ({ source }), [source])
  const [copyResult, setCopyResult] = useState<{
    identity: typeof copyIdentity
    success: boolean
  }>()
  const copyRequest = useRef(0)
  const copyTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const copied = copyResult?.identity === copyIdentity && copyResult.success
  const copyFailed = copyResult?.identity === copyIdentity && !copyResult.success
  const copyLabel = copied
    ? t('Copied')
    : copyFailed
      ? t('Could not copy code. Try again.')
      : t('Copy code')
  const highlightKey = createHighlightKey(source, language)
  const highlighter = useCodeHighlighter(Boolean(language))

  useEffect(() => {
    return () => {
      copyRequest.current += 1
      clearTimeout(copyTimer.current)
    }
  }, [copyIdentity])

  const copyCode = useCallback(async () => {
    const request = ++copyRequest.current
    clearTimeout(copyTimer.current)
    setCopyResult(undefined)
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(copyIdentity.source)
      if (request !== copyRequest.current) return
      setCopyResult({ identity: copyIdentity, success: true })
      copyTimer.current = setTimeout(() => setCopyResult(undefined), 2000)
    } catch {
      if (request === copyRequest.current) setCopyResult({ identity: copyIdentity, success: false })
    }
  }, [copyIdentity])

  useEffect(() => {
    if (!language || !highlighter?.supportsLanguage(language as BundledLanguage)) return

    let active = true
    const apply = (result: HighlightResult): void => {
      if (active) setHighlighted({ key: highlightKey, result })
    }
    // The highlighter loads languages/themes asynchronously; cached hits return immediately instead.
    const immediate = highlighter.highlight(
      { code: source, language: language as BundledLanguage, themes: highlighter.getThemes() },
      apply
    )

    if (immediate) queueMicrotask(() => apply(immediate))

    return () => {
      active = false
    }
  }, [source, language, highlightKey, highlighter])

  // Only paint tokens that were produced for the currently rendered code and language.
  const tokens = highlighted?.key === highlightKey ? highlighted.result.tokens : undefined

  return (
    <div
      className={cn(
        'group relative max-h-[320px] overflow-hidden rounded-md border border-border-200 bg-bg-000',
        className
      )}
    >
      {copyable && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                data-testid="code-copy-button"
                aria-label={copyLabel}
                onClick={() => void copyCode()}
                className="absolute right-2 top-2 z-10 inline-flex items-center justify-center rounded bg-bg-100/80 p-1.5 text-text-200 backdrop-blur-sm hover:bg-bg-200 hover:text-text-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <span key={copyLabel} className="button-feedback">
                  {copied ? (
                    <Check
                      className="size-3.5 text-status-success-foreground dark:text-status-success-dark-foreground"
                      aria-hidden
                    />
                  ) : copyFailed ? (
                    <CircleAlert className="size-3.5 text-destructive" aria-hidden />
                  ) : (
                    <Copy className="size-3.5" aria-hidden />
                  )}
                </span>
              </button>
            </TooltipTrigger>
            <TooltipContent>{copyLabel}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      {copyable && (
        <span className="sr-only" role="status">
          {copied || copyFailed ? copyLabel : ''}
        </span>
      )}
      <pre
        data-testid="tool-code-block"
        data-language={language}
        className="m-0 max-h-[320px] overflow-auto px-3 py-2.5"
      >
        <code className="block whitespace-pre font-mono text-[12px] leading-relaxed text-text-000">
          {tokens
            ? tokens.map((line, lineIndex) => (
                <Fragment key={lineIndex}>
                  {line.map((token, tokenIndex) => (
                    <span
                      key={tokenIndex}
                      className="dark:[color:var(--shiki-dark)]!"
                      // Dual-theme Shiki output puts the color (and a --shiki-dark var) in htmlStyle,
                      // not token.color. Apply htmlStyle, then let the app's dark class switch to the
                      // paired token color; !important is required to beat Shiki's inline light color.
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
    </div>
  )
}

export { WorkspaceToolCodeBlock }
