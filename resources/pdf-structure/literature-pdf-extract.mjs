/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Candidate extractor adapted from the reviewed offline experiment. Main owns authorization/cache.
// Usage: node resources/pdf-structure/literature-pdf-extract.mjs PDF ASSETS ORT_PACKAGE PAGES NEW_OUTPUT
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getDocument, version } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  captionKind,
  applyRuledCaptionRecovery,
  excludePdfLineNumbers,
  findCaptionCandidates,
  recoverAuxiliaryTableCaptions,
  joinCaptionLines,
  sourceWordSpellings
} from './literature-pdf-caption-group.mjs'
import {
  associateFigures,
  deduplicateFigureCaptions,
  associateUnnumberedFigure,
  associateUncaptionedRasterFigure,
  associateGraphicalTables,
  associateRasterTables,
  resolveFigureCaption,
  findAlgorithmCandidates,
  associateAdjacentFigure,
  associatePreviousPageRasterFigure,
  associateTableCaptions,
  associateGraphicalAbstract
} from './literature-pdf-association.mjs'
import {
  associateTableNotes,
  tableNoteOwnershipRect,
  associateContinuedTableNotes,
  recoverRuledDoseNoteCrop,
  recoverRuledDefinitionNoteCrop,
  recoverRepeatedRecordFooterNotes
} from './literature-pdf-table-notes.mjs'
import {
  inside,
  rebaseTableCrop,
  selectResultGeometryPages
} from './literature-pdf-table-geometry.mjs'
import {
  hasTableEvidence,
  refineTable,
  recoverRuledTable,
  seedNativeClosedRecordTable,
  splitCaptionedTableRegions,
  recoverCaptionedRuledTables,
  recoverNativeIndependentCaptionedTables,
  recoverNativeIndependentPanelParts,
  recoverNativeFourFieldOrdinaryRecordOwners
} from './literature-pdf-table-refine.mjs'
import {
  recoverNativeFencedGroupLabels,
  recoverNativeExistingWholeRecordRows,
  recoverNativeBlankFirstLeafOwners,
  recoverNativeStackedSharedCaptionParts
} from './literature-pdf-native-leaf-record-repair.mjs'
import {
  deduplicateTableRegions,
  narrativeDuplicateTableIndices
} from './literature-pdf-table-regions.mjs'
import {
  splitRuledComparisonSections,
  groupRuledComparisonSections
} from './literature-pdf-ruled-narrative-grid.mjs'
import {
  isFigureRiskTable,
  isFigureOwnedPartialTable,
  proveCaptionedNativeDefinitionFrame,
  proveCaptionedNativeClosedTableFrame,
  findCaptionedNativeClosedTableFrames,
  isRecognizedAlgorithmOwnedTable,
  nativeSourceDuplicateTableIndices,
  isNativeRepeatedAuthorContactPanel,
  recoverNativeCenteredTableCaption,
  isNativeClosedFrameOwnedByTable
} from './literature-pdf-table-evidence.mjs'
import { recoverNativeMixedSectionParts } from './literature-pdf-native-mixed-section-parts.mjs'
import { proveNativeCaptionRaisedGlyphOwnership } from './literature-pdf-native-caption-raised-glyphs.mjs'
import { recoverNativeCaptionOverlayAccentLines } from './literature-pdf-native-caption-overlay-accents.mjs'
import {
  recoverOwnedTableCrop,
  trimTableCaptionCrop,
  trimTableNoteCrop,
  tableMarginCropTop
} from './literature-pdf-table-geometry.mjs'
import { recoverWrappedCountTable } from './literature-pdf-wrapped-count-grid.mjs'
import { groupTableParts, recoverPriorPageTableCaption } from './literature-pdf-table-group.mjs'
import {
  recoverRepeatedRecordBlocks,
  groupRepeatedRecordBlocks
} from './literature-pdf-repeated-record-blocks.mjs'
import {
  proveDescriptiveRecordBlock,
  provePairedStatisticGutters,
  recoverDescriptiveRecordBlock,
  groupDescriptiveRecordBlocks
} from './literature-pdf-descriptive-record-block.mjs'
import {
  findClosedDefinitionTailFrame,
  recoverClosedDefinitionTail
} from './literature-pdf-closed-definition-tail.mjs'
import {
  recoverMixedQuestionSections,
  groupMixedQuestionSections
} from './literature-pdf-long-question-record-grid.mjs'
import { recoverNativeQuestionContinuationCaption } from './literature-pdf-native-question-continuation.mjs'
import { renderPdfCrop, recoverScannedFigures } from './literature-pdf-crop.mjs'
import {
  nativeOwnedFigureInkBottom,
  nativeProseInkTopLimit
} from './literature-pdf-figure-crop-geometry.mjs'
import {
  collectTableRules,
  collectClosedFigureFrames,
  excludeRepeatedMarginContent,
  excludeRemovedMarginTokens
} from './literature-pdf-graphics.mjs'
import {
  repairPdfSymbolText,
  splitPdfNumericRuns,
  nativeWhitespaceGaps
} from './literature-pdf-symbol-text.mjs'
import {
  proveNativeScientificLeafGutters,
  recoverNativeScientificLeafRecordGrid
} from './literature-pdf-native-scientific-leaf-gutters.mjs'
import { recoverNativeMeanDeviationRecords } from './literature-pdf-native-mean-deviation-records.mjs'
import { findCaptionedNativePartialRuleTable } from './literature-pdf-native-header-grid.mjs'
import { isNativeFrontMatterRegion } from './literature-pdf-front-matter.mjs'
import {
  originalRect,
  tableTextToken,
  restoreCaptionCoordinates
} from './literature-pdf-orientation.mjs'
import { readFigureSequence, rasterPlateRect } from './literature-pdf-figure-sequence.mjs'
import { nativeRepeatedMatrixCandidate } from './literature-pdf-native-repeated-matrix-candidate.mjs'
import {
  getNativePairedTextContextDirection,
  recoverNativePairedTextCaption
} from './literature-pdf-native-bounded-text-record-grid.mjs'
import { recoverNativeRepeatedMatrixParts } from './literature-pdf-native-repeated-matrix-grid.mjs'
import {
  recoverPriorCohortContinuation,
  recoverNativeCountContinuationCaption,
  isNativeAuthorAffiliationRegion,
  recoverAdjacentStatisticalSections,
  groupNativeStatisticalSections,
  recoverEnclosedTableDescriptionCaption,
  isExternalAttachmentTableRegion
} from './literature-pdf-native-table-candidates.mjs'
import { serializeWorkerResult } from './scratch.mjs'

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
const originalPages = new Map(geometry.pages.map((page) => [page.pageNumber, page]))
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
const captions = recoverAuxiliaryTableCaptions(
  geometry.pages,
  findCaptionCandidates(geometry.pages),
  requestedPages
)
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
const nativeTextTokens = (content, viewport, rotation, includeFontMetrics = false) =>
  content.items
    .filter((i) => 'str' in i && i.str.trim())
    .map((item) => ({
      ...tableTextToken(item, viewport, rotation),
      ...(includeFontMetrics ? { fontDescent: content.styles[item.fontName]?.descent } : {})
    }))
const pageWords = new Map(
  geometry.pages.map((page) => [
    page.pageNumber,
    sourceWordSpellings(page.lines.map((line) => line.text))
  ])
)
const captionValue = (c) =>
  c
    ? {
        text: joinCaptionLines(
          c.lines,
          c.regions
            ? new Set(c.regions.flatMap(({ page }) => [...(pageWords.get(page) ?? [])]))
            : pageWords.get(c.page)
        ),
        lines: c.lines,
        page: c.page,
        rect: c.rect,
        ...(c.regions ? { regions: c.regions } : {})
      }
    : undefined
