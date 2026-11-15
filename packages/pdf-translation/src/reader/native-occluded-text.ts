import type { PDFPageProxy } from 'pdfjs-dist'
import { nativeOutlineBox } from './native-source-geometry.js'
import { nativeInkPageCurrent, nativeInkPageIdentity } from './auxiliary-native-ink.js'
import { getPdfTranslationTextContent } from './text-content.js'
import { readNativeFormClippedText } from './native-form-clipped-text.js'

type Box = [number, number, number, number]
type Content = Awaited<ReturnType<PDFPageProxy['getTextContent']>>
type Proof = Readonly<{ indexes: ReadonlySet<number>; current: () => boolean }>
const identity = [1, 0, 0, 1, 0, 0]
const axis = (m: readonly number[]): boolean =>
  m.length === 6 && m.every(Number.isFinite) && m[0] > 0 && m[3] > 0 && m[1] === 0 && m[2] === 0
// Keep a full native-coordinate unit clear of the fill edge, including raster edge coverage.
const inside = (a: Box, b: Box): boolean =>
  a[0] > b[0] + 1 && a[1] > b[1] + 1 && a[2] < b[2] - 1 && a[3] < b[3] - 1
function bounds(b: Box, m: number[]): Box {
  return [b[0] * m[0] + m[4], b[1] * m[3] + m[5], b[2] * m[0] + m[4], b[3] * m[3] + m[5]]
}
function intersect(a: Box, b: Box): Box {
  return [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]
}
// A filled hull is not an opaque interior. Accept exactly one closed rectangular
// subpath, without holes, curves, repeated vertices, or diagonal edges.
function rectangle(paths: ArrayLike<number>[]): Box | undefined {
  if (paths.length !== 1) return
  const p = Array.from(paths[0])
  if (
    p.length !== 13 ||
    !p.every(Number.isFinite) ||
    p[0] !== 0 ||
    p[3] !== 1 ||
    p[6] !== 1 ||
    p[9] !== 1 ||
    p[12] !== 4
  )
    return
  const points = [
    [p[1], p[2]],
    [p[4], p[5]],
    [p[7], p[8]],
    [p[10], p[11]]
  ]
  const xs = [...new Set(points.map((v) => v[0]))],
    ys = [...new Set(points.map((v) => v[1]))]
  if (xs.length !== 2 || ys.length !== 2 || new Set(points.map((v) => v.join(','))).size !== 4)
    return
  if (
    points.some((a, i) => {
      const b = points[(i + 1) % 4]
      return (a[0] === b[0]) === (a[1] === b[1])
    })
  )
    return
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

/** Only the initial ordinary paint prefix is supported. A later, solid rectangle
 * must cover complete native glyph outlines in its actual rectangular clip.
 * Forms, groups, unknown state and unsupported text stop the proof. A source is
 * bound to one complete text-show occurrence; equal strings never deduplicate.
 * Missing outlines abstain; no font metric or navigation box substitutes ink. */
async function readNativeSolidFillOccludedText(
  page: PDFPageProxy,
  content: Content,
  viewport: ReturnType<PDFPageProxy['getViewport']>
): Promise<Proof | undefined> {
  if (!page.commonObjs || typeof page.getOperatorList !== 'function') return
  try {
    const { OPS, Util } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const operators = await page.getOperatorList()
    if (
      operators.fnArray.length !== operators.argsArray.length ||
      operators.fnArray.length > 100000
    )
      return
    const snapshot = structuredClone(operators)
    if (!page.view || page.view.length !== 4 || !page.view.every(Number.isFinite)) return
    // Collect keys without consulting font or outline objects. Bind the actual
    // objects and bytes BEFORE any measurement, not after the candidate is found.
    const outlineKeys = new Set<string>(),
      fontStack: string[] = []
    let activeFont = '',
      firstFill = false
    for (let n = 0; n < snapshot.fnArray.length; n++) {
      const op = snapshot.fnArray[n],
        args = snapshot.argsArray[n] ?? []
      if (op === OPS.save) fontStack.push(activeFont)
      else if (op === OPS.restore) {
        const previous = fontStack.pop()
        if (previous === undefined) return
        activeFont = previous
      } else if (op === OPS.setFont) activeFont = args[0]
      else if (op === OPS.setGState || op === OPS.beginGroup || op === OPS.paintFormXObjectBegin)
        return
      else if (op === OPS.showText) {
        if (!Array.isArray(args[0])) return
        for (const glyph of args[0])
          if (typeof glyph !== 'number') {
            if (!activeFont || typeof glyph?.fontChar !== 'string') return
            outlineKeys.add(`${activeFont}_path_${glyph.fontChar}`)
          }
      } else if (op === OPS.constructPath && args[0] !== OPS.endPath) {
        if (args[0] !== OPS.fill || !rectangle(args[1] ?? [])) return
        firstFill = true
        break
      }
    }
    if (!firstFill || !outlineKeys.size || outlineKeys.size > 10000) return
    const current = nativeInkPageCurrent(page, content, viewport, operators, [...outlineKeys])
    if (!current?.()) return
    let state = {
      matrix: identity,
      clip: [...page.view] as Box,
      font: '',
      size: 0,
      textMatrix: identity,
      charSpacing: 0,
      wordSpacing: 0,
      hScale: 1,
      rise: 0,
      positioned: false,
      inText: false
    }
    const stack: (typeof state)[] = [],
      pending: { index: number; ink: Box }[] = []
    const sources = content.items.flatMap((item, index) =>
      'str' in item && item.str.trim() ? [{ item, index }] : []
    )
    let cursor = 0,
      clipping = false
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
      OPS.setLeading
    ])
    for (let n = 0; n < snapshot.fnArray.length; n++) {
      const op = snapshot.fnArray[n],
        args = snapshot.argsArray[n] ?? []
      if (clipping && op !== OPS.constructPath) return
      if (op === OPS.save) {
        stack.push(state)
        state = { ...state }
      } else if (op === OPS.restore) {
        const prior = stack.pop()
        if (!prior || state.inText) return
        state = prior
      } else if (op === OPS.transform) {
        if (!axis(args)) return
        state.matrix = Util.transform(state.matrix, args)
      } else if (op === OPS.beginText) {
        if (state.inText) return
        state.inText = true
        state.positioned = false
        state.textMatrix = identity
      } else if (op === OPS.endText) {
        if (!state.inText) return
        state.inText = false
        state.positioned = false
      } else if (op === OPS.setTextMatrix) {
        const m = Array.from(args[0] ?? []) as number[]
        if (!state.inText || !axis(m)) return
        state.textMatrix = m
        state.positioned = true
      } else if (op === OPS.moveText) {
        if (
          !state.inText ||
          state.positioned ||
          state.textMatrix !== identity ||
          args.length !== 2 ||
          !args.every(Number.isFinite)
        )
          return
        state.textMatrix = [1, 0, 0, 1, args[0], args[1]]
        state.positioned = true
      } else if (op === OPS.setFont) {
        state.font = args[0]
        state.size = args[1]
      } else if (op === OPS.setCharSpacing) state.charSpacing = args[0]
      else if (op === OPS.setWordSpacing) state.wordSpacing = args[0]
      else if (op === OPS.setHScale) state.hScale = args[0] / 100
      else if (op === OPS.setTextRise) state.rise = args[0]
      else if (op === OPS.setTextRenderingMode) {
        if (args[0] !== 0) return
      } else if (op === OPS.setGState)
        return // Includes transparency, blend, soft masks and inherited fonts.
      else if ([OPS.setFillRGBColor, OPS.setFillGray, OPS.setFillCMYKColor].includes(op)) {
        if (
          op === OPS.setFillRGBColor &&
          (args.length !== 1 || typeof args[0] !== 'string' || !/^#[0-9a-f]{6}$/iu.test(args[0]))
        )
          return
        if (
          op !== OPS.setFillRGBColor &&
          (args.length !== (op === OPS.setFillGray ? 1 : 4) ||
            !args.every(Number.isFinite) ||
            args.some((v: number) => v < 0 || v > 1))
        )
          return
      } else if (op === OPS.clip || op === OPS.eoClip) clipping = true
      else if (op === OPS.constructPath) {
        if (state.inText) return
        const r = rectangle(args[1] ?? [])
        if (!r) return
        const painted = bounds(r, state.matrix)
        if (clipping) {
          if (args[0] !== OPS.endPath) return
          state.clip = intersect(state.clip, painted)
          clipping = false
          continue
        }
        // Stop at the first graphical paint. Nothing after an ordinary opaque
        // fill can resurrect its earlier pixels; no transparency ancestor was admitted.
        if (args[0] !== OPS.fill || !pending.length) return
        const opaque = intersect(state.clip, painted)
        const indexes = new Set(pending.filter((p) => inside(p.ink, opaque)).map((p) => p.index))
        if (!indexes.size) return
        if (!current()) return
        const before = await nativeInkPageIdentity(page, content, viewport)
        if (!current() || !before || JSON.stringify(before.operators) !== JSON.stringify(snapshot))
          return
        const fresh = await getPdfTranslationTextContent(page)
        if (!current() || JSON.stringify(fresh) !== JSON.stringify(content)) return
        const after = await nativeInkPageIdentity(page, content, viewport)
        if (!current() || before.key !== after?.key) return
        return { indexes, current }
      } else if (op === OPS.showText) {
        if (!state.inText || !state.positioned || !Array.isArray(args[0])) return
        state.positioned = false // Every admitted show needs a fresh explicit position.
        const glyphs = args[0]
        const literal = glyphs
          .map((g) =>
            typeof g === 'number' ? '' : typeof g?.unicode === 'string' ? g.unicode : '\u0000'
          )
          .join('')
        if (literal.includes('\u0000')) return
        // Native whitespace/control-only shows do not consume nonblank owners.
        if (!literal.trim()) continue
        const source = sources[cursor++]
        if (
          !source ||
          source.item.str !== literal.trim() ||
          source.item.fontName !== state.font ||
          source.item.dir !== 'ltr' ||
          content.styles?.[state.font]?.vertical !== false ||
          !page.commonObjs.has(state.font)
        )
          return
        const font = page.commonObjs.get(state.font)
        if (
          font?.loadedName !== state.font ||
          font.missingFile !== false ||
          font.isInvalidPDFjsFont !== false ||
          font.isType3Font !== false ||
          font.vertical !== false ||
          font.remeasure ||
          font.systemFontInfo ||
          JSON.stringify(font.fontMatrix) !== JSON.stringify([0.001, 0, 0, 0.001, 0, 0])
        )
          return
        if (
          ![state.size, state.charSpacing, state.wordSpacing, state.hScale, state.rise].every(
            Number.isFinite
          ) ||
          state.size <= 0 ||
          state.hScale <= 0 ||
          !axis(state.textMatrix) ||
          !axis(state.matrix)
        )
          return
        const base = Util.transform(state.matrix, state.textMatrix)
        const transform = Util.transform(base, [
          state.size * state.hScale,
          0,
          0,
          state.size,
          0,
          state.rise
        ])
        if (
          source.item.transform.length !== 6 ||
          !source.item.transform.every(
            (v, i) => Number.isFinite(v) && Math.abs(v - transform[i]) < 0.002
          ) ||
          !Number.isFinite(source.item.height) ||
          Math.abs(source.item.height - transform[3]) > 0.002
        )
          return
        let x = 0,
          end = 0
        const boxes: Box[] = []
        for (const glyph of glyphs) {
          if (typeof glyph === 'number') {
            if (!Number.isFinite(glyph)) return
            x -= (glyph * state.size) / 1000
            continue
          }
          if (
            !glyph ||
            typeof glyph.unicode !== 'string' ||
            !Number.isFinite(glyph.width) ||
            glyph.accent ||
            typeof glyph.fontChar !== 'string' ||
            !glyph.fontChar ||
            (glyph.unicode.trim() && glyph.isInFont !== true)
          )
            return
          const key = `${font.loadedName}_path_${glyph.fontChar}`
          if (!page.commonObjs.has(key)) return
          const outline = nativeOutlineBox(page.commonObjs.get(key)?.path)
          if (!outline && glyph.unicode.trim()) return
          if (!outlineKeys.has(key)) return
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
            (glyph.width * state.size) / 1000 +
            state.charSpacing +
            (glyph.isSpace ? state.wordSpacing : 0)
          if (glyph.unicode.trim()) end = x - state.charSpacing
        }
        if (
          !boxes.length ||
          !Number.isFinite(source.item.width) ||
          Math.abs(source.item.width - end * state.hScale * base[0]) > 0.002
        )
          return
        const ink: Box = [
          Math.min(...boxes.map((b) => b[0])),
          Math.min(...boxes.map((b) => b[1])),
          Math.max(...boxes.map((b) => b[2])),
          Math.max(...boxes.map((b) => b[3]))
        ]
        if (!ink.every(Number.isFinite)) return
        pending.push({ index: source.index, ink })
      } else if (!inert.has(op)) return
    }
  } catch {
    return
  }
}

export async function readNativeOccludedText(
  page: PDFPageProxy,
  content: Content,
  viewport: ReturnType<PDFPageProxy['getViewport']>,
  readAuxiliaryExclusions?: () => Promise<Proof | undefined>
): Promise<Proof | undefined> {
  let clipped: Proof | undefined = await readNativeFormClippedText(page, content, viewport)
  if (!clipped && readAuxiliaryExclusions) {
    try {
      const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
      const operators = await page.getOperatorList()
      if (
        operators.fnArray.length <= 100000 &&
        operators.fnArray.includes(OPS.paintFormXObjectBegin)
      )
        clipped = await readAuxiliaryExclusions()
    } catch {
      /* Unknown native observations do not exclude source text. */
    }
  }
  const covered = await readNativeSolidFillOccludedText(page, content, viewport)
  const proofs = [clipped, covered].filter((proof): proof is Proof => !!proof)
  if (!proofs.length || proofs.some((proof) => !proof.current())) return
  return {
    indexes: new Set(proofs.flatMap((proof) => [...proof.indexes])),
    current: () => proofs.every((proof) => proof.current())
  }
}
