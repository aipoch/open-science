/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
const box = (a) => [
  Math.min(...a.map((i) => i.rect[0])),
  Math.min(...a.map((i) => i.rect[1])),
  Math.max(...a.map((i) => i.rect[2])),
  Math.max(...a.map((i) => i.rect[3]))
]
const literal = (a) => a.map((i) => i.text).join('')
const valid = (i) =>
  i.horizontal &&
  typeof i.text === 'string' &&
  i.text.trim() &&
  Number.isFinite(i.baseline) &&
  Number.isFinite(i.height) &&
  i.height > 0 &&
  Array.isArray(i.rect) &&
  i.rect.length === 4 &&
  i.rect.every(Number.isFinite) &&
  i.rect[0] < i.rect[2] &&
  i.rect[1] < i.rect[3]
function bands(items, h) {
  const out = []
  for (const i of [...items].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    const last = out.at(-1)
    if (last && Math.abs(last[0].baseline - i.baseline) < h * 0.03) last.push(i)
    else out.push([i])
  }
  return out.map((r) => r.sort((a, b) => a.rect[0] - b.rect[0]))
}
function descriptor(items, runs) {
  const text = runs.map((r) => r.text).join('')
  if ([...text].sort().join('') !== [...literal(items)].sort().join('')) return
  return {
    tokens: new Set(items),
    runs,
    geometry: items.map((i) => ({
      item: i,
      text: i.text,
      baseline: i.baseline,
      height: i.height,
      rect: [...i.rect]
    }))
  }
}
function stacked(items, h) {
  const tail = items.filter((i) => Math.abs(i.height - h) < h * 0.03 && /^\p{L}$/u.test(i.text))
  if (tail.length > 1) return
  const rest = items.filter((i) => !tail.includes(i)),
    rows = bands(rest, h)
  if (rows.length !== 3) return
  rows.forEach((r) => r.sort((a, b) => a.rect[0] - b.rect[0]))
  const [up, main, down] = rows,
    mb = box(main),
    ub = box(up),
    db = box(down)
  const num = '\\d+(?:\\.\\d+)?'
  if (
    !new RegExp(`^[−-]?${num}$`).test(literal(main)) ||
    !new RegExp(`^\\+${num}$`).test(literal(up)) ||
    !new RegExp(`^[−-]${num}$`).test(literal(down))
  )
    return
  const script = up[0].height,
    dy = main[0].baseline - up[0].baseline,
    dd = down[0].baseline - main[0].baseline
  if (
    script < h * 0.55 ||
    script > h * 0.75 ||
    main.some((i) => Math.abs(i.height - h) > h * 0.03) ||
    [...up, ...down].some((i) => Math.abs(i.height - script) > h * 0.03) ||
    dy < h * 0.2 ||
    dy > h * 0.5 ||
    dd < h * 0.15 ||
    dd > h * 0.45 ||
    ub[0] - mb[2] < -h * 0.03 ||
    ub[0] - mb[2] > h * 0.35 ||
    Math.abs(ub[0] - db[0]) > h * 0.05 ||
    ub[3] > db[1] + h * 0.05
  )
    return
  if (
    rows.some((r) =>
      r.some(
        (i, n) =>
          n && (i.rect[0] - r[n - 1].rect[2] < -h * 0.03 || i.rect[0] - r[n - 1].rect[2] > h * 0.15)
      )
    )
  )
    return
  if (
    tail.length &&
    (Math.abs(tail[0].baseline - main[0].baseline) > h * 0.03 ||
      tail[0].rect[0] <= Math.max(ub[2], db[2]) ||
      tail[0].rect[0] - Math.max(ub[2], db[2]) > h * 0.2)
  )
    return
  const runs = [
    { text: literal(main), position: 'normal' },
    { text: literal(up), position: 'superscript' },
    { text: literal(down), position: 'subscript' }
  ]
  if (tail.length) runs.push({ text: tail[0].text, position: 'normal' })
  return {
    proof: descriptor(items, runs),
    tail: tail[0],
    offset: [dy, dd],
    script,
    main: main[0].baseline
  }
}
function literalRuns(items, baseline, h) {
  const rows = bands(items, h)
  if (
    rows.some((r) => Math.abs(r[0].baseline - baseline) > h * 0.5) ||
    rows.some((r) => r.some((i, n) => n && i.rect[0] < r[n - 1].rect[2] - h * 0.03)) ||
    !items.some(
      (i) => Math.abs(i.baseline - baseline) < h * 0.03 && Math.abs(i.height - h) < h * 0.03
    )
  )
    return
  const sorted = [...items].sort((a, b) => a.rect[0] - b.rect[0] || a.baseline - b.baseline)
  const runs = []
  for (const i of sorted) {
    const dy = i.baseline - baseline,
      position = Math.abs(dy) < h * 0.03 ? 'normal' : dy < 0 ? 'superscript' : 'subscript'
    if (position !== 'normal' && (i.height < h * 0.55 || i.height > h * 1.03)) return
    const last = runs.at(-1)
    if (last?.position === position) last.text += i.text
    else runs.push({ text: i.text, position })
  }
  return descriptor(items, runs)
}

