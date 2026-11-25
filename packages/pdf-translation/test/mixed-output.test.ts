import { deflateSync } from 'node:zlib'
import { PDFDocument, PDFHexString, PDFName, StandardFonts, rgb, type PDFRef } from 'pdf-lib'
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { expect, it, onTestFinished } from 'vitest'
import { PdfTranslationWriter } from '../src/writer.js'
import type { PdfTranslationPdfRequest } from '../src/contracts.js'
import { TestCallerRegistry } from './support/callers.js'
import { resolve } from './paths.js'
import { createCanvas } from '@napi-rs/canvas'
import { verifyPdfPreservation } from './support/pdf-translation-preservation.js'

it.each([false, true])(
  'keeps images in a resource dictionary shared with other pages (incremental=%s)',
  async (incremental) => {
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    const image = (pixels: number[]): PDFRef =>
      pdf.context.register(
        pdf.context.flateStream(Uint8Array.from(pixels), {
          Type: 'XObject',
          Subtype: 'Image',
          ColorSpace: 'DeviceRGB',
          BitsPerComponent: 8,
          Width: 1,
          Height: 1
        })
      )
    const images = pdf.context.register(
      pdf.context.obj({ Warm: image([200, 70, 30]), Cool: image([40, 80, 180]) })
    )
    const fonts = pdf.context.register(pdf.context.obj({ Body: font.ref }))
    const resources = pdf.context.register(
      pdf.context.obj({ Font: fonts, XObject: images, ProcSet: ['PDF', 'Text', 'ImageC'] })
    )
    const sources = ['First paragraph.', 'Second paragraph.', 'Third paragraph.', 'Last paragraph.']
    const translations = ['第一段。', '第二段。', '第三段。', '最后一段。']
    for (const [index, source] of sources.entries()) {
      const page = pdf.addPage([400, 500])
      const raster = [null, 'Warm', 'Cool'][index]
      const content =
        `BT /Body 12 Tf 40 440 Td (${source}) Tj ET\n` +
        (raster ? `q 47 0 0 29 280 340 cm /${raster} Do Q\n` : '')
      page.node.set(PDFName.of('Contents'), pdf.context.register(pdf.context.flateStream(content)))
      page.node.set(PDFName.of('Resources'), resources)
    }
    pdf.catalog.Pages().set(PDFName.of('Resources'), resources)
    const data = await pdf.save({ useObjectStreams: false })
    const units = sources.map((source, index) => ({
      source,
      translation: translations[index],
      fragments: [{ pageNumber: index + 1, rect: { x: 0.09, y: 0.09, width: 0.82, height: 0.06 } }]
    }))
    const registry = new TestCallerRegistry()
    const caller = registry.acquire({ leaseId: 'shared-raster-resources', surface: 'electron' })
    onTestFinished(() => registry.dispose())
    const output = await new PdfTranslationWriter(() =>
      resolve('resources/worker.mjs')
    ).generateDetailed(
      {
        id: 'shared-raster-resources',
        data,
        pages: sources.map(() => ({ width: 400, height: 500 })),
        units,
        preserveUnsupported: true,
        ...(incremental ? { incremental: { data, pageNumbers: [1, 2, 3] } } : {})
      },
      caller.lease
    )
    expect(output?.layoutFailures).toEqual([])

    const before = getDocument({ data: data.slice() })
    const after = getDocument({ data: output!.data.slice() })
    onTestFinished(() => before.destroy())
    onTestFinished(() => after.destroy())
    const [original, written] = await Promise.all([before.promise, after.promise])
    const preservation = await verifyPdfPreservation(original, written, units, [], [2, 3])
    expect(preservation.pages.slice(1, 3).map((page) => page.pixels?.changedPixels)).toEqual([0, 0])
    for (const [index, translation] of translations.slice(1, 3).entries()) {
      const page = await written.getPage(index + 2)
      expect((await page.getOperatorList()).fnArray).toContain(OPS.paintImageXObject)
      expect((await page.getTextContent()).items).toContainEqual(
        expect.objectContaining({ str: translation })
      )
    }
  }
)

