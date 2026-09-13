/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Shared offline association; candidate geometry does not prove semantic correctness.
import assert from 'node:assert/strict'
import { captionKind, joinCaptionLines, groupPageLines } from './literature-pdf-caption-group.mjs'

const union = (rects) => [
  Math.min(...rects.map((r) => r[0])),
  Math.min(...rects.map((r) => r[1])),
  Math.max(...rects.map((r) => r[2])),
  Math.max(...rects.map((r) => r[3]))
]
const area = (r) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1])
const intersection = (a, b) =>
  area([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])])
const lineRect = (l) => [l.x, l.y, l.x + l.width, l.y + l.height]

export function associateFigures(page, candidates) {
  const pageCaptions = candidates.filter((c) => c.page === page.pageNumber)
  const captions = pageCaptions.filter((c) => captionKind(c.lines[0]) === 'figure')
  if (!page.graphicsBounds)
    return captions.map((caption) => ({ caption, reason: 'graphics-not-recorded' }))
  assert(
    Number.isSafeInteger(page.invalidGraphicsBounds) && page.invalidGraphicsBounds >= 0,
    'Rerun the structure probe to record invalid graphics bounds explicitly.'
  )
  const assigned = captions.map(() => [])
  const barriers = page.lines.filter((l) => l.text.length > 80)
  // Match both caption directions; intervening prose/captions block association.
  for (const graphic of page.graphicsBounds) {
    assert(
      graphic.normalizedRect.every(Number.isFinite),
      'Invalid recorded geometry; rerun the structure probe.'
    )
    const rect = graphic.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
    const eligible = captions
      .map((caption, index) => ({
        caption,
        index,
        gap: Math.max(caption.rect[1] - rect[3], rect[1] - caption.rect[3], 0)
      }))
      .filter(
        ({ caption: { rect: c } }) =>
          (rect[3] <= c[1] + page.height / 256 || rect[1] >= c[3] - page.height / 256) &&
          Math.max(c[1] - rect[3], rect[1] - c[3]) <= 400 &&
          (rect[0] + rect[2]) / 2 >= c[0] - 24 &&
          (rect[0] + rect[2]) / 2 <= c[2] + 24 &&
          !pageCaptions.some(
            (other) =>
              other.rect !== c &&
              other.rect[2] > rect[0] &&
              other.rect[0] < rect[2] &&
              (intersection(other.rect, rect) > 0 ||
                (other.rect[1] >= Math.min(rect[3], c[3]) - 3 &&
                  other.rect[3] <= Math.max(rect[1], c[1]) + 3))
          ) &&
          !barriers.some(
            (l) =>
              l.y > Math.min(rect[3], c[3]) + 2 &&
              l.y + l.height < Math.max(rect[1], c[1]) - 2 &&
              l.x < rect[2] &&
              l.x + l.width > rect[0]
          )
      )
      .sort((a, b) => a.gap - b.gap)
    if (!eligible.length) continue
    // Do not break same-height caption ties by input order.
    if (eligible[1] && Math.abs(eligible[1].gap - eligible[0].gap) < 2) continue
    assigned[eligible[0].index].push(rect)
  }
  return captions.map((caption, index) => {
    const graphics = assigned[index]
    if (!graphics.length) return { caption, reason: 'no-unambiguous-adjacent-graphics' }
    if (
      graphics.some((rect) => rect[3] <= caption.rect[1] + page.height / 256) &&
      graphics.some((rect) => rect[1] >= caption.rect[3] - page.height / 256)
    )
      return { caption, reason: 'ambiguous-graphic-direction' }
    const bounds = union(graphics)
    const below = caption.rect[1] >= bounds[3] - page.height / 256
    const nearby = page.lines.filter(
      (l) =>
        l.y >= Math.max(bounds[1] - 24, below ? 0 : caption.rect[3] + 2) &&
        l.y + l.height <= Math.min(bounds[3] + 24, below ? caption.rect[1] - 2 : page.height) &&
        l.x + l.width >= bounds[0] - 24 &&
        l.x <= bounds[2] + 24 &&
        !pageCaptions.some((c) => intersection(c.rect, lineRect(l)) > 0)
    )
    const rect = union([bounds, ...nearby.map(lineRect)])
    // Recorded operation boxes are quantized; keep the caption itself out of the resulting crop.
    if (below) rect[3] = Math.min(rect[3], caption.rect[1] - 2)
    else rect[1] = Math.max(rect[1], caption.rect[3] + 2)
    return { caption, rect, graphicsCount: graphics.length }
  })
}

