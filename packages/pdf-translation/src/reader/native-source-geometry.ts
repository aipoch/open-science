import type { PDFPageProxy } from 'pdfjs-dist'
import type { TextItem, TextStyle } from 'pdfjs-dist/types/src/display/api.js'
import type { PdfStructureResult } from '@aipoch/pdf-structure/result'

type NavigationRect = Readonly<{ x: number; y: number; width: number; height: number }>

/** A visible navigation intersection does not prove complete glyph or cell geometry. */
export function clippedNavigationRect(rect: NavigationRect): NavigationRect | undefined {
  if (
    !Object.values(rect).every(Number.isFinite) ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    !(rect.x < 0 || rect.y < 0 || rect.x + rect.width > 1 || rect.y + rect.height > 1)
  )
    return
  const x = Math.max(0, rect.x),
    y = Math.max(0, rect.y),
    width = Math.min(1, rect.x + rect.width) - x,
    height = Math.min(1, rect.y + rect.height) - y
  return width > 0 && height > 0 ? { x, y, width, height } : undefined
}

/** Preserve only the native literal; never infer text omitted by the PDF decoder. */
export function nativePartialNavigation(
  item: TextItem,
  style: TextStyle | undefined,
  viewport: ReturnType<PDFPageProxy['getViewport']>
): { rect: NavigationRect; unclippedRect: NavigationRect } | undefined {
  if (
    !item.str.trim() ||
    item.dir !== 'ltr' ||
    !item.fontName ||
    style?.vertical !== false ||
    !Number.isFinite(style.ascent) ||
    !Number.isFinite(style.descent) ||
    style.ascent! <= 0 ||
    style.ascent! > 1 ||
    style.descent! > 0 ||
    style.descent! < -1 ||
    style.ascent! <= style.descent! ||
    item.transform.length !== 6 ||
    ![...item.transform, item.width, item.height, viewport.width, viewport.height].every(
      Number.isFinite
    ) ||
    item.width <= 0 ||
    item.height <= 0 ||
    viewport.width <= 0 ||
    viewport.height <= 0 ||
    viewport.transform?.length !== 6 ||
    !viewport.transform.every(Number.isFinite)
  )
    return
  const [a, b, c, d, x, y] = item.transform,
    [ma, mb, mc, md, mx, my] = viewport.transform,
    aa = ma * a + mc * b,
    bb = -(mb * a + md * b),
    cc = ma * c + mc * d,
    dd = -(mb * c + md * d),
    scale = Math.hypot(ma, mb)
  if (aa <= 0 || aa !== dd || bb !== 0 || cc !== 0 || item.height * scale !== dd) return
  const unclippedRect = {
      x: (ma * x + mc * y + mx) / viewport.width,
      y: (mb * x + md * y + my - style.ascent! * dd) / viewport.height,
      width: (item.width * scale) / viewport.width,
      height: dd / viewport.height
    },
    rect = clippedNavigationRect(unclippedRect)
  return rect ? { rect, unclippedRect } : undefined
}

/** A full glyph outline is used only to prove that an unclaimed zero-advance item is outside. */
export async function nativeZeroAdvanceRegions(
  page: PDFPageProxy,
  content: Awaited<ReturnType<PDFPageProxy['getTextContent']>>,
  viewport: ReturnType<PDFPageProxy['getViewport']>,
  pageNumber: number
): Promise<Map<number, NonNullable<ReturnType<typeof nativeLabelRegion>>>> {
  const regions = new Map<number, NonNullable<ReturnType<typeof nativeLabelRegion>>>()
  if (!page.commonObjs || typeof page.getOperatorList !== 'function') return regions
  const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const operators = await page.getOperatorList()
  if (operators.fnArray.length !== operators.argsArray.length || operators.fnArray.length > 100000)
    return regions
  let state = { font: '', size: 0, mode: 0, char: 0, word: 0, scale: 100, rise: 0, unsafe: false }
  const stack: (typeof state)[] = []
  const glyphs = new Map<string, { chars: Set<string>; unsafe: boolean; size: number }>()
  for (let i = 0; i < operators.fnArray.length; i++) {
    const op = operators.fnArray[i],
      args = operators.argsArray[i]
    if (op === OPS.save || op === OPS.paintFormXObjectBegin) {
      stack.push({ ...state })
      if (op === OPS.paintFormXObjectBegin) state.unsafe = true
    } else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
      if (!stack.length) return regions
      state = stack.pop()!
    } else if (op === OPS.setFont) {
      state.font = args[0]
      state.size = args[1]
    } else if (op === OPS.setTextRenderingMode) {
      state.mode = args[0]
      if (state.mode >= 4) state.unsafe = true
    } else if (op === OPS.setCharSpacing) state.char = args[0]
    else if (op === OPS.setWordSpacing) state.word = args[0]
    else if (op === OPS.setHScale) state.scale = args[0]
    else if (op === OPS.setTextRise) state.rise = args[0]
    else if ([OPS.setGState, OPS.transform, OPS.clip, OPS.eoClip, OPS.setFillColorN].includes(op))
      state.unsafe = true
    else if (op === OPS.constructPath && [OPS.clip, OPS.eoClip].includes(args?.[0]))
      state.unsafe = true
    else if ([OPS.beginAnnotation, OPS.endAnnotation, OPS.beginGroup, OPS.endGroup].includes(op))
      return regions
    else if (op === OPS.showText) {
      if (!Array.isArray(args?.[0])) return regions
      for (const glyph of args[0]) {
        if (!glyph || typeof glyph !== 'object' || typeof glyph.unicode !== 'string') continue
        const key = state.font + '\0' + glyph.unicode
        const found = glyphs.get(key) ?? {
          chars: new Set<string>(),
          unsafe: false,
          size: state.size
        }
        found.unsafe ||=
          state.unsafe ||
          state.mode !== 0 ||
          state.char !== 0 ||
          state.word !== 0 ||
          state.scale !== 100 ||
          state.rise !== 0 ||
          !Number.isFinite(state.size) ||
          state.size <= 0 ||
          found.size !== state.size ||
          glyph.width !== 0 ||
          glyph.isInFont !== true ||
          !!glyph.accent ||
          typeof glyph.fontChar !== 'string' ||
          !glyph.fontChar
        found.chars.add(glyph.fontChar)
        glyphs.set(key, found)
      }
    }
  }
  if (stack.length) return regions
  for (const [index, item] of content.items.entries()) {
    if (
      !('str' in item) ||
      !item.str.trim() ||
      item.width !== 0 ||
      item.dir !== 'ltr' ||
      content.styles?.[item.fontName]?.vertical ||
      item.transform.length !== 6 ||
      !item.transform.every(Number.isFinite) ||
      !Number.isFinite(item.height) ||
      item.height <= 0
    )
      continue
    const [a, b, c, d, x, y] = item.transform
    if (a !== item.height || d !== item.height || b !== 0 || c !== 0) continue
    const found = glyphs.get(item.fontName + '\0' + item.str)
    if (
      !found ||
      found.unsafe ||
      found.chars.size !== 1 ||
      found.size !== item.height ||
      !page.commonObjs.has(item.fontName)
    )
      continue
    const font = page.commonObjs.get(item.fontName)
    if (
      !font ||
      font.missingFile !== false ||
      font.isInvalidPDFjsFont !== false ||
      font.remeasure ||
      font.vertical !== false ||
      font.isType3Font !== false ||
      typeof font.loadedName !== 'string' ||
      JSON.stringify(font.fontMatrix) !== '[0.001,0,0,0.001,0,0]'
    )
      continue
    const key = font.loadedName + '_path_' + [...found.chars][0]
    if (!page.commonObjs.has(key)) continue
    const bounds = nativeOutlineBox(page.commonObjs.get(key)?.path)
    if (!bounds) continue
    const points = [bounds[0], bounds[2]].flatMap((u) =>
      [bounds[1], bounds[3]].map((v) => viewport.convertToViewportPoint(x + a * u, y + d * v))
    )
    const left = Math.min(...points.map((p) => p[0])),
      top = Math.min(...points.map((p) => p[1]))
    const region = {
      page: pageNumber,
      x: left / viewport.width,
      y: top / viewport.height,
      width: (Math.max(...points.map((p) => p[0])) - left) / viewport.width,
      height: (Math.max(...points.map((p) => p[1])) - top) / viewport.height
    }
    if (Object.values(region).every(Number.isFinite) && region.width > 0 && region.height > 0)
      regions.set(index, region)
  }
  return regions
}

export function nativeLabelRegion(
  item: TextItem,
  style: TextStyle | undefined,
  viewport: ReturnType<PDFPageProxy['getViewport']>,
  page: number
): PdfStructureResult['elements'][number]['regions'][number] | undefined {
  if (
    item.dir !== 'ltr' ||
    style?.vertical ||
    item.transform.length !== 6 ||
    ![...item.transform, item.width, item.height].every(Number.isFinite) ||
    item.width <= 0 ||
    item.height <= 0
  )
    return
  const [a, b, c, d, x, y] = item.transform,
    advance = Math.hypot(a, b),
    height = Math.hypot(c, d)
  if (
    advance <= 0 ||
    height <= 0 ||
    a * d - b * c <= 0 ||
    Math.abs(a * c + b * d) > advance * height * 0.0001
  )
    return
  const ascent = style?.ascent || (style?.descent ? 1 + style.descent : 0.8)
  const points = [0, item.width].flatMap((u) =>
    [-(1 - ascent) * height, ascent * height].map((v) =>
      viewport.convertToViewportPoint(
        x + (a / advance) * u + (c / height) * v,
        y + (b / advance) * u + (d / height) * v
      )
    )
  )
  const left = Math.min(...points.map(([x]) => x)),
    top = Math.min(...points.map(([, y]) => y))
  const result = {
    page,
    x: left / viewport.width,
    y: top / viewport.height,
    width: (Math.max(...points.map(([x]) => x)) - left) / viewport.width,
    height: (Math.max(...points.map(([, y]) => y)) - top) / viewport.height
  }
  return Object.values(result).every(Number.isFinite) && result.width > 0 && result.height > 0
    ? result
    : undefined
}

type Box = [number, number, number, number]
type Point = [number, number]
// Control-point bounds contain the complete glyph, including Bezier curves.
export function nativeOutlineBox(path: ArrayLike<number> | undefined): Box | undefined {
  if (!path || !Number.isSafeInteger(path.length) || path.length > 10000) return
  const points: Point[] = []
  let drawn = false
  for (let i = 0; i < path.length;) {
    const op = path[i++],
      n = op === 0 || op === 1 ? 2 : op === 2 ? 6 : op === 3 ? 4 : op === 4 ? 0 : -1
    if (n < 0 || i + n > path.length || (op !== 0 && !points.length)) return
    if (op >= 1 && op <= 3) drawn = true
    for (let end = i + n; i < end; i += 2) {
      if (!Number.isFinite(path[i]) || !Number.isFinite(path[i + 1])) return
      points.push([path[i], path[i + 1]])
    }
  }
  if (!drawn) return
  const b: Box = [
    Math.min(...points.map((p) => p[0])),
    Math.min(...points.map((p) => p[1])),
    Math.max(...points.map((p) => p[0])),
    Math.max(...points.map((p) => p[1]))
  ]
  return b[2] > b[0] && b[3] > b[1] ? b : undefined
}

/** Independent, narrow text-show proof for otherwise overlapping algorithm labels.
 * Claimed sources require their complete native advance. Exterior sources use
 * actual glyph ink, including no guessed ink for native positioning spaces.
 */
