/* eslint-disable @typescript-eslint/explicit-function-return-type */
import {
  nativeWholeOwnerRepairPacket,
  nativeCompleteRuledRecordPaintCrop
} from './literature-pdf-native-leaf-record-repair.mjs'
import { proveNativeUniqueWholeFonts } from './literature-pdf-table-evidence.mjs'
import { nativeClosedProgramInkPacket } from './literature-pdf-figure-native-plot-labels.mjs'
import { MAX_EDGE, MAX_SCALE, matchesInitialPdfCropPng } from './literature-pdf-crop.mjs'

// This independent final-grid path does not relax the wider closed-face proof.
function narrowNativeCountTable(table, tokens, rules, page, captions, context) {
  const native = context?.nativeContext,
    v = native?.viewport
  if (
    !v ||
    !Array.isArray(context?.tables) ||
    context.tables.length !== 1 ||
    context.tables[0] !== table ||
    !Array.isArray(table.grid) ||
    table.grid.length < 4 ||
    table.grid.some(
      (r) =>
        !Array.isArray(r) || r.length !== 2 || r.some((t) => typeof t !== 'string' || !t.trim())
    ) ||
    !Array.isArray(table.cells) ||
    table.cells.length !== table.grid.length * 2 ||
    table.cells.some((c) => !c || typeof c !== 'object' || c.rowSpan !== 1 || c.colSpan !== 1) ||
    table.parts ||
    table.cropRects ||
    table.issues?.length ||
    table.clipped?.length ||
    table.unassigned?.length ||
    ![v.width, v.height, v.scale].every((n) => Number.isFinite(n) && n > 0) ||
    table.cropRect[1] > v.height * 0.15 ||
    !Number.isInteger(page.pageNumber) ||
    page.pageNumber < 1 ||
    page.rotation !== 0 ||
    page.renderRotation !== 0 ||
    v.rotation !== 0 ||
    page.width * v.scale !== v.width ||
    page.height * v.scale !== v.height ||
    (table.page !== undefined && table.page !== page.pageNumber) ||
    (table.sourceViewport !== undefined &&
      ['width', 'height', 'scale'].some((k) => table.sourceViewport[k] !== v[k]))
  )
    return false
  const proof = nativeWholeOwnerRepairPacket(
    {
      ...table,
      page: page.pageNumber,
      sourceViewport: { width: v.width, height: v.height, scale: v.scale }
    },
    tokens,
    rules,
    native
  )
  if (
    !proof ||
    proof.columns !== 2 ||
    proof.groups.length !== table.grid.length ||
    !proveNativeUniqueWholeFonts(proof.fonts, tokens)
  )
    return false
  const clean = (text) => text.replace(/\s/gu, '')
  const lanes = [[], []],
    rows = []
  for (let row = 0; row < table.grid.length; row++) {
    const pair = table.cells.filter((c) => c.row === row).sort((a, b) => a.column - b.column)
    if (pair.length !== 2 || pair[0].column !== 0 || pair[1].column !== 1) return false
    const fonts = pair.map((c) => proof.owners.get(c))
    if (fonts.some((f) => !f?.length)) return false
    const band = fonts.flat(),
      baseline = band[0].baseline
    if (
      band.some((f) => f.baseline !== baseline || f.height !== band[0].height) ||
      band.length !== proof.groups[row].length ||
      band.some((f) => !proof.groups[row].includes(f))
    )
      return false
    for (let col = 0; col < 2; col++) {
      const ordered = [...fonts[col]].sort((a, b) => a.rect[0] - b.rect[0])
      if (clean(ordered.map((f) => f.text).join('')) !== clean(pair[col].text)) return false
      lanes[col].push(...ordered)
    }
    if (
      row === 0
        ? pair.some((c) => !/\p{L}/u.test(c.text))
        : !/^[+−-]?\d+(?:[.,]\d+)?$/u.test(pair[1].text.trim())
    )
      return false
    rows.push(band)
  }
  if (Math.max(...lanes[0].map((f) => f.rect[2])) >= Math.min(...lanes[1].map((f) => f.rect[0])))
    return false
  const crop = table.cropRect
  const edges = rules
    .filter(
      (r) =>
        Math.max(r[0], r[2]) >= crop[0] &&
        Math.min(r[0], r[2]) <= crop[2] &&
        Math.max(r[1], r[3]) >= crop[1] &&
        Math.min(r[1], r[3]) <= crop[3]
    )
    .sort((a, b) => a[1] - b[1])
  if (
    edges.length !== 3 ||
    edges.some((r) => r[1] !== r[3] || r[0] !== edges[0][0] || r[2] !== edges[0][2]) ||
    !(edges[0][1] < edges[1][1] && edges[1][1] < edges[2][1])
  )
    return false
  if (
    tokens.some((f) => f.text?.trim() && f.rect[1] < edges[0][1]) ||
    page.lines.some((l) => l.text.trim() && l.y * v.scale < edges[0][1])
  )
    return false
  const paint = edges.map((r) => native.rulePaintBounds?.get(r.join(',')))
  if (paint.some((r) => !Array.isArray(r) || r.length !== 4 || !r.every(Number.isFinite)))
    return false
  if (
    rows[0].some(
      (f) =>
        f.rect[1] <= paint[0][3] ||
        f.rect[3] >= paint[1][1] ||
        f.rect[0] < edges[0][0] ||
        f.rect[2] > edges[0][2]
    ) ||
    rows
      .slice(1)
      .flat()
      .some((f) => f.rect[1] <= paint[1][3] || f.rect[3] >= paint[2][1]) ||
    captions.some((c) => c.page === page.pageNumber && c.rect[1] * v.scale <= edges[2][1])
  )
    return false
  const closed = nativeCompleteRuledRecordPaintCrop(crop, edges, rules, native, proof.fonts)
  return !!closed && closed.every((n, i) => n === crop[i])
}

