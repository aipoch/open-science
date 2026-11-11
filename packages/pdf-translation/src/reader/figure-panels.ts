import type { PDFPageProxy, PDFDocumentProxy, getDocument } from 'pdfjs-dist'
import type { PdfTranslationSource } from './source.js'
import { createPdfTranslationSource } from './source.js'
import type { PdfTranslationExtraction } from './extraction.js'
import { carryNativeCaptionEligibility } from './caption-eligibility.js'
import {
  nativeInkPageIdentity,
  nativeInkPageCurrent,
  createNativeInkReader,
  type AuxiliaryNativeInkReader
} from './auxiliary-native-ink.js'
import { nativeAlgorithmInkRegions } from './native-source-geometry.js'
import { nativePaints } from './native-display-packets.js'
import { isPdfTranslationCaption } from './layout.js'

type Box = [number, number, number, number]
type Unit = PdfTranslationSource['units'][number]
type Rect = Unit['fragments'][number]['rect']
type Operators = Awaited<ReturnType<PDFPageProxy['getOperatorList']>>
type Paint = NonNullable<Awaited<ReturnType<typeof nativePaints>>>[number]
const retention = new WeakMap<PdfTranslationExtraction, () => boolean>()
export function isCurrentNativeFigurePanels(extraction: PdfTranslationExtraction): boolean {
  return retention.get(extraction)?.() ?? true
}
const inside = (a: Box, b: Box): boolean =>
  a[0] >= b[0] && a[1] >= b[1] && a[2] <= b[2] && a[3] <= b[3]
const overlaps = (a: Box, b: Box): boolean =>
  a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]
const close = (a: number, b: number): boolean => Math.abs(a - b) < 0.001

/** Project only inert state changes. A zero-width stroke, transparency, clipping,
 * form or unknown state never becomes evidence through this projection. */
async function panelOperators(original: Operators): Promise<Operators | undefined> {
  const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs'),
    fnArray: number[] = [],
    argsArray: Operators['argsArray'] = [],
    stack: number[] = [],
    strokes = new Set([
      OPS.stroke,
      OPS.closeStroke,
      OPS.fillStroke,
      OPS.eoFillStroke,
      OPS.closeFillStroke,
      OPS.closeEOFillStroke
    ])
  let width = 1
  for (const [index, op] of original.fnArray.entries()) {
    const args = original.argsArray[index]
    if (op === OPS.save) stack.push(width)
    else if (op === OPS.restore) {
      if (!stack.length) return
      width = stack.pop()!
    } else if (op === OPS.setGState) {
      if (JSON.stringify(args) !== '[[["ca",1]]]') return
      continue
    } else if (op === OPS.setLineWidth) {
      if (args?.length !== 1 || !Number.isFinite(args[0]) || args[0] < 0) return
      width = args[0]
      if (width === 0) continue
    } else if (
      op === OPS.clip ||
      op === OPS.eoClip ||
      (op === OPS.constructPath && strokes.has(args?.[0]) && width === 0)
    )
      return
    fnArray.push(op)
    argsArray.push(args)
  }
  return stack.length ? undefined : { ...original, fnArray, argsArray }
}

const panelInk: typeof nativeAlgorithmInkRegions = async (
  page,
  content,
  viewport,
  number,
  selected,
  snapshot
) => {
  const operators = await panelOperators(snapshot ?? (await page.getOperatorList()))
  return (
    operators && nativeAlgorithmInkRegions(page, content, viewport, number, selected, operators)
  )
}