export async function nativeAlgorithmInkRegions(
  page: PDFPageProxy,
  content: Awaited<ReturnType<PDFPageProxy['getTextContent']>>,
  viewport: ReturnType<PDFPageProxy['getViewport']>,
  pageNumber: number,
  selected: ReadonlySet<number>
): Promise<Map<number, NonNullable<ReturnType<typeof nativeLabelRegion>>> | undefined> {
  return readNativeInkRegions(page, content, viewport, pageNumber, selected)
}

/** A separate text proof; a clip is harmless to text only when its entire
 * saved lifetime is text-free. It does not certify any graphical paint. */
export async function nativeTextFreeClipInkRegions(
  page: PDFPageProxy,
  content: Awaited<ReturnType<PDFPageProxy['getTextContent']>>,
  viewport: ReturnType<PDFPageProxy['getViewport']>,
  pageNumber: number,
  selected: ReadonlySet<number>,
  operatorSnapshot?: Awaited<ReturnType<PDFPageProxy['getOperatorList']>>
): Promise<Map<number, NonNullable<ReturnType<typeof nativeLabelRegion>>> | undefined> {
  try {
    const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs'),
      original = await page.getOperatorList()
    if (original.fnArray.length !== original.argsArray.length || original.fnArray.length > 100000)
      return
    if (operatorSnapshot && JSON.stringify(original) !== JSON.stringify(operatorSnapshot)) return
    // The proof and glyph pass consume the same snapshot across their awaits.
    const operators = structuredClone(operatorSnapshot ?? original),
      clips = new Set<number>(),
      stack: number[] = []
    let active = 0,
      pending = false
    for (const [index, op] of operators.fnArray.entries()) {
      const args = operators.argsArray[index]
      if (op === OPS.save) {
        if (pending) return
        stack.push(active)
      } else if (op === OPS.restore) {
        if (pending || !stack.length) return
        active = stack.pop()!
      } else if (op === OPS.clip || op === OPS.eoClip) {
        if (pending || !stack.length || clips.size >= 16) return
        clips.add(index)
        pending = true
      } else if (op === OPS.constructPath && pending) {
        if (args?.[0] !== OPS.endPath || args?.[1]?.length !== 1 || !nativeOutlineBox(args[1][0]))
          return
        pending = false
        active++
      } else if (
        (active || pending) &&
        [
          OPS.beginText,
          OPS.showText,
          OPS.showSpacedText,
          OPS.nextLineShowText,
          OPS.nextLineSetSpacingShowText
        ].includes(op)
      )
        return
    }
    if (pending || active || stack.length || !clips.size) return
    return readNativeInkRegions(page, content, viewport, pageNumber, selected, operators, clips)
  } catch {
    return
  }
}

async function readNativeInkRegions(
  page: PDFPageProxy,
  content: Awaited<ReturnType<PDFPageProxy['getTextContent']>>,
  viewport: ReturnType<PDFPageProxy['getViewport']>,
  pageNumber: number,
  selected: ReadonlySet<number>,
  operatorSnapshot?: Awaited<ReturnType<PDFPageProxy['getOperatorList']>>,
  textFreeClips?: ReadonlySet<number>
): Promise<Map<number, NonNullable<ReturnType<typeof nativeLabelRegion>>> | undefined> {
  if (!page.commonObjs || typeof page.getOperatorList !== 'function') return
  if (viewport.scale !== 1 || viewport.rotation !== 0 || !selected.size) return
  const { OPS, Util } = await import('pdfjs-dist/legacy/build/pdf.mjs'),
    ops = operatorSnapshot ?? (await page.getOperatorList()),
    finite = (a: unknown, n: number): a is number[] =>
      (Array.isArray(a) || ArrayBuffer.isView(a)) &&
      (a as number[]).length === n &&
      Array.from(a as number[]).every(Number.isFinite),
    axis = (a: number[]): boolean =>
      finite(a, 6) && a[0] > 0 && a[3] > 0 && a[1] === 0 && a[2] === 0,
    letters = (s: string): string[] => Array.from(s.normalize('NFD')).filter((c) => !/\s/u.test(c)),
    union = (rs: number[][]): number[] => [
      Math.min(...rs.map((r) => r[0])),
      Math.min(...rs.map((r) => r[1])),
      Math.max(...rs.map((r) => r[2])),
      Math.max(...rs.map((r) => r[3]))
    ],
    box = (r: number[], m: number[]): number[] => {
      const ps = [r[0], r[2]].flatMap((x) =>
        [r[1], r[3]].map((y) => {
          const p = [x, y]
          Util.applyTransform(p, m)
          return p
        })
      )
      return [
        Math.min(...ps.map((p) => p[0])),
        Math.min(...ps.map((p) => p[1])),
        Math.max(...ps.map((p) => p[0])),
        Math.max(...ps.map((p) => p[1]))
      ]
    }
  if (
    ops.fnArray.length !== ops.argsArray.length ||
    ops.fnArray.length > 100000 ||
    !finite(viewport.transform, 6) ||
    content.items.length > 10000
  )
    return
  type Glyph = { char: string; font: string; transform: number[]; advance: number[]; ink: number[] }
  const chars: Glyph[] = [],
    stack: { ctm: number[]; font: string; size: number; fill: string }[] = []
  let state = { ctm: [1, 0, 0, 1, 0, 0], font: '', size: 0, fill: '#000000' },
    matrix = [1, 0, 0, 1, 0, 0],
    x = 0,
    y = 0,
    lineX = 0,
    lineY = 0,
    text = false
  const inert = new Set([
    OPS.setStrokeRGBColor,
    OPS.setLineWidth,
    OPS.setLineCap,
    OPS.setLineJoin,
    OPS.setMiterLimit,
    OPS.setDash
  ])
  for (let i = 0; i < ops.fnArray.length; i++) {
    const op = ops.fnArray[i],
      a = ops.argsArray[i]
    if (op === OPS.save) {
      if (text) return
      stack.push({ ...state, ctm: [...state.ctm] })
    } else if (op === OPS.restore) {
      if (text || !stack.length) return
      state = stack.pop()!
    } else if (op === OPS.transform) {
      if (text || !finite(a, 6)) return
      state.ctm = Util.transform(state.ctm, a)
    } else if (op === OPS.beginText) {
      if (text) return
      text = true
      matrix = [1, 0, 0, 1, 0, 0]
      x = y = lineX = lineY = 0
    } else if (op === OPS.endText) {
      if (!text) return
      text = false
    } else if (op === OPS.setFont) {
      if (!text || typeof a?.[0] !== 'string' || !Number.isFinite(a[1]) || a[1] <= 0) return
      state.font = a[0]
      state.size = a[1]
    } else if (op === OPS.setTextMatrix) {
      const m = a?.length === 1 ? a[0] : a
      if (!text || !axis(m)) return
      matrix = m
      x = y = lineX = lineY = 0
    } else if (op === OPS.moveText) {
      if (!text || !finite(a, 2)) return
      x = lineX += a[0]
      y = lineY += a[1]
    } else if (op === OPS.setFillRGBColor) {
      if (typeof a?.[0] !== 'string' || !/^#[0-9a-f]{6}$/iu.test(a[0])) return
      state.fill = a[0]
    } else if (op === OPS.showText) {
      if (
        !text ||
        !state.font ||
        !(state.size > 0) ||
        !Array.isArray(a?.[0]) ||
        state.fill.toLowerCase() === '#ffffff' ||
        !page.commonObjs.has(state.font)
      )
        return
      const font = page.commonObjs.get(state.font),
        m = Util.transform(state.ctm, matrix)
      if (
        !axis(m) ||
        font?.missingFile !== false ||
        font.isInvalidPDFjsFont !== false ||
        font.remeasure ||
        font.vertical !== false ||
        font.isType3Font !== false ||
        typeof font.loadedName !== 'string' ||
        JSON.stringify(font.fontMatrix) !== '[0.001,0,0,0.001,0,0]'
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
          g.isInFont !== true ||
          !Number.isFinite(g.width) ||
          g.width < 0 ||
          g.accent != null ||
          g.vmetric != null ||
          g.operatorListId != null
        )
          return
        const key = font.loadedName + '_path_' + g.fontChar
        if (!page.commonObjs.has(key)) return
        const path = page.commonObjs.get(key)?.path,
          outline = nativeOutlineBox(path),
          cs = letters(g.unicode)
        if (!cs.length) {
          if (g.isSpace !== true || !path || path.length !== 0) return
          x += (g.width * state.size) / 1000
          continue
        }
        if (!outline) return
        const transform = [
            m[0] * state.size,
            m[1] * state.size,
            m[2] * state.size,
            m[3] * state.size,
            m[4] + m[0] * x + m[2] * y,
            m[5] + m[1] * x + m[3] * y
          ],
          display = Util.transform(viewport.transform, transform),
          ink = box(outline, display),
          advance = box([0, 0, g.width / 1000, 1], display)
        if (![...transform, ...ink, ...advance].every(Number.isFinite)) return
        for (const char of cs) chars.push({ char, font: state.font, transform, advance, ink })
        x += (g.width * state.size) / 1000
      }
    } else if (op === OPS.constructPath) {
      if (
        text ||
        ![
          OPS.stroke,
          OPS.closeStroke,
          OPS.fill,
          OPS.eoFill,
          OPS.fillStroke,
          OPS.eoFillStroke,
          OPS.closeFillStroke,
          OPS.closeEOFillStroke,
          OPS.endPath
        ].includes(a?.[0])
      )
        return
    } else if (op === OPS.dependency) {
      if (!Array.isArray(a) || a.some((s) => typeof s !== 'string')) return
    } else if (textFreeClips?.has(i) && (op === OPS.clip || op === OPS.eoClip)) {
      // The separate entry point proved this clip cannot affect any text.
    } else if (!inert.has(op)) return
  }
  if (text || stack.length) return
  const regions = new Map<number, NonNullable<ReturnType<typeof nativeLabelRegion>>>()
  let offset = 0
  for (const [index, item] of content.items.entries()) {
    if (!('str' in item) || !item.str.trim()) continue
    const cs = letters(item.str),
      part = chars.slice(offset, offset + cs.length)
    offset += cs.length
    if (
      !part.length ||
      part.map((g) => g.char).join('') !== cs.join('') ||
      part.some((g) => g.font !== item.fontName) ||
      item.dir !== 'ltr' ||
      content.styles?.[item.fontName]?.vertical !== false ||
      !axis(item.transform) ||
      !Number.isFinite(item.width) ||
      item.width < 0 ||
      !Number.isFinite(item.height) ||
      item.height <= 0 ||
      item.transform.some((n, i) => Math.abs(n - part[0].transform[i]) > 0.02)
    )
      return
    if (selected.has(index)) {
      const expected = box(
          [0, 0, item.width / item.transform[0], 1],
          Util.transform(viewport.transform, item.transform)
        ),
        advance = union(part.map((g) => g.advance))
      if (expected.some((n, i) => Math.abs(n - advance[i]) > 0.02)) return
    }
    const r = union(part.map((g) => g.ink)),
      result = {
        page: pageNumber,
        x: r[0] / viewport.width,
        y: r[1] / viewport.height,
        width: (r[2] - r[0]) / viewport.width,
        height: (r[3] - r[1]) / viewport.height
      }
    if (!Object.values(result).every(Number.isFinite) || result.width <= 0 || result.height <= 0)
      return
    regions.set(index, result)
  }
  if (offset !== chars.length || [...selected].some((i) => !regions.has(i))) return
  return regions
}

