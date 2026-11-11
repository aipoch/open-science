/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { nativePageTextPacketInventory } from './literature-pdf-figure-native-plot-labels.mjs'
import { completeNativeNodeGlyphProgram } from './literature-pdf-figure-native-plot-bands.mjs'
import { collectClosedFigureFrames, collectTableRules } from './literature-pdf-graphics.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
const valid = (r) =>
  Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3]
// Equality tolerance only for serialized native/work coordinate arithmetic.
const near = (a, b) => Math.abs(a - b) < 1e-6
const equal = (a, b) => a.length === b.length && a.every((n, i) => near(n, b[i]))
const inside = (a, b) => b.every((n, i) => (i < 2 ? n >= a[i] - 1e-6 : n <= a[i] + 1e-6))
const over = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]
const union = (rs) => [
  Math.min(...rs.map((r) => r[0])),
  Math.min(...rs.map((r) => r[1])),
  Math.max(...rs.map((r) => r[2])),
  Math.max(...rs.map((r) => r[3]))
]
// The existing complete program gate excludes transparency, blend extensions,
// forms, clipping and nondefault text rendering. Observe only its RGB state.
function colors(o) {
  let fill = '#000000',
    stroke = '#000000'
  const stack = [],
    texts = new Map(),
    paths = new Map()
  for (const [i, op] of o.fnArray.entries()) {
    const a = o.argsArray[i]
    if (op === OPS.save) stack.push({ fill, stroke })
    else if (op === OPS.restore) ({ fill, stroke } = stack.pop())
    else if (op === OPS.setFillRGBColor) fill = a[0]
    else if (op === OPS.setStrokeRGBColor) stroke = a[0]
    else if (op === OPS.showText) texts.set(i, fill)
    else if (op === OPS.constructPath) paths.set(i, stroke)
  }
  return { texts, paths }
}

