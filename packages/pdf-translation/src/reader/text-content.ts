import type { PDFPageProxy } from 'pdfjs-dist'

// A page advisory has no native text owner. Require an actual text-show outline
// and a missing map entry; never infer a character from the outline or font name.
// This deliberately handles only the first, single glyph after an explicit text
// position, with axis-aligned transforms and fully known rectangular clipping.
async function hasUnownedUnicodeGlyph(
  page: PDFPageProxy,
  content: Awaited<ReturnType<PDFPageProxy['getTextContent']>>
): Promise<boolean> {
  if (!page.commonObjs || typeof page.getOperatorList !== 'function') return false
  try {
    const { OPS, Util } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const rectangle = (value: ArrayLike<number> | undefined): number[] | undefined => {
      const r = value && Array.from(value)
      return r?.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3]
        ? r
        : undefined
    }
    const axisMatrix = (m: number[]): boolean =>
      m.length === 6 &&
      m.every(Number.isFinite) &&
      m[0] !== 0 &&
      m[3] !== 0 &&
      m[1] === 0 &&
      m[2] === 0
    const bounds = (r: number[], m: number[]): number[] => {
      const x = [r[0] * m[0] + m[4], r[2] * m[0] + m[4]]
      const y = [r[1] * m[3] + m[5], r[3] * m[3] + m[5]]
      return [Math.min(...x), Math.min(...y), Math.max(...x), Math.max(...y)]
    }
    // PDF.js FontPathInfo.path is retained with fontExtraProperties in both the
    // renderer and Node. Path2D.getBounds is Node-specific, so do not depend on it.
    // Bezier control points bound the complete curve without raster/OCR guesses.
    const outlineBounds = (path: ArrayLike<number> | undefined): number[] | undefined => {
      if (!path || !Number.isSafeInteger(path.length) || path.length > 100000) return undefined
      let left = Infinity,
        top = Infinity,
        right = -Infinity,
        bottom = -Infinity
      let moved = false,
        drawn = false
      let start = [0, 0],
        point = start,
        area = 0
      const close = (): void => {
        area += point[0] * start[1] - start[0] * point[1]
        point = start
      }
      const coefficients = (values: number[]): number[] =>
        values.length === 2
          ? [values[0], values[1] - values[0]]
          : values.length === 3
            ? [values[0], 2 * (values[1] - values[0]), values[0] - 2 * values[1] + values[2]]
            : [
                values[0],
                3 * (values[1] - values[0]),
                3 * (values[0] - 2 * values[1] + values[2]),
                -values[0] + 3 * values[1] - 3 * values[2] + values[3]
              ]
      for (let i = 0; i < path.length;) {
        const op = path[i++]
        const length = op === 0 || op === 1 ? 2 : op === 2 ? 6 : op === 3 ? 4 : op === 4 ? 0 : -1
        if (length < 0 || i + length > path.length || (op !== 0 && !moved)) return undefined
        if (op === 0) {
          if (moved) close()
          moved = true
        }
        if (op === 4) close()
        if (op >= 1 && op <= 3) drawn = true
        const points = [point]
        for (let end = i + length; i < end; i += 2) {
          const x = path[i],
            y = path[i + 1]
          if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined
          left = Math.min(left, x)
          right = Math.max(right, x)
          top = Math.min(top, y)
          bottom = Math.max(bottom, y)
          points.push([x, y])
        }
        if (op === 0) start = point = points[1]
        else if (length > 0) {
          const x = coefficients(points.map((p) => p[0])),
            y = coefficients(points.map((p) => p[1]))
          // Exact polynomial integral of x dy - y dx. Nonzero signed area
          // proves a nonempty fill; a mere diagonal/path bounding box does not.
          for (let a = 0; a < x.length; a++)
            for (let b = 1; b < y.length; b++) area += (x[a] * b * y[b] - y[a] * b * x[b]) / (a + b)
          point = points[points.length - 1]
        }
      }
      if (moved) close()
      return drawn && Number.isFinite(area) && Math.abs(area) > 1e-12
        ? rectangle([left, top, right, bottom])
        : undefined
    }
    const view = rectangle(page.view)
    if (!view) return false
    const ownerFonts = new Set(
      content.items.flatMap((item) => ('str' in item ? [item.fontName] : []))
    )
    const identity = [1, 0, 0, 1, 0, 0]
    let state = {
      matrix: identity,
      clip: view,
      font: '',
      size: 0,
      safe: true,
      mode: 0,
      alpha: 1,
      hScale: 1,
      rise: 0,
      textMatrix: identity,
      x: 0,
      y: 0,
      positioned: false,
      inText: false
    }
    const stack: { kind: number; state: typeof state }[] = []
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
      OPS.setCharSpacing,
      OPS.setWordSpacing,
      OPS.setLeading,
      OPS.constructPath,
      OPS.endPath,
      OPS.stroke,
      OPS.closeStroke,
      OPS.fill,
      OPS.eoFill,
      OPS.fillStroke,
      OPS.eoFillStroke,
      OPS.closeFillStroke,
      OPS.closeEOFillStroke,
      OPS.paintImageXObject,
      OPS.paintInlineImageXObject,
      OPS.paintImageMaskXObject
    ])
    const operators = await page.getOperatorList()
    if (operators.fnArray.length !== operators.argsArray.length) return false
    let found = false
    for (let index = 0; index < operators.fnArray.length; index++) {
      const op = operators.fnArray[index],
        args = operators.argsArray[index] ?? []
      if (op === OPS.save || op === OPS.paintFormXObjectBegin || op === OPS.beginGroup) {
        stack.push({ kind: op, state })
        state = { ...state }
        if (op === OPS.beginGroup) state.safe = false
        if (op === OPS.paintFormXObjectBegin) {
          const m = args[0] === null ? identity : (Array.from(args[0] ?? []) as number[])
          const r = rectangle(args[1])
          if (!axisMatrix(m) || !r) state.safe = false
          else {
            state.matrix = Util.transform(state.matrix, m)
            const b = bounds(r, state.matrix)
            state.clip = [
              Math.max(b[0], state.clip[0]),
              Math.max(b[1], state.clip[1]),
              Math.min(b[2], state.clip[2]),
              Math.min(b[3], state.clip[3])
            ]
          }
        }
      } else if ([OPS.restore, OPS.paintFormXObjectEnd, OPS.endGroup].includes(op)) {
        const prior = stack.pop()
        const expected =
          op === OPS.restore
            ? OPS.save
            : op === OPS.paintFormXObjectEnd
              ? OPS.paintFormXObjectBegin
              : OPS.beginGroup
        if (prior?.kind !== expected) return false
        state = prior.state
      } else if (op === OPS.transform) {
        if (!axisMatrix(args)) state.safe = false
        else state.matrix = Util.transform(state.matrix, args)
      } else if (op === OPS.setFont) {
        state.font = args[0]
        state.size = args[1]
      } else if (op === OPS.setGState) {
        for (const [key, value] of args[0] ?? []) {
          if (key === 'Font') {
            state.font = value[0]
            state.size = value[1]
          } else if (key === 'ca') state.alpha = value
          else if (key === 'SMask') {
            if (value !== false) state.safe = false
          } else if (key === 'BM') {
            if (value !== 'source-over') state.safe = false
          } else if (!['CA', 'LW', 'LC', 'LJ', 'ML', 'D', 'RI', 'FL'].includes(key))
            state.safe = false
        }
      } else if (op === OPS.beginText) {
        state.textMatrix = identity
        state.x = state.y = 0
        state.positioned = false
        state.inText = true
      } else if (op === OPS.endText) {
        state.inText = false
        state.positioned = false
      } else if (op === OPS.setTextMatrix) {
        state.textMatrix = args
        state.x = state.y = 0
        state.positioned = axisMatrix(args)
      } else if (op === OPS.moveText) {
        state.x += args[0]
        state.y += args[1]
        state.positioned = Number.isFinite(state.x) && Number.isFinite(state.y)
      } else if (op === OPS.setTextRenderingMode) {
        state.mode = args[0]
        if (!Number.isInteger(state.mode) || state.mode < 0 || state.mode >= 4) state.safe = false
      } else if (op === OPS.setHScale) state.hScale = args[0] / 100
      else if (op === OPS.setTextRise) state.rise = args[0]
      else if ([OPS.setFillRGBColor, OPS.setFillGray, OPS.setFillCMYKColor].includes(op)) {
        // Solid fill is supported; pattern/color-space state is rejected below.
      } else if (op === OPS.showText) {
        const positioned = state.positioned
        state.positioned = false
        const glyph = args[0]?.length === 1 ? args[0][0] : undefined
        if (
          !positioned ||
          !state.inText ||
          !state.safe ||
          state.mode !== 0 ||
          state.alpha !== 1 ||
          !axisMatrix(state.matrix) ||
          !axisMatrix(state.textMatrix) ||
          !rectangle(state.clip) ||
          ![state.size, state.hScale, state.rise].every(Number.isFinite) ||
          state.size <= 0 ||
          state.hScale <= 0 ||
          ownerFonts.has(state.font) ||
          !page.commonObjs.has(state.font) ||
          !glyph ||
          typeof glyph.unicode !== 'string' ||
          glyph.unicode.trim() ||
          glyph.isInFont !== true ||
          glyph.isSpace === true ||
          glyph.accent ||
          !Number.isSafeInteger(glyph.originalCharCode) ||
          glyph.originalCharCode < 0 ||
          glyph.originalCharCode > 65535 ||
          glyph.unicode !== String.fromCharCode(glyph.originalCharCode) ||
          typeof glyph.fontChar !== 'string' ||
          !glyph.fontChar
        )
          continue
        const font = page.commonObjs.get(state.font),
          map = font?.toUnicode?._map
        if (
          font?.missingFile !== false ||
          font.isType3Font ||
          font.vertical ||
          !map ||
          typeof map !== 'object' ||
          Object.hasOwn(map, glyph.originalCharCode) ||
          map[glyph.originalCharCode] !== undefined ||
          typeof font.loadedName !== 'string' ||
          !font.loadedName
        )
          continue
        const pathId = `${font.loadedName}_path_${glyph.fontChar}`
        if (!page.commonObjs.has(pathId)) continue
        const outline = outlineBounds(page.commonObjs.get(pathId)?.path)
        if (!outline) continue
        const m = Util.transform(Util.transform(state.matrix, state.textMatrix), [
          state.size * state.hScale,
          0,
          0,
          state.size,
          state.x,
          state.y + state.rise
        ])
        const r = bounds(outline, m)
        if (
          r.every(Number.isFinite) &&
          r[0] >= state.clip[0] &&
          r[1] >= state.clip[1] &&
          r[2] <= state.clip[2] &&
          r[3] <= state.clip[3]
        )
          found = true
      } else if (
        [
          OPS.showSpacedText,
          OPS.nextLineShowText,
          OPS.nextLineSetSpacingShowText,
          OPS.nextLine,
          OPS.setLeadingMoveText
        ].includes(op)
      ) {
        state.positioned = false
        // These change the text line position, which this narrow proof does not track.
        if (op !== OPS.showSpacedText) state.textMatrix = []
      } else if (!inert.has(op)) state.safe = false
    }
    return found && stack.length === 0
  } catch {
    return false
  }
}

