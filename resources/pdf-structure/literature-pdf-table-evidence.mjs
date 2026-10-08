/* eslint-disable @typescript-eslint/explicit-function-return-type, no-control-regex, no-useless-escape */
import { inside } from './literature-pdf-table-geometry.mjs'
import { area, intersection } from './literature-pdf-page-geometry.mjs'
import { hasNativeNonTableLayout } from './literature-pdf-native-non-table-layout.mjs'
import { joinHorizontalTableRules, classifyTableRuleEdge } from './literature-pdf-table-rules.mjs'
import { groupSourceRowsWithScripts } from './literature-pdf-source-records.mjs'
import { proveNativeClosedLeafHeader } from './literature-pdf-native-header-grid.mjs'

// A native image fallback adds nothing when a source-backed grid already owns
// exactly the same glyphs and its thumbnail contains every one. Printed caption
// numbers and detector fence margins do not establish a different physical table.
export function isNativeClosedFrameOwnedByTable(table, frame) {
  const valid = (rect) =>
    Array.isArray(rect) &&
    rect.length === 4 &&
    rect.every(Number.isFinite) &&
    rect[2] > rect[0] &&
    rect[3] > rect[1]
  const crop = table?.cropRect
  if (
    !valid(crop) ||
    !Array.isArray(table.grid) ||
    table.grid.length < 2 ||
    (table.grid[0]?.length ?? 0) < 2 ||
    !Array.isArray(frame?.sourceTokens) ||
    frame.sourceTokens.length < 4
  )
    return false
  const assigned = (table.cells ?? []).flatMap((cell) => cell.sourceRects ?? [])
  if (assigned.length !== frame.sourceTokens.length || assigned.some((rect) => !valid(rect)))
    return false
  const owned = new Set()
  for (const token of frame.sourceTokens) {
    const rect = token.rect
    if (
      !valid(rect) ||
      !token.text?.trim() ||
      rect[0] < crop[0] - 0.02 ||
      rect[1] < crop[1] - 0.02 ||
      rect[2] > crop[2] + 0.02 ||
      rect[3] > crop[3] + 0.02
    )
      return false
    const matches = assigned.flatMap((source, index) =>
      source.every((value, axis) => Math.abs(value - rect[axis]) <= 0.02) ? [index] : []
    )
    if (matches.length !== 1 || owned.has(matches[0])) return false
    owned.add(matches[0])
  }
  return owned.size === assigned.length
}

// Tighten a detector crop only when an independently closed native frame owns
// every assigned glyph and every native glyph within it. Neighboring panel
// ink cannot lend a wider boundary to this complete source grid.
export function proveNativeAssignedClosedTableFrame(table, items, rules) {
  const valid = (r) => r?.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1]
  const crop = table.cropRect
  if (
    !valid(crop) ||
    !Array.isArray(table.grid) ||
    table.grid.length < 3 ||
    table.grid[0]?.length < 2
  )
    return
  const cells = (table.cells ?? []).filter((c) => c.sourceRects?.length)
  if (
    new Set(cells.map((c) => c.row)).size !== table.grid.length ||
    cells.some((c) => !Number.isInteger(c.row) || c.row < 0 || c.row >= table.grid.length)
  )
    return
  const source = cells.flatMap((c) => c.sourceRects)
  if (!source.length || source.some((r) => !valid(r))) return
  const same = (a, b) => a.every((v, n) => Math.abs(v - b[n]) <= 0.02)
  const tokens = source.map((r) => items.filter((i) => i.text?.trim() && same(r, i.rect)))
  if (tokens.some((matches) => matches.length !== 1)) return
  const owned = tokens.map((matches) => matches[0])
  if (
    new Set(owned).size !== owned.length ||
    owned.some((i) => !i.horizontal || !Number.isFinite(i.height) || !(i.height > 0))
  )
    return
  const headers = cells.filter((c) => c.row === 0).flatMap((c) => c.sourceRects)
  const body = cells.filter((c) => c.row > 0).flatMap((c) => c.sourceRects)
  if (!headers.length || !body.length) return
  const height = Math.max(...owned.map((i) => i.height))
  const x0 = Math.min(...source.map((r) => r[0])),
    x1 = Math.max(...source.map((r) => r[2])),
    y0 = Math.min(...source.map((r) => r[1])),
    y1 = Math.max(...source.map((r) => r[3]))
  const horizontal = joinHorizontalTableRules(rules).filter(
    (r) =>
      r.every(Number.isFinite) &&
      r[1] === r[3] &&
      r[0] >= crop[0] - 0.02 &&
      r[2] <= crop[2] + 0.02 &&
      r[1] >= crop[1] - 0.02 &&
      r[1] <= crop[3] + 0.02 &&
      r[0] <= x0 + 0.02 &&
      r[2] >= x1 - 0.02 &&
      x0 - r[0] <= height * 2 &&
      r[2] - x1 <= height * 2
  )
  const proofs = []
  for (const opening of horizontal.filter((r) => r[1] < y0 && y0 - r[1] <= height)) {
    for (const closing of horizontal.filter((r) => r[1] > y1 && r[1] - y1 <= height)) {
      if (Math.abs(opening[0] - closing[0]) > 0.02 || Math.abs(opening[2] - closing[2]) > 0.02)
        continue
      const dividers = horizontal.filter(
        (r) =>
          Math.abs(r[0] - opening[0]) <= 0.02 &&
          Math.abs(r[2] - opening[2]) <= 0.02 &&
          r[1] > Math.max(...headers.map((s) => s[3])) &&
          r[1] < Math.min(...body.map((s) => s[1]))
      )
      if (dividers.length !== 1) continue
      const rect = [opening[0], opening[1], opening[2], closing[1]]
      const native = items.filter((i) => i.text?.trim() && intersection(i.rect, rect) > 0.02)
      if (
        native.length !== owned.length ||
        native.some(
          (i) =>
            !owned.includes(i) ||
            i.rect[0] < rect[0] - 0.02 ||
            i.rect[1] < rect[1] - 0.02 ||
            i.rect[2] > rect[2] + 0.02 ||
            i.rect[3] > rect[3] + 0.02
        )
      )
        continue
      proofs.push({ cropRect: rect, sourceTokens: native })
    }
  }
  return proofs.length === 1 ? proofs[0] : undefined
}

export function isRecognizedAlgorithmOwnedTable(table, caption, algorithms, scale = 1.5) {
  if (
    caption ||
    !Number.isFinite(scale) ||
    !(scale > 0) ||
    (table.rows?.length ?? table.grid?.length ?? 0) < 2
  )
    return false
  const source = (table.cells ?? []).flatMap((c) => c.sourceRects ?? [])
  if (
    !source.length ||
    source.some((r) => r.length !== 4 || !r.every(Number.isFinite) || r[2] <= r[0] || r[3] <= r[1])
  )
    return false
  return algorithms.some((algorithm) => {
    if (
      algorithm.rect?.length !== 4 ||
      !algorithm.rect.every(Number.isFinite) ||
      algorithm.rect[2] <= algorithm.rect[0] ||
      algorithm.rect[3] <= algorithm.rect[1]
    )
      return false
    const owned = source.filter(
      (r) =>
        r[0] / scale >= algorithm.rect[0] - 0.5 &&
        r[1] / scale >= algorithm.rect[1] - 0.5 &&
        r[2] / scale <= algorithm.rect[2] + 0.5 &&
        r[3] / scale <= algorithm.rect[3] + 0.5
    )
    return (
      owned.length >= 2 &&
      owned.reduce((sum, r) => sum + area(r), 0) >=
        source.reduce((sum, r) => sum + area(r), 0) * 0.99
    )
  })
}

function isNativeProseFootnoteOverlap(table, caption, items, rules) {
  if (
    caption ||
    !table.cropRect ||
    !table.cells?.length ||
    table.grid.length > 4 ||
    table.grid[0]?.length > 3
  )
    return false
  const numbers = table.cells.filter((c) => /^\d{1,3}$/u.test(c.text?.trim() ?? ''))
  if (!numbers.length || numbers.length > 2) return false
  const source = table.cells.flatMap((c) => c.sourceRects ?? [])
  const assigned = items.filter((i) =>
    source.some((r) => r.every((v, n) => Math.abs(v - i.rect[n]) < 0.02))
  )
  const prose = assigned.filter(
    (i) =>
      i.horizontal &&
      (i.text.match(/\p{L}{2,}/gu) ?? []).length >= 5 &&
      i.rect[0] < table.cropRect[0] - i.height &&
      i.rect[2] < table.cropRect[2] - i.height
  )
  if (prose.length < 2) return false
  const h = Math.max(...prose.map((i) => i.height))
  if (
    Math.max(...prose.map((i) => i.rect[0])) - Math.min(...prose.map((i) => i.rect[0])) >
    h * 0.08
  )
    return false
  return numbers.every((c) => {
    const markers = items.filter(
      (i) =>
        i.horizontal &&
        i.text.trim() === c.text.trim() &&
        i.height < h * 0.65 &&
        (c.sourceRects ?? []).some((r) => r.every((v, n) => Math.abs(v - i.rect[n]) < 0.02))
    )
    if (markers.length !== 1) return false
    const marker = markers[0]
    return (
      rules.some(
        (r) =>
          r[1] === r[3] &&
          r[0] <= marker.rect[0] &&
          r[2] > marker.rect[2] &&
          r[2] - r[0] < h * 9 &&
          marker.rect[1] - r[1] >= 0 &&
          marker.rect[1] - r[1] < h * 0.3
      ) &&
      items.some(
        (i) =>
          i !== marker &&
          i.horizontal &&
          /\p{L}/u.test(i.text) &&
          (i.height > marker.height * 1.3 ||
            (i.height > marker.height * 1.15 && i.height < h * 0.8)) &&
          i.rect[0] >= marker.rect[2] &&
          i.rect[0] - marker.rect[2] < marker.height &&
          Math.abs(i.baseline - marker.baseline) < marker.height
      )
    )
  })
}

// A literal caption and a closed native frame preserve the visual table when
// its detector grid cannot prove cell semantics. This does not create cells or
// propagate a grouped stub through quoted or mathematical records.
export function proveCaptionedNativeClosedTableFrame(table, caption, items, rules) {
  if (
    !table.cropRect ||
    !caption?.rect ||
    !/^Table\s+[\dIVXLC]+\s*[:.]/iu.test(caption.lines?.[0] ?? '')
  )
    return
  const [left, top, right, bottom] = table.cropRect
  const near = items.filter(
    (i) =>
      i.horizontal &&
      i.height > 0 &&
      i.rect[0] >= left - 2 &&
      i.rect[2] <= right + 2 &&
      i.rect[1] >= top - 20 &&
      i.rect[3] <= bottom + 20
  )
  const heights = near.map((i) => i.height).sort((a, b) => a - b),
    h = heights[heights.length >> 1]
  if (!(h > 0)) return
  let horizontal = joinHorizontalTableRules(rules)
    .filter(
      (r) =>
        r[1] >= top - h * 1.5 &&
        r[1] <= bottom + h * 1.5 &&
        Math.abs(r[0] - left) < h * 1.5 &&
        r[2] >= right - h * 1.5 &&
        r[2] - right < (right - left) * 0.4
    )
    .sort((a, b) => a[1] - b[1])
  if (horizontal.length < 2) return
  const opening = horizontal.toSorted((a, b) => Math.abs(a[1] - top) - Math.abs(b[1] - top))[0]
  horizontal = horizontal.filter(
    (r) =>
      r[1] >= opening[1] && Math.abs(r[0] - opening[0]) < 0.05 && Math.abs(r[2] - opening[2]) < 0.05
  )
  const closing = horizontal.toSorted(
    (a, b) => Math.abs(a[1] - bottom) - Math.abs(b[1] - bottom)
  )[0]
  horizontal = horizontal.filter((r) => r[1] <= closing[1])
  if (
    closing[1] - opening[1] < h * 3 ||
    Math.abs(opening[0] - closing[0]) > 0.05 ||
    Math.abs(opening[2] - closing[2]) > 0.05 ||
    caption.rect[0] >= opening[2] ||
    caption.rect[2] <= opening[0] ||
    !(
      (caption.rect[3] <= opening[1] && opening[1] - caption.rect[3] < h * 3) ||
      (caption.rect[1] >= closing[1] && caption.rect[1] - closing[1] < h * 4)
    )
  )
    return
  const source = items.filter(
    (i) =>
      i.horizontal &&
      i.text?.trim() &&
      i.rect[0] >= opening[0] - 0.05 &&
      i.rect[2] <= opening[2] + 0.05 &&
      i.rect[1] >= opening[1] - h * 0.2 &&
      i.rect[3] <= closing[1] + 0.05
  )
  if (source.length < 8 || source.some((i) => /^Algorithm\s+\d/iu.test(i.text))) return
  const vertical = rules.filter(
    (r) =>
      r[0] === r[2] &&
      r[0] >= opening[0] - 0.6 &&
      r[0] <= opening[2] + 0.6 &&
      classifyTableRuleEdge(rules, 0, r[0], opening[1], closing[1]) === 1
  )
  const cuts = [...new Set(vertical.map((r) => r[0]))].sort((a, b) => a - b)
  if (
    cuts.length >= 3 &&
    cuts.length <= 7 &&
    Math.abs(cuts[0] - opening[0]) < 0.6 &&
    Math.abs(cuts.at(-1) - opening[2]) < 0.6 &&
    cuts
      .slice(1)
      .filter((x, c) => source.some((i) => i.rect[0] >= cuts[c] - 0.05 && i.rect[2] <= x + 0.05))
      .length >= 2
  ) {
    return {
      kind: 'native-boxed-table-visual',
      cropRect: [opening[0], opening[1], opening[2], closing[1]],
      sourceTokens: source,
      columns: cuts.slice(1).map((x, c) => [cuts[c], opening[1], x, closing[1]])
    }
  }
  if (horizontal.length !== 3) return
  const divider = horizontal[1]
  if (
    Math.abs(divider[0] - opening[0]) > 0.05 ||
    Math.abs(divider[2] - opening[2]) > 0.05 ||
    divider[1] - opening[1] > h * 2.8
  )
    return
  const header = source.filter((i) => i.baseline > opening[1] && i.rect[3] < divider[1])
  if (
    header.length < 2 ||
    header.length > 20 ||
    header.some((i) => Math.abs(i.baseline - header[0].baseline) > h * 0.2)
  )
    return
  const ordered = header.toSorted((a, b) => a.rect[0] - b.rect[0])
  const fields = []
  for (const i of ordered) {
    const previous = fields.at(-1)
    if (previous && i.rect[0] - previous.at(-1).rect[2] < h * 0.4) previous.push(i)
    else fields.push([i])
  }
  if (
    fields.length < 2 ||
    fields.length > 6 ||
    fields.some((g) => !g.some((i) => /\p{L}/u.test(i.text)))
  )
    return
  const body = source.filter((i) => i.baseline > divider[1])
  // A visual-only fallback does not need to assign ambiguous scripts to a
  // body record. The complete native enclosure and explicit leaf header own
  // those glyphs; repeated ordinary baselines prove there is table content.
  const ordinaryBands = []
  for (const i of body
    .filter((i) => i.height >= h * 0.8)
    .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    const band = ordinaryBands.at(-1)
    if (band && Math.abs(i.baseline - band[0].baseline) < h * 0.2) band.push(i)
    else ordinaryBands.push([i])
  }
  const bands = groupSourceRowsWithScripts(body, h, 0.2) ?? ordinaryBands
  if (
    !bands ||
    bands.length < 4 ||
    body.filter((i) => /\p{L}/u.test(i.text)).length < Math.min(6, bands.length)
  )
    return
  return {
    kind: 'native-closed-table-visual',
    cropRect: [opening[0], opening[1], opening[2], closing[1]],
    sourceTokens: source,
    headerTokens: header
  }
}