/** A single closed, axis-aligned rounded frame; no additional subpaths. */
function roundedFrame(paint: Paint): boolean {
  const p = paint.path,
    m = paint.matrix
  if (m[1] !== 0 || m[2] !== 0 || m[0] === 0 || m[3] === 0) return false
  const commands: number[] = []
  for (let at = 0; at < p.length;) {
    const command = p[at++]
    commands.push(command)
    if (![0, 1, 2, 4].includes(command)) return false
    at += command === 2 ? 6 : command === 4 ? 0 : 2
  }
  if (commands.join() !== '0,1,2,1,2,1,2,1,2,4') return false
  // Four distinct boundary lines connected by monotone corner cubics.
  const [left, top, right, bottom] = paint.hull,
    point = (at: number): number[] => [m[0] * p[at] + m[4], m[3] * p[at + 1] + m[5]],
    sides = new Set<number>()
  let start = point(1)
  for (let at = 3; at < p.length - 1;) {
    const end = point(at + 1),
      side =
        close(start[0], end[0]) && close(end[0], left)
          ? 0
          : close(start[1], end[1]) && close(end[1], top)
            ? 1
            : close(start[0], end[0]) && close(end[0], right)
              ? 2
              : close(start[1], end[1]) && close(end[1], bottom)
                ? 3
                : -1
    if (side < 0 || sides.has(side)) return false
    sides.add(side)
    at += 3
    const curve = [end, point(at + 1), point(at + 3), point(at + 5)]
    for (const axis of [0, 1]) {
      const delta = curve[3][axis] - curve[0][axis]
      if (curve.some((v, i) => i > 0 && (v[axis] - curve[i - 1][axis]) * delta < -1e-6))
        return false
    }
    start = curve[3]
    at += 7
  }
  return sides.size === 4 && point(1).every((v, i) => close(v, start[i]))
}

/** Captioned stacks of complete header/body/two-column panels. Returns existing
 * owner IDs only; frame proximity alone never authorizes source-only text. */
