/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Offline experiment, not a production extractor or the official Table Transformer postprocessor.
// Usage: node scripts/spikes/literature-pdf-onnx.mjs PDF ASSET_DIR ORT_PACKAGE_OR_ENTRY PAGES OUT_DIR
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { cpus, platform, arch } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'
import { getDocument, version } from 'pdfjs-dist/legacy/build/pdf.mjs'
import sharp from 'sharp'
import { collectTableRules, findCaptionedNumericTableRegions } from './literature-pdf-graphics.mjs'
import { repairPdfSymbolText } from './literature-pdf-symbol-text.mjs'
import { readingRotation, isUprightText } from './literature-pdf-orientation.mjs'

const [pdfPath, assetDirectory, runtimeDirectory, pageList, outputDirectory, mode] =
  process.argv.slice(2)
assert(
  pdfPath && assetDirectory && runtimeDirectory && pageList && outputDirectory,
  'Supply PDF, model asset directory, onnxruntime-web package directory, comma-separated pages, output directory.'
)
const pages = pageList.split(',').map(Number)
assert(pages.length <= 5 && pages.every((page) => Number.isSafeInteger(page) && page > 0))
assert((await stat(pdfPath)).size <= 50 * 1024 * 1024, 'Input exceeds 50 MiB.')
const runtimePath = resolve(runtimeDirectory)
const runtimeEntry = (await stat(runtimePath)).isDirectory()
  ? join(runtimePath, 'dist/ort.node.min.mjs')
  : runtimePath
const ort = await import(pathToFileURL(runtimeEntry).href)
assert.equal(ort.env.versions.web, '1.29.0', 'Use the reviewed runtime version.')
ort.env.wasm.numThreads = 1
ort.env.wasm.proxy = false
const models = {
  detection: {
    revision: '187ac355617c8fee3d69c00d461ecf8eb8a4a5b7',
    sha256: '5be82ec9d157814ea8616588398d7baec17aed0780b870f7adf24b280ee1b5aa',
    longestEdge: 800,
    labels: ['table', 'table rotated']
  },
  structure: {
    revision: '5387550de655512721e1b88e4e42117001ba4813',
    sha256: '2c90a63298df61006a45267932f47b345a8b104ce53fd504eacf11aee3c05a41',
    longestEdge: 1000,
    labels: [
      'table',
      'table column',
      'table row',
      'table column header',
      'table projected row header',
      'table spanning cell'
    ]
  }
}
const sessions = {}
const modelEvidence = {}
const started = performance.now()
const pdfBytes = await readFile(pdfPath)
const assetRoot = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
const task = getDocument({
  data: new Uint8Array(pdfBytes),
  standardFontDataUrl: `${join(assetRoot, 'standard_fonts')}/`,
  cMapUrl: `${join(assetRoot, 'cmaps')}/`,
  cMapPacked: true,
  isEvalSupported: false,
  fontExtraProperties: true,
  useSystemFonts: false,
  verbosity: 0
})

