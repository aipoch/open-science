import type { PDFPageProxy } from 'pdfjs-dist'
import type { PdfTranslationSource } from './source.js'
import type { AuxiliaryNativeInkReader } from './auxiliary-native-ink.js'
import { nativeInkPageIdentity } from './auxiliary-native-ink.js'
import { nativeReferenceFontWitnesses } from './native-reference-evidence.js'
import { nativeTextFreeClipInkRegions } from './native-source-geometry.js'

type Content = Awaited<ReturnType<PDFPageProxy['getTextContent']>>
type Viewport = ReturnType<PDFPageProxy['getViewport']>
type Unit = PdfTranslationSource['units'][number]
type Item = Extract<Content['items'][number], { str: string }>
type Entry = { item: Item; index: number; owner: Unit }
type Box = [number, number, number, number]
type Paint = {
  operator: number
  bounds: Box
  hull: Box
  horizontalRule: boolean
}

const union = (boxes: Box[]): Box => [
  Math.min(...boxes.map((b) => b[0])),
  Math.min(...boxes.map((b) => b[1])),
  Math.max(...boxes.map((b) => b[2])),
  Math.max(...boxes.map((b) => b[3]))
]
const overlaps = (a: Box, b: Box, pad = 0): boolean =>
  a[0] - pad < b[2] && a[2] + pad > b[0] && a[1] - pad < b[3] && a[3] + pad > b[1]

/** Cheap marker gate only; it grants no native evidence or eligibility. */
export function hasNativeDisplaySequence(content: Content): boolean {
  const numbers = new Set(
    content.items.flatMap((i): number[] =>
      'str' in i && /^\([1-9]\d{0,3}\)$/u.test(i.str) ? [Number(i.str.slice(1, -1))] : []
    )
  )
  return [...numbers].some((n) => numbers.has(n + 1))
}

/** Every path is bounded by its actual control hull and a conservative stroke
 * expansion. Clipping never shrinks this envelope. No image, form, transparency,
 * or unknown paint operation is admitted by this display-only branch. */
