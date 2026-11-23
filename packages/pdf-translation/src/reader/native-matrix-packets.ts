import type { PDFDocumentProxy, PDFPageProxy, getDocument } from 'pdfjs-dist'
import {
  createAuxiliaryNativeNegativeReader,
  nativeInkPageIdentity
} from './auxiliary-native-ink.js'
import { readNativeGlyphSelection, type NativeSelectedGlyph } from './native-selected-glyphs.js'
import { nativeOutlineBox } from './native-source-geometry.js'
import { nativeMathAtom, nativePaints } from './native-display-packets.js'
import { getPdfTranslationTextContent } from './text-content.js'
import type { PdfTranslationSource } from './source.js'

type Content = Awaited<ReturnType<PDFPageProxy['getTextContent']>>
type Item = Extract<Content['items'][number], { str: string }>
type Viewport = ReturnType<PDFPageProxy['getViewport']>
type Rect = { page: number; x: number; y: number; width: number; height: number }
type MatrixAtom = { origin: number[]; dimensions: number[]; appearance: string }
type Frame = { indices: number[]; bounds: number[]; atoms: MatrixAtom[] }
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
      const indices = [...new Set([left.index, ...body, right.index])].sort((a, b) => a - b)
      body.sort((a, b) => {
        const x = content.items[a] as Item,
          y = content.items[b] as Item
        return y.transform[5] - x.transform[5] || x.transform[4] - y.transform[4]
      })
      const atoms: MatrixAtom[] = []
      for (const n of body) {
        const item = content.items[n] as Item,
          signature = signatures.get(n)
        if (!Array.isArray(signature) || signature.length !== 9) return
        const [scaleX, skewX, skewY, scaleY, x, y] = item.transform
        atoms.push({
          origin: [x, y],
          dimensions: [scaleX, scaleY, item.width],
          appearance: JSON.stringify([signature[0], signature[8], skewX, skewY])
        })
      }
      packets.push({ indices, bounds: [left.x, left.top, right.right, right.bottom], atoms })
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

// A derivative and two repeated column vectors are literal math even when
// their individual letters are left outside the original protected owners.
const derivativePieces = [0, 1, 3, 4, 16, 17]
const derivativeBrackets = [2, 5, 7, 15, 18]

export function hasNativeDerivativeMatrixCandidate(content: Content): boolean {
  return ['d', 'dt', '] ['].every((word) =>
    content.items.some((item) => 'str' in item && item.str === word)
  )
}

