/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { area, intersection, union, lineRect } from './literature-pdf-page-geometry.mjs'

const contains = (a, b, tolerance = 0) =>
  b[0] >= a[0] - tolerance &&
  b[1] >= a[1] - tolerance &&
  b[2] <= a[2] + tolerance &&
  b[3] <= a[3] + tolerance
const graphics = (page, kind) =>
  page.graphicsBounds
    .filter((g) => g.kind === kind)
    .map((g) =>
      (g.paintedNormalizedRect ?? g.normalizedRect).map(
        (v, i) => v * (i % 2 ? page.height : page.width)
      )
    )
const captionFont = (page, caption) =>
  Math.max(
    ...page.lines.filter((l) => intersection(lineRect(l), caption.rect) > 0).map((l) => l.fontSize)
  )
const blocked = (rect, caption, captions, tables) =>
  tables.some((r) => intersection(r, rect) > 0) ||
  captions.some((c) => c !== caption && c.page === caption.page && intersection(c.rect, rect) > 0)

// Some native text figures draw their frame as four independent rules rather
// than one closed path. Join only aligned horizontal/vertical segments that
// form a closed rectangle; the text proof below still has to establish that
// the rectangle is an illustration rather than a table or paragraph.
const segmentedFrameRects = (paths, font) => {
  const tolerance = Math.max(2, font * 1.5)
  const thin = Math.max(2, font * 1.15)
  const horizontal = paths.filter(
    (r) => r[2] - r[0] >= font * 20 && r[3] - r[1] <= thin && r[3] - r[1] > 0
  )
  const vertical = paths.filter(
    (r) => r[3] - r[1] >= font * 5 && r[2] - r[0] <= thin && r[2] - r[0] > 0
  )
  const close = (a, b) => Math.abs(a - b) <= tolerance
  const frames = []
  for (const top of horizontal) {
    for (const bottom of horizontal) {
      if (bottom[1] - top[3] < font * 5) continue
      if (!close(top[0], bottom[0]) || !close(top[2], bottom[2])) continue
      const left = vertical.find(
        (r) =>
          close(r[0], top[0]) &&
          close(r[2], top[0]) &&
          r[1] <= top[1] + tolerance &&
          r[3] >= bottom[3] - tolerance
      )
      const right = vertical.find(
        (r) =>
          close(r[0], top[2]) &&
          close(r[2], top[2]) &&
          r[1] <= top[1] + tolerance &&
          r[3] >= bottom[3] - tolerance
      )
      if (!left || !right) continue
      const rect = [
        Math.min(top[0], bottom[0], left[0], right[0]),
        Math.min(top[1], bottom[1], left[1], right[1]),
        Math.max(top[2], bottom[2], left[2], right[2]),
        Math.max(top[3], bottom[3], left[3], right[3])
      ]
      if (!frames.some((r) => r.every((v, i) => Math.abs(v - rect[i]) <= tolerance)))
        frames.push(rect)
    }
  }
  return frames
}

// A native outer drawing and distinctly smaller typeset contents prove the
// illustrated text face independently of paragraph-length exclusion heuristics.
export function nativeCaptionedTextIllustration(page, caption, captions, tables) {
  const font = captionFont(page, caption)
  if (!(font > 0) || !Number.isFinite(font)) return
  const paths = graphics(page, 'path')
  const candidateRects = [
    ...paths.map((rect) => ({ rect, segmented: false })),
    ...segmentedFrameRects(paths, font).map((rect) => ({ rect, segmented: true }))
  ]
  const proofs = candidateRects
    .filter(({ rect: r, segmented }) => {
      if (
        !r.every(Number.isFinite) ||
        r[2] - r[0] < font * 20 ||
        r[3] - r[1] < font * 5 ||
        r[3] > caption.rect[1] ||
        caption.rect[1] - r[3] > font * 2 ||
        Math.min(r[2], caption.rect[2]) <= Math.max(r[0], caption.rect[0]) ||
        blocked(r, caption, captions, tables)
      )
        return false
      const contents = page.lines.filter((l) => contains(r, lineRect(l)) && l.text.trim())
      // Some publishers draw a framed prompt card with an inset border and
      // keep its body at the regular text size, just above the caption size.
      // The inset border is a strict ownership witness; without it retain
      // the older, smaller-body threshold so ordinary prose stays deferred.
      const nestedFrame = paths.some((other) => {
        if (other === r || area(other) <= area(r) * 0.35) return false
        const ratio = area(other) / area(r)
        const tolerance = Math.max(2, font * 1.5)
        const duplicate =
          ratio >= 0.98 &&
          ratio <= 1.02 &&
          other.every((value, index) => Math.abs(value - r[index]) <= tolerance)
        return (ratio < 0.98 || duplicate) && contains(r, other, tolerance)
      })
      // Prompt-style text panels often keep their title at the caption size
      // while setting the body one point smaller.  Ignore that title line,
      // but require enough smaller body text to prove this is an illustration
      // rather than an ordinary paragraph.
      const body = (segmented ? contents.slice(1) : contents).filter(
        (l) => l.fontSize > 0 && l.fontSize <= font * (segmented ? 1.05 : nestedFrame ? 1.2 : 0.95)
      )
      const title = segmented
        ? contents.slice(0, 1)
        : nestedFrame
          ? []
          : contents.filter((l) => l.fontSize > font * 0.95)
      return (
        body.length >= 4 &&
        body.filter((l) => l.text.length >= 30).length >= 3 &&
        title.every((l) => l === contents[0] && l.text.length < 80 && l.y <= body[0].y)
      )
    })
    .filter(
      ({ rect: r }, i, all) =>
        !all.some(
          (p, j) =>
            j !== i &&
            contains(p.rect, r) &&
            (area(p.rect) > area(r) || (area(p.rect) === area(r) && j < i))
        )
    )
  if (proofs.length === 1)
    return {
      caption,
      rect: proofs[0].rect,
      graphicsCount: paths.filter((r) => contains(proofs[0].rect, r)).length
    }
}

