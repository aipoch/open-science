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
  if (predicted.length === 8) return recoverPairedBinaryIntervals(table, items, predicted)
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

// Binary count columns can share one diagnostic interval per cohort below.
// Keep those intervals together only when all three repeated negative/positive
// headers, both count records and every complete interval are present.
function recoverPairedBinaryIntervals(table, items, columns) {
  const [left, top, right, bottom] = table.cropRect
  const cuts = [
    left,
    ...columns.slice(1).map((c, n) => left + (columns[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const source = items.filter(
    (i) =>
      i.horizontal &&
      i.rect[0] >= left &&
      i.rect[2] <= right &&
      i.rect[1] >= top &&
      i.rect[3] <= bottom
  )
  const child = source
    .filter((i) => /^SR (?:negative|positive)$/.test(i.text))
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (
    child.length !== 6 ||
    child.some(
      (i, n) =>
        col(i) !== n + 2 ||
        i.text !== `SR ${n % 2 ? 'positive' : 'negative'}` ||
        Math.abs(i.baseline - child[0].baseline) > 1
    )
  )
    return
  const height = child[0].height
  const parents = source.filter((i) => i.baseline < child[0].rect[1])
  const body = source.filter((i) => i.rect[1] > child[0].baseline)
  const labelLines = []
  for (const i of body
    .filter((i) => col(i) <= 1)
    .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    const g = labelLines.find(
      (g) => col(g[0]) === col(i) && Math.abs(g[0].baseline - i.baseline) < height * 0.3
    )
    if (g) g.push(i)
    else labelLines.push([i])
  }
  const labels = labelLines
    .map((g) => ({ ...g[0], rect: union(g), text: g.map((i) => i.text).join('') }))
    .filter((i) =>
      /^(?:Free margins|Involved margins|Sensitivity|Specificity|PPV|NPV|Accuracy)\b/.test(i.text)
    )
    .sort((a, b) => a.baseline - b.baseline)
  if (
    labels.length !== 7 ||
    !/^Free margins/.test(labels[0].text) ||
    !/^Involved margins/.test(labels[1].text)
  )
    return
  const edges = [
    child[0].baseline + height * 0.1,
    ...labels.slice(1).map((i, n) => (labels[n].baseline + i.rect[1]) / 2),
    bottom
  ]
  const groups = labels.map((_, n) =>
    body.filter(
      (i) => (i.rect[1] + i.rect[3]) / 2 >= edges[n] && (i.rect[1] + i.rect[3]) / 2 < edges[n + 1]
    )
  )
  const text = (g, start, end) =>
    g
      .filter((i) => col(i) >= start && col(i) < end)
      .sort((a, b) => a.rect[0] - b.rect[0])
      .map((i) => i.text)
      .join('')
      .replace(/\s/g, '')
  if ([0, 1].some((n) => [2, 3, 4, 5, 6, 7].some((c) => !/^\d+$/.test(text(groups[n], c, c + 1)))))
    return
  if (
    groups
      .slice(2)
      .some((g) =>
        [2, 4, 6].some(
          (c) => !/^\d+(?:\.\d+)?\(\d+(?:\.\d+)?[–-]\d+(?:\.\d+)?\)$/.test(text(g, c, c + 2))
        )
      )
  )
    return
  if (
    [2, 4, 6].some((c) => !/^.+\(n=\d+\)$/.test(text(parents, c, c + 2))) ||
    body.some((i) => !groups.some((g) => g.includes(i)))
  )
    return
  const spans = [
    { row: 2, column: 0, rowSpan: 2, colSpan: 1 },
    ...[2, 4, 6].map((column) => ({ row: 0, column, rowSpan: 1, colSpan: 2 }))
  ]
  for (let n = 2; n < groups.length; n++)
    for (const column of [0, 2, 4, 6]) spans.push({ row: n + 2, column, rowSpan: 1, colSpan: 2 })
  return {
    rows: [
      [left, union(parents)[1], right, child[0].rect[1] - 0.1],
      [left, child[0].rect[1] - 0.1, right, edges[0]],
      ...groups.map((_, n) => [left, edges[n], right, edges[n + 1]])
    ],
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans,
    headerRows: [0, 1],
    completeSpans: true
  }
}
