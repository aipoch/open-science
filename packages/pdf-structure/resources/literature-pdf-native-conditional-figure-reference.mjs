/* eslint-disable @typescript-eslint/explicit-function-return-type */
// A conditional body paragraph is excluded only beside its independently
// printed same-number caption. This does not classify isolated "If" strings.
const finite = (r) =>
  ['x', 'y', 'right', 'bottom', 'fontSize'].every((k) => Number.isFinite(r?.[k])) &&
  r.right > r.x &&
  r.bottom > r.y &&
  r.fontSize > 0
const ordinal = (s) => /^(?:Figure|Fig\.?)\s+([1-9]\d*)[.:]\s+/u.exec(s)?.[1]
const hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
export function nativeConditionalFigureReference(start, runs, page) {
  try {
    const number = ordinal(start?.text),
      em = start?.fontSize
    if (
      !number ||
      !/^Fig\.?\s+[1-9]\d*\.\s+If\s+/u.test(start.text) ||
      !finite(start) ||
      page.invalidGraphicsBounds !== 0 ||
      page.rotation !== 0 ||
      !Array.isArray(runs) ||
      runs.length > 4096 ||
      runs.some((r) => !finite(r)) ||
      !Array.isArray(page.graphicsBounds)
    )
      return false
    const graphics = page.graphicsBounds.map((g) =>
      g.normalizedRect?.map((x, i) => x * (i % 2 ? page.height : page.width))
    )
    if (
      graphics.some(
        (r) =>
          !Array.isArray(r) ||
          r.length !== 4 ||
          !r.every(Number.isFinite) ||
          r[2] < r[0] ||
          r[3] < r[1]
      )
    )
      return false
    const ordered = [...runs].sort((a, b) => a.y - b.y || a.x - b.x),
      index = ordered.indexOf(start)
    if (index < 1) return false
    const prior = ordered
      .slice(0, index)
      .filter(
        (r) => ordinal(r.text) === number && !/\bIf\b/u.test(r.text) && /^Figure\s/u.test(r.text)
      )
    if (prior.length !== 1) return false
    const caption = prior[0],
      capIndex = ordered.indexOf(caption)
    if (
      caption.x - start.x < em ||
      caption.x - start.x > 4 * em ||
      caption.fontSize < em * 0.9 ||
      caption.fontSize > em * 1.1
    )
      return false
    const captionRows = ordered.slice(capIndex, index)
    if (
      captionRows.length < 2 ||
      captionRows.length > 24 ||
      !/[.!?]$/u.test(captionRows.at(-1).text) ||
      captionRows.some(
        (r, n) =>
          r.fontSize < em * 0.7 ||
          r.fontSize > em * 1.4 ||
          Math.abs(r.x - caption.x) > em * 0.15 ||
          r.right > caption.right + em * 0.15 ||
          (n > 0 && (r.y <= captionRows[n - 1].y || r.y - captionRows[n - 1].bottom > em * 0.75))
      )
    )
      return false
    const tail = captionRows.at(-1),
      gap = start.y - tail.bottom
    if (gap < em || gap > em * 4) return false
    const body = []
    let end = index,
      display = false
    for (; end < ordered.length && body.length < 10; end++) {
      const r = ordered[end],
        previous = body.at(-1)
      if (previous && r.y - previous.bottom > em * 2) break
      if (
        r.fontSize < em * 0.6 ||
        r.fontSize > em * 1.2 ||
        r.x < start.x - em * 0.1 ||
        r.right > start.right + em * 0.1
      )
        break
      if (end !== index && ordinal(r.text)) break
      // Only baseline-aligned body rows or a centered displayed equation can
      // bridge the conditional sentence. Scripts remain on their native row.
      const aligned = Math.abs(r.x - start.x) < em * 0.15
      const centered = r.x > start.x + em * 4 && /[=∈∑†]/u.test(r.text)
      const script =
        body.length > 0 &&
        r.fontSize < em * 0.8 &&
        r.y < previous.bottom + em * 0.25 &&
        r.x > start.x + em * 4
      if (!aligned && !centered && !script) break
      if (centered) display = true
      body.push(r)
      if (aligned && body.length >= 3 && /[.!?]$/u.test(r.text)) break
    }
    if (
      body.length < 4 ||
      body.length > 9 ||
      !display ||
      !/[.!?]$/u.test(body.at(-1).text) ||
      Math.abs(body.at(-1).x - start.x) > em * 0.15
    )
      return false
    const sentence = body
      .map((r) => r.text)
      .join(' ')
      .replace(/-\s+(?=\p{Ll})/gu, '')
    if (!/^Fig\.?\s+[1-9]\d*\.\s+If\s+[^,]+,\s+(?:the|a|an|this|these|it)\s+/u.test(sentence))
      return false
    const bodyRect = [start.x, tail.bottom, start.right, Math.max(...body.map((r) => r.bottom))]
    if (graphics.some((r) => hit(bodyRect, r))) return false
    // A second drawing immediately below could instead make this a real top
    // caption. Keep that candidate; prose syntax alone cannot resolve it.
    if (
      graphics.some(
        (r) =>
          r[1] >= bodyRect[3] &&
          r[1] - bodyRect[3] < em * 4 &&
          r[0] < bodyRect[2] &&
          r[2] > bodyRect[0]
      )
    )
      return false
    return graphics.some(
      (r) =>
        r[3] <= caption.y &&
        caption.y - r[3] < em * 4 &&
        (r[2] - r[0]) * (r[3] - r[1]) > page.width * page.height * 0.01 &&
        Math.min(r[2], caption.right) - Math.max(r[0], caption.x) >
          (caption.right - caption.x) * 0.6
    )
  } catch {
    return false
  }
}
