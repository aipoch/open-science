/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'

export const isUprightText = (item, rotation) => {
  const angle = (rotation * Math.PI) / 180
  const [a, b, c, d] = item.transform
  return (
    item.dir === 'ltr' &&
    Math.abs(b * Math.cos(angle) - a * Math.sin(angle)) < 0.001 &&
    // Italic fonts may shear their vertical axis while the text baseline is
    // still horizontal. Do not discard their letters or unit symbols.
    Math.abs(c * Math.cos(angle) + d * Math.sin(angle)) <=
      Math.abs(d * Math.cos(angle) - c * Math.sin(angle)) * 0.5 &&
    a * Math.cos(angle) + b * Math.sin(angle) > 0
  )
}

// Sideways margin labels must not acquire a horizontal box that overlaps a
// nearby table. Transform all four corners along the item's own text axes.
export const rotatedTextRect = (item, viewport) => {
  const [a, b, c, d, x, y] = item.transform
  const baselineLength = Math.hypot(a, b) || 1
  const verticalLength = Math.hypot(c, d) || 1
  const dx = (a / baselineLength) * item.width
  const dy = (b / baselineLength) * item.width
  const hx = (c / verticalLength) * item.height
  const hy = (d / verticalLength) * item.height
  const corners = [
    [x, y],
    [x + dx, y + dy],
    [x + hx, y + hy],
    [x + dx + hx, y + dy + hy]
  ].map(([px, py]) => viewport.convertToViewportPoint(px, py))
  return [
    Math.min(...corners.map(([px]) => px)),
    Math.min(...corners.map(([, py]) => py)),
    Math.max(...corners.map(([px]) => px)),
    Math.max(...corners.map(([, py]) => py))
  ]
}

