import {
  getPdfTranslationTextContent,
  createPdfTranslationTargetExclusions,
  sameNativeMatrixBody,
  sameNativeFunctionDisplay,
  nativeMixedBulletOwners,
  nativeMixedBulletLiteralsMatch,
  resolveInlineFractions,
  type PdfTranslationResults
} from '@aipoch/pdf-translation/reader'

import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { pdfjsLib } from '../pdfjs'
import type { PdfTranslationPageGeometry as Geometry } from './pdf-translation-document-state'
import {
  annotationKey,
  sameCoordinates,
  textKey,
  verifyPdfTranslationLinks,
  type AnnotationSnapshot
} from './pdf-translation-link-verification'

type TextContent = Awaited<ReturnType<PDFPageProxy['getTextContent']>>
type TextItem = Extract<TextContent['items'][number], { str: string }>
type VerifiedPower = { power: string; exponent: string }

// Unicode powers may retain the publisher's digit glyph and raised geometry.
// Admit that spelling only when both PDFs prove the same adjacent base/exponent.
function verifiedPowerText(
  original: TextContent,
  target: TextContent,
  labels: Set<string>
): Map<number, VerifiedPower> {
  const pairs = (
    content: TextContent
  ): {
    index: number
    label: string
    size: number
    baseSize: number
    rise: number
    width: number
  }[] =>
    content.items.flatMap((marker, index) => {
      if (
        !('str' in marker) ||
        !/^\d{1,2}$/u.test(marker.str) ||
        marker.transform[0] <= 0 ||
        marker.transform[1] !== 0 ||
        marker.transform[2] !== 0
      )
        return []
      const bases = content.items.filter(
        (base): base is TextItem =>
          'str' in base &&
          /(?:[A-Za-z\p{Script=Greek}]\d{0,3}|(?<!\d)10)$/u.test(base.str) &&
          base.transform[0] > 0 &&
          base.transform[1] === 0 &&
          base.transform[2] === 0 &&
          marker.transform[3] < base.transform[3] * 0.85 &&
          marker.transform[5] - base.transform[5] > base.transform[3] * 0.2 &&
          marker.transform[5] - base.transform[5] < base.transform[3] * 0.8 &&
          Math.abs(marker.transform[4] - base.transform[4] - base.width) < base.transform[3] * 0.2
      )
      if (bases.length !== 1) return []
      const base = bases[0],
        label =
          base.str.match(/(?:[A-Za-z\p{Script=Greek}]\d{0,3}|(?<!\d)10)$/u)![0] +
          [...marker.str].map((d) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(d)]).join('')
      return labels.has(label)
        ? [
            {
              index,
              label,
              size: marker.transform[3],
              baseSize: base.transform[3],
              rise: marker.transform[5] - base.transform[5],
              width: marker.width
            }
          ]
        : []
    })
  const before = pairs(original),
    after = pairs(target),
    result = new Map<number, VerifiedPower>()
  // Verify the original sign, raised digits and returning quantity symbol
  // before reading the two native script objects as a Unicode power.
  const signedQuantities = (
    content: TextContent,
    exponent: string,
    symbol: string
  ): { signIndex: number; digitIndex: number; metrics: number[][] }[] => {
    const entries = content.items.flatMap((item, index) =>
      'str' in item && item.str.trim() ? [{ ...item, index }] : []
    )
    return entries.flatMap((base, index) => {
      const chain = entries.slice(index, index + 4)
      if (chain.length !== 4) return []
      const [, sign, digits, suffix] = chain
      if (
        base.str !== '10' ||
        sign.str !== '−' ||
        digits.str !== exponent.normalize('NFKC') ||
        suffix.str !== symbol ||
        chain.some(
          ({ width, transform: [a, b, c, d, x, y] }) =>
            ![width, a, d, x, y].every(Number.isFinite) ||
            width <= 0 ||
            a <= 0 ||
            a !== d ||
            b !== 0 ||
            c !== 0
        )
      )
        return []
      const [size, , , , x, y] = base.transform
      if (
        sign.transform[3] < size * 0.5 ||
        sign.transform[3] >= size * 0.85 ||
        Math.abs(digits.transform[3] - sign.transform[3]) > 0.01 ||
        sign.transform[5] - y <= size * 0.2 ||
        sign.transform[5] - y >= size * 0.75 ||
        Math.abs(digits.transform[5] - sign.transform[5]) > 0.01 ||
        Math.abs(suffix.transform[3] - size) > 0.01 ||
        Math.abs(suffix.transform[5] - y) > 0.01 ||
        chain.slice(1).some(({ transform }, i) => {
          const gap = transform[4] - chain[i].transform[4] - chain[i].width
          return gap < -0.02 || gap > size * 0.3
        })
      )
        return []
      const metrics = chain.map(({ width, transform: [a, b, c, d, tx, ty] }) => [
        width,
        a,
        b,
        c,
        d,
        tx - x,
        ty - y
      ])
      return [{ signIndex: sign.index, digitIndex: digits.index, metrics }]
    })
  }
  for (const label of labels) {
    const signed = /^10⁻([⁰¹²³⁴⁵⁶⁷⁸⁹]{1,2})([a-z])$/u.exec(label)
    if (signed) {
      const originals = signedQuantities(original, signed[1], signed[2]),
        written = signedQuantities(target, signed[1], signed[2])
      if (
        originals.length === 1 &&
        written.length === 1 &&
        written[0].metrics.every((metrics, row) =>
          metrics.every((value, col) => Math.abs(value - originals[0].metrics[row][col]) < 0.01)
        )
      ) {
        result.set(written[0].signIndex, { power: label, exponent: '⁻' })
        result.set(written[0].digitIndex, { power: label, exponent: signed[1] })
      }
      continue
    }
    const sources = before.filter((p) => p.label === label),
      targets = after.filter((p) => p.label === label)
    if (
      !sources.length ||
      sources.length !== targets.length ||
      !targets.every(
        (p, i) =>
          Math.abs(p.size - sources[i].size) < 0.01 &&
          // Native CJK ink fitting can move the generated base by at most
          // 5% of its font size (capped at half a point); exponent glyphs
          // retain their exact font and width and must still be adjacent.
          Math.abs(p.rise - sources[i].rise) <=
            Math.min(0.5, p.baseSize * 0.05, sources[i].baseSize * 0.05) &&
          Math.abs(p.width - sources[i].width) < 0.01
      )
    )
      continue
    const exponent = label.match(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+$/u)![0]
    for (const p of targets) result.set(p.index, { power: label, exponent })
  }
  return result
}

// A footnote may be spelled with a Unicode superscript in the model
// output while the PDF retains the original digit and its raised placement.
function verifiedNativeFootnote(
  original: TextItem[],
  target: TextItem[],
  label: string,
  trailing = false
): boolean {
  const adjacent = (body: TextItem, marker: TextItem): boolean =>
    !trailing ||
    (marker.transform[5] - body.transform[5] > body.transform[3] * 0.2 &&
      marker.transform[5] - body.transform[5] < body.transform[3] * 0.8 &&
      Math.abs(marker.transform[4] - body.transform[4] - body.width) < body.transform[3] * 0.2)
  const before = original.filter((item) => item.str.trim()),
    after = target.filter((item) => item.str.trim()),
    sourceMarker = before[0],
    targetMarker = after[0],
    sourceBody = before.find(
      (item) => /[\p{L}]{2}/u.test(item.str) && adjacent(item, sourceMarker)
    ),
    targetBody = after.find((item) => /[\p{L}]{2}/u.test(item.str) && adjacent(item, targetMarker)),
    digit = label.normalize('NFKC')
  if (
    !sourceMarker ||
    !targetMarker ||
    !sourceBody ||
    !targetBody ||
    sourceMarker.str !== digit ||
    targetMarker.str !== digit
  )
    return false
  const raised = (marker: TextItem, body: TextItem): boolean =>
    marker.transform[0] > 0 &&
    marker.transform[3] > 0 &&
    Math.abs(marker.transform[1]) < 0.001 &&
    Math.abs(marker.transform[2]) < 0.001 &&
    Math.abs(body.transform[1]) < 0.001 &&
    Math.abs(body.transform[2]) < 0.001 &&
    marker.transform[3] < body.transform[3] * 0.9 &&
    marker.transform[5] - body.transform[5] > body.transform[3] * 0.2 &&
    (trailing ||
      (body.transform[4] >= marker.transform[4] - 1 &&
        body.transform[4] <= marker.transform[4] + marker.width + body.transform[3]))
  return (
    raised(sourceMarker, sourceBody) &&
    raised(targetMarker, targetBody) &&
    sourceMarker.transform
      .slice(0, 4)
      .every((value, index) => Math.abs(value - targetMarker.transform[index]) < 0.01) &&
    Math.abs(sourceMarker.width - targetMarker.width) < 0.01 &&
    Math.abs(
      sourceMarker.transform[5] -
        sourceBody.transform[5] -
        (targetMarker.transform[5] - targetBody.transform[5])
    ) < 0.05
  )
}

type NativeBar = { rect: number[]; width: number; segment?: boolean }
async function nativeHorizontalBars(page: PDFPageProxy): Promise<NativeBar[]> {
  const { fnArray, argsArray } = await page.getOperatorList(),
    ops = pdfjsLib.OPS
  let matrix = [1, 0, 0, 1, 0, 0],
    width = 1
  const stack: Array<{ matrix: number[]; width: number }> = [],
    result: NativeBar[] = [],
    ordinary = !fnArray.some((op) =>
      [
        ops.paintFormXObjectBegin,
        ops.paintFormXObjectEnd,
        ops.beginGroup,
        ops.clip,
        ops.eoClip
      ].includes(op)
    )
  const transform = (m: number[], x: number, y: number): number[] => [
    m[0] * x + m[2] * y + m[4],
    m[1] * x + m[3] * y + m[5]
  ]
  for (let i = 0; i < fnArray.length; i++) {
    const op = fnArray[i],
      args = argsArray[i]
    if (op === ops.save) stack.push({ matrix: [...matrix], width })
    else if (op === ops.restore) {
      const saved = stack.pop()
      if (saved) ({ matrix, width } = saved)
    } else if (op === ops.setLineWidth) width = args[0]
    else if (op === ops.transform) {
      const m = args.length === 1 ? args[0] : args
      const origin = transform(matrix, m[4], m[5])
      matrix = [
        matrix[0] * m[0] + matrix[2] * m[1],
        matrix[1] * m[0] + matrix[3] * m[1],
        matrix[0] * m[2] + matrix[2] * m[3],
        matrix[1] * m[2] + matrix[3] * m[3],
        ...origin
      ]
    } else if (op === ops.paintSolidColorImageMask) {
      // PDF.js represents a solid one-pixel stencil as a unit rectangle.
      // Its complete transformed ink must survive with the fraction glyphs.
      const a = transform(matrix, 0, 0),
        b = transform(matrix, 1, 1),
        rect = [
          Math.min(a[0], b[0]),
          Math.min(a[1], b[1]),
          Math.max(a[0], b[0]),
          Math.max(a[1], b[1])
        ]
      if (
        Math.abs(matrix[1]) < 0.001 &&
        Math.abs(matrix[2]) < 0.001 &&
        rect[2] > rect[0] &&
        rect[3] - rect[1] > 0 &&
        rect[3] - rect[1] <= 1
      )
        result.push({ rect, width: rect[3] - rect[1] })
    } else if (
      op === ops.constructPath &&
      [ops.stroke, ops.fill, ops.eoFill, ops.fillStroke].includes(args[0]) &&
      args[2]?.length === 4
    ) {
      const [x1, y1, x2, y2] = args[2],
        a = transform(matrix, x1, y1),
        b = transform(matrix, x2, y2)
      const rect = [
        Math.min(a[0], b[0]),
        Math.min(a[1], b[1]),
        Math.max(a[0], b[0]),
        Math.max(a[1], b[1])
      ]
      if (
        Math.abs(matrix[1]) < 0.001 &&
        Math.abs(matrix[2]) < 0.001 &&
        rect[2] > rect[0] &&
        rect[3] - rect[1] <= 1
      )
        result.push({
          rect,
          segment:
            ordinary &&
            args[0] === ops.stroke &&
            args[1]?.length === 1 &&
            ((args[1][0]?.length === 6 &&
              args[1][0][0] === 0 &&
              args[1][0][3] === 1 &&
              args[1][0][2] === args[1][0][5]) ||
              (args[1][0]?.length === 9 &&
                args[1][0][0] === 0 &&
                args[1][0][3] === 0 &&
                args[1][0][6] === 1 &&
                args[1][0][1] === args[1][0][4] &&
                args[1][0][2] === args[1][0][5] &&
                args[1][0][5] === args[1][0][8])),
          width: args[0] === ops.stroke ? width * Math.abs(matrix[0]) : rect[3] - rect[1]
        })
    }
  }
  return result
}

