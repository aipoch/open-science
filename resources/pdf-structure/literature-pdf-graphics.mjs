/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { captionKind } from './literature-pdf-caption-group.mjs'
import { createHash } from 'node:crypto'
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'

// Locate small tables missed by the detector. The structure model still owns
// their cells: require a caption, enclosing rules and aligned numeric records.
export function findCaptionedNumericTableRegions(items, rules, detectedRects = []) {
  const regions = []
  const horizontal = rules.filter((r) => r[1] === r[3])
  for (const [left, top, right] of horizontal) {
    const groups = []
    for (const item of items
      .filter(
        (i) =>
          i.horizontal &&
          i.x >= left - 1 &&
          i.x + i.width <= right + 1 &&
          i.baseline - i.height > top &&
          i.baseline < top + i.height * 20
      )
      .sort((a, b) => a.baseline - b.baseline || a.x - b.x)) {
      const group = groups.find(
        (g) => Math.abs(g[0].baseline - item.baseline) < Math.max(g[0].height, item.height) * 0.35
      )
      if (group) group.push(item)
      else groups.push([item])
    }
    const caption = groups[0]
    if (
      !caption ||
      !/^Table\s+\d+[.:]\s+\p{L}/u.test(caption.map((i) => i.text).join(' ')) ||
      caption[0].baseline - top > caption[0].height * 3
    )
      continue
    const height = Math.max(...caption.map((i) => i.height)),
      captionBottom = Math.max(...caption.map((i) => i.baseline))
    for (const bottom of horizontal
      .filter(
        (r) =>
          r[1] > captionBottom &&
          r[1] - captionBottom < height * 20 &&
          Math.abs(r[0] - left) < height &&
          Math.abs(r[2] - right) < height
      )
      .map((r) => r[1])
      .sort((a, b) => a - b)) {
      const enclosed = groups.slice(1).filter((g) => g.every((i) => i.baseline <= bottom))
      const numeric = (g) =>
        g.length >= 4 &&
        /\p{L}/u.test(g[0].text) &&
        g.slice(1).every((i) => /^[<>≤≥−+-]?\d[\d.,()%±–−+\-/]*$/.test(i.text.trim()))
      const first = enclosed.findIndex(numeric)
      if (first < 1) continue
      const records = enclosed.slice(first),
        headings = enclosed.slice(0, first).flat()
      // An internal horizontal rule cannot end a table while another aligned
      // numeric record follows immediately below it.
      const following = groups.find((g) => g.every((i) => i.baseline > bottom))
      if (following && numeric(following) && following[0].baseline - bottom < height * 2.5) continue
      if (
        records.length < 2 ||
        records.some(
          (g) =>
            !numeric(g) ||
            g.length !== records[0].length ||
            g
              .slice(1)
              .some(
                (i, c) =>
                  Math.abs(i.x + i.width - records[0][c + 1].x - records[0][c + 1].width) >
                  height * 0.4
              )
        )
      )
        continue
      const centres = records[0].map((i) => i.x + i.width / 2)
      if (
        centres
          .slice(1)
          .some(
            (x, c) =>
              !headings.some(
                (i) =>
                  /\p{L}/u.test(i.text) &&
                  i.x + i.width / 2 > (centres[c] + x) / 2 &&
                  i.x + i.width / 2 < (centres[c + 2] ? (x + centres[c + 2]) / 2 : right)
              )
          )
      )
        continue
      const rect = [left, captionBottom + height * 0.6, right, bottom]
      if (
        ![...detectedRects, ...regions].some(
          (r) =>
            Math.max(0, Math.min(r[2], right) - Math.max(r[0], left)) *
              Math.max(0, Math.min(r[3], bottom) - Math.max(r[1], rect[1])) >
            (right - left) * (bottom - rect[1]) * 0.5
        )
      )
        regions.push(rect)
      break
    }
  }
  return regions
}

