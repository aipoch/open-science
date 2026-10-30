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

  it('keeps ambiguous actual PDF columns conservative and applies only confirmed page corrections', async () => {
    const document = await PDFDocument.create()
    const font = await document.embedFont(StandardFonts.Helvetica)
    for (const pageNumber of [1, 2]) {
      const page = document.addPage([600, 800])
      for (let row = 1; row <= 24; row++) {
        page.drawText(`P${pageNumber}L${row} Left prose follows the previous sentence.`, {
          x: 40,
          y: 700 - row * 16,
          size: 9,
          font
        })
        page.drawText(`P${pageNumber}R${row} Right prose continues in its own column.`, {
          x: 330,
          y: pageNumber === 1 ? 695 - row * 17 : 700 - row * 16,
          size: 9,
          font
        })
      }
    }
    const path = join(root, 'actual-columns.pdf')
    await writeFile(path, await document.save())
    const ids = (text: string, page: number): string[] =>
      text.match(new RegExp(`P${page}[LR]\\d+`, 'g')) ?? []
    const expected = (page: number): string[] =>
      ['L', 'R'].flatMap((column) =>
        Array.from({ length: 24 }, (_, row) => `P${page}${column}${row + 1}`)
      )
    const automatic = await extractPdfText(path)
    const native = (page: number): string[] =>
      Array.from({ length: 24 }, (_, row) => [`P${page}L${row + 1}`, `P${page}R${row + 1}`]).flat()
    expect(ids(automatic.text, 1)).toEqual(native(1))
    expect(ids(automatic.text, 2)).toEqual(
      Array.from({ length: 24 }, (_, row) => [`P2L${row + 1}`, `P2R${row + 1}`]).flat()
    )
    const proseRegions = [{ page: 2, left: 0.04, top: 0.1, right: 0.95, bottom: 0.95, split: 0.48 }]
    const corrected = await extractPdfText(path, undefined, { proseRegions })
    expect(ids(corrected.text, 1)).toEqual(native(1))
    expect(ids(corrected.text, 2)).toEqual(expected(2))
    const targeted = await extractPdfTextPages(path, [1])
    expect(ids(targeted.pages[0]!.text, 1)).toEqual(native(1))
    const firstPageRegions = [{ ...proseRegions[0]!, page: 1 }]
    expect(
      ids((await extractPdfText(path, 1, { proseRegions: firstPageRegions })).text, 1)
    ).toEqual(expected(1))
    expect(ids((await extractPdfText(path, 2, { proseRegions })).text, 2)).toEqual(expected(2))
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