export async function nativeFigurePanels(
  units: readonly Unit[],
  page: PDFPageProxy,
  pageNumber: number,
  auxiliary?: AuxiliaryNativeInkReader
): Promise<{ ids: ReadonlySet<string>; regions: Rect[]; current: () => boolean } | undefined> {
  try {
    const captions = units.filter(
      (u) =>
        /^(?:(?:Extended Data\s+)?(?:Figure|Fig\.))\s*\d/iu.test(u.source) &&
        isPdfTranslationCaption(u.source)
    )
    if (!captions.length) return
    const sourceKey = JSON.stringify(units),
      getText = page.getTextContent,
      getOps = page.getOperatorList,
      getViewport = page.getViewport,
      objects = page.commonObjs,
      getObject = objects?.get,
      hasObject = objects?.has,
      content = await page.getTextContent(),
      viewport = page.getViewport({ scale: 1 })
    if (
      viewport.scale !== 1 ||
      viewport.rotation !== 0 ||
      JSON.stringify(viewport.transform) !== JSON.stringify([1, 0, 0, -1, 0, viewport.height])
    )
      return
    const identity = await nativeInkPageIdentity(page, content, viewport)
    if (!identity) return
    const operators = await panelOperators(identity.operators),
      paints = operators && (await nativePaints(operators, viewport))
    if (!paints || paints.length > 256) return
    const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs'),
      frames = paints.filter((p) => p.kind === OPS.fill && roundedFrame(p)),
      panels: { box: Box; paints: Paint[]; header: Box; body: Box; divider: number }[] = []
    for (const frame of frames) {
      const outer = frame.hull,
        children = paints.filter((p) => p !== frame && inside(p.hull, outer)),
        fills = children.filter((p) => p.kind === OPS.fill).sort((a, b) => a.hull[1] - b.hull[1]),
        divider = children.find(
          (p) =>
            p.kind === OPS.stroke &&
            p.path.length === 6 &&
            p.path[0] === 0 &&
            p.path[3] === 1 &&
            p.hull[0] === p.hull[2]
        )
      if (fills.length !== 2) continue
      if (children.length !== 3 || !divider) return
      // This two-point segment has no joins. Half its Frobenius-bounded
      // transformed width contains butt, round and square caps alike.
      const radius = divider.strokeWidth / 2,
        d = divider.hull
      if (!inside([d[0] - radius, d[1] - radius, d[2] + radius, d[3] + radius], outer)) return
      const [header, body] = fills.map((p) => p.hull),
        inset = header[0] - outer[0]
      if (
        inset <= 0 ||
        inset > 2 ||
        !close(outer[2] - header[2], inset) ||
        !close(header[1] - outer[1], inset) ||
        !close(body[0], header[0]) ||
        !close(body[2], header[2]) ||
        !close(outer[3] - body[3], inset) ||
        !close(body[1] - header[3], inset) ||
        header[3] - header[1] <= inset * 2 ||
        header[3] - header[1] >= (body[3] - body[1]) / 3 ||
        !close(divider.hull[1], body[1]) ||
        !close(divider.hull[3], body[3]) ||
        divider.hull[0] <= body[0] + (body[2] - body[0]) / 4 ||
        divider.hull[0] >= body[2] - (body[2] - body[0]) / 4
      )
        continue
      panels.push({
        box: outer,
        paints: [frame, ...children],
        header,
        body,
        divider: divider.hull[0]
      })
    }
    if (panels.length < 2 || panels.length > 8) return
    panels.sort((a, b) => a.box[1] - b.box[1])
    const first = panels[0].box,
      last = panels.at(-1)!.box,
      group: Box = [first[0], first[1], first[2], last[3]],
      toBox = (r: Rect): Box => [
        r.x * viewport.width,
        r.y * viewport.height,
        (r.x + r.width) * viewport.width,
        (r.y + r.height) * viewport.height
      ],
      captionBoxes = captions.flatMap((u) =>
        u.fragments.filter((f) => f.pageNumber === pageNumber).map((f) => toBox(f.rect))
      ),
      caption = captionBoxes.filter(
        (b) => b[1] > last[3] && b[1] - last[3] < 36 && b[0] <= first[0] + 2 && b[2] >= first[2] - 2
      )
    if (
      caption.length !== 1 ||
      panels.some(
        (p, i) =>
          !close(p.box[0], first[0]) ||
          !close(p.box[2], first[2]) ||
          (i > 0 && (p.box[1] - panels[i - 1].box[3] < 4 || p.box[1] - panels[i - 1].box[3] > 36))
      )
    )
      return
    const corridor: Box = [group[0], group[1], group[2], caption[0][1]],
      admitted = new Set(panels.flatMap((p) => p.paints))
    if (paints.some((p) => !admitted.has(p) && overlaps(p.bounds, corridor))) return
    const owner = new Map<number, Unit>(),
      counts = new Map<number, number>()
    for (const unit of units)
      for (const f of unit.fragments)
        if (f.pageNumber === pageNumber)
          for (const item of f.items) {
            const native = identity.content.items[item.index]
            if (!native || !('str' in native) || native.str !== item.text) return
            owner.set(item.index, unit)
            counts.set(item.index, (counts.get(item.index) ?? 0) + 1)
          }
    const indices = identity.content.items.flatMap((i, n) =>
      'str' in i && i.str.trim() ? [n] : []
    )
    if (indices.some((n) => !owner.has(n) || counts.get(n) !== 1)) return
    const nativeOperators = await page.getOperatorList(),
      fontIds = new Set(
        identity.content.items.flatMap((i) => ('str' in i && i.str.trim() ? [i.fontName] : []))
      ),
      chars = new Set<string>()
    for (const [i, op] of nativeOperators.fnArray.entries())
      if (op === OPS.showText)
        for (const glyph of nativeOperators.argsArray[i]?.[0] ?? [])
          if (typeof glyph?.fontChar === 'string') chars.add(glyph.fontChar)
    if (fontIds.size * chars.size > 10000) return
    const sync = nativeInkPageCurrent(
      page,
      content,
      viewport,
      nativeOperators,
      [...fontIds].flatMap((id) => [...chars].map((c) => id + '_path_' + c))
    )
    if (!sync) return
    const selectedIndices = new Set(indices),
      ink =
        (await panelInk(
          page,
          identity.content,
          viewport,
          pageNumber,
          selectedIndices,
          identity.operators
        )) ??
        (await auxiliary?.read({
          page,
          content,
          viewport,
          pageNumber,
          selected: selectedIndices,
          operatorSnapshot: identity.operators
        }))
    if (!ink || ink.size !== indices.length) return
    const selected = new Set<number>(),
      ids = new Set<string>()
    for (const panel of panels) {
      const entries = indices.filter((n) => inside(toBox(ink.get(n)!), panel.box)),
        columns = [0, 0]
      let title = 0
      for (const n of entries) {
        const b = toBox(ink.get(n)!)
        if (inside(b, panel.header)) title++
        else if (inside(b, panel.body) && (b[2] < panel.divider || b[0] > panel.divider))
          columns[b[2] < panel.divider ? 0 : 1]++
        else return
        selected.add(n)
      }
      if (!title || columns.some((n) => n < 2)) return
    }
    if (indices.some((n) => !selected.has(n) && overlaps(toBox(ink.get(n)!), corridor))) return
    for (const n of selected) {
      const unit = owner.get(n)!
      if (
        isPdfTranslationCaption(unit.source) ||
        unit.fragments.some(
          (f) =>
            f.pageNumber !== pageNumber ||
            f.items.some((i) => i.text.trim() && !selected.has(i.index))
        )
      )
        return
      ids.add(unit.id)
    }
    const current = (): boolean =>
      sync() &&
      sourceKey === JSON.stringify(units) &&
      page.getTextContent === getText &&
      page.getOperatorList === getOps &&
      page.getViewport === getViewport &&
      page.commonObjs === objects &&
      objects.get === getObject &&
      objects.has === hasObject
    if (
      sourceKey !== JSON.stringify(units) ||
      page.getTextContent !== getText ||
      page.getOperatorList !== getOps ||
      page.getViewport !== getViewport ||
      page.commonObjs !== objects ||
      objects.get !== getObject ||
      objects.has !== hasObject ||
      identity.key !== (await nativeInkPageIdentity(page, content, viewport))?.key ||
      !current()
    )
      return
    return {
      ids,
      current,
      regions: panels.map(({ box: b }) => ({
        x: b[0] / viewport.width,
        y: b[1] / viewport.height,
        width: (b[2] - b[0]) / viewport.width,
        height: (b[3] - b[1]) / viewport.height
      }))
    }
  } catch {
    return
  }
}

