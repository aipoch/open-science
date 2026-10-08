import { resolve } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { ApplicationCallerLeaseRegistry } from '../../caller-lifecycle'
import { PdfTranslationWriter } from './writer'
import { extractPdfTranslationSource } from '../../../renderer/src/pages/workspace/previews/renderers/pdf-translation-extraction'
import { pdfTranslationLayoutFragments } from '../../../renderer/src/pages/workspace/previews/renderers/pdf-translation-fragments'
import type { PdfTranslationPdfRequest } from '../../../shared/pdf-translation'
import { readPdfTranslationCases } from '../../../../test/fixtures/pdf-translation/read-cases'
import { verifyPdfUnits } from '../../../../test/pdf-translation-native-verification'
import { verifyPdfPreservation } from '../../../../test/pdf-translation-preservation'

it.each(
  readPdfTranslationCases<{
    name: string
    source: string
    translation: string
    label: string
    nativeLeading: string
    nativeTranslationPrefix: string
    nativeFitted: boolean
  }>('spacing-grave-linked-identity.jsonl')
)(
  'backfills encoded grave citations only with complete link identity: $name',
  async ({
    source: expectedSource,
    translation,
    label,
    nativeLeading,
    nativeTranslationPrefix,
    nativeFitted
  }) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.TimesRoman),
      page = pdf.addPage([600, 800]),
      [prefix, suffix] = expectedSource.split('`'),
      accentX = 40 + font.widthOfTextAtSize(prefix, 10)
    page.drawText(nativeLeading, { x: 40, y: 713.2, size: 10, font })
    page.drawText(prefix, { x: 40, y: 700, size: 10, font })
    page.drawText('`', { x: accentX + 0.55, y: 700.05, size: 10, font })
    page.drawText(suffix, { x: accentX, y: 700, size: 10, font })
    page.drawText('Independent neighboring paragraph.', { x: 40, y: 660, size: 10, font })
    page.node.set(
      PDFName.of('Annots'),
      pdf.context.obj(
        [label, '2037'].map((text) => {
          const x =
            40 +
            font.widthOfTextAtSize(
              expectedSource.slice(0, expectedSource.indexOf(text)).replace('`', ''),
              10
            )
          return pdf.context.register(
            pdf.context.obj({
              Type: 'Annot',
              Subtype: 'Link',
              Rect: [x, 698, x + font.widthOfTextAtSize(text.replace('`', ''), 10), 708],
              Border: [0, 0, 0],
              A: { S: 'URI', URI: PDFString.of('https://example.invalid/reference') }
            })
          )
        })
      )
    )
    const bytes = new Uint8Array(await pdf.save()),
      loading = getDocument({ data: bytes.slice(), useSystemFonts: true }),
      registry = new ApplicationCallerLeaseRegistry()
    onTestFinished(() => loading.destroy())
    onTestFinished(() => registry.dispose())
    const original = await loading.promise,
      caller = registry.acquire({ leaseId: 'linked-grave', surface: 'electron' }),
      { source } = await extractPdfTranslationSource({
        document: original,
        resourceRequestKey: 'linked-grave',
        signal: caller.lease.signal
      })
    expect(source.units).toHaveLength(2)
    expect(source.units[0].source).toBe(nativeLeading + ' ' + expectedSource)
    const unit = {
        ...source.units[0],
        fragments: pdfTranslationLayoutFragments(source.units[0], source),
        translation: nativeTranslationPrefix + translation
      },
      result = await new PdfTranslationWriter(() =>
        resolve('resources/pdf-translation/worker.mjs')
      ).generateDetailed(
        {
          id: 'linked-grave',
          data: bytes,
          pages: source.pages,
          preserveUnsupported: true,
          units: [unit]
        },
        caller.lease
      )
    expect(result).not.toBeNull()
    expect(result!.layoutFailures).toEqual(
      nativeFitted
        ? []
        : [
            {
              unitIndex: 0,
              code: 'annotations',
              phase: 'planning',
              pageNumbers: [1],
              fragmentCount: 1
            }
          ]
    )
    const output = getDocument({ data: result!.data.slice(), useSystemFonts: true })
    onTestFinished(() => output.destroy())
    const target = await output.promise,
      placements = await verifyPdfUnits(
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
    expect(placements[0].translationFound).toBe(nativeFitted)
    expect(preservation.pages.flatMap((entry) => entry.failures)).toEqual([])
    expect(preservation.pages[0].pixels!.changedPixels).toBe(0)
    expect((await (await target.getPage(1)).getAnnotations()).map((link) => link.url)).toEqual([
      'https://example.invalid/reference',
      'https://example.invalid/reference'
    ])
  }
)

