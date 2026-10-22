import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { expect, it } from 'vitest'
import { PdfTranslationWriter } from '../src/writer.js'
import type { PdfTranslationPdfRequest } from '../src/contracts.js'
import { TestCallerRegistry } from './support/callers.js'
import { resolve } from './paths.js'
import { createCanvas } from '@napi-rs/canvas'
import { verifyPdfPreservation } from './support/pdf-translation-preservation.js'

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
