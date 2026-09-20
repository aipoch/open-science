/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Standalone evaluation worker. No application entry point imports this file.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'

const [enginePath, inputPath, marksPath, outputPath] = process.argv.slice(2)
assert(outputPath, 'Usage: export.mjs <engine.mjs> <input.pdf> <pdf-space-marks.json> <output.pdf>')
const start = performance.now()
const cpuStart = process.cpuUsage()
const mupdf = await import(pathToFileURL(enginePath).href)
const importMs = performance.now() - start
const input = await readFile(inputPath)
const marks = JSON.parse(await readFile(marksPath, 'utf8'))
const exportStart = performance.now()
const exportCpu = process.cpuUsage()
const document = new mupdf.PDFDocument(input)
assert(!document.needsPassword(), 'Encrypted input needs an explicit password workflow')
const types = {
  highlight: 'Highlight',
  underline: 'Underline',
  squiggly: 'Squiggly',
  strikethrough: 'StrikeOut',
  area: 'Square',
  'page-note': 'Text',
  'document-note': 'Text'
}
const colors = {
  yellow: [1, 0.84, 0.16],
  blue: [0.25, 0.55, 1],
  green: [0.22, 0.75, 0.38],
  pink: [0.96, 0.38, 0.62],
  purple: [0.64, 0.42, 0.94]
}
const byPage = Map.groupBy(marks, (mark) => mark.pageNumber)
try {
  for (const [pageNumber, pageMarks] of byPage) {
    assert(pageNumber >= 1 && pageNumber <= document.countPages())
    const page = document.loadPage(pageNumber - 1)
    try {
      const matrix = page.getTransform()
      const transform = (x, y) => [
        matrix[0] * x + matrix[2] * y + matrix[4],
        matrix[1] * x + matrix[3] * y + matrix[5]
      ]
      for (const mark of pageMarks) {
        assert(types[mark.kind], `Unknown annotation kind: ${mark.kind}`)
        const annotation = page.createAnnotation(types[mark.kind])
        try {
          annotation.setName(mark.id)
          annotation.setAuthor('Open Science - MuPDF spike')
          annotation.setSubject(mark.kind)
          annotation.setContents(mark.note || '')
          annotation.setCreationDate(new Date('2026-09-20T00:00:00Z'))
          annotation.setModificationDate(new Date('2026-09-20T00:00:00Z'))
          annotation.setFlags(annotation.getFlags() | mupdf.PDFAnnotation.IS_PRINT)
          annotation.setColor(colors[mark.color || 'yellow'])
          if (annotation.hasQuadPoints()) {
            annotation.setQuadPoints(
              mark.pdfQuads.map((quad) =>
                quad.flatMap((_, i) => (i % 2 ? [] : transform(quad[i], quad[i + 1])))
              )
            )
            annotation.setOpacity(mark.kind === 'highlight' ? 0.4 : 1)
          } else {
            annotation.setRect(mupdf.Rect.transform(mark.pdfRect, matrix))
            if (mark.kind === 'area') {
              annotation.setInteriorColor(colors[mark.color || 'yellow'])
              annotation.setOpacity(0.25)
              annotation.setBorderWidth(1)
            } else {
              annotation.setIcon('Note')
              annotation.setIsOpen(false)
            }
          }
          annotation.update()
        } finally {
          annotation.destroy()
        }
      }
      page.update()
    } finally {
      page.destroy()
    }
  }
  const buffer = document.saveToBuffer({ compress: true, garbage: 3 })
  try {
    await writeFile(outputPath, buffer.asUint8Array())
    console.log(
      JSON.stringify({
        inputBytes: input.length,
        outputBytes: buffer.length,
        annotations: marks.length,
        pages: document.countPages(),
        importMs,
        exportMs: performance.now() - exportStart,
        exportCpuMs: Object.values(process.cpuUsage(exportCpu)).reduce((a, b) => a + b, 0) / 1000,
        totalMs: performance.now() - start,
        totalCpuMs: Object.values(process.cpuUsage(cpuStart)).reduce((a, b) => a + b, 0) / 1000,
        peakRssMiB: process.resourceUsage().maxRSS / 1024
      })
    )
  } finally {
    buffer.destroy()
  }
} finally {
  document.destroy()
}
