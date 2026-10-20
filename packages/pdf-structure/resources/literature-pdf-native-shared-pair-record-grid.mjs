/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'
import { hasUniqueRecordTokens } from './literature-pdf-source-records.mjs'

const box = (items) => [
  Math.min(...items.map((i) => i.rect[0])),
  Math.min(...items.map((i) => i.rect[1])),
  Math.max(...items.map((i) => i.rect[2])),
  Math.max(...items.map((i) => i.rect[3]))
]
const literal = (items) =>
  [...items]
    .sort((a, b) => a.rect[0] - b.rect[0])
    .map((i) => i.text)
    .join('')
    .replace(/\s/gu, '')
const numeric = (s) => /^(?:[−+-]?\d+(?:\.\d+)?|\.\.\.)$/.test(s)

function laneGroups(items, h) {
  const groups = []
  for (const item of items
    .filter((i) => Math.abs(i.height - h) < h * 0.04)
    .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    const last = groups.at(-1)
    if (last && Math.abs(last[0].baseline - item.baseline) < h * 0.04) last.push(item)
    else groups.push([item])
  }
  if (!groups.length) return
  for (const i of items.filter((i) => Math.abs(i.height - h) >= h * 0.04)) {
    const owners = groups.filter((g) => Math.abs(g[0].baseline - i.baseline) < h * 0.45)
    if (owners.length !== 1 || i.height < h * 0.55 || i.height > h * 0.8) return
    owners[0].push(i)
  }
  return hasUniqueRecordTokens(items, groups) ? groups : undefined
}

