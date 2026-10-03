/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { groupPageLines, captionKind, joinCaptionLines } from './literature-pdf-caption-group.mjs'
import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'
import { lineRect, union } from './literature-pdf-page-geometry.mjs'

// Consecutive raised markers can start midway through the preceding note's
// last physical line. The original small-type paragraph, rather than one
// marker's x coordinate, owns its wrapped continuation.
export function recoverNativeNumberedDefinitionFooter(page, tables) {
  return tables.map(({ rect }, index) => {
    const firsts = page.lines.filter(
      (l) =>
        l.text === '1' &&
        l.fontSize > 0 &&
        l.y >= rect[3] &&
        l.y - rect[3] < l.fontSize * 3 &&
        l.x >= rect[0] &&
        l.x + l.width <= rect[2]
    )
    if (firsts.length !== 1) return
    const first = firsts[0],
      initial = page.lines.filter(
        (l) =>
          l !== first &&
          l.x >= first.x + first.width &&
          l.x - first.x - first.width < first.fontSize &&
          l.y + l.fontSize - first.y - first.fontSize > first.fontSize * 0.2 &&
          l.y - first.y < first.fontSize &&
          l.fontSize >= first.fontSize * 1.2 &&
          /^[\p{L}][^:]{2,60}:\s*\p{L}/u.test(l.text)
      )
    if (initial.length !== 1) return
    const lead = initial[0],
      em = lead.fontSize,
      left = first.x - em * 0.1,
      right = rect[2]
    const heads = page.lines
      .filter(
        (l) =>
          l.text.trim() &&
          Math.abs(l.fontSize - em) < 0.5 &&
          l.y >= lead.y &&
          l.y < lead.y + em * 30 &&
          l.x >= left &&
          l.x + l.width <= right + 0.1
      )
      .sort((a, b) => a.y - b.y || a.x - b.x)
    const rows = []
    for (const l of heads) {
      const row = rows.at(-1)
      if (row && Math.abs(row.y - l.y) < em * 0.15) row.parts.push(l)
      else {
        if (row && l.y - row.y > em * 1.5) break
        rows.push({ y: l.y, parts: [l] })
      }
    }
    if (rows.length < 3 || !/[.!?]$/.test(rows.at(-1).parts.at(-1).text.trim())) return
    const bottom = rows.at(-1).y + em
    if (
      tables.some(
        (t, i) =>
          i !== index &&
          t.rect[1] < bottom &&
          t.rect[3] > lead.y &&
          t.rect[0] < right &&
          t.rect[2] > left
      )
    )
      return
    const scope = page.lines.filter(
      (l) =>
        l.text.trim() &&
        l.y >= first.y - em * 0.1 &&
        l.y + l.height <= bottom + em * 0.1 &&
        l.x >= left &&
        l.x + l.width <= right + 0.1
    )
    if (scope.some((l) => ![l.x, l.y, l.width, l.height, l.fontSize].every(Number.isFinite))) return
    const markers = scope
      .filter((l) => /^\d{1,2}$/.test(l.text) && l.fontSize >= em * 0.5 && l.fontSize <= em * 0.8)
      .sort((a, b) => a.y - b.y || a.x - b.x)
    if (
      markers.length < 3 ||
      markers.length > 12 ||
      markers.some((m, i) => Number(m.text) !== i + 1)
    )
      return
    for (const marker of markers) {
      const owner = rows.filter((r) => r.y - marker.y > 0 && r.y - marker.y < em * 0.5)
      if (
        owner.length !== 1 ||
        !owner[0].parts.some(
          (l) => l.x >= marker.x + marker.width && l.x - marker.x - marker.width < em * 0.8
        )
      )
        return
      owner[0].parts.push(marker)
    }
    const assigned = new Set(rows.flatMap((r) => r.parts))
    if (scope.some((l) => !assigned.has(l))) return
    const chunks = []
    for (const row of rows)
      for (const l of row.parts.sort((a, b) => a.x - b.x)) {
        if (markers.includes(l)) chunks.push([l])
        else {
          if (!chunks.length) return
          chunks.at(-1).push(l)
        }
      }
    const notes = chunks.map((parts) => ({
      text: joinCaptionLines(parts.map((l) => l.text)),
      rect: union(parts.map(lineRect))
    }))
    const words = new Set(
      page.lines
        .filter(
          (l) =>
            l.y >= rect[1] &&
            l.y + l.height <= rect[3] &&
            l.x >= rect[0] &&
            l.x + l.width <= rect[2]
        )
        .flatMap((l) => l.text.match(/\p{L}+/gu) ?? [])
        .map((s) => s.toLowerCase())
    )
    if (
      notes.slice(0, 3).some((n) => {
        const label = /^\d+\s+([^:]{2,80}):/.exec(n.text)?.[1]
        return !label || !(label.match(/\p{L}+/gu) ?? []).some((s) => words.has(s.toLowerCase()))
      })
    )
      return
    return { notes, rect: union(scope.map(lineRect)) }
  })
}

