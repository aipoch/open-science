/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Candidate extractor adapted from the reviewed offline experiment. Main owns authorization/cache.
// Usage: node scripts/spikes/literature-pdf-extract.mjs PDF ASSETS ORT_PACKAGE PAGES NEW_OUTPUT
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getDocument, version } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  captionKind,
  findCaptionCandidates,
  joinCaptionLines
} from './literature-pdf-caption-group.mjs'
import {
  associateFigures,
  associateUnnumberedFigure,
  associateGraphicalTables,
  resolveFigureCaption,
  findAlgorithmCandidates,
  associateAdjacentFigure,
  associateTableCaptions,
  associateGraphicalAbstract
} from './literature-pdf-association.mjs'
import { associateTableNotes } from './literature-pdf-table-notes.mjs'
import {
  hasTableEvidence,
  refineTable,
  recoverRuledTable,
  splitCaptionedTableRegions,
  recoverCaptionedRuledTables
} from './literature-pdf-table-refine.mjs'
import { deduplicateTableRegions } from './literature-pdf-table-regions.mjs'
import { recoverWrappedCountTable } from './literature-pdf-wrapped-count-grid.mjs'
import { groupTableParts } from './literature-pdf-table-group.mjs'
import { renderPdfCrop, recoverScannedFigures } from './literature-pdf-crop.mjs'
import { collectTableRules, excludeRepeatedMarginContent } from './literature-pdf-graphics.mjs'
import { repairPdfSymbolText, splitPdfNumericRuns } from './literature-pdf-symbol-text.mjs'
import { isUprightText, originalRect, rotatedTextRect } from './literature-pdf-orientation.mjs'
import { readFigureSequence } from './literature-pdf-figure-sequence.mjs'

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
await run('./literature-pdf-structure.mjs', [
  pdfPath,
  join(output, 'geometry'),
  pageArgument,
  'adjacent',
  'production'
])
await run('./literature-pdf-onnx.mjs', [
  pdfPath,
  assets,
  runtime,
  pageArgument,
  join(output, 'inference'),
  'production'
])
const geometry = JSON.parse(await readFile(join(output, 'geometry/probe.json'), 'utf8'))
geometry.pages = excludeRepeatedMarginContent(geometry.pages)
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
const captions = findCaptionCandidates(geometry.pages)
const figures = [],
  algorithms = [],
  tables = []
const imageRoot = join(output, 'thumbnails')
await mkdir(imageRoot)
const assetRoot = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
const task = getDocument({
  data: new Uint8Array(bytes),
  isEvalSupported: false,
  fontExtraProperties: true,
  useSystemFonts: false,
  verbosity: 0,
  standardFontDataUrl: `${join(assetRoot, 'standard_fonts')}/`,
  cMapUrl: `${join(assetRoot, 'cmaps')}/`,
  cMapPacked: true
})
const normalize = (rect, width, height) => rect.map((v, i) => v / (i % 2 ? height : width))
const pageWords = new Map(
  geometry.pages.map((page) => [
    page.pageNumber,
    new Set(
      page.lines.flatMap((line) =>
        (line.text.toLowerCase().match(/\p{L}+(?:[-\u2010\u2011]\p{L}+)*/gu) ?? []).map((word) =>
          word.replace(/[\u2010\u2011]/g, '-')
        )
      )
    )
  ])
)
const captionValue = (c) =>
  c
    ? {
        text: joinCaptionLines(c.lines, pageWords.get(c.page)),
        lines: c.lines,
        page: c.page,
        rect: c.rect
      }
    : undefined
