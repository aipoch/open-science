/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { inside, union, isAdjacentTableScript } from './literature-pdf-table-geometry.mjs'
import {
  joinHorizontalTableRules,
  clusterTableRulePositions,
  classifyTableRuleEdge
} from './literature-pdf-table-rules.mjs'

// Record recognizers share strict source containment, while each recognizer
// retains its own anchors, row tolerances and statistical expressions.
export function tableSourceItems(items, [left, top, right, bottom]) {
  return items
    .filter(
      (i) =>
        i.horizontal &&
        i.rect[0] >= left &&
        i.rect[2] <= right &&
        i.rect[1] >= top &&
        i.rect[3] <= bottom
    )
    .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
}

// Compact strings are for recognition only. Never write them back to source
// tokens or use them as replacement text in the exported table.
export function readSourceRow(items, cuts, { multiline = false } = {}) {
  if (
    cuts.length < 2 ||
    cuts.some((x, n) => !Number.isFinite(x) || (n > 0 && x <= cuts[n - 1])) ||
    new Set(items).size !== items.length
  )
    return
  const cells = cuts.slice(1).map(() => [])
  for (const item of items) {
    const [left, , right] = item.rect
    if (!Number.isFinite(left) || !Number.isFinite(right) || right <= left) return
    const column = cuts.slice(1).findIndex((x) => (left + right) / 2 < x)
    if (column < 0 || left < cuts[column] || right > cuts[column + 1]) return
    cells[column].push(item)
  }
  return cells.map((cell) =>
    cell
      .sort((a, b) =>
        multiline && Math.abs(a.baseline - b.baseline) > Math.min(a.height, b.height) * 0.35
          ? a.baseline - b.baseline
          : a.rect[0] - b.rect[0]
      )
      .map((item) => item.text)
      .join('')
      .replace(/\s/g, '')
  )
}

// A token may not disappear or be claimed twice when nearby anchors produce
// overlapping record groups. Repeated values at different positions are valid.
export function hasUniqueRecordTokens(items, groups) {
  const remaining = new Set(items)
  if (remaining.size !== items.length) return false
  for (const group of groups) {
    if (!group.length) return false
    for (const item of group) if (!remaining.delete(item)) return false
  }
  return remaining.size === 0
}

// Source is already in baseline order. Callers choose their row tolerance;
// small scripts must have exactly one row owner instead of creating a new row.
export function groupSourceRowsWithScripts(source, height, tolerance) {
  if (!(height > 0) || !(tolerance > 0)) return
  const groups = []
  const scripts = new Set(
    source.filter(
      (i) =>
        i.height < height * 0.8 ||
        (/^[a-z](?:,[a-z])*$/.test(i.text) && source.some((a) => isAdjacentTableScript(i, a)))
    )
  )
  for (const item of source.filter((i) => !scripts.has(i))) {
    const last = groups.at(-1)
    if (last && Math.abs(item.baseline - last[0].baseline) < height * tolerance) last.push(item)
    else groups.push([item])
  }
  for (const item of source.filter((i) => scripts.has(i))) {
    const owners = groups.filter((group) =>
      group.some(
        (i) =>
          isAdjacentTableScript(item, i) ||
          // A signed exponent may be split into a raised sign and raised digits.
          // Extend only an already attached script along its own tight baseline.
          (scripts.has(i) &&
            Math.abs(item.baseline - i.baseline) < Math.min(item.height, i.height) * 0.15 &&
            item.rect[0] - i.rect[2] >= -i.height * 0.1 &&
            item.rect[0] - i.rect[2] <= i.height * 0.35)
      )
    )
    if (owners.length !== 1) return
    owners[0].push(item)
  }
  return hasUniqueRecordTokens(source, groups) ? groups : undefined
}

