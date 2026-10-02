/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { area, intersection, lineRect } from './literature-pdf-page-geometry.mjs'

// Work only inside an existing multiline numbered caption. Native left-edge
// prose baselines delimit physical rows; every short script needs one exact
// source edge owner. Letters and unknown glyphs stay literal; proven numeric
// superscripts retain the established plain-caption superscript representation.
export function nativeCaptionLiteralFragments(page, caption) {
  if (
    caption.lines.length < 3 ||
    !/^(?:Table|Tab\.?|Fig\.?|Figure\.?)\s+[AS]?\d+(?:[.-]\d+)*[.:]\s/iu.test(caption.lines[0])
  )
    return
  const first = page.lines.find(
    (l) =>
      caption.lines[0].startsWith(l.text) &&
      Math.abs(l.x - caption.rect[0]) < 0.1 &&
      Math.abs(l.y - caption.rect[1]) < 0.1
  )
  if (!first) return
  const em = first.fontSize
  if (
    !(em > 0) ||
    !caption.rect.every(Number.isFinite) ||
    page.lines.some((l) => ![l.x, l.y, l.width, l.height, l.fontSize].every(Number.isFinite))
  )
    return
  const frame = [...caption.rect.slice(0, 3), caption.rect[3] + em * 0.4]
  const source = page.lines.filter((l) => l.text.trim() && intersection(lineRect(l), frame) > 0)
  if (
    source.some(
      (l) =>
        ![l.x, l.y, l.width, l.height, l.fontSize].every(Number.isFinite) ||
        l.width <= 0 ||
        l.height <= 0 ||
        l.fontSize < em * 0.5 ||
        l.fontSize > em * 1.45 ||
        l.x < frame[0] - 0.1 ||
        l.x + l.width > frame[2] + 0.1 ||
        l.y < frame[1] - 0.1 ||
        l.y + l.height > frame[3] + 0.1
    )
  )
    return
  const heads = source
    .filter((l) => Math.abs(l.x - first.x) < 0.1 && Math.abs(l.fontSize - em) < 0.1)
    .sort((a, b) => a.y - b.y)
  if (
    heads.length < 3 ||
    heads[0] !== first ||
    heads.some((l, i) => i && (l.y - heads[i - 1].y < em || l.y - heads[i - 1].y > em * 1.8))
  )
    return
  const rows = heads.map((h) => ({ head: h, parts: [] })),
    owners = new Map(),
    scripts = new Map()
  const small = source.filter((l) => l.fontSize <= em * 0.8)
  if (small.length < 2) return
  for (const s of small) {
    const parents = source.filter(
      (b) =>
        b !== s &&
        b.fontSize > em * 0.8 &&
        Math.abs(s.x - b.x - b.width) < em * 0.1 &&
        Math.abs(s.y + s.fontSize - (b.y + b.fontSize)) > em * 0.15 &&
        Math.abs(s.y + s.fontSize - (b.y + b.fontSize)) < em * 1.2
    )
    if (parents.length !== 1) return
    const parent = parents[0]
    const distances = rows
      .map((r, index) => ({ index, distance: Math.abs(s.y + s.height / 2 - r.head.y - em / 2) }))
      .sort((a, b) => a.distance - b.distance)
    if (
      distances[0].distance > em * 0.8 ||
      distances[1].distance - distances[0].distance < em * 0.1
    )
      return
    const row = distances[0].index
    if (owners.has(parent) && owners.get(parent) !== row) return
    owners.set(parent, row)
    owners.set(s, row)
    if (!scripts.has(parent)) scripts.set(parent, [])
    scripts.get(parent).push(s)
  }
  for (const part of source.filter((l) => !small.includes(l))) {
    const matches = rows.flatMap((r, index) => (Math.abs(r.head.y - part.y) < 0.1 ? [index] : []))
    if (!owners.has(part)) {
      if (matches.length !== 1) return
      owners.set(part, matches[0])
    } else if (matches.length && matches[0] !== owners.get(part)) return
    rows[owners.get(part)].parts.push(part)
  }
  const lines = rows.map((r) =>
    r.parts
      .sort((a, b) => a.x - b.x)
      .map((parent) => {
        let text = parent.text.trim()
        for (const script of (scripts.get(parent) ?? []).sort((a, b) => a.y - b.y || a.x - b.x)) {
          // Preserve the established groupPageLines numeric superscript contract
          // only after this complete caption proved one unique native edge owner.
          const rise = parent.y + parent.height - (script.y + script.height),
            gap = script.x - parent.x - parent.width,
            superscript =
              /^\d+$/.test(script.text) &&
              script.fontSize <= parent.fontSize * 0.8 &&
              rise >= parent.fontSize * 0.2 &&
              rise <= parent.fontSize * 0.8 &&
              gap >= -parent.fontSize * 0.1 &&
              gap <= parent.fontSize * 0.3
          text += superscript
            ? script.text.replace(/\d/g, (digit) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(digit)])
            : ' ' + script.text.trim()
        }
        return text
      })
      .join(' ')
  )
  return {
    lines,
    rect: [
      Math.min(...source.map((l) => l.x)),
      Math.min(...source.map((l) => l.y)),
      Math.max(...source.map((l) => l.x + l.width)),
      Math.max(...source.map((l) => l.y + l.height))
    ]
  }
}
// Reorder literal source indices only inside an already owned caption. Both
// indices attach to one native base edge; no Unicode composition is inferred.
export function nativeCaptionRaisedIndexLines(page, caption) {
  if (
    !caption.rect.every(Number.isFinite) ||
    page.lines.some((l) => ![l.x, l.y, l.width, l.height, l.fontSize].every(Number.isFinite))
  )
    return
  if (!/^(?:Table|Tab\.?|Fig\.?|Figure)\s+(?:\d+|[IVX]+)[.:]\s/i.test(caption.lines[0])) return
  const source = page.lines.filter(
    (l) =>
      area(lineRect(l)) > 0 && intersection(lineRect(l), caption.rect) / area(lineRect(l)) > 0.99
  )
  const triples = []
  for (const raised of source.filter((l) => /^\p{L}$/u.test(l.text) && l.fontSize > 0)) {
    const bases = source.filter(
      (l) =>
        l !== raised &&
        /\p{L}$/u.test(l.text.trim()) &&
        Math.abs(raised.x - l.x - l.width) <= l.fontSize * 0.05 &&
        raised.fontSize <= l.fontSize * 0.8 &&
        raised.fontSize >= l.fontSize * 0.5 &&
        l.y + l.height - raised.y - raised.height >= l.fontSize * 0.2 &&
        l.y + l.height - raised.y - raised.height <= l.fontSize * 0.7
    )
    if (bases.length !== 1) continue
    const base = bases[0],
      tails = source.filter(
        (l) =>
          l !== base &&
          l !== raised &&
          /^\p{L}{1,3}[.,;:]/u.test(l.text) &&
          Math.abs(l.x - base.x - base.width) <= base.fontSize * 0.05 &&
          Math.abs(l.fontSize - base.fontSize) <= 0.1 &&
          Math.abs(l.y - base.y) <= 0.1 &&
          l.height > base.fontSize * 1.1 &&
          l.height <= base.fontSize * 1.3
      )
    if (tails.length !== 1) continue
    triples.push({ base, raised, tail: tails[0] })
  }
  if (triples.length !== 1) return
  const { base, raised, tail } = triples[0]
  const rows = source.filter((l) => l !== raised).sort((a, b) => a.y - b.y || a.x - b.x),
    result = []
  let used = false
  for (const part of rows) {
    if (part === tail) continue
    if (part === base) {
      result.push(base.text + ' ' + raised.text + ' ' + tail.text)
      used = true
    } else result.push(part.text)
  }
  return used ? result : undefined
}