// Repeated pairs of three independently measured lanes can share the other
// six lanes only when both complete pairs have the same native geometry.
// Empty model values cannot create these spans.
export function recoverNativeSharedPairRecordGrid(table, items, captions, rules) {
  const crop = table.cropRect,
    near = items.filter(
      (i) =>
        i.text?.trim() &&
        i.rect[0] < crop[2] &&
        i.rect[2] > crop[0] &&
        i.baseline > crop[1] &&
        i.baseline < crop[3]
    )
  if (!near.length) return
  const h = near.map((i) => i.height).sort((a, b) => a - b)[Math.floor(near.length / 2)]
  // Fragmented script glyphs outnumber normal glyphs in some PDFs. The
  // repeated largest source font supplies the physical record baselines.
  const main = Math.max(...near.map((i) => i.height))
  if (!(h > 0) || main > h * 1.9) return
  const full = joinHorizontalTableRules(rules)
    .filter(
      (r) =>
        r[1] >= crop[1] - main * 0.3 &&
        r[1] <= crop[3] + main * 0.3 &&
        Math.abs(r[0] - crop[0]) < main &&
        Math.abs(r[2] - crop[2]) < main
    )
    .sort((a, b) => a[1] - b[1])
  if (
    full.length < 5 ||
    full.length > 12 ||
    full.some((r) => Math.abs(r[0] - full[0][0]) > 0.02 || Math.abs(r[2] - full[0][2]) > 0.02)
  )
    return
  const opening = full[0],
    divider = full.find((r) => r[1] - opening[1] > main * 0.7),
    closing = full.at(-1)
  if (!divider || divider === closing || divider[1] - opening[1] > main * 2.5) return
  if (
    captions.filter(
      (c) =>
        captionKind(c.lines[0]) === 'table' &&
        c.rect[3] <= opening[1] &&
        opening[1] - c.rect[3] < main * 8 &&
        c.rect[0] < opening[2] &&
        c.rect[2] > opening[0]
    ).length !== 1
  )
    return
  const vertical = rules.filter(
    (r) =>
      Math.abs(r[0] - r[2]) < 0.02 &&
      r[0] > opening[0] &&
      r[0] < opening[2] &&
      r[1] >= opening[1] - 0.02 &&
      r[3] <= closing[1] + 0.02 &&
      r[3] > r[1]
  )
  const xs = [...new Set(vertical.map((r) => Math.round(r[0] * 100) / 100))].sort((a, b) => a - b)
  if (xs.length !== 8) return
  const cuts = [
    opening[0],
    ...xs.map((x) => vertical.find((r) => Math.abs(r[0] - x) < 0.02)[0]),
    opening[2]
  ]
  const stops = []
  for (const x of cuts.slice(1, -1)) {
    const segments = vertical.filter((r) => Math.abs(r[0] - x) < 0.02).sort((a, b) => a[1] - b[1])
    if (
      segments.length < 8 ||
      segments[0][1] - opening[1] > main * 0.3 ||
      closing[1] - segments.at(-1)[3] > main * 0.05
    )
      return
    let end = segments[0][3]
    for (const r of segments.slice(1)) {
      if (r[1] - end > main * 0.1) return
      end = Math.max(end, r[3])
    }
    stops.push(segments.map((r) => r[3]))
  }
  const source = near.filter((i) => i.baseline > opening[1] && i.baseline < closing[1])
  if (
    items.some(
      (i) =>
        i.text?.trim() &&
        i.rect[0] < opening[2] &&
        i.rect[2] > opening[0] &&
        i.rect[1] < closing[1] &&
        i.rect[3] > opening[1] &&
        !source.includes(i)
    )
  )
    return
  if (
    source.some(
      (i) =>
        i.horizontal === false ||
        ![...i.rect, i.baseline, i.height].every(Number.isFinite) ||
        i.height < main * 0.55 ||
        i.height > main * 1.04 ||
        i.rect[1] < opening[1] ||
        i.rect[3] > closing[1] ||
        !cuts.slice(1).some((x, n) => i.rect[0] >= cuts[n] - 0.02 && i.rect[2] <= x + 0.02)
    )
  )
    return
  const header = source.filter((i) => i.baseline < divider[1]),
    body = source.filter((i) => i.baseline > divider[1])
  if (
    cuts
      .slice(1)
      .some((x, n) => !header.some((i) => i.rect[0] >= cuts[n] - 0.02 && i.rect[2] <= x + 0.02))
  )
    return
  const lanes = cuts
      .slice(1)
      .map((x, n) => body.filter((i) => i.rect[0] >= cuts[n] - 0.02 && i.rect[2] <= x + 0.02)),
    groups = lanes.map((l) => laneGroups(l, main))
  if (groups.some((g) => !g)) return
  const varying = [4, 5, 6],
    shared = [0, 1, 2, 3, 7, 8]
  const anchors = groups[4].map(
    (g) => g.find((i) => Math.abs(i.height - main) < main * 0.04).baseline
  )
  if (
    anchors.length < 8 ||
    anchors.length > 40 ||
    varying.some(
      (k) =>
        groups[k].length !== anchors.length ||
        groups[k].some(
          (g, n) =>
            Math.abs(g.find((i) => Math.abs(i.height - main) < main * 0.04).baseline - anchors[n]) >
              main * 0.04 ||
            !numeric(literal(g.filter((i) => Math.abs(i.height - main) < main * 0.04)))
        )
    )
  )
    return
  const ownership = [],
    pairPatterns = []
  for (let k = 0; k < 9; k++) {
    const plan = []
    for (const group of groups[k]) {
      const y = group.find((i) => Math.abs(i.height - main) < main * 0.04).baseline
      const exact = anchors.map((a, n) => ({ a, n })).filter((a) => Math.abs(a.a - y) < main * 0.04)
      if (exact.length === 1) {
        plan.push({ row: exact[0].n + 1, span: 1, items: group })
        continue
      }
      if (!shared.includes(k)) return
      const pairs = anchors
        .slice(1)
        .map((a, n) => ({ a, n }))
        .filter(
          ({ a, n }) => y > anchors[n] && y < a && Math.abs(y - (anchors[n] + a) / 2) < main * 0.15
        )
      if (pairs.length !== 1) return
      plan.push({ row: pairs[0].n + 1, span: 2, items: group })
    }
    const covered = plan.flatMap((p) => Array.from({ length: p.span }, (_v, n) => p.row + n))
    if (covered.length !== anchors.length || new Set(covered).size !== anchors.length) return
    ownership.push(plan)
    if (shared.includes(k)) pairPatterns.push(plan.filter((p) => p.span === 2).map((p) => p.row))
  }
  if (
    pairPatterns[0].length < 2 ||
    pairPatterns.some((p) => JSON.stringify(p) !== JSON.stringify(pairPatterns[0]))
  )
    return
  if (
    shared.some((k) =>
      ownership[k]
        .filter((p) => p.span === 2)
        .some((p) => (k === 0 ? !/\p{L}/u.test(literal(p.items)) : !/[\d]/u.test(literal(p.items))))
    )
  )
    return
  const bands = anchors.map((_y, n) =>
      varying.flatMap((k) => ownership[k].find((p) => p.row === n + 1).items)
    ),
    edges = [box(header)[1], divider[1]]
  for (let n = 1; n < bands.length; n++) {
    const a = box(bands[n - 1])[3],
      b = box(bands[n])[1]
    if (b <= a) return
    const native = stops[0].filter(
      (y) =>
        y >= a - 0.02 && y <= b + 0.02 && stops.every((s) => s.some((z) => Math.abs(z - y) < 0.02))
    )
    if (native.length !== 1) return
    edges.push(native[0])
  }
  edges.push(closing[1])
  const spans = []
  for (let k = 0; k < 9; k++)
    for (const p of ownership[k]) {
      if (p.items.some((i) => i.rect[1] < edges[p.row] || i.rect[3] > edges[p.row + p.span])) return
      if (p.span > 1) spans.push({ row: p.row, column: k, rowSpan: p.span, colSpan: 1 })
    }
  if (!hasUniqueRecordTokens(source, [header, ...ownership.flatMap((l) => l.map((p) => p.items))]))
    return
  return {
    rows: edges.slice(1).map((y, n) => [opening[0], edges[n], opening[2], y]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], edges[0], x, closing[1]]),
    headerRows: [0],
    spans,
    completeSpans: true,
    ownedTokens: new Set(source),
    preservePhysicalRows: true,
    repair: 'native-body-records-recovered'
  }
}