// Native group underlines partition a wrapped parent title from its children.
// Single-column headers occupy both bands; every glyph must have one owner.
export function recoverRuledHeaderBands(source, cuts, rules, top, bottom) {
  const hierarchy = recoverNativeHeaderHierarchy(source, cuts, rules, top, bottom)
  if (hierarchy) return hierarchy
  const left = cuts[0],
    right = cuts.at(-1),
    height = Math.max(...source.map((i) => i.height))
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const parents = joinHorizontalTableRules(rules)
    // Touching underlines can belong to different parents when a native
    // vertical border divides the upper tier. Leaf dividers start below it.
    .flatMap((r) => {
      const xs = [
        ...new Set(
          rules
            .filter(
              (v) =>
                v[0] === v[2] &&
                v[0] > r[0] + 1 &&
                v[0] < r[2] - 1 &&
                v[1] <= top + 1 &&
                v[3] >= r[1] - 1
            )
            .map((v) => v[0])
        )
      ].sort((a, b) => a - b)
      return [r[0], ...xs].map((x, n) => [x, r[1], xs[n] ?? r[2], r[3]])
    })
    .filter(
      (r) => r[1] === r[3] && r[1] > top && r[1] < bottom && r[2] - r[0] < (right - left) * 0.85
    )
    .flatMap((r) => {
      const above = source.filter(
        (i) =>
          i.rect[3] <= r[1] + height * 0.1 &&
          ((i.rect[0] >= r[0] - 1 && i.rect[2] <= r[2] + 1) ||
            // A centered heading can slightly overhang its own underline.
            // Keep the tolerance font-relative and require the same center;
            // nearby text still cannot borrow another group's rule.
            (i.rect[0] >= r[0] - height * 0.2 &&
              i.rect[2] <= r[2] + height * 0.2 &&
              Math.abs((i.rect[0] + i.rect[2] - r[0] - r[2]) / 2) < height * 0.5))
      )
      const below = source.filter(
        (i) => (i.rect[1] + i.rect[3]) / 2 > r[1] && i.rect[0] >= r[0] - 1 && i.rect[2] <= r[2] + 1
      )
      const columns = [...new Set(below.map(col))].sort((a, b) => a - b)
      if (
        !above.length ||
        columns.length < 1 ||
        columns.some((c, n) => n && c !== columns[n - 1] + 1) ||
        above.some((i) => !columns.includes(col(i)))
      )
        return []
      return [{ rule: r, above, column: columns[0], colSpan: columns.length }]
    })
    .sort((a, b) => a.column - b.column)
  if (!parents.length) return { rows: [[left, top, right, bottom]], spans: [] }
  if (parents.some((p, n) => n && p.column < parents[n - 1].column + parents[n - 1].colSpan)) return
  let split = parents[0].rule[1]
  if (parents.some((p) => Math.abs(p.rule[1] - split) > height * 0.2)) {
    // Sibling underlines may be staggered without introducing another tier.
    // Use their shared glyph-free gap only when every parent and child agrees;
    // an underline alone must not move text across a logical row boundary.
    const upper = parents.flatMap((p) => p.above)
    const lower = source.filter((i) => !upper.includes(i))
    const upperBottom = Math.max(...upper.map((i) => i.rect[3]))
    const lowerTop = Math.min(...lower.map((i) => i.rect[1]))
    const ys = parents.map((p) => p.rule[1])
    if (
      parents.length < 2 ||
      parents.some((p) => p.colSpan < 2) ||
      Math.max(...ys) - Math.min(...ys) > height ||
      !lower.length ||
      lowerTop <= upperBottom ||
      lowerTop - upperBottom > height ||
      parents.some((p) =>
        lower.some(
          (i) => col(i) >= p.column && col(i) < p.column + p.colSpan && i.rect[1] <= p.rule[1]
        )
      )
    )
      return
    split = (upperBottom + lowerTop) / 2
  }
  const rows = [
    [left, top, right, split],
    [left, split, right, bottom]
  ]
  const spans = parents.map((p) => ({ row: 0, column: p.column, rowSpan: 1, colSpan: p.colSpan }))
  const vertical = rules.filter((r) => r[0] === r[2])
  const horizontal = rules.filter((r) => r[1] === r[3])
  const borders = clusterTableRulePositions(vertical.map((r) => r[0])).filter(
    (x) => classifyTableRuleEdge(vertical, 0, x, top, bottom) === 1
  )
  const enclosedAcrossTiers = (c) => {
    // Glyph centers do not identify a merged header's row: a centered title
    // can sit below the parent underline. Require a uniquely enclosed native
    // cell and no internal stroke, including partial strokes, before merging.
    const sides = [cuts[c], cuts[c + 1]].map((cut) =>
      borders.filter((x) => Math.abs(x - cut) < height)
    )
    if (sides.some((xs) => xs.length !== 1)) return false
    const [start, end] = sides.map((xs) => xs[0])
    const own = source.filter((i) => col(i) === c)
    return (
      start < end &&
      own.length > 0 &&
      own.every((i) => i.rect[0] >= start && i.rect[2] <= end) &&
      [top, bottom].every((y) => classifyTableRuleEdge(horizontal, 1, y, start, end) === 1) &&
      classifyTableRuleEdge(horizontal, 1, split, start + 1, end - 1) === 0
    )
  }
  for (let c = 0; c < cuts.length - 1; c++)
    if (
      !parents.some((p) => c >= p.column && c < p.column + p.colSpan) &&
      (source.some((i) => col(i) === c && (i.rect[1] + i.rect[3]) / 2 < split) ||
        enclosedAcrossTiers(c)) &&
      !source.some(
        (i) =>
          col(i) === c &&
          i.rect[1] > split &&
          /^[\p{L}]$/u.test(i.text) &&
          source.filter(
            (other) =>
              col(other) !== c &&
              other.text === i.text &&
              Math.abs(other.baseline - i.baseline) < height * 0.2
          ).length >= 2
      )
    )
      spans.push({ row: 0, column: c, rowSpan: 2, colSpan: 1 })
  const owners = []
  for (const p of parents) {
    owners.push(p.above)
    for (let c = p.column; c < p.column + p.colSpan; c++)
      owners.push(
        source.filter(
          (i) => col(i) === c && !p.above.includes(i) && (i.rect[1] + i.rect[3]) / 2 > split
        )
      )
  }
  for (let c = 0; c < cuts.length - 1; c++)
    if (!parents.some((p) => c >= p.column && c < p.column + p.colSpan))
      owners.push(source.filter((i) => col(i) === c))
  if (
    !hasUniqueRecordTokens(
      source,
      owners.filter((g) => g.length)
    )
  )
    return
  return { rows, spans }
}

