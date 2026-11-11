import type { PDFPageProxy } from 'pdfjs-dist'
import {
  nativeAlgorithmInkRegions,
  nativeLabelRegion,
  nativeOutlineBox as outlineBox
} from './native-source-geometry.js'
import type { PdfTranslationLayout } from './layout.js'
import { nativePaints } from './native-display-packets.js'

type Box = [number, number, number, number]
type Point = [number, number]
type Evidence = {
  index: number
  box: Box
  font: number
  text: string
  zero: boolean
  node: boolean
}
export type PdfMathDiagram = { page: number; box: Box; indexes: number[]; incomplete?: boolean }
const union = (boxes: Box[]): Box => [
  Math.min(...boxes.map((b) => b[0])),
  Math.min(...boxes.map((b) => b[1])),
  Math.max(...boxes.map((b) => b[2])),
  Math.max(...boxes.map((b) => b[3]))
]
const overlaps = (a: Box, b: Box): boolean =>
  a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]
const inside = (a: Box, b: Box): boolean =>
  a[0] >= b[0] && a[1] >= b[1] && a[2] <= b[2] && a[3] <= b[3]
const distance = (p: Point, b: Box): number =>
  Math.hypot(Math.max(b[0] - p[0], 0, p[0] - b[2]), Math.max(b[1] - p[1], 0, p[1] - b[3]))
const nearMiddle = (box: Box, a: Point, b: Point, font: number): boolean => {
  const x = (box[0] + box[2]) / 2,
    y = (box[1] + box[3]) / 2,
    dx = b[0] - a[0],
    dy = b[1] - a[1],
    length = dx * dx + dy * dy
  if (!length) return false
  const t = ((x - a[0]) * dx + (y - a[1]) * dy) / length
  return t > 0.15 && t < 0.85 && distance([a[0] + t * dx, a[1] + t * dy], box) <= font * 0.8
}
const axis = (m: number[]): boolean =>
  m.length === 6 && m.every(Number.isFinite) && m[0] !== 0 && m[3] !== 0 && m[1] === 0 && m[2] === 0
const matrix = (m: number[]): boolean =>
  m.length === 6 && m.every(Number.isFinite) && m[0] * m[3] - m[1] * m[2] !== 0
const point = (p: Point, m: number[]): Point => [
  p[0] * m[0] + p[1] * m[2] + m[4],
  p[0] * m[1] + p[1] * m[3] + m[5]
]
const transformBox = (b: Box, m: number[]): Box =>
  union(
    [
      [b[0], b[1]],
      [b[2], b[1]],
      [b[2], b[3]],
      [b[0], b[3]]
    ].map((p) => {
      const [x, y] = point(p as Point, m)
      return [x, y, x, y]
    })
  )

type Paint = NonNullable<Awaited<ReturnType<typeof nativePaints>>>[number]
type HookedArrow = { a: Point; b: Point; paints: Paint[] }
const expand = (b: Box, p: number): Box => [b[0] - p, b[1] - p, b[2] + p, b[3] + p]
const samePoint = (a: Point, b: Point): boolean => Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.02

