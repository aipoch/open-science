/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'
import { readSourceRow, hasUniqueRecordTokens } from './literature-pdf-source-records.mjs'
import {
  nativeMeasuredWordTokens,
  partitionNativeScalarFields
} from './literature-pdf-native-scalar-record-grid.mjs'
const box = (items) => [
  Math.min(...items.map((i) => i.rect[0])),
  Math.min(...items.map((i) => i.rect[1])),
  Math.max(...items.map((i) => i.rect[2])),
  Math.max(...items.map((i) => i.rect[3]))
]
const literal = (items) =>
  items
    .map((i) => i.text)
    .join('')
    .replace(/\s/gu, '')

// Two explicitly separated complete cohorts prove the repeated record sequence.
// The final cohort is accepted only with the very same independently printed
// tuple/label sequence and every value present. No closing stroke is invented.
export function recoverNativeRepeatedTuplePlan(table, items, captions, rules, observations = []) {
  const crop = table.cropRect
  const near = items.filter(
    (i) =>
      i.text?.trim() &&
      i.rect[0] < crop[2] &&
      i.rect[2] > crop[0] &&
      i.baseline > crop[1] &&
      i.baseline < crop[3]
  )
  if (!near.length) return
  const h = near.map((i) => i.height).sort((a, b) => a - b)[Math.floor(near.length / 2)]
  if (!(h > 0)) return
  const full = joinHorizontalTableRules(rules)
    .filter(
      (r) =>
        r[1] >= crop[1] - h &&
        r[1] < crop[3] &&
        Math.abs(r[0] - crop[0]) < h &&
        Math.abs(r[2] - crop[2]) < h
    )
    .sort((a, b) => a[1] - b[1])
  if (
    full.length < 3 ||
    full.length > 4 ||
    full.some((r) => Math.abs(r[0] - full[0][0]) > 0.05 || Math.abs(r[2] - full[0][2]) > 0.05)
  )
    return
  const [opening, divider, ...separators] = full
  if (divider[1] - opening[1] < h * 2 || divider[1] - opening[1] > h * 4) return
  if (
    !captions.some(
      (c) =>
        captionKind(c.lines[0]) === 'table' &&
        c.rect[3] <= opening[1] &&
        opening[1] - c.rect[3] < h * 4 &&
        c.rect[0] < opening[2] &&
        c.rect[2] > opening[0]
    )
  )
    return
  const original = items.filter(
    (i) =>
      i.text?.trim() &&
      i.rect[0] < opening[2] &&
      i.rect[2] > opening[0] &&
      i.baseline > opening[1] &&
      i.baseline < crop[3]
  )
  if (
    original.some(
      (i) =>
        i.horizontal === false ||
        i.rect[0] < opening[0] ||
        i.rect[2] > opening[2] ||
        i.height < h * 0.55 ||
        i.height > h * 1.04 ||
        i.rect.some((v) => !Number.isFinite(v))
    )
  )
    return
  const replacement = new Map(
      original.map((i) => [i, nativeMeasuredWordTokens(i, observations, h)])
    ),
    source = original.flatMap((i) => replacement.get(i))
  const header = source.filter((i) => i.baseline < divider[1]),
    body = source.filter((i) => i.baseline > divider[1])
  if (body.some((i) => Math.abs(i.height - h) > h * 0.04)) return
  const leafY = Math.max(
    ...header.filter((i) => Math.abs(i.height - h) < h * 0.04).map((i) => i.baseline)
  )
  const leaf = header.filter((i) => Math.abs(i.baseline - leafY) < h * 0.04)
  const leafSorted = [...leaf].sort((a, b) => a.rect[0] - b.rect[0])
  const firstGaps = leafSorted
    .slice(1)
    .map((i, n) => [leafSorted[n].rect[2], i.rect[0]])
    .filter(([a, b]) => b - a > h)
  if (!firstGaps.length) return
  const firstGap = firstGaps[0],
    initialCut = (firstGap[0] + firstGap[1]) / 2
  const missingStubHeader = /^\(/u.test(leafSorted[0].text)
  const initialLabels = body.filter((i) =>
    missingStubHeader
      ? /\p{L}/u.test(i.text) && (i.rect[0] + i.rect[2]) / 2 < leafSorted[0].rect[0]
      : (i.rect[0] + i.rect[2]) / 2 < initialCut
  )
  const others = body.filter((i) => !initialLabels.includes(i)),
    a = Math.max(...initialLabels.map((i) => i.rect[2])),
    b = Math.min(...others.map((i) => i.rect[0]))
  if (!initialLabels.length || !others.length || b - a < h * 0.1) return
  const groupCut = (a + b) / 2,
    labels = initialLabels,
    ink = others,
    cohortCount = separators.length + 1
  if (
    labels.length < cohortCount ||
    labels.length > cohortCount * 3 ||
    ink.length + labels.length !== body.length
  )
    return
  const physical = []
  for (const i of [...ink].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    const row = physical.at(-1)
    if (row && Math.abs(row[0].baseline - i.baseline) < h * 0.04) row.push(i)
    else physical.push([i])
  }
  const parsed = physical.map((r) => partitionNativeScalarFields(r, h, true))
  if (
    parsed.some((p) => !p) ||
    parsed.some(
      (p) =>
        p.groups.length !== parsed[0].groups.length || p.prefix.length !== parsed[0].prefix.length
    )
  )
    return
  const bounds = [divider[1], ...separators.map((r) => r[1]), crop[3]]
  const cohortRows = bounds
    .slice(1)
    .map((y, n) => physical.filter((r) => r[0].baseline > bounds[n] && r[0].baseline < y))
  if (
    cohortRows[0].length < 4 ||
    cohortRows[0].length > 8 ||
    cohortRows.some((r) => r.length !== cohortRows[0].length)
  )
    return
  const keys = (rows) =>
    rows.map((r) => {
      const p = parsed[physical.indexOf(r)]
      return literal(p.prefix.length ? p.prefix : p.groups[0])
    })
  if (
    new Set(keys(cohortRows[0])).size !== cohortRows[0].length ||
    cohortRows.slice(1).some((r) => JSON.stringify(keys(r)) !== JSON.stringify(keys(cohortRows[0])))
  )
    return
  const groups = []
  for (let n = 0; n < cohortCount; n++) {
    const own = labels.filter((i) => i.rect[1] >= bounds[n] && i.rect[3] <= bounds[n + 1])
    if (
      !own.length ||
      own.some((i) => Math.abs(i.baseline - own[0].baseline) > h * 0.04) ||
      Math.abs((box(own)[1] + box(own)[3]) / 2 - (bounds[n] + bounds[n + 1]) / 2) > h
    )
      return
    groups.push(own)
  }
  const count = parsed[0].groups.length,
    prefixCount = parsed[0].prefix.length ? 1 : 0,
    cuts = [crop[0], groupCut]
  if (prefixCount) {
    const a = Math.max(...parsed.map((p) => box(p.prefix)[2])),
      b = Math.min(...parsed.map((p) => box(p.groups[0])[0]))
    if (b - a < h * 0.1) return
    cuts.push((a + b) / 2)
  }
  for (let n = 1; n < count; n++) {
    const a = Math.max(...parsed.map((p) => box(p.groups[n - 1])[2])),
      b = Math.min(...parsed.map((p) => box(p.groups[n])[0]))
    if (b - a < h * 0.1) return
    cuts.push((a + b) / 2)
  }
  cuts.push(crop[2])
  if (
    physical.some((r, n) => {
      const v = readSourceRow(r, cuts)
      return (
        !v ||
        r.some((i) => !cuts.slice(1).some((x, k) => i.rect[0] >= cuts[k] && i.rect[2] <= x)) ||
        v
          .slice(1 + prefixCount)
          .some((s, k) => s.replace(/\s/gu, '') !== literal(parsed[n].groups[k]))
      )
    })
  )
    return
  const title = header.filter((i) => !leaf.includes(i)),
    titleColumns = title.map((i) => {
      const slots = cuts
        .slice(1)
        .map((x, n) => (i.rect[0] < x && i.rect[2] > cuts[n] ? n : -1))
        .filter((n) => n >= 0)
      return slots
    })
  const parentColumns = [...new Set(titleColumns.flat())].sort((a, b) => a - b)
  const simpleHeader = titleColumns.every((s) => s.length === 1),
    headerRows = simpleHeader ? [0] : [0, 1],
    spans = []
  if (!simpleHeader) {
    const broad = title.filter((_i, n) => titleColumns[n].length > 1),
      broadCols = [...new Set(broad.flatMap((i) => titleColumns[title.indexOf(i)]))].sort(
        (a, b) => a - b
      )
    if (
      broadCols.length < 2 ||
      broadCols.some((n, k) => n !== broadCols[0] + k) ||
      broadCols[0] < 2 ||
      broadCols.at(-1) > cuts.length - 2
    )
      return
    const siblings = readSourceRow(leaf, cuts)?.slice(broadCols[0], broadCols.at(-1) + 1)
    if (!siblings?.every((s) => /^\p{L}\s*=\s*\d+$/u.test(s))) return
    spans.push({ row: 0, column: broadCols[0], rowSpan: 1, colSpan: broadCols.length })
  }
  if (simpleHeader && parentColumns.some((n) => n < 0)) return
  const headerOwned = simpleHeader ? [header] : [title, leaf],
    edges = [box(header)[1]]
  if (!simpleHeader) {
    const a = Math.max(...title.map((i) => i.rect[3])),
      b = Math.min(...leaf.map((i) => i.rect[1]))
    if (b < a) return
    edges.push((a + b) / 2)
  }
  edges.push(divider[1])
  for (let n = 1; n < physical.length; n++) {
    const a = box(physical[n - 1])[3],
      b = box(physical[n])[1]
    if (b - a < h * 0.04) return
    const s = separators.filter((r) => r[1] >= a && r[1] <= b)
    if (s.length > 1) return
    edges.push(s.length ? s[0][1] : (a + b) / 2)
  }
  edges.push(Math.max(...source.map((i) => i.rect[3])))
  const offset = headerRows.length,
    groupSize = cohortRows[0].length
  for (let n = 0; n < cohortCount; n++)
    spans.push({ row: offset + n * groupSize, column: 0, rowSpan: groupSize, colSpan: 1 })
  const owners = [
    ...headerOwned,
    ...physical.map((r, n) =>
      n % groupSize === 0 ? [...r, ...groups[Math.floor(n / groupSize)]] : r
    )
  ]
  if (!hasUniqueRecordTokens(source, owners)) return
  return {
    pageItems: items.flatMap((i) => replacement.get(i) ?? [i]),
    grid: {
      rows: edges.slice(1).map((y, n) => [crop[0], edges[n], crop[2], y]),
      columns: cuts.slice(1).map((x, n) => [cuts[n], crop[1], x, crop[3]]),
      headerRows,
      spans,
      completeSpans: true,
      ownedTokens: new Set(source),
      preservePhysicalRows: true,
      repair: 'native-body-records-recovered'
    }
  }
}