// Multiple native underline tiers (or separated, left-aligned parent bands)
// describe a tree over leaf columns. Construct that tree before consulting
// overlapping model spans; each source token must have exactly one owner.
export function recoverNativeHeaderHierarchy(source, cuts, rules, top, bottom) {
  if (!source.length || cuts.length < 3) return
  const height = Math.max(...source.map((i) => i.height))
  const left = cuts[0],
    right = cuts.at(-1)
  // Per-cell drawing commands can leave subpixel joins in one underline.
  // Use the same bounded stroke tolerance as native edge classification.
  const lines = joinHorizontalTableRules(rules, Math.min(1, height * 0.05)).filter(
    (r) =>
      r[1] > top &&
      r[1] < bottom &&
      r[2] - r[0] < (right - left) * 0.9 &&
      source.some(
        (i) => i.rect[3] <= r[1] + height * 0.1 && i.rect[0] >= r[0] - 1 && i.rect[2] <= r[2] + 1
      ) &&
      source.some(
        (i) =>
          i.rect[1] >= r[1] - height * 0.05 &&
          (i.rect[1] + i.rect[3]) / 2 > r[1] &&
          i.rect[0] >= r[0] - 1 &&
          i.rect[2] <= r[2] + 1
      )
  )
  let splits = [...new Set(lines.map((r) => r[1]))].sort((a, b) => a - b)
  splits = splits.filter((y, n) => !n || y - splits[n - 1] > height * 0.2)
  if (!splits.length) {
    const baselines = [
      ...new Set(source.filter((i) => i.height > height * 0.85).map((i) => i.baseline))
    ].sort((a, b) => a - b)
    for (let n = 1; n < baselines.length; n++)
      if (baselines[n] - baselines[n - 1] > height * 1.65)
        splits.push((baselines[n] - height + baselines[n - 1]) / 2)
    // Whitespace alone needs at least two parent levels and a broad root.
    if (
      splits.length !== 2 ||
      !source.some((i) => i.rect[3] < splits[0] && i.rect[2] - i.rect[0] > height * 10)
    )
      return
  } else if (splits.length < 2) return
  if (splits.length > 3) return
  const ys = [top, ...splits, bottom],
    spans = [],
    owned = []
  let regions = [{ start: 0, end: cuts.length - 1 }]
  const rowOf = (i) => ys.slice(1).findIndex((y) => (i.rect[1] + i.rect[3]) / 2 < y)
  for (let row = 0; row < ys.length - 1; row++) {
    const next = []
    for (const region of regions) {
      const tokens = source.filter(
        (i) =>
          rowOf(i) === row &&
          i.rect[0] >= cuts[region.start] - 1 &&
          i.rect[2] <= cuts[region.end] + 1
      )
      const descendants = source.filter(
        (i) =>
          rowOf(i) > row && i.rect[0] >= cuts[region.start] - 1 && i.rect[2] <= cuts[region.end] + 1
      )
      if (!tokens.length) {
        next.push(region)
        continue
      }
      const native = lines.filter(
        (r) =>
          Math.abs(r[1] - ys[row + 1]) < height * 0.2 &&
          r[0] >= cuts[region.start] - height &&
          r[2] <= cuts[region.end] + height
      )
      const nodes = []
      for (const r of native) {
        const group = tokens.filter((i) => i.rect[0] >= r[0] - 1 && i.rect[2] <= r[2] + 1)
        const leafCols = cuts
          .slice(1)
          .flatMap((x, c) =>
            c >= region.start &&
            c < region.end &&
            descendants.some(
              (i) =>
                i.rect[0] >= r[0] - 1 &&
                i.rect[2] <= r[2] + 1 &&
                (i.rect[0] + i.rect[2]) / 2 >= cuts[c] &&
                (i.rect[0] + i.rect[2]) / 2 < x
            )
              ? [c]
              : []
          )
        if (!group.length || !leafCols.length) continue
        nodes.push({ start: leafCols[0], end: leafCols.at(-1) + 1, tokens: group })
      }
      for (const i of tokens
        .filter((i) => !nodes.some((n) => n.tokens.includes(i)))
        .sort((a, b) => a.rect[0] - b.rect[0])) {
        const start = cuts.slice(1).findIndex((x) => i.rect[0] < x - 0.1)
        if (start < region.start || start >= region.end) return
        // Adjacent scripts still belong to their unruled statistic heading
        // when neighboring cohort headings have native underlines.
        let node = nodes.find(
          (n) =>
            (!native.length && n.start === start) ||
            n.tokens.some(
              (t) =>
                isAdjacentTableScript(i, t) ||
                (Math.abs(t.baseline - i.baseline) < height * 0.2 &&
                  i.rect[0] >= t.rect[2] - 0.1 &&
                  i.rect[0] - t.rect[2] < height * 0.25)
            )
        )
        if (!node) {
          node = { start, end: start + 1, tokens: [] }
          nodes.push(node)
        }
        node.tokens.push(i)
      }
      nodes.sort((a, b) => a.start - b.start)
      for (let n = 0; n < nodes.length; n++) {
        const node = nodes[n],
          limit = nodes[n + 1]?.start ?? region.end
        if (!native.length && row < ys.length - 2) node.end = limit
        if (
          node.end > limit ||
          node.start < region.start ||
          node.tokens.some((i) => i.rect[2] > cuts[node.end] + 1)
        )
          return
        let rowSpan = 1
        if (
          node.end - node.start === 1 &&
          !descendants.some(
            (i) => i.rect[0] >= cuts[node.start] - 1 && i.rect[2] <= cuts[node.end] + 1
          )
        )
          rowSpan = ys.length - 1 - row
        spans.push({ row, column: node.start, rowSpan, colSpan: node.end - node.start })
        owned.push(node.tokens)
        if (rowSpan === 1) next.push({ start: node.start, end: node.end })
      }
      // A stub may be printed only beside the leaf tier.
      let cursor = region.start
      for (const node of nodes) {
        if (node.start > cursor) next.push({ start: cursor, end: node.start })
        cursor = node.end
      }
      if (cursor < region.end) next.push({ start: cursor, end: region.end })
    }
    regions = next
  }
  if (!hasUniqueRecordTokens(source, owned)) return
  return { rows: ys.slice(1).map((y, n) => [left, ys[n], right, y]), spans }
}