// Complete physical records and all native glyphs are proved before a cell
// receives the exceptional divider font-box ownership. Neither values nor
// scripts are reconstructed from an output string or a scientific meaning.
export function recoverNativeStackedRecordGrid(table, items, captions, rules) {
  const crop = table.cropRect
  if (
    !crop?.every(Number.isFinite) ||
    items.some(
      (i) =>
        i.text?.trim() &&
        (!Array.isArray(i.rect) ||
          i.rect.length !== 4 ||
          !i.rect.every(Number.isFinite) ||
          !Number.isFinite(i.baseline) ||
          !Number.isFinite(i.height))
    )
  )
    return
  const cols = table.structure?.objects
    ?.filter((o) => o.label === 'table column')
    .map((o) => [o.rect[0] + crop[0], o.rect[2] + crop[0]])
    .sort((a, b) => a[0] - b[0])
  if (!cols || ![9, 11].includes(cols.length)) return
  const hItems = items.filter(
    (i) =>
      valid(i) &&
      i.rect[0] >= crop[0] &&
      i.rect[2] <= cols[0][1] &&
      i.baseline > crop[1] &&
      i.baseline < crop[3]
  )
  const sizes = hItems.map((i) => i.height).sort((a, b) => a - b),
    h = sizes[sizes.length >> 1]
  if (!(h > 0)) return
  const full = rules
    .filter(
      (r) =>
        r.every(Number.isFinite) &&
        r[1] === r[3] &&
        Math.abs(r[0] - crop[0]) < h &&
        Math.abs(r[2] - crop[2]) < h &&
        r[1] > crop[1] - h &&
        r[1] < crop[3] + h
    )
    .sort((a, b) => a[1] - b[1])
  if (
    full.length !== 4 ||
    full.some((r) => Math.abs(r[0] - full[0][0]) > 0.02 || Math.abs(r[2] - full[0][2]) > 0.02) ||
    full[1][1] - full[0][1] < h * 0.15 ||
    full[1][1] - full[0][1] > h * 0.4
  )
    return
  const [top, opening, divider, closing] = full
  if (
    captions.filter(
      (c) =>
        captionKind(c.lines?.[0] ?? '') === 'table' &&
        c.rect[3] < top[1] &&
        top[1] - c.rect[3] < h * 4 &&
        c.rect[0] < closing[2] &&
        c.rect[2] > closing[0]
    ).length !== 1
  )
    return
  const source = items.filter(
    (i) =>
      i.text?.trim() &&
      i.rect[0] < Math.max(crop[2], closing[2]) &&
      i.rect[2] > Math.min(crop[0], closing[0]) &&
      i.rect[1] < closing[1] + 0.5 &&
      i.rect[3] > top[1] - 0.5
  )
  if (
    !source.length ||
    new Set(source).size !== source.length ||
    source.some(
      (i) =>
        !valid(i) ||
        i.rect[0] < closing[0] ||
        i.rect[2] > closing[2] ||
        i.rect[1] < top[1] ||
        i.rect[3] > closing[1] ||
        i.baseline <= opening[1]
    )
  )
    return
  const header = source.filter((i) => i.baseline < divider[1]),
    body = source.filter((i) => i.baseline > divider[1])
  if (header.length + body.length !== source.length || !header.length || !body.length) return
  const originalCuts = [
      closing[0],
      ...cols.slice(1).map((c, n) => (cols[n][1] + c[0]) / 2),
      closing[2]
    ],
    originalLane = (i) => originalCuts.findIndex((x, n) => n && (i.rect[0] + i.rect[2]) / 2 < x) - 1
  if (source.some((i) => originalLane(i) < 0)) return
  const anchors = bands(
    body.filter((i) => originalLane(i) === 0 && Math.abs(i.height - h) < h * 0.03),
    h
  )
  if (anchors.length < 4 || anchors.length > 30) return
  const ys = anchors.map((a) => a[0].baseline)
  if (ys.some((y, n) => n && (y - ys[n - 1] < h * 1.2 || y - ys[n - 1] > h * 3))) return
  const records = ys.map(() => [])
  for (const i of body) {
    const owners = ys
      .map((y, n) => ({ y, n }))
      .filter(
        (a) => Math.abs(a.y - i.baseline) < (Math.abs(i.height - h) < h * 0.03 ? h * 0.03 : h * 0.5)
      )
    if (owners.length !== 1) return
    records[owners[0].n].push(i)
  }
  const nativeCuts = [
    ...new Set(
      rules.filter((r) => r[0] === r[2] && r[0] > closing[0] && r[0] < closing[2]).map((r) => r[0])
    )
  ].sort((a, b) => a - b)
  let cuts
  if (cols.length === 9) {
    if (
      nativeCuts.length !== 8 ||
      nativeCuts.some((x) =>
        [
          ...ys,
          ...bands(
            header.filter((i) => Math.abs(i.height - h) < h * 0.03),
            h
          )
            .filter((a) => a.length >= cols.length * 0.55)
            .map((a) => a[0].baseline)
        ].some((y) => !rules.some((r) => r[0] === x && r[2] === x && r[1] <= y && r[3] >= y))
      )
    )
      return
    cuts = [closing[0], ...nativeCuts, closing[2]]
  } else {
    if (nativeCuts.length) return
    const extents = cols.map((_, c) => box(source.filter((i) => originalLane(i) === c)))
    if (
      extents.some((e) => !e.every(Number.isFinite)) ||
      extents.some((e, n) => n && e[0] - extents[n - 1][2] < h * 0.1)
    )
      return
    cuts = [closing[0], ...extents.slice(1).map((e, n) => (extents[n][2] + e[0]) / 2), closing[2]]
  }
  const lane = (i) => cuts.findIndex((x, n) => n && i.rect[0] >= cuts[n - 1] && i.rect[2] <= x) - 1
  if (source.some((i) => lane(i) < 0 || lane(i) !== originalLane(i))) return
  const headerBases = bands(
    header.filter((i) => Math.abs(i.height - h) < h * 0.03),
    h
  )
    .filter((a) => a.length >= cols.length * 0.55)
    .map((a) => a[0].baseline)
  if (
    headerBases.length !== (cols.length === 9 ? 1 : 2) ||
    headerBases.some((y, n) => n && y - headerBases[n - 1] < h)
  )
    return
  const headerBands = headerBases.map(() => [])
  for (const i of header) {
    const near = headerBases
      .map((y, n) => ({ y, n, d: Math.abs(y - i.baseline) }))
      .sort((a, b) => a.d - b.d)
    if (near[0].d > h * 0.5 || near[1]?.d - near[0].d < h * 0.1) return
    headerBands[near[0].n].push(i)
  }
  if (cols.some((_, c) => !headerBands[0].some((i) => lane(i) === c && /\p{L}/u.test(i.text))))
    return
  const proofs = [],
    stacks = []
  for (let n = 0; n < records.length; n++)
    for (let c = 0; c < cols.length; c++) {
      const own = records[n].filter((i) => lane(i) === c)
      if (!own.length) return
      const p = stacked(own, h)
      if (p) {
        if (Math.abs(p.main - ys[n]) > h * 0.03) return
        stacks.push({ ...p, column: c, row: n, tokens: own })
        proofs.push(p.proof)
      } else {
        if (
          own.some((i) => Math.abs(i.height - h) > h * 0.03) &&
          !(
            cols.length === 9 &&
            c === cols.length - 1 &&
            own
              .filter((i) => Math.abs(i.height - h) > h * 0.03)
              .every((i) => /^[*∗]+$/.test(i.text))
          )
        )
          return
        const p = literalRuns(own, ys[n], h)
        if (!p) return
        proofs.push(p)
      }
    }
  const stackColumns = [...new Set(stacks.map((p) => p.column))]
  if (
    !stackColumns.length ||
    stackColumns.some((c) => stacks.filter((p) => p.column === c).length < 4)
  )
    return
  if (
    stacks.some(
      (p) =>
        p.tail &&
        stacks.filter((q) => q.column === p.column && q.tail?.text === p.tail.text).length < 4
    )
  )
    return
  if (stacks.some((p) => p.offset.some((v, n) => Math.abs(v - stacks[0].offset[n]) > h * 0.03)))
    return
  const firstInk = Math.min(...records[0].map((i) => i.rect[1])),
    headerBottom = Math.max(...header.map((i) => i.rect[3]))
  if (
    firstInk <= headerBottom ||
    firstInk >= divider[1] ||
    divider[1] - firstInk > h * 0.1 ||
    records[0].some((i) => i.baseline <= divider[1])
  )
    return
  for (const p of stacks) {
    const extent = box(p.tokens)
    if (
      rules.some(
        (r) =>
          r[1] === r[3] &&
          r[1] > extent[1] &&
          r[1] < extent[3] &&
          r[0] < extent[2] &&
          r[2] > extent[0] &&
          !(p.row === 0 && r === divider)
      )
    )
      return
  }
  for (let n = 0; n < headerBands.length; n++)
    for (let c = 0; c < cols.length; c++) {
      const own = headerBands[n].filter((i) => lane(i) === c)
      if (own.length) {
        const p = literalRuns(own, headerBases[n], h)
        if (!p) return
        proofs.push(p)
      }
    }
  const groups = [...headerBands, ...records],
    edges = [opening[1]]
  for (let n = 1; n < groups.length; n++) {
    const previous = Math.max(...groups[n - 1].map((i) => (i.rect[1] + i.rect[3]) / 2)),
      next = Math.min(...groups[n].map((i) => (i.rect[1] + i.rect[3]) / 2))
    if (previous >= next) return
    edges.push((previous + next) / 2)
  }
  edges.push(Math.max(...records.at(-1).map((i) => i.rect[3])))
  const spans =
    headerBands.length === 2
      ? cols.flatMap((_, c) =>
          headerBands[1].some((i) => lane(i) === c)
            ? []
            : [{ row: 0, column: c, rowSpan: 2, colSpan: 1 }]
        )
      : []
  return {
    cropRect: [closing[0], top[1] - 0.5, closing[2], closing[1] + 0.5],
    rows: edges.slice(1).map((y, n) => [closing[0], edges[n], closing[2], y]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], opening[1], x, closing[1]]),
    headerRows: headerBands.map((_, n) => n),
    spans,
    completeSpans: true,
    ownedTokens: new Set(source),
    nativeStackedRecordRuns: proofs,
    repair: 'native-body-records-recovered'
  }
}

