/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { splitNativeMeasuredFields } from './literature-pdf-native-header-grid.mjs'
import { proveNativeUniqueWholeFonts } from './literature-pdf-table-evidence.mjs'
// Called only after the native glyph splitter has proved every fragment's width.
// Offsets refer to the original UTF-16 string, including its literal whitespace.
export function measuredSourceRanges(item, fragments) {
  const origin = item.sourceItem
  if (!origin || origin.text !== item.str || item.sourceSegment) return undefined
  let cursor = 0
  const ranges = []
  for (const fragment of fragments) {
    const start = item.str.indexOf(fragment, cursor)
    if (!fragment.trim() || start < cursor || item.str.slice(cursor, start).trim()) return undefined
    cursor = start + fragment.length
    ranges.push({ ...origin, start, end: cursor })
  }
  return item.str.slice(cursor).trim() ? undefined : ranges
}

const sameRect = (a, b) =>
  a?.length === 4 &&
  b?.length === 4 &&
  a.every((v, i) => Number.isFinite(v) && Math.abs(v - b[i]) < 1e-6)
const sourceKey = (source) => `${source.pageNumber}:${source.index}`
const sameOrigin = (a, b) => sourceKey(a) === sourceKey(b) && a.text === b.text
const arrayOrEmpty = (value) => (Array.isArray(value) ? value : [])
const tableCells = (table) => [
  ...arrayOrEmpty(table.cells).map((cell) => ({ cell, table })),
  ...arrayOrEmpty(table.parts).flatMap(tableCells)
]

const sourceCarriers = (token) =>
  [
    token.sourceItem,
    token.sourceSegment,
    token.sourceToken?.sourceItem,
    token.sourceToken?.sourceSegment,
    token.sourceToken?.pageNumber !== undefined ? token.sourceToken : undefined
  ].filter(Boolean)
const cellOrigins = (cell) => [
  ...arrayOrEmpty(cell.sourceItems),
  ...arrayOrEmpty(cell.sourceSegments),
  ...arrayOrEmpty(cell.sourceTokens).flatMap(sourceCarriers)
]
const containsRect = (outer, inner) =>
  outer?.length === 4 &&
  inner?.length === 4 &&
  outer.every(Number.isFinite) &&
  inner.every(Number.isFinite) &&
  inner[0] >= outer[0] - 1e-6 &&
  inner[1] >= outer[1] - 1e-6 &&
  inner[2] <= outer[2] + 1e-6 &&
  inner[3] <= outer[3] + 1e-6
const plainRunsAgree = (cell) =>
  !cell.textRuns || cell.textRuns.map((run) => run.text).join('') === cell.text