// This is a negative preservation check, never a table grid or permission to repaint.
async function nativeParameterBodyUnchanged(
  originalPage: PDFPageProxy,
  targetPage: PDFPageProxy,
  original: TextContent,
  target: TextContent
): Promise<boolean> {
  const headers = original.items.filter(
    (item): item is TextItem => 'str' in item && item.str.trim() === 'Parameters'
  )
  if (!headers.length || headers.length > 8) return true
  type Native = { item: TextItem; rect: number[] }
  const native = (content: TextContent): Native[] | undefined => {
    const result: Native[] = []
    for (const item of content.items) {
      if (!('str' in item) || !item.str.trim()) continue
      const style = content.styles?.[item.fontName],
        [a, b, c, d, x, y] = item.transform
      if (
        item.dir !== 'ltr' ||
        style?.vertical !== false ||
        ![a, b, c, d, x, y, item.width, item.height, style.ascent, style.descent].every(
          Number.isFinite
        ) ||
        a <= 0 ||
        d <= 0 ||
        b !== 0 ||
        c !== 0 ||
        item.width <= 0 ||
        Math.abs(item.height - d) > 0.001 ||
        style.ascent <= style.descent
      )
        return
      result.push({ item, rect: [x, y + style.descent * d, x + item.width, y + style.ascent * d] })
    }
    return result
  }
  const before = native(original)
  if (!before || before.length > 8192) return true
  const bars = (await nativeHorizontalBars(originalPage)).filter(
    (bar) => bar.segment && bar.width > 0 && bar.width <= 1
  )
  if (bars.length > 256) return true
  const overlaps = (a: number[], b: number[]): boolean =>
    a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
  const inside = (a: number[], b: number[]): boolean =>
    a[0] >= b[0] - 0.001 && a[2] <= b[2] + 0.001 && a[1] >= b[1] && a[3] <= b[3]
  const same = (a: number, b: number): boolean => Math.abs(a - b) < 0.001
  for (const header of headers) {
    const h = before.find((entry) => entry.item === header)!,
      em = header.height
    const enclosing = bars.filter(
      ({ rect }) => rect[0] < h.rect[0] && rect[2] > h.rect[2] && rect[2] - rect[0] > em * 12
    )
    const families = enclosing.filter(
      (bar, index) =>
        enclosing.findIndex(
          (other) => same(other.rect[0], bar.rect[0]) && same(other.rect[2], bar.rect[2])
        ) === index
    )
    for (const family of families) {
      const fences = enclosing
        .filter((bar) => same(bar.rect[0], family.rect[0]) && same(bar.rect[2], family.rect[2]))
        .sort((a, b) => b.rect[1] - a.rect[1])
      if (
        fences.length < 4 ||
        fences.length > 8 ||
        fences.some((f, i) => i > 0 && fences[i - 1].rect[1] - f.rect[1] < em)
      )
        continue
      const top = fences[0].rect[1],
        divider = fences[1].rect[1],
        bottom = fences.at(-1)!.rect[1],
        frame = [family.rect[0], bottom, family.rect[2], top]
      if (h.rect[3] >= top || h.rect[1] <= divider) continue
      const captions = before.filter(
        ({ item, rect }) =>
          /^(?:TABLE|Table)\s+(?:[IVXLCDM]+|[1-9]\d{0,3})$/u.test(item.str.trim()) &&
          rect[1] > top &&
          rect[1] - top < em * 4 &&
          Math.abs((rect[0] + rect[2] - frame[0] - frame[2]) / 2) < em
      )
      const selected = before.filter(({ rect }) => overlaps(rect, frame)),
        headerBand = selected.filter(({ rect }) => rect[1] > divider)
      if (
        captions.length !== 1 ||
        headerBand.length !== 1 ||
        headerBand[0] !== h ||
        selected.some(({ rect }) => !inside(rect, frame)) ||
        fences
          .slice(1, -1)
          .some(({ rect }) =>
            selected.some((entry) => entry.rect[1] < rect[1] && entry.rect[3] > rect[1])
          )
      )
        continue
      const body = selected.filter((entry) => entry !== h),
        labels = body.filter(
          ({ item }) =>
            /^[A-Za-z][A-Za-z -]{3,}$/u.test(item.str.trim()) &&
            Math.abs(item.height - em) < em * 0.03
        ),
        left = Math.min(...labels.map(({ rect }) => rect[0])),
        rows = labels.filter(({ rect }) => Math.abs(rect[0] - left) < em * 0.1)
      if (
        new Set(rows.map(({ item }) => Math.round(item.transform[5] * 100) / 100)).size < 6 ||
        rows.some(
          ({ item, rect }) =>
            !body.some(
              (other) =>
                other.rect[0] > rect[2] + em * 0.5 &&
                Math.abs(other.item.transform[5] - item.transform[5]) < em * 0.3
            )
        ) ||
        !body.some(({ item }) => /[=βλγω×−]/u.test(item.str)) ||
        !body.some(({ item }) => /\b(?:W|V|Hz|GHz|km|nm|dB|GBd)\b/u.test(item.str))
      )
        continue
      const after = native(target)
      if (!after) return false
      const targetBody = after.filter(({ rect }) => overlaps(rect, frame))
      if (targetBody.length !== selected.length) return false
      const used = new Set<Native>()
      for (const source of selected) {
        const matches = targetBody.filter(
          (entry) =>
            !used.has(entry) &&
            entry.item.str === source.item.str &&
            same(entry.item.width, source.item.width) &&
            same(entry.item.height, source.item.height) &&
            entry.item.transform.every((value, i) => same(value, source.item.transform[i])) &&
            JSON.stringify(target.styles[entry.item.fontName]) ===
              JSON.stringify(original.styles[source.item.fontName])
        )
        if (matches.length !== 1) return false
        used.add(matches[0])
      }
      const targetBars = await nativeHorizontalBars(targetPage)
      if (
        !fences.every((bar) =>
          targetBars.some(
            (other) =>
              other.segment &&
              same(other.width, bar.width) &&
              other.rect.every((v, i) => same(v, bar.rect[i]))
          )
        )
      )
        return false
    }
  }
  return true
}

// A retained native fraction has two text tiers; concatenating PDF.js items loses
// its dividing rule. Reconstruct its reading only after proving the original
// glyph geometry and the rule survive together in the generated document.
async function verifiedFractionText(
  originalPage: PDFPageProxy,
  targetPage: PDFPageProxy,
  original: TextContent,
  target: TextContent
): Promise<Map<number, { label: string; indices: number[] }>> {
  const glyphs = (content: TextContent): Array<TextItem & { index: number }> =>
    content.items.flatMap((item, index) =>
      'str' in item &&
      item.str.trim() &&
      Math.abs(item.transform[1]) < 0.001 &&
      Math.abs(item.transform[2]) < 0.001 &&
      item.transform[0] > 0 &&
      item.transform[3] > 0
        ? [{ ...item, index }]
        : []
    )
  const before = glyphs(original),
    after = glyphs(target)
  const fractionItems = before.map((item) => ({
    i: item.index,
    text: item.str,
    fontSize: item.transform[3],
    baseline: item.transform[5],
    bounds: [
      item.transform[4],
      item.transform[5] - item.transform[3] * 0.3,
      item.transform[4] + item.width,
      item.transform[5] + item.transform[3] * 0.8
    ] as [number, number, number, number]
  }))
  const fractions: ReturnType<typeof resolveInlineFractions> = []
  const baselines = new Set<string>()
  for (const item of before) {
    if (!/[A-Za-z\p{Script=Han}]{2}/u.test(item.str)) continue
    const key = `${item.transform[5]}:${item.transform[3]}`
    if (baselines.has(key)) continue
    baselines.add(key)
    for (const fraction of resolveInlineFractions(
      fractionItems,
      item.transform[5],
      item.transform[3]
    ))
      if (!fractions.some((other) => other.numerator === fraction.numerator))
        fractions.push(fraction)
  }
  const result = new Map<number, { label: string; indices: number[] }>()
  if (!fractions.length) return result
  const [originalBars, targetBars] = await Promise.all([
    nativeHorizontalBars(originalPage),
    nativeHorizontalBars(targetPage)
  ])
  const same = (a: number, b: number): boolean => Math.abs(a - b) < 0.02
  const used = new Set<number>()
  for (const fraction of fractions) {
    const members = fraction.indices.map((index) => before.find((item) => item.index === index)!)
    const numerator = members.find((item) => item.index === fraction.numerator)!,
      denominator = members.filter((item) => fraction.denominator.includes(item.index))
    const rule = originalBars.filter(
      ({ rect, width }) =>
        width > 0 &&
        width <= 1 &&
        Math.abs(rect[0] - fraction.bounds[0]) < 1.5 &&
        Math.abs(rect[2] - fraction.bounds[2]) < 1.5 &&
        rect[1] > Math.max(...denominator.map((item) => item.transform[5])) &&
        rect[3] < numerator.transform[5]
    )
    if (rule.length !== 1) continue
    for (const candidate of after) {
      if (candidate.str !== numerator.str || used.has(candidate.index)) continue
      const dx = candidate.transform[4] - numerator.transform[4],
        dy = candidate.transform[5] - numerator.transform[5]
      const found = members.map((member) =>
        after.filter(
          (item) =>
            !used.has(item.index) &&
            item.str === member.str &&
            same(item.width, member.width) &&
            item.transform
              .slice(0, 4)
              .every((value, index) => same(value, member.transform[index])) &&
            same(item.transform[4], member.transform[4] + dx) &&
            same(item.transform[5], member.transform[5] + dy)
        )
      )
      if (found.some((matches) => matches.length !== 1)) continue
      if (
        !targetBars.some(
          (bar) =>
            same(bar.width, rule[0].width) &&
            bar.rect.every((value, index) =>
              same(value, rule[0].rect[index] + (index % 2 === 0 ? dx : dy))
            )
        )
      )
        continue
      const indices = found.map(([item]) => item.index)
      for (const index of indices) used.add(index)
      result.set(Math.min(...indices), { label: fraction.label, indices })
    }
  }
  return result
}

