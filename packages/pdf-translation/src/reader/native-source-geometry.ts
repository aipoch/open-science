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
