import { pdfTranslationCheckpointRequestSchema } from '../../../../../../shared/pdf-translation'
import {
  verifiedPdfLatinAccentText,
  pdfTranslationLayoutFragments,
  getPdfTranslationTextContent,
  getPdfTranslationLayoutSnapshot,
  createPdfTranslationTargetExclusions,
  extractPdfTranslationSource,
  sameNativeMatrixBody,
  sameNativeFunctionDisplay,
  resolveInlineFractions,
  pdfLinkLabelKey,
  pdfLinkLabelMatches,
  pdfLinkAddressMatches,
  translatedPdfBracketedReference,
  translatedPdfLinkFragment,
  translatedPdfLinkLabel,
  isPdfTranslationResultExtension,
  type PdfTranslationResults
} from '@aipoch/pdf-translation/reader'

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { pdfjsLib } from '../pdfjs'
import { usePdfReflowDocument } from './use-pdf-reflow-document'
import {
  preparePdfTranslationStructure,
  type PdfTranslationStructureContext
} from './pdf-translation-structure'
import type {
  PdfTranslationDocumentState,
  PdfTranslationPageGeometry as Geometry
} from './pdf-translation-document-state'

export type { PdfTranslationDocumentState } from './pdf-translation-document-state'

import {
  pdfGenerationFailure,
  type PdfGenerationFailure,
  type PdfTranslationLayoutFailure
} from '@aipoch/pdf-translation/contracts'
import { type PdfTranslationRecordLayoutRequest } from '../../../../../../shared/pdf-translation'

/** A generated file belongs to exactly one accepted result snapshot, never a filename alone. */
export type PdfTranslationArtifact = Readonly<{ results: PdfTranslationResults; data: Uint8Array }>
type State = PdfTranslationDocumentState
const idle: State = { status: 'idle' }
// A figure prefix may govern exactly two coordinated panels. Only the second
// digit is implicit; the complete ordered pair and its occurrence stay fixed.
function coordinatedPanelContinuation(
  source: string,
  translation: string,
  label: string,
  offset: number
): { start: number; panel: string } | undefined {
  if (!/^\d+$/u.test(label) || source.slice(offset, offset + label.length) !== label)
    return undefined
  const pairs = (value: string): RegExpExecArray[] =>
    [
      ...value.matchAll(
        /(?:\b(?:Figure|Fig\.?)\s*|[图圖]\s*)(\d+)[（(]\s*([A-Za-z])\s*[)）]\s*(?:and\b|和|与|與|及)\s*(\d+)[（(]\s*([A-Za-z])\s*[)）](?![A-Za-z\d])/giu
      )
    ].filter(
      (match) =>
        !/^\s*(?:[,;，；]|and\b|和|与|與|及)\s*\d/u.test(value.slice(match.index + match[0].length))
    )
  const identity = (match: RegExpExecArray): string => match.slice(1, 5).join(':')
  const digit = (match: RegExpExecArray): number =>
    match.index + match[0].search(/\d+[（(]\s*[A-Za-z]\s*[)）]\s*$/u)
  const from = pairs(source),
    reference = from.find((match) => match[3] === label && digit(match) === offset)
  if (!reference) return undefined
  const same = (match: RegExpExecArray): boolean => identity(match) === identity(reference)
  const original = from.filter(same),
    translated = pairs(translation).filter(same)
  const compoundCount = (value: string): number =>
    [...value.matchAll(/(?<![A-Za-z\d_.])(\d+)[（(]\s*([A-Za-z])\s*[)）](?![A-Za-z\d])/gu)].filter(
      (match) => match[1] === label && match[2] === reference[4]
    ).length
  if (
    original.length !== translated.length ||
    compoundCount(source) !== original.length ||
    compoundCount(translation) !== translated.length
  )
    return undefined
  const target = translated[original.indexOf(reference)]
  return target ? { start: digit(target), panel: reference[4] } : undefined
}

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

