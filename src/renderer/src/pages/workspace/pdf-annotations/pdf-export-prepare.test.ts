import { expect, it } from 'vitest'
import { PDFDocument, PDFName, degrees } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { preparePdfExportMarks } from './pdf-export-prepare'
import { exportAnnotatedPdf } from './pdf-export'
import type { PdfAnnotation } from '../../../../../shared/pdf-annotations'

it('roundtrips visible quad corners on rotated cropped UserUnit pages and separates note icons', async () => {
  const pdf = await PDFDocument.create()
  for (const rotation of [0, 90, 180, 270]) {
    const page = pdf.addPage([300, 400])
    page.setCropBox(10, 15, 250, 320)
    page.setRotation(degrees(rotation))
    page.node.set(PDFName.of('UserUnit'), pdf.context.obj(2))
  }
  const bytes = await pdf.save()
  const loading = getDocument({ data: bytes.slice() })
  const document = await loading.promise
  try {
    const annotations = [0, 90, 180, 270].map((pageRotation, i) => ({
      id: String(i),
      kind: 'underline',
      color: 'yellow',
      note: '中文',
      tagIds: [],
      createdAt: '2026-09-20T00:00:00Z',
      updatedAt: '2026-09-20T00:00:00Z',
      target: {
        selector: {
          kind: 'text',
          pageNumber: i + 1,
          pageRotation,
          quads: [{ x: 0.2, y: 0.3, width: 0.4, height: 0.05 }]
        }
      }
    })) as unknown as PdfAnnotation[]
    const prepared = await preparePdfExportMarks(
      document,
      annotations,
      new AbortController().signal,
      (a) => a.note
    )
    for (const mark of prepared) {
      const page = await document.getPage(mark.pageNumber),
        viewport = page.getViewport({ scale: 1 })
      const quad = mark.quads[0]
      const actual = [0, 2, 4, 6].flatMap((i) =>
        viewport.convertToViewportPoint(quad[i], quad[i + 1])
      )
      const expected = [0.2, 0.3, 0.6, 0.3, 0.2, 0.35, 0.6, 0.35].map(
        (n, i) => n * (i % 2 ? viewport.height : viewport.width)
      )
      const sortedActual = [0, 2, 4, 6]
        .map((i) => [actual[i], actual[i + 1]])
        .sort((a, b) => a[0] - b[0] || a[1] - b[1])
        .flat()
      const sortedExpected = [0, 2, 4, 6]
        .map((i) => [expected[i], expected[i + 1]])
        .sort((a, b) => a[0] - b[0] || a[1] - b[1])
        .flat()
      sortedActual.forEach((n, i) => expect(n).toBeCloseTo(sortedExpected[i], 6))
    }
    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)),
      (b) => b.toString(16).padStart(2, '0')
    ).join('')
    const output = await exportAnnotatedPdf({
      data: bytes.buffer as ArrayBuffer,
      checksum: hash,
      marks: prepared
    })
    const exportedTask = getDocument({ data: new Uint8Array(output) })
    try {
      const exported = await exportedTask.promise
      for (let pageNumber = 1; pageNumber <= 4; pageNumber++) {
        const marks = await (await exported.getPage(pageNumber)).getAnnotations()
        expect(marks).toHaveLength(1)
        expect(marks[0].subtype).toBe('Underline')
        expect(marks[0].contentsObj.str).toBe('中文')
        expect(marks[0].hasAppearance).toBe(true)
      }
    } finally {
      await exportedTask.destroy()
    }
    const notes = [0, 1].map((i) => ({
      ...annotations[0],
      id: `note${i}`,
      kind: 'document-note',
      target: { selector: { kind: 'document-note' } }
    })) as PdfAnnotation[]
    const icons = await preparePdfExportMarks(
      document,
      notes,
      new AbortController().signal,
      (a) => a.note
    )
    expect(icons[0].pageNumber).toBe(1)
    expect(icons[0].quads).not.toEqual(icons[1].quads)
    const controller = new AbortController()
    controller.abort()
    await expect(
      preparePdfExportMarks(document, annotations, controller.signal, (a) => a.note)
    ).rejects.toThrow()
  } finally {
    await loading.destroy()
  }
})

it('keeps underline baselines parallel to source text on rotated and mixed-direction pages', async () => {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([400, 400])
  page.setRotation(degrees(90))
  page.drawText('Horizontal text', { x: 30, y: 200, size: 12 })
  page.drawText('Vertical text', { x: 250, y: 30, size: 12, rotate: degrees(90) })
  const task = getDocument({ data: await pdf.save() })
  const document = await task.promise
  try {
    const view = (await document.getPage(1)).getViewport({ scale: 1 })
    const rects = [
      [30, 200, 130, 212],
      [238, 30, 250, 100]
    ]
    const annotations = rects.map(([x0, y0, x1, y1], i) => {
      const p = view.convertToViewportPoint(x0, y0),
        q = view.convertToViewportPoint(x1, y1)
      return {
        id: String(i),
        kind: 'underline',
        target: {
          selector: {
            kind: 'text',
            pageNumber: 1,
            pageRotation: 90,
            quads: [
              {
                x: Math.min(p[0], q[0]) / view.width,
                y: Math.min(p[1], q[1]) / view.height,
                width: Math.abs(p[0] - q[0]) / view.width,
                height: Math.abs(p[1] - q[1]) / view.height
              }
            ]
          }
        }
      }
    }) as unknown as PdfAnnotation[]
    const marks = await preparePdfExportMarks(
      document,
      annotations,
      new AbortController().signal,
      () => ''
    )
    expect(marks[0].quads[0]).toEqual([30, 212, 130, 212, 30, 200, 130, 200])
    expect(marks[1].quads[0]).toEqual([238, 30, 238, 100, 250, 30, 250, 100])
  } finally {
    await task.destroy()
  }
})
