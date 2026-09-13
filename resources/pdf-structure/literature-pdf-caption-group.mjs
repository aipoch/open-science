/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Offline geometry heuristic; a caption candidate is not a semantic classification.
import assert from 'node:assert/strict'

export function captionKind(text) {
  const match =
    /^(?:(?:Supplementary|Supplemental)\s+)?(Figure|Fig\.?|Table|Tab\.?|图|圖|表)\s*S?\d+(?:[.-]\d+)*(?=[\s.:：．、]|$)/i.exec(
      text ?? ''
    )
  return match ? (/^(?:Table|Tab\.?|表)$/i.test(match[1]) ? 'table' : 'figure') : undefined
}

// PDF line endings describe placement, not paragraphs. Retain visible hyphens;
// only an explicit soft hyphen is safe to remove without a language dictionary.
export function joinCaptionLines(lines) {
  return lines.reduce((text, line) => {
    const next = line.trim()
    if (!next) return text
    if (text.endsWith('\u00ad')) return text.slice(0, -1) + next
    return text + (text && !text.endsWith('-') ? ' ' : '') + next
  }, '')
}

export function groupPageLines(page) {
  const rows = []
  // Join nearby fragments on the same visual line, including superscripts split by the first probe.
  for (const line of [...page.lines].sort((a, b) => a.y - b.y || a.x - b.x)) {
    assert([line.x, line.y, line.width, line.height, line.fontSize].every(Number.isFinite))
    const row = rows.find((entry) => Math.abs(entry.y - line.y) <= 2)
    if (row) row.parts.push(line)
    else rows.push({ y: line.y, parts: [line] })
  }
  const runs = []
  for (const row of rows) {
    let run
    for (const part of row.parts.sort((a, b) => a.x - b.x)) {
      // Geometry only: permit nearby fragments, but do not bridge a typical column gutter.
      // A narrow gutter or unusually wide within-caption gap still needs layout-level evidence.
      if (run && part.x - run.right <= Math.max(run.fontSize, part.fontSize) * 0.8) {
        run.text += ' ' + part.text
        run.y = Math.min(run.y, part.y)
        run.right = Math.max(run.right, part.x + part.width)
        run.bottom = Math.max(run.bottom, part.y + part.height)
        run.fontSize = Math.max(run.fontSize, part.fontSize)
      } else {
        run = {
          text: part.text,
          x: part.x,
          y: part.y,
          right: part.x + part.width,
          bottom: part.y + part.height,
          fontSize: part.fontSize
        }
        runs.push(run)
      }
    }
  }
  return runs
}

export function findCaptionCandidates(pages) {
  const candidates = []
  for (const page of pages) {
    assert(page.rotation === 0, 'Only unrotated geometry is supported.')
    const runs = groupPageLines(page)
    for (const start of runs.filter(({ text }) => captionKind(text))) {
      const lines = [start]
      // ponytail: left alignment, font size and line gap cannot distinguish a caption from body text.
      for (let count = 1; count < runs.length; count++) {
        const previous = lines.at(-1)
        const next = runs
          .filter((line) => line.y > previous.y + 2 && Math.abs(line.x - start.x) <= 2)
          .sort((a, b) => a.y - b.y)[0]
        if (
          !next ||
          next.y - previous.y > start.fontSize * 1.6 ||
          Math.abs(next.fontSize - start.fontSize) > 0.7 ||
          captionKind(next.text)
        )
          break
        lines.push(next)
      }
      candidates.push({
        page: page.pageNumber,
        lines: lines.map(({ text }) => text),
        rect: [
          Math.min(...lines.map((line) => line.x)),
          Math.min(...lines.map((line) => line.y)),
          Math.max(...lines.map((line) => line.right)),
          Math.max(...lines.map((line) => line.bottom))
        ]
      })
    }
  }
  return candidates
}