// Mixed words/numbers need independent column evidence before replacing even
// whitespace-only clip slack. A complete first native row and another complete
// native record must occupy the same domains; neither may borrow this parent.
function hasIndependentMixedColumns(entries, group, tokens, run, measured, origin, pieces) {
  const decimal = (text) => /^[−+-]?(?:\d+(?:\.\d+)?|\.\d+)$/u.test(text)
  if (
    !pieces.some(decimal) ||
    pieces.every(decimal) ||
    !Array.isArray(run.literalGlyphs) ||
    run.literalGlyphs.join('').replace(/\s/gu, '') !== origin.text.replace(/\s/gu, '')
  )
    return false
  const owner = group[0].table
  const uniqueSlot = (cell) =>
    entries.filter(
      (entry) =>
        entry.table === owner &&
        cell.row >= entry.cell.row &&
        cell.row < entry.cell.row + entry.cell.rowSpan &&
        cell.column >= entry.cell.column &&
        cell.column < entry.cell.column + entry.cell.colSpan
    ).length === 1
  if (
    group.some(
      ({ cell }, index) =>
        !uniqueSlot(cell) ||
        !plainRunsAgree(cell) ||
        owner.grid?.[cell.row]?.[cell.column] !== cell.text ||
        !containsRect(cell.rect, measured[index]) ||
        (index > 0 &&
          (Math.abs(cell.rect[0] - group[index - 1].cell.rect[2]) > 1e-6 ||
            Math.abs(cell.rect[1] - group[0].cell.rect[1]) > 1e-6 ||
            Math.abs(cell.rect[3] - group[0].cell.rect[3]) > 1e-6))
    )
  )
    return false
  const parent = tokens.filter((token) =>
    sourceCarriers(token).some((source) => sourceKey(source) === sourceKey(origin))
  )
  if (
    parent.length !== 1 ||
    parent[0].sourceSegment ||
    parent[0].sourceToken?.sourceSegment ||
    sourceCarriers(parent[0]).some((source) => !sameOrigin(source, origin))
  )
    return false
  if (
    entries.some(
      (entry) =>
        !group.includes(entry) &&
        cellOrigins(entry.cell).some((source) => sourceKey(source) === sourceKey(origin))
    )
  )
    return false
  const completeNative = (cell) => {
    if (
      !cell ||
      !uniqueSlot(cell) ||
      cell.rowSpan !== 1 ||
      cell.colSpan !== 1 ||
      !cell.text ||
      !plainRunsAgree(cell) ||
      owner.grid?.[cell.row]?.[cell.column] !== cell.text ||
      cell.sourceSegments ||
      !cell.sourceItems?.length ||
      cell.sourceItems.length !== cell.sourceRects?.length ||
      cell.sourceItems.length !== cell.sourceTokens?.length ||
      cell.sourceItems
        .map((source) => source.text)
        .join('')
        .replace(/\s/gu, '') !== cell.text.replace(/\s/gu, '')
    )
      return false
    const keys = cell.sourceItems.map(sourceKey)
    if (new Set(keys).size !== keys.length || keys.includes(sourceKey(origin))) return false
    const ownedPadding = (token) => {
      const claimed = entries.filter((entry) =>
        cellOrigins(entry.cell).some((source) =>
          sourceCarriers(token).some((item) => sameOrigin(source, item))
        )
      )
      if (claimed.length !== 1 || claimed[0].table !== owner) return false
      const adjacent = claimed[0].cell
      if (
        Math.abs(adjacent.row - cell.row) !== 1 ||
        adjacent.column !== cell.column ||
        adjacent.rowSpan !== 1 ||
        adjacent.colSpan !== 1 ||
        !uniqueSlot(adjacent) ||
        !plainRunsAgree(adjacent) ||
        owner.grid?.[adjacent.row]?.[adjacent.column] !== adjacent.text ||
        adjacent.sourceSegments ||
        !adjacent.sourceItems?.length ||
        adjacent.sourceItems.length !== adjacent.sourceRects?.length ||
        adjacent.sourceItems.length !== adjacent.sourceTokens?.length ||
        adjacent.sourceItems
          .map((source) => source.text)
          .join('')
          .replace(/\s/gu, '') !== adjacent.text.replace(/\s/gu, '') ||
        cell.sourceRects.some(
          (rect) => Math.min(rect[3], token.rect[3]) > Math.max(rect[1], token.rect[1]) + 1e-6
        )
      )
        return false
      const adjacentKeys = adjacent.sourceItems.map(sourceKey)
      if (new Set(adjacentKeys).size !== adjacentKeys.length) return false
      return adjacent.sourceItems.every((source, index) => {
        const native = tokens.filter((item) =>
          sourceCarriers(item).some((s) => sourceKey(s) === sourceKey(source))
        )
        const assigned = adjacent.sourceTokens[index]
        return (
          native.length === 1 &&
          native[0].sourceItem &&
          native[0].horizontal &&
          !native[0].sourceSegment &&
          !native[0].sourceToken?.sourceSegment &&
          sourceCarriers(native[0]).every((item) => sameOrigin(item, source)) &&
          native[0].text === source.text &&
          !assigned.sourceSegment &&
          !assigned.sourceToken?.sourceSegment &&
          assigned.text === source.text &&
          sourceCarriers(assigned).every((item) => sameOrigin(item, source)) &&
          sameRect(native[0].rect, adjacent.sourceRects[index]) &&
          sameRect(native[0].rect, assigned.rect) &&
          native[0].rect[0] >= adjacent.rect[0] &&
          native[0].rect[2] <= adjacent.rect[2] &&
          (native[0].rect[1] + native[0].rect[3]) / 2 >= adjacent.rect[1] &&
          (native[0].rect[1] + native[0].rect[3]) / 2 <= adjacent.rect[3] &&
          entries.filter((entry) =>
            cellOrigins(entry.cell).some((item) => sourceKey(item) === sourceKey(source))
          ).length === 1
        )
      })
    }
    if (
      tokens.some(
        (token) =>
          token.text?.trim() &&
          Math.min(token.rect[2], cell.rect[2]) > Math.max(token.rect[0], cell.rect[0]) + 1e-6 &&
          Math.min(token.rect[3], cell.rect[3]) > Math.max(token.rect[1], cell.rect[1]) + 1e-6 &&
          !cell.sourceItems.some(
            (source, index) =>
              token.sourceItem &&
              sameOrigin(token.sourceItem, source) &&
              sameRect(token.rect, cell.sourceRects[index])
          ) &&
          !ownedPadding(token)
      )
    )
      return false
    return cell.sourceItems.every((source, index) => {
      const native = tokens.filter((token) =>
        sourceCarriers(token).some((item) => sourceKey(item) === sourceKey(source))
      )
      const assigned = cell.sourceTokens[index]
      return (
        native.length === 1 &&
        native[0].horizontal &&
        !native[0].sourceSegment &&
        !native[0].sourceToken?.sourceSegment &&
        native[0].text === source.text &&
        sourceCarriers(native[0]).every((item) => sameOrigin(item, source)) &&
        assigned.text === source.text &&
        !assigned.sourceSegment &&
        !assigned.sourceToken?.sourceSegment &&
        sourceCarriers(assigned).every((item) => sameOrigin(item, source)) &&
        sameRect(native[0].rect, cell.sourceRects[index]) &&
        sameRect(assigned.rect, native[0].rect) &&
        containsRect(cell.rect, native[0].rect) &&
        entries.filter((entry) =>
          cellOrigins(entry.cell).some((item) => sourceKey(item) === sourceKey(source))
        ).length === 1 &&
        !entries.some(
          (entry) =>
            entry.cell !== cell &&
            entry.cell.sourceRects?.some(
              (rect) =>
                Math.min(rect[2], native[0].rect[2]) >
                  Math.max(rect[0], native[0].rect[0]) + 1e-6 &&
                Math.min(rect[3], native[0].rect[3]) > Math.max(rect[1], native[0].rect[1]) + 1e-6
            )
        ) &&
        !tokens.some((token) => token !== native[0] && sameRect(token.rect, native[0].rect))
      )
    })
  }
  const matching = (row, cell) =>
    entries.filter(
      (entry) =>
        entry.table === owner &&
        entry.cell.row === row &&
        entry.cell.column === cell.column &&
        entry.cell.rect?.length === 4 &&
        Math.abs(entry.cell.rect[0] - cell.rect[0]) < 1e-6 &&
        Math.abs(entry.cell.rect[2] - cell.rect[2]) < 1e-6
    )
  const completeRow = (row) =>
    group.every(({ cell }) => {
      const found = matching(row, cell)
      return (
        found.length === 1 &&
        completeNative(found[0].cell) &&
        (row < cell.row
          ? found[0].cell.rect[3] <= cell.rect[1]
          : found[0].cell.rect[1] >= cell.rect[3])
      )
    })
  return (
    group[0].cell.row > 0 &&
    completeRow(0) &&
    entries.some(
      (entry) =>
        entry.table === owner &&
        entry.cell.row > 0 &&
        entry.cell.row !== group[0].cell.row &&
        completeRow(entry.cell.row)
    )
  )
}

