import type { PDFPageProxy, PDFDocumentProxy, getDocument } from 'pdfjs-dist'
import type { PdfStructureResult } from '@aipoch/pdf-structure/result'
import { createPdfTranslationSource, type PdfTranslationSource } from './source.js'
import type { PdfTranslationExtraction } from './extraction.js'
import type { AuxiliaryNativeInkReader } from './auxiliary-native-ink.js'
import {
  nativeInkPageIdentity,
  nativeInkPageCurrent,
  createAuxiliaryNativeInkReader
} from './auxiliary-native-ink.js'
import { nativeAlgorithmInkRegions, nativeLabelRegion } from './native-source-geometry.js'
import { nativePaints } from './native-display-packets.js'
import { carryNativeCaptionEligibility } from './caption-eligibility.js'

type Unit = PdfTranslationSource['units'][number]
type Rect = Unit['fragments'][number]['rect']
type Box = [number, number, number, number]
type Paint = NonNullable<Awaited<ReturnType<typeof nativePaints>>>[number]
const retainedChecks = new WeakMap<PdfTranslationExtraction, () => boolean>()
export function isCurrentNativeFigureVariableKeys(extraction: PdfTranslationExtraction): boolean {
  return retainedChecks.get(extraction)?.() ?? true
}
const inside = (a: Box, b: Box): boolean =>
  a[0] >= b[0] && a[1] >= b[1] && a[2] <= b[2] && a[3] <= b[3]
const overlaps = (a: Box, b: Box): boolean =>
  a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]

function circle(p: Paint): { center: number[]; radius: number } | undefined {
  const commands: number[] = [],
    points: number[][] = [],
    m = p.matrix
  for (let at = 0; at < p.path.length;) {
    const op = p.path[at++],
      count = op === 0 ? 2 : op === 2 ? 6 : op === 4 ? 0 : -1
    if (count < 0) return
    commands.push(op)
    for (const end = at + count; at < end; at += 2)
      points.push([
        m[0] * p.path[at] + m[2] * p.path[at + 1] + m[4],
        m[1] * p.path[at] + m[3] * p.path[at + 1] + m[5]
      ])
  }
  if (!['0,2,2,2,2,4', '0,2,2,2,2,4,0'].includes(commands.join())) return
  const center = [(p.hull[0] + p.hull[2]) / 2, (p.hull[1] + p.hull[3]) / 2],
    radius = (p.hull[2] - p.hull[0]) / 2,
    distance = (a: number[], b: number[]): number => Math.hypot(a[0] - b[0], a[1] - b[1])
  if (radius < 4 || Math.abs(p.hull[3] - p.hull[1] - radius * 2) > radius * 0.01) return
  const k = 0.55228475,
    first = points[0].map((v, i) => (v - center[i]) / radius),
    next = points[3].map((v, i) => (v - center[i]) / radius)
  if (
    Math.abs(Math.hypot(...first) - 1) > 0.007 ||
    Math.abs(first[0] * next[0] + first[1] * next[1]) > 0.007
  )
    return
  const canonical = [
    [1, 0],
    [1, k],
    [k, 1],
    [0, 1],
    [-k, 1],
    [-1, k],
    [-1, 0],
    [-1, -k],
    [-k, -1],
    [0, -1],
    [k, -1],
    [1, -k],
    [1, 0]
  ]
  if (
    canonical.some(
      ([x, y], i) =>
        distance(
          points[i],
          center.map((v, j) => v + radius * (x * first[j] + y * next[j]))
        ) >
        radius * 0.007
    ) ||
    (points.length === 14 && distance(points[13], center) > radius * 0.007)
  )
    return
  return { center, radius }
}

/** Repeated names belong to separate native graph components, never to a
 * text/position match. Every body paint must be a node, connecting shaft, or
 * a uniquely attached arrowhead before the component label sets can agree. */
