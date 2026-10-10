/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
import {
  readSourceRow,
  hasUniqueRecordTokens,
  groupSourceRowsWithScripts
} from './literature-pdf-source-records.mjs'
import { recoverNativeStackedUncertainty } from './literature-pdf-native-stacked-uncertainty.mjs'
import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'
import { nativeMeasuredWordTokens } from './literature-pdf-native-scalar-record-grid.mjs'

// Measured native word gaps may separate several indicator headings emitted
// in one PDF text operation. A closed frame and repeated label/check records
// establish the leaves without trusting a detector's wide header span.
export function recoverNativeIndicatorRecordPlan(table, items, captions, rules, observations) {
  const crop = table.cropRect,
    near = items.filter(
      (i) =>
        i.horizontal &&
        i.text.trim() &&
        i.rect[0] < crop[2] &&
        i.rect[2] > crop[0] &&
        i.baseline > crop[1] &&
        i.baseline < crop[3]
    ),
    h = median(near.map((i) => i.height))
  if (!(h > 0)) return
  const full = joinHorizontalTableRules(rules)
    .filter(
      (r) =>
        r[1] >= crop[1] - h &&
        r[1] <= crop[3] + h &&
        Math.abs(r[0] - crop[0]) < h &&
        Math.abs(r[2] - crop[2]) < h
    )
    .sort((a, b) => a[1] - b[1])
  if (
    full.length !== 3 ||
    full.some((r) => Math.abs(r[0] - full[0][0]) > 0.02 || Math.abs(r[2] - full[0][2]) > 0.02)
  )
    return
  const [opening, divider, closing] = full,
    original = items.filter(
      (i) =>
        i.text.trim() &&
        i.rect[0] < opening[2] &&
        i.rect[2] > opening[0] &&
        i.rect[3] > opening[1] &&
        i.rect[1] < closing[1]
    )
  if (
    original.some(
      (i) =>
        !i.horizontal ||
        Math.abs(i.height - h) > h * 0.05 ||
        i.rect[0] < opening[0] - 0.02 ||
        i.rect[2] > opening[2] + 0.02 ||
        i.rect[1] < opening[1] ||
        i.rect[3] > closing[1]
    )
  )
    return
  if (
    captions.filter(
      (c) =>
        captionKind(c.lines[0]) === 'table' &&
        c.rect[0] < opening[2] &&
        c.rect[2] > opening[0] &&
        ((c.rect[3] < opening[1] && opening[1] - c.rect[3] < h * 8) ||
          (c.rect[1] > closing[1] && c.rect[1] - closing[1] < h * 8))
    ).length !== 1
  )
    return
  const replacement = new Map(
      original.map((i) => [
        i,
        i.baseline < divider[1] ? nativeMeasuredWordTokens(i, observations ?? [], h) : [i]
      ])
    ),
    source = original.flatMap((i) => replacement.get(i)),
    header = source.filter((i) => i.baseline < divider[1]),
    body = source.filter((i) => i.baseline > divider[1]),
    projections = []
  for (const i of [...header].sort((a, b) => a.rect[0] - b.rect[0])) {
    const last = projections.at(-1)
    if (last && i.rect[0] - last[1] < h * 0.3) last[1] = Math.max(last[1], i.rect[2])
    else projections.push([i.rect[0], i.rect[2]])
  }
  if (projections.length < 4 || projections.length > 12) return
  const cuts = [
    Math.min(opening[0], ...source.map((i) => i.rect[0])),
    ...projections.slice(1).map((r, n) => (projections[n][1] + r[0]) / 2),
    Math.max(opening[2], ...source.map((i) => i.rect[2]))
  ]
  // A long label can approach the first heading. The complete native source
  // gutter still has to remain positive before its neighboring check lane.
  const stubs = body.filter((i) => /\p{L}/u.test(i.text)),
    checks = body.filter((i) => /^[✓✗]$/.test(i.text.trim()))
  if (!stubs.length || checks.length < 4 || stubs.length + checks.length !== body.length) return
  const a = Math.max(projections[0][1], ...stubs.map((i) => i.rect[2])),
    b = Math.min(projections[1][0], ...checks.map((i) => i.rect[0]))
  if (b - a < h * 0.3) return
  cuts[1] = (a + b) / 2
  const records = []
  for (const g of groupSourceRowsWithScripts(
    [...body].sort((a, b) => a.baseline - b.baseline),
    h,
    0.1
  ) ?? []) {
    const v = readSourceRow(g, cuts)
    if (!v) return
    if (v[0] && v.slice(1).some(Boolean)) {
      if (v.slice(1).some((s) => s && !/^[✓✗]$/.test(s))) return
      records.push([...g])
    } else if (v[0] && v.slice(1).every((s) => !s) && records.length) {
      if (g[0].baseline - records.at(-1).at(-1).baseline > h * 1.6) return
      records.at(-1).push(...g)
    } else return
  }
  if (
    records.length < 4 ||
    !hasUniqueRecordTokens(source, [header, ...records]) ||
    !readSourceRow(header, cuts, { multiline: true })?.every((v) => /\p{L}/u.test(v))
  )
    return
  const bounds = records.map((r) => [
    Math.min(...r.map((i) => i.rect[1])),
    Math.max(...r.map((i) => i.rect[3]))
  ])
  if (bounds.some((r, n) => n && r[0] <= bounds[n - 1][1])) return
  const ys = [
      opening[1],
      divider[1],
      ...bounds.slice(1).map((r, n) => (bounds[n][1] + r[0]) / 2),
      closing[1]
    ],
    grid = {
      cropRect: [cuts[0], opening[1], cuts.at(-1), closing[1]],
      rows: ys.slice(1).map((y, n) => [cuts[0], ys[n], cuts.at(-1), y]),
      columns: cuts.slice(1).map((x, n) => [cuts[n], opening[1], x, closing[1]]),
      spans: [],
      headerRows: [0],
      completeSpans: true,
      preservePhysicalRows: true,
      ownedTokens: new Set(source),
      repair: 'native-body-records-recovered'
    }
  return { grid, pageItems: items.flatMap((i) => replacement.get(i) ?? [i]) }
}