// A source-cited definition may start a new paragraph inside a labeled note.
// Learn its rhythm from that already-owned note, then require two matching
// paragraph indents, complete literal ownership and cited definition subjects.
export function recoverExplicitDefinitionParagraphs(page, tables, notes) {
  return tables.map(({ rect }, index) => {
    const note = notes[index]?.find((n) => /^Notes?:/i.test(n.text))
    if (!note) return
    const first = page.lines.find(
      (l) =>
        /^Notes?:/i.test(l.text) &&
        Math.abs(l.y - note.rect[1]) < 0.1 &&
        l.x >= note.rect[0] &&
        l.x < note.rect[0] + l.fontSize * 0.5
    )
    if (!first) return
    const em = first.fontSize,
      left = note.rect[0],
      right = note.rect[2]
    const heads = page.lines
      .filter(
        (l) =>
          l.text.length >= 8 &&
          Math.abs(l.fontSize - em) < 0.1 &&
          l.x >= left - 0.1 &&
          l.x <= first.x + 0.1 &&
          l.x + l.width <= right + 0.1 &&
          l.y >= note.rect[1] &&
          l.y + l.height <= note.rect[3] + 0.1
      )
      .sort((a, b) => a.y - b.y)
    if (heads.length < 3) return
    const last = heads.at(-1),
      leading = last.y - heads.at(-2).y
    if (
      !(leading > em && leading < em * 1.5) ||
      Math.abs(heads.at(-2).y - heads.at(-3).y - leading) > em * 0.1
    )
      return
    const tailHeads = page.lines
      .filter(
        (l) =>
          l.text.length >= 8 &&
          Math.abs(l.fontSize - em) < 0.1 &&
          l.x >= left - 0.1 &&
          l.x <= first.x + 0.1 &&
          l.x + l.width <= right + 0.1 &&
          l.y > last.y + leading * 0.9 &&
          l.y < note.rect[3] + em * 12
      )
      .sort((a, b) => a.y - b.y)
    if (
      tailHeads.length < 4 ||
      tailHeads.some(
        (l, i) => Math.abs(l.y - (i ? tailHeads[i - 1].y : last.y) - leading) > em * 0.1
      )
    )
      return
    const paragraphs = tailHeads.flatMap((l, i) =>
      Math.abs(l.x - first.x) < 0.1 && l.x - left > em * 0.15 ? [i] : []
    )
    if (paragraphs.length < 2 || paragraphs[0] !== 0) return
    const end = tailHeads.at(-1).y + em
    const scope = page.lines.filter(
      (l) =>
        l.text.trim() &&
        l.y >= last.y + em * 0.7 &&
        l.y < end &&
        l.x < right &&
        l.x + l.width > left
    )
    if (
      scope.some(
        (l) =>
          ![l.x, l.y, l.width, l.height, l.fontSize].every(Number.isFinite) ||
          l.width <= 0 ||
          l.height <= 0 ||
          l.x < left - 0.1 ||
          l.x + l.width > right + 0.1 ||
          l.y + l.height > end + em * 0.2 ||
          l.fontSize < em * 0.5 ||
          l.fontSize > em * 1.2
      )
    )
      return
    const rowOf = (l) => tailHeads.flatMap((h, i) => (Math.abs(h.y - l.y) < 0.1 ? [i] : []))
    const rows = tailHeads.map(() => []),
      hats = new Map()
    for (const l of scope) {
      let matches = rowOf(l)
      if (!matches.length && l.text === 'ˆ') {
        const bases = scope.filter(
          (b) =>
            b !== l &&
            /^\p{L}/u.test(b.text) &&
            rowOf(b).length === 1 &&
            Math.abs(b.fontSize - em) < 0.1 &&
            (b.y - l.y) / em >= 0.2 &&
            (b.y - l.y) / em <= 0.35 &&
            l.x + l.width / 2 >= b.x &&
            l.x + l.width / 2 <= b.x + em &&
            l.width < em * 0.6
        )
        if (bases.length !== 1) return
        matches = rowOf(bases[0])
        hats.set(l, bases[0])
      } else if (!matches.length && l.text === '√') {
        const following = scope.filter(
          (b) =>
            b !== l &&
            rowOf(b).length === 1 &&
            Math.abs(b.fontSize - em) < 0.1 &&
            Math.abs(l.x + l.width - b.x) < em * 0.1 &&
            (b.y - l.y) / em >= 0.5 &&
            (b.y - l.y) / em <= 0.9
        )
        if (following.length !== 1) return
        matches = rowOf(following[0])
      } else if (!matches.length && l.fontSize <= em * 0.8) {
        const bases = scope.filter(
          (b) =>
            b !== l &&
            rowOf(b).length === 1 &&
            Math.abs(b.fontSize - em) < 0.1 &&
            Math.abs(l.x - b.x - b.width) < em * 0.1 &&
            Math.abs(l.y + l.fontSize - b.y - b.fontSize) > em * 0.15 &&
            Math.abs(l.y + l.fontSize - b.y - b.fontSize) < em * 0.8
        )
        if (bases.length !== 1) return
        matches = rowOf(bases[0])
      }
      if (matches.length !== 1) return
      rows[matches[0]].push(l)
    }
    const texts = rows.map((row) =>
      row
        .sort((a, b) => (hats.get(a) === b ? -1 : hats.get(b) === a ? 1 : a.x - b.x))
        .map((l) => l.text)
        .join(' ')
    )
    const word = (s) => s.toLowerCase().replace(/s$/, '')
    const keys = new Set(
      page.lines
        .filter(
          (l) =>
            l.y >= rect[1] &&
            l.y + l.height <= rect[3] &&
            l.x >= rect[0] &&
            l.x + l.width <= rect[2]
        )
        .flatMap((l) => l.text.match(/\b(?:[A-Z]|[A-Za-z]{2,})\b/g) ?? [])
        .map(word)
    )
    for (const [i, start] of paragraphs.entries()) {
      const text = texts.slice(start, paragraphs[i + 1] ?? texts.length).join(' ')
      if (
        !/\b(?:denotes?|represents?|(?:are|is) (?:computed|defined|calculated))\b/i.test(text) ||
        new Set(
          (text.match(/\b(?:[A-Z]|[A-Za-z]{2,})\b/g) ?? []).map(word).filter((k) => keys.has(k))
        ).size < 2
      )
        return
    }
    if (
      !/[.!?]$/.test(texts.at(-1)) ||
      tables.some(
        (t, i) =>
          i !== index &&
          t.rect[0] < right &&
          t.rect[2] > left &&
          t.rect[1] < end &&
          t.rect[3] > note.rect[3]
      )
    )
      return
    return {
      text: note.text + ' ' + joinCaptionLines(texts),
      rect: union([note.rect, ...scope.map(lineRect)])
    }
  })
}

