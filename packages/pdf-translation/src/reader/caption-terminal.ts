import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type { PdfLayoutPage } from './layout.js'

type Content = Awaited<ReturnType<PDFPageProxy['getTextContent']>>
type Context = {
  document: Pick<PDFDocumentProxy, 'fingerprints' | 'numPages'>
  page: PDFPageProxy
  content: Content
  rawPage: PdfLayoutPage
  signal: AbortSignal
}
type Glyph = {
  text: string
  x: number
  y: number
  width: number
  font: string
  size: number
  show: number
}
type Program = {
  begin: number
  end?: number
  glyphs: Glyph[]
  font?: string
  size?: number
  x: number
  y: number
  positioned: boolean
  leading: number
  shown: boolean
}
type Proof = { indices: readonly number[]; tailIndex: number; current: () => boolean }
const proofs = new WeakMap<PdfLayoutPage, Proof>()

// Source grouping evidence only; never crop, glyph erasure or repaint authority.
const norm = (s: string): string => s.replace(/\s/gu, '')
const finite = (a: readonly number[] | undefined, n: number): a is number[] =>
  a?.length === n && Array.from(a).every(Number.isFinite)
const close = (a: number, b: number, tolerance = 0.001): boolean => Math.abs(a - b) <= tolerance
const identity = (m: number[]): boolean =>
  finite(m, 6) && m.every((v, i) => close(v, [1, 0, 0, 1, 0, 0][i], 1e-8))
const stamp = (v: unknown): string | undefined => JSON.stringify(v)
const boundedContent = (content: Content): boolean =>
  content.items.length <= 10000 &&
  content.items.reduce((n, i) => n + ('str' in i ? i.str.length : 0), 0) <= 65536 &&
  Object.keys(content.styles).length <= 128 &&
  Object.values(content.styles).every(
    (style) => !style.fontFamily || style.fontFamily.length <= 512
  )