// A hooked arrow has three consecutive native paints: a thin shaft, two
// short Béziers beginning at its tail, and a dart whose notch meets its tip.
function nativeHookedArrow(
  shaft: Paint,
  hook: Paint,
  head: Paint,
  stroke: number,
  fill: number
): HookedArrow | undefined {
  if (
    shaft.kind !== stroke ||
    hook.kind !== stroke ||
    head.kind !== fill ||
    !shaft.plainBlack ||
    !hook.plainBlack ||
    !head.plainBlack ||
    shaft.strokeWidth > 0.8 ||
    hook.strokeWidth > 0.8 ||
    shaft.path.length !== 6 ||
    shaft.path[0] !== 0 ||
    shaft.path[3] !== 1 ||
    hook.path.length !== 20 ||
    hook.path[0] !== 0 ||
    hook.path[3] !== 1 ||
    hook.path[6] !== 2 ||
    hook.path[13] !== 2 ||
    hook.hull[2] - hook.hull[0] > 4 ||
    hook.hull[3] - hook.hull[1] > 4 ||
    head.path.length !== 12 ||
    head.path[0] !== 0 ||
    head.path[3] !== 1 ||
    head.path[6] !== 1 ||
    head.path[9] !== 1
  )
    return
  const at = ({ path, matrix }: Paint, offset: number): Point =>
    point([path[offset], path[offset + 1]], matrix)
  const a = at(shaft, 1),
    b = at(shaft, 4),
    dx = b[0] - a[0],
    dy = b[1] - a[1],
    length = Math.hypot(dx, dy)
  if (
    length < 8 ||
    !((dx > 0 && Math.abs(dy) < 0.02) || (dy > 0 && Math.abs(dx) < 0.02)) ||
    !samePoint(a, at(hook, 1)) ||
    !samePoint(b, at(head, 7))
  )
    return
  const local = (p: Point): Point => [
    ((p[0] - b[0]) * dx + (p[1] - b[1]) * dy) / length,
    ((p[1] - b[1]) * dx - (p[0] - b[0]) * dy) / length
  ]
  const [tip, upper, lower] = [1, 4, 10].map((offset) => local(at(head, offset)))
  if (
    tip[0] < 0.8 ||
    tip[0] > 3 ||
    Math.abs(tip[1]) > 0.02 ||
    upper[0] > -0.3 ||
    upper[0] < -2 ||
    Math.abs(upper[0] - lower[0]) > 0.02 ||
    upper[1] * lower[1] >= 0 ||
    Math.abs(upper[1] + lower[1]) > 0.02 ||
    Math.abs(upper[1]) < 0.5 ||
    Math.abs(upper[1]) > 2.5
  )
    return
  return { a, b, paints: [shaft, hook, head] }
}

function* orderedSquares(
  horizontal: HookedArrow[],
  vertical: HookedArrow[]
): Generator<[HookedArrow, HookedArrow, HookedArrow, HookedArrow]> {
  for (const top of horizontal)
    for (const bottom of horizontal) {
      if (top.a[1] >= bottom.a[1]) continue
      for (const left of vertical)
        for (const right of vertical) {
          if (left.a[0] < right.a[0]) yield [top, bottom, left, right]
        }
    }
}

