import { describe, expect, it } from 'vitest'

// PDF.js uses its worker implementation in-process when Vitest runs without a browser Worker.
import 'pdfjs-dist/legacy/build/pdf.worker.min.mjs'
import { pdfjsLib } from './pdfjs'

const createMinimalPdf = (): Uint8Array => {
  const content = '0 0 m 100 100 l S\n'
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 4 0 R >>\nendobj\n',
    `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`
  ]
  let source = '%PDF-1.4\n'
  const offsets = objects.map((object) => {
    const offset = source.length
    source += object
    return offset
  })
  const xrefOffset = source.length
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  source += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`

  return new TextEncoder().encode(source)
}

describe('pdfjs runtime', () => {
  it('loads a real PDF and builds its page render operators', async () => {
    const loadingTask = pdfjsLib.getDocument({ data: createMinimalPdf() })
    const document = await loadingTask.promise

    try {
      expect(document.numPages).toBe(1)
      const page = await document.getPage(1)
      expect(page.getViewport({ scale: 1 })).toMatchObject({ width: 200, height: 200 })
      const operators = await page.getOperatorList()
      expect(operators.fnArray.length).toBeGreaterThan(0)
      page.cleanup()
    } finally {
      await document.destroy()
    }
  })
})
