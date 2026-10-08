import { resolve } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { PDFDocument, PDFName, PDFString, StandardFonts, degrees } from 'pdf-lib'
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
    change: string
    accepted: boolean
    pngBase64: string
    translation: string
  }>('raster-run-in-label-roundtrip.jsonl')
)(
  'owns a complete decorated paragraph and citation without touching neighbors: $name',
  async ({ name, change, accepted, pngBase64, translation }) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.TimesRoman),
      image = await pdf.embedPng(Buffer.from(pngBase64, 'base64')),
      page = pdf.addPage([600, 800]),
      point = 10,
      label = 'TASK',
      width = font.widthOfTextAtSize(label, point)
    page.drawText(label, { x: 40, y: 700, size: point, font })
    page.drawImage(image, {
      x: change === 'displaced' ? 41.5 : 40,
      y: 698,
      width: width + 1,
      height: change === 'thick' ? 2 : 0.48,
      rotate: degrees(change === 'rotation' ? 2 : 0)
    })
    let x = 41 + width
    let linkedX = 0
    for (const text of [
      ': The prior controlled result (Doran et al., 2037b,',
      'a',
      '; Kelin et al., 2038) supports the observation.'
    ]) {
      if (text === 'a') linkedX = x
      page.drawText(text, { x, y: 700, size: point, font })
      x += font.widthOfTextAtSize(text, point)
    }
    page.drawText('The complete paragraph keeps the independent neighboring boundaries intact.', {
      x: 40,
      y: 688,
      size: point,
      font
    })
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
            Rect: [linkedX, 698, linkedX + font.widthOfTextAtSize('a', point), 708],
            Border: [0, 0, 0],
            A: { S: 'URI', URI: PDFString.of('https://example.invalid/reference-b') }
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
      }),
      paragraph = source.units.find((unit) => unit.source.startsWith(label + ':'))!
    expect(paragraph).toBeDefined()
    expect(paragraph.source).toContain('intact.')
    expect(paragraph.source).not.toContain('remains unchanged.')
    expect(
      paragraph.fragments
        .flatMap((fragment) => fragment.items)
        .map((item) => item.text)
        .join('')
    ).toContain('Kelin')
    expect(source.units.filter((unit) => unit.source.includes('remains unchanged.'))).toHaveLength(
      1
    )
    const unit = {
        ...paragraph,
        fragments: pdfTranslationLayoutFragments(paragraph, source),
        translation
      },
      writer = new PdfTranslationWriter(() => resolve('resources/pdf-translation/worker.mjs')),
      input = {
        id: name.replace(/\W+/gu, '-').slice(0, 64),
        data: bytes,
        pages: source.pages,
        preserveUnsupported: true,
        units: [unit]
      },
      generated = await writer.generateDetailed(input, caller.lease)
    expect(generated!.layoutFailures, JSON.stringify(generated!.layoutFailures)).toHaveLength(
      accepted ? 0 : 1
    )
    const translated = getDocument({ data: generated!.data.slice(), useSystemFonts: true })
    onTestFinished(() => translated.destroy())
    const target = await translated.promise,
      verification = await verifyPdfUnits(
        target,
        [{ ...unit, sourceIndex: 0 }],
        generated!.layoutFailures,
        original
      ),
      preservation = await verifyPdfPreservation(
        original,
        target,
        [unit],
        generated!.layoutFailures,
        [1]
      )
    expect(verification[0]).toMatchObject({ retained: !accepted, translationFound: accepted })
    expect(preservation.pages.flatMap((page) => page.failures)).toEqual([])
    expect(preservation.pages.every((page) => page.pixels!.changedPixels === 0)).toBe(true)
    if (accepted) {
      // Independently confirm the image moves with the unchanged title, retaining
      // its physical size and relative position, rather than being erased/exempted.
      const inspect = async (
        data: Uint8Array
      ): Promise<{ dx: number; dy: number; width: number; height: number }> => {
        const { pathToFileURL } = await import('node:url'),
          { engine } = await import(
            /* @vite-ignore */ pathToFileURL(resolve('resources/pdf-translation/pdfium.mjs')).href
          ),
          e = await engine(),
          d = e.open(data),
          p = e.p.FPDF_LoadPage(d.doc, 0)
        try {
          const objects = e.objects(p),
            title = objects.find(
              (object: { type: number; text?: string }) =>
                object.type === 1 && object.text === label
            ),
            graphic = objects.find((object: { type: number }) => object.type === 3)
          expect(title).toBeDefined()
          expect(graphic).toBeDefined()
          return {
            dx: graphic.bounds[0] - title.bounds[0],
            dy: graphic.bounds[1] - title.bounds[1],
            width: graphic.bounds[2] - graphic.bounds[0],
            height: graphic.bounds[3] - graphic.bounds[1]
          }
        } finally {
          e.p.FPDF_ClosePage(p)
          d.close()
        }
      }
      const before = await inspect(bytes),
        after = await inspect(generated!.data)
      for (const key of ['dx', 'dy', 'width', 'height'] as const)
        expect(after[key]).toBeCloseTo(before[key], 3)
      await expect(
        writer.generateDetailed(
          { ...input, units: [{ ...unit, source: unit.source.replace('controlled', 'invented') }] },
          caller.lease
        )
      ).rejects.toThrow('source-mismatch')
      const expanded = {
          ...unit,
          translation: translation + '额外的普通正文继续说明结果。'.repeat(100)
        },
        retained = await writer.generateDetailed({ ...input, units: [expanded] }, caller.lease)
      expect(retained!.layoutFailures[0]?.code).toBe('overflow')
      const fallback = getDocument({ data: retained!.data.slice(), useSystemFonts: true })
      onTestFinished(() => fallback.destroy())
      const protectedResult = await verifyPdfPreservation(
        original,
        await fallback.promise,
        [expanded],
        retained!.layoutFailures,
        [1]
      )
      expect(protectedResult.pages.flatMap((page) => page.failures)).toEqual([])
      expect(protectedResult.pages.every((page) => page.pixels!.changedPixels === 0)).toBe(true)
    }
  }
)
