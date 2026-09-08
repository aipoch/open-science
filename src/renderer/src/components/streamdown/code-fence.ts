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
// first marker line and closes on a marker with the same character at equal or greater length,
// followed only by spaces or tabs (and an optional CR from CRLF input).
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
        } else if (
          fence[1][0] === markerChar &&
          fence[1].length >= markerLength &&
          /^[ \t]*\r?$/.test(line.slice(fence[0].length))
        ) {
          open = false
        }
      }
      return open
    },
    isOpen: () => open
  }
}

// Explicit scan state for `getMarkdownPluginNeeds`, mirroring `createCodeFenceTracker`'s fence
// rules plus the blockquote/list tracking the scan needs. Kept outside a closure so the
// incremental scanner can persist it across calls and score the trailing partial line against a
// throwaway copy.
type PluginNeedsScanState = {
  fenceOpen: boolean
  fenceMarkerChar: string
  fenceMarkerLength: number
  fenceBlockquoteDepth: number
  fenceListIndent: number
  listBlockquoteDepth: number
  listContentIndents: number[]
  code: boolean
  mermaid: boolean
}

const createPluginNeedsScanState = (): PluginNeedsScanState => ({
  fenceOpen: false,
  fenceMarkerChar: '',
  fenceMarkerLength: 0,
  fenceBlockquoteDepth: 0,
  fenceListIndent: 0,
  listBlockquoteDepth: 0,
  listContentIndents: [],
  code: false,
  mermaid: false
})

// Same open/close rule as `createCodeFenceTracker.feed`.
const feedScanFence = (state: PluginNeedsScanState, line: string): boolean => {
  const fence = FENCE_LINE.exec(line)
  if (fence) {
    if (!state.fenceOpen) {
      state.fenceOpen = true
      state.fenceMarkerChar = fence[1][0]
      state.fenceMarkerLength = fence[1].length
    } else if (
      fence[1][0] === state.fenceMarkerChar &&
      fence[1].length >= state.fenceMarkerLength &&
      /^[ \t]*\r?$/.test(line.slice(fence[0].length))
    ) {
      state.fenceOpen = false
    }
  }
  return state.fenceOpen
}

const scanPluginNeedsLine = (state: PluginNeedsScanState, rawLine: string): boolean => {
  const wasOpen = state.fenceOpen
  let line = rawLine
  let blockquoteDepth = 0
  while (blockquoteDepth < (wasOpen ? state.fenceBlockquoteDepth : Number.POSITIVE_INFINITY)) {
    const prefix = line.match(BLOCKQUOTE_PREFIX)?.[0]
    if (!prefix) break
    line = line.slice(prefix.length)
    blockquoteDepth += 1
  }

  // A fenced block cannot outlive its enclosing blockquote or list item. Reprocess the
  // first outside line as Markdown so a new fence or alert can start there immediately.
  if (
    wasOpen &&
    (blockquoteDepth < state.fenceBlockquoteDepth ||
      (state.fenceListIndent > 0 &&
        line.trim() &&
        (line.match(LEADING_WHITESPACE)?.[0].length ?? 0) < state.fenceListIndent))
  ) {
    state.fenceOpen = false
    state.fenceListIndent = 0
    return scanPluginNeedsLine(state, rawLine)
  }

  if (wasOpen && state.fenceListIndent > 0) {
    const indentation = line.match(LEADING_WHITESPACE)?.[0].length ?? 0
    if (indentation >= state.fenceListIndent) line = line.slice(state.fenceListIndent)
  } else if (!wasOpen && line.trim()) {
    if (blockquoteDepth !== state.listBlockquoteDepth) state.listContentIndents.length = 0

    if (state.listContentIndents.length > 0) {
      const indentation = line.match(LEADING_WHITESPACE)?.[0].length ?? 0
      while ((state.listContentIndents.at(-1) ?? 0) > indentation) state.listContentIndents.pop()
      line = line.slice(state.listContentIndents.at(-1) ?? 0)
    }

    let listIndent = state.listContentIndents.at(-1) ?? 0
    for (let listMarker = line.match(LIST_MARKER)?.[0]; listMarker;) {
      listIndent += listMarker.length
      state.listContentIndents.push(listIndent)
      state.listBlockquoteDepth = blockquoteDepth
      line = line.slice(listMarker.length)
      listMarker = line.match(LIST_MARKER)?.[0]
    }
  }

  const isOpen = feedScanFence(state, line)
  if (!wasOpen && isOpen) {
    state.fenceBlockquoteDepth = blockquoteDepth
    state.fenceListIndent = state.listContentIndents.at(-1) ?? 0
    state.code = true
    const language = line.replace(FENCE_LINE, '').trim().split(/\s+/, 1)[0]
    if (language === 'mermaid') state.mermaid = true
  } else if (wasOpen && !isOpen) {
    state.fenceListIndent = 0
  }
  return wasOpen || isOpen
}

