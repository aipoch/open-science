/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
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
  let recoveredBottom = caption.rect[3]
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
    // A sheared mathematical face can report a slightly larger font norm
    // than adjacent upright prose although both have identical native boxes.
    // An already accepted single-letter base proves that physical baseline;
    // admit only complete, nonoverlapping upright fragments on the same row.
    const projected = bases.filter(
      (b) =>
        /^\p{L}$/u.test(b.text.trim()) &&
        b.width > 0 &&
        b.height > 0 &&
        b.fontSize > b.height &&
        b.fontSize <= b.height * 1.02
    )
    let sharedNativeBaseline = false
    if (
      projected.length &&
      page.lines.every((l) => l.width > 0 && l.height > 0 && l.fontSize > 0)
    ) {
      const sameHeight = page.lines.filter(
        (l) =>
          !bases.includes(l) &&
          l.text.trim() &&
          row.text.replace(/\s/gu, '').includes(l.text.replace(/\s/gu, '')) &&
          Math.abs(l.fontSize - l.height) < 0.02 &&
          l.x >= row.x &&
          l.x + l.width <= row.right &&
          projected.some(
            (b) => Math.abs(l.y - b.y) < 0.02 && Math.abs(l.height - b.height) < 0.02
          ) &&
          ownedLines.filter((r) => Math.abs(l.y - r.y) < Math.max(2, em * 0.15)).length === 1
      )
      const all = [...bases, ...sameHeight]
      if (
        sameHeight.length &&
        all.every((l, i) =>
          all
            .slice(i + 1)
            .every(
              (other) =>
                Math.min(l.x + l.width, other.x + other.width) - Math.max(l.x, other.x) <= em * 0.01
            )
        )
      ) {
        bases.push(...sameHeight)
        sharedNativeBaseline = true
      }
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
            (/^[−-]?\d+$/.test(s.text) &&
              /[\p{L}\p{N}]$/u.test(b.text.trim()) &&
              s.x - b.x - b.width >= -em * 0.1 &&
              // PDF.js can leave a small advance gap before compact superscripts.
              s.x - b.x - b.width <= em * 0.3) ||
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
    const hasWideGap = bases.some(
      (b, i) =>
        i &&
        b.x -
          Math.max(
            bases[i - 1].x + bases[i - 1].width,
            ...(attached.get(bases[i - 1]) ?? []).map((s) => s.x + s.width)
          ) >
          em * 0.8
    )
    let text
    if (hasWideGap && !fractions.size) {
      // Math can span several native baselines inside one caption row (for
      // example, a sum and a derivative between two prose fragments). When
      // the ordinary parent-edge recovery cannot join that row, keep the
      // complete literal fragment stream rather than silently dropping it.
      const scriptsInRow = scripts.filter(
        (s) =>
          s.x >= bases[0].x &&
          s.x < Math.max(...bases.map((b) => b.x + b.width)) &&
          Math.abs(s.y + s.height / 2 - (row.y + row.fontSize / 2)) <= em * 0.8
      )
      const gap = bases
        .map((base, index) => ({
          left: base.x + base.width,
          right: bases[index + 1]?.x,
          width: bases[index + 1]?.x - base.x - base.width
        }))
        .filter((span) => span.width > em * 0.8)
        .sort((a, b) => b.width - a.width)[0]
      const gapScripts = gap
        ? scriptsInRow.filter((s) => s.x >= gap.left - em * 0.2 && s.x <= gap.right + em * 0.8)
        : []
      const raised = gap
        ? page.lines.filter(
            (fragment) =>
              fragment.text.trim().length === 1 &&
              fragment.fontSize >= em * 0.85 &&
              fragment.fontSize <= em * 1.05 &&
              fragment.x >= gap.left &&
              fragment.x + fragment.width <= gap.right &&
              fragment.y < row.y - em * 0.2 &&
              row.y - fragment.y < em &&
              caption.rect[1] <= fragment.y &&
              fragment.y + fragment.height <= caption.rect[3]
          )
        : []
      if (gapScripts.length < 3 || !gap || raised.length !== 1) {
        result.push(row.text)
        continue
      }
      text = [...bases, ...gapScripts, ...raised]
        .sort((a, b) => Math.round(a.x / (em * 0.2)) - Math.round(b.x / (em * 0.2)) || a.y - b.y)
        .map((fragment) => fragment.text.trim())
        .join(' ')
      for (const fragment of gapScripts) covered.add(fragment)
    } else if (hasWideGap) {
      result.push(row.text)
      continue
    } else {
      text = bases
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
    }
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
    if (sharedNativeBaseline && conserves && text !== row.text)
      for (const scripts of attached.values())
        for (const script of scripts)
          recoveredBottom = Math.max(recoveredBottom, script.y + script.height)
    result.push(conserves ? text : row.text)
  }
  return changed
    ? {
        lines: result,
        ...(recoveredBottom > caption.rect[3]
          ? { rect: [...caption.rect.slice(0, 3), recoveredBottom] }
          : {})
      }
    : undefined
}