// Only an optional reference-caption owner uses this isolated native program.
// Complete Form clips exclude foreign paint; the ordinary glyph core stays strict.
type CaptionInkContent = Awaited<ReturnType<PDFPageProxy['getTextContent']>>
type CaptionInkViewport = ReturnType<PDFPageProxy['getViewport']>
type CaptionInkOperators = Awaited<ReturnType<PDFPageProxy['getOperatorList']>>
type CaptionInkRegion = NonNullable<ReturnType<typeof nativeLabelRegion>>
type CaptionInkImage = { id: string; width: number; height: number }
type CaptionInkForm = {
  begin: number
  end?: number
  bounds: Box
  images: Box[]
  imageSources: CaptionInkImage[]
}
type CaptionInkState = {
  matrix: number[]
  font: string
  form?: CaptionInkForm
  ca: number
  blend: string
  mask: boolean
  width: number
  miter: number
}
type CaptionRgbImage = {
  width: number
  height: number
  kind: number
  bitmap?: unknown
  data: Uint8Array | Uint8ClampedArray
}
export type IsolatedPlotCaptionScope = {
  ids: number[]
  body: CaptionInkForm
  foreign: CaptionInkForm
  forms: CaptionInkForm[]
  membership: Map<number, number | null>
  outsidePaths: Box[]
  projectedContent: CaptionInkContent
  projectedOps: CaptionInkOperators
  outlineKeys: string[]
}
const captionInkFinite = (a: unknown, n: number): a is number[] =>
    (Array.isArray(a) || ArrayBuffer.isView(a)) &&
    (a as number[]).length === n &&
    Array.from(a as number[]).every(Number.isFinite),
  captionInkAxis = (m: number[]): boolean =>
    captionInkFinite(m, 6) && m[0] > 0 && m[3] > 0 && m[1] === 0 && m[2] === 0,
  captionInkHit = (a: number[], b: number[]): boolean =>
    a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
  captionInkValid = (b: unknown): b is Box => captionInkFinite(b, 4) && b[0] < b[2] && b[1] < b[3],
  captionInkUnion = (bs: number[][]): Box => [
    Math.min(...bs.map((b) => b[0])),
    Math.min(...bs.map((b) => b[1])),
    Math.max(...bs.map((b) => b[2])),
    Math.max(...bs.map((b) => b[3]))
  ]
const captionInkBox = (b: number[], m: number[]): Box => {
    const ps = [b[0], b[2]].flatMap((x) =>
      [b[1], b[3]].map((y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]])
    )
    return captionInkUnion(ps.map((p) => [p[0], p[1], p[0], p[1]]))
  },
  captionInkLetters = (s: string): string[] =>
    Array.from(s.normalize('NFD')).filter((c) => !/\s/u.test(c))

/** The enclosing scope already closes the opcode, Form, graphics-state and source
 * lifetimes. Check the vector paint separately, without treating its conservative
 * envelopes as exact visible ink. Nondegenerate native rectangles and straight
 * strokes establish actual drawing primitives; the Form clip bounds all paint. */
function captionInkClosedVectorForm(
  ops: CaptionInkOperators,
  viewport: CaptionInkViewport,
  form: CaptionInkForm,
  OPS: typeof import('pdfjs-dist/legacy/build/pdf.mjs').OPS,
  Util: typeof import('pdfjs-dist/legacy/build/pdf.mjs').Util
): boolean {
  const intersection = (a: Box, b: Box): Box | undefined => {
    const r: Box = [
      Math.max(a[0], b[0]),
      Math.max(a[1], b[1]),
      Math.min(a[2], b[2]),
      Math.min(a[3], b[3])
    ]
    return r[0] < r[2] && r[1] < r[3] ? r : undefined
  }
  const rectangle = (p: Float32Array): boolean =>
    p.length === 13 &&
    p[0] === 0 &&
    p[3] === 1 &&
    p[6] === 1 &&
    p[9] === 1 &&
    p[12] === 4 &&
    p[1] === p[10] &&
    p[2] === p[5] &&
    p[4] === p[7] &&
    p[8] === p[11]
  let state: {
    matrix: number[]
    fill: string
    stroke: string
    ca: number
    strokeAlpha: number
    width: number
    miter: number
    clip?: Box
    form?: number
  } = {
    matrix: [1, 0, 0, 1, 0, 0],
    fill: '#000000',
    stroke: '#000000',
    ca: 1,
    strokeAlpha: 1,
    width: 1,
    miter: 10
  }
  const stack: (typeof state)[] = [],
    possiblePaint: Box[] = []
  let pendingClip = false,
    clips = 0,
    coordinates = 0,
    rectangles = 0,
    straightStrokes = 0
  for (let i = 0; i <= form.end!; i++) {
    const op = ops.fnArray[i],
      a = ops.argsArray[i]
    if (op === OPS.save || op === OPS.paintFormXObjectBegin) {
      if (pendingClip) return false
      stack.push({ ...state, matrix: [...state.matrix] })
      if (op === OPS.paintFormXObjectBegin) {
        if (a?.[0]) state.matrix = Util.transform(state.matrix, a[0])
        state.form = i
        const clip = captionInkBox(
          Array.from(a[1]),
          Util.transform(viewport.transform, state.matrix)
        )
        state.clip = state.clip ? intersection(state.clip, clip) : clip
        if (!state.clip) return false
      }
    } else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
      if (pendingClip || !stack.length) return false
      state = stack.pop()!
    } else if (op === OPS.transform) {
      state.matrix = Util.transform(state.matrix, a)
      if (
        !state.matrix.every(Number.isFinite) ||
        state.matrix[1] !== 0 ||
        state.matrix[2] !== 0 ||
        state.matrix[0] === 0 ||
        state.matrix[3] === 0
      )
        return false
    } else if (op === OPS.setFillRGBColor || op === OPS.setStrokeRGBColor) {
      if (typeof a?.[0] !== 'string' || !/^#[0-9a-f]{6}$/iu.test(a[0])) return false
      if (op === OPS.setFillRGBColor) state.fill = a[0].toLowerCase()
      else state.stroke = a[0].toLowerCase()
    } else if (op === OPS.setDash) {
      if (!Array.isArray(a?.[0]) || a[0].length !== 0 || a[1] !== 0) return false
    } else if (op === OPS.setLineCap || op === OPS.setLineJoin) {
      if (!Number.isInteger(a?.[0]) || a[0] < 0 || a[0] > 2) return false
    } else if (op === OPS.setLineWidth) state.width = a[0]
    else if (op === OPS.setMiterLimit) state.miter = a[0]
    else if (op === OPS.setGState) {
      for (const [key, value] of a[0]) {
        if (key === 'ca') state.ca = value
        else if (key === 'CA') state.strokeAlpha = value
        else if (key === 'LW') state.width = value
        else if (key === 'ML') state.miter = value
      }
    } else if (op === OPS.clip || op === OPS.eoClip) {
      if (state.form === form.begin) {
        if (pendingClip) return false
        pendingClip = true
      }
    } else if (op === OPS.constructPath && state.form === form.begin) {
      if (!Array.isArray(a?.[1]) || a[1].length !== 1 || !state.clip) return false
      const path = a[1][0],
        stored = a[2]
      if (
        !(path instanceof Float32Array) ||
        !(stored instanceof Float32Array) ||
        (coordinates += path.length) > 64000 ||
        !captionInkFinite(stored, 4) ||
        stored[0] > stored[2] ||
        stored[1] > stored[3]
      )
        return false
      let raw = nativeOutlineBox(path)
      if (!raw && captionInkFinite(path, 6) && path[0] === 0 && path[3] === 1)
        raw = [
          Math.min(path[1], path[4]),
          Math.min(path[2], path[5]),
          Math.max(path[1], path[4]),
          Math.max(path[2], path[5])
        ]
      if (!raw) return false
      // The decoder stores path operands as Float32. Reject discrepancies beyond
      // one representable step, including the Float32 subnormal floor.
      for (let k = 0; k < 4; k++) {
        const ulp =
          2 **
          (Math.floor(Math.log2(Math.max(2 ** -126, Math.abs(raw[k]), Math.abs(stored[k])))) - 23)
        if (Math.abs(raw[k] - stored[k]) > ulp) return false
      }
      const nativeUnion: Box = [
          Math.min(raw[0], stored[0]),
          Math.min(raw[1], stored[1]),
          Math.max(raw[2], stored[2]),
          Math.max(raw[3], stored[3])
        ],
        matrix = Util.transform(viewport.transform, state.matrix),
        envelope = captionInkBox(nativeUnion, matrix),
        rawBox = captionInkBox(raw, matrix)
      if (pendingClip) {
        if (a[0] !== OPS.endPath || !rectangle(path) || matrix[1] !== 0 || matrix[2] !== 0)
          return false
        // A rectangle's actual path, rather than its rounded metadata envelope,
        // defines this exact axis-aligned clip.
        state.clip = intersection(state.clip, rawBox)
        if (!state.clip) return false
        pendingClip = false
        clips++
        continue
      }
      if (
        ![OPS.fill, OPS.stroke].includes(a[0]) ||
        !Number.isFinite(state.width) ||
        state.width < 0 ||
        !Number.isFinite(state.miter) ||
        state.miter < 1
      )
        return false
      const stroke = a[0] === OPS.stroke,
        alpha = stroke ? state.strokeAlpha : state.ca,
        color = stroke ? state.stroke : state.fill
      if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) return false
      const pad = stroke
          ? Math.max(
              1,
              state.width *
                state.miter *
                (Math.hypot(matrix[0], matrix[1]) + Math.hypot(matrix[2], matrix[3]))
            )
          : 0,
        possible = intersection(state.clip, [
          envelope[0] - pad,
          envelope[1] - pad,
          envelope[2] + pad,
          envelope[3] + pad
        ]),
        nonwhite = alpha > 0 && color !== '#ffffff'
      if (possible && nonwhite) possiblePaint.push(possible)
      if (
        !stroke &&
        rectangle(path) &&
        intersection(state.clip, rawBox) &&
        rawBox[0] < rawBox[2] &&
        rawBox[1] < rawBox[3] &&
        nonwhite
      )
        rectangles++
      if (
        stroke &&
        state.width > 0 &&
        path.length === 6 &&
        path[0] === 0 &&
        path[3] === 1 &&
        (rawBox[0] < rawBox[2] || rawBox[1] < rawBox[3]) &&
        rawBox[0] >= state.clip[0] &&
        rawBox[1] >= state.clip[1] &&
        rawBox[2] <= state.clip[2] &&
        rawBox[3] <= state.clip[3] &&
        nonwhite
      )
        straightStrokes++
    }
  }
  if (!rectangles || !straightStrokes || !clips || !possiblePaint.length) return false
  const bounds = captionInkUnion(possiblePaint)
  return (
    bounds[2] - bounds[0] >= (form.bounds[2] - form.bounds[0]) * 0.5 &&
    bounds[3] - bounds[1] >= (form.bounds[3] - form.bounds[1]) * 0.5
  )
}
/** Close both sibling Form programs and every source/glyph identity before isolating their paint.
 * One Form contains a raster plot and colorbar; the other can independently prove
 * bounded vector drawing below it. A caption must have one complete local owner. */
