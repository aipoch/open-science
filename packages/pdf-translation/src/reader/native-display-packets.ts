import type { PDFPageProxy } from 'pdfjs-dist'
import type { PdfTranslationSource } from './source.js'
import type { PdfLayoutPage, PdfLayoutTextItem } from './layout.js'
import type { AuxiliaryNativeInkReader } from './auxiliary-native-ink.js'
import { nativeInkPageIdentity } from './auxiliary-native-ink.js'
import { nativeReferenceFontWitnesses, nativeDisplayNumber } from './native-reference-evidence.js'
import { nativeTextFreeClipInkRegions } from './native-source-geometry.js'

type Content = Awaited<ReturnType<PDFPageProxy['getTextContent']>>
type Viewport = ReturnType<PDFPageProxy['getViewport']>
type Unit = PdfTranslationSource['units'][number]
type Item = Extract<Content['items'][number], { str: string }>
type Entry = { item: Item; index: number; owner: Unit }
type Box = [number, number, number, number]
type Paint = {
  operator: number
  kind: number
  path: number[]
  matrix: number[]
  strokeWidth: number
  plainBlack: boolean
  bounds: Box
  hull: Box
  horizontalRule: boolean
}

const union = (boxes: Box[]): Box => [
  Math.min(...boxes.map((b) => b[0])),
  Math.min(...boxes.map((b) => b[1])),
  Math.max(...boxes.map((b) => b[2])),
  Math.max(...boxes.map((b) => b[3]))
]
const overlaps = (a: Box, b: Box, pad = 0): boolean =>
  a[0] - pad < b[2] && a[2] + pad > b[0] && a[1] - pad < b[3] && a[3] + pad > b[1]

/** Cheap marker gate only; it grants no native evidence or eligibility. */
export function hasNativeDisplaySequence(content: Content): boolean {
  const numbers = content.items.flatMap((i) =>
    'str' in i && nativeDisplayNumber(i.str) ? [nativeDisplayNumber(i.str)!] : []
  )
  return numbers.some((n) =>
    numbers.some((other) => other.roman === n.roman && other.value === n.value + 1)
  )
}

export function hasNativeNestedIntegralMarker(content: Content): boolean {
  return (
    content.items.some((i) => 'str' in i && i.str.includes('∫')) &&
    content.items.some((i) => 'str' in i && /^\([1-9]\d{0,3}\)$/u.test(i.str) && i.hasEOL)
  )
}

type MathItem = { str: string; height: number; width: number; transform: number[] }
const mathOperator =
  /^(?:arg\s*(?:max|min)|lim|max|min|log|ln|exp|sin|cos|tan|sinh|cosh|tanh|det)$/u
/** A potential native math atom. Long words still require an attached index below. */
export function nativeMathAtom(item: MathItem, font: number): boolean {
  const value = item.str.normalize('NFKC'),
    words = value.match(/[A-Za-z]{2,}/gu) ?? []
  return (
    !Array.from(value).some(
      (char) => /\p{L}/u.test(char) && !/[\p{Script=Latin}\p{Script=Greek}]/u.test(char)
    ) &&
    !/\p{Script=Greek}{3,}/u.test(value) &&
    item.height >= font * 0.45 &&
    item.height <= font * 1.05 &&
    (!words.length ||
      mathOperator.test(item.str.normalize('NFKC')) ||
      item.str === 'in' ||
      words.every((word) => mathOperator.test(word)) ||
      (item.height < font * 0.85 && /^[A-Za-z]{2,20}$/u.test(item.str.normalize('NFKC'))))
  )
}
type ProductEntry = { item: PdfLayoutTextItem; index: number }

const uprightProductItem = ({ dir, transform: [a, b, c, d] }: PdfLayoutTextItem): boolean =>
  dir === 'ltr' && a > 0 && b === 0 && c === 0 && d > 0

// Two centered rows under a display product can split into separate native owners.
function nativeProductParityLimit(
  packet: ProductEntry[],
  page: number,
  owners: ReadonlyMap<number, Unit>,
  duplicates: ReadonlySet<number>
): Unit | undefined {
  const [product, variable, relation, set, first, second, third, fourth] = packet
  if (!third) return
  const split = first.item.str === variable.item.str
  const condition = split ? [first, second] : [first]
  const [number, factor] = split ? [third, fourth] : [second, third]
  const membership = [variable, relation, set]
  const owner = owners.get(first.index)
  const anchor = owners.get(product.index)
  const exactClaim = (entries: ProductEntry[]): boolean => {
    const claim = owners.get(entries[0].index)
    const [fragment] = claim?.fragments ?? []
    return (
      claim?.fragments.length === 1 &&
      fragment?.pageNumber === page &&
      fragment.items.length === entries.length &&
      entries.every(
        ({ index }, n) => owners.get(index) === claim && fragment.items[n].index === index
      )
    )
  }
  if (
    !owner ||
    owner.sourceOnly ||
    owner.preserve ||
    owner.figure ||
    owner.referenceBoundary ||
    !factor ||
    !anchor ||
    (!(anchor.sourceOnly && anchor.preserve === 'formula') && !exactClaim([product])) ||
    !exactClaim(membership) ||
    !exactClaim(condition) ||
    !/^[A-Za-z]$/u.test(variable.item.str) ||
    relation.item.str !== '∈' ||
    !/^[A-Z]$/u.test(set.item.str) ||
    !['odd', 'even'].some((parity) => owner.source === variable.item.str + ' ' + parity) ||
    owner.source !== condition.map(({ item }) => item.str).join(' ') ||
    !/^\d$/u.test(number.item.str) ||
    factor.item.str !== variable.item.str ||
    !variable.item.fontName ||
    first.item.fontName !== variable.item.fontName ||
    factor.item.fontName !== variable.item.fontName ||
    relation.item.fontName === variable.item.fontName
  )
    return
  const all = [product, ...membership, ...condition, number, factor]
  if (
    all.some(
      ({ item, index }) =>
        duplicates.has(index) ||
        !uprightProductItem(item) ||
        ![item.width, item.height, ...item.transform].every(Number.isFinite) ||
        item.width <= 0 ||
        item.height <= 0
    )
  )
    return
  const h = product.item.height,
    x = product.item.transform[4],
    y = product.item.transform[5]
  const right = (item: PdfLayoutTextItem): number => item.transform[4] + item.width
  const row = (parts: ProductEntry[]): boolean =>
    Math.abs(
      (parts[0].item.transform[4] + right(parts.at(-1)!.item)) / 2 - (x + product.item.width / 2)
    ) <
      h * 0.06 &&
    parts.every(
      ({ item }, i) =>
        item.height > h * 0.48 &&
        item.height < h * 0.55 &&
        Math.abs(item.transform[5] - parts[0].item.transform[5]) < h * 0.02 &&
        (i === 0 || Math.abs(item.transform[4] - right(parts[i - 1].item)) < h * 0.15)
    )
  const inBand = (value: number, lower: number, upper: number): boolean =>
    value > lower * h && value < upper * h
  return row(membership) &&
    row(condition) &&
    inBand(y - variable.item.transform[5], 0.54, 0.61) &&
    inBand(variable.item.transform[5] - first.item.transform[5], 0.39, 0.47) &&
    inBand(number.item.transform[5] - y, 0.58, 0.67) &&
    inBand(number.item.height, 0.65, 0.75) &&
    inBand(number.item.transform[4] - right(product.item), 0.25, 0.92) &&
    Math.abs(factor.item.transform[4] - right(number.item)) < h * 0.08 &&
    Math.abs(factor.item.transform[5] - number.item.transform[5]) < h * 0.02
    ? owner
    : undefined
}

