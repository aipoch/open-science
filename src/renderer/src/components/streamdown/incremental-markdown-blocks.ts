import { parseMarkdownIntoBlocks } from 'streamdown'

// The Streamdown patch uses Marked block tokens only: segmentation never consumes inline
// tokens. Rendering still runs the complete GFM/CJK/math parser through its existing adapter.

// Streamdown usually retains source whitespace. Keep two unsettled blocks:
// a newly arriving list continuation or heading underline can still reinterpret the last one.
// The parser itself owns fences, HTML and math grouping; do not split on blank lines here.
export const createIncrementalMarkdownBlocks = (): ((markdown: string) => string[]) => {
  let prefix = ''
  let completed: string[] = []
  let previousInput: string | undefined
  let previousBlocks: string[] = []

  return (markdown) => {
    if (markdown === previousInput) return previousBlocks
    if (!markdown.startsWith(prefix)) {
      // Edits and repaired partial syntax can invalidate the cached prefix.
      prefix = ''
      completed = []
    }
    const tail = markdown.slice(prefix.length)
    if (tail.includes('[^') || tail.includes(']:')) {
      // Definitions share a document-level label table; a later duplicate can tokenize
      // differently even before its URL is complete. Keep full-parser semantics for these
      // documents (including multiline labels), conservatively including literal markers.
      prefix = ''
      completed = []
      previousInput = markdown
      previousBlocks = parseMarkdownIntoBlocks(markdown)
      return previousBlocks
    }
    const blocks = parseMarkdownIntoBlocks(tail)
    previousInput = markdown
    previousBlocks = [...completed, ...blocks]

    // Some inputs (e.g. CRLF) are normalized by the lexer. Only cache exact source boundaries.
    if (blocks.join('') !== tail) {
      prefix = ''
      completed = []
      return previousBlocks
    }
    let cut = blocks.length
    let unsettled = 0
    while (cut > 0 && unsettled < 2) {
      cut--
      if (blocks[cut]!.trim()) unsettled++
    }
    while (cut > 0 && !blocks[cut - 1]!.trim()) cut--
    if (cut > 0) {
      const settled = blocks.slice(0, cut)
      prefix += settled.join('')
      completed = [...completed, ...settled]
    }
    return previousBlocks
  }
}
