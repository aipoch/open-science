/* eslint-disable @typescript-eslint/explicit-function-return-type */
const valid = (r) =>
  r &&
  typeof r.text === 'string' &&
  [r.x, r.y, r.right, r.bottom, r.fontSize].every(Number.isFinite) &&
  r.right > r.x &&
  r.bottom > r.y &&
  r.fontSize > 0

export function findNativeCenteredVectorCaptionTail(start, runs, page, rules) {
  const em = start?.fontSize
  if (
    !valid(start) ||
    !/^Figure\s+[A-Z]?\d+[.:]\s+\S/u.test(start.text) ||
    /[.!?:]$/u.test(start.text.trim()) ||
    start.right - start.x < page.width * 0.35 ||
    page.rotation !== 0 ||
    (page.renderRotation ?? 0) !== 0 ||
    page.invalidGraphicsBounds !== 0 ||
    !Array.isArray(runs) ||
    runs.length > 4096 ||
    !runs.every(valid) ||
    !Array.isArray(page.graphicsBounds) ||
    !page.graphicsBounds.length ||
    page.graphicsBounds.length > 4096
  )
    return
  const following = runs.filter((r) => r.y > start.y).sort((a, b) => a.y - b.y || a.x - b.x)
  const [tail, boundary] = following
  if (
    !tail ||
    !boundary ||
    !/^[a-z].{24,}[.!?]$/u.test(tail.text.trim()) ||
    Math.abs(tail.fontSize - em) > em * 0.01 ||
    tail.y < start.bottom ||
    tail.y - start.y > em * 1.6 ||
    tail.x <= start.x ||
    tail.right >= start.right ||
    Math.abs((tail.x + tail.right - start.x - start.right) / 2) > em * 0.2 ||
    !/^(?:Appendix\s+[A-Z][.:]?|\d+(?:\.\d+)*\.?)[ \t]+\p{Lu}/u.test(boundary.text) ||
    boundary.fontSize < em * 1.15 ||
    boundary.fontSize > em * 1.35 ||
    Math.abs(boundary.x - start.x) > em * 0.1 ||
    boundary.right > start.right ||
    boundary.y - tail.bottom < em * 1.4 ||
    boundary.y - tail.bottom > em * 4
  )
    return
  const source = page.lines.filter(
    (l) =>
      l.text.trim() &&
      l.x < start.right &&
      l.x + l.width > start.x &&
      l.y + l.height > start.y &&
      l.y < boundary.y
  )
  if (
    source.length !== 2 ||
    ![start, tail].every((r) =>
      source.some(
        (l) =>
          l.text === r.text &&
          Math.abs(l.x - r.x) < 0.01 &&
          Math.abs(l.y - r.y) < 0.01 &&
          Math.abs(l.x + l.width - r.right) < 0.01 &&
          Math.abs(l.y + l.height - r.bottom) < 0.01
      )
    ) ||
    rules.some(
      (r) =>
        !Array.isArray(r) ||
        r.length !== 4 ||
        !r.every(Number.isFinite) ||
        (r[0] < start.right &&
          r[2] > start.x &&
          Math.max(r[1], r[3]) > start.bottom &&
          Math.min(r[1], r[3]) < boundary.y)
    )
  )
    return
  let adjacentVector = false
  for (const graphic of page.graphicsBounds) {
    const n = graphic.normalizedRect
    if (
      !['path', 'image'].includes(graphic.kind) ||
      !Array.isArray(n) ||
      n.length !== 4 ||
      !n.every(Number.isFinite) ||
      n.some((v) => v < 0 || v > 1) ||
      n[2] <= n[0] ||
      n[3] <= n[1]
    )
      return
    const r = n.map((v, i) => v * (i % 2 ? page.height : page.width))
    if (r[0] < start.right && r[2] > start.x && r[3] > start.bottom && r[1] < boundary.y) return
    if (
      graphic.kind === 'path' &&
      r[3] <= start.y &&
      start.y - r[3] < em * 3 &&
      r[2] - r[0] > em * 8 &&
      r[3] - r[1] > em * 4
    )
      adjacentVector = true
  }
  if (adjacentVector) return [tail]
}
