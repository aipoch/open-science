/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { union, area, intersection, lineRect } from './literature-pdf-page-geometry.mjs'
// Preserve complete native font boxes already intersecting owned drawing ink.
// Detached rows require independent repeated panel/label column evidence.
export function nativeOwnedFigureLabels(
  page,
  caption,
  captions,
  tables,
  rect,
  foreignOwns = () => false
) {
  const font = Math.min(
    ...page.lines
      .filter((l) => intersection(lineRect(l), caption.rect) > 0)
      .map((l) => l.fontSize)
      .filter((v) => v > 0)
  )
  if (!Number.isFinite(font)) return []
  const eligible = (l) =>
    l.fontSize > 0 &&
    l.fontSize <= font * 1.15 &&
    [l.x, l.y, l.width, l.height, l.fontSize].every(Number.isFinite) &&
    l.width > 0 &&
    l.height > 0 &&
    l.text.length < 40 &&
    !/[.!?]$/.test(l.text.trim()) &&
    !captions.some((c) => intersection(c.rect, lineRect(l)) > 0) &&
    !tables.some((t) => intersection(t, lineRect(l)) > 0) &&
    !foreignOwns(lineRect(l))
  const marker = (l) => /^(?:[a-z]|[a-z](?:\s+[a-z])+)$/.test(l.text.trim())
  const labels = page.lines.filter(
    (l) =>
      eligible(l) &&
      (l.width <= l.fontSize * 15 || marker(l)) &&
      intersection(lineRect(l), rect) / area(lineRect(l)) > 0.05
  )
  const marks = page.lines
    .filter(
      (l) =>
        eligible(l) &&
        /^[a-z]$/.test(l.text.trim()) &&
        l.x >= rect[0] - l.fontSize * 4 &&
        l.x < rect[0] &&
        l.y >= rect[1] - l.fontSize * 3 &&
        l.y + l.height <= rect[3] &&
        l.height <= l.fontSize * 1.25
    )
    .sort((a, b) => a.y - b.y)
  if (
    marks.length >= 3 &&
    marks.length <= 6 &&
    marks.every(
      (l, i) =>
        Math.abs(l.x - marks[0].x) < l.fontSize * 0.2 &&
        Math.abs(l.fontSize - marks[0].fontSize) < 0.1 &&
        l.text === String.fromCharCode(97 + i) &&
        (!i || l.y - marks[i - 1].y > l.fontSize * 5)
    )
  )
    labels.push(...marks)
  const expanded = union([rect, ...labels.map(lineRect)])
  const outside = page.lines.filter(
    (l) =>
      eligible(l) &&
      l.fontSize < font * 0.9 &&
      l.text.length < 30 &&
      l.height <= l.fontSize * 1.25 &&
      l.x >= rect[0] - l.fontSize * 6 &&
      l.x + l.width >= rect[0] - l.fontSize * 2 &&
      l.x < rect[0] &&
      l.y >= expanded[1] &&
      l.y + l.height <= expanded[3]
  )
  if (
    outside.length >= 5 &&
    outside.every((l) => Math.abs(l.fontSize - outside[0].fontSize) < 0.1) &&
    !page.lines.some(
      (l) => l.text.length > 60 && intersection(lineRect(l), union(outside.map(lineRect))) > 0
    )
  )
    labels.push(...outside)
  return [...new Set(labels)]
}
export function nativePanelTopHeading(page, captions, tables, rect, rules) {
  const headings = page.lines.filter(
    (l) =>
      /^\([a-z]\)\s+\p{L}/u.test(l.text) &&
      l.fontSize > 0 &&
      l.height <= l.fontSize * 1.3 &&
      l.text.length < 60 &&
      l.x >= rect[0] &&
      l.x + l.width <= rect[2] &&
      !captions.some((c) => intersection(c.rect, lineRect(l)) > 0)
  )
  const before = headings.filter(
    (l) => l.y + l.height < rect[1] && rect[1] - l.y - l.height <= l.fontSize * 3
  )
  if (before.length !== 1) return []
  const title = before[0],
    peers = headings.filter(
      (l) =>
        l.y >= rect[1] && l.y + l.height <= rect[3] && Math.abs(l.fontSize - title.fontSize) < 0.1
    )
  if (
    peers.length < 2 ||
    new Set([title, ...peers].map((l) => l.text[1])).size !== peers.length + 1
  )
    return []
  const opening = rules.filter(
    (r) =>
      r[1] === r[3] &&
      r[0] <= title.x &&
      r[2] >= title.x + title.width &&
      r[1] >= title.y + title.height &&
      r[1] <= rect[1] &&
      Math.abs(r[0] - rect[0]) < 8 &&
      Math.abs(r[2] - rect[2]) < 8
  )
  if (
    opening.length !== 1 ||
    tables.some((t) => intersection(t, lineRect(title)) > 0) ||
    page.lines.some(
      (l) => l !== title && intersection(lineRect(l), [rect[0], title.y, rect[2], rect[1]]) > 0
    )
  )
    return []
  return [title]
}

