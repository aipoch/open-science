import { memo, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import type { HighlightResult } from '@streamdown/code'
import type { BundledLanguage } from 'shiki'
import { useCodeHighlighter } from '@/components/streamdown/use-code-highlighter'
import type { NotebookProcessObservation } from '../../../../shared/notebook-process-monitor'

// Mounted only for expanded kernels. Primitive props keep metric polls from re-highlighting code.
export const ComputeCellPreview = memo(function ComputeCellPreview({
  code,
  kind,
  truncated
}: {
  code: string
  kind: NotebookProcessObservation['kind']
  truncated: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const lines = useMemo(() => code.split('\n'), [code])
  const language = kind === 'repl' ? 'javascript' : kind === 'shell' ? 'shellscript' : kind
  const highlightEnabled = code.length <= 8000 && lines.length <= 200
  const plugin = useCodeHighlighter(highlightEnabled)
  const [highlight, setHighlight] = useState<{
    source: string
    language: string
    tokens: HighlightResult['tokens']
  }>()
  useEffect(() => {
    if (!highlightEnabled || !plugin?.supportsLanguage(language as BundledLanguage)) return
    let active = true
    const apply = (result: HighlightResult): void => {
      if (active) setHighlight({ source: code, language, tokens: result.tokens })
    }
    try {
      const result = plugin.highlight(
        { code, language: language as BundledLanguage, themes: plugin.getThemes() },
        apply
      )
      if (result) queueMicrotask(() => apply(result))
    } catch {
      // Plain source remains readable if a grammar or highlighting chunk is unavailable.
    }
    return () => {
      active = false
    }
  }, [code, language, highlightEnabled, plugin])
  const tokens =
    highlight?.source === code && highlight.language === language ? highlight.tokens : undefined
  return (
    <div className="mb-4 overflow-hidden rounded-lg border border-border bg-card">
      <header className="flex items-center justify-between border-b border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <h3 className="font-medium">{t('Last cell')}</h3>
        <span className="font-mono">
          {kind === 'repl' ? t('JavaScript REPL') : kind === 'shell' ? t('Shell') : kind}
        </span>
      </header>
      <div
        tabIndex={0}
        role="region"
        aria-label={t('Last cell')}
        className="max-h-64 overflow-auto overscroll-contain focus-visible:keyboard-focus"
      >
        <div className="flex min-w-full w-max py-3 font-mono text-xs leading-5">
          <pre
            aria-hidden="true"
            className="sticky left-0 shrink-0 select-none border-r border-border bg-card px-3 text-right text-muted-foreground"
          >
            {lines.map((_, index) => index + 1).join('\n')}
          </pre>
          <pre className="px-4">
            <code>
              {tokens
                ? tokens.map((line, index) => (
                    <span key={index} className="block min-h-5">
                      {line.map((token, tokenIndex) => (
                        <span
                          key={tokenIndex}
                          className="dark:[color:var(--shiki-dark)]!"
                          style={{ color: token.color, ...(token.htmlStyle as CSSProperties) }}
                        >
                          {token.content}
                        </span>
                      ))}
                    </span>
                  ))
                : code}
            </code>
          </pre>
        </div>
      </div>
      {truncated && (
        <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
          {t('Preview limited to the first 32,000 characters.')}
        </p>
      )}
    </div>
  )
})
