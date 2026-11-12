/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'

const label = /^Table\s+([A-Z]?\d+)\s+(?![.:])/u
const valid = (r) =>
  r &&
  typeof r.text === 'string' &&
  [r.x, r.y, r.right, r.bottom, r.fontSize].every(Number.isFinite) &&
  r.right > r.x &&
  r.bottom > r.y &&
  r.fontSize > 0

// Negative candidate proof only: the independent printed title and complete
// native table remain responsible for their own association and Source.
export function nativePrintedTableBodyReference(start, runs, page, rules, kind) {
  const number = label.exec(start?.text ?? '')?.[1],
    em = start?.fontSize
  if (
    !number ||
    !valid(start) ||
    kind(start.text) !== 'table' ||
    page.rotation !== 0 ||
    (page.renderRotation ?? 0) !== 0 ||
    page.invalidGraphicsBounds !== 0 ||
    !Array.isArray(runs) ||
    runs.length > 4096 ||
    !runs.every(valid) ||
    !Array.isArray(page.graphicsBounds) ||
    page.graphicsBounds.length > 4096 ||
    !Array.isArray(rules) ||
    rules.some((r) => !Array.isArray(r) || r.length !== 4 || !r.every(Number.isFinite))
  )
    return false
  const titles = runs.filter(
    (r) =>
      r !== start &&
      r.y > start.bottom &&
      label.exec(r.text)?.[1] === number &&
      kind(r.text) === 'table'
  )
  if (titles.length !== 1) return false
  const title = titles[0]
  if (
    !/[.!?]$/u.test(title.text.trim()) ||
    Math.abs(title.fontSize - em) > em * 0.02 ||
    Math.abs(title.x - start.x) > em * 0.1 ||
    title.right > start.right + em * 0.2
  )
    return false
  const body = runs
    .filter((r) => r.y >= start.y && r.bottom < title.y)
    .sort((a, b) => a.y - b.y || a.x - b.x)
  if (
    body.length < 3 ||
    body.length > 12 ||
    body[0] !== start ||
    !/[.!?]$/u.test(body.at(-1).text.trim()) ||
    body.at(-1).right - start.x > (start.right - start.x) * 0.65 ||
    title.y - body.at(-1).bottom < em * 0.75 ||
    title.y - body.at(-1).bottom > em * 3 ||
    body.some(
      (r, i) =>
        Math.abs(r.x - start.x) > em * 0.1 ||
        Math.abs(r.fontSize - em) > em * 0.02 ||
        r.right > start.right + em * 0.2 ||
        (i < body.length - 1 && r.right - r.x < (start.right - start.x) * 0.8) ||
        (i && (r.y < body[i - 1].bottom || r.y - body[i - 1].bottom > em * 0.65))
    )
  )
    return false
  const horizontal = joinHorizontalTableRules(rules)
  const openings = horizontal.filter(
    (r) =>
      r[1] >= title.bottom &&
      r[1] - title.bottom < em * 3 &&
      r[0] >= title.x - em * 0.1 &&
      r[2] <= start.right + em * 0.2 &&
      r[2] - r[0] > em * 10 &&
      r[2] - r[0] >= (title.right - title.x) * 0.8 &&
      Math.min(r[2], title.right) - Math.max(r[0], title.x) > (r[2] - r[0]) * 0.6
  )
  if (openings.length !== 1) return false
  const first = openings[0],
    rails = horizontal.filter(
      (r) =>
        r[1] >= first[1] && Math.abs(r[0] - first[0]) < 0.01 && Math.abs(r[2] - first[2]) < 0.01
    )
  if (
    rails.length !== 3 ||
    rails[1][1] - first[1] < em * 0.5 ||
    rails[1][1] - first[1] > em * 4 ||
    rails[2][1] - rails[1][1] < em * 3
  )
    return false
  const closing = rails[2]
  // An independent drawing may make the earlier long paragraph a real title.
  // Reject every observed envelope in the complete paragraph/title band.
  // In the remaining gap also reject images and fully contained paths. A path
  // straddling the opening is not classified as owned from its coarse box.
  for (const graphic of page.graphicsBounds) {
    const n = graphic.normalizedRect
    if (
      !['path', 'image'].includes(graphic.kind) ||
      !Array.isArray(n) ||
      n.length !== 4 ||
      !n.every(Number.isFinite) ||
      n.some((v) => v < 0 || v > 1) ||
      n[2] <= n[0] ||
      n[3] <= n[1]
    )
      return false
    const r = n.map((v, i) => v * (i % 2 ? page.height : page.width))
    if (r[0] >= start.right || r[2] <= start.x) continue
    if (
      (r[3] > start.y && r[1] < title.bottom) ||
      (graphic.kind === 'image' && r[3] > title.bottom && r[1] < first[1]) ||
      (graphic.kind === 'path' && r[1] >= title.bottom && r[3] <= first[1])
    )
      return false
  }
  if (
    runs.some(
      (r) =>
        r !== title &&
        r.y < first[1] &&
        r.bottom > body.at(-1).bottom &&
        r.x < start.right &&
        r.right > start.x
    ) ||
    runs.filter(
      (r) =>
        r.y >= first[1] &&
        r.bottom <= closing[1] &&
        r.x >= first[0] - em * 0.1 &&
        r.right <= first[2] + em * 0.1 &&
        /\d/u.test(r.text)
    ).length < 3
  )
    return false
  // Every original native font in the paragraph/title corridor must belong to
  // exactly one proved row; extra source cannot be hidden by run grouping.
  const rows = [...body, title],
    source = page.lines.filter(
      (l) =>
        l.text.trim() &&
        l.x < start.right &&
        l.x + l.width > start.x &&
        l.y + l.height > start.y &&
        l.y < first[1]
    )
  if (
    !source.length ||
    source.some(
      (l) =>
        !rows.some(
          (r) =>
            l.x >= r.x - em * 0.1 &&
            l.x + l.width <= r.right + em * 0.1 &&
            l.y >= r.y - em * 0.1 &&
            l.y + l.height <= r.bottom + em * 0.1
        )
    )
  )
    return false
  return true
}
