/* Hallmark · component: source diff · genre: modern-minimal · theme: existing semantic tokens
 * Pre-emit critique: P5 H4 E4 S5 R5 V4.
 * Read-only content; native disclosure provides hover, focus and pressed interaction.
 */
import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { parsePatch, type StructuredPatch } from 'diff'
import type { HighlightResult } from '@streamdown/code'
import type { BundledLanguage } from 'shiki'
import { ChevronDown, FileCode2, Ellipsis } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useCodeHighlighter } from '@/components/streamdown/use-code-highlighter'

type DiffViewerProps = {
  name: string
  patch?: string
  language?: string
  unavailable?: React.ReactNode
  defaultOpen?: boolean
}

type Hunk = StructuredPatch['hunks'][number]

// Highlight each side independently: removed code must not change the new side's lexer state.
function useDiffTokens(source: string, language: string): HighlightResult['tokens'] | undefined {
  const plugin = useCodeHighlighter(source.length <= 128 * 1024)
  const [highlighted, setHighlighted] = useState<{ key: string; result: HighlightResult }>()
  const key = `${language}\0${source}`
  useEffect(() => {
    if (source.length > 128 * 1024 || !plugin?.supportsLanguage(language as BundledLanguage)) return
    let active = true
    const apply = (result: HighlightResult): void => {
      if (active) setHighlighted({ key, result })
    }
    try {
      const immediate = plugin.highlight(
        { code: source, language: language as BundledLanguage, themes: plugin.getThemes() },
        apply
      )
      if (immediate) queueMicrotask(() => apply(immediate))
    } catch {
      // Highlighting is optional; the original diff remains readable.
    }
    return () => {
      active = false
    }
  }, [key, language, plugin, source])
  const result = highlighted?.key === key ? highlighted.result.tokens : undefined
  return result?.map((line) => line.map((token) => token.content).join('')).join('\n') === source
    ? result
    : undefined
}

