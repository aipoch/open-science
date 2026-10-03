/*
 * Normalize the order of ordinary text lines on pages that have a clear
 * two-column layout. PDF text streams commonly interleave columns by paint
 * order, which is unsuitable for unstructured text consumers. Keep the
 * geometry objects intact and only change their array order; caption/table
 * grouping still performs its own spatial checks.
 */

const finiteLine = (line) =>
  line &&
  [line.x, line.y, line.width, line.height].every(Number.isFinite) &&
  line.width > 0 &&
  line.height > 0

const byReadingPosition = (left, right) => left.y - right.y || left.x - right.x

const splitColumns = (page, lines) => {
  if (!(page?.width > 0) || lines.length < 8) return
  const candidates = lines.filter(
    (line) =>
      finiteLine(line) &&
      line.x >= 0 &&
      line.x + line.width <= page.width + 0.5 &&
      line.width <= page.width * 0.55
  )
  if (candidates.length < 6) return
  const starts = [...new Set(candidates.map((line) => Math.round(line.x * 10) / 10))].sort(
    (a, b) => a - b
  )
  if (starts.length < 2) return
  const minimumGap = Math.max(32, page.width * 0.1)
  let split
  for (let index = 0; index < starts.length - 1; index++) {
    const gap = starts[index + 1] - starts[index]
    if (!split || gap > split.gap)
      split = { gap, threshold: (starts[index] + starts[index + 1]) / 2 }
  }
  if (!split || split.gap < minimumGap) return
  // Use the left edge for membership. A normal column line can be wider than
  // the midpoint (especially when it ends close to the gutter), so requiring
  // its right edge to stay left of the midpoint would reject valid layouts.
  const left = candidates.filter((line) => line.x <= split.threshold - 4)
  const right = candidates.filter((line) => line.x >= split.threshold + 4)
  if (left.length < 3 || right.length < 3) return
  if (Math.min(left.length, right.length) < candidates.length * 0.2) return
  return { left, right, threshold: split.threshold }
}

const reorderBand = (band, layout) => {
  const left = [],
    right = [],
    other = []
  for (const line of band) {
    if (line.x <= layout.threshold - 4) left.push(line)
    else if (line.x >= layout.threshold + 4) right.push(line)
    else other.push(line)
  }
  if (!left.length || !right.length) return [...band].sort(byReadingPosition)
  // Keep full-width headings/footers in their visual position while making
  // each bounded band column-major. Unassigned fragments are retained after
  // the two columns so no source text disappears.
  return [
    ...left.sort(byReadingPosition),
    ...right.sort(byReadingPosition),
    ...other.sort(byReadingPosition)
  ]
}

export function normalizePageLineOrder(page) {
  const lines = Array.isArray(page?.lines) ? page.lines : []
  if (lines.length < 8) return lines
  const layout = splitColumns(page, lines)
  if (!layout) return lines
  const wide = lines
    .filter((line) => finiteLine(line) && line.width > page.width * 0.55)
    .sort(byReadingPosition)
  if (!wide.length) return reorderBand(lines, layout)

  const bands = []
  let cursor = 0
  for (const boundary of wide) {
    const next = lines.filter(
      (line) => line !== boundary && line.y >= cursor && line.y < boundary.y
    )
    if (next.length) bands.push(reorderBand(next, layout))
    bands.push([boundary])
    cursor = boundary.y + boundary.height
  }
  const tail = lines.filter(
    (line) => line !== undefined && line.y >= cursor && !wide.includes(line)
  )
  if (tail.length) bands.push(reorderBand(tail, layout))
  const result = bands.flat()
  return result.length === lines.length ? result : lines
}

export function hasClearTwoColumnLayout(page) {
  const lines = Array.isArray(page?.lines) ? page.lines : []
  return !!splitColumns(page, lines)
}