async function nativeDerivativeMatrixOwners(
  units: PdfTranslationSource['units'],
  page: PDFPageProxy,
  content: Content,
  viewport: Viewport,
  pageNumber: number
): Promise<ReadonlySet<string>> {
  const result = new Set<string>()
  try {
    if (viewport.scale !== 1 || viewport.rotation !== 0) return result
    const entries = content.items.flatMap((item, index) =>
      'str' in item && item.str.trim() ? [{ item, index }] : []
    )
    const ownership = new Map<number, { owner: (typeof units)[number]; text: string } | null>()
    for (const owner of units)
      for (const f of owner.fragments)
        if (f.pageNumber === pageNumber)
          for (const i of f.items)
            ownership.set(i.index, ownership.has(i.index) ? null : { owner, text: i.text })
    const snapshot = JSON.stringify(units),
      current: (() => boolean)[] = []
    for (const [at, entry] of entries.entries()) {
      if (entry.item.str !== 'd') continue
      const packet = entries.slice(at, at + 21)
      if (packet.length !== 21) continue
      const items = packet.map(({ item }) => item),
        text = items.map(({ str }) => str),
        x = (i: number): number => items[i].transform[4],
        y = (i: number): number => items[i].transform[5],
        right = (i: number): number => x(i) + items[i].width,
        h = items[6].height,
        near = (a: number, b: number): boolean => Math.abs(a - b) < h * 0.05
      if (
        !/^d dt \[ ([a-z]) ([a-z]) \] = \[ 0 1 \/([a-z]) − \3\p{Script=Greek} 2 0 \] \[ \1 \2 \] \. \(([1-9]\d{0,3})\)$/u.test(
          text.join(' ')
        ) ||
        text[3] === text[4] ||
        !items[20].hasEOL ||
        packet.some(
          ({ item }, i) =>
            item.dir !== 'ltr' ||
            item.width <= 0 ||
            item.transform.length !== 6 ||
            ![item.width, item.height, ...item.transform].every(Number.isFinite) ||
            item.transform[0] !== item.height ||
            item.transform[3] !== item.height ||
            item.transform[1] !== 0 ||
            item.transform[2] !== 0 ||
            !near(item.height, i === 13 ? h * 0.7 : h)
        ) ||
        !derivativeBrackets.every(
          (i) => items[i].fontName === items[2].fontName && near(y(i), y(2))
        ) ||
        ![3, 4, 16, 17].every((i) => items[i].fontName === items[0].fontName) ||
        items[0].fontName !== items[1].fontName ||
        items[2].fontName === items[0].fontName ||
        ![8, 9, 10, 16].every((i) => near(y(i), y(3))) ||
        ![11, 12, 14, 17].every((i) => near(y(i), y(4))) ||
        ![19, 20].every((i) => near(y(i), y(6))) ||
        !near((y(3) + y(4)) / 2, y(6)) ||
        y(3) - y(4) < h ||
        y(3) - y(4) > h * 1.4 ||
        y(0) <= y(3) ||
        y(1) >= y(4) ||
        y(13) <= y(4) ||
        !near((x(0) + right(0)) / 2, (x(1) + right(1)) / 2) ||
        right(1) >= x(2) ||
        right(5) >= x(6) ||
        right(6) >= x(7) ||
        right(18) >= x(19) ||
        right(19) + h >= x(20)
      )
        continue
      const selected = new Set(packet.map(({ index }) => index)),
        affected = new Set<string>()
      if (
        packet.some(({ index, item }, i) => {
          const claim = ownership.get(index)
          if (!claim || claim.text !== item.str) return true
          const { owner } = claim
          if (
            !owner.fragments.length ||
            owner.fragments.some(
              (f) =>
                f.pageNumber !== pageNumber || f.items.some((entry) => !selected.has(entry.index))
            ) ||
            owner.source.replace(/\s/gu, '') !==
              owner.fragments
                .flatMap((f) => f.items.map((entry) => entry.text))
                .join('')
                .replace(/\s/gu, '') ||
            (owner.preserve && owner.preserve !== 'formula' && owner.preserve !== 'literal')
          )
            return true
          if (!owner.sourceOnly) {
            if (owner.preserve || !derivativePieces.includes(i)) return true
            affected.add(owner.id)
          }
          return false
        }) ||
        !affected.size
      )
        continue

      // The already-protected coefficient may span several showText operations.
      // Verify whole-page operator identity but select only the brackets and newly
      // protected glyphs for outline reading.
      const scoped = { ...content, items },
        identity = await nativeInkPageIdentity(page, scoped, viewport)
      if (!identity) continue
      const read = await readNativeGlyphSelection(
        page,
        content,
        viewport,
        pageNumber,
        new Set([...derivativeBrackets, ...derivativePieces].map((i) => packet[i].index)),
        identity.operators
      )
      if (!read) continue
      const glyphs = (i: number): readonly NativeSelectedGlyph[] =>
          read.glyphs.get(packet[i].index) ?? [],
        outlines = derivativeBrackets.flatMap(glyphs)
      if (
        outlines.map((glyph) => bracketSide(glyph.path)).join(',') !==
        'left,right,left,right,left,right'
      )
        continue
      const [a, b, c, d, e, f] = outlines.map(({ box }) => box),
        inside = (i: number, l: number[], r: number[]): boolean =>
          glyphs(i).length > 0 &&
          glyphs(i).every(
            ({ box }) => box[0] >= l[2] && box[2] <= r[0] && box[1] >= l[1] && box[3] <= r[3]
          )
      if (
        outlines.length !== 6 ||
        outlines.some(
          ({ box }, i) =>
            !near(box[1], a[1]) ||
            !near(box[3], a[3]) ||
            (i > 0 && outlines[i - 1].box[2] >= box[0])
        ) ||
        !inside(3, a, b) ||
        !inside(4, a, b) ||
        !inside(16, e, f) ||
        !inside(17, e, f) ||
        x(11) < c[2] ||
        right(10) > d[0] + h * 0.03 ||
        !near(b[0] - a[2], f[0] - e[2]) ||
        entries.some(
          ({ index, item }) =>
            !selected.has(index) &&
            item.transform[4] < right(20) &&
            item.transform[4] + item.width > x(1) - h * 0.1 &&
            viewport.height - item.transform[5] + item.height * 0.25 > a[1] &&
            viewport.height - item.transform[5] - item.height * 0.75 < a[3]
        )
      )
        continue
      const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs'),
        paints = await nativePaints(identity.operators, viewport, true)
      if (!paints) continue
      const local = paints.filter(
        ({ bounds: [l, t, r, b] }) =>
          l < right(20) && r > x(1) - h * 0.1 && t < a[3] + h * 0.1 && b > a[1] - h * 0.1
      )
      const rule = local[0]
      if (
        local.length !== 1 ||
        !rule.plainBlack ||
        rule.kind !== OPS.paintSolidColorImageMask ||
        !near(rule.bounds[0], x(1)) ||
        !near(rule.bounds[2], right(1)) ||
        rule.bounds[1] <= Math.max(...glyphs(0).map(({ box }) => box[3])) ||
        rule.bounds[3] >= Math.min(...glyphs(1).map(({ box }) => box[1])) ||
        rule.bounds[3] - rule.bounds[1] > h * 0.1 ||
        identity.key !== (await nativeInkPageIdentity(page, scoped, viewport))?.key ||
        snapshot !== JSON.stringify(units) ||
        !read.current()
      )
        continue
      for (const id of affected) result.add(id)
      current.push(read.current)
    }
    return snapshot === JSON.stringify(units) && current.every((verify) => verify())
      ? result
      : new Set()
  } catch {
    return new Set()
  }
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
    result = new Set(
      hasNativeDerivativeMatrixCandidate(content)
        ? await nativeDerivativeMatrixOwners(units, page, content, viewport, pageNumber)
        : []
    ),
    packet = hasNativeMatrixCandidate(content)
      ? await observe(reader, page, content, viewport, pageNumber)
      : []
  if (snapshot !== JSON.stringify(units)) return new Set()
  if (!packet) return result
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

// The native writer can round page coordinates when serializing unchanged text.
// Compare positions within one hundredth of a point and keep glyph outlines and offsets exact.
function sameMatrixFrame(before: Frame, after: Frame): boolean {
  const near = (a: number[], b: number[], tolerance: number): boolean =>
    a.length === b.length && a.every((value, i) => Math.abs(value - b[i]) <= tolerance)
  return (
    near(before.bounds, after.bounds, 0.01) &&
    before.atoms.length === after.atoms.length &&
    before.atoms.every((atom, i) => {
      const written = after.atoms[i]
      return (
        atom.appearance === written.appearance &&
        near(atom.origin, written.origin, 0.01) &&
        near(atom.dimensions, written.dimensions, 0.00001)
      )
    })
  )
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
      before.length === after.length &&
      before.every((frame, i) => sameMatrixFrame(frame, after[i]))
    )
  } finally {
    await Promise.all(readers.map((reader) => reader.dispose()))
  }
}