function nativeSectionEvidence(
  { table, items, rows, columnRects, spans, rules, context },
  completeClaims = false
) {
  const p = context?.sourcePage,
    c = context?.nativeGlyphContext,
    s = context?.viewport?.scale,
    v = c?.viewport
  if (
    !p ||
    !c ||
    s !== 1.5 ||
    v?.scale !== 1 ||
    v.rotation !== 0 ||
    p.renderRotation !== 0 ||
    p.invalidGraphicsBounds !== 0 ||
    p.pageNumber !== c.pageNumber ||
    !/^[a-f0-9]{64}$/iu.test(c.sourceSha256 ?? '') ||
    context.viewport.rotation !== 0 ||
    !Array.isArray(v.transform) ||
    !Array.isArray(context.viewport.transform) ||
    !equal(
      context.viewport.transform,
      v.transform.map((n) => n * s)
    ) ||
    p.width !== v.width ||
    p.height !== v.height ||
    context.viewport.width !== p.width * s ||
    context.viewport.height !== p.height * s ||
    JSON.stringify(p.graphicsBounds) !== JSON.stringify(c.graphicsBounds) ||
    !valid(table?.cropRect) ||
    table.readingRotation ||
    ![items, rows, columnRects, spans, rules].every(Array.isArray) ||
    items.length > 4096 ||
    rows.length < 10 ||
    columnRects.length < 3 ||
    columnRects.length > 8 ||
    rows.some((r) => !valid(r.rect)) ||
    columnRects.some((r) => !valid(r))
  )
    return
  const tokens = c.content.items.flatMap((r, index) =>
    r.str?.trim()
      ? [
          tableTextToken(
            { ...r, sourceItem: { pageNumber: p.pageNumber, index, text: r.str } },
            v,
            0
          )
        ]
      : []
  )
  const inventory = completeClaims
    ? nativePageTextPacketInventory(
        p,
        tokens,
        c,
        true,
        new Set(items.map((i) => i.sourceItem?.index)),
        true
      )
    : nativePageTextPacketInventory(p, tokens, c, true)
  if (
    !inventory ||
    !completeNativeNodeGlyphProgram(p, tokens, collectClosedFigureFrames(c.operators, v), c)
  )
    return
  const color = colors(c.operators),
    glyphs = (r) => [...new Set(r.part.map((z) => z.g))],
    ink = (r) =>
      union(
        glyphs(r)
          .filter((g) => valid(g.ink))
          .map((g) => g.ink)
      ),
    records = new Map(inventory.records.map((r) => [r.index, r])),
    bound = new Map()
  for (const item of items) {
    const source = item.sourceItem,
      r = records.get(source?.index)
    if (
      !r ||
      bound.has(r.index) ||
      source.pageNumber !== p.pageNumber ||
      source.text !== item.text ||
      source.text !== r.r.str ||
      !item.horizontal ||
      !valid(item.rect)
    )
      return
    const native = tableTextToken({ ...r.r, sourceItem: source }, context.viewport, 0)
    if (
      !equal(item.rect, native.rect) ||
      !near(item.height, native.height) ||
      !near(item.baseline, native.baseline)
    )
      return
    bound.set(r.index, item)
  }
  const paints = []
  for (const [id, path] of inventory.evidence.paths) {
    const a = c.operators.argsArray[id]
    if (a?.[0] === OPS.endPath) continue
    const tr = Util.transform(v.transform, path.transform),
      pad = (path.lineWidth * Math.max(1, inventory.strokeMargins.get(id) ?? 10)) / 2
    if (
      !Number.isFinite(pad) ||
      pad < 0 ||
      !(Array.isArray(a?.[2]) || ArrayBuffer.isView(a?.[2])) ||
      a[2].length !== 4
    )
      return
    const box = inventory.box(
      Array.from(a[2], (n, i) => n + (i < 2 ? -pad : pad)),
      tr
    )
    if (!valid(box)) return
    const q = a[1]?.[0]
    let rule,
      actualInk,
      opaque = false
    if (
      a[0] === OPS.stroke &&
      q?.length === 6 &&
      q[0] === 0 &&
      q[3] === 1 &&
      near(tr[1], 0) &&
      near(tr[2], 0)
    ) {
      const points = [q.slice(1, 3), q.slice(4, 6)].map((z) => [
        tr[0] * z[0] + tr[4],
        tr[3] * z[1] + tr[5]
      ])
      rule = [
        Math.min(points[0][0], points[1][0]),
        Math.min(points[0][1], points[1][1]),
        Math.max(points[0][0], points[1][0]),
        Math.max(points[0][1], points[1][1])
      ]
      const half = (path.lineWidth * Math.abs(tr[3])) / 2
      actualInk = [rule[0], rule[1] - half, rule[2], rule[3] + half]
      opaque =
        near(rule[1], rule[3]) &&
        path.solidStroke &&
        path.strokeAlpha === 1 &&
        path.lineCap === 0 &&
        path.lineWidth > 0 &&
        color.paths.get(id)?.toLowerCase() !== '#ffffff' &&
        valid(actualInk) &&
        valid(path.clip) &&
        inside(path.clip, actualInk) &&
        c.graphicsBounds.filter((g) => g.kind === 'path' && g.operationIndex === id).length === 1
    }
    paints.push({ id, box, rule, ink: actualInk, opaque })
  }
  const nativeRules = collectTableRules(c.operators, v),
    groups = []
  for (const paint of paints.filter(
    (q) =>
      q.opaque &&
      nativeRules.some((r) => equal(r, q.rule)) &&
      rules.some((r) =>
        equal(
          r,
          q.rule.map((n) => n * s)
        )
      )
  )) {
    let group = groups.find(
      (g) => near(g[0].rule[0], paint.rule[0]) && near(g[0].rule[2], paint.rule[2])
    )
    if (!group) groups.push((group = []))
    group.push(paint)
  }
  return { p, c, s, v, inventory, glyphs, ink, records, bound, paints, groups, color }
}

