import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { findSearchMatches } from '../../../../shared/search-text'

export const SearchHighlight = ({
  text,
  query
}: {
  text: string
  query: string
}): React.JSX.Element => {
  const matches = useMemo(() => findSearchMatches(text, query), [text, query])
  return (
    <>
      {matches.map(({ start, end }, index) => {
        const before = text.slice(matches[index - 1]?.end ?? 0, start)
        return (
          <span key={start}>
            {before}
            <mark data-search-match={index} className="search-match">
              {text.slice(start, end)}
            </mark>
          </span>
        )
      })}
      {text.slice(matches.at(-1)?.end ?? 0)}
    </>
  )
}

// Measure the first rendered hit, not newline-delimited source text. Resizing preserves exactly
// three visual lines above/below it, including when a paragraph wraps or a message is very short.
export const MessageSearchExcerpt = ({
  text,
  query
}: {
  text: string
  query: string
}): React.JSX.Element => {
  const contentRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const [offset, setOffset] = useState(0)
  useLayoutEffect(() => {
    const content = contentRef.current
    const viewport = viewportRef.current
    if (!content || !viewport) return
    const measure = (): void => {
      const lineHeight = Number.parseFloat(getComputedStyle(content).lineHeight) || 24
      const marker = content.querySelector('[data-search-match="0"]')
      const top = marker
        ? (marker.getClientRects()[0]?.top ?? content.getBoundingClientRect().top) -
          content.getBoundingClientRect().top
        : 0
      const line = Math.max(0, Math.floor(top / lineHeight))
      setOffset(marker ? (3 - line) * lineHeight : 0)
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(viewport)
    return () => observer?.disconnect()
  }, [text, query])
  return (
    <div ref={viewportRef} className="search-message-excerpt" data-testid="search-message-excerpt">
      <div
        ref={contentRef}
        className="search-message-text whitespace-pre-wrap break-words"
        style={{ transform: `translateY(${offset}px)` }}
      >
        <SearchHighlight text={text} query={query} />
      </div>
    </div>
  )
}
