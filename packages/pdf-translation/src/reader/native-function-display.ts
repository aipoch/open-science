import type { PDFDocumentProxy, PDFPageProxy, getDocument } from 'pdfjs-dist'
import {
  createAuxiliaryNativeNegativeReader,
  nativeInkPageIdentity,
  nativeInkPageCurrent
} from './auxiliary-native-ink.js'
import { nativeClosedMathGrammar, nativeMathAtom, nativePaints } from './native-display-packets.js'
import { readNativeGlyphSelection, type NativeSelectedGlyph } from './native-selected-glyphs.js'
import {
  nativeAlgorithmInkRegions,
  nativeTextFreeClipInkRegions
} from './native-source-geometry.js'
import { getPdfTranslationTextContent } from './text-content.js'
import type { PdfTranslationSource } from './source.js'
type Content = Awaited<ReturnType<PDFPageProxy['getTextContent']>>
type Item = Extract<Content['items'][number], { str: string }>
type Viewport = ReturnType<PDFPageProxy['getViewport']>
type CurvePiece = { glyph: NativeSelectedGlyph; item: Item }
type Frame = { indices: number[]; signature: string }
type Region = { page: number; x: number; y: number; width: number; height: number }
const annotationsByFrame = new WeakMap<readonly Frame[], { page: PDFPageProxy; key: string }>()
const frames = new WeakMap<ReadonlyMap<number, Region>, readonly Frame[]>(),
  current = new WeakMap<readonly Frame[], () => boolean>()