const centerY = (i) => (i.rect[1] + i.rect[3]) / 2
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

// A complete ruled header and complete native numerical records prove the
// leaf lanes independently of model cuts. In particular, an interval remains
// one field and a model row cannot absorb the preceding header/first record.
export function recoverCompleteNativeLeafRecords(table, items, captions, rules) {
  const crop = table.cropRect,
    near = items.filter(
      (i) =>
        i.horizontal &&
        i.text.trim() &&
        i.rect[0] < crop[2] &&
        i.rect[2] > crop[0] &&
        i.baseline > crop[1] &&
        i.baseline < crop[3]
    ),
    em = median(near.map((i) => i.height))
  if (!(em > 0)) return
  const full = joinHorizontalTableRules(rules)
    .filter(
      (r) =>
        r[1] >= crop[1] - em &&
        r[1] <= crop[3] + em &&
        Math.abs(r[0] - crop[0]) < em &&
        Math.abs(r[2] - crop[2]) < em
    )
    .sort((a, b) => a[1] - b[1])
  if (
    full.length !== 3 ||
    full.some((r) => Math.abs(r[0] - full[0][0]) > 0.05 || Math.abs(r[2] - full[0][2]) > 0.05)
  )
    return
  const [opening, divider, closing] = full,
    source = items.filter(
      (i) =>
        i.horizontal &&
        i.text.trim() &&
        i.rect[0] < opening[2] &&
        i.rect[2] > opening[0] &&
        i.rect[3] > opening[1] &&
        i.rect[1] < closing[1]
    )
  if (
    source.some(
      (i) =>
        i.rect[0] < opening[0] ||
        i.rect[2] > opening[2] ||
        i.rect[1] < opening[1] ||
        i.rect[3] > closing[1]
    )
  )
    return
  if (
    captions.filter(
      (c) =>
        captionKind(c.lines[0]) === 'table' &&
        c.rect[0] < opening[2] &&
        c.rect[2] > opening[0] &&
        ((c.rect[3] < opening[1] && opening[1] - c.rect[3] < em * 8) ||
          (c.rect[1] > closing[1] && c.rect[1] - closing[1] < em * 3))
    ).length !== 1
  )
    return
  const header = source.filter((i) => i.baseline < divider[1]),
    body = source.filter((i) => i.baseline > divider[1]),
    headerRows = groupSourceRowsWithScripts(
      [...header].sort((a, b) => a.baseline - b.baseline),
      em,
      0.15
    ),
    records = groupSourceRowsWithScripts(
      [...body].sort((a, b) => a.baseline - b.baseline),
      em,
      0.15
    )
  if (
    headerRows?.length !== 1 ||
    !records ||
    records.length < 2 ||
    !hasUniqueRecordTokens(source, [header, ...records])
  )
    return
  // Literal numerical separators can delimit several leaves below a parent.
  // Their repeated native proof owns that topology; proximity alone does not.
  if (body.some((i) => i.text.trim() === '|')) return
  const lanes = (row) => {
    const groups = []
    for (const i of [...row].sort((a, b) => a.rect[0] - b.rect[0])) {
      const last = groups.at(-1)
      if (last && i.rect[0] - Math.max(...last.map((j) => j.rect[2])) < em * 0.65) last.push(i)
      else groups.push([i])
    }
    return groups
  }
  const groups = [lanes(header), ...records.map(lanes)],
    count = groups[0].length
  if (
    count < 3 ||
    count > 10 ||
    groups.some((g) => g.length !== count) ||
    groups[0].some((g) => !g.some((i) => /\p{L}/u.test(i.text))) ||
    groups
      .slice(1)
      .some(
        (g) =>
          !g[0].some((i) => /[\p{L}\p{N}]/u.test(i.text)) ||
          g.slice(1).some((lane) => !lane.some((i) => /\d/.test(i.text)))
      )
  )
    return
  const cuts = [opening[0]]
  for (let c = 1; c < count; c++) {
    const a = Math.max(...groups.flatMap((g) => g[c - 1].map((i) => i.rect[2]))),
      b = Math.min(...groups.flatMap((g) => g[c].map((i) => i.rect[0])))
    if (b - a < em * 0.3) return
    cuts.push((a + b) / 2)
  }
  cuts.push(opening[2])
  if ([header, ...records].some((r) => !readSourceRow(r, cuts))) return
  const bounds = records.map((r) => [
    Math.min(...r.map((i) => i.rect[1])),
    Math.max(...r.map((i) => i.rect[3]))
  ])
  if (bounds.some((r, n) => n && r[0] <= bounds[n - 1][1])) return
  const edges = [
    opening[1],
    divider[1],
    ...bounds.slice(1).map((r, n) => (bounds[n][1] + r[0]) / 2),
    closing[1]
  ]
  return {
    cropRect: [opening[0], opening[1], opening[2], closing[1]],
    rows: edges.slice(1).map((y, n) => [opening[0], edges[n], opening[2], y]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], opening[1], x, closing[1]]),
    spans: [],
    headerRows: [0],
    completeSpans: true,
    ownedTokens: new Set(source),
    repair: 'native-body-records-recovered'
  }
}
function frame(table, items, captions, rules, count) {
  const crop = table.cropRect,
    columns = table.structure.objects
      .filter((o) => o.label === 'table column')
      .map((o) => o.rect)
      .sort((a, b) => a[0] - b[0]),
    nearby = items.filter(
      (i) =>
        i.rect[0] >= crop[0] && i.rect[2] <= crop[2] && centerY(i) > crop[1] && centerY(i) < crop[3]
    ),
    height = median(nearby.map((i) => i.height))
  if (columns.length !== 5 || !(height > 0)) return
  const full = rules
    .filter(
      (r) =>
        r[1] === r[3] &&
        r[1] > crop[1] - height &&
        r[1] < crop[3] + height &&
        Math.abs(r[0] - crop[0]) < height &&
        Math.abs(r[2] - crop[2]) < height
    )
    .sort((a, b) => a[1] - b[1])
  if (
    full.length !== count ||
    full.some((r) => Math.abs(r[0] - full[0][0]) > 0.02 || Math.abs(r[2] - full[0][2]) > 0.02)
  )
    return
  const [opening, divider] = full,
    closing = full.at(-1)
  if (
    Math.abs(opening[1] - crop[1]) > height ||
    Math.abs(closing[1] - crop[3]) > height ||
    divider[1] - opening[1] < height ||
    divider[1] - opening[1] > height * 3.5
  )
    return
  const titles = captions.filter(
      (c) => captionKind(c.lines[0]) === 'table' && c.rect[0] < closing[2] && c.rect[2] > closing[0]
    ),
    above = titles.filter((c) => c.rect[3] < opening[1] && opening[1] - c.rect[3] < height * 2),
    below = titles.filter(
      (c) =>
        c.rect[1] > closing[1] - height * 0.1 &&
        c.rect[3] > closing[1] &&
        c.rect[1] - closing[1] < height * 2
    )
  if ((above.length ? above : below).length !== 1) return
  const cuts = [
      crop[0],
      ...columns.slice(1).map((c, n) => crop[0] + (columns[n][2] + c[0]) / 2),
      crop[2]
    ],
    source = nearby.filter((i) => i.rect[1] >= opening[1] && i.rect[3] <= closing[1]),
    header = source.filter((i) => i.baseline <= divider[1]),
    body = source.filter((i) => i.baseline > divider[1])
  if (
    !hasUniqueRecordTokens(source, [header, body]) ||
    nearby.some((i) => centerY(i) > opening[1] && centerY(i) < closing[1] && !source.includes(i)) ||
    !readSourceRow(header, cuts, { multiline: true })?.every((v) => /\p{L}/u.test(v))
  )
    return
  return { crop, cuts, source, header, body, height, full, divider, closing }
}
function grid(proof, records, edges, spans = []) {
  const { crop, cuts, source, header } = proof
  if (
    edges.length !== records.length + 2 ||
    edges.some((y, n) => n && y <= edges[n - 1]) ||
    !hasUniqueRecordTokens(source, [header, ...records])
  )
    return
  return {
    cropRect: crop,
    rows: edges.slice(1).map((y, n) => [crop[0], edges[n], crop[2], y]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], crop[1], x, crop[3]]),
    spans,
    headerRows: [0],
    completeSpans: true,
    ownedTokens: new Set(source),
    repair: 'native-body-records-recovered'
  }
}