// PDF.js emits some native circumflexes and macrons before their base. Canonicalize only
// complete unchanged glyph pairs, proved in both PDFs with the same relative
// geometry and occurrence count; never reorder arbitrary combining characters.
function verifiedAccentText(
  original: TextContent,
  target: TextContent,
  regions: {
    sourceIndices: Set<number>
    targetIndices: Set<number>
    source: string
    expected: string
    unitIndex: number
  }[],
  unverifiedLeadingAccent: Set<number>
): Map<number, { label: string; indices: number[] }> {
  const pairs = (
    content: TextContent
  ): Array<{ mark: TextItem & { index: number }; base: TextItem & { index: number } }> => {
    const items = content.items.flatMap((item, index) =>
      'str' in item &&
      item.str.trim() &&
      item.transform[0] > 0 &&
      item.transform[3] > 0 &&
      Math.abs(item.transform[1]) < 0.001 &&
      Math.abs(item.transform[2]) < 0.001
        ? [{ ...item, index }]
        : []
    )
    return items
      .filter(
        (item) =>
          (item.str.trim() === '\u0302' && Math.abs(item.width) < 0.02) ||
          (/^[ˆ¯˜˙]$/u.test(item.str.trim()) && item.width > 0 && item.width < item.transform[3])
      )
      .map((item) => ({ ...item, str: item.str.trim() }))
      .flatMap((mark) => {
        const bases = items.filter(
          (base) =>
            /^[A-Za-z\p{Script=Greek}]/u.test(base.str) &&
            (mark.str !== '˙' ||
              (/^\p{Script=Greek}$/u.test(base.str) &&
                base.index === mark.index + 1 &&
                Math.abs(mark.transform[5] - base.transform[5]) < 0.02 &&
                mark.transform[4] >= base.transform[4] &&
                mark.transform[4] + mark.width <= base.transform[4] + base.width &&
                mark.fontName !== base.fontName &&
                mark.width < mark.transform[3] * 0.35)) &&
            (Math.abs(base.transform[4] - mark.transform[4]) < mark.transform[3] * 0.25 ||
              // Zero-advance math accents can start inside the letter's footprint.
              (mark.width === 0 &&
                mark.str === '\u0302' &&
                base.str.length === 1 &&
                base.width > 0 &&
                mark.transform[4] >= base.transform[4] + base.width * 0.2 &&
                mark.transform[4] <= base.transform[4] + base.width * 0.8 &&
                mark.transform[5] - base.transform[5] > mark.transform[3] * 0.15) ||
              // A wide native letter can start well left of its centered hat.
              // Require the complete single-letter footprint, then prove the
              // unchanged inset and dimensions in both PDFs below.
              (/^[A-Za-z\p{Script=Greek}]$/u.test(base.str) &&
                /^[ˆ¯˜˙]$/u.test(mark.str) &&
                mark.width <= base.width &&
                mark.transform[4] + mark.width / 2 >= base.transform[4] &&
                mark.transform[4] + mark.width / 2 <= base.transform[4] + base.width)) &&
            mark.transform[5] - base.transform[5] > -mark.transform[3] * 0.1 &&
            mark.transform[5] - base.transform[5] < mark.transform[3] * 0.35 &&
            Math.abs(base.transform[3] - mark.transform[3]) < 0.02
        )
        return bases.length === 1 ? [{ mark, base: bases[0] }] : []
      })
  }
  const before = pairs(original),
    after = pairs(target),
    result = new Map<number, { label: string; indices: number[] }>(),
    used = new Set<number>()
  type Pair = (typeof before)[number]
  const owner = (pair: Pair, indices: 'sourceIndices' | 'targetIndices'): number | undefined => {
    const owners = regions.flatMap((region, index) =>
      [pair.mark.index, pair.base.index].every((item) => region[indices].has(item)) ? [index] : []
    )
    return owners.length === 1 ? owners[0] : undefined
  }
  const same = (a: Pair, b: Pair): boolean =>
    [
      [a.mark, b.mark],
      [a.base, b.base]
    ].every(
      ([left, right]) =>
        left.str === right.str &&
        Math.abs(left.width - right.width) < 0.02 &&
        left.transform.slice(0, 4).every((value, i) => Math.abs(value - right.transform[i]) < 0.02)
    ) &&
    [4, 5].every(
      (axis) =>
        Math.abs(
          a.base.transform[axis] -
            a.mark.transform[axis] -
            b.base.transform[axis] +
            b.mark.transform[axis]
        ) < 0.02
    )
  for (const pair of before) {
    if (used.has(pair.mark.index)) continue
    const region = owner(pair, 'sourceIndices')
    if (region === undefined) continue
    const originals = before.filter(
        (other) => owner(other, 'sourceIndices') === region && same(pair, other)
      ),
      matches = after.filter(
        (other) => owner(other, 'targetIndices') === region && same(pair, other)
      )
    originals.forEach((other) => used.add(other.mark.index))
    const ownerRegion = regions[region],
      letter = String.fromCodePoint(pair.base.str.codePointAt(0)!),
      leading = pair.mark.str + letter,
      trailing = letter + pair.mark.str,
      // Preserve a leading spacing accent that remained adjacent to its
      // exact native base. Raw extraction order alone cannot prove its location.
      leadingAccent =
        /^[˜ˆ]$/u.test(pair.mark.str) &&
        pair.base.str === letter &&
        originals.length === 1 &&
        pair.mark.index + 1 === pair.base.index &&
        [ownerRegion.source, ownerRegion.expected].every((text) => {
          const value = textKey(text)
          return value.split(leading).length === 2 && !value.includes(trailing)
        }),
      provedLeadingAccent =
        leadingAccent && matches.length === 1 && matches[0].mark.index + 1 === matches[0].base.index
    if (leadingAccent && !provedLeadingAccent) unverifiedLeadingAccent.add(ownerRegion.unitIndex)
    if (originals.length !== matches.length) continue
    if (
      pair.mark.str === '˙' &&
      ![ownerRegion.source, ownerRegion.expected].every((text) => {
        const value = textKey(text)
        return value.includes(textKey(trailing)) && !value.includes(textKey(leading))
      })
    )
      continue
    // The broader inset still requires one owned packet with unchanged fonts
    // and the same trailing circumflex in the accepted translation.
    if (
      pair.mark.str === '\u0302' &&
      Math.abs(pair.base.transform[4] - pair.mark.transform[4]) >= pair.mark.transform[3] * 0.25 &&
      (originals.length !== 1 ||
        ![pair.mark, pair.base].every((item, index) => {
          const other = index === 0 ? matches[0].mark : matches[0].base
          const before = original.styles?.[item.fontName]
          return (
            before && JSON.stringify(before) === JSON.stringify(target.styles?.[other.fontName])
          )
        }) ||
        ![ownerRegion.source, ownerRegion.expected].every(
          (text) => textKey(text).split(trailing.normalize('NFC')).length === 2
        ))
    )
      continue
    const fusedTilde = pair.base.str + pair.mark.str
    // The source can place a raised tilde after a fused Greek equality. Match
    // that spelling only on the same unique native pair in both PDFs.
    const provesFusedTilde = (value: Pair): boolean =>
      value.mark.index + 1 === value.base.index &&
      value.mark.fontName === value.base.fontName &&
      value.mark.transform[5] - value.base.transform[5] > value.mark.transform[3] * 0.15
    const provedFusedTilde =
      pair.mark.str === '˜' &&
      /^\p{Script=Greek}\s*=$/u.test(pair.base.str) &&
      originals.length === 1 &&
      matches.length === 1 &&
      provesFusedTilde(pair) &&
      provesFusedTilde(matches[0]) &&
      original.styles?.[pair.mark.fontName] &&
      JSON.stringify(original.styles[pair.mark.fontName]) ===
        JSON.stringify(target.styles?.[matches[0].mark.fontName]) &&
      [ownerRegion.source, ownerRegion.expected].every(
        (text) => textKey(text).split(textKey(fusedTilde)).length === 2
      )
    for (const { mark, base } of matches) {
      const indices = [mark.index, base.index]
      const label = provedLeadingAccent
        ? leading
        : provedFusedTilde
          ? fusedTilde
          : trailing + base.str.slice(letter.length)
      result.set(Math.min(...indices), { label: label.normalize('NFC'), indices })
    }
  }
  return result
}

