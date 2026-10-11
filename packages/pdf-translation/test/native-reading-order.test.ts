import { resolve } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { TestCallerRegistry } from './support/callers.js'
import { PdfTranslationWriter } from '../src/writer.js'
import { extractPdfTranslationSource } from '../src/reader/extraction.js'
import { readPdfTranslationCases } from './fixtures/read-cases.js'
import { verifyPdfPreservation } from './support/pdf-translation-preservation.js'

const cases = readPdfTranslationCases<{
  name: string
  draws: [number, number, number, string][]
  source: string
  bounds: [number, number, number, number]
  roundtrip?: boolean
}>('native-visual-reading-order.jsonl')

it.each(cases)(
  'proves unchanged visual reading order without repainting: $name',
  async (fixture) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      page = pdf.addPage([600, 800])
    for (const [x, y, size, text] of fixture.draws) page.drawText(text, { x, y, size, font })
    page.drawText('Independent neighboring paragraph.', { x: 40, y: 600, size: 10, font })
    const data = new Uint8Array(await pdf.save()),
      loading = getDocument({ data: data.slice(), useSystemFonts: true }),
      registry = new TestCallerRegistry()
    onTestFinished(() => loading.destroy())
    onTestFinished(() => registry.dispose())
    const original = await loading.promise,
      caller = registry.acquire({ leaseId: 'native-reading-order', surface: 'electron' }),
      { source } = await extractPdfTranslationSource({
        document: original,
        resourceRequestKey: 'synthetic-reading-order',
        signal: caller.lease.signal
      }),
      [left, bottom, right, top] = fixture.bounds,
      unit = {
        source: fixture.source,
        translation: fixture.source,
        fragments: [
          {
            pageNumber: 1,
            rect: {
              x: left / 600,
              y: (800 - top) / 800,
              width: (right - left) / 600,
              height: (top - bottom) / 800
            }
          }
        ]
      }
    if (fixture.roundtrip) {
      expect(source.units[0].source).toBe(fixture.source)
      unit.fragments = source.units[0].fragments.map((fragment) => ({ ...fragment }))
    }
    const writer = new PdfTranslationWriter(() => resolve('resources/worker.mjs')),
      request = {
        id: 'native-reading-order',
        data,
        pages: source.pages,
        preserveUnsupported: true,
        units: [unit]
      },
      result = await writer.generateDetailed(request, caller.lease)
    expect(result).not.toBeNull()
    expect(result!.layoutFailures).toEqual([])
    const translated = getDocument({ data: result!.data.slice(), useSystemFonts: true })
    onTestFinished(() => translated.destroy())
    // Treat the whole page as protected, including the verified unchanged unit.
    const preservation = await verifyPdfPreservation(
      original,
      await translated.promise,
      [],
      [],
      [1]
    )
    expect(preservation.pages.flatMap((entry) => entry.failures)).toEqual([])
    expect(preservation.pages[0].pixels!.changedPixels).toBe(0)

    if (fixture.roundtrip) {
      const neighbor = source.units.find((entry) => entry.source.startsWith('Independent'))!
      const changed = [
        { ...unit, translation: 'Synthetic table' },
        { ...neighbor, translation: 'Translated neighboring paragraph.' }
      ]
      const output = await writer.generateDetailed({ ...request, units: changed }, caller.lease)
      expect(output!.layoutFailures).toEqual([
        {
          unitIndex: 0,
          code: 'source-mismatch',
          phase: 'planning',
          pageNumbers: [1],
          fragmentCount: 1
        }
      ])
      const target = getDocument({ data: output!.data.slice(), useSystemFonts: true })
      onTestFinished(() => target.destroy())
      const checked = await verifyPdfPreservation(
        original,
        await target.promise,
        changed,
        output!.layoutFailures,
        [1]
      )
      expect(checked.pages.flatMap((entry) => entry.failures)).toEqual([])
      expect(checked.pages[0].pixels!.retainedChangedPixels).toBe(0)
      const content = await (await (await target.promise).getPage(1)).getTextContent()
      expect(
        content.items
          .filter((item) => 'str' in item)
          .map((item) => item.str)
          .join(' ')
      ).toContain('Translated neighboring paragraph.')
      await expect(
        writer.generateDetailed(
          { ...request, preserveUnsupported: false, units: changed },
          caller.lease
        )
      ).rejects.toMatchObject({ failure: { code: 'source-mismatch' } })
    }

    // Identical character bags, substitutions and omissions are not source proofs.
    for (const source of [
      fixture.source + 'Q',
      fixture.source.slice(1),
      fixture.source.split('').reverse().join('')
    ]) {
      await expect(
        writer.generateDetailed(
          { ...request, units: [{ ...unit, source, translation: source }] },
          caller.lease
        )
      ).rejects.toMatchObject({ failure: { code: 'source-mismatch' } })
    }
  }
)
