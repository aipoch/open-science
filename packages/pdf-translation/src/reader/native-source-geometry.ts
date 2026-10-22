import type { PDFPageProxy } from 'pdfjs-dist'
import type { TextItem, TextStyle } from 'pdfjs-dist/types/src/display/api.js'
import type { PdfStructureResult } from '@aipoch/pdf-structure/result'

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
