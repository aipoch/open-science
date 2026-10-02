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
    // Some publishers place the caption above the opening rule, followed by
    // several header bands. Require the same enclosing geometry and records.
    const above = items.filter(
      (i) =>
        i.horizontal &&
        i.x >= left - 1 &&
        i.x + i.width <= right + 1 &&
        i.baseline < top &&
        top - i.baseline < i.height * 3 &&
        /^Table\s+\d+(?:[.:]|\s)\s*\p{L}/u.test(i.text)
    )
    const captionAbove = above.length === 1
    const caption = captionAbove ? above : groups[0]
    if (
      !caption ||
      (!captionAbove && !/^Table\s+\d+[.:]\s+\p{L}/u.test(caption.map((i) => i.text).join(' '))) ||
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
      const enclosed = groups
        .slice(captionAbove ? 0 : 1)
        .filter((g) => g.every((i) => i.baseline <= bottom))
      if (captionAbove) enclosed.forEach((g) => g.sort((a, b) => a.x - b.x))
      const numeric = (g) =>
        g.length >= 4 &&
        /\p{L}/u.test(g[0].text) &&
        g
          .slice(1)
          .every((i) =>
            /^[<>≤≥−+-]?\d[\d.,()%±–−+\-/]*$/.test(
              captionAbove ? i.text.replace(/\s/g, '') : i.text.trim()
            )
          )
      const first = enclosed.findIndex(numeric)
      if (first < (captionAbove ? 2 : 1)) continue
      const records = enclosed.slice(first),
        headings = enclosed.slice(0, first).flat()
      // An internal horizontal rule cannot end a table while another aligned
      // numeric record follows immediately below it.
      const following = groups.find((g) => g.every((i) => i.baseline > bottom))
      if (following && numeric(following) && following[0].baseline - bottom < height * 2.5) continue
      const longest = records.reduce((a, b) => (a.length >= b.length ? a : b), [])
      if (captionAbove) {
        // A final probability field may be shared or blank. Every occupied
        // field must still have a header and a consistent alignment anchor.
        if (
          records.length < 3 ||
          longest.length < 7 ||
          records.some((g) => !numeric(g) || longest.length - g.length > 1)
        )
          continue
        if (
          longest.slice(1).some(
            (_, c) =>
              ![0, 0.5, 1].some((anchor) => {
                const positions = records
                  .filter((g) => g[c + 1])
                  .map((g) => g[c + 1].x + g[c + 1].width * anchor)
                return Math.max(...positions) - Math.min(...positions) < height * 0.5
              })
          )
        )
          continue
      } else if (
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
      const centres = (captionAbove ? longest : records[0]).map((i) => i.x + i.width / 2)
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
      const rect = [left, captionAbove ? top : captionBottom + height * 0.6, right, bottom]
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
// Keep closed stroke rectangles separate from table-rule discovery: a path's
// bounding box does not prove four edges. Only explicit four-corner polygons
// with a closePath and axis-aligned transformed edges establish a figure frame.
export function collectClosedFigureFrames(operators, viewport) {
  let transform = [1, 0, 0, 1, 0, 0]
  const stack = [],
    frames = []
  for (const [i, op] of operators.fnArray.entries()) {
    const args = operators.argsArray[i]
    if (op === OPS.save) stack.push([...transform])
    else if (op === OPS.restore) transform = stack.pop() ?? [1, 0, 0, 1, 0, 0]
    else if (op === OPS.transform) transform = Util.transform(transform, args)
    else if (op === OPS.constructPath && args[0] === OPS.stroke && args[1]?.length === 1) {
      const nativePath = args[1][0]
      if (
        !Array.isArray(nativePath) &&
        !(ArrayBuffer.isView(nativePath) && typeof nativePath.length === 'number')
      )
        continue
      const path = Array.from(nativePath)
      const polygon = path.slice(-13),
        prefix = path.slice(0, -13)
      if (
        polygon.length !== 13 ||
        polygon[12] !== 4 ||
        polygon[0] !== 0 ||
        ![3, 6, 9].every((n) => polygon[n] === 1) ||
        prefix.length % 3 !== 0 ||
        prefix.some((v, n) => n % 3 === 0 && v !== 0) ||
        !path.every(Number.isFinite)
      )
        continue
      const points = [0, 3, 6, 9].map((n) => [polygon[n + 1], polygon[n + 2]])
      const matrix = Util.transform(viewport.transform, transform)
      for (const point of points) Util.applyTransform(point, matrix)
      if (
        new Set(points.map((p) => p.join(','))).size !== 4 ||
        points.some((p, n) => {
          const q = points[(n + 1) % 4]
          return (
            Math.min(Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1])) > 0.01 ||
            Math.max(Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1])) < 4
          )
        })
      )
        continue
      frames.push([
        Math.min(...points.map((p) => p[0])),
        Math.min(...points.map((p) => p[1])),
        Math.max(...points.map((p) => p[0])),
        Math.max(...points.map((p) => p[1]))
      ])
    }
  }
  return frames
}