// Some native frames partition the top by parent cells and the bottom by
// leaves. A wrapped title crossing a leaf cut and complete, aligned children
// prove the hierarchy without inventing an underline between the two tiers.
export function recoverSplitBorderHeaderBands(source, cuts, rules, top, bottom) {
  if (
    !source.length ||
    cuts.length < 4 ||
    cuts.some((x, n) => !Number.isFinite(x) || (n && x <= cuts[n - 1]))
  )
    return
  const height = Math.max(...source.map((i) => i.height))
  if (
    !(height > 0) ||
    source.some((i) => !i.horizontal || Math.abs(i.height - height) > height * 0.2)
  )
    return
  const first = Math.min(...source.map((i) => i.rect[1]))
  const partition = (y) =>
    rules
      .filter((r) => r[1] === r[3] && Math.abs(r[1] - y) < height * 0.01)
      .sort((a, b) => a[0] - b[0])
  const upper = rules.filter(
    (r) => r[1] === r[3] && r[1] >= top && Math.abs(r[1] - first) < height * 0.1
  )
  if (!upper.length) return
  const edges = partition(upper[0][1]),
    leaves = partition(bottom)
  const contiguous = (lines) =>
    lines.length >= 2 &&
    Math.abs(lines[0][0] - cuts[0]) < height * 0.5 &&
    Math.abs(lines.at(-1)[2] - cuts.at(-1)) < height * 0.5 &&
    lines.every(
      (r, n) =>
        r[2] > r[0] && (!n || (r[0] >= lines[n - 1][2] && r[0] - lines[n - 1][2] < height * 0.1))
    )
  if (
    !contiguous(edges) ||
    !contiguous(leaves) ||
    leaves.length !== cuts.length - 1 ||
    edges.length >= leaves.length ||
    leaves.some(
      (r, c) =>
        Math.abs(r[0] - cuts[c]) > height * 0.5 || Math.abs(r[2] - cuts[c + 1]) > height * 0.5
    )
  )
    return
  const spans = [],
    owned = [],
    splits = []
  let column = 0
  for (const edge of edges) {
    const start = column
    if (Math.abs(edge[0] - leaves[start]?.[0]) > height * 0.1) return
    while (column < leaves.length && leaves[column][2] < edge[2] - height * 0.1) column++
    if (column >= leaves.length || Math.abs(leaves[column][2] - edge[2]) > height * 0.1) return
    const end = ++column
    const group = source.filter((i) => i.rect[0] >= edge[0] && i.rect[2] <= edge[2])
    if (!group.length || !group.some((i) => /\p{L}/u.test(i.text))) return
    if (end - start === 1) {
      if (!readSourceRow(group, cuts)?.[start]) return
      spans.push({ row: 0, column: start, rowSpan: 2, colSpan: 1 })
      owned.push(group)
      continue
    }
    const crossing = group.filter((i) =>
      cuts.slice(start + 1, end).some((x) => i.rect[0] < x && i.rect[2] > x)
    )
    if (!crossing.length) return
    const upperBottom = Math.max(...crossing.map((i) => i.rect[3]))
    const children = group.filter((i) => i.rect[1] > upperBottom)
    if (!children.length) return
    const childTop = Math.min(...children.map((i) => i.rect[1]))
    if (childTop - upperBottom > height || childTop - upperBottom < height * 0.05) return
    const names = group.filter((i) => i.rect[3] <= upperBottom)
    const nameRect = union(names)
    const labels = readSourceRow(children, cuts, { multiline: true })?.slice(start, end)
    if (
      !hasUniqueRecordTokens(group, [names, children]) ||
      !names.some((i) => /\p{L}{2}/u.test(i.text)) ||
      Math.abs(nameRect[0] + nameRect[2] - edge[0] - edge[2]) > height ||
      !labels?.every((s) => /\p{L}/u.test(s) && !/\d/u.test(s)) ||
      new Set(labels).size !== labels.length
    )
      return
    const childBands = Array.from({ length: end - start }, (_, n) =>
      union(
        children.filter((i) => i.rect[0] >= cuts[start + n] && i.rect[2] <= cuts[start + n + 1])
      )
    )
    if (
      childBands.some(
        (r) =>
          Math.abs(r[1] - childBands[0][1]) > height * 0.1 ||
          Math.abs(r[3] - childBands[0][3]) > height * 0.1
      ) ||
      rules.some(
        (r) =>
          r[0] < edge[2] &&
          r[2] > edge[0] &&
          r[1] > upper[0][1] + height * 0.1 &&
          r[1] < bottom - height * 0.1
      )
    )
      return
    splits.push((upperBottom + childTop) / 2)
    spans.push({ row: 0, column: start, rowSpan: 1, colSpan: end - start })
    owned.push(names, children)
  }
  if (
    column !== leaves.length ||
    !splits.length ||
    splits.some((y) => Math.abs(y - splits[0]) > height * 0.1) ||
    !hasUniqueRecordTokens(source, owned)
  )
    return
  return {
    rows: [
      [cuts[0], top, cuts.at(-1), splits[0]],
      [cuts[0], splits[0], cuts.at(-1), bottom]
    ],
    spans
  }
}

