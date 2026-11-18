import type { PDFPageProxy } from 'pdfjs-dist'
import { nativeInkPageCurrent, nativeInkPageIdentity } from './native-ink-page-state.js'
import { nativeOutlineBox, nativeRectangularPath } from './native-source-geometry.js'
import { getPdfTranslationTextContent } from './text-content.js'

type Content = Awaited<ReturnType<PDFPageProxy['getTextContent']>>
type Box = [number, number, number, number]
const identity = [1, 0, 0, 1, 0, 0]
const axis = (m: readonly number[]): boolean =>
  m.length === 6 && m.every(Number.isFinite) && m[0] > 0 && m[3] > 0 && m[1] === 0 && m[2] === 0
const bounds = (b: readonly number[], m: readonly number[]): Box => [
  b[0] * m[0] + m[4],
  b[1] * m[3] + m[5],
  b[2] * m[0] + m[4],
  b[3] * m[3] + m[5]
]
const outside = (a: Box, b: Box): boolean =>
  a[2] < b[0] - 1 || a[0] > b[2] + 1 || a[3] < b[1] - 1 || a[1] > b[3] + 1

export type NativeFormBBoxExclusion = Readonly<{
  kind: 'hard-form-bbox'
  indexes: ReadonlySet<number>
  current: () => boolean
}>
const hardFormExclusions = new WeakMap<
  NativeFormBBoxExclusion,
  {
    page: PDFPageProxy
    content: Content
    viewport: ReturnType<PDFPageProxy['getViewport']>
    indexes: readonly number[]
  }
>()

export function isNativeFormBBoxExclusion(
  value: unknown,
  scope?: Readonly<{
    page: PDFPageProxy
    content: Content
    viewport: ReturnType<PDFPageProxy['getViewport']>
  }>
): value is NativeFormBBoxExclusion {
  if (typeof value !== 'object' || value === null) return false
  const proof = value as NativeFormBBoxExclusion,
    record = hardFormExclusions.get(proof)
  return (
    !!record &&
    (!scope ||
      (scope.page === record.page &&
        scope.content === record.content &&
        scope.viewport === record.viewport)) &&
    proof.indexes.size === record.indexes.length &&
    record.indexes.every((index) => proof.indexes.has(index))
  )
}