// A saved native link can split a merged final run. Prove every visible
// prefix with unchanged ink before accepting the finer PDF.js item boundaries.
async function verifiedNativeLinkPrefix(
  before: TextItem[],
  after: TextItem[],
  original: TextContent,
  target: TextContent,
  originalPage: PDFPageProxy,
  targetPage: PDFPageProxy,
  delta: readonly number[]
): Promise<boolean> {
  if (!before.length || before.length !== after.length) return false
  for (let index = 0; index < before.length; index++) {
    const source = before[index],
      moved = after[index],
      sourceStyle = original.styles?.[source.fontName],
      targetStyle = target.styles?.[moved.fontName],
      suffix = source.str.slice(moved.str.length)
    if (
      !moved.str.trim() ||
      ![source.width, moved.width].every((width) => Number.isFinite(width) && width > 0) ||
      (index < before.length - 1
        ? source.str !== moved.str || Math.abs(source.width - moved.width) >= 0.001
        : !source.str.startsWith(moved.str) ||
          !/^(?:\s|[,.;:)\]](?:\s|$))/u.test(suffix) ||
          moved.width >= source.width) ||
      !sourceStyle ||
      !targetStyle ||
      sourceStyle.fontFamily !== targetStyle.fontFamily ||
      targetStyle.vertical ||
      !(['ascent', 'descent'] as const).every(
        (key) => Math.abs(sourceStyle[key] - targetStyle[key]) < 0.001
      ) ||
      source.transform[0] <= 0 ||
      source.transform[3] <= 0 ||
      source.transform[1] !== 0 ||
      source.transform[2] !== 0 ||
      !source.transform
        .slice(0, 4)
        .every((value, i) => Math.abs(value - moved.transform[i]) < 0.001) ||
      ![4, 5].every(
        (axis) => Math.abs(moved.transform[axis] - source.transform[axis] - delta[axis - 4]) < 0.05
      ) ||
      !(await verifiedNativePrefixInk(source, moved, originalPage, targetPage, sourceStyle))
    )
      return false
  }
  return true
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
      // Retained source has no output capacity to reserve. Enlarging its region
      // can include rotated figure labels excluded from prose extraction.
      fragments:
        !translations.has(unit.id) || translations.get(unit.id)!.translation === unit.source
          ? unit.fragments
          : pdfTranslationLayoutFragments(unit, results.source),
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
        const borderStyle = annotation.borderStyle && { ...annotation.borderStyle }
        // PDFium serializes border widths through float32; all other metadata stays exact.
        for (const key of ['width', 'rawWidth'])
          if (
            borderStyle &&
            typeof borderStyle[key] === 'number' &&
            borderStyle[key] >= 0 &&
            Number.isFinite(Math.fround(borderStyle[key]))
          )
            borderStyle[key] = Math.fround(borderStyle[key])
        return {
          type: annotation.annotationType,
          destinationCoordinates,
          rect: annotation.rect,
          quadPoints: annotation.quadPoints,
          uri: annotation.unsafeUrl ?? annotation.url,
          key: JSON.stringify({
            type: annotation.annotationType,
            color: annotation.color,
            borderStyle,
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
  beforeReady?: () => void,
  layout?: 'reflow',
  translating = false,
  structureContext?: PdfTranslationStructureContext
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
  const reflow = usePdfReflowDocument(
    original,
    results,
    resourceRequestKey,
    layout === 'reflow',
    beforeReady,
    translating,
    structureContext
  )
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
    originalPages?: {
      original: PDFDocumentProxy
      source: PdfTranslationResults['source']
      reasons: ReadonlyMap<number, Pick<PdfTranslationLayoutFailure, 'code' | 'phase'>>
    }
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
    layout !== 'reflow' &&
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
    if (!runResults || !snapshot) return
    const sourceUnits = runResults.source.units.filter((unit) => !unit.sourceOnly)
    const originalPages = new Map(
      request.originalPages?.original === original &&
        request.originalPages.source === runResults.source
        ? request.originalPages.reasons
        : []
    )
    // Preserve joined paragraphs as a whole, including their other pages.
    let expanded: boolean
    do {
      expanded = false
      for (const unit of sourceUnits) {
        const retained = unit.fragments.find((fragment) => originalPages.has(fragment.pageNumber))
        if (!retained) continue
        for (const fragment of unit.fragments)
          if (!originalPages.has(fragment.pageNumber)) {
            originalPages.set(fragment.pageNumber, originalPages.get(retained.pageNumber)!)
            expanded = true
          }
      }
    } while (expanded)
    const preservedIds = new Set(
      sourceUnits
        .filter((unit) => unit.fragments.some((fragment) => originalPages.has(fragment.pageNumber)))
        .map((unit) => unit.id)
    )
    let runSnapshot = originalPages.size
      ? {
          ...snapshot,
          units: snapshot.units.map((unit, index) =>
            preservedIds.has(sourceUnits[index].id)
              ? { ...unit, fragments: sourceUnits[index].fragments, translation: unit.source }
              : unit
          )
        }
      : snapshot
    const units = sourceUnits.map((unit, index) => ({
      ...unit,
      fragments: runSnapshot.units[index].fragments
    }))
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
    const nativeVerification = new AbortController()
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
    let task: ReturnType<typeof pdfjsLib.getDocument> | undefined
    let released = false
    let validating = false
    let validationPage: number | undefined
    let validationUnit: string | undefined
    let validationDetails: string | undefined
    const validationError = (
      message: string,
      unitIndex?: number,
      fragmentIndex?: number
    ): Error => {
      const unit = unitIndex === undefined ? undefined : units[unitIndex]
      validationDetails = message
      validationUnit = unit?.id
      if (unit && fragmentIndex !== undefined)
        validationPage = unit.fragments[fragmentIndex]?.pageNumber ?? validationPage
      return new Error(message)
    }
    const baseline = request.baseline
    const reusable =
      !useArtifact &&
      originalPages.size === 0 &&
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
    let generatedUnits = units.flatMap((unit, sourceIndex) =>
      acceptedById.has(unit.id)
        ? [{ unit, sourceIndex, snapshot: snapshot.units[sourceIndex] }]
        : []
    )
    let nativeFailures: Record<string, PdfTranslationLayoutFailure> = {}
    let cacheToken: string | undefined
    let cacheHit = false
    const bypassCache =
      request.bypassCache?.original === original && request.bypassCache.results === runResults
    let cache =
      complete && !originalPages.size && runResults.checkpoint
        ? {
            source: pdfTranslationCheckpointRequestSchema.parse(runResults.checkpoint.source),
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
            source: pdfTranslationCheckpointRequestSchema.parse(runResults.checkpoint.source),
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
    const generation = (async () => {
      publish({ status: 'loading', phase: 'generating' })
      if (structureContext && typeof window.api?.pdfStructure?.readCached === 'function') {
        const coverage =
          getPdfTranslationLayoutSnapshot(runResults.source)?.coverage ??
          (
            await extractPdfTranslationSource({
              document: original,
              resourceRequestKey,
              signal: nativeVerification.signal
            })
          ).coverage
        const structure = await preparePdfTranslationStructure({
          document: original,
          extraction: { source: runResults.source, coverage },
          context: structureContext,
          preserveUnitIdentity: true,
          nativeDocumentFactory: pdfjsLib.getDocument,
          signal: nativeVerification.signal
        })
        if (cancelled) return
        for (const id of structure.retainedUnitIds) if (acceptedById.has(id)) preservedIds.add(id)
        for (const page of structure.retainedSourcePageNumbers ?? [])
          originalPages.set(page, { code: 'unsupported-layout', phase: 'generation' })
        // A saved owner can span pages; retaining any page must retain the whole owner.
        let previousSize: number
        do {
          previousSize = originalPages.size
          for (const unit of sourceUnits)
            if (unit.fragments.some((fragment) => originalPages.has(fragment.pageNumber))) {
              preservedIds.add(unit.id)
              for (const fragment of unit.fragments)
                if (!originalPages.has(fragment.pageNumber))
                  originalPages.set(fragment.pageNumber, {
                    code: 'unsupported-layout',
                    phase: 'generation'
                  })
            }
        } while (originalPages.size !== previousSize)
        if (preservedIds.size || originalPages.size) {
          // Only current native-proved negative ownership may override a saved target.
          // The historical source, accepted translation and checkpoint stay unchanged.
          runSnapshot = {
            ...snapshot,
            units: snapshot.units.map((unit, index) =>
              preservedIds.has(sourceUnits[index].id)
                ? { ...unit, fragments: sourceUnits[index].fragments, translation: unit.source }
                : unit
            )
          }
          for (const [index, unit] of units.entries())
            units[index] = { ...unit, fragments: runSnapshot.units[index].fragments }
          generatedUnits = units.flatMap((unit, sourceIndex) =>
            acceptedById.has(unit.id)
              ? [{ unit, sourceIndex, snapshot: snapshot.units[sourceIndex] }]
              : []
          )
          cache = undefined
          incremental = undefined
        }
        if (useArtifact && (originalPages.size || preservedIds.size)) {
          validating = true
          validationPage =
            originalPages.keys().next().value ??
            sourceUnits.find((unit) => preservedIds.has(unit.id))?.fragments[0]?.pageNumber
          throw validationError('Retained neighboring PDF glyph changed')
        }
      }
      let data = useArtifact ? artifact?.data : undefined
      if (!data) {
        const source = await original.getData()
        if (cancelled) return
        if (originalPages.size) {
          // Transplant only verified replacement pages into the original PDF.
          // Preserved page streams must not pass through PDFium serialization.
          const pageNumbers = Array.from(
            { length: original.numPages },
            (_, index) => index + 1
          ).filter((number) => !originalPages.has(number))
          incremental = pageNumbers.length ? { data: source, pageNumbers } : undefined
        }
        const generate = async (): Promise<Uint8Array | undefined> => {
          cacheToken = undefined
          cacheHit = false
          nativeFailures = {}
          for (const { unit } of generatedUnits)
            if (preservedIds.has(unit.id))
              nativeFailures[unit.id] = {
                ...(originalPages.get(unit.fragments[0].pageNumber) ?? {
                  code: 'unsupported-layout',
                  phase: 'generation'
                }),
                pageNumbers: [...new Set(unit.fragments.map((fragment) => fragment.pageNumber))],
                fragmentCount: unit.fragments.length
              }
          if (originalPages.size === original.numPages) return source.slice()
          const output = await api!.generatePdf({
            id,
            preserveUnsupported: true,
            preserveUnmatched: true,
            data: source,
            ...(incremental ? { incremental } : {}),
            ...(cache ? { cache } : {}),
            pages: runResults.source.pages,
            // The native indices refer to this accepted subset, not the full source.
            units: generatedUnits.map(({ sourceIndex }) => ({
              source: runSnapshot.units[sourceIndex].source,
              fragments: runSnapshot.units[sourceIndex].fragments,
              translation: runSnapshot.units[sourceIndex].translation
            }))
          })
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
          if (
            !incremental ||
            originalPages.size > 0 ||
            !['worker-failed', 'invalid-input'].includes(code) ||
            cancelled
          )
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
      targetExclusions = createPdfTranslationTargetExclusions({
        source: runResults.source,
        document: translated,
        data,
        nativeDocumentFactory: pdfjsLib.getDocument,
        signal: nativeVerification.signal
      })
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
              signal: nativeVerification.signal
            }))
          )
            throw validationError('Retained neighboring PDF glyph changed')
          if (
            !(await sameNativeFunctionDisplay(original, translated, number, {
              nativeDocumentFactory: pdfjsLib.getDocument,
              signal: nativeVerification.signal
            }))
          )
            throw validationError('Retained neighboring PDF glyph changed')
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
              // One serialized native item can carry a digit and exactly one
              // boundary delimiter. Its identity is still proved below by the
              // complete closed vector, its occurrence and the same owner.
              const numericHit = (
                items: TextItem[]
              ):
                | {
                    linked: TextItem[]
                    label: string
                    open: string
                    close: string
                  }
                | undefined => {
                const linked =
                  items.length > 1 && /^[,，]$/u.test(textKey(items.at(-1)!.str))
                    ? items.slice(0, -1)
                    : items
                const label = textKey(linked.map((item) => item.str).join(''))
                if (/^\d{1,4}$/u.test(label)) return { linked, label, open: '', close: '' }
                if (items.length !== 1) return
                const opening = label.match(/^([[［])(\d{1,4})$/u),
                  closing = label.match(/^(\d{1,4})([\]］])$/u)
                return opening
                  ? { linked, label: opening[2], open: opening[1], close: '' }
                  : closing
                    ? { linked, label: closing[1], open: '', close: closing[2] }
                    : undefined
              }
              const located = (rect: readonly number[], token: string, offset: number): boolean => {
                const hit = linkedItems(text, rect),
                  numeric = numericHit(hit)
                if (!numeric || numeric.label !== token) return false
                const linked = numeric.linked
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
                  candidates = text.items.flatMap((item) => {
                    if (
                      !('str' in item) ||
                      !item.str.trim() ||
                      item.transform[0] <= 0 ||
                      item.transform[1] !== 0 ||
                      item.transform[2] !== 0
                    )
                      return []
                    return within(item, owner) ? [item] : []
                  }),
                  local = candidates
                    .filter(
                      (item) =>
                        Math.abs(item.transform[5] - first.transform[5]) <=
                        Math.min(item.transform[0], first.transform[0]) * 0.3
                    )
                    .sort((a, b) => a.transform[4] - b.transform[4]),
                  rows = [
                    local,
                    [...candidates].sort((a, b) =>
                      Math.abs(a.transform[5] - b.transform[5]) >
                      Math.max(a.transform[0], b.transform[0]) * 0.3
                        ? b.transform[5] - a.transform[5]
                        : a.transform[4] - b.transform[4]
                    )
                  ]
                // Anchor a single-row citation to its own digits. A pairwise
                // font-size comparator can place unrelated lowered math inside it.
                return rows.some((row, rowIndex) => {
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
                  const before = textKey(translation.slice(full.targetBlock.start, full.start)),
                    after = textKey(translation.slice(full.end, full.targetBlock.end))
                  if (
                    (numeric.open && before !== numeric.open) ||
                    (numeric.close && after !== numeric.close)
                  )
                    return false
                  const block = textKey(full.targetBlock.text),
                    blockStart = actual[0].start + numeric.open.length - before.length
                  if (
                    blockStart < 0 ||
                    line.slice(blockStart, blockStart + block.length) !== block ||
                    actual.at(-1)!.end - actual[0].start !==
                      token.length + numeric.open.length + numeric.close.length
                  )
                    return false
                  const parts = spans.filter(
                    (span) => span.start < blockStart + block.length && span.end > blockStart
                  )
                  // A preserved hit area can also cover the following comma.
                  // It must belong to this exact closed vector, never nearby prose.
                  if (hit.some((item) => !parts.some((part) => part.item === item))) return false
                  if (
                    rowIndex === 0 &&
                    candidates.some(
                      (item) =>
                        !local.includes(item) &&
                        parts.some(
                          ({ item: part }) =>
                            Math.abs(item.transform[5] - part.transform[5]) <
                              Math.max(item.transform[0], part.transform[0]) * 0.65 &&
                            item.transform[4] < part.transform[4] + part.width &&
                            item.transform[4] + item.width > part.transform[4]
                        )
                    )
                  )
                    return false
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
                  digitOwners = new Set<TextItem>(),
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
                    const selected =
                      sharedRun ||
                      [...block[0].matchAll(/\d+/gu)].map((part) => part[0]).join(',') ===
                        [...nativeSource.targetBlock.text.matchAll(/\d+/gu)]
                          .map((part) => part[0])
                          .join(',')
                    if (selected) {
                      let cursor = 0
                      for (const item of sourceItems) {
                        const start = cursor
                        cursor += 'str' in item ? item.str.length : 0
                        if (
                          'str' in item &&
                          nativeDigits.some(
                            (digit) =>
                              start < proof.targetBlock.start + digit.index + digit[0].length &&
                              cursor > proof.targetBlock.start + digit.index
                          )
                        )
                          digitOwners.add(item)
                      }
                    }
                    return selected
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
                          digitOwners.has(item)
                        )
                      )
                        return []
                      const targetItems = linkedItems(text, targetAnnotations[position].rect),
                        label = numericHit(targetItems)?.label,
                        sourceItem = linkedItems(originalText!, candidate.rect, true).find((item) =>
                          digitOwners.has(item)
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
                      /(?:\b(?:Figure|Fig\.?)\s*|[图圖]\s*)(\d+)[（(]\s*([A-Za-z])\s*[)）](?![A-Za-z\d])/giu
                    )
                  ],
                  nativeItems = linkedItems(originalText!, annotation.rect, true),
                  nativeRun = nativeItems.map((item) => item.str).join(' '),
                  originals = [
                    ...panels(nativeRun),
                    ...nativeRun.matchAll(/^\s*(\d+)[（(]\s*([A-Za-z])\s*[)）](?![A-Za-z\d])/gu)
                  ].filter((match) => match[1] === sourceLabel)
                if (originals.length !== 1) return false
                const owners = units.filter((unit, unitIndex) => {
                  const matches = panels(unit.source).filter(
                    (match) => match[1] === sourceLabel && match[2] === originals[0][2]
                  )
                  const starts = [
                      ...unit.source.matchAll(
                        new RegExp(
                          `(?<![A-Za-z\\d_.])${sourceLabel}[（(]\\s*${originals[0][2]}\\s*[)）](?![A-Za-z\\d])`,
                          'gu'
                        )
                      )
                    ],
                    continued =
                      matches.length === 0 && starts.length === 1
                        ? coordinatedPanelContinuation(
                            unit.source,
                            runSnapshot.units[unitIndex].translation,
                            sourceLabel,
                            starts[0].index
                          )
                        : undefined
                  if (matches.length !== 1 && !continued) return false
                  const match = matches[0],
                    target = match
                      ? translatedPdfLinkFragment(
                          unit.source,
                          runSnapshot.units[unitIndex].translation,
                          sourceLabel,
                          match.index + match[0].indexOf(sourceLabel)
                        )
                      : continued && { start: continued.start, text: sourceLabel }
                  if (continued) {
                    const targetGeometry = source
                    const after = linkedItems(text, moved.rect),
                      glyph = after[0]
                    if (
                      nativeItems.length !== 1 ||
                      after.length !== 1 ||
                      glyph.str !== sourceLabel ||
                      glyph.transform[0] <= 0 ||
                      glyph.transform[3] <= 0 ||
                      glyph.transform[1] !== 0 ||
                      glyph.transform[2] !== 0 ||
                      Math.abs(nativeItems[0].transform[4] - annotation.rect[0]) > 1 ||
                      units.filter((u) =>
                        u.fragments.some(
                          (f) =>
                            f.pageNumber === number &&
                            f.items.some((c) => originalText!.items[c.index] === nativeItems[0])
                        )
                      ).length !== 1 ||
                      sourceAnnotations.filter((a) =>
                        linkedItems(originalText!, a.rect, true).includes(nativeItems[0])
                      ).length !== 1 ||
                      targetAnnotations.filter((a) => linkedItems(text, a.rect).includes(glyph))
                        .length !== 1
                    )
                      return false
                    const within = (item: TextItem): boolean =>
                        unit.fragments.some(
                          (f) =>
                            f.pageNumber === number &&
                            item.transform[4] >= f.rect.x * targetGeometry.width - 1 &&
                            item.transform[4] + item.width <=
                              (f.rect.x + f.rect.width) * targetGeometry.width + 1 &&
                            targetGeometry.height - item.transform[5] >=
                              f.rect.y * targetGeometry.height - 1 &&
                            targetGeometry.height - item.transform[5] <=
                              (f.rect.y + f.rect.height) * targetGeometry.height + 1
                        ),
                      row = text.items
                        .filter(
                          (item): item is TextItem =>
                            'str' in item &&
                            Boolean(item.str.trim()) &&
                            item !== glyph &&
                            item.transform[0] > 0 &&
                            item.transform[3] > 0 &&
                            item.transform[1] === 0 &&
                            item.transform[2] === 0 &&
                            Math.abs(item.transform[5] - glyph.transform[5]) <=
                              glyph.transform[0] * 0.3 &&
                            item.transform[4] >= glyph.transform[4] + glyph.width - 0.001
                        )
                        .sort((a, b) => a.transform[4] - b.transform[4])
                    let tail = '',
                      previous = glyph
                    for (const item of row) {
                      if (tail.length >= 3) break
                      if (
                        !within(item) ||
                        item.transform[4] - previous.transform[4] - previous.width >
                          glyph.transform[0] * 1.5
                      )
                        return false
                      tail += item.str.replace(/\s/gu, '').normalize('NFKC')
                      previous = item
                    }
                    if (!within(glyph) || !tail.startsWith(`(${continued.panel})`)) return false
                  }
                  return (
                    target?.text === label &&
                    unit.fragments.some(
                      (fragment) =>
                        fragment.pageNumber === number &&
                        nativeItems.every((native) =>
                          fragment.items.some(
                            (item) =>
                              originalText!.items[item.index] === native &&
                              textKey(item.text) === textKey(native.str)
                          )
                        ) &&
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
            // A digit-only annotation needs the full typed-reference identity and
            // its native row ordinal. A repeated digit in one merged row abstains.
            const typedReferences = (
              value: string
            ): { key: string; at: number; end: number; digit: number }[] =>
              [
                ...value.matchAll(
                  /(?:\b(?:Figure|Fig\.?|Table|Tab\.?|Theorem)|[图圖表]|定理)\s*(\d+)(?:\s*[（(]\s*([A-Za-z])\s*[)）])?(?![A-Za-z\d]|[.．]\d)/giu
                )
              ].flatMap((match) => {
                const prefix = match[0].slice(0, match[0].indexOf(match[1])),
                  key = pdfLinkLabelKey(prefix + match[1])
                return key &&
                  (!/^\s*[（(]/u.test(value.slice(match.index + match[0].length)) || match[2])
                  ? [
                      {
                        key: key + ':' + (match[2] ?? ''),
                        at: match.index,
                        end: match.index + match[0].length,
                        digit: match.index + prefix.length
                      }
                    ]
                  : []
              })
            const typedReferenceRequired =
              !panelNumber &&
              originalExactLabel !== sourceLabel &&
              /^\d+$/u.test(sourceLabel) &&
              (numericOccurrences !== 1 ||
                [
                  ...linkedItems(originalText!, annotation.rect, true)
                    .map((item) => item.str)
                    .join(' ')
                    .matchAll(/\d+/gu)
                ].filter((match) => match[0] === sourceLabel).length !== 1) &&
              typedReferences(
                linkedItems(originalText!, annotation.rect, true)
                  .map((item) => item.str)
                  .join(' ')
              ).some((reference) => reference.key.split(':')[1] === sourceLabel)
            const typedReferenceOwners =
              typedReferenceRequired && sourceLabel === label
                ? units.map((unit, unitIndex) => {
                    if (unchanged(unitIndex) || unit.fragments.some((f) => f.pageNumber !== number))
                      return undefined
                    const hit = linkedItems(originalText!, annotation.rect, true),
                      claims = unit.fragments.flatMap((f) => f.items),
                      indices = claims.map((c) => c.index)
                    if (
                      !hit.length ||
                      new Set(indices).size !== indices.length ||
                      indices.some((n, i) => i > 0 && n <= indices[i - 1]) ||
                      claims.some((c) => {
                        const native = originalText!.items[c.index]
                        return !native || !('str' in native) || native.str !== c.text
                      }) ||
                      !hit.every((native) =>
                        claims.some((c) => originalText!.items[c.index] === native)
                      ) ||
                      units.some(
                        (other) =>
                          other !== unit &&
                          other.fragments.some(
                            (f) =>
                              f.pageNumber === number &&
                              f.items.some((c) => indices.includes(c.index))
                          )
                      ) ||
                      unit.fragments.filter((f) =>
                        hit.every((native) =>
                          f.items.some((c) => originalText!.items[c.index] === native)
                        )
                      ).length !== 1
                    )
                      return undefined
                    let cursor = 0
                    const spans = claims.map((c) => {
                        const start = cursor
                        cursor += c.text.length + 1
                        return {
                          item: originalText!.items[c.index] as TextItem,
                          start,
                          end: cursor - 1
                        }
                      }),
                      native = claims.map((c) => c.text).join(' '),
                      from = typedReferences(unit.source),
                      to = typedReferences(runSnapshot.units[unitIndex].translation),
                      actualFrom = typedReferences(native),
                      same = (a: typeof from, b: typeof from): boolean =>
                        a.length > 0 &&
                        a.length === b.length &&
                        a.every((r, i) => r.key === b[i].key),
                      candidates = actualFrom.filter((r) => {
                        const parts = spans.filter((s) => s.start < r.end && s.end > r.at)
                        return parts.length > 0 && parts.every((s) => hit.includes(s.item))
                      })
                    if (
                      !same(from, actualFrom) ||
                      !same(from, to) ||
                      candidates.length !== 1 ||
                      [
                        ...hit
                          .map((i) => i.str)
                          .join(' ')
                          .matchAll(/\d+/gu)
                      ].filter((m) => m[0] === sourceLabel).length !== 1 ||
                      sourceAnnotations.filter((a) =>
                        linkedItems(originalText!, a.rect, true).some((item) => hit.includes(item))
                      ).length !== 1
                    )
                      return undefined
                    const occurrence = actualFrom.indexOf(candidates[0]),
                      expected = translatedPdfLinkFragment(
                        unit.source,
                        runSnapshot.units[unitIndex].translation,
                        sourceLabel,
                        from[occurrence].digit
                      ),
                      within = (
                        item: TextItem,
                        fragment: (typeof unit.fragments)[number]
                      ): boolean =>
                        item.transform[0] > 0 &&
                        item.transform[3] > 0 &&
                        item.transform[1] === 0 &&
                        item.transform[2] === 0 &&
                        [item.transform[4], item.transform[4] + item.width].every(
                          (x) =>
                            x >= fragment.rect.x * target.width - 1 &&
                            x <= (fragment.rect.x + fragment.rect.width) * target.width + 1
                        ) &&
                        target.height - item.transform[5] >= fragment.rect.y * target.height - 1 &&
                        target.height - item.transform[5] <=
                          (fragment.rect.y + fragment.rect.height) * target.height + 1,
                      targetRows = unit.fragments.map((fragment) =>
                        text.items
                          .filter(
                            (item): item is TextItem =>
                              'str' in item && Boolean(item.str) && within(item, fragment)
                          )
                          .sort((a, b) =>
                            Math.abs(a.transform[5] - b.transform[5]) >
                            Math.max(a.transform[0], b.transform[0]) * 0.3
                              ? b.transform[5] - a.transform[5]
                              : a.transform[4] - b.transform[4]
                          )
                      ),
                      ordered = targetRows.flat(),
                      after = linkedItems(text, moved.rect)
                    if (
                      expected?.text !== sourceLabel ||
                      expected.start !== to[occurrence].digit ||
                      !after.length ||
                      textKey(after.map((i) => i.str).join('')) !== sourceLabel ||
                      new Set(ordered).size !== ordered.length ||
                      !after.every((i) => ordered.includes(i)) ||
                      targetAnnotations.filter((a) =>
                        linkedItems(text, a.rect).some((item) => after.includes(item))
                      ).length !== 1
                    )
                      return undefined
                    cursor = 0
                    const targetSpans = ordered.map((item) => {
                        const start = cursor
                        cursor += textKey(item.str).length
                        return { item, start, end: cursor }
                      }),
                      targetNative = ordered.map((item) => item.str).join(''),
                      actualTo = typedReferences(targetNative).map((r) => ({
                        ...r,
                        digit: textKey(targetNative.slice(0, r.digit)).length
                      })),
                      reference = actualTo[occurrence],
                      linked = targetSpans.filter((s) => after.includes(s.item))
                    if (
                      !same(to, actualTo) ||
                      !reference ||
                      linked[0].start !== reference.digit ||
                      linked.at(-1)!.end !== reference.digit + sourceLabel.length ||
                      after.length !== 1 ||
                      hit.length !== 1
                    )
                      return undefined
                    return unit
                  })
                : []
            const typedOwners = typedReferenceOwners.filter((unit) => unit !== undefined),
              typedReferenceNumber = typedOwners.length === 1
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
            const prefixBefore = linkedItems(originalText, annotation.rect, true),
              prefixAfter = linkedItems(text, moved.rect),
              prefixOwners =
                originalExactLabel &&
                originalExactLabel !== sourceLabel &&
                sourceLabel === label &&
                textKey(prefixAfter.map((item) => item.str).join('')) === label &&
                sourceLabel.startsWith(originalExactLabel) &&
                prefixBefore.length > 0 &&
                prefixBefore.length === prefixAfter.length &&
                Math.abs(prefixBefore[0].transform[4] - annotation.rect[0]) <= 1 &&
                Math.abs(
                  prefixBefore.at(-1)!.transform[4] + prefixAfter.at(-1)!.width - annotation.rect[2]
                ) <= 1 &&
                originalRun.startsWith(sourceLabel) &&
                originalRun.split(sourceLabel).length === 2
                  ? units.filter(
                      (unit, unitIndex) =>
                        !unchanged(unitIndex) &&
                        textKey(unit.source).split(sourceLabel).length === 2 &&
                        textKey(runSnapshot.units[unitIndex].translation).split(label).length ===
                          2 &&
                        unit.fragments.every((fragment) => fragment.pageNumber === number) &&
                        prefixBefore.every((item) =>
                          unit.fragments.some((fragment) =>
                            fragment.items.some(
                              (claimed) =>
                                originalText!.items[claimed.index] === item &&
                                claimed.text === item.str
                            )
                          )
                        )
                    )
                  : [],
              verifiedPrefix =
                prefixOwners.length === 1 &&
                (await verifiedNativeLinkPrefix(
                  prefixBefore,
                  prefixAfter,
                  originalText,
                  text,
                  sourcePage,
                  translatedPage,
                  [moved.rect[0] - annotation.rect[0], moved.rect[1] - annotation.rect[1]]
                ))
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
              (typedReferenceRequired && !typedReferenceNumber) ||
              (nativeReferences.length === 1 && !repeatedNumericLabel && !verifiedRepeatedDated) ||
              (!verifiedUri &&
                !verifiedCollective &&
                !verifiedRepeatedDated &&
                (originalExactLabel
                  ? originalExactLabel.normalize('NFKC') !== sourceLabel.normalize('NFKC') &&
                    !partialSourceLabel &&
                    !verifiedPrefix &&
                    !repeatedNumericLabel
                  : (referenceNumber.test(sourceLabel)
                      ? numericOccurrences !== 1
                      : originalRun.split(sourceLabel).length !== 2) &&
                    !repeatedNumericLabel &&
                    !appendixLetter &&
                    !panelNumber &&
                    !typedReferenceNumber)) ||
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
                (!verifiedPrefix || prefixOwners.includes(unit)) &&
                (!typedReferenceNumber || typedOwners.includes(unit)) &&
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
            excluded?: ReadonlySet<number>
          ): string => {
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
      }
      if (!cancelled) {
        recordLayout(
          generatedUnits.flatMap(({ unit, sourceIndex, snapshot }) => {
            if (
              incremental &&
              !preservedIds.has(unit.id) &&
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
    })()
    void generation.finally(closeTargetExclusions).catch((error) => {
      if (!cancelled) {
        release()
        if (validating && cacheHit && !bypassCache) {
          setRequest({ ...request, bypassCache: { original, results: runResults } })
          return
        }
        // A failed candidate is never displayed. Rebuild its affected page from
        // the original source, then run the same independent verification again.
        // Each page can enter this fallback only once for this source; errors in
        // already-preserved content remain explicit instead of looping forever.
        const generationFailure = pdfGenerationFailure(error)
        if (validating && validationDetails)
          console.warn('[pdf-translation] Candidate verification rejected', {
            reason: validationDetails,
            pageNumber: validationPage,
            unitId: validationUnit
          })
        const failedPage = validating
          ? validationPage
          : generationFailure.pageLocal
            ? generationFailure.pageNumber
            : undefined
        if (
          !useArtifact &&
          failedPage !== undefined &&
          failedPage >= 1 &&
          failedPage <= original.numPages &&
          !originalPages.has(failedPage)
        ) {
          setRequest({
            ...request,
            bypassCache: { original, results: runResults },
            originalPages: {
              original,
              source: runResults.source,
              reasons: new Map(originalPages).set(
                failedPage,
                validating
                  ? { code: 'validation-failed', phase: 'verification' }
                  : {
                      code: generationFailure.code as PdfTranslationLayoutFailure['code'],
                      phase: 'generation'
                    }
              )
            }
          })
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
      nativeVerification.abort()
      setStored(undefined)
      if (!useArtifact) void api?.cancelPdf(id).catch(() => undefined)
      // Keep the verified display alive while its explicit replacement loads.
      // Source replacement and unmount release it through the display owner.
      if (live.current?.release !== release) release()
    }
  }, [
    admitted,
    original,
    artifact,
    beforeReady,
    request,
    useArtifact,
    selected,
    snapshot,
    structureContext,
    resourceRequestKey
  ])
  // Batch at page boundaries, never cancel a running generation for incoming paragraphs.
  // A failed early snapshot may be superseded once translation stops. Only
  // different ready-page content can retry automatically; unchanged errors stay explicit.
  const latestSnapshot = useMemo(
    () => (results ? partialPdfSnapshot(results) : undefined),
    [results]
  )
  useEffect(() => {
    const recoverNewResults =
      state.status === 'error' &&
      !translating &&
      ['timeout', 'worker-failed'].includes(state.failure.code)
    if (
      !admitted ||
      artifact ||
      !results ||
      !selected ||
      !snapshot ||
      !latestSnapshot ||
      (!(state.status === 'ready' && canDisplay) && !recoverNewResults)
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
    state,
    translating,
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
  return layout === 'reflow'
    ? reflow
    : {
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