// A complete condition centered beneath a large product is part of its formula.
function nativeProductPrimeLimit(
  packet: ProductEntry[],
  owners: ReadonlyMap<number, Unit>,
  duplicates: ReadonlySet<number>
): Unit | undefined {
  const [anchor, ...condition] = packet
  const product = anchor.item
  const productOwner = owners.get(anchor.index)
  const owner = condition[0] && owners.get(condition[0].index)
  const [fragment] = owner?.fragments ?? []
  const [first, , , last] = condition
  if (
    !last ||
    !productOwner?.sourceOnly ||
    productOwner.preserve !== 'formula' ||
    !owner ||
    owner.sourceOnly ||
    owner.preserve ||
    owner.figure ||
    owner.referenceBoundary ||
    owner.fragments.length !== 1 ||
    fragment.items.length !== condition.length ||
    !/^(\p{L})\s*[<>≤≥]\s*\d+\s*,\s*\1 prime$/u.test(owner.source) ||
    condition
      .map(({ item }) => item.str)
      .join('')
      .replace(/prime$/u, ' prime') !== owner.source ||
    condition.some(
      ({ index }, i) => owners.get(index) !== owner || fragment.items[i].index !== index
    ) ||
    packet.some(
      ({ item, index }) =>
        duplicates.has(index) ||
        !uprightProductItem(item) ||
        ![item.height, item.width, ...item.transform].every(Number.isFinite) ||
        item.height <= 0 ||
        item.width <= 0
    )
  )
    return
  const h = product.height
  const [, , , , x, y] = product.transform
  const lower = y - first.item.transform[5]
  const left = first.item.transform[4]
  const right = last.item.transform[4] + last.item.width
  if (
    product.width <= h * 1.15 ||
    lower < h * 1.65 ||
    lower > h * 2.4 ||
    right - left > h * 4.5 ||
    Math.abs((left + right - 2 * x - product.width) / 2) > h * 0.2 ||
    condition.some(({ item }, i) => {
      const previous = condition[i - 1]?.item
      const gap = previous && item.transform[4] - previous.transform[4] - previous.width
      return (
        item.height < h * 0.6 ||
        item.height > h * 0.85 ||
        Math.abs(item.transform[5] - first.item.transform[5]) > h * 0.05 ||
        (gap !== undefined && (gap < -h * 0.04 || gap > h * 0.35))
      )
    })
  )
    return
  return owner
}

/** Protect terms and conditions whose native product limits establish display geometry. */
export function nativeDisplayProductTerms(
  units: readonly Unit[],
  pages: readonly PdfLayoutPage[]
): ReadonlySet<string> {
  const result = new Set<string>()
  for (const page of pages) {
    if (page.rotation !== 0 || !page.items.some(({ str }) => str === '∏')) continue
    const entries = page.items.flatMap((item, index) => (item.str.trim() ? [{ item, index }] : []))
    const owners = new Map<number, Unit>()
    const duplicates = new Set<number>()
    for (const unit of units)
      for (const part of unit.fragments) {
        if (part.pageNumber !== page.page) continue
        for (const { index, text } of part.items) {
          if (owners.has(index) || page.items[index]?.str !== text) duplicates.add(index)
          if (page.items[index]?.str === text) owners.set(index, unit)
        }
      }
    for (let n = 0; n + 3 < entries.length; n++) {
      const { item: product, index } = entries[n]
      if (product.str !== '∏') continue
      const parity = nativeProductParityLimit(
        entries.slice(n, n + 8),
        page.page,
        owners,
        duplicates
      )
      if (parity) result.add(parity.id)
      const prime = nativeProductPrimeLimit(entries.slice(n, n + 5), owners, duplicates)
      if (prime) result.add(prime.id)
      if (n === 0) continue
      const [upper, , lower, lowerValue, first] = entries.slice(n - 1, n + 4)
      const anchor = owners.get(index)
      const term = owners.get(first.index)
      if (
        !anchor?.sourceOnly ||
        anchor.preserve !== 'formula' ||
        !term ||
        term.sourceOnly ||
        term.preserve ||
        term.figure ||
        term.referenceBoundary ||
        term.fragments.length !== 1 ||
        term.fragments[0].items[0]?.index !== first.index ||
        !/^[A-Za-z]$/u.test(upper.item.str) ||
        !/^[A-Za-z]$/u.test(lower.item.str) ||
        !/^=\d+$/u.test(lowerValue.item.str) ||
        !/^[A-Za-z\p{Script=Greek}]$/u.test(first.item.str) ||
        ![upper, lower, lowerValue].every(({ index: i }) => {
          const owner = owners.get(i)
          return owner?.sourceOnly && owner.preserve === 'formula'
        })
      )
        continue
      const [x, y] = product.transform.slice(4)
      const [left, baseline] = first.item.transform.slice(4)
      const em = first.item.height
      if (
        em <= 0 ||
        ![upper.item, product, lower.item, lowerValue.item, first.item].every(uprightProductItem)
      )
        continue
      if (
        Math.abs(product.height - em) > em * 0.05 ||
        product.width <= em * 1.15 ||
        y - baseline < em * 0.75 ||
        y - baseline > em * 1.2 ||
        left - x - product.width < 0 ||
        left - x - product.width > em * 0.3 ||
        upper.item.transform[5] - y < em * 0.15 ||
        baseline - lower.item.transform[5] < em ||
        baseline - lower.item.transform[5] > em * 1.5 ||
        Math.abs(lower.item.transform[5] - lowerValue.item.transform[5]) > em * 0.05 ||
        [upper.item, lower.item, lowerValue.item].some(
          (item) =>
            item.transform[4] < x - em * 0.1 ||
            item.transform[4] + item.width > x + product.width + em * 0.15 ||
            item.height >= em * 0.85
        )
      )
        continue
      const parts = term.fragments[0].items
      if (
        parts.length < 5 ||
        parts.length > 40 ||
        parts.some(
          ({ index: i }, offset) => entries[n + 3 + offset]?.index !== i || owners.get(i) !== term
        )
      )
        continue
      const atoms = parts.map(({ index: i }) => page.items[i])
      if (
        atoms.every(
          (item) =>
            uprightProductItem(item) &&
            nativeMathAtom(item, em) &&
            !/\p{L}{2}/u.test(item.str) &&
            Math.abs(item.transform[5] - baseline) < em * 0.6 &&
            item.transform[4] >= left
        ) &&
        atoms.some(({ str }) => /[=+−×]/u.test(str)) &&
        atoms.some((item) => item.height < em * 0.85 && item.transform[5] - baseline > em * 0.15) &&
        atoms.some((item) => item.height < em * 0.85 && baseline - item.transform[5] > em * 0.15)
      )
        result.add(term.id)
    }
  }
  return result
}