// Single-axis strokes and thin rectangular fills establish table borders.
// Bounding boxes of backgrounds, compound grids and curves are not cell edges.
export function collectTableRules(operators, viewport) {
  const fillThickness =
    1.1 *
    Math.max(
      Math.hypot(viewport.transform[0], viewport.transform[1]),
      Math.hypot(viewport.transform[2], viewport.transform[3])
    )
  let transform = [1, 0, 0, 1, 0, 0]
  const stack = [],
    rules = []
  for (const [i, op] of operators.fnArray.entries()) {
    const args = operators.argsArray[i]
    if (op === OPS.save) stack.push([...transform])
    else if (op === OPS.restore) transform = stack.pop() ?? [1, 0, 0, 1, 0, 0]
    else if (op === OPS.transform) transform = Util.transform(transform, args)
    else if (op === OPS.constructPath) {
      // PDF.js DrawOPS: exactly moveTo(x, y), lineTo(x, y); a compound path
      // can have gaps even when its bounding box looks like one continuous rule.
      const path = args[1]?.[0]
      if (args[1]?.length !== 1 || !path) continue
      // Publishers can batch disconnected rules into one stroke. Keep each
      // explicit move/line pair; the overall bounds must never bridge a gap.
      if (
        args[0] === OPS.stroke &&
        path.length > 6 &&
        path.length % 6 === 0 &&
        Array.from(path).every(
          (value, index) =>
            Number.isFinite(value) &&
            (index % 6 === 0 ? value === 0 : index % 6 === 3 ? value === 1 : true)
        )
      ) {
        const matrix = Util.transform(viewport.transform, transform)
        for (let offset = 0; offset < path.length; offset += 6) {
          const a = [path[offset + 1], path[offset + 2]],
            b = [path[offset + 4], path[offset + 5]]
          Util.applyTransform(a, matrix)
          Util.applyTransform(b, matrix)
          const width = Math.abs(a[0] - b[0]),
            height = Math.abs(a[1] - b[1])
          if (Math.min(width, height) <= 0.01 && Math.max(width, height) >= 4)
            rules.push([
              Math.min(a[0], b[0]),
              Math.min(a[1], b[1]),
              Math.max(a[0], b[0]),
              Math.max(a[1], b[1])
            ])
        }
        continue
      }
      const stroke = args[0] === OPS.stroke && path.length === 6 && path[0] === 0 && path[3] === 1
      const filled =
        [OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke].includes(args[0]) &&
        (path.length === 12 || (path.length === 13 && path[12] === 4)) &&
        path[0] === 0 &&
        [3, 6, 9].every((index) => path[index] === 1)
      if (!stroke && !filled) continue
      const box = args[2]
      if (!box || box.length !== 4 || !Array.from(box).every(Number.isFinite)) continue
      if (stroke && Math.min(Math.abs(box[2] - box[0]), Math.abs(box[3] - box[1])) > 0.01) continue
      const matrix = Util.transform(viewport.transform, transform)
      const points = filled
        ? [0, 3, 6, 9].map((index) => [path[index + 1], path[index + 2]])
        : [
            [box[0], box[1]],
            [box[2], box[3]]
          ]
      for (const point of points) Util.applyTransform(point, matrix)
      if (filled && new Set(points.map((point) => point.join(','))).size !== 4) continue
      if (
        filled &&
        points.some((point, index) => {
          const next = points[(index + 1) % points.length]
          return Math.min(Math.abs(point[0] - next[0]), Math.abs(point[1] - next[1])) > 0.01
        })
      )
        continue
      const rect = [
        Math.min(...points.map((p) => p[0])),
        Math.min(...points.map((p) => p[1])),
        Math.max(...points.map((p) => p[0])),
        Math.max(...points.map((p) => p[1]))
      ]
      if (
        Math.min(rect[2] - rect[0], rect[3] - rect[1]) <= (filled ? fillThickness : 0.01) &&
        Math.max(rect[2] - rect[0], rect[3] - rect[1]) >= 4
      ) {
        if (filled) {
          const axis = rect[2] - rect[0] > rect[3] - rect[1] ? 1 : 0
          rect[axis] = rect[axis + 2] = (rect[axis] + rect[axis + 2]) / 2
        }
        rules.push(rect)
      }
    }
  }
  return rules
}