// A vector architecture plate can be painted as one large outer path with
// many small image/path operations for logos, arrows, and boxed labels. It has
// no raster plate for the ordinary association pass, and its short labels do
// not satisfy the prose-body proof above. Require a directly attached broad
// frame, several enclosed image marks, and three spatially separated stages;
// this keeps ordinary prose boxes and uncaptioned decorative drawings out.
export function nativeCaptionedVectorDiagram(page, caption, captions, tables) {
  const font = captionFont(page, caption)
  if (!(font > 0) || !Number.isFinite(font)) return
  const toRect = (graphic) => {
    const source = graphic?.normalizedRect
    return source?.every(Number.isFinite)
      ? source.map((value, index) => value * (index % 2 ? page.height : page.width))
      : undefined
  }
  const inside = (outer, inner, tolerance = 2) =>
    inner[0] >= outer[0] - tolerance &&
    inner[1] >= outer[1] - tolerance &&
    inner[2] <= outer[2] + tolerance &&
    inner[3] <= outer[3] + tolerance
  const frames = (page.graphicsBounds ?? [])
    .filter((graphic) => graphic.kind === 'path')
    .map(toRect)
    .filter(
      (rect) =>
        rect &&
        rect[2] - rect[0] >= page.width * 0.7 &&
        rect[3] - rect[1] >= page.height * 0.15 &&
        rect[3] <= caption.rect[1] &&
        caption.rect[1] - rect[3] <= Math.max(24, font * 3) &&
        !tables.some((table) => intersection(table, rect) > 0) &&
        !captions.some((other) => other !== caption && intersection(other.rect, rect) > 0)
    )
    .filter(
      (rect, index, all) =>
        !all
          .slice(0, index)
          .some((other) =>
            other.every((value, coordinate) => Math.abs(value - rect[coordinate]) <= 1)
          )
    )
  const images = (page.graphicsBounds ?? [])
    .filter((graphic) => graphic.kind === 'image')
    .map(toRect)
    .filter((rect) => rect && area(rect) > 0)
  const candidates = frames
    .map((frame) => {
      const enclosedImages = images.filter((image) => inside(frame, image))
      if (enclosedImages.length < 6) return undefined
      const centers = enclosedImages.map((rect) => (rect[0] + rect[2]) / 2).sort((a, b) => a - b)
      const columns = []
      for (const center of centers) {
        const previous = columns.at(-1)
        if (previous === undefined || center - previous > page.width * 0.12) columns.push(center)
        else columns[columns.length - 1] = (previous + center) / 2
      }
      if (columns.length < 3) return undefined
      const lines = (page.lines ?? []).filter(
        (line) =>
          line.text?.trim() &&
          inside(frame, lineRect(line), 2) &&
          !captions.some(
            (other) => other !== caption && intersection(other.rect, lineRect(line)) > 0
          )
      )
      if (lines.length < 8) return undefined
      return { frame, graphicsCount: enclosedImages.length, columns: columns.length }
    })
    .filter(Boolean)
    .sort((a, b) => area(b.frame) - area(a.frame))
  if (candidates.length !== 1) return undefined
  return {
    caption,
    rect: candidates[0].frame,
    graphicsCount: candidates[0].graphicsCount
  }
}

// A narrow-column vector plate can contain only boxes, arrows, and short
// labels.  It has no raster witness and therefore cannot use the broad
// architecture-plate recognizer above.  Keep this fallback strict: require a
// caption-attached outer path, a dense repeated row/column lattice of smaller
// paths, and no table or competing caption in the candidate band.  Ordinary
// plots and prose rules do not satisfy the repeated lattice proof.
export function nativeCaptionedVectorGrid(page, caption, captions, tables) {
  const font = captionFont(page, caption)
  if (
    !(font > 0) ||
    !Number.isFinite(font) ||
    !/^figure\s+\d+\s*[:.]/i.test(caption.lines[0] ?? '')
  )
    return
  const paths = graphics(page, 'path')
  const candidates = paths.filter((frame, index) => {
    const width = frame[2] - frame[0],
      height = frame[3] - frame[1]
    return (
      width >= page.width * 0.3 &&
      height >= Math.max(page.height * 0.1, font * 8) &&
      frame[3] <= caption.rect[1] + 1 &&
      caption.rect[1] - frame[3] <= Math.max(24, font * 3) &&
      Math.min(frame[2], caption.rect[2]) - Math.max(frame[0], caption.rect[0]) >= width * 0.8 &&
      !paths
        .slice(0, index)
        .some((other) => other.every((value, n) => Math.abs(value - frame[n]) <= 1)) &&
      !blocked(frame, caption, captions, tables)
    )
  })
  const cluster = (values, tolerance) => {
    const sorted = values.slice().sort((a, b) => a - b),
      groups = []
    for (const value of sorted) {
      const previous = groups.at(-1)
      if (!previous || value - previous.at(-1) > tolerance) groups.push([value])
      else previous.push(value)
    }
    return groups.map((group) => group.reduce((sum, value) => sum + value, 0) / group.length)
  }
  const proofs = candidates
    .map((frame) => {
      const frameArea = area(frame),
        marks = paths.filter((path) => {
          const width = path[2] - path[0],
            height = path[3] - path[1]
          return (
            path !== frame &&
            contains(frame, path, 2) &&
            width >= font * 1.8 &&
            height >= font * 1.3 &&
            height <= font * 2.8 &&
            area(path) > font * font * 0.25 &&
            area(path) < frameArea * 0.2 &&
            width < (frame[2] - frame[0]) * 0.35 &&
            height < (frame[3] - frame[1]) * 0.45
          )
        })
      if (marks.length < 18) return undefined
      const rowCenters = cluster(
          marks.map((path) => (path[1] + path[3]) / 2),
          Math.max(font * 1.5, 6)
        ),
        columnCenters = cluster(
          marks.map((path) => (path[0] + path[2]) / 2),
          Math.max(font * 1.5, 6)
        ),
        lines = page.lines.filter(
          (line) =>
            contains(frame, lineRect(line), 2) &&
            line.text?.trim() &&
            !captions.some(
              (other) => other !== caption && intersection(other.rect, lineRect(line)) > 0
            )
        )
      if (rowCenters.length < 3 || columnCenters.length < 4 || lines.length < 1) return undefined
      if (
        rowCenters.some(
          (row) =>
            marks.filter(
              (path) => Math.abs((path[1] + path[3]) / 2 - row) <= Math.max(font * 1.5, 6)
            ).length < 4
        ) ||
        columnCenters.some(
          (column) =>
            marks.filter(
              (path) => Math.abs((path[0] + path[2]) / 2 - column) <= Math.max(font * 1.5, 6)
            ).length < 2
        )
      )
        return undefined
      return { frame, marks, lines }
    })
    .filter(Boolean)
    .filter(
      ({ frame }, index, all) =>
        !all.some(
          (other, otherIndex) =>
            otherIndex !== index &&
            contains(other.frame, frame, 2) &&
            area(other.frame) > area(frame)
        )
    )
  if (proofs.length !== 1) return
  return {
    caption,
    rect: proofs[0].frame,
    graphicsCount: paths.filter((path) => contains(proofs[0].frame, path, 2)).length,
    reason: 'native-vector-grid'
  }
}

