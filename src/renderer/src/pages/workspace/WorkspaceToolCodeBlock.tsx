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
  // Opt-in review annotations; transcript code keeps its existing presentation.
  showLineNumbers?: boolean
  highlightedLines?: readonly number[]
  revealLine?: { line: number }
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
  copyable = false,
  showLineNumbers = false,
  highlightedLines,
  revealLine
}: WorkspaceToolCodeBlockProps): React.JSX.Element => {
  const { t } = useTranslation()
  const numbered = showLineNumbers || highlightedLines !== undefined
  const sourceLines = useMemo(() => (numbered ? source.split('\n') : undefined), [source, numbered])
  const virtual = !!sourceLines && sourceLines.length > 300
  const [window, setWindow] = useState({ source, firstLine: 0 })
  const firstLine = window.source === source ? window.firstLine : 0
  const setFirstLine = useCallback(
    (firstLine: number): void => setWindow({ source, firstLine }),
    [source]
  )
  const pendingFocus = useRef<typeof revealLine>(undefined)
  const startLine = virtual ? Math.min(firstLine, Math.max(0, sourceLines.length - 60)) : 0
  const visibleLines = virtual ? sourceLines.slice(startLine, startLine + 60) : sourceLines
  const markedLines = useMemo(() => new Set(highlightedLines), [highlightedLines])
  const highlightEnabled = Boolean(language) && source.length <= 20_000 && !virtual
  const [highlighted, setHighlighted] = useState<HighlightState | null>(null)
  const copyIdentity = useMemo(() => ({ source }), [source])
  const [copyResult, setCopyResult] = useState<{
    identity: typeof copyIdentity
    success: boolean
  }>()
  const codeViewport = useRef<HTMLPreElement>(null)
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
  const highlighter = useCodeHighlighter(highlightEnabled)

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
    if (
      !highlightEnabled ||
      !language ||
      !highlighter?.supportsLanguage(language as BundledLanguage)
    )
      return

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
  }, [source, language, highlightKey, highlighter, highlightEnabled])

  // Only paint tokens that were produced for the currently rendered code and language.
  const tokens =
    highlightEnabled && highlighted?.key === highlightKey ? highlighted.result.tokens : undefined

  useEffect(() => {
    const viewport = codeViewport.current
    if (!viewport || !revealLine || !Number.isInteger(revealLine.line)) return
    if (virtual && sourceLines) {
      const line = Math.min(sourceLines.length, Math.max(1, revealLine.line))
      viewport.scrollTop = Math.max(0, (line - 1) * 19.5 - viewport.clientHeight / 2)
      viewport.scrollLeft = 0
      pendingFocus.current = revealLine
      setFirstLine(Math.max(0, Math.floor(viewport.scrollTop / 19.5) - 8))
      return
    }
    const target = viewport.querySelector<HTMLElement>(`[data-code-line="${revealLine.line}"]`)
    if (!target) return
    // Scroll only this code viewport, preserving the surrounding conversation position.
    viewport.scrollTop +=
      target.getBoundingClientRect().top -
      viewport.getBoundingClientRect().top -
      (viewport.clientHeight - target.clientHeight) / 2
    viewport.scrollLeft = 0
    target.focus({ preventScroll: true })
  }, [revealLine, source, virtual, sourceLines, setFirstLine])
  useEffect(() => {
    if (virtual && revealLine && pendingFocus.current === revealLine) {
      const target = codeViewport.current?.querySelector<HTMLElement>(
        `[data-code-line="${revealLine.line}"]`
      )
      if (target) {
        target.focus({ preventScroll: true })
        pendingFocus.current = undefined
      }
    }
  }, [virtual, firstLine, revealLine])

  const renderTokens = (line: HighlightResult['tokens'][number]): React.ReactNode =>
    line.map((token, tokenIndex) => (
      <span
        key={tokenIndex}
        className="dark:[color:var(--shiki-dark)]!"
        // Dual-theme Shiki colors use htmlStyle; the dark utility overrides inline light color.
        style={{
          color: token.color,
          ...(token.htmlStyle as React.CSSProperties | undefined),
          ...fontStyleToCss(token.fontStyle)
        }}
      >
        {token.content}
      </span>
    ))

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
        ref={codeViewport}
        onScroll={
          virtual
            ? (event) =>
                setFirstLine(Math.max(0, Math.floor(event.currentTarget.scrollTop / 19.5) - 8))
            : undefined
        }
        data-testid="tool-code-block"
        data-language={language}
        className={cn('m-0 max-h-[320px] overflow-auto py-2.5', numbered ? 'px-0' : 'px-3')}
      >
        <code
          className={cn(
            'block whitespace-pre font-mono text-[12px] leading-relaxed text-text-000',
            numbered && 'w-max min-w-full'
          )}
        >
          {virtual && (
            <span aria-hidden="true" className="block" style={{ height: startLine * 19.5 }} />
          )}
          {visibleLines
            ? visibleLines.map((line, offset) => {
                const index = startLine + offset
                const marked = markedLines.has(index + 1)
                const lineTokens = tokens?.[index]
                return (
                  <span
                    key={index}
                    style={virtual ? { height: 19.5, lineHeight: '19.5px' } : undefined}
                    data-code-line={index + 1}
                    data-highlighted={marked || undefined}
                    tabIndex={-1}
                    className={cn(
                      'flex min-h-[1.625em] border-l-2 border-transparent pr-10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
                      marked &&
                        'border-status-warning-foreground bg-status-warning-surface/60 dark:border-status-warning-dark-foreground dark:bg-status-warning-dark-surface/60'
                    )}
                  >
                    <span
                      aria-hidden="true"
                      data-line={index + 1}
                      className={cn(
                        'sticky left-0 mr-3 w-10 shrink-0 select-none bg-bg-000 pr-2 text-right text-muted-foreground before:content-[attr(data-line)]',
                        marked &&
                          'font-semibold text-status-warning-foreground dark:text-status-warning-dark-foreground'
                      )}
                    />
                    <span>
                      {lineTokens?.map((token) => token.content).join('') === line
                        ? renderTokens(lineTokens)
                        : line}
                      {index < (sourceLines?.length ?? 0) - 1 ? '\n' : null}
                    </span>
                  </span>
                )
              })
            : tokens
              ? tokens.map((line, index) => (
                  <Fragment key={index}>
                    {renderTokens(line)}
                    {index < tokens.length - 1 ? '\n' : null}
                  </Fragment>
                ))
              : source}
          {virtual && sourceLines && (
            <span
              aria-hidden="true"
              className="block"
              style={{ height: Math.max(0, sourceLines.length - startLine - 60) * 19.5 }}
            />
          )}
        </code>
      </pre>
    </div>
  )
}

export { WorkspaceToolCodeBlock }
