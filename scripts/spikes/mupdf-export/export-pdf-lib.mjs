/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Standalone comparison worker. The low-level annotation/AP adapter is our code, not pdf-lib API.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'

const [enginePath, inputPath, marksPath, outputPath] = process.argv.slice(2)
assert(outputPath, 'Usage: export-pdf-lib.mjs <engine.js> <input.pdf> <marks.json> <output.pdf>')
const start = performance.now()
const cpuStart = process.cpuUsage()
const engine = await import(pathToFileURL(enginePath).href)
const { PDFDocument, PDFHexString, PDFName } = engine.default ?? engine
const importMs = performance.now() - start
const input = await readFile(inputPath)
const marks = JSON.parse(await readFile(marksPath, 'utf8'))
const exportStart = performance.now()
const exportCpu = process.cpuUsage()
// Do not use ignoreEncryption: it does not decrypt the source.
const document = await PDFDocument.load(input, { updateMetadata: false })
const context = document.context
const pages = document.getPages()
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
const number = (value) => {
  assert(Number.isFinite(value), 'Non-finite appearance coordinate')
  return Number(value.toFixed(5)).toString()
}
const op = (values, operator) => `${values.map(number).join(' ')} ${operator}`
for (const [pageNumber, pageMarks] of Map.groupBy(marks, (mark) => mark.pageNumber)) {
  assert(Number.isInteger(pageNumber) && pageNumber >= 1 && pageNumber <= pages.length)
  const page = pages[pageNumber - 1]
  // Avoid addAnnot's page normalization: export must not modify original content streams.
  let annotations = page.node.Annots()
  if (!annotations) {
    annotations = context.obj([])
    page.node.set(PDFName.of('Annots'), annotations)
  }
  for (const mark of pageMarks) {
    assert(types[mark.kind], `Unknown annotation kind: ${mark.kind}`)
    const color = colors[mark.color || 'yellow']
    assert(color, `Unknown annotation color: ${mark.color}`)
    const isTextMarkup = ['highlight', 'underline', 'squiggly', 'strikethrough'].includes(mark.kind)
    const rects = isTextMarkup
      ? mark.pdfQuads.map(([x0, y1, x1, , , y0]) => [x0, y0, x1, y1])
      : [mark.pdfRect]
    assert(rects.length > 0)
    for (const r of rects)
      assert(r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1], 'Invalid mark rectangle')
    const bounds = [
      Math.min(...rects.map((r) => r[0])),
      Math.min(...rects.map((r) => r[1])),
      Math.max(...rects.map((r) => r[2])),
      Math.max(...rects.map((r) => r[3]))
    ]
    const margin = 1
    const rect = bounds.map((v, i) => v + (i < 2 ? -margin : margin))
    const width = rect[2] - rect[0]
    const height = rect[3] - rect[1]
    const opacity = mark.kind === 'highlight' ? 0.4 : mark.kind === 'area' ? 0.25 : 1
    const commands = ['q', '/GS0 gs', op(color, 'rg'), op(color, 'RG'), '1 w']
    for (const [x0, y0, x1, y1] of rects) {
      const x = x0 - rect[0]
      const y = y0 - rect[1]
      const w = x1 - x0
      const h = y1 - y0
      switch (mark.kind) {
        case 'highlight':
          commands.push(op([x, y, w, h], 're'), 'f')
          break
        case 'area':
          commands.push(op([x, y, w, h], 're'), 'B')
          break
        case 'underline':
        case 'strikethrough': {
          const lineY = y + (mark.kind === 'underline' ? h * 0.1 : h * 0.5)
          commands.push(op([x, lineY], 'm'), op([x + w, lineY], 'l'), 'S')
          break
        }
        case 'squiggly': {
          const amplitude = Math.min(1, h / 8)
          const segments = Math.max(2, Math.ceil(w / (2 * amplitude)))
          commands.push(op([x, y + amplitude], 'm'))
          for (let i = 1; i <= segments; i++)
            commands.push(op([x + (w * i) / segments, y + (i % 2 ? 0 : amplitude)], 'l'))
          commands.push('S')
          break
        }
        default:
          // Text note icon only; comments remain Unicode /Contents, never drawn over page text.
          commands.push(op([x, y, w, h], 're'), 'f', '0.2 G')
          for (const fraction of [0.3, 0.5, 0.7])
            commands.push(
              op([x + w * 0.2, y + h * fraction], 'm'),
              op([x + w * 0.8, y + h * fraction], 'l'),
              'S'
            )
      }
    }
    commands.push('Q')
    const appearanceCommands = commands.join('\n')
    // Tiny vector streams cost more compression workspace than they save in bytes.
    // Keep long paths compressed; do not retain a compressor per annotation or force GC.
    const stream = appearanceCommands.length < 1024 ? 'stream' : 'flateStream'
    const appearance = context.register(
      context[stream](appearanceCommands, {
        Type: 'XObject',
        Subtype: 'Form',
        FormType: 1,
        BBox: [0, 0, width, height],
        Resources: {
          ExtGState: {
            GS0: {
              Type: 'ExtGState',
              ca: opacity,
              CA: opacity,
              BM: mark.kind === 'highlight' ? 'Multiply' : 'Normal'
            }
          }
        }
      })
    )
    const annotation = context.obj({
      Type: 'Annot',
      Subtype: types[mark.kind],
      P: page.ref,
      NM: PDFHexString.fromText(mark.id),
      T: PDFHexString.fromText('Open Science - pdf-lib spike'),
      Subj: PDFHexString.fromText(mark.kind),
      Contents: PDFHexString.fromText(mark.note || ''),
      CreationDate: PDFHexString.fromText('D:20260920000000Z'),
      M: PDFHexString.fromText('D:20260920000000Z'),
      F: 4,
      C: color,
      CA: opacity,
      Rect: rect,
      AP: { N: appearance },
      ...(isTextMarkup ? { QuadPoints: mark.pdfQuads.flat() } : {}),
      ...(mark.kind === 'area'
        ? { IC: color, RD: [margin, margin, margin, margin], BS: { W: 1, S: 'S' } }
        : {}),
      ...(types[mark.kind] === 'Text' ? { Name: 'Note', Open: false } : {})
    })
    annotations.push(context.register(annotation))
  }
}
const output = await document.save({ useObjectStreams: true, updateFieldAppearances: false })
await writeFile(outputPath, output)
console.log(
  JSON.stringify({
    inputBytes: input.length,
    outputBytes: output.length,
    annotations: marks.length,
    pages: pages.length,
    importMs,
    exportMs: performance.now() - exportStart,
    exportCpuMs: Object.values(process.cpuUsage(exportCpu)).reduce((a, b) => a + b, 0) / 1000,
    totalMs: performance.now() - start,
    totalCpuMs: Object.values(process.cpuUsage(cpuStart)).reduce((a, b) => a + b, 0) / 1000,
    peakRssMiB: process.resourceUsage().maxRSS / 1024
  })
)