function prove(input) {
  const { items, rows, columnRects, spans } = input
  const e = nativeSectionEvidence(input)
  if (!e) return
  const { s, inventory, glyphs, ink, bound, paints, groups, color } = e
  const frames = groups
    .filter(
      (g) =>
        g.length >= 5 &&
        columnRects.every((col) => {
          const center = (col[0] + col[2]) / 2 / s
          return center > g[0].rule[0] && center < g[0].rule[2]
        })
    )
    .map((g) => g.sort((a, b) => a.rule[1] - b.rule[1]))
    .filter((g) => {
      const frame = [g[0].rule[0], g[0].rule[1], g[0].rule[2], g.at(-1).rule[1]]
      return (
        valid(frame) &&
        items.every((item) =>
          inside(
            frame,
            item.rect.map((n) => n / s)
          )
        )
      )
    })
  if (frames.length !== 1) return
  const fences = frames[0],
    frame = [fences[0].rule[0], fences[0].rule[1], fences[0].rule[2], fences.at(-1).rule[1]]
  if (
    fences.some((f, i) => i && near(f.rule[1], fences[i - 1].rule[1])) ||
    paints.some((q) => over(q.box, frame) && (!q.opaque || !fences.includes(q))) ||
    inventory.evidence.images.some((i) => !valid(i.rect) || over(i.rect, frame))
  )
    return
  const active = inventory.records.filter((r) => valid(ink(r)) && over(ink(r), frame))
  if (
    active.length !== items.length ||
    active.some(
      (r) =>
        !bound.has(r.index) ||
        !inside(frame, ink(r)) ||
        r.part.some((z) =>
          /\s/u.test(z.c)
            ? valid(z.g.ink)
            : !valid(z.g.ink) ||
              color.texts.get(z.g.i)?.toLowerCase() === '#ffffff' ||
              inventory.records.filter((q) => q.part.some((p) => p.g === z.g)).length !== 1
        )
    ) ||
    inventory.glyphs.some(
      (g) => valid(g.ink) && over(g.ink, frame) && !active.some((r) => glyphs(r).includes(g))
    )
  )
    return
  const sections = []
  for (let i = 1; i < fences.length - 1; i++) {
    const top = fences[i].rule[1],
      bottom = fences[i + 1].rule[1],
      block = active
        .filter((r) => ink(r)[1] > top && ink(r)[3] < bottom)
        .sort((a, b) => a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0])
    if (!block.length) return
    const first = block[0],
      heading = block.filter(
        (r) =>
          near(r.rect[3], first.rect[3]) ||
          (r.rect[1] >= first.rect[1] && r.rect[3] - first.rect[3] < first.r.height * 0.2)
      )
    const owners = rows.flatMap((row, index) =>
      heading.every((r) => {
        const center = ((r.rect[1] + r.rect[3]) * s) / 2
        return center > row.rect[1] && center < row.rect[3]
      })
        ? [index]
        : []
    )
    if (owners.length !== 1 || owners[0] === 0) return
    const row = owners[0],
      band = [columnRects[0][0], rows[row].rect[1], columnRects.at(-1)[2], rows[row].rect[3]],
      headingInk = union(heading.map(ink)).map((n) => n * s)
    if (!inside(band, headingInk)) return
    const covered = spans.some(
      (slots) =>
        slots.length > 1 &&
        slots.every((slot) => slot.row === row) &&
        heading.every((r) =>
          inside(
            union(slots.map((slot) => slot.rect)),
            ink(r).map((n) => n * s)
          )
        )
    )
    sections.push({ row, heading, covered, block, band })
  }
  if (
    sections.length < 3 ||
    sections.filter((g) => g.covered).length < 2 ||
    sections.some((g) => !near(g.heading[0].rect[0], sections[0].heading[0].rect[0]))
  )
    return
  const candidates = []
  for (const section of sections.filter((g) => !g.covered)) {
    const { row, heading, block, band } = section
    if (
      heading.length !== 2 ||
      !/^\p{L}[\p{L}\p{M}\s]+$/u.test(heading[0].r.str) ||
      !/^\p{L}$/u.test(heading[1].r.str) ||
      !near(heading[0].rect[3], heading[1].rect[3]) ||
      !near(heading[0].r.height, heading[1].r.height) ||
      heading[0].rect[2] * s <= columnRects[0][2] ||
      heading[1].rect[0] <= heading[0].rect[2] ||
      heading[1].rect[0] - heading[0].rect[2] >= heading[0].r.height * 0.5 ||
      spans.some((slots) => slots.some((slot) => slot.row === row))
    )
      continue
    const body = block.filter((r) => !heading.includes(r)),
      baselines = []
    for (const r of body) {
      let g = baselines.find((g) => near(g[0].rect[3], r.rect[3]))
      if (!g) baselines.push((g = []))
      g.push(r)
    }
    if (baselines.length < 3) continue
    let complete = true
    for (const group of baselines) {
      const bodyOwners = rows.flatMap((r, index) =>
        group.every((g) => {
          const center = ((g.rect[1] + g.rect[3]) * s) / 2
          return center > r.rect[1] && center < r.rect[3]
        })
          ? [index]
          : []
      )
      if (bodyOwners.length !== 1 || bodyOwners[0] <= row) {
        complete = false
        break
      }
      const parts = columnRects.map((col) =>
        group.filter((r) => {
          const center = ((r.rect[0] + r.rect[2]) * s) / 2
          return center > col[0] && center < col[2]
        })
      )
      if (
        !parts[0].length ||
        parts.flat().length !== group.length ||
        parts.slice(1).some(
          (part) =>
            !part.length ||
            !/^[<>≤≥−+-]?(?:\d|\.\d)[\d.,%()±–−+\-/]*$/u.test(
              part
                .sort((a, b) => a.rect[0] - b.rect[0])
                .map((r) => r.r.str)
                .join('')
            )
        )
      ) {
        complete = false
        break
      }
      if (
        parts.some((part, col) =>
          part.some(
            (r) =>
              !inside(
                [
                  columnRects[col][0],
                  rows[bodyOwners[0]].rect[1],
                  columnRects[col][2],
                  rows[bodyOwners[0]].rect[3]
                ],
                ink(r).map((n) => n * s)
              )
          )
        )
      ) {
        complete = false
        break
      }
    }
    if (
      complete &&
      !body.some((r) =>
        over(
          ink(r).map((n) => n * s),
          band
        )
      )
    )
      candidates.push(row)
  }
  return candidates.length === 1 ? candidates : undefined
}

