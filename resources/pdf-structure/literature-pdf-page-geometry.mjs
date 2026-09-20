/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Page-space rectangles use [left, top, right, bottom] coordinates.
export const union = (rects) => {
  const bounds = [Infinity, Infinity, -Infinity, -Infinity]
  // Dense vector plots exceed the engine's argument limit when spread into min/max.
  for (const rect of rects) {
    bounds[0] = Math.min(bounds[0], rect[0])
    bounds[1] = Math.min(bounds[1], rect[1])
    bounds[2] = Math.max(bounds[2], rect[2])
    bounds[3] = Math.max(bounds[3], rect[3])
  }
  return bounds
}
export const area = (r) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1])
export const intersection = (a, b) =>
  area([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])])
export const lineRect = (l) => [l.x, l.y, l.x + l.width, l.y + l.height]