/** Exact current RAW association to one closed, simple, horizontal caption BT. */
async function prove({
  document,
  page,
  content,
  rawPage,
  signal
}: Context): Promise<Proof | undefined> {
  const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  signal.throwIfAborted()
  if (
    rawPage.page !== page.pageNumber ||
    page.rotate !== 0 ||
    page.view[0] !== 0 ||
    page.view[1] !== 0 ||
    page.view[2] !== rawPage.width ||
    page.view[3] !== rawPage.height ||
    !boundedContent(content)
  )
    return
  const canonical = await page.getTextContent()
  signal.throwIfAborted()
  // RAW spaces are semantic too. Glyph normalization cannot authenticate a
  // forged literal such as “Pan els” when the actual native reader says “Panels”.
  if (!boundedContent(canonical) || stamp(canonical) !== stamp(content)) return
  const ops = await page.getOperatorList()
  signal.throwIfAborted()
  if (
    rawPage.rotation !== 0 ||
    rawPage.width <= 0 ||
    rawPage.height <= 0 ||
    ops.fnArray.length !== ops.argsArray.length ||
    ops.fnArray.length > 10000 ||
    content.items.length !== rawPage.items.length ||
    content.items.length > 10000
  )
    return
  const entries = content.items.flatMap((item, index) =>
    'str' in item && item.str.trim() ? [{ item, index }] : []
  )
  const tails = entries.filter((e) => /^\([a-z]\)\.$/u.test(e.item.str))
  if (tails.length !== 1) return
  const tail = tails[0],
    prefixes = entries.filter(
      (e) => e.index < tail.index && /^(?:Figure|Fig\.)\s*[1-9]\d*[.:](?:\s|$)/iu.test(e.item.str)
    )
  if (prefixes.length !== 1) return
  const prefix = prefixes[0],
    selected = entries.filter((e) => e.index >= prefix.index && e.index <= tail.index)
  const before = selected
      .slice(0, -1)
      .map((e) => e.item.str)
      .join(' '),
    marker = tail.item.str.slice(0, 3)
  if (
    selected.length < 4 ||
    !/\b(?:in|on)$/u.test(before) ||
    !before.includes(marker) ||
    new Set([...before.matchAll(/\([a-z]\)/gu)].map((m) => m[0])).size < 2
  )
    return
  const first = prefix.item,
    font = page.commonObjs?.get(first.fontName),
    size = first.height
  if (
    !font ||
    font.missingFile !== false ||
    font.isType3Font !== false ||
    font.isInvalidPDFjsFont !== false ||
    font.systemFontInfo !== null ||
    font.vertical !== false ||
    stamp(font.fontMatrix) !== stamp([0.001, 0, 0, 0.001, 0, 0])
  )
    return
  const style = content.styles[first.fontName]
  if (
    !style ||
    style.vertical !== false ||
    !finite([style.ascent, style.descent], 2) ||
    style.ascent <= 0 ||
    style.descent > 0 ||
    style.ascent !== font.ascent ||
    style.descent !== font.descent
  )
    return
  for (const { item, index } of selected) {
    const raw = rawPage.items[index]
    if (
      !finite(item.transform, 6) ||
      item.dir !== 'ltr' ||
      item.fontName !== first.fontName ||
      !close(item.height, size, 1e-8) ||
      !close(item.transform[0], size, 1e-8) ||
      !close(item.transform[3], size, 1e-8) ||
      item.transform[1] !== 0 ||
      item.transform[2] !== 0 ||
      item.width <= 0 ||
      !raw ||
      raw.str !== item.str ||
      raw.fontName !== item.fontName ||
      stamp(raw.transform) !==
        stamp([
          item.transform[0],
          -item.transform[1],
          item.transform[2],
          item.transform[3],
          item.transform[4],
          rawPage.height - (rawPage.height - item.transform[5])
        ]) ||
      raw.width !== item.width ||
      raw.height !== item.height ||
      raw.hasEOL !== item.hasEOL ||
      raw.fontAscent !== style.ascent ||
      raw.fontDescent !== style.descent ||
      raw.fontVertical !== false
    )
      return
  }
  // Only a finite simple text-program vocabulary. Unknown paint/state or a clip/Form rejects.
  const programs: Program[] = [],
    stack: number[][] = []
  let matrix = [1, 0, 0, 1, 0, 0],
    current: Program | undefined
  let glyphCount = 0
  const reject = (): undefined => undefined
  for (let i = 0; i < ops.fnArray.length; i++) {
    const op = ops.fnArray[i],
      a = ops.argsArray[i]
    if (op === OPS.beginText) {
      if (current || !identity(matrix)) return reject()
      current = {
        begin: i,
        glyphs: [],
        font: undefined,
        size: undefined,
        x: 0,
        y: 0,
        positioned: false,
        leading: 0,
        shown: false
      }
      programs.push(current)
      continue
    }
    if (op === OPS.endText) {
      if (!current) return reject()
      current.end = i
      current = undefined
      continue
    }
    if (op === OPS.dependency) {
      if (
        !Array.isArray(a) ||
        a.length > 128 ||
        a.some((v) => typeof v !== 'string' || v.length > 128)
      )
        return
      continue
    }
    if (current) {
      if (op === OPS.setFillRGBColor) {
        if (a?.[0] !== '#000000') return reject()
      } else if (op === OPS.setFont) {
        if (
          typeof a?.[0] !== 'string' ||
          a[0].length > 128 ||
          !(a[1] > 0) ||
          a[1] > 72 ||
          !Number.isFinite(a[1]) ||
          (current.font && (current.font !== a[0] || current.size !== a[1]))
        )
          return reject()
        current.font = a[0]
        current.size = a[1]
      } else if (op === OPS.setLeading) {
        if (!finite(a, 1) || !(a[0] > 0)) return reject()
        current.leading = a[0]
      } else if (op === OPS.setTextMatrix) {
        const m = a?.length === 1 ? Array.from(a[0]) : a
        if (current.positioned || !finite(m, 6) || !identity([...m.slice(0, 4), 0, 0]))
          return reject()
        current.x = m[4]
        current.y = m[5]
        current.positioned = true
      } else if (op === OPS.moveText) {
        if (!finite(a, 2) || (current.positioned && (a[0] !== 0 || !(a[1] < 0)))) return reject()
        current.x += a[0]
        current.y += a[1]
        current.positioned = true
        current.shown = false
      } else if (op === OPS.nextLine) {
        if (!current.positioned || !current.leading) return reject()
        current.y -= current.leading
        current.shown = false
      } else if (op === OPS.showText) {
        if (
          current.shown ||
          !current.positioned ||
          !current.font ||
          !current.size ||
          !Array.isArray(a?.[0])
        )
          return reject()
        current.shown = true
        let x = current.x
        for (const glyph of a[0]) {
          if (++glyphCount > 16384) return
          if (typeof glyph === 'number') {
            if (!Number.isFinite(glyph)) return reject()
            x -= (glyph * current.size) / 1000
            continue
          }
          if (
            typeof glyph?.unicode !== 'string' ||
            !glyph.unicode ||
            glyph.unicode.length > 8 ||
            !Number.isFinite(glyph.width) ||
            glyph.width < 0 ||
            glyph.accent !== null ||
            glyph.vmetric !== undefined ||
            glyph.operatorListId !== undefined ||
            (norm(glyph.unicode) && glyph.isInFont !== true)
          )
            return reject()
          const width = (glyph.width * current.size) / 1000
          if (norm(glyph.unicode))
            current.glyphs.push({
              text: norm(glyph.unicode),
              x,
              y: current.y,
              width,
              font: current.font,
              size: current.size,
              show: i
            })
          x += width
        }
      } else return reject()
    } else if (op === OPS.save) stack.push([...matrix])
    else if (op === OPS.restore) {
      if (!stack.length) return reject()
      matrix = stack.pop()!
    } else if (op === OPS.transform) {
      if (!finite(a, 6) || a[1] !== 0 || a[2] !== 0 || !(a[0] > 0) || !(a[3] > 0)) return reject()
      matrix = [
        matrix[0] * a[0],
        0,
        0,
        matrix[3] * a[3],
        matrix[0] * a[4] + matrix[4],
        matrix[3] * a[5] + matrix[5]
      ]
    } else if (op === OPS.setGState) {
      if (!Array.isArray(a?.[0]) || a[0].some((v) => v[0] !== 'SMask' || v[1] !== false))
        return reject()
    } else if (op === OPS.paintImageXObject) {
      // Never snapshot or copy an image payload; only the canonical XObject ID.
      if (
        a?.length !== 3 ||
        typeof a[0] !== 'string' ||
        a[0].length > 128 ||
        !Number.isSafeInteger(a[1]) ||
        !Number.isSafeInteger(a[2]) ||
        a[1] <= 0 ||
        a[2] <= 0
      )
        return
    } else return reject()
  }
  if (current || stack.length || !identity(matrix)) return
  const text = norm(selected.map((e) => e.item.str).join(''))
  const matching = programs.filter(
    (p) => p.end !== undefined && p.glyphs.map((g) => g.text).join('') === text
  )
  if (matching.length !== 1) return
  const program = matching[0]
  let at = 0
  for (const { item } of selected) {
    const start = at,
      expected = norm(item.str)
    let actual = ''
    while (at < program.glyphs.length && actual.length < expected.length)
      actual += program.glyphs[at++].text
    if (actual !== expected) return
    const glyphs = program.glyphs.slice(start, at),
      a = glyphs[0],
      b = glyphs.at(-1)!
    if (
      glyphs.some(
        (g) => g.font !== item.fontName || g.size !== size || !close(g.y, item.transform[5])
      ) ||
      !close(a.x, item.transform[4]) ||
      !close(b.x + b.width - a.x, item.width)
    )
      return
  }
  if (at !== program.glyphs.length) return
  const rows: (typeof selected)[] = []
  for (const e of selected) {
    if (!rows.length || !close(rows.at(-1)![0].item.transform[5], e.item.transform[5]))
      rows.push([])
    rows.at(-1)!.push(e)
  }
  if (rows.length < 3 || rows.at(-1)!.length !== 1) return
  const leads = rows.slice(1).map((r, i) => rows[i][0].item.transform[5] - r[0].item.transform[5])
  if (
    leads.some((v) => v <= size * 0.75 || v >= size * 1.7 || !close(v, leads[0], 0.01)) ||
    rows.some((r) => !close(r[0].item.transform[4], first.transform[4], size * 0.05))
  )
    return
  const previous = rows.at(-2)!,
    previousItem = previous.at(-1)!
  if (
    selected.at(-2) !== previousItem ||
    !/\bin$/u.test(previousItem.item.str) ||
    !previousItem.item.hasEOL ||
    rows.slice(0, -1).some((r) => r.at(-1)!.item.hasEOL !== true)
  )
    return
  const rawData = (): unknown => [
    rawPage.page,
    rawPage.width,
    rawPage.height,
    rawPage.rotation,
    rawPage.items
  ]
  const rawItems = rawPage.items,
    originalItems = content.items,
    styleObject = content.styles,
    fn = ops.fnArray,
    args = ops.argsArray,
    fingerprint = document.fingerprints[0],
    count = document.numPages,
    pageNumber = page.pageNumber,
    getOps = page.getOperatorList,
    getText = page.getTextContent,
    snapshot = stamp([rawData(), content, ops]),
    fontState = stamp([font.fontMatrix, font.ascent, font.descent])
  const currentProof = (): boolean => {
    try {
      return (
        rawPage.items === rawItems &&
        content.items === originalItems &&
        content.styles === styleObject &&
        ops.fnArray === fn &&
        ops.argsArray === args &&
        document.fingerprints[0] === fingerprint &&
        document.numPages === count &&
        page.pageNumber === pageNumber &&
        page.getOperatorList === getOps &&
        page.getTextContent === getText &&
        page.commonObjs.get(first.fontName) === font &&
        font.missingFile === false &&
        font.isType3Font === false &&
        font.vertical === false &&
        font.isInvalidPDFjsFont === false &&
        font.systemFontInfo === null &&
        stamp([rawData(), content, ops]) === snapshot &&
        stamp([font.fontMatrix, font.ascent, font.descent]) === fontState
      )
    } catch {
      return false
    }
  }
  return Object.freeze({
    page: rawPage.page,
    prefixIndex: prefix.index,
    previousIndex: previousItem.index,
    tailIndex: tail.index,
    indices: Object.freeze(selected.map((e) => e.index)),
    source: selected.map((e) => e.item.str).join(' '),
    program: Object.freeze({ begin: program.begin, end: program.end }),
    current: currentProof
  })
}

/** Only this native reader can register a proof; no external proof/flag setter. */
export async function rememberNativeCaptionTerminal(
  context: Context
): Promise<(() => boolean) | undefined> {
  context.signal.throwIfAborted()
  // Avoid another native read unless a complete terminal marker is present.
  if (!context.content.items.some((i) => 'str' in i && /^\([a-z]\)\.$/u.test(i.str))) return
  try {
    const proof = await prove(context)
    context.signal.throwIfAborted()
    if (proof?.current()) {
      proofs.set(context.rawPage, proof)
      return proof.current
    }
  } catch {
    context.signal.throwIfAborted()
    // Unsupported fonts/operators decline this narrow join, not extraction.
  }
}

export function isNativeCaptionTerminal(
  page: PdfLayoutPage,
  prefix: readonly number[],
  tail: number
): boolean {
  const proof = proofs.get(page)
  return (
    !!proof &&
    proof.current() &&
    proof.tailIndex === tail &&
    prefix.length === proof.indices.length - 1 &&
    prefix.every((v, i) => v === proof.indices[i])
  )
}