async function infer(name, png, width, height) {
  const start = performance.now()
  const model = models[name]
  // Pinned conversion's shortest-edge 800 / longest-edge bound; bilinear via existing Sharp.
  const scale = Math.min(800 / Math.min(width, height), model.longestEdge / Math.max(width, height))
  const resizedWidth = Math.round(width * scale)
  const resizedHeight = Math.round(height * scale)
  const pixels = await sharp(png)
    .resize(resizedWidth, resizedHeight, { kernel: sharp.kernel.linear })
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer()
  const area = resizedWidth * resizedHeight
  assert.equal(pixels.length, area * 3)
  const input = new Float32Array(area * 3)
  const mean = [0.485, 0.456, 0.406]
  const std = [0.229, 0.224, 0.225]
  for (let i = 0; i < area; i++)
    for (let channel = 0; channel < 3; channel++)
      input[channel * area + i] = (pixels[3 * i + channel] / 255 - mean[channel]) / std[channel]
  const tensor = new ort.Tensor('float32', input, [1, 3, resizedHeight, resizedWidth])
  const preprocessMs = performance.now() - start
  const output = await sessions[name].run({ pixel_values: tensor })
  try {
    const classes = model.labels.length + 1
    assert.equal(output.logits.dims[2], classes)
    assert.equal(output.pred_boxes.dims[2], 4)
    const objects = []
    for (let q = 0; q < output.logits.dims[1]; q++) {
      const logits = Array.from(output.logits.data.slice(q * classes, (q + 1) * classes))
      const max = Math.max(...logits)
      const label = logits.indexOf(max)
      const score = 1 / logits.reduce((sum, value) => sum + Math.exp(value - max), 0)
      if (label === classes - 1 || score < 0.5) continue
      const [cx, cy, w, h] = output.pred_boxes.data.slice(q * 4, q * 4 + 4)
      const rect = [
        (cx - w / 2) * width,
        (cy - h / 2) * height,
        (cx + w / 2) * width,
        (cy + h / 2) * height
      ]
      assert(rect.every(Number.isFinite) && w > 0 && h > 0)
      objects.push({ label: model.labels[label], score, rect })
    }
    return {
      objects,
      inputSize: [resizedWidth, resizedHeight],
      preprocessMs: Math.round(preprocessMs),
      inferenceMs: Math.round(performance.now() - start - preprocessMs),
      memory: process.memoryUsage()
    }
  } finally {
    tensor.dispose()
    for (const value of Object.values(output)) value.dispose()
  }
}

function inside(rect, x, y) {
  return x >= rect[0] && x <= rect[2] && y >= rect[1] && y <= rect[3]
}

