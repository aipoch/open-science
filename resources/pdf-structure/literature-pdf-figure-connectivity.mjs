/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { intersection } from './literature-pdf-page-geometry.mjs'

// Spatial bins accelerate the existing eight-point adjacency traversal. Large
// rectangles use a bounded fallback, so indexing never expands a page-sized
// path into an unbounded number of entries. Exact intersections remain decisive.
export function connectFigureGraphics(connected, pending) {
  const bins = new Map(),
    large = new Set(),
    locations = new Map()
  const order = new Map([...pending].map((item, n) => [item, n]))
  const keys = (rect) => {
    const [left, top, right, bottom] = rect.map((v) => Math.floor(v / 32))
    if ((right - left + 1) * (bottom - top + 1) > 64) return
    const result = []
    for (let x = left; x <= right; x++) for (let y = top; y <= bottom; y++) result.push(`${x},${y}`)
    return result
  }
  for (const item of pending) {
    const cells = keys(item.rect)
    locations.set(item, cells)
    if (!cells) large.add(item)
    else
      for (const key of cells) {
        if (!bins.has(key)) bins.set(key, new Set())
        bins.get(key).add(item)
      }
  }
  const visited = new Set()
  for (let cursor = 0; cursor < connected.length && pending.size; cursor++) {
    const r = connected[cursor].rect
    // Quantized scatter marks often repeat a box thousands of times. The
    // pending set only shrinks, so repeating the same query cannot add a path.
    const identity = r.join(',')
    if (visited.has(identity)) continue
    visited.add(identity)
    const rect = [r[0] - 8, r[1] - 8, r[2] + 8, r[3] + 8]
    const cells = keys(rect)
    const candidates = cells ? new Set(large) : pending
    if (cells) for (const key of cells) for (const item of bins.get(key) ?? []) candidates.add(item)
    // Preserve source order for downstream side-caption propagation.
    const matches = [...candidates]
      .filter((item) => intersection(item.rect, rect) > 0)
      .sort((a, b) => order.get(a) - order.get(b))
    for (const item of matches) {
      pending.delete(item)
      large.delete(item)
      for (const key of locations.get(item) ?? []) bins.get(key).delete(item)
      connected.push(item)
    }
  }
}