// A table-data reference list is eligible only through the native table's
// reference header, repeated source citations and one matching closing rule.
// The label alone cannot turn an article bibliography into table notes.
export function recoverRuledReferenceNotes(page, tables, rules, lines, priorNotes) {
  const horizontal = joinHorizontalTableRules(rules)
  return tables.map(({ rect }, index) => {
    const body = page.lines.filter(
      (l) =>
        l.y >= rect[1] - 0.1 &&
        l.y + l.height <= rect[3] + 0.1 &&
        l.x >= rect[0] - 1 &&
        l.x + l.width <= rect[2] + 1
    )
    if (
      !body.some((l) => /\breferences?\b/i.test(l.text) && l.y < rect[1] + l.fontSize * 4) &&
      !priorNotes[index]?.some(
        (n) =>
          /^Notes?\./i.test(n.text) &&
          /\breference\b.{0,60}\blisted below this table\b/i.test(n.text)
      )
    )
      return []
    const cited = new Set(body.flatMap((l) => l.text.match(/\b\d{1,3}\b/g) ?? []))
    const found = []
    for (const start of lines.filter((l) => /^References\.\s*\(\d+\)/i.test(l.text))) {
      const em = start.fontSize,
        prior = priorNotes[index]?.at(-1)
      if (
        !(em > 0) ||
        start.y < rect[3] ||
        start.right < rect[0] ||
        start.x > rect[2] ||
        tables.some(
          (t, i) =>
            i !== index &&
            t.rect[3] > rect[3] &&
            t.rect[3] <= start.y &&
            t.rect[0] < start.right &&
            t.rect[2] > start.x
        )
      )
        continue
      const closings = horizontal.filter(
        (r) =>
          Math.abs(r[1] - rect[3]) < em &&
          r[1] <= start.y &&
          Math.abs(r[0] - rect[0]) < em &&
          Math.abs(r[2] - rect[2]) < em
      )
      if (closings.length !== 1) continue
      const closing = closings[0]
      const followsNote =
        prior &&
        /^Notes?\./i.test(prior.text) &&
        start.y >= prior.rect[3] &&
        start.y - prior.rect[3] < em * 1.5 &&
        Math.abs(start.x - prior.rect[0]) < 1
      if (
        (!followsNote && start.y - closing[1] > em * 1.5) ||
        lines.some(
          (l) =>
            l !== start &&
            l.text.trim() &&
            l.y >= closing[1] &&
            l.y < start.y - 0.1 &&
            l.x < start.right &&
            l.right > start.x &&
            !(followsNote && l.y >= prior.rect[1] - 0.1 && l.bottom <= prior.rect[3] + 0.1)
        )
      )
        continue
      const parts = [start]
      for (const next of lines.filter((l) => l.y > start.y + 2)) {
        if (next.x >= start.right || next.right <= start.x) continue
        const previous = parts.at(-1)
        if (
          Math.abs(next.x - start.x) > 1 ||
          Math.abs(next.fontSize - em) > 0.1 ||
          next.right > start.right + 1 ||
          next.y - previous.y < em ||
          next.y - previous.y > em * 1.4 ||
          captionKind(next.text) ||
          /^(?:Notes?|References?)\b/i.test(next.text)
        )
          break
        parts.push(next)
        if (next.right - next.x < (start.right - start.x) * 0.7 && /[.;]$/.test(next.text)) break
      }
      const text = joinCaptionLines(parts.map((l) => l.text))
      const keys = [...text.matchAll(/\((\d{1,3})\)\s*\p{L}/gu)].map((m) => m[1])
      if (
        keys.length < 3 ||
        new Set(keys).size !== keys.length ||
        keys[0] !== '1' ||
        keys.some((key, i) => Number(key) !== i + 1) ||
        keys.filter((key) => cited.has(key)).length < 3 ||
        !/(?:[.;]|\((?:18|19|20)\d{2}[a-z]?\))$/.test(parts.at(-1).text)
      )
        continue
      found.push({ text, rect: union(parts.map(lineRect)) })
    }
    return found
  })
}

