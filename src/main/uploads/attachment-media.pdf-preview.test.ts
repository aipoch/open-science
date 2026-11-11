import { LiteratureReader } from '@aipoch/literature-reading'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { renderPdfPagePreviews } from './attachment-media'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { extractPdfText, extractPdfTextPages } from './pdf-text-extraction'

const twoPagePdf = (): Buffer => {
  const pageTwoStream = 'BT /F1 12 Tf 10 50 Td (Page two claim) Tj ET'
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 5 0 R /Resources << >> >>\nendobj\n',
    '4 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>\nendobj\n',
    '5 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n',
    `6 0 obj\n<< /Length ${pageTwoStream.length} >>\nstream\n${pageTwoStream}\nendstream\nendobj\n`,
    '7 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n'
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = objects.map((object) => {
    const offset = Buffer.byteLength(pdf)
    pdf += object
    return offset
  })
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 8\n0000000000 65535 f \n${offsets
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf)
}

describe('targeted PDF preview rendering', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'reviewer-pdf-preview-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('extracts and rasterizes only requested page two', async () => {
    const filePath = join(root, 'two-pages.pdf')
    await writeFile(filePath, twoPagePdf())

    await expect(extractPdfTextPages(filePath, [2])).resolves.toMatchObject({
      pageCount: 2,
      pages: [{ pageNumber: 2, text: 'Page two claim' }]
    })
    const preview = await renderPdfPagePreviews(filePath, [2], 1_000_000)
    expect(preview).toMatchObject({
      pageCount: 2,
      media: [{ pageNumber: 2, mimeType: 'image/jpeg' }],
      budgetExhaustedPages: []
    })
    expect(preview.media[0]!.data.length).toBeGreaterThan(100)
  })

  it.each([false, true])(
    'extracts real PDF text conservatively; ambiguous columns: %s',
    async (ambiguous) => {
      const document = await PDFDocument.create()
      const font = await document.embedFont(StandardFonts.Helvetica)
      const page = document.addPage([600, 800])
      for (const row of ambiguous ? [0, 1, 2, 3] : [3, 2, 1, 0]) {
        page.drawText(`Left${row} original prose sentence.`, {
          x: 40,
          y: 680 - row * 24,
          font,
          size: 10
        })
        if (ambiguous)
          page.drawText(`Right${row} original prose sentence.`, {
            x: 330,
            y: 680 - row * 24,
            font,
            size: 10
          })
      }
      const filePath = join(root, 'conservative.pdf')
      await writeFile(filePath, await document.save())
      const result = await extractPdfText(filePath)
      expect(result.text.match(/(?:Left|Right)\d/g)).toEqual(
        [0, 1, 2, 3].flatMap((row) => (ambiguous ? [`Left${row}`, `Right${row}`] : [`Left${row}`]))
      )
      expect(result.warnings).toEqual(ambiguous ? [expect.stringContaining('Page 1:')] : undefined)
      const positioned = await extractPdfText(filePath, undefined, {
        includeLayout: true,
        ocr: true
      })
      expect(positioned.coverage).toEqual({
        textPages: [1],
        ocrPages: [],
        unavailablePages: [],
        uncheckedPages: []
      })
      expect(positioned.text).toBe(result.text)
      expect(positioned.warnings).toEqual(result.warnings)
      expect(
        positioned.pageLayouts?.[0]?.blocks
          .filter((block) => block.text.trim())
          .map((block) => block.text)
      ).toEqual(
        ambiguous
          ? [0, 1, 2, 3].flatMap((row) => [
              `Left${row} original prose sentence.`,
              `Right${row} original prose sentence.`
            ])
          : undefined
      )
      expect(positioned.pageLayouts?.[0]?.coordinateSystem).toBe(ambiguous ? 'top-left' : undefined)
      expect(result.pageLayouts).toBeUndefined()
      if (ambiguous) {
        expect(result.text.length).toBeLessThan(500)
        const bounded = await extractPdfText(filePath, undefined, {
          includeLayout: true,
          maxChars: 500
        })
        expect(bounded.text).toBe(result.text)
        expect(bounded.pageLayouts).toBeUndefined()
        expect(bounded.layoutOmittedPages).toEqual([1])
      }
    }
  )

  it('orders aligned prose columns in a real PDF by column', async () => {
    const document = await PDFDocument.create()
    const font = await document.embedFont(StandardFonts.Helvetica)
    const page = document.addPage([600, 800])
    for (let row = 0; row < 4; row += 1) {
      page.drawText(`Left column prose evidence sentence ${row}.`, {
        x: 40,
        y: 680 - row * 24,
        font,
        size: 12
      })
      page.drawText(`Right column prose evidence sentence ${row}.`, {
        x: 330,
        y: 680 - row * 24,
        font,
        size: 12
      })
    }
    const filePath = join(root, 'aligned-prose-columns.pdf')
    await writeFile(filePath, await document.save())
    const result = await extractPdfText(filePath)
    expect(result.text).toBe(
      '--- Page 1 ---\n' +
        [
          ...[0, 1, 2, 3].map((row) => `Left column prose evidence sentence ${row}.`),
          ...[0, 1, 2, 3].map((row) => `Right column prose evidence sentence ${row}.`)
        ].join('\n')
    )
    expect(result.warnings).toBeUndefined()
  })

  it('keeps physical page authority when a real PDF contains page-like source text', async () => {
    const doc = await PDFDocument.create(),
      font = await doc.embedFont(StandardFonts.Helvetica)
    const first = doc.addPage([600, 800])
    first.drawText('--- Page 99 ---', { x: 40, y: 750, size: 12, font })
    for (let row = 0; row < 3; row++) {
      first.drawText(`Left original ${row} needle.`, { x: 40, y: 680 - row * 24, size: 10, font })
      first.drawText(`Right original ${row}.`, { x: 330, y: 680 - row * 24, size: 10, font })
    }
    doc.addPage([600, 800]).drawText('Actual second page.', { x: 40, y: 750, size: 12, font })
    const path = join(root, 'embedded-page-marker.pdf')
    await writeFile(path, await doc.save())
    const result = await extractPdfText(path, undefined, { includeLayout: true })
    expect(result.text).toContain('--- Page 99 ---')
    expect(result.pageStarts).toEqual([
      { page: 1, offset: 0 },
      { page: 2, offset: result.text.indexOf('--- Page 2 ---') }
    ])
    const reader = new LiteratureReader({ authorize: async () => async () => result })
    const reference = {
      bindingId: 'physical-pages',
      name: 'fixture.pdf',
      checksum: 'a'.repeat(64),
      sizeBytes: 100
    }
    const search = await reader.searchDocuments([reference], 'needle')
    expect(search.passages.every((hit) => hit.pageStart === 1 && hit.pageEnd === 1)).toBe(true)
    expect(search.documents[0].pageLayouts?.map((page) => page.page)).toEqual([1])
    expect((await reader.readDocument(reference)).passage.text).toBe(result.text)
  })

  it('reports image-only target budget exhaustion without dropping page identity', async () => {
    const filePath = join(root, 'two-pages.pdf')
    await writeFile(filePath, twoPagePdf())

    await expect(renderPdfPagePreviews(filePath, [2], 1)).resolves.toEqual({
      pageCount: 2,
      media: [],
      budgetExhaustedPages: [2]
    })
  })
})