// A captionless continuation can occupy only a strip beside upright prose.
// Require repeated, separated measurement columns in several aligned rows;
// isolated axis labels, page numbers and narrative columns are not evidence.
const hasRepeatedMeasurementRows = (items, rotation) => {
  const angle = (rotation * Math.PI) / 180
  const numeric = items
    .filter(
      (item) =>
        isUprightText(item, rotation) &&
        item.height > 0 &&
        item.width > 0 &&
        /^[+−-]?\d[\d\s.,±%()[\]+−*–-]*(?:to[\d\s.,+−–-]*)?\)?\**$/u.test(item.str.trim())
    )
    .map((item) => ({
      ...item,
      x: item.transform[4] * Math.cos(angle) + item.transform[5] * Math.sin(angle),
      y: -item.transform[4] * Math.sin(angle) + item.transform[5] * Math.cos(angle)
    }))
    .sort((a, b) => a.y - b.y || a.x - b.x)
  const rows = []
  for (const item of numeric) {
    const row = rows.at(-1)
    if (row && Math.abs(row[0].y - item.y) < item.height * 0.25) row.push(item)
    else rows.push([item])
  }
  // Short descriptive continuations may have count, mean (SD), and range
  // rather than two treatment columns. Repeated aligned triples still prove
  // a table orientation, even when manuscript furniture dominates the page.
  const summaries = rows.filter(
    (row) =>
      row.length === 3 &&
      /^\d+$/.test(row[0].str.trim()) &&
      /\d\s*\([^)]*\)/.test(row[1].str) &&
      /^\d+(?:\.\d+)?[–−-]\d+(?:\.\d+)?$/.test(row[2].str.trim()) &&
      row.slice(1).every((i, n) => i.x - row[n].x - row[n].width > i.height)
  )
  if (
    summaries.some(
      (anchor) =>
        summaries.filter((row) =>
          row.every(
            (item, n) =>
              Math.abs(item.x - anchor[n].x) <= item.height &&
              Math.abs(item.height - anchor[n].height) <= item.height * 0.1
          )
        ).length >= 4
    )
  )
    return true
  const measurements = rows
    .filter((row) => row.length >= 4)
    .map((row) => row.filter((item) => /\d\s*(?:±|\(|\[)/u.test(item.str)))
    .filter((row) => row.length >= 2)
  return measurements.some(
    (anchor) =>
      measurements.filter((row) =>
        anchor
          .slice(0, 2)
          .every((item) =>
            row.some(
              (peer) =>
                Math.abs(peer.x - item.x) <= item.height &&
                Math.abs(peer.height - item.height) <= item.height * 0.1
            )
          )
      ).length >= 4 && anchor[1].x - anchor[0].x - anchor[0].width > anchor[0].height
  )
}

// PDF.js includes UserUnit in the viewport transform, but not in text-item dimensions.
// Keep the entire token in viewport coordinates, including font size and upright bounds.
export const tableTextToken = (item, viewport, rotation) => {
  const [x, baseline] = viewport.convertToViewportPoint(item.transform[4], item.transform[5])
  const scale = Math.hypot(viewport.transform[0], viewport.transform[1])
  const horizontal = isUprightText(item, rotation)
  return {
    text: item.str,
    sourceItem: item.sourceItem,
    inlineSymbol: item.inlineSymbol === true,
    baseline,
    height: item.height * scale,
    rect: horizontal
      ? [x, baseline - item.height * scale, x + item.width * scale, baseline]
      : rotatedTextRect(item, viewport),
    horizontal
  }
}

// Whole-page sideways tables use rotated text even when /Rotate is zero.
// Require a strong majority or an explicit sideways table caption, so isolated
// chart axes cannot rotate a normal page. A short continued table can share a
// page with upright prose; do not apply that exception over an upright caption.
export const readingRotation = (page, content) => {
  const items = content.items.filter((item) => 'str' in item && item.str.trim())
  const weight = (item) => item.str.replace(/\s/gu, '').length
  const total = items.reduce((sum, item) => sum + weight(item), 0)
  const caption = (item) => captionKind(item.str) !== undefined
  // A bold caption label and its number can be separate PDF text runs.
  // Require adjacency along the same baseline, not merely a nearby digit.
  const splitCaption = (item, rotation) => {
    if (!/^(?:Table|Tableau|Tab\.|Figure|Fig\.)$/i.test(item.str.replace(/\s/g, ''))) return false
    const angle = (rotation * Math.PI) / 180
    return items.some((next) => {
      if (!/^\d+[.:]?$/.test(next.str.trim()) || !isUprightText(next, rotation)) return false
      const dx = next.transform[4] - item.transform[4]
      const dy = next.transform[5] - item.transform[5]
      const gap = dx * Math.cos(angle) + dy * Math.sin(angle) - item.width
      return (
        Math.abs(-dx * Math.sin(angle) + dy * Math.cos(angle)) < item.height * 0.1 &&
        Math.abs(next.height - item.height) < item.height * 0.1 &&
        gap >= -item.height * 0.1 &&
        gap <= item.height * 0.75
      )
    })
  }
  const uprightCaption = items.some(
    (item) => isUprightText(item, 0) && (caption(item) || splitCaption(item, 0))
  )
  if (uprightCaption) return 0
  for (const rotation of [90, 270, 0, 180]) {
    const aligned = items
      .filter((item) => isUprightText(item, rotation))
      .reduce((sum, item) => sum + weight(item), 0)
    const tableCaption = items.some(
      (item) =>
        isUprightText(item, rotation) &&
        (captionKind(item.str) === 'table' ||
          (/^(?:Table|Tableau|Tab\.)$/i.test(item.str.replace(/\s/g, '')) &&
            splitCaption(item, rotation)))
    )
    if (
      aligned >= 100 &&
      (aligned >= total * 0.8 ||
        tableCaption ||
        ((rotation === 90 || rotation === 270) && hasRepeatedMeasurementRows(items, rotation)))
    )
      return rotation
  }
  return page.rotate
}

// Convert upright analysis coordinates back to the unchanged PDF page for links
// and cell provenance. Width/height are those of the upright analysis viewport.
export const originalRect = ([x0, y0, x1, y1], width, height, rotation) => {
  if (rotation === 180) return [width - x1, height - y1, width - x0, height - y0]
  if (rotation === 90) return [y0, width - x1, y1, width - x0]
  if (rotation === 270) return [height - y1, x0, height - y0, x1]
  return [x0, y0, x1, y1]
}

// Caption parts can live on pages with different analysis rotations. Restore
// each source rectangle independently without mutating shared part objects.
export const restoreCaptionCoordinates = (caption, pages) => {
  if (!caption) return
  const restore = (part) => {
    const page = pages.find((p) => p.pageNumber === part.page)
    return page
      ? {
          ...part,
          rect: originalRect(
            part.rect,
            page.width,
            page.height,
            (page.renderRotation - page.rotation + 360) % 360
          )
        }
      : part
  }
  caption.rect = restore(caption).rect
  if (caption.regions) caption.regions = caption.regions.map(restore)
}
