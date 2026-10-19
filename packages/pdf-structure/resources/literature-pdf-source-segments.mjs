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
const tableCells = (table) => [
  ...(table.cells ?? []).map((cell) => ({ cell, table })),
  ...(table.parts ?? []).flatMap(tableCells)
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
  ...(cell.sourceItems ?? []),
  ...(cell.sourceSegments ?? []),
  ...(cell.sourceTokens ?? []).flatMap(sourceCarriers)
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
      ...(item.sourceItems ?? []),
      ...(item.sourceSegments ?? []),
      item.sourceToken?.sourceItem,
      item.sourceToken?.sourceSegment,
      ...(item.sourceToken?.sourceItems ?? []),
      ...(item.sourceToken?.sourceSegments ?? []),
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
    ...(cell.sourceItems ?? []),
    ...(cell.sourceSegments ?? []),
    ...(cell.sourceTokens ?? []).flatMap(carriers)
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
  const leaves = splitNativeMeasuredFields(token, observations, token.height)
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
  if (
    group.some(({ cell, table }, index) => {
      const assigned = cell.sourceTokens?.[0],
        leaf = leaves[index]
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
        cell.text !== leaf.text ||
        owner.grid?.[cell.row]?.[cell.column] !== cell.text ||
        !plainRunsAgree(cell) ||
        cell.sourceSegments ||
        cell.sourceItems?.length !== 1 ||
        !sameOrigin(cell.sourceItems[0], origin) ||
        cell.sourceRects?.length !== 1 ||
        cell.sourceTokens?.length !== 1 ||
        !assigned ||
        !wholeOnly(assigned) ||
        carriers(assigned).some((s) => !sameOrigin(s, origin)) ||
        assigned.text !== leaf.text ||
        !sameRect(cell.sourceRects[0], leaf.rect) ||
        !sameRect(assigned.rect, leaf.rect) ||
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
  if (
    entries.some(
      (e) =>
        !group.includes(e) &&
        (claims(e.cell).some((s) => sourceKey(s) === key) ||
          e.cell.sourceRects?.some((r) => overlaps(r, token.rect)))
    )
  )
    return
  return group.map(({ cell }, index) => ({
    cell,
    segment: { ...ranges[index], rect: [...leaves[index].rect] }
  }))
}

// Refine an existing, complete assignment. Numeric clips may shrink within
// native gaps; textual leaves require exact extents or independent native columns.
// Text and cell owners never change.
export function refineMeasuredAssignedNumericSegments(table, tokens, observations) {
  const entries = tableCells(table)
  for (const token of tokens) {
    const exact = exactMeasuredParentPlan(entries, tokens, observations, token)
    if (exact) {
      for (const { cell, segment } of exact) {
        cell.sourceSegments = [segment]
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
  const regions = cells.flatMap((cell) => cell.sourceRects ?? [])
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
    for (const segment of cell.sourceSegments ?? []) claims.push({ cell, segment })
  for (const cell of cells) {
    if (plans.some((plan) => plan?.cell === cell)) continue
    for (const origin of [
      ...(cell.sourceItems ?? []),
      ...(cell.sourceTokens ?? []).flatMap((token) =>
        [token.sourceItem, token.sourceToken].filter(Boolean)
      )
    ])
      claims.push({ cell, segment: { ...origin, start: 0, end: origin.text.length } })
    for (const token of cell.sourceTokens ?? [])
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
