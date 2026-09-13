/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
import { union } from './literature-pdf-table-geometry.mjs'
import {
  tableSourceItems,
  readSourceRow,
  hasUniqueRecordTokens
} from './literature-pdf-source-records.mjs'
import { area, intersection as intersect } from './literature-pdf-page-geometry.mjs'

// Consecutive source identifiers anchor case records, including wrapped assay
// or stage descriptions. Centered section titles require enclosing full-width
// rules; a wrapped value without those rules cannot become a section.
export function recoverNumberedCaseGrid(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  for (let n = predicted.length - 1; n > 0; n--)
    if (
      intersect(predicted[n].rect, predicted[n - 1].rect) /
        Math.min(area(predicted[n].rect), area(predicted[n - 1].rect)) >
      0.9
    )
      predicted.splice((predicted[n].score ?? 1) > (predicted[n - 1].score ?? 1) ? n - 1 : n, 1)
  if (predicted.length < 4 || predicted.length > 8) return
  const cuts = [
    left,
    ...predicted.slice(1).map((c, n) => left + (predicted[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const source = tableSourceItems(items, table.cropRect)
  const title = source.find(
    (i) =>
      col(i) === 0 && /^(?:Patient|Subject|Case|Participant)\s+(?:no\.?|number|ID)$/i.test(i.text)
  )
  if (!title) return
  const labels = source.filter((i) => col(i) === 0 && /^\d+$/.test(i.text))
  if (labels.length < 8 || labels.some((i, n) => Number(i.text) !== n + 1)) return
  const borders = rules.filter(
    (r) => r[1] === r[3] && r[0] <= left + 12 && r[2] >= right - 12 && r[1] >= top && r[1] <= bottom
  )
  const sections = source.filter(
    (i) =>
      i.rect[0] >= cuts[1] &&
      i.rect[2] > cuts[2] &&
      /\p{L}/u.test(i.text) &&
      borders.some((r) => r[1] < i.baseline - i.height / 2 && i.rect[1] - r[1] < i.height) &&
      borders.some((r) => r[1] > i.baseline - i.height / 2 && r[1] - i.rect[3] < i.height)
  )
  if (
    sections.length < 2 ||
    sections.some((s) => Math.abs((s.rect[0] + s.rect[2] - left - right) / 2) > s.height * 2)
  )
    return
  // An empty enclosed section band means the source evidence is incomplete.
  const sectionBorders = [...borders].sort((a, b) => a[1] - b[1])
  if (
    sectionBorders.slice(1).some((r, n) => {
      const previous = sectionBorders[n][1]
      return (
        r[1] - previous > sections[0].height * 0.5 &&
        r[1] - previous < sections[0].height * 1.5 &&
        !source.some(
          (i) => (i.rect[1] + i.rect[3]) / 2 > previous && (i.rect[1] + i.rect[3]) / 2 < r[1]
        )
      )
    })
  )
    return
  const anchors = [...sections, ...labels].sort((a, b) => a.baseline - b.baseline)
  if (!sections.includes(anchors[0])) return
  const header = source.filter((i) => i.rect[3] < anchors[0].rect[1])
  const body = source.filter((i) => !header.includes(i))
  const ys = [anchors[0].rect[1] - 0.1, ...anchors.slice(1).map((i) => i.rect[1] - 0.1), bottom]
  const groups = anchors.map((_, n) =>
    body.filter(
      (i) => (i.rect[1] + i.rect[3]) / 2 >= ys[n] && (i.rect[1] + i.rect[3]) / 2 < ys[n + 1]
    )
  )
  if (!hasUniqueRecordTokens(body, groups)) return
  for (let n = 0; n < groups.length; n++) {
    const g = groups[n],
      anchor = anchors[n]
    if (sections.includes(anchor)) {
      if (g.length !== 1 || g[0] !== anchor) return
      continue
    }
    const cells = readSourceRow(g, cuts)
    if (!cells || cells[0] !== anchor.text || !cells.every(Boolean) || !/^\d+$/.test(cells[1]))
      return
    if (
      !predicted.every((_, c) =>
        g.some((i) => col(i) === c && Math.abs(i.baseline - anchor.baseline) < anchor.height * 0.3)
      )
    )
      return
    if (g.some((i) => col(i) > 1 && i.baseline > anchor.baseline + anchor.height * 1.5)) return
  }
  return {
    rows: [
      [left, union(header)[1], right, union(header)[3]],
      ...groups.map((_, n) => [left, ys[n], right, ys[n + 1]])
    ],
    columns: cuts.slice(1).map((x, n) => [cuts[n], top, x, bottom]),
    spans: sections.map((s) => ({
      row: anchors.indexOf(s) + 1,
      column: 0,
      rowSpan: 1,
      colSpan: predicted.length
    })),
    completeSpans: true
  }
}

// Two fully populated mean/deviation columns anchor wrapped descriptions.
// This narrow, ruled layout has no subtotal rows or missing measurements.
export function recoverPairedDeviationGrid(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (predicted.length !== 3) return
  const cuts = [
    left,
    ...predicted.slice(1).map((c, n) => left + (predicted[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const source = tableSourceItems(items, table.cropRect)
  const deviations = source.filter((i) => col(i) === 1 && i.text.includes('±'))
  if (deviations.length < 8) return
  const borders = rules
    .filter(
      (r) =>
        r[1] === r[3] && r[0] <= left + 12 && r[2] >= right - 12 && r[1] >= top && r[1] <= bottom
    )
    .sort((a, b) => a[1] - b[1])
  const divider = borders.findLast(
    (r) => r[1] < (deviations[0].rect[1] + deviations[0].rect[3]) / 2
  )
  const footer = borders.find((r) => r[1] > deviations.at(-1).rect[3])
  if (!divider || !footer) return
  const header = source.filter((i) => i.rect[3] <= divider[1])
  if (![1, 2].every((c) => header.some((i) => col(i) === c && /\p{L}/u.test(i.text)))) return
  const body = source.filter(
    (i) => (i.rect[1] + i.rect[3]) / 2 >= divider[1] && i.rect[3] <= footer[1]
  )
  const ys = [divider[1], ...deviations.slice(1).map((i) => i.rect[1] - 0.1), footer[1]]
  const records = deviations.map((_, n) =>
    body.filter(
      (i) => (i.rect[1] + i.rect[3]) / 2 >= ys[n] && (i.rect[1] + i.rect[3]) / 2 < ys[n + 1]
    )
  )
  if (!hasUniqueRecordTokens(body, records)) return
  for (let n = 0; n < records.length; n++) {
    const g = records[n],
      cells = readSourceRow(g, cuts),
      anchor = deviations[n]
    if (
      !cells ||
      !/\p{L}/u.test(cells[0]) ||
      !cells.slice(1).every((s) => /^\d+\.\d+±\d+\.\d+[*a-z]?$/.test(s))
    )
      return
    if (
      !g.some(
        (i) => col(i) === 0 && Math.abs(i.baseline - anchor.baseline) < anchor.height * 0.25
      ) ||
      g.some((i) => col(i) > 0 && Math.abs(i.baseline - anchor.baseline) > anchor.height * 0.6)
    )
      return
  }
  return {
    rows: [
      [left, union(header)[1], right, divider[1]],
      ...records.map((_, n) => [left, ys[n], right, ys[n + 1]])
    ],
    columns: cuts.slice(1).map((x, n) => [cuts[n], top, x, bottom]),
    spans: [],
    completeSpans: true
  }
}

// Repeated timepoints and F/P pairs have explicit native group underlines.
// Left-aligned child headers establish columns independently of duplicate or
// shifted model predictions. Reject any record that crosses those columns.
export function recoverRuledTimepointGrid(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const source = tableSourceItems(items, table.cropRect)
  const children = source
    .filter((i) => /^(?:T\d+|F|P)$/.test(i.text))
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (
    children.length < 8 ||
    children.some((i) => Math.abs(i.baseline - children[0].baseline) > i.height * 0.2)
  )
    return
  const height = children[0].height
  const underlines = rules
    .filter(
      (r) =>
        r[1] === r[3] &&
        r[1] < children[0].rect[1] &&
        children[0].rect[1] - r[1] < height &&
        r[0] >= left &&
        r[2] <= right
    )
    .sort((a, b) => a[0] - b[0])
  const groups = underlines.map((r) =>
    children.filter((i) => i.rect[0] >= r[0] - 0.1 && i.rect[2] <= r[2] + 0.1)
  )
  const timepoints = groups.filter((g) => g.length >= 2 && g.every((i, n) => i.text === `T${n}`))
  if (
    timepoints.length < 2 ||
    !timepoints.every((g) => g.length === timepoints[0].length) ||
    groups.length <= timepoints.length ||
    groups.some((g) => !timepoints.includes(g) && g.map((i) => i.text).join(',') !== 'F,P') ||
    !hasUniqueRecordTokens(children, groups)
  )
    return
  const cuts = [left, ...children.map((i) => i.rect[0] - height * 0.1), right]
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const divider = rules.find(
    (r) =>
      r[1] === r[3] &&
      r[1] > children[0].baseline &&
      r[1] - children[0].baseline < height &&
      r[0] <= cuts[1] + height &&
      r[2] >= right - 12
  )
  if (!divider) return
  const body = source.filter((i) => i.rect[1] > divider[1])
  const anchors = body.filter((i) => col(i) === 1 && /^\d+(?:\.\d+)?$/.test(i.text))
  // A mean and its deviation occupy the same baseline; keep one row anchor.
  const lines = anchors.filter(
    (i, n) => !n || Math.abs(i.baseline - anchors[n - 1].baseline) > height * 0.3
  )
  if (lines.length < 4) return
  const borders = [divider[1], ...lines.slice(1).map((i) => i.rect[1] - height * 0.1), bottom]
  const records = lines.map((_, n) =>
    body.filter((i) => i.rect[1] >= borders[n] && i.rect[3] <= borders[n + 1])
  )
  if (!hasUniqueRecordTokens(body, records)) return
  const timeColumns = new Set(timepoints.flat().map((i) => children.indexOf(i) + 1))
  for (const record of records) {
    const values = readSourceRow(record, cuts)
    if (
      !values ||
      !/\p{L}/u.test(values[0]) ||
      values
        .slice(1)
        .some(
          (v, n) =>
            !(
              timeColumns.has(n + 1)
                ? /^\d+(?:\.\d+)?±\d+(?:\.\d+)?$/
                : /^(?:\d+(?:\.\d+)?|\*{1,3})$/
            ).test(v)
        )
    )
      return
  }
  const headerBottom = Math.max(...underlines.map((r) => r[1]))
  const parent = source.filter((i) => i.rect[3] <= headerBottom && i.rect[0] >= cuts[1])
  const spans = [{ row: 0, column: 0, rowSpan: 2, colSpan: 1 }]
  for (const group of groups) {
    const c = children.indexOf(group[0]) + 1
    if (!parent.some((i) => i.rect[0] >= cuts[c] && i.rect[2] <= cuts[c + group.length])) return
    spans.push({ row: 0, column: c, rowSpan: 1, colSpan: group.length })
  }
  if (
    parent.some(
      (i) =>
        !spans
          .slice(1)
          .some((s) => i.rect[0] >= cuts[s.column] && i.rect[2] <= cuts[s.column + s.colSpan])
    )
  )
    return
  return {
    rows: [
      [left, top, right, headerBottom],
      [left, headerBottom, right, divider[1]],
      ...lines.map((_, n) => [left, borders[n], right, borders[n + 1]])
    ],
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans,
    completeSpans: true
  }
}

// A unique code and a scalar value identify each record even when later
// columns contain several measurement lines. Native rules bound the body;
// no model row or inferred scientific value establishes record ownership.
export function recoverCodedRecordGrid(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (predicted.length < 5 || predicted.length > 10) return
  const cuts = [
    left,
    ...predicted.slice(1).map((c, n) => left + (predicted[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const source = tableSourceItems(items, table.cropRect)
  const code = source.find((i) => i.text === 'Code' && col(i) === 1)
  if (!code) return
  const edges = rules
    .filter(
      (r) =>
        r[1] === r[3] &&
        r[0] <= left + 12 &&
        r[2] >= right - 12 &&
        r[1] > code.baseline &&
        r[1] <= bottom
    )
    .sort((a, b) => a[1] - b[1])
  if (edges.length !== 2 || edges[0][1] - code.baseline > code.height * 3) return
  const body = source.filter((i) => i.rect[1] > edges[0][1] && i.rect[3] < edges[1][1])
  const anchors = body.filter((i) => col(i) === 1)
  if (
    anchors.length < 6 ||
    new Set(anchors.map((a) => a.text)).size !== anchors.length ||
    anchors.some(
      (a, n) =>
        !/^[A-Z][A-Z0-9]{0,9}$/.test(a.text) ||
        (n && a.baseline - anchors[n - 1].baseline < a.height * 1.5)
    )
  )
    return
  const borders = [
    edges[0][1],
    ...anchors.slice(1).map((a) => a.rect[1] - a.height * 0.15),
    edges[1][1]
  ]
  const records = anchors.map((_, n) =>
    body.filter((i) => i.rect[1] >= borders[n] && i.rect[3] <= borders[n + 1])
  )
  if (!hasUniqueRecordTokens(body, records)) return
  let wrapped = 0
  for (const [n, record] of records.entries()) {
    if (!readSourceRow(record, cuts)) return
    const anchor = anchors[n]
    const aligned = (i) => Math.abs(i.baseline - anchor.baseline) < anchor.height * 0.3
    const scalar = record.filter((i) => col(i) === 2)
    const labels = record.filter((i) => col(i) === 0)
    if (
      scalar.length !== 1 ||
      !/^\d+(?:\.\d+)?$/.test(scalar[0].text) ||
      !aligned(scalar[0]) ||
      !labels.some((i) => aligned(i) && /\p{L}/u.test(i.text)) ||
      !record.some((i) => col(i) >= 3 && aligned(i) && /\d/.test(i.text))
    )
      return
    const tails = labels.filter((i) => !aligned(i))
    if (
      tails.length &&
      !labels.some((i) => aligned(i) && /-$/.test(i.text)) &&
      !tails.every((i) => /^\([^()]+\)$/.test(i.text))
    )
      return
    if (record.some((i) => col(i) >= 3 && i.baseline > anchor.baseline + anchor.height)) wrapped++
  }
  if (wrapped < 3) return
  return {
    rows: [
      [left, top, right, edges[0][1]],
      ...anchors.map((_, n) => [left, borders[n], right, borders[n + 1]])
    ],
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans: [],
    completeSpans: true
  }
}

// Enrichment tables place two scientific-notation probabilities and two counts
// beside indented, sometimes wrapped pathway labels. The label indentation
// bounds each record independently of the model's fragmented row predictions.
export function recoverEnrichmentGrid(table, items, captions) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (predicted.length !== 5) return
  const cuts = [
    left,
    ...predicted.slice(1).map((c, n) => left + (predicted[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const source = tableSourceItems(items, table.cropRect)
  const fdr = source.find((i) => /^FDR-Adj\./i.test(i.text))
  if (!fdr || col(fdr) !== 2) return
  const note = source.find((i) => /^Notes?\s*:/i.test(i.text))
  const body = source.filter(
    (i) => i.baseline > fdr.baseline + fdr.height * 0.5 && (!note || i.rect[3] < note.rect[1])
  )
  const science = (text) => /^\d+(?:\.\d+)?E[-+−]\d+$/i.test(text)
  const anchors = body.filter((i) => col(i) === 1 && science(i.text))
  if (anchors.length < 6) return
  const numericLabels = body.filter(
    (i) => col(i) === 0 && anchors.some((a) => Math.abs(a.baseline - i.baseline) < fdr.height * 0.3)
  )
  if (!numericLabels.length) return
  const indent = Math.min(...numericLabels.map((i) => i.rect[0]))
  const labels = body.filter((i) => col(i) === 0 && i.rect[0] <= indent + fdr.height * 0.15)
  if (!labels.length || labels.some((i, n) => n && i.rect[1] <= labels[n - 1].rect[3])) return
  const bands = labels.map((label, n) => [
    left,
    label.rect[1] - 0.1,
    right,
    labels[n + 1] ? labels[n + 1].rect[1] - 0.1 : Math.max(...body.map((i) => i.rect[3])) + 0.1
  ])
  const spans = []
  let records = 0
  for (const [n, band] of bands.entries()) {
    const group = body.filter((i) => i.rect[1] >= band[1] && i.rect[3] <= band[3])
    const values = [1, 2, 3, 4].map((c) => group.filter((i) => col(i) === c))
    if (values.every((v) => !v.length)) {
      if (labels[n].rect[0] >= indent - fdr.height * 0.2) return
      spans.push({ row: n + 1, column: 0, rowSpan: 1, colSpan: 5 })
    } else {
      if (
        values.some(
          (v, c) => v.length !== 1 || !(c < 2 ? science(v[0].text) : /^\d+$/.test(v[0].text))
        )
      )
        return
      if (values.some((v) => Math.abs(v[0].baseline - values[0][0].baseline) > fdr.height * 0.3))
        return
      records++
    }
    if (group.some((i) => i.rect[0] < cuts[col(i)] || i.rect[2] > cuts[col(i) + 1])) return
  }
  if (
    records !== anchors.length ||
    body.some((i) => !bands.some((r) => i.rect[1] >= r[1] && i.rect[3] <= r[3]))
  )
    return
  return {
    rows: [[left, top, right, bands[0][1]], ...bands],
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans,
    completeSpans: true
  }
}

// Repeated outcome blocks have explicit measurement labels and the same value
// columns in every block. Rebuild their row bands only when every body line is
// accounted for; model spans must not flatten a measurement into a section.
export function recoverAlignedNumericGrid(table, items, captions, rules = []) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  for (let n = predicted.length - 1; n > 0; n--)
    if (
      intersect(predicted[n].rect, predicted[n - 1].rect) /
        Math.min(area(predicted[n].rect), area(predicted[n - 1].rect)) >
      0.7
    )
      predicted.splice((predicted[n].score ?? 1) > (predicted[n - 1].score ?? 1) ? n - 1 : n, 1)
  if (predicted.length < 5 || predicted.length > 16) return
  const cuts = [
    left,
    ...predicted.slice(1).map((c, n) => left + (predicted[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  let source = items.filter(
    (i) =>
      i.horizontal &&
      i.rect[0] >= left &&
      i.rect[2] <= right &&
      i.rect[1] >= top &&
      i.rect[3] <= bottom
  )
  // Some PDF superscripts retain a full-size font box. A letter immediately
  // following a decimal value belongs to that value's baseline, not a new row.
  source = source.map((i) => {
    if (!/^[a-d]$/.test(i.text)) return i
    const value = source.find(
      (v) =>
        /^(?:\d+)?\.\d+$/.test(v.text) &&
        Math.abs(v.rect[2] - i.rect[0]) < 0.5 &&
        i.baseline < v.baseline &&
        v.baseline - i.baseline <= v.height * 0.7
    )
    return value ? { ...i, baseline: value.baseline, height: Math.min(i.height, value.height) } : i
  })
  const groups = []
  for (const item of [...source].sort(
    (a, b) => b.height - a.height || a.baseline - b.baseline || a.rect[0] - b.rect[0]
  )) {
    const group = groups.find(
      (g) => Math.abs(g[0].baseline - item.baseline) < Math.max(g[0].height, item.height) * 0.5
    )
    if (group) group.push(item)
    else groups.push([item])
  }
  groups.sort((a, b) => a[0].baseline - b[0].baseline)
  const cells = (g) =>
    predicted.map((_, c) =>
      g
        .filter((i) => col(i) === c)
        .sort((a, b) => a.rect[0] - b.rect[0])
        .map((i) => i.text)
        .join(' ')
        .trim()
    )
  const compact = (s) => s.replace(/\s/g, '')
  const timepoint = (s) => /^(?:Baseline|End-?trial|Change|P-value)[a-d*]*$/i.test(compact(s))
  const groupLabel = (s) => /^(?:Exercise|Control|Total|Pilates|Dance)$/.test(s)
  const countRows = groups.filter((g) => {
    const text = cells(g)
    return (
      /\p{L}/u.test(text[0]) &&
      text.slice(1).filter((v) => /^(?:\d+(?:[.,]\d+)?\s*\(\d+(?:[.,]\d+)?%?\)|0)$/.test(v))
        .length >= 2 &&
      text.slice(1).filter((v) => /^\d/.test(v)).length >= 3
    )
  })
  const categorical =
    countRows.length >= 10 &&
    (groups
      .slice(0, 3)
      .some((g) =>
        /^(?:Variables|Characteristics?|Assessments compared to baseline)$/i.test(cells(g)[0])
      ) ||
      groups.slice(0, 3).some(
        (g) =>
          cells(g)
            .slice(1)
            .filter((v) =>
              /group|^(?:Total|Control|Intervention|Synchronous|Sequential|Overall)\b/i.test(v)
            ).length >= 3
      ))
  // Repeated n (%) headings can extend beyond narrow numeric column bounds.
  // Move only a boundary in the whitespace between complete neighbouring labels,
  // and only if every body token retains its original column.
  if (categorical) {
    for (const g of groups.slice(0, 3)) {
      const ordered = [...g].sort((a, b) => a.rect[0] - b.rect[0])
      if (ordered.filter((i) => i.text === '(%)').length < 3) continue
      for (let n = 2; n < ordered.length - 1; n++) {
        if (ordered[n].text !== '(%)' || ordered[n - 1].text !== 'n') continue
        const anchor = ordered[n - 2],
          next = ordered[n + 1],
          c = col(anchor)
        if (c < 1 || col(next) !== c + 1 || next.rect[0] - ordered[n].rect[2] < anchor.height)
          continue
        const cut = (ordered[n].rect[2] + next.rect[0]) / 2
        if (
          source.some(
            (i) =>
              i.baseline > g[0].baseline + anchor.height &&
              (i.rect[0] + i.rect[2]) / 2 > Math.min(cuts[c + 1], cut) &&
              (i.rect[0] + i.rect[2]) / 2 < Math.max(cuts[c + 1], cut)
          )
        )
          continue
        cuts[c + 1] = cut
      }
    }
  }
  const paired =
    predicted.length === 6 &&
    groups.filter((g) => /^(?:Control|Intervention)$/.test(cells(g)[0])).length >= 20 &&
    groups.filter((g) => /^Day \d+$/.test(cells(g)[0])).length >= 3 &&
    groups.slice(0, 3).some((g) => cells(g).slice(-3).join(' ').trim() === 't df p')
  const deviation =
    predicted.length >= 7 &&
    groups.filter(
      (g) =>
        cells(g)
          .slice(1)
          .filter((v) => /±/.test(v)).length >= 3
    ).length >= 8
  const labelled = categorical || deviation || paired
  const stub = labelled
    ? 0
    : groups.filter((g) => timepoint(cells(g)[0])).length >= 8
      ? 0
      : groups.filter((g) => groupLabel(cells(g)[1])).length >= 12
        ? 1
        : -1
  if (stub < 0) return
  const numeric = (s) => /^[<>≤≥−+-]?(?:\d|\.\d)[\d\s.,()%±*–−+\-/]*[a-d*]*$/.test(compact(s))
  const isRecord = (g) =>
    labelled
      ? /\p{L}/u.test(cells(g)[0]) &&
        cells(g)
          .slice(1)
          .filter((s) => numeric(s) || /^[-–—]$/.test(s)).length >= (paired ? 2 : 3)
      : (stub ? groupLabel : timepoint)(cells(g)[stub])
  const firstRecord = groups.findIndex(isRecord)
  if (firstRecord < 1) return
  const headerEnd = groups.findLastIndex(
    (g, n) =>
      n < firstRecord &&
      cells(g)
        .slice(stub + 1)
        .filter((s) => /[a-z]/i.test(s)).length >= 3
  )
  if (headerEnd < 0 || headerEnd >= firstRecord) return
  const wideSection = (g) =>
    !stub &&
    Math.min(...g.map((i) => i.rect[0])) < cuts[1] &&
    /\p{L}/u.test(g.map((i) => i.text).join(' ')) &&
    g.every((i) => !/^[<>≤≥−+-]?\d/.test(i.text) && i.rect[2] < cuts.at(-2))
  // The first outcome is a stub-only line after column headings/units.
  let firstSection = groups.findIndex(
    (g, n) =>
      n > headerEnd &&
      n < firstRecord &&
      (wideSection(g) ||
        (/\p{L}/u.test(cells(g)[0]) &&
          cells(g)
            .slice(1, stub ? 6 : undefined)
            .every((s) => !s)))
  )
  if (firstSection < 0 && labelled) firstSection = firstRecord
  if (firstSection < 0 && /continued/i.test(captions.map((c) => c.lines.join(' ')).join(' ')))
    firstSection = firstRecord
  if (firstSection < 0) return
  const body = groups.slice(firstSection)
  const records = [],
    spans = []
  let measures = 0,
    sections = 0
  for (const group of body) {
    const text = cells(group)
    if (/^\(?continuedonnextpage\)?$/i.test(compact(text.join(' ')))) break
    if (/^(?:Notes?\s*:|Abbreviations?\s*:)/i.test(text.join(' ').trim())) break
    const previous = body[body.indexOf(group) - 1]
    if (
      labelled &&
      previous &&
      (!text[0] || (deviation && /^[a-z]/.test(text[0]))) &&
      text.slice(1).some(Boolean) &&
      text
        .slice(1)
        .every(
          (v, n) =>
            !v ||
            (/^\(\d[\d.,%]*\)$/.test(compact(v)) &&
              /^\d[\d.,]*$/.test(compact(cells(previous)[n + 1]))) ||
            (deviation &&
              /^\d[\d.,]*$/.test(compact(v)) &&
              /±$/.test(compact(cells(previous)[n + 1])))
        ) &&
      group[0].baseline - previous[0].baseline <= group[0].height * 1.8 &&
      records.length
    ) {
      records.at(-1)[3] = Math.max(records.at(-1)[3], union(group)[3])
      continue
    }
    if (
      deviation &&
      records.length &&
      group.every((i) => i.height < body[0][0].height * 0.8) &&
      rules.some(
        (r) =>
          r[1] === r[3] &&
          r[1] >= records.at(-1)[3] &&
          r[1] < union(group)[1] &&
          r[2] - r[0] > (right - left) * 0.9
      )
    )
      break
    if (
      categorical &&
      !text[0] &&
      text.slice(1).filter(Boolean).length >= 3 &&
      text.slice(1).every((s) => !s || /^n\s*\(%\)$/i.test(s))
    ) {
      records.push(union(group))
      continue
    }
    if (isRecord(group)) {
      const values = text.slice(stub + 1).filter(Boolean)
      if (
        values.length < (paired ? 2 : 3) ||
        !values.every(
          (s) =>
            numeric(s) || ((categorical || paired) && /^(?:\(\d[\d.,]*\)|[-–—])$/.test(compact(s)))
        )
      )
        return
      measures++
    } else {
      if (
        !wideSection(group) &&
        (!/\p{L}/u.test(text[0]) ||
          text[0].length > 100 ||
          text.slice(1, stub ? 6 : categorical ? -1 : undefined).some(Boolean) ||
          (stub && text.slice(6).some((s) => s && !numeric(s))) ||
          (categorical && text.at(-1) && !numeric(text.at(-1))))
      )
        return
      if (
        /^[a-z]/.test(text[0]) &&
        text.slice(1).every((s) => !s) &&
        records.length &&
        !isRecord(body[body.indexOf(group) - 1]) &&
        group[0].baseline - body[body.indexOf(group) - 1][0].baseline < group[0].height * 1.6
      ) {
        records.at(-1)[3] = Math.max(records.at(-1)[3], union(group)[3])
        continue
      }
      sections++
      if (wideSection(group) || !text.slice(1).some(Boolean))
        spans.push({ row: records.length, column: 0, rowSpan: 1, colSpan: predicted.length })
    }
    records.push(union(group))
  }
  if (measures < 8 || sections < 2) return
  const heading = groups.slice(0, firstSection)
  // Keep each original header baseline; only a units-only line spans the values.
  const unit = heading.find(
    (g) =>
      !cells(g)[0] &&
      cells(g).filter(Boolean).length === 1 &&
      /Mean.*SD|%.*N/i.test(cells(g).join(' '))
  )
  const header = union(heading.filter((g) => g !== unit).flat())
  const rows = [[left, header[1], right, header[3]]]
  if (unit) {
    const r = union(unit)
    rows.push([left, r[1], right, r[3]])
  }
  if ((deviation || categorical) && !unit && heading.length > 1) {
    const parent = heading[0],
      parentRect = union(parent)
    const brackets = rules.filter(
      (r) =>
        r[1] === r[3] &&
        r[1] > parentRect[3] &&
        r[1] < header[3] &&
        r[0] >= left - 2 &&
        r[2] <= right + 2
    )
    const parentSpans = brackets.flatMap((r) => {
      const labels = parent
        .filter((i) => i.rect[0] >= r[0] - 1 && i.rect[2] <= r[2] + 1)
        .sort((a, b) => a.rect[0] - b.rect[0])
      // A full-width header rule can underline several independent column
      // labels. Only a contiguous label establishes a parent spanning them.
      if (
        labels.some(
          (i, n) =>
            n && i.rect[0] - labels[n - 1].rect[2] > Math.max(i.height, labels[n - 1].height) * 1.5
        )
      )
        return []
      // An inset underline may follow the outer child glyphs rather than the
      // model gutters. Require complete child ownership and both matching text
      // edges before preferring those columns over approximate cut distances.
      const children = heading
        .slice(1)
        .flat()
        .filter((i) => i.rect[1] > r[1])
      const covered = children.filter((i) => i.rect[0] >= r[0] - 1 && i.rect[2] <= r[2] + 1)
      const childColumns = [...new Set(covered.map(col))].sort((a, b) => a - b)
      const textEdges =
        labels.length > 0 &&
        childColumns.length >= 2 &&
        childColumns.at(-1) - childColumns[0] + 1 === childColumns.length &&
        labels.every((i) => childColumns.includes(col(i))) &&
        Math.abs(Math.min(...covered.map((i) => i.rect[0])) - r[0]) <= 2 &&
        Math.abs(Math.max(...covered.map((i) => i.rect[2])) - r[2]) <= 2 &&
        children.filter((i) => childColumns.includes(col(i))).every((i) => covered.includes(i)) &&
        covered.every((i) => i.rect[0] >= cuts[col(i)] && i.rect[2] <= cuts[col(i) + 1])
      const c = textEdges ? childColumns[0] : cuts.findIndex((x) => x >= r[0] - 12)
      const end = textEdges ? childColumns.at(-1) + 1 : cuts.findLastIndex((x) => x <= r[2] + 12)
      return c >= 0 && end > c && parent.some((i) => i.rect[0] >= r[0] - 1 && i.rect[2] <= r[2] + 1)
        ? [{ row: 0, column: c, rowSpan: 1, colSpan: end - c }]
        : []
    })
    if (
      categorical &&
      !parentSpans.length &&
      cells(parent).filter(Boolean).length >= 3 &&
      brackets.some((r) => r[2] - r[0] > (right - left) * 0.9)
    ) {
      const split = Math.max(...brackets.map((r) => r[1]))
      rows.splice(0, rows.length, [left, header[1], right, split], [left, split, right, header[3]])
    }
    if (parentSpans.length >= (categorical ? 1 : 2)) {
      const split = categorical
        ? Math.max(...brackets.map((r) => r[1]))
        : (parentRect[3] + union(heading[1])[1]) / 2
      rows.splice(0, rows.length, [left, header[1], right, split], [left, split, right, header[3]])
      spans.push(...parentSpans.map((span) => ({ ...span, header: true })))
      for (let c = 0; c < predicted.length; c++) {
        if (
          parent.some((i) => col(i) === c) &&
          (categorical ||
            !heading
              .slice(1)
              .flat()
              .some((i) => col(i) === c)) &&
          !parentSpans.some((span) => c >= span.column && c < span.column + span.colSpan)
        )
          spans.push({ row: 0, column: c, rowSpan: 2, colSpan: 1, header: true })
      }
    }
  }
  const headerCount = rows.length
  for (const span of spans) if (!span.header) span.row += headerCount
  if (unit)
    spans.push({
      row: 1,
      column: 1,
      rowSpan: 1,
      colSpan:
        predicted.length -
        1 -
        Number(heading.some((g) => /^p-?value$/i.test(compact(cells(g).at(-1)))))
    })
  rows.push(...records.map((r) => [left, r[1], right, r[3]]))
  // No two unrelated body baselines may claim the same glyph center.
  for (let n = 1; n < rows.length; n++) {
    const boundary = (rows[n - 1][3] + rows[n][1]) / 2
    rows[n - 1][3] = boundary
    rows[n][1] = boundary
  }
  if (
    source.some((i) => {
      const c = col(i)
      return (
        c < 0 ||
        (i.rect[1] >= rows[headerCount][1] &&
          i.rect[1] <= rows.at(-1)[3] &&
          !body.some((g) => g.includes(i) && wideSection(g)) &&
          c > 0 &&
          (i.rect[0] < cuts[c] - 1 || i.rect[2] > cuts[c + 1] + 1))
      )
    })
  )
    return
  return {
    rows,
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans,
    completeSpans: true
  }
}

// Wrapped definitions and repeated OR/CI comparisons have left-aligned record
// labels even when estimates are vertically centered between label lines.
export function recoverAnchoredStubGrid(table, items, captions) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (![2, 5].includes(predicted.length)) return
  const cuts = [
    left,
    ...predicted.slice(1).map((c, n) => left + (predicted[n].rect[2] + c.rect[0]) / 2),
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
  const odds = source.filter((i) => /^OR\s*\(CI\s*95%\)$/i.test(i.text))
  if (predicted.length === 5 && odds.length !== 2) return
  const first = source.filter((i) => col(i) === 0).sort((a, b) => a.baseline - b.baseline)[0]
  if (!first) return
  const headerEnd = odds.length ? Math.max(...odds.map((i) => i.baseline)) : first.baseline
  const note = source.find((i) => /^Notes?\s*:/i.test(i.text))
  const body = source.filter(
    (i) => i.baseline > headerEnd + 1 && (!note || i.rect[3] < note.rect[1])
  )
  const labels = body
    .filter(
      (i) =>
        col(i) === 0 &&
        i.height >= first.height * 0.8 &&
        Math.abs(i.rect[0] - first.rect[0]) <= 1 &&
        /^[A-Z]/.test(i.text)
    )
    .sort((a, b) => a.baseline - b.baseline)
  if (
    labels.length < 8 ||
    labels.some((i, n) => n && i.baseline - labels[n - 1].baseline < i.height)
  )
    return
  const borders = [
    labels[0].rect[1] - 0.1,
    ...labels.slice(1).map((i) => i.rect[1] - 0.1),
    Math.max(...body.map((i) => i.rect[3])) + 0.1
  ]
  const records = labels.map((_, n) =>
    body.filter(
      (i) =>
        (i.rect[1] + i.rect[3]) / 2 >= borders[n] && (i.rect[1] + i.rect[3]) / 2 < borders[n + 1]
    )
  )
  if (records.some((g) => !g.length)) return
  const value = (g, c) =>
    g
      .filter((i) => col(i) === c)
      .map((i) => i.text)
      .join(' ')
  if (odds.length) {
    if (
      records.filter((g) => /\d+\.\d+\s*\(/.test(value(g, 1))).length < 6 ||
      records.some((g) => g.some((i) => col(i) > 0 && !/^[\d\s.,();−+–-]+$/.test(i.text)))
    )
      return
  } else {
    const definitions =
      /^Term$/i.test(first.text) &&
      source.some(
        (i) =>
          col(i) === 1 &&
          /^Definition$/i.test(i.text) &&
          Math.abs(i.baseline - first.baseline) < first.height * 0.25
      )
    if (
      records.filter((g) => value(g, 1).length > 25 && /\p{L}/u.test(value(g, 1))).length < 6 ||
      (!definitions && records.filter((g) => !value(g, 1)).length < 2) ||
      (!definitions &&
        records.filter((g) => g.filter((i) => col(i) === 0).length > 1).length < 3) ||
      (definitions && records.some((g) => !value(g, 1))) ||
      records.some((g) => value(g, 1) && /^\d/.test(value(g, 1)))
    )
      return
  }
  const head = source.filter((i) => i.baseline <= headerEnd + 1)
  const header = union(head)
  const rows = [
    [left, header[1], right, header[3]],
    ...labels.map((_, n) => [left, borders[n], right, borders[n + 1]])
  ]
  const spans = []
  if (odds.length) {
    const parents = head.filter((i) => i.baseline < Math.min(...odds.map((i) => i.rect[1])))
    if (parents.length !== 2 || !parents.every((i) => /^(?:Uni|Multi)variate$/i.test(i.text)))
      return
    const split =
      (Math.max(...parents.map((i) => i.rect[3])) + Math.min(...odds.map((i) => i.rect[1]))) / 2
    rows.splice(0, 1, [left, header[1], right, split], [left, split, right, header[3]])
    for (const i of parents) {
      const c = col(i)
      if (![1, 3].includes(c)) return
      spans.push({ row: 0, column: c, colSpan: 2, rowSpan: 1 })
    }
  } else
    records.forEach((g, n) => {
      if (!value(g, 1)) spans.push({ row: n + 1, column: 0, colSpan: 2, rowSpan: 1 })
    })
  return {
    rows,
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans,
    completeSpans: true
  }
}

// A short explicitly continued table may have one record and no model rows.
// Three complete rules and separate textual header runs establish the grid;
// blank statistic cells remain blank, without borrowing values from another page.
export function recoverSingleRowContinuation(table, items, captions, rules) {
  if (table.structure.objects.some((o) => o.label === 'table row')) return
  const [left, top, right, bottom] = table.cropRect
  if (
    !captions.some(
      (c) =>
        /^Table\s+\d+\.?\s*\(continued\)$/i.test(c.lines.join(' ')) &&
        c.rect[3] <= top &&
        top - c.rect[3] < 30 &&
        Math.abs(c.rect[0] - left) < 20
    )
  )
    return
  const borders = rules
    .filter(
      (r) =>
        r[1] === r[3] &&
        r[1] >= top &&
        r[1] <= bottom &&
        Math.abs(r[0] - left) < 15 &&
        Math.abs(r[2] - right) < 15
    )
    .sort((a, b) => a[1] - b[1])
  if (borders.length !== 3) return
  const source = tableSourceItems(items, table.cropRect)
  const head = source.filter((i) => i.rect[1] >= borders[0][1] && i.rect[3] <= borders[1][1])
  const body = source.filter((i) => i.rect[1] >= borders[1][1] && i.rect[3] <= borders[2][1])
  if (head.length < 4 || body.length < 3 || source.length !== head.length + body.length) return
  if (
    [head, body].some(
      (g) => Math.max(...g.map((i) => i.baseline)) - Math.min(...g.map((i) => i.baseline)) > 1
    )
  )
    return
  const runs = []
  for (const item of [...head].sort((a, b) => a.rect[0] - b.rect[0])) {
    const last = runs.at(-1)
    if (last && item.rect[0] - last.at(-1).rect[2] < item.height * 1.5) last.push(item)
    else runs.push([item])
  }
  if (runs.length < 4 || runs.length > 10 || runs.some((g) => !/^\p{L}/u.test(g[0].text))) return
  const cuts = [
    left,
    ...runs.slice(1).map((g, n) => (runs[n].at(-1).rect[2] + g[0].rect[0]) / 2),
    right
  ]
  const values = readSourceRow(body, cuts)
  if (
    !values ||
    !/^(?:[+−-]|[\p{L}\d ]+)$/u.test(values[0]) ||
    values.slice(1).filter(Boolean).length < 2 ||
    values.slice(1).some((v) => v && !/^\d+(?:\.\d+)?(?:\(\d+(?:\.\d+)?%?\))?$/.test(v))
  )
    return
  // Left-aligned labels and values must agree with their source header anchors.
  if (
    body.some((i) => {
      const c = cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
      return Math.abs(i.rect[0] - runs[c][0].rect[0]) > i.height * 0.4
    })
  )
    return
  return {
    rows: [
      [left, borders[0][1], right, borders[1][1]],
      [left, borders[1][1], right, borders[2][1]]
    ],
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans: [],
    completeSpans: true
  }
}
