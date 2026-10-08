import { resolve } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { PDFDocument, StandardFonts, type PDFFont } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { ApplicationCallerLeaseRegistry } from '../../caller-lifecycle'
import { PdfTranslationWriter } from './writer'
import { extractPdfTranslationSource } from '../../../renderer/src/pages/workspace/previews/renderers/pdf-translation-extraction'
import { pdfTranslationLayoutFragments } from '../../../renderer/src/pages/workspace/previews/renderers/pdf-translation-fragments'
import { readPdfTranslationCases } from '../../../../test/fixtures/pdf-translation/read-cases'
import { verifyPdfUnits } from '../../../../test/pdf-translation-native-verification'
import { verifyPdfPreservation } from '../../../../test/pdf-translation-preservation'

it.each(
  readPdfTranslationCases<{
    name: string
    translation: string
    expectedCode: string | null
  }>('wrapped-parameter-native-roundtrip.jsonl')
)(
  'places the complete native parameter paragraph: $name',
  async ({ name, translation, expectedCode }) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.TimesRoman),
      variable = await pdf.embedFont(StandardFonts.TimesRomanItalic),
      page = pdf.addPage([600, 800]),
      leading =
        'The controlled network uses a shared implementation and a stable training task. For the independent branches,'
    page.drawText(leading, { x: 40, y: 700, size: 10, font })
    let x = 40
    const draw = (text: string, face: PDFFont = font, point = 10, y = 688): void => {
      page.drawText(text, { x, y, size: point, font: face })
      x += face.widthOfTextAtSize(text, point)
    }
    draw('h', variable)
    draw(' = 15 and ')
    draw('d', variable)
    draw('k', variable, 7, 686.5)
    draw(' = ')
    draw('d', variable)
    draw('v', variable, 7, 686.5)
    draw(' = 72. ')
    draw('The feedforward layers have hidden size ')
    draw('d', variable)
    draw('ff', variable, 7, 686.5)
    draw(' = 4096.')
    draw(' The same matched budgets apply.')
    page.drawText('Independent neighboring paragraph remains unchanged.', {
      x: 40,
      y: 660,
      size: 10,
      font
    })
    const bytes = new Uint8Array(await pdf.save()),
      loading = getDocument({ data: bytes.slice(), useSystemFonts: true }),
      registry = new ApplicationCallerLeaseRegistry()
    onTestFinished(() => loading.destroy())
    onTestFinished(() => registry.dispose())
    const original = await loading.promise,
      caller = registry.acquire({ leaseId: name, surface: 'electron' }),
      { source } = await extractPdfTranslationSource({
        document: original,
        resourceRequestKey: name,
        signal: caller.lease.signal
      })
    expect(source.units).toHaveLength(2)
    expect(source.units[0].source).toBe(
      leading +
        ' h = 15 and dk = dv = 72. The feedforward layers have hidden size dff = 4096. The same matched budgets apply.'
    )
    expect(source.units[0].sourceOnly).toBeUndefined()
    const unit = {
        ...source.units[0],
        fragments: pdfTranslationLayoutFragments(source.units[0], source),
        translation
      },
      result = await new PdfTranslationWriter(() =>
        resolve('resources/pdf-translation/worker.mjs')
      ).generateDetailed(
        { id: name, data: bytes, pages: source.pages, preserveUnsupported: true, units: [unit] },
        caller.lease
      )
    expect(result!.layoutFailures.map((failure) => failure.code)).toEqual(
      expectedCode ? [expectedCode] : []
    )
    const output = getDocument({ data: result!.data.slice(), useSystemFonts: true })
    onTestFinished(() => output.destroy())
    const target = await output.promise,
      verification = await verifyPdfUnits(
        target,
        [{ ...unit, sourceIndex: 0 }],
        result!.layoutFailures,
        original
      ),
      preservation = await verifyPdfPreservation(
        original,
        target,
        [unit],
        result!.layoutFailures,
        [1]
      )
    expect(verification[0]).toMatchObject({
      retained: !!expectedCode,
      translationFound: !expectedCode
    })
    expect(preservation.pages.flatMap((page) => page.failures)).toEqual([])
    expect(preservation.pages[0].pixels!.changedPixels).toBe(0)
  }
)