function sharedComponentLabels(
  nodes: { center: number[]; radius: number; paint: Paint; label: string }[],
  marks: Paint[],
  stroke: number,
  fillStroke: number
): boolean {
  const point = (p: Paint, x: number, y: number): number[] => [
      p.matrix[0] * x + p.matrix[2] * y + p.matrix[4],
      p.matrix[1] * x + p.matrix[3] * y + p.matrix[5]
    ],
    distance = (a: number[], b: number[]): number => Math.hypot(a[0] - b[0], a[1] - b[1]),
    rest = marks.filter((p) => !nodes.some((n) => n.paint === p)),
    edges: { paint: Paint; a: number; b: number; start: number[]; end: number[] }[] = []
  for (const p of rest.filter((p) => p.kind === stroke)) {
    if (p.path.length !== 6 || p.path[0] !== 0 || p.path[3] !== 1) return false
    const start = point(p, p.path[1], p.path[2]),
      end = point(p, p.path[4], p.path[5]),
      length = distance(start, end)
    if (!length) return false
    const dx = (end[0] - start[0]) / length,
      dy = (end[1] - start[1]) / length,
      matches = (at: number[], direction: number): number[] =>
        nodes.flatMap((node, index) => {
          const x = node.center[0] - at[0],
            y = node.center[1] - at[1],
            along = (x * dx + y * dy) * direction,
            across = Math.abs(x * dy - y * dx)
          return along >= node.radius - p.strokeWidth &&
            along <= node.radius * 1.75 &&
            across <= p.strokeWidth &&
            p.strokeWidth < node.radius / 3
            ? [index]
            : []
        }),
      a = matches(start, -1),
      b = matches(end, 1)
    if (a.length !== 1 || b.length !== 1 || a[0] === b[0]) return false
    edges.push({ paint: p, a: a[0], b: b[0], start, end })
  }
  const usedHeads = new Set<string>()
  for (const p of rest.filter((p) => p.kind !== stroke)) {
    if (
      p.kind !== fillStroke ||
      p.path.length !== 13 ||
      [0, 3, 6, 9, 12].some((at, i) => p.path[at] !== (i === 0 ? 0 : i === 4 ? 4 : 1))
    )
      return false
    const vertices = [1, 4, 7, 10].map((at) => point(p, p.path[at], p.path[at + 1])),
      candidates: string[] = []
    for (const [index, edge] of edges.entries())
      for (const reverse of [false, true]) {
        const start = reverse ? edge.end : edge.start,
          end = reverse ? edge.start : edge.end,
          node = nodes[reverse ? edge.a : edge.b],
          length = distance(start, end),
          dx = (end[0] - start[0]) / length,
          dy = (end[1] - start[1]) / length,
          projected = vertices.map(([x, y]) => [
            (x - end[0]) * dx + (y - end[1]) * dy,
            (x - end[0]) * dy - (y - end[1]) * dx
          ]),
          tip = projected.findIndex((v) => v[0] === Math.max(...projected.map((q) => q[0]))),
          [front, wing, notch, other] = [0, 1, 2, 3].map((offset) => projected[(tip + offset) % 4]),
          tolerance = Math.max(p.strokeWidth, edge.paint.strokeWidth) / 4
        if (
          Math.abs(front[1]) > tolerance ||
          Math.abs(notch[1]) > tolerance ||
          Math.abs(wing[0] - other[0]) > tolerance ||
          Math.abs(wing[1] + other[1]) > tolerance ||
          wing[1] * other[1] >= 0 ||
          front[0] <= notch[0] ||
          notch[0] <= wing[0] ||
          front[0] - wing[0] > node.radius ||
          Math.abs(wing[1]) > node.radius / 2 ||
          Math.abs(notch[0]) > edge.paint.strokeWidth * 2 ||
          distance(vertices[tip], node.center) > node.radius * 1.5 ||
          p.strokeWidth >= node.radius / 3
        )
          continue
        candidates.push(`${index}:${reverse}`)
      }
    if (candidates.length !== 1 || usedHeads.has(candidates[0])) return false
    usedHeads.add(candidates[0])
  }
  const pending = new Set(nodes.map((_, i) => i)),
    components: number[][] = []
  while (pending.size) {
    const component = [pending.values().next().value!]
    pending.delete(component[0])
    for (const index of component)
      for (const edge of edges) {
        const peer = edge.a === index ? edge.b : edge.b === index ? edge.a : undefined
        if (peer !== undefined && pending.delete(peer)) component.push(peer)
      }
    components.push(component)
  }
  if (components.length !== 2) return false
  const labels = components.map((component) => component.map((i) => nodes[i].label).sort())
  return (
    labels.every((set) => set.length >= 2 && new Set(set).size === set.length) &&
    JSON.stringify(labels[0]) === JSON.stringify(labels[1])
  )
}

