import { resolve } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { PDFDocument, PDFName, PDFString, StandardFonts, type PDFRef } from 'pdf-lib'
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
    prefix: string
    suffix: string
    translation: string
  }>('spacing-circumflex-native-roundtrip.jsonl')
)(
  'preserves spacing circumflex source proof and its neighbor through native fallback: $name',
  async ({ prefix, suffix, translation }) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.TimesRoman),
      page = pdf.addPage([600, 800]),
      x = 40 + font.widthOfTextAtSize(prefix, 10)
    page.drawText(prefix, { x: 40, y: 627, size: 10, font })
    page.drawText('ˆ', { x: x + 0.39, y: 629.14, size: 10, font })
    page.drawText('1', { x, y: 627, size: 10, font })
    page.drawText(')ˆ', { x: x + 5, y: 627, size: 10, font })
    page.drawText('1', { x: x + 9, y: 627, size: 10, font })
    page.drawText(suffix, { x: x + 15, y: 627, size: 10, font })
    page.drawText('Independent neighboring paragraph.', { x: 40, y: 600, size: 10, font })
    const bytes = new Uint8Array(await pdf.save()),
      loading = getDocument({ data: bytes.slice(), useSystemFonts: true }),
      registry = new ApplicationCallerLeaseRegistry()
    onTestFinished(() => registry.dispose())
    try {
      const original = await loading.promise,
        caller = registry.acquire({ leaseId: 'spacing-circumflex', surface: 'electron' }),
        extraction = await extractPdfTranslationSource({
          document: original,
          resourceRequestKey: 'synthetic-circumflex',
          signal: caller.lease.signal
        }),
        source = extraction.source
      expect(source.units).toHaveLength(2)
      expect(source.units[0].source).toContain('(x.ˆ1)ˆ1')
      const unit = {
        ...source.units[0],
        fragments: pdfTranslationLayoutFragments(source.units[0], source),
        translation
      }
      const writer = new PdfTranslationWriter(() =>
          resolve('resources/pdf-translation/worker.mjs')
        ),
        output = await writer.generateDetailed(
          {
            id: 'synthetic-circumflex',
            data: bytes,
            pages: source.pages,
            preserveUnsupported: true,
            units: [unit]
          },
          caller.lease
        )
      expect(output).not.toBeNull()
      const translated = getDocument({ data: output!.data.slice(), useSystemFonts: true })
      try {
        const failures = output!.layoutFailures,
          target = await translated.promise,
          verified = await verifyPdfUnits(
            target,
            [{ ...unit, sourceIndex: 0 }],
            failures,
            original
          ),
          preserved = await verifyPdfPreservation(original, target, [unit], failures, [1])
        expect(failures).toEqual([
          { code: 'font', phase: 'planning', pageNumbers: [1], fragmentCount: 1, unitIndex: 0 }
        ])
        expect(verified[0].retained).toBe(true)
        expect(preserved.pages.flatMap((entry) => entry.failures)).toEqual([])
        expect(preserved.pages[0].pixels!.changedPixels).toBe(0)
      } finally {
        await translated.destroy()
      }
      // A numeral absent from the native source must still fail strict proof.
      await expect(
        writer.generateDetailed(
          {
            id: 'synthetic-circumflex-wrong-source',
            data: bytes,
            pages: source.pages,
            preserveUnsupported: true,
            units: [{ ...unit, source: unit.source.replace('(x.ˆ1)ˆ1', '(x.ˆ2)ˆ1') }]
          },
          caller.lease
        )
      ).rejects.toThrow('[pdf-generation:source-mismatch:1]')
    } finally {
      await loading.destroy()
    }
  }
)

it.each(
  readPdfTranslationCases<{
    name: string
    prefix: string
    suffix: string
    expected: string
    translation: string
  }>('spacing-grave-native-prose.jsonl')
)(
  'preserves a native grave in prose through complete backfill: $name',
  async ({ prefix, suffix, expected, translation }) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.TimesRoman),
      page = pdf.addPage([600, 800]),
      x = 40 + font.widthOfTextAtSize(prefix, 10)
    page.drawText(prefix, { x: 40, y: 700, size: 10, font })
    page.drawText('`', { x: x + 0.55, y: 700.05, size: 10, font })
    page.drawText(suffix, { x, y: 700, size: 10, font })
    page.drawText('Independent neighboring paragraph.', { x: 40, y: 675, size: 10, font })
    const bytes = new Uint8Array(await pdf.save()),
      loading = getDocument({ data: bytes.slice(), useSystemFonts: true }),
      registry = new ApplicationCallerLeaseRegistry()
    onTestFinished(() => registry.dispose())
    onTestFinished(() => loading.destroy())
    const original = await loading.promise,
      caller = registry.acquire({ leaseId: 'native-grave', surface: 'electron' }),
      { source } = await extractPdfTranslationSource({
        document: original,
        resourceRequestKey: 'native-grave',
        signal: caller.lease.signal
      })
    expect(source.units).toHaveLength(2)
    expect(source.units[0].source).toBe(expected)
    const unit = {
        ...source.units[0],
        fragments: pdfTranslationLayoutFragments(source.units[0], source),
        translation
      },
      writer = new PdfTranslationWriter(() => resolve('resources/pdf-translation/worker.mjs')),
      input = {
        id: 'native-grave',
        data: bytes,
        pages: source.pages,
        preserveUnsupported: true,
        units: [unit]
      },
      output = await writer.generateDetailed(input, caller.lease)
    expect(output).not.toBeNull()
    const translated = getDocument({ data: output!.data.slice(), useSystemFonts: true })
    onTestFinished(() => translated.destroy())
    const target = await translated.promise,
      placement = await verifyPdfUnits(
        target,
        [{ ...unit, sourceIndex: 0 }],
        output!.layoutFailures,
        original
      ),
      preservation = await verifyPdfPreservation(
        original,
        target,
        [unit],
        output!.layoutFailures,
        [1]
      )
    expect(output!.layoutFailures).toEqual([])
    expect(placement[0].translationFound).toBe(true)
    expect(preservation.pages.flatMap((entry) => entry.failures)).toEqual([])
    expect(preservation.pages[0].pixels!.changedPixels).toBe(0)
    await expect(
      writer.generateDetailed(
        {
          ...input,
          id: 'native-grave-wrong-source',
          units: [{ ...unit, source: expected.replace('Cova', 'Covaq') }]
        },
        caller.lease
      )
    ).rejects.toThrow('[pdf-generation:source-mismatch:1]')
  }
)

