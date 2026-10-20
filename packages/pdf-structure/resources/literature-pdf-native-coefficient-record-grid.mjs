/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
import {
  tableSourceItems,
  readSourceRow,
  hasUniqueRecordTokens
} from './literature-pdf-source-records.mjs'

const number = /^[−–-]?\d+\.\d+$/
const box = (items) => [
  Math.min(...items.map((i) => i.rect[0])),
  Math.min(...items.map((i) => i.rect[1])),
  Math.max(...items.map((i) => i.rect[2])),
  Math.max(...items.map((i) => i.rect[3]))
]

// A closed, two-level native header and five complete decimal lanes witness
// these uniformly spaced records. Full-em raised stars belong only to their
// unique adjacent numeric advance, never to a model row or section above it.
export function recoverNativeCoefficientRecordGrid(table, items, captions, rules) {
  const crop = table.cropRect,
    columns = table.structure.objects
      .filter((o) => o.label === 'table column')
      .map((o) => o.rect)
      .sort((a, b) => a[0] - b[0])
  if (columns.length !== 6) return
  const nearby = tableSourceItems(items, crop),
    sizes = nearby
      .filter((i) => /^\d+\.\d+$/.test(i.text))
      .map((i) => i.height)
      .sort((a, b) => a - b),
    height = sizes[Math.floor(sizes.length / 2)]
  if (!(height > 0)) return
  const horizontal = rules.filter(
      (r) => r[1] === r[3] && r[1] > crop[1] - height && r[1] < crop[3] + height
    ),
    joined = [...Map.groupBy(horizontal, (r) => r[1]).values()]
      .map((g) => [...g].sort((a, b) => a[0] - b[0]))
      .filter((g) => g.every((r, n) => !n || Math.abs(g[n - 1][2] - r[0]) < height * 0.01))
      .map((g) => [g[0][0], g[0][1], g.at(-1)[2], g[0][1]])
      .sort((a, b) => a[1] - b[1]),
    full = joined.filter(
      (r) => Math.abs(r[0] - crop[0]) < height && Math.abs(r[2] - crop[2]) < height
    )
  if (full.length !== 3) return
  const [opening, divider, closing] = full
  if (
    divider[1] - opening[1] < height * 3 ||
    divider[1] - opening[1] > height * 5 ||
    Math.abs(closing[1] - crop[3]) > height ||
    full.some((r) => Math.abs(r[0] - opening[0]) > 0.02 || Math.abs(r[2] - opening[2]) > 0.02) ||
    captions.filter(
      (c) =>
        captionKind(c.lines[0]) === 'table' &&
        c.rect[3] < opening[1] &&
        opening[1] - c.rect[3] < height * 2 &&
        c.rect[0] < opening[2] &&
        c.rect[2] > opening[0]
    ).length !== 1
  )
    return
  const cuts = [
      crop[0],
      ...columns.slice(1).map((c, n) => crop[0] + (columns[n][2] + c[0]) / 2),
      crop[2]
    ],
    parentRules = joined.filter(
      (r) =>
        r[1] > opening[1] &&
        r[1] < divider[1] &&
        r[0] > cuts[1] &&
        r[0] > cuts[2] - height * 2 &&
        r[0] < cuts[3] &&
        Math.abs(r[2] - opening[2]) < 0.02
    )
  if (parentRules.length !== 1 || joined.length !== 4) return
  const parentRule = parentRules[0],
    source = nearby.filter((i) => i.rect[1] >= opening[1] && i.rect[3] <= closing[1]),
    header = source.filter((i) => i.rect[3] < divider[1]),
    body = source.filter((i) => i.rect[1] > divider[1])
  if (
    !source.length ||
    !hasUniqueRecordTokens(source, [header, body]) ||
    nearby.some((i) => i.rect[1] < closing[1] && i.rect[3] > opening[1] && !source.includes(i))
  )
    return
  const leftHeader = header.filter((i) => i.rect[2] <= cuts[2]),
    parent = header.filter((i) => i.rect[0] >= cuts[2] && i.rect[3] < parentRule[1]),
    leaves = header.filter((i) => i.rect[0] >= cuts[2] && i.rect[1] > parentRule[1])
  if (
    !hasUniqueRecordTokens(header, [leftHeader, parent, leaves]) ||
    !readSourceRow(leftHeader, cuts, { multiline: true })
      ?.slice(0, 2)
      .every((v) => /\p{L}/u.test(v)) ||
    !parent.length ||
    !/\p{L}/u.test(parent.map((i) => i.text).join('')) ||
    !readSourceRow(leaves, cuts)
      ?.slice(2)
      .every((v) => /\p{L}/u.test(v)) ||
    leaves.some((i) => Math.abs(i.baseline - leaves[0].baseline) > height * 0.1)
  )
    return
  const stars = body.filter((i) => /^\*{1,3}$/.test(i.text)),
    main = body.filter((i) => !stars.includes(i)),
    physical = [],
    scriptAnchors = new Map()
  for (const i of main) {
    const last = physical.at(-1)
    if (last && Math.abs(i.baseline - last[0].baseline) < height * 0.1) last.push(i)
    else physical.push([i])
  }
  for (const star of stars) {
    const anchors = main.filter(
      (anchor) =>
        number.test(anchor.text) &&
        anchor.rect[0] > cuts[1] &&
        star.height >= height * 0.8 &&
        star.height <= height * 1.1 &&
        anchor.baseline - star.baseline > height * 0.35 &&
        anchor.baseline - star.baseline < height * 0.5 &&
        Math.abs(star.rect[0] - anchor.rect[2]) < height * 0.1 &&
        readSourceRow([anchor, star], cuts)
    )
    if (anchors.length !== 1) return
    const owner = physical.find((row) => row.includes(anchors[0]))
    owner.push(star)
    scriptAnchors.set(star, anchors[0])
  }
  if (!hasUniqueRecordTokens(body, physical)) return
  const values = physical.map((row) => readSourceRow(row, cuts)),
    measured = physical.filter((_, n) =>
      values[n]?.slice(1).every((v) => /^[−–-]?\d+\.\d+\*{0,3}$/.test(v))
    ),
    sections = physical.filter((_, n) => values[n]?.slice(1).every((v) => !v))
  if (
    measured.length < 6 ||
    sections.length < 2 ||
    measured.length + sections.length !== physical.length ||
    values.some((v) => !v || !/\p{L}/u.test(v[0])) ||
    main.some((i) => Math.abs(i.height - height) > height * 0.05)
  )
    return
  const labelLeft = (row) =>
      Math.min(...row.filter((i) => i.rect[2] <= cuts[1]).map((i) => i.rect[0])),
    flush = labelLeft(sections[0]),
    indent = labelLeft(measured[0]) - flush,
    gaps = physical.slice(1).map((row, n) => row[0].baseline - physical[n][0].baseline),
    leading = gaps[0]
  if (
    Math.abs(flush - opening[0]) > height * 0.1 ||
    indent < height * 0.8 ||
    indent > height * 1.2 ||
    measured.some((row) => Math.abs(labelLeft(row) - flush - indent) > height * 0.05) ||
    sections.some((row) => Math.abs(labelLeft(row) - flush) > height * 0.05) ||
    leading < height * 1.1 ||
    leading > height * 1.5 ||
    gaps.some((gap) => Math.abs(gap - leading) > height * 0.05)
  )
    return
  const edges = [crop[1], parentRule[1], divider[1]],
    records = [[...leftHeader, ...parent], leaves, ...physical]
  for (let n = 1; n < physical.length; n++) {
    const priorBottom = box(physical[n - 1])[3],
      nextTop = box(physical[n])[1]
    if (priorBottom >= nextTop) {
      // A raised star's em can cross the previous baseline, while the numeric
      // baseline is still unique. Use the midpoint between numeric baselines.
      if (!physical[n].some((i) => stars.includes(i))) return
    }
    edges.push((physical[n - 1][0].baseline + physical[n][0].baseline) / 2 - height * 0.5)
  }
  edges.push(crop[3])
  if (
    edges.length !== records.length + 1 ||
    edges.some((y, n) => n && y <= edges[n - 1]) ||
    !hasUniqueRecordTokens(source, records)
  )
    return
  return {
    cropRect: crop,
    rows: edges.slice(1).map((y, n) => [crop[0], edges[n], crop[2], y]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], crop[1], x, crop[3]]),
    spans: [
      { row: 0, column: 0, rowSpan: 2, colSpan: 1 },
      { row: 0, column: 1, rowSpan: 2, colSpan: 1 },
      { row: 0, column: 2, rowSpan: 1, colSpan: 4 },
      ...sections.map((row) => ({
        row: physical.indexOf(row) + 2,
        column: 0,
        rowSpan: 1,
        colSpan: 6
      }))
    ],
    headerRows: [0, 1],
    completeSpans: true,
    ownedTokens: new Set(source),
    scriptAnchors,
    repair: 'native-body-records-recovered'
  }
}