it.each([false, true])(
  'preserves unmatched regions alongside translated paragraphs (incremental=%s)',
  async (incremental) => {
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    const first = pdf.addPage([400, 500])
    first.drawText('Cell growth.', { font, size: 12, x: 40, y: 440 })
    first.drawRectangle({
      x: 35,
      y: 340,
      width: 160,
      height: 30,
      borderWidth: 1,
      color: rgb(0.9, 0.9, 1)
    })
    first.drawText('Original diagram label', { font, size: 12, x: 40, y: 350 })
    const imageCanvas = createCanvas(8, 8)
    imageCanvas.getContext('2d').fillRect(0, 0, 8, 8)
    const image = await pdf.embedPng(imageCanvas.toBuffer('image/png'))
    first.drawImage(image, { x: 280, y: 340, width: 40, height: 30 })
    first.drawText('Skipped paragraph.', { font, size: 12, x: 40, y: 260 })
    pdf.addPage([400, 500]).drawText('Second page.', { font, size: 12, x: 40, y: 440 })
    pdf.addPage([400, 500]).drawText('Untouched page.', { font, size: 12, x: 40, y: 440 })
    const data = await pdf.save()
    const fragment = (
      pageNumber: number,
      y: number
    ): PdfTranslationPdfRequest['units'][number]['fragments'][number] => ({
      pageNumber,
      rect: { x: 35 / 400, y: (500 - y - 18) / 500, width: 330 / 400, height: 32 / 500 }
    })
    const request: PdfTranslationPdfRequest = {
      id: 'mixed-output',
      data,
      preserveUnsupported: true,
      preserveUnmatched: true,
      pages: Array.from({ length: 3 }, () => ({ width: 400, height: 500 })),
      units: [
        { source: 'Cell growth.', translation: '细胞生长。', fragments: [fragment(1, 440)] },
        // Extraction of diagram text can disagree with native PDF objects. Its
        // proposed translation must never be substituted into unrelated source.
        {
          source: 'Unmatched extracted figure text',
          translation: '不应写入的图中文字',
          fragments: [fragment(1, 350)]
        },
        { source: 'Second page.', translation: '第二页。', fragments: [fragment(2, 440)] }
      ],
      ...(incremental ? { incremental: { data, pageNumbers: [1, 2] } } : {})
    }
    const writer = new PdfTranslationWriter(() => resolve('resources/worker.mjs'))
    const caller = new TestCallerRegistry().acquire({ leaseId: 'mixed', surface: 'electron' })
    let task: ReturnType<typeof getDocument> | undefined
    try {
      // Existing strict callers still reject a source mismatch.
      await expect(
        writer.generateDetailed({ ...request, preserveUnmatched: false }, caller.lease)
      ).rejects.toMatchObject({ failure: { code: 'source-mismatch' } })
      const result = await writer.generateDetailed(request, caller.lease)
      expect(result).toBeTruthy()
      expect(result!.layoutFailures).toContainEqual(
        expect.objectContaining({ unitIndex: 1, code: 'source-mismatch' })
      )
      task = getDocument({ data: result!.data.slice() })
      const document = await task.promise
      expect(document.numPages).toBe(3)
      const text = async (page: number): Promise<string> =>
        (await (await document.getPage(page)).getTextContent()).items
          .map((item) => ('str' in item ? item.str : ''))
          .join('')
          .replace(/\s/gu, '')
      expect(await text(1)).toContain('细胞生长。')
      expect(await text(1)).toContain('Originaldiagramlabel')
      expect(await text(1)).toContain('Skippedparagraph.')
      expect(await text(1)).not.toContain('不应写入')
      expect(await text(2)).toContain('第二页。')
      expect(await text(3)).toBe('Untouchedpage.')
      // Compare the entire retained diagram area, including its vector frame,
      // source label and raster image, independently of text extraction.
      const original = getDocument({ data: data.slice() })
      try {
        const preservation = await verifyPdfPreservation(
          await original.promise,
          document,
          request.units,
          result!.layoutFailures,
          [1]
        )
        expect(preservation.pages[0].pixels?.changedPixels).toBe(0)
        expect(preservation.pages[0].pixels?.retainedChangedPixels).toBe(0)
      } finally {
        await original.destroy()
      }
    } finally {
      await task?.destroy()
      caller.release()
    }
  }
)

it('requires explicit preservation mode for unmatched-source fallback', () => {
  const writer = new PdfTranslationWriter()
  const input = {
    id: 'invalid-mode',
    data: new Uint8Array([1]),
    pages: [{ width: 400, height: 500 }],
    units: [
      {
        source: 'cell',
        translation: '细胞',
        fragments: [{ pageNumber: 1, rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.1 } }]
      }
    ],
    preserveUnmatched: true
  }
  expect(writer.valid(input)).toBe(false)
  expect(writer.valid({ ...input, preserveUnsupported: true })).toBe(true)
})

it.each([false, true])(
  'preserves a named indexed inline palette when rewriting text (incremental=%s)',
  async (incremental) => {
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    const page = pdf.addPage([400, 500])
    const palette = pdf.context.obj(['Indexed', 'DeviceRGB', 1, PDFHexString.of('FF0000000080')])
    const colors = pdf.context.obj({ Palette: pdf.context.register(palette) })
    page.node.set(
      PDFName.of('Resources'),
      pdf.context.obj({ Font: { Body: font.ref }, ColorSpace: pdf.context.register(colors) })
    )
    const operators = Buffer.from(
      'BT /Body 12 Tf 40 440 Td (Cell growth.) Tj ET\n' +
        'q 60 0 0 30 280 340 cm BI /CS /Palette /W 2 /H 1 /BPC 8 /F /Fl ID\n'
    )
    const content = Buffer.concat([
      operators,
      deflateSync(Uint8Array.of(0, 1)),
      Buffer.from('\nEI Q')
    ])
    page.node.addContentStream(pdf.context.register(pdf.context.flateStream(content)))
    const data = await pdf.save()
    const rect = { x: 0.0875, y: 0.084, width: 0.825, height: 0.064 }
    const request: PdfTranslationPdfRequest = {
      id: 'indexed-inline-colors',
      data,
      pages: [{ width: 400, height: 500 }],
      units: [
        { source: 'Cell growth.', translation: '细胞生长。', fragments: [{ pageNumber: 1, rect }] }
      ],
      ...(incremental ? { incremental: { data, pageNumbers: [1] } } : {})
    }
    const writer = new PdfTranslationWriter(() => resolve('resources/worker.mjs'))
    const caller = new TestCallerRegistry().acquire({
      leaseId: 'indexed-colors',
      surface: 'electron'
    })
    const original = getDocument({ data: data.slice() })
    let written: ReturnType<typeof getDocument> | undefined
    try {
      const result = await writer.generateDetailed(request, caller.lease)
      expect(result?.layoutFailures).toEqual([])
      written = getDocument({ data: result!.data.slice() })
      const output = await written.promise
      const items = (await (await output.getPage(1)).getTextContent()).items
      expect(items.map((item) => ('str' in item ? item.str : '')).join('')).toContain('细胞生长。')
      const proof = await verifyPdfPreservation(
        await original.promise,
        output,
        request.units,
        [],
        [1]
      )
      expect(proof.pages[0].pixels?.changedPixels).toBe(0)
    } finally {
      await original.destroy()
      await written?.destroy()
      caller.release()
    }
  }
)