async function nativePaints(
  ops: Awaited<ReturnType<PDFPageProxy['getOperatorList']>>,
  viewport: Viewport
): Promise<Paint[] | undefined> {
  const { OPS, Util } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  if (ops.fnArray.length !== ops.argsArray.length || ops.fnArray.length > 100000) return
  type State = {
    matrix: number[]
    width: number
    cap: number
    join: number
    miter: number
    dash: number[]
    stroke: string
    clip: number
  }
  let state: State = {
      matrix: [1, 0, 0, 1, 0, 0],
      width: 1,
      cap: 0,
      join: 0,
      miter: 10,
      dash: [],
      stroke: '#000000',
      clip: 0
    },
    pendingClip = false,
    controls = 0
  const stack: State[] = [],
    result: Paint[] = [],
    finite = (v: unknown, length?: number): v is number[] =>
      (Array.isArray(v) || ArrayBuffer.isView(v)) &&
      (length === undefined || (v as number[]).length === length) &&
      Array.from(v as number[]).every(Number.isFinite),
    text = new Set([
      OPS.beginText,
      OPS.endText,
      OPS.setFont,
      OPS.moveText,
      OPS.setTextMatrix,
      OPS.showText,
      OPS.setTextRenderingMode,
      OPS.dependency
    ]),
    strokeModes = new Set([
      OPS.stroke,
      OPS.closeStroke,
      OPS.fillStroke,
      OPS.eoFillStroke,
      OPS.closeFillStroke,
      OPS.closeEOFillStroke
    ]),
    fillModes = new Set([
      OPS.fill,
      OPS.eoFill,
      OPS.fillStroke,
      OPS.eoFillStroke,
      OPS.closeFillStroke,
      OPS.closeEOFillStroke
    ])
  for (let index = 0; index < ops.fnArray.length; index++) {
    const op = ops.fnArray[index],
      a = ops.argsArray[index]
    if (op === OPS.save) stack.push({ ...state, matrix: [...state.matrix], dash: [...state.dash] })
    else if (op === OPS.restore) {
      if (!stack.length || pendingClip) return
      state = stack.pop()!
    } else if (op === OPS.transform) {
      if (!finite(a, 6)) return
      state.matrix = Util.transform(state.matrix, a)
      if (
        !finite(state.matrix, 6) ||
        state.matrix[0] * state.matrix[3] === state.matrix[1] * state.matrix[2]
      )
        return
    } else if (op === OPS.setLineWidth) {
      if (!Number.isFinite(a?.[0]) || a[0] <= 0) return
      state.width = a[0]
    } else if (op === OPS.setLineCap || op === OPS.setLineJoin) {
      if (![0, 1, 2].includes(a?.[0])) return
      state[op === OPS.setLineCap ? 'cap' : 'join'] = a[0]
    } else if (op === OPS.setMiterLimit) {
      if (!Number.isFinite(a?.[0]) || a[0] < 1) return
      state.miter = a[0]
    } else if (op === OPS.setDash) {
      if (!finite(a?.[0]) || a[0].some((v: number) => v < 0) || !Number.isFinite(a[1])) return
      state.dash = Array.from(a[0])
    } else if (op === OPS.setStrokeRGBColor || op === OPS.setFillRGBColor) {
      if (typeof a?.[0] !== 'string' || !/^#[0-9a-f]{6}$/u.test(a[0])) return
      if (op === OPS.setStrokeRGBColor) state.stroke = a[0]
    } else if (op === OPS.clip || op === OPS.eoClip) {
      if (pendingClip || !stack.length) return
      pendingClip = true
    } else if (op === OPS.constructPath) {
      if (a?.[0] === OPS.endPath && a?.[1]?.length === 1 && a[1][0] === null && a[2] === null) {
        if (pendingClip) return
        continue
      }
      if (a?.[1]?.length !== 1 || !finite(a[1][0]) || a[1][0].length > 10000) return
      const data = Array.from(a[1][0]) as number[],
        points: Box[] = [],
        matrix = Util.transform(viewport.transform, state.matrix)
      for (let at = 0; at < data.length;) {
        const command = data[at++],
          count =
            command === 0 || command === 1
              ? 2
              : command === 2
                ? 6
                : command === 3
                  ? 4
                  : command === 4
                    ? 0
                    : -1
        if (count < 0 || at + count > data.length || (command !== 0 && !points.length)) return
        for (const end = at + count; at < end; at += 2) {
          const p = [data[at], data[at + 1]]
          Util.applyTransform(p, matrix)
          if (!p.every(Number.isFinite) || ++controls > 100000) return
          points.push([p[0], p[1], p[0], p[1]])
        }
      }
      if (!points.length) return
      const hull = union(points),
        stroke = strokeModes.has(a[0]),
        fill = fillModes.has(a[0])
      if (!stroke && !fill && a[0] !== OPS.endPath) return
      // The Frobenius norm bounds every transformed stroke direction. Full
      // miter expansion plus one point is deliberately conservative; it is not
      // a crop, a pixel-equivalence claim, or inferred visible ink.
      const pad = stroke
        ? (Math.hypot(...state.matrix.slice(0, 4)) *
            state.width *
            Math.max(1, state.join === 0 ? state.miter : 1)) /
            2 +
          1
        : 0
      if (!Number.isFinite(pad)) return
      if (stroke || fill)
        result.push({
          operator: index,
          hull,
          bounds: [hull[0] - pad, hull[1] - pad, hull[2] + pad, hull[3] + pad],
          horizontalRule:
            a[0] === OPS.stroke &&
            data.length === 6 &&
            data[0] === 0 &&
            data[3] === 1 &&
            hull[1] === hull[3] &&
            state.stroke === '#000000' &&
            state.cap === 0 &&
            !state.dash.length &&
            state.clip === 0
        })
      if (pendingClip) {
        if (a[0] !== OPS.endPath) return
        pendingClip = false
        state.clip++
      }
    } else if (!text.has(op)) return
  }
  return !pendingClip && !state.clip && !stack.length ? result : undefined
}

/** Returns only complete existing owner IDs, never inferred text or geometry. */
export async function nativeScopedDisplayOwners(
  units: readonly Unit[],
  page: PDFPageProxy,
  content: Content,
  viewport: Viewport,
  pageNumber: number,
  auxiliary: AuxiliaryNativeInkReader
): Promise<ReadonlySet<string>> {
  const empty = new Set<string>()
  try {
    const inputContent = content,
      inputViewport = viewport,
      inputUnits = units,
      sourceKey = JSON.stringify(units),
      operatorReader = page.getOperatorList,
      objects = page.commonObjs,
      objectReader = objects.get,
      objectHas = objects.has,
      unitSnapshot = structuredClone(units)
    if (
      viewport.scale !== 1 ||
      viewport.rotation !== 0 ||
      JSON.stringify(viewport.transform) !== JSON.stringify([1, 0, 0, -1, 0, viewport.height]) ||
      !hasNativeDisplaySequence(content) ||
      !nativeReferenceFontWitnesses(page, content)
    )
      return empty
    const identity = await nativeInkPageIdentity(page, content, viewport)
    if (!identity) return empty
    content = identity.content
    viewport = identity.viewport
    units = unitSnapshot
    const owners = new Map<number, Unit>(),
      counts = new Map<number, number>(),
      sourceTexts = new Map<number, string>()
    for (const unit of units)
      for (const fragment of unit.fragments)
        if (fragment.pageNumber === pageNumber)
          for (const item of fragment.items) {
            owners.set(item.index, unit)
            counts.set(item.index, (counts.get(item.index) ?? 0) + 1)
            sourceTexts.set(item.index, item.text)
          }
    const entries: Entry[] = content.items.flatMap((item, index): Entry[] =>
      'str' in item && item.str.trim() ? [{ item, index, owner: owners.get(index)! }] : []
    )
    if (
      entries.some(
        (e) => !e.owner || counts.get(e.index) !== 1 || sourceTexts.get(e.index) !== e.item.str
      )
    )
      return empty
    const box = (e: Entry): Box => {
        const i = e.item,
          style = content.styles[i.fontName]
        return [
          i.transform[4],
          viewport.height - i.transform[5] - style.ascent * i.height,
          i.transform[4] + i.width,
          viewport.height - i.transform[5] - style.descent * i.height
        ]
      },
      anchors = entries.filter(
        (e) =>
          /^\([1-9]\d{0,3}\)$/u.test(e.item.str) &&
          e.owner.sourceOnly &&
          e.owner.preserve === 'formula' &&
          e.owner.fragments.length === 1 &&
          e.owner.fragments[0].items.length === 1
      ),
      packets: { entries: Entry[]; owners: Unit[]; anchor: Entry }[] = []
    for (const anchor of anchors) {
      const h = anchor.item.height,
        y = anchor.item.transform[5],
        x = anchor.item.transform[4],
        number = Number(anchor.item.str.slice(1, -1))
      if (
        !anchors.some(
          (e) =>
            Math.abs(Number(e.item.str.slice(1, -1)) - number) === 1 &&
            Math.abs(e.item.transform[4] - x) < h * 0.05 &&
            Math.abs(e.item.transform[5] - y) > h * 1.6 &&
            Math.abs(e.item.transform[5] - y) < h * 20
        )
      )
        continue
      let first = entries.indexOf(anchor)
      while (first > 0) {
        const i = entries[first - 1].item
        if (
          Math.abs(i.transform[5] - y) > h * 1.55 ||
          i.transform[4] >= x ||
          i.height < h * 0.45 ||
          i.height > h * 1.05
        )
          break
        first--
      }
      const packet = entries.slice(first, entries.indexOf(anchor) + 1),
        math = packet.slice(0, -1),
        selected = new Set(packet.map((e) => e.index)),
        whole = [...new Set(packet.map((e) => e.owner))]
      if (
        math.length < 3 ||
        math.length > 256 ||
        !math.some((e) => e.item.str.includes('=')) ||
        !whole.some((o) => !o.sourceOnly && !o.preserve) ||
        whole.some(
          (o) =>
            o.fragments.some(
              (f) => f.pageNumber !== pageNumber || f.items.some((i) => !selected.has(i.index))
            ) ||
            (o.preserve && !['formula', 'literal'].includes(o.preserve))
        )
      )
        continue
      if (
        math.some((e, at) => {
          const i = e.item,
            a = math[at + 1]?.item,
            b = math[at + 2]?.item
          if (
            i.width <= 0 ||
            i.height <= 0 ||
            i.transform.length !== 6 ||
            i.transform[0] <= 0 ||
            i.transform[1] !== 0 ||
            i.transform[2] !== 0 ||
            i.transform[3] !== i.height ||
            ![...i.transform, i.width, i.height].every(Number.isFinite) ||
            (Array.from(i.str).some((char) => char.charCodeAt(0) < 32) && !e.owner.sourceOnly)
          )
            return true
          return (i.str.normalize('NFKC').match(/[A-Za-z]+/gu) ?? []).some(
            (word) =>
              word.length > 1 &&
              !/^(?:lim|max|min|log|ln|exp|sin|cos|tan|det)$/u.test(word) &&
              !(
                word === 'in' &&
                a &&
                b &&
                /^(?:R|C|N|Z)$/u.test(a.str.normalize('NFKC')) &&
                /^\d{1,2}$/u.test(b.str) &&
                Math.abs(i.transform[5] - y) < h * 0.05 &&
                Math.abs(a.transform[5] - y) < h * 0.05 &&
                b.transform[5] > y &&
                b.height < h * 0.85
              )
          )
        })
      )
        continue
      packets.push({ entries: packet, owners: whole, anchor })
    }
    if (!packets.length) return empty
    const selected = new Set(packets.flatMap((p) => p.entries.map((e) => e.index))),
      ink =
        (await nativeTextFreeClipInkRegions(
          page,
          content,
          viewport,
          pageNumber,
          selected,
          identity.operators
        )) ??
        (await auxiliary.read({
          page,
          content,
          viewport,
          pageNumber,
          selected,
          operatorSnapshot: identity.operators
        })),
      paints = ink && (await nativePaints(identity.operators, viewport))
    if (
      !ink ||
      ink.size !== entries.length ||
      !paints ||
      sourceKey !== JSON.stringify(inputUnits) ||
      page.getOperatorList !== operatorReader ||
      page.commonObjs !== objects ||
      objects.get !== objectReader ||
      objects.has !== objectHas ||
      identity.key !== (await nativeInkPageIdentity(page, inputContent, inputViewport))?.key
    )
      return empty
    const inkBox = (index: number): Box => {
        const r = ink.get(index)!
        return [
          r.x * viewport.width,
          r.y * viewport.height,
          (r.x + r.width) * viewport.width,
          (r.y + r.height) * viewport.height
        ]
      },
      result = new Set<string>()
    for (const packet of packets) {
      const selected = new Set(packet.entries.map((e) => e.index)),
        bounds = union(packet.entries.flatMap((e) => [box(e), inkBox(e.index)])),
        h = packet.anchor.item.height,
        y = packet.anchor.item.transform[5],
        x = packet.anchor.item.transform[4],
        math = packet.entries.slice(0, -1),
        rules: number[] = []
      if (
        !bounds.every(Number.isFinite) ||
        bounds[0] < 0 ||
        bounds[1] < 0 ||
        bounds[2] > viewport.width ||
        bounds[3] > viewport.height ||
        entries.some((e) => !selected.has(e.index) && overlaps(inkBox(e.index), bounds, 1))
      )
        continue
      let closed = true
      for (const paint of paints.filter((p) => overlaps(p.bounds, bounds))) {
        const r = paint.hull,
          above = math.some((e) => {
            const b = box(e)
            return b[0] >= r[0] && b[2] <= r[2] && b[3] < r[1]
          }),
          below = math.some((e) => {
            const b = box(e)
            return b[0] >= r[0] && b[2] <= r[2] && b[1] > r[1]
          })
        if (
          paint.horizontalRule &&
          r[0] >= bounds[0] &&
          r[2] < x - h &&
          r[2] - r[0] >= h * 0.6 &&
          r[2] - r[0] < h * 8 &&
          above &&
          below
        )
          rules.push(paint.operator)
        else {
          closed = false
          break
        }
      }
      if (
        !closed ||
        (packet.owners.some(
          (o) =>
            !o.sourceOnly &&
            !o.preserve &&
            o.fragments
              .flatMap((f) => f.items)
              .every((i) => Math.abs((content.items[i.index] as Item).transform[5] - y) > h * 0.05)
        ) &&
          rules.length !== 1)
      )
        continue
      for (const owner of packet.owners)
        if (!owner.sourceOnly && !owner.preserve) result.add(owner.id)
    }
    return result
  } catch {
    return empty
  }
}