// Three native full-width rules, one complete header, and uniformly spaced
// five-lane decimal/arrow records prove rows omitted by the model. Recognition
// strings never replace the original fragments or their source rectangles.
export function recoverNativePairedRecordGrid(table, items, captions, rules) {
  const p = frame(table, items, captions, rules, 3)
  if (!p) return
  const records = []
  for (const i of [...p.body].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    const row = records.at(-1)
    if (row && Math.abs(i.baseline - row[0].baseline) < p.height * 0.05) row.push(i)
    else records.push([i])
  }
  if (
    records.length < 3 ||
    records.length > 12 ||
    p.body.some((i) => Math.abs(i.height - p.height) > p.height * 0.05)
  )
    return
  const values = records.map((r) => readSourceRow(r, p.cuts)),
    gaps = records.slice(1).map((r, n) => r[0].baseline - records[n][0].baseline),
    leading = median(gaps)
  if (
    values.some(
      (v) =>
        !v ||
        !/^\d+\.\d+$/.test(v[0]) ||
        !v.slice(1).every((t) => /^[−-]?\d+\.\d+→[−-]?\d+\.\d+$/.test(t))
    ) ||
    leading < p.height * 1.05 ||
    leading > p.height * 1.5 ||
    gaps.some((g) => Math.abs(g - leading) > p.height * 0.05) ||
    records[0].some((i) => i.rect[1] < p.divider[1])
  )
    return
  const edges = [
    p.crop[1],
    p.divider[1],
    ...records
      .slice(1)
      .map((r, n) => (Math.max(...records[n].map(centerY)) + Math.min(...r.map(centerY))) / 2),
    p.crop[3]
  ]
  return grid(p, records, edges)
}