// Flag a CID or nonblank simple-font control that fell back to its numeric code in a font whose
// actual Unicode map is available. Character appearance or script mixing alone
// is not evidence of a broken encoding. Missing metadata is not proof either.
async function unreliableTextItems(
  page: PDFPageProxy,
  content: Awaited<ReturnType<PDFPageProxy['getTextContent']>>
): Promise<readonly number[]> {
  if (
    !page.commonObjs ||
    typeof page.getOperatorList !== 'function' ||
    !content.items.some((item) => 'str' in item && item.str.trim())
  )
    return []
  try {
    const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const operators = await page.getOperatorList()
    const streams = new Map<
      string,
      { text: string; missing: { start: number; end: number }[]; complete: boolean }
    >()
    const stack: (string | undefined)[] = []
    let current: string | undefined
    for (let index = 0; index < operators.fnArray.length; index++) {
      const op = operators.fnArray[index],
        args = operators.argsArray[index]
      if ([OPS.save, OPS.paintFormXObjectBegin, OPS.beginGroup].includes(op)) stack.push(current)
      else if ([OPS.restore, OPS.paintFormXObjectEnd, OPS.endGroup].includes(op))
        current = stack.pop()
      else if (op === OPS.setFont) current = args[0]
      else if (op === OPS.setGState) {
        for (const [key, value] of args[0] ?? []) if (key === 'Font') current = value[0]
      } else if (
        current &&
        [
          OPS.showText,
          OPS.showSpacedText,
          OPS.nextLineShowText,
          OPS.nextLineSetSpacingShowText
        ].includes(op) &&
        page.commonObjs.has(current)
      ) {
        const font = page.commonObjs.get(current),
          map = font?.toUnicode?._map
        if (!streams.has(current)) streams.set(current, { text: '', missing: [], complete: true })
        const stream = streams.get(current)!
        for (const glyph of args.flat()) {
          if (!glyph || typeof glyph !== 'object') continue
          if (typeof glyph.unicode !== 'string') {
            stream.complete = false
            continue
          }
          const text = glyph.unicode.replace(/\s/gu, '')
          const start = stream.text.length
          stream.text += text
          const simpleControl =
            font?.composite === false &&
            font.missingFile === false &&
            !font.vertical &&
            !font.isType3Font &&
            !glyph.accent &&
            !glyph.isSpace &&
            glyph.unicode.length === 1 &&
            glyph.unicode.charCodeAt(0) <= 31 &&
            map &&
            !Object.hasOwn(map, glyph.originalCharCode)
          if (
            (font?.composite !== true && !simpleControl) ||
            font.missingFile ||
            !map ||
            typeof map !== 'object' ||
            glyph.isInFont !== true ||
            !Number.isSafeInteger(glyph.originalCharCode) ||
            glyph.originalCharCode < 0 ||
            glyph.originalCharCode > 65535 ||
            !text ||
            map[glyph.originalCharCode] !== undefined ||
            glyph.unicode !== String.fromCharCode(glyph.originalCharCode)
          )
            continue
          stream.missing.push({ start, end: stream.text.length })
        }
      }
    }
    // A font can map several CIDs to the same Unicode character. Align the whole
    // literal native stream before assigning particular missing-CID occurrences;
    // normalizing or matching a character set would blame unrelated text items.
    const itemsByFont = new Map<string, { index: number; start: number; end: number }[]>()
    const textByFont = new Map<string, string>()
    for (const [index, item] of content.items.entries()) {
      if (!('str' in item)) continue
      const previous = textByFont.get(item.fontName) ?? ''
      const text = item.str.replace(/\s/gu, '')
      textByFont.set(item.fontName, previous + text)
      if (!itemsByFont.has(item.fontName)) itemsByFont.set(item.fontName, [])
      itemsByFont
        .get(item.fontName)!
        .push({ index, start: previous.length, end: previous.length + text.length })
    }
    return [...streams]
      .flatMap(([name, stream]) => {
        if (!stream.complete || textByFont.get(name) !== stream.text) return []
        let rangeIndex = 0
        return (itemsByFont.get(name) ?? []).flatMap((item) => {
          while (rangeIndex < stream.missing.length && stream.missing[rangeIndex].end <= item.start)
            rangeIndex++
          const range = stream.missing[rangeIndex]
          return range && item.start < item.end && item.end > range.start ? [item.index] : []
        })
      })
      .sort((a, b) => a - b)
  } catch {
    // An optional font audit must not discard otherwise readable source text.
    return []
  }
}

