import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { extractPdfTextPages, renderPdfPagePreviews } from './attachment-media'

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
