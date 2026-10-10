/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { recoverRuledContinuationCounts } from './literature-pdf-sectional-records.mjs'
import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'

const nativeItemLines = (items) => {
  const groups = []
  for (const item of [...items].sort((a, b) => a.rect[3] - b.rect[3] || a.rect[0] - b.rect[0])) {
    const line = groups.find((g) => Math.abs(g[0].rect[3] - item.rect[3]) < item.height * 0.2)
    if (line) line.push(item)
    else groups.push([item])
  }
  return groups.map((group) => {
    const parts = group.sort((a, b) => a.rect[0] - b.rect[0])
    return {
      parts,
      text: parts
        .map((i) => i.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
      rect: [
        Math.min(...parts.map((i) => i.rect[0])),
        Math.min(...parts.map((i) => i.rect[1])),
        Math.max(...parts.map((i) => i.rect[2])),
        Math.max(...parts.map((i) => i.rect[3]))
      ]
    }
  })
}

// Number and descriptive title occupy their own four-sided native band,
// followed by a separate ruled header and repeated numeric records. The
// detector's body crop cannot turn an enclosed title into unrelated prose.
export function recoverEnclosedTableDescriptionCaption(table, items, rules, caption, scale = 1.5) {
  if (
    !(scale > 0) ||
    !caption ||
    caption.lines?.length !== 1 ||
    !/^Table\s+\d+$/.test(caption.lines[0])
  )
    return
  const titleRect = caption.rect.map((v) => v * scale),
    crop = table.cropRect
  const number = items.filter(
    (i) =>
      i.horizontal &&
      i.text?.trim() &&
      i.rect[0] >= titleRect[0] - 0.2 &&
      i.rect[2] <= titleRect[2] + 0.2 &&
      i.rect[1] >= titleRect[1] - 0.2 &&
      i.rect[3] <= titleRect[3] + 0.2
  )
  if (
    !number.length ||
    nativeItemLines(number)
      .map((l) => l.text)
      .join(' ') !== caption.lines[0]
  )
    return
  const h = Math.max(...number.map((i) => i.height)),
    horizontal = joinHorizontalTableRules(rules)
  const above = horizontal.filter(
    (r) =>
      r[1] <= titleRect[1] &&
      titleRect[1] - r[1] < h &&
      Math.abs(r[0] - crop[0]) < h &&
      Math.abs(r[2] - crop[2]) < h
  )
  if (above.length !== 1) return
  const top = above[0],
    below = horizontal
      .filter(
        (r) =>
          r[1] > titleRect[3] &&
          r[1] - titleRect[3] < h * 5 &&
          r[1] < crop[1] + h &&
          Math.abs(r[0] - top[0]) < 0.2 &&
          Math.abs(r[2] - top[2]) < 0.2
      )
      .sort((a, b) => a[1] - b[1])
  if (!below.length) return
  const bottom = below[0]
  if (
    ![top[0], top[2]].every((x) =>
      rules.some(
        (r) =>
          r[0] === r[2] &&
          Math.abs(r[0] - x) < h * 0.05 &&
          Math.abs(r[1] - top[1]) < h * 0.05 &&
          Math.abs(r[3] - bottom[1]) < h * 0.05
      )
    )
  )
    return
  const enclosed = items.filter(
    (i) =>
      i.horizontal &&
      i.text?.trim() &&
      i.rect[0] >= top[0] &&
      i.rect[2] <= top[2] &&
      i.rect[1] >= top[1] &&
      i.rect[3] <= bottom[1]
  )
  if (enclosed.some((i) => Math.abs(i.height - h) > h * 0.05)) return
  const lines = nativeItemLines(enclosed),
    descriptions = lines.slice(1)
  const centre = (top[0] + top[2]) / 2
  if (
    lines[0]?.text !== caption.lines[0] ||
    descriptions.length < 1 ||
    descriptions.length > 3 ||
    descriptions.some(
      (l, n) =>
        !/\p{L}/u.test(l.text) ||
        /\d/.test(l.text) ||
        Math.abs((l.rect[0] + l.rect[2]) / 2 - centre) > h ||
        l.rect[1] - lines[n].rect[3] < -0.1 ||
        l.rect[1] - lines[n].rect[3] > h * 0.8
    )
  )
    return
  const headerEnd = horizontal.filter(
    (r) =>
      r[1] > bottom[1] &&
      r[1] - bottom[1] < h * 3 &&
      Math.abs(r[0] - top[0]) < 0.2 &&
      Math.abs(r[2] - top[2]) < 0.2
  )
  if (headerEnd.length !== 1) return
  const body = items.filter(
    (i) =>
      i.horizontal &&
      i.rect[0] >= top[0] &&
      i.rect[2] <= top[2] &&
      i.rect[1] > headerEnd[0][1] &&
      i.rect[3] <= crop[3]
  )
  if (
    nativeItemLines(body).filter((l) => (l.text.match(/\d+(?:\.\d+)?/g) ?? []).length >= 3).length <
    2
  )
    return
  return {
    ...caption,
    lines: lines.map((l) => l.text),
    rect: [
      Math.min(...lines.map((l) => l.rect[0])),
      Math.min(...lines.map((l) => l.rect[1])),
      Math.max(...lines.map((l) => l.rect[2])),
      Math.max(...lines.map((l) => l.rect[3]))
    ].map((v) => v / scale)
  }
}

// A supplementary attachment list describes files elsewhere. Require the
// section heading, repeated numbered file entries, an explicit file label
// after this title, and every candidate glyph inside that one entry. Native
// table borders or numeric cells preserve local table eligibility.
export function isExternalAttachmentTableRegion(table, items, rules, caption, scale = 1.5) {
  if (!(scale > 0) || !caption?.lines?.length || !/^Table\s+S\d+\b/.test(caption.lines[0]))
    return false
  const crop = table.cropRect,
    title = caption.rect.map((v) => v * scale)
  const source = items.filter(
    (i) =>
      i.horizontal &&
      i.text?.trim() &&
      i.rect[0] >= title[0] - i.height * 0.3 &&
      i.rect[2] <= crop[2] + i.height * 2
  )
  const lines = nativeItemLines(source)
  const heading = lines.filter(
    (l) => /^(?:Supporting|Supplementary) Information$/i.test(l.text) && l.rect[3] < title[1]
  )
  if (heading.length !== 1) return false
  const entries = lines.filter(
    (l) => l.rect[1] > heading[0].rect[3] && /^(?:Table|Figure)\s+S\d+\b/.test(l.text)
  )
  if (entries.length < 2) return false
  const owned = source.filter(
    (i) =>
      i.rect[0] >= crop[0] && i.rect[2] <= crop[2] && i.rect[1] >= crop[1] && i.rect[3] <= crop[3]
  )
  if (!owned.length) return false
  // A detector can cover the file label of a later entry while association
  // selects the preceding supplementary title. Local ink, rather than that
  // uncertain title match, must place every glyph in one complete entry.
  const firstInk = Math.min(...owned.map((i) => i.rect[1]))
  const start = entries.filter((l) => l.rect[1] <= firstInk).at(-1)
  if (!start || !/^Table\s+S\d+\b/.test(start.text)) return false
  const next = entries.find((l) => l.rect[1] > start.rect[3])
  const tails = lines.filter(
    (l) =>
      l.rect[1] > start.rect[3] &&
      l.rect[1] < (next?.rect[1] ?? Infinity) &&
      /^\((?:DOCX?|XLSX?)\)$/.test(l.text)
  )
  if (tails.length !== 1) return false
  const end = tails[0],
    h = end.rect[3] - end.rect[1]
  const entry = lines.filter((l) => l.rect[1] >= start.rect[1] && l.rect[3] <= end.rect[3])
  if (
    entry.some((l) => Math.abs(l.rect[0] - start.rect[0]) > h * 0.3) ||
    entry.slice(1).some((l, n) => l.rect[1] - entry[n].rect[3] > h) ||
    entry
      .flatMap((l) => l.parts)
      .filter((i) => /^[-−]?\d+(?:\.\d+)?(?:\s*\([\d.%-]+\))?$/.test(i.text.trim())).length >= 2
  )
    return false
  if (
    joinHorizontalTableRules(rules).some(
      (r) =>
        r[1] >= start.rect[1] &&
        r[1] <= end.rect[3] &&
        Math.min(r[2], crop[2]) - Math.max(r[0], crop[0]) > (crop[2] - crop[0]) * 0.6
    )
  )
    return false
  return owned.every((i) => i.rect[1] >= start.rect[1] && i.rect[3] <= end.rect[3])
}

// Qualify only source-proved table continuations and first-page contact blocks.
// These checks do not admit ordinary captionless prose or infer missing values.
export function recoverNativeCountContinuationCaption(
  table,
  items,
  rules,
  pageNumber,
  previousPage,
  captions,
  previousRules = []
) {
  if (!previousPage || previousPage.pageNumber !== pageNumber - 1) return
  if (captions.some((c) => c.page === pageNumber && /^Table\s+\d+/i.test(c.lines[0]))) return
  const prior = captions.filter(
    (c) => c.page === previousPage.pageNumber && /^Table\s+\d+/i.test(c.lines[0])
  )
  if (prior.length !== 1) return
  const proof = recoverRuledContinuationCounts(table, items, rules)
  if (!proof || proof.headerRows.length || proof.columns.length !== 5) return
  const source = [...proof.ownedTokens]
  const h = source.map((i) => i.height).sort((a, b) => a - b)[source.length >> 1]
  if (proof.cropRect[1] > h * 12) return
  const caption = prior[0]
  const sameWidth = joinHorizontalTableRules(previousRules).filter(
    (r) =>
      Math.abs(r[0] - (proof.cropRect[0] + 0.5)) <= h * 0.1 &&
      Math.abs(r[2] - (proof.cropRect[2] - 0.5)) <= h * 0.1 &&
      r[1] > caption.rect[3] * 1.5
  )
  const lines = previousPage.lines.filter((l) => l.y >= caption.rect[3])
  const pairs = lines.filter((l) => /^\d+\s*\(\d+(?:\.\d+)?%\)$/.test(l.text.trim()))
  const anchors = [...new Set(pairs.map((l) => Math.round(l.x * 150) / 100))].sort((a, b) => a - b)
  const firstPairY = Math.min(...pairs.map((l) => l.y))
  const header = lines.filter((l) => l.y < firstPairY)
  if (
    anchors.length !== 3 ||
    (
      header
        .map((l) => l.text)
        .join(' ')
        .match(/\(n\s*=\s*\d+\)/g) ?? []
    ).length !== 3
  )
    return
  const probabilityHeader = header.filter((l) => /\bp[- ]value\b/i.test(l.text))
  if (
    probabilityHeader.length !== 1 ||
    probabilityHeader[0].x * 1.5 < proof.columns[3][0] ||
    probabilityHeader[0].x * 1.5 >= proof.columns[3][2]
  )
    return
  const headerTop = Math.min(...header.map((l) => l.y)) * 1.5
  const opening = sameWidth.filter(
    (r) => r[1] <= headerTop + h * 0.1 && headerTop - r[1] <= h * 1.5
  )
  const lastPairBottom = Math.max(...pairs.map((l) => l.y + l.height)) * 1.5
  const closing = sameWidth.filter((r) => r[1] >= lastPairBottom && r[1] - lastPairBottom <= h * 2)
  if (opening.length !== 1 || closing.length !== 1 || opening[0][1] >= closing[0][1]) return
  const numeric = /^\d+(?:\s*\(\d+(?:\.\d+)?%\))?$/
  for (const [n, column] of [1, 2, 4].entries()) {
    const band = proof.columns[column]
    const current = source.filter(
      (i) => i.rect[0] >= band[0] && i.rect[2] <= band[2] && numeric.test(i.text.trim())
    )
    if (
      !current.length ||
      anchors[n] < band[0] ||
      anchors[n] >= band[2] ||
      Math.abs(Math.min(...current.map((i) => i.rect[0])) - anchors[n]) > h * 0.1 ||
      pairs.filter((l) => Math.abs(l.x * 1.5 - anchors[n]) < h * 0.1).length < 2
    )
      return
  }
  const pairedBaselines = pairs
    .filter((l) => Math.abs(l.x * 1.5 - anchors[0]) < h * 0.1)
    .filter((l) =>
      anchors
        .slice(1)
        .every((x) =>
          pairs.some(
            (r) => Math.abs(r.x * 1.5 - x) < h * 0.1 && Math.abs(r.y - l.y) * 1.5 < h * 0.1
          )
        )
    )
  if (pairedBaselines.length < 2) return
  return caption
}

export function isNativeAuthorAffiliationRegion(table, items, pageNumber, caption, rules) {
  if (pageNumber !== 1 || caption || !table.cropRect) return false
  const box = table.cropRect
  const source = items.filter(
    (i) =>
      i.horizontal &&
      i.rect[0] >= box[0] &&
      i.rect[2] <= box[2] &&
      i.rect[1] >= box[1] &&
      i.rect[3] <= box[3]
  )
  const email = source.filter((i) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(i.text.trim()))
  if (email.length !== 1) return false
  const h = email[0].height
  const superscripts = source
    .filter((i) => /^\d$/.test(i.text) && i.height < h * 0.8 && i.rect[3] > email[0].rect[3])
    .sort((a, b) => a.rect[1] - b.rect[1])
  if (
    superscripts.length < 4 ||
    superscripts.some(
      (i, n) => Number(i.text) !== n + 1 || Math.abs(i.rect[0] - superscripts[0].rect[0]) > h * 0.1
    )
  )
    return false
  const bodies = superscripts.map((s) =>
    source.filter(
      (i) =>
        i.height >= h * 0.95 &&
        i.height <= h * 1.05 &&
        i.rect[0] > s.rect[2] &&
        i.rect[0] - s.rect[2] < h * 2 &&
        Math.abs(i.rect[3] - s.rect[3]) < h * 0.5
    )
  )
  if (
    bodies.some((b) => b.length !== 1) ||
    bodies.filter((b) => /\b(?:Department|Unit|Universit[ée]?)\b/i.test(b[0].text)).length < 3
  )
    return false
  const opening = rules.filter(
    (r) =>
      r[1] === r[3] &&
      Math.abs(r[0] - superscripts[0].rect[0]) < h &&
      Math.abs(r[2] - box[2]) < h &&
      r[1] >= box[1] - h &&
      r[1] < email[0].rect[1]
  )
  if (
    opening.length !== 1 ||
    rules.some(
      (r) =>
        r[1] === r[3] &&
        r[1] > email[0].rect[3] &&
        r[1] < box[3] + h &&
        r[0] <= box[0] + h &&
        r[2] >= box[2] - h
    )
  )
    return false
  return true
}

export function recoverPriorCohortContinuation(
  items,
  rules,
  pageNumber,
  previousPage,
  captions,
  detected = []
) {
  if (!previousPage || previousPage.pageNumber !== pageNumber - 1) return
  const priorCaptions = captions.filter(
    (c) => c.page === pageNumber - 1 && /^Table\s+\d+[:.]?\s+/i.test(c.lines[0])
  )
  if (priorCaptions.length !== 1) return
  const caption = priorCaptions[0]
  const headers = previousPage.lines.filter(
    (l) =>
      l.y > caption.rect[3] &&
      l.y - caption.rect[3] < l.height * 5 &&
      (l.text.match(/\(n\s*=\s*\d+\)/g) ?? []).length === 2 &&
      /\bp[- ]value\b/i.test(l.text)
  )
  if (headers.length !== 1) return
  const h = headers[0].height * 1.5
  const source = items.filter((i) => i.horizontal && i.height >= h * 0.95 && i.height <= h * 1.05)
  const priorPairs = previousPage.lines.filter(
    (l) => l.y > headers[0].y && /^\d+\s*\(\d+(?:\.\d+)?%\)$/.test(l.text.trim())
  )
  const anchors = [...new Set(priorPairs.map((l) => Math.round(l.x * 1.5 * 100) / 100))].sort(
    (a, b) => a - b
  )
  if (
    anchors.length !== 2 ||
    anchors.some((x) => priorPairs.filter((l) => Math.abs(l.x * 1.5 - x) < h * 0.1).length < 2)
  )
    return
  const horizontal = rules
    .filter((r) => r[1] === r[3] && r[0] < anchors[0] && r[2] > anchors[1])
    .sort((a, b) => a[1] - b[1])
  const top = horizontal.find((r) => r[1] < h * 12)
  if (!top) return
  const bands = horizontal.filter(
    (r) => Math.abs(r[0] - top[0]) < h * 0.1 && Math.abs(r[2] - top[2]) < h * 0.1
  )
  if (bands.length < 5 || bands[0] !== top) return
  const bottom = bands.at(-1)
  const currentCaptions = captions.filter(
    (c) => c.page === pageNumber && /^Table\s+\d+/i.test(c.lines[0])
  )
  if (!currentCaptions.length || currentCaptions.some((c) => c.rect[1] * 1.5 <= bottom[1])) return
  const enclosed = source.filter(
    (i) =>
      i.rect[0] >= top[0] &&
      i.rect[2] <= top[2] &&
      i.rect[1] >= top[1] - h * 0.1 &&
      i.rect[3] <= bottom[1]
  )
  if (
    !enclosed.length ||
    Math.min(...enclosed.map((i) => i.rect[1])) - top[1] > h ||
    bands
      .slice(1)
      .some(
        (r, n) => !enclosed.some((i) => i.rect[3] >= bands[n][1] - h * 0.1 && i.rect[3] <= r[1])
      )
  )
    return
  const groups = []
  for (const i of enclosed.sort((a, b) => a.rect[3] - b.rect[3] || a.rect[0] - b.rect[0])) {
    const g = groups.find((r) => Math.abs(r[0].rect[3] - i.rect[3]) < h * 0.2)
    if (g) g.push(i)
    else groups.push([i])
  }
  const numeric = /^\d+(?:\.\d+)?(?:\s*\(\d+(?:\.\d+)?%\))?$/
  const probability = groups.filter(
    (g) =>
      g.length === 2 &&
      /\p{L}/u.test(g[0].text) &&
      numeric.test(g[1].text) &&
      Number(g[1].text) <= 1 &&
      g[1].rect[0] > anchors[1] + h * 5
  )
  if (
    probability.length < 3 ||
    probability.some((g) => Math.abs(g[1].rect[0] - probability[0][1].rect[0]) > h * 0.1)
  )
    return
  const pStart = probability[0][1].rect[0]
  const starts = [
    Math.min(
      ...enclosed
        .filter((i) => i.rect[0] < anchors[0] && /\p{L}/u.test(i.text))
        .map((i) => i.rect[0])
    ),
    ...anchors,
    pStart
  ]
  if (!Number.isFinite(starts[0])) return
  const records = groups.filter((g) =>
    g.some((i) => /^\(?\d/.test(i.text) && i.rect[0] >= anchors[0] - h * 0.1 && i.rect[0] < pStart)
  )
  const complete = records.filter((g) =>
    anchors.every((x, c) => {
      const text = g
        .filter((i) => i.rect[0] >= x - h * 0.1 && i.rect[0] < (c ? pStart : anchors[1]) - h * 0.1)
        .map((i) => i.text)
        .join(' ')
      return /^\d+\s*\(\d+(?:\.\d+)?%\)$/.test(text)
    })
  )
  if (
    complete.length < 6 ||
    records.some((g) => !g.some((i) => i.rect[0] < anchors[0] && /\p{L}/u.test(i.text)))
  )
    return
  const content = enclosed.filter((i) => !/^Abbreviation:/i.test(i.text))
  const cuts = [top[0]]
  for (let c = 1; c < starts.length; c++) {
    const lane = content.filter(
      (i) => i.rect[0] >= starts[c - 1] - h * 0.1 && i.rect[0] < starts[c] - h * 0.1
    )
    const end = Math.max(...lane.map((i) => i.rect[2]))
    if (!lane.length || end >= starts[c]) return
    cuts.push((end + starts[c]) / 2)
  }
  cuts.push(top[2])
  const cropRect = [top[0], Math.min(top[1], ...content.map((i) => i.rect[1])), top[2], bottom[1]]
  if (
    detected.some((t) => {
      const b = t.cropRect
      return b[0] < cropRect[2] && b[2] > cropRect[0] && b[1] < cropRect[3] && b[3] > cropRect[1]
    })
  )
    return
  const ys = groups.map((g) => [
    Math.min(...g.map((i) => i.rect[1])),
    Math.max(...g.map((i) => i.rect[3]))
  ])
  const rows = ys.map((y, n) => [
    cropRect[0],
    n ? (ys[n - 1][1] + y[0]) / 2 : cropRect[1],
    cropRect[2],
    n + 1 < ys.length ? (y[1] + ys[n + 1][0]) / 2 : y[1]
  ])
  const columns = cuts.slice(1).map((x, c) => [cuts[c], cropRect[1], x, cropRect[3]])
  return {
    caption,
    table: {
      id: `page-${pageNumber}-native-cohort-continuation`,
      cropRect,
      structure: {
        objects: [
          ...rows.map((rect) => ({
            label: 'table row',
            rect: rect.map((v, i) => v - cropRect[i % 2])
          })),
          ...columns.map((rect) => ({
            label: 'table column',
            rect: rect.map((v, i) => v - cropRect[i % 2])
          }))
        ]
      }
    }
  }
}

// One numbered table can contain a probability comparison followed by a
// regression block with a different leaf count. Require both native frames
// and every original record before replacing overlapping detector proposals.
export function recoverAdjacentStatisticalSections(tables, items, captions, rules, pageNumber) {
  const titles = captions.filter((c) => c.page === pageNumber && /^Table\s+\d+/i.test(c.lines[0]))
  if (titles.length !== 1 || tables.length < 3) return
  const caption = titles[0]
  const h = items
    .filter((i) => i.horizontal && i.rect[1] >= caption.rect[3] && i.rect[1] < caption.rect[3] + 40)
    .map((i) => i.height)
    .sort((a, b) => a - b)[0]
  if (!h) return
  const width = Math.max(...tables.map((t) => t.cropRect[2] - t.cropRect[0]))
  const full = rules
    .filter(
      (r) =>
        r[1] === r[3] &&
        r[1] >= caption.rect[3] &&
        r[1] - caption.rect[3] < h * 25 &&
        r[0] <= caption.rect[0] &&
        r[2] >= caption.rect[2] &&
        r[2] - r[0] >= width * 0.8
    )
    .sort((a, b) => a[1] - b[1])
  if (
    full.length !== 6 ||
    full.some((r) => Math.abs(r[0] - full[0][0]) > h * 0.1 || Math.abs(r[2] - full[0][2]) > h * 0.1)
  )
    return
  const [left, top, right] = full[0],
    bottom = full.at(-1)[1],
    divider = full[2][1]
  const source = items.filter(
    (i) =>
      i.horizontal &&
      i.rect[0] >= left &&
      i.rect[2] <= right &&
      i.rect[1] >= top &&
      i.rect[3] <= bottom
  )
  const groups = []
  for (const i of source.sort((a, b) => a.rect[3] - b.rect[3] || a.rect[0] - b.rect[0])) {
    const g = groups.find((g) => Math.abs(g[0].rect[3] - i.rect[3]) < h * 0.1)
    if (g) g.push(i)
    else groups.push([i])
  }
  const text = (g) =>
    g
      .map((i) => i.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
  const upper = groups.filter((g) => g[0].rect[3] < divider),
    lower = groups.filter((g) => g[0].rect[1] > divider),
    partitioned = [...upper.flat(), ...lower.flat()]
  // Native frames prove a split only when every source token belongs entirely
  // to exactly one section. A token crossing the divider cannot be discarded.
  if (
    partitioned.length !== source.length ||
    new Set(partitioned).size !== source.length ||
    upper.some((g) => g.some((i) => i.rect[3] >= divider)) ||
    lower.some((g) => g.some((i) => i.rect[1] <= divider))
  )
    return
  if (
    upper.length !== 5 ||
    lower.length < 5 ||
    lower.length > 10 ||
    !/^Repeated measures analyses\b/i.test(text(upper[0])) ||
    !/^Regression model:/i.test(text(lower[0]))
  )
    return
  if (
    upper[0].length !== 1 ||
    lower[0].length !== 1 ||
    upper[1].length !== 4 ||
    text(upper[1]) !== 'Response Curvature Main arm effect Arm*Week' ||
    text(lower[1]) !== 'Week R2 RSME Estimate P value'
  )
    return
  if (
    upper[1].some((i) => i.rect[1] < full[1][1]) ||
    lower[1].some((i) => i.rect[1] < full[3][1] || i.rect[3] > full[4][1])
  )
    return
  const headerLow = [
    ...lower[1].slice(0, 4),
    {
      ...lower[1][4],
      text: lower[1]
        .slice(4)
        .map((i) => i.text)
        .join(' '),
      rect: [lower[1][4].rect[0], lower[1][4].rect[1], lower[1].at(-1).rect[2], lower[1][4].rect[3]]
    }
  ]
  if (lower[1].length < 5 || lower[1].length > 6) return
  const build = (band, header, width, start, end, bodyTop) => {
    const cuts = [left]
    for (let c = 1; c < width; c++) cuts.push((header[c - 1].rect[2] + header[c].rect[0]) / 2)
    cuts.push(right)
    const body = band.slice(2)
    for (const [n, g] of body.entries()) {
      if (g.some((i) => i.rect[1] < bodyTop)) return
      const values = cuts
        .slice(1)
        .map((x, c) => text(g.filter((i) => i.rect[0] >= cuts[c] && i.rect[2] <= x)))
      if (
        g.some(
          (i) => cuts.slice(1).filter((x, c) => i.rect[0] >= cuts[c] && i.rect[2] <= x).length !== 1
        )
      )
        return
      if (
        width === 4
          ? !/^[A-Za-z]\*-baseline$/.test(values[0]) ||
            values.slice(1).some((v) => !/^P\s*=\s*(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(v))
          : Number(values[0]) !== n + 1 ||
            values
              .slice(1)
              .some((v) => !/^<?(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(v.replace(/\s/g, '')))
      )
        return
    }
    const y = band.map((g) => [
      Math.min(...g.map((i) => i.rect[1])),
      Math.max(...g.map((i) => i.rect[3]))
    ])
    const rows = y.map((v, n) => [
      left,
      n ? (y[n - 1][1] + v[0]) / 2 : start,
      right,
      n + 1 < y.length ? (v[1] + y[n + 1][0]) / 2 : end
    ])
    const cropRect = [left, start, right, end]
    const columns = cuts.slice(1).map((x, c) => [cuts[c], start, x, end])
    return {
      cropRect,
      structure: {
        objects: [
          ...rows.map((rect) => ({
            label: 'table row',
            rect: rect.map((v, i) => v - cropRect[i % 2])
          })),
          ...columns.map((rect) => ({
            label: 'table column',
            rect: rect.map((v, i) => v - cropRect[i % 2])
          })),
          { label: 'table column header', rect: [0, 0, right - left, rows[1][3] - start] },
          { label: 'table spanning cell', rect: [0, 0, right - left, rows[0][3] - start] }
        ]
      }
    }
  }
  const underline = rules
    .filter(
      (r) =>
        r[1] === r[3] &&
        r[1] > upper[1][0].rect[3] &&
        r[1] < upper[2][0].rect[1] &&
        r[0] >= left &&
        r[2] <= right
    )
    .sort((a, b) => a[0] - b[0])
  if (
    underline.length !== 4 ||
    upper[1].some((i, c) => underline[c][0] > i.rect[0] || underline[c][2] < i.rect[2]) ||
    underline.some((r, n) => n && r[0] > underline[n - 1][2])
  )
    return
  const first = build(upper, upper[1], 4, top, divider, underline[0][1]),
    second = build(lower, headerLow, 5, divider, bottom, full[4][1])
  if (!first || !second) return
  const replaced = tables.filter((t) => {
    const b = t.cropRect
    return (
      b[0] >= left - h &&
      b[2] <= right + h &&
      b[1] >= top - h &&
      b[3] <= bottom + h &&
      b[1] < bottom &&
      b[3] > top
    )
  })
  if (
    replaced.length < 3 ||
    tables.some(
      (t) =>
        !replaced.includes(t) &&
        t.cropRect[0] < right &&
        t.cropRect[2] > left &&
        t.cropRect[1] < bottom &&
        t.cropRect[3] > top
    )
  )
    return
  const id = `page-${pageNumber}-native-statistical-sections`
  return {
    caption,
    replaced,
    tables: [
      { ...first, id: id + '-section-1' },
      { ...second, id: id + '-section-2' }
    ]
  }
}

export function groupNativeStatisticalSections(tables) {
  const result = [],
    consumed = new Set()
  for (const first of tables) {
    if (consumed.has(first)) continue
    const id = /^(page-\d+-native-statistical-sections)-section-1$/.exec(first.id)
    const next = id && tables.find((t) => t.id === id[1] + '-section-2' && t.page === first.page)
    if (
      !next ||
      !first.caption ||
      next.caption ||
      first.parts ||
      next.parts ||
      first.grid?.[0]?.length !== 4 ||
      next.grid?.[0]?.length !== 5 ||
      Math.abs(first.cropRect[3] - next.cropRect[1]) > 1 ||
      Math.abs(first.cropRect[0] - next.cropRect[0]) > 1 ||
      Math.abs(first.cropRect[2] - next.cropRect[2]) > 1
    ) {
      result.push(first)
      continue
    }
    consumed.add(next)
    result.push({
      id: id[1],
      page: first.page,
      caption: first.caption,
      cropRect: [first.cropRect[0], first.cropRect[1], first.cropRect[2], next.cropRect[3]],
      notes: next.notes ?? [],
      parts: [first, next].map((part) => ({
        title: part.grid[0][0],
        sourceViewport: part.sourceViewport,
        grid: part.grid,
        cells: part.cells,
        unassigned: part.unassigned,
        issues: part.issues,
        notes: []
      }))
    })
  }
  return result
}