// Local table-caption matching in the same scale-1 displayed viewport. Keep uncertain ownership absent.
export function associateTableCaptions(page, tables, candidates) {
  const captions = candidates.filter(
    (c) => c.page === page.pageNumber && captionKind(c.lines[0]) === 'table'
  )
  const choices = tables.map(({ rect }) =>
    captions
      .map((caption) => {
        const c = caption.rect
        const gap = c[3] <= rect[1] ? rect[1] - c[3] : c[1] >= rect[3] ? c[1] - rect[3] : -1
        const overlap = Math.min(c[2], rect[2]) - Math.max(c[0], rect[0])
        const betweenTop = Math.min(c[3], rect[3])
        const betweenBottom = Math.max(c[1], rect[1])
        const blocked = page.lines.some((line) => {
          const l = lineRect(line)
          return (
            line.text.length > 80 &&
            l[1] > betweenTop + 2 &&
            l[3] < betweenBottom - 2 &&
            l[0] < rect[2] &&
            l[2] > rect[0] &&
            !candidates.some(
              (candidate) =>
                candidate.page === page.pageNumber && intersection(candidate.rect, l) > 0
            )
          )
        })
        return { caption, gap, overlap, blocked }
      })
      .filter(
        ({ caption, gap, overlap, blocked }) =>
          gap >= 0 &&
          gap <= 60 &&
          !blocked &&
          overlap / Math.min(rect[2] - rect[0], caption.rect[2] - caption.rect[0]) >= 0.5
      )
      .sort((a, b) => a.gap - b.gap)
  )
  return choices.map((matches, index) => {
    if (!matches.length) return { reason: 'no-adjacent-table-caption' }
    if (matches[1] && matches[1].gap - matches[0].gap < 2)
      return { reason: 'ambiguous-table-caption' }
    const best = matches[0]
    // Require the caption to prefer this table too; reject reverse ties or a closer competing table.
    if (
      choices.some(
        (other, i) =>
          i !== index && other.some((m) => m.caption === best.caption && m.gap <= best.gap + 2)
      )
    )
      return { reason: 'shared-table-caption' }
    return { caption: best.caption }
  })
}

// A note must begin with a footnote marker or explicit notes label and have one
// nearest preceding table. Continuations retain their original source region.
export function associateTableNotes(page, tables) {
  const notes = tables.map(() => [])
  const startsNote = (text) =>
    /^(?:[*†‡§¶‖]|Notes?\s*[:：]|注\s*[:：]|註\s*[:：])/i.test(text.trim())
  const lines = groupPageLines(page)
    .map((line) => ({ ...line, width: line.right - line.x, height: line.bottom - line.y }))
    .sort((a, b) => a.y - b.y || a.x - b.x)
  const used = new Set()
  for (const start of lines) {
    if (
      used.has(start) ||
      !startsNote(start.text) ||
      tables.some(({ rect }) => intersection(rect, lineRect(start)) > 0)
    )
      continue
    const candidates = tables
      .map(({ rect }, index) => ({
        rect,
        index,
        gap: start.y - (notes[index].at(-1)?.rect[3] ?? rect[3])
      }))
      .filter(
        ({ rect, gap }) =>
          gap >= 0 &&
          gap <= Math.max(36, start.fontSize * 3) &&
          (Math.min(rect[2], start.x + start.width) - Math.max(rect[0], start.x)) /
            Math.min(rect[2] - rect[0], start.width) >=
            0.7
      )
      .sort((a, b) => a.gap - b.gap)
    if (!candidates.length || (candidates[1] && candidates[1].gap - candidates[0].gap < 2)) continue
    const parts = [start]
    used.add(start)
    for (const next of lines.filter((line) => line.y > start.y + 2)) {
      if (next.x >= candidates[0].rect[2] + 4 || next.x + next.width <= candidates[0].rect[0] - 4)
        continue
      const previous = parts.at(-1)
      if (
        startsNote(next.text) ||
        next.y - previous.y > start.fontSize * 1.8 ||
        Math.abs(next.fontSize - start.fontSize) > 0.8 ||
        next.x < start.x - 4 ||
        next.x > start.x + 24 ||
        captionKind(next.text)
      )
        break
      if (tables.some(({ rect }) => intersection(rect, lineRect(next)) > 0)) break
      parts.push(next)
      used.add(next)
    }
    notes[candidates[0].index].push({
      text: joinCaptionLines(parts.map((line) => line.text)),
      rect: union(parts.map(lineRect))
    })
  }
  return notes
}
