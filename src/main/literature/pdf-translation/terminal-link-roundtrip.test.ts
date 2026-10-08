import { resolve } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib'
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
    kind: string
    translation: string
    expectedCode: string | null
    citationStop?: boolean
  }>('citation-footnote-native-roundtrip.jsonl').concat(
    readPdfTranslationCases('citation-stop-footnote-native-roundtrip.jsonl')
  )
)(
  'preserves the full paragraph and native link: $name',
  async ({ name, kind, translation, expectedCode, citationStop }) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.TimesRoman),
      page = pdf.addPage([600, 800]),
      leading = citationStop
        ? 'The complete comparison records the independent observations (Doran et al., 2037).'
        : 'The complete controlled paragraph records independent observations for every stable comparison.'
    page.drawText(leading, { x: 40, y: 700, size: 10, font })
    let x: number, y: number, width: number, sourceText: string
    if (kind === 'citation') {
      const stem = 'The retained result follows ',
        label = '[Doran et al.'
      x = 40 + font.widthOfTextAtSize(stem, 10)
      y = 688
      width = font.widthOfTextAtSize(label, 10)
      page.drawText(stem, { x: 40, y, size: 10, font })
      page.drawText(label, { x, y, size: 10, font })
      page.drawText(', 2037].', { x: x + width, y, size: 10, font })
      sourceText = leading + ' ' + stem + label + ', 2037].'
    } else {
      const point = kind === 'body-number' ? 10 : 7
      x = 40 + font.widthOfTextAtSize(leading, 10)
      y = kind === 'body-number' ? 700 : 703.5
      width = font.widthOfTextAtSize('8', point)
      page.drawText('8', { x, y, size: point, font })
      const tail = 'The entire paragraph retains the fixed settings and neighboring boundaries.'
      page.drawText(tail, { x: 40, y: 688, size: 10, font })
      sourceText = leading + (kind === 'body-number' ? '8 ' : ' 8 ') + tail
    }
    page.drawText('Independent neighboring paragraph remains unchanged.', {
      x: 40,
      y: 660,
      size: 10,
      font
    })
    page.node.set(
      PDFName.of('Annots'),
      pdf.context.obj([
        pdf.context.register(
          pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [x - 0.5, y - 1, x + width + 0.5, y + 8],
            Border: [0, 0, 0],
            A: { S: 'URI', URI: PDFString.of('https://example.invalid/controlled-reference') }
          })
        )
      ])
    )
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
    expect(source.units[0].source).toBe(sourceText)
    const unit = {
        ...source.units[0],
        source: citationStop ? source.units[0].source.replace('. 8', '.8') : source.units[0].source,
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

it.each(
  readPdfTranslationCases<{
    name: string
    reference: string
    translation: string
    expectedCode: string | null
  }>('terminal-numbered-link-native-roundtrip.jsonl')
)(
  'backfills the entire paragraph with its native terminal link: $name',
  async ({ name, reference, translation, expectedCode }) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.TimesRoman),
      page = pdf.addPage([600, 800]),
      point = 10,
      leading = 'The complete controlled paragraph records independent observations.',
      stem =
        'All measured samples remain in the same comparison, as summarized in ' + reference + ' ',
      x = 40 + font.widthOfTextAtSize(stem, point),
      numberWidth = font.widthOfTextAtSize('8', point),
      stopWidth = font.widthOfTextAtSize('.', point)
    page.drawText(leading, { x: 40, y: 700, size: point, font })
    page.drawText(stem, { x: 40, y: 688, size: point, font })
    page.drawText('8', { x, y: 688, size: point, font })
    page.drawText('.', { x: x + numberWidth, y: 688, size: point, font })
    page.drawText('Independent neighboring paragraph remains unchanged.', {
      x: 40,
      y: 660,
      size: point,
      font
    })
    page.node.set(
      PDFName.of('Annots'),
      pdf.context.obj([
        pdf.context.register(
          pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [x - 0.5, 686, x + numberWidth + stopWidth + 0.5, 696],
            Border: [0, 0, 0],
            A: { S: 'URI', URI: PDFString.of('https://example.invalid/controlled-result') }
          })
        )
      ])
    )
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
    expect(source.units[0].source).toBe(leading + ' ' + stem + '8.')
    expect(source.units[0].fragments.flatMap((fragment) => fragment.items)).toHaveLength(4)
    const unit = {
        ...source.units[0],
        fragments: pdfTranslationLayoutFragments(source.units[0], source),
        translation
      },
      result = await new PdfTranslationWriter(() =>
        resolve('resources/pdf-translation/worker.mjs')
      ).generateDetailed(
        {
          id: name.replace(/\W+/gu, '-'),
          data: bytes,
          pages: source.pages,
          preserveUnsupported: true,
          units: [unit]
        },
        caller.lease
      )
    expect(result).not.toBeNull()
    expect(result!.layoutFailures).toEqual(
      expectedCode
        ? [
            {
              unitIndex: 0,
              code: expectedCode,
              phase: 'planning',
              pageNumbers: [1],
              fragmentCount: 1
            }
          ]
        : []
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
