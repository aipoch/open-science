/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Candidate extractor adapted from the reviewed offline experiment. Main owns authorization/cache.
// Usage: node scripts/spikes/literature-pdf-extract.mjs PDF ASSETS ORT_PACKAGE PAGES NEW_OUTPUT
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { getDocument, version } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { findCaptionCandidates, joinCaptionLines } from './literature-pdf-caption-group.mjs'
import {
  associateFigures,
  associateTableCaptions,
  associateTableNotes
} from './literature-pdf-association.mjs'
import { hasTableEvidence, refineTable } from './literature-pdf-table-refine.mjs'

const [pdfArgument, assetArgument, runtimeArgument, pageArgument, outputArgument] =
  process.argv.slice(2)
assert(
  pdfArgument && assetArgument && runtimeArgument && pageArgument && outputArgument,
  'Supply all five arguments.'
)
const pdfPath = resolve(pdfArgument),
  assets = resolve(assetArgument),
  runtime = resolve(runtimeArgument)
const output = resolve(outputArgument)
const requestedPages = pageArgument
  .split(',')
  .map(Number)
  .sort((a, b) => a - b)
assert(
  requestedPages.length > 0 &&
    requestedPages.length <= 5 &&
    requestedPages.every((p) => Number.isSafeInteger(p) && p > 0)
)
assert.equal(new Set(requestedPages).size, requestedPages.length)
// Refuse to mix a failed or earlier run with new evidence. Caller supplies an existing parent.
await mkdir(output)
// Each job has its own Worker thread; stages share no module cache with another job.
const run = async (script, args) => {
  console.log(JSON.stringify({ phase: script }))
  const previous = process.argv
  process.argv = [process.execPath, fileURLToPath(new URL(script, import.meta.url)), ...args]
  try {
    await import(new URL(script, import.meta.url).href)
  } finally {
    process.argv = previous
  }
}
await run('./literature-pdf-structure.mjs', [pdfPath, join(output, 'geometry'), pageArgument])
await run('./literature-pdf-onnx.mjs', [
  pdfPath,
  assets,
  runtime,
  pageArgument,
  join(output, 'inference')
])
const geometry = JSON.parse(await readFile(join(output, 'geometry/probe.json'), 'utf8'))
const inference = JSON.parse(await readFile(join(output, 'inference/onnx-probe.json'), 'utf8'))
assert.equal(geometry.summary.checksum, inference.sourceSha256)
assert.equal(geometry.summary.pdfjsVersion, version)
assert.equal(inference.runtime.pdfjs, version)
assert.deepEqual(
  inference.results.map((r) => r.page).sort((a, b) => a - b),
  requestedPages
)
const bytes = await readFile(pdfPath)
const checksum = createHash('sha256').update(bytes).digest('hex')
assert.equal(checksum, inference.sourceSha256)
const captions = findCaptionCandidates(
  geometry.pages.filter((p) => requestedPages.includes(p.pageNumber))
)
const figures = [],
  tables = []
const imageRoot = join(output, 'thumbnails')
await mkdir(imageRoot)
const assetRoot = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
const task = getDocument({
  data: new Uint8Array(bytes),
  isEvalSupported: false,
  useSystemFonts: false,
  verbosity: 0,
  standardFontDataUrl: `${join(assetRoot, 'standard_fonts')}/`,
  cMapUrl: `${join(assetRoot, 'cmaps')}/`,
  cMapPacked: true
})
const normalize = (rect, width, height) => rect.map((v, i) => v / (i % 2 ? height : width))
const captionValue = (c) =>
  c ? { text: joinCaptionLines(c.lines), lines: c.lines, page: c.page, rect: c.rect } : undefined