// Segmented parent frames may include narrow, empty spacers, with separate
// leaf strokes only below the entire header. Repeated complete leaf labels
// and a common glyph-free tier boundary corroborate the native partitions.
export function recoverSegmentedCohortHeaderBands(source, cuts, rules, top, bottom) {
  if (
    !source.length ||
    cuts.length < 7 ||
    cuts.some((x, n) => !Number.isFinite(x) || (n && x <= cuts[n - 1]))
  )
    return
  const height = Math.max(...source.map((i) => i.height)),
    first = Math.min(...source.map((i) => i.rect[1])),
    centers = cuts.slice(1).map((x, c) => (cuts[c] + x) / 2)
  if (
    !(height > 0) ||
    source.some((i) => !i.horizontal || Math.abs(i.height - height) > height * 0.1)
  )
    return
  const topLines = rules
    .filter((r) => r[1] === r[3] && r[1] >= top && Math.abs(r[1] - first) < height * 0.1)
    .sort((a, b) => a[0] - b[0])
  if (
    topLines.length < 3 ||
    Math.abs(topLines[0][0] - cuts[0]) > height * 1.5 ||
    Math.abs(topLines.at(-1)[2] - cuts.at(-1)) > height * 1.5 ||
    topLines.some(
      (r, n) =>
        r[2] <= r[0] ||
        (n &&
          (Math.abs(r[1] - topLines[0][1]) > height * 0.01 ||
            r[0] < topLines[n - 1][2] ||
            r[0] - topLines[n - 1][2] > height * 0.1))
    )
  )
    return
  const parents = [],
    singles = [],
    owned = []
  for (const edge of topLines) {
    const columns = centers.flatMap((x, c) => (x >= edge[0] && x <= edge[2] ? [c] : []))
    const tokens = source.filter(
      (i) => i.rect[0] >= edge[0] - height * 0.05 && i.rect[2] <= edge[2] + height * 0.05
    )
    if (!columns.length) {
      if (tokens.length || edge[2] - edge[0] > height * 1.5) return
      continue
    }
    if (!tokens.length || columns.some((c, n) => n && c !== columns[n - 1] + 1)) return
    const node = { edge, tokens, start: columns[0], end: columns.at(-1) + 1 }
    if (columns.length === 1) {
      if (
        tokens.some(
          (i) =>
            i.rect[0] < cuts[node.start] || i.rect[2] > cuts[node.end] || !/\p{L}/u.test(i.text)
        )
      )
        return
      singles.push(node)
    } else parents.push(node)
    owned.push(tokens)
  }
  if (parents.length < 3 || !hasUniqueRecordTokens(source, owned)) return
  const leafLines = rules.filter((r) => r[1] === r[3] && Math.abs(r[1] - bottom) < height * 0.1)
  if (
    !centers.every((x, c) =>
      leafLines.some(
        (r) =>
          x >= r[0] &&
          x <= r[2] &&
          r[2] - r[0] >= (cuts[c + 1] - cuts[c]) * 0.5 &&
          Math.abs(r[0] - cuts[c]) < height * 1.5 &&
          Math.abs(r[2] - cuts[c + 1]) < height * 1.5
      )
    )
  )
    return
  const members = parents.flatMap((p) => p.tokens),
    candidates = []
  for (const y of [...new Set(members.map((i) => i.rect[3]))]) {
    const below = members.filter((i) => i.rect[1] > y)
    if (!below.length || members.some((i) => i.rect[1] <= y && i.rect[3] > y)) continue
    const next = Math.min(...below.map((i) => i.rect[1]))
    if (next - y > height) continue
    const labels = [],
      spans = []
    let valid = true
    for (const p of parents) {
      const upper = p.tokens.filter((i) => i.rect[3] <= y),
        lower = p.tokens.filter((i) => i.rect[1] >= next)
      const values = readSourceRow(lower, cuts)?.slice(p.start, p.end)
      const rect = upper.length && union(upper)
      if (
        !rect ||
        !values?.every((s) => /\p{L}/u.test(s)) ||
        new Set(values).size < 2 ||
        !upper.some((i) => /\p{L}{2}/u.test(i.text)) ||
        !upper.some((i) =>
          cuts.slice(p.start + 1, p.end).some((x) => i.rect[0] < x && i.rect[2] > x)
        ) ||
        Math.abs((rect[0] + rect[2] - p.edge[0] - p.edge[2]) / 2) > height * 0.5 ||
        rules.some(
          (r) =>
            r[1] > topLines[0][1] + height * 0.1 &&
            r[1] < bottom - height * 0.1 &&
            r[0] < p.edge[2] &&
            r[2] > p.edge[0]
        )
      ) {
        valid = false
        break
      }
      labels.push(values)
      spans.push({ row: 0, column: p.start, rowSpan: 1, colSpan: p.end - p.start })
    }
    if (!valid || labels.some((v) => JSON.stringify(v) !== JSON.stringify(labels[0]))) continue
    candidates.push({ split: (y + next) / 2, spans })
  }
  if (candidates.length !== 1) return
  const { split, spans } = candidates[0]
  spans.push(...singles.map((p) => ({ row: 0, column: p.start, rowSpan: 2, colSpan: 1 })))
  return {
    rows: [
      [cuts[0], top, cuts.at(-1), split],
      [cuts[0], split, cuts.at(-1), bottom]
    ],
    spans
  }
}