try {
  const document = await task.promise
  const separatedFigures =
    document.numPages > 20 &&
    document.numPages <= 100 &&
    (captions.some((c) => /^(?:Fig\.|Figure)\s*\d/i.test(c.lines[0])) ||
      geometry.pages.some((p) =>
        p.graphicsBounds?.some(
          (g) =>
            g.kind === 'image' &&
            (g.normalizedRect[2] - g.normalizedRect[0]) *
              (g.normalizedRect[3] - g.normalizedRect[1]) >
              0.25
        )
      ))
      ? await readFigureSequence(document)
      : new Map()
  const firstLegend = Math.min(...[...separatedFigures.values()].map((c) => c.endPage ?? c.page))
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
    const pageInference = inference.results.find((p) => p.page === pageNumber)
    assert.equal(pageInference.coordinateSystem, 'PDF.js scale-1.5 viewport pixels')
    const scale = Math.ceil(pageGeometry.width * 1.5) / pageGeometry.width
    const page = await document.getPage(pageNumber)
    try {
      const crop = async (rect, id) => {
        const relativePath = `thumbnails/${id}.png`
        await writeFile(
          join(output, relativePath),
          await renderPdfCrop(page, rect, pageGeometry.renderRotation)
        )
        return relativePath
      }
      const pageAlgorithms = findAlgorithmCandidates(pageGeometry)
      for (const [index, algorithm] of pageAlgorithms.entries()) {
        const id = `p${pageNumber}-algorithm-${index + 1}`
        algorithms.push({
          id,
          page: pageNumber,
          caption: captionValue(algorithm.caption),
          region: normalize(algorithm.rect, pageGeometry.width, pageGeometry.height),
          thumbnail: await crop(algorithm.rect, id)
        })
      }
      // Exclude algorithm detections before cell reconstruction and graphic association.
      pageInference.tables = pageInference.tables.filter(
        (raw) =>
          !pageAlgorithms.some(({ rect }) => {
            const centerX = (raw.cropRect[0] + raw.cropRect[2]) / 3
            const centerY = (raw.cropRect[1] + raw.cropRect[3]) / 3
            return (
              centerX >= rect[0] && centerX <= rect[2] && centerY >= rect[1] && centerY <= rect[3]
            )
          })
      )
      const viewport = page.getViewport({ scale: 1.5, rotation: pageGeometry.renderRotation })
      const content = splitPdfNumericRuns(
        await repairPdfSymbolText(page, await page.getTextContent()),
        await page.getOperatorList()
      )
      const tokens = content.items
        .filter((i) => 'str' in i && i.str.trim())
        .map((i) => {
          const [x, baseline] = viewport.convertToViewportPoint(i.transform[4], i.transform[5])
          const horizontal = isUprightText(i, pageGeometry.renderRotation)
          return {
            text: i.str,
            inlineSymbol: i.inlineSymbol === true,
            baseline,
            height: i.height * 1.5,
            rect: horizontal
              ? [x, baseline - i.height * 1.5, x + i.width * 1.5, baseline]
              : rotatedTextRect(i, viewport),
            horizontal
          }
        })
      const rules = collectTableRules(await page.getOperatorList(), viewport)
      // Native table rules disambiguate headers styled like the caption above.
      // Refine only existing table candidates; figure associations keep their input.
      const ruledCaptions = findCaptionCandidates(
        [pageGeometry],
        new Map([[pageNumber, rules.map((rect) => rect.map((v) => v / 1.5))]])
      )
      for (const candidate of captions.filter(
        (c) => c.page === pageNumber && captionKind(c.lines[0]) === 'table'
      )) {
        const bounded = ruledCaptions.find(
          (c) =>
            c.lines[0] === candidate.lines[0] &&
            c.rect[1] === candidate.rect[1] &&
            (Math.abs(c.rect[0] - candidate.rect[0]) < 0.01 ||
              (c.rect[0] <= candidate.rect[0] + 0.01 && c.rect[2] >= candidate.rect[2] - 0.01))
        )
        if (bounded) Object.assign(candidate, bounded)
      }
      const pageCaptions = captions
        .filter((c) => c.page === pageNumber)
        .map((c) => ({ ...c, rect: c.rect.map((v) => v * 1.5) }))
      pageInference.tables = pageInference.tables.flatMap((table) =>
        splitCaptionedTableRegions(table, pageCaptions, rules)
      )
      pageInference.tables.push(
        ...recoverCaptionedRuledTables(
          tokens,
          rules,
          pageCaptions,
          pageNumber,
          pageInference.tables
        )
      )
      {
        const remainingRules = rules.filter(
          (r) =>
            !pageInference.tables.some((t) => {
              const c = t.cropRect,
                x = (r[0] + r[2]) / 2,
                y = (r[1] + r[3]) / 2
              // Detector crops can stop short of the outer border, especially for
              // off-page manuscript grids. Those borders still belong to that table.
              return x >= c[0] - 24 && x <= c[2] + 24 && y >= c[1] - 24 && y <= c[3] + 24
            })
        )
        const recovered = recoverRuledTable(tokens, remainingRules, pageNumber)
        if (recovered) pageInference.tables.push(recovered)
      }
      if (!pageCaptions.some((c) => captionKind(c.lines[0]) === 'table')) {
        const recovered = recoverWrappedCountTable(tokens, rules, pageNumber)
        if (recovered) {
          const r = recovered.cropRect
          const overlaps = pageInference.tables.filter((t) => {
            const b = t.cropRect
            return b[0] < r[2] && b[2] > r[0] && b[1] < r[3] && b[3] > r[1]
          })
          if (!overlaps.length) pageInference.tables.push(recovered)
          else if (overlaps.length === 1) {
            const prior = overlaps[0],
              b = prior.cropRect
            // Replace only a covering prediction with no source text outside
            // the validated grid. Do not discard neighboring or partial tables.
            if (
              b[0] <= r[0] &&
              b[1] <= r[1] &&
              b[2] >= r[2] &&
              b[3] >= r[3] &&
              !tokens.some(
                (i) =>
                  i.rect[0] >= b[0] &&
                  i.rect[2] <= b[2] &&
                  i.rect[1] >= b[1] &&
                  i.rect[3] <= b[3] &&
                  (i.rect[0] < r[0] || i.rect[2] > r[2] || i.rect[1] < r[1] || i.rect[3] > r[3])
              )
            )
              pageInference.tables.splice(pageInference.tables.indexOf(prior), 1, recovered)
          }
        }
      }
      pageInference.tables = deduplicateTableRegions(pageInference.tables, tokens)
      const refined = pageInference.tables.map((raw) =>
        refineTable(raw, tokens, pageCaptions, [], rules)
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
        captions,
        rules.map((rect) => rect.map((v) => v / 1.5))
      )
      const notes = associateTableNotes(
        pageGeometry,
        contentRects.map((rect) => ({ rect })),
        rules.map((rect) => rect.map((v) => v / 1.5))
      )
      for (const [index, tableNotes] of notes.entries()) {
        if (!tableNotes.length) continue
        refined[index] = refineTable(
          pageInference.tables[index],
          tokens,
          pageCaptions,
          tableNotes.map((note) => ({ ...note, rect: note.rect.map((v) => v * 1.5) })),
          rules
        )
      }
      // Cell row extents omit border rules; the full detected crop owns those rules too.
      const legendPage =
        pageNumber >= firstLegend &&
        pageNumber <= Math.max(...[...separatedFigures.values()].map((c) => c.endPage ?? c.page))
      // A confirmed separated legend section includes short continuation pages
      // where line numbers alone can look like a two-column table.
      const adjacentFigures = associateAdjacentFigure(pageGeometry, geometry.pages, captions)
      const captionedFigureRegions = [
        ...adjacentFigures,
        ...associateFigures(pageGeometry, captions)
      ].filter((f) => f.rect)
      const acceptedTables = refined.map(
        (table, index) =>
          (!legendPage || Boolean(associations[index].caption)) &&
          (Boolean(associations[index].caption) ||
            !captionedFigureRegions.some((f) => {
              const r = table.cropRect.map((v) => v / 1.5)
              return (
                pageGeometry.graphicsBounds.some((g) => {
                  const b = g.normalizedRect.map(
                    (v, i) => v * (i % 2 ? pageGeometry.height : pageGeometry.width)
                  )
                  const intersection =
                    Math.max(0, Math.min(r[2], b[2]) - Math.max(r[0], b[0])) *
                    Math.max(0, Math.min(r[3], b[3]) - Math.max(r[1], b[1]))
                  if (intersection / ((r[2] - r[0]) * (r[3] - r[1])) > 0.8) return true
                  // Detector padding can extend beyond an embedded risk table.
                  // Require the actual assigned source text to lie in the raster
                  // as well as the full predicted region in its captioned figure.
                  const source = table.cells.flatMap((cell) => cell.sourceRects ?? [])
                  if (!source.length) return false
                  const text = [
                    Math.min(...source.map((s) => s[0])),
                    Math.min(...source.map((s) => s[1])),
                    Math.max(...source.map((s) => s[2])),
                    Math.max(...source.map((s) => s[3]))
                  ].map((v) => v / 1.5)
                  const coverage =
                    Math.max(0, Math.min(text[2], b[2]) - Math.max(text[0], b[0])) *
                    Math.max(0, Math.min(text[3], b[3]) - Math.max(text[1], b[1]))
                  return (
                    g.kind === 'image' &&
                    coverage / ((text[2] - text[0]) * (text[3] - text[1])) > 0.8
                  )
                }) &&
                r[0] >= f.rect[0] - 12 &&
                r[2] <= f.rect[2] + 12 &&
                r[1] >= f.rect[1] - 12 &&
                r[3] <= f.rect[3] + 12
              )
            })) &&
          hasTableEvidence(table, associations[index].caption, tokens)
      )
      const recognizedTableRects = refined
        .filter((_, index) => acceptedTables[index])
        .map((table) => table.cropRect.map((v) => v / 1.5))
      for (const [index, table] of associateGraphicalTables(
        pageGeometry,
        captions,
        recognizedTableRects,
        refined
          .filter((t) => !t.grid.flat().some((s) => s.trim()))
          .map((t) => t.cropRect.map((v) => v / 1.5))
      ).entries()) {
        const id = `p${pageNumber}-graphical-table-${index + 1}`
        recognizedTableRects.push(table.rect)
        tables.push({
          id,
          page: pageNumber,
          caption: captionValue(table.caption),
          sourceViewport: { width: viewport.width, height: viewport.height, scale: 1.5 },
          grid: [],
          cells: [],
          unassigned: [],
          issues: ['no-source-cell-grid'],
          region: normalize(table.rect, pageGeometry.width, pageGeometry.height),
          thumbnail: await crop(table.rect, id)
        })
      }
      const localFigures = associateFigures(pageGeometry, captions, [
        ...recognizedTableRects,
        ...pageAlgorithms.map((a) => a.rect)
      ])
      let pageFigures =
        localFigures.length || recognizedTableRects.length
          ? localFigures
          : associateAdjacentFigure(pageGeometry, geometry.pages, captions)
      if (!pageFigures.length && !recognizedTableRects.length && !legendPage)
        pageFigures = await recoverScannedFigures(page, pageGeometry)
      if (legendPage) pageFigures = []
      if (
        !legendPage &&
        !pageFigures.length &&
        geometry.pages.some(
          (p) => (p.lines ?? []).filter((l) => /^##/.test(l.text.trim())).length >= 3
        )
      )
        pageFigures = associateUnnumberedFigure(pageGeometry, captions, recognizedTableRects)
      const plateCaption = separatedFigures.get(pageNumber)
      const plateImages = pageGeometry.graphicsBounds.filter(
        (g) =>
          g.kind === 'image' &&
          (g.normalizedRect[2] - g.normalizedRect[0]) *
            (g.normalizedRect[3] - g.normalizedRect[1]) >
            (plateCaption ? 0.03 : 0.25)
      )
      if (plateCaption && plateImages.length) {
        const footerTop = Math.min(
          pageGeometry.height,
          ...pageGeometry.lines
            .filter(
              (l) => l.y > pageGeometry.height * 0.9 && /Downloaded from|©|Copyright/i.test(l.text)
            )
            .map((l) => l.y)
        )
        const plateBounds = pageGeometry.graphicsBounds
          .filter(
            (g) =>
              g.normalizedRect[1] >= 0 &&
              g.normalizedRect[3] <= 0.99 &&
              g.normalizedRect[1] * pageGeometry.height < footerTop
          )
          .map((g) =>
            g.normalizedRect.map((v, i) => v * (i % 2 ? pageGeometry.height : pageGeometry.width))
          )
        const plateLabels = pageGeometry.lines
          .filter(
            (l) =>
              !/^(?:Figure|Fig\.)\s*\d+\.?$/i.test(l.text.trim()) &&
              l.y + l.height > 0 &&
              l.y + l.height < Math.min(footerTop, pageGeometry.height * 0.99)
          )
          .map((l) => [l.x, l.y, l.x + l.width, l.y + l.height])
        const parts = [...plateBounds, ...plateLabels]
        const plateRect = [
          Math.min(...parts.map((r) => r[0])),
          Math.max(0, Math.min(...parts.map((r) => r[1]))),
          Math.max(...parts.map((r) => r[2])),
          Math.min(footerTop, Math.max(...parts.map((r) => r[3])))
        ]
        pageFigures = [
          {
            caption: plateCaption,
            rect: plateRect,
            graphicsCount: 1
          }
        ]
        if (!geometry.pages.some((p) => p.pageNumber === plateCaption.page)) {
          const source = await document.getPage(plateCaption.page)
          const viewport = source.getViewport({ scale: 1 })
          geometry.pages.push({
            pageNumber: plateCaption.page,
            width: viewport.width,
            height: viewport.height,
            rotation: source.rotate,
            renderRotation: source.rotate,
            headingCandidates: []
          })
          source.cleanup()
        }
      } else if (
        !pageFigures.length &&
        !recognizedTableRects.length &&
        associateGraphicalAbstract(pageGeometry)
      ) {
        pageFigures = [associateGraphicalAbstract(pageGeometry)]
      } else if (
        pageNumber <= 3 &&
        !pageFigures.length &&
        !recognizedTableRects.length &&
        plateImages.length === 1 &&
        geometry.pages.some((p) => p.lines.some((line) => /[A-Za-z]{3}/.test(line.text))) &&
        (!tokens.some((item) => item.horizontal && !/^\d+$/.test(item.text.trim())) ||
          (pageNumber === 1 &&
            tokens.some((item) => /^(?:ABSTRACT|OBJECTIVES):?/.test(item.text.trim())))) &&
        (plateImages[0].normalizedRect[2] - plateImages[0].normalizedRect[0]) *
          (plateImages[0].normalizedRect[3] - plateImages[0].normalizedRect[1]) >=
          (tokens.some((item) => item.horizontal && !/^\d+$/.test(item.text.trim())) ? 0.25 : 0.65)
      ) {
        // An isolated early full-page plate can be a graphical abstract. Preserve
        // the image without inventing a numbered caption or scientific label.
        pageFigures = [
          {
            rect: plateImages[0].normalizedRect.map(
              (v, i) => v * (i % 2 ? pageGeometry.height : pageGeometry.width)
            ),
            graphicsCount: 1
          }
        ]
      }
      for (const [index, candidate] of pageFigures.entries()) {
        const id = `p${pageNumber}-figure-${index + 1}`
        // Advance boxes can miss glyph ink at an edge. Match the earlier diagnostic's 2px guard,
        // bounded by the page and the caption; publish the same expanded region used by the crop.
        const rect = candidate.rect && [
          Math.max(0, candidate.rect[0] - 2 / scale),
          Math.max(
            0,
            candidate.rect[1] - 2 / scale,
            candidate.caption?.page === pageNumber && candidate.caption.rect[3] <= candidate.rect[1]
              ? candidate.caption.rect[3] + 0.5
              : 0
          ),
          Math.min(pageGeometry.width, candidate.rect[2] + 2 / scale),
          Math.min(
            pageGeometry.height,
            candidate.caption?.page === pageNumber && candidate.caption.rect[1] >= candidate.rect[3]
              ? candidate.caption.rect[1] - 0.5
              : pageGeometry.height,
            candidate.rect[3] + 2 / scale
          )
        ]
        figures.push({
          id,
          page: pageNumber,
          caption: captionValue(resolveFigureCaption(candidate.caption, captions)),
          region: rect ? normalize(rect, pageGeometry.width, pageGeometry.height) : undefined,
          thumbnail: rect ? await crop(rect, id) : undefined,
          issue: candidate.reason,
          graphicsCount: candidate.graphicsCount
        })
      }
      const pageTables = []
      for (const [index, table] of refined.entries()) {
        const association = associations[index]
        const cropRect = [...table.cropRect]
        const caption = association.caption
        if (!acceptedTables[index]) continue
        if (caption && caption.rect[3] <= contentRects[index][1])
          cropRect[1] = Math.max(cropRect[1], (caption.rect[3] + 1) * 1.5)
        if (caption && caption.rect[1] >= contentRects[index][3])
          cropRect[3] = Math.min(cropRect[3], (caption.rect[1] - 1) * 1.5)
        for (const note of notes[index]) {
          if (note.rect[1] >= contentRects[index][3])
            cropRect[3] = Math.min(cropRect[3], note.rect[1] * 1.5 - 1)
        }
        pageTables.push({
          ...table,
          cropRect,
          notes: notes[index],
          page: pageNumber,
          caption: captionValue(association.caption),
          captionIssue: association.reason,
          sourceViewport: { width: viewport.width, height: viewport.height, scale: 1.5 }
        })
      }
      for (const table of groupTableParts(pageTables, pageGeometry)) {
        tables.push({
          ...table,
          region: normalize(table.cropRect, viewport.width, viewport.height),
          thumbnail: await crop(
            table.cropRect.map((v) => v / 1.5),
            table.id
          )
        })
      }
    } finally {
      page.cleanup()
    }
    console.log(JSON.stringify({ phase: 'assembled', page: pageNumber }))
  }
  geometry.pages.sort((a, b) => a.pageNumber - b.pageNumber)
  // Keep the original PDF's coordinate system at the worker boundary. Analysis
  // and thumbnails are upright, while source jumps still point into the original.
  const restoreCaption = (caption) => {
    if (!caption) return
    const p = geometry.pages.find((p) => p.pageNumber === caption.page)
    if (p)
      caption.rect = originalRect(
        caption.rect,
        p.width,
        p.height,
        (p.renderRotation - p.rotation + 360) % 360
      )
  }
  for (const item of [...figures, ...algorithms, ...tables]) {
    restoreCaption(item.caption)
    const p = geometry.pages.find((p) => p.pageNumber === item.page)
    const rotation = (p.renderRotation - p.rotation + 360) % 360
    if (!rotation) continue
    if (item.region) item.region = originalRect(item.region, 1, 1, rotation)
    const restoreTable = (data) => {
      const { width, height } = data.sourceViewport ?? {
        width: p.width * 1.5,
        height: p.height * 1.5
      }
      const restore = (rect) => originalRect(rect, width, height, rotation)
      if (data.cropRect) data.cropRect = restore(data.cropRect)
      for (const cell of data.cells ?? []) {
        cell.rect = restore(cell.rect)
        cell.sourceRects = cell.sourceRects.map(restore)
      }
      for (const row of data.rows ?? []) row.rect = restore(row.rect)
      for (const note of data.notes ?? [])
        note.rect = originalRect(note.rect, p.width, p.height, rotation)
      if (data.sourceViewport && rotation !== 180)
        data.sourceViewport = { ...data.sourceViewport, width: height, height: width }
    }
    restoreTable(item)
    item.parts?.forEach(restoreTable)
  }
  captions.forEach(restoreCaption)
  const scriptNames = [
    'literature-pdf-orientation.mjs',
    'literature-pdf-extract.mjs',
    'literature-pdf-crop.mjs',
    'literature-pdf-structure.mjs',
    'literature-pdf-graphics.mjs',
    'literature-pdf-onnx.mjs',
    'literature-pdf-caption-group.mjs',
    'literature-pdf-association.mjs',
    'literature-pdf-table-notes.mjs',
    'literature-pdf-page-geometry.mjs',
    'literature-pdf-table-refine.mjs',
    'literature-pdf-table-evidence.mjs',
    'literature-pdf-table-regions.mjs',
    'literature-pdf-source-records.mjs',
    'literature-pdf-table-geometry.mjs',
    'literature-pdf-table-row-repair.mjs',
    'literature-pdf-table-cell-merges.mjs',
    'literature-pdf-table-cell-text.mjs',
    'literature-pdf-record-grid.mjs',
    'literature-pdf-aligned-numeric-grid.mjs',
    'literature-pdf-native-header-grid.mjs',
    'literature-pdf-segmented-record-grid.mjs',
    'literature-pdf-numbered-matrix.mjs',
    'literature-pdf-ruled-narrative-grid.mjs',
    'literature-pdf-wrapped-proportion-grid.mjs',
    'literature-pdf-binary-comparison-grid.mjs',
    'literature-pdf-wrapped-summary-grid.mjs',
    'literature-pdf-deviation-grid.mjs',
    'literature-pdf-ruled-effect-grid.mjs',
    'literature-pdf-regression-grid.mjs',
    'literature-pdf-wrapped-count-grid.mjs',
    'literature-pdf-ruled-stub-grid.mjs',
    'literature-pdf-figure-sequence.mjs',
    'literature-pdf-table-group.mjs',
    'literature-pdf-symbol-text.mjs'
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
    auxiliaryPages: geometry.pages
      .map((p) => p.pageNumber)
      .filter((p) => !requestedPages.includes(p)),
    coordinates: {
      regions: 'normalized displayed PDF.js viewport',
      captionRects: 'scale-1 displayed viewport',
      tableRects: 'sourceViewport pixels'
    },
    pages: geometry.pages.map((p) => ({
      page: p.pageNumber,
      width: (p.renderRotation - p.rotation + 360) % 180 ? p.height : p.width,
      height: (p.renderRotation - p.rotation + 360) % 180 ? p.width : p.height,
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
    algorithms,
    tables
  }
  await writeFile(
    join(output, 'structure.pending.json'),
    JSON.stringify(
      result,
      // Token geometry is needed while assembling cells, but duplicates their
      // sourceRects and text in the final transport. Keep it out of the bounded
      // main-process payload, particularly for PDFs with one token per glyph.
      (key, value) => (key === 'sourceTokens' ? undefined : value),
      2
    ) + '\n'
  )
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
