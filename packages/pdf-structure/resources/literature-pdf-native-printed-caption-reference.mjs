/* eslint-disable @typescript-eslint/explicit-function-return-type */
const valid = (r) =>
    ['x', 'y', 'right', 'bottom', 'fontSize'].every((k) => Number.isFinite(r?.[k])) &&
    r.right > r.x &&
    r.bottom > r.y &&
    r.fontSize > 0,
  finiteRect = (r) =>
    Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3],
  ordinal = '(?:[A-Z]?\\d+(?:\\.\\d+)*)',
  printed = new RegExp(`^(?:Figure|Fig\\.?)\\s+(${ordinal})[.:]\\s+\\p{L}`, 'u'),
  reference = new RegExp(`^(?:Figure|Fig\\.?)\\s+(${ordinal})\\s+\\p{L}`, 'u')

// A complete independently printed caption and an entire indented body
// paragraph distinguish this reference. Neither an unfamiliar verb nor a
// duplicate ordinal alone suppresses a caption. This grants no Source role.
export function nativePrintedCaptionBodyReference(start, runs, page, captions) {
  try {
    const number = reference.exec(start?.text ?? '')?.[1],
      em = start?.fontSize
    if (
      !number ||
      !valid(start) ||
      page.rotation !== 0 ||
      (page.renderRotation ?? 0) !== 0 ||
      page.invalidGraphicsBounds !== 0 ||
      !Number.isFinite(page.width) ||
      !Number.isFinite(page.height) ||
      !Array.isArray(runs) ||
      runs.length > 4096 ||
      runs.some((r) => !valid(r)) ||
      !Array.isArray(captions) ||
      captions.length > 256 ||
      !Array.isArray(page.graphicsBounds) ||
      page.graphicsBounds.length > 4096
    )
      return false
    const prior = captions.filter(
      (c) =>
        c.page === page.pageNumber &&
        finiteRect(c.rect) &&
        c.rect[3] < start.y &&
        printed.exec(c.lines?.[0] ?? '')?.[1] === number
    )
    if (prior.length !== 1) return false
    const cap = prior[0],
      left = cap.rect[0],
      right = cap.rect[2],
      width = right - left
    if (
      !Array.isArray(cap.lines) ||
      cap.lines.length < 2 ||
      cap.lines.length > 12 ||
      !cap.lines.every((s) => typeof s === 'string') ||
      !/[.!?]$/u.test(cap.lines.at(-1)) ||
      width < page.width * 0.35 ||
      start.x - left < em * 0.6 ||
      start.x - left > em * 1.8
    )
      return false
    const ordered = [...runs].sort((a, b) => a.y - b.y || a.x - b.x),
      rows = []
    for (const text of cap.lines) {
      const matches = ordered.filter(
        (r) =>
          r.text === text &&
          r.x >= cap.rect[0] - 0.01 &&
          r.y >= cap.rect[1] - 0.01 &&
          r.right <= cap.rect[2] + 0.01 &&
          r.bottom <= cap.rect[3] + 0.01
      )
      if (matches.length !== 1) return false
      rows.push(matches[0])
    }
    if (
      Math.abs(rows[0].y - cap.rect[1]) > 0.01 ||
      Math.abs(rows.at(-1).bottom - cap.rect[3]) > 0.01 ||
      rows.some(
        (r, n) =>
          Math.abs(r.x - left) > em * 0.1 ||
          Math.abs(r.fontSize - em) > em * 0.02 ||
          (n && (r.y <= rows[n - 1].bottom || r.y - rows[n - 1].bottom > em * 0.65))
      )
    )
      return false
    const before = ordered.filter((r) => r.y > cap.rect[3] + 0.01 && r.bottom < start.y)
    if (
      before.length < 2 ||
      before.length > 8 ||
      !/[.!?]$/u.test(before.at(-1).text) ||
      before[0].y - cap.rect[3] < em * 0.75 ||
      before[0].y - cap.rect[3] > em * 3.5 ||
      start.y - before.at(-1).bottom < em * 0.25 ||
      start.y - before.at(-1).bottom > em * 1.25 ||
      before.at(-1).right - left > width * 0.85 ||
      before.some(
        (r, n) =>
          Math.abs(r.x - left) > em * 0.1 ||
          Math.abs(r.fontSize - em) > em * 0.02 ||
          r.right > right + em * 0.2 ||
          (n < before.length - 1 && r.right - left < width * 0.8) ||
          (n && (r.y <= before[n - 1].bottom || r.y - before[n - 1].bottom > em * 0.65))
      )
    )
      return false
    const index = ordered.indexOf(start),
      body = [start]
    if (index < 0) return false
    for (const r of ordered.slice(index + 1)) {
      if (r.y - body.at(-1).bottom > em * 0.65 || Math.abs(r.x - left) > em * 0.1) break
      if (
        r.y <= body.at(-1).bottom ||
        Math.abs(r.fontSize - em) > em * 0.02 ||
        r.right > right + em * 0.2
      )
        return false
      body.push(r)
      if (body.length > 24) return false
    }
    if (
      body.length < 3 ||
      !/[.!?]$/u.test(body.at(-1).text) ||
      body.at(-1).right - left > width * 0.85 ||
      body.slice(0, -1).some((r) => r.right - r.x < width * 0.7)
    )
      return false
    // Every native graphic must precede the independently printed caption.
    // A second legitimate same-number drawing, including a continued figure,
    // keeps this candidate regardless of its paragraph-like typography.
    let adjacent = false
    for (const g of page.graphicsBounds) {
      if (!['path', 'image'].includes(g.kind) || !finiteRect(g.normalizedRect)) return false
      const r = g.normalizedRect.map((v, n) => v * (n % 2 ? page.height : page.width))
      if (r[3] > cap.rect[1]) return false
      if (
        cap.rect[1] - r[3] <= em * 4 &&
        (r[2] - r[0]) * (r[3] - r[1]) > page.width * page.height * 0.01 &&
        Math.min(r[2], right) - Math.max(r[0], left) >= width * 0.6
      )
        adjacent = true
    }
    return adjacent
  } catch {
    return false
  }
}