// Some publishers paint the top border once per parent cell, then draw one
// continuous underline below all parents. Preserve the native top segments
// when separate centered names and repeated child labels corroborate them.
export function recoverSegmentedParentBands(source, cuts, rules, top, bottom) {
  if (!source.length) return
  const height = Math.max(...source.map((i) => i.height))
  const first = Math.min(...source.map((i) => i.rect[1]))
  const edge = rules
    .filter((r) => r[1] === r[3] && r[1] >= top && r[1] < first && first - r[1] < height * 2)
    .sort((a, b) => a[0] - b[0])
  if (
    edge.length < 3 ||
    edge.some(
      (r, n) => n && (Math.abs(r[1] - edge[0][1]) > 0.1 || Math.abs(r[0] - edge[n - 1][2]) > 0.1)
    )
  )
    return
  const bands = joinHorizontalTableRules(rules).filter(
    (r) => r[1] > first && r[1] < bottom && r[0] > cuts[0] && r[2] < cuts.at(-1)
  )
  for (const line of bands) {
    const upper = source.filter((i) => i.rect[3] < line[1]),
      lower = source.filter((i) => i.rect[1] > line[1])
    if (!hasUniqueRecordTokens(source, [upper, lower])) continue
    const parents = []
    let valid = true
    for (const r of edge) {
      const names = upper.filter((i) => i.rect[0] >= r[0] - 1 && i.rect[2] <= r[2] + 1)
      if (!names.length) continue
      const children = lower.filter((i) => i.rect[0] >= r[0] - 1 && i.rect[2] <= r[2] + 1)
      const cols = [
        ...new Set(
          children.map((i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x))
        )
      ].sort((a, b) => a - b)
      const rect = union(names)
      if (
        cols.length < 2 ||
        cols.some((c, n) => n && c !== cols[n - 1] + 1) ||
        Math.abs((rect[0] + rect[2] - r[0] - r[2]) / 2) > height ||
        !names.some((i) => /\p{L}{2}/u.test(i.text))
      ) {
        valid = false
        break
      }
      const labels = readSourceRow(children, cuts)?.slice(cols[0], cols.at(-1) + 1)
      if (!labels?.every((s) => /\p{L}/u.test(s))) {
        valid = false
        break
      }
      parents.push({
        members: names,
        labels,
        row: 0,
        column: cols[0],
        colSpan: cols.length,
        rowSpan: 1
      })
    }
    if (
      !valid ||
      parents.length < 2 ||
      !hasUniqueRecordTokens(
        upper,
        parents.map((p) => p.members)
      )
    )
      continue
    if (parents.some((p) => JSON.stringify(p.labels) !== JSON.stringify(parents[0].labels)))
      continue
    if (parents.some((p, n) => n && p.column < parents[n - 1].column + parents[n - 1].colSpan))
      continue
    const spans = parents.map((p) => ({
      row: p.row,
      column: p.column,
      rowSpan: p.rowSpan,
      colSpan: p.colSpan
    }))
    return {
      rows: [
        [cuts[0], top, cuts.at(-1), line[1]],
        [cuts[0], line[1], cuts.at(-1), bottom]
      ],
      spans
    }
  }
}