// A four-panel heatmap can be encoded entirely as native vector cell paths,
// so there is no image witness for the ordinary figure pass.  Keep recovery
// narrow: the caption must name success rates/trajectory lengths, the paths
// must form a dense multi-row grid immediately above it, and no table or
// competing caption may intersect the band.
export function nativeCaptionedVectorHeatmap(page, caption, captions, tables) {
  const text = caption.lines.join(' ')
  if (
    !/^figure\s+\d+\s*:/i.test(text) ||
    !/success\s+rates?/i.test(text) ||
    !/trajectory\s+lengths?/i.test(text)
  )
    return undefined
  const font = captionFont(page, caption)
  const paths = graphics(page, 'path').filter(
    (rect) =>
      rect[3] <= caption.rect[1] && rect[0] >= page.width * 0.08 && rect[2] <= page.width * 0.92
  )
  if (paths.length < 24) return undefined

  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)]
  }
  const gapX = Math.max(font * 1.5, median(paths.map((rect) => rect[2] - rect[0])) * 0.4)
  const gapY = Math.max(font * 1.5, median(paths.map((rect) => rect[3] - rect[1])) * 0.4)
  const touches = (a, b) => {
    const overlapX = Math.min(a[2], b[2]) - Math.max(a[0], b[0])
    const overlapY = Math.min(a[3], b[3]) - Math.max(a[1], b[1])
    const horizontalGap = Math.max(b[0] - a[2], a[0] - b[2], 0)
    const verticalGap = Math.max(b[1] - a[3], a[1] - b[3], 0)
    return (overlapX > 0 && verticalGap <= gapY) || (overlapY > 0 && horizontalGap <= gapX)
  }
  const components = []
  const pending = new Set(paths.keys())
  while (pending.size > 0) {
    const seed = pending.values().next().value
    pending.delete(seed)
    const component = [paths[seed]]
    const queue = [seed]
    while (queue.length > 0) {
      const current = queue.pop()
      for (const candidate of [...pending]) {
        if (!touches(paths[current], paths[candidate])) continue
        pending.delete(candidate)
        queue.push(candidate)
        component.push(paths[candidate])
      }
    }
    components.push(component)
  }
  const candidates = components
    .filter((component) => component.length >= 24)
    .map((component) => {
      const bounds = union(component)
      const rowCenters = [
        ...new Set(component.map((rect) => Math.round((rect[1] + rect[3]) / 2 / 4)))
      ]
      const columnCenters = [
        ...new Set(component.map((rect) => Math.round((rect[0] + rect[2]) / 2 / 8)))
      ]
      return { component, bounds, rowCenters, columnCenters }
    })
    .filter(({ bounds, rowCenters, columnCenters }) => {
      if (caption.rect[1] - bounds[3] > Math.max(28, font * 4)) return false
      if (blocked(bounds, caption, captions, tables)) return false
      if (bounds[2] - bounds[0] < page.width * 0.55 || bounds[3] - bounds[1] < page.height * 0.12)
        return false
      return rowCenters.length >= 4 && columnCenters.length >= 4
    })
  if (candidates.length !== 1) return undefined
  const { component, bounds } = candidates[0]
  return { caption, rect: bounds, graphicsCount: component.length, reason: 'native-vector-heatmap' }
}

// Workflow screenshots are a native composite: raster panels are connected
// by arrows and small labels, with the caption below the whole plate.  Require
// several image panels in two rows plus a broad path component spanning them;
// this prevents ordinary screenshot prose or a single image from widening a
// crop merely by proximity.
export function nativeCaptionedWorkflowPanel(page, caption, captions, tables) {
  if (!/execution\s+trajectory/i.test(caption.lines.join(' '))) return undefined
  const toRect = (graphic) => {
    const source = graphic?.paintedNormalizedRect ?? graphic?.normalizedRect
    return source?.every(Number.isFinite)
      ? source.map((value, index) => value * (index % 2 ? page.height : page.width))
      : undefined
  }
  const images = (page.graphicsBounds ?? [])
    .filter((graphic) => graphic.kind === 'image')
    .map(toRect)
    .filter((rect) => rect && rect[3] < caption.rect[1] && rect[1] > page.height * 0.04)
  if (images.length < 6) return undefined
  const imageBounds = union(images)
  if (
    imageBounds[2] - imageBounds[0] < page.width * 0.62 ||
    caption.rect[1] - imageBounds[3] > Math.max(32, captionFont(page, caption) * 5)
  )
    return undefined
  const rows = [...new Set(images.map((rect) => Math.round((rect[1] + rect[3]) / 2 / 12)))]
  if (rows.length < 2) return undefined
  const paths = (page.graphicsBounds ?? [])
    .filter((graphic) => graphic.kind === 'path')
    .map(toRect)
    .filter((rect) => rect && intersection(rect, imageBounds) > 0)
  const spanningPath = (page.graphicsBounds ?? [])
    .filter((graphic) => graphic.kind === 'path')
    .map(toRect)
    .find(
      (rect) =>
        rect &&
        rect[0] <= imageBounds[0] + 8 &&
        rect[2] >= imageBounds[2] - 8 &&
        rect[1] <= imageBounds[1] + 8 &&
        rect[3] >= imageBounds[3] - 8
    )
  if (!spanningPath || blocked(union([imageBounds, ...paths]), caption, captions, tables))
    return undefined
  const rect = union([imageBounds, spanningPath, ...paths])
  return {
    caption,
    rect,
    graphicsCount: images.length + paths.length,
    reason: 'native-workflow-panel'
  }
}