/** Complete grammar over unchanged native items, including nested lowered labels. */
export function nativeClosedMathGrammar(items: readonly MathItem[], font: number): boolean {
  const text = items.map((i) => i.str.normalize('NFKC')).join(' '),
    optimization = /^(?:arg\s*)?(?:max|min)\b/u.test(text)
  if (
    items.length < 3 ||
    items.length > 256 ||
    (!/[=≡≠≈≃≤≥]/u.test(text) && !optimization) ||
    (optimization && !/[=+−]/u.test(text))
  )
    return false
  return items.every((item, at) => {
    if (!nativeMathAtom(item, font)) return false
    const value = item.str.normalize('NFKC'),
      words = value.match(/[A-Za-z]{2,}/gu) ?? []
    if (value === 'in') {
      const domain = items[at + 1],
        dimension = items[at + 2]
      return (
        !!domain &&
        !!dimension &&
        /^[RC]$/u.test(domain.str) &&
        /^\d{1,2}$/u.test(dimension.str) &&
        Math.abs(domain.height - item.height) < font * 0.05 &&
        Math.abs(domain.transform[5] - item.transform[5]) < font * 0.05 &&
        domain.transform[4] - item.transform[4] - item.width >= 0 &&
        domain.transform[4] - item.transform[4] - item.width < font * 2 &&
        dimension.height >= font * 0.5 &&
        dimension.height < font * 0.85 &&
        dimension.transform[5] - domain.transform[5] > font * 0.1 &&
        dimension.transform[5] - domain.transform[5] < font * 0.6 &&
        Math.abs(dimension.transform[4] - domain.transform[4] - domain.width) < font * 0.3
      )
    }
    if (!words.length || mathOperator.test(value) || words.every((w) => mathOperator.test(w)))
      return true
    if (!/^[A-Za-z]{2,20}$/u.test(value) || item.height >= font * 0.85) return false
    const parents = items.slice(Math.max(0, at - 8), at).filter((base, n, preceding) => {
      const gap = item.transform[4] - base.transform[4] - base.width,
        delta = base.transform[5] - item.transform[5]
      return (
        /^[,(]?[A-Za-z\p{Script=Greek}](?:,[A-Za-z\p{Script=Greek}])?$/u.test(
          base.str.normalize('NFKC')
        ) &&
        item.height >= base.height * 0.5 &&
        item.height < base.height * 0.85 &&
        delta >= base.height * 0.08 &&
        delta <= base.height * 0.5 &&
        gap >= -base.height * 0.1 &&
        gap < base.height * 0.25 &&
        preceding
          .slice(n + 1)
          .every((i) => i.height < base.height * 0.85 && /^[()\d,.'′+−-]+$/u.test(i.str))
      )
    })
    return parents.length === 1
  })
}

/** Every path is bounded by its actual control hull and a conservative stroke
 * expansion. Clipping never shrinks this envelope. No image, form, transparency,
 * or unknown paint operation is admitted by this display-only branch. */
export async function nativePaints(
  ops: Awaited<ReturnType<PDFPageProxy['getOperatorList']>>,
  viewport: Viewport,
  boundSolidMasks = false
): Promise<Paint[] | undefined> {
  const { OPS, Util } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  if (ops.fnArray.length !== ops.argsArray.length || ops.fnArray.length > 100000) return
  type State = {
    matrix: number[]
    width: number
    cap: number
    join: number
    miter: number
    dash: number[]
    stroke: string
    fill: string
    clip: number
  }
  let state: State = {
      matrix: [1, 0, 0, 1, 0, 0],
      width: 1,
      cap: 0,
      join: 0,
      miter: 10,
      dash: [],
      stroke: '#000000',
      fill: '#000000',
      clip: 0
    },
    pendingClip = false,
    controls = 0
  const stack: State[] = [],
    result: Paint[] = [],
    finite = (v: unknown, length?: number): v is number[] =>
      (Array.isArray(v) || ArrayBuffer.isView(v)) &&
      (length === undefined || (v as number[]).length === length) &&
      Array.from(v as number[]).every(Number.isFinite),
    text = new Set([
      OPS.beginText,
      OPS.endText,
      OPS.setFont,
      OPS.moveText,
      OPS.setTextMatrix,
      OPS.showText,
      OPS.setTextRenderingMode,
      OPS.dependency
    ]),
    strokeModes = new Set([
      OPS.stroke,
      OPS.closeStroke,
      OPS.fillStroke,
      OPS.eoFillStroke,
      OPS.closeFillStroke,
      OPS.closeEOFillStroke
    ]),
    fillModes = new Set([
      OPS.fill,
      OPS.eoFill,
      OPS.fillStroke,
      OPS.eoFillStroke,
      OPS.closeFillStroke,
      OPS.closeEOFillStroke
    ])
  if (boundSolidMasks) {
    text.add(OPS.setLeading)
    text.add(OPS.nextLine)
  }
  for (let index = 0; index < ops.fnArray.length; index++) {
    const op = ops.fnArray[index],
      a = ops.argsArray[index]
    if (op === OPS.save) stack.push({ ...state, matrix: [...state.matrix], dash: [...state.dash] })
    else if (op === OPS.restore) {
      if (!stack.length || pendingClip) return
      state = stack.pop()!
    } else if (op === OPS.transform) {
      if (!finite(a, 6)) return
      state.matrix = Util.transform(state.matrix, a)
      if (
        !finite(state.matrix, 6) ||
        state.matrix[0] * state.matrix[3] === state.matrix[1] * state.matrix[2]
      )
        return
    } else if (op === OPS.setLineWidth) {
      if (!Number.isFinite(a?.[0]) || a[0] <= 0) return
      state.width = a[0]
    } else if (op === OPS.setLineCap || op === OPS.setLineJoin) {
      if (![0, 1, 2].includes(a?.[0])) return
      state[op === OPS.setLineCap ? 'cap' : 'join'] = a[0]
    } else if (op === OPS.setMiterLimit) {
      if (!Number.isFinite(a?.[0]) || a[0] < 1) return
      state.miter = a[0]
    } else if (op === OPS.setDash) {
      if (!finite(a?.[0]) || a[0].some((v: number) => v < 0) || !Number.isFinite(a[1])) return
      state.dash = Array.from(a[0])
    } else if (op === OPS.setStrokeRGBColor || op === OPS.setFillRGBColor) {
      if (typeof a?.[0] !== 'string' || !/^#[0-9a-f]{6}$/u.test(a[0])) return
      state[op === OPS.setStrokeRGBColor ? 'stroke' : 'fill'] = a[0]
    } else if (op === OPS.clip || op === OPS.eoClip) {
      if (pendingClip || !stack.length) return
      pendingClip = true
      // PDF.js emits this optimized paint for a solid unit square. Include
      // its entire transformed box so it can only exclude an integral packet.
    } else if (boundSolidMasks && op === OPS.paintSolidColorImageMask) {
      if (!Array.isArray(a) || a.length || state.clip || pendingClip || state.fill !== '#000000')
        return
      const matrix = Util.transform(viewport.transform, state.matrix),
        [scaleX, b, c, d, x, y] = matrix
      if (!matrix.every(Number.isFinite) || b !== 0 || c !== 0 || scaleX <= 0 || d <= 0) return
      const bounds: Box = [x, y, x + scaleX, y + d]
      if (!bounds.every(Number.isFinite)) return
      result.push({
        operator: index,
        kind: op,
        path: [],
        matrix,
        strokeWidth: 0,
        plainBlack: true,
        bounds,
        hull: bounds,
        horizontalRule: false
      })
    } else if (op === OPS.constructPath) {
      if (a?.[0] === OPS.endPath && a?.[1]?.length === 1 && a[1][0] === null && a[2] === null) {
        if (pendingClip) return
        continue
      }
      if (a?.[1]?.length !== 1 || !finite(a[1][0]) || a[1][0].length > 10000) return
      const data = Array.from(a[1][0]) as number[],
        points: Box[] = [],
        matrix = Util.transform(viewport.transform, state.matrix)
      for (let at = 0; at < data.length;) {
        const command = data[at++],
          count =
            command === 0 || command === 1
              ? 2
              : command === 2
                ? 6
                : command === 3
                  ? 4
                  : command === 4
                    ? 0
                    : -1
        if (count < 0 || at + count > data.length || (command !== 0 && !points.length)) return
        for (const end = at + count; at < end; at += 2) {
          const p = [data[at], data[at + 1]]
          Util.applyTransform(p, matrix)
          if (!p.every(Number.isFinite) || ++controls > 100000) return
          points.push([p[0], p[1], p[0], p[1]])
        }
      }
      if (!points.length) return
      const hull = union(points),
        stroke = strokeModes.has(a[0]),
        fill = fillModes.has(a[0])
      if (!stroke && !fill && a[0] !== OPS.endPath) return
      // The Frobenius norm bounds every transformed stroke direction. Full
      // miter expansion plus one point is deliberately conservative; it is not
      // a crop, a pixel-equivalence claim, or inferred visible ink.
      const pad = stroke
        ? (Math.hypot(...state.matrix.slice(0, 4)) *
            state.width *
            Math.max(1, state.join === 0 ? state.miter : 1)) /
            2 +
          1
        : 0
      if (!Number.isFinite(pad)) return
      if (stroke || fill)
        result.push({
          operator: index,
          kind: a[0],
          path: data,
          matrix,
          strokeWidth: stroke
            ? Math.hypot(matrix[0], matrix[1], matrix[2], matrix[3]) * state.width
            : 0,
          plainBlack:
            state.clip === 0 &&
            (!stroke || (state.stroke === '#000000' && !state.dash.length)) &&
            (!fill || state.fill === '#000000'),
          hull,
          bounds: [hull[0] - pad, hull[1] - pad, hull[2] + pad, hull[3] + pad],
          horizontalRule:
            a[0] === OPS.stroke &&
            data.length === 6 &&
            data[0] === 0 &&
            data[3] === 1 &&
            hull[1] === hull[3] &&
            state.stroke === '#000000' &&
            state.cap === 0 &&
            !state.dash.length &&
            state.clip === 0
        })
      if (pendingClip) {
        if (a[0] !== OPS.endPath) return
        pendingClip = false
        state.clip++
      }
    } else if (!text.has(op)) return
  }
  return !pendingClip && !state.clip && !stack.length ? result : undefined
}

// Extensible TeX integral signs advertise a large font descent. Prove that
// specific embedded operator and every local text owner from the closed display.
async function proveNumberedNestedIntegralOwners(
  entries: Entry[],
  anchors: Entry[],
  box: (entry: Entry) => Box,
  page: PDFPageProxy,
  content: Content,
  viewport: Viewport
): Promise<Set<string>> {
  const result = new Set<string>(),
    candidates: { bounds: Box; owners: Unit[]; packet: Item[] }[] = []
  for (const anchor of anchors) {
    const {
        height: h,
        transform: [, , , , x, y]
      } = anchor.item,
      at = entries.indexOf(anchor)
    if (
      !/^\([1-9]\d{0,3}\)$/u.test(anchor.item.str) ||
      !(h > 0) ||
      anchor.item.transform.some((n) => !Number.isFinite(n)) ||
      !anchor.owner.sourceOnly ||
      anchor.owner.preserve !== 'formula' ||
      anchor.owner.fragments[0].items.length !== 1 ||
      x + anchor.item.width < viewport.width * 0.75
    )
      continue
    let first = at
    while (first > 0 && at - first < 48) {
      const i = entries[first - 1].item
      if (
        !/^(?:exp|d[A-Za-z][,.]?|[\p{Script=Latin}\p{Script=Greek}∫()[\]=−+.,\s]{1,8})$/u.test(
          i.str
        ) ||
        (i.str.match(/[A-Za-z]{2,}/gu) ?? []).some((word) => !/^(?:exp|d[A-Za-z])$/u.test(word)) ||
        i.transform[5] < y - h * 0.01 ||
        i.transform[5] > y + h * 1.55 ||
        i.transform[4] + i.width >= x - h * 3 ||
        (first < at && i.transform[4] + i.width > entries[first].item.transform[4] + h * 0.04)
      )
        break
      first--
    }
    const packet = entries.slice(first, at),
      math = packet.map(({ item }) => item),
      text = math
        .map((item) => item.str)
        .join('')
        .replaceAll(/\s/gu, ''),
      count = (re: RegExp): number => [...text.matchAll(re)].length
    if (
      !/^\p{L}(?:\(\p{L}\))?=/u.test(text) ||
      !/(?:d[A-Za-z][,.]?|\)[,.]?)$/u.test(text) ||
      count(/=/gu) !== 1 ||
      count(/∫/gu) < 2 ||
      count(/∫/gu) !== count(/d[A-Za-z]/gu)
    )
      continue
    const fences: string[] = []
    let complete = true
    for (const char of text) {
      if (char === '(' || char === '[') fences.push(char)
      else if ((char === ')' && fences.pop() !== '(') || (char === ']' && fences.pop() !== '[')) {
        complete = false
        break
      }
    }
    if (!complete || fences.length) continue
    const extender = math.find((i) => i.str.includes('∫'))?.fontName,
      extended = extender ? page.commonObjs.get(extender) : undefined,
      ordinary = [anchor.item, ...math.filter((i) => i.fontName !== extender)]
    if (
      !extended ||
      !/^(?:[A-Z]{6}\+)?CMEX10$/u.test(extended.name ?? '') ||
      extended.missingFile !== false ||
      extended.isInvalidPDFjsFont !== false ||
      extended.isType3Font !== false ||
      extended.systemFontInfo !== null ||
      extended.vertical !== false ||
      extended.ascent !== content.styles[extender!]?.ascent ||
      extended.descent !== content.styles[extender!]?.descent ||
      extended.ascent < 0 ||
      extended.ascent > 0.1 ||
      extended.descent < -2.5 ||
      extended.descent >= -1 ||
      !nativeReferenceFontWitnesses(page, { ...content, items: ordinary }) ||
      math.some((i) => {
        const rise = i.transform[5] - y
        if (
          i.dir !== 'ltr' ||
          i.width <= 0 ||
          ![...i.transform, i.width, i.height].every(Number.isFinite) ||
          i.transform[0] <= 0 ||
          i.transform[1] ||
          i.transform[2] ||
          i.transform[3] !== i.height
        )
          return true
        return i.fontName === extender
          ? !/^[∫()[\]]{1,2}$/u.test(i.str) || Math.abs(i.height - h) > h * 0.025 || rise < h * 1.1
          : i.str.includes('∫') ||
              (rise < h * 0.025
                ? Math.abs(i.height - h) > h * 0.025
                : rise < h * 0.35 || rise > h * 0.55 || i.height < h * 0.6 || i.height > h * 0.8)
      })
    )
      continue
    const selected = new Set([...packet, anchor].map((e) => e.index)),
      owners = [...new Set(packet.map(({ owner }) => owner))],
      bounds = union([...packet, anchor].map(box))
    if (
      !owners.some((o) => !o.sourceOnly && !o.preserve) ||
      owners.some(
        (owner) =>
          (owner.preserve && owner.preserve !== 'formula' && owner.preserve !== 'literal') ||
          owner.fragments.some(
            (f) =>
              f.pageNumber !== anchor.owner.fragments[0].pageNumber ||
              f.items.some((i) => !selected.has(i.index))
          )
      ) ||
      entries.some((e) => !selected.has(e.index) && overlaps(box(e), bounds))
    )
      continue
    candidates.push({ bounds, owners, packet: [...math, anchor.item] })
  }
  if (!candidates.length) return result
  const fullContentKey = JSON.stringify(content),
    scopedContent = { ...content, items: candidates.flatMap((c) => c.packet) },
    identity = await nativeInkPageIdentity(page, scopedContent, viewport)
  if (!identity) return result
  const paints = await nativePaints(identity.operators, identity.viewport, true)
  if (
    !paints ||
    identity.key !== (await nativeInkPageIdentity(page, scopedContent, viewport))?.key ||
    fullContentKey !== JSON.stringify(content)
  )
    return result
  for (const candidate of candidates)
    if (!paints.some((p) => overlaps(p.bounds, candidate.bounds)))
      for (const owner of candidate.owners)
        if (!owner.sourceOnly && !owner.preserve) result.add(owner.id)
  return result
}

const singleFractionProduct = (items: readonly Item[]): boolean =>
  items.length === 5 &&
  /^[\p{Script=Latin}\p{Script=Greek}]$/u.test(items[0].str) &&
  items[1].str === '=' &&
  /^[\p{Script=Latin}\p{Script=Greek}]$/u.test(items[2].str) &&
  /^[\p{Script=Latin}\p{Script=Greek}] ?$/u.test(items[3].str) &&
  /^[\p{Script=Latin}\p{Script=Greek}][,.]$/u.test(items[4].str)

const pairedFraction = /^\p{L}=\p{L}2\d\p{L}\+\p{L}{2}2\p{L}2\d[,.]$/u

// Only a cheap text gate. The subsequent proof requires two painted bars.
export function hasNativeStackedFractionMarker(content: Content): boolean {
  const items = content.items.filter((i): i is Item => 'str' in i && !!i.str.trim())
  return items.some(
    (i, n) =>
      /^\([1-9]\d{0,3}\)$/u.test(i.str) &&
      (pairedFraction.test(
        items
          .slice(Math.max(0, n - 13), n)
          .map((i) => i.str)
          .join('')
      ) ||
        singleFractionProduct(items.slice(Math.max(0, n - 5), n)))
  )
}

/** Match complete stacked fractions with witnessed native solids at their bars. */
async function proveNumberedStackedFractionOwners(
  entries: Entry[],
  anchors: Entry[],
  box: (entry: Entry) => Box,
  page: PDFPageProxy,
  content: Content,
  viewport: Viewport
): Promise<Set<string>> {
  const result = new Set<string>()
  const key = JSON.stringify(content)
  for (const anchor of anchors) {
    const at = entries.indexOf(anchor)
    const pair = entries.slice(Math.max(0, at - 13), at)
    const paired =
      pair.length === 13 && pairedFraction.test(pair.map(({ item }) => item.str).join(''))
    const packet = paired ? pair : entries.slice(Math.max(0, at - 5), at)
    if (
      (!paired && !singleFractionProduct(packet.map(({ item }) => item))) ||
      !anchor.owner.sourceOnly ||
      anchor.owner.preserve !== 'formula' ||
      !/^\([1-9]\d{0,3}\)$/u.test(anchor.item.str) ||
      anchor.owner.fragments[0].items.length !== 1
    )
      continue
    const sequence = [...packet, anchor]
    const scoped = { ...content, items: sequence.map(({ item }) => item) }
    if (!nativeReferenceFontWitnesses(page, scoped)) continue
    const {
      height: h,
      transform: [, , , , x, y]
    } = anchor.item
    if (!(h > 0) || x + anchor.item.width < viewport.width * 0.75) continue
    const body = paired ? [0, 1, 6, 12] : [0, 1, 4]
    const top = paired ? [2, 7, 9] : [2]
    const raised = paired ? [3, 8, 10] : []
    const bottom = paired ? [4, 5, 11] : [3]
    const horizontal = paired ? [0, 1, 4, 6, 7, 12] : [0, 1, 3, 4]
    if (
      sequence.some(
        ({ item }) =>
          item.dir !== 'ltr' ||
          item.width <= 0 ||
          ![item.width, item.height, ...item.transform].every(Number.isFinite) ||
          item.transform[0] !== item.height ||
          item.transform[3] !== item.height ||
          item.transform[1] !== 0 ||
          item.transform[2] !== 0
      ) ||
      body.some((i) => Math.abs(packet[i].item.transform[5] - y) > h * 0.02) ||
      top.some((i) => Math.abs(packet[i].item.transform[5] - y - h * 0.67) > h * 0.08) ||
      bottom.some((i) => Math.abs(packet[i].item.transform[5] - y + h * 0.68) > h * 0.08) ||
      [...body, ...top, ...bottom].some((i) => Math.abs(packet[i].item.height - h) > h * 0.02) ||
      raised.some((i) => {
        const item = packet[i].item,
          base = packet[i - 1].item
        return (
          Math.abs(item.height - h * 0.7) > h * 0.06 ||
          Math.abs(item.transform[5] - base.transform[5] - h * 0.37) > h * 0.07 ||
          Math.abs(item.transform[4] - base.transform[4] - base.width) > h * 0.06
        )
      }) ||
      horizontal.some(
        (i, n, order) =>
          n > 0 && packet[order[n - 1]].item.transform[4] >= packet[i].item.transform[4]
      ) ||
      (!paired &&
        (box(packet[0])[2] > box(packet[1])[0] ||
          box(packet[1])[2] > Math.min(box(packet[2])[0], box(packet[3])[0]) ||
          Math.abs(packet[2].item.transform[4] - packet[3].item.transform[4]) > h * 0.12 ||
          packet[4].item.transform[4] - packet[3].item.transform[4] - packet[3].item.width >
            h * 0.25 ||
          packet[4].item.transform[4] <
            packet[3].item.transform[4] + packet[3].item.width - h * 0.03))
    )
      continue
    const bounds = union(sequence.map(box)),
      selected = new Set(sequence.map((e) => e.index)),
      owners = [...new Set(sequence.map((e) => e.owner))]
    if (
      entries.some((e) => !selected.has(e.index) && overlaps(box(e), bounds)) ||
      owners.some(
        (owner) =>
          (owner.preserve && owner.preserve !== 'formula' && owner.preserve !== 'literal') ||
          owner.fragments.some(
            (f) =>
              f.pageNumber !== anchor.owner.fragments[0].pageNumber ||
              f.items.some((i) => !selected.has(i.index))
          )
      )
    )
      continue
    const identity = await nativeInkPageIdentity(page, scoped, viewport)
    if (!identity) continue
    const paint = await nativePaints(identity.operators, viewport, true),
      local = paint?.filter((p) => overlaps(p.bounds, bounds))
    const fractions = paired
      ? [
          [2, 3, 4, 5],
          [7, 8, 9, 10, 11]
        ]
      : [[2, 3]]
    if (!local || local.length !== fractions.length) continue
    const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    local.sort((a, b) => a.bounds[0] - b.bounds[0])
    if (
      local.some((rule, i) => {
        const [l, t, r, b] = rule.bounds
        const members = fractions[i].map((n) => packet[n].item)
        const measureLeft = Math.min(...members.map((item) => item.transform[4]))
        const measureRight = Math.max(...members.map((item) => item.transform[4] + item.width))
        const ruleHeight = b - t,
          elevation = viewport.height - (b + t) / 2 - y
        return (
          rule.kind !== OPS.paintSolidColorImageMask ||
          !rule.plainBlack ||
          ruleHeight <= h * 0.025 ||
          ruleHeight >= h * 0.065 ||
          l > measureLeft + h * 0.03 ||
          l < measureLeft - h * 0.15 ||
          // A space attached to the denominator can extend its text box past the ink.
          r < measureRight - h * (!paired && packet[3].item.str.endsWith(' ') ? 0.12 : 0.03) ||
          r > measureRight + h * 0.15 ||
          elevation < h * 0.15 ||
          elevation > h * 0.35
        )
      }) ||
      (paired && Math.abs(local[0].bounds[1] - local[1].bounds[1]) > 0.01) ||
      key !== JSON.stringify(content) ||
      identity.key !== (await nativeInkPageIdentity(page, scoped, viewport))?.key
    )
      continue
    for (const owner of owners) if (!owner.sourceOnly && !owner.preserve) result.add(owner.id)
  }
  return result
}

// PDF.js may expose the embedded Computer Modern root glyph as a Latin p.
export function hasNativeEncodedRadicalMarker(content: Content): boolean {
  return (
    content.items.some((item) => 'str' in item && item.str === 'p') &&
    content.items.some(
      (item) => 'str' in item && /^\([1-9]\d{0,3}\)$/u.test(item.str) && item.hasEOL
    )
  )
}

async function proveNumberedEncodedRadicalOwners(
  entries: Entry[],
  anchors: Entry[],
  box: (entry: Entry) => Box,
  page: PDFPageProxy,
  content: Content,
  viewport: Viewport
): Promise<Set<string>> {
  const result = new Set<string>()
  if (!hasNativeEncodedRadicalMarker(content)) return result
  const inputKey = JSON.stringify(content)
  for (const anchor of anchors) {
    const h = anchor.item.height,
      [, , , , x, y] = anchor.item.transform
    if (
      nativeDisplayNumber(anchor.item.str)?.roman ||
      !anchor.owner.sourceOnly ||
      anchor.owner.preserve !== 'formula' ||
      anchor.owner.fragments[0].items.length !== 1
    )
      continue
    const end = entries.indexOf(anchor)
    let start = end
    while (start > 0) {
      const item = entries[start - 1].item
      if (
        Math.abs(item.transform[5] - y) > h ||
        item.transform[4] + item.width > x - h ||
        !nativeMathAtom(item, h)
      )
        break
      start--
    }
    const math = entries.slice(start, end)
    const rootIndex = math.findIndex(
      ({ item }) => item.str === 'p' && item.transform[5] - y > h * 0.65
    )
    const root = math[rootIndex]
    const radicand = math.slice(rootIndex + 1)
    const equation = math
      .map(({ item }, i) =>
        i === rootIndex
          ? '√'
          : item.height < h * 0.85 && /^[a-z]+$/u.test(item.str)
            ? '_'
            : item.str.replaceAll(/\s/gu, '')
      )
      .join('')
    if (
      rootIndex < 2 ||
      root.owner.preserve !== 'formula' ||
      !root.owner.sourceOnly ||
      !/^\p{L}_(?:[−-]_)?=√\(\p{L}_\)\d+\+\(\d+(?:\.\d+)?[·×]\p{L}_\)\d+$/u.test(equation) ||
      math.some(({ item }, i) => {
        const shift = item.transform[5] - y
        const previous = math[i - 1]?.item
        const gap = previous ? item.transform[4] - previous.transform[4] - previous.width : 0
        return (
          item.dir !== 'ltr' ||
          item.width <= 0 ||
          item.transform[0] <= 0 ||
          item.transform[1] !== 0 ||
          item.transform[2] !== 0 ||
          item.transform[3] !== item.height ||
          gap < -h * 0.02 ||
          gap > h ||
          (i === rootIndex
            ? shift >= h || Math.abs(item.height - h) > h * 0.03
            : item.height >= h * 0.85
              ? Math.abs(shift) > h * 0.03
              : gap > h * 0.25 ||
                (/^\d+$/u.test(item.str)
                  ? shift < h * 0.15 || shift > h * 0.45
                  : shift > -h * 0.08 || shift < -h * 0.3))
        )
      })
    )
      continue

    const packet = [...math, anchor],
      indexes = new Set(packet.map(({ index }) => index))
    const owners = [...new Set(packet.map(({ owner }) => owner))]
    const bounds = union(packet.map(box))
    if (
      bounds.some((n) => !Number.isFinite(n)) ||
      bounds[0] < 0 ||
      bounds[1] < 0 ||
      bounds[2] > viewport.width ||
      bounds[3] > viewport.height ||
      entries.some((entry) => !indexes.has(entry.index) && overlaps(box(entry), bounds)) ||
      owners.some(
        (owner) =>
          owner.figure ||
          owner.referenceBoundary ||
          (owner.preserve && owner.preserve !== 'formula') ||
          owner.fragments.some(
            (f) =>
              f.pageNumber !== anchor.owner.fragments[0].pageNumber ||
              f.items.some((item) => !indexes.has(item.index))
          )
      )
    )
      continue

    const scoped = { ...content, items: packet.map(({ item }) => item) }
    if (!nativeReferenceFontWitnesses(page, scoped)) continue
    const rootFont = page.commonObjs.get(root.item.fontName)
    if (!/^(?:[A-Z]{6}\+)?CMEX10$/u.test(rootFont?.name ?? '') || rootFont.isSymbolicFont !== true)
      continue
    const identity = await nativeInkPageIdentity(page, scoped, viewport)
    if (!identity) continue
    const paints = await nativePaints(identity.operators, viewport)
    const local = paints?.filter((paint) => overlaps(paint.bounds, bounds))
    const roof = local?.[0]
    const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    if (
      !roof ||
      local?.length !== 1 ||
      !roof.horizontalRule ||
      !roof.plainBlack ||
      roof.kind !== OPS.stroke ||
      roof.strokeWidth > h * 0.08 ||
      Math.abs(roof.hull[0] - box(root)[2]) > h * 0.05 ||
      Math.abs(viewport.height - roof.hull[1] - root.item.transform[5]) > h * 0.05 ||
      Math.abs(roof.hull[2] - box(radicand.at(-1)!)[2]) > h * 0.08 ||
      radicand.some((entry) => box(entry)[1] < roof.hull[1] - h * 0.02)
    )
      continue

    const { fnArray, argsArray } = identity.operators
    const glyphAt = fnArray.lastIndexOf(OPS.showText, roof.operator)
    const fontAt = fnArray.lastIndexOf(OPS.setFont, glyphAt)
    const glyphs = argsArray[glyphAt]?.[0]
    if (
      glyphAt < 0 ||
      fontAt < 0 ||
      argsArray[fontAt]?.[0] !== root.item.fontName ||
      glyphs?.length !== 1 ||
      glyphs[0]?.originalCharCode !== 112 ||
      glyphs[0]?.unicode !== 'p' ||
      glyphs[0]?.isInFont !== true ||
      inputKey !== JSON.stringify(content) ||
      identity.key !== (await nativeInkPageIdentity(page, scoped, viewport))?.key
    )
      continue
    for (const owner of owners) if (!owner.sourceOnly && !owner.preserve) result.add(owner.id)
  }
  return result
}

/** Returns only complete existing owner IDs, never inferred text or geometry. */
export async function nativeScopedDisplayOwners(
  units: readonly Unit[],
  page: PDFPageProxy,
  content: Content,
  viewport: Viewport,
  pageNumber: number,
  auxiliary: AuxiliaryNativeInkReader
): Promise<ReadonlySet<string>> {
  const empty = new Set<string>()
  try {
    const inputContent = content,
      inputViewport = viewport,
      inputUnits = units,
      sourceKey = JSON.stringify(units),
      operatorReader = page.getOperatorList,
      objects = page.commonObjs,
      objectReader = objects.get,
      objectHas = objects.has,
      unitSnapshot = structuredClone(units)
    if (
      viewport.scale !== 1 ||
      viewport.rotation !== 0 ||
      JSON.stringify(viewport.transform) !== JSON.stringify([1, 0, 0, -1, 0, viewport.height]) ||
      !(
        hasNativeDisplaySequence(content) ||
        hasNativeNestedIntegralMarker(content) ||
        hasNativeStackedFractionMarker(content) ||
        hasNativeEncodedRadicalMarker(content)
      )
    )
      return empty
    const hasPageFontWitness = nativeReferenceFontWitnesses(page, content)
    const identity = hasPageFontWitness
      ? await nativeInkPageIdentity(page, content, viewport)
      : undefined
    if (hasPageFontWitness && !identity) return empty
    if (identity) {
      content = identity.content
      viewport = identity.viewport
    }
    units = unitSnapshot
    const owners = new Map<number, Unit>(),
      counts = new Map<number, number>(),
      sourceTexts = new Map<number, string>()
    for (const unit of units)
      for (const fragment of unit.fragments)
        if (fragment.pageNumber === pageNumber)
          for (const item of fragment.items) {
            owners.set(item.index, unit)
            counts.set(item.index, (counts.get(item.index) ?? 0) + 1)
            sourceTexts.set(item.index, item.text)
          }
    const entries: Entry[] = content.items.flatMap((item, index): Entry[] =>
      'str' in item && item.str.trim() ? [{ item, index, owner: owners.get(index)! }] : []
    )
    if (
      entries.some(
        (e) => !e.owner || counts.get(e.index) !== 1 || sourceTexts.get(e.index) !== e.item.str
      )
    )
      return empty
    const box = (e: Entry): Box => {
        const i = e.item,
          style = content.styles[i.fontName]
        return [
          i.transform[4],
          viewport.height - i.transform[5] - style.ascent * i.height,
          i.transform[4] + i.width,
          viewport.height - i.transform[5] - style.descent * i.height
        ]
      },
      anchors = entries.filter(
        (e) =>
          nativeDisplayNumber(e.item.str) &&
          e.item.hasEOL === true &&
          e.owner.fragments.length === 1
      ),
      packets: { entries: Entry[]; owners: Unit[]; anchor: Entry }[] = []
    const encodedRadicals = await proveNumberedEncodedRadicalOwners(
      entries,
      anchors,
      box,
      page,
      content,
      viewport
    )
    if (
      !identity ||
      (!hasNativeDisplaySequence(content) && hasNativeStackedFractionMarker(content))
    ) {
      const scoped = await proveNumberedNestedIntegralOwners(
        entries,
        anchors,
        box,
        page,
        content,
        viewport
      )
      for (const id of encodedRadicals) scoped.add(id)
      if (hasNativeStackedFractionMarker(content))
        for (const id of await proveNumberedStackedFractionOwners(
          entries,
          anchors,
          box,
          page,
          content,
          viewport
        ))
          scoped.add(id)
      return sourceKey === JSON.stringify(inputUnits) &&
        page.getOperatorList === operatorReader &&
        page.commonObjs === objects &&
        objects.get === objectReader &&
        objects.has === objectHas
        ? scoped
        : empty
    }
    const current = (): boolean =>
      sourceKey === JSON.stringify(inputUnits) &&
      page.getOperatorList === operatorReader &&
      page.commonObjs === objects &&
      objects.get === objectReader &&
      objects.has === objectHas
    if (!hasNativeDisplaySequence(content)) return current() ? encodedRadicals : empty

    for (const anchor of anchors) {
      const h = anchor.item.height,
        y = anchor.item.transform[5],
        x = anchor.item.transform[4],
        number = nativeDisplayNumber(anchor.item.str)!
      const aligned = new Set(
        anchors.flatMap((e) => {
          const n = nativeDisplayNumber(e.item.str)
          return n?.roman &&
            Math.abs(e.item.transform[4] + e.item.width - x - anchor.item.width) < h * 0.05
            ? [n.value]
            : []
        })
      )
      if (
        number.roman &&
        ![number.value - 2, number.value - 1, number.value].some((start) =>
          [0, 1, 2].every((n) => aligned.has(start + n))
        )
      )
        continue
      let first = entries.indexOf(anchor)
      while (first > 0) {
        const i = entries[first - 1].item
        if (
          Math.abs(i.transform[5] - y) > h * 5 ||
          i.transform[4] + i.width > x + anchor.item.width + h * 0.1 ||
          nativeDisplayNumber(i.str) ||
          !nativeMathAtom(i, h)
        )
          break
        first--
      }
      const packet = entries.slice(first, entries.indexOf(anchor) + 1),
        math = packet.slice(0, -1),
        selected = new Set(packet.map((e) => e.index)),
        whole = [...new Set(packet.map((e) => e.owner))]
      if (
        math.length < 3 ||
        math.length > 256 ||
        !nativeClosedMathGrammar(
          math.map((e) => e.item),
          h
        ) ||
        !whole.some((o) => !o.sourceOnly && !o.preserve) ||
        whole.some(
          (o) =>
            o.fragments.some(
              (f) => f.pageNumber !== pageNumber || f.items.some((i) => !selected.has(i.index))
            ) ||
            (o.preserve && !['formula', 'literal'].includes(o.preserve))
        )
      )
        continue
      packets.push({ entries: packet, owners: whole, anchor })
    }
    if (!packets.length) return current() ? encodedRadicals : empty
    const selected = new Set(packets.flatMap((p) => p.entries.map((e) => e.index))),
      ink =
        (await nativeTextFreeClipInkRegions(
          page,
          content,
          viewport,
          pageNumber,
          selected,
          identity.operators
        )) ??
        (await auxiliary.read({
          page,
          content,
          viewport,
          pageNumber,
          selected,
          operatorSnapshot: identity.operators
        })),
      paints = await nativePaints(identity.operators, viewport)
    if (
      !ink ||
      ink.size !== entries.length ||
      !paints ||
      sourceKey !== JSON.stringify(inputUnits) ||
      page.getOperatorList !== operatorReader ||
      page.commonObjs !== objects ||
      objects.get !== objectReader ||
      objects.has !== objectHas ||
      identity.key !== (await nativeInkPageIdentity(page, inputContent, inputViewport))?.key
    )
      return current() ? encodedRadicals : empty
    const inkBox = (index: number): Box => {
        const r = ink.get(index)!
        return [
          r.x * viewport.width,
          r.y * viewport.height,
          (r.x + r.width) * viewport.width,
          (r.y + r.height) * viewport.height
        ]
      },
      result = encodedRadicals
    for (const packet of packets) {
      const selected = new Set(packet.entries.map((e) => e.index)),
        bounds = union(packet.entries.flatMap((e) => [box(e), inkBox(e.index)])),
        h = packet.anchor.item.height,
        y = packet.anchor.item.transform[5],
        x = packet.anchor.item.transform[4],
        math = packet.entries.slice(0, -1),
        rules: number[] = []
      if (
        !bounds.every(Number.isFinite) ||
        bounds[0] < 0 ||
        bounds[1] < 0 ||
        bounds[2] > viewport.width ||
        bounds[3] > viewport.height ||
        entries.some((e) => !selected.has(e.index) && overlaps(inkBox(e.index), bounds, 1))
      )
        continue
      let closed = true
      for (const paint of paints.filter((p) => overlaps(p.bounds, bounds))) {
        const r = paint.hull,
          above = math.some((e) => {
            const b = box(e)
            return b[0] >= r[0] && b[2] <= r[2] && b[3] < r[1]
          }),
          below = math.some((e) => {
            const b = box(e)
            return b[0] >= r[0] && b[2] <= r[2] && b[1] > r[1]
          })
        if (
          paint.horizontalRule &&
          r[0] >= bounds[0] &&
          r[2] < x - h &&
          r[2] - r[0] >= h * 0.6 &&
          r[2] - r[0] < h * 8 &&
          above &&
          below
        )
          rules.push(paint.operator)
        else {
          closed = false
          break
        }
      }
      if (
        !closed ||
        (packet.owners.some(
          (o) =>
            !o.sourceOnly &&
            !o.preserve &&
            o.fragments
              .flatMap((f) => f.items)
              .every((i) => Math.abs((content.items[i.index] as Item).transform[5] - y) > h * 0.05)
        ) &&
          rules.length !== 1)
      )
        continue
      for (const owner of packet.owners)
        if (!owner.sourceOnly && !owner.preserve) result.add(owner.id)
    }
    return result
  } catch {
    return empty
  }
}