async function readNativeFilledMathDiagrams(
  page: PDFPageProxy,
  pageNumber: number,
  content: Awaited<ReturnType<PDFPageProxy['getTextContent']>>
): Promise<PdfMathDiagram[]> {
  // Limit this family to compact symbolic squares with an explicit product or
  // union in a node. An ordinary filled workflow or a compound graph stays out.
  if (!content.items.some((item) => 'str' in item && /[×∪]/u.test(item.str))) return []
  try {
    const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs'),
      viewport = page.getViewport({ scale: 1 })
    if (
      content.items.length > 10000 ||
      viewport.rotation !== 0 ||
      JSON.stringify(viewport.transform) !== JSON.stringify([1, 0, 0, -1, 0, viewport.height])
    )
      return []
    const ops = await page.getOperatorList(),
      paints = await nativePaints(ops, viewport)
    if (!paints || paints.length > 256) return []
    const arrows = paints.slice(0, -2).flatMap((paint, index) => {
      const arrow = nativeHookedArrow(
        paint,
        paints[index + 1],
        paints[index + 2],
        OPS.stroke,
        OPS.fill
      )
      return arrow ? [arrow] : []
    })
    if (arrows.length < 4 || arrows.length > 24) return []
    const horizontal = arrows.filter(({ a, b }) => Math.abs(a[1] - b[1]) < 0.02),
      vertical = arrows.filter(({ a, b }) => Math.abs(a[0] - b[0]) < 0.02)
    const regionBox = (r: NonNullable<ReturnType<typeof nativeLabelRegion>>): Box => [
      r.x * viewport.width,
      r.y * viewport.height,
      (r.x + r.width) * viewport.width,
      (r.y + r.height) * viewport.height
    ]
    const runs = content.items.flatMap((item, index) => {
      if (!('str' in item) || !item.str.trim() || !axis(item.transform)) return []
      const region = nativeLabelRegion(item, content.styles[item.fontName], viewport, pageNumber)
      return region ? [{ index, text: item.str, font: item.height, box: regionBox(region) }] : []
    })
    const proofs: PdfMathDiagram[] = []
    for (const [top, bottom, left, right] of orderedSquares(horizontal, vertical)) {
      const x0 = left.a[0],
        y0 = top.a[1],
        x1 = right.a[0],
        y1 = bottom.a[1]
      if (
        !(x0 < x1 && y0 < y1) ||
        ![top, bottom].every((a) => x0 < a.a[0] && a.b[0] < x1) ||
        ![left, right].every((a) => y0 < a.a[1] && a.b[1] < y1)
      )
        continue
      const corners: Point[] = [
          [x0, y0],
          [x1, y0],
          [x0, y1],
          [x1, y1]
        ],
        fonts = corners.map((p) =>
          Math.max(
            0,
            ...runs
              .filter(
                (r) =>
                  /^\p{L}[\p{L}\p{N}×∪\s]{0,6}$/u.test(r.text.trim()) &&
                  distance(p, r.box) < r.font * 1.1 &&
                  r.box[1] <= p[1] &&
                  p[1] <= r.box[3]
              )
              .map((r) => r.font)
          )
        ),
        em = fonts[0]
      if (
        !em ||
        fonts.some((font) => Math.abs(font - em) > em * 0.05) ||
        x1 - x0 > em * 10 ||
        y1 - y0 > em * 8 ||
        ![top, bottom].every((a) => a.a[0] - x0 < em * 3 && x1 - a.b[0] < em * 3) ||
        ![left, right].every((a) => a.a[1] - y0 < em * 2 && y1 - a.b[1] < em * 2)
      )
        continue
      const edges = [top, bottom, left, right],
        fence: Box = [x0 - em * 2.5, y0 - em, x1 + em * 2.5, y1 + em],
        selected = runs.filter((r) => overlaps(r.box, fence)),
        node = (box: Box): boolean =>
          corners.some(([x, y]) => overlaps(box, [x - em * 2.5, y - em, x + em * 2.5, y + em]))
      if (
        selected.length < 5 ||
        selected.length > 24 ||
        !selected.some((r) => /[×∪]/u.test(r.text) && node(r.box)) ||
        !selected.some((r) => r.font < em * 0.85 && node(r.box)) ||
        selected.some(
          (r) =>
            !inside(r.box, fence) ||
            /\p{L}{5}|[\n\r]/u.test(r.text) ||
            r.text.length > 12 ||
            (!node(r.box) && !edges.some(({ a, b }) => nearMiddle(r.box, a, b, em)))
        )
      )
        continue
      const indexes = new Set(selected.map((r) => r.index))
      if (
        content.items
          .slice(selected[0].index, selected.at(-1)!.index + 1)
          .some(
            (item, n) => 'str' in item && item.str.trim() && !indexes.has(selected[0].index + n)
          )
      )
        continue
      const ink = await nativeAlgorithmInkRegions(page, content, viewport, pageNumber, indexes, ops)
      if (!ink) continue
      const ownedPaint = new Set(edges.flatMap((a) => a.paints)),
        box = union(
          [...ownedPaint]
            .map((paint) => paint.bounds)
            .concat(selected.map((r) => regionBox(ink.get(r.index)!)))
        ),
        moat = expand(box, em * 0.25)
      if (
        !inside(box, fence) ||
        !inside(moat, [0, 0, viewport.width, viewport.height]) ||
        // A foreign square cap can project beyond its stroke radius.
        paints.some(
          (paint) =>
            !ownedPaint.has(paint) && overlaps(expand(paint.bounds, paint.strokeWidth / 2), fence)
        ) ||
        [...ink].some(([i, r]) => !indexes.has(i) && overlaps(regionBox(r), moat)) ||
        arrows.some(
          (arrow) =>
            !ownedPaint.has(arrow.paints[0]) &&
            corners.some(
              (corner) =>
                Math.min(
                  Math.hypot(corner[0] - arrow.a[0], corner[1] - arrow.a[1]),
                  Math.hypot(corner[0] - arrow.b[0], corner[1] - arrow.b[1])
                ) <
                em * 1.5
            )
        )
      )
        continue
      proofs.push({ page: pageNumber, box, indexes: [...indexes] })
    }
    return proofs.filter(
      (proof, i) => !proofs.some((peer, j) => i !== j && overlaps(proof.box, peer.box))
    )
  } catch {
    return []
  }
}