// Source-only span evidence: never replaces rows, body cells, crops or claims.
export function proveNativeFencedSectionRows(input) {
  try {
    return prove(input)
  } catch {
    return undefined
  }
}

function proveTerminal(input) {
  const { table, items, rows, columnRects, cells, unassigned, captions } = input
  if (
    !Array.isArray(cells) ||
    !Array.isArray(unassigned) ||
    unassigned.length !== 1 ||
    !Array.isArray(captions)
  )
    return
  const e = nativeSectionEvidence(input, true)
  if (!e) return
  const { p, s, inventory, glyphs, ink, records, bound, paints, groups, color } = e
  const strictInside = (a, b) => b.every((n, i) => (i < 2 ? n >= a[i] : n <= a[i]))
  const candidates = []
  for (const group of groups.filter((g) => g.length === 4)) {
    const fences = group.slice().sort((a, b) => a.rule[1] - b.rule[1])
    const frame = [fences[0].rule[0], fences[0].rule[1], fences[0].rule[2], fences.at(-1).rule[1]]
    if (
      !valid(frame) ||
      fences.some((f) => f.rule[0] !== frame[0] || f.rule[2] !== frame[2]) ||
      fences.some((f, i) => i && f.rule[1] === fences[i - 1].rule[1]) ||
      !columnRects.every((col) => {
        const x = (col[0] + col[2]) / 2 / s
        return x > frame[0] && x < frame[2]
      }) ||
      !items.every((item) =>
        strictInside(
          frame,
          item.rect.map((n) => n / s)
        )
      ) ||
      paints.some((q) => over(q.box, frame) && (!q.opaque || !fences.includes(q))) ||
      inventory.evidence.images.some((i) => !valid(i.rect) || over(i.rect, frame))
    )
      continue
    const active = inventory.records.filter((r) => valid(ink(r)) && over(ink(r), frame))
    if (
      active.length !== items.length ||
      active.some(
        (r) =>
          !bound.has(r.index) ||
          r.advanceComplete !== true ||
          r.foreignSourceNormalized ||
          !strictInside(frame, ink(r)) ||
          r.part.some((z) =>
            /\s/u.test(z.c)
              ? valid(z.g.ink)
              : !valid(z.g.ink) ||
                color.texts.get(z.g.i)?.toLowerCase() === '#ffffff' ||
                inventory.records.filter((q) => q.part.some((p) => p.g === z.g)).length !== 1
          )
      ) ||
      inventory.glyphs.some(
        (g) => valid(g.ink) && over(g.ink, frame) && !active.some((r) => glyphs(r).includes(g))
      )
    )
      continue
    const labelItems = items.filter((i) => unassigned.includes(i.text))
    if (labelItems.length !== 1) continue
    const item = labelItems[0],
      heading = records.get(item.sourceItem.index),
      h = item.height
    if (
      !/^\p{L}[\p{L}\p{M}\s]+$/u.test(item.text) ||
      item.text.length < 12 ||
      !captions.filter(
        (q) =>
          /^Table\s+[\p{N}IVX]+[.:]/u.test(q.lines?.[0] ?? '') &&
          valid(q.rect) &&
          q.rect[3] <= table.cropRect[1] &&
          table.cropRect[1] - q.rect[3] <= h * 2 &&
          Math.min(q.rect[2], frame[2] * s) - Math.max(q.rect[0], frame[0] * s) >=
            (frame[2] - frame[0]) * s * 0.8
      ).length
    )
      continue
    const upper = fences.at(-2),
      lower = fences.at(-1),
      band = [upper.rule[0], upper.ink[3], lower.rule[2], lower.ink[1]]
    if (!valid(band) || !strictInside(band, heading.rect) || !strictInside(band, ink(heading)))
      continue
    const peers = cells.filter(
      (cell) => cell.column === 0 && cell.colSpan === columnRects.length && cell.rowSpan === 1
    )
    if (
      peers.length !== 2 ||
      peers.some(
        (cell) =>
          cell.sourceItems?.length !== 1 ||
          cell.sourceTokens?.length !== 1 ||
          cell.sourceRects?.length !== 1 ||
          cell.sourceItems[0].pageNumber !== p.pageNumber
      )
    )
      continue
    const peerRecords = peers.map((cell) => records.get(cell.sourceItems[0].index))
    if (
      peerRecords.some(
        (r, i) =>
          !r ||
          peers[i].text !== r.r.str ||
          !bound.has(r.index) ||
          r.r.fontName !== heading.r.fontName ||
          r.r.height !== heading.r.height ||
          !equal(r.r.transform.slice(0, 4), heading.r.transform.slice(0, 4)) ||
          !near(r.rect[0], heading.rect[0]) ||
          r.rect[3] >= band[1] ||
          !equal(peers[i].sourceRects[0], bound.get(r.index).rect)
      )
    )
      continue
    const block = active.filter((r) => over(ink(r), band))
    if (
      block.length !== columnRects.length + 1 ||
      block.some((r) => !strictInside(band, r.rect) || !strictInside(band, ink(r)))
    )
      continue
    const body = block.filter((r) => r !== heading),
      last = rows.length - 1,
      row = rows[last]
    if (
      body.length !== columnRects.length ||
      body.some(
        (r) =>
          r.rect[1] <= heading.rect[3] ||
          !near(r.rect[3], body[0].rect[3]) ||
          r.r.fontName === heading.r.fontName
      ) ||
      item.rect[1] <= rows[last - 1].rect[3] ||
      item.rect[3] >= row.rect[1] ||
      peers.some((cell) => cell.row >= last) ||
      cells.some((cell) => cell.rowSpan !== 1)
    )
      continue
    const rowCells = cells.filter((cell) => cell.row === last).sort((a, b) => a.column - b.column)
    if (
      rowCells.length !== columnRects.length ||
      rowCells.some(
        (cell, col) =>
          cell.column !== col ||
          cell.colSpan !== 1 ||
          cell.sourceItems?.length !== 1 ||
          cell.sourceRects?.length !== 1 ||
          cell.sourceTokens?.length !== 1
      )
    )
      continue
    const data = rowCells.map((cell) => records.get(cell.sourceItems[0].index))
    if (
      new Set(data).size !== body.length ||
      data.some(
        (r, col) =>
          !r ||
          !body.includes(r) ||
          rowCells[col].sourceItems[0].pageNumber !== p.pageNumber ||
          rowCells[col].text !== r.r.str ||
          !equal(rowCells[col].sourceRects[0], bound.get(r.index).rect) ||
          !strictInside(
            [columnRects[col][0], row.rect[1], columnRects[col][2], row.rect[3]],
            r.rect.map((n) => n * s)
          ) ||
          (col > 1 && !/^[<>≤≥−+-]?(?:\d|\.\d)[\d.,%°()±–−+\-/]*$/u.test(r.r.str))
      )
    )
      continue
    const claims = cells.flatMap((cell) => cell.sourceItems ?? [])
    if (
      new Set(claims.map((q) => q.index)).size !== claims.length ||
      claims.length + 1 !== active.length ||
      claims.some((q) => q.pageNumber !== p.pageNumber || records.get(q.index)?.r.str !== q.text) ||
      active.some((r) => r !== heading && !claims.some((q) => q.index === r.index))
    )
      continue
    candidates.push({
      item,
      insertAt: last,
      rect: [columnRects[0][0], item.rect[1], columnRects.at(-1)[2], item.rect[3]]
    })
  }
  return candidates.length === 1 ? candidates[0] : undefined
}

// A terminal whole section Source is separate from the existing multi-record family.
export function proveNativeTerminalFencedSection(input) {
  try {
    return proveTerminal(input)
  } catch {
    return undefined
  }
}
