/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { area, intersection, lineRect } from './literature-pdf-page-geometry.mjs'

// The caller has already established caption paragraph ownership. Rejoin only
// original same-baseline fragments and uniquely attached small scripts inside
// that paragraph; preserve unknown font glyphs literally.
export function nativeCaptionOwnedInlineFragments(page, caption, ownedLines, rules = []) {
  if (ownedLines.length < 2 || !caption.rect.every(Number.isFinite)) return
  if (caption.lines.some((text) => text.includes('ˆ'))) return
  const em = ownedLines[0].fontSize
  if (
    !(em > 0) ||
    page.lines.some((l) => ![l.x, l.y, l.width, l.height, l.fontSize].every(Number.isFinite))
  )
    return
  let changed = false
  const covered = new Set(),
    result = []
  for (const row of ownedLines) {
    const bases = page.lines
      .filter(
        (l) =>
          l.text.trim() &&
          l.fontSize >= em * 0.85 &&
          Math.abs(l.fontSize - em) < 0.1 &&
          Math.abs(l.y - row.y) <= Math.max(2, em * 0.15) &&
          l.x >= caption.rect[0] - 0.1 &&
          l.x + l.width <= caption.rect[2] + 0.1
      )
      .sort((a, b) => a.x - b.x)
    if (!bases.length) {
      result.push(row.text)
      continue
    }
    const scripts = page.lines
      .filter(
        (l) =>
          l.text.trim() &&
          l.fontSize >= em * 0.5 &&
          l.fontSize <= em * 0.8 &&
          l.x >= caption.rect[0] &&
          l.x + l.width <= caption.rect[2] &&
          Math.abs(l.y + l.height - row.y - row.fontSize) < em
      )
      .sort((a, b) => a.y - b.y || a.x - b.x)
    const fractions = new Set()
    for (const rule of rules.filter(
      (r) =>
        r[1] === r[3] &&
        r[2] - r[0] > 0 &&
        r[2] - r[0] < em * 8 &&
        r[0] >= caption.rect[0] &&
        r[2] <= caption.rect[2]
    )) {
      const pair = page.lines
        .filter(
          (s) =>
            s.fontSize >= em * 0.5 &&
            s.fontSize <= em * 0.8 &&
            s.x >= rule[0] - em * 0.1 &&
            s.x + s.width <= rule[2] + em * 0.1 &&
            Math.abs(s.y - rule[1]) < em * 1.5 &&
            /^[\p{L}\p{N}√+−\-/()[\]., ]{1,40}$/u.test(s.text.trim())
        )
        .sort((a, b) => a.y - b.y)
      const above = pair.filter((s) => s.y + s.height / 2 < rule[1]),
        below = pair.filter((s) => s.y + s.height / 2 > rule[1])
      if (
        !above.length ||
        !below.length ||
        pair.some((s) => covered.has(s)) ||
        Math.min(...below.map((s) => s.y)) - Math.min(...above.map((s) => s.y)) < em * 0.5 ||
        Math.min(...below.map((s) => s.y)) - Math.min(...above.map((s) => s.y)) > em * 1.3 ||
        Math.abs(
          (Math.min(...below.map((s) => s.x)) + Math.max(...below.map((s) => s.x + s.width))) / 2 -
            (rule[0] + rule[2]) / 2
        ) >
          em * 0.2
      )
        continue
      const distance = (r) => Math.abs(rule[1] - r.y - r.fontSize / 2)
      if (distance(row) > em * 0.85) continue
      if (ownedLines.some((r) => r !== row && distance(r) <= distance(row) + em * 0.1)) continue
      bases.push({
        ...pair[0],
        text: [above, below]
          .map((parts) =>
            parts
              .sort((a, b) => a.x - b.x)
              .map((s) => s.text.trim())
              .join(' ')
          )
          .join(' '),
        x: rule[0],
        width: rule[2] - rule[0],
        y: row.y,
        fontSize: em,
        height: em
      })
      for (const s of pair) {
        covered.add(s)
        fractions.add(s)
      }
    }
    const chains = []
    for (const s of scripts.filter((s) => !fractions.has(s))) {
      const last = chains.at(-1)
      if (last && Math.abs(last.y - s.y) < 0.1 && Math.abs(last.x + last.width - s.x) < em * 0.1)
        Object.assign(last, {
          text: last.text + s.text,
          width: s.x + s.width - last.x,
          members: [...last.members, s]
        })
      else chains.push({ ...s, members: [s] })
    }
    const attached = new Map()
    for (const s of chains) {
      const parents = bases.filter(
        (b) =>
          (Math.abs(s.x - b.x - b.width) < em * 0.1 ||
            (/^\p{L}$/u.test(s.text) &&
              s.x >= b.x + b.width - em &&
              s.x + s.width <= b.x + b.width + em * 0.1 &&
              s.y + s.fontSize > b.y + b.fontSize + em * 0.15)) &&
          Math.abs(b.y + b.fontSize - s.y - s.fontSize) > em * 0.15 &&
          Math.abs(b.y + b.fontSize - s.y - s.fontSize) < em
      )
      if (parents.length !== 1 || s.members.some((m) => covered.has(m))) continue
      const distances = ownedLines
        .map((r) => Math.abs(s.y + s.height / 2 - r.y - r.fontSize / 2))
        .sort((a, b) => a - b)
      const distance = Math.abs(s.y + s.height / 2 - row.y - row.fontSize / 2)
      if (
        distance > distances[0] + em * 0.01 ||
        distance > em * 0.8 ||
        (distances.length > 1 && distances[1] - distances[0] < em * 0.1)
      )
        continue
      const parent = parents[0]
      if (!attached.has(parent)) attached.set(parent, [])
      attached.get(parent).push(s)
      for (const member of s.members) covered.add(member)
    }
    // A raised literal operator may sit above its own physical prose row.
    // A unique exact next edge supplies ownership without interpreting its font.
    for (const overlay of page.lines.filter(
      (l) =>
        l.text.trim().length === 1 &&
        Math.abs(l.fontSize - em) < 0.1 &&
        l.y < row.y - em * 0.2 &&
        row.y - l.y < em &&
        l.x >= caption.rect[0] &&
        l.x + l.width <= caption.rect[2] &&
        !covered.has(l)
    )) {
      const next = bases.filter(
        (b) =>
          Math.abs(b.x - overlay.x - overlay.width) < em * 0.05 &&
          overlay.y + overlay.height > row.y
      )
      const competing = page.lines.filter(
        (l) =>
          l !== overlay &&
          Math.abs(l.x - overlay.x) < em * 0.05 &&
          Math.abs(l.y - overlay.y) < em * 0.1 &&
          Math.abs(l.width - overlay.width) < em * 0.05
      )
      if (next.length === 1 && !competing.length) {
        bases.push(overlay)
        covered.add(overlay)
      }
    }
    bases.sort((a, b) => a.x - b.x)
    if (
      bases.some(
        (b, i) =>
          i &&
          b.x -
            Math.max(
              bases[i - 1].x + bases[i - 1].width,
              ...(attached.get(bases[i - 1]) ?? []).map((s) => s.x + s.width)
            ) >
            em * 0.8
      )
    ) {
      result.push(row.text)
      continue
    }
    const text = bases
      .map((b) => {
        let value = b.text.trim()
        for (const s of attached.get(b) ?? []) {
          const rise = b.y + b.height - s.y - s.height
          value +=
            /^[−-]?\d+$/.test(s.text) && rise >= em * 0.2 && rise <= em * 0.8
              ? s.text.replace(/[−-]/g, '⁻').replace(/\d/g, (d) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(d)])
              : ' ' + s.text
        }
        return value
      })
      .join(' ')
    const unresolved = scripts.some(
      (s) => !covered.has(s) && s.y >= row.y - em * 0.2 && s.y < row.y + em * 0.8
    )
    if (unresolved) {
      result.push(row.text)
      continue
    }
    // A connected native formula row can contain more than one prose
    // baseline. Reordering scripts must not discard any already owned text
    // from that physical row. Superscript normalization keeps literal digits
    // equivalent while preserving unknown mathematical glyphs unchanged.
    const available = new Map()
    for (const char of text.normalize('NFKD').replace(/\s/gu, ''))
      available.set(char, (available.get(char) ?? 0) + 1)
    const conserves = [...row.text.normalize('NFKD').replace(/\s/gu, '')].every((char) => {
      const count = available.get(char) ?? 0
      available.set(char, count - 1)
      return count > 0
    })
    if (conserves && text !== row.text && (bases.length > 1 || attached.size)) changed = true
    result.push(conserves ? text : row.text)
  }
  return changed ? { lines: result } : undefined
}

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
      // A uniquely attached raised script can define the paragraph's top edge
      // above its first physical prose baseline. The complete source proof
      // below still requires every fragment to have one literal row owner.
      Math.abs(l.y - caption.rect[1]) < l.fontSize * 0.3
  )
  if (!first) return
  const em = first.fontSize
  if (
    !(em > 0) ||
    !caption.rect.every(Number.isFinite) ||
    page.lines.some((l) => ![l.x, l.y, l.width, l.height, l.fontSize].every(Number.isFinite))
  )
    return
  const frame = [
    caption.rect[0],
    Math.min(caption.rect[1], first.y - em * 0.3),
    caption.rect[2],
    caption.rect[3] + em * 0.4
  ]
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
    .filter((l) => Math.abs(l.x - first.x) < em * 0.1 && Math.abs(l.fontSize - em) < 0.1)
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
        Math.abs(s.x - b.x - b.width) < em * 0.2 &&
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
              /^[−-]?\d+$/.test(script.text) &&
              script.fontSize <= parent.fontSize * 0.8 &&
              rise >= parent.fontSize * 0.2 &&
              rise <= parent.fontSize * 0.8 &&
              gap >= -parent.fontSize * 0.1 &&
              gap <= parent.fontSize * 0.3
          text += superscript
            ? script.text
                .replace(/[−-]/g, '⁻')
                .replace(/\d/g, (digit) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(digit)])
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