// Saving can split one untouched PDF.js run into several text objects. Text
// concatenation alone cannot prove its inner glyph positions: require identical
// rendered ink as well as the complete text, outer bounds and font matrix.
async function verifiedSplitNativeRun(
  before: TextItem,
  target: TextContent,
  originalPage: PDFPageProxy,
  targetPage: PDFPageProxy,
  sourceStyle?: TextContent['styles'][string]
): Promise<number[] | undefined> {
  if (
    ![before.width, ...before.transform].every(Number.isFinite) ||
    before.transform[0] <= 0 ||
    before.transform[3] <= 0 ||
    before.transform[1] !== 0 ||
    before.transform[2] !== 0 ||
    !before.str.trim() ||
    before.width <= 0 ||
    typeof originalPage.render !== 'function' ||
    typeof targetPage.render !== 'function'
  )
    return undefined
  const left = before.transform[4],
    right = left + before.width
  const collect = (displaced: boolean): { item: TextItem; index: number }[] =>
    target.items
      .flatMap((item, index) =>
        'str' in item &&
        item.str.trim() &&
        (!displaced ||
          (before.str.includes(item.str) &&
            item.width > 0 &&
            target.styles[item.fontName]?.fontFamily === sourceStyle!.fontFamily &&
            target.styles[item.fontName]?.vertical === false &&
            Math.abs(target.styles[item.fontName].ascent - sourceStyle!.ascent) < 0.001 &&
            Math.abs(target.styles[item.fontName].descent - sourceStyle!.descent) < 0.001)) &&
        item.transform[4] >= left - 0.001 &&
        item.transform[4] + item.width <= right + 0.001 &&
        item.transform.every(
          (value, i) =>
            i === 4 ||
            (i === 5 && displaced
              ? Math.abs(value - before.transform[i]) < before.height * 0.3
              : Math.abs(value - before.transform[i]) < 0.001)
        )
          ? [{ item, index }]
          : []
      )
      .sort((a, b) => a.item.transform[4] - b.item.transform[4])
  const closed = (pieces: ReturnType<typeof collect>, displaced: boolean): boolean =>
    pieces.length >= 2 &&
    textKey(pieces.map(({ item }) => item.str).join('')) === textKey(before.str) &&
    Math.abs(pieces[0].item.transform[4] - left) < 0.001 &&
    Math.abs(pieces.at(-1)!.item.transform[4] + pieces.at(-1)!.item.width - right) < 0.001 &&
    (displaced
      ? Math.abs(pieces[0].item.transform[5] - before.transform[5]) < 0.001 &&
        pieces.every(
          ({ item }, index) =>
            index === 0 || item.transform[4] > pieces[index - 1].item.transform[4]
        )
      : pieces.every(
          ({ item }, index) =>
            index === 0 ||
            item.transform[4] >=
              pieces[index - 1].item.transform[4] + pieces[index - 1].item.width - 0.001
        ))
  let repeatedSymbol = false,
    pieces = collect(false)
  // A retained text run can expose its final advance as an adjacent space item.
  if (pieces.length === 1) {
    const [lead] = pieces,
      space = target.items[lead.index + 1]
    if (
      space &&
      'str' in space &&
      space.str === ' ' &&
      before.str === lead.item.str + space.str &&
      space.fontName === lead.item.fontName &&
      space.height === 0 &&
      space.width > 0 &&
      Math.abs(space.transform[4] - lead.item.transform[4] - lead.item.width) < 0.001 &&
      space.transform.every(
        (value, index) => index === 4 || Math.abs(value - before.transform[index]) < 0.001
      )
    )
      pieces.push({ item: space, index: lead.index + 1 })
  }
  if (!closed(pieces, false)) {
    // Untouched diagram symbols may split with overlapping advances and native baseline offsets.
    repeatedSymbol = /^([^\p{L}\p{N}\s])\1{1,7}$/u.test(before.str)
    if (
      !repeatedSymbol ||
      !Number.isFinite(before.height) ||
      before.height <= 0 ||
      !sourceStyle ||
      sourceStyle.vertical ||
      !Number.isFinite(sourceStyle.ascent) ||
      !Number.isFinite(sourceStyle.descent) ||
      sourceStyle.ascent <= 0 ||
      sourceStyle.ascent > 1.5 ||
      sourceStyle.descent > 0 ||
      sourceStyle.descent < -1
    )
      return undefined
    pieces = collect(true)
    if (!closed(pieces, true)) return undefined
  }
  // The original font envelope includes this run's ink without borrowing the
  // neighboring row, whose prose may have been legitimately translated.
  const fontBounds =
    sourceStyle &&
    !sourceStyle.vertical &&
    Number.isFinite(sourceStyle.ascent) &&
    Number.isFinite(sourceStyle.descent) &&
    sourceStyle.ascent > 0 &&
    sourceStyle.ascent <= 1.5 &&
    sourceStyle.descent <= 0 &&
    sourceStyle.descent >= -1
      ? [sourceStyle.descent, sourceStyle.ascent]
      : [-1, 1]
  const pixels = async (page: PDFPageProxy): Promise<Uint8ClampedArray | undefined> => {
    const viewport = page.getViewport({ scale: 4 }),
      corners = [
        viewport.convertToViewportPoint(
          left,
          (repeatedSymbol
            ? Math.min(before.transform[5], ...pieces.map(({ item }) => item.transform[5]))
            : before.transform[5]) +
            before.transform[3] * fontBounds[0]
        ),
        viewport.convertToViewportPoint(
          right,
          (repeatedSymbol
            ? Math.max(before.transform[5], ...pieces.map(({ item }) => item.transform[5]))
            : before.transform[5]) +
            before.transform[3] * fontBounds[1]
        )
      ],
      x = Math.floor(Math.min(...corners.map(([x]) => x))) - 1,
      y = Math.floor(Math.min(...corners.map(([, y]) => y))) - 1,
      width = Math.ceil(Math.max(...corners.map(([x]) => x))) + 1 - x,
      height = Math.ceil(Math.max(...corners.map(([, y]) => y))) + 1 - y
    if (width <= 0 || height <= 0 || width * height > 262144) return undefined
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    try {
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) return undefined
      await page.render({
        canvas,
        canvasContext: context,
        viewport,
        transform: [1, 0, 0, 1, -x, -y]
      }).promise
      return context.getImageData(0, 0, width, height).data
    } finally {
      canvas.width = 0
      canvas.height = 0
    }
  }
  const [original, after] = await Promise.all([pixels(originalPage), pixels(targetPage)])
  return original &&
    after &&
    original.length === after.length &&
    original.some(
      (value, index) =>
        index % 4 === 3 &&
        value > 0 &&
        original[index - 3] + original[index - 2] + original[index - 1] < 765
    ) &&
    original.every((value, index) => value === after[index])
    ? pieces.map(({ index }) => index)
    : undefined
}

// A merged source row can expose a preserved native prefix independently.
export type VerifiedPdfTranslationRegions = Readonly<{
  regionText: string[][]
  rawRegionText: string[][]
  originalRegionText: string[][]
  annotations: AnnotationSnapshot[][]
}>

export type PdfTranslationRenderUnit = Readonly<{
  source: string
  fragments: PdfTranslationResults['source']['units'][number]['fragments']
  translation: string
}>

type VerificationInput = Readonly<{
  original: PDFDocumentProxy
  translated: PDFDocumentProxy
  data: Uint8Array
  runResults: PdfTranslationResults
  units: PdfTranslationResults['source']['units']
  renderUnits: readonly PdfTranslationRenderUnit[]
  previousValidation: VerifiedPdfTranslationRegions | undefined
  dirtyPages: ReadonlySet<number>
  originalPages: ReadonlyMap<number, unknown>
  originalLinkOwners: ReadonlyMap<number, ReadonlyMap<number, string>>
  preservedIds: ReadonlySet<string>
  acceptedById: ReadonlyMap<string, PdfTranslationResults['units'][number]>
  useArtifact: boolean
}>

type VerifiedPdfTranslation = Readonly<{
  pages: Geometry[]
  originalUnitCount: number
  retainedUnitIds: string[]
  validation: VerifiedPdfTranslationRegions
}>

export type PdfTranslationVerificationLocation = {
  reason?: 'moved-link' | 'unit-placement' | 'literal-example' | 'overlapping-owner'
  details?: string
  pageNumber?: number
  unitId?: string
  failedLinks?: ReadonlyMap<number, string>
}

type Verification = Readonly<{
  location: PdfTranslationVerificationLocation
  reject: (details: string) => Error
  validate: (input: VerificationInput) => Promise<VerifiedPdfTranslation | undefined>
  dispose: () => Promise<void>
}>

