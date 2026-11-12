/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'
import { splitNativeMeasuredFields } from './literature-pdf-native-header-grid.mjs'
import { proveNativeUniqueWholeFonts } from './literature-pdf-table-evidence.mjs'

const box = (group) => [
  Math.min(...group.map((i) => i.rect[0])),
  Math.min(...group.map((i) => i.rect[1])),
  Math.max(...group.map((i) => i.rect[2])),
  Math.max(...group.map((i) => i.rect[3]))
]
const literal = (group) =>
  [...group]
    .sort((a, b) => a.rect[0] - b.rect[0])
    .map((i) => i.text)
    .join('')
    .replace(/\s/gu, '')
const number = (s) => /^(?:[−+-]?\d[\d,.]*(?:±\d[\d,.]*)?|[−–—-])%?$/u.test(s)

// A following title may touch the last stroke by a fraction of an em. Keep
// that whole font on its independent caption owner, but only when its exact
// printed title and the next native ruled header/body are also present.
function followingCaptionFonts(items, captions, horizontal, closing, em) {
  const compact = (s) => s.replace(/\s/gu, '')
  const proven = []
  for (const c of captions) {
    if (
      captionKind(c.lines?.[0]) !== 'table' ||
      c.rect[1] < closing[1] - em * 0.1 ||
      c.rect[1] > closing[1] + em ||
      c.rect[3] <= closing[1]
    )
      continue
    const fonts = items.filter(
      (i) =>
        i.text?.trim() &&
        i.rect.every((v, n) => (n < 2 ? v >= c.rect[n] - 0.02 : v <= c.rect[n] + 0.02))
    )
    if (
      !proveNativeUniqueWholeFonts(fonts, items) ||
      fonts.some(
        (i) =>
          !i.horizontal ||
          i.rect[1] < closing[1] - em * 0.1 ||
          (i.rect[1] + i.rect[3]) / 2 <= closing[1] ||
          i.sourceItem.pageNumber !== c.page
      ) ||
      compact(
        [...fonts]
          .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
          .map((i) => i.text)
          .join('')
      ) !== compact(c.lines.join(''))
    )
      continue
    const next = horizontal
      .filter(
        (r) =>
          r[1] > c.rect[3] && Math.abs(r[0] - closing[0]) < em && Math.abs(r[2] - closing[2]) < em
      )
      .sort((a, b) => a[1] - b[1])
    if (
      next.length < 3 ||
      next[0][1] - c.rect[3] > em * 3 ||
      next
        .slice(1, 3)
        .some((r) => Math.abs(r[0] - next[0][0]) > 0.02 || Math.abs(r[2] - next[0][2]) > 0.02)
    )
      continue
    const header = items.filter(
        (i) =>
          i.horizontal &&
          i.rect[0] >= next[0][0] &&
          i.rect[2] <= next[0][2] &&
          i.rect[1] > next[0][1] &&
          i.rect[3] < next[1][1]
      ),
      body = items.filter(
        (i) =>
          i.horizontal &&
          i.rect[0] >= next[0][0] &&
          i.rect[2] <= next[0][2] &&
          i.rect[1] > next[1][1] &&
          i.rect[3] < next[2][1]
      )
    if (
      header.filter((i) => /\p{L}/u.test(i.text)).length < 3 ||
      new Set(body.filter((i) => number(compact(i.text))).map((i) => i.baseline)).size < 2
    )
      continue
    proven.push(...fonts)
  }
  return new Set(proven)
}

