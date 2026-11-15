import type { PDFDocumentProxy, PDFPageProxy, getDocument } from 'pdfjs-dist'
import {
  createAuxiliaryNativeNegativeReader,
  nativeInkPageIdentity
} from './auxiliary-native-ink.js'
import { readNativeGlyphSelection } from './native-selected-glyphs.js'
import { nativeOutlineBox } from './native-source-geometry.js'
import { nativeMathAtom } from './native-display-packets.js'
import { getPdfTranslationTextContent } from './text-content.js'
import type { PdfTranslationSource } from './source.js'

type Content = Awaited<ReturnType<PDFPageProxy['getTextContent']>>
type Item = Extract<Content['items'][number], { str: string }>
type Viewport = ReturnType<PDFPageProxy['getViewport']>
type Rect = { page: number; x: number; y: number; width: number; height: number }
type Frame = { indices: number[]; signature: string }
const frames = new WeakMap<ReadonlyMap<number, Rect>, readonly Frame[]>()
const currentFrames = new WeakMap<readonly Frame[], () => boolean>()
const candidateCharacters = [String.fromCharCode(20), String.fromCharCode(21)]

// A cheap candidate gate, never an interpretation of a control character.
export function hasNativeMatrixCandidate(content: Content): boolean {
  return content.items.some((i) => 'str' in i && candidateCharacters.some((c) => i.str.includes(c)))
}

/** The filled orthogonal outline itself, rather than Unicode or a font name,
 * establishes which way a tall square bracket opens. */
function bracketSide(path: ArrayLike<number>): 'left' | 'right' | undefined {
  const contours: number[][][] = []
  let points: number[][] = []
  for (let at = 0; at < path.length;) {
    const op = path[at++]
    if (op === 0 || op === 1) {
      if (at + 1 >= path.length) return
      if (op === 0) {
        if (points.length > 2) return
        points = []
      }
      points.push([path[at++], path[at++]])
    } else if (op === 4) {
      if (
        points.length > 2 &&
        points[0][0] === points.at(-1)![0] &&
        points[0][1] === points.at(-1)![1]
      )
        points.pop()
      contours.push(points)
      points = []
    } else return
  }
  if (points.length || contours.length !== 1) return
  const p = contours[0],
    b = nativeOutlineBox(path)
  if (!b || p.length !== 8 || !p.flat().every(Number.isFinite)) return
  const [l, t, r, d] = b,
    w = r - l,
    h = d - t
  if (h < 0.7 || h > 4 || w < 0.1 || w > 0.6 || h / w < 4) return
  if (
    p.some((q, n) => {
      const z = p[(n + 1) % p.length]
      return (q[0] !== z[0]) === (q[1] !== z[1])
    })
  )
    return
  const xs = [...new Set(p.map((q) => q[0]))].sort((a, b) => a - b),
    ys = [...new Set(p.map((q) => q[1]))].sort((a, b) => a - b)
  if (
    xs.length !== 3 ||
    ys.length !== 4 ||
    (ys[1] - t) / h < 0.005 ||
    (ys[1] - t) / h > 0.08 ||
    (d - ys[2]) / h < 0.005 ||
    (d - ys[2]) / h > 0.08
  )
    return
  const atY = (y: number): number[] =>
    p
      .filter((q) => q[1] === y)
      .map((q) => q[0])
      .sort((a, b) => a - b)
  const outer = [l, r].join(','),
    inner = [xs[1], r].join(','),
    reverse = [l, xs[1]].join(',')
  if (atY(t).join(',') !== outer || atY(d).join(',') !== outer) return
  if (atY(ys[1]).join(',') === inner && atY(ys[2]).join(',') === inner && (xs[1] - l) / w < 0.5)
    return 'left'
  if (atY(ys[1]).join(',') === reverse && atY(ys[2]).join(',') === reverse && (r - xs[1]) / w < 0.5)
    return 'right'
  return
}

