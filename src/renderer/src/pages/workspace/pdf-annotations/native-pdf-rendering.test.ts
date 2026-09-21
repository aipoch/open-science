import { expect, it } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { exportAnnotatedPdf } from './pdf-export'

it('hides only managed originals through PDF.js annotation storage, preserving unmanaged annotations', async () => {
  const original = await PDFDocument.create()
  original.addPage([300, 400])
  const data = (await original.save()).buffer as ArrayBuffer
  const checksum = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
  const bytes = await exportAnnotatedPdf({
    data,
    checksum,
    marks: ['managed', 'unmanaged'].map((id, i) => ({
      id,
      kind: 'highlight',
      color: 'yellow',
      note: id,
      createdAt: '2026-09-20T00:00:00Z',
      updatedAt: '2026-09-20T00:00:00Z',
      pageNumber: 1,
      quads: [[20, 80 + i * 30, 140, 80 + i * 30, 20, 60 + i * 30, 140, 60 + i * 30]]
    }))
  })
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const document = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    verbosity: 0,
    isEvalSupported: false
  }).promise
  try {
    const page = await document.getPage(1)
    const annotations = await page.getAnnotations()
    const managed = annotations.find((annotation) => annotation.contentsObj?.str === 'managed')!
    const options = { annotationMode: pdfjs.AnnotationMode.ENABLE_STORAGE }
    const before = await page.getOperatorList(options)
    expect(before.fnArray.filter((op) => op === pdfjs.OPS.beginAnnotation)).toHaveLength(2)
    document.annotationStorage.setValue(managed.id, { noView: true })
    const after = await page.getOperatorList(options)
    expect(after.fnArray.filter((op) => op === pdfjs.OPS.beginAnnotation)).toHaveLength(1)
  } finally {
    await document.destroy()
  }
})
