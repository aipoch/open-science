/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'

// Three aligned top/bottom stroke segments can retain native column ownership
// after a crop loses the opening rule. Restrict recovery to a wrapped count /
// percentage leaf band; a parent crossing lanes or any child underline rejects it.
export function recoverSegmentedLeafHeaderBand(table, items, captions, rules) {
  const crop = table.cropRect
  if (!crop || table.readingRotation) return
  const source = items.filter(
    (i) =>
      i.horizontal &&
      i.height > 0 &&
      i.text.trim() &&
      i.rect[0] >= crop[0] &&
      i.rect[2] <= crop[2] &&
      i.rect[1] > crop[1] - i.height &&
      i.rect[3] <= crop[3]
  )
  const heights = source.map((i) => i.height).sort((a, b) => a - b)
  const height = heights[Math.floor(heights.length / 2)]
  if (!(height > 0)) return
  const epsilon = height * 0.1
  const horizontal = rules.filter(
    (r) =>
      Math.abs(r[3] - r[1]) < 0.01 && r[0] >= crop[0] && r[2] <= crop[2] && r[2] - r[0] > height * 3
  )
  const bands = []
  for (const rule of horizontal) {
    let band = bands.find((b) => Math.abs(b.y - rule[1]) < 0.01)
    if (!band) bands.push((band = { y: rule[1], segments: [] }))
    band.segments.push(rule)
  }
  const tops = bands.filter((b) => Math.abs(b.y - crop[1]) < height && b.segments.length === 3)
  if (tops.length !== 1) return
  const top = tops[0],
    segments = top.segments.sort((a, b) => a[0] - b[0])
  if (segments.some((r, n) => n && Math.abs(r[0] - segments[n - 1][2]) > epsilon)) return
  const cuts = [segments[0][0], ...segments.map((r) => r[2])]
  if (cuts.at(-1) - cuts[0] < (crop[2] - crop[0]) * 0.8) return
  const bottoms = bands.filter(
    (b) =>
      b.y > top.y + height * 2 &&
      b.y < top.y + height * 4 &&
      b.segments.length === 3 &&
      b.segments
        .sort((a, b) => a[0] - b[0])
        .every(
          (r, n) => Math.abs(r[0] - cuts[n]) < epsilon && Math.abs(r[2] - cuts[n + 1]) < epsilon
        )
  )
  if (bottoms.length !== 1) return
  const bottom = bottoms[0].y
  if (
    rules.some(
      (r) =>
        r[1] > top.y + epsilon && r[3] < bottom - epsilon && r[2] > cuts[0] && r[0] < cuts.at(-1)
    )
  )
    return
  const titles = captions.filter(
    (c) =>
      captionKind(c.lines[0]) === 'table' &&
      c.rect[3] <= top.y &&
      top.y - c.rect[3] < height * 2 &&
      c.rect[0] >= cuts[0] - height &&
      c.rect[2] <= cuts.at(-1) + height
  )
  if (titles.length !== 1) return
  const header = source.filter((i) => i.rect[1] > top.y && i.rect[3] < bottom)
  const lanes = cuts
    .slice(1)
    .map((x, n) =>
      header
        .filter((i) => i.rect[0] >= cuts[n] - epsilon && i.rect[2] <= x + epsilon)
        .sort((a, b) => a.baseline - b.baseline)
    )
  if (
    lanes.flat().length !== header.length ||
    lanes[0].length !== 2 ||
    lanes[1].length !== 2 ||
    lanes[2].length !== 1
  )
    return
  if (
    !/\b(?:and|of)\s*$/i.test(lanes[0][0].text) ||
    !/^(?:No\.|Number)\s+of\b/i.test(lanes[1][0].text) ||
    !/^(?:Percentage|Percent|%)$/i.test(lanes[2][0].text.trim())
  )
    return
  if (
    header.some((i) => Math.abs(i.height - height) > epsilon) ||
    Math.abs(lanes[0][0].baseline - lanes[1][0].baseline) > epsilon ||
    Math.abs(lanes[0][1].baseline - lanes[1][1].baseline) > epsilon ||
    Math.abs(lanes[0][1].baseline - lanes[2][0].baseline) > epsilon ||
    lanes.slice(0, 2).some((lane) => Math.abs(lane[0].rect[0] - lane[1].rect[0]) > epsilon)
  )
    return
  const records = source.filter((i) => i.rect[1] > bottom)
  const counts = records.filter(
    (i) =>
      /^\d+$/.test(i.text.trim()) &&
      i.rect[0] >= cuts[1] - epsilon &&
      i.rect[2] <= cuts[2] + epsilon
  )
  const complete = counts.filter(
    (count) =>
      records.some(
        (i) =>
          /^\d+(?:\.\d+)?$/.test(i.text.trim()) &&
          i.rect[0] >= cuts[2] - epsilon &&
          i.rect[2] <= cuts[3] + epsilon &&
          Math.abs(i.baseline - count.baseline) < epsilon
      ) &&
      records.some(
        (i) =>
          /\p{L}/u.test(i.text) &&
          i.rect[0] >= cuts[0] - epsilon &&
          i.rect[2] <= cuts[1] + epsilon &&
          Math.abs(i.baseline - count.baseline) < epsilon
      )
  )
  if (complete.length < 2) return
  return {
    cropRect: [crop[0], Math.min(crop[1], top.y), crop[2], crop[3]],
    columnRects: cuts.slice(1).map((x, n) => [cuts[n], top.y, x, crop[3]]),
    headerRect: [cuts[0], top.y, cuts.at(-1), bottom]
  }
}
