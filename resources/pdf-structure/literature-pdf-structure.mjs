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
import {
  captionKind,
  joinPdfSmallCapsLine,
  startsDetachedTableCaption,
  startsDetachedTextColumn
} from './literature-pdf-caption-group.mjs'
import { collectGraphicsBounds } from './literature-pdf-graphics.mjs'
import { getDocument, OPS, version } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { repairPdfSymbolText } from './literature-pdf-symbol-text.mjs'
import { readingRotation } from './literature-pdf-orientation.mjs'

const [inputPath, outputDirectory, renderPageList, adjacent, mode] = process.argv.slice(2)
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
  fontExtraProperties: true,
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
  const geometryPages =
    renderPages && adjacent === 'adjacent'
      ? [...new Set(renderPages.flatMap((page) => [page - 1, page, page + 1]))]
          .filter((page) => page > 0 && page <= document.numPages)
          .sort((a, b) => a - b)
      : renderPages
  const outline = await document.getOutline()
  await mkdir(outputDirectory, { recursive: true })
  for (const pageNumber of geometryPages ??
    Array.from({ length: document.numPages }, (_, i) => i + 1)) {
    let page
    let canvas
    const auxiliary = renderPages && !renderPages.includes(pageNumber)
    try {
      page = await document.getPage(pageNumber)
      let content = await page.getTextContent({ includeMarkedContent: true })
      const renderRotation = readingRotation(page, content)
      const viewport = page.getViewport({ scale: 1, rotation: renderRotation })
      const structure = await page.getStructTree()
      const operators = await page.getOperatorList()
      content = await repairPdfSymbolText(page, content, operators)
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
        const text = joinPdfSmallCapsLine(pending)
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
        if (startsDetachedTableCaption(pending, item) || startsDetachedTextColumn(pending, item))
          flush()
        if (
          pending.length &&
          Math.abs(
            viewport.convertToViewportPoint(...pending.at(-1).transform.slice(4))[1] -
              viewport.convertToViewportPoint(...item.transform.slice(4))[1]
          ) > 2
        )
          flush()
        pending.push(item)
        if (item.hasEOL) flush()
      }
      flush()
      // Deliberately expose false positives instead of claiming caption association.
      const captionStarts = lines.filter(({ text }) => captionKind(text))
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
        renderRotation,
        structureRoles: roles,
        graphicsOperators: counts,
        captionStarts,
        headingCandidates,
        lines
      })
      if (
        geometryPages ? geometryPages.includes(pageNumber) : captionStarts.length && rendered < 2
      ) {
        const scaled = page.getViewport({ scale: 1.5, rotation: renderRotation })
        if (Math.ceil(scaled.width) * Math.ceil(scaled.height) > 4_000_000)
          throw new Error('PDF render pixel budget exceeded')
        canvas = createCanvas(Math.ceil(scaled.width), Math.ceil(scaled.height))
        const context = canvas.getContext('2d')
        const rendering = page.render({
          canvas,
          canvasContext: context,
          viewport: scaled,
          recordOperations: true
        })
        await rendering.promise
        Object.assign(pages.at(-1), collectGraphicsBounds(rendering, page.recordedBBoxes))
        if (mode !== 'production') {
          await writeFile(
            join(outputDirectory, `page-${pageNumber}.png`),
            await canvas.encode('png')
          )
          context.strokeStyle = '#c026d3'
          context.lineWidth = 2
          for (const rect of captionStarts)
            context.strokeRect(rect.x * 1.5, rect.y * 1.5, rect.width * 1.5, rect.height * 1.5)
          await writeFile(
            join(outputDirectory, `page-${pageNumber}-candidates.png`),
            await canvas.encode('png')
          )
        }
        rendered++
      }
    } catch (error) {
      if (!auxiliary) throw error
      // Optional geometry must not turn a valid requested page into a failed extraction.
      const index = pages.findIndex((entry) => entry.pageNumber === pageNumber)
      if (index !== -1) pages.splice(index, 1)
    } finally {
      if (canvas) canvas.width = canvas.height = 1
      page?.cleanup()
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