// A single raster chart can sit immediately above a narrow-column caption
// while a second multi-panel figure occupies the lower half of the page. The
// ordinary adjacency pass can see both directions and conservatively defer;
// accept only a unique, tightly attached raster with no competing caption.
export function nativeCaptionedRaster(page, caption, captions, tables) {
  const font = captionFont(page, caption)
  if (!(font > 0) || !Number.isFinite(font)) return
  // Leave a raster/vector plate to the general association pass when a path
  // touches the candidate image/caption or sits in the immediately preceding
  // figure band. Unrelated paths elsewhere on the page (for example a listing
  // below a wide chart) must not suppress an otherwise unique crop.
  const paths = (page.graphicsBounds ?? [])
    .filter((g) => g.kind === 'path')
    .map((g) =>
      g.normalizedRect?.every(Number.isFinite)
        ? g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
        : undefined
    )
    .filter(Boolean)
  const nearby = (a, b, tolerance = Math.max(2, font * 1.5)) =>
    intersection([a[0] - tolerance, a[1] - tolerance, a[2] + tolerance, a[3] + tolerance], b) > 0
  // A neighboring side caption normally shares the top baseline of its raster.
  // If that caption is vertically displaced, the two plates are ambiguous;
  // defer ownership rather than letting the upper raster claim the whole page.
  const sideCaptionDisplaced = captions.some((other) => {
    if (other === caption) return false
    return (page.graphicsBounds ?? []).some((graphic) => {
      if (graphic.kind !== 'image' || !graphic.normalizedRect?.every(Number.isFinite)) return false
      const rect = graphic.normalizedRect.map(
        (value, index) => value * (index % 2 ? page.height : page.width)
      )
      const gap = other.rect[0] - rect[2]
      const horizontalOverlap =
        Math.max(0, Math.min(rect[2], caption.rect[2]) - Math.max(rect[0], caption.rect[0])) /
        Math.max(1, Math.min(rect[2] - rect[0], caption.rect[2] - caption.rect[0]))
      return (
        gap >= 0 &&
        gap <= Math.max(12, font * 2) &&
        rect[1] >= caption.rect[3] - Math.max(12, font * 2) &&
        horizontalOverlap >= 0.25 &&
        Math.abs(rect[1] - other.rect[1]) > Math.max(6, font * 0.9) &&
        Math.min(rect[3], other.rect[3]) - Math.max(rect[1], other.rect[1]) >
          Math.min(rect[3] - rect[1], other.rect[3] - other.rect[1]) * 0.35
      )
    })
  })
  if (sideCaptionDisplaced) return
  const candidates = (page.graphicsBounds ?? [])
    .filter((g) => g.kind === 'image')
    .map((g) =>
      g.normalizedRect?.every(Number.isFinite)
        ? { rect: g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)) }
        : undefined
    )
    .filter(Boolean)
    .filter(({ rect }) => {
      const overlap = Math.min(rect[2], caption.rect[2]) - Math.max(rect[0], caption.rect[0])
      const gap = caption.rect[1] - rect[3]
      // A detached vector panel in the vertical band between the raster and
      // its caption belongs to the same composite figure. Keep the generic
      // association pass in charge so it can join that panel instead of
      // letting this narrow raster shortcut steal the caption.
      const pathInFigureBand = paths.some(
        (path) =>
          path[1] < caption.rect[1] &&
          path[3] <= rect[1] &&
          rect[1] - path[3] <= Math.max(24, page.height * 0.2)
      )
      return (
        rect[2] - rect[0] >= font * 8 &&
        rect[3] - rect[1] >= font * 8 &&
        gap >= 0 &&
        gap <= Math.max(8, font * 2) &&
        overlap >= Math.min(rect[2] - rect[0], caption.rect[2] - caption.rect[0]) * 0.2 &&
        !pathInFigureBand &&
        !paths.some((path) => nearby(rect, path) || nearby(caption.rect, path)) &&
        !tables.some((table) => intersection(table, rect) > 0) &&
        !captions.some((other) => other !== caption && intersection(other.rect, rect) > 0)
      )
    })
  if (candidates.length !== 1) return
  return { caption, rect: candidates[0].rect, graphicsCount: 1 }
}

// A single composite raster in a narrow column can have a larger typesetting
// gap before its caption than the ordinary raster shortcut allows. Keep this
// fallback stricter than the normal matcher: require one image, at least 80%
// horizontal overlap, and no competing graphics, tables, or captions.
export function nativeCaptionedRasterModerateGap(page, caption, captions, tables) {
  const firstLine = caption.lines?.[0] ?? ''
  if (!/^(?:figure|fig\.?)[ \t]+\d+[.:]/i.test(firstLine)) return
  const font = captionFont(page, caption)
  if (!(font > 0) || !Number.isFinite(font)) return
  const paths = (page.graphicsBounds ?? [])
    .filter((g) => g.kind === 'path')
    .map((g) =>
      g.normalizedRect?.every(Number.isFinite)
        ? g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
        : undefined
    )
    .filter(Boolean)
  const allImages = (page.graphicsBounds ?? []).filter(
    (g) => g.kind === 'image' && g.normalizedRect?.every(Number.isFinite)
  )
  if (allImages.length !== 1) return
  const images = allImages
    .map((g) => ({ rect: g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)) }))
    .filter(({ rect }) => {
      const overlap = Math.min(rect[2], caption.rect[2]) - Math.max(rect[0], caption.rect[0])
      const gap = caption.rect[1] - rect[3]
      const width = rect[2] - rect[0]
      const height = rect[3] - rect[1]
      const pathInBand = paths.some(
        (path) =>
          path[1] < caption.rect[1] &&
          path[3] <= rect[1] &&
          rect[1] - path[3] <= Math.max(24, page.height * 0.2)
      )
      return (
        width >= font * 8 &&
        height >= font * 8 &&
        gap >= 0 &&
        gap <= Math.max(24, font * 3) &&
        overlap >= width * 0.8 &&
        !pathInBand &&
        !tables.some((table) => intersection(table, rect) > 0) &&
        !captions.some((other) => other !== caption && intersection(other.rect, rect) > 0)
      )
    })
  if (images.length !== 1 || paths.some((path) => intersection(path, images[0].rect) > 0)) return
  return { caption, rect: images[0].rect, graphicsCount: 1, reason: 'native-raster-moderate-gap' }
}

