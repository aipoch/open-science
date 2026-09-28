/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { groupPageLines, captionKind } from './literature-pdf-caption-group.mjs'

// Raised, consecutive note numbers and a repeated manuscript line rhythm are
// independent evidence. Ordinary numbered paragraphs and isolated references
// do not establish a double-spaced footnote sequence.
export function findDoubleSpacedNoteBlocks(page) {
  const lines = groupPageLines({
    ...page,
    lines: page.lines.filter((l) => !isNotePageMargin(l, page))
  }).sort((a, b) => a.y - b.y || a.x - b.x)
  const starts = lines.filter(
    (line) =>
      /^([1-9]\d?)\s+\p{L}/u.test(line.text) &&
      page.lines.some(
        (part) =>
          part.text === /^\d+/.exec(line.text)[0] &&
          Math.abs(part.x - line.x) < 1 &&
          Math.abs(part.y - line.y) < 2 &&
          part.fontSize < line.fontSize * 0.8 &&
          part.y + part.height < line.bottom - line.fontSize * 0.15
      )
  )
  if (
    !starts.length ||
    starts.some(
      (line, n) =>
        Math.abs(line.x - starts[0].x) > 2 ||
        Math.abs(line.fontSize - starts[0].fontSize) > 0.7 ||
        (n && Number(/^\d+/.exec(line.text)[0]) !== Number(/^\d+/.exec(starts[n - 1].text)[0]) + 1)
    )
  )
    return []
  const blocks = []
  let spacing,
    wrapped = 0
  for (const [n, start] of starts.entries()) {
    const parts = [start]
    for (const next of lines.filter(
      (l) => l.y > start.y + 2 && l.y < (starts[n + 1]?.y ?? Infinity)
    )) {
      const previous = parts.at(-1),
        gap = next.bottom - previous.bottom
      if (
        Math.abs(next.x - start.x) > 2 ||
        Math.abs(next.fontSize - start.fontSize) > 0.7 ||
        gap <= start.fontSize * 1.8 ||
        gap > start.fontSize * 2.5 ||
        (spacing !== undefined && Math.abs(gap - spacing) > 1) ||
        captionKind(next.text)
      )
        break
      spacing ??= gap
      parts.push(next)
      wrapped++
      if (next.right - next.x < (start.right - start.x) * 0.8 && /[.;)]$/.test(next.text)) break
    }
    if (n && start.y - blocks[n - 1].lines.at(-1).bottom > start.fontSize * 4) return []
    blocks.push({ number: Number(/^\d+/.exec(start.text)[0]), lines: parts })
  }
  // An isolated raised note may occupy the entire remaining page. Only its
  // one aligned lowercase continuation can replace the missing repetition;
  // extra prose or a completed first sentence makes ownership uncertain.
  if (starts.length === 1) {
    const parts = blocks[0].lines
    return parts.length === 2 &&
      !/[.;!?]$/.test(parts[0].text) &&
      /^[a-z]/.test(parts[1].text) &&
      lines.filter((l) => l.y >= starts[0].y).every((l) => parts.includes(l))
      ? blocks
      : []
  }
  return wrapped >= 2 ? blocks : []
}

export function isNotePageMargin(line, page) {
  const bottom = line.bottom ?? line.y + line.height
  return (
    (/^\d+$/.test(line.text.trim()) &&
      (line.y > page.height * 0.9 || bottom < page.height * 0.06)) ||
    (bottom - line.y > line.fontSize * 2 &&
      /^(?:ACCEPTED (?:MANUSCRIPT|ARTICLE)|JOURNAL PRE[- ]PROOF|PROOF)$/i.test(line.text.trim())) ||
    (/^Downloaded from\s+https?:\/\//i.test(line.text) &&
      line.x > page.width * 0.9 &&
      bottom - line.y > line.fontSize * 2)
  )
}
