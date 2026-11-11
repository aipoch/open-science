/* eslint-disable @typescript-eslint/explicit-function-return-type */
const finite = (a, n) => Array.isArray(a) && a.length === n && a.every(Number.isFinite)
const valid = (r) => finite(r, 4) && r[0] < r[2] && r[1] < r[3]

// Crop-only upper bound for native glyph outlines painted in fill+stroke mode.
// The caller retains the original glyph/font/state witness. This does not
// establish text ownership or reconstruct glyphs from their displayed text.
export function nativeFillStrokeGlyphEnvelope(ink, state, rasterScale) {
  if (
    !valid(ink) ||
    !state ||
    !finite(state.matrix, 6) ||
    !finite(state.textMatrix, 6) ||
    !valid(state.clip) ||
    !Number.isFinite(rasterScale) ||
    rasterScale <= 0 ||
    !Number.isFinite(state.lineWidth) ||
    state.lineWidth <= 0 ||
    ![0, 1, 2].includes(state.lineJoin) ||
    ![0, 1, 2].includes(state.lineCap) ||
    !Number.isFinite(state.miterLimit) ||
    state.miterLimit <= 0 ||
    state.fillAlpha !== 1 ||
    state.strokeAlpha !== 1 ||
    !/^#[a-f0-9]{6}$/iu.test(state.fillColor) ||
    !/^#[a-f0-9]{6}$/iu.test(state.strokeColor)
  )
    return
  const m = state.matrix,
    determinant = Math.abs(m[0] * m[3] - m[1] * m[2]),
    textScale = Math.hypot(state.textMatrix[0], state.textMatrix[1]),
    xScale = Math.hypot(m[0], m[2]),
    yScale = Math.hypot(m[1], m[3])
  if (
    ![determinant, textScale, xScale, yScale].every(Number.isFinite) ||
    !(determinant > 0) ||
    !(textScale > 0)
  )
    return
  // Pinned CanvasGraphics.showText divides LW by textMatrixScale. Its
  // fontSizeScale and paintChar's font-size path transform cancel. A native
  // minimum-device stroke is bounded using getSinglePixelWidth's affine
  // row-norm/determinant formula, then charged before the rectangular clip.
  const minimumWidth = Math.max(xScale, yScale) / (rasterScale * determinant),
    width = Math.max(state.lineWidth / textScale, minimumWidth),
    join = Math.max(Math.SQRT2, state.lineJoin === 0 ? state.miterLimit : 1),
    xRadius = (width * xScale * join) / 2,
    yRadius = (width * yScale * join) / 2,
    rect = [
      Math.max(state.clip[0], ink[0] - xRadius),
      Math.max(state.clip[1], ink[1] - yRadius),
      Math.min(state.clip[2], ink[2] + xRadius),
      Math.min(state.clip[3], ink[3] + yRadius)
    ]
  return Number.isFinite(xRadius) && Number.isFinite(yRadius) && valid(rect) ? rect : undefined
}