// Seed only unique closed native tables next to the supplied literal caption.
// Further boxed parts must continue the same physical fence widths; they have
// no invented caption ownership and are returned as visual-only source parts.
export function findCaptionedNativeClosedTableFrames(caption, items, rules) {
  if (!caption?.rect || !/^Table\s+[\dIVXLC]+\s*[:.]/iu.test(caption.lines?.[0] ?? '')) return []
  const h = items
    .filter((i) => i.height > 0)
    .map((i) => i.height)
    .sort((a, b) => a - b)[items.filter((i) => i.height > 0).length >> 1]
  if (!(h > 0)) return []
  const horizontal = joinHorizontalTableRules(rules)
    .filter(
      (r) =>
        r[2] - r[0] > h * 8 &&
        r[1] > caption.rect[3] &&
        r[0] < caption.rect[2] &&
        r[2] > caption.rect[0]
    )
    .sort((a, b) => a[1] - b[1])
  const openings = horizontal.filter((r) => r[1] - caption.rect[3] < h * 3)
  const matches = []
  for (const opening of openings) {
    const closing = horizontal.filter(
      (r) =>
        r[1] > opening[1] + h * 3 &&
        Math.abs(r[0] - opening[0]) < 0.05 &&
        Math.abs(r[2] - opening[2]) < 0.05
    )
    const frames = closing
      .map((r) =>
        proveCaptionedNativeClosedTableFrame(
          { cropRect: [opening[0], opening[1], r[2], r[1]] },
          caption,
          items,
          rules
        )
      )
      .filter(Boolean)
    if (frames.length) matches.push(frames.at(-1))
  }
  if (matches.length !== 1) return []
  const center = (caption.rect[0] + caption.rect[2]) / 2
  const frame = matches[0].cropRect
  const first = {
      ...matches[0],
      caption: center >= frame[0] - h && center <= frame[2] + h ? caption : undefined
    },
    out = [first]
  if (first.kind !== 'native-boxed-table-visual') return out
  let previous = first
  for (let n = 0; n < 2; n++) {
    const opening = horizontal.find(
      (r) =>
        r[1] > previous.cropRect[3] + h * 0.3 &&
        r[1] - previous.cropRect[3] < h * 2 &&
        Math.abs(r[0] - first.cropRect[0]) < 0.6 &&
        Math.abs(r[2] - first.cropRect[2]) < 0.6
    )
    if (!opening) break
    const intervening = items.filter(
      (i) =>
        i.horizontal &&
        i.text?.trim() &&
        i.rect[1] > previous.cropRect[3] + 0.05 &&
        i.rect[3] < opening[1] - 0.05 &&
        i.rect[0] < opening[2] &&
        i.rect[2] > opening[0]
    )
    if (intervening.length) break
    const fakeCaption = {
      ...caption,
      rect: [opening[0], opening[1] - h, opening[2], opening[1] - 0.01]
    }
    const proofs = horizontal
      .filter(
        (r) =>
          r[1] > opening[1] + h * 3 &&
          Math.abs(r[0] - opening[0]) < 0.05 &&
          Math.abs(r[2] - opening[2]) < 0.05
      )
      .map((r) =>
        proveCaptionedNativeClosedTableFrame(
          { cropRect: [opening[0], opening[1], r[2], r[1]] },
          fakeCaption,
          items,
          rules
        )
      )
      .filter((p) => p?.kind === 'native-boxed-table-visual')
    if (!proofs.length) break
    previous = { ...proofs.at(-1), caption: undefined }
    out.push(previous)
  }
  return out
}

// A complete native definition frame is stronger ownership than a damaged
// formula-like detector grid. Return geometry proof, never invented math cells.
export function proveCaptionedNativeDefinitionFrame(table, caption, items, rules) {
  if (
    !table.cropRect ||
    !caption?.rect ||
    !/^Table\s+[\dIVXLC]+\s*[:.]/iu.test(caption.lines?.[0] ?? '')
  )
    return
  const [left, top, right, bottom] = table.cropRect
  const near = items.filter(
    (i) =>
      i.horizontal &&
      i.height > 0 &&
      i.rect[0] >= left - 5 &&
      i.rect[2] <= right + 5 &&
      i.rect[1] >= top - 15 &&
      i.rect[3] <= bottom + 15
  )
  const heights = near.map((i) => i.height).sort((a, b) => a - b),
    h = heights[heights.length >> 1]
  if (!(h > 0)) return
  const frame = joinHorizontalTableRules(rules)
    .filter(
      (r) =>
        r[1] >= top - h &&
        r[1] <= bottom + h &&
        Math.abs(r[0] - left) < h &&
        Math.abs(r[2] - right) < h
    )
    .sort((a, b) => a[1] - b[1])
  if (frame.length !== 2 && frame.length !== 3) return
  const opening = frame[0],
    closing = frame.at(-1)
  if (
    opening[1] - caption.rect[3] < -0.05 ||
    opening[1] - caption.rect[3] > h * 2 ||
    caption.rect[2] <= opening[0] ||
    caption.rect[0] >= opening[2] ||
    closing[1] - opening[1] < h * 4
  )
    return
  const source = items.filter(
    (i) =>
      i.horizontal &&
      i.text?.trim() &&
      i.rect[0] >= opening[0] - 0.05 &&
      i.rect[2] <= opening[2] + 0.05 &&
      i.rect[1] >= opening[1] - h * 0.3 &&
      i.rect[3] <= closing[1] + 0.05
  )
  if (!source.length) return
  const cropRect = [
    opening[0],
    Math.min(opening[1], ...source.map((i) => i.rect[1])),
    closing[2],
    closing[1]
  ]
  if (frame.length === 3) {
    const divider = frame[1],
      header = source.filter((i) => i.baseline < divider[1])
    if (
      header.length !== 3 ||
      header.map((i) => i.text.trim()).join('|') !== 'Symbol|Meaning|Notes' ||
      header.some((i) => Math.abs(i.baseline - header[0].baseline) > h * 0.15) ||
      divider[1] - opening[1] > h * 2.5
    )
      return
    const body = source.filter((i) => i.baseline > divider[1])
    if (body.length < 30 || body.filter((i) => /[=∑∏≤≥]/u.test(i.text)).length < 3) return
    return { kind: 'native-notation-visual', cropRect, sourceTokens: source, headerTokens: header }
  }
  const bands = groupSourceRowsWithScripts(source, h, 0.25)
  if (!bands || bands.length < 4 || bands.length > 12) return
  const labels = bands.map((g) => g.toSorted((a, b) => a.rect[0] - b.rect[0])[0])
  if (
    labels.some((i) => !/^\p{L}[\p{L}\d\s,/()−-]{5,60}$/u.test(i.text.trim())) ||
    labels.some((i) => Math.abs(i.rect[0] - labels[0].rect[0]) > h * 0.1)
  )
    return
  const values = bands.map((g, n) => g.filter((i) => i !== labels[n]))
  if (
    values.some(
      (g) =>
        g.length < 2 ||
        !g.some((i) => /\d/u.test(i.text)) ||
        !g.some((i) => /[=<>≤≥]/u.test(i.text))
    )
  )
    return
  const labelRight = Math.max(...labels.map((i) => i.rect[2])),
    valueLeft = Math.min(...values.flat().map((i) => i.rect[0]))
  if (valueLeft - labelRight < h * 0.8) return
  const cut = (labelRight + valueLeft) / 2
  if (
    bands
      .slice(1)
      .some(
        (g, n) =>
          Math.max(...bands[n].map((i) => i.rect[3])) - Math.min(...g.map((i) => i.rect[1])) >
          h * 0.1
      )
  )
    return
  const rows = bands.map((g, n) => [
    opening[0],
    n
      ? Math.min(
          Math.min(...g.map((i) => i.rect[1])),
          (Math.max(...bands[n - 1].map((i) => i.rect[3])) + Math.min(...g.map((i) => i.rect[1]))) /
            2
        )
      : cropRect[1],
    closing[2],
    n === bands.length - 1
      ? closing[1]
      : Math.max(
          Math.max(...g.map((i) => i.rect[3])),
          (Math.max(...g.map((i) => i.rect[3])) + Math.min(...bands[n + 1].map((i) => i.rect[1]))) /
            2
        )
  ])
  if (
    rows.some((r) => r[3] <= r[1]) ||
    bands.some((g, n) =>
      g.some((i) => i.rect[1] < rows[n][1] - 0.05 || i.rect[3] > rows[n][3] + 0.05)
    )
  )
    return
  return {
    kind: 'native-parameter-records',
    cropRect,
    sourceTokens: source,
    columns: [
      [opening[0], cropRect[1], cut, closing[1]],
      [cut, cropRect[1], closing[2], closing[1]]
    ],
    rows,
    bodyRecords: bands,
    headerRows: []
  }
}

// Native paragraph ink crosses a detector's artificial column cuts. Require
// several connected words on the same baseline; separate description columns
// and independently measured records do not supply this proof.
function hasContinuousNativeProse(table, items) {
  if (!table.cropRect || !table.cells?.length) return false
  const [left, top, right, bottom] = table.cropRect
  const cuts = [
    ...new Set(
      table.cells
        .filter((c) => c.colSpan === 1)
        .map((c) => c.rect[2])
        .filter((x) => x > left + 2 && x < right - 2)
    )
  ]
  if (!cuts.length) return false
  const source = items.filter(
    (i) =>
      i.horizontal &&
      i.height > 0 &&
      i.rect[3] > top &&
      i.rect[1] < bottom &&
      i.rect[2] > left &&
      i.rect[0] < right
  )
  if (!source.length) return false
  const em = Math.max(...source.map((i) => i.height))
  const rows = []
  for (const item of source
    .filter((i) => i.height >= em * 0.85)
    .sort((a, b) => a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0])) {
    const row = rows.find((r) => Math.abs(r[0].rect[1] - item.rect[1]) < em * 0.15)
    if (row) row.push(item)
    else rows.push([item])
  }
  const prose = []
  for (const row of rows) {
    const chains = []
    for (const item of row.sort((a, b) => a.rect[0] - b.rect[0])) {
      const chain = chains.at(-1),
        previous = chain?.at(-1)
      if (previous && item.rect[0] - previous.rect[2] < em * 0.9) chain.push(item)
      else chains.push([item])
    }
    for (const chain of chains) {
      const text = chain.map((i) => i.text).join(' ')
      if (
        (text.match(/\p{L}{2,}/gu) ?? []).length >= 5 &&
        chain.at(-1).rect[2] - chain[0].rect[0] > (right - left) * 0.5 &&
        cuts.some((x) => chain[0].rect[0] < x - em && chain.at(-1).rect[2] > x + em)
      )
        prose.push(chain)
    }
  }
  const measuredRows = table.grid.filter(
    (row) => row.filter((t) => /^[-+−]?\d+(?:\.\d+)?(?:\s*\([^)]*\))?$/.test(t.trim())).length >= 2
  )
  if (
    measuredRows.length ||
    table.grid.some((row) => row.some((t) => /^[-+−]?\d+(?:\.\d+)?\s*\([^)]*\)$/.test(t.trim())))
  )
    return false
  const text = source.map((i) => i.text).join(' ')
  return (
    prose.length >= 2 ||
    (prose.length === 1 && /[=≤≥⪰≳]/.test(text) && source.some((i) => /^[∇∥≥≤=−+]/.test(i.text)))
  )
}

