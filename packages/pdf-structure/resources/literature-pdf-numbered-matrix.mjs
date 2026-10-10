/* eslint-disable @typescript-eslint/explicit-function-return-type */
import {
  tableSourceItems,
  readSourceRow,
  groupSourceRowsWithScripts,
  hasUniqueRecordTokens
} from './literature-pdf-source-records.mjs'
import { union } from './literature-pdf-table-geometry.mjs'

// Numbered variables, consecutive column references and the printed unit
// diagonal jointly establish an upper-triangular correlation matrix. Missing
// correlations stay blank; neither symmetry nor a computed value fills them.
export function recoverNumberedMatrix(table, items, captions, rules) {
  if (!captions.some((c) => /\bcorrelations?\b/i.test(c.lines.join(' ')))) return
  const [left, top, right, bottom] = table.cropRect
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (predicted.length < 5) return
  const cuts = [
    left,
    ...predicted.slice(1).map((c, n) => left + (predicted[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const source = tableSourceItems(items, table.cropRect)
  const summary = recoverSummaryTriangle(source, table.cropRect, rules)
  if (summary) return summary
  const named = recoverNamedTriangle(source, table.cropRect, rules)
  if (named) return named
  const labels = source.filter((i) => /^\d+\.\s+\p{L}/u.test(i.text) && i.rect[2] < cuts[1])
  if (
    labels.length !== predicted.length ||
    labels.some((i, n) => Number.parseInt(i.text) !== n + 1)
  )
    return
  const heads = source.filter((i) => i.rect[3] < labels[0].rect[1] && /^\d+$/.test(i.text))
  if (
    heads.length !== predicted.length - 1 ||
    heads.some((i, n) => i.text !== String(n + 2) || Math.abs(i.baseline - heads[0].baseline) > 1)
  )
    return
  const header = readSourceRow(heads, cuts)
  if (!header || header[0] || header.slice(1).some((s, n) => s !== String(n + 2))) return
  const footer = rules.find(
    (r) =>
      r[1] === r[3] &&
      r[0] <= left + 12 &&
      r[2] >= right - 16 &&
      r[1] > labels.at(-1).rect[3] &&
      r[1] <= bottom
  )
  if (!footer) return
  const boundaries = [
    heads[0].rect[3],
    ...labels.slice(1).map((l, n) => (labels[n].baseline + l.baseline) / 2 - l.height * 0.6),
    footer[1]
  ]
  const records = labels.map((_, n) =>
    source.filter((i) => i.rect[1] >= boundaries[n] && i.rect[3] <= boundaries[n + 1])
  )
  if (
    new Set([...heads, ...records.flat()]).size !== source.length ||
    records.flat().length + heads.length !== source.length
  )
    return
  for (let n = 0; n < records.length; n++) {
    const cells = readSourceRow(records[n], cuts)
    if (!cells || !cells[0]?.startsWith(`${n + 1}.`)) return
    for (let c = 1; c < cells.length; c++) {
      if (c < n) {
        if (cells[c]) return
      } else if (!/^[−-]?(?:0?\.\d+|1\.0+)[a-z]?$/.test(cells[c])) return
      if (n > 0 && c === n && !/^1\.0+$/.test(cells[c])) return
    }
  }
  const rects = [union(heads), ...records.map(union)]
  if (rects.some((r, n) => n && r[1] <= rects[n - 1][3])) return
  const ys = [rects[0][1], ...rects.slice(1).map((r, n) => (rects[n][3] + r[1]) / 2), footer[1]]
  return {
    rows: ys.slice(1).map((y, n) => [left, ys[n], right, y]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], top, x, bottom]),
    spans: [],
    completeSpans: true
  }
}

// A numbered lower triangle may have summary columns before the coefficients.
// Consecutive source headers and the exact increasing coefficient count prove
// a column omitted by the model; never synthesize a diagonal or mirror values.
function recoverSummaryTriangle(source, [left, top, right, bottom], rules) {
  const labels = source
    .filter((i) => /^\d+\.\s+\p{L}/u.test(i.text))
    .sort((a, b) => a.baseline - b.baseline)
  if (labels.length < 6 || labels.some((i, n) => Number.parseInt(i.text) !== n + 1)) return
  const header = source
    .filter((i) => i.rect[3] < labels[0].rect[1])
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (
    header.length !== labels.length + 2 ||
    !/^Variable$/i.test(header[0].text) ||
    !/^Mean$/i.test(header[1].text) ||
    !/^SD$/i.test(header[2].text) ||
    header.slice(3).some((i, n) => i.text !== String(n + 1))
  )
    return
  const height = header[0].height
  const full = rules.filter((r) => r[1] === r[3] && r[0] <= left + 16 && r[2] >= right - 16)
  const divider = full.find(
    (r) => r[1] >= Math.max(...header.map((i) => i.rect[3])) && r[1] < labels[0].rect[1]
  )
  const footer = full.find((r) => r[1] > labels.at(-1).rect[3] && r[1] <= bottom)
  if (!divider || !footer) return
  const cuts = [
    left,
    (Math.max(...labels.map((i) => i.rect[2])) + header[1].rect[0]) / 2,
    ...header.slice(2).map((i, n) => (header[n + 1].rect[2] + i.rect[0]) / 2),
    right
  ]
  const body = source.filter((i) => i.rect[1] > divider[1] && i.rect[3] < footer[1])
  const sections = body.filter(
    (i) =>
      !labels.includes(i) &&
      i.rect[0] < cuts[1] &&
      /\p{L}/u.test(i.text) &&
      i.text.length > 3 &&
      labels.every((l) => Math.abs(i.baseline - l.baseline) > height)
  )
  if (sections.some((i) => i.rect[2] >= cuts[1])) return
  const anchors = [...labels, ...sections].sort((a, b) => a.baseline - b.baseline)
  const ys = [
    divider[1],
    ...anchors.slice(1).map((a, n) => (anchors[n].baseline + a.baseline) / 2 - height * 0.5),
    footer[1]
  ]
  const groups = anchors.map((_, n) =>
    body.filter(
      (i) => (i.rect[1] + i.rect[3]) / 2 >= ys[n] && (i.rect[1] + i.rect[3]) / 2 < ys[n + 1]
    )
  )
  if (!hasUniqueRecordTokens(source, [header, ...groups])) return
  const coefficient = (s) => /^[<>≤≥]?[−–-]?(?:0?\.\d+|\d{1,3})\*{0,3}$/.test(s)
  const spans = []
  for (let n = 0; n < groups.length; n++) {
    const v = readSourceRow(groups[n], cuts)
    if (!v) return
    const index = labels.indexOf(anchors[n])
    if (index < 0) {
      if (v.slice(1).some(Boolean)) return
      spans.push({ row: n + 1, column: 0, rowSpan: 1, colSpan: cuts.length - 1 })
      continue
    }
    if (
      !v[0].startsWith(`${index + 1}.`) ||
      !v.slice(1, 3).every((s) => /^(?:\d+(?:\.\d+)?|—)$/.test(s)) ||
      v.slice(3).some((s, c) => (c < index ? !coefficient(s) : Boolean(s)))
    )
      return
  }
  return {
    rows: [[left, top, right, divider[1]], ...ys.slice(1).map((y, n) => [left, ys[n], right, y])],
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    headerRows: [0],
    spans,
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// A printed lower triangle establishes its sparse columns from the header and
// the increasing count of coefficients. Preserve repeated/mistyped source labels.
function recoverNamedTriangle(source, [left, top, right, bottom], rules) {
  if (!source.length) return
  const height = source.map((i) => i.height).sort((a, b) => a - b)[Math.floor(source.length / 2)]
  const groups = groupSourceRowsWithScripts(source, height, 0.35)
  if (!groups || groups.length < 7 || groups.length > 25) return
  const head = [...groups[0]].sort((a, b) => a.rect[0] - b.rect[0])
  if (head.length !== groups.length - 2 || !head.every((i) => /^[A-Za-z]{2,12} ?\d?$/.test(i.text)))
    return
  const firstStub = groups[1].find((i) => i.rect[2] < head[0].rect[0])
  if (!firstStub || groups[1].length !== 1) return
  const cuts = [
    left,
    (firstStub.rect[2] + head[0].rect[0]) / 2,
    ...head.slice(1).map((i, n) => (head[n].rect[2] + i.rect[0]) / 2),
    right
  ]
  const values = groups.slice(1).map((g) => readSourceRow(g, cuts))
  if (
    values.some(
      (v, n) =>
        !v ||
        !/^[A-Za-z]{2,12}\d?$/.test(v[0]) ||
        v
          .slice(1)
          .some((x, c) => (c < n ? !/^[−-]?(?:0?\.\d+|1(?:\.0+)?)\*{0,2}$/.test(x) : Boolean(x)))
    )
  )
    return
  const divider = rules.find(
    (r) =>
      r[1] === r[3] &&
      r[0] <= left + 16 &&
      r[2] >= right - 16 &&
      r[1] > union(head)[3] &&
      r[1] < firstStub.rect[1]
  )
  if (!divider) return
  const rects = groups.map(union)
  if (rects.some((r, n) => n && r[1] <= rects[n - 1][3])) return
  return {
    rows: rects.map((r) => [left, r[1], right, r[3]]),
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans: [],
    completeSpans: true
  }
}