export function recoverNativeStackedRecordRuns(items, proofs, existingRuns) {
  if (
    !Array.isArray(items) ||
    new Set(items).size !== items.length ||
    !items.every(valid) ||
    !proofs
  )
    return
  const matches = proofs.filter(
    (p) => p.tokens.size === items.length && items.every((i) => p.tokens.has(i))
  )
  if (matches.length !== 1) return
  const p = matches[0]
  if (
    !Array.isArray(p.geometry) ||
    p.geometry.length !== items.length ||
    !Array.isArray(p.runs) ||
    p.runs.some(
      (r) =>
        typeof r.text !== 'string' || !['normal', 'superscript', 'subscript'].includes(r.position)
    )
  )
    return
  if (
    p.geometry.some(
      (g) =>
        g.item.text !== g.text ||
        g.item.baseline !== g.baseline ||
        g.item.height !== g.height ||
        g.item.rect.some((v, n) => v !== g.rect[n])
    )
  )
    return
  if (
    [...p.runs.map((r) => r.text).join('')].sort().join('') !== [...literal(items)].sort().join('')
  )
    return
  // Keep established whitespace when literal order and script positions
  // already agree with the complete native proof.
  if (Array.isArray(existingRuns)) {
    const normalized = []
    for (const r of existingRuns) {
      const last = normalized.at(-1)
      if (last?.position === r.position) last.text += r.text.replace(/\s/g, '')
      else normalized.push({ text: r.text.replace(/\s/g, ''), position: r.position })
    }
    if (
      normalized.length === p.runs.length &&
      normalized.every(
        (r, n) => r.position === p.runs[n].position && r.text === p.runs[n].text.replace(/\s/g, '')
      )
    )
      return
  }
  return p.runs.map((r) => ({ ...r }))
}