function isNumberedNativeDisplay(table, items) {
  const equations = table.grid.filter(
    (row) =>
      row.some((t) => /^\((?:[A-Z]\.)?\d+(?:\.\d+)*\)$/.test(t.trim())) &&
      row.some((t) => /[=≤≥⪰∥∇]/.test(t))
  )
  if (!equations.length || !table.cropRect) return false
  const numericRows = table.grid.filter(
    (row) => row.filter((t) => /^[-+−]?\d+(?:\.\d+)?$/.test(t.trim())).length >= 2
  )
  if (numericRows.length) return false
  return equations.every((row) => {
    const label = row.find((t) => /^\((?:[A-Z]\.)?\d+(?:\.\d+)*\)$/.test(t.trim()))
    const matches = items.filter(
      (i) => i.horizontal && i.text.trim() === label && inside(table.cropRect, i)
    )
    return (
      matches.length === 1 &&
      matches[0].rect[0] > table.cropRect[0] + (table.cropRect[2] - table.cropRect[0]) * 0.8 &&
      items.some(
        (i) =>
          i.horizontal &&
          /[=≤≥⪰∥∇]/.test(i.text) &&
          Math.abs(i.rect[3] - matches[0].rect[3]) < matches[0].height * 0.2 &&
          matches[0].rect[0] - i.rect[2] > matches[0].height * 4
      )
    )
  })
}

// A displayed system of equations can be split into detector columns and look
// like a small table.  Without a caption, repeated mathematical rows and an
// equation ordinal are stronger evidence of native prose than tabular data.
function isNativeFormulaSystem(table, caption) {
  if (caption || !table.cropRect || table.grid.length < 3) return false
  const cells = table.grid
    .flat()
    .map((text) => text.trim())
    .filter(Boolean)
  if (cells.length < 5) return false
  const measuredRows = table.grid.filter(
    (row) =>
      row.filter((text) => /^[-+−]?\d+(?:\.\d+)?(?:\s*\([^)]*\))?$/.test(text.trim())).length >= 2
  )
  if (measuredRows.length) return false
  const formulaRows = table.grid.filter(
    (row) =>
      row.some((text) => /[=∈≤≥⪰∥∇]/u.test(text)) && row.some((text) => /[\p{L}α-ω]/u.test(text))
  )
  const ordinals = cells.filter((text) =>
    /(?:^|\s)\((?:[A-Z]\.)?\d+(?:\.\d+)*\)(?:$|[,.])/u.test(text)
  )
  const symbolic = cells.filter((text) => /[=∈≤≥⪰∥∇]/u.test(text)).length
  const prose = cells.filter(
    (text) => text.split(/\s+/).length >= 8 && !/[=∈≤≥⪰∥∇]/u.test(text)
  ).length
  return formulaRows.length >= 3 && ordinals.length >= 1 && symbolic >= 3 && prose <= 1
}

// Some appendix equations have enough aligned glyphs to be emitted as a
// detector table, but they do not contain a tabular record.  Captionless
// displays are already covered by isNativeFormulaSystem; this conservative
// companion also handles damaged math glyphs (for example boxed operators or
// replacement characters) when the crop carries a large amount of unowned
// text.  A complete two-column parameter table remains eligible because it has
// no crop-boundary/unassigned evidence.
function isDamagedNativeFormulaLayout(table, caption) {
  if (!table.cropRect || table.grid.length < 3) return false
  const populated = table.grid
    .flat()
    .map((text) => text.trim())
    .filter(Boolean)
  if (populated.length < 4) return false
  const math = /[=∈≤≥⪰∥∇∑√∞∫⋆ℓβγθνξ∆⊕⊗∀∃�−+*\/^]/u
  const formulaRows = table.grid.filter((row) => {
    const text = row.filter(Boolean).join(' ')
    return math.test(text) && /[\p{L}α-ω]/u.test(text)
  })
  if (caption && formulaRows.length < 2) return false
  const measuredRows = table.grid.filter(
    (row) =>
      row.filter((text) => /^[-+−]?\d+(?:\.\d+)?(?:\s*\([^)]*\))?$/.test(text.trim())).length >= 2
  )
  const controlGlyphs = populated.join(' ').match(/[\u0000-\u001f�]/gu)?.length ?? 0
  const ordinal = populated.some((text) =>
    /(?:^|\s)\((?:[A-Z]\.)?\d+(?:\.\d+)*\)(?:$|[,.])/u.test(text)
  )
  const symbolicCount = (populated.join(' ').match(/[=∈≤≥⪰∥∇∑√∞∫⋆ℓβγθνξ∆⊕⊗∀∃�−+*\/^]/gu) ?? [])
    .length
  if (caption && controlGlyphs === 0 && !ordinal && symbolicCount < 3) return false
  if (
    table.grid.length <= 4 &&
    controlGlyphs >= Math.max(2, Math.ceil(populated.length * 0.2)) &&
    (table.unassigned?.length ?? 0) + (table.clipped?.length ?? 0) >= 2
  )
    return true
  if (measuredRows.length || formulaRows.length < 2) return false
  const damage =
    (table.unassigned?.length ?? 0) + (table.clipped?.length ?? 0) >=
    Math.max(4, populated.length * 0.45)
  return damage && (ordinal || formulaRows.length >= 3 || table.grid.length <= 4)
}

function isImageBackedNonTable(table, caption, sourceGraphics = []) {
  if (caption || !table.cropRect || !sourceGraphics.length) return false
  const image = sourceGraphics.find(
    (graphic) =>
      graphic.kind === 'image' &&
      intersection(graphic.rect, table.cropRect) / area(table.cropRect) > 0.8 &&
      intersection(graphic.rect, table.cropRect) / area(graphic.rect) > 0.6
  )
  if (!image) return false
  const values = [...(table.grid ?? []).flat(), ...(table.unassigned ?? [])]
  const controlGlyphs = values.join(' ').match(/[\u0000-\u001f�]/gu)?.length ?? 0
  const measurements = values.filter((text) =>
    /^[-+−]?\d+(?:\.\d+)?(?:\s*[%±].*)?$/.test(text.trim())
  )
  const cleanWords = values.filter(
    (text) => /\p{L}{2,}/u.test(text) && !/[\u0000-\u001f�]/u.test(text)
  )
  return (
    measurements.length === 0 &&
    controlGlyphs >= Math.max(2, Math.ceil(values.length * 0.2)) &&
    (cleanWords.length < 3 || (table.unassigned?.length ?? 0) >= 2)
  )
}

// A detector can crop the tabular-looking left side of a figure panel while
// the right side remains part of the figure.  Publish the figure as one
// region instead of exposing a misleading partial table when the candidate
// has crop-boundary/unassigned evidence and sits almost entirely inside a
// captioned figure, but occupies only a portion of that figure.
export function isFigureOwnedPartialTable(table, figures, scale = 1.5) {
  if (
    !table?.cropRect ||
    !Array.isArray(figures) ||
    !table.issues?.includes('text-crosses-crop-boundary') ||
    !(table.unassigned?.length ?? 0)
  )
    return false
  const rect = table.cropRect.map((value) => value / scale)
  const rectArea = area(rect)
  if (!rectArea) return false
  return figures.some((figure) => {
    const graphic = figure?.rect
    if (!Array.isArray(graphic) || area(graphic) <= 0) return false
    const overlapArea = intersection(rect, graphic)
    return overlapArea / rectArea >= 0.85 && overlapArea / area(graphic) < 0.8
  })
}

function isCaptionedNarrativeCard(table, caption) {
  if (!caption || !table.grid.length || !table.unassigned?.length) return false
  const text = table.grid.flat().join(' ')
  const words = text.trim() ? text.trim().split(/\s+/).length : 0
  const measurements = table.grid
    .flat()
    .filter((cell) => /^[-+−]?\d+(?:\.\d+)?(?:\s*[%±].*)?$/.test(cell.trim()))
  return (
    measurements.length === 0 &&
    words >= 40 &&
    table.unassigned.length >= 8 &&
    (table.issues?.includes('text-crosses-crop-boundary') ||
      table.issues?.includes('overlapping-predicted-columns')) &&
    table.grid.length <= 5
  )
}