// These unmarked formats are explanatory only inside a source-owned footer.
// Recognition alone never establishes a note or independent table eligibility.
const footerFormat = (text) =>
  /^Values are expressed as percentages? or means?\b.+\bSD\.(?:[⁰¹²³⁴⁵⁶⁷⁸⁹]|\s|$)/i.test(text) ||
  /^Valid percentages? \(%\) reported\./i.test(text) ||
  /^There (?:was|were) \d+(?:\.\d+)?(?: to \d+(?:\.\d+)?)?% missing data for (?:some|the) variables\.?$/i.test(
    text
  ) ||
  /^(?:Higher|Lower) scores are associated with (?:higher|lower)\b.+\blevels\.$/i.test(text) ||
  /^\(\+\)\s*Indicates scales where higher scores\s*=/i.test(text) ||
  /^Effect sizes were calculated for group differences\b.+\b(?:adjusted for|Bold numbers indicate)\b/i.test(
    text
  ) ||
  /^\d+ additional items\b.+\bnot reported in this manuscript\.?$/i.test(text)

const glossaryKeys = (text) =>
  [
    ...text.matchAll(
      /(?:^|[;,.]\s*)([A-Z][A-Z0-9-]{0,11})(?:\s*\([^)]{1,12}\))?\s*(?:[:=]\s*|,\s*|\s+)(?=\p{L}|$)/gu
    )
  ].map((m) => m[1])

