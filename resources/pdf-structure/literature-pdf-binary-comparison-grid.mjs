/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
import { union } from './literature-pdf-table-geometry.mjs'

// Repeated binary comparisons establish their columns through the same +/-
// subheaders in every block. A model can miss the wide label column entirely.
export function recoverBinaryComparisonGrid(table, items, captions) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  for (let n = predicted.length - 1; n > 0; n--) {
    const a = predicted[n].rect,
      b = predicted[n - 1].rect
    if ((Math.min(a[2], b[2]) - Math.max(a[0], b[0])) / Math.min(a[2] - a[0], b[2] - b[0]) > 0.7)
      predicted.splice(n - 1, 1)
  }
  if (![3, 6].includes(predicted.length)) return
  const source = items.filter(
    (i) =>
      i.horizontal &&
      i.rect[0] >= left &&
      i.rect[2] <= right &&
      i.rect[1] >= top &&
      i.rect[3] <= bottom
  )
  let groups = []
  for (const i of [...source].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    const g = groups.find((g) => Math.abs(g[0].baseline - i.baseline) < i.height * 0.65)
    if (g) g.push(i)
    else groups.push([i])
  }
  groups = groups.map((g) => {
    const joined = []
    for (const i of g.sort((a, b) => a.rect[0] - b.rect[0])) {
      const last = joined.at(-1)
      if (last && i.rect[0] - last.rect[2] < i.height * 0.8) {
        last.text += ' ' + i.text
        last.rect = union([last, i])
      } else joined.push({ ...i, rect: [...i.rect] })
    }
    return joined
  })
  const text = (g) => g.map((i) => i.text).join(' ')
  let cuts,
    spans = []
  if (predicted.length === 3) {
    const headers = groups.filter(
      (g) => g.length === 2 && g.every((i) => /^\S+\s*[+−-]$/.test(i.text))
    )
    if (headers.length !== 2 || text(headers[0]) !== text(headers[1])) return
    const labels = groups.filter(
      (g) =>
        g.length === 3 &&
        /^\S+\s*[+−-]$/.test(g[0].text) &&
        g.slice(1).every((i) => /^\d+$/.test(i.text))
    )
    if (labels.length !== 4) return
    const labelRight = Math.max(...labels.map((g) => g[0].rect[2])),
      valueLeft = Math.min(...labels.map((g) => g[1].rect[0]))
    if (valueLeft - labelRight < source[0].height * 3) return
    cuts = [
      left,
      (labelRight + valueLeft) / 2,
      ...predicted.slice(1).map((c, n) => left + (predicted[n].rect[2] + c.rect[0]) / 2),
      right
    ]
  } else {
    const binary = groups.filter(
      (g) => g.length === 4 && g.every((i, n) => i.text === (n % 2 ? '−' : '+'))
    )
    if (binary.length < 2) return
    cuts = [
      left,
      ...predicted.slice(1).map((c, n) => left + (predicted[n].rect[2] + c.rect[0]) / 2),
      right
    ]
    if (
      !binary.every((g) =>
        g.every(
          (i, n) =>
            (i.rect[0] + i.rect[2]) / 2 > cuts[n + 1] && (i.rect[0] + i.rect[2]) / 2 < cuts[n + 2]
        )
      )
    )
      return
  }
  const rows = []
  for (const g of groups) {
    const r = union(g),
      s = text(g),
      row = rows.length
    if (/^(?:CI confidence interval|Values were compared)/.test(s)) break
    if (predicted.length === 3) {
      if (/^(?:Concordance rate|Overall diagnostic concordance)/i.test(s))
        spans.push({ row, column: 0, rowSpan: 1, colSpan: 4 })
      else if (g.length === 2 && g.at(-1).text === 'Total')
        spans.push({ row, column: 1, rowSpan: 1, colSpan: 2 })
      else if (!g.every((i) => /^(?:\S+\s*[+−-]|\d+)$/.test(i.text))) return
    } else {
      const sub = groups[groups.indexOf(g) + 1]
      if (sub?.length === 4 && sub.every((i, n) => i.text === (n % 2 ? '−' : '+'))) {
        for (const c of [1, 3]) {
          const label = g.filter((i) => i.rect[0] >= cuts[c] - 1 && i.rect[2] <= cuts[c + 2] + 1)
          if (!/\S+\s+n\s*=\s*\d+/.test(text(label))) return
          spans.push({ row, column: c, rowSpan: 1, colSpan: 2 })
        }
      } else if (g.length === 1 && /^(?:Total cases|Lesion\s*[<>≤≥])/.test(s))
        spans.push({ row, column: 0, rowSpan: 1, colSpan: 6 })
      else if (
        !g.every((i) =>
          /^(?:[+−]|\d+(?:\.\d+)?|Histopathology\s*[+−]\s*,?\s*n\s*=\s*\d+|(?:Sensitivity|Specificity|Accuracy)\s*\(%\))$/.test(
            i.text
          )
        )
      )
        return
    }
    rows.push([left, r[1], right, r[3]])
  }
  for (let n = 1; n < rows.length; n++) {
    const y = (rows[n - 1][3] + rows[n][1]) / 2
    rows[n - 1][3] = y
    rows[n][1] = y
  }
  return {
    rows,
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans,
    completeSpans: true
  }
}