// The source probe can omit a tiny run from a grouped label. Preserve only
// literal glyph tails tightly attached to an already owned short native run.
export function nativeOwnedFigureGlyphTails(page, caption, captions, tables, rect, tokens) {
  const owned = page.lines.filter(
    (l) =>
      l.text.length < 20 &&
      l.fontSize > 0 &&
      [l.x, l.y, l.width, l.height, l.fontSize].every(Number.isFinite) &&
      intersection(lineRect(l), rect) / area(lineRect(l)) > 0.8 &&
      !captions.some((c) => intersection(c.rect, lineRect(l)) > 0)
  )
  const result = []
  for (const token of tokens) {
    if (
      !token.horizontal ||
      !/^[\p{L}\p{N}]{1,4}$/u.test(token.text) ||
      ![...token.rect, token.baseline, token.height].every(Number.isFinite) ||
      token.height <= 0 ||
      area(token.rect) <= 0 ||
      page.lines.some((l) => intersection(lineRect(l), token.rect) / area(token.rect) > 0.8) ||
      tables.some((t) => intersection(t, token.rect) > 0) ||
      captions.some((c) => intersection(c.rect, token.rect) > 0)
    )
      continue
    const peers = owned.filter(
      (l) =>
        Math.abs(token.rect[0] - l.x - l.width) <= token.height * 0.05 &&
        token.height >= l.fontSize * 0.65 &&
        token.height <= l.fontSize * 1.2 &&
        token.rect[1] < l.y + l.height &&
        token.baseline > l.y &&
        Math.abs(token.baseline - l.y - l.height) <= token.height * 0.2
    )
    if (
      peers.length !== 1 ||
      tokens.some(
        (t) =>
          t !== token &&
          t.horizontal &&
          intersection(t.rect, [token.rect[0], token.rect[1], token.rect[2], token.rect[3]]) > 0
      )
    )
      continue
    const strip = [token.rect[2], token.rect[1], token.rect[2] + token.height * 0.2, token.rect[3]]
    const clear =
      !tokens.some((t) => t !== token && intersection(t.rect, strip) > 0) &&
      !page.lines.some((l) => intersection(lineRect(l), strip) > 0) &&
      !captions.some((c) => intersection(c.rect, strip) > 0) &&
      !tables.some((t) => intersection(t, strip) > 0)
    result.push({
      cropRect: clear ? [token.rect[0], token.rect[1], strip[2], token.rect[3]] : token.rect,
      text: token.text,
      x: token.rect[0],
      y: token.rect[1],
      width: token.rect[2] - token.rect[0],
      height: token.rect[3] - token.rect[1],
      fontSize: token.height
    })
  }
  return result
}

// Quantized PDF.js stroke bounds can overhang a table's actual last divider.
// Match one complete native vertical segment and a uniquely recognized native
// ruled table; this is not a lower overlap threshold for arbitrary graphics.
export function nativeTableDividerGraphic(page, rect, tables, rules) {
  const ux = page.width / 256,
    uy = page.height / 256
  if (
    ![...rect, ux, uy].every(Number.isFinite) ||
    ux <= 0 ||
    uy <= 0 ||
    rect[2] - rect[0] > ux * 2 + 0.01
  )
    return false
  const owners = tables.filter((table) => {
    const horizontals = rules.filter(
      (r) =>
        r[1] === r[3] &&
        // A refined crop can retain a small outer margin around the printed
        // fence. The source rules themselves must still share exact endpoints.
        Math.abs(r[0] - table[0]) <= ux * 2 &&
        Math.abs(r[2] - table[2]) <= ux * 2 &&
        r[1] >= table[1] - uy &&
        r[1] <= table[3] + 0.02
    )
    if (
      new Set(horizontals.map((r) => r[1])).size < 3 ||
      horizontals.some(
        (r) =>
          Math.abs(r[0] - horizontals[0][0]) > 0.02 || Math.abs(r[2] - horizontals[0][2]) > 0.02
      ) ||
      // Painted stroke margins can place the crop just below the rule's
      // centreline. This does not license a remotely closing table boundary.
      !horizontals.some((r) => Math.abs(r[1] - table[3]) <= Math.max(0.02, uy * 0.2))
    )
      return false
    const native = rules.filter(
      (r) =>
        r[0] === r[2] &&
        r[3] - r[1] >= uy * 2 &&
        r[0] >= table[0] &&
        r[0] <= table[2] &&
        r[1] >= table[1] - 0.02 &&
        r[3] <= table[3] + 0.02 &&
        r[0] >= rect[0] &&
        r[0] <= rect[2] &&
        r[1] >= rect[1] &&
        r[3] <= rect[3] &&
        r[0] - rect[0] <= ux * 2 &&
        rect[2] - r[0] <= ux * 2 &&
        r[1] - rect[1] <= uy * 2 &&
        rect[3] - r[3] <= uy * 2
    )
    return native.length === 1
  })
  return owners.length === 1
}