export async function nativeIsolatedPlotCaptionScope(
  content: CaptionInkContent,
  viewport: CaptionInkViewport,
  selected: ReadonlySet<number>,
  ops: CaptionInkOperators,
  pageNumber: number
): Promise<IsolatedPlotCaptionScope | undefined> {
  const { OPS, Util } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const names = new Map(Object.entries(OPS).map(([k, v]) => [v, k])),
    known = new Set([
      'setFillRGBColor',
      'setStrokeRGBColor',
      'transform',
      'save',
      'restore',
      'paintFormXObjectBegin',
      'paintFormXObjectEnd',
      'setLineJoin',
      'setLineWidth',
      'constructPath',
      'setGState',
      'dependency',
      'paintImageXObject',
      'beginText',
      'setFont',
      'moveText',
      'showText',
      'endText',
      'setTextMatrix',
      'setLineCap',
      'clip',
      'eoClip',
      'beginMarkedContentProps',
      'endMarkedContent',
      'setDash',
      'setMiterLimit',
      'setTextRenderingMode'
    ])

  try {
    if (
      viewport.scale !== 1 ||
      viewport.rotation !== 0 ||
      selected.size !== 2 ||
      ops.fnArray.length !== ops.argsArray.length ||
      ops.fnArray.length > 100000 ||
      content.items.length > 10000
    )
      return
    const ids = [...selected].sort((a, b) => a - b),
      first = content.items[ids[0]],
      second = content.items[ids[1]]
    if (
      !first ||
      !second ||
      !('str' in first) ||
      !('str' in second) ||
      !/^Figure\s+[1-9]\d*:$/.test(first.str) ||
      !/^[A-Z][\p{Script=Latin}\p{M}\d\s(),.'’-]+[.!?]$/u.test(second.str) ||
      (second.str.match(/\p{L}{2,}/gu)?.length ?? 0) < 5 ||
      first.dir !== 'ltr' ||
      second.dir !== 'ltr' ||
      first.fontName === second.fontName
    )
      return
    let state: CaptionInkState = {
        matrix: [1, 0, 0, 1, 0, 0],
        font: '',
        form: undefined,
        ca: 1,
        blend: 'source-over',
        mask: false,
        width: 1,
        miter: 10
      },
      text = false
    const stack: (CaptionInkState & { op: number })[] = [],
      forms: CaptionInkForm[] = [],
      glyphs: { c: string; form?: number }[] = [],
      outlineKeys = new Set<string>(),
      outsidePaths: Box[] = [],
      markers: { form: number }[] = [],
      markIds = new Set<number>(),
      projectedFn = [...ops.fnArray],
      projectedArgs = [...ops.argsArray]
    for (let i = 0; i < ops.fnArray.length; i++) {
      const op = ops.fnArray[i],
        a = ops.argsArray[i]
      if (!known.has(names.get(op) ?? '')) return
      if (op === OPS.save || op === OPS.paintFormXObjectBegin) {
        if (text) return
        stack.push({ ...state, matrix: [...state.matrix], op })
        if (op === OPS.paintFormXObjectBegin) {
          if (state.form || forms.length >= 2) return
          if (a?.[0]) {
            if (!captionInkFinite(a[0], 6)) return
            state.matrix = Util.transform(state.matrix, a[0])
          }
          if (!captionInkAxis(state.matrix) || !captionInkValid(a?.[1])) return
          const bounds = captionInkBox(a[1], Util.transform(viewport.transform, state.matrix))
          if (
            !captionInkValid(bounds) ||
            bounds[0] < 0 ||
            bounds[1] < 0 ||
            bounds[2] > viewport.width ||
            bounds[3] > viewport.height
          )
            return
          state.form = { begin: i, bounds, images: [], imageSources: [] }
          forms.push(state.form)
        }
      } else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
        if (text || !stack.length) return
        const prev = stack.pop()!
        if (prev.op !== (op === OPS.restore ? OPS.save : OPS.paintFormXObjectBegin)) return
        if (op === OPS.paintFormXObjectEnd) {
          if (!state.form) return
          const closingForm = state.form
          if (markers.some((m) => m.form === closingForm.begin)) return
          state.form.end = i
        }
        state = prev
      } else if (op === OPS.transform) {
        if (text || !captionInkFinite(a, 6)) return
        state.matrix = Util.transform(state.matrix, a)
        if (!state.form && !captionInkAxis(state.matrix)) return
      } else if (op === OPS.beginText) {
        if (text) return
        text = true
      } else if (op === OPS.endText) {
        if (!text) return
        text = false
      } else if (op === OPS.setGState) {
        if (!Array.isArray(a?.[0]) || !a[0].length) return
        for (const e of a[0]) {
          if (!Array.isArray(e) || e.length !== 2) return
          const [k, v] = e
          if (['ca', 'CA'].includes(k)) {
            if (!Number.isFinite(v) || v < 0 || v > 1) return
            if (k === 'ca') state.ca = v
          } else if (k === 'BM') {
            if (v !== 'source-over') return
            state.blend = v
          } else if (k === 'SMask') {
            if (v !== false) return
            state.mask = v
          } else if (['LC', 'LJ'].includes(k)) {
            if (!Number.isInteger(v) || v < 0 || v > 2) return
          } else if (k === 'LW') {
            if (!Number.isFinite(v) || v < 0) return
            state.width = v
          } else if (k === 'ML') {
            if (!Number.isFinite(v) || v < 1) return
            state.miter = v
          } else return
        }
        if (!state.form) {
          if (state.ca !== 1 || state.blend !== 'source-over' || state.mask) return
          projectedFn[i] = OPS.dependency
          projectedArgs[i] = []
        }
      } else if (op === OPS.setTextRenderingMode) {
        if (a?.[0] !== 0) return
      } else if (op === OPS.setLineWidth) {
        if (!Number.isFinite(a?.[0]) || a[0] < 0) return
        state.width = a[0]
      } else if (op === OPS.setMiterLimit) {
        if (!Number.isFinite(a?.[0]) || a[0] < 1) return
        state.miter = a[0]
      } else if (op === OPS.setFont) {
        if (typeof a?.[0] !== 'string' || !a[0]) return
        state.font = a[0]
      } else if (op === OPS.showText) {
        if (!text || !Array.isArray(a?.[0])) return
        for (const g of a[0]) {
          if (typeof g === 'number') {
            if (!Number.isFinite(g)) return
            continue
          }
          if (typeof g?.unicode !== 'string') return
          if (state.font && typeof g.fontChar === 'string' && g.fontChar) {
            outlineKeys.add(state.font + '_path_' + g.fontChar)
            if (outlineKeys.size > 10000) return
          }
          for (const c of captionInkLetters(g.unicode)) glyphs.push({ c, form: state.form?.begin })
        }
      } else if (op === OPS.paintImageXObject) {
        if (
          !state.form ||
          typeof a?.[0] !== 'string' ||
          !Number.isInteger(a[1]) ||
          a[1] <= 0 ||
          !Number.isInteger(a[2]) ||
          a[2] <= 0
        )
          return
        const bounds = captionInkBox([0, 0, 1, 1], Util.transform(viewport.transform, state.matrix))
        if (
          !captionInkValid(bounds) ||
          state.ca !== 1 ||
          state.blend !== 'source-over' ||
          state.mask
        )
          return
        state.form.images.push(bounds)
        state.form.imageSources.push({ id: a[0], width: a[1], height: a[2] })
      } else if (op === OPS.beginMarkedContentProps) {
        if (
          !state.form ||
          !Array.isArray(a) ||
          a.length !== 2 ||
          !['P', 'Span', 'Artifact'].includes(a[0]) ||
          (a[0] === 'Artifact'
            ? a[1] != null
            : !Number.isSafeInteger(a[1]) || a[1] < 0 || markIds.has(a[1]))
        )
          return
        if (a[1] != null) markIds.add(a[1])
        markers.push({ form: state.form.begin })
      } else if (op === OPS.endMarkedContent) {
        if (!markers.length || markers.pop()!.form !== state.form?.begin) return
      } else if ([OPS.clip, OPS.eoClip].includes(op)) {
        if (!state.form) return
      } else if (op === OPS.constructPath && !state.form) {
        if (text || !Array.isArray(a?.[1]) || a[1].length !== 1 || !captionInkAxis(state.matrix))
          return
        const p = a[1][0]
        let native = nativeOutlineBox(p)
        if (
          !native &&
          a[0] === OPS.stroke &&
          captionInkFinite(p, 6) &&
          p[0] === 0 &&
          p[3] === 1 &&
          (p[1] === p[4] || p[2] === p[5])
        )
          native = [
            Math.min(p[1], p[4]),
            Math.min(p[2], p[5]),
            Math.max(p[1], p[4]),
            Math.max(p[2], p[5])
          ]
        if (!native) return
        const bounds = captionInkBox(native, Util.transform(viewport.transform, state.matrix)),
          pad = Math.max(1, state.width * Math.max(state.matrix[0], state.matrix[3]) * state.miter)
        outsidePaths.push([bounds[0] - pad, bounds[1] - pad, bounds[2] + pad, bounds[3] + pad])
      }
    }
    if (
      text ||
      stack.length ||
      markers.length ||
      forms.length !== 2 ||
      forms.some((f) => !Number.isInteger(f.end)) ||
      forms[0].end! >= forms[1].begin
    )
      return
    const chars = content.items.flatMap((r, index) =>
      'str' in r ? captionInkLetters(r.str).map((c) => ({ c, index })) : []
    )
    if (
      chars.length > 64000 ||
      chars.length !== glyphs.length ||
      chars.some((r, i) => r.c !== glyphs[i].c)
    )
      return
    const membership = new Map<number, number | null>()
    chars.forEach((r, i) => {
      const form = glyphs[i].form ?? null
      if (membership.has(r.index) && membership.get(r.index) !== form)
        throw Error('mixed native owner')
      membership.set(r.index, form)
    })
    if (ids.some((i) => membership.get(i) !== null)) return
    let body = forms[0],
      foreign = forms[1]
    const raster = forms[0],
      vector = forms[1],
      candidate = ids.map((i) => {
        const item = content.items[i]
        return 'str' in item
          ? nativeLabelRegion(item, content.styles[item.fontName], viewport, pageNumber)
          : undefined
      })
    if (candidate.some((r) => !r)) return
    const candidateBox = captionInkUnion(
      candidate.map((r) => [
        r!.x * viewport.width,
        r!.y * viewport.height,
        (r!.x + r!.width) * viewport.width,
        (r!.y + r!.height) * viewport.height
      ])
    )
    const network = vector.bounds[3] < candidateBox[1] && raster.bounds[3] < vector.bounds[1]
    if (network) {
      body = vector
      foreign = raster
      if (!captionInkClosedVectorForm(ops, viewport, body, OPS, Util)) return
    } else if (body.bounds[3] >= candidateBox[1] || candidateBox[3] >= foreign.bounds[1]) return
    if (raster.images.length !== 2 || vector.images.length) return
    const images = raster.images.toSorted(
        (a, b) => (b[2] - b[0]) * (b[3] - b[1]) - (a[2] - a[0]) * (a[3] - a[1])
      ),
      [heat, bar] = images,
      hw = heat[2] - heat[0],
      hh = heat[3] - heat[1],
      bw = bar[2] - bar[0],
      bh = bar[3] - bar[1]
    if (
      hw / hh < 0.5 ||
      hw / hh > 2 ||
      bw > hw * 0.15 ||
      bh < hh * 0.95 ||
      bh > hh * 1.05 ||
      bar[0] <= heat[2] ||
      bar[0] - heat[2] > hw * 0.2 ||
      Math.abs(bar[1] - heat[1]) > hh * 0.05
    )
      return
    const projectedContent = {
      ...content,
      items: content.items.map((r, index) =>
        membership.get(index) != null ? { ...r, str: '' } : r
      )
    }
    for (const f of forms)
      for (let i = f.begin; i <= f.end!; i++) {
        projectedFn[i] = OPS.dependency
        projectedArgs[i] = []
      }
    return {
      ids,
      body,
      foreign,
      forms,
      membership,
      outsidePaths,
      projectedContent,
      outlineKeys: [...outlineKeys],
      projectedOps: { ...ops, fnArray: projectedFn, argsArray: projectedArgs }
    }
  } catch {
    return
  }
}
/** Only complete clipped Form lifetimes become inert slots. All remaining text is checked by the
 * unchanged whole-advance glyph core; foreign owners retain their conservative Form clip boxes. */
