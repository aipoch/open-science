/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Input may be synthetic rawRects or the application's normalized selector records.
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

const [inputArg, marksArg, outputArg, engineArg, repetitionsArg = '3', engineKind = 'mupdf'] =
  process.argv.slice(2)
assert(
  engineArg,
  'Usage: spike.mjs <input.pdf> <marks.json> <output.pdf> <engine module> [repetitions] [mupdf|pdf-lib]'
)
assert(['mupdf', 'pdf-lib'].includes(engineKind), 'Unknown export engine')
assert(Number.isInteger(Number(repetitionsArg)) && Number(repetitionsArg) > 0)
const author = `Open Science - ${engineKind === 'mupdf' ? 'MuPDF' : 'pdf-lib'} spike`
const [inputPath, marksPath, outputPath, enginePath] = [
  inputArg,
  marksArg,
  outputArg,
  engineArg
].map((p) => resolve(p))
assert.notEqual(inputPath, outputPath, 'The spike must not overwrite the source PDF')
await mkdir(dirname(outputPath), { recursive: true })
const inputBytes = await readFile(inputPath)
const fontPath = fileURLToPath(
  new URL('../../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)
)
const source = await pdfjs.getDocument({
  data: new Uint8Array(inputBytes),
  standardFontDataUrl: fontPath,
  disableFontFace: true
}).promise
const records = JSON.parse(await readFile(marksPath, 'utf8'))
const prepared = []
const rectBounds = (points) => [
  Math.min(...points.map((p) => p[0])),
  Math.min(...points.map((p) => p[1])),
  Math.max(...points.map((p) => p[0])),
  Math.max(...points.map((p) => p[1]))
]
const expectedText = []
const originalByPage = []
const annotationSignature = (a) => ({
  subtype: a.subtype,
  rect: a.rect,
  contents: a.contentsObj?.str,
  flags: a.annotationFlags,
  url: a.url
})
let originalAnnotations = 0
for (let i = 1; i <= source.numPages; i++) {
  const page = await source.getPage(i)
  expectedText.push((await page.getTextContent()).items.map((item) => item.str).join('\n'))
  const original = (await page.getAnnotations()).filter((a) => a.subtype !== 'Popup')
  originalAnnotations += original.length
  originalByPage.push(original.map(annotationSignature))
}
for (const record of records) {
  const selector = record.selector || record
  const pageNumber = selector.pageNumber || 1
  const page = await source.getPage(pageNumber)
  const viewport = page.getViewport({ scale: 1, rotation: selector.pageRotation ?? page.rotate })
  let normalizedRects = selector.quads || (selector.rect ? [selector.rect] : [])
  if (record.rawRects) {
    normalizedRects = record.rawRects.map((r) => {
      const [x0, y0, x1, y1] = rectBounds(
        [
          [r[0], r[1]],
          [r[2], r[3]]
        ].map((p) => viewport.convertToViewportPoint(...p))
      )
      return {
        x: x0 / viewport.width,
        y: y0 / viewport.height,
        width: (x1 - x0) / viewport.width,
        height: (y1 - y0) / viewport.height
      }
    })
  }
  // Page/document notes have no saved geometry. A margin icon is a spike policy only.
  if (!normalizedRects.length) normalizedRects = [{ x: 0.92, y: 0.04, width: 0.03, height: 0.03 }]
  const pdfRects = normalizedRects.map((r) =>
    rectBounds([
      viewport.convertToPdfPoint(r.x * viewport.width, r.y * viewport.height),
      viewport.convertToPdfPoint(
        (r.x + r.width) * viewport.width,
        (r.y + r.height) * viewport.height
      )
    ])
  )
  if (record.rawRects)
    pdfRects
      .flat()
      .forEach((value, index) =>
        assert(
          Math.abs(value - record.rawRects.flat()[index]) < 0.001,
          'Viewport coordinate round-trip failed'
        )
      )
  // Current selectors have axis-aligned boxes only. This preserves page rotations;
  // intrinsically tilted/vertical glyph baselines need richer selector geometry.
  prepared.push({
    ...record,
    pageNumber,
    pdfRect: pdfRects[0],
    normalizedRects,
    pdfQuads: pdfRects.map(([x0, y0, x1, y1]) => [x0, y1, x1, y1, x0, y0, x1, y0])
  })
}
const preparedPath = outputPath.replace(/\.pdf$/, '-prepared.json')
await writeFile(preparedPath, JSON.stringify(prepared))
const runs = []
for (let i = 0; i < Number(repetitionsArg); i++) {
  const run = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL(engineKind === 'mupdf' ? './export.mjs' : './export-pdf-lib.mjs', import.meta.url)
      ),
      enginePath,
      inputPath,
      preparedPath,
      outputPath
    ],
    { encoding: 'utf8' }
  )
  assert.equal(run.status, 0, run.stderr || run.stdout)
  runs.push(JSON.parse(run.stdout.trim().split('\n').at(-1)))
}
const result = await pdfjs.getDocument({
  data: new Uint8Array(await readFile(outputPath)),
  standardFontDataUrl: fontPath,
  disableFontFace: true
}).promise
assert.equal(result.numPages, source.numPages)
let annotationCount = 0
let checked = 0
let maxCoordinateError = 0
const types = {
  highlight: 'Highlight',
  underline: 'Underline',
  squiggly: 'Squiggly',
  strikethrough: 'StrikeOut',
  area: 'Square',
  'page-note': 'Text',
  'document-note': 'Text'
}
for (let i = 1; i <= result.numPages; i++) {
  const page = await result.getPage(i)
  assert.equal(
    (await page.getTextContent()).items.map((item) => item.str).join('\n'),
    expectedText[i - 1],
    `Page ${i}: text changed`
  )
  const annotations = await page.getAnnotations()
  assert.deepEqual(
    annotations
      .filter((a) => a.subtype !== 'Popup' && a.titleObj?.str !== author)
      .map(annotationSignature),
    originalByPage[i - 1],
    `Original annotations changed on page ${i}`
  )
  annotationCount += annotations.filter((a) => a.subtype !== 'Popup').length
  const exported = annotations.filter((a) => a.subtype !== 'Popup' && a.titleObj?.str === author)
  const expectedPage = prepared.filter((mark) => mark.pageNumber === i)
  assert.equal(exported.length, expectedPage.length)
  for (const [index, expected] of expectedPage.entries()) {
    // PDF.js exposes the indirect object ID, not the annotation's /NM stable name.
    const actual = exported[index]
    assert(actual, `Missing ${expected.id}`)
    assert.equal(actual.subtype, types[expected.kind])
    assert.equal(actual.contentsObj.str, expected.note || '', `Comment changed: ${expected.id}`)
    assert(actual.hasAppearance, `Missing appearance: ${expected.id}`)
    assert((actual.annotationFlags & 4) !== 0, 'Annotation must print')
    if (actual.quadPoints) {
      const flat = Array.from(actual.quadPoints)
      const expectedFlat = expected.pdfQuads.flat()
      assert.equal(flat.length, expectedFlat.length)
      for (let q = 0; q < flat.length; q++) {
        const error = Math.abs(flat[q] - expectedFlat[q])
        maxCoordinateError = Math.max(maxCoordinateError, error)
        assert(error < 0.02, `Quad position differs: ${expected.id}, ${error}`)
      }
    } else if (expected.kind === 'area') {
      // MuPDF expands /Rect by the border width. /RD retains the selected bounds.
      assert(actual.rect.every((value, index) => Math.abs(value - expected.pdfRect[index]) <= 1.02))
    }
    checked++
  }
}
assert.equal(checked, records.length)
assert.equal(annotationCount, records.length + originalAnnotations)
const report = {
  input: inputPath,
  output: outputPath,
  engine: engineKind === 'mupdf' ? 'mupdf@1.28.1' : 'pdf-lib@1.17.1',
  independentReader: `pdfjs-dist@${pdfjs.version}`,
  checks: {
    pages: result.numPages,
    checked,
    originalAnnotations,
    annotationCount,
    textUnchanged: true,
    contentsExact: true,
    appearancesPresent: true,
    maxCoordinateError
  },
  runs
}
await writeFile(outputPath.replace(/\.pdf$/, '-results.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
await result.destroy()
await source.destroy()