// Syntax-highlighted code listings can look like sparse multi-column tables
// when the detector follows the painted background or indentation.  Keep this
// proof deliberately narrow: require repeated declaration/return lines,
// source-level punctuation, and substantial text that the inferred grid did
// not assign.  Captioned tables remain eligible because a real caption is
// stronger ownership evidence than a lexical code signal.
function isNativeCodeListing(table, caption, items) {
  if (caption || !table.cropRect || !Array.isArray(items)) return false
  const populated = table.grid.flat().filter((text) => text.trim())
  if (populated.length < 2) return false
  const text = [...populated, ...(table.unassigned ?? [])].join(' ')
  const numberedAlgorithm =
    table.grid.length >= 6 &&
    table.grid.every((row) => row.length === 2 && /^(?:\d+:\s*)+$/.test(row[0].trim())) &&
    table.grid.filter((row) => /\b(?:for|while|if|continue|end\s+(?:if|for|while))\b/i.test(row[1]))
      .length >= 4 &&
    /\b(?:input|initialize|output)\s*:/i.test(text)
  if (numberedAlgorithm) return true
  const procedureRows = table.grid.filter((row) =>
    /\b(?:while|if|then|for\b[^\n]{0,60}\bdo|plan|sub-?goals?|node\s*\(|re-?enter)\b/iu.test(
      row.join(' ')
    )
  )
  const numberedProcedureRows = table.grid.filter((row) =>
    /^\s*\d+(?:\s+\d+)?\s*$/u.test(row.find((value) => value.trim())?.trim() ?? '')
  )
  if (
    table.grid.length >= 5 &&
    table.grid.every((row) => row.length <= 3) &&
    numberedProcedureRows.length >= 3 &&
    procedureRows.length >= 3 &&
    procedureRows.length >= table.grid.length * 0.5
  )
    return true
  if (!table.unassigned?.length || table.unassigned.length < populated.length) return false
  const declarations = (text.match(/\b(?:def|function|class|import|const|let|var)\b/gi) ?? [])
    .length
  const returns = (text.match(/\b(?:return|yield)\b/gi) ?? []).length
  const declarationKinds = new Set(
    (text.match(/\b(?:def|function|class|import|const|let|var)\b/gi) ?? []).map((word) =>
      word.toLowerCase()
    )
  )
  const syntax = (text.match(/[()[\]{}:=#]/g) ?? []).length
  if (syntax < 6) return false
  if (declarations < 2 || returns < 2 || declarationKinds.size < 1) return false
  const source = items.filter(
    (item) =>
      item.horizontal &&
      item.rect?.[1] >= table.cropRect[1] &&
      item.rect?.[3] <= table.cropRect[3] &&
      item.rect?.[2] > table.cropRect[0] &&
      item.rect?.[0] < table.cropRect[2]
  )
  const sourceDeclarations = source.filter((item) =>
    /^(?:def|function|class|import|const|let|var)\b/i.test(item.text.trim())
  ).length
  const sourceReturns = source.filter((item) =>
    /^(?:return|yield)\b/i.test(item.text.trim())
  ).length
  return sourceDeclarations >= 2 && sourceReturns >= 2
}

function isNativeSingleColumnDerivation(table, caption, items, rules) {
  if (
    !Array.isArray(rules) ||
    !caption?.rect ||
    !table.cropRect ||
    table.grid.length < 4 ||
    table.grid.some((row) => row.length !== 1)
  )
    return false
  const [left, top, right, bottom] = table.cropRect
  const source = items.filter((i) => i.horizontal && i.height > 0 && inside(table.cropRect, i))
  const em = Math.max(0, ...source.map((i) => i.height))
  const captionTop = caption.rect[1] * 1.5,
    bodyBottom = Math.max(
      ...(table.cells ?? []).flatMap((c) => (c.sourceRects ?? []).map((r) => r[3]))
    )
  if (
    !em ||
    captionTop - bottom > em * 3 ||
    (captionTop < bottom &&
      (!Number.isFinite(bodyBottom) || bottom - captionTop > em * 2 || captionTop <= bodyBottom))
  )
    return false
  if (
    rules.some(
      (r) => r[1] === r[3] && r[1] >= top && r[1] <= bottom && r[2] - r[0] > (right - left) * 0.5
    )
  )
    return false
  const physicalRows = []
  for (const item of source
    .filter((i) => i.rect[1] >= top && i.height >= em * 0.85)
    .sort((a, b) => a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0])) {
    const row = physicalRows.find((r) => Math.abs(r[0].rect[1] - item.rect[1]) < em * 0.15)
    if (row) row.push(item)
    else physicalRows.push([item])
  }
  const prose = physicalRows
    .map((row) => {
      row.sort((a, b) => a.rect[0] - b.rect[0])
      return {
        text: row.map((i) => i.text).join(' '),
        rect: [row[0].rect[0], row[0].rect[1], row.at(-1).rect[2], row[0].rect[3]],
        continuous: row.every((i, n) => !n || i.rect[0] - row[n - 1].rect[2] < em * 0.9)
      }
    })
    .filter(
      (i) =>
        i.continuous &&
        i.rect[2] - i.rect[0] > (right - left) * 0.5 &&
        (i.text.match(/\p{L}{2,}/gu) ?? []).length >= 5
    )
  if (prose.length < 3 || prose.some((i) => Math.abs(i.rect[0] - prose[0].rect[0]) > em * 0.2))
    return false
  const labels = source.filter(
    (i) => /^\(\d+(?:\.\d+)*\)$/.test(i.text.trim()) && i.rect[0] > left + (right - left) * 0.8
  )
  return (
    labels.length === 1 &&
    table.grid.some((row) => (row[0].match(/=/g) ?? []).length >= 2) &&
    source.some(
      (i) =>
        /=/.test(i.text) &&
        Math.abs(i.rect[3] - labels[0].rect[3]) < em * 0.2 &&
        labels[0].rect[0] - i.rect[2] > em * 4
    )
  )
}

// Risk strips belong to their survival plot. A detector can cross the plot
// boundary into prose, so test the assigned numeric cells rather than padding.
export function isFigureRiskTable(table, figures, page, scale = 1.5) {
  const numeric = table.cells.filter((c) => /\d/.test(c.text) && !/\p{L}/u.test(c.text))
  if (numeric.length < 6 || new Set(numeric.map((c) => c.row)).size < 2) return false
  const contains = (outer, inner) =>
    inner.every((v, n) => (n < 2 ? v >= outer[n] - 2 : v <= outer[n] + 2))
  return figures.some(
    (f) =>
      f.rect &&
      /Kaplan[–-]Meier|cumulative (?:risk|incidence)|survival/i.test(f.caption.lines.join(' ')) &&
      page.lines.some(
        (l) =>
          /^(?:Number|No\.?) (?:at risk|of (?:patients|participants) at risk)/i.test(
            l.text.trim()
          ) && contains(f.rect, [l.x, l.y, l.x + l.width, l.y + l.height])
      ) &&
      numeric.every(
        (c) =>
          c.sourceRects?.length &&
          c.sourceRects.every((r) =>
            contains(
              f.rect,
              r.map((v) => v / scale)
            )
          )
      )
  )
}

// A lettered appendix contents directory can look like a two-column table: each
// row has a one-letter section marker, a dotted leader, and a page number. Keep
// this proof deliberately narrow. A real data table may use letter categories,
// but it should not also have a page-level CONTENTS heading and dotted leaders.
function isLetteredContentsDirectory(table, pageItems) {
  if (table.grid.length < 3 || table.grid.some((row) => row.length !== 2)) return false
  if (
    !table.grid.every((row) => {
      const marker = row[0]?.trim() ?? ''
      const entry = row[1]?.trim() ?? ''
      return (
        /^[A-Z]$/.test(marker) &&
        /(?:\s*\.){3,}\s*\d{1,4}\s*$/.test(entry) &&
        /\p{L}{2}/u.test(entry)
      )
    })
  )
    return false

  const heading = pageItems.some((item) => /^contents$/i.test(item?.text?.trim() ?? ''))
  if (heading) return true

  const horizontal = pageItems
    .filter((item) => item?.horizontal !== false && item?.text?.trim() && Array.isArray(item.rect))
    .sort((a, b) => a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0])
  const lines = []
  for (const item of horizontal) {
    const itemHeight = Number.isFinite(item.height) ? item.height : item.rect[3] - item.rect[1]
    const line = lines.find(
      (candidate) =>
        Math.abs(candidate[0].rect[1] - item.rect[1]) <
          Math.min(
            Number.isFinite(candidate[0].height)
              ? candidate[0].height
              : candidate[0].rect[3] - candidate[0].rect[1],
            itemHeight
          ) *
            0.3 ||
        Math.abs(candidate[0].rect[3] - item.rect[3]) <
          Math.min(
            Number.isFinite(candidate[0].height)
              ? candidate[0].height
              : candidate[0].rect[3] - candidate[0].rect[1],
            itemHeight
          ) *
            0.3
    )
    if (line) line.push(item)
    else lines.push([item])
  }
  return lines.some(
    (line) =>
      line
        .sort((a, b) => a.rect[0] - b.rect[0])
        .map((item) => item.text.trim())
        .join('')
        .replace(/\s+/g, '')
        .toLowerCase() === 'contents'
  )
}

// A flat supplemental directory still has explicit native navigation roles:
// one local Contents title, consecutive S ordinals and a separate right page
// lane. Neither a section-looking data label nor the grid alone proves this.
function isFlatSupplementalContentsDirectory(table, items, rules) {
  if (!table.cropRect || table.grid.length < 4) return false
  const [left, top, right, bottom] = table.cropRect,
    width = right - left,
    source = items.filter(
      (i) =>
        i.horizontal &&
        i.height > 0 &&
        i.text?.trim() &&
        i.rect?.length === 4 &&
        i.rect.every(Number.isFinite)
    ),
    titles = source.filter(
      (i) =>
        /^contents$/iu.test(i.text.trim()) &&
        i.rect[0] >= left &&
        i.rect[2] <= right &&
        i.rect[1] >= top &&
        i.rect[3] <= bottom
    )
  if (titles.length !== 1) return false
  const title = titles[0],
    bands = []
  for (const i of source
    .filter(
      (i) =>
        i.baseline > title.baseline &&
        i.rect[1] >= top &&
        i.rect[3] <= bottom &&
        i.rect[0] >= left &&
        i.rect[2] <= right
    )
    .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    const band = bands.at(-1)
    if (band && Math.abs(i.baseline - band[0].baseline) < Math.min(i.height, band[0].height) * 0.2)
      band.push(i)
    else bands.push([i])
  }
  const entries = bands.flatMap((g) => {
    const ordered = [...g].sort((a, b) => a.rect[0] - b.rect[0]),
      target = ordered.at(-1),
      labelItems = ordered.slice(0, -1),
      label = labelItems.map((i) => i.text.trim()).join(' '),
      match = /^S(\d+)\s+(\p{L}.*)$/u.exec(label)
    if (
      !match ||
      !/^\d{1,4}$/u.test(target.text.trim()) ||
      target.rect[0] < left + width * 0.8 ||
      target.rect[0] - labelItems.at(-1).rect[2] < target.height * 2
    )
      return []
    return [
      { ordinal: Number(match[1]), page: Number(target.text.trim()), target, first: ordered[0] }
    ]
  })
  if (
    entries.length < 4 ||
    entries.length < table.grid.length * 0.8 ||
    entries[0].first.rect[1] - title.rect[3] > entries[0].first.height * 3 ||
    entries.some(
      (e, n) =>
        e.ordinal !== n + 1 ||
        e.page < 1 ||
        (n && e.page < entries[n - 1].page) ||
        Math.abs(e.target.rect[2] - entries[0].target.rect[2]) > e.target.height * 0.2
    )
  )
    return false
  return !rules.some(
    (r) =>
      r[1] === r[3] &&
      r[2] - r[0] > width * 0.5 &&
      r[1] > entries[0].first.rect[1] &&
      r[1] < entries.at(-1).target.rect[3]
  )
}

// Hierarchical contents pages are often emitted as a two-column table: the
// section label is followed by a dotted leader and a printed page number. A
// page-level Contents heading plus repeated navigation-shaped rows is a
// stronger non-table proof than detector confidence. Keep the test narrow so
// dotted values in a real data table are not discarded.
function isHierarchicalContentsDirectory(table, pageItems, sourceRules) {
  if (!table?.grid || table.grid.length < 5 || !Array.isArray(pageItems)) return false
  const rules = Array.isArray(sourceRules) ? sourceRules : []
  const horizontal = pageItems
    .filter((item) => item?.horizontal !== false && item?.text?.trim() && Array.isArray(item.rect))
    .sort((a, b) => a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0])
  const lines = []
  for (const item of horizontal) {
    const height = Number.isFinite(item.height) ? item.height : item.rect[3] - item.rect[1]
    const line = lines.find(
      (candidate) =>
        Math.abs(candidate[0].rect[1] - item.rect[1]) < Math.min(candidate[0].height, height) * 0.3
    )
    if (line) line.push({ ...item, height })
    else lines.push([{ ...item, height }])
  }
  const joinedLines = lines.map((line) =>
    line
      .sort((a, b) => a.rect[0] - b.rect[0])
      .map((item) => item.text.trim())
      .join('')
      .replace(/\s+/g, ' ')
      .trim()
  )
  if (!joinedLines.some((text) => /^(?:table\s+of\s+)?contents$/i.test(text))) return false

  // Hierarchical navigation also occurs without leaders, between page-wide
  // outer separators. Prove native section/title/page lanes, a consecutive
  // major sequence and nested ordinals before allowing those outer strokes.
  if (table.cropRect) {
    const [left, top, right, bottom] = table.cropRect,
      width = right - left
    const titles = lines.filter((line) =>
      /^(?:table\s+of\s+)?contents$/i.test(line.map((i) => i.text.trim()).join(''))
    )
    const title = titles.length === 1 ? titles[0] : undefined
    const entries = lines.flatMap((line) => {
      const ordered = [...line].sort((a, b) => a.rect[0] - b.rect[0]),
        first = ordered[0],
        target = ordered.at(-1),
        label = ordered
          .slice(0, -1)
          .map((i) => i.text.trim())
          .join(' '),
        match = /^(\d+(?:\.\d+)*|[A-Z])\s+(.+)$/.exec(label)
      if (
        !match ||
        !target ||
        !title ||
        !/\p{L}{2}/u.test(match[2]) ||
        !/^\d{1,4}$/.test(target.text.trim()) ||
        first.rect[1] <= title[0].rect[1] ||
        first.rect[0] < left - first.height * 0.2 ||
        first.rect[1] < top ||
        target.rect[2] > right + target.height * 0.2 ||
        target.rect[3] > bottom ||
        target.rect[0] < left + width * 0.8 ||
        target.rect[0] - ordered.at(-2).rect[2] < target.height * 2
      )
        return []
      return [{ ordinal: match[1], page: Number(target.text.trim()), first, target }]
    })
    const majors = entries.filter((e) => /^\d+$/.test(e.ordinal)),
      nested = entries.filter((e) => /^\d+\.\d+$/.test(e.ordinal))
    const navigable =
      majors.length >= 4 &&
      nested.length >= 3 &&
      entries.length >= 9 &&
      entries.length >= table.grid.length * 0.8 &&
      title.every(
        (i) => i.rect[0] >= left - i.height * 0.2 && i.rect[2] <= right + i.height * 0.2
      ) &&
      entries[0].first.rect[1] - Math.max(...title.map((i) => i.rect[3])) <=
        entries[0].first.height * 4 &&
      Math.min(...title.map((i) => i.rect[1])) >= top - entries[0].first.height * 2 &&
      majors.every((e, n) => Number(e.ordinal) === n + 1) &&
      nested.every((e) =>
        majors.some(
          (m) => m.ordinal === e.ordinal.split('.')[0] && m.first.rect[1] < e.first.rect[1]
        )
      ) &&
      entries.every(
        (e, n) =>
          e.page > 0 &&
          (!n || e.page >= entries[n - 1].page) &&
          Math.abs(e.target.rect[2] - entries[0].target.rect[2]) <= e.target.height * 0.2
      )
    const interiorRule = rules.some(
      (r) =>
        Math.abs(r[3] - r[1]) < 1 &&
        r[2] - r[0] > width * 0.5 &&
        entries.length &&
        r[1] > entries[0].first.rect[1] &&
        r[1] < entries.at(-1).target.rect[3]
    )
    if (navigable && !interiorRule) return true
  }
  if (
    table.cropRect &&
    rules.some(
      (r) =>
        Math.abs(r[3] - r[1]) < 1 && r[2] - r[0] > (table.cropRect[2] - table.cropRect[0]) * 0.5
    )
  )
    return false

  const rows = table.grid.map((row) => row.map((text) => String(text ?? '').trim()).filter(Boolean))
  const leader = /(?:\.\s*){3,}|…{2,}/
  const pageNumber = /(?:^|\s)\d{1,4}$/
  const navigable = rows.filter((row) => {
    const text = row.join(' ').replace(/\s+/g, ' ').trim()
    return leader.test(text) && pageNumber.test(text)
  })
  if (navigable.length < 5 || navigable.length / rows.length < 0.7) return false

  const hierarchical = navigable.filter((row) => {
    const text = row.join(' ').trim()
    return /^(?:[A-Z]|\d+(?:\.\d+)*)(?:[.)]|\s)/.test(text)
  })
  // Require either a nested numeric section or several lettered/numbered
  // section markers. This prevents a captioned data table containing dotted
  // decimal values from being treated as a directory.
  const nested = navigable.some((row) => /^\d+\.\d+(?:\.|\s)/.test(row.join(' ').trim()))
  return nested || hierarchical.length >= 3
}

