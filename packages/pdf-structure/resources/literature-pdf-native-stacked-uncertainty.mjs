/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
import { readSourceRow, hasUniqueRecordTokens } from './literature-pdf-source-records.mjs'
const bounds = (items) => [
  Math.min(...items.map((i) => i.rect[0])),
  Math.min(...items.map((i) => i.rect[1])),
  Math.max(...items.map((i) => i.rect[2])),
  Math.max(...items.map((i) => i.rect[3]))
]
const text = (items) => items.map((i) => i.text).join('')
// Called only after the existing cell assignments. Exactly three native
// baselines and matched smaller signed lanes witness the two scripts. Every
// original character is emitted once; no value or sign is synthesized.
export function recoverNativeStackedUncertainty(items, rules, equalFontStacks) {
  if (
    items.length < 3 ||
    items.length > 18 ||
    new Set(items).size !== items.length ||
    items.some(
      (i) =>
        !i.horizontal ||
        !Number.isFinite(i.baseline) ||
        !(i.height > 0) ||
        i.rect.some((v) => !Number.isFinite(v)) ||
        i.rect[0] >= i.rect[2] ||
        i.rect[1] >= i.rect[3]
    )
  )
    return
  const rows = []
  for (const i of [...items].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    const row = rows.at(-1)
    if (row && Math.abs(i.baseline - row[0].baseline) < Math.min(i.height, row[0].height) * 0.03)
      row.push(i)
    else rows.push([i])
  }
  if (rows.length !== 3) return
  for (const row of rows) row.sort((a, b) => a.rect[0] - b.rect[0])
  const [upper, main, lower] = rows,
    height = main[0].height,
    script = upper[0].height,
    mainBox = bounds(main),
    upperBox = bounds(upper),
    lowerBox = bounds(lower),
    witnessed = equalFontStacks?.filter(
      (g) => g.tokens.size === items.length && items.every((i) => g.tokens.has(i))
    ),
    equalFont =
      witnessed?.length === 1 &&
      rows.every((row) => row.every((i) => Math.abs(i.height - height) < height * 0.03))
  const smallFontBoundary = witnessed?.length === 1 && witnessed[0].smallFontBoundary === true
  if (
    !/^[−-]?\d+\.\d+$/.test(text(main)) ||
    !/^\+\d+\.\d+$/.test(text(upper)) ||
    !/^[−-]\d+\.\d+$/.test(text(lower)) ||
    // PDF font sizes may round a true three-quarter em just above 0.75.
    // A thousandth of an em tolerance retains the independent lane proof.
    (!equalFont && (script < height * 0.55 || script > height * 0.751)) ||
    rows.some((row, n) =>
      row.some(
        (i, k) =>
          Math.abs(i.height - (n === 1 ? height : script)) > height * 0.05 ||
          (k &&
            (i.rect[0] - row[k - 1].rect[2] < -height * 0.03 ||
              i.rect[0] - row[k - 1].rect[2] > height * 0.15))
      )
    )
  )
    return
  const up = main[0].baseline - upper[0].baseline,
    down = lower[0].baseline - main[0].baseline,
    gap = upperBox[0] - mainBox[2]
  if (
    up < height * (equalFont ? 0.45 : 0.2) ||
    up > height * (equalFont ? 0.6 : 0.5) ||
    down < height * (equalFont ? 0.45 : 0.15) ||
    down > height * (equalFont ? 0.6 : 0.45) ||
    gap < -height * 0.03 ||
    gap > height * 0.35 ||
    Math.abs(upperBox[0] - lowerBox[0]) > height * 0.05 ||
    Math.abs(upperBox[2] - lowerBox[2]) > height * (equalFont ? 1.5 : 0.75) ||
    upperBox[3] > lowerBox[1] + height * 0.05
  )
    return
  const box = bounds(items)
  if (
    rules.some(
      (r) =>
        (r[1] === r[3] &&
          r[1] > box[1] &&
          r[1] < box[3] &&
          r[0] < box[2] &&
          r[2] > box[0] &&
          !(
            (equalFont || smallFontBoundary) &&
            r[1] === witnessed[0].divider &&
            upper[0].baseline > r[1] &&
            r[1] - upperBox[1] <= height * (equalFont ? 0.3 : 0.01) &&
            mainBox[1] > r[1]
          )) ||
        (r[0] === r[2] && r[0] > mainBox[2] && r[0] < box[2] && r[1] < box[3] && r[3] > box[1])
    )
  )
    return
  return {
    runs: [
      { text: text(main), position: 'normal' },
      { text: text(upper), position: 'superscript' },
      { text: text(lower), position: 'subscript' }
    ],
    ownedTokens: new Set(items)
  }
}

