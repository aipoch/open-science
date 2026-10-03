/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { area, intersection, lineRect } from './literature-pdf-page-geometry.mjs'

// Association has already excluded these prose owners. Limit only the final
// rendering padding, using native font descent; never shrink the owned plate.
export function nativeProseInkTopLimit(figure, tokens) {
  if (!figure.rect || !figure.excludedProseLines?.length) return 0
  const bottoms = tokens
    .filter(
      (t) =>
        t.horizontal &&
        t.rect?.every(Number.isFinite) &&
        area(t.rect) > 0 &&
        Number.isFinite(t.baseline) &&
        Number.isFinite(t.height) &&
        t.height > 0 &&
        Number.isFinite(t.fontDescent) &&
        t.fontDescent >= -1 &&
        t.fontDescent <= 0 &&
        t.rect[3] <= figure.rect[1] &&
        figure.excludedProseLines.some(
          (line) => intersection(lineRect(line), t.rect) / area(t.rect) > 0.8
        )
    )
    .map((t) => t.baseline - t.fontDescent * t.height + 0.5)
    .filter((bottom) => bottom <= figure.rect[1])
  return Math.max(0, ...bottoms)
}
