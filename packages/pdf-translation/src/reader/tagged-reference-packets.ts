import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { nativeInkPageCurrent } from './auxiliary-native-ink.js'
import { nativeReferenceFontWitnesses } from './native-reference-evidence.js'
import { nativeOutlineBox } from './native-source-geometry.js'
import type { PdfLayoutPage } from './layout.js'
import type { PdfTranslationSource } from './source.js'

type Content = Awaited<ReturnType<PDFPageProxy['getTextContent']>>
type Viewport = ReturnType<PDFPageProxy['getViewport']>
type Operators = Awaited<ReturnType<PDFPageProxy['getOperatorList']>>
type Unit = PdfTranslationSource['units'][number]
type Box = [number, number, number, number]
type Glyph = {
  unicode: string
  font: string
  mcid: number
  transform: number[]
  advance: Box
  ink?: Box
}
type NativeItem = { index: number; ink: Box; glyphs: Glyph[]; mcids: number[] }
type Program = { items: NativeItem[]; glyphs: Glyph[] }
type Input = {
  page: PDFPageProxy
  content: Content
  viewport: Viewport
  rawPage: PdfLayoutPage
  unreliable: Set<number>
}
type Frame = Input & { current: () => boolean; program: Program; selected: Set<number> }
type Document = Pick<PDFDocumentProxy, 'numPages' | 'fingerprints' | 'getPage'>
const nativeSetSize = Object.getOwnPropertyDescriptor(Set.prototype, 'size')!.get!
const nativeSetHas = Set.prototype.has
const nativeSetValues = Set.prototype.values
const literalUrl = (s: string): boolean => /^https?:\/\/\S+$/u.test(s)
const heading = (s: string): boolean => /^(?:References|Bibliography)$/u.test(s)
// Comparison only, as in nativeAlgorithmInkRegions. Never replaces Source or glyphs.
const letters = (s: string): string[] =>
  Array.from(s.normalize('NFD')).filter((c) => !/\s/u.test(c))
const finite = (a: ArrayLike<number> | undefined, n: number): boolean =>
  !!a && a.length === n && Array.from(a).every(Number.isFinite)
const union = (bs: Box[]): Box => [
  Math.min(...bs.map((b) => b[0])),
  Math.min(...bs.map((b) => b[1])),
  Math.max(...bs.map((b) => b[2])),
  Math.max(...bs.map((b) => b[3]))
]
const intersects = (a: Box, b: Box): boolean =>
  a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
const inside = (a: Box, b: Box): boolean =>
  a[0] >= b[0] && a[1] >= b[1] && a[2] <= b[2] && a[3] <= b[3]

/** A bounded data-only reference and value watch, not a serialized authority. */
function watch(value: unknown): () => boolean {
  const slots: [object, string | symbol, PropertyDescriptor][] = [],
    seen = new Set<object>(),
    objects: { value: object; keys: (string | symbol)[]; prototype: object | null }[] = []
  function visit(v: unknown): void {
    if (!v || typeof v !== 'object' || seen.has(v)) return
    seen.add(v)
    if (seen.size > 100000) throw Error('Native reference budget')
    const keys = Reflect.ownKeys(v)
    objects.push({ value: v, keys, prototype: Object.getPrototypeOf(v) })
    for (const key of keys) {
      const d = Object.getOwnPropertyDescriptor(v, key)
      if (!d || !('value' in d)) throw Error('Native accessor')
      slots.push([v, key, d])
      visit(d.value)
    }
  }
  visit(value)
  return () =>
    objects.every(({ value, keys, prototype }) => {
      const now = Reflect.ownKeys(value)
      return (
        Object.getPrototypeOf(value) === prototype &&
        now.length === keys.length &&
        now.every((key, i) => key === keys[i])
      )
    }) &&
    slots.every(([o, k, d]) => {
      const now = Object.getOwnPropertyDescriptor(o, k)
      return (
        !!now &&
        ['value', 'get', 'set', 'writable', 'enumerable', 'configurable'].every(
          (key) => now[key as keyof PropertyDescriptor] === d[key as keyof PropertyDescriptor]
        )
      )
    })
}

