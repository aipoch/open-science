/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { captionKind } from './literature-pdf-caption-group.mjs'
import { createHash } from 'node:crypto'
import { Path2D } from '@napi-rs/canvas'
import { OPS, Util, version } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { nativeClosedRuleFrames } from './literature-pdf-figure-connectivity.mjs'

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
// bounding box does not prove four edges. Explicit closed outlines and four
// separately painted, connected sides establish frames after exact clipping.
export function collectClosedFigureFrames(operators, viewport) {
  let transform = [1, 0, 0, 1, 0, 0],
    clip = [0, 0, viewport.width ?? Infinity, viewport.height ?? Infinity],
    pendingClip = false,
    lineWidth = 1,
    solidStroke = true,
    strokeAlpha = 1,
    fillAlpha = 1
  const stack = [],
    frames = [],
    sides = []
  const save = () =>
    stack.push({
      transform: [...transform],
      clip: clip && [...clip],
      lineWidth,
      solidStroke,
      strokeAlpha,
      fillAlpha
    })
  const restore = () => {
    const state = stack.pop()
    transform = state?.transform ?? [1, 0, 0, 1, 0, 0]
    clip = state ? state.clip : null
    lineWidth = state?.lineWidth ?? 1
    solidStroke = state?.solidStroke ?? true
    strokeAlpha = state?.strokeAlpha ?? 1
    fillAlpha = state ? state.fillAlpha : 1
    pendingClip = false
  }
  const intersectClip = (rect) => {
    if (!clip || !rect) return null
    const r = [
      Math.max(clip[0], rect[0]),
      Math.max(clip[1], rect[1]),
      Math.min(clip[2], rect[2]),
      Math.min(clip[3], rect[3])
    ]
    return r[0] < r[2] && r[1] < r[3] ? r : null
  }
  const rectangle = (points) => {
    if (
      points.length !== 4 ||
      points.some((p) => !p.every(Number.isFinite)) ||
      new Set(points.map((p) => p.join(','))).size !== 4
    )
      return
    if (
      points.some((p, n) => {
        const q = points[(n + 1) % 4]
        return Math.min(Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1])) > 1e-5
      })
    )
      return
    return [
      Math.min(...points.map((p) => p[0])),
      Math.min(...points.map((p) => p[1])),
      Math.max(...points.map((p) => p[0])),
      Math.max(...points.map((p) => p[1]))
    ]
  }
  const addFrame = (rect, paintClip) => {
    if (
      paintClip &&
      rect.every((v, n) => (n < 2 ? v >= paintClip[n] - 1e-8 : v <= paintClip[n] + 1e-8))
    )
      frames.push(rect)
  }
  for (const [i, op] of operators.fnArray.entries()) {
    const args = operators.argsArray[i],
      // PDF.js paints the current path against the old clip before consumePath
      // applies a pending clip. Keep that paint domain even when the new clip
      // is curved and therefore unproved for all subsequent frame discovery.
      paintClip = clip
    if (op === OPS.constructPath && (pendingClip || [OPS.clip, OPS.eoClip].includes(args?.[0]))) {
      pendingClip = false
      const path = args?.[1]?.length === 1 ? args[1][0] : undefined
      if (
        path?.length !== 13 ||
        path[0] !== 0 ||
        path[12] !== 4 ||
        ![3, 6, 9].every((n) => path[n] === 1)
      )
        clip = null
      else {
        const matrix = Util.transform(viewport.transform, transform),
          points = [0, 3, 6, 9].map((n) => [path[n + 1], path[n + 2]])
        for (const point of points) Util.applyTransform(point, matrix)
        clip = intersectClip(rectangle(points))
      }
    }
    if (op === OPS.save) save()
    else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) restore()
    else if (op === OPS.transform) transform = Util.transform(transform, args)
    else if (op === OPS.paintFormXObjectBegin) {
      save()
      if (args?.[0]) transform = Util.transform(transform, args[0])
      const bounds = args?.[1],
        matrix = Util.transform(viewport.transform, transform)
      // A form without a BBox introduces no new clipping path; its painted
      // paths still inherit the caller's exact clip and saved graphics state.
      if (bounds === null || bounds === undefined) continue
      if (bounds?.length !== 4 || !bounds.every(Number.isFinite)) clip = null
      else {
        const points = [
          [bounds[0], bounds[1]],
          [bounds[2], bounds[1]],
          [bounds[2], bounds[3]],
          [bounds[0], bounds[3]]
        ]
        for (const point of points) Util.applyTransform(point, matrix)
        clip = intersectClip(rectangle(points))
      }
    } else if (op === OPS.setLineWidth) lineWidth = args[0]
    else if (op === OPS.setDash) solidStroke = Array.isArray(args[0]) && args[0].length === 0
    else if (op === OPS.setGState) {
      for (const [key, value] of args?.[0] ?? []) {
        if (key === 'LW') lineWidth = value
        if (key === 'D') solidStroke = Array.isArray(value?.[0]) && value[0].length === 0
        if (key === 'CA') strokeAlpha = value
        if (key === 'ca') fillAlpha = value
      }
    } else if (op === OPS.clip || op === OPS.eoClip) pendingClip = true
    else if (
      op === OPS.constructPath &&
      [OPS.stroke, OPS.fill, OPS.fillStroke, OPS.eoFillStroke].includes(args[0]) &&
      args[1]?.length === 1
    ) {
      const nativePath = args[1][0]
      if (
        !Array.isArray(nativePath) &&
        !(ArrayBuffer.isView(nativePath) && typeof nativePath.length === 'number')
      )
        continue
      let path = Array.from(nativePath)
      if (args[0] !== OPS.fill && (!(strokeAlpha > 0) || !Number.isFinite(strokeAlpha))) continue
      // A fill-and-stroke operation really paints its closed perimeter. A
      // fill alone still requires the separate hollow-contour proof below.
      if (
        [OPS.fillStroke, OPS.eoFillStroke].includes(args[0]) &&
        (!(lineWidth > 0) || !Number.isFinite(lineWidth))
      )
        continue
      if (args[0] === OPS.stroke && path.length === 6 && path[0] === 0 && path[3] === 1) {
        const matrix = Util.transform(viewport.transform, transform),
          a = [path[1], path[2]],
          b = [path[4], path[5]]
        if (
          !paintClip ||
          !solidStroke ||
          !(lineWidth > 0) ||
          !Number.isFinite(lineWidth) ||
          !(strokeAlpha > 0) ||
          !Number.isFinite(strokeAlpha) ||
          !matrix.every(Number.isFinite)
        )
          continue
        if (!((matrix[1] === 0 && matrix[2] === 0) || (matrix[0] === 0 && matrix[3] === 0)))
          continue
        Util.applyTransform(a, matrix)
        Util.applyTransform(b, matrix)
        if (![...a, ...b].every(Number.isFinite) || (a[0] !== b[0] && a[1] !== b[1])) continue
        const r = [
          Math.max(Math.min(a[0], b[0]), paintClip[0]),
          Math.max(Math.min(a[1], b[1]), paintClip[1]),
          Math.min(Math.max(a[0], b[0]), paintClip[2]),
          Math.min(Math.max(a[1], b[1]), paintClip[3])
        ]
        if (r[0] <= r[2] && r[1] <= r[3] && Math.max(r[2] - r[0], r[3] - r[1]) >= 30) sides.push(r)
        continue
      }
      if (args[0] === OPS.fill) {
        if (!(fillAlpha > 0) || !Number.isFinite(fillAlpha)) continue
        // SVG stroke conversion can paint a border as two closed contours.
        // Prove its hollow perimeter from opposite winding and four long
        // straight sides; a solid background or arbitrary filled AABB fails.
        const parts = []
        let valid = path.every(Number.isFinite)
        for (let n = 0; valid && n < path.length;) {
          const command = path[n]
          if (command === 4) {
            n++
            continue
          }
          if (![0, 1].includes(command) || n + 2 >= path.length) {
            valid = false
            break
          }
          if (command === 0) parts.push([])
          if (!parts.length) {
            valid = false
            break
          }
          const p = [path[n + 1], path[n + 2]]
          Util.applyTransform(p, Util.transform(viewport.transform, transform))
          parts.at(-1).push(p)
          n += 3
        }
        const closed =
          parts.length === 2 &&
          parts.every(
            (p) =>
              p.length >= 5 &&
              p.length <= 1024 &&
              p[0].every((v, i) => Math.abs(v - p.at(-1)[i]) <= 0.01)
          )
        if (valid && closed) {
          const contours = parts
            .map((points) => {
              const rect = [
                Math.min(...points.map((p) => p[0])),
                Math.min(...points.map((p) => p[1])),
                Math.max(...points.map((p) => p[0])),
                Math.max(...points.map((p) => p[1]))
              ]
              const signed =
                points
                  .slice(1)
                  .reduce((sum, p, n) => sum + points[n][0] * p[1] - p[0] * points[n][1], 0) / 2
              const sides = points
                .slice(1)
                .map((p, n) => [points[n], p])
                .filter(
                  ([p, q]) =>
                    Math.min(Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1])) <= 0.01 &&
                    (Math.abs(p[0] - q[0]) >= (rect[2] - rect[0]) * 0.5 ||
                      Math.abs(p[1] - q[1]) >= (rect[3] - rect[1]) * 0.5)
                )
              const face =
                sides.length === 4 &&
                sides.every(([p, q], n) => {
                  const vertical = Math.abs(p[0] - q[0]) <= 0.01
                  const [a, b] = sides[(n + 1) % 4]
                  return (
                    vertical !== Math.abs(a[0] - b[0]) <= 0.01 &&
                    Math.min(
                      Math.abs(p[vertical ? 0 : 1] - rect[vertical ? 0 : 1]),
                      Math.abs(p[vertical ? 0 : 1] - rect[vertical ? 2 : 3])
                    ) <= 0.05
                  )
                })
              return { rect, signed, face }
            })
            .sort((a, b) => Math.abs(b.signed) - Math.abs(a.signed))
          const [outer, inner] = contours,
            width = outer.rect[2] - outer.rect[0],
            height = outer.rect[3] - outer.rect[1]
          const inset = [
            inner.rect[0] - outer.rect[0],
            inner.rect[1] - outer.rect[1],
            outer.rect[2] - inner.rect[2],
            outer.rect[3] - inner.rect[3]
          ]
          if (
            width >= 4 &&
            height >= 4 &&
            contours.every(
              (c) =>
                c.face &&
                Math.abs(c.signed) > (c.rect[2] - c.rect[0]) * (c.rect[3] - c.rect[1]) * 0.9
            ) &&
            outer.signed * inner.signed < 0 &&
            inset.every((v) => v > 0 && v < Math.min(width, height) * 0.04) &&
            Math.max(...inset) < Math.min(...inset) * 1.2
          )
            addFrame(outer.rect, paintClip)
        }
        continue
      }
      // The same closed rounded perimeter can start on a straight side.
      // Rotate its exact commands to the corner-first form below; a trailing
      // move without a painted segment contributes no edge or frame evidence.
      if (
        path.length === 47 &&
        path[0] === 0 &&
        path[3] === 1 &&
        path[43] === 4 &&
        path[44] === 0 &&
        [6, 16, 26, 36].every((n) => path[n] === 2) &&
        [13, 23, 33].every((n) => path[n] === 1) &&
        path.every(Number.isFinite) &&
        path[41] === path[1] &&
        path[42] === path[2]
      )
        path = [0, path[4], path[5], ...path.slice(6, 44)]
      // A rounded rectangle has four monotone quarter-corners connected by
      // four straight axis-aligned sides. Explicit closePath is mandatory;
      // a curved path with the same bounding box cannot establish a frame.
      if (
        path.length === 41 &&
        path[0] === 0 &&
        path[40] === 4 &&
        [3, 13, 23, 33].every((n) => path[n] === 2) &&
        [10, 20, 30].every((n) => path[n] === 1) &&
        path.every(Number.isFinite)
      ) {
        const matrix = Util.transform(viewport.transform, transform)
        const point = (n) => {
          const p = [path[n], path[n + 1]]
          Util.applyTransform(p, matrix)
          return p
        }
        const start = point(1),
          corners = [3, 13, 23, 33].map((n, i) => ({
            start: i ? point(n - 2) : start,
            a: point(n + 1),
            b: point(n + 3),
            end: point(n + 5)
          }))
        const sides = corners.map((c, i) => [c.end, corners[(i + 1) % 4].start])
        const straight = sides.every(([p, q], i) => {
          const dx = Math.abs(p[0] - q[0]),
            dy = Math.abs(p[1] - q[1])
          const [a, b] = sides[(i + 1) % 4]
          return (
            Math.min(dx, dy) <= 0.01 &&
            Math.max(dx, dy) >= 4 &&
            dx <= 0.01 !== Math.abs(a[0] - b[0]) <= 0.01
          )
        })
        const rounded = corners.every((c) => {
          const dx = Math.abs(c.start[0] - c.end[0]),
            dy = Math.abs(c.start[1] - c.end[1])
          return (
            dx > 0.01 &&
            dy > 0.01 &&
            Math.max(dx, dy) < Math.min(dx, dy) * 1.1 &&
            [c.a, c.b].every((p) =>
              p.every(
                (v, i) =>
                  v >= Math.min(c.start[i], c.end[i]) - 0.01 &&
                  v <= Math.max(c.start[i], c.end[i]) + 0.01
              )
            ) &&
            ((Math.abs(c.a[0] - c.start[0]) <= 0.01 && Math.abs(c.b[1] - c.end[1]) <= 0.01) ||
              (Math.abs(c.a[1] - c.start[1]) <= 0.01 && Math.abs(c.b[0] - c.end[0]) <= 0.01))
          )
        })
        if (straight && rounded) {
          const points = corners.flatMap((c) => [c.start, c.end])
          addFrame(
            [
              Math.min(...points.map((p) => p[0])),
              Math.min(...points.map((p) => p[1])),
              Math.max(...points.map((p) => p[0])),
              Math.max(...points.map((p) => p[1]))
            ],
            paintClip
          )
        }
        continue
      }
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
      addFrame(
        [
          Math.min(...points.map((p) => p[0])),
          Math.min(...points.map((p) => p[1])),
          Math.max(...points.map((p) => p[0])),
          Math.max(...points.map((p) => p[1]))
        ],
        paintClip
      )
    }
  }
  return [...frames, ...nativeClosedRuleFrames(sides)].filter(
    (r, n, all) => !all.slice(0, n).some((p) => p.every((v, i) => Math.abs(v - r[i]) < 0.01))
  )
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
  const runningSeparator = (page, line) => {
    const matches = (page.graphicsBounds ?? []).filter((g) => {
      const r = g.normalizedRect,
        bottom = (line.y + line.height) / page.height
      return (
        bottom > 0.07 &&
        g.kind === 'path' &&
        r[2] - r[0] >= 0.8 &&
        r[3] - r[1] <= 0.015 &&
        r[3] <= 0.12 &&
        r[1] >= bottom - (line.height / page.height) * 0.5 &&
        r[1] - bottom <= (line.height / page.height) * 1.5 &&
        line.x / page.width >= r[0] &&
        (line.x + line.width) / page.width <= r[2] &&
        (page.graphicsBounds ?? []).some(
          (other) =>
            other !== g &&
            other.normalizedRect[1] >= r[3] + (line.height / page.height) * 0.5 &&
            (other.normalizedRect[2] - other.normalizedRect[0]) *
              (other.normalizedRect[3] - other.normalizedRect[1]) >
              0.01
        )
      )
    })
    return matches.length === 1 ? matches[0] : undefined
  }
  const headerText = (page, line) => {
    const text = line.text
    if (authorHeader(text)) return text.replace(/^\d+\s+/, '')
    // Native merged rows include a changing printed ordinal. Normalize only
    // an exact page ordinal in a compact author-shaped shallow-margin row.
    if (
      text.startsWith(`${page.pageNumber} `) &&
      /^\d+\s+(?:\p{Lu}\.\s*){1,3}\p{Lu}\p{L}+(?:[\p{L}\s.]+)\band\s+(?:\p{Lu}\.\s*){1,3}\p{Lu}\p{L}+$/u.test(
        text
      )
    )
      return text.slice(String(page.pageNumber).length + 1)
    if (
      text.endsWith(` ${page.pageNumber}`) &&
      /^[\p{Lu}\d\s-]+\s\d+$/u.test(text) &&
      page.lines.some(
        (first) =>
          first !== line &&
          /\bet al\.:.*-$/i.test(first.text) &&
          Math.abs(first.fontSize - line.fontSize) < 0.1 &&
          Math.abs(first.x - line.x) < 0.1 &&
          line.y >= first.y + first.height &&
          line.y - first.y - first.height < line.fontSize * 0.5
      )
    )
      return text.slice(0, -String(page.pageNumber).length - 1)
    return text
  }
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
        rect[3] <= (authorHeader(line.text) || runningSeparator(page, line) ? 0.1 : 0.07) &&
        rect[3] - rect[1] <= 0.03
      if (
        !(verticalNotice || runningHeader) ||
        (page.graphicsBounds ?? []).some((graphic) => {
          const { kind, normalizedRect: r } = graphic
          return (
            // A page background/border path is not evidence that a repeated
            // running header is a figure label. Real images remain protected.
            !(runningHeader && kind === 'path' && r[2] - r[0] >= 0.95 && r[3] - r[1] >= 0.95) &&
            !(runningHeader && graphic === runningSeparator(page, line)) &&
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
        })
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
            headerText(pages[notice.pageIndex], notice.line) ===
              headerText(pages[other.pageIndex], other.line) &&
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
          r[3] - r[1] <= 0.03 + 1 / 256 &&
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
              (line.y + line.height < r[1] * page.height ||
                runningSeparator(page, line)?.normalizedRect === r)
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

// PDF.js replaces DrawOPS in the same render stream with a native Path2D while
// painting. Observe its complete commands, never promote its bounding box.
function imageEnvelopeRectangularClip(path) {
  if (Array.isArray(path) || path instanceof Float32Array) {
    return (
      path.length === 13 &&
      Array.from(path).every(Number.isFinite) &&
      path[0] === 0 &&
      path[3] === 1 &&
      path[6] === 1 &&
      path[9] === 1 &&
      path[12] === 4 &&
      path[2] === path[5] &&
      path[4] === path[7] &&
      path[8] === path[11] &&
      path[10] === path[1] &&
      path[4] > path[1] &&
      path[8] > path[2]
    )
  }
  if (!(path instanceof Path2D) || Object.getPrototypeOf(path) !== Path2D.prototype) return false
  const commands = Path2D.prototype.toSVGString.call(path)
  if (commands.length > 512) return false
  const number = '[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][-+]?\\d+)?'
  const point = `(${number}) (${number})`
  const rect = new RegExp(`^M${point}L${point}L${point}L${point}L${point}Z$`, 'u').exec(commands)
  if (!rect) return false
  const [x0, y0, x1, y1, x2, y2, x3, y3, x4, y4] = rect.slice(1).map(Number)
  return (
    rect.slice(1).map(Number).every(Number.isFinite) &&
    y0 === y1 &&
    x1 === x2 &&
    y2 === y3 &&
    x3 === x4 &&
    x4 === x0 &&
    y4 === y0 &&
    x1 > x0 &&
    y2 > y0
  )
}

// Only a simple, observed render context supplies this image destination upper
// bound. Reject whole streams with effects or nested programs rather than
// reconstructing a second graphics-state engine. Clips may only reduce paint.
function imageEnvelopeRenderContext(task, operators) {
  const viewport = task.params?.viewport,
    context = task.gfx?.ctx
  if (
    version !== '5.4.624' ||
    task.params?.transform ||
    (task.params?.background !== null && task.params?.background !== undefined) ||
    !context ||
    context !== task.params?.canvasContext ||
    task.gfx.pageColors !== null ||
    !['none', ''].includes(context.filter) ||
    context.shadowBlur !== 0 ||
    context.shadowOffsetX !== 0 ||
    context.shadowOffsetY !== 0 ||
    context.globalAlpha !== 1 ||
    context.globalCompositeOperation !== 'source-over' ||
    typeof context.getTransform !== 'function' ||
    !(viewport?.width > 0) ||
    !(viewport?.height > 0) ||
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.rotation !== 0 ||
    !Array.isArray(viewport.transform) ||
    viewport.transform.length !== 6 ||
    !viewport.transform.every(Number.isFinite) ||
    viewport.transform[0] <= 0 ||
    viewport.transform[1] !== 0 ||
    viewport.transform[2] !== 0 ||
    viewport.transform[3] >= 0
  )
    return false
  const original = context.getTransform()
  if (
    !original ||
    [original.a, original.b, original.c, original.d, original.e, original.f].some(
      (v, i) => v !== [1, 0, 0, 1, 0, 0][i]
    )
  )
    return false
  const allowed = new Set([
    OPS.save,
    OPS.restore,
    OPS.transform,
    OPS.dependency,
    OPS.constructPath,
    OPS.clip,
    OPS.eoClip,
    OPS.paintImageXObject,
    OPS.setFillRGBColor,
    OPS.setStrokeRGBColor,
    OPS.beginText,
    OPS.endText,
    OPS.setTextRenderingMode,
    OPS.setFont,
    OPS.setTextMatrix,
    OPS.showText,
    OPS.setCharSpacing,
    OPS.setWordSpacing,
    OPS.setHScale,
    OPS.setLeading,
    OPS.moveText,
    OPS.setLeadingMoveText,
    OPS.nextLine,
    OPS.setTextRise
  ])
  let depth = 0
  for (const [index, operation] of operators.fnArray.entries()) {
    const args = operators.argsArray[index]
    if (!allowed.has(operation)) return false
    if (operation === OPS.save) depth++
    else if (operation === OPS.restore) {
      if (!depth) return false
      depth--
    } else if (operation === OPS.transform) {
      if (!Array.isArray(args) || args.length !== 6 || !args.every(Number.isFinite)) return false
    } else if (operation === OPS.setTextRenderingMode && args?.[0] !== 0) return false
    else if (operation === OPS.setFont) {
      const source = args?.[0],
        font =
          typeof source === 'string' && task.commonObjs?.has(source)
            ? task.commonObjs.get(source)
            : undefined
      if (
        !font ||
        font.isType3Font ||
        ![
          'Type1',
          'Type1C',
          'CIDFontType0',
          'CIDFontType0C',
          'CIDFontType2',
          'TrueType',
          'OpenType',
          'MMType1'
        ].includes(font.type)
      )
        return false
    } else if (operation === OPS.clip || operation === OPS.eoClip) {
      const next = operators.argsArray[index + 1],
        path = next?.[1]?.[0]
      if (
        operators.fnArray[index + 1] !== OPS.constructPath ||
        next?.[0] !== OPS.endPath ||
        next?.[1]?.length !== 1 ||
        !imageEnvelopeRectangularClip(path)
      )
        return false
    } else if (
      operation === OPS.constructPath &&
      ![
        OPS.endPath,
        OPS.stroke,
        OPS.closeStroke,
        OPS.fill,
        OPS.eoFill,
        OPS.fillStroke,
        OPS.eoFillStroke,
        OPS.closeFillStroke,
        OPS.closeEOFillStroke
      ].includes(args?.[0])
    )
      return false
  }
  return depth === 0
}

function imageEnvelopeRect(decoded, transform, viewport, recorded) {
  if (
    !(decoded?.data instanceof Uint8Array || decoded?.data instanceof Uint8ClampedArray) ||
    ![2, 3].includes(decoded.kind) ||
    !Number.isSafeInteger(decoded.width) ||
    decoded.width <= 0 ||
    !Number.isSafeInteger(decoded.height) ||
    decoded.height <= 0 ||
    decoded.data.length !== decoded.width * decoded.height * (decoded.kind === 3 ? 4 : 3) ||
    decoded.data.length > 16_000_000 ||
    !transform.every(Number.isFinite) ||
    transform[0] <= 0 ||
    transform[3] <= 0 ||
    transform[1] !== 0 ||
    transform[2] !== 0
  )
    return
  const channels = decoded.kind === 3 ? 4 : 3
  let visible = false
  for (let index = 0; index < decoded.data.length; index += channels)
    if (
      (channels === 3 || decoded.data[index + 3] > 0) &&
      (decoded.data[index] !== 255 ||
        decoded.data[index + 1] !== 255 ||
        decoded.data[index + 2] !== 255)
    ) {
      visible = true
      break
    }
  if (!visible) return
  const matrix = Util.transform(viewport.transform, transform)
  const topLeft = [0, 1],
    bottomRight = [1, 0]
  Util.applyTransform(topLeft, matrix)
  Util.applyTransform(bottomRight, matrix)
  if (bottomRight[0] - topLeft[0] <= 2 || bottomRight[1] - topLeft[1] <= 2) return
  // PDFjs drawImageAtIntegerCoords rounds both destination corners. Include
  // half an output pixel; this is not decoded-white-border ink or a crop.
  const envelope = [
    topLeft[0] - 0.5,
    topLeft[1] - 0.5,
    bottomRight[0] + 0.5,
    bottomRight[1] + 0.5
  ].map((v, i) => v / (i % 2 ? viewport.height : viewport.width))
  if (
    !envelope.every(Number.isFinite) ||
    envelope.some((v, i) => v < 0 || v > 1 || (i < 2 ? v < recorded[i] : v > recorded[i]))
  )
    return
  return envelope
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
  const envelopeContext = imageEnvelopeRenderContext(renderTask._internalRenderTask, operators)
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
    let imageHash, paintedNormalizedRect, imageEnvelopeNormalizedRect
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
      if (envelopeContext && operation === OPS.paintImageXObject && imageHash)
        imageEnvelopeNormalizedRect = imageEnvelopeRect(
          decoded,
          transform,
          viewport,
          normalizedRect
        )
    }
    const graphic = {
      operationIndex: index,
      kind: image ? 'image' : 'path',
      normalizedRect,
      ...(imageHash ? { imageHash } : {}),
      ...(paintedNormalizedRect ? { paintedNormalizedRect } : {}),
      ...(imageEnvelopeNormalizedRect ? { imageEnvelopeNormalizedRect } : {})
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