it.each(
  readPdfTranslationCases<{
    name: string
    body: string
    marker: string
    translation: string
    fitted: boolean
  }>('sentence-footnote-native-roundtrip.jsonl')
)(
  'parses and backfills a sentence with linked raised markers: $name',
  async ({ body, marker, translation, fitted }) => {
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.TimesRoman)
    const page = pdf.addPage([600, 800])
    const baseline = 650
    page.drawText(body, { font, size: 10, x: 40, y: baseline })
    const markerX = 40 + font.widthOfTextAtSize(body, 10)
    const markerWidth = font.widthOfTextAtSize(marker, 7)
    page.drawText(marker, { font, size: 7, x: markerX, y: baseline + 3.7 })
    page.drawText('Independent neighboring paragraph.', { font, size: 10, x: 40, y: 600 })
    const annotation = (rect: number[], uri: string): PDFRef =>
      pdf.context.register(
        pdf.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: rect,
          Border: [0, 0, 0],
          A: { S: 'URI', URI: PDFString.of(uri) }
        })
      )
    const links = [
      annotation([markerX, 653, markerX + markerWidth, 660], 'https://example.invalid/note')
    ]
    if (body.includes('Table 6')) {
      const numberX = 40 + font.widthOfTextAtSize(body.slice(0, body.indexOf('6')), 10)
      links.push(
        annotation(
          [numberX, 648, numberX + font.widthOfTextAtSize('6', 10), 658],
          'https://example.invalid/table'
        )
      )
    }
    page.node.set(PDFName.of('Annots'), pdf.context.obj(links))
    const original = getDocument({ data: await pdf.save(), useSystemFonts: true })
    onTestFinished(() => original.destroy())
    const registry = new ApplicationCallerLeaseRegistry()
    onTestFinished(() => registry.dispose())
    const caller = registry.acquire({
      leaseId: 'synthetic-structural-roundtrip',
      surface: 'electron'
    })
    const document = await original.promise
    const { source, coverage } = await extractPdfTranslationSource({
      document,
      resourceRequestKey: 'synthetic-structure',
      signal: caller.lease.signal
    })
    expect(coverage.excludedItemCount).toBe(0)
    const owner = source.units.find(
      (unit) => unit.source.startsWith('Inspect') || unit.source.startsWith('Its')
    )!
    expect(owner.source).toBe(body + ' ' + marker)
    expect(owner.sourceOnly).toBeUndefined()
    expect(owner.source).not.toContain('Independent neighboring')
    const fragments = pdfTranslationLayoutFragments(owner, source)
    const result = await new PdfTranslationWriter(() =>
      resolve('resources/pdf-translation/worker.mjs')
    ).generateDetailed(
      {
        id: 'synthetic-native-roundtrip',
        data: await document.getData(),
        pages: source.pages,
        preserveUnsupported: true,
        units: [{ ...owner, fragments, translation }]
      },
      caller.lease
    )
    expect(result).not.toBeNull()
    expect(result!.layoutFailures).toHaveLength(fitted ? 0 : 1)
    const output = getDocument({ data: result!.data.slice(), useSystemFonts: true })
    onTestFinished(() => output.destroy())
    const target = await output.promise
    const placement = await verifyPdfUnits(
      target,
      [{ ...owner, fragments, translation, sourceIndex: 0 }],
      result!.layoutFailures,
      document
    )
    expect(placement[0].translationFound).toBe(fitted)
    const preservation = await verifyPdfPreservation(
      document,
      target,
      [{ ...owner, fragments }],
      result!.layoutFailures,
      [1]
    )
    expect(preservation.pages.flatMap((page) => page.failures)).toEqual([])
    expect(preservation.pages[0].pixels!.changedPixels).toBe(0)
    const sourceLinks = await (await document.getPage(1)).getAnnotations()
    const outputLinks = await (await target.getPage(1)).getAnnotations()
    expect(outputLinks.map((link) => link.url).sort()).toEqual(
      sourceLinks.map((link) => link.url).sort()
    )
  }
)