function DiffHunk({
  hunk,
  language,
  omitted,
  gutterWidth
}: {
  hunk: Hunk
  language: string
  omitted: number
  gutterWidth: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const oldTokens = useDiffTokens(
    hunk.lines
      .filter((line) => /^[ -]/.test(line))
      .map((line) => line.slice(1))
      .join('\n'),
    language
  )
  const newTokens = useDiffTokens(
    hunk.lines
      .filter((line) => /^[ +]/.test(line))
      .map((line) => line.slice(1))
      .join('\n'),
    language
  )
  let oldLine = hunk.oldStart
  let newLine = hunk.newStart
  let oldIndex = 0
  let newIndex = 0
  return (
    <>
      {omitted > 0 ? (
        <div
          data-diff-omitted=""
          className="my-1 flex items-center gap-3 rounded bg-muted/70 px-3 py-2 font-sans text-xs text-muted-foreground"
        >
          <Ellipsis aria-hidden="true" className="size-4 shrink-0" />
          {t('{{count}} unchanged lines omitted', {
            count: omitted,
            defaultValue_one: '{{count}} unchanged line omitted'
          })}
        </div>
      ) : null}
      {hunk.lines.map((line, index) => {
        const marker = line[0]
        if (marker === '\\')
          return (
            <div
              key={index}
              data-diff-newline-notice=""
              className="px-3 py-1 text-muted-foreground"
            >
              {t('No newline at end of file')}
            </div>
          )
        const removed = marker === '-'
        const added = marker === '+'
        const oldNumber = added ? undefined : oldLine++
        const newNumber = removed ? undefined : newLine++
        const tokens = removed ? oldTokens?.[oldIndex] : newTokens?.[newIndex]
        if (!added) oldIndex++
        if (!removed) newIndex++
        return (
          <div
            key={index}
            data-diff-kind={removed ? 'removed' : added ? 'added' : 'context'}
            style={{ gridTemplateColumns: `${gutterWidth} minmax(0, 1fr)` }}
            className={`relative grid min-w-max border-l-[3px] leading-6 ${removed ? 'border-transparent bg-diff-removed-surface' : added ? 'border-diff-added-foreground bg-diff-added-surface' : 'border-transparent'}`}
          >
            <span
              aria-hidden="true"
              className={`select-none border-r border-border/60 pr-3 text-right tabular-nums ${removed ? 'text-diff-removed-foreground' : added ? 'text-diff-added-foreground' : 'text-muted-foreground'}`}
            >
              {removed ? oldNumber : newNumber}
            </span>
            <code className="whitespace-pre pl-5 pr-4 text-foreground">
              {removed || added ? (
                <span className="sr-only select-none">{t(removed ? 'Removed:' : 'Added:')} </span>
              ) : null}
              {tokens
                ? tokens.map((token, tokenIndex) => (
                    <span
                      key={tokenIndex}
                      className="dark:[color:var(--shiki-dark)]!"
                      style={{
                        color: token.color,
                        ...(token.htmlStyle as CSSProperties),
                        fontStyle: (token.fontStyle ?? 0) & 1 ? 'italic' : undefined,
                        fontWeight: (token.fontStyle ?? 0) & 2 ? 600 : undefined
                      }}
                    >
                      {token.content}
                    </span>
                  ))
                : line.slice(1) || '\u00a0'}
            </code>
            {removed ? (
              <span
                aria-hidden="true"
                data-diff-deletion-rail=""
                className="pointer-events-none absolute inset-y-0 -left-[3px] w-[3px]"
                style={{
                  backgroundImage:
                    'repeating-linear-gradient(45deg, var(--diff-removed-foreground) 0, var(--diff-removed-foreground) 1.5px, transparent 1.5px, transparent 3px)'
                }}
              />
            ) : null}
          </div>
        )
      })}
    </>
  )
}

/** Shared unified-patch presentation. Callers retain loading, errors and mutation ownership. */
export function DiffViewer({
  name,
  patch,
  language,
  unavailable,
  defaultOpen = false
}: DiffViewerProps): React.JSX.Element {
  const { t } = useTranslation()
  const parsed = useMemo(() => {
    if (!patch || patch.length > 128 * 1024) return undefined
    try {
      // parsePatch normalizes zero-length ranges to the next line; do not offset them again.
      const files = parsePatch(patch)
      // A viewer represents exactly one file; never silently discard additional files or bad input.
      return files.length === 1 && files[0].hunks.length ? files[0] : undefined
    } catch {
      return undefined
    }
  }, [patch])
  const lines = parsed?.hunks.flatMap((hunk) => hunk.lines)
  const added = lines?.filter((line) => line.startsWith('+')).length ?? 0
  const removed = lines?.filter((line) => line.startsWith('-')).length ?? 0
  const gutterWidth = `${Math.max(1, ...(parsed?.hunks.flatMap((hunk) => [String(hunk.oldStart + hunk.oldLines).length, String(hunk.newStart + hunk.newLines).length]) ?? [])) + 2}ch`
  const resolvedLanguage = language ?? name.split('.').pop()?.toLowerCase() ?? 'text'
  return (
    <details open={defaultOpen} className="group/diff mt-3 min-w-0 overflow-hidden bg-background">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded px-2 py-2 hover:bg-muted active:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
        <ChevronDown
          aria-hidden="true"
          className="size-4 shrink-0 -rotate-90 group-open/diff:rotate-0"
        />
        <FileCode2 aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 break-all text-[13px] font-medium">{name}</span>
        {parsed ? (
          <span className="flex shrink-0 gap-2 font-mono text-[13px] tabular-nums">
            <span className="text-diff-added-foreground">
              <span className="sr-only">{t('Added:')} </span>+{added}
            </span>
            <span className="text-diff-removed-foreground">
              <span className="sr-only">{t('Removed:')} </span>−{removed}
            </span>
          </span>
        ) : null}
      </summary>
      <div
        className="overflow-x-auto pb-1 font-mono text-[13px]"
        tabIndex={0}
        role="region"
        aria-label={name}
      >
        {parsed ? (
          parsed.hunks.map((hunk, index) => (
            <DiffHunk
              key={`${patch}:${index}`}
              gutterWidth={gutterWidth}
              hunk={hunk}
              language={resolvedLanguage}
              omitted={Math.max(
                0,
                hunk.oldStart -
                  (index === 0
                    ? 1
                    : parsed.hunks[index - 1].oldStart + parsed.hunks[index - 1].oldLines)
              )}
            />
          ))
        ) : patch ? (
          <pre className="m-0 p-3 whitespace-pre">{patch}</pre>
        ) : (
          <div className="px-3 py-3 font-sans text-muted-foreground">{unavailable}</div>
        )}
      </div>
    </details>
  )
}