export async function readPdfMathDiagrams(
  page: PDFPageProxy,
  pageNumber: number,
  content: Awaited<ReturnType<PDFPageProxy['getTextContent']>>
): Promise<PdfMathDiagram[]> {
  const legacy = await readNativeGlyphMathDiagrams(page, pageNumber, content)
  return legacy.length ? legacy : readNativeFilledMathDiagrams(page, pageNumber, content)
}

/** Optional proof for a narrow class of typeset, arrow-connected mathematical displays.
 * It never infers arrow direction or Unicode from appearance. Unproved pages keep the old layout.
 */
async function readNativeGlyphMathDiagrams(
  page: PDFPageProxy,
  pageNumber: number,
  content: Awaited<ReturnType<PDFPageProxy['getTextContent']>>
): Promise<PdfMathDiagram[]> {
  if (
    !page.commonObjs ||
    typeof page.getOperatorList !== 'function' ||
    content.items.filter((i) => 'str' in i && i.str.trim() && i.width === 0).length < 3
  )
    return []
  try {
    const { OPS, Util } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const viewport = page.getViewport({ scale: 1 }),
      vm = viewport.transform
    if (!axis(vm)) return []
    const operators = await page.getOperatorList()
    if (
      operators.fnArray.length !== operators.argsArray.length ||
      operators.fnArray.length > 100000
    )
      return []
    const inert = new Set([
      OPS.beginText,
      OPS.endText,
      OPS.moveText,
      OPS.setTextMatrix,
      OPS.setLeading,
      OPS.setCharSpacing,
      OPS.setWordSpacing,
      OPS.setHScale,
      OPS.setTextRise,
      OPS.dependency,
      OPS.setFillRGBColor,
      OPS.setStrokeRGBColor,
      OPS.setFillGray,
      OPS.setStrokeGray,
      OPS.setFillCMYKColor,
      OPS.setStrokeCMYKColor,
      OPS.setLineCap,
      OPS.setLineJoin,
      OPS.setMiterLimit
    ])
    let state = { matrix: [1, 0, 0, 1, 0, 0], width: 1, font: '', dashed: false }
    const stack: (typeof state)[] = [],
      glyphs = new Map<string, Set<string>>()
    const paths: { a: Point; b: Point; box: Box; eligible: boolean }[] = [],
      guards: Box[] = []
    let formDepth = 0
    for (let i = 0; i < operators.fnArray.length; i++) {
      const op = operators.fnArray[i],
        args = operators.argsArray[i] ?? []
      if (op === OPS.paintFormXObjectBegin) {
        if (!formDepth) {
          const bounds = Array.from(args[1] ?? []) as number[],
            m = Util.transform(vm, Util.transform(state.matrix, args[0] ?? [1, 0, 0, 1, 0, 0]))
          if (bounds.length !== 4 || !bounds.every(Number.isFinite) || !matrix(m)) return []
          guards.push(transformBox(bounds as Box, m))
        }
        formDepth++
        continue
      }
      if (op === OPS.paintFormXObjectEnd) {
        if (!formDepth) return []
        formDepth--
        continue
      }
      if (formDepth) continue
      if (op === OPS.save) stack.push({ ...state, matrix: [...state.matrix] })
      else if (op === OPS.restore) {
        const old = stack.pop()
        if (!old) return []
        state = old
      } else if (op === OPS.transform) {
        state.matrix = Util.transform(state.matrix, args)
        if (!matrix(state.matrix)) return []
      } else if (op === OPS.setLineWidth) {
        state.width = args[0]
        if (!Number.isFinite(state.width) || state.width <= 0) return []
      } else if (op === OPS.setDash) state.dashed = args[0]?.length !== 0
      else if (op === OPS.setFont) state.font = args[0]
      else if (op === OPS.showText) {
        for (const g of args[0] ?? [])
          if (
            g &&
            typeof g === 'object' &&
            g.width === 0 &&
            g.isInFont === true &&
            !g.accent &&
            typeof g.unicode === 'string' &&
            typeof g.fontChar === 'string'
          ) {
            const key = state.font + '\0' + g.unicode
            if (!glyphs.has(key)) glyphs.set(key, new Set())
            glyphs.get(key)!.add(g.fontChar)
          }
      } else if (op === OPS.constructPath) {
        // Only thin straight strokes can prove connectors. Other graphics fail closed.
        const data = args[1]?.[0],
          m = Util.transform(vm, state.matrix)
        if (
          args[0] !== OPS.stroke ||
          args[1]?.length !== 1 ||
          data?.length !== 6 ||
          data[0] !== 0 ||
          data[3] !== 1 ||
          state.width * Math.hypot(m[0], m[1], m[2], m[3]) > 1.5
        )
          return []
        const a = point([data[1], data[2]], m),
          b = point([data[4], data[5]], m)
        if (![...a, ...b].every(Number.isFinite)) return []
        const pad = (state.width * Math.hypot(m[0], m[1], m[2], m[3])) / 2
        paths.push({
          a,
          b,
          eligible: !state.dashed,
          box: [
            Math.min(a[0], b[0]) - pad,
            Math.min(a[1], b[1]) - pad,
            Math.max(a[0], b[0]) + pad,
            Math.max(a[1], b[1]) + pad
          ]
        })
      } else if (!inert.has(op)) return []
    }
    if (stack.length || formDepth || paths.length < 3) return []
    const evidence: Evidence[] = []
    for (const [index, item] of content.items.entries()) {
      if (!('str' in item) || !item.str.trim()) continue
      const m = Util.transform(vm, item.transform),
        font = Math.hypot(m[2], m[3])
      if (
        !matrix(m) ||
        item.dir !== 'ltr' ||
        !Number.isFinite(item.width) ||
        item.width < 0 ||
        font <= 0
      )
        return []
      let box: Box | undefined
      if (item.width === 0) {
        const chars = glyphs.get(item.fontName + '\0' + item.str)
        if (chars?.size !== 1 || !page.commonObjs.has(item.fontName)) return []
        const f = page.commonObjs.get(item.fontName),
          key = f.loadedName + '_path_' + [...chars][0]
        if (f.missingFile || f.vertical || f.isType3Font || !page.commonObjs.has(key)) return []
        const bounds = outlineBox(page.commonObjs.get(key)?.path)
        if (!bounds) return []
        box = transformBox(bounds, m)
      } else {
        const style = content.styles?.[item.fontName],
          ascent = style?.ascent || (style?.descent ? 1 + style.descent : 0.8)
        box = transformBox(
          [0, ascent - 1, item.width / Math.hypot(item.transform[0], item.transform[1]), ascent],
          m
        )
      }
      evidence.push({
        index,
        box,
        font,
        text: item.str,
        zero: item.width === 0,
        node: axis(m) && m[0] > 0 && m[3] < 0
      })
    }
    const tips = evidence.filter((e) => e.zero),
      letters = evidence.filter((e) => !e.zero && e.node)
    const groups: Evidence[][] = []
    for (const item of letters) {
      const matching = groups.filter((g) => {
        const t = { box: union(g.map((i) => i.box)), font: Math.max(...g.map((i) => i.font)) }
        const gap = Math.max(t.box[0] - item.box[2], item.box[0] - t.box[2], 0)
        return (
          gap <= Math.min(t.font, item.font) * 0.35 &&
          t.box[1] < item.box[3] &&
          item.box[1] < t.box[3]
        )
      })
      if (!matching.length) groups.push([item])
      else {
        const first = matching[0]
        first.push(item)
        for (const other of matching.slice(1)) {
          first.push(...other)
          groups.splice(groups.indexOf(other), 1)
        }
      }
    }
    const nodes = groups.map((items) => ({
      items,
      box: union(items.map((i) => i.box)),
      font: Math.max(...items.map((i) => i.font))
    }))
    const edges: { path: number; a: number; b: number; tips: Evidence[] }[] = []
    for (const [index, p] of paths.entries()) {
      if (!p.eligible) continue
      const owned = tips.filter(
        (t) => distance(p.a, t.box) <= t.font * 0.2 || distance(p.b, t.box) <= t.font * 0.2
      )
      if (!owned.length) continue
      const ends = [p.a, p.b].map((end) =>
        nodes
          .map((n, i) => ({ i, d: distance(end, n.box), font: n.font }))
          .filter((x) => x.d <= x.font * 0.9)
          .sort((a, b) => a.d - b.d)
      )
      if (ends.some((e) => !e.length || (e[1] && e[1].d - e[0].d < 1))) continue
      const a = ends[0][0].i,
        b = ends[1][0].i
      if (a !== b) edges.push({ path: index, a, b, tips: owned })
    }
    const seen = new Set<number>(),
      proofs: PdfMathDiagram[] = []
    for (const start of edges.flatMap((e) => [e.a, e.b])) {
      if (seen.has(start)) continue
      const component = new Set<number>(),
        queue = [start]
      while (queue.length) {
        const i = queue.pop()!
        if (component.has(i)) continue
        component.add(i)
        seen.add(i)
        for (const e of edges) {
          if (e.a === i) queue.push(e.b)
          if (e.b === i) queue.push(e.a)
        }
      }
      const links = edges.filter((e) => component.has(e.a) && component.has(e.b))
      if (
        component.size < 3 ||
        links.length < 3 ||
        !links.some((e) =>
          links.some((f) => {
            const a = paths[e.path],
              b = paths[f.path]
            return (
              Math.abs(
                (a.b[0] - a.a[0]) * (b.b[1] - b.a[1]) - (a.b[1] - a.a[1]) * (b.b[0] - b.a[0])
              ) > 1
            )
          })
        )
      )
        continue
      const selected = [...component].flatMap((i) => nodes[i].items),
        arrowItems = [...new Set(links.flatMap((e) => e.tips))]
      // Script typography corroborates mathematical content; paths/arrow outlines,
      // never spelling alone, establish the connected display and its boundary.
      if (
        [...component].filter((i) => nodes[i].items.some((t) => t.font < nodes[i].font * 0.85))
          .length < 2 ||
        selected.some((i) => /\p{L}{5}/u.test(i.text))
      )
        continue
      const nodeFont = Math.min(...[...component].map((i) => nodes[i].font))
      for (const [i, node] of nodes.entries()) {
        if (
          component.has(i) ||
          node.font > nodeFont * 0.85 ||
          node.items.some((t) => /\p{L}{5}/u.test(t.text))
        )
          continue
        if (links.some((e) => nearMiddle(node.box, paths[e.path].a, paths[e.path].b, node.font)))
          selected.push(...node.items)
      }
      const box = union(
        [...selected, ...arrowItems].map((i) => i.box).concat(links.map((e) => paths[e.path].box))
      )
      if (guards.some((g) => overlaps(g, box))) continue
      const partial: PdfMathDiagram = {
        page: pageNumber,
        box,
        indexes: [...new Set([...selected, ...arrowItems].map((i) => i.index))].sort(
          (a, b) => a - b
        ),
        incomplete: true
      }
      proofs.push(partial)
      const enclosed = evidence.filter((i) => overlaps(i.box, box))
      if (
        enclosed.some(
          (i) => !inside(i.box, box) || (!selected.includes(i) && !arrowItems.includes(i))
        )
      )
        continue
      // A terminal arrow may start just outside the text envelope. Apply the
      // same endpoint-to-node tolerance used to build edges before claiming
      // completeness; an unowned outward connector keeps the graph partial.
      if (
        paths.some(
          (p, i) =>
            !links.some((e) => e.path === i) &&
            (overlaps(p.box, box) ||
              [...component].some((n) =>
                [p.a, p.b].some((end) => distance(end, nodes[n].box) <= nodes[n].font * 0.9)
              ))
        )
      )
        continue
      if (!inside(box, [0, 0, viewport.width, viewport.height])) continue
      const padding = Math.min(...selected.map((i) => i.font)) * 0.3,
        moat: Box = [box[0] - padding, box[1] - padding, box[2] + padding, box[3] + padding]
      if (evidence.some((i) => !enclosed.includes(i) && overlaps(i.box, moat))) continue
      partial.incomplete = false
    }
    return proofs.filter((p, i) => !proofs.some((q, j) => i !== j && overlaps(p.box, q.box)))
  } catch {
    return []
  }
}