export async function retainNativeFigurePanels({
  extraction,
  document,
  sourceIdentity,
  nativeDocumentFactory,
  signal
}: {
  extraction: PdfTranslationExtraction
  document: Pick<PDFDocumentProxy, 'getPage' | 'numPages' | 'fingerprints'> &
    Partial<Pick<PDFDocumentProxy, 'getData' | 'getMetadata'>>
  sourceIdentity: { sourceChecksum: string; sourceSizeBytes: number }
  nativeDocumentFactory?: typeof getDocument
  signal: AbortSignal
}): Promise<PdfTranslationExtraction> {
  const source = extraction.source,
    getPage = document.getPage,
    ids = new Set<string>(),
    checks: (() => boolean)[] = [],
    regions = [...(source.originalRegions ?? [])],
    auxiliary = createNativeInkReader(
      { document, sourceIdentity, nativeDocumentFactory, signal },
      panelInk
    )
  try {
    for (let number = 1; number <= source.pages.length; number++) {
      signal.throwIfAborted()
      const units = source.units.filter((u) => u.fragments.some((f) => f.pageNumber === number))
      if (
        !units.some(
          (u) =>
            /^(?:(?:Extended Data\s+)?(?:Figure|Fig\.))\s*\d/iu.test(u.source) &&
            isPdfTranslationCaption(u.source)
        )
      )
        continue
      const page = await document.getPage(number),
        viewport = page.getViewport({ scale: 1 }),
        expected = source.pages[number - 1]
      if (viewport.width !== expected.width || viewport.height !== expected.height)
        return extraction
      const result = await nativeFigurePanels(units, page, number, auxiliary)
      signal.throwIfAborted()
      if (!result) continue
      checks.push(result.current)
      for (const id of result.ids) ids.add(id)
      for (const rect of result.regions) {
        if (
          !regions.some(
            (r) =>
              r.pageNumber === number &&
              r.rect.x <= rect.x &&
              r.rect.y <= rect.y &&
              r.rect.x + r.rect.width >= rect.x + rect.width &&
              r.rect.y + r.rect.height >= rect.y + rect.height
          )
        )
          regions.push({ pageNumber: number, rect })
      }
    }
  } finally {
    await auxiliary.dispose()
  }
  signal.throwIfAborted()
  const current = (): boolean =>
    document.getPage === getPage &&
    document.fingerprints[0] === source.fingerprint &&
    document.numPages === source.pages.length &&
    checks.every((check) => check())
  if (!ids.size || !current()) return extraction
  const result = {
    ...extraction,
    source: carryNativeCaptionEligibility(
      source,
      createPdfTranslationSource({
        ...source,
        originalRegions: regions,
        units: source.units.map((u) =>
          ids.has(u.id) ? { ...u, sourceOnly: true, figure: true } : u
        )
      })
    )
  }
  retention.set(result, current)
  return result
}