function selection(content: Content): Set<number> {
  const brackets = content.items.filter(
      (i): i is Item => 'str' in i && candidateCharacters.some((c) => i.str.includes(c))
    ),
    result = new Set<number>()
  for (const anchor of brackets)
    content.items.forEach((i, n) => {
      if (
        'str' in i &&
        i.str.trim() &&
        i.transform[5] <= anchor.transform[5] + anchor.height * 0.85 &&
        i.transform[5] >= anchor.transform[5] - anchor.height * 3 &&
        i.transform[4] >= Math.min(...brackets.map((b) => b.transform[4])) - anchor.height * 0.1 &&
        i.transform[4] + i.width <=
          Math.max(...brackets.map((b) => b.transform[4] + b.width)) + anchor.height * 0.1
      )
        result.add(n)
    })
  return result
}

async function readMatrixSelection(
  page: PDFPageProxy,
  content: Content,
  viewport: Viewport,
  pageNumber: number,
  selected: ReadonlySet<number>,
  snapshot?: Awaited<ReturnType<PDFPageProxy['getOperatorList']>>
): Promise<Map<number, Rect> | undefined> {
  try {
    const observed = await readNativeGlyphSelection(
      page,
      content,
      viewport,
      pageNumber,
      selected,
      snapshot
    )
    if (!observed) return
    const { regions: result, signatures, current } = observed,
      roles: {
        index: number
        side: string
        x: number
        right: number
        top: number
        bottom: number
        height: number
      }[] = []
    for (const [index, glyphs] of observed.glyphs)
      for (const glyph of glyphs) {
        const side = bracketSide(glyph.path),
          box = glyph.box
        if (side)
          roles.push({
            index,
            side,
            x: box[0],
            right: box[2],
            top: box[1],
            bottom: box[3],
            height: (content.items[index] as Item).height
          })
      }
    const packets: Frame[] = []
    for (const left of roles.filter((r) => r.side === 'left')) {
      const rights = roles
        .filter(
          (r) =>
            r.side === 'right' &&
            r.x > left.right + left.height &&
            Math.abs(r.top - left.top) < left.height * 0.03 &&
            Math.abs(r.bottom - left.bottom) < left.height * 0.03
        )
        .sort((a, b) => a.x - b.x)
      if (!rights.length) continue
      const right = rights[0],
        body = [...selected].filter((n) => {
          const r = result.get(n)!,
            l = r.x * viewport.width,
            t = r.y * viewport.height
          return (
            l >= left.right &&
            (r.x + r.width) * viewport.width <= right.x &&
            t >= left.top &&
            (r.y + r.height) * viewport.height <= left.bottom
          )
        })
      const h = Math.max(...body.map((n) => (content.items[n] as Item).height))
      if (
        body.length < 2 ||
        left.bottom - left.top < h * 1.5 ||
        left.bottom - left.top > h * 4 ||
        body.some((n) => !nativeMathAtom(content.items[n] as Item, h))
      )
        continue
      const base = body.map((n) => content.items[n] as Item).filter((i) => i.height >= h * 0.9),
        ys: number[] = []
      for (const i of base)
        if (!ys.some((y) => Math.abs(y - i.transform[5]) < h * 0.1)) ys.push(i.transform[5])
      if (ys.length !== 2 || Math.abs(ys[0] - ys[1]) < h * 0.7 || Math.abs(ys[0] - ys[1]) > h * 1.8)
        continue
      const indices = [...new Set([left.index, ...body, right.index])].sort((a, b) => a - b),
        signature = JSON.stringify([
          left.x,
          left.top,
          right.right,
          right.bottom,
          body
            .sort((a, b) => {
              const x = content.items[a] as Item,
                y = content.items[b] as Item
              return y.transform[5] - x.transform[5] || x.transform[4] - y.transform[4]
            })
            .map((n) => signatures.get(n))
        ])
      packets.push({ indices, signature })
    }
    if (!packets.length || !current()) return
    const frozen = Object.freeze(packets)
    currentFrames.set(frozen, current)
    frames.set(result, frozen)
    return result
  } catch {
    return
  }
}

type Options = Parameters<typeof createAuxiliaryNativeNegativeReader>[0]
export function createNativeMatrixReader(
  options: Options
): ReturnType<typeof createAuxiliaryNativeNegativeReader> {
  return createAuxiliaryNativeNegativeReader(options, readMatrixSelection, (from, to) => {
    const packet = frames.get(from)
    if (packet) frames.set(to, packet)
  })
}