/** Independently prove complete native key owners outside a circular figure crop. */
export async function nativeFigureVariableKeys(
  units: readonly Unit[],
  page: PDFPageProxy,
  pageNumber: number,
  figure: { region: Rect; caption: Rect; pageSize: { width: number; height: number } },
  auxiliary: AuxiliaryNativeInkReader
): Promise<{ ids: ReadonlySet<string>; region: Rect; current: () => boolean } | undefined> {
  const empty = undefined
  try {
    const sourceKey = JSON.stringify(units),
      figureKey = JSON.stringify(figure),
      getText = page.getTextContent,
      getOps = page.getOperatorList,
      objects = page.commonObjs,
      getObject = objects.get,
      hasObject = objects.has,
      content = await page.getTextContent(),
      viewport = page.getViewport({ scale: 1 })
    if (
      page.pageNumber !== pageNumber ||
      viewport.width !== figure.pageSize.width ||
      viewport.height !== figure.pageSize.height ||
      viewport.scale !== 1 ||
      viewport.rotation !== 0 ||
      JSON.stringify(viewport.transform) !== JSON.stringify([1, 0, 0, -1, 0, viewport.height])
    )
      return empty
    const identity = await nativeInkPageIdentity(page, content, viewport)
    if (!identity) return empty
    const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs'),
      // PDF.js can emit an empty stroke after closing a scope. It has no
      // current path. Clipping is never projected into evidence here.
      operators = {
        ...identity.operators,
        fnArray: [] as number[],
        argsArray: [] as typeof identity.operators.argsArray
      }
    for (const [i, op] of identity.operators.fnArray.entries()) {
      const args = identity.operators.argsArray[i]
      if (op === OPS.clip || op === OPS.eoClip) return empty
      if (
        op === OPS.constructPath &&
        args?.[0] === OPS.stroke &&
        args[1]?.length === 1 &&
        args[1][0] === null &&
        args[2] === null
      )
        continue
      operators.fnArray.push(op)
      operators.argsArray.push(args)
    }
    const paints = await nativePaints(operators, viewport)
    if (!paints || paints.length > 80) return empty
    const toBox = (r: Rect): Box => [
        r.x * viewport.width,
        r.y * viewport.height,
        (r.x + r.width) * viewport.width,
        (r.y + r.height) * viewport.height
      ],
      body = toBox(figure.region),
      caption = toBox(figure.caption),
      nodes = paints
        .filter((p) => p.kind === OPS.fillStroke && inside(p.bounds, body))
        .map((paint) => {
          const node = circle(paint)
          return node && { ...node, paint, label: '' }
        })
        .filter((n) => !!n)
    if (nodes.length < 4 || nodes.length > 8 || caption[1] <= body[3] || caption[1] - body[3] > 80)
      return empty
    const owners = new Map<number, Unit>(),
      counts = new Map<number, number>()
    for (const unit of units)
      for (const f of unit.fragments)
        if (f.pageNumber === pageNumber)
          for (const item of f.items) {
            const native = identity.content.items[item.index]
            if (!native || !('str' in native) || native.str !== item.text) return empty
            owners.set(item.index, unit)
            counts.set(item.index, (counts.get(item.index) ?? 0) + 1)
          }
    const entries = identity.content.items.flatMap((item, index) =>
      'str' in item && item.str.trim() ? [{ item, index }] : []
    )
    if (entries.some((e) => !owners.has(e.index) || counts.get(e.index) !== 1)) return empty
    const nativeOperators = await page.getOperatorList(),
      fonts = new Set(entries.map((e) => e.item.fontName)),
      chars = new Set<string>()
    for (const [i, op] of nativeOperators.fnArray.entries())
      if (op === OPS.showText)
        for (const g of nativeOperators.argsArray[i]?.[0] ?? [])
          if (typeof g?.fontChar === 'string') chars.add(g.fontChar)
    if (fonts.size * chars.size > 10000) return empty
    const sync = nativeInkPageCurrent(
      page,
      content,
      viewport,
      nativeOperators,
      [...fonts].flatMap((font) => [...chars].map((char) => font + '_path_' + char))
    )
    if (!sync) return empty
    const selected = new Set(entries.map((e) => e.index)),
      ink =
        (await nativeAlgorithmInkRegions(
          page,
          identity.content,
          viewport,
          pageNumber,
          selected,
          identity.operators
        )) ??
        (await auxiliary.read({
          page,
          content: identity.content,
          viewport,
          pageNumber,
          selected,
          operatorSnapshot: identity.operators
        }))
    if (!ink || ink.size !== entries.length) return empty
    const captionEntries = entries.filter((e) => overlaps(toBox(ink.get(e.index)!), caption))
    if (
      !captionEntries.length ||
      !captionEntries.some((e) => /^(?:Figure|Fig\.)\s*\d/iu.test(e.item.str.trim())) ||
      captionEntries.some(
        (e) => !/^(?:Figure|Fig\.)\s*\d/iu.test(owners.get(e.index)!.source.trim())
      )
    )
      return empty
    const labels = new Set<string>(),
      nodeIndexes = new Set<number>()
    for (const node of nodes) {
      const matches = entries.filter((e) => {
        const b = toBox(ink.get(e.index)!)
        return [
          [b[0], b[1]],
          [b[0], b[3]],
          [b[2], b[1]],
          [b[2], b[3]]
        ].every((p) => Math.hypot(p[0] - node.center[0], p[1] - node.center[1]) < node.radius * 0.8)
      })
      if (
        matches.length !== 1 ||
        !/^[A-Z]$/u.test(matches[0].item.str.trim()) ||
        nodeIndexes.has(matches[0].index)
      )
        return empty
      labels.add(matches[0].item.str.trim())
      nodeIndexes.add(matches[0].index)
      node.label = matches[0].item.str.trim()
    }
    const marks = paints.filter((p) => overlaps(p.bounds, body)),
      bottom = Math.max(...marks.map((p) => p.bounds[3]))
    if (!marks.length || marks.some((p) => !inside(p.bounds, body))) return empty
    if (
      labels.size !== nodes.length &&
      !sharedComponentLabels(nodes, marks, OPS.stroke, OPS.fillStroke)
    )
      return empty
    const keys = entries.filter((e) => {
      const b = toBox(ink.get(e.index)!)
      return b[1] >= bottom && b[3] <= caption[1]
    })
    if (keys.length < 4 || keys.length > 40) return empty
    const rows: (typeof keys)[] = []
    for (const entry of keys.sort(
      (a, b) =>
        b.item.transform[5] - a.item.transform[5] || a.item.transform[4] - b.item.transform[4]
    )) {
      const row = rows.find((r) => Math.abs(r[0].item.transform[5] - entry.item.transform[5]) < 0.5)
      if (row) row.push(entry)
      else rows.push([entry])
    }
    if (rows.length < 2 || rows.length > 6) return empty
    const found = new Set<string>()
    for (const row of rows) {
      const groups: (typeof keys)[] = []
      row.sort((a, b) => a.item.transform[4] - b.item.transform[4])
      for (const [index, e] of row.entries()) {
        // A letter in the definition is not a new key. Require the native
        // following sequence to contain its delimiter before starting a group.
        if (
          /^[A-Z]\s*(?:=\s*\d+\s*)?:/u.test(
            row
              .slice(index)
              .map((entry) => entry.item.str)
              .join('')
          )
        )
          groups.push([e])
        else if (groups.length) groups.at(-1)!.push(e)
        else return empty
      }
      if (!groups.length || groups.length > 2) return empty
      for (const g of groups) {
        const match = /^([A-Z])\s*(?:=\s*\d+\s*)?:\s*\p{L}/u.exec(g.map((e) => e.item.str).join(''))
        if (!match || !labels.has(match[1]) || found.has(match[1])) return empty
        found.add(match[1])
      }
    }
    if (found.size !== labels.size) return empty
    const fontBoxes: Box[] = []
    for (const e of keys) {
      const style = identity.content.styles[e.item.fontName],
        region =
          style &&
          Number.isFinite(style.ascent) &&
          Number.isFinite(style.descent) &&
          !style.vertical &&
          nativeLabelRegion(e.item, style, viewport, pageNumber)
      if (!region) return empty
      fontBoxes.push(toBox(region))
    }
    const boxes = [...keys.map((e) => toBox(ink.get(e.index)!)), ...fontBoxes],
      keyBox: Box = [
        Math.min(...boxes.map((b) => b[0])),
        Math.min(...boxes.map((b) => b[1])),
        Math.max(...boxes.map((b) => b[2])),
        Math.max(...boxes.map((b) => b[3]))
      ],
      indices = new Set(keys.map((e) => e.index)),
      ids = new Set<string>()
    if (
      paints.some((p) => overlaps(p.bounds, keyBox)) ||
      entries.some((e) => !indices.has(e.index) && overlaps(toBox(ink.get(e.index)!), keyBox))
    )
      return empty
    for (const e of keys) {
      const unit = owners.get(e.index)!
      if (
        unit.fragments.some(
          (f) =>
            f.pageNumber !== pageNumber ||
            f.items.some((i) => i.text.trim() && !indices.has(i.index))
        )
      )
        return empty
      ids.add(unit.id)
    }
    const current = (): boolean =>
      sync() && sourceKey === JSON.stringify(units) && figureKey === JSON.stringify(figure)
    if (
      sourceKey !== JSON.stringify(units) ||
      figureKey !== JSON.stringify(figure) ||
      page.getTextContent !== getText ||
      page.getOperatorList !== getOps ||
      page.commonObjs !== objects ||
      objects.get !== getObject ||
      objects.has !== hasObject ||
      identity.key !== (await nativeInkPageIdentity(page, content, viewport))?.key ||
      !current()
    )
      return empty
    return {
      ids,
      current,
      region: {
        x: keyBox[0] / viewport.width,
        y: keyBox[1] / viewport.height,
        width: (keyBox[2] - keyBox[0]) / viewport.width,
        height: (keyBox[3] - keyBox[1]) / viewport.height
      }
    }
  } catch {
    return empty
  }
}

