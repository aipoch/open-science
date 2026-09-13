/* eslint-disable @typescript-eslint/explicit-function-return-type */

// Read-only feasibility probe, not a production layout parser.
// Usage: node scripts/spikes/literature-pdf-structure.mjs input.pdf output-directory [render-pages]
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createCanvas } from '@napi-rs/canvas'
import { getDocument, OPS, version } from 'pdfjs-dist/legacy/build/pdf.mjs'

const [inputPath, outputDirectory, renderPageList] = process.argv.slice(2)
assert(inputPath && outputDirectory, 'Supply a local PDF and an output directory.')
const renderPages = renderPageList?.split(',').map(Number)
if (renderPages)
  assert(
    renderPages.length <= 5 && renderPages.every((page) => Number.isSafeInteger(page) && page > 0),
    'Supply at most five positive render page numbers.'
  )
assert((await stat(inputPath)).size <= 50 * 1024 * 1024, 'Probe input exceeds 50 MiB.')
const bytes = await readFile(inputPath)
const assetRoot = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
const task = getDocument({
  data: new Uint8Array(bytes),
  standardFontDataUrl: `${join(assetRoot, 'standard_fonts')}/`,
  cMapUrl: `${join(assetRoot, 'cmaps')}/`,
  cMapPacked: true,
  isEvalSupported: false,
  useSystemFonts: false,
  verbosity: 0
})
const started = performance.now()
const document = await task.promise
const pages = []
let rendered = 0
try {
  // Production requests are bounded page batches, independent of document length.
  if (!renderPages) assert(document.numPages <= 100, 'Supply explicit pages for long documents.')
  if (renderPages) assert(renderPages.every((page) => page <= document.numPages))
  const outline = await document.getOutline()
  await mkdir(outputDirectory, { recursive: true })
  for (const pageNumber of renderPages ??
    Array.from({ length: document.numPages }, (_, i) => i + 1)) {
    const page = await document.getPage(pageNumber)
    try {
      const viewport = page.getViewport({ scale: 1 })
      const content = await page.getTextContent({ includeMarkedContent: true })
      const structure = await page.getStructTree()
      const operators = await page.getOperatorList()
      const roles = {}
      const visit = (node) => {
        if (node?.role) roles[node.role] = (roles[node.role] ?? 0) + 1
        node?.children?.forEach(visit)
      }
      visit(structure)
      const lines = []
      let pending = []
      const flush = () => {
        if (!pending.length) return
        const text = pending
          .map((item) => item.str)
          .join('')
          .trim()
        if (text) {
          // PDF.js synthetic spacing items can have zero height and oversized widths.
          // Preserve their text above, but do not treat invisible whitespace as painted bounds.
          const rects = pending
            .filter((item) => item.str.trim())
            .map((item) => {
              const [a, b, c, d, x, y] = item.transform
              const horizontal = Math.hypot(a, b)
              const vertical = Math.hypot(c, d)
              assert(horizontal > 0 && vertical > 0, 'Degenerate text transform.')
              // Retain each item's orientation, including chart-axis labels. These are advance
              // boxes, not exact glyph ink bounds; line grouping below remains stream-order based.
              const points = [
                [0, 0],
                [1, 0],
                [0, 1],
                [1, 1]
              ].map(([u, v]) =>
                viewport.convertToViewportPoint(
                  x + (u * item.width * a) / horizontal + (v * item.height * c) / vertical,
                  y + (u * item.width * b) / horizontal + (v * item.height * d) / vertical
                )
              )
              return {
                x: Math.min(...points.map((point) => point[0])),
                y: Math.min(...points.map((point) => point[1])),
                right: Math.max(...points.map((point) => point[0])),
                bottom: Math.max(...points.map((point) => point[1]))
              }
            })
          const x = Math.min(...rects.map((rect) => rect.x))
          const y = Math.min(...rects.map((rect) => rect.y))
          lines.push({
            text,
            fontSize: Math.max(...pending.map((item) => item.height)),
            x,
            y,
            width: Math.max(...rects.map((rect) => rect.right)) - x,
            height: Math.max(...rects.map((rect) => rect.bottom)) - y
          })
        }
        pending = []
      }
      for (const item of content.items) {
        if (!('str' in item)) continue
        if (pending.length && Math.abs(pending.at(-1).transform[5] - item.transform[5]) > 2) flush()
        pending.push(item)
        if (item.hasEOL) flush()
      }
      flush()
      // Deliberately expose false positives instead of claiming caption association.
      const captionStarts = lines.filter(({ text }) =>
        /^(?:Figure|Fig\.?|Table)\s+\d+[.:]?\s/i.test(text)
      )
      const headingCandidates = lines.filter(
        ({ text, fontSize }) =>
          text.length < 110 &&
          fontSize >= 10 &&
          /^(?:\d+(?:\.\d+)*\.?\s+[A-Z]|Abstract$|References$)/.test(text)
      )
      const counts = {}
      for (const [name, code] of Object.entries(OPS)) {
        if (/paint.*Image|constructPath/.test(name)) {
          const count = operators.fnArray.filter((op) => op === code).length
          if (count) counts[name] = count
        }
      }
      pages.push({
        pageNumber,
        width: viewport.width,
        height: viewport.height,
        rotation: page.rotate,
        structureRoles: roles,
        graphicsOperators: counts,
        captionStarts,
        headingCandidates,
        lines
      })
      if (renderPages ? renderPages.includes(pageNumber) : captionStarts.length && rendered < 2) {
        const scaled = page.getViewport({ scale: 1.5 })
        if (Math.ceil(scaled.width) * Math.ceil(scaled.height) > 4_000_000)
          throw new Error('PDF render pixel budget exceeded')
        const canvas = createCanvas(Math.ceil(scaled.width), Math.ceil(scaled.height))
        const context = canvas.getContext('2d')
        await page.render({
          canvas,
          canvasContext: context,
          viewport: scaled,
          recordOperations: true
        }).promise
        // PDF.js 5.4.624 records quantized normalized operation boxes, not semantic figure boxes.
        // The reader is typed as `any` upstream; validate this diagnostic on each PDF.js upgrade.
        const boxes = page.recordedBBoxes
        const graphicsBounds = []
        let invalidGraphicsBounds = 0
        for (let index = 0; index < operators.fnArray.length; index++) {
          const operation = operators.fnArray[index]
          if (
            (operation === OPS.constructPath || operation === OPS.paintImageXObject) &&
            !boxes.isEmpty(index)
          ) {
            const normalizedRect = [
              boxes.minX(index),
              boxes.minY(index),
              boxes.maxX(index),
              boxes.maxY(index)
            ]
            if (
              !normalizedRect.every(Number.isFinite) ||
              normalizedRect[2] <= normalizedRect[0] ||
              normalizedRect[3] <= normalizedRect[1]
            ) {
              invalidGraphicsBounds++
              continue
            }
            graphicsBounds.push({
              operationIndex: index,
              kind: operation === OPS.constructPath ? 'path' : 'image',
              normalizedRect
            })
          }
        }
        pages.at(-1).graphicsBounds = graphicsBounds
        pages.at(-1).invalidGraphicsBounds = invalidGraphicsBounds
        await writeFile(join(outputDirectory, `page-${pageNumber}.png`), await canvas.encode('png'))
        context.strokeStyle = '#c026d3'
        context.lineWidth = 2
        for (const rect of captionStarts)
          context.strokeRect(rect.x * 1.5, rect.y * 1.5, rect.width * 1.5, rect.height * 1.5)
        await writeFile(
          join(outputDirectory, `page-${pageNumber}-candidates.png`),
          await canvas.encode('png')
        )
        rendered++
      }
    } finally {
      page.cleanup()
    }
  }
  const summary = {
    pdfjsVersion: version,
    checksum: createHash('sha256').update(bytes).digest('hex'),
    pageCount: document.numPages,
    nativeOutlineRoots: outline?.length ?? 0,
    taggedPages: pages.filter((page) => Object.keys(page.structureRoles).length).length,
    captionStartCandidates: pages.reduce((sum, page) => sum + page.captionStarts.length, 0),
    headingCandidates: pages.reduce((sum, page) => sum + page.headingCandidates.length, 0),
    elapsedMs: Math.round(performance.now() - started)
  }
  await writeFile(
    join(outputDirectory, 'probe.json'),
    JSON.stringify({ summary, outline, pages }, null, 2) + '\n'
  )
  console.log(JSON.stringify(summary, null, 2))
} finally {
  await task.destroy()
}
