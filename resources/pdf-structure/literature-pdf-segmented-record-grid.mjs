/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
import { union } from './literature-pdf-table-geometry.mjs'
import {
  tableSourceItems,
  readSourceRow,
  hasUniqueRecordTokens
} from './literature-pdf-source-records.mjs'

// Word tables preserve a small gap between adjacent cell border strokes. The
// same cuts on every ruled band provide stronger evidence than model columns.
// Within a tall cell, split only complete, aligned pairs of numeric records.
export function recoverSegmentedRecordGrid(table, items, rules) {
  const [left, top, right, bottom] = table.cropRect
  const bands = []
  for (const r of rules
    .filter((r) => r[1] === r[3] && r[1] >= top - 3 && r[1] <= bottom + 3)
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])) {
    let band = bands.find((b) => Math.abs(b.y - r[1]) < 0.05)
    if (!band) bands.push((band = { y: r[1], parts: [] }))
    band.parts.push(r)
  }
  const valid = bands.filter(
    (b) =>
      b.parts.length >= 3 &&
      b.parts.length <= 10 &&
      Math.abs(b.parts[0][0] - left) < 15 &&
      Math.abs(b.parts.at(-1)[2] - right) < 40 &&
      b.parts.slice(1).every((r, n) => r[0] - b.parts[n][2] > 0.1 && r[0] - b.parts[n][2] < 1)
  )
  if (
    valid.length < 3 ||
    bands.some(
      (b) => b.y >= valid[0].y && b.y <= valid.at(-1).y && b.parts.length >= 3 && !valid.includes(b)
    )
  )
    return
  const first = valid[0],
    n = first.parts.length
  if (n !== 3 && n !== 10) return
  if (
    valid.some(
      (b) =>
        b.parts.length !== n ||
        b.parts.some(
          (r, c) => Math.abs(r[0] - first.parts[c][0]) > 1 || Math.abs(r[2] - first.parts[c][2]) > 1
        )
    )
  )
    return
  const cuts = [
    first.parts[0][0],
    ...first.parts.slice(1).map((r, c) => (r[0] + first.parts[c][2]) / 2),
    first.parts.at(-1)[2]
  ]
  const source = tableSourceItems(items, [cuts[0], first.y - 3, cuts.at(-1), valid.at(-1).y])
  if (
    source.some((i, n) =>
      source
        .slice(n + 1)
        .some((j) => j.text === i.text && j.rect.every((v, c) => Math.abs(v - i.rect[c]) < 0.01))
    )
  )
    return
  const groups = [],
    rows = []
  let numeric = 0
  for (let b = 0; b < valid.length - 1; b++) {
    const a = valid[b].y,
      z = valid[b + 1].y
    const members = source.filter(
      (i) => (i.rect[1] + i.rect[3]) / 2 > a && (i.rect[1] + i.rect[3]) / 2 < z
    )
    if (!members.length) return
    const cells = readSourceRow(members, cuts)
    if (!cells) return
    if (b === 0 && cells.slice(1).some((s) => /[A-Za-z]/.test(s))) {
      groups.push(members)
      rows.push([cuts[0], a, cuts.at(-1), z])
      continue
    }
    if (n === 10) {
      if (b === 0) {
        if (!/Weeks/i.test(cells[0]) || cells.slice(1).some((s, c) => s !== String(c * 2))) return
      } else if (
        !/[A-Za-z]/.test(cells[0]) ||
        cells.slice(1).some((s) => s && !/^\d+(?:\.\d+)?$/.test(s))
      )
        return
      groups.push(members)
      rows.push([cuts[0], a, cuts.at(-1), z])
      numeric++
      continue
    }
    const lines = []
    for (const i of members) {
      let line = lines.find((g) => Math.abs(g[0].baseline - i.baseline) < i.height * 0.4)
      if (!line) lines.push((line = []))
      line.push(i)
    }
    const anchors = lines.filter((g) => {
      const r = readSourceRow(g, cuts)
      return r && r.slice(1).every((s) => /^[<>≤≥−+-]?\d[\d.,()%±−–+*-]*$/.test(s))
    })
    if (!anchors.length) {
      if (cells.slice(1).some(Boolean)) return
      groups.push(members)
      rows.push([cuts[0], a, cuts.at(-1), z])
      continue
    }
    numeric += anchors.length
    if (anchors.length === 1) {
      if (members.some((i) => i.rect[0] >= cuts[1] && !anchors[0].includes(i))) return
      groups.push(members)
      rows.push([cuts[0], a, cuts.at(-1), z])
      continue
    }
    const assigned = anchors.map((g) => [...g])
    const leading = []
    for (const i of members.filter((i) => !anchors.some((g) => g.includes(i)))) {
      if (i.rect[2] > cuts[1]) return
      if (i.rect[3] < Math.min(...anchors[0].map((i) => i.rect[1]))) leading.push(i)
      else {
        const matches = anchors
          .map((g, n) => ({ n, d: Math.abs(g[0].baseline - i.baseline) }))
          .filter((x) => x.d < i.height * 0.4)
        if (!matches.length && i.height < anchors[0][0].height * 0.85) {
          const raised = anchors
            .map((g, n) => ({ n, g }))
            .filter(({ g }) =>
              g.some(
                (base) =>
                  base.rect[2] <= cuts[1] &&
                  i.rect[0] >= base.rect[0] &&
                  i.rect[0] <= base.rect[2] + base.height * 0.3 &&
                  base.baseline - i.baseline > 0 &&
                  base.baseline - i.baseline < base.height * 0.6
              )
            )
          if (raised.length === 1) matches.push({ n: raised[0].n })
        }
        if (matches.length !== 1) return
        assigned[matches[0].n].push(i)
      }
    }
    if (leading.length) assigned.unshift(leading)
    const bounds = assigned.map((g) => [
      Math.min(...g.map((i) => i.rect[1])),
      Math.max(...g.map((i) => i.rect[3]))
    ])
    if (bounds.some((r, n) => n && r[0] <= bounds[n - 1][1])) return
    assigned.forEach((g, n) => {
      groups.push(g)
      rows.push([
        cuts[0],
        n ? (bounds[n - 1][1] + bounds[n][0]) / 2 : a,
        cuts.at(-1),
        n + 1 < assigned.length ? (bounds[n][1] + bounds[n + 1][0]) / 2 : z
      ])
    })
  }
  if (numeric < 2 || !hasUniqueRecordTokens(source, groups)) return
  rows[0][1] = Math.min(rows[0][1], ...groups[0].map((i) => i.rect[1]))
  return {
    rows,
    columns: cuts.slice(1).map((x, n) => [cuts[n], first.y, x, valid.at(-1).y]),
    spans: [],
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Repeated native column strokes and complete time-point records can replace
// conflicting row predictions in paired mean/SD summaries. Labels belong to the
// source record where they start; no missing baseline or statistic is inferred.
export function recoverRuledTimeSeriesGrid(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const bands = []
  for (const r of rules
    .filter((r) => r[1] === r[3] && r[1] >= top && r[1] <= bottom)
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])) {
    let band = bands.find((b) => Math.abs(b.y - r[1]) < 0.01)
    if (!band) bands.push((band = { y: r[1], parts: [] }))
    band.parts.push(r)
  }
  if (bands.length !== 3) return
  const first = bands[0],
    count = first.parts.length
  if (
    count !== 11 ||
    Math.abs(first.parts[0][0] - left) > 15 ||
    Math.abs(first.parts.at(-1)[2] - right) > 15 ||
    bands.some(
      (b) =>
        b.parts.length !== count ||
        b.parts.some(
          (r, c) =>
            Math.abs(r[0] - first.parts[c][0]) > 0.05 ||
            Math.abs(r[2] - first.parts[c][2]) > 0.05 ||
            (c && Math.abs(r[0] - b.parts[c - 1][2]) > 0.01)
        )
    )
  )
    return
  const source = tableSourceItems(items, [left, first.y, right, bands[2].y])
  const nativeCuts = [
    left,
    ...first.parts.slice(1).map((r, c) => (r[0] + first.parts[c][2]) / 2),
    right
  ]
  const parts = nativeCuts.slice(1).map(() => [])
  for (const i of source) {
    const c = nativeCuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
    if (c < 0) return
    parts[c].push(i)
  }
  if (parts.some((p) => !p.length)) return
  // Font positions can drift a fraction of a point across the original stroke.
  // Move a cut only into the observed empty gutter, within half a source point.
  const cuts = [left]
  for (let c = 1; c < count; c++) {
    const a = Math.max(...parts[c - 1].map((i) => i.rect[2])),
      b = Math.min(...parts[c].map((i) => i.rect[0]))
    if (a + 0.002 >= b || nativeCuts[c] < a - 0.5 || nativeCuts[c] > b + 0.5) return
    cuts.push(Math.max(a + 0.001, Math.min(b - 0.001, nativeCuts[c])))
  }
  cuts.push(right)
  const header = source.filter((i) => i.rect[3] < bands[1].y)
  const heading = readSourceRow(header, cuts)
  const countHeading = (c) =>
    header
      .filter((i) => i.rect[0] >= cuts[c] && i.rect[2] <= cuts[c + 1])
      .map((i) => i.text)
      .join('')
      .replace(/\s/g, '')
  if (
    !heading ||
    !/\p{L}/u.test(heading[0]) ||
    heading[1] ||
    heading[7] !== 'CI' ||
    heading[10] !== 'Change'
  )
    return
  const summary =
    heading[3] === 'SD' &&
    heading[5] === 'SD' &&
    heading[6] === 'Difference' &&
    /\p{L}/u.test(heading[2]) &&
    /\p{L}/u.test(heading[4]) &&
    countHeading(8) === `${heading[2]}(n)` &&
    countHeading(9) === `${heading[4]}(n)`
  const comparison =
    heading[2] === 'BL' &&
    /^\d+m$/.test(heading[3]) &&
    /^\d+m$/.test(heading[4]) &&
    Number.parseInt(heading[3], 10) < Number.parseInt(heading[4], 10) &&
    heading[5] === 'Difference' &&
    heading[6] === 'SD' &&
    /^[A-Za-z]+group\(n\)$/.test(countHeading(8)) &&
    /^[A-Za-z]+group\(n\)$/.test(countHeading(9))
  if (!summary && !comparison) return
  const body = source.filter((i) => i.rect[1] >= bands[1].y)
  const times = body.filter((i) => i.rect[0] >= cuts[1] && i.rect[2] <= cuts[2])
  const compareTime = /^(BL|\d+) versus (\d+), ([A-Za-z]+)$/
  if (
    times.length < 8 ||
    times.some((i) => !(summary ? /^(?:BL|\d+\s*m)$/ : compareTime).test(i.text.trim()))
  )
    return
  const records = times.map((t) =>
    body.filter((i) => Math.abs(i.baseline - t.baseline) < Math.max(i.height, t.height) * 0.35)
  )
  if (
    !hasUniqueRecordTokens(source, [header, ...records]) ||
    source.some((i, n) =>
      source
        .slice(n + 1)
        .some((j) => j.text === i.text && j.rect.every((v, c) => Math.abs(v - i.rect[c]) < 0.01))
    )
  )
    return
  const values = records.map((g) => readSourceRow(g, cuts))
  const scalar = /^[−–-]?\d+(?:\.\d+)?$/
  const interval = /^[−–-]?\d+(?:\.\d+)?[−–-][−–-]?\d+(?:\.\d+)?$/
  const scalarOrEmpty = (s) => !s || scalar.test(s)
  if (
    values.some(
      (r) =>
        !r ||
        !interval.test(r[7]) ||
        !/^[A-Za-z]+$/.test(r[10]) ||
        (summary
          ? r.slice(2, 7).some((s) => !scalar.test(s)) || !/^\d+$/.test(r[8]) || !/^\d+$/.test(r[9])
          : r.slice(2, 5).some((s) => !scalarOrEmpty(s)) ||
            !scalar.test(r[5]) ||
            !scalar.test(r[6]) ||
            r.slice(8, 10).some((s) => s && !/^\d+$/.test(s)))
    )
  )
    return
  if (comparison) {
    const points = [
      'BL',
      String(Number.parseInt(heading[3], 10)),
      String(Number.parseInt(heading[4], 10))
    ]
    for (let n = 0; n < values.length; n++) {
      const [, a, b, arm] = times[n].text.trim().match(compareTime)
      if (
        !points.includes(a) ||
        !points.includes(b) ||
        points.indexOf(a) >= points.indexOf(b) ||
        values[n].slice(2, 5).some((s, c) => Boolean(s) !== [a, b].includes(points[c])) ||
        (arm === 'All'
          ? values[n][8] || values[n][9]
          : Number(Boolean(values[n][8])) + Number(Boolean(values[n][9])) !== 1)
      )
        return
    }
  }
  const starts = []
  for (let n = 0; n < values.length; n++) {
    if (!values[n][0]) continue
    if (/^[A-Z][A-Za-z-]+/.test(values[n][0])) starts.push(n)
    else {
      const start = starts.at(-1)
      if (!comparison || start === undefined || n !== start + 1 || !/^[a-z]/.test(values[n][0]))
        return
      const label = records[n].filter((i) => i.rect[2] <= cuts[1]),
        prior = records[start].filter((i) => i.rect[2] <= cuts[1])
      if (
        label.length !== 1 ||
        prior.length !== 1 ||
        Math.abs(label[0].rect[0] - prior[0].rect[0]) > 1 ||
        label[0].baseline - prior[0].baseline > prior[0].height * 1.5
      )
        return
    }
  }
  if (starts.length < 3 || starts[0] !== 0) return
  const spans = []
  for (const [n, start] of starts.entries()) {
    const end = starts[n + 1] ?? records.length
    if (end - start < 2) return
    if (summary) {
      const sequence = times
        .slice(start, end)
        .map((i) => (i.text.trim() === 'BL' ? 0 : Number.parseInt(i.text, 10)))
      if (sequence.some((v, n) => n && v <= sequence[n - 1])) return
    }
    spans.push({ row: start + 1, column: 0, rowSpan: end - start, colSpan: 1 })
  }
  const bounds = records.map(union)
  if (bounds.some((r, n) => n && r[1] < bounds[n - 1][3])) return
  const ys = [bands[1].y, ...bounds.slice(1).map((r, n) => (bounds[n][3] + r[1]) / 2), bands[2].y]
  return {
    rows: [
      [left, first.y, right, bands[1].y],
      ...records.map((_, n) => [left, ys[n], right, ys[n + 1]])
    ],
    columns: cuts.slice(1).map((x, n) => [cuts[n], first.y, x, bands[2].y]),
    spans,
    completeSpans: true,
    ownedTokens: new Set(source),
    repair: 'ruled-time-series-recovered'
  }
}
