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

function prove({ table, items, rows, columnRects, spans, rules, context }) {
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
  const inventory = nativePageTextPacketInventory(p, tokens, c, true)
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