export async function nativeIsolatedPlotCaptionInk(
  page: PDFPageProxy,
  content: CaptionInkContent,
  viewport: CaptionInkViewport,
  pageNumber: number,
  selected: ReadonlySet<number>,
  operatorSnapshot?: CaptionInkOperators
): Promise<Map<number, CaptionInkRegion> | undefined> {
  const ops = operatorSnapshot ?? (await page.getOperatorList()),
    scope = await nativeIsolatedPlotCaptionScope(content, viewport, selected, ops, pageNumber)
  if (!scope) return
  const ink = await readNativeInkRegions(
    page,
    scope.projectedContent,
    viewport,
    pageNumber,
    selected,
    scope.projectedOps
  )
  if (!ink) return
  const selectedBounds = scope.ids.flatMap((i): Box[] => {
    const r = ink.get(i)
    return r
      ? [
          [
            r.x * viewport.width,
            r.y * viewport.height,
            (r.x + r.width) * viewport.width,
            (r.y + r.height) * viewport.height
          ]
        ]
      : []
  })
  if (selectedBounds.length !== scope.ids.length) return
  const domain = captionInkUnion(selectedBounds),
    body = scope.body.bounds,
    foreign = scope.foreign.bounds
  if (
    captionInkHit(body, domain) ||
    captionInkHit(foreign, domain) ||
    body[3] >= domain[1] ||
    (scope.body.imageSources.length ? domain[3] >= foreign[1] : foreign[3] >= body[1]) ||
    scope.outsidePaths.some((b) => captionInkHit(b, domain))
  )
    return
  for (const [index, r] of ink)
    if (
      !selected.has(index) &&
      captionInkHit(
        [
          r.x * viewport.width,
          r.y * viewport.height,
          (r.x + r.width) * viewport.width,
          (r.y + r.height) * viewport.height
        ],
        domain
      )
    )
      return
  for (const [index, form] of scope.membership)
    if (form !== null) {
      const f = scope.forms.find((f) => f.begin === form)!,
        b = f.bounds
      ink.set(index, {
        page: pageNumber,
        x: b[0] / viewport.width,
        y: b[1] / viewport.height,
        width: (b[2] - b[0]) / viewport.width,
        height: (b[3] - b[1]) / viewport.height
      })
    }
  return ink
}

/** Bind actual opaque RGB image objects and bytes without exporting raster data into Source. */
export async function nativeIsolatedPlotImageEpoch(
  page: PDFPageProxy,
  scope: IsolatedPlotCaptionScope
): Promise<Readonly<{ verify: () => Promise<boolean>; current: () => boolean }> | undefined> {
  try {
    const objs = page.objs,
      get = objs?.get,
      has = objs?.has
    if (typeof get !== 'function' || typeof has !== 'function') return
    const refs: {
      source: CaptionInkImage
      image: CaptionRgbImage
      data: Uint8Array | Uint8ClampedArray
      bytes: Uint8Array
      key: string
    }[] = []
    let pixels = 0
    const digest = async (b: Uint8Array | Uint8ClampedArray): Promise<string> =>
      Array.from(
        new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(b).buffer)),
        (x) => x.toString(16).padStart(2, '0')
      ).join('')
    for (const source of scope.forms.flatMap((form) => form.imageSources)) {
      if (!objs.has(source.id)) return
      const image = objs.get(source.id),
        data = image?.data
      if (
        !image ||
        image.width !== source.width ||
        image.height !== source.height ||
        image.kind !== 2 ||
        image.bitmap != null ||
        !(data instanceof Uint8Array || data instanceof Uint8ClampedArray) ||
        !(data.buffer instanceof ArrayBuffer) ||
        data.length !== image.width * image.height * 3 ||
        (pixels += image.width * image.height) > 4000000
      )
        return
      const bytes = new Uint8Array(data)
      refs.push({ source, image, data, bytes, key: await digest(bytes) })
    }
    if (refs.length !== 2) return
    const current = (): boolean => {
      try {
        if (page.objs !== objs || objs.get !== get || objs.has !== has) return false
        for (const { source, image, data, bytes } of refs) {
          if (
            !objs.has(source.id) ||
            objs.get(source.id) !== image ||
            image.data !== data ||
            image.width !== source.width ||
            image.height !== source.height ||
            image.kind !== 2 ||
            image.bitmap != null ||
            data.length !== bytes.length
          )
            return false
          for (let i = 0; i < bytes.length; i++) if (data[i] !== bytes[i]) return false
        }
        return true
      } catch {
        return false
      }
    }
    if (!current()) return
    const verify = async (): Promise<boolean> => {
      try {
        if (page.objs !== objs || objs.get !== get || objs.has !== has) return false
        for (const { source, image, data, key } of refs) {
          if (
            !objs.has(source.id) ||
            objs.get(source.id) !== image ||
            image.data !== data ||
            image.width !== source.width ||
            image.height !== source.height ||
            image.kind !== 2 ||
            image.bitmap != null ||
            data.length !== image.width * image.height * 3 ||
            (await digest(data)) !== key
          )
            return false
        }
        return current()
      } catch {
        return false
      }
    }
    return Object.freeze({ verify, current })
  } catch {
    return
  }
}

import { OPS as algorithmOPS, Util as algorithmUtil } from 'pdfjs-dist/legacy/build/pdf.mjs'

type C = Awaited<ReturnType<PDFPageProxy['getTextContent']>>
type V = ReturnType<PDFPageProxy['getViewport']>
type O = Awaited<ReturnType<PDFPageProxy['getOperatorList']>>
type B = [number, number, number, number]
const finite = (a: unknown, n: number): a is number[] =>
  (Array.isArray(a) || ArrayBuffer.isView(a)) &&
  (a as number[]).length === n &&
  Array.from(a as number[]).every(Number.isFinite)
const box = (b: number[], m: number[]): B => {
  const ps = [b[0], b[2]].flatMap((x) =>
    [b[1], b[3]].map((y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]])
  )
  return [
    Math.min(...ps.map((p) => p[0])),
    Math.min(...ps.map((p) => p[1])),
    Math.max(...ps.map((p) => p[0])),
    Math.max(...ps.map((p) => p[1]))
  ]
}
const union = (bs: B[]): B => [
  Math.min(...bs.map((b) => b[0])),
  Math.min(...bs.map((b) => b[1])),
  Math.max(...bs.map((b) => b[2])),
  Math.max(...bs.map((b) => b[3]))
]
const intersect = (a: B, b: B): B | undefined => {
  const r: B = [
    Math.max(a[0], b[0]),
    Math.max(a[1], b[1]),
    Math.min(a[2], b[2]),
    Math.min(a[3], b[3])
  ]
  return r[0] < r[2] && r[1] < r[3] ? r : undefined
}
const letters = (s: string): string[] =>
  Array.from(s.normalize('NFD')).filter((c) => !/\s/u.test(c))
const hit = (a: B, b: B): boolean => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
const rectangle = (p: number[]): boolean =>
  p.length === 13 &&
  p[0] === 0 &&
  p[3] === 1 &&
  p[6] === 1 &&
  p[9] === 1 &&
  p[12] === 4 &&
  p[1] === p[10] &&
  p[2] === p[5] &&
  p[4] === p[7] &&
  p[8] === p[11]
/** Consume every original operation and physical primitive in the bounded page.
 * NFD is comparison only; never rewrites Source or physical glyphs. */
