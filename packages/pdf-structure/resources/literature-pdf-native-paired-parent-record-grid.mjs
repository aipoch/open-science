/* eslint-disable @typescript-eslint/explicit-function-return-type */
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
const numeric = (s) => /^[−+-]?\d+(?:\.\d+)?$/.test(s)
export function recoverNativePairedParentRecordGrid(table, items, captions, rules) {
  if (
    !Array.isArray(table?.cropRect) ||
    table.cropRect.length !== 4 ||
    !table.cropRect.every(Number.isFinite) ||
    items.some(
      (i) =>
        !Array.isArray(i.rect) ||
        i.rect.length !== 4 ||
        !i.rect.every(Number.isFinite) ||
        !Number.isFinite(i.baseline) ||
        !Number.isFinite(i.height) ||
        i.height <= 0
    ) ||
    rules.some((r) => !Array.isArray(r) || r.length !== 4 || !r.every(Number.isFinite))
  )
    return
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
  const full = rules
    .filter(
      (r) =>
        Math.abs(r[1] - r[3]) < 0.02 &&
        Math.abs(r[0] - crop[0]) < h * 0.3 &&
        Math.abs(r[2] - crop[2]) < h * 0.3 &&
        r[1] >= crop[1] &&
        r[1] < crop[3]
    )
    .sort((a, b) => a[1] - b[1])
  if (
    full.length !== 2 ||
    full[1][1] - full[0][1] < h * 2 ||
    full[1][1] - full[0][1] > h * 4 ||
    Math.abs(full[0][0] - full[1][0]) > 0.02 ||
    Math.abs(full[0][2] - full[1][2]) > 0.02
  )
    return
  const [opening, divider] = full
  if (
    captions.filter(
      (c) =>
        /^Table\s+\d/i.test(c.lines[0]) &&
        c.rect[3] < opening[1] &&
        opening[1] - c.rect[3] < h * 6 &&
        c.rect[0] < opening[2] &&
        c.rect[2] > opening[0]
    ).length !== 1
  )
    return
  const source = near.filter(
    (i) =>
      i.rect[1] > opening[1] &&
      i.rect[3] < crop[3] &&
      !captions.some(
        (c) =>
          c.rect[0] <= i.rect[0] &&
          c.rect[1] <= i.rect[1] &&
          c.rect[2] >= i.rect[2] &&
          c.rect[3] >= i.rect[3]
      )
  )
  // A note outside the recovered body is not a record. Its canonical input is
  // deliberately not inferred here: use only source through the last complete
  // measured baseline before the first differently styled note/body line.
  const groups = []
  for (const i of source
    .filter((i) => Math.abs(i.height - h) < h * 0.04)
    .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    const last = groups.at(-1)
    if (last && Math.abs(last[0].baseline - i.baseline) < h * 0.04) last.push(i)
    else groups.push([i])
  }
  const header = groups.filter((g) => g[0].baseline < divider[1]),
    body = groups.filter((g) => g[0].baseline > divider[1])
  if (
    header.length !== 2 ||
    body.length !== 6 ||
    source.length !== header.flat().length + body.flat().length
  )
    return
  if (body.some((g) => g.some((i) => Math.abs(i.height - h) > h * 0.04))) return
  const measured = body.filter(
    (g) => g.length === 10 && g.filter((i) => numeric(i.text.trim())).length === 8
  )
  const labels = body.filter(
    (g) => g.length === 2 && g.every((i) => /\p{L}/u.test(i.text) && !numeric(i.text.trim()))
  )
  if (
    measured.length !== 4 ||
    labels.length !== 2 ||
    body[0] !== labels[0] ||
    body[3] !== labels[1]
  )
    return
  const lanes = measured[0].map((i) => box(measured.map((g) => g[measured[0].indexOf(i)])))
  const cuts = [opening[0]]
  for (let k = 1; k < 10; k++) {
    if (lanes[k - 1][2] >= lanes[k][0]) return
    cuts.push((lanes[k - 1][2] + lanes[k][0]) / 2)
  }
  cuts.push(opening[2])
  if (
    measured.some((g) => g.some((i, k) => i.rect[0] < cuts[k] || i.rect[2] > cuts[k + 1])) ||
    measured.some((g) => !/[\p{L}]/u.test(g[0].text) || g[0].text !== g[5].text)
  )
    return
  const leaf = header[1],
    leafGroups = []
  for (const k of [1, 2, 3, 4, 6, 7, 8, 9]) {
    const owned = leaf.filter((i) => i.rect[0] >= cuts[k] && i.rect[2] <= cuts[k + 1])
    if (!owned.length) return
    leafGroups.push(owned)
  }
  if (
    leafGroups.flat().length !== leaf.length ||
    leafGroups.slice(0, 4).some((g, k) => literal(g) !== literal(leafGroups[k + 4]))
  )
    return
  if (
    new Set(leafGroups.slice(0, 4).map(literal)).size !== 4 ||
    leafGroups.some((g) => !/[\p{L}]/u.test(literal(g)) || !/[\d]/.test(literal(g)))
  )
    return
  const parents = header[0],
    parentGroups = [
      parents.filter((i) => i.rect[0] >= cuts[1] && i.rect[2] <= cuts[5]),
      parents.filter((i) => i.rect[0] >= cuts[6] && i.rect[2] <= cuts[10])
    ]
  if (
    parentGroups.some((g) => !g.length || !/[\p{L}]/u.test(literal(g))) ||
    parentGroups.flat().length !== parents.length
  )
    return
  for (let k = 0; k < 2; k++) {
    const p = box(parentGroups[k]),
      first = box(leafGroups[k * 4]),
      last = box(leafGroups[k * 4 + 3])
    if (p[0] >= first[2] || p[2] <= last[0]) return
  }
  // Parent scope is limited to the four repeated leaves whose native lane
  // envelopes contain the complete parent run; neither empty stub can own it.
  const owned = [...parents, ...leaf, ...body.flat()],
    b = box(owned)
  const frame = [opening[0] - 0.5, opening[1] - 0.5, opening[2] + 0.5, b[3] + 0.5]
  const physical = items.filter(
    (i) =>
      i.text?.trim() &&
      i.rect[0] < frame[2] &&
      i.rect[2] > frame[0] &&
      i.rect[1] < frame[3] &&
      i.rect[3] > frame[1]
  )
  if (
    physical.length !== owned.length ||
    physical.some((i) => !owned.includes(i)) ||
    new Set(owned).size !== owned.length
  )
    return
  const rows = [parents, leaf, ...body],
    edges = [opening[1]]
  for (let k = 1; k < rows.length; k++) {
    const previous = box(rows[k - 1])[3],
      next = box(rows[k])[1]
    if (next <= previous) return
    edges.push(k === 2 ? divider[1] : (previous + next) / 2)
  }
  edges.push(frame[3])
  return {
    rows: edges.slice(1).map((y, k) => [frame[0], edges[k], frame[2], y]),
    columns: cuts.slice(1).map((x, k) => [cuts[k], frame[1], x, frame[3]]),
    headerRows: [0, 1],
    spans: [
      { row: 0, column: 1, rowSpan: 1, colSpan: 4 },
      { row: 0, column: 6, rowSpan: 1, colSpan: 4 }
    ],
    ownedTokens: new Set(owned),
    cropRect: frame,
    completeSpans: true,
    preservePhysicalRows: true,
    repair: 'native-body-records-recovered'
  }
}
