/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { hasHorizontalTableRuleBetween } from './literature-pdf-table-rules.mjs'
import { captionKind } from './literature-pdf-caption-group.mjs'
import { union } from './literature-pdf-table-geometry.mjs'
import {
  tableSourceItems,
  readSourceRow,
  hasUniqueRecordTokens,
  groupSourceRowsWithScripts
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
  if (deviations.length < 8)
    return recoverMixedClinicalRecords({ source, cuts, top, bottom, rules })
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
  const sharedTests = recoverSharedClinicalStatistics(table, items, captions, rules)
  if (sharedTests) return sharedTests
  const followup = recoverDatedFollowupColumns(table, items, captions, rules)
  if (followup) return followup
  const quartiles = recoverQuartileComparisonGrid(table, items, captions, rules)
  if (quartiles) return quartiles

  const adherence = recoverAdherenceDistributionGrid(table, items, captions)
  if (adherence) return adherence
  const clinical = recoverClinicalTimepointGrid(table, items, captions, rules)
  if (clinical) return clinical
  const mixed = recoverMixedCohortGrid(table, items, captions)
  if (mixed) return mixed
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
  if (predicted.length < 4 || predicted.length > 16) return
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
  const compact = (s) => s.replace(/[\s"“”]/g, '')
  const timepoint = (s) =>
    /^(?:Baseline|End-?trial|Change|P-value|T[01]|(?:Beginning|End)ofrehabilitation|3monthsafterrehabilitation|Basal\(T1\)|After[123](?:st|nd|rd)NMT\(T[123]\)|Arrival(?:1st|5nd)week\(T[23]\))[a-d*]*$/i.test(
      compact(s)
    )
  const groupLabel = (s) => /^(?:Exercise|Control|Total|Pilates|Dance)$/.test(s)
  const countRows = groups.filter((g) => {
    const text = cells(g)
    return (
      /\p{L}/u.test(text[0]) &&
      text
        .slice(1)
        .filter((v) =>
          /^(?:\d+(?:[.,]\d+)?\s*\(\d+(?:[.,]\d+)?%?\)|\d+(?:[.,]\d+)?\s*%(?:\s*\(\d+\/\d+\))?|0)$/.test(
            v
          )
        ).length >= 2 &&
      text.slice(1).filter((v) => /^\d/.test(v)).length >= (predicted.length === 4 ? 2 : 3)
    )
  })
  const categorical =
    countRows.length >= 10 &&
    ((predicted.length === 7 &&
      groups.slice(0, 4).some((g) => /^p$/i.test(cells(g)[3]) && /^p$/i.test(cells(g)[6])) &&
      groups
        .slice(0, 4)
        .some((g) => cells(g).filter((v) => /\banalysis$/i.test(v)).length === 2)) ||
      groups.slice(0, 4).some(
        (g) =>
          predicted.length === 4 &&
          /^p$/i.test(cells(g).at(-1)) &&
          cells(g)
            .slice(1, 3)
            .every((v) => /n\s*\(%\)/i.test(v))
      ) ||
      groups
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
      ) ||
      (groups.slice(0, 3).some((g) => /^p\s*value$/i.test(cells(g).at(-1))) &&
        groups.slice(0, 3).some(
          (g) =>
            cells(g)
              .slice(1, -1)
              .filter((s) => /\p{L}/u.test(s)).length >= 3
        )))
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
  const repeatedTimes = groups.filter((g) => timepoint(cells(g)[0])).length >= 12
  const sparseMeasures =
    repeatedTimes &&
    predicted.length === 5 &&
    groups.slice(0, 5).some((g) => cells(g).filter((v) => /^F\(p\)$/.test(compact(v))).length === 2)
  const minimumValues = paired || repeatedTimes || (categorical && predicted.length === 4) ? 2 : 3
  const labelled = categorical || deviation || paired
  const stub = labelled
    ? 0
    : groups.filter((g) => timepoint(cells(g)[0])).length >= 8
      ? 0
      : groups.filter((g) => groupLabel(cells(g)[1])).length >= 12
        ? 1
        : -1
  if (stub < 0) return
  const numeric = (s) => /^[<>≤≥−+-]?(?:\d|\.\d)[\d\s.,;()%±*–−+\-/]*[a-d*]*$/.test(compact(s))
  const isRecord = (g) =>
    labelled
      ? Boolean(cells(g)[0]) &&
        cells(g)
          .slice(1)
          .filter((s) => numeric(s) || /^[-–—]$/.test(s)).length >= minimumValues
      : (stub ? groupLabel : timepoint)(cells(g)[stub])
  const firstRecord = groups.findIndex(isRecord)
  if (firstRecord < 1) return
  const headerEnd = groups.findLastIndex(
    (g, n) =>
      n < firstRecord &&
      cells(g)
        .slice(stub + 1)
        .filter((s) => /[a-z]/i.test(s)).length >= (predicted.length === 4 ? 2 : 3)
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
            .slice(1, stub ? 6 : categorical ? -1 : undefined)
            .every((s, c) => !s || (sparseMeasures && [1, 3].includes(c) && numeric(s)))))
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
    if (
      /^Bold indicates a significance level of\s+p\s*[<≤]\s*0?\.\d+\.?$/i.test(
        text.join(' ').trim()
      )
    )
      break
    if (
      measures >= 8 &&
      records.length &&
      group.every((i) => i.height < body[0][0].height * 0.9) &&
      rules.some(
        (r) =>
          r[1] === r[3] &&
          r[1] >= records.at(-1)[3] &&
          r[1] < union(group)[1] &&
          r[2] - r[0] > (right - left) * 0.9
      )
    )
      break
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
            (/^\(\d[\d.,%/–-]*\)$/.test(compact(v)) &&
              /^\d[\d.,]*%?$/.test(compact(cells(previous)[n + 1]))) ||
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
        values.length < minimumValues ||
        !values.every(
          (s) =>
            numeric(s) ||
            /^[-–—]$/.test(compact(s)) ||
            ((categorical || paired) && /^(?:\(\d[\d.,]*\)|[-–—])$/.test(compact(s)))
        )
      )
        return
      measures++
    } else {
      if (
        !wideSection(group) &&
        (!/\p{L}/u.test(text[0]) ||
          text[0].length > 100 ||
          text
            .slice(1, stub ? 6 : categorical ? -1 : undefined)
            .some((v, c) => v && !(sparseMeasures && [1, 3].includes(c) && numeric(v))) ||
          (stub && text.slice(6).some((s) => s && !numeric(s))) ||
          (categorical && text.at(-1) && !numeric(text.at(-1))))
      )
        return
      if (
        (/^[a-z]/.test(text[0]) ||
          (categorical &&
            /^\([a-z][^)]+\),/.test(text[0]) &&
            previous &&
            records.length &&
            items
              .filter(
                (i) =>
                  col(i) === 0 && i.rect[1] >= records.at(-1)[1] && i.rect[3] <= records.at(-1)[3]
              )
              .map((i) => i.text)
              .join(' ').length > 50 &&
            body[body.indexOf(group) + 1] &&
            isRecord(body[body.indexOf(group) + 1]))) &&
        text.slice(1).every((s) => !s) &&
        records.length &&
        (!isRecord(body[body.indexOf(group) - 1]) ||
          (categorical &&
            previous &&
            cells(previous)[0].length > 30 &&
            previous.some((i) => col(i) === 0 && i.rect[2] > cuts[1] - i.height * 2) &&
            group.every(
              (i) =>
                Math.abs(
                  i.rect[0] -
                    Math.min(...previous.filter((p) => col(p) === 0).map((p) => p.rect[0]))
                ) <
                i.height * 1.1
            ))) &&
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
  if ((deviation || categorical || repeatedTimes) && !unit && heading.length > 1) {
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
        !children.some(
          (i) =>
            !covered.includes(i) &&
            (i.rect[0] + i.rect[2]) / 2 > r[0] &&
            (i.rect[0] + i.rect[2]) / 2 < r[2]
        ) &&
        r[0] <= Math.min(...covered.map((i) => i.rect[0])) + 1 &&
        r[2] >= Math.max(...covered.map((i) => i.rect[2])) - 1 &&
        children.filter((i) => childColumns.includes(col(i))).every((i) => covered.includes(i)) &&
        covered.every((i) => i.rect[0] >= cuts[col(i)] && i.rect[2] <= cuts[col(i) + 1])
      const c = textEdges ? childColumns[0] : cuts.findIndex((x) => x >= r[0] - 12)
      const end = textEdges ? childColumns.at(-1) + 1 : cuts.findLastIndex((x) => x <= r[2] + 12)
      return c >= 0 && end > c && parent.some((i) => i.rect[0] >= r[0] - 1 && i.rect[2] <= r[2] + 1)
        ? [{ row: 0, column: c, rowSpan: 1, colSpan: end - c }]
        : []
    })
    // Some publishers mark parent groups above their title baseline and
    // individual child columns below it. Require separate inset overlines and
    // complete child ownership; a full-width table border cannot define a group.
    const overlineSpans = rules.flatMap((r) => {
      if (
        r[1] !== r[3] ||
        r[1] < parentRect[1] - parent[0].height ||
        r[1] > parentRect[1] + parent[0].height * 0.2 ||
        r[2] - r[0] > (right - left) * 0.85
      )
        return []
      const labels = parent.filter((i) => i.rect[0] >= r[0] - 1 && i.rect[2] <= r[2] + 1)
      const columns = cuts
        .slice(1)
        .flatMap((x, c) => ((cuts[c] + x) / 2 >= r[0] && (cuts[c] + x) / 2 <= r[2] ? [c] : []))
      if (
        !labels.length ||
        columns.length < 2 ||
        labels.some((i, n) => n && i.rect[0] - labels[n - 1].rect[2] > i.height * 1.5) ||
        columns.some(
          (c) =>
            !heading
              .slice(1)
              .flat()
              .some((i) => col(i) === c)
        ) ||
        heading
          .slice(1)
          .flat()
          .some((i) => columns.includes(col(i)) && (i.rect[0] < r[0] - 1 || i.rect[2] > r[2] + 1))
      )
        return []
      return [{ row: 0, column: columns[0], rowSpan: 1, colSpan: columns.length }]
    })
    if (
      overlineSpans.length >= 2 &&
      overlineSpans.every(
        (s, n) => !n || s.column >= overlineSpans[n - 1].column + overlineSpans[n - 1].colSpan
      )
    )
      parentSpans.splice(0, parentSpans.length, ...overlineSpans)
    if (
      categorical &&
      !parentSpans.length &&
      cells(parent).filter(Boolean).length >= 3 &&
      brackets.some((r) => r[2] - r[0] > (right - left) * 0.9)
    ) {
      const split = Math.max(...brackets.map((r) => r[1]))
      rows.splice(0, rows.length, [left, header[1], right, split], [left, split, right, header[3]])
    }
    if (parentSpans.length >= (categorical || repeatedTimes ? 1 : 2)) {
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
  if (sparseMeasures && heading.length === 3) {
    const middle = cells(heading[1]),
      lower = cells(heading[2])
    if (
      middle[1] &&
      middle[3] &&
      !middle[2] &&
      !middle[4] &&
      [2, 4].every((c) => /^F\(p\)$/.test(compact(lower[c]))) &&
      [1, 3].every((c) =>
        rules.some(
          (r) =>
            r[1] === r[3] &&
            r[1] > union(heading[1])[3] &&
            r[1] < union(heading[2])[1] &&
            heading[2]
              .filter((i) => col(i) >= c && col(i) < c + 2)
              .every((i) => i.rect[0] >= r[0] - 1 && i.rect[2] <= r[2] + 1)
        )
      )
    ) {
      rows.splice(0, rows.length, ...heading.map((g) => [left, union(g)[1], right, union(g)[3]]))
      for (let n = spans.length - 1; n >= 0; n--) if (spans[n].header) spans.splice(n, 1)
      spans.push(
        { row: 0, column: 0, rowSpan: 3, colSpan: 1, header: true },
        { row: 0, column: 1, rowSpan: 1, colSpan: 4, header: true },
        ...[1, 3].map((column) => ({ row: 1, column, rowSpan: 1, colSpan: 2, header: true }))
      )
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
// Repeated child headings and their native brackets establish both the parent
// groups and the value columns. Complete value baselines anchor hanging stubs.
function recoverBracketedSummaryGrid(table, items, rules) {
  const [left, top, right, bottom] = table.cropRect
  const source = tableSourceItems(items, table.cropRect)
  if (!source.length) return
  const height = source.map((i) => i.height).sort((a, b) => a - b)[Math.floor(source.length / 2)]
  const groups = groupSourceRowsWithScripts(source, height, 0.35)
  if (!groups) return
  for (let h = 1; h < Math.min(groups.length, 5); h++) {
    const leaf = [...groups[h]].sort((a, b) => a.rect[0] - b.rect[0])
    if (
      leaf.length < 5 ||
      leaf.length > 13 ||
      leaf.length % 2 !== 1 ||
      !leaf
        .slice(1)
        .every((i, n) => /^[A-Za-z]{1,12}$/.test(i.text) && i.text === leaf[1 + (n % 2)].text) ||
      leaf[1].text === leaf[2].text
    )
      continue
    const columns = table.structure.objects
      .filter((o) => o.label === 'table column')
      .sort((a, b) => a.rect[0] - b.rect[0])
    if (columns.length !== leaf.length) continue
    const cuts = [
      left,
      ...columns.slice(1).map((c, n) => left + (columns[n].rect[2] + c.rect[0]) / 2),
      right
    ]
    const divider = rules.find(
      (r) =>
        r[1] === r[3] &&
        r[0] <= left + height &&
        r[2] >= right - height &&
        r[1] > union(leaf)[3] &&
        r[1] < union(leaf)[3] + height
    )
    const parent = groups[h - 1]
    const brackets = rules.filter(
      (r) => r[1] === r[3] && r[1] > union(parent)[3] && r[1] < union(leaf)[1]
    )
    if (!divider || brackets.length !== (leaf.length - 1) / 2 || parent.length !== brackets.length)
      continue
    const spans = []
    for (let c = 1; c < leaf.length; c += 2) {
      const bracket = brackets.find(
        (r) =>
          leaf[c].rect[0] >= r[0] - 1 &&
          leaf[c + 1].rect[2] <= r[2] + 1 &&
          (c === 1 || leaf[c - 1].rect[2] < r[0]) &&
          (c + 2 === leaf.length || leaf[c + 2].rect[0] > r[2])
      )
      if (
        !bracket ||
        parent.filter((i) => i.rect[0] >= bracket[0] && i.rect[2] <= bracket[2]).length !== 1
      )
        break
      spans.push({ row: 0, column: c, rowSpan: 1, colSpan: 2 })
    }
    if (spans.length !== brackets.length) continue
    const body = groups.slice(h + 1),
      records = []
    let valid = true
    for (const g of body) {
      const v = readSourceRow(g, cuts)
      if (!v) {
        valid = false
        break
      }
      if (v.slice(1).every((x) => /^(?:NA|[−-]?\d[\d.,]*\([\d.,]+\))$/.test(x)) && v[0])
        records.push([...g])
      else if (
        records.length &&
        v[0] &&
        v.slice(1).every((x) => !x) &&
        g.every((i) => i.rect[0] >= leaf[0].rect[0] + height * 0.5) &&
        g[0].baseline - records.at(-1).at(-1).baseline < height * 1.6
      )
        records.at(-1).push(...g)
      else {
        valid = false
        break
      }
    }
    if (
      !valid ||
      records.length < 8 ||
      records.filter((g) => new Set(g.map((i) => Math.round(i.baseline))).size > 1).length < 4
    )
      continue
    const rects = records.map(union)
    if (rects.some((r, n) => n && r[1] <= rects[n - 1][3])) continue
    const split = (union(parent)[3] + union(leaf)[1]) / 2
    return {
      rows: [
        [left, union(parent)[1], right, split],
        [left, split, right, divider[1]],
        ...rects.map((r) => [left, r[1], right, r[3]])
      ],
      columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
      spans,
      completeSpans: true
    }
  }
}

export function recoverAnchoredStubGrid(table, items, captions, rules = []) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const bracketed = recoverBracketedSummaryGrid(table, items, rules)
  if (bracketed) return bracketed
  const [left, top, right, bottom] = table.cropRect
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (![2, 3, 5].includes(predicted.length)) return
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
  const sharedOdds =
    predicted.length === 3 && source.find((i) => /^Adjusted Odds Ratio \(95% CI\)$/.test(i.text))
  if (predicted.length === 3 && !sharedOdds) return
  const odds = source.filter((i) => /^OR\s*\(CI\s*95%\)$/i.test(i.text))
  if (predicted.length === 5 && odds.length !== 2) return
  const first = source.filter((i) => col(i) === 0).sort((a, b) => a.baseline - b.baseline)[0]
  if (!first) return
  const headerEnd = sharedOdds
    ? sharedOdds.baseline
    : odds.length
      ? Math.max(...odds.map((i) => i.baseline))
      : first.baseline
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
    (sharedOdds ? Math.min(...body.map((i) => i.rect[1])) : labels[0].rect[1]) - 0.1,
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
  } else if (sharedOdds) {
    const numeric = (s) => /^[<>≤≥−+-]?\d[\d.,()–−+\s-]*$/.test(s)
    if (
      records.filter((g) => [1, 2].every((c) => numeric(value(g, c)))).length < 6 ||
      records.filter((g) => [1, 2].every((c) => /\(n\s*=\s*\d+\s*\)/.test(value(g, c)))).length !==
        2 ||
      records.some(
        (g) => ![1, 2].every((c) => numeric(value(g, c)) || /\(n\s*=\s*\d+\s*\)/.test(value(g, c)))
      )
    )
      return
  } else {
    const descriptions =
      predicted.length === 2 &&
      cuts[1] - left < (right - left) * 0.25 &&
      rules.filter(
        (r) =>
          r[1] === r[3] && r[0] <= left + 12 && r[2] >= right - 12 && r[1] >= top && r[1] <= bottom
      ).length === 3 &&
      labels.every((i) => i.text.length < 40) &&
      records.every((g) => value(g, 1).length > 5)
    const definitions =
      descriptions ||
      (/^Term$/i.test(first.text) &&
        source.some(
          (i) =>
            col(i) === 1 &&
            /^Definition$/i.test(i.text) &&
            Math.abs(i.baseline - first.baseline) < first.height * 0.25
        ))
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
  const spans = sharedOdds ? [{ row: 0, column: 1, colSpan: 2, rowSpan: 1 }] : []
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

// Before/after clinical observations mix counts, deviations and a final
// qualitative record. Complete paired values anchor rows; only short indented
// lowercase/unit continuations may join the preceding stub.
function recoverMixedClinicalRecords({ source, cuts, top, bottom, rules }) {
  const [left, , , right] = cuts
  if (!source.length) return
  const height = source.map((i) => i.height).sort((a, b) => a - b)[Math.floor(source.length / 2)]
  const groups = groupSourceRowsWithScripts(source, height, 0.3)
  if (!groups || groups.length < 10) return
  const footer = rules.find(
    (r) =>
      r[1] === r[3] &&
      r[0] <= left + 4 &&
      r[2] >= right - 4 &&
      r[1] > union(groups.at(-1))[3] &&
      r[1] <= bottom
  )
  if (!footer) return
  const count = (s) => /^\d+(?:\(\d+(?:\.\d+)?%\))?$/.test(s)
  const deviation = (s) => /^\d+(?:\.\d+)?±\d+(?:\.\d+)?$/.test(s)
  const values = groups.map((g) => readSourceRow(g, cuts))
  if (values.some((v) => !v)) return
  const start = values.findIndex((v) => /\p{L}/u.test(v[0]) && v.slice(1).every(count))
  if (start < 1 || start > 4) return
  const header = groups.slice(0, start).flat()
  const text = cuts.slice(1).map((x, c) =>
    header
      .filter((i) => i.rect[0] >= cuts[c] && i.rect[2] <= x)
      .map((i) => i.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
  )
  if (
    !/^Before\b.*\bn\s*=\s*\d+$/i.test(text[1]) ||
    !/^After\b.*\bn\s*=\s*\d+$/i.test(text[2]) ||
    !/\p{L}/u.test(text[0])
  )
    return
  const records = []
  let counts = 0,
    deviations = 0,
    qualitative = 0
  for (let n = start; n < groups.length; n++) {
    const g = groups[n],
      v = values[n],
      prior = records.at(-1)
    if (!v[0]) return
    if (v.slice(1).every(count)) {
      counts++
      records.push([...g])
    } else if (v.slice(1).every(deviation)) {
      deviations++
      records.push([...g])
    } else if (n === groups.length - 1 && v.slice(1).every((s) => /^Normal$/i.test(s))) {
      qualitative++
      records.push([...g])
    } else if (
      !v[1] &&
      !v[2] &&
      prior &&
      /^(?:[a-z]|SD$)/.test(v[0]) &&
      g[0].rect[0] > prior[0].rect[0] &&
      g[0].rect[0] - prior[0].rect[0] <= height &&
      g[0].baseline - prior[0].baseline < height * 1.6 &&
      !hasHorizontalTableRuleBetween(rules, union(prior)[3], union(g)[1])
    )
      prior.push(...g)
    else return
  }
  if (
    counts < 6 ||
    deviations < 3 ||
    qualitative !== 1 ||
    !hasUniqueRecordTokens(source, [header, ...records])
  )
    return
  const bounds = records.map(union)
  if (bounds.some((b, n) => n && b[1] <= bounds[n - 1][3])) return
  return {
    rows: [
      [left, union(header)[1], right, bounds[0][1] - 0.1],
      ...bounds.map((b) => [left, b[1], right, b[3]])
    ],
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans: [],
    headerRows: [0],
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Some cohort tables alternate two numeric subcolumns with a centered count
// spanning both. The source explicitly declares both formats above the body.
function recoverMixedCohortGrid(table, items, captions) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const source = tableSourceItems(items, table.cropRect)
  const units = source.filter((i) => /^n \(missing values\) mean ± SD or$/.test(i.text))
  if (
    units.length !== 2 ||
    Math.abs(units[0].baseline - units[1].baseline) > 1 ||
    !source.some((i) => i.text === 'Nominal and ordinal data')
  )
    return
  const height = units[0].height
  const groups = groupSourceRowsWithScripts(source, height, 0.3)
  if (!groups) return
  const nominal = groups.findIndex((g) => g.some((i) => i.text === 'Nominal and ordinal data'))
  const header = groups.slice(0, nominal + 1).flat()
  const cohortHeads = header.filter((i) => /Group \(n\s*=\s*\d+\)/.test(i.text))
  if (cohortHeads.length !== 2) return
  const number = (s) => /^[\d.,]+(?:\s*\([\d.,–-]+\)|\s*±\s*[\d.,]+)?$/.test(s)
  const body = groups.slice(nominal + 1)
  const paired = body
    .map((g) => g.filter((i) => i.rect[0] >= units[0].rect[0] && number(i.text)))
    .filter((g) => g.length === 4)
  if (paired.length < 5) return
  paired.forEach((g) => g.sort((a, b) => a.rect[0] - b.rect[0]))
  const cuts = [
    table.cropRect[0],
    units[0].rect[0] - height * 0.2,
    ...[1, 2, 3].map(
      (c) =>
        (Math.max(...paired.map((g) => g[c - 1].rect[2])) +
          Math.min(...paired.map((g) => g[c].rect[0]))) /
        2
    ),
    table.cropRect[2]
  ]
  const rows = [union(header)],
    spans = [
      { row: 0, column: 1, rowSpan: 1, colSpan: 2 },
      { row: 0, column: 3, rowSpan: 1, colSpan: 2 }
    ],
    owned = [...header]
  let categories = 0
  for (const g of body) {
    const label = g.filter((i) => i.rect[2] < cuts[1]),
      values = g.filter((i) => !label.includes(i)).sort((a, b) => a.rect[0] - b.rect[0])
    if (!label.length || values.some((i) => !number(i.text))) return
    const row = rows.length
    if (values.length === 4) {
      if (!readSourceRow(g, cuts)) return
    } else if (values.length === 2) {
      if (
        values.some(
          (i, n) =>
            i.rect[0] < cuts[1 + n * 2] ||
            i.rect[2] > cuts[3 + n * 2] ||
            Math.abs((i.rect[0] + i.rect[2]) / 2 - (units[n].rect[0] + units[n].rect[2]) / 2) >
              height
        )
      )
        return
      spans.push(...[1, 3].map((column) => ({ row, column, rowSpan: 1, colSpan: 2 })))
      categories++
    } else if (!values.length) {
      if (!/\p{L}/u.test(label.map((i) => i.text).join(''))) return
      spans.push({ row, column: 0, rowSpan: 1, colSpan: 5 })
    } else return
    rows.push(union(g))
    owned.push(...g)
  }
  if (categories < 15 || rows.some((r, n) => n && r[1] < rows[n - 1][3])) return
  return {
    rows: rows.map((r) => [cuts[0], r[1], cuts[5], r[3]]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], rows[0][1], x, rows.at(-1)[3]]),
    spans,
    completeSpans: true,
    headerRows: [0],
    ownedTokens: new Set(owned)
  }
}

// Repeated baseline/intervention/follow-up triplets and within-group contrasts
// independently establish rows in four-column clinical outcome tables.
function recoverClinicalTimepointGrid(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const columns = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  for (let n = columns.length - 1; n > 0; n--)
    if (
      intersect(columns[n].rect, columns[n - 1].rect) /
        Math.min(area(columns[n].rect), area(columns[n - 1].rect)) >
      0.9
    )
      columns.splice(n, 1)
  if (![4, 5].includes(columns.length)) return
  const cuts = [
    left,
    ...columns.slice(1).map((c, n) => left + (columns[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const source = tableSourceItems(items, table.cropRect)
  // Repeated visit labels anchor two-stub clinical tables even when the first
  // outcome is predicted as the header. Both sample headings and native rules
  // must independently identify the real header band.
  const sampleHeadings = source.filter((i) => /\bgroup\s+[Nn]\s*=\s*\d+/.test(i.text))
  if (
    sampleHeadings.length === 2 &&
    Math.abs(sampleHeadings[0].baseline - sampleHeadings[1].baseline) <
      sampleHeadings[0].height * 0.2
  ) {
    const height = sampleHeadings[0].height
    const borders = rules
      .filter(
        (r) =>
          r[1] === r[3] && r[0] <= left + 12 && r[2] >= right - 12 && r[1] >= top && r[1] <= bottom
      )
      .sort((a, b) => a[1] - b[1])
    const divider = borders.find(
      (r) => r[1] > sampleHeadings[0].rect[3] && r[1] - sampleHeadings[0].rect[3] < height * 2
    )
    const footer = borders.at(-1)
    if (divider && footer && footer !== divider) {
      const header = source.filter((i) => i.rect[3] < divider[1])
      const body = source.filter((i) => i.rect[1] > divider[1] && i.rect[3] < footer[1])
      const groups = groupSourceRowsWithScripts(body, height, 0.35)
      const values = groups?.map((g) => readSourceRow(g, cuts))
      const visit = /^(?:baseline|\d+(?:st|nd|rd|th)week)$/i
      const numeric = /^(?:[−+-]?\d[\d.,±−+-]*|(?:t|χ2)=[−+-]?\d[\d.,−+-]*,P[=<>][\d.]+[a-z]?)$/
      if (
        values &&
        values.length >= 8 &&
        values.every((v) => v && visit.test(v[1]) && v.slice(2).every((x) => numeric.test(x)))
      ) {
        const starts = values.flatMap((v, n) => (v[0] ? [n] : []))
        const cycle = starts[1]
        if (
          starts.length >= 3 &&
          starts[0] === 0 &&
          cycle >= 3 &&
          cycle <= 4 &&
          values.length === starts.length * cycle &&
          starts.every((n, i) => n === i * cycle) &&
          values.every((v, n) => v[1] === values[n % cycle][1]) &&
          hasUniqueRecordTokens(body, groups)
        ) {
          const spans = starts.map((n) => ({ row: n + 1, column: 0, rowSpan: cycle, colSpan: 1 }))
          if (header.some((i) => i.rect[0] < cuts[1] && i.rect[2] > cuts[1] && i.rect[2] < cuts[2]))
            spans.push({ row: 0, column: 0, rowSpan: 1, colSpan: 2 })
          return {
            rows: [
              [left, union(header)[1], right, divider[1]],
              ...groups.map((g) => {
                const r = union(g)
                return [left, r[1], right, r[3]]
              })
            ],
            columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
            spans,
            completeSpans: true,
            headerRows: [0],
            ownedTokens: new Set([...header, ...body])
          }
        }
      }
    }
  }
  if (columns.length !== 4) return
  const heading = source.find((i) => /^Between-Group Effects mean diff \(95% CI\)$/.test(i.text))
  if (!heading || !source.some((i) => /Group.*mean \(SD; 95% CI\)/.test(i.text))) return
  const groups = groupSourceRowsWithScripts(source, heading.height, 0.35)
  if (!groups) return
  const start = groups.findIndex((g) => g[0].baseline > heading.baseline + heading.height)
  if (start !== 2) return
  const text = groups.map((g) => readSourceRow(g, cuts))
  if (text.some((v) => !v)) return
  const time = (s) => /^(?:Baseline|\d+weeks?Intervention|\d+months?Follow-up)$/.test(s)
  const contrast = (s) => /^Baselineto\d+(?:weeks?|months?)$/.test(s)
  const numeric = (s) => {
    const value = s.replace(/to/g, '').replace(/[a-d]$/, '')
    let depth = 0
    if (!/^[−+-]?\d[\d.,;()−+-]*$/.test(value)) return false
    for (const ch of value) {
      if (ch === '(') depth++
      if (ch === ')' && --depth < 0) return false
    }
    // Some source statistics have one extra opening bracket. Preserve it verbatim;
    // the repeated timepoint/column evidence still establishes its cell.
    return (
      (depth === 0 || (depth === 1 && value.includes(';') && value.endsWith(')'))) &&
      value.includes('(')
    )
  }
  const spans = [{ row: 0, column: 1, rowSpan: 1, colSpan: 2 }]
  let baseline = 0,
    followup = 0,
    contrasts = 0,
    sections = 0
  for (let n = start; n < groups.length; n++) {
    const v = text[n]
    if (time(v[0])) {
      if (!v.slice(1, 3).every(numeric) || v[3]) return
      if (v[0] === 'Baseline') baseline++
      else followup++
    } else if (contrast(v[0])) {
      if (!v.slice(1).every(numeric)) return
      contrasts++
    } else if (/\p{L}/u.test(v[0]) && v.slice(1).every((s) => !s)) {
      spans.push({ row: n, column: 0, rowSpan: 1, colSpan: 4 })
      sections++
    } else return
  }
  if (
    baseline < 4 ||
    followup !== baseline * 2 ||
    contrasts !== baseline * 2 ||
    sections < baseline
  )
    return
  return {
    rows: groups.map((g) => {
      const r = union(g)
      return [left, r[1], right, r[3]]
    }),
    columns: cuts.slice(1).map((x, n) => [cuts[n], top, x, bottom]),
    spans,
    completeSpans: true,
    headerRows: [0, 1],
    ownedTokens: new Set(source)
  }
}

// Ordered adherence bins repeat beneath each outcome. Their literal labels,
// counts and intervals provide independent row anchors for shared outcome stubs.
function recoverAdherenceDistributionGrid(table, items, captions) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const columns = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (columns.length !== 5) return
  const cuts = [
    left,
    ...columns.slice(1).map((c, n) => left + (columns[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const source = tableSourceItems(items, table.cropRect)
  const heading = source.find((i) => i.text === 'Adherence')
  if (!heading || !source.some((i) => i.text === 'Risk Ratio (95% CI)')) return
  const groups = groupSourceRowsWithScripts(source, heading.height, 0.35)
  if (!groups) return
  const values = groups.map((g) => readSourceRow(g, cuts))
  if (values.some((v) => !v) || values[0][2] !== 'Adherence') return
  const bins = ['<25%', '25%–49%', '50%–74%', '75%–100%']
  let bin = 0,
    blocks = 0,
    sections = 0,
    stub = -1
  const spans = []
  for (let n = 1; n < groups.length; n++) {
    const v = values[n]
    if (!v.slice(1).some(Boolean)) {
      if (bin || !/\p{L}/u.test(v[0])) return
      sections++
      continue
    }
    if (v[2] !== bins[bin] || !/^\d+\(\d+\)$/.test(v[1]) || (v[4] && !/^0?\.\d+$/.test(v[4])))
      return
    if (!/^(?:1,referent|[–−-]|\d+(?:\.\d+)?\(\d+(?:\.\d+)?[–−-]\d+(?:\.\d+)?\))$/.test(v[3]))
      return
    if (!bin) {
      if (!v[0] || !/\p{L}/u.test(v[0])) return
      stub = n
      blocks++
    } else if (v[0]) return
    bin = (bin + 1) % 4
    if (!bin) spans.push({ row: stub, column: 0, rowSpan: 4, colSpan: 1 })
  }
  if (bin || blocks < 6 || sections < 3) return
  return {
    rows: groups.map((g) => {
      const r = union(g)
      return [left, r[1], right, r[3]]
    }),
    columns: cuts.slice(1).map((x, n) => [cuts[n], top, x, bottom]),
    spans,
    completeSpans: true,
    headerRows: [0],
    ownedTokens: new Set(source)
  }
}

// Repeated median/IQR headings establish paired summary columns independently
// of detector header bands. Parent underlines and complete comparison records
// keep note markers and wrapped ranges with their literal source owners.
function recoverQuartileComparisonGrid(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const columns = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (columns.length !== 11) return
  const cuts = [
    left,
    ...columns.slice(1).map((c, n) => left + (columns[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const source = tableSourceItems(items, table.cropRect)
  const medians = source.filter((i) => i.text.trim() === 'Median')
  if (
    medians.length !== 3 ||
    medians.some((i) => Math.abs(i.baseline - medians[0].baseline) > i.height * 0.2)
  )
    return
  const height = medians[0].height
  const sourceColumn = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  if (medians.some((i, n) => sourceColumn(i) !== 1 + n * 2)) return
  const lowerTop = Math.min(...medians.map((i) => i.rect[1]))
  const parentRules = rules.filter(
    (r) =>
      r[1] === r[3] &&
      r[1] < medians[0].baseline - height * 0.3 &&
      Math.abs(lowerTop - r[1]) < height &&
      r[0] > left &&
      r[2] < cuts[7]
  )
  if (parentRules.length !== 3) return
  const parentBottom = Math.max(...parentRules.map((r) => r[1]))
  const lowerEnd = source.filter(
    (i) => i.rect[1] >= lowerTop && i.rect[1] < lowerTop + height * 4 && i.text === 'IQR'
  )
  if (lowerEnd.length !== 3) return
  const headerBottom = Math.max(...lowerEnd.map((i) => i.rect[3]))
  const upper = source.filter((i) => i.rect[3] <= parentBottom)
  const lower = source.filter((i) => i.rect[1] >= lowerTop && i.rect[1] < headerBottom)
  const body = source.filter((i) => i.rect[1] >= headerBottom)
  if (
    !hasUniqueRecordTokens(source, [upper, lower, body]) ||
    (
      upper
        .map((i) => i.text)
        .join(' ')
        .match(/n\s*=\s*\d+/g) ?? []
    ).length !== 3
  )
    return
  const child = readSourceRow(
    lower.filter((i) => i.height >= height * 0.8),
    cuts
  )
  if (
    !child ||
    ![1, 3, 5].every((c) =>
      /^(?:Median\(FirstQuartile[–-]ThirdQuartile\)|\(FirstQuartile[–-]ThirdQuartile\)Median)$/.test(
        child[c]
      )
    ) ||
    ![2, 4, 6].every((c) => child[c] === 'IQR') ||
    ![7, 8, 9, 10].every((c) => child[c] === 'P')
  )
    return
  const groups = groupSourceRowsWithScripts(body, height, 0.25)
  if (!groups) return
  const records = []
  for (const g of groups) {
    const v = readSourceRow(g, cuts)
    if (!v) return
    if (v[0] && v.slice(1).every((s) => /^[.\d]/.test(s))) records.push([...g])
    else {
      const previous = records.at(-1)
      if (
        !previous ||
        (v[0] && !/^\([a-z ]+\)(?:\/[A-Z])?$/.test(v[0])) ||
        v.some((s, c) => s && ![0, 1, 3, 5].includes(c)) ||
        ![1, 3, 5].every(
          (c) =>
            /^\([\d.]+[–-][\d.]+\)$/.test(v[c]) ||
            (!v[c] && /\([\d.]+[–-][\d.]+\)/.test(readSourceRow(previous, cuts)?.[c] ?? ''))
        ) ||
        g[0].baseline - previous[0].baseline > height * 1.8 ||
        hasHorizontalTableRuleBetween(rules, union(previous)[3], union(g)[1])
      )
        return
      previous.push(...g)
    }
  }
  if (records.length < 6) return
  const bounds = [union(upper), union(lower), ...records.map(union)]
  if (bounds.some((b, n) => n && b[1] <= bounds[n - 1][3])) return
  return {
    rows: bounds.map((b) => [left, b[1], right, b[3]]),
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans: [1, 3, 5].map((column) => ({ row: 0, column, rowSpan: 1, colSpan: 2 })),
    headerRows: [0, 1],
    completeSpans: true,
    ownedTokens: new Set(source),
    repair: 'quartile-comparison-grid-recovered'
  }
}

// Repeated, explicitly dated follow-up columns can be collapsed by the model.
// Native heading centers and empty gutters must establish every missing column;
// paired intervention rows independently validate the recovered time series.
function recoverDatedFollowupColumns(table, items, captions, rules) {
  const [left, top, right, bottom] = table.cropRect
  if (
    !captions.some(
      (c) => captionKind(c.lines[0]) === 'table' && c.rect[3] <= top && top - c.rect[3] < 30
    )
  )
    return
  const source = tableSourceItems(items, table.cropRect)
  const dates = source
    .filter((i) => /^\d+-month$/.test(i.text) && i.rect[1] < top + 100)
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (
    dates.length !== 4 ||
    dates.some(
      (i, n) =>
        Math.abs(i.baseline - dates[0].baseline) > 1 ||
        (n && parseInt(i.text) <= parseInt(dates[n - 1].text))
    )
  )
    return
  const height = dates[0].height
  const heading = source.filter((i) => i.rect[1] < dates[0].rect[3] + height * 1.5)
  const label = (text) =>
    heading.filter((i) => i.text === text && Math.abs(i.baseline - dates[0].baseline) < 1)
  const anchors = [
    label('Measure and'),
    label('Pretreatment'),
    label('Posttreatment'),
    label('Group'),
    ...dates.map((i) => [i]),
    label('Treatment'),
    label('Follow-up')
  ]
  if (anchors.some((g) => g.length !== 1)) return
  const centers = anchors.map(([i]) => (i.rect[0] + i.rect[2]) / 2)
  const time = label('Time')
  if (
    time.length !== 1 ||
    time[0].rect[0] <= anchors[3][0].rect[2] ||
    time[0].rect[2] >= dates[0].rect[0]
  )
    return
  centers[3] = (anchors[3][0].rect[0] + time[0].rect[2]) / 2
  if (centers.some((x, n) => n && x <= centers[n - 1])) return
  const parent = heading.filter((i) => i.text === 'Follow-up' && i.rect[3] < dates[0].rect[1])
  if (
    parent.length !== 1 ||
    !rules.some(
      (r) =>
        r[1] === r[3] &&
        Math.abs(r[1] - parent[0].baseline) < height &&
        r[0] > centers[3] &&
        r[0] < centers[4] &&
        r[2] > centers[7] &&
        r[2] < centers[8]
    )
  )
    return
  const leaf = heading.filter((i) => i !== parent[0]),
    body = source.filter((i) => !heading.includes(i))
  const cuts = [left, ...centers.slice(1).map((x, n) => (x + centers[n]) / 2), right]
  const columns = cuts.slice(1).map(() => [])
  for (const i of [...leaf, ...body]) {
    const c = cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
    if (c < 0) return
    columns[c].push(i)
  }
  if (columns.some((c) => !c.length)) return
  for (let c = 1; c < columns.length; c++) {
    const a = Math.max(...columns[c - 1].map((i) => i.rect[2])),
      b = Math.min(...columns[c].map((i) => i.rect[0]))
    if (a >= b) return
    cuts[c] = Math.max(a + 0.01, Math.min(b - 0.01, cuts[c]))
  }
  const leafValues = readSourceRow(leaf, cuts)
  if (!leafValues || [1, 2, 4, 5, 6, 7].some((c) => !leafValues[c].endsWith('M(SD)'))) return
  const groups = groupSourceRowsWithScripts(body, height, 0.3)
  if (!groups || groups.length < 12 || groups.length % 3 !== 0) return
  const values = groups.map((g) => readSourceRow(g, cuts))
  if (values.some((v) => !v)) return
  const pair = values.slice(1, 3).map((v) => v[0])
  if (pair.some((v) => !/^[A-Z][A-Za-z-]+$/.test(v)) || pair[0] === pair[1]) return
  for (let n = 0; n < values.length; n += 3) {
    const section = values[n]
    if (
      !/\p{L}/u.test(section[0]) ||
      section.some((s, c) => c > 0 && c !== 3 && s) ||
      (section[3] && !/^\d+(?:\.\d+)?$/.test(section[3]))
    )
      return
    for (let k = 1; k <= 2; k++) {
      const v = values[n + k]
      if (
        v[0] !== pair[k - 1] ||
        v[3] ||
        v
          .slice(1)
          .some(
            (s, c) =>
              c !== 2 && !/^(?:[−–+-]?\d+(?:\.\d+)?(?:\(\d+(?:\.\d+)?\))?[a-d*]*|[—−–-])$/.test(s)
          )
      )
        return
    }
  }
  if (!hasUniqueRecordTokens(source, [parent, leaf, ...groups])) return
  const y = (parent[0].rect[3] + Math.min(...leaf.map((i) => i.rect[1]))) / 2
  const bound = union(leaf)
  return {
    rows: [
      [left, parent[0].rect[1], right, y],
      [left, y, right, bound[3]],
      ...groups.map((g) => {
        const r = union(g)
        return [left, r[1], right, r[3]]
      })
    ],
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    headerRows: [0, 1],
    spans: [
      { row: 0, column: 4, rowSpan: 1, colSpan: 4 },
      ...[0, 1, 2, 3, 8, 9].map((c) => ({ row: 0, column: c, rowSpan: 2, colSpan: 1 }))
    ],
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// A two-stub cohort table prints one test and P value for an entire category
// group. Native test starts and paired counts determine both shared cell spans.
function recoverSharedClinicalStatistics(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const columns = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (columns.length !== 5) return
  const cuts = [
    left,
    ...columns.slice(1).map((c, n) => left + (columns[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const source = tableSourceItems(items, table.cropRect)
  const title = source.find((i) => col(i) === 4 && /^Statistic,$/.test(i.text))
  if (!title) return
  const borders = rules
    .filter(
      (r) =>
        r[1] === r[3] && r[0] <= left + 12 && r[2] >= right - 12 && r[1] >= top && r[1] <= bottom
    )
    .sort((a, b) => a[1] - b[1])
  if (borders.length !== 3) return
  const divider = borders[1][1],
    footer = borders[2][1],
    height = title.height
  const header = source.filter((i) => i.rect[3] < divider)
  if (
    ![2, 3].every((c) =>
      /groupN=\d+/.test(
        header
          .filter((i) => col(i) === c)
          .map((i) => i.text)
          .join('')
          .replace(/\s/g, '')
      )
    )
  )
    return
  const body = source.filter((i) => i.rect[1] > divider && i.rect[3] < footer)
  const data = body.filter((i) => col(i) === 2 || col(i) === 3)
  const groups = groupSourceRowsWithScripts(data, height, 0.35)
  if (!groups || groups.length < 6) return
  if (
    !groups.every((g) => {
      const v = readSourceRow(g, cuts)
      return (
        v &&
        v
          .slice(2, 4)
          .every((x) => /^(?:\d+(?:\.\d+)?\([\d.]+\)|\d+(?:\.\d+)?±\d+(?:\.\d+)?)$/.test(x))
      )
    })
  )
    return
  const anchors = groups.map(union)
  const ys = [divider, ...anchors.slice(1).map((r) => r[1] - 0.1), footer]
  const tests = body.filter((i) => col(i) === 4 && /^(?:t\s*=|χ$)/.test(i.text))
  const starts = tests.map((i) =>
    groups.findIndex((g) => Math.abs(g[0].baseline - i.baseline) < height * 0.3)
  )
  if (
    starts.length < 3 ||
    starts[0] !== 0 ||
    starts.some((n, i) => n < 0 || (i && n <= starts[i - 1]))
  )
    return
  const spans = [],
    owned = [header, ...groups]
  for (let n = 0; n < starts.length; n++) {
    const start = starts[n],
      end = starts[n + 1] ?? groups.length
    const region = body.filter(
      (i) =>
        col(i) !== 2 &&
        col(i) !== 3 &&
        (i.rect[1] + i.rect[3]) / 2 >= ys[start] &&
        (i.rect[1] + i.rect[3]) / 2 < ys[end]
    )
    const stats = region.filter((i) => col(i) === 4)
    const statLines = groupSourceRowsWithScripts(stats, height, 0.35)
    const value = statLines?.map((g) => readSourceRow(g, cuts)?.[4] ?? '').join('')
    // Preserve the exponent in its baseline group before validating the pair.
    if (!/^(?:t=|2χ=|χ2=)[\d.]+,P[=<>][\d.]+$/.test(value)) return
    const label = region.filter((i) => col(i) === 0)
    if (!label.length || !label.some((i) => /\p{L}/u.test(i.text))) return
    const categories = region.filter((i) => col(i) === 1)
    if (end - start === 1) {
      if (categories.some((i) => !/^[\p{L}±(),.\s-]+$/u.test(i.text))) return
      spans.push({ row: start + 1, column: 0, rowSpan: 1, colSpan: 2 })
    } else {
      if (
        !groups
          .slice(start, end)
          .every((_, r) =>
            categories.some(
              (i) =>
                (i.rect[1] + i.rect[3]) / 2 >= ys[start + r] &&
                (i.rect[1] + i.rect[3]) / 2 < ys[start + r + 1]
            )
          )
      )
        return
      spans.push({ row: start + 1, column: 0, rowSpan: end - start, colSpan: 1 })
    }
    spans.push({ row: start + 1, column: 4, rowSpan: end - start, colSpan: 1 })
    owned.push(region)
  }
  if (!hasUniqueRecordTokens([...header, ...body], owned)) return
  return {
    rows: [
      [left, union(header)[1], right, divider],
      ...groups.map((_, n) => [left, ys[n], right, ys[n + 1]])
    ],
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans,
    completeSpans: true,
    headerRows: [0],
    ownedTokens: new Set([...header, ...body])
  }
}
