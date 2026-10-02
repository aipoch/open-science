/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'

const finiteRect = (rect) =>
  rect?.length === 4 && rect.every(Number.isFinite) && rect[2] > rect[0] && rect[3] > rect[1]
const intersects = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
const contains = (outer, inner) =>
  inner[0] >= outer[0] - 0.001 &&
  inner[2] <= outer[2] + 0.001 &&
  inner[1] >= outer[1] - 0.001 &&
  inner[3] <= outer[3] + 0.001
const validToken = (t) =>
  t.horizontal &&
  finiteRect(t.rect) &&
  Number.isFinite(t.baseline) &&
  t.height > 0 &&
  Number.isFinite(t.height)
const lineRect = (l) => [l.x, l.y, l.x + l.width, l.y + l.height]
const validLine = (l) =>
  [l.x, l.y, l.width, l.height, l.fontSize].every(Number.isFinite) &&
  l.width > 0 &&
  l.height > 0 &&
  l.fontSize > 0
const compact = (text) => text.trim().replace(/\s+/gu, ' ')
const glyphs = (parts) =>
  [
    ...parts
      .map((p) => p.text)
      .join('')
      .replace(/\s/gu, '')
  ]
    .sort()
    .join('')

// Page/caption coordinates are scale 1; native tokens retain their source viewport
// scale. Only original single-letter glyph widths establish accent ownership.
export function recoverNativeCaptionOverlayAccentLines(page, caption, nativeTokens, scale = 1.5) {
  if (
    !(scale > 0) ||
    !Number.isFinite(scale) ||
    !finiteRect(caption.rect) ||
    page.pageNumber !== caption.page ||
    !captionKind(caption.lines?.[0] ?? '') ||
    !caption.lines?.length
  )
    return
  const first = page.lines.find(
    (l) =>
      validLine(l) &&
      Math.abs(l.x - caption.rect[0]) < 0.001 &&
      Math.abs(l.y - caption.rect[1]) < 0.001 &&
      caption.lines[0].startsWith(l.text)
  )
  if (!first) return
  const em = first.fontSize,
    frame = [caption.rect[0], caption.rect[1] - em * 0.35, caption.rect[2], caption.rect[3]]
  const sourceFrame = frame.map((x) => x * scale)
  const source = nativeTokens.filter(
    (t) => t.text.trim() && (!finiteRect(t.rect) || intersects(t.rect, sourceFrame))
  )
  if (source.some((t) => !validToken(t) || !contains(sourceFrame, t.rect))) return
  const accents = source.filter((t) => /^[ˆ¯]$/u.test(t.text))
  if (!accents.length) return
  const geometry = page.lines.filter(
    (l) => l.text.trim() && (!validLine(l) || intersects(lineRect(l), frame))
  )
  if (geometry.some((l) => !validLine(l) || !contains(frame, lineRect(l)))) return
  // A native run may end in a real whitespace advance that overlaps the next
  // letter's font box. Require complete literal coverage instead of treating
  // that blank advance as foreign ink or estimating its glyph width.
  if (glyphs(source) !== glyphs(geometry)) return
  const result = [...caption.lines],
    assignments = new Set(),
    owners = new Set()
  let changed = false
  for (const accent of accents) {
    const center = (accent.rect[0] + accent.rect[2]) / 2
    const matches = source.filter(
      (base) =>
        base !== accent &&
        /^\p{L}$/u.test(base.text) &&
        Math.abs(base.height - accent.height) < 0.001 &&
        Math.abs(base.height / scale - em) < 0.001 &&
        base.baseline - accent.baseline >= base.height * 0.15 &&
        base.baseline - accent.baseline <= base.height * 0.35 &&
        center >= base.rect[0] &&
        center <= base.rect[2] &&
        accent.rect[0] >= base.rect[0] - 0.001 &&
        accent.rect[2] <= base.rect[2] + 0.001 &&
        accent.rect[2] - accent.rect[0] <= base.height * 0.7
    )
    if (matches.length !== 1 || owners.has(matches[0])) return
    const owner = matches[0]
    owners.add(owner)
    const fragments = geometry.filter(
      (l) =>
        l.text.startsWith(owner.text) &&
        Math.abs(l.x - owner.rect[0] / scale) < 0.001 &&
        Math.abs(l.y - owner.rect[1] / scale) < 0.001 &&
        Math.abs(l.fontSize - em) < 0.001
    )
    if (fragments.length !== 1 || assignments.has(fragments[0])) return
    const fragment = fragments[0]
    assignments.add(fragment)
    const row = geometry
      .filter((l) => !/^[ˆ¯]$/u.test(l.text) && Math.abs(l.y - fragment.y) < 0.001)
      .sort((a, b) => a.x - b.x)
    const rowText = compact(row.map((l) => l.text).join(' '))
    const rows = result.flatMap((text, index) => {
      const original = text.replaceAll(accent.text + owner.text, owner.text)
      return compact(original) === rowText ? [index] : []
    })
    if (rows.length !== 1) return
    const index = rows[0],
      text = result[index],
      start = text.indexOf(fragment.text)
    if (start < 0 || text.indexOf(fragment.text, start + 1) >= 0) return
    if (start > 0 && text[start - 1] === accent.text) continue
    result[index] = text.slice(0, start) + accent.text + text.slice(start)
    changed = true
  }
  return changed ? result : undefined
}
