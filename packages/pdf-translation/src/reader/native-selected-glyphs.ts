import type { PDFPageProxy } from 'pdfjs-dist'
import { nativeInkPageCurrent } from './auxiliary-native-ink.js'
import { nativeOutlineBox } from './native-source-geometry.js'
type Content = Awaited<ReturnType<PDFPageProxy['getTextContent']>>
type Viewport = ReturnType<PDFPageProxy['getViewport']>
type Rect = { page: number; x: number; y: number; width: number; height: number }
export type NativeSelectedGlyph = { path: number[]; box: number[]; offset: number }
export type NativeGlyphSelection = {
  regions: Map<number, Rect>
  signatures: Map<number, unknown>
  glyphs: Map<number, NativeSelectedGlyph[]>
  current: () => boolean
}
type Glyph = {
  unicode: string
  fontChar: string
  width: number
  isInFont: boolean
  accent?: unknown
  vmetric?: unknown
  operatorListId?: unknown
}
export async function readNativeGlyphSelection(
  page: PDFPageProxy,
  content: Content,
  viewport: Viewport,
  pageNumber: number,
  selected: ReadonlySet<number>,
  snapshot?: Awaited<ReturnType<PDFPageProxy['getOperatorList']>>
): Promise<NativeGlyphSelection | undefined> {
  try {
    if (viewport.scale !== 1 || viewport.rotation !== 0 || !selected.size || selected.size > 256)
      return
    const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs'),
      ops = await page.getOperatorList(),
      before = JSON.stringify(ops),
      runs: { font: string; width: number; glyphs: { glyph: Glyph; offset: number }[] }[] = []
    if (snapshot && before !== JSON.stringify(snapshot)) return
    const stack: string[] = []
    let font = ''
    for (let n = 0; n < ops.fnArray.length; n++) {
      const op = ops.fnArray[n],
        a = ops.argsArray[n]
      if (op === OPS.setFont) font = a[0]
      else if ([OPS.save, OPS.paintFormXObjectBegin, OPS.beginGroup].includes(op)) stack.push(font)
      else if ([OPS.restore, OPS.paintFormXObjectEnd, OPS.endGroup].includes(op)) {
        if (!stack.length) return
        font = stack.pop()!
      } else if (op === OPS.showText) {
        const run = { font, width: 0, glyphs: [] as { glyph: Glyph; offset: number }[] }
        for (const g of a[0]) {
          if (typeof g === 'number') {
            if (!Number.isFinite(g)) return
            run.width -= g
          } else if (g && typeof g.unicode === 'string' && Number.isFinite(g.width)) {
            run.glyphs.push({ glyph: g, offset: run.width })
            run.width += g.width
          } else return
        }
        if (run.glyphs.length) {
          const start = run.glyphs[0].offset,
            last = run.glyphs.at(-1)!
          run.width = last.offset + last.glyph.width - start
          run.glyphs = run.glyphs.map((g) => ({ ...g, offset: g.offset - start }))
          runs.push(run)
        }
      }
    }
    if (stack.length) return
    const result = new Map<number, Rect>(),
      outlineKeys = new Set<string>(),
      glyphs = new Map<number, NativeSelectedGlyph[]>(),
      signatures = new Map<number, unknown>()
    for (const index of selected) {
      const item = content.items[index]
      if (
        !item ||
        !('str' in item) ||
        item.dir !== 'ltr' ||
        item.transform.length !== 6 ||
        item.transform[0] !== item.height ||
        item.transform[3] !== item.height ||
        item.transform[1] !== 0 ||
        item.transform[2] !== 0
      )
        return
      const f = page.commonObjs.get(item.fontName)
      if (
        f?.missingFile !== false ||
        f.isInvalidPDFjsFont !== false ||
        f.isType3Font !== false ||
        f.vertical !== false ||
        JSON.stringify(f.fontMatrix) !== '[0.001,0,0,0.001,0,0]'
      )
        return
      const boxes: number[][] = [],
        chars: unknown[] = [],
        itemGlyphs: NativeSelectedGlyph[] = []
      const matching = runs.filter(
        (run) =>
          run.font === item.fontName &&
          run.glyphs
            .map((g) => g.glyph.unicode)
            .join('')
            .replace(/\s/gu, '') === item.str.replace(/\s/gu, '') &&
          Math.abs((run.width * item.height) / 1000 - item.width) < item.height * 0.025
      )
      if (!matching.length || new Set(matching.map((run) => JSON.stringify(run.glyphs))).size !== 1)
        return
      for (const { glyph: g, offset } of matching[0].glyphs) {
        const char = g.unicode
        if (
          !g ||
          g.isInFont !== true ||
          g.accent != null ||
          g.vmetric != null ||
          g.operatorListId != null ||
          !Number.isFinite(g.width) ||
          g.width < 0
        )
          return
        const key = f.loadedName + '_path_' + g.fontChar
        if (!page.commonObjs.has(key)) return
        outlineKeys.add(key)
        const path = page.commonObjs.get(key)?.path as ArrayLike<number>,
          b = nativeOutlineBox(path)
        if (!b) {
          if (!/\s/u.test(char) || path?.length) return
        } else {
          const x = item.transform[4] + (offset * item.height) / 1000,
            h = item.height,
            box = [
              x + b[0] * h,
              viewport.height - item.transform[5] - b[3] * h,
              x + b[2] * h,
              viewport.height - item.transform[5] - b[1] * h
            ]
          boxes.push(box)
          itemGlyphs.push({ path: Array.from(path), box, offset })
          chars.push([char, offset, Array.from(path)])
        }
      }
      if (!boxes.length) return
      const left = Math.min(...boxes.map((b) => b[0])),
        top = Math.min(...boxes.map((b) => b[1])),
        right = Math.max(...boxes.map((b) => b[2])),
        bottom = Math.max(...boxes.map((b) => b[3]))
      if (
        ![left, top, right, bottom].every(Number.isFinite) ||
        left < 0 ||
        top < 0 ||
        right > viewport.width ||
        bottom > viewport.height
      )
        return
      result.set(index, {
        page: pageNumber,
        x: left / viewport.width,
        y: top / viewport.height,
        width: (right - left) / viewport.width,
        height: (bottom - top) / viewport.height
      })
      signatures.set(index, [item.str, ...item.transform, item.width, chars])
      glyphs.set(index, itemGlyphs)
    }
    const current = nativeInkPageCurrent(page, content, viewport, ops, [...outlineKeys])
    if (!current || before !== JSON.stringify(await page.getOperatorList()) || !current()) return
    return { regions: result, signatures, glyphs, current }
  } catch {
    return
  }
}