const union = (rects) => [
  Math.min(...rects.map((r) => r[0])),
  Math.min(...rects.map((r) => r[1])),
  Math.max(...rects.map((r) => r[2])),
  Math.max(...rects.map((r) => r[3]))
]
const bounds = (table) => {
  const rows = union(table.rows.map((row) => row.rect))
  return [table.cropRect[0], rows[1], table.cropRect[2], rows[3]].map((v) => v / 1.5)
}
const lineRect = (line) => [line.x, line.y, line.x + line.width, line.y + line.height]

// A page-end title can introduce a closed native table at the next page's
// opening. Prove the header faces independently of detector/caption proximity;
// a second page-end title remains reserved for the subsequent native table.
export function recoverPriorPageTableCaption(
  table,
  tokens,
  rules,
  pageGeometry,
  pages,
  captions,
  currentCaption,
  context
) {
  const previous = pages.find((p) => p.pageNumber === pageGeometry.pageNumber - 1)
  if (!previous || !table.cropRect) return
  const prior = captions.filter(
    (c) =>
      c.page === previous.pageNumber && /^Table\s+(?:[AS]?\d+|[A-Z]\.\d+)[.:]/i.test(c.lines[0])
  )
  if (prior.length !== 1) return
  const caption = prior[0]
  const isTerminal = (c, page) =>
    c.rect[1] > page.height * 0.75 &&
    page.lines.every(
      (l) =>
        l.y + l.height <= c.rect[3] + 0.5 ||
        l.y > page.height * 0.93 ||
        c.lines.includes(l.text) ||
        (l.text.trim() === String(page.pageNumber) &&
          l.y > page.height * 0.85 &&
          Math.abs(l.x + l.width / 2 - page.width / 2) < l.fontSize * 2)
    )
  if (!isTerminal(caption, previous)) return
  if (
    currentCaption &&
    (currentCaption.page !== pageGeometry.pageNumber || !isTerminal(currentCaption, pageGeometry))
  )
    return
  if (
    !currentCaption &&
    narrowNativeCountTable(table, tokens, rules, pageGeometry, captions, context)
  )
    return caption
  if (!table.structure?.objects) return
  const columns = table.structure.objects.filter((o) => o.label === 'table column').length
  if (columns < 2 || columns > 8 || table.cropRect[1] > pageGeometry.height * 1.5 * 0.15) return
  const horizontal = []
  for (const r of rules
    .filter((r) => Math.abs(r[1] - r[3]) < 0.01)
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])) {
    const prior = horizontal.at(-1)
    if (prior && Math.abs(prior[1] - r[1]) < 0.75 && r[0] <= prior[2] + 0.75)
      prior[2] = Math.max(prior[2], r[2])
    else horizontal.push([...r])
  }
  const em = tokens
    .filter((i) => i.horizontal && i.height > 0)
    .map((i) => i.height)
    .sort((a, b) => a - b)
  const height = em[em.length >> 1]
  if (!(height > 0)) return
  const openings = horizontal.filter(
    (r) =>
      r[2] - r[0] > pageGeometry.width * 1.5 * 0.5 &&
      Math.abs(r[0] - table.cropRect[0]) < height &&
      Math.abs(r[1] - table.cropRect[1]) < height * 1.5
  )
  const proofs = []
  for (const opening of openings) {
    if (
      captions.some(
        (c) =>
          c.page === pageGeometry.pageNumber &&
          c.rect[3] * 1.5 <= opening[1] &&
          opening[1] - c.rect[3] * 1.5 < height * 4
      )
    )
      continue
    const closings = horizontal.filter(
      (r) =>
        r[1] > opening[1] + height &&
        r[1] - opening[1] < height * 5 &&
        Math.abs(r[0] - opening[0]) < 0.75 &&
        Math.abs(r[2] - opening[2]) < 0.75
    )
    for (const closing of closings) {
      const cuts = [
        ...new Set(
          rules
            .filter(
              (r) =>
                Math.abs(r[0] - r[2]) < 0.01 &&
                r[1] <= opening[1] + 0.75 &&
                r[3] >= closing[1] - 0.75 &&
                r[0] >= opening[0] - 0.75 &&
                r[0] <= opening[2] + 0.75
            )
            .map((r) => Math.round(r[0] * 10) / 10)
        )
      ].sort((a, b) => a - b)
      if (cuts.length !== columns + 1) continue
      const source = tokens.filter(
        (i) =>
          i.horizontal &&
          i.rect[1] >= opening[1] - height * 0.1 &&
          i.rect[3] > opening[1] &&
          i.rect[3] <= closing[1] + 0.1 &&
          i.rect[0] >= opening[0] - 0.1 &&
          i.rect[2] <= opening[2] + 0.1
      )
      if (
        source.length < columns ||
        source.some(
          (i) =>
            !cuts
              .slice(0, -1)
              .some((x, n) => i.rect[0] >= x - 0.75 && i.rect[2] <= cuts[n + 1] + 0.75)
        )
      )
        continue
      if (
        cuts
          .slice(0, -1)
          .some(
            (x, n) =>
              !source.some(
                (i) =>
                  /\p{L}/u.test(i.text) && i.rect[0] >= x - 0.75 && i.rect[2] <= cuts[n + 1] + 0.75
              )
          )
      )
        continue
      if (currentCaption && currentCaption.rect[1] * 1.5 <= closing[1]) continue
      proofs.push({ opening, closing })
    }
  }
  if (proofs.length !== 1) return
  return caption
}

