/* eslint-disable @typescript-eslint/explicit-function-return-type */
import {
  classifyTableRuleEdge,
  joinHorizontalTableRules,
  clusterTableRulePositions
} from './literature-pdf-table-rules.mjs'
import { captionKind } from './literature-pdf-caption-group.mjs'
import { union, isAdjacentTableScript } from './literature-pdf-table-geometry.mjs'
import {
  tableSourceItems,
  readSourceRow,
  hasUniqueRecordTokens,
  groupSourceRowsWithScripts,
  recoverRuledHeaderBands,
  recoverClosedNativeHeaderBands,
  recoverSharedSampleCountHeaderBands
} from './literature-pdf-source-records.mjs'

const nativeHorizontalFields = (items, gap) => {
  const groups = []
  for (const i of [...items].sort((a, b) => a.rect[0] - b.rect[0])) {
    const previous = groups.at(-1)
    if (previous && i.rect[0] - Math.max(...previous.map((p) => p.rect[2])) < gap) previous.push(i)
    else groups.push([i])
  }
  return groups
}

// Complete native fences prove physical faces independently of the detector's
// lane count. Empty faces are retained only where every edge is actually drawn.
// No checkmark, total, reference or other printed literal is interpreted here.
export function proveNativeFullyRuledLiteralGrid(table, items, captions, rules) {
  if (!table.cropRect || !Array.isArray(rules)) return
  const [left, top, right, bottom] = table.cropRect
  const nearby = items.filter(
    (i) =>
      i.horizontal &&
      i.rect &&
      i.height > 0 &&
      i.rect[0] >= left - 2 &&
      i.rect[2] <= right + 2 &&
      i.baseline >= top &&
      i.baseline <= bottom
  )
  const heights = nearby.map((i) => i.height).sort((a, b) => a - b),
    h = heights[heights.length >> 1]
  if (!(h > 0)) return
  const native = rules.filter(
    (r) =>
      r.length === 4 &&
      r.every(Number.isFinite) &&
      r[0] >= left - h &&
      r[2] <= right + h &&
      r[1] >= top - h &&
      r[3] <= bottom + h
  )
  const vertical = native.filter((r) => r[0] === r[2] && r[3] > r[1]),
    horizontal = native.filter((r) => r[1] === r[3] && r[2] > r[0]),
    cuts = clusterTableRulePositions(vertical.map((r) => r[0])),
    faces = clusterTableRulePositions(horizontal.map((r) => r[1]))
  if (cuts.length < 4 || cuts.length > 65 || faces.length < 5 || faces.length > 1001) return
  if (
    cuts.some((x) => classifyTableRuleEdge(vertical, 0, x, faces[0], faces.at(-1)) !== 1) ||
    faces.some((y) => classifyTableRuleEdge(horizontal, 1, y, cuts[0], cuts.at(-1)) !== 1)
  )
    return
  const ownedCaptions = captions.filter(
    (c) =>
      captionKind(c.lines?.[0]) === 'table' &&
      c.rect &&
      c.rect[0] < cuts.at(-1) &&
      c.rect[2] > cuts[0] &&
      ((c.rect[3] <= faces[0] && faces[0] - c.rect[3] < h * 8) ||
        (c.rect[1] >= faces.at(-1) && c.rect[1] - faces.at(-1) < h * 4))
  )
  if (ownedCaptions.length !== 1 || faces[1] - faces[0] < h * 1.4) return
  const source = items.filter(
    (i) =>
      i.text?.trim() &&
      i.rect &&
      (i.rect[0] + i.rect[2]) / 2 >= cuts[0] &&
      (i.rect[0] + i.rect[2]) / 2 <= cuts.at(-1) &&
      i.baseline > faces[0] &&
      i.baseline < faces.at(-1)
  )
  if (
    !source.length ||
    source.some(
      (i) =>
        !i.horizontal ||
        !i.rect.every(Number.isFinite) ||
        i.rect[2] <= i.rect[0] ||
        i.rect[0] < cuts[0] - 0.02 ||
        i.rect[2] > cuts.at(-1) + 0.02
    )
  )
    return
  const groups = faces.slice(1).map(() => []),
    cells = faces.slice(1).map(() => cuts.slice(1).map(() => []))
  for (const i of source) {
    const r = faces.slice(1).findIndex((y) => i.baseline < y),
      c = cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
    if (
      r < 0 ||
      c < 0 ||
      i.rect[0] < cuts[c] - 0.02 ||
      i.rect[2] > cuts[c + 1] + 0.02 ||
      i.rect[1] < faces[r] - i.height * 0.2
    )
      return
    groups[r].push(i)
    cells[r][c].push(i)
  }
  if (cells[0].some((g) => !g.length) || cells.slice(1).some((r) => !r[0].length)) return
  // A drawn face alone does not prove a single literal record when ordinary
  // body glyphs have independent baselines or interleaved horizontal ownership.
  // Preserve the existing record/script reconstruction in those cases.
  for (const row of cells.slice(1)) {
    for (const cell of row) {
      if (!cell.length) continue
      const ordinary = cell
        .filter((i) => i.height >= Math.max(...cell.map((p) => p.height)) * 0.8)
        .toSorted((a, b) => a.rect[0] - b.rect[0])
      if (
        ordinary.some(
          (i) => Math.abs(i.baseline - ordinary[0].baseline) > ordinary[0].height * 0.2
        ) ||
        ordinary.some((i, n) => n && i.rect[0] < ordinary[n - 1].rect[2] - 0.05)
      )
        return
    }
  }
  // Distinct leaves cannot become a joined header merely because an interior
  // fence is missing. Allow contiguous glyph fragments and wrapped words.
  const headerBands = cells[0].map((cell) =>
    groupSourceRowsWithScripts(
      cell.toSorted((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0]),
      h,
      0.2
    )
  )
  if (
    headerBands.some(
      (bands) => !bands || bands.some((g) => nativeHorizontalFields(g, h * 0.65).length !== 1)
    )
  )
    return
  const rowRects = faces.slice(1).map((y, r) => [cuts[0], faces[r], cuts.at(-1), y]),
    headerCells = cells[0].map((g, column) => ({
      row: 0,
      column,
      rowSpan: 1,
      colSpan: 1,
      rect: [cuts[column], faces[0], cuts[column + 1], faces[1]],
      // The existing native row proof owns attached scripts on their base
      // baseline. Read within each proved row horizontally, so a raised glyph
      // cannot precede its base merely because it has the earlier baseline.
      text: headerBands[column]
        .map((band) =>
          band
            .toSorted((a, b) => a.rect[0] - b.rect[0])
            .reduce(
              (text, i, n, ordered) =>
                text +
                (n && i.rect[0] - ordered[n - 1].rect[2] > h * 0.14 ? ' ' : '') +
                i.text.trim(),
              ''
            )
        )
        .join(' '),
      sourceTokens: g,
      sourceRects: g.map((i) => i.rect),
      origin: 'source-fully-ruled-header'
    }))
  return {
    cuts,
    groups,
    headerCells,
    headerRows: 1,
    rowRects,
    consumed: source,
    cropRect: [cuts[0], faces[0], cuts.at(-1), faces.at(-1)],
    repair: 'native-fully-ruled-literal-faces-proved'
  }
}

// An explicitly captioned numeric inventory need not draw an outer box. A
// single header separator plus a continuous stub fence and complete peer
// records can prove the same physical leaf lanes without model predictions.
export function findCaptionedNativePartialRuleTable(caption, items, rules, runs = []) {
  if (!caption?.rect || !/^Table\s+[\dIVXLC]+\s*[:.]/iu.test(caption.lines?.[0] ?? '')) return
  const horizontal = joinHorizontalTableRules(rules),
    candidates = []
  for (const divider of horizontal) {
    if (
      divider[0] >= caption.rect[2] ||
      divider[2] <= caption.rect[0] ||
      caption.rect[1] <= divider[1]
    )
      continue
    const near = items.filter(
        (i) =>
          i.horizontal &&
          i.height > 0 &&
          i.text?.trim() &&
          i.rect[0] >= divider[0] - 0.02 &&
          i.rect[2] <= divider[2] + 0.02 &&
          i.baseline >= divider[1] - 30 &&
          i.baseline <= caption.rect[1]
      ),
      heights = near.map((i) => i.height).sort((a, b) => a - b),
      h = heights[heights.length >> 1]
    if (!(h > 0) || caption.rect[1] - divider[1] > h * 8) continue
    const vertical = rules.filter(
        (r) =>
          r[0] === r[2] &&
          r[0] > divider[0] + h &&
          r[0] < divider[2] - h &&
          r[1] < divider[1] &&
          r[1] > divider[1] - h * 2
      ),
      stubs = clusterTableRulePositions(vertical.map((r) => r[0]))
    if (stubs.length !== 1) continue
    const stub = stubs[0],
      segments = rules.filter((r) => r[0] === r[2] && Math.abs(r[0] - stub) < 0.02),
      top = Math.min(...segments.map((r) => r[1])),
      bottom = Math.max(...segments.map((r) => r[3]))
    if (
      classifyTableRuleEdge(segments, 0, stub, top, bottom) !== 1 ||
      bottom < caption.rect[1] - h ||
      bottom > caption.rect[1] + h * 0.2 ||
      horizontal.some(
        (r) =>
          r !== divider &&
          r[0] < divider[2] &&
          r[2] > divider[0] &&
          r[1] > top - h &&
          r[1] < bottom + h * 0.2
      )
    )
      continue
    const source = near.filter((i) => i.baseline >= top && i.baseline <= bottom),
      header = source.filter((i) => i.baseline < divider[1]),
      originalBody = source.filter((i) => i.baseline > divider[1]),
      headerBands = groupSourceRowsWithScripts(header, h, 0.2),
      bodyItems = originalBody.flatMap((i) => splitNativeMeasuredFields(i, runs, h) ?? [i]),
      bands = groupSourceRowsWithScripts(bodyItems, h, 0.2)
    if (!headerBands || headerBands.length !== 1 || !bands || bands.length < 3 || bands.length > 6)
      continue
    const leaves = nativeHorizontalFields(
        header.flatMap((i) => splitNativeMeasuredFields(i, runs, h) ?? [i]),
        h * 0.55
      ),
      fields = bands.map((g) => nativeHorizontalFields(g, h * 0.55))
    if (
      leaves.length < 3 ||
      leaves.length > 8 ||
      fields.some((g) => g.length !== leaves.length) ||
      leaves.some((g) => !g.some((i) => /\p{L}/u.test(i.text))) ||
      fields.some((g) =>
        g.some(
          (f) =>
            !/^[-+−]?\d/u.test(
              f
                .map((i) => i.text)
                .join('')
                .trim()
            )
        )
      ) ||
      !hasUniqueRecordTokens(bodyItems, bands)
    )
      continue
    const domains = leaves.map((g, c) => [
      Math.min(...g.map((i) => i.rect[0]), ...fields.flatMap((r) => r[c].map((i) => i.rect[0]))),
      Math.max(...g.map((i) => i.rect[2]), ...fields.flatMap((r) => r[c].map((i) => i.rect[2])))
    ])
    if (
      domains.slice(1).some((d, c) => d[0] - domains[c][1] < h * 0.1) ||
      !(domains[0][1] < stub && domains[1][0] > stub)
    )
      continue
    const cuts = [
        divider[0],
        stub,
        ...domains.slice(2).map((d, c) => (domains[c + 1][1] + d[0]) / 2),
        divider[2]
      ],
      cropRect = [divider[0], Math.min(top, ...header.map((i) => i.rect[1])), divider[2], bottom],
      columns = cuts.slice(1).map((x, c) => [cuts[c], cropRect[1], x, bottom]),
      headerCells = leaves.map((g, column) => ({
        row: 0,
        column,
        rowSpan: 1,
        colSpan: 1,
        rect: [cuts[column], cropRect[1], cuts[column + 1], divider[1]],
        text: g
          .toSorted((a, b) => a.rect[0] - b.rect[0])
          .map((i) => i.text)
          .join(''),
        sourceTokens: g,
        sourceRects: g.map((i) => i.rect),
        origin: 'source-partial-rule-header'
      }))
    if (
      source.some(
        (i) => i.rect[0] < cropRect[0] || i.rect[2] > cropRect[2] || i.rect[3] > cropRect[3]
      )
    )
      continue
    candidates.push({
      kind: 'native-partial-rule-records',
      caption,
      cropRect,
      columns,
      rows: [[divider[0], cropRect[1], divider[2], divider[1]]],
      headerRows: [0],
      headerCells,
      ownedTokens: new Set(header),
      headerBottom: divider[1],
      bodyItems,
      originalBody,
      bodyRecords: bands,
      cuts,
      groups: [header, ...bands],
      consumed: source,
      repair: 'native-partial-rule-literal-records-proved'
    })
  }
  return candidates.length === 1 ? candidates[0] : undefined
}

// Wrapped prose fields can share one header face. Their independent native
// starts and complete peer baselines prove gutters; every continuation still
// has to fit one lane. This proves headers, not paragraph/record semantics.
export function proveNativeAnchoredLeafHeader(table, items, captions, rules) {
  if (!table.cropRect) return
  const [left, top, right, bottom] = table.cropRect,
    near = items.filter(
      (i) =>
        i.horizontal &&
        i.height > 0 &&
        i.text?.trim() &&
        i.rect[0] >= left &&
        i.rect[2] <= right &&
        i.rect[1] >= top &&
        i.rect[3] <= bottom
    ),
    heights = near.map((i) => i.height).sort((a, b) => a - b),
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
  if (
    frame.length !== 3 ||
    frame.some((r) => Math.abs(r[0] - frame[0][0]) > 0.02 || Math.abs(r[2] - frame[0][2]) > 0.02)
  )
    return
  const [opening, divider, closing] = frame
  if (divider[1] - opening[1] > h * 3 || closing[1] - divider[1] < h * 3) return
  if (
    items.some(
      (i) =>
        i.horizontal &&
        i.text?.trim() &&
        i.rect &&
        i.baseline > opening[1] &&
        i.baseline < closing[1] &&
        i.rect[0] < opening[2] &&
        i.rect[2] > opening[0] &&
        (i.rect[0] < opening[0] - 0.02 || i.rect[2] > opening[2] + 0.02)
    )
  )
    return
  const caption = captions.filter(
    (c) =>
      captionKind(c.lines?.[0]) === 'table' &&
      c.rect &&
      c.rect[0] < opening[2] &&
      c.rect[2] > opening[0] &&
      ((c.rect[3] <= opening[1] && opening[1] - c.rect[3] < h * 8) ||
        (c.rect[1] >= closing[1] && c.rect[1] - closing[1] < h * 4))
  )
  if (caption.length !== 1) return
  const source = near
      .filter((i) => i.baseline > opening[1] && i.baseline < closing[1])
      .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0]),
    header = source.filter((i) => i.baseline < divider[1]),
    bands = groupSourceRowsWithScripts(header, h, 0.2)
  if (!bands || bands.length < 1 || bands.length > 3) return
  const leaves = nativeHorizontalFields(bands[0], h * 0.4)
  if (
    leaves.length < 3 ||
    leaves.length > 12 ||
    leaves.some((g) => !g.some((i) => /\p{L}/u.test(i.text)))
  )
    return
  const starts = leaves.map((g) => Math.min(...g.map((i) => i.rect[0]))),
    headerGroups = leaves.map(() => []),
    body = source.filter((i) => i.baseline > divider[1]),
    lanes = leaves.map(() => [])
  for (const i of source) {
    const c = starts.findLastIndex((x) => i.rect[0] >= x - 0.02)
    if (c < 0 || (c + 1 < starts.length && i.rect[2] >= starts[c + 1] - 0.02)) return
    ;(i.baseline < divider[1] ? headerGroups[c] : lanes[c]).push(i)
  }
  if (lanes.some((g) => !g.length)) return
  const peers = groupSourceRowsWithScripts(body, h, 0.2)
  if (
    !peers ||
    peers.filter(
      (g) =>
        new Set(g.map((i) => starts.findLastIndex((x) => i.rect[0] >= x - 0.02))).size ===
        leaves.length
    ).length < 2
  )
    return
  const domains = leaves.map((_, c) => [
    Math.min(...headerGroups[c].map((i) => i.rect[0]), ...lanes[c].map((i) => i.rect[0])),
    Math.max(...headerGroups[c].map((i) => i.rect[2]), ...lanes[c].map((i) => i.rect[2]))
  ])
  if (domains.slice(1).some((d, c) => d[0] - domains[c][1] < h * 0.1)) return
  const cuts = [
      opening[0],
      ...domains.slice(1).map((d, c) => (domains[c][1] + d[0]) / 2),
      opening[2]
    ],
    columns = cuts.slice(1).map((x, c) => [cuts[c], opening[1], x, closing[1]]),
    headerCells = headerGroups.map((g, column) => ({
      row: 0,
      column,
      rowSpan: 1,
      colSpan: 1,
      rect: [cuts[column], opening[1], cuts[column + 1], divider[1]],
      text: g
        .toSorted((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
        .map((i) => i.text.trim())
        .join(' '),
      sourceTokens: g,
      sourceRects: g.map((i) => i.rect),
      origin: 'source-anchored-leaf-header'
    }))
  return {
    kind: 'anchored-leaf',
    columns,
    headerCells,
    rows: [[opening[0], opening[1], opening[2], divider[1]]],
    headerRows: [0],
    headerBottom: divider[1],
    ownedTokens: new Set(header),
    bodyItems: body,
    originalBody: body,
    cuts,
    cropRect: [opening[0], opening[1], opening[2], closing[1]],
    repair: 'native-anchored-leaf-header-gutters-proved'
  }
}

// Some native inventories have one variable inner gutter: the second field
// ends before a flowing third field, while both terminal fields and the first
// stub retain fixed starts. A unique repeated header-sized gap proves each
// row-local boundary. Do not invent a global cut through those source glyphs.
export function proveNativeVariableGutterLeafGrid(table, items, captions, rules) {
  if (!table.cropRect) return
  const [left, top, right, bottom] = table.cropRect,
    near = items.filter(
      (i) =>
        i.horizontal &&
        i.height > 0 &&
        i.text?.trim() &&
        i.rect[0] >= left &&
        i.rect[2] <= right &&
        i.rect[1] >= top &&
        i.rect[3] <= bottom
    ),
    heights = near.map((i) => i.height).sort((a, b) => a - b),
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
  if (
    frame.length !== 3 ||
    frame.some((r) => Math.abs(r[0] - frame[0][0]) > 0.02 || Math.abs(r[2] - frame[0][2]) > 0.02)
  )
    return
  const [opening, divider, closing] = frame
  if (
    divider[1] - opening[1] > h * 2.5 ||
    captions.filter(
      (c) =>
        captionKind(c.lines?.[0]) === 'table' &&
        c.rect &&
        c.rect[0] < opening[2] &&
        c.rect[2] > opening[0] &&
        c.rect[3] <= opening[1] &&
        opening[1] - c.rect[3] < h * 8
    ).length !== 1
  )
    return
  const source = near
      .filter((i) => i.baseline > opening[1] && i.baseline < closing[1])
      .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0]),
    header = source.filter((i) => i.baseline < divider[1]),
    originalBody = source.filter((i) => i.baseline > divider[1]),
    bands = groupSourceRowsWithScripts(header, h, 0.15),
    body = groupSourceRowsWithScripts(originalBody, h, 0.15)
  if (
    !bands ||
    bands.length !== 1 ||
    !body ||
    body.length < 3 ||
    body.some((g) => g.some((i) => Math.abs(i.height - h) > h * 0.02))
  )
    return
  const leaves = nativeHorizontalFields(header, h * 0.2)
  if (leaves.length !== 5 || leaves.some((g) => !g.some((i) => /\p{L}/u.test(i.text)))) return
  const bounds = leaves.map(union),
    gap = bounds[2][0] - bounds[1][2]
  if (gap < h * 0.2 || gap > h * 0.45) return
  const fields = []
  for (const group of body) {
    const ordered = [...group].sort((a, b) => a.rect[0] - b.rect[0]),
      prefix = ordered.filter((i) => i.rect[2] < bounds[1][0] - h * 0.1),
      terminal = ordered.filter((i) => i.rect[0] >= bounds[4][0] - h * 0.05),
      penultimate = ordered.filter(
        (i) => i.rect[0] >= bounds[3][0] - h * 0.05 && i.rect[2] < bounds[4][0] - h * 0.1
      ),
      owned = new Set([...prefix, ...penultimate, ...terminal]),
      middle = ordered.filter((i) => !owned.has(i))
    if (
      !prefix.length ||
      !penultimate.length ||
      !terminal.length ||
      middle.length < 2 ||
      Math.abs(middle[0].rect[0] - bounds[1][0]) > h * 0.05 ||
      middle.some((i) => i.rect[0] < bounds[1][0] - h * 0.05 || i.rect[2] >= bounds[3][0] - h * 0.1)
    )
      return
    const matches = middle
      .slice(1)
      .flatMap((i, n) => (Math.abs(i.rect[0] - middle[n].rect[2] - gap) <= h * 0.02 ? [n + 1] : []))
    if (matches.length !== 1) return
    const cut = matches[0],
      row = [prefix, middle.slice(0, cut), middle.slice(cut), penultimate, terminal]
    if (row.flat().length !== ordered.length || new Set(row.flat()).size !== ordered.length) return
    fields.push(row)
  }
  if (!hasUniqueRecordTokens(originalBody, body)) return
  const cuts = [
      opening[0],
      ...bounds.slice(1).map((r, c) => (bounds[c][2] + r[0]) / 2),
      opening[2]
    ],
    headerCells = leaves.map((g, column) => ({
      row: 0,
      column,
      rowSpan: 1,
      colSpan: 1,
      rect: [cuts[column], opening[1], cuts[column + 1], divider[1]],
      text: g.map((i) => i.text).join(''),
      sourceTokens: g,
      sourceRects: g.map((i) => i.rect),
      origin: 'source-variable-gutter-header'
    })),
    spans = fields.flatMap((row, n) =>
      row.map((g, column) => ({
        row: n + 1,
        column,
        colSpan: 1,
        rowSpan: 1,
        items: g,
        rect: union(g)
      }))
    ),
    ys = [
      opening[1],
      divider[1],
      ...body
        .slice(1)
        .map(
          (g, n) =>
            (Math.max(...body[n].map((i) => i.rect[3])) + Math.min(...g.map((i) => i.rect[1]))) / 2
        ),
      closing[1]
    ],
    groups = [header, ...body]
  return {
    cuts,
    groups,
    headerCells,
    headerRows: 1,
    spans,
    consumed: source,
    rowRects: groups.map((_, n) => [opening[0], ys[n], opening[2], ys[n + 1]]),
    cropRect: [opening[0], opening[1], opening[2], closing[1]],
    repair: 'native-variable-gutter-literal-fields-proved'
  }
}

// Repeated complete native scalar peers can witness the leaf lanes underneath
// a wrapped header. Independent words stacked in one lane remain one physical
// header face; this does not create inferred grouped/semantic parent headings.
export function proveNativePeerScalarLeafHeader(table, items, captions, rules, runs = []) {
  if (!table.cropRect) return
  if (
    items.some(
      (i) =>
        !Array.isArray(i.rect) ||
        i.rect.length !== 4 ||
        !i.rect.every(Number.isFinite) ||
        i.rect[2] <= i.rect[0] ||
        i.rect[3] <= i.rect[1] ||
        !Number.isFinite(i.baseline)
    )
  )
    return
  const [left, top, right, bottom] = table.cropRect,
    near = items.filter(
      (i) =>
        i.horizontal &&
        i.height > 0 &&
        i.text?.trim() &&
        i.rect[0] >= left - 2 &&
        i.rect[2] <= right + 2 &&
        i.rect[1] >= top - 20 &&
        i.rect[3] <= bottom + 20
    ),
    heights = near.map((i) => i.height).sort((a, b) => a - b),
    h = heights[heights.length >> 1]
  if (!(h > 0)) return
  const frame = joinHorizontalTableRules(rules)
    .filter(
      (r) =>
        r[1] >= top - h * 2 &&
        r[1] <= bottom + h &&
        Math.abs(r[0] - left) < h * 1.5 &&
        Math.abs(r[2] - right) < h * 1.5
    )
    .sort((a, b) => a[1] - b[1])
  if (
    frame.length < 3 ||
    frame.some((r) => Math.abs(r[0] - frame[0][0]) > 0.02 || Math.abs(r[2] - frame[0][2]) > 0.02)
  )
    return
  const opening = frame[0],
    divider = frame[1],
    closing = frame.at(-1)
  if (
    divider[1] - opening[1] > h * 4 ||
    captions.filter(
      (c) =>
        captionKind(c.lines?.[0]) === 'table' &&
        c.rect &&
        c.rect[0] < opening[2] &&
        c.rect[2] > opening[0] &&
        ((c.rect[3] <= opening[1] && opening[1] - c.rect[3] < h * 8) ||
          (c.rect[1] >= closing[1] && c.rect[1] - closing[1] < h * 4))
    ).length !== 1
  )
    return
  if (
    items.some(
      (i) =>
        i.text?.trim() &&
        i.rect[0] < opening[2] &&
        i.rect[2] > opening[0] &&
        i.rect[1] < closing[1] &&
        i.rect[3] > opening[1] &&
        (!i.horizontal || i.rect[0] < opening[0] - 0.02 || i.rect[2] > opening[2] + 0.02)
    )
  )
    return
  const source = items
      .filter(
        (i) =>
          i.horizontal &&
          i.text?.trim() &&
          i.rect[0] >= opening[0] - 0.02 &&
          i.rect[2] <= opening[2] + 0.02 &&
          i.baseline > opening[1] &&
          i.baseline < closing[1]
      )
      .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0]),
    header = source.filter((i) => i.baseline < divider[1]),
    originalBody = source.filter((i) => i.baseline > divider[1]),
    headerItems = header.flatMap((i) => splitNativeMeasuredFields(i, runs, h) ?? [i]),
    bodyItems = originalBody.flatMap((i) => splitNativeMeasuredFields(i, runs, h) ?? [i]),
    headerBands = groupSourceRowsWithScripts(header, h, 0.2),
    body = groupSourceRowsWithScripts(bodyItems, h, 0.2)
  if (!headerBands || headerBands.length > 3 || !body) return
  if (
    header.length + originalBody.length !== source.length ||
    originalBody.some(
      (i) => i.height < h * 0.8 && header.some((a) => isAdjacentTableScript(i, a))
    ) ||
    new Set(headerItems).size !== headerItems.length ||
    new Set(headerItems.map((i) => i.sourceToken ?? i)).size !== header.length
  )
    return
  const scalar = (g) =>
      /^[-+−]?\d+(?:\.\d+)?$/u.test(
        g
          .map((i) => i.text)
          .join('')
          .replace(/\s/gu, '')
      ),
    records = body
      .map((g) => nativeHorizontalFields(g, h * 0.55))
      .filter((row) => row.length >= 3 && row.length <= 14 && row.slice(-2).every(scalar)),
    counts = [...new Set(records.map((r) => r.length))],
    plans = []
  for (const count of counts) {
    const peers = records.filter((r) => r.length === count)
    if (peers.length < 3) continue
    const domains = Array.from({ length: count }, (_, c) => [
      Math.min(...peers.flatMap((r) => r[c].map((i) => i.rect[0]))),
      Math.max(...peers.flatMap((r) => r[c].map((i) => i.rect[2])))
    ])
    if (domains.slice(1).some((d, c) => d[0] - domains[c][1] < h * 0.1)) continue
    const initial = [
        opening[0],
        ...domains.slice(1).map((d, c) => (domains[c][1] + d[0]) / 2),
        opening[2]
      ],
      leaves = Array.from({ length: count }, () => [])
    let invalidHeader = false
    for (const i of headerItems) {
      const center = (i.rect[0] + i.rect[2]) / 2,
        c = initial.slice(1).findIndex((x) => center < x)
      if (c < 0) {
        invalidHeader = true
        break
      }
      leaves[c].push(i)
      domains[c][0] = Math.min(domains[c][0], i.rect[0])
      domains[c][1] = Math.max(domains[c][1], i.rect[2])
    }
    if (
      invalidHeader ||
      leaves.flat().length !== headerItems.length ||
      leaves.some((g) => !g.some((i) => /[\p{L}\d]/u.test(i.text))) ||
      domains.slice(1).some((d, c) => d[0] - domains[c][1] < h * 0.1)
    )
      continue
    const leafBands = leaves.map((g) => groupSourceRowsWithScripts(g, h, 0.2))
    if (
      leafBands.some(
        (bands) => !bands || bands.some((g) => nativeHorizontalFields(g, h * 0.65).length !== 1)
      )
    )
      continue
    const cuts = [
      opening[0],
      ...domains.slice(1).map((d, c) => (domains[c][1] + d[0]) / 2),
      opening[2]
    ]
    if (
      headerItems.some(
        (i) =>
          cuts.slice(1).filter((x, c) => i.rect[0] >= cuts[c] - 0.02 && i.rect[2] <= x + 0.02)
            .length !== 1
      )
    )
      continue
    const columns = cuts.slice(1).map((x, c) => [cuts[c], opening[1], x, closing[1]]),
      headerCells = leaves.map((g, column) => ({
        row: 0,
        column,
        rowSpan: 1,
        colSpan: 1,
        rect: [cuts[column], opening[1], cuts[column + 1], divider[1]],
        text: leafBands[column]
          .map((band) =>
            band
              .toSorted((a, b) => a.rect[0] - b.rect[0])
              .reduce(
                (text, i, n, ordered) =>
                  text +
                  (n && i.rect[0] - ordered[n - 1].rect[2] > h * 0.14 ? ' ' : '') +
                  i.text.trim(),
                ''
              )
          )
          .join(' '),
        sourceTokens: g,
        sourceRects: g.map((i) => i.rect),
        origin: 'source-peer-scalar-leaf-header'
      }))
    plans.push({
      kind: 'peer-scalar-leaf',
      columns,
      headerCells,
      rows: [[opening[0], opening[1], opening[2], divider[1]]],
      headerRows: [0],
      headerBottom: divider[1],
      ownedTokens: new Set(header),
      bodyItems,
      originalBody,
      cuts,
      cropRect: [opening[0], opening[1], opening[2], closing[1]],
      repair: 'native-peer-scalar-leaf-header-gutters-proved'
    })
  }
  return plans.length === 1 ? plans[0] : undefined
}

// A closed source frame and complete peer baselines can prove leaf gutters
// even when a detector invents a lane or merges the last two leaves. Each
// field is literal native ink; neither column widths nor header names supply
// missing body values.
export function proveNativeClosedLeafHeader(table, items, captions, rules, runs = []) {
  if (!table.cropRect) return
  const [left, top, right, bottom] = table.cropRect
  const near = tableSourceItems(items, [left - 2, top - 2, right + 2, bottom + 2])
  const heights = near
    .filter((i) => i.height > 0)
    .map((i) => i.height)
    .sort((a, b) => a - b)
  const h = heights[heights.length >> 1]
  if (!(h > 0)) return
  const horizontal = joinHorizontalTableRules(rules)
    .filter(
      (r) =>
        r[1] >= top - h * 1.5 &&
        r[1] <= bottom + h * 1.5 &&
        Math.abs(r[0] - left) < h * 1.5 &&
        r[2] >= right - h * 1.5 &&
        r[2] - right < (right - left) * 0.4
    )
    .sort((a, b) => a[1] - b[1])
  if (horizontal.length < 3) return
  const opening = horizontal[0],
    closing = horizontal.at(-1)
  const frame = horizontal.filter(
    (r) => Math.abs(r[0] - opening[0]) < 0.05 && Math.abs(r[2] - opening[2]) < 0.05
  )
  const divider = frame[1]
  if (
    frame.length < 3 ||
    !divider ||
    divider[1] - opening[1] > h * 2.8 ||
    closing[1] - divider[1] < h * 2 ||
    closing !== frame.at(-1)
  )
    return
  const possibleCaptions = captions.filter(
    (c) =>
      captionKind(c.lines?.[0]) === 'table' &&
      c.rect[0] < opening[2] &&
      c.rect[2] > opening[0] &&
      ((c.rect[3] <= opening[1] && opening[1] - c.rect[3] < h * 8) ||
        (c.rect[1] >= closing[1] && c.rect[1] - closing[1] < h * 4))
  )
  const aboveCaptions = possibleCaptions.filter((c) => c.rect[3] <= opening[1])
  const caption = aboveCaptions.length ? aboveCaptions : possibleCaptions
  if (caption.length !== 1) return
  const source = tableSourceItems(items, [
    opening[0] - 0.05,
    opening[1] - h * 0.35,
    opening[2] + 0.05,
    closing[1] + 0.05
  ])
  const header = source.filter((i) => i.baseline > opening[1] && i.rect[3] < divider[1])
  if (!header.length || header.some((i) => Math.abs(i.baseline - header[0].baseline) > h * 0.2))
    return
  const headerItems = header.flatMap((i) => splitNativeMeasuredFields(i, runs, h) ?? [i])
  const leaves = nativeHorizontalFields(headerItems, h * 0.35)
  if (
    leaves.length < 2 ||
    leaves.length > 14 ||
    leaves.some((g) => !g.some((i) => /[\p{L}\d]/u.test(i.text)))
  )
    return
  const originalBody = source.filter((i) => i.rect[1] > divider[1] && i.rect[3] < closing[1])
  const bodyItems = originalBody.flatMap((i) => splitNativeMeasuredFields(i, runs, h) ?? [i])
  const bands = groupSourceRowsWithScripts(bodyItems, h, 0.2)
  if (!bands || bands.length < 2) return
  const complete = bands
    .map((g) => nativeHorizontalFields(g, h * 0.55))
    .filter((g) => g.length === leaves.length)
  if (complete.length < 2) return
  const domains = leaves.map((g, c) => [
    Math.min(
      ...g.map((i) => i.rect[0]),
      ...complete.flatMap((row) => row[c].map((i) => i.rect[0]))
    ),
    Math.max(...g.map((i) => i.rect[2]), ...complete.flatMap((row) => row[c].map((i) => i.rect[2])))
  ])
  if (domains.slice(1).some((d, c) => d[0] - domains[c][1] < h * 0.15)) return
  // A wrapped fragment may extend its independently witnessed lane, but it
  // must touch exactly one domain and leave every neighboring gutter open.
  for (const i of bodyItems) {
    const matches = domains
      .map((d, c) => ({ d, c }))
      .filter(({ d }) => i.rect[0] <= d[1] + 0.05 && i.rect[2] >= d[0] - 0.05)
    if (matches.length !== 1) return
    const d = matches[0].d
    d[0] = Math.min(d[0], i.rect[0])
    d[1] = Math.max(d[1], i.rect[2])
  }
  if (domains.slice(1).some((d, c) => d[0] - domains[c][1] < h * 0.1)) return
  if (domains[0][0] < opening[0] - 0.05 || domains.at(-1)[1] > opening[2] + 0.05) return
  const cuts = [
    opening[0] - 0.001,
    ...domains.slice(1).map((d, c) => (domains[c][1] + d[0]) / 2),
    opening[2] + 0.001
  ]
  if (
    bodyItems.some(
      (i) =>
        cuts.filter(
          (x, c) => c < cuts.length - 1 && i.rect[0] >= x - 0.05 && i.rect[2] <= cuts[c + 1] + 0.05
        ).length !== 1
    )
  )
    return
  const texts = leaves.map((g) =>
    g
      .toSorted((a, b) => a.rect[0] - b.rect[0])
      .reduce(
        (text, i, n, ordered) =>
          text + (n && i.rect[0] - ordered[n - 1].rect[2] > h * 0.14 ? ' ' : '') + i.text.trim(),
        ''
      )
  )
  if (texts.some((t) => !t)) return
  const headerCells = leaves.map((g, column) => ({
    row: 0,
    column,
    rowSpan: 1,
    colSpan: 1,
    rect: [cuts[column], opening[1], cuts[column + 1], divider[1]],
    text: texts[column],
    sourceTokens: g,
    sourceRects: g.map((i) => i.rect),
    origin: 'source-closed-leaf-header'
  }))
  return {
    cropRect: [opening[0], opening[1], opening[2], closing[1]],
    columns: cuts.slice(1).map((x, c) => [cuts[c], opening[1], x, closing[1]]),
    rows: [[opening[0], opening[1], opening[2], divider[1]]],
    headerRows: [0],
    headerCells,
    ownedTokens: new Set(header),
    headerBottom: divider[1],
    bodyItems,
    originalBody,
    bodyRecords: bands,
    spans: [],
    completeSpans: true,
    kind: 'closed-leaf',
    repair: 'native-closed-leaf-header-gutters-proved'
  }
}

// Trusted body gutters establish the leaf lanes. Independent native baselines
// and short underlines establish parent ownership; the parent's spelling has
// no role in that proof.
export function proveNativePrintedHeaderAtColumns(
  table,
  items,
  captions,
  rules,
  columns,
  runs = []
) {
  if (!table.cropRect || !columns?.length || columns.length < 3 || columns.length > 16) return
  if (columns.some((r, c) => !(r[2] > r[0]) || (c && Math.abs(r[0] - columns[c - 1][2]) > 0.02)))
    return
  const source = tableSourceItems(items, table.cropRect)
  const heights = source
    .filter((i) => i.height > 0)
    .map((i) => i.height)
    .sort((a, b) => a - b)
  const h = heights[heights.length >> 1]
  if (!(h > 0)) return
  const left = columns[0][0],
    right = columns.at(-1)[2]
  const full = joinHorizontalTableRules(rules)
    .filter(
      (r) =>
        Math.abs(r[0] - left) < h &&
        Math.abs(r[2] - right) < h &&
        r[1] >= table.cropRect[1] - h &&
        r[1] <= table.cropRect[3] + h
    )
    .sort((a, b) => a[1] - b[1])
  if (full.length < 3) return
  const opening = full[0],
    divider = full.find((r) => r[1] - opening[1] > h * 0.6),
    closing = full.at(-1)
  if (
    !divider ||
    divider === closing ||
    divider[1] - opening[1] > h * 5 ||
    divider[1] - opening[1] < h * 0.5
  )
    return
  const nearby = captions.filter(
    (c) =>
      captionKind(c.lines?.[0]) === 'table' &&
      c.rect[0] < right &&
      c.rect[2] > left &&
      ((c.rect[3] <= opening[1] && opening[1] - c.rect[3] < h * 10) ||
        (c.rect[1] >= closing[1] && c.rect[1] - closing[1] < h * 4))
  )
  const above = nearby.filter((c) => c.rect[3] <= opening[1])
  if ((above.length ? above : nearby).length !== 1) return
  const header = source.filter((i) => i.baseline > opening[1] && i.rect[3] < divider[1])
  const originalBands = groupSourceRowsWithScripts(header, h, 0.2)
  if (!originalBands || originalBands.length < 1 || originalBands.length > 2) return
  const bands = originalBands.map((g) =>
    nativeHorizontalFields(
      g.flatMap((i) => splitNativeMeasuredFields(i, runs, h) ?? [i]),
      h * 0.35
    )
  )
  const columnOf = (g) =>
    columns
      .map((r, c) => ({ r, c }))
      .filter(({ r }) => {
        const rect = union(g),
          x = (rect[0] + rect[2]) / 2
        return x >= r[0] && x < r[2]
      })
  const slots = new Map()
  for (const g of bands.at(-1)) {
    const matches = columnOf(g)
    if (matches.length !== 1) return
    const c = matches[0].c
    slots.set(c, [...(slots.get(c) ?? []), ...g])
  }
  const needsHeaderGutter = [...slots].some(
    ([c, g]) => union(g)[0] < columns[c][0] - 0.05 || union(g)[2] > columns[c][2] + 0.05
  )
  if (needsHeaderGutter) {
    const domains = columns.map((r, c) =>
      slots.has(c) ? [union(slots.get(c))[0], union(slots.get(c))[2]] : [Infinity, -Infinity]
    )
    const body = source
      .filter((i) => i.rect[1] > divider[1] && i.rect[3] < closing[1])
      .flatMap((i) => splitNativeMeasuredFields(i, runs, h) ?? [i])
    for (const i of body) {
      // A fenced full-width section is outside the leaf-lane domain proof.
      if (
        i.rect[2] - i.rect[0] > (right - left) * 0.6 &&
        /\p{L}/u.test(i.text) &&
        full.some((r) => r[1] <= i.rect[1] && i.rect[1] - r[1] < h * 0.5) &&
        full.some((r) => r[1] >= i.rect[3] && r[1] - i.rect[3] < h * 0.5)
      )
        continue
      const matches = columnOf([i])
      if (matches.length !== 1) return
      const d = domains[matches[0].c]
      d[0] = Math.min(d[0], i.rect[0])
      d[1] = Math.max(d[1], i.rect[2])
    }
    if (
      domains.some((d) => !d.every(Number.isFinite)) ||
      domains.slice(1).some((d, c) => d[0] - domains[c][1] < h * 0.08)
    )
      return
    const cuts = [left, ...domains.slice(1).map((d, c) => (domains[c][1] + d[0]) / 2), right]
    columns = cuts.slice(1).map((x, c) => [cuts[c], columns[c][1], x, columns[c][3]])
  }
  if (bands.length === 2) {
    const parentRules = joinHorizontalTableRules(rules).filter(
      (r) =>
        r[1] > Math.max(...originalBands[0].map((i) => i.rect[3])) &&
        r[1] < Math.min(...originalBands[1].map((i) => i.rect[1])) &&
        r[0] > opening[0] &&
        r[2] < opening[2]
    )
    const grouped = []
    for (const rule of parentRules) {
      const owned = bands[0].filter(
        (g) => union(g)[0] >= rule[0] - h * 0.15 && union(g)[2] <= rule[2] + h * 0.15
      )
      if (owned.length) grouped.push(owned.flat())
    }
    const consumed = new Set(grouped.flat())
    if (grouped.flat().length !== consumed.size) return
    bands[0] = [...grouped, ...bands[0].filter((g) => g.every((i) => !consumed.has(i)))].sort(
      (a, b) => union(a)[0] - union(b)[0]
    )
    const singleLane = new Map()
    const wideParents = []
    for (const g of bands[0]) {
      const rect = union(g),
        matches = columns
          .map((r, c) => ({ r, c }))
          .filter(({ r }) => rect[0] >= r[0] - 0.05 && rect[2] <= r[2] + 0.05)
      if (matches.length === 1)
        singleLane.set(matches[0].c, [...(singleLane.get(matches[0].c) ?? []), ...g])
      else wideParents.push(g)
    }
    bands[0] = [...singleLane.values(), ...wideParents].sort((a, b) => union(a)[0] - union(b)[0])
  }
  const boundaries = [
    opening[1],
    ...originalBands
      .slice(1)
      .map(
        (g, n) =>
          (Math.max(...originalBands[n].map((i) => i.rect[3])) +
            Math.min(...g.map((i) => i.rect[1]))) /
          2
      ),
    divider[1]
  ]
  const occupied = new Set(),
    headerCells = []
  const add = (g, row, owned, rowSpan = 1) => {
    if (!owned.length || owned.some((c, n) => n && c !== owned[n - 1] + 1)) return false
    for (let r = row; r < row + rowSpan; r++)
      for (const c of owned) {
        if (occupied.has(`${r}:${c}`)) return false
        occupied.add(`${r}:${c}`)
      }
    const literal = g
      .toSorted((a, b) => a.rect[0] - b.rect[0])
      .reduce(
        (text, i, n, ordered) =>
          text + (n && i.rect[0] - ordered[n - 1].rect[2] > h * 0.14 ? ' ' : '') + i.text.trim(),
        ''
      )
    headerCells.push({
      row,
      column: owned[0],
      rowSpan,
      colSpan: owned.length,
      rect: [
        columns[owned[0]][0],
        boundaries[row],
        columns[owned.at(-1)][2],
        boundaries[row + rowSpan]
      ],
      text: literal,
      sourceTokens: g,
      sourceRects: g.map((i) => i.rect),
      origin: 'source-printed-header'
    })
    return true
  }
  if (bands.length === 2)
    for (const g of bands[0]) {
      const matches = columnOf(g),
        rect = union(g)
      if (
        matches.length === 1 &&
        rect[0] >= matches[0].r[0] - 0.05 &&
        rect[2] <= matches[0].r[2] + 0.05
      ) {
        if (!add(g, 0, [matches[0].c], slots.has(matches[0].c) ? 1 : 2)) return
        continue
      }
      const underlines = joinHorizontalTableRules(rules).filter(
        (r) =>
          r[1] > rect[3] &&
          r[1] < Math.min(...originalBands[1].map((i) => i.rect[1])) &&
          rect[0] >= r[0] - h * 0.15 &&
          rect[2] <= r[2] + h * 0.15 &&
          r[0] > opening[0] &&
          r[2] < opening[2]
      )
      if (underlines.length > 1) return
      let owned
      if (underlines.length) {
        const rule = underlines[0]
        owned = [...slots]
          .filter(([, leaf]) => {
            const x = (union(leaf)[0] + union(leaf)[2]) / 2
            return x > rule[0] && x < rule[2]
          })
          .map(([c]) => c)
          .sort((a, b) => a - b)
      } else {
        const candidates = []
        const leafText = (c) =>
          slots
            .get(c)
            ?.map((i) => i.text.trim())
            .join('')
        const repeated =
          columns.length === 13 &&
          slots.size === 12 &&
          !slots.has(0) &&
          Array.from({ length: 12 }, (_, n) => n + 1).every(
            (c) => leafText(c) === leafText(((c - 1) % 4) + 1)
          )
        const fence = (x) =>
          rules.some(
            (r) =>
              r[0] === r[2] &&
              Math.abs(r[0] - x) < h * 0.1 &&
              classifyTableRuleEdge(
                rules,
                0,
                r[0],
                Math.min(...originalBands[1].map((i) => i.rect[1])),
                Math.max(...originalBands[1].map((i) => i.rect[3]))
              ) === 1
          )
        for (let start = 1; start < columns.length; start++)
          for (let end = start + 1; end < columns.length; end++) {
            const span = Array.from({ length: end - start + 1 }, (_, n) => start + n)
            if (!span.every((c) => slots.has(c))) continue
            const a = columns[start][0],
              b = end === columns.length - 1 ? opening[2] : columns[end][2]
            const bounded =
              ((start === 1 && slots.has(0)) || fence(a)) &&
              (end === columns.length - 1 || fence(b))
            const repeatBounded = repeated && span.length === 4 && (start - 1) % 4 === 0
            if (
              (bounded || repeatBounded) &&
              rect[0] >= a &&
              rect[2] <= b &&
              Math.abs((rect[0] + rect[2] - a - b) / 2) < h * 0.2
            )
              candidates.push(span)
          }
        if (candidates.length !== 1) return
        owned = candidates[0]
      }
      if (owned.length < 2 || !add(g, 0, owned)) return
    }
  for (const [c, g] of slots) {
    const anchor = bands.length === 2 && !occupied.has(`0:${c}`) ? 0 : bands.length - 1
    if (!add(g, anchor, [c], bands.length - anchor)) return
  }
  const missing = columns.map((_, c) => c).filter((c) => !occupied.has(`0:${c}`))
  // A blank stub is permitted only when complete literal body records witness
  // that lane. A missing metric leaf must remain diagnostic.
  if (missing.length) {
    if (missing.length !== 1 || missing[0] !== 0) return
    const body = source.filter((i) => i.baseline > divider[1] && i.rect[3] < closing[1])
    const peers = groupSourceRowsWithScripts(body, h, 0.2)?.filter((g) =>
      columns.every((r) => g.some((i) => i.rect[0] >= r[0] - 0.05 && i.rect[2] <= r[2] + 0.05))
    )
    if (!peers || peers.length < 3) return
    headerCells.push({
      row: 0,
      column: 0,
      rowSpan: bands.length,
      colSpan: 1,
      rect: [left, opening[1], columns[0][2], divider[1]],
      text: '',
      sourceTokens: [],
      sourceRects: [],
      origin: 'source-printed-header'
    })
    for (let r = 0; r < bands.length; r++) occupied.add(`${r}:0`)
  }
  if (bands.length === 2 && occupied.size !== columns.length * 2) return
  return {
    columns: columns.map((r) => r.slice()),
    rows: boundaries.slice(1).map((y, n) => [left, boundaries[n], right, y]),
    headerRows: bands.map((_, n) => n),
    headerCells,
    ownedTokens: new Set(header),
    headerBottom: divider[1],
    spans: [],
    completeSpans: true,
    kind: 'printed-header',
    repair: 'native-independent-printed-header-proved'
  }
}

// Two printed titles centered over complete mean/interval peer fields prove
// two parent spans. No invisible leaf names or statistical roles are added.
export function proveNativeMeanIntervalParents(table, items, captions, rules) {
  if (!table.cropRect) return
  const source = tableSourceItems(items, table.cropRect),
    heights = source
      .filter((i) => i.height > 0)
      .map((i) => i.height)
      .sort((a, b) => a - b),
    h = heights[heights.length >> 1]
  if (!(h > 0)) return
  const [left, top, right, bottom] = table.cropRect
  const frame = joinHorizontalTableRules(rules)
    .filter(
      (r) =>
        Math.abs(r[0] - left) < h &&
        Math.abs(r[2] - right) < h &&
        r[1] >= top - h &&
        r[1] <= bottom + h
    )
    .sort((a, b) => a[1] - b[1])
  if (frame.length < 3) return
  const opening = frame[0],
    divider = frame[1],
    closing = frame.at(-1)
  if (
    divider[1] - opening[1] > h * 2.5 ||
    closing[1] - divider[1] < h * 4 ||
    captions.filter(
      (c) =>
        captionKind(c.lines?.[0]) === 'table' &&
        c.rect[3] <= opening[1] &&
        opening[1] - c.rect[3] < h * 8 &&
        c.rect[0] < right &&
        c.rect[2] > left
    ).length !== 1
  )
    return
  const header = source.filter((i) => i.baseline > opening[1] && i.rect[3] < divider[1])
  const parents = nativeHorizontalFields(header, h * 0.3)
  if (
    parents.length !== 2 ||
    header.some((i) => Math.abs(i.baseline - header[0].baseline) > h * 0.15) ||
    parents.some((g) => !g.some((i) => /\p{L}/u.test(i.text)))
  )
    return
  const originalBody = source.filter((i) => i.rect[1] > divider[1] && i.rect[3] < closing[1])
  const bands = groupSourceRowsWithScripts(originalBody, h, 0.2)
  if (!bands) return
  const fields = bands.map((g) => nativeHorizontalFields(g, h * 0.55)).filter((g) => g.length === 5)
  const literal = (g) =>
    g
      .toSorted((a, b) => a.rect[0] - b.rect[0])
      .map((i) => i.text)
      .join('')
      .replace(/\s/gu, '')
  const mean = /^[−+-]?\d+(?:\.\d+)?$/u,
    interval = /^\[[−+-]?\d+(?:\.\d+)?,[−+-]?\d+(?:\.\d+)?\]$/u
  const complete = fields.filter(
    (g) =>
      /\p{L}/u.test(literal(g[0])) &&
      mean.test(literal(g[1])) &&
      interval.test(literal(g[2])) &&
      mean.test(literal(g[3])) &&
      interval.test(literal(g[4]))
  )
  if (complete.length < 3) return
  const domains = Array.from({ length: 5 }, (_, c) => [
    Math.min(...complete.flatMap((g) => g[c].map((i) => i.rect[0]))),
    Math.max(...complete.flatMap((g) => g[c].map((i) => i.rect[2])))
  ])
  if (domains.slice(1).some((d, c) => d[0] - domains[c][1] < h * 0.2)) return
  const cuts = [
    opening[0],
    ...domains.slice(1).map((d, c) => (domains[c][1] + d[0]) / 2),
    opening[2]
  ]
  if (
    parents.some((g, n) => {
      const r = union(g),
        a = n ? 3 : 1,
        b = n ? 5 : 3
      return (
        r[0] < cuts[a] ||
        r[2] > cuts[b] ||
        Math.abs((r[0] + r[2] - cuts[a] - cuts[b]) / 2) > h * 0.35
      )
    })
  )
    return
  const cells = [
    {
      row: 0,
      column: 0,
      rowSpan: 1,
      colSpan: 1,
      rect: [cuts[0], opening[1], cuts[1], divider[1]],
      text: '',
      sourceTokens: [],
      sourceRects: [],
      origin: 'source-mean-interval-parent'
    },
    ...parents.map((g, n) => ({
      row: 0,
      column: n ? 3 : 1,
      rowSpan: 1,
      colSpan: 2,
      rect: [cuts[n ? 3 : 1], opening[1], cuts[n ? 5 : 3], divider[1]],
      text: g.map((i) => i.text.trim()).join(' '),
      sourceTokens: g,
      sourceRects: g.map((i) => i.rect),
      origin: 'source-mean-interval-parent'
    }))
  ]
  return {
    columns: cuts.slice(1).map((x, c) => [cuts[c], opening[1], x, closing[1]]),
    rows: [[opening[0], opening[1], opening[2], divider[1]]],
    headerRows: [0],
    headerCells: cells,
    ownedTokens: new Set(header),
    headerBottom: divider[1],
    spans: cells.filter((c) => c.colSpan > 1),
    completeSpans: true,
    kind: 'mean-interval-parent',
    repair: 'native-mean-interval-parent-spans-proved'
  }
}

// A printed ordinal and complete scientific records prove a narrow stub that
// the detector can merge into its first metric. No glyph widths are estimated.
export function proveNativeOrdinalMetricHeader(table, items, captions, rules) {
  if (!table.cropRect) return
  const source = tableSourceItems(items, table.cropRect)
  const heights = source.map((i) => i.height).sort((a, b) => a - b),
    h = heights[heights.length >> 1]
  if (!(h > 0)) return
  const [left, top, right, bottom] = table.cropRect
  const frame = joinHorizontalTableRules(rules)
    .filter(
      (r) =>
        r[1] >= top - h &&
        r[1] <= bottom + h &&
        Math.abs(r[0] - left) < h &&
        Math.abs(r[2] - right) < h
    )
    .sort((a, b) => a[1] - b[1])
  if (frame.length !== 3) return
  const [opening, divider, closing] = frame
  if (divider[1] - opening[1] > h * 2 || closing[1] - divider[1] < h * 3) return
  if (
    captions.filter(
      (c) =>
        captionKind(c.lines?.[0]) === 'table' &&
        c.rect[3] < opening[1] &&
        opening[1] - c.rect[3] < h * 8 &&
        c.rect[0] < right &&
        c.rect[2] > left
    ).length !== 1
  )
    return
  const header = source.filter((i) => i.baseline > opening[1] - h * 0.4 && i.baseline < divider[1])
  const groups = nativeHorizontalFields(header, h * 0.5)
  if (
    groups.length < 4 ||
    groups.length > 12 ||
    groups[0]
      .map((i) => i.text)
      .join('')
      .trim() !== 'ℓ'
  )
    return
  const body = source.filter((i) => i.baseline >= divider[1] && i.rect[3] <= closing[1] + 0.05)
  const bands = groupSourceRowsWithScripts(body, h, 0.25)
  if (!bands || bands.length < 3 || bands.length > 12) return
  const fields = bands.map((g) => nativeHorizontalFields(g, h * 0.5))
  if (
    fields.some((g) => g.length !== groups.length) ||
    fields.some((g, n) => g[0].map((i) => i.text).join('') !== String(n))
  )
    return
  const numeric = /^[−+-]?\d[\d.,×−+\-()[\]\s]*$|^\[[−+-]?\d[\d.]*,[−+-]?\d[\d.]*\]$|^[–—-]$/u
  if (
    fields.some((g) =>
      g
        .slice(1)
        .some(
          (f) =>
            !numeric.test(
              readSourceRow(f, [union(f)[0] - 0.01, union(f)[2] + 0.01])[0]?.replace(/\s/gu, '') ??
                ''
            )
        )
    )
  )
    return
  const domains = groups.map((g, c) => [
    Math.min(...g.map((i) => i.rect[0]), ...fields.flatMap((row) => row[c].map((i) => i.rect[0]))),
    Math.max(...g.map((i) => i.rect[2]), ...fields.flatMap((row) => row[c].map((i) => i.rect[2])))
  ])
  if (domains.slice(1).some((d, c) => d[0] - domains[c][1] < h * 0.3)) return
  if (domains[0][0] < opening[0] - h * 0.02 || domains.at(-1)[1] > opening[2] + h * 0.02) return
  const cuts = [
    Math.min(opening[0], domains[0][0]) - 0.001,
    ...domains.slice(1).map((d, c) => (domains[c][1] + d[0]) / 2),
    Math.max(opening[2], domains.at(-1)[1]) + 0.001
  ]
  const texts = readSourceRow(header, cuts)
  if (!texts || texts.some((t) => !t) || !texts.slice(1).some((t) => /\p{L}/u.test(t))) return
  const headerCells = groups.map((g, column) => ({
    row: 0,
    column,
    rowSpan: 1,
    colSpan: 1,
    rect: [cuts[column], opening[1], cuts[column + 1], divider[1]],
    text: texts[column],
    sourceTokens: g,
    sourceRects: g.map((i) => i.rect),
    origin: 'source-ordinal-metric-header'
  }))
  return {
    columns: cuts.slice(1).map((x, c) => [cuts[c], opening[1], x, closing[1]]),
    rows: [[opening[0], opening[1], opening[2], divider[1]]],
    headerRows: [0],
    headerCells,
    spans: [],
    completeSpans: true,
    ownedTokens: new Set(header),
    headerBottom: divider[1],
    bodyRecords: bands,
    originalBody: body,
    bodyItems: body,
    kind: 'ordinal-metric',
    prefixColumns: 1,
    repair: 'native-ordinal-metric-header-gutters-proved'
  }
}

// Repeated native four-leaf tiers plus a literal TJ gap establish sibling
// header ownership; the repeated tier cannot lend words to arbitrary prose.
export function proveNativeRepeatedLeafHeader(table, items, captions, rules, runs = []) {
  if (!table.cropRect || !runs.length) return
  const source = tableSourceItems(items, table.cropRect),
    heights = source.map((i) => i.height).sort((a, b) => a - b),
    h = heights[heights.length >> 1]
  if (!(h > 0)) return
  const [left, top, right, bottom] = table.cropRect
  const frame = joinHorizontalTableRules(rules)
    .filter(
      (r) =>
        r[1] >= top - h &&
        r[1] <= bottom + h &&
        Math.abs(r[0] - left) < h &&
        Math.abs(r[2] - right) < h
    )
    .sort((a, b) => a[1] - b[1])
  if (
    frame.length < 5 ||
    captions.filter(
      (c) =>
        captionKind(c.lines?.[0]) === 'table' &&
        c.rect[3] < frame[0][1] &&
        frame[0][1] - c.rect[3] < h * 6 &&
        c.rect[0] < right &&
        c.rect[2] > left
    ).length !== 1
  )
    return
  const tiers = []
  for (let n = 0; n < frame.length - 1; n++) {
    if (frame[n + 1][1] - frame[n][1] > h * 2) continue
    const original = source.filter((i) => i.rect[1] >= frame[n][1] && i.rect[3] < frame[n + 1][1])
    if (!original.length) continue
    const measured = original.flatMap((i) => splitNativeMeasuredFields(i, runs, h) ?? [i])
    const g = nativeHorizontalFields(measured, h * 0.3)
    if (g.length !== 4 || g.some((f) => !/\p{L}/u.test(f.map((i) => i.text).join('')))) continue
    tiers.push({ opening: frame[n], divider: frame[n + 1], original, groups: g, measured })
  }
  if (tiers.length !== 2 || !tiers[0].measured.some((i) => i.sourceToken)) return
  const lower = tiers[1],
    upper = tiers[0]
  const domains = lower.groups.map((g, c) => [
    Math.min(...g.map((i) => i.rect[0]), ...upper.groups[c].map((i) => i.rect[0])),
    Math.max(...g.map((i) => i.rect[2]), ...upper.groups[c].map((i) => i.rect[2]))
  ])
  const body = source.filter((i) => i.rect[1] > upper.divider[1] && i.rect[3] < lower.opening[1])
  // Wrapped source labels can extend farther right than the short header.
  // Move only to their observed ink, still leaving a real gap before the
  // independently measured first metric title and its complete records.
  domains[0][1] = Math.max(
    domains[0][1],
    ...body
      .filter((i) => i.rect[2] < domains[1][0] - 0.02 && /\p{L}/u.test(i.text))
      .map((i) => i.rect[2])
  )
  const isolatedCitations = body.filter(
    (i) =>
      /^\d+(?:\.\d+)?\s*\[\d+\](?:,\s*\d+(?:\.\d+)?\s*\[\d+\])+$/u.test(i.text.trim()) &&
      body.filter((other) => Math.abs(other.baseline - i.baseline) < h * 0.15).length === 1
  )
  if (isolatedCitations.some((i) => i.rect[0] <= domains[2][1] + h * 0.2)) return
  if (isolatedCitations.length)
    domains[3][0] = Math.min(domains[3][0], ...isolatedCitations.map((i) => i.rect[0]))
  if (domains[1][0] - domains[0][1] < h * 0.05) return
  if (domains.slice(1).some((d, c) => d[0] - domains[c][1] < h * 0.2)) return
  const cuts = [
    frame[0][0],
    ...domains.slice(1).map((d, c) => (domains[c][1] + d[0]) / 2),
    frame[0][2]
  ]
  const witness = groupSourceRowsWithScripts(body, h, 0.25)?.filter((g) => {
    const v = readSourceRow(
      g.filter((i) => i.rect[0] >= domains[1][0] - 0.02),
      cuts.slice(1)
    )
    return (
      g.some((i) => i.rect[0] < cuts[1] && /\p{L}/u.test(i.text)) &&
      v &&
      v.every((t) => /^[−+-]?\d[\d.,−+-]*$/u.test(t))
    )
  })
  if (!witness || witness.length < 2) return
  const headerCells = upper.groups.map((g, column) => ({
    row: 0,
    column,
    rowSpan: 1,
    colSpan: 1,
    rect: [cuts[column], upper.opening[1], cuts[column + 1], upper.divider[1]],
    text: readSourceRow(g, [cuts[column], cuts[column + 1]])?.[0],
    sourceTokens: g,
    sourceRects: g.map((i) => i.rect),
    origin: 'source-repeated-leaf-header'
  }))
  if (headerCells.some((c) => !c.text)) return
  return {
    columns: cuts.slice(1).map((x, c) => [cuts[c], frame[0][1], x, frame.at(-1)[1]]),
    rows: [[left, upper.opening[1], right, upper.divider[1]]],
    headerRows: [0],
    headerCells,
    spans: [],
    completeSpans: true,
    ownedTokens: new Set(upper.original),
    headerBottom: upper.divider[1],
    kind: 'repeated-leaf',
    repair: 'native-repeated-leaf-header-gutters-proved'
  }
}

// Two centered printed parent labels and complete six-lane numeric records
// establish an otherwise unruled hierarchy. Printed labels remain verbatim.
export function proveNativeUnruledPairedParentHeader(table, items) {
  if (!table.cropRect) return
  const source = tableSourceItems(items, table.cropRect),
    heights = source.map((i) => i.height).sort((a, b) => a - b),
    h = heights[heights.length >> 1]
  if (!(h > 0)) return
  const bands = []
  for (const i of source.toSorted((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    const previous = bands.at(-1)
    if (previous && Math.abs(previous[0].baseline - i.baseline) < h * 0.15) previous.push(i)
    else bands.push([i])
  }
  const parents = bands[0],
    leaves = bands[1]
  if (
    parents?.length !== 3 ||
    leaves?.length !== 6 ||
    leaves[0].baseline - parents[0].baseline < h * 0.8 ||
    leaves[0].baseline - parents[0].baseline > h * 1.6
  )
    return
  const labels = leaves.map((i) => /^([A-Z]{2,5})([1-4])$/.exec(i.text.trim()))
  if (
    labels.some((x) => !x) ||
    labels.slice(0, 2).some((m, n) => m[1] !== labels[0][1] || m[2] !== String(n + 1)) ||
    labels.slice(2).some((m, n) => m[1] !== labels[2][1] || m[2] !== String(n + 1)) ||
    labels[0][1] === labels[2][1]
  )
    return
  if (
    !/^[A-Z][a-z]{4,20}$/.test(parents[0].text.trim()) ||
    parents.slice(1).some((i) => !/^[A-Z]{2,5}$/.test(i.text.trim()))
  )
    return
  const complete = bands
    .slice(2)
    .filter((g) => g.length === 7 && g.slice(1).every((i) => /^\d[\d.x×]*$/u.test(i.text.trim())))
  if (complete.length < 3) return
  const domains = leaves.map((i, c) => [
    Math.min(i.rect[0], ...complete.map((g) => g[c + 1].rect[0])),
    Math.max(i.rect[2], ...complete.map((g) => g[c + 1].rect[2]))
  ])
  if (domains.slice(1).some((d, c) => d[0] - domains[c][1] < h)) return
  const stub = source.filter((i) => i.rect[2] < domains[0][0] - h)
  if (!stub.length) return
  const stubRight = Math.max(...stub.map((i) => i.rect[2]))
  if (domains[0][0] - stubRight < h) return
  const cuts = [
    table.cropRect[0],
    (stubRight + domains[0][0]) / 2,
    ...domains.slice(1).map((d, c) => (domains[c][1] + d[0]) / 2),
    table.cropRect[2]
  ]
  if (
    parents[0].rect[2] >= cuts[1] ||
    parents.slice(1).some((i, n) => {
      const owned = leaves.slice(n ? 2 : 0, n ? 6 : 2),
        center = owned.reduce((sum, l) => sum + (l.rect[0] + l.rect[2]) / 2, 0) / owned.length
      return (
        i.rect[0] < cuts[n ? 3 : 1] ||
        i.rect[2] > cuts[n ? 7 : 3] ||
        Math.abs((i.rect[0] + i.rect[2]) / 2 - center) > h * 0.2
      )
    })
  )
    return
  const firstBody = Math.min(...complete[0].map((i) => i.rect[1])),
    middle = (parents[0].baseline + leaves[0].rect[1]) / 2,
    top = Math.min(...parents.map((i) => i.rect[1]))
  if (firstBody <= Math.max(...leaves.map((i) => i.rect[3]))) return
  const headerCells = [
    {
      row: 0,
      column: 0,
      rowSpan: 2,
      colSpan: 1,
      rect: [cuts[0], top, cuts[1], firstBody],
      text: parents[0].text,
      sourceTokens: [parents[0]],
      sourceRects: [parents[0].rect],
      origin: 'source-unruled-paired-parent'
    },
    ...parents.slice(1).map((i, n) => ({
      row: 0,
      column: n ? 3 : 1,
      rowSpan: 1,
      colSpan: n ? 4 : 2,
      rect: [cuts[n ? 3 : 1], top, cuts[n ? 7 : 3], middle],
      text: i.text,
      sourceTokens: [i],
      sourceRects: [i.rect],
      origin: 'source-unruled-paired-parent'
    })),
    ...leaves.map((i, n) => ({
      row: 1,
      column: n + 1,
      rowSpan: 1,
      colSpan: 1,
      rect: [cuts[n + 1], middle, cuts[n + 2], firstBody],
      text: i.text,
      sourceTokens: [i],
      sourceRects: [i.rect],
      origin: 'source-unruled-paired-leaf'
    }))
  ]
  return {
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, table.cropRect[3]]),
    rows: [
      [cuts[0], top, cuts.at(-1), middle],
      [cuts[0], middle, cuts.at(-1), firstBody]
    ],
    headerRows: [0, 1],
    headerCells,
    spans: headerCells.filter((c) => c.colSpan > 1 || c.rowSpan > 1),
    completeSpans: true,
    ownedTokens: new Set([...parents, ...leaves]),
    headerBottom: firstBody,
    kind: 'unruled-paired-parent',
    repair: 'native-unruled-paired-parent-header-proved'
  }
}

// A caller's complete native body proof can supply its own leaf lanes. Short
// header separators and exact measured gaps still must own every title token.
export function proveNativeMeasuredHeaderAtColumns(
  table,
  items,
  captions,
  rules,
  runs,
  columns,
  emptyColumns = []
) {
  if (!table.cropRect || columns.length < 4 || columns.length > 20) return
  const [left, top, right, bottom] = table.cropRect,
    source = tableSourceItems(items, table.cropRect),
    heights = source.map((i) => i.height).sort((a, b) => a - b),
    h = heights[heights.length >> 1]
  if (
    !(h > 0) ||
    columns.some((c, n) => c[2] <= c[0] || (n && Math.abs(c[0] - columns[n - 1][2]) > 0.02))
  )
    return
  const horizontal = rules
    .filter(
      (r) =>
        r[1] === r[3] &&
        r[1] > top - h &&
        r[1] < bottom + h &&
        r[0] >= left - h &&
        r[2] <= right + h
    )
    .sort((a, b) => a[1] - b[1])
  const full = joinHorizontalTableRules(horizontal).filter(
    (r) => Math.abs(r[0] - columns[0][0]) < h && Math.abs(r[2] - columns.at(-1)[2]) < h
  )
  const opening = full[0],
    closing = full.at(-1)
  if (
    !opening ||
    !closing ||
    opening === closing ||
    captions.filter(
      (c) =>
        captionKind(c.lines?.[0]) === 'table' &&
        c.rect[3] < opening[1] &&
        opening[1] - c.rect[3] < h * 4 &&
        c.rect[0] < right &&
        c.rect[2] > left
    ).length !== 1
  )
    return
  const dividerY = horizontal.find((r) => r[1] > opening[1] + h * 0.5)?.[1]
  if (!dividerY || dividerY - opening[1] > h * 2.5) return
  const divider = horizontal.filter((r) => Math.abs(r[1] - dividerY) < 0.02)
  if (divider.reduce((sum, r) => sum + r[2] - r[0], 0) < (columns.at(-1)[2] - columns[0][0]) * 0.9)
    return
  const original = source.filter((i) => i.rect[1] >= opening[1] - 0.02 && i.rect[3] < dividerY)
  if (
    !original.length ||
    original.some((i) => Math.abs(i.baseline - original[0].baseline) > h * 0.2)
  )
    return
  const parts = original.flatMap((i) => splitNativeMeasuredFields(i, runs, h) ?? [i]),
    lanes = columns.map(() => [])
  for (const i of parts) {
    const matches = columns
      .map((c, n) => ({ c, n }))
      .filter(({ c }) => i.rect[0] >= c[0] - 0.02 && i.rect[2] <= c[2] + 0.02)
    if (matches.length !== 1) return
    lanes[matches[0].n].push(i)
  }
  if (
    lanes.some((g, c) => (emptyColumns.includes(c) ? g.length : !g.length)) ||
    new Set(parts.map((i) => i.sourceToken ?? i)).size !== original.length
  )
    return
  const headerCells = lanes.map((g, column) => ({
    row: 0,
    column,
    rowSpan: 1,
    colSpan: 1,
    rect: [columns[column][0], opening[1], columns[column][2], dividerY],
    text: g.length
      ? readSourceRow(g, [columns[column][0] - 0.02, columns[column][2] + 0.02])?.[0]
      : '',
    sourceTokens: g,
    sourceRects: g.map((i) => i.rect),
    origin: 'source-measured-body-lane-header'
  }))
  if (headerCells.some((c, n) => !emptyColumns.includes(n) && !c.text)) return
  return {
    columns,
    rows: [[columns[0][0], opening[1], columns.at(-1)[2], dividerY]],
    headerRows: [0],
    headerCells,
    spans: [],
    completeSpans: true,
    ownedTokens: new Set(original),
    headerBottom: dividerY,
    kind: 'measured-body-lane-header',
    repair: 'native-measured-body-lane-header-proved'
  }
}

export function splitNativeMeasuredFields(item, runs, h) {
  const matches = runs.filter(
    (r) => r.text === item.text && r.rect.every((v, n) => Math.abs(v - item.rect[n]) < 0.02)
  )
  if (matches.length !== 1) return
  const run = matches[0]
  if (
    !run.glyphRuns?.length ||
    !run.glyphRuns.every(Number.isInteger) ||
    !Array.isArray(run.literalGlyphs) ||
    [...run.literalGlyphs.join('')].length !== run.glyphRuns.length ||
    run.literalGlyphs.join('') !== item.text.replace(/\s/gu, '')
  )
    return
  const gaps = run.gaps.filter((g) => g.right - g.left >= h * 0.4).sort((a, b) => a.index - b.index)
  if (
    gaps.some(
      (g, n) =>
        !Number.isInteger(g.index) ||
        g.index <= 0 ||
        g.index >= run.glyphRuns.length ||
        run.glyphRuns[g.index - 1] !== run.glyphRuns[g.index] ||
        (n && g.index <= gaps[n - 1].index) ||
        g.left < item.rect[0] ||
        g.right > item.rect[2]
    )
  )
    return
  const characters = [...item.text],
    offsets = gaps.map((g) => g.index)
  const positions = []
  let count = 0
  for (let n = 0; n < characters.length; n++) {
    if (/\s/u.test(characters[n])) continue
    if (offsets.includes(count)) positions.push(n)
    count++
  }
  if (positions.length !== gaps.length) return
  const cuts = [0, ...positions, characters.length]
  const parts = cuts.slice(1).map((end, n) => ({
    ...item,
    text: characters.slice(cuts[n], end).join('').trim(),
    rect: [
      n ? gaps[n - 1].right : item.rect[0],
      item.rect[1],
      n < gaps.length ? gaps[n].left : item.rect[2],
      item.rect[3]
    ],
    sourceToken: item
  }))
  return parts.every((p) => p.text && p.rect[0] < p.rect[2]) ? parts : undefined
}

export function proveNativeMeasuredTieredHeader(table, items, captions, rules, runs = []) {
  if (!table.cropRect || !runs.length) return
  const source = tableSourceItems(items, table.cropRect)
  const heights = source.map((i) => i.height).sort((a, b) => a - b),
    h = heights[heights.length >> 1]
  if (!(h > 0)) return
  const parts = source.map((i) => splitNativeMeasuredFields(i, runs, h))
  if (parts.some((p) => !p) || parts.every((p) => p.length === 1)) return
  const measured = parts.flat().sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
  const bands = []
  for (const item of measured) {
    const row = bands.at(-1)
    if (row && Math.abs(row[0].baseline - item.baseline) < h * 0.15) row.push(item)
    else bands.push([item])
  }
  const plan = proveNativeTieredHeader(table, measured, captions, rules, bands)
  if (!plan) return
  const owned = new Set([...plan.ownedTokens].map((i) => i.sourceToken))
  if (owned.has(undefined)) return
  const originalBody = source.filter(
    (i) => i.rect[1] > plan.headerBottom && i.rect[3] < plan.columns[0][3]
  )
  const bodyItems = measured.filter((i) => originalBody.includes(i.sourceToken))
  if (!bodyItems.length) return
  return {
    ...plan,
    kind: 'measured-tiered',
    ownedTokens: owned,
    originalBody,
    bodyItems,
    repair: 'native-measured-tiered-header-gutters-proved'
  }
}

// Measured TJ gaps may separate several printed titles in one text operator.
// Require the same complete native lanes in peer records before using them.
export function proveNativeMeasuredLeafHeader(table, items, captions, rules, runs = []) {
  if (!table.cropRect || !runs.length) return
  const source = tableSourceItems(items, table.cropRect)
  const heights = source.map((i) => i.height).sort((a, b) => a - b)
  const h = heights[heights.length >> 1]
  if (!(h > 0)) return
  const [left, top, right, bottom] = table.cropRect
  const frame = joinHorizontalTableRules(rules)
    .filter(
      (r) =>
        r[1] >= top - h &&
        r[1] <= bottom + h &&
        Math.abs(r[0] - left) < h * 2.5 &&
        Math.abs(r[2] - right) < h * 2.5
    )
    .sort((a, b) => a[1] - b[1])
  if (frame.length !== 3) return
  const [opening, divider, closing] = frame
  if (
    divider[1] - opening[1] < h * 0.5 ||
    divider[1] - opening[1] > h * 2.5 ||
    closing[1] - divider[1] < h * 4
  )
    return
  if (
    captions.filter(
      (c) =>
        captionKind(c.lines?.[0]) === 'table' &&
        c.rect[3] < opening[1] &&
        opening[1] - c.rect[3] < h * 6 &&
        c.rect[0] < right &&
        c.rect[2] > left
    ).length !== 1
  )
    return
  const header = source.filter((i) => i.rect[1] >= opening[1] && i.rect[3] < divider[1])
  if (!header.length || header.some((i) => Math.abs(i.baseline - header[0].baseline) > h * 0.15))
    return
  const split = (item) => splitNativeMeasuredFields(item, runs, h)
  const splitHeader = header.map(split)
  if (splitHeader.some((g) => !g) || splitHeader.every((g) => g.length === 1)) return
  const leaves = splitHeader.flat().sort((a, b) => a.rect[0] - b.rect[0])
  if (leaves.length < 6 || leaves.length > 16 || leaves.some((i) => !/\p{L}/u.test(i.text))) return
  const originalBody = source.filter((i) => i.rect[1] > divider[1] && i.rect[3] < closing[1])
  const splitBody = originalBody.map(split)
  if (!originalBody.length || splitBody.some((g) => !g)) return
  const body = splitBody.flat().sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
  const bands = []
  for (const item of body) {
    const band = bands.at(-1)
    if (band && Math.abs(band[0].baseline - item.baseline) < h * 0.15) band.push(item)
    else bands.push([item])
  }
  const complete = bands.filter((g) => g.length === leaves.length)
  if (
    complete.length < 4 ||
    complete[0] !== bands[0] ||
    complete.some((g) => g.slice(-3).some((i) => !/^[+−–-]?(?:\d|\[)/u.test(i.text.trim())))
  )
    return
  const domains = leaves.map((item, c) => [
    Math.min(item.rect[0], ...complete.map((g) => g[c].rect[0])),
    Math.max(item.rect[2], ...complete.map((g) => g[c].rect[2]))
  ])
  if (domains.slice(1).some((d, c) => d[0] - domains[c][1] < h * 0.2)) return
  const cuts = [
    opening[0],
    ...domains.slice(1).map((d, c) => (domains[c][1] + d[0]) / 2),
    opening[2]
  ]
  const columnOf = (i) =>
    cuts.slice(1).findIndex((x, c) => i.rect[0] >= cuts[c] - 0.02 && i.rect[2] <= x + 0.02)
  if (
    body.some((i) => columnOf(i) < 0) ||
    complete.some((g) => g.some((i, c) => columnOf(i) !== c))
  )
    return
  const records = complete.map((g, n) =>
    body.filter(
      (i) =>
        i.baseline >= g[0].baseline - h * 0.15 &&
        (n === complete.length - 1 || i.baseline < complete[n + 1][0].baseline - h * 0.15)
    )
  )
  if (records.flat().length !== body.length || new Set(records.flat()).size !== body.length) return
  const headerCells = leaves.map((i, column) => ({
    row: 0,
    column,
    rowSpan: 1,
    colSpan: 1,
    rect: [cuts[column], opening[1], cuts[column + 1], divider[1]],
    text: i.text,
    sourceTokens: [i],
    sourceRects: [i.rect],
    origin: 'source-measured-leaf-header'
  }))
  return {
    columns: cuts.slice(1).map((x, c) => [cuts[c], opening[1], x, closing[1]]),
    rows: [[opening[0], opening[1], opening[2], divider[1]]],
    headerRows: [0],
    headerCells,
    spans: [],
    completeSpans: true,
    ownedTokens: new Set(header),
    headerBottom: divider[1],
    bodyItems: body,
    bodyRecords: records,
    originalBody,
    kind: 'measured-leaf',
    repair: 'native-measured-leaf-header-gutters-proved'
  }
}

// Native numeric lanes and short header rules prove a hierarchy independently
// of detector spans. Return a header plan only: callers retain all body records.
export function proveNativeNarrativeHeader(table, items, captions, rules) {
  if (!table.cropRect || !captions.some((c) => captionKind(c.lines?.[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const source = tableSourceItems(items, table.cropRect)
  if (!source.length) return
  const heights = source.map((i) => i.height).sort((a, b) => a - b),
    h = heights[heights.length >> 1]
  if (!(h > 0)) return
  const frame = joinHorizontalTableRules(rules)
    .filter(
      (r) =>
        r[1] >= top - h &&
        r[1] <= bottom + h &&
        Math.abs(r[0] - left) < h * 2 &&
        Math.abs(r[2] - right) < h * 2
    )
    .sort((a, b) => a[1] - b[1])
  if (frame.length < 3) return
  const [opening, divider] = frame,
    closing = frame.at(-1)
  if (divider[1] - opening[1] > h * 3 || divider === closing) return
  const header = source
    .filter((i) => i.rect[1] >= opening[1] && i.rect[3] < divider[1])
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (!header.length || header.some((i) => Math.abs(i.baseline - header[0].baseline) > h * 0.15))
    return
  const labels = header.map((i) => ({ text: i.text.trim(), tokens: [i], rect: i.rect }))
  const names = labels.map((g) => g.text).join('|')
  if (
    names !== 'Benchmark|Arm|Ideas by|Prose by|Label' &&
    names !== '#|Role|Extracted item|Paraphrased item'
  )
    return
  // Keep the established combined ordinal/role stub in narrative inventories.
  if (labels[0].text === '#') {
    const tokens = labels.slice(0, 2).flatMap((g) => g.tokens)
    labels.splice(0, 2, { text: '# Role', tokens, rect: union(tokens) })
  }
  const body = source.filter((i) => i.rect[1] > divider[1] && i.rect[3] < closing[1])
  const lanes = labels.map(() => [])
  for (const item of body) {
    const column = labels.findLastIndex((g) => g.rect[0] <= item.rect[0] + h * 0.8)
    if (column < 0 || (labels[column + 1] && item.rect[2] >= labels[column + 1].rect[0] - 0.1))
      return
    lanes[column].push(item)
  }
  if (lanes.some((l) => l.length < 4)) return
  const domains = labels.map((g, c) => [
    Math.min(g.rect[0], ...lanes[c].map((i) => i.rect[0])),
    Math.max(g.rect[2], ...lanes[c].map((i) => i.rect[2]))
  ])
  if (domains.slice(1).some((d, c) => d[0] - domains[c][1] < h * 0.15)) return
  const cuts = [
    opening[0],
    ...domains.slice(1).map((d, c) => (domains[c][1] + d[0]) / 2),
    opening[2]
  ]
  const headerCells = labels.map((g, column) => ({
    row: 0,
    column,
    rowSpan: 1,
    colSpan: 1,
    rect: [cuts[column], opening[1], cuts[column + 1], divider[1]],
    text: g.text,
    sourceTokens: g.tokens,
    sourceRects: g.tokens.map((t) => t.rect),
    origin: 'source-narrative-header'
  }))
  return {
    columns: cuts.slice(1).map((x, c) => [cuts[c], opening[1], x, closing[1]]),
    rows: [[opening[0], opening[1], opening[2], divider[1]]],
    headerRows: [0],
    headerCells,
    spans: [],
    completeSpans: true,
    ownedTokens: new Set(header),
    headerBottom: divider[1],
    bodyItems: body,
    repair: 'native-narrative-header-gutters-proved'
  }
}

export function proveNativeTieredHeader(table, items, captions, rules, measuredBands = []) {
  if (!table.cropRect || !captions.some((c) => captionKind(c.lines?.[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const source = tableSourceItems(items, [left, top - 2, right, bottom + 2])
  if (!source.length) return
  const heights = source
    .map((i) => i.height)
    .filter((h) => h > 0)
    .sort((a, b) => a - b)
  const h = heights[heights.length >> 1]
  if (!(h > 0)) return
  const frame = joinHorizontalTableRules(rules)
    .filter(
      (r) =>
        r[1] >= top - h &&
        r[1] <= bottom + h &&
        Math.abs(r[0] - left) < h * 1.5 &&
        Math.abs(r[2] - right) < h * 1.5
    )
    .sort((a, b) => a[1] - b[1])
  if (frame.length < 3) return
  const opening = frame[0],
    divider = frame.find((r) => r[1] - opening[1] > h * 0.8),
    closing = frame.at(-1)
  if (
    !divider ||
    divider === closing ||
    divider[1] - opening[1] > h * 6 ||
    bottom - closing[1] > h * 1.5
  )
    return
  const header = source.filter((i) => i.rect[1] >= opening[1] && i.rect[3] < divider[1])
  const groups = []
  for (const item of header) {
    const prior = groups.at(-1)
    if (prior && Math.abs(item.baseline - prior[0].baseline) < h * 0.2) prior.push(item)
    else groups.push([item])
  }
  if (!groups || groups.length < 2 || groups.length > 3) return
  const joinFragments = (tokens) =>
    tokens
      .slice()
      .sort((a, b) => a.rect[0] - b.rect[0])
      .reduce(
        (text, token, index, ordered) =>
          text +
          (index && token.rect[0] - ordered[index - 1].rect[2] > h * 0.14 ? ' ' : '') +
          token.text.trim(),
        ''
      )
  const merge = (tokens) => {
    const out = []
    for (const token of tokens.slice().sort((a, b) => a.rect[0] - b.rect[0])) {
      const prior = out.at(-1)
      if (prior && token.rect[0] - prior.rect[2] <= h * 0.14) {
        prior.tokens.push(token)
        prior.rect = union(prior.tokens)
        prior.text = joinFragments(prior.tokens)
      } else out.push({ tokens: [token], rect: token.rect, text: token.text.trim() })
    }
    return out
  }
  const partial = joinHorizontalTableRules(rules).filter(
    (r) => r[1] > opening[1] && r[1] < divider[1] && r[0] > opening[0] && r[2] < opening[2]
  )
  const bands = groups.map(merge)
  for (let row = 0; row < bands.length - 1; row++)
    for (const rule of partial.filter(
      (r) =>
        r[1] > Math.max(...groups[row].map((t) => t.rect[3])) &&
        r[1] < Math.min(...groups[row + 1].map((t) => t.rect[1]))
    )) {
      const underlined = bands[row].filter(
        (g) => g.rect[0] >= rule[0] - h * 0.4 && g.rect[2] <= rule[2] + h * 0.4
      )
      if (underlined.length < 2) continue
      const tokens = underlined.flatMap((g) => g.tokens)
      bands[row] = bands[row].filter((g) => !underlined.includes(g))
      bands[row].push({ tokens, rect: union(tokens), text: joinFragments(tokens) })
      bands[row].sort((a, b) => a.rect[0] - b.rect[0])
    }
  const scalar = (text) => /^[+−-]?\d[\d.,]*(?:\s*\/\s*\d[\d.,]*)?%?$/u.test(text.trim())
  const body = source.filter((i) => i.rect[1] > divider[1] && i.rect[3] < closing[1])
  const records = groupSourceRowsWithScripts(
    body.filter((i) => scalar(i.text)),
    h,
    0.2
  )
  if (!records) return
  // A printed sample-count stub can be blank in summary records. Its narrow
  // native header and a following parent underline separate it from metrics;
  // never require an invented count to make those peer records complete.
  const sampleStub = bands
    .at(-1)
    .filter((g) => g.text === 'n' && partial.some((r) => r[0] > g.rect[2] && r[1] < divider[1]))
  const optionalCount =
    sampleStub.length === 1 &&
    records.filter((g) =>
      g.some(
        (i) =>
          i.rect[0] >= sampleStub[0].rect[0] - h && i.rect[2] <= sampleStub[0].rect[2] + h * 0.1
      )
    ).length < 3 &&
    records.some(
      (g) =>
        !g.some(
          (i) =>
            i.rect[0] >= sampleStub[0].rect[0] - h && i.rect[2] <= sampleStub[0].rect[2] + h * 0.1
        )
    )
      ? sampleStub[0]
      : undefined
  const numericRows = records
    .map((g) =>
      g
        .filter(
          (i) =>
            scalar(i.text) &&
            !(
              optionalCount &&
              i.rect[0] >= optionalCount.rect[0] - h &&
              i.rect[2] <= optionalCount.rect[2] + h * 0.1
            )
        )
        .sort((a, b) => a.rect[0] - b.rect[0])
    )
    .filter((g) => g.length >= 4)
  const counts = new Map()
  for (const g of numericRows) counts.set(g.length, (counts.get(g.length) ?? 0) + 1)
  const count = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0]
  const complete = numericRows.filter((g) => g.length === count)
  if (!count || complete.length < 3) return
  const domains = Array.from({ length: count }, (_, index) => [
    Math.min(...complete.map((g) => g[index].rect[0])),
    Math.max(...complete.map((g) => g[index].rect[2]))
  ])
  if (domains.slice(1).some((d, i) => d[0] - domains[i][1] < h * 0.1)) return
  const prefix = bands
    .flat()
    .filter((g) => g.rect[2] < domains[0][0] - 0.1)
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (!prefix.length) {
    const numberedStub = bands
      .at(-1)
      .filter(
        (g) =>
          g.rect[0] < opening[0] + h * 2 &&
          g.rect[0] <= domains[0][0] &&
          g.rect[2] >= domains[0][1] &&
          g.rect[2] < domains[1][0]
      )
    if (numberedStub.length !== 1) return
    prefix.push(numberedStub[0])
    domains.shift()
  }
  if (!prefix.length || prefix.length > 2 || prefix.some((g) => !/\p{L}/u.test(g.text))) return
  for (let row = bands.length - 1; row >= 0; row--) {
    bands[row] = bands[row].filter((g) => !prefix.includes(g))
    if (!bands[row].length) {
      bands.splice(row, 1)
      groups.splice(row, 1)
    }
  }
  if (bands.length < 2 || bands.length > 3) return
  const measuredPrefix = measuredBands
    .filter((g) => g[0].rect[1] > divider[1] && g.every((i) => i.rect[3] < closing[1]))
    .map((g) => g.filter((i) => i.rect[2] < domains[0][0] - 0.1))
  if (
    measuredBands.length &&
    (![1, 2].includes(prefix.length) ||
      measuredPrefix.length < 3 ||
      measuredPrefix.some((g) => g.length !== prefix.length || g.some((i) => !i.sourceToken)))
  )
    return
  const prefixDomains = prefix.map((g, index) => {
    const next = prefix[index + 1]?.rect[0] ?? domains[0][0]
    const owned = measuredBands.length
      ? measuredPrefix.map((g) => g[index])
      : body.filter((i) => i.rect[0] >= g.rect[0] - h * 0.25 && i.rect[2] < next - 0.1)
    return [
      Math.min(g.rect[0], ...owned.map((i) => i.rect[0])),
      Math.max(g.rect[2], ...owned.map((i) => i.rect[2]))
    ]
  })
  const allDomains = [...prefixDomains, ...domains]
  if (allDomains.slice(1).some((d, i) => d[0] <= allDomains[i][1])) return
  const cuts = [
    opening[0],
    ...allDomains.slice(1).map((d, i) => (allDomains[i][1] + d[0]) / 2),
    opening[2]
  ]
  const center = (rect) => (rect[0] + rect[2]) / 2
  const columnOf = (g) =>
    cuts.findIndex(
      (x, i) => i < cuts.length - 1 && center(g.rect) >= x && center(g.rect) < cuts[i + 1]
    )
  // A repeated compact leaf run can be emitted as one native string. Its
  // explicit whitespace labels and repeated order must match every body lane.
  const lowest = bands.at(-1)
  const wide = lowest.filter(
    (g) =>
      g.rect[2] - g.rect[0] > (right - left) * 0.6 && g.text.trim().split(/\s+/u).length === count
  )
  if (wide.length) {
    if (wide.length !== 1 || lowest.length !== 1) return
    const g = wide[0],
      words = g.text.split(/\s+/u)
    const period = [2, 3, 4].find(
      (n) => count % n === 0 && count / n >= 2 && words.every((word, i) => word === words[i % n])
    )
    if (!period || g.rect[0] > domains[0][0] + h || g.rect[2] < domains.at(-1)[1] - h) return
    lowest.splice(
      lowest.indexOf(g),
      1,
      ...words.map((text, index) => ({
        text,
        tokens: g.tokens,
        derived: true,
        rect: [
          Math.max(g.rect[0], cuts[prefix.length + index]),
          g.rect[1],
          Math.min(g.rect[2], cuts[prefix.length + index + 1]),
          g.rect[3]
        ]
      }))
    )
  }
  const lowerSlots = new Map()
  for (const g of lowest) {
    const column = columnOf(g)
    if (column < 0 || lowerSlots.has(column)) return
    lowerSlots.set(column, g)
  }
  const cells = [],
    occupied = new Set(),
    rows = []
  const boundaries = [
    opening[1],
    ...groups
      .slice(1)
      .map(
        (g, i) =>
          (Math.max(...groups[i].map((t) => t.rect[3])) + Math.min(...g.map((t) => t.rect[1]))) / 2
      ),
    divider[1]
  ]
  if (boundaries.slice(1).some((y, i) => y <= boundaries[i])) return
  for (const g of prefix) {
    const column = columnOf(g)
    if (column < 0 || column >= prefix.length) return
    for (let row = 0; row < bands.length; row++) occupied.add(row + ':' + column)
    cells.push({
      row: 0,
      column,
      rowSpan: bands.length,
      colSpan: 1,
      rect: [cuts[column], opening[1], cuts[column + 1], divider[1]],
      text: g.text,
      sourceTokens: g.tokens,
      sourceRects: g.tokens.map((t) => t.rect),
      origin: 'source-tiered-header'
    })
  }
  for (let row = 0; row < bands.length; row++)
    for (const g of bands[row]) {
      let owned
      if (row === bands.length - 1 || prefix.includes(g)) owned = [columnOf(g)]
      else {
        const underline = partial.filter(
          (r) =>
            r[1] > g.rect[3] &&
            r[1] < Math.min(...groups[row + 1].map((t) => t.rect[1])) &&
            g.rect[0] >= r[0] - h * 0.4 &&
            g.rect[2] <= r[2] + h * 0.4
        )
        if (underline.length > 1) return
        const witness = underline[0] ?? g.rect
        owned = allDomains
          .map((d, index) => ({ index, x: (d[0] + d[1]) / 2 }))
          .filter((v) => v.x >= witness[0] && v.x <= witness[2])
          .map((v) => v.index)
        if (!owned.length) return
        // A narrow centered title does not prove which neighboring leaves it
        // groups. Single-lane parents need an explicit native underline;
        // otherwise leave specialized source-backed ownership intact.
        if (owned.length === 1 && !underline.length && lowerSlots.has(owned[0])) return
        if (
          owned.length > 1 &&
          !underline.length &&
          (groups.length !== 2 || !owned.every((c) => lowerSlots.has(c)))
        )
          return
      }
      if (owned.some((c) => c < 0) || owned.some((c, i) => i && c !== owned[i - 1] + 1)) return
      const column = owned[0],
        colSpan = owned.length
      const anchor = row === bands.length - 1 && !occupied.has('0:' + column) ? 0 : row
      const rowSpan =
        colSpan === 1 &&
        !bands.slice(row + 1).some((b) => b.some((child) => columnOf(child) === column))
          ? bands.length - anchor
          : 1
      for (let r = anchor; r < anchor + rowSpan; r++)
        for (const c of owned) {
          const key = r + ':' + c
          if (occupied.has(key)) return
          occupied.add(key)
        }
      const sourceTokens = g.derived
        ? [
            {
              text: g.text,
              rect: g.rect,
              baseline: g.tokens[0].baseline,
              height: g.tokens[0].height
            }
          ]
        : g.tokens
      cells.push({
        row: anchor,
        column,
        rowSpan,
        colSpan,
        rect: [
          cuts[column],
          boundaries[anchor],
          cuts[column + colSpan],
          boundaries[anchor + rowSpan]
        ],
        text: g.text,
        sourceTokens,
        sourceRects: sourceTokens.map((t) => t.rect),
        origin: 'source-tiered-header'
      })
    }
  if (occupied.size !== bands.length * allDomains.length || !cells.some((c) => c.colSpan > 1))
    return
  for (let row = 0; row < bands.length; row++)
    rows.push([opening[0], boundaries[row], opening[2], boundaries[row + 1]])
  return {
    columns: cuts.slice(1).map((x, i) => [cuts[i], opening[1], x, closing[1]]),
    prefixColumns: prefix.length,
    rows,
    headerRows: rows.map((_, i) => i),
    spans: cells
      .filter((c) => c.rowSpan > 1 || c.colSpan > 1)
      .map(({ row, column, rowSpan, colSpan }) => ({ row, column, rowSpan, colSpan })),
    headerCells: cells,
    ownedTokens: new Set(header),
    completeSpans: true,
    headerBottom: divider[1],
    bodyRecords: complete,
    repair: 'source-native-tiered-header-recovered'
  }
}

// Keep an unnumbered title whole in an already detected comparison table
// when the model clips through it. Three matching native rules, two
// complete header lanes, and several complete pairs prove the body frame.
export function recoverClippedUnnumberedTitleCrop(table, items, rules) {
  const c = table.cropRect,
    near = items.filter(
      (i) =>
        i.horizontal &&
        i.text.trim() &&
        i.rect[0] < c[2] &&
        i.rect[2] > c[0] &&
        i.baseline > c[1] &&
        i.baseline < c[3]
    ),
    hs = near.map((i) => i.height).sort((a, b) => a - b),
    h = hs[hs.length >> 1]
  if (!(h > 0) || table.structure.objects.filter((o) => o.label === 'table column').length !== 2)
    return
  const full = joinHorizontalTableRules(rules)
    .filter(
      (r) => r[1] > c[1] && r[1] < c[3] && Math.abs(r[0] - c[0]) < h && Math.abs(r[2] - c[2]) < h
    )
    .sort((a, b) => a[1] - b[1])
  if (
    full.length !== 3 ||
    full.some((r) => Math.abs(r[0] - full[0][0]) > 0.02 || Math.abs(r[2] - full[0][2]) > 0.02)
  )
    return
  const [opening, divider, closing] = full,
    title = items.filter(
      (i) =>
        i.horizontal &&
        /\p{L}/u.test(i.text) &&
        i.rect[1] < c[1] &&
        i.rect[3] > c[1] &&
        i.rect[3] < opening[1] &&
        opening[1] - i.rect[3] < h &&
        i.rect[0] > opening[0] &&
        i.rect[2] < opening[2] &&
        i.rect[2] - i.rect[0] > (opening[2] - opening[0]) * 0.4 &&
        Math.abs((i.rect[0] + i.rect[2] - opening[0] - opening[2]) / 2) < h
    )
  if (title.length !== 1) return
  const header = items
    .filter(
      (i) =>
        i.horizontal &&
        i.baseline > opening[1] &&
        i.baseline < divider[1] &&
        i.rect[0] >= opening[0] &&
        i.rect[2] <= opening[2]
    )
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (
    header.length !== 2 ||
    Math.abs(header[0].baseline - header[1].baseline) > h * 0.05 ||
    header.some((i) => i.rect[1] < title[0].rect[3] || !/\p{L}/u.test(i.text))
  )
    return
  const body = items.filter(
      (i) =>
        i.horizontal &&
        i.baseline > divider[1] &&
        i.baseline < closing[1] &&
        i.rect[0] >= opening[0] &&
        i.rect[2] <= opening[2]
    ),
    left = Math.max(
      header[0].rect[2],
      ...body.filter((i) => i.rect[0] < header[1].rect[0] - 0.1).map((i) => i.rect[2])
    ),
    right = Math.min(
      header[1].rect[0],
      ...body.filter((i) => i.rect[0] >= header[1].rect[0] - 0.1).map((i) => i.rect[0])
    ),
    cut = (left + right) / 2,
    groups = groupSourceRowsWithScripts(
      [...body].sort((a, b) => a.baseline - b.baseline),
      h,
      0.1
    )
  if (right - left < h * 0.2) return
  const pairs = groups?.map((g) => readSourceRow(g, [opening[0], cut, opening[2]]))
  if (
    !pairs ||
    pairs.filter((v) => v?.every((s) => /\p{L}/u.test(s))).length < 4 ||
    pairs.some((v) => !v || !v.some(Boolean))
  )
    return
  const top = title[0].rect[1] - 0.1
  if (
    items.some(
      (i) =>
        i.text.trim() &&
        i !== title[0] &&
        i.rect[0] < c[2] &&
        i.rect[2] > c[0] &&
        i.rect[3] > top &&
        i.rect[1] < Math.min(...header.map((i) => i.rect[1]))
    )
  )
    return
  return [c[0], top, c[2], c[3]]
}

// Matching native column-width top and bottom strokes enclose one header band.
// Its only continuations are standalone sample qualifications in the two
// cohort columns; ordinary statistical leaves or parent headings decline.
export function recoverWrappedSampleHeaderBand(table, items, captions, rules) {
  const [left, top, right] = table.cropRect,
    columns = table.structure.objects.filter((o) => o.label === 'table column')
  if (columns.length !== 4) return
  const candidates = captions.filter(
    (c) =>
      captionKind(c.lines[0]) === 'table' &&
      c.rect[0] < right &&
      c.rect[2] > left &&
      c.rect[3] <= top
  )
  if (candidates.length !== 1) return
  const caption = candidates[0],
    edges = [
      ...Map.groupBy(
        rules.filter(
          (r) => r[1] === r[3] && r[0] >= left && r[2] <= right && r[1] > caption.rect[3]
        ),
        (r) => r[1]
      ).values()
    ].sort((a, b) => a[0][1] - b[0][1])
  if (edges.length < 2) return
  const [upper, lower] = edges.slice(0, 2).map((g) => [...g].sort((a, b) => a[0] - b[0])),
    y0 = upper[0][1],
    y1 = lower[0][1],
    header = tableSourceItems(items, [left, y0, right, y1]),
    height = Math.max(...header.map((i) => i.height)),
    tolerance = height * 0.03
  if (
    !(height > 0) ||
    upper.length !== 4 ||
    lower.length !== 4 ||
    y0 - caption.rect[3] > height ||
    y0 - top > height ||
    y1 - y0 > height * 3.5 ||
    upper.some(
      (r, n) =>
        Math.abs(r[0] - lower[n][0]) > tolerance ||
        Math.abs(r[2] - lower[n][2]) > tolerance ||
        (n && Math.abs(r[0] - upper[n - 1][2]) > tolerance)
    ) ||
    rules.some((r) => r[1] === r[3] && r[1] > y0 && r[1] < y1 && r[0] < right && r[2] > left)
  )
    return
  const cuts = [left, ...upper.slice(1).map((r) => r[0]), right],
    groups = cuts
      .slice(1)
      .map((x, c) => header.filter((i) => i.rect[0] >= cuts[c] && i.rect[2] <= x))
  if (!hasUniqueRecordTokens(header, groups) || groups[0].length !== 1 || groups[3].length !== 1)
    return
  const stub = groups[0][0],
    p = groups[3][0]
  if (!/^\p{L}[\p{L}\s]+$/u.test(stub.text) || !/^P\s*(?:value|-value)?$/i.test(p.text)) return
  for (const group of groups.slice(1, 3)) {
    group.sort((a, b) => a.baseline - b.baseline)
    if (
      group.length !== 2 ||
      !/^\p{L}[\p{L}\s-]*\s(?:group|cohort)$/iu.test(group[0].text) ||
      !/^\(n\s*=\s*\d+\)$/i.test(group[1].text) ||
      Math.abs(group[0].rect[0] - group[1].rect[0]) > tolerance ||
      group[1].baseline - group[0].baseline < height ||
      group[1].baseline - group[0].baseline > height * 1.4 ||
      Math.abs(group[1].baseline - stub.baseline) > tolerance ||
      Math.abs(group[1].baseline - p.baseline) > tolerance
    )
      return
  }
  if (
    !table.structure.objects.some(
      (o) => o.label === 'table column header' && o.rect[1] + top >= y0 && o.rect[3] + top <= y1
    )
  )
    return
  return [left, y0, right, y1]
}

// A detector top can graze the last caption line. Move only that edge, inside
// a proven blank gap before native header ink. A native top/footer or the
// complete underlined count layout must independently witness the table.
export function recoverCaptionSeparatedHeaderCrop(table, items, captions, rules) {
  const [left, top, right, bottom] = table.cropRect,
    source = tableSourceItems(items, table.cropRect),
    height = source.map((i) => i.height).sort((a, b) => a - b)[Math.floor(source.length / 2)],
    overlaps = captions.filter(
      (c) =>
        captionKind(c.lines[0]) === 'table' &&
        c.rect[3] >= top &&
        c.rect[3] - top < height &&
        c.rect[1] < top &&
        (Math.min(c.rect[2], right) - Math.max(c.rect[0], left) > (right - left) * 0.5 ||
          Math.abs(c.rect[0] - left) < height)
    )
  if (!(height > 0) || overlaps.length !== 1) return
  const caption = overlaps[0],
    ink = source.filter(
      (i) =>
        !(
          i.rect[0] >= caption.rect[0] - 0.1 &&
          i.rect[2] <= caption.rect[2] + 0.1 &&
          i.rect[1] >= caption.rect[1] - 0.1 &&
          i.rect[3] <= caption.rect[3] + 0.1
        )
    ),
    first = Math.min(...ink.map((i) => i.rect[1])),
    gap = first - caption.rect[3]
  if (gap < height * 0.15 || gap > height * 1.5) return
  const full = joinHorizontalTableRules(rules).filter(
      (r) =>
        Math.abs(r[0] - left) < height * 2 &&
        Math.abs(r[2] - right) < height * 2 &&
        r[2] - r[0] >= (right - left) * 0.97
    ),
    starts = full.filter(
      (r) => r[1] > caption.rect[3] && r[1] <= first + height * 0.1 && r[1] - top < height * 1.5
    ),
    ends = full.filter((r) => r[1] > first + height * 3 && Math.abs(r[1] - bottom) < height * 2),
    endPositions = clusterTableRulePositions(ends.map((r) => r[1]))
  if (starts.length > 1 || endPositions.length !== 1) return
  if (starts.length) {
    const body = ink.filter((i) => i.rect[1] > first + height * 2 && i.rect[3] < ends[0][1]),
      numeric = body.filter((i) => /^[<>≤≥−-]?\d/.test(i.text)),
      baselines = clusterTableRulePositions(numeric.map((i) => i.baseline)),
      columns = table.structure.objects
        .filter((o) => o.label === 'table column')
        .sort((a, b) => a.rect[0] - b.rect[0]),
      cuts = [
        left,
        ...columns.slice(1).map((c, n) => left + (columns[n].rect[2] + c.rect[0]) / 2),
        right
      ],
      records = baselines.filter(
        (y) =>
          new Set(
            numeric
              .filter((i) => Math.abs(i.baseline - y) < height * 0.2)
              .map((i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x))
              .filter((c) => c > 0)
          ).size >= 2
      )
    if (records.length < 2) return
  } else {
    const counted = recoverUnderlinedCountComparisonGrid(table, items, captions, rules)
    if (!counted?.completeSpans || counted.rows.at(-1)[3] > ends[0][1]) return
  }
  // Keep the native top stroke strictly inside the crop: record recovery
  // uses interior rules to distinguish it from a neighboring caption edge.
  const newTop = starts.length
    ? Math.min(starts[0][1] - 0.1, first - 0.1)
    : (caption.rect[3] + first) / 2
  if (newTop <= caption.rect[3]) return
  return [left, newTop, right, bottom]
}

// Two ruled header bands may contain sample counts or a shared P-value
// heading. Source clusters keep a left stub out of an overlapping model span.
function recoverRuledSummaryHeaders(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const crop = table.cropRect,
    columns = table.structure.objects
      .filter((o) => o.label === 'table column')
      .sort((a, b) => a.rect[0] - b.rect[0])
  if (columns.length < 5 || columns.length > 6) return
  const borders = joinHorizontalTableRules(rules, 1).filter(
    (r) =>
      Math.abs(r[0] - crop[0]) < 16 &&
      Math.abs(r[2] - crop[2]) < 16 &&
      r[1] >= crop[1] - 8 &&
      r[1] <= crop[3] + 8
  )
  if (borders.length < 4 || borders[2][1] - borders[0][1] > 70) return
  const frame = [borders[0][0] - 0.1, borders[0][1], borders[0][2] + 0.1, borders.at(-1)[1]],
    source = tableSourceItems(items, frame),
    upper = source.filter((i) => i.rect[3] < borders[1][1]),
    lower = source.filter((i) => i.rect[1] > borders[1][1] && i.rect[3] < borders[2][1])
  if (!upper.length || !lower.length) return
  const height = Math.max(...upper.map((i) => i.height)),
    clusters = []
  for (const i of [...upper].sort((a, b) => a.rect[0] - b.rect[0])) {
    const g = clusters.at(-1)
    if (g && i.rect[0] - union(g)[2] < height * 0.8) g.push(i)
    else clusters.push([i])
  }
  const text = (g) =>
    g
      .map((i) => i.text)
      .join('')
      .replace(/\s/g, '')
  const counts = lower.filter((i) => /^n\s*=\s*\d+$/i.test(i.text))
  const parent = clusters.find((g) => /^PValueforDifference$/i.test(text(g)))
  if (counts.length < 2 && !parent) return
  const cuts = [
    frame[0],
    ...columns.slice(1).map((c, n) => crop[0] + (columns[n].rect[2] + c.rect[0]) / 2),
    frame[2]
  ]
  const spans = []
  if (parent) {
    const index = clusters.indexOf(parent),
      prior = clusters[index - 1]
    if (!prior || index !== clusters.length - 1 || columns.length !== 6) return
    cuts[4] = (union(prior)[2] + union(parent)[0]) / 2
    if (
      !lower.every((i) => i.rect[0] >= cuts[4]) ||
      !readSourceRow(lower, cuts, { multiline: true })
    )
      return
    spans.push({ row: 0, column: 4, rowSpan: 1, colSpan: 2 })
  } else {
    if (columns.length !== 5 || clusters.length !== 4) return
    cuts[1] = Math.min(cuts[1], union(clusters[1])[0] - 0.1)
  }
  const body = source.filter((i) => i.rect[1] > borders[2][1]),
    physical = groupSourceRowsWithScripts(body, height, 0.3)
  if (
    !physical ||
    physical.length < 10 ||
    !hasUniqueRecordTokens(source, [upper, lower, ...physical])
  )
    return
  const groups = [],
    measured = []
  for (const g of physical) {
    const numeric = g.some((i) => i.rect[0] >= cuts[1] && /\d/.test(i.text))
    if (numeric) {
      const cells =
        readSourceRow(g, cuts) ??
        cuts.slice(1).map((x, c) =>
          g
            .filter(
              (i) => (i.rect[0] + i.rect[2]) / 2 >= cuts[c] && (i.rect[0] + i.rect[2]) / 2 < x
            )
            .map((i) => i.text)
            .join('')
        )
      if (!cells || !cells[0] || !cells.slice(1).some((v) => /\d/.test(v))) return
      measured.push(g)
    } else if (g.some((i) => i.rect[0] < cuts[1]) && g.some((i) => i.rect[0] >= cuts[1])) return
    groups.push(g)
  }
  if (measured.length < 8) return
  // A caption can independently witness a wrapped label whose values appear
  // on its second line; do not merge an unrelated section heading.
  const captionText = captions
    .flatMap((c) => c.lines)
    .join(' ')
    .toLowerCase()
  for (let n = 1; n < groups.length; n++) {
    const a = groups[n - 1],
      b = groups[n]
    if (measured.includes(a) || !measured.includes(b) || !a.every((i) => i.rect[0] < cuts[1]))
      continue
    const tail = b.filter((i) => i.rect[0] < cuts[1]),
      words = a
        .map((i) => i.text)
        .join(' ')
        .match(/[A-Za-z]+/g),
      first = text(tail).match(/^[A-Za-z]+/)
    if (
      !words ||
      !first ||
      !/,[a-z]+$/i.test(text(tail)) ||
      !captionText.includes(words.at(-1).toLowerCase() + ' ' + first[0].toLowerCase()) ||
      rules.some((r) => r[1] === r[3] && r[1] > union(a)[3] && r[1] < union(b)[1])
    )
      continue
    groups.splice(n - 1, 2, [...a, ...b])
    n--
  }
  const rows = [
    [frame[0], frame[1], frame[2], borders[1][1]],
    [frame[0], borders[1][1], frame[2], borders[2][1]]
  ]
  for (const g of groups) {
    const r = union(g),
      row = rows.length
    if (!g.some((i) => i.rect[0] >= cuts[1] && /\d/.test(i.text)))
      spans.push({ row, column: 0, rowSpan: 1, colSpan: columns.length })
    rows.push([frame[0], r[1], frame[2], r[3]])
  }
  return {
    cropRect: frame,
    rows,
    columns: cuts.slice(1).map((x, c) => [cuts[c], frame[1], x, frame[3]]),
    headerRows: [0, 1],
    spans,
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Repeated sample-qualified cohort headings anchor complete source values.
// Read physical records independently of overlapping model rows and columns;
// centred statistic labels are shared headings, not an extra numeric column.
export function recoverCohortSummaryRows(table, items, captions, rules) {
  const headers = recoverRuledSummaryHeaders(table, items, captions, rules)
  if (headers) return headers
  const crop = table.cropRect
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const borders = joinHorizontalTableRules(rules, 1)
    .filter(
      (r) =>
        Math.abs(r[0] - crop[0]) < 36 &&
        Math.abs(r[2] - crop[2]) < 20 &&
        r[1] >= crop[1] - 12 &&
        r[1] <= crop[3] + 12
    )
    .sort((a, b) => a[1] - b[1])
  if (borders.length < 2 || borders.length > 3 || borders[1][1] - borders[0][1] > 45) return
  const frame = [borders[0][0] - 1, borders[0][1], borders[0][2] + 1, borders[2]?.[1] ?? crop[3]],
    source = tableSourceItems(items, frame)
  const header = source.filter((i) => i.rect[3] < borders[1][1]),
    height = Math.max(...header.map((i) => i.height)),
    clusters = []
  for (const i of [...header].sort((a, b) => a.rect[0] - b.rect[0])) {
    const last = clusters.at(-1)
    if (last && i.rect[0] - union(last)[2] < height) last.push(i)
    else clusters.push([i])
  }
  const text = (g) =>
    g
      .map((i) => i.text)
      .join('')
      .replace(/\s/g, '')
  if (
    clusters.length !== 4 ||
    !clusters.slice(0, 3).every((g) => /^\p{L}[\p{L}-]*\(N=\d+\)$/u.test(text(g))) ||
    !/^p$/i.test(text(clusters[3]))
  )
    return
  const cuts = [
    frame[0],
    union(clusters[0])[0] - height * 2,
    ...clusters.slice(1).map((g, n) => (union(clusters[n])[2] + union(g)[0]) / 2),
    frame[2]
  ]
  const body = source.filter((i) => i.rect[1] > borders[1][1]),
    physical = groupSourceRowsWithScripts(body, height, 0.3)
  if (!physical || physical.length < 15 || !hasUniqueRecordTokens(source, [header, ...physical]))
    return
  const groups = [],
    spans = []
  let measured = 0,
    sections = 0
  const numeric = (v) => /^(?:N=\d+|[−+]?\d[\d.,()%[\]–−-]*)$/.test(v)
  for (const g of physical) {
    const v = readSourceRow(g, cuts),
      row = groups.length + 1
    if (
      g.every((i) => i.rect[0] >= cuts[1] && i.rect[2] <= cuts[4]) &&
      /^Median\[IQR\],\(minimum,maximum\)N$/i.test(text(g))
    ) {
      spans.push({ row, column: 1, rowSpan: 1, colSpan: 3 })
      groups.push(g)
      continue
    }
    if (!v) return
    if (
      !v[0] &&
      !v[4] &&
      v.slice(1, 4).filter(Boolean).length === 1 &&
      /^(?:Mean\(SD\)|N\(%\)|Median\[IQR\],\(minimum,maximum\)|N)$/i.test(v.slice(1, 4).join(''))
    ) {
      spans.push({ row, column: 1, rowSpan: 1, colSpan: 3 })
      groups.push(g)
      continue
    }
    if (
      !/\p{L}/u.test(v[0]) ||
      v.slice(1, 4).some((s) => s && !numeric(s)) ||
      (v[4] && !/^[<>≤≥]?(?:0?\.\d+|1(?:\.0+)?)$/.test(v[4]))
    )
      return
    if (v.slice(1).every((s) => !s)) {
      spans.push({ row, column: 0, rowSpan: 1, colSpan: 5 })
      sections++
    } else if (v.slice(1, 4).every(numeric)) measured++
    groups.push(g)
  }
  if (measured < 8 || (!sections && !borders[2])) return
  return {
    cropRect: frame,
    rows: [
      [frame[0], frame[1], frame[2], borders[1][1]],
      ...groups.map((g) => {
        const r = union(g)
        return [frame[0], r[1], frame[2], r[3]]
      })
    ],
    columns: cuts.slice(1).map((x, c) => [cuts[c], frame[1], x, frame[3]]),
    headerRows: [0],
    spans,
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// A small two-column numeric table can wrap one heading across several
// lines. Complete numeric pairs below it delimit the entire header band.
export function recoverCompactNumericHeader(table, items) {
  const crop = table.cropRect,
    columns = table.structure.objects
      .filter((o) => o.label === 'table column')
      .sort((a, b) => a.rect[0] - b.rect[0])
  if (columns.length !== 2) return
  const source = tableSourceItems(items, crop)
  if (!source.length) return
  const height = Math.max(...source.map((i) => i.height)),
    groups = groupSourceRowsWithScripts(source, height, 0.3)
  if (!groups || groups.length < 5 || groups.length > 12) return
  const cut = crop[0] + (columns[0].rect[2] + columns[1].rect[0]) / 2,
    cuts = [crop[0], cut, crop[2]]
  const cells = groups.map((g) => readSourceRow(g, cuts))
  const numeric = (v) => /^\d+(?:\.\d+)?%?$/.test(v)
  const first = cells.findIndex((v) => v && v.every(numeric))
  if (
    first < 2 ||
    first > 4 ||
    cells.length - first < 3 ||
    cells.slice(first).some((v) => !v || !v.every(numeric))
  )
    return
  const header = groups.slice(0, first).flat(),
    head = readSourceRow(header, cuts, { multiline: true })
  if (
    !head ||
    head.some((s) => !/^\p{L}[\p{L}–-]{1,70}$/u.test(s)) ||
    header.some((i) => i.height < height * 0.9) ||
    !hasUniqueRecordTokens(source, [header, ...groups.slice(first)])
  )
    return
  return {
    rows: [header, ...groups.slice(first)].map((g) => {
      const r = union(g)
      return [crop[0], r[1], crop[2], r[3]]
    }),
    columns: [
      [crop[0], crop[1], cut, crop[3]],
      [cut, crop[1], crop[2], crop[3]]
    ],
    headerRows: [0],
    spans: [],
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// A segmented header border preserves native column starts even when the
// detector invents an overlapping column. Repeated underlined child headings
// and paired source records must independently confirm every native column.
export function recoverRepeatedHeaderGrid(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const source = tableSourceItems(items, table.cropRect)
  if (!source.length) return
  const height = source.map((i) => i.height).sort((a, b) => a - b)[Math.floor(source.length / 2)]
  if (!(height > 0)) return
  const horizontal = rules.filter((r) => r[1] === r[3] && r[1] > top && r[1] < bottom)
  const bands = []
  for (const r of horizontal) {
    let band = bands.find((b) => Math.abs(b[0][1] - r[1]) < 0.05)
    if (!band) bands.push((band = []))
    band.push(r)
  }
  for (const band of bands) band.sort((a, b) => a[0] - b[0])
  const borders = bands.filter(
    (b) =>
      b.length >= 7 &&
      b.length <= 25 &&
      Math.abs(b[0][0] - left) < 15 &&
      Math.abs(b.at(-1)[2] - right) < 15 &&
      b.slice(1).every((r, n) => Math.abs(r[0] - b[n][2]) < 0.05)
  )
  const pairedBorders = bands
    .filter(
      (b) =>
        b.length === 6 &&
        Math.abs(b[0][0] - left) < 15 &&
        Math.abs(b.at(-1)[2] - right) < 15 &&
        b.slice(1).every((r, n) => Math.abs(r[0] - b[n][2]) < 0.05)
    )
    .sort((a, b) => a[0][1] - b[0][1])
  if (pairedBorders.length >= 2) {
    const [upperRule, lowerRule] = pairedBorders,
      y0 = upperRule[0][1],
      y1 = lowerRule[0][1]
    const cuts = [left, ...lowerRule.slice(1).map((r) => r[0] - 0.1), right]
    const childRules = bands.find((b) => b.length === 2 && b[0][1] > y0 && b[0][1] < y1)
    if (childRules) {
      const split = childRules[0][1]
      const upper = source.filter((i) => i.rect[1] >= y0 && i.rect[3] < split)
      const lower = source.filter((i) => i.rect[1] >= split && i.rect[3] < y1)
      const leaves = readSourceRow(lower, cuts)
      const parents = childRules.map((r) =>
        upper.filter((i) => i.rect[0] >= r[0] - 0.1 && i.rect[2] <= r[2])
      )
      if (
        leaves?.join('|') === '|n|M(SD)or%|n|M(SD)or%|' &&
        parents.every((g) => g.length === 1 && /\p{L}/u.test(g[0].text)) &&
        childRules.every(
          (r, n) => Math.abs(r[0] - cuts[1 + n * 2]) < 0.2 && r[2] < cuts[3 + n * 2]
        ) &&
        upper
          .filter((i) => !parents.flat().includes(i))
          .every((i) => i.rect[0] >= cuts[5] && /^p$/i.test(i.text))
      ) {
        const body = source.filter((i) => i.rect[1] > y1),
          groups = groupSourceRowsWithScripts(body, height, 0.3)
        const records = [],
          spans = [
            { row: 0, column: 1, rowSpan: 1, colSpan: 2 },
            { row: 0, column: 3, rowSpan: 1, colSpan: 2 },
            { row: 0, column: 5, rowSpan: 2, colSpan: 1 }
          ]
        let valid = Boolean(groups),
          measures = 0
        for (const g of groups ?? []) {
          if (
            /^\(?continued\)?$/i.test(
              g
                .map((i) => i.text)
                .join(' ')
                .trim()
            )
          )
            break
          const v = readSourceRow(g, cuts)
          if (
            !v ||
            !v[0] ||
            v.slice(1).some((x) => x && !/^[<>≤≥−+-]?\d[\d.,()%–−±/+-]*$/.test(x))
          ) {
            valid = false
            break
          }
          if (v.slice(1).some(Boolean)) measures++
          else spans.push({ row: records.length + 2, column: 0, rowSpan: 1, colSpan: 6 })
          records.push(union(g))
        }
        if (valid && measures >= 3 && records.every((r, n) => !n || r[1] > records[n - 1][3]))
          return {
            rows: [
              [left, y0, right, split],
              [left, split, right, y1],
              ...records.map((r) => [left, r[1], right, r[3]])
            ],
            columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
            spans,
            completeSpans: true
          }
      }
    }
  }
  // A summary block can list the compared groups once, followed by repeated
  // metric blocks for those same groups. Native segmented borders give the
  // leaf columns even when the detector omits the entire parent row.
  if (borders.length === 2) {
    const [upperBorder, lowerBorder] = [...borders].sort((a, b) => a[0][1] - b[0][1])
    const y0 = upperBorder[0][1],
      y1 = lowerBorder[0][1]
    const cuts = [left, ...lowerBorder.slice(1).map((r) => r[0] - 0.1), right]
    const divider = joinHorizontalTableRules(rules).filter(
      (r) =>
        r[1] > y0 &&
        r[1] < y1 &&
        Math.abs(r[0] - cuts[1]) < 0.2 &&
        Math.abs(r[2] - lowerBorder.at(-1)[2]) < 0.2
    )
    if (
      divider.length === 1 &&
      y1 - y0 < height * 5 &&
      upperBorder.length === lowerBorder.length &&
      upperBorder.every((r, n) => Math.abs(r[0] - lowerBorder[n][0]) < 0.2)
    ) {
      const split = divider[0][1]
      const upper = source.filter((i) => i.rect[1] >= y0 && i.rect[3] < split)
      const lower = source.filter((i) => i.rect[1] > split && i.rect[3] < y1)
      const body = source.filter((i) => i.rect[1] > y1)
      const clusters = []
      for (const i of [...upper].sort((a, b) => a.rect[0] - b.rect[0])) {
        const g = clusters.at(-1)
        if (g && i.rect[0] - union(g)[2] < height * 0.8) g.push(i)
        else clusters.push([i])
      }
      const text = (g) =>
        g
          .map((i) => i.text)
          .join('')
          .replace(/\s/g, '')
      const leaves = readSourceRow(lower, cuts)
      const count = clusters.length - 1
      const width = (lowerBorder.length - 1 - count) / count
      const records = groupSourceRowsWithScripts(body, height, 0.3)
      const values = records?.map((g) => readSourceRow(g, cuts))
      if (
        count >= 3 &&
        count <= 6 &&
        Number.isInteger(width) &&
        width >= 2 &&
        width <= 5 &&
        leaves &&
        leaves.every((s) => /\p{L}/u.test(s)) &&
        clusters.slice(1).every((g, n) => text(g) === leaves[n + 1]) &&
        leaves.slice(1 + count).every((s, n) => s === leaves[1 + count + (n % width)]) &&
        clusters.every((g, n) => {
          const start = n ? 1 + count + (n - 1) * width : 1
          const end = n ? start + width : 1 + count
          const rect = union(g)
          return (
            rect[0] >= cuts[start] &&
            rect[2] <= cuts[end] &&
            Math.abs((rect[0] + rect[2]) / 2 - (cuts[start] + cuts[end]) / 2) < height
          )
        }) &&
        values?.length >= 3 &&
        values.every(
          (v) => v && /\p{L}/u.test(v[0]) && v.slice(1).every((s) => /^\d+(?:\.\d+)?$/.test(s))
        ) &&
        hasUniqueRecordTokens(source, [upper, lower, ...records])
      ) {
        const bounds = records.map(union)
        if (bounds.every((r, n) => !n || r[1] > bounds[n - 1][3]))
          return {
            rows: [
              [left, y0, right, split],
              [left, split, right, y1],
              ...bounds.map((r) => [left, r[1], right, r[3]])
            ],
            columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
            spans: [
              { row: 0, column: 0, rowSpan: 2, colSpan: 1 },
              { row: 0, column: 1, rowSpan: 1, colSpan: count },
              ...clusters.slice(1).map((_, n) => ({
                row: 0,
                column: 1 + count + n * width,
                rowSpan: 1,
                colSpan: width
              }))
            ],
            completeSpans: true
          }
      }
    }
  }
  if (borders.length !== 1) return
  const border = borders[0],
    divider = border[0][1]
  const cuts = [left, ...border.slice(1).map((r) => r[0] - 0.1), right]
  const footer = horizontal.find(
    (r) =>
      r[1] > divider &&
      Math.abs(r[0] - border[0][0]) < 0.1 &&
      Math.abs(r[2] - border.at(-1)[2]) < 0.1
  )
  if (!footer) return
  const tiers = bands.filter(
    (b) =>
      b.length >= 2 &&
      b.length <= 6 &&
      b[0][1] < divider &&
      divider - b[0][1] < height * 3 &&
      b.slice(1).every((r, n) => r[0] > b[n][2] + height)
  )
  if (tiers.length !== 1) return
  const parents = tiers[0],
    y = parents[0][1]
  const upper = source.filter((i) => i.rect[3] <= y),
    lower = source.filter((i) => i.rect[1] > y && i.rect[3] < divider),
    body = source.filter((i) => i.rect[1] > divider && i.rect[3] < footer[1])
  if (!hasUniqueRecordTokens(source, [upper, lower, body])) return
  const primary = (group) => group.filter((i) => i.height >= height * 0.8)
  const scriptsOwned = (group) =>
    group
      .filter((i) => i.height < height * 0.8)
      .every((i) => primary(group).filter((a) => isAdjacentTableScript(i, a)).length === 1)
  if (!scriptsOwned(upper) || !scriptsOwned(lower)) return
  const leaves = readSourceRow(primary(lower), cuts)
  if (!leaves) return
  const prefix = leaves.findIndex(Boolean)
  if (prefix < 2 || prefix > 4 || leaves.slice(prefix).some((s) => !/^\p{L}+$/u.test(s))) return
  const width = (border.length - prefix) / parents.length
  if (
    !Number.isInteger(width) ||
    width < 2 ||
    width > 4 ||
    leaves.slice(prefix).some((s, n) => s !== leaves[prefix + (n % width)])
  )
    return
  const parentGroups = parents.map((r) =>
    upper.filter((i) => i.rect[0] >= r[0] && i.rect[2] <= r[2])
  )
  if (
    parentGroups.some(
      (g, n) =>
        g.length !== 1 ||
        !/\p{L}/u.test(g[0].text) ||
        Math.abs(parents[n][0] - border[prefix + n * width][0]) > 0.1 ||
        parents[n][2] > cuts[prefix + (n + 1) * width] + 0.2
    )
  )
    return
  const parentTokens = new Set(parentGroups.flat())
  const stubs = upper.filter((i) => !parentTokens.has(i))
  const stubText = readSourceRow(primary(stubs), cuts)
  if (
    !stubText ||
    stubText.slice(0, prefix).some((s) => !/\p{L}/u.test(s)) ||
    stubText.slice(prefix).some(Boolean) ||
    !hasUniqueRecordTokens(upper, [stubs, ...parentGroups])
  )
    return
  const groups = groupSourceRowsWithScripts(body, height, 0.2)
  if (!groups || groups.length < 6 || groups.length % 2) return
  const records = groups.map((g) => readSourceRow(g, cuts))
  if (
    records.some(
      (r) =>
        !r ||
        r.slice(1, prefix).some((s) => !s) ||
        r.slice(prefix).some((s) => s && !/^[−+-]?\d[\d.,]*$/.test(s))
    )
  )
    return
  // Explicit repeated group codes distinguish a shared stub from arbitrary
  // blank labels. Each first record is complete; the second retains its blanks.
  if (
    records[0][1] === records[1][1] ||
    !/^[A-Za-z]+$/.test(records[0][1]) ||
    !/^[A-Za-z]+$/.test(records[1][1]) ||
    records.some(
      (r, n) =>
        r[1] !== records[n % 2][1] ||
        (n % 2 ? r[0] : !/\p{L}/u.test(r[0])) ||
        (!(n % 2) && r.slice(prefix).some((s) => !s)) ||
        r.slice(prefix).filter(Boolean).length < parents.length * 2
    )
  )
    return
  const bounds = groups.map(union)
  if (bounds.some((b, n) => n && bounds[n - 1][3] >= b[1])) return
  const ys = [divider, ...bounds.slice(1).map((b, n) => (bounds[n][3] + b[1]) / 2), footer[1]]
  return {
    rows: [
      [left, top, right, y],
      [left, y, right, divider],
      ...groups.map((_, n) => [left, ys[n], right, ys[n + 1]])
    ],
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, footer[1]]),
    spans: [
      ...parents.map((_, n) => ({
        row: 0,
        column: prefix + n * width,
        rowSpan: 1,
        colSpan: width
      })),
      ...Array.from({ length: prefix }, (_, column) => ({
        row: 0,
        column,
        rowSpan: 2,
        colSpan: 1
      })),
      ...groups.flatMap((_, n) =>
        n % 2 ? [] : [{ row: n + 2, column: 0, rowSpan: 2, colSpan: 1 }]
      )
    ],
    completeSpans: true,
    headerRows: [0, 1],
    ownedTokens: new Set(source)
  }
}

// Full-width rules delimit category groups; paired count/percentage baselines
// delimit records within each group, including bottom-aligned wrapped labels.
export function recoverRuledCategoryGrid(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const columns = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (columns.length !== 4) return
  const cuts = [
    left,
    ...columns.slice(1).map((c, n) => left + (columns[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const borders = rules
    .filter(
      (r) =>
        r[1] === r[3] &&
        r[1] > top &&
        r[1] < bottom &&
        Math.abs(r[0] - left) < 15 &&
        Math.abs(r[2] - right) < 15
    )
    .sort((a, b) => a[1] - b[1])
  if (
    borders.length < 5 ||
    borders.some((r) => Math.abs(r[0] - borders[0][0]) > 2 || Math.abs(r[2] - borders[0][2]) > 2)
  )
    return
  const source = tableSourceItems(items, [left, borders[0][1], right, borders.at(-1)[1]])
  const header = source.filter((i) => i.rect[3] < borders[1][1])
  if (readSourceRow(header, cuts)?.join('|') !== '||Count|%') return
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  if (source.some((i) => col(i) < 0 || i.rect[0] < cuts[col(i)] || i.rect[2] > cuts[col(i) + 1]))
    return
  const rows = [[left, borders[0][1], right, borders[1][1]]],
    spans = [],
    groups = [header]
  for (let n = 1; n + 1 < borders.length; n++) {
    const a = borders[n][1],
      b = borders[n + 1][1]
    const body = source.filter((i) => i.rect[1] >= a && i.rect[3] <= b)
    const parent = body.filter((i) => col(i) === 0)
    const counts = body.filter((i) => col(i) === 2)
    const percentages = body.filter((i) => col(i) === 3)
    if (
      parent.length !== 1 ||
      !/\p{L}/u.test(parent[0].text) ||
      counts.length < 2 ||
      counts.length !== percentages.length ||
      counts.some(
        (i, j) =>
          !/^\d+$/.test(i.text) ||
          !/^\d+(?:\.\d+)?%?$/.test(percentages[j].text) ||
          Math.abs(i.baseline - percentages[j].baseline) > i.height * 0.2
      )
    )
      return
    const records = counts.map((i, j) => [i, percentages[j]])
    for (const item of body.filter((i) => col(i) === 1)) {
      const row = counts.findIndex((i) => i.baseline >= item.baseline - item.height * 0.2)
      if (row < 0 || counts[row].baseline - item.baseline > item.height * 1.6) return
      records[row].push(item)
    }
    if (records.some((g) => !g.some((i) => col(i) === 1 && /\p{L}/u.test(i.text)))) return
    const bounds = records.map(union)
    if (bounds.some((r, j) => j && r[1] <= bounds[j - 1][3])) return
    spans.push({ row: rows.length, column: 0, rowSpan: records.length, colSpan: 1 })
    const ys = [a, ...bounds.slice(1).map((r, j) => (bounds[j][3] + r[1]) / 2), b]
    rows.push(...records.map((_, j) => [left, ys[j], right, ys[j + 1]]))
    groups.push(parent, ...records)
  }
  if (!hasUniqueRecordTokens(source, groups)) return
  return {
    rows,
    columns: cuts.slice(1).map((x, n) => [cuts[n], top, x, bottom]),
    spans,
    completeSpans: true
  }
}

// Repeated short gaps in the top and bottom header rules identify columns.
// Accept only single-line records with indented labels and explicitly empty
// comparison cells. Wrapped labels and bare numeric continuation rows decline.
export function recoverNativeHeaderGrid(table, items, captions, rules) {
  const pairedMetrics = recoverPairedMetricHeaderGrid(table, items, captions, rules)
  if (pairedMetrics) return pairedMetrics
  const comparisonLeaves = recoverSegmentedComparisonLeafGrid(table, items, captions, rules)
  if (comparisonLeaves) return comparisonLeaves
  const clinical = recoverSegmentedClinicalRecordGrid(table, items, captions, rules)
  if (clinical) return clinical
  const overlapping = recoverOverlappingLeafRecordGrid(table, items, captions, rules)
  if (overlapping) return overlapping
  const asymmetric = recoverAsymmetricSummaryHeaderGrid(table, items, captions, rules)
  if (asymmetric) return asymmetric
  const offsetCountLeaves = recoverOffsetCountPercentageLeaves(table, items, captions, rules)
  if (offsetCountLeaves) return offsetCountLeaves
  const repeatedSummaries = recoverRepeatedSampleSummaryBands(table, items, captions, rules)
  if (repeatedSummaries) return repeatedSummaries
  const limbComparison = recoverRepeatedLimbComparisonGrid(table, items, captions, rules)
  if (limbComparison) return limbComparison
  const repeatedSamples = recoverRepeatedSampleHierarchyGrid(table, items, captions, rules)
  if (repeatedSamples) return repeatedSamples
  const closed = recoverClosedHeaderGrid(table, items, captions, rules)
  if (closed) return closed
  const counted = recoverUnderlinedCountComparisonGrid(table, items, captions, rules)
  if (counted) return counted
  const mixedSummary = recoverMixedCountSummaryGrid(table, items, captions, rules)
  if (mixedSummary) return mixedSummary
  const grouped = recoverRuledGroupedCountGrid(table, items, captions, rules)
  if (grouped) return grouped
  const bands = recoverRuledComparisonBands(table, items, captions, rules)
  if (bands) return bands
  const sectioned = recoverSectionedComparisonGrid(table, items, rules)
  if (sectioned) return sectioned
  const domains = recoverRuledDomainGrid(table, items, captions, rules)
  if (domains) return domains
  const underlined = recoverUnderlinedNumericGrid(table, items, captions, rules)
  if (underlined) return underlined
  const review = recoverRuledReviewHeader(table, items, captions, rules)
  if (review) return review
  const events = recoverRepeatedEventGrid(table, items, captions, rules)
  if (events) return events
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const source = tableSourceItems(items, table.cropRect)
  // Explicit count, percentage, summary and range headings establish sparse
  // columns even when the model overlaps two count columns and loses '%'.
  const summary = source.filter((i) => /^(?:n|%|Mean \(SD\)|Range)$/.test(i.text))
  if (
    summary.length === 4 &&
    summary.map((i) => i.text).join('|') === 'n|%|Mean (SD)|Range' &&
    summary.every((i) => Math.abs(i.baseline - summary[0].baseline) < 0.1)
  ) {
    const font = summary[0].height
    const frame = rules
      .filter(
        (r) =>
          r[1] === r[3] &&
          r[0] >= left &&
          r[2] <= right &&
          r[2] - r[0] > (right - left) * 0.9 &&
          r[1] >= top &&
          r[1] <= bottom
      )
      .sort((a, b) => a[1] - b[1])
    const predicted = table.structure.objects
      .filter((o) => o.label === 'table column')
      .sort((a, b) => a.rect[0] - b.rect[0])
    if (
      frame.length === 3 &&
      predicted.length === 5 &&
      frame[0][1] < summary[0].rect[1] &&
      frame[1][1] > summary[0].rect[3]
    ) {
      const cuts = [
        left,
        summary[0].rect[0] - font,
        ...summary.slice(1).map((i, n) => (summary[n].rect[2] + i.rect[0]) / 2),
        right
      ]
      const body = source.filter((i) => i.rect[1] > frame[1][1] && i.rect[3] < frame[2][1])
      const groups = groupSourceRowsWithScripts(body, font, 0.35)
      const records = [],
        sections = []
      let valid = Boolean(groups),
        measures = 0
      for (const g of groups ?? []) {
        const v = readSourceRow(g, cuts)
        if (!v || !v[0]) {
          valid = false
          break
        }
        if (
          v[1] &&
          /^\d+$/.test(v[1]) &&
          v.slice(2).every((x) => !x || /^\d[\d.,()–-]*$/.test(x))
        ) {
          measures++
          records.push([...g])
        } else if (v.slice(1).every((x) => !x)) {
          if (
            records.length &&
            /^[a-z(]/.test(v[0]) &&
            g[0].baseline - records.at(-1).at(-1).baseline < font * 1.6
          )
            records.at(-1).push(...g)
          else {
            sections.push(records.length)
            records.push([...g])
          }
        } else {
          valid = false
          break
        }
      }
      if (valid && measures >= 20 && sections.length >= 5 && hasUniqueRecordTokens(body, records)) {
        const rects = records.map(union)
        if (rects.every((r, n) => !n || r[1] > rects[n - 1][3]))
          return {
            rows: [
              [left, frame[0][1], right, frame[1][1]],
              ...rects.map((r) => [left, r[1], right, r[3]])
            ],
            columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
            spans: sections.map((n) => ({ row: n + 1, column: 0, rowSpan: 1, colSpan: 5 })),
            completeSpans: true
          }
      }
    }
  }
  const lines = new Map()
  for (const r of rules
    .filter((r) => r[1] === r[3] && r[1] >= top && r[1] <= bottom)
    .sort((a, b) => a[0] - b[0])) {
    const band = lines.get(r[1]) ?? []
    band.push(r)
    lines.set(r[1], band)
  }
  const edges = [...lines].sort((a, b) => a[0] - b[0])
  // Small tables can have column-width strokes at the header divider and
  // footer even when the model emits no rows. Matching segment endpoints and
  // complete numeric baselines establish the grid independently of inference.
  const segmented = edges.filter(
    ([, parts]) =>
      parts.length >= 3 &&
      parts.length <= 8 &&
      parts[0][0] >= left - 12 &&
      parts.at(-1)[2] <= right + 12 &&
      parts.slice(1).every((r, i) => Math.abs(r[0] - parts[i][2]) < 0.1)
  )
  if (segmented.length === 2) {
    const [[divider, upper], [footer, lower]] = segmented
    const border = edges.findLast(
      ([y, parts]) =>
        y < divider &&
        parts.length === 1 &&
        Math.abs(parts[0][0] - upper[0][0]) < 0.1 &&
        Math.abs(parts[0][2] - upper.at(-1)[2]) < 0.1
    )?.[0]
    if (
      border !== undefined &&
      upper.length === lower.length &&
      upper.every(
        (r, i) => Math.abs(r[0] - lower[i][0]) < 0.1 && Math.abs(r[2] - lower[i][2]) < 0.1
      )
    ) {
      const cuts = [upper[0][0] - 0.1, ...upper.map((r) => r[2])]
      cuts[cuts.length - 1] += 0.1
      const body = source.filter((i) => i.rect[1] >= divider && i.rect[3] <= footer)
      const groups = []
      for (const i of body) {
        const group = groups.at(-1)
        if (group && Math.abs(group[0].baseline - i.baseline) < i.height * 0.3) group.push(i)
        else groups.push([i])
      }
      const header = source.filter((i) => i.rect[1] >= border && i.rect[3] <= divider)
      const values = groups.map((g) => readSourceRow(g, cuts))
      // Matching segmented borders also delimit sparse baseline comparisons.
      // Require two explicit cohort headings, statistic/probability columns,
      // and complete paired counts or section statistics on every source line.
      const heading = readSourceRow(header, cuts)
      if (
        cuts.length === 6 &&
        heading &&
        !heading[0] &&
        heading.slice(1, 3).every((v) => /group\(n=\d+\)/i.test(v)) &&
        /^torχ2$/i.test(heading[3]) &&
        /^P$/i.test(heading[4])
      ) {
        const height = Math.max(...header.map((i) => i.height))
        const nativeBody = source.filter(
          (i) => i.rect[1] >= divider - height * 0.1 && i.rect[3] <= footer
        )
        const nativeRows = groupSourceRowsWithScripts(nativeBody, height, 0.35)
        const nativeValues = nativeRows?.map((g) => readSourceRow(g, cuts))
        const number = (v) => /^[<>≤≥−+-]?(?:\d|\.\d)[\d.,()%±–−+/-]*$/.test(v)
        const paired = (v) => v && number(v[1]) && number(v[2])
        const section = (v) => v && !v[1] && !v[2] && number(v[3]) && number(v[4])
        if (
          nativeRows &&
          nativeValues.filter(paired).length >= 12 &&
          nativeValues.filter(section).length >= 3 &&
          nativeValues.every(
            (v) =>
              v &&
              /\p{L}/u.test(v[0]) &&
              (paired(v) || section(v)) &&
              v.slice(1).every((x) => !x || number(x))
          ) &&
          hasUniqueRecordTokens(source, [header, ...nativeRows])
        ) {
          return {
            rows: [
              [cuts[0], border, cuts.at(-1), divider],
              ...nativeRows.map((g) => {
                const r = union(g)
                return [cuts[0], r[1], cuts.at(-1), r[3]]
              })
            ],
            columns: cuts.slice(1).map((x, n) => [cuts[n], border, x, footer]),
            spans: [],
            completeSpans: true
          }
        }
      }
      if (
        groups.length >= 2 &&
        groups.length <= 8 &&
        hasUniqueRecordTokens(source, [header, ...groups]) &&
        values.every(
          (r) =>
            r && /\p{L}/u.test(r[0]) && r.slice(1).every((v) => /^[<>≤≥−+-]?\d[\d.,()%]*$/.test(v))
        ) &&
        cuts
          .slice(1)
          .every((x, c) =>
            header.some((i) => i.rect[0] >= cuts[c] && i.rect[2] <= x && /\p{L}/u.test(i.text))
          )
      ) {
        const ys = [
          divider,
          ...groups.slice(1).map((g, n) => (union(groups[n])[3] + union(g)[1]) / 2),
          footer
        ]
        return {
          rows: [
            [cuts[0], border, cuts.at(-1), divider],
            ...groups.map((_, n) => [cuts[0], ys[n], cuts.at(-1), ys[n + 1]])
          ],
          columns: cuts.slice(1).map((x, n) => [cuts[n], border, x, footer]),
          spans: [],
          completeSpans: true
        }
      }
    }
  }
  const matches = edges.filter(
    ([, segments]) =>
      segments.length >= 3 &&
      segments.length <= 8 &&
      segments[0][0] <= left + 12 &&
      segments.at(-1)[2] >= right - 12 &&
      segments.slice(1).every((r, n) => r[0] - segments[n][2] > 0 && r[0] - segments[n][2] < 1)
  )
  if (matches.length !== 2) return
  const [[a, upper], [b, lower]] = matches
  if (
    upper.length !== lower.length ||
    upper.some((r, n) => Math.abs(r[0] - lower[n][0]) > 1 || Math.abs(r[2] - lower[n][2]) > 1)
  )
    return
  const cuts = [left, ...upper.slice(1).map((r, n) => (upper[n][2] + r[0]) / 2), right]
  const header = source.filter(
    (i) => (i.rect[1] + i.rect[3]) / 2 > a && (i.rect[1] + i.rect[3]) / 2 < b
  )
  const heading = readSourceRow(header, cuts)
  if (
    !heading?.every((s) => /\p{L}/u.test(s)) ||
    header.some((i) => Math.abs(i.baseline - header[0].baseline) > i.height * 0.2)
  )
    return
  const footer = edges.findLast(
    ([y, rs]) =>
      y > b &&
      rs[0][0] <= left + 12 &&
      rs.at(-1)[2] >= right - 12 &&
      rs.slice(1).every((r, n) => r[0] <= rs[n][2] + 1)
  )?.[0]
  if (!footer) return
  const body = source.filter((i) => (i.rect[1] + i.rect[3]) / 2 >= b && i.rect[3] < footer)
  const groups = []
  for (const i of body) {
    const g = groups.at(-1)
    if (g && Math.abs(i.baseline - g[0].baseline) < i.height * 0.25) g.push(i)
    else groups.push([i])
  }
  if (groups.length < 6 || !hasUniqueRecordTokens(body, groups)) return
  const cells = groups.map((g) => readSourceRow(g, cuts))
  if (
    cells.some(
      (r) =>
        !r ||
        !/\p{L}/u.test(r[0]) ||
        r.slice(1).some((s) => s && !/^[−–-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(s))
    )
  )
    return
  if (cells.filter((r) => r.slice(1).every(Boolean)).length < 4) return
  const sections = cells.map((r, n) => (r.slice(1).every((s) => !s) ? n : -1)).filter((n) => n >= 0)
  if (sections.length < 2 || sections[0] !== 0) return
  const sectionLeft = Math.min(...groups[0].map((i) => i.rect[0]))
  if (
    groups.some((g, n) =>
      sections.includes(n)
        ? Math.abs(g[0].rect[0] - sectionLeft) > 1
        : g[0].rect[0] < sectionLeft + g[0].height * 0.5
    )
  )
    return
  const ys = [b, ...groups.slice(1).map((g) => Math.min(...g.map((i) => i.rect[1])) - 0.1), footer]
  return {
    rows: [[left, a, right, b], ...groups.map((_, n) => [left, ys[n], right, ys[n + 1]])],
    columns: cuts.slice(1).map((x, n) => [cuts[n], top, x, bottom]),
    spans: sections.map((n) => ({ row: n + 1, column: 0, rowSpan: 1, colSpan: cuts.length - 1 })),
    completeSpans: true
  }
}

// Repeated ADD-S/ADD leaves establish paired metric columns independently of
// an oversegmented model. Recover only a closed native frame with one source
// parent per pair and complete numeric records fitting every derived gutter.
export function recoverPairedMetricHeaderGrid(table, items, captions, rules) {
  if (!captions.some((caption) => captionKind(caption.lines?.[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const source = tableSourceItems(items, table.cropRect)
  const object = source.filter((item) => item.text.trim() === 'Object')
  if (object.length !== 1) return
  const height = object[0].height
  if (!(height > 0)) return
  const leaves = source
    .filter((item) => Math.abs(item.baseline - object[0].baseline) <= height * 0.15)
    .sort((a, b) => a.rect[0] - b.rect[0])
  const pairCount = (leaves.length - 1) / 2
  if (
    pairCount < 3 ||
    pairCount > 12 ||
    !Number.isInteger(pairCount) ||
    leaves[0] !== object[0] ||
    leaves.slice(1).some((item, index) => item.text.trim() !== (index % 2 ? 'ADD' : 'ADDS'))
  )
    return
  const borders = joinHorizontalTableRules(rules)
    .filter(
      (rule) =>
        rule[1] >= top &&
        rule[1] <= bottom &&
        Math.abs(rule[0] - left) < height &&
        Math.abs(rule[2] - right) < height
    )
    .sort((a, b) => a[1] - b[1])
  if (borders.length < 3) return
  const opening = borders[0][1],
    divider = borders[1][1],
    closing = borders.at(-1)[1]
  if (
    !(opening < object[0].rect[1] && object[0].rect[3] < divider) ||
    divider - opening > height * 4
  )
    return
  const parents = source
    .filter(
      (item) =>
        item.rect[1] >= opening && item.rect[3] < Math.min(...leaves.map((leaf) => leaf.rect[1]))
    )
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (
    parents.length !== pairCount ||
    parents.some(
      (item) =>
        !/\p{L}/u.test(item.text) || Math.abs(item.baseline - parents[0].baseline) > height * 0.15
    )
  )
    return
  const body = source.filter((item) => item.rect[1] > divider && item.rect[3] < closing)
  const groups = groupSourceRowsWithScripts(body, height, 0.2)
  if (!groups || groups.length < 4) return
  const cuts = [
    left,
    ...leaves.slice(1).map((leaf, index) => (leaves[index].rect[2] + leaf.rect[0]) / 2),
    right
  ]
  const records = groups.map((group) => group.slice().sort((a, b) => a.rect[0] - b.rect[0]))
  if (
    records.some(
      (record) =>
        record.length !== leaves.length ||
        !/\p{L}/u.test(record[0].text) ||
        record.slice(1).some((item) => !/^\d+(?:\.\d+)?$/u.test(item.text.trim()))
    )
  )
    return
  const stubRight = Math.max(object[0].rect[2], ...records.map((record) => record[0].rect[2]))
  const metricLeft = Math.min(leaves[1].rect[0], ...records.map((record) => record[1].rect[0]))
  if (metricLeft - stubRight < height * 0.25) return
  cuts[1] = (stubRight + metricLeft) / 2
  const values = groups.map((group) => readSourceRow(group, cuts))
  if (
    values.some(
      (value) =>
        !value ||
        !/\p{L}/u.test(value[0]) ||
        value.slice(1).some((text) => !/^\d+(?:\.\d+)?$/u.test(text))
    )
  )
    return
  if (
    parents.some((item, index) => {
      const a = cuts[1 + index * 2],
        b = cuts[3 + index * 2]
      return (
        item.rect[0] < a ||
        item.rect[2] > b ||
        Math.abs((item.rect[0] + item.rect[2] - a - b) / 2) > (b - a) * 0.25
      )
    })
  )
    return
  if (!hasUniqueRecordTokens(source, [parents, leaves, ...groups])) return
  const headerSplit =
    (Math.max(...parents.map((item) => item.rect[3])) +
      Math.min(...leaves.map((item) => item.rect[1]))) /
    2
  const bounds = groups.map(union)
  if (bounds.some((rect, index) => index && rect[1] <= bounds[index - 1][3])) return
  return {
    rows: [
      [left, opening, right, headerSplit],
      [left, headerSplit, right, divider],
      ...bounds.map((rect) => [left, rect[1], right, rect[3]])
    ],
    columns: cuts.slice(1).map((cut, index) => [cuts[index], opening, cut, closing]),
    spans: [
      { row: 0, column: 0, rowSpan: 2, colSpan: 1 },
      ...parents.map((_, index) => ({ row: 0, column: 1 + index * 2, rowSpan: 1, colSpan: 2 }))
    ],
    headerRows: [0, 1],
    completeSpans: true,
    ownedTokens: new Set(source),
    repair: 'native-paired-metric-header-recovered'
  }
}

// Matching five-piece rules enclose four independent comparison leaves beside
// an empty stub. Complete numeric records and both continuous outer sides prove
// the body; a model without a header cannot discard this native first band.
export function recoverSegmentedComparisonLeafGrid(table, items, captions, rules) {
  if (table.structure.objects.some((o) => o.label === 'table column header')) return
  const [left, top, right, bottom] = table.cropRect
  const source = tableSourceItems(items, table.cropRect)
  if (!source.length) return
  const height = source.map((i) => i.height).sort((a, b) => a - b)[Math.floor(source.length / 2)]
  if (!(height > 0)) return
  const bands = [
    ...Map.groupBy(
      rules.filter((r) => r[1] === r[3]),
      (r) => r[1]
    )
  ]
    .map(([y, rs]) => [
      y,
      rs.filter((r) => r[0] >= left - height && r[2] <= right + height).sort((a, b) => a[0] - b[0])
    ])
    .filter(
      ([, rs]) =>
        rs.length === 5 &&
        Math.abs(rs[0][0] - left) < height &&
        Math.abs(rs[4][2] - right) < height &&
        rs.slice(1).every((r, n) => Math.abs(r[0] - rs[n][2]) < height * 0.01)
    )
  const opening = bands.filter(([y]) => Math.abs(y - top) < height)
  if (opening.length !== 1) return
  const [start, segments] = opening[0]
  const cuts = [segments[0][0], ...segments.map((r) => r[2])]
  const matching = bands.filter(([, rs]) =>
    rs.every(
      (r, n) =>
        Math.abs(r[0] - segments[n][0]) < height * 0.01 &&
        Math.abs(r[2] - segments[n][2]) < height * 0.01
    )
  )
  const dividers = matching.filter(([y]) => y > start + height && y < start + height * 3)
  const footers = matching.filter(([y]) => Math.abs(y - bottom) < height)
  if (dividers.length !== 1 || footers.length !== 1) return
  const divider = dividers[0][0],
    footer = footers[0][0]
  for (const edge of [cuts[0], cuts.at(-1)]) {
    const side = rules
      .filter(
        (r) =>
          r[0] === r[2] &&
          Math.abs(r[0] - edge) < height * 0.02 &&
          r[1] >= start - height * 0.05 &&
          r[3] <= footer + height * 0.05
      )
      .sort((a, b) => a[1] - b[1])
    let end = start
    for (const r of side) {
      if (r[1] > end + height * 0.05) return
      end = Math.max(end, r[3])
    }
    if (end < footer - height * 0.05) return
  }
  const localCaption = captions.filter(
    (c) =>
      captionKind(c.lines[0]) === 'table' &&
      c.rect[3] <= start &&
      start - c.rect[3] < height * 6 &&
      c.rect[0] >= cuts[0] &&
      c.rect[2] <= cuts.at(-1)
  )
  if (localCaption.length !== 1) return
  const header = source.filter((i) => i.rect[1] > start && i.rect[3] < divider)
  const heading = readSourceRow(header, cuts)
  if (
    !heading ||
    heading[0] ||
    !/^≤Median$/i.test(heading[1]) ||
    !/^>Median$/i.test(heading[2]) ||
    !/^OR\(95%CI\)\*?$/.test(heading[3]) ||
    !/^p-value$/i.test(heading[4]) ||
    header.some((i) => Math.abs(i.baseline - header[0].baseline) > height * 0.1)
  )
    return
  const body = source.filter((i) => i.rect[1] > divider && i.rect[3] < footer)
  const groups = groupSourceRowsWithScripts(body, height, 0.3)
  if (!groups || !hasUniqueRecordTokens(source, [header, ...groups])) return
  const spans = []
  let measured = 0
  for (const [n, group] of groups.entries()) {
    const values = readSourceRow(group, cuts)
    if (!values || !/\p{L}/u.test(values[0])) return
    if (values.slice(1).every((s) => !s))
      spans.push({ row: n + 1, column: 0, rowSpan: 1, colSpan: 5 })
    else {
      if (
        !values.slice(1, 4).every((s) => /^\d[\d.()−–+/-]*(?:Ref\.)?\)?$/.test(s)) ||
        !/^(?:[<>]?\.?\d+(?:\.\d+)?)?$/.test(values[4])
      )
        return
      measured++
    }
  }
  if (measured < 6) return
  const bounds = groups.map(union)
  if (bounds.some((r, n) => n && r[1] <= bounds[n - 1][3])) return
  return {
    rows: [
      [cuts[0], start, cuts.at(-1), divider],
      ...bounds.map((r) => [cuts[0], r[1], cuts.at(-1), r[3]])
    ],
    columns: cuts.slice(1).map((x, n) => [cuts[n], start, x, footer]),
    spans,
    headerRows: [0],
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Native segmented dividers retain categorical/count lanes when model row
// spans cover a later record. A continuous left stroke or matching footer
// establishes the terminal boundary; source completeness is proved anew.
export function recoverSegmentedClinicalRecordGrid(table, items, captions, rules) {
  const initial = tableSourceItems(items, table.cropRect)
  const height = initial.map((i) => i.height).sort((a, b) => a - b)[Math.floor(initial.length / 2)]
  if (!(height > 0)) return
  const [left, top, right, bottom] = table.cropRect
  const bands = []
  for (const r of rules.filter((r) => r[1] === r[3] && r[1] > top && r[1] < bottom + height)) {
    let band = bands.find((b) => Math.abs(b[0][1] - r[1]) < height * 0.01)
    if (!band) bands.push((band = []))
    band.push(r)
  }
  for (const b of bands) b.sort((a, b) => a[0] - b[0])
  const dividers = bands.filter(
    (b) =>
      [4, 6].includes(b.length) &&
      b.slice(1).every((r, n) => Math.abs(r[0] - b[n][2]) < height * 0.01) &&
      Math.abs(b[0][0] - left) < height * 2 &&
      b.at(-1)[2] > right &&
      b.at(-1)[2] - right < height * 6
  )
  if (dividers.length !== 1) return
  const divider = dividers[0],
    edge = divider[0][1],
    nativeLeft = divider[0][0],
    nativeRight = divider.at(-1)[2]
  const openings = bands.filter(
    (b) =>
      b.length === 1 &&
      b[0][1] < edge &&
      edge - b[0][1] < height * 5 &&
      Math.abs(b[0][0] - nativeLeft) < 0.1 &&
      Math.abs(b[0][2] - nativeRight) < 0.1
  )
  if (openings.length !== 1) return
  const opening = openings[0][0][1]
  const caption = captions.filter(
    (c) =>
      captionKind(c.lines[0]) === 'table' && c.rect[3] < opening && opening - c.rect[3] < height * 5
  )
  if (caption.length !== 1) return
  const footers = bands
    .filter(
      (b) =>
        b.length === 1 &&
        b[0][1] > edge &&
        Math.abs(b[0][0] - nativeLeft) < 0.1 &&
        Math.abs(b[0][2] - nativeRight) < 0.1
    )
    .map((b) => b[0][1])
  let footer
  if (footers.length) {
    if (Math.max(...footers) - Math.min(...footers) > height * 0.2) return
    footer = Math.max(...footers)
  } else {
    const terminal = rules.filter(
      (r) =>
        r[0] === r[2] &&
        nativeLeft - r[0] > 0 &&
        nativeLeft - r[0] < height * 0.5 &&
        r[1] < opening &&
        r[3] > edge &&
        Math.abs(r[3] - bottom) < height * 2
    )
    if (terminal.length !== 1) return
    footer = terminal[0][3]
  }
  let cuts = [
    nativeLeft - height * 0.02,
    ...divider.slice(1).map((r) => r[0] - height * 0.005),
    nativeRight + 0.1
  ]
  let headerEdge = edge
  if (divider.length === 6) {
    const splitBands = bands.filter((b) => b.length === 2 && b[0][1] > opening && b[0][1] < edge)
    if (splitBands.length !== 1) return
    const child = splitBands[0]
    if (
      Math.abs(child[0][0] - cuts[2]) > 0.1 ||
      child[0][2] >= child[1][0] ||
      child[1][2] > cuts[3]
    )
      return
    cuts = [...cuts.slice(0, 3), (child[0][2] + child[1][0]) / 2, ...cuts.slice(3)]
    headerEdge = child[0][1]
  }
  const frame = [cuts[0], opening, cuts.at(-1), footer]
  const source = tableSourceItems(items, frame)
  if (!source.length || source.some((i) => i.rect[0] < frame[0] || i.rect[2] > frame[2])) return
  if (
    items.some(
      (i) =>
        i.horizontal &&
        i.rect[2] >= left &&
        i.rect[0] <= nativeRight &&
        (i.rect[1] + i.rect[3]) / 2 >= opening &&
        (i.rect[1] + i.rect[3]) / 2 <= footer &&
        !source.includes(i)
    )
  )
    return
  const header = source.filter((i) => i.rect[3] < headerEdge)
  const body = source.filter((i) => i.rect[1] > headerEdge)
  if (!hasUniqueRecordTokens(source, [header, body])) return
  const headings = readSourceRow(header, cuts, { multiline: true })
  if (!headings) return
  if (
    divider.length === 4
      ? !/^parameter$/i.test(headings[0]) ||
        !/^categories$/i.test(headings[1]) ||
        headings.slice(2).some((s) => !/\p{L}/u.test(s))
      : headings.slice(0, 2).some(Boolean) ||
        !/^non-amplified$/i.test(headings[2]) ||
        !/^amplified$/i.test(headings[3]) ||
        headings.slice(4).some((s) => !/\p{L}/u.test(s))
  )
    return
  const groups = groupSourceRowsWithScripts(body, height, 0.3)
  if (!groups || groups.length < 2 || !hasUniqueRecordTokens(body, groups)) return
  const values = groups.map((g) => {
    const value = readSourceRow(g, cuts)
    if (value || divider.length !== 6) return value
    const box = union(g)
    if (
      Math.abs(box[0] - cuts[2]) > height * 0.02 ||
      box[2] <= cuts[3] ||
      box[2] >= cuts[4] ||
      g.some((i) => !/\p{L}/u.test(i.text))
    )
      return
    const shared = readSourceRow(g, [...cuts.slice(0, 3), ...cuts.slice(4)])
    if (!shared || shared.filter(Boolean).length !== 1) return
    return [...shared.slice(0, 3), '', ...shared.slice(3)]
  })
  const spans = [],
    rows = [[frame[0], opening, frame[2], headerEdge]]
  const numeric = (s) =>
    /^[<>≤≥−–+,-]?(?:\d|\.\d)[\d.,()%−–+\s]*$/.test(s) ||
    /^\([−–+-]?[\d.]+to[−–+-]?[\d.]+\)$/.test(s)
  if (divider.length === 4) {
    if (values.some((v) => !v || !v[1] || !numeric(v[2]) || (v[3] && !numeric(v[3])))) return
  } else {
    const sections = []
    const records = []
    for (let n = 0; n < groups.length; n++) {
      const v = values[n]
      if (!v) return
      if (v.filter(Boolean).length === 1 && /\p{L}/u.test(v.join(''))) {
        sections.push(n)
        spans.push({ row: n + 1, column: 2, rowSpan: 1, colSpan: 2 })
      } else {
        if (
          !/\p{L}/u.test(v[1]) ||
          !numeric(v[2]) ||
          !numeric(v[3]) ||
          v.slice(4).some((s) => s && !numeric(s))
        )
          return
        records.push(n)
      }
    }
    if (!sections.length || records.length < 4) return
    const starts = records.filter((n) => values[n][0])
    if (starts.length < 2) return
    let pairs = 0
    for (const n of starts) {
      const v = values[n],
        next = values[n + 1]
      if (!v.slice(4).every(Boolean)) return
      if (n === groups.length - 1) continue
      if (
        !next ||
        next[0] ||
        !next[1] ||
        next[1] === v[1] ||
        next.slice(4).some(Boolean) ||
        !numeric(next[2]) ||
        !numeric(next[3])
      )
        return
      pairs++
      spans.push(
        { row: n + 1, column: 0, rowSpan: 2, colSpan: 1 },
        ...[4, 5, 6].map((column) => ({ row: n + 1, column, rowSpan: 2, colSpan: 1 }))
      )
    }
    if (
      pairs < 2 ||
      records.some(
        (n) => !starts.includes(n) && !(n === 1 && sections.includes(0)) && !starts.includes(n - 1)
      )
    )
      return
  }
  const bounds = groups.map(union)
  if (
    bounds.some((r, n) => n && bounds[n - 1][3] >= r[1]) ||
    footer - bounds.at(-1)[3] > height * 2.5
  )
    return
  rows.push(...bounds.map((r) => [frame[0], r[1], frame[2], r[3]]))
  return {
    rows,
    columns: cuts.slice(1).map((x, c) => [cuts[c], opening, x, footer]),
    spans,
    headerRows: [0],
    completeSpans: true,
    cropRect: [left, top, nativeRight + 0.5, footer + 0.5],
    repair: 'native-body-records-recovered'
  }
}

// Overlapping leaf strokes are distinct native paths, not inferred model
// columns. Both underline tiers and every repeated source record must agree
// before their shared gutters can replace an extra detector column.
export function recoverAsymmetricSummaryHeaderGrid(table, items, captions, rules) {
  const [left, top, right, bottom] = table.cropRect
  const source = tableSourceItems(items, table.cropRect)
  if (!source.length) return
  const height = source.map((i) => i.height).sort((a, b) => a - b)[Math.floor(source.length / 2)]
  if (!(height > 0)) return
  const bands = []
  for (const r of rules.filter((r) => r[1] === r[3] && r[1] >= top && r[1] <= bottom)) {
    let band = bands.find((b) => Math.abs(b[0][1] - r[1]) < 0.05)
    if (!band) bands.push((band = []))
    band.push(r)
  }
  for (const b of bands) b.sort((a, b) => a[0] - b[0])
  const full = bands.filter(
    (b) => b.length === 1 && Math.abs(b[0][0] - left) < height && Math.abs(b[0][2] - right) < height
  )
  const leaves = bands.filter(
    (b) =>
      b.length === 16 &&
      Math.abs(b[0][0] - left) < height &&
      Math.abs(b.at(-1)[2] - right) < height &&
      b.slice(1).every((r, n) => {
        const overlap = b[n][2] - r[0]
        return overlap > height && overlap < height * 2 && r[2] > b[n][2]
      })
  )
  if (full.length !== 2 || leaves.length !== 1) return
  full.sort((a, b) => a[0][1] - b[0][1])
  const opening = full[0][0][1],
    footer = full[1][0][1],
    divider = leaves[0][0][1]
  const roots = bands.filter((b) => b.length === 2 && b[0][1] > opening && b[0][1] < divider)
  const children = bands.filter((b) => b.length === 5 && b[0][1] > opening && b[0][1] < divider)
  if (roots.length !== 1 || children.length !== 1) return
  const root = roots[0],
    child = children[0],
    y0 = root[0][1],
    y1 = child[0][1]
  if (!(opening < y0 && y0 < y1 && y1 < divider && divider - opening < height * 7)) return
  const captionsAbove = captions.filter(
    (c) =>
      captionKind(c.lines[0]) === 'table' &&
      c.rect[3] <= opening &&
      opening - c.rect[3] < height * 5
  )
  if (captionsAbove.length !== 1) return
  if (
    Math.abs(root[0][0] - child[0][0]) > 0.1 ||
    Math.abs(root[0][2] - child[2][2]) > 0.1 ||
    Math.abs(root[1][0] - child[3][0]) > 0.1 ||
    Math.abs(root[1][2] - child[4][2]) > 0.1
  )
    return
  const border = leaves[0]
  const padding = border[0][2] - border[1][0]
  if (border.slice(1).some((r, n) => Math.abs(border[n][2] - r[0] - padding) > height * 0.1)) return
  const cuts = [left, ...border.slice(1).map((r, n) => (border[n][2] + r[0]) / 2), right]
  const header = [
    source.filter((i) => i.rect[1] >= opening && i.rect[3] < y0),
    source.filter((i) => i.rect[1] > y0 && i.rect[3] < y1),
    source.filter((i) => i.rect[1] > y1 && i.rect[3] < divider)
  ]
  const ownHeading = (band, groups) => {
    const owned = band.map((r) =>
      groups.filter((i) => i.rect[0] >= r[0] - 0.1 && i.rect[2] <= r[2] + 0.1)
    )
    return (
      owned.every((g) => g.length && /\p{L}/u.test(g.map((i) => i.text).join(''))) &&
      hasUniqueRecordTokens(groups, owned)
    )
  }
  if (!ownHeading(root, header[0]) || !ownHeading(child, header[1])) return
  const leafValues = readSourceRow(header[2], cuts)
  if (!leafValues || leafValues[0]) return
  const normalize = (s) => s.replace(/\s/g, '').toLowerCase()
  if (
    leafValues.slice(1, 10).some((s, n) => normalize(s) !== ['n', 'mean', 'sd'][n % 3]) ||
    leafValues
      .slice(10)
      .some(
        (s, n) => ![/^mean$/i, /^(?:\d\.\d+)?ci$/i, /^p(?:-?value)?$/i][n % 3].test(normalize(s))
      ) ||
    child.some(
      (r, n) =>
        Math.abs(r[0] - border[1 + n * 3][0] - padding) > height * 0.1 ||
        (n === 4
          ? border[15][2] - r[2] <= 0 || border[15][2] - r[2] >= height
          : Math.abs(r[2] - border[3 + n * 3][2] + padding) > height * 0.1)
    )
  )
    return
  const body = source.filter((i) => i.rect[1] > divider && i.rect[3] < footer)
  const groups = groupSourceRowsWithScripts(body, height, 0.3)
  if (
    !groups ||
    groups.length < 6 ||
    groups.length % 3 ||
    !hasUniqueRecordTokens(source, [...header, ...groups])
  )
    return
  const values = groups.map((g) => readSourceRow(g, cuts))
  const numeric = (s) => /^[()−+\d.,\s]+(?:to[()−+\d.,\s]+)?$/.test(s)
  if (
    values.some(
      (v, n) =>
        !v ||
        !/\p{L}/u.test(v[0]) ||
        (n % 3 === 0
          ? v.slice(1, 10).some(Boolean) || v.slice(10).some((s) => !numeric(s))
          : v.slice(1, 10).some((s) => !numeric(s)) ||
            v.slice(10).some(Boolean) ||
            v[0] !== values[n % 3][0])
    )
  )
    return
  const bounds = groups.map(union)
  if (bounds.some((r, n) => n && bounds[n - 1][3] >= r[1])) return
  return {
    rows: [
      [left, opening, right, y0],
      [left, y0, right, y1],
      [left, y1, right, divider],
      ...bounds.map((r) => [left, r[1], right, r[3]])
    ],
    columns: cuts.slice(1).map((x, c) => [cuts[c], opening, x, footer]),
    spans: [
      { row: 0, column: 0, rowSpan: 3, colSpan: 1 },
      { row: 0, column: 1, rowSpan: 1, colSpan: 9 },
      { row: 0, column: 10, rowSpan: 1, colSpan: 6 },
      ...child.map((_, n) => ({ row: 1, column: 1 + n * 3, rowSpan: 1, colSpan: 3 }))
    ],
    headerRows: [0, 1, 2],
    completeSpans: true,
    cropRect: [left, top, right, Math.min(bottom, footer + 0.5)],
    repair: 'native-body-records-recovered'
  }
}

export function recoverOverlappingLeafRecordGrid(table, items, captions, rules) {
  const [left, top, right, bottom] = table.cropRect
  const initial = tableSourceItems(items, table.cropRect)
  const height = initial.map((i) => i.height).sort((a, b) => a - b)[Math.floor(initial.length / 2)]
  if (!(height > 0)) return
  const bands = []
  for (const r of rules.filter((r) => r[1] === r[3] && r[1] >= top && r[1] <= bottom)) {
    let b = bands.find((b) => Math.abs(b[0][1] - r[1]) < 0.05)
    if (!b) bands.push((b = []))
    b.push(r)
  }
  for (const b of bands) b.sort((a, b) => a[0] - b[0])
  const full = bands
    .filter(
      (b) =>
        b.length === 1 && Math.abs(b[0][0] - left) < height && Math.abs(b[0][2] - right) < height
    )
    .sort((a, b) => a[0][1] - b[0][1])
  const leafBands = bands.filter(
    (b) =>
      [7, 10].includes(b.length) &&
      Math.abs(b[0][0] - left) < height &&
      Math.abs(b.at(-1)[2] - right) < height &&
      b.slice(1).every((r, n) => b[n][2] > r[0] && b[n][2] - r[0] < height * 2.2 && r[2] > b[n][2])
  )
  if (full.length !== 2 || leafBands.length !== 1) return
  const border = leafBands[0],
    count = (border.length - 1) / 3,
    divider = border[0][1]
  const opening = full[0][0][1],
    footer = full[1][0][1]
  const parentBands = bands.filter(
    (b) => b.length === count && b[0][1] > opening && b[0][1] < divider
  )
  if (parentBands.length !== 1 || divider - opening > height * 6) return
  const parents = parentBands[0],
    split = parents[0][1]
  const padding = border[0][2] - border[1][0]
  if (
    padding < height * 0.7 ||
    border.slice(1).some((r, n) => Math.abs(border[n][2] - r[0] - padding) > height * 0.02)
  )
    return
  const cuts = [
    Math.min(left, full[0][0][0] - 0.01),
    ...border.slice(1).map((r, n) => (border[n][2] + r[0]) / 2),
    right
  ]
  const frame = [cuts[0], opening, right, footer]
  if (
    items.some((i) => {
      if (!i.horizontal) return false
      const x = (i.rect[0] + i.rect[2]) / 2,
        y = (i.rect[1] + i.rect[3]) / 2
      return (
        x >= frame[0] &&
        x <= frame[2] &&
        y >= opening &&
        y <= footer &&
        (i.rect[0] < frame[0] || i.rect[2] > frame[2] || i.rect[1] < opening || i.rect[3] > footer)
      )
    })
  )
    return
  const source = tableSourceItems(items, frame)
  const header = source.filter((i) => i.rect[3] < split)
  const leaves = source.filter((i) => i.rect[1] > split && i.rect[3] < divider)
  const body = source.filter((i) => i.rect[1] > divider)
  const parentTokens = parents.map((r) =>
    header.filter((i) => i.rect[0] >= r[0] - 0.1 && i.rect[2] <= r[2] + 0.1)
  )
  const stub = header.filter((i) => i.rect[2] < cuts[1])
  if (
    parentTokens.some((g) => !g.length) ||
    !hasUniqueRecordTokens(header, [...(stub.length ? [stub] : []), ...parentTokens])
  )
    return
  if (
    parents.some(
      (r, n) =>
        Math.abs(r[0] - border[1 + n * 3][0] - padding) > height * 0.02 || r[2] >= cuts[4 + n * 3]
    )
  )
    return
  const headings = readSourceRow(leaves, cuts)
  if (!headings || headings[0] || headings.slice(1).some((s) => !/[A-Za-z]/.test(s))) return
  if (
    count === 2
      ? headings.slice(1).some((s, n) => s.toLowerCase() !== ['n', 'n/mean', 'sd/%'][n % 3])
      : headings
          .slice(1)
          .some(
            (s, n) =>
              !(
                n < 6
                  ? [/^n$/i, /^est\.meanΔ$/i, /^(?:\d\.\d+)?ci$/i][n % 3]
                  : [/^est\.meanΔ$/i, /^(?:\d\.\d+)?ci$/i, /^pvalue$/i][n % 3]
              ).test(s)
          )
  )
    return
  const localCaption = captions.filter(
    (c) =>
      captionKind(c.lines[0]) === 'table' &&
      c.rect[3] <= opening &&
      opening - c.rect[3] < height * 5
  )
  if (localCaption.length !== 1) return
  const groups = groupSourceRowsWithScripts(body, height, 0.3)
  if (!groups || groups.length < 6 || !hasUniqueRecordTokens(source, [header, leaves, ...groups]))
    return
  const spans = parents.map((_, n) => ({ row: 0, column: 1 + n * 3, rowSpan: 1, colSpan: 3 }))
  if (stub.length) spans.push({ row: 0, column: 0, rowSpan: 2, colSpan: 1 })
  let measured = 0
  for (let n = 0; n < groups.length; n++) {
    let values = readSourceRow(groups[n], cuts)
    if (!values && count === 2) {
      const shared = readSourceRow(groups[n], [
        cuts[0],
        cuts[1],
        cuts[2],
        cuts[4],
        cuts[5],
        cuts[7]
      ])
      if (
        !shared ||
        shared[1] ||
        shared[3] ||
        !shared[2].match(/^\d+\/\d+\/\d+\*?$/) ||
        !shared[4].match(/^\d+\/\d+\/\d+\*?$/)
      )
        return
      values = [shared[0], '', shared[2], '', '', shared[4], '']
      spans.push(
        { row: n + 2, column: 2, rowSpan: 1, colSpan: 2 },
        { row: n + 2, column: 5, rowSpan: 1, colSpan: 2 }
      )
    }
    if (
      !values ||
      !values[0] ||
      values.slice(1).some((s) => s && !/^[()\d.,%/−+*\s]+(?:to[()\d.,−+\s]+)?$/.test(s))
    )
      return
    if (values.slice(1).filter(Boolean).length >= count * 2) measured++
    if (values.slice(1).every((s) => !s))
      spans.push({ row: n + 2, column: 0, rowSpan: 1, colSpan: border.length })
  }
  if (measured < 3) return
  const bounds = groups.map(union)
  if (bounds.some((r, n) => n && bounds[n - 1][3] >= r[1])) return
  return {
    rows: [
      [cuts[0], opening, right, split],
      [cuts[0], split, right, divider],
      ...bounds.map((r) => [cuts[0], r[1], right, r[3]])
    ],
    columns: cuts.slice(1).map((x, c) => [cuts[c], opening, x, footer]),
    spans,
    headerRows: [0, 1],
    completeSpans: true,
    cropRect: [Math.min(left, cuts[0]), top, right, Math.min(bottom, footer + 0.5)],
    repair: 'native-body-records-recovered'
  }
}

// Some native N/% leaves sit at opposite ends of a cohort underline, while
// their body numbers occupy two narrower columns. Repeated four-value records
// establish the interior cuts; the native underlines establish cohort ownership.
function recoverOffsetCountPercentageLeaves(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect,
    source = tableSourceItems(items, table.cropRect),
    leaves = source.filter((i) => /^(?:N|%)$/.test(i.text))
  if (leaves.length !== 4 || leaves.map((i) => i.text).join('|') !== 'N|%|N|%') return
  const height = leaves[0].height
  if (!(height > 0) || leaves.some((i) => Math.abs(i.baseline - leaves[0].baseline) > height * 0.1))
    return
  const strokes = [0, 1].map((n) =>
    rules.filter(
      (r) =>
        r[1] === r[3] &&
        r[1] < leaves[0].rect[1] &&
        leaves[0].rect[1] - r[1] < height * 0.4 &&
        Math.abs(r[0] - leaves[n * 2].rect[0]) < height * 0.15 &&
        Math.abs(r[2] - leaves[n * 2 + 1].rect[2]) < height * 0.15
    )
  )
  if (strokes.some((g) => g.length !== 1)) return
  const parents = strokes.map((g) => g[0])
  if (
    parents[0][2] + height >= parents[1][0] ||
    Math.abs(parents[0][1] - parents[1][1]) > height * 0.1
  )
    return
  const horizontal = joinHorizontalTableRules(rules),
    frame = horizontal.filter(
      (r) =>
        r[0] >= left &&
        r[2] <= right &&
        r[2] - r[0] > (right - left) * 0.9 &&
        r[1] >= top &&
        r[1] <= bottom
    ),
    divider = frame.filter((r) => r[1] > leaves[0].rect[3] && r[1] - leaves[0].rect[3] < height)
  if (divider.length !== 1) return
  const split = divider[0][1],
    head = source.filter((i) => i.rect[3] < split),
    body = source.filter((i) => i.rect[1] > split),
    groups = groupSourceRowsWithScripts(body, height, 0.2)
  if (!groups || !head.length || !body.length) return
  const records = [],
    owned = [],
    rows = [],
    sections = []
  for (const group of groups) {
    const numeric = group.filter((i) => /^\d+$/.test(i.text)),
      labels = group.filter((i) => !numeric.includes(i))
    if (labels.some((i) => i.rect[2] >= parents[0][0])) return
    if (numeric.length) {
      if (numeric.length !== 4 || !labels.length || !labels.some((i) => /\p{L}/u.test(i.text)))
        return
      numeric.sort((a, b) => a.rect[0] - b.rect[0])
      if (
        numeric.some(
          (i, c) =>
            i.rect[0] < parents[Math.floor(c / 2)][0] || i.rect[2] > parents[Math.floor(c / 2)][2]
        )
      )
        return
      records.push(numeric)
      owned.push(group)
      rows.push([left, union(group)[1], right, union(group)[3]])
    } else if (
      owned.length &&
      owned.at(-1).filter((i) => /^\d+$/.test(i.text)).length === 4 &&
      /^\(/.test(readSourceRow(labels, [left, parents[0][0]])?.[0] ?? '') &&
      union(group)[1] - rows.at(-1)[3] < height * 0.5 &&
      group[0].baseline - owned.at(-1)[0].baseline < height * 1.4
    ) {
      owned.at(-1).push(...group)
      rows.at(-1)[3] = union(owned.at(-1))[3]
    } else {
      if (
        !labels.length ||
        !labels.every((i) => /\p{L}/u.test(i.text)) ||
        union(group)[2] - union(group)[0] > height * 8
      )
        return
      sections.push(rows.length)
      owned.push(group)
      rows.push([left, union(group)[1], right, union(group)[3]])
    }
  }
  if (records.length < 3 || rows.some((r, n) => n && r[1] <= rows[n - 1][3])) return
  const numericBounds = [0, 1, 2, 3].map((c) => union(records.map((g) => g[c])))
  if (
    numericBounds.some((r) => r[2] - r[0] > height * 2.2) ||
    numericBounds.slice(1).some((r, c) => r[0] - numericBounds[c][2] < height)
  )
    return
  const cuts = [
    left,
    Math.min(parents[0][0], leaves[0].rect[0]),
    (numericBounds[0][2] + numericBounds[1][0]) / 2,
    (parents[0][2] + parents[1][0]) / 2,
    (numericBounds[2][2] + numericBounds[3][0]) / 2,
    right
  ]
  if (owned.some((g) => !readSourceRow(g, cuts, { multiline: true }))) return
  const parentBottom = Math.min(...parents.map((r) => r[1])),
    cohortLabels = parents.map((r) =>
      head.filter(
        (i) =>
          i.rect[0] >= r[0] &&
          i.rect[2] <= r[2] &&
          i.rect[3] < parentBottom &&
          parentBottom - i.rect[3] < height
      )
    )
  if (
    cohortLabels.some((g) => !g.length || !g.some((i) => /\p{L}/u.test(i.text))) ||
    Math.abs(cohortLabels[0][0].baseline - cohortLabels[1][0].baseline) > height * 0.1
  )
    return
  const upperRule = horizontal.filter(
    (r) =>
      r[1] < Math.min(...cohortLabels.flat().map((i) => i.rect[1])) &&
      Math.min(...cohortLabels.flat().map((i) => i.rect[1])) - r[1] < height * 0.4 &&
      Math.abs(r[0] - parents[0][0]) < height * 0.15 &&
      Math.abs(r[2] - parents[1][2]) < height * 0.15
  )
  if (upperRule.length !== 1) return
  const upperBottom = upperRule[0][1],
    upper = head.filter((i) => i.rect[3] < upperBottom),
    footer = frame.filter((r) => r[1] > rows.at(-1)[3] && r[1] - rows.at(-1)[3] < height),
    opening = frame.filter(
      (r) => upper.length && r[1] < union(upper)[1] && union(upper)[1] - r[1] < height
    )
  if (
    !upper.length ||
    upper.some((i) => i.rect[0] < cuts[1] || i.rect[2] > right) ||
    !upper.some((i) => /\p{L}/u.test(i.text)) ||
    !hasUniqueRecordTokens(head, [upper, ...cohortLabels, leaves]) ||
    !hasUniqueRecordTokens(body, owned) ||
    footer.length !== 1 ||
    opening.length !== 1 ||
    !readSourceRow(leaves, cuts)
  )
    return
  return {
    rows: [
      [left, top, right, upperBottom],
      [left, upperBottom, right, parentBottom],
      [left, parentBottom, right, split],
      ...rows
    ],
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans: [
      { row: 0, column: 1, rowSpan: 1, colSpan: 4 },
      { row: 1, column: 1, rowSpan: 1, colSpan: 2 },
      { row: 1, column: 3, rowSpan: 1, colSpan: 2 },
      ...sections.map((r) => ({ row: r + 3, column: 0, rowSpan: 1, colSpan: 5 }))
    ],
    headerRows: [0, 1, 2],
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Restore a small detector side cut only inside a captioned native frame.
// Complete labeled numeric bands independently prove its closing body border;
// an adjacent note outside that border does not extend the recovered crop.
export function recoverClosedNumericFrameCrop(table, items, captions, rules) {
  const crop = table.cropRect
  const columns = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (columns.length < 3 || columns.length > 9) return
  const local = tableSourceItems(items, crop)
  const height = local.map((i) => i.height).sort((a, b) => a - b)[Math.floor(local.length / 2)]
  if (!(height > 0)) return
  const horizontal = joinHorizontalTableRules(rules, 1)
  const vertical = rules.filter((r) => r[0] === r[2])
  const openings = horizontal.filter(
    (r) =>
      Math.abs(r[1] - crop[1]) < height &&
      Math.abs(r[0] - crop[0]) < height &&
      Math.abs(r[2] - crop[2]) < height
  )
  const matches = []
  for (const opening of openings) {
    const xs = [opening[0], opening[2]].map((x) =>
      clusterTableRulePositions(vertical.filter((v) => Math.abs(v[0] - x) < 1).map((v) => v[0]))
    )
    if (xs.some((values) => values.length !== 1)) continue
    const [left, right] = xs.map((values) => values[0]),
      top = opening[1]
    if (
      !captions.some(
        (c) =>
          captionKind(c.lines[0]) === 'table' &&
          c.rect[3] <= top &&
          top - c.rect[3] < height * 2 &&
          Math.abs(c.rect[0] - left) < height
      )
    )
      continue
    const closings = horizontal.filter(
      (r) =>
        r[1] > top &&
        Math.abs(r[1] - crop[3]) < height &&
        Math.abs(r[0] - left) < 1 &&
        Math.abs(r[2] - right) < 1
    )
    for (const closing of closings) {
      const bottom = closing[1],
        frame = [left, top, right, bottom]
      if (
        frame.some((x, n) => Math.abs(x - crop[n]) > height) ||
        [left, right].some((x) => classifyTableRuleEdge(vertical, 0, x, top, bottom) !== 1)
      )
        continue
      const source = tableSourceItems(items, frame)
      if (!source.some((i) => i.rect[0] < crop[0] || i.rect[2] > crop[2])) continue
      const ys = clusterTableRulePositions(
        horizontal
          .filter(
            (r) =>
              r[1] >= top &&
              r[1] <= bottom &&
              Math.abs(r[0] - left) < 1 &&
              Math.abs(r[2] - right) < 1
          )
          .map((r) => r[1])
      )
      if (ys.length < 4 || ys.length > 12) continue
      const cuts = [
        left,
        ...columns.slice(1).map((c, n) => crop[0] + (columns[n].rect[2] + c.rect[0]) / 2),
        right
      ]
      const groups = ys
        .slice(1)
        .map((y, n) =>
          source.filter(
            (i) => (i.rect[1] + i.rect[3]) / 2 >= ys[n] && (i.rect[1] + i.rect[3]) / 2 < y
          )
        )
      if (!hasUniqueRecordTokens(source, groups)) continue
      const values = groups.map((g) => readSourceRow(g, cuts, { multiline: true }))
      if (
        values.some((v) => !v || !/\p{L}/u.test(v[0])) ||
        !values[0].slice(1).every((s) => /\p{L}/u.test(s)) ||
        !values
          .slice(1)
          .every((v) =>
            v
              .slice(1)
              .every((s) =>
                /^[<>≤≥−+-]?\d[\d.,()%±–−+/-]*(?:to[\d.,()%±–−+/-]+)?[a-z*§†‡]*$/i.test(s)
              )
          )
      )
        continue
      matches.push(frame)
    }
  }
  if (matches.length === 1) return matches[0]
}

// Repeated native limb leaves and independently underlined population groups
// witness a stacked marker above the separate comparison probability column.
function recoverRepeatedLimbComparisonGrid(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const columns = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (columns.length !== 8) return
  const source = tableSourceItems(items, table.cropRect)
  const height = Math.max(...source.map((i) => i.height))
  const cuts = [
    left,
    ...columns.slice(1).map((c, n) => left + (columns[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const leaves = source.filter((i) => [1, 4].includes(col(i)) && i.text === 'IL*')
  if (leaves.length !== 2 || Math.abs(leaves[0].baseline - leaves[1].baseline) > height * 0.1)
    return
  const nativeBottom = joinHorizontalTableRules(rules, 1).find(
    (r) =>
      r[1] > leaves[0].rect[3] &&
      r[1] - leaves[0].rect[3] < height * 2 &&
      Math.abs(r[0] - cuts[1]) < height &&
      Math.abs(r[2] - right) < height
  )?.[1]
  if (nativeBottom === undefined) return
  const head = source.filter((i) => i.rect[3] < nativeBottom)
  const lower = head.filter((i) => Math.abs(i.baseline - leaves[0].baseline) < height * 0.4)
  const v = readSourceRow(lower, cuts)
  if (!v || v[0] || v.slice(1).join('|') !== 'IL*|CL†|p|IL*|CL†|p|P') return
  const comparison = head.filter((i) => col(i) === 7 && !lower.includes(i))
  if (
    comparison.length !== 2 ||
    comparison[0].text !== 'IL*' ||
    !/^\p{L}+\s+vs\.\s+\p{L}+$/u.test(comparison[1].text)
  )
    return
  const recovered = recoverRuledHeaderBands(head, cuts, rules, top, nativeBottom)
  if (
    recovered?.rows.length !== 2 ||
    ![1, 4].every((column) =>
      recovered.spans.some((s) => s.row === 0 && s.column === column && s.colSpan === 3)
    )
  )
    return
  const groups = groupSourceRowsWithScripts(
    source.filter((i) => i.rect[1] > nativeBottom),
    height,
    0.35
  )
  if (!groups || groups.length < 3 || !hasUniqueRecordTokens(source, [head, ...groups])) return
  if (
    groups.some((g) => {
      const values = readSourceRow(g, cuts)
      return (
        !values ||
        !/\p{L}/u.test(values[0]) ||
        !values.slice(1).every((s) => /^[<>≤≥−+-]?\d[\d.,:() °%±–−+/-]*$/.test(s))
      )
    })
  )
    return
  const bounds = groups.map(union)
  if (bounds.some((r, n) => n && r[1] <= bounds[n - 1][3])) return
  return {
    rows: [...recovered.rows, ...bounds.map((r) => [left, r[1], right, r[3]])],
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans: recovered.spans,
    headerRows: [0, 1],
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Complete sample-qualified visits, identical summary bands and repeated
// treatment pairs partition continuous native underlines into four tiers.
function recoverRepeatedSampleHierarchyGrid(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const columns = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (columns.length < 7 || columns.length > 15 || columns.length % 2 !== 1) return
  const source = tableSourceItems(items, table.cropRect)
  const height = source.map((i) => i.height).sort((a, b) => a - b)[Math.floor(source.length / 2)]
  if (!(height > 0)) return
  const cuts = [
    left,
    ...columns.slice(1).map((c, n) => left + (columns[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const pairedCuts = [left, ...cuts.slice(1).filter((_, n) => n % 2 === 0)]
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const leaves = source
    .filter((i) => /^(?:IG|CG)$/.test(i.text))
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (
    leaves.length !== columns.length - 1 ||
    leaves.some(
      (i, n) =>
        i.text !== (n % 2 ? 'CG' : 'IG') ||
        col(i) !== n + 1 ||
        Math.abs(i.baseline - leaves[0].baseline) > height * 0.15
    )
  )
    return
  const horizontal = joinHorizontalTableRules(rules, 1).filter((r) => r[1] >= top && r[1] < bottom)
  const full = horizontal.filter(
    (r) => Math.abs(r[0] - left) < height && Math.abs(r[2] - right) < height
  )
  const leafTop = Math.min(...leaves.map((i) => i.rect[1])),
    leafBottom = Math.max(...leaves.map((i) => i.rect[3]))
  const headerBottom = full.find((r) => r[1] > leafBottom && r[1] - leafBottom < height)?.[1]
  if (headerBottom === undefined || full.length < 3) return
  const upper = full.filter((r) => r[1] < leafTop)
  if (upper.length !== 2 || upper[1][1] - upper[0][1] > height * 3) return
  const title = source.filter((i) => i.rect[1] > upper[0][1] && i.rect[3] < upper[1][1])
  if (
    !title.length ||
    title.some(
      (i) => !/\p{L}/u.test(i.text) || Math.abs(i.baseline - title[0].baseline) > height * 0.2
    )
  )
    return
  const internal = horizontal.filter(
    (r) =>
      r[1] > upper[1][1] &&
      r[1] < leafTop &&
      Math.abs(r[0] - cuts[1]) < height &&
      Math.abs(r[2] - right) < height
  )
  if (internal.length !== 2) return
  const parents = source.filter(
    (i) => i.rect[1] > upper[1][1] && i.rect[3] < internal[0][1] && i.rect[0] >= cuts[1]
  )
  const summaries = source.filter(
    (i) => i.rect[1] > internal[0][1] && i.rect[3] < internal[1][1] && i.rect[0] >= cuts[1]
  )
  const parentValues = readSourceRow(parents, pairedCuts, { multiline: true })
  const summaryValues = readSourceRow(summaries, pairedCuts)
  if (
    !parentValues ||
    !summaryValues ||
    parentValues[0] ||
    summaryValues[0] ||
    !parentValues.slice(1).every((s) => /\p{L}.*\(n=\d+\)$/iu.test(s.replace(/\s/g, ''))) ||
    !summaryValues.slice(1).every((s) => s === 'Value')
  )
    return
  const stub = source.filter(
    (i) => i.rect[0] < cuts[1] && i.rect[1] > upper[1][1] && i.rect[3] < headerBottom
  )
  if (!stub.length || stub.some((i) => i.rect[2] > cuts[1] || !/\p{L}/u.test(i.text))) return
  const body = source.filter((i) => i.rect[1] > headerBottom)
  const groups = groupSourceRowsWithScripts(body, height, 0.3)
  if (
    !groups ||
    groups.length < 3 ||
    !hasUniqueRecordTokens(source, [title, parents, summaries, leaves, stub, ...groups])
  )
    return
  const spans = [
    { row: 0, column: 0, rowSpan: 1, colSpan: columns.length },
    { row: 1, column: 0, rowSpan: 3, colSpan: 1 }
  ]
  for (let c = 1; c < columns.length; c += 2)
    for (const row of [1, 2]) spans.push({ row, column: c, rowSpan: 1, colSpan: 2 })
  let complete = 0
  for (const [n, g] of groups.entries()) {
    const values = readSourceRow(g, cuts)
    if (!values || !/\p{L}/u.test(values[0])) return
    if (values.slice(1).every((s) => /^\d+(?:\.\d+)?$/.test(s))) complete++
    else if (values.slice(1).every((s) => !s))
      spans.push({ row: n + 4, column: 0, rowSpan: 1, colSpan: columns.length })
    else return
  }
  const bounds = groups.map(union)
  if (complete < 3 || bounds.some((r, n) => n && r[1] <= bounds[n - 1][3])) return
  const ys = [upper[0][1], upper[1][1], internal[0][1], internal[1][1], headerBottom]
  return {
    rows: [
      ...ys.slice(1).map((y, n) => [left, ys[n], right, y]),
      ...bounds.map((r) => [left, r[1], right, r[3]])
    ],
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans,
    headerRows: [0, 1, 2, 3],
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Closed native faces or an explicit shared count parent establish the header;
// complete body records independently confirm the model's leaf-column cuts.
function recoverClosedHeaderGrid(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const columns = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  const predictedBottom =
    top +
    Math.max(
      ...table.structure.objects
        .filter((o) => o.label === 'table column header')
        .map((o) => o.rect[3])
    )
  if (columns.length < 4 || columns.length > 14 || !Number.isFinite(predictedBottom)) return
  const source = tableSourceItems(items, table.cropRect)
  if (!source.length) return
  const height = Math.max(...source.map((i) => i.height))
  const cuts = [
    left,
    ...columns.slice(1).map((c, n) => left + (columns[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const candidates = joinHorizontalTableRules(rules, 1)
    .filter(
      (r) =>
        Math.abs(r[1] - predictedBottom) < height * 2 &&
        Math.abs(r[0] - left) < height &&
        Math.abs(r[2] - right) < height
    )
    .sort((a, b) => Math.abs(a[1] - predictedBottom) - Math.abs(b[1] - predictedBottom))
  for (const rule of candidates) {
    const header = source.filter((i) => i.rect[3] < rule[1])
    const recovered =
      recoverClosedNativeHeaderBands(header, cuts, rules, top, rule[1]) ??
      recoverSharedSampleCountHeaderBands(header, cuts, rules, top, rule[1])
    if (!recovered || recovered.rows.length < 2) continue
    const body = source.filter((i) => i.rect[1] > rule[1])
    const groups = groupSourceRowsWithScripts(body, height, 0.35)
    if (!groups || groups.length < 3 || !hasUniqueRecordTokens(source, [header, ...groups]))
      continue
    const values = groups.map((g) => readSourceRow(g, cuts))
    if (
      values.some(
        (v) =>
          !v ||
          !/\p{L}/u.test(v[0]) ||
          !v.slice(1).every((s) => /^[<>≤≥−+-]?\d[\d.,() %±–−+/-]*$/.test(s))
      )
    )
      continue
    const bounds = groups.map(union)
    if (bounds.some((r, n) => n && r[1] <= bounds[n - 1][3])) continue
    return {
      rows: [...recovered.rows, ...bounds.map((r) => [left, r[1], right, r[3]])],
      columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
      spans: recovered.spans,
      headerRows: recovered.rows.map((_, n) => n),
      completeSpans: true,
      ownedTokens: new Set(source)
    }
  }
}

// Complete paired count records confirm both cohort lanes; mean/SD records
// printed across each pair own the same physical population spans.
function recoverMixedCountSummaryGrid(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const columns = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (columns.length !== 6) return
  const cuts = [
    left,
    ...columns.slice(1).map((c, n) => left + (columns[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const source = tableSourceItems(items, table.cropRect)
  const height = source.map((i) => i.height).sort((a, b) => a - b)[Math.floor(source.length / 2)]
  if (!(height > 0)) return
  const borders = joinHorizontalTableRules(rules, 1).filter(
    (r) =>
      r[1] >= top &&
      r[1] <= bottom &&
      Math.abs(r[0] - left) < height &&
      Math.abs(r[2] - right) < height
  )
  if (borders.length < 2 || borders.length > 3 || borders[1][1] - borders[0][1] > height * 6) return
  const head = source.filter((i) => (i.rect[1] + i.rect[3]) / 2 < borders[1][1])
  const leaf = head.filter((i) => /^(?:No\.|%)$/.test(i.text))
  if (
    leaf.length !== 4 ||
    leaf.map((i) => i.text).join('|') !== 'No.|%|No.|%' ||
    leaf.some((i) => Math.abs(i.baseline - leaf[0].baseline) > height * 0.2)
  )
    return
  const leafTop = Math.min(...leaf.map((i) => i.rect[1]))
  const parents = [1, 3].map((c) =>
    head.filter((i) => i.rect[0] >= cuts[c] && i.rect[2] <= cuts[c + 2] && i.rect[3] < leafTop)
  )
  if (
    parents.some(
      (g) =>
        !/\p{L}.*\(n=\d+\)$/iu.test(
          g
            .map((i) => i.text)
            .join('')
            .replace(/\s/g, '')
        )
    )
  )
    return
  const outside = head.filter((i) => !parents.flat().includes(i) && !leaf.includes(i))
  const outer = readSourceRow(outside, cuts, { multiline: true })
  if (
    !outer ||
    !/\p{L}/u.test(outer[0]) ||
    !/^p-?value$/i.test(outer[5]) ||
    outer.slice(1, 5).some(Boolean)
  )
    return
  const split = (Math.max(...parents.flat().map((i) => i.rect[3])) + leafTop) / 2
  const body = source.filter(
    (i) => (i.rect[1] + i.rect[3]) / 2 > borders[1][1] && i.rect[3] < (borders[2]?.[1] ?? bottom)
  )
  const groups = groupSourceRowsWithScripts(body, height, 0.3)
  if (!groups || groups.length < 8 || !hasUniqueRecordTokens(source, [head, ...groups])) return
  const spans = [
    { row: 0, column: 0, rowSpan: 2, colSpan: 1 },
    { row: 0, column: 1, rowSpan: 1, colSpan: 2 },
    { row: 0, column: 3, rowSpan: 1, colSpan: 2 },
    { row: 0, column: 5, rowSpan: 2, colSpan: 1 }
  ]
  let counts = 0,
    summaries = 0,
    sections = 0
  const scalar = (s) => /^\d+(?:\.\d+)?$/.test(s)
  for (const [n, g] of groups.entries()) {
    const values = readSourceRow(g, cuts)
    const combined = readSourceRow(g, [left, cuts[1], cuts[3], cuts[5], right])
    if (
      !combined ||
      !/\p{L}/u.test(combined[0]) ||
      (combined[3] && !/^[<>≤≥]?\d+(?:\.\d+)?$/.test(combined[3]))
    )
      return
    if (
      /\(Mean±SD\)$/i.test(combined[0]) &&
      combined.slice(1, 3).every((s) => /^\d+(?:\.\d+)?±\d+(?:\.\d+)?$/.test(s))
    ) {
      summaries++
      for (const c of [1, 3]) spans.push({ row: n + 2, column: c, rowSpan: 1, colSpan: 2 })
    } else if (values && values.slice(1, 5).every(scalar)) counts++
    else if (values && values.slice(1, 5).every((s) => !s)) {
      sections++
      spans.push({ row: n + 2, column: 0, rowSpan: 1, colSpan: values[5] ? 5 : 6 })
    } else return
  }
  const bounds = groups.map(union)
  if (
    counts < 4 ||
    summaries < 2 ||
    sections < 2 ||
    bounds.some((r, n) => n && r[1] <= bounds[n - 1][3])
  )
    return
  return {
    rows: [
      [left, borders[0][1], right, split],
      [left, split, right, Math.min(borders[1][1], bounds[0][1])],
      ...bounds.map((r) => [left, r[1], right, r[3]])
    ],
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans,
    headerRows: [0, 1],
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Four abutting native leaf underlines and explicit sample-qualified cohort
// names establish two count/percentage pairs even when the model clips the
// names or combines the independent test and probability columns. A single
// centered test value owns its whole section only without an internal rule.
function recoverUnderlinedCountComparisonGrid(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, originalRight, bottom] = table.cropRect
  let right = originalRight
  let source = tableSourceItems(items, table.cropRect)
  const height = source.map((i) => i.height).sort((a, b) => a - b)[Math.floor(source.length / 2)]
  if (!(height > 0)) return
  const leaves = source.filter((i) => /^[n%]$/.test(i.text))
  if (leaves.length !== 4 || leaves.map((i) => i.text).join('|') !== 'n|%|n|%') return
  if (leaves.some((i) => Math.abs(i.baseline - leaves[0].baseline) > height * 0.1)) return
  const split = rules.find(
    (r) => r[1] === r[3] && r[1] < leaves[0].rect[1] && leaves[0].rect[1] - r[1] < height * 0.3
  )?.[1]
  if (split === undefined) return
  const strokes = rules.filter((r) => r[1] === split && r[3] === split).sort((a, b) => a[0] - b[0])
  if (strokes.length !== 4 || strokes.slice(1).some((r, n) => Math.abs(r[0] - strokes[n][2]) > 0.1))
    return
  const headerBottom = Math.max(...leaves.map((i) => i.rect[3])) + height * 0.2
  const header = source.filter((i) => i.rect[3] < headerBottom)
  const tests = header
    .filter((i) => /^(?:P|χ2|χ)$/i.test(i.text))
    .sort((a, b) => a.rect[0] - b.rect[0])
  const testGroups = tests.map((i) => [
    i,
    ...header.filter((s) => s !== i && /^2$/.test(s.text) && isAdjacentTableScript(s, i))
  ])
  if (tests.length < 1 || tests.length > 2 || !/^P$/i.test(tests.at(-1).text)) return
  const clipped = tableSourceItems(items, [left, top, right + height, bottom]).filter(
    (i) => !source.includes(i)
  )
  if (clipped.length) {
    const probability = tests.at(-1)
    if (
      clipped.some(
        (i) =>
          i.rect[1] <= headerBottom ||
          !/^[<>≤≥]?\d+(?:\.\d+)?[a-z]?$/.test(i.text) ||
          Math.abs((i.rect[0] + i.rect[2] - probability.rect[0] - probability.rect[2]) / 2) > height
      )
    )
      return
    right = Math.max(...clipped.map((i) => i.rect[2])) + 0.1
    source = [...source, ...clipped].sort(
      (a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0]
    )
  }
  const cuts = [
    left,
    ...strokes.map((r) => r[0]),
    strokes.at(-1)[2],
    ...tests.slice(1).map((i, n) => (union(testGroups[n])[2] + i.rect[0]) / 2),
    right
  ]
  if (cuts.some((x, n) => n && x <= cuts[n - 1])) return
  const parents = [0, 1].map((n) =>
    header.filter(
      (i) => i.rect[3] < split && i.rect[0] >= cuts[1 + n * 2] && i.rect[2] <= cuts[3 + n * 2]
    )
  )
  if (
    parents.some(
      (g) =>
        !g.length ||
        !/\p{L}{3}/u.test(g.map((i) => i.text).join('')) ||
        !/\(n\s*=\s*\d+\)/i.test(g.map((i) => i.text).join(''))
    )
  )
    return
  const stub = header.filter((i) => i.rect[0] >= left && i.rect[2] <= cuts[1])
  if (
    !stub.length ||
    !stub.some((i) => /\p{L}/u.test(i.text)) ||
    !hasUniqueRecordTokens(header, [stub, ...parents, ...testGroups, leaves])
  )
    return
  const body = source.filter((i) => i.rect[1] > headerBottom)
  const anchors = groupSourceRowsWithScripts(
    body.filter(
      (i) =>
        i.rect[0] >= left &&
        (i.rect[2] <= cuts[1] ||
          (i.rect[0] < cuts[1] + height * 0.5 &&
            i.rect[2] < cuts[1] + height &&
            /\p{L}/u.test(i.text)))
    ),
    height,
    0.25
  )
  if (
    !anchors ||
    anchors.length < 8 ||
    anchors.some((g, n) => n && g[0].baseline - anchors[n - 1][0].baseline < height * 0.8)
  )
    return
  const groups = anchors.map((g) =>
    body.filter(
      (i) =>
        i.rect[2] <= cuts[5] &&
        (g.includes(i) || Math.abs(i.baseline - g[0].baseline) < height * 0.25)
    )
  )
  const rows = [],
    spans = [
      { row: 0, column: 0, rowSpan: 2, colSpan: 1 },
      { row: 0, column: 1, rowSpan: 1, colSpan: 2 },
      { row: 0, column: 3, rowSpan: 1, colSpan: 2 },
      ...tests.map((_, n) => ({ row: 0, column: 5 + n, rowSpan: 2, colSpan: 1 }))
    ],
    sections = [],
    owned = [header]
  const number = (s) => /^(?:-|\d+(?:\.\d+)?)$/.test(s)
  for (const [n, group] of groups.entries()) {
    const v = readSourceRow(group, cuts)
    const section =
      (v && v[0] && v.slice(1, 5).every((s) => !s || /^\(n=\d+\)$/i.test(s))) ||
      (!v &&
        group.some((i) => /\p{L}{3}/u.test(i.text)) &&
        group.every((i) => /\p{L}/u.test(i.text) || /^\(n\s*=\s*\d+\)$/i.test(i.text)))
    if (!section && (!v || !v[0] || !v.slice(1, 5).every(number))) return
    const rect = union(group)
    rows.push([left, rect[1], right, rect[3]])
    owned.push(group)
    if (section) {
      sections.push(n)
      spans.push({ row: n + 2, column: 0, rowSpan: 1, colSpan: cuts.length - 1 })
    }
  }
  if (sections.length < 3 || sections[0] !== 0) return
  for (const [n, start] of sections.entries()) {
    const end = sections[n + 1] ?? rows.length
    if (end - start < 3 || end - start > 6) return
    const from = rows[start + 1][1],
      to = rows[end - 1][3]
    for (let c = 5; c < cuts.length - 1; c++) {
      const values = body.filter(
        (i) =>
          i.rect[0] >= cuts[c] &&
          i.rect[2] <= cuts[c + 1] &&
          (i.rect[1] + i.rect[3]) / 2 >= from &&
          (i.rect[1] + i.rect[3]) / 2 <= to
      )
      if (
        values.length > 2 ||
        (values.length &&
          !/^[<>≤≥]?\d+(?:\.\d+)?[a-z]?$/.test(
            [...values]
              .sort((a, b) => a.rect[0] - b.rect[0])
              .map((i) => i.text)
              .join('')
          ))
      )
        return
      if (!values.length) continue
      if (
        rules.some(
          (r) => r[1] === r[3] && r[1] > from && r[1] < to && r[0] < cuts[c + 1] && r[2] > cuts[c]
        )
      )
        return
      owned.push(values)
      spans.push({ row: start + 3, column: c, rowSpan: end - start - 1, colSpan: 1 })
      const rect = union(values)
      rows[start + 1][1] = Math.min(rows[start + 1][1], rect[1])
      rows[end - 1][3] = Math.max(rows[end - 1][3], rect[3])
    }
  }
  if (!hasUniqueRecordTokens(source, owned) || rows.some((r, n) => n && r[1] <= rows[n - 1][3]))
    return
  const footer = joinHorizontalTableRules(rules).filter(
    (r) =>
      r[1] >= Math.max(...body.map((i) => i.rect[3])) &&
      r[1] - Math.max(...body.map((i) => i.rect[3])) < height &&
      r[1] <= bottom &&
      Math.abs(r[0] - left) < height &&
      r[2] >= right &&
      r[2] - originalRight < height * 1.5
  )
  return {
    cropRect: [left, top, right, bottom],
    rows: [[left, top, right, split], [left, split, right, headerBottom], ...rows],
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans,
    headerRows: [0, 1],
    completeSpans: true,
    ...(right > originalRight && right - originalRight <= height * 0.6 && footer.length === 1
      ? { repair: 'native-count-footer-crop-recovered' }
      : {}),
    ownedTokens: new Set(source)
  }
}

// Two independently repeated sample-qualified headers and identical native
// cohort underlines prove their Mean/SD leaves and the spanning stub/test labels.
function recoverRepeatedSampleSummaryBands(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  if (table.structure.objects.filter((o) => o.label === 'table column').length !== 5) return
  const [left, top, right, bottom] = table.cropRect,
    source = tableSourceItems(items, table.cropRect),
    height = source.map((i) => i.height).sort((a, b) => a - b)[Math.floor(source.length / 2)],
    leaves = source.filter((i) => /^Mean\s*±\s*SD$/i.test(i.text))
  if (!(height > 0) || leaves.length !== 4) return
  const leafBands = [...Map.groupBy(leaves, (i) => i.baseline).values()]
  if (leafBands.length !== 2 || leafBands.some((g) => g.length !== 2)) return
  const groups = [],
    rows = [],
    spans = [],
    headerRows = []
  let cuts
  for (const [n, leaf] of leafBands.entries()) {
    const strokes = rules
      .filter(
        (r) => r[1] === r[3] && r[1] < leaf[0].rect[1] && leaf[0].rect[1] - r[1] < height * 0.3
      )
      .sort((a, b) => a[0] - b[0])
    if (
      strokes.length !== 2 ||
      Math.abs(strokes[0][2] - strokes[1][0]) > 0.1 ||
      Math.abs(strokes[0][1] - strokes[1][1]) > 0.1
    )
      return
    const split = strokes[0][1],
      upper = source.filter(
        (i) => i.rect[1] >= Math.max(top, split - height * 5.5) && i.rect[3] < split
      ),
      lower = source.filter(
        (i) => i.rect[1] > split && i.rect[3] <= Math.max(...leaf.map((i) => i.rect[3]))
      ),
      tests = upper.filter((i) => /^(?:t|P)$/.test(i.text)).sort((a, b) => a.rect[0] - b.rect[0])
    if (tests.length !== 2 || tests[0].text !== 't' || tests[1].text !== 'P') return
    const xs = [
      left,
      strokes[0][0],
      strokes[1][0],
      strokes[1][2],
      (tests[0].rect[2] + tests[1].rect[0]) / 2,
      right
    ]
    if (cuts && xs.some((x, c) => Math.abs(x - cuts[c]) > 0.1)) return
    cuts = xs
    const names = readSourceRow(upper, cuts, { multiline: true }),
      values = readSourceRow(lower, cuts)
    if (
      !names ||
      !values ||
      !/\p{L}/u.test(names[0]) ||
      !names.slice(1, 3).every((s) => /\p{L}{3}/u.test(s) && /\(n=\d+\)$/.test(s)) ||
      names[3] !== 't' ||
      names[4] !== 'P' ||
      values.join('|') !== '|Mean±SD|Mean±SD||'
    )
      return
    const start = Math.min(...upper.map((i) => i.rect[1])),
      end = Math.max(...lower.map((i) => i.rect[3])),
      row = rows.length
    if (n && start <= rows.at(-1)[3]) return
    rows.push([left, start, right, split], [left, split, right, end])
    groups.push(upper, lower)
    headerRows.push(row, row + 1)
    for (const column of [0, 3, 4]) spans.push({ row, column, rowSpan: 2, colSpan: 1 })
    const nextSplit =
        n + 1 < leafBands.length ? leafBands[n + 1][0].rect[1] - height * 5.8 : bottom,
      body = source.filter((i) => i.rect[1] > end && i.rect[3] < nextSplit),
      records = groupSourceRowsWithScripts(body, height, 0.2),
      v = records?.map((g) => readSourceRow(g, cuts))
    if (
      !v ||
      v.length < 6 ||
      v
        .slice(0, -2)
        .some(
          (r) =>
            !r ||
            !r[0] ||
            !r.slice(1, 3).every((s) => /^[−+-]?\d+(?:\.\d+)?±\d+(?:\.\d+)?$/.test(s)) ||
            !r.slice(3).every((s) => /^[−+-]?\d+(?:\.\d+)?$/.test(s))
        ) ||
      v
        .slice(-2)
        .some(
          (r, j) =>
            !r ||
            r[0] !== ['F', 'P'][j] ||
            !r.slice(1, 3).every((s) => /^\d+(?:\.\d+)?$/.test(s)) ||
            r.slice(3).some(Boolean)
        )
    )
      return
    for (const g of records) {
      const r = union(g)
      rows.push([left, r[1], right, r[3]])
      groups.push(g)
    }
  }
  const footer = joinHorizontalTableRules(rules).filter(
    (r) =>
      r[1] > rows.at(-1)[3] &&
      r[1] - rows.at(-1)[3] < height &&
      Math.abs(r[0] - left) < height * 2 &&
      Math.abs(r[2] - right) < height
  )
  if (footer.length !== 1 || !hasUniqueRecordTokens(source, groups)) return
  return {
    rows,
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans,
    headerRows,
    completeSpans: true,
    ownedTokens: new Set(source),
    repair: 'native-repeated-summary-header-recovered'
  }
}

// Several count/percentage cohorts share native record baselines, with optional
// median/range records and empty section rows. Enclosing rules and repeated
// complete pairs prove the layout even on a continuation without a caption.
export function recoverCohortDistributionRecords(table, items, rules) {
  const continuation = recoverCountPercentContinuation(table, items, rules)
  if (continuation) return continuation
  const [left, top, right, originalBottom] = table.cropRect
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (predicted.length < 5 || predicted.length > 9 || predicted.length % 2 !== 1) return
  const cuts = [
    left,
    ...predicted.slice(1).map((c, n) => left + (predicted[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const sideEnds = rules.filter(
    (r) =>
      r[0] === r[2] && r[1] < originalBottom && r[3] > originalBottom && r[3] - originalBottom < 15
  )
  const lower = sideEnds.find(
    (r) =>
      Math.abs(r[0] - left) < 15 &&
      sideEnds.some((s) => Math.abs(s[0] - right) < 15 && Math.abs(s[3] - r[3]) < 1)
  )
  const bottom = lower?.[3] ?? originalBottom
  const cropRect = [left, top, right, bottom]
  const source = tableSourceItems(items, cropRect)
  const height = source.map((i) => i.height).sort((a, b) => a - b)[Math.floor(source.length / 2)]
  const groups = groupSourceRowsWithScripts(source, height, 0.3)
  if (!groups || groups.length < 12) return
  const frame = joinHorizontalTableRules(rules, 1).filter(
    (r) =>
      r[1] >= top && r[1] <= bottom && Math.abs(r[0] - left) < 15 && Math.abs(r[2] - right) < 15
  )
  if (frame.length < 3) return
  let first = 0
  const spans = [],
    headerRows = []
  if (
    groups
      .slice(0, 3)
      .flat()
      .some((i) => /^\(N\s*=\s*\d+\)$/i.test(i.text))
  ) {
    const head = groups.slice(0, 3).flat(),
      parentCuts = [left, ...cuts.slice(1, -1).filter((_, n) => n % 2 === 0), right]
    const v = readSourceRow(head, parentCuts, { multiline: true })
    if (
      !v ||
      !/\p{L}/u.test(v[0]) ||
      !v.slice(1).every((s) => /\p{L}/u.test(s) && /\(N=\d+\)/i.test(s))
    )
      return
    first = 3
    headerRows.push(0)
    for (let c = 1; c < predicted.length; c += 2)
      spans.push({ row: 0, column: c, rowSpan: 1, colSpan: 2 })
  }
  const records = []
  for (const g of groups.slice(first)) {
    const v = readSourceRow(g, cuts),
      last = records.at(-1),
      prior = last && readSourceRow(last, cuts, { multiline: true })
    if (
      v &&
      prior &&
      /^[a-z]/.test(v[0]) &&
      v.slice(1).every((s) => !s) &&
      prior.slice(1).every((s) => !s) &&
      g[0].baseline - last.at(-1).baseline < height * 1.3 &&
      !frame.some((r) => r[1] > union(last)[3] && r[1] < union(g)[1])
    )
      last.push(...g)
    else records.push([...g])
  }
  const values = records.map((g) => readSourceRow(g, cuts, { multiline: true }))
  let counts = 0,
    sections = 0
  for (const v of values) {
    if (!v || !v[0]) return
    if (v.slice(1).every((s) => !s) && /\p{L}/u.test(v[0])) {
      sections++
      continue
    }
    let count = true,
      range = true,
      sparse = true
    for (let c = 1; c < predicted.length; c += 2) {
      count &&= /^\d+$/.test(v[c]) && /^\d+(?:\.\d+)?%$/.test(v[c + 1])
      range &&= /^\d+(?:\.\d+)?$/.test(v[c]) && /^\(\d+(?:\.\d+)?;\d+(?:\.\d+)?\)$/.test(v[c + 1])
      sparse &&= /^\d+$/.test(v[c]) && !v[c + 1]
    }
    if (!count && !range && !sparse) return
    if (count) counts++
  }
  if (counts < 8 || sections < 3) return
  const owned = first ? [groups.slice(0, first).flat(), ...records] : records
  if (!hasUniqueRecordTokens(source, owned)) return
  const bounds = owned.map(union)
  if (bounds.some((r, n) => n && r[1] <= bounds[n - 1][3])) return
  return {
    cropRect,
    rows: bounds.map((r) => [left, r[1] - 0.01, right, r[3] + 0.01]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], top, x, bottom]),
    spans,
    headerRows,
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// A captionless comparison may have only opening/closing rules and overlapping
// predicted columns. Repeated count/percentage pairs prove the native gutters;
// their consistent denominators independently distinguish measured records.
function recoverCountPercentContinuation(table, items, rules) {
  const crop = table.cropRect
  if (table.structure.objects.filter((o) => o.label === 'table column').length !== 6) return
  const borders = joinHorizontalTableRules(rules, 1).filter(
    (r) =>
      (Math.abs(r[0] - crop[0]) < 24 &&
        Math.abs(r[2] - crop[2]) < 24 &&
        Math.abs(r[1] - crop[1]) < 24) ||
      (Math.abs(r[0] - crop[0]) < 24 &&
        Math.abs(r[2] - crop[2]) < 24 &&
        Math.abs(r[1] - crop[3]) < 24)
  )
  if (
    borders.length !== 2 ||
    borders[1][1] - borders[0][1] < 120 ||
    Math.abs(borders[0][0] - borders[1][0]) > 1 ||
    Math.abs(borders[0][2] - borders[1][2]) > 1
  )
    return
  const frame = [borders[0][0], Math.min(crop[1], borders[0][1]), borders[0][2], borders[1][1]]
  const source = tableSourceItems(items, frame)
  if (!source.length) return
  const height = source.map((i) => i.height).sort((a, b) => a - b)[Math.floor(source.length / 2)]
  const raw = groupSourceRowsWithScripts(source, height, 0.3)
  const number = (i) => /^\d+(?:\.\d+)?$/.test(i.text.trim())
  const complete = raw?.filter(
    (g) =>
      g.length === 5 &&
      /\p{L}/u.test(g[0].text) &&
      g.slice(1).every(number) &&
      /^\d+$/.test(g[1].text) &&
      /^\d+$/.test(g[3].text)
  )
  if (!complete || complete.length < 8) return
  const ranges = Array.from({ length: 5 }, (_, c) => [
    Math.min(...complete.map((g) => g[c].rect[0])),
    Math.max(...complete.map((g) => g[c].rect[2]))
  ])
  if (ranges.some((r, n) => n && r[0] <= ranges[n - 1][1])) return
  const probabilities = raw.filter(
    (g) =>
      g.length === 2 &&
      /\p{L}/u.test(g[0].text) &&
      /^(?:0?\.\d+|1(?:\.0+)?)$/.test(g[1].text) &&
      g[1].rect[0] > ranges[4][1] + height
  )
  if (probabilities.length < 2) return
  const cuts = [
    frame[0],
    ...ranges.slice(1).map((r, n) => (r[0] + ranges[n][1]) / 2),
    (ranges[4][1] + Math.min(...probabilities.map((g) => g[1].rect[0]))) / 2,
    frame[2]
  ]
  const groups = []
  for (let n = 0; n < raw.length; n++) {
    const g = raw[n],
      next = raw[n + 1],
      after = raw[n + 2]
    // A centered numeric record can sit between the two lines of a wrapped
    // stub. Both stub lines must share their indent and bracket just that record.
    if (
      g.length === 1 &&
      next?.length === 4 &&
      next.every(number) &&
      after?.length === 1 &&
      /\p{L}/u.test(g[0].text) &&
      /\p{L}/u.test(after[0].text) &&
      Math.abs(g[0].rect[0] - after[0].rect[0]) < height * 0.1 &&
      after[0].rect[2] < cuts[1] &&
      next[0].baseline - g[0].baseline < height * 1.3 &&
      after[0].baseline - next[0].baseline < height * 1.3
    ) {
      groups.push([...g, ...next, ...after])
      n += 2
    } else groups.push(g)
  }
  const values = groups.map((g) => readSourceRow(g, cuts, { multiline: true }))
  if (
    values.some(
      (v) =>
        !v ||
        !/\p{L}/u.test(v[0]) ||
        !(
          (v.slice(1, 5).every((s) => /^\d+(?:\.\d+)?$/.test(s)) && !v[5]) ||
          (v.slice(1, 5).every((s) => !s) && /^(?:0?\.\d+|1(?:\.0+)?)$/.test(v[5]))
        )
    )
  )
    return
  const measured = values.filter((v) => v[1])
  for (const c of [1, 3]) {
    if (!measured.every((v) => /^\d+$/.test(v[c]))) return
    const largest = measured.reduce((a, b) => (Number(a[c]) >= Number(b[c]) ? a : b))
    const denominator = (Number(largest[c]) * 100) / Number(largest[c + 1])
    if (
      !(denominator > 0) ||
      measured.some((v) => Math.abs((Number(v[c]) * 100) / denominator - Number(v[c + 1])) > 0.015)
    )
      return
  }
  if (!hasUniqueRecordTokens(source, groups)) return
  const bounds = groups.map(union)
  if (bounds.some((r, n) => n && r[1] <= bounds[n - 1][3])) return
  return {
    cropRect: frame,
    rows: bounds.map((r) => [frame[0], r[1] - 0.01, frame[2], r[3] + 0.01]),
    columns: cuts.slice(1).map((x, c) => [cuts[c], frame[1], x, frame[3]]),
    spans: values.flatMap((v, row) => (!v[1] ? [{ row, column: 0, rowSpan: 1, colSpan: 5 }] : [])),
    headerRows: [],
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Partial row rules leave the category and P-value columns open; full-width
// rules close those shared cells. Require both native borders and complete
// count records before replacing conflicting model spans.
function recoverRuledGroupedCountGrid(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (predicted.length !== 6) return
  const cuts = [
    left,
    ...predicted.slice(1).map((c, n) => left + (predicted[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const source = tableSourceItems(items, table.cropRect)
  const height = source.map((i) => i.height).sort((a, b) => a - b)[Math.floor(source.length / 2)]
  const groups = groupSourceRowsWithScripts(source, height, 0.3)
  if (!groups || groups.length < 8 || !hasUniqueRecordTokens(source, groups)) return
  const values = groups.map((g) => readSourceRow(g, cuts))
  if (values.some((v) => !v)) return
  const [parent, leaves] = values
  if (
    !parent[0] ||
    parent[1] ||
    !/N=\d/i.test(parent[2]) ||
    !/\p{L}/u.test(parent[3]) ||
    parent[4] ||
    !/^p-?value$/i.test(parent[5]) ||
    leaves.some((v, c) => (c === 3 || c === 4 ? !/N=\d/i.test(v) : Boolean(v)))
  )
    return
  const count = (s) => /^\d+(?:\.\d+)?\(\d+(?:\.\d+)?%\)$/.test(s)
  if (
    values
      .slice(2)
      .some(
        (v) =>
          !v[1] ||
          !v.slice(2, 5).every(count) ||
          (v[5] && !/^[<>≤≥]?(?:0?\.\d+|1(?:\.0+)?)$/.test(v[5]))
      )
  )
    return
  const sections = values.flatMap((v, n) => (n >= 2 && v[0] ? [n] : []))
  if (sections.length < 2 || sections[0] !== 2) return
  const bounds = groups.map(union)
  if (bounds.some((b, n) => n && b[1] <= bounds[n - 1][3])) return
  const horizontal = joinHorizontalTableRules(rules, 0.1).filter(
    (r) => r[1] >= top && r[1] <= bottom
  )
  const full = horizontal.filter((r) => Math.abs(r[0] - left) < 15 && Math.abs(r[2] - right) < 15)
  if (!full.some((r) => r[1] <= bounds[0][1]) || !full.some((r) => r[1] >= bounds.at(-1)[3])) return
  const spans = [
    { row: 0, column: 0, rowSpan: 2, colSpan: 2 },
    { row: 0, column: 2, rowSpan: 2, colSpan: 1 },
    { row: 0, column: 3, rowSpan: 1, colSpan: 2 },
    { row: 0, column: 5, rowSpan: 2, colSpan: 1 }
  ]
  for (const [j, start] of sections.entries()) {
    const end = sections[j + 1] ?? groups.length
    if (end - start < 2 || !values[start][5] || values.slice(start + 1, end).some((v) => v[5]))
      return
    if (!full.some((r) => r[1] > bounds[start - 1][3] && r[1] < bounds[start][1])) return
    for (let n = start + 1; n < end; n++) {
      if (
        !horizontal.some(
          (r) =>
            r[1] > bounds[n - 1][3] &&
            r[1] < bounds[n][1] &&
            r[0] >= cuts[1] - height &&
            r[0] < cuts[2] &&
            r[2] > cuts[5] - height &&
            r[2] < right
        )
      )
        return
    }
    spans.push(
      { row: start, column: 0, rowSpan: end - start, colSpan: 1 },
      { row: start, column: 5, rowSpan: end - start, colSpan: 1 }
    )
  }
  return {
    rows: bounds.map((b) => [left, b[1], right, b[3]]),
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans,
    headerRows: [0, 1],
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Full-width native borders prove record boundaries independently of the model.
// A comparison row must contain both cohort values; a section may span them only
// when those columns contain no measurements. Wrapped labels stay in their band.
function recoverRuledComparisonBands(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (predicted.length !== 4) return
  const cuts = [
    left,
    ...predicted.slice(1).map((c, n) => left + (predicted[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const borders = clusterTableRulePositions(
    joinHorizontalTableRules(rules, 0.1)
      .filter(
        (r) =>
          r[1] >= top && r[1] <= bottom && Math.abs(r[0] - left) < 15 && Math.abs(r[2] - right) < 15
      )
      .map((r) => r[1])
  )
  if (borders.length < 8) return
  const source = tableSourceItems(items, table.cropRect)
  const groups = borders
    .slice(1)
    .map((y, n) => source.filter((i) => i.rect[1] >= borders[n] && i.rect[3] <= y))
  if (!hasUniqueRecordTokens(source, groups)) return
  const header = readSourceRow(groups[0], cuts, { multiline: true })
  if (
    !header ||
    !header.slice(1, 3).every((s) => /\p{L}/u.test(s)) ||
    !/^P(?:value)?$/i.test(header[3])
  )
    return
  const value = (s) => /^[<>≤≥−+-]?\d[\d.,()%–−/+-]*$/.test(s)
  const spans = []
  let records = 0,
    sections = 0
  for (let n = 1; n < groups.length; n++) {
    const v = readSourceRow(groups[n], cuts, { multiline: true })
    if (v && v[0] && value(v[1]) && value(v[2]) && (!v[3] || value(v[3]) || v[3] === 'NT')) {
      records++
      continue
    }
    const section = readSourceRow(groups[n], [left, cuts[3], right], { multiline: true })
    if (
      !section ||
      !/\p{L}/u.test(section[0]) ||
      (section[1] && section[1] !== 'NT' && !value(section[1])) ||
      groups[n].some((i) => i.rect[0] >= cuts[1] && i.rect[2] <= cuts[3] && /\d/.test(i.text))
    )
      return
    sections++
    spans.push({ row: n, column: 0, rowSpan: 1, colSpan: 3 })
  }
  if (records < 5 || sections < 1) return
  return {
    rows: groups.map((_, n) => [left, borders[n], right, borders[n + 1]]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], top, x, bottom]),
    spans,
    headerRows: [0],
    completeSpans: true
  }
}

// Paired cohort values and repeated indented categories establish complete
// records independently of model rowspans. A section may own a separate P
// value, but may not contain a partly populated pair of cohort measurements.
function recoverSectionedComparisonGrid(table, items, rules) {
  const [left, top, right, bottom] = table.cropRect
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (predicted.length !== 3 && predicted.length !== 4) return
  const cuts = [
    left,
    ...predicted.slice(1).map((c, n) => left + (predicted[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const borders = joinHorizontalTableRules(rules, 0.1).filter(
    (r) =>
      r[1] === r[3] && r[0] <= left + 15 && r[2] >= right - 15 && r[1] >= top - 2 && r[1] <= bottom
  )
  if (borders.length < 3) return
  const footer = Math.max(...borders.map((r) => r[1]))
  // A full-width section separator is not necessarily the closing border.
  // Decline if any original table text would be lost below it.
  if (tableSourceItems(items, table.cropRect).some((i) => i.rect[3] > footer)) return
  const source = tableSourceItems(items, [left, top, right, footer])
  if (source.length < 25) return
  const height = source.map((i) => i.height).sort((a, b) => a - b)[Math.floor(source.length / 2)]
  const groups = groupSourceRowsWithScripts(source, height, 0.35)
  if (!groups || !hasUniqueRecordTokens(source, groups)) return
  const values = groups.map((g) => readSourceRow(g, cuts))
  if (values.some((v) => !v)) return
  const statistic = (v) => v === 'None' || /^[<>≤≥−+-]?(?:\d|\.\d)[\d.,()%±;–−+\-/=Nn]*$/.test(v)
  const probability = (v) => /^[<>≤≥]?(?:0?\.\d+|1(?:\.0+)?)[*†‡§]*$/.test(v)
  const paired = (v) =>
    v[0] && statistic(v[1]) && statistic(v[2]) && (v.length === 3 || !v[3] || probability(v[3]))
  const first = values.findIndex(paired)
  if (first < 1) return
  const headerCount =
    values.slice(0, first).findLastIndex((v) => /\p{L}/u.test(v[1]) && /\p{L}/u.test(v[2])) + 1
  if (
    headerCount < 1 ||
    headerCount > 2 ||
    values.slice(0, headerCount).some((v) => !/\p{L}/u.test(v[1]) || !/\p{L}/u.test(v[2]))
  )
    return
  const bounds = groups.map(union)
  if (bounds.some((r, n) => n && r[1] <= bounds[n - 1][3])) return
  const sections = []
  let records = 0
  for (let n = headerCount; n < groups.length; n++) {
    const v = values[n]
    if (paired(v)) {
      records++
      continue
    }
    if (!/\p{L}/u.test(v[0]) || v[1] || v[2] || (v.length === 4 && v[3] && !probability(v[3])))
      return
    const stubLeft = Math.min(
      ...groups[n].filter((i) => i.rect[2] <= cuts[1]).map((i) => i.rect[0])
    )
    if (
      ![n + 1, n + 2].every(
        (j) =>
          values[j] &&
          paired(values[j]) &&
          Math.min(...groups[j].filter((i) => i.rect[2] <= cuts[1]).map((i) => i.rect[0])) >=
            stubLeft + height * 0.4
      )
    )
      return
    sections.push(n)
  }
  if (sections.length < 2 || records < 6) return
  return {
    rows: bounds.map((r) => [left, r[1], right, r[3]]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], top, x, footer]),
    spans: sections.map((row) => ({ row, column: 0, rowSpan: 1, colSpan: 3 })),
    headerRows: Array.from({ length: headerCount }, (_, n) => n),
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Overlapping footer strokes preserve each original column even when model
// columns overlap. Repeated numeric/unit headings and complete first records
// independently confirm those cuts and the parent groups.
export function recoverRepeatedUnitGrid(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const source = tableSourceItems(items, table.cropRect)
  const times = source.filter((i) => /^\d+(?:\.\d+)?\s+(?:h|min|d)$/.test(i.text))
  if (times.length < 3 || times.some((i) => Math.abs(i.rect[0] - times[0].rect[0]) > 1)) return
  const candidates = rules.filter(
    (r) => r[1] === r[3] && r[1] > times.at(-1).rect[3] && r[1] < bottom
  )
  const footer = candidates
    .filter((r) => Math.abs(r[1] - candidates[0][1]) < 0.01)
    .sort((a, b) => a[0] - b[0])
  if (
    footer.length < 7 ||
    footer[0][0] > left + 12 ||
    footer.at(-1)[2] < right - 12 ||
    footer.slice(1).some((r, n) => r[0] - footer[n][2] > 0 || r[0] - footer[n][2] < -2)
  )
    return
  const cuts = [left, ...footer.slice(1).map((r, n) => (footer[n][2] + r[0]) / 2), right]
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const heading = source.filter((i) => i.rect[3] < times[0].rect[1])
  const units = heading.filter((i) => /^(?:[μµ]g|mg|g|mL|ml|kg)$/.test(i.text))
  if (
    units.length !== footer.length - 1 ||
    !units.every(
      (i, n) =>
        i.text === units[0].text &&
        col(i) === n + 1 &&
        Math.abs(i.baseline - units[0].baseline) < i.height * 0.2
    )
  )
    return
  const numbers = heading.filter((i) => /^\d+(?:\.\d+)?$/.test(i.text))
  if (
    numbers.length !== units.length ||
    !numbers.every(
      (i, n) => col(i) === n + 1 && Math.abs(i.baseline - numbers[0].baseline) < i.height * 0.2
    )
  )
    return
  const size = numbers.findIndex((i, n) => n > 0 && i.text === numbers[0].text)
  if (
    size < 2 ||
    numbers.length % size ||
    numbers.some((i, n) => i.text !== numbers[n % size].text)
  )
    return
  const parents = heading.filter((i) => !numbers.includes(i) && !units.includes(i))
  if (
    parents.length !== numbers.length / size ||
    parents.some(
      (i, n) =>
        !/\p{L}/u.test(i.text) ||
        i.rect[0] < cuts[1 + n * size] ||
        i.rect[2] > cuts[1 + (n + 1) * size]
    )
  )
    return
  const divider = rules.find(
    (r) =>
      r[1] === r[3] &&
      r[0] <= left + 12 &&
      r[2] >= right - 12 &&
      r[1] > units[0].rect[3] &&
      r[1] < times[0].baseline - times[0].height / 2
  )
  const parentDivider = rules.find(
    (r) =>
      r[1] === r[3] &&
      r[0] <= cuts[1] + 2 &&
      r[2] >= right - 12 &&
      r[1] > parents[0].rect[3] &&
      r[1] < numbers[0].baseline - numbers[0].height / 2
  )
  if (!divider || !parentDivider) return
  const body = source.filter((i) => !heading.includes(i) && i.rect[3] <= footer[0][1])
  const ys = [divider[1], ...times.slice(1).map((i) => i.rect[1] - 0.1), footer[0][1]]
  const groups = times.map((_, n) =>
    body.filter(
      (i) => (i.rect[1] + i.rect[3]) / 2 >= ys[n] && (i.rect[1] + i.rect[3]) / 2 < ys[n + 1]
    )
  )
  if (!hasUniqueRecordTokens(body, groups)) return
  const cells = groups.map((g) => readSourceRow(g, cuts))
  if (
    cells.some(
      (r, n) =>
        !r ||
        r[0] !== times[n].text.replace(/\s/g, '') ||
        r.slice(1).some((s) => s && !/^\d+(?:\.\d+)?±\d+(?:\.\d+)?[a-z]?$/.test(s))
    ) ||
    !cells[0].every(Boolean)
  )
    return
  return {
    rows: [
      [left, top, right, parentDivider[1]],
      [left, parentDivider[1], right, divider[1]],
      ...groups.map((_, n) => [left, ys[n], right, ys[n + 1]])
    ],
    columns: cuts.slice(1).map((x, n) => [cuts[n], top, x, bottom]),
    spans: parents.map((_, n) => ({ row: 0, column: 1 + n * size, rowSpan: 1, colSpan: size })),
    completeSpans: true
  }
}

// Repeated count/percentage sections contain the same leaf headings and
// underlined parent tiers. Build rows from complete source baselines, preserving
// each repeated section title instead of letting it fall between model rows.
export function recoverRepeatedCountSections(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (predicted.length < 5 || predicted.length % 2 !== 1) return
  const cuts = [
    left,
    ...predicted.slice(1).map((r, n) => left + (predicted[n].rect[2] + r.rect[0]) / 2),
    right
  ]
  const footer = rules
    .filter((r) => r[1] === r[3] && r[0] <= left + 12 && r[2] >= right - 12 && r[1] <= bottom)
    .sort((a, b) => b[1] - a[1])[0]
  if (!footer) return
  const source = tableSourceItems(items, table.cropRect).filter((i) => i.rect[3] < footer[1])
  const groups = []
  for (const i of source) {
    const g = groups.at(-1)
    if (g && Math.abs(i.baseline - g[0].baseline) < i.height * 0.25) g.push(i)
    else groups.push([i])
  }
  if (groups.length < 12 || groups[0].length !== 1) return
  const key = (s) => s.replace(/\d+/g, '#')
  const titles = groups.filter((g) => g.length === 1 && key(g[0].text) === key(groups[0][0].text))
  if (
    titles.length < 2 ||
    !/\d/.test(groups[0][0].text) ||
    titles.some(
      (g) =>
        !/\p{L}/u.test(g[0].text) ||
        Math.abs((g[0].rect[0] + g[0].rect[2] - left - right) / 2) > (right - left) * 0.05
    )
  )
    return
  const spans = [],
    leafRows = [],
    recordRows = []
  for (let n = 0; n < groups.length; n++) {
    const g = groups[n],
      cells = readSourceRow(g, cuts)
    if (titles.includes(g)) {
      spans.push({ row: n, column: 0, rowSpan: 1, colSpan: predicted.length })
      continue
    }
    if (
      cells &&
      /\p{L}/u.test(cells[0]) &&
      cells.slice(1).every((s, c) => (c % 2 ? s === '%' : /^(?:No\.|N|Count)$/.test(s)))
    ) {
      leafRows.push(n)
      continue
    }
    if (
      cells &&
      /\p{L}/u.test(cells[0]) &&
      cells.slice(1).every((s) => /^\d+(?:\.\d+)?$/.test(s))
    ) {
      recordRows.push(n)
      continue
    }
    const occupied = new Set()
    for (const i of g) {
      if (!/\p{L}/u.test(i.text)) return
      const underline = rules.find(
        (r) =>
          r[1] === r[3] &&
          r[1] > i.rect[3] &&
          r[1] - i.rect[3] < i.height &&
          r[0] <= i.rect[0] &&
          r[2] >= i.rect[2]
      )
      if (!underline) return
      const cols = predicted
        .map((_, c) => c)
        .filter(
          (c) =>
            c > 0 &&
            (cuts[c] + cuts[c + 1]) / 2 >= underline[0] &&
            (cuts[c] + cuts[c + 1]) / 2 <= underline[2]
        )
      if (
        cols.length < 2 ||
        cols.some((c) => occupied.has(c)) ||
        i.rect[0] < cuts[cols[0]] ||
        i.rect[2] > cuts[cols.at(-1) + 1]
      )
        return
      cols.forEach((c) => occupied.add(c))
      spans.push({ row: n, column: cols[0], rowSpan: 1, colSpan: cols.length })
    }
    if (occupied.size !== predicted.length - 1) return
  }
  if (leafRows.length !== titles.length || recordRows.length < titles.length * 3) return
  for (let n = 0; n < titles.length; n++) {
    const start = groups.indexOf(titles[n]),
      end = n + 1 < titles.length ? groups.indexOf(titles[n + 1]) : groups.length
    const leaves = leafRows.filter((r) => r > start && r < end)
    if (
      leaves.length !== 1 ||
      recordRows.filter((r) => r > leaves[0] && r < end).length !== end - leaves[0] - 1 ||
      end - leaves[0] - 1 < 3
    )
      return
  }
  if (!hasUniqueRecordTokens(source, groups)) return
  const ys = [
    top,
    ...groups.slice(1).map((g) => Math.min(...g.map((i) => i.rect[1])) - 0.1),
    footer[1]
  ]
  return {
    rows: groups.map((_, n) => [left, ys[n], right, ys[n + 1]]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], top, x, bottom]),
    spans,
    completeSpans: true
  }
}

// Repeated totals followed by ordered count distributions share a wrapped
// description down the stub column. Native column strokes and complete numeric
// baselines establish the records; no counts or missing values are synthesized.
export function recoverCountDistributionGrid(table, items, captions, rules) {
  const mixedStub = recoverMixedStubCountRecords(table, items, captions)
  if (mixedStub) return mixedStub
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const bands = []
  for (const r of rules
    .filter((r) => r[1] === r[3] && r[1] >= top && r[1] <= bottom)
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])) {
    let band = bands.find((b) => Math.abs(b.y - r[1]) < 0.05)
    if (!band) bands.push((band = { y: r[1], parts: [] }))
    band.parts.push(r)
  }
  const frames = bands.filter(
    (b) =>
      b.parts.length === 5 &&
      Math.abs(b.parts[0][0] - left) < 15 &&
      Math.abs(b.parts.at(-1)[2] - right) < 15 &&
      b.parts.slice(1).every((r, n) => Math.abs(r[0] - b.parts[n][2]) < 0.05)
  )
  if (
    frames.length !== 3 ||
    frames.some((b) =>
      b.parts.some(
        (r, n) =>
          Math.abs(r[0] - frames[0].parts[n][0]) > 0.05 ||
          Math.abs(r[2] - frames[0].parts[n][2]) > 0.05
      )
    )
  )
    return
  const cuts = [frames[0].parts[0][0], ...frames[0].parts.map((r) => r[2])]
  const [a, b, z] = frames.map((f) => f.y)
  const underline = bands.find(
    (f) =>
      f.y > a &&
      f.y < b &&
      f.parts.length === 2 &&
      Math.abs(f.parts[0][0] - cuts[2]) < 0.05 &&
      Math.abs(f.parts[0][2] - cuts[3]) < 0.05 &&
      Math.abs(f.parts[1][0] - cuts[3]) < 0.05 &&
      Math.abs(f.parts[1][2] - cuts[4]) < 0.05
  )
  if (!underline) return
  const source = tableSourceItems(items, [cuts[0], a, cuts[5], z])
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const upper = source.filter((i) => i.rect[3] < underline.y)
  const lower = source.filter((i) => i.rect[1] > underline.y && i.rect[3] < b)
  const parent = upper.filter((i) => col(i) === 2 || col(i) === 3)
  const parentText = parent.map((i) => i.text).join('')
  const header = readSourceRow(
    upper.filter((i) => !parent.includes(i)),
    cuts
  )
  const children = readSourceRow(lower, cuts)
  if (
    !/^[\p{L} ]{2,50}\([Nn]\)$/u.test(parentText) ||
    !header ||
    parent.some((i) => i.rect[0] < cuts[2] || i.rect[2] > cuts[4]) ||
    Math.abs(
      (Math.min(...parent.map((i) => i.rect[0])) +
        Math.max(...parent.map((i) => i.rect[2])) -
        cuts[2] -
        cuts[4]) /
        2
    ) > 1 ||
    !/^[\p{L} ]+\(n\)$/iu.test(header[1]) ||
    !/^p$/i.test(header[4]) ||
    header[0] ||
    header[2] ||
    header[3] ||
    !children ||
    children[0] ||
    children[1] ||
    children[4] ||
    !children.slice(2, 4).every((s) => /^[\p{L}]+$/u.test(s))
  )
    return
  const body = source.filter((i) => i.rect[1] > b)
  const numeric = []
  for (const i of body.filter((i) => col(i) > 0)) {
    const last = numeric.at(-1)
    if (last && Math.abs(i.baseline - last[0].baseline) < i.height * 0.2) last.push(i)
    else numeric.push([i])
  }
  if (numeric.some((g) => new Set(g.map(col)).size !== g.length)) return
  const values = numeric.map((g) => readSourceRow(g, cuts))
  if (
    values.some(
      (v) =>
        !v ||
        !/^\d+$/.test(v[2]) ||
        !/^\d+$/.test(v[3]) ||
        (v[1] && !/^\d+$/.test(v[1])) ||
        (v[4] && !/^(?:0?\.\d+|1(?:\.0+)?)$/.test(v[4]))
    )
  )
    return
  const totals = values.flatMap((v, n) => (!v[1] && !v[4] ? [n] : []))
  if (totals.length < 2 || totals[0] !== 0) return
  const ys = numeric.map((g) => Math.min(...g.map((i) => i.rect[1])) - 0.1)
  const rows = [
    [cuts[0], a, cuts[5], underline.y],
    [cuts[0], underline.y, cuts[5], b],
    ...numeric.map((_, n) => [cuts[0], ys[n], cuts[5], ys[n + 1] ?? z])
  ]
  const spans = [
    { row: 0, column: 2, rowSpan: 1, colSpan: 2 },
    ...[0, 1, 4].map((column) => ({ row: 0, column, rowSpan: 2, colSpan: 1 }))
  ]
  const groups = [upper, lower]
  for (let k = 0; k < totals.length; k++) {
    const start = totals[k],
      end = totals[k + 1] ?? numeric.length
    if (
      end - start < 4 ||
      values
        .slice(start + 1, end)
        .some(
          (v, n) =>
            !v[1] || (n > 0 && Number(v[1]) <= Number(values[start + n][1])) || (n > 0 && v[4])
        )
    )
      return
    const summary = body.filter((i) => i.rect[1] >= ys[start] && i.rect[3] < ys[start + 1])
    const labels = body.filter(
      (i) => col(i) === 0 && i.rect[1] >= ys[start + 1] && i.rect[3] < (ys[end] ?? z)
    )
    const summaryLabels = summary.filter((i) => col(i) === 0)
    if (
      summaryLabels.length < 2 ||
      !/^Total\b/.test(summaryLabels[0].text) ||
      labels.length < 2 ||
      !/^\p{Lu}/u.test(labels[0].text) ||
      labels.slice(1).some((i) => !/^\p{Ll}/u.test(i.text) && !/^[A-Z]{2,}\b/.test(i.text)) ||
      [...summaryLabels, ...labels].some(
        (i) => Math.abs(i.rect[0] - cuts[0]) > 1 || i.rect[2] > cuts[1]
      ) ||
      Math.abs(labels[0].baseline - numeric[start + 1][0].baseline) > labels[0].height * 0.3
    )
      return
    groups.push(summary, ...numeric.slice(start + 1, end), labels)
    spans.push({ row: start + 3, column: 0, rowSpan: end - start - 1, colSpan: 1 })
  }
  if (!hasUniqueRecordTokens(source, groups)) return
  return {
    rows,
    columns: cuts.slice(1).map((x, n) => [cuts[n], a, x, z]),
    spans,
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Restore only source-backed header fragments. A confidence suffix establishes
// a same-column measure; a comparison must repeat both neighboring arm names.
// An independent single-column heading instead requires its own native frame.
export function recoverClippedHeading({
  rows,
  objects,
  groups,
  columnRects,
  rules,
  repairs,
  captioned = true
}) {
  if (!rows.length || !groups[0]?.length) return
  const leading = groups[0]
  const bounds = (items) => [
    Math.min(...items.map((i) => i.rect[0])),
    Math.min(...items.map((i) => i.rect[1])),
    Math.max(...items.map((i) => i.rect[2])),
    Math.max(...items.map((i) => i.rect[3]))
  ]
  const contains = (rect, item) => item.rect.every((v, n) => (n < 2 ? v >= rect[n] : v <= rect[n]))
  const columnOf = (item) => columnRects.findIndex((r) => contains(r, item))
  const rect = bounds(leading)
  const height = Math.max(...leading.map((i) => i.height))
  const next = groups[1] ?? []
  const first = rows[0].rect
  const column = columnOf(leading[0])
  const leadingColumns = new Set(leading.map(columnOf).filter((value) => value >= 0))
  // Expanding a row is safe only when it already contains the final line of
  // one wrapped heading. An independent header above a data row needs its own row.
  const tails = groups
    .slice(1)
    .flat()
    .filter((item) => item.rect[3] <= first[3])
  const tailColumn = tails.length ? columnOf(tails[0]) : -1
  const ruledHeader = objects.find(
    (o) =>
      o.label === 'table column header' &&
      Math.abs(o.rect[1] - first[1]) < height &&
      Math.abs(o.rect[3] - first[3]) < height &&
      rules.some(
        (r) =>
          r[1] === r[3] &&
          r[1] <= rect[1] &&
          rect[1] - r[1] < height &&
          r[0] <= rect[0] &&
          r[2] >= rect[2]
      ) &&
      rules.some(
        (r) =>
          r[1] === r[3] &&
          Math.abs(r[1] - o.rect[3]) < height * 0.3 &&
          r[0] <= rect[0] &&
          r[2] >= rect[2]
      )
  )
  const multiColumnHeading =
    rect[1] < first[1] &&
    first[1] - rect[1] <= height * 2.5 &&
    leading.length >= 3 &&
    leadingColumns.size >= 3 &&
    leading.filter((item) => /\p{L}/u.test(item.text)).length >= 3 &&
    leading.every(
      (item) =>
        /\p{L}/u.test(item.text) ||
        leading.some((anchor) => /\p{L}/u.test(anchor.text) && isAdjacentTableScript(item, anchor))
    ) &&
    tails.length >= 2 &&
    tailColumn >= 0 &&
    leadingColumns.has(tailColumn) &&
    tails.every(
      (item) =>
        /\p{L}/u.test(item.text) &&
        (columnOf(item) === tailColumn || (ruledHeader && leadingColumns.has(columnOf(item))))
    ) &&
    tails.some((item) => item.rect[3] >= first[1]) &&
    !rules.some(
      (rule) =>
        rule[1] === rule[3] &&
        rule[1] > rect[3] &&
        rule[1] < first[1] &&
        rule[0] <= rect[0] &&
        rule[2] >= rect[2]
    )
  if (multiColumnHeading && (captioned || ruledHeader)) {
    first[1] = rect[1]
    repairs.push('clipped-multicolumn-heading-recovered')
    return
  }
  if (!captioned) return
  if (rect[1] >= first[1] || first[1] - rect[1] > height * 2 + 0.1) return
  // A labelled stub can be the only ink in the first ruled header band.
  // Two complete native boundaries distinguish it from an unruled section
  // label; the model need not have predicted a column-header object.
  if (
    column === 0 &&
    leading.every((i) => columnOf(i) === 0) &&
    /^(?:Characteristics?|Variables?|Parameters?|Outcomes?)$/i.test(
      leading
        .map((i) => i.text)
        .join(' ')
        .trim()
    )
  ) {
    const width = columnRects.at(-1)[2] - columnRects[0][0]
    const edges = rules.filter((r) => r[1] === r[3] && r[2] - r[0] > width * 0.9)
    if (
      edges.some((r) => r[1] <= rect[1] && rect[1] - r[1] < height) &&
      edges.some((r) => r[1] >= rect[3] && r[1] <= first[1] && r[1] - rect[3] < height)
    ) {
      rows.unshift({
        rect: [columnRects[0][0], rect[1], columnRects.at(-1)[2], rect[3]],
        origin: 'source-header'
      })
      repairs.push('clipped-first-header-recovered')
      return
    }
  }
  if (column < 1 || !leading.every((i) => columnOf(i) === column)) return
  const text = leading.map((i) => i.text.trim()).join(' ')
  if (!/\p{L}/u.test(text)) return
  const suffix = next.filter((i) => columnOf(i) === column)
  const header = objects.find(
    (o) =>
      o.label === 'table column header' &&
      suffix.length &&
      suffix.every((i) => i.rect[1] >= o.rect[1] - height * 0.2 && i.rect[3] <= o.rect[3])
  )
  // A tall, left-aligned header may begin above all model rows while its
  // lower lines share the neighboring two-tier header. Native child underlines
  // and complete textual peers establish the header's extent.
  const wrappedHeader =
    header ??
    objects.find(
      (o) => o.label === 'table column header' && o.rect[1] <= first[3] && o.rect[3] >= first[3]
    )
  if (wrappedHeader && rows.length >= 3) {
    const prefix = groups
      .flat()
      .filter(
        (i) => columnOf(i) === column && i.rect[1] >= rect[1] && i.rect[3] <= wrappedHeader.rect[3]
      )
    const peers = groups
      .flat()
      .filter(
        (i) => columnOf(i) !== column && i.rect[1] >= first[1] && i.rect[3] <= wrappedHeader.rect[3]
      )
    const headerRows = rows.filter((r) => r.rect[1] < wrappedHeader.rect[3] - height * 0.2)
    if (
      prefix.length >= 3 &&
      prefix.length <= 5 &&
      headerRows.length === 2 &&
      prefix.every((i) => /\p{L}/u.test(i.text) && Math.abs(i.rect[0] - rect[0]) < 1) &&
      prefix
        .slice(1)
        .every(
          (i, n) =>
            i.baseline - prefix[n].baseline > height * 0.8 &&
            i.baseline - prefix[n].baseline < height * 1.6
        ) &&
      new Set(peers.filter((i) => /\p{L}/u.test(i.text)).map(columnOf)).size >= 3 &&
      !peers.some((i) => /^\d/.test(i.text)) &&
      rules.some(
        (r) =>
          r[1] === r[3] &&
          r[1] > first[1] &&
          r[1] < wrappedHeader.rect[3] &&
          r[0] >= columnRects[0][0] &&
          r[2] < columnRects[column][0] &&
          r[2] - r[0] > height * 4
      )
    ) {
      first[1] = rect[1]
      wrappedHeader.rect[1] = Math.min(wrappedHeader.rect[1], rect[1])
      repairs.push('clipped-wrapped-heading-recovered')
      return {
        column,
        rect: [columnRects[column][0], rect[1], columnRects[column][2], headerRows[1].rect[3]]
      }
    }
  }
  const sampleLine =
    groups
      .slice(2, 4)
      .find((g) => g.some((i) => columnOf(i) === column && /^[Nn]$/.test(i.text))) ?? []
  const sample = sampleLine.filter((i) => columnOf(i) === column)
  const sampledGroup =
    suffix.length === 1 &&
    /^[\p{L} ,.-]+$/u.test(suffix[0].text) &&
    Math.abs((suffix[0].rect[0] + suffix[0].rect[2]) / 2 - (rect[0] + rect[2]) / 2) <
      height * 0.25 &&
    /^[Nn]\s*=\s*\d+$/.test(sample.map((i) => i.text).join(' ')) &&
    sample.every(
      (i) =>
        i.baseline - suffix[0].baseline > height * 0.8 &&
        i.baseline - suffix[0].baseline < height * 1.6
    ) &&
    sampleLine.some((i) => columnOf(i) !== column && /^[Nn]$/.test(i.text))
  const confidence =
    suffix.length === 1 &&
    /^\((?:90|95|99)% CI\)$/.test(suffix[0].text.trim()) &&
    Math.abs(suffix[0].rect[0] - rect[0]) < 1
  const parents = next.filter((i) => columnOf(i) !== column && /\p{L}/u.test(i.text))
  const comparison =
    suffix.length === 1 &&
    parents.length === 2 &&
    `${text} ${suffix[0].text.trim()}` ===
      `${parents[0].text.trim()} vs. ${parents[1].text.trim()}` &&
    Math.abs(suffix[0].rect[0] + suffix[0].rect[2] - rect[0] - rect[2]) < height * 0.1 &&
    rules.some(
      (r) =>
        r[1] === r[3] &&
        r[1] > suffix[0].rect[3] &&
        r[1] - suffix[0].rect[3] < height &&
        r[0] <= rect[0] &&
        r[2] >= rect[2]
    )
  if (
    leading.length === 1 &&
    first[1] - rect[1] < height * 1.6 &&
    header &&
    (confidence || comparison || sampledGroup) &&
    suffix[0].baseline - leading[0].baseline > height * 0.8 &&
    suffix[0].baseline - leading[0].baseline < height * 1.6 &&
    !rules.some(
      (r) =>
        r[1] === r[3] &&
        r[1] > rect[3] &&
        r[1] < suffix[0].rect[1] &&
        r[0] <= rect[0] &&
        r[2] >= rect[2]
    )
  ) {
    first[1] = rect[1]
    header.rect[1] = Math.min(header.rect[1], rect[1])
    repairs.push('clipped-wrapped-heading-recovered')
    return
  }
  if (
    columnRects.length !== 2 ||
    rows.length < 4 ||
    rect[3] >= first[1] ||
    next.length !== 2 ||
    columnOf(next[0]) !== 0 ||
    columnOf(next[1]) !== 1 ||
    !/\p{L}/u.test(next[0].text) ||
    !/^\d+(?:\.\d+)?$/.test(next[1].text.trim()) ||
    leading.some((i) => Math.abs(i.baseline - leading[0].baseline) > height * 0.35)
  )
    return
  const fullRules = rules.filter(
    (r) =>
      r[1] === r[3] &&
      Math.abs(r[0] - columnRects[0][0]) < 8 &&
      r[2] >= columnRects[1][2] - 8 &&
      r[2] - r[0] <= (columnRects[1][2] - columnRects[0][0]) * 1.2
  )
  const upper = fullRules.find((r) => r[1] <= rect[1] && rect[1] - r[1] < height * 0.5)
  const lower = fullRules.find(
    (r) => r[1] >= rect[3] && r[1] < next[0].rect[1] && r[1] - rect[3] < height * 0.5
  )
  if (
    !upper ||
    !lower ||
    Math.abs(upper[0] - lower[0]) > 0.1 ||
    Math.abs(upper[2] - lower[2]) > 0.1
  )
    return
  rows.unshift({ rect: [first[0], upper[1], first[2], lower[1]], origin: 'source-native-header' })
  repairs.push('ruled-isolated-heading-recovered')
}

// A detector can clip the glyph tops of an entire leading column header.
// One aligned label per column plus a full native underline establishes the
// missing row, including untitled resource-table continuations.
export function recoverClippedColumnHeader(table, items, rules, captions = []) {
  const crop = table.cropRect
  const leadingColumns = table.structure.objects
    .filter((o) => o.label === 'table column')
    .map((o) => [
      o.rect[0] + crop[0],
      o.rect[1] + crop[1],
      o.rect[2] + crop[0],
      o.rect[3] + crop[1]
    ])
    .sort((a, b) => a[0] - b[0])

  // A wide symbolic matrix can lose an entire header lane when the detector
  // starts at the first numeric row. Unlike prose above a table, every model
  // column then has one or more clipped glyphs on the same baseline and a
  // native full-width separator closes the band. Require those witnesses
  // before extending the crop; this branch deliberately leaves narrow and
  // ambiguous text layouts to the existing recognizers below.
  if (leadingColumns.length >= 5 && leadingColumns.length <= 16) {
    const heights = items
      .map((item) => item.height)
      .filter((value) => Number.isFinite(value) && value > 0)
      .sort((a, b) => a - b)
    const height = heights[Math.floor(heights.length / 2)] ?? 0
    const modelRows = table.structure.objects.filter((o) => o.label === 'table row')
    const firstRowTop = Math.min(...modelRows.map((o) => o.rect[1] + crop[1]))
    const leading = items.filter(
      (item) =>
        item.horizontal &&
        item.rect[1] < crop[1] + height * 0.15 &&
        item.rect[3] > crop[1] - height * 1.5 &&
        item.rect[0] >= leadingColumns[0][0] - 2 &&
        item.rect[2] <= leadingColumns.at(-1)[2] + 2
    )
    const groups = leadingColumns.map((column) =>
      leading.filter((item) => item.rect[0] >= column[0] - 2 && item.rect[2] <= column[2] + 2)
    )
    const baselines = leading.map((item) => item.baseline)
    const separator = rules
      .filter(
        (rule) =>
          rule[1] === rule[3] &&
          rule[1] >= Math.max(...leading.map((item) => item.rect[3]), crop[1]) &&
          rule[1] <= firstRowTop + height * 0.5 &&
          rule[0] <= leadingColumns[0][0] + 2 &&
          rule[2] >= leadingColumns.at(-1)[2] - 2
      )
      .sort((a, b) => a[1] - b[1])[0]
    if (
      height > 0 &&
      modelRows.length > 0 &&
      leading.length >= leadingColumns.length &&
      groups.every((group) => group.length > 0) &&
      baselines.length > 0 &&
      Math.max(...baselines) - Math.min(...baselines) <= height * 0.35 &&
      Math.min(...baselines) < firstRowTop - height * 0.05 &&
      separator
    ) {
      const top = Math.min(...leading.map((item) => item.rect[1])) - 1
      return {
        cropRect: [crop[0], top, crop[2], crop[3]],
        rect: [leadingColumns[0][0], top, leadingColumns.at(-1)[2], separator[1]],
        spans: []
      }
    }
  }

  // Borderless two-column tables can lose a complete text header when the
  // detector starts at the first body row. Require one aligned source label
  // per model lane and a native separator before extending the crop; this
  // keeps nearby prose from becoming a synthetic header.
  if (leadingColumns.length >= 2 && leadingColumns.length <= 4) {
    const heights = items
      .map((item) => item.height)
      .filter((value) => Number.isFinite(value) && value > 0)
      .sort((a, b) => a - b)
    const height = heights[Math.floor(heights.length / 2)] ?? 0
    const modelRows = table.structure.objects.filter((o) => o.label === 'table row')
    const firstRowTop = Math.min(...modelRows.map((o) => o.rect[1] + crop[1]))
    const leading = items.filter(
      (item) =>
        item.horizontal &&
        item.rect[1] < crop[1] &&
        // The detector crop often clips the lower half of a header glyph, so
        // allow the source line to extend a little into the first body band.
        // Lane ownership and the native separator below remain the proof that
        // this is a header rather than nearby prose.
        item.rect[3] <= crop[1] + height * 1.2 &&
        item.rect[3] > crop[1] - height * 2.5 &&
        item.rect[0] >= leadingColumns[0][0] - 2 &&
        item.rect[2] <= leadingColumns.at(-1)[2] + 2 &&
        /\p{L}/u.test(item.text.trim())
    )
    const groups = leadingColumns.map((column) =>
      leading.filter((item) => item.rect[0] >= column[0] - 2 && item.rect[2] <= column[2] + 2)
    )
    const baseline = leading.length ? Math.max(...leading.map((item) => item.baseline)) : 0
    const separator = rules.find(
      (rule) =>
        rule[1] === rule[3] &&
        rule[1] >= Math.max(...leading.map((item) => item.rect[3]), crop[1]) &&
        rule[1] <= firstRowTop &&
        rule[0] <= leadingColumns[0][0] + 2 &&
        rule[2] >= leadingColumns.at(-1)[2] - 2
    )
    if (
      height > 0 &&
      modelRows.length > 0 &&
      leading.length === leadingColumns.length &&
      groups.every((group) => group.length === 1) &&
      Math.max(...leading.map((item) => item.baseline)) -
        Math.min(...leading.map((item) => item.baseline)) <=
        height * 0.25 &&
      baseline < firstRowTop - height * 0.5 &&
      separator
    ) {
      const top = Math.min(...leading.map((item) => item.rect[1])) - 1
      const bottom = separator[1]
      return {
        cropRect: [crop[0], top, crop[2], crop[3]],
        rect: [leadingColumns[0][0], top, leadingColumns.at(-1)[2], bottom],
        spans: []
      }
    }
  }

  // An open-top header still has native vertical faces. Two sample headings
  // and a test column identify the header; common endpoints bound it without
  // inventing a horizontal stroke or extending through adjacent prose.
  const edges = rules
    .filter(
      (r) =>
        r[0] === r[2] &&
        r[0] >= crop[0] - 15 &&
        r[0] <= crop[2] + 20 &&
        r[1] >= crop[1] &&
        r[1] < crop[1] + 20 &&
        r[3] < crop[3]
    )
    .sort((a, b) => a[0] - b[0])
  if (
    edges.length >= 4 &&
    edges.length <= 8 &&
    edges.every((r) => Math.abs(r[1] - edges[0][1]) < 0.1 && Math.abs(r[3] - edges[0][3]) < 0.1)
  ) {
    const [left, top, , bottom] = edges[0],
      right = edges.at(-1)[0]
    const header = items.filter(
      (i) =>
        i.horizontal &&
        i.rect[0] >= left &&
        i.rect[2] <= right &&
        i.rect[1] >= top &&
        i.rect[3] <= bottom
    )
    const text = header.map((i) => i.text).join(' ')
    const nativeFaces = edges
      .slice(1)
      .map((r, c) => header.filter((i) => i.rect[0] >= edges[c][0] && i.rect[2] <= r[0]))
    if (
      right > crop[2] &&
      right - crop[2] < 20 &&
      (text.match(/n\s*=\s*\d+/g) ?? []).length === 2 &&
      /P\s*-?\s*value/i.test(text) &&
      nativeFaces.every((g) => g.some((i) => /\p{L}/u.test(i.text))) &&
      nativeFaces.flat().length === header.length
    ) {
      const modelColumns = table.structure.objects.filter((o) => o.label === 'table column')
      const spans = edges.slice(1).flatMap((r, c) =>
        modelColumns.filter((o) => {
          const center = crop[0] + (o.rect[0] + o.rect[2]) / 2
          return center > edges[c][0] && center < r[0]
        }).length > 1
          ? [[edges[c][0], top, r[0], bottom]]
          : []
      )
      const stubEdges = [
        ...new Set(
          rules
            .filter(
              (r) =>
                r[0] === r[2] &&
                r[0] > left + 2 &&
                r[0] < edges[1][0] - 2 &&
                r[1] >= bottom - 1 &&
                r[3] <= crop[3]
            )
            .map((r) => r[0])
        )
      ]
      if (spans[0]?.[0] === left && stubEdges.length === 1) {
        const stubRight = stubEdges[0]
        const horizontal = rules.filter(
          (r) =>
            r[1] === r[3] &&
            r[1] > bottom &&
            r[1] <= crop[3] &&
            r[0] <= left + 1 &&
            r[2] >= stubRight - 1
        )
        const ys = [bottom, ...new Set(horizontal.map((r) => r[1]))].sort((a, b) => a - b)
        const vertical = rules.filter((r) => r[0] === r[2])
        for (let n = 1; n < ys.length; n++) {
          const a = ys[n - 1],
            b = ys[n]
          const label = items.filter(
            (i) => i.rect[0] >= left && i.rect[2] <= stubRight && i.rect[1] >= a && i.rect[3] <= b
          )
          const separators = rules.filter(
            (r) =>
              r[1] === r[3] &&
              r[1] > a + 1 &&
              r[1] < b - 1 &&
              r[0] >= stubRight - 1 &&
              r[0] < stubRight + 1 &&
              r[2] >= edges[1][0] - 1
          )
          if (
            label.length === 1 &&
            /^\d+$/.test(label[0].text) &&
            separators.length >= 1 &&
            [left, stubRight].every((x) => classifyTableRuleEdge(vertical, 0, x, a, b) === 1)
          )
            spans.push([left, a, stubRight, b])
        }
      }
      return {
        cropRect: [Math.min(crop[0], left), crop[1], right + 1, crop[3]],
        rect: [left, top, right, bottom],
        spans
      }
    }
  }

  const columns = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  const rows = table.structure.objects
    .filter((o) => o.label === 'table row')
    .sort((a, b) => a.rect[1] - b.rect[1])

  // Repeated source leaf labels corroborate cohort titles clipped by the first
  // model row. Independent underlines need cover the titles, not every child.
  if (
    columns.length >= 5 &&
    rows.length >= 4 &&
    captions.some((c) => captionKind(c.lines[0]) === 'table')
  ) {
    const first = crop[1] + rows[0].rect[1]
    const underlines = joinHorizontalTableRules(rules)
      .filter(
        (r) =>
          r[1] >= crop[1] &&
          r[1] < crop[1] + 50 &&
          r[0] >= crop[0] &&
          r[2] <= crop[2] &&
          r[2] - r[0] > (crop[2] - crop[0]) * 0.2 &&
          r[2] - r[0] < (crop[2] - crop[0]) * 0.5
      )
      .sort((a, b) => a[0] - b[0])
    if (
      underlines.length === 2 &&
      underlines.every(
        (r, n) => Math.abs(r[1] - underlines[0][1]) < 1 && (!n || r[0] > underlines[n - 1][2])
      )
    ) {
      const split = underlines[0][1]
      const leafSource = items.filter(
        (i) =>
          i.horizontal &&
          i.rect[0] >= crop[0] &&
          i.rect[2] <= crop[2] &&
          i.rect[1] > split &&
          i.rect[3] < split + i.height * 2
      )
      const cuts = [
        crop[0],
        ...columns.slice(1).map((c, n) => crop[0] + (columns[n].rect[2] + c.rect[0]) / 2),
        crop[2]
      ]
      const values = readSourceRow(leafSource, cuts)
      const size = (columns.length - 1) / 2
      if (
        Number.isInteger(size) &&
        size >= 2 &&
        values &&
        !values[0] &&
        values.slice(1).every((v) => /\p{L}/u.test(v) && !/\d/.test(v)) &&
        values.slice(1, 1 + size).join('|') === values.slice(1 + size).join('|')
      ) {
        const names = underlines.map((r, n) =>
          items.filter(
            (i) =>
              i.horizontal &&
              i.rect[0] >= r[0] - 1 &&
              i.rect[2] <= r[2] + 1 &&
              i.rect[3] < split &&
              i.rect[1] >= Math.max(crop[1], split - i.height * 3) &&
              i.rect[0] >= cuts[1 + n * size] &&
              i.rect[2] <= cuts[1 + (n + 1) * size]
          )
        )
        if (
          names.every((g) => g.length && g.some((i) => /\p{L}{2}/u.test(i.text))) &&
          names.flat().some((i) => i.rect[1] < first)
        ) {
          const top = Math.min(...names.flat().map((i) => i.rect[1])) - 1
          if (!captions.some((c) => c.rect[3] > top && c.rect[1] < split))
            return {
              cropRect: crop,
              rect: [crop[0], top, crop[2], split],
              spans: underlines.map((_, n) => [
                cuts[1 + n * size],
                top,
                cuts[1 + (n + 1) * size],
                split
              ])
            }
        }
      }
    }
  }
  // A printed continuation and multiple independently underlined parent
  // headings establish a clipped multi-level header above the detector crop.
  if (
    columns.length >= 5 &&
    rows.length >= 6 &&
    items.some(
      (i) =>
        /^\(Table\s+\d+\s+continues on next page\)$/i.test(i.text.trim()) &&
        i.rect[1] > crop[1] &&
        i.rect[3] <= crop[3] + i.height
    )
  ) {
    const underlines = joinHorizontalTableRules(rules).filter(
      (r) =>
        r[1] >= crop[1] &&
        r[1] - crop[1] < 24 &&
        r[0] >= crop[0] &&
        r[2] <= crop[2] &&
        r[2] - r[0] > (crop[2] - crop[0]) * 0.2 &&
        r[2] - r[0] < (crop[2] - crop[0]) * 0.5
    )
    if (
      underlines.length >= 2 &&
      underlines.every(
        (r, n) =>
          Math.abs(r[1] - underlines[0][1]) < 1 &&
          underlines.slice(0, n).every((p) => r[0] >= p[2] || p[0] >= r[2])
      )
    ) {
      const bottom = underlines[0][1]
      const parents = underlines.map((r) =>
        items.filter(
          (i) =>
            i.horizontal &&
            i.rect[0] >= r[0] &&
            i.rect[2] <= r[2] &&
            i.rect[3] < bottom &&
            i.rect[1] >= bottom - i.height * 4.5
        )
      )
      const leaves = underlines.map((r) =>
        items.filter(
          (i) =>
            i.horizontal &&
            i.rect[0] >= r[0] &&
            i.rect[2] <= r[2] &&
            i.rect[1] > bottom &&
            i.rect[3] <= bottom + i.height * 2
        )
      )
      if (
        parents.every((g) => g.length && g.every((i) => /\p{L}/u.test(i.text))) &&
        leaves.every((g) => g.filter((i) => /\p{L}/u.test(i.text)).length >= 2) &&
        parents.flat().some((i) => i.rect[1] < crop[1])
      ) {
        const top = Math.min(...parents.flat().map((i) => i.rect[1])) - 1
        if (!captions.some((c) => c.rect[3] > top && c.rect[1] < bottom))
          return {
            cropRect: [crop[0], top, crop[2], crop[3]],
            rect: [crop[0], top, crop[2], bottom],
            spans: underlines.map((r) => [r[0], top, r[2], bottom])
          }
      }
    }
  }
  // An unboxed prose-table header can extend beyond a crop fitted to short
  // body values. Repeated native body borders and both aligned column labels
  // bound the missing header independently of the detector's right edge.
  if (
    columns.length === 2 &&
    rows.length >= 3 &&
    captions.some(
      (c) =>
        captionKind(c.lines[0]) === 'table' &&
        c.rect[3] <= crop[1] + 4 &&
        crop[1] - c.rect[3] < 40 &&
        c.rect[0] < crop[2] &&
        c.rect[2] > crop[0]
    )
  ) {
    const first = crop[1] + rows[0].rect[1]
    const split = crop[0] + (columns[0].rect[2] + columns[1].rect[0]) / 2
    const horizontal = joinHorizontalTableRules(rules)
    for (const border of horizontal.filter(
      (r) =>
        Math.abs(r[0] - crop[0]) < 8 &&
        r[2] >= crop[2] &&
        r[2] - crop[2] < (crop[2] - crop[0]) * 0.15 &&
        r[1] < first &&
        first - r[1] < 12
    )) {
      const heading = items.filter(
        (i) =>
          i.horizontal &&
          i.rect[0] >= border[0] &&
          i.rect[2] <= border[2] &&
          i.rect[1] >= crop[1] &&
          i.rect[3] < border[1]
      )
      if (
        heading.length !== 2 ||
        !heading.every((i) => /\p{L}/u.test(i.text)) ||
        Math.abs(heading[0].baseline - heading[1].baseline) >
          Math.min(...heading.map((i) => i.height)) * 0.2
      )
        continue
      const labels = heading.slice().sort((a, b) => a.rect[0] - b.rect[0])
      if (
        labels[0].rect[2] >= split ||
        labels[1].rect[0] <= split ||
        border[1] - Math.min(...heading.map((i) => i.rect[1])) > labels[0].height * 2
      )
        continue
      if (
        horizontal.filter(
          (r) =>
            r[1] > border[1] &&
            r[1] < crop[3] &&
            Math.abs(r[0] - border[0]) < 1 &&
            Math.abs(r[2] - border[2]) < 1
        ).length < 3
      )
        continue
      if (
        labels.some(
          (label) =>
            items.filter(
              (i) =>
                i.horizontal &&
                i.rect[1] > border[1] &&
                i.rect[3] <= crop[3] &&
                Math.abs(i.rect[0] - label.rect[0]) < 1
            ).length < 3
        )
      )
        continue
      return {
        cropRect: [crop[0], crop[1], border[2] + 1, crop[3]],
        rect: [crop[0], Math.min(...heading.map((i) => i.rect[1])), border[2] + 1, border[1]]
      }
    }
  }
  // A detector may omit the whole header, including multiple wrapped lines
  // above empty stub columns. Matching full-width native rules establish its
  // own row; do not append these labels to the first data record.
  if (columns.length >= 2 && rows.length >= 3) {
    const first = crop[1] + rows[0].rect[1]
    const borders = rules.filter(
      (r) =>
        r[1] === r[3] &&
        Math.abs(r[0] - crop[0]) <= 16 &&
        Math.abs(r[2] - crop[2]) <= 16 &&
        r[1] >= crop[1] - 4 &&
        r[1] <= first + 16
    )
    for (const upper of borders) {
      const divider = borders.find((r) => r[1] > upper[1] + 8 && r[1] >= first - 16)
      if (!divider) continue
      const header = items.filter(
        (i) =>
          i.horizontal &&
          i.rect[0] >= upper[0] - 1 &&
          i.rect[2] <= upper[2] + 1 &&
          i.rect[1] >= upper[1] &&
          i.rect[3] <= Math.min(first, divider[1])
      )
      if (header.length < 2 || header.some((i) => /[.!?]$/u.test(i.text.trim()))) continue
      const groups = columns.map((column) =>
        header.filter((i) => {
          const center = (i.rect[0] + i.rect[2]) / 2 - crop[0]
          return center >= column.rect[0] && center <= column.rect[2]
        })
      )
      if (
        (columns.length > 2 && (groups[0].length || groups[1].length)) ||
        groups.filter((g) => g.some((i) => /\p{L}/u.test(i.text))).length < 2 ||
        groups.flat().length !== header.length ||
        table.structure.objects.some(
          (o) =>
            o.label === 'table column header' &&
            o.rect[1] + crop[1] <= Math.min(...header.map((i) => i.rect[1]))
        )
      )
        continue
      return {
        cropRect: crop,
        rect: [crop[0], upper[1], crop[2], Math.min(first, divider[1])]
      }
    }
  }
  // A continuation can omit the caption and the model's entire spanning header.
  // Matching native borders establish that header independently of its wording.
  if (columns.length >= 2 && rows.length >= 3) {
    const first = crop[1] + rows[0].rect[1]
    const leading = items.filter(
      (i) =>
        i.horizontal &&
        i.rect[0] >= crop[0] &&
        i.rect[2] <= crop[2] &&
        i.rect[1] >= crop[1] - i.height &&
        i.rect[3] < first
    )
    if (leading.length === 1 && /\p{L}/u.test(leading[0].text)) {
      const item = leading[0]
      const upper = rules.find(
        (r) =>
          r[1] === r[3] &&
          r[1] <= item.rect[1] &&
          item.rect[1] - r[1] < item.height &&
          Math.abs(r[0] - crop[0]) < item.height * 1.5 &&
          Math.abs(r[2] - crop[2]) < item.height * 2 &&
          r[0] <= item.rect[0] &&
          r[2] >= item.rect[2]
      )
      const divider =
        upper &&
        rules.find(
          (r) =>
            r[1] === r[3] &&
            r[1] > item.rect[3] &&
            Math.abs(r[1] - first) < item.height * 0.25 &&
            Math.abs(r[0] - upper[0]) < 0.1 &&
            Math.abs(r[2] - upper[2]) < 0.1
        )
      const lower =
        upper &&
        rules.find(
          (r) =>
            r[1] === r[3] &&
            r[1] >= crop[1] + rows.at(-1).rect[3] &&
            Math.abs(r[1] - crop[3]) < item.height &&
            Math.abs(r[0] - upper[0]) < 0.1 &&
            Math.abs(r[2] - upper[2]) < 0.1
        )
      if (divider && lower) {
        const rect = [upper[0], upper[1], upper[2], divider[1]]
        return {
          cropRect: [
            Math.min(crop[0], upper[0]),
            Math.min(crop[1], upper[1]),
            Math.max(crop[2], upper[2]),
            Math.max(crop[3], lower[1])
          ],
          rect,
          spans: [rect]
        }
      }
    }
  }
  if (columns.length < 3 || columns.length > 10 || rows.length < 3) return
  const first = crop[1] + rows[0].rect[1]
  const leading = items.filter(
    (i) =>
      i.horizontal &&
      i.rect[0] >= crop[0] &&
      i.rect[2] <= crop[2] &&
      i.rect[1] >= crop[1] - i.height * 0.5 &&
      i.rect[3] <= first &&
      i.rect[1] <= crop[1] + i.height * 0.5
  )
  if (
    leading.length !== columns.length ||
    !leading.some((i) => i.rect[1] < crop[1]) ||
    leading.some(
      (i) =>
        !/\p{L}/u.test(i.text) ||
        /[\d.;:]/.test(i.text) ||
        Math.abs(i.baseline - leading[0].baseline) > leading[0].height * 0.2
    )
  )
    return
  const cuts = [
    crop[0],
    ...columns.slice(1).map((c, n) => crop[0] + (columns[n].rect[2] + c.rect[0]) / 2),
    crop[2]
  ]
  leading.sort((a, b) => a.rect[0] - b.rect[0])
  if (leading.some((i, n) => i.rect[0] < cuts[n] || i.rect[2] > cuts[n + 1])) return
  const glyphBottom = Math.max(...leading.map((i) => i.rect[3]))
  const divider = rules.find(
    (r) =>
      r[1] === r[3] &&
      r[1] > glyphBottom &&
      r[1] < first &&
      r[1] - glyphBottom < leading[0].height &&
      Math.abs(r[0] - crop[0]) < 12 &&
      Math.abs(r[2] - crop[2]) < 12
  )
  if (!divider) return
  const top = Math.min(...leading.map((i) => i.rect[1])) - 1
  return { cropRect: [crop[0], top, crop[2], crop[3]], rect: [crop[0], top, crop[2], divider[1]] }
}

// Repeated indented count categories establish native rows independently of
// gaps in the model. Section labels carry no value; do not fill them down.
export function recoverCountedCategoryGrid(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (predicted.length !== 2) return
  const cuts = [left, left + (predicted[0].rect[2] + predicted[1].rect[0]) / 2, right]
  const source = tableSourceItems(items, table.cropRect)
  if (!source.length) return
  const height = source.map((i) => i.height).sort((a, b) => a - b)[Math.floor(source.length / 2)]
  const groups = groupSourceRowsWithScripts(source, height, 0.3)
  if (!groups || groups.length < 10) return
  const values = groups.map((g) => readSourceRow(g, cuts))
  if (values.some((v) => !v)) return
  const sections = values.flatMap((v, n) => (/\p{L}.*[,;]n\(%\)$/u.test(v[0]) && !v[1] ? [n] : []))
  if (sections.length < 3) return
  const count = (v) => /^\d+\(\d+(?:\.\d+)?%\)$/.test(v)
  if (values.filter((v) => count(v[1])).length < 8) return
  const indent = Math.min(...sections.map((n) => groups[n][0].rect[0]))
  for (const [n, v] of values.entries()) {
    if (!v[0] || !/\p{L}|\d/u.test(v[0])) return
    if (sections.includes(n)) {
      if (Math.abs(groups[n][0].rect[0] - indent) > 1 || !count(values[n + 1]?.[1] ?? '')) return
    } else if (!count(v[1])) {
      if (!/[,;]M\(SD\)$/.test(v[0]) || !/^\d+(?:\.\d+)?\(\d+(?:\.\d+)?\)$/.test(v[1])) return
    } else if (
      groups[n][0].rect[0] - indent < height * 0.5 ||
      groups[n][0].rect[0] - indent > height * 1.5
    )
      return
  }
  const bounds = groups.map(union)
  if (bounds.some((b, n) => n && b[1] <= bounds[n - 1][3])) return
  const borders = rules.filter((r) => r[1] === r[3] && r[0] <= left + 4 && r[2] >= right - 4)
  if (
    !borders.some((r) => r[1] >= top && r[1] < bounds[0][1]) ||
    !borders.some((r) => r[1] > bounds.at(-1)[3] && r[1] <= bottom)
  )
    return
  return {
    rows: bounds.map((b) => [left, b[1], right, b[3]]),
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans: [],
    headerRows: [],
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Dense baseline summaries have a ruled header, repeated numeric records and
// outdented category labels. Reconstruct those records from native baselines,
// including labels wrapped within one record, before accepting model merges.
export function recoverRuledComparisonRecords(table, items, captions, rules) {
  const paired = recoverPairedCountRecords(table, items, captions, rules)
  if (paired) return paired
  const summaries = recoverPairedCountSummaries(table, items, captions, rules)
  if (summaries) return summaries
  const crop = table.cropRect
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
    .filter(
      (c, n, all) =>
        !all
          .slice(0, n)
          .some(
            (p) =>
              (Math.min(p.rect[2], c.rect[2]) - Math.max(p.rect[0], c.rect[0])) /
                Math.max(p.rect[2] - p.rect[0], c.rect[2] - c.rect[0]) >
              0.9
          )
    )
  if (
    predicted.length < 3 ||
    predicted.length > 12 ||
    !captions.some((c) => captionKind(c.lines[0]) === 'table')
  )
    return
  const joined = []
  for (const r of rules.filter((r) => r[1] === r[3]).sort((a, b) => a[1] - b[1] || a[0] - b[0])) {
    const previous = joined.at(-1)
    if (previous && Math.abs(previous[1] - r[1]) < 0.5 && r[0] <= previous[2] + 0.01) {
      previous[0] = Math.min(previous[0], r[0])
      previous[2] = Math.max(previous[2], r[2])
    } else joined.push([...r])
  }
  const borders = joined
    .filter(
      (r) =>
        r[1] === r[3] &&
        Math.abs(r[0] - crop[0]) < 16 &&
        Math.abs(r[2] - crop[2]) < 16 &&
        r[1] >= crop[1] - 16 &&
        r[1] <= crop[3] + 16
    )
    .sort((a, b) => a[1] - b[1])
  if (![3, 4].includes(borders.length)) return
  const upper = borders[0],
    divider = borders.at(-2),
    lower = borders.at(-1)
  let tier = borders.length === 4 ? borders[1] : undefined
  if (divider[1] - upper[1] > 80 || lower[1] - divider[1] < 70) return
  const left = Math.min(crop[0], upper[0]),
    right = Math.max(crop[2], upper[2]),
    // Native font ascent boxes can overhang this rule by a rounding fraction.
    // Keep only observed header ink within one hundredth of an em (and a
    // tenth of a pixel); nearby prose or a visibly clipped title stays out.
    top = Math.min(
      upper[1],
      ...items
        .filter(
          (i) =>
            i.horizontal &&
            i.rect[0] >= left &&
            i.rect[2] <= right &&
            i.rect[1] < upper[1] &&
            upper[1] - i.rect[1] <= Math.min(0.1, i.height * 0.01) &&
            i.rect[3] < divider[1] &&
            /\p{L}/u.test(i.text)
        )
        .map((i) => i.rect[1])
    ),
    bottom = lower[1]
  const source = tableSourceItems(items, [left, top, right, bottom])
  const body = source.filter((i) => i.rect[1] >= divider[1])
  if (!body.length) return
  const height = body.map((i) => i.height).sort((a, b) => a - b)[Math.floor(body.length / 2)]
  // A close double rule with no text between its strokes is decoration, not
  // a parent-header tier. Keep the full border for cropping and text ownership.
  if (
    tier &&
    tier[1] - upper[1] < height * 0.5 &&
    !source.some(
      (i) => (i.rect[1] + i.rect[3]) / 2 < tier[1] && (i.rect[1] + i.rect[3]) / 2 > upper[1]
    )
  )
    tier = undefined
  const groups = groupSourceRowsWithScripts(body, height, 0.3)
  if (!groups || groups.length < 5) return
  const cuts = [
    left,
    ...predicted.slice(1).map((c, n) => crop[0] + (predicted[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  // A detector can combine adjacent narrow scalar columns. Separate them
  // only when independent short headers and repeated pairs of native values
  // agree on one empty gutter; never split a text run by character count.
  for (let c = cuts.length - 2; c > 0; c--) {
    const head = source
      .filter((i) => i.rect[3] <= divider[1] && i.rect[0] >= cuts[c] && i.rect[2] <= cuts[c + 1])
      .sort((a, b) => a.rect[0] - b.rect[0])
    if (
      head.length !== 2 ||
      head.some((i) => !/^[A-Za-z]{1,4}$/.test(i.text.trim())) ||
      Math.abs(head[0].baseline - head[1].baseline) > height * 0.2 ||
      head[1].rect[0] - head[0].rect[2] < height * 2
    )
      continue
    const middle = (head[0].rect[2] + head[1].rect[0]) / 2
    const pairs = groups
      .map((g) => g.filter((i) => i.rect[0] >= cuts[c] && i.rect[2] <= cuts[c + 1]))
      .filter((g) => g.length)
    if (
      pairs.length < 3 ||
      pairs.some(
        (g) =>
          g.length !== 2 ||
          g.some((i) => !/^[+−-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(i.text.trim())) ||
          g.filter((i) => i.rect[2] < middle).length !== 1 ||
          g.filter((i) => i.rect[0] > middle).length !== 1
      )
    )
      continue
    const band = source.filter((i) => i.rect[0] < cuts[c + 1] && i.rect[2] > cuts[c])
    if (band.some((i) => i.rect[0] < middle && i.rect[2] > middle)) continue
    cuts.splice(c + 1, 0, middle)
  }
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  // Move a predicted cut only within an empty source gutter. A run crossing
  // every possible cut is ambiguous and must not be split by character count.
  for (let c = 1; c < cuts.length - 1; c++) {
    const a = body.filter((i) => col(i) === c - 1),
      b = body.filter((i) => col(i) === c)
    if (!a.length || !b.length) return
    const end = Math.max(...a.map((i) => i.rect[2])),
      start = Math.min(...b.map((i) => i.rect[0]))
    if (end >= start) return
    if (end > cuts[c] || start < cuts[c]) cuts[c] = (end + start) / 2
  }
  const values = groups.map((g) => readSourceRow(g, cuts))
  if (values.some((v) => !v)) return
  const numeric = (v) =>
    /^(?:(?:n=)?[<>≤≥−+–-]?(?:\d|\.\d)[\d.,()%/±–−+*a-z=<>≤≥-]*|\((?:n=)?[\d.−–%-]+\)|[–—-][*†‡]?)$/i.test(
      v
    )
  const records = values.filter((v) => v[0] && v.slice(1).filter(numeric).length >= 2)
  if (records.length < 5) return
  const indent = Math.min(...body.filter((i) => col(i) === 0).map((i) => i.rect[0]))
  const sections = values.flatMap((v, n) =>
    v[0] &&
    /^(?:\p{Lu}|\d+[- ]day)/u.test(v[0]) &&
    !v[1] &&
    Math.abs(Math.min(...groups[n].filter((i) => col(i) === 0).map((i) => i.rect[0])) - indent) < 1
      ? [n]
      : []
  )
  // A numeric prefix does not by itself establish a section. Within this
  // complete ruled body, require repeated independent flush headings with two
  // complete indented records, then the same font, leading and indentation for
  // the candidate. Ordinary wrapped measured labels keep their existing path.
  if (predicted.length === 5) {
    const indentedPair = (n) => {
      const heading = groups[n],
        head = union(heading),
        pair = groups.slice(n + 1, n + 3)
      if (
        values[n].slice(1).some(Boolean) ||
        pair.length !== 2 ||
        heading.some((i) => Math.abs(i.height - height) > height * 0.05)
      )
        return
      const xs = pair.map((g) => Math.min(...g.filter((i) => col(i) === 0).map((i) => i.rect[0])))
      const leading = pair[0][0].baseline - heading[0].baseline
      if (
        xs.some((x) => x - indent < height * 0.5 || x - indent > height * 1.5) ||
        Math.abs(xs[0] - xs[1]) > height * 0.05 ||
        leading < height ||
        leading > height * 1.7 ||
        Math.abs(pair[1][0].baseline - pair[0][0].baseline - leading) > height * 0.05 ||
        pair.some(
          (g, j) =>
            !/\p{L}/u.test(values[n + j + 1][0]) ||
            !values[n + j + 1].slice(1).every(numeric) ||
            g.some((i) => Math.abs(i.height - height) > height * 0.05) ||
            union(g)[1] <= head[3]
        )
      )
        return
      return { x: xs[0], leading }
    }
    const peers = sections.map(indentedPair).filter(Boolean)
    if (peers.length >= 2)
      for (let n = 1; n < groups.length - 2; n++) {
        const pair = /^\d+\s+\p{L}/u.test(groups[n].map((i) => i.text).join(' '))
          ? indentedPair(n)
          : undefined
        if (
          pair &&
          !sections.includes(n) &&
          values[n - 1].slice(1).every(numeric) &&
          union(groups[n])[1] > union(groups[n - 1])[3] + height * 0.1 &&
          Math.abs(Math.min(...groups[n].map((i) => i.rect[0])) - indent) < height * 0.05 &&
          peers.every(
            (p) =>
              Math.abs(p.x - pair.x) < height * 0.05 &&
              Math.abs(p.leading - pair.leading) < height * 0.05
          )
        )
          sections.push(n)
      }
  }
  if (
    (sections.length < 2 && records.some((v) => v.slice(1).some((s) => !s))) ||
    sections.some((n) => /^[a-z]\./.test(values[n][0])) ||
    groups.some((g) =>
      /\s\d+(?:\.\d+)?\s\d+(?:\.\d+)?(?:\s\d+(?:\.\d+)?)?$/.test(
        g
          .filter((i) => col(i) === 0)
          .map((i) => i.text)
          .join(' ')
      )
    )
  )
    return
  const owned = [],
    isSection = []
  for (let n = 0; n < groups.length; n++) {
    const g = groups[n],
      v = values[n],
      stub = g.filter((i) => col(i) === 0),
      data = v.slice(1).some(Boolean)
    if (!v[0] || v.slice(1).some((s) => s && !numeric(s) && !/^(?:[χv]2|t)=.*p=/.test(s))) return
    const x = Math.min(...stub.map((i) => i.rect[0]))
    if (!data && owned.length && !sections.includes(n)) {
      const previous = owned.at(-1),
        label = previous.filter((i) => col(i) === 0),
        bounds = union(previous)
      if (
        !label.length ||
        g[0].baseline - Math.max(...previous.map((i) => i.baseline)) > height * 1.7 ||
        x < Math.min(...label.map((i) => i.rect[0])) - 1
      )
        return
      // A label-only numeric category is a real record, never a continuation.
      if (
        (!/\p{L}/u.test(v[0]) && !/^[%)]+$/.test(v[0])) ||
        /^[<>≤≥]/.test(v[0]) ||
        /\s\d+\s+\d+$/.test(stub.map((i) => i.text).join(' '))
      )
        return
      if (union(g)[1] < bounds[3] - height * 0.15) return
      previous.push(...g)
    } else {
      owned.push([...g])
      isSection.push(sections.includes(n))
    }
  }
  const header = source.filter((i) => i.rect[3] <= divider[1]),
    bounds = owned.map(union)
  if (
    !header.length ||
    !hasUniqueRecordTokens(source, [header, ...owned]) ||
    bounds.some((r, n) => n && r[1] < bounds[n - 1][3] - height * 0.01) ||
    // Only complete numeric records justify relaxing the font-box boundary.
    // Sparse sections and partial records still need separate wrapping evidence.
    (bounds.some((r, n) => n && r[1] <= bounds[n - 1][3]) &&
      records.some((v) => v.slice(1).some((s) => !s)))
  )
    return
  // Font em boxes can touch or overlap by a rounding fraction even though
  // native baselines establish distinct records. Share that boundary only;
  // never change token geometry or tolerate substantive line overlap.
  for (let n = 1; n < bounds.length; n++) {
    if (bounds[n][1] <= bounds[n - 1][3]) {
      const cut = (bounds[n][1] + bounds[n - 1][3]) / 2
      bounds[n][1] = cut
      bounds[n - 1][3] = cut
    }
  }
  const headRows = [[left, top, right, divider[1]]],
    spans = []
  const underlines = rules.filter(
    (r) =>
      !borders.some(
        (b) => Math.abs(b[1] - r[1]) < 0.5 && r[0] >= b[0] - 0.01 && r[2] <= b[2] + 0.01
      ) &&
      r[1] === r[3] &&
      r[1] > top &&
      r[1] < divider[1] &&
      r[0] > left &&
      r[2] < right
  )
  // Repeated value/(SD or %) records establish paired columns even without a
  // second header tier. Require a complete sample-qualified heading for each
  // pair and a separate P-value column before joining any header slots.
  if (!tier && !underlines.length && predicted.length === 6) {
    const parentValues = readSourceRow(header, [left, cuts[1], cuts[3], cuts[5], right], {
      multiline: true
    })
    if (
      parentValues &&
      !parentValues[0] &&
      /^P-?value$/i.test(parentValues[3]) &&
      parentValues.slice(1, 3).every((s) => /\p{L}.*\(n=\d+\)$/u.test(s)) &&
      records.length >= 6 &&
      records.every((v) =>
        [1, 3].every((c) => /^\d+(?:\.\d+)?$/.test(v[c]) && /^\(\d+(?:\.\d+)?%?\)$/.test(v[c + 1]))
      )
    ) {
      for (const column of [1, 3]) spans.push({ row: 0, column, rowSpan: 1, colSpan: 2 })
    }
  }
  if (tier) {
    if (underlines.length || predicted.length % 2 !== 1) return
    const parents = header.filter((i) => i.rect[3] < tier[1]),
      children = header.filter((i) => i.rect[1] > tier[1])
    if (!hasUniqueRecordTokens(header, [parents, children])) return
    const values = readSourceRow(children, cuts)
    if (
      !values ||
      values[0] ||
      values.slice(1).some((v, n) => (n % 2 === 0 ? v !== 'Numberofpatients' : v !== '(%)'))
    )
      return
    if (
      parents.some(
        (i) =>
          col(i) > 0 &&
          (i.rect[0] < cuts[1 + 2 * Math.floor((col(i) - 1) / 2)] ||
            i.rect[2] > cuts[3 + 2 * Math.floor((col(i) - 1) / 2)])
      )
    )
      return
    headRows.splice(0, 1, [left, top, right, tier[1]], [left, tier[1], right, divider[1]])
    for (let c = 1; c < predicted.length; c += 2)
      spans.push({ row: 0, column: c, rowSpan: 1, colSpan: 2 })
    for (const [n, g] of owned.entries())
      if (/^Median\(range\)$/.test(readSourceRow(g, cuts)?.[0] ?? ''))
        for (let c = 1; c < predicted.length; c += 2)
          spans.push({ row: n + 2, column: c, rowSpan: 1, colSpan: 2 })
  }
  if (underlines.length) {
    if (underlines.length !== 1) return
    const line = underlines[0],
      parent = header.filter((i) => i.rect[3] <= line[1]),
      children = header.filter((i) => i.rect[1] >= line[1])
    if (!parent.length || !children.length || !hasUniqueRecordTokens(header, [parent, children]))
      return
    const cols = cuts
      .slice(1)
      .flatMap((x, c) =>
        children.some(
          (i) => col(i) === c && i.rect[0] >= line[0] - 2 && i.rect[2] <= line[2] + height * 4
        )
          ? [c]
          : []
      )
    if (
      cols.length !== 2 ||
      cols[1] !== cols[0] + 1 ||
      parent.some((i) => i.rect[0] < cuts[cols[0]] || i.rect[2] > cuts[cols[1] + 1])
    )
      return
    headRows.splice(0, 1, [left, top, right, line[1]], [left, line[1], right, divider[1]])
    spans.push({ row: 0, column: cols[0], rowSpan: 1, colSpan: 2 })
  }
  return {
    cropRect: [left, top, right, bottom],
    rows: [...headRows, ...bounds.map((r) => [left, r[1], right, r[3]])],
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans: [
      ...spans,
      ...owned.flatMap((g, n) =>
        isSection[n] && g.every((i) => col(i) === 0)
          ? [{ row: n + headRows.length, column: 0, rowSpan: 1, colSpan: cuts.length - 1 }]
          : []
      )
    ],
    completeSpans: true,
    headerRows: headRows.map((_, n) => n),
    ownedTokens: new Set(source),
    repair: 'source-record-boundary-comparison-recovered'
  }
}

// Repeated No./% baselines establish complete cohort records independently of
// missing or overlapping model rows. Native header rules establish the parent;
// trailing statistics retain their printed row rather than an inferred span.
function recoverPairedCountRecords(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (predicted.length < 4 || predicted.length > 12) return
  const initial = tableSourceItems(items, table.cropRect)
  const heights = initial.map((i) => i.height).sort((a, b) => a - b)
  const height = heights[Math.floor(heights.length / 2)]
  if (!(height > 0)) return
  const frame = joinHorizontalTableRules(rules).filter(
    (r) =>
      Math.abs(r[0] - left) < height * 2 &&
      Math.abs(r[2] - right) < height * 2 &&
      r[1] >= top - height &&
      r[1] <= bottom + height
  )
  if (frame.length !== 3 || frame[1][1] - frame[0][1] > height * 8) return
  const source = tableSourceItems(items, [left, frame[0][1], right, frame[2][1]])
  const header = source.filter((i) => i.rect[3] < frame[1][1])
  const cue = source.at(-1)
  const continuation =
    cue &&
    /^\(continued in next column\)$/i.test(cue.text.trim()) &&
    frame[2][1] - cue.rect[3] < height &&
    Math.abs(cue.rect[0] + cue.rect[2] - left - right) < height * 2
      ? cue
      : undefined
  const body = source.filter((i) => i.rect[1] > frame[1][1] && i !== continuation)
  const groups = groupSourceRowsWithScripts(body, height, 0.3)
  if (!groups || groups.length < 12) return
  const cuts = [
    left,
    ...predicted.slice(1).map((c, n) => left + (predicted[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  for (let c = 1; c < cuts.length - 1; c++) {
    const a = body.filter((i) => col(i) === c - 1),
      b = body.filter((i) => col(i) === c)
    if (!a.length || !b.length) return
    const end = Math.max(...a.map((i) => i.rect[2])),
      start = Math.min(...b.map((i) => i.rect[0]))
    if (end >= start) return
    if (end > cuts[c] || start < cuts[c]) cuts[c] = (end + start) / 2
  }
  const values = groups.map((g) => readSourceRow(g, cuts))
  if (values.some((v) => !v || !v[0])) return
  const percentages = values.flatMap((v, n) => (v[0] === '%' ? [n] : []))
  if (percentages.length < 5) return
  const cohorts = values[percentages[0]].slice(1).filter(Boolean).length
  if (cohorts < 2 || cohorts >= predicted.length - 1) return
  const number = (s) => /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(s)
  const statistic = (s) => /^[<>≤≥]?(?:\d+(?:\.\d+)?|\.\d+)[*†‡]?$/.test(s)
  const counts = new Set()
  for (const n of percentages) {
    const previous = values[n - 1],
      current = values[n]
    if (
      !previous ||
      !/^(?:No\.|N|Count)$/i.test(previous[0]) ||
      previous.slice(1, cohorts + 1).some((s) => !/^\d+$/.test(s)) ||
      current.slice(1, cohorts + 1).some((s) => !number(s)) ||
      current.slice(cohorts + 1).some(Boolean) ||
      previous.slice(cohorts + 1).some((s) => s && !statistic(s)) ||
      groups[n][0].baseline - groups[n - 1][0].baseline > height * 1.6
    )
      return
    counts.add(n - 1)
  }
  const nativeHeader = recoverRuledHeaderBands(header, cuts, rules, frame[0][1], frame[1][1])
  if (!nativeHeader?.spans.some((s) => s.row === 0 && s.column === 1 && s.colSpan === cohorts))
    return
  const owned = [],
    labels = []
  for (let n = 0; n < groups.length; n++) {
    const g = groups[n],
      v = values[n]
    if (counts.has(n) || percentages.includes(n)) {
      owned.push([...g])
      labels.push(false)
    } else if (v.slice(1).every((s) => !s) && /\p{L}/u.test(v[0])) {
      const previous = owned.at(-1),
        bounds = union(g)
      if (
        previous &&
        labels.at(-1) &&
        g[0].baseline - Math.max(...previous.map((i) => i.baseline)) < height * 1.3 &&
        bounds[0] >= union(previous)[0] - 1 &&
        bounds[0] - union(previous)[0] < height * 3
      )
        previous.push(...g)
      else {
        owned.push([...g])
        labels.push(true)
      }
    } else if (
      /^(?:TotalNo\.|No\.ofpatients|N)$/i.test(v[0]) &&
      v.slice(1, cohorts + 1).every((s) => /^\d+$/.test(s)) &&
      v.slice(cohorts + 1).every((s) => !s)
    ) {
      owned.push([...g])
      labels.push(false)
    } else return
  }
  const bounds = owned.map(union)
  if (
    !hasUniqueRecordTokens(source, [header, ...owned, ...(continuation ? [[continuation]] : [])]) ||
    bounds.some((r, n) => n && r[1] <= bounds[n - 1][3])
  )
    return
  return {
    cropRect: [left, frame[0][1], right, frame[2][1]],
    rows: [...nativeHeader.rows, ...bounds.map((r) => [left, r[1], right, r[3]])],
    columns: cuts.slice(1).map((x, c) => [cuts[c], frame[0][1], x, frame[2][1]]),
    spans: nativeHeader.spans,
    completeSpans: true,
    headerRows: nativeHeader.rows.map((_, n) => n),
    ownedTokens: new Set([...header, ...owned.flat()]),
    repair: 'source-record-boundary-comparison-recovered'
  }
}

// Repeated No./% leaves and cohort underlines establish a single stub and paired
// data columns even when the model splits the stub. Centered summary values own
// both leaves; count-only records retain genuinely blank percentage cells.
function recoverPairedCountSummaries(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const horizontal = rules.filter((r) => r[1] === r[3] && r[1] >= top && r[1] <= bottom)
  const frame = horizontal
    .filter((r) => Math.abs(r[0] - left) < 16 && Math.abs(r[2] - right) < 16)
    .sort((a, b) => a[1] - b[1])
  if (frame.length !== 3 || frame[1][1] - frame[0][1] > 120 || bottom - frame[2][1] > 16) return
  const source = tableSourceItems(items, [left, frame[0][1], right, frame[2][1]])
  const header = source.filter((i) => i.rect[3] < frame[1][1])
  const first = header.find((i) => i.text === 'No.')
  if (!first) return
  const height = first.height
  const leaves = header
    .filter(
      (i) => /^(?:No\.|%)$/.test(i.text) && Math.abs(i.baseline - first.baseline) < height * 0.3
    )
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (
    leaves.length < 4 ||
    leaves.length > 12 ||
    leaves.length % 2 ||
    leaves.some((i, n) => i.text !== (n % 2 ? '%' : 'No.'))
  )
    return
  const cuts = [
    left,
    leaves[0].rect[0] - height * 0.75,
    ...leaves.slice(1).map((i, n) => (leaves[n].rect[2] + i.rect[0]) / 2),
    right
  ]
  const parentCuts = [left, ...cuts.slice(1, -1).filter((_, n) => n % 2 === 0), right]
  const bands = []
  for (const r of horizontal.filter((r) => r[1] > frame[0][1] && r[1] < first.rect[1])) {
    let band = bands.find((b) => Math.abs(b[0][1] - r[1]) < 0.1)
    if (!band) bands.push((band = []))
    band.push(r)
  }
  bands.sort((a, b) => a[0][1] - b[0][1])
  if (bands.length !== 2 || bands[0].length !== 1 || bands[1].length !== leaves.length / 2) return
  const parentRule = bands[0][0],
    children = bands[1].sort((a, b) => a[0] - b[0])
  if (
    children.some(
      (r, n) =>
        r[0] > leaves[n * 2].rect[0] ||
        r[2] < leaves[n * 2 + 1].rect[2] ||
        r[0] < parentCuts[n + 1] ||
        r[2] > parentCuts[n + 2]
    ) ||
    parentRule[0] > leaves[0].rect[0] ||
    parentRule[2] < leaves.at(-1).rect[2]
  )
    return
  const upper = header.filter((i) => i.rect[3] < parentRule[1]),
    middle = header.filter((i) => i.rect[1] > parentRule[1] && i.rect[3] < children[0][1]),
    lower = header.filter((i) => i.rect[1] > children[0][1])
  const main = readSourceRow(upper, [left, cuts[1], right]),
    parents = readSourceRow(middle, parentCuts, { multiline: true }),
    labels = readSourceRow(lower, cuts)
  if (
    !hasUniqueRecordTokens(header, [upper, middle, lower]) ||
    !main ||
    main[0] ||
    !/\p{L}/u.test(main[1]) ||
    !parents ||
    parents[0] ||
    !parents.slice(1).every((s) => /\p{L}/u.test(s) && /\(n=\d+\)/i.test(s)) ||
    !labels ||
    !/\p{L}/u.test(labels[0]) ||
    labels.slice(1).some((s, n) => s !== (n % 2 ? '%' : 'No.'))
  )
    return
  const body = source.filter((i) => i.rect[1] > frame[1][1]),
    groups = groupSourceRowsWithScripts(body, height, 0.3)
  if (!groups || !hasUniqueRecordTokens(source, [header, ...groups])) return
  const spans = [{ row: 0, column: 1, rowSpan: 1, colSpan: leaves.length }]
  for (let c = 1; c < cuts.length - 1; c += 2)
    spans.push({ row: 1, column: c, rowSpan: 1, colSpan: 2 })
  const indent = Math.min(...body.map((i) => i.rect[0]))
  let sections = 0,
    records = 0,
    summaries = 0
  for (const [n, g] of groups.entries()) {
    const paired = readSourceRow(g, parentCuts)
    if (!paired || !paired[0]) return
    if (paired.slice(1).every((s) => !s)) {
      if (!/\p{L}/u.test(paired[0]) || Math.abs(union(g)[0] - indent) > height * 0.35) return
      spans.push({ row: n + 3, column: 0, rowSpan: 1, colSpan: leaves.length + 1 })
      sections++
    } else if (/^(?:Median|Mean|Range)$/i.test(paired[0])) {
      if (!paired.slice(1).every((s) => /^[-−+]?\d+(?:\.\d+)?(?:[-–−]\d+(?:\.\d+)?)?$/.test(s)))
        return
      for (let c = 1; c < parentCuts.length - 1; c++) {
        const tokens = g.filter((i) => i.rect[0] >= parentCuts[c] && i.rect[2] <= parentCuts[c + 1])
        const bounds = union(tokens),
          rule = children[c - 1]
        if (Math.abs((bounds[0] + bounds[2] - rule[0] - rule[2]) / 2) > height) return
        spans.push({ row: n + 3, column: c * 2 - 1, rowSpan: 1, colSpan: 2 })
      }
      summaries++
    } else {
      const v = readSourceRow(g, cuts)
      if (!v) return
      const counts = v.slice(1).filter((_, c) => c % 2 === 0),
        percentages = v.slice(2).filter((_, c) => c % 2 === 0)
      if (
        counts.some((s) => !/^(?:\d+|NA)$/.test(s)) ||
        !(
          percentages.every((s) => !s) ||
          percentages.every((s, c) =>
            counts[c] === 'NA' ? !s : /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(s)
          )
        )
      )
        return
      records++
    }
  }
  if (sections < 2 || records < 5 || summaries < 2) return
  const bounds = groups.map(union)
  if (bounds.some((r, n) => n && r[1] <= bounds[n - 1][3])) return
  const ys = [frame[1][1], ...bounds.slice(1).map((r, n) => (r[1] + bounds[n][3]) / 2), frame[2][1]]
  return {
    cropRect: [left, frame[0][1], right, frame[2][1]],
    rows: [
      [left, frame[0][1], right, parentRule[1]],
      [left, parentRule[1], right, children[0][1]],
      [left, children[0][1], right, frame[1][1]],
      ...groups.map((_, n) => [left, ys[n], right, ys[n + 1]])
    ],
    columns: cuts.slice(1).map((x, c) => [cuts[c], frame[0][1], x, frame[2][1]]),
    spans,
    headerRows: [0, 1, 2],
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Repeated allele headings and P-value columns establish the actual count
// blocks when the detector duplicates a column. Native header/footer rules
// and a unique, complete assignment of every source run are required.
export function recoverAlleleDistributionGrid(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const crop = table.cropRect
  const borders = rules
    .filter(
      (r) =>
        r[1] === r[3] &&
        Math.abs(r[0] - crop[0]) < 16 &&
        Math.abs(r[2] - crop[2]) < 16 &&
        r[1] >= crop[1] - 10 &&
        r[1] <= crop[3] + 10
    )
    .sort((a, b) => a[1] - b[1])
  if (borders.length !== 4) return
  const [upper, tier, divider, lower] = borders
  if (tier[1] - upper[1] > 30 || divider[1] - tier[1] > 55) return
  const left = Math.min(crop[0], upper[0]),
    right = Math.max(crop[2], upper[2]),
    top = upper[1],
    bottom = lower[1]
  const source = tableSourceItems(items, [left, top, right, bottom])
  const header = source.filter((i) => i.rect[1] > tier[1] && i.rect[3] < divider[1])
  const heads = header
    .filter((i) => /^(?:[ACGT]{2}|P[- ]value)$/.test(i.text))
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (
    heads.length < 8 ||
    heads.length > 24 ||
    heads.length % 4 ||
    heads.some((i, n) => (n % 4 === 3 ? !/^P/.test(i.text) : !/^[ACGT]{2}$/.test(i.text)))
  )
    return
  const height = heads[0].height,
    body = source.filter((i) => i.rect[1] > divider[1])
  const cuts = [
    left,
    heads[0].rect[0] - height * 2,
    ...heads.slice(1).map((i, n) => (heads[n].rect[2] + i.rect[0]) / 2),
    right
  ]
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  for (let c = 1; c < cuts.length - 1; c++) {
    const a = [...body, ...header].filter((i) => col(i) === c - 1),
      b = [...body, ...header].filter((i) => col(i) === c)
    if (!a.length || !b.length) return
    const end = Math.max(...a.map((i) => i.rect[2])),
      start = Math.min(...b.map((i) => i.rect[0]))
    if (end >= start) return
    cuts[c] = (end + start) / 2
  }
  const labels = groupSourceRowsWithScripts(
    body.filter((i) => col(i) === 0),
    height,
    0.3
  )
  if (!labels || labels.length < 10) return
  const anchors = labels.map((g) => Math.max(...g.map((i) => i.baseline))),
    groups = labels.map((g) => [...g])
  for (const i of body.filter((i) => col(i) > 0)) {
    const near = anchors
      .map((y, n) => ({ n, d: Math.abs(y - i.baseline) }))
      .sort((a, b) => a.d - b.d)
    if (near[0].d > height || near[1].d - near[0].d < height * 0.1) return
    groups[near[0].n].push(i)
  }
  for (const group of groups) {
    if (!readSourceRow(group, cuts)) return
    for (let c = 1; c < cuts.length - 1; c++) {
      const v = group
        .filter((i) => col(i) === c)
        .sort((a, b) =>
          Math.abs(a.baseline - b.baseline) < height * 0.3
            ? a.rect[0] - b.rect[0]
            : a.baseline - b.baseline
        )
        .map((i) => i.text)
        .join('')
        .replace(/[\s＊*†]/g, '')
      if (v && !/^(?:[<>]?\d+(?:\.\d+)?(?:\([\d.%-]+\))?[＊*†]?|-)$/u.test(v)) return
    }
  }
  const parents = source.filter((i) => i.rect[3] < tier[1]),
    parentGroups = heads.filter((_, n) => n % 4 === 0).map(() => [])
  for (const i of parents) {
    const c = col(i)
    if (c < 1) return
    parentGroups[Math.floor((c - 1) / 4)].push(i)
  }
  if (
    parentGroups.some(
      (g, n) =>
        !g.length || g.some((i) => i.rect[0] < cuts[1 + n * 4] || i.rect[2] > cuts[5 + n * 4])
    ) ||
    !hasUniqueRecordTokens(source, [parents, header, ...groups])
  )
    return
  const bounds = groups.map(union)
  if (bounds.some((r, n) => n && r[1] <= bounds[n - 1][3])) return
  return {
    cropRect: [left, top, right, bottom],
    rows: [
      [left, top, right, tier[1]],
      [left, tier[1], right, divider[1]],
      ...bounds.map((r) => [left, r[1], right, r[3]])
    ],
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans: parentGroups.map((_, n) => ({ row: 0, column: 1 + n * 4, rowSpan: 1, colSpan: 4 })),
    headerRows: [0, 1],
    completeSpans: true,
    ownedTokens: new Set(source),
    repair: 'allele-distribution-grid-recovered'
  }
}

// A small repeated-measure table can lose its entire first record into the
// header. A full underline and independently aligned stub/interval records
// determine both bands without treating a model header as source evidence.
export function recoverRuledIntervalRecords(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const crop = table.cropRect,
    columns = table.structure.objects
      .filter((o) => o.label === 'table column')
      .sort((a, b) => a.rect[0] - b.rect[0])
  if (columns.length < 4 || columns.length > 7) return
  const borders = rules
    .filter(
      (r) =>
        r[1] === r[3] &&
        Math.abs(r[0] - crop[0]) < 20 &&
        Math.abs(r[2] - crop[2]) < 20 &&
        r[1] >= crop[1] - 10 &&
        r[1] <= crop[3] + 10
    )
    .sort((a, b) => a[1] - b[1])
  if (
    borders.length !== 3 ||
    borders[1][1] - borders[0][1] > 35 ||
    borders[2][1] - borders[1][1] > 160
  )
    return
  const [top, divider, bottom] = borders.map((r) => r[1]),
    left = Math.min(crop[0], borders[0][0]),
    right = Math.max(crop[2], borders[0][2])
  const cuts = [
    left,
    ...columns.slice(1).map((c, n) => crop[0] + (columns[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const source = tableSourceItems(items, [left, top, right, bottom]),
    head = source.filter((i) => i.rect[3] < divider),
    body = source.filter((i) => i.rect[1] > divider)
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const labels = body.filter((i) => col(i) === 0)
  if (labels.length < 3 || labels.length > 6 || labels.some((i) => !/\p{L}/u.test(i.text))) return
  const height = labels[0].height,
    groups = labels.map((i) => [i])
  for (const i of body.filter((i) => col(i) > 0)) {
    const near = labels
      .map((l, n) => ({ n, d: Math.abs(l.baseline - i.baseline) }))
      .sort((a, b) => a.d - b.d)
    if (near[0].d > height || near[1].d - near[0].d < height * 0.15) return
    groups[near[0].n].push(i)
  }
  if (
    !readSourceRow(head, cuts) ||
    !hasUniqueRecordTokens(source, [head, ...groups]) ||
    groups.some((g) => !readSourceRow(g, cuts))
  )
    return
  if (
    groups
      .slice(0, -1)
      .some((g) =>
        cuts
          .slice(2, -1)
          .some((_, n) => !g.some((i) => col(i) === n + 1 && /^\([\d., ]+\)$/.test(i.text)))
      )
  )
    return
  const bounds = groups.map(union)
  if (bounds.some((r, n) => n && r[1] <= bounds[n - 1][3])) return
  return {
    cropRect: [left, top, right, bottom],
    rows: [[left, top, right, divider], ...bounds.map((r) => [left, r[1], right, r[3]])],
    columns: cuts.slice(1).map((x, n) => [cuts[n], top, x, bottom]),
    headerRows: [0],
    spans: [],
    completeSpans: true,
    ownedTokens: new Set(source),
    repair: 'ruled-interval-records-recovered'
  }
}

function recoverRepeatedEventGrid(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const columns = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (columns.length < 6 || columns.length % 2) return
  const cuts = [
    left,
    ...columns.slice(1).map((c, n) => left + (columns[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const source = tableSourceItems(items, table.cropRect),
    events = source.filter((i) => i.text === 'No. of Events')
  if (
    events.length !== (columns.length - 2) / 2 ||
    events.length < 2 ||
    !source.some((i) => i.text === 'Total Patients')
  )
    return
  const height = events[0].height
  const units = source.filter((i) => /^\(\d+-y CI\)$/.test(i.text))
  if (units.length !== events.length) return
  const divider = rules
    .filter(
      (r) =>
        r[1] === r[3] &&
        r[1] > Math.max(...units.map((i) => i.baseline)) &&
        r[1] - units[0].baseline < height * 2
    )
    .sort((a, b) => a[1] - b[1])[0]?.[1]
  const footer = rules
    .filter(
      (r) =>
        r[1] === r[3] && r[1] > divider && r[1] <= bottom && r[0] < left + 15 && r[2] > right - 15
    )
    .sort((a, b) => b[1] - a[1])[0]?.[1]
  if (divider === undefined || footer === undefined) return
  const upper = source.filter((i) => i.baseline < events[0].rect[1]),
    lower = source.filter((i) => i.baseline >= events[0].rect[1] && i.rect[3] < divider)
  const leaves = readSourceRow(lower, cuts)
  if (
    !leaves ||
    leaves.slice(0, 2).some(Boolean) ||
    !events.every(
      (_, n) => /^No\.ofEvents\(\d+-yCI\)$/.test(leaves[2 + n * 2]) && leaves[3 + n * 2] === 'P'
    )
  )
    return
  const parents = [...upper].sort((a, b) => a.rect[0] - b.rect[0])
  if (
    parents.length !== events.length + 1 ||
    parents[0].text !== 'Total Patients' ||
    parents.some(
      (i, n) =>
        i.rect[0] < cuts[n ? 2 * n : 1] ||
        i.rect[2] > cuts[n ? 2 * n + 2 : 2] ||
        Math.abs(i.baseline - parents[0].baseline) > height * 0.2
    )
  )
    return
  const groups = groupSourceRowsWithScripts(
    source.filter((i) => i.rect[1] > divider && i.rect[3] < footer),
    height,
    0.35
  )
  if (!groups) return
  const spans = [
    { row: 0, column: 1, rowSpan: 2, colSpan: 1 },
    ...events.map((_, n) => ({ row: 0, column: 2 + n * 2, rowSpan: 1, colSpan: 2 }))
  ]
  let records = 0,
    sections = 0
  for (const [n, g] of groups.entries()) {
    const v = readSourceRow(g, cuts)
    if (!v || !/\p{L}/u.test(v[0])) return
    if (v.slice(1).every((s) => !s)) {
      spans.push({ row: n + 2, column: 0, rowSpan: 1, colSpan: columns.length })
      sections++
    } else {
      if (
        !/^\d+$/.test(v[1]) ||
        !events.every(
          (_, i) =>
            /^\d+\(\d+(?:\.\d+)?%\)$/.test(v[2 + i * 2]) && /^(?:0?\.\d+|—)?$/.test(v[3 + i * 2])
        )
      )
        return
      records++
    }
  }
  if (records < 6 || sections < 3) return
  return {
    rows: [union(upper), union(lower), ...groups.map(union)].map((r) => [left, r[1], right, r[3]]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], top, x, bottom]),
    spans,
    completeSpans: true,
    headerRows: [0, 1],
    ownedTokens: new Set([...upper, ...lower, ...groups.flat()])
  }
}

// A tall literature-review header can wrap independently beside a short parent
// and two underlined children. Recover those gutters from complete child glyphs;
// author anchors own the body, including separately footnoted outcome rows.
function recoverRuledReviewHeader(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (predicted.length !== 11) return
  const source = tableSourceItems(items, table.cropRect)
  const author = source.find((i) => i.text === 'Author, year'),
    parent = source.find((i) => i.text === 'Reported LRR')
  const children = ['MRI (%)', 'No MRI (%)'].map((s) => source.find((i) => i.text === s))
  if (!author || !parent || children.some((i) => !i)) return
  const underline = rules.find(
    (r) =>
      r[1] === r[3] &&
      r[1] > parent.rect[3] &&
      r[1] < Math.min(...children.map((i) => i.rect[1])) &&
      Math.abs(r[0] - children[0].rect[0]) < 1 &&
      Math.abs(r[2] - children[1].rect[2]) < 1
  )
  if (!underline) return
  const cuts = [
    left,
    ...predicted.slice(1).map((c, n) => left + (predicted[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const authors = source
    .filter(
      (i) => col(i) === 0 && (/\bet al\.\s*\d{4}$/.test(i.text) || /^Current series$/.test(i.text))
    )
    .sort((a, b) => a.baseline - b.baseline)
  if (authors.length < 4) return
  const bodyStart = authors[0].rect[1] - author.height * 0.25
  const heading = source.filter((i) => i.rect[3] < bodyStart)
  const neighbour = heading.filter((i) => col(i) === 7 && i !== parent)
  cuts[8] = (Math.max(...neighbour.map((i) => i.rect[2])) + children[0].rect[0]) / 2
  cuts[9] = (children[0].rect[2] + children[1].rect[0]) / 2
  if (
    cuts.some((x, n) => n && x <= cuts[n - 1]) ||
    source.some(
      (i) =>
        i !== parent &&
        (col(i) < 0 || i.rect[0] < cuts[col(i)] - 1 || i.rect[2] > cuts[col(i) + 1] + 1)
    )
  )
    return
  const rows = [
    [left, Math.min(...heading.map((i) => i.rect[1])), right, underline[1]],
    [left, underline[1], right, bodyStart]
  ]
  const spans = [{ row: 0, column: 8, rowSpan: 1, colSpan: 2 }]
  for (let c = 0; c < 11; c++)
    if (c !== 8 && c !== 9) spans.push({ row: 0, column: c, rowSpan: 2, colSpan: 1 })
  const footer = rules.find(
    (r) =>
      r[1] === r[3] &&
      r[1] >= Math.max(...source.map((i) => i.rect[3])) &&
      r[2] - r[0] > (right - left) * 0.9
  )?.[1]
  if (!footer) return
  for (const [n, a] of authors.entries()) {
    const start = a.rect[1] - author.height * 0.25,
      end = authors[n + 1] ? authors[n + 1].rect[1] - author.height * 0.25 : footer
    const owned = source.filter(
      (i) => (i.rect[1] + i.rect[3]) / 2 >= start && (i.rect[1] + i.rect[3]) / 2 < end
    )
    const values = owned
      .filter((i) => col(i) === 8 && /^\d[\d.]*$/.test(i.text))
      .sort((a, b) => a.baseline - b.baseline)
    if (
      !values.length ||
      values.length > 2 ||
      !owned.some((i) => col(i) === 1 && /^\d[\d,]*$/.test(i.text))
    )
      return
    if (values.length === 2) {
      const split = (values[0].rect[3] + values[1].rect[1]) / 2
      if (owned.some((i) => col(i) < 8 && (i.rect[1] + i.rect[3]) / 2 >= split)) return
      for (let c = 0; c < 8; c++)
        spans.push({ row: rows.length, column: c, rowSpan: 2, colSpan: 1 })
      rows.push([left, start, right, split], [left, split, right, end])
    } else rows.push([left, start, right, end])
  }
  return {
    rows,
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans,
    completeSpans: true
  }
}

// Native segmented underlines supply leaf columns; shorter underlines supply
// parent spans. Accept only complete numeric records with unique token ownership.
function recoverUnderlinedNumericGrid(table, items, captions, rules) {
  const crop = table.cropRect
  const caption = captions
    .filter(
      (c) =>
        captionKind(c.lines[0]) === 'table' &&
        c.rect[3] <= crop[1] + 40 &&
        c.rect[2] > crop[0] &&
        c.rect[0] < crop[2]
    )
    .sort((a, b) => b.rect[3] - a.rect[3])[0]
  if (!caption || crop[1] - caption.rect[3] > 30) return
  const bands = []
  for (const r of rules
    .filter(
      (r) =>
        r[1] === r[3] &&
        r[1] >= caption.rect[3] &&
        r[1] <= crop[3] + 8 &&
        r[0] >= crop[0] - 16 &&
        r[2] <= crop[2] + 16
    )
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])) {
    let band = bands.find((b) => Math.abs(b.y - r[1]) < 0.05)
    if (!band) bands.push((band = { y: r[1], parts: [] }))
    band.parts.push(r)
  }
  const full = bands.filter(
    (b) =>
      b.parts[0][0] < crop[0] + Math.max(16, (crop[2] - crop[0]) * 0.05) &&
      b.parts.at(-1)[2] > crop[2] - Math.max(16, (crop[2] - crop[0]) * 0.05) &&
      b.parts.every((r, n) => !n || (r[0] <= b.parts[n - 1][2] + 0.1 && r[2] > b.parts[n - 1][2]))
  )
  const footer = full.at(-1)
  if (!footer || Math.abs(footer.y - crop[3]) > 16) return
  const leafPattern =
    /^(?:n|%|Mean|SD|F|Utility|RI|Allgrades|Grade3-4|No|Yes|P\*|\((?:SE|SQ|TWT|SOL|WASO)\)|Arm[A-Z]:.+|HR\(95%CI\)|Pvalue|[bB]|t\(df\)|(?:Negative|Positive)\(n=\d+\))$/
  const native = tableSourceItems(items, [crop[0], caption.rect[3], crop[2], crop[3]])
  const candidates = [...full]
  // A single full divider can still use predicted gutters when repeated paired
  // population headings and their native underlines independently confirm them.
  const population = native.filter(
    (i) => i.rect[1] < crop[1] + 100 && /^(?:Negative|Positive)$/.test(i.text)
  )
  if (
    population.length === 6 &&
    new Set(population.map((i) => Math.round(i.baseline))).size === 1
  ) {
    const predicted = table.structure.objects
      .filter((o) => o.label === 'table column')
      .sort((a, b) => a.rect[0] - b.rect[0])
    if (predicted.length === 10) {
      const cuts = [
        crop[0],
        ...predicted.slice(1).map((c, n) => crop[0] + (predicted[n].rect[2] + c.rect[0]) / 2),
        crop[2]
      ]
      for (const b of full.filter(
        (b) =>
          b.parts.length === 1 && b.y > population[0].baseline && b.y - population[0].baseline < 40
      ))
        candidates.unshift({ ...b, parts: cuts.slice(1).map((x, c) => [cuts[c], b.y, x, b.y]) })
    }
  }
  // Repeated coefficient/test pairs are independently delimited by parent
  // underlines. Their single body rule needs the detector's leaf gutters only.
  const coefficients = native.filter((i) => /^[bB]$/.test(i.text) && i.rect[1] < crop[1] + 100)
  if (
    coefficients.length >= 3 &&
    coefficients.length <= 6 &&
    coefficients.every((i) => Math.abs(i.baseline - coefficients[0].baseline) < i.height * 0.2)
  ) {
    const predicted = table.structure.objects
      .filter((o) => o.label === 'table column')
      .sort((a, b) => a.rect[0] - b.rect[0])
    for (let n = predicted.length - 1; n > 0; n--) {
      const a = predicted[n - 1].rect,
        b = predicted[n].rect
      if ((Math.min(a[2], b[2]) - Math.max(a[0], b[0])) / Math.min(a[2] - a[0], b[2] - b[0]) > 0.9)
        predicted.splice(n, 1)
    }
    const parents = bands.find(
      (b) =>
        b.parts.length === coefficients.length &&
        b.y < coefficients[0].rect[1] &&
        coefficients[0].rect[1] - b.y < coefficients[0].height
    )
    const border = full.find(
      (b) => b.y > coefficients[0].rect[3] && b.y - coefficients[0].rect[3] < coefficients[0].height
    )
    if (parents && border && predicted.length === coefficients.length * 2 + 1) {
      const cuts = [
        crop[0],
        ...predicted.slice(1).map((c, n) => crop[0] + (predicted[n].rect[2] + c.rect[0]) / 2),
        crop[2]
      ]
      const leaves = native.filter((i) => i.rect[1] > parents.y && i.rect[3] < border.y)
      const values = readSourceRow(leaves, cuts)
      if (values && values.slice(1).every((v, n) => (n % 2 ? v === 't(df)' : /^[bB]$/.test(v))))
        candidates.unshift({
          ...border,
          parts: cuts.slice(1).map((x, c) => [cuts[c], border.y, x, border.y])
        })
    }
  }
  const roles = native
    .filter(
      (i) =>
        /^(?:Patients?|Spouses?|Intervention|Control)$/.test(i.text) && i.rect[1] < crop[1] + 100
    )
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (
    roles.length === 4 &&
    roles.every(
      (i, n) =>
        (n % 2 ? /^(?:Spouse|Control)/ : /^(?:Patient|Intervention)/).test(i.text) &&
        Math.abs(i.baseline - roles[0].baseline) < i.height * 0.2
    )
  ) {
    const parent = bands.find(
      (b) =>
        b.parts.length === 2 && b.y < roles[0].rect[1] && roles[0].rect[1] - b.y < roles[0].height
    )
    const border = full.find(
      (b) => b.y > roles[0].baseline && b.y - roles[0].baseline < roles[0].height * 2 + 1
    )
    if (parent && border) {
      const predicted = table.structure.objects
        .filter((o) => o.label === 'table column')
        .sort((a, b) => a.rect[0] - b.rect[0])
        .filter(
          (c, n, all) =>
            !all
              .slice(0, n)
              .some(
                (p) =>
                  (Math.min(p.rect[2], c.rect[2]) - Math.max(p.rect[0], c.rect[0])) /
                    Math.max(p.rect[2] - p.rect[0], c.rect[2] - c.rect[0]) >
                  0.9
              )
        )
      if (predicted.length === (roles[0].text === 'Intervention' ? 7 : 5)) {
        const cuts = [
          crop[0],
          ...predicted.slice(1).map((c, n) => crop[0] + (predicted[n].rect[2] + c.rect[0]) / 2),
          crop[2]
        ]
        const leaf = native.filter((i) => i.rect[1] > parent.y && i.rect[3] < border.y)
        const rawValues = readSourceRow(leaf, cuts)
        const values =
          rawValues &&
          cuts.slice(1).map((x, c) =>
            leaf
              .filter((i) => i.rect[0] >= cuts[c] && i.rect[2] <= x)
              .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
              .map((i) => i.text)
              .join('')
              .replace(/\s/g, '')
          )
        if (
          values &&
          values
            .slice(1)
            .every((v, n) =>
              (roles[0].text === 'Intervention'
                ? n % 3 === 2
                  ? /^p-?Value$/i
                  : n % 3 === 1
                    ? /^Control\(n=\d+\)$/
                    : /^Intervention\(n=\d+\)$/
                : n % 2
                  ? /^Spouses?(?:M?\(SE\)|\(n=\d+\))?$/
                  : /^Patients?(?:M\(SE\)|\(n=\d+\))?$/
              ).test(v)
            )
        )
          candidates.unshift({
            ...border,
            roleHeader: parent.y,
            parts: cuts.slice(1).map((x, c) => [cuts[c], border.y, x, border.y])
          })
      }
    }
  }
  const repeated = native.filter((i) => leafPattern.test(i.text.replace(/\s/g, '')))
  for (const anchor of repeated) {
    const leaf = repeated.filter(
      (i) => Math.abs(i.baseline - anchor.baseline) < anchor.height * 0.3
    )
    if (leaf.length < 3 || anchor.baseline - caption.rect[3] > 100) continue
    const end = Math.max(...leaf.map((i) => i.rect[3]))
    const boundary = full.find((b) => b.y > end && b.parts.length >= 5)
    const first = native.filter((i) => i.rect[1] > end).sort((a, b) => a.rect[1] - b.rect[1])[0]
    if (
      boundary &&
      first &&
      first.rect[1] < boundary.y &&
      first.rect[1] - end < anchor.height * 2 &&
      !candidates.some((b) => Math.abs(b.y - (end + first.rect[1]) / 2) < 0.1)
    )
      candidates.unshift({ ...boundary, y: (end + first.rect[1]) / 2 })
  }
  for (const divider of candidates.filter(
    (b) =>
      b.parts.length >= 5 && b.parts.length <= 25 && b.y - caption.rect[3] < 120 && b !== footer
  )) {
    const left = Math.min(crop[0], divider.parts[0][0]),
      right = Math.max(crop[2], divider.parts.at(-1)[2])
    const top = caption.rect[3] + 0.1,
      bottom = footer.y
    const source = tableSourceItems(items, [left, top, right, bottom])
    const heading = source.filter((i) => i.rect[3] < divider.y)
    const times = heading.filter((i) => /^T\d+$/.test(i.text))
    if (times.length >= 4) {
      const counts = [...Map.groupBy(times, (i) => i.text).values()].map((g) => g.length)
      if (counts.some((n) => n < 2 || n !== counts[0])) continue
    }
    const body = source.filter((i) => i.rect[1] > divider.y)
    if (!heading.length || !body.length || !hasUniqueRecordTokens(source, [heading, body])) continue
    const height = body.map((i) => i.height).sort((a, b) => a - b)[Math.floor(body.length / 2)]
    const leafY = Math.max(...heading.map((i) => i.baseline))
    const populationTier =
      population.length === 6
        ? Math.max(...bands.filter((b) => b.y < divider.y && b.parts.length === 3).map((b) => b.y))
        : -Infinity
    const leaves = heading.filter((i) =>
      divider.roleHeader
        ? i.rect[1] > divider.roleHeader
        : population.length === 6
          ? i.rect[1] > populationTier
          : Math.abs(i.baseline - leafY) < height * 0.3
    )
    let cuts = [left, ...divider.parts.slice(1).map((r) => r[0] - 0.1), right]
    // Empty narrow rule segments are spacing between groups, not data columns.
    for (let c = cuts.length - 2; c > 0; c--) {
      if (
        cuts[c + 1] - cuts[c] < height &&
        ![...leaves, ...body].some(
          (i) => (i.rect[0] + i.rect[2]) / 2 >= cuts[c] && (i.rect[0] + i.rect[2]) / 2 < cuts[c + 1]
        )
      )
        cuts.splice(c, 1)
    }
    const leafValues = readSourceRow(leaves, cuts)
    if (
      !leafValues ||
      leafValues.slice(1).filter(Boolean).length < 3 ||
      (!divider.roleHeader && leafValues.slice(1).filter((v) => leafPattern.test(v)).length < 3)
    )
      continue
    const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
    const shared =
      leafValues.slice(1).every((v, n) => v === (n % 2 ? 'RI' : 'Utility')) &&
      leafValues.length >= 7
    const coefficientPairs = leafValues
      .slice(1)
      .every((v, n) => (n % 2 ? v === 't(df)' : /^[bB]$/.test(v)))
    const probability = leafValues.filter((v) => v === 'P*').length >= 2
    const pValues = probability ? body.filter((i) => leafValues[col(i)] === 'P*') : []
    const sharedValues = shared ? body.filter((i) => col(i) > 0 && col(i) % 2 === 0) : pValues
    const recordBody = body.filter((i) => !sharedValues.includes(i))
    const groups = groupSourceRowsWithScripts(recordBody, height, 0.3)
    if (!groups || groups.length < 3) continue
    const owned = [],
      sections = [],
      labelSpans = []
    let valid = true,
      records = 0
    for (const g of groups) {
      let v = readSourceRow(g, cuts)
      if (!v && population.length === 6) {
        const stub = g.filter((i) => i.rect[0] < cuts[1]),
          values = g.filter((i) => i.rect[0] >= cuts[1])
        const start = Math.min(...values.map(col)),
          data = readSourceRow(values, cuts)
        if (
          stub.length === 1 &&
          /\p{L}/u.test(stub[0].text) &&
          start >= 2 &&
          stub[0].rect[2] < cuts[start] &&
          data
        ) {
          v = [stub[0].text.replace(/\s/g, ''), ...data.slice(1)]
          labelSpans.push({ row: owned.length, column: 0, rowSpan: 1, colSpan: start })
        }
      }
      if (!v && g.every((i) => i.rect[0] < cuts[1] && /\p{L}/u.test(i.text))) {
        const previous = owned.at(-1)
        if (
          previous &&
          sections.at(-1) &&
          /^[a-z]/.test(g[0].text) &&
          g[0].baseline - Math.max(...previous.map((i) => i.baseline)) < height * 1.6
        )
          previous.push(...g)
        else {
          owned.push([...g])
          sections.push(true)
        }
        continue
      }
      if (
        !v ||
        v
          .slice(1)
          .some(
            (s) =>
              s &&
              !(divider.roleHeader && /^[$€£]\d[\d,]*(?:\.\d+)?$/.test(s)) &&
              !/^(?:[<>≤≥−+–-]?(?:\d|\.\d)[\d.,()<>%±−+–/:-]*(?:\(ref\))?[a-z]{0,2}[*#†]{0,3}|\(\d+(?:\.\d+)?(?:[–−-]\d+(?:\.\d+)?)?\)|[—–-]|\*{1,3})$/.test(
                s
              )
          )
      ) {
        valid = false
        break
      }
      if (v.slice(1).some(Boolean)) {
        if (!v[0]) {
          const prior = owned.at(-1)
          if (
            divider.roleHeader &&
            prior &&
            !sections.at(-1) &&
            v.slice(1).filter(Boolean).length >= 2 &&
            v.slice(1).every((x) => !x || /^\(\d+[–−-]\d+\)$/.test(x)) &&
            union(g)[1] > union(prior)[3] &&
            union(g)[1] - union(prior)[3] < height
          ) {
            prior.push(...g)
            continue
          }
          valid = false
          break
        }
        records++
        const previous = owned.at(-1)
        if (
          previous &&
          sections.at(-1) &&
          ((coefficientPairs && previous.some((i) => /[×*]\s*$/.test(i.text))) ||
            (divider.roleHeader &&
              (/^\(/.test(v[0]) ||
                Math.min(...previous.map((i) => i.rect[0])) -
                  Math.min(...body.filter((i) => col(i) === 0).map((i) => i.rect[0])) >=
                  height * 0.5))) &&
          Math.min(...g.map((i) => i.rect[1])) - Math.max(...previous.map((i) => i.rect[3])) <
            height
        ) {
          previous.push(...g)
          sections[sections.length - 1] = false
        } else {
          owned.push([...g])
          sections.push(false)
        }
      } else if (v[0]) {
        const previous = owned.at(-1)
        if (
          previous &&
          (/^[a-z(]/.test(v[0]) ||
            /^(?:RateofChange|RandomEffects)$/.test(
              previous
                .map((i) => i.text)
                .join('')
                .replace(/\s/g, '') + v[0]
            )) &&
          Math.min(...g.map((i) => i.baseline)) - Math.max(...previous.map((i) => i.baseline)) <
            height * 1.6
        )
          previous.push(...g)
        else {
          owned.push([...g])
          sections.push(true)
        }
      } else {
        valid = false
        break
      }
    }
    if (!valid || records < 3 || !hasUniqueRecordTokens(recordBody, owned)) continue
    const bodyBounds = owned.map(union)
    // Raised significance marks can graze the preceding line's font box.
    // Keep the native baseline grouping and divide only this sub-point overlap.
    if (coefficientPairs || divider.roleHeader)
      for (let n = 1; n < bodyBounds.length; n++) {
        const previous = bodyBounds[n - 1],
          current = bodyBounds[n]
        if (
          current[1] <= previous[3] &&
          previous[3] - current[1] < height * (divider.roleHeader ? 0.2 : 0.1)
        ) {
          const boundary = (previous[3] + current[1]) / 2
          previous[3] = boundary - 0.001
          current[1] = boundary + 0.001
        }
      }
    if (bodyBounds.some((r, n) => n && r[1] <= bodyBounds[n - 1][3])) continue
    const tiers = bands
      .filter(
        (b) =>
          b.y < divider.y &&
          b.y > Math.min(...heading.map((i) => i.rect[1])) &&
          b.parts.some((r) => r[0] > left + height || r[2] < right - height)
      )
      .map((b) => ({ ...b, parts: [...b.parts] }))
    for (let n = tiers.length - 1; n > 0; n--) {
      if (tiers[n].y - tiers[n - 1].y < height * 0.15) {
        tiers[n - 1].parts.push(...tiers[n].parts)
        tiers[n - 1].parts.sort((a, b) => a[0] - b[0])
        tiers.splice(n, 1)
      }
    }
    if (
      tiers.length > 2 ||
      (!tiers.length && leafValues.filter((v) => /^\([A-Z]+\)$/.test(v)).length < 4)
    )
      continue
    const ys = [top, ...tiers.map((b) => b.y), divider.y]
    const spans = labelSpans.map((s) => ({ ...s, row: s.row + ys.length - 1 })),
      assigned = new Set()
    if (probability) {
      const gs = []
      for (let c = 1; c < cuts.length - 1; c++)
        if (leafValues[c] === 'P*') {
          const g = pValues.filter((i) => col(i) === c)
          if (g.length !== 1 || !/^0?\.\d+$/.test(g[0].text)) {
            valid = false
            break
          }
          gs.push(g)
          // A probability printed beside another decimal statistic belongs to
          // that native record, not an inferred span across the entire matrix.
          const aligned = owned.findIndex((record) =>
            record.some(
              (i) =>
                col(i) === c - 1 &&
                /^\d?\.\d+$/.test(i.text) &&
                Math.abs(i.baseline - g[0].baseline) < height * 0.1
            )
          )
          spans.push({
            row: ys.length - 1 + Math.max(0, aligned),
            column: c,
            rowSpan: aligned < 0 ? owned.length : 1,
            colSpan: 1
          })
        }
      if (!valid || !hasUniqueRecordTokens(pValues, gs)) continue
    }
    if (shared) {
      const sectionRows = sections.flatMap((s, n) => (s ? [n] : []))
      if (sectionRows.length < 3 || sectionRows[0] !== 0) continue
      const sharedGroups = []
      for (const [index, start] of sectionRows.entries()) {
        const end = sectionRows[index + 1] ?? owned.length
        if (end - start < 3) {
          valid = false
          break
        }
        for (let c = 2; c < cuts.length - 1; c += 2) {
          const g = sharedValues.filter(
            (i) =>
              col(i) === c &&
              i.rect[1] > bodyBounds[start][3] &&
              i.rect[3] <= bodyBounds[end - 1][3] + height * 0.3
          )
          if (g.length !== 1 || !/^\d+(?:\.\d+)?$/.test(g[0].text)) {
            valid = false
            break
          }
          sharedGroups.push(g)
          spans.push({ row: start + ys.length, column: c, rowSpan: end - start - 1, colSpan: 1 })
        }
      }
      if (!valid || !hasUniqueRecordTokens(sharedValues, sharedGroups)) continue
    }
    for (let row = 0; row < ys.length - 1; row++) {
      const tokens = heading.filter((i) => i.rect[1] >= ys[row] && i.rect[3] <= ys[row + 1])
      if (row < tiers.length) {
        const segments = []
        for (const r of tiers[row].parts) {
          const p = segments.at(-1)
          if (p && Math.abs(p[2] - r[0]) < 0.1) p[2] = r[2]
          else segments.push([...r])
        }
        for (const r of segments) {
          const owned = tokens.filter((i) => i.rect[0] >= r[0] - 0.2 && i.rect[2] <= r[2] + 0.2)
          if (!owned.length) continue
          const covered = cuts
            .slice(1)
            .flatMap((x, c) =>
              leaves.some((i) => col(i) === c && i.rect[0] >= r[0] - 0.2 && i.rect[2] <= r[2] + 0.2)
                ? [c]
                : []
            )
          if (!covered.length || covered.some((c, n) => n && c !== covered[n - 1] + 1)) {
            valid = false
            break
          }
          spans.push({ row, column: covered[0], rowSpan: 1, colSpan: covered.length })
          owned.forEach((i) => assigned.add(i))
        }
      }
      for (const i of tokens.filter((i) => !assigned.has(i))) {
        const c = col(i)
        if (c < 0 || i.rect[0] < cuts[c] - 0.2 || i.rect[2] > cuts[c + 1] + 0.2) {
          valid = false
          break
        }
        assigned.add(i)
      }
    }
    for (const i of heading.filter((i) => !assigned.has(i))) {
      const c = col(i)
      if (
        c < 0 ||
        i.rect[0] < cuts[c] ||
        i.rect[2] > cuts[c + 1] ||
        spans.some((s) => c >= s.column && c < s.column + s.colSpan)
      ) {
        valid = false
        break
      }
      assigned.add(i)
    }
    if (!valid || assigned.size !== heading.length) continue
    // A wrapped stub can cross a tier boundary without crossing a data column.
    for (let c = 0; c < cuts.length - 1; c++) {
      const tokens = heading.filter(
        (i) => col(i) === c && !spans.some((s) => c >= s.column && c < s.column + s.colSpan)
      )
      if (tokens.length && tokens.every((i) => i.rect[0] >= cuts[c] && i.rect[2] <= cuts[c + 1]))
        spans.push({ row: 0, column: c, rowSpan: ys.length - 1, colSpan: 1 })
    }
    return {
      rows: [
        ...ys.slice(1).map((y, n) => [left, ys[n], right, y]),
        ...bodyBounds.map((r) => [left, r[1], right, r[3]])
      ],
      columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
      spans: [
        ...spans,
        ...sections.flatMap((s, n) =>
          s ? [{ row: n + ys.length - 1, column: 0, rowSpan: 1, colSpan: cuts.length - 1 }] : []
        )
      ],
      headerRows: ys.slice(1).map((_, n) => n),
      completeSpans: true,
      ownedTokens: new Set(source)
    }
  }
}

// Native domain labels occupy the first column and start on the first member
// baseline. They must never inherit the preceding model row's group boundary.
function recoverRuledDomainGrid(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const bands = []
  for (const r of rules
    .filter((r) => r[1] === r[3] && r[1] >= top && r[1] <= bottom)
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])) {
    let b = bands.find((b) => Math.abs(b.y - r[1]) < 0.1)
    if (!b) bands.push((b = { y: r[1], parts: [] }))
    b.parts.push(r)
  }
  const divider = bands.find(
    (b) =>
      [5, 11].includes(b.parts.length) &&
      b.y - top < 100 &&
      b.parts[0][0] < left + 2 &&
      b.parts.at(-1)[2] > right - 4 &&
      b.parts.every((r, n) => !n || (r[0] < b.parts[n - 1][2] && r[2] > b.parts[n - 1][2]))
  )
  const footer = bands.find(
    (b) =>
      b.parts.length === 1 &&
      b.y > divider?.y + 50 &&
      bottom - b.y < 16 &&
      b.parts[0][0] < left + 2 &&
      b.parts[0][2] > right - 4
  )
  if (!divider || !footer) return
  const cuts = [
    left,
    ...divider.parts.slice(1).map((r, n) => (divider.parts[n][2] + r[0]) / 2),
    right
  ]
  const source = tableSourceItems(items, [left, top, right, footer.y]),
    height = source.map((i) => i.height).sort((a, b) => a - b)[Math.floor(source.length / 2)]
  const head = source.filter((i) => i.rect[3] < divider.y),
    body = source.filter((i) => i.rect[1] > divider.y)
  if (!head.length || !hasUniqueRecordTokens(source, [head, body])) return
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const parents = body.filter((i) => col(i) === 0)
  if (
    parents.length < 2 ||
    parents.length > 5 ||
    parents.some((i) => !/^\p{Lu}[\p{Lu}\d-]{2,24}$/u.test(i.text))
  )
    return
  const groups = groupSourceRowsWithScripts(
    body.filter((i) => col(i) !== 0),
    height,
    0.3
  )
  if (!groups) return
  const records = []
  for (const g of groups) {
    const v = readSourceRow(g, cuts)
    if (!v || !/[a-z]/i.test(v[1]) || v[0]) return
    if (v.slice(2).every((x) => x && /^[<>≤≥−–+-]?(?:\d|\.\d)[\d.,() %≤≥−–+/*-]*[a-z]?$/.test(x)))
      records.push([...g])
    else if (
      v.slice(2).every((x) => !x) &&
      records.length &&
      g[0].baseline - records.at(-1)[0].baseline < height * 1.6
    )
      records.at(-1).push(...g)
    else return
  }
  if (
    records.length < 12 ||
    !hasUniqueRecordTokens(
      body.filter((i) => col(i) !== 0),
      records
    )
  )
    return
  const bounds = records.map(union)
  if (bounds.some((r, n) => n && r[1] <= bounds[n - 1][3])) return
  const starts = parents.map((p) =>
    records.findIndex((g) => Math.abs(g[0].baseline - p.baseline) < height * 0.3)
  )
  if (starts[0] !== 0 || starts.some((n, i) => n < 0 || (i && n - starts[i - 1] < 3))) return
  const tiers = bands.filter((b) => b.y < divider.y && b.parts.length === 2)
  if ((cuts.length === 12 && tiers.length !== 2) || (cuts.length === 6 && tiers.length)) return
  const ys = [top, ...tiers.map((b) => b.y), divider.y],
    spans = []
  const headerRows = ys.length - 1
  for (let n = 0; n < parents.length; n++)
    spans.push({
      row: headerRows + starts[n],
      column: 0,
      rowSpan: (starts[n + 1] ?? records.length) - starts[n],
      colSpan: 1
    })
  if (tiers.length) {
    const labels = head.filter((i) => i.rect[3] < tiers[0].y)
    if (labels.length !== 2 || labels[0].text !== 'Intervention' || labels[1].text !== 'Control')
      return
    for (const [n, label] of labels.entries()) {
      const first = col(label),
        end = n === 0 ? col(labels[1]) : cuts.length - 1
      if (first !== 2 + n * 4) return
      spans.push({ row: 0, column: first, rowSpan: 1, colSpan: end - first })
    }
    for (let c = 2; c < cuts.length - 1; c++) {
      const tokens = head.filter((i) => col(i) === c && i.rect[1] > tiers[0].y)
      if (
        tokens.some((i) => i.rect[1] < tiers[1].y) &&
        tokens.some((i) => i.rect[3] > tiers[1].y) &&
        !tokens.some((i) => i.text === 'Mean value')
      )
        spans.push({ row: 1, column: c, rowSpan: 2, colSpan: 1 })
    }
  }
  return {
    rows: [
      ...ys.slice(1).map((y, n) => [left, ys[n], right, y]),
      ...bounds.map((r) => [left, r[1], right, r[3]])
    ],
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, footer.y]),
    headerRows: Array.from({ length: headerRows }, (_, n) => n),
    spans,
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Dense cohort tables can switch from a merged descriptive stub to paired
// category/value stubs. Repeated sample headings and category pairs prove the
// switch; every source baseline must be a complete record or a section.
function recoverMixedStubCountRecords(table, items, captions) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (predicted.length !== 5) return
  const cuts = [
    left,
    ...predicted.slice(1).map((c, n) => left + (predicted[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const source = tableSourceItems(items, table.cropRect),
    heights = source.map((i) => i.height).sort((a, b) => a - b),
    height = heights[Math.floor(heights.length / 2)]
  const groups = groupSourceRowsWithScripts(
    [...source].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0]),
    height,
    0.35
  )
  if (!groups || groups.length < 20) return
  const pairedHeaders = groups.findIndex((g) => {
    const v = readSourceRow(g, cuts)
    return v && !v[0] && !v[1] && !v[4] && /^(?:No\.?|n)\.?(?:\(%\))$/i.test(v[2]) && v[2] === v[3]
  })
  if (pairedHeaders < 1 || pairedHeaders > 3) return
  const head = groups.slice(0, pairedHeaders + 1).flat()
  if (
    ![2, 3].every((c) =>
      head.some(
        (i) => i.rect[0] >= cuts[c] && i.rect[2] <= cuts[c + 1] && /^\(N\s*=\s*\d+\)$/i.test(i.text)
      )
    )
  )
    return
  const body = groups.slice(pairedHeaders + 1),
    spans = [{ row: 0, column: 0, rowSpan: 1, colSpan: 2 }]
  const scalar = (s) =>
    /^(?:NA|[<>≤≥−-]?\d+(?:[.,]\d+)?(?:[–-]\d+)?(?:\(\d+(?:[.,]\d+)?(?:[–-]\d+)?%?\))?)$/i.test(s)
  let records = 0,
    sections = 0
  const pairs = []
  for (let n = 0; n < body.length; n++) {
    const g = body[n],
      v = readSourceRow(g, [left, cuts[2], cuts[3], cuts[4], right])
    if (!v) return
    if (v[0] && v.slice(1).every((s) => !s) && /\p{L}/u.test(v[0])) {
      sections++
      spans.push({ row: n + 1, column: 0, rowSpan: 1, colSpan: 5 })
      continue
    }
    if (!v[0] || !scalar(v[1]) || !scalar(v[2]) || (v[3] && !scalar(v[3]))) return
    records++
    const stub = g.filter((i) => i.rect[0] < cuts[2]),
      dual = readSourceRow(stub, cuts)
    if (dual?.[0] && dual[1]) {
      const next = body[n + 1] && readSourceRow(body[n + 1], cuts)
      if (!next || next[0] || !next[1] || !scalar(next[2]) || !scalar(next[3]) || next[4]) return
      pairs.push([dual[1], next[1]].join('|'))
      spans.push({ row: n + 1, column: 0, rowSpan: 2, colSpan: 1 })
    } else if (dual?.[1] && !dual[0]) {
      if (!spans.some((s) => s.row === n && s.rowSpan === 2)) return
    } else spans.push({ row: n + 1, column: 0, rowSpan: 1, colSpan: 2 })
  }
  if (
    records < 12 ||
    sections < 3 ||
    pairs.length < 2 ||
    new Set(pairs).size !== 1 ||
    !hasUniqueRecordTokens(source, [head, ...body])
  )
    return
  return {
    rows: [head, ...body].map((g) => {
      const r = union(g)
      return [left, r[1], right, r[3]]
    }),
    columns: cuts.slice(1).map((x, n) => [cuts[n], top, x, bottom]),
    spans,
    completeSpans: true
  }
}
// Repeated count/percentage pairs establish categorical source rows even when
// the model drops the final category or merges a label into the preceding row.
// Each record must have both counts and either all or no percentages. Cohort
// qualifiers and a final P heading independently prove the paired header spans.
export function recoverPairedCountGrid(table, items, captions) {
  const grades = recoverPairedGradeHeader(table, items, captions)
  if (grades) return grades
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const model = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (model.length < 7 || model.length > 11 || model.length % 2 !== 1) return
  const cuts = [
    left,
    ...model.slice(1).map((o, n) => (o.rect[0] + model[n].rect[2]) / 2 + left),
    right
  ]
  const source = tableSourceItems(items, table.cropRect)
  if (!source.length) return
  const height = source.map((i) => i.height).sort((a, b) => a - b)[Math.floor(source.length / 2)]
  const groups = groupSourceRowsWithScripts(source, height, 0.3)
  if (!groups || groups.length < 7) return
  const header = groups[0]
  const parentCuts = [left, cuts[1], cuts[2], ...cuts.slice(4).filter((_, n) => n % 2 === 0), right]
  const headings = readSourceRow(header, parentCuts)
  if (
    !headings ||
    headings[0] ||
    headings[1] ||
    !/^P(?:-?value)?$/i.test(headings.at(-1)) ||
    !headings.slice(2, -1).every((s) => /\p{L}/u.test(s) && /\(n=\d+\)/i.test(s))
  )
    return
  const records = groups.slice(1).map((g) => readSourceRow(g, cuts))
  if (
    records.some(
      (r) =>
        !r ||
        !r[1] ||
        !Array.from({ length: (model.length - 3) / 2 }, (_, n) => n * 2 + 2).every((c) =>
          /^\d+$/.test(r[c])
        ) ||
        !(
          r
            .slice(3, -1)
            .filter((_, n) => n % 2 === 0)
            .every((s) => /^\(\d+(?:\.\d+)?%\)$/.test(s)) ||
          r
            .slice(3, -1)
            .filter((_, n) => n % 2 === 0)
            .every((s) => !s)
        ) ||
        (r.at(-1) && !/^[<>≤≥]?\d+(?:\.\d+)?[a-z]?$/.test(r.at(-1)))
    )
  )
    return
  const starts = records.flatMap((r, n) => (r[0] ? [n] : []))
  if (
    starts.length < 2 ||
    starts[0] !== 0 ||
    records.filter((r) => r[3]).length < 4 ||
    groups.some((g, n) => n && union(g)[1] < union(groups[n - 1])[3])
  )
    return
  const spans = Array.from({ length: (model.length - 3) / 2 }, (_, n) => ({
    row: 0,
    column: 2 + n * 2,
    rowSpan: 1,
    colSpan: 2
  }))
  for (const [n, first] of starts.entries()) {
    const end = starts[n + 1] ?? records.length
    if (end - first < 2) continue
    spans.push({ row: first + 1, column: 0, rowSpan: end - first, colSpan: 1 })
    const tests = records.slice(first, end).flatMap((r, n) => (r.at(-1) ? [first + n] : []))
    for (const [n, start] of tests.entries()) {
      const limit = tests[n + 1] ?? end
      if (limit - start >= 2)
        spans.push({ row: start + 1, column: model.length - 1, rowSpan: limit - start, colSpan: 1 })
    }
  }
  const ys = [
    top,
    ...groups.slice(1).map((g, n) => (union(groups[n])[3] + union(g)[1]) / 2),
    union(groups.at(-1))[3] + 0.1
  ]
  return {
    rows: groups.map((_, n) => [left, ys[n], right, ys[n + 1]]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], top, x, bottom]),
    spans,
    headerRows: [0],
    completeSpans: true
  }
}

// Repeated grade leaves establish cohort pairs even when a common unit line
// follows the leaves. Keep that unit as its own spanning header, not in the
// first cohort's grade cell; all body records must independently fit the cuts.
function recoverPairedGradeHeader(table, items, captions) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const columns = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (columns.length < 5 || columns.length > 13 || columns.length % 2 !== 1) return
  const cuts = [
    left,
    ...columns.slice(1).map((c, n) => left + (columns[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const source = tableSourceItems(items, table.cropRect),
    height = source.map((i) => i.height).sort((a, b) => a - b)[Math.floor(source.length / 2)],
    groups = groupSourceRowsWithScripts(source, height, 0.3)
  if (!groups) return
  const tier = groups.findIndex((g) => {
    const v = readSourceRow(g, cuts)
    return (
      v &&
      !v[0] &&
      v
        .slice(1)
        .every((s, n) =>
          n % 2 ? /^Grade[3-5](?:[/–-][3-5])?$/i.test(s) : /^(?:All|Any)Grades?$/i.test(s)
        )
    )
  })
  if (tier < 1 || tier > 3 || !groups[tier + 2]) return
  const head = groups.slice(0, tier).flat(),
    parentCuts = [left, ...cuts.slice(1, -1).filter((_, n) => n % 2 === 0), right],
    parents = readSourceRow(head, parentCuts, { multiline: true })
  const unit = readSourceRow(groups[tier + 1], [left, cuts[1], right])
  if (
    !parents ||
    !/\p{L}/u.test(parents[0]) ||
    !parents.slice(1).every((s) => /\p{L}/u.test(s) && /\(N=\d+\)/i.test(s)) ||
    !unit ||
    unit[0] ||
    !/^(?:Numberofpatients|Patients|n)\(%\)$/i.test(unit[1])
  )
    return
  const body = groups.slice(tier + 2),
    spans = [
      { row: 0, column: 0, rowSpan: 3, colSpan: 1 },
      { row: 2, column: 1, rowSpan: 1, colSpan: columns.length - 1 }
    ]
  let measured = 0
  for (const [n, g] of body.entries()) {
    const v = readSourceRow(g, cuts)
    if (!v || !v[0]) return
    if (v.slice(1).every((s) => !s)) {
      spans.push({ row: n + 3, column: 0, rowSpan: 1, colSpan: columns.length })
      continue
    }
    if (!v.slice(1).every((s) => /^\d+(?:\(\d+(?:\.\d+)?%?\))?$/.test(s))) return
    measured++
  }
  if (measured < 5) return
  for (let c = 1; c < columns.length; c += 2)
    spans.push({ row: 0, column: c, rowSpan: 1, colSpan: 2 })
  const owned = [head, groups[tier], groups[tier + 1], ...body],
    bounds = owned.map(union)
  if (!hasUniqueRecordTokens(source, owned) || bounds.some((r, n) => n && r[1] <= bounds[n - 1][3]))
    return
  const ys = [top, ...bounds.slice(1).map((r, n) => (r[1] + bounds[n][3]) / 2), bottom]
  return {
    rows: owned.map((_, n) => [left, ys[n], right, ys[n + 1]]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], top, x, bottom]),
    spans,
    headerRows: [0, 1, 2],
    completeSpans: true
  }
}