try {
  const document = await task.promise
  const outlineEntries = []
  const navigationIssues = []
  const visitOutline = async (entries, depth = 0) => {
    for (const entry of entries ?? []) {
      try {
        const destination =
          typeof entry.dest === 'string' ? await document.getDestination(entry.dest) : entry.dest
        if (!Array.isArray(destination) || !destination.length)
          throw new Error('No local destination')
        const index = Number.isInteger(destination[0])
          ? destination[0]
          : await document.getPageIndex(destination[0])
        assert(Number.isInteger(index) && index >= 0 && index < document.numPages)
        outlineEntries.push({ title: entry.title, page: index + 1, depth })
      } catch {
        navigationIssues.push({ title: entry.title, reason: 'unresolved-native-destination' })
      }
      await visitOutline(entry.items, depth + 1)
    }
  }
  await visitOutline(geometry.outline)
  for (const pageNumber of requestedPages) {
    const pageGeometry = geometry.pages.find((p) => p.pageNumber === pageNumber)
    assert.equal(pageGeometry.rotation, 0)
    const pageInference = inference.results.find((p) => p.page === pageNumber)
    assert.equal(pageInference.coordinateSystem, 'PDF.js scale-1.5 viewport pixels')
    const image = await loadImage(join(output, `geometry/page-${pageNumber}.png`))
    const scale = image.width / pageGeometry.width
    assert(Math.abs(image.height / pageGeometry.height - scale) < 0.002)
    const crop = async (rect, id) => {
      const left = Math.max(0, Math.floor(rect[0] * scale)),
        top = Math.max(0, Math.floor(rect[1] * scale))
      const right = Math.min(image.width, Math.ceil(rect[2] * scale)),
        bottom = Math.min(image.height, Math.ceil(rect[3] * scale))
      assert(right > left && bottom > top)
      const width = right - left,
        height = bottom - top
      const ratio = Math.min(1, 1200 / Math.max(width, height))
      const canvas = createCanvas(
        Math.max(1, Math.round(width * ratio)),
        Math.max(1, Math.round(height * ratio))
      )
      canvas
        .getContext('2d')
        .drawImage(image, left, top, width, height, 0, 0, canvas.width, canvas.height)
      const relativePath = `thumbnails/${id}.png`
      await writeFile(join(output, relativePath), await canvas.encode('png'))
      return relativePath
    }
    for (const [index, candidate] of associateFigures(pageGeometry, captions).entries()) {
      const id = `p${pageNumber}-figure-${index + 1}`
      // Advance boxes can miss glyph ink at an edge. Match the earlier diagnostic's 2px guard,
      // bounded by the page and the caption; publish the same expanded region used by the crop.
      const rect = candidate.rect && [
        Math.max(0, candidate.rect[0] - 2 / scale),
        Math.max(
          0,
          candidate.rect[1] - 2 / scale,
          candidate.caption.rect[3] <= candidate.rect[1] ? candidate.caption.rect[3] + 0.5 : 0
        ),
        Math.min(pageGeometry.width, candidate.rect[2] + 2 / scale),
        Math.min(
          pageGeometry.height,
          candidate.caption.rect[1] >= candidate.rect[3]
            ? candidate.caption.rect[1] - 0.5
            : pageGeometry.height,
          candidate.rect[3] + 2 / scale
        )
      ]
      figures.push({
        id,
        page: pageNumber,
        caption: captionValue(candidate.caption),
        region: rect ? normalize(rect, pageGeometry.width, pageGeometry.height) : undefined,
        thumbnail: rect ? await crop(rect, id) : undefined,
        issue: candidate.reason,
        graphicsCount: candidate.graphicsCount
      })
    }
    const page = await document.getPage(pageNumber)
    try {
      const viewport = page.getViewport({ scale: 1.5 })
      const content = await page.getTextContent()
      const tokens = content.items
        .filter((i) => 'str' in i && i.str.trim())
        .map((i) => {
          const [x, baseline] = viewport.convertToViewportPoint(i.transform[4], i.transform[5])
          return {
            text: i.str,
            baseline,
            height: i.height * 1.5,
            rect: [x, baseline - i.height * 1.5, x + i.width * 1.5, baseline],
            horizontal:
              i.dir === 'ltr' &&
              Math.abs(i.transform[1]) < 0.001 &&
              Math.abs(i.transform[2]) < 0.001
          }
        })
      const refined = pageInference.tables.map((raw) =>
        refineTable(
          raw,
          tokens,
          captions
            .filter((c) => c.page === pageNumber)
            .map((c) => ({ ...c, rect: c.rect.map((v) => v * 1.5) }))
        )
      )
      // Use recovered row extents, not the padded inference crop, for caption distance.
      const contentRects = refined.map((table) =>
        table.rows.length
          ? [
              table.cropRect[0],
              Math.min(...table.rows.map((r) => r.rect[1])),
              table.cropRect[2],
              Math.max(...table.rows.map((r) => r.rect[3]))
            ].map((v) => v / 1.5)
          : table.cropRect.map((v) => v / 1.5)
      )
      const associations = associateTableCaptions(
        pageGeometry,
        contentRects.map((rect) => ({ rect })),
        captions
      )
      const notes = associateTableNotes(
        pageGeometry,
        contentRects.map((rect) => ({ rect }))
      )
      for (const [index, raw] of pageInference.tables.entries()) {
        const table = refined[index]
        const association = associations[index]
        const cropRect = [...raw.cropRect]
        const caption = association.caption
        if (!hasTableEvidence(table, caption)) continue
        if (caption && caption.rect[3] <= contentRects[index][1])
          cropRect[1] = Math.max(cropRect[1], (caption.rect[3] + 1) * 1.5)
        if (caption && caption.rect[1] >= contentRects[index][3])
          cropRect[3] = Math.min(cropRect[3], (caption.rect[1] - 1) * 1.5)
        tables.push({
          ...table,
          notes: notes[index],
          page: pageNumber,
          caption: captionValue(association.caption),
          captionIssue: association.reason,
          sourceViewport: { width: viewport.width, height: viewport.height, scale: 1.5 },
          region: normalize(cropRect, viewport.width, viewport.height),
          thumbnail: await crop(
            cropRect.map((v) => v / 1.5),
            raw.id
          )
        })
      }
    } finally {
      page.cleanup()
    }
    console.log(JSON.stringify({ phase: 'assembled', page: pageNumber }))
  }
  const scriptNames = [
    'literature-pdf-extract.mjs',
    'literature-pdf-structure.mjs',
    'literature-pdf-onnx.mjs',
    'literature-pdf-caption-group.mjs',
    'literature-pdf-association.mjs',
    'literature-pdf-table-refine.mjs'
  ]
  const fingerprint = createHash('sha256')
  for (const name of scriptNames)
    fingerprint.update(name).update(await readFile(new URL(name, import.meta.url)))
  fingerprint.update(
    JSON.stringify(
      {
        pdfjs: version,
        ort: inference.runtime.ort,
        models: inference.modelEvidence,
        requestedPages
      },
      (key, value) => (['loadMs'].includes(key) ? undefined : value)
    )
  )
  const result = {
    schemaVersion: 1,
    warning: 'Experimental candidates; not a production cache, copy gate, or accuracy guarantee.',
    sourceSha256: checksum,
    extractorFingerprint: fingerprint.digest('hex'),
    pageCount: document.numPages,
    requestedPages,
    processedPages: requestedPages,
    coordinates: {
      regions: 'normalized displayed PDF.js viewport',
      captionRects: 'scale-1 displayed viewport',
      tableRects: 'sourceViewport pixels'
    },
    pages: geometry.pages.map((p) => ({
      page: p.pageNumber,
      width: p.width,
      height: p.height,
      rotation: p.rotation
    })),
    navigation: {
      mode: outlineEntries.length ? 'native' : 'pages',
      entries: outlineEntries,
      pages: Array.from({ length: document.numPages }, (_, i) => i + 1),
      issues: navigationIssues,
      untrustedHeadingCandidates: geometry.pages.flatMap((p) =>
        p.headingCandidates.map((h) => ({ ...h, page: p.pageNumber }))
      )
    },
    captionCandidates: captions,
    modelAssets: inference.modelEvidence,
    figures,
    tables
  }
  await writeFile(join(output, 'structure.pending.json'), JSON.stringify(result, null, 2) + '\n')
  await rename(join(output, 'structure.pending.json'), join(output, 'structure.json'))
  console.log(
    JSON.stringify({
      output,
      figures: figures.filter((f) => f.region).length,
      tables: tables.length,
      navigation: result.navigation.mode
    })
  )
} finally {
  await task.destroy()
}
