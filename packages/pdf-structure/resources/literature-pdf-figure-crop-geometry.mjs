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

// Native advance boxes end at the baseline. Complete the ink of glyphs already
// wholly owned by this plate, without admitting adjacent text into the crop.
export function nativeOwnedFigureInkBottom(figure, tokens) {
  const rect = figure.rect
  if (!rect?.every(Number.isFinite) || area(rect) <= 0) return rect?.[3] ?? 0
  // Viewport scaling and its inverse can differ by a floating-point ulp.
  const epsilon = 1e-8
  const owned = tokens.filter(
    (token) =>
      token.horizontal &&
      token.rect?.every(Number.isFinite) &&
      area(token.rect) > 0 &&
      token.rect[0] >= rect[0] - epsilon &&
      token.rect[1] >= rect[1] - epsilon &&
      token.rect[2] <= rect[2] + epsilon &&
      token.rect[3] <= rect[3] + epsilon &&
      Number.isFinite(token.baseline) &&
      Math.abs(token.baseline - token.rect[3]) <= 0.01 &&
      Number.isFinite(token.height) &&
      token.height > 0 &&
      Number.isFinite(token.fontDescent) &&
      token.fontDescent >= -1 &&
      token.fontDescent <= 0 &&
      !figure.excludedProseLines?.some(
        (line) => intersection(lineRect(line), token.rect) / area(token.rect) > 0.8
      )
  )
  const bottom = Math.max(
    rect[3],
    ...owned.map((token) => token.baseline - token.fontDescent * token.height + 0.5)
  )
  if (bottom === rect[3]) return bottom
  const strip = [rect[0], rect[3], rect[2], bottom]
  return tokens.some(
    (token) =>
      !owned.includes(token) &&
      token.rect?.every(Number.isFinite) &&
      intersection(strip, token.rect) > 0
  )
    ? rect[3]
    : bottom
}