// Annotate an exact existing leaf assignment, without moving geometry or text.
function exactMeasuredParentPlan(entries, tokens, observations, token) {
  const carriers = (item) =>
    [
      item.sourceItem,
      item.sourceSegment,
      ...arrayOrEmpty(item.sourceItems),
      ...arrayOrEmpty(item.sourceSegments),
      item.sourceToken?.sourceItem,
      item.sourceToken?.sourceSegment,
      ...arrayOrEmpty(item.sourceToken?.sourceItems),
      ...arrayOrEmpty(item.sourceToken?.sourceSegments),
      item.sourceToken?.pageNumber !== undefined ? item.sourceToken : undefined
    ].filter(Boolean)
  const wholeOnly = (item) =>
    !item.sourceSegment &&
    !item.sourceSegments &&
    !item.sourceItems &&
    !item.sourceToken?.sourceSegment &&
    !item.sourceToken?.sourceSegments &&
    !item.sourceToken?.sourceItems
  const claims = (cell) => [
    ...arrayOrEmpty(cell.sourceItems),
    ...arrayOrEmpty(cell.sourceSegments),
    ...arrayOrEmpty(cell.sourceTokens).flatMap(carriers)
  ]
  const overlaps = (a, b) =>
    a?.length === 4 &&
    b?.length === 4 &&
    Math.min(a[2], b[2]) > Math.max(a[0], b[0]) + 1e-6 &&
    Math.min(a[3], b[3]) > Math.max(a[1], b[1]) + 1e-6
  const origin = token.sourceItem
  if (
    !origin ||
    !Number.isSafeInteger(origin.pageNumber) ||
    origin.pageNumber < 1 ||
    !Number.isSafeInteger(origin.index) ||
    origin.index < 0 ||
    typeof origin.text !== 'string' ||
    token.text !== origin.text ||
    !token.horizontal ||
    !Number.isFinite(token.height) ||
    token.height <= 0 ||
    !sameRect(token.rect, token.rect) ||
    token.rect[2] <= token.rect[0] ||
    token.rect[3] <= token.rect[1] ||
    !wholeOnly(token) ||
    carriers(token).some((s) => !sameOrigin(s, origin))
  )
    return
  // Preserve the original numeric path, including its stricter gap rejection.
  if (
    token.text
      .trim()
      .split(/\s+/u)
      .every((piece) => /^[−+-]?(?:\d+(?:\.\d+)?|\.\d+)$/u.test(piece))
  )
    return
  const key = sourceKey(origin)
  const group = entries.filter((e) => claims(e.cell).some((s) => sourceKey(s) === key))
  if (group.length < 2) return
  // Existing carrier helpers certify at most one sourceToken layer. Unknown
  // deeper graphs must not hide a competitor, even outside table geometry.
  if (
    tokens.some((t) => t.sourceToken?.sourceToken !== undefined) ||
    entries.some((e) => e.cell.sourceTokens?.some((t) => t.sourceToken?.sourceToken !== undefined))
  )
    return
  if (
    tokens.filter((t) => carriers(t).some((s) => sourceKey(s) === key)).length !== 1 ||
    tokens.some((t) => t !== token && t.text?.trim() && overlaps(t.rect, token.rect))
  )
    return
  const runs = observations.filter((r) => r.text === token.text && sameRect(r.rect, token.rect))
  if (runs.length !== 1) return
  const run = runs[0],
    boundaries = new Set()
  if (
    !Array.isArray(run.literalGlyphs) ||
    !Array.isArray(run.glyphRuns) ||
    !Array.isArray(run.gaps) ||
    run.literalGlyphs.some((s) => typeof s !== 'string' || !s) ||
    run.glyphRuns.some((n) => !Number.isInteger(n) || n < 0)
  )
    return
  let offset = 0
  for (const literal of run.literalGlyphs) {
    offset += Array.from(literal).length
    boundaries.add(offset)
  }
  if (
    run.gaps.some(
      (gap, index) =>
        !gap ||
        !boundaries.has(gap.index) ||
        !Number.isFinite(gap.left) ||
        !Number.isFinite(gap.right) ||
        gap.left >= gap.right ||
        gap.left < token.rect[0] ||
        gap.right > token.rect[2] ||
        (index && (gap.index <= run.gaps[index - 1].index || gap.left <= run.gaps[index - 1].right))
    )
  )
    return
  const leaves = splitNativeMeasuredFields(token, runs, token.height)
  if (!leaves || leaves.length < 2) return
  const ranges = measuredSourceRanges(
    { str: token.text, sourceItem: origin },
    leaves.map((l) => l.text)
  )
  if (
    !ranges ||
    leaves.some(
      (leaf, index) =>
        !sameRect(leaf.rect, leaf.rect) ||
        !containsRect(token.rect, leaf.rect) ||
        leaf.rect[2] <= leaf.rect[0] ||
        Math.abs(leaf.rect[1] - token.rect[1]) > 1e-6 ||
        Math.abs(leaf.rect[3] - token.rect[3]) > 1e-6 ||
        (index > 0 && leaf.rect[0] < leaves[index - 1].rect[2] - 1e-6)
    ) ||
    Math.abs(leaves[0].rect[0] - token.rect[0]) > 1e-6 ||
    Math.abs(leaves.at(-1).rect[2] - token.rect[2]) > 1e-6
  )
    return
  if (group.length !== leaves.length) return
  group.sort((a, b) => a.cell.column - b.cell.column)
  const first = group[0],
    owner = first.table
  // A measured descriptor may already own a valid shared-row face. Preserve
  // that assignment only when every covered slot is empty and exclusively
  // owned, with one independent whole native descriptor on each peer row.
  // This certifies transport of existing leaves, never creates a new rowspan.
  const sharedDescriptor = (() => {
    const cell = first.cell
    if (
      group.length !== 2 ||
      cell.column !== 0 ||
      !Number.isSafeInteger(cell.rowSpan) ||
      cell.rowSpan < 2 ||
      cell.row + cell.rowSpan > (owner.grid?.length ?? 0) ||
      group[1].cell.rowSpan !== 1 ||
      leaves.some((l) => !/\p{L}/u.test(l.text)) ||
      !proveNativeUniqueWholeFonts([token], tokens) ||
      tokens.some((t) => t !== token && t.text?.trim() && overlaps(t.rect, cell.rect))
    )
      return false
    let bottom = token.rect[3]
    const peers = []
    for (let row = cell.row; row < cell.row + cell.rowSpan; row++) {
      const slot = entries.filter(
        (e) =>
          e.table === owner &&
          row >= e.cell.row &&
          row < e.cell.row + e.cell.rowSpan &&
          cell.column >= e.cell.column &&
          cell.column < e.cell.column + e.cell.colSpan
      )
      if (slot.length !== 1 || slot[0] !== first) return false
      if (row === cell.row) continue
      if (owner.grid[row]?.[cell.column] !== '') return false
      const adjacent = entries.filter(
        (e) =>
          e.table === owner &&
          row >= e.cell.row &&
          row < e.cell.row + e.cell.rowSpan &&
          cell.column + 1 >= e.cell.column &&
          cell.column + 1 < e.cell.column + e.cell.colSpan
      )
      if (adjacent.length !== 1) return false
      const peer = adjacent[0].cell,
        origin = peer.sourceItems?.[0],
        fonts = origin ? tokens.filter((t) => t.sourceItem && sameOrigin(t.sourceItem, origin)) : []
      const font = fonts[0]
      if (
        peer.row !== row ||
        peer.column !== cell.column + 1 ||
        peer.rowSpan !== 1 ||
        peer.colSpan !== 1 ||
        peer.sourceItems?.length !== 1 ||
        peer.sourceSegments ||
        peer.sourceTokens?.length !== 1 ||
        peer.sourceRects?.length !== 1 ||
        fonts.length !== 1 ||
        !wholeOnly(peer.sourceTokens[0]) ||
        carriers(peer.sourceTokens[0]).some((s) => !sameOrigin(s, origin)) ||
        !/\p{L}/u.test(peer.text) ||
        peer.text !== font.text ||
        owner.grid[row][peer.column] !== peer.text ||
        !plainRunsAgree(peer) ||
        !sameRect(peer.sourceRects[0], font.rect) ||
        peer.sourceTokens[0].text !== font.text ||
        !sameRect(peer.sourceTokens[0].rect, font.rect) ||
        !sameRect(peer.rect, peer.rect) ||
        font.rect[0] < peer.rect[0] ||
        font.rect[2] > peer.rect[2] ||
        font.baseline < peer.rect[1] ||
        font.baseline > peer.rect[3] ||
        font.rect[1] < bottom ||
        font.rect[3] > cell.rect[3] ||
        entries.some(
          (e) => e !== adjacent[0] && claims(e.cell).some((s) => sourceKey(s) === sourceKey(origin))
        )
      )
        return false
      peers.push(font)
      bottom = font.rect[3]
    }
    return proveNativeUniqueWholeFonts(peers, tokens)
  })()
  const plans = []
  if (
    group.some(({ cell, table }, index) => {
      const leaf = leaves[index],
        assigned = cell.sourceTokens?.filter(
          (t) => t.text === leaf.text && sameRect(t.rect, leaf.rect)
        )
      return (
        table !== owner ||
        !Number.isSafeInteger(cell.row) ||
        cell.row < 0 ||
        !Number.isSafeInteger(cell.column) ||
        cell.column < 0 ||
        cell.row !== first.cell.row ||
        (cell.rowSpan !== 1 && !(index === 0 && sharedDescriptor)) ||
        cell.colSpan !== 1 ||
        cell.column !== first.cell.column + index ||
        owner.grid?.[cell.row]?.[cell.column] !== cell.text ||
        !plainRunsAgree(cell) ||
        cell.sourceSegments ||
        !cell.sourceItems?.length ||
        cell.sourceItems.length !== cell.sourceRects?.length ||
        cell.sourceItems.length !== cell.sourceTokens?.length ||
        new Set(cell.sourceItems.map(sourceKey)).size !== cell.sourceItems.length ||
        cell.sourceItems.filter((s) => sameOrigin(s, origin)).length !== 1 ||
        assigned?.length !== 1 ||
        !wholeOnly(assigned[0]) ||
        carriers(assigned[0]).some((s) => !sameOrigin(s, origin)) ||
        cell.sourceRects.filter((r) => sameRect(r, leaf.rect)).length !== 1 ||
        cell.sourceTokens
          .map((t) => t.text)
          .join('')
          .replace(/\s/gu, '') !== cell.text.replace(/\s/gu, '') ||
        !containsRect(cell.rect, leaf.rect) ||
        entries.filter(
          (e) =>
            e.table === owner &&
            cell.row >= e.cell.row &&
            cell.row < e.cell.row + e.cell.rowSpan &&
            cell.column >= e.cell.column &&
            cell.column < e.cell.column + e.cell.colSpan
        ).length !== 1
      )
    })
  )
    return
  // A split parent can be only one contribution to a cell (for example the
  // final unit letter beside separate native value/symbol items). Certify the
  // other whole contributions too before replacing the cell's declaration.
  // Existing segmented cells remain untouched; this path must never overwrite
  // an unrelated range or turn a range back into a whole-source claim.
  for (const [index, { cell }] of group.entries()) {
    const leaf = leaves[index],
      segments = []
    for (const rect of cell.sourceRects) {
      const assigned = cell.sourceTokens.filter((t) => sameRect(t.rect, rect))
      if (assigned.length !== 1 || !wholeOnly(assigned[0]) || !containsRect(cell.rect, rect)) return
      if (sameRect(rect, leaf.rect)) {
        segments.push({ ...ranges[index], rect: [...rect] })
        continue
      }
      const found = tokens.filter((t) => sameRect(t.rect, rect) && t.text === assigned[0].text)
      if (found.length !== 1) return
      const native = found[0],
        source = native.sourceItem
      if (
        !source ||
        !Number.isSafeInteger(source.pageNumber) ||
        source.pageNumber < 1 ||
        !Number.isSafeInteger(source.index) ||
        source.index < 0 ||
        typeof source.text !== 'string' ||
        !source.text.trim() ||
        source.text !== native.text ||
        !native.horizontal ||
        rect[2] <= rect[0] ||
        rect[3] <= rect[1] ||
        !wholeOnly(native) ||
        carriers(native).some((s) => !sameOrigin(s, source)) ||
        carriers(assigned[0]).some((s) => !sameOrigin(s, source)) ||
        cell.sourceItems.filter((s) => sameOrigin(s, source)).length !== 1 ||
        tokens.filter((t) => carriers(t).some((s) => sourceKey(s) === sourceKey(source))).length !==
          1 ||
        entries.some(
          (e) =>
            e.cell !== cell &&
            (claims(e.cell).some((s) => sourceKey(s) === sourceKey(source)) ||
              e.cell.sourceRects?.some((r) => overlaps(r, rect)))
        ) ||
        cell.sourceRects.some((r) => r !== rect && overlaps(r, rect)) ||
        tokens.some((t) => t !== native && t.text?.trim() && overlaps(t.rect, rect))
      )
        return
      segments.push({ ...source, start: 0, end: source.text.length, rect: [...rect] })
    }
    if (cell.sourceItems.some((s) => !segments.some((part) => sameOrigin(s, part)))) return
    plans.push({
      cell,
      segments: segments.sort(
        (a, b) => a.pageNumber - b.pageNumber || a.index - b.index || a.start - b.start
      )
    })
  }
  if (
    entries.some(
      (e) =>
        !group.includes(e) &&
        (claims(e.cell).some((s) => sourceKey(s) === key) ||
          e.cell.sourceRects?.some((r) => overlaps(r, token.rect)))
    )
  )
    return
  return plans
}

