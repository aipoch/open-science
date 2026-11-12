import type { PDFPageProxy, PDFDocumentProxy } from 'pdfjs-dist'
import type { PdfLayoutPage } from './layout.js'

type Content = Awaited<ReturnType<PDFPageProxy['getTextContent']>>
const referenceRolePages = new WeakMap<
  PdfLayoutPage,
  {
    resolve: (indices: readonly number[]) => object | undefined
    checks: (() => boolean)[]
    unreliable: Set<string>
    rowClosed: (indices: readonly number[]) => boolean
  }
>()
const referenceRoleFonts = new WeakMap<object, () => boolean>()

/** Native item/font identity for reference roles only; never a paint witness. */
export async function bindNativeReferenceRolePage(
  raw: PdfLayoutPage,
  page: PDFPageProxy,
  content: Content,
  document: Pick<PDFDocumentProxy, 'fingerprints' | 'numPages'>,
  signal: AbortSignal,
  unreliable: Set<string>,
  viewport = page.getViewport({ scale: 1 })
): Promise<void> {
  if (!content.items.some((item) => 'str' in item && /^\[\d{1,4}\]$/u.test(item.str))) return
  let endTextAtEOF = false
  let eofCurrent = (): boolean => false
  try {
    const { OPS, normalizeUnicode } = await import('pdfjs-dist/legacy/build/pdf.mjs'),
      operators = await page.getOperatorList(),
      last = content.items.findLast((item) => 'str' in item && item.str.trim())
    if (
      last &&
      'str' in last &&
      operators.fnArray.length <= 100000 &&
      operators.fnArray.length === operators.argsArray.length &&
      'lastChunk' in operators &&
      operators.lastChunk === true
    ) {
      const show = operators.fnArray.lastIndexOf(OPS.showText),
        fontAt = operators.fnArray.findLastIndex((op, i) => i < show && op === OPS.setFont),
        literal = (operators.argsArray[show]?.[0] ?? [])
          .filter((g: unknown) => !!g && typeof g === 'object')
          .map((g: { unicode?: string }) => g.unicode ?? '\uFFFD')
          .join(''),
        compact = (s: string): string => normalizeUnicode(s).normalize('NFD').replace(/\s/gu, '')
      endTextAtEOF =
        show >= 0 &&
        fontAt >= 0 &&
        operators.argsArray[fontAt]?.[0] === last.fontName &&
        compact(literal).endsWith(compact(last.str)) &&
        operators.fnArray.slice(show + 1).includes(OPS.endText) &&
        !operators.fnArray
          .slice(show + 1)
          .some((op) =>
            [
              OPS.beginText,
              OPS.showSpacedText,
              OPS.nextLineShowText,
              OPS.nextLineSetSpacingShowText
            ].includes(op)
          )
      if (endTextAtEOF) {
        const fn = operators.fnArray,
          args = operators.argsArray,
          getOperators = page.getOperatorList,
          showArgs = args[show],
          fontArgs = args[fontAt],
          count = fn.length,
          tail = JSON.stringify([
            fn[fontAt],
            fontArgs,
            fn[show],
            showArgs,
            fn.slice(show + 1),
            args.slice(show + 1)
          ])
        eofCurrent = () =>
          page.getOperatorList === getOperators &&
          operators.fnArray === fn &&
          operators.argsArray === args &&
          fn.length === count &&
          args.length === count &&
          args[show] === showArgs &&
          args[fontAt] === fontArgs &&
          operators.lastChunk === true &&
          JSON.stringify([
            fn[fontAt],
            args[fontAt],
            fn[show],
            args[show],
            fn.slice(show + 1),
            args.slice(show + 1)
          ]) === tail
      }
    }
  } catch {
    /* Optional role evidence; keep the old reader path. */
  }
  const nativeItems = content.items,
    rawItems = raw.items,
    styles = content.styles,
    commonObjsAtBinding = page.commonObjs,
    getFontAtBinding = page.commonObjs?.get,
    originalFonts = new Map<string, unknown>(),
    viewportTransform = viewport.transform,
    viewportValue = JSON.stringify([
      viewport.width,
      viewport.height,
      viewport.rotation,
      viewport.scale,
      viewport.transform
    ]),
    fingerprints = document.fingerprints,
    fingerprint = fingerprints[0],
    pageCount = document.numPages,
    geometry = [raw.page, raw.width, raw.height, raw.rotation],
    folioEvidence = raw.nativeFolioFontEvidence,
    folioValues = JSON.stringify(folioEvidence),
    nativeRefs = [...nativeItems],
    rawRefs = [...rawItems],
    nativeTransforms = nativeRefs.map((item) => ('transform' in item ? item.transform : undefined)),
    rawTransforms = rawRefs.map((item) => item.transform),
    nativeValues = JSON.stringify(nativeItems),
    rawValues = JSON.stringify(rawItems),
    checks: (() => boolean)[] = []
  for (const item of nativeItems)
    if ('str' in item && item.str.trim() && !originalFonts.has(item.fontName)) {
      try {
        originalFonts.set(item.fontName, commonObjsAtBinding.get(item.fontName))
      } catch {
        originalFonts.set(item.fontName, undefined)
      }
    }
  const current = (): boolean =>
    !signal.aborted &&
    !!fingerprint &&
    document.fingerprints === fingerprints &&
    document.fingerprints[0] === fingerprint &&
    document.numPages === pageCount &&
    geometry.every((value, i) => value === [raw.page, raw.width, raw.height, raw.rotation][i]) &&
    page.pageNumber === raw.page &&
    content.items === nativeItems &&
    content.styles === styles &&
    page.commonObjs === commonObjsAtBinding &&
    page.commonObjs.get === getFontAtBinding &&
    viewport.transform === viewportTransform &&
    JSON.stringify([
      viewport.width,
      viewport.height,
      viewport.rotation,
      viewport.scale,
      viewport.transform
    ]) === viewportValue &&
    raw.items === rawItems &&
    nativeItems.length === nativeRefs.length &&
    rawItems.length === rawRefs.length &&
    raw.nativeFolioFontEvidence === folioEvidence &&
    JSON.stringify(folioEvidence) === folioValues &&
    nativeItems.every(
      (item, i) =>
        item === nativeRefs[i] && (!('transform' in item) || item.transform === nativeTransforms[i])
    ) &&
    rawItems.every((item, i) => item === rawRefs[i] && item.transform === rawTransforms[i]) &&
    JSON.stringify(nativeItems) === nativeValues &&
    JSON.stringify(rawItems) === rawValues
  referenceRolePages.set(raw, {
    checks,
    unreliable,
    rowClosed(indices) {
      if (
        !current() ||
        !indices.length ||
        indices.some(
          (index, n) =>
            !nativeItems[index] ||
            !('str' in nativeItems[index]) ||
            (n > 0 && index <= indices[n - 1])
        )
      )
        return false
      const last = indices.at(-1)!,
        next = nativeItems.findIndex((item, i) => i > last && 'str' in item && item.str.trim()),
        item = nativeItems[last]
      if (
        !('str' in item) ||
        !indices.slice(0, -1).every((index) => {
          const part = nativeItems[index]
          return 'str' in part && part.hasEOL === false
        })
      )
        return false
      if (
        item.hasEOL === true ||
        nativeItems
          .slice(last + 1, next < 0 ? undefined : next)
          .some((item) => 'str' in item && !item.str.trim() && item.hasEOL === true)
      )
        return true
      if (next < 0 && endTextAtEOF && eofCurrent()) {
        checks.push(eofCurrent)
        return true
      }
      return false
    },
    resolve(indices) {
      if (
        !current() ||
        !indices.length ||
        indices.length > 10000 ||
        new Set(indices).size !== indices.length ||
        nativeItems.length !== rawItems.length
      )
        return
      const selected = indices.map((index) => nativeItems[index])
      if (
        selected.some((item, n) => {
          const rawItem = rawItems[indices[n]]
          if (
            !item ||
            !('str' in item) ||
            !rawItem ||
            item.str !== rawItem.str ||
            item.fontName !== rawItem.fontName ||
            item.dir !== rawItem.dir ||
            item.hasEOL !== rawItem.hasEOL ||
            unreliable.has(`${raw.page}:${indices[n]}`)
          )
            return true
          const [a, b, c, d, x, y] = item.transform,
            [ma, mb, mc, md, mx, my] = viewport.transform,
            scale = Math.hypot(ma, mb),
            transform = [
              ma * a + mc * b,
              -(mb * a + md * b),
              ma * c + mc * d,
              -(mb * c + md * d),
              ma * x + mc * y + mx,
              viewport.height - (mb * x + md * y + my)
            ],
            style = styles[item.fontName]
          return (
            item.width * scale !== rawItem.width ||
            item.height * scale !== rawItem.height ||
            transform.some((v, i) => v !== rawItem.transform[i]) ||
            rawItem.fontAscent !== style?.ascent ||
            rawItem.fontDescent !== style?.descent ||
            rawItem.fontVertical !== style?.vertical
          )
        })
      )
        return
      const witness = nativeReferenceFontWitnesses(page, { ...content, items: selected })
      if (!witness) return
      const commonObjs = page.commonObjs,
        fonts = Object.keys(witness).map((name) => {
          const font = commonObjs.get(name),
            style = styles[name],
            keys = [
              'missingFile',
              'isType3Font',
              'isInvalidPDFjsFont',
              'systemFontInfo',
              'vertical',
              'ascent',
              'descent'
            ],
            values = keys.map((key) => font[key]),
            prototype = Object.getPrototypeOf(font),
            slots = keys.map((key) => {
              let owner = font
              while (owner && !Object.hasOwn(owner, key)) owner = Object.getPrototypeOf(owner)
              return {
                key,
                owner,
                descriptor: owner && Object.getOwnPropertyDescriptor(owner, key)
              }
            }),
            unicode = font.toUnicode,
            map = unicode?._map,
            mapKeys = map && typeof map === 'object' ? Object.keys(map) : [],
            mapValues = mapKeys.map((key) => map[key])
          return () =>
            page.commonObjs === commonObjs &&
            commonObjs.get(name) === font &&
            font === originalFonts.get(name) &&
            Object.getPrototypeOf(font) === prototype &&
            styles[name] === style &&
            font.toUnicode === unicode &&
            unicode?._map === map &&
            (!map ||
              (Object.keys(map).length === mapKeys.length &&
                mapKeys.every((key, i) => Object.hasOwn(map, key) && map[key] === mapValues[i]))) &&
            keys.every((key, i) => Object.is(font[key], values[i])) &&
            style.ascent === witness[name].ascent &&
            style.descent === witness[name].descent &&
            style.vertical === false &&
            slots.every(({ key, owner, descriptor }) => {
              let next = font
              while (next && !Object.hasOwn(next, key)) next = Object.getPrototypeOf(next)
              const now = next && Object.getOwnPropertyDescriptor(next, key)
              return (
                next === owner &&
                !!now &&
                !!descriptor &&
                now.get === descriptor.get &&
                now.set === descriptor.set &&
                now.value === descriptor.value &&
                now.writable === descriptor.writable &&
                now.enumerable === descriptor.enumerable &&
                now.configurable === descriptor.configurable
              )
            })
        })
      const stillCurrent = (): boolean =>
        current() &&
        fonts.every((check) => check()) &&
        indices.every((index) => !unreliable.has(`${raw.page}:${index}`))
      if (!stillCurrent()) return
      const token = Object.freeze({})
      referenceRoleFonts.set(token, stillCurrent)
      checks.push(stillCurrent)
      return token
    }
  })
}

