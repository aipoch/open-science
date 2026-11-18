import { expect, it, onTestFinished } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { resolve } from './paths.js'
import { TestCallerRegistry } from './support/callers.js'
import { PdfTranslationWriter } from '../src/writer.js'
import { extractPdfTranslationSource } from '../src/reader/extraction.js'
import { verifyPdfPreservation } from './support/pdf-translation-preservation.js'
import { verifyPdfUnits } from './support/pdf-translation-native-verification.js'
import { readPdfTranslationCases } from './fixtures/read-cases.js'

it.each(
  readPdfTranslationCases<{ name: string; base: string; translation: string }>(
    'native-script-atomicity-roundtrip.jsonl'
  )
)(
  'moves a whitespace-separated native power with its base: $name',
  async ({ base: identifier, translation }) => {
    const pdf = await PDFDocument.create(),
      roman = await pdf.embedFont(StandardFonts.TimesRoman),
      italic = await pdf.embedFont(StandardFonts.TimesRomanItalic),
      symbol = await pdf.embedFont(StandardFonts.Symbol),
      page = pdf.addPage([600, 800]),
      registry = new TestCallerRegistry(),
      caller = registry.acquire({ leaseId: 'native-power-boundary', surface: 'electron' })
    onTestFinished(() => registry.dispose())
    page.drawText('A description of the observed response and its measured rate.', {
      x: 40,
      y: 500,
      font: roman,
      size: 10
    })
    page.drawText('The inset shows ', { x: 40, y: 470, font: roman, size: 10 })
    let x = 40 + roman.widthOfTextAtSize('The inset shows ', 10)
    page.drawText(identifier, { x, y: 470, font: italic, size: 10 })
    x += italic.widthOfTextAtSize(identifier, 10) + 1.5
    page.drawText('−', { x, y: 473.5, font: symbol, size: 7.5 })
    x += symbol.widthOfTextAtSize('−', 7.5) + 0.5
    page.drawText('2', { x, y: 473.5, font: roman, size: 7.5 })
    x += roman.widthOfTextAtSize('2', 7.5) + 3
    page.drawText(' versus time.', { x, y: 470, font: roman, size: 10 })
    const neighbor = 'An independent paragraph stays unchanged.'
    page.drawText(neighbor, { x: 40, y: 430, font: roman, size: 10 })
    const data = new Uint8Array(await pdf.save()),
      loading = getDocument({ data: data.slice(), useSystemFonts: true })
    onTestFinished(() => loading.destroy())
    const original = await loading.promise,
      { source } = await extractPdfTranslationSource({
        document: original,
        resourceRequestKey: 'native-power-boundary',
        signal: caller.lease.signal
      })
    const rows = source.units.filter((unit) => !unit.source.includes(neighbor))
    expect(rows).toHaveLength(2)
    const unit = {
      ...rows[0],
      source: rows.map((row) => row.source).join(' '),
      fragments: rows.flatMap((row) => row.fragments),
      translation
    }
    expect(unit.fragments).toHaveLength(2)
    expect(unit.source).toContain(`${identifier} −2`)
    const writer = new PdfTranslationWriter(() => resolve('resources/worker.mjs'))
    const result = await writer.generateDetailed(
      {
        id: 'native-power-boundary',
        data,
        pages: source.pages,
        preserveUnsupported: true,
        units: [unit]
      },
      caller.lease
    )
    expect(result!.layoutFailures).toEqual([])
    const translated = getDocument({ data: result!.data.slice(), useSystemFonts: true })
    onTestFinished(() => translated.destroy())
    const target = await translated.promise,
      items = (await (await target.getPage(1)).getTextContent()).items.filter(
        (item) => 'str' in item
      )
    const base = items.find((item) => item.str.includes(identifier))!,
      minus = items.find((item) => item.str === '−')!,
      exponent = items.find((item) => item.str === '2')!
    expect(base).toBeDefined()
    expect(minus).toBeDefined()
    expect(exponent).toBeDefined()
    expect(base.str).toBe(identifier)
    expect(base.transform[5]).toBeCloseTo(470, 3)
    expect(minus.transform[4]).toBeGreaterThan(base.transform[4])
    const placement = await verifyPdfUnits(target, [{ ...unit, sourceIndex: 0 }], [], original)
    expect(placement[0]).toMatchObject({ translationFound: true, retained: false })
    expect(minus.transform[5] - base.transform[5]).toBeCloseTo(3.5, 3)
    expect(exponent.transform[5]).toBeCloseTo(minus.transform[5], 3)
    expect(minus.transform[3]).toBeCloseTo(7.5, 3)
    expect(exponent.transform[3]).toBeCloseTo(7.5, 3)
    const preservation = await verifyPdfPreservation(original, target, [unit], [], [1])
    expect(preservation.pages.flatMap((page) => page.failures)).toEqual([])
  }
)