// Refine an existing, complete assignment. Numeric clips may shrink within
// native gaps; textual leaves require exact extents or independent native columns.
// Text and cell owners never change.
export function refineMeasuredAssignedNumericSegments(table, tokens, observations) {
  const entries = tableCells(table)
  for (const token of tokens) {
    const exact = exactMeasuredParentPlan(entries, tokens, observations, token)
    if (exact) {
      for (const { cell, segments } of exact) {
        cell.sourceSegments = segments
        delete cell.sourceItems
      }
      continue
    }
    const origin = token.sourceItem
    if (!origin || token.sourceSegment || !token.horizontal || token.text !== origin.text) continue
    const pieces = token.text.trim().split(/\s+/u),
      numeric = pieces.every((piece) => /^[−+-]?(?:\d+(?:\.\d+)?|\.\d+)$/u.test(piece))
    if (pieces.length < 2) continue
    if (
      tokens.filter(
        (other) => other.sourceItem && sourceKey(other.sourceItem) === sourceKey(origin)
      ).length !== 1 ||
      tokens.filter((other) => other.text === token.text && sameRect(other.rect, token.rect))
        .length !== 1 ||
      tokens.some(
        (other) => other.sourceSegment && sourceKey(other.sourceSegment) === sourceKey(origin)
      )
    )
      continue
    const group = entries.filter(({ cell }) =>
      cell.sourceItems?.some((item) => sourceKey(item) === sourceKey(origin))
    )
    if (
      group.length !== pieces.length ||
      entries.some(({ cell }) =>
        cell.sourceSegments?.some((item) => sourceKey(item) === sourceKey(origin))
      )
    )
      continue
    group.sort((a, b) => a.cell.column - b.cell.column)
    const first = group[0]
    if (
      group.some(
        ({ cell, table: owner }, index) =>
          owner !== first.table ||
          cell.row !== first.cell.row ||
          cell.rowSpan !== 1 ||
          cell.colSpan !== 1 ||
          cell.column !== first.cell.column + index ||
          cell.text !== pieces[index] ||
          (owner.grid && owner.grid[cell.row]?.[cell.column] !== cell.text) ||
          cell.sourceSegments ||
          cell.sourceItems?.length !== 1 ||
          !sameOrigin(cell.sourceItems[0], origin) ||
          cell.sourceRects?.length !== 1 ||
          cell.sourceTokens?.length !== 1 ||
          cell.sourceTokens[0].text !== pieces[index] ||
          !sameRect(cell.sourceRects[0], cell.sourceTokens[0].rect) ||
          cell.sourceTokens[0].sourceSegment ||
          [cell.sourceTokens[0].sourceItem, cell.sourceTokens[0].sourceToken].some(
            (item) => item && !sameOrigin(item, origin)
          )
      )
    )
      continue
    const rects = group.map(({ cell }) => cell.sourceRects[0]),
      parent = token.rect
    if (
      rects.some(
        (rect, index) =>
          Math.abs(rect[1] - parent[1]) > 1e-6 ||
          Math.abs(rect[3] - parent[3]) > 1e-6 ||
          (index ? rect[0] < rects[index - 1][2] - 1e-6 : Math.abs(rect[0] - parent[0]) > 1e-6) ||
          !(rect[2] > rect[0])
      ) ||
      Math.abs(rects.at(-1)[2] - parent[2]) > 1e-6
    )
      continue
    if (
      entries.some(
        (entry) =>
          !group.includes(entry) &&
          (entry.cell.sourceTokens?.some((source) =>
            [source.sourceItem, source.sourceToken, source.sourceSegment].some(
              (item) => item && sourceKey(item) === sourceKey(origin)
            )
          ) ||
            entry.cell.sourceRects?.some(
              (rect) =>
                Math.min(rect[2], parent[2]) > Math.max(rect[0], parent[0]) + 1e-6 &&
                Math.min(rect[3], parent[3]) > Math.max(rect[1], parent[1]) + 1e-6
            ))
      )
    )
      continue
    const runs = observations.filter((run) => run.text === token.text && sameRect(run.rect, parent))
    if (runs.length !== 1 || runs[0].gaps.length !== pieces.length - 1) continue
    const gaps = runs[0].gaps,
      ranges = measuredSourceRanges({ str: token.text, sourceItem: origin }, pieces)
    let count = 0
    if (
      !ranges ||
      gaps.some((gap, index) => {
        count += Array.from(pieces[index]).length
        return (
          gap.index !== count ||
          !Number.isFinite(gap.left) ||
          !Number.isFinite(gap.right) ||
          gap.left > rects[index][2] ||
          gap.right < rects[index][2] ||
          gap.left > rects[index + 1][0] ||
          gap.right < rects[index + 1][0] ||
          gap.left >= gap.right
        )
      })
    )
      continue
    const measured = pieces.map((_, index) => [
      index ? gaps[index - 1].right : parent[0],
      parent[1],
      index < gaps.length ? gaps[index].left : parent[2],
      parent[3]
    ])
    const mixedColumns =
      !numeric &&
      hasIndependentMixedColumns(entries, group, tokens, runs[0], measured, origin, pieces)
    if (
      measured.some(
        (rect, index) =>
          rect[0] < rects[index][0] - 1e-6 ||
          rect[2] > rects[index][2] + 1e-6 ||
          rect[2] <= rect[0] ||
          (!numeric && !mixedColumns && !sameRect(rect, rects[index]))
      )
    )
      continue
    for (const [index, { cell }] of group.entries()) {
      cell.sourceRects = [measured[index]]
      cell.sourceTokens = [{ ...cell.sourceTokens[0], rect: [...measured[index]] }]
      cell.sourceSegments = [{ ...ranges[index], rect: [...measured[index]] }]
      delete cell.sourceItems
    }
  }
}

