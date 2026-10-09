import { verifiedPdfLatinAccentText } from './pdf-translation-latin-accents'
import { pdfTranslationLayoutFragments } from './pdf-translation-fragments'
import { getPdfTranslationTextContent } from './pdf-translation-text-content'
import { resolveInlineFractions } from '../../../../../../../resources/pdf-translation/math-fractions.mjs'
import {
  pdfLinkLabelKey,
  pdfLinkLabelMatches,
  pdfLinkAddressMatches,
  translatedPdfBracketedReference,
  translatedPdfLinkFragment,
  translatedPdfLinkLabel
} from '../../../../../../../resources/pdf-translation/link-labels.mjs'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { pdfjsLib } from '../pdfjs'
import { isPdfTranslationResultExtension, type PdfTranslationResults } from './pdf-translation'
import {
  pdfGenerationFailure,
  type PdfGenerationFailure,
  type PdfTranslationLayoutFailure,
  type PdfTranslationRecordLayoutRequest
} from '../../../../../../shared/pdf-translation'

/** A generated file belongs to exactly one accepted result snapshot, never a filename alone. */
export type PdfTranslationArtifact = Readonly<{ results: PdfTranslationResults; data: Uint8Array }>
type Geometry = Readonly<{ width: number; height: number; rotation: number }>
type State =
  | { status: 'idle' }
  | { status: 'loading'; phase: 'generating' | 'validating' }
  | {
      status: 'error'
      failure: PdfGenerationFailure
      details?: string
      unitId?: string
      retryUnchanged?: boolean
    }
  | {
      status: 'ready'
      document: PDFDocumentProxy
      pages: readonly Geometry[]
      originalUnitCount: number
      retainedUnitIds: readonly string[]
      unchangedLayoutUnitIds?: readonly string[]
    }
const idle: State = { status: 'idle' }
const textKey = (text: string): string => text.normalize('NFC').replace(/\s/gu, '')

type TextContent = Awaited<ReturnType<PDFPageProxy['getTextContent']>>
type TextItem = Extract<TextContent['items'][number], { str: string }>

