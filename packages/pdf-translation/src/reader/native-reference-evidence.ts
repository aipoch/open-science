import type { PDFPageProxy } from 'pdfjs-dist'

export type NativeReferenceFontWitness = {
  ascent: number
  descent: number
  vertical: false
  nativeMetrics: true
}
type Rule = {
  left: number
  right: number
  baseline: number
  halfHeight: number
  operators: number[]
}
export type NativeReferenceEvidence =
  | {
      complete: true
      rules: Rule[]
      fonts: Record<string, NativeReferenceFontWitness>
    }
  | { complete: false; reason: string }

/** Resolve only the actual embedded font object used by each native source. */
export function nativeReferenceFontWitnesses(
  page: PDFPageProxy,
  content: Awaited<ReturnType<PDFPageProxy['getTextContent']>>
): Record<string, NativeReferenceFontWitness> | undefined {
  if (!page.commonObjs) return
  const fonts: Record<string, NativeReferenceFontWitness> = {}
  for (const id of new Set(
    content.items.flatMap((i) => ('str' in i && i.str.trim() ? [i.fontName] : []))
  )) {
    const style = content.styles[id],
      font = page.commonObjs.get(id)
    if (
      !style ||
      !font ||
      font.missingFile !== false ||
      font.isType3Font !== false ||
      font.isInvalidPDFjsFont !== false ||
      font.systemFontInfo !== null ||
      style.vertical !== false ||
      font.vertical !== false ||
      !Number.isFinite(style.ascent) ||
      !Number.isFinite(style.descent) ||
      style.ascent <= 0 ||
      style.ascent > 1 ||
      style.descent > 0 ||
      style.descent < -1 ||
      font.ascent !== style.ascent ||
      font.descent !== style.descent
    )
      return
    fonts[id] = {
      ascent: style.ascent,
      descent: style.descent,
      vertical: false,
      nativeMetrics: true
    }
  }
  return fonts
}

// Source geometry and font identity only. No glyph repaint, inferred font style,
// font-name matching or reference reconstruction is authorized by this witness.
export async function readNativeReferenceEvidence(
  page: PDFPageProxy,
  content: Awaited<ReturnType<PDFPageProxy['getTextContent']>>
): Promise<NativeReferenceEvidence> {
  try {
    if (!content.items.some((i) => 'str' in i && /^\[\d{1,4}\]/u.test(i.str)))
      return { complete: false, reason: 'no-numbered-reference-items' }
    return readNativeLinearRuleEvidence(page, content)
  } catch {
    return { complete: false, reason: 'native-evidence-unavailable' }
  }
}

/** A separate numbered display gate reuses the same strict font/paint proof.
 * The existing reference entry point retains its original admission rule.
 */
export async function readNativeDisplayEquationEvidence(
  page: PDFPageProxy,
  content: Awaited<ReturnType<PDFPageProxy['getTextContent']>>,
  reference: NativeReferenceEvidence
): Promise<NativeReferenceEvidence> {
  try {
    if (!content.items.some((i) => 'str' in i && /^\([1-9]\d{0,3}\)$/u.test(i.str)))
      return { complete: false, reason: 'no-display-equation-number' }
    if (reference.complete || reference.reason !== 'no-numbered-reference-items') return reference
    return readNativeLinearRuleEvidence(page, content)
  } catch {
    return { complete: false, reason: 'native-evidence-unavailable' }
  }
}

/** Numbered control flow and superscript bibliographies have distinct native
 * markers. They request the unchanged strict font/rule proof independently of
 * the existing bracket-reference and display-equation admission guards. */
