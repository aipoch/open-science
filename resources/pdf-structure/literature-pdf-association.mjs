/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Shared offline association; candidate geometry does not prove semantic correctness.
import assert from 'node:assert/strict'
import { connectFigureGraphics } from './literature-pdf-figure-connectivity.mjs'
import { captionKind, groupPageLines } from './literature-pdf-caption-group.mjs'

import { union, area, intersection, lineRect } from './literature-pdf-page-geometry.mjs'
import { associateTableNotes } from './literature-pdf-table-notes.mjs'

export function resolveFigureCaption(caption, candidates) {
  const direction =
    /see legend on (previous|next) page/i.exec(caption?.lines.join(' '))?.[1] ??
    (/^(?:Fig\.|Figure)\s*\d+\s*[:.]?\s*Continued\.?$/i.test(caption?.lines.join(' '))
      ? 'next'
      : undefined)
  const number = /^(?:Fig\.|Figure)\s*(\d+)\b/i.exec(caption?.lines[0])?.[1]
  if (!direction || !number) return caption
  const matches = candidates.filter(
    (other) =>
      Math.abs(other.page - caption.page) === 1 &&
      other.page === caption.page + (direction === 'previous' ? -1 : 1) &&
      /^(?:Fig\.|Figure)\s*(\d+)\b/i.exec(other.lines[0])?.[1] === number &&
      !/see legend on (?:previous|next) page/i.test(other.lines.join(' '))
  )
  if (matches.length === 1) return matches[0]
  // Printed previous/next pointers can be wrong after pages are reordered. Only
  // recover an unambiguous neighboring full legend with the exact same number.
  const adjacent = candidates.filter(
    (other) =>
      Math.abs(other.page - caption.page) === 1 &&
      /^(?:Fig\.|Figure)\s*(\d+)\b/i.exec(other.lines[0])?.[1] === number &&
      !/see legend on (?:previous|next) page/i.test(other.lines.join(' '))
  )
  return adjacent.length === 1 ? adjacent[0] : caption
}

// Nearby text may be the last/first line of body prose, not a chart label.
// Require three aligned prose lines outside the graphic, extending beyond the
// label search margin. Internal text and short/multiline chart titles stay intact.
const continuesExternalParagraph = (line, bounds, lines, minimumLineLength = 40) => {
  const above = line.y + line.height <= bounds[1]
  const below = line.y >= bounds[3]
  if (
    below &&
    /^(?:Conclusions?|Discussion|Results|Methods|Interventions?|Data collection|Acknowledgments?|References)$/i.test(
      line.text.trim()
    )
  ) {
    const paragraph = lines.find(
      (next) =>
        next.y >= line.y + line.height &&
        next.y - line.y - line.height <= line.height &&
        Math.abs(next.x - line.x) <= line.height * 2 &&
        next.text.length >= 40
    )
    if (paragraph && continuesExternalParagraph(paragraph, bounds, lines, minimumLineLength))
      return true
  }
  if ((!above && !below) || line.text.length < 20) return false
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
    if (line.y + line.height <= bounds[1]) rect[1] = Math.max(rect[1], line.y + line.height + 2)
    if (line.y >= bounds[3]) rect[3] = Math.min(rect[3], line.y - 2)
  }
  return rect
}