// Publishers can paint footer lettering as paths, alternating left/right on facing pages.
// Match a compact repeated glyph pattern, allowing horizontal translation and one PDF.js
// quantization step. Raster bounds alone never establish equal image content.
export function excludeRepeatedMarginContent(pages) {
  const authorHeader = (text) => /^\d+\s+\p{L}[\p{L}\s.,-]+\bet al\.$/u.test(text)
  const headerText = (text) => (authorHeader(text) ? text.replace(/^\d+\s+/, '') : text)
  // Repeated running headers and vertical download notices can expand a figure crop.
  // Require margin geometry, repetition and separation from graphics; vertical notices
  // also need publication wording so rotated chart labels remain part of the figure.
  const notices = pages.flatMap((page, pageIndex) =>
    (page.lines ?? []).flatMap((line) => {
      const rect = [
        line.x / page.width,
        line.y / page.height,
        (line.x + line.width) / page.width,
        (line.y + line.height) / page.height
      ]
      const verticalNotice =
        line.height >= line.width * 4 &&
        (rect[0] >= 0.94 || rect[2] <= 0.06) &&
        /(?:first published|downloaded from|copyright|https?:\/\/)/i.test(line.text)
      const runningHeader =
        !captionKind(line.text) &&
        line.width > line.height * 2 &&
        line.height > 0 &&
        rect[3] <= (authorHeader(line.text) ? 0.1 : 0.07) &&
        rect[3] - rect[1] <= 0.03
      if (
        !(verticalNotice || runningHeader) ||
        (page.graphicsBounds ?? []).some(
          ({ kind, normalizedRect: r }) =>
            // A page background/border path is not evidence that a repeated
            // running header is a figure label. Real images remain protected.
            !(runningHeader && kind === 'path' && r[2] - r[0] >= 0.95 && r[3] - r[1] >= 0.95) &&
            r[0] < rect[2] &&
            r[2] > rect[0] &&
            r[1] < rect[3] &&
            r[3] > rect[1]
        )
      )
        return []
      return [{ pageIndex, line, rect }]
    })
  )
  const excludedLines = new Set(
    notices
      .filter((notice) =>
        notices.some(
          (other) =>
            notice.pageIndex !== other.pageIndex &&
            headerText(notice.line.text) === headerText(other.line.text) &&
            notice.rect.every((v, i) => Math.abs(v - other.rect[i]) <= 1 / 256)
        )
      )
      .map(({ line }) => line)
  )
  const marks = pages.flatMap((page, pageIndex) =>
    ['top', 'bottom'].flatMap((edge) => {
      const graphics = (page.graphicsBounds ?? []).filter(
        ({ kind, normalizedRect: r }) =>
          kind === 'path' && (edge === 'top' ? r[3] <= 0.07 : r[1] >= 0.93)
      )
      if (
        graphics.length < 6 ||
        graphics.some(({ normalizedRect: r }) => r[2] - r[0] > 0.03 || r[3] - r[1] > 0.03)
      )
        return []
      const rects = graphics.map((g) => g.normalizedRect).sort((a, b) => a[0] - b[0] || a[2] - b[2])
      const left = Math.min(...rects.map((r) => r[0]))
      if (
        Math.max(...rects.map((r) => r[2])) - left > 0.25 ||
        Math.max(...rects.map((r) => r[3])) - Math.min(...rects.map((r) => r[1])) > 0.03 ||
        new Set(rects.map((r) => r.join(','))).size < 3
      )
        return []
      return [
        {
          pageIndex,
          edge,
          graphics,
          pattern: rects.map((r) => r.map((v, i) => v - (i % 2 ? 0 : left)))
        }
      ]
    })
  )
  const excluded = new Set(
    marks
      .filter((mark) =>
        marks.some(
          (other) =>
            other.pageIndex !== mark.pageIndex &&
            other.edge === mark.edge &&
            other.pattern.length === mark.pattern.length &&
            mark.pattern.every((r, i) =>
              r.every((v, j) => Math.abs(v - other.pattern[i][j]) <= 1 / 256)
            )
        )
      )
      .flatMap((mark) => mark.graphics)
  )
  // Side banners repeated on several pages are publisher furniture. Require
  // matching path geometry and isolation from all raster content.
  const sideMarks = pages.flatMap((page, pageIndex) =>
    (page.graphicsBounds ?? [])
      .filter(
        ({ kind, normalizedRect: r }) =>
          kind === 'path' &&
          (r[2] <= 0.065 || r[0] >= 0.94) &&
          r[3] - r[1] >= 0.05 &&
          r[3] - r[1] <= 0.3 &&
          !(page.graphicsBounds ?? []).some(
            (g) =>
              g.kind === 'image' &&
              g.normalizedRect[0] < r[2] &&
              g.normalizedRect[2] > r[0] &&
              g.normalizedRect[1] < r[3] &&
              g.normalizedRect[3] > r[1]
          )
      )
      .map((graphic) => ({ pageIndex, graphic }))
  )
  for (const mark of sideMarks) {
    const page = pages[mark.pageIndex]
    const categoryBanners = sideMarks.filter(
      (other) =>
        other.pageIndex === mark.pageIndex &&
        (page.lines ?? []).some((line) => {
          const r = other.graphic.normalizedRect
          return (
            /^[A-Z][A-Z &-]+$/.test(line.text) &&
            line.height > line.width * 4 &&
            line.x >= r[0] * page.width &&
            line.x + line.width <= r[2] * page.width &&
            line.y >= r[1] * page.height &&
            line.y + line.height <= r[3] * page.height
          )
        })
    )
    // A batch may contain only one page carrying the category banners. Two
    // separate, vertically lettered outer-margin boxes establish local evidence.
    const pairedCategories =
      categoryBanners.some((other) => other.graphic === mark.graphic) &&
      categoryBanners.some(
        (other) =>
          other.graphic.normalizedRect[3] < mark.graphic.normalizedRect[1] ||
          other.graphic.normalizedRect[1] > mark.graphic.normalizedRect[3]
      )
    if (
      pairedCategories ||
      sideMarks.some(
        (other) =>
          other.pageIndex !== mark.pageIndex &&
          mark.graphic.normalizedRect.every(
            (v, i) => Math.abs(v - other.graphic.normalizedRect[i]) <= 1 / 256
          )
      )
    ) {
      excluded.add(mark.graphic)
      const r = mark.graphic.normalizedRect
      for (const line of page.lines ?? []) {
        if (
          line.height > line.width * 4 &&
          line.x >= r[0] * page.width &&
          line.x + line.width <= r[2] * page.width &&
          line.y >= r[1] * page.height &&
          line.y + line.height <= r[3] * page.height
        )
          excludedLines.add(line)
      }
    }
  }
  const marginRules = pages.flatMap((page, pageIndex) =>
    (page.graphicsBounds ?? [])
      .filter(
        ({ kind, normalizedRect: r }) =>
          kind === 'path' &&
          r[2] - r[0] >= 0.25 &&
          ((r[3] <= 0.07 && r[3] - r[1] <= 0.045) ||
            (r[1] >= 0.93 &&
              r[3] - r[1] <= 0.045 &&
              (page.lines ?? []).some(
                (l) =>
                  /©|copyright/i.test(l.text) &&
                  l.y + l.height >= r[1] * page.height &&
                  l.y <= r[3] * page.height
              )))
      )
      .map((graphic) => ({ pageIndex, graphic }))
  )
  for (const rule of marginRules) {
    const r = rule.graphic.normalizedRect
    if (
      marginRules.some((other) => {
        const b = other.graphic.normalizedRect
        return (
          other.pageIndex !== rule.pageIndex &&
          Math.abs(b[1] - r[1]) <= 1 / 256 &&
          Math.abs(b[3] - r[3]) <= 1 / 256 &&
          Math.abs(b[2] - b[0] - r[2] + r[0]) <= 1 / 256
        )
      })
    )
      excluded.add(rule.graphic)
  }
  // A decoded raster repeated behind dense prose is a publication background,
  // such as an ACCEPTED MANUSCRIPT watermark. Geometry alone cannot establish
  // this: the pixels must match on separate prose pages.
  // Some accepted manuscripts outline diagonal watermark lettering as paths.
  // Require at least twelve matching positions across three prose pages, then
  // a narrow descending diagonal. Repeated chart axes alone do not qualify.
  const watermarkPaths = pages.map((page) =>
    (page.graphicsBounds ?? []).filter((g) => {
      const r = g.normalizedRect
      return (
        g.kind === 'path' &&
        r[0] > 0.1 &&
        r[2] < 0.9 &&
        r[1] > 0.15 &&
        r[3] < 0.85 &&
        r[2] - r[0] > 0.015 &&
        r[2] - r[0] < 0.1 &&
        r[3] - r[1] > 0.015 &&
        r[3] - r[1] < 0.1 &&
        pages.filter(
          (p) =>
            (p.lines ?? []).filter((l) => l.text.length > 60).length >= 6 &&
            (p.graphicsBounds ?? []).some(
              (other) =>
                other.kind === 'path' &&
                other.normalizedRect.every((v, i) => Math.abs(v - r[i]) < 1 / 256)
            )
        ).length >= 3
      )
    })
  )
  for (const paths of watermarkPaths) {
    if (paths.length < 12) continue
    const centers = paths
      .map((g) => [
        (g.normalizedRect[0] + g.normalizedRect[2]) / 2,
        (g.normalizedRect[1] + g.normalizedRect[3]) / 2
      ])
      .sort((a, b) => a[0] - b[0])
    const first = centers[0],
      last = centers.at(-1),
      slope = (last[1] - first[1]) / (last[0] - first[0])
    if (
      last[0] - first[0] > 0.3 &&
      slope < -0.5 &&
      slope > -2 &&
      centers.every(([x, y]) => Math.abs(y - first[1] - slope * (x - first[0])) < 0.045)
    )
      for (const path of paths) excluded.add(path)
  }
  const backgrounds = pages.flatMap((page, pageIndex) =>
    (page.graphicsBounds ?? [])
      .filter((g) => {
        const r = g.normalizedRect
        return (
          g.kind === 'image' &&
          g.imageHash &&
          (r[2] - r[0]) * (r[3] - r[1]) > 0.25 &&
          ((page.lines ?? []).filter(
            (l) =>
              l.text.length > 80 &&
              l.y >= r[1] * page.height &&
              l.y + l.height <= r[3] * page.height
          ).length >= 5 ||
            (page.graphicsBounds ?? []).some((other) => {
              const b = other.normalizedRect
              return (
                other.kind === 'image' &&
                other.imageHash &&
                other.imageHash !== g.imageHash &&
                (b[2] - b[0]) * (b[3] - b[1]) > 0.1 &&
                Math.max(0, Math.min(b[2], r[2]) - Math.max(b[0], r[0])) *
                  Math.max(0, Math.min(b[3], r[3]) - Math.max(b[1], r[1])) >
                  Math.min((r[2] - r[0]) * (r[3] - r[1]), (b[2] - b[0]) * (b[3] - b[1])) * 0.8
              )
            }))
        )
      })
      .map((graphic) => ({ pageIndex, graphic }))
  )
  const backgroundHashes = new Set(
    backgrounds
      .filter((entry) =>
        backgrounds.some(
          (other) =>
            other.pageIndex !== entry.pageIndex &&
            other.graphic.imageHash === entry.graphic.imageHash &&
            other.graphic.normalizedRect.every(
              (v, i) => Math.abs(v - entry.graphic.normalizedRect[i]) <= 1 / 256
            )
        )
      )
      .map((entry) => entry.graphic.imageHash)
  )
  for (const page of pages)
    for (const graphic of page.graphicsBounds ?? []) {
      if (backgroundHashes.has(graphic.imageHash)) excluded.add(graphic)
    }
  const logos = pages.flatMap((page, pageIndex) =>
    (page.graphicsBounds ?? [])
      .filter(
        ({ kind, imageHash, normalizedRect: r }) =>
          kind === 'image' &&
          imageHash &&
          (r[3] <= 0.07 || r[1] >= 0.93) &&
          r[2] - r[0] <= 0.25 &&
          r[3] - r[1] <= 0.05 &&
          !(page.graphicsBounds ?? []).some(
            (other) =>
              !(
                other.kind === 'path' &&
                other.normalizedRect[2] - other.normalizedRect[0] >= 0.95 &&
                other.normalizedRect[3] - other.normalizedRect[1] >= 0.95
              ) &&
              other.normalizedRect[3] > 0.07 &&
              other.normalizedRect[1] < 0.93 &&
              other.normalizedRect[0] < r[2] &&
              other.normalizedRect[2] > r[0] &&
              Math.min(other.normalizedRect[3], r[3]) - Math.max(other.normalizedRect[1], r[1]) >
                1 / 256
          )
      )
      .map((graphic) => ({ pageIndex, graphic }))
  )
  for (const logo of logos) {
    if (
      logos.some(
        (other) =>
          other.pageIndex !== logo.pageIndex &&
          other.graphic.imageHash === logo.graphic.imageHash &&
          Math.abs(logo.graphic.normalizedRect[1] - other.graphic.normalizedRect[1]) <= 1 / 256 &&
          Math.abs(logo.graphic.normalizedRect[3] - other.graphic.normalizedRect[3]) <= 1 / 256
      )
    ) {
      const r = logo.graphic.normalizedRect
      // Raster logos often have duplicate path bounds or lettering painted on top.
      // Their repeated pixel hash establishes ownership of the whole small mark.
      for (const graphic of pages[logo.pageIndex].graphicsBounds) {
        const b = graphic.normalizedRect
        if (
          b[1] >= r[1] - 1 / 256 &&
          b[3] <= r[3] + 1 / 256 &&
          ((b[0] >= r[0] - 1 / 256 && b[2] <= r[2] + 1 / 256) ||
            (graphic.kind === 'path' &&
              b[0] <= r[0] &&
              b[2] >= r[2] &&
              b[2] - b[0] <= (r[2] - r[0]) * 1.5))
        )
          excluded.add(graphic)
      }
    }
  }
  // Some journals put a running rule below the header, beyond the narrow text
  // margin. Require repeated geometry and a separately confirmed running header.
  const runningRules = pages.flatMap((page, pageIndex) =>
    (page.graphicsBounds ?? [])
      .filter(
        ({ kind, normalizedRect: r }) =>
          kind === 'path' &&
          r[2] - r[0] >= 0.8 &&
          r[3] - r[1] <= 0.015 &&
          r[3] <= 0.15 &&
          page.lines?.some(
            (line) =>
              (excludedLines.has(line) ||
                [...excludedLines].some(
                  (other) =>
                    other.text === line.text &&
                    Math.abs(other.y - line.y) <= 1 &&
                    Math.abs(other.width - line.width) <= 1
                )) &&
              line.y + line.height < r[1] * page.height
          )
      )
      .map((graphic) => ({ pageIndex, graphic }))
  )
  for (const rule of runningRules) {
    if (
      runningRules.some(
        (other) =>
          other.pageIndex !== rule.pageIndex &&
          rule.graphic.normalizedRect.every(
            (v, i) => Math.abs(v - other.graphic.normalizedRect[i]) <= 1 / 256
          )
      )
    )
      excluded.add(rule.graphic)
  }
  return pages.map((page) => {
    const marginRuleBounds = (page.graphicsBounds ?? [])
      .filter(
        (g) =>
          excluded.has(g) &&
          g.kind === 'path' &&
          g.normalizedRect[2] - g.normalizedRect[0] >= 0.25 &&
          g.normalizedRect[3] - g.normalizedRect[1] <= 0.015
      )
      .map((g) => g.normalizedRect)
    return {
      ...page,
      // Association still needs these separators as barriers after they leave the
      // graphic set; deleting that evidence can turn distant rules into a figure.
      ...(marginRuleBounds.length ? { marginRuleBounds } : {}),
      ...(page.lines ? { lines: page.lines.filter((line) => !excludedLines.has(line)) } : {}),
      ...(page.graphicsBounds
        ? {
            graphicsBounds: page.graphicsBounds.filter((graphic) => !excluded.has(graphic))
          }
        : {})
    }
  })
}

