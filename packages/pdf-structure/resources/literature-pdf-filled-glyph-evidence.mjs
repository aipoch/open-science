/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createHash } from 'node:crypto'
import { Path2D, PathOp } from '@napi-rs/canvas'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
const finite = (a, n) => Array.isArray(a) && a.length === n && a.every(Number.isFinite)
const same = (a, b) => finite(a, b?.length) && a.every((n, i) => Math.abs(n - b[i]) < 1e-6)
const digest = (b) => createHash('sha256').update(b).digest('hex')

// Optional precision only, requested by native overprint geometry. The existing
// complete coarse bounds are neither replaced nor recomputed.
export function collectFilledGlyphEvidence(
  content,
  operators,
  objects,
  coarse,
  identity,
  budget = 65536
) {
  try {
    if (
      !Array.isArray(content?.items) ||
      content.items.length > 4096 ||
      !Array.isArray(operators?.fnArray) ||
      operators.fnArray.length > 100000 ||
      operators.fnArray.length !== operators.argsArray?.length ||
      !Array.isArray(coarse) ||
      !/^[a-f0-9]{64}$/.test(identity?.sourceSha256) ||
      !Number.isSafeInteger(identity.pageNumber) ||
      identity.pageNumber < 1 ||
      !(budget > 0)
    )
      return
    const requests = new Map()
    for (let i = 0; i + 2 < content.items.length; i++) {
      const a = content.items[i],
        b = content.items[i + 1],
        next = content.items[i + 2],
        h = a.height
      if (
        ![a, b, next].every(
          (s) =>
            typeof s?.str === 'string' &&
            finite(s.transform, 6) &&
            s.transform[0] === s.height &&
            s.transform[3] === s.height &&
            s.transform[1] === 0 &&
            s.transform[2] === 0
        ) ||
        [...a.str].length !== 1 ||
        !/^\p{Script=Latin}$/u.test(b.str) ||
        !/^[([{]$/u.test(next.str) ||
        !(h > 0) ||
        Math.abs(h - b.height) > h * 0.02 ||
        Math.abs(next.height - h) > h * 0.02 ||
        a.transform[5] - b.transform[5] < h * 0.15 ||
        a.transform[5] - b.transform[5] > h * 0.4 ||
        Math.abs(next.transform[5] - b.transform[5]) > h * 0.02 ||
        Math.min(a.transform[4] + a.width, b.transform[4] + b.width) -
          Math.max(a.transform[4], b.transform[4]) <
          Math.min(a.width, b.width) * 0.7
      )
        continue
      const key = a.fontName + '\0' + a.str
      if (!requests.has(key))
        requests.set(key, { fontName: a.fontName, unicode: a.str, sourceIndices: [] })
      requests.get(key).sourceIndices.push(i)
      if (requests.size > 32) return
    }
    if (!requests.size) return
    let state = { font: undefined, fill: '#000000', alpha: 1, mode: 0, safe: true },
      stack = []
    const occurrences = new Map()
    for (let i = 0; i < operators.fnArray.length; i++) {
      const op = operators.fnArray[i],
        a = operators.argsArray[i]
      if (op === OPS.save || op === OPS.paintFormXObjectBegin) stack.push({ ...state })
      else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
        if (!stack.length) return
        state = stack.pop()
      } else if (op === OPS.setFont) state.font = a?.[0]
      else if (op === OPS.setFillRGBColor) state.fill = a?.[0]
      else if (op === OPS.setTextRenderingMode) state.mode = a?.[0]
      else if (
        op === OPS.setFillColorN ||
        op === OPS.setFillColor ||
        op === OPS.setFillGray ||
        op === OPS.setFillCMYKColor
      )
        state.safe = false
      else if (op === OPS.setGState) {
        if (!Array.isArray(a?.[0])) return
        for (const e of a[0]) {
          if (!Array.isArray(e) || e.length !== 2) return
          if (e[0] === 'ca') state.alpha = e[1]
          else if (e[0] !== 'CA' && !(e[0] === 'SMask' && e[1] === false)) state.safe = false
        }
      } else if (op === OPS.showText) {
        if (!Array.isArray(a?.[0])) return
        for (let j = 0; j < a[0].length; j++) {
          const g = a[0][j],
            key = state.font + '\0' + g?.unicode
          if (!requests.has(key)) continue
          if (
            !state.safe ||
            state.fill !== '#000000' ||
            state.alpha !== 1 ||
            state.mode !== 0 ||
            !g?.isInFont ||
            typeof g.fontChar !== 'string' ||
            !g.fontChar ||
            !Number.isSafeInteger(g.originalCharCode) ||
            g.accent != null ||
            g.operatorListId != null ||
            g.vmetric != null
          )
            return
          if (!occurrences.has(key)) occurrences.set(key, [])
          occurrences.get(key).push({
            operationIndex: i,
            glyphIndex: j,
            fontChar: g.fontChar,
            originalCharCode: g.originalCharCode
          })
        }
      }
    }
    if (stack.length) return
    const result = []
    let computed = 0
    for (const [key, request] of requests) {
      const used = occurrences.get(key),
        font = objects.get(request.fontName)
      if (
        !used?.length ||
        used.some(
          (g) => g.fontChar !== used[0].fontChar || g.originalCharCode !== used[0].originalCharCode
        ) ||
        font?.loadedName !== request.fontName ||
        font.missingFile !== false ||
        font.isInvalidPDFjsFont !== false ||
        font.isType3Font !== false ||
        !(font.data instanceof Uint8Array) ||
        font.data.length > 16 * 1024 * 1024 ||
        !same(font.fontMatrix, [0.001, 0, 0, 0.001, 0, 0]) ||
        font.toFontChar?.[used[0].originalCharCode] !== used[0].fontChar.codePointAt(0)
      )
        continue
      const coarseBounds = coarse
        .find((f) => f.fontName === request.fontName)
        ?.glyphs.find((g) => g.fontChar === used[0].fontChar)?.bounds
      const original = font.getPathGenerator(objects, used[0].fontChar)
      if (!same(original?.getBounds?.(), coarseBounds) || original.getFillType() !== 0) continue
      const svg = original.toSVGString()
      if (svg.length > 65536) continue
      const originalBounds = Array.from(original.getBounds()),
        simplified = new Path2D(original).simplify()
      computed++
      const filledBounds = Array.from(simplified.getBounds())
      if (
        !finite(filledBounds, 4) ||
        filledBounds[2] <= filledBounds[0] ||
        filledBounds[3] <= filledBounds[1] ||
        filledBounds.some((n, i) =>
          i < 2 ? n < originalBounds[i] - 1e-6 : n > originalBounds[i] + 1e-6
        ) ||
        filledBounds[3] - filledBounds[1] > 0.2 ||
        new Path2D(original)
          .op(simplified, PathOp.Xor)
          .getBounds()
          .some((n) => n !== 0) ||
        original.toSVGString() !== svg ||
        !same(original.getBounds(), originalBounds)
      )
        continue
      result.push({
        ...request,
        fontChar: used[0].fontChar,
        originalCharCode: used[0].originalCharCode,
        fontSha256: digest(font.data),
        fontMatrix: Array.from(font.fontMatrix),
        outlineSha256: digest(svg),
        coarseBounds: originalBounds,
        filledBounds,
        occurrences: used.map(({ operationIndex, glyphIndex }) => ({ operationIndex, glyphIndex }))
      })
    }
    const value = {
      ...identity,
      glyphs: result,
      requestedGlyphs: requests.size,
      computedGlyphs: computed
    }
    return result.length && JSON.stringify(value).length * 2 <= budget ? value : undefined
  } catch {
    return
  }
}
