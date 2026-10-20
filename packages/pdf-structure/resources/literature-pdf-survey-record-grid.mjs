/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
import { union, isAdjacentTableScript } from './literature-pdf-table-geometry.mjs'
import {
  tableSourceItems,
  groupSourceRowsWithScripts,
  readSourceRow,
  hasUniqueRecordTokens
} from './literature-pdf-source-records.mjs'

// Three matching native frame bands witness four count lanes or five
// proportion/interval lanes. Physical records, rather than model row spans,
// distinguish section titles, explicit sample counts and reference rows.
export function recoverRuledSurveyRecordGrid(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect,
    source = tableSourceItems(items, table.cropRect),
    height = source.map((i) => i.height).sort((a, b) => a - b)[Math.floor(source.length / 2)]
  if (!(height > 0)) return
  const bands = [
    ...Map.groupBy(
      rules.filter((r) => r[1] === r[3] && r[1] >= top && r[1] <= bottom),
      (r) => r[1]
    ).values()
  ]
    .map((g) => [...g].sort((a, b) => a[0] - b[0]))
    .filter(
      (g) =>
        [4, 5].includes(g.length) &&
        Math.abs(g[0][0] - left) < height &&
        Math.abs(g.at(-1)[2] - right) < height &&
        g.slice(1).every((r, n) => Math.abs(r[0] - g[n][2]) < height * 0.01)
    )
    .sort((a, b) => a[0][1] - b[0][1])
  if (
    bands.length !== 3 ||
    bands.some(
      (g) =>
        g.length !== bands[0].length ||
        g.some(
          (r, c) =>
            Math.abs(r[0] - bands[0][c][0]) > height * 0.01 ||
            Math.abs(r[2] - bands[0][c][2]) > height * 0.01
        )
    )
  )
    return
  const count = bands[0].length,
    divider = bands[1][0][1],
    closing = bands[2][0][1],
    cuts = [left, ...bands[0].slice(1).map((r) => r[0] - 0.001), right],
    header = source.filter((i) => i.rect[3] < divider),
    body = source.filter((i) => i.rect[1] > divider && i.rect[3] < closing)
  if (
    !body.length ||
    divider - bands[0][0][1] > height * 6 ||
    closing - Math.max(...body.map((i) => i.rect[3])) > height * 1.5
  )
    return
  // Native starts drift by fractions of an em. Only observed numeric/header
  // ink can move a cut, and every complete record must fit afterward.
  for (let c = 1; c < count; c++) {
    const crossing = source.filter(
      (i) =>
        i.rect[0] < cuts[c] &&
        i.rect[2] > cuts[c] &&
        i.rect[0] >= cuts[c - 1] + height &&
        (header.includes(i) || /^[\da][\d.,()%–−+-]*$/.test(i.text.replace(/\s/g, '')))
    )
    if (!crossing.length) continue
    const edge = Math.min(...crossing.map((i) => i.rect[0]))
    if (cuts[c] - edge > height * 0.1) return
    cuts[c] = edge - 0.001
  }
  const head =
    count === 4
      ? countHead(header, cuts, height, top, divider)
      : proportionHead(header, cuts, height, top, divider, rules, bands[0])
  if (!head) return
  const scripts = body.filter((i) => i.height < height * 0.8),
    physical = groupSourceRowsWithScripts(
      body.filter((i) => !scripts.includes(i)),
      height,
      0.25
    )
  if (!physical) return
  for (const script of scripts) {
    let owners = physical.filter((g) => g.some((a) => isAdjacentTableScript(script, a)))
    if (!owners.length && count === 5 && /^[a-z]$/.test(script.text)) {
      const column = cuts.slice(1).findIndex((x) => (script.rect[0] + script.rect[2]) / 2 < x)
      owners = physical.filter((g) => {
        const v = readSourceRow(g, cuts),
          shift = g[0].baseline - script.baseline
        return (
          column >= 3 &&
          v &&
          v[0] &&
          v.slice(1, 3).every((s) => /^\d+(?:\.\d+)?$/.test(s)) &&
          !v[column] &&
          shift > 0 &&
          shift < height * 0.45 &&
          script.rect[0] >= cuts[column] &&
          script.rect[2] <= cuts[column + 1]
        )
      })
    }
    if (owners.length !== 1) return
    owners[0].push(script)
  }
  if (!hasUniqueRecordTokens(source, [...head.groups, ...physical])) return
  const groups = [],
    spans = []
  let records = 0,
    intervals = 0
  for (const g of physical) {
    const v = readSourceRow(g, cuts),
      numeric = v && v[0] && v.slice(1, count === 4 ? 4 : 3).every((s) => /^\d+(?:\.\d+)?$/.test(s))
    if (numeric) {
      if (
        count === 5 &&
        (!/^(?:|1\.00|[a-z]|\d+(?:\.\d+)?\(\d+(?:\.\d+)?[–−-]\d+(?:\.\d+)?\))$/.test(v[3]) ||
          !/^(?:|[a-z]|[<>≤≥]?\d+(?:\.\d+)?)$/.test(v[4]))
      )
        return
      records++
      if (count === 5 && /\(/.test(v[3])) intervals++
      groups.push(g)
      continue
    }
    const previous = groups.at(-1),
      prev = previous && readSourceRow(previous, cuts),
      stubOnly = g.every((i) => i.rect[0] < cuts[1]) && /\p{L}/u.test(g.map((i) => i.text).join(''))
    if (!stubOnly || Math.min(...g.map((i) => i.rect[0])) - bands[0][0][0] > height * 1.5) return
    // Only an indented tight continuation of a preceding numerical label
    // joins that row. A following subsection baseline remains independent.
    if (
      g.every((i) => i.rect[2] <= cuts[1]) &&
      prev &&
      prev.slice(1, count === 4 ? 4 : 3).every((s) => /^\d+(?:\.\d+)?$/.test(s)) &&
      union(g)[1] - union(previous)[3] < height * 0.4 &&
      g[0].baseline - previous[0].baseline < height * 1.5 &&
      union(g)[0] >= union(previous.filter((i) => i.rect[2] <= cuts[1]))[0] - height * 0.1
    )
      previous.push(...g)
    else {
      spans.push({ row: groups.length + head.groups.length, column: 0, rowSpan: 1, colSpan: count })
      groups.push(g)
    }
  }
  if (records < 3 || (count === 5 && intervals < 3)) return
  const rows = groups.map((g) => [left, union(g)[1], right, union(g)[3]])
  if (rows.some((r, n) => n && r[1] <= rows[n - 1][3])) return
  return {
    rows: [...head.rows, ...rows],
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans: [...head.spans, ...spans],
    headerRows: head.rows.map((_, n) => n),
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

function countHead(header, cuts, height, top, divider) {
  const lines = groupSourceRowsWithScripts(header, height, 0.25)
  if (!lines || lines.length < 2 || lines.length > 3) return
  const last = lines.at(-1),
    values = readSourceRow(last, cuts),
    upper = lines.slice(0, -1).flat(),
    heads = readSourceRow(upper, cuts, { multiline: true })
  if (
    !values ||
    values[0] !== 'N' ||
    !values.slice(1).every((s) => /^\d+$/.test(s)) ||
    !heads ||
    !heads.every((s) => /\p{L}/u.test(s))
  )
    return
  const split = (union(upper)[3] + union(last)[1]) / 2
  return {
    groups: [upper, last],
    rows: [
      [cuts[0], top, cuts.at(-1), split],
      [cuts[0], split, cuts.at(-1), divider]
    ],
    spans: []
  }
}

function proportionHead(header, cuts, height, top, divider, rules, band) {
  const underline = rules.filter(
    (r) =>
      r[1] === r[3] &&
      r[1] > top &&
      r[1] < divider &&
      Math.abs(r[0] - band[1][0]) < height * 0.01 &&
      Math.abs(r[2] - band.at(-1)[2]) < height * 0.01
  )
  if (underline.length !== 1) return
  const upper = header.filter((i) => i.rect[3] < underline[0][1]),
    lower = header.filter((i) => i.rect[1] > underline[0][1]),
    lines = groupSourceRowsWithScripts(lower, height, 0.25)
  if (
    !lines ||
    lines.length !== 2 ||
    upper.some((i) => i.rect[0] >= cuts[2]) ||
    !upper.some((i) => i.rect[0] >= cuts[1])
  )
    return
  const a = readSourceRow(lines[0], cuts),
    b = readSourceRow(lines[1], cuts)
  if (
    !a ||
    !b ||
    a[0] ||
    !a.slice(1, 3).every((s) => /\p{L}/u.test(s)) ||
    !/^OR\(95%CI\)$/i.test(a[3]) ||
    !/^pvalue$/i.test(a[4]) ||
    b[0] ||
    !b.slice(1, 3).every((s) => /^Proportion\(%\)\(n=\d+\)$/i.test(s)) ||
    b.slice(3).some(Boolean)
  )
    return
  const split = (union(lines[0])[3] + union(lines[1])[1]) / 2
  return {
    groups: [upper, ...lines],
    rows: [
      [cuts[0], top, cuts.at(-1), underline[0][1]],
      [cuts[0], underline[0][1], cuts.at(-1), split],
      [cuts[0], split, cuts.at(-1), divider]
    ],
    spans: [
      { row: 0, column: 0, rowSpan: 3, colSpan: 1 },
      { row: 0, column: 1, rowSpan: 1, colSpan: 4 },
      { row: 1, column: 3, rowSpan: 2, colSpan: 1 },
      { row: 1, column: 4, rowSpan: 2, colSpan: 1 }
    ]
  }
}