export function collectGraphicsBounds(renderTask, boxes) {
  // PDF.js 5.4.624 getOperatorList() sets the OPLIST intent, disabling queue optimization.
  // recordedBBoxes uses the render stream, so indices from getOperatorList() are NOT compatible.
  // This version-pinned adapter is covered with a real optimized-image PDF regression.
  const operators = renderTask?._internalRenderTask?.operatorList
  assert(Array.isArray(operators?.fnArray) && boxes, 'PDF render geometry is unavailable.')
  const graphicsBounds = []
  const imageMasks = new Set()
  let invalidGraphicsBounds = 0
  for (const [index, operation] of operators.fnArray.entries()) {
    const image = [
      OPS.paintImageXObject,
      OPS.paintImageXObjectRepeat,
      OPS.paintInlineImageXObject,
      OPS.paintInlineImageXObjectGroup,
      OPS.paintImageMaskXObject,
      OPS.paintImageMaskXObjectGroup,
      OPS.paintImageMaskXObjectRepeat
    ].includes(operation)
    if ((!image && operation !== OPS.constructPath) || boxes.isEmpty(index)) continue
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
    // Compare decoded pixels, not per-page object IDs or bounding boxes. Hash
    // decoded images within a bounded budget, including manuscript watermarks.
    let imageHash
    if (image) {
      const source = operators.argsArray[index]?.[0]
      const task = renderTask._internalRenderTask
      const store =
        typeof source === 'string' && source.startsWith('g_') ? task.commonObjs : task.objs
      const decoded =
        typeof source === 'string' ? (store?.has(source) ? store.get(source) : undefined) : source
      if (
        (decoded?.data instanceof Uint8Array || decoded?.data instanceof Uint8ClampedArray) &&
        decoded.data.length <= 16_000_000
      ) {
        imageHash = createHash('sha256')
          .update(`${decoded.width}:${decoded.height}:${decoded.kind}:`)
          .update(decoded.data)
          .digest('hex')
      }
    }
    const graphic = {
      operationIndex: index,
      kind: image ? 'image' : 'path',
      normalizedRect,
      ...(imageHash ? { imageHash } : {})
    }
    graphicsBounds.push(graphic)
    if (
      [
        OPS.paintImageMaskXObject,
        OPS.paintImageMaskXObjectGroup,
        OPS.paintImageMaskXObjectRepeat
      ].includes(operation)
    )
      imageMasks.add(graphic)
  }
  return {
    graphicsBounds: graphicsBounds.filter((graphic) => {
      if (!imageMasks.has(graphic)) return true
      const r = graphic.normalizedRect
      // Thin mask strips are page decoration; near-identical image masks often
      // repaint an existing figure and must not change its ownership.
      if (r[2] - r[0] < 0.05 || r[3] - r[1] < 0.05) return false
      return !graphicsBounds.some((other) => {
        if (imageMasks.has(other)) return false
        const b = other.normalizedRect
        const intersection =
          Math.max(0, Math.min(r[2], b[2]) - Math.max(r[0], b[0])) *
          Math.max(0, Math.min(r[3], b[3]) - Math.max(r[1], b[1]))
        const union = (r[2] - r[0]) * (r[3] - r[1]) + (b[2] - b[0]) * (b[3] - b[1]) - intersection
        return intersection / union > 0.9
      })
    }),
    invalidGraphicsBounds
  }
}