type AlgorithmPageProgram = {
  records: { index: number; ink: B; advance: B; form?: number }[]
  paint: { op: number; kind: string; rect: B; form?: number }[]
  rails: { op: number; rect: B; paint: B; color: string; visible: boolean }[]
  forms: { begin: number; end?: number; bounds: B }[]
  outlineKeys: string[]
  glyphs: number
}
function inspectAlgorithmPage(
  page: PDFPageProxy,
  content: C,
  viewport: V,
  ops: O
): AlgorithmPageProgram {
  const decline: (at: number, why: string) => never = (at, why) => {
    throw Error(at + ': ' + why)
  }
  if (
    viewport.scale !== 1 ||
    viewport.rotation !== 0 ||
    content.items.length > 10000 ||
    ops.fnArray.length > 100000 ||
    ops.fnArray.length !== ops.argsArray.length
  )
    decline(-1, 'budget/viewport')
  type State = {
    ctm: number[]
    font: string
    size: number
    fill: string
    stroke: string
    ca: number
    CA: number
    width: number
    miter: number
    cap: number
    dash: boolean
    clip: B
    form?: number
  }
  let s: State = {
      ctm: [1, 0, 0, 1, 0, 0],
      font: '',
      size: 0,
      fill: '#000000',
      stroke: '#000000',
      ca: 1,
      CA: 1,
      width: 1,
      miter: 10,
      cap: 0,
      dash: false,
      clip: [0, 0, viewport.width, viewport.height]
    },
    text = false,
    pending = false,
    m = [1, 0, 0, 1, 0, 0],
    x = 0,
    y = 0,
    lx = 0,
    ly = 0,
    coords = 0,
    outlineBytes = 0
  const saves: { op: number; s: State }[] = [],
    forms: { begin: number; end?: number; bounds: B }[] = [],
    glyphs: {
      char: string
      font: string
      transform: number[]
      advance: B
      ink: B
      form?: number
    }[] = [],
    paint: { op: number; kind: string; rect: B; form?: number }[] = [],
    rails: { op: number; rect: B; paint: B; color: string; visible: boolean }[] = [],
    outlineKeys = new Set<string>(),
    fontIds = new Set<string>()
  const safeRgb = (a: unknown): boolean => typeof a === 'string' && /^#[0-9a-f]{6}$/iu.test(a)
  for (let i = 0; i < ops.fnArray.length; i++) {
    const op = ops.fnArray[i],
      a = ops.argsArray[i]
    if (op === algorithmOPS.save || op === algorithmOPS.paintFormXObjectBegin) {
      if (text || pending) decline(i, 'nested text/pending clip')
      saves.push({ op, s: { ...s, ctm: [...s.ctm], clip: [...s.clip] } })
      if (op === algorithmOPS.paintFormXObjectBegin) {
        if (s.form !== undefined || forms.length >= 1) decline(i, 'nested/repeated foreign Form')
        if (a?.[0]) {
          if (!finite(a[0], 6)) decline(i, 'Form matrix')
          s.ctm = algorithmUtil.transform(s.ctm, a[0])
        }
        if (
          !finite(a?.[1], 4) ||
          s.ctm[1] !== 0 ||
          s.ctm[2] !== 0 ||
          s.ctm[0] <= 0 ||
          s.ctm[3] <= 0
        )
          decline(i, 'Form bbox/axis')
        const b = box(Array.from(a[1]), algorithmUtil.transform(viewport.transform, s.ctm))
        if (b[0] < 0 || b[1] < 0 || b[2] > viewport.width || b[3] > viewport.height)
          decline(i, 'Form outside viewport')
        const clip = intersect(s.clip, b)
        if (!clip) decline(i, 'empty Form clip')
        s.clip = clip
        s.form = i
        forms.push({ begin: i, bounds: b })
      }
    } else if (op === algorithmOPS.restore || op === algorithmOPS.paintFormXObjectEnd) {
      if (text || pending || !saves.length) decline(i, 'unbalanced end')
      const z = saves.pop()!
      if (
        z.op !==
        (op === algorithmOPS.restore ? algorithmOPS.save : algorithmOPS.paintFormXObjectBegin)
      )
        decline(i, 'mismatched end')
      if (op === algorithmOPS.paintFormXObjectEnd) {
        if (s.form === undefined) decline(i, 'missing Form')
        forms.find((f) => f.begin === s.form)!.end = i
      }
      s = z.s
    } else if (op === algorithmOPS.transform) {
      if (text || !finite(a, 6)) decline(i, 'transform')
      s.ctm = algorithmUtil.transform(s.ctm, a)
      if (!s.ctm.every(Number.isFinite) || s.ctm[0] * s.ctm[3] - s.ctm[1] * s.ctm[2] === 0)
        decline(i, 'singular transform')
    } else if (op === algorithmOPS.beginText) {
      if (text || pending) decline(i, 'BT')
      text = true
      m = [1, 0, 0, 1, 0, 0]
      x = y = lx = ly = 0
    } else if (op === algorithmOPS.endText) {
      if (!text) decline(i, 'ET')
      text = false
    } else if (op === algorithmOPS.setFont) {
      if (!text || typeof a?.[0] !== 'string' || !Number.isFinite(a[1]) || a[1] <= 0)
        decline(i, 'font')
      s.font = a[0]
      s.size = a[1]
    } else if (op === algorithmOPS.moveText) {
      if (!text || !finite(a, 2)) decline(i, 'Td')
      x = lx += a[0]
      y = ly += a[1]
    } else if (op === algorithmOPS.setTextMatrix) {
      const q = a?.length === 1 ? a[0] : a
      if (!text || !finite(q, 6)) decline(i, 'Tm')
      m = Array.from(q)
      x = y = lx = ly = 0
    } else if (op === algorithmOPS.setFillRGBColor || op === algorithmOPS.setStrokeRGBColor) {
      if (!safeRgb(a?.[0])) decline(i, 'RGB')
      if (op === algorithmOPS.setFillRGBColor) s.fill = a[0]
      else s.stroke = a[0]
    } else if (op === algorithmOPS.setGState) {
      if (!Array.isArray(a?.[0])) decline(i, 'gstate')
      for (const [k, v] of a[0]) {
        if (k === 'ca' || k === 'CA') {
          if (!Number.isFinite(v) || v < 0 || v > 1) decline(i, 'alpha')
          s[k as 'ca' | 'CA'] = v
        } else if (k === 'SMask') {
          if (v !== false) decline(i, 'mask')
        } else if (k === 'BM') {
          if (!['Normal', 'source-over'].includes(v)) decline(i, 'blend')
        } else decline(i, 'unknown gstate ' + k)
      }
    } else if (op === algorithmOPS.setLineWidth) {
      if (!Number.isFinite(a?.[0]) || a[0] < 0) decline(i, 'width')
      s.width = a[0]
    } else if (op === algorithmOPS.setLineCap) {
      if (![0, 1, 2].includes(a?.[0])) decline(i, 'cap')
      s.cap = a[0]
    } else if (op === algorithmOPS.setLineJoin) {
      if (![0, 1, 2].includes(a?.[0])) decline(i, 'join')
    } else if (op === algorithmOPS.setMiterLimit) {
      if (!Number.isFinite(a?.[0]) || a[0] < 1) decline(i, 'miter')
      s.miter = a[0]
    } else if (op === algorithmOPS.setDash) {
      if (!Array.isArray(a?.[0]) || !a[0].every(Number.isFinite) || !Number.isFinite(a[1]))
        decline(i, 'dash')
      s.dash = a[0].length !== 0 || a[1] !== 0
    } else if (op === algorithmOPS.showText) {
      if (
        !text ||
        !s.font ||
        !Array.isArray(a?.[0]) ||
        (s.form === undefined && (s.ca !== 1 || s.fill.toLowerCase() === '#ffffff')) ||
        !page.commonObjs.has(s.font)
      )
        decline(i, 'show state')
      const font = page.commonObjs.get(s.font),
        M = algorithmUtil.transform(s.ctm, m)
      fontIds.add(s.font)
      if (
        fontIds.size > 64 ||
        font?.missingFile !== false ||
        font.isInvalidPDFjsFont !== false ||
        font.remeasure ||
        font.vertical !== false ||
        font.isType3Font !== false ||
        font.loadedName !== s.font ||
        JSON.stringify(font.fontMatrix) !== '[0.001,0,0,0.001,0,0]'
      )
        decline(i, 'FontData')
      for (const g of a[0]) {
        if (typeof g === 'number') {
          if (!Number.isFinite(g)) decline(i, 'TJ number')
          x -= (g * s.size) / 1000
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
          g.operatorListId != null
        )
          decline(i, 'glyph')
        const cs = letters(g.unicode)
        if (!cs.length && g.isInFont === false && g.unicode === ' ' && g.width > 0) {
          x += (g.width * s.size) / 1000
          continue
        }
        if (g.isInFont !== true) decline(i, 'missing glyph')
        const key = font.loadedName + '_path_' + g.fontChar
        if (!outlineKeys.has(key))
          outlineBytes +=
            (page.commonObjs.has(key) ? (page.commonObjs.get(key)?.path?.length ?? 0) : 0) * 8
        outlineKeys.add(key)
        if (outlineKeys.size > 10000 || !page.commonObjs.has(key)) decline(i, 'outline cache')
        const p = page.commonObjs.get(key)?.path,
          outline = nativeOutlineBox(p)
        if (!cs.length) {
          if (g.isSpace !== true || !p || p.length !== 0) decline(i, 'space')
          x += (g.width * s.size) / 1000
          continue
        }
        if (!outline) decline(i, 'outline')
        if (outlineBytes > 16 * 1024 * 1024) decline(i, 'outline budget')
        const T = [
            M[0] * s.size,
            M[1] * s.size,
            M[2] * s.size,
            M[3] * s.size,
            M[4] + M[0] * x + M[2] * y,
            M[5] + M[1] * x + M[3] * y
          ],
          display = algorithmUtil.transform(viewport.transform, T),
          ink = box(outline, display),
          advance = box([0, 0, g.width / 1000, 1], display),
          physical = intersect(ink, s.clip)
        if (![...T, ...ink, ...advance].every(Number.isFinite) || !physical)
          decline(i, 'glyph geometry')
        if (s.form === undefined && physical.some((n, k) => n !== ink[k]))
          decline(i, 'owned glyph clipped')
        for (const char of cs)
          glyphs.push({ char, font: s.font, transform: T, ink: physical, advance, form: s.form })
        if (glyphs.length > 64000) decline(i, 'glyph budget')
        paint.push({ op: i, kind: 'glyph', rect: physical, form: s.form })
        x += (g.width * s.size) / 1000
      }
    } else if (op === algorithmOPS.clip || op === algorithmOPS.eoClip) {
      if (text || pending || s.form === undefined) decline(i, 'clip outside foreign Form')
      pending = true
    } else if (op === algorithmOPS.constructPath) {
      if (text || !Array.isArray(a?.[1]) || a[1].length !== 1) decline(i, 'path')
      const p = Array.from(a[1][0]) as number[]
      if ((coords += p.length) > 64000 || !p.every(Number.isFinite)) decline(i, 'path budget')
      let b = nativeOutlineBox(p)
      if (!b && p.length === 6 && p[0] === 0 && p[3] === 1)
        b = [Math.min(p[1], p[4]), Math.min(p[2], p[5]), Math.max(p[1], p[4]), Math.max(p[2], p[5])]
      if (!b) decline(i, 'path shape')
      const M = algorithmUtil.transform(viewport.transform, s.ctm),
        raw = box(b, M)
      if (pending) {
        if (a[0] !== algorithmOPS.endPath || !rectangle(p) || M[1] !== 0 || M[2] !== 0)
          decline(i, 'nonrect clip')
        const clipped = intersect(raw, s.clip)
        if (!clipped) decline(i, 'empty clip')
        s.clip = clipped
        pending = false
        continue
      }
      if (a[0] === algorithmOPS.endPath) continue
      if (
        ![
          algorithmOPS.fill,
          algorithmOPS.eoFill,
          algorithmOPS.stroke,
          algorithmOPS.closeStroke,
          algorithmOPS.fillStroke,
          algorithmOPS.eoFillStroke,
          algorithmOPS.closeFillStroke,
          algorithmOPS.closeEOFillStroke
        ].includes(a[0])
      )
        decline(i, 'paint mode')
      const stroke = [
          algorithmOPS.stroke,
          algorithmOPS.closeStroke,
          algorithmOPS.fillStroke,
          algorithmOPS.eoFillStroke,
          algorithmOPS.closeFillStroke,
          algorithmOPS.closeEOFillStroke
        ].includes(a[0]),
        pad = stroke
          ? Math.max(1, s.width * s.miter * (Math.hypot(M[0], M[1]) + Math.hypot(M[2], M[3])))
          : 0,
        physical = intersect([raw[0] - pad, raw[1] - pad, raw[2] + pad, raw[3] + pad], s.clip)
      if (!physical) decline(i, 'empty path paint')
      if (s.form === undefined) {
        if (
          a[0] !== algorithmOPS.stroke ||
          p.length !== 6 ||
          p[0] !== 0 ||
          p[3] !== 1 ||
          p[2] !== p[5] ||
          p[1] === p[4] ||
          M[1] !== 0 ||
          M[2] !== 0 ||
          s.cap !== 0 ||
          s.dash ||
          s.CA !== 1 ||
          s.width <= 0 ||
          s.stroke.toLowerCase() === '#ffffff'
        )
          decline(i, 'outside paint not solid horizontal rail')
        const half = (s.width * Math.abs(M[3])) / 2
        rails.push({
          op: i,
          rect: [raw[0], raw[1], raw[2], raw[3]],
          paint: [raw[0], raw[1] - half, raw[2], raw[3] + half],
          color: s.stroke,
          visible: true
        })
      } else paint.push({ op: i, kind: 'path', rect: physical, form: s.form })
    } else if (op === algorithmOPS.paintImageXObject) {
      if (
        text ||
        s.form === undefined ||
        typeof a?.[0] !== 'string' ||
        !Number.isSafeInteger(a[1]) ||
        a[1] <= 0 ||
        !Number.isSafeInteger(a[2]) ||
        a[2] <= 0 ||
        s.ca !== 1
      )
        decline(i, 'image')
      const physical = intersect(
        box([0, 0, 1, 1], algorithmUtil.transform(viewport.transform, s.ctm)),
        s.clip
      )
      if (!physical) decline(i, 'image bbox')
      paint.push({ op: i, kind: 'image', rect: physical, form: s.form })
    } else if (op === algorithmOPS.dependency) {
      if (!Array.isArray(a) || a.some((v) => typeof v !== 'string')) decline(i, 'dependency')
    } else decline(i, 'unknown operator ' + op)
  }
  if (
    text ||
    pending ||
    saves.length ||
    forms.length !== 1 ||
    forms.some((f) => !Number.isSafeInteger(f.end))
  )
    decline(-1, 'unclosed program')
  const records: { index: number; ink: B; advance: B; form?: number }[] = []
  let offset = 0
  for (const [index, item] of content.items.entries()) {
    if (!('str' in item) || !item.str.trim()) continue
    const cs = letters(item.str),
      part = glyphs.slice(offset, offset + cs.length)
    offset += cs.length
    if (
      !part.length ||
      part.map((g) => g.char).join('') !== cs.join('') ||
      part.some((g) => g.font !== item.fontName || g.form !== part[0].form) ||
      item.dir !== 'ltr' ||
      content.styles[item.fontName]?.vertical !== false ||
      !finite(item.transform, 6) ||
      item.transform.some((n, k) => Math.abs(n - part[0].transform[k]) > 0.02)
    )
      decline(index, 'Source/glyph literal/font/transform')
    records.push({
      index,
      ink: union(part.map((g) => g.ink)),
      advance: union(part.map((g) => g.advance)),
      form: part[0].form
    })
  }
  if (offset !== glyphs.length) decline(-1, 'unclaimed glyphs')
  return { records, paint, rails, forms, outlineKeys: [...outlineKeys], glyphs: glyphs.length }
}

