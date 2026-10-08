import { describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { PDFDocument, PDFString } from 'pdf-lib'

// PDF.js uses its worker implementation in-process when Vitest runs without a browser Worker.
import 'pdfjs-dist/legacy/build/pdf.worker.mjs'
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
  it('extracts Japanese from a predefined CMap without an embedded ToUnicode map', async () => {
    const pdf = await PDFDocument.create(),
      page = pdf.addPage([200, 200]),
      descendant = pdf.context.register(
        pdf.context.obj({
          Type: 'Font',
          Subtype: 'CIDFontType0',
          BaseFont: 'HeiseiMin-W3',
          FontDescriptor: {
            Type: 'FontDescriptor',
            FontName: 'HeiseiMin-W3',
            Flags: 6,
            FontBBox: [-1000, -120, 1000, 880],
            ItalicAngle: 0,
            Ascent: 880,
            Descent: -120,
            CapHeight: 880,
            StemV: 80
          },
          CIDSystemInfo: {
            Registry: PDFString.of('Adobe'),
            Ordering: PDFString.of('Japan1'),
            Supplement: 6
          }
        })
      ),
      font = pdf.context.register(
        pdf.context.obj({
          Type: 'Font',
          Subtype: 'Type0',
          BaseFont: 'HeiseiMin-W3',
          Encoding: 'UniJIS-UTF16-H',
          DescendantFonts: [descendant]
        })
      )
    page.node.set(pdf.context.obj('Resources'), pdf.context.obj({ Font: { CJK: font } }))
    page.node.set(
      pdf.context.obj('Contents'),
      pdf.context.register(
        pdf.context.flateStream('BT /CJK 12 Tf 20 150 Td <30533093306B3061306F4E16754C> Tj ET')
      )
    )
    const requested: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      const name = url.split('/').at(-1)!.split('?')[0]
      requested.push(name)
      return new Response(await readFile(resolve('node_modules/pdfjs-dist/cmaps', name)))
    })
    const task = pdfjsLib.getDocument({ data: await pdf.save() })
    try {
      const document = await task.promise,
        text = await (await document.getPage(1)).getTextContent()
      expect(
        text.items
          .filter((item) => 'str' in item)
          .map((item) => item.str)
          .join('')
      ).toBe('こんにちは世界')
      expect(requested).toContain('UniJIS-UTF16-H.bcmap')
      expect(requested).toContain('Adobe-Japan1-UCS2.bcmap')
    } finally {
      await task.destroy()
      vi.unstubAllGlobals()
    }
  })

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
