import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { searchContentRanges } from './search-content-ranges'

const HIGHLIGHT_NAME = 'global-search-content'

const scrollToRange = (range: Range): void => {
  let parent = range.startContainer.parentElement
  while (parent) {
    const style = getComputedStyle(parent)
    if (/(auto|scroll)/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight) {
      const rect = range.getBoundingClientRect()
      const viewport = parent.getBoundingClientRect()
      parent.scrollTop += rect.top - viewport.top - parent.clientHeight / 2 + rect.height / 2
    }
    if (/(auto|scroll)/.test(style.overflowX) && parent.scrollWidth > parent.clientWidth) {
      const rect = range.getBoundingClientRect()
      const viewport = parent.getBoundingClientRect()
      if (rect.left < viewport.left || rect.right > viewport.right)
        parent.scrollLeft += rect.left - viewport.left - parent.clientWidth / 2
    }
    if (parent.classList.contains('search-detail-content')) break
    parent = parent.parentElement
  }
}

export const SearchContentHighlight = ({
  query,
  children,
  className
}: {
  query: string
  children: ReactNode
  className?: string
}): React.JSX.Element => {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const root = ref.current
    if (!root) return
    let ranges: Range[] = []
    let positioned = false
    let canceled = false
    const highlight =
      typeof Highlight !== 'undefined' && globalThis.CSS?.highlights
        ? (CSS.highlights.get(HIGHLIGHT_NAME) ?? new Highlight())
        : undefined
    if (highlight) CSS.highlights.set(HIGHLIGHT_NAME, highlight)
    const viewport = root.closest<HTMLElement>('.search-detail-content')
    if (viewport) viewport.scrollTop = 0
    const position = (): void => {
      if (!canceled && !positioned && ranges[0]) {
        scrollToRange(ranges[0])
        positioned = true
      }
    }
    const update = (): void => {
      ranges.forEach((range) => highlight?.delete(range))
      ranges = searchContentRanges(root, query)
      ranges.forEach((range) => highlight?.add(range))
      root.dataset.searchMatchCount = String(ranges.length)
      if (!positioned && ranges[0]) {
        const animations = root.closest('.global-search-body')?.getAnimations?.() ?? []
        if (animations.length)
          void Promise.all(animations.map((animation) => animation.finished.catch(() => {}))).then(
            position
          )
        else position()
      }
    }
    update()
    // File reads and optional Markdown renderers finish after the initial mount.
    const observer = new MutationObserver(update)
    observer.observe(root, { subtree: true, childList: true, characterData: true })
    return () => {
      canceled = true
      observer.disconnect()
      ranges.forEach((range) => highlight?.delete(range))
      if (highlight?.size === 0) CSS.highlights.delete(HIGHLIGHT_NAME)
    }
  }, [query, children])
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  )
}