/** The cache supplies a candidate, while native shapes and glyphs prove the
 * detached keys. Keep the original crop and add a separate native key region. */
export async function retainNativeFigureVariableKeys({
  extraction,
  document,
  results,
  sourceIdentity,
  nativeDocumentFactory,
  signal
}: {
  extraction: PdfTranslationExtraction
  document: Pick<PDFDocumentProxy, 'getPage' | 'numPages' | 'fingerprints'> &
    Partial<Pick<PDFDocumentProxy, 'getData' | 'getMetadata'>>
  results: readonly PdfStructureResult[]
  sourceIdentity: { sourceChecksum: string; sourceSizeBytes: number }
  nativeDocumentFactory?: typeof getDocument
  signal: AbortSignal
}): Promise<PdfTranslationExtraction> {
  const source = extraction.source,
    getPage = document.getPage,
    sourceKey = JSON.stringify(source),
    resultKey = JSON.stringify(results),
    ids = new Set<string>(),
    checks: (() => boolean)[] = [],
    regions = [...(source.originalRegions ?? [])],
    auxiliary = createAuxiliaryNativeInkReader({
      document,
      sourceIdentity,
      nativeDocumentFactory,
      signal
    }),
    elements = results.flatMap((r) => r.elements),
    pages = new Set<number>()
  try {
    for (const element of elements) {
      if (
        element.kind !== 'figure' ||
        element.regions.length !== 1 ||
        element.caption?.regions.length !== 1
      )
        continue
      const region = element.regions[0],
        caption = element.caption.regions[0],
        pageNumber = region.page
      if (
        caption.page !== pageNumber ||
        pages.has(pageNumber) ||
        elements.filter((e) => e.kind === 'figure' && e.regions.some((r) => r.page === pageNumber))
          .length !== 1
      )
        continue
      pages.add(pageNumber)
      signal.throwIfAborted()
      const pageSize = source.pages[pageNumber - 1]
      if (!pageSize) continue
      const page = await document.getPage(pageNumber),
        proof = await nativeFigureVariableKeys(
          source.units,
          page,
          pageNumber,
          { region, caption, pageSize },
          auxiliary
        )
      if (!proof || (await document.getPage(pageNumber)) !== page || !proof.current()) continue
      const box = (r: Rect): Box => [r.x, r.y, r.x + r.width, r.y + r.height]
      if (
        elements.some(
          (other) =>
            other !== element &&
            [...other.regions, ...(other.caption?.regions ?? [])].some(
              (r) => r.page === pageNumber && overlaps(box(r), box(proof.region))
            )
        )
      )
        continue
      checks.push(proof.current)
      for (const id of proof.ids) ids.add(id)
      regions.push({ pageNumber, rect: proof.region })
    }
  } finally {
    await auxiliary.dispose()
  }
  signal.throwIfAborted()
  const current = (): boolean =>
    document.getPage === getPage &&
    sourceKey === JSON.stringify(source) &&
    resultKey === JSON.stringify(results) &&
    document.fingerprints[0] === source.fingerprint &&
    document.numPages === source.pages.length &&
    checks.every((check) => check())
  if (!ids.size || !current()) return extraction
  const retained = {
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
  retainedChecks.set(retained, current)
  return retained
}