// Some publishers paint a raster plate and its border as separate image/path
// operations. On stacked pages the ordinary adjacency pass sees both plates
// and declines the caption. Recover only one uniquely nearest framed image;
// never widen the crop to include a neighbouring plate.
export function nativeCaptionedFramedRaster(page, caption, captions, tables) {
  // Decimal continuation labels (for example Figure 4.1) commonly annotate
  // the preceding plate rather than introduce a new graphic. Leave those to
  // the established panel recognizer so the strict recovery cannot steal a
  // neighboring stacked image.
  if (/\b(?:Figure|Fig\.?)[ \t]+\d+\.\d+\b/i.test(caption.lines?.[0] ?? '')) return
  const toRect = (graphic) => {
    const source = graphic?.normalizedRect
    return source?.every(Number.isFinite)
      ? source.map((value, index) => value * (index % 2 ? page.height : page.width))
      : undefined
  }
  const images = (page.graphicsBounds ?? [])
    .filter((graphic) => graphic.kind === 'image')
    .map((graphic) => ({ rect: toRect(graphic) }))
    .filter(({ rect }) => rect && area(rect) >= page.width * page.height * 0.01)
  const frames = (page.graphicsBounds ?? [])
    .filter((graphic) => graphic.kind === 'path')
    .map((graphic) => ({ rect: toRect(graphic) }))
    .filter(({ rect }) => rect && area(rect) > 0)
  const frameTolerance = Math.max(8, page.width * 0.025, page.height * 0.04)
  const overlapRatio = (a, b) =>
    Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) /
    Math.max(1, Math.min(a[2] - a[0], b[2] - b[0]))
  const candidates = images
    .map(({ rect }) => {
      const frame = frames.find(
        ({ rect: candidate }) =>
          candidate &&
          overlapRatio(candidate, rect) >= 0.96 &&
          Math.abs(candidate[0] - rect[0]) <= frameTolerance &&
          Math.abs(candidate[1] - rect[1]) <= frameTolerance &&
          Math.abs(candidate[2] - rect[2]) <= frameTolerance &&
          Math.abs(candidate[3] - rect[3]) <= frameTolerance
      )
      if (!frame) return undefined
      // Painted image bounds can be inset from the publisher's border by
      // several pixels. Use the matched frame for ownership and crop gaps so
      // a caption immediately below the border is not stolen by a lower plate.
      const cropRect = frame.rect ?? rect
      if (overlapRatio(cropRect, caption.rect) < 0.8) return undefined
      const aboveGap = caption.rect[1] - cropRect[3]
      const belowGap = cropRect[1] - caption.rect[3]
      const direction =
        aboveGap >= 0 && aboveGap <= 24
          ? 'above'
          : belowGap >= 0 && belowGap <= 24
            ? 'below'
            : undefined
      if (!direction) return undefined
      // A caption below an image is usually the trailing caption for the
      // preceding plate. If another caption is already immediately above that
      // same image, keep the ownership with the preceding caption and avoid
      // assigning the image twice on stacked pages.
      if (
        aboveGap >= 0 &&
        captions.some(
          (other) =>
            other !== caption &&
            other.rect[3] <= cropRect[1] &&
            cropRect[1] - other.rect[3] <= 24 &&
            overlapRatio(other.rect, cropRect) >= 0.8
        )
      )
        return undefined
      if (
        tables.some((table) => intersection(table, cropRect) > 0) ||
        captions.some((other) => other !== caption && intersection(other.rect, cropRect) > 0)
      )
        return undefined
      return {
        rect: cropRect,
        direction,
        gap: direction === 'above' ? aboveGap : belowGap
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.gap - b.gap)
  // When a caption sits between two stacked plates, its preceding plate is
  // the stronger ownership signal: the following plate commonly belongs to
  // the next caption on the next page. Prefer the unique above candidate;
  // otherwise require exactly one below candidate.
  const above = candidates.filter((candidate) => candidate.direction === 'above')
  const below = candidates.filter((candidate) => candidate.direction === 'below')
  const selected = above.length ? above : below
  if (selected.length !== 1) return undefined
  return { caption, rect: selected[0].rect, graphicsCount: 1 }
}

// UI-style examples can place a raster image beside a prompt/response panel
// inside one outer frame. The frame is the figure boundary even though the
// raster does not share that boundary and the panel uses the same body font
// as the caption. Accept only one enclosing frame with a substantial raster,
// a caption directly below it, and no table or competing caption overlap.
export function nativeCaptionedFramedRasterTextPanel(page, caption, captions, tables) {
  const toRect = (graphic) => {
    const source = graphic?.normalizedRect
    return source?.every(Number.isFinite)
      ? source.map((value, index) => value * (index % 2 ? page.height : page.width))
      : undefined
  }
  const contains = (outer, inner, tolerance = 2) =>
    inner[0] >= outer[0] - tolerance &&
    inner[1] >= outer[1] - tolerance &&
    inner[2] <= outer[2] + tolerance &&
    inner[3] <= outer[3] + tolerance
  const rawFrames = (page.graphicsBounds ?? [])
    .filter((graphic) => graphic.kind === 'path')
    .map((graphic) => toRect(graphic))
    .filter((rect) => rect && area(rect) >= page.width * page.height * 0.04)
  const frameGroups = []
  for (const frame of rawFrames.sort((a, b) => a[1] - b[1])) {
    const group = frameGroups.find((candidate) => {
      const horizontal =
        Math.max(0, Math.min(candidate.rect[2], frame[2]) - Math.max(candidate.rect[0], frame[0])) /
        Math.max(1, Math.min(candidate.rect[2] - candidate.rect[0], frame[2] - frame[0]))
      const verticalGap =
        Math.max(candidate.rect[1], frame[1]) - Math.min(candidate.rect[3], frame[3])
      return horizontal >= 0.9 && verticalGap <= 8
    })
    if (group) group.rect = union([group.rect, frame])
    else frameGroups.push({ rect: frame.slice() })
  }
  const frames = frameGroups.map(({ rect }) => rect)
  const images = (page.graphicsBounds ?? [])
    .filter((graphic) => graphic.kind === 'image')
    .map((graphic) => toRect(graphic))
    .filter((rect) => rect && area(rect) >= page.width * page.height * 0.01)
  const candidates = frames
    .map((frame) => {
      if (caption.rect[1] - frame[3] < 0 || caption.rect[1] - frame[3] > 24) return undefined
      if (
        tables.some((table) => intersection(table, frame) > 0) ||
        captions.some((other) => other !== caption && intersection(other.rect, frame) > 0)
      )
        return undefined
      const enclosedImages = images.filter((image) => contains(frame, image))
      if (enclosedImages.length < 1 || enclosedImages.length > 4) return undefined
      if (enclosedImages.reduce((total, image) => total + area(image), 0) < area(frame) * 0.1)
        return undefined
      const panelLines = (page.lines ?? []).filter(
        (line) => line.text?.trim() && contains(frame, lineRect(line), 1)
      )
      if (panelLines.length < 2) return undefined
      return {
        frame,
        imageKey: enclosedImages
          .map((image) => image.join(','))
          .sort()
          .join('|'),
        gap: caption.rect[1] - frame[3]
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.gap - b.gap)
  const imageKeys = new Set(candidates.map((candidate) => candidate.imageKey))
  if (imageKeys.size === 1 && candidates.length > 1) {
    candidates.sort((a, b) => area(b.frame) - area(a.frame))
  }
  if (imageKeys.size !== 1 || candidates.length < 1) return undefined
  return { caption, rect: candidates[0].frame, graphicsCount: 1 }
}

// Explicit sequential caption keys must each match one raster and its own
// physically attached source key. Caption centering cannot define plate width.
export function nativeLetteredRasterArray(page, caption, captions, tables, tokens) {
  const keys = [...caption.lines.join(' ').matchAll(/\(([a-z])\)/g)].map((m) => m[1])
  const font = captionFont(page, caption)
  if (
    keys.length < 3 ||
    keys.length > 12 ||
    !(font > 0) ||
    !Number.isFinite(font) ||
    new Set(keys).size !== keys.length ||
    keys.some((k, i) => k.charCodeAt(0) !== 97 + i)
  )
    return
  const source = tokens.filter(
    (t) => t.horizontal && t.rect?.every(Number.isFinite) && area(t.rect) > 0
  )
  const labels = source
    .filter((t) => /^\([a-z]\)$/.test(t.text.trim()))
    .map((t) => ({ key: t.text.trim()[1], rect: t.rect }))
  for (const t of source.filter((t) => /^[a-z]$/.test(t.text.trim()))) {
    const adjacent = (p, left) =>
      Math.abs(p.baseline - t.baseline) < font * 0.05 &&
      Math.abs(p.height - t.height) < font * 0.05 &&
      Math.abs(left ? t.rect[0] - p.rect[2] : p.rect[0] - t.rect[2]) < font * 0.05
    const open = source.filter((p) => p.text === '(' && adjacent(p, true))
    const close = source.filter((p) => p.text === ')' && adjacent(p, false))
    if (open.length === 1 && close.length === 1)
      labels.push({ key: t.text.trim(), rect: union([open[0].rect, t.rect, close[0].rect]) })
  }
  const images = graphics(page, 'image').filter(
    (r) => r[3] < caption.rect[1] && r[2] - r[0] > font * 4 && r[3] - r[1] > font * 4
  )
  const pairs = keys.map((key) => {
    const attached = labels
      .filter((t) => t.key === key && t.rect[3] < caption.rect[1])
      .flatMap((t) =>
        images
          .filter(
            (r) =>
              t.rect[1] >= r[3] - font * 0.3 &&
              t.rect[1] - r[3] < font * 2 &&
              t.rect[0] >= r[0] &&
              t.rect[2] <= r[2]
          )
          .map((r) => ({ label: t.rect, image: r }))
      )
    return attached.length === 1 ? attached[0] : undefined
  })
  if (
    pairs.some((p) => !p) ||
    new Set(pairs.map((p) => p.image)).size !== keys.length ||
    pairs.some((p, i) => pairs.slice(0, i).some((q) => intersection(p.image, q.image) > 0))
  )
    return
  const rect = union(pairs.flatMap((p) => [p.image, p.label]))
  if (
    caption.rect[1] - rect[3] > font * 3 ||
    blocked(rect, caption, captions, tables) ||
    source.some((t) => t.text.length >= 40 && intersection(t.rect, rect) > 0)
  )
    return
  return { caption, rect, graphicsCount: pairs.length }
}

// Some PDFs split a compact ``Fig.2.`` prefix away from the caption candidate
// when that prefix shares a baseline with the final raster panel. Recover this
// narrow case only when the page has one unique 2x2 raster plate and the merged
// caption proves a complete (a)-(d) sequence. The extra prefix proof keeps
// running prose references and open vector plots out of this recovery path.
export function nativeCaptionedRasterArrayFragment(page, caption, captions, tables) {
  const lines = page.lines ?? []
  const prefix = lines.find((line) => {
    if (!line?.text || /^(?:Fig(?:ure)?\s*\.?\s*\d+\.)/i.test(caption.lines?.[0] ?? ''))
      return false
    if (!/^(?:Fig(?:ure)?\s*\.?\s*\d+\.)/i.test(line.text.trim())) return false
    const font = Math.max(line.fontSize || 0, 1)
    return (
      Math.abs(line.y - caption.rect[1]) <= font * 1.2 &&
      Math.abs(line.x - caption.rect[0]) <= font * 1.2 &&
      !caption.lines.some((text) => text.trim() === line.text.trim())
    )
  })
  if (!prefix) return
  const font = Math.max(prefix.fontSize || 0, 1)
  const bandLines = lines
    .filter(
      (line) =>
        line.y >= caption.rect[1] - font * 0.5 &&
        line.y <= caption.rect[3] + font * 0.5 &&
        line.x >= caption.rect[0] - font &&
        line.x + line.width <= caption.rect[2] + font &&
        !captions.some((other) => other !== caption && intersection(other.rect, lineRect(line)) > 0)
    )
    .sort((a, b) => a.y - b.y || a.x - b.x)
  const text = bandLines.map((line) => line.text).join(' ')
  if (!/\(a\).*?\(b\).*?\(c\).*?\(d\)/s.test(text)) return
  const images = graphics(page, 'image').filter((rect) => {
    if (
      !rect.every(Number.isFinite) ||
      rect[2] - rect[0] < font * 4 ||
      rect[3] - rect[1] < font * 4
    )
      return false
    return (
      rect[1] < caption.rect[1] + font * 2 &&
      !tables.some((table) => intersection(table, rect) > 0) &&
      !captions.some((other) => other !== caption && intersection(other.rect, rect) > 0)
    )
  })
  if (images.length !== 4) return
  const widths = images.map((rect) => rect[2] - rect[0])
  const heights = images.map((rect) => rect[3] - rect[1])
  const median = (values) => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)]
  const width = median(widths)
  const height = median(heights)
  if (
    widths.some((value) => Math.abs(value - width) > width * 0.25) ||
    heights.some((value) => Math.abs(value - height) > height * 0.25)
  )
    return
  const rows = []
  for (const rect of images.slice().sort((a, b) => a[1] - b[1])) {
    const row = rows.find(({ rects }) => Math.abs(rects[0][1] - rect[1]) <= height * 0.45)
    if (row) row.rects.push(rect)
    else rows.push({ rects: [rect] })
  }
  if (rows.length !== 2 || rows.some((row) => row.rects.length !== 2)) return
  const centers = rows
    .flatMap(({ rects }) => rects.map((rect) => (rect[0] + rect[2]) / 2))
    .sort((a, b) => a - b)
  const columns = []
  for (const center of centers) {
    const previous = columns.at(-1)
    if (previous === undefined || center - previous > width * 0.5) columns.push(center)
    else columns[columns.length - 1] = (previous + center) / 2
  }
  if (columns.length !== 2 || columns[1] - columns[0] < width * 0.5) return
  const rect = union(images)
  if (blocked(rect, caption, captions, tables)) return
  const captionLines = bandLines.map((line) => line.text)
  const captionRect = union([caption.rect, lineRect(prefix)])
  return {
    caption,
    captionLines,
    captionRect,
    rect,
    graphicsCount: images.length
  }
}

// Some papers encode a trajectory plate as many equal raster tiles instead of
// one composite image. Require a coherent multi-row grid directly above its
// caption so decorative icons and neighboring column images cannot widen the
// figure crop by accident.
// Some papers encode a compact four-panel result plate as four independent
// raster operations while keeping the caption as an ordinary Figure line.
// Require a complete 2x2 image grid directly above that caption; this avoids
// widening a crop from a single nearby image or from an unrelated table.
export function nativeCaptionedRasterQuad(page, caption, captions, tables) {
  const firstLine = caption.lines?.[0] ?? ''
  if (!/^(?:figure|fig\.?)[ \t]+\d+[.:]/i.test(firstLine)) return
  const font = captionFont(page, caption)
  if (!(font > 0) || !Number.isFinite(font)) return
  const images = graphics(page, 'image').filter((rect) => {
    if (!rect.every(Number.isFinite) || rect[2] <= rect[0] || rect[3] <= rect[1]) return false
    if (rect[3] > caption.rect[1] || rect[1] < page.height * 0.04) return false
    if (tables.some((table) => intersection(table, rect) > 0)) return false
    if (captions.some((other) => other !== caption && intersection(other.rect, rect) > 0))
      return false
    return rect[2] - rect[0] >= font * 4 && rect[3] - rect[1] >= font * 4
  })
  if (images.length !== 4) return
  const widths = images.map((rect) => rect[2] - rect[0])
  const heights = images.map((rect) => rect[3] - rect[1])
  const median = (values) => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)]
  const width = median(widths)
  const height = median(heights)
  if (
    widths.some((value) => Math.abs(value - width) > width * 0.25) ||
    heights.some((value) => Math.abs(value - height) > height * 0.25)
  )
    return
  const rows = []
  for (const rect of images.slice().sort((a, b) => a[1] - b[1])) {
    const row = rows.find(({ anchor }) => Math.abs(anchor[1] - rect[1]) <= height * 0.45)
    if (row) row.rects.push(rect)
    else rows.push({ rects: [rect], anchor: rect })
  }
  if (rows.length !== 2 || rows.some((row) => row.rects.length !== 2)) return
  const centers = rows
    .flatMap(({ rects }) => rects.map((rect) => (rect[0] + rect[2]) / 2))
    .sort((a, b) => a - b)
  const columns = []
  for (const center of centers) {
    const previous = columns.at(-1)
    if (previous === undefined || center - previous > width * 0.45) columns.push(center)
    else columns[columns.length - 1] = (previous + center) / 2
  }
  if (columns.length !== 2 || columns[1] - columns[0] < width * 0.45) return
  const bounds = union(images)
  const gap = caption.rect[1] - bounds[3]
  if (
    gap < 0 ||
    gap > Math.max(font * 3, 24) ||
    Math.min(bounds[2], caption.rect[2]) - Math.max(bounds[0], caption.rect[0]) <
      Math.min(bounds[2] - bounds[0], caption.rect[2] - caption.rect[0]) * 0.5 ||
    blocked(bounds, caption, captions, tables)
  )
    return
  return { caption, rect: bounds, graphicsCount: images.length, reason: 'native-raster-quad' }
}