// A native separator proves shared left labels independently of the leaf
// records. Two checkmark lanes, a text anchor and a uniquely connected radical
// bar in every record establish ownership, including full-em root overhang.
export function recoverNativeGroupedFlagRecordGrid(table, items, captions, rules) {
  const p = frame(table, items, captions, rules, 4)
  if (!p) return
  const separator = p.full[2],
    column = (i) => p.cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x),
    stub = p.body.filter((i) => column(i) === 0),
    leaf = p.body.filter((i) => column(i) > 0),
    anchors = leaf.filter((i) => column(i) === 1).sort((a, b) => a.baseline - b.baseline)
  if (
    anchors.length < 5 ||
    anchors.length > 12 ||
    anchors.some(
      (i) =>
        !/^\p{L}[\p{L}\p{N}\s.(),-]*$/u.test(i.text) ||
        Math.abs(i.height - p.height) > p.height * 0.05
    ) ||
    !readSourceRow(leaf, p.cuts, { multiline: true })
  )
    return
  const groups = [
    anchors.filter((i) => i.baseline < separator[1]),
    anchors.filter((i) => i.baseline > separator[1])
  ]
  if (groups.some((g) => g.length < 2)) return
  const leading = median(
    groups.flatMap((g) => g.slice(1).map((i, n) => i.baseline - g[n].baseline))
  )
  if (
    leading < p.height * 1.5 ||
    leading > p.height * 2 ||
    groups.some((g) =>
      g.slice(1).some((i, n) => Math.abs(i.baseline - g[n].baseline - leading) > p.height * 0.05)
    )
  )
    return
  const records = anchors.map((a) => [a]),
    assigned = new Set(anchors)
  const bars = rules.filter(
    (r) =>
      r[1] === r[3] &&
      r[0] > p.cuts[4] &&
      r[2] < p.cuts[5] &&
      r[1] > p.divider[1] &&
      r[1] < p.closing[1] &&
      r[2] - r[0] > p.height * 0.5 &&
      r[2] - r[0] < p.height * 2
  )
  if (bars.length !== anchors.length) return
  for (const bar of bars) {
    const roots = leaf.filter(
        (i) =>
          column(i) === 4 &&
          Math.abs(i.height - p.height) < p.height * 0.05 &&
          Math.abs(i.rect[2] - bar[0]) < p.height * 0.02 &&
          Math.abs(i.baseline - bar[1]) < p.height * 0.05
      ),
      owners = anchors.filter(
        (a) =>
          a.baseline - bar[1] > p.height * 0.65 &&
          a.baseline - bar[1] < p.height &&
          leaf.some(
            (i) =>
              column(i) === 4 &&
              Math.abs(i.baseline - a.baseline) < p.height * 0.05 &&
              i.rect[0] >= bar[0] - p.height * 0.02 &&
              i.rect[2] <= bar[2] + p.height * 0.02
          )
      )
    if (roots.length !== 1 || owners.length !== 1 || assigned.has(roots[0])) return
    records[anchors.indexOf(owners[0])].push(roots[0])
    assigned.add(roots[0])
  }
  for (const i of leaf.filter((i) => !assigned.has(i))) {
    const owners = anchors.filter((a) => Math.abs(i.baseline - a.baseline) < p.height * 0.4)
    if (owners.length !== 1) return
    records[anchors.indexOf(owners[0])].push(i)
    assigned.add(i)
  }
  if (
    records.some(
      (r) =>
        !readSourceRow(r, p.cuts)
          ?.slice(2, 4)
          .every((v) => /^[✓✗]$/.test(v)) || !readSourceRow(r, p.cuts)?.[4].endsWith(')')
    )
  )
    return
  const stubGroups = [
    stub.filter((i) => i.rect[1] > p.divider[1] && i.rect[3] < separator[1]),
    stub.filter((i) => i.rect[1] > separator[1] && i.rect[3] < p.closing[1])
  ]
  if (
    !hasUniqueRecordTokens(stub, stubGroups) ||
    stubGroups.some((g) => g.length < 2 || !readSourceRow(g, p.cuts, { multiline: true })?.[0])
  )
    return
  const edges = [p.crop[1], p.divider[1]],
    spans = []
  for (let g = 0; g < groups.length; g++) {
    const first = anchors.indexOf(groups[g][0])
    spans.push({ row: first + 1, column: 0, rowSpan: groups[g].length, colSpan: 1 })
    for (let n = 1; n < groups[g].length; n++) {
      const before = records[first + n - 1],
        next = records[first + n],
        bottom = Math.max(...before.map(centerY)),
        top = Math.min(...next.map(centerY))
      if (bottom >= top) return
      edges.push((bottom + top) / 2)
    }
    edges.push(g === 0 ? separator[1] : p.crop[3])
    records[first].push(...stubGroups[g])
  }
  return grid(p, records, edges, spans)
}
const union = (a) => [
  Math.min(...a.map((i) => i.rect[0])),
  Math.min(...a.map((i) => i.rect[1])),
  Math.max(...a.map((i) => i.rect[2])),
  Math.max(...a.map((i) => i.rect[3]))
]
export function recoverSmallCompleteRecordGrid(table, items, captions, rules) {
  if (table.structure.objects.filter((o) => o.label === 'table column').length !== 9) return
  const crop = table.cropRect,
    ids = items
      .filter(
        (i) =>
          i.horizontal &&
          /^\d{6,20}$/.test(i.text) &&
          i.rect[0] >= crop[0] &&
          i.rect[2] <= crop[2] &&
          i.baseline > crop[1] &&
          i.baseline < crop[3]
      )
      .sort((a, b) => a.baseline - b.baseline),
    height = ids[0]?.height
  if (ids.length !== 3 || !height) return
  const full = rules
    .filter(
      (r) =>
        r[1] === r[3] &&
        Math.abs(r[0] - crop[0]) < height &&
        Math.abs(r[2] - crop[2]) < height &&
        r[1] > crop[1] - height &&
        r[1] < crop[3] + height
    )
    .sort((a, b) => a[1] - b[1])
  if (
    full.length !== 4 ||
    full.some((r) => Math.abs(r[0] - full[0][0]) > 0.02 || Math.abs(r[2] - full[0][2]) > 0.02) ||
    full[1][1] - full[0][1] < height * 0.15 ||
    full[1][1] - full[0][1] > height * 0.3
  )
    return
  const [top, , divider, close] = full,
    frame = [top[0], top[1], top[2], close[1]],
    source = items.filter(
      (i) =>
        i.horizontal &&
        i.rect[0] >= frame[0] &&
        i.rect[2] <= frame[2] &&
        i.baseline > frame[1] &&
        i.baseline < frame[3]
    )
  if (
    items.some(
      (i) =>
        i.text.trim() &&
        i.rect[0] < frame[2] &&
        i.rect[2] > frame[0] &&
        i.rect[1] < frame[3] &&
        i.rect[3] > frame[1] &&
        !source.includes(i)
    )
  )
    return
  if (
    captions.filter(
      (c) =>
        captionKind(c.lines[0]) === 'table' &&
        c.rect[3] < top[1] &&
        top[1] - c.rect[3] < height * 3 &&
        c.rect[0] < top[2] &&
        c.rect[2] > top[0]
    ).length !== 1
  )
    return
  const header = source.filter((i) => i.baseline <= divider[1]),
    body = source.filter((i) => i.baseline > divider[1]),
    head = header
      .filter(
        (i) =>
          Math.abs(i.height - height) < height * 0.03 &&
          Math.abs(i.baseline - header[0].baseline) < height * 0.03 &&
          /\p{L}/u.test(i.text)
      )
      .sort((a, b) => a.rect[0] - b.rect[0])
  const leading = ids[1].baseline - ids[0].baseline
  if (
    head.length !== 9 ||
    ids.some((i) => !body.includes(i)) ||
    !Number.isFinite(leading) ||
    leading < height ||
    leading > height * 2 ||
    Math.abs(ids[2].baseline - ids[1].baseline - leading) > height * 0.03
  )
    return
  const centers = head.map((i) => (i.rect[0] + i.rect[2]) / 2),
    initial = [frame[0], ...centers.slice(1).map((v, n) => (v + centers[n]) / 2), frame[2]],
    lane = (i) => initial.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x),
    rows = ids.map(() => [])
  for (const i of body) {
    const owners = ids
      .map((a, n) => ({ a, n }))
      .filter(({ a }) => Math.abs(i.baseline - a.baseline) < height * 0.65)
    if (owners.length !== 1) return
    rows[owners[0].n].push(i)
  }
  if (!hasUniqueRecordTokens(source, [header, ...rows])) return
  const cuts = [crop[0]]
  for (let c = 1; c < 9; c++) {
    const left = union(source.filter((i) => lane(i) === c - 1))[2],
      right = union(source.filter((i) => lane(i) === c))[0]
    if (right - left < height * 0.05) return
    cuts.push((left + right) / 2)
  }
  cuts.push(crop[2])
  if (!readSourceRow(header, cuts, { multiline: true })?.every((v) => /\p{L}/u.test(v))) return
  const stacks = []
  for (const row of rows) {
    const v = readSourceRow(row, cuts),
      group = row.filter((i) => lane(i) === 1),
      ctx = { tokens: new Set(group), divider: divider[1], smallFontBoundary: true },
      pair = recoverNativeStackedUncertainty(group, rules, [ctx])
    if (
      !v ||
      !/^\d{6,20}$/.test(v[0]) ||
      !pair ||
      !v.slice(2, 6).every((t) => /^[−-]?\d+\.\d+$/.test(t)) ||
      !/\p{L}/u.test(v[6]) ||
      !v.slice(7).every((t) => /^[−-]?\d+\.\d+$/.test(t))
    )
      return
    stacks.push(ctx)
  }
  const boundaries = []
  for (let n = 1; n < rows.length; n++) {
    const before = Math.max(...rows[n - 1].map((i) => (i.rect[1] + i.rect[3]) / 2)),
      after = Math.min(...rows[n].map((i) => (i.rect[1] + i.rect[3]) / 2))
    if (after <= before) return
    boundaries.push((before + after) / 2)
  }
  const edges = [crop[1], divider[1], ...boundaries, crop[3]]
  return {
    cropRect: crop,
    rows: edges.slice(1).map((y, n) => [crop[0], edges[n], crop[2], y]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], crop[1], x, crop[3]]),
    headerRows: [0],
    spans: [],
    ownedTokens: new Set(source),
    equalFontStacks: stacks,
    completeSpans: true,
    preservePhysicalRows: true,
    repair: 'native-body-records-recovered'
  }
}