/** An inherited Form BBox rejects complete ink; later paints cannot restore it. */
export async function readNativeFormClippedText(
  page: PDFPageProxy,
  content: Content,
  viewport: ReturnType<PDFPageProxy['getViewport']>
): Promise<NativeFormBBoxExclusion | undefined> {
  try {
    if (!page.commonObjs || typeof page.getOperatorList !== 'function') return
    const { OPS, Util } = await import('pdfjs-dist/legacy/build/pdf.mjs'),
      operators = await page.getOperatorList()
    if (
      operators.fnArray.length !== operators.argsArray.length ||
      operators.fnArray.length > 100000 ||
      !operators.fnArray.includes(OPS.paintFormXObjectBegin)
    )
      return
    const snapshot = structuredClone(operators),
      keys = new Set<string>(),
      fonts: string[] = []
    let font = ''
    for (let n = 0; n < snapshot.fnArray.length; n++) {
      const op = snapshot.fnArray[n],
        a = snapshot.argsArray[n] ?? []
      if (op === OPS.setFont) font = a[0]
      else if (op === OPS.save || op === OPS.paintFormXObjectBegin) fonts.push(font)
      else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
        if (!fonts.length) return
        font = fonts.pop()!
      } else if (op === OPS.showText) {
        if (!Array.isArray(a[0])) return
        for (const g of a[0])
          if (typeof g !== 'number') {
            if (!font || typeof g?.fontChar !== 'string') return
            keys.add(`${font}_path_${g.fontChar}`)
          }
      } else if (
        op === OPS.beginGroup ||
        op === OPS.endGroup ||
        ((op === OPS.beginMarkedContentProps || op === OPS.beginMarkedContent) && a[0] === 'OC')
      )
        return
    }
    if (fonts.length || !keys.size || keys.size > 10000) return
    const current = nativeInkPageCurrent(page, content, viewport, operators, [...keys])
    if (!current?.()) return
    let state = {
      matrix: identity,
      clips: [] as Box[],
      font: '',
      size: 0,
      textMatrix: identity,
      charSpacing: 0,
      wordSpacing: 0,
      hScale: 1,
      rise: 0,
      fill: '#000000',
      mode: 0,
      inText: false,
      positioned: false,
      valid: true,
      verticalPositioned: false
    }
    const stack: { kind: 'save' | 'form'; state: typeof state }[] = [],
      sources = content.items.flatMap((item, index) =>
        'str' in item && item.str.trim() ? [{ item, index }] : []
      ),
      matched = new Map<number, { hidden: boolean }[]>(),
      uncertain = new Set<string>(),
      whollyClippedFonts = new Map<string, boolean>()
    // The PDF reader can combine or divide the runs of a font when exposing text.
    // A font is eligible only when every show on the page has proved clipped ink.
    const exhaustiveShows = !snapshot.fnArray.some((op, index) => {
      const args = snapshot.argsArray[index]
      return (
        op === OPS.showSpacedText ||
        op === OPS.nextLineShowText ||
        op === OPS.nextLineSetSpacingShowText ||
        (op === OPS.setGState &&
          (!Array.isArray(args?.[0]) ||
            args[0].some((entry: unknown[]) => entry?.[0] === 'Font'))) ||
        // A Type3 glyph may paint a nested operator list.
        (op === OPS.showText &&
          args?.[0]?.some((glyph: { operatorListId?: string }) => glyph?.operatorListId != null))
      )
    })
    let comparisons = 0
    const sourcesByText = new Map<string, typeof sources>()
    for (const source of sources) {
      const key = source.item.fontName + '\n' + source.item.str
      const entries = sourcesByText.get(key) ?? []
      entries.push(source)
      sourcesByText.set(key, entries)
    }
    const inert = new Set([
      OPS.dependency,
      OPS.setStrokeRGBColor,
      OPS.setStrokeGray,
      OPS.setStrokeCMYKColor,
      OPS.setLineWidth,
      OPS.setLineCap,
      OPS.setLineJoin,
      OPS.setMiterLimit,
      OPS.setDash,
      OPS.setLeading,
      OPS.clip,
      OPS.eoClip,
      OPS.constructPath,
      OPS.paintImageXObject,
      OPS.paintInlineImageXObject,
      OPS.paintImageMaskXObject,
      OPS.paintImageXObjectRepeat,
      OPS.paintImageMaskXObjectRepeat,
      OPS.beginMarkedContent,
      OPS.beginMarkedContentProps,
      OPS.endMarkedContent,
      OPS.markPoint,
      OPS.markPointProps
    ])
    for (let n = 0; n < snapshot.fnArray.length; n++) {
      const op = snapshot.fnArray[n],
        a = snapshot.argsArray[n] ?? []
      if (op === OPS.save || op === OPS.paintFormXObjectBegin) {
        if (stack.length >= 128 || state.inText) return
        const form = op === OPS.paintFormXObjectBegin
        stack.push({ kind: form ? 'form' : 'save', state })
        state = { ...state }
        if (form) {
          const matrix = a[0] == null ? identity : (Array.from(a[0]) as number[]),
            box = a[1] == null ? [] : (Array.from(a[1]) as number[])
          if (
            !axis(matrix) ||
            box.length !== 4 ||
            !box.every(Number.isFinite) ||
            box[0] >= box[2] ||
            box[1] >= box[3]
          )
            state.valid = false
          else {
            state.matrix = Util.transform(state.matrix, matrix)
            const clip = bounds(box, state.matrix)
            if (!clip.every(Number.isFinite)) state.valid = false
            else state.clips = [...state.clips, clip]
          }
        }
      } else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
        const before = stack.pop()
        if (!before || before.kind !== (op === OPS.restore ? 'save' : 'form') || state.inText)
          return
        state = before.state
      } else if (op === OPS.transform) {
        if (!axis(a)) state.valid = false
        else state.matrix = Util.transform(state.matrix, a)
      } else if (
        op === OPS.clip &&
        state.clips.length &&
        !state.inText &&
        axis(state.matrix) &&
        snapshot.fnArray[n + 1] === OPS.constructPath
      ) {
        const args = snapshot.argsArray[n + 1],
          paths = args?.[1]
        // Only the actual typed rectangle consumed by this clip can restrict
        // inherited Form ink. The renderer's cached extent alone is insufficient.
        const rectangle =
          args?.[0] === OPS.endPath &&
          Array.isArray(paths) &&
          paths.length === 1 &&
          ArrayBuffer.isView(paths[0])
            ? nativeRectangularPath(paths)
            : undefined
        if (
          rectangle &&
          args?.[2]?.length === 4 &&
          rectangle.every((value, index) => value === args[2][index])
        ) {
          const clip = bounds(rectangle, state.matrix)
          if (clip.every(Number.isFinite)) state.clips = [...state.clips, clip]
        }
      } else if (op === OPS.beginText) {
        if (state.inText) return
        state.inText = true
        state.positioned = false
        state.verticalPositioned = false
        state.textMatrix = identity
      } else if (op === OPS.endText) {
        if (!state.inText) return
        state.inText = false
        state.positioned = false
        state.verticalPositioned = false
      } else if (op === OPS.setTextMatrix) {
        const m = Array.from(a[0] ?? []) as number[]
        state.positioned = state.inText && axis(m)
        state.verticalPositioned = state.positioned
        if (state.positioned) state.textMatrix = m
      } else if (op === OPS.moveText) {
        state.positioned =
          state.inText &&
          !state.positioned &&
          state.textMatrix === identity &&
          a.length === 2 &&
          a.every(Number.isFinite)
        state.verticalPositioned = state.positioned
        if (state.positioned) state.textMatrix = [1, 0, 0, 1, a[0], a[1]]
      } else if (op === OPS.setFont) {
        state.font = a[0]
        state.size = a[1]
      } else if (op === OPS.setCharSpacing) state.charSpacing = a[0]
      else if (op === OPS.setWordSpacing) state.wordSpacing = a[0]
      else if (op === OPS.setHScale) state.hScale = a[0] / 100
      else if (op === OPS.setTextRise) state.rise = a[0]
      else if (op === OPS.setTextRenderingMode) state.mode = a[0]
      else if (op === OPS.setFillRGBColor) state.fill = a[0]
      else if (op === OPS.setFillGray) state.fill = a[0] === 0 ? '#000000' : ''
      else if (op === OPS.setFillCMYKColor) state.fill = ''
      else if (op === OPS.showText) {
        if (!Array.isArray(a[0])) return
        const glyphs = a[0],
          literal = glyphs
            .map((g) =>
              typeof g === 'number' ? '' : typeof g?.unicode === 'string' ? g.unicode : '\u0000'
            )
            .join(''),
          key = state.font + '\n' + literal.trim(),
          positioned = state.positioned
        state.positioned = false
        if (exhaustiveShows && state.font && whollyClippedFonts.get(state.font) !== false) {
          const font = page.commonObjs.has(state.font) ? page.commonObjs.get(state.font) : undefined
          const matrix = Util.transform(state.matrix, state.textMatrix)
          // In an axis-aligned horizontal text object, successive shows can
          // change x without changing either of these vertical ink bounds.
          const clip =
            state.valid &&
            state.inText &&
            state.verticalPositioned &&
            axis(matrix) &&
            state.fill === '#000000' &&
            state.mode === 0 &&
            Number.isFinite(state.size) &&
            state.size > 0 &&
            Number.isFinite(state.hScale) &&
            state.hScale > 0 &&
            Number.isFinite(state.rise) &&
            font?.loadedName === state.font &&
            font.missingFile === false &&
            font.isInvalidPDFjsFont === false &&
            font.isType3Font === false &&
            font.vertical === false &&
            !font.remeasure &&
            !font.systemFontInfo &&
            JSON.stringify(font.fontMatrix) === '[0.001,0,0,0.001,0,0]' &&
            state.clips.some((clip) => {
              return glyphs.every((glyph) => {
                if (typeof glyph === 'number') return Number.isFinite(glyph)
                if (
                  !glyph ||
                  typeof glyph.unicode !== 'string' ||
                  typeof glyph.fontChar !== 'string' ||
                  !glyph.fontChar ||
                  !Number.isFinite(glyph.width) ||
                  glyph.width < 0 ||
                  glyph.accent != null ||
                  glyph.vmetric != null ||
                  glyph.operatorListId != null ||
                  (glyph.unicode.trim() && glyph.isInFont !== true)
                )
                  return false
                const key = `${font.loadedName}_path_${glyph.fontChar}`
                if (!keys.has(key) || !page.commonObjs.has(key)) return false
                const path = page.commonObjs.get(key)?.path,
                  outline = nativeOutlineBox(path)
                if (!outline) return !glyph.unicode.trim() && !path?.length
                const y = matrix[5] + matrix[3] * state.rise,
                  scale = matrix[3] * state.size
                return y + outline[3] * scale < clip[1] - 1 || y + outline[1] * scale > clip[3] + 1
              })
            })
          whollyClippedFonts.set(state.font, !!clip)
        }
        if (!literal.trim()) continue
        if (
          !state.valid ||
          !positioned ||
          !state.inText ||
          literal.includes('\u0000') ||
          !axis(state.matrix) ||
          !axis(state.textMatrix) ||
          ![state.size, state.charSpacing, state.wordSpacing, state.hScale, state.rise].every(
            Number.isFinite
          ) ||
          state.size <= 0 ||
          state.hScale <= 0
        ) {
          uncertain.add(key)
          continue
        }
        const candidates = sourcesByText.get(key) ?? []
        if ((comparisons += candidates.length) > 1000000) return
        const base = Util.transform(state.matrix, state.textMatrix),
          transform = Util.transform(base, [
            state.size * state.hScale,
            0,
            0,
            state.size,
            0,
            state.rise
          ]),
          matches = candidates.filter(
            ({ item }) =>
              item.str === literal.trim() &&
              item.fontName === state.font &&
              item.dir === 'ltr' &&
              item.transform.length === 6 &&
              item.transform.every(
                (v, i) => Number.isFinite(v) && Math.abs(v - transform[i]) < 0.002
              ) &&
              Number.isFinite(item.height) &&
              Math.abs(item.height - transform[3]) < 0.002
          )
        if (matches.length !== 1) {
          uncertain.add(key)
          continue
        }
        const source = matches[0],
          list = matched.get(source.index) ?? []
        matched.set(source.index, list)
        list.push({ hidden: false })
        if (
          !state.clips.length ||
          state.fill !== '#000000' ||
          state.mode !== 0 ||
          content.styles?.[state.font]?.vertical !== false ||
          !page.commonObjs.has(state.font)
        )
          continue
        const f = page.commonObjs.get(state.font)
        if (
          f?.loadedName !== state.font ||
          f.missingFile !== false ||
          f.isInvalidPDFjsFont !== false ||
          f.isType3Font !== false ||
          f.vertical !== false ||
          f.remeasure ||
          f.systemFontInfo ||
          JSON.stringify(f.fontMatrix) !== '[0.001,0,0,0.001,0,0]'
        )
          continue
        let x = 0,
          end = 0,
          valid = true
        const boxes: Box[] = []
        for (const g of glyphs) {
          if (typeof g === 'number') {
            if (!Number.isFinite(g)) {
              valid = false
              break
            }
            x -= (g * state.size) / 1000
            continue
          }
          if (
            !g ||
            typeof g.unicode !== 'string' ||
            !Number.isFinite(g.width) ||
            g.width < 0 ||
            g.accent != null ||
            g.vmetric != null ||
            g.operatorListId != null ||
            typeof g.fontChar !== 'string' ||
            !g.fontChar ||
            (g.unicode.trim() && g.isInFont !== true)
          ) {
            valid = false
            break
          }
          const outlineKey = `${f.loadedName}_path_${g.fontChar}`
          if (!keys.has(outlineKey) || !page.commonObjs.has(outlineKey)) {
            valid = false
            break
          }
          const path = page.commonObjs.get(outlineKey)?.path,
            outline = nativeOutlineBox(path)
          if (!outline && (g.unicode.trim() || path?.length)) {
            valid = false
            break
          }
          if (outline)
            boxes.push(
              bounds(
                outline,
                Util.transform(base, [
                  state.size * state.hScale,
                  0,
                  0,
                  state.size,
                  x * state.hScale,
                  state.rise
                ])
              )
            )
          x +=
            (g.width * state.size) / 1000 + state.charSpacing + (g.isSpace ? state.wordSpacing : 0)
          if (g.unicode.trim()) end = x - state.charSpacing
        }
        if (
          !valid ||
          !boxes.length ||
          !boxes.flat().every(Number.isFinite) ||
          !Number.isFinite(end) ||
          !Number.isFinite(source.item.width) ||
          Math.abs(source.item.width - end * state.hScale * base[0]) >= 0.002
        )
          continue
        list[list.length - 1].hidden = state.clips.some((clip) =>
          boxes.every((box) => outside(box, clip))
        )
      } else if (op === OPS.setGState) {
        // The writer emits this complete default tuple even for opaque Form content.
        if (JSON.stringify(a) !== '[[["BM","source-over"],["CA",1],["ca",1]]]') state.valid = false
      } else if (!inert.has(op)) state.valid = false
    }
    if (stack.length || state.inText || !current()) return
    const indexes = new Set(
      sources
        .filter(({ item, index }) => {
          const occurrences = matched.get(index)
          return (
            whollyClippedFonts.get(item.fontName) === true ||
            (!uncertain.has(item.fontName + '\n' + item.str) &&
              occurrences?.length === 1 &&
              occurrences[0].hidden)
          )
        })
        .map(({ index }) => index)
    )
    if (!indexes.size) return
    const before = await nativeInkPageIdentity(page, content, viewport)
    if (!before || !current() || JSON.stringify(before.operators) !== JSON.stringify(snapshot))
      return
    const fresh = await getPdfTranslationTextContent(page)
    if (!current() || JSON.stringify(fresh) !== JSON.stringify(content)) return
    const after = await nativeInkPageIdentity(page, content, viewport)
    if (!current() || before.key !== after?.key) return
    const expected = [...indexes]
    const proof = Object.freeze({
      kind: 'hard-form-bbox' as const,
      indexes,
      current: () =>
        current() &&
        indexes.size === expected.length &&
        expected.every((index) => indexes.has(index))
    })
    hardFormExclusions.set(proof, { page, content, viewport, indexes: expected })
    return proof
  } catch {
    return
  }
}