// Neighbor geometry may own the first half of a caption outside this job.
// Prove its graphic locally before suppressing a caption-only tail; never
// publish the auxiliary figure as a newly processed page.
const auxiliaryCaptionOwners = captions.flatMap((caption) => {
  if (requestedPages.includes(caption.page)) return []
  const combined = resolveFigureCaption(caption, captions, geometry.pages)
  if (!combined.regions) return []
  const page = geometry.pages.find((p) => p.pageNumber === caption.page)
  if (!page) return []
  return associateFigures(page, captions)
    .filter((figure) => figure.rect && figure.caption === caption)
    .map((figure) => ({ region: figure.rect, caption: captionValue(combined) }))
})
try {
  const document = await task.promise
  const separatedFigures =
    document.numPages > 20 &&
    document.numPages <= 100 &&
    (captions.some((c) => /^(?:Fig\.|Figure)\s*\d/i.test(c.lines[0])) ||
      geometry.pages.some(
        (p) =>
          p.graphicsBounds?.filter((g) => g.kind === 'path').length >= 3 &&
          p.lines.every((l) => l.text.length < 100)
      ) ||
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
      const crop = async (rect, id, regions) => {
        const relativePath = `thumbnails/${id}.png`
        await writeFile(
          join(output, relativePath),
          await renderPdfCrop(page, rect, pageGeometry.renderRotation, regions)
        )
        return relativePath
      }
      const nativeViewport = page.getViewport({ scale: 1, rotation: pageGeometry.renderRotation })
      const operators = await page.getOperatorList()
      // A numbered algorithm's opening rule can occupy the running-head band.
      // The algorithm proof checks its complete frame and numbered steps; retain
      // that native frame while ordinary figure/table inputs still omit headers.
      const pageAlgorithms = findAlgorithmCandidates(
        originalPages.get(pageNumber) ?? pageGeometry,
        collectTableRules(operators, nativeViewport)
      )
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
            const centerX = (raw.cropRect[0] + raw.cropRect[2]) / 2
            const centerY = (raw.cropRect[1] + raw.cropRect[3]) / 2
            return (
              centerX >= rect[0] && centerX <= rect[2] && centerY >= rect[1] && centerY <= rect[3]
            )
          })
      )
      const viewport = page.getViewport({ scale: 1.5, rotation: pageGeometry.renderRotation })
      const originalContent = await page.getTextContent()
      const sourceContent = {
        ...originalContent,
        items: originalContent.items.map((item, index) =>
          'str' in item ? { ...item, sourceItem: { pageNumber, index, text: item.str } } : item
        )
      }
      // Figure labels retain original native glyph items. Symbol repair can
      // replace or suppress an item while reconstructing table/formula text;
      // its original measured label bounds still belong to the rendered figure.
      const sourceFigureTokens = excludeRemovedMarginTokens(
        nativeTextTokens(sourceContent, viewport, pageGeometry.renderRotation, true),
        originalPages.get(pageNumber),
        pageGeometry,
        1.5
      )
      const content = splitPdfNumericRuns(
        excludePdfLineNumbers(await repairPdfSymbolText(page, sourceContent), nativeViewport, {
          tableRects: pageInference.tables.map((t) => t.cropRect.map((v) => v / 1.5)),
          captions: captions.filter((c) => c.page === pageNumber),
          rules: collectTableRules(operators, nativeViewport)
        }),
        operators,
        { viewport: nativeViewport, rules: collectTableRules(operators, nativeViewport) }
      )
      const measuredRuns = nativeWhitespaceGaps(content, operators, viewport)
      let tokens = excludeRemovedMarginTokens(
        nativeTextTokens(content, viewport, pageGeometry.renderRotation),
        originalPages.get(pageNumber),
        pageGeometry,
        1.5
      )
      const rulePaintBounds = new Map()
      const rules = collectTableRules(operators, viewport, rulePaintBounds)
      const closedFrames = collectClosedFigureFrames(
        operators,
        page.getViewport({ scale: 1, rotation: pageGeometry.renderRotation })
      )
      // Native rules establish caption paragraph bounds and retain inline math
      // fragments. Update only uniquely matching existing caption identities.
      const ruledCaptions = findCaptionCandidates(
        [pageGeometry],
        new Map([[pageNumber, rules.map((rect) => rect.map((v) => v / 1.5))]])
      )
      applyRuledCaptionRecovery(
        captions,
        ruledCaptions,
        pageGeometry,
        rules.map((rect) => rect.map((v) => v / 1.5))
      )
      // Use original native single-glyph items after ruled caption recovery.
      // Preserve the canonical caption object; serialization joins its new lines.
      for (const caption of captions.filter((c) => c.page === pageNumber)) {
        const accentLines = recoverNativeCaptionOverlayAccentLines(
          pageGeometry,
          caption,
          sourceFigureTokens,
          1.5
        )
        if (accentLines) caption.lines = accentLines
      }
      const pageCaptions = captions
        .filter((c) => c.page === pageNumber)
        .map((c) => ({ ...c, rect: c.rect.map((v) => v * 1.5) }))
      const continuationCaptions = new Map()
      const nativeDefinitionTails = new Set()
      const scientificGutters = []
      if (
        pageInference.tables.some((table) =>
          [8, 9].includes(
            table.structure.objects.filter((object) => object.label === 'table column').length
          )
        )
      ) {
        const nativeRuns = nativeWhitespaceGaps(content, operators, viewport)
        for (const table of pageInference.tables) {
          const proof = proveNativeScientificLeafGutters(
            table,
            tokens,
            pageCaptions,
            rules,
            nativeRuns
          )
          if (!proof) continue
          const frame = {
            rect: proof.rect.map((v) => v / 1.5),
            cuts: proof.cuts.map((v) => v / 1.5),
            gutterBands: proof.gutterBands.map((band) => band.map((v) => v / 1.5))
          }
          const revised = excludeRemovedMarginTokens(
            nativeTextTokens(
              splitPdfNumericRuns(content, operators, {
                viewport: nativeViewport,
                rules: rules.map((rule) => rule.map((v) => v / 1.5)),
                provenFrames: [...scientificGutters, frame]
              }),
              viewport,
              pageGeometry.renderRotation
            ),
            originalPages.get(pageNumber),
            pageGeometry,
            1.5
          )
          if (recoverNativeScientificLeafRecordGrid(table, revised, pageCaptions, rules, proof)) {
            tokens = revised
            scientificGutters.push(frame)
          }
        }
      }
      const statisticGutters = provePairedStatisticGutters(tokens, rules)
      if (statisticGutters.length) {
        tokens = excludeRemovedMarginTokens(
          nativeTextTokens(
            splitPdfNumericRuns(content, operators, {
              viewport: nativeViewport,
              rules: rules.map((rule) => rule.map((v) => v / 1.5)),
              provenFrames: [
                ...scientificGutters,
                ...statisticGutters.map((frame) => ({
                  ...frame,
                  rect: frame.rect.map((v) => v / 1.5),
                  cuts: frame.cuts.map((v) => v / 1.5),
                  gutterBands: frame.gutterBands.map((b) => b.map((v) => v / 1.5))
                }))
              ]
            }),
            viewport,
            pageGeometry.renderRotation
          ),
          originalPages.get(pageNumber),
          pageGeometry,
          1.5
        )
      }
      let descriptiveRecordBlock = proveDescriptiveRecordBlock(
        pageInference.tables,
        tokens,
        pageCaptions,
        rules
      )
      if (descriptiveRecordBlock) {
        const proof = descriptiveRecordBlock
        const revised = excludeRemovedMarginTokens(
          nativeTextTokens(
            splitPdfNumericRuns(content, operators, {
              viewport: nativeViewport,
              rules: rules.map((rule) => rule.map((v) => v / 1.5)),
              provenFrames: [
                ...scientificGutters,
                ...statisticGutters.map((frame) => ({
                  ...frame,
                  rect: frame.rect.map((v) => v / 1.5),
                  cuts: frame.cuts.map((v) => v / 1.5),
                  gutterBands: frame.gutterBands.map((b) => b.map((v) => v / 1.5))
                })),
                {
                  rect: proof.rect.map((v) => v / 1.5),
                  cuts: proof.cuts.slice(1, -1).map((v) => v / 1.5),
                  gutterBands: proof.gutterBands.map((b) => b.map((v) => v / 1.5))
                }
              ]
            }),
            viewport,
            pageGeometry.renderRotation
          ),
          originalPages.get(pageNumber),
          pageGeometry,
          1.5
        )
        const recovered = recoverDescriptiveRecordBlock(proof, revised, pageNumber)
        if (recovered) {
          tokens = revised
          proof.tables = [
            recovered,
            ...proof.sections.slice(1).map((section) =>
              pageInference.tables.find((table) => {
                const y = (table.cropRect[1] + table.cropRect[3]) / 2
                return y > section.band[0][1] && y < section.band.at(-1)[1]
              })
            )
          ]
          pageInference.tables.push(recovered)
          const caption = captions.find(
            (c) => c.page === pageNumber && c.lines === proof.caption.lines
          )
          for (const table of proof.tables.filter(Boolean))
            continuationCaptions.set(table.id, caption)
        } else descriptiveRecordBlock = undefined
      }
      const questionSections = recoverMixedQuestionSections(
        pageInference.tables,
        tokens,
        pageCaptions,
        rules,
        pageNumber
      )
      if (questionSections) {
        pageInference.tables = [
          ...pageInference.tables.filter((t) => !questionSections.replaced.includes(t)),
          ...questionSections.tables
        ]
        continuationCaptions.set(questionSections.tables[1].id, undefined)
      }
      pageInference.tables = pageInference.tables.flatMap((table) =>
        splitCaptionedTableRegions(table, pageCaptions, rules)
      )
      const recoveredCaptionedTables = recoverCaptionedRuledTables(
        tokens,
        rules,
        pageCaptions,
        pageNumber,
        pageInference.tables,
        measuredRuns,
        rulePaintBounds
      )
      pageInference.tables.push(...recoveredCaptionedTables)
      for (const table of recoveredCaptionedTables) {
        if (!table.caption) continue
        // `pageCaptions` uses the source viewport (scale 1.5), while the
        // serialized caption contract is scale-1. Recoveries carry the
        // internal caption for geometry; map back to the canonical object
        // before it reaches the continuation association and output.
        const canonical = captions.find(
          (caption) =>
            caption.page === pageNumber &&
            caption.lines?.join('\n') === table.caption.lines?.join('\n')
        )
        continuationCaptions.set(table.id, canonical ?? table.caption)
      }
      const nativeClosedFrames = pageCaptions
        .flatMap((caption) => findCaptionedNativeClosedTableFrames(caption, tokens, rules))
        .filter(
          (frame, index, frames) =>
            frames.findIndex((other) =>
              frame.cropRect.every((v, axis) => Math.abs(v - other.cropRect[axis]) < 0.05)
            ) === index
        )
      const coversClosedFrame = (rect, frame) => {
        const overlap =
          Math.max(0, Math.min(rect[2], frame[2]) - Math.max(rect[0], frame[0])) *
          Math.max(0, Math.min(rect[3], frame[3]) - Math.max(rect[1], frame[1]))
        return overlap >= (frame[2] - frame[0]) * (frame[3] - frame[1]) * 0.98
      }
      // An explicit caption, one native header divider and a continuous stub
      // fence can prove a compact scalar inventory that the detector missed.
      // Seed only that complete source plan; an open rectangle alone is never
      // sufficient table evidence, and existing covered candidates keep priority.
      const partialRuleTables = pageCaptions
        .map((caption) => findCaptionedNativePartialRuleTable(caption, tokens, rules, measuredRuns))
        .filter(Boolean)
      for (const [index, plan] of partialRuleTables.entries()) {
        if (pageInference.tables.some((table) => coversClosedFrame(table.cropRect, plan.cropRect)))
          continue
        const crop = plan.cropRect,
          seed = {
            id: `p${pageNumber}-native-partial-rule-table-${index + 1}`,
            pageNumber,
            cropRect: crop,
            structure: {
              objects: [
                ...plan.columns.map((column) => ({
                  label: 'table column',
                  rect: [column[0] - crop[0], 0, column[2] - crop[0], crop[3] - crop[1]]
                })),
                ...plan.groups.map((group) => ({
                  label: 'table row',
                  rect: [
                    0,
                    Math.min(...group.map((i) => i.rect[1])) - crop[1],
                    crop[2] - crop[0],
                    Math.max(...group.map((i) => i.rect[3])) - crop[1]
                  ]
                }))
              ]
            }
          }
        pageInference.tables.push(seed)
        continuationCaptions.set(
          seed.id,
          captions.find(
            (caption) => caption.page === pageNumber && caption.lines === plan.caption.lines
          )
        )
      }
      for (const [index, frame] of nativeClosedFrames.entries()) {
        if (pageInference.tables.some((table) => coversClosedFrame(table.cropRect, frame.cropRect)))
          continue
        const seed = seedNativeClosedRecordTable(frame, tokens, rules, pageNumber)
        if (!seed) continue
        seed.id += `-${index + 1}`
        pageInference.tables.push(seed)
        // An independently proved panel may have no unique caption. Retain
        // that literal absence through the existing association override.
        continuationCaptions.set(
          seed.id,
          frame.caption &&
            captions.find(
              (caption) => caption.page === pageNumber && caption.lines === frame.caption.lines
            )
        )
      }
      const meanDeviationRecords = recoverNativeMeanDeviationRecords(
        pageInference.tables,
        tokens,
        pageCaptions,
        rules
      )
      if (meanDeviationRecords) {
        pageInference.tables = pageInference.tables.map(
          (table) =>
            meanDeviationRecords.replacements.find((replacement) => replacement.original === table)
              ?.table ?? table
        )
        for (const { table, caption } of meanDeviationRecords.replacements)
          continuationCaptions.set(
            table.id,
            captions.find((c) => c.page === pageNumber && c.lines === caption.lines)
          )
      }
      const repeatedRecordBlocks = recoverRepeatedRecordBlocks(
        pageInference.tables,
        tokens,
        pageCaptions,
        rules,
        pageNumber
      )
      if (repeatedRecordBlocks) {
        pageInference.tables = [
          ...pageInference.tables.filter((table) => !repeatedRecordBlocks.replaced.includes(table)),
          ...repeatedRecordBlocks.tables
        ]
        for (const table of repeatedRecordBlocks.tables)
          continuationCaptions.set(
            table.id,
            captions.find(
              (c) => c.page === pageNumber && c.lines === repeatedRecordBlocks.caption.lines
            )
          )
      }
      const continuation = recoverPriorCohortContinuation(
        tokens,
        rules,
        pageNumber,
        geometry.pages.find((p) => p.pageNumber === pageNumber - 1),
        captions,
        pageInference.tables
      )
      if (continuation) {
        pageInference.tables.push(continuation.table)
        continuationCaptions.set(continuation.table.id, continuation.caption)
      }
      const previousGeometry = geometry.pages.find((p) => p.pageNumber === pageNumber - 1)
      const definitionTailFrame = findClosedDefinitionTailFrame(tokens, rules, viewport.height)
      if (
        previousGeometry &&
        (definitionTailFrame ||
          (!pageCaptions.some((c) => captionKind(c.lines[0]) === 'table') &&
            pageInference.tables.some((table) =>
              [3, 7].includes(
                table.structure.objects.filter((o) => o.label === 'table column').length
              )
            )))
      ) {
        const previousNativePage = await document.getPage(pageNumber - 1)
        const previousOperators = await previousNativePage.getOperatorList()
        const previousViewport = previousNativePage.getViewport({
          scale: 1.5,
          rotation: previousGeometry.renderRotation
        })
        const previousRules = collectTableRules(previousOperators, previousViewport)
        const previousTokens = excludeRemovedMarginTokens(
          nativeTextTokens(
            splitPdfNumericRuns(
              await repairPdfSymbolText(
                previousNativePage,
                await previousNativePage.getTextContent()
              ),
              previousOperators,
              {
                viewport: previousNativePage.getViewport({
                  scale: 1,
                  rotation: previousGeometry.renderRotation
                }),
                rules: previousRules.map((rule) => rule.map((v) => v / 1.5))
              }
            ),
            previousViewport,
            previousGeometry.renderRotation
          ),
          originalPages.get(pageNumber - 1),
          previousGeometry,
          1.5
        )
        if (
          definitionTailFrame &&
          !pageInference.tables.some((table) => {
            const r = definitionTailFrame.rect,
              c = table.cropRect
            return c[0] < r[2] && c[2] > r[0] && c[1] < r[3] && c[3] > r[1]
          })
        ) {
          const tail = recoverClosedDefinitionTail(
            definitionTailFrame,
            previousTokens,
            previousRules,
            pageNumber,
            previousViewport.height
          )
          if (tail) {
            pageInference.tables.push(tail)
            nativeDefinitionTails.add(tail.id)
            continuationCaptions.set(tail.id, undefined)
          }
        }
        for (const table of pageInference.tables) {
          const caption =
            recoverNativeQuestionContinuationCaption(
              table,
              tokens,
              rules,
              pageNumber,
              previousTokens,
              previousRules,
              captions
            ) ??
            recoverNativeCountContinuationCaption(
              table,
              tokens,
              rules,
              pageNumber,
              previousGeometry,
              captions,
              previousRules
            )
          if (caption) continuationCaptions.set(table.id, caption)
        }
        previousNativePage.cleanup()
      }
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
      const statisticalSections = recoverAdjacentStatisticalSections(
        pageInference.tables,
        tokens,
        pageCaptions,
        rules,
        pageNumber
      )
      if (statisticalSections) {
        pageInference.tables = [
          ...pageInference.tables.filter((t) => !statisticalSections.replaced.includes(t)),
          ...statisticalSections.tables
        ]
        continuationCaptions.set(
          statisticalSections.tables[0].id,
          captions.find(
            (caption) =>
              caption.page === statisticalSections.caption.page &&
              caption.lines === statisticalSections.caption.lines
          )
        )
        continuationCaptions.set(statisticalSections.tables[1].id, undefined)
      }
      pageInference.tables = pageInference.tables.flatMap((table) =>
        splitRuledComparisonSections(table, tokens, pageCaptions, rules)
      )
      pageInference.tables = deduplicateTableRegions(pageInference.tables, tokens, pageCaptions)
      const adjacentNativeContexts = new Map()
      const pairedTextContexts = new Map()
      for (const raw of pageInference.tables) {
        const direction = getNativePairedTextContextDirection(
          raw,
          tokens,
          pageCaptions,
          rules,
          viewport.height
        )
        if (direction !== -1 && direction !== 1) continue
        const adjacentNumber = pageNumber + direction
        const adjacentGeometry = geometry.pages.find((p) => p.pageNumber === adjacentNumber)
        if (!adjacentGeometry) continue
        if (!adjacentNativeContexts.has(adjacentNumber)) {
          let adjacentPage
          let context
          try {
            adjacentPage = await document.getPage(adjacentNumber)
            const adjacentOperators = await adjacentPage.getOperatorList()
            const adjacentViewport = adjacentPage.getViewport({
              scale: 1.5,
              rotation: adjacentGeometry.renderRotation
            })
            const adjacentNativeViewport = adjacentPage.getViewport({
              scale: 1,
              rotation: adjacentGeometry.renderRotation
            })
            const adjacentRules = collectTableRules(adjacentOperators, adjacentViewport)
            const adjacentContent = splitPdfNumericRuns(
              excludePdfLineNumbers(
                await repairPdfSymbolText(
                  adjacentPage,
                  await adjacentPage.getTextContent(),
                  adjacentOperators
                ),
                adjacentNativeViewport,
                {
                  captions: captions.filter((c) => c.page === adjacentNumber),
                  rules: collectTableRules(adjacentOperators, adjacentNativeViewport)
                }
              ),
              adjacentOperators,
              {
                viewport: adjacentNativeViewport,
                rules: collectTableRules(adjacentOperators, adjacentNativeViewport)
              }
            )
            context = {
              pageNumber: adjacentNumber,
              tokens: excludeRemovedMarginTokens(
                nativeTextTokens(
                  adjacentContent,
                  adjacentViewport,
                  adjacentGeometry.renderRotation
                ),
                originalPages.get(adjacentNumber),
                adjacentGeometry,
                1.5
              ),
              rules: adjacentRules,
              captions: captions
                .filter((c) => c.page === adjacentNumber)
                .map((c) => ({ ...c, rect: c.rect.map((v) => v * 1.5) })),
              height: adjacentViewport.height,
              currentHeight: viewport.height
            }
          } catch (error) {
            // Neighbor evidence is optional; a failed auxiliary read cannot
            // replace the existing current-page result or publish another page.
            console.warn(
              JSON.stringify({
                phase: 'native-paired-table-context',
                page: adjacentNumber,
                error: String(error)
              })
            )
          } finally {
            adjacentPage?.cleanup()
          }
          adjacentNativeContexts.set(adjacentNumber, context)
        }
        const context = adjacentNativeContexts.get(adjacentNumber)
        if (context) {
          pairedTextContexts.set(raw.id, context)
          const provedCaption = recoverNativePairedTextCaption(
            raw,
            tokens,
            pageCaptions,
            rules,
            context
          )
          const originalCaption =
            provedCaption &&
            captions.find((c) => c.page === provedCaption.page && c.lines === provedCaption.lines)
          if (originalCaption) continuationCaptions.set(raw.id, originalCaption)
        }
      }
      const nativeFigureTokens = sourceFigureTokens.map((token) => ({
        ...token,
        rect: token.rect.map((value) => value / 1.5),
        baseline: token.baseline / 1.5,
        height: token.height / 1.5
      }))
      const refined = pageInference.tables.map((raw) =>
        refineTable(
          raw,
          tokens,
          pageCaptions,
          [],
          rules,
          measuredRuns,
          pairedTextContexts.get(raw.id),
          rulePaintBounds
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
        captions,
        rules.map((rect) => rect.map((v) => v / 1.5)),
        geometry.pages
      ).map((association, index) => {
        let owned = continuationCaptions.has(refined[index].id)
          ? { caption: continuationCaptions.get(refined[index].id) }
          : association
        const priorTitle = recoverPriorPageTableCaption(
          refined[index],
          tokens,
          rules,
          pageGeometry,
          geometry.pages,
          captions,
          owned.caption
        )
        if (priorTitle) owned = { ...owned, caption: priorTitle }
        const enclosed = recoverEnclosedTableDescriptionCaption(
          refined[index],
          tokens,
          rules,
          owned.caption
        )
        if (enclosed) owned = { ...owned, caption: enclosed }
        const centered =
          !owned.caption &&
          recoverNativeCenteredTableCaption(
            refined[index],
            tokens,
            rules,
            pageGeometry,
            captions,
            refined
          )
        return centered ? { caption: centered } : owned
      })
      // A stacked page can place the next caption inside the previous
      // detector crop. When every visible table has its own consecutive
      // caption, stable vertical order is stronger evidence than nearest
      // distance and repairs that one-page ordering ambiguity.
      const stackedCaptions = captions
        .filter(
          (caption) => caption.page === pageNumber && captionKind(caption.lines?.[0]) === 'table'
        )
        .sort((a, b) => a.rect[1] - b.rect[1])
      const stackedTables = contentRects
        .map((rect, index) => ({ rect, index }))
        .sort((a, b) => a.rect[1] - b.rect[1])
      const stackedNumbers = stackedCaptions.map((caption) =>
        Number.parseInt(/^Table\s+(\d+)/i.exec(caption.lines?.[0] ?? '')?.[1] ?? '', 10)
      )
      const consecutiveStack = stackedNumbers.every(
        (number, index) =>
          Number.isFinite(number) && (!index || number === stackedNumbers[index - 1] + 1)
      )
      const captionNearStackTable = (caption, rect) => {
        const height = Math.max(1, rect[3] - rect[1])
        const captionHeight = Math.max(1, caption.rect[3] - caption.rect[1])
        const above = rect[1] - caption.rect[3]
        const below = caption.rect[1] - rect[3]
        return (
          (above >= -captionHeight * 0.25 && above <= Math.max(48, height * 0.35)) ||
          (below >= -captionHeight * 0.25 && below <= Math.max(48, height * 0.35))
        )
      }
      const stackColumnAligned = stackedTables.every(({ rect }, index) => {
        if (!index) return true
        const previous = stackedTables[index - 1].rect
        const overlap = Math.min(previous[2], rect[2]) - Math.max(previous[0], rect[0])
        const width = Math.min(previous[2] - previous[0], rect[2] - rect[0])
        const verticalGap = rect[1] - previous[3]
        const centerDelta = Math.abs((previous[0] + previous[2]) / 2 - (rect[0] + rect[2]) / 2)
        return (
          overlap >= width * 0.5 &&
          centerDelta <= Math.max(24, width * 0.2) &&
          verticalGap >= -8 &&
          verticalGap <= Math.max(160, width * 0.5)
        )
      })
      const uniqueStackCaptionOwners = stackedCaptions.every((caption) => {
        const owners = stackedTables.filter(({ rect }) => {
          const overlap = Math.min(caption.rect[2], rect[2]) - Math.max(caption.rect[0], rect[0])
          const width = Math.min(caption.rect[2] - caption.rect[0], rect[2] - rect[0])
          return overlap >= width * 0.5 && captionNearStackTable(caption, rect)
        })
        return owners.length === 1
      })
      if (
        stackedCaptions.length === stackedTables.length &&
        stackedCaptions.length >= 2 &&
        consecutiveStack &&
        stackColumnAligned &&
        uniqueStackCaptionOwners &&
        stackedTables.every(({ rect }, index) => {
          const caption = stackedCaptions[index].rect
          return (
            Math.min(caption[2], rect[2]) - Math.max(caption[0], rect[0]) >=
            Math.min(caption[2] - caption[0], rect[2] - rect[0]) * 0.5
          )
        })
      )
        for (const [index, { index: tableIndex }] of stackedTables.entries())
          associations[tableIndex].caption = stackedCaptions[index]
      // A lower stacked table can begin immediately after its descriptive
      // caption while a neighboring detector box still owns the preceding
      // table. Recover only a unique, tight above-table caption; this avoids
      // letting a distant title jump across columns or table bodies.
      for (const [index, association] of associations.entries()) {
        if (association.caption) continue
        const rect = contentRects[index]
        const candidates = captions.filter((caption) => {
          const overlap = Math.min(caption.rect[2], rect[2]) - Math.max(caption.rect[0], rect[0])
          return (
            caption.page === pageNumber &&
            captionKind(caption.lines[0]) === 'table' &&
            ((caption.rect[3] <= rect[1] && rect[1] - caption.rect[3] <= 20) ||
              (caption.rect[1] >= rect[1] - 20 && caption.rect[1] <= rect[1] + 40)) &&
            overlap / Math.min(caption.rect[2] - caption.rect[0], rect[2] - rect[0]) >= 0.5
          )
        })
        if (
          candidates.length === 1 &&
          !associations.some(
            (other, otherIndex) => otherIndex !== index && other.caption === candidates[0]
          )
        )
          association.caption = candidates[0]
      }
      const notes = associateTableNotes(
        pageGeometry,
        contentRects.map((rect, index) => ({
          rect: tableNoteOwnershipRect(refined[index], rect, 1.5, tokens, measuredRuns)
        })),
        rules.map((rect) => rect.map((v) => v / 1.5))
      ).map((assigned, index) => (nativeDefinitionTails.has(refined[index].id) ? [] : assigned))
      const repeatedFooter = recoverRepeatedRecordFooterNotes(
        pageGeometry,
        repeatedRecordBlocks,
        rules.map((rect) => rect.map((v) => v / 1.5))
      )
      if (repeatedFooter) {
        const owners = repeatedRecordBlocks.tables.map((table) =>
          refined.findIndex((candidate) => candidate.id === table.id)
        )
        if (owners.every((index) => index >= 0) && owners.every((index) => !notes[index].length))
          notes[owners[0]] = repeatedFooter
      }
      for (const [index, tableNotes] of notes.entries()) {
        if (!tableNotes.length) continue
        const scaledNotes = tableNotes.map((note) => ({
          ...note,
          rect: note.rect.map((v) => v * 1.5)
        }))
        const noteCrop =
          recoverRuledDoseNoteCrop(refined[index], scaledNotes, rules) ??
          recoverRuledDefinitionNoteCrop(refined[index], scaledNotes, rules)
        refined[index] = refineTable(
          noteCrop
            ? rebaseTableCrop(pageInference.tables[index], noteCrop)
            : pageInference.tables[index],
          tokens,
          pageCaptions,
          scaledNotes,
          rules,
          measuredRuns,
          pairedTextContexts.get(refined[index].id),
          rulePaintBounds
        )
      }
      // Cell row extents omit border rules; the full detected crop owns those rules too.
      const legendPage =
        pageNumber >= firstLegend &&
        pageNumber <= Math.max(...[...separatedFigures.values()].map((c) => c.endPage ?? c.page))
      // A confirmed separated legend section includes short continuation pages
      // where line numbers alone can look like a two-column table.
      const adjacentFigures = associateAdjacentFigure(
        pageGeometry,
        geometry.pages,
        captions,
        rules.map((r) => r.map((v) => v / 1.5)),
        closedFrames
      )
      const captionedFigureRegions = [
        ...adjacentFigures,
        ...associateFigures(
          pageGeometry,
          captions,
          [],
          rules.map((r) => r.map((v) => v / 1.5)),
          closedFrames,
          nativeFigureTokens,
          { operators, viewport: nativeViewport }
        )
      ].filter((f) => f.rect)
      // A side-by-side detector can attach a caption to a narrow crop that
      // contains only the first body row and a numeric stub from its neighbor.
      // Prefer the overlapping complete grid as the caption owner. This is a
      // geometry/content transfer only; it does not alter the table schema or
      // create a second record.
      for (let outerIndex = 0; outerIndex < refined.length; outerIndex++) {
        const outerAssociation = associations[outerIndex]
        const outer = refined[outerIndex]
        if (!outerAssociation?.caption || !outer?.cropRect) continue
        if (!(outer.issues ?? []).includes('text-crosses-crop-boundary')) continue
        if ((outer.unassigned?.length ?? 0) < 3) continue
        const outerRows = outer.grid?.length ?? 0
        const outerColumns = Math.max(0, ...(outer.grid ?? []).map((row) => row.length))
        for (let innerIndex = 0; innerIndex < refined.length; innerIndex++) {
          if (innerIndex === outerIndex || associations[innerIndex]?.caption) continue
          const inner = refined[innerIndex]
          if (!inner?.cropRect || (inner.unassigned?.length ?? 0) > 0) continue
          const innerRows = inner.grid?.length ?? 0
          const innerColumns = Math.max(0, ...(inner.grid ?? []).map((row) => row.length))
          if (innerRows < Math.max(3, outerRows + 1) || innerColumns !== outerColumns - 1) continue
          const horizontal =
            Math.max(
              0,
              Math.min(outer.cropRect[2], inner.cropRect[2]) -
                Math.max(outer.cropRect[0], inner.cropRect[0])
            ) /
            Math.max(
              1,
              Math.min(outer.cropRect[2] - outer.cropRect[0], inner.cropRect[2] - inner.cropRect[0])
            )
          const vertical =
            Math.max(
              0,
              Math.min(outer.cropRect[3], inner.cropRect[3]) -
                Math.max(outer.cropRect[1], inner.cropRect[1])
            ) /
            Math.max(
              1,
              Math.min(outer.cropRect[3] - outer.cropRect[1], inner.cropRect[3] - inner.cropRect[1])
            )
          if (horizontal < 0.5 || vertical < 0.8) continue
          associations[innerIndex] = { caption: outerAssociation.caption }
          associations[outerIndex] = { reason: 'caption-forwarded-to-complete-overlap' }
          break
        }
      }
      const captionedTableIndices = new Set(
        associations.flatMap((association, index) => (association.caption ? [index] : []))
      )
      for (const [index, table] of refined.entries()) {
        const crop = table?.cropRect
        if (!crop) continue
        const hasNearbyCaption = pageCaptions.some((caption) => {
          if (captionKind(caption.lines?.[0]) !== 'table' || !caption.rect) return false
          const overlap = Math.min(caption.rect[2], crop[2]) - Math.max(caption.rect[0], crop[0])
          const width = Math.min(caption.rect[2] - caption.rect[0], crop[2] - crop[0])
          if (overlap / Math.max(1, width) < 0.5) return false
          const aboveGap = crop[1] - caption.rect[3]
          return (
            (aboveGap >= -2 && aboveGap <= 36) ||
            (caption.rect[1] >= crop[1] && caption.rect[3] <= crop[3])
          )
        })
        if (hasNearbyCaption) captionedTableIndices.add(index)
      }
      const narrativeDuplicates = narrativeDuplicateTableIndices(refined, {
        captionedIndices: captionedTableIndices,
        rules
      })
      const nativeSourceDuplicates = nativeSourceDuplicateTableIndices(
        refined,
        associations,
        tokens,
        rules
      )
      const nativeEvidenceGraphics = pageGeometry.graphicsBounds.map((graphic) => ({
        kind: graphic.kind,
        rect: graphic.normalizedRect.map(
          (value, axis) => value * (axis % 2 ? pageGeometry.height : pageGeometry.width) * 1.5
        )
      }))
      const hasSourceTableEvidence = (table, index) =>
        nativeDefinitionTails.has(table.id) ||
        hasTableEvidence(table, associations[index].caption, tokens, rules, nativeEvidenceGraphics)
      // A fully framed native notation table can have an unreliable formula
      // grid. Keep its proved image using the existing graphical-table result
      // instead of publishing guessed mathematical cell assignments.
      const nativeNotationFrames = pageInference.tables.flatMap((raw, index) => {
        const matches = pageCaptions.flatMap((caption) => {
          const proof =
            proveCaptionedNativeDefinitionFrame(raw, caption, tokens, rules) ??
            proveCaptionedNativeClosedTableFrame(raw, caption, tokens, rules)
          return proof &&
            [
              'native-notation-visual',
              'native-closed-table-visual',
              'native-boxed-table-visual'
            ].includes(proof.kind)
            ? [
                {
                  index,
                  rect: [
                    Math.max(0, (proof.cropRect[0] - 2) / 1.5),
                    Math.max(0, (proof.cropRect[1] - 2) / 1.5),
                    Math.min(pageGeometry.width, (proof.cropRect[2] + 2) / 1.5),
                    Math.min(pageGeometry.height, (proof.cropRect[3] + 2) / 1.5)
                  ],
                  caption: {
                    ...caption,
                    rect: caption.rect.map((v) => v / 1.5)
                  }
                }
              ]
            : []
        })
        return matches.length === 1 && !hasSourceTableEvidence(refined[index], index) ? matches : []
      })
      const nativeNotationIndices = new Set(nativeNotationFrames.map((f) => f.index))
      const acceptedTables = refined.map(
        (table, index) =>
          !nativeNotationIndices.has(index) &&
          !narrativeDuplicates.has(index) &&
          !nativeSourceDuplicates.has(index) &&
          // A recognized, explicitly numbered procedure already owns its
          // native source. A detector grid cannot publish those instructions
          // a second time as table cells merely because they align in rows.
          !isRecognizedAlgorithmOwnedTable(table, associations[index].caption, pageAlgorithms) &&
          !isFigureOwnedPartialTable(table, captionedFigureRegions) &&
          !isExternalAttachmentTableRegion(table, tokens, rules, associations[index].caption) &&
          !isNativeAuthorAffiliationRegion(
            table,
            tokens,
            pageNumber,
            associations[index].caption,
            rules
          ) &&
          !isNativeFrontMatterRegion(
            table,
            tokens,
            pageNumber,
            associations[index].caption,
            rules
          ) &&
          // Repeated native name/institution/email lanes and an independent
          // larger Abstract heading prove a first-page contact panel even
          // when the institution names are opaque abbreviations.
          !isNativeRepeatedAuthorContactPanel(
            table,
            tokens,
            pageNumber,
            associations[index].caption,
            rules
          ) &&
          (!legendPage || Boolean(associations[index].caption)) &&
          (Boolean(associations[index].caption) ||
            !isFigureRiskTable(table, captionedFigureRegions, pageGeometry)) &&
          (Boolean(associations[index].caption) ||
            !captionedFigureRegions.some((f) => {
              const r = table.cropRect.map((v) => v / 1.5)
              return (
                (f.ownsContainedTables ||
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
                  })) &&
                r[0] >= f.rect[0] - 12 &&
                r[2] <= f.rect[2] + 12 &&
                r[1] >= f.rect[1] - 12 &&
                r[3] <= f.rect[3] + 12
              )
            })) &&
          hasSourceTableEvidence(table, index)
      )
      const recognizedTableRects = refined
        .filter((_, index) => acceptedTables[index])
        .map((table) => table.cropRect.map((v) => v / 1.5))
      const graphicalTables = associateGraphicalTables(
        pageGeometry,
        captions,
        recognizedTableRects,
        refined
          .filter((t) => !t.grid.flat().some((s) => s.trim()))
          .map((t) => t.cropRect.map((v) => v / 1.5))
      )
      for (const frame of nativeNotationFrames) {
        const sameCaption = (caption) =>
          caption?.page === frame.caption.page &&
          caption?.lines?.[0] === frame.caption.lines[0] &&
          Math.abs(caption.rect[1] - frame.caption.rect[1]) < 0.1
        for (let index = graphicalTables.length - 1; index >= 0; index--)
          if (sameCaption(graphicalTables[index].caption)) graphicalTables.splice(index, 1)
        if (!graphicalTables.some((table) => sameCaption(table.caption)))
          graphicalTables.push({ rect: frame.rect, caption: frame.caption })
      }
      // Complete source fences preserve omitted native visuals even when
      // no reliable cell grid exists. Already emitted grids and images keep
      // ownership; captionless boxed parts gain no inferred parent relation.
      for (const frame of nativeClosedFrames) {
        if (
          refined.some(
            (table, index) => acceptedTables[index] && isNativeClosedFrameOwnedByTable(table, frame)
          ) ||
          [...recognizedTableRects, ...graphicalTables.map((table) => table.rect)].some((rect) =>
            coversClosedFrame(
              rect.map((v) => v * 1.5),
              frame.cropRect
            )
          )
        )
          continue
        graphicalTables.push({
          rect: [
            Math.max(0, (frame.cropRect[0] - 2) / 1.5),
            Math.max(0, (frame.cropRect[1] - 2) / 1.5),
            Math.min(pageGeometry.width, (frame.cropRect[2] + 2) / 1.5),
            Math.min(pageGeometry.height, (frame.cropRect[3] + 2) / 1.5)
          ],
          caption: frame.caption && {
            ...frame.caption,
            rect: frame.caption.rect.map((v) => v / 1.5)
          }
        })
      }
      // A noisy caption can produce both a graphical-table fallback and a
      // detector fragment for the same source region. Keep the source-backed
      // candidate when their captions agree and their regions materially
      // overlap; an outlined table without a detector region is unaffected.
      const captionKey = (caption) =>
        String(caption?.text ?? caption?.lines?.join(' ') ?? '')
          .toLowerCase()
          .replace(/\s+/g, ' ')
          .trim()
      for (let index = graphicalTables.length - 1; index >= 0; index--) {
        const graphical = graphicalTables[index]
        const key = captionKey(graphical.caption)
        if (!key) continue
        const duplicate = refined.some((table, refinedIndex) => {
          if (!acceptedTables[refinedIndex] || !captionKey(associations[refinedIndex].caption))
            return false
          if (captionKey(associations[refinedIndex].caption) !== key || !table.cropRect)
            return false
          const rect = table.cropRect.map((value) => value / 1.5)
          const horizontalOverlap =
            Math.max(
              0,
              Math.min(rect[2], graphical.rect[2]) - Math.max(rect[0], graphical.rect[0])
            ) / Math.max(1, Math.min(rect[2] - rect[0], graphical.rect[2] - graphical.rect[0]))
          return horizontalOverlap > 0.5 && table.grid?.flat().some((text) => text.trim())
        })
        if (duplicate) graphicalTables.splice(index, 1)
      }
      // Complete native matrix panels prove the table image even when their
      // overprinted headers cannot prove a cell grid. Preserve that existing
      // image-only table surface, with its explicit no-source-cell-grid issue.
      const nativeMatrix = nativeRepeatedMatrixCandidate(
        nativeFigureTokens,
        rules.map((rect) => rect.map((v) => v / 1.5)),
        captions.filter((caption) => caption.page === pageNumber),
        pageGeometry.width,
        pageGeometry.height
      )
      if (
        nativeMatrix &&
        ![...recognizedTableRects, ...graphicalTables.map((table) => table.rect)].some(
          (rect) =>
            rect[0] < nativeMatrix.rect[2] &&
            rect[2] > nativeMatrix.rect[0] &&
            rect[1] < nativeMatrix.rect[3] &&
            rect[3] > nativeMatrix.rect[1]
        )
      )
        graphicalTables.push(nativeMatrix)
      graphicalTables.push(
        ...associateRasterTables(
          pageGeometry,
          pageInference.tables.filter(
            (_, index) => !refined[index].grid.flat().some((text) => text.trim())
          ),
          [
            ...recognizedTableRects,
            ...captionedFigureRegions.map((f) => f.rect),
            ...graphicalTables.map((t) => t.rect)
          ]
        )
      )
      for (const [index, table] of graphicalTables.entries()) {
        const id = `p${pageNumber}-graphical-table-${index + 1}`
        recognizedTableRects.push(table.rect)
        const matrix = table === nativeMatrix && recoverNativeRepeatedMatrixParts(table, 1.5)
        tables.push({
          id,
          page: pageNumber,
          caption: captionValue(table.caption),
          ...(matrix
            ? {
                parts: matrix.parts.map((part) => ({
                  ...part,
                  sourceViewport: { width: viewport.width, height: viewport.height, scale: 1.5 }
                }))
              }
            : {
                sourceViewport: { width: viewport.width, height: viewport.height, scale: 1.5 },
                grid: [],
                cells: [],
                unassigned: [],
                issues: ['no-source-cell-grid']
              }),
          region: normalize(table.rect, pageGeometry.width, pageGeometry.height),
          thumbnail: await crop(table.rect, id)
        })
      }
      const localFigures = associateFigures(
        pageGeometry,
        captions,
        [
          ...recognizedTableRects,
          ...notes.flatMap((items, index) =>
            acceptedTables[index] ? items.map((n) => n.rect) : []
          ),
          ...pageAlgorithms.map((a) => a.rect)
        ],
        rules.map((r) => r.map((v) => v / 1.5)),
        closedFrames,
        nativeFigureTokens,
        { operators, viewport: nativeViewport }
      )
      let pageFigures =
        localFigures.length || recognizedTableRects.length
          ? localFigures
          : associateAdjacentFigure(
              pageGeometry,
              geometry.pages,
              captions,
              rules.map((r) => r.map((v) => v / 1.5)),
              closedFrames
            )
      if (!legendPage)
        pageFigures.push(
          ...associatePreviousPageRasterFigure(
            pageGeometry,
            geometry.pages,
            captions,
            [
              ...recognizedTableRects,
              ...notes.flatMap((items, index) =>
                acceptedTables[index] ? items.map((n) => n.rect) : []
              ),
              ...pageAlgorithms.map((a) => a.rect)
            ],
            pageFigures
          )
        )
      if (!pageFigures.length && !recognizedTableRects.length && !legendPage)
        pageFigures = await recoverScannedFigures(page, pageGeometry)
      if (legendPage) pageFigures = []
      if (!legendPage && !pageFigures.length && !recognizedTableRects.length)
        pageFigures = associateUncaptionedRasterFigure(pageGeometry, captions, recognizedTableRects)
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
      // A numbered vector plate can supply native evidence without a raster.
      // Its bounds alone may omit axis text; use the common plate union below.
      const plateNumber = /^(?:Figure|Fig\.)\s*(\d+)\b/i.exec(plateCaption?.lines[0] ?? '')?.[1]
      const numberedPlate =
        plateNumber &&
        pageFigures.length === 1 &&
        pageFigures[0].rect &&
        /^(?:Figure|Fig\.)\s*(\d+)\.?$/i.exec(
          pageFigures[0].caption?.lines.join(' ') ?? ''
        )?.[1] === plateNumber
      const nativePlate =
        plateCaption &&
        pageGeometry.graphicsBounds.filter(
          (g) =>
            g.kind === 'path' &&
            (g.normalizedRect[2] - g.normalizedRect[0]) * pageGeometry.width > 10 &&
            (g.normalizedRect[3] - g.normalizedRect[1]) * pageGeometry.height > 10
        ).length >= 3
      if (plateCaption && (plateImages.length || numberedPlate || nativePlate)) {
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
              !/^(?:Figure|Fig\.)\s*\d+[A-Z]?\.?$/i.test(l.text.trim()) &&
              !(/^\d+$/.test(l.text.trim()) && l.y > pageGeometry.height * 0.9) &&
              l.y + l.height > 0 &&
              l.y + l.height <= Math.min(footerTop, pageGeometry.height)
          )
          .map((l) => [l.x, l.y, l.x + l.width, l.y + l.height])
        const parts = [
          ...plateBounds,
          ...plateLabels,
          ...(numberedPlate ? [pageFigures[0].rect] : [])
        ]
        const plateRect = rasterPlateRect(pageGeometry) ?? [
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
      if (
        plateCaption &&
        pageFigures.some((candidate) => candidate.caption === plateCaption) &&
        !geometry.pages.some((p) => p.pageNumber === plateCaption.page)
      ) {
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
      for (const [index, candidate] of pageFigures.entries()) {
        const id = `p${pageNumber}-figure-${index + 1}`
        const resolvedCaption = resolveFigureCaption(candidate.caption, captions, geometry.pages)
        const serializedCaption = candidate.captionLines
          ? {
              ...(resolvedCaption ?? candidate.caption),
              lines: candidate.captionLines,
              rect: candidate.captionRect ?? candidate.caption?.rect
            }
          : resolvedCaption
        const captionRect = serializedCaption?.rect ?? candidate.caption?.rect
        // Advance boxes can miss glyph ink at an edge. Match the earlier diagnostic's 2px guard,
        // bounded by the page and the caption; publish the same expanded region used by the crop.
        const rect = candidate.rect && [
          Math.max(0, candidate.rect[0] - 2 / scale),
          Math.max(
            0,
            candidate.rect[1] - 2 / scale,
            nativeProseInkTopLimit(candidate, nativeFigureTokens),
            serializedCaption?.page === pageNumber && captionRect?.[3] <= candidate.rect[1]
              ? captionRect[3] + 0.5
              : 0
          ),
          Math.min(pageGeometry.width, candidate.rect[2] + 2 / scale),
          Math.min(
            pageGeometry.height,
            serializedCaption?.page === pageNumber && captionRect?.[1] >= candidate.rect[3]
              ? captionRect[1] - 0.5
              : pageGeometry.height,
            Math.max(
              candidate.rect[3] + 2 / scale,
              nativeOwnedFigureInkBottom(candidate, nativeFigureTokens)
            )
          )
        ]
        figures.push({
          id,
          page: pageNumber,
          caption: captionValue(serializedCaption),
          region: rect ? normalize(rect, pageGeometry.width, pageGeometry.height) : undefined,
          thumbnail: rect ? await crop(rect, id) : undefined,
          issue: candidate.issue ?? candidate.reason,
          graphicsCount: candidate.graphicsCount
        })
      }
      const pageTables = []
      for (const [index, refinedTable] of refined.entries()) {
        const uprightRuleCrop =
          pageInference.tables[index].readingRotation === 0 && !notes[index].length
        const table = {
          ...refinedTable,
          cropRect: recoverOwnedTableCrop(
            refinedTable,
            rules,
            [viewport.width, viewport.height],
            tokens,
            rulePaintBounds,
            uprightRuleCrop ? nativeEvidenceGraphics : [],
            uprightRuleCrop ? sourceFigureTokens : []
          )
        }
        const association = associations[index]
        const cropRect = [...table.cropRect]
        const caption = association.caption
        if (!acceptedTables[index]) continue
        const captionGlyphOwner = proveNativeCaptionRaisedGlyphOwnership(
          table,
          tokens,
          pageCaptions,
          rules
        )
        const ownedBottom = cropRect[3]
        cropRect[1] = tableMarginCropTop(
          table,
          originalPages.get(pageNumber),
          pageGeometry,
          rules,
          1.5
        )
        trimTableCaptionCrop({
          cropRect,
          table,
          caption,
          contentRect: contentRects[index],
          rules,
          pageNumber,
          scale: 1.5,
          pageItems: tokens,
          pageFontItems: sourceFigureTokens,
          noteOwnerRects: contentRects,
          rulePaintBounds
        })
        trimTableNoteCrop({
          cropRect,
          table,
          notes: notes[index],
          contentRect: contentRects[index],
          scale: 1.5,
          sourceRules: rules
        })
        // Caption padding cannot remove a uniquely proved native table footer.
        // Its raised caption glyphs remain outside table source ownership.
        const footerBottom = captionGlyphOwner && captionGlyphOwner.closing[1] + 0.5
        if (
          captionGlyphOwner &&
          Number.isFinite(footerBottom) &&
          footerBottom <= ownedBottom &&
          caption?.page === pageNumber &&
          captionGlyphOwner.caption.lines === caption.lines &&
          footerBottom < caption.rect[1] * 1.5
        )
          cropRect[3] = Math.max(cropRect[3], footerBottom)
        // Refinement can rebase a native grid to rule center lines. Retain
        // the measured stroke envelope only for the very same complete
        // below-caption recovery, with every original font still owned once.
        const paintedSeed = recoveredCaptionedTables.find(
          (seed) =>
            seed === pageInference.tables[index] &&
            seed.id === table.id &&
            seed.id.startsWith(`p${pageNumber}-below-caption-two-leaf-table-`)
        )
        if (
          paintedSeed &&
          caption === continuationCaptions.get(paintedSeed.id) &&
          caption?.page === pageNumber &&
          !notes[index].length &&
          !table.issues.length &&
          !table.unassigned.length
        ) {
          const rows = paintedSeed.structure.objects
              .filter((object) => object.label === 'table row')
              .map((object) => object.rect.map((v, axis) => v + paintedSeed.cropRect[axis % 2]))
              .sort((a, b) => a[1] - b[1]),
            columns = paintedSeed.structure.objects
              .filter((object) => object.label === 'table column')
              .map((object) => object.rect.map((v, axis) => v + paintedSeed.cropRect[axis % 2]))
              .sort((a, b) => a[0] - b[0]),
            source = tokens.filter(
              (item) => item.text.trim() && inside(paintedSeed.cropRect, item)
            ),
            owners = table.cells.flatMap((cell) => cell.sourceTokens ?? []),
            sameFont = (a, b) =>
              a.text === b.text &&
              a.baseline === b.baseline &&
              a.height === b.height &&
              a.rect.every((v, axis) => v === b.rect[axis]),
            complete =
              columns.length === 2 &&
              table.grid.length === rows.length &&
              table.grid.every((row) => row.length === 2) &&
              table.cells.length === rows.length * 2 &&
              new Set(table.cells.map((cell) => `${cell.row},${cell.column}`)).size ===
                table.cells.length &&
              owners.length === source.length &&
              source.every(
                (item) => owners.filter((owner) => sameFont(item, owner)).length === 1
              ) &&
              table.cells.every((cell) => {
                const row = rows[cell.row],
                  column = columns[cell.column],
                  fonts = cell.sourceTokens
                return (
                  row &&
                  column &&
                  cell.rowSpan === 1 &&
                  cell.colSpan === 1 &&
                  table.grid[cell.row][cell.column] === cell.text &&
                  fonts?.length &&
                  fonts.length === cell.sourceRects.length &&
                  fonts
                    .map((item) => item.text)
                    .join('')
                    .replace(/\s/gu, '') === cell.text.replace(/\s/gu, '') &&
                  fonts.every(
                    (item, n) =>
                      !item.sourceToken &&
                      source.filter((original) => sameFont(item, original)).length === 1 &&
                      item.rect.every((v, axis) => v === cell.sourceRects[n][axis]) &&
                      item.rect[0] >= column[0] &&
                      item.rect[2] <= column[2] &&
                      item.baseline > row[1] &&
                      item.baseline < row[3] &&
                      (item.rect[1] + item.rect[3]) / 2 > row[1] &&
                      (item.rect[1] + item.rect[3]) / 2 < row[3]
                  )
                )
              })
          if (complete) cropRect.splice(0, 4, ...paintedSeed.cropRect)
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
      // Split complete source owners after index-coupled crop and note assembly.
      const independentPageTables = pageTables.flatMap((table) => {
        const recovered = recoverNativeIndependentCaptionedTables(
          table,
          tokens,
          pageCaptions,
          rules,
          measuredRuns,
          rulePaintBounds,
          nativeEvidenceGraphics
        )
        if (!recovered) return [table]
        const canonical = recovered.map((part) => {
          const matches = captions.filter(
            (caption) =>
              caption.page === part.caption.page &&
              caption.lines.length === part.caption.lines.length &&
              caption.lines.every((line, index) => line === part.caption.lines[index]) &&
              caption.rect.every((value, axis) => value * 1.5 === part.caption.rect[axis])
          )
          return matches.length === 1 ? { ...part, caption: captionValue(matches[0]) } : undefined
        })
        return canonical.every(Boolean) ? canonical : [table]
      })
      const fencedPageTables = independentPageTables.map((table) => {
        const seeds = pageInference.tables.filter((seed) => seed.id === table.id)
        if (
          seeds.length !== 1 ||
          seeds[0].readingRotation !== 0 ||
          pageGeometry.invalidGraphicsBounds !== 0
        )
          return table
        const grouped =
          recoverNativeFencedGroupLabels(
            table,
            tokens,
            pageCaptions,
            rules,
            measuredRuns,
            rulePaintBounds,
            nativeEvidenceGraphics,
            { operators, viewport }
          ) ?? table
        const records =
          recoverNativeExistingWholeRecordRows(
            grouped,
            tokens,
            pageCaptions,
            rules,
            measuredRuns,
            rulePaintBounds,
            nativeEvidenceGraphics
          ) ?? grouped
        const blank =
          recoverNativeBlankFirstLeafOwners(
            records,
            tokens,
            pageCaptions,
            rules,
            measuredRuns,
            rulePaintBounds,
            nativeEvidenceGraphics,
            { operators, viewport }
          ) ?? records
        return (
          recoverNativeFourFieldOrdinaryRecordOwners(
            blank,
            tokens,
            pageCaptions,
            rules,
            measuredRuns,
            rulePaintBounds,
            nativeEvidenceGraphics,
            { operators, viewport }
          ) ?? blank
        )
      })
      for (let table of groupRuledComparisonSections(
        groupNativeStatisticalSections(
          groupMixedQuestionSections(
            groupDescriptiveRecordBlocks(
              groupRepeatedRecordBlocks(
                groupTableParts(fencedPageTables, pageGeometry),
                repeatedRecordBlocks
              ),
              descriptiveRecordBlock
            )
          )
        )
      )) {
        const mixedSections =
          !table.parts &&
          (recoverNativeMixedSectionParts(table, tokens, pageCaptions, rules, measuredRuns) ??
            recoverNativeIndependentPanelParts(table, tokens, pageCaptions, rules, measuredRuns) ??
            recoverNativeStackedSharedCaptionParts(
              table,
              tokens,
              pageCaptions,
              rules,
              measuredRuns,
              refined,
              { operators, content, viewport, rulePaintBounds, nativeEvidenceGraphics }
            ))
        if (mixedSections)
          table = {
            id: table.id,
            page: table.page,
            caption: table.caption,
            notes: table.notes,
            cropRect: mixedSections.cropRect,
            parts: mixedSections.parts.map((part) => ({
              title: part.title,
              grid: part.grid,
              cells: part.cells,
              unassigned: part.unassigned,
              issues: part.issues,
              notes: part.notes,
              sourceViewport: table.sourceViewport
            }))
          }
        // Rendering-only regions must not enter the persisted worker transport.
        const { cropRects, ...result } = table
        table.notes = [
          ...(table.notes ?? []),
          ...(nativeDefinitionTails.has(table.id)
            ? []
            : associateContinuedTableNotes(
                table,
                pageGeometry,
                geometry.pages.find((p) => p.pageNumber === pageNumber + 1)
              ))
        ]
        tables.push({
          ...result,
          notes: table.notes,
          region: normalize(table.cropRect, viewport.width, viewport.height),
          thumbnail: await crop(
            table.cropRect.map((v) => v / 1.5),
            table.id,
            cropRects?.map((r) => r.map((v) => v / 1.5))
          )
        })
      }
    } finally {
      page.cleanup()
    }
    console.log(JSON.stringify({ phase: 'assembled', page: pageNumber }))
  }
  figures.splice(0, figures.length, ...deduplicateFigureCaptions(figures, auxiliaryCaptionOwners))
  geometry.pages.sort((a, b) => a.pageNumber - b.pageNumber)
  // Keep the original PDF's coordinate system at the worker boundary. Analysis
  // and thumbnails are upright, while source jumps still point into the original.
  const restoreCaption = (caption) => restoreCaptionCoordinates(caption, geometry.pages)
  for (const item of [...figures, ...algorithms, ...tables]) {
    restoreCaption(item.caption)
    for (const data of [item, ...(item.parts ?? [])])
      for (const note of data.notes ?? []) {
        const source = geometry.pages.find((p) => p.pageNumber === (note.page ?? item.page))
        note.rect = originalRect(
          note.rect,
          source.width,
          source.height,
          (source.renderRotation - source.rotation + 360) % 360
        )
      }
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
      if (data.sourceViewport && rotation !== 180)
        data.sourceViewport = { ...data.sourceViewport, width: height, height: width }
    }
    restoreTable(item)
    item.parts?.forEach(restoreTable)
  }
  captions.forEach(restoreCaption)
  // Match the engine adapter's resource discovery so newly extracted private
  // helpers cannot silently disappear from standalone extraction evidence.
  const scriptNames = (await readdir(dirname(fileURLToPath(import.meta.url))))
    .filter((name) => name.endsWith('.mjs'))
    .sort()
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
  const resultGeometryPages = selectResultGeometryPages(geometry.pages, requestedPages, [
    ...figures,
    ...tables,
    ...algorithms
  ])
  // These fields describe assembly geometry, while the worker contract uses
  // grid/cells and each cell's sourceRects. Keep them in memory for repairs,
  // then omit only table-owned duplicates from the bounded result payload.
  const tableTransportData = (data) => {
    const transport = { ...data }
    delete transport.rows
    if (Array.isArray(data.cells))
      transport.cells = data.cells.map((cell) => {
        const value = { ...cell }
        delete value.rect
        delete value.origin
        return value
      })
    return transport
  }
  const result = {
    schemaVersion: 1,
    warning: 'Experimental candidates; not a production cache, copy gate, or accuracy guarantee.',
    sourceSha256: checksum,
    extractorFingerprint: fingerprint.digest('hex'),
    pageCount: document.numPages,
    requestedPages,
    processedPages: requestedPages,
    auxiliaryPages: resultGeometryPages
      .map((p) => p.pageNumber)
      .filter((p) => !requestedPages.includes(p)),
    coordinates: {
      regions: 'normalized displayed PDF.js viewport',
      captionRects: 'scale-1 displayed viewport',
      tableRects: 'sourceViewport pixels'
    },
    pages: resultGeometryPages.map((p) => ({
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
    tables: tables.map((table) =>
      table.parts
        ? { ...tableTransportData(table), parts: table.parts.map(tableTransportData) }
        : tableTransportData(table)
    )
  }
  await writeFile(join(output, 'structure.pending.json'), serializeWorkerResult(result))
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