function outlineKeys(ops: Operators): string[] | undefined {
  if (ops.fnArray.length > 100000 || ops.fnArray.length !== ops.argsArray.length) return
  let font = ''
  const keys = new Set<string>()
  for (let i = 0; i < ops.fnArray.length; i++) {
    const a = ops.argsArray[i]
    if (ops.fnArray[i] === OPS.setFont) font = a?.[0]
    if (ops.fnArray[i] === OPS.showText) {
      if (!Array.isArray(a?.[0])) return
      for (const g of a[0])
        if (g && typeof g === 'object' && g.isInFont === true) {
          keys.add(font + '_path_' + g.fontChar)
          if (keys.size > 10000) return
        }
    }
  }
  return [...keys]
}

/** A separate visible-PDF.js contract. It does not infer unexposed BDC dictionary
 * fields or auxiliary ActualText. Every accepted operator is interpreted, including
 * exact clips, MCID nesting, opacity and the renderer's nonpainting space advance. */
function program(
  page: PDFPageProxy,
  content: Content,
  viewport: Viewport,
  ops: Operators,
  selected: Set<number>
): Program | undefined {
  if (
    !finite(viewport.transform, 6) ||
    viewport.transform.some((n, i) => n !== [1, 0, 0, -1, 0, viewport.height][i]) ||
    viewport.scale !== 1 ||
    viewport.rotation !== 0 ||
    content.items.length > 10000 ||
    ops.fnArray.length > 100000 ||
    ops.fnArray.length !== ops.argsArray.length
  )
    return
  type State = { font: string; size: number; spacing: number; clip?: Box }
  type Span = { mcid: number; indices: Set<number> }
  let state: State = { font: '', size: 0, spacing: 0 },
    matrix = [1, 0, 0, 1, 0, 0],
    x = 0,
    text = false,
    pending = false,
    shows = 0,
    outlineBytes = 0
  const saves: State[] = [],
    marks: Span[] = [],
    spans: Span[] = [],
    mcids = new Set<number>(),
    glyphs: Glyph[] = [],
    chars: { char: string; glyph: Glyph }[] = [],
    paths = new Set<string>()
  for (let at = 0; at < ops.fnArray.length; at++) {
    const op = ops.fnArray[at],
      a = ops.argsArray[at]
    if (op === OPS.beginMarkedContentProps) {
      if (
        text ||
        pending ||
        marks.length ||
        !Array.isArray(a) ||
        a.length !== 2 ||
        a[0] !== 'Span' ||
        !Number.isSafeInteger(a[1]) ||
        a[1] < 0 ||
        mcids.has(a[1])
      )
        return
      mcids.add(a[1])
      const s: Span = { mcid: a[1], indices: new Set() }
      spans.push(s)
      marks.push(s)
    } else if (op === OPS.endMarkedContent) {
      if (text || pending || marks.length !== 1 || a !== null) return
      marks.pop()
    } else if (op === OPS.save) {
      if (text || pending) return
      saves.push({ ...state })
    } else if (op === OPS.restore) {
      if (text || pending || !saves.length) return
      state = saves.pop()!
    } else if (op === OPS.eoClip) {
      if (text || pending || !saves.length) return
      pending = true
    } else if (op === OPS.constructPath) {
      const p = a?.[1]?.[0],
        b = a?.[2]
      if (
        !pending ||
        a?.[0] !== OPS.endPath ||
        a[1].length !== 1 ||
        !(p instanceof Float32Array) ||
        !finite(p, 13) ||
        !finite(b, 4) ||
        p[0] !== 0 ||
        p[3] !== 1 ||
        p[6] !== 1 ||
        p[9] !== 1 ||
        p[12] !== 4 ||
        p[1] !== p[10] ||
        p[2] !== p[5] ||
        p[4] !== p[7] ||
        p[8] !== p[11]
      )
        return
      const b0: Box = [
        Math.min(p[1], p[4]),
        Math.min(p[2], p[8]),
        Math.max(p[1], p[4]),
        Math.max(p[2], p[8])
      ]
      if (!(b0[0] < b0[2] && b0[1] < b0[3]) || b0.some((n, i) => n !== b[i])) return
      state.clip = state.clip
        ? [
            Math.max(b0[0], state.clip[0]),
            Math.max(b0[1], state.clip[1]),
            Math.min(b0[2], state.clip[2]),
            Math.min(b0[3], state.clip[3])
          ]
        : b0
      pending = false
    } else if (op === OPS.beginText) {
      if (text || pending || !marks.length || !state.clip) return
      text = true
      matrix = [1, 0, 0, 1, 0, 0]
      x = 0
      shows = 0
    } else if (op === OPS.endText) {
      if (!text || shows < 1) return
      text = false
    } else if (op === OPS.setFont) {
      if (!text || typeof a?.[0] !== 'string' || !Number.isFinite(a[1]) || a[1] <= 0) return
      state.font = a[0]
      state.size = a[1]
    } else if (op === OPS.setTextMatrix) {
      const m = a?.length === 1 ? a[0] : a
      if (!text || !finite(m, 6) || m[0] !== 1 || m[1] !== 0 || m[2] !== 0 || m[3] !== 1) return
      matrix = Array.from(m)
      x = 0
    } else if (op === OPS.setCharSpacing) {
      if (!finite(a, 1)) return
      state.spacing = a[0]
    } else if (op === OPS.setFillRGBColor || op === OPS.setStrokeRGBColor) {
      if (a?.length !== 1 || a[0] !== '#000000') return
    } else if (op === OPS.setGState) {
      if (!Array.isArray(a?.[0])) return
      for (const pair of a[0])
        if (!(
          Array.isArray(pair) &&
          pair.length === 2 &&
          ((pair[0] === 'BM' && pair[1] === 'source-over') ||
            (['ca', 'CA'].includes(pair[0]) && pair[1] === 1))
        ))
          return
    } else if (op === OPS.dependency) {
      if (!Array.isArray(a) || a.some((s) => typeof s !== 'string')) return
    } else if (op === OPS.showText) {
      if (
        !text ||
        !Array.isArray(a?.[0]) ||
        !state.font ||
        !state.size ||
        !state.clip ||
        marks.length !== 1
      )
        return
      shows++
      const font = page.commonObjs.get(state.font)
      if (
        font?.loadedName !== state.font ||
        font.missingFile !== false ||
        font.vertical !== false ||
        font.isType3Font !== false ||
        font.isInvalidPDFjsFont !== false ||
        font.remeasure ||
        !finite(font.fontMatrix, 6) ||
        font.fontMatrix.some((n: number, i: number) => n !== [0.001, 0, 0, 0.001, 0, 0][i])
      )
        return
      for (const g of a[0]) {
        if (typeof g === 'number') {
          if (!Number.isFinite(g)) return
          x -= (g * state.size) / 1000
          continue
        }
        if (
          typeof g?.unicode !== 'string' ||
          typeof g.fontChar !== 'string' ||
          !g.fontChar ||
          !Number.isFinite(g.width) ||
          g.width < 0 ||
          g.accent != null ||
          g.vmetric != null ||
          g.operatorListId != null ||
          glyphs.length >= 100000
        )
          return
        const transform = [state.size, 0, 0, state.size, matrix[4] + x, matrix[5]],
          width = (g.width * state.size) / 1000,
          record: Glyph = {
            font: state.font,
            unicode: g.unicode,
            transform,
            advance: [transform[4], transform[5], transform[4] + width, transform[5] + state.size],
            mcid: marks[0].mcid
          }
        if (g.isInFont !== true) {
          // Same nonpainting condition as PDF.js showText, with all original advance retained.
          if (g.isInFont !== false || g.unicode !== ' ' || g.width <= 0) return
        } else {
          const key = state.font + '_path_' + g.fontChar
          if (!page.commonObjs.has(key)) return
          const p = page.commonObjs.get(key)?.path
          if (!paths.has(key)) {
            if (
              !ArrayBuffer.isView(p) ||
              !(p.buffer instanceof ArrayBuffer) ||
              (outlineBytes += p.byteLength) > 16 * 1024 * 1024 ||
              paths.size >= 10000
            )
              return
            paths.add(key)
          }
          const b = nativeOutlineBox(p)
          if (!b) return
          const ink: Box = [
            transform[4] + b[0] * state.size,
            transform[5] + b[1] * state.size,
            transform[4] + b[2] * state.size,
            transform[5] + b[3] * state.size
          ]
          if (
            !ink.every(Number.isFinite) ||
            !inside(ink, state.clip) ||
            !inside(ink, [0, 0, viewport.width, viewport.height])
          )
            return
          record.ink = ink
          const cs = letters(g.unicode)
          if (!cs.length) return
          for (const char of cs) chars.push({ char, glyph: record })
        }
        glyphs.push(record)
        x += width + state.spacing
        if (!Number.isFinite(x)) return
      }
    } else return
  }
  if (text || pending || marks.length || saves.length || !spans.length) return
  let offset = 0
  const items: NativeItem[] = []
  for (const [index, item] of content.items.entries()) {
    if (!('str' in item) || !item.str.trim()) continue
    const cs = letters(item.str),
      part = chars.slice(offset, offset + cs.length)
    offset += cs.length
    if (
      !part.length ||
      part.map((g) => g.char).join('') !== cs.join('') ||
      part.some((g) => g.glyph.font !== item.fontName) ||
      item.dir !== 'ltr' ||
      content.styles[item.fontName]?.vertical !== false ||
      !finite(item.transform, 6) ||
      item.transform[0] <= 0 ||
      item.transform[0] !== item.transform[3] ||
      item.transform[1] !== 0 ||
      item.transform[2] !== 0 ||
      item.height !== item.transform[3] ||
      !Number.isFinite(item.width) ||
      item.width <= 0
    )
      return
    if (Math.max(...item.transform.map((n, i) => Math.abs(n - part[0].glyph.transform[i]))) > 0.02)
      return
    const advance = union(part.map((g) => g.glyph.advance)),
      expected = [
        item.transform[4],
        item.transform[5],
        item.transform[4] + item.width,
        item.transform[5] + item.height
      ]
    if (Math.max(...expected.map((n, i) => Math.abs(n - advance[i]))) > 0.02) return
    const gs = [...new Set(part.map((g) => g.glyph))]
    items.push({
      index,
      ink: union(gs.map((g) => g.ink!)),
      glyphs: gs,
      mcids: [...new Set(gs.map((g) => g.mcid))]
    })
    for (const g of gs) spans.find((s) => s.mcid === g.mcid)!.indices.add(index)
  }
  if (
    offset !== chars.length ||
    [...selected].some((i) => !items.some((x) => x.index === i)) ||
    spans.some(
      (s) =>
        [...s.indices].some((i) => selected.has(i)) && [...s.indices].some((i) => !selected.has(i))
    )
  )
    return
  const chosen = items.filter((i) => selected.has(i.index))
  if (!chosen.length) return
  const bounds = union(chosen.map((i) => i.ink))
  if (items.some((i) => !selected.has(i.index) && intersects(i.ink, bounds))) return
  return { items, glyphs }
}