// Detection confidence alone also accepts affiliations and prose. Like the upstream
// content-supported row/column refinement, require evidence from source text.
// ponytail: uncaptioned single-column or single-row tables remain ambiguous with lists;
// retain them only with a reliable table caption until richer layout evidence is available.
export function hasTableEvidence(table, caption, pageItems = [], sourceRules, sourceGraphics = []) {
  const populatedRows = table.grid.map((row) => row.filter((text) => text.trim()).length)
  if (!populatedRows.some((count) => count > 0)) return false
  if (isNativeProseFootnoteOverlap(table, caption, pageItems, sourceRules ?? [])) return false
  const nativeCaption = caption?.rect
    ? { ...caption, rect: caption.rect.map((v) => v * (table.sourceViewport?.scale ?? 1.5)) }
    : undefined
  const nativeLeaves =
    nativeCaption &&
    sourceRules &&
    proveNativeClosedLeafHeader(table, pageItems, [nativeCaption], sourceRules)
  if (
    nativeLeaves &&
    table.grid.length === nativeLeaves.bodyRecords.length + 1 &&
    table.grid.every((row) => row.length === nativeLeaves.columns.length) &&
    nativeLeaves.headerCells.every(
      (c) => table.grid[0][c.column].replace(/\s/gu, '') === c.text.replace(/\s/gu, '')
    ) &&
    [...nativeLeaves.ownedTokens, ...nativeLeaves.originalBody].every((i) =>
      (table.cells ?? []).some((c) =>
        (c.sourceRects ?? []).some((r) => r.every((v, n) => Math.abs(v - i.rect[n]) < 0.02))
      )
    ) &&
    (table.cells ?? []).every(
      (c) =>
        c.rect?.length === 4 &&
        c.rect.every(Number.isFinite) &&
        c.rect[2] > c.rect[0] &&
        c.rect[3] > c.rect[1]
    )
  )
    return true
  const nativeDefinition =
    caption?.rect &&
    sourceRules &&
    proveCaptionedNativeDefinitionFrame(
      table,
      { ...caption, rect: caption.rect.map((v) => v * (table.sourceViewport?.scale ?? 1.5)) },
      pageItems,
      sourceRules
    )
  if (
    nativeDefinition?.kind === 'native-parameter-records' &&
    table.grid.length === nativeDefinition.bodyRecords.length &&
    table.grid.every((row) => row.length === 2 && row.every((text) => text.trim())) &&
    !table.unassigned?.length &&
    !table.clipped?.length &&
    nativeDefinition.sourceTokens.every((i) =>
      (table.cells ?? []).some((c) =>
        (c.sourceRects ?? []).some((r) => r.every((v, n) => Math.abs(v - i.rect[n]) < 0.02))
      )
    )
  )
    return true
  if (!caption && isHierarchicalContentsDirectory(table, pageItems, sourceRules)) return false
  if (!caption && isLetteredContentsDirectory(table, pageItems)) return false
  if (!caption && isFlatSupplementalContentsDirectory(table, pageItems, sourceRules ?? []))
    return false
  // A supplementary-materials directory names several external tables. Its
  // neighboring entry is not a caption for the directory or nearby references.
  if (
    /^Supplementary Table/i.test(caption?.lines?.[0] ?? '') &&
    [...table.grid.map((row) => row.join(' ')), ...(table.unassigned ?? [])].filter((text) =>
      /^Supplementary Table S?\d+\s*[|:]/i.test(text)
    ).length >= 2
  )
    return false
  // A contents list has repeated numbered captions followed by page numbers.
  // A caption association to its first entry must not turn the list into a table.
  const contentsRows = table.grid.map((row) => row.join(' ').trim())
  if (
    contentsRows.filter((text) => /^(?:TABLE|FIGURE)\s+\d+\b.*\s\d+$/i.test(text)).length >= 3 &&
    table.grid.every((row) => row.filter((text) => text.trim()).length <= 3)
  )
    return false
  if (isNativeSingleColumnDerivation(table, caption, pageItems, sourceRules)) return false
  if (isNativeFormulaSystem(table, caption)) return false
  if (isDamagedNativeFormulaLayout(table, caption)) return false
  if (isCaptionedNarrativeCard(table, caption)) return false
  if (isImageBackedNonTable(table, caption, sourceGraphics)) return false
  if (isNativeCodeListing(table, caption, pageItems)) return false
  if (caption) return true
  if (hasNativeNonTableLayout(table, pageItems, sourceRules)) return false
  if (
    table.repairs?.some((r) =>
      ['closed-numeric-grid-recovered', 'wrapped-count-grid-recovered'].includes(r)
    )
  )
    return true
  const sourceText = pageItems.map((item) => item.text).join(' ')
  // Preserve an explicitly labelled, completely assigned native glossary.
  // A distant mention of abbreviations is not enough to admit an arbitrary list.
  if (
    table.cropRect &&
    table.grid.length >= 4 &&
    !table.unassigned?.length &&
    table.grid.every(
      (row) =>
        row.length === 2 &&
        /^[A-Z][A-Za-z\d/&–-]{0,15}$/.test(row[0].trim()) &&
        /\p{L}/u.test(row[1])
    ) &&
    pageItems.some(
      (i) =>
        i.horizontal &&
        /^(?:List of )?Abbreviations\s*:?$/i.test(i.text.trim()) &&
        i.rect[3] <= table.cropRect[1] + i.height * 0.2 &&
        table.cropRect[1] - i.rect[3] < i.height * 2 &&
        i.rect[0] >= table.cropRect[0] - i.height &&
        i.rect[0] < table.cropRect[2]
    )
  )
    return true
  const cropText = [...table.grid.flat(), ...(table.unassigned ?? [])].join(' ')
  const compactText = cropText.replace(/\s/g, '')
  const words = (text) => (text.trim() ? text.trim().split(/\s+/).length : 0)
  if (
    /\bAuthor contributions\b/i.test(sourceText) &&
    table.grid.every((row) => row.length === 2) &&
    table.grid[0].some((text) => /^Author Initials$/i.test(text.trim())) &&
    /conception|design|final approval/i.test(cropText)
  )
    return false
  const measurement = (text) => /^[-+−]?\d+(?:\.\d+)?(?:\s*\([^)]*\))?$/.test(text.trim())
  const hasMeasurement = table.grid.some((row) => row.some(measurement))
  if (hasContinuousNativeProse(table, pageItems) || isNumberedNativeDisplay(table, pageItems))
    return false
  // Repeated affiliation markers, institutions and contact addresses identify
  // an author footer even when word-spaced prose became many model columns.
  if (
    !hasMeasurement &&
    (cropText.match(/[†‡§¶]/g) ?? []).length >= 3 &&
    (cropText.match(/\b(?:Department|University|Institute|College)\b/gi) ?? []).length >= 3 &&
    (cropText.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g) ?? []).length >= 2
  )
    return false
  // Article metadata can form a false stub beside the abstract. Receipt and
  // acceptance dates plus a DOI or a complete history/keywords heading identify
  // that publication block independently of the neighboring abstract.
  if (
    !hasMeasurement &&
    table.grid.every((row) => row.length <= 2) &&
    /\bReceived\s+\d/i.test(cropText) &&
    /\bAccepted\s+\d/i.test(cropText) &&
    (/\bDOI\s*:\s*10\./i.test(cropText) ||
      (/\bArticle history\s*:/i.test(cropText) &&
        /\bAvailable online\b/i.test(cropText) &&
        /\bKeywords\s*:/i.test(cropText)))
  )
    return false
  // Abstract headings and clipped paragraph tails do not become a table
  // merely because the detector aligns the headings into a stub column.
  if (
    table.grid.length >= 3 &&
    table.grid.every((row) => row.length === 2) &&
    table.grid.filter((row) =>
      /^(?:Background|Methods?|Results?|Conclusions?|Objectives?)[:.]?$/i.test(row[0].trim())
    ).length >= 3 &&
    table.grid.every((row) => !measurement(row[1])) &&
    (table.clipped?.length >= 3 || table.issues?.includes('text-crosses-crop-boundary'))
  )
    return false
  // Numbered affiliation blocks can have an extra model column containing
  // only affiliation ordinals. Require institutional prose on both sides.
  if (
    table.grid.length >= 2 &&
    table.grid.every((row) => row.length <= 3 && row.filter(measurement).length <= 1) &&
    table.grid.filter(
      (row) =>
        row.filter((text) =>
          /\b(?:Department|University|Institute|Hospital|College|Unit)\b/i.test(text)
        ).length >= 2
    ).length >= 2 &&
    table.grid.filter((row) => /^\d+\s+\p{L}/u.test(row[0])).length >= 2
  )
    return false
  // A lone citation plus a page number may be entirely inside its crop.
  // Publication year/volume/page syntax and an author list are independent
  // evidence; the page number must not masquerade as a measured data row.
  if (
    table.grid.length <= 4 &&
    table.grid.every((row) => row.length <= 2) &&
    /^\d+\.\s+\p{Lu}[\p{L} '-]+\s+[A-Z][, .]/u.test(cropText.trim()) &&
    /\bet al\./i.test(cropText) &&
    /\b(?:19|20)\d{2};\d+(?::|\()[A-Z]*\d+[–-]\d+/.test(cropText) &&
    table.grid.filter((row) => row.some(measurement)).length <= 1
  )
    return false
  // Author-year bibliographies may fill the crop without clipping a single
  // line. Repeated parenthesized years and journal volume/page ranges together
  // identify the prose columns; measured or captioned tables remain eligible.
  if (
    !hasMeasurement &&
    table.grid.every((row) => row.length <= 2) &&
    (cropText.match(/\((?:19|20)\d{2}[a-z]?\)/g) ?? []).length >= 3 &&
    (cropText.match(/\b\d{1,4}\s*,\s*\d+[–-]\d+[.]/g) ?? []).length >= 3
  )
    return false
  // Author blocks repeat personal names followed by affiliations in both page
  // columns. Neither particular institutions nor country names prove ownership.
  // Preserve captioned tables above and measured comparisons below.
  const populatedCells = table.grid.flat().filter((text) => text.trim())
  const authorAffiliations = populatedCells.filter((text) =>
    /^(?:(?:\p{Lu}[\p{L}’'-]+|\p{Lu}\.)\s+){2,6}(?:University|College|School|Institute|Hospital|Center)\b/u.test(
      text.trim()
    )
  )
  if (
    !hasMeasurement &&
    table.grid.every((row) => row.length <= 2) &&
    authorAffiliations.length >= 4 &&
    authorAffiliations.length >= populatedCells.length * 0.6
  )
    return false
  // Publication sidebars can cross into an abstract. A DOI split across native
  // lines leaves an apparently numeric last cell, so require publication and
  // licensing anchors together instead of treating that fragment as a value.
  if (
    table.grid.every((row) => row.length <= 2 && row.filter(measurement).length < 2) &&
    /Acceptedon/i.test(compactText) &&
    /published(?:at|on|online)/i.test(compactText) &&
    /\bDOI\b/i.test(cropText) &&
    /(?:org\/|DOI:)10\./i.test(compactText) &&
    /(?:CreativeCommons|©)/i.test(compactText)
  )
    return false
  // Section outlines contain numbered prose headings, sometimes with a
  // completely empty detector column. Those ordinals are not measurements.
  if (
    table.grid.length <= 4 &&
    table.grid.length >= 2 &&
    table.grid.every(
      (row) =>
        /^\d+(?:\.\d+)*\.$/.test(row[0]?.trim() ?? '') &&
        row.slice(1).filter((text) => text.trim()).length === 1 &&
        row.slice(1).some((text) => /^[\p{L} -]+$/u.test(text.trim()))
    ) &&
    table.issues?.includes('text-crosses-crop-boundary')
  )
    return false
  // A detector can turn a reference column or a prose section outline into a
  // two-column grid. These candidates commonly cross the crop boundary and
  // leave source text unassigned. Keep a measured comparison or a captioned
  // table above, but reject the unstructured shapes before they reach output.
  const referenceHeading = pageItems.some((item) =>
    /^(?:References|Bibliography)\s*:?$/i.test(item.text.trim())
  )
  const numberedReferenceMarkers = pageItems.filter((item) =>
    /^\d+[.)]?$/.test(item.text.trim())
  ).length
  const sourceReferenceMarkers = (sourceText.match(/(?:^|\s)\d+\.\s/g) ?? []).length
  const citationYears = (sourceText.match(/\b(?:19|20)\d{2}\b/g) ?? []).length
  const citationUrls = (cropText.match(/https?:\/\/|doi\.org/gi) ?? []).length
  const referenceLikeGrid = table.grid.every((row) => row.length <= 6)
  const numberedCitationRows = table.grid.filter((row) => {
    const marker = row[0]?.trim() ?? ''
    const citation = row.slice(1).join(' ').trim()
    return (
      /^\d+[.)]?$/.test(marker) &&
      words(citation) >= 8 &&
      /(?:19|20)\d{2}\b/.test(citation) &&
      /\b(?:Journal|Cancer|BMJ|Eur|doi|et al\.)\b/i.test(citation)
    )
  }).length
  if (
    !hasMeasurement &&
    referenceLikeGrid &&
    table.issues?.includes('text-crosses-crop-boundary') &&
    ((referenceHeading && numberedReferenceMarkers >= 3) ||
      (numberedReferenceMarkers >= 3 && citationYears >= 3) ||
      (citationUrls >= 2 && citationYears >= 2) ||
      (sourceReferenceMarkers >= 3 && citationYears >= 3))
  )
    return false
  // A two-column detector crop can also treat a short bibliography tail as a
  // table. Numeric-only left cells are ordinals in this shape, not measured
  // values; require every row to carry a long citation before rejecting it.
  if (
    !caption &&
    table.issues?.includes('text-crosses-crop-boundary') &&
    numberedCitationRows >= 2 &&
    numberedCitationRows === table.grid.length
  )
    return false
  // Multi-column review questions often resemble a sparse table because each
  // answer option lands in a separate detector column. Repeated question
  // numbers, option markers, and question punctuation identify the outline;
  // measured or captioned tables remain eligible.
  const questionRows = table.grid.filter((row) => /\b\d+\.\s+/u.test(row.join(' '))).length
  const questionMarks = (cropText.match(/\?/g) ?? []).length
  const optionCount = (cropText.match(/(?:^|\s)[a-c][.)]\s/giu) ?? []).length
  if (
    !caption &&
    table.issues?.includes('text-crosses-crop-boundary') &&
    !hasMeasurement &&
    questionRows >= 2 &&
    (questionMarks >= 2 || (questionMarks === 1 && questionRows >= 4)) &&
    optionCount >= 6
  )
    return false
  // Detector spans can merge footnotes or prose notes into a wide cell and
  // then split the following paragraph into two columns. Without a caption or
  // measured records, a majority of full-width model spans is stronger
  // evidence of a page note than of a data table. Keep this generic so real
  // qualitative tables with a coherent row grid remain eligible.
  if (
    !caption &&
    table.issues?.includes('text-crosses-crop-boundary') &&
    table.issues?.includes('unassigned-source-text') &&
    table.cells?.length &&
    table.grid.length >= 4 &&
    table.grid.length <= 12 &&
    !hasMeasurement
  ) {
    const columnCount = Math.max(...table.grid.map((row) => row.length))
    const fullWidthSpanRows = new Set(
      table.cells
        .filter((cell) => cell.origin === 'model-span' && (cell.colSpan ?? 1) >= columnCount)
        .map((cell) => cell.row)
    )
    const longProseRows = table.grid.filter((row) => row.some((text) => words(text) >= 8)).length
    if (
      fullWidthSpanRows.size >= 3 &&
      fullWidthSpanRows.size >= Math.ceil(table.grid.length * 0.5) &&
      longProseRows >= 2
    )
      return false
  }
  // A small detector crop at the end of a prose column can look like a two
  // column table when the adjacent sentence and journal furniture are split
  // into separate cells. Require a caption or measured content for this
  // ambiguous shape; quoted narrative tables remain eligible.
  if (
    !caption &&
    table.cropRect &&
    table.issues?.includes('text-crosses-crop-boundary') &&
    table.issues?.includes('unassigned-source-text') &&
    table.grid.length <= 3 &&
    table.grid.every((row) => row.length <= 2 && !row.some(measurement)) &&
    (table.unassigned?.length ?? 0) >= 2
  ) {
    const populated = table.grid.flat().filter((text) => text.trim())
    const hasQuotedNarrative = populated.some((text) => /^[“"']/u.test(text.trim()))
    if (!hasQuotedNarrative && populated.filter((text) => words(text) >= 4).length >= 2)
      return false
  }
  // A displayed equation followed by parameter bullets is explanatory prose.
  // Require repeated bullet markers, a mathematical expression, long prose
  // cells and no measured record; retain captioned and numeric tables above.
  if (
    !hasMeasurement &&
    table.grid.every((row) => row.length <= 2) &&
    table.grid.filter((row) => /^[•◦]$/.test(row[0]?.trim() ?? '')).length >= 3 &&
    table.grid.filter((row) => row.some((text) => words(text) >= 8)).length >= 3 &&
    /[=∈]/u.test(cropText) &&
    (cropText.match(/[α-ω]/gu) ?? []).length >= 3
  )
    return false
  const sectionLabelRows = table.grid.filter(
    (row) => !row[0]?.trim() || /^\d+\.\d+(?:\.\d+)*$/.test(row[0].trim())
  ).length
  const sectionProseRows = table.grid.filter((row) => words(row[1] ?? '') >= 8).length
  if (
    table.grid.length >= 3 &&
    table.grid.every((row) => row.length === 2) &&
    !table.grid.some((row) => measurement(row[1])) &&
    sectionLabelRows >= table.grid.length * 0.6 &&
    sectionProseRows >= table.grid.length * 0.6
  )
    return false
  // Quoted callouts are frequently boxed like a small two-column table. Keep
  // them in the source document unless a real table caption or measurement
  // column provides explicit structure evidence.
  const quotedRows = table.grid.filter((row) => /^[“”"']/.test((row[0] ?? '').trim()))
  if (
    !caption &&
    !hasMeasurement &&
    table.grid.length <= 4 &&
    table.grid.every((row) => row.length <= 2) &&
    quotedRows.length > 0 &&
    words(table.grid.flat().join(' ')) >= 6
  )
    return false
  // Article title/author blocks can align into two detector columns and may
  // contain a journal year or page range. They have no table caption and no
  // measured data, so discard the structural false positive.
  if (
    !caption &&
    !hasMeasurement &&
    table.grid.every((row) => row.length <= 2) &&
    /\b(?:Department|University|Institute)\b/i.test(
      [...table.grid.flat(), ...(table.unassigned ?? [])].join(' ')
    ) &&
    /(?:©|\b(?:19|20)\d{2}\s*,\s*\d+\s*,\s*\d+\s*,\s*\d+[–-]\d+)/u.test(
      [...table.grid.flat(), ...(table.unassigned ?? [])].join(' ')
    )
  )
    return false
  if (table.cropRect && table.grid.every((r) => r.length <= 2 && !r.some(measurement))) {
    const [left, top, right, bottom] = table.cropRect
    const prose = pageItems.filter(
      (i) =>
        i.horizontal &&
        i.rect[1] >= top - i.height &&
        i.rect[3] <= bottom + i.height &&
        i.text.trim().split(/\s+/).length >= 5
    )
    // A short detector box can cut into the left article column while its right
    // edge happens to coincide with the other column's margin.
    if (
      table.grid.length <= 6 &&
      prose.filter((i) => i.rect[0] < left - i.height && i.rect[2] > left).length >= 3 &&
      prose.filter(
        (i) => i.rect[0] > left + (right - left) * 0.4 && Math.abs(i.rect[2] - right) < i.height
      ).length >= 3 &&
      pageItems.filter(
        (i) =>
          i.horizontal &&
          i.rect[1] < bottom &&
          i.rect[3] > bottom &&
          i.text.trim().split(/\s+/).length >= 5
      ).length >= 2
    )
      return false
    // A clipped questionnaire outline can leave most of the predicted table
    // empty. Its repeated source bullets outside the crop establish list prose.
    if (
      prose.length >= 6 &&
      Math.max(...prose.map((i) => i.rect[3])) < top + (bottom - top) * 0.4 &&
      pageItems.filter(
        (i) =>
          /^[•◦]$/.test(i.text) &&
          i.rect[0] < left &&
          i.rect[0] >= left - i.height * 3 &&
          i.rect[1] >= top &&
          i.rect[3] < bottom
      ).length >= 3
    )
      return false
  }
  if (
    !table.grid.some((row) => row.filter(measurement).length >= 2) &&
    ((/Prepublication history/i.test(cropText) &&
      /supplemental\s+material/i.test(cropText) &&
      /doi(?:[.:]|\.org)/i.test(cropText)) ||
      (/Acknowledgements/i.test(cropText) &&
        table.grid.filter(
          (row) =>
            /^[A-Z][A-Za-z]{1,8}$/.test(row[0]) &&
            row.slice(1).some((text) => text.split(/\s+/).length >= 2)
        ).length >= 3) ||
      (table.grid.every((row) => row.length <= 3) &&
        (cropText.match(/\b(?:Department|University|Institute|College|School)\b/g) ?? []).length >=
          5 &&
        (cropText.match(/\b(?:UK|USA|Ukraine|Korea|Belarus|Federation)\b/g) ?? []).length >= 3))
  )
    return false

  if (
    /Full protocol available at:/i.test(cropText) &&
    /Raw data available at:/i.test(cropText) &&
    /\S+@\S+/.test(cropText) &&
    !table.grid.some((r) => r.some(measurement))
  )
    return false
  // Tiny detections across two prose columns contain clipped sentences rather
  // than independently measured records. Require source overhang on both sides.
  if (
    table.cropRect &&
    table.grid.length <= 3 &&
    table.grid.every((r) => r.length <= 2 && !r.some(measurement))
  ) {
    const prose = pageItems.filter(
      (i) =>
        i.horizontal &&
        i.rect[1] >= table.cropRect[1] - i.height &&
        i.rect[3] <= table.cropRect[3] &&
        i.text.trim().split(/\s+/).length >= 7
    )
    if (
      prose.some(
        (i) => i.rect[0] < table.cropRect[0] - i.height && i.rect[2] > table.cropRect[0]
      ) &&
      prose.some((i) => i.rect[0] < table.cropRect[2] && i.rect[2] > table.cropRect[2] + i.height)
    )
      return false
  }

  // A numbered parameter list has punctuation on each ordinal and one prose
  // field. Ordinals alone must not count as a measurement column.
  if (
    table.grid.every(
      (row) => row.length === 2 && (!row[0].trim() || /^\d+\.$/.test(row[0].trim()))
    ) &&
    table.grid.filter((row) => /^\d+\.$/.test(row[0].trim()) && /\p{L}/u.test(row[1])).length >=
      4 &&
    !table.grid.some((row) => measurement(row[1]))
  )
    return false
  // A small detection across several empty model columns is a prose fragment
  // when native sentences cross its edges and it contains no measured records.
  if (
    table.cropRect &&
    table.grid.length <= 3 &&
    table.grid[0]?.length >= 3 &&
    table.grid.every((row) => row.filter((s) => s.trim()).length <= 4 && !row.some(measurement)) &&
    pageItems.filter(
      (i) =>
        i.text.length > 40 &&
        i.rect[1] < table.cropRect[3] &&
        i.rect[3] > table.cropRect[1] &&
        (i.rect[0] < table.cropRect[0] || i.rect[2] > table.cropRect[2])
    ).length >= 2
  )
    return false

  // Short metadata and bibliography fragments may produce plausible-looking
  // columns. Require explicit publication anchors and no measured data pairs.
  if (
    table.grid.every((row) => row.length <= 3 && row.filter(measurement).length < 2) &&
    ((/\bKey words?:/i.test(cropText) && table.grid.length <= 3) ||
      ((cropText.match(/\((?:19|20)\d{2}\)\s*:/g) ?? []).length >= 3 &&
        /\b(?:Ophthalmol|Cancer|Journ?al)\b/i.test(cropText)))
  )
    return false
  // Disclosure directories align names and relationship labels in columns.
  // Require several explicit relationship labels and no measurement columns;
  // a captioned research table has already been accepted above.
  if (
    table.grid.every((row) => row.length <= 2 && !row.some(measurement)) &&
    (
      cropText.match(
        /\b(?:Consulting or Advisory Role|Research Funding|Honoraria|Speakers[’'] Bureau|Uncompensated Relationships|Travel, Accommodations, Expenses)\s*:/g
      ) ?? []
    ).length >= 3
  )
    return false
  if (
    table.grid.every((row) => row.filter(measurement).length <= 1) &&
    ((/Published Online:/i.test(cropText) && /doi:\s*10\./i.test(cropText)) ||
      ((
        cropText.match(
          /\b(?:Department of|Clinic of|Clinical Epidemiology|College of|Medical School|Epidemiology Division)\b/gi
        ) ?? []
      ).length >= 3 &&
        table.grid.every((row) => row.length <= 3)) ||
      (/\b(?:PhD|MD)\b/.test(cropText) &&
        /\bJournal of\b/.test(cropText) &&
        /\bDOI:\s*10\./i.test(sourceText) &&
        /©/.test(sourceText) &&
        table.grid.length <= 3 &&
        table.grid.every((row) => row.length <= 2)))
  )
    return false
  if (
    /Corresponding Author\s*:/i.test(cropText) &&
    /E-mail\s*:\s*\S+@\S+/i.test(cropText) &&
    /doi\s*:\s*10\./i.test(cropText) &&
    /(?:Creative Commons|Published by)/i.test(cropText)
  )
    return false
  if (
    /Reprints and permission/i.test(cropText) &&
    /DOI:\s*10\./i.test(cropText) &&
    /https?:\/\//.test(cropText) &&
    table.grid.every((r) => r.length <= 2)
  )
    return false
  // Citation prose may use volume, page range and a parenthesized year instead of semicolons.
  if (
    (cropText.match(/\d+,?\s+\d+[–-]\d+\s*\((?:19|20)\d{2}\)/g) ?? []).length >= 2 &&
    /\bet al\b/i.test(cropText) &&
    table.grid.every((r) => r.length <= 2)
  )
    return false
  // Small fragments of a bibliography may contain only one citation. Require
  // multiple complete journal references in the source and no numeric columns.
  const journalReference = /\b(?:19|20)\d{2}\s*;\s*\d+(?:\(\d+\))?\s*:\s*\d+/g
  const journalCitations = (cropText.match(journalReference) ?? []).length
  if (
    journalCitations >= 3 &&
    table.issues?.includes('text-crosses-crop-boundary') &&
    table.grid.every((row) => row.length <= 3) &&
    table.grid.every((row) =>
      row.filter((text) => measurement(text)).every((text) => /^\d{1,3}$/.test(text.trim()))
    ) &&
    table.grid.filter((row) => row.some((text) => words(text) >= 20)).length >= 2
  )
    return false
  if (
    table.grid.length <= 3 &&
    table.grid.every((r) => r.length <= 3) &&
    (sourceText.match(journalReference) ?? []).length >= 3 &&
    journalReference.test(cropText) &&
    /\bet al\b/i.test(cropText) &&
    !table.grid.some((r) => r.some((c) => /^[-−+]?\d+(?:\.\d+)?(?:\s*\([^)]*\))?$/.test(c.trim())))
  )
    return false

  if (
    /Updated version/i.test(sourceText) &&
    /Reprints and/i.test(sourceText) &&
    /Permissions/i.test(sourceText) &&
    /(?:most recent (?:version|supplemental material)|free email-alerts)/i.test(cropText)
  )
    return false
  if (
    /Search (?:profile|strategy)/i.test(sourceText) &&
    (cropText.match(/\d+\s+(?:OR|AND)\s+\d+/g) ?? []).length >= 2 &&
    table.grid.every((row) => row.length <= 2)
  )
    return false
  // Structured abstracts align section labels with prose, not measurements.
  const abstractLabels =
    /^(?:background|purpose|objectives?|patients and methods|methods|results|conclusions?)\s*:?$/i
  const sections = pageItems.filter((item) => abstractLabels.test(item.text.trim()))
  if (
    sections.length >= 3 &&
    sections.some((item) => /conclusion/i.test(item.text)) &&
    table.grid.every((row) => row.length <= 3) &&
    table.grid.some((row) => row.some((text) => text.length > 100)) &&
    sections.some((item) => inside(table.cropRect, item))
  )
    return false
  if (
    /\b(?:Tel\.|Telephone|Fax)\s*:/i.test(cropText) &&
    /\S+@\S+/.test(cropText) &&
    !table.grid.some(
      (row) => row.filter((text) => /^[-+−]?\d+(?:\.\d+)?$/.test(text.trim())).length >= 2
    )
  )
    return false
  if (
    /ARTICLE TOOLS/i.test(cropText) &&
    /PERMISSIONS/i.test(cropText) &&
    /https?:\/\//.test(cropText)
  )
    return false
  if (
    /Email alerting service/i.test(cropText) &&
    /Receive free email alerts/i.test(cropText) &&
    /https?:\/\//.test(cropText)
  )
    return false
  // R/knitr console output is preformatted statistical text, not a predicted
  // cell grid. Keep it in the original PDF instead of publishing a broken grid.
  if (pageItems.filter((i) => /^##/.test(i.text.trim())).length >= 3) return false
  if (/\bAbstract\b/i.test(cropText) && /\bK\s*E\s*Y\s*W\s*O\s*R\s*D\s*S\b/i.test(sourceText))
    return false
  if (
    (cropText.match(/\b(?:19|20)\d{2}\s*;/g) ?? []).length >= 3 &&
    /\bet al\b/i.test(cropText) &&
    !table.grid.some((r) => r.filter((c) => /^\d+(?:\.\d+)?$/.test(c.trim())).length >= 2)
  )
    return false
  if (
    table.grid.length <= 4 &&
    table.grid.every((r) => r.length >= 2) &&
    /\b(?:ethics committee|ethics decision|ethics decisi-)\b/i.test(cropText) &&
    /\b(?:approval|approved)\b/i.test(sourceText)
  )
    return false
  if (
    /(?:通讯作者|通訊作者)/.test(compactText) &&
    /(?:收到|收稿|修订|接受|电子邮[件箱]|電子郵件|orcid\.org)/i.test(compactText)
  )
    return false
  if (
    table.grid[0]?.length >= 2 &&
    (compactText.match(/\p{Script=Han}/gu) ?? []).length > 30 &&
    (/(?:参考文献|參考文獻|orcid\.org)/i.test(compactText) ||
      (compactText.match(/(?:19|20)\d{2}[；;年]/g) ?? []).length >= 2)
  )
    return false
  if (
    (/\bPII\s*:/i.test(cropText) ||
      (cropText.match(/\b(?:Received|Revised|Accepted) Date:/g) ?? []).length >= 2) &&
    /\bDOI\s*:/i.test(cropText) &&
    /\b(?:Reference|To appear in)\s*:/i.test(cropText)
  )
    return false
  if (
    /\S+@\S+/.test(cropText) &&
    table.grid.length <= 6 &&
    table.grid.every(
      (row) =>
        row.length === 2 &&
        /^\d+$/.test(row[0]) &&
        /\b(?:Department|Division|University|Hospital|School)\b/i.test(row[1])
    )
  )
    return false
  if (
    (cropText.match(/\[\d+\]/g) ?? []).length >= 3 &&
    (cropText.match(/\b(?:19|20)\d{2}\s*[;:,]/g) ?? []).length >= 3 &&
    !table.grid.some(
      (row) => row.filter((cell) => /^[-−+]?\d+(?:\.\d+)?$/.test(cell.trim())).length >= 2
    )
  )
    return false
  if (
    /Edited by\s*:/i.test(sourceText) &&
    /Reviewed by\s*:/i.test(sourceText) &&
    /(?:Reviewed by|University|Correspondence|Received|doi\s*:)/i.test(cropText)
  )
    return false
  if (
    /Academic Editor\s*:/i.test(sourceText) &&
    /Received\s*:/i.test(sourceText) &&
    /(?:doi\.org|Keywords\s*:|Academic Editor)/i.test(cropText)
  )
    return false
  const columnText = pageItems
    .filter(
      (item) =>
        !table.cropRect ||
        (item.rect?.[0] >= table.cropRect[0] &&
          item.rect?.[2] <= table.cropRect[2] &&
          item.rect[1] <= table.cropRect[1] + (item.rect[3] - item.rect[1]) * 2 &&
          item.rect[3] >= table.cropRect[1] - (item.rect[3] - item.rect[1]) * 6)
    )
    .map((item) => item.text)
    .join(' ')
  if (
    /A\s*R\s*T\s*I\s*C\s*L\s*E\s+I\s*N\s*F\s*O/i.test(columnText) &&
    /A\s*B\s*S\s*T\s*R\s*A\s*C\s*T/i.test(columnText) &&
    /Keywords\s*:/i.test(cropText)
  )
    return false
  if (
    table.grid[0]?.length === 2 &&
    table.grid.some((row) => /^\s*\*\s*$/.test(row[0]) && /\S+@\S+/.test(row[1])) &&
    table.grid.some(
      (row) => /^\d+$/.test(row[0]) && /\b(?:Department|University|School)\b/i.test(row[1])
    )
  )
    return false
  if (
    /\b(?:Abbreviations|Nomenclature)\b/i.test(sourceText + ' ' + cropText) &&
    table.grid.length >= 4 &&
    table.grid.every(
      (row) => row.length >= 2 && row[0].length < 35 && row.slice(2).every((s) => !s.trim())
    ) &&
    table.grid.filter(
      ([key, value]) => /^[A-Z][A-Za-z\d-]{1,15}$/.test(key) && /\p{L}/u.test(value)
    ).length >= 4 &&
    !table.grid.some((row) => row.some((value) => /^[-−+]?\d+(?:\.\d+)?$/.test(value.trim())))
  )
    return false
  // Publishers lay out abbreviation keys in two parallel key/description lists.
  // Require the heading and repeated acronym pairs, not merely a four-column grid.
  if (
    /\bAbbreviations\b/i.test(cropText) &&
    table.grid.every((row) => row.length === 4) &&
    table.grid
      .flatMap((row) => [
        [row[0], row[1]],
        [row[2], row[3]]
      ])
      .filter(([key, value]) => /^[A-Z][A-Z\d–-]{1,15}$/.test(key) && /\p{L}/u.test(value))
      .length >= 6 &&
    !table.grid.some((row) => row.filter((value) => /^\d+(?:\.\d+)?$/.test(value)).length >= 2)
  )
    return false
  if (
    pageItems.some((item) => /^Affiliations\s*$/i.test(item.text)) &&
    (cropText.match(/\b(?:University|Hospital|College|Department)\b/g) ?? []).length >= 4 &&
    !table.grid.some(
      (row) => row.filter((value) => /^\d+(?:\.\d+)?$/.test(value.trim())).length >= 2
    )
  )
    return false
  if (
    table.grid.length >= 3 &&
    table.grid.filter((row) => row.some((text) => /^\[\d+\]$/.test(text.trim()))).length >=
      table.grid.length * 0.7 &&
    /(?:Data availability|Informed consent)/i.test(cropText)
  )
    return false
  if (
    populatedRows.filter((n) => n === 0).length >= table.grid.length / 2 &&
    table.grid.some((row) => row.some((text) => /\bFig\.\s*\d/.test(text)))
  )
    return false
  // Parallel correspondence blocks are metadata even when addresses contain numbers.
  if (
    /\bCorresponding author[.:]/i.test(cropText) &&
    /\bE-?mail(?: address)?\s*:/i.test(cropText) &&
    /\S+@\S+/.test(cropText) &&
    /\b(?:Department|University|Hospital|Oncology|Therapy)\b/i.test(cropText) &&
    !table.grid.some(
      (row) => row.filter((value) => /^\d+(?:\.\d+)?$/.test(value.trim())).length >= 2
    )
  )
    return false
  // Some journals print author initials and years without DOI links. Require
  // repeated citation anchors, volume/page ranges and long prose, not bare dates.
  if (
    table.grid.every((row) => row.length <= 3) &&
    (cropText.match(/\b[A-Z]{1,3}\s+(?:19|20)\d{2}\b/g) ?? []).length >= 3 &&
    (cropText.match(/\b\d+\s+\d+[–-]\d+/g) ?? []).length >= 2 &&
    table.grid.flat().filter((text) => text.split(/\s+/).length >= 8).length >= 3 &&
    !table.grid.some(
      (row) => row.filter((value) => /^\d+(?:\.\d+)?$/.test(value.trim())).length >= 2
    )
  )
    return false
  // Author-year reference lists may have no numbered margin. Repeated DOI
  // anchors and publication years distinguish them from uncaptained data.
  if (
    table.grid.every((row) => row.length <= 3) &&
    (cropText.match(/\bdoi\s*:\s*10\./gi) ?? []).length >= 3 &&
    (cropText.match(/\b(?:19|20)\d{2}\b/g) ?? []).length >= 3 &&
    /\bet al\b/i.test(cropText) &&
    !table.grid.some(
      (row) => row.filter((value) => /^\d+(?:\.\d+)?$/.test(value.trim())).length >= 2
    )
  )
    return false
  if (
    table.grid[0]?.length >= 2 &&
    table.grid[0].every((_, column) => {
      const text = table.grid.map((row) => row[column]).join(' ')
      return /\bE-?mail\s*:/i.test(text) && /\b(?:Tel\.?|Telephone|Fax)\s*:/i.test(text)
    })
  )
    return false
  // Inspect source citation anchors as well as the reconstructed grid: a poor
  // grid can absorb the numbers into author names or lose whole reference rows.
  const cropItems = pageItems.filter((item) => table.cropRect && inside(table.cropRect, item))
  const possibleNumbers = cropItems.filter(
    (item) =>
      /^\d+$/.test(item.text.trim()) &&
      item.rect[0] < table.cropRect[0] + (table.cropRect[2] - table.cropRect[0]) * 0.12
  )
  const numberLeft = Math.min(...possibleNumbers.map((item) => item.rect[0]))
  const marginNumbers = possibleNumbers
    .filter((item) => Math.abs(item.rect[0] - numberLeft) < item.height * 0.3)
    .sort((a, b) => a.baseline - b.baseline)
  if (
    marginNumbers.length >= 5 &&
    marginNumbers.every(
      (item, i) => !i || Number(item.text) === Number(marginNumbers[i - 1].text) + 1
    ) &&
    marginNumbers.filter((number) => {
      const text = cropItems
        .filter(
          (item) =>
            item.horizontal &&
            item.rect[0] > number.rect[2] &&
            item.height >= number.height * 0.9 &&
            Math.abs(item.baseline - number.baseline) < number.height * 0.4
        )
        .sort((a, b) => a.rect[0] - b.rect[0])
        .map((item) => item.text)
        .join(' ')
      return text.length >= 40 && text.split(/\s+/).length >= 8
    }).length >=
      marginNumbers.length * 0.6
  )
    return false
  const possibleAnchors = cropItems.filter((item) => /^\d+\.$/.test(item.text.trim()))
  const anchorLeft = Math.min(...possibleAnchors.map((item) => item.rect[0]))
  const citationAnchors = possibleAnchors
    .filter((item) => Math.abs(item.rect[0] - anchorLeft) < item.height * 0.5)
    .sort((a, b) => a.baseline - b.baseline)
  if (
    citationAnchors.length >= 3 &&
    citationAnchors.every(
      (item, i) =>
        !i ||
        (Math.abs(item.rect[0] - citationAnchors[0].rect[0]) < item.height &&
          Number.parseInt(item.text) === Number.parseInt(citationAnchors[i - 1].text) + 1)
    ) &&
    (
      cropItems
        .map((item) => item.text)
        .join(' ')
        .match(/\b(?:19|20)\d{2}\./g) ?? []
    ).length >= 3
  )
    return false
  // Publisher disclosure forms contain aligned fields and checklists, not research
  // tables. Require the template marker and a form section, not common row labels.
  if (
    pageItems.some((item) =>
      /^nature(?: portfolio| research)?\s*\|\s*(?:life sciences )?reporting summary$/i.test(
        item.text.trim()
      )
    ) &&
    pageItems.some((item) =>
      /^(?:Experimental design|Field-specific reporting|Life sciences study design|Reporting for specific materials, systems and methods)$/i.test(
        item.text.trim()
      )
    )
  )
    return false
  if (table.issues.includes('overlapping-predicted-columns')) return false
  // Parallel prose columns also produce confident multi-column predictions. A crop cutting
  // through paragraph text, with long prose in most cells of most rows, lacks row evidence.
  // Keep captioned tables and tables with short row labels/numeric or sequence values.
  if (
    (table.unassigned ?? []).some((text) => /^abbreviations\s*:?$/i.test(text.trim())) &&
    table.grid.length >= 3 &&
    table.grid.every(
      (row) => row.length === 2 && /^[\p{L}\d‒–-]+$/u.test(row[0]) && words(row[1]) >= 2
    )
  )
    return false
  const publicationSidebar = table.grid.map((row) => row[0] ?? '')
  if (
    publicationSidebar.some((text) => /^Received:\s+.*\b(?:19|20)\d{2}\b/i.test(text)) &&
    publicationSidebar.some((text) => /^Accepted:\s+.*\b(?:19|20)\d{2}\b/i.test(text)) &&
    publicationSidebar.some((text) => /^(?:Published online:|Check for updates)/i.test(text)) &&
    table.grid.some((row) => row.slice(1).some((text) => words(text) >= 60))
  )
    return false
  // Bibliography continuations may have no section heading. Their numbered entries
  // form a hanging-indent list, with publication years/author citations in prose.
  const referenceNumber = (row) => row[0]?.trim().match(/^[-–−]?\s*(\d+)[.)]?(?:\s+\p{L}+)?$/u)?.[1]
  const numbered = table.grid.filter((row) => referenceNumber(row))
  if (
    numbered.length >= 3 &&
    numbered.length >= populatedRows.filter((count) => count >= 2).length * 0.7 &&
    numbered.every(
      (row, i) => !i || Number(referenceNumber(row)) > Number(referenceNumber(numbered[i - 1]))
    ) &&
    numbered.filter(
      (row, i) => i && Number(referenceNumber(row)) === Number(referenceNumber(numbered[i - 1])) + 1
    ).length >=
      (numbered.length - 1) * 0.7 &&
    numbered.filter((row) => words(row.slice(1).join(' ')) >= 12).length >= numbered.length * 0.7 &&
    (
      [...numbered.flatMap((row) => row.slice(1)), ...(table.unassigned ?? [])]
        .join(' ')
        .match(/(?:\bet al\.|\((?:19|20)\d{2}\)|\b(?:19|20)\d{2};\d)/g) ?? []
    ).length >= 3 &&
    !table.grid
      .slice(0, table.grid.indexOf(numbered[0]))
      .some((row) => row.filter((text) => /\p{L}/u.test(text)).length >= 2)
  )
    return false
  // Captionless reference pages can be mistaken for two-column tables when
  // bracketed citation keys occupy the first model column. Require a dense
  // sequence of citation keys, reference-length prose, and bibliography
  // anchors; measured or captioned tables remain eligible.
  const citationKeyRows = table.grid.filter((row) =>
    /^\s*\[[^\]]{2,16}\](?:\s+\[[^\]]{2,16}\])?\s*$/u.test(row[0]?.trim() ?? '')
  )
  const citationProseRows = citationKeyRows.filter((row) => words(row.slice(1).join(' ')) >= 8)
  const citationText = [
    ...citationKeyRows.flatMap((row) => row.slice(1)),
    ...(table.unassigned ?? [])
  ].join(' ')
  if (
    !caption &&
    table.grid.flat().filter(measurement).length <= 2 &&
    table.grid.length >= 8 &&
    citationKeyRows.length >= Math.max(8, table.grid.length * 0.55) &&
    citationProseRows.length >= citationKeyRows.length * 0.65 &&
    (citationText.match(/(?:\b(?:19|20)\d{2}\b|\bet al\.|\barXiv:|\bdoi\b|https?:\/\/)/gi) ?? [])
      .length >= 3
  )
    return false
  // Short references-page tails can contain only four or five rows after a
  // page crop, so the long-list guard above intentionally does not cover
  // them.  Keep the fallback strict: every row must carry a bracketed
  // citation key and reference-length prose, with several publication
  // anchors.  Captioned or measured tables continue through this path.
  if (
    !caption &&
    table.grid.length <= 7 &&
    table.grid.flat().filter(measurement).length <= 2 &&
    citationKeyRows.length >= 4 &&
    citationKeyRows.length >= table.grid.length * 0.75 &&
    citationProseRows.length >= citationKeyRows.length * 0.75 &&
    (citationText.match(/(?:\b(?:19|20)\d{2}\b|\bet al\.|\barXiv:|\bdoi\b|https?:\/\/)/gi) ?? [])
      .length >= 3
  )
    return false
  // Boxed pseudocode is unstructured algorithm content, not a data grid.
  // Require an explicit Algorithm heading and numbered instruction rows so a
  // measured table with a numbered first column remains eligible.
  const algorithmHeading = [
    ...(table.grid[0] ?? []).filter(Boolean),
    ...(table.unassigned ?? [])
  ].some((text) => /^\s*Algorithm\b/i.test(text.trim()))
  const algorithmRows = table.grid
    .slice(1)
    .filter((row) => /^\s*\d+[.:)]\s*/u.test(row.find((text) => text.trim())?.trim() ?? ''))
  if (
    !caption &&
    table.grid.flat().filter(measurement).length === 0 &&
    algorithmHeading &&
    algorithmRows.length >= 3 &&
    algorithmRows.length >= (table.grid.length - 1) * 0.6
  )
    return false
  // Some boxed procedures omit the literal Algorithm heading. A numbered
  // instruction lane with repeated control-flow vocabulary is still
  // pseudocode, not a data grid; require several independent witnesses so a
  // labelled prose table remains eligible.
  const numberedProcedureRows = table.grid.filter((row) =>
    /^\s*\d+(?:\s+\d+)?\s*$/u.test(row.find((text) => text.trim())?.trim() ?? '')
  )
  const procedureRows = table.grid.filter((row) =>
    /\b(?:while|if|then|for\b[^\n]{0,60}\bdo|plan|sub-?goals?|node\s*\(|re-?enter)\b/iu.test(
      row.join(' ')
    )
  )
  if (
    !caption &&
    table.grid.flat().filter(measurement).length === 0 &&
    numberedProcedureRows.length >= 3 &&
    procedureRows.length >= 3 &&
    procedureRows.length >= table.grid.length * 0.5
  )
    return false
  // A ruled article-info/abstract panel is not a table, even when the whole prose
  // fits inside the crop. Require both the keyword sidebar and a nearby ABSTRACT
  // heading. A heading clipped by the upper edge also needs its paired ARTICLE
  // INFO label, so a cell mentioning an abstract remains valid.
  const keywordColumn = table.grid[0]?.findIndex((text) => /^key\s*words?\s*:?$/i.test(text.trim()))
  if (
    keywordColumn >= 0 &&
    table.grid.some((row) =>
      row.some((text, column) => column !== keywordColumn && words(text) >= 80)
    ) &&
    pageItems.some(
      (item) =>
        /^abstract:?$/i.test(item.text.replace(/\s+/g, '')) &&
        table.cropRect &&
        item.rect[0] >= table.cropRect[0] &&
        item.rect[2] <= table.cropRect[2] &&
        ((item.rect[3] <= table.cropRect[1] &&
          table.cropRect[1] - item.rect[3] <= 4 * (item.rect[3] - item.rect[1])) ||
          (Math.abs(item.rect[1] - table.cropRect[1]) <= item.rect[3] - item.rect[1] &&
            pageItems
              .filter(
                (other) =>
                  other.rect[0] >= table.cropRect[0] &&
                  other.rect[2] < item.rect[0] &&
                  Math.abs(other.rect[3] - item.rect[3]) < (item.rect[3] - item.rect[1]) * 0.5
              )
              .sort((a, b) => a.rect[0] - b.rect[0])
              .map((other) => other.text.replace(/\s+/g, ''))
              .join('')
              .toLowerCase() === 'articleinfo'))
    )
  )
    return false
  // A standalone bibliography heading plus a numbered, linked citation is prose,
  // even when the detector splits just one reference across several short columns.
  // A References column beside other headers is not a section heading.
  if (
    table.issues.includes('text-crosses-crop-boundary') &&
    table.grid.some(
      (row) =>
        row.filter((text) => text.trim()).length === 1 &&
        row.some((text) => /^(?:references|bibliography)\s*:?$/i.test(text.trim()))
    ) &&
    table.grid.some((row) =>
      /^\s*(?:\d+[.)]|\[\d+\])\s+\p{L}/u.test(row.find((text) => text.trim()) ?? '')
    ) &&
    [...table.grid.flat(), ...(table.unassigned ?? [])].some((text) => /https?:\/\//i.test(text))
  )
    return false
  const mostlyUnassigned =
    words((table.unassigned ?? []).join(' ')) > words(table.grid.flat().join(' '))
  // A predicted divider through an ordinary paragraph has word-sized gaps on
  // both sides, not a stable column gutter. Require repeated prose rows and actual
  // source positions, so compact numeric tables and captioned prose tables survive.
  // Whole source lines can cross both the crop edge and its first divider.
  // Two such prose lines prove that a narrow three-column prediction cuts
  // ordinary paragraphs; do not reject captioned tables or numeric records.
  if (
    table.cropRect &&
    table.issues.includes('text-crosses-crop-boundary') &&
    table.grid.every((row) => row.length === 3 && !row.some(measurement)) &&
    (table.cells ?? []).filter(
      (cell) =>
        cell.column === 0 &&
        cell.colSpan === 1 &&
        pageItems.some(
          (item) =>
            item.rect &&
            words(item.text) >= 5 &&
            inside(cell.rect, item) &&
            item.rect[0] < table.cropRect[0] - item.height &&
            item.rect[2] > cell.rect[2] + item.height
        )
    ).length >= 2
  )
    return false
  // A crop starting inside a native prose column can leave an unrelated
  // paragraph or list marker in its second model column. Reassemble only
  // word-spaced source lines, and require repeated long lines crossing the
  // left crop edge; isolated overhanging labels remain eligible.
  if (
    table.cropRect &&
    table.issues.includes('text-crosses-crop-boundary') &&
    table.grid.every((row) => row.length === 2 && !row.some(measurement))
  ) {
    const [left, top, right, bottom] = table.cropRect
    const lines = []
    for (const item of pageItems
      .filter((i) => i.horizontal && i.rect[1] >= top && i.rect[3] <= bottom)
      .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
      const line = lines.find((g) => Math.abs(g[0].baseline - item.baseline) < item.height * 0.3)
      if (line) line.push(item)
      else lines.push([item])
    }
    const crossed = lines.filter((line) => {
      const chunks = []
      for (const item of line.sort((a, b) => a.rect[0] - b.rect[0])) {
        const prior = chunks.at(-1)
        if (prior && item.rect[0] - prior.at(-1).rect[2] < item.height) prior.push(item)
        else chunks.push([item])
      }
      return chunks.some(
        (g) =>
          g[0].rect[0] < left - 1 &&
          g.at(-1).rect[2] > left + (right - left) * 0.6 &&
          g.at(-1).rect[2] < right - g[0].height * 2 &&
          words(g.map((i) => i.text).join(' ')) >= 6
      )
    })
    if (crossed.length >= 2 && crossed.length >= lines.length * 0.6) return false
  }
  // A detector can split a long paragraph into one populated cell per row
  // while leaving the neighboring model column empty. Without a caption or
  // measured values this is unstructured page prose, not a table.
  if (
    !caption &&
    table.issues.includes('text-crosses-crop-boundary') &&
    table.grid.length >= 8 &&
    table.grid.filter((row) => row.filter((text) => text.trim()).length === 1).length >=
      table.grid.length * 0.75 &&
    table.grid.filter(
      (row) => row.filter((text) => text.trim()).length === 1 && words(row.join(' ')) >= 4
    ).length >=
      table.grid.length * 0.75 &&
    !table.grid.some((row) => row.some(measurement))
  )
    return false
  const proseRecords = table.grid.filter((row) => row.filter((text) => text.trim()).length >= 2)
  const dividedProse =
    proseRecords.length >= 2 &&
    table.grid.every(
      (row) => row.filter((text) => text.trim()).length <= 2 && !row.some(measurement)
    ) &&
    proseRecords.filter(
      (row) =>
        row.some((text) => /\p{L}/u.test(text)) && row.reduce((n, text) => n + words(text), 0) >= 7
    ).length >=
      proseRecords.length * 0.6
  if (dividedProse) {
    const crossed = (table.cells ?? []).filter(
      (cell) =>
        cell.column === 0 &&
        cell.colSpan === 1 &&
        pageItems.some(
          (a) =>
            a.rect &&
            inside(cell.rect, a) &&
            pageItems.some(
              (b) =>
                b.rect &&
                (b.rect[0] + b.rect[2]) / 2 >= cell.rect[2] &&
                b.rect[0] - a.rect[2] >= 0 &&
                b.rect[0] - a.rect[2] < a.height * 1.5 &&
                Math.abs(a.baseline - b.baseline) < a.height * 0.35
            )
        )
    )
    if (crossed.length >= 2 && crossed.length >= proseRecords.length * 0.6) return false
    // A detector can start in the tail of the neighboring prose column. The
    // apparent stub continues text outside the crop rather than naming a row.
    const paragraphTails = (table.cells ?? []).filter(
      (cell) =>
        table.cropRect &&
        cell.column === 0 &&
        cell.colSpan === 1 &&
        pageItems.some(
          (item) =>
            item.rect &&
            inside(cell.rect, item) &&
            pageItems.some(
              (before) =>
                before.rect &&
                before.rect[0] < table.cropRect[0] - item.height * 2 &&
                before.rect[2] <= item.rect[0] &&
                item.rect[0] - before.rect[2] < item.height * 1.5 &&
                Math.abs(before.baseline - item.baseline) < item.height * 0.35 &&
                /\p{L}/u.test(before.text)
            )
        )
    )
    if (paragraphTails.length >= 2 && paragraphTails.length >= proseRecords.length * 0.6)
      return false
  }
  const proseRows = table.grid.filter((row) => {
    const counts = row.map(words)
    return (
      row.length >= 2 &&
      (counts.every((count) => count >= 6) ||
        (mostlyUnassigned &&
          !row.some((text) => /^\s*[<>≤≥~±+−-]?(?:\d|[.,]\d)/u.test(text)) &&
          // A detached citation number is a prose continuation, not a numeric data column.
          counts.every((count, index) => count >= 2 || /^\[\d+\]$/.test(row[index].trim())) &&
          counts.some((count) => count >= 6) &&
          counts.reduce((sum, count) => sum + count, 0) >= 8))
    )
  })
  if (
    table.issues.includes('text-crosses-crop-boundary') &&
    proseRows.length > table.grid.length / 2
  )
    return false
  return populatedRows.filter((count) => count >= 2).length >= 2
}