/** A separate complete algorithm-caption program. Foreign Form paint, including
 * every glyph/image/path, is interpreted and clipped before being excluded.
 * The original algorithm ink reader and all of its admission guards are unchanged. */
export async function nativeAlgorithmCaptionInk(
  page: PDFPageProxy,
  content: C,
  viewport: V,
  pageNumber: number,
  selected: ReadonlySet<number>,
  operatorSnapshot?: O
): Promise<Map<number, NonNullable<ReturnType<typeof nativeLabelRegion>>> | undefined> {
  try {
    const ops = operatorSnapshot ?? (await page.getOperatorList()),
      p = inspectAlgorithmPage(page, content, viewport, ops)
    if (!selected.size || selected.size > 256) return
    const groups = new Map<string, typeof p.rails>()
    for (const r of p.rails) {
      const key = [r.rect[0], r.rect[2]].join(',')
      groups.set(key, [...(groups.get(key) ?? []), r])
    }
    let accepted = 0
    for (const rails of groups.values()) {
      rails.sort((a, b) => a.rect[1] - b.rect[1])
      if (rails.length !== 3 || rails[0].rect[2] - rails[0].rect[0] >= viewport.width * 0.95)
        continue
      const em = Math.max(
        ...[...selected].map((i) => ('str' in content.items[i] ? content.items[i].height : NaN))
      )
      if (!Number.isFinite(em) || em <= 0) continue
      // Existing tenth-em caption hanging alignment is flow only. Original Source,
      // physical glyph bounds and the native rule endpoints remain unchanged.
      const captionBox: B = [
          rails[0].rect[0] - em * 0.1,
          rails[0].paint[3],
          rails[0].rect[2] + em * 0.1,
          rails[1].paint[1]
        ],
        bodyBox: B = [captionBox[0], rails[1].paint[3], captionBox[2], rails[2].paint[1]],
        domain: B = [captionBox[0], rails[0].paint[1], captionBox[2], rails[2].paint[3]],
        inside = (a: B, b: B): boolean =>
          a[0] >= b[0] && a[1] >= b[1] && a[2] <= b[2] && a[3] <= b[3]
      if (
        p.forms.some((f) => hit(f.bounds, domain)) ||
        p.paint.some((x) => x.form !== undefined && hit(x.rect, domain))
      )
        continue
      const caption = p.records.filter((r) => inside(r.ink, captionBox)),
        body = p.records.filter((r) => inside(r.ink, bodyBox))
      if (
        caption.length !== selected.size ||
        caption.some((r) => !selected.has(r.index) || r.form !== undefined) ||
        !body.length ||
        body.some((r) => r.form !== undefined) ||
        p.records.some(
          (r) =>
            (hit(r.ink, captionBox) && !caption.includes(r)) ||
            (hit(r.ink, bodyBox) && !body.includes(r))
        )
      )
        continue
      const item = (i: number): import('pdfjs-dist/types/src/display/api.js').TextItem =>
          content.items[i] as import('pdfjs-dist/types/src/display/api.js').TextItem,
        captionText = caption.map((r) => item(r.index).str).join(' '),
        first = item(caption[0].index)
      if (
        !/^Algorithm\s+[1-9]\d*\b/u.test(captionText) ||
        caption.some((r, n) => n > 0 && r.index <= caption[n - 1].index) ||
        body[0].index <= caption.at(-1)!.index
      )
        continue
      const complete = [...caption, ...body].every((r) => {
        const i = item(r.index)
        if (
          i.dir !== 'ltr' ||
          i.transform[0] <= 0 ||
          i.transform[1] !== 0 ||
          i.transform[2] !== 0 ||
          i.transform[3] !== i.height ||
          i.width <= 0 ||
          i.height <= 0
        )
          return false
        const expected = box(
          [0, 0, i.width / i.transform[0], 1],
          algorithmUtil.transform(viewport.transform, i.transform)
        )
        return expected.every((x, k) => Math.abs(x - r.advance[k]) <= 0.02)
      })
      if (!complete) continue
      const markers = body.filter((r) => /^[1-9]\d{0,2}:$/u.test(item(r.index).str)),
        preludes = body.filter((r) => r.index < (markers[0]?.index ?? -1)),
        controls = new Set(body.map((r) => item(r.index).str.trim()))
      if (
        markers.length < 3 ||
        markers.length > 256 ||
        markers.some(
          (r, n) =>
            Number(item(r.index).str.slice(0, -1)) !== n + 1 ||
            (n > 0 && (r.index <= markers[n - 1].index || r.ink[1] <= markers[n - 1].ink[1]))
        ) ||
        !preludes.some((r) => item(r.index).str === 'Require:') ||
        !preludes.some((r) => item(r.index).str === 'Ensure:') ||
        !controls.has('return') ||
        !['if', 'for', 'while'].some((t) => controls.has(t))
      )
        continue
      if (rails.some((r) => p.paint.some((g) => hit(g.rect, r.paint)))) continue
      // All other exterior primitives are explicitly observed horizontal strokes;
      // none may cross the caption/body domain or its three visible separators.
      if (p.rails.some((r) => !rails.includes(r) && hit(r.paint, domain))) continue
      if (caption.some((r) => Math.abs(item(r.index).height - first.height) > first.height * 0.25))
        continue
      accepted++
    }
    if (accepted !== 1) return
    return new Map(
      p.records.map((r) => [
        r.index,
        {
          page: pageNumber,
          x: r.ink[0] / viewport.width,
          y: r.ink[1] / viewport.height,
          width: (r.ink[2] - r.ink[0]) / viewport.width,
          height: (r.ink[3] - r.ink[1]) / viewport.height
        }
      ])
    )
  } catch {
    return
  }
}

type TerminalPlotScope = Readonly<{
  forms: readonly Readonly<{
    begin: number
    end?: number
    bounds: Readonly<Box>
    paths: number
    glyphs: number
  }>[]
  membership: ReadonlyMap<number, number | null>
  sourceTextEnds: ReadonlyMap<number, number>
}>
const terminalPlotScopes = new WeakMap<Map<number, CaptionInkRegion>, TerminalPlotScope>()
const copyTerminalPlotScope = (scope: TerminalPlotScope): TerminalPlotScope =>
  Object.freeze({
    forms: Object.freeze(
      scope.forms.map((form) =>
        Object.freeze({ ...form, bounds: Object.freeze([...form.bounds] as Box) })
      )
    ),
    membership: new Map(scope.membership),
    sourceTextEnds: new Map(scope.sourceTextEnds)
  })
export function nativeTerminalPlotScope(
  regions: Map<number, CaptionInkRegion>
): TerminalPlotScope | undefined {
  const scope = terminalPlotScopes.get(regions)
  return scope && copyTerminalPlotScope(scope)
}
export function carryNativeTerminalPlotScope(
  from: Map<number, CaptionInkRegion>,
  to: Map<number, CaptionInkRegion>
): void {
  const scope = terminalPlotScopes.get(from)
  if (
    scope &&
    from.size === to.size &&
    [...from].every(([index, region]) => JSON.stringify(to.get(index)) === JSON.stringify(region))
  )
    terminalPlotScopes.set(to, copyTerminalPlotScope(scope))
}

/** A terminal float's complete Form clip isolates its original-only drawing.
 * No Form paint becomes a crop certificate. Only the exterior native caption
 * uses the unchanged complete-advance glyph proof. */