// Repeated leaf labels establish equal-sized child groups even without inset
// underlines. A third-level title must be centered over all those groups, not
// merely positioned above a single middle column.
export function recoverRepeatedHeaderHierarchy(source, cuts, top, bottom) {
  const height = Math.max(...source.map((i) => i.height)),
    baseline = Math.max(...source.map((i) => i.baseline))
  const leaves = source
    .filter((i) => Math.abs(i.baseline - baseline) < height * 0.2)
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (leaves.length < 6 || leaves.some((i) => !/^[\p{L} -]+$/u.test(i.text))) return
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  if (leaves.some((i, n) => n && col(i) !== col(leaves[n - 1]) + 1)) return
  const size = leaves.slice(1).findIndex((i) => i.text === leaves[0].text) + 1
  if (size < 2 || leaves.length % size || leaves.some((i, n) => i.text !== leaves[n % size].text))
    return
  const start = col(leaves[0]),
    end = col(leaves.at(-1)) + 1,
    parents = []
  for (let n = 0; n < leaves.length; n += size) {
    const a = col(leaves[n]),
      b = a + size
    const owner = source.filter(
      (i) =>
        !leaves.includes(i) &&
        i.rect[3] < union(leaves)[1] &&
        Math.abs((i.rect[0] + i.rect[2] - cuts[a] - cuts[b]) / 2) < height * 0.6
    )
    const lowest = owner.sort((a, b) => b.baseline - a.baseline)[0]
    if (!lowest || lowest.rect[0] < cuts[a] || lowest.rect[2] > cuts[b]) return
    parents.push(lowest)
  }
  if (parents.some((i) => Math.abs(i.baseline - parents[0].baseline) > height * 0.2)) return
  const roots = source.filter(
    (i) =>
      !parents.includes(i) &&
      i.rect[3] < union(parents)[1] &&
      i.rect[0] >= cuts[start] &&
      i.rect[2] <= cuts[end] &&
      Math.abs((i.rect[0] + i.rect[2] - cuts[start] - cuts[end]) / 2) < height * 0.6
  )
  if (roots.length !== 1) return
  const root = roots[0],
    others = source.filter((i) => !leaves.includes(i) && !parents.includes(i) && i !== root)
  if (others.some((i) => col(i) >= start && col(i) < end)) return
  const ys = [
    top,
    (root.rect[3] + union(parents)[1]) / 2,
    (union(parents)[3] + union(leaves)[1]) / 2,
    bottom
  ]
  const spans = [
    { row: 0, column: start, rowSpan: 1, colSpan: end - start },
    ...parents.map((_, n) => ({ row: 1, column: start + n * size, rowSpan: 1, colSpan: size }))
  ]
  for (let c = 0; c < cuts.length - 1; c++)
    if (c < start || c >= end) spans.push({ row: 0, column: c, rowSpan: 3, colSpan: 1 })
  return { rows: ys.slice(1).map((y, n) => [cuts[0], ys[n], cuts.at(-1), y]), spans }
}