export async function readNativeNumberedPacketEvidence(
  page: PDFPageProxy,
  content: Awaited<ReturnType<PDFPageProxy['getTextContent']>>,
  reference: NativeReferenceEvidence,
  display: NativeReferenceEvidence
): Promise<NativeReferenceEvidence> {
  const items = content.items.flatMap((item) => ('str' in item && item.str.trim() ? [item] : []))
  const algorithm = items.some((item) => /^(?:Algorithm\s+[1-9]\d*|Pseudo code\b)/u.test(item.str))
  const markers = items.filter((item, index) => {
    const next = items[index + 1]
    return (
      /^\d{1,3}$/u.test(item.str) &&
      next &&
      item.height > next.height * 0.7 &&
      item.height < next.height * 0.8 &&
      item.transform[5] > next.transform[5] &&
      item.transform[5] - next.transform[5] < next.height * 0.4
    )
  })
  if (!algorithm && markers.length < 3)
    return { complete: false, reason: 'no-numbered-native-packet' }
  if (reference.complete) return reference
  if (display.complete) return display
  if (reference.reason === 'incomplete-native-font' || display.reason === 'incomplete-native-font')
    return { complete: false, reason: 'incomplete-native-font' }
  return readNativeLinearRuleEvidence(page, content)
}

async function readNativeLinearRuleEvidence(
  page: PDFPageProxy,
  content: Awaited<ReturnType<PDFPageProxy['getTextContent']>>
): Promise<NativeReferenceEvidence> {
  const fail = (reason: string): NativeReferenceEvidence => ({ complete: false, reason })
  try {
    if (!page.commonObjs || typeof page.getOperatorList !== 'function')
      return fail('native-api-unavailable')
    const { OPS, Util } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const viewport = page.getViewport({ scale: 1 }),
      [ma, mb, mc, md, mx, my] = viewport.transform
    const virtual = [ma, -mb, mc, -md, mx, viewport.height - my]
    const upright = (m: number[]): boolean =>
      m.length === 6 && m.every(Number.isFinite) && m[0] > 0 && m[3] > 0 && m[1] === 0 && m[2] === 0
    if (!upright(virtual)) return fail('non-upright-viewport')
    const operators = await page.getOperatorList()
    if (
      operators.fnArray.length !== operators.argsArray.length ||
      operators.fnArray.length > 100000
    )
      return fail('incomplete-operators')
    const fonts = nativeReferenceFontWitnesses(page, content)
    if (!fonts) return fail('incomplete-native-font')
    const inert = new Set([
      OPS.beginText,
      OPS.endText,
      OPS.moveText,
      OPS.setTextMatrix,
      OPS.setFont,
      OPS.showText,
      OPS.setLeading,
      OPS.setCharSpacing,
      OPS.setWordSpacing,
      OPS.setHScale,
      OPS.setTextRise,
      OPS.dependency
    ])
    type State = {
      matrix: number[]
      width: number
      cap: number
      dash: number[]
      fill: string
      stroke: string
    }
    let state: State = {
      matrix: [1, 0, 0, 1, 0, 0],
      width: 1,
      cap: 0,
      dash: [],
      fill: '#000000',
      stroke: '#000000'
    }
    const stack: State[] = [],
      rules: Rule[] = []
    for (let n = 0; n < operators.fnArray.length; n++) {
      const op = operators.fnArray[n],
        args = operators.argsArray[n] ?? []
      if (inert.has(op)) continue
      if (op === OPS.save) {
        stack.push({ ...state, matrix: [...state.matrix], dash: [...state.dash] })
        continue
      }
      if (op === OPS.restore) {
        const prior = stack.pop()
        if (!prior) return fail('unbalanced-graphics-state')
        state = prior
        continue
      }
      if (op === OPS.transform) {
        state.matrix = Util.transform(state.matrix, args)
        if (!upright(state.matrix)) return fail('non-upright-paint-transform')
        continue
      }
      if (op === OPS.setLineWidth) {
        if (!Number.isFinite(args[0]) || args[0] <= 0) return fail('invalid-line-width')
        state.width = args[0]
        continue
      }
      if (op === OPS.setLineCap) {
        if (args[0] !== 0) return fail('unsupported-line-cap')
        state.cap = 0
        continue
      }
      if (op === OPS.setDash) {
        if (!Array.isArray(args[0]) || args[0].length || args[1] !== 0) return fail('dashed-paint')
        state.dash = []
        continue
      }
      if (op === OPS.setFillRGBColor || op === OPS.setStrokeRGBColor) {
        if (typeof args[0] !== 'string' || !/^#[0-9a-f]{6}$/u.test(args[0]))
          return fail('unknown-paint-color')
        state[op === OPS.setFillRGBColor ? 'fill' : 'stroke'] = args[0]
        continue
      }
      if (op === OPS.setTextRenderingMode) {
        if (args[0] !== 0) return fail('unsupported-text-paint-mode')
        continue
      }
      // In particular, clipping, transparency, forms, images and unknown state
      // are rejected. They are not silently ignored when certifying a rule.
      if (op !== OPS.constructPath) return fail('unsupported-graphics-operator:' + op)
      if (args[1]?.length !== 1 || !args[1][0] || !Number.isSafeInteger(args[1][0].length))
        return fail('incomplete-native-path')
      const path = Array.from(args[1][0]) as number[],
        m = Util.transform(virtual, state.matrix)
      if (!path.every(Number.isFinite) || !upright(m)) return fail('invalid-native-path')
      const point = (x: number, y: number): [number, number] => [x * m[0] + m[4], y * m[3] + m[5]]
      if (args[0] === OPS.stroke && path.length === 6 && path[0] === 0 && path[3] === 1) {
        if (state.stroke !== '#000000' || state.cap !== 0 || state.dash.length)
          return fail('nonopaque-black-rule')
        const a = point(path[1], path[2]),
          b = point(path[4], path[5])
        if (a[1] !== b[1] && a[0] !== b[0]) return fail('non-axis-rule')
        if (a[1] === b[1] && a[0] !== b[0])
          rules.push({
            left: Math.min(a[0], b[0]),
            right: Math.max(a[0], b[0]),
            baseline: a[1],
            halfHeight: (state.width * m[3]) / 2,
            operators: [n]
          })
        continue
      }
      if (
        args[0] === OPS.fill &&
        path.length === 13 &&
        path[0] === 0 &&
        path[3] === 1 &&
        path[6] === 1 &&
        path[9] === 1 &&
        path[12] === 4
      ) {
        if (state.fill !== '#000000') return fail('occluding-fill')
        const p = [
          point(path[1], path[2]),
          point(path[4], path[5]),
          point(path[7], path[8]),
          point(path[10], path[11])
        ]
        if (
          !p.every((a, k) => {
            const b = p[(k + 1) % 4]
            return (a[0] === b[0]) !== (a[1] === b[1])
          }) ||
          new Set(p.map((a) => a[0])).size !== 2 ||
          new Set(p.map((a) => a[1])).size !== 2
        )
          return fail('non-rectangular-fill')
        // Opaque black fill cannot erase an already painted black separator.
        continue
      }
      return fail('unsupported-native-paint')
    }
    if (stack.length) return fail('unbalanced-graphics-state')
    // Redundant collinear strokes form one continuous rule; their count has no
    // semantic meaning. A gap is retained instead of being guessed closed.
    const merged: Rule[] = []
    for (const rule of rules.toSorted((a, b) => a.baseline - b.baseline || a.left - b.left)) {
      const prior = merged.at(-1)
      if (prior && prior.baseline === rule.baseline && rule.left <= prior.right) {
        prior.right = Math.max(prior.right, rule.right)
        prior.halfHeight = Math.max(prior.halfHeight, rule.halfHeight)
        prior.operators.push(...rule.operators)
      } else merged.push({ ...rule, operators: [...rule.operators] })
    }
    return { complete: true, rules: merged, fonts }
  } catch {
    return fail('native-evidence-unavailable')
  }
}