export function nativeReferenceRolePageFonts(
  raw: PdfLayoutPage,
  indices: readonly number[]
): object | undefined {
  try {
    return referenceRolePages.get(raw)?.resolve(indices)
  } catch {
    return
  }
}

export function nativeReferenceRoleRowClosed(
  raw: PdfLayoutPage,
  indices: readonly number[]
): boolean {
  try {
    return referenceRolePages.get(raw)?.rowClosed(indices) === true
  } catch {
    return false
  }
}

export function nativeReferenceRoleFontsCurrent(token: object): boolean {
  try {
    return referenceRoleFonts.get(token)?.() === true
  } catch {
    return false
  }
}

export function nativeReferenceRolePagesCurrent(
  pages: readonly PdfLayoutPage[],
  unreliable: Set<string>
): boolean {
  try {
    return pages.every((page) => {
      const binding = referenceRolePages.get(page)
      return (
        !binding || (binding.unreliable === unreliable && binding.checks.every((check) => check()))
      )
    })
  } catch {
    return false
  }
}

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

/** Canonical printed equation numbers only; this grants no ownership. */
export function nativeDisplayNumber(text: string): { value: number; roman: boolean } | undefined {
  if (/^\([1-9]\d{0,3}\)$/u.test(text)) return { value: Number(text.slice(1, -1)), roman: false }
  const inner = text.slice(1, -1)
  if (
    !/^\([ivxlcdm]+\)$/u.test(text) ||
    !/^m{0,3}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})$/u.test(inner)
  )
    return
  const values: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 }
  return {
    value: [...inner].reduce(
      (sum, char, n) =>
        sum + (values[char] < (values[inner[n + 1]] ?? 0) ? -values[char] : values[char]),
      0
    ),
    roman: true
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
    const items = content.items.flatMap((i) => ('str' in i && i.str.trim() ? [i] : []))
    // This marker only requests the unchanged native font/paint proof. The
    // reader separately closes the indexed numerator, denominator and rule.
    const indexedFraction = items.some(
      (item, at) =>
        /^[A-Za-z]$/u.test(item.str) &&
        /^[a-z]{2}$/u.test(items[at + 1]?.str ?? '') &&
        items[at + 2]?.str === '−' &&
        items[at + 3]?.str === '¯' &&
        items[at + 4]?.str === item.str &&
        items[at + 5]?.str === items[at + 1].str.slice(-1)
    )
    const roman = items.flatMap((i) => {
      const number = nativeDisplayNumber(i.str)
      return number?.roman ? [number.value] : []
    })
    const numbered =
      items.some((i) => /^\([1-9]\d{0,3}\)$/u.test(i.str)) ||
      roman.some((n) => roman.includes(n + 1))
    if (!indexedFraction && !numbered)
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
      OPS.nextLine,
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

/** Request the existing whole-page font/opaque-rule proof only for appendix
 * table Notes. No model grid, caption rectangle or partial font packet is used. */
export async function readNativeTableNoteEvidence(
  page: PDFPageProxy,
  content: Awaited<ReturnType<PDFPageProxy['getTextContent']>>,
  unreliable: ReadonlySet<number>
): Promise<NativeReferenceEvidence> {
  const items = content.items.filter((i) => 'str' in i && i.str.trim())
  if (
    unreliable.size ||
    !('str' in (items[0] ?? {})) ||
    !/^Table [A-Z]\.[1-9]\d*:/u.test((items[0] as { str: string }).str) ||
    !items.some((i) => 'str' in i && i.str === 'Note')
  )
    return { complete: false, reason: 'no-reliable-native-table-note' }
  try {
    const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs'),
      operators = await page.getOperatorList()
    if (
      operators.fnArray.some(
        (op, n) =>
          (op === OPS.constructPath && operators.argsArray[n]?.[0] !== OPS.stroke) ||
          (op === OPS.setFillRGBColor && operators.argsArray[n]?.[0] === '#ffffff')
      )
    )
      return { complete: false, reason: 'occluded-table-note' }
    return readNativeLinearRuleEvidence(page, content)
  } catch {
    return { complete: false, reason: 'native-evidence-unavailable' }
  }
}