// Legacy Dingbats encodings can expose glyph slots 51/55 as digits even
// though both the font and the rendered page contain check/cross marks.
// Resolve only those isolated runs in that named font, never ordinary digits.
// txsys slot 2 is multiplication. Its named font and 636-unit advance
// distinguish it from unrelated control-code encodings in other math fonts.
export async function getPdfTranslationTextContent(
  page: PDFPageProxy,
  onUnreliableItems?: (indexes: readonly number[]) => void,
  onUnownedUnicodeGlyph?: (proved: boolean) => void
): ReturnType<PDFPageProxy['getTextContent']> {
  const content = await page.getTextContent()
  const unreliable = onUnreliableItems ? await unreliableTextItems(page, content) : []
  const finish = (
    result: Awaited<ReturnType<PDFPageProxy['getTextContent']>>
  ): Awaited<ReturnType<PDFPageProxy['getTextContent']>> => {
    // A proven native repair below resolves that item's fallback. Do not retain
    // an encoding warning for a slot whose literal was actually repaired.
    onUnreliableItems?.(
      unreliable.filter((index) => {
        const before = content.items[index],
          after = result.items[index]
        return 'str' in before && 'str' in after && before.str === after.str
      })
    )
    return result
  }
  if (onUnownedUnicodeGlyph) onUnownedUnicodeGlyph(await hasUnownedUnicodeGlyph(page, content))
  const fonts = new Set(
    content.items.flatMap((item) =>
      'str' in item && (/^[37]$/u.test(item.str) || item.str === '\u0002') ? [item.fontName] : []
    )
  )
  if (!fonts.size || !page.commonObjs) return finish(content)
  if ([...fonts].some((font) => !page.commonObjs.has(font))) await page.getOperatorList()
  const dingbats = new Set(
    [...fonts].filter(
      (font) =>
        page.commonObjs.has(font) &&
        /^(?:[A-Z]{6}\+)?(?:Zapf)?Dingbats$/u.test(page.commonObjs.get(font)?.name ?? '')
    )
  )
  return finish({
    ...content,
    items: content.items.map((item) => {
      if (!('str' in item)) return item
      if (dingbats.has(item.fontName) && /^[37]$/u.test(item.str))
        return { ...item, str: item.str === '3' ? '✓' : '✗' }
      if (
        item.str === '\u0002' &&
        page.commonObjs.has(item.fontName) &&
        item.transform[0] > 0 &&
        item.transform[1] === 0 &&
        item.transform[2] === 0 &&
        Math.abs(item.width / item.transform[0] - 0.636) < 0.0001 &&
        /^(?:[A-Z]{6}\+)?txsys$/u.test(page.commonObjs.get(item.fontName)?.name ?? '')
      )
        return { ...item, str: '×' }
      return item
    })
  })
}