export function collectTableRules(operators, viewport, rulePaintBounds) {
  const fillThickness =
    1.1 *
    Math.max(
      Math.hypot(viewport.transform[0], viewport.transform[1]),
      Math.hypot(viewport.transform[2], viewport.transform[3])
    )
  let transform = [1, 0, 0, 1, 0, 0],
    lineWidth = 1,
    lineCap = 0,
    solidStroke = true,
    unprovedClip = false
  const stack = [],
    rules = [],
    unknownPaint = new Set()
  // The public rules retain their original center lines. This optional private
  // map records only paint proved by native state and an axis-aligned transform.
  const rememberPaint = (rule, bounds) => {
    if (!rulePaintBounds) return
    const key = rule.join(',')
    if (
      !bounds ||
      unprovedClip ||
      !bounds.every(Number.isFinite) ||
      ((viewport.width !== undefined || viewport.height !== undefined) &&
        (!Number.isFinite(viewport.width) ||
          !Number.isFinite(viewport.height) ||
          viewport.width <= 0 ||
          viewport.height <= 0 ||
          bounds[0] < 0 ||
          bounds[1] < 0 ||
          bounds[2] > viewport.width ||
          bounds[3] > viewport.height))
    ) {
      rulePaintBounds.delete(key)
      unknownPaint.add(key)
      return
    }
    if (unknownPaint.has(key)) return
    const previous = rulePaintBounds.get(key)
    rulePaintBounds.set(
      key,
      previous
        ? [
            Math.min(previous[0], bounds[0]),
            Math.min(previous[1], bounds[1]),
            Math.max(previous[2], bounds[2]),
            Math.max(previous[3], bounds[3])
          ]
        : bounds
    )
  }
  const strokePaint = (rule, matrix, startCap = true, endCap = true) => {
    if (
      !solidStroke ||
      !Number.isFinite(lineWidth) ||
      lineWidth <= 0 ||
      ![0, 1, 2].includes(lineCap) ||
      !matrix.every(Number.isFinite) ||
      !rule.every(Number.isFinite)
    )
      return
    const aligned = matrix[1] === 0 && matrix[2] === 0,
      quarterTurn = matrix[0] === 0 && matrix[3] === 0
    if (!aligned && !quarterTurn) return
    const scaleX = Math.hypot(matrix[0], matrix[2]),
      scaleY = Math.hypot(matrix[1], matrix[3]),
      horizontal = rule[1] === rule[3],
      vertical = rule[0] === rule[2]
    if (!scaleX || !scaleY || horizontal === vertical) return
    const radiusX = (lineWidth * scaleX) / 2,
      radiusY = (lineWidth * scaleY) / 2,
      cap = lineCap !== 0
    return [
      rule[0] - (vertical || (cap && startCap) ? radiusX : 0),
      rule[1] - (horizontal || (cap && startCap) ? radiusY : 0),
      rule[2] + (vertical || (cap && endCap) ? radiusX : 0),
      rule[3] + (horizontal || (cap && endCap) ? radiusY : 0)
    ]
  }
  for (const [i, op] of operators.fnArray.entries()) {
    const args = operators.argsArray[i]
    if (op === OPS.save)
      stack.push({ transform: [...transform], lineWidth, lineCap, solidStroke, unprovedClip })
    else if (op === OPS.restore) {
      const state = stack.pop()
      transform = state?.transform ?? [1, 0, 0, 1, 0, 0]
      lineWidth = state ? state.lineWidth : 1
      lineCap = state ? state.lineCap : 0
      solidStroke = state ? state.solidStroke : true
      unprovedClip = state ? state.unprovedClip : false
    } else if (op === OPS.transform) transform = Util.transform(transform, args)
    else if (op === OPS.setLineWidth) lineWidth = args[0]
    else if (op === OPS.setLineCap) lineCap = args[0]
    else if (op === OPS.setDash) solidStroke = Array.isArray(args[0]) && args[0].length === 0
    else if (op === OPS.clip || op === OPS.eoClip) unprovedClip = true
    else if (op === OPS.setGState) {
      if (!Array.isArray(args[0])) {
        lineWidth = NaN
        lineCap = NaN
        solidStroke = false
      } else {
        for (const entry of args[0]) {
          if (!Array.isArray(entry)) {
            lineWidth = NaN
            lineCap = NaN
            solidStroke = false
          } else if (entry[0] === 'LW') lineWidth = entry[1]
          else if (entry[0] === 'LC') lineCap = entry[1]
          else if (entry[0] === 'D')
            solidStroke = Array.isArray(entry[1]?.[0]) && entry[1][0].length === 0
        }
      }
    } else if (op === OPS.constructPath) {
      if (args[0] === OPS.clip || args[0] === OPS.eoClip) unprovedClip = true
      // PDF.js DrawOPS: exactly moveTo(x, y), lineTo(x, y); a compound path
      // can have gaps even when its bounding box looks like one continuous rule.
      const path = args[1]?.[0]
      if (args[1]?.length !== 1 || !path) continue
      // A continuous same-axis polyline retains each painted segment. Prove
      // one move, only line commands, monotonic transformed points and no
      // repeated point; compound boxes, branches and curves stay ineligible.
      if (
        args[0] === OPS.stroke &&
        path.length >= 9 &&
        path.length % 3 === 0 &&
        Array.from(path).every((v, n) => Number.isFinite(v) && (n % 3 !== 0 || v === (n ? 1 : 0)))
      ) {
        const matrix = Util.transform(viewport.transform, transform)
        const points = Array.from({ length: path.length / 3 }, (_, n) => [
          path[n * 3 + 1],
          path[n * 3 + 2]
        ])
        for (const point of points) Util.applyTransform(point, matrix)
        const axis = points.every((p) => Math.abs(p[1] - points[0][1]) <= 0.01)
          ? 0
          : points.every((p) => Math.abs(p[0] - points[0][0]) <= 0.01)
            ? 1
            : undefined
        if (axis !== undefined) {
          const direction = Math.sign(points.at(-1)[axis] - points[0][axis])
          if (
            direction &&
            points.slice(1).every((p, n) => (p[axis] - points[n][axis]) * direction >= 4)
          ) {
            for (const [n, p] of points.slice(1).entries()) {
              const a = points[n]
              const rule = [
                Math.min(a[0], p[0]),
                Math.min(a[1], p[1]),
                Math.max(a[0], p[0]),
                Math.max(a[1], p[1])
              ]
              rules.push(rule)
              const forward = direction > 0
              rememberPaint(
                rule,
                strokePaint(
                  rule,
                  matrix,
                  forward ? n === 0 : n === points.length - 2,
                  forward ? n === points.length - 2 : n === 0
                )
              )
            }
          }
        }
        continue
      }
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
          if (Math.min(width, height) <= 0.01 && Math.max(width, height) >= 4) {
            const rule = [
              Math.min(a[0], b[0]),
              Math.min(a[1], b[1]),
              Math.max(a[0], b[0]),
              Math.max(a[1], b[1])
            ]
            rules.push(rule)
            rememberPaint(rule, strokePaint(rule, matrix))
          }
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
          const dx = Math.abs(point[0] - next[0]),
            dy = Math.abs(point[1] - next[1])
          // Filled table rules can have beveled ends. Only a short end edge
          // may be diagonal; a slanted long edge is not an axis-aligned rule.
          return (
            Math.min(dx, dy) > 0.01 &&
            (Math.max(dx, dy) > fillThickness || Math.abs(dx - dy) > 0.01)
          )
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
        const strokePoints = stroke
          ? [
              [path[1], path[2]],
              [path[4], path[5]]
            ]
          : []
        for (const point of strokePoints) Util.applyTransform(point, matrix)
        const ownsStroke =
          stroke &&
          Array.from(path).every(Number.isFinite) &&
          [
            Math.min(...strokePoints.map((p) => p[0])),
            Math.min(...strokePoints.map((p) => p[1])),
            Math.max(...strokePoints.map((p) => p[0])),
            Math.max(...strokePoints.map((p) => p[1]))
          ].every((value, index) => value === rect[index])
        const paint = filled
          ? [OPS.fill, OPS.eoFill].includes(args[0])
            ? [...rect]
            : undefined
          : ownsStroke
            ? strokePaint(rect, matrix)
            : undefined
        if (filled) {
          const axis = rect[2] - rect[0] > rect[3] - rect[1] ? 1 : 0
          rect[axis] = rect[axis + 2] = (rect[axis] + rect[axis + 2]) / 2
        }
        rules.push(rect)
        rememberPaint(rect, paint)
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
            // Quantized separator strokes can touch the top of the header's
            // font box. A long thin rule is not an enclosing body graphic.
            !(
              runningHeader &&
              kind === 'path' &&
              r[2] - r[0] >= 0.5 &&
              r[3] - r[1] <= 0.01 &&
              r[3] <= rect[1] + (rect[3] - rect[1]) * 0.3
            ) &&
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
  for (const page of pages)
    for (const line of page.lines ?? []) {
      if (
        line.height < line.width * 4 ||
        !/publishing|copyright|©/i.test(line.text) ||
        !((line.x + line.width) / page.width <= 0.06 || line.x / page.width >= 0.94)
      )
        continue
      if (
        page.lines.some(
          (other) =>
            excludedLines.has(other) &&
            other.height > other.width * 4 &&
            Math.abs(other.x - line.x) < line.fontSize &&
            Math.min(
              Math.abs(line.y - other.y - other.height),
              Math.abs(other.y - line.y - line.height)
            ) <
              line.fontSize * 2
        )
      )
        excludedLines.add(line)
    }
  // A repeated, oversized diagonal publication watermark is not a figure
  // label. Require publication wording plus the same text/geometry on three
  // pages; preserve ordinary rotated axes and one-off annotations.
  for (const page of pages)
    for (const line of page.lines ?? []) {
      if (
        !/^(?:Accepted Manuscript|Uncorrected Proof)$/i.test(line.text.trim()) ||
        line.fontSize < page.height * 0.04 ||
        line.height < line.fontSize * 3
      )
        continue
      if (
        pages.filter((other) =>
          other.lines?.some(
            (l) =>
              l.text === line.text &&
              Math.abs(l.x / other.width - line.x / page.width) < 1 / 256 &&
              Math.abs(l.y / other.height - line.y / page.height) < 1 / 256 &&
              Math.abs(l.height / other.height - line.height / page.height) < 1 / 256
          )
        ).length >= 3
      )
        excludedLines.add(line)
    }
  const marks = pages.flatMap((page, pageIndex) =>
    ['top', 'bottom'].flatMap((edge) => {
      const graphics = (page.graphicsBounds ?? []).filter(
        ({ kind, normalizedRect: r }) =>
          kind === 'path' && (edge === 'top' ? r[3] <= 0.07 : r[1] >= 0.92)
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
  // Filled running bands enclose their own native text, so the ordinary
  // no-overlap header test cannot identify them. Require three matching pages,
  // a repeated non-caption label inside the band, and no raster ownership.
  const runningBands = pages.flatMap((page, pageIndex) =>
    (page.graphicsBounds ?? [])
      .filter(
        ({ kind, normalizedRect: r }) =>
          kind === 'path' &&
          r[2] - r[0] > 0.5 &&
          r[3] - r[1] < 0.035 &&
          (r[3] < 0.08 || r[1] > 0.91) &&
          !(page.graphicsBounds ?? []).some(
            (g) =>
              g.kind === 'image' &&
              g.normalizedRect[0] < r[2] &&
              g.normalizedRect[2] > r[0] &&
              g.normalizedRect[1] < r[3] &&
              g.normalizedRect[3] > r[1]
          )
      )
      .map((graphic) => ({
        pageIndex,
        graphic,
        labels: (page.lines ?? []).filter(
          (l) =>
            l.text.length > 5 &&
            !captionKind(l.text) &&
            l.x / page.width >= graphic.normalizedRect[0] - 1 / 256 &&
            (l.x + l.width) / page.width <= graphic.normalizedRect[2] + 1 / 256 &&
            l.y / page.height >= graphic.normalizedRect[1] - 1 / 256 &&
            (l.y + l.height) / page.height <= graphic.normalizedRect[3] + 1 / 256
        )
      }))
  )
  for (const band of runningBands) {
    const peers = runningBands.filter(
      (other) =>
        (band.graphic.normalizedRect.every(
          (v, n) => Math.abs(v - other.graphic.normalizedRect[n]) <= 1 / 256
        ) ||
          // Facing pages mirror the running band; glyph quantization can
          // move its horizontal edges by two operation-box steps.
          band.graphic.normalizedRect.every((v, n) =>
            n % 2
              ? Math.abs(v - other.graphic.normalizedRect[n]) <= 1 / 256
              : Math.abs(v - (1 - other.graphic.normalizedRect[2 - n])) <= 2 / 256
          )) &&
        band.labels.some((l) =>
          other.labels.some(
            (o) =>
              o.text.replace(/^\d{1,4}(?=\p{L})|\d{1,4}$/gu, '') ===
              l.text.replace(/^\d{1,4}(?=\p{L})|\d{1,4}$/gu, '')
          )
        )
    )
    if (new Set(peers.map((p) => p.pageIndex)).size < 3) continue
    const page = pages[band.pageIndex],
      r = band.graphic.normalizedRect
    for (const g of page.graphicsBounds)
      if (g.kind === 'path' && g.normalizedRect.every((v, n) => (n < 2 ? v >= r[n] : v <= r[n])))
        excluded.add(g)
    for (const l of band.labels) excludedLines.add(l)
  }
  // A publisher wordmark can be painted as one vector path. Repetition alone
  // is insufficient: require a separately confirmed running header in its band
  // and no touching body graphic or native figure label.
  const headerMarks = pages.flatMap((page, pageIndex) =>
    (page.graphicsBounds ?? [])
      .filter(
        ({ kind, normalizedRect: r }) =>
          kind === 'path' &&
          r[3] <= 0.07 &&
          r[2] - r[0] <= 0.25 &&
          r[3] - r[1] <= 0.03 &&
          page.lines?.some(
            (l) =>
              excludedLines.has(l) &&
              l.y / page.height < r[3] &&
              (l.y + l.height) / page.height > r[1]
          ) &&
          !page.lines?.some(
            (l) =>
              !/^\d{1,4}$/.test(l.text.trim()) &&
              l.x / page.width < r[2] &&
              (l.x + l.width) / page.width > r[0] &&
              l.y / page.height < r[3] &&
              (l.y + l.height) / page.height > r[1]
          ) &&
          !(page.graphicsBounds ?? []).some(
            (g) =>
              g.normalizedRect !== r &&
              g.normalizedRect[3] > 0.07 &&
              g.normalizedRect[0] < r[2] &&
              g.normalizedRect[2] > r[0] &&
              g.normalizedRect[1] < r[3]
          )
      )
      .map((graphic) => ({ pageIndex, graphic }))
  )
  for (const mark of headerMarks)
    if (
      headerMarks.some(
        (other) =>
          other.pageIndex !== mark.pageIndex &&
          mark.graphic.normalizedRect.every(
            (v, i) => Math.abs(v - other.graphic.normalizedRect[i]) <= 1 / 256
          )
      )
    )
      excluded.add(mark.graphic)
  // Side banners repeated on several pages are publisher furniture. Require
  // matching path geometry and isolation from all raster content.
  const sideMarks = pages.flatMap((page, pageIndex) =>
    (page.graphicsBounds ?? [])
      .filter(
        ({ kind, normalizedRect: r }) =>
          kind === 'path' &&
          (r[2] <= 0.065 || r[0] >= 0.94) &&
          (r[3] - r[1] >= 0.05 ||
            (r[3] - r[1] >= 0.03 &&
              page.lines?.some(
                (l) =>
                  excludedLines.has(l) &&
                  /publishing|copyright|©/i.test(l.text) &&
                  l.height > page.height * 0.1 &&
                  l.x / page.width >= r[0] &&
                  (l.x + l.width) / page.width <= r[2]
              ))) &&
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
      for (const graphic of page.graphicsBounds)
        if (
          graphic.kind === 'path' &&
          graphic.normalizedRect.every((v, n) => (n < 2 ? v >= r[n] : v <= r[n]))
        )
          excluded.add(graphic)
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
          ((r[3] <= 0.075 && r[3] - r[1] <= 0.045) ||
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
  // Require at least twelve matching positions across three text/table pages, then
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
            ((p.lines ?? []).filter((l) => l.text.length > 60).length >= 6 ||
              ((p.lines ?? []).some((l) => captionKind(l.text) === 'table') &&
                !(p.lines ?? []).some((l) => captionKind(l.text) === 'figure') &&
                (p.lines ?? []).filter((l) => l.text.length > 20).length >= 6)) &&
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
          r[3] - r[1] <= 0.02 &&
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
  // Reuse the detector's evidence when retaining removed rules as barriers.
  const runningRuleGraphics = new Set(runningRules.map(({ graphic }) => graphic))
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
          (runningRuleGraphics.has(g) || g.normalizedRect[3] - g.normalizedRect[1] <= 0.015)
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

// Apply the already established running-margin ownership to the high-resolution
// table tokens as well. No new text classifier is needed in the table parser.
export function excludeRemovedMarginTokens(tokens, originalPage, contentPage, scale) {
  const retained = new Set(contentPage.lines)
  const removed = (originalPage.lines ?? []).filter((line) => !retained.has(line))
  return tokens.filter(
    (token) =>
      !removed.some((line) => {
        // A rotated notice/watermark has a large axis-aligned box covering
        // unrelated upright cells. Its removed text does not own those cells.
        if (token.horizontal && line.height > line.fontSize * 3) return false
        const x = (token.rect[0] + token.rect[2]) / (2 * scale)
        const y = (token.rect[1] + token.rect[3]) / (2 * scale)
        return x >= line.x && x <= line.x + line.width && y >= line.y && y <= line.y + line.height
      })
  )
}

// Only exact white or fully transparent pixels establish an unpainted border.
// Keep a source pixel around all other ink for interpolation; dark frames and
// off-white backgrounds are content, regardless of what the image depicts.
function decodedWhiteBorderRect(decoded, matrix, viewport) {
  const { width, height, kind, data } = decoded ?? {},
    channels = kind === 2 ? 3 : kind === 3 ? 4 : 0
  if (
    !channels ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    !Number.isSafeInteger(width * height) ||
    data?.length !== width * height * channels ||
    !matrix?.every(Number.isFinite) ||
    matrix[1] !== 0 ||
    matrix[2] !== 0 ||
    !matrix[0] ||
    !matrix[3] ||
    !(viewport?.width > 0 && viewport?.height > 0)
  )
    return
  // The decoded buffer already exists. Bound the work of proving complete
  // white edge strips, rather than rejecting a large image whose margins are
  // cheap to inspect. An unfinished row/column never establishes blank ink.
  let inspected = 0,
    inkSeen = false
  const unpainted = (x, y) => {
    if (inspected >= 16_000_000) return false
    inspected++
    const i = (y * width + x) * channels
    const blank =
      (channels === 4 && data[i + 3] === 0) ||
      (data[i] === 255 &&
        data[i + 1] === 255 &&
        data[i + 2] === 255 &&
        (channels === 3 || data[i + 3] === 255))
    if (!blank) inkSeen = true
    return blank
  }
  const emptyRow = (y) => {
    for (let x = 0; x < width; x++) if (!unpainted(x, y)) return false
    return true
  }
  let top = 0,
    bottom = height - 1,
    left = 0,
    right = width - 1
  while (top <= bottom && emptyRow(top)) top++
  if (top > bottom) return
  while (emptyRow(bottom)) bottom--
  const emptyColumn = (x) => {
    for (let y = top; y <= bottom; y++) if (!unpainted(x, y)) return false
    return true
  }
  while (emptyColumn(left)) left++
  while (emptyColumn(right)) right--
  if (!inkSeen) return
  left = Math.max(0, left - 1)
  right = Math.min(width, right + 2)
  top = Math.max(0, top - 1)
  bottom = Math.min(height, bottom + 2)
  if (left === 0 && right === width && top === 0 && bottom === height) return
  const points = [
    [left / width, 1 - top / height],
    [right / width, 1 - bottom / height]
  ]
  for (const point of points) Util.applyTransform(point, matrix)
  return [
    Math.min(...points.map((p) => p[0])) / viewport.width,
    Math.min(...points.map((p) => p[1])) / viewport.height,
    Math.max(...points.map((p) => p[0])) / viewport.width,
    Math.max(...points.map((p) => p[1])) / viewport.height
  ]
}

export function collectGraphicsBounds(renderTask, boxes) {
  // PDF.js 5.4.624 getOperatorList() sets the OPLIST intent, disabling queue optimization.
  // recordedBBoxes uses the render stream, so indices from getOperatorList() are NOT compatible.
  // This version-pinned adapter is covered with a real optimized-image PDF regression.
  const operators = renderTask?._internalRenderTask?.operatorList
  assert(Array.isArray(operators?.fnArray) && boxes, 'PDF render geometry is unavailable.')
  const graphicsBounds = []
  const imageMasks = new Set()
  let transform = [1, 0, 0, 1, 0, 0]
  const transforms = [],
    viewport = renderTask._internalRenderTask.params?.viewport
  let invalidGraphicsBounds = 0
  for (const [index, operation] of operators.fnArray.entries()) {
    const args = operators.argsArray[index]
    if (operation === OPS.save) transforms.push([...transform])
    else if (operation === OPS.restore) transform = transforms.pop() ?? [1, 0, 0, 1, 0, 0]
    else if (operation === OPS.transform) transform = Util.transform(transform, args)
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
    // PDF.js also records dependency bounds for W/W* followed by n. Those
    // paths only change clipping; endPath never paints visible figure content.
    if (operation === OPS.constructPath && operators.argsArray[index]?.[0] === OPS.endPath) continue
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
    let imageHash, paintedNormalizedRect
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
      if (
        (decoded?.data instanceof Uint8Array || decoded?.data instanceof Uint8ClampedArray) &&
        operation === OPS.paintImageXObject &&
        Array.isArray(viewport?.transform) &&
        !task.params?.transform
      ) {
        const painted = decodedWhiteBorderRect(
          decoded,
          Util.transform(viewport.transform, transform),
          viewport
        )
        if (
          painted?.every(Number.isFinite) &&
          painted[2] > painted[0] &&
          painted[3] > painted[1] &&
          painted[0] >= normalizedRect[0] &&
          painted[1] >= normalizedRect[1] &&
          painted[2] <= normalizedRect[2] &&
          painted[3] <= normalizedRect[3]
        )
          paintedNormalizedRect = painted
      }
    }
    const graphic = {
      operationIndex: index,
      kind: image ? 'image' : 'path',
      normalizedRect,
      ...(imageHash ? { imageHash } : {}),
      ...(paintedNormalizedRect ? { paintedNormalizedRect } : {})
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