// Some papers render a comparison plate as two side-by-side raster panels,
// each with three tiles per row and four rows.  The generic grid matcher can
// reject this shape when the two panels use different tile widths, leaving a
// lower subset as the figure.  Recover only a complete four-row, six-tile
// band whose two panel clusters are separated on every row and whose bottom
// edge is immediately followed by this caption.
export function nativeCaptionedRasterDualPanelGrid(page, caption, captions, tables) {
  const firstLine = caption.lines?.[0] ?? ''
  if (!/^(?:figure|fig\.?)[ \t]+\d+[.:]/i.test(firstLine)) return
  const font = captionFont(page, caption)
  if (!(font > 0) || !Number.isFinite(font)) return
  const images = graphics(page, 'image').filter((rect) => {
    if (!rect.every(Number.isFinite) || rect[2] <= rect[0] || rect[3] <= rect[1]) return false
    if (rect[3] > caption.rect[1] || rect[1] < page.height * 0.04) return false
    if (tables.some((table) => intersection(table, rect) > 0)) return false
    if (captions.some((other) => other !== caption && intersection(other.rect, rect) > 0))
      return false
    return rect[2] - rect[0] >= font * 3 && rect[3] - rect[1] >= font * 2
  })
  if (images.length < 24) return
  const widths = images.map((rect) => rect[2] - rect[0]).sort((a, b) => a - b)
  const heights = images.map((rect) => rect[3] - rect[1]).sort((a, b) => a - b)
  const median = (values) => values[Math.floor(values.length / 2)]
  const tileWidth = median(widths)
  const tileHeight = median(heights)
  if (!(tileWidth > 0) || !(tileHeight > 0)) return
  const rows = []
  for (const rect of images.slice().sort((a, b) => a[1] - b[1])) {
    const row = rows.find(({ anchor }) => Math.abs(anchor - rect[1]) <= tileHeight * 0.45)
    if (row) row.rects.push(rect)
    else rows.push({ anchor: rect[1], rects: [rect] })
  }
  if (rows.length !== 4 || rows.some((row) => row.rects.length !== 6)) return
  const panelSplit = (rects) => {
    const centers = rects.map((rect) => (rect[0] + rect[2]) / 2).sort((a, b) => a - b)
    const gaps = centers.slice(1).map((center, index) => ({
      index,
      gap: center - centers[index]
    }))
    const split = gaps.sort((a, b) => b.gap - a.gap)[0]
    if (!split || split.gap < tileWidth * 1.05) return
    const left = rects.filter((rect) => (rect[0] + rect[2]) / 2 <= centers[split.index])
    const right = rects.filter((rect) => (rect[0] + rect[2]) / 2 > centers[split.index])
    if (left.length !== 3 || right.length !== 3) return
    return { left, right }
  }
  const panels = rows.map((row) => panelSplit(row.rects))
  if (panels.some((panel) => !panel)) return
  const leftBounds = union(panels.flatMap((panel) => panel.left))
  const rightBounds = union(panels.flatMap((panel) => panel.right))
  if (leftBounds[2] >= rightBounds[0]) return
  const bounds = union([leftBounds, rightBounds])
  const gap = caption.rect[1] - bounds[3]
  if (gap < 0 || gap > Math.max(font * 3, 24) || blocked(bounds, caption, captions, tables)) return
  return {
    caption,
    rect: bounds,
    graphicsCount: images.length,
    reason: 'native-raster-dual-panel-grid'
  }
}

