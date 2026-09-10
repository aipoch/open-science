import { findSearchMatches } from '../../../../shared/search-text'

// Highlight rendered text with Ranges so Markdown, code coloring and text selection keep their DOM.
export const searchContentRanges = (root: HTMLElement, query: string): Range[] => {
  const nodes: { node: Text; start: number; end: number }[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let text = ''
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest('button, script, style, [aria-hidden="true"]')) continue
    const value = node.textContent ?? ''
    nodes.push({ node: node as Text, start: text.length, end: text.length + value.length })
    text += value
  }
  let firstIndex = 0
  let lastIndex = 0
  return findSearchMatches(text, query).flatMap(({ start, end }) => {
    while (nodes[firstIndex] && nodes[firstIndex]!.end <= start) firstIndex++
    lastIndex = Math.max(firstIndex, lastIndex)
    while (nodes[lastIndex] && nodes[lastIndex]!.end < end) lastIndex++
    const first = nodes[firstIndex]
    const last = nodes[lastIndex]
    if (!first || !last) return []
    const range = document.createRange()
    range.setStart(first.node, start - first.start)
    range.setEnd(last.node, end - last.start)
    return [range]
  })
}
