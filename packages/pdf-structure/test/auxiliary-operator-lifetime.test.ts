import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { resolve } from './paths'
import { anonymousAuxiliaryDenseVector } from './fixtures/auxiliary-dense-vector.mjs'

it('retains all auxiliary paint without holding both dense operator programs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pdf-auxiliary-lifetime-'))
  const count = 128
  try {
    const input = join(directory, 'input.pdf')
    const output = join(directory, 'geometry')
    const observation = join(directory, 'intent-lifetime.json')
    const runner = join(directory, 'observe-intents.mjs')
    const pdfjs = pathToFileURL(
      createRequire(import.meta.url).resolve('pdfjs-dist/legacy/build/pdf.mjs')
    ).href
    await writeFile(input, anonymousAuxiliaryDenseVector(count))
    // Observe the actual pinned PDF.js caches at render entry. This catches
    // duplicate retained programs without a machine-dependent heap threshold.
    await writeFile(
      runner,
      `
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { getDocument, version } from ${JSON.stringify(pdfjs)}
import assert from 'node:assert/strict'
import { createCanvas } from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('@napi-rs/canvas')).href)}
import { createHash } from 'node:crypto'

const [structure, input, output, observation] = process.argv.slice(2)
assert.equal(version, '5.4.624')
const assets = ${JSON.stringify(dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')).replaceAll('\\', '/'))}
const document = await getDocument({
  data: new Uint8Array(await readFile(input)),
  verbosity: 0,
  fontExtraProperties: true,
  isEvalSupported: false,
  useSystemFonts: false,
  standardFontDataUrl: assets + '/standard_fonts/',
  cMapUrl: assets + '/cmaps/',
  cMapPacked: true,
  wasmUrl: assets + '/wasm/'
}).promise
const page = await document.getPage(1)
const prototype = Object.getPrototypeOf(page)
const viewport = page.getViewport({ scale: 1.5 })
const canvas = createCanvas(viewport.width, viewport.height)
const hash = (canvas) => createHash('sha256')
  .update(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data)
  .digest('hex')
const source = (item) => ({
  str: item.str,
  transform: item.transform,
  width: item.width,
  height: item.height,
  dir: item.dir,
  hasEOL: item.hasEOL
})
await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise
const expectedPixels = hash(canvas)
const expectedSources = (await page.getTextContent()).items.map(source)
canvas.width = canvas.height = 1
await document.destroy()

const original = prototype.render
const records = []
const renderedPixels = []
prototype.render = function (...args) {
  const rawProgramsBeforeRender = [...this._intentStates.values()]
    .filter((state) => state.opListReadCapability && state.operatorList?.fnArray.length).length
  const task = original.apply(this, args)
  const record = {
    page: this.pageNumber,
    rawProgramsBeforeRender,
    programsDuringRender: this._intentStates.size
  }
  records.push(record)
  if (this.pageNumber === 1) {
    renderedPixels.push(task.promise.then(() => { record.pixels = hash(args[0].canvas) }))
  }
  return task
}
process.argv = [process.execPath, structure, input, output, '1', 'adjacent', 'production']
let snapshot
try {
  snapshot = (await import(pathToFileURL(structure))).nativeFigureRenderContexts.get(1)
  await Promise.all(renderedPixels)
} finally {
  prototype.render = original
}
assert(snapshot, 'Requested native render capture must remain available')
assert.deepEqual(snapshot.content.items.map(source), expectedSources,
  'Raw native text identities/geometry remain exact')
await writeFile(observation, JSON.stringify({ records, expectedPixels, sourceItems: expectedSources.length }))
`
    )
    await promisify(execFile)(
      process.execPath,
      [runner, resolve('resources/literature-pdf-structure.mjs'), input, output, observation],
      { timeout: 30000, windowsHide: true, env: { ...process.env, NODE_OPTIONS: '' } }
    )
    const result = JSON.parse(await readFile(join(output, 'probe.json'), 'utf8'))
    const observed = JSON.parse(await readFile(observation, 'utf8'))
    const lifetimes = observed.records
    expect(
      lifetimes.find((record: { page: number }) => record.page === 1).rawProgramsBeforeRender
    ).toBe(0)
    expect(lifetimes.find((record: { page: number }) => record.page === 1).pixels).toBe(
      observed.expectedPixels
    )
    expect(observed.sourceItems).toBeGreaterThan(1)
    expect(lifetimes.find((record: { page: number }) => record.page === 2)).toEqual({
      page: 2,
      rawProgramsBeforeRender: 0,
      programsDuringRender: 1
    })
    expect(result.pages.map((page: { pageNumber: number }) => page.pageNumber)).toEqual([1, 2])
    expect(result.pages[0].graphicsBounds.length).toBeGreaterThan(2)
    expect(result.pages[1].invalidGraphicsBounds).toBe(0)
    expect(result.pages[1].graphicsBounds).toHaveLength(count)
    expect(
      result.pages[1].graphicsBounds.every((g: { normalizedRect: number[] }) =>
        g.normalizedRect.every(Number.isFinite)
      )
    ).toBe(true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 40000)