// Repeated native child headings establish the leaf count independently of
// the detector. Parent underlines additionally prove wider groups; paired
// leaves can also repeat under a separated, complete two-tier native header.
// A shared scalar is accepted only at the exact center of its printed parent.
export function recoverNativeRepeatedMetricSourceGrid(table, items, captions, rules, runs = []) {
  const crop = table.cropRect,
    near = items.filter(
      (i) =>
        i.text?.trim() &&
        i.rect[0] < crop[2] &&
        i.rect[2] > crop[0] &&
        i.rect[1] < crop[3] &&
        i.rect[3] > crop[1]
    ),
    em = near.map((i) => i.height).sort((a, b) => a - b)[near.length >> 1]
  if (!(em > 0)) return
  const horizontal = joinHorizontalTableRules(rules),
    full = horizontal
      .filter(
        (r) =>
          r[1] >= crop[1] - em &&
          r[1] <= crop[3] + em &&
          Math.abs(r[0] - crop[0]) < em &&
          Math.abs(r[2] - crop[2]) < em
      )
      .sort((a, b) => a[1] - b[1])
  if (
    full.length < 3 ||
    full.length > 8 ||
    full.some((r) => Math.abs(r[0] - full[0][0]) > 0.02 || Math.abs(r[2] - full[0][2]) > 0.02)
  )
    return
  const opening = full[0],
    divider = full[1],
    closing = full.at(-1),
    captionFonts = followingCaptionFonts(items, captions, horizontal, closing, em),
    source = items.filter(
      (i) =>
        i.text?.trim() &&
        !captionFonts.has(i) &&
        i.rect[0] < opening[2] &&
        i.rect[2] > opening[0] &&
        i.rect[1] < closing[1] &&
        i.rect[3] > opening[1]
    )
  // An earlier closed native title tier can be just outside a clipped model
  // crop. Leave that complete owner to the existing header recognizer rather
  // than treating its internal divider as this table's opening stroke.
  if (
    horizontal.some(
      (r) =>
        r[1] < opening[1] &&
        r[1] >= crop[1] - em * 2 &&
        Math.abs(r[0] - opening[0]) < 0.02 &&
        Math.abs(r[2] - opening[2]) < 0.02 &&
        items.some(
          (i) =>
            i.horizontal &&
            i.text?.trim() &&
            i.rect[0] >= r[0] &&
            i.rect[2] <= r[2] &&
            i.rect[1] >= r[1] &&
            i.rect[3] <= opening[1]
        )
    )
  )
    return
  if (
    source.length > 2048 ||
    source.some(
      (i) =>
        !i.horizontal ||
        ![...i.rect, i.baseline, i.height].every(Number.isFinite) ||
        i.rect[0] < opening[0] - 0.02 ||
        i.rect[2] > opening[2] + 0.02 ||
        i.rect[1] < opening[1] ||
        i.rect[3] > closing[1]
    )
  )
    return
  if (
    source.some((i, n) =>
      source
        .slice(n + 1)
        .some(
          (j) =>
            Math.min(i.rect[2], j.rect[2]) - Math.max(i.rect[0], j.rect[0]) > em * 0.02 &&
            Math.min(i.rect[3], j.rect[3]) - Math.max(i.rect[1], j.rect[1]) > 0.02
        )
    )
  )
    return
  if (
    captions.filter(
      (c) =>
        captionKind(c.lines?.[0]) === 'table' &&
        c.rect[0] < opening[2] &&
        c.rect[2] > opening[0] &&
        c.rect[3] < opening[1] &&
        opening[1] - c.rect[3] < em * 8
    ).length !== 1
  )
    return
  let underlines = horizontal
    .filter((r) => r[0] > opening[0] && r[2] < opening[2] && r[1] > opening[1] && r[1] < divider[1])
    .sort((a, b) => a[0] - b[0])
  const header = source.filter((i) => i.baseline < divider[1]),
    body = source.filter((i) => i.baseline > divider[1]),
    fields = (group) => {
      const out = []
      for (const i of [...group].sort((a, b) => a.rect[0] - b.rect[0])) {
        const previous = out.at(-1)
        if (previous && i.rect[0] - box(previous)[2] < em * 0.3) previous.push(i)
        else out.push([i])
      }
      return out
    }
  let stub = [],
    parent,
    leaf
  if (!underlines.length) {
    const baseline = Math.max(...header.map((i) => i.baseline)),
      top = fields(header.filter((i) => i.baseline < baseline - em * 0.5)),
      bottom = fields(header.filter((i) => Math.abs(i.baseline - baseline) < 0.02))
    if (
      top.length < 3 ||
      top.length > 9 ||
      bottom.length !== (top.length - 1) * 2 ||
      box(top[0])[2] >= box(bottom[0])[0] ||
      new Set(
        top
          .slice(1)
          .flat()
          .map((i) => i.baseline)
      ).size !== 1
    )
      return
    stub = top[0]
    parent = top.slice(1).flat()
    leaf = bottom.flat()
    const y =
      (Math.max(...parent.map((i) => i.rect[3])) + Math.min(...leaf.map((i) => i.rect[1]))) / 2
    if (parent.some((i) => i.rect[3] >= y) || leaf.some((i) => i.rect[1] <= y)) return
    if (
      top.slice(1).some((g, k) => {
        const b = box([...bottom[k * 2], ...bottom[k * 2 + 1]]),
          p = box(g)
        return p[0] < b[0] - em || p[2] > b[2] + em
      })
    )
      return
    underlines = top.slice(1).map((_, k) => {
      const b = box([...bottom[k * 2], ...bottom[k * 2 + 1]])
      return [b[0], y, b[2], y]
    })
  } else {
    stub = header.filter(
      (i) =>
        i.rect[2] < underlines[0][0] &&
        Math.abs(i.baseline - Math.max(...header.map((j) => j.baseline))) > 0.02
    )
    parent = header.filter((i) => !stub.includes(i) && i.baseline < underlines[0][1])
    leaf = header.filter((i) => !stub.includes(i) && i.baseline > underlines[0][1])
  }
  if (
    underlines.length < 2 ||
    underlines.length > 8 ||
    underlines.some(
      (r, n) => Math.abs(r[1] - underlines[0][1]) > 0.02 || (n && r[0] <= underlines[n - 1][2])
    )
  )
    return
  const stubGroups = fields(stub),
    stubCount = stubGroups.length === 2 ? 2 : 1
  // The extra leading lane must be printed independently. Only this fully
  // fenced variant needs a native TJ split inside a repeated leaf heading.
  if (stubCount === 2)
    leaf = leaf.flatMap((i) => {
      const parts = splitNativeMeasuredFields(i, runs, em)
      return parts?.length > 1 ? parts : [i]
    })
  if (
    new Set([...stub, ...parent, ...leaf].map((i) => i.sourceToken ?? i)).size !== header.length ||
    !leaf.length ||
    leaf.some((i) => Math.abs(i.baseline - leaf[0].baseline) > 0.02) ||
    stubGroups.length > 2 ||
    stubGroups.some((g) => !/\p{L}/u.test(literal(g)))
  )
    return
  const leaves = [...stubGroups, ...fields(leaf)],
    count = leaves.length,
    groups = underlines.map((r) =>
      leaves
        .map((g, c) => ({ g, c }))
        .filter(({ g }) => {
          const b = box(g)
          return (b[0] + b[2]) / 2 > r[0] && (b[0] + b[2]) / 2 < r[2]
        })
    )
  const width = groups[0].length
  if (
    width < 2 ||
    width > 6 ||
    count !== stubCount + groups.length * width ||
    groups.some(
      (g, n) =>
        g.length !== width ||
        g.some(
          (v, k) => v.c !== stubCount + n * width + k || literal(v.g) !== literal(groups[0][k].g)
        )
    )
  )
    return
  const parents = underlines.map((r) =>
    parent.filter((i) => i.rect[0] >= r[0] - em * 0.3 && i.rect[2] <= r[2] + em * 0.3)
  )
  if (
    parents.some((g) => !g.length || !/\p{L}/u.test(literal(g))) ||
    new Set(parents.flat()).size !== parent.length
  )
    return
  const measured = body.flatMap((i) => {
      const parts = splitNativeMeasuredFields(i, runs, em)
      return parts?.length > 1 ? parts : [i]
    }),
    records = []
  for (const i of [...measured].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    const last = records.at(-1)
    if (last && Math.abs(last[0].baseline - i.baseline) < em * 0.15) last.push(i)
    else records.push([i])
  }
  const rows = records.map(fields)
  if (stubCount === 2) {
    // A native band owns one centered cohort and the same complete sequence
    // of method/metric records. Neither the cohort nor a missing measurement
    // may create an extra row; every measured fragment must fit one leaf.
    const numeric = (s) => number(s) || /^[−+-]?\d[\d,.]*(?:±\d[\d,.]*)?%?[*†‡]$/u.test(s),
      complete = rows.filter((r) => r.length === count)
    if (
      full.length < 4 ||
      records.length < 4 ||
      records.length > 80 ||
      complete.length < 2 ||
      !proveNativeUniqueWholeFonts(source, items) ||
      source.some((i) => i.sourceItem.pageNumber !== source[0].sourceItem.pageNumber) ||
      rules.some(
        (r) =>
          r[0] === r[2] &&
          r[0] > opening[0] &&
          r[0] < opening[2] &&
          r[1] < closing[1] &&
          r[3] > opening[1]
      ) ||
      complete.some(
        (r) =>
          r.slice(0, 2).some((g) => !/\p{L}/u.test(literal(g))) ||
          r.slice(2).some((g) => !numeric(literal(g)))
      )
    )
      return
    const domains = leaves.map((g, c) => box([...g, ...complete.flatMap((r) => r[c])]))
    if (domains.slice(1).some((d, c) => d[0] - domains[c][2] < em * 0.08)) return
    const cuts = [
        opening[0],
        ...domains.slice(1).map((d, c) => (domains[c][2] + d[0]) / 2),
        opening[2]
      ],
      partitions = records.map((r) =>
        cuts.slice(1).map((x, c) => r.filter((i) => i.rect[0] >= cuts[c] && i.rect[2] <= x))
      ),
      bounds = records.map(box),
      bandSpans = [],
      bandStarts = new Map()
    if (
      partitions.some(
        (p, n) =>
          p.flat().length !== records[n].length ||
          !/\p{L}/u.test(literal(p[1])) ||
          p.slice(2).some((g) => !g.length || !numeric(literal(g)))
      ) ||
      bounds.some((b, n) => n && b[1] <= bounds[n - 1][3])
    )
      return
    let methodSequence
    const covered = new Set()
    for (let b = 1; b < full.length - 1; b++) {
      const top = full[b][1],
        bottom = full[b + 1][1],
        indices = records
          .map((_, n) => n)
          .filter((n) => bounds[n][1] < bottom && bounds[n][3] > top),
        cohort = indices.filter((n) => partitions[n][0].length)
      if (
        indices.length < 2 ||
        indices.length > 8 ||
        cohort.length !== 1 ||
        indices.some((n) => bounds[n][1] <= top || bounds[n][3] >= bottom || covered.has(n)) ||
        rules.some(
          (r) => r[1] === r[3] && r[1] > top && r[1] < bottom && r[0] < cuts[1] && r[2] > cuts[0]
        )
      )
        return
      const label = partitions[cohort[0]][0],
        methods = indices.map((n) => literal(partitions[n][1])),
        baselines = indices.map((n) => partitions[n][1][0].baseline),
        mean = baselines.reduce((a, b) => a + b, 0) / baselines.length
      if (
        !/\p{L}/u.test(literal(label)) ||
        label.some((i) => Math.abs(i.baseline - mean) > em * 0.03) ||
        indices.some((n, k) =>
          partitions[n][1].some((i) => Math.abs(i.baseline - baselines[k]) > em * 0.03)
        ) ||
        (methodSequence && JSON.stringify(methods) !== methodSequence)
      )
        return
      methodSequence = JSON.stringify(methods)
      indices.forEach((n) => covered.add(n))
      bandStarts.set(indices[0], top)
      bandSpans.push({ row: indices[0] + 2, column: 0, rowSpan: indices.length, colSpan: 1 })
    }
    if (covered.size !== records.length) return
    const edges = [
      opening[1],
      underlines[0][1],
      divider[1],
      ...bounds.slice(1).map((b, n) => (bounds[n][3] + b[1]) / 2),
      closing[1]
    ]
    for (const [n, y] of bandStarts) edges[n + 2] = y
    return {
      cropRect: [opening[0], opening[1], opening[2], closing[1]],
      rows: edges.slice(1).map((y, n) => [cuts[0], edges[n], cuts.at(-1), y]),
      columns: cuts.slice(1).map((x, n) => [cuts[n], opening[1], x, closing[1]]),
      spans: [
        ...[0, 1].map((column) => ({ row: 0, column, rowSpan: 2, colSpan: 1 })),
        ...groups.map((_, n) => ({ row: 0, column: 2 + n * width, rowSpan: 1, colSpan: width })),
        ...bandSpans
      ],
      headerRows: [0, 1],
      completeSpans: true,
      preservePhysicalRows: true,
      ownedTokens: new Set(source),
      repair: 'native-body-records-recovered'
    }
  }
  const complete = rows.filter((r) => r.length === count)
  if (
    records.length < 3 ||
    records.length > 80 ||
    complete.length < 3 ||
    complete.some((r) => !literal(r[0]) || r.slice(1).some((g) => !number(literal(g))))
  )
    return
  const domains = leaves.map((g, c) => box([...g, ...complete.flatMap((r) => r[c])]))
  if (domains.slice(1).some((d, c) => d[0] - domains[c][2] < em * 0.08)) return
  const cuts = [
      opening[0],
      ...domains.slice(1).map((d, c) => (domains[c][2] + d[0]) / 2),
      opening[2]
    ],
    spans = [
      ...(stub.length ? [{ row: 0, column: 0, rowSpan: 2, colSpan: 1 }] : []),
      ...groups.map((_, n) => ({ row: 0, column: 1 + n * width, rowSpan: 1, colSpan: width }))
    ]
  const titles = rows
    .map((r, n) => ({ r, n }))
    .filter(({ r }) => r.length === 1 && /\p{L}/u.test(literal(r[0])))
  const sectionStarts = new Map()
  if (titles.length) {
    // A title is a row only when each complete ruled body band starts with
    // exactly one unchanged title and independently repeats the numeric grid.
    // A stray prose line or an incomplete measured record is not a section.
    if (
      titles.length < 2 ||
      titles.length !== full.length - 2 ||
      !proveNativeUniqueWholeFonts(
        titles.flatMap(({ r }) => r.flat()),
        items
      )
    )
      return
    for (let s = 1; s < full.length - 1; s++) {
      const top = full[s][1],
        bottom = full[s + 1][1],
        band = records
          .map((r, n) => ({ r, n, b: box(r) }))
          .filter(({ b }) => b[1] < bottom && b[3] > top),
        title = titles[s - 1]
      if (
        band.length < 3 ||
        band[0].n !== title.n ||
        band.some(({ b }) => b[1] <= top || b[3] >= bottom) ||
        band.slice(1).some(({ n }) => titles.some((t) => t.n === n)) ||
        band.slice(1).filter(({ n }) => rows[n].length === count).length < 2 ||
        band[0].b[1] - top > em ||
        band[1].b[1] - band[0].b[3] > em * 2 ||
        Math.abs(band[0].b[0] - box(rows[band[1].n][0])[0]) > em * 0.3
      )
        return
      sectionStarts.set(title.n, top)
      spans.push({ row: title.n + 2, column: 0, rowSpan: 1, colSpan: count })
    }
  }
  for (const [n, row] of rows.entries()) {
    if (sectionStarts.has(n)) continue
    if (row.length === count) continue
    if (
      row.length !== 1 + groups.length ||
      !/\p{L}/u.test(literal(row[0])) ||
      box(row[0])[2] > cuts[1] ||
      row.slice(1).some((g, k) => {
        const b = box(g),
          u = underlines[k]
        return !number(literal(g)) || Math.abs((b[0] + b[2] - u[0] - u[2]) / 2) > em * 0.15
      })
    )
      return
    for (let k = 0; k < groups.length; k++)
      spans.push({
        row: n + 2,
        column: 1 + k * width,
        rowSpan: 1,
        colSpan: width
      })
  }
  const bounds = records.map(box)
  if (bounds.some((b, n) => n && b[1] <= bounds[n - 1][3])) return
  const edges = [
    opening[1],
    underlines[0][1],
    divider[1],
    ...bounds.slice(1).map((b, n) => (bounds[n][3] + b[1]) / 2),
    closing[1]
  ]
  for (const [n, top] of sectionStarts) edges[n + 2] = top
  return {
    cropRect: [opening[0], opening[1], opening[2], closing[1]],
    rows: edges.slice(1).map((y, n) => [cuts[0], edges[n], cuts.at(-1), y]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], opening[1], x, closing[1]]),
    spans,
    headerRows: [0, 1],
    completeSpans: true,
    preservePhysicalRows: true,
    ownedTokens: new Set(source),
    repair: 'native-body-records-recovered'
  }
}