try {
  await mkdir(outputDirectory, { recursive: true })
  for (const [name, model] of Object.entries(models)) {
    const bytes = await readFile(join(assetDirectory, `${name}.onnx`))
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      model.sha256,
      'Model checksum mismatch.'
    )
    const start = performance.now()
    sessions[name] = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] })
    assert.deepEqual(sessions[name].inputNames, ['pixel_values'])
    modelEvidence[name] = {
      ...model,
      bytes: bytes.length,
      loadMs: Math.round(performance.now() - start)
    }
  }
  const document = await task.promise
  const results = []
  for (const pageNumber of pages) {
    assert(pageNumber <= document.numPages)
    const page = await document.getPage(pageNumber)
    try {
      const content = await repairPdfSymbolText(page, await page.getTextContent())
      const rotation = readingRotation(page, content)
      const viewport = page.getViewport({ scale: 1.5, rotation })
      assert(viewport.width * viewport.height <= 4_000_000)
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
      const context = canvas.getContext('2d')
      await page.render({ canvas, canvasContext: context, viewport }).promise
      const png = await canvas.encode('png')
      const detection = await infer('detection', png, canvas.width, canvas.height)
      const textItems = content.items
        .filter((item) => 'str' in item && item.str.trim())
        .map((item) => {
          const [x, baseline] = viewport.convertToViewportPoint(
            item.transform[4],
            item.transform[5]
          )
          return {
            text: item.str,
            x,
            baseline,
            width: item.width * 1.5,
            height: item.height * 1.5,
            horizontal: isUprightText(item, rotation)
          }
        })
      const rules = collectTableRules(await page.getOperatorList(), viewport)
      for (const rect of findCaptionedNumericTableRegions(
        textItems,
        rules,
        detection.objects.map((o) => o.rect)
      )) {
        detection.objects.push({ label: 'table', rect, origin: 'captioned-numeric-region' })
      }
      const tables = []
      for (const [index, object] of detection.objects.entries()) {
        if (object.label !== 'table') continue
        const id = `page-${pageNumber}-table-${index + 1}`
        const left = Math.max(0, Math.floor(object.rect[0]) - 10)
        const top = Math.max(0, Math.floor(object.rect[1]) - 10)
        const right = Math.min(canvas.width, Math.ceil(object.rect[2]) + 10)
        const bottom = Math.min(canvas.height, Math.ceil(object.rect[3]) + 10)
        assert(right > left && bottom > top)
        const crop = await sharp(png)
          .extract({ left, top, width: right - left, height: bottom - top })
          .png()
          .toBuffer()
        if (mode !== 'production') await writeFile(join(outputDirectory, `${id}.png`), crop)
        const structure = await infer('structure', crop, right - left, bottom - top)
        const rows = structure.objects
          .filter((item) => item.label === 'table row')
          .sort((a, b) => a.rect[1] - b.rect[1])
        const columns = structure.objects
          .filter((item) => item.label === 'table column')
          .sort((a, b) => a.rect[0] - b.rect[0])
        const spans = structure.objects.filter((item) => item.label === 'table spanning cell')
        const cells = rows.map(() => columns.map(() => []))
        const unassigned = []
        // ponytail: raw row/column intersections omit official refinement and merged-cell resolution.
        for (const item of textItems) {
          // Margin notices and diagonal watermarks can overlap a detector crop.
          // Their advance boxes are not horizontal cell coordinates. The page's
          // reading rotation has already been applied to genuine rotated tables.
          if (!item.horizontal) continue
          const x = item.x + item.width / 2 - left
          const y = item.baseline - item.height / 2 - top
          if (!inside([0, 0, right - left, bottom - top], x, y)) continue
          const row = rows.findIndex(({ rect }) => y >= rect[1] && y <= rect[3])
          const column = columns.findIndex(({ rect }) => x >= rect[0] && x <= rect[2])
          if (row < 0 || column < 0) unassigned.push(item.text)
          else cells[row][column].push(item)
        }
        // Horizontal order keeps superscripts attached; wrapped cells need a real reading-order resolver.
        const grid = cells.map((row) =>
          row.map((items) =>
            items
              .sort((a, b) => a.x - b.x || a.baseline - b.baseline)
              .map(
                (item, i, all) =>
                  (i > 0 && item.x - all[i - 1].x - all[i - 1].width > item.height * 0.15
                    ? ' '
                    : '') + item.text
              )
              .join('')
              .trim()
              .replace(/\s+/g, ' ')
          )
        )
        if (mode !== 'production')
          await writeFile(
            join(outputDirectory, `${id}.tsv`),
            grid.map((row) => row.join('\t')).join('\n') + '\n'
          )
        tables.push({
          id,
          detection: object,
          cropRect: [left, top, right, bottom],
          structure,
          rowCount: rows.length,
          columnCount: columns.length,
          spans,
          grid,
          unassigned
        })
        if (mode !== 'production') {
          context.strokeStyle = '#d50070'
          context.lineWidth = 3
          context.strokeRect(
            ...[
              object.rect[0],
              object.rect[1],
              object.rect[2] - object.rect[0],
              object.rect[3] - object.rect[1]
            ]
          )
          context.font = '18px sans-serif'
          context.fillStyle = '#d50070'
          context.fillText(
            `${index + 1}: ${rows.length} x ${columns.length}`,
            left,
            Math.max(20, top)
          )
        }
      }
      if (mode !== 'production')
        await writeFile(
          join(outputDirectory, `page-${pageNumber}-detected.png`),
          await canvas.encode('png')
        )
      results.push({
        page: pageNumber,
        coordinateSystem: 'PDF.js scale-1.5 viewport pixels',
        detection,
        tables
      })
      console.log(
        JSON.stringify({
          page: pageNumber,
          tables: tables.map(({ id, rowCount, columnCount, grid, unassigned }) => ({
            id,
            rowCount,
            columnCount,
            grid,
            unassigned
          }))
        })
      )
    } finally {
      page.cleanup()
    }
  }
  const report = {
    runtime: {
      node: process.versions.node,
      electron: process.versions.electron ?? null,
      ort: ort.env.versions.web,
      pdfjs: version,
      sharp: sharp.versions.sharp,
      platform: platform(),
      arch: arch(),
      cpu: cpus()[0]?.model
    },
    modelEvidence,
    sourceSha256: createHash('sha256').update(pdfBytes).digest('hex'),
    elapsedMs: Math.round(performance.now() - started),
    memory: process.memoryUsage(),
    maxRssKiB: process.resourceUsage().maxRSS,
    results
  }
  await writeFile(join(outputDirectory, 'onnx-probe.json'), JSON.stringify(report, null, 2) + '\n')
} finally {
  await task.destroy()
  for (const session of Object.values(sessions)) await session.release()
}