// Normalization needs the same container context as plugin detection, while deferred code
// rendering can keep using the raw-line tracker above.
const createMarkdownFenceScanner = (): {
  // Returns whether this line belongs to a code fence, including opening and closing markers.
  feed: (line: string) => boolean
  isOpen: () => boolean
} => {
  const state = createPluginNeedsScanState()
  return {
    feed: (line: string): boolean => scanPluginNeedsLine(state, line),
    isOpen: () => state.fenceOpen
  }
}

const getMarkdownPluginNeeds = (markdown: string): MarkdownPluginNeeds => {
  const state = createPluginNeedsScanState()

  for (const rawLine of markdown.split('\n')) {
    scanPluginNeedsLine(state, rawLine)
    if (state.mermaid) return { code: true, mermaid: true }
  }

  return { code: state.code, mermaid: false }
}

// Incremental `getMarkdownPluginNeeds` for append-only streaming. Only newline-terminated lines
// are committed to the persisted state, so a later append can re-evaluate the trailing partial
// line (which may still complete into a fence marker); the partial line is scored per call
// against a throwaway copy of the state. Detected needs are monotonic under append, so once
// Mermaid is found no further scanning is needed. Non-append input resets the scan.
const createMarkdownPluginNeedsScanner = (): ((markdown: string) => MarkdownPluginNeeds) => {
  let cachedInput: string | null = null
  let cachedNeeds: MarkdownPluginNeeds = { code: false, mermaid: false }
  let state = createPluginNeedsScanState()
  let scanPosition = 0

  return (markdown: string): MarkdownPluginNeeds => {
    if (markdown === cachedInput) return cachedNeeds
    if (cachedInput === null || !markdown.startsWith(cachedInput)) {
      state = createPluginNeedsScanState()
      scanPosition = 0
    }

    if (!state.mermaid) {
      for (;;) {
        const newlineIndex = markdown.indexOf('\n', scanPosition)
        if (newlineIndex === -1) break
        scanPluginNeedsLine(state, markdown.slice(scanPosition, newlineIndex))
        scanPosition = newlineIndex + 1
        if (state.mermaid) break
      }
    }

    let needs: MarkdownPluginNeeds
    if (state.mermaid) {
      needs = { code: true, mermaid: true }
    } else if (scanPosition < markdown.length) {
      const partialState: PluginNeedsScanState = {
        ...state,
        listContentIndents: [...state.listContentIndents]
      }
      scanPluginNeedsLine(partialState, markdown.slice(scanPosition))
      needs = { code: partialState.code, mermaid: partialState.mermaid }
    } else {
      needs = { code: state.code, mermaid: false }
    }

    cachedInput = markdown
    cachedNeeds = needs
    return needs
  }
}

export {
  FENCE_LINE,
  createCodeFenceTracker,
  createMarkdownFenceScanner,
  createMarkdownPluginNeedsScanner,
  getMarkdownPluginNeeds
}
export type { MarkdownPluginNeeds }
