import { resolve } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import {
  PDFDocument,
  StandardFonts,
  pushGraphicsState,
  popGraphicsState,
  scale,
  type PDFPage
} from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { ApplicationCallerLeaseRegistry } from '../../caller-lifecycle'
import { PdfTranslationWriter } from './writer'
import { extractPdfTranslationSource } from '../../../renderer/src/pages/workspace/previews/renderers/pdf-translation-extraction'
import { pdfTranslationLayoutFragments } from '../../../renderer/src/pages/workspace/previews/renderers/pdf-translation-fragments'
import { readPdfTranslationCases } from '../../../../test/fixtures/pdf-translation/read-cases'
import { verifyPdfUnits } from '../../../../test/pdf-translation-native-verification'
import { verifyPdfPreservation } from '../../../../test/pdf-translation-preservation'

type Wide = {
  name: string
  kind: 'wide-caption'
  witnessRows: string[]
  tail: string
  captionRows: string[]
  continuation: string[]
  translation: string
}
type Notes = {
  name: string
  kind: 'footnotes'
  first: string
  second: string
  tail: string
  translations: string[]
}

it.each<Wide | Notes>([
  ...readPdfTranslationCases<Wide>('wide-caption-native-roundtrip.jsonl'),
  ...readPdfTranslationCases<Notes>('symbolic-footnote-native-roundtrip.jsonl')
])(
  'backfills complete repaired sources while preserving adjacent native content: $name',
  async (fixture) => {
    const pdf = await PDFDocument.create(),
      roman = await pdf.embedFont(StandardFonts.TimesRoman),
      symbol = await pdf.embedFont(StandardFonts.Symbol),
      first = pdf.addPage([600, 800]),
      registry = new ApplicationCallerLeaseRegistry(),
      caller = registry.acquire({ leaseId: fixture.name, surface: 'electron' })
    onTestFinished(() => registry.dispose())
    const row = (
      page: PDFPage,
      text: string,
      x: number,
      y: number,
      size: number,
      width?: number
    ): void => {
      const factor = width ? width / roman.widthOfTextAtSize(text, size) : 1
      expect(factor).toBeGreaterThan(0.95)
      expect(factor).toBeLessThan(1.05)
      page.pushOperators(pushGraphicsState(), scale(factor, 1))
      page.drawText(text, { x: x / factor, y, font: roman, size })
      page.pushOperators(popGraphicsState())
    }
    if (fixture.kind === 'wide-caption') {
      fixture.witnessRows.forEach((text, index) => row(first, text, 310, 640 - 12 * index, 10, 220))
      row(first, fixture.tail, 320, 70, 10)
      const next = pdf.addPage([600, 800])
      next.drawRectangle({ x: 50, y: 660, width: 470, height: 90, borderWidth: 1 })
      fixture.captionRows.forEach((text, index) =>
        row(next, text, 40, 620 - 11 * index, 9, index ? undefined : 490)
      )
      const [start, scalar, rest, end] = fixture.continuation,
        natural =
          roman.widthOfTextAtSize(start + ' ' + rest, 10) +
          symbol.widthOfTextAtSize(scalar, 10) +
          2.5,
        factor = 220 / natural
      expect(factor).toBeGreaterThan(0.95)
      expect(factor).toBeLessThan(1.05)
      next.pushOperators(pushGraphicsState(), scale(factor, 1))
      let x = 40 / factor
      next.drawText(start + ' ', { x, y: 577, font: roman, size: 10 })
      x += roman.widthOfTextAtSize(start + ' ', 10)
      next.drawText(scalar, { x, y: 577, font: symbol, size: 10 })
      x += symbol.widthOfTextAtSize(scalar, 10) + 2.5
      next.drawText(rest, { x, y: 577, font: roman, size: 10 })
      next.pushOperators(popGraphicsState())
      row(next, end, 40, 565, 10)
      row(next, 'Independent neighboring paragraph remains unchanged.', 40, 530, 10)
    } else {
      row(first, 'Independent body text establishes the document font and stays', 40, 650, 10)
      row(first, 'separate from all attribution notes at the bottom of this page.', 40, 638, 10)
      first.drawText('†', { x: 58, y: 107, font: roman, size: 6 })
      row(first, fixture.first, 62, 103, 9)
      first.drawText('‡', { x: 58, y: 96, font: roman, size: 6 })
      row(first, fixture.second, 62, 92, 9)
      row(first, fixture.tail, 40, 81, 9)
    }
    const data = new Uint8Array(await pdf.save()),
      loading = getDocument({ data: data.slice(), useSystemFonts: true })
    onTestFinished(() => loading.destroy())
    const original = await loading.promise,
      { source } = await extractPdfTranslationSource({
        document: original,
        resourceRequestKey: fixture.name,
        signal: caller.lease.signal
      }),
      paragraphs =
        fixture.kind === 'wide-caption'
          ? [source.units.find((unit) => unit.source.startsWith(fixture.tail))!]
          : [
              source.units.find((unit) => unit.source.includes(fixture.first))!,
              source.units.find((unit) => unit.source.includes(fixture.second))!
            ]
    expect(paragraphs.every(Boolean)).toBe(true)
    if (fixture.kind === 'wide-caption') {
      expect(paragraphs[0].source).toContain(fixture.continuation.at(-1))
      expect(paragraphs[0].fragments).toHaveLength(2)
      expect(paragraphs[0].source).not.toMatch(/Figure|Independent/u)
    } else {
      expect(paragraphs[1].source).toContain(fixture.tail)
      expect(paragraphs[0]).not.toBe(paragraphs[1])
      expect(paragraphs[1].source).not.toContain(fixture.first)
    }
    const translations =
        fixture.kind === 'wide-caption' ? [fixture.translation] : fixture.translations,
      units = paragraphs.map((unit, index) => ({
        ...unit,
        fragments: pdfTranslationLayoutFragments(unit, source),
        translation: translations[index]
      })),
      writer = new PdfTranslationWriter(() => resolve('resources/pdf-translation/worker.mjs')),
      input = { id: fixture.name, data, pages: source.pages, preserveUnsupported: true, units },
      output = await writer.generateDetailed(input, caller.lease)
    expect(output!.layoutFailures).toEqual([])
    const translated = getDocument({ data: output!.data.slice(), useSystemFonts: true })
    onTestFinished(() => translated.destroy())
    const target = await translated.promise,
      placement = await verifyPdfUnits(
        target,
        units.map((unit, sourceIndex) => ({ ...unit, sourceIndex })),
        [],
        original
      ),
      preservation = await verifyPdfPreservation(
        original,
        target,
        units,
        [],
        source.pages.map((_, index) => index + 1)
      )
    expect(placement.every((unit) => unit.translationFound && !unit.retained)).toBe(true)
    expect(preservation.pages.flatMap((page) => page.failures)).toEqual([])
    expect(preservation.pages.every((page) => page.pixels!.changedPixels === 0)).toBe(true)
    await expect(
      writer.generateDetailed(
        { ...input, units: [{ ...units[0], source: units[0].source + ' invented source' }] },
        caller.lease
      )
    ).rejects.toThrow('source-mismatch')
    const expanded = units.map((unit) => ({
        ...unit,
        translation: unit.translation + '额外的普通正文继续说明结果。'.repeat(100)
      })),
      fallback = await writer.generateDetailed({ ...input, units: expanded }, caller.lease)
    expect(fallback!.layoutFailures).toHaveLength(units.length)
    expect(fallback!.layoutFailures.every((failure) => failure.code === 'overflow')).toBe(true)
    const kept = getDocument({ data: fallback!.data.slice(), useSystemFonts: true })
    onTestFinished(() => kept.destroy())
    const protection = await verifyPdfPreservation(
      original,
      await kept.promise,
      expanded,
      fallback!.layoutFailures,
      source.pages.map((_, index) => index + 1)
    )
    expect(protection.pages.flatMap((page) => page.failures)).toEqual([])
    expect(protection.pages.every((page) => page.pixels!.changedPixels === 0)).toBe(true)
  }
)
