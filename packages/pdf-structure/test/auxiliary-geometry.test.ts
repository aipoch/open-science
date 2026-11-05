import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolve } from './paths'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

const { selectResultGeometryPages } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-geometry.mjs')).href
)
it('emits distant analysis geometry only for returned caption provenance', () => {
  const pages = [1, 2, 3, 4, 5, 6, 7].map((pageNumber) => ({ pageNumber }))
  const selected = (elements: unknown[]): number[] =>
    selectResultGeometryPages(pages, [3], elements).map(
      ({ pageNumber }: { pageNumber: number }) => pageNumber
    )
  expect(selected([])).toEqual([2, 3, 4])
  expect(selected([{ page: 3, caption: { page: 1 } }])).toEqual([1, 2, 3, 4])
  expect(selected([{ page: 3, caption: { regions: [{ page: 7 }] } }])).toEqual([2, 3, 4, 7])
  expect(selected([{ page: 3, caption: { page: 1, regions: [{ page: 7 }] } }])).toEqual([
    1, 2, 3, 4, 7
  ])
  expect(selected([{ page: 3, regions: [{ page: 6 }] }])).toEqual([2, 3, 4])
})

it.each(['oversized', 'rotated'])(
  'keeps requested geometry when an auxiliary page is %s',
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'pdf-auxiliary-'))
    try {
      const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> >>',
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${kind === 'oversized' ? '2400 2400' : '200 200'}] /Rotate ${kind === 'rotated' ? 90 : 0} /Resources << >> >>`,
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> >>'
      ]
      let pdf = '%PDF-1.4\n'
      const offsets = objects.map((object, i) => {
        const offset = pdf.length
        pdf += `${i + 1} 0 obj\n${object}\nendobj\n`
        return offset
      })
      const xref = pdf.length
      pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
      const input = join(root, 'input.pdf')
      await writeFile(input, pdf)
      const script = resolve('resources/literature-pdf-structure.mjs')
      const output = join(root, 'geometry')
      const run = spawnSync(process.execPath, [script, input, output, '3', 'adjacent'], {
        encoding: 'utf8',
        timeout: 10000
      })
      expect(run.status, run.stderr).toBe(0)
      const result = JSON.parse(await readFile(join(output, 'probe.json'), 'utf8'))
      expect(result.pages.map((page: { pageNumber: number }) => page.pageNumber)).toEqual(
        kind === 'rotated' ? [1, 2, 3] : [1, 3]
      )
      expect(result.pages[0].graphicsBounds).toEqual([])
      const production = join(root, 'production')
      const fast = spawnSync(
        process.execPath,
        [script, input, production, '3', 'adjacent', 'production'],
        {
          encoding: 'utf8',
          timeout: 10000
        }
      )
      expect(fast.status, fast.stderr).toBe(0)
      const optimized = JSON.parse(await readFile(join(production, 'probe.json'), 'utf8'))
      expect(optimized.pages).toEqual(result.pages)
      await expect(readFile(join(production, 'page-1.png'))).rejects.toMatchObject({
        code: 'ENOENT'
      })
      await expect(readFile(join(production, 'page-1-candidates.png'))).rejects.toMatchObject({
        code: 'ENOENT'
      })

      if (kind === 'oversized') {
        const invalid = spawnSync(
          process.execPath,
          [script, input, join(root, 'requested'), '2', 'adjacent'],
          { encoding: 'utf8', timeout: 10000 }
        )
        expect(invalid.status).not.toBe(0)
        expect(invalid.stderr).toContain('pixel budget exceeded')
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

it('publishes complete geometry and usable retained native evidence after the structure phase closes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pdf-retained-geometry-'))
  try {
    const stream =
      '0 g 30 60 140 80 re f BT /F 10 Tf 1 0 0 1 30 30 Tm (Figure 1: Retained drawing.) Tj ET'
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
    ]
    let pdf = '%PDF-1.4\n'
    const offsets = objects.map((object, i) => {
      const offset = pdf.length
      pdf += `${i + 1} 0 obj\n${object}\nendobj\n`
      return offset
    })
    const xref = pdf.length
    pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
    const input = join(root, 'input.pdf'),
      output = join(root, 'geometry'),
      script = resolve('resources/literature-pdf-structure.mjs')
    await writeFile(input, pdf)
    const inspected = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        String.raw`
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
const [input, output, script] = process.argv.slice(1)
process.argv = [process.execPath, script, input, output, '1', 'adjacent', 'production', 'caption-raster']
const phase = await import(pathToFileURL(script).href)
const probe = JSON.parse(await readFile(join(output, 'probe.json'), 'utf8'))
assert.equal(probe.summary.pageCount, 1)
assert.equal(probe.pages.length, 1)
const page = probe.pages[0]
assert.equal(page.pageNumber, 1)
assert(page.lines.some(line => line.text === 'Figure 1: Retained drawing.'))
assert(page.graphicsBounds.some(graphic => graphic.kind === 'path'))
const snapshot = phase.nativeFigureRenderContexts.get(1)
assert(snapshot)
assert.deepEqual(snapshot.graphicsBounds, page.graphicsBounds)
const raster = snapshot.captionLaneRaster
assert(raster)
assert(phase.nativePageRasterFiles.has(raster.path))
const png = await readFile(raster.path)
assert.equal(createHash('sha256').update(png).digest('hex'), raster.sha256)
assert.equal(png.readUInt32BE(16), 300)
assert.equal(png.readUInt32BE(20), 300)
const require = createRequire(pathToFileURL(script))
const { default: sharp } = await import(pathToFileURL(require.resolve('sharp')).href)
const pixels = await sharp(png).removeAlpha().raw().toBuffer()
assert.deepEqual([...pixels.subarray((100 * 300 + 100) * 3, (100 * 300 + 100) * 3 + 3)], [0, 0, 0])
const { getDocument } = await import(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href)
const { matchNativeFigureRenderContext } = await import(pathToFileURL(join(dirname(script), 'literature-pdf-render-bounds.mjs')).href)
const { tableTextToken } = await import(pathToFileURL(join(dirname(script), 'literature-pdf-orientation.mjs')).href)
const { createNativeFigurePaintCertificate, nativeFigurePaintCertificateData } = await import(pathToFileURL(join(dirname(script), 'literature-pdf-figure-native-plot-labels.mjs')).href)
const assets = dirname(require.resolve('pdfjs-dist/package.json'))
const task = getDocument({data:new Uint8Array(await readFile(input)), standardFontDataUrl:join(assets,'standard_fonts')+'/', cMapUrl:join(assets,'cmaps')+'/', wasmUrl:join(assets,'wasm')+'/', cMapPacked:true, isEvalSupported:false, fontExtraProperties:true, useSystemFonts:false, verbosity:0})
try {
  const document = await task.promise, nativePage = await document.getPage(1)
  const content = await nativePage.getTextContent(), viewport = nativePage.getViewport({scale:1, rotation:page.renderRotation})
  const context = {...matchNativeFigureRenderContext(snapshot, 1, content, viewport, page.graphicsBounds, probe.summary.checksum), pageNumber:1, sourceSha256:probe.summary.checksum}
  assert(context.content)
  const tokens = context.content.items.filter(item => item.str.trim()).map(item => tableTextToken(item, context.viewport, 0))
  const handle = createNativeFigurePaintCertificate(page, tokens, context)
  const data = nativeFigurePaintCertificateData(handle, page, tokens, context)
  assert(data?.pieces.some(piece => piece.kind === 'path'))
  assert(data.pieces.some(piece => piece.kind === 'glyph'))
  assert.equal(nativeFigurePaintCertificateData(structuredClone(handle), page, tokens, context), undefined)
  const original = context.operators.argsArray
  context.operators.argsArray = structuredClone(original)
  assert.equal(nativeFigurePaintCertificateData(handle, page, tokens, context), undefined)
  context.operators.argsArray = original
  assert(nativeFigurePaintCertificateData(handle, page, tokens, context))
} finally { await task.destroy() }
console.log('retained-evidence-ok')
`,
        input,
        output,
        script
      ],
      { encoding: 'utf8', timeout: 12000 }
    )
    expect(inspected.status, inspected.stderr).toBe(0)
    expect(inspected.stdout).toContain('retained-evidence-ok')
  } finally {
    expect(resolve(root, '..')).toBe(resolve(tmpdir()))
    await rm(root, { recursive: true, force: true })
  }
})
