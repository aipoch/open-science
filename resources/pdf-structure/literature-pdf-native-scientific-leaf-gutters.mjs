/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
import { readSourceRow, hasUniqueRecordTokens } from './literature-pdf-source-records.mjs'
import { recoverNativeStackedUncertainty } from './literature-pdf-native-stacked-uncertainty.mjs'

const center = (i) => (i.rect[0] + i.rect[2]) / 2
const median = (v) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]
const box = (v) => [
  Math.min(...v.map((i) => i.rect[0])),
  Math.min(...v.map((i) => i.rect[1])),
  Math.max(...v.map((i) => i.rect[2])),
  Math.max(...v.map((i) => i.rect[3]))
]
const completeInk = (items, source, rect) =>
  items.every(
    (i) =>
      !i.text.trim() ||
      i.rect[2] <= rect[0] ||
      i.rect[0] >= rect[2] ||
      i.rect[3] <= rect[1] ||
      i.rect[1] >= rect[3] ||
      source.includes(i)
  )

// Full native leaf ink and repeated source anchors authorize only measured TJ
// whitespace. The caller must revalidate every source field after splitting.
export function proveNativeScientificLeafGutters(table, items, captions, rules, nativeRuns = []) {
  const crop = table.cropRect,
    cols = table.structure.objects
      .filter((o) => o.label === 'table column')
      .map((o) => o.rect)
      .sort((a, b) => a[0] - b[0]),
    width = cols.length
  if (![8, 9].includes(width)) return
  const nearby = items.filter(
      (i) =>
        i.horizontal &&
        i.rect[0] >= crop[0] &&
        i.rect[2] <= crop[2] &&
        i.baseline > crop[1] &&
        i.baseline < crop[3]
    ),
    ids = nearby.filter(
      (i) =>
        /^\d{6,20}(?:\s+\p{L}[\p{L}\p{N}\s]*)?$/u.test(i.text) &&
        i.rect[0] < crop[0] + (crop[2] - crop[0]) * 0.1
    ),
    height = median(ids.map((i) => i.height))
  if (!(height > 0) || ids.length < 9 || ids.length > 60) return
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
    full.length < 4 ||
    full.length > 8 ||
    full.some((r) => Math.abs(r[0] - full[0][0]) > 0.02 || Math.abs(r[2] - full[0][2]) > 0.02) ||
    full[1][1] - full[0][1] < height * 0.15 ||
    full[1][1] - full[0][1] > height * 0.3
  )
    return
  const opening = full[0],
    divider = full[2],
    closing = full.at(-1)
  if (
    divider[1] - full[1][1] < height ||
    divider[1] - full[1][1] > height * 3.2 ||
    Math.abs(crop[3] - closing[1]) > height ||
    captions.filter(
      (c) =>
        captionKind(c.lines[0]) === 'table' &&
        c.rect[3] < opening[1] &&
        opening[1] - c.rect[3] < height * 3 &&
        c.rect[0] < opening[2] &&
        c.rect[2] > opening[0]
    ).length !== 1
  )
    return
  const source = nearby.filter((i) => i.baseline > opening[1] && i.baseline < closing[1]),
    header = source.filter((i) => i.baseline <= divider[1]),
    body = source.filter((i) => i.baseline > divider[1]),
    anchors = ids.filter((i) => body.includes(i)).sort((a, b) => a.baseline - b.baseline),
    gaps = anchors.slice(1).map((i, n) => i.baseline - anchors[n].baseline),
    leading = median(gaps)
  if (!completeInk(items, source, [opening[0], opening[1], opening[2], closing[1]])) return
  if (
    anchors.length !== ids.length ||
    leading < height * 1.35 ||
    leading > height * 1.6 ||
    gaps.some((g) => Math.abs(g - leading) > height * 0.06) ||
    source.some((i) => i.rect[1] < opening[1] - height * 0.1 || i.rect[3] > closing[1]) ||
    body.some((i) => i.height < height * 0.55 || i.height > height * 1.05)
  )
    return
  const initial = [
      crop[0],
      ...cols.slice(1).map((c, n) => crop[0] + (cols[n][2] + c[0]) / 2),
      crop[2]
    ],
    lane = (i) => initial.slice(1).findIndex((x) => center(i) < x),
    firstBaseline = header.find((i) => /\p{L}/u.test(i.text))?.baseline,
    primary = header.filter((i) => Math.abs(i.baseline - firstBaseline) < height * 0.2),
    heads = cols.map((_, c) => primary.filter((i) => lane(i) === c)),
    records = anchors.map(() => [])
  for (const i of body) {
    const owners = anchors
      .map((a, n) => ({ a, n }))
      .filter(({ a }) => Math.abs(a.baseline - i.baseline) < height * 0.65)
    if (owners.length !== 1) return
    records[owners[0].n].push(i)
  }
  if (
    !hasUniqueRecordTokens(source, [header, ...records]) ||
    records.some((row) => row.some((i) => !/^[\p{L}\p{N}\s.±+−()/-]+$/u.test(i.text)))
  )
    return
  const bare = records.filter(
    (row) =>
      row.some((i) => /^\d{6,20}$/.test(i.text)) &&
      row.some((i) => /^\p{L}[\p{L}\p{N}\s]*$/u.test(i.text) && lane(i) === 1)
  )
  if (bare.length < 9) return
  const bands = []
  if (heads.every((g) => g.length && g.some((i) => /\p{L}/u.test(i.text)))) {
    if (
      heads.some((g) => !g.length || !g.some((i) => /\p{L}/u.test(i.text))) ||
      primary.some(
        (i) => i.rect[0] < initial[lane(i)] - height || i.rect[2] > initial[lane(i) + 1] + height
      )
    )
      return
    for (let c = 1; c < width; c++) bands.push([box(heads[c - 1])[2], box(heads[c])[0]])
  } else {
    if (heads.slice(0, 4).some((g) => !g.length || !g.some((i) => /\p{L}/u.test(i.text)))) return
    const joined = primary.filter(
      (i) =>
        i.rect[0] >= initial[4] - height && i.rect[2] > initial[7] && /\p{L}\s+\p{L}/u.test(i.text)
    )
    if (joined.length !== 1 || primary.filter((i) => i.rect[0] >= initial[4] - height).length !== 1)
      return
    const flags = cols
      .slice(4)
      .map((_, n) =>
        body.filter(
          (i) =>
            lane(i) === n + 4 &&
            /^\p{L}{1,10}$/u.test(i.text) &&
            Math.abs(i.height - height) < height * 0.05
        )
      )
    if (
      flags.some((g) => g.length !== anchors.length) ||
      records.some(
        (row) =>
          row.filter((i) => i.rect[0] >= initial[4] && /^\p{L}{1,10}$/u.test(i.text)).length !== 4
      )
    )
      return
    for (let c = 1; c < 4; c++) bands.push([box(heads[c - 1])[2], box(heads[c])[0]])
    bands.push([box(heads[3])[2], joined[0].rect[0]])
    const runs = nativeRuns.filter(
      (r) =>
        r.text === joined[0].text && r.rect.every((v, n) => Math.abs(v - joined[0].rect[n]) < 0.05)
    )
    if (runs.length !== 1) return
    const selected = []
    for (let c = 1; c < 4; c++) {
      const band = [box(flags[c - 1])[2], box(flags[c])[0]],
        options = runs[0].gaps
          .filter(
            (g) => g.left >= band[0] && g.right <= band[1] && g.right - g.left >= height * 0.25
          )
          .sort((a, b) => b.right - b.left - (a.right - a.left)),
        gap = options[0]
      if (
        !gap ||
        gap.right - gap.left < height * 0.4 ||
        gap.right - gap.left > height * 0.6 ||
        (options[1] && gap.right - gap.left - (options[1].right - options[1].left) < height * 0.08)
      )
        return
      selected.push(gap)
      bands.push([gap.left - 0.01, gap.right + 0.01])
    }
    if (
      selected.some(
        (g) => Math.abs(g.right - g.left - (selected[0].right - selected[0].left)) > height * 0.01
      )
    )
      return
  }
  if (bands.some((b, n) => b[1] - b[0] < height * 0.25 || (n && b[0] <= bands[n - 1][1]))) return
  const cuts = bands.map((b) => (b[0] + b[1]) / 2)
  return {
    rect: [opening[0], opening[1], opening[2], closing[1]],
    cuts,
    gutterBands: bands,
    headerBottom: divider[1],
    height,
    width,
    anchors: anchors.map((i) => i.baseline),
    sourceCount: source.length
  }
}