export function nativeRasterGrid(page, caption, captions, tables) {
  const font = captionFont(page, caption)
  if (!(font > 0) || !Number.isFinite(font)) return
  const allImages = (page.graphicsBounds ?? [])
    .filter((g) => g.kind === 'image')
    .map((g) => ({
      rect: (g.paintedNormalizedRect ?? g.normalizedRect).map(
        (v, i) => v * (i % 2 ? page.height : page.width)
      )
    }))
    .filter(
      ({ rect }) =>
        rect.every(Number.isFinite) &&
        rect[2] - rect[0] >= font * 4 &&
        rect[3] - rect[1] >= font * 4 &&
        rect[3] <= caption.rect[1] &&
        !tables.some((table) => intersection(table, rect) > 0) &&
        !captions.some((other) => other !== caption && intersection(other.rect, rect) > 0)
    )
  if (allImages.length < 8) return
  const widths = allImages.map(({ rect }) => rect[2] - rect[0])
  const heights = allImages.map(({ rect }) => rect[3] - rect[1])
  const median = (values) => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)]
  const width = median(widths)
  const height = median(heights)
  if (!(width > 0) || !(height > 0)) return

  // A page can contain several raster grids with identical tile geometry.
  // Cluster by horizontal proximity first, then split vertically at the
  // whitespace between figure bands. This keeps a caption from claiming a
  // neighboring grid merely because all of its tiles sit above the caption.
  const clusterGap = Math.max(width * 1.5, font * 8)
  const horizontalClusters = []
  for (const image of allImages.slice().sort((a, b) => a.rect[0] - b.rect[0])) {
    const cluster = horizontalClusters.find(
      ({ bounds }) =>
        image.rect[0] <= bounds[2] + clusterGap && image.rect[2] >= bounds[0] - clusterGap
    )
    if (cluster) {
      cluster.images.push(image)
      cluster.bounds = union(cluster.images.map(({ rect }) => rect))
    } else horizontalClusters.push({ images: [image], bounds: image.rect.slice() })
  }
  const candidates = []
  for (const cluster of horizontalClusters) {
    const clusterWidths = cluster.images.map(({ rect }) => rect[2] - rect[0])
    const clusterHeights = cluster.images.map(({ rect }) => rect[3] - rect[1])
    const clusterWidth = median(clusterWidths)
    const clusterHeight = median(clusterHeights)
    if (
      clusterWidths.some((value) => Math.abs(value - clusterWidth) > clusterWidth * 0.2) ||
      clusterHeights.some((value) => Math.abs(value - clusterHeight) > clusterHeight * 0.2)
    )
      continue
    const rows = []
    for (const image of cluster.images.slice().sort((a, b) => a.rect[1] - b.rect[1])) {
      const row = rows.find(({ rect }) => Math.abs(rect[1] - image.rect[1]) <= clusterHeight * 0.45)
      if (row) {
        row.images.push(image)
        row.rect = union(row.images.map(({ rect }) => rect))
      } else rows.push({ images: [image], rect: image.rect.slice() })
    }
    const blocks = []
    for (const row of rows) {
      const previous = blocks.at(-1)
      if (
        previous &&
        row.rect[1] - previous.rows.at(-1).rect[3] <= Math.max(clusterHeight * 1.25, font * 6)
      ) {
        previous.rows.push(row)
        previous.images.push(...row.images)
      } else blocks.push({ rows: [row], images: row.images.slice() })
    }
    for (const block of blocks) {
      if (block.rows.length < 2 || block.rows.some((row) => row.images.length < 3)) continue
      const bounds = union(block.images.map(({ rect }) => rect))
      const gap = caption.rect[1] - bounds[3]
      const horizontalOverlap = Math.max(
        0,
        Math.min(bounds[2], caption.rect[2]) - Math.max(bounds[0], caption.rect[0])
      )
      const overlapRatio =
        horizontalOverlap / Math.min(bounds[2] - bounds[0], caption.rect[2] - caption.rect[0])
      const interveningCaption = captions.some(
        (other) =>
          other !== caption &&
          other.page === caption.page &&
          other.rect[1] >= bounds[3] - font &&
          other.rect[3] <= caption.rect[1] + font &&
          intersection(other.rect, bounds) > 0
      )
      if (
        gap < 0 ||
        gap > Math.max(font * 7, page.height * 0.1) ||
        overlapRatio < 0.5 ||
        interveningCaption
      )
        continue
      candidates.push({ block, bounds, gap, overlapRatio })
    }
  }
  const selected = candidates.sort((a, b) => a.gap - b.gap || b.overlapRatio - a.overlapRatio)[0]
  if (!selected) return
  const { images, rows } = selected.block
  const columns = rows
    .flatMap((row) => row.images)
    .map(({ rect }) => (rect[0] + rect[2]) / 2)
    .sort((a, b) => a - b)
  const columnCenters = []
  for (const center of columns) {
    const previous = columnCenters.at(-1)
    if (previous === undefined || center - previous > width * 0.55) columnCenters.push(center)
    else columnCenters[columnCenters.length - 1] = (previous + center) / 2
  }
  if (
    columnCenters.length < 3 ||
    rows.filter((row) => row.images.length >= columnCenters.length * 0.6).length < 2
  )
    return
  const bounds = union(images.map(({ rect }) => rect))
  if (
    bounds[3] >= caption.rect[1] ||
    caption.rect[1] - bounds[3] > Math.max(font * 7, page.height * 0.1) ||
    area(bounds) < page.width * page.height * 0.01
  )
    return
  const attached = (page.lines ?? []).filter(
    (line) =>
      line.text.trim() &&
      line.text.length < 40 &&
      line.y >= bounds[3] - font &&
      line.y + line.height <= caption.rect[1] &&
      line.x >= bounds[0] - font * 2 &&
      line.x + line.width <= bounds[2] + font * 2 &&
      !captions.some((other) => other !== caption && intersection(other.rect, lineRect(line)) > 0)
  )
  const rect = union([bounds, ...attached.map(lineRect)])
  return { caption, rect, graphicsCount: images.length }
}