// Final assembly can replace or regroup tokens. Issue evidence only when every
// surviving source region still has exactly one unchanged native token owner.
export function attachMeasuredTableSourceSegments(table, tokens) {
  if (!tokens.some((token) => token.sourceSegment)) return
  const cells = tableCells(table).map(({ cell }) => cell)
  const regions = cells.flatMap((cell) => arrayOrEmpty(cell.sourceRects))
  const plans = cells.map((cell) => {
    if (
      cell.sourceSegments ||
      !cell.sourceRects?.length ||
      cell.sourceTokens?.length !== cell.sourceRects.length
    )
      return undefined
    let measured = false
    const segments = []
    for (const rect of cell.sourceRects) {
      if (regions.filter((other) => sameRect(rect, other)).length !== 1) return undefined
      const owned = cell.sourceTokens.filter((token) => sameRect(rect, token.rect))
      if (owned.length !== 1) return undefined
      const native = tokens.filter(
        (token) => token.text === owned[0].text && sameRect(rect, token.rect)
      )
      if (native.length !== 1) return undefined
      const token = native[0],
        origin = token.sourceSegment ?? token.sourceItem
      if (!origin || typeof origin.text !== 'string') return undefined
      const segment = token.sourceSegment ?? { ...origin, start: 0, end: origin.text.length, rect }
      const previous = owned[0]
      if (
        [previous.sourceItem, previous.sourceToken, token.sourceItem].some(
          (item) => item && !sameOrigin(item, origin)
        ) ||
        (previous.sourceSegment &&
          (!sameOrigin(previous.sourceSegment, origin) ||
            previous.sourceSegment.start !== segment.start ||
            previous.sourceSegment.end !== segment.end ||
            !sameRect(previous.sourceSegment.rect, segment.rect)))
      )
        return undefined
      if (
        !Number.isSafeInteger(segment.start) ||
        !Number.isSafeInteger(segment.end) ||
        segment.start < 0 ||
        segment.end <= segment.start ||
        segment.end > origin.text.length ||
        origin.text.slice(segment.start, segment.end) !== token.text ||
        !sameRect(segment.rect, rect)
      )
        return undefined
      measured ||= !!token.sourceSegment
      segments.push({ ...segment, rect: [...rect] })
    }
    if (
      cell.sourceItems?.some((origin) => !segments.some((segment) => sameOrigin(segment, origin)))
    )
      return undefined
    return { cell, measured, segments }
  })
  const claims = plans.flatMap(
    (plan) => plan?.segments.map((segment) => ({ cell: plan.cell, segment })) ?? []
  )
  // A retained whole-item owner elsewhere also competes with every child range.
  for (const cell of cells)
    for (const segment of arrayOrEmpty(cell.sourceSegments)) claims.push({ cell, segment })
  for (const cell of cells) {
    if (plans.some((plan) => plan?.cell === cell)) continue
    for (const origin of [
      ...arrayOrEmpty(cell.sourceItems),
      ...arrayOrEmpty(cell.sourceTokens).flatMap((token) =>
        [token.sourceItem, token.sourceToken].filter(Boolean)
      )
    ])
      claims.push({ cell, segment: { ...origin, start: 0, end: origin.text.length } })
    for (const token of arrayOrEmpty(cell.sourceTokens))
      if (token.sourceSegment) claims.push({ cell, segment: token.sourceSegment })
  }
  for (const plan of plans) {
    if (!plan?.measured) continue
    if (
      plan.segments.some((segment) =>
        claims.some(
          (claim) =>
            claim.segment !== segment &&
            sourceKey(claim.segment) === sourceKey(segment) &&
            (claim.segment.text !== segment.text ||
              Math.min(claim.segment.end, segment.end) >
                Math.max(claim.segment.start, segment.start))
        )
      )
    )
      continue
    plan.cell.sourceSegments = plan.segments.sort(
      (a, b) => a.pageNumber - b.pageNumber || a.index - b.index || a.start - b.start
    )
    delete plan.cell.sourceItems
  }
}