export function associateFigures(page, candidates, tableRects = [], rules = []) {
  // Zero-advance PDF tagging tokens have no painted extent.
  page = {
    ...page,
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
        const key = graphic.normalizedRect.join(',')
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
    }
  }
  // Recorded bounds are quantized outward and include stroke ink. Allow one
  // extra source pixel when a border sits immediately above its caption.
  const edgeTolerance = page.height / 256 + 1
  const pageCaptions = candidates.filter((c) => c.page === page.pageNumber)
  const captions = pageCaptions.filter(
    (c) => captionKind(c.lines[0]) === 'figure' && !/\(facing page\)/i.test(c.lines.join(' '))
  )
  if (!page.graphicsBounds)
    return captions.map((caption) => ({ caption, reason: 'graphics-not-recorded' }))
  assert(
    Number.isSafeInteger(page.invalidGraphicsBounds) && page.invalidGraphicsBounds >= 0,
    'Rerun the structure probe to record invalid graphics bounds explicitly.'
  )
  const marginal = associateMarginalFigurePlates(page, captions, tableRects)
  if (marginal) return marginal
  const standalone =
    associateRuledFigurePlate(page, pageCaptions, tableRects, rules) ??
    associateStandaloneFigurePlate(page, pageCaptions, tableRects)
  if (standalone) return [standalone]
  const assigned = captions.map(() => [])
  // A numbered running author head establishes a page-furniture band. Some
  // publisher logos extend slightly below the text baseline or closing rule.
  const numberedAuthorHead =
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
      page.lines.some((l) => l.y < page.height * 0.06 && /^\d+ of \d+$/.test(l.text.trim())))
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
  const runningHeaders = page.lines.filter(
    (line) =>
      line.y < page.height * 0.06 &&
      ((line.width > page.width * 0.8 &&
        /\bet al\./i.test(line.text) &&
        /\b(?:19|20)\d{2}\b/.test(line.text)) ||
        (line.width > page.width * 0.6 &&
          /\bet al\.?\s+\d+$/.test(line.text.trim()) &&
          Number(/\d+$/.exec(line.text.trim())?.[0]) === page.pageNumber) ||
        (splitHeader &&
          (line === splitHeader || line.x > page.width * 0.6) &&
          Math.abs(line.y - splitHeader.y) < Math.max(line.height, splitHeader.height) * 0.25))
  )
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
    page.lines.some(
      (tick) =>
        /^[−-]?\d+(?:\.\d+)?(?:\s+[−-]?\d+(?:\.\d+)?)*$/.test(tick.text.trim()) &&
        tick.y + tick.height <= line.y &&
        line.y - tick.y - tick.height <= line.fontSize * 2 &&
        tick.x >= line.x - 24 &&
        tick.x + tick.width <= line.x + line.width + 24
    ) &&
    page.graphicsBounds.some(
      (g) =>
        (g.kind === 'path' ||
          (g.kind === 'image' &&
            g.normalizedRect[0] * page.width < line.x + line.width &&
            g.normalizedRect[2] * page.width > line.x)) &&
        g.normalizedRect[1] * page.height < line.y &&
        line.y - g.normalizedRect[3] * page.height < line.fontSize * 5 &&
        (g.normalizedRect[2] - g.normalizedRect[0]) * page.width > 40 &&
        g.normalizedRect[3] * page.height <= line.y
    )
  const diagramFrames = page.graphicsBounds
    .filter((g) => g.kind === 'path' && area(g.normalizedRect) < 0.08)
    .map((g) => g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)))
    .filter(
      (r) =>
        r[3] - r[1] >= 12 &&
        r[2] - r[0] >= 30 &&
        r[1] < page.height * 0.9 &&
        !candidates.some((c) => c.page === page.pageNumber && intersection(c.rect, r) > 0) &&
        page.lines.some((line) => intersection(lineRect(line), r) / area(lineRect(line)) > 0.8)
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
    diagramFrames.some((r) => intersection(lineRect(line), r) / area(lineRect(line)) > 0.8)
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
  const barriers = page.lines.filter(
    (l) => l.text.length > 80 && !axisTitle(l) && !figureNotes.has(l)
  )
  const pathBarriers = page.lines.filter(
    (l) => l.text.length > 60 && !axisTitle(l) && !figureNotes.has(l) && !framedDiagramText(l)
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
  // Match both caption directions; intervening prose/captions block association.
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
      graphic.normalizedRect[1] <= 0.01 &&
      graphic.normalizedRect[3] >= 0.99 &&
      (graphic.normalizedRect[2] <= 0.06 || graphic.normalizedRect[0] >= 0.94)
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
      rasterPlates.some((plate) => plate[3] < rect[1] - 24) &&
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
    // Text-column frames and clipping paths can enclose entire prose blocks.
    if (
      graphic.kind === 'path' &&
      !captions.some(
        (c) =>
          /\b(?:flowchart|flow diagram|schema)\b/i.test(c.lines.join(' ')) &&
          rect[2] - rect[0] > page.width * 0.5 &&
          c.rect[1] >= rect[3] &&
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
    if (rect[3] < page.height * (numberedAuthorHead ? 0.065 : 0.055)) continue
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
          side && horizontalGap <= (framedSide ? page.width * 0.25 : 60) && verticalGap <= 120
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
          /\bContinued\.?$/i.test(caption.lines.join(' ')) &&
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
        if (beside && !vertical) {
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
                !pageCaptions.some((other) => intersection(other.rect, lineRect(l)) > 0)
            )
          return {
            caption,
            index,
            side,
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
        priority:
          // The inverse layout uses legends above both plates. An immediate
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
    assigned[eligible[0].index].push({ rect, side: eligible[0].side, kind: graphic.kind })
  }
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
  return captions.map((caption, index) => {
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
    const plates = assigned[index].filter((item) => item.kind === 'image')
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
      plates.length
        ? assigned[index].filter(
            (item) =>
              item.kind === 'path' &&
              !retained.has(item) &&
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
      /\b(?:CONSORT|flowchart|flow diagram|patient flow)\b/i.test(caption.lines.join(' ')) &&
      connected.length &&
      connected.every((item) => item.kind === 'path') &&
      diagramFrames.length >= 3
    ) {
      const seed = connected.find((item) => item.side && area(item.rect) > 144)
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
        connectFigureGraphics(component, new Set(paths.filter((g) => !sameRect(g, seed))))
        if (
          connected.every((g) => component.some((other) => sameRect(g, other))) &&
          diagramFrames.filter((r) =>
            component.some((g) => intersection(r, g.rect) / area(r) > 0.95)
          ).length >= 3
        )
          connected = component.map((g) => ({ ...g, side: seed.side }))
      }
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
    // Border rules below a caption are not a second figure. Evaluate extent per direction,
    // retaining thin axes when they belong to a larger figure on that same side.
    const directions = Map.groupBy(
      connected,
      (item) => item.side ?? (item.rect[1] < caption.rect[1] ? 'above' : 'below')
    )
    const meaningful = [...directions.values()]
      .filter((items) => {
        // Disconnected tiny marks do not form a large panel merely because
        // their union spans a paragraph. Keep axes inside a substantial plate.
        if (
          !items.some(
            (item) => item.rect[2] - item.rect[0] >= 12 && item.rect[3] - item.rect[1] >= 12
          )
        ) {
          // Legacy PDFs may encode a plate as hundreds of raster scan strips.
          // Require continuous vertical coverage and overlapping horizontal ink;
          // disconnected marks and vector paragraph rules remain excluded.
          const strips = items
            .filter((item) => item.kind === 'image')
            .sort((a, b) => a.rect[1] - b.rect[1])
          if (
            strips.length < 20 ||
            area(union(strips.map((g) => g.rect))) < page.width * page.height * 0.03 ||
            strips.some(
              (g, n) =>
                n &&
                (g.rect[1] > strips[n - 1].rect[3] + edgeTolerance ||
                  Math.min(g.rect[2], strips[n - 1].rect[2]) <=
                    Math.max(g.rect[0], strips[n - 1].rect[0]))
            )
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
    const graphics = meaningful.map((item) => item.rect)
    const sides = new Set(meaningful.map((item) => item.side))
    if (sides.size > 1) return { caption, reason: 'ambiguous-graphic-direction' }
    const side = sides.size === 1 ? meaningful[0]?.side : undefined
    if (!graphics.length) return { caption, reason: 'no-unambiguous-adjacent-graphics' }
    if (
      !side &&
      graphics.some((rect) => rect[3] <= caption.rect[1] + edgeTolerance) &&
      graphics.some((rect) => rect[1] >= caption.rect[3] - edgeTolerance)
    )
      return { caption, reason: 'ambiguous-graphic-direction' }
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
    if (side && meaningful.every((g) => g.kind === 'path')) {
      const outlined = page.graphicsBounds
        .filter((g) => g.kind === 'path')
        .map((g) => g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)))
        .filter(
          (r) =>
            r[2] - r[0] <= 12 &&
            r[3] - r[1] <= 12 &&
            !(numberedAuthorHead && r[3] < page.height * 0.065) &&
            r[0] >= bounds[0] - 32 &&
            r[2] <= bounds[2] + 32 &&
            r[1] >= bounds[1] - 24 &&
            r[3] <= bounds[3] + 32 &&
            !pageCaptions.some((c) => intersection(c.rect, r) > 0) &&
            !tableRects.some((t) => intersection(t, r) > 0)
        )
      if (outlined.length >= 6) {
        const extended = union([bounds, ...outlined])
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
        (/^(?:No\.?|Number)(?: of(?: patients| subjects)?)? at risk\b/i.test(line.text.trim()) ||
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
        below &&
        line.x >= bounds[0] - 100 &&
        line.x + line.width <= bounds[2] &&
        graphics.some((r) => line.y >= r[3] - 12 && line.y - r[3] <= 36)
    )
    for (const label of riskLabels) {
      const rows = page.lines.filter(
        (line) =>
          line.y > label.y &&
          line.y + line.height < caption.rect[1] - 2 &&
          line.y - label.y < 64 &&
          line.x >= Math.max(caption.rect[0] - 4, label.x - 120) &&
          line.x + line.width <= bounds[2] + 12 &&
          line.height <= 12 &&
          Math.abs(line.fontSize - label.fontSize) <= 0.5 &&
          line.text.replace(/[\d\s.,:−-]/g, '').length < 20 &&
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
    const paragraphRuns =
      plates.length &&
      page.lines.every((l) => [l.x, l.y, l.width, l.height, l.fontSize].every(Number.isFinite))
        ? groupPageLines(page)
        : []
    const nearby = page.lines.filter(
      (l) =>
        !runningHeaders.includes(l) &&
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
    for (const line of page.lines) {
      if (
        nearby.includes(line) ||
        line.text.length > 30 ||
        line.width > line.fontSize * 7 ||
        line.y < bounds[1] ||
        line.y + line.height > bounds[3] ||
        line.x > bounds[2] + 12 ||
        line.x + line.width > bounds[2] + line.fontSize * 7 ||
        pageCaptions.some((c) => intersection(c.rect, lineRect(line)) > 0)
      )
        continue
      if (
        nearby.some(
          (other) =>
            other.text.length < 30 &&
            other.x >= bounds[2] - 24 &&
            Math.abs(other.x - line.x) < 1 &&
            Math.abs(other.fontSize - line.fontSize) < 0.5 &&
            Math.abs(other.y - line.y) > line.height &&
            Math.abs(other.y - line.y) < line.height * 1.8
        )
      )
        nearby.push(line)
    }
    if (diagramFrames.length >= 3) {
      const titles = page.lines.filter(
        (line) =>
          /^(?:CONSORT(?: \d{4})? )?Flow Diagram$/i.test(line.text.trim()) &&
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
            line.text.length > 40
        )
      )
        nearby.push(titles[0])
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
        line.y < bounds[1] ||
        line.y + line.height > bounds[3] ||
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
    const rect = boundByExternalParagraphs(
      union([bounds, ...nearby.map(lineRect)]),
      bounds,
      page.lines
    )
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
    return { caption, rect, graphicsCount: graphics.length }
  })
}

// Conservative adjacent-page fallback for one large recorded graphic.
// A labelled table can contain a vector forest plot rather than a cell grid.
// Preserve that graphic as an image-only table when cell detection has no result.
export function associateGraphicalTables(page, candidates, tableRects = [], emptyDetections = []) {
  const tables = candidates.filter(
    (c) => c.page === page.pageNumber && captionKind(c.lines[0]) === 'table'
  )
  return tables.flatMap((caption) => {
    if (
      tableRects.some(
        (r) => Math.min(Math.abs(r[1] - caption.rect[3]), Math.abs(caption.rect[1] - r[3])) < 60
      )
    )
      return []
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
    return [{ ...match, caption }]
  })
}

// Conservative adjacent-page fallback for one large recorded graphic.
export function associateAdjacentFigure(page, pages, candidates) {
  // Only a caption-free, figure-dominated page can consume a neighboring caption.
  // Smaller or multiple unlabelled figures need a layout model; do not guess their ownership.
  if (page.rotation !== 0 || candidates.some((c) => c.page === page.pageNumber)) return []
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
  const nearby = page.lines.filter(
    (line) =>
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

// Labelled pseudocode uses rules and indentation, not a rectangular cell grid.
// Keep its original image until a symbolic parser can preserve the mathematics.
export function findAlgorithmCandidates(page) {
  const lines = groupPageLines(page)
  const titles = lines.filter((line) => /^Algorithm\s+\d+\b/i.test(line.text))
  const rules = (page.graphicsBounds ?? [])
    .filter((graphic) => graphic.kind === 'path')
    .map((graphic) => graphic.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)))
    .filter((r) => r[3] - r[1] <= page.height / 64 && r[2] - r[0] > (r[3] - r[1]) * 15)
  return titles.flatMap((title) => {
    const aligned = rules.filter((r) => Math.abs(r[0] - title.x) <= 8 && r[2] >= title.right - 4)
    const top = aligned
      .filter((r) => Math.abs(r[1] - title.y) <= title.fontSize)
      .sort((a, b) => Math.abs(a[1] - title.y) - Math.abs(b[1] - title.y))[0]
    if (!top) return []
    const nextTitle = titles.find((line) => line.y > title.y && Math.abs(line.x - title.x) <= 8)
    const bottom = aligned
      .filter(
        (r) =>
          r[1] > title.bottom + title.fontSize * 4 &&
          r[1] < (nextTitle?.y ?? page.height) &&
          Math.abs(r[2] - top[2]) <= 8
      )
      .sort((a, b) => a[1] - b[1])[0]
    if (!bottom) return []
    const content = lines.filter(
      (line) =>
        line.y > title.y &&
        line.bottom <= bottom[3] &&
        line.x >= top[0] - 4 &&
        line.right <= top[2] + 4
    )
    if (
      !content.some((line) => /^(?:Require|Ensure|Input|Output)\s*:/i.test(line.text)) ||
      content.filter((line) => /^\d+\s*:/.test(line.text)).length < 2
    )
      return []
    return [
      {
        caption: {
          page: page.pageNumber,
          lines: [title.text],
          rect: [title.x, title.y, title.right, title.bottom]
        },
        rect: [
          Math.max(0, top[0] - 2),
          Math.max(0, Math.min(top[1], title.y) - 2),
          Math.min(page.width, top[2] + 2),
          Math.min(page.height, bottom[3] + 2)
        ]
      }
    ]
  })
}

// Local table-caption matching in the same scale-1 displayed viewport. Keep uncertain ownership absent.
export function associateTableCaptions(page, tables, candidates, rules = []) {
  const captions = candidates.filter(
    (c) => c.page === page.pageNumber && captionKind(c.lines[0]) === 'table'
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
        // A predicted crop may overlap only the bottom of an above-table title.
        // A full-width source rule below the title distinguishes crop padding
        // from a caption embedded in the data region.
        const paddedTitle =
          c[1] < rect[1] &&
          c[3] > rect[1] &&
          c[3] - rect[1] <= (c[3] - c[1]) * 0.35 &&
          rules.some(
            (r) =>
              r[1] === r[3] &&
              r[1] >= c[3] &&
              r[1] - c[3] <= 12 &&
              Math.abs(r[0] - rect[0]) <= 6 &&
              Math.abs(r[2] - rect[2]) <= 6
          )
        const gap = paddedTitle
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
        return { caption, gap, overlap, blocked, ruledFooter }
      })
      .filter(
        ({ caption, gap, overlap, blocked, ruledFooter }) =>
          gap >= 0 &&
          (ruledFooter ||
            gap <= 60 ||
            (tables.length === 1 && captions.length === 1 && gap <= page.height * 0.2)) &&
          (ruledFooter || !blocked) &&
          overlap / Math.min(rect[2] - rect[0], caption.rect[2] - caption.rect[0]) >= 0.5
      )
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
  if (
    tables.length > 1 &&
    captions.length === tables.length &&
    above.every((matches) => matches.length === 1) &&
    new Set(above.map((matches) => matches[0].caption)).size === tables.length &&
    !choices.some((matches) => matches.some((m) => m.ruledFooter)) &&
    tables.every(
      ({ rect }) =>
        (Math.min(rect[2], tables[0].rect[2]) - Math.max(rect[0], tables[0].rect[0])) /
          Math.min(rect[2] - rect[0], tables[0].rect[2] - tables[0].rect[0]) >=
        0.7
    )
  )
    return above.map((matches) => ({ caption: matches[0].caption }))
  return choices.map((matches, index) => {
    if (!matches.length) return { reason: 'no-adjacent-table-caption' }
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
    return { caption: best.caption }
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
function associateMarginalFigurePlates(page, captions, tableRects) {
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