// Per-generation acceptance of native content, placement and linked objects.
// The caller controls the lifetime of both PDF.js documents and the rendered preview.
export function createPdfTranslationVerification(signal: AbortSignal): Verification {
  const location: PdfTranslationVerificationLocation = {}
  let targetExclusions: ReturnType<typeof createPdfTranslationTargetExclusions> | undefined
  const heldNativePages = new Set<PDFPageProxy>()
  const nativeExclusionChecks: (() => boolean)[] = []

  const closeTargetExclusions = async (): Promise<void> => {
    try {
      await targetExclusions?.dispose()
    } finally {
      for (const page of heldNativePages) page.cleanup()
      heldNativePages.clear()
    }
  }
  const reject = (details: string): Error => {
    location.details = details
    location.unitId = undefined
    return new Error(details)
  }

  return {
    location,
    reject,
    dispose: closeTargetExclusions,
    async validate({
      original,
      translated,
      data,
      runResults,
      units,
      renderUnits,
      previousValidation,
      dirtyPages,
      originalPages,
      originalLinkOwners,
      preservedIds,
      acceptedById,
      useArtifact
    }): Promise<VerifiedPdfTranslation | undefined> {
      const validationError = (
        message: string,
        unitIndex?: number,
        fragmentIndex?: number,
        reason?: PdfTranslationVerificationLocation['reason']
      ): Error => {
        const unit = unitIndex === undefined ? undefined : units[unitIndex]
        location.details = message
        location.reason = reason
        location.unitId = unit?.id
        if (unit && fragmentIndex !== undefined)
          location.pageNumber = unit.fragments[fragmentIndex]?.pageNumber ?? location.pageNumber
        return new Error(message)
      }
      if (translated.numPages !== original.numPages) throw validationError('PDF page count changed')
      targetExclusions = createPdfTranslationTargetExclusions({
        source: runResults.source,
        document: translated,
        data,
        nativeDocumentFactory: pdfjsLib.getDocument,
        signal
      })
      const pages: Geometry[] = []
      const cached = previousValidation
      const regionText = units.map((unit, i) =>
        unit.fragments.map((_, f) => cached?.regionText[i][f] ?? '')
      )
      const rawRegionText = units.map((unit, i) =>
        unit.fragments.map((_, f) => cached?.rawRegionText[i][f] ?? '')
      )
      const originalRegionText = units.map((unit, i) =>
        unit.fragments.map((_, f) => cached?.originalRegionText[i][f] ?? '')
      )
      const annotations: AnnotationSnapshot[][] = []
      const unverifiedLeadingAccent = new Set<number>()
      for (let number = 1; number <= original.numPages; number++) {
        location.pageNumber = number
        location.failedLinks = undefined
        if (signal.aborted) return
        const [sourcePage, translatedPage]: [PDFPageProxy, PDFPageProxy] = await Promise.all([
          original.getPage(number),
          translated.getPage(number)
        ])
        if (signal.aborted) return
        try {
          const source = sourcePage.getViewport({ scale: 1 }),
            target = translatedPage.getViewport({ scale: 1 })
          if (
            ![source.width, source.height, target.width, target.height].every(
              (value) => Number.isFinite(value) && value > 0
            ) ||
            Math.abs(source.width - target.width) > 0.001 ||
            Math.abs(source.height - target.height) > 0.001 ||
            source.rotation !== target.rotation
          )
            throw validationError('PDF page geometry changed')
          if (cached && !dirtyPages.has(number)) {
            // The worker reuses these page dictionaries/resources without editing
            // them. Check geometry and every link against the verified snapshot;
            // avoid extracting/rendering their unchanged text again.
            const current = await annotationKey(translated, translatedPage)
            const previous = cached.annotations[number - 1]
            if (
              current.length !== previous.length ||
              current.some((annotation, i) => {
                const before = previous[i]
                return (
                  annotation.key !== before.key ||
                  annotation.uri !== before.uri ||
                  !sameCoordinates(annotation.rect, before.rect) ||
                  !sameCoordinates(annotation.quadPoints, before.quadPoints) ||
                  !sameCoordinates(annotation.destinationCoordinates, before.destinationCoordinates)
                )
              })
            )
              throw validationError('Reused PDF annotations changed')
            annotations.push(current)
            pages.push({ width: source.width, height: source.height, rotation: source.rotation })
            continue
          }
          const [sourceAnnotations, targetAnnotations] = await Promise.all([
            annotationKey(original, sourcePage, true),
            annotationKey(translated, translatedPage, originalPages.has(number))
          ])
          annotations.push(targetAnnotations)
          const text: TextContent = await getPdfTranslationTextContent(translatedPage)
          let originalText: TextContent | undefined = await getPdfTranslationTextContent(sourcePage)
          const hidden = await targetExclusions.read({
            pageNumber: number,
            sourceContent: originalText,
            targetPage: translatedPage,
            targetContent: text,
            targetViewport: target
          })
          if (hidden) {
            heldNativePages.add(translatedPage)
            nativeExclusionChecks.push(hidden.current)
          }
          if (!(await nativeParameterBodyUnchanged(sourcePage, translatedPage, originalText, text)))
            throw validationError('Native mathematical parameter table changed')
          if (
            !(await sameNativeMatrixBody(original, translated, number, {
              nativeDocumentFactory: pdfjsLib.getDocument,
              signal
            }))
          )
            throw validationError('Retained neighboring PDF glyph changed')
          if (
            !(await sameNativeFunctionDisplay(original, translated, number, {
              nativeDocumentFactory: pdfjsLib.getDocument,
              signal
            }))
          )
            throw validationError('Retained neighboring PDF glyph changed')
          const unchanged = (index: number): boolean =>
            units[index].source === renderUnits[index].translation
          const { pageLatinAccentText, pendingRetentions } = await verifyPdfTranslationLinks({
            number,
            sourcePage,
            translatedPage,
            source,
            target,
            originalText,
            text,
            hidden,
            sourceAnnotations,
            targetAnnotations,
            documentSource: runResults.source,
            units,
            renderUnits,
            canRetainLinks:
              !useArtifact && !originalPages.has(number) && !originalLinkOwners.has(number),
            originalLinkOwners,
            preservedIds,
            acceptedById,
            unchanged,
            validationError
          })
          if (pendingRetentions.size) {
            location.failedLinks = pendingRetentions
            throw validationError(
              'PDF moved link could not be verified',
              undefined,
              undefined,
              'moved-link'
            )
          }
          // Reuse page coordinates across regions; keep only the current page in memory.
          const projectText = (
            content: typeof text,
            viewport: typeof target
          ): { index: number; str: string; points: number[][] }[] =>
            content.items.flatMap((item, index) => {
              if (!('str' in item) || !item.str.trim()) return []
              const [a, b, , , x, y] = item.transform,
                length = Math.hypot(a, b)
              if (!Number.isFinite(length) || length <= 0)
                throw validationError('Invalid PDF text geometry')
              return [
                {
                  index,
                  str: item.str,
                  points: [
                    viewport.convertToViewportPoint(x, y),
                    viewport.convertToViewportPoint(
                      x + (a / length) * item.width,
                      y + (b / length) * item.width
                    )
                  ]
                }
              ]
            })
          const nativeLabels = new Map<number, { label: string; indices: number[] }>()
          for (const [item, label] of pageLatinAccentText) {
            const index = text.items.indexOf(item)
            if (index >= 0) nativeLabels.set(index, { label, indices: [index] })
          }
          if (
            units.some(
              (unit) =>
                /[A-Za-z\p{Script=Greek}\d⁰¹²³⁴⁵⁶⁷⁸⁹]\//u.test(unit.source) &&
                unit.fragments.some((fragment) => fragment.pageNumber === number)
            )
          ) {
            originalText ??= await getPdfTranslationTextContent(sourcePage)
            for (const [index, value] of await verifiedFractionText(
              sourcePage,
              translatedPage,
              originalText,
              text
            ))
              nativeLabels.set(index, value)
          }
          if (
            units.some(
              (unit) =>
                /[\u0302ˆ¯˜˙]/u.test(unit.source) &&
                unit.fragments.some((fragment) => fragment.pageNumber === number)
            )
          ) {
            originalText ??= await getPdfTranslationTextContent(sourcePage)
            const projected = projectText(text, target),
              regions = units.flatMap((unit, index) =>
                unit.fragments
                  .filter((fragment) => fragment.pageNumber === number)
                  .map((fragment) => ({
                    source: unit.source,
                    expected: renderUnits[index].translation,
                    unitIndex: index,
                    sourceIndices: new Set(
                      fragment.items
                        .filter((claimed) => {
                          const item = originalText!.items[claimed.index]
                          return (
                            item && 'str' in item && textKey(item.str) === textKey(claimed.text)
                          )
                        })
                        .map((item) => item.index)
                    ),
                    targetIndices: new Set(
                      projected
                        .filter((item) =>
                          item.points.every(
                            ([x, y]) =>
                              x >= fragment.rect.x * target.width - 1 &&
                              x <= (fragment.rect.x + fragment.rect.width) * target.width + 1 &&
                              y >= fragment.rect.y * target.height - 1 &&
                              y <= (fragment.rect.y + fragment.rect.height) * target.height + 1
                          )
                        )
                        .map((item) => item.index)
                    )
                  }))
              )
            for (const [index, value] of verifiedAccentText(
              originalText,
              text,
              regions,
              unverifiedLeadingAccent
            ))
              nativeLabels.set(index, value)
          }
          // Power spellings belong to a paragraph, not every matching variable
          // on the page. Another paragraph may intentionally use plain digits.
          for (const [unitIndex, unit] of units.entries()) {
            const fragments = unit.fragments.filter((fragment) => fragment.pageNumber === number)
            const powers = new Set(
              [
                ...renderUnits[unitIndex].translation.matchAll(
                  /(?:[A-Za-z\p{Script=Greek}]\d{0,3}|(?<!\d)10)[⁰¹²³⁴⁵⁶⁷⁸⁹]{1,2}/gu
                )
              ]
                .map(([label]) => label)
                .filter((label) => unit.source.normalize('NFKC').includes(label.normalize('NFKC')))
            )
            const powersByCaret = new Map<string, string>()
            const translation = renderUnits[unitIndex].translation
            for (const [power] of translation.matchAll(
              /(?<=[∼≈]\s)10⁻[⁰¹²³⁴⁵⁶⁷⁸⁹]{1,2}[a-z](?![\p{L}\p{N}_])/gu
            )) {
              if (unit.source.split(power).length === 2 && translation.split(power).length === 2)
                powers.add(power)
            }
            for (const [spelling, exponent] of unit.source.matchAll(
              /(?<![\p{L}\p{N}])M⋆ = \d{1,3} × 10([⁰¹²³⁴⁵⁶⁷⁸⁹]{1,2})M⊙(?![\p{L}\p{N}])/gu
            )) {
              const nativePower = '10' + exponent,
                caret = '^' + exponent.normalize('NFKC'),
                equivalent = spelling.replace(exponent, caret)
              if (
                unit.source.split(nativePower).length === 2 &&
                translation.split(equivalent).length === 2 &&
                !translation.includes(nativePower)
              ) {
                powers.add(nativePower)
                powersByCaret.set(nativePower, caret)
              }
            }
            const authorLabels = [
              ...unit.source.matchAll(/\b(?:MM|MD|PhD|MSc|BSc)(\d{1,2}[*†‡]?)/gu)
            ].map((match) => match[1])
            const raisedLabels = [
              ...renderUnits[unitIndex].translation.matchAll(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+[*†‡]?/gu)
            ].map((match) => match[0])
            const authorFootnotes =
              authorLabels.length >= 2 &&
              authorLabels.length === raisedLabels.length &&
              authorLabels.every((label, index) => label === raisedLabels[index].normalize('NFKC'))
            if (!fragments.length || (!powers.size && !authorFootnotes)) continue
            originalText ??= await getPdfTranslationTextContent(sourcePage)
            const sourceIndices = new Set(
              fragments.flatMap((fragment) => fragment.items.map((item) => item.index))
            )
            const targetIndices = projectText(text, target)
              .filter((item) =>
                fragments.some(({ rect }) =>
                  item.points.every(
                    ([x, y]) =>
                      x >= rect.x * target.width - 1 &&
                      x <= (rect.x + rect.width) * target.width + 1 &&
                      y >= rect.y * target.height - 1 &&
                      y <= (rect.y + rect.height) * target.height + 1
                  )
                )
              )
              .map((item) => item.index)
            if (authorFootnotes) {
              const before = originalText.items.filter(
                (item, index): item is TextItem => sourceIndices.has(index) && 'str' in item
              )
              const after = targetIndices.map((index) => text.items[index] as TextItem)
              const sourceMarkers = before.filter((item) => /^\d{1,2}[*†‡]?$/u.test(item.str))
              const targetMarkers = after.filter((item) => /^\d{1,2}[*†‡]?$/u.test(item.str))
              if (
                sourceMarkers.length === authorLabels.length &&
                targetMarkers.length === authorLabels.length &&
                sourceMarkers.every((marker, index) =>
                  verifiedNativeFootnote(
                    [marker, ...before.filter((item) => item !== marker)],
                    [
                      targetMarkers[index],
                      ...after.filter((item) => item !== targetMarkers[index])
                    ],
                    raisedLabels[index],
                    true
                  )
                )
              ) {
                for (const [index, marker] of targetMarkers.entries()) {
                  const targetIndex = targetIndices[after.indexOf(marker)]
                  nativeLabels.set(targetIndex, {
                    label: raisedLabels[index],
                    indices: [targetIndex]
                  })
                }
              }
            }
            for (const [index, { power, exponent }] of verifiedPowerText(
              {
                ...originalText,
                items: originalText.items.filter((_, index) => sourceIndices.has(index))
              },
              { ...text, items: targetIndices.map((index) => text.items[index]) },
              powers
            )) {
              const targetIndex = targetIndices[index]
              nativeLabels.set(targetIndex, {
                label: powersByCaret.get(power) ?? exponent,
                indices: [targetIndex]
              })
            }
          }
          for (const [index, unit] of units.entries()) {
            const raised = /^[⁰¹²³⁴⁵⁶⁷⁸⁹]{1,2}(?=\p{L})/u.exec(renderUnits[index].translation)?.[0]
            const fragment = unit.fragments[0]
            if (
              !raised ||
              !fragment ||
              fragment.pageNumber !== number ||
              !unit.source.startsWith(raised.normalize('NFKC'))
            )
              continue
            originalText ??= await getPdfTranslationTextContent(sourcePage)
            const before = fragment.items.flatMap(({ index: itemIndex }) => {
              const item = originalText!.items[itemIndex]
              return item && 'str' in item ? [item] : []
            })
            const candidates = projectText(text, target).filter((item) =>
              item.points.every(
                ([x, y]) =>
                  x >= fragment.rect.x * target.width - 1 &&
                  x <= (fragment.rect.x + fragment.rect.width) * target.width + 1 &&
                  y >= fragment.rect.y * target.height - 1 &&
                  y <= (fragment.rect.y + fragment.rect.height) * target.height + 1
              )
            )
            if (
              verifiedNativeFootnote(
                before,
                candidates.map(({ index }) => text.items[index] as TextItem),
                raised
              )
            )
              nativeLabels.set(candidates[0].index, {
                label: raised,
                indices: [candidates[0].index]
              })
          }
          let rawTargetItems: ReturnType<typeof projectText> | undefined
          if (
            hidden &&
            [...nativeLabels.values()].some((label) =>
              label.indices.some((index) => hidden.target.has(index))
            )
          )
            throw validationError('Target native exclusion overlaps a glyph projection')
          const projectedTarget = (): ReturnType<typeof projectText> => {
            const items = (rawTargetItems ??= projectText(text, target)),
              consumed = new Set([...nativeLabels.values()].flatMap((fraction) => fraction.indices))
            return items.flatMap((item) => {
              const fraction = nativeLabels.get(item.index)
              if (fraction)
                return [
                  {
                    ...item,
                    str: fraction.label,
                    points: items
                      .filter((other) => fraction.indices.includes(other.index))
                      .flatMap((other) => other.points)
                  }
                ]
              return consumed.has(item.index) ? [] : [item]
            })
          }
          let targetItems: ReturnType<typeof projectText> | undefined,
            sourceItems: ReturnType<typeof projectText> | undefined
          const owned = new Map<number, string>()
          const overlapping = new Set<string>()
          const claimedSourceItems = new Set(
            units.flatMap((unit) =>
              unit.fragments
                .filter((fragment) => fragment.pageNumber === number)
                .flatMap((fragment) => fragment.items.map((item) => item.index))
            )
          )
          const sourceOnlyItems = new Set(
            runResults.source.units
              .filter((unit) => unit.sourceOnly)
              .flatMap((unit) =>
                unit.fragments
                  .filter((fragment) => fragment.pageNumber === number)
                  .flatMap((fragment) =>
                    fragment.items
                      .map((item) => item.index)
                      .filter((index) => !claimedSourceItems.has(index))
                  )
              )
          )
          const foreignMatches = new Map<number, number[]>(),
            preservedUnownedGroups = new Map<number, number[]>()
          const retainedForeignItems = (
            fragment: PdfTranslationRenderUnit['fragments'][number],
            unitIndex: number,
            fragmentIndex: number
          ): Set<number> => {
            const excluded = new Set<number>()
            if (!sourceOnlyItems.size || !fragment.items.length || !originalText) return excluded
            sourceItems ??= projectText(originalText, source)
            for (const item of sourceItems) {
              if (
                !sourceOnlyItems.has(item.index) ||
                !item.str.trim() ||
                !item.points.every(
                  ([x, y]) =>
                    x >= fragment.rect.x * source.width - 1 &&
                    x <= (fragment.rect.x + fragment.rect.width) * source.width + 1 &&
                    y >= fragment.rect.y * source.height - 1 &&
                    y <= (fragment.rect.y + fragment.rect.height) * source.height + 1
                )
              )
                continue
              if (unchangedNativePage) {
                excluded.add(item.index)
                continue
              }
              const nativeGroup = preservedUnownedGroups.get(item.index)
              if (nativeGroup) {
                nativeGroup.forEach((index) => excluded.add(index))
                continue
              }
              if (!foreignMatches.has(item.index)) {
                const before = originalText.items[item.index] as TextItem
                const same = (after: TextContent['items'][number]): boolean =>
                  'str' in after &&
                  after.str === before.str &&
                  Math.abs(after.width - before.width) < 0.02 &&
                  after.transform.every((value, n) => Math.abs(value - before.transform[n]) < 0.02)
                if (originalText.items.filter(same).length !== 1)
                  throw validationError('Ambiguous neighboring PDF glyph')
                foreignMatches.set(
                  item.index,
                  text.items.flatMap((after, index) => (same(after) ? [index] : []))
                )
              }
              const matches = foreignMatches.get(item.index)!
              if (matches.length !== 1) {
                // This fragment covers the protected glyph. Retry just its active owner
                // before restoring the page, then verify the same glyph again.
                const overlapsActiveOwner = !unchanged(unitIndex)
                throw validationError(
                  'Retained neighboring PDF glyph changed',
                  overlapsActiveOwner ? unitIndex : undefined,
                  fragmentIndex,
                  overlapsActiveOwner ? 'overlapping-owner' : undefined
                )
              }
              excluded.add(matches[0])
            }
            return excluded
          }
          originalText ??= await getPdfTranslationTextContent(sourcePage)
          const unchangedNativePage =
            units.every(
              (unit, i) =>
                unchanged(i) || !unit.fragments.some((fragment) => fragment.pageNumber === number)
            ) &&
            originalText.items.length === text.items.length &&
            originalText.items.every((before, index) => {
              const after = text.items[index]
              return (
                'str' in before &&
                after &&
                'str' in after &&
                before.str === after.str &&
                before.width === after.width &&
                before.transform.every((value, i) => value === after.transform[i])
              )
            })
          const sourceRegionOwners = new Map<
            number,
            PdfTranslationRenderUnit['fragments'][number]['rect'] | null
          >()
          for (const unit of units)
            for (const fragment of unit.fragments) {
              if (fragment.pageNumber !== number) continue
              for (const claimed of fragment.items) {
                const item = originalText.items[claimed.index]
                if (!item || !('str' in item) || textKey(item.str) !== textKey(claimed.text))
                  continue
                sourceRegionOwners.set(
                  claimed.index,
                  sourceRegionOwners.has(claimed.index) ? null : fragment.rect
                )
              }
            }
          const sameNativePlacement = (
            before: TextItem,
            index: number,
            after: TextItem
          ): boolean => {
            if (
              !(Math.abs(before.width - after.width) < 0.001) ||
              !before.transform.every(
                (value, i) => i === 4 || Math.abs(value - after.transform[i]) < 0.001
              )
            )
              return false
            const advanceDrift = Math.abs(before.transform[4] - after.transform[4])
            if (advanceDrift < 0.001) return true
            const owner = sourceRegionOwners.get(index)
            if (
              !owner ||
              advanceDrift >= 0.01 ||
              after.transform[1] !== 0 ||
              after.transform[2] !== 0
            )
              return false
            // Saving may round a kerning advance. Reuse a source owner only when
            // both native runs stay in the overlap of two fragments of the same paragraph.
            const inside = (rect: typeof owner): boolean =>
              (
                [
                  [before, source],
                  [after, target]
                ] as const
              ).every(([item, viewport]) => {
                const [, , , , x, y] = item.transform
                return [x, x + item.width].every((end) => {
                  const [px, py] = viewport.convertToViewportPoint(end, y)
                  return (
                    px >= rect.x * viewport.width &&
                    px <= (rect.x + rect.width) * viewport.width &&
                    py >= rect.y * viewport.height &&
                    py <= (rect.y + rect.height) * viewport.height
                  )
                })
              })
            return (
              inside(owner) &&
              units.some(
                ({ fragments }) =>
                  fragments.some(({ rect }) => rect === owner) &&
                  fragments.some(
                    ({ pageNumber, rect }) =>
                      pageNumber === number && rect !== owner && inside(rect)
                  )
              )
            )
          }
          // Match exact text and full geometry uniquely in both directions.
          const originalByText = new Map<string, { item: TextItem; index: number }[]>()
          originalText.items.forEach((item, index) => {
            if ('str' in item)
              originalByText.set(item.str, [
                ...(originalByText.get(item.str) ?? []),
                { item, index }
              ])
          })
          const nativeMatches = new Map<number, number[]>(),
            unownedNativeTargets = new Set<number>(),
            preservedTargetOwners = new Map<
              number,
              PdfTranslationRenderUnit['fragments'][number]['rect']
            >()
          text.items.forEach((item, index) => {
            if (!('str' in item)) return
            const matches = (originalByText.get(item.str) ?? []).filter(({ item: before, index }) =>
              sameNativePlacement(before, index, item)
            )
            if (matches.length === 1) {
              const originalIndex = matches[0].index
              nativeMatches.set(originalIndex, [...(nativeMatches.get(originalIndex) ?? []), index])
            }
          })
          for (const [index, targets] of nativeMatches) {
            const region = sourceRegionOwners.get(index)
            if (region && targets.length === 1) preservedTargetOwners.set(targets[0], region)
            else if (
              !sourceRegionOwners.has(index) &&
              sourceOnlyItems.has(index) &&
              targets.length === 1
            )
              unownedNativeTargets.add(targets[0])
          }
          // Some untouched Form glyphs were painted twice in the source. Keep
          // that complete multiset only when every source member is unclaimed,
          // and all target copies retain exactly the same text and geometry.
          for (const entries of originalByText.values())
            for (const { item, index } of entries) {
              if (preservedUnownedGroups.has(index) || !sourceOnlyItems.has(index)) continue
              const same = (after: TextContent['items'][number]): boolean =>
                  'str' in after &&
                  after.str === item.str &&
                  after.width === item.width &&
                  after.transform.every((value, i) => value === item.transform[i]),
                originals = entries.filter(({ item }) => same(item)),
                targets = text.items.flatMap((item, index) => (same(item) ? [index] : []))
              if (
                originals.length < 2 ||
                originals.length !== targets.length ||
                !originals.every(
                  ({ index }) => sourceOnlyItems.has(index) && !sourceRegionOwners.has(index)
                )
              )
                continue
              originals.forEach(({ index }) => preservedUnownedGroups.set(index, targets))
              targets.forEach((index) => unownedNativeTargets.add(index))
            }
          for (const index of sourceOnlyItems) {
            if (
              sourceRegionOwners.has(index) ||
              nativeMatches.has(index) ||
              preservedUnownedGroups.has(index)
            )
              continue
            const before = originalText.items[index]
            if (!before || !('str' in before)) continue
            const originals = (originalByText.get(before.str) ?? []).filter(({ item }) =>
              [item.width, ...item.transform].every(
                (value, i) => Math.abs(value - [before.width, ...before.transform][i]) < 0.001
              )
            )
            if (originals.length !== 1) continue
            const targets = await verifiedSplitNativeRun(
              before,
              text,
              sourcePage,
              translatedPage,
              originalText.styles?.[before.fontName]
            )
            if (
              !targets ||
              targets.some(
                (index) => preservedTargetOwners.has(index) || unownedNativeTargets.has(index)
              )
            )
              continue
            preservedUnownedGroups.set(index, targets)
            targets.forEach((index) => unownedNativeTargets.add(index))
          }
          // Reflowed scientific scripts may change font advances and horizontal
          // position while preserving their text and raised baseline, with at most 2% ink fitting.
          // Assign only unique source/target matches to the verified source owner.
          const scriptIdentity = (item: TextContent['items'][number]): string | undefined =>
            'str' in item &&
            item.transform[0] > 0 &&
            item.transform[3] > 0 &&
            item.transform[1] === 0 &&
            item.transform[2] === 0 &&
            /^[A-Za-z\p{Script=Greek}\d()[\]+−-]{1,12}$/u.test(item.str)
              ? JSON.stringify(
                  [item.str, item.transform[5]].map((value) =>
                    typeof value === 'number' ? Math.round(value * 1000) : value
                  )
                )
              : undefined
          const sourceScripts = new Map<string, number[]>()
          for (const [index, region] of sourceRegionOwners) {
            const item = originalText.items[index]
            if (!region || !item || !('str' in item)) continue
            const identity = scriptIdentity(item)
            if (!identity) continue
            const size = Math.hypot(item.transform[0], item.transform[1])
            const base = [...sourceRegionOwners].some(([other, owner]) => {
              const candidate = originalText!.items[other]
              if (owner !== region || !candidate || !('str' in candidate)) return false
              const bodySize = Math.hypot(candidate.transform[0], candidate.transform[1]),
                rise = Math.abs(item.transform[5] - candidate.transform[5])
              return size <= bodySize * 0.85 && rise >= bodySize * 0.1 && rise <= bodySize
            })
            if (base) sourceScripts.set(identity, [...(sourceScripts.get(identity) ?? []), index])
          }
          const targetScripts = new Map<string, number[]>()
          text.items.forEach((item, index) => {
            const identity = scriptIdentity(item)
            if (identity)
              targetScripts.set(identity, [...(targetScripts.get(identity) ?? []), index])
          })
          for (const [identity, indices] of targetScripts) {
            const originals = sourceScripts.get(identity)
            if (!originals?.length || indices.length !== originals.length) continue
            const region = sourceRegionOwners.get(originals[0])
            // Minor native ink fitting can scale scripts together. Repeated
            // markers are unambiguous only when all originals share one owner,
            // their count and baseline survive, and both axes keep the same scale.
            if (!region || originals.some((index) => sourceRegionOwners.get(index) !== region))
              continue
            if (
              !indices.every((index, i) => {
                const before = originalText!.items[originals[i]] as TextItem,
                  after = text.items[index] as TextItem,
                  scale = after.transform[0] / before.transform[0]
                return (
                  scale >= 0.98 &&
                  scale <= 1.02 &&
                  Math.abs(after.transform[3] / before.transform[3] - scale) < 0.001
                )
              })
            )
              continue
            for (const index of indices) preservedTargetOwners.set(index, region)
          }
          // Padding accommodates font advances, but cannot give a neighboring
          // paragraph ownership of a glyph fully inside one exact source region.
          const targetRegions = units.flatMap((unit) =>
            unit.fragments
              .filter((fragment) => fragment.pageNumber === number)
              .map((fragment) => fragment.rect)
          )
          // A closed native subscript can cross an old line's read padding after
          // reflow. Prove its base/script/suffix in both PDFs before projecting
          // only its reading baseline; actual glyph geometry remains untouched.
          type ScriptPart = TextItem & { index: number }
          type ScriptPacket = {
            token: string
            base: ScriptPart
            script: ScriptPart
            suffix: ScriptPart[]
          }
          const scriptPackets = (content: TextContent): ScriptPacket[] => {
            if (source.rotation !== 0 || target.rotation !== 0 || content.items.length > 8192)
              return []
            const entries = content.items.flatMap((item, index) =>
                'str' in item &&
                item.str.trim() &&
                item.width > 0 &&
                item.transform.every(Number.isFinite) &&
                item.transform[0] > 0 &&
                item.transform[3] === item.transform[0] &&
                item.transform[1] === 0 &&
                item.transform[2] === 0
                  ? [{ ...item, index }]
                  : []
              ),
              packets: ScriptPacket[] = []
            const next = (left: ScriptPart, body: ScriptPart): ScriptPart[] =>
              entries.filter(
                (right) =>
                  right !== left &&
                  Math.abs(right.transform[5] - body.transform[5]) < 0.01 &&
                  Math.abs(right.transform[0] - body.transform[0]) < 0.01 &&
                  right.transform[4] - left.transform[4] - left.width >= -0.01 &&
                  right.transform[4] - left.transform[4] - left.width < body.transform[0] * 0.1
              )
            const candidates = entries.filter((item) =>
              /^[A-Za-z\p{Script=Greek}]$/u.test(item.str)
            )
            if (candidates.length > 256) return []
            for (const script of candidates) {
              const bases = entries.filter(
                (base) =>
                  /(?:^|[^A-Za-z\p{Script=Greek}\d])([A-Za-z\p{Script=Greek}]{1,3})\s*$/u.test(
                    base.str
                  ) &&
                  script.transform[0] / base.transform[0] >= 0.5 &&
                  script.transform[0] / base.transform[0] < 0.85 &&
                  base.transform[5] - script.transform[5] > base.transform[0] * 0.1 &&
                  base.transform[5] - script.transform[5] < base.transform[0] * 0.8 &&
                  script.transform[4] - base.transform[4] - base.width >= -0.01 &&
                  script.transform[4] - base.transform[4] - base.width < base.transform[0] * 0.1
              )
              if (bases.length !== 1) continue
              const base = bases[0],
                suffix: ScriptPart[] = []
              let left = script,
                label = ''
              for (let count = 0; count < 4; count++) {
                const candidates = next(left, base)
                if (candidates.length !== 1) break
                left = candidates[0]
                suffix.push(left)
                label += textKey(left.str)
                if (
                  /^(?:\[[A-Za-z\p{Script=Greek}\d]{1,3}\]|\([A-Za-z\p{Script=Greek}\d]{1,3}\))/u.test(
                    label
                  )
                )
                  break
                if (!/^[[(][A-Za-z\p{Script=Greek}\d]{0,3}$/u.test(label)) break
              }
              const closed =
                /^(?:\[[A-Za-z\p{Script=Greek}\d]{1,3}\]|\([A-Za-z\p{Script=Greek}\d]{1,3}\))/u.exec(
                  label
                )?.[0]
              if (!closed) continue
              const parts = [base, script, ...suffix],
                low = base.transform[4] + base.width,
                high = suffix[0].transform[4]
              if (
                entries.some(
                  (item) =>
                    !parts.includes(item) &&
                    item.transform[4] < high - 0.001 &&
                    item.transform[4] + item.width > low + 0.001 &&
                    item.transform[5] >= script.transform[5] - 0.001 &&
                    item.transform[5] <= base.transform[5] + 0.001
                )
              )
                continue
              packets.push({
                token:
                  /([A-Za-z\p{Script=Greek}]{1,3})\s*$/u.exec(base.str)![1] + script.str + closed,
                base,
                script,
                suffix
              })
            }
            return packets
          }
          const scriptReadProjection = new Map<
              number,
              { y: number; rect: (typeof targetRegions)[number] }
            >(),
            beforePackets = scriptPackets(originalText),
            afterPackets = scriptPackets(text),
            literalText = (content: TextContent): string =>
              content.items.length <= 8192
                ? textKey(
                    content.items.flatMap((item) => ('str' in item ? [item.str] : [])).join('')
                  )
                : '',
            beforeLiteral =
              beforePackets.length && afterPackets.length ? literalText(originalText) : '',
            afterLiteral = beforePackets.length && afterPackets.length ? literalText(text) : '',
            literalCount = (value: string, token: string): number => {
              let count = 0
              for (
                let at = value.indexOf(token);
                at >= 0;
                at = value.indexOf(token, at + token.length)
              ) {
                if (++count > 8) break
              }
              return count
            }
          for (const token of new Set(afterPackets.map((packet) => packet.token))) {
            const matches = beforePackets.filter((packet) => packet.token === token),
              targets = afterPackets.filter((packet) => packet.token === token)
            if (
              !matches.length ||
              matches.length > 8 ||
              targets.length !== matches.length ||
              literalCount(beforeLiteral, token) !== matches.length ||
              literalCount(afterLiteral, token) !== targets.length
            )
              continue
            const before = matches[0],
              sourceParts = matches.flatMap((packet) => [
                packet.base,
                packet.script,
                ...packet.suffix
              ]),
              owners = units.filter((unit) =>
                sourceParts.every(
                  (part) =>
                    sourceRegionOwners.get(part.index) &&
                    unit.fragments.some(
                      (fragment) =>
                        fragment.pageNumber === number &&
                        fragment.items.some(
                          (claim) =>
                            claim.index === part.index && textKey(claim.text) === textKey(part.str)
                        )
                    )
                )
              ),
              sameStyle = (packet: ScriptPacket): boolean =>
                Math.abs(
                  before.script.transform[0] / before.base.transform[0] -
                    packet.script.transform[0] / packet.base.transform[0]
                ) < 0.01 &&
                Math.abs(
                  before.script.transform[5] -
                    before.base.transform[5] -
                    (packet.script.transform[5] - packet.base.transform[5])
                ) < 0.05,
              consistentFonts = (packets: ScriptPacket[]): boolean =>
                packets.every(
                  (packet) =>
                    packet.base.fontName === packets[0].base.fontName &&
                    packet.script.fontName === packets[0].script.fontName
                )
            if (
              owners.length !== 1 ||
              !matches.every(sameStyle) ||
              !targets.every(sameStyle) ||
              !consistentFonts(matches) ||
              !consistentFonts(targets)
            )
              continue
            const projections = targets.map((after) => {
              if (unownedNativeTargets.has(after.script.index)) return undefined
              const points = [after.base, ...after.suffix].flatMap((item) => [
                  target.convertToViewportPoint(item.transform[4], item.transform[5]),
                  target.convertToViewportPoint(item.transform[4] + item.width, item.transform[5])
                ]),
                regions = targetRegions.filter((rect) =>
                  points.every(
                    ([x, y]) =>
                      x >= rect.x * target.width - 0.001 &&
                      x <= (rect.x + rect.width) * target.width + 0.001 &&
                      y >= rect.y * target.height - 0.001 &&
                      y <= (rect.y + rect.height) * target.height + 0.001
                  )
                )
              if (
                regions.length !== 1 ||
                !owners[0].fragments.some((f) => f.rect === regions[0]) ||
                (preservedTargetOwners.has(after.script.index) &&
                  preservedTargetOwners.get(after.script.index) !== regions[0])
              )
                return undefined
              return {
                index: after.script.index,
                y: target.convertToViewportPoint(
                  after.script.transform[4],
                  after.base.transform[5]
                )[1],
                rect: regions[0]
              }
            })
            // Complete same-style copies need no occurrence-to-occurrence pairing.
            // Admit the entire closed multiset or keep the original validation.
            if (projections.some((projection) => !projection)) continue
            for (const projection of projections)
              if (projection)
                scriptReadProjection.set(projection.index, {
                  y: projection.y,
                  rect: projection.rect
                })
          }
          // The raised digit can cross a former line's read boundary after reflow.
          // A native pair and its returning prose establish the reading row.
          const raisedDigitPackets = (content: TextContent): ScriptPacket[] => {
            if (source.rotation !== 0 || target.rotation !== 0 || content.items.length > 8192)
              return []
            const entries = content.items.flatMap((item, index) =>
              'str' in item && item.str.trim() ? [{ ...item, index }] : []
            )
            return entries.flatMap((script, index) => {
              if (!/^[2-9]$/u.test(script.str)) return []
              const base = entries[index - 1],
                suffix = entries[index + 1]
              const letter = base && /(?<![A-Za-z\d])([A-Z])\s*$/u.exec(base.str)?.[1]
              if (!letter || !suffix || !/^[,，.]?\s*\p{L}{2,}/u.test(suffix.str)) return []
              if (
                [base, script, suffix].some(
                  ({ width, transform: [a, b, c, d, x, y] }) =>
                    ![width, a, b, c, d, x, y].every(Number.isFinite) ||
                    width <= 0 ||
                    a <= 0 ||
                    a !== d ||
                    b !== 0 ||
                    c !== 0
                )
              )
                return []
              const [size, , , , x, y] = base.transform,
                [digitSize, , , , sx, sy] = script.transform,
                [suffixSize, , , , tx, ty] = suffix.transform,
                join = sx - x - base.width,
                following = tx - sx - script.width
              return digitSize >= size * 0.6 &&
                digitSize < size * 0.8 &&
                sy - y > size * 0.3 &&
                sy - y < size * 0.42 &&
                join >= -0.01 &&
                join < size * 0.15 &&
                following >= -0.01 &&
                following < size * 0.35 &&
                Math.abs(y - ty) < 0.01 &&
                Math.abs(size - suffixSize) < 0.01
                ? [{ token: letter + script.str, base, script, suffix: [suffix] }]
                : []
            })
          }
          const originalRaised = raisedDigitPackets(originalText)
          if (originalRaised.length) {
            const targetRaised = raisedDigitPackets(text)
            for (const before of originalRaised) {
              const token = new RegExp(
                `(?<![A-Za-z\\d])${before.token[0]}\\s*${before.token[1]}(?![A-Za-z\\d])`,
                'gu'
              )
              const owners = units.flatMap((unit, index) =>
                !unchanged(index) &&
                [unit.source, renderUnits[index].translation].every(
                  (value) => [...value.matchAll(token)].length === 1
                ) &&
                [before.base, before.script, ...before.suffix].every(
                  (part) =>
                    !sourceOnlyItems.has(part.index) &&
                    unit.fragments.some(
                      ({ pageNumber, rect, items }) =>
                        pageNumber === number &&
                        sourceRegionOwners.get(part.index) === rect &&
                        items.some((item) => item.index === part.index && item.text === part.str)
                    )
                )
                  ? [unit]
                  : []
              )
              if (owners.length !== 1) continue
              const placements = targetRaised.flatMap((after) => {
                if (
                  after.token !== before.token ||
                  unownedNativeTargets.has(after.script.index) ||
                  scriptReadProjection.has(after.script.index) ||
                  Math.abs(after.base.transform[0] - before.base.transform[0]) >= 0.02 ||
                  Math.abs(after.script.transform[0] - before.script.transform[0]) >= 0.02 ||
                  Math.abs(
                    after.script.transform[5] -
                      after.base.transform[5] -
                      (before.script.transform[5] - before.base.transform[5])
                  ) >= 0.05
                )
                  return []
                const [, y] = target.convertToViewportPoint(0, after.base.transform[5])
                const regions = targetRegions.filter(
                  (rect) =>
                    y >= rect.y * target.height - 0.001 &&
                    y <= (rect.y + rect.height) * target.height + 0.001 &&
                    [after.base, after.script, ...after.suffix].every((item) => {
                      const [left] = target.convertToViewportPoint(item.transform[4], 0)
                      const [right] = target.convertToViewportPoint(
                        item.transform[4] + item.width,
                        0
                      )
                      return (
                        left >= rect.x * target.width - 0.001 &&
                        right <= (rect.x + rect.width) * target.width + 0.001
                      )
                    })
                )
                const rect = regions[0]
                const conflicting = preservedTargetOwners.get(after.script.index)
                return regions.length === 1 &&
                  owners[0].fragments.some((fragment) => fragment.rect === rect) &&
                  (!conflicting || conflicting === rect)
                  ? [{ index: after.script.index, y, rect }]
                  : []
              })
              if (placements.length !== 1) continue
              const { index, y, rect } = placements[0]
              scriptReadProjection.set(index, { y, rect })
            }
          }
          const exactOwners = new WeakMap<
            ReturnType<typeof projectText>,
            Map<number, PdfTranslationRenderUnit['fragments'][number]['rect']>
          >()
          const exactTargetOwners = (
            content: ReturnType<typeof projectText>
          ): Map<number, PdfTranslationRenderUnit['fragments'][number]['rect']> => {
            let owners = exactOwners.get(content)
            if (owners) return owners
            owners = new Map()
            for (const item of content) {
              if (unchangedNativePage) {
                const sourceOwner = sourceRegionOwners.get(item.index)
                if (sourceOwner) owners.set(item.index, sourceOwner)
                continue
              }
              if (unownedNativeTargets.has(item.index)) continue
              const script = scriptReadProjection.get(item.index)
              if (script) {
                owners.set(item.index, script.rect)
                continue
              }
              const preserved = preservedTargetOwners.get(item.index)
              if (
                preserved &&
                'str' in text.items[item.index] &&
                (text.items[item.index] as TextItem).str === item.str
              ) {
                owners.set(item.index, preserved)
                continue
              }
              // Native single-precision serialization can cross an exact edge by
              // a fraction of a millipoint; this is not the one-point read padding.
              const regions = targetRegions.filter((region) =>
                item.points.every(
                  ([x, y]) =>
                    x >= region.x * target.width - 0.001 &&
                    x <= (region.x + region.width) * target.width + 0.001 &&
                    y >= region.y * target.height - 0.001 &&
                    y <= (region.y + region.height) * target.height + 0.001
                )
              )
              if (regions.length === 1) owners.set(item.index, regions[0])
            }
            exactOwners.set(content, owners)
            return owners
          }
          const readRegion = (
            rect: PdfTranslationRenderUnit['fragments'][number]['rect'],
            content: ReturnType<typeof projectText>,
            viewport: typeof target,
            owner?: string,
            excluded?: ReadonlySet<number>,
            semanticSpaces = false
          ): string => {
            let previousEnd: number[] | undefined
            let value = ''
            const exact = viewport === target ? exactTargetOwners(content) : sourceRegionOwners
            for (const { index, str, points } of content) {
              if (
                (viewport === target ? hidden?.target : hidden?.source)?.has(index) ||
                excluded?.has(index) ||
                (exact?.get(index) && exact.get(index) !== rect)
              )
                continue
              // Baseline/advance positions are independent of embedded font ascent metrics.
              const projected = viewport === target ? scriptReadProjection.get(index) : undefined
              const inside = points.every(([px, rawY]) => {
                const py = projected?.y ?? rawY
                return (
                  px >= rect.x * viewport.width - 1 &&
                  px <= (rect.x + rect.width) * viewport.width + 1 &&
                  py >= rect.y * viewport.height - 1 &&
                  py <= (rect.y + rect.height) * viewport.height + 1
                )
              })
              if (!inside) continue
              if (owner !== undefined) {
                const previous = owned.get(index)
                if (previous !== undefined) {
                  // Adjacent fragments of one paragraph may share their read
                  // padding. Count a target glyph once; the complete ordered
                  // translation is still checked below. Other paragraphs must
                  // never acquire that same glyph.
                  if (previous.split(':')[0] === owner.split(':')[0]) continue
                  overlapping.add(previous)
                  overlapping.add(owner)
                }
                owned.set(index, owner)
              }
              if (semanticSpaces && previousEnd) {
                const item = text.items[index]
                const em =
                  item && 'str' in item ? Math.hypot(item.transform[0], item.transform[1]) : 0
                if (
                  Math.abs(points[0][1] - previousEnd[1]) > em * 0.4 ||
                  points[0][0] - previousEnd[0] > em * 0.12
                )
                  value += ' '
              }
              value += str
              previousEnd = points[1]
            }
            return value
          }
          // Rebuild literal ownership from original native items on every read,
          // including restored checkpoints. Snapshot text alone is never proof.
          const mixedOwners = nativeMixedBulletOwners(
            originalText.items,
            originalText.styles,
            new Set(
              runResults.source.units
                .filter((unit) => unit.sourceOnly || unit.preserve || unit.figure)
                .flatMap((unit) =>
                  unit.fragments
                    .filter((f) => f.pageNumber === number)
                    .flatMap((f) => f.items.map((item) => item.index))
                )
            )
          )
          // Verify the complete target across its own ordered regions, rather than
          // requiring an entire cross-page paragraph to appear on every page.
          for (let i = 0; i < units.length; i++) {
            for (const [f, fragment] of units[i].fragments.entries()) {
              if (fragment.pageNumber !== number) continue
              const { rect } = fragment
              targetItems ??= projectedTarget()
              if (sourceOnlyItems.size)
                originalText ??= await getPdfTranslationTextContent(sourcePage)
              const foreign = retainedForeignItems(fragment, i, f)
              regionText[i][f] = readRegion(rect, targetItems, target, `${i}:${f}`, foreign)
              rawRegionText[i][f] =
                nativeLabels.size || foreign.size
                  ? readRegion(rect, rawTargetItems!, target)
                  : regionText[i][f]
              if (
                unchanged(i) ||
                textKey(regionText[i][f]) !== textKey(renderUnits[i].translation)
              ) {
                originalText ??= await getPdfTranslationTextContent(sourcePage)
                sourceItems ??= projectText(originalText, source)
                originalRegionText[i][f] = readRegion(rect, sourceItems, source)
              }
              if (!unchanged(i)) {
                const indices = new Set(fragment.items.map((item) => item.index))
                for (const mixed of mixedOwners) {
                  if (!mixed.indices.some((index) => indices.has(index))) continue
                  const claimed =
                    new Set(fragment.items.map((claim) => claim.index)).size ===
                      fragment.items.length &&
                    !runResults.source.units.some(
                      (other) =>
                        other.id !== units[i].id &&
                        other.fragments.some(
                          (part) =>
                            part.pageNumber === number &&
                            part.items.some((claim) => mixed.indices.includes(claim.index))
                        )
                    ) &&
                    !runResults.source.originalRegions?.some(
                      (region) =>
                        region.pageNumber === number &&
                        mixed.indices.some((index) => {
                          const item = originalText!.items[index]
                          if (!item || !('str' in item)) return true
                          const [x, y] = source.convertToViewportPoint(
                            item.transform[4] + item.width / 2,
                            item.transform[5]
                          )
                          return (
                            x >= region.rect.x * source.width &&
                            x <= (region.rect.x + region.rect.width) * source.width &&
                            y >= region.rect.y * source.height &&
                            y <= (region.rect.y + region.rect.height) * source.height
                          )
                        })
                    ) &&
                    fragment.items.every((claim) => {
                      const native = originalText!.items[claim.index]
                      return native && 'str' in native && native.str === claim.text
                    })
                  if (
                    !mixed.indices.every((index) => indices.has(index)) ||
                    !mixed.proved ||
                    !claimed ||
                    !nativeMixedBulletLiteralsMatch(mixed.literals, renderUnits[i].translation) ||
                    !nativeMixedBulletLiteralsMatch(
                      mixed.literals,
                      readRegion(rect, targetItems, target, undefined, foreign, true)
                    )
                  )
                    throw validationError('PDF literal example changed', i, f, 'literal-example')
                }
              }
              // No-op regions retain original glyphs, including line-end hyphens
              // removed by paragraph grouping. Compare the actual original region;
              // never strip punctuation from translated text to make validation pass.
              if (unchanged(i)) {
                const retained = textKey(originalRegionText[i][f])
                if (!retained || textKey(rawRegionText[i][f]) !== retained)
                  throw validationError('Retained PDF source text or placement changed', i, f)
              }
            }
          }
          // Bounding boxes can include separately grouped superscripts. Shared geometry
          // is safe only for exact retained text with distinct, verified source runs.
          const sourceOwnership = new Set<number>()
          for (const owner of overlapping) {
            const [i, f] = owner.split(':').map(Number)
            originalText ??= await getPdfTranslationTextContent(sourcePage)
            sourceItems ??= projectText(originalText, source)
            originalRegionText[i][f] = readRegion(units[i].fragments[f].rect, sourceItems, source)
            const retained = textKey(originalRegionText[i][f])
            if (
              !retained ||
              textKey(rawRegionText[i][f]) !== retained ||
              !units[i].fragments[f].items.length
            ) {
              throw validationError(
                'Ambiguous PDF translation regions',
                i,
                f,
                retained && units[i].fragments[f].items.length ? 'overlapping-owner' : undefined
              )
            }
            for (const item of units[i].fragments[f].items) {
              const originalItem = originalText?.items[item.index]
              if (
                sourceOwnership.has(item.index) ||
                !originalItem ||
                !('str' in originalItem) ||
                textKey(originalItem.str) !== textKey(item.text)
              )
                throw validationError('Ambiguous PDF translation regions', i, f)
              sourceOwnership.add(item.index)
            }
          }
          pages.push({ width: source.width, height: source.height, rotation: source.rotation })
          if (hidden && !hidden.current()) throw validationError('Target native exclusion changed')
        } finally {
          if (!heldNativePages.has(translatedPage)) translatedPage.cleanup()
        }
      }
      if (!nativeExclusionChecks.every((current) => current()))
        throw validationError('Target native exclusion changed')
      await closeTargetExclusions()
      let originalUnitCount = runResults.failedUnitIds?.length ?? 0
      const retainedUnitIds: string[] = []
      for (let i = 0; i < units.length; i++) {
        if (
          preservedIds.has(units[i].id) &&
          acceptedById.has(units[i].id) &&
          acceptedById.get(units[i].id)!.translation !== units[i].source
        ) {
          originalUnitCount++
          retainedUnitIds.push(units[i].id)
        }
        if (
          units[i].source !== renderUnits[i].translation &&
          (unverifiedLeadingAccent.has(i) ||
            textKey(regionText[i].join('')) !== textKey(renderUnits[i].translation))
        ) {
          // A fallback is accepted only if every fragment still contains the exact original
          // text at its original position. Mixed, missing or misplaced fragments still fail.
          if (
            !rawRegionText[i].every(
              (text, f) => textKey(text) && textKey(text) === textKey(originalRegionText[i][f])
            )
          )
            throw validationError(
              'PDF translation text or placement changed',
              i,
              rawRegionText[i].findIndex(
                (text, f) => !textKey(text) || textKey(text) !== textKey(originalRegionText[i][f])
              ),
              'unit-placement'
            )
          originalUnitCount++
          retainedUnitIds.push(units[i].id)
        }
      }
      return {
        pages,
        originalUnitCount,
        retainedUnitIds,
        validation: { regionText, rawRegionText, originalRegionText, annotations }
      }
    }
  }
}