// Split only a uniquely owned model row. Unlike strict column containment in
// readSourceRow, row repair uses glyph centers, matching cell assignment. The
// caller supplies ordered source groups and retains responsibility for deciding
// whether their labels/values justify a split. No source tokens are rewritten.
export function splitOwnedSourceRow(rows, items, upper, lower, bounds) {
  return splitOwnedSourceRows(rows, items, [upper, lower], bounds)
}

// The same ownership check applies when one model band contains several
// complete source records. Keep the pair interface for existing recognizers.
export function splitOwnedSourceRows(rows, items, groups, [left, right]) {
  const members = groups.flat()
  if (
    groups.length < 2 ||
    !hasUniqueRecordTokens(members, groups) ||
    members.some((i) => !items.includes(i))
  )
    return
  const owns = (row, item) => inside([left, row.rect[1], right, row.rect[3]], item)
  const owners = rows.filter((row) => members.every((item) => owns(row, item)))
  if (
    owners.length !== 1 ||
    items.some((item) => !members.includes(item) && owns(owners[0], item)) ||
    rows.some((row) => row !== owners[0] && members.some((item) => owns(row, item)))
  )
    return
  const rects = groups.map(union)
  if (
    rects.some((rect, n) => {
      if (!n || rects[n - 1][3] < rect[1]) return false
      // Font ascent boxes may touch even on distinct native baselines. Permit
      // only a small overlap between uniform, unscripted lines; their centers
      // still have a unique boundary and no glyph changes its record owner.
      const pair = [groups[n - 1], groups[n]]
      const height = Math.min(...pair.flat().map((i) => i.height))
      return (
        rects[n - 1][3] - rect[1] > height * 0.1 ||
        pair.some((g) =>
          g.some(
            (i) =>
              Math.abs(i.baseline - g[0].baseline) > height * 0.1 ||
              Math.abs(i.height - height) > height * 0.1
          )
        ) ||
        groups[n][0].baseline - groups[n - 1][0].baseline < height * 0.8
      )
    })
  )
    return
  return {
    index: rows.indexOf(owners[0]),
    rows: rects.map((rect, n) => ({
      rect: [
        left,
        n ? (rects[n - 1][3] + rect[1]) / 2 : rect[1],
        right,
        n + 1 < rects.length ? (rect[3] + rects[n + 1][1]) / 2 : rect[3]
      ],
      origin: 'source-text'
    }))
  }
}
