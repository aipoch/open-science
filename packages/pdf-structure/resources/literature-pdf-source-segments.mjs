/* eslint-disable @typescript-eslint/explicit-function-return-type */
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

// Refine an existing, complete numeric assignment only. Native measured gaps
// must contain every old clip boundary; text and cell owners never change.
export function refineMeasuredAssignedNumericSegments(table, tokens, observations) {
  const entries = tableCells(table)
  for (const token of tokens) {
    const origin = token.sourceItem
    if (!origin || token.sourceSegment || !token.horizontal || token.text !== origin.text) continue
    const pieces = token.text.trim().split(/\s+/u)
    if (
      pieces.length < 2 ||
      pieces.some((piece) => !/^[−+-]?(?:\d+(?:\.\d+)?|\.\d+)$/u.test(piece))
    )
      continue
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
          Math.abs(rect[0] - (index ? rects[index - 1][2] : parent[0])) > 1e-6 ||
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
    if (
      measured.some(
        (rect, index) =>
          rect[0] < rects[index][0] - 1e-6 || rect[2] > rects[index][2] + 1e-6 || rect[2] <= rect[0]
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
