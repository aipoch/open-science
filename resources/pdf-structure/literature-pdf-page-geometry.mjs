/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Page-space rectangles use [left, top, right, bottom] coordinates.
export const union = (rects) => [
  Math.min(...rects.map((r) => r[0])),
  Math.min(...rects.map((r) => r[1])),
  Math.max(...rects.map((r) => r[2])),
  Math.max(...rects.map((r) => r[3]))
]
export const area = (r) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1])
export const intersection = (a, b) =>
  area([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])])
export const lineRect = (l) => [l.x, l.y, l.x + l.width, l.y + l.height]