// Group only explicit, consecutive A/B/... sections on one page with a shared
// table caption. Column counts may differ: each part retains its own grid.
// Complete note records, rather than their baseline-ended line boxes, own the
// added ink. A competing mark in the added raster strip prevents grouping.
function groupedNoteCrop(rect, notes, page, tokens, context) {
  if (!notes.length) return rect
  const inside = (a, b) => b.every((n, i) => (i < 2 ? n >= a[i] - 1e-8 : n <= a[i] + 1e-8))
  const hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
  const literal = (s) => s.replace(/\s/gu, '')
  if (page.rotation !== 0 || page.invalidGraphicsBounds !== 0 || !Array.isArray(tokens)) return
  const selected = []
  for (const note of notes) {
    const own = tokens
      .filter((t) => t.horizontal && inside(note.rect, t.rect))
      .sort((a, b) => (a.sourceItem?.index ?? -1) - (b.sourceItem?.index ?? -1))
    if (!own.length || literal(own.map((t) => t.text).join('')) !== literal(note.text)) return
    selected.push(...own)
  }
  const indices = new Set(selected.map((t) => t.sourceItem?.index))
  if (indices.size !== selected.length) return
  const packet = nativeClosedProgramInkPacket(
    page,
    tokens,
    context,
    selected.map((t) => t.sourceItem)
  )
  if (!packet) return
  const records = packet.records.filter((r) => indices.has(r.index))
  if (
    records.length !== selected.length ||
    records.some((r) => !r.advanceComplete || !packet.valid(r.ink))
  )
    return
  const owners = new Set(),
    owned = new Set(records.flatMap((r) => r.part.map((z) => z.g)))
  for (const record of packet.records) {
    for (const glyph of new Set(record.part.map((z) => z.g))) {
      if (owners.has(glyph)) return
      owners.add(glyph)
    }
  }
  const ink = union(records.map((r) => r.ink))
  if (ink[0] < rect[0] || ink[2] > rect[2] || ink[1] < rect[1]) return
  if (ink[3] <= rect[3]) return rect
  // One antialiasing pixel at renderPdfCrop's actual initial scale; account
  // for the resulting height before computing its ceil-sized raster strip.
  const scale = Math.min(
    MAX_SCALE,
    MAX_EDGE / (rect[2] - rect[0]),
    (MAX_EDGE - 1) / (ink[3] - rect[1])
  )
  const next = [...rect.slice(0, 3), ink[3] + 1 / scale]
  const actualScale = Math.min(MAX_SCALE, MAX_EDGE / Math.max(next[2] - next[0], next[3] - next[1]))
  const strip = [
    rect[0],
    rect[3],
    rect[2],
    rect[1] + (Math.ceil((next[3] - rect[1]) * actualScale) + 1) / actualScale
  ]
  if (
    strip[3] > page.height ||
    packet.glyphs.some((g) => !owned.has(g) && !g.rendererSkipped && hit(strip, g.ink))
  )
    return
  if (tokens.some((t) => !indices.has(t.sourceItem?.index) && hit(strip, t.rect))) return
  if (
    page.graphicsBounds.some((g) =>
      hit(
        strip,
        (g.paintedNormalizedRect ?? g.normalizedRect).map(
          (n, i) => n * (i % 2 ? page.height : page.width)
        )
      )
    )
  )
    return
  return next
}

