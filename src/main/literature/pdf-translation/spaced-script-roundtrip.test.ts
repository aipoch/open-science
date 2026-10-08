import { resolve } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { ApplicationCallerLeaseRegistry } from '../../caller-lifecycle'
import { PdfTranslationWriter } from './writer'
import { extractPdfTranslationSource } from '../../../renderer/src/pages/workspace/previews/renderers/pdf-translation-extraction'
import { pdfTranslationLayoutFragments } from '../../../renderer/src/pages/workspace/previews/renderers/pdf-translation-fragments'
import { readPdfTranslationCases } from '../../../../test/fixtures/pdf-translation/read-cases'
import { verifyPdfUnits } from '../../../../test/pdf-translation-native-verification'
import { verifyPdfPreservation } from '../../../../test/pdf-translation-preservation'

type Fixture = {
  name: string
  runs: Array<{ base: string; upper: string; lower?: string }>
  translation: string
}

it.each(readPdfTranslationCases<Fixture>('spaced-script-native-roundtrip.jsonl'))(
  'backfills the complete native explanation and preserves script levels: $name',
  async ({ name, runs, translation }) => {
    const pdf = await PDFDocument.create(),
      roman = await pdf.embedFont(StandardFonts.TimesRoman),
      italic = await pdf.embedFont(StandardFonts.TimesRomanItalic),
      page = pdf.addPage([600, 800]),
      registry = new ApplicationCallerLeaseRegistry(),
      caller = registry.acquire({ leaseId: name, surface: 'electron' })
    onTestFinished(() => registry.dispose())
    page.drawText('The matrices ', { x: 40, y: 500, font: roman, size: 12 })
    let x = 40 + roman.widthOfTextAtSize('The matrices ', 12)
    for (const run of runs) {
      page.drawText(run.base, { x, y: 500, font: italic, size: 12 })
      x += italic.widthOfTextAtSize(run.base, 12) + 2
      page.drawText(run.upper, { x, y: 504, font: italic, size: 8.4 })
      if (run.lower) page.drawText(run.lower, { x: x - 0.5, y: 497.5, font: italic, size: 8.4 })
      x += italic.widthOfTextAtSize(run.upper, 8.4) + 3
    }
    page.drawText(' are learned parameters for', { x, y: 500, font: roman, size: 12 })
    page.drawText('the output, query and key projections, respectively.', {
      x: 40,
      y: 485,
      font: roman,
      size: 12
    })
    const neighbor = 'An independent neighboring paragraph remains intact.'
    page.drawText(neighbor, { x: 40, y: 450, font: roman, size: 12 })
    const data = new Uint8Array(await pdf.save()),
      loading = getDocument({ data: data.slice(), useSystemFonts: true })
    onTestFinished(() => loading.destroy())
    const original = await loading.promise,
      { source } = await extractPdfTranslationSource({
        document: original,
        resourceRequestKey: name,
        signal: caller.lease.signal
      }),
      paragraph = source.units.find((unit) => unit.source.startsWith('The matrices'))!
    expect(paragraph).toBeDefined()
    expect(paragraph.source).toContain('respectively.')
    expect(paragraph.source).not.toContain(neighbor)
    for (const run of runs) expect(paragraph.source).toContain(`Z ${run.upper}${run.lower ?? ''}`)
    expect(paragraph.sourceOnly).toBeUndefined()
    const unit = {
        ...paragraph,
        fragments: pdfTranslationLayoutFragments(paragraph, source),
        translation
      },
      writer = new PdfTranslationWriter(() => resolve('resources/pdf-translation/worker.mjs')),
      input = {
        id: 'spaced-native',
        data,
        pages: source.pages,
        preserveUnsupported: true,
        units: [unit]
      },
      output = await writer.generateDetailed(input, caller.lease)
    expect(output!.layoutFailures).toEqual([])
    const translated = getDocument({ data: output!.data.slice(), useSystemFonts: true })
    onTestFinished(() => translated.destroy())
    const target = await translated.promise,
      placement = await verifyPdfUnits(target, [{ ...unit, sourceIndex: 0 }], [], original),
      preservation = await verifyPdfPreservation(original, target, [unit], [], [1])
    expect(placement[0]).toMatchObject({ translationFound: true, retained: false })
    expect(preservation.pages.flatMap((value) => value.failures)).toEqual([])
    expect(preservation.pages[0].pixels!.changedPixels).toBe(0)
    const nativeItems = (await (await target.getPage(1)).getTextContent()).items.filter(
      (item) => 'str' in item
    )
    for (const run of runs) {
      const upper = nativeItems.find((item) => item.str === run.upper)!
      expect(upper).toBeDefined()
      expect(upper.transform[3]).toBeCloseTo(8.4, 3)
      if (run.lower) {
        const lower = nativeItems
          .filter((item) => item.str === run.lower)
          .find((item) => Math.abs(item.transform[4] - upper.transform[4] + 0.5) < 0.01)!
        expect(lower).toBeDefined()
        expect(lower.transform[3]).toBeCloseTo(8.4, 3)
        expect(upper.transform[5] - lower.transform[5]).toBeCloseTo(6.5, 3)
      }
    }
    for (const [badTranslation, code] of [
      [
        translation.replace(`Z ${runs[0].upper}${runs[0].lower ?? ''}`, 'Z D'),
        'unsupported-layout'
      ],
      [translation + ` Z ${runs[0].upper}${runs[0].lower ?? ''}`, 'unsupported-layout'],
      [translation + '额外的普通正文继续说明参数。'.repeat(100), 'overflow']
    ] as const) {
      const changed = { ...unit, translation: badTranslation },
        retained = await writer.generateDetailed({ ...input, units: [changed] }, caller.lease)
      expect(retained!.layoutFailures).toHaveLength(1)
      expect(retained!.layoutFailures[0].code).toBe(code)
      const fallback = getDocument({ data: retained!.data.slice(), useSystemFonts: true })
      onTestFinished(() => fallback.destroy())
      const kept = await verifyPdfPreservation(
        original,
        await fallback.promise,
        [changed],
        retained!.layoutFailures,
        [1]
      )
      expect(kept.pages.flatMap((value) => value.failures)).toEqual([])
      expect(kept.pages[0].pixels!.retainedChangedPixels).toBe(0)
    }
    await expect(
      writer.generateDetailed(
        { ...input, units: [{ ...unit, source: unit.source.replace('matrices', 'invented') }] },
        caller.lease
      )
    ).rejects.toThrow('source-mismatch')
  }
)