async function observe(
  reader: ReturnType<typeof createNativeMatrixReader>,
  page: PDFPageProxy,
  content: Content,
  viewport: Viewport,
  pageNumber: number
): Promise<readonly Frame[] | undefined> {
  const selected = selection(content)
  if (!selected.size) return []
  const identity = await nativeInkPageIdentity(page, content, viewport)
  if (!identity) return
  const direct = await readMatrixSelection(
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
    packet = direct ? frames.get(direct) : negative && frames.get(negative.items)
  if (
    !packet ||
    identity.key !== (await nativeInkPageIdentity(page, content, viewport))?.key ||
    !currentFrames.get(packet)?.()
  )
    return
  return packet
}

export async function nativeMatrixOwners(
  units: PdfTranslationSource['units'],
  page: PDFPageProxy,
  content: Content,
  viewport: Viewport,
  pageNumber: number,
  reader: ReturnType<typeof createNativeMatrixReader>
): Promise<ReadonlySet<string>> {
  const snapshot = JSON.stringify(units),
    packet = await observe(reader, page, content, viewport, pageNumber),
    result = new Set<string>()
  if (!packet || snapshot !== JSON.stringify(units)) return result
  const counts = new Map<number, number>()
  for (const unit of units)
    for (const f of unit.fragments)
      if (f.pageNumber === pageNumber)
        for (const item of f.items) counts.set(item.index, (counts.get(item.index) ?? 0) + 1)
  for (const frame of packet) {
    const selected = new Set(frame.indices)
    for (const unit of units) {
      if (
        unit.sourceOnly ||
        unit.preserve ||
        !unit.fragments.length ||
        !unit.fragments.every(
          (f) =>
            f.pageNumber === pageNumber &&
            f.items.every(
              (i) =>
                selected.has(i.index) &&
                counts.get(i.index) === 1 &&
                'str' in content.items[i.index] &&
                (content.items[i.index] as Item).str === i.text
            )
        ) ||
        unit.source.replace(/\s/gu, '') !==
          unit.fragments
            .flatMap((f) => f.items.map((i) => i.text))
            .join('')
            .replace(/\s/gu, '')
      )
        continue
      result.add(unit.id)
    }
  }
  return result
}

/** A mismatch retains the entire original page, never repaints a matrix. */
export async function sameNativeMatrixBody(
  original: PDFDocumentProxy,
  translated: PDFDocumentProxy,
  pageNumber: number,
  options: { nativeDocumentFactory: typeof getDocument; signal: AbortSignal }
): Promise<boolean> {
  const sourcePage = await original.getPage(pageNumber),
    content = await getPdfTranslationTextContent(sourcePage)
  if (!hasNativeMatrixCandidate(content)) return true
  const readers: ReturnType<typeof createNativeMatrixReader>[] = []
  try {
    const read = async (
      document: PDFDocumentProxy,
      page: PDFPageProxy,
      text: Content
    ): Promise<readonly Frame[] | undefined> => {
      const data = await document.getData(),
        hash = await crypto.subtle.digest('SHA-256', data.slice().buffer),
        sourceIdentity = {
          sourceChecksum: Array.from(new Uint8Array(hash), (n) =>
            n.toString(16).padStart(2, '0')
          ).join(''),
          sourceSizeBytes: data.length
        },
        reader = createNativeMatrixReader({ ...options, document, sourceIdentity })
      readers.push(reader)
      return observe(reader, page, text, page.getViewport({ scale: 1 }), pageNumber)
    }
    const before = await read(original, sourcePage, content)
    if (!before?.length) return true
    const outputPage = await translated.getPage(pageNumber),
      after = await read(translated, outputPage, await getPdfTranslationTextContent(outputPage))
    options.signal.throwIfAborted()
    return (
      !!after &&
      !!currentFrames.get(before)?.() &&
      !!currentFrames.get(after)?.() &&
      JSON.stringify(before.map((f) => f.signature)) ===
        JSON.stringify(after.map((f) => f.signature))
    )
  } finally {
    await Promise.all(readers.map((reader) => reader.dispose()))
  }
}
