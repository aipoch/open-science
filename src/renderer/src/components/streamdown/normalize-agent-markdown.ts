import { createCodeFenceTracker } from './code-fence'

const quoteAxisListItems = (raw: string): string =>
  raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      if (item.startsWith('"') || item.startsWith("'")) return item
      if (/^-?\d+(\.\d+)?$/.test(item)) return item
      return `"${item.replace(/^["']|["']$/g, '')}"`
    })
    .join(', ')

const normalizeXychartLine = (line: string): string[] => {
  const titleAndXAxis = line.match(/^\s*"([^"]+)"\s+x-axis\s+\[(.+)\]\s*$/i)
  if (titleAndXAxis) {
    return [
      `    title "${titleAndXAxis[1]}"`,
      `    x-axis [${quoteAxisListItems(titleAndXAxis[2])}]`
    ]
  }

  const bareTitle = line.match(/^\s*"([^"]+)"\s*$/)
  if (bareTitle && !/^\s*title\b/i.test(line)) {
    return [`    title "${bareTitle[1]}"`]
  }

  const xAxis = line.match(/^(\s*x-axis\s+)\[(.+)\]\s*$/i)
  if (xAxis) {
    return [`${xAxis[1]}[${quoteAxisListItems(xAxis[2])}]`]
  }

  return [line]
}

/** Fix common AI mistakes in xychart-beta blocks before Mermaid parses them. */
const normalizeMermaidChart = (source: string): string => {
  if (!/^\s*xychart-beta\b/im.test(source)) return source

  const lines = source.split('\n').flatMap((line) => normalizeXychartLine(line))
  return lines.join('\n')
}

const normalizeMermaidBlocks = (markdown: string): string =>
  markdown.replace(/```mermaid[^\n]*\n([\s\S]*?)```/g, (block, chart: string) =>
    block.replace(chart, normalizeMermaidChart(chart))
  )

/** GitHub-style alerts: > [!NOTE] → styled aside (ChatGPT/Cursor/Claude docs style). */
const normalizeGfmAlerts = (markdown: string): string =>
  markdown.replace(
    /^>\s*\[!([A-Z]+)\]\s*\r?\n((?:>\s?.+\r?\n?)+)/gim,
    (_match, type: string, body: string) => {
      const content = body
        .split(/\r?\n/)
        .map((line) => line.replace(/^>\s?/, ''))
        .join('\n')
        .trim()

      return `<aside data-agent-alert="${type.toLowerCase()}">\n\n${content}\n\n</aside>\n\n`
    }
  )

/** Normalize agent markdown before Streamdown parses it. */
const normalizeAgentMarkdown = (markdown: string): string =>
  normalizeMermaidBlocks(normalizeGfmAlerts(markdown))

const ALERT_HEADER_LINE = /^>\s*\[![A-Z]+\]\s*\r?$/i
const BARE_QUOTE_LINE = /^>\r?$/

const lineAt = (markdown: string, lineStart: number): string => {
  const lineEnd = markdown.indexOf('\n', lineStart)
  return lineEnd === -1 ? markdown.slice(lineStart) : markdown.slice(lineStart, lineEnd)
}

// Start of the line above `lineStart` (which must itself be a line start), or -1 at position 0.
const lineStartBefore = (markdown: string, lineStart: number): number => {
  if (lineStart === 0) return -1
  if (lineStart === 1) return 0
  return markdown.lastIndexOf('\n', lineStart - 2) + 1
}

// An alert match crossing the boundary has its `> [!TYPE]` header above it and a body of
// consecutive `>` lines around it. Walk back over that construct — `>` lines, a bare `>` line
// gluing the next line into the body (`>\s?` can consume the newline), and blank lines a
// bodiless header can absorb (the header regex's trailing `\s*`) — so the boundary lands above
// the header.
const widenPastAlert = (markdown: string, boundary: number): number => {
  let cursor = boundary
  for (;;) {
    const previous = lineStartBefore(markdown, cursor)
    if (previous === -1) return cursor

    const previousLine = lineAt(markdown, previous)
    if (previousLine.startsWith('>')) {
      cursor = previous
      continue
    }

    if (previousLine.trim() === '') {
      // Only a header immediately above the blank run can still span it.
      let blankRunStart = previous
      for (;;) {
        const above = lineStartBefore(markdown, blankRunStart)
        if (above === -1 || lineAt(markdown, above).trim() !== '') break
        blankRunStart = above
      }
      const headerStart = lineStartBefore(markdown, blankRunStart)
      if (headerStart !== -1 && ALERT_HEADER_LINE.test(lineAt(markdown, headerStart))) {
        cursor = headerStart
        continue
      }
      return cursor
    }

    const glueStart = lineStartBefore(markdown, previous)
    if (glueStart !== -1 && BARE_QUOTE_LINE.test(lineAt(markdown, glueStart))) {
      cursor = glueStart
      continue
    }
    return cursor
  }
}