/** Replace only complete existing owners; a mixed prose unit invalidates the proposal. */
export function preservePdfMathDiagrams(
  layout: PdfTranslationLayout,
  proofs: PdfMathDiagram[]
): PdfTranslationLayout {
  for (const proof of proofs) {
    const wanted = new Set(proof.indexes.map((i) => `${proof.page}:${i}`))
    const owned = layout.units.filter((u) => u.items.some((i) => wanted.has(i)))
    const warn = (): void => {
      for (const u of owned)
        if (!u.risks.includes('formula-extraction')) u.risks.push('formula-extraction')
    }
    if (proof.incomplete) {
      warn()
      continue
    }
    if (!owned.length || owned.some((u) => u.items.some((i) => !wanted.has(i)))) {
      warn()
      continue
    }
    const actual = owned.flatMap((u) => u.items)
    if (actual.length !== wanted.size || new Set(actual).size !== wanted.size) {
      warn()
      continue
    }
    const first = layout.units.indexOf(owned[0]),
      id = `math-diagram:p${proof.page}:i${proof.indexes[0]}`
    const originals = new Map(
      owned.flatMap((u) => u.items.map((key, i) => [key, u.originalStrings[i]] as const))
    )
    const items = [...wanted],
      originalStrings = items.map((i) => originals.get(i)!),
      source = owned.map((u) => u.source).join(' ')
    const rect = {
      x: proof.box[0],
      y: proof.box[1],
      right: proof.box[2],
      bottom: proof.box[3],
      font: Math.max(...owned.flatMap((u) => u.fragments.map((f) => f.rect.font)))
    }
    const risks = [...new Set(owned.flatMap((u) => u.risks))]
    const ids = new Set(owned.flatMap((u) => u.fragments.map((f) => f.id)))
    if (layout.joins.some((j) => ids.has(j.from) || ids.has(j.to))) {
      warn()
      continue
    }
    const page = layout.pages[proof.page - 1]
    page.blocks = page.blocks.filter((b) => !ids.has(b.id))
    page.blocks.push({
      id,
      page: proof.page,
      source,
      sourceOnly: true,
      items,
      originalStrings,
      rect,
      lines: [{ ...rect, text: source, items }],
      risks
    })
    layout.units = layout.units.filter((u) => !owned.includes(u))
    layout.units.splice(first, 0, {
      id,
      kind: 'other',
      source,
      sourceOnly: true,
      items,
      originalStrings,
      fragments: [{ id, page: proof.page, rect }],
      risks
    })
  }
  return layout
}