it.each(
  readPdfTranslationCases<{
    name: string
    pages: Array<{
      runs: Array<{ text: string; x: number; y: number; size: number }>
      fragment: PdfTranslationPdfRequest['units'][number]['fragments'][number]
    }>
    links: Array<{ page: number; uri: string; rect: number[] }>
    source: string
    translation: string
    neighbor: string
    expectedCode: string | null
  }>('dense-linked-cross-page-prose.jsonl')
)(
  'preserves full dense cross-page paragraphs, link actions and neighbors: $name',
  async ({ pages, links, source, translation, neighbor, expectedCode }) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.TimesRoman)
    for (const [index, entry] of pages.entries()) {
      const page = pdf.addPage([612, 792])
      for (const run of entry.runs)
        page.drawText(run.text, { x: run.x, y: run.y, size: run.size, font })
      page.drawText(neighbor, { x: 108, y: index === 0 ? 80 : 390, size: 10, font })
      page.node.set(
        PDFName.of('Annots'),
        pdf.context.obj(
          links
            .filter((link) => link.page === index + 1)
            .map((link) =>
              pdf.context.register(
                pdf.context.obj({
                  Type: 'Annot',
                  Subtype: 'Link',
                  Rect: link.rect,
                  Border: [0, 0, 0],
                  A: { S: 'URI', URI: PDFString.of(link.uri) }
                })
              )
            )
        )
      )
    }
    expect(pages.flatMap((page) => page.runs.map((run) => run.text)).join(' ')).toBe(source)
    const bytes = new Uint8Array(await pdf.save()),
      loading = getDocument({ data: bytes.slice(), useSystemFonts: true }),
      registry = new ApplicationCallerLeaseRegistry()
    onTestFinished(() => loading.destroy())
    onTestFinished(() => registry.dispose())
    const original = await loading.promise,
      caller = registry.acquire({ leaseId: 'dense-linked-prose', surface: 'electron' }),
      unit = { source, translation, fragments: pages.map((page) => page.fragment) },
      input = {
        id: 'dense-linked-prose',
        data: bytes,
        pages: pages.map(() => ({ width: 612, height: 792 })),
        preserveUnsupported: true,
        units: [unit]
      },
      writer = new PdfTranslationWriter(() => resolve('resources/pdf-translation/worker.mjs')),
      result = await writer.generateDetailed(input, caller.lease)
    expect(result).not.toBeNull()
    expect(result!.layoutFailures).toEqual(
      expectedCode
        ? [
            {
              unitIndex: 0,
              code: expectedCode,
              phase: 'planning',
              pageNumbers: [1, 2],
              fragmentCount: 2
            }
          ]
        : []
    )
    const output = getDocument({ data: result!.data.slice(), useSystemFonts: true })
    onTestFinished(() => output.destroy())
    const target = await output.promise,
      placements = await verifyPdfUnits(
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
        [1, 2]
      )
    expect(placements[0].translationFound).toBe(!expectedCode)
    expect(preservation.pages.flatMap((entry) => entry.failures)).toEqual([])
    expect(preservation.pages.map((entry) => entry.pixels!.changedPixels)).toEqual([0, 0])
    for (const pageNumber of [1, 2]) {
      const sourceLinks = await (await original.getPage(pageNumber)).getAnnotations(),
        targetLinks = await (await target.getPage(pageNumber)).getAnnotations()
      expect(targetLinks.map((link) => link.url).sort()).toEqual(
        sourceLinks.map((link) => link.url).sort()
      )
      if (!expectedCode) {
        const content = await (await target.getPage(pageNumber)).getTextContent(),
          prose = content.items.filter((item) => 'str' in item && /\p{Script=Han}/u.test(item.str))
        expect(prose.length).toBeGreaterThan(0)
        for (const item of prose) {
          if ('str' in item)
            expect(Math.hypot(item.transform[0], item.transform[1])).toBeGreaterThanOrEqual(8)
        }
      }
    }
    await expect(
      writer.generateDetailed(
        {
          ...input,
          units: [
            { ...unit, source: source.replace('independent observation', 'invented observation') }
          ]
        },
        caller.lease
      )
    ).rejects.toThrow('[pdf-generation:source-mismatch:2]')
  }
)