// No speculative split is adopted without all native leaf titles and all
// complete source records. Output ownership and cuts are physical source ink.
export function recoverNativeScientificLeafRecordGrid(table, items, captions, rules, proof) {
  if (!proof) return
  const { rect, height, width } = proof,
    crop = table.cropRect,
    source = items.filter(
      (i) =>
        i.horizontal &&
        i.rect[0] >= rect[0] - 0.01 &&
        i.rect[2] <= rect[2] + 0.01 &&
        i.baseline > rect[1] &&
        i.baseline < rect[3]
    ),
    header = source.filter((i) => i.baseline <= proof.headerBottom),
    body = source.filter((i) => i.baseline > proof.headerBottom),
    records = proof.anchors.map(() => []),
    initial = [rect[0], ...proof.cuts, rect[2]],
    lane = (i) => initial.slice(1).findIndex((x) => center(i) < x)
  if (!completeInk(items, source, rect)) return
  for (const i of body) {
    const owners = proof.anchors
      .map((b, n) => ({ b, n }))
      .filter(({ b }) => Math.abs(i.baseline - b) < height * 0.65)
    if (owners.length !== 1) return
    records[owners[0].n].push(i)
  }
  if (!hasUniqueRecordTokens(source, [header, ...records])) return
  if (width === 9) {
    for (const c of [5, 6]) {
      const gaps = []
      for (let n = 0; n < records.length; n++) {
        const line = records[n]
          .filter((i) => Math.abs(i.baseline - proof.anchors[n]) < height * 0.1)
          .sort((a, b) => a.rect[0] - b.rect[0])
        if (line.filter((i) => i.text === '±').length !== 3) return
        const matches = line
          .slice(1)
          .map((i, k) => [line[k].rect[2], i.rect[0]])
          .filter(
            (b) => b[1] - b[0] >= height * 0.25 && Math.abs((b[0] + b[1]) / 2 - initial[c]) < height
          )
        if (matches.length !== 1) return
        gaps.push(matches[0])
      }
      const left = Math.max(...gaps.map((b) => b[0])),
        right = Math.min(...gaps.map((b) => b[1]))
      if (right - left < height * 0.25) return
      initial[c] = (left + right) / 2
    }
  }
  const lanes = initial.slice(1).map((_, c) => body.filter((i) => lane(i) === c)),
    cuts = [crop[0]]
  for (let c = 1; c < width; c++) {
    const left = box(lanes[c - 1])[2],
      right = box(lanes[c])[0]
    if (right - left < -0.002) return
    cuts.push((left + right) / 2)
  }
  cuts.push(crop[2])
  // Adjacent runs can round their independent font-box edges by <.002px.
  // Recognize each already unique lane separately; exported boxes are untouched.
  const read = (row, multiline = false) =>
    cuts.slice(1).map(
      (_, c) =>
        readSourceRow(
          row.filter((i) => lane(i) === c),
          [cuts[c] - 0.002, cuts[c + 1] + 0.002],
          { multiline }
        )?.[0]
    )
  const head = initial.slice(1).map((_, c) =>
      header
        .filter((i) => lane(i) === c)
        .map((i) => i.text)
        .join('')
    ),
    values = records.map((row) => read(row)),
    scalar = /^[−-]?\d+\.\d+$/,
    paired = /^[−-]?\d+\.\d+±\d+\.\d+$/,
    stack = /^[−-]?\d+\.\d+[+−.\d]+$/
  if (
    !head?.every((v) => /\p{L}/u.test(v)) ||
    values.some(
      (v) =>
        !v ||
        !/^\d{6,20}$/.test(v[0]) ||
        !/\p{L}/u.test(v[1]) ||
        !(width === 9
          ? stack.test(v[2]) &&
            stack.test(v[3]) &&
            v.slice(4, 7).every((t) => paired.test(t)) &&
            /\p{L}/u.test(v[7]) &&
            stack.test(v[8])
          : /\p{L}/u.test(v[2]) &&
            stack.test(v[3]) &&
            v.slice(4).every((t) => /^\p{L}{1,10}$/u.test(t)))
    ) ||
    values.some((v) =>
      v.slice(width === 9 ? 2 : 3, width === 9 ? 4 : 4).some((s) => scalar.test(s))
    )
  )
    return
  const edges = [crop[1], proof.headerBottom]
  for (let n = 1; n < records.length; n++) {
    const bottom = Math.max(...records[n - 1].map((i) => (i.rect[1] + i.rect[3]) / 2)),
      top = Math.min(...records[n].map((i) => (i.rect[1] + i.rect[3]) / 2))
    if (bottom >= top) return
    edges.push((bottom + top) / 2)
  }
  edges.push(crop[3])
  const stackProofs = []
  for (const row of records)
    for (const c of width === 9 ? [2, 3, 8] : [3]) {
      const group = row.filter((i) => lane(i) === c),
        bounds = box(group),
        crossing = rules.filter(
          (r) =>
            r[1] === r[3] &&
            r[1] > bounds[1] &&
            r[1] < bounds[3] &&
            r[0] === rect[0] &&
            r[2] === rect[2]
        )
      const ctx =
        crossing.length === 1
          ? { tokens: new Set(group), divider: crossing[0][1], smallFontBoundary: true }
          : undefined
      if (!recoverNativeStackedUncertainty(group, rules, ctx ? [ctx] : undefined)) return
      if (ctx) stackProofs.push(ctx)
    }
  return {
    cropRect: crop,
    rows: edges.slice(1).map((y, n) => [crop[0], edges[n], crop[2], y]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], crop[1], x, crop[3]]),
    spans: [],
    headerRows: [0],
    completeSpans: true,
    ownedTokens: new Set(source),
    equalFontStacks: stackProofs,
    preservePhysicalRows: true,
    repair: 'native-body-records-recovered'
  }
}