// Work only inside an existing multiline numbered caption. Native left-edge
// prose baselines delimit physical rows; every short script needs one exact
// source edge owner. Letters and unknown glyphs stay literal; proven numeric
// superscripts retain the established plain-caption superscript representation.
export function nativeCaptionLiteralFragments(page, caption) {
  return captionLiteralFragments(page, caption)
}

function captionLiteralFragments(page, caption, controlOwners) {
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
    const matches = controlOwners?.has(part)
      ? [controlOwners.get(part)]
      : rows.flatMap((r, index) => (Math.abs(r.head.y - part.y) < 0.1 ? [index] : []))
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

// A paired literal control fragment may straddle the nominal prose baseline.
// Admit it only through the complete original-item and selected-font stream,
// with unique neighbours in one existing caption row. Never decode its glyph.
export function nativeCaptionProvenControlFragments(page, caption, fonts, context) {
  const owners = nativeControlRowOwners(page, caption, fonts, context)
  return owners ? captionLiteralFragments(page, caption, owners) : undefined
}

function nativeControlRowOwners(page, caption, fonts, context) {
  const finite = (r, n) => Array.isArray(r) && r.length === n && r.every(Number.isFinite)
  const literal = (s) => s.replace(/\s/gu, '')
  const control = (s) =>
    s.length === 1 && (s.charCodeAt(0) <= 8 || (s.charCodeAt(0) >= 14 && s.charCodeAt(0) <= 31))
  if (
    !caption ||
    !Number.isSafeInteger(page.pageNumber) ||
    page.pageNumber < 1 ||
    caption.page !== page.pageNumber ||
    caption.regions ||
    !Array.isArray(caption.lines) ||
    caption.lines.length < 3 ||
    !/^(?:Fig(?:ure)?\.?)\s+[A-Z]?\d+[.:]\s/iu.test(caption.lines[0]) ||
    page.renderRotation !== 0 ||
    !(
      Number.isFinite(page.width) &&
      page.width > 0 &&
      Number.isFinite(page.height) &&
      page.height > 0
    ) ||
    page.invalidGraphicsBounds !== 0 ||
    !Array.isArray(page.graphicsBounds) ||
    !finite(caption.rect, 4) ||
    !Array.isArray(context?.content?.items) ||
    !Array.isArray(context.inventory) ||
    !Array.isArray(fonts) ||
    !Array.isArray(context.associations) ||
    context.associations.length !== 1
  )
    return
  const association = context.associations[0]
  if (
    association.captionLines ||
    association.captionRect ||
    JSON.stringify(association.caption) !== JSON.stringify(caption) ||
    !finite(association.rect, 4) ||
    association.rect[3] >= caption.rect[1]
  )
    return
  const v = context.viewport?.transform,
    ops = context.operators,
    raw = context.content.items
  if (
    !finite(v, 6) ||
    v[0] !== 1 ||
    v[1] !== 0 ||
    v[2] !== 0 ||
    v[3] !== -1 ||
    !Array.isArray(ops?.fnArray) ||
    !Array.isArray(ops.argsArray) ||
    ops.fnArray.length !== ops.argsArray.length
  )
    return
  const first = page.lines.find(
    (l) =>
      caption.lines[0].startsWith(l.text) &&
      Math.abs(l.x - caption.rect[0]) < 0.1 &&
      Math.abs(l.y - caption.rect[1]) < l.fontSize * 0.3
  )
  if (!first) return
  const em = first.fontSize,
    frame = [
      caption.rect[0],
      Math.min(caption.rect[1], first.y - em * 0.3),
      caption.rect[2],
      caption.rect[3] + em * 0.4
    ]
  const intersects = (r) => r[0] < frame[2] && r[2] > frame[0] && r[1] < frame[3] && r[3] > frame[1]
  const within = (r) =>
    r[0] >= frame[0] - 0.1 &&
    r[2] <= frame[2] + 0.1 &&
    r[1] >= frame[1] - 0.1 &&
    r[3] <= frame[3] + 0.1
  if (
    !Array.isArray(context.rules) ||
    context.rules.some(
      (r) =>
        !finite(r, 4) ||
        intersects([
          Math.min(r[0], r[2]),
          Math.min(r[1], r[3]),
          Math.max(r[0], r[2]),
          Math.max(r[1], r[3])
        ])
    )
  )
    return
  if (
    page.graphicsBounds.some(
      (g) =>
        !['path', 'image'].includes(g.kind) ||
        !finite(g.normalizedRect, 4) ||
        g.normalizedRect.some((v) => v < 0 || v > 1) ||
        g.normalizedRect[2] < g.normalizedRect[0] ||
        g.normalizedRect[3] < g.normalizedRect[1] ||
        intersects(g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)))
    )
  )
    return
  const source = page.lines.filter(
    (l) => l.text.trim() && intersects([l.x, l.y, l.x + l.width, l.y + l.height])
  )
  const selected = source.filter((l) => control(l.text))
  if (
    selected.length !== 2 ||
    selected.some((l) => Math.abs(l.fontSize - em) > 0.1) ||
    Math.abs(selected[0].y - selected[1].y) > 0.02
  )
    return
  // Unknown extra source carriers are never treated as harmless aliases.
  const carriers = (value) => {
    const counts = new Map(),
      active = new Set()
    const walk = (x) => {
      if (!x || typeof x !== 'object') return true
      if (active.has(x)) return false
      active.add(x)
      if (Number.isSafeInteger(x.pageNumber) && Number.isSafeInteger(x.index)) {
        const k = x.pageNumber + ':' + x.index
        counts.set(k, (counts.get(k) ?? 0) + 1)
      }
      for (const y of Object.values(x)) if (!walk(y)) return false
      active.delete(x)
      return true
    }
    return walk(value) ? counts : undefined
  }
  const rc = carriers(context.content),
    ic = carriers(context.inventory),
    fc = carriers(fonts)
  if (!rc || !ic || !fc) return
  const byIndex = new Map(),
    native = []
  for (const t of context.inventory) {
    const s = t.sourceItem,
      r = raw[s?.index],
      key = s?.pageNumber + ':' + s?.index
    if (
      !s ||
      s.pageNumber !== page.pageNumber ||
      !Number.isSafeInteger(s.index) ||
      s.index < 0 ||
      byIndex.has(s.index) ||
      r?.str !== t.text ||
      s.text !== t.text ||
      r.fontName !== t.fontName ||
      rc.get(key) !== 1 ||
      ic.get(key) !== 1 ||
      !finite(t.rect, 4) ||
      !finite(r.transform, 6) ||
      r.sourceItem?.index !== s.index ||
      r.sourceItem.pageNumber !== s.pageNumber ||
      r.sourceItem.text !== s.text ||
      ['sourceToken', 'sourceSegment', 'sourceItems', 'sourceSegments'].some(
        (k) => r[k] !== undefined || t[k] !== undefined
      )
    )
      return
    byIndex.set(s.index, t)
    const [a, b, c, d, x, y] = r.transform,
      point = [v[0] * x + v[2] * y + v[4], v[1] * x + v[3] * y + v[5]],
      rect = [point[0], point[1] - r.height, point[0] + r.width, point[1]]
    if (!intersects(rect)) continue
    if (
      !(a > 0 && d > 0 && r.width > 0 && r.height > 0) ||
      b !== 0 ||
      c !== 0 ||
      !within(rect) ||
      rect.some((z, i) => Math.abs(z - t.rect[i]) > 1e-7) ||
      t.horizontal !== true
    )
      return
    const f = fonts.filter(
      (f) => f.sourceItem?.index === s.index && f.sourceItem?.pageNumber === s.pageNumber
    )
    if (
      f.length !== 1 ||
      fc.get(key) !== 1 ||
      f[0].text !== r.str ||
      f[0].sourceItem.text !== r.str ||
      !finite(f[0].rect, 4) ||
      f[0].rect.some((z, i) => Math.abs(z - rect[i]) > 1e-7) ||
      ['sourceToken', 'sourceSegment', 'sourceItems', 'sourceSegments'].some(
        (k) => f[0][k] !== undefined
      )
    )
      return
    native.push({ r, rect, index: s.index })
  }
  if (byIndex.size !== raw.filter((r) => typeof r.str === 'string' && r.str.trim()).length) return
  const chars = (s) => [...literal(s)].sort().join('')
  if (chars(source.map((l) => l.text).join('')) !== chars(native.map((n) => n.r.str).join('')))
    return
  const heads = source
    .filter((l) => Math.abs(l.x - first.x) < em * 0.1 && Math.abs(l.fontSize - em) < 0.1)
    .sort((a, b) => a.y - b.y)
  const bases = source.filter((l) => l.fontSize > em * 0.8),
    owners = new Map(),
    chosen = []
  const nonblank = raw.flatMap((r, index) =>
    typeof r.str === 'string' && r.str.trim() ? [{ r, index }] : []
  )
  // An exact contiguous original-item interval must also fit the complete native line.
  const anchor = (at, step, line) => {
    let text = '',
      parts = []
    for (let i = at; i >= 0 && i < nonblank.length; i += step) {
      const n = nonblank[i],
        t = byIndex.get(n.index)
      if (!t) return false
      text = step < 0 ? literal(n.r.str) + text : text + literal(n.r.str)
      parts.push(t)
      if (text.length >= literal(line.text).length) break
    }
    return (
      text === literal(line.text) &&
      parts.length > 0 &&
      parts.every(
        (t) =>
          t.rect[0] >= line.x - 0.02 &&
          t.rect[2] <= line.x + line.width + 0.02 &&
          t.rect[1] >= line.y - 0.02 &&
          t.rect[3] <= line.y + line.height + 0.02
      )
    )
  }
  for (const line of selected) {
    const i = bases.indexOf(line),
      left = bases[i - 1],
      right = bases[i + 1]
    if (
      !left ||
      !right ||
      control(left.text) ||
      control(right.text) ||
      Math.abs(left.y - right.y) > 0.02 ||
      !(line.y < left.y && line.y + line.height > left.y) ||
      line.x - left.x - left.width < -0.02 ||
      line.x - left.x - left.width >= em * 0.5 ||
      right.x - line.x - line.width < -0.02 ||
      right.x - line.x - line.width >= em * 0.5
    )
      return
    const rows = heads.flatMap((h, i) => (Math.abs(h.y - left.y) < 0.1 ? [i] : []))
    if (rows.length !== 1) return
    const matched = native.filter(
      (n) =>
        n.r.str === line.text &&
        Math.abs(n.rect[0] - line.x) < 0.02 &&
        Math.abs(n.rect[1] - line.y) < 0.02 &&
        Math.abs(n.rect[2] - line.x - line.width) < 0.02 &&
        Math.abs(n.rect[3] - line.y - line.height) < 0.02
    )
    if (matched.length !== 1) return
    const n = matched[0],
      pos = nonblank.findIndex((t) => t.index === n.index),
      style = context.content.styles?.[n.r.fontName]
    if (
      !style ||
      style.vertical !== false ||
      !Number.isFinite(style.ascent) ||
      !Number.isFinite(style.descent) ||
      !anchor(pos - 1, -1, left) ||
      !anchor(pos + 1, 1, right)
    )
      return
    chosen.push(n)
    owners.set(line, rows[0])
  }
  if (chosen[0].r.fontName !== chosen[1].r.fontName || chosen[0].index >= chosen[1].index) return
  const fontName = chosen[0].r.fontName,
    shown = [],
    stack = []
  let active
  for (let i = 0; i < ops.fnArray.length; i++) {
    const op = ops.fnArray[i],
      a = ops.argsArray[i]
    if ([OPS.save, OPS.paintFormXObjectBegin, OPS.beginGroup].includes(op))
      stack.push({ operation: op, font: active })
    else if ([OPS.restore, OPS.paintFormXObjectEnd, OPS.endGroup].includes(op)) {
      if (!stack.length) return
      const saved = stack.pop()
      const expected =
        op === OPS.restore
          ? OPS.save
          : op === OPS.paintFormXObjectEnd
            ? OPS.paintFormXObjectBegin
            : OPS.beginGroup
      if (saved.operation !== expected) return
      active = saved.font
    } else if (op === OPS.setFont) {
      if (!Array.isArray(a) || typeof a[0] !== 'string') return
      active = a[0]
    } else if (op === OPS.setGState) {
      if (
        !Array.isArray(a?.[0]) ||
        a[0].some((entry) => !Array.isArray(entry) || entry.length !== 2)
      )
        return
      for (const [k, value] of a[0])
        if (k === 'Font') {
          if (!Array.isArray(value) || typeof value[0] !== 'string') return
          active = value[0]
        }
    } else if (
      [
        OPS.showText,
        OPS.showSpacedText,
        OPS.nextLineShowText,
        OPS.nextLineSetSpacingShowText
      ].includes(op) &&
      active === fontName
    ) {
      if (!Array.isArray(a)) return
      for (const glyph of a.flat()) {
        if (typeof glyph === 'number' && Number.isFinite(glyph)) continue
        if (!glyph || typeof glyph !== 'object' || typeof glyph.unicode !== 'string') return
        shown.push({ glyph, operationIndex: i })
      }
    }
  }
  if (stack.length) return
  const nativeFont = nonblank.filter((n) => n.r.fontName === fontName)
  if (
    literal(nativeFont.map((n) => n.r.str).join('')) !==
    literal(shown.map((s) => s.glyph.unicode).join(''))
  )
    return
  for (const n of chosen) {
    const start = literal(
      nativeFont
        .filter((t) => t.index < n.index)
        .map((t) => t.r.str)
        .join('')
    ).length
    let offset = 0,
      matched = []
    for (const s of shown) {
      const text = literal(s.glyph.unicode),
        from = offset
      offset += text.length
      if (offset > start && from < start + 1) matched.push(s)
    }
    if (matched.length !== 1) return
    const g = matched[0].glyph
    if (
      g.unicode !== n.r.str ||
      g.originalCharCode !== n.r.str.charCodeAt(0) ||
      g.isInFont !== true ||
      g.isSpace ||
      g.accent
    )
      return
  }
  return owners
}