// The note extension proves the initial ceil-sized raster strip. A byte-budget
// resize changes that strip and cannot publish a grouped note preview.
export function matchesGroupedTableCropPng(table, png) {
  if (
    !table.parts?.length ||
    !table.notes?.length ||
    !table.parts.every((p) => p.cropRects?.length)
  )
    return true
  const rect = table.cropRect.map((n) => n / 1.5),
    width = rect[2] - rect[0],
    height = rect[3] - rect[1],
    scale = Math.min(MAX_SCALE, MAX_EDGE / Math.max(width, height))
  return matchesInitialPdfCropPng(png, {
    pixelWidth: Math.min(MAX_EDGE, Math.max(1, Math.ceil(width * scale))),
    pixelHeight: Math.min(MAX_EDGE, Math.max(1, Math.ceil(height * scale)))
  })
}

export function groupTableParts(tables, page, tokens, context) {
  const continued = [...tables]
  for (const first of [...continued]) {
    if (first.caption || !first.grid?.length) continue
    const rect = first.cropRect.map((v) => v / 1.5)
    const footer = page.lines.find(
      (line) =>
        /^\(Table\s+\d+\s+continued on next column\)$/i.test(line.text) &&
        line.x >= rect[0] &&
        line.x + line.width <= rect[2] &&
        Math.abs(line.y + line.height - rect[3]) <= line.height * 3
    )
    if (!footer) continue
    const number = footer.text.match(/Table\s+(\d+)/i)[1]
    const next = continued.find(
      (table) =>
        table !== first &&
        table.page === first.page &&
        table.caption?.text.match(/^Table\s+(\d+)\b/i)?.[1] === number &&
        table.grid?.[1]?.[0]?.trim() === '(Continued from previous column)' &&
        table.grid[1].slice(1).every((text) => !text) &&
        JSON.stringify(table.grid[0]) === JSON.stringify(first.grid[0]) &&
        table.cropRect[0] >= first.cropRect[2] &&
        table.cropRect[0] - first.cropRect[2] <= (first.cropRect[2] - first.cropRect[0]) * 0.25 &&
        Math.abs(table.cropRect[1] - first.cropRect[1]) <= 18
    )
    if (!next) continue
    const offset = first.grid.length - 2
    continued.splice(continued.indexOf(first), 1, {
      ...first,
      caption: next.caption,
      captionIssue: next.captionIssue,
      cropRect: union([first.cropRect, next.cropRect]),
      cropRects: [...(first.cropRects ?? [first.cropRect]), ...(next.cropRects ?? [next.cropRect])],
      grid: [...first.grid, ...next.grid.slice(2)],
      cells: [
        ...first.cells,
        ...next.cells
          .filter((cell) => cell.row >= 2)
          .map((cell) => ({ ...cell, row: cell.row + offset }))
      ],
      rows: [...first.rows, ...next.rows.slice(2)],
      notes: [...(first.notes ?? []), ...(next.notes ?? [])],
      unassigned: [...first.unassigned, ...next.unassigned],
      clipped: [...(first.clipped ?? []), ...(next.clipped ?? [])],
      issues: [...new Set([...first.issues, ...next.issues])]
    })
    continued.splice(continued.indexOf(next), 1)
  }
  // Side-by-side continuations repeat the header and explicitly identify the
  // same table. Source column order takes precedence over a slightly higher
  // top edge on the continuation column.
  for (const next of [...continued]) {
    const number = /^Table\s+(\d+)[.]?\s*\(?continued\)?[.]?$/i.exec(next.caption?.text ?? '')?.[1]
    if (!number || !next.grid?.length || next.parts) continue
    const candidates = continued.filter(
      (first) =>
        first !== next &&
        !first.parts &&
        first.page === next.page &&
        first.caption?.text.match(/^Table\s+(\d+)\b/i)?.[1] === number &&
        !/\bcontinued\b/i.test(first.caption.text) &&
        JSON.stringify(first.grid?.[0]) === JSON.stringify(next.grid[0]) &&
        first.cropRect[2] <= next.cropRect[0] &&
        next.cropRect[0] - first.cropRect[2] <= (first.cropRect[2] - first.cropRect[0]) * 0.3 &&
        Math.abs(first.cropRect[1] - next.cropRect[1]) <= 30 &&
        Math.min(first.cropRect[3], next.cropRect[3]) -
          Math.max(first.cropRect[1], next.cropRect[1]) >
          Math.min(first.cropRect[3] - first.cropRect[1], next.cropRect[3] - next.cropRect[1]) * 0.5
    )
    if (candidates.length !== 1) continue
    const first = candidates[0],
      offset = first.grid.length - 1
    // Once both columns establish the continuation, a matching footer below
    // the last source row is navigation text, even if PDF tokens split it.
    const footer =
      first.unassigned.join('').replace(/\s/g, '') === '(Continued)' &&
      page.lines.find(
        (line) =>
          /^\(Continued\s*\)$/i.test(line.text) &&
          line.y * 1.5 >= Math.max(...first.rows.map((row) => row.rect[3])) &&
          line.y * 1.5 - Math.max(...first.rows.map((row) => row.rect[3])) <= line.height * 3 &&
          line.x * 1.5 >= first.cropRect[0] &&
          (line.x + line.width) * 1.5 <= first.cropRect[2] + line.height &&
          Math.abs((line.y + line.height) * 1.5 - first.cropRect[3]) <= line.height * 3
      )
    const clipped = footer
      ? (first.clipped ?? []).filter((item) => {
          const rect = lineRect(footer).map((v) => v * 1.5)
          return (
            item.rect[0] < rect[0] - 1 ||
            item.rect[1] < rect[1] - 1 ||
            item.rect[2] > rect[2] + 1 ||
            item.rect[3] > rect[3] + 1
          )
        })
      : (first.clipped ?? [])
    continued.splice(continued.indexOf(first), 1, {
      ...first,
      cropRects: [
        ...(first.cropRects ?? [first.cropRect]).map((r) =>
          footer ? [r[0], r[1], r[2], Math.min(r[3], footer.y * 1.5 - 1)] : r
        ),
        ...(next.cropRects ?? [next.cropRect])
      ],
      cropRect: union([
        footer
          ? [
              first.cropRect[0],
              first.cropRect[1],
              first.cropRect[2],
              Math.min(first.cropRect[3], footer.y * 1.5 - 1)
            ]
          : first.cropRect,
        next.cropRect
      ]),
      grid: [...first.grid, ...next.grid.slice(1)],
      cells: [
        ...first.cells,
        ...next.cells.filter((c) => c.row >= 1).map((c) => ({ ...c, row: c.row + offset }))
      ],
      rows: [...first.rows, ...next.rows.slice(1)],
      notes: [...(first.notes ?? []), ...(next.notes ?? [])],
      unassigned: [...(footer ? [] : first.unassigned), ...next.unassigned],
      clipped: [...clipped, ...(next.clipped ?? [])],
      issues: [
        ...new Set([
          ...first.issues.filter(
            (issue) =>
              !footer ||
              (issue !== 'unassigned-source-text' &&
                (issue !== 'text-crosses-crop-boundary' || clipped.length))
          ),
          ...next.issues
        ])
      ]
    })
    continued.splice(continued.indexOf(next), 1)
  }
  const ordered = continued.sort((a, b) => a.cropRect[1] - b.cropRect[1])
  const partLabel = /^(?:([A-Z])[.)]|\(([a-z])\))\s+\p{L}/u
  const partOrdinal = (line) => {
    const [, letter, parenthesized] = partLabel.exec(line.text)
    return (letter ?? parenthesized.toUpperCase()).charCodeAt(0)
  }
  const heading = (table) => {
    const rect = bounds(table)
    return page.lines
      .filter(
        (line) =>
          partLabel.test(line.text) &&
          line.y + line.height <= rect[1] &&
          rect[1] - line.y <= line.height * 4 &&
          line.x >= rect[0] - 2 &&
          line.x + line.width <= rect[2] + 2
      )
      .sort((a, b) => b.y - a.y)[0]
  }
  const result = []
  for (let i = 0; i < ordered.length; i++) {
    const first = ordered[i]
    const firstHeading = first.rows.length && heading(first)
    if (
      !first.caption ||
      !firstHeading ||
      partOrdinal(firstHeading) !== 65 ||
      first.caption.rect[3] > firstHeading.y ||
      firstHeading.y - first.caption.rect[3] > 60
    ) {
      result.push(first)
      continue
    }
    const members = [first],
      headings = [firstHeading]
    while (i + members.length < ordered.length && members.length < 8) {
      const previous = members.at(-1),
        next = ordered[i + members.length]
      const label = next.rows.length && heading(next)
      const prior = bounds(previous),
        rect = bounds(next)
      if (
        previous.notes?.length ||
        next.page !== first.page ||
        next.caption ||
        !label ||
        partOrdinal(label) !== 65 + members.length ||
        label.text.startsWith('(') !== firstHeading.text.startsWith('(') ||
        label.y < prior[3] ||
        label.y - prior[3] > label.height * 4 ||
        Math.abs(rect[0] - prior[0]) > 12 ||
        (Math.min(rect[2], prior[2]) - Math.max(rect[0], prior[0])) /
          Math.max(rect[2] - rect[0], prior[2] - prior[0]) <
          0.85 ||
        page.lines.some(
          (line) =>
            line !== label &&
            line.y >= prior[3] &&
            line.y + line.height <= rect[1] &&
            line.x < rect[2] &&
            line.x + line.width > rect[0]
        )
      )
        break
      members.push(next)
      headings.push(label)
    }
    if (members.length === 1) {
      result.push(first)
      continue
    }
    const notes = members.at(-1).notes ?? []
    let rect = union([
      ...members.map((member) => member.cropRect.map((v) => v / 1.5)),
      first.caption.rect,
      ...headings.map(lineRect),
      ...notes.map((note) => note.rect)
    ])
    if (tokens !== undefined || context !== undefined) {
      rect = groupedNoteCrop(rect, notes, page, tokens, context)
      if (!rect) {
        result.push(first)
        continue
      }
    }
    result.push({
      id: first.id,
      page: first.page,
      caption: first.caption,
      notes,
      cropRect: rect.map((v) => v * 1.5),
      parts: members.map((member, index) => ({
        title: headings[index].text,
        // Preserve each independently extracted crop. Cell glyph boxes cannot
        // establish a part boundary or reconstruct the space between parts.
        cropRects: (member.cropRects ?? [member.cropRect]).map((rect) => [...rect]),
        sourceViewport: member.sourceViewport,
        grid: member.grid,
        cells: member.cells,
        ...(member.unreliableMathSourceItems
          ? { unreliableMathSourceItems: member.unreliableMathSourceItems }
          : {}),
        unassigned: member.unassigned,
        issues: member.issues,
        notes: []
      }))
    })
    i += members.length - 1
  }
  return result
}