function completeRecords(frames: Frame[]): boolean {
  type Row = { page: number; baseline: number; height: number; left: number; glyphs: Glyph[] }
  const rows: Row[] = []
  const first = frames[0],
    title = first.content.items.find((i) => 'str' in i && heading(i.str))
  if (!title || !('str' in title)) return false
  const left = title.transform[4],
    em = title.height
  for (const f of frames) {
    const selectedItems = f.program.items.filter((i) => f.selected.has(i.index)),
      titleGlyphs = new Set(
        selectedItems
          .filter((i) => {
            const item = f.content.items[i.index]
            return 'str' in item && heading(item.str)
          })
          .flatMap((i) => i.glyphs)
      ),
      mcids = new Set(selectedItems.flatMap((i) => i.mcids)),
      local: Row[] = []
    for (const g of f.program.glyphs) {
      if (!mcids.has(g.mcid) || titleGlyphs.has(g)) continue
      if (Math.abs(g.transform[3] - em) > em * 0.02) return false
      let row = local.find((r) => Math.abs(r.baseline - g.transform[5]) <= em * 0.02)
      if (!row) {
        row = {
          page: f.rawPage.page,
          baseline: g.transform[5],
          height: em,
          left: Infinity,
          glyphs: []
        }
        local.push(row)
      }
      row.glyphs.push(g)
      if (g.unicode.trim()) row.left = Math.min(row.left, g.transform[4])
    }
    local.sort((a, b) => b.baseline - a.baseline)
    // Adjacent physical rows must have disjoint baseline bands. Sorting is private proof only.
    if (local.some((r, i) => i > 0 && local[i - 1].baseline - r.baseline < em * 0.8)) return false
    rows.push(...local)
  }
  const records: Row[][] = []
  for (const row of rows) {
    row.glyphs.sort((a, b) => a.transform[4] - b.transform[4])
    if (Math.abs(row.left - left) <= em * 0.02) records.push([row])
    else {
      if (!records.length || (row.left - left) / em < 3 || (row.left - left) / em > 3.5)
        return false
      records.at(-1)!.push(row)
    }
  }
  if (records.length < 3 || records.filter((r) => r.length > 1).length < 2) return false
  return records.every((record) => {
    const lines = record.map((r) => r.glyphs.map((g) => g.unicode).join('')),
      value = lines.join('\n')
    if (!/\b(?:18|19|20)\d{2}[a-z]?\b/u.test(value)) return false
    if (/[.!?)]\s*$/u.test(value) || /https?:\/\/\S+\s*$/u.test(value)) return true
    const at = lines.findLastIndex((s) => /https?:\/\//u.test(s))
    if (at < 0) return false
    const parts = [lines[at].slice(lines[at].search(/https?:\/\//u)), ...lines.slice(at + 1)]
    return (
      parts.every((s) => /^\S+$/u.test(s.trim())) &&
      /^https?:\/\/[^\s<>]+$/u.test(parts.map((s) => s.trim()).join(''))
    )
  })
}

/** Only this closure can retain its live page frames. No JSON evidence field or
 * exported registration function can mint a native reference packet. */
export function createNativeTaggedReferenceReader(
  document: Document,
  signal: AbortSignal
): {
  observe: (input: Input) => Promise<void>
  owners: (
    units: readonly Unit[],
    pages: readonly PdfLayoutPage[]
  ) => Promise<ReadonlyMap<string, 'reference' | 'original-only-url'>>
  currentOwners: (
    units: readonly Unit[],
    pages: readonly PdfLayoutPage[]
  ) => ReadonlyMap<string, 'reference' | 'original-only-url'>
} {
  let frames: Frame[] = [],
    failed = false
  let verified:
    | {
        units: readonly Unit[]
        pages: readonly PdfLayoutPage[]
        current: () => boolean
        roles: ReadonlyMap<string, 'reference' | 'original-only-url'>
      }
    | undefined
  const count = document.numPages,
    fingerprints = document.fingerprints,
    fingerprintValues = [...fingerprints],
    getPage = document.getPage,
    documentCurrent = (): boolean =>
      !signal.aborted &&
      document.numPages === count &&
      document.getPage === getPage &&
      document.fingerprints === fingerprints &&
      fingerprints.length === fingerprintValues.length &&
      fingerprints.every((s, i) => s === fingerprintValues[i]),
    current = (): boolean => documentCurrent() && frames.every((f) => f.current())
  return {
    async observe(input): Promise<void> {
      verified = undefined
      try {
        const titles = input.content.items.flatMap((item, index) =>
          'str' in item && heading(item.str) ? [index] : []
        )
        if (titles.length) {
          frames = []
          failed = false
        }
        if (!titles.length && (!frames.length || failed)) return
        if (
          titles.length > 1 ||
          frames.length >= 8 ||
          !current() ||
          input.rawPage.page !== input.page.pageNumber ||
          (frames.length && input.page.pageNumber !== frames.at(-1)!.rawPage.page + 1)
        ) {
          failed = true
          return
        }
        const { page, content, viewport, rawPage, unreliable } = input
        if (
          !(unreliable instanceof Set) ||
          nativeSetSize.call(unreliable) ||
          rawPage.items.length !== content.items.length
        ) {
          failed = true
          return
        }
        const rawItems = rawPage.items,
          dimensions = [rawPage.page, rawPage.width, rawPage.height, rawPage.rotation],
          watched = watch(rawItems),
          contentCurrent = watch(content),
          viewportCurrent = watch(viewport),
          setCurrent = watch(unreliable),
          unreliableValues = [...nativeSetValues.call(unreliable)],
          setHas = unreliable.has,
          setPrototype = Object.getPrototypeOf(unreliable),
          apis = [page.getOperatorList, page.getTextContent, page.getViewport],
          pageNumber = page.pageNumber,
          inputCurrent = (): boolean =>
            watched() &&
            contentCurrent() &&
            viewportCurrent() &&
            setCurrent() &&
            page.pageNumber === pageNumber &&
            [page.getOperatorList, page.getTextContent, page.getViewport].every(
              (api, i) => api === apis[i]
            ) &&
            [rawPage.page, rawPage.width, rawPage.height, rawPage.rotation].every(
              (n, i) => n === dimensions[i]
            ) &&
            rawPage.items === rawItems &&
            input.page === page &&
            input.content === content &&
            input.rawPage === rawPage &&
            input.viewport === viewport &&
            input.unreliable === unreliable &&
            Object.getPrototypeOf(unreliable) === setPrototype &&
            unreliable.has === setHas &&
            nativeSetSize.call(unreliable) === unreliableValues.length &&
            unreliableValues.every((i) => nativeSetHas.call(unreliable, i))
        const operators = await page.getOperatorList()
        if (!current() || !inputCurrent()) {
          failed = true
          return
        }
        const keys = outlineKeys(operators),
          epoch = keys && nativeInkPageCurrent(page, content, viewport, operators, keys)
        if (!epoch || !nativeReferenceFontWitnesses(page, content)) {
          failed = true
          return
        }
        const frameCurrent = (): boolean => epoch() && inputCurrent()
        if (!frameCurrent()) {
          failed = true
          return
        }
        const raw = await page.getTextContent({ disableNormalization: true })
        if (
          !current() ||
          !frameCurrent() ||
          raw.items.length !== content.items.length ||
          JSON.stringify(raw) !== JSON.stringify(content)
        ) {
          failed = true
          return
        }
        const title = titles.length ? content.items[titles[0]] : undefined
        if (title) {
          if (!('str' in title)) {
            failed = true
            return
          }
          const first = content.items.find(
            (i) => 'str' in i && i.str.trim() && i.transform[5] < title.transform[5]
          )
          if (
            !first ||
            !('str' in first) ||
            first.fontName === title.fontName ||
            Math.abs(first.height - title.height) > title.height * 0.02 ||
            Math.abs(first.transform[4] - title.transform[4]) > title.height * 0.02
          ) {
            failed = true
            return
          }
        }
        const selected = new Set(
          content.items.flatMap((item, index) =>
            'str' in item && item.str.trim() && (!title || item.transform[5] <= title.transform[5])
              ? [index]
              : []
          )
        )
        for (const [index, native] of content.items.entries())
          if ('str' in native && native.str.trim()) {
            const item = rawItems[index],
              style = content.styles[native.fontName],
              [a, b, c, d, x, y] = native.transform,
              [ma, mb, mc, md, mx, my] = viewport.transform,
              scale = Math.hypot(ma, mb),
              projected = [
                ma * a + mc * b,
                -(mb * a + md * b),
                ma * c + mc * d,
                -(mb * c + md * d),
                ma * x + mc * y + mx,
                viewport.height - (mb * x + md * y + my)
              ]
            if (
              !item ||
              item.str !== native.str ||
              item.fontName !== native.fontName ||
              item.dir !== native.dir ||
              item.width !== native.width * scale ||
              item.height !== native.height * scale ||
              item.transform.some((n, i) => n !== projected[i]) ||
              item.fontAscent !== style.ascent ||
              item.fontDescent !== style.descent ||
              item.fontVertical !== style.vertical
            ) {
              failed = true
              return
            }
          }
        const proof = program(page, content, viewport, operators, selected)
        if (!proof || !frameCurrent() || !current()) {
          failed = true
          return
        }
        frames.push({ ...input, current: frameCurrent, program: proof, selected })
      } catch {
        failed = true
      }
    },
    async owners(units, pages): Promise<ReadonlyMap<string, 'reference' | 'original-only-url'>> {
      verified = undefined
      const declined = new Map<string, 'reference' | 'original-only-url'>()
      try {
        if (
          failed ||
          !frames.length ||
          frames.at(-1)!.rawPage.page !== count ||
          !current() ||
          !completeRecords(frames)
        )
          return declined
        const sourceCurrent = watch(units),
          pageCurrent = watch(pages),
          keys = new Map<string, { text: string; owner?: Unit }>()
        for (const f of frames) {
          if (pages[f.rawPage.page - 1] !== f.rawPage) return declined
          for (const index of f.selected) {
            const item = f.content.items[index]
            if (!('str' in item)) return declined
            keys.set(f.rawPage.page + ':' + index, { text: item.str })
          }
        }
        if (keys.size > 4096) return declined
        const owned = new Set<Unit>()
        for (const unit of units) {
          const items = unit.fragments.flatMap((f) =>
              f.items.map((i) => ({ key: f.pageNumber + ':' + i.index, text: i.text }))
            ),
            selected = items.filter((i) => keys.has(i.key))
          if (!selected.length) continue
          if (selected.length !== items.length || unit.figure || !unit.id || items.length === 0)
            return declined
          for (const item of selected) {
            const native = keys.get(item.key)!
            if (native.owner || native.text !== item.text) return declined
            native.owner = unit
          }
          owned.add(unit)
        }
        if ([...keys.values()].some((i) => !i.owner)) return declined
        for (const f of frames) {
          const actual = await document.getPage(f.rawPage.page)
          if (actual !== f.page || !current() || !sourceCurrent() || !pageCurrent()) return declined
        }
        const accepted = new Map<string, 'reference' | 'original-only-url'>()
        for (const u of owned)
          if (!u.sourceOnly && !u.preserve)
            accepted.set(u.id, literalUrl(u.source) ? 'original-only-url' : 'reference')
        if (!current() || !sourceCurrent() || !pageCurrent()) return declined
        verified = {
          units,
          pages,
          current: () => current() && sourceCurrent() && pageCurrent(),
          roles: accepted
        }
        return new Map(accepted)
      } catch {
        return declined
      }
    },
    currentOwners(units, pages): ReadonlyMap<string, 'reference' | 'original-only-url'> {
      // This synchronous check is repeated after the caller's final await, with
      // no intervening promise before assigning roles and committing Source.
      try {
        if (
          !verified ||
          verified.units !== units ||
          verified.pages !== pages ||
          !verified.current()
        )
          return new Map()
        return new Map(verified.roles)
      } catch {
        return new Map()
      }
    }
  }
}