// These openings describe existing table records. Their text is insufficient
// on its own: numeric body ink and a nearby native closing rule are required.
const closedFooterOpening = (text, body, words) => {
  const measured =
    body.filter((line) => (line.text.match(/\d+(?:\.\d+)?/g) ?? []).length >= 3).length >= 2
  if (!measured) return {}
  const keys = glossaryKeys(text)
  const glossary =
    (/^[A-Z][A-Z0-9-]{1,11},\s*\p{Ll}[\p{L} -]+\.$/u.test(text) &&
      keys.length === 1 &&
      (words.has(keys[0]) ||
        (/^SD, standard deviation\.$/.test(text) &&
          body.filter((l) => /\d+(?:\.\d+)?\s*\(\d+(?:\.\d+)?\)/.test(l.text)).length >= 2))) ||
    /^M,\s*Mean,\s*SD,\s*standard deviation\.?$/i.test(text)
  const subject = /^([\p{L}][\p{L} -]{2,39}):\s*[A-Z0-9]+(?:\/[A-Z0-9]+)?\s+ratio\b/u.exec(
    text
  )?.[1]
  const classification =
    subject &&
    (text.match(/\bratio\s*[<≤>,]\s*\d+(?:\.\d+)?/g) ?? []).length >= 2 &&
    body.some((line) =>
      line.text
        .toLowerCase()
        .replace(/[ -]/g, '')
        .includes(subject.toLowerCase().replace(/[ -]/g, ''))
    )
  const typography =
    /^P[-‐‑– ]?values less than or equal to \d+(?:\.\d+)? are denoted in bold\.$/i.test(text) &&
    body.some((line) => /\bp[-‐‑– ]?value\b/i.test(line.text))
  const annotation =
    /^Differences between groups are annotated with [*⁎†‡]\s*\(p\s*[<≤]\s*\.?\d+/i.test(text) &&
    body.some((line) => /[*⁎†‡]/.test(line.text))
  const legend = /^Legend:\s*[*⁎†‡],?\s*p[- ]?value\b.+\b(?:difference|between)\b/i.test(text)
  const method =
    annotation ||
    legend ||
    /^(?:Intention-to-treat|Per-protocol) analyses? of outcomes were performed with\b.+\b(?:model|analyses)\b/i.test(
      text
    ) ||
    /^Descriptive data at baseline were obtained using\b.+\bpost[- ]intervention\b.+\bimputation\b/i.test(
      text
    ) ||
    /^Means and confidence intervals\s*\([A-Z]{2,4}\) presented are adjusted for\b/i.test(text) ||
    /^[\p{L}’' -]{3,40}\bTest for [A-Z][A-Z-]+\s*\([^)]+\) significant at p\s*[<≤]\s*\d/u.test(text)
  return { glossary, classification, typography, method, legend }
}

// The source closing line, same-column line rhythm, body citations and a
// terminal short line delimit these blocks. Nearby article prose cannot use
// a statistical-looking sentence as a substitute for the closing line.
export function recoverRuledFooterNotes(page, tables, rules, lines) {
  const horizontal = joinHorizontalTableRules(rules)
  return tables.map(({ rect }, index) => {
    if (
      tables.some(
        ({ rect: other }, n) =>
          n !== index &&
          Math.abs(other[3] - rect[3]) < 2 &&
          (Math.min(other[2], rect[2]) - Math.max(other[0], rect[0])) /
            Math.min(other[2] - other[0], rect[2] - rect[0]) >
            0.7
      )
    )
      return []
    const body = lines.filter(
      (l) =>
        l.y >= rect[1] - 0.2 &&
        l.bottom <= rect[3] + 0.2 &&
        l.x >= rect[0] - 1 &&
        l.right <= rect[2] + 1
    )
    const words = new Set(body.flatMap((l) => l.text.match(/[A-Za-z0-9-]+/g) ?? []))
    const bodySize = Math.max(0, ...body.filter((l) => l.y > rect[3] - 60).map((l) => l.fontSize))
    const cite = (text) => {
      const keys = glossaryKeys(text)
      return keys.length >= 2 && new Set(keys.filter((key) => words.has(key))).size >= 2
    }
    const nearby = lines.filter(
      (l) =>
        l.y >= rect[3] - 0.2 &&
        l.y - rect[3] < 120 &&
        l.x >= rect[0] - 2 &&
        l.right <= rect[2] + l.fontSize &&
        (l.fontSize <= bodySize * 1.05 ||
          (l.fontSize <= bodySize * 1.25 &&
            lines.some(
              (next) =>
                next.y > l.bottom &&
                next.y - l.bottom < l.fontSize * 3 &&
                Math.abs(next.x - l.x) < l.fontSize &&
                Math.abs(next.fontSize - l.fontSize) < 0.2 &&
                /^(?:[*⁎†‡]\s*\p{L}|Abbreviations:)/u.test(next.text)
            ))) &&
        !isNotePageMargin(l, page)
    )
    const found = []
    let previous
    for (const start of nearby) {
      if (found.some((n) => n.parts.includes(start)) || /^\d+$/.test(start.text)) continue
      const opening = closedFooterOpening(start.text, body, words)
      const glossary = cite(start.text) || opening.glossary
      const format = footerFormat(start.text)
      const parameterMethod = /^The parameter estimates were calculated using\b/i.test(start.text)
      const method = parameterMethod || opening.method
      const cutoff =
        /^Clinically significant .+ cutoff for ([A-Z][A-Z0-9-]{1,11}) was a score of \d+(?:\.\d+)?\.$/.exec(
          start.text
        )
      const typography = /^(?:Percentages|Precentages) are in italics\.?$/i.test(start.text)
      if (
        !format &&
        !glossary &&
        !method &&
        !cutoff &&
        !typography &&
        !opening.classification &&
        !opening.typography
      )
        continue
      const adjacent =
        previous &&
        start.y - previous.parts.at(-1).bottom >= -0.2 &&
        start.y - previous.parts.at(-1).bottom < start.fontSize * 1.5 &&
        Math.abs(start.x - previous.parts[0].x) < 2 &&
        Math.abs(start.fontSize - previous.parts[0].fontSize) < 0.8
      if ((parameterMethod || cutoff || typography) && (!adjacent || !previous.glossary)) continue
      if (cutoff && !words.has(cutoff[1])) continue
      const footerRules =
        opening.method || opening.glossary
          ? joinHorizontalTableRules(rules, start.fontSize * 0.075)
          : horizontal
      const closing = footerRules.find(
        (r) =>
          r[1] >= rect[3] - 0.2 &&
          r[1] <= start.y &&
          start.y - r[1] < start.fontSize * 1.5 &&
          r[1] - rect[3] < start.fontSize * (opening.glossary ? 3 : 1.5) &&
          Math.min(r[2], rect[2]) - Math.max(r[0], rect[0]) > (rect[2] - rect[0]) * 0.85 &&
          (Math.abs(start.x - r[0]) < start.fontSize ||
            (opening.legend && start.x >= r[0] && start.right <= r[2]))
      )
      // Coarse path bounds cannot replace an exact closing rule generally.
      // Two aligned thin paths may enclose one same-baseline format strip.
      const bands = (page.graphicsBounds ?? [])
        .filter((g) => g.kind === 'path')
        .map((g) => g.normalizedRect.map((v, n) => v * (n % 2 ? page.height : page.width)))
        .filter(
          (b) =>
            b[3] - b[1] < start.fontSize * 0.9 &&
            Math.min(b[2], rect[2]) - Math.max(b[0], rect[0]) > (rect[2] - rect[0]) * 0.85
        )
      const upper =
        format &&
        bands.find(
          (b) =>
            b[1] >= rect[3] &&
            b[3] <= start.y &&
            start.y - b[3] < start.fontSize &&
            start.x >= b[0] - 1 &&
            start.x - b[0] < start.fontSize * 2.5
        )
      const lower =
        upper &&
        bands.find(
          (b) =>
            b[1] > start.bottom &&
            b[1] - start.bottom < start.fontSize * 1.5 &&
            Math.abs(b[0] - upper[0]) < 1 &&
            Math.abs(b[2] - upper[2]) < 1
        )
      if (!closing && !adjacent && !lower) continue
      if (
        lines.some(
          (l) =>
            l !== start &&
            l.y >= (adjacent ? previous.parts.at(-1).bottom : rect[3]) &&
            l.y < start.y - 2 &&
            l.text.trim() &&
            !/^\d+$/.test(l.text) &&
            l.x < start.right &&
            l.right > start.x
        )
      )
        continue
      const parts = [start]
      if (lower) {
        const marker = nearby.find(
          (l) =>
            /^\d{1,2}$/.test(l.text) &&
            l.x >= start.right &&
            l.x - start.right < start.fontSize * 0.6 &&
            start.bottom - l.bottom > start.fontSize * 0.15 &&
            Math.abs(l.y - start.y) < start.fontSize * 0.5 &&
            l.fontSize < start.fontSize * 0.8
        )
        const tail =
          marker &&
          nearby.find(
            (l) =>
              l !== start &&
              /^\p{Lu}/u.test(l.text) &&
              Math.abs(l.y - start.y) < 0.1 &&
              Math.abs(l.fontSize - start.fontSize) < 0.1 &&
              l.x >= marker.right &&
              l.x - marker.right < start.fontSize * 0.6 &&
              l.right < lower[2]
          )
        if (marker && tail) parts.push(marker, tail)
      } else {
        for (const next of nearby.filter((l) => l.y > start.y + 2)) {
          const last = parts.at(-1)
          if (next.x >= start.right || next.right <= start.x) continue
          if (
            opening.method &&
            /[.!?]$/.test(last.text) &&
            (parts.length === 1 || last.width < start.width * 0.85)
          )
            break
          const terminalKey =
            glossary &&
            /;\s*$/.test(last.text) &&
            /^[A-Z][A-Z0-9-]{1,11}\s*=\s*\p{Ll}/u.test(next.text) &&
            words.has(/^[A-Z][A-Z0-9-]*/.exec(next.text)[0])
          if (
            parts.length >= 10 ||
            next.y - last.y > start.fontSize * 1.8 ||
            Math.abs(next.x - start.x) > 2 ||
            Math.abs(next.fontSize - start.fontSize) > 0.8 ||
            captionKind(next.text) ||
            footerFormat(next.text) ||
            /^[a-z]\s+(?:\p{Lu}|\d)/u.test(next.text) ||
            (/^[*†‡]\s/.test(next.text) && next.fontSize < start.fontSize * 0.8) ||
            (!method && !terminalKey && (!/^\p{Ll}/u.test(next.text) || /[.!?]$/.test(last.text)))
          )
            break
          parts.push(next)
          if (
            method &&
            next.width < start.width * (opening.method ? 0.85 : 0.6) &&
            /[.!?]$/.test(next.text)
          )
            break
        }
      }
      if (
        parameterMethod &&
        (parts.length < 2 ||
          !/\b(?:maximum likelihood|regression|model)\b/i.test(
            parts.map((l) => l.text).join(' ')
          ) ||
          !/[.!?]$/.test(parts.at(-1).text) ||
          parts.at(-1).width >= start.width * 0.7)
      )
        continue
      const block = {
        parts,
        glossary,
        text: joinCaptionLines(parts.map((l) => l.text)),
        rect: union(parts.map(lineRect))
      }
      found.push(block)
      previous = block
    }
    return found.map(({ text, rect }) => ({ text, rect }))
  })
}

// Raised, consecutive note numbers and a repeated manuscript line rhythm are
// independent evidence. Ordinary numbered paragraphs and isolated references
// do not establish a double-spaced footnote sequence.
export function findDoubleSpacedNoteBlocks(page) {
  const lines = groupPageLines({
    ...page,
    lines: page.lines.filter((l) => !isNotePageMargin(l, page))
  }).sort((a, b) => a.y - b.y || a.x - b.x)
  const starts = lines.filter(
    (line) =>
      /^([1-9]\d?)\s+\p{L}/u.test(line.text) &&
      page.lines.some(
        (part) =>
          part.text === /^\d+/.exec(line.text)[0] &&
          Math.abs(part.x - line.x) < 1 &&
          Math.abs(part.y - line.y) < 2 &&
          part.fontSize < line.fontSize * 0.8 &&
          part.y + part.height < line.bottom - line.fontSize * 0.15
      )
  )
  if (
    !starts.length ||
    starts.some(
      (line, n) =>
        Math.abs(line.x - starts[0].x) > 2 ||
        Math.abs(line.fontSize - starts[0].fontSize) > 0.7 ||
        (n && Number(/^\d+/.exec(line.text)[0]) !== Number(/^\d+/.exec(starts[n - 1].text)[0]) + 1)
    )
  )
    return []
  const blocks = []
  let spacing,
    wrapped = 0
  for (const [n, start] of starts.entries()) {
    const parts = [start]
    for (const next of lines.filter(
      (l) => l.y > start.y + 2 && l.y < (starts[n + 1]?.y ?? Infinity)
    )) {
      const previous = parts.at(-1),
        gap = next.bottom - previous.bottom
      if (
        Math.abs(next.x - start.x) > 2 ||
        Math.abs(next.fontSize - start.fontSize) > 0.7 ||
        gap <= start.fontSize * 1.8 ||
        gap > start.fontSize * 2.5 ||
        (spacing !== undefined && Math.abs(gap - spacing) > 1) ||
        captionKind(next.text)
      )
        break
      spacing ??= gap
      parts.push(next)
      wrapped++
      if (next.right - next.x < (start.right - start.x) * 0.8 && /[.;)]$/.test(next.text)) break
    }
    if (n && start.y - blocks[n - 1].lines.at(-1).bottom > start.fontSize * 4) return []
    blocks.push({ number: Number(/^\d+/.exec(start.text)[0]), lines: parts })
  }
  // An isolated raised note may occupy the entire remaining page. Only its
  // one aligned lowercase continuation can replace the missing repetition;
  // extra prose or a completed first sentence makes ownership uncertain.
  if (starts.length === 1) {
    const parts = blocks[0].lines
    return parts.length === 2 &&
      !/[.;!?]$/.test(parts[0].text) &&
      /^[a-z]/.test(parts[1].text) &&
      lines.filter((l) => l.y >= starts[0].y).every((l) => parts.includes(l))
      ? blocks
      : []
  }
  return wrapped >= 2 ? blocks : []
}

export function isNotePageMargin(line, page) {
  const bottom = line.bottom ?? line.y + line.height
  return (
    (/^\d+$/.test(line.text.trim()) &&
      (line.y > page.height * 0.9 || bottom < page.height * 0.06)) ||
    (bottom - line.y > line.fontSize * 2 &&
      /^(?:ACCEPTED (?:MANUSCRIPT|ARTICLE)|JOURNAL PRE[- ]PROOF|PROOF)$/i.test(line.text.trim())) ||
    (/^Downloaded from\s+https?:\/\//i.test(line.text) &&
      line.x > page.width * 0.9 &&
      bottom - line.y > line.fontSize * 2)
  )
}
// A centered glossary may wrap after '=' and change its line indent. Native
// closing endpoints, multiple citations, a uniform font/leading and one shared
// center establish this footer; equation prose and uncited definitions decline.
export function recoverCenteredRuledGlossaries(page, tables, rules, lines) {
  const keys = (text) =>
    [...text.matchAll(/(?:^|;\s*)([A-Za-z0-9][A-Za-z0-9,.-]{1,15})\s*=/g)].map((m) => m[1])
  const canonical = (text) => text.toLowerCase().replace(/[,.]/g, '')
  const horizontal = joinHorizontalTableRules(rules)
  return tables.map(({ rect }, index) => {
    const closings = horizontal.filter(
      (r) =>
        r[1] >= rect[3] - 0.2 &&
        r[1] - rect[3] < 16 &&
        Math.abs(r[0] - rect[0]) < 4 &&
        Math.abs(r[2] - rect[2]) < 4
    )
    if (closings.length !== 1) return []
    const closing = closings[0],
      center = (closing[0] + closing[2]) / 2
    const body = lines.filter(
      (l) =>
        l.y >= rect[1] &&
        l.bottom <= closing[1] &&
        l.x >= closing[0] - 1 &&
        l.right <= closing[2] + 1
    )
    const words = new Set(
      body.flatMap((l) => l.text.match(/[A-Za-z0-9][A-Za-z0-9,.-]*/g) ?? []).map(canonical)
    )
    const bodySize = Math.max(0, ...body.map((l) => l.fontSize))
    const starters = lines.filter(
      (l) =>
        l.y >= closing[1] &&
        l.y - closing[1] < l.fontSize * 1.5 &&
        l.fontSize > 0 &&
        l.fontSize <= bodySize &&
        Math.abs((l.x + l.right) / 2 - center) < l.fontSize * 0.8 &&
        /^[A-Za-z0-9][A-Za-z0-9,.-]{1,15}\s*=/.test(l.text) &&
        keys(l.text).length >= 2
    )
    if (starters.length !== 1) return []
    const start = starters[0],
      size = start.fontSize,
      parts = [start]
    if (
      tables.some(
        ({ rect: other }, n) =>
          n !== index &&
          Math.abs(other[3] - rect[3]) < size * 2 &&
          other[0] < start.right &&
          other[2] > start.x
      )
    )
      return []
    const following = lines
      .filter((l) => l.y > start.y + 2 && l.x < start.right && l.right > start.x)
      .sort((a, b) => a.y - b.y)
    let leading
    for (const next of following) {
      const last = parts.at(-1),
        gap = next.y - last.y
      if (gap > size * 1.5 || Math.abs(next.fontSize - size) > 0.1) break
      if (
        parts.length >= 8 ||
        gap < size ||
        captionKind(next.text) ||
        Math.abs((next.x + next.right) / 2 - center) > size * 0.8 ||
        next.x < Math.min(closing[0], start.x) - size * 0.1 ||
        next.right > Math.max(closing[2], start.right) + size * 0.1 ||
        (leading !== undefined && Math.abs(gap - leading) > size * 0.05)
      )
        return []
      if (!/[=;]\s*$/.test(last.text) && keys(next.text).length === 0) break
      if (!keys(next.text).length && !/=\s*$/.test(last.text)) return []
      leading ??= gap
      parts.push(next)
      if (/[.]\s*$/.test(next.text)) break
    }
    const text = joinCaptionLines(parts.map((l) => l.text)),
      defined = keys(text)
    if (
      defined.length < 3 ||
      new Set(defined.filter((k) => words.has(canonical(k)))).size < 2 ||
      /=\s*$/.test(text)
    )
      return []
    const terminal = parts.at(-1)
    if (
      !/[.;]\s*$/.test(text) &&
      !(
        parts.length >= 2 &&
        /=\s*$/.test(parts.at(-2).text) &&
        terminal.right - terminal.x < (parts.at(-2).right - parts.at(-2).x) * 0.75
      )
    )
      return []
    const intervening = lines.filter(
      (l) =>
        !parts.includes(l) &&
        l.y >= closing[1] &&
        l.y < terminal.bottom &&
        l.x < Math.max(...parts.map((p) => p.right)) &&
        l.right > Math.min(...parts.map((p) => p.x))
    )
    if (intervening.some((l) => l.text.trim())) return []
    return [{ text, rect: union(parts.map(lineRect)) }]
  })
}