// This is only a candidate. The word alone never changes eligibility.
export function hasNativeFunctionDisplay(content: Content): boolean {
  return content.items.some((i) => 'str' in i && i.str === 'in')
}
function packets(content: Content): number[][] {
  const entries = content.items.flatMap((i, index) =>
      'str' in i && i.str.trim() ? [{ item: i, index }] : []
    ),
    result: number[][] = []
  for (let at = 0; at < entries.length; at++) {
    const first = entries[at].item,
      h = first.height,
      y = first.transform[5]
    if (first.str !== 'in' || h <= 0) continue
    let end = at + 1
    while (end < entries.length && end - at < 256) {
      const i = entries[end].item
      if (
        !nativeMathAtom(i, h) ||
        Math.abs(i.transform[5] - y) > h * 5 ||
        i.transform[4] < first.transform[4] - h * 0.1
      )
        break
      end++
    }
    const body = entries.slice(at + 1, end)
    if (
      body.length < 4 ||
      !nativeClosedMathGrammar(
        body.map((e) => e.item),
        h
      )
    )
      continue
    const equals = body.filter(
      ({ item: i }) =>
        /^=\s*\(/u.test(i.str) &&
        Math.abs(i.height - h) < h * 0.05 &&
        y - i.transform[5] > h * 2 &&
        y - i.transform[5] < h * 4 &&
        i.transform[4] >= first.transform[4] &&
        i.transform[4] - first.transform[4] < h * 2
    )
    if (equals.length !== 1) continue
    result.push(entries.slice(at, end).map((e) => e.index))
  }
  return result
}

// Observe the filled curved edges themselves. Unicode and legacy font codes
// do not identify delimiters. These profiles grant exclusion, never paint rights.
function edgeProfile(
  parts: { glyph: NativeSelectedGlyph; item: Item }[],
  height: number
): { box: number[]; xs: number[] } | undefined {
  const segments: number[][] = [],
    pieces: number[][][] = []
  for (const { glyph: g, item: i } of parts) {
    const begin = segments.length
    const points: number[][] = []
    let from: number[] | undefined,
      start: number[] | undefined,
      drawn = false
    const xy = (x: number, y: number): number[] => [
      i.transform[4] + (g.offset * i.height) / 1000 + x * i.height,
      height - i.transform[5] - y * i.height
    ]
    for (let n = 0; n < g.path.length;) {
      const op = g.path[n++],
        count = op === 0 || op === 1 ? 2 : op === 2 ? 6 : op === 3 ? 4 : op === 4 ? 0 : -1
      if (count < 0 || n + count > g.path.length) return
      if (op === 0) {
        if (drawn) return
        start = from = xy(g.path[n], g.path[n + 1])
        points.push(from)
      } else if (op === 1) {
        if (!from) return
        const to = xy(g.path[n], g.path[n + 1])
        segments.push([...from, ...to])
        from = to
        points.push(to)
      } else if (op === 2 || op === 3) {
        if (!from) return
        drawn = true
        const a = from,
          b = xy(g.path[n], g.path[n + 1]),
          c = xy(g.path[n + 2], g.path[n + 3]),
          d = op === 2 ? xy(g.path[n + 4], g.path[n + 5]) : c
        for (let t = 1; t <= 16; t++) {
          const u = t / 16,
            v = 1 - u,
            to =
              op === 2
                ? [
                    v * v * v * a[0] +
                      3 * v * v * u * b[0] +
                      3 * v * u * u * c[0] +
                      u * u * u * d[0],
                    v * v * v * a[1] +
                      3 * v * v * u * b[1] +
                      3 * v * u * u * c[1] +
                      u * u * u * d[1]
                  ]
                : [
                    v * v * a[0] + 2 * v * u * b[0] + u * u * c[0],
                    v * v * a[1] + 2 * v * u * b[1] + u * u * c[1]
                  ]
          segments.push([...from, ...to])
          from = to
          points.push(to)
        }
      } else {
        if (!from || !start) return
        segments.push([...from, ...start])
        from = start
      }
      n += count
    }
    if (!drawn || !points.length || g.path.at(-1) !== 4) return
    pieces.push(segments.slice(begin))
  }
  const vertical = pieces
    .map((p) => [
      Math.min(...p.flatMap((s) => [s[1], s[3]])),
      Math.max(...p.flatMap((s) => [s[1], s[3]]))
    ])
    .sort((a, b) => a[0] - b[0])
  if (vertical.some((r, n) => n && r[0] > vertical[n - 1][1])) return
  const box = [
      Math.min(...segments.flatMap((s) => [s[0], s[2]])),
      Math.min(...segments.flatMap((s) => [s[1], s[3]])),
      Math.max(...segments.flatMap((s) => [s[0], s[2]])),
      Math.max(...segments.flatMap((s) => [s[1], s[3]]))
    ],
    w = box[2] - box[0],
    h = box[3] - box[1],
    xs: number[] = []
  if (!box.every(Number.isFinite) || w <= 0 || h / w < 3 || h / w > 12) return
  for (const f of [0.1, 0.25, 0.5, 0.75, 0.9]) {
    const y = box[1] + h * f,
      intervals: number[][] = []
    for (const piece of pieces) {
      const cross = piece
        .flatMap((s) =>
          (s[1] <= y && s[3] > y) || (s[3] <= y && s[1] > y)
            ? [s[0] + ((s[2] - s[0]) * (y - s[1])) / (s[3] - s[1])]
            : []
        )
        .sort((a, b) => a - b)
      if (!cross.length) continue
      if (cross.length !== 2) return
      intervals.push(cross)
    }
    intervals.sort((a, b) => a[0] - b[0])
    if (!intervals.length || intervals.some((r, n) => n && r[0] > intervals[n - 1][1])) return
    const left = intervals[0][0],
      right = Math.max(...intervals.map((r) => r[1]))
    if (right - left > w * 0.4) return
    xs.push(((left + right) / 2 - box[0]) / w)
  }
  return { box, xs }
}
async function readSelection(
  page: PDFPageProxy,
  content: Content,
  viewport: Viewport,
  pageNumber: number,
  selected: ReadonlySet<number>,
  snapshot?: Awaited<ReturnType<PDFPageProxy['getOperatorList']>>
): Promise<Map<number, Region> | undefined> {
  try {
    if (
      viewport.scale !== 1 ||
      viewport.rotation !== 0 ||
      JSON.stringify(viewport.transform) !== JSON.stringify([1, 0, 0, -1, 0, viewport.height])
    )
      return
    const proof = await readNativeGlyphSelection(
      page,
      content,
      viewport,
      pageNumber,
      selected,
      snapshot
    )
    if (!proof) return
    const operators = await page.getOperatorList(),
      paints = await nativePaints(operators, viewport),
      allInk =
        (await nativeAlgorithmInkRegions(
          page,
          content,
          viewport,
          pageNumber,
          selected,
          operators
        )) ??
        (await nativeTextFreeClipInkRegions(
          page,
          content,
          viewport,
          pageNumber,
          selected,
          operators
        )),
      annotationReader = page.getAnnotations,
      annotations = await page.getAnnotations({ intent: 'display' }),
      annotationKey = JSON.stringify(annotations),
      outlineKeys = new Set<string>(),
      stack: string[] = []
    if (
      !paints ||
      !allInk ||
      allInk.size !== content.items.filter((i) => 'str' in i && i.str.trim()).length
    )
      return
    const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    let font = ''
    for (const [n, op] of operators.fnArray.entries()) {
      const args = operators.argsArray[n]
      if (op === OPS.setFont) font = args[0]
      else if ([OPS.save, OPS.paintFormXObjectBegin, OPS.beginGroup].includes(op)) stack.push(font)
      else if ([OPS.restore, OPS.paintFormXObjectEnd, OPS.endGroup].includes(op))
        font = stack.pop() ?? ''
      else if (op === OPS.showText)
        for (const glyph of args[0])
          if (typeof glyph?.fontChar === 'string') outlineKeys.add(font + '_path_' + glyph.fontChar)
    }
    const inkCurrent = nativeInkPageCurrent(page, content, viewport, operators, [...outlineKeys])
    if (!inkCurrent) return
    const result: Frame[] = []
    for (const indices of packets(content)) {
      if (indices.some((n) => !selected.has(n))) continue
      const first = content.items[indices[0]] as Item,
        h = first.height,
        ink = indices.map((n) => proof.regions.get(n)!),
        bounds = [
          Math.min(...ink.map((r) => r.x)) * viewport.width,
          Math.min(...ink.map((r) => r.y)) * viewport.height,
          Math.max(...ink.map((r) => r.x + r.width)) * viewport.width,
          Math.max(...ink.map((r) => r.y + r.height)) * viewport.height
        ],
        overlap = (b: number[]): boolean =>
          b[0] < bounds[2] + 1 &&
          b[2] > bounds[0] - 1 &&
          b[1] < bounds[3] + 1 &&
          b[3] > bounds[1] - 1
      if (
        paints.some((p) => overlap(p.bounds)) ||
        annotations.some(
          (a) =>
            !Array.isArray(a.rect) ||
            a.rect.length !== 4 ||
            !a.rect.every(Number.isFinite) ||
            overlap([
              a.rect[0],
              viewport.height - a.rect[3],
              a.rect[2],
              viewport.height - a.rect[1]
            ])
        ) ||
        content.items.some((i, n) => {
          if (!('str' in i) || !i.str.trim() || indices.includes(n)) return false
          const r = allInk.get(n)!
          return (
            overlap([
              r.x * viewport.width,
              r.y * viewport.height,
              (r.x + r.width) * viewport.width,
              (r.y + r.height) * viewport.height
            ]) ||
            (i.height >= h * 0.85 && Math.abs(i.transform[5] - first.transform[5]) < h * 0.2)
          )
        })
      )
        continue
      const tall: CurvePiece[] = indices.flatMap((n) =>
          (proof.glyphs.get(n) ?? [])
            .filter((g) => g.box[3] - g.box[1] > h * 1.4 && g.box[2] - g.box[0] < h)
            .map((g) => ({ glyph: g, item: content.items[n] as Item }))
        ),
        groups: (typeof tall)[] = []
      for (const g of tall) {
        const group = groups.find((p) => Math.abs(p[0].glyph.box[0] - g.glyph.box[0]) < h * 0.05)
        if (group) group.push(g)
        else groups.push([g])
      }
      const profiles = groups
          .filter((g) => g.length <= 2)
          .flatMap((g) => {
            const p = edgeProfile(g, viewport.height)
            return p ? [p] : []
          }),
        left = profiles.filter(
          (p) =>
            p.xs[2] < p.xs[0] - 0.3 &&
            p.xs[2] < p.xs[4] - 0.3 &&
            p.box[0] > first.transform[4] + first.width &&
            p.box[0] - first.transform[4] - first.width < h * 2 &&
            viewport.height - first.transform[5] > p.box[1] &&
            viewport.height - first.transform[5] < p.box[3]
        )
      if (left.length !== 1) continue
      const l = left[0],
        right = profiles.filter(
          (r) =>
            r.box[0] > l.box[2] + h * 3 &&
            Math.abs(r.box[1] - l.box[1]) < h * 0.05 &&
            Math.abs(r.box[3] - l.box[3]) < h * 0.05 &&
            r.xs.every((x, n) => Math.abs(x + l.xs[n] - 1) < 0.05)
        )
      if (right.length !== 1) continue
      const r = right[0]
      if (
        l.box[3] - l.box[1] < h * 2 ||
        l.box[3] - l.box[1] > h * 4 ||
        !indices.some((n) => {
          const b = proof.regions.get(n)!
          return (
            b.x * viewport.width > l.box[2] &&
            (b.x + b.width) * viewport.width < r.box[0] &&
            b.y * viewport.height > l.box[1] &&
            (b.y + b.height) * viewport.height < l.box[3]
          )
        })
      )
        continue
      result.push({
        indices,
        signature: JSON.stringify([
          viewport.width,
          viewport.height,
          viewport.transform,
          indices.map((n) => proof.signatures.get(n))
        ])
      })
    }
    if (
      !result.length ||
      !proof.current() ||
      !inkCurrent() ||
      page.getAnnotations !== annotationReader ||
      annotationKey !== JSON.stringify(await page.getAnnotations({ intent: 'display' }))
    )
      return
    const frozen = Object.freeze(result)
    frames.set(proof.regions, frozen)
    annotationsByFrame.set(frozen, { page, key: annotationKey })
    current.set(
      frozen,
      () =>
        proof.current() &&
        inkCurrent() &&
        page.getAnnotations === annotationReader &&
        annotationKey === JSON.stringify(annotations)
    )
    return proof.regions
  } catch {
    return
  }
}
type Options = Parameters<typeof createAuxiliaryNativeNegativeReader>[0]
export function createNativeFunctionDisplayReader(
  options: Options
): ReturnType<typeof createAuxiliaryNativeNegativeReader> {
  return createAuxiliaryNativeNegativeReader(options, readSelection, (from, to) => {
    const f = frames.get(from)
    if (f) frames.set(to, f)
  })
}
async function observe(
  reader: ReturnType<typeof createNativeFunctionDisplayReader>,
  page: PDFPageProxy,
  content: Content,
  viewport: Viewport,
  pageNumber: number
): Promise<readonly Frame[] | undefined> {
  const selected = new Set(packets(content).flat())
  if (!selected.size) return []
  const identity = await nativeInkPageIdentity(page, content, viewport)
  if (!identity) return
  const direct = await readSelection(
      page,
      content,
      viewport,
      pageNumber,
      selected,
      identity.operators
    ),
    negative = direct
      ? undefined
      : await reader.readNegativeSelection({
          page,
          content,
          viewport,
          pageNumber,
          selected,
          operatorSnapshot: identity.operators
        }),
    f = frames.get(direct ?? negative?.items ?? new Map())
  return f &&
    current.get(f)?.() &&
    identity.key === (await nativeInkPageIdentity(page, content, viewport))?.key
    ? f
    : undefined
}
export async function nativeFunctionDisplayOwners(
  units: PdfTranslationSource['units'],
  page: PDFPageProxy,
  content: Content,
  viewport: Viewport,
  pageNumber: number,
  reader: ReturnType<typeof createNativeFunctionDisplayReader>
): Promise<ReadonlySet<string>> {
  const snapshot = JSON.stringify(units),
    packet = await observe(reader, page, content, viewport, pageNumber),
    result = new Set<string>(),
    counts = new Map<number, number>()
  if (!packet || snapshot !== JSON.stringify(units)) return result
  for (const u of units)
    for (const f of u.fragments)
      if (f.pageNumber === pageNumber)
        for (const i of f.items) counts.set(i.index, (counts.get(i.index) ?? 0) + 1)
  for (const p of packet) {
    const indices = new Set(p.indices),
      owners = units.filter((u) =>
        u.fragments.some(
          (f) => f.pageNumber === pageNumber && f.items.some((i) => indices.has(i.index))
        )
      )
    if (
      p.indices.some((n) => counts.get(n) !== 1) ||
      owners.some(
        (u) =>
          !u.fragments.every(
            (f) =>
              f.pageNumber === pageNumber &&
              f.items.every(
                (i) => indices.has(i.index) && (content.items[i.index] as Item).str === i.text
              )
          ) ||
          u.source.replace(/\s/gu, '') !==
            u.fragments
              .flatMap((f) => f.items.map((i) => i.text))
              .join('')
              .replace(/\s/gu, '') ||
          (u.preserve && !['literal', 'formula'].includes(u.preserve))
      )
    )
      continue
    for (const u of owners) if (!u.sourceOnly && !u.preserve) result.add(u.id)
  }
  return current.get(packet)?.() ? result : new Set<string>()
}
export async function sameNativeFunctionDisplay(
  original: PDFDocumentProxy,
  translated: PDFDocumentProxy,
  pageNumber: number,
  options: { nativeDocumentFactory: typeof getDocument; signal: AbortSignal }
): Promise<boolean> {
  const page = await original.getPage(pageNumber),
    content = await getPdfTranslationTextContent(page)
  if (!hasNativeFunctionDisplay(content) || !packets(content).length) return true
  const readers: ReturnType<typeof createNativeFunctionDisplayReader>[] = []
  try {
    const read = async (
      document: PDFDocumentProxy,
      p: PDFPageProxy,
      c: Content
    ): Promise<readonly Frame[] | undefined> => {
      const data = await document.getData(),
        hash = await crypto.subtle.digest('SHA-256', data.slice().buffer),
        reader = createNativeFunctionDisplayReader({
          ...options,
          document,
          sourceIdentity: {
            sourceChecksum: Array.from(new Uint8Array(hash), (n) =>
              n.toString(16).padStart(2, '0')
            ).join(''),
            sourceSizeBytes: data.length
          }
        })
      readers.push(reader)
      return observe(reader, p, c, p.getViewport({ scale: 1 }), pageNumber)
    }
    const before = await read(original, page, content)
    if (!before?.length) return true
    const target = await translated.getPage(pageNumber),
      after = await read(translated, target, await getPdfTranslationTextContent(target))
    options.signal.throwIfAborted()
    for (const frame of [before, after]) {
      const annotation = frame && annotationsByFrame.get(frame)
      if (
        !annotation ||
        annotation.key !==
          JSON.stringify(await annotation.page.getAnnotations({ intent: 'display' }))
      )
        return false
    }
    return (
      !!after &&
      !!current.get(before)?.() &&
      !!current.get(after)?.() &&
      JSON.stringify(before.map((f) => f.signature)) ===
        JSON.stringify(after.map((f) => f.signature))
    )
  } finally {
    await Promise.all(readers.map((r) => r.dispose()))
  }
}
