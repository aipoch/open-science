/* eslint-disable @typescript-eslint/explicit-function-return-type */

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

// Whole-page sideways tables use rotated text even when /Rotate is zero.
// Require a strong majority or an explicit sideways table caption, so isolated
// chart axes cannot rotate a normal page. A short continued table can share a
// page with upright prose; do not apply that exception over an upright caption.
export const readingRotation = (page, content) => {
  const items = content.items.filter((item) => 'str' in item && item.str.trim())
  const weight = (item) => item.str.replace(/\s/gu, '').length
  const total = items.reduce((sum, item) => sum + weight(item), 0)
  const caption = (item) =>
    /^(?:Table|Tab\.|Figure|Fig\.)\s+(?:\d+|[IVXLCDM]+)(?:[.:\s]|$)/i.test(item.str)
  // A bold caption label and its number can be separate PDF text runs.
  // Require adjacency along the same baseline, not merely a nearby digit.
  const splitCaption = (item, rotation) => {
    if (!/^(?:Table|Tab\.|Figure|Fig\.)$/i.test(item.str.trim())) return false
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
        (/^Table\s+(?:\d+|[IVXLCDM]+)(?:[.:\s]|$)/i.test(item.str) ||
          (/^Table$/i.test(item.str.trim()) && splitCaption(item, rotation)))
    )
    if (aligned >= 100 && (aligned >= total * 0.8 || tableCaption)) return rotation
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