// Equal native em boxes alone never prove scripts. A closed, captioned frame
// with twelve native leaves and repeated complete twelve-lane records proves
// the eight paired numeric lanes before any cell text receives this exception.
export function recoverNativeEqualFontStackRecordGrid(table, items, captions, rules) {
  const crop = table.cropRect,
    nearby = items.filter(
      (i) =>
        i.horizontal &&
        i.rect[0] >= crop[0] &&
        i.rect[2] <= crop[2] &&
        i.baseline > crop[1] &&
        i.baseline < crop[3]
    ),
    ids = nearby.filter(
      (i) => /^\d{6,20}$/.test(i.text) && i.rect[0] < crop[0] + (crop[2] - crop[0]) * 0.15
    ),
    height = ids[0]?.height
  if (!(height > 0) || ids.length < 6 || ids.length > 60) return
  const full = rules
    .filter(
      (r) =>
        r[1] === r[3] &&
        Math.abs(r[0] - crop[0]) < height * 2 &&
        Math.abs(r[2] - crop[2]) < height * 2 &&
        r[1] > crop[1] - height &&
        r[1] < crop[3] + height
    )
    .sort((a, b) => a[1] - b[1])
  if (
    ![3, 4].includes(full.length) ||
    full.some((r) => Math.abs(r[0] - full[0][0]) > 0.02 || Math.abs(r[2] - full[0][2]) > 0.02)
  )
    return
  if (
    full.length === 4 &&
    (full[1][1] - full[0][1] < height * 0.15 || full[1][1] - full[0][1] > height * 0.45)
  )
    return
  const opening = full[full.length === 4 ? 1 : 0],
    divider = full.at(-2),
    closing = full.at(-1)
  if (
    divider[1] - opening[1] < height * 2 ||
    divider[1] - opening[1] > height * 4 ||
    Math.abs(closing[1] - crop[3]) > height * 1.5 ||
    captions.filter(
      (c) =>
        captionKind(c.lines[0]) === 'table' &&
        c.rect[3] < opening[1] &&
        opening[1] - c.rect[3] < height * 4 &&
        c.rect[0] < closing[2] &&
        c.rect[2] > closing[0]
    ).length !== 1
  )
    return
  const source = nearby.filter((i) => i.baseline > opening[1] && i.baseline < closing[1]),
    header = source.filter((i) => i.baseline <= divider[1]),
    body = source.filter((i) => i.baseline > divider[1]),
    anchors = ids.filter((i) => body.includes(i)).sort((a, b) => a.baseline - b.baseline)
  if (
    anchors.length !== ids.length ||
    body.some((i) => Math.abs(i.height - height) > height * 0.03) ||
    source.some((i) => i.rect[1] < full[0][1] - height * 0.1 || i.rect[3] > closing[1]) ||
    body.some((i) => i.rect[1] < divider[1] - height * 0.3)
  )
    return
  const main = anchors.map((a) =>
    body
      .filter((i) => Math.abs(i.baseline - a.baseline) < height * 0.03)
      .sort((a, b) => a.rect[0] - b.rect[0])
  )
  if (
    main.some(
      (row) =>
        row.length !== 12 ||
        !/^\d{6,20}$/.test(row[0].text) ||
        !row.slice(1, 3).every((i) => /\p{L}/u.test(i.text)) ||
        !/^\d+$/.test(row[3].text) ||
        !row.slice(4).every((i) => /^[−-]?\d+\.\d+$/.test(i.text))
    )
  )
    return
  const gaps = anchors.slice(1).map((a, n) => a.baseline - anchors[n].baseline),
    leading = gaps[0]
  if (
    leading < height * 1.8 ||
    leading > height * 2.2 ||
    gaps.some((g) => Math.abs(g - leading) > height * 0.03)
  )
    return
  const headingBaseline = header.find((i) => /\p{L}/u.test(i.text))?.baseline,
    leaves = header
      .filter(
        (i) => /\p{L}/u.test(i.text) && Math.abs(i.baseline - headingBaseline) < height * 0.03
      )
      .sort((a, b) => a.rect[0] - b.rect[0])
  if (leaves.length !== 12) return
  const centers = leaves.map((i) => (i.rect[0] + i.rect[2]) / 2),
    initial = [crop[0], ...centers.slice(1).map((x, n) => (x + centers[n]) / 2), crop[2]],
    lane = (i) => initial.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  if (main.some((row) => row.some((i, n) => lane(i) !== n))) return
  const records = anchors.map(() => [])
  for (const i of body) {
    const owners = anchors
      .map((a, n) => ({ a, n }))
      .filter(({ a }) => Math.abs(i.baseline - a.baseline) < height * 0.65)
    if (owners.length !== 1) return
    records[owners[0].n].push(i)
  }
  const lanes = initial.slice(1).map((_, n) => source.filter((i) => lane(i) === n)),
    cuts = [crop[0]]
  for (let c = 1; c < 12; c++) {
    const left = Math.max(...lanes[c - 1].map((i) => i.rect[2])),
      right = Math.min(...lanes[c].map((i) => i.rect[0]))
    if (right - left < height * 0.05) return
    cuts.push((left + right) / 2)
  }
  cuts.push(crop[2])
  if (
    !readSourceRow(header, cuts, { multiline: true })?.every((v) => /\p{L}/u.test(v)) ||
    !hasUniqueRecordTokens(source, [header, ...records])
  )
    return
  const stacks = [],
    offsets = []
  for (let n = 0; n < records.length; n++)
    for (let c = 4; c < 12; c++) {
      const group = records[n].filter((i) => lane(i) === c),
        set = { tokens: new Set(group), divider: divider[1] },
        p = recoverNativeStackedUncertainty(group, rules, [set])
      if (!p || !readSourceRow(group, cuts)) return
      const baselines = [...new Set(group.map((i) => i.baseline))].sort((a, b) => a - b)
      if (baselines.length !== 3 || Math.abs(baselines[1] - anchors[n].baseline) > height * 0.03)
        return
      offsets.push([baselines[1] - baselines[0], baselines[2] - baselines[1]])
      stacks.push(set)
    }
  if (
    offsets.some((pair) => pair.some((v, n) => Math.abs(v - offsets[0][n]) > height * 0.03)) ||
    records.some((row) => row.filter((i) => lane(i) < 4).length !== 4)
  )
    return
  const edges = [crop[1], divider[1]]
  for (let n = 1; n < records.length; n++) {
    const last = Math.max(...records[n - 1].map((i) => (i.rect[1] + i.rect[3]) / 2)),
      next = Math.min(...records[n].map((i) => (i.rect[1] + i.rect[3]) / 2))
    if (last >= next) return
    edges.push((last + next) / 2)
  }
  edges.push(crop[3])
  if (edges.some((y, n) => n && y <= edges[n - 1])) return
  return {
    cropRect: crop,
    rows: edges.slice(1).map((y, n) => [crop[0], edges[n], crop[2], y]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], crop[1], x, crop[3]]),
    spans: [],
    headerRows: [0],
    completeSpans: true,
    ownedTokens: new Set(source),
    equalFontStacks: stacks,
    repair: 'native-body-records-recovered'
  }
}