// The mermaid regex has no line anchor, so a "```mermaid" opener can start mid-line. If one
// sits before the boundary without its closing "```" also before it, widen the boundary to
// that opener's line so the whole block is re-normalized.
const widenPastMermaidOpener = (markdown: string, boundary: number): number => {
  const opener = markdown.lastIndexOf('```mermaid', boundary - 1)
  if (opener === -1) return boundary

  const closer = markdown.indexOf('```', opener + '```mermaid'.length)
  if (closer !== -1 && closer < boundary) return boundary

  return markdown.lastIndexOf('\n', opener - 1) + 1
}

// Incremental counterpart of the boundary scan for append-only streaming. The base split point
// is the last blank-line block boundary (alert bodies are consecutive non-empty `>` lines, so
// only a fence can span a blank line), widened to a fixpoint for the two constructs that reach
// further: mermaid blocks and GFM alerts. The fence scan persists across calls and resumes at
// the first line not yet fed to the tracker; only the per-call widening still walks the text.
const createNormalizationBoundaryFinder = (): ((markdown: string) => number) => {
  let cachedInput: string | null = null
  let fenceTracker = createCodeFenceTracker()
  let fenceOpenerStart = -1
  let boundary = 0
  // Start of the first line not yet fed to the tracker. The trailing partial line is never fed:
  // a later append can still complete it into a fence marker, and it is re-evaluated then.
  let scanPosition = 0

  const reset = (): void => {
    fenceTracker = createCodeFenceTracker()
    fenceOpenerStart = -1
    boundary = 0
    scanPosition = 0
  }

  return (markdown: string): number => {
    if (cachedInput === null || !markdown.startsWith(cachedInput)) reset()

    for (;;) {
      const newlineIndex = markdown.indexOf('\n', scanPosition)
      if (newlineIndex === -1) break
      const line = markdown.slice(scanPosition, newlineIndex)

      const fenceWasOpen = fenceTracker.isOpen()
      const fenceIsOpen = fenceTracker.feed(line)
      if (!fenceWasOpen && fenceIsOpen) {
        fenceOpenerStart = scanPosition
      } else if (fenceWasOpen && !fenceIsOpen) {
        fenceOpenerStart = -1
      }

      if (line.trim() === '') {
        boundary = fenceOpenerStart === -1 ? newlineIndex + 1 : fenceOpenerStart
      }

      scanPosition = newlineIndex + 1
    }

    // A whitespace-only trailing partial line still moves the base boundary to the end of input.
    // A blank line never changes the fence tracker, so this can be scored without feeding it.
    let baseBoundary = boundary
    if (scanPosition < markdown.length && markdown.slice(scanPosition).trim() === '') {
      baseBoundary = fenceOpenerStart === -1 ? markdown.length : fenceOpenerStart
    }
    baseBoundary = Math.min(baseBoundary, markdown.length)

    cachedInput = markdown

    let widened = baseBoundary
    while (widened > 0) {
      const next = widenPastAlert(markdown, widenPastMermaidOpener(markdown, widened))
      if (next === widened) return widened
      widened = next
    }
    return widened
  }
}

/**
 * Incremental `normalizeAgentMarkdown` for append-only streaming. Caches the last input/output
 * and, when the new input only appends to it, re-normalizes just from a safe boundary (the last
 * blank-line block, widened to any containing code fence) instead of the whole message. Anything
 * else — edits, truncation — falls back to full normalization.
 */
const createAgentMarkdownNormalizer = (): ((markdown: string) => string) => {
  let cachedInput: string | null = null
  let cachedOutput = ''
  let boundary = 0
  // Invariant: boundaryOutput === normalizeAgentMarkdown(cachedInput.slice(0, boundary)).
  let boundaryOutput = ''
  const findBoundary = createNormalizationBoundaryFinder()

  return (markdown: string): string => {
    if (markdown === cachedInput) return cachedOutput

    const appendFrom = cachedInput !== null && markdown.startsWith(cachedInput) ? boundary : -1

    const output =
      appendFrom === -1
        ? normalizeAgentMarkdown(markdown)
        : boundaryOutput + normalizeAgentMarkdown(markdown.slice(appendFrom))

    const nextBoundary = findBoundary(markdown)
    if (appendFrom !== -1 && nextBoundary >= appendFrom) {
      // Extend the cached prefix without re-normalizing it; both split points are safe.
      boundaryOutput =
        boundaryOutput + normalizeAgentMarkdown(markdown.slice(appendFrom, nextBoundary))
      boundary = nextBoundary
    } else {
      // No safe prefix to carry over; the next append re-normalizes everything once.
      boundary = 0
      boundaryOutput = ''
    }

    cachedInput = markdown
    cachedOutput = output
    return output
  }
}

export {
  createAgentMarkdownNormalizer,
  normalizeAgentMarkdown,
  normalizeGfmAlerts,
  normalizeMermaidChart
}