export async function nativeTerminalPlotCaptionInk(
  page: PDFPageProxy,
  content: CaptionInkContent,
  viewport: CaptionInkViewport,
  pageNumber: number,
  selected: ReadonlySet<number>,
  operatorSnapshot?: CaptionInkOperators
): Promise<Map<number, CaptionInkRegion> | undefined> {
  try {
    const { OPS, Util } = await import('pdfjs-dist/legacy/build/pdf.mjs'),
      ops = operatorSnapshot ?? (await page.getOperatorList())
    if (
      viewport.scale !== 1 ||
      viewport.rotation !== 0 ||
      !captionInkFinite(viewport.transform, 6) ||
      !Number.isFinite(viewport.width) ||
      viewport.width <= 0 ||
      !Number.isFinite(viewport.height) ||
      viewport.height <= 0 ||
      content.items.length > 10000 ||
      ops.fnArray.length > 100000 ||
      ops.fnArray.length !== ops.argsArray.length
    )
      return
    type Form = { begin: number; end?: number; bounds: Box; paths: number; glyphs: number }
    type State = { matrix: number[]; font: string; top?: Form; ca: number; strokeAlpha: number }
    let state: State = { matrix: [1, 0, 0, 1, 0, 0], font: '', ca: 1, strokeAlpha: 1 },
      text = false,
      pendingClip = false,
      textGlyphStart = 0,
      paths = 0,
      pathBytes = 0
    const stack: (State & { op: number })[] = [],
      forms: Form[] = [],
      glyphs: { c: string; form: number | null; font: string }[] = [],
      textGlyphEnds = new Map<number, number>(),
      projectedFn = [...ops.fnArray],
      projectedArgs = [...ops.argsArray]
    const path = (args: unknown[]): boolean => {
      const values = (args?.[1] as ArrayLike<ArrayLike<number>>)?.[0]
      if (
        !values ||
        !captionInkFinite(args[2], 4) ||
        args[2][0] > args[2][2] ||
        args[2][1] > args[2][3] ||
        !Number.isSafeInteger(values.length) ||
        !values.length ||
        ++paths > 4096 ||
        (pathBytes += values.length * 8) > 16 * 1024 * 1024
      )
        return false
      let n = 0
      while (n < values.length) {
        const count =
          values[n] === 0 || values[n] === 1
            ? 3
            : values[n] === 2
              ? 7
              : values[n] === 3
                ? 5
                : values[n] === 4
                  ? 1
                  : 0
        if (!count || n + count > values.length) return false
        for (let k = 0; k < count; k++) if (!Number.isFinite(values[n + k])) return false
        n += count
      }
      return [
        OPS.stroke,
        OPS.closeStroke,
        OPS.fill,
        OPS.eoFill,
        OPS.fillStroke,
        OPS.eoFillStroke,
        OPS.closeFillStroke,
        OPS.closeEOFillStroke,
        OPS.endPath
      ].includes(args[0] as number)
    }
    const pattern = (a: unknown[]): boolean => {
      if (
        a.length !== 9 ||
        a[0] !== 'TilingPattern' ||
        a[1] !== null ||
        !captionInkAxis(a[3] as number[]) ||
        !captionInkValid(a[4]) ||
        a[4][0] !== 0 ||
        a[4][1] !== 0 ||
        a[5] !== a[4][2] ||
        a[6] !== a[4][3] ||
        a[7] !== 1 ||
        a[8] !== 1
      )
        return false
      const program = a[2] as CaptionInkOperators,
        b = a[4],
        background = program?.fnArray?.length === 6,
        expected = background
          ? [
              OPS.setStrokeRGBColor,
              OPS.setFillRGBColor,
              OPS.constructPath,
              OPS.setFillRGBColor,
              OPS.setLineWidth,
              OPS.constructPath
            ]
          : [OPS.setStrokeRGBColor, OPS.setFillRGBColor, OPS.setLineWidth, OPS.constructPath]
      if (
        !Array.isArray(program?.fnArray) ||
        program.fnArray.length !== expected.length ||
        program.fnArray.length !== program.argsArray?.length ||
        program.fnArray.some((op, n) => op !== expected[n])
      )
        return false
      if (background) {
        const rectangle = program.argsArray[2]?.[1]?.[0]
        if (
          program.argsArray[2]?.[0] !== OPS.fill ||
          !captionInkFinite(rectangle, 13) ||
          JSON.stringify(Array.from(rectangle)) !==
            JSON.stringify([0, b[0], b[1], 1, b[2], b[1], 1, b[2], b[3], 1, b[0], b[3], 4])
        )
          return false
      }
      const linesArgs = program.argsArray[background ? 5 : 3],
        lines = linesArgs?.[1]?.[0],
        widthArgs = program.argsArray[background ? 4 : 2]
      if (
        ![OPS.stroke, OPS.fillStroke].includes(linesArgs?.[0]) ||
        !lines ||
        lines.length < 18 ||
        lines.length > 384 ||
        lines.length % 6 ||
        widthArgs?.[0] > Math.min(b[2], b[3]) * 0.1
      )
        return false
      let positive = 0
      while (positive < lines.length / 6 && lines[positive * 6 + 5] > lines[positive * 6 + 2])
        positive++
      const groups = lines.length / 6 === positive ? 1 : 2
      if (positive < 3 || lines.length !== positive * groups * 6) return false
      for (let group = 0; group < groups; group++)
        for (let n = 0; n < positive; n++) {
          const at = (group * positive + n) * 6,
            x = -b[2] / 2 + (n * b[2]) / (positive - 1),
            y = group ? b[3] + (x / b[2]) * b[3] : (-x / b[2]) * b[3],
            want = [
              0,
              Math.fround(x),
              Math.fround(y),
              1,
              Math.fround(x + b[2]),
              Math.fround(y + (group ? -b[3] : b[3]))
            ]
          if (want.some((value, k) => !Number.isFinite(value) || lines[at + k] !== value))
            return false
        }
      return program.fnArray.every((op, n) => {
        const args = program.argsArray[n]
        if (op === OPS.setFillRGBColor || op === OPS.setStrokeRGBColor)
          return typeof args?.[0] === 'string' && /^#[0-9a-f]{6}$/iu.test(args[0])
        if (op === OPS.setLineWidth) return Number.isFinite(args?.[0]) && args[0] > 0
        if (op === OPS.constructPath) return path(args)
        return false
      })
    }
    for (let i = 0; i < ops.fnArray.length; i++) {
      const op = ops.fnArray[i],
        a = ops.argsArray[i]
      if (pendingClip && op !== OPS.constructPath) return
      if (op === OPS.save || op === OPS.paintFormXObjectBegin) {
        if (text || stack.length >= 32) return
        stack.push({ ...state, matrix: [...state.matrix], op })
        if (op === OPS.paintFormXObjectBegin) {
          if (a?.[0]) {
            if (!captionInkFinite(a[0], 6)) return
            state.matrix = Util.transform(state.matrix, a[0])
            if (!captionInkFinite(state.matrix, 6)) return
          }
          if (!captionInkValid(a?.[1])) return
          if (!state.top) {
            if (forms.length >= 2 || !captionInkAxis(state.matrix)) return
            const display = Util.transform(viewport.transform, state.matrix)
            if (!captionInkFinite(display, 6)) return
            const bounds = captionInkBox(a[1], display)
            if (
              !captionInkValid(bounds) ||
              bounds[0] < 0 ||
              bounds[1] < 0 ||
              bounds[2] > viewport.width ||
              bounds[3] > viewport.height
            )
              return
            state.top = { begin: i, bounds, paths: 0, glyphs: 0 }
            forms.push(state.top)
          }
        }
      } else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
        if (text || !stack.length) return
        const previous = stack.pop()!
        if (previous.op !== (op === OPS.restore ? OPS.save : OPS.paintFormXObjectBegin)) return
        if (op === OPS.paintFormXObjectEnd && state.top !== previous.top) state.top!.end = i
        state = previous
      } else if (op === OPS.transform) {
        if (text || !captionInkFinite(a, 6)) return
        state.matrix = Util.transform(state.matrix, a)
        if (!captionInkFinite(state.matrix, 6)) return
        if (!state.top && !captionInkAxis(state.matrix)) return
      } else if (op === OPS.beginText) {
        if (text) return
        text = true
        textGlyphStart = glyphs.length
      } else if (op === OPS.endText) {
        if (!text) return
        if (!state.top && glyphs.length > textGlyphStart) textGlyphEnds.set(glyphs.length - 1, i)
        text = false
      } else if (op === OPS.setFont) {
        if (!text || typeof a?.[0] !== 'string' || !a[0] || !Number.isFinite(a[1]) || a[1] <= 0)
          return
        state.font = a[0]
      } else if (op === OPS.showText) {
        if (!text || !state.font || !Array.isArray(a?.[0])) return
        for (const g of a[0]) {
          if (typeof g === 'number') {
            if (!Number.isFinite(g)) return
            continue
          }
          if (
            typeof g?.unicode !== 'string' ||
            typeof g.fontChar !== 'string' ||
            g.unicode.length > 64000 ||
            (/\S/u.test(g.unicode) && g.isInFont !== true) ||
            !Number.isFinite(g.width) ||
            g.width < 0 ||
            g.accent != null ||
            g.operatorListId != null ||
            g.vmetric != null
          )
            return
          for (const c of g.unicode.normalize('NFD'))
            if (!/\s/u.test(c)) {
              if (glyphs.length >= 64000) return
              glyphs.push({ c, form: state.top?.begin ?? null, font: state.font })
              if (state.top) state.top.glyphs++
            }
        }
      } else if (op === OPS.setGState) {
        if (!Array.isArray(a?.[0]) || !a[0].length) return
        for (const e of a[0]) {
          if (!Array.isArray(e) || e.length !== 2) return
          const [key, value] = e
          if (key === 'ca' || key === 'CA') {
            if (!Number.isFinite(value) || value < 0 || value > 1) return
            if (key === 'ca') state.ca = value
            else state.strokeAlpha = value
          } else if (key === 'BM') {
            if (value !== 'source-over') return
          } else if (key === 'SMask') {
            if (value !== false) return
          } else if (key === 'LW') {
            if (!Number.isFinite(value) || value < 0) return
          } else if (key === 'LC' || key === 'LJ') {
            if (!Number.isInteger(value) || value < 0 || value > 2) return
          } else if (key === 'ML') {
            if (!Number.isFinite(value) || value < 1) return
          } else return
        }
        if (!state.top) {
          if (state.ca !== 1 || state.strokeAlpha !== 1) return
          projectedFn[i] = OPS.dependency
          projectedArgs[i] = []
        }
      } else if (op === OPS.clip || op === OPS.eoClip) {
        if (!state.top || text) return
        pendingClip = true
      } else if (op === OPS.constructPath) {
        // The pinned decoder emits exactly this for an empty path buffer.
        // CanvasGraphics creates an empty Path2D; it proves no drawing ink.
        if (
          state.top &&
          !text &&
          !pendingClip &&
          a?.length === 3 &&
          Array.isArray(a[1]) &&
          a[1].length === 1 &&
          a[1][0] === null &&
          a[2] === null &&
          [OPS.stroke, OPS.fill, OPS.eoFill, OPS.endPath].includes(a[0])
        )
          continue
        if (text || !state.top || !path(a) || (pendingClip && a[0] !== OPS.endPath)) return
        if (!pendingClip && a[0] !== OPS.endPath) state.top.paths++
        pendingClip = false
      } else if (op === OPS.setFillColorN) {
        if (!state.top || text || !pattern(a)) return
      } else if (op === OPS.setFillRGBColor || op === OPS.setStrokeRGBColor) {
        if (typeof a?.[0] !== 'string' || !/^#[0-9a-f]{6}$/iu.test(a[0])) return
      } else if (op === OPS.setLineWidth) {
        if (!Number.isFinite(a?.[0]) || a[0] < 0) return
      } else if (op === OPS.setLineCap || op === OPS.setLineJoin) {
        if (!Number.isInteger(a?.[0]) || a[0] < 0 || a[0] > 2) return
      } else if (op === OPS.setMiterLimit) {
        if (!Number.isFinite(a?.[0]) || a[0] < 1) return
      } else if (op === OPS.setDash) {
        if (
          !Array.isArray(a?.[0]) ||
          a[0].some((n: number) => !Number.isFinite(n) || n < 0) ||
          !Number.isFinite(a[1])
        )
          return
      } else if (op === OPS.moveText) {
        if (!text || !captionInkFinite(a, 2)) return
      } else if (op === OPS.setTextMatrix) {
        if (!text || !captionInkFinite(a?.length === 1 ? a[0] : a, 6)) return
      } else if (op === OPS.setTextRenderingMode) {
        if (a?.[0] !== 0) return
      } else if (op === OPS.dependency) {
        if (!Array.isArray(a) || a.some((s: unknown) => typeof s !== 'string')) return
      } else return
    }
    if (
      text ||
      pendingClip ||
      stack.length ||
      !forms.length ||
      forms.some((f) => !Number.isInteger(f.end) || f.paths < 2 || f.glyphs < 8)
    )
      return
    const source: { c: string; index: number; font: string }[] = []
    for (const [index, item] of content.items.entries())
      if ('str' in item) {
        if (item.str.length > 64000) return
        for (const c of item.str.normalize('NFD'))
          if (!/\s/u.test(c)) {
            if (source.length >= 64000) return
            source.push({ c, index, font: item.fontName })
          }
      }
    if (source.length !== glyphs.length) return
    const membership = new Map<number, number | null>(),
      sourceTextEnds = new Map<number, number>()
    for (let i = 0; i < source.length; i++) {
      const a = source[i],
        b = glyphs[i]
      if (
        a.c !== b.c ||
        a.font !== b.font ||
        (membership.has(a.index) && membership.get(a.index) !== b.form)
      )
        return
      membership.set(a.index, b.form)
      const end = textGlyphEnds.get(i)
      if (end !== undefined && b.form === null && source[i + 1]?.index !== a.index)
        sourceTextEnds.set(a.index, end)
    }
    if ([...selected].some((i) => membership.get(i) !== null)) return
    selected = new Set([...membership].filter(([, form]) => form === null).map(([index]) => index))
    if (!selected.size) return
    for (const f of forms)
      for (let i = f.begin; i <= f.end!; i++) {
        projectedFn[i] = OPS.dependency
        projectedArgs[i] = []
      }
    const projectedContent = {
        ...content,
        items: content.items.map((item, index) =>
          membership.get(index) != null ? { ...item, str: '' } : item
        )
      },
      regions = await readNativeInkRegions(page, projectedContent, viewport, pageNumber, selected, {
        ...ops,
        fnArray: projectedFn,
        argsArray: projectedArgs
      })
    if (!regions) return
    for (const f of forms)
      for (const [index, form] of membership)
        if (form === f.begin)
          regions.set(index, {
            page: pageNumber,
            x: f.bounds[0] / viewport.width,
            y: f.bounds[1] / viewport.height,
            width: (f.bounds[2] - f.bounds[0]) / viewport.width,
            height: (f.bounds[3] - f.bounds[1]) / viewport.height
          })
    for (const i of selected) {
      const r = regions.get(i)
      if (!r) return
      const b = [
        r.x * viewport.width,
        r.y * viewport.height,
        (r.x + r.width) * viewport.width,
        (r.y + r.height) * viewport.height
      ]
      if (forms.some((f) => captionInkHit(f.bounds, b))) return
    }
    terminalPlotScopes.set(regions, copyTerminalPlotScope({ forms, membership, sourceTextEnds }))
    return regions
  } catch {
    return
  }
}