// Unicode powers may retain the publisher's digit glyph and raised geometry.
// Admit that spelling only when both PDFs prove the same adjacent base/exponent.
function verifiedPowerText(
  original: TextContent,
  target: TextContent,
  labels: Set<string>
): Map<number, string> {
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
    result = new Map<number, string>()
  for (const label of labels) {
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
    for (const p of targets) result.set(p.index, label.match(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+$/u)![0])
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
  type Bar = { rect: number[]; width: number }
  const bars = async (page: PDFPageProxy): Promise<Bar[]> => {
    const { fnArray, argsArray } = await page.getOperatorList(),
      ops = pdfjsLib.OPS
    let matrix = [1, 0, 0, 1, 0, 0],
      width = 1
    const stack: Array<{ matrix: number[]; width: number }> = [],
      result: Bar[] = []
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
            width: args[0] === ops.stroke ? width * Math.abs(matrix[0]) : rect[3] - rect[1]
          })
      }
    }
    return result
  }
  const [originalBars, targetBars] = await Promise.all([bars(originalPage), bars(targetPage)])
  const same = (a: number, b: number): boolean => Math.abs(a - b) < 0.02
  const used = new Set<number>()
  for (const fraction of fractions) {
    const members = fraction.indices.map((index) => before.find((item) => item.index === index)!)
    const numerator = members[0],
      denominator = members.slice(1)
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
  regions: { sourceIndices: Set<number>; targetIndices: Set<number> }[]
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
          (/^[ˆ¯˜]$/u.test(item.str.trim()) && item.width > 0 && item.width < item.transform[3])
      )
      .map((item) => ({ ...item, str: item.str.trim() }))
      .flatMap((mark) => {
        const bases = items.filter(
          (base) =>
            /^[A-Za-z\p{Script=Greek}]/u.test(base.str) &&
            (Math.abs(base.transform[4] - mark.transform[4]) < mark.transform[3] * 0.25 ||
              // A wide native letter can start well left of its centered hat.
              // Require the complete single-letter footprint, then prove the
              // unchanged inset and dimensions in both PDFs below.
              (/^[A-Za-z\p{Script=Greek}]$/u.test(base.str) &&
                /^[ˆ¯˜]$/u.test(mark.str) &&
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
    if (originals.length !== matches.length) continue
    for (const { mark, base } of matches) {
      const indices = [mark.index, base.index],
        letter = String.fromCodePoint(base.str.codePointAt(0)!)
      result.set(Math.min(...indices), {
        label: (letter + mark.str + base.str.slice(letter.length)).normalize('NFC'),
        indices
      })
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
    right = left + before.width,
    pieces = target.items
      .flatMap((item, index) =>
        'str' in item &&
        item.str.trim() &&
        item.transform[4] >= left - 0.001 &&
        item.transform[4] + item.width <= right + 0.001 &&
        item.transform.every((value, i) => i === 4 || Math.abs(value - before.transform[i]) < 0.001)
          ? [{ item, index }]
          : []
      )
      .sort((a, b) => a.item.transform[4] - b.item.transform[4])
  if (
    pieces.length < 2 ||
    textKey(pieces.map(({ item }) => item.str).join('')) !== textKey(before.str) ||
    Math.abs(pieces[0].item.transform[4] - left) >= 0.001 ||
    Math.abs(pieces.at(-1)!.item.transform[4] + pieces.at(-1)!.item.width - right) >= 0.001 ||
    pieces.some(
      ({ item }, i) =>
        i > 0 &&
        item.transform[4] < pieces[i - 1].item.transform[4] + pieces[i - 1].item.width - 0.001
    )
  )
    return undefined
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
          before.transform[5] + before.transform[3] * fontBounds[0]
        ),
        viewport.convertToViewportPoint(
          right,
          before.transform[5] + before.transform[3] * fontBounds[1]
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
// Align crops to each glyph origin, so save-time coordinate rounding never
// changes raster phase; require exactly identical, nonempty native ink.
async function verifiedNativePrefixInk(
  before: TextItem,
  after: TextItem,
  originalPage: PDFPageProxy,
  targetPage: PDFPageProxy,
  sourceStyle: TextContent['styles'][string]
): Promise<boolean> {
  if (
    typeof originalPage.render !== 'function' ||
    typeof targetPage.render !== 'function' ||
    sourceStyle.vertical ||
    !Number.isFinite(sourceStyle.ascent) ||
    !Number.isFinite(sourceStyle.descent) ||
    sourceStyle.ascent <= 0 ||
    sourceStyle.ascent > 1.5 ||
    sourceStyle.descent > 0 ||
    sourceStyle.descent < -1
  )
    return false
  const fontBounds = [sourceStyle.descent, sourceStyle.ascent]
  const pixels = async (
    page: PDFPageProxy,
    before: TextItem
  ): Promise<Uint8ClampedArray | undefined> => {
    const viewport = page.getViewport({ scale: 4 }),
      corners = [
        viewport.convertToViewportPoint(
          before.transform[4],
          before.transform[5] + before.transform[3] * fontBounds[0]
        ),
        viewport.convertToViewportPoint(
          before.transform[4] + before.width,
          before.transform[5] + before.transform[3] * fontBounds[1]
        )
      ],
      x = Math.min(...corners.map(([x]) => x)),
      y = Math.min(...corners.map(([, y]) => y)),
      width = Math.ceil(Math.max(...corners.map(([x]) => x)) - x),
      height = Math.ceil(Math.max(...corners.map(([, y]) => y)) - y)
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
  const [original, target] = await Promise.all([
    pixels(originalPage, { ...before, width: after.width }),
    pixels(targetPage, after)
  ])
  return Boolean(
    original &&
    target &&
    original.length === target.length &&
    original.some(
      (value, index) =>
        index % 4 === 3 &&
        value > 0 &&
        original[index - 3] + original[index - 2] + original[index - 1] < 765
    ) &&
    original.every((value, index) => value === target[index])
  )
}

type PdfTranslationRenderUnit = Readonly<{
  source: string
  fragments: PdfTranslationResults['source']['units'][number]['fragments']
  translation: string
}>

// Some PDFs emit a single paragraph as one fragment per line. Treat adjacent
// lines in its own column as one layout area; never cross another unit's space.

function partialPdfSnapshot(results: PdfTranslationResults): Readonly<{
  ready: boolean
  readyPages: readonly number[]
  units: readonly PdfTranslationRenderUnit[]
}> {
  const sourceUnits = results.source.units.filter((unit) => !unit.sourceOnly)
  const sourceById = new Map(sourceUnits.map((unit) => [unit.id, unit]))
  const accepted = results.units.filter((unit) => {
    const source = sourceById.get(unit.id)
    return Boolean(source && unit.translationSource === source.source && unit.translation.trim())
  })
  const translations = new Map(accepted.map((unit) => [unit.id, unit]))
  const completed = new Set([...accepted.map((unit) => unit.id), ...(results.failedUnitIds ?? [])])
  const pageUnits = new Map<number, Set<string>>()
  for (const unit of sourceUnits) {
    for (const fragment of unit.fragments) {
      const owners = pageUnits.get(fragment.pageNumber) ?? new Set<string>()
      owners.add(unit.id)
      pageUnits.set(fragment.pageNumber, owners)
    }
  }
  const readyPages = [...pageUnits]
    .filter(([, ids]) => ids.size > 0 && [...ids].every((id) => completed.has(id)))
    .map(([page]) => page)
    .sort((left, right) => left - right)
  return {
    ready: readyPages.length > 0 && accepted.length > 0,
    readyPages,
    units: sourceUnits.map((unit) => ({
      source: unit.source,
      fragments: pdfTranslationLayoutFragments(unit, results.source),
      translation: translations.get(unit.id)?.translation ?? unit.source
    }))
  }
}

// Object references may change when saving. Compare destinations by page, not object ID.
type AnnotationSnapshot = {
  type: number
  key: string
  rect: readonly number[]
  quadPoints: ArrayLike<number> | undefined
  destinationCoordinates: readonly (number | null)[]
  uri: string | undefined
}
const sameCoordinates = (
  left: ArrayLike<number | null> | undefined,
  right: ArrayLike<number | null> | undefined
): boolean =>
  left === undefined || right === undefined
    ? left === right
    : left.length === right.length &&
      Array.from(left).every((value, index) =>
        value === null || right[index] === null
          ? value === right[index]
          : Number.isFinite(value) &&
            Number.isFinite(right[index]) &&
            Math.abs(value - (right[index] as number)) <= 0.001
      )

async function annotationKey(
  document: PDFDocumentProxy,
  page: PDFPageProxy,
  original = false
): Promise<AnnotationSnapshot[]> {
  const annotations = await page.getAnnotations({ intent: 'any' })
  return Promise.all(
    annotations
      .filter((annotation) => {
        // Match the writer's original-only notes/markup policy. Never filter the generated PDF:
        // unexpected annotations there must still fail independent validation.
        const type = annotation.annotationType
        return !original || type === 2 || type < 1 || type > 16
      })
      .map(async (annotation) => {
        let dest =
          typeof annotation.dest === 'string'
            ? await document.getDestination(annotation.dest)
            : annotation.dest
        // Extracted pages can keep names whose targets are outside the document.
        // Preserve their identity instead of treating every missing target as null.
        const unresolvedDestination =
          typeof annotation.dest === 'string' && dest === null ? annotation.dest : undefined
        if (Array.isArray(dest) && dest[0] && typeof dest[0] === 'object')
          dest = [await document.getPageIndex(dest[0]), ...dest.slice(1)]
        const coordinateCount = Array.isArray(dest)
          ? (({ XYZ: 2, FitH: 1, FitBH: 1, FitV: 1, FitBV: 1, FitR: 4 } as Record<string, number>)[
              dest[1]?.name
            ] ?? 0)
          : 0
        const destinationCoordinates = coordinateCount ? dest.slice(2, 2 + coordinateCount) : []
        // Only positions have point-based tolerance; destination page, mode, nulls
        // and zoom retain their exact meaning.
        if (coordinateCount)
          dest = [
            ...dest.slice(0, 2),
            ...destinationCoordinates.map(() => null),
            ...dest.slice(2 + coordinateCount)
          ]
        return {
          type: annotation.annotationType,
          destinationCoordinates,
          rect: annotation.rect,
          quadPoints: annotation.quadPoints,
          uri: annotation.unsafeUrl ?? annotation.url,
          key: JSON.stringify({
            type: annotation.annotationType,
            color: annotation.color,
            borderStyle: annotation.borderStyle,
            flags: annotation.annotationFlags,
            url: annotation.url,
            unsafeUrl: annotation.unsafeUrl,
            newWindow: annotation.newWindow,
            hasAppearance: annotation.hasAppearance,
            unresolvedDestination,
            dest
          })
        }
      })
  )
}

// Borrows the verified original/results. Owns the writer request and translated PDF.js task only.
export function usePdfTranslationDocument(
  original: PDFDocumentProxy | null,
  results: PdfTranslationResults | undefined,
  artifact: PdfTranslationArtifact | undefined,
  resourceRequestKey: string,
  beforeReady?: () => void
): {
  state: State
  ready: Extract<State, { status: 'ready' }> | undefined
  updateAvailable: boolean
  isCurrent: boolean
  unchangedLayoutUnitIds: readonly string[]
  unfilledUnitIds: readonly string[]
  layoutFailures: Readonly<Record<string, PdfTranslationLayoutFailure>>
  refresh: (unitId?: string) => void
  retry: () => void
  registerDisposer: (dispose: () => void) => () => void
} {
  const [request, setRequest] = useState<{
    failed?: {
      original: PDFDocumentProxy
      results: PdfTranslationResults
      value: Extract<State, { status: 'error' }>
    }
    rebuildArtifact?: PdfTranslationArtifact
    retryUnitId?: string
    baseline?: Displayed
    bypassCache?: { original: PDFDocumentProxy; results: PdfTranslationResults }
  }>({})
  const generationClock = useRef(0)
  const [layoutReports, setLayoutReports] = useState<{
    original: PDFDocumentProxy
    source: PdfTranslationResults['source']
    units: Record<
      string,
      { translation: string; source: string; failure?: PdfTranslationLayoutFailure }
    >
  }>()
  const useArtifact = Boolean(artifact && artifact !== request.rebuildArtifact)
  const disposers = useRef(new Set<() => void>())
  const registerDisposer = useCallback((dispose: () => void) => {
    disposers.current.add(dispose)
    return () => {
      disposers.current.delete(dispose)
    }
  }, [])
  const [stored, setStored] = useState<{
    original: PDFDocumentProxy
    results: PdfTranslationResults
    artifact: PdfTranslationArtifact | undefined
    value: State
  }>()
  const [selection, setSelection] = useState<{
    original: PDFDocumentProxy
    artifact: PdfTranslationArtifact | undefined
    results: PdfTranslationResults
    ready: boolean
  }>()
  type Displayed = {
    original: PDFDocumentProxy
    artifact: PdfTranslationArtifact | undefined
    results: PdfTranslationResults
    value: Extract<State, { status: 'ready' }>
    release: () => void
    data: Uint8Array
    validation: {
      regionText: string[][]
      rawRegionText: string[][]
      originalRegionText: string[][]
      annotations: AnnotationSnapshot[][]
    }
  }
  const [displayed, setDisplayed] = useState<Displayed>()
  const live = useRef<Displayed | undefined>(undefined)
  const admitted =
    original &&
    results &&
    (!artifact || artifact.results === results) &&
    results.source.resourceRequestKey === resourceRequestKey &&
    results.source.fingerprint === original.fingerprints[0]
  // Progress remains live, but appending paragraphs must not replace the PDF
  // under the reader. Completed pages advance the snapshot between generation jobs.
  const selected = admitted
    ? selection?.original === original &&
      selection.artifact === artifact &&
      selection.ready &&
      isPdfTranslationResultExtension(selection.results, results, true)
      ? selection.results
      : results
    : undefined
  const snapshot = useMemo(() => (selected ? partialPdfSnapshot(selected) : undefined), [selected])
  if (
    selection?.results !== selected ||
    (selected && (selection?.original !== original || selection.artifact !== artifact))
  )
    setSelection(
      selected && original
        ? { original, artifact, results: selected, ready: snapshot?.ready ?? false }
        : undefined
    )
  const canDisplay = Boolean(
    admitted &&
    displayed?.original === original &&
    displayed.artifact === artifact &&
    isPdfTranslationResultExtension(displayed.results, results, true)
  )
  useLayoutEffect(() => {
    if (!canDisplay && live.current) {
      live.current.release()
      setDisplayed(undefined)
    }
  }, [canDisplay])
  useEffect(() => () => live.current?.release(), [])
  const storedState =
    admitted &&
    stored?.original === original &&
    stored.artifact === artifact &&
    isPdfTranslationResultExtension(stored.results, results, true)
      ? stored.value
      : idle
  const state = useMemo(
    () =>
      storedState.status === 'error' &&
      storedState.retryUnchanged &&
      stored &&
      results &&
      !isPdfTranslationResultExtension(stored.results, results)
        ? { ...storedState, retryUnchanged: false }
        : storedState,
    [storedState, stored, results]
  )

  useEffect(() => {
    if (!admitted) return
    const runResults = selected
    const runSnapshot = snapshot
    if (!runResults || !runSnapshot) return
    const units = runResults.source.units
      .filter((unit) => !unit.sourceOnly)
      .map((unit, index) => ({ ...unit, fragments: runSnapshot.units[index].fragments }))
    const acceptedById = new Map(runResults.units.map((unit) => [unit.id, unit]))
    const complete =
      units.length > 0 &&
      runResults.units.length === units.length &&
      units.every((unit) => {
        const result = acceptedById.get(unit.id)
        return (
          result?.id === unit.id &&
          result.translationSource === unit.source &&
          Boolean(result.translation.trim())
        )
      })
    const api = window.api?.pdfTranslation
    if (
      (!useArtifact && !runSnapshot.ready) ||
      (useArtifact && !complete) ||
      (!useArtifact && !api?.generatePdf)
    )
      return
    let cancelled = false
    let task: ReturnType<typeof pdfjsLib.getDocument> | undefined
    let released = false
    let validating = false
    let validationPage: number | undefined
    let validationUnit: string | undefined
    const validationError = (
      message: string,
      unitIndex?: number,
      fragmentIndex?: number
    ): Error => {
      const unit = unitIndex === undefined ? undefined : units[unitIndex]
      validationUnit = unit?.id
      if (unit && fragmentIndex !== undefined)
        validationPage = unit.fragments[fragmentIndex]?.pageNumber ?? validationPage
      return new Error(message)
    }
    const baseline = request.baseline
    const reusable =
      !useArtifact &&
      baseline?.original === original &&
      live.current?.release === baseline.release &&
      baseline.artifact === artifact &&
      baseline.results.source === runResults.source
        ? baseline
        : undefined
    const dirtyPages = new Set<number>()
    if (reusable) {
      const before = new Map(reusable.results.units.map((unit) => [unit.id, unit]))
      const retryRetained =
        reusable.results.units.length === runResults.units.length &&
        isPdfTranslationResultExtension(reusable.results, runResults)
      for (const unit of units) {
        const previous = before.get(unit.id),
          next = acceptedById.get(unit.id)
        if (
          previous?.translation !== next?.translation ||
          previous?.translationSource !== next?.translationSource ||
          ((retryRetained || request.retryUnitId === unit.id) &&
            reusable.value.retainedUnitIds.includes(unit.id) &&
            (!request.retryUnitId || request.retryUnitId === unit.id))
        )
          for (const fragment of unit.fragments) dirtyPages.add(fragment.pageNumber)
      }
      // Whole joined units must participate in the rebuild, even when another
      // changed paragraph touches only one of their pages. Close transitively.
      let expanded: boolean
      do {
        expanded = false
        for (const unit of units) {
          if (!unit.fragments.some((fragment) => dirtyPages.has(fragment.pageNumber))) continue
          for (const fragment of unit.fragments)
            if (!dirtyPages.has(fragment.pageNumber)) {
              dirtyPages.add(fragment.pageNumber)
              expanded = true
            }
        }
      } while (expanded)
    }
    let incremental =
      reusable && dirtyPages.size > 0 && dirtyPages.size < original.numPages
        ? { data: reusable.data, pageNumbers: [...dirtyPages].sort((a, b) => a - b) }
        : undefined
    const generatedAt = Math.max(Date.now(), generationClock.current + 1)
    generationClock.current = generatedAt
    const generatedUnits = units.flatMap((unit, sourceIndex) =>
      acceptedById.has(unit.id)
        ? [{ unit, sourceIndex, snapshot: runSnapshot.units[sourceIndex] }]
        : []
    )
    let nativeFailures: Record<string, PdfTranslationLayoutFailure> = {}
    let cacheToken: string | undefined
    let cacheHit = false
    const bypassCache =
      request.bypassCache?.original === original && request.bypassCache.results === runResults
    const cache =
      complete && runResults.checkpoint
        ? {
            source: runResults.checkpoint.source,
            checkpointKey: runResults.checkpoint.key,
            ...(bypassCache ? { bypass: true } : {})
          }
        : undefined
    const recordLayout = (
      entries: PdfTranslationRecordLayoutRequest['units'],
      pdfCacheToken?: string
    ): void => {
      if (cancelled || useArtifact || !entries.length) return
      setLayoutReports((previous) => ({
        original,
        source: runResults.source,
        units: {
          ...(previous?.original === original && previous.source === runResults.source
            ? previous.units
            : {}),
          ...Object.fromEntries(entries.map((entry) => [units[entry.sourceIndex].id, entry]))
        }
      }))
      if (runResults.checkpoint && api?.recordLayout) {
        void api
          .recordLayout({
            source: runResults.checkpoint.source,
            checkpointKey: runResults.checkpoint.key,
            generatedAt,
            units: entries,
            ...(pdfCacheToken ? { pdfCacheToken } : {})
          })
          .catch(() => {
            console.warn('[pdf-translation] Could not save PDF layout diagnostics')
          })
      }
    }
    const id = crypto.randomUUID()
    const publish = (value: State): void => {
      if (!cancelled)
        setStored({
          original,
          results: runResults,
          artifact,
          value
        })
    }
    const release = (): void => {
      if (released) return
      released = true
      if (live.current?.release === release) {
        for (const dispose of disposers.current) {
          try {
            dispose()
          } catch {
            /* Release remaining pages. */
          }
        }
        disposers.current.clear()
        live.current = undefined
      }
      void task?.destroy().catch(() => undefined)
    }
    void (async () => {
      publish({ status: 'loading', phase: 'generating' })
      let data = useArtifact ? artifact?.data : undefined
      if (!data) {
        const source = await original.getData()
        if (cancelled) return
        const generate = async (): Promise<Uint8Array | undefined> => {
          cacheToken = undefined
          cacheHit = false
          const output = await api!.generatePdf({
            id,
            preserveUnsupported: true,
            data: source,
            ...(incremental ? { incremental } : {}),
            ...(cache ? { cache } : {}),
            pages: runResults.source.pages,
            // The native indices refer to this accepted subset, not the full source.
            units: generatedUnits.map(({ snapshot: unit }) => ({
              source: unit.source,
              fragments: unit.fragments,
              translation: unit.translation
            }))
          })
          nativeFailures = {}
          if (!output || output instanceof Uint8Array) return output ?? undefined
          cacheToken = cache ? output.cacheToken : undefined
          cacheHit = Boolean(cache && output.cacheHit)
          // A persisted PDF has not been validated in this reader; check every page.
          if (cacheHit) incremental = undefined
          for (const { unitIndex, ...failure } of output.layoutFailures) {
            const entry = generatedUnits[unitIndex]
            if (entry) nativeFailures[entry.unit.id] = failure
          }
          return output.data
        }
        try {
          data = await generate()
        } catch (error) {
          // Unsupported page transplantation falls back once to the original full
          // generation/validation path. Capacity/timeouts remain explicit errors.
          const code = pdfGenerationFailure(error).code
          if (!incremental || !['worker-failed', 'invalid-input'].includes(code) || cancelled)
            throw error
          incremental = undefined
          data = await generate()
        }
      }
      if (cancelled) return
      if (!data?.byteLength) throw new Error('PDF generation was not admitted')
      validating = true
      publish({ status: 'loading', phase: 'validating' })
      // PDF.js transfers its input; the producer retains its bytes for retry/export.
      task = pdfjsLib.getDocument({ data: data.slice() })
      const translated = await task.promise
      if (cancelled) return
      if (translated.numPages !== original.numPages) throw validationError('PDF page count changed')
      const pages: Geometry[] = []
      const cached = incremental ? reusable?.validation : undefined
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
      for (let number = 1; number <= original.numPages; number++) {
        validationPage = number
        if (cancelled) return
        const [sourcePage, translatedPage]: [PDFPageProxy, PDFPageProxy] = await Promise.all([
          original.getPage(number),
          translated.getPage(number)
        ])
        if (cancelled) return
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
            annotationKey(translated, translatedPage)
          ])
          annotations.push(targetAnnotations)
          const text: TextContent = await getPdfTranslationTextContent(translatedPage)
          let originalText: TextContent | undefined
          const unchanged = (index: number): boolean =>
            units[index].source === runSnapshot.units[index].translation
          // A moved link keeps its original label/action and stays within one source
          // paragraph. References can legitimately repeat within that paragraph;
          // full translated text is verified independently below.
          const linkedItems = (
            content: TextContent,
            rect: readonly number[],
            intersect = false
          ): TextItem[] =>
            content.items.flatMap((item) => {
              if (!('str' in item) || !item.str.trim()) return []
              const [a, b, , , x, y] = item.transform,
                point = Math.hypot(a, b)
              if (!Number.isFinite(point) || point <= 0) return []
              const points = [
                [x - b * 0.3, y + a * 0.3],
                [x + (a / point) * item.width - b * 0.3, y + (b / point) * item.width + a * 0.3]
              ]
              const contained = points.every(
                ([px, py]) =>
                  px >= rect[0] - 1 && px <= rect[2] + 1 && py >= rect[1] - 1 && py <= rect[3] + 1
              )
              const crosses =
                Math.min(...points.map(([, py]) => py)) <= rect[3] + 1 &&
                Math.max(...points.map(([, py]) => py)) >= rect[1] - 1 &&
                Math.min(...points.map(([px]) => px)) <= rect[2] + 1 &&
                Math.max(...points.map(([px]) => px)) >= rect[0] - 1
              return contained || (intersect && crosses) ? [item] : []
            })
          const pageLatinAccentText = new Map<TextItem, string>()
          let latinAccentText = new Map<TextItem, string>()
          const linkedText = (
            content: typeof text,
            rect: readonly number[],
            intersect = false
          ): string =>
            textKey(
              linkedItems(content, rect, intersect)
                .map((item) => latinAccentText.get(item) ?? item.str)
                .join('')
            )
          if (sourceAnnotations.length !== targetAnnotations.length)
            throw validationError('PDF annotations changed')
          for (const [index, annotation] of sourceAnnotations.entries()) {
            const moved = targetAnnotations[index]
            if (
              annotation.key !== moved.key ||
              !sameCoordinates(annotation.quadPoints, moved.quadPoints) ||
              !sameCoordinates(annotation.destinationCoordinates, moved.destinationCoordinates)
            )
              throw validationError('PDF annotations changed')
            if (sameCoordinates(annotation.rect, moved.rect)) continue
            if (
              annotation.type !== 2 ||
              annotation.quadPoints?.length ||
              [annotation.rect, moved.rect].some(
                (rect) =>
                  rect.length !== 4 ||
                  !rect.every(Number.isFinite) ||
                  rect[2] <= rect[0] ||
                  rect[3] <= rect[1]
              ) ||
              Math.abs(annotation.rect[2] - annotation.rect[0] - moved.rect[2] + moved.rect[0]) >
                0.001 ||
              Math.abs(annotation.rect[3] - annotation.rect[1] - moved.rect[3] + moved.rect[1]) >
                0.001
            )
              throw validationError('PDF link geometry changed')
            originalText ??= await getPdfTranslationTextContent(sourcePage)
            latinAccentText = verifiedPdfLatinAccentText(
              originalText,
              text,
              linkedItems(originalText, annotation.rect, true),
              linkedItems(text, moved.rect, true),
              annotation.rect,
              moved.rect
            )
            for (const [item, value] of latinAccentText) pageLatinAccentText.set(item, value)
            // PDF.js may combine a source link with surrounding prose. Require the
            // exact target label once in the intersecting source run and its owner.
            let label = linkedText(text, moved.rect)
            if (!label) {
              // Some links cover only the digit inside one native "[3]" run.
              // Accept its overhang only when the complete unchanged run and
              // its exact position relative to the hit area move together.
              const before = linkedItems(originalText, annotation.rect, true).filter((item) =>
                  item.str.trim()
                ),
                after = linkedItems(text, moved.rect, true).filter((item) => item.str.trim())
              if (
                before.length === 1 &&
                after.length === 1 &&
                /^\[\d+(?:[,–-]\d+)*\]$/u.test(textKey(before[0].str)) &&
                textKey(before[0].str) === textKey(after[0].str) &&
                Math.abs(before[0].width - after[0].width) < 0.01 &&
                before[0].transform
                  .slice(0, 4)
                  .every((value, i) => Math.abs(value - after[0].transform[i]) < 0.01) &&
                [0, 1].every(
                  (axis) =>
                    Math.abs(
                      after[0].transform[4 + axis] -
                        before[0].transform[4 + axis] -
                        moved.rect[axis] +
                        annotation.rect[axis]
                    ) < 0.01
                )
              )
                label = textKey(after[0].str)
            }
            if (!label) {
              // A dated year link may cover its localized closing bracket. Keep
              // only its original right overhang, proven by the complete native
              // source suffix and the same unique author/year paragraph.
              const after = linkedItems(text, moved.rect, true).filter((item) =>
                /^\d{4}[a-z]?[)）]$/u.test(item.str)
              )
              if (after.length === 1) {
                const item = after[0],
                  candidates = units.filter((unit, unitIndex) => {
                    const translation = runSnapshot.units[unitIndex].translation,
                      at = translation.indexOf(item.str),
                      from = translatedPdfLinkFragment(translation, unit.source, item.str, at)
                    if (
                      unchanged(unitIndex) ||
                      at < 0 ||
                      translation.lastIndexOf(item.str) !== at ||
                      !from ||
                      unit.source.indexOf(from.text) !== from.start ||
                      unit.source.lastIndexOf(from.text) !== from.start
                    )
                      return false
                    const before = linkedItems(originalText!, annotation.rect, true).filter(
                      (sourceItem) =>
                        sourceItem.str.endsWith(from.text) &&
                        unit.fragments.some(
                          (fragment) =>
                            fragment.pageNumber === number &&
                            fragment.items.some(
                              (claimed) =>
                                originalText!.items[claimed.index] === sourceItem &&
                                textKey(claimed.text) === textKey(sourceItem.str)
                            )
                        )
                    )
                    if (before.length !== 1) return false
                    const original = before[0],
                      right = original.transform[4] + original.width - annotation.rect[2],
                      pointY = item.transform[5] + item.transform[0] * 0.3
                    return (
                      [original, item].every(
                        (glyph) =>
                          glyph.transform[0] > 0 &&
                          glyph.transform[1] === 0 &&
                          glyph.transform[2] === 0
                      ) &&
                      right > 0 &&
                      right <= original.transform[0] * 0.5 &&
                      item.transform[4] >= moved.rect[0] - 1 &&
                      item.transform[4] + item.width <= moved.rect[2] + right + 0.001 &&
                      pointY >= moved.rect[1] - 1 &&
                      pointY <= moved.rect[3] + 1
                    )
                  })
                if (candidates.length === 1) label = item.str
              }
            }
            if (!label) {
              // PDF.js can combine the original citation with surrounding prose.
              // A comma-separated numeric run may span several smaller hit areas;
              // every member must move together and retain its source label/action.
              const citationRun = (rect: readonly number[]): string => {
                const items = linkedItems(text, rect, true).filter((item) =>
                  /^\d+(?:,\d+)+$/u.test(textKey(item.str))
                )
                return items.length === 1 ? textKey(items[0].str) : ''
              }
              const run = citationRun(moved.rect),
                dx = moved.rect[0] - annotation.rect[0],
                dy = moved.rect[1] - annotation.rect[1],
                group = targetAnnotations.flatMap((candidate, position) =>
                  citationRun(candidate.rect) === run ? [position] : []
                )
              if (
                /^\d+(?:,\d+)+$/u.test(run) &&
                group.length === run.split(',').length &&
                group.every((position) => {
                  const from = sourceAnnotations[position],
                    to = targetAnnotations[position]
                  return (
                    from.type === 2 &&
                    to.type === 2 &&
                    from.key === to.key &&
                    linkedText(originalText!, from.rect, true).split(run).length === 2 &&
                    Math.abs(to.rect[0] - from.rect[0] - dx) <= 0.001 &&
                    Math.abs(to.rect[1] - from.rect[1] - dy) <= 0.001
                  )
                })
              )
                label = run
            }
            let nativeUriLabel = ''
            let nativeUriOwner: (typeof units)[number] | undefined
            if (annotation.uri) {
              // Wrapped URI pieces can keep a small native glyph overhang outside
              // their hit areas. Prove the complete action and rigidly preserved
              // piece, never a substring cut out of translated surrounding prose.
              const group = sourceAnnotations.filter((part) => part.uri === annotation.uri),
                owners = units.flatMap((unit, unitIndex) => {
                  const matches = (value: string): number =>
                      pdfLinkAddressMatches(value.replace(/\b(https?:) +(?=\/\/)/gu, '$1')).filter(
                        (address) => address.text.replace(/ /gu, '') === annotation.uri
                      ).length,
                    native = unit.fragments.flatMap((fragment) =>
                      fragment.pageNumber !== number
                        ? []
                        : fragment.items.flatMap((claimed) => {
                            const item = originalText!.items[claimed.index]
                            return item && 'str' in item && claimed.text === item.str ? [item] : []
                          })
                    ),
                    joined = native.map((item) => textKey(item.str)).join(''),
                    start = joined.indexOf(annotation.uri!)
                  if (
                    unchanged(unitIndex) ||
                    matches(unit.source) !== 1 ||
                    matches(runSnapshot.units[unitIndex].translation) !== 1 ||
                    unit.fragments.some(
                      (fragment) =>
                        fragment.pageNumber !== number ||
                        fragment.items.some((claimed) => {
                          const item = originalText!.items[claimed.index]
                          return !item || !('str' in item) || claimed.text !== item.str
                        })
                    ) ||
                    start < 0 ||
                    joined.lastIndexOf(annotation.uri!) !== start
                  )
                    return []
                  let cursor = 0
                  const owned = native.filter((item) => {
                    const from = cursor
                    cursor += textKey(item.str).length
                    return from >= start && cursor <= start + annotation.uri!.length
                  })
                  return [{ unit, owned }]
                }),
                pieces = group.map((part) =>
                  linkedItems(originalText!, part.rect, true).filter(
                    (item) => owners.length === 1 && owners[0].owned.includes(item)
                  )
                ),
                before = linkedItems(originalText, annotation.rect, true).filter(
                  (item) => owners.length === 1 && owners[0].owned.includes(item)
                ),
                after = linkedItems(text, moved.rect, true).filter(
                  (item) => before.length === 1 && item.str === before[0].str
                )
              if (
                group.length > 1 &&
                textKey(pieces.flatMap((runs) => runs.map((item) => item.str)).join('')) ===
                  annotation.uri &&
                owners.length === 1 &&
                pieces.every((runs) => runs.length === 1) &&
                before.length === 1 &&
                after.length === 1 &&
                (!label || label === textKey(before[0].str)) &&
                Boolean(originalText.styles[before[0].fontName]) &&
                JSON.stringify(originalText.styles[before[0].fontName]) ===
                  JSON.stringify(text.styles[after[0].fontName]) &&
                Math.abs(before[0].width - after[0].width) < 0.01 &&
                before[0].transform
                  .slice(0, 4)
                  .every((value, i) => Math.abs(value - after[0].transform[i]) < 0.01) &&
                [0, 1].every(
                  (axis) =>
                    Math.abs(
                      after[0].transform[4 + axis] -
                        before[0].transform[4 + axis] -
                        moved.rect[axis] +
                        annotation.rect[axis]
                    ) < 0.01
                )
              ) {
                nativeUriOwner = owners[0].unit
                nativeUriLabel = before[0].str
                label = textKey(nativeUriLabel)
              }
            }
            const originalRun = linkedText(originalText, annotation.rect, true)
            const key = pdfLinkLabelKey(label)
            const fragmentLabels = originalRun.includes(label)
              ? []
              : units.flatMap((unit, unitIndex) => {
                  const rawTranslation = runSnapshot.units[unitIndex].translation,
                    translated = textKey(rawTranslation),
                    result: string[] = [],
                    positions: number[] = []
                  // Link extraction omits spaces, but author word boundaries are
                  // part of the saved citation identity. Project only whitespace
                  // removal in already-NFC text; composition has no offset proof.
                  if (rawTranslation.normalize('NFC') === rawTranslation)
                    for (let index = 0; index < rawTranslation.length; index++)
                      if (!/\s/u.test(rawTranslation[index])) positions.push(index)
                  for (
                    let at = translated.indexOf(label);
                    label && at >= 0;
                    at = translated.indexOf(label, at + label.length)
                  ) {
                    const start = positions[at],
                      end = positions[at + label.length - 1],
                      rawLabel =
                        start === undefined || end === undefined
                          ? undefined
                          : rawTranslation.slice(start, end + 1),
                      rawFragment =
                        start !== undefined && rawLabel && textKey(rawLabel) === label
                          ? (translatedPdfLinkFragment(
                              rawTranslation,
                              unit.source,
                              rawLabel,
                              start
                            ) ??
                            translatedPdfLinkLabel(rawTranslation, unit.source, rawLabel, start))
                          : undefined,
                      fragment =
                        rawFragment ??
                        translatedPdfLinkFragment(translated, unit.source, label, at) ??
                        translatedPdfLinkLabel(translated, unit.source, label, at)
                    if (fragment) result.push(textKey(fragment.text))
                  }
                  return result
                })
            const originalLabel = [
              ...new Set(
                [
                  ...originalRun.matchAll(
                    /(?:(?:Table|Tab\.|Figure|Fig\.)\d+|(?:Suppl\.|Supplementary)Appendix|[“”"]\d+)(?![A-Za-z\d]|[.．,，–—−-]\d)/giu
                  )
                ]
                  .filter((match) => key !== null && pdfLinkLabelKey(match[0]) === key)
                  .map((match) => match[0])
                  .concat(
                    units.flatMap((unit) =>
                      pdfLinkLabelMatches(unit.source, label).map((match) => textKey(match[0]))
                    ),
                    fragmentLabels
                  )
              )
            ].filter((candidate) => originalRun.split(candidate).length === 2)
            const sourceLabel =
              originalLabel.length === 1
                ? originalLabel[0]
                : key?.startsWith('panel:')
                  ? label.normalize('NFKC')
                  : label
            // A merged native line may cite the same year more than once. Prove
            // all numeric/panel hit areas together in their source left-to-right order;
            // a missing link, changed year, or swapped distinct label fails closed.
            let repeatedNumericLabel = false
            const referenceNumber = /^\d+(?:\.\d+)*(?:[a-z]|\([A-Za-z]\))?$/u
            // Substrings in quantities/decimals/identifiers are not occurrences
            // of a citation label: the 8 in "80% ... [8]" is a different token.
            const numericTokens = (value: string): RegExpExecArray[] => [
              ...value
                .normalize('NFKC')
                .matchAll(/(?<![A-Za-z\d.])\d+(?:\.\d+)*(?:[a-z]|\([A-Za-z]\))?(?![A-Za-z\d])/gu)
            ]
            const numericOccurrences = referenceNumber.test(sourceLabel)
              ? numericTokens(
                  linkedItems(originalText, annotation.rect, true)
                    .map((item) => item.str)
                    .join('')
                ).filter((match) => match[0] === sourceLabel).length
              : 0
            // A linked number belongs to its full closed citation, not a
            // month elsewhere in this paragraph. Prove its ordinal on the
            // actual translated native row as well as in the saved text.
            const bracketedSources = /^\d{1,4}$/u.test(sourceLabel)
              ? units.filter(
                  (unit, unitIndex) =>
                    !unchanged(unitIndex) &&
                    [
                      ...unit.source.matchAll(
                        /\[\s*\d{1,4}(?:\s*[,，]\s*\d{1,4})*\s*\]|［\s*\d{1,4}(?:\s*[,，]\s*\d{1,4})*\s*］/gu
                      )
                    ].some((block) =>
                      [...block[0].matchAll(/\d+/gu)].some((token) => token[0] === sourceLabel)
                    ) &&
                    unit.fragments.some(
                      (fragment) =>
                        fragment.pageNumber === number &&
                        fragment.items.some((claimed) =>
                          linkedItems(originalText!, annotation.rect, true).some(
                            (item) =>
                              originalText!.items[claimed.index] === item &&
                              textKey(claimed.text) === textKey(item.str)
                          )
                        )
                    )
                )
              : []
            // A year linked inside an author citation must not be reclassified
            // by a pure [2019] elsewhere in the same paragraph. Only a complete
            // source block mapped to this annotation's exact native run applies.
            const nativeBracketedSources = bracketedSources.filter((unit) => {
              const claimed = unit.fragments
                  .filter((fragment) => fragment.pageNumber === number)
                  .flatMap((fragment) => fragment.items),
                sourceItems = [...new Set(claimed.map((part) => part.index))].map(
                  (index) => originalText!.items[index]
                )
              if (
                claimed.some((part) => {
                  const item = originalText!.items[part.index]
                  return !item || !('str' in item) || textKey(part.text) !== textKey(item.str)
                })
              )
                return true
              const native = sourceItems.map((item) => ('str' in item ? item.str : '')).join(''),
                proofs = [
                  ...unit.source.matchAll(
                    /\[\s*\d{1,4}(?:\s*[,，]\s*\d{1,4})*\s*\]|［\s*\d{1,4}(?:\s*[,，]\s*\d{1,4})*\s*］/gu
                  )
                ].flatMap((block) =>
                  [...block[0].matchAll(/\d+/gu)]
                    .filter((token) => token[0] === sourceLabel)
                    .map((token) =>
                      translatedPdfBracketedReference(
                        unit.source,
                        native,
                        sourceLabel,
                        block.index + token.index
                      )
                    )
                )
              // Unproven or changed native source cannot authorize a fallback.
              if (!proofs.length || proofs.some((proof) => !proof)) return true
              const linked = linkedItems(originalText!, annotation.rect, true)
              let cursor = 0
              return sourceItems.some((item) => {
                const start = cursor
                cursor += 'str' in item ? item.str.length : 0
                return (
                  linked.includes(item as TextItem) &&
                  proofs.some(
                    (proof) => start < proof!.targetBlock.end && cursor > proof!.targetBlock.start
                  )
                )
              })
            })
            const bracketedOwners = nativeBracketedSources.filter((unit) => {
              const unitIndex = units.indexOf(unit),
                translation = runSnapshot.units[unitIndex].translation
              const located = (rect: readonly number[], token: string, offset: number): boolean => {
                const linked = linkedItems(text, rect)
                if (!linked.length || textKey(linked.map((item) => item.str).join('')) !== token)
                  return false
                const first = linked[0],
                  within = (item: TextItem, fragment: (typeof unit.fragments)[number]): boolean =>
                    [
                      target.convertToViewportPoint(item.transform[4], item.transform[5]),
                      target.convertToViewportPoint(
                        item.transform[4] + item.width,
                        item.transform[5]
                      )
                    ].every(
                      ([x, y]) =>
                        x >= fragment.rect.x * target.width - 1 &&
                        x <= (fragment.rect.x + fragment.rect.width) * target.width + 1 &&
                        y >= fragment.rect.y * target.height - 1 &&
                        y <= (fragment.rect.y + fragment.rect.height) * target.height + 1
                    ),
                  owners = unit.fragments.filter(
                    (fragment) =>
                      fragment.pageNumber === number &&
                      linked.every((item) => within(item, fragment))
                  )
                if (owners.length !== 1) return false
                const owner = owners[0],
                  row = text.items
                    .flatMap((item) => {
                      if (
                        !('str' in item) ||
                        !item.str.trim() ||
                        item.transform[0] <= 0 ||
                        item.transform[1] !== 0 ||
                        item.transform[2] !== 0
                      )
                        return []
                      return within(item, owner) ? [item] : []
                    })
                    .sort((a, b) =>
                      Math.abs(a.transform[5] - b.transform[5]) >
                      Math.max(a.transform[0], b.transform[0]) * 0.3
                        ? b.transform[5] - a.transform[5]
                        : a.transform[4] - b.transform[4]
                    )
                let cursor = 0
                const spans = row.map((item) => {
                    const start = cursor
                    cursor += textKey(item.str).length
                    return { item, start, end: cursor }
                  }),
                  line = textKey(row.map((item) => item.str).join('')),
                  actual = spans.filter((span) => linked.includes(span.item)),
                  full = translatedPdfBracketedReference(unit.source, translation, token, offset)
                if (actual.length !== linked.length || !full) return false
                const block = textKey(full.targetBlock.text),
                  blockStart =
                    actual[0].start -
                    textKey(translation.slice(full.targetBlock.start, full.start)).length
                if (
                  blockStart < 0 ||
                  line.slice(blockStart, blockStart + block.length) !== block ||
                  actual.at(-1)!.end - actual[0].start !== token.length
                )
                  return false
                const parts = spans.filter(
                  (span) => span.start < blockStart + block.length && span.end > blockStart
                )
                return parts.every((part, index) => {
                  if (!index) return true
                  const previous = parts[index - 1].item,
                    size = Math.max(part.item.transform[0], previous.transform[0]),
                    rise = previous.transform[5] - part.item.transform[5],
                    gap = part.item.transform[4] - previous.transform[4] - previous.width
                  if (Math.abs(rise) <= size * 0.3)
                    return gap >= -first.transform[0] * 0.05 && gap <= first.transform[0] * 0.5
                  // A full native citation may wrap at a comma. Keep it in
                  // this one owned region and prove adjacent row-end/start
                  // geometry; no intervening text may enter the exact block.
                  return (
                    rise >= size * 0.65 &&
                    rise <= size * 1.6 &&
                    /[,，[［]$/u.test(textKey(previous.str)) &&
                    /^[\d\]］]/u.test(textKey(part.item.str)) &&
                    previous.transform[4] + previous.width >=
                      (owner.rect.x + owner.rect.width) * target.width - size * 3 &&
                    Math.abs(part.item.transform[4] - owner.rect.x * target.width) <= size * 0.5
                  )
                })
              }
              const claimed = unit.fragments
                  .filter((f) => f.pageNumber === number)
                  .flatMap((f) => f.items),
                indices = [...new Set(claimed.map((part) => part.index))],
                sourceItems = indices.map((index) => originalText!.items[index])
              if (
                claimed.some((part) => {
                  const item = originalText!.items[part.index]
                  return !item || !('str' in item) || textKey(part.text) !== textKey(item.str)
                })
              )
                return false
              const sourceLine = sourceItems.map((item) => ('str' in item ? item.str : '')).join('')
              for (const occurrence of unit.source.matchAll(
                new RegExp(`(?<!\\d)${sourceLabel}(?!\\d)`, 'gu')
              )) {
                const full = translatedPdfBracketedReference(
                    unit.source,
                    translation,
                    sourceLabel,
                    occurrence.index
                  ),
                  nativeSource = translatedPdfBracketedReference(
                    unit.source,
                    sourceLine,
                    sourceLabel,
                    occurrence.index
                  )
                if (!full || !nativeSource || !located(moved.rect, sourceLabel, occurrence.index))
                  continue
                let cursor = 0
                const owned = sourceItems.filter((item) => {
                    const start = cursor
                    cursor += 'str' in item ? item.str.length : 0
                    return (
                      start < nativeSource.targetBlock.end &&
                      cursor > nativeSource.targetBlock.start
                    )
                  }),
                  // One merged native line can contain the same complete
                  // citation twice. Prove all linked blocks in that run together;
                  // the full helper keeps their occurrence and numeric ordinals.
                  tokens = [
                    ...unit.source.matchAll(
                      /\[\s*\d{1,4}(?:\s*[,，]\s*\d{1,4})*\s*\]|［\s*\d{1,4}(?:\s*[,，]\s*\d{1,4})*\s*］/gu
                    )
                  ].flatMap((block) => {
                    const first = [...block[0].matchAll(/\d+/gu)][0],
                      proof = translatedPdfBracketedReference(
                        unit.source,
                        sourceLine,
                        first[0],
                        block.index + first.index
                      )
                    if (!proof) return []
                    const nativeDigits = [...proof.targetBlock.text.matchAll(/\d+/gu)]
                    let cursor = 0
                    const sharedRun = sourceItems.some((item) => {
                      const start = cursor
                      cursor += 'str' in item ? item.str.length : 0
                      return (
                        owned.includes(item) &&
                        // A run may close one citation and open another. Sharing
                        // only its delimiter does not share the numeric identity.
                        nativeDigits.some(
                          (digit) =>
                            start < proof.targetBlock.start + digit.index + digit[0].length &&
                            cursor > proof.targetBlock.start + digit.index
                        )
                      )
                    })
                    return sharedRun
                      ? [...block[0].matchAll(/\d+/gu)].map((token) => ({
                          label: token[0],
                          offset: block.index + token.index,
                          blockKey: [...block[0].matchAll(/\d+/gu)].map((part) => part[0]).join(',')
                        }))
                      : []
                  }),
                  group = sourceAnnotations
                    .flatMap((candidate, position) => {
                      if (
                        !linkedItems(originalText!, candidate.rect, true).some((item) =>
                          owned.includes(item)
                        )
                      )
                        return []
                      const label = linkedText(text, targetAnnotations[position].rect),
                        targetItems = linkedItems(text, targetAnnotations[position].rect),
                        sourceItem = linkedItems(originalText!, candidate.rect, true).find((item) =>
                          owned.includes(item)
                        )!
                      return tokens.some(
                        (token) =>
                          token.label === label &&
                          located(targetAnnotations[position].rect, label, token.offset)
                      )
                        ? [
                            {
                              label,
                              rect: candidate.rect,
                              sourceItem,
                              targetFirst: targetItems[0],
                              targetLast: targetItems.at(-1)!
                            }
                          ]
                        : []
                    })
                    .sort((a, b) =>
                      Math.abs(a.sourceItem.transform[5] - b.sourceItem.transform[5]) >
                      Math.max(a.sourceItem.transform[0], b.sourceItem.transform[0]) * 0.3
                        ? b.sourceItem.transform[5] - a.sourceItem.transform[5]
                        : a.rect[0] - b.rect[0]
                    )
                if (
                  group.length === tokens.length &&
                  group.every((member, index) => {
                    // Separate complete citations can change order with prose;
                    // the numeric vector and repeated ordinal of one identity
                    // still follow their source-native action group exactly.
                    const previous =
                      group[
                        tokens
                          .slice(0, index)
                          .findLastIndex((token) => token.blockKey === tokens[index].blockKey)
                      ]
                    return (
                      member.label === tokens[index].label &&
                      (!previous ||
                        member.targetFirst.transform[5] <
                          previous.targetLast.transform[5] -
                            member.targetFirst.transform[0] * 0.3 ||
                        (Math.abs(
                          member.targetFirst.transform[5] - previous.targetLast.transform[5]
                        ) <=
                          member.targetFirst.transform[0] * 0.3 &&
                          member.targetFirst.transform[4] >=
                            previous.targetLast.transform[4] +
                              previous.targetLast.width -
                              member.targetFirst.transform[0] * 0.05))
                    )
                  })
                )
                  return true
              }
              return false
            })
            if (nativeBracketedSources.length && bracketedOwners.length !== 1)
              throw validationError('PDF link left its closed numeric citation')
            // A raised native reference list can directly follow a name,
            // NumPy¹,². Joining it with the body erases the numeric boundary.
            // Prove its complete native run and one owning paragraph instead.
            const nativeReferences = linkedItems(originalText, annotation.rect, true).filter(
              (item) => {
                const list = textKey(item.str).normalize('NFKC')
                if (!referenceNumber.test(sourceLabel) || !/^\d+(?:[,–−-]\d+)+$/u.test(list))
                  return false
                return (
                  units.filter((unit, unitIndex) => {
                    if (
                      textKey(unit.source).normalize('NFKC').split(list).length !== 2 ||
                      textKey(runSnapshot.units[unitIndex].translation)
                        .normalize('NFKC')
                        .split(list).length !== 2
                    )
                      return false
                    return unit.fragments.some(
                      (fragment) =>
                        fragment.pageNumber === number &&
                        fragment.items.some(
                          (claimed) =>
                            originalText!.items[claimed.index] === item &&
                            textKey(claimed.text) === textKey(item.str)
                        ) &&
                        fragment.items.some((claimed) => {
                          const body = originalText!.items[claimed.index]
                          return (
                            body &&
                            'str' in body &&
                            body.transform[0] > 0 &&
                            body.transform[1] === 0 &&
                            body.transform[2] === 0 &&
                            item.transform[0] > body.transform[0] * 0.3 &&
                            item.transform[0] < body.transform[0] * 0.85 &&
                            item.transform[1] === 0 &&
                            item.transform[2] === 0 &&
                            item.transform[5] - body.transform[5] > body.transform[0] * 0.1 &&
                            item.transform[5] - body.transform[5] < body.transform[0] * 0.5
                          )
                        })
                    )
                  }).length === 1
                )
              }
            )
            if (numericOccurrences > 1 || nativeReferences.length === 1) {
              // Top-origin equation operators may cross the line's hit area
              // despite belonging to a neighboring formula. They cannot contain
              // a numeric label; their native geometry is verified separately.
              const originals =
                nativeReferences.length === 1
                  ? nativeReferences
                  : linkedItems(originalText, annotation.rect, true).filter(
                      (item) => !/^[√∛∜∫∑∏]$/u.test(item.str.trim())
                    )
              if (
                originals.length === 1 &&
                originals[0].transform[0] > 0 &&
                originals[0].transform[1] === 0
              ) {
                const yearLabel = /^\d{4}[a-z]?$/u.test(sourceLabel)
                const numbers = numericTokens(originals[0].str)
                  // A native line can include an unlinked prose list marker
                  // between citations: (..., 2041), (3) another method (..., 2041).
                  // Only exclude that explicit list syntax; every repeated year
                  // still requires its own unchanged, ordered link below.
                  .filter((match) => {
                    // Plain quantities in the same line are not dated citations.
                    if (yearLabel && !/^\d{4}[a-z]?$/u.test(match[0])) return false
                    const before = originals[0].str.slice(0, match.index),
                      after = originals[0].str.slice(match.index + match[0].length)
                    return !(
                      /^\d{1,2}$/u.test(match[0]) &&
                      /(?:^|[,;])\s*(?:and\s+)?\($/u.test(before) &&
                      /^\)\s+[a-z]/u.test(after)
                    )
                  })
                  .map((match) => match[0])
                const group = sourceAnnotations
                  .flatMap((candidate, position) => {
                    const items = linkedItems(originalText!, candidate.rect, true)
                        .filter((item) => !/^[√∛∜∫∑∏]$/u.test(item.str.trim()))
                        .filter(
                          (item) => nativeReferences.length !== 1 || item === nativeReferences[0]
                        ),
                      targetLabel = linkedText(text, targetAnnotations[position].rect).normalize(
                        'NFKC'
                      )
                    return items.length === 1 &&
                      items[0] === originals[0] &&
                      referenceNumber.test(targetLabel) &&
                      (!yearLabel || /^\d{4}[a-z]?$/u.test(targetLabel))
                      ? [{ rect: candidate.rect, label: targetLabel }]
                      : []
                  })
                  .sort((a, b) => a.rect[0] - b.rect[0])
                repeatedNumericLabel =
                  group.length === numbers.length &&
                  group.every(
                    (candidate, position) =>
                      candidate.label === numbers[position] &&
                      (position === 0 || candidate.rect[0] >= group[position - 1].rect[2] - 1)
                  )
              }
            }
            // Appendix letters may also occur inside acronyms in a merged line
            // (Appendix A ... CIFAR). Require the same unique typed reference.
            const typedAppendix = (value: string): number =>
              /^[A-Z]$/u.test(sourceLabel)
                ? [
                    ...value.matchAll(
                      new RegExp(
                        '(?:\\bappendix\\s*|附[录錄]\\s*)' + sourceLabel + '(?![A-Za-z\\d])',
                        'giu'
                      )
                    )
                  ].length
                : 0
            const appendixLetter =
              typedAppendix(
                linkedItems(originalText, annotation.rect, true)
                  .map((item) => item.str)
                  .join(' ')
              ) === 1 &&
              units.some(
                (unit, unitIndex) =>
                  typedAppendix(unit.source) === 1 &&
                  typedAppendix(runSnapshot.units[unitIndex].translation) === 1 &&
                  unit.fragments.some(
                    (fragment) =>
                      fragment.pageNumber === number &&
                      annotation.rect[0] >= fragment.rect.x * source.width - 2 &&
                      annotation.rect[2] <=
                        (fragment.rect.x + fragment.rect.width) * source.width + 2 &&
                      source.height - annotation.rect[3] >= fragment.rect.y * source.height - 2 &&
                      source.height - annotation.rect[1] <=
                        (fragment.rect.y + fragment.rect.height) * source.height + 2
                  )
              )
            // Some publishers link only the digit in a parenthesized figure
            // panel, while PDF.js merges "Figure 2(a)" into the whole prose run.
            // A bare digit is not enough: prove the complete unchanged panel,
            // its occurrence count and the same unique source paragraph.
            const panelNumber =
              /^\d+$/u.test(sourceLabel) &&
              (() => {
                const panels = (value: string): RegExpExecArray[] => [
                    ...value.matchAll(
                      /(?:\b(?:Figure|Fig\.?)\s*|[图圖]\s*)(\d+)[（(]\s*([A-Za-z])\s*[)）](?![A-Za-z\d])/gu
                    )
                  ],
                  originals = panels(
                    linkedItems(originalText!, annotation.rect, true)
                      .map((item) => item.str)
                      .join(' ')
                  ).filter((match) => match[1] === sourceLabel)
                if (originals.length !== 1) return false
                const owners = units.filter((unit, unitIndex) => {
                  const matches = panels(unit.source).filter(
                    (match) => match[1] === sourceLabel && match[2] === originals[0][2]
                  )
                  if (matches.length !== 1) return false
                  const match = matches[0],
                    at = match.index + match[0].indexOf(sourceLabel),
                    target = translatedPdfLinkFragment(
                      unit.source,
                      runSnapshot.units[unitIndex].translation,
                      sourceLabel,
                      at
                    )
                  return (
                    target?.text === label &&
                    unit.fragments.some(
                      (fragment) =>
                        fragment.pageNumber === number &&
                        annotation.rect[0] >= fragment.rect.x * source.width - 2 &&
                        annotation.rect[2] <=
                          (fragment.rect.x + fragment.rect.width) * source.width + 2 &&
                        source.height - annotation.rect[3] >= fragment.rect.y * source.height - 2 &&
                        source.height - annotation.rect[1] <=
                          (fragment.rect.y + fragment.rect.height) * source.height + 2
                    )
                  )
                })
                return owners.length === 1
              })()
            const containedSourceItems = linkedItems(originalText, annotation.rect).filter(
              (item) => !referenceNumber.test(sourceLabel) || !/^[√∛∜∫∑∏]$/u.test(item.str.trim())
            )
            const originalExactLabel = textKey(
              containedSourceItems.map((item) => latinAccentText.get(item) ?? item.str).join('')
            )
            // Detached accents or range dashes can split a native link between
            // larger PDF.js prose runs. Every fully contained run must belong
            // to the same unique complete author or numeric range/list span.
            const labelStart = originalRun.indexOf(sourceLabel)
            let sourceOffset = 0
            const partialRangeLabel = /^\d+(?:[,–−-]\d+)+$/u.test(sourceLabel)
            const partialSourceLabel =
              Boolean(originalExactLabel) &&
              (key?.startsWith('authors:') ||
                partialRangeLabel ||
                (latinAccentText.size > 0 && /^[A-Za-zÀ-ÖØ-öø-ÿ]+$/u.test(sourceLabel))) &&
              originalRun.split(sourceLabel).length === 2 &&
              linkedItems(originalText, annotation.rect, true).every((item) => {
                const start = sourceOffset
                sourceOffset += textKey(latinAccentText.get(item) ?? item.str).length
                return (
                  !containedSourceItems.includes(item) ||
                  (start >= labelStart && sourceOffset <= labelStart + sourceLabel.length)
                )
              })
            const literalLabel = (
              nativeUriLabel ||
              linkedItems(text, moved.rect)
                .map((item) => item.str)
                .join('')
            )
              .replace(/\s+/gu, ' ')
              .trim()
            // A wrapped URI can share its short label, such as "https://", with
            // another address. Prove its complete original action and exact
            // native source interval before assigning the translated fragment.
            const wrappedUriOwners = new Set<(typeof units)[number]>()
            const uriFragment = (unit: (typeof units)[number], unitIndex: number): boolean => {
              if (
                !annotation.uri ||
                !literalLabel ||
                unit.fragments.some((f) => f.pageNumber !== number)
              )
                return false
              const translation = runSnapshot.units[unitIndex].translation,
                same = (item: { text: string }): boolean =>
                  item.text.replace(/ /gu, '') === annotation.uri,
                from = pdfLinkAddressMatches(unit.source).filter(same),
                to = pdfLinkAddressMatches(translation).filter(same)
              if (from.length !== 1 || to.length !== 1) return false
              const indices = [
                  ...new Set(
                    unit.fragments.flatMap((fragment) => fragment.items.map((item) => item.index))
                  )
                ],
                native = indices.map((index) => originalText!.items[index])
              if (
                native.some((item) => !item || !('str' in item)) ||
                unit.fragments.some((fragment) =>
                  fragment.items.some((claimed) => {
                    const item = originalText!.items[claimed.index]
                    return !item || !('str' in item) || textKey(claimed.text) !== textKey(item.str)
                  })
                )
              )
                return false
              let cursor = 0
              const spans = native.map((item) => {
                  const start = cursor
                  cursor += textKey('str' in item ? item.str : '').length
                  return { item, start, end: cursor, nativeStart: start, nativeEnd: cursor }
                }),
                nativeLiteral = native.map((item) => ('str' in item ? item.str : '')).join(''),
                nativeText = textKey(nativeLiteral),
                removed = new Set<number>()
              if (nativeText !== textKey(unit.source)) {
                // Only the full original action can prove a layout hyphen inside
                // its URI. Require adjacent native rows in this same fragment;
                // semantic hyphens remain literal characters of that action.
                const breaks = new Set<number>()
                for (let i = 0; i + 1 < native.length; i++) {
                  const before = native[i],
                    after = native[i + 1]
                  if (!('str' in before) || !('str' in after)) continue
                  const size = before.transform[0],
                    dy = before.transform[5] - after.transform[5]
                  if (
                    /[A-Za-z\d]-$/u.test(before.str.trimEnd()) &&
                    /^[A-Za-z\d]/u.test(after.str.trimStart()) &&
                    before.hasEOL === true &&
                    indices[i + 1] === indices[i] + 1 &&
                    before.fontName &&
                    before.fontName === after.fontName &&
                    [before, after].every(
                      (part) =>
                        part.transform[0] > 0 &&
                        part.transform[1] === 0 &&
                        part.transform[2] === 0 &&
                        Math.abs(part.transform[3] - size) < size * 0.05
                    ) &&
                    Math.abs(size - after.transform[0]) < size * 0.05 &&
                    dy > size * 0.8 &&
                    dy < size * 1.8 &&
                    Math.abs(before.transform[4] - after.transform[4]) < size * 0.3 &&
                    unit.fragments.some(
                      (fragment) =>
                        fragment.items.some((part) => part.index === indices[i]) &&
                        fragment.items.some((part) => part.index === indices[i + 1])
                    )
                  )
                    breaks.add(spans[i].end - 1)
                }
                const addresses = pdfLinkAddressMatches(nativeLiteral).flatMap((rawAddress) => {
                  const address = {
                    text: textKey(rawAddress.text),
                    index: textKey(nativeLiteral.slice(0, rawAddress.index)).length
                  }
                  let at = 0
                  const skipped: number[] = []
                  for (let i = 0; i < address.text.length; i++) {
                    const char = address.text[i]
                    if (char === annotation.uri![at]) at++
                    else if (char === '-' && breaks.has(address.index + i))
                      skipped.push(address.index + i)
                    else return []
                  }
                  return at === annotation.uri!.length && skipped.length ? [skipped] : []
                })
                if (addresses.length !== 1) return false
                for (const at of addresses[0]) removed.add(at)
                if (
                  nativeText
                    .split('')
                    .filter((_, at) => !removed.has(at))
                    .join('') !== textKey(unit.source)
                )
                  return false
                for (const span of spans) {
                  const start = span.start,
                    end = span.end
                  span.start -= [...removed].filter((at) => at < start).length
                  span.end -= [...removed].filter((at) => at < end).length
                }
              }
              const linked = linkedItems(originalText!, annotation.rect, true),
                candidates: number[] = []
              for (
                let at = to[0].text.indexOf(literalLabel);
                at >= 0;
                at = to[0].text.indexOf(literalLabel, at + literalLabel.length)
              ) {
                const mapped = translatedPdfLinkFragment(
                  translation,
                  unit.source,
                  literalLabel,
                  to[0].index + at
                )
                if (
                  !mapped ||
                  mapped.start < from[0].index ||
                  mapped.start + mapped.text.length > from[0].index + from[0].text.length
                )
                  continue
                const start = textKey(unit.source.slice(0, mapped.start)).length,
                  end = start + textKey(mapped.text).length,
                  owned = spans.filter((span) => span.start < end && span.end > start)
                const nativeEdge =
                  removed.size > 0 &&
                  owned.some((span) => {
                    if (!('str' in span.item)) return false
                    const item = span.item,
                      pointY = item.transform[5] + item.transform[0] * 0.3
                    return (
                      pointY >= annotation.rect[1] - 1 &&
                      pointY <= annotation.rect[3] + 1 &&
                      ((end === span.end &&
                        removed.has(span.nativeEnd - 1) &&
                        /-$/u.test(item.str.trimEnd()) &&
                        Math.abs(item.transform[4] + item.width - annotation.rect[2]) <
                          item.transform[0] * 0.1) ||
                        (start === span.start &&
                          removed.has(span.nativeStart - 1) &&
                          Math.abs(item.transform[4] - annotation.rect[0]) <
                            item.transform[0] * 0.1))
                    )
                  })
                if (
                  owned.length &&
                  owned.every((span) => 'str' in span.item && linked.includes(span.item)) &&
                  (removed.size ? nativeEdge : originalRun.split(textKey(mapped.text)).length === 2)
                )
                  candidates.push(at)
              }
              if (candidates.length === 1 && removed.size) wrappedUriOwners.add(unit)
              return candidates.length === 1
            }
            // A merged row may repeat one author/year identity in linked and
            // unlinked prose. A complete native closed citation and its two
            // original actions prove the label; a repeated author or year alone
            // does not. Every occurrence must retain this same dated identity.
            const repeatedDatedOwners =
              sourceLabel === label && originalRun.split(sourceLabel).length > 2
                ? units.filter((unit, unitIndex) => {
                    if (unchanged(unitIndex) || !originalText) return false
                    const claimed = unit.fragments
                        .filter((fragment) => fragment.pageNumber === number)
                        .flatMap((fragment) => fragment.items),
                      native = claimed.map((part) => originalText!.items[part.index])
                    if (
                      !claimed.length ||
                      claimed.some(
                        (part, index) =>
                          !native[index] ||
                          !('str' in native[index]) ||
                          (native[index] as TextItem).str !== part.text
                      )
                    )
                      return false
                    const group = sourceAnnotations.flatMap((part, position) => {
                      if (part.key !== annotation.key) return []
                      const before = linkedItems(originalText!, part.rect, true),
                        after = linkedItems(text, targetAnnotations[position].rect)
                      return before.length &&
                        before.every((item) => native.includes(item)) &&
                        after.length === 1
                        ? [{ position, glyph: after[0] }]
                        : []
                    })
                    if (group.length < 2 || !group.some((part) => part.position === index))
                      return false
                    const current = group.find((part) => part.position === index)!,
                      author = pdfLinkLabelKey(current.glyph.str)?.startsWith('authors:')
                        ? current
                        : group
                            .filter(
                              (part) =>
                                pdfLinkLabelKey(part.glyph.str)?.startsWith('authors:') &&
                                part.glyph.transform[4] < current.glyph.transform[4] &&
                                Math.abs(part.glyph.transform[5] - current.glyph.transform[5]) <=
                                  current.glyph.transform[0] * 0.3
                            )
                            .sort((a, b) => b.glyph.transform[4] - a.glyph.transform[4])[0],
                      year = /^\d{4}[a-z]?$/u.test(current.glyph.str)
                        ? current
                        : group
                            .filter(
                              (part) =>
                                /^\d{4}[a-z]?$/u.test(part.glyph.str) &&
                                part.glyph.transform[4] > current.glyph.transform[4] &&
                                Math.abs(part.glyph.transform[5] - current.glyph.transform[5]) <=
                                  current.glyph.transform[0] * 0.3
                            )
                            .sort((a, b) => a.glyph.transform[4] - b.glyph.transform[4])[0]
                    if (!author || !year) return false
                    const complete = `${author.glyph.str}, ${year.glyph.str}`,
                      identity = pdfLinkLabelKey(complete),
                      from = pdfLinkLabelMatches(unit.source, complete),
                      to = pdfLinkLabelMatches(runSnapshot.units[unitIndex].translation, complete),
                      names = pdfLinkLabelMatches(unit.source, author.glyph.str),
                      years = numericTokens(unit.source).filter(
                        (match) => match[0] === year.glyph.str
                      )
                    if (
                      !identity?.startsWith('dated-authors:') ||
                      from.length < 2 ||
                      from.length !== to.length ||
                      names.length !== from.length ||
                      years.length !== from.length ||
                      group.length !== from.length * 2 ||
                      group.filter(
                        (part) =>
                          pdfLinkLabelKey(part.glyph.str) === pdfLinkLabelKey(author.glyph.str)
                      ).length !== from.length ||
                      group.filter((part) => part.glyph.str === year.glyph.str).length !==
                        from.length ||
                      Math.abs(author.glyph.transform[5] - year.glyph.transform[5]) >
                        Math.max(author.glyph.transform[0], year.glyph.transform[0]) * 0.3
                    )
                      return false
                    return unit.fragments.some((fragment) => {
                      if (fragment.pageNumber !== number) return false
                      const inside = (item: TextItem): boolean =>
                        [
                          target.convertToViewportPoint(item.transform[4], item.transform[5]),
                          target.convertToViewportPoint(
                            item.transform[4] + item.width,
                            item.transform[5]
                          )
                        ].every(
                          ([x, y]) =>
                            x >= fragment.rect.x * target.width - 1 &&
                            x <= (fragment.rect.x + fragment.rect.width) * target.width + 1 &&
                            y >= fragment.rect.y * target.height - 1 &&
                            y <= (fragment.rect.y + fragment.rect.height) * target.height + 1
                        )
                      if (![author.glyph, year.glyph].every(inside)) return false
                      const row = text.items
                          .flatMap((item) =>
                            'str' in item &&
                            item.str.trim() &&
                            inside(item) &&
                            item.transform[0] > 0 &&
                            item.transform[1] === 0 &&
                            item.transform[2] === 0 &&
                            Math.abs(item.transform[5] - author.glyph.transform[5]) <=
                              Math.max(item.transform[0], author.glyph.transform[0]) * 0.3
                              ? [item]
                              : []
                          )
                          .sort((a, b) => a.transform[4] - b.transform[4]),
                        at = row.indexOf(author.glyph),
                        end = row.indexOf(year.glyph),
                        between = textKey(
                          row
                            .slice(at + 1, end)
                            .map((item) => item.str)
                            .join('')
                        )
                      return (
                        at > 0 &&
                        end > at &&
                        ((/[(（]\s*$/u.test(row[at - 1].str) && /^[,，]$/u.test(between)) ||
                          /^[（(]$/u.test(between)) &&
                        /^[)）]/u.test(row[end + 1]?.str ?? '') &&
                        row.slice(at, end + 2).every((item, position, parts) => {
                          if (!position) return true
                          const previous = parts[position - 1],
                            gap = item.transform[4] - previous.transform[4] - previous.width
                          return gap >= -0.001 && gap <= item.transform[0] * 1.5
                        })
                      )
                    })
                  })
                : []
            const verifiedRepeatedDated = repeatedDatedOwners.length === 1
            // A wrapped author citation can start a merged row with "et al."
            // and repeat those words later in that row. Bind this exact native
            // prefix to all three unchanged author/collective/year hit areas;
            // a repeated substring alone never proves its destination.
            const collectiveOwners =
              label === 'etal.'
                ? units.filter((unit, unitIndex) => {
                    if (unchanged(unitIndex) || !originalText) return false
                    const before = linkedItems(originalText, annotation.rect, true),
                      after = linkedItems(text, moved.rect),
                      group = sourceAnnotations
                        .flatMap((part, position) => {
                          const saved = targetAnnotations[position],
                            glyphs = linkedItems(text, saved.rect)
                          return part.key === annotation.key &&
                            sameCoordinates(
                              part.destinationCoordinates,
                              annotation.destinationCoordinates
                            ) &&
                            saved.key === part.key &&
                            sameCoordinates(
                              saved.destinationCoordinates,
                              part.destinationCoordinates
                            ) &&
                            glyphs.length === 1
                            ? [{ part, saved, glyph: glyphs[0], label: glyphs[0].str.trim() }]
                            : []
                        })
                        .sort((a, b) =>
                          Math.abs(a.part.rect[1] - b.part.rect[1]) > 2
                            ? b.part.rect[1] - a.part.rect[1]
                            : a.part.rect[0] - b.part.rect[0]
                        )
                    if (
                      before.length !== 1 ||
                      after.length !== 1 ||
                      group.length !== 3 ||
                      !before[0].str.trimStart().startsWith('et al.') ||
                      group[1].part !== annotation ||
                      !/^[A-Z][A-Za-z .’'-]*$/u.test(group[0].label) ||
                      group[1].label !== 'et al.' ||
                      !/^\d{4}[a-z]?$/u.test(group[2].label) ||
                      !originalText.styles[before[0].fontName] ||
                      JSON.stringify(originalText.styles[before[0].fontName]) !==
                        JSON.stringify(text.styles[after[0].fontName]) ||
                      before[0].transform
                        .slice(0, 4)
                        .some(
                          (value, axis) => Math.abs(value - after[0].transform[axis]) >= 0.001
                        ) ||
                      [0, 1].some(
                        (axis) =>
                          Math.abs(
                            after[0].transform[4 + axis] -
                              before[0].transform[4 + axis] -
                              moved.rect[axis] +
                              annotation.rect[axis]
                          ) >= 0.001
                      )
                    )
                      return false
                    const authorBefore = linkedItems(originalText, group[0].part.rect, true),
                      authorAfter = group[0].glyph
                    // The author hit area must own this exact native suffix, rather
                    // than another name elsewhere in the same complete paragraph.
                    if (
                      authorBefore.length !== 1 ||
                      authorBefore[0].str.split(group[0].label).length !== 2 ||
                      !authorBefore[0].str.endsWith(group[0].label) ||
                      !/[\s(]/u.test(
                        authorBefore[0].str.slice(
                          -group[0].label.length - 1,
                          -group[0].label.length
                        )
                      ) ||
                      JSON.stringify(originalText.styles[authorBefore[0].fontName]) !==
                        JSON.stringify(text.styles[authorAfter.fontName]) ||
                      authorBefore[0].transform
                        .slice(0, 4)
                        .some(
                          (value, axis) => Math.abs(value - authorAfter.transform[axis]) >= 0.001
                        ) ||
                      Math.abs(
                        authorBefore[0].transform[4] + authorBefore[0].width - group[0].part.rect[2]
                      ) >
                        authorBefore[0].transform[0] * 0.2 ||
                      Math.abs(
                        authorAfter.transform[4] +
                          authorAfter.width -
                          authorBefore[0].transform[4] -
                          authorBefore[0].width -
                          group[0].saved.rect[0] +
                          group[0].part.rect[0]
                      ) >= 0.001
                    )
                      return false
                    const author = group[0].label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'),
                      citation = new RegExp(
                        '\\(' + author + '\\s+et\\s+al\\.,\\s*' + group[2].label + '\\)',
                        'gu'
                      ),
                      sourceMatches = [...unit.source.matchAll(citation)],
                      targetMatches = [
                        ...runSnapshot.units[unitIndex].translation.matchAll(citation)
                      ],
                      claimed = unit.fragments
                        .filter((fragment) => fragment.pageNumber === number)
                        .flatMap((fragment) => fragment.items),
                      native = [...new Set(claimed.map((part) => part.index))].map(
                        (position) => originalText!.items[position]
                      )
                    if (
                      sourceMatches.length !== 1 ||
                      targetMatches.length !== 1 ||
                      unit.fragments.some((fragment) => fragment.pageNumber !== number) ||
                      claimed.some(
                        (part) =>
                          !originalText!.items[part.index] ||
                          !('str' in originalText!.items[part.index]) ||
                          (originalText!.items[part.index] as TextItem).str !== part.text
                      ) ||
                      !before.every((glyph) => native.includes(glyph)) ||
                      group.some(
                        ({ part, glyph }) =>
                          !linkedItems(originalText!, part.rect, true).every((item) =>
                            native.includes(item)
                          ) ||
                          !unit.fragments.some((fragment) => {
                            const [x, y] = target.convertToViewportPoint(
                              glyph.transform[4],
                              glyph.transform[5]
                            )
                            return (
                              x >= fragment.rect.x * target.width - 1 &&
                              x + glyph.width <=
                                (fragment.rect.x + fragment.rect.width) * target.width + 1 &&
                              y >= fragment.rect.y * target.height - 1 &&
                              y <= (fragment.rect.y + fragment.rect.height) * target.height + 1
                            )
                          })
                      )
                    )
                      return false
                    // The three target parts must remain adjacent in their one dated
                    // citation. Only the comma/space gap can separate native pieces.
                    return group.every(({ glyph }, position) => {
                      if (!position) return true
                      const previous = group[position - 1].glyph,
                        dy = previous.transform[5] - glyph.transform[5]
                      if (dy < -0.001 || dy > glyph.transform[0] * 1.8) return false
                      if (dy <= glyph.transform[0] * 0.3) {
                        const gap = glyph.transform[4] - previous.transform[4] - previous.width
                        return (
                          gap >= -0.001 &&
                          gap <= glyph.transform[0] * 1.5 &&
                          text.items.every(
                            (item) =>
                              !('str' in item) ||
                              Math.abs(item.transform[5] - glyph.transform[5]) > 0.001 ||
                              item.transform[4] < previous.transform[4] + previous.width - 0.001 ||
                              item.transform[4] + item.width > glyph.transform[4] + 0.001 ||
                              /^[\s,，]*$/u.test(item.str)
                          )
                        )
                      }
                      return false
                    })
                  })
                : []
            const collectiveBefore = linkedItems(originalText, annotation.rect, true),
              collectiveAfter = linkedItems(text, moved.rect)
            const verifiedCollective =
              collectiveOwners.length === 1 &&
              (await verifiedNativePrefixInk(
                collectiveBefore[0],
                collectiveAfter[0],
                sourcePage,
                translatedPage,
                originalText.styles[collectiveBefore[0].fontName]
              ))
            const uriOwners = units.filter(
              (unit, unitIndex) =>
                !unchanged(unitIndex) && (unit === nativeUriOwner || uriFragment(unit, unitIndex))
            )
            const verifiedUri =
              uriOwners.length === 1 &&
              (uriOwners[0] === nativeUriOwner || wrappedUriOwners.has(uriOwners[0]))
            if (
              !label ||
              (nativeReferences.length === 1 && !repeatedNumericLabel && !verifiedRepeatedDated) ||
              (!verifiedUri &&
                !verifiedCollective &&
                !verifiedRepeatedDated &&
                (originalExactLabel
                  ? originalExactLabel.normalize('NFKC') !== sourceLabel.normalize('NFKC') &&
                    !partialSourceLabel &&
                    !repeatedNumericLabel
                  : (referenceNumber.test(sourceLabel)
                      ? numericOccurrences !== 1
                      : originalRun.split(sourceLabel).length !== 2) &&
                    !repeatedNumericLabel &&
                    !appendixLetter &&
                    !panelNumber)) ||
              (!verifiedUri &&
                !verifiedCollective &&
                sourceLabel !== label &&
                !fragmentLabels.includes(sourceLabel) &&
                (!key || pdfLinkLabelKey(sourceLabel) !== key))
            )
              throw validationError('PDF link label changed')
            const owners = units.filter(
              (unit, unitIndex) =>
                !unchanged(unitIndex) &&
                (!verifiedUri || uriOwners.includes(unit)) &&
                (!verifiedCollective || collectiveOwners.includes(unit)) &&
                (!verifiedRepeatedDated || repeatedDatedOwners.includes(unit)) &&
                (!nativeBracketedSources.length || bracketedOwners.includes(unit)) &&
                textKey(unit.source).includes(sourceLabel) &&
                textKey(runSnapshot.units[unitIndex].translation).includes(label) &&
                (!partialRangeLabel ||
                  !partialSourceLabel ||
                  (textKey(unit.source).split(sourceLabel).length === 2 &&
                    textKey(runSnapshot.units[unitIndex].translation).split(label).length === 2)) &&
                (key !== null ||
                  fragmentLabels.includes(sourceLabel) ||
                  uriOwners.includes(unit) ||
                  (/^[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ .&'’−-]*$/u.test(literalLabel) &&
                    (() => {
                      const spelling = literalLabel
                          .replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
                          .replaceAll(' ', '\\s+'),
                        pattern = new RegExp(`(?<![A-Za-z])${spelling}(?![A-Za-z])`, 'gu'),
                        count = [...unit.source.matchAll(pattern)].length
                      const translation = runSnapshot.units[unitIndex].translation
                      return (
                        (count > 0 && count === [...translation.matchAll(pattern)].length) ||
                        (/^[a-z]$/u.test(sourceLabel) &&
                          translatedPdfLinkFragment(
                            unit.source,
                            translation,
                            sourceLabel,
                            unit.source.lastIndexOf(sourceLabel)
                          )?.text === literalLabel) ||
                        [...unit.source.matchAll(pattern)].some((match) => {
                          const citation = translatedPdfLinkLabel(
                            unit.source,
                            translation,
                            match[0],
                            match.index
                          )
                          return citation !== null && textKey(citation.text) === label
                        })
                      )
                    })()) ||
                  /^(?:\[\d+(?:[,–-]\d+)*\]|[\d,.;:–−-]+)$/u.test(label) ||
                  (/^\d{4}[a-z]$/u.test(label) &&
                    (() => {
                      const occurrences = [
                        ...unit.source.matchAll(
                          new RegExp(`(?<![A-Za-z\\d])${label}(?![A-Za-z\\d])`, 'gu')
                        )
                      ]
                      return (
                        occurrences.length > 0 &&
                        occurrences.every(
                          (match) =>
                            translatedPdfLinkFragment(
                              unit.source,
                              runSnapshot.units[unitIndex].translation,
                              label,
                              match.index
                            )?.text === label
                        )
                      )
                    })()) ||
                  (textKey(unit.source).split(label).length === 2 &&
                    textKey(runSnapshot.units[unitIndex].translation).split(label).length === 2)) &&
                unit.fragments.some((fragment) => {
                  if (fragment.pageNumber !== number) return false
                  const contained = [
                    [annotation.rect, source],
                    [moved.rect, target]
                  ].every(([rect, viewport], position) => {
                    const box = rect as readonly number[],
                      view = viewport as typeof target,
                      corners = [
                        view.convertToViewportPoint(box[0], box[1]),
                        view.convertToViewportPoint(box[2], box[3])
                      ]
                    // Translation can reorder a link between fragments of the
                    // same paragraph on this page. Its source owner, label and
                    // action must still pass their independent checks.
                    return (position === 0 ? [fragment] : unit.fragments).some(
                      ({ pageNumber, rect: region }) =>
                        pageNumber === number &&
                        corners.every(
                          ([x, y]) =>
                            x >= region.x * view.width - 2 &&
                            x <= (region.x + region.width) * view.width + 2 &&
                            y >= region.y * view.height - 2 &&
                            y <= (region.y + region.height) * view.height + 2
                        )
                    )
                  })
                  if (contained) return true
                  // Some publishers give one citation a taller hit area than its
                  // text line. Keep only that existing vertical envelope, with
                  // the linked text still owned by this same unique paragraph.
                  if (source.rotation !== 0 || target.rotation !== 0) return false
                  const r = fragment.rect,
                    left = r.x * source.width,
                    right = (r.x + r.width) * source.width,
                    bottom = source.height * (1 - r.y - r.height),
                    top = source.height * (1 - r.y),
                    originalBox = annotation.rect,
                    movedBox = moved.rect,
                    centerY = (originalBox[1] + originalBox[3]) / 2
                  if (
                    centerY < bottom ||
                    centerY > top ||
                    [originalBox, movedBox].some(
                      (box) => box[0] < left - 2 || box[2] > right + 2
                    ) ||
                    movedBox[1] < Math.min(bottom, originalBox[1]) - 0.001 ||
                    movedBox[3] > Math.max(top, originalBox[3]) + 0.001
                  )
                    return false
                  const points = (item: TextItem): number[][] => {
                    const [a, b, , , x, y] = item.transform
                    if (a <= 0 || Math.abs(b) > 0.001) return []
                    return [
                      [x, y + a * 0.3],
                      [x + item.width, y + a * 0.3]
                    ]
                  }
                  const inside = (item: TextItem, box: readonly number[]): boolean => {
                    const ink = points(item)
                    return (
                      ink.length === 2 &&
                      ink.every(
                        ([x, y]) =>
                          x >= box[0] - 0.001 &&
                          x <= box[2] + 0.001 &&
                          y >= box[1] - 0.001 &&
                          y <= box[3] + 0.001
                      )
                    )
                  }
                  const ownerBox = [left - 2, bottom - 2, right + 2, top + 2],
                    before = linkedItems(originalText!, originalBox, true),
                    after = linkedItems(text, movedBox, true)
                  return (
                    before.some((item) => inside(item, ownerBox)) &&
                    after.some((item) => inside(item, ownerBox)) &&
                    after.every((item) => inside(item, ownerBox) || inside(item, originalBox))
                  )
                })
            )
            if (owners.length !== 1) throw validationError('PDF link left its source paragraph')
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
                /[A-Za-z\p{Script=Greek}\d]\//u.test(unit.source) &&
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
                /[\u0302ˆ¯˜]/u.test(unit.source) &&
                unit.fragments.some((fragment) => fragment.pageNumber === number)
            )
          ) {
            originalText ??= await getPdfTranslationTextContent(sourcePage)
            const projected = projectText(text, target),
              regions = units.flatMap((unit) =>
                unit.fragments
                  .filter((fragment) => fragment.pageNumber === number)
                  .map((fragment) => ({
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
            for (const [index, value] of verifiedAccentText(originalText, text, regions))
              nativeLabels.set(index, value)
          }
          // Power spellings belong to a paragraph, not every matching variable
          // on the page. Another paragraph may intentionally use plain digits.
          for (const [unitIndex, unit] of units.entries()) {
            const fragments = unit.fragments.filter((fragment) => fragment.pageNumber === number)
            const powers = new Set(
              [
                ...runSnapshot.units[unitIndex].translation.matchAll(
                  /(?:[A-Za-z\p{Script=Greek}]\d{0,3}|(?<!\d)10)[⁰¹²³⁴⁵⁶⁷⁸⁹]{1,2}/gu
                )
              ]
                .map(([label]) => label)
                .filter((label) => unit.source.normalize('NFKC').includes(label.normalize('NFKC')))
            )
            const authorLabels = [
              ...unit.source.matchAll(/\b(?:MM|MD|PhD|MSc|BSc)(\d{1,2}[*†‡]?)/gu)
            ].map((match) => match[1])
            const raisedLabels = [
              ...runSnapshot.units[unitIndex].translation.matchAll(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+[*†‡]?/gu)
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
            for (const [index, label] of verifiedPowerText(
              {
                ...originalText,
                items: originalText.items.filter((_, index) => sourceIndices.has(index))
              },
              { ...text, items: targetIndices.map((index) => text.items[index]) },
              powers
            )) {
              const targetIndex = targetIndices[index]
              nativeLabels.set(targetIndex, { label, indices: [targetIndex] })
            }
          }
          for (const [index, unit] of units.entries()) {
            const raised = /^[⁰¹²³⁴⁵⁶⁷⁸⁹]{1,2}(?=\p{L})/u.exec(
              runSnapshot.units[index].translation
            )?.[0]
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
            fragment: PdfTranslationRenderUnit['fragments'][number]
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
              if (matches.length !== 1)
                throw validationError('Retained neighboring PDF glyph changed')
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
          // PDFium serializes transforms with finite precision. Compare the
          // actual values: decimal buckets can split two unchanged coordinates
          // on opposite sides of a rounding boundary. Ownership remains unique
          // in both directions and requires the same text and complete geometry.
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
            const values = [item.width, ...item.transform],
              matches = (originalByText.get(item.str) ?? []).filter((before) =>
                [before.item.width, ...before.item.transform].every(
                  (value, i) => Math.abs(value - values[i]) < 0.001
                )
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
            excluded?: ReadonlySet<number>
          ): string => {
            let value = ''
            const exact = viewport === target ? exactTargetOwners(content) : sourceRegionOwners
            for (const { index, str, points } of content) {
              if (excluded?.has(index) || (exact?.get(index) && exact.get(index) !== rect)) continue
              // Baseline/advance positions are independent of embedded font ascent metrics.
              const inside = points.every(
                ([px, py]) =>
                  px >= rect.x * viewport.width - 1 &&
                  px <= (rect.x + rect.width) * viewport.width + 1 &&
                  py >= rect.y * viewport.height - 1 &&
                  py <= (rect.y + rect.height) * viewport.height + 1
              )
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
              value += str
            }
            return value
          }
          // Verify the complete target across its own ordered regions, rather than
          // requiring an entire cross-page paragraph to appear on every page.
          for (let i = 0; i < units.length; i++) {
            for (const [f, fragment] of units[i].fragments.entries()) {
              if (fragment.pageNumber !== number) continue
              const { rect } = fragment
              targetItems ??= projectedTarget()
              if (sourceOnlyItems.size)
                originalText ??= await getPdfTranslationTextContent(sourcePage)
              const foreign = retainedForeignItems(fragment)
              regionText[i][f] = readRegion(rect, targetItems, target, `${i}:${f}`, foreign)
              rawRegionText[i][f] =
                nativeLabels.size || foreign.size
                  ? readRegion(rect, rawTargetItems!, target)
                  : regionText[i][f]
              if (
                unchanged(i) ||
                textKey(regionText[i][f]) !== textKey(runSnapshot.units[i].translation)
              ) {
                originalText ??= await getPdfTranslationTextContent(sourcePage)
                sourceItems ??= projectText(originalText, source)
                originalRegionText[i][f] = readRegion(rect, sourceItems, source)
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
            )
              throw validationError('Ambiguous PDF translation regions', i, f)
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
        } finally {
          translatedPage.cleanup()
        }
      }
      let originalUnitCount = runResults.failedUnitIds?.length ?? 0
      const retainedUnitIds: string[] = []
      for (let i = 0; i < units.length; i++)
        if (
          units[i].source !== runSnapshot.units[i].translation &&
          textKey(regionText[i].join('')) !== textKey(runSnapshot.units[i].translation)
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
              )
            )
          originalUnitCount++
          retainedUnitIds.push(units[i].id)
        }
      if (!cancelled) {
        recordLayout(
          generatedUnits.flatMap(({ unit, sourceIndex, snapshot }) => {
            if (
              incremental &&
              (!cacheToken || retainedUnitIds.includes(unit.id)) &&
              !unit.fragments.some((fragment) =>
                incremental?.pageNumbers.includes(fragment.pageNumber)
              )
            )
              return []
            const failure = retainedUnitIds.includes(unit.id)
              ? (nativeFailures[unit.id] ?? {
                  code: 'unsupported-layout' as const,
                  phase: 'verification' as const,
                  pageNumbers: [...new Set(unit.fragments.map((fragment) => fragment.pageNumber))],
                  fragmentCount: unit.fragments.length
                })
              : undefined
            return [
              {
                sourceIndex,
                source: snapshot.source,
                translation: snapshot.translation,
                ...(failure ? { failure } : {})
              }
            ]
          }),
          cacheToken
        )
        if (cancelled) return
        const baseline = request.baseline
        const sameSource =
          baseline?.original === original &&
          live.current?.release === baseline.release &&
          baseline.artifact === artifact &&
          baseline.results.source === runResults.source
        const sameSnapshot =
          sameSource &&
          baseline.results.units.length === runResults.units.length &&
          isPdfTranslationResultExtension(baseline.results, runResults)
        const unchangedLayoutUnitIds = sameSource
          ? retainedUnitIds.filter((id) => {
              const before = baseline.results.units.find((unit) => unit.id === id)
              const after = acceptedById.get(id)
              const rebuiltPages = incremental?.pageNumbers
              const rebuilt =
                !rebuiltPages ||
                units
                  .find((unit) => unit.id === id)
                  ?.fragments.some((fragment) => rebuiltPages.includes(fragment.pageNumber))
              return (
                baseline.value.retainedUnitIds.includes(id) &&
                (baseline.value.unchangedLayoutUnitIds?.includes(id) ||
                  (rebuilt && (!request.retryUnitId || request.retryUnitId === id))) &&
                before?.translation === after?.translation &&
                before?.translationSource === after?.translationSource
              )
            })
          : []
        // An identical rebuild must not replace the reader's verified document
        // or reset its scroll and selection.
        if (
          sameSnapshot &&
          unchangedLayoutUnitIds.length > 0 &&
          unchangedLayoutUnitIds.length === retainedUnitIds.length &&
          retainedUnitIds.length === baseline.value.retainedUnitIds.length
        ) {
          const previousData = await baseline.value.document.getData()
          if (cancelled) return
          if (
            data.length === previousData.length &&
            data.every((byte, index) => byte === previousData[index])
          ) {
            release()
            const value = { ...baseline.value, unchangedLayoutUnitIds }
            const next = { ...baseline, value }
            live.current = next
            setDisplayed(next)
            publish(value)
            return
          }
        }
        beforeReady?.()
        live.current?.release()
        const value: Extract<State, { status: 'ready' }> = {
          status: 'ready',
          document: translated,
          pages,
          originalUnitCount,
          retainedUnitIds,
          unchangedLayoutUnitIds
        }
        const next = {
          original,
          artifact,
          results: runResults,
          value,
          release,
          data,
          validation: { regionText, rawRegionText, originalRegionText, annotations }
        }
        live.current = next
        setDisplayed(next)
        publish(value)
      }
    })().catch((error) => {
      if (!cancelled) {
        release()
        if (validating && cacheHit && !bypassCache) {
          setRequest({ ...request, bypassCache: { original, results: runResults } })
          return
        }
        const previous = request.failed
        const details = error instanceof Error ? error.message : undefined
        const retryUnchanged =
          validating &&
          previous?.original === original &&
          previous.results === runResults &&
          previous.value.failure.code === 'validation-failed' &&
          previous.value.failure.pageNumber === validationPage &&
          previous.value.unitId === validationUnit &&
          previous.value.details === details
        const failure: PdfGenerationFailure = validating
          ? { code: 'validation-failed', pageNumber: validationPage }
          : pdfGenerationFailure(error)
        if (
          [
            'source-mismatch',
            'annotations',
            'overflow',
            'multi-region',
            'font',
            'unsupported-layout',
            'validation-failed'
          ].includes(failure.code)
        ) {
          recordLayout(
            generatedUnits.flatMap(({ unit, sourceIndex, snapshot }) => {
              const affected = validationUnit
                ? unit.id === validationUnit
                : failure.pageNumber !== undefined &&
                  unit.fragments.some((fragment) => fragment.pageNumber === failure.pageNumber)
              if (!affected) return []
              return [
                {
                  sourceIndex,
                  source: snapshot.source,
                  translation: snapshot.translation,
                  failure: {
                    code: failure.code as PdfTranslationLayoutFailure['code'],
                    phase: validating ? ('verification' as const) : ('generation' as const),
                    pageNumbers: failure.pageNumber
                      ? [failure.pageNumber]
                      : [...new Set(unit.fragments.map((fragment) => fragment.pageNumber))],
                    fragmentCount: unit.fragments.length
                  }
                }
              ]
            })
          )
        }
        publish({
          status: 'error',
          retryUnchanged,
          failure,
          details,
          unitId: validating ? validationUnit : undefined
        })
      }
    })
    return () => {
      cancelled = true
      setStored(undefined)
      if (!useArtifact) void api?.cancelPdf(id).catch(() => undefined)
      // Keep the verified display alive while its explicit replacement loads.
      // Source replacement and unmount release it through the display owner.
      if (live.current?.release !== release) release()
    }
  }, [admitted, original, artifact, beforeReady, request, useArtifact, selected, snapshot])
  // Batch at page boundaries, never cancel a running generation for incoming paragraphs.
  // Keep errors explicit so a failed rebuild cannot turn into an automatic retry loop.
  const latestSnapshot = useMemo(
    () => (results ? partialPdfSnapshot(results) : undefined),
    [results]
  )
  useEffect(() => {
    if (
      !admitted ||
      artifact ||
      !results ||
      !selected ||
      !snapshot ||
      !latestSnapshot ||
      state.status !== 'ready' ||
      !canDisplay
    )
      return
    const readyPages = new Set(latestSnapshot.readyPages)
    const before = new Map(selected.units.map((unit) => [unit.id, unit.translation]))
    const after = new Map(results.units.map((unit) => [unit.id, unit.translation]))
    const pageChanged =
      latestSnapshot.readyPages.some((page) => !snapshot.readyPages.includes(page)) ||
      results.source.units.some(
        (unit) =>
          unit.fragments.some((fragment) => readyPages.has(fragment.pageNumber)) &&
          before.get(unit.id) !== after.get(unit.id)
      )
    if (!pageChanged) return
    const timer = window.setTimeout(() => {
      setSelection({ original, artifact, results, ready: true })
      setRequest({ baseline: displayed })
    }, 200)
    return () => window.clearTimeout(timer)
  }, [
    admitted,
    artifact,
    original,
    results,
    selected,
    snapshot,
    latestSnapshot,
    state.status,
    canDisplay,
    displayed
  ])

  const retry = useCallback(() => {
    if (state.status !== 'error' || state.retryUnchanged) return
    setStored(undefined)
    if (admitted && results) setSelection({ original, artifact, results, ready: true })
    setRequest({
      rebuildArtifact: artifact,
      baseline: displayed,
      ...(admitted && results ? { bypassCache: { original, results } } : {}),
      ...(admitted && results && state.status === 'error'
        ? { failed: { original, results, value: state } }
        : {})
    })
  }, [state, admitted, original, artifact, results, displayed])
  const refresh = useCallback(
    (unitId?: string) => {
      if (!admitted || !results || state.status === 'loading') return
      setSelection({ original, artifact, results, ready: true })
      setRequest({
        rebuildArtifact: artifact,
        retryUnitId: unitId,
        baseline: displayed,
        bypassCache: { original, results }
      })
    },
    [admitted, original, artifact, results, state.status, displayed]
  )
  const unfilledUnitIds = useMemo(() => {
    if (!admitted || !results) return []
    const rendered = new Map(
      canDisplay ? displayed?.results.units.map((unit) => [unit.id, unit]) : []
    )
    const retained = new Set(canDisplay ? displayed?.value.retainedUnitIds : [])
    return results.units.flatMap((unit) => {
      const previous = rendered.get(unit.id)
      return retained.has(unit.id) ||
        previous?.translation !== unit.translation ||
        previous?.translationSource !== unit.translationSource
        ? [unit.id]
        : []
    })
  }, [admitted, results, canDisplay, displayed])
  const layoutFailures = useMemo(() => {
    if (!admitted || !results) return {}
    const failures = { ...results.layoutFailures }
    if (layoutReports?.original === original && layoutReports.source === results.source) {
      for (const unit of results.units) {
        const report = layoutReports.units[unit.id]
        if (report?.source !== unit.translationSource || report.translation !== unit.translation)
          continue
        if (report.failure) failures[unit.id] = report.failure
        else delete failures[unit.id]
      }
    }
    return failures
  }, [admitted, results, original, layoutReports])
  return {
    state,
    unfilledUnitIds,
    layoutFailures,
    ready: canDisplay ? displayed?.value : undefined,
    unchangedLayoutUnitIds:
      canDisplay && displayed
        ? (displayed.value.unchangedLayoutUnitIds ?? []).filter((id) => {
            const before = displayed.results.units.find((unit) => unit.id === id)
            const after = results?.units.find((unit) => unit.id === id)
            return (
              before?.translation === after?.translation &&
              before?.translationSource === after?.translationSource
            )
          })
        : [],
    updateAvailable: Boolean(
      admitted &&
      selected &&
      (results.units.length !== selected.units.length ||
        !isPdfTranslationResultExtension(selected, results))
    ),
    isCurrent: Boolean(
      canDisplay &&
      displayed &&
      results &&
      displayed.results.units.length === results.units.length &&
      isPdfTranslationResultExtension(displayed.results, results)
    ),
    refresh,
    retry,
    registerDisposer
  }
}
