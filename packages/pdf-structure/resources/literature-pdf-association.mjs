/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Shared offline association; candidate geometry does not prove semantic correctness.
import assert from 'node:assert/strict'
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  connectFigureGraphics,
  enclosedFigureFrame,
  closedCaptionFigureFrame,
  closedFrameCompositeEvidence,
  topCaptionedNativeFlow,
  nativeFramedPanelArray,
  collapsedNativeAxisLeft,
  nativeClosedRuleFrames
} from './literature-pdf-figure-connectivity.mjs'
import {
  captionKind,
  findCaptionCandidates,
  nativePhotographCaption,
  nativeUnpunctuatedRasterCaption,
  groupPageLines,
  groupNativeCaptionFragments
} from './literature-pdf-caption-group.mjs'

import {
  nativeOwnedFigureLabels,
  nativeRasterRowLabels,
  nativePanelTopHeading,
  nativeOwnedFigureGlyphTails,
  nativeOwnedFigureBottomLabels,
  nativeOwnedRasterTitleRows,
  nativeOwnedRasterColumnHeadings,
  nativeOwnedFigureTopLabel,
  nativeOwnedFormPaintBounds,
  nativeFigureMarginPageNumber,
  nativeTableDividerGraphic
} from './literature-pdf-native-owned-figure-labels.mjs'
import { nativeRasterCaptionColumn } from './literature-pdf-native-raster-column.mjs'
import { nativeOpenAxisArray } from './literature-pdf-native-open-axis-array.mjs'
import { nativeCrossPageProse } from './literature-pdf-figure-cross-page-prose.mjs'
import {
  nativeCompleteAxisFigure,
  nativeCompletedAxisPanels
} from './literature-pdf-figure-complete-axis-ownership.mjs'
import {
  nativeConnectedKeyedLegend,
  nativeFiniteTopRowKeyedLegend
} from './literature-pdf-figure-connected-keyed-legend.mjs'
import {
  nativeAttachedPlotLabels,
  nativeAxisTitlePacket
} from './literature-pdf-figure-native-plot-labels.mjs'
import { completeNativePanelParagraphs } from './literature-pdf-figure-panel-paragraphs.mjs'
import { nativeNodeFigureLabels } from './literature-pdf-figure-node-labels.mjs'
import {
  nativeMatrixFigureScope,
  nativeClosedNodeSources
} from './literature-pdf-figure-native-vector-scope.mjs'
import { nativeOverlayDiagramLines } from './literature-pdf-figure-overlay-note.mjs'
import { nativeBraceFigureLabel } from './literature-pdf-figure-native-brace-label.mjs'
import { nativeMaskedPlotBounds } from './literature-pdf-figure-masked-plot.mjs'
import {
  nativeFormPlotEvidence,
  nativeFormPlotExcludedProse
} from './literature-pdf-figure-form-plot.mjs'
import {
  nativeCaptionedTextIllustration,
  nativeCaptionedVectorDiagram,
  nativeCaptionedConnectedNodes,
  nativeCaptionedVectorGrid,
  nativeCaptionedVectorTableGrid,
  nativeCaptionedVectorChartStrip,
  nativeCaptionedVectorBarChart,
  nativeCaptionedVectorBarPanels,
  nativeCaptionedVectorHeatmap,
  nativeCaptionedWorkflowPanel,
  nativeCaptionedRaster,
  nativeCaptionedRasterFullWidth,
  nativeCaptionedFramedRaster,
  nativeCaptionedFramedRasterTextPanel,
  nativeCaptionedFramedVectorQuad,
  nativeCaptionedRasterArrayFragment,
  nativeLetteredRasterArray,
  nativeCaptionedRasterQuad,
  nativeCaptionedRasterHorizontalArray,
  nativeCaptionedRasterSideBySide,
  nativeCaptionedRasterVectorStrip,
  nativeCaptionedRasterVectorCompositeGrid,
  nativeCaptionedMixedWorkflowPanel,
  nativeCaptionedPairedRasterGrid,
  nativeCaptionedRasterCompositeGrid,
  nativeCaptionedRasterDualPanelGrid,
  nativeCaptionedRasterModerateGap,
  nativeCaptionedRepeatedRasterRows,
  nativeCaptionedIntervalRows,
  nativeCaptionedOpenCycle,
  nativeCaptionedAlignedRasterPair,
  nativeCaptionedKeyedRasterTriple,
  nativeOwnedAnnotationFrame,
  nativeCaptionedRasterFrameBands,
  nativeCaptionedRasterMapStack,
  nativeCaptionedRasterAnswerPlate,
  nativeCaptionedKeyedHeatmapStack,
  nativeCaptionedRasterTaskTimeline,
  nativeRasterGrid
} from './literature-pdf-figure-native-captioned-illustration.mjs'
import {
  nativeCaptionedPlotBand,
  nativeDisjointPlotColumn,
  nativeFigureRunningHead,
  nativeAlignedNodeFigure,
  nativeClosedCategoryLabels,
  nativeTopParagraphTail
} from './literature-pdf-figure-native-plot-bands.mjs'
import {
  ownedRasterKeyBand,
  pairedVectorTopTitles,
  nativeMultirowRasterPanelEvidence,
  nativeContiguousRasterStack,
  nativeCaptionedRasterBand,
  nativeCaptionedLabeledRasterStack,
  nativeRepeatedRowPanelEvidence,
  nativeRasterFormEnvelope
} from './literature-pdf-native-panel-labels.mjs'
import { union, area, intersection, lineRect } from './literature-pdf-page-geometry.mjs'
import { associateTableNotes } from './literature-pdf-table-notes.mjs'
import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'
import { proveNativeUniqueWholeFonts } from './literature-pdf-table-evidence.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
import { nativeFigureLabelBounds } from './literature-pdf-figure-crop-geometry.mjs'

// A neighboring plate can already own the caption on a text-only page.
// Keep every resolved plate (including multi-page figures), but do not emit
// a second unresolved candidate for that exact source caption.
export function deduplicateFigureCaptions(figures, auxiliaryOwners = []) {
  const key = (figure) =>
    figure.caption &&
    JSON.stringify([figure.caption.page, figure.caption.rect, figure.caption.text])
  const resolved = new Set(
    figures
      .filter((figure) => figure.region)
      .map(key)
      .filter(Boolean)
  )
  const continued = new Set(
    [...figures, ...auxiliaryOwners]
      .filter((figure) => figure.region && figure.caption?.regions?.length === 2)
      .flatMap((figure) => figure.caption.regions.slice(1))
      .map(({ page, rect }) => JSON.stringify([page, rect]))
  )
  return figures.filter(
    (figure) =>
      figure.region ||
      (!continued.has(JSON.stringify([figure.caption?.page, figure.caption?.rect])) &&
        !resolved.has(key(figure)) &&
        !figures.some(
          (other) =>
            other.region &&
            other.caption?.page === figure.caption?.page &&
            other.caption?.text?.length >= 40 &&
            figure.caption?.text?.startsWith(other.caption.text) &&
            intersection(other.caption.rect, figure.caption.rect) / area(other.caption.rect) > 0.25
        ))
  )
}

export function resolveFigureCaption(caption, candidates, pages = []) {
  const hanging = resolveNativeHangingCaption(caption, candidates, pages)
  if (hanging) return hanging
  // A sentence can continue on the next page even when extraction jobs split
  // there. Require both printed ownership markers and one matching fragment;
  // keep page-local rectangles rather than spanning unrelated page content.
  const pointer = /\s*\(continued on (?:following|next) page\)\s*$/i
  const continuation = /^(?:Fig\.?|Figure)\s*([AS]?\d+)\.?:?\s*\(Continued\)\.?\s*/i
  const number = /^(?:Fig\.?|Figure)\s*([AS]?\d+)\b/i.exec(caption?.lines[0])?.[1]
  if (number && pointer.test(caption.lines.join(' '))) {
    const next = candidates.filter(
      (other) =>
        other.page === caption.page + 1 &&
        continuation.exec(other.lines[0])?.[1] === number &&
        !pointer.test(other.lines.join(' '))
    )
    if (
      next.length === 1 &&
      candidates.filter(
        (other) =>
          other.page === caption.page &&
          /^(?:Fig\.?|Figure)\s*([AS]?\d+)\b/i.exec(other.lines[0])?.[1] === number
      ).length === 1
    ) {
      const tail = [...next[0].lines]
      tail[0] = tail[0].replace(continuation, '')
      if (tail.join(' ').trim()) {
        const lines = [...caption.lines]
        lines[lines.length - 1] = lines.at(-1).replace(pointer, '')
        return {
          ...caption,
          lines: [...lines, ...tail],
          regions: [caption, next[0]].map(({ page, rect }) => ({ page, rect }))
        }
      }
    }
  }
  if (/^(?:Fig\.?|Figure)\s*\d+\.?$/i.test(caption?.lines.join(' ').trim())) {
    const label = (c) => /^(?:Fig\.?|Figure)\s*(\d+)\b/i.exec(c.lines[0])?.[1]
    const number = label(caption)
    const full = candidates.filter(
      (c) =>
        label(c) === number &&
        c.page < caption.page &&
        caption.page - c.page <= 4 &&
        c.lines.join(' ').length > 25
    )
    if (full.length === 1) {
      const legends = candidates.filter((c) => c.page === full[0].page)
      const plates = candidates.filter(
        (c) => c.page > full[0].page && c.page <= full[0].page + legends.length
      )
      if (
        legends.length >= 2 &&
        legends.length <= 4 &&
        plates.length === legends.length &&
        legends.every(
          (c, n) =>
            label(c) &&
            c.lines.join(' ').length > 25 &&
            plates.some(
              (p) =>
                p.page === c.page + n + 1 &&
                label(p) === label(c) &&
                /^(?:Fig\.?|Figure)\s*\d+\.?$/i.test(p.lines.join(' ').trim())
            )
        )
      )
        return full[0]
    }
  }
  const direction =
    /see legend on (previous|next) page/i.exec(caption?.lines.join(' '))?.[1] ??
    (/^\((?:Fig\.?|Figure)\s*\d+\s+continues on (?:the )?next page\)$/i.test(
      caption?.lines.join(' ')
    )
      ? 'next'
      : undefined) ??
    (/^(?:Fig\.|Figure)\s*\d+\s*[:.]?\s*Continued\.?$/i.test(caption?.lines.join(' '))
      ? 'next'
      : undefined)
  const pointerNumber = /^\(?(?:Fig\.|Figure)\s*(\d+)\b/i.exec(caption?.lines[0])?.[1]
  if (!direction || !pointerNumber) return caption
  const matches = candidates.filter(
    (other) =>
      Math.abs(other.page - caption.page) === 1 &&
      other.page === caption.page + (direction === 'previous' ? -1 : 1) &&
      /^(?:Fig\.|Figure)\s*(\d+)\b/i.exec(other.lines[0])?.[1] === pointerNumber &&
      !/see legend on (?:previous|next) page/i.test(other.lines.join(' '))
  )
  if (matches.length === 1) return matches[0]
  // Printed previous/next pointers can be wrong after pages are reordered. Only
  // recover an unambiguous neighboring full legend with the exact same number.
  const adjacent = candidates.filter(
    (other) =>
      Math.abs(other.page - caption.page) === 1 &&
      /^(?:Fig\.|Figure)\s*(\d+)\b/i.exec(other.lines[0])?.[1] === pointerNumber &&
      !/see legend on (?:previous|next) page/i.test(other.lines.join(' '))
  )
  return adjacent.length === 1 ? adjacent[0] : caption
}

// An unfinished page-end caption can own a short native paragraph before the
// following plate. Preserve its mixed-font fragments without interpreting them.
function resolveNativeHangingCaption(caption, candidates, pages) {
  const page = pages.find((p) => p.pageNumber === caption?.page)
  const next = pages.find((p) => p.pageNumber === caption?.page + 1)
  if (
    !page ||
    !next ||
    caption.regions ||
    !caption.lines?.length ||
    caption.rect[3] < page.height * 0.8 ||
    !/\p{L}$/u.test(caption.lines.join(' ').trim())
  )
    return
  const owned = page.lines.filter((line) => intersection(lineRect(line), caption.rect) > 0)
  const font = owned
    .filter((line) => line.fontSize > 0)
    .sort((a, b) => b.text.length - a.text.length)[0]?.fontSize
  const printedPageNumber = (line, owner) =>
    /^\d+$/.test(line.text.trim()) &&
    line.y > owner.height * 0.88 &&
    Math.abs(line.x + line.width / 2 - owner.width / 2) < font
  if (
    !font ||
    candidates.some(
      (other) =>
        other !== caption && other.page === caption.page && other.rect[1] >= caption.rect[1]
    ) ||
    page.lines.some((line) => line.y >= caption.rect[3] && !printedPageNumber(line, page))
  )
    return
  const plates = next.graphicsBounds
    .map((g) => g.normalizedRect.map((v, n) => v * (n % 2 ? next.height : next.width)))
    .filter(
      (rect) => rect[2] - rect[0] > next.width * 0.25 && rect[3] - rect[1] > next.height * 0.1
    )
  if (
    !plates.length &&
    (!page.graphicsBounds.some(
      (g) =>
        (g.normalizedRect[2] - g.normalizedRect[0]) * (g.normalizedRect[3] - g.normalizedRect[1]) >
        0.05
    ) ||
      next.lines.some((line) => line.y >= next.height * 0.18 && !printedPageNumber(line, next)))
  )
    return
  const limit = plates.length
    ? Math.min(...plates.map((rect) => rect[1])) - font * 3
    : next.height * 0.18
  // Caption coordinates are expressed in the source page's scale.  A
  // following page may use a different physical size (for example, an
  // inserted landscape or supplemental page), so compare its continuation
  // against the caption's normalized horizontal lane instead of reusing the
  // previous page's absolute x coordinates.  This keeps the cross-page
  // provenance while avoiding a false rejection (or acceptance) caused only
  // by page-size scaling.
  const laneScale = next.width / page.width
  const lane = [caption.rect[0] * laneScale, caption.rect[2] * laneScale]
  const fragments = next.lines.filter((line) => line.y < limit && !printedPageNumber(line, next))
  if (
    !fragments.length ||
    fragments.some(
      (line) =>
        line.x < lane[0] - font * 0.1 ||
        line.x + line.width > lane[1] + font ||
        line.y < font * 3 ||
        line.y + line.height > next.height * 0.18
    )
  )
    return
  const rows = groupNativeCaptionFragments(fragments, font)
  if (
    !rows ||
    rows.length < 2 ||
    rows.length > 8 ||
    !/^\p{Ll}/u.test(rows[0].text.trim()) ||
    rows.some(
      (row, index) =>
        Math.abs(row.x - lane[0]) > font * (index ? 0.2 : 0.1) ||
        (index > 0 && row.y - rows[index - 1].bottom > font * 1.5)
    ) ||
    !/[.!?)]$/.test(rows.at(-1).text.trim()) ||
    candidates.some(
      (other) =>
        other.page === next.pageNumber &&
        intersection(other.rect, [rows[0].x, rows[0].y, rows[0].right, rows[1].bottom]) > 0
    )
  )
    return
  const text = [...caption.lines, ...rows.map((row) => row.text)].join(' ')
  let balance = 0
  for (const character of text) {
    if (character === '(') balance++
    if (character === ')' && --balance < 0) return
  }
  if (balance || new Set(rows.flatMap((row) => row.parts)).size !== fragments.length) return
  return {
    ...caption,
    lines: [...caption.lines, ...rows.map((row) => row.text)],
    regions: [
      { page: caption.page, rect: caption.rect },
      {
        page: next.pageNumber,
        rect: [
          Math.min(...rows.map((row) => row.x)),
          rows[0].y,
          Math.max(...rows.map((row) => row.right)),
          rows.at(-1).bottom
        ]
      }
    ]
  }
}

// Nearby text may be the last/first line of body prose, not a chart label.
// Require three aligned prose lines outside the graphic, extending beyond the
// label search margin. Internal text and short/multiline chart titles stay intact.
const continuesExternalParagraph = (line, bounds, lines, minimumLineLength = 40) => {
  const above = line.y + line.height <= bounds[1]
  const below = line.y >= bounds[3]
  // A wrapped heading or a short paragraph ending can precede a fully aligned
  // prose block. Follow at most two short lines; the following paragraph, not
  // the heading's vocabulary, must independently establish external ownership.
  if (below && line.height > 0 && line.text.length >= 20) {
    let current = line
    for (let step = 0; step < 3; step++) {
      const next = lines
        .filter(
          (other) =>
            other.y >= current.y + current.height &&
            other.y - current.y - current.height <= current.height * 2 &&
            Math.abs(other.x - line.x) <= line.height * 2 &&
            other.x + other.width <= line.x + line.width + line.height * 3
        )
        .sort((a, b) => a.y - b.y)[0]
      if (!next) break
      if (
        current !== line &&
        next.text.length >= minimumLineLength &&
        next.y > line.y + line.height &&
        continuesExternalParagraph(next, bounds, lines, minimumLineLength)
      )
        return true
      if (
        next.text.length >= minimumLineLength ||
        next.text.length < 3 ||
        !/^[\p{L}\s,;:.'’()-]+$/u.test(next.text) ||
        Math.abs(next.height - line.height) > line.height * 0.2 ||
        Math.abs(next.x - line.x) > line.height * 0.2
      )
        break
      current = next
    }
  }
  if (
    below &&
    (/^(?:Conclusions?|Discussion|Results|Methods|Interventions?|Data collection|Acknowledgments?|References)$/i.test(
      line.text.trim()
    ) ||
      (line.text.length < 40 &&
        /^[\p{L} -]+$/u.test(line.text.trim()) &&
        line.y - bounds[3] > line.height))
  ) {
    const paragraph = lines.find(
      (next) =>
        next.y >= line.y + line.height &&
        next.y - line.y - line.height <= line.height * 2 &&
        Math.abs(next.x - line.x) <= line.height * 2 &&
        next.text.length >= 40
    )
    if (paragraph && continuesExternalParagraph(paragraph, bounds, lines, minimumLineLength))
      return true
  }
  if ((!above && !below) || line.text.length < (above ? 3 : 20)) return false
  let current = line
  for (let step = 0; step < 2; step++) {
    const next = lines.find((other) => {
      const gap = above ? current.y - other.y - other.height : other.y - current.y - current.height
      return (
        other !== current &&
        other.text.length >= minimumLineLength &&
        other.height > 0 &&
        Math.abs(other.height - current.height) <= current.height * 0.2 &&
        gap >= 0 &&
        gap <= current.height * 0.8 &&
        Math.abs(other.x - current.x) <= current.height * 2 &&
        (Math.abs(other.x + other.width - current.x - current.width) <= current.height * 2 ||
          (above && step === 0 && other.width >= current.width))
      )
    })
    if (!next) return false
    current = next
  }
  return above ? current.y < bounds[1] - 24 : current.y + current.height > bounds[3] + 24
}

const boundByExternalParagraphs = (rect, bounds, lines) => {
  for (const line of lines) {
    if (
      line.x >= rect[2] ||
      line.x + line.width <= rect[0] ||
      !continuesExternalParagraph(line, bounds, lines)
    )
      continue
    if (line.y + line.height <= bounds[1])
      // PDF text bounds stop at the baseline; leave room for descenders but
      // never trim inside the figure's independently established graphics.
      rect[1] = Math.max(
        rect[1],
        Math.min(bounds[1], line.y + line.height + Math.max(2, line.height * 0.6))
      )
    if (line.y >= bounds[3]) rect[3] = Math.min(rect[3], line.y - 2)
  }
  return rect
}

// Compact vector flowcharts are often encoded as dozens of separate border
// paths, so the generic nearest-graphic matcher sees only disconnected strokes.
// An explicit flowchart caption supplies enough evidence to join nearby boxes
// and connectors into one crop.
function associateConnectedFlowchart(page, captions, tableRects) {
  const dy = page.height / 128
  for (const caption of captions.filter(
    (c) =>
      captionKind(c.lines[0]) === 'figure' &&
      /\b(?:flow\s*chart|flow diagram|CONSORT)\b/i.test(c.lines.join(' '))
  )) {
    // A marginal caption can sit beside the root rather than below the tree.
    // Prove ownership using populated node frames and connected branches before
    // the standalone-plate shortcut chooses the nearest individual box.
    const nextCaption = Math.min(
      page.height * 0.9,
      ...captions.filter((c) => c !== caption && c.rect[1] > caption.rect[3]).map((c) => c.rect[1])
    )
    const paths = page.graphicsBounds
      .filter((g) => g.kind === 'path')
      .map((g) => ({
        rect: g.normalizedRect.map((v, n) => v * (n % 2 ? page.height : page.width))
      }))
      .filter(
        ({ rect: r }) =>
          r[1] >= caption.rect[1] - dy &&
          r[3] < nextCaption &&
          area(r) > 0 &&
          !tableRects.some((t) => intersection(t, r) > 0)
      )
    const nodes = paths.filter(
      ({ rect: r }) =>
        r[2] - r[0] > page.width * 0.1 &&
        r[3] - r[1] > dy * 3 &&
        r[3] - r[1] < page.height * 0.15 &&
        (paths.filter(
          ({ rect: p }) =>
            area(p) < area(r) * 0.4 &&
            p[2] - p[0] > dy &&
            p[3] - p[1] > dy &&
            intersection(r, p) / area(p) > 0.99
        ).length >= 2 ||
          page.lines.filter((l) => intersection(r, lineRect(l)) / area(lineRect(l)) > 0.99)
            .length >= 2)
    )
    const roots = nodes.filter(
      ({ rect: r }) =>
        Math.abs(r[1] - caption.rect[1]) < dy &&
        (r[0] >= caption.rect[2] || r[2] <= caption.rect[0])
    )
    if (roots.length !== 1 || nodes.length < 4) continue
    const connected = [roots[0]],
      pending = new Set(paths.filter((p) => p !== roots[0]))
    connectFigureGraphics(connected, pending)
    const ownedNodes = nodes.filter((n) => connected.includes(n))
    const connectors = connected.filter(
      ({ rect: r }) =>
        Math.min(r[2] - r[0], r[3] - r[1]) < dy * 2 && Math.max(r[2] - r[0], r[3] - r[1]) > dy * 3
    )
    if (ownedNodes.length < 4 || connectors.length < ownedNodes.length - 1) continue
    const rect = union(connected.map((p) => p.rect))
    if (
      captions.some((c) => c !== caption && intersection(c.rect, rect) > 0) ||
      page.lines.some(
        (l) => l.text.length > 80 && intersection(lineRect(l), rect) / area(lineRect(l)) > 0.5
      )
    )
      continue
    return [{ caption, rect, graphicsCount: connected.length }]
  }
}

function associateFlowchart(page, captions, tableRects) {
  for (const caption of captions.filter(
    (candidate) =>
      candidate.page === page.pageNumber &&
      captionKind(candidate.lines[0]) === 'figure' &&
      /\b(?:flowchart|flow diagram|CONSORT)\b/i.test(candidate.lines.join(' '))
  )) {
    // A CONSORT diagram can be only one panel of a larger figure. Its shortcut
    // owns interior node labels only; let the full plot matcher retain the axes
    // and titles when the caption explicitly names several native panel letters.
    const legend = caption.lines.join(' ')
    const panels = new Set(
      page.lines
        .filter(
          (line) =>
            /^[a-z]$/.test(line.text.trim()) &&
            line.y + line.height < caption.rect[1] &&
            new RegExp(`(?:^|[. )])${line.text.trim()}\\s+[A-Z]`).test(legend)
        )
        .map((line) => line.text.trim())
    )
    if (panels.size >= 2) continue
    const eligiblePaths = (page.graphicsBounds ?? [])
      .filter((graphic) => graphic.kind === 'path')
      .map((graphic) =>
        graphic.normalizedRect.map((value, index) => value * (index % 2 ? page.height : page.width))
      )
      .filter(
        (rect) =>
          // Recorded path bounds round outward and can graze the caption.
          rect[3] <= caption.rect[1] + page.height / 256 + 1 &&
          rect[1] >= page.height * 0.04 &&
          rect[2] - rect[0] >= 2 &&
          rect[3] - rect[1] >= 2 &&
          !tableRects.some((table) => intersection(table, rect) > 0)
      )
    const paths = eligiblePaths.filter((rect) => rect[1] >= caption.rect[1] - page.height * 0.45)
    if (paths.length < 12) continue
    // The caption window is a seed, not a crop boundary. Follow adjoining
    // upstream boxes so tall flowcharts retain enrollment and exclusion nodes.
    for (;;) {
      const extent = union(paths)
      const upstream = eligiblePaths.filter(
        (r) =>
          !paths.includes(r) &&
          r[1] <= extent[3] &&
          r[3] >= extent[1] - 36 &&
          r[0] < extent[2] &&
          r[2] > extent[0]
      )
      if (!upstream.length) break
      paths.push(...upstream)
    }
    const bounds = union(paths)
    // Some diagrams paint the enclosing border in a raster, then overlay native
    // node paths. The path-only shortcut cannot own that border; the general
    // raster matcher below retains the original image and its adjacent labels.
    if (
      (page.graphicsBounds ?? []).some((g) => {
        if (g.kind !== 'image' || area(g.normalizedRect) < 0.03) return false
        const r = g.normalizedRect.map((v, n) => v * (n % 2 ? page.height : page.width))
        return (
          intersection(r, bounds) / area(bounds) > 0.95 &&
          r[3] <= caption.rect[1] &&
          !tableRects.some((t) => intersection(t, r) > 0)
        )
      })
    )
      continue
    // A marginal legend can lie beside the final nodes. The shortcut above
    // the legend must not crop away a connected continuation below it.
    if (
      (page.graphicsBounds ?? []).some((g) => {
        if (g.kind !== 'path') return false
        const r = g.normalizedRect.map((v, n) => v * (n % 2 ? page.height : page.width))
        return (
          r[3] > caption.rect[1] + page.height / 256 + 1 &&
          r[1] < bounds[3] + 36 &&
          r[0] < bounds[2] &&
          r[2] > bounds[0] &&
          r[2] - r[0] > 12 &&
          !tableRects.some((t) => intersection(t, r) > 0)
        )
      })
    )
      continue
    if (
      page.lines.some(
        (line) =>
          line.text.length > 80 && intersection(lineRect(line), bounds) / area(lineRect(line)) > 0.5
      )
    )
      continue
    const labels = page.lines.filter(
      (line) =>
        line.text.length < 80 && intersection(lineRect(line), bounds) / area(lineRect(line)) > 0.5
    )
    const rect = union([bounds, ...labels.map(lineRect)])
    const definitions = page.lines.filter((line) => {
      const keys = [...line.text.matchAll(/(?:^|[,;]\s*)([A-Z]{2,5}):\s+[^,;]+/g)]
      return (
        keys.length >= 2 &&
        keys.every((match) => labels.some((l) => new RegExp(`\\b${match[1]}\\b`).test(l.text))) &&
        line.fontSize > 0 &&
        line.fontSize <= 8 &&
        line.height <= line.fontSize * 1.2 &&
        line.y >= rect[3] &&
        line.y - rect[3] <= line.fontSize * 2 &&
        line.y + line.height < caption.rect[1] - 2 &&
        line.x >= rect[0] &&
        line.x + line.width <= rect[2] &&
        !page.lines.some(
          (other) => other !== line && intersection(lineRect(other), lineRect(line)) > 0
        )
      )
    })
    if (definitions.length === 1) rect[3] = definitions[0].y + definitions[0].height
    rect[3] = Math.min(rect[3], caption.rect[1] - 2)
    return [
      {
        caption,
        rect,
        graphicsCount: paths.length
      }
    ]
  }
  return undefined
}

// Recover a classifier-rejected title only from a complete independently
// painted native font program and its single adjacent raster carrier.
function nativeCaptionPaintPackets(page, context) {
  const ops = context?.operators,
    viewport = context?.viewport
  const numbers = (a, n) => Array.isArray(a) && a.length === n && a.every(Number.isFinite)
  const near = (a, b) => a.every((v, n) => Math.abs(v - b[n]) < 1e-5)
  if (
    !Array.isArray(ops?.fnArray) ||
    !Array.isArray(ops.argsArray) ||
    ops.fnArray.length !== ops.argsArray.length ||
    ops.fnArray.length > 2000 ||
    !numbers(viewport?.transform, 6) ||
    !near(viewport.transform, [1, 0, 0, -1, 0, page.height]) ||
    viewport.scale !== 1 ||
    viewport.rotation !== 0 ||
    viewport.width !== page.width ||
    viewport.height !== page.height
  )
    return
  let matrix = [1, 0, 0, 1, 0, 0],
    text = false,
    font,
    size,
    origin = [0, 0],
    cursor = 0
  const stack = [],
    packets = [],
    images = []
  for (let i = 0; i < ops.fnArray.length; i++) {
    const op = ops.fnArray[i],
      a = ops.argsArray[i]
    if (op === OPS.save) {
      if (text) return
      stack.push([...matrix])
    } else if (op === OPS.restore) {
      if (text || !stack.length) return
      matrix = stack.pop()
    } else if (op === OPS.transform) {
      if (text || !numbers(a, 6) || a[1] !== 0 || a[2] !== 0 || a[0] <= 0 || a[3] <= 0) return
      matrix = [
        matrix[0] * a[0],
        0,
        0,
        matrix[3] * a[3],
        matrix[0] * a[4] + matrix[4],
        matrix[3] * a[5] + matrix[5]
      ]
      if (!matrix.every(Number.isFinite)) return
    } else if (op === OPS.beginText) {
      if (text || !near(matrix, [1, 0, 0, 1, 0, 0])) return
      text = true
      origin = [0, 0]
      cursor = 0
    } else if (op === OPS.endText) {
      if (!text) return
      text = false
    } else if (op === OPS.setFont) {
      if (
        !text ||
        !Array.isArray(a) ||
        a.length !== 2 ||
        typeof a[0] !== 'string' ||
        !a[0] ||
        !Number.isFinite(a[1]) ||
        a[1] <= 0 ||
        a[1] > 100
      )
        return
      ;[font, size] = a
    } else if (op === OPS.setTextMatrix) {
      if (
        !text ||
        !Array.isArray(a) ||
        a.length !== 1 ||
        !(Array.isArray(a[0]) || a[0] instanceof Float32Array)
      )
        return
      const m = Array.prototype.slice.call(a[0])
      if (!numbers(m, 6) || m[0] !== 1 || m[1] !== 0 || m[2] !== 0 || m[3] !== 1) return
      origin = [m[4], m[5]]
      cursor = origin[0]
    } else if (op === OPS.moveText) {
      if (!text || !numbers(a, 2)) return
      origin = [origin[0] + a[0], origin[1] + a[1]]
      cursor = origin[0]
    } else if (op === OPS.showText) {
      if (
        !text ||
        !font ||
        !size ||
        !Array.isArray(a) ||
        a.length !== 1 ||
        !Array.isArray(a[0]) ||
        a[0].length > 1000
      )
        return
      let first,
        last,
        literal = ''
      for (const glyph of a[0]) {
        if (typeof glyph === 'number') {
          if (!Number.isFinite(glyph) || Math.abs(glyph) > 10000) return
          cursor -= (glyph * size) / 1000
          continue
        }
        if (
          !glyph ||
          typeof glyph.unicode !== 'string' ||
          !glyph.unicode ||
          glyph.isInFont !== true ||
          glyph.operatorListId !== undefined ||
          glyph.accent !== null ||
          !Number.isFinite(glyph.width) ||
          glyph.width <= 0 ||
          glyph.width > 5000
        )
          return
        if (first === undefined) first = cursor
        literal += glyph.unicode
        cursor += (glyph.width * size) / 1000
        last = cursor
      }
      if (
        first === undefined ||
        !(last > first) ||
        ![first, last, ...origin].every(Number.isFinite)
      )
        return
      packets.push({
        font,
        literal,
        height: size,
        baseline: page.height - origin[1],
        rect: [first, page.height - origin[1] - size, last, page.height - origin[1]],
        operationIndex: i
      })
    } else if (op === OPS.paintImageXObject) {
      if (
        text ||
        !Array.isArray(a) ||
        a.length !== 3 ||
        typeof a[0] !== 'string' ||
        !a[0] ||
        !Number.isSafeInteger(a[1]) ||
        a[1] <= 0 ||
        !Number.isSafeInteger(a[2]) ||
        a[2] <= 0
      )
        return
      images.push({
        operationIndex: i,
        rect: [
          matrix[4],
          page.height - matrix[5] - matrix[3],
          matrix[4] + matrix[0],
          page.height - matrix[5]
        ]
      })
    } else if (op === OPS.setGState) {
      // This profile paints at default opaque alpha. Only disabling the
      // soft mask preserves that proof; unknown state entries fail closed.
      if (
        text ||
        !Array.isArray(a) ||
        a.length !== 1 ||
        !Array.isArray(a[0]) ||
        a[0].length !== 1 ||
        !Array.isArray(a[0][0]) ||
        a[0][0].length !== 2 ||
        a[0][0][0] !== 'SMask' ||
        a[0][0][1] !== false
      )
        return
    } else if (op === OPS.setFillRGBColor || op === OPS.setStrokeRGBColor) {
      // The complete native packet family is monochrome on white. Do not
      // infer visible glyph ink from advances under an unknown paint color.
      if (!Array.isArray(a) || a.length !== 1 || a[0] !== '#000000') return
    } else if (op === OPS.dependency) {
      if (
        !Array.isArray(a) ||
        !a.length ||
        a.length > 100 ||
        a.some((id) => typeof id !== 'string' || !id)
      )
        return
    } else if (op === OPS.setDash) {
      if (
        text ||
        !Array.isArray(a) ||
        a.length !== 2 ||
        !Array.isArray(a[0]) ||
        a[0].length ||
        a[1] !== 0
      )
        return
    } else if (op === OPS.setLineCap) {
      if (text || !Array.isArray(a) || a.length !== 1 || a[0] !== 0) return
    } else if (op === OPS.setLineWidth) {
      if (text || !numbers(a, 1) || a[0] <= 0 || a[0] > 10) return
    } else if (op === OPS.constructPath) {
      const packed = (value) => {
        if (Array.isArray(value) || ArrayBuffer.isView(value)) return Array.from(value)
        // Private JSON source receipts preserve typed-array coordinates as
        // sequential numeric keys. Validate that exact serialization too.
        if (
          value &&
          typeof value === 'object' &&
          Object.keys(value).every((key, n) => key === String(n))
        )
          return Object.values(value)
      }
      const path = packed(a?.[1]?.[0]),
        bounds = packed(a?.[2])
      if (
        text ||
        !Array.isArray(a) ||
        a.length !== 3 ||
        a[0] !== OPS.stroke ||
        !Array.isArray(a[1]) ||
        a[1].length !== 1 ||
        !numbers(path, 6) ||
        path[0] !== 0 ||
        path[3] !== 1 ||
        path[2] !== path[5] ||
        path[4] <= path[1] ||
        !numbers(bounds, 4) ||
        !near(bounds, [path[1], path[2], path[4], path[5]])
      )
        return
    } else return
  }
  if (text || stack.length) return
  return { packets, images }
}

function recoverNativePunctuatedRasterCaption(page, candidates, tables, rules, tokens, context) {
  const validRect = (r) =>
    Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && area(r) > 0
  const contains = (a, b, tolerance = 1e-7) =>
    b.every((v, n) => (n < 2 ? v >= a[n] - tolerance : v <= a[n] + tolerance))
  const glyphs = (s) => s.replace(/\s+/gu, '')
  const near = (a, b) => a.every((v, n) => Math.abs(v - b[n]) < 1e-5)
  if (
    !page?.lines?.length ||
    page.invalidGraphicsBounds !== 0 ||
    !tokens?.length ||
    !page.graphicsBounds?.length ||
    tables.length
  )
    return []
  const profile = nativeCaptionPaintPackets(page, context)
  if (!profile || profile.images.length !== 1) return []
  const images = page.graphicsBounds.filter((g) => g.kind === 'image')
  if (images.length !== 1) return []
  const image = images[0]
  if (
    !image.imageHash ||
    !validRect(image.normalizedRect) ||
    !validRect(image.paintedNormalizedRect) ||
    !contains(image.normalizedRect, image.paintedNormalizedRect)
  )
    return []
  const rect = image.paintedNormalizedRect.map((v, n) => v * (n % 2 ? page.height : page.width))
  const painted = profile.images[0]
  const recorded = image.normalizedRect.map((v, n) => v * (n % 2 ? page.height : page.width))
  if (
    image.operationIndex !== painted.operationIndex ||
    !contains(recorded, painted.rect, 1e-5) ||
    !near(
      image.normalizedRect,
      painted.rect.map(
        (v, n) =>
          (n < 2
            ? Math.floor((v * 256) / (n % 2 ? page.height : page.width))
            : Math.ceil((v * 256) / (n % 2 ? page.height : page.width)) + 1) / 256
      )
    ) ||
    !contains(painted.rect, rect)
  )
    return []
  const runs = groupPageLines(page, rules),
    results = []
  for (const start of runs) {
    const label = /^(Figure\s+[A-Z]?\d+(?:\.\d+)*:)\s+\p{L}/u.exec(start.text)
    if (
      !label ||
      captionKind(start.text) ||
      start.right - start.x < page.width * 0.5 ||
      candidates.some(
        (c) =>
          c.page === page.pageNumber &&
          intersection(c.rect, [start.x, start.y, start.right, start.bottom]) > 0
      )
    )
      continue
    const em = start.fontSize,
      gap = start.y - rect[3]
    if (
      !(em > 0) ||
      rect[2] - rect[0] < em * 8 ||
      rect[3] - rect[1] < em * 8 ||
      gap < 0 ||
      gap > em * 2 ||
      rect[0] < start.x - em ||
      rect[2] > start.right + em
    )
      continue
    const following = runs
      .filter(
        (r) => r.y > start.y && r.y - start.y < em * 14 && r.right > start.x && r.x < start.right
      )
      .sort((a, b) => a.y - b.y)
    const lead = following[0]?.y - start.y,
      rows = [start]
    if (lead < em || lead > em * 1.3) continue
    for (const row of following) {
      const prior = rows.at(-1)
      if (
        rows.length >= 12 ||
        ![row.x, row.y, row.right, row.bottom, row.fontSize].every(Number.isFinite) ||
        Math.abs(row.fontSize - em) > em * 0.01 ||
        Math.abs(row.x - start.x) > em * 0.05 ||
        row.right > start.right + em * 0.05 ||
        Math.abs(row.y - prior.y - lead) > em * 0.02 ||
        captionKind(row.text) ||
        /^(?:Figure|Fig\.?|Table|Tab\.?)\s+\w+/i.test(row.text)
      )
        break
      rows.push(row)
      if (/[.!?]$/.test(row.text) && row.right - row.x < (start.right - start.x) * 0.95) break
    }
    if (
      rows.length < 3 ||
      !/[.!?]$/.test(rows.at(-1).text) ||
      rows.slice(1, -1).some((r) => r.right - r.x < (start.right - start.x) * 0.95)
    )
      continue
    const captionRect = union(rows.map((r) => [r.x, r.y, r.right, r.bottom]))
    const envelope = union([rect, captionRect])
    if (
      page.graphicsBounds.some(
        (g) =>
          g !== image &&
          intersection(
            g.normalizedRect.map((v, n) => v * (n % 2 ? page.height : page.width)),
            envelope
          ) > 0
      ) ||
      rules.some(
        (r) =>
          r[1] === r[3] &&
          r[1] > rect[1] &&
          r[1] < captionRect[3] &&
          r[2] > envelope[0] &&
          r[0] < envelope[2]
      ) ||
      candidates.some((c) => c.page === page.pageNumber && intersection(c.rect, envelope) > 0)
    )
      continue
    const fonts = tokens.filter(
      (t) => t.rect?.every(Number.isFinite) && intersection(t.rect, captionRect) > 0
    )
    if (
      !fonts.length ||
      fonts.some(
        (t) =>
          !t.horizontal ||
          !validRect(t.rect) ||
          ![t.height, t.baseline, t.fontDescent].every(Number.isFinite) ||
          t.fontDescent > 0 ||
          t.fontDescent < -1 ||
          t.sourceItem?.pageNumber !== page.pageNumber ||
          t.sourceItem?.text !== t.text ||
          !contains(captionRect, t.rect, em * 0.02)
      )
    )
      continue
    const bound = fonts.map((t) =>
      profile.packets.filter(
        (p) =>
          glyphs(p.literal) === glyphs(t.text) &&
          near(p.rect, t.rect) &&
          Math.abs(p.height - t.height) < 1e-5 &&
          Math.abs(p.baseline - t.baseline) < 1e-5
      )
    )
    if (
      bound.some((ps) => ps.length !== 1) ||
      new Set(bound.map((ps) => ps[0].operationIndex)).size !== fonts.length ||
      new Set(fonts.map((t) => t.sourceItem.index)).size !== fonts.length
    )
      continue
    const paintedFonts = profile.packets.filter((p) => intersection(p.rect, captionRect) > 0)
    if (
      paintedFonts.length !== fonts.length ||
      paintedFonts.some((p) => !bound.some((ps) => ps[0] === p))
    )
      continue
    const packets = rows.map((r) =>
      fonts
        .filter((t) => Math.abs(t.baseline - r.bottom) < em * 0.01)
        .sort((a, b) => a.rect[0] - b.rect[0])
    )
    if (
      packets.flat().length !== fonts.length ||
      packets.some((ts, n) => glyphs(ts.map((t) => t.text).join('')) !== glyphs(rows[n].text))
    )
      continue
    const ordered = fonts
      .map((t, n) => ({ token: t, paint: bound[n][0] }))
      .sort((a, b) => a.paint.operationIndex - b.paint.operationIndex)
    const parent = ordered[0],
      first = ordered[1]
    if (
      parent?.token.text !== label[1] ||
      !first ||
      first.paint.font === parent.paint.font ||
      Math.abs(first.token.fontDescent - parent.token.fontDescent) < 0.002
    )
      continue
    const title = []
    let n = 1
    for (; n < ordered.length; n++) {
      const entry = ordered[n]
      if (
        entry.paint.font !== first.paint.font ||
        entry.token.fontDescent !== first.token.fontDescent ||
        Math.abs(entry.token.height - em) > em * 0.01 ||
        n > 3
      )
        break
      title.push(entry.token.text)
      if (/[.!?]$/.test(entry.token.text)) {
        n++
        break
      }
    }
    if (
      !title.length ||
      !/[.!?]$/.test(title.at(-1)) ||
      ordered[n]?.paint.font !== parent.paint.font ||
      ordered[n]?.token.fontDescent !== parent.token.fontDescent
    )
      continue
    // Classification alias only: a whole hyphenated noun is one lexical
    // token. The independently painted title ends before body explanation.
    if (
      captionKind(
        `${label[1]} ${title.join(' ').replace(/\p{L}+(?:[-\u2010-\u2015]\p{L}+)+/gu, '__compound__')}`
      ) !== 'figure'
    )
      continue
    const whole = union(
      fonts.map((t) => [t.rect[0], t.rect[1], t.rect[2], t.baseline - t.fontDescent * t.height])
    )
    if (
      tokens.some(
        (t) =>
          !fonts.includes(t) &&
          t.rect?.every(Number.isFinite) &&
          intersection(t.rect, union([captionRect, whole])) > 0
      ) ||
      page.lines.some(
        (l) =>
          intersection(lineRect(l), envelope) > 0 &&
          !rows.some(
            (r) =>
              glyphs(r.text) === glyphs(l.text) && near([r.x, r.y, r.right, r.bottom], lineRect(l))
          )
      )
    )
      continue
    results.push({
      caption: {
        page: page.pageNumber,
        lines: rows.map((r) => r.text),
        rect: union([captionRect, whole])
      },
      rect,
      graphicsCount: 1
    })
  }
  return results.length === 1 ? results : []
}

// Only two native closed frames may complete titles above an already resolved
// raster grid. Detached result labels remain outside this admission.
function nativeRasterClosedFrameTitles(
  page,
  figure,
  captions,
  tables,
  frames,
  fonts,
  foreignOwns,
  operatorContext
) {
  const validRect = (r) =>
    Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1]
  const insideRect = (outer, inner) =>
    inner.every((v, n) => (n < 2 ? v >= outer[n] : v <= outer[n]))
  if (
    !page ||
    !figure ||
    figure.reason !== 'native-raster-composite-grid' ||
    !validRect(figure.rect) ||
    page.invalidGraphicsBounds !== 0 ||
    !Number.isFinite(page.width) ||
    !Number.isFinite(page.height) ||
    page.width <= 0 ||
    page.height <= 0 ||
    ![captions, tables, frames, fonts].every(Array.isArray) ||
    !frames.every(validRect) ||
    !fonts.length
  )
    return
  const owner = figure.caption,
    rect = figure.rect,
    origins = new Set()
  if (!owner || captions.filter((c) => c === owner).length !== 1 || !validRect(owner.rect)) return
  for (const f of fonts) {
    if (
      !f ||
      typeof f.text !== 'string' ||
      !f.text.trim() ||
      !validRect(f.rect) ||
      ![f.height, f.baseline].every(Number.isFinite) ||
      f.height <= 0 ||
      typeof f.horizontal !== 'boolean' ||
      f.sourceItem?.pageNumber !== page.pageNumber ||
      !Number.isSafeInteger(f.sourceItem.index) ||
      f.sourceItem.index < 0 ||
      f.sourceItem.text !== f.text
    )
      return
    const k = f.sourceItem.index
    if (origins.has(k)) return
    if (operatorContext && operatorContext.content?.items?.[k]?.str !== f.text) return
    origins.add(k)
  }
  const captionFonts = fonts.filter((f) => intersection(owner.rect, f.rect) / area(f.rect) > 0.95)
  if (!captionFonts.length) return
  const font = Math.max(...captionFonts.map((f) => f.height))
  if (!(font > 0)) return
  const candidates = frames.filter(
    (f) =>
      f[1] < rect[1] &&
      rect[1] - f[1] <= font &&
      f[3] <= rect[3] &&
      f[3] - f[1] >= font * 10 &&
      f[2] - f[0] >= font * 8 &&
      intersection(f, rect) / area(f) >= 0.9
  )
  if (candidates.length !== 2) return
  const pair = candidates.slice().sort((a, b) => a[0] - b[0])
  if (
    intersection(pair[0], pair[1]) !== 0 ||
    Math.abs(pair[0][1] - pair[1][1]) > font * 0.1 ||
    Math.abs(pair[0][3] - pair[1][3]) > font * 0.1 ||
    pair[1][0] - pair[0][2] > font
  )
    return
  if (
    !Array.isArray(page.graphicsBounds) ||
    page.graphicsBounds.some(
      (g) => !g || !['image', 'path'].includes(g.kind) || !validRect(g.normalizedRect)
    )
  )
    return
  const images = page.graphicsBounds
    .filter((g) => g.kind === 'image')
    .map((g) =>
      (g.paintedNormalizedRect || g.normalizedRect).map(
        (v, n) => v * (n % 2 ? page.height : page.width)
      )
    )
  if (
    !images.every(validRect) ||
    !pair.every((f) => images.filter((r) => insideRect(f, r)).length >= 2)
  )
    return
  const titles = pair.map((frame) =>
    fonts.filter(
      (t) =>
        t.horizontal &&
        insideRect(frame, t.rect) &&
        t.rect[1] < rect[1] &&
        t.rect[3] <= rect[1] + font * 0.3 &&
        t.height >= font * 0.5 &&
        t.height <= font * 0.8 &&
        t.text.length >= 12 &&
        t.text.length <= 100 &&
        t.rect[2] - t.rect[0] >= font * 5 &&
        Math.abs((t.rect[0] + t.rect[2] - frame[0] - frame[2]) / 2) <= font * 2
    )
  )
  if (!titles.every((t) => t.length === 1)) return
  const selected = titles.flat(),
    target = [
      Math.min(rect[0], ...pair.map((f) => f[0])),
      Math.min(rect[1], ...pair.map((f) => f[1])),
      rect[2],
      rect[3]
    ]
  if (foreignOwns(target)) return
  if (
    captions.some(
      (c) => c.page === page.pageNumber && c !== owner && intersection(c.rect, target) > 0
    ) ||
    tables.some((t) => intersection(t, target) > 0)
  )
    return
  for (const f of fonts) {
    if (intersection(f.rect, target) > intersection(f.rect, rect) && !selected.includes(f)) return
  }
  // Border ink and the renderer's quantized footprint need their specific
  // source paint. A large overlapping path is never an ownership witness.
  const specificPaint = nativeRasterFramePaints(page, pair, operatorContext)
  for (const g of page.graphicsBounds || []) {
    if (!['path', 'image'].includes(g.kind) || !validRect(g.normalizedRect)) return
    const r = g.normalizedRect.map((v, n) => v * (n % 2 ? page.height : page.width))
    if (
      intersection(r, target) > intersection(r, rect) &&
      !pair.some((f) => insideRect(f, r)) &&
      !specificPaint?.has(g)
    )
      return
  }
  return target
}

// A bounded first-paint prefix, not a general paint interpreter. Unknown state
// leaves the old crop intact. The geometry probe's 1.5-scale, 256-bin recorder
// is the existing source of these rectangles; never bind arbitrary later
// optimized-render operation indices to the original operator list.
function nativeRasterFramePaints(page, frames, context) {
  const { operators, viewport, content } = context ?? {}
  if (
    !Array.isArray(operators?.fnArray) ||
    !Array.isArray(operators.argsArray) ||
    operators.fnArray.length !== operators.argsArray.length ||
    !Array.isArray(content?.items) ||
    !content.items.length ||
    !Array.isArray(viewport?.transform) ||
    !viewport.transform.every(Number.isFinite) ||
    viewport.width !== page.width ||
    viewport.height !== page.height
  )
    return
  const rectPath = (args) => {
    const p = args?.[1]?.length === 1 ? args[1][0] : undefined
    if (
      !p ||
      p.length !== 13 ||
      p[0] !== 0 ||
      p[12] !== 4 ||
      ![3, 6, 9].every((n) => p[n] === 1) ||
      !Array.from(p).every(Number.isFinite)
    )
      return
    const points = [0, 3, 6, 9].map((n) => [p[n + 1], p[n + 2]])
    const r = [
      Math.min(...points.map((p) => p[0])),
      Math.min(...points.map((p) => p[1])),
      Math.max(...points.map((p) => p[0])),
      Math.max(...points.map((p) => p[1]))
    ]
    if (
      r[2] <= r[0] ||
      r[3] <= r[1] ||
      new Set(points.map((p) => p.join(','))).size !== 4 ||
      points.some((p, n) => {
        const q = points[(n + 1) % 4]
        return p[0] !== q[0] && p[1] !== q[1]
      }) ||
      !(Array.isArray(args[2]) || args[2] instanceof Float32Array) ||
      args[2].length !== 4 ||
      !Array.from(args[2]).every(Number.isFinite) ||
      !r.every((v, n) => v === args[2][n])
    )
      return
    return r
  }
  const quantize = (r) =>
    r.map(
      (v, n) =>
        (n < 2
          ? Math.floor(((v * 1.5) / Math.ceil((n % 2 ? page.height : page.width) * 1.5)) * 256)
          : Math.ceil(((v * 1.5) / Math.ceil((n % 2 ? page.height : page.width) * 1.5)) * 256) +
            1) / 256
    )
  const matrixRect = (r, m) => {
    if (!m.every(Number.isFinite) || m[1] !== 0 || m[2] !== 0 || m[0] === 0 || m[3] === 0) return
    const a = [r[0], r[1]],
      b = [r[2], r[3]]
    Util.applyTransform(a, m)
    Util.applyTransform(b, m)
    return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]
  }
  let transform = [1, 0, 0, 1, 0, 0],
    group,
    clip,
    alpha = 1,
    white = false,
    pendingClip = false,
    first
  const states = []
  const fn = operators.fnArray,
    args = operators.argsArray
  for (let i = 0; i < fn.length; i++) {
    const op = fn[i],
      a = args[i]
    if (op === OPS.transform) {
      if (
        group ||
        clip ||
        pendingClip ||
        !Array.isArray(a) ||
        a.length !== 6 ||
        !a.every(Number.isFinite)
      )
        return
      transform = Util.transform(transform, a)
    } else if (op === OPS.save) states.push([...transform])
    else if (op === OPS.beginGroup) {
      if (
        group ||
        !a?.[0] ||
        a[0].matrix !== null ||
        a[0].smask !== null ||
        a[0].isolated !== false ||
        a[0].knockout !== false ||
        !Array.isArray(a[0].bbox) ||
        a[0].bbox.length !== 4 ||
        !a[0].bbox.every(Number.isFinite)
      )
        return
      group = a[0].bbox
    } else if (op === OPS.paintFormXObjectBegin) {
      if (!group || a?.[0] != null || a?.[1] != null) return
      states.push([...transform])
    } else if (op === OPS.beginMarkedContent) {
      if (a?.[0]?.name !== 'Artifact') return
    } else if (op === OPS.clip || op === OPS.eoClip) {
      if (pendingClip || clip) return
      pendingClip = true
    } else if (op === OPS.setGState) {
      if (!Array.isArray(a?.[0])) return
      for (const [key, value] of a[0]) {
        if (key === 'ca') {
          if (value !== 1) return
          alpha = value
        } else if (key === 'BM') {
          if (value !== 'source-over') return
        } else return
      }
    } else if (op === OPS.setFillRGBColor) {
      white = a?.length === 1 && a[0] === '#ffffff'
      if (!white) return
    } else if (op === OPS.constructPath) {
      const r = rectPath(a)
      if (!r) return
      if (a[0] === OPS.endPath) {
        if (!pendingClip || clip) return
        clip = r
        pendingClip = false
        continue
      }
      if (
        ![OPS.fill, OPS.eoFill].includes(a[0]) ||
        !group ||
        !clip ||
        pendingClip ||
        alpha !== 1 ||
        !white
      )
        return
      first = { index: i, rect: r, matrix: Util.transform(viewport.transform, transform) }
      break
    } else return
  }
  if (!first) return
  const outer = matrixRect(group, first.matrix),
    clipped = matrixRect(clip, first.matrix),
    paint = matrixRect(first.rect, first.matrix)
  if (!outer || !clipped || !paint) return
  const effective = [
    Math.max(paint[0], clipped[0]),
    Math.max(paint[1], clipped[1]),
    Math.min(paint[2], clipped[2]),
    Math.min(paint[3], clipped[3])
  ]
  const q = quantize(effective),
    outerQ = quantize(outer)
  if (
    !q.every((v, n) => v === outerQ[n]) ||
    !frames.every((f) => f.every((v, n) => (n < 2 ? v >= effective[n] : v <= effective[n])))
  )
    return
  const background = page.graphicsBounds.filter(
    (g) =>
      g.kind === 'path' &&
      g.operationIndex === first.index &&
      g.normalizedRect.every((v, n) => v === q[n])
  )
  if (background.length !== 1 || page.graphicsBounds[0] !== background[0]) return
  const owned = new Set(background)
  const activeMatrices = new Map()
  // Only graphics-state transforms are followed after the first paint. The
  // unchanged native collector has already established each closed frame.
  for (let i = first.index + 1; i < fn.length; i++) {
    const op = fn[i],
      a = args[i]
    if (op === OPS.save) states.push([...transform])
    else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
      if (!states.length) return
      transform = states.pop()
    } else if (op === OPS.transform) {
      if (!Array.isArray(a) || a.length !== 6 || !a.every(Number.isFinite)) return
      transform = Util.transform(transform, a)
    } else if (op === OPS.paintFormXObjectBegin) {
      states.push([...transform])
      if (a?.[0] != null) {
        if (!Array.isArray(a[0]) || a[0].length !== 6 || !a[0].every(Number.isFinite)) return
        transform = Util.transform(transform, a[0])
      }
    } else if (op === OPS.beginGroup && a?.[0]?.matrix != null) return
    else if (op === OPS.constructPath && a?.[0] === OPS.stroke)
      activeMatrices.set(i, Util.transform(viewport.transform, transform))
  }
  if (states.length) return
  for (const frame of frames) {
    const matches = []
    for (let i = first.index + 1; i < fn.length; i++) {
      if (
        fn[i] !== OPS.constructPath ||
        args[i]?.[0] !== OPS.stroke ||
        fn[i - 4] !== OPS.save ||
        fn[i - 3] !== OPS.setLineWidth ||
        fn[i - 2] !== OPS.setStrokeRGBColor ||
        fn[i - 1] !== OPS.setDash ||
        fn[i + 1] !== OPS.restore
      )
        continue
      const r = rectPath(args[i]),
        width = args[i - 3]?.[0]
      if (!r || !(width > 0) || !Number.isFinite(width)) continue
      if (!activeMatrices.get(i)?.every((v, n) => v === first.matrix[n])) continue
      const center = matrixRect(r, first.matrix)
      if (!center || !center.every((v, n) => v === frame[n])) continue
      const ink = matrixRect(
          r.map((v, n) => v + (n < 2 ? -width / 2 : width / 2)),
          first.matrix
        ),
        footprint = quantize(ink)
      const graphics = page.graphicsBounds.filter(
        (g) =>
          g.kind === 'path' &&
          g.operationIndex === i &&
          g.normalizedRect.every((v, n) => v === footprint[n])
      )
      if (graphics.length === 1) matches.push(graphics[0])
    }
    if (matches.length !== 1 || owned.has(matches[0])) return
    owned.add(matches[0])
  }
  return owned
}

export function associateFigures(
  page,
  candidates,
  tableRects = [],
  rules = [],
  closedFrames = [],
  nativeTokens = [],
  operatorContext,
  previousProseEvidence
) {
  const marginNumber = nativeFigureMarginPageNumber(page, nativeTokens, candidates, tableRects)
  if (marginNumber) {
    nativeTokens = nativeTokens.filter((token) => token !== marginNumber.token)
    page = { ...page, lines: page.lines.filter((line) => line !== marginNumber.line) }
  }
  const rowPanels = nativeRepeatedRowPanelEvidence(
    page,
    candidates,
    tableRects,
    nativeTokens,
    operatorContext
  )
  const rasterPanels = nativeMultirowRasterPanelEvidence(
    page,
    candidates,
    tableRects,
    nativeTokens,
    operatorContext
  )
  const closedComposites = new Map(
    candidates
      .filter((caption) => caption.page === page.pageNumber)
      .flatMap((caption) => {
        const proof = closedFrameCompositeEvidence(
          page,
          caption,
          candidates,
          tableRects,
          closedFrames,
          nativeTokens,
          operatorContext
        )
        return proof ? [[caption, proof]] : []
      })
  )
  const associated = associateFigureFaces(
    page,
    candidates,
    tableRects,
    rules,
    closedFrames,
    nativeTokens,
    closedComposites,
    operatorContext,
    previousProseEvidence
  )
  if (!associated.length) {
    const recovered = recoverNativePunctuatedRasterCaption(
      page,
      candidates,
      tableRects,
      rules,
      nativeTokens,
      operatorContext
    )
    if (recovered.length) return recovered
  }
  // Completion must use the same independently proved margin-free source as
  // face association, or complete native plot bands can reattach a running head.
  const nativeHead = page.graphicsBounds
    ? nativeFigureRunningHead(
        page,
        candidates.filter((c) => c.page === page.pageNumber),
        nativeTokens,
        rules,
        tableRects
      )
    : undefined
  if (nativeHead) {
    // A merged printed line can span unrelated labels between its two fonts.
    // Remove only the native tokens that proved the running head.
    nativeTokens = nativeTokens.filter((token) => !nativeHead.tokens.includes(token))
    page = {
      ...page,
      lines: page.lines.filter((l) => !nativeHead.lines.includes(l)),
      graphicsBounds: page.graphicsBounds.filter(
        (g) => g !== nativeHead.bar && !nativeHead.decorations.includes(g)
      )
    }
  }
  const partialAxes = page.graphicsBounds?.some((g) => g.kind === 'image')
    ? nativeOpenAxisArray(
        page,
        candidates.filter((c) => c.page === page.pageNumber),
        tableRects,
        rules,
        { includeIncomplete: true }
      )
    : undefined
  const completed = associated.map((figure, figureIndex) => {
    const keyedRasterRow = recoverKeyedNativeRasterRow(
      page,
      figure,
      candidates,
      tableRects,
      nativeTokens
    )
    if (keyedRasterRow)
      return {
        ...figure,
        rect: keyedRasterRow,
        reason: 'native-raster-side-by-side',
        issue: undefined
      }
    const isolatedVector = recoverIsolatedNativeVectorBand(
      page,
      figure,
      candidates,
      tableRects,
      nativeTokens,
      operatorContext
    )
    if (isolatedVector && (!figure.rect || area(figure.rect) > area(isolatedVector) * 3))
      return { ...figure, rect: isolatedVector, reason: undefined, issue: undefined }
    const keyedPlotBand = recoverNativeKeyedPlotBand(
      page,
      figure,
      candidates,
      tableRects,
      rules,
      nativeTokens
    )
    if (keyedPlotBand) return { ...figure, rect: keyedPlotBand, issue: undefined }
    // The panel-row proof has already split the two caption envelopes using
    // independent same-row graphics and a column boundary.  Do not run the
    // later generic completion passes over that bounded result: plot-band
    // completion can mistake the following prose column for the chart and
    // expand the first crop across unrelated body text.
    if (figure.panelRowRecovery) return { ...figure, issue: undefined }
    // Complete native enclosures and their unique directed connectors own
    // every node label. Preserve this whole component before generic padding.
    const connectedNodes = nativeCaptionedConnectedNodes(
      page,
      figure.caption,
      candidates,
      tableRects,
      nativeTokens,
      operatorContext
    )
    if (connectedNodes) return { ...figure, ...connectedNodes, issue: undefined }
    // A complete native form independently owns its keyed top-row legend.
    // Preserve that proved form boundary through final figure completion.
    const finiteTopRowLegend = nativeFiniteTopRowKeyedLegend(
      page,
      figure.caption,
      candidates,
      tableRects,
      nativeTokens,
      figure.rect,
      operatorContext
    )
    if (finiteTopRowLegend) return { ...figure, ...finiteTopRowLegend, issue: undefined }
    // This bounded raster family already proves every whole font and painted
    // carrier. Generic detached-label padding would attach unrelated margin
    // furniture outside its complete native source ownership.
    const pairedRaster = nativeCaptionedPairedRasterGrid(
      page,
      figure.caption,
      candidates.filter((c) => c.page === page.pageNumber),
      tableRects,
      nativeTokens
    )
    if (pairedRaster) return { ...figure, ...pairedRaster, issue: undefined }
    // Prefer complete, independently proved source faces over a matcher that
    // stops at the panel nearest the caption.
    // Completion must preserve the native face's already proved prose exclusion.
    // Original graphics and fonts still establish the whole painted plot extent.
    const plotPage = figure.excludedProseLines?.length
      ? { ...page, lines: page.lines.filter((line) => !figure.excludedProseLines.includes(line)) }
      : page
    const closedPlots = nativeCaptionedPlotBand(
      plotPage,
      figure.caption,
      candidates,
      tableRects,
      rules,
      closedFrames,
      nativeTokens,
      figure.rect,
      operatorContext
    )
    const composite = nativeCaptionedRasterCompositeGrid(
      page,
      figure.caption,
      candidates.filter((c) => c.page === page.pageNumber),
      tableRects,
      nativeTokens
    )
    const outerFrame = closedCaptionFigureFrame(
      page,
      figure.caption,
      candidates.filter((c) => c.page === page.pageNumber),
      tableRects,
      closedFrames
    )
    const rasterFrame =
      outerFrame &&
      figure.rect &&
      intersection(outerFrame.rect, figure.rect) / area(figure.rect) > 0.95 &&
      (page.graphicsBounds ?? []).filter(
        (g) =>
          g.kind === 'image' &&
          area(g.normalizedRect) > 0.001 &&
          intersection(
            outerFrame.rect,
            g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
          ) > 0
      ).length >= 4
        ? outerFrame
        : undefined
    // The mixed native matcher already owns the complete raster/vector plate.
    // A closed-axis subset can add labels, but cannot remove
    // the other panels merely because their frames use a different layout.
    // Quantized mixed bounds can reach into the caption; that is not proof
    // for expanding the more precise closed-axis candidate.
    const completePlots =
      closedPlots &&
      figure.rect &&
      figure.reason === 'native-raster-vector-strip' &&
      figure.rect[3] < figure.caption.rect[1]
        ? { ...closedPlots, rect: union([figure.rect, closedPlots.rect]) }
        : closedPlots
    const complete =
      completePlots ??
      rasterFrame ??
      (composite &&
      figure.rect &&
      !tableRects.some((r) => intersection(r, composite.rect) > 0) &&
      intersection(composite.rect, figure.rect) / area(figure.rect) > 0.95
        ? { ...composite, rect: union([composite.rect, figure.rect]) }
        : undefined)
    if (complete) figure = { ...figure, ...complete, issue: undefined }
    const qualifiedRasterTriple = nativeCaptionedKeyedRasterTriple(
      page,
      figure.caption,
      candidates,
      tableRects,
      nativeTokens,
      operatorContext,
      figure.rect
    )
    if (qualifiedRasterTriple)
      figure = { ...figure, ...qualifiedRasterTriple, issue: undefined, reason: undefined }
    const completePlate =
      qualifiedRasterTriple ??
      nativeCaptionedAlignedRasterPair(
        page,
        figure.caption,
        candidates,
        tableRects,
        associated.filter((other, n) => n !== figureIndex && other.rect).map((other) => other.rect),
        nativeTokens,
        closedFrames,
        operatorContext
      ) ??
      nativeCaptionedRasterFrameBands(page, figure.caption, candidates, tableRects, closedFrames) ??
      nativeCaptionedRasterMapStack(page, figure.caption, candidates, tableRects) ??
      nativeCaptionedRepeatedRasterRows(page, figure.caption, candidates, tableRects) ??
      nativeCaptionedRasterAnswerPlate(page, figure.caption, candidates, tableRects) ??
      nativeCaptionedKeyedHeatmapStack(page, figure.caption, candidates, tableRects) ??
      nativeCaptionedRasterTaskTimeline(page, figure, candidates, tableRects)
    if (completePlate) figure = { ...figure, ...completePlate, issue: undefined }
    // A composite caption can describe several horizontally aligned image
    // panels while the geometry pass assigns only the nearest raster (for
    // example, an ``original / without critic / with critic`` strip). Recover
    // that complete panel band only when the caption and same-row image
    // evidence are both explicit; ordinary single-panel figures keep the
    // existing association unchanged.
    const panelGrid = recoverCaptionedPanelGrid(page, figure, candidates, tableRects)
    if (panelGrid) figure = { ...figure, ...panelGrid }
    // Letter-range captions (for example ``Figure 1A-B``) can own a vertically
    // stacked raster pair even when the ordinary adjacency pass assigns only
    // the panel nearest the caption.  The pair proof is deliberately narrow:
    // two same-width images, one column, no competing caption or table.
    const letteredPair = recoverLetteredRasterPair(page, figure, candidates, tableRects)
    if (letteredPair) figure = { ...figure, ...letteredPair }
    if (figure.rect) {
      const labels = nativeRasterRowLabels(
        page,
        figure.caption,
        candidates,
        tableRects,
        figure.rect,
        nativeTokens
      )
      if (labels.length) figure = { ...figure, rect: union([figure.rect, ...labels.map(lineRect)]) }
    }
    if (figure.rect) {
      const font = Math.max(
        ...page.lines
          .filter((l) => intersection(lineRect(l), figure.caption.rect) > 0)
          .map((l) => l.fontSize)
          .filter((f) => f > 0)
      )
      const frames = closedFrames.filter(
        (r) =>
          intersection(r, figure.rect) / area(r) > 0.8 &&
          r[0] >= figure.rect[0] - font * 2 &&
          r[2] <= figure.rect[2] + font * 2 &&
          r[1] >= figure.rect[1] - font * 2 &&
          r[3] <= Math.min(figure.caption.rect[1], figure.rect[3] + font * 2) &&
          !tableRects.some((t) => intersection(t, r) > 0) &&
          !candidates.some((c) => c.page === page.pageNumber && intersection(c.rect, r) > 0) &&
          (page.graphicsBounds ?? []).some((g) => {
            if (g.kind !== 'image') return false
            const image = (g.paintedNormalizedRect ?? g.normalizedRect).map(
              (v, i) => v * (i % 2 ? page.height : page.width)
            )
            return area(image) >= area(r) * 0.1 && intersection(r, image) / area(image) > 0.85
          })
      )
      if (frames.length) figure = { ...figure, rect: union([figure.rect, ...frames]) }
    }
    // A detached label immediately above a raster is figure content unless a
    // matching distant running header proves it is page furniture.  Keep that
    // label when the independent header witness is absent.
    const topLabel = recoverUnmatchedTopFigureLabel(page, figure)
    if (topLabel) figure = { ...figure, rect: topLabel }
    // Include a closing rule that is painted immediately below a raster frame;
    // the rule is part of the complete source extent, not article furniture.
    const inkExpanded = expandAdjacentFigureInk(page, figure)
    if (inkExpanded) figure = { ...figure, rect: inkExpanded }
    // A vector plot can be mistaken for a graphical table before figure
    // association runs. When that table shadow covers the complete plot, the
    // ordinary table barrier hides every useful path and leaves the caption
    // unresolved. Retry only with a narrowly proved plot-like shadow; this
    // keeps text-only/vector illustrations on the existing no-crop contract.
    if (!figure.rect) {
      const adjacent = recoverIsolatedAdjacentFigure(
        page,
        figure,
        candidates,
        tableRects,
        rules,
        closedFrames,
        nativeTokens
      )
      if (adjacent?.rect) figure = adjacent
    }
    if (!figure.rect) {
      const recovered = recoverGraphicalTableShadowFigure(
        page,
        figure,
        candidates,
        tableRects,
        rules,
        closedFrames,
        nativeTokens
      )
      if (recovered?.rect) figure = recovered
    }
    const attached = nativeAttachedPlotLabels(
      page,
      figure,
      candidates,
      tableRects,
      rules,
      nativeTokens
    )
    const completeBottomLabels = (candidate) => {
      if (!candidate.rect) return candidate
      const panelParagraphs = completeNativePanelParagraphs(
        page,
        candidate,
        candidates,
        tableRects,
        nativeTokens
      )
      if (panelParagraphs) candidate = { ...candidate, rect: panelParagraphs }
      candidate = excludeOwnedFigurePriorProse(
        page,
        candidate,
        candidates,
        tableRects,
        nativeTokens,
        operatorContext
      )
      const stem = nativeOwnedTimelineStroke(page, candidate, candidates, tableRects, rules)
      if (stem) candidate = { ...candidate, rect: stem }
      const formPaint = nativeOwnedFormPaintBounds(
        page,
        candidate.caption,
        candidates,
        tableRects,
        candidate.rect,
        operatorContext
      )
      if (formPaint) candidate = { ...candidate, rect: formPaint }
      const rowHeadings = recoverCenteredRasterRowHeadings(
        page,
        candidate,
        candidates,
        tableRects,
        nativeTokens
      )
      if (rowHeadings) candidate = { ...candidate, rect: rowHeadings }
      const foreignOwns = (r) =>
        associated.some(
          (other, n) => n !== figureIndex && other.rect && intersection(other.rect, r) > 0
        )
      const frameTitles = nativeRasterClosedFrameTitles(
        page,
        candidate,
        candidates,
        tableRects,
        closedFrames,
        nativeTokens,
        foreignOwns,
        operatorContext
      )
      if (frameTitles) candidate = { ...candidate, rect: frameTitles }
      const rasterLabels = nativeOwnedRasterColumnHeadings(
        page,
        candidate,
        candidates,
        tableRects,
        nativeTokens,
        foreignOwns,
        operatorContext
      )
      const labels =
        rasterLabels?.rects ??
        nativeOwnedRasterTitleRows(
          page,
          candidate.caption,
          candidates,
          tableRects,
          candidate.rect,
          nativeTokens,
          foreignOwns,
          operatorContext
        ) ??
        nativeOwnedFigureBottomLabels(
          page,
          candidate.caption,
          candidates,
          tableRects,
          candidate.rect,
          closedFrames,
          nativeTokens,
          foreignOwns
        )
      const title = nativeOwnedFigureTopLabel(
        page,
        candidate.caption,
        candidates,
        tableRects,
        candidate.rect,
        nativeTokens
      )
      candidate =
        labels.length || title
          ? { ...candidate, rect: union([candidate.rect, ...labels, ...(title ? [title] : [])]) }
          : candidate
      if (rasterLabels?.sourceItems?.length) {
        const existing = candidate.sourceItems ?? []
        if (
          rasterLabels.sourceItems.every(
            (source) =>
              !existing.some(
                (old) =>
                  old.pageNumber === source.pageNumber &&
                  old.index === source.index &&
                  old.text !== source.text
              )
          )
        )
          candidate = {
            ...candidate,
            sourceItems: [
              ...existing,
              ...rasterLabels.sourceItems.filter(
                (source) =>
                  !existing.some(
                    (old) => old.pageNumber === source.pageNumber && old.index === source.index
                  )
              )
            ].sort((a, b) => a.pageNumber - b.pageNumber || a.index - b.index)
          }
      }
      const maskedPlot = nativeMaskedPlotBounds(
        page,
        candidate,
        candidates,
        tableRects,
        closedFrames,
        rules,
        operatorContext
      )
      if (maskedPlot) candidate = { ...candidate, rect: maskedPlot }
      const annotation = nativeOwnedAnnotationFrame(
        page,
        candidate,
        candidates,
        tableRects,
        closedFrames,
        nativeTokens,
        (r) =>
          associated.some(
            (other, n) => n !== figureIndex && other.rect && intersection(other.rect, r) > 0
          )
      )
      return annotation ? { ...candidate, rect: annotation } : candidate
    }
    // A long listing can contain hundreds of stroked glyphs. It looks like a
    // large connected drawing to the geometry pass, but it is not a figure
    // and must not be published as one. Require a substantial image/path
    // plate before accepting a text-dominant result.
    if (attached.rect && isTextDominantFigure(page, attached, candidates))
      return { ...attached, rect: undefined, issue: 'text-dominant-graphics' }
    if (!attached.rect && isTextDominantPage(page, candidates))
      return { ...attached, issue: 'text-dominant-graphics' }
    if (attached.rect) {
      // A lower raster that has its own following caption cannot belong to an
      // unresolved upper vector figure. Preserve no-crop rather than lending
      // the neighboring figure to both captions.
      const next = associated.find(
        (other) =>
          other.caption !== attached.caption &&
          other.caption.rect[1] > attached.caption.rect[3] &&
          attached.rect[3] <= other.caption.rect[1] &&
          Math.min(other.caption.rect[2], attached.rect[2]) -
            Math.max(other.caption.rect[0], attached.rect[0]) >
            (attached.rect[2] - attached.rect[0]) * 0.5
      )
      if (
        attached.rect[1] >= attached.caption.rect[3] &&
        next &&
        (page.graphicsBounds ?? []).some((g) => {
          const rect = figureGraphicRect(page, g)
          return (
            (g.kind === 'path' ||
              (g.kind === 'image' &&
                g.paintedNormalizedRect &&
                !g.imageHash &&
                area(rect ?? []) >= page.width * page.height * 0.02)) &&
            rect &&
            rect[3] <= attached.caption.rect[1] &&
            attached.caption.rect[1] - rect[3] <= 120 &&
            rect[2] - rect[0] > page.width * 0.15 &&
            Math.min(rect[2], attached.caption.rect[2]) >
              Math.max(rect[0], attached.caption.rect[0])
          )
        })
      )
        return { ...attached, rect: undefined, issue: 'no-unambiguous-adjacent-graphics' }
      return completeBottomLabels(attached)
    }
    const recovered = recoverConservativeFigureRect(page, attached, tableRects, candidates)
    return recovered
      ? completeBottomLabels({ ...attached, rect: recovered, issue: undefined })
      : attached
  })
  // Generic association sees painted interiors, which need not reach the axes.
  // Preserve the independently proved vector face while completing its raster.
  return completed
    .map((figure) => {
      if (
        rowPanels?.caption === figure.caption &&
        figure.rect &&
        figure.rect.every((n, i) =>
          i < 2
            ? n >= rowPanels.bounds[i] - Math.max(page.width, page.height) / 128
            : n <= rowPanels.bounds[i] + Math.max(page.width, page.height) / 128
        ) &&
        rowPanels.accepts(rowPanels.bounds)
      )
        return { ...figure, rect: rowPanels.bounds, graphicsCount: rowPanels.graphicsCount }
      if (rasterPanels?.caption === figure.caption && figure.rect) {
        const expanded = union([figure.rect, rasterPanels.bounds])
        // A partial face need not own its added area. Revalidate the complete
        // final envelope before retaining any separately proved raster panel.
        return rasterPanels.accepts(expanded)
          ? {
              ...figure,
              rect: expanded,
              graphicsCount: rasterPanels.graphicsCount,
              sourceItems: rasterPanels.ownedSourceItems
            }
          : figure
      }
      const composite = closedComposites.get(figure.caption)
      if (composite && figure.rect) {
        const expanded = union([figure.rect, composite.bound])
        return composite.accepts(expanded)
          ? { ...figure, rect: expanded, sourceItems: composite.ownedSourceItems }
          : { ...figure, rect: composite.closed.rect }
      }
      if (
        !partialAxes?.requiresCompleteAssociation ||
        figure.caption !== partialAxes.caption ||
        !figure.rect
      )
        return figure
      const expanded = union([figure.rect, partialAxes.rect])
      // Generic completion may reach past the local raster into another region.
      // No text owner is proved for that added area, so retain the native vector
      // crop when it would add a table or readable alphabetic content.
      const addsIndependentContent =
        tableRects.some((t) => intersection(t, expanded) > 0) ||
        page.lines.some(
          (l) =>
            /\p{L}/u.test(l.text) &&
            intersection(lineRect(l), expanded) > intersection(lineRect(l), partialAxes.rect)
        )
      return { ...figure, rect: addsIndependentContent ? partialAxes.rect : expanded }
    })
    .map((figure, _index, figures) => {
      if (figures.length !== 1) return figure
      const form = nativeRasterFormEnvelope(
        page,
        figure,
        candidates,
        tableRects,
        nativeTokens,
        operatorContext
      )
      return form ? { ...figure, ...form, issue: undefined } : figure
    })
    .map((figure, index, figures) => {
      const band =
        nativeCaptionedLabeledRasterStack(
          page,
          figure.caption,
          candidates,
          tableRects,
          operatorContext,
          figure
        ) ??
        nativeCaptionedRasterBand(
          page,
          figure.caption,
          candidates,
          tableRects,
          operatorContext,
          figure
        )
      if (
        !band ||
        figures.some(
          (other, i) => i !== index && other.rect && intersection(other.rect, band.rect) > 0
        )
      )
        return figure
      return band
    })
    .map((figure) => {
      if (figure.rect) return figure
      const intervals = nativeCaptionedIntervalRows(
        page,
        figure.caption,
        candidates,
        tableRects,
        nativeTokens,
        operatorContext,
        figure
      )
      return intervals ? { ...figure, ...intervals } : figure
    })
    .map((figure) => {
      if (figure.rect) return figure
      const cycle = nativeCaptionedOpenCycle(
        page,
        figure.caption,
        candidates,
        tableRects,
        nativeTokens,
        operatorContext,
        figure
      )
      return cycle ? { ...figure, ...cycle } : figure
    })
    .map((figure, index, figures) => {
      const axis = nativeAxisTitlePacket(
        page,
        figure,
        candidates,
        tableRects,
        rules,
        nativeTokens,
        operatorContext,
        (r) =>
          figures.some((other, i) => i !== index && other.rect && intersection(other.rect, r) > 0)
      )
      return axis ? { ...figure, rect: axis.rect } : figure
    })
    .map((figure, index, figures) => {
      const proof = nativeFormPlotEvidence(
        page,
        figure,
        candidates,
        tableRects,
        nativeTokens,
        operatorContext
      )
      if (
        !proof ||
        figures.some(
          (other, n) => n !== index && other.rect && intersection(other.rect, proof.rect) > 0
        )
      )
        return figure
      const result = {
        ...figure,
        rect: proof.rect,
        excludedProseLines: [
          ...(figure.excludedProseLines ?? []),
          ...nativeFormPlotExcludedProse(page, proof.rect, nativeTokens)
        ]
      }
      const existing = figure.sourceItems ?? []
      if (
        proof.sourceItems?.length &&
        proof.sourceItems.every(
          (source) =>
            !existing.some(
              (old) =>
                old.pageNumber === source.pageNumber &&
                old.index === source.index &&
                old.text !== source.text
            )
        )
      )
        result.sourceItems = [
          ...existing,
          ...proof.sourceItems.filter(
            (source) =>
              !existing.some(
                (old) => old.pageNumber === source.pageNumber && old.index === source.index
              )
          )
        ].sort((a, b) => a.pageNumber - b.pageNumber || a.index - b.index)
      return result
    })
    .map((figure, index, figures) => {
      for (const prove of [nativeMatrixFigureScope, nativeClosedNodeSources]) {
        const proof = prove(page, figure, candidates, tableRects, nativeTokens, operatorContext)
        if (
          proof &&
          !figures.some(
            (other, n) => n !== index && other.rect && intersection(other.rect, proof.rect) > 0
          )
        )
          figure = { ...figure, ...proof }
      }
      const nodeLabels = nativeNodeFigureLabels(
        page,
        figure,
        candidates,
        tableRects,
        closedFrames,
        nativeTokens,
        operatorContext
      )
      if (
        nodeLabels &&
        !figures.some(
          (other, n) => n !== index && other.rect && intersection(other.rect, nodeLabels.rect) > 0
        )
      )
        figure = { ...figure, ...nodeLabels }
      const braceLabel = nativeBraceFigureLabel(
        page,
        figure,
        candidates,
        tableRects,
        nativeTokens,
        operatorContext
      )
      if (
        braceLabel &&
        !figures.some(
          (other, n) => n !== index && other.rect && intersection(other.rect, braceLabel.rect) > 0
        )
      )
        figure = { ...figure, ...braceLabel }
      if (!figure.sourceItems?.length) return figure
      // Other figures may complete their boundaries in the same pass. Publish
      // text ownership only after those final crops are available, and only for
      // whole original fonts retained by this crop with no competing owner.
      const fonts = nativeTokens.filter((token) =>
        figure.sourceItems.some(
          (source) =>
            token.sourceItem?.pageNumber === source.pageNumber &&
            token.sourceItem?.index === source.index &&
            token.text === source.text
        )
      )
      const ambiguous =
        fonts.length !== figure.sourceItems.length ||
        fonts.some(
          (token) =>
            token.rect.some((v, n) => (n < 2 ? v < figure.rect[n] : v > figure.rect[n])) ||
            tableRects.some((r) => intersection(r, token.rect) > 0) ||
            candidates.some(
              (c) => c.page === page.pageNumber && intersection(c.rect, token.rect) > 0
            ) ||
            figures.some(
              (other, n) => n !== index && other.rect && intersection(other.rect, token.rect) > 0
            )
        )
      if (!ambiguous) return figure
      const retained = { ...figure }
      delete retained.sourceItems
      return retained
    })
}

function recoverCaptionedPanelGrid(page, figure, candidates, tableRects) {
  const caption = figure?.caption
  if (!caption || !figure?.rect || !page.graphicsBounds?.length) return undefined
  const captionText = caption.lines?.join(' ') ?? ''
  const priorCaptionBottom = Math.max(
    0,
    ...candidates
      .filter(
        (candidate) =>
          candidate !== caption &&
          candidate.page === caption.page &&
          candidate.rect[3] < caption.rect[1]
      )
      .map((candidate) => candidate.rect[3])
  )
  const panelKeys = new Set(
    [...captionText.matchAll(/(?:^|\s)\(([a-z])\)/gi)].map((match) => match[1].toLowerCase())
  )
  const panelTitleEvidence = page.lines?.some(
    (line) =>
      line.y < caption.rect[1] &&
      line.y > priorCaptionBottom &&
      /\boriginal\b/i.test(line.text) &&
      /\bwithout\b/i.test(line.text) &&
      /\bwith\b/i.test(line.text) &&
      line.width >= page.width * 0.35
  )
  // Require at least three explicitly named panels. This avoids widening
  // captions that merely mention one parenthetical citation or metric.
  if (panelKeys.size < 3 && !panelTitleEvidence) return undefined
  const areaOf = (rect) => Math.max(0, rect[2] - rect[0]) * Math.max(0, rect[3] - rect[1])
  const toRect = (graphic) =>
    (graphic.paintedNormalizedRect ?? graphic.normalizedRect).map(
      (value, index) => value * (index % 2 ? page.height : page.width)
    )
  const graphics = page.graphicsBounds
    .filter((graphic) => {
      const source = graphic.paintedNormalizedRect ?? graphic.normalizedRect
      return source?.length === 4 && source.every(Number.isFinite)
    })
    .map((graphic) => ({ ...graphic, rect: toRect(graphic) }))
  const pageArea = page.width * page.height
  const hasCompetingCaption = (rect) =>
    candidates.some(
      (candidate) =>
        candidate !== caption &&
        candidate.page === caption.page &&
        intersection(candidate.rect, rect) > 0
    ) || tableRects.some((table) => intersection(table, rect) / Math.max(1, areaOf(rect)) > 0.2)

  // Prefer a same-row image strip. The row tolerance includes the small
  // palette/key below a panel without absorbing the following prose.
  const images = graphics.filter(
    (graphic) => graphic.kind === 'image' && areaOf(graphic.rect) >= pageArea * 0.004
  )
  const rows = []
  for (const image of images) {
    const existing = rows.find(
      (row) =>
        Math.min(row.bottom, image.rect[3]) - Math.max(row.top, image.rect[1]) >=
        Math.min(row.bottom - row.top, image.rect[3] - image.rect[1]) * 0.5
    )
    if (existing) {
      existing.items.push(image)
      existing.top = Math.min(existing.top, image.rect[1])
      existing.bottom = Math.max(existing.bottom, image.rect[3])
    } else rows.push({ top: image.rect[1], bottom: image.rect[3], items: [image] })
  }
  const current = figure.rect
  const row = rows
    .filter((candidate) => candidate.items.length >= 3)
    .map((candidate) => {
      const ordered = candidate.items.slice().sort((a, b) => a.rect[0] - b.rect[0])
      const distinctColumns = ordered.filter(
        (item, index) => index === 0 || item.rect[0] - ordered[index - 1].rect[2] > 4
      ).length
      const bounds = union(ordered.map((item) => item.rect))
      const widths = ordered.map((item) => item.rect[2] - item.rect[0])
      const heights = ordered.map((item) => item.rect[3] - item.rect[1])
      return {
        ...candidate,
        bounds,
        distinctColumns,
        uniform:
          Math.max(...widths) <= Math.min(...widths) * 1.35 &&
          Math.max(...heights) <= Math.min(...heights) * 1.35,
        distance: Math.abs(bounds[3] - current[3]) + Math.abs(bounds[1] - current[1])
      }
    })
    .filter(
      (candidate) =>
        candidate.distinctColumns >= 3 &&
        candidate.uniform &&
        candidate.bounds[3] < caption.rect[1] &&
        candidate.bounds[1] > priorCaptionBottom &&
        intersection(
          [candidate.bounds[0], candidate.bounds[1], candidate.bounds[2], candidate.bounds[3] + 32],
          current
        ) > 0
    )
    .sort((a, b) => a.distance - b.distance)[0]
  if (row) {
    const rowBand = [row.bounds[0] - 8, row.bounds[1] - 8, row.bounds[2] + 8, row.bounds[3] + 32]
    const joined = graphics.filter(
      (graphic) =>
        graphic.rect[1] >= rowBand[1] &&
        graphic.rect[3] <= rowBand[3] &&
        graphic.rect[0] < rowBand[2] &&
        graphic.rect[2] > rowBand[0] &&
        !hasCompetingCaption(graphic.rect)
    )
    const titleLine = page.lines
      ?.filter(
        (line) =>
          line.y < row.top &&
          line.y > priorCaptionBottom &&
          row.top - line.y <= Math.max(64, page.height * 0.09) &&
          line.width >= page.width * 0.35 &&
          (/\boriginal\b.*\bwithout\b.*\bwith\b/i.test(line.text) || /\([a-z]\)/i.test(line.text))
      )
      .sort((a, b) => b.y - a.y)[0]
    const rect = union([
      ...joined.map((graphic) => graphic.rect),
      ...(titleLine
        ? [
            [
              titleLine.x,
              titleLine.y - 2,
              titleLine.x + titleLine.width,
              titleLine.y + titleLine.height + 2
            ]
          ]
        : [])
    ])
    if (areaOf(rect) > areaOf(current) * 1.5 && rect[3] <= caption.rect[1] + 4)
      return { rect, graphicsCount: joined.length, issue: undefined }
  }

  // Some composite figures are arranged as three tall columns instead of a
  // single image row. A broad enclosing vector frame is strong ownership
  // evidence; clip it at the caption so its bottom stroke cannot pull prose
  // into the crop.
  const frames = graphics
    .filter(
      (graphic) =>
        graphic.kind === 'path' &&
        graphic.rect[2] - graphic.rect[0] >= page.width * 0.6 &&
        graphic.rect[3] - graphic.rect[1] >= page.height * 0.3 &&
        graphic.rect[1] < caption.rect[1] &&
        graphic.rect[1] > priorCaptionBottom &&
        graphic.rect[3] <= caption.rect[1] + 16 &&
        graphic.rect[0] <= caption.rect[0] + 12 &&
        graphic.rect[2] >= caption.rect[2] - 12 &&
        !candidates.some(
          (candidate) =>
            candidate !== caption &&
            candidate.page === caption.page &&
            intersection(candidate.rect, graphic.rect) > 0
        )
    )
    .map((frame) => {
      const inside = images.filter(
        (image) => intersection(frame.rect, image.rect) / Math.max(1, areaOf(image.rect)) > 0.95
      )
      const columns = new Set(
        inside
          .map((image) => Math.round((image.rect[0] / Math.max(1, page.width)) * 20))
          .sort((a, b) => a - b)
      )
      return { frame, inside, columns }
    })
    .filter((candidate) => candidate.inside.length >= 3 && candidate.columns.size >= 3)
    .sort((a, b) => areaOf(b.frame.rect) - areaOf(a.frame.rect))
  const frame = frames[0]?.frame
  if (!frame || hasCompetingCaption(frame.rect)) return undefined
  const rect = [...frame.rect]
  if (rect[3] >= caption.rect[1]) rect[3] = Math.max(rect[1], caption.rect[1] - 1)
  if (areaOf(rect) <= areaOf(current) * 1.5) return undefined
  return {
    rect,
    graphicsCount: frames[0].inside.length,
    issue: undefined
  }
}

// Separate native panel labels bind a short centered caption to the complete
// image row. Earlier images elsewhere on the page cannot consume this owner.
function recoverKeyedNativeRasterRow(page, figure, candidates, tableRects, tokens) {
  const caption = figure?.caption
  if (figure.rect || !caption || page.invalidGraphicsBounds || !tokens.length) return
  const labels = tokens
    .filter(
      (t) =>
        t.horizontal &&
        /^\([a-b]\)\s+\S/u.test(t.text) &&
        t.rect?.every(Number.isFinite) &&
        t.rect[3] <= caption.rect[1] &&
        caption.rect[1] - t.rect[3] <= t.height * 2
    )
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (
    labels.length !== 2 ||
    !labels[0].text.startsWith('(a)') ||
    !labels[1].text.startsWith('(b)') ||
    labels.some(
      (t) => !Number.isFinite(t.fontDescent) || t.fontDescent > 0 || t.fontDescent < -1
    ) ||
    Math.abs(labels[0].baseline - labels[1].baseline) >
      Math.min(...labels.map((t) => t.height)) * 0.2
  )
    return
  const font = Math.max(...labels.map((t) => t.height))
  const images = (page.graphicsBounds ?? [])
    .filter((g) => g.kind === 'image' && g.imageHash)
    .map((g) =>
      (g.paintedNormalizedRect ?? g.normalizedRect).map(
        (v, n) => v * (n % 2 ? page.height : page.width)
      )
    )
    .filter(
      (r) =>
        r.every(Number.isFinite) &&
        r[2] - r[0] > font * 8 &&
        r[3] - r[1] > font * 6 &&
        r[3] <= labels[0].rect[1] + font &&
        labels[0].rect[1] - r[3] < font * 2
    )
    .sort((a, b) => a[0] - b[0])
  if (
    images.length !== 2 ||
    images[0][2] >= images[1][0] ||
    Math.abs(images[0][1] - images[1][1]) > font ||
    Math.abs(images[0][3] - images[1][3]) > font ||
    labels.some(
      (t, n) =>
        t.rect[0] < images[n][0] ||
        t.rect[2] > images[n][2] ||
        Math.abs((t.rect[0] + t.rect[2] - images[n][0] - images[n][2]) / 2) > font * 2
    )
  )
    return
  const rect = union([
    ...images,
    ...labels.map((t) => [t.rect[0], t.rect[1], t.rect[2], t.rect[3] - t.fontDescent * t.height])
  ])
  const corridor = [rect[0], rect[1], rect[2], caption.rect[1]]
  if (
    rect[0] < 0 ||
    rect[1] < 0 ||
    rect[2] > page.width ||
    rect[3] > caption.rect[1] ||
    Math.abs((caption.rect[0] + caption.rect[2] - rect[0] - rect[2]) / 2) > font * 2 ||
    candidates.some(
      (c) => c.page === page.pageNumber && c !== caption && intersection(c.rect, corridor) > 0
    ) ||
    tableRects.some((r) => intersection(r, corridor) > 0) ||
    tokens.some(
      (t) =>
        t.text?.trim() &&
        intersection(t.rect, corridor) > 0 &&
        !labels.includes(t) &&
        !images.some((r) => intersection(r, t.rect) / area(t.rect) > 0.99)
    )
  )
    return
  return rect
}

// Conservative native paint envelopes resolve quantized boundary spill only.
// Ignore clipping here: an unclipped envelope is a safe superset, so a path
// whose ownership depends on its clip prevents this recovery.
function nativePathPaintEnvelopes(context) {
  const { operators: o, viewport: v } = context ?? {}
  const numbers = (a, n) =>
    (Array.isArray(a) || ArrayBuffer.isView(a)) && a.length === n && a.every(Number.isFinite)
  if (
    !numbers(v?.transform, 6) ||
    !Array.isArray(o?.fnArray) ||
    !Array.isArray(o.argsArray) ||
    o.fnArray.length !== o.argsArray.length
  )
    return
  let state = { matrix: [1, 0, 0, 1, 0, 0], width: 1, join: 0, miter: 10 }
  const stack = [],
    paints = []
  for (let i = 0; i < o.fnArray.length; i++) {
    const op = o.fnArray[i],
      a = o.argsArray[i]
    if (op === OPS.save || op === OPS.paintFormXObjectBegin) {
      stack.push(structuredClone(state))
      if (op === OPS.paintFormXObjectBegin && a?.[0]) {
        if (!numbers(a[0], 6)) return
        state.matrix = Util.transform(state.matrix, a[0])
      }
    } else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
      if (!stack.length) return
      state = stack.pop()
    } else if (op === OPS.transform) {
      if (!numbers(a, 6)) return
      state.matrix = Util.transform(state.matrix, a)
    } else if (op === OPS.setLineWidth) state.width = a?.[0]
    else if (op === OPS.setLineJoin) state.join = a?.[0]
    else if (op === OPS.setMiterLimit) state.miter = a?.[0]
    else if (op === OPS.setGState) {
      if (!Array.isArray(a?.[0])) return
      for (const [key, value] of a[0]) {
        if (key === 'LW') state.width = value
        else if (key === 'LJ') state.join = value
        else if (key === 'ML') state.miter = value
      }
    } else if (op === OPS.constructPath && a?.[0] !== OPS.endPath) {
      const filled = [OPS.fill, OPS.eoFill].includes(a?.[0])
      if (
        !filled &&
        ![
          OPS.stroke,
          OPS.closeStroke,
          OPS.fillStroke,
          OPS.eoFillStroke,
          OPS.closeFillStroke,
          OPS.closeEOFillStroke
        ].includes(a?.[0])
      )
        return
      if (!numbers(a?.[2], 4) || a[2][0] > a[2][2] || a[2][1] > a[2][3]) return
      const b = a[2],
        matrix = Util.transform(v.transform, state.matrix)
      if (!matrix.every(Number.isFinite)) return
      const points = [
        [b[0], b[1]],
        [b[2], b[1]],
        [b[2], b[3]],
        [b[0], b[3]]
      ]
      for (const point of points) Util.applyTransform(point, matrix)
      let pad = 0
      if (!filled) {
        if (
          !Number.isFinite(state.width) ||
          state.width < 0 ||
          ![0, 1, 2].includes(state.join) ||
          !Number.isFinite(state.miter) ||
          state.miter < 1
        )
          return
        // A full stroke width also covers square/round end caps. Miter joins
        // use their native limit; hairlines retain a conservative page pixel.
        pad =
          Math.max(1e-3, state.width) *
          (state.join === 0 ? state.miter : 1) *
          Math.max(Math.hypot(matrix[0], matrix[2]), Math.hypot(matrix[1], matrix[3]))
        if (state.width === 0) pad = Math.max(pad, 1)
      }
      const rect = [
        Math.min(...points.map((p) => p[0])) - pad,
        Math.min(...points.map((p) => p[1])) - pad,
        Math.max(...points.map((p) => p[0])) + pad,
        Math.max(...points.map((p) => p[1])) + pad
      ]
      if (!rect.every(Number.isFinite)) return
      paints.push(rect)
    }
  }
  if (stack.length) return
  return paints
}

function recoverIsolatedNativeVectorBand(page, figure, candidates, tables, tokens, context) {
  const caption = figure.caption
  if (!caption || page.invalidGraphicsBounds || !tokens.length) return
  const captionFonts = tokens.filter(
    (t) => t.horizontal && intersection(t.rect, caption.rect) / area(t.rect) > 0.95
  )
  const font = Math.max(...captionFonts.map((t) => t.height))
  const width = caption.rect[2] - caption.rect[0]
  if (!Number.isFinite(font) || width < font * 12 || width > page.width * 0.5) return
  const lane = [
    Math.max(0, caption.rect[0] - font * 4),
    0,
    Math.min(page.width, caption.rect[2] + font * 4),
    caption.rect[1]
  ]
  const columns = page.lines.filter(
    (l) => l.y < caption.rect[1] && l.width > width * 0.6 && l.text.length >= 45
  )
  const leftColumns = columns.filter((l) => l.x + l.width <= caption.rect[0])
  const rightColumns = columns.filter((l) => l.x >= caption.rect[2])
  if (leftColumns.length >= 3)
    lane[0] = Math.max(0, Math.max(...leftColumns.map((l) => l.x + l.width)) + font * 0.5)
  if (rightColumns.length >= 3)
    lane[2] = Math.min(lane[2], Math.min(...rightColumns.map((l) => l.x)) - font * 0.5)
  const prose = page.lines.filter(
    (l) =>
      l.y + l.height < caption.rect[1] &&
      l.width > width * 0.6 &&
      l.text.trim().split(/\s+/u).length >= 7 &&
      l.fontSize >= font * 0.9 &&
      Math.min(l.x + l.width, caption.rect[2]) - Math.max(l.x, caption.rect[0]) > width * 0.5
  )
  lane[1] = Math.max(page.height * 0.04, ...prose.map((l) => l.y + l.height))
  const all = (page.graphicsBounds ?? []).map((g) => ({
    g,
    rect: (g.paintedNormalizedRect ?? g.normalizedRect).map(
      (v, n) => v * (n % 2 ? page.height : page.width)
    )
  }))
  const local = all.filter(({ rect }) => intersection(rect, lane) > 0)
  const outside = (r) => r.some((v, n) => (n < 2 ? v < lane[n] : v > lane[n]))
  if (local.some(({ rect }) => outside(rect))) {
    const native = nativePathPaintEnvelopes(context)
    if (!native) return
    for (const item of local.filter(({ rect }) => outside(rect))) {
      if (item.g.kind !== 'path') return
      const related = native.filter((r) => intersection(r, item.rect) > 0)
      const quantum = [page.width / 256, page.height / 256]
      if (
        !related.length ||
        related.some(outside) ||
        !related.some((r) => r.every((v, n) => Math.abs(v - item.rect[n]) <= quantum[n % 2] * 2))
      )
        return
      item.rect = union(related)
    }
  }
  if (
    local.length < 5 ||
    local.some(
      ({ g, rect }) =>
        g.kind !== 'path' ||
        area(rect) <= 0 ||
        rect.some((v, n) => (n < 2 ? v < lane[n] : v > lane[n]))
    )
  )
    return
  const paths = local.map(({ rect }) => rect)
  const bounds = union(paths)
  if (
    bounds[2] - bounds[0] < font * 5 ||
    bounds[3] - bounds[1] < font ||
    caption.rect[1] - bounds[3] > page.height * 0.2
  )
    return
  const labels = tokens.filter(
    (t) =>
      t.text?.trim() &&
      t.rect?.every(Number.isFinite) &&
      t.rect[0] >= lane[0] &&
      t.rect[2] <= lane[2] &&
      t.rect[1] >= Math.max(lane[1], bounds[1] - font * 2) &&
      t.rect[3] <= caption.rect[1]
  )
  if (
    labels.length < 2 ||
    labels.some(
      (t) =>
        t.height > font * 1.5 ||
        !Number.isFinite(t.fontDescent) ||
        t.fontDescent > 0 ||
        t.fontDescent < -1 ||
        t.text.trim().split(/\s+/u).length > 12
    )
  )
    return
  const rect = union([
    bounds,
    ...labels.map((t) => [t.rect[0], t.rect[1], t.rect[2], t.rect[3] - t.fontDescent * t.height])
  ])
  if (
    rect[3] >= caption.rect[1] ||
    tables.some((r) => intersection(r, rect) > 0) ||
    candidates.some(
      (c) => c !== caption && c.page === caption.page && intersection(c.rect, lane) > 0
    ) ||
    tokens.some((t) => t.text?.trim() && intersection(t.rect, rect) > 0 && !labels.includes(t))
  )
    return
  return rect
}

// A complete, caption-wide keyed plate owns every native source above its
// caption. Requiring all consecutive panel keys and an isolated text/axis
// band avoids extending a local chart into neighboring article prose.
function recoverNativeKeyedPlotBand(page, figure, candidates, tables, rules, tokens) {
  const { rect, caption } = figure
  if (
    !rect ||
    !caption ||
    page.invalidGraphicsBounds ||
    !tokens.length ||
    rules.length < 8 ||
    caption.rect[2] - caption.rect[0] < page.width * 0.7 ||
    caption.rect[1] > page.height * 0.6
  )
    return
  const font = Math.max(
    ...tokens
      .filter((t) => intersection(t.rect, caption.rect) / area(t.rect) > 0.95)
      .map((t) => t.height)
  )
  if (!Number.isFinite(font)) return
  const native = tokens.filter(
    (t) => t.text?.trim() && t.rect[1] >= page.height * 0.04 && t.rect[3] < caption.rect[1]
  )
  const keys = native.filter((t) => t.horizontal && /^(?:[a-h]|\([a-h]\))(?:\s|$)/u.test(t.text))
  const letters = keys
    .map((t) => t.text.match(/[a-h]/u)[0])
    .sort()
    .join('')
  if (
    keys.length < 3 ||
    keys.length > 8 ||
    letters !== 'abcdefgh'.slice(0, keys.length) ||
    keys.some((t) => t.height > font * 1.2 || Math.abs(t.height - keys[0].height) > font * 0.2)
  )
    return
  if (
    native.some(
      (t) =>
        !t.rect.every(Number.isFinite) ||
        !Number.isFinite(t.fontDescent) ||
        t.fontDescent > 0 ||
        t.fontDescent < -1 ||
        t.height > font * 1.4 ||
        t.text.length > 100
    ) ||
    page.lines.some(
      (l) =>
        l.y >= page.height * 0.04 &&
        l.y + l.height < caption.rect[1] &&
        l.text.trim().split(/\s+/u).length > 16
    )
  )
    return
  const graphics = (page.graphicsBounds ?? [])
    .map((g) =>
      (g.paintedNormalizedRect ?? g.normalizedRect).map(
        (v, n) => v * (n % 2 ? page.height : page.width)
      )
    )
    .filter((r) => r[1] >= page.height * 0.04 && r[3] < caption.rect[1])
  if (
    graphics.length < 12 ||
    keys.some(
      (key) =>
        !graphics.some(
          (r) =>
            r[2] > key.rect[0] &&
            r[0] < key.rect[2] + font * 6 &&
            r[1] >= key.rect[1] - font &&
            r[1] < key.rect[3] + font * 3
        )
    )
  )
    return
  const expanded = union([
    ...graphics,
    ...native.map((t) => [
      t.rect[0],
      t.rect[1],
      t.rect[2],
      t.rect[3] - (t.horizontal ? t.fontDescent * t.height : 0)
    ])
  ])
  if (
    expanded[0] < 0 ||
    expanded[1] < 0 ||
    expanded[2] > page.width ||
    expanded[3] >= caption.rect[1] ||
    intersection(expanded, rect) / area(rect) < 0.9 ||
    tables.some((r) => intersection(r, expanded) > 0) ||
    candidates.some(
      (c) => c !== caption && c.page === caption.page && intersection(c.rect, expanded) > 0
    )
  )
    return
  // Preserve a complete source-proved plate even when it needs no expansion:
  // later local plot matching can otherwise select only one of its panels.
  return expanded
}

function recoverCenteredRasterRowHeadings(page, figure, candidates, tables, tokens) {
  const { rect, caption } = figure
  if (!rect || page.invalidGraphicsBounds || !tokens.length) return
  const images = (page.graphicsBounds ?? [])
    .filter((g) => g.kind === 'image' && g.imageHash)
    .map((g) =>
      (g.paintedNormalizedRect ?? g.normalizedRect).map(
        (v, n) => v * (n % 2 ? page.height : page.width)
      )
    )
    .filter((r) => area(r) > 0 && intersection(r, rect) / area(r) > 0.99)
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])
  const rows = []
  for (const image of images) {
    const row = rows.find((r) => Math.abs(r[0][1] - image[1]) <= page.height / 256)
    if (row) row.push(image)
    else rows.push([image])
  }
  if (
    rows.length < 2 ||
    rows.length > 6 ||
    rows[0].length < 2 ||
    rows.some((r) => r.length !== rows[0].length)
  )
    return
  for (const row of rows) row.sort((a, b) => a[0] - b[0])
  if (
    rows.some((row) =>
      row.some(
        (r, i) =>
          Math.abs(r[0] - rows[0][i][0]) > page.width / 256 ||
          Math.abs(r[2] - rows[0][i][2]) > page.width / 256 ||
          Math.abs(r[3] - row[0][3]) > page.height / 256
      )
    )
  )
    return
  const headings = []
  for (const row of rows) {
    const bounds = union(row)
    const local = tokens.filter(
      (t) =>
        t.horizontal &&
        t.height > 0 &&
        t.rect?.every(Number.isFinite) &&
        Number.isFinite(t.fontDescent) &&
        t.fontDescent >= -1 &&
        t.fontDescent <= 0 &&
        /^\p{L}/u.test(t.text) &&
        !/[.!?:]$/u.test(t.text.trim()) &&
        t.text.length <= 100 &&
        t.rect[0] >= bounds[0] &&
        t.rect[2] <= bounds[2] &&
        t.rect[3] <= bounds[1] &&
        bounds[1] - t.rect[3] <= t.height &&
        Math.abs((t.rect[0] + t.rect[2] - bounds[0] - bounds[2]) / 2) <= t.height &&
        t.height <= (row[0][3] - row[0][1]) / 4
    )
    if (local.length !== 1) return
    headings.push(local[0])
  }
  if (
    headings.every((t) => t.rect[1] >= rect[1]) ||
    headings.some((t) => Math.abs(t.height - headings[0].height) > headings[0].height * 0.1)
  )
    return
  const expanded = union([rect, ...headings.map((t) => t.rect)])
  const added = [expanded[0], expanded[1], expanded[2], rect[1]]
  if (
    tables.some((t) => intersection(t, added) > 0) ||
    candidates.some((c) => c.page === caption.page && intersection(c.rect, added) > 0) ||
    tokens.some((t) => t.text?.trim() && intersection(t.rect, added) > 0 && !headings.includes(t))
  )
    return
  return expanded
}

function recoverLetteredRasterPair(page, figure, candidates, tableRects) {
  const caption = figure?.caption
  if (!caption || !page.graphicsBounds?.length) return undefined
  if (!/^\s*(?:Figure|Fig\.?)\s*\d+\s*[A-Z]-[A-Z]\.?(?:\s|$)/i.test(caption.lines?.[0] ?? ''))
    return undefined
  const images = page.graphicsBounds
    .filter((graphic) => graphic.kind === 'image' && graphic.normalizedRect?.every(Number.isFinite))
    .map((graphic) =>
      graphic.normalizedRect.map((value, index) => value * (index % 2 ? page.height : page.width))
    )
    .filter((rect) => rect[3] < caption.rect[1] && rect[2] - rect[0] > page.width * 0.45)
  if (images.length !== 2) return undefined
  const [first, second] = images.slice().sort((a, b) => a[1] - b[1])
  const width = first[2] - first[0]
  if (
    Math.abs(second[2] - second[0] - width) > Math.max(2, width * 0.03) ||
    Math.abs(first[0] - second[0]) > Math.max(2, width * 0.03) ||
    second[1] - first[3] > Math.max(24, page.height * 0.06) ||
    candidates.some(
      (other) =>
        other !== caption &&
        other.page === caption.page &&
        images.some((image) => intersection(other.rect, image) > 0)
    ) ||
    tableRects.some((table) => images.some((image) => intersection(table, image) > 0))
  )
    return undefined
  const rect = union(images)
  return { rect, graphicsCount: 2 }
}

function recoverUnmatchedTopFigureLabel(page, figure) {
  const rect = figure?.rect
  const caption = figure?.caption
  if (!rect || !caption || rect[1] > page.height * 0.15) return undefined
  const label = page.lines.find(
    (line) =>
      line !== caption &&
      line.y < rect[1] &&
      rect[1] - (line.y + line.height) <= Math.max(24, line.fontSize * 2) &&
      line.x < page.width * 0.25 &&
      line.width < page.width * 0.7 &&
      Math.max(0, Math.min(line.x + line.width, rect[2]) - Math.max(line.x, rect[0])) >=
        Math.min(line.width, rect[2] - rect[0]) * 0.5 &&
      !/^\d{1,4}\s+of\s+\d+/i.test(line.text.trim()) &&
      !/\bet al\.?\s+\d+$/i.test(line.text.trim()) &&
      /\bet al\.?\b/i.test(line.text)
  )
  if (!label) return undefined
  // An all-width `et al.:` line in the shallow top margin is a running
  // author/journal head, even when the adjacent vector plate starts just
  // below it. Do not let the generic top-label recovery pull that furniture
  // back into the figure crop after the geometry pass excluded its rule.
  if (
    label.y < page.height * 0.08 &&
    label.x < page.width * 0.25 &&
    label.width > page.width * 0.45 &&
    /\bet al\.\s*:/i.test(label.text) &&
    !page.graphicsBounds.some(
      (graphic) =>
        graphic.kind === 'image' &&
        intersection(
          lineRect(label),
          graphic.normalizedRect.map(
            (value, index) => value * (index % 2 ? page.height : page.width)
          )
        ) > 0
    )
  )
    return undefined
  const matchingHeader = page.lines.some(
    (line) =>
      line !== label &&
      line.x > page.width * 0.6 &&
      /\d/.test(line.text) &&
      Math.abs(line.y - label.y) < Math.max(label.height, line.fontSize) * 0.25
  )
  if (matchingHeader) return undefined
  return [Math.min(rect[0], label.x), label.y, rect[2], rect[3]]
}

// Complete one already owned timeline stem only when its actual native stroke
// and centered time label identify it independently of the candidate's box.
export function nativeOwnedTimelineStroke(page, figure, captions = [], tables = [], rules = []) {
  const { rect, caption } = figure ?? {}
  if (!rect || !caption || !/\b(?:timeline|during)\b/i.test(caption.lines?.join(' ') ?? ''))
    return undefined
  const font = Math.min(
    ...page.lines
      .filter((line) => intersection(lineRect(line), caption.rect) > 0)
      .map((line) => line.fontSize),
    caption.rect[3] - caption.rect[1]
  )
  const labels = page.lines.filter(
    (line) =>
      /^time$/i.test(line.text.trim()) &&
      line.y > rect[1] &&
      line.y + line.height <= Math.min(rect[3], caption.rect[1])
  )
  if (labels.length !== 1) return undefined
  const label = labels[0]
  const strokes = rules.filter(
    (r) =>
      r.every(Number.isFinite) &&
      Math.abs(r[3] - r[1]) < 0.1 &&
      r[2] - r[0] >= (rect[2] - rect[0]) * 0.75 &&
      r[0] < rect[0] &&
      rect[0] - r[0] <= font * 4 &&
      r[2] <= rect[2] + font &&
      r[1] >= rect[1] &&
      r[1] <= label.y &&
      label.y - r[1] <= label.height &&
      Math.abs((r[0] + r[2]) / 2 - label.x - label.width / 2) <= label.height * 2
  )
  if (
    strokes.length !== 1 ||
    page.lines.some(
      (line) =>
        Math.abs(line.y - label.y) <= label.height &&
        (line.text.match(/(?:^|\s)[−-]?\d+(?:\.\d+)?(?=\s|$)/g)?.length ?? 0) >= 3
    )
  )
    return undefined
  const stroke = strokes[0]
  const painted = (page.graphicsBounds ?? [])
    .filter((g) => g.kind === 'path')
    .map((g) => figureGraphicRect(page, g))
    .filter(
      (r) =>
        r &&
        r[3] - r[1] <= font &&
        r[0] <= stroke[0] &&
        r[2] >= stroke[2] &&
        r[1] <= stroke[1] &&
        r[3] >= stroke[3] &&
        r[0] < rect[0] &&
        rect[0] - r[0] <= font * 4 &&
        r[2] <= rect[2] + font
    )
  if (painted.length !== 1) return undefined
  const extension = [painted[0][0], painted[0][1], rect[0], painted[0][3]]
  if (
    captions.some(
      (c) => c !== caption && c.page === page.pageNumber && intersection(c.rect, extension) > 0
    ) ||
    tables.some((r) => intersection(r, extension) > 0)
  )
    return undefined
  return union([rect, painted[0]])
}

// A font change can split a normal sentence into several native fragments.
// Remove it only before a separate existing plate, with a full-width sentence
// and a clear gap before every piece of already owned source ink.
export function excludeOwnedFigurePriorProse(
  page,
  figure,
  captions = [],
  tables = [],
  tokens = [],
  context
) {
  const { rect, caption } = figure ?? {}
  if (!rect || !caption) return figure
  // Legacy geometry-only inputs remain valid association sources. This new
  // font-qualified prose witness cannot classify them without native metrics.
  if (
    !page.lines?.length ||
    page.lines.some(
      (line) =>
        ![line.x, line.y, line.width, line.height, line.fontSize].every(Number.isFinite) ||
        line.fontSize <= 0
    )
  )
    return figure
  const font = Math.min(
    ...page.lines
      .filter((line) => intersection(lineRect(line), caption.rect) > 0)
      .map((line) => line.fontSize),
    caption.rect[3] - caption.rect[1]
  )
  const graphics = (page.graphicsBounds ?? [])
    .filter((g) => {
      const owned =
        g.paintedNormalizedRect?.map((v, i) => v * (i % 2 ? page.height : page.width)) ??
        figureGraphicRect(page, g)
      return (
        (g.kind === 'image' || g.kind === 'path') &&
        owned &&
        area(owned) > font * font &&
        intersection(owned, rect) / area(owned) > 0.95
      )
    })
    .map((g) => figureGraphicRect(page, g))
  if (graphics.length < 2) return figure
  const inkTop = graphics.reduce((minimum, r) => Math.min(minimum, r[1]), Infinity)
  const sentence = nativePriorInlineScript(page, figure, captions, tables, tokens, context, inkTop)
  if (sentence)
    return {
      ...figure,
      rect: [rect[0], inkTop, rect[2], rect[3]],
      excludedProseLines: [...(figure.excludedProseLines ?? []), ...sentence]
    }
  const rows = groupPageLines(page)
    .map((line) => ({ ...line, width: line.right - line.x, height: line.bottom - line.y }))
    .filter(
      (line) =>
        line.y >= rect[1] - font &&
        line.y + line.height <= inkTop - font &&
        line.width >= page.width * 0.65 &&
        line.x < rect[0] - font * 3 &&
        line.x + line.width > rect[2] + font * 3 &&
        line.fontSize > font * 1.1 &&
        /\.$/.test(line.text.trim()) &&
        (line.text.match(/[\p{L}]{2,}/gu)?.length ?? 0) >= 6
    )
  if (rows.length !== 1) return figure
  const row = rows[0],
    rowRect = lineRect(row)
  if (
    captions.some(
      (c) => c !== caption && c.page === page.pageNumber && intersection(c.rect, rowRect) > 0
    ) ||
    tables.some((r) => intersection(r, rowRect) > 0)
  )
    return figure
  const excluded = page.lines.filter(
    (line) => intersection(lineRect(line), rowRect) / Math.max(1, area(lineRect(line))) > 0.95
  )
  if (excluded.length < 2 || !excluded.some((line) => line.fontSize > font * 1.1)) return figure
  const kept = page.lines.filter(
    (line) => !excluded.includes(line) && line.y < inkTop && intersection(lineRect(line), rect) > 0
  )
  if (kept.length) return figure
  return {
    ...figure,
    rect: [rect[0], inkTop, rect[2], rect[3]],
    excludedProseLines: [...(figure.excludedProseLines ?? []), ...excluded]
  }
}
// A lowered inline subscript can pull a preceding sentence into the candidate.
// The two ordinary native fragments, every script
// item between them, and the next independent paint must all be accounted for.
function nativePriorInlineScript(page, figure, captions, tables, tokens, context, inkTop) {
  const { rect, caption } = figure,
    raw = context?.content?.items,
    v = context?.viewport,
    valid = (r) =>
      Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1],
    same = (a, b) =>
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every(Number.isFinite) &&
      b.every(Number.isFinite) &&
      a.every((n, i) => Math.abs(n - b[i]) < 1e-6),
    glyphs = (s) => s.replace(/\s+/gu, '')
  if (
    page.invalidGraphicsBounds !== 0 ||
    !Array.isArray(raw) ||
    !Array.isArray(tokens) ||
    !tokens.length ||
    v?.rotation !== 0 ||
    v.scale !== 1 ||
    !same(v.transform, [1, 0, 0, -1, 0, page.height]) ||
    v.width !== page.width ||
    v.height !== page.height ||
    !Number.isFinite(inkTop)
  )
    return
  const viewport = { ...v, convertToViewportPoint: (x, y) => [x, page.height - y] },
    before = tokens.filter(
      (t) => t.text?.trim() && valid(t.rect) && t.rect[1] < inkTop && t.rect[3] > rect[1]
    )
  if (!before.length || before.some((t) => t.rect[3] >= inkTop)) return
  // The ordinary baseline is above the crop; the lowered script alone enters.
  const ends = tokens.filter(
    (t) =>
      t.text?.length >= 35 &&
      /^[\p{L}\s,'’()-]+\.$/u.test(t.text) &&
      valid(t.rect) &&
      t.rect[1] < rect[1] &&
      t.rect[3] <= rect[1] + t.height &&
      t.rect[3] < inkTop &&
      t.rect[0] > rect[0]
  )
  if (ends.length !== 1) return
  const tail = ends[0],
    em = tail.height,
    starts = tokens.filter(
      (t) =>
        t !== tail &&
        /^[\p{L}]+(?:\s+[\p{L}]+)+$/u.test(t.text ?? '') &&
        valid(t.rect) &&
        Math.abs(t.height - em) < 1e-6 &&
        Math.abs(t.baseline - tail.baseline) < 1e-6 &&
        t.rect[0] < rect[0] - em * 3 &&
        t.rect[2] <= rect[0] + em &&
        t.sourceItem?.index < tail.sourceItem?.index
    )
  if (starts.length !== 1 || !(em > 0) || inkTop - Math.max(...before.map((t) => t.rect[3])) < em)
    return
  const first = starts[0],
    packet = tokens
      .filter(
        (t) =>
          t.sourceItem?.index >= first.sourceItem.index &&
          t.sourceItem.index <= tail.sourceItem.index
      )
      .sort((a, b) => a.sourceItem.index - b.sourceItem.index),
    scripts = packet.slice(1, -1)
  if (
    packet[0] !== first ||
    packet.at(-1) !== tail ||
    scripts.length < 1 ||
    scripts.length > 8 ||
    !proveNativeUniqueWholeFonts(packet, tokens) ||
    (first.text.concat(' ', tail.text).match(/\p{L}{2,}/gu)?.length ?? 0) < 10 ||
    raw.slice(first.sourceItem.index, tail.sourceItem.index + 1).filter((i) => i.str?.trim())
      .length !== packet.length ||
    raw[first.sourceItem.index]?.fontName !== raw[tail.sourceItem.index]?.fontName
  )
    return
  for (const [i, t] of packet.entries()) {
    const item = raw[t.sourceItem.index],
      style = context.content.styles?.[item?.fontName]
    if (
      item?.str !== t.text ||
      t.sourceItem.pageNumber !== page.pageNumber ||
      !Array.isArray(item.transform) ||
      item.transform.length !== 6 ||
      !item.transform.every(Number.isFinite) ||
      item.transform[1] !== 0 ||
      item.transform[2] !== 0 ||
      item.transform[0] <= 0 ||
      item.transform[3] <= 0 ||
      !Number.isFinite(item.height) ||
      Math.abs(item.height - t.height) > 1e-6 ||
      Math.abs(item.transform[0] - t.height) > 1e-6 ||
      Math.abs(item.transform[3] - t.height) > 1e-6 ||
      !Number.isFinite(t.height) ||
      !Number.isFinite(t.baseline) ||
      style?.vertical !== false ||
      !Number.isFinite(style.ascent) ||
      style.ascent <= 0 ||
      style.ascent > 1 ||
      !Number.isFinite(style.descent) ||
      style.descent < -1 ||
      style.descent > 0 ||
      !same(tableTextToken(item, viewport, 0).rect, t.rect) ||
      Math.abs(tableTextToken(item, viewport, 0).baseline - t.baseline) > 1e-6 ||
      !same(nativeFigureLabelBounds(item, style, viewport), t.nativeLabelRect) ||
      t.nativeLabelRect[3] >= inkTop ||
      (i && (t.rect[0] < packet[i - 1].rect[0] || t.rect[0] - packet[i - 1].rect[2] > em * 0.5))
    )
      return
  }
  if (
    scripts.some(
      (t) =>
        !/^[\p{L}\p{N}()[\]{}]+$/u.test(t.text) ||
        t.height >= em * 0.8 ||
        Math.abs(t.baseline - tail.baseline) > em * 0.5
    ) ||
    before.some((t) => !packet.includes(t))
  )
    return
  const envelope = union(packet.map((t) => t.rect)),
    removed = [rect[0], rect[1], rect[2], inkTop],
    lines = page.lines.filter((l) => intersection(lineRect(l), envelope) > 0)
  if (
    glyphs(lines.map((l) => l.text).join('')) !== glyphs(packet.map((t) => t.text).join('')) ||
    tokens.some(
      (t) =>
        t.text?.trim() &&
        !packet.includes(t) &&
        (!valid(t.rect) ||
          (valid(t.nativeLabelRect)
            ? intersection(t.nativeLabelRect, removed) > 0
            : intersection(t.rect, [rect[0], rect[1] - t.height, rect[2], inkTop + t.height]) > 0))
    ) ||
    captions.some(
      (c) => c !== caption && c.page === page.pageNumber && intersection(c.rect, envelope) > 0
    ) ||
    tables.some((r) => intersection(r, envelope) > 0) ||
    page.lines.some(
      (l) => !lines.includes(l) && l.y < inkTop && intersection(lineRect(l), rect) > 0
    ) ||
    page.graphicsBounds.some((g) => {
      const r = figureGraphicRect(page, g)
      return !valid(r) || (intersection(r, rect) > 0 && r[1] < inkTop)
    })
  )
    return
  return lines
}
function expandAdjacentFigureInk(page, figure) {
  const rect = figure?.rect
  if (!rect || !page.graphicsBounds?.length) return undefined
  const adjacent = page.graphicsBounds
    .filter((graphic) => graphic.kind === 'path' && graphic.normalizedRect?.every(Number.isFinite))
    .map((graphic) =>
      graphic.normalizedRect.map((value, index) => value * (index % 2 ? page.height : page.width))
    )
    .filter((candidate) => {
      const verticalGap = Math.max(candidate[1] - rect[3], 0)
      const horizontalOverlap =
        Math.max(0, Math.min(candidate[2], rect[2]) - Math.max(candidate[0], rect[0])) /
        Math.max(1, Math.min(candidate[2] - candidate[0], rect[2] - rect[0]))
      return (
        verticalGap <= 8 &&
        candidate[1] >= rect[3] - 1 &&
        candidate[3] - candidate[1] <= 10 &&
        horizontalOverlap >= 0.8 &&
        // A closing figure rule cannot cross into its following caption.
        // Raised formula strokes otherwise undo the caption-aware matcher.
        !(figure.caption.rect[1] >= rect[3] && candidate[3] >= figure.caption.rect[1])
      )
    })
  if (!adjacent.length) return undefined
  const bounded = adjacent.map((candidate) => [
    candidate[0],
    candidate[1],
    candidate[2],
    Math.min(candidate[3], rect[3] + 5)
  ])
  return union([rect, ...bounded])
}

function recoverIsolatedAdjacentFigure(
  page,
  figure,
  candidates,
  tableRects,
  rules,
  closedFrames,
  nativeTokens
) {
  const caption = figure?.caption
  if (!caption || !page.graphicsBounds?.length) return undefined
  // Candidate captions are document-wide. Only captions on this page can
  // witness a competing graphic or overlap the recovered image pair.
  const others = candidates.filter(
    (candidate) => candidate !== caption && candidate.page === caption.page
  )
  if (
    others.some(
      (other) =>
        other.rect[1] > caption.rect[3] &&
        Math.max(
          0,
          Math.min(other.rect[2], caption.rect[2]) - Math.max(other.rect[0], caption.rect[0])
        ) /
          Math.max(1, Math.min(other.rect[2] - other.rect[0], caption.rect[2] - caption.rect[0])) >
          0.35
    )
  )
    return undefined
  const images = page.graphicsBounds
    .filter((graphic) => graphic.kind === 'image')
    .map((graphic) => ({ graphic, rect: figureGraphicRect(page, graphic) }))
    .filter(({ rect }) => {
      if (!rect || area(rect) < page.width * page.height * 0.01) return false
      const overlap =
        Math.max(0, Math.min(rect[2], caption.rect[2]) - Math.max(rect[0], caption.rect[0])) /
        Math.max(1, Math.min(rect[2] - rect[0], caption.rect[2] - caption.rect[0]))
      return caption.rect[1] - rect[3] >= 0 && caption.rect[1] - rect[3] <= 24 && overlap >= 0.8
    })
  if (images.length !== 2) return undefined
  const bounds = union(images.map((item) => item.rect))
  if (
    Math.abs(images[0].rect[3] - images[1].rect[3]) > 8 ||
    Math.abs(images[0].rect[1] - images[1].rect[1]) > 8 ||
    others.some((other) => intersection(other.rect, bounds) > 0) ||
    tableRects.some((table) => intersection(table, bounds) > 0)
  )
    return undefined
  const retryPage = { ...page, graphicsBounds: images.map((item) => item.graphic) }
  const retry = associateFigureFaces(
    retryPage,
    [caption],
    tableRects,
    rules,
    closedFrames,
    nativeTokens
  )[0]
  return retry?.rect ? retry : undefined
}

function recoverGraphicalTableShadowFigure(
  page,
  figure,
  candidates,
  tableRects,
  rules,
  closedFrames,
  nativeTokens
) {
  const caption = figure?.caption
  if (!caption || !tableRects.length || !page.graphicsBounds?.length) return undefined
  const captionWidth = caption.rect[2] - caption.rect[0]
  const maxGap = Math.max(24, (caption.rect[3] - caption.rect[1]) * 4)
  const toRect = (graphic) =>
    graphic.normalizedRect?.map((value, index) => value * (index % 2 ? page.height : page.width))
  const paths = page.graphicsBounds
    .filter((graphic) => graphic.kind === 'path')
    .map((graphic) => ({ graphic, rect: toRect(graphic) }))
    .filter(({ rect }) => rect && area(rect) > 0)
  if (paths.length < 20) return undefined
  const shadow = tableRects.find((table) => {
    const horizontal =
      Math.max(0, Math.min(table[2], caption.rect[2]) - Math.max(table[0], caption.rect[0])) /
      Math.max(1, Math.min(table[2] - table[0], captionWidth))
    if (
      horizontal < 0.5 ||
      table[1] > caption.rect[3] + 2 ||
      caption.rect[1] - table[3] > maxGap ||
      table[2] - table[0] < page.width * 0.45
    )
      return false
    const owned = paths.filter(({ rect }) => intersection(rect, table) / area(rect) > 0.55)
    if (owned.length < 20) return false
    const narrow = owned.filter(({ rect }) => rect[2] - rect[0] <= 12 && rect[3] - rect[1] <= 12)
    const vertical = owned.find(
      ({ rect: candidate }) =>
        candidate[3] - candidate[1] > 60 &&
        candidate[2] - candidate[0] < 12 &&
        owned.filter(
          ({ rect: other }) =>
            other[2] - other[0] > 40 &&
            other[3] - other[1] < 12 &&
            intersection(candidate, other) > 0
        ).length >= 2
    )
    return narrow.length >= 20 && Boolean(vertical)
  })
  if (!shadow) return undefined
  const relaxedTables = tableRects.filter((table) => table !== shadow)
  const retry = associateFigureFaces(
    page,
    candidates,
    relaxedTables,
    rules,
    closedFrames,
    nativeTokens
  )
  return retry.find((candidate) => candidate.caption === caption && candidate.rect)
}

function figureGraphicRect(page, graphic) {
  if (!graphic?.normalizedRect?.every(Number.isFinite)) return undefined
  return graphic.normalizedRect.map(
    (value, index) => value * (index % 2 ? page.height : page.width)
  )
}

function figureGraphicArea(page, graphic) {
  const rect = figureGraphicRect(page, graphic)
  return rect ? area(rect) / (page.width * page.height) : 0
}

function hasVerifiedListingEvidence(page, lines) {
  if (lines.length < 40) return false
  const proseLines = lines.filter(
    (line) => line.width >= page.width * 0.45 && line.text.trim().split(/\s+/).length >= 5
  )
  if (proseLines.length < Math.max(30, Math.ceil(lines.length * 0.75))) return false
  const left = Math.min(...proseLines.map((line) => line.x))
  const aligned = proseLines.filter(
    (line) => Math.abs(line.x - left) <= Math.max(4, page.width * 0.04)
  )
  return aligned.length >= Math.ceil(proseLines.length * 0.8)
}

function isTextDominantFigure(page, figure, candidates) {
  if (!figure.rect || !figure.graphicsCount || figure.graphicsCount < 100) return false
  const rect = figure.rect
  const graphics = (page.graphicsBounds ?? []).map((graphic) => ({
    graphic,
    rect: figureGraphicRect(page, graphic)
  }))
  const inside = graphics.filter(
    (item) => item.rect && intersection(item.rect, rect) / area(item.rect) > 0.8
  )
  if (!inside.length || inside.some((item) => item.graphic.kind === 'image')) return false
  const maxArea = inside.reduce(
    (maximum, item) => Math.max(maximum, figureGraphicArea(page, item.graphic)),
    -Infinity
  )
  if (maxArea >= 0.02) return false
  // A vector plate can be composed of many small paths. Keep those when a
  // few paths still occupy a material area; listing-like blocks tend to have
  // only hairline fragments despite their high graphics count.
  if (inside.filter((item) => figureGraphicArea(page, item.graphic) >= 0.005).length >= 3)
    return false
  const lines = page.lines.filter(
    (line) =>
      line.text?.trim() &&
      !candidates.some(
        (candidate) =>
          candidate.page === page.pageNumber && intersection(lineRect(line), candidate.rect) > 0
      ) &&
      intersection(lineRect(line), rect) / area(lineRect(line)) > 0.75
  )
  return hasVerifiedListingEvidence(page, lines) && area(rect) / (page.width * page.height) >= 0.35
}

function isTextDominantPage(page, candidates) {
  const graphics = page.graphicsBounds ?? []
  if (graphics.length < 100 || graphics.some((graphic) => graphic.kind === 'image')) return false
  const maxArea = graphics.reduce(
    (maximum, graphic) => Math.max(maximum, figureGraphicArea(page, graphic)),
    -Infinity
  )
  if (maxArea >= 0.02) return false
  if (graphics.filter((graphic) => figureGraphicArea(page, graphic) >= 0.005).length >= 3)
    return false
  const lines = page.lines.filter(
    (line) =>
      line.text?.trim() &&
      !candidates.some(
        (candidate) =>
          candidate.page === page.pageNumber && intersection(lineRect(line), candidate.rect) > 0
      )
  )
  return hasVerifiedListingEvidence(page, lines)
}

function nativeParagraphOwnsRasterWords(page, items, captions, tableRects) {
  if (
    page.invalidGraphicsBounds !== 0 ||
    items.length < 2 ||
    items.some(
      ({ graphic }) =>
        graphic.kind !== 'image' ||
        !Array.isArray(graphic.paintedNormalizedRect) ||
        graphic.paintedNormalizedRect.length !== 4 ||
        !graphic.paintedNormalizedRect.every(Number.isFinite)
    )
  )
    return false
  const paints = items.map(({ graphic }) =>
    graphic.paintedNormalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
  )
  if (paints.some((r) => area(r) <= 0)) return false
  const runs = groupPageLines(page)
  for (const first of runs) {
    const em = first.fontSize
    if (
      !/^[\p{Lu}]/u.test(first.text) ||
      first.text.length < 40 ||
      captionKind(first.text) ||
      !Number.isFinite(em) ||
      em <= 0 ||
      first.y >= Math.min(...paints.map((r) => r[1]))
    )
      continue
    const rows = [first]
    for (const next of runs.filter((r) => r.y > first.y).sort((a, b) => a.y - b.y)) {
      const previous = rows.at(-1),
        step = next.y - previous.y
      if (step > em * 1.5) break
      if (
        step < em ||
        Math.abs(next.x - first.x) > em * 0.05 ||
        Math.abs(next.fontSize - em) > em * 0.015 ||
        next.text.length < 30 ||
        captionKind(next.text)
      )
        break
      rows.push(next)
      if (/[.!?][”"']?$/u.test(next.text.trim())) break
    }
    if (
      rows.length < 3 ||
      !/[.!?][”"']?$/u.test(rows.at(-1).text.trim()) ||
      rows.slice(1).some((r, i) => Math.abs(r.y - rows[i].y - (rows[1].y - first.y)) > em * 0.03)
    )
      continue
    const rowRect = (r) => [r.x, r.y, r.right, r.bottom]
    const nativeBox = union(rows.map(rowRect))
    if (
      !nativeBox ||
      paints.some(
        (r) =>
          r[0] < nativeBox[0] ||
          r[1] < nativeBox[1] ||
          r[2] > nativeBox[2] ||
          r[3] - r[1] > em * 1.25 ||
          !rows.some((l) => intersection(rowRect(l), r) > area(r) * 0.5)
      )
    )
      continue
    // Image ink can descend below the native advance box. Its majority must
    // overlap a body row; include the actual ink when excluding other content.
    const box = union([nativeBox, ...paints])
    const native = page.lines.filter((l) => l.text?.trim() && intersection(lineRect(l), box) > 0)
    if (
      native.length !== rows.length ||
      !rows.every(
        (r) =>
          native.filter(
            (n) =>
              n.text === r.text &&
              n.x === r.x &&
              n.y === r.y &&
              n.x + n.width === r.right &&
              n.y + n.height === r.bottom &&
              n.fontSize === r.fontSize
          ).length === 1
      )
    )
      continue
    if (
      captions.some((c) => intersection(c.rect, box) > 0) ||
      tableRects.some((r) => intersection(r, box) > 0)
    )
      continue
    if (
      page.graphicsBounds.some(
        (g) =>
          !items.some((i) => i.graphic === g) &&
          (!figureGraphicRect(page, g) || intersection(figureGraphicRect(page, g), box) > 0)
      )
    )
      continue
    return true
  }
  return false
}

function recoverConservativeFigureRect(page, figure, tableRects, candidates) {
  if (!figure?.caption || !page.graphicsBounds?.length) return undefined
  const caption = figure.caption
  const pageCaptions = candidates.filter((candidate) => candidate.page === page.pageNumber)
  const otherCaptions = pageCaptions.filter((candidate) => candidate !== caption)
  const edgeTolerance = page.height / 256 + 1
  const maximumCaptionGap = 240
  const graphics = page.graphicsBounds
    .map((graphic) => ({ graphic, rect: figureGraphicRect(page, graphic) }))
    .filter(({ rect }) => rect && area(rect) > 0)
    .filter(
      ({ rect }) =>
        !(
          rect[1] < page.height * 0.1 &&
          rect[3] - rect[1] < page.height * 0.08 &&
          rect[2] - rect[0] > page.width * 0.7
        ) &&
        !tableRects.some((table) => intersection(table, rect) / area(rect) > 0.8) &&
        !otherCaptions.some((candidate) => intersection(candidate.rect, rect) / area(rect) > 0.6) &&
        intersection(caption.rect, rect) / area(rect) < 0.25
    )
  // Above/below recovery must stay in the caption's horizontal lane. A
  // neighboring column can be equally close vertically, but it must not be
  // unioned into this figure's crop. Compare with the narrower projection so
  // a short caption under a wide plate still supplies meaningful lane proof.
  const laneGraphics = graphics.filter(({ rect }) => {
    const overlap = Math.max(
      0,
      Math.min(rect[2], caption.rect[2]) - Math.max(rect[0], caption.rect[0])
    )
    const narrowerWidth = Math.min(rect[2] - rect[0], caption.rect[2] - caption.rect[0])
    return narrowerWidth > 0 && overlap / narrowerWidth >= 0.35
  })
  const sideGraphics = (side) => {
    const items = graphics.filter(({ rect }) => {
      const verticalOverlap =
        Math.min(rect[3], caption.rect[3]) - Math.max(rect[1], caption.rect[1])
      return (
        (side === 'left'
          ? rect[2] <= caption.rect[0] + edgeTolerance &&
            caption.rect[0] - rect[2] <= maximumCaptionGap
          : rect[0] >= caption.rect[2] - edgeTolerance &&
            rect[0] - caption.rect[2] <= maximumCaptionGap) &&
        verticalOverlap >= Math.min(rect[3] - rect[1], caption.rect[3] - caption.rect[1]) * 0.35
      )
    })
    if (!items.length) return []
    const gap = (rect) => (side === 'left' ? caption.rect[0] - rect[2] : rect[0] - caption.rect[2])
    const nearest = items.reduce((minimum, { rect }) => Math.min(minimum, gap(rect)), Infinity)
    const anchor = items.find(({ rect }) => gap(rect) === nearest)?.rect
    if (!anchor) return []
    return items.filter(({ rect }) => {
      const overlap = Math.max(0, Math.min(rect[2], anchor[2]) - Math.max(rect[0], anchor[0]))
      const narrowerWidth = Math.min(rect[2] - rect[0], anchor[2] - anchor[0])
      return narrowerWidth > 0 && overlap / narrowerWidth >= 0.35
    })
  }
  // When two figure captions share one vertical lane, an unresolved lower
  // caption must not claim the graphics above the already-labelled figure.
  // Use only the nearest intervening figure caption as a barrier; a table
  // caption or a caption in another column does not change the composite
  // figure contract.
  const interveningAbove = otherCaptions
    .filter((candidate) => {
      if (
        captionKind(candidate.lines?.[0] ?? '') !== 'figure' ||
        candidate.rect[3] >= caption.rect[1] - edgeTolerance
      )
        return false
      const overlap = Math.max(
        0,
        Math.min(candidate.rect[2], caption.rect[2]) - Math.max(candidate.rect[0], caption.rect[0])
      )
      const narrowerWidth = Math.min(
        candidate.rect[2] - candidate.rect[0],
        caption.rect[2] - caption.rect[0]
      )
      if (narrowerWidth <= 0 || overlap / narrowerWidth < 0.35) return false
      const upperGraphics = laneGraphics.some(
        ({ rect }) => rect[3] <= candidate.rect[1] + edgeTolerance
      )
      const lowerGraphics = laneGraphics.some(
        ({ rect }) =>
          rect[1] >= candidate.rect[3] - edgeTolerance && rect[3] <= caption.rect[1] + edgeTolerance
      )
      return upperGraphics && lowerGraphics
    })
    .sort((a, b) => b.rect[3] - a.rect[3])[0]
  const aboveBarrier = interveningAbove?.rect[3]
  const belowBarrier = otherCaptions
    .filter(
      (candidate) =>
        candidate.rect[1] > caption.rect[3] &&
        captionKind(candidate.lines?.[0] ?? '') === 'figure' &&
        Math.min(candidate.rect[2], caption.rect[2]) > Math.max(candidate.rect[0], caption.rect[0])
    )
    .sort((a, b) => a.rect[1] - b.rect[1])[0]?.rect[1]
  const upperPlate = laneGraphics.filter(
    ({ rect }) =>
      rect[3] <= caption.rect[1] + edgeTolerance &&
      caption.rect[1] - rect[3] <= maximumCaptionGap &&
      (aboveBarrier === undefined || rect[1] >= aboveBarrier - edgeTolerance)
  )
  const hasUpperPlate =
    upperPlate.filter(
      ({ graphic, rect }) =>
        graphic.kind === 'image' && area(rect) >= page.width * page.height * 0.001
    ).length >= 2 ||
    upperPlate.some(
      ({ graphic, rect }) =>
        graphic.kind === 'path' && area(rect) >= page.width * page.height * 0.02
    ) ||
    upperPlate.some(
      ({ graphic, rect }) =>
        graphic.kind === 'image' &&
        graphic.paintedNormalizedRect &&
        !graphic.imageHash &&
        area(rect) >= page.width * page.height * 0.02
    ) ||
    upperPlate.filter(
      ({ graphic, rect }) =>
        graphic.kind === 'path' &&
        rect[2] - rect[0] >= page.width * 0.15 &&
        caption.rect[1] - rect[3] <= 120
    ).length >= 2
  const nextCaptionOwnsLowerPlate =
    belowBarrier !== undefined &&
    laneGraphics.some(
      ({ rect }) =>
        rect[1] >= caption.rect[3] - edgeTolerance &&
        rect[3] <= belowBarrier + edgeTolerance &&
        belowBarrier - rect[3] <= maximumCaptionGap
    )
  const directions = [
    upperPlate,
    laneGraphics.filter(
      ({ rect }) =>
        rect[1] >= caption.rect[3] - edgeTolerance &&
        rect[1] - caption.rect[3] <= maximumCaptionGap &&
        // A lower plate followed by its own caption cannot be claimed by an
        // unresolved caption above it. Preserve ambiguity instead of silently
        // assigning the next figure's content to both captions.
        (!hasUpperPlate || !nextCaptionOwnsLowerPlate)
    ),
    sideGraphics('left'),
    sideGraphics('right')
  ]
  const ranked = directions
    .map((items, direction) => {
      if (!items.length) return undefined
      if (nativeParagraphOwnsRasterWords(page, items, pageCaptions, tableRects)) return undefined
      const bounds = union(items.map((item) => item.rect))
      const imageCount = items.filter((item) => item.graphic.kind === 'image').length
      const maxArea = items.reduce(
        (maximum, item) => Math.max(maximum, figureGraphicArea(page, item.graphic)),
        -Infinity
      )
      // Raster-strip recovery is only safe when the strips form one continuous
      // plate. Sparse strips are commonly unrelated image fragments or a
      // neighboring column; do not bridge their gaps into a fabricated crop.
      if (imageCount >= 3 && items.every((item) => item.graphic.kind === 'image')) {
        const strips = [...items].sort((a, b) => a.rect[1] - b.rect[1])
        if (
          strips.some(
            (strip, index) => index > 0 && strip.rect[1] - strips[index - 1].rect[3] > edgeTolerance
          )
        )
          return undefined
      }
      // A lone raster can be a decorative panel or a neighboring column image.
      // Require either a raster pair (the common multi-panel case) or a
      // substantial vector plate before claiming an unresolved caption.
      if (imageCount < 2 && (imageCount > 0 || maxArea < 0.02)) return undefined
      const pathCount = items.filter((item) => item.graphic.kind === 'path').length
      if (imageCount === 0 && pathCount < 3) return undefined
      if (imageCount === 0 && bounds[2] - bounds[0] < page.width * 0.45) return undefined
      return { bounds, direction, items, score: area(bounds) + maxArea * page.width * page.height }
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
  if (!ranked.length) return undefined
  const winner = ranked[0]
  if (winner.direction >= 2 && winner.items.every((item) => item.graphic.kind !== 'image'))
    return undefined
  const rect = winner.bounds
  return [
    Math.max(0, rect[0] - 2),
    Math.max(0, rect[1] - 2),
    Math.min(page.width, rect[2] + 2),
    Math.min(page.height, rect[3] + 2)
  ]
}

function associateFigureFaces(
  page,
  candidates,
  tableRects = [],
  rules = [],
  closedFrames = [],
  nativeTokens = [],
  closedComposites = new Map(),
  operatorContext,
  previousProseEvidence
) {
  const originalLines = page.lines
  // Zero-advance PDF tagging tokens have no painted extent.
  page = {
    ...page,
    graphicsBounds: page.graphicsBounds?.map((g) =>
      g.kind === 'image' &&
      g.paintedNormalizedRect?.length === 4 &&
      g.paintedNormalizedRect.every(Number.isFinite) &&
      g.paintedNormalizedRect[2] > g.paintedNormalizedRect[0] &&
      g.paintedNormalizedRect[3] > g.paintedNormalizedRect[1] &&
      g.paintedNormalizedRect[0] >= g.normalizedRect[0] &&
      g.paintedNormalizedRect[1] >= g.normalizedRect[1] &&
      g.paintedNormalizedRect[2] <= g.normalizedRect[2] &&
      g.paintedNormalizedRect[3] <= g.normalizedRect[3]
        ? { ...g, normalizedRect: g.paintedNormalizedRect }
        : g
    ),
    lines: page.lines.filter(
      (l) =>
        l.width > 0 &&
        l.height > 0 &&
        !/^(?:Tagged(?:End|Figure))+$/.test(l.text.replace(/\s/g, ''))
    )
  }

  // Quantized heatmap/scatter operations can repeat identical path bounds
  // tens of thousands of times. Geometry association needs each occupied box
  // once; rendering still uses the complete, unchanged PDF operator stream.
  if (page.graphicsBounds) {
    const seen = new Set()
    page = {
      ...page,
      graphicsBounds: page.graphicsBounds.filter((graphic) => {
        if (graphic.kind !== 'path') return true
        const rect = graphic.normalizedRect.map(
          (value, index) => value * (index % 2 ? page.height : page.width)
        )
        // Some publishers draw a tiny footer/link icon as a path over the
        // running URL. It is not part of a figure, but its position below a
        // caption can make the real plate look bi-directional. Require both
        // the footer zone and a matching URL/publisher line before discarding
        // it so small scientific markers elsewhere remain available.
        if (
          rect[1] >= page.height * 0.88 &&
          area(rect) <= page.width * page.height * 0.002 &&
          page.lines.some(
            (line) =>
              line.y >= page.height * 0.86 &&
              /(?:https?:\/\/|www\.|\.(?:com|org|net)\b)/i.test(line.text) &&
              intersection(lineRect(line), rect) > 0
          )
        )
          return false
        const key = graphic.normalizedRect.join(',')
        if (seen.has(key)) {
          // Preserve a repeated large frame when it is immediately above a
          // figure caption. Some code/prompt cards paint the same border
          // twice; the duplicate is a strict nested-frame witness for the
          // text illustration recognizer, while repeated tiny path glyphs
          // remain deduplicated as before.
          const captionAttached = candidates.some((candidate) => {
            if (candidate.page !== page.pageNumber || candidate.rect[1] < rect[3]) return false
            const overlap =
              Math.max(
                0,
                Math.min(candidate.rect[2], rect[2]) - Math.max(candidate.rect[0], rect[0])
              ) / Math.max(1, Math.min(candidate.rect[2] - candidate.rect[0], rect[2] - rect[0]))
            return candidate.rect[1] - rect[3] <= 24 && overlap >= 0.8
          })
          if (captionAttached && area(rect) >= page.width * page.height * 0.1) return true
          return false
        }
        seen.add(key)
        return true
      })
    }
  }
  // Recorded bounds are quantized outward and include stroke ink. Allow one
  // extra source pixel when a border sits immediately above its caption.
  const edgeTolerance = page.height / 256 + 1
  const pageCaptions = candidates.filter((c) => c.page === page.pageNumber)

  // A vector multi-panel plate can be mistaken for a table by the detector:
  // the detector crop then covers every panel and ends immediately above the
  // figure caption, preventing the figure matcher from seeing any graphics.
  // Ignore that crop only with a narrow, local proof. It must contain at
  // least six substantial path panels in three aligned columns, span several
  // rows, touch this figure caption, and contain no raster graphics. Raster
  // panels and ordinary table barriers therefore remain protected.
  const isPanelGridTableFalsePositive = (caption, table) => {
    if (
      captionKind(caption.lines?.[0] ?? '') !== 'figure' ||
      !Array.isArray(table) ||
      table.length !== 4 ||
      !table.every(Number.isFinite) ||
      table[2] <= table[0] ||
      table[3] <= table[1] ||
      table[2] - table[0] < page.width * 0.6 ||
      table[3] < caption.rect[1] - edgeTolerance ||
      table[3] > caption.rect[3] + edgeTolerance ||
      table[1] > caption.rect[1] + edgeTolerance
    )
      return false
    const paths = (page.graphicsBounds ?? [])
      .filter((graphic) => graphic.kind === 'path')
      .map((graphic) =>
        graphic.normalizedRect.map((value, index) => value * (index % 2 ? page.height : page.width))
      )
      .filter(
        (rect) =>
          rect[0] >= table[0] - edgeTolerance &&
          rect[1] >= table[1] - edgeTolerance &&
          rect[2] <= table[2] + edgeTolerance &&
          rect[3] <= table[3] + edgeTolerance
      )
    if (
      (page.graphicsBounds ?? []).some(
        (graphic) =>
          graphic.kind === 'image' &&
          intersection(
            graphic.normalizedRect.map(
              (value, index) => value * (index % 2 ? page.height : page.width)
            ),
            table
          ) > 0
      )
    )
      return false
    const panels = paths.filter(
      (rect) => rect[2] - rect[0] >= page.width * 0.12 && rect[3] - rect[1] >= page.height * 0.04
    )
    if (panels.length < 6 || area(union(panels)) < page.width * page.height * 0.05) return false
    const columns = []
    for (const panel of [...panels].sort((a, b) => a[0] - b[0])) {
      const column = columns.at(-1)
      if (!column || Math.abs(panel[0] - column[0][0]) > page.width * 0.03) columns.push([panel])
      else column.push(panel)
    }
    if (columns.length < 3) return false
    const verticalSpan = union(panels)[3] - union(panels)[1]
    return verticalSpan >= page.height * 0.12
  }
  tableRects = tableRects.filter(
    (table) => !pageCaptions.some((caption) => isPanelGridTableFalsePositive(caption, table))
  )
  const captions = pageCaptions.filter((c) => {
    // Candidate grouping has already accepted the native title line. A
    // descriptive continuation may contain a finite verb without turning
    // that independently accepted title into an inline prose reference.
    let kind = captionKind(c.lines[0])
    // A finite verb remains conservative in the text-only classifier. Reuse
    // the same complete native caption proof that admitted an isolated colon
    // title, binding every line and its rectangle instead of adding a marker.
    if (kind === undefined && /^Figure\s+[A-Z]?\d+:\s+(?:As|For|In)\b/u.test(c.lines[0])) {
      const native = findCaptionCandidates([page], new Map([[page.pageNumber, rules]]))
      if (
        native.filter(
          (candidate) =>
            candidate.lines.length === c.lines.length &&
            candidate.lines.every((line, index) => line === c.lines[index]) &&
            candidate.rect.every((value, axis) => value === c.rect[axis])
        ).length === 1
      )
        kind = 'figure'
    }
    // A tight label-only first line needs its immediate descriptive title.
    // Keep this fallback exclusive to printed ordinals; later caption prose
    // cannot reclassify either a rejected reference or an accepted title.
    if (
      kind === undefined &&
      c.lines[1]?.trim() &&
      /^(?:(?:Supplementary|Supplemental)\s+)?(?:Fig\.?|Figure)\s+(?:[A-Z]{0,3}\d+(?:\.\d+)*|[A-Z]\.\d+(?:\.\d+)*|[IVXLCDM]+)[.:]\s*$/i.test(
        c.lines[0]
      )
    )
      kind = captionKind(`${c.lines[0]} ${c.lines[1]}`)
    // A page-start figure label can be mistaken for a caption when a prior
    // page's legend continues into ordinary body text.  A caption that owns
    // almost an entire column needs same-page graphic evidence; without it,
    // keep the candidate out of figure association rather than emitting a
    // caption-only figure whose rectangle swallows prose.
    const bodySizedWithoutGraphic =
      kind === 'figure' &&
      c.rect[1] < page.height * 0.2 &&
      c.rect[3] > page.height * 0.75 &&
      c.lines.length >= 12 &&
      !(page.graphicsBounds ?? []).some((graphic) => {
        const rect = figureGraphicRect(page, graphic)
        return (
          rect &&
          rect[3] <= c.rect[1] + page.height * 0.05 &&
          area(rect) > page.width * page.height * 0.02
        )
      })
    return (
      (kind === 'figure' ||
        nativePhotographCaption(page, c, rules) ||
        nativeUnpunctuatedRasterCaption(page, c, rules) ||
        nativeCaptionedRasterArrayFragment(page, c, pageCaptions, tableRects)) &&
      !bodySizedWithoutGraphic &&
      !/\(facing page\)/i.test(c.lines.join(' '))
    )
  })
  const legendHeading = page.lines.find((l) => /^(?:Figure )?legends$/i.test(l.text.trim()))
  if (
    legendHeading &&
    captions.length >= 2 &&
    captions.every((c) => c.rect[1] > legendHeading.y + legendHeading.height) &&
    !(page.graphicsBounds ?? []).some((g) => g.kind === 'image' && area(g.normalizedRect) > 0.03)
  )
    return captions.map((caption) => ({ caption, reason: 'no-unambiguous-adjacent-graphics' }))
  // A page-sized raster overlay can surround a separate, directly captioned
  // image. Its extent includes native running heads and the legend, and must
  // not replace the independent figure image. Keep the original painted PDF.
  if (page.graphicsBounds)
    page = {
      ...page,
      graphicsBounds: page.graphicsBounds.filter((g) => {
        const r = g.normalizedRect
        if (g.kind !== 'image' || r[2] - r[0] < 0.85 || r[3] - r[1] < 0.8) return true
        return !captions.some((c) => {
          const cr = c.rect.map((v, n) => v / (n % 2 ? page.height : page.width))
          return (
            intersection(r, cr) / area(cr) > 0.95 &&
            page.graphicsBounds.some((inner) => {
              const b = inner.normalizedRect
              return (
                inner !== g &&
                inner.kind === 'image' &&
                inner.imageHash &&
                area(b) > 0.1 &&
                intersection(r, b) / area(b) > 0.99 &&
                b[3] <= cr[1] + 1 / 256 &&
                cr[1] - b[3] < 0.025 &&
                b[0] >= cr[0] - 0.1 &&
                b[2] <= cr[2] + 0.15
              )
            })
          )
        })
      })
    }
  if (!page.graphicsBounds)
    return captions.map((caption) => ({ caption, reason: 'graphics-not-recorded' }))
  const nativeHead = nativeFigureRunningHead(page, pageCaptions, nativeTokens, rules, tableRects)
  if (nativeHead)
    page = {
      ...page,
      lines: page.lines.filter((l) => !nativeHead.lines.includes(l)),
      graphicsBounds: page.graphicsBounds.filter(
        (g) => g !== nativeHead.bar && !nativeHead.decorations.includes(g)
      )
    }
  assert(
    Number.isSafeInteger(page.invalidGraphicsBounds) && page.invalidGraphicsBounds >= 0,
    'Rerun the structure probe to record invalid graphics bounds explicitly.'
  )
  // Two small facing masthead images flank the journal title and homepage.
  // Native directory/homepage anchors distinguish this band from plot panels.
  const masthead = page.graphicsBounds.filter(
    (g) =>
      g.kind === 'image' &&
      g.normalizedRect[1] > 0.04 &&
      g.normalizedRect[3] < 0.2 &&
      area(g.normalizedRect) < 0.02
  )
  if (
    masthead.length === 2 &&
    masthead.some((g) => g.normalizedRect[2] < 0.2) &&
    masthead.some((g) => g.normalizedRect[0] > 0.8) &&
    Math.abs(masthead[0].normalizedRect[3] - masthead[1].normalizedRect[3]) < 0.01 &&
    page.lines.some(
      (l) => l.y < page.height * 0.12 && /^Contents lists available at\b/i.test(l.text)
    ) &&
    page.lines.some(
      (l) =>
        l.y < page.height * 0.2 &&
        /^journalhomepage:(?:https?:\/\/)?www\./i.test(l.text.replace(/\s/g, ''))
    ) &&
    captions.every((c) => c.rect[1] > page.height * 0.2) &&
    page.graphicsBounds.some(
      (g) => g.kind === 'image' && area(g.normalizedRect) > 0.03 && g.normalizedRect[1] > 0.2
    )
  )
    page = {
      ...page,
      graphicsBounds: page.graphicsBounds.filter(
        (g) => !masthead.includes(g) && !(g.kind === 'path' && g.normalizedRect[3] <= 0.2)
      ),
      lines: page.lines.filter((l) => l.y + l.height > page.height * 0.2)
    }
  const marginal = associateMarginalFigurePlates(page, captions, tableRects, rules)
  if (marginal) return marginal
  const openArray = nativeOpenAxisArray(page, captions, tableRects, rules)
  if (openArray) return [openArray]
  const nativeArray = nativeFramedPanelArray(page, captions, tableRects, rules)
  if (nativeArray) {
    // A strict image+frame match must get first ownership on stacked pages.
    // The broad framed-panel recognizer can otherwise claim the preceding
    // caption and return one shared crop before the per-caption association
    // pass has a chance to separate adjacent plates.
    const strictMatches = captions
      .map((caption) => {
        const match =
          nativeCaptionedFramedRasterTextPanel(page, caption, captions, tableRects) ??
          nativeCaptionedRasterVectorCompositeGrid(page, caption, captions, tableRects) ??
          nativeCaptionedMixedWorkflowPanel(page, caption, captions, tableRects) ??
          nativeCaptionedRasterCompositeGrid(page, caption, captions, tableRects, nativeTokens) ??
          nativeCaptionedRasterHorizontalArray(page, caption, captions, tableRects) ??
          nativeCaptionedRasterSideBySide(page, caption, captions, tableRects) ??
          nativeCaptionedFramedRaster(page, caption, captions, tableRects) ??
          nativeCaptionedVectorHeatmap(page, caption, captions, tableRects) ??
          nativeCaptionedWorkflowPanel(page, caption, captions, tableRects) ??
          nativeCaptionedVectorDiagram(page, caption, captions, tableRects) ??
          nativeCaptionedVectorTableGrid(page, caption, captions, tableRects) ??
          nativeCaptionedVectorChartStrip(
            page,
            caption,
            captions,
            tableRects,
            nativeTokens,
            closedFrames
          ) ??
          nativeCaptionedVectorGrid(page, caption, captions, tableRects)
        return match
          ? nativeAttachedPlotLabels(page, match, captions, tableRects, rules, nativeTokens)
          : undefined
      })
      .filter(Boolean)
    if (strictMatches.length) {
      const strictCaptions = new Set(strictMatches.map((match) => match.caption))
      const remainingCaptions = captions.filter((caption) => !strictCaptions.has(caption))
      const remainingArray = nativeFramedPanelArray(page, remainingCaptions, tableRects, rules)
      if (remainingArray) {
        const labels = nativeOwnedFigureLabels(
          page,
          remainingArray.caption,
          remainingCaptions,
          tableRects,
          remainingArray.rect
        )
        return [
          ...strictMatches,
          { ...remainingArray, rect: union([remainingArray.rect, ...labels.map(lineRect)]) }
        ]
      }
    } else {
      const labels = nativeOwnedFigureLabels(
        page,
        nativeArray.caption,
        captions,
        tableRects,
        nativeArray.rect
      )
      return [{ ...nativeArray, rect: union([nativeArray.rect, ...labels.map(lineRect)]) }]
    }
  }
  // Some plates include a blank caption strip in the raster's bounds. A
  // native frame and an overlaid caption establish ownership independently
  // of the ordinary non-overlapping graphic/caption distance heuristic.
  const framed = captions.map((caption) => {
    const matches = page.graphicsBounds.filter((g) => {
      if (g.kind !== 'image') return false
      const r = g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
      return (
        area(r) > page.width * page.height * 0.02 &&
        caption.rect[1] > r[1] + (r[3] - r[1]) * 0.65 &&
        caption.rect[1] < r[3] &&
        caption.rect[3] <= r[3] + edgeTolerance &&
        caption.rect[0] >= r[0] - edgeTolerance * 2 &&
        caption.rect[2] <= r[2] + edgeTolerance * 2 &&
        !tableRects.some((t) => intersection(t, r) / area(r) > 0.2) &&
        page.graphicsBounds.some((frame) => {
          const b = frame.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
          return (
            frame.kind === 'path' &&
            area(b) < area(r) * 1.25 &&
            intersection(b, r) / area(r) > 0.95 &&
            intersection(b, caption.rect) / area(caption.rect) > 0.9
          )
        })
      )
    })
    if (matches.length !== 1) return undefined
    const rect = matches[0].normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
    rect[3] = caption.rect[1] - 1
    return { caption, rect, graphicsCount: 1 }
  })
  if (framed.length && framed.every(Boolean)) return framed
  // A caption can be above a framed flowchart. Require a frame containing
  // several substantial nodes and their connecting paths, not a prose box.
  if (captions.length === 1) {
    const caption = captions[0]
    const paths = page.graphicsBounds
      .filter((g) => g.kind === 'path')
      .map((g) => g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)))
    const frames = paths.filter(
      (r) =>
        intersection(r, caption.rect) / area(caption.rect) > 0.9 &&
        caption.rect[3] - r[1] < (r[3] - r[1]) * 0.15 &&
        r[3] - caption.rect[3] > page.height * 0.25 &&
        !tableRects.some((t) => intersection(t, r) > 0)
    )
    for (const frame of frames) {
      const interior = paths.filter(
        (r) => r !== frame && r[1] >= caption.rect[3] && intersection(r, frame) / area(r) > 0.99
      )
      const separator = interior.find(
        (r) =>
          r[3] - r[1] < edgeTolerance * 3 &&
          r[2] - r[0] > (frame[2] - frame[0]) * 0.85 &&
          r[1] - caption.rect[3] < 12
      )
      if (
        separator &&
        interior.length >= 20 &&
        union(interior)[3] - separator[3] > (frame[3] - frame[1]) * 0.6
      )
        return [
          {
            caption,
            rect: [frame[0], separator[3], frame[2], frame[3]],
            graphicsCount: interior.length
          }
        ]
      if (!/\b(?:flowchart|flow diagram|CONSORT)\b/i.test(caption.lines.join(' '))) continue
      const nodes = paths.filter(
        (r) =>
          r !== frame &&
          r[1] >= caption.rect[3] &&
          intersection(r, frame) / area(r) > 0.99 &&
          r[2] - r[0] > (frame[2] - frame[0]) * 0.6 &&
          r[3] - r[1] > 8 &&
          r[3] - r[1] < 50
      )
      const connectors = paths.filter(
        (r) =>
          r[1] >= caption.rect[3] &&
          intersection(r, frame) / area(r) > 0.99 &&
          r[2] - r[0] < 15 &&
          r[3] - r[1] > 5
      )
      if (nodes.length >= 4 && connectors.length >= nodes.length - 1)
        return [
          {
            caption,
            rect: [frame[0], Math.min(...nodes.map((r) => r[1])), frame[2], frame[3]],
            graphicsCount: nodes.length + connectors.length
          }
        ]
    }
  }
  const connectedFlowchart =
    captions.length === 1 && associateConnectedFlowchart(page, pageCaptions, tableRects)
  if (connectedFlowchart) return connectedFlowchart
  const nativeTopFlow =
    captions.length === 1 &&
    topCaptionedNativeFlow(page, captions[0], pageCaptions, tableRects, closedFrames)
  if (nativeTopFlow) return [nativeTopFlow]
  const standalone =
    associateRuledFigurePlate(page, pageCaptions, tableRects, rules) ??
    associateStandaloneFigurePlate(page, pageCaptions, tableRects)
  if (standalone) return [standalone]
  const flowchart = captions.length === 1 && associateFlowchart(page, captions, tableRects)
  if (flowchart) return flowchart
  // Repeated margin removal keeps native publisher rules as evidence. A small
  // raster wholly above that rule is page furniture when an independent plate
  // starts below it; figure legends and inset keys inside the plate stay intact.
  const marginHeaders = (page.marginRuleBounds ?? []).filter(
    (r) => r[1] > 0.03 && r[3] < 0.09 && r[2] - r[0] > 0.8 && r[3] - r[1] < 0.02
  )
  if (marginHeaders.length === 1) {
    const band = marginHeaders[0]
    if (
      page.graphicsBounds.some(
        (g) => g.kind === 'image' && area(g.normalizedRect) < 0.02 && g.normalizedRect[3] <= band[3]
      ) &&
      page.graphicsBounds.some(
        (g) => g.kind === 'image' && area(g.normalizedRect) > 0.08 && g.normalizedRect[1] > band[3]
      ) &&
      captions.every((c) => c.rect[1] > band[3] * page.height)
    )
      page = {
        ...page,
        graphicsBounds: page.graphicsBounds.filter((g) => g.normalizedRect[3] > band[3])
      }
  }
  // A small logo above several joined header strokes forms page furniture
  // when a separate substantial raster starts below the complete header band.
  const headerPaths = page.graphicsBounds.filter(
    (g) =>
      g.kind === 'path' &&
      g.normalizedRect[3] < 0.09 &&
      g.normalizedRect[1] > 0.03 &&
      g.normalizedRect[3] - g.normalizedRect[1] < 0.02 &&
      g.normalizedRect[2] - g.normalizedRect[0] > 0.05
  )
  if (headerPaths.length >= 2) {
    const band = union(headerPaths.map((g) => g.normalizedRect))
    const ordered = headerPaths.map((g) => g.normalizedRect).sort((a, b) => a[0] - b[0])
    if (
      band[2] - band[0] > 0.8 &&
      band[3] - band[1] < 0.02 &&
      ordered.every((r, n) => !n || r[0] - ordered[n - 1][2] < 0.01) &&
      page.graphicsBounds.some(
        (g) =>
          g.kind === 'image' &&
          area(g.normalizedRect) < 0.01 &&
          g.normalizedRect[3] <= band[3] &&
          g.normalizedRect[1] > 0.01
      ) &&
      page.graphicsBounds.some(
        (g) => g.kind === 'image' && area(g.normalizedRect) > 0.08 && g.normalizedRect[1] >= band[3]
      ) &&
      captions.every((c) => c.rect[1] > band[3] * page.height)
    )
      page = {
        ...page,
        graphicsBounds: page.graphicsBounds.filter((g) => g.normalizedRect[3] > band[3])
      }
  }
  const assigned = captions.map(() => [])
  const panelAssignments = []
  // A numbered running author head establishes a page-furniture band. Some
  // publisher logos extend slightly below the text baseline or closing rule.
  const numberedAuthorHead =
    page.lines.some(
      (l) =>
        l.y < page.height * 0.06 &&
        /\bet al\./i.test(l.text) &&
        new RegExp('^[|｜]?\\s*' + page.pageNumber + '(?=\\D|$)').test(l.text.trim())
    ) ||
    page.lines.some(
      (l) =>
        l.y < page.height * 0.06 &&
        l.height < page.height * 0.025 &&
        /\bet al\./i.test(l.text) &&
        page.lines.some(
          (n) =>
            n.y < page.height * 0.06 &&
            /^(?:\d{1,4}(?: of \d{1,4})?)(?:\s|$|[A-Z])/.test(n.text) &&
            Math.abs(n.y - l.y) < Math.max(n.height, l.height)
        )
    ) ||
    (page.marginRuleBounds?.some((r) => r[3] < 0.07 && r[2] - r[0] > 0.8) &&
      page.lines.some(
        (l) => l.y < page.height * 0.06 && /^(?:\d+ of \d+|\d{1,4}\s*[|｜])$/.test(l.text.trim())
      ))
  page = {
    ...page,
    graphicsBounds: page.graphicsBounds.filter(
      (g) =>
        !(
          g.kind === 'path' &&
          g.normalizedRect[0] === 0 &&
          g.normalizedRect[2] === 1 &&
          g.normalizedRect[1] === 0 &&
          g.normalizedRect[3] < 0.1 &&
          page.graphicsBounds.some(
            (p) =>
              p.kind === 'image' &&
              p.normalizedRect[1] > g.normalizedRect[3] &&
              area(p.normalizedRect) > 0.1
          )
        )
    )
  }

  // Author and journal running heads can be separate text runs on one line.
  // Require both distant columns above every caption and outside raster ink;
  // an author-like label inside a panel is still figure content.
  const splitHeader = page.lines.find(
    (line) =>
      line.y < page.height * 0.06 &&
      line.x < page.width * 0.25 &&
      /(?:\bet al\.?$|^[A-Z]\.\s*\p{L}.*,)/iu.test(line.text.trim()) &&
      pageCaptions.every((c) => c.rect[1] > line.y + line.height) &&
      page.lines.some(
        (other) =>
          other.x > page.width * 0.6 &&
          /\d/.test(other.text) &&
          Math.abs(other.y - line.y) < Math.max(line.height, other.height) * 0.25
      ) &&
      !page.graphicsBounds.some(
        (g) =>
          g.kind === 'image' &&
          intersection(
            lineRect(line),
            g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
          ) > 0
      )
  )
  const authorBands = page.graphicsBounds.filter((g) => {
    const r = g.normalizedRect
    return (
      g.kind === 'path' &&
      r[3] < 0.125 &&
      r[3] - r[1] < 0.04 &&
      r[2] - r[0] > 0.6 &&
      page.lines.some(
        (l) =>
          /\bet al\./i.test(l.text) &&
          l.width > page.width * 0.5 &&
          intersection(
            lineRect(l),
            r.map((v, n) => v * (n % 2 ? page.height : page.width))
          ) /
            area(lineRect(l)) >
            0.95
      ) &&
      !page.graphicsBounds.some(
        (p) => p.kind === 'image' && intersection(p.normalizedRect, r) > 0
      ) &&
      pageCaptions.every((c) => c.rect[1] > r[3] * page.height)
    )
  })
  const runningHeaders = page.lines.filter(
    (line) =>
      line.y < page.height * 0.125 &&
      ((/\bet al\./i.test(line.text) &&
        ((line.y < page.height * 0.06 &&
          new RegExp('^[|｜]?\\s*' + page.pageNumber + '(?=\\D|$)').test(line.text.trim())) ||
          authorBands.some(
            (g) =>
              intersection(
                lineRect(line),
                g.normalizedRect.map((v, n) => v * (n % 2 ? page.height : page.width))
              ) /
                area(lineRect(line)) >
              0.95
          ))) ||
        (line.width > page.width * 0.8 &&
          /\bet al\./i.test(line.text) &&
          /\b(?:19|20)\d{2}\b/.test(line.text)) ||
        (line.width > page.width * 0.6 &&
          /\bet al\.?\s+\d+$/.test(line.text.trim()) &&
          Number(/\d+$/.exec(line.text.trim())?.[0]) === page.pageNumber) ||
        (/\b(?:19|20)\d{2}\b/.test(line.text) &&
          /\bPage\s+\d+\s+of\s+\d+\b/i.test(line.text) &&
          line.width > page.width * 0.6) ||
        (splitHeader &&
          (line === splitHeader || line.x > page.width * 0.6) &&
          Math.abs(line.y - splitHeader.y) < Math.max(line.height, splitHeader.height) * 0.25))
  )
  for (const number of page.lines.filter(
    (line) =>
      line.text.trim() === String(page.pageNumber) &&
      line.y < page.height * 0.08 &&
      (line.x < page.width * 0.15 || line.x > page.width * 0.85)
  )) {
    const titles = page.lines.filter(
      (line) =>
        line !== number &&
        line.text.length >= 40 &&
        line.width > page.width * 0.3 &&
        line.fontSize > 0 &&
        line.fontSize <= number.fontSize &&
        Math.abs(line.y + line.height - number.y - number.height) < line.fontSize * 0.1 &&
        !pageCaptions.some((c) => intersection(c.rect, lineRect(line)) > 0) &&
        page.graphicsBounds.some(
          (g) =>
            area(g.normalizedRect) > 0.02 &&
            g.normalizedRect[1] * page.height > line.y + line.height + line.fontSize * 2
        ) &&
        !page.graphicsBounds.some(
          (g) =>
            area(g.normalizedRect) > 0.02 &&
            intersection(
              lineRect(line),
              g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
            ) > 0
        )
    )
    if (titles.length === 1) runningHeaders.push(number, ...titles)
  }
  for (const line of page.lines) {
    // Repeated-margin cleanup can remove a quantized path while retaining its
    // native closing rule. Require one complete rule and a separate raster;
    // text over image ink remains a figure label.
    const nativeClosings = rules.filter(
      (r) =>
        r[1] === r[3] &&
        r[0] <= page.width * 0.1 &&
        r[2] >= page.width * 0.9 &&
        r[1] >= line.y + line.height &&
        r[1] - line.y - line.height < line.height * 0.25
    )
    const nativeHeader =
      nativeClosings.length === 1 &&
      page.graphicsBounds.some(
        (g) =>
          g.kind === 'image' &&
          area(g.normalizedRect) > 0.1 &&
          g.normalizedRect[1] * page.height > nativeClosings[0][1] + line.height * 0.5 &&
          g.normalizedRect[1] * page.height < nativeClosings[0][1] + line.height * 2
      )
    if (
      line.y < page.height * 0.04 &&
      line.height < page.height * 0.015 &&
      !pageCaptions.some((c) => intersection(c.rect, lineRect(line)) > 0) &&
      (nativeHeader ||
        page.graphicsBounds.some(
          (g) =>
            g.kind === 'path' &&
            g.normalizedRect[2] - g.normalizedRect[0] > 0.6 &&
            g.normalizedRect[3] - g.normalizedRect[1] < 0.02 &&
            g.normalizedRect[3] < 0.07 &&
            g.normalizedRect[3] * page.height >= line.y + line.height &&
            g.normalizedRect[3] * page.height - line.y - line.height < line.height * 2
        )) &&
      !page.graphicsBounds.some(
        (g) =>
          g.kind === 'image' &&
          intersection(
            lineRect(line),
            g.normalizedRect.map((v, n) => v * (n % 2 ? page.height : page.width))
          ) > 0
      )
    )
      runningHeaders.push(line)
  }
  const datedHeader = page.lines.find(
    (line) =>
      line.y < page.height * 0.12 &&
      /^(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{4}\s+/.test(
        line.text
      ) &&
      line.width > page.width * 0.65 &&
      page.lines.some(
        (other) =>
          /^\d{1,4}$/.test(other.text.trim()) &&
          other.x >= line.x + line.width &&
          Math.abs(other.y + other.height - line.y - line.height) < 1
      )
  )
  if (datedHeader)
    runningHeaders.push(
      datedHeader,
      ...page.lines.filter(
        (line) =>
          /^\d{1,4}$/.test(line.text.trim()) &&
          Math.abs(line.y + line.height - datedHeader.y - datedHeader.height) < 1
      )
    )
  const rasterPlates = page.graphicsBounds
    .filter((g) => g.kind === 'image' && area(g.normalizedRect) >= 0.1)
    .map((g) => g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)))
  // Adjustment notes beneath a survival plot are figure content. Their explicit
  // statistical label, small type and continuous gap to its caption distinguish
  // them from an intervening paragraph of article prose.
  const figureNotes = new Set()
  for (const caption of captions) {
    if (!/Kaplan[–-]Meier|survival/i.test(caption.lines.join(' '))) continue
    const before = page.lines
      .filter(
        (l) =>
          l.y + l.height <= caption.rect[1] &&
          caption.rect[1] - l.y <= 48 &&
          l.x >= caption.rect[0] - 4 &&
          l.x + l.width <= caption.rect[2] + 4
      )
      .sort((a, b) => a.y - b.y)
    const start = before.findIndex((l) => /^HR\s+adjusted\s+for\b/i.test(l.text.trim()))
    if (start < 0) continue
    const notes = before.slice(start)
    if (
      notes.length > 3 ||
      notes.some(
        (l, i) =>
          l.fontSize > 9 ||
          Math.abs(l.fontSize - notes[0].fontSize) > 0.5 ||
          (i && (l.y - before[start + i - 1].y > l.height * 1.6 || Math.abs(l.x - notes[0].x) > 2))
      ) ||
      caption.rect[1] - notes.at(-1).y - notes.at(-1).height > notes[0].height * 2 ||
      !page.graphicsBounds.some(
        (g) =>
          g.kind === 'image' &&
          g.normalizedRect[2] - g.normalizedRect[0] > 0.5 &&
          Math.abs(g.normalizedRect[3] * page.height - notes[0].y) <= notes[0].height
      )
    )
      continue
    for (const line of notes) figureNotes.add(line)
  }
  const axisTitle = (line) =>
    line.fontSize <= 8 &&
    line.height <= line.fontSize * 1.5 &&
    (/^(.{3,50}?)(?:\s*\1){2,}$/.test(line.text.trim()) ||
      page.lines.some(
        (tick) =>
          /^[−-]?\d+(?:\.\d+)?(?:\s+[−-]?\d+(?:\.\d+)?)*$/.test(tick.text.trim()) &&
          tick.y + tick.height <= line.y &&
          line.y - tick.y - tick.height <= line.fontSize * 2 &&
          tick.x >= line.x - 24 &&
          tick.x + tick.width <= line.x + line.width + 24
      )) &&
    page.graphicsBounds.some(
      (g) =>
        (g.kind === 'path' ||
          (g.kind === 'image' &&
            g.normalizedRect[0] * page.width < line.x + line.width &&
            g.normalizedRect[2] * page.width > line.x)) &&
        g.normalizedRect[1] * page.height < line.y &&
        line.y - g.normalizedRect[3] * page.height < line.fontSize * 5 &&
        (g.normalizedRect[2] - g.normalizedRect[0]) * page.width > 40 &&
        g.normalizedRect[3] * page.height <= line.y + edgeTolerance
    )
  // Outlined glyphs provide label evidence even when the PDF has no text run.
  // Require a cluster of small, enclosed paths; empty frames cannot qualify.
  const outlinedGlyphs = page.graphicsBounds
    .filter((g) => g.kind === 'path')
    .map((g) => g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)))
    .filter((r) => r[2] - r[0] >= 1 && r[2] - r[0] <= 12 && r[3] - r[1] >= 2 && r[3] - r[1] <= 12)
  const diagramFrames = page.graphicsBounds
    .filter((g) => g.kind === 'path' && area(g.normalizedRect) < 0.08)
    .map((g) => g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)))
    .filter(
      (r) =>
        r[3] - r[1] >= 12 &&
        r[2] - r[0] >= 30 &&
        r[1] < page.height * 0.9 &&
        !candidates.some((c) => c.page === page.pageNumber && intersection(c.rect, r) > 0) &&
        (page.lines.some(
          (line) =>
            line.y >= r[1] &&
            line.y + line.height <= r[3] &&
            intersection(lineRect(line), r) / (Math.min(line.width, r[2] - r[0]) * line.height) >
              0.8
        ) ||
          outlinedGlyphs.filter((glyph) => intersection(glyph, r) / area(glyph) > 0.95).length >= 8)
    )
  // Several drawing operations may describe the same plot frame.
  // Require three distinct boxes before treating enclosed prose as diagram labels.
  for (let i = diagramFrames.length - 1; i > 0; i--)
    if (
      diagramFrames
        .slice(0, i)
        .some(
          (r) => intersection(r, diagramFrames[i]) / Math.min(area(r), area(diagramFrames[i])) > 0.8
        )
    )
      diagramFrames.splice(i, 1)
  const framedDiagramText = (line) =>
    diagramFrames.length >= 3 &&
    (diagramFrames.some((r) => intersection(lineRect(line), r) / area(lineRect(line)) > 0.8) ||
      diagramFrames.reduce((sum, r) => sum + intersection(lineRect(line), r), 0) /
        area(lineRect(line)) >
        0.8)
  // A framed flowchart may carry a long explanatory note below its boxes.
  // Require the explicit note, closing border and both enclosing side borders.
  if (diagramFrames.length >= 3)
    for (const caption of captions) {
      if (!/CONSORT|flowchart/i.test(caption.lines.join(' '))) continue
      const before = page.lines
        .filter((l) => l.y + l.height <= caption.rect[1] && caption.rect[1] - l.y < 48)
        .sort((a, b) => a.y - b.y)
      const start = before.findIndex((l) => /^Note:\s/i.test(l.text))
      if (start < 0) continue
      const note = before.slice(start)
      if (
        note.length > 3 ||
        note.some(
          (l, n) =>
            Math.abs(l.x - note[0].x) > 2 ||
            l.fontSize > 9 ||
            Math.abs(l.fontSize - note[0].fontSize) > 0.5 ||
            (n && l.y - note[n - 1].y > l.height * 1.8)
        )
      )
        continue
      const paths = page.graphicsBounds
        .filter((g) => g.kind === 'path')
        .map((g) => g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)))
      const border = paths.find(
        (r) =>
          r[2] - r[0] > page.width * 0.65 &&
          r[3] - r[1] < page.height * 0.015 &&
          r[1] >= note.at(-1).y &&
          r[3] <= caption.rect[1] + page.height / 128 &&
          r[0] <= note[0].x &&
          r[2] >= note[0].x + note[0].width
      )
      if (!border) continue
      const sides = paths.filter(
        (r) =>
          r[2] - r[0] < page.width * 0.02 &&
          r[3] - r[1] > page.height * 0.15 &&
          r[3] >= border[1] &&
          r[1] < note[0].y
      )
      if (
        ![border[0], border[2]].every((x) =>
          sides.some((r) => Math.abs((r[0] + r[2]) / 2 - x) < page.width * 0.015)
        )
      )
        continue
      if (
        diagramFrames.filter((r) => r[0] >= border[0] && r[2] <= border[2] && r[3] < note[0].y)
          .length < 3
      )
        continue
      for (const line of note) figureNotes.add(line)
    }
  // Native axis titles can span several raster panels in one PDF text run.
  // The same tick/graphic evidence applies to raster and vector associations.
  // Dense risk-count rows are plot labels, not paragraph barriers. Establish
  // the block before assigning graphics, since those rows separate the axes
  // from the caption. Require a heading, two baselines and numeric-only runs.
  const riskRows = new Set()
  for (const heading of page.lines.filter((l) =>
    /^(?:n|No\.?|Number|Patients)(?: of(?: patients| subjects)?)?(?: still)? at risk\b/i.test(
      l.text.trim()
    )
  )) {
    const rows = page.lines.filter(
      (l) =>
        /^(?:\d+\s+){2,}\d+$/.test(l.text.trim()) &&
        l.y > heading.y &&
        l.y - heading.y <= heading.fontSize * 8 &&
        l.fontSize >= heading.fontSize * 0.5 &&
        l.fontSize <= heading.fontSize * 1.1 &&
        l.x >= heading.x - heading.fontSize * 2 &&
        !tableRects.some((r) => intersection(r, lineRect(l)) > 0)
    )
    for (const row of rows)
      if (
        rows.some(
          (other) =>
            other !== row &&
            Math.abs(other.y - row.y) >= row.height &&
            Math.abs(other.y - row.y) <= row.height * 3 &&
            Math.abs(other.x - row.x) <= row.fontSize * 4
        )
      )
        riskRows.add(row)
  }
  for (const row of [...riskRows])
    for (const tick of page.lines)
      if (
        /^(?:\d+\s+){5,}\d+$/.test(tick.text.trim()) &&
        tick.y < row.y &&
        row.y - tick.y <= tick.fontSize * 6 &&
        Math.abs(tick.x - row.x) <= tick.fontSize * 2 &&
        Math.abs(tick.width - row.width) <= tick.fontSize * 6
      )
        riskRows.add(tick)
  // Long panel titles can look like prose. Repeated tall native axis titles and
  // the caption's explicit panel keys establish their ownership before barriers
  // are built; an unlabelled chart or an ordinary paragraph cannot qualify.
  const multiPanelCaptions = captions.filter(
    (c) => new Set([...c.lines.join(' ').matchAll(/\(([a-z])\)/g)].map((m) => m[1])).size >= 4
  )
  const verticalAxes = page.lines.filter(
    (l) =>
      l.fontSize > 0 &&
      l.fontSize <= 8 &&
      Math.abs(l.width - l.fontSize) < l.fontSize * 0.2 &&
      l.height > l.fontSize * 8
  )
  const panelTitle = (line) =>
    multiPanelCaptions.some((caption) => {
      const axes = verticalAxes.filter(
        (axis) =>
          axis.y > line.y + line.height &&
          axis.y - line.y - line.height < line.fontSize * 4 &&
          axis.x < line.x &&
          line.x - axis.x < line.fontSize * 6 &&
          axis.y + axis.height < caption.rect[1] &&
          verticalAxes.filter(
            (other) => other.text === axis.text && Math.abs(other.fontSize - axis.fontSize) < 0.2
          ).length >= 4
      )
      return (
        line.fontSize <= 8 &&
        line.height < line.fontSize * 1.2 &&
        line.width < page.width * 0.4 &&
        axes.length === 1 &&
        page.lines.some(
          (label) =>
            /^[a-z](?:\s+[a-z])*$/.test(label.text.trim()) &&
            label.text
              .trim()
              .split(/\s+/)
              .every((key) => caption.lines.join(' ').includes(`(${key})`)) &&
            label.y + label.height <= line.y + 1 &&
            line.y - label.y - label.height <= line.fontSize * 2 &&
            label.x < line.x + line.width &&
            label.x + label.width > line.x - line.fontSize
        )
      )
    })
  const barriers = page.lines.filter(
    (l) =>
      l.text.length > 80 &&
      !axisTitle(l) &&
      !panelTitle(l) &&
      !ownedRasterKeyBand(l, page, pageCaptions) &&
      !figureNotes.has(l) &&
      !riskRows.has(l)
  )
  const ownedOverlayLines = nativeOverlayDiagramLines(
    page,
    pageCaptions,
    tableRects,
    nativeTokens,
    operatorContext
  )
  const pathBarriers = page.lines.filter(
    (l) =>
      l.text.length > 60 &&
      !axisTitle(l) &&
      !panelTitle(l) &&
      !ownedRasterKeyBand(l, page, pageCaptions) &&
      !figureNotes.has(l) &&
      !riskRows.has(l) &&
      !ownedOverlayLines.has(l) &&
      !framedDiagramText(l)
  )
  const wideRules = page.graphicsBounds
    .filter(
      (g) =>
        g.kind === 'path' &&
        g.normalizedRect[2] - g.normalizedRect[0] >= 0.8 &&
        g.normalizedRect[3] - g.normalizedRect[1] <= 0.015
    )
    .map((g) => g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)))
  const separators = wideRules.filter((r) =>
    [
      ...wideRules,
      ...(page.marginRuleBounds ?? []).map((r) =>
        r.map((v, i) => v * (i % 2 ? page.height : page.width))
      )
    ].some(
      (margin) =>
        (margin[3] <= page.height * 0.07 || margin[1] >= page.height * 0.95) &&
        Math.abs(r[0] - margin[0]) <= page.width / 128 &&
        Math.abs(r[2] - margin[2]) <= page.width / 128
    )
  )
  // A side legend can sit beyond the plotted axes, with only its legend keys
  // close enough for ordinary adjacency. Orthogonal native axes establish the
  // whole plot before individual marks compete with the preceding caption.
  const axes = page.graphicsBounds
    .filter((g) => g.kind === 'path')
    .map((g) => g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)))
  const sidePlots = captions.map((caption) =>
    axes.flatMap((horizontal) => {
      const width = horizontal[2] - horizontal[0],
        height = horizontal[3] - horizontal[1]
      if (width < page.width * 0.2 || height > edgeTolerance * 3) return []
      return axes
        .filter(
          (vertical) =>
            vertical[3] - vertical[1] > page.height * 0.12 &&
            vertical[2] - vertical[0] < edgeTolerance * 3 &&
            Math.abs(vertical[3] - horizontal[3]) < edgeTolerance * 2 &&
            Math.abs(vertical[0] - horizontal[0]) < edgeTolerance * 2
        )
        .map((vertical) => union([horizontal, vertical]))
        .filter(
          (r) =>
            ((r[2] <= caption.rect[0] && caption.rect[0] - r[2] < page.width * 0.2) ||
              (r[0] >= caption.rect[2] && r[0] - caption.rect[2] < page.width * 0.2)) &&
            Math.min(r[3], caption.rect[3]) - Math.max(r[1], caption.rect[1]) >
              Math.min(r[3] - r[1], caption.rect[3] - caption.rect[1]) * 0.5 &&
            !pageCaptions.some((other) => other !== caption && intersection(other.rect, r) > 0) &&
            !tableRects.some((table) => intersection(table, r) > 0)
        )
    })
  )
  // A side legend can describe a vector chart followed by a raster panel.
  // The far panel exceeds caption-distance limits, but an aligned neighboring
  // axis frame and explicit panel references establish the shared figure.
  for (const [index, caption] of captions.entries()) {
    if (new Set([...caption.lines.join(' ').matchAll(/\(([A-Z])\)/g)].map((m) => m[1])).size < 2)
      continue
    // Some exporters paint both orthogonal axes in one path operation.
    const seeds = [
      ...sidePlots[index],
      ...axes.filter(
        (r) =>
          r[2] - r[0] >= page.width * 0.2 &&
          r[3] - r[1] >= page.height * 0.12 &&
          ((r[0] >= caption.rect[2] && r[0] - caption.rect[2] < page.width * 0.2) ||
            (r[2] <= caption.rect[0] && caption.rect[0] - r[2] < page.width * 0.2)) &&
          Math.min(r[3], caption.rect[3]) - Math.max(r[1], caption.rect[1]) >
            Math.min(r[3] - r[1], caption.rect[3] - caption.rect[1]) * 0.5 &&
          !pageCaptions.some((other) => other !== caption && intersection(other.rect, r) > 0) &&
          !tableRects.some((table) => intersection(table, r) > 0)
      )
    ]
    for (const graphic of page.graphicsBounds) {
      if (graphic.kind !== 'image') continue
      const r = graphic.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
      if (
        r[2] - r[0] < page.width * 0.1 ||
        r[3] - r[1] < page.height * 0.1 ||
        !seeds.some((seed) => {
          const gap = Math.max(r[0] - seed[2], seed[0] - r[2])
          const band = union([seed, r])
          return (
            gap >= 0 &&
            gap <= page.width * 0.12 &&
            Math.abs(r[1] - seed[1]) <= 24 &&
            Math.min(r[3], seed[3]) - Math.max(r[1], seed[1]) >
              Math.min(r[3] - r[1], seed[3] - seed[1]) * 0.75 &&
            (band[0] >= caption.rect[2] || band[2] <= caption.rect[0]) &&
            !pageCaptions.some(
              (other) => other !== caption && intersection(other.rect, band) > 0
            ) &&
            !tableRects.some((table) => intersection(table, band) > 0) &&
            !page.lines.some(
              (line) => line.text.length > 80 && intersection(lineRect(line), band) > 0
            )
          )
        })
      )
        continue
      sidePlots[index].push(r)
    }
  }
  // Match both caption directions; intervening prose/captions block association.
  const fullHeightPublisherStrips = page.graphicsBounds.filter(
    (strip) =>
      strip.kind === 'path' &&
      strip.normalizedRect[1] <= 0.01 &&
      strip.normalizedRect[3] >= 0.99 &&
      (strip.normalizedRect[2] <= 0.06 || strip.normalizedRect[0] >= 0.94)
  )
  for (const graphic of page.graphicsBounds) {
    assert(
      graphic.normalizedRect.every(Number.isFinite),
      'Invalid recorded geometry; rerun the structure probe.'
    )
    const rect = graphic.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
    // A small shaded page-number block touches the bottom outer margin and
    // is separated from every panel. It is not a second graphic direction.
    if (
      graphic.kind === 'path' &&
      rect[1] > page.height * 0.92 &&
      area(rect) < page.width * page.height * 0.002 &&
      rasterPlates.some(
        (plate) =>
          plate[3] < rect[1] - page.height * 0.15 &&
          page.lines.some(
            (l) =>
              l.y > plate[3] &&
              l.y + l.height < rect[1] &&
              continuesExternalParagraph(l, plate, page.lines)
          )
      )
    )
      continue
    if (
      graphic.kind === 'path' &&
      graphic.normalizedRect[0] === 0 &&
      graphic.normalizedRect[1] > 0.92 &&
      graphic.normalizedRect[2] < 0.15 &&
      graphic.normalizedRect[3] - graphic.normalizedRect[1] < 0.06 &&
      rasterPlates.length &&
      rasterPlates.every((r) => r[3] < rect[1] - 60) &&
      page.lines.some((l) => /^\d{1,4}$/.test(l.text.trim()) && intersection(lineRect(l), rect) > 0)
    )
      continue
    // Glyph outlines and text decorations outside a raster can inherit a
    // paragraph's bounds. Aligned native prose supplies independent evidence.
    if (
      graphic.kind === 'path' &&
      rect[3] - rect[1] < 24 &&
      rasterPlates.some(
        (plate) =>
          (rect[3] < plate[1] || rect[1] > plate[3]) &&
          page.lines.some(
            (line) =>
              intersection(lineRect(line), rect) > 0 &&
              continuesExternalParagraph(line, plate, page.lines)
          )
      )
    )
      continue
    if (authorBands.includes(graphic)) continue
    // A running author head can be outlined together with its full-width rule.
    // Require the author text inside the shallow top-margin path above all captions.
    if (
      graphic.kind === 'path' &&
      rect[3] < page.height * 0.07 &&
      rect[3] - rect[1] < page.height * 0.03 &&
      !rasterPlates.some((plate) => intersection(plate, rect) > 0) &&
      rect[2] - rect[0] > page.width * 0.6 &&
      pageCaptions.every((c) => c.rect[1] > rect[3]) &&
      page.lines.some(
        (l) =>
          /\bet al\.?$/i.test(l.text.trim()) &&
          intersection(lineRect(l), rect) / area(lineRect(l)) > 0.95
      )
    )
      continue
    // Outlined section headings have no text run. A shallow box immediately
    // above a complete external prose column is not part of a distant raster.
    if (
      graphic.kind === 'path' &&
      page.lines.some(
        (l) =>
          l.y >= rect[3] &&
          l.y - rect[3] <= l.height &&
          rect[3] - rect[1] <= l.height * 2 &&
          Math.abs(l.x - rect[0]) <= edgeTolerance &&
          rect[2] <= l.x + l.width + edgeTolerance &&
          rasterPlates.some(
            (plate) =>
              rect[1] > plate[3] + 32 && continuesExternalParagraph(l, plate, page.lines, 30)
          )
      )
    )
      continue
    // Full-height publisher strips at the outer edge are page furniture, even
    // when a rotated page makes them appear beside a figure caption.
    if (
      fullHeightPublisherStrips.some(
        (strip) =>
          graphic.normalizedRect[0] >= strip.normalizedRect[0] &&
          graphic.normalizedRect[2] <= strip.normalizedRect[2]
      )
    )
      continue
    if (
      graphic.kind === 'path' &&
      rect[3] - rect[1] < page.height * 0.012 &&
      rect[2] - rect[0] > page.width * 0.6 &&
      runningHeaders.some(
        (line) =>
          rect[1] >= line.y + line.height && rect[1] - line.y - line.height < line.height * 2
      )
    )
      continue
    if (
      graphic.kind === 'path' &&
      rect[2] - rect[0] > (rect[3] - rect[1]) * 4 &&
      rect[3] - rect[1] < page.height * 0.04 &&
      page.lines.some(
        (l) =>
          /^(?:DISCUSSION|RESULTS|PATIENTS AND METHODS|METHODS|CONCLUSIONS|REFERENCES|COMMENT)$/.test(
            l.text.trim()
          ) && intersection(lineRect(l), rect) > 0
      )
    )
      continue
    // An outlined footer can enclose the printed page number. It cannot
    // supply a second figure direction below an otherwise complete plate.
    if (
      graphic.kind === 'path' &&
      rect[1] > page.height * 0.9 &&
      rect[3] - rect[1] < page.height * 0.04 &&
      rect[2] - rect[0] < page.width * 0.15 &&
      (rasterPlates.some((plate) => plate[3] < rect[1] - 24) ||
        (pageCaptions.every((c) => c.rect[3] < rect[1] - 24) &&
          page.lines.some(
            (l) => /©|copyright/i.test(l.text) && Math.abs(l.y - rect[1]) < l.height * 2
          ))) &&
      page.lines.some(
        (line) => /^\d{1,4}$/.test(line.text.trim()) && intersection(lineRect(line), rect) > 0
      ) &&
      !page.lines.some(
        (line) => !/^\d{1,4}$/.test(line.text.trim()) && intersection(lineRect(line), rect) > 0
      )
    )
      continue
    // A frame/background can enclose both a raster plate and its caption. It
    // must not compete with that plate as a second graphic beside the legend.
    if (
      graphic.kind === 'path' &&
      captions.some((c) => intersection(c.rect, rect) > 0) &&
      page.graphicsBounds.some(
        (g) =>
          g.kind === 'image' &&
          area(g.normalizedRect) > 0.02 &&
          intersection(
            rect,
            g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
          ) >=
            area(g.normalizedRect) * page.width * page.height * 0.95
      )
    )
      continue
    // A separate clipping path can wrap several narrow prose columns above a
    // photograph. Their individual lines are shorter than a full-width paragraph.
    if (graphic.kind === 'path' && rect[2] - rect[0] > page.width * 0.5) {
      const plates = rasterPlates.filter(
        (r) => r[1] > rect[3] && r[1] - rect[3] <= 36 && r[0] < rect[2] && r[2] > rect[0]
      )
      if (plates.length) {
        const bounds = union(plates)
        const paragraphs = page.lines.filter(
          (line) =>
            intersection(lineRect(line), rect) / area(lineRect(line)) > 0.7 &&
            !pageCaptions.some((c) => intersection(c.rect, lineRect(line)) > 0) &&
            continuesExternalParagraph(line, bounds, page.lines)
        )
        if (paragraphs.some((a) => paragraphs.some((b) => Math.abs(a.x - b.x) > page.width * 0.15)))
          continue
      }
    }
    // A shaded prose column can contain only short lines, so character count
    // alone does not distinguish it from a panel. Require a dense aligned text
    // block and no interior drawing evidence before discarding its background.
    if (graphic.kind === 'path' && !pageCaptions.some((c) => intersection(c.rect, rect) > 0)) {
      const prose = page.lines.filter(
        (line) =>
          line.text.split(/\s+/).length >= 5 &&
          line.width > (rect[2] - rect[0]) * 0.7 &&
          intersection(lineRect(line), rect) / area(lineRect(line)) > 0.95
      )
      if (
        // Dense point marks cannot enclose six prose lines. Establish that
        // inexpensive condition before scanning the whole page for interior ink.
        prose.some(
          (line) =>
            prose.filter(
              (other) =>
                Math.abs(other.x - line.x) < 2 && Math.abs(other.fontSize - line.fontSize) < 0.5
            ).length >= 6
        ) &&
        !page.graphicsBounds.some((other) => {
          if (other === graphic) return false
          const r = other.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
          return area(r) < area(rect) * 0.9 && intersection(r, rect) / area(r) > 0.95
        })
      )
        continue
    }
    // Text-column frames and clipping paths can enclose entire prose blocks.
    if (
      graphic.kind === 'path' &&
      !captions.some(
        (c) =>
          /\b(?:flowchart|flow diagram|schema|trial profile)\b/i.test(c.lines.join(' ')) &&
          rect[2] - rect[0] > page.width * 0.5 &&
          c.rect[1] >= rect[3] - edgeTolerance &&
          c.rect[1] - rect[3] <= 24 &&
          !pageCaptions.some((other) => other !== c && intersection(other.rect, rect) > 0) &&
          page.graphicsBounds.filter((other) => {
            const r = other.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
            return (
              other !== graphic &&
              other.kind === 'path' &&
              area(r) < area(rect) * 0.5 &&
              intersection(r, rect) / area(r) > 0.95 &&
              r[2] - r[0] >= 8 &&
              r[3] - r[1] >= 8
            )
          }).length >= 3
      ) &&
      page.lines.filter(
        (line) =>
          line.text.length > 80 &&
          intersection(lineRect(line), rect) / area(lineRect(line)) > 0.8 &&
          !pageCaptions.some((c) => intersection(c.rect, lineRect(line)) > 0)
      ).length >= (rect[1] > page.height * 0.9 ? 2 : 3)
    )
      continue
    // Running headers and publisher marks are not figure content.
    if (rect[3] < page.height * (numberedAuthorHead ? 0.07 : 0.055)) continue
    // A narrow bleed tab starts at the physical page edge. It has no labels
    // and is separated from the actual drawing; it cannot anchor a figure.
    if (
      graphic.kind === 'path' &&
      rect[1] <= 0 &&
      rect[3] < page.height * 0.09 &&
      rect[2] - rect[0] < page.width * 0.04 &&
      !page.lines.some((l) => intersection(lineRect(l), rect) > 0) &&
      captions.every((c) => c.rect[1] > rect[3] + 24) &&
      !page.graphicsBounds.some(
        (other) =>
          other !== graphic &&
          area(other.normalizedRect) > 0.02 &&
          intersection(
            rect.map((v, i) => (v + (i < 2 ? -8 : 8)) / (i % 2 ? page.height : page.width)),
            other.normalizedRect
          ) > 0
      )
    )
      continue
    // A very shallow full-width raster at the bottom edge is a footer when
    // an independent plate and its caption finish well above it.
    if (
      graphic.kind === 'image' &&
      rect[1] > page.height * 0.97 &&
      rect[3] - rect[1] < page.height * 0.03 &&
      rect[2] - rect[0] > page.width * 0.5 &&
      captions.length &&
      captions.every((c) => c.rect[3] < rect[1] - 24) &&
      rasterPlates.some((r) => r[3] < rect[1] - 24 && area(r) > page.width * page.height * 0.04)
    )
      continue
    // A full-width raster running head can contain the author and journal art.
    // Require a separate substantial plate and a clear vertical gap below it.
    if (
      graphic.kind === 'image' &&
      rect[1] < page.height * 0.02 &&
      rect[3] < page.height * 0.09 &&
      rect[2] - rect[0] > page.width * 0.9 &&
      rasterPlates.some((r) => r[1] > rect[3] + 24) &&
      page.lines.some(
        (l) => l.text.length >= 8 && l.height < 16 && intersection(lineRect(l), rect) > 0
      )
    )
      continue
    if (graphic.kind === 'path' && rect[1] >= page.height * 0.98) continue
    // Several isolated paragraph rules do not become a tall graphic when unioned.
    // Keep horizontal axes attached to a plate or other substantial drawing.
    if (
      graphic.kind === 'path' &&
      rect[2] - rect[0] >= page.width * 0.3 &&
      rect[3] - rect[1] <= page.height * (0.015 + (rect[1] > page.height * 0.9 ? 1 / 256 : 0)) &&
      !page.graphicsBounds.some((other) => {
        if (other === graphic) return false
        const r = other.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
        return (
          (other.kind === 'image' || r[3] - r[1] > page.height * 0.025) &&
          r[2] - r[0] < page.width * 0.95 &&
          r[3] - r[1] < page.height * 0.95 &&
          intersection([rect[0] - 12, rect[1] - 12, rect[2] + 12, rect[3] + 12], r) > 0
        )
      })
    )
      continue
    // Rules isolated from raster plates are page furniture. Keep axes and borders
    // touching the actual image, and leave vector-only figures to the geometry rules.
    if (
      graphic.kind === 'path' &&
      rasterPlates.length &&
      rect[2] - rect[0] > page.width * 0.3 &&
      rect[3] - rect[1] < page.height * 0.015 &&
      !rasterPlates.some((r) => intersection([r[0] - 8, r[1] - 8, r[2] + 8, r[3] + 8], rect) > 0)
    )
      continue
    // Full-width publisher/section rules are independent separators, not panels.
    // Filtering them individually prevents distant rules from forming a tall
    // fictitious graphic below the caption when their bounds are unioned.
    if (separators.some((r) => r.every((v, i) => v === rect[i]))) continue
    if (graphic.kind === 'path' && nativeTableDividerGraphic(page, rect, tableRects, rules))
      continue
    // Table rules belong to the recognized table, even when a figure caption is closer.
    if (
      tableRects.some(
        (table) =>
          intersection(table, rect) / area(rect) >=
            (graphic.kind === 'path' && rect[2] - rect[0] > (rect[3] - rect[1]) * 8 ? 0.7 : 0.8) ||
          // Quantized path boxes can straddle the refined table's bottom edge.
          // A long closing rule with the same columns still belongs to that table.
          (graphic.kind === 'path' &&
            rect[2] - rect[0] > (rect[3] - rect[1]) * 20 &&
            table[3] - table[1] > (rect[3] - rect[1]) * 8 &&
            Math.abs((rect[1] + rect[3]) / 2 - table[3]) <= page.height / 256 &&
            Math.max(0, Math.min(table[2], rect[2]) - Math.max(table[0], rect[0])) /
              Math.max(table[2] - table[0], rect[2] - rect[0]) >=
              0.85)
      )
    )
      continue
    const eligible = captions
      .map((caption, index) => {
        const c = caption.rect
        const verticalGap = Math.max(c[1] - rect[3], rect[1] - c[3], 0)
        const side = rect[2] <= c[0] ? 'left' : rect[0] >= c[2] ? 'right' : undefined
        const horizontalGap = Math.max(c[0] - rect[2], rect[0] - c[2], 0)
        const sidePlot =
          side &&
          sidePlots[index].some(
            (r) =>
              rect[0] >= r[0] - 48 &&
              (side === 'left' ? rect[2] <= c[0] : rect[0] >= c[2]) &&
              // Recorded graphics are quantized to 1/256 of the page. Include
              // the whole title glyph when its box grazes the upper margin.
              rect[1] >= r[1] - 24 - page.height / 256 &&
              rect[3] <= r[3] + 24
          )
        const framedSide =
          side &&
          page.graphicsBounds.some((g) => {
            const frame = g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
            return (
              g.kind === 'path' &&
              area(frame) < page.width * page.height * 0.35 &&
              intersection(frame, rect) / area(rect) > 0.95 &&
              intersection(frame, c) / area(c) > 0.8
            )
          })
        const beside =
          side &&
          (sidePlot ||
            horizontalGap <=
              (framedSide
                ? page.width * 0.25
                : graphic.kind === 'image' &&
                    area(graphic.normalizedRect) > 0.05 &&
                    c[2] - c[0] < page.width * 0.3 &&
                    Math.min(rect[3], c[3]) - Math.max(rect[1], c[1]) > (c[3] - c[1]) * 0.4
                  ? Math.max(60, page.width * 0.2)
                  : 60)) &&
          verticalGap <= 120
        const shortImageCaption =
          graphic.kind === 'image' &&
          verticalGap <= Math.max(24, Math.min(36, (c[3] - c[1]) * 4)) &&
          ((c[0] >= rect[0] - 24 && c[2] <= rect[2] + 24) ||
            (pageCaptions.length === 1 &&
              rasterPlates.length === 1 &&
              area(rect) > page.width * page.height * 0.15 &&
              rect[2] - rect[0] > page.width * 0.55 &&
              c[1] >= rect[3] &&
              c[0] >= rect[0] - page.width * 0.15 &&
              c[2] <= rect[2]) ||
            // A full-width plate can be inset from a short, margin-aligned legend.
            (rect[2] - rect[0] >= page.width * 0.5 &&
              Math.min(c[2], rect[2]) - Math.max(c[0], rect[0]) >= (c[2] - c[0]) * 0.5) ||
            page.graphicsBounds.some((g) => {
              const frame = g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
              return (
                g.kind === 'path' &&
                intersection(frame, rect) >= area(rect) * 0.95 &&
                intersection(frame, c) >= area(c) * 0.9 &&
                area(frame) < area(rect) * 2.5
              )
            }))
        const labelledRasterPair =
          graphic.kind === 'image' &&
          page.lines.some(
            (l) =>
              /^\(a\)\s+\(b\)$/.test(l.text.trim()) &&
              l.y >= rect[3] &&
              l.y - rect[3] < 16 &&
              c[1] >= l.y + l.height &&
              c[1] - l.y - l.height < 24 &&
              page.graphicsBounds.some((other) => {
                const r = other.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
                return (
                  other !== graphic &&
                  other.kind === 'image' &&
                  Math.abs(r[1] - rect[1]) < 8 &&
                  Math.abs(r[3] - rect[3]) < 8 &&
                  Math.max(r[0] - rect[2], rect[0] - r[2]) <= 24 &&
                  l.x >= Math.min(r[0], rect[0]) &&
                  l.x + l.width <= Math.max(r[2], rect[2]) &&
                  c[0] >= Math.min(r[0], rect[0]) &&
                  c[2] <= Math.max(r[2], rect[2])
                )
              })
          )
        const legendPointer = /see legend on (?:previous|next) page/i.test(caption.lines.join(' '))
        const centeredContinuation =
          /\bContinued?\.?$/i.test(caption.lines.join(' ')) &&
          rect[3] <= c[1] + edgeTolerance &&
          Math.abs((c[0] + c[2]) / 2 - page.width / 2) <= page.width * 0.1
        const unrestrictedCaption =
          graphic.kind === 'path' &&
          ((captions.length === 1 && pageCaptions.length === 1) ||
            (rect[3] <= c[1] &&
              diagramFrames.filter((r) => r[3] <= c[1]).length >= 3 &&
              /\b(?:CONSORT|flowchart|flow diagram)\b/i.test(caption.lines.join(' '))) ||
            /^(?:Fig\.?|Figure)\s+\d+\.?$/i.test(caption.lines.join(' ')))
        const vertical =
          (rect[3] <=
            c[1] +
              (graphic.kind === 'image'
                ? Math.max(edgeTolerance, Math.min(8, (c[3] - c[1]) * 0.8))
                : edgeTolerance) ||
            rect[1] >= c[3] - edgeTolerance) &&
          verticalGap <= page.height * 0.9 &&
          (unrestrictedCaption ||
            legendPointer ||
            centeredContinuation ||
            shortImageCaption ||
            labelledRasterPair ||
            // Centered inset plates can extend past a short margin-aligned caption.
            // Require an immediate caption and substantial horizontal overlap.
            (graphic.kind === 'image' &&
              verticalGap <= 24 &&
              rect[2] - rect[0] >= page.width * 0.3 &&
              Math.abs((rect[0] + rect[2]) / 2 - page.width / 2) < page.width * 0.15 &&
              Math.min(c[2], rect[2]) - Math.max(c[0], rect[0]) >=
                Math.min(c[2] - c[0], rect[2] - rect[0]) * 0.2) ||
            ((rect[0] + rect[2]) / 2 >= c[0] - 24 && (rect[0] + rect[2]) / 2 <= c[2] + 24))
        if (beside && (!vertical || sidePlot)) {
          const corridor = [
            side === 'left' ? rect[2] : c[2],
            Math.min(rect[1], c[1]),
            side === 'left' ? c[0] : rect[0],
            Math.max(rect[3], c[3])
          ]
          const blocked =
            pageCaptions.some(
              (other) =>
                other !== caption &&
                (intersection(other.rect, corridor) > 0 || intersection(other.rect, rect) > 0)
            ) ||
            (graphic.kind === 'path' ? pathBarriers : barriers).some(
              (l) =>
                intersection(lineRect(l), corridor) > 0 &&
                // Adjacent text can touch the caption edge with sub-point
                // rounding noise. Only actual ink inside the gap blocks it.
                Math.min(l.x + l.width, corridor[2]) - Math.max(l.x, corridor[0]) >
                  Math.min(1, l.height * 0.1) &&
                !pageCaptions.some((other) => intersection(other.rect, lineRect(l)) > 0)
            )
          return {
            caption,
            index,
            side,
            sidePlot,
            gap: Math.hypot(horizontalGap, verticalGap * 2),
            eligible: !blocked
          }
        }
        const blocked =
          separators.some(
            (r) => r[1] > Math.min(rect[3], c[3]) && r[3] < Math.max(rect[1], c[1])
          ) ||
          pageCaptions.some(
            (other) =>
              other !== caption &&
              ((other.rect[2] > rect[0] && other.rect[0] < rect[2]) ||
                (captionKind(other.lines[0]) === 'table' &&
                  tableRects.some(
                    (t) => t[0] < rect[2] && t[2] > rect[0] && Math.abs(t[1] - other.rect[3]) < 90
                  ))) &&
              (intersection(other.rect, rect) > 0 ||
                (other.rect[1] >= Math.min(rect[3], c[3]) - 3 &&
                  other.rect[3] <= Math.max(rect[1], c[1]) + 3))
          ) ||
          (graphic.kind === 'path' ? pathBarriers : barriers).some(
            (l) =>
              l.y > Math.min(rect[3], c[3]) + 2 &&
              l.y + l.height < Math.max(rect[1], c[1]) - 2 &&
              l.x < rect[2] &&
              l.x + l.width > rect[0]
          )
        return { caption, index, side: undefined, gap: verticalGap, eligible: vertical && !blocked }
      })
      .filter((choice) => choice.eligible)
      // Close, vertically aligned captions take precedence over a neighboring column's legend.
      .map((choice, _, choices) => ({
        ...choice,
        priority: choice.sidePlot
          ? -1
          : // The inverse layout uses legends above both plates. An immediate
            // raster below the lower legend disambiguates a plate between them.
            !choice.side &&
              choice.gap > 24 &&
              rect[3] <= choice.caption.rect[1] &&
              choices.some((other) => !other.side && rect[1] >= other.caption.rect[3]) &&
              page.graphicsBounds.some((g) => {
                const r = g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
                return (
                  g.kind === 'image' &&
                  area(g.normalizedRect) > 0.02 &&
                  r[1] >= choice.caption.rect[3] &&
                  r[1] - choice.caption.rect[3] <= 36 &&
                  r[0] < choice.caption.rect[2] &&
                  r[2] > choice.caption.rect[0] &&
                  !pageCaptions.some((c) => c !== choice.caption && intersection(c.rect, r) > 0)
                )
              })
            ? 2
            : // Two stacked, captioned figures can have a wide gap before the second
              // legend. Once the upper legend already has a graphic above it, the
              // intervening graphic belongs to the lower legend, not to both.
              !choice.side &&
                rect[1] >= choice.caption.rect[3] &&
                choices.some(
                  (other) =>
                    !other.side &&
                    rect[3] <= other.caption.rect[1] + edgeTolerance &&
                    page.graphicsBounds.some((g) => {
                      const r = g.normalizedRect.map(
                        (v, i) => v * (i % 2 ? page.height : page.width)
                      )
                      return (
                        area(r) > page.width * page.height * 0.02 &&
                        r[3] <= choice.caption.rect[1] &&
                        r[2] > choice.caption.rect[0] &&
                        r[0] < choice.caption.rect[2]
                      )
                    })
                )
              ? 2
              : choice.gap <= 24 &&
                  (!choice.side ||
                    (graphic.kind === 'image' &&
                      choice.caption.lines.length >= 2 &&
                      Math.abs(choice.caption.rect[1] - rect[1]) <= edgeTolerance &&
                      choice.caption.rect[3] <= rect[3] + edgeTolerance))
                ? 0
                : 1
      }))
      .sort((a, b) => a.priority - b.priority || a.gap - b.gap)
    if (!eligible.length) continue
    // Do not break same-height caption ties by input order.
    if (
      eligible[1] &&
      eligible[1].priority === eligible[0].priority &&
      Math.abs(eligible[1].gap - eligible[0].gap) < 2
    )
      continue
    const item = { rect, side: eligible[0].side, kind: graphic.kind }
    assigned[eligible[0].index].push(item)
    if (captions.length > 1 && graphic.kind === 'path')
      panelAssignments.push({ item, eligible, owner: eligible[0].index })
  }
  // The preceding caption can own several small aligned panels instead of one
  // large graphic. Count their disjoint footprints, not their enclosing box or
  // nested divider strokes. Only exclusively assigned panels establish this
  // witness; a nearer caption alone cannot establish a complete prior figure.
  const panelBundleOwners = new Set()
  for (const [owner, caption] of captions.entries()) {
    const c = caption.rect
    const exclusive = panelAssignments
      .filter(
        ({ item, eligible }) =>
          eligible.length === 1 &&
          eligible[0].index === owner &&
          !item.side &&
          item.rect[3] <= c[1] &&
          item.rect[0] >= c[0] &&
          item.rect[2] <= c[2]
      )
      .map(({ item }) => item.rect)
    const panels = exclusive.filter(
      (r, i) =>
        !exclusive.some(
          (q, j) => j !== i && area(q) > area(r) && intersection(q, r) >= area(r) - 1e-7
        )
    )
    if (
      panels.length < 2 ||
      panels.some(
        (r) => Math.abs(r[1] - panels[0][1]) > 1e-7 || Math.abs(r[3] - panels[0][3]) > 1e-7
      ) ||
      panels.some((r, i) => panels.some((q, j) => j !== i && intersection(r, q) > 1e-7)) ||
      panels.reduce((sum, r) => sum + area(r), 0) <= page.width * page.height * 0.02
    )
      continue
    const corridor = [
      Math.min(...panels.map((r) => r[0])),
      panels[0][1],
      Math.max(...panels.map((r) => r[2])),
      c[1]
    ]
    if (
      pageCaptions.some((other) => other !== caption && intersection(other.rect, corridor) > 0) ||
      pathBarriers.some((line) => intersection(lineRect(line), corridor) > 0)
    )
      continue
    const labels = new Set(
      panels.flatMap((panel) =>
        nativeOwnedFigureLabels(page, caption, pageCaptions, tableRects, panel)
      )
    )
    const contains = (outer, inner) =>
      inner.every((value, axis) =>
        axis < 2 ? value >= outer[axis] - 1e-7 : value <= outer[axis] + 1e-7
      )
    // Short inter-panel text is not covered by the ordinary long-prose
    // barrier. Every line/run in this band still needs an individual owner.
    if (
      page.lines.some(
        (line) =>
          line.text.trim() &&
          intersection(lineRect(line), corridor) > 1e-7 &&
          !labels.has(line) &&
          !panels.some((panel) => contains(panel, lineRect(line)))
      ) ||
      nativeTokens.some(
        (token) =>
          token.text.trim() &&
          intersection(token.rect, corridor) > 1e-7 &&
          !panels.some((panel) => contains(panel, token.rect)) &&
          ![...labels].some(
            (line) => line.text.includes(token.text) && contains(lineRect(line), token.rect)
          )
      )
    )
      continue
    panelBundleOwners.add(owner)
  }
  // Reuse the existing stacked-caption priority only among already eligible
  // choices. Evaluate after collecting all panels so paint order is irrelevant.
  for (const { item, eligible, owner } of panelAssignments) {
    if (
      !panelBundleOwners.has(owner) ||
      item.side ||
      item.rect[1] < captions[owner].rect[3] ||
      !eligible.some(
        (other) => !other.side && item.rect[3] <= other.caption.rect[1] + edgeTolerance
      )
    )
      continue
    const choices = eligible
      .map((choice) => ({
        ...choice,
        priority: choice.index === owner && choice.priority === 1 ? 2 : choice.priority
      }))
      .sort((a, b) => a.priority - b.priority || a.gap - b.gap)
    if (
      choices[0].index === owner ||
      (choices[1] &&
        choices[1].priority === choices[0].priority &&
        Math.abs(choices[1].gap - choices[0].gap) < 2)
    )
      continue
    assigned[owner].splice(assigned[owner].indexOf(item), 1)
    assigned[choices[0].index].push(item)
  }
  // Three equal raster rows in one column can have a long shared caption below
  // the complete stack. Its middle image is closer vertically to a chart's
  // side legend in the next column. Three equal source footprints, equal row
  // spacing and an exclusive caption column prove the whole stack's owner.
  for (const [owner, items] of assigned.entries()) {
    const c = captions[owner].rect
    if (captionKind(captions[owner].lines[0]) !== 'figure' || c[2] - c[0] > page.width * 0.5)
      continue
    const images = assigned
      .flatMap((others, index) =>
        others
          .filter(
            (item) =>
              item.kind === 'image' &&
              item.rect[0] >= c[0] &&
              item.rect[2] <= c[2] &&
              item.rect[3] <= c[1] &&
              c[1] - item.rect[3] < page.height * 0.7 &&
              !tableRects.some((table) => intersection(table, item.rect) > 0)
          )
          .map((item) => ({ item, index }))
      )
      .sort((a, b) => a.item.rect[1] - b.item.rect[1])
    if (images.length !== 3) continue
    const [top, middle, bottom] = images.map(({ item }) => item)
    const width = top.rect[2] - top.rect[0],
      height = top.rect[3] - top.rect[1]
    if (
      width < page.width * 0.1 ||
      height < page.height * 0.08 ||
      [middle, bottom].some(
        (item) =>
          Math.abs(top.rect[0] - item.rect[0]) > edgeTolerance ||
          Math.abs(top.rect[2] - item.rect[2]) > edgeTolerance ||
          Math.abs(height - item.rect[3] + item.rect[1]) > edgeTolerance
      ) ||
      middle.rect[1] <= top.rect[3] ||
      bottom.rect[1] <= middle.rect[3] ||
      Math.abs(middle.rect[1] * 2 - top.rect[1] - bottom.rect[1]) > edgeTolerance * 2 ||
      c[1] - bottom.rect[3] > page.height * 0.1 ||
      pageCaptions.some(
        (other) =>
          other !== captions[owner] &&
          intersection(other.rect, [top.rect[0], top.rect[1], bottom.rect[2], c[1]]) > 0
      )
    )
      continue
    for (const { item, index } of images) {
      if (
        index === owner ||
        intersection(captions[index].rect, [top.rect[0], 0, top.rect[2], page.height]) > 0
      )
        continue
      assigned[index].splice(assigned[index].indexOf(item), 1)
      items.push(item)
    }
  }
  // A wide caption can introduce a two-panel row whose second panel is
  // followed by a separately captioned chart in the next column.  The normal
  // distance heuristic sees the panel and the chart as one ambiguous side
  // band.  Resolve only this strongly evidenced layout directly: two
  // substantial graphics share a row between the captions, and a distinct
  // right-column graphic starts below the later caption and ends before the
  // following prose baseline.  Keeping the two envelopes separate prevents
  // body text from expanding the first crop and gives the second caption a
  // complete chart crop.
  const panelRowRecovery = (() => {
    if (captions.length !== 2 || !page.graphicsBounds?.length) return undefined
    const figureCaptions = captions.filter(
      (caption) => captionKind(caption.lines?.[0] ?? '') === 'figure'
    )
    if (figureCaptions.length !== 2) return undefined
    const [wideCaption, chartCaption] = [...figureCaptions].sort((a, b) => a.rect[1] - b.rect[1])
    if (
      wideCaption.rect[2] - wideCaption.rect[0] < page.width * 0.7 ||
      chartCaption.rect[2] - chartCaption.rect[0] > page.width * 0.5 ||
      chartCaption.rect[0] < page.width * 0.45 ||
      chartCaption.rect[1] <= wideCaption.rect[3]
    )
      return undefined
    const toRect = (graphic) =>
      graphic.normalizedRect.map((value, index) => value * (index % 2 ? page.height : page.width))
    const graphics = page.graphicsBounds.map((graphic) => ({ ...graphic, rect: toRect(graphic) }))
    const topPanels = graphics.filter(
      ({ rect }) =>
        rect[1] >= wideCaption.rect[3] - edgeTolerance &&
        rect[3] <= chartCaption.rect[1] + edgeTolerance &&
        rect[2] - rect[0] >= page.width * 0.2 &&
        rect[3] - rect[1] >= page.height * 0.03
    )
    if (topPanels.length < 2) return undefined
    const topBounds = union(topPanels.map(({ rect }) => rect))
    if (topBounds[2] - topBounds[0] < page.width * 0.6) return undefined
    // A ruled table or a table-backed graphic in this corridor invalidates
    // the panel proof.  Do not let a captioned figure claim table ink merely
    // because the table happens to share the right column.
    if (tableRects.some((table) => intersection(table, topBounds) > 0)) return undefined
    const nextProseY = Math.min(
      page.height,
      ...page.lines
        .filter(
          (line) =>
            line.x >= chartCaption.rect[0] - edgeTolerance &&
            line.y > chartCaption.rect[3] + edgeTolerance &&
            line.fontSize > 0 &&
            line.text.trim().length > 20
        )
        .map((line) => line.y)
    )
    const chartGraphics = graphics.filter(
      ({ rect }) =>
        rect[0] >= chartCaption.rect[0] - edgeTolerance &&
        rect[1] >= chartCaption.rect[3] - edgeTolerance &&
        rect[3] <= nextProseY - edgeTolerance &&
        !topPanels.some((panel) => panel.rect === rect)
    )
    if (!chartGraphics.length) return undefined
    const chartBounds = union(chartGraphics.map(({ rect }) => rect))
    // Axis titles, tick labels, and compact legends are native text rather
    // than graphics.  Keep short labels in the chart's vertical envelope so
    // the crop does not lose the y-axis title or terminal x-axis marker;
    // exclude the longer prose column that follows the chart.
    const chartLabels = page.lines
      .filter(
        (line) =>
          line.text.trim().length > 0 &&
          line.text.trim().length <= 24 &&
          line.y >= chartCaption.rect[3] - edgeTolerance &&
          line.y <= chartBounds[3] + 20 &&
          line.x >= chartBounds[0] - 40 &&
          line.x + line.width <= chartBounds[2] + 40
      )
      .map(lineRect)
    const chartWithLabels = chartLabels.length ? union([chartBounds, ...chartLabels]) : chartBounds
    if (area(chartWithLabels) < page.width * page.height * 0.01) return undefined
    if (tableRects.some((table) => intersection(table, chartWithLabels) > 0)) return undefined
    return [
      {
        caption: wideCaption,
        rect: topBounds,
        graphicsCount: topPanels.length,
        panelRowRecovery: true
      },
      {
        caption: chartCaption,
        rect: chartWithLabels,
        graphicsCount: chartGraphics.length,
        panelRowRecovery: true
      }
    ]
  })()
  if (panelRowRecovery) return panelRowRecovery
  const compositePlateRecovery = (() => {
    if (captions.length !== 1 || !page.graphicsBounds?.length) return undefined
    const [caption] = captions
    if (captionKind(caption.lines?.[0] ?? '') !== 'figure') return undefined
    const toRect = (graphic) =>
      graphic.normalizedRect.map((value, index) => value * (index % 2 ? page.height : page.width))
    const graphics = page.graphicsBounds.map((graphic) => ({ ...graphic, rect: toRect(graphic) }))
    const images = graphics.filter(
      ({ kind, rect }) =>
        kind === 'image' &&
        rect[1] < caption.rect[1] &&
        rect[3] <= caption.rect[1] + edgeTolerance &&
        rect[3] - rect[1] >= page.height * 0.03
    )
    if (images.length < 4) return undefined
    const firstRow = images
      .slice()
      .sort((a, b) => a.rect[1] - b.rect[1])
      .slice(0, 4)
    const rowY = Math.min(...firstRow.map(({ rect }) => rect[1]))
    if (firstRow.some(({ rect }) => Math.abs(rect[1] - rowY) > edgeTolerance * 2)) return undefined
    const firstRowBounds = union(firstRow.map(({ rect }) => rect))
    const plateImages = images.filter(
      ({ rect }) =>
        rect[0] >= firstRowBounds[0] - edgeTolerance &&
        rect[2] <= firstRowBounds[2] + edgeTolerance &&
        rect[1] >= firstRowBounds[1] - edgeTolerance
    )
    const plateBounds = union(plateImages.map(({ rect }) => rect))
    const selected = graphics.filter(
      ({ rect }) =>
        rect[1] >= plateBounds[1] - 24 &&
        rect[3] <= caption.rect[1] + edgeTolerance &&
        intersection(rect, [
          plateBounds[0] - page.width * 0.2,
          plateBounds[1] - 24,
          plateBounds[2] + 24,
          plateBounds[3] + 24
        ]) > 0
    )
    const hasSideComponent = selected.some(
      ({ rect }) =>
        rect[2] < plateBounds[0] - edgeTolerance &&
        Math.min(rect[3], plateBounds[3]) - Math.max(rect[1], plateBounds[1]) >
          (rect[3] - rect[1]) * 0.25
    )
    if (!hasSideComponent || selected.length < plateImages.length + 2) return undefined
    return [
      { caption, rect: union(selected.map(({ rect }) => rect)), graphicsCount: selected.length }
    ]
  })()
  if (compositePlateRecovery) return compositePlateRecovery
  // Legend marks inside another caption's panel belong to that panel, even
  // when their small individual boxes are closer to the previous caption.
  for (const [index, items] of assigned.entries()) {
    for (const item of [...items]) {
      const owners = assigned.flatMap((others, owner) =>
        owner === index
          ? []
          : others
              .filter(
                (other) =>
                  area(other.rect) > page.width * page.height * 0.02 &&
                  area(other.rect) > area(item.rect) * 2 &&
                  intersection(other.rect, item.rect) / area(item.rect) > 0.95
              )
              .map(() => owner)
      )
      if (owners.length && new Set(owners).size === 1) {
        items.splice(items.indexOf(item), 1)
        assigned[owners[0]].push(item)
      }
    }
  }
  // A separately captioned native panel establishes its own column even when
  // small curves near its top are closer to the neighbouring side legend.
  for (const [index, items] of assigned.entries()) {
    for (const item of [...items]) {
      const owners = assigned.flatMap((others, owner) =>
        owner === index
          ? []
          : others
              .filter(
                (other) =>
                  other.kind === 'path' &&
                  area(other.rect) > page.width * page.height * 0.05 &&
                  captions[owner].rect[1] >= other.rect[3] &&
                  captions[owner].rect[1] - other.rect[3] < 24 &&
                  captions[owner].rect[0] >= other.rect[0] - 8 &&
                  captions[owner].rect[2] <= other.rect[2] + 8 &&
                  captionKind(captions[index].lines[0]) === 'figure' &&
                  intersection(captions[index].rect, [
                    other.rect[0],
                    0,
                    other.rect[2],
                    page.height
                  ]) === 0 &&
                  intersection(other.rect, item.rect) / area(item.rect) > 0.95
              )
              .map(() => owner)
      )
      if (owners.length && new Set(owners).size === 1) {
        items.splice(items.indexOf(item), 1)
        assigned[owners[0]].push(item)
      }
    }
  }
  return captions.map((caption, index) => {
    const framedRasterTextPanel = nativeCaptionedFramedRasterTextPanel(
      page,
      caption,
      pageCaptions,
      tableRects
    )
    if (framedRasterTextPanel) return framedRasterTextPanel
    const dualPanelGrid = nativeCaptionedRasterDualPanelGrid(
      page,
      caption,
      pageCaptions,
      tableRects
    )
    if (dualPanelGrid) return dualPanelGrid
    const horizontalRasterArray = nativeCaptionedRasterHorizontalArray(
      page,
      caption,
      pageCaptions,
      tableRects
    )
    if (horizontalRasterArray) return horizontalRasterArray
    const sideBySideRaster = nativeCaptionedRasterSideBySide(
      page,
      caption,
      pageCaptions,
      tableRects
    )
    if (sideBySideRaster) return sideBySideRaster
    const rasterVectorComposite = nativeCaptionedRasterVectorCompositeGrid(
      page,
      caption,
      pageCaptions,
      tableRects
    )
    if (rasterVectorComposite) return rasterVectorComposite
    const mixedWorkflow = nativeCaptionedMixedWorkflowPanel(page, caption, pageCaptions, tableRects)
    if (mixedWorkflow) return mixedWorkflow
    const foreignRasters = assigned.flatMap((items, owner) =>
      owner === index
        ? []
        : items
            .filter(
              (item) =>
                item.kind === 'image' &&
                area(item.rect) > page.width * page.height * 0.001 &&
                item.rect[3] <= captions[owner].rect[1] &&
                intersection(item.rect, [
                  captions[owner].rect[0],
                  0,
                  captions[owner].rect[2],
                  page.height
                ]) /
                  area(item.rect) >
                  0.95 &&
                intersection(item.rect, [caption.rect[0], 0, caption.rect[2], page.height]) === 0
            )
            .map((item) => item.rect)
    )
    const rasterVectorStrip = nativeCaptionedRasterVectorStrip(
      page,
      caption,
      pageCaptions,
      tableRects,
      foreignRasters,
      nativeTokens
    )
    if (rasterVectorStrip) return rasterVectorStrip
    const framedRaster = nativeCaptionedFramedRaster(page, caption, pageCaptions, tableRects)
    if (framedRaster) return framedRaster
    const textIllustration = nativeCaptionedTextIllustration(
      page,
      caption,
      pageCaptions,
      tableRects
    )
    if (textIllustration) return textIllustration
    const vectorHeatmap = nativeCaptionedVectorHeatmap(page, caption, pageCaptions, tableRects)
    if (vectorHeatmap) return vectorHeatmap
    const workflowPanel = nativeCaptionedWorkflowPanel(page, caption, pageCaptions, tableRects)
    if (workflowPanel) return workflowPanel
    const vectorDiagram = nativeCaptionedVectorDiagram(page, caption, pageCaptions, tableRects)
    if (vectorDiagram) return vectorDiagram
    const framedVectorQuad = nativeCaptionedFramedVectorQuad(
      page,
      caption,
      pageCaptions,
      tableRects
    )
    if (framedVectorQuad) return framedVectorQuad
    const vectorTableGrid = nativeCaptionedVectorTableGrid(page, caption, pageCaptions, tableRects)
    if (vectorTableGrid) return vectorTableGrid
    const vectorChartStrip = nativeCaptionedVectorChartStrip(
      page,
      caption,
      pageCaptions,
      tableRects,
      nativeTokens,
      closedFrames
    )
    if (vectorChartStrip) return vectorChartStrip
    const vectorBarChart = nativeCaptionedVectorBarChart(
      page,
      caption,
      pageCaptions,
      tableRects,
      rules,
      operatorContext
    )
    // The abbreviated-caption entry must not bypass the later native prose
    // ownership checks by discarding an already assigned shallow stroke.
    // A local chart frame is not evidence that an external mark is unrelated.
    // Abbreviated captions only recover unassigned charts here. Existing assignments
    // retain the generic prose/neighbor checks instead of replacing their crop.
    if (
      vectorBarChart &&
      (!/^fig\./i.test(caption.lines?.[0] ?? '') || assigned[index].length === 0)
    )
      return vectorBarChart
    const vectorBarPanels = nativeCaptionedVectorBarPanels(page, caption, pageCaptions, tableRects)
    if (vectorBarPanels) return vectorBarPanels
    const vectorGrid = nativeCaptionedVectorGrid(page, caption, pageCaptions, tableRects)
    if (vectorGrid) return vectorGrid
    const fullWidthRaster = nativeCaptionedRasterFullWidth(page, caption, pageCaptions, tableRects)
    if (fullWidthRaster) return fullWidthRaster
    // A proved complete keyed plate takes precedence over its nearest raster.
    const rasterArray = nativeLetteredRasterArray(
      page,
      caption,
      pageCaptions,
      tableRects,
      nativeTokens
    )
    if (rasterArray) return rasterArray
    const captionedRaster = nativeCaptionedRaster(page, caption, pageCaptions, tableRects)
    if (captionedRaster)
      return (
        nativeContiguousRasterStack(
          page,
          caption,
          pageCaptions,
          tableRects,
          operatorContext,
          captionedRaster
        ) ?? captionedRaster
      )
    const captionedRasterModerateGap = nativeCaptionedRasterModerateGap(
      page,
      caption,
      pageCaptions,
      tableRects
    )
    if (captionedRasterModerateGap) return captionedRasterModerateGap
    const captionedRasterFragment = nativeCaptionedRasterArrayFragment(
      page,
      caption,
      pageCaptions,
      tableRects
    )
    if (captionedRasterFragment) return captionedRasterFragment
    const rasterQuad = nativeCaptionedRasterQuad(page, caption, pageCaptions, tableRects)
    if (rasterQuad) return rasterQuad
    const rasterGrid = nativeRasterGrid(page, caption, pageCaptions, tableRects)
    if (rasterGrid) return rasterGrid
    const compositeRasterGrid = nativeCaptionedRasterCompositeGrid(
      page,
      caption,
      pageCaptions,
      tableRects,
      nativeTokens
    )
    if (compositeRasterGrid) return compositeRasterGrid
    const closedPlots = nativeCaptionedPlotBand(page, caption, pageCaptions, tableRects, rules)
    const assignedBounds = assigned[index].length
      ? union(assigned[index].map((item) => item.rect))
      : undefined
    if (
      closedPlots &&
      (!assignedBounds ||
        closedPlots.rect.some((v, i) =>
          i < 2 ? v < assignedBounds[i] - edgeTolerance : v > assignedBounds[i] + edgeTolerance
        ))
    )
      return closedPlots
    const columnPlots = nativeDisjointPlotColumn(
      page,
      caption,
      pageCaptions,
      tableRects,
      nativeTokens
    )
    if (columnPlots) return columnPlots
    const nodes = nativeAlignedNodeFigure(
      page,
      caption,
      pageCaptions,
      tableRects,
      rules,
      nativeTokens
    )
    if (nodes) return nodes
    const rasterColumn = nativeRasterCaptionColumn(
      page,
      caption,
      page.graphicsBounds.some((g) => g.kind === 'image' && g.paintedNormalizedRect)
        ? pageCaptions
        : captions,
      tableRects
    )
    if (rasterColumn) return rasterColumn
    // Label recovery must respect a substantial panel already assigned to a
    // different caption. Small outlined glyphs are otherwise reconsidered from
    // the whole page and can drag a neighbouring column into this crop.
    const foreignPanelOwns = (rect) =>
      assigned.some(
        (items, owner) =>
          owner !== index &&
          items.some(
            (item) =>
              area(item.rect) > page.width * page.height * 0.02 &&
              intersection(item.rect, rect) / area(rect) > 0.95 &&
              !assigned[index].some(
                (own) =>
                  area(own.rect) > page.width * page.height * 0.02 &&
                  intersection(own.rect, rect) / area(rect) > 0.95
              )
          )
      )
    const closed = closedCaptionFigureFrame(page, caption, pageCaptions, tableRects, closedFrames)
    if (closed && !closedComposites.has(caption)) return closed
    const enclosed = () =>
      enclosedFigureFrame(page, caption, pageCaptions, tableRects) ?? closedPlots
    // Composite raster panels can wrap around a legend in the lower-left corner.
    // Preserve the original plate rather than dropping it because it intersects
    // its own caption; other captions and recognized tables remain barriers.
    const embedded = page.graphicsBounds.filter((g) => {
      const r = g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
      return (
        g.kind === 'image' &&
        area(g.normalizedRect) > 0.2 &&
        // Quantized image bounds can graze an external legend by a few points.
        r[3] > caption.rect[1] + edgeTolerance &&
        // A bare external number grazing the final quantized raster row is
        // distinct from a legend embedded materially inside a composite plate.
        !(
          /^(?:Fig\.?|Figure)\s+\d+\.?$/i.test(caption.lines.join(' ')) &&
          r[3] - caption.rect[1] <= caption.rect[3] - caption.rect[1]
        ) &&
        (intersection(r, caption.rect) > area(caption.rect) * 0.2 ||
          (caption.lines.join(' ').length > 100 && intersection(r, caption.rect) > 0)) &&
        caption.rect[1] > r[1] + (r[3] - r[1]) * 0.5 &&
        !pageCaptions.some((c) => c !== caption && intersection(c.rect, r) > 0) &&
        !tableRects.some((t) => intersection(t, r) > 0)
      )
    })
    if (embedded.length === 1)
      return {
        caption,
        rect: embedded[0].normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)),
        graphicsCount: 1
      }
    // Tiny rasterized axis/legend labels do not establish a raster plate:
    // vector axes and embedded data grids still belong to the same figure.
    const plates = assigned[index].filter(
      (item) => item.kind === 'image' && area(item.rect) > page.width * page.height * 0.01
    )
    let connected = plates.length
      ? assigned[index].filter(
          (item) =>
            item.kind === 'image' ||
            (item.rect[2] - item.rect[0] >= 12 &&
              item.rect[3] - item.rect[1] >= 12 &&
              !page.lines.some(
                (l) => l.text.length > 80 && intersection(lineRect(l), item.rect) > 0
              ) &&
              item.rect[0] < page.width * 0.94 &&
              !tableRects.some((t) => intersection(t, item.rect) > 0)) ||
            plates.some(
              (plate) =>
                intersection(item.rect, [
                  plate.rect[0] - 8,
                  plate.rect[1] - 8,
                  plate.rect[2] + 8,
                  plate.rect[3] + 8
                ]) > 0
            )
        )
      : assigned[index]
    // Quantized outlined marks inside an independently captioned raster column
    // retain that raster's owner even if their individual y distance is shorter
    // to a chart legend in the next column. Keep cross-column connectors out of
    // this exclusion: only operations enclosed by one source image qualify.
    connected = connected.filter(
      (item) =>
        !foreignRasters.some(
          (rect) =>
            intersection(item.rect, [
              rect[0] - page.width / 64,
              rect[1] - edgeTolerance,
              rect[2] + page.width / 64,
              rect[3] + edgeTolerance
            ]) /
              area(item.rect) >
            0.95
        )
    )
    // A small mathematical stroke inside a separate native prose column is
    // not part of a substantial chart above this caption. Require a chart
    // wholly inside the caption's column and repeated ordinary prose baselines
    // surrounding the remote stroke; detached figure labels stay untouched.
    let externalProseOwnsMath = () => false
    if (!plates.length && caption.rect[2] - caption.rect[0] <= page.width * 0.5) {
      const anchors = connected.filter(
        (item) =>
          item.kind === 'path' &&
          area(item.rect) > page.width * page.height * 0.01 &&
          item.rect[0] >= caption.rect[0] - edgeTolerance &&
          item.rect[2] <= caption.rect[2] + edgeTolerance &&
          item.rect[3] < caption.rect[1]
      )
      if (
        anchors.some((a) => area(a.rect) > page.width * page.height * 0.02) ||
        anchors.some((a) => anchors.some((b) => a !== b && intersection(a.rect, b.rect) === 0))
      ) {
        // Native inline scripts can split an ordinary prose baseline into
        // several short runs. Reconstruct its measured row before requiring
        // the same aligned words above and below a remote mathematical mark.
        const proseRows = page.lines.every((line) =>
          [line.x, line.y, line.width, line.height, line.fontSize].every(Number.isFinite)
        )
          ? groupPageLines(page).map((line) => ({
              ...line,
              width: line.right - line.x,
              height: line.bottom - line.y
            }))
          : page.lines
        externalProseOwnsMath = (rect) => {
          const prose = proseRows.filter(
            (line) =>
              line.fontSize > 0 &&
              (line.text.match(/\p{L}{2,}/gu)?.length ?? 0) >= 4 &&
              (rect[2] - rect[0] <= line.fontSize * 4 ||
                // A fraction bar or its numerator can exceed a short glyph.
                // Both remain inside independently bracketed ordinary prose
                // in a column separate from the complete chart panels.
                (rect[3] - rect[1] <= line.fontSize * 1.5 &&
                  rect[2] - rect[0] <= line.width * 0.75)) &&
              rect[3] - rect[1] <= line.fontSize * 1.5 &&
              Math.abs(line.y - rect[1]) <= line.fontSize * 5 &&
              line.x <= rect[0] + line.fontSize * 0.001 &&
              line.x + line.width >= rect[2] - line.fontSize * 0.001 &&
              (line.x + line.width < caption.rect[0] - line.fontSize ||
                line.x > caption.rect[2] + line.fontSize) &&
              !pageCaptions.some((other) => intersection(other.rect, lineRect(line)) > 0) &&
              !tableRects.some((table) => intersection(table, lineRect(line)) > 0) &&
              !anchors.some((anchor) => intersection(anchor.rect, lineRect(line)) > 0)
          )
          const aligned = prose.filter(
            (line) =>
              Math.abs(line.x - prose[0].x) <= line.fontSize &&
              Math.abs(line.fontSize - prose[0].fontSize) <= line.fontSize * 0.1
          )
          return (
            aligned.length >= 3 &&
            aligned.some((line) => line.y < rect[1] - line.fontSize) &&
            aligned.some((line) => line.y > rect[3])
          )
        }
        connected = connected.filter(
          (item) =>
            item.kind !== 'path' || anchors.includes(item) || !externalProseOwnsMath(item.rect)
        )
      }
    }
    // A compact diagram beside ordinary prose can share a page with a shaded
    // text box and a publisher mark. Require a directly captioned enclosing path
    // and many contained strokes before excluding those disconnected decorations.
    if (!plates.length) {
      const seeds = connected.filter(
        (g) =>
          g.kind === 'path' &&
          g.rect[3] <= caption.rect[1] &&
          caption.rect[1] - g.rect[3] < 20 &&
          g.rect[0] <= caption.rect[0] + 4 &&
          g.rect[2] >= caption.rect[2] &&
          g.rect[3] - g.rect[1] > 40 &&
          connected.filter(
            (other) => other !== g && intersection(g.rect, other.rect) / area(other.rect) > 0.95
          ).length >= 5
      )
      const seed = seeds.sort((a, b) => area(b.rect) - area(a.rect))[0]
      if (seed) {
        const component = [seed]
        connectFigureGraphics(component, new Set(connected.filter((g) => g !== seed)))
        const remaining = new Set(connected.filter((g) => !component.includes(g)))
        const outside = []
        while (remaining.size) {
          const first = remaining.values().next().value
          remaining.delete(first)
          const group = [first]
          connectFigureGraphics(group, remaining)
          outside.push(union(group.map((g) => g.rect)))
        }
        if (
          outside.length &&
          outside.every(
            (rect) =>
              (rect[1] > page.height * 0.92 && area(rect) < page.width * page.height * 0.002) ||
              page.lines.filter(
                (l) => l.text.split(/\s+/).length >= 6 && intersection(lineRect(l), rect) > 0
              ).length >= 3
          )
        )
          connected = component
      }
    }
    // A stray legend dash below this caption needs its own substantial panel;
    // the legend box above the caption cannot lend it false support.
    connected = connected.filter(
      (item) =>
        item.rect[1] < caption.rect[3] - edgeTolerance ||
        connected.some(
          (other) =>
            other.rect[1] >= caption.rect[3] - edgeTolerance &&
            other.rect[2] - other.rect[0] >= 12 &&
            other.rect[3] - other.rect[1] >= 12
        )
    )
    if (
      connected.some((item) => !item.side) &&
      (connected.every((item) => item.rect[3] <= caption.rect[1] + edgeTolerance) ||
        (/^(?:Fig\.?|Figure)\s+\d+\.?$/i.test(caption.lines.join(' ')) &&
          connected.every((item) => item.rect[1] >= caption.rect[3] - edgeTolerance)))
    ) {
      for (const item of connected) item.side = undefined
    }
    const substantial = connected.filter((g) => area(g.rect) > page.width * page.height * 0.15)
    if (substantial.length)
      connected = connected.filter(
        (g) =>
          area(g.rect) > page.width * page.height * 0.01 ||
          (plates.length && g.rect[2] - g.rect[0] >= 12 && g.rect[3] - g.rect[1] >= 12) ||
          substantial.some(
            (p) =>
              intersection(g.rect, [
                p.rect[0] - 24,
                p.rect[1] - 24,
                p.rect[2] + 24,
                p.rect[3] + 24
              ]) > 0
          )
      )
    // A composite figure can mix raster panels with connected vector drawings
    // and outlined labels. Grow from the retained graphics using the same local
    // margin as raster adjacency; distance from the raster alone is not evidence
    // that a path is decoration. Only already-assigned paths may join the figure.
    const retained = new Set(connected)
    const pending = new Set(
      plates.length || substantial.some((g) => g.kind === 'path')
        ? assigned[index].filter(
            (item) =>
              item.kind === 'path' &&
              !retained.has(item) &&
              (plates.length ||
                (item.rect[1] >= union(substantial.map((g) => g.rect))[3] - edgeTolerance * 2 &&
                  item.rect[3] < caption.rect[1])) &&
              item.rect[0] < page.width * 0.94 &&
              !tableRects.some((t) => intersection(t, item.rect) > 0) &&
              !page.lines.some(
                (l) => l.text.length > 80 && intersection(lineRect(l), item.rect) > 0
              )
          )
        : []
    )
    connectFigureGraphics(connected, pending)
    // A side-captioned flowchart can extend above and below its legend. Grow
    // from one adjacent node through native connectors, including distant nodes
    // missed by caption distance. A disconnected or competing component is not
    // evidence that every graphic on that side belongs to this diagram.
    if (
      /\b(?:CONSORT|flow\s*chart|flow diagram|patient flow)\b/i.test(caption.lines.join(' ')) &&
      connected.length &&
      connected.every((item) => item.kind === 'path') &&
      diagramFrames.length >= 3
    ) {
      const lateral =
        caption.rect[2] < page.width * 0.4 && connected.every((g) => g.rect[0] > caption.rect[2])
          ? 'right'
          : caption.rect[0] > page.width * 0.6 &&
              connected.every((g) => g.rect[2] < caption.rect[0])
            ? 'left'
            : undefined
      const adjacent = connected.find((item) => (item.side || lateral) && area(item.rect) > 144)
      const seed = adjacent && { ...adjacent, side: adjacent.side ?? lateral }
      if (seed) {
        const onSide = (rect) =>
          seed.side === 'left' ? rect[2] <= caption.rect[0] : rect[0] >= caption.rect[2]
        const paths = page.graphicsBounds
          .filter((g) => g.kind === 'path')
          .map((g) => ({
            rect: g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)),
            kind: 'path',
            side: seed.side
          }))
          .filter(
            (g) =>
              onSide(g.rect) &&
              !pageCaptions.some((c) => intersection(c.rect, g.rect) > 0) &&
              !tableRects.some((t) => intersection(t, g.rect) > 0) &&
              !pathBarriers.some((l) => intersection(lineRect(l), g.rect) > 0)
          )
        const sameRect = (a, b) => a.rect.every((v, i) => v === b.rect[i])
        const component = [seed]
        const pending = new Set(paths.filter((g) => !sameRect(g, seed)))
        connectFigureGraphics(component, pending)
        // A native flowchart is only safe when every same-side path belongs to
        // the connected component. Missing connectors and detached panels must
        // remain unresolved instead of producing a plausible partial crop.
        if (/\bCONSORT\b/i.test(caption.lines.join(' ')) && pending.size)
          return enclosed() ?? { caption, reason: 'ambiguous-graphic-direction' }
        if (
          connected.every((g) => component.some((other) => sameRect(g, other))) &&
          diagramFrames.filter((r) =>
            component.some((g) => intersection(r, g.rect) / area(r) > 0.95)
          ).length >= 3
        )
          connected = component.map((g) => ({ ...g, side: seed.side }))
      }
    } else if (
      /\bCONSORT\b/i.test(caption.lines.join(' ')) &&
      connected.length &&
      connected.every((item) => item.kind === 'path')
    ) {
      // Without labelled frame evidence, side-positioned paths are ambiguous
      // page furniture and should not become a figure by proximity alone.
      return enclosed() ?? { caption, reason: 'ambiguous-graphic-direction' }
    }
    // Small operations inside a side-captioned panel share its direction.
    for (const item of connected.some((g) => g.side) ? connected : []) {
      const parent = connected.find(
        (other) =>
          other !== item &&
          other.side &&
          area(other.rect) > area(item.rect) * 2 &&
          intersection(other.rect, item.rect) / area(item.rect) >
            (other.kind === 'image' ? 0.1 : 0.5)
      )
      if (parent) item.side = parent.side
    }
    // A flowchart connector can span several side panels without belonging to
    // any one panel. Inherit their direction only inside their shared envelope.
    for (const side of ['left', 'right']) {
      const panels = connected.filter((g) => g.side === side && area(g.rect) > 144)
      if (panels.length < 2) continue
      const envelope = union(panels.map((g) => g.rect))
      for (const item of connected) {
        if (
          !item.side &&
          (side === 'right' ? item.rect[0] >= caption.rect[2] : item.rect[2] <= caption.rect[0]) &&
          intersection(envelope, item.rect) / area(item.rect) > 0.99
        )
          item.side = side
      }
    }
    if (/\bCONSORT\b/i.test(caption.lines.join(' ')) && plates.length) {
      const detachedUnlabelledPath = connected.some(
        (item) =>
          item.kind === 'path' &&
          !plates.some(
            (plate) =>
              intersection(
                [
                  plate.rect[0] - edgeTolerance,
                  plate.rect[1] - edgeTolerance,
                  plate.rect[2] + edgeTolerance,
                  plate.rect[3] + edgeTolerance
                ],
                item.rect
              ) > 0
          ) &&
          !page.lines.some(
            (line) => intersection(lineRect(line), item.rect) / area(lineRect(line)) > 0.8
          )
      )
      if (detachedUnlabelledPath)
        return enclosed() ?? { caption, reason: 'ambiguous-graphic-direction' }
    }
    // Border rules below a caption are not a second figure. Evaluate extent per direction,
    // retaining thin axes when they belong to a larger figure on that same side.
    if (
      pageCaptions.length === 1 &&
      diagramFrames.length >= 3 &&
      connected.length &&
      connected.every((g) => g.kind === 'path')
    ) {
      const lateral =
        caption.rect[2] < page.width * 0.35 && connected.every((g) => g.rect[0] > caption.rect[2])
          ? 'right'
          : caption.rect[0] > page.width * 0.65 &&
              connected.every((g) => g.rect[2] < caption.rect[0])
            ? 'left'
            : undefined
      if (lateral) {
        const component = [connected[0]],
          pending = new Set(connected.slice(1))
        connectFigureGraphics(component, pending)
        if (
          !pending.size &&
          diagramFrames.filter((r) =>
            component.some((g) => intersection(g.rect, r) / area(r) > 0.95)
          ).length >= 3
        )
          for (const item of connected) item.side = lateral
      }
    }
    const directions = Map.groupBy(
      excludeDetachedDiagramDecorations(connected, diagramFrames, page),
      (item) => item.side ?? (item.rect[1] < caption.rect[1] ? 'above' : 'below')
    )
    let meaningful = [...directions.values()]
      .filter((items) => {
        // Disconnected tiny marks do not form a large panel merely because
        // their union spans a paragraph. Keep axes inside a substantial plate.
        if (
          !items.some(
            (item) => item.rect[2] - item.rect[0] >= 12 && item.rect[3] - item.rect[1] >= 12
          )
        ) {
          // An outlined forest plot has thin interval strokes and vertical
          // reference axes, but no single two-dimensional panel operation.
          // Require both intersecting axes and a substantial glyph cluster.
          const vectorPlot =
            items.every((g) => g.kind === 'path') &&
            items.filter((g) => g.rect[2] - g.rect[0] <= 12 && g.rect[3] - g.rect[1] <= 12)
              .length >= 20 &&
            items.some(
              (v) =>
                v.rect[3] - v.rect[1] > 60 &&
                v.rect[2] - v.rect[0] < 12 &&
                items.filter(
                  (h) =>
                    h.rect[2] - h.rect[0] > 40 &&
                    h.rect[3] - h.rect[1] < 12 &&
                    intersection(v.rect, h.rect) > 0
                ).length >= 2
            )
          // Legacy PDFs may encode a plate as hundreds of raster scan strips.
          // Require continuous vertical coverage and overlapping horizontal ink;
          // disconnected marks and vector paragraph rules remain excluded.
          const strips = items
            .filter((item) => item.kind === 'image')
            .sort((a, b) => a.rect[1] - b.rect[1])
          if (
            !vectorPlot &&
            (strips.length < 20 ||
              area(union(strips.map((g) => g.rect))) < page.width * page.height * 0.03 ||
              strips.some(
                (g, n) =>
                  n &&
                  (g.rect[1] > strips[n - 1].rect[3] + edgeTolerance ||
                    Math.min(g.rect[2], strips[n - 1].rect[2]) <=
                      Math.max(g.rect[0], strips[n - 1].rect[0]))
              ))
          )
            return false
        }
        const rect = union(items.map((item) => item.rect))
        const width = rect[2] - rect[0]
        const height = rect[3] - rect[1]
        // Caption continuation rules can include an arrowhead: their box is taller than
        // a plain rule. Keep raster strips and labelled charts, but not bare path dividers.
        const divider =
          items.every((item) => item.kind === 'path') &&
          width > height * 30 &&
          height <= page.height * 0.025 &&
          !page.lines.some(
            (line) =>
              line.text.trim() &&
              intersection(lineRect(line), rect) > 0 &&
              !pageCaptions.some((c) => intersection(c.rect, lineRect(line)) > 0)
          )
        return width >= 12 && height >= 12 && !divider
      })
      .flat()
    // A pure-vector plate can sit above its caption while the next figure is
    // already painted below that caption. The direction check is otherwise
    // conservative and rejects the upper figure as ambiguous. Use the later
    // figure caption as a boundary only when substantial graphics occupy both
    // sides and that caption follows the lower component.
    if (
      meaningful.length > 1 &&
      meaningful.every((item) => item.kind === 'path') &&
      captionKind(caption.lines?.[0] ?? '') === 'figure'
    ) {
      const above = meaningful.filter((item) => item.rect[3] <= caption.rect[1] + edgeTolerance)
      const below = meaningful.filter((item) => item.rect[1] >= caption.rect[3] - edgeTolerance)
      const laterCaption = pageCaptions
        .filter(
          (other) =>
            other !== caption &&
            captionKind(other.lines?.[0] ?? '') === 'figure' &&
            other.rect[1] > caption.rect[3] + edgeTolerance
        )
        .sort((a, b) => a.rect[1] - b.rect[1])
        .find((other) => {
          if (!below.length) return false
          if (
            other.rect[1] <=
            below.reduce((maximum, item) => Math.max(maximum, item.rect[3]), -Infinity) +
              edgeTolerance
          )
            return false
          const overlap =
            Math.min(other.rect[2], caption.rect[2]) - Math.max(other.rect[0], caption.rect[0])
          return (
            overlap >=
            Math.min(other.rect[2] - other.rect[0], caption.rect[2] - caption.rect[0]) * 0.5
          )
        })
      if (above.length >= 3 && below.length >= 3 && laterCaption) {
        const aboveBounds = union(above.map((item) => item.rect))
        const belowBounds = union(below.map((item) => item.rect))
        if (
          area(aboveBounds) >= page.width * page.height * 0.005 &&
          area(belowBounds) >= page.width * page.height * 0.005
        )
          meaningful = above
      }
    }
    // A page can place two raster plates one above the other, with the upper
    // plate's figure caption between the graphics. The generic adjacency pass
    // may otherwise assign both plates to the lower caption. Treat an
    // intervening figure caption as an ownership barrier only when graphics
    // clearly exist on both sides and retain the contiguous component nearest
    // the current caption.
    if (meaningful.length > 1 && captionKind(caption.lines?.[0] ?? '') === 'figure') {
      const bounds = union(meaningful.map((item) => item.rect))
      const barriers = pageCaptions
        .filter((other) => {
          if (other === caption || captionKind(other.lines?.[0] ?? '') !== 'figure') return false
          if (other.rect[1] <= bounds[1] + edgeTolerance) return false
          if (other.rect[3] >= caption.rect[1] - edgeTolerance) return false
          if (Math.min(other.rect[2], bounds[2]) <= Math.max(other.rect[0], bounds[0])) return false
          const above = meaningful.some((item) => item.rect[3] <= other.rect[1] + edgeTolerance)
          const below = meaningful.some((item) => item.rect[1] >= other.rect[3] - edgeTolerance)
          return above && below
        })
        .sort((a, b) => b.rect[3] - a.rect[3])
      const barrier = barriers[0]
      if (barrier) {
        const retained = meaningful.filter(
          (item) => item.rect[1] >= barrier.rect[3] - edgeTolerance
        )
        if (retained.length && retained.length < meaningful.length) meaningful = retained
      }
    }
    // On two-column pages, a left-column caption can be horizontally adjacent
    // to the next column's plot while that plot is owned by a later caption.
    // Keep the left figure's above-caption component when every competing side
    // graphic sits inside that later caption's column and above its caption.
    // This is narrower than resolving arbitrary above/below ambiguity and
    // preserves the conservative contract for genuinely composite figures.
    if (meaningful.some((item) => item.side === 'right') && meaningful.some((item) => !item.side)) {
      const sideOwners = pageCaptions.filter(
        (other) =>
          other !== caption &&
          other.rect[0] >= caption.rect[2] - edgeTolerance &&
          other.rect[1] > caption.rect[3] &&
          other.rect[1] - caption.rect[3] < page.height * 0.35
      )
      const foreignSideGraphics = meaningful.filter(
        (item) =>
          item.side === 'right' &&
          sideOwners.some(
            (owner) =>
              item.rect[0] >= owner.rect[0] - edgeTolerance &&
              item.rect[2] <= owner.rect[2] + edgeTolerance &&
              item.rect[3] <= owner.rect[1] + edgeTolerance
          )
      )
      const sideGraphics = meaningful.filter((item) => item.side === 'right')
      if (foreignSideGraphics.length === sideGraphics.length)
        meaningful = meaningful.filter((item) => item.side !== 'right')
    }
    const graphics = meaningful.map((item) => item.rect)
    const sides = new Set(meaningful.map((item) => item.side))
    if (sides.size > 1 || (sides.size === 1 && sides.has(undefined))) {
      // A caption printed in a narrow side column can make panels above and
      // below it look like different directions even though every retained
      // graphic is on the same lateral side. Recover only when the caption is
      // clearly a side label and no retained graphic crosses its column.
      const captionWidth = caption.rect[2] - caption.rect[0]
      const pageSide =
        caption.rect[2] <= page.width * 0.45
          ? 'right'
          : caption.rect[0] >= page.width * 0.55
            ? 'left'
            : undefined
      const lateral =
        pageSide === 'right'
          ? meaningful.every((item) => item.rect[0] >= caption.rect[2] - edgeTolerance)
          : pageSide === 'left'
            ? meaningful.every((item) => item.rect[2] <= caption.rect[0] + edgeTolerance)
            : false
      if (pageSide && captionWidth <= page.width * 0.4 && lateral) {
        for (const item of meaningful) item.side = pageSide
        sides.clear()
        sides.add(pageSide)
      } else if (sides.size > 1)
        return enclosed() ?? { caption, reason: 'ambiguous-graphic-direction' }
    }
    const side = sides.size === 1 ? meaningful[0]?.side : undefined
    if (!graphics.length)
      return enclosed() ?? { caption, reason: 'no-unambiguous-adjacent-graphics' }
    if (
      !side &&
      graphics.some((rect) => rect[3] <= caption.rect[1] + edgeTolerance) &&
      graphics.some((rect) => rect[1] >= caption.rect[3] - edgeTolerance)
    )
      return enclosed() ?? { caption, reason: 'ambiguous-graphic-direction' }
    const bounds = union(graphics)
    // An above-numbered magazine chart can end with a paragraph and a citation
    // inside the same ruled column. A matching closing rule bounds that legend.
    if (
      plates.length === 1 &&
      /^(?:FIGURE|Fig\.)\s*\d+\.?$/i.test(caption.lines.join(' ')) &&
      caption.rect[3] < plates[0].rect[1]
    ) {
      const p = plates[0].rect
      const closing = rules
        .filter(
          (r) =>
            r[1] === r[3] &&
            r[1] > p[3] &&
            r[1] - p[3] < page.height * 0.2 &&
            Math.abs(r[0] - p[0]) < 8 &&
            Math.abs(r[2] - p[2]) < 8
        )
        .sort((a, b) => a[1] - b[1])[0]
      if (closing) {
        const tail = groupPageLines(page).filter(
          (l) => l.y >= p[3] - 4 && l.bottom < closing[1] && l.x >= p[0] - 4 && l.right <= p[2] + 4
        )
        if (
          tail.length >= 4 &&
          tail.some((l) => /\d{4}[.]?$/.test(l.text)) &&
          tail.every((l, n) => !n || l.y - tail[n - 1].bottom < l.fontSize * 1.5)
        )
          return {
            caption: { ...caption, lines: [...caption.lines, ...tail.map((l) => l.text)] },
            rect: [p[0], caption.rect[3] + 2, p[2], closing[1]],
            graphicsCount: 1
          }
      }
    }
    // Some older plots outline every axis glyph as a separate tiny path.
    // A side legend's distance limit excludes the far axis; recover only a
    // cluster near a substantial vector panel, clear of other content.
    if (
      meaningful.every((g) => g.kind === 'path') ||
      meaningful.some((g) => g.kind === 'image' && area(g.rect) > page.width * page.height * 0.05)
    ) {
      const outlined = page.graphicsBounds
        .filter((g) => g.kind === 'path')
        .map((g) => g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)))
        .filter(
          (r) =>
            r[2] - r[0] <= 12 + edgeTolerance &&
            r[3] - r[1] <= 12 + edgeTolerance &&
            !(numberedAuthorHead && r[3] < page.height * 0.07) &&
            r[0] >=
              Math.max(
                side === 'right' ? caption.rect[2] + 2 : 0,
                bounds[0] - (plates.length ? 80 : 32)
              ) &&
            r[2] <= bounds[2] + 32 &&
            r[1] >= bounds[1] - 24 &&
            r[3] <= Math.max(bounds[3] + 32, plates.length ? caption.rect[3] + 32 : 0) &&
            // Label recovery must stay on the owned side of the caption. A
            // later panel's outlined letters cannot turn an above-caption
            // raster into a below-caption figure and clip away that raster.
            (side ||
              (bounds[3] <= caption.rect[1] + edgeTolerance
                ? r[3] <= caption.rect[1]
                : bounds[1] >= caption.rect[3] - edgeTolerance
                  ? r[1] >= caption.rect[3]
                  : true)) &&
            !pageCaptions.some((c) => intersection(c.rect, r) > 0) &&
            !foreignPanelOwns(r) &&
            !barriers.some((l) => intersection(lineRect(l), r) > 0) &&
            !tableRects.some((t) => intersection(t, r) > 0)
        )
      if (
        outlined.length >= 6 &&
        (side ||
          outlined.reduce((maximum, r) => Math.max(maximum, r[1]), -Infinity) -
            outlined.reduce((minimum, r) => Math.min(minimum, r[1]), Infinity) >
            24)
      ) {
        const extended = union([bounds, ...outlined])
        // Individually separate glyph boxes can span an independent caption
        // when combined. Keep the established face if their whole envelope
        // would newly claim any of that caption's area.
        if (
          !pageCaptions.some(
            (c) => c !== caption && intersection(c.rect, extended) > intersection(c.rect, bounds)
          )
        )
          bounds.splice(0, 4, ...extended)
      }
    }
    if (bounds[3] - bounds[1] < 12 || bounds[2] - bounds[0] < 12)
      return { caption, reason: 'no-unambiguous-adjacent-graphics' }
    const below =
      caption.rect[1] > bounds[1] && caption.rect[1] >= bounds[3] - Math.max(edgeTolerance, 8)
    // At-risk blocks belong to each plot, including upper panels in a stack.
    // Require an explicit heading near an owned graphic and at least two
    // numeric baselines; group labels may be separate runs left of the counts.
    const riskLabels = page.lines.filter(
      (line) =>
        (/^(?:n|No\.?|Number|Patients)(?: of(?: patients| subjects)?)?(?: still)? at risk\b/i.test(
          line.text.trim()
        ) ||
          (/Kaplan[–−-]Meier/i.test(caption.lines.join(' ')) &&
            /^(?:Years|Months|Days)$/i.test(line.text.trim()) &&
            page.lines.filter(
              (other) =>
                /^(?:\d+\s+){2,}\d+$/.test(other.text.trim()) &&
                other.y > line.y &&
                other.y - line.y < line.fontSize * 4 &&
                other.x < line.x &&
                other.x + other.width > line.x &&
                page.lines.some(
                  (stub) =>
                    /:$/u.test(stub.text.trim()) &&
                    stub.text.length < 24 &&
                    stub.x < other.x &&
                    other.x - stub.x - stub.width < line.fontSize * 2 &&
                    Math.abs(stub.y - other.y) < line.fontSize / 2
                )
            ).length >= 2)) &&
        (below || side) &&
        line.x >= bounds[0] - 100 &&
        line.x + line.width <= bounds[2] &&
        graphics.some((r) => line.y >= r[3] - 12 && line.y - r[3] <= 36)
    )
    for (const label of riskLabels) {
      const rows = page.lines.filter(
        (line) =>
          line.y > label.y &&
          line.y + line.height < (side ? page.height : caption.rect[1] - 2) &&
          line.y - label.y < 64 &&
          line.x >= Math.max(caption.rect[0] - 4, label.x - 120) &&
          line.x + line.width <= bounds[2] + 12 &&
          line.height <= 12 &&
          line.fontSize >= label.fontSize * 0.5 &&
          line.fontSize <= label.fontSize * 1.1 &&
          line.text.replace(/[\d\s.,:()%/+−-]/g, '').length < 20 &&
          !pageCaptions.some((c) => intersection(c.rect, lineRect(line)) > 0) &&
          !tableRects.some((r) => intersection(r, lineRect(line)) > 0) &&
          !continuesExternalParagraph(line, bounds, page.lines)
      )
      const counts = rows.filter((line) => /\d/.test(line.text))
      const supported = counts.filter((line) =>
        counts.some(
          (other) =>
            Math.abs(other.y - line.y) > line.height &&
            Math.abs(other.y - line.y) <= line.height * 3 &&
            Math.abs(other.x - line.x) <= label.fontSize * 2
        )
      )
      if (!supported.length) continue
      const content = rows.filter((line) =>
        supported.some((count) => Math.abs(count.y - line.y) < label.fontSize * 0.5)
      )
      bounds.splice(0, 4, ...union([bounds, lineRect(label), ...content.map(lineRect)]))
    }
    // Stacked vector plots can repeat a rotated axis title well beyond their
    // ticks. Matching native titles and alignment prove the shared outer edge.
    const axes = page.lines.filter(
      (l) =>
        l.fontSize > 0 &&
        l.fontSize <= 10 &&
        l.width <= l.fontSize * 1.3 &&
        l.height >= l.fontSize * 2 &&
        /\p{L}/u.test(l.text) &&
        l.y >= bounds[1] &&
        l.y + l.height <= bounds[3] &&
        l.x < bounds[0] &&
        l.x >= bounds[0] - 90 &&
        !pageCaptions.some((c) => intersection(c.rect, lineRect(l)) > 0) &&
        !tableRects.some((r) => intersection(r, lineRect(l)) > 0)
    )
    const repeatedAxes = axes.filter((l) =>
      axes.some(
        (o) =>
          o !== l &&
          o.text === l.text &&
          Math.abs(o.x - l.x) < 1 &&
          Math.abs(o.height - l.height) < 1 &&
          Math.abs(o.y - l.y) > l.height * 2
      )
    )
    if (repeatedAxes.length >= 2) bounds[0] = Math.min(bounds[0], ...repeatedAxes.map((l) => l.x))
    const paragraphRuns = page.lines.every((l) =>
      [l.x, l.y, l.width, l.height, l.fontSize].every(Number.isFinite)
    )
      ? groupPageLines(page)
      : []
    const nearby = page.lines.filter(
      (l) =>
        !runningHeaders.includes(l) &&
        !foreignPanelOwns(lineRect(l)) &&
        !externalProseOwnsMath(lineRect(l)) &&
        !(
          l.text.trim() === String(page.pageNumber) &&
          l.y < page.height * 0.07 &&
          (l.x > page.width * 0.85 || l.x < page.width * 0.15) &&
          l.y + l.height <= bounds[1] - l.fontSize * 0.5 &&
          !graphics.some((r) => intersection(r, lineRect(l)) > 0)
        ) &&
        !(/^(?:FIGURE )?LEGENDS$/i.test(l.text.trim()) && l.y + l.height < bounds[1]) &&
        // A manuscript wrapper can repeat the printed page number below a plate.
        // Require its independent "Page N of M" witness before dropping a number.
        !(
          /^\d+$/.test(l.text.trim()) &&
          l.y > Math.max(bounds[3], page.height * 0.9) &&
          Math.abs(l.x + l.width / 2 - page.width / 2) < page.width * 0.03 &&
          page.lines.some(
            (other) =>
              other.y > page.height * 0.9 &&
              /^Page (\d+) of \d+$/i.exec(other.text.trim())?.[1] === l.text.trim()
          )
        ) &&
        !(numberedAuthorHead && l.y + l.height < page.height * 0.055) &&
        !tableRects.some((r) => intersection(r, lineRect(l)) > 0) &&
        !(
          l.y < page.height * 0.045 &&
          page.lines.some(
            (other) =>
              /^\d+ of \d+$/.test(other.text.trim()) &&
              Math.abs(other.y - l.y) < Math.max(other.height, l.height)
          )
        ) &&
        l.y >=
          Math.max(
            bounds[1] -
              (/^[a-z]$/i.test(l.text.trim()) && Math.abs(l.x - bounds[0]) <= 24
                ? Math.max(24, l.height * 3)
                : 24),
            side || below ? 0 : caption.rect[3] + 0.5
          ) &&
        !separators.some((r) => r[1] > l.y + l.height && r[3] < bounds[1]) &&
        l.y + l.height <=
          Math.min(bounds[3] + 24, !side && below ? caption.rect[1] - 2 : page.height) &&
        l.x >= bounds[0] - 24 &&
        (l.x + l.width <= bounds[2] + 24 ||
          // A short legend can extend beyond the plot edge. For an ordinary
          // below/above caption, require an adjacent small marker inside the plot.
          ((side === 'right' ||
            (!side &&
              graphics.some(
                (r) =>
                  r[2] - r[0] >= 4 &&
                  r[2] - r[0] <= l.fontSize * 4 &&
                  r[3] - r[1] >= 3 &&
                  r[3] - r[1] <= l.fontSize * 3 &&
                  l.x >= r[2] &&
                  l.x - r[2] <= l.fontSize * 2 &&
                  l.y + l.height / 2 >= r[1] &&
                  l.y + l.height / 2 <= r[3]
              ))) &&
            l.x <= bounds[2] + 12 &&
            l.x >= bounds[2] - 24 &&
            l.y >= bounds[1] &&
            l.y + l.height <= bounds[3] &&
            l.width <= Math.max(24, l.height * 14) &&
            l.text.length <= 60)) &&
        !pageCaptions.some((c) => intersection(c.rect, lineRect(l)) > 0) &&
        !continuesExternalParagraph(l, bounds, page.lines) &&
        !continuesSideParagraph(l, bounds, paragraphRuns)
    )
    // Two stacked panels can repeat a short outside key beyond ordinary tick
    // padding. Distinct native panel letters and two repeated key lines prove
    // that column; an isolated label or prose neighbour supplies no such proof.
    // Paired repeated native vector grids can own a small title beyond the fixed label pad.
    if (meaningful.every((g) => g.kind === 'path'))
      nearby.push(...pairedVectorTopTitles(page, caption, tableRects, graphics, bounds, nearby))
    const outsideKeys = page.lines.filter(
      (line) =>
        line.fontSize > 0 &&
        line.fontSize <= 12 &&
        line.height <= line.fontSize * 1.2 &&
        line.text.length >= 2 &&
        line.text.length <= 30 &&
        /\p{L}/u.test(line.text) &&
        !/[.!?]$/.test(line.text.trim()) &&
        line.x < bounds[0] - 24 &&
        line.x >= bounds[0] - line.fontSize * 5 &&
        line.x + line.width <= bounds[0] + line.fontSize * 0.2 &&
        bounds[0] - line.x - line.width <= line.fontSize * 2 &&
        line.y >= bounds[1] &&
        line.y + line.height <= bounds[3] &&
        !foreignPanelOwns(lineRect(line)) &&
        !pageCaptions.some((c) => intersection(c.rect, lineRect(line)) > 0) &&
        !tableRects.some((r) => intersection(r, lineRect(line)) > 0) &&
        !continuesExternalParagraph(line, bounds, page.lines) &&
        !page.lines.some(
          (other) =>
            other.text.length > 60 &&
            Math.abs(other.x - line.x) < line.fontSize * 2 &&
            Math.abs(other.y - line.y) < line.fontSize * 3
        )
    )
    const keyPairs = outsideKeys.flatMap((line, n) =>
      outsideKeys
        .slice(n + 1)
        .flatMap((other) =>
          other.text === line.text &&
          Math.abs(other.x - line.x) < line.fontSize * 0.05 &&
          Math.abs(other.fontSize - line.fontSize) < 0.2 &&
          other.y - line.y > line.fontSize * 6
            ? [[line, other]]
            : []
        )
    )
    const panelKeys = keyPairs.flatMap((pair) => {
      const marks = pair.map((key) =>
        page.lines.filter(
          (line) =>
            /^\([a-z]\)$/.test(line.text.trim()) &&
            line.fontSize >= key.fontSize &&
            line.fontSize <= key.fontSize * 1.3 &&
            line.x >= key.x - key.fontSize &&
            line.x <= key.x + key.fontSize * 2 &&
            line.y < key.y &&
            key.y - line.y <= key.fontSize * 7 &&
            (() => {
              const strokes = graphics.filter(
                (r) =>
                  r[0] >= bounds[0] &&
                  r[2] - r[0] > key.fontSize * 4 &&
                  r[3] - r[1] > key.fontSize &&
                  r[1] >= line.y - line.fontSize &&
                  r[3] <= key.y + key.fontSize * 6
              )
              if (!strokes.length) return false
              const panel = union(strokes)
              return (
                panel[3] - panel[1] > key.fontSize * 5 &&
                Math.abs(panel[1] - line.y) < line.fontSize &&
                key.y >= panel[1] &&
                key.y + key.height <= panel[3]
              )
            })() &&
            !foreignPanelOwns(lineRect(line)) &&
            !pageCaptions.some((c) => intersection(c.rect, lineRect(line)) > 0) &&
            !tableRects.some((r) => intersection(r, lineRect(line)) > 0)
        )
      )
      return marks.every((items) => items.length === 1) &&
        marks[0][0].text !== marks[1][0].text &&
        Math.abs(pair[0].y - marks[0][0].y - pair[1].y + marks[1][0].y) < pair[0].fontSize
        ? [{ pair, marks: marks.flat() }]
        : []
    })
    if (new Set(panelKeys.map(({ pair }) => pair[0].text)).size >= 2)
      nearby.push(...new Set(panelKeys.flatMap(({ pair, marks }) => [...pair, ...marks])))
    // A forest/bar comparison prints its confidence interval to the right of
    // the axis. Adjacent statistical headings or P values independently own
    // the entire native run, including the interval's otherwise clipped end.
    for (const line of page.lines) {
      if (
        /\(\d{2}%\s*CI\b/.test(line.text) &&
        line.text.length < 100 &&
        line.fontSize > 0 &&
        line.fontSize <= 10 &&
        line.height <= line.fontSize * 1.3 &&
        line.x >= bounds[0] &&
        line.x <= bounds[2] &&
        line.x + line.width <= bounds[2] + line.fontSize * 8 &&
        line.y >= bounds[1] &&
        line.y + line.height <= bounds[3] &&
        nearby.some(
          (other) =>
            /^(?:Absolute difference|Exact P\s*=)/.test(other.text) &&
            Math.abs(other.y - line.y) <= line.fontSize * 2 &&
            Math.abs(other.x + other.width / 2 - line.x - line.width / 2) < line.fontSize * 2
        ) &&
        !pageCaptions.some((c) => intersection(c.rect, lineRect(line)) > 0) &&
        !tableRects.some((r) => intersection(r, lineRect(line)) > 0) &&
        !continuesExternalParagraph(line, bounds, page.lines)
      )
        nearby.push(line)
    }
    for (const line of page.lines) {
      // A legend can contain a longer middle entry. Two short neighbours at
      // the same baseline spacing establish its column independently of width.
      const aligned = nearby.filter(
        (other) =>
          other !== line &&
          other.text.length < 30 &&
          other.width <= other.fontSize * 7 &&
          Math.abs(other.x - line.x) <= line.fontSize / 2 &&
          Math.abs(other.fontSize - line.fontSize) < 0.5 &&
          Math.abs(other.y - line.y) > line.height * 0.8 &&
          Math.abs(other.y - line.y) < line.height * 1.8
      )
      const widthLimit = line.fontSize * (aligned.length >= 2 ? 14 : 7)
      if (
        nearby.includes(line) ||
        foreignPanelOwns(lineRect(line)) ||
        line.text.length > 30 ||
        line.width > widthLimit ||
        line.y < bounds[1] ||
        line.y + line.height > bounds[3] ||
        line.x > bounds[2] + 12 ||
        line.x + line.width > bounds[2] + widthLimit ||
        pageCaptions.some((c) => intersection(c.rect, lineRect(line)) > 0) ||
        tableRects.some((r) => intersection(r, lineRect(line)) > 0) ||
        continuesExternalParagraph(line, bounds, page.lines) ||
        continuesSideParagraph(line, bounds, paragraphRuns)
      )
        continue
      if (aligned.some((other) => other.x >= bounds[2] - 24)) nearby.push(line)
    }
    if (diagramFrames.length >= 3) {
      const titles = groupPageLines(page)
        .map((l) => ({ ...l, width: l.right - l.x, height: l.bottom - l.y }))
        .filter(
          (line) =>
            /\bflow\s*(?:chart|diagram)$/i.test(line.text.trim()) &&
            line.y + line.height < bounds[1] &&
            bounds[1] - line.y - line.height < line.fontSize * 4 &&
            line.x >= bounds[0] &&
            line.x + line.width <= bounds[2]
        )
      if (
        titles.length === 1 &&
        !page.lines.some(
          (line) =>
            line.y > titles[0].y + titles[0].height &&
            line.y + line.height < bounds[1] &&
            line.x < bounds[2] &&
            line.x + line.width > bounds[0] &&
            line.text.length > 40
        )
      )
        nearby.push(titles[0])
      // A boxed abbreviation key can be detached from the flowchart's nodes.
      // Its definition and enclosing native path establish ownership beyond
      // the ordinary label padding without absorbing an adjacent paragraph.
      if (side && /\bflow\s*(?:chart|diagram)\b/i.test(caption.lines.join(' ')))
        for (const note of page.lines.filter(
          (l) =>
            /^\*?\p{L}{2,12}\s*[=:]/u.test(l.text) &&
            l.y > bounds[3] &&
            l.y - bounds[3] < 48 &&
            l.x >= bounds[0] &&
            l.x + l.width <= bounds[2]
        )) {
          const frame = page.graphicsBounds
            .filter((g) => g.kind === 'path')
            .map((g) => g.normalizedRect.map((v, n) => v * (n % 2 ? page.height : page.width)))
            .find(
              (r) =>
                r[1] > bounds[3] &&
                r[3] < note.y + note.height + 8 &&
                r[2] - r[0] > note.width &&
                intersection(r, lineRect(note)) / area(lineRect(note)) > 0.95
            )
          if (frame && !tableRects.some((t) => intersection(t, frame) > 0))
            bounds.splice(0, 4, ...union([bounds, frame]))
        }
    }
    // A detached key below an above-captioned diagram can exceed the normal
    // label padding. Require several aligned explicit definitions and stop at
    // any intervening prose; never extend a crop merely because text is nearby.
    if (
      !below &&
      !side &&
      caption.rect[3] < bounds[1] &&
      page.lines.every((line) => Number.isFinite(line.fontSize))
    ) {
      const tail = groupPageLines(page)
        .filter(
          (line) => line.y >= bounds[3] && line.x >= bounds[0] - 12 && line.right <= bounds[2] + 12
        )
        .sort((a, b) => a.y - b.y)
      const key = []
      for (const line of tail) {
        const previous = key.at(-1)
        if (
          !/^(?:[A-Za-z][A-Za-z\d]{0,7}|[*^†‡])\s*=\s*\p{L}/u.test(line.text.trim()) ||
          line.y - (previous?.bottom ?? bounds[3]) > line.fontSize * (previous ? 1.5 : 3) ||
          (previous &&
            (Math.abs(line.x - previous.x) > 2 ||
              Math.abs(line.fontSize - previous.fontSize) > 0.5)) ||
          pageCaptions.some(
            (c) => intersection(c.rect, [line.x, line.y, line.right, line.bottom]) > 0
          ) ||
          tableRects.some((r) => intersection(r, [line.x, line.y, line.right, line.bottom]) > 0)
        )
          break
        key.push(line)
      }
      if (key.length >= 3)
        nearby.push(
          ...key.map((line) => ({
            ...line,
            width: line.right - line.x,
            height: line.bottom - line.y
          }))
        )
    }
    // Dense category plots put long labels to the left of a narrow plotting
    // area. Repeated right alignment and a shared small font establish ownership.
    const categoryLabels = page.lines.filter(
      (line) =>
        line.x < bounds[0] - 24 &&
        Math.abs(line.x + line.width - bounds[0]) <= 24 &&
        line.y >= bounds[1] &&
        line.y + line.height <= bounds[3] &&
        line.fontSize > 0 &&
        line.fontSize <= 8 &&
        line.height <= line.fontSize * 1.2 &&
        line.width < page.width * 0.55 &&
        page.lines.filter(
          (other) =>
            other !== line &&
            other.text.length > 50 &&
            Math.abs(other.x + other.width - line.x - line.width) < 2 &&
            Math.abs(other.y - line.y) <= line.height * 4
        ).length < 2 &&
        !continuesExternalParagraph(line, bounds, page.lines) &&
        /\p{L}/u.test(line.text) &&
        !pageCaptions.some((c) => intersection(c.rect, lineRect(line)) > 0) &&
        !tableRects.some((r) => intersection(r, lineRect(line)) > 0)
    )
    for (const line of categoryLabels) {
      const aligned = categoryLabels.filter(
        (other) =>
          Math.abs(other.x + other.width - line.x - line.width) <= 1 &&
          Math.abs(other.fontSize - line.fontSize) <= 0.2
      )
      if (
        aligned.length >= 6 &&
        Math.max(...aligned.map((l) => l.width)) - Math.min(...aligned.map((l) => l.width)) >= 30 &&
        Math.max(...aligned.map((l) => l.y)) - Math.min(...aligned.map((l) => l.y)) >=
          line.fontSize * 8
      )
        nearby.push(line)
    }
    // Once a dense category axis is owned, its panel letter can sit above
    // and just left of that axis. PDF text runs may also fuse that letter with
    // the first category label, increasing the apparent font size of the line.
    const ownedCategories = categoryLabels.filter((line) => nearby.includes(line))
    if (ownedCategories.length >= 6) {
      const extent = union(ownedCategories.map(lineRect))
      nearby.push(
        ...page.lines.filter(
          (line) =>
            line.x >= extent[0] - line.fontSize &&
            line.x <= extent[0] + line.fontSize &&
            line.fontSize <= ownedCategories[0].fontSize * 2 &&
            line.height <= line.fontSize * 1.5 &&
            graphics.some((r) => Math.abs(line.y - r[1]) <= line.fontSize * 1.5) &&
            (/^[A-Z]$/.test(line.text.trim()) ||
              (line.text.length < 100 && Math.abs(line.x + line.width - extent[2]) <= 2)) &&
            !pageCaptions.some((c) => intersection(c.rect, lineRect(line)) > 0) &&
            !tableRects.some((r) => intersection(r, lineRect(line)) > 0) &&
            !continuesExternalParagraph(line, bounds, page.lines)
        )
      )
    }
    const stubLabels = page.lines.filter(
      (line) =>
        line.x < bounds[0] - 24 &&
        line.x >= bounds[0] - 90 &&
        line.y >= bounds[1] - 24 &&
        line.y + line.height <= bounds[3] &&
        line.fontSize <= 8 &&
        line.height <= line.fontSize * 1.2 &&
        line.text.length <= 35 &&
        /\p{L}/u.test(line.text) &&
        !/[.!?]$/.test(line.text) &&
        !continuesExternalParagraph(line, bounds, page.lines) &&
        !page.lines.some(
          (other) =>
            other.text.length > 60 &&
            Math.abs(other.x - line.x) <= line.fontSize * 2 &&
            Math.abs(other.y - line.y) < line.height * 2.5 &&
            Math.abs(other.fontSize - line.fontSize) < 0.5
        ) &&
        !pageCaptions.some((c) => intersection(c.rect, lineRect(line)) > 0) &&
        !tableRects.some((r) => intersection(r, lineRect(line)) > 0)
    )
    for (const line of stubLabels) {
      if (
        stubLabels.filter(
          (other) =>
            Math.abs(other.x - line.x) <= 1 && Math.abs(other.fontSize - line.fontSize) <= 0.2
        ).length >= 6
      )
        nearby.push(line)
    }
    // Panel letters can share the outdented stub column rather than the raster edge.
    for (const line of page.lines) {
      if (
        /^[A-Z](?:\s+[A-Z])*$/.test(line.text.trim()) &&
        line.x + line.width <= bounds[2] &&
        line.y >= bounds[1] - 24 &&
        line.y + line.height <= bounds[3] &&
        nearby.some(
          (label) =>
            label.text.length > 1 &&
            label.text.length <= 35 &&
            Math.abs(label.x - line.x) <= 1 &&
            label.y >= line.y + line.height &&
            label.y - line.y - line.height <= line.fontSize * 2
        ) &&
        !pageCaptions.some((c) => intersection(c.rect, lineRect(line)) > 0) &&
        !tableRects.some((r) => intersection(r, lineRect(line)) > 0)
      )
        nearby.push(line)
    }
    // Rotated category labels below a heatmap extend farther than tick padding.
    // Keep a repeated top-aligned set inside the chart width and above its caption.
    const rotatedLabels = page.lines.filter(
      (line) =>
        line.fontSize > 0 &&
        Math.abs(line.width - line.fontSize) < line.fontSize * 0.2 &&
        line.height > line.fontSize * 3 &&
        line.height < page.height * 0.18 &&
        line.x >= bounds[0] &&
        line.x + line.width <= bounds[2] &&
        line.y >= bounds[3] - 24 &&
        line.y <= bounds[3] + 24 &&
        line.y + line.height < (below ? caption.rect[1] - 2 : page.height) &&
        !pageCaptions.some((c) => intersection(c.rect, lineRect(line)) > 0)
    )
    for (const line of rotatedLabels) {
      if (
        rotatedLabels.filter(
          (other) =>
            Math.abs(other.y - line.y) < line.fontSize &&
            Math.abs(other.fontSize - line.fontSize) < 0.2
        ).length >= 4
      )
        nearby.push(line)
    }
    // Forty-five-degree PDF text has a square painted box, rather than the
    // font-width box of a vertical label. Require at least four top-aligned
    // peers before retaining their complete glyphs and the unique axis title.
    const diagonal = page.lines.filter(
      (line) =>
        line.fontSize > 0 &&
        line.fontSize <= 8 &&
        Math.abs(line.width - line.height) < line.fontSize * 0.05 &&
        line.height >= line.fontSize * 2 &&
        line.height < page.height * 0.1 &&
        line.x >= bounds[0] - line.width &&
        line.x + line.width > bounds[0] &&
        line.x + line.width <= bounds[2] &&
        Math.abs(line.y - bounds[3]) < 24 &&
        line.y + line.height < caption.rect[1] - 2 &&
        !pageCaptions.some((c) => intersection(c.rect, lineRect(line)) > 0) &&
        !tableRects.some((r) => intersection(r, lineRect(line)) > 0)
    )
    const diagonalPeers = diagonal.filter(
      (line) =>
        diagonal.filter(
          (other) =>
            Math.abs(other.y - line.y) < line.fontSize &&
            Math.abs(other.fontSize - line.fontSize) < 0.2
        ).length >= 4
    )
    if (below && diagonalPeers.length >= 4) {
      nearby.push(...diagonalPeers)
      const cluster = union(diagonalPeers.map(lineRect)),
        font = diagonalPeers[0].fontSize
      nearby.push(
        ...page.lines.filter(
          (line) =>
            line.fontSize > 0 &&
            Math.abs(line.fontSize - font) < 0.2 &&
            Math.abs(line.width - line.height) < font * 0.05 &&
            line.x >= cluster[0] - font &&
            line.x + line.width <= cluster[2] + font &&
            line.y >= cluster[1] &&
            line.y + line.height <= cluster[3] + font &&
            !pageCaptions.some((c) => intersection(c.rect, lineRect(line)) > 0)
        )
      )
      const titles = page.lines.filter(
        (line) =>
          line.text.length >= 3 &&
          line.text.length <= 40 &&
          line.fontSize >= font &&
          line.fontSize <= font * 1.5 &&
          Math.abs(line.height - line.fontSize) < 0.2 &&
          line.y >= cluster[3] &&
          line.y - cluster[3] <= font * 2 &&
          Math.abs(line.x + line.width / 2 - (cluster[0] + cluster[2]) / 2) <= font * 4 &&
          line.y + line.height < caption.rect[1] - 2 &&
          !tableRects.some((r) => intersection(r, lineRect(line)) > 0)
      )
      if (titles.length === 1 && !continuesExternalParagraph(titles[0], bounds, page.lines))
        nearby.push(titles[0])
    }
    // Vertical axis titles can sit beyond the fixed padding, outside the tick labels.
    // Require a tall, font-width box beside at least two already-owned numeric ticks;
    // ordinary prose and page-margin watermarks cannot expand the crop this way.
    const ticks = nearby.filter((l) => /^[−-]?\d+(?:\.\d+)?%?$/.test(l.text.trim()))
    for (const line of page.lines) {
      if (
        nearby.includes(line) ||
        line.fontSize <= 0 ||
        Math.abs(line.width - line.fontSize) > line.fontSize * 0.2 ||
        line.height < line.fontSize * 3 ||
        line.y < bounds[1] - line.fontSize * 2 ||
        line.y + line.height > bounds[3] + line.fontSize * 2 ||
        (below && line.y + line.height >= caption.rect[1] - 2) ||
        pageCaptions.some((c) => intersection(c.rect, lineRect(line)) > 0)
      )
        continue
      const left = line.x + line.width < bounds[0]
      const right = line.x > bounds[2]
      if (!left && !right) continue
      const neighbors = ticks.filter((tick) => {
        const gap = left ? tick.x - line.x - line.width : line.x - tick.x - tick.width
        return (
          (left
            ? tick.x + tick.width <= bounds[0] + tick.fontSize * 0.2
            : tick.x >= bounds[2] - tick.fontSize * 0.2) &&
          gap >= 0 &&
          gap <= line.fontSize * 2.5
        )
      })
      if (neighbors.length >= 2) nearby.push(line)
    }
    // A centered two-line chart title can begin just outside the label margin.
    // Extend only from a title line already above the plot, matching its font and center.
    const titleTails = nearby.filter((l) => l.y + l.height <= bounds[1] && l.text.length < 70)
    for (const tail of titleTails) {
      const preceding = page.lines.filter(
        (l) =>
          l.y + l.height <= tail.y &&
          tail.y - l.y - l.height <= tail.height * 0.6 &&
          Math.abs(l.fontSize - tail.fontSize) < 0.2 &&
          (Math.abs(l.x + l.width / 2 - tail.x - tail.width / 2) <= tail.height * 2 ||
            (/^(?:Figure|Fig\.)\s*\d+\.?$/i.test(caption.lines.join(' ')) &&
              Math.abs(l.x - tail.x) < 1 &&
              Math.abs(l.x - caption.rect[0]) < 4)) &&
          l.x >= bounds[0] &&
          l.x + l.width <= bounds[2] &&
          l.text.length < 70 &&
          !pageCaptions.some((c) => intersection(c.rect, lineRect(l)) > 0) &&
          !continuesExternalParagraph(l, bounds, page.lines)
      )
      nearby.push(...preceding.filter((l) => !nearby.includes(l)))
    }
    nearby.push(
      ...nativeOwnedFigureLabels(
        page,
        caption,
        pageCaptions,
        tableRects,
        union([bounds, ...nearby.map(lineRect)]),
        (rect) => foreignPanelOwns(rect) || externalProseOwnsMath(rect)
      )
    )
    nearby.push(...nativePanelTopHeading(page, pageCaptions, tableRects, bounds, rules))
    const glyphTails = nativeOwnedFigureGlyphTails(
      page,
      caption,
      pageCaptions,
      tableRects,
      union([bounds, ...nearby.map(lineRect)]),
      nativeTokens
    )
    nearby.push(...glyphTails)
    const proseRows = page.lines.every((l) =>
      [l.x, l.y, l.width, l.height, l.fontSize].every(Number.isFinite)
    )
      ? groupPageLines(page).map((l) => ({
          ...l,
          width: l.right - l.x,
          height: l.bottom - l.y
        }))
      : page.lines
    const topProse = proseRows.filter((l) =>
      nativeTopParagraphTail(l, bounds, proseRows, pageCaptions)
    )
    // Apply the same lower-caption boundary used by the final crop below.
    // Quantized image boxes can otherwise extend into their own caption.
    const crossPageProse =
      below &&
      !side &&
      nativeCrossPageProse(
        page,
        [bounds[0], bounds[1], bounds[2], Math.min(bounds[3], caption.rect[1] - 2)],
        caption,
        pageCaptions,
        operatorContext,
        previousProseEvidence
      )
    if (crossPageProse) topProse.push(crossPageProse.line)
    const excludedProse = new Set(
      page.lines.filter((l) =>
        topProse.some(
          (p) =>
            intersection(lineRect(l), lineRect(p)) / area(lineRect(l)) > 0.8 ||
            (l.fontSize < p.fontSize * 0.8 &&
              l.x >= p.x &&
              l.x + l.width <= p.x + p.width &&
              l.y >= p.y &&
              l.y + l.height <= p.y + p.height + p.fontSize * 0.5 &&
              l.y + l.height < bounds[1])
        )
      )
    )
    for (const l of page.lines)
      if (
        l.y + l.height <= bounds[1] &&
        /^(?:Figure|Fig\.)\s*\d+\b/i.test(l.text) &&
        !captionKind(l.text)
      )
        excludedProse.add(l)
    const rect = boundByExternalParagraphs(
      union([
        bounds,
        ...nearby
          .filter(
            (line) =>
              !foreignPanelOwns(lineRect(line)) &&
              !externalProseOwnsMath(lineRect(line)) &&
              !excludedProse.has(line)
          )
          .map(lineRect),
        ...glyphTails.map((l) => l.cropRect)
      ]),
      bounds,
      // Native superscripts/font changes can split one prose baseline into
      // short runs. Use the same reconstructed lines as side-paragraph checks.
      (paragraphRuns.length
        ? paragraphRuns
        : page.lines.every((l) => [l.x, l.y, l.width, l.height, l.fontSize].every(Number.isFinite))
          ? groupPageLines(page)
          : page.lines
      ).map((l) => ({ ...l, width: l.width ?? l.right - l.x, height: l.height ?? l.bottom - l.y }))
    )
    const collapsedAxis = collapsedNativeAxisLeft(
      { ...page, lines: originalLines },
      caption,
      tableRects,
      rules,
      bounds
    )
    if (
      collapsedAxis !== undefined &&
      !pageCaptions.some(
        (c) =>
          c !== caption &&
          intersection(c.rect, [collapsedAxis, bounds[1], bounds[0], bounds[3]]) > 0
      )
    )
      rect[0] = Math.min(rect[0], collapsedAxis)
    // On a single-figure page, several retained labels inside one raster
    // establish that panel's full painted extent, even when its distance
    // from the caption exceeded the initial association window.
    if (captions.length === 1 && !tableRects.length) {
      for (const g of page.graphicsBounds.filter((g) => g.kind === 'image')) {
        const r = g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
        if (
          area(g.normalizedRect) >= 0.01 &&
          area(g.normalizedRect) <= 0.2 &&
          intersection(r, rect) / area(r) > 0.5 &&
          intersection(r, caption.rect) === 0 &&
          nearby.filter((l) => intersection(lineRect(l), r) / area(lineRect(l)) > 0.95).length >=
            3 &&
          !pageCaptions.some((c) => c !== caption && intersection(c.rect, r) > 0)
        )
          rect.splice(0, 4, ...union([rect, r]))
      }
    }
    // Native figure notes may begin inside a raster's quantized bottom box.
    // Keep the complete aligned note block instead of cropping through its
    // first line. A new caption, table, font or paragraph gap ends ownership.
    if (!side && !below && plates.length === 1) {
      const first = page.lines.find(
        (l) =>
          /^(?:Notes?:|The vertical lines are .*confidence intervals?\b|Each (?:dot|bar) represents the coefficient\b)/i.test(
            l.text
          ) &&
          l.fontSize <= 10 &&
          Math.abs(l.y - bounds[3]) <= l.fontSize * 2 &&
          l.x >= bounds[0] - 2 &&
          l.x + l.width <= bounds[2] + 2
      )
      if (first) {
        const note = [first]
        for (const next of page.lines
          .filter((l) => l.y > first.y && l.x < first.x + first.width && l.x + l.width > first.x)
          .sort((a, b) => a.y - b.y)) {
          const previous = note.at(-1)
          if (
            next.y - previous.y > first.fontSize * 1.8 ||
            Math.abs(next.fontSize - first.fontSize) > 0.5 ||
            Math.abs(next.x - first.x) > 2 ||
            next.x + next.width > bounds[2] + 2 ||
            captionKind(next.text) ||
            tableRects.some((r) => intersection(r, lineRect(next)) > 0)
          )
            break
          note.push(next)
          if (/[.!?]$/.test(next.text) && next.width < first.width * 0.8) break
        }
        if (note.length >= 2 && note.length <= 12)
          rect.splice(0, 4, ...union([rect, ...note.map(lineRect)]))
      }
    }
    // Outlined vertical tick labels can graze a caption by one quantization
    // step and be rejected as prose. Repeated narrow boxes mostly inside the
    // owned figure establish the missing tails; the caption still bounds ink.
    if (below && !side) {
      const unitX = page.width / 256,
        unitY = page.height / 256
      const tails = page.graphicsBounds
        .filter((g) => g.kind === 'path')
        .map((g) => g.normalizedRect.map((v, n) => v * (n % 2 ? page.height : page.width)))
        .filter(
          (r) =>
            r[2] - r[0] <= unitX * 4 &&
            r[3] - r[1] >= (r[2] - r[0]) * 2 &&
            r[3] > rect[3] &&
            r[3] >= caption.rect[1] &&
            r[3] - caption.rect[1] <= unitY &&
            intersection(r, rect) / area(r) > 0.7 &&
            !tableRects.some((t) => intersection(t, r) > 0) &&
            !pageCaptions.some((c) => c !== caption && intersection(c.rect, r) > 0)
        )
      if (tails.some((r) => tails.filter((t) => Math.abs(t[1] - r[1]) <= unitY).length >= 3))
        rect[3] = tails.reduce((maximum, r) => Math.max(maximum, r[3]), rect[3])
    }
    // Recorded operation boxes are quantized; keep the caption itself out of the resulting crop.
    if (side === 'left') rect[2] = Math.min(rect[2], caption.rect[0] - 2)
    else if (side === 'right') rect[0] = Math.max(rect[0], caption.rect[2] + 2)
    else if (below) rect[3] = Math.min(rect[3], caption.rect[1] - 2)
    else rect[1] = Math.max(rect[1], caption.rect[3] + 0.5)
    // Some journals put only the figure number above the plate and its legend
    // below. Require a separate, aligned multiline block immediately below it.
    if (
      /^(?:Fig\.?|Figure)\s+\d+\.?$/i.test(caption.lines.join(' ')) &&
      caption.rect[3] < bounds[1]
    ) {
      const runs = groupPageLines(page)
      const first = runs.find(
        (line) =>
          line.y >= bounds[3] &&
          line.y - bounds[3] <= 24 &&
          Math.abs(line.x - caption.rect[0]) <= 2 &&
          line.text.length >= 60 &&
          !captionKind(line.text)
      )
      if (first) {
        const legend = [first]
        for (const next of runs.filter((line) => line.y > first.y).sort((a, b) => a.y - b.y)) {
          const previous = legend.at(-1)
          if (
            next.y - previous.bottom > first.fontSize ||
            Math.abs(next.x - first.x) > 2 ||
            Math.abs(next.fontSize - first.fontSize) > 0.7 ||
            captionKind(next.text)
          )
            break
          legend.push(next)
        }
        if (legend.length >= 2 && legend.every((line) => line.text.length >= 40)) {
          rect[3] = Math.min(rect[3], first.y - 2)
          return {
            caption: {
              ...caption,
              lines: [...caption.lines, ...legend.map((line) => line.text)],
              rect: [
                first.x,
                first.y,
                Math.max(...legend.map((line) => line.right)),
                legend.at(-1).bottom
              ]
            },
            rect,
            graphicsCount: graphics.length
          }
        }
      }
    }
    const completedPanels = nativeCompletedAxisPanels(
      page,
      caption,
      pageCaptions,
      tableRects,
      rules,
      nativeTokens,
      rect
    )
    if (completedPanels) rect.splice(0, 4, ...completedPanels.rect)
    const categories = nativeClosedCategoryLabels(
      page,
      caption,
      pageCaptions,
      tableRects,
      rect,
      rules,
      nativeTokens
    )
    const completeAxis = nativeCompleteAxisFigure(
      page,
      caption,
      pageCaptions,
      tableRects,
      rules,
      nativeTokens,
      categories.length ? union([rect, ...categories]) : rect
    )
    if (completeAxis) return completeAxis
    const connectedLegend = nativeConnectedKeyedLegend(
      page,
      caption,
      pageCaptions,
      tableRects,
      nativeTokens,
      categories.length ? union([rect, ...categories]) : rect
    )
    if (connectedLegend) return connectedLegend
    const excludedProseLines = [...excludedProse].filter(
      (line) =>
        line.y + line.height <= rect[1] && rect[1] - line.y - line.height <= line.fontSize * 2
    )
    return {
      caption,
      rect: categories.length ? union([rect, ...categories]) : rect,
      graphicsCount: graphics.length,
      ...(excludedProseLines.length ? { excludedProseLines } : {})
    }
  })
}

// Conservative adjacent-page fallback for one large recorded graphic.
// A labelled table can contain a vector forest plot rather than a cell grid.
// Preserve that graphic as an image-only table when cell detection has no result.
export function associateGraphicalTables(page, candidates, tableRects = [], emptyDetections = []) {
  const tables = candidates.filter(
    (c) => c.page === page.pageNumber && captionKind(c.lines[0]) === 'table'
  )
  const matches = tables.flatMap((caption) => {
    const proxy = { ...caption, lines: ['Figure 1. Graphical table'] }
    const proxies = candidates.map((c) => (c === caption ? proxy : c))
    let match = associateFigures(page, proxies, tableRects).find((m) => m.caption === proxy)
    // Outlined glyph tables have no native text. A model region below the
    // caption disambiguates the graphic from publisher decoration above it.
    const below = emptyDetections.filter(
      (r) =>
        r[1] >= caption.rect[3] &&
        r[1] - caption.rect[3] < 40 &&
        r[0] >= caption.rect[0] - 10 &&
        area(r) > page.width * page.height * 0.04
    )
    if (match?.reason === 'ambiguous-graphic-direction' && below.length === 1) {
      const r = below[0]
      const limit = Math.min(
        page.height * 0.95,
        ...page.lines
          .filter((l) => l.text.length > 20 && l.y >= r[3] && l.x < r[2] && l.x + l.width > r[0])
          .map((l) => l.y)
      )
      match = associateFigures(
        {
          ...page,
          graphicsBounds: page.graphicsBounds.filter(
            (g) =>
              g.normalizedRect[1] * page.height >= caption.rect[3] &&
              g.normalizedRect[3] * page.height <= limit
          )
        },
        proxies,
        tableRects
      ).find((m) => m.caption === proxy)
    }
    if (
      !match?.rect ||
      area(match.rect) < page.width * page.height * 0.04 ||
      tableRects.some(
        (r) => intersection(r, match.rect) / Math.min(area(r), area(match.rect)) > 0.8
      )
    )
      return []
    // A nearby recognized grid can own this caption only in its column and
    // on the matched graphic's side of the caption. The next table below a
    // bottom caption must not suppress the independently bounded graphic above.
    if (
      tableRects.some(
        (r) =>
          Math.min(r[2], caption.rect[2]) > Math.max(r[0], caption.rect[0]) &&
          Math.min(Math.abs(r[1] - caption.rect[3]), Math.abs(caption.rect[1] - r[3])) < 60 &&
          (match.rect[3] <= caption.rect[1]
            ? r[1] < caption.rect[3]
            : match.rect[1] >= caption.rect[3]
              ? r[3] > caption.rect[1]
              : true)
      )
    )
      return []
    // A figure caption between the graphic and a long table-reference
    // paragraph proves that the graphic belongs to the figure, even when the
    // paragraph is classified as a table caption by a noisy PDF stream.
    // Without this guard the graphical-table fallback reserves the graphic
    // first and the normal figure association can no longer crop it.
    const hasInterveningFigureCaption = candidates.some((candidate) => {
      if (candidate === caption || captionKind(candidate.lines?.[0]) !== 'figure') return false
      const overlap =
        Math.min(candidate.rect[2], caption.rect[2]) - Math.max(candidate.rect[0], caption.rect[0])
      return (
        overlap >
          Math.min(candidate.rect[2] - candidate.rect[0], caption.rect[2] - caption.rect[0]) *
            0.35 &&
        candidate.rect[1] >= match.rect[3] - 12 &&
        candidate.rect[3] <= caption.rect[1] + 12
      )
    })
    const hasLineFigureCaption = page.lines.some(
      (line) =>
        /^(?:Fig\.?|Figure)\s+[AS]?\d+[.:]/i.test(line.text.trim()) &&
        line.y >= match.rect[3] - 12 &&
        line.y + line.height <= caption.rect[1] + 12 &&
        line.x + line.width > match.rect[0] &&
        line.x < match.rect[2]
    )
    if (hasInterveningFigureCaption || hasLineFigureCaption) return []
    // Axis plots can be mistaken for image-only tables when a table-reference
    // paragraph follows the plot. Require several numeric tick labels, an
    // axis/legend cue, and a dense vector plate. Outlined table controls have
    // detector evidence directly below the caption and therefore bypass this
    // veto.
    if (!below.length) {
      const numericTicks = page.lines.filter(
        (line) =>
          intersection(lineRect(line), match.rect) / area(lineRect(line)) > 0.5 &&
          (/^(?:[-+]?\d+(?:\.\d+)?\s+){2,}[-+]?\d+(?:\.\d+)?$/.test(line.text.trim()) ||
            /^[-+]?\d+(?:\.\d+)?$/.test(line.text.trim()))
      ).length
      const axisCues = page.lines.filter(
        (line) =>
          intersection(lineRect(line), match.rect) / area(lineRect(line)) > 0.25 &&
          /\b(?:axis|angle|guidance|steps|legend|curve|plot|density|distribution|sampling|gFID|FDr|SNR)\b/i.test(
            line.text
          )
      ).length
      const vectorPlate = (page.graphicsBounds ?? []).filter(
        (graphic) =>
          graphic.kind === 'path' &&
          (() => {
            const rect = figureGraphicRect(page, graphic)
            return rect && intersection(rect, match.rect) / area(rect) > 0.25
          })()
      ).length
      if (numericTicks >= 4 && axisCues >= 1 && vectorPlate >= 8) return []
    }
    return [{ ...match, caption: recoverSpacedCaptionContinuations(page, caption, match.rect) }]
  })
  // Two caption directions can independently find the same image. Resolve
  // only exact duplicate regions through the existing table-owner proof;
  // retain one uncaptioned image when that proof is ambiguous.
  const groups = new Map()
  for (const match of matches) {
    const key = JSON.stringify(match.rect)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(match)
  }
  return [...groups.values()].map((group) => {
    if (group.length === 1) return group[0]
    const owner = associateTableCaptions(page, [{ rect: group[0].rect }], candidates)[0]?.caption
    if (owner) {
      const selected = group.find(
        (match) =>
          match.caption.page === owner.page &&
          JSON.stringify(match.caption.rect) === JSON.stringify(owner.rect)
      )
      if (selected) return { ...selected, caption: owner }
    }
    const image = { ...group[0] }
    delete image.caption
    return image
  })
}

// A raster can contain its own title and notes, leaving no native caption or
// cell text. Require strong detection and structure evidence within one image;
// preserve the whole image, but never claim that its cells have been decoded.
// Model coordinates use the extraction viewport (scale 1.5).
export function associateRasterTables(page, detections, occupiedRects = [], context = {}) {
  const images = (page.graphicsBounds ?? [])
    .filter((g) => g.kind === 'image')
    .map((g) => g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)))
  const results = []
  const precedingCaption = (rect) => {
    const { pages = [], captions = [] } = context
    if (
      page.rotation ||
      page.renderRotation ||
      page.invalidGraphicsBounds ||
      page.lines.some((line) => line.text.trim()) ||
      page.graphicsBounds?.length !== 1 ||
      images.length !== 1 ||
      rect[1] > page.height * 0.2 ||
      captions.some((caption) => caption.page === page.pageNumber) ||
      detections.length !== 1
    )
      return
    const previous = pages.find((p) => p.pageNumber === page.pageNumber - 1)
    if (
      !previous ||
      previous.rotation ||
      previous.renderRotation ||
      previous.invalidGraphicsBounds ||
      previous.width !== page.width ||
      previous.height !== page.height
    )
      return
    const number = (caption) => /^Table\s+(\d+)[.:]\s+\p{Lu}/u.exec(caption.lines.join(' '))?.[1]
    const prior = captions.filter(
      (caption) => caption.page === previous.pageNumber && number(caption)
    )
    const terminal = prior.filter(
      (caption) =>
        /[.!?]$/u.test(caption.lines.at(-1)?.trim() ?? '') &&
        previous.lines.every(
          (line) => !line.text.trim() || line.y + line.height <= caption.rect[3] + 1e-6
        ) &&
        previous.graphicsBounds.every(
          (graphic) =>
            graphic.normalizedRect?.length === 4 &&
            graphic.normalizedRect.every(Number.isFinite) &&
            graphic.normalizedRect[3] * previous.height < caption.rect[1]
        )
    )
    if (terminal.length !== 1) return
    const caption = terminal[0],
      inside = previous.lines.filter(
        (line) => line.text.trim() && intersection(lineRect(line), caption.rect) > 0
      ),
      compact = (text) => text.normalize('NFKC').replace(/\s+/gu, '')
    if (
      !inside.length ||
      inside.some(
        (line) => intersection(lineRect(line), caption.rect) < area(lineRect(line)) - 1e-6
      ) ||
      compact(inside.map((line) => line.text).join(' ')) !== compact(caption.lines.join(' '))
    )
      return
    const owned = associateGraphicalTables(previous, captions)
    const peers = owned.filter(
      (match) =>
        match.caption &&
        number(match.caption) &&
        Number(number(match.caption)) + 1 === Number(number(caption)) &&
        match.caption.rect[3] <= match.rect[1] &&
        match.rect[3] < caption.rect[1] &&
        previous.graphicsBounds.filter((graphic) => {
          if (graphic.kind !== 'image') return false
          const r = (graphic.paintedNormalizedRect ?? graphic.normalizedRect).map(
            (v, i) => v * (i % 2 ? previous.height : previous.width)
          )
          return (
            intersection(r, match.rect) / area(r) > 0.98 &&
            intersection(r, match.rect) / area(match.rect) > 0.98
          )
        }).length === 1
    )
    if (
      peers.length !== 1 ||
      owned.some((match) => match.caption && number(match.caption) === number(caption))
    )
      return
    return caption
  }
  for (const table of detections) {
    if (table.readingRotation || table.detection?.score < 0.99 || !table.detection) continue
    const objects = table.structure?.objects ?? []
    const rows = objects.filter((o) => o.label === 'table row' && o.score >= 0.9)
    const columns = objects.filter((o) => o.label === 'table column' && o.score >= 0.9)
    if (!objects.some((o) => o.label === 'table' && o.score >= 0.99)) continue
    const region = table.cropRect.map((v) => v / 1.5)
    const matches = images.filter(
      (image) =>
        intersection(region, image) / area(region) > 0.98 &&
        intersection(region, image) / area(image) > 0.4 &&
        (region[2] - region[0]) / (image[2] - image[0]) > 0.85 &&
        // A full-page scan can contain prose and several unrelated graphics.
        image[2] - image[0] < page.width * 0.9 &&
        area(image) < page.width * page.height * 0.82
    )
    if (matches.length !== 1) continue
    const rect = matches[0]
    if (
      [...occupiedRects, ...results.map((r) => r.rect)].some(
        (r) => intersection(r, rect) / Math.min(area(r), area(rect)) > 0.2
      ) ||
      page.lines.some(
        (line) =>
          line.text.trim() && intersection(lineRect(line), rect) / area(lineRect(line)) > 0.5
      )
    )
      continue
    const caption = rows.length >= 2 && columns.length >= 2 ? precedingCaption(rect) : undefined
    if ((rows.length < 4 || !columns.length) && !caption) continue
    results.push({ rect, graphicsCount: 1, ...(caption ? { caption } : {}) })
  }
  return results
}

// Conservative adjacent-page fallback for one large recorded graphic.
function associateSplitNativePanel(page, pages, candidates, rules, closedFrames) {
  const marks = page.lines.filter((l) => l.text.trim() === '(a)'),
    letterFrames = closedFrames.filter(
      (r) =>
        marks.length === 1 && intersection(r, lineRect(marks[0])) / area(lineRect(marks[0])) > 0.95
    )
  if (marks.length !== 1 || letterFrames.length !== 1) return
  const mark = marks[0],
    // Independently stroked plot edges can finish a quarter point apart at
    // their caps. This tolerance applies only with the boxed panel-pair proof.
    frames = nativeClosedRuleFrames(rules, 0.25).filter(
      (r) =>
        r[0] > mark.x + mark.width &&
        r[0] - mark.x - mark.width < mark.fontSize * 6 &&
        Math.abs(r[1] - mark.y) < mark.fontSize * 2 &&
        r[2] - r[0] > mark.fontSize * 10 &&
        r[3] - r[1] > mark.fontSize * 10
    )
  if (frames.length !== 1) return
  const plot = frames[0],
    drawn = page.graphicsBounds
      .filter((g) => g.kind === 'path')
      .map((g) => g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))),
    enclosing = drawn
      .filter(
        (r) =>
          intersection(r, plot) / area(plot) > 0.95 &&
          area(r) < area(plot) * 2 &&
          r[0] >= plot[0] - mark.fontSize * 4 &&
          r[1] >= plot[1] - mark.fontSize * 3 &&
          r[3] <= plot[3] + mark.fontSize * 3
      )
      .sort((a, b) => area(b) - area(a))
  if (
    !enclosing.length ||
    enclosing.some((r) => intersection(r, enclosing[0]) / area(r) < 0.95) ||
    drawn.filter((r) => area(r) > 1 && intersection(r, plot) / area(r) > 0.95).length < 20
  )
    return
  const previous = pages.find((p) => p.pageNumber === page.pageNumber - 1)
  if (previous) {
    const prior = associateFigures(previous, candidates)
    if (
      prior.some(
        (f) =>
          f.caption.lines.some((l) => /\(a\)/.test(l)) &&
          (!f.rect ||
            !['(a)', '(b)'].every((text) =>
              previous.lines.some(
                (l) =>
                  l.text.trim() === text &&
                  intersection(lineRect(l), f.rect) / area(lineRect(l)) > 0.95
              )
            ))
      )
    )
      return
  }
  const next = pages.find((p) => p.pageNumber === page.pageNumber + 1)
  if (!next) return
  const matches = associateFigures(next, candidates).filter(
    (f) =>
      f.rect &&
      /\(a\)/.test(f.caption.lines.join(' ')) &&
      /\(b\)/.test(f.caption.lines.join(' ')) &&
      next.lines.filter(
        (l) =>
          l.text.trim() === '(b)' && intersection(lineRect(l), f.rect) / area(lineRect(l)) > 0.95
      ).length === 1 &&
      !next.lines.some((l) => l.text.trim() === '(a)' && intersection(lineRect(l), f.rect) > 0)
  )
  if (matches.length !== 1) return
  const bounds = union([enclosing[0], letterFrames[0]]),
    labels = page.lines.filter(
      (l) =>
        l.x >= bounds[0] - 12 &&
        l.x + l.width <= bounds[2] + 12 &&
        l.y >= bounds[1] - 12 &&
        l.y + l.height <= bounds[3] + 12 &&
        !continuesExternalParagraph(l, bounds, page.lines)
    ),
    rect = union([bounds, ...labels.map(lineRect)])
  if (candidates.some((c) => c.page === page.pageNumber && intersection(c.rect, rect) > 0)) return
  return {
    caption: matches[0].caption,
    rect,
    graphicsCount: drawn.filter((r) => intersection(r, rect) / area(r) > 0.95).length
  }
}

// A page can end with an unowned raster plate while its numbered caption is
// carried to the following page. Preserve the existing source/caption page
// distinction only with one sequential, unresolved page-top title and an
// isolated bottom plate; earlier owned graphics never join the new crop.
export function associatePreviousPageRasterFigure(
  page,
  pages,
  candidates,
  tableRects = [],
  ownedFigures
) {
  if (page.rotation !== 0) return []
  const next = pages.find((p) => p.pageNumber === page.pageNumber + 1 && p.rotation === 0)
  if (!next) return []
  const label = (c) => /^(?:figure|fig\.?)[ \t]+([A-Z]?)(\d+)(?:[.:]|\s)/i.exec(c?.lines?.[0] ?? '')
  const owned = ownedFigures ?? associateFigures(page, candidates, tableRects)
  let preceding = owned
    .filter((f) => f.rect && f.caption?.page === page.pageNumber && label(f.caption))
    .sort((a, b) => b.caption.rect[3] - a.caption.rect[3])[0]
  // A terminal plate can be the only figure on a prose page. Its sequence
  // witness then belongs to the immediately preceding page, not this one.
  // Keep all existing next-page title, isolated-raster and no-prose guards.
  if (!preceding && !owned.length && !candidates.some((c) => c.page === page.pageNumber)) {
    const previous = pages.find((p) => p.pageNumber === page.pageNumber - 1 && p.rotation === 0)
    const previousOwners = previous
      ? associateFigures(previous, candidates).filter(
          (f) => f.rect && f.caption?.page === previous.pageNumber && label(f.caption)
        )
      : []
    if (previousOwners.length === 1) preceding = previousOwners[0]
  }
  if (!preceding) return []
  const previousLabel = label(preceding.caption)
  const eligible = associateFigures(next, candidates).filter((f) => {
    const current = label(f.caption)
    return (
      !f.rect &&
      f.reason === 'no-unambiguous-adjacent-graphics' &&
      f.caption.rect[1] < next.height * 0.12 &&
      current &&
      current[1].toUpperCase() === previousLabel[1].toUpperCase() &&
      Number(current[2]) === Number(previousLabel[2]) + 1
    )
  })
  if (eligible.length !== 1) return []
  const caption = eligible[0].caption
  const font = Math.max(
    ...next.lines
      .filter((l) => intersection(lineRect(l), caption.rect) > 0)
      .map((l) => l.fontSize)
      .filter((v) => v > 0)
  )
  if (!Number.isFinite(font) || !(font > 0)) return []
  const footer = (line, p) =>
    /^[A-Z]?\d+$/i.test(line.text.trim()) &&
    line.y >= p.height * 0.9 &&
    Math.abs(line.x + line.width / 2 - p.width / 2) <= font * 3
  if (
    next.lines.some(
      (l) =>
        l.text.trim() &&
        l.y + l.height < caption.rect[1] &&
        l.y > next.height * 0.035 &&
        !footer(l, next)
    )
  )
    return []
  const images = (page.graphicsBounds ?? [])
    .filter((g) => g.kind === 'image' && g.imageHash)
    .map((g) => {
      const r = g.paintedNormalizedRect ?? g.normalizedRect
      if (
        r?.length !== 4 ||
        !r.every(Number.isFinite) ||
        r[0] < 0 ||
        r[1] < 0 ||
        r[2] > 1 ||
        r[3] > 1 ||
        r[2] <= r[0] ||
        r[3] <= r[1]
      )
        return
      return { hash: g.imageHash, rect: r.map((v, i) => v * (i % 2 ? page.height : page.width)) }
    })
    .filter(
      (g) =>
        g &&
        g.rect[1] >= page.height * 0.5 &&
        g.rect[3] <= page.height * 0.92 &&
        g.rect[2] - g.rect[0] >= font * 8 &&
        g.rect[3] - g.rect[1] >= font * 6 &&
        !owned.some((f) => f.rect && intersection(f.rect, g.rect) / area(g.rect) > 0.1)
    )
  if (![1, 3].includes(images.length) || new Set(images.map((g) => g.hash)).size !== images.length)
    return []
  const rect = union(images.map((g) => g.rect))
  if (
    rect[3] < page.height * 0.72 ||
    area(rect) < page.width * page.height * 0.03 ||
    (Math.abs((rect[0] + rect[2]) / page.width - (caption.rect[0] + caption.rect[2]) / next.width) *
      page.width) /
      2 >
      font * 2
  )
    return []
  if (images.length === 3) {
    const ordered = images.map((g) => g.rect).sort((a, b) => a[0] - b[0])
    if (
      ordered.some((r) => Math.abs(r[3] - rect[3]) > font * 2) ||
      ordered
        .slice(1)
        .some((r, i) => r[0] - ordered[i][2] < -page.width / 128 || r[0] - ordered[i][2] > font * 3)
    )
      return []
  }
  const terminal = [rect[0], rect[1], rect[2], page.height * 0.92]
  if (
    tableRects.some((r) => intersection(r, terminal) > 0) ||
    owned.some((f) => f.rect && intersection(f.rect, rect) > 0) ||
    candidates.some((c) => c.page === page.pageNumber && intersection(c.rect, terminal) > 0) ||
    page.lines.some(
      (l) =>
        l.text.trim() &&
        !footer(l, page) &&
        intersection(lineRect(l), terminal) > 0 &&
        !images.some((g) => intersection(lineRect(l), g.rect) / area(lineRect(l)) > 0.9)
    )
  )
    return []
  const excludedProseLines = page.lines.filter(
    (line) =>
      line.text.trim().length >= 20 &&
      line.y + line.height <= rect[1] &&
      rect[1] - line.y - line.height <= font * 2 &&
      line.x < rect[2] &&
      line.x + line.width > rect[0]
  )
  return [
    {
      caption,
      rect,
      graphicsCount: images.length,
      reason: 'native-raster-following-page-caption',
      ...(excludedProseLines.length ? { excludedProseLines } : {})
    }
  ]
}

export function associateAdjacentFigure(
  page,
  pages,
  candidates,
  rules = [],
  closedFrames = [],
  nativeTokens = []
) {
  // Only a caption-free, figure-dominated page can consume a neighboring caption.
  // Smaller or multiple unlabelled figures need a layout model; do not guess their ownership.
  if (page.rotation !== 0 || candidates.some((c) => c.page === page.pageNumber)) return []
  const split = associateSplitNativePanel(page, pages, candidates, rules, closedFrames)
  if (split) return [split]
  const graphics = (page.graphicsBounds ?? [])
    .map((g) => g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)))
    .filter((r) => r[1] >= page.height * 0.055 && r[3] <= page.height * 0.95 && area(r) >= 12 * 12)
  if (!graphics.length) return []
  const bounds = union(graphics)
  if (
    !graphics.some((rect) => area(rect) >= page.width * page.height * 0.4) &&
    (area(bounds) < page.width * page.height * 0.4 ||
      (!(page.graphicsBounds ?? []).some((g) => g.kind === 'image') && graphics.length < 20) ||
      graphics.reduce((sum, rect) => sum + area(rect), 0) < page.width * page.height * 0.1)
  )
    return []
  if (
    page.lines.some(
      (line) =>
        line.text.length > 80 &&
        line.y > page.height * 0.055 &&
        line.y < page.height * 0.95 &&
        intersection(lineRect(line), bounds) / area(lineRect(line)) < 0.8
    )
  )
    return []
  let eligible = pages
    .filter((p) => p.rotation === 0 && Math.abs(p.pageNumber - page.pageNumber) === 1)
    .flatMap((neighbor) =>
      [
        ...associateFigures(neighbor, candidates),
        ...candidates
          .filter(
            (c) =>
              c.page === neighbor.pageNumber &&
              neighbor.pageNumber < page.pageNumber &&
              /\(facing page\)/i.test(c.lines.join(' '))
          )
          .map((caption) => ({ caption, reason: 'no-unambiguous-adjacent-graphics' }))
      ]
        .filter((match) => !match.rect && match.reason === 'no-unambiguous-adjacent-graphics')
        .map((match) => match.caption)
        .filter((caption) =>
          neighbor.pageNumber < page.pageNumber
            ? caption.rect[1] >= neighbor.height * 0.7 ||
              neighbor.lines.some(
                (line) =>
                  /^(?:FIGURE )?LEGENDS$/i.test(line.text.trim()) && line.y < caption.rect[1]
              )
            : caption.rect[1] <= neighbor.height * 0.15 || caption.rect[1] >= neighbor.height * 0.7
        )
    )
  // Manuscript legend pages can list supplemental figures whose plates are
  // supplied separately. A single main legend precedes that supplemental list.
  const main = eligible.filter((c) => /^(?:FIGURE|Fig\.?)\s+\d+[:.]/i.test(c.lines[0]))
  if (
    main.length === 1 &&
    eligible.length > 1 &&
    eligible.every(
      (c) =>
        c === main[0] ||
        (/^Supplement(?:ary|al)\s+/i.test(c.lines[0]) &&
          c.page === main[0].page &&
          c.rect[1] > main[0].rect[3])
    )
  )
    eligible = main
  if (eligible.length !== 1) return []
  const marginNumber = nativeFigureMarginPageNumber(page, nativeTokens, candidates, [])
  const nearby = page.lines.filter(
    (line) =>
      line !== marginNumber?.line &&
      line.y >= bounds[1] - 24 &&
      line.y + line.height <= bounds[3] + 24 &&
      line.x >= bounds[0] - (/^[a-z]$/i.test(line.text.trim()) ? 24 : 12) &&
      line.x + line.width <= bounds[2] + (/^[a-z]$/i.test(line.text.trim()) ? 24 : 12) &&
      !continuesExternalParagraph(line, bounds, page.lines)
  )
  return [
    {
      caption: eligible[0],
      rect: boundByExternalParagraphs(union([bounds, ...nearby.map(lineRect)]), bounds, page.lines),
      graphicsCount: graphics.length
    }
  ]
}

// Unnumbered statistical plots in supplementary reports still contain recorded
// graphics. Require a dense drawing and no prose crossing its bounds; console
// output and publisher metadata alone cannot pass this test.
export function associateUnnumberedFigure(page, candidates, tableRects = []) {
  if (candidates.some((c) => c.page === page.pageNumber)) return []
  const graphics = (page.graphicsBounds ?? [])
    .filter((g) => g.kind === 'path')
    .map((g) => g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)))
    .filter(
      (r) =>
        r[1] > page.height * 0.06 &&
        r[3] < page.height * 0.95 &&
        r[2] - r[0] > 2 &&
        r[3] - r[1] > 2 &&
        !tableRects.some((t) => intersection(t, r) / area(r) > 0.5)
    )
  if (graphics.length < 20) return []
  const bounds = union(graphics)
  if (area(bounds) < page.width * page.height * 0.03) return []
  // Prompt/code pages often draw every fenced block as many path segments.
  // Their density looks like an unnumbered vector plot, but there is no
  // figure ownership to recover. Require a strong code-text witness before
  // admitting a path-only unnumbered figure; ordinary plots usually contain
  // labels, ticks, or prose instead of repeated code syntax.
  const codeLines = (page.lines ?? []).filter((line) => {
    const text = line.text.trim()
    return (
      (/[()[\]{}]/u.test(text) && /[()[\]{}].*[()[\]{}]/u.test(text)) ||
      /^(?:please\s+solve|your\s+plan\s+as\s+plain\s+text|(?:define|domain|objects|init|goal)\b)/iu.test(
        text
      )
    )
  })
  if (
    !(page.graphicsBounds ?? []).some((graphic) => graphic.kind === 'image') &&
    codeLines.length >= 12 &&
    codeLines.length >= (page.lines?.length ?? 0) * 0.6
  )
    return []
  const longLines = page.lines.filter(
    (l) => l.text.length > 80 && intersection(lineRect(l), bounds) > 0
  )
  if (longLines.length > 1) return []
  const labels = page.lines.filter(
    (l) =>
      l.y >= bounds[1] - 150 &&
      l.y + l.height <= bounds[3] + 50 &&
      l.x >= bounds[0] - 150 &&
      l.x + l.width <= page.width * 0.95 &&
      l.text.length < 80 &&
      !/^##/.test(l.text.trim()) &&
      !/^\d+$/.test(l.text.trim()) &&
      !continuesExternalParagraph(l, bounds, page.lines)
  )
  return [
    {
      rect: boundByExternalParagraphs(union([bounds, ...labels.map(lineRect)]), bounds, page.lines),
      graphicsCount: graphics.length
    }
  ]
}

// A single isolated embedded plate on a native-text page is useful without an
// invented number. Its image operation supplies the complete bounds; outlined
// watermarks outside it do not expand ownership.
export function associateUncaptionedRasterFigure(page, candidates, tableRects = []) {
  if (candidates.some((c) => c.page === page.pageNumber) || tableRects.length) return []
  const images = (page.graphicsBounds ?? []).filter(
    (g) => g.kind === 'image' && g.imageHash && area(g.normalizedRect) > 0.12
  )
  if (images.length !== 1) return []
  const r = images[0].normalizedRect
  if (r[0] < 0.04 || r[2] > 0.96 || r[1] < 0.06 || r[3] > 0.9 || area(r) > 0.65) return []
  const rect = r.map((v, n) => v * (n % 2 ? page.height : page.width))
  if (
    page.lines.some(
      (l) =>
        l.text.trim().length > 30 && l.y > page.height * 0.08 && l.y + l.height < page.height * 0.9
    )
  )
    return []
  return [{ rect, graphicsCount: 1 }]
}

export { findAlgorithmCandidates } from './literature-pdf-numbered-native-procedure.mjs'

// An unfinished caption can wrap definitions or a paired-panel explanation
// across widely spaced lines. Matching native leading and typography plus
// closed definitions or the table's own panel labels prove the paragraph.
function recoverSpacedCaptionContinuations(page, caption, tableRect) {
  if (
    !Number.isFinite(page.width) ||
    caption.lines.length !== 1 ||
    caption.lines[0].length < 80 ||
    /[.!?:;]$/.test(caption.lines[0])
  )
    return caption
  const runs = groupPageLines(page)
  const starts = runs.filter(
    (l) =>
      l.text === caption.lines[0] &&
      Math.abs(l.x - caption.rect[0]) < 0.01 &&
      Math.abs(l.y - caption.rect[1]) < 0.01
  )
  if (starts.length !== 1) return caption
  const start = starts[0],
    h = start.fontSize
  const follow = runs
    .filter(
      (l) =>
        l.y >= start.bottom && l.y < start.bottom + h * 5 && l.right > start.x && l.x < start.right
    )
    .sort((a, b) => a.y - b.y)
  if (follow.length !== 2) return caption
  const [definition, tail] = follow,
    leading = definition.y - start.y
  const definitions =
    /^[a-z]/.test(definition.text) &&
    /=$/.test(definition.text) &&
    (definition.text.match(/\b[A-Za-z][A-Za-z0-9]{1,10}\s*=\s*[a-z]/g) ?? []).length >= 2 &&
    /^[a-z].*\.$/.test(tail.text)
  const firstPanels = [...start.text.matchAll(/\(([A-Z])\.\)/g)].map((m) => m[1])
  const nextPanels = [...definition.text.matchAll(/\(([A-Z])\.\)/g)].map((m) => m[1])
  const native = tableRect
    ? runs.filter(
        (l) =>
          l.x >= tableRect[0] &&
          l.right <= tableRect[2] &&
          l.y >= tableRect[1] &&
          l.bottom <= tableRect[3]
      )
    : []
  const marked = native
    .map((l) => [...l.text.matchAll(/\b([A-Z])\.\s+(?=[A-Z])/g)].map((m) => m[1]))
    .filter((p) => p.length)
  const panels =
    firstPanels.length === 1 &&
    nextPanels.length === 1 &&
    nextPanels[0].charCodeAt(0) === firstPanels[0].charCodeAt(0) + 1 &&
    marked.length === 1 &&
    JSON.stringify(marked[0]) === JSON.stringify([...firstPanels, ...nextPanels]) &&
    /^[a-z].*[a-z]$/.test(definition.text) &&
    /^[A-Z]{2,}\b.+\.$/.test(tail.text)
  if (
    start.right - start.x < page.width * 0.65 ||
    leading < h * 2 ||
    leading > h * 2.6 ||
    Math.abs(tail.y - definition.y - leading) > h * 0.1 ||
    !(definitions || panels) ||
    definition.right - start.x < (start.right - start.x) * 0.8 ||
    [definition, tail].some(
      (l) =>
        Math.abs(l.x - start.x) > h * 0.1 ||
        Math.abs(l.fontSize - h) > h * 0.03 ||
        l.right > start.right + h * 0.1
    )
  )
    return caption
  return {
    ...caption,
    lines: [start.text, definition.text, tail.text],
    rect: [start.x, start.y, Math.max(start.right, definition.right, tail.right), tail.bottom]
  }
}

// A separate caption sheet can follow a single large framed table. Keep its
// actual source page and complete paragraph; neighboring prose or graphics
// must never be claimed simply because the table lacks a same-page caption.
function associateCaptionSheet(page, tables, candidates, rules, pages) {
  if (tables.length !== 1 || candidates.some((c) => c.page === page.pageNumber)) return
  const next = pages.filter((p) => p.pageNumber === page.pageNumber + 1)
  if (next.length !== 1) return
  const sheet = next[0],
    captions = candidates.filter((c) => c.page === sheet.pageNumber)
  if (
    captions.length !== 1 ||
    captionKind(captions[0].lines[0]) !== 'table' ||
    sheet.graphicsBounds.length ||
    sheet.invalidGraphicsBounds > 0
  )
    return
  const caption = captions[0],
    lines = groupPageLines(sheet)
  const body = lines.filter((l) => l.y >= sheet.height * 0.08 && l.bottom <= sheet.height * 0.85)
  const first = body[0],
    height = first?.fontSize,
    rect = tables[0].rect
  if (
    !height ||
    body.length < 2 ||
    body.length > 8 ||
    Math.abs(sheet.width - page.width) > height ||
    Math.abs(sheet.height - page.height) > height ||
    sheet.rotation !== page.rotation ||
    sheet.renderRotation !== page.renderRotation ||
    first.text !== caption.lines[0] ||
    caption.lines.some((s, n) => s !== body[n]?.text) ||
    first.y > sheet.height * 0.25 ||
    first.right - first.x < sheet.width * 0.65 ||
    !/[.!?]$/.test(body.at(-1).text) ||
    body.slice(0, -1).some((l) => /[.!?]$/.test(l.text)) ||
    area(rect) < page.width * page.height * 0.4 ||
    Math.abs(first.x - rect[0]) > height ||
    Math.abs(first.right - rect[2]) > (rect[2] - rect[0]) * 0.1
  )
    return
  const leading = body[1].y - first.y
  if (
    leading < height ||
    leading > height * 2.6 ||
    body.some(
      (l, n) =>
        l.text.length < 30 ||
        Math.abs(l.fontSize - height) > height * 0.03 ||
        Math.abs(l.x - first.x) > height * 0.1 ||
        l.right > first.right + height * 0.1 ||
        (n && Math.abs(l.y - body[n - 1].y - leading) > height * 0.1)
    ) ||
    lines
      .filter((l) => !body.includes(l))
      .some(
        (l) =>
          !(
            (l.y < sheet.height * 0.08 &&
              page.lines.some(
                (p) =>
                  p.text === l.text &&
                  Math.abs(p.y - l.y) < height * 0.1 &&
                  Math.abs(p.x - l.x) < height * 0.1
              )) ||
            (l.y > sheet.height * 0.85 &&
              /^\[?\d+\]?$/.test(l.text.trim()) &&
              Math.abs((l.x + l.right) / 2 - sheet.width / 2) < height * 2)
          )
      )
  )
    return
  const edges = joinHorizontalTableRules(rules, height * 0.1)
  const top = edges.find(
    (r) =>
      r[1] >= rect[1] &&
      r[1] - rect[1] < height * 2 &&
      Math.abs(r[0] - rect[0]) < height &&
      Math.abs(r[2] - rect[2]) < height
  )
  if (
    !top ||
    !edges.some(
      (r) =>
        r[1] >= rect[3] &&
        r[1] - rect[3] < height &&
        Math.abs(r[0] - top[0]) < height * 0.1 &&
        Math.abs(r[2] - top[2]) < height * 0.1
    )
  )
    return
  const words = (text) => new Set(text.toLowerCase().match(/\p{L}{4,}/gu) ?? [])
  const labels = words(
    page.lines
      .filter(
        (l) =>
          l.y >= rect[1] &&
          l.y + l.height <= rect[1] + (rect[3] - rect[1]) * 0.25 &&
          l.x >= rect[0] &&
          l.x + l.width <= rect[2]
      )
      .map((l) => l.text)
      .join(' ')
  )
  const description = words(body.map((l) => l.text).join(' '))
  if ([...labels].filter((s) => description.has(s)).length < 3) return
  return {
    ...caption,
    lines: body.map((l) => l.text),
    rect: union(body.map((l) => [l.x, l.y, l.right, l.bottom]))
  }
}

// Local table-caption matching in the same scale-1 displayed viewport. Keep uncertain ownership absent.
// A captionless count/percent table can continue through one complete table-only
// page. Repeated denominators, typography and native record extents prove the
// chain; nearby titles alone never establish cross-page ownership.
function associateCountContinuationCaption(page, tables, candidates, pages, distance = 2) {
  if (tables.length !== 1) return
  const origin = pages.find((p) => p.pageNumber === page.pageNumber - distance)
  const middle =
    distance === 2 ? pages.find((p) => p.pageNumber === page.pageNumber - 1) : undefined
  if (
    !origin ||
    (distance === 2 && !middle) ||
    [origin, middle].filter(Boolean).some((p) => p.width !== page.width || p.height !== page.height)
  )
    return
  const captions = candidates.filter(
    (c) => c.page === origin.pageNumber && captionKind(c.lines[0]) === 'table'
  )
  if (captions.length !== 1 || (middle && candidates.some((c) => c.page === middle.pageNumber)))
    return
  const title = captions[0],
    rect = tables[0].rect
  if (rect[1] > page.height * 0.15 || Math.abs(title.rect[0] - rect[0]) > 12) return
  const content = (p) =>
    groupPageLines(p).filter(
      (l) =>
        !(
          /^\d+$/.test(l.text) &&
          l.y > p.height * 0.85 &&
          l.right - l.x < p.width * 0.04 &&
          Math.abs((l.x + l.right) / 2 - p.width / 2) < p.width * 0.03
        )
    )
  const original = content(origin).filter((l) => l.y >= title.rect[3])
  const headings = original.filter(
    (l) => (l.text.match(/\(n\s*=\s*\d{2,6}\)/gi) ?? []).length === 2
  )
  const totals = headings.flatMap((l) =>
    [...l.text.matchAll(/\(n\s*=\s*(\d{2,6})\)/gi)].map((m) => Number(m[1]))
  )
  if (
    totals.length !== 2 ||
    !original.some((l) => /^No\.\s*%\s+No\.\s*%$/.test(l.text)) ||
    !original.some((l) => /^p[- ]?value$/i.test(l.text))
  )
    return
  const record = (l) =>
    /^(.*?)\s+(\d+)\s+(\d+\.\d{1,2})\s+(\d+)\s+(\d+\.\d{1,2})(?:\s+(0?\.\d{1,4}|1(?:\.0+)?))?$/.exec(
      l.text
    )
  const streams = [
    original,
    ...(middle ? [content(middle)] : []),
    content(page).filter(
      (l) =>
        l.x >= rect[0] - 1 &&
        l.right <= rect[2] + 1 &&
        l.y >= rect[1] - 1 &&
        l.bottom <= rect[3] + 1
    )
  ]
  const rows = streams.map((ls) =>
    ls.map((l) => ({ line: l, match: record(l) })).filter((r) => r.match)
  )
  if (
    rows.some((rs) => rs.length < 3) ||
    rows[0].at(-1).line.bottom < origin.height * 0.8 ||
    (middle &&
      (streams[1][0]?.y > middle.height * 0.15 || streams[1].at(-1)?.bottom < middle.height * 0.8))
  )
    return
  const anchor = rows[0].find((r) => !r.match[6])?.line
  if (!anchor) return
  const height = anchor.fontSize
  if (
    height <= 0 ||
    rows.some(
      (rs) =>
        rs.filter(
          ({ match: m }) =>
            Math.abs((Number(m[2]) / totals[0]) * 100 - Number(m[3])) <= 0.011 &&
            Math.abs((Number(m[4]) / totals[1]) * 100 - Number(m[5])) <= 0.011
        ).length < 3
    ) ||
    rows
      .flat()
      .some(
        ({ line: l, match: m }) =>
          !/\p{L}/u.test(m[1]) ||
          Math.abs(l.fontSize - height) > 0.5 ||
          Math.abs(l.x - anchor.x) > height * 2.2 ||
          (m[6]
            ? Math.abs(l.right - rect[2]) > height
            : Math.abs(l.right - anchor.right) > height * 0.8)
      )
  )
    return
  // The bridge must contain only these records, short section/test labels or
  // their aligned wrapped stub and detached count tail. Ordinary prose breaks it.
  if (
    streams[1].some((l) => {
      if (record(l)) return false
      if (Math.abs(l.fontSize - height) > 0.5 || l.x < rect[0] - 1 || l.right > rect[2] + 1)
        return true
      if (/^\d+\s+\d+\.\d{1,2}\s+\d+\s+\d+\.\d{1,2}$/.test(l.text))
        return l.x < anchor.x + height * 4
      return !(
        /^[\p{L}][\p{L}\p{N} ()/–-]{0,49}(?:\s+0?\.\d{1,4})?$/u.test(l.text) &&
        l.x <= anchor.x + 1 &&
        !/^(?:Discussion|Results|Methods|Conclusion|References)\b/i.test(l.text)
      )
    })
  )
    return
  return title
}

function associatePairedCountContinuation(page, tables, candidates, rules, pages) {
  if (tables.length !== 1 || tables[0].rect[1] > page.height * 0.15) return
  const origin = pages.find((p) => p.pageNumber === page.pageNumber - 1)
  if (!origin || origin.width !== page.width || origin.height !== page.height) return
  const titles = candidates.filter(
    (c) => c.page === origin.pageNumber && captionKind(c.lines[0]) === 'table'
  )
  if (
    titles.length !== 1 ||
    candidates.some((c) => c.page === page.pageNumber && c.rect[3] <= tables[0].rect[1])
  )
    return
  const title = titles[0],
    rect = tables[0].rect
  const record = (l) =>
    /^(.+?)\s+(\d+)\s*\((\d+(?:\.\d+)?)\)\s+(\d+)\s*\((\d+(?:\.\d+)?)\)$/.exec(l.text.trim())
  const prior = groupPageLines(origin)
    .filter((l) => l.y >= title.rect[3])
    .map((l) => ({ line: l, match: record(l) }))
    .filter((r) => r.match)
  const current = groupPageLines(page)
    .filter((l) => l.y >= rect[1] - 1 && l.bottom <= rect[3] + 1)
    .map((l) => ({ line: l, match: record(l) }))
    .filter((r) => r.match)
  if (prior.length < 3 || current.length < 3 || prior.at(-1).line.bottom < origin.height * 0.8)
    return
  const anchor = prior.at(-1).line,
    font = anchor.fontSize
  if (
    origin.lines.some(
      (l) => l.text.length > 80 && l.y >= title.rect[3] && l.y + l.height <= anchor.bottom
    )
  )
    return
  const samples = origin.lines
    .filter(
      (l) =>
        /^n\s*=\s*\d{2,6}$/i.test(l.text.trim()) && l.y > title.rect[3] && l.y < prior[0].line.y
    )
    .map((l) => Number(/\d+/.exec(l.text)[0]))
  if (
    samples.length !== 2 ||
    Math.abs(title.rect[0] - rect[0]) > font * 3 ||
    [...prior, ...current].some(
      ({ line: l }) =>
        Math.abs(l.fontSize - font) > 0.2 ||
        Math.abs(l.x - anchor.x) > font * 1.5 ||
        Math.abs(l.right - anchor.right) > font * 2
    )
  )
    return
  const fits = (rows) =>
    rows.filter(
      ({ match: m }) =>
        Math.abs((Number(m[2]) / samples[0]) * 100 - Number(m[3])) < 0.15 &&
        Math.abs((Number(m[4]) / samples[1]) * 100 - Number(m[5])) < 0.15
    ).length >= 3
  if (!fits(prior) || !fits(current)) return
  const closing = joinHorizontalTableRules(rules, 0.75).filter(
    (r) =>
      r[1] >= rect[3] &&
      r[1] - rect[3] <= font * 2 &&
      r[0] <= Math.min(...current.map(({ line: l }) => l.x)) &&
      r[2] >= Math.max(...current.map(({ line: l }) => l.right)) &&
      (rect[2] - rect[0]) / (r[2] - r[0]) >= 0.8
  )
  if (
    closing.length !== 1 ||
    candidates.some(
      (c) =>
        c.page === page.pageNumber &&
        c.rect[1] >= rect[3] &&
        c.rect[1] - closing[0][1] <= (c.rect[3] - c.rect[1]) * 2
    ) ||
    page.lines.some((l) => l.text.length > 80 && intersection(lineRect(l), rect) > 0)
  )
    return
  return title
}

function associateTerminalStatisticalCaption(page, tables, candidates, rules, pages) {
  if (tables.length !== 1 || candidates.some((c) => c.page === page.pageNumber)) return
  const rect = tables[0].rect
  if (rect[1] > page.height * 0.16) return
  const record = (l) =>
    /^(?:Estimate|Error|Effect Size)\s+(?:[−-]?\d+(?:\.\d+)?[*†‡§]?\s+){2,}[−-]?\d+(?:\.\d+)?[*†‡§]?$/.test(
      l.text.trim()
    )
  const rows = groupPageLines(page).filter(
    (l) => l.y >= rect[1] - 1 && l.bottom <= rect[3] + 1 && record(l)
  )
  if (rows.length < 3) return
  const anchor = rows[0],
    font = anchor.fontSize
  if (rows.some((l) => Math.abs(l.fontSize - font) > 0.2 || Math.abs(l.x - anchor.x) > font * 0.25))
    return
  const horizontal = joinHorizontalTableRules(rules, 0.75).filter(
    (r) =>
      r[2] - r[0] > page.width * 0.55 &&
      r[0] <= anchor.x &&
      r[2] >= Math.max(...rows.map((l) => l.right))
  )
  const openings = horizontal.filter(
    (r) => r[1] <= rect[1] + font * 0.05 && rect[1] - r[1] < font * 4
  )
  const closings = horizontal.filter((r) => r[1] >= rect[3] && r[1] - rect[3] < font * 2)
  if (
    openings.length !== 1 ||
    closings.length !== 1 ||
    Math.abs(openings[0][0] - closings[0][0]) > font * 0.2 ||
    Math.abs(openings[0][2] - closings[0][2]) > font * 0.2
  )
    return
  // A native section stub may have a full-em box just above its opening rule.
  // Its baseline and almost all ink remain below the unique stroke; an extra
  // run, different font, foreign glyph or substantive overlap is not evidence.
  if (openings[0][1] > rect[1]) {
    const crossing = page.lines.filter(
      (l) =>
        l.y < openings[0][1] && l.y + l.height > rect[1] && l.x < rect[2] && l.x + l.width > rect[0]
    )
    const first = crossing[0]
    if (
      crossing.length !== 1 ||
      !/^\p{L}[\p{L} -]{0,49}$/u.test(first.text.trim()) ||
      Math.abs(first.fontSize - font) > 0.2 ||
      Math.abs(first.height - font) > font * 0.1 ||
      first.y < openings[0][1] - font * 0.05 ||
      first.y + first.height <= openings[0][1] + font * 0.5 ||
      first.x < openings[0][0] ||
      first.x > anchor.x ||
      first.x + first.width > openings[0][2]
    )
      return
  }
  const frame = [openings[0][0], openings[0][1], openings[0][2], closings[0][1]]
  const possible = []
  for (const distance of [1, 2]) {
    const origin = pages.find((p) => p.pageNumber === page.pageNumber - distance)
    if (!origin || origin.width !== page.width || origin.height !== page.height) continue
    const body = groupPageLines(origin).filter(
      (l) => l.y > origin.height * 0.05 && l.bottom < origin.height * 0.9
    )
    const titles = candidates.filter(
      (c) =>
        c.page === origin.pageNumber &&
        captionKind(c.lines[0]) === 'table' &&
        /^Table\s+\d+[.:]\s+\S.{15}/i.test(c.lines.join(' ')) &&
        c.rect[3] === body.at(-1)?.bottom &&
        c.lines.at(-1) === body.at(-1)?.text &&
        Math.abs(c.rect[0] - frame[0]) < font
    )
    if (titles.length !== 1) continue
    if (distance === 2) {
      const middle = pages.find((p) => p.pageNumber === page.pageNumber - 1)
      if (
        !middle ||
        middle.width !== page.width ||
        middle.height !== page.height ||
        candidates.some((c) => c.page === middle.pageNumber)
      )
        continue
      const previousRows = groupPageLines(middle).filter(record)
      if (
        previousRows.length < 6 ||
        previousRows.at(-1).bottom < middle.height * 0.8 ||
        previousRows.some(
          (l) => Math.abs(l.fontSize - font) > 0.2 || Math.abs(l.x - anchor.x) > font * 0.25
        )
      )
        continue
      const edges = (middle.graphicsBounds ?? [])
        .filter((g) => g.kind === 'path')
        .map((g) => g.normalizedRect.map((v, n) => v * (n % 2 ? middle.height : middle.width)))
        .filter((r) => r[3] - r[1] < middle.height / 64)
        .map((r) => [r[0], (r[1] + r[3]) / 2, r[2], (r[1] + r[3]) / 2])
      const bars = joinHorizontalTableRules(edges, font * 0.2).filter(
        (r) => Math.abs(r[0] - frame[0]) < font && Math.abs(r[2] - frame[2]) < font
      )
      if (
        !bars.some((r) => r[1] < middle.height * 0.16) ||
        !bars.some((r) => r[1] > middle.height * 0.8) ||
        middle.lines.some(
          (l) => l.text.length > 80 && l.y > middle.height * 0.05 && l.y < middle.height * 0.9
        )
      )
        continue
    }
    possible.push(titles[0])
  }
  return possible.length === 1 ? possible[0] : undefined
}

// Resolve a complete set of native ruled tables before footer proximity can
// steal the next table's above-caption. Each candidate needs its own opening,
// header separator and closing rule, numeric records and a unique caption.
// Matching does not depend on model detection order or one shared column.
function associateCompleteNativeBelowTableCaptions(page, tables, candidates, rules) {
  if (tables.length < 2 || tables.length > 6) return
  const captions = candidates.filter(
    (c) => c.page === page.pageNumber && captionKind(c.lines?.[0] ?? '') === 'table'
  )
  if (captions.length < tables.length || captions.length > tables.length + 2) return
  const nativeRules = joinHorizontalTableRules(rules)
  const nativeLines = groupPageLines(page)
  // Grouped runs locate the records, but cannot prove an intersecting native
  // font belongs wholly to this owner. Check the original full font boxes too.
  const completeNativeFonts = (bounds, excluded) => {
    const fonts = page.lines.filter((l) => intersection(lineRect(l), bounds) > 0)
    return (
      fonts.length > 0 &&
      fonts.every((l) => {
        const r = lineRect(l)
        return (
          [l.x, l.y, l.width, l.height, l.fontSize].every(Number.isFinite) &&
          l.width > 0 &&
          l.fontSize > 0 &&
          // The canonical probe can join a lowered script into this native
          // run, extending its full envelope beyond the largest font em.
          l.height >= l.fontSize - 1e-8 &&
          r[0] >= bounds[0] - 1e-8 &&
          r[1] >= bounds[1] - 1e-8 &&
          r[2] <= bounds[2] + 1e-8 &&
          r[3] <= bounds[3] + 1e-8 &&
          excluded.every((other) => intersection(r, other) === 0)
        )
      })
    )
  }
  const matches = tables.map(({ rect }, index) =>
    captions.filter((caption) => {
      const printed = nativeLines.filter(
        (l) => intersection([l.x, l.y, l.right, l.bottom], caption.rect) > 0
      )
      const em = Math.max(...printed.map((l) => l.fontSize).filter((v) => v > 0))
      if (
        !Number.isFinite(em) ||
        !rect?.every(Number.isFinite) ||
        caption.rect[1] < rect[3] ||
        printed.length !== caption.lines.length ||
        !completeNativeFonts(
          caption.rect,
          candidates
            .filter((other) => other !== caption && other.page === page.pageNumber)
            .map((other) => other.rect)
        ) ||
        caption.lines.some((text) => !printed.some((l) => l.text === text))
      )
        return false
      const tolerance = Math.max(em, (rect[2] - rect[0]) * 0.08)
      const edges = nativeRules.filter(
        (r) =>
          Math.abs(r[0] - rect[0]) <= tolerance &&
          Math.abs(r[2] - rect[2]) <= tolerance &&
          r[1] >= rect[1] - em * 2 &&
          r[1] <= rect[3] + em
      )
      const closing = edges.filter(
        (r) =>
          Math.abs(r[1] - rect[3]) <= em &&
          r[1] <= caption.rect[1] &&
          caption.rect[1] - r[1] <= em * 3 &&
          Math.abs((r[0] + r[2] - caption.rect[0] - caption.rect[2]) / 2) <= em * 2
      )
      if (closing.length !== 1) return false
      const last = closing[0]
      const same = edges.filter(
        (r) => Math.abs(r[0] - last[0]) < 0.05 && Math.abs(r[2] - last[2]) < 0.05
      )
      const first = same[0]
      if (
        same.length < 3 ||
        first === last ||
        Math.abs(first[1] - rect[1]) > em * 2 ||
        !same.some((r) => r[1] > first[1] + em * 0.5 && r[1] <= first[1] + em * 4)
      )
        return false
      const frame = [first[0], first[1], first[2], last[1]]
      const corridor = [
        Math.min(last[0], caption.rect[0]),
        last[1],
        Math.max(last[2], caption.rect[2]),
        caption.rect[1]
      ]
      if (
        tables.some((other, n) => n !== index && intersection(other.rect, frame) > 0) ||
        !completeNativeFonts(
          frame,
          candidates.filter((other) => other.page === page.pageNumber).map((other) => other.rect)
        ) ||
        candidates.some(
          (other) =>
            other !== caption &&
            other.page === page.pageNumber &&
            intersection(other.rect, corridor) > 0
        ) ||
        page.lines.some((l) => intersection(lineRect(l), corridor) > 0)
      )
        return false
      const source = nativeLines.filter(
        (l) => l.y >= first[1] && l.bottom <= last[1] && l.x >= first[0] && l.right <= first[2]
      )
      const header = source.filter((l) => l.bottom <= same[1][1])
      const bands = []
      for (const line of source
        .filter((l) => l.y >= same[1][1])
        .sort((a, b) => a.bottom - b.bottom || a.x - b.x)) {
        const band = bands.find(
          (b) => Math.abs(b[0].bottom - line.bottom) <= Math.max(b[0].fontSize, line.fontSize) * 0.2
        )
        if (band) band.push(line)
        else bands.push([line])
      }
      return (
        header.some((l) => /\p{L}/u.test(l.text)) &&
        bands.filter(
          (b) =>
            b.reduce(
              (count, l) => count + (l.text.match(/[-+−]?\d+(?:\.\d+)?/gu) ?? []).length,
              0
            ) >= 2
        ).length >= 3
      )
    })
  )
  if (
    matches.every((owners) => owners.length === 1) &&
    new Set(matches.map((owners) => owners[0])).size === tables.length
  ) {
    // A missed independently closed plate may own another footer. Reserve it
    // only through the same complete native-font/fence proof; do not discard
    // an unmatched caption merely to force page-wide cardinality.
    const unmatched = captions.filter((c) => !matches.some((owners) => owners[0] === c))
    for (const caption of unmatched) {
      const em = Math.max(
        ...page.lines
          .filter((l) => intersection(lineRect(l), caption.rect) > 0)
          .map((l) => l.fontSize)
          .filter((v) => v > 0)
      )
      if (!Number.isFinite(em)) return
      const closings = nativeRules.filter(
        (r) =>
          r[1] < caption.rect[1] &&
          caption.rect[1] - r[1] < em * 3 &&
          Math.abs((r[0] + r[2] - caption.rect[0] - caption.rect[2]) / 2) < em * 2
      )
      const frames = closings.flatMap((closing) => {
        const family = nativeRules.filter(
          (r) =>
            r[1] <= closing[1] &&
            Math.abs(r[0] - closing[0]) < 0.05 &&
            Math.abs(r[2] - closing[2]) < 0.05
        )
        if (family.length < 3) return []
        const first = family[0],
          frame = [first[0], first[1], first[2], closing[1]]
        const headerFonts = page.lines.filter(
          (l) => intersection(lineRect(l), frame) > 0 && l.y < first[1]
        )
        if (headerFonts.length) {
          if (
            headerFonts.length !== 1 ||
            headerFonts[0].y + headerFonts[0].height >= family[1][1] ||
            first[1] - headerFonts[0].y > headerFonts[0].fontSize * 0.25 ||
            headerFonts[0].x < first[0] ||
            headerFonts[0].x + headerFonts[0].width > first[2]
          )
            return []
          // Preserve the whole native header font envelope. Its baseline is
          // inside the independent header face, even when its em starts above
          // the first painted rule; no foreign font is silently discarded.
          frame[1] = headerFonts[0].y
        }
        const corridor = [
          Math.min(first[0], caption.rect[0]),
          closing[1],
          Math.max(first[2], caption.rect[2]),
          caption.rect[1]
        ]
        if (
          tables.some((t) => intersection(t.rect, frame) > 0) ||
          !completeNativeFonts(
            frame,
            candidates.filter((c) => c.page === page.pageNumber).map((c) => c.rect)
          ) ||
          page.lines.filter((l) => intersection(lineRect(l), frame) > 0).length < 8 ||
          page.lines.some((l) => intersection(lineRect(l), corridor) > 0) ||
          !completeNativeFonts(
            caption.rect,
            captions.filter((c) => c !== caption).map((c) => c.rect)
          )
        )
          return []
        return [frame]
      })
      if (frames.length !== 1) return
    }
    return matches.map(([caption]) => ({ caption }))
  }
}

function associateCompleteNativeTableCaptions(page, tables, candidates, rules) {
  if (tables.length < 2 || tables.length > 6) return
  const captions = candidates.filter(
    (c) => c.page === page.pageNumber && captionKind(c.lines?.[0] ?? '') === 'table'
  )
  const ordered = [...captions].sort((a, b) => a.rect[1] - b.rect[1])
  const ordinals = ordered.map((c) => Number(/^Table\s+(\d+)[.:]/iu.exec(c.lines[0])?.[1]))
  // Short flush-left titles need not share the center of a wide table. Admit
  // that alignment only for a complete consecutive title stack; every table
  // must still pass the independent opening, closing, source and corridor proof.
  const leftStack =
    captions.length === tables.length &&
    ordinals.every(
      (n, i) => Number.isSafeInteger(n) && n > 0 && (!i || n === ordinals[i - 1] + 1)
    ) &&
    ordered.every((c) => Math.abs(c.rect[0] - ordered[0].rect[0]) < 0.1)
  const aligned = (edge, caption, em) =>
    Math.abs((edge[0] + edge[2] - caption.rect[0] - caption.rect[2]) / 2) <= em * 2 ||
    (leftStack && Math.abs(edge[0] - caption.rect[0]) <= em * 0.15)
  const matches = tables.map(({ rect }, index) =>
    captions.filter((caption) => {
      const em = Math.max(
        ...page.lines
          .filter((l) => intersection(lineRect(l), caption.rect) > 0)
          .map((l) => l.fontSize)
          .filter((v) => v > 0)
      )
      if (!Number.isFinite(em) || caption.rect[3] > rect[1] + em * 0.25) return false
      // A complete preceding plate can own this caption below its closing
      // stroke. Do not reserve that footer for the following plate merely
      // because the caption's final line is also close to its opening.
      // Leave below-caption association to the existing orientation checks.
      if (
        tables.some(({ rect: previous }) => {
          const tolerance = Math.max(em, (previous[2] - previous[0]) * 0.08)
          const edges = rules.filter(
            (r) =>
              r.every(Number.isFinite) &&
              r[1] === r[3] &&
              Math.abs(r[0] - previous[0]) <= tolerance &&
              Math.abs(r[2] - previous[2]) <= tolerance
          )
          const closing = edges.filter(
            (r) =>
              Math.abs(r[1] - previous[3]) <= em &&
              r[1] <= caption.rect[1] &&
              caption.rect[1] - r[1] <= em * 3 &&
              aligned(r, caption, em)
          )
          if (closing.length !== 1) return false
          const last = closing[0]
          const opening = edges.filter(
            (r) =>
              Math.abs(r[1] - previous[1]) <= em * 2 &&
              r[1] < last[1] - em * 3 &&
              Math.abs(r[0] - last[0]) < 0.5 &&
              Math.abs(r[2] - last[2]) < 0.5
          )
          if (!opening.length) return false
          const first = opening.reduce((a, b) => (a[1] < b[1] ? a : b))
          // A preceding table with its own independently adjacent above-title
          // must not block the next table's title in a regular caption stack.
          if (
            captions.some(
              (other) =>
                other !== caption &&
                other.rect[3] <= first[1] &&
                first[1] - other.rect[3] <= em * 3 &&
                aligned(first, other, em) &&
                !page.lines.some(
                  (l) =>
                    intersection(lineRect(l), [first[0], other.rect[3], first[2], first[1]]) > 0 &&
                    intersection(lineRect(l), other.rect) === 0
                )
            )
          )
            return false
          if (
            !edges.some(
              (r) => r[1] > first[1] + em * 0.5 && r[1] - first[1] <= em * 4 && r[1] < last[1] - em
            ) ||
            candidates.some(
              (other) =>
                other !== caption &&
                other.page === page.pageNumber &&
                intersection(other.rect, [last[0], last[1], last[2], caption.rect[1]]) > 0
            ) ||
            page.lines.some(
              (l) =>
                intersection(lineRect(l), [last[0], last[1], last[2], caption.rect[1]]) > 0 &&
                intersection(lineRect(l), caption.rect) === 0
            )
          )
            return false
          return (
            groupPageLines(page).filter(
              (l) =>
                l.y >= first[1] - em * 0.1 &&
                l.bottom <= last[1] + em * 0.1 &&
                l.x >= first[0] - em &&
                l.right <= first[2] + em &&
                /\d/.test(l.text)
            ).length >= 3
          )
        })
      )
        return false
      const tolerance = Math.max(em, (rect[2] - rect[0]) * 0.08)
      const edges = rules.filter(
        (r) =>
          r.every(Number.isFinite) &&
          r[1] === r[3] &&
          Math.abs(r[0] - rect[0]) <= tolerance &&
          Math.abs(r[2] - rect[2]) <= tolerance
      )
      const openingCandidates = edges.filter(
        (r) =>
          r[1] >= caption.rect[3] &&
          r[1] - caption.rect[3] <= em * 3 &&
          Math.abs(r[1] - rect[1]) <= em * 2 &&
          aligned(r, caption, em)
      )
      // A body-only prediction can begin below both the opening and separator.
      // The first matching source stroke after the caption is the opening;
      // an intervening equal-width stroke prevents a separator masquerading as
      // another independent opening candidate.
      const opening = openingCandidates.filter(
        (r) =>
          !edges.some(
            (earlier) =>
              earlier[1] >= caption.rect[3] &&
              earlier[1] < r[1] - 0.5 &&
              Math.abs(earlier[0] - r[0]) < 0.5 &&
              Math.abs(earlier[2] - r[2]) < 0.5
          )
      )
      if (opening.length !== 1) return false
      const first = opening[0]
      const closing = edges.filter(
        (r) =>
          r[1] > first[1] + em * 3 &&
          Math.abs(r[1] - rect[3]) <= em &&
          Math.abs(r[0] - first[0]) < 0.5 &&
          Math.abs(r[2] - first[2]) < 0.5
      )
      if (
        closing.length !== 1 ||
        !edges.some(
          (r) =>
            r[1] > first[1] + em * 0.5 && r[1] - first[1] <= em * 4 && r[1] < closing[0][1] - em
        )
      )
        return false
      const frame = [first[0], first[1], first[2], closing[0][1]]
      if (
        tables.some((other, n) => n !== index && intersection(other.rect, frame) > 0) ||
        candidates.some(
          (other) =>
            other !== caption &&
            other.page === page.pageNumber &&
            intersection(other.rect, frame) > 0
        )
      )
        return false
      const corridor = [
        Math.min(first[0], caption.rect[0]),
        caption.rect[3],
        Math.max(first[2], caption.rect[2]),
        first[1]
      ]
      if (
        page.lines.some(
          (l) =>
            intersection(lineRect(l), corridor) > 0 &&
            intersection(lineRect(l), caption.rect) === 0 &&
            l.y + l.height <= first[1]
        )
      )
        return false
      const source = groupPageLines(page).filter(
        (l) =>
          l.y >= first[1] - em * 0.1 &&
          l.bottom <= closing[0][1] + em * 0.1 &&
          l.x >= first[0] - em &&
          l.right <= first[2] + em
      )
      return source.filter((l) => /\d/.test(l.text)).length >= 3
    })
  )
  const owned = matches.map((items, index) =>
    items.length === 1 && !matches.some((other, n) => n !== index && other.includes(items[0]))
      ? { caption: items[0] }
      : undefined
  )
  // An oversized competing prediction may have no complete frame. Its
  // presence must not erase an independently proven compact table's title.
  if (owned.some(Boolean)) return owned
}

// Complete centered two-line titles can be wider than their compact native
// tables. Recover them only as a complete unique same-page ruled pair.
const stackedCaptionValidRect = (r) =>
  Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1]
const stackedCaptionFontBox = (l) => [l.x, l.y, l.x + l.width, l.y + l.height]
const stackedCaptionOverlaps = (a, b) =>
  Math.min(a[2], b[2]) > Math.max(a[0], b[0]) && Math.min(a[3], b[3]) > Math.max(a[1], b[1])
const stackedCaptionContains = (a, b) =>
  b.every((v, n) => (n < 2 ? v >= a[n] - 1e-8 : v <= a[n] + 1e-8))
const stackedCaptionValidLine = (l) =>
  l &&
  typeof l === 'object' &&
  typeof l.text === 'string' &&
  l.text.trim() &&
  [l.x, l.y, l.width, l.height, l.fontSize].every(Number.isFinite) &&
  l.width > 0 &&
  l.height > 0 &&
  l.fontSize > 0 &&
  l.height >= l.fontSize - 1e-8
const stackedCaptionMidpoint = (r) => (r[0] + r[2]) / 2
const stackedCaptionRectKey = (r) => r.map((v) => v.toFixed(7)).join(',')

function recoverNativeCompleteStackedCaptions(page, tables, candidates, rules) {
  if (
    !page ||
    typeof page !== 'object' ||
    !Array.isArray(page.lines) ||
    !page.lines.every(stackedCaptionValidLine) ||
    ![page.pageNumber, page.width, page.height].every(Number.isFinite) ||
    page.width <= 0 ||
    page.height <= 0 ||
    !Array.isArray(tables) ||
    tables.length !== 2 ||
    !tables.every((t) => t && stackedCaptionValidRect(t.rect)) ||
    !Array.isArray(candidates) ||
    !Array.isArray(rules)
  )
    return
  if (!rules.every((r) => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite))) return
  if (
    !candidates.every(
      (c) =>
        c &&
        typeof c === 'object' &&
        Array.isArray(c.lines) &&
        c.lines.length &&
        c.lines.every((l) => typeof l === 'string') &&
        stackedCaptionValidRect(c.rect)
    )
  )
    return
  const local = candidates.filter(
    (c) => c.page === page.pageNumber && captionKind(c.lines[0]) === 'table'
  )
  if (
    local.length !== 2 ||
    !local.every((c) => c.lines.length === 1 && /^Table\s+[AS]?\d+[.:]\s+\S.{34}/i.test(c.lines[0]))
  )
    return
  const source = groupPageLines(page)
  const fullCaptions = []
  for (const candidate of local) {
    const first = source.filter(
      (l) =>
        l.text === candidate.lines[0] &&
        stackedCaptionRectKey([l.x, l.y, l.right, l.bottom]) ===
          stackedCaptionRectKey(candidate.rect)
    )
    if (first.length !== 1) return
    const start = first[0],
      em = start.fontSize
    const following = source
      .filter((l) => l.y >= start.bottom)
      .sort((a, b) => a.y - b.y || a.x - b.x)
    const tail = following[0]
    if (
      !tail ||
      !/[.!?]$/u.test(tail.text.trim()) ||
      tail.text.length < 30 ||
      captionKind(tail.text) ||
      /^Notes?\s*[:.]/i.test(tail.text) ||
      Math.abs(tail.fontSize - em) > em * 1e-6 ||
      tail.y - start.y < em * 1.15 ||
      tail.y - start.y > em * 1.3 ||
      Math.abs((tail.x + tail.right - start.x - start.right) / 2) > em * 0.05 ||
      tail.right - tail.x < (start.right - start.x) * 0.4 ||
      tail.right - tail.x > (start.right - start.x) * 0.85
    )
      return
    const rect = [
      Math.min(start.x, tail.x),
      start.y,
      Math.max(start.right, tail.right),
      tail.bottom
    ]
    const rows = source.filter((l) => stackedCaptionOverlaps([l.x, l.y, l.right, l.bottom], rect))
    if (rows.length !== 2 || rows[0].text !== start.text || rows[1].text !== tail.text) return
    const allFonts = page.lines.filter((l) =>
      stackedCaptionOverlaps(stackedCaptionFontBox(l), rect)
    )
    if (
      allFonts.length === 0 ||
      !allFonts.every((l) => stackedCaptionContains(rect, stackedCaptionFontBox(l)))
    )
      return
    if (
      candidates.some(
        (c) => c !== candidate && c.page === page.pageNumber && stackedCaptionOverlaps(c.rect, rect)
      )
    )
      return
    fullCaptions.push({ ...candidate, lines: [start.text, tail.text], rect })
  }
  if (stackedCaptionOverlaps(fullCaptions[0].rect, fullCaptions[1].rect)) return
  const horizontal = rules.filter((r) => r[1] === r[3])
  const matches = tables.map((table, index) =>
    fullCaptions.flatMap((caption) => {
      const em = Math.max(
        ...page.lines
          .filter((l) => stackedCaptionOverlaps(stackedCaptionFontBox(l), caption.rect))
          .map((l) => l.fontSize)
      )
      if (caption.rect[3] > table.rect[1]) return []
      const edges = horizontal.filter(
        (r) =>
          Math.abs(r[0] - table.rect[0]) <= (table.rect[2] - table.rect[0]) * 0.08 &&
          Math.abs(r[2] - table.rect[2]) <= (table.rect[2] - table.rect[0]) * 0.08 &&
          Math.abs(stackedCaptionMidpoint(r) - stackedCaptionMidpoint(caption.rect)) < em * 0.1 &&
          r[2] - r[0] >= (caption.rect[2] - caption.rect[0]) * 0.4 &&
          r[2] - r[0] <= (caption.rect[2] - caption.rect[0]) * 0.6
      )
      const openings = edges.filter(
        (r) =>
          r[1] >= caption.rect[3] &&
          r[1] - caption.rect[3] < em * 1.6 &&
          Math.abs(r[1] - table.rect[1]) < em * 0.25
      )
      if (openings.length !== 1) return []
      const opening = openings[0]
      const same = edges
        .filter((r) => Math.abs(r[0] - opening[0]) < 1e-5 && Math.abs(r[2] - opening[2]) < 1e-5)
        .sort((a, b) => a[1] - b[1])
      const closings = same.filter(
        (r) => r[1] > opening[1] + em * 3 && Math.abs(r[1] - table.rect[3]) < em
      )
      if (closings.length !== 1) return []
      const closing = closings[0]
      const separators = same.filter(
        (r) => r[1] > opening[1] + em && r[1] < opening[1] + em * 3 && r[1] < closing[1] - em
      )
      if (
        separators.length !== 1 ||
        same.some(
          (r) =>
            r !== opening &&
            r !== closing &&
            r !== separators[0] &&
            r[1] > opening[1] &&
            r[1] < closing[1]
        )
      )
        return []
      const bodyFonts = page.lines.filter(
        (l) =>
          l.y >= opening[1] &&
          l.y + l.height <= closing[1] &&
          l.x >= opening[0] &&
          l.x + l.width <= opening[2]
      )
      if (!bodyFonts.length) return []
      const bodyEm = Math.max(...bodyFonts.map((l) => l.fontSize))
      if (!(bodyEm > 0 && bodyEm <= em * 0.92)) return []
      // Complete native parent boxes can start above the rule. Own their entire
      // envelope locally, rather than using a clipped printed-font subset.
      const envelope = [opening[0], opening[1] - bodyEm * 0.25, opening[2], closing[1]]
      const fonts = page.lines.filter((l) =>
        stackedCaptionOverlaps(stackedCaptionFontBox(l), envelope)
      )
      if (
        !fonts.length ||
        !fonts.every(
          (l) =>
            stackedCaptionContains(envelope, stackedCaptionFontBox(l)) &&
            Math.abs(l.fontSize - bodyEm) < bodyEm * 0.01
        )
      )
        return []
      const header = fonts.filter((l) => l.y + l.height <= separators[0][1])
      const records = fonts.filter((l) => l.y >= separators[0][1] - bodyEm * 0.25)
      if (
        header.length !== 2 ||
        !header.every((l) => /\p{L}/u.test(l.text)) ||
        records.length < 3 ||
        !records.every((l) => (l.text.match(/[-+−]?\d+(?:\.\d+)?/gu) ?? []).length >= 2)
      )
        return []
      const corridor = [caption.rect[0], caption.rect[3], caption.rect[2], opening[1]]
      if (
        page.lines.some(
          (l) => stackedCaptionOverlaps(stackedCaptionFontBox(l), corridor) && !fonts.includes(l)
        )
      )
        return []
      if (
        tables.some((t, n) => n !== index && stackedCaptionOverlaps(t.rect, envelope)) ||
        fullCaptions.some((c) => c !== caption && stackedCaptionOverlaps(c.rect, envelope)) ||
        candidates.some(
          (c) =>
            c.page === page.pageNumber &&
            !local.includes(c) &&
            (stackedCaptionOverlaps(c.rect, envelope) || stackedCaptionOverlaps(c.rect, corridor))
        )
      )
        return []
      return [
        {
          caption,
          frame: [opening[0], opening[1], opening[2], closing[1]],
          envelope,
          opening,
          separator: separators[0],
          closing,
          completeSourceFontRows: fonts.length
        }
      ]
    })
  )
  if (
    !matches.every((ms) => ms.length === 1) ||
    new Set(matches.map((ms) => ms[0].caption)).size !== 2
  )
    return
  return fullCaptions
}

export function associateTableCaptions(page, tables, candidates, rules = [], pages = []) {
  const completeBelow = associateCompleteNativeBelowTableCaptions(page, tables, candidates, rules)
  if (completeBelow) return completeBelow
  const completeStackedCaptions = recoverNativeCompleteStackedCaptions(
    page,
    tables,
    candidates,
    rules
  )
  if (completeStackedCaptions) {
    let titleIndex = 0
    candidates = candidates.map((c) =>
      c.page === page.pageNumber && captionKind(c.lines[0]) === 'table'
        ? completeStackedCaptions[titleIndex++]
        : c
    )
  }
  const completeNative = associateCompleteNativeTableCaptions(page, tables, candidates, rules)
  if (completeNative?.every(Boolean)) return completeNative
  const pairedContinuation = associatePairedCountContinuation(
    page,
    tables,
    candidates,
    rules,
    pages
  )
  if (pairedContinuation) return [{ caption: pairedContinuation }]
  const terminalStatisticalCaption = associateTerminalStatisticalCaption(
    page,
    tables,
    candidates,
    rules,
    pages
  )
  if (terminalStatisticalCaption) return [{ caption: terminalStatisticalCaption }]
  const isBareTableLabel = (text) =>
    /^(?:Table|Tab\.?)\s+(?:[AS]?\d+(?:\.\d+)*|[IVXLCDM]+)\.\s*$/i.test(text?.trim() ?? '')
  const captions = candidates.filter(
    (c) =>
      c.page === page.pageNumber &&
      (captionKind(c.lines[0]) === 'table' || isBareTableLabel(c.lines[0]))
  )
  const tableNotes = associateTableNotes(page, tables, rules)
  const choices = tables.map(({ rect }, tableIndex) =>
    captions
      .map((caption) => {
        const c = caption.rect
        // A caption immediately below a footer sharing the header's endpoints
        // belongs to that table, even when a second table starts closer below.
        const ruledFooter =
          c[1] >= rect[3] &&
          rules.some(
            (footer) =>
              Math.abs(footer[3] - footer[1]) < 1 &&
              footer[1] >= rect[3] &&
              footer[1] - rect[3] <= 80 &&
              footer[1] <= c[1] &&
              c[1] - footer[1] <= 12 &&
              !rules.some(
                (edge) =>
                  edge[1] === edge[3] &&
                  edge[1] >= rect[3] - 1 &&
                  edge[1] < footer[1] - 2 &&
                  Math.abs(edge[0] - footer[0]) <= 2 &&
                  Math.abs(edge[2] - footer[2]) <= 2
              ) &&
              Math.abs(footer[0] - c[0]) <= 4 &&
              // Detection crops can include a narrow pad outside the actual
              // column. The matching header/footer still define the table.
              footer[0] <= rect[0] + (rect[2] - rect[0]) * 0.15 &&
              footer[2] >= rect[2] - 4 &&
              (rect[2] - rect[0]) / (footer[2] - footer[0]) >= 0.85 &&
              (rect[2] - rect[0]) / (footer[2] - footer[0]) <= 1.2 &&
              rules.some(
                (header) =>
                  Math.abs(header[3] - header[1]) < 1 &&
                  Math.abs(header[0] - footer[0]) <= 2 &&
                  Math.abs(header[2] - footer[2]) <= 2 &&
                  header[1] >= rect[1] &&
                  header[1] <= rect[1] + (rect[3] - rect[1]) * 0.25
              ) &&
              !tables.some(
                (other, i) =>
                  i !== tableIndex &&
                  intersection(other.rect, [footer[0], rect[3], footer[2], c[3]]) > 0
              )
          )
        const sideGap = c[2] <= rect[0] ? rect[0] - c[2] : c[0] >= rect[2] ? c[0] - rect[2] : -1
        const sideCaption =
          sideGap >= 0 &&
          sideGap < 60 &&
          Math.abs(c[1] - rect[1]) < 24 &&
          c[3] > rect[1] &&
          c[3] <= rect[3]
        // A caption in the neighboring newspaper column can sit just beyond
        // this table's edge and look like a marginal title. If another table
        // owns the caption's horizontal span, keep this marginal interpretation
        // out of the choices so captions cannot jump across columns.
        const sideCaptionHasHorizontalOwner =
          sideCaption &&
          tables.some((other, otherIndex) => {
            if (otherIndex === tableIndex) return false
            const otherRect = other.rect
            const horizontalOverlap = Math.min(c[2], otherRect[2]) - Math.max(c[0], otherRect[0])
            if (horizontalOverlap / Math.min(c[2] - c[0], otherRect[2] - otherRect[0]) < 0.5)
              return false
            const verticalGap =
              c[3] <= otherRect[1]
                ? otherRect[1] - c[3]
                : c[1] >= otherRect[3]
                  ? c[1] - otherRect[3]
                  : 0
            return verticalGap <= Math.max(24, c[3] - c[1] + 24)
          })
        // A predicted crop may overlap only the bottom of an above-table title.
        // A full-width source rule below the title distinguishes crop padding
        // from a caption embedded in the data region.
        const titleRulePadding = Math.max(6, Math.min(12, (rect[2] - rect[0]) * 0.02))
        const paddedTitle =
          c[1] < rect[1] &&
          c[3] > rect[1] &&
          c[3] - rect[1] <= (c[3] - c[1]) * 0.35 &&
          rules.some(
            (r) =>
              r[1] === r[3] &&
              r[1] >= c[3] &&
              r[1] - c[3] <= 12 &&
              Math.abs(r[0] - rect[0]) <= titleRulePadding &&
              Math.abs(r[2] - rect[2]) <= titleRulePadding
          )
        const paddedFooter = (() => {
          // Native column segments can end just below the final text record.
          // Require their matching terminal edge and an intact numeric row
          // before treating a tiny title overlap as row-box padding.
          if (
            tables.length !== 1 ||
            captions.length !== 1 ||
            c[1] >= rect[3] ||
            c[3] <= rect[3] ||
            !/^Table\s+\d+[.:]\s.{20,}/i.test(caption.lines.join(' '))
          )
            return false
          const em = Math.max(
            ...page.lines
              .filter((l) => intersection(lineRect(l), c) > 0)
              .map((l) => l.fontSize)
              .filter((h) => h > 0)
          )
          if (!Number.isFinite(em) || rect[3] - c[1] > em * 0.15) return false
          const terminal = rules.filter(
            (r) =>
              r[0] === r[2] &&
              r[0] > rect[0] &&
              r[0] < rect[2] &&
              Math.abs(r[3] - rect[3]) <= 0.1 &&
              r[3] > r[1] &&
              r[3] - r[1] <= em * 2
          )
          if (
            new Set(terminal.map((r) => r[0])).size < 3 ||
            Math.max(...terminal.map((r) => r[0])) - Math.min(...terminal.map((r) => r[0])) <
              (rect[2] - rect[0]) * 0.4 ||
            Math.max(...terminal.map((r) => r[1])) - Math.min(...terminal.map((r) => r[1])) > 0.1
          )
            return false
          const start = terminal[0][1]
          return (
            page.lines.some(
              (l) =>
                l.y >= start - em * 0.3 &&
                l.y + l.height <= c[1] &&
                l.x >= rect[0] &&
                l.x + l.width <= rect[2] &&
                (l.text.match(/\d+(?:\.\d+)?/g) ?? []).length >= 3
            ) &&
            page.lines
              .filter((l) => intersection(lineRect(l), [rect[0], c[1], rect[2], rect[3]]) > 0)
              .every((l) => intersection(lineRect(l), c) / area(lineRect(l)) > 0.98)
          )
        })()
        const gap =
          paddedTitle || paddedFooter
            ? 0
            : sideCaption
              ? sideGap
              : c[3] <= rect[1]
                ? rect[1] - c[3]
                : c[1] >= rect[3]
                  ? c[1] - rect[3]
                  : -1
        const overlap = sideCaption
          ? Math.min(c[2] - c[0], rect[2] - rect[0])
          : Math.min(c[2], rect[2]) - Math.max(c[0], rect[0])
        const betweenTop = Math.min(c[3], rect[3])
        const betweenBottom = Math.max(c[1], rect[1])
        const blocked = page.lines.some((line) => {
          const l = lineRect(line)
          return (
            line.text.length > 80 &&
            l[1] > betweenTop + 2 &&
            l[3] < betweenBottom - 2 &&
            l[0] < rect[2] &&
            l[2] > rect[0] &&
            !tableNotes[tableIndex].some(
              (note) => note.rect[3] <= c[1] && intersection(note.rect, l) / area(l) > 0.8
            ) &&
            !candidates.some(
              (candidate) =>
                candidate.page === page.pageNumber && intersection(candidate.rect, l) > 0
            )
          )
        })
        return { caption, gap, overlap, blocked, ruledFooter, sideCaptionHasHorizontalOwner }
      })
      .filter(
        ({ caption, gap, overlap, blocked, ruledFooter, sideCaptionHasHorizontalOwner }) =>
          !completeNative?.some(
            (owner, index) => index !== tableIndex && owner?.caption === caption
          ) &&
          gap >= 0 &&
          !sideCaptionHasHorizontalOwner &&
          (ruledFooter ||
            gap <= 60 ||
            (tables.length === 1 && captions.length === 1 && gap <= page.height * 0.2)) &&
          (ruledFooter || !blocked) &&
          overlap / Math.min(rect[2] - rect[0], caption.rect[2] - caption.rect[0]) >= 0.5
      )
      .filter((match, _, matches) => {
        // A same-number "continues" footer is a forward page marker when a
        // unique full title already owns the native opening rule above this
        // table. Do not let their nearly equal distances erase that title.
        const marker = /^Table\s+(\d+[A-Z]?)\s*\(continues\)\s*$/i.exec(
          match.caption.lines.join(' ').trim()
        )
        if (!marker || matches.length !== 2 || match.caption.rect[1] < rect[3]) return true
        const title = matches.find((m) => m !== match)
        const description = /^Table\s+(\d+[A-Z]?)\s*:\s*(.{20,})$/i.exec(
          title.caption.lines.join(' ').trim()
        )
        if (
          !description ||
          description[1].toLowerCase() !== marker[1].toLowerCase() ||
          title.caption.rect[3] > rect[1] ||
          title.gap > Math.min(18, (title.caption.rect[3] - title.caption.rect[1]) * 2) ||
          match.gap > Math.min(18, (match.caption.rect[3] - match.caption.rect[1]) * 2)
        )
          return true
        const tolerance = Math.max(4, (rect[2] - rect[0]) * 0.02)
        const opening = rules.filter(
          (r) =>
            r[1] === r[3] &&
            r[1] >= title.caption.rect[3] &&
            r[1] <= rect[1] + Math.min(4, (title.caption.rect[3] - title.caption.rect[1]) * 0.25) &&
            Math.abs(r[0] - rect[0]) <= tolerance &&
            Math.abs(r[2] - rect[2]) <= tolerance &&
            Math.abs(r[0] - title.caption.rect[0]) <= 4 &&
            title.caption.rect[2] <= r[2] + 4 &&
            Math.abs(match.caption.rect[2] - r[2]) <= 4
        )
        return opening.length !== 1
      })
      .filter((match, _, matches) => {
        // Some layouts print only a table number above and repeat that same
        // number with the description below. Two close eligible matches prove
        // the description's ownership without treating their distance as a tie.
        const label = /^Table\s+(\d+[A-Z]?)\.?$/i.exec(match.caption.lines.join(' ').trim())
        if (!label || matches.length !== 2 || match.caption.rect[3] > rect[1]) return true
        const other = matches.find((m) => m !== match)
        const description = /^Table\s+(\d+[A-Z]?)\.\s+(.{20,})$/i.exec(
          other.caption.lines.join(' ').trim()
        )
        return !(
          description &&
          description[1].toLowerCase() === label[1].toLowerCase() &&
          other.caption.rect[1] >= rect[3] &&
          match.gap <= (match.caption.rect[3] - match.caption.rect[1]) * 2 &&
          other.gap <= (other.caption.rect[3] - other.caption.rect[1]) * 2 &&
          Math.abs(match.caption.rect[0] - other.caption.rect[0]) <=
            match.caption.rect[3] - match.caption.rect[1]
        )
      })
      .sort((a, b) => Number(b.ruledFooter) - Number(a.ruledFooter) || a.gap - b.gap)
  )
  // Closely stacked tables can put the next title nearer the preceding table.
  // Require a complete, unique set of short above-table matches in one column
  // before using that shared layout instead of independent nearest distances.
  const above = choices.map((matches, i) =>
    matches.filter(
      (m) =>
        m.caption.rect[3] <= tables[i].rect[1] &&
        (m.gap <= Math.min(18, (m.caption.rect[3] - m.caption.rect[1]) * 2) ||
          // A full-width header rule can precede the first predicted row.
          // Keep the shared above-table layout when that rule bounds the gap.
          (m.gap <= Math.min(36, (m.caption.rect[3] - m.caption.rect[1]) * 4) &&
            rules.some(
              (r) =>
                r[1] === r[3] &&
                r[1] >= m.caption.rect[3] &&
                r[1] <= tables[i].rect[1] &&
                tables[i].rect[1] - r[1] <= m.caption.rect[3] - m.caption.rect[1] &&
                Math.abs(r[0] - tables[i].rect[0]) <=
                  (tables[i].rect[2] - tables[i].rect[0]) * 0.02 &&
                Math.abs(r[2] - tables[i].rect[2]) <= (tables[i].rect[2] - tables[i].rect[0]) * 0.02
            )))
    )
  )
  const completeNativeStack =
    tables.length >= 2 &&
    tables.length <= 6 &&
    above.every((matches, i) => {
      if (matches.length !== 1) return false
      const caption = matches[0].caption,
        rect = tables[i].rect,
        em = Math.max(
          ...page.lines
            .filter((l) => intersection(lineRect(l), caption.rect) > 0)
            .map((l) => l.fontSize)
            .filter((h) => h > 0)
        )
      if (!Number.isFinite(em) || !/^Table\s+\d+[.:]\s/i.test(caption.lines[0])) return false
      const edgeTolerance = (rect[2] - rect[0]) * 0.08
      const hasOmittedHeaderLabels = (rule) => {
        // Predicted rows may start below a parent header. Two smaller native
        // labels on the same baseline, separated horizontally and wholly
        // inside that band, prove its ownership without widening prose gaps.
        if (rect[1] - rule[1] > em * 2) return false
        const labels = page.lines.filter(
          (l) =>
            l.y >= rule[1] &&
            l.y + l.height <= rect[1] &&
            l.x >= rule[0] &&
            l.x + l.width <= rule[2] &&
            l.width <= (rule[2] - rule[0]) * 0.7 &&
            l.fontSize > 0 &&
            l.fontSize <= em * 0.8 &&
            /[A-Za-z]/.test(l.text) &&
            !/\d|[.!?;]\s*$/.test(l.text)
        )
        return labels.some((a, n) =>
          labels.slice(n + 1).some((b) => {
            const font = Math.max(a.fontSize, b.fontSize)
            return (
              Math.abs(a.y + a.height - b.y - b.height) <= font * 0.2 &&
              Math.max(b.x - a.x - a.width, a.x - b.x - b.width) >= font * 0.5
            )
          })
        )
      }
      const opening = rules.filter(
        (r) =>
          r[1] === r[3] &&
          r[1] >= caption.rect[3] &&
          // Native glyph boxes can overhang their opening rule by a fraction
          // of an em. The complete unique frame still proves upper ownership.
          r[1] <= rect[1] + em * 0.1 &&
          r[1] - caption.rect[3] <= em * 1.5 &&
          (rect[1] - r[1] <= em || hasOmittedHeaderLabels(r)) &&
          Math.abs(r[0] - rect[0]) <= edgeTolerance &&
          Math.abs(r[2] - rect[2]) <= edgeTolerance &&
          Math.abs((r[0] + r[2] - caption.rect[0] - caption.rect[2]) / 2) <= em
      )
      if (opening.length !== 1) return false
      const first = opening[0],
        closing = rules.filter(
          (r) =>
            r[1] === r[3] &&
            r[1] >= rect[3] &&
            r[1] - rect[3] <= em &&
            Math.abs(r[0] - first[0]) <= 0.1 &&
            Math.abs(r[2] - first[2]) <= 0.1
        )
      if (
        closing.length !== 1 ||
        tables.some(
          (t, n) =>
            n !== i && intersection(t.rect, [first[0], first[1], first[2], closing[0][1]]) > 0
        )
      )
        return false
      const source = page.lines.filter(
        (l) =>
          l.y >= first[1] &&
          l.y + l.height <= closing[0][1] &&
          l.x >= first[0] - 0.1 &&
          l.x + l.width <= first[2] + 0.1
      )
      return source.filter((l) => (l.text.match(/\d+(?:\.\d+)?/g) ?? []).length >= 3).length >= 3
    })
  if (
    tables.length > 1 &&
    (captions.length === tables.length || completeNativeStack) &&
    above.every((matches) => matches.length === 1) &&
    new Set(above.map((matches) => matches[0].caption)).size === tables.length &&
    // A unique complete stack proves that the nearby below-footer title owns
    // the next table; footer proximity alone cannot override both opening rules.
    (completeNativeStack || !choices.some((matches) => matches.some((m) => m.ruledFooter))) &&
    tables.every(
      ({ rect }) =>
        (Math.min(rect[2], tables[0].rect[2]) - Math.max(rect[0], tables[0].rect[0])) /
          Math.min(rect[2] - rect[0], tables[0].rect[2] - tables[0].rect[0]) >=
        0.7
    )
  )
    return above.map((matches) => ({ caption: matches[0].caption }))
  return choices.map((matches, index) => {
    if (completeNative?.[index]) return completeNative[index]
    if (!matches.length) {
      const caption =
        associateCaptionSheet(page, tables, candidates, rules, pages) ??
        associateCountContinuationCaption(page, tables, candidates, pages, 1) ??
        associateCountContinuationCaption(page, tables, candidates, pages)
      return caption ? { caption } : { reason: 'no-adjacent-table-caption' }
    }
    const bareLabel = matches.find(
      (match) =>
        isBareTableLabel(match.caption.lines.join(' ').trim()) &&
        match.caption.rect[3] <= tables[index].rect[1]
    )
    if (bareLabel) {
      const bareNumber = /^(?:Table|Tab\.?)\s+([AS]?\d+(?:\.\d+)*|[IVXLCDM]+)\./i.exec(
        bareLabel.caption.lines.join(' ').trim()
      )?.[1]
      const provenDescription = matches.some((match) => {
        if (match === bareLabel) return false
        const description =
          /^(?:Table|Tab\.?)\s+([AS]?\d+(?:\.\d+)*|[IVXLCDM]+)\.\s+(.{20,})$/i.exec(
            match.caption.lines.join(' ').trim()
          )
        return (
          description &&
          description[1].toLowerCase() === bareNumber?.toLowerCase() &&
          match.caption.rect[1] >= tables[index].rect[3] &&
          match.gap <= (match.caption.rect[3] - match.caption.rect[1]) * 2 &&
          Math.abs(bareLabel.caption.rect[0] - match.caption.rect[0]) <=
            bareLabel.caption.rect[3] - bareLabel.caption.rect[1]
        )
      })
      if (!provenDescription) return { reason: 'ambiguous-table-caption' }
    }
    if (
      matches[1] &&
      matches[1].ruledFooter === matches[0].ruledFooter &&
      matches[1].gap - matches[0].gap < 2
    )
      return { reason: 'ambiguous-table-caption' }
    const best = matches[0]
    // Require the caption to prefer this table too; reject reverse ties or a closer competing table.
    if (
      choices.some(
        (other, i) =>
          i !== index &&
          other.some(
            (m) =>
              m.caption === best.caption &&
              ((m.ruledFooter && !best.ruledFooter) ||
                (m.ruledFooter === best.ruledFooter && m.gap <= best.gap + 2))
          )
      )
    )
      return { reason: 'shared-table-caption' }
    return { caption: recoverSpacedCaptionContinuations(page, best.caption, tables[index].rect) }
  })
}

// A labelled graphical abstract can share its page with ordinary article text.
// Only a single substantial raster image directly beneath the explicit title
// qualifies; no numbering or description is inferred.
export function associateGraphicalAbstract(page) {
  const titles = page.lines.filter((l) => /^Graphical Abstract$/i.test(l.text.trim()))
  const images = page.graphicsBounds.filter(
    (g) =>
      g.kind === 'image' &&
      (g.normalizedRect[2] - g.normalizedRect[0]) * (g.normalizedRect[3] - g.normalizedRect[1]) >
        0.1
  )
  if (page.pageNumber > 3 || titles.length !== 1 || images.length !== 1) return
  const title = titles[0],
    rect = images[0].normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
  // A labelled abstract can put its description before the centered image.
  // Require the whole intervening block to be one tightly spaced paragraph;
  // a distant image alone does not establish ownership.
  const description = page.lines
    .filter((l) => l.y >= title.y + title.height && l.y < rect[1] && l.height <= title.height * 1.5)
    .sort((a, b) => a.y - b.y)
  if (
    description.length >= 2 &&
    description.length <= 10 &&
    rect[2] - rect[0] >= page.width * 0.4 &&
    description[0].y - title.y - title.height <= title.height * 2 &&
    description[0].x >= title.x &&
    description[0].x - title.x <= title.height * 2 &&
    description.every(
      (l, n) =>
        l.height > 0 &&
        l.text.length >= 20 &&
        Math.abs(l.height - description[0].height) < 0.5 &&
        Math.abs(l.x - description[0].x) < 2 &&
        l.y + l.height <= rect[1] &&
        (!n ||
          (l.y > description[n - 1].y + l.height * 0.8 &&
            l.y - description[n - 1].y <= l.height * 1.8))
    ) &&
    rect[1] - description.at(-1).y - description.at(-1).height <= 24 &&
    (Math.abs(
      (rect[0] + rect[2]) / 2 - description[0].x - Math.max(...description.map((l) => l.width)) / 2
    ) <= 24 ||
      Math.abs((rect[0] + rect[2]) / 2 - page.width / 2) <= 24)
  )
    return {
      rect,
      graphicsCount: 1,
      caption: {
        page: page.pageNumber,
        lines: [title.text, ...description.map((l) => l.text)],
        rect: union([title, ...description].map(lineRect))
      }
    }
  if (
    rect[2] - rect[0] < page.width * 0.6 ||
    rect[1] < title.y + title.height ||
    rect[1] - title.y - title.height > 24 ||
    Math.abs(rect[0] - title.x) > 24
  )
    return
  return {
    rect,
    graphicsCount: 1,
    caption: { page: page.pageNumber, lines: [title.text], rect: lineRect(title) }
  }
}

// A landscape plate exported from a slide uses a single number-only footer
// caption and large diagram labels throughout. Its raster panels can be far
// from that caption or extend beside it. Derive the complete plate from painted
// content and native labels, never from non-painting clipping dependencies.
function associateStandaloneFigurePlate(page, captions, tableRects) {
  if (
    page.width < page.height * 1.2 ||
    captions.length !== 1 ||
    tableRects.length ||
    page.graphicsBounds.some((g) => !g.normalizedRect.every(Number.isFinite))
  )
    return
  const caption = captions[0]
  if (!/^(?:Figure|Fig\.)\s*\d+\.?$/i.test(caption.lines.join(' ').trim())) return
  if (caption.rect[1] < page.height * 0.1 && caption.rect[2] < page.width * 0.2) {
    const frames = page.graphicsBounds
      .filter((g) => g.kind === 'path')
      .map((g) => g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)))
      .filter(
        (r) =>
          r[2] - r[0] > 30 &&
          r[3] - r[1] > 15 &&
          r[3] - r[1] < page.height * 0.3 &&
          area(r) < page.width * page.height * 0.2 &&
          intersection(r, caption.rect) === 0 &&
          page.lines.some((l) => intersection(lineRect(l), r) / area(lineRect(l)) > 0.8)
      )
    const unique = frames.filter(
      (r, n) =>
        !frames.slice(0, n).some((p) => intersection(p, r) / Math.min(area(p), area(r)) > 0.9)
    )
    const labels = page.lines.filter((l) =>
      unique.some((r) => intersection(lineRect(l), r) / area(lineRect(l)) > 0.8)
    )
    if (
      unique.length >= 6 &&
      labels.length >= 12 &&
      unique.some((r) => r[1] < caption.rect[3] && r[0] > caption.rect[2])
    ) {
      const rect = union(unique)
      if (rect[2] - rect[0] > page.width * 0.65 && rect[3] - rect[1] > page.height * 0.65)
        return { caption, rect, graphicsCount: unique.length }
    }
    return
  }
  if (caption.rect[1] < page.height * 0.9) return
  const footerTop = Math.min(
    page.height,
    ...page.lines
      .filter(
        (line) => line.y > page.height * 0.9 && /Downloaded from|©|Copyright/i.test(line.text)
      )
      .map((line) => line.y)
  )
  const labels = page.lines.filter(
    (line) => line.y < footerTop && !/^(?:Figure|Fig\.)\s*\d+\.?$/i.test(line.text.trim())
  )
  if (
    labels.length < 5 ||
    labels.some(
      (line) =>
        line.fontSize < page.height * 0.02 ||
        !Number.isFinite(line.fontSize) ||
        line.text.length > 100
    ) ||
    !labels.some((line) => line.fontSize >= page.height * 0.045)
  )
    return
  const graphics = page.graphicsBounds.filter(
    (g) => g.kind !== 'path' || area(g.normalizedRect) < 0.95
  )
  const frames = graphics.filter(
    (g) =>
      g.kind === 'path' &&
      g.normalizedRect[2] - g.normalizedRect[0] > 0.2 &&
      g.normalizedRect[3] - g.normalizedRect[1] > 0.2
  )
  const distinct = frames.filter(
    (g, n) =>
      !frames
        .slice(0, n)
        .some(
          (other) =>
            intersection(g.normalizedRect, other.normalizedRect) /
              Math.min(area(g.normalizedRect), area(other.normalizedRect)) >
            0.9
        )
  )
  if (
    graphics.filter((g) => g.kind === 'image' && area(g.normalizedRect) > 0.02).length < 2 &&
    distinct.length < 3
  )
    return
  const drawn = graphics.map((g) =>
    g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
  )
  const extent = union(drawn)
  if (extent[2] - extent[0] < page.width * 0.65 || extent[3] - extent[1] < page.height * 0.65)
    return
  const bounds = union([...drawn, ...labels.map(lineRect)])
  return {
    caption,
    rect: [
      Math.max(0, bounds[0]),
      Math.max(0, bounds[1]),
      Math.min(page.width, bounds[2]),
      Math.min(page.height, bounds[3])
    ],
    graphicsCount: graphics.length
  }
}

// A caption strip and matching closing rule bound a native forest-plot panel.
// The adjacent numeric labels and explanatory footnotes belong to this figure,
// even when a table detector also finds the aligned text beside its whiskers.
function associateRuledFigurePlate(page, captions, tableRects, rules) {
  if (captions.length !== 1 || captionKind(captions[0].lines[0]) !== 'figure') return
  const caption = captions[0],
    c = caption.rect
  const paths = page.graphicsBounds
    .filter((g) => g.kind === 'path')
    .map((g) => g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)))
  const wide = (rules.length ? rules : paths)
    .filter((r) => r[2] - r[0] > page.width * 0.7 && r[3] - r[1] < page.height / 128 + 1)
    .sort((a, b) => a[1] - b[1])
  const above = wide.find(
    (r) => Math.abs((r[1] + r[3]) / 2 - c[1]) < 6 && r[0] <= c[0] + 2 && r[2] >= c[2] - 2
  )
  if (!above) return
  const below = wide.filter(
    (r) => r[1] >= c[3] - 2 && Math.abs(r[0] - above[0]) < 2 && Math.abs(r[2] - above[2]) < 2
  )
  if (below.length !== 2 || below[0][1] - c[3] > 12 || below[1][1] - below[0][3] < 60) return
  const [header, footer] = below
  const labels = page.lines.filter(
    (l) =>
      l.y >= header[3] &&
      l.y + l.height <= footer[1] &&
      l.x >= header[0] &&
      l.x + l.width <= header[2]
  )
  const survival =
    labels.some((l) => /^At risk\b/i.test(l.text)) &&
    labels.some((l) => /^Time Since Randomization/.test(l.text)) &&
    labels.some((l) => /^Cumulative Incidence$/.test(l.text)) &&
    rules.some(
      (r) =>
        r[0] === r[2] && r[3] - r[1] > page.height * 0.4 && r[1] >= header[3] && r[3] <= footer[1]
    ) &&
    rules.some(
      (r) =>
        r[1] === r[3] && r[2] - r[0] > page.width * 0.4 && r[1] >= header[3] && r[3] <= footer[1]
    ) &&
    paths.length >= 20
  if (
    (!survival && !labels.some((l) => /HR\s*\(95%\s*CI\)/i.test(l.text))) ||
    labels.filter((l) => /\d/.test(l.text)).length < 12
  )
    return
  const whiskers = paths.filter(
    (r) =>
      r[0] >= header[0] &&
      r[2] <= header[2] &&
      r[1] >= header[3] &&
      r[3] <= footer[1] &&
      r[2] - r[0] >= 5 &&
      r[2] - r[0] < page.width * 0.3 &&
      r[3] - r[1] < page.height / 128 + 1
  )
  if (!survival && new Set(whiskers.map((r) => Math.round(r[1] / 5))).size < 5) return
  const size = Math.max(
    ...page.lines.filter((l) => intersection(lineRect(l), c) > 0).map((l) => l.fontSize)
  )
  const notes = []
  for (const l of groupPageLines(page)
    .filter((l) => l.y >= footer[1] && l.x >= header[0] - 2 && l.right <= header[2] + 2)
    .sort((a, b) => a.y - b.y)) {
    if (
      l.y - (notes.at(-1)?.bottom ?? footer[3]) > size * 1.8 ||
      l.fontSize > size ||
      captionKind(l.text) ||
      /Annals\.org|Downloaded|Copyright/.test(l.text)
    )
      break
    notes.push(l)
  }
  const rect = [header[0], header[3], header[2], Math.max(footer[3], ...notes.map((l) => l.bottom))]
  if (tableRects.some((r) => intersection(r, rect) > 0)) return
  return { caption, rect, graphicsCount: whiskers.length, ownsContainedTables: true }
}

// Aligned marginal captions and separate complete native frames determine
// ownership of vertically stacked plots before distances assign subpaths.
function associateMarginalFigurePlates(page, captions, tableRects, rules) {
  // Separate caption columns can have matched opening/closing rules rather
  // than a complete frame. Resolve both columns together so proximity cannot
  // assign an upper panel in one column to the other column's shorter legend.
  if (captions.length >= 2) {
    const edges = [
      ...rules,
      ...page.graphicsBounds
        .filter((g) => g.kind === 'path')
        .map((g) => g.normalizedRect.map((v, n) => v * (n % 2 ? page.height : page.width)))
        .filter((r) => r[3] - r[1] <= page.height / 128 + 1)
    ]
    const tolerance = page.width / 128 + 1
    const strips = captions.map((c) => {
      const bottom = rules.find(
        (r) =>
          r[1] === r[3] &&
          r[1] >= c.rect[3] &&
          r[1] - c.rect[3] < 16 &&
          Math.abs(r[0] - c.rect[0]) < 4 &&
          r[2] >= c.rect[2] &&
          r[2] - r[0] < page.width * 0.48
      )
      const top =
        bottom &&
        edges
          .filter(
            (r) =>
              r[1] < c.rect[1] - 60 &&
              Math.abs(r[0] - bottom[0]) < tolerance &&
              Math.abs(r[2] - bottom[2]) < tolerance
          )
          .sort((a, b) => b[1] - a[1])[0]
      if (!top) return
      const rect = [top[0] - 2, top[1] - 1, top[2] + 2, c.rect[1] - 2]
      if (
        tableRects.some((t) => intersection(t, rect) > 0) ||
        captions.some((o) => o !== c && intersection(o.rect, rect) > 0)
      )
        return
      const count = page.graphicsBounds.filter(
        (g) =>
          intersection(
            g.normalizedRect,
            rect.map((v, n) => v / (n % 2 ? page.height : page.width))
          ) /
            area(g.normalizedRect) >
          0.95
      ).length
      if (count < 8) return
      return { caption: c, rect, graphicsCount: count }
    })
    if (
      strips.every(Boolean) &&
      strips.every((a, n) => strips.slice(0, n).every((b) => intersection(a.rect, b.rect) === 0))
    )
      return strips
  }
  if (
    captions.length < 2 ||
    captions.some((c) => c.rect[2] > page.width * 0.3) ||
    captions.some((c) => Math.abs(c.rect[0] - captions[0].rect[0]) > 5)
  )
    return
  const ordered = captions.slice().sort((a, b) => a.rect[1] - b.rect[1])
  const result = []
  for (const [n, c] of ordered.entries()) {
    const candidates = page.graphicsBounds
      .filter((g) => g.kind === 'path')
      .map((g) => g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)))
      .filter(
        (r) =>
          r[0] > c.rect[2] + 5 &&
          Math.abs(r[1] - c.rect[1]) < 12 &&
          r[2] - r[0] > page.width * 0.45 &&
          r[3] - r[1] > page.height * 0.12 &&
          r[3] < (ordered[n + 1]?.rect[1] ?? page.height) &&
          !tableRects.some((t) => intersection(t, r) > 0)
      )
      .sort((a, b) => area(b) - area(a))
    const rect = candidates[0]
    if (!rect || candidates.slice(1).some((r) => intersection(r, rect) / area(r) < 0.95)) return
    result.push({
      caption: c,
      rect,
      graphicsCount: page.graphicsBounds.filter((g) => {
        const r = g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
        return intersection(r, rect) / area(r) > 0.95
      }).length
    })
  }
  return result
}

function continuesSideParagraph(line, bounds, paragraphs) {
  if (line.x + line.width > bounds[0] && line.x < bounds[2]) return false
  const left = line.x + line.width <= bounds[0]
  const runs = paragraphs.filter(
    (l) =>
      l.text.length >= 40 &&
      (left
        ? l.right <= bounds[0] && bounds[0] - l.right < 30
        : l.x >= bounds[2] && l.x - bounds[2] < 30)
  )
  return runs.some(
    (r) =>
      intersection(lineRect(line), [r.x, r.y, r.right, r.bottom]) > 0 &&
      runs.filter((n) => Math.abs(n.x - r.x) < 4 && Math.abs(n.y - r.y) < line.height * 4).length >=
        3
  )
}

// Keep detached diagram frames, while excluding proven inline and footer decorations.
function excludeDetachedDiagramDecorations(connected, diagramFrames, page) {
  if (diagramFrames.length < 3 || connected.some((g) => g.kind !== 'path')) return connected
  const pending = new Set(connected),
    components = []
  while (pending.size) {
    const first = pending.values().next().value
    pending.delete(first)
    const group = [first]
    connectFigureGraphics(group, pending)
    components.push(group)
  }
  const diagrams = components.filter(
    (group) =>
      diagramFrames.filter((r) => group.some((g) => intersection(g.rect, r) / area(r) > 0.95))
        .length >= 3
  )
  if (diagrams.length !== 1) return connected
  const decoration = (group) =>
    group !== diagrams[0] &&
    !diagramFrames.some((r) => group.some((g) => intersection(g.rect, r) / area(r) > 0.95)) &&
    group.every(
      (g) =>
        area(g.rect) < page.width * page.height * 0.001 &&
        // Isolated inline link decorations above the chart have text ownership,
        // not diagram connectivity. Do not drop detached scientific panels.
        (page.lines.some((l) => l.text.length >= 20 && intersection(lineRect(l), g.rect) > 0) ||
          (g.rect[1] > page.height * 0.9 &&
            page.lines.some(
              (l) =>
                /^\d+$/.test(l.text.trim()) &&
                l.y > page.height * 0.9 &&
                l.x >= g.rect[0] - 2 &&
                l.x + l.width <= g.rect[2] + 2 &&
                g.rect[1] >= l.y &&
                g.rect[1] - l.y - l.height < l.fontSize * 2 &&
                page.lines.some(
                  (other) =>
                    /^©/.test(other.text.trim()) && Math.abs(other.y - l.y) < l.fontSize * 2
                )
            )))
    )
  return components.filter((group) => !decoration(group)).flat()
}