// Run after the strict measured-segment assembly and all table repairs. A model
// can subdivide one ordinary literal geometrically while copying its whole
// origin into every child. Failure to prove segments is not whole ownership.
// This final negative review grants no new segment, column or Source rights.
export function withdrawUnprovedPartialWholeSources(table, tokens) {
  if (!Array.isArray(tokens)) return
  const entries = tableCells(table),
    fonts = new Map(),
    claims = new Map()
  const rect = (r) =>
    Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3]
  const word = (s) =>
    typeof s === 'string' &&
    /^[\p{L}\p{M}]+(?:[-'’][\p{L}\p{M}]+)*$/u.test(s) &&
    [...s].filter((c) => /\p{L}/u.test(c)).length >= 2
  for (const token of tokens) {
    const o = token.sourceItem
    if (
      !o ||
      !Number.isSafeInteger(o.pageNumber) ||
      o.pageNumber < 1 ||
      !Number.isSafeInteger(o.index) ||
      o.index < 0
    )
      continue
    const k = sourceKey(o)
    if (!fonts.has(k)) fonts.set(k, [])
    fonts.get(k).push(token)
  }
  for (const entry of entries)
    for (const origin of arrayOrEmpty(entry.cell.sourceItems)) {
      const key = sourceKey(origin)
      if (!claims.has(key)) claims.set(key, [])
      if (!claims.get(key).includes(entry)) claims.get(key).push(entry)
    }
  for (const [key, group] of claims) {
    if (group.length < 2 || group.length > 8) continue
    const originals = fonts.get(key)
    if (originals?.length !== 1) continue
    const font = originals[0],
      origin = font.sourceItem
    if (
      font.sourceSegment ||
      font.sourceSegments ||
      font.inlineSymbol ||
      typeof origin.text !== 'string' ||
      !origin.text.trim() ||
      font.text !== origin.text ||
      !font.horizontal ||
      !rect(font.rect) ||
      !Number.isFinite(font.height) ||
      font.height <= 0 ||
      !Number.isFinite(font.baseline)
    )
      continue
    if (
      tokens.some(
        (t) =>
          sourceCarriers(t).some((o) => sourceKey(o) === key) &&
          (t.sourceSegment || t.sourceToken?.sourceSegment)
      ) ||
      entries.some(
        (entry) =>
          cellOrigins(entry.cell).some((o) => sourceKey(o) === key) && !group.includes(entry)
      )
    )
      continue
    group.sort((a, b) => a.cell.column - b.cell.column)
    const first = group[0],
      owner = first.table,
      pieces = group.map(({ cell }) => cell.text),
      ranges = measuredSourceRanges({ str: font.text, sourceItem: origin }, pieces)
    // Literal coverage below only identifies the unsupported parent. It is
    // deliberately not a measuredSourceRanges -> SourceSegments signing path.
    if (
      !ranges ||
      !pieces.every(word) ||
      !Array.isArray(owner.unassigned) ||
      !owner.unassigned.every((s) => typeof s === 'string') ||
      (owner.issues !== undefined &&
        (!Array.isArray(owner.issues) || !owner.issues.every((s) => typeof s === 'string')))
    )
      continue
    const partial = group.every(({ cell, table: item }, index) => {
      const token = cell.sourceTokens?.[0],
        box = cell.sourceRects?.[0]
      return (
        item === owner &&
        Number.isSafeInteger(cell.row) &&
        cell.row >= 0 &&
        cell.row === first.cell.row &&
        cell.rowSpan === 1 &&
        cell.colSpan === 1 &&
        cell.column === first.cell.column + index &&
        !cell.textRuns &&
        !cell.sourceSegments &&
        cell.sourceItems?.length === 1 &&
        sameOrigin(cell.sourceItems[0], origin) &&
        owner.grid?.[cell.row]?.[cell.column] === cell.text &&
        cell.sourceRects?.length === 1 &&
        cell.sourceTokens?.length === 1 &&
        rect(box) &&
        containsRect(font.rect, box) &&
        !sameRect(font.rect, box) &&
        Math.abs(box[1] - font.rect[1]) < 1e-6 &&
        Math.abs(box[3] - font.rect[3]) < 1e-6 &&
        token?.text === cell.text &&
        sameRect(token.rect, box) &&
        Number.isFinite(token.baseline) &&
        Number.isFinite(token.height) &&
        !token.inlineSymbol &&
        !token.sourceSegment &&
        !token.sourceSegments &&
        !token.sourceItems &&
        !token.sourceToken?.sourceToken &&
        sourceCarriers(token).every((o) => sameOrigin(o, origin)) &&
        (index === 0
          ? Math.abs(box[0] - font.rect[0]) < 1e-6
          : Math.abs(box[0] - group[index - 1].cell.sourceRects[0][2]) < 1e-6) &&
        (index !== group.length - 1 || Math.abs(box[2] - font.rect[2]) < 1e-6)
      )
    })
    if (!partial) continue
    // Keep every original occurrence, even when several distinct fonts print
    // identical words. A second review is inert because these whole claims and
    // all sourceToken carrier paths have already been removed.
    owner.unassigned.push(origin.text)
    owner.issues = [
      ...new Set([
        ...(owner.issues ?? []),
        'unassigned-source-text',
        'native-table-structure-ambiguous'
      ])
    ]
    owner.reviewCandidate = false
    for (const { cell } of group) {
      delete cell.sourceItems
      cell.sourceTokens = cell.sourceTokens.map(({ text, rect, baseline, height }) => ({
        text,
        rect,
        baseline,
        height
      }))
    }
  }
}
