// Shared markdown code-fence tracking used by the streaming renderers (normalization boundary
// and the deferred-highlight block) so fence open/close rules live in exactly one place.
const FENCE_LINE = /^[ \t]{0,3}(`{3,}|~{3,})/
const BLOCKQUOTE_PREFIX = /^\s{0,3}>\s?/u
const LIST_MARKER = /^\s{0,3}(?:[-+*]|\d+[.)])\s+/u
const LEADING_WHITESPACE = /^\s*/u

type MarkdownPluginNeeds = {
  code: boolean
  mermaid: boolean
}

// Tracks one fence's open/close state while lines stream through `feed`. A fence opens on the
// first marker line and closes on a marker with the same character at equal or greater length.
const createCodeFenceTracker = (): {
  feed: (line: string) => boolean
  isOpen: () => boolean
} => {
  let open = false
  let markerChar = ''
  let markerLength = 0

  return {
    // Returns whether a fence is open after this line.
    feed: (line: string): boolean => {
      const fence = FENCE_LINE.exec(line)
      if (fence) {
        if (!open) {
          open = true
          markerChar = fence[1][0]
          markerLength = fence[1].length
        } else if (fence[1][0] === markerChar && fence[1].length >= markerLength) {
          open = false
        }
      }
      return open
    },
    isOpen: () => open
  }
}

const getMarkdownPluginNeeds = (markdown: string): MarkdownPluginNeeds => {
  const tracker = createCodeFenceTracker()
  let code = false
  let fenceBlockquoteDepth = 0
  let fenceListIndent = 0
  let listBlockquoteDepth = 0
  const listContentIndents: number[] = []

  for (const rawLine of markdown.split('\n')) {
    const wasOpen = tracker.isOpen()
    let line = rawLine
    let blockquoteDepth = 0
    while (blockquoteDepth < (wasOpen ? fenceBlockquoteDepth : Number.POSITIVE_INFINITY)) {
      const prefix = line.match(BLOCKQUOTE_PREFIX)?.[0]
      if (!prefix) break
      line = line.slice(prefix.length)
      blockquoteDepth += 1
    }

    if (wasOpen && fenceListIndent > 0) {
      const indentation = line.match(LEADING_WHITESPACE)?.[0].length ?? 0
      if (indentation >= fenceListIndent) line = line.slice(fenceListIndent)
    } else if (!wasOpen && line.trim()) {
      if (blockquoteDepth !== listBlockquoteDepth) listContentIndents.length = 0

      if (listContentIndents.length > 0) {
        const indentation = line.match(LEADING_WHITESPACE)?.[0].length ?? 0
        while ((listContentIndents.at(-1) ?? 0) > indentation) listContentIndents.pop()
        line = line.slice(listContentIndents.at(-1) ?? 0)
      }

      let listIndent = listContentIndents.at(-1) ?? 0
      for (let listMarker = line.match(LIST_MARKER)?.[0]; listMarker;) {
        listIndent += listMarker.length
        listContentIndents.push(listIndent)
        listBlockquoteDepth = blockquoteDepth
        line = line.slice(listMarker.length)
        listMarker = line.match(LIST_MARKER)?.[0]
      }
    }

    const isOpen = tracker.feed(line)
    if (!wasOpen && isOpen) {
      fenceBlockquoteDepth = blockquoteDepth
      fenceListIndent = listContentIndents.at(-1) ?? 0
    } else if (wasOpen && !isOpen) {
      fenceListIndent = 0
    }
    if (wasOpen || !isOpen) continue

    code = true
    const language = line.replace(FENCE_LINE, '').trim().split(/\s+/, 1)[0]
    if (language === 'mermaid') return { code: true, mermaid: true }
  }

  return { code, mermaid: false }
}

export { FENCE_LINE, createCodeFenceTracker, getMarkdownPluginNeeds }
export type { MarkdownPluginNeeds }
