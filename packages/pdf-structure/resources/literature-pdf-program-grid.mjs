/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
import { union } from './literature-pdf-table-geometry.mjs'
import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'
import {
  tableSourceItems,
  groupSourceRowsWithScripts,
  readSourceRow,
  hasUniqueRecordTokens
} from './literature-pdf-source-records.mjs'

export function recoverRuledProgramGrid(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const source = tableSourceItems(items, table.cropRect)
  if (!source.length) return
  const height = source.map((i) => i.height).sort((a, b) => a - b)[Math.floor(source.length / 2)],
    lines = groupSourceRowsWithScripts(source, height, 0.2)
  if (!(height > 0) || !lines || source.some((i) => Math.abs(i.height - height) > height * 0.1))
    return
  return (
    recoverSchedule(table, source, lines, height, rules, items) ??
    recoverComponents(table, source, lines, height, rules)
  )
}

function clusters(group, height) {
  const result = []
  for (const i of [...group].sort((a, b) => a.rect[0] - b.rect[0])) {
    if (result.length && i.rect[0] - union(result.at(-1))[2] < height * 0.7) result.at(-1).push(i)
    else result.push([i])
  }
  return result
}

function closingRule(table, rules, source, height) {
  const [left, , right, bottom] = table.cropRect,
    end = Math.max(...source.map((i) => i.rect[3]))
  const closing = joinHorizontalTableRules(rules).filter(
    (r) =>
      r[1] > end &&
      r[1] - end < height * 1.5 &&
      r[1] <= bottom &&
      Math.abs(r[0] - left) < height &&
      Math.abs(r[2] - right) < height * 2
  )
  return closing.length === 1 ? closing[0] : undefined
}

// A ruled schedule has one global band, one native subgroup underline, and
// a dense final timepoint row. Its repeated X records witness every later visit
// column, including the terminal visit with no printed timepoint code.
function recoverSchedule(table, source, lines, height, rules, pageItems) {
  const [left, top, right, bottom] = table.cropRect,
    marked = lines.filter((g) => g.some((i) => i.text === 'X')),
    closing = closingRule(table, rules, source, height)
  if (marked.length < 5 || !closing) return
  const firstMark = union(marked[0])[1],
    dense = lines.filter((g) => union(g)[3] < firstMark && clusters(g, height).length >= 8)
  if (dense.length !== 1) return
  const final = dense[0],
    leaves = clusters(final, height)
  if (leaves.length !== 8 || !/\p{L}/u.test(leaves[0].map((i) => i.text).join(''))) return
  const head = source.filter((i) => i.rect[3] <= union(final)[3]),
    before = lines.filter((g) => union(g)[3] < union(final)[1]),
    last = before
      .map((g) => clusters(g, height).at(-1))
      .filter((g) => union(g)[0] > union(leaves.at(-1))[2] + height * 2)
  if (last.length !== 2 || Math.abs(union(last[0])[0] - union(last[1])[0]) > height * 0.1) return
  const anchors = [...leaves.map((g) => union(g)[0]), union(last[0])[0]],
    cuts = [left, ...anchors.slice(1).map((x) => x - height * 0.5), right],
    horizontal = joinHorizontalTableRules(rules),
    global = horizontal.filter(
      (r) =>
        r[1] > union(lines[0])[3] &&
        r[1] < union(final)[1] &&
        Math.abs(r[0] - anchors[1]) < height * 0.2 &&
        Math.abs(r[2] - right) < height
    ),
    subgroup = horizontal.filter(
      (r) =>
        r[1] > (global[0]?.[1] ?? Infinity) &&
        r[1] < union(final)[1] &&
        Math.abs(r[0] - anchors[1]) < height * 0.2 &&
        r[2] > anchors[3] &&
        r[2] < anchors[4]
    )
  if (global.length !== 1 || subgroup.length !== 1 || cuts.some((x, c) => c && x <= cuts[c - 1]))
    return
  const upper = head.filter((i) => i.rect[3] < global[0][1]),
    sub = head.filter(
      (i) =>
        i.rect[1] > global[0][1] &&
        i.rect[3] < subgroup[0][1] &&
        i.rect[0] >= cuts[1] &&
        i.rect[2] <= cuts[4]
    ),
    lower = head.filter(
      (i) => i.rect[1] > subgroup[0][1] && i.rect[3] < union(final)[1] && i.rect[2] <= cuts[4]
    ),
    repeated = [4, 5, 6, 7, 8].map((c) =>
      head.filter((i) => !final.includes(i) && i.rect[0] >= cuts[c] && i.rect[2] <= cuts[c + 1])
    )
  if (
    !upper.length ||
    upper.some((i) => i.rect[0] < cuts[1]) ||
    !sub.length ||
    !lower.length ||
    repeated.some((g) => !g.length) ||
    !hasUniqueRecordTokens(head, [upper, sub, lower, final, ...repeated]) ||
    !readSourceRow(final, cuts) ||
    !readSourceRow(lower, cuts)
  )
    return
  const body = source.filter((i) => i.rect[1] > union(final)[3]),
    bodyLines = groupSourceRowsWithScripts(body, height, 0.2),
    owned = []
  if (!bodyLines) return
  for (const g of bodyLines) {
    const label = g.filter((i) => i.text !== 'X'),
      marks = g.filter((i) => i.text === 'X')
    if (!label.length || label.some((i) => i.rect[2] >= cuts[1]) || !readSourceRow(g, cuts)) return
    if (
      !marks.length &&
      owned.length &&
      owned.at(-1).some((i) => i.text === 'X') &&
      union(g)[1] - union(owned.at(-1))[3] < height * 0.6 &&
      g[0].baseline - owned.at(-1)[0].baseline < height * 1.5 &&
      union(g)[0] >= union(owned.at(-1).filter((i) => i.text !== 'X'))[0]
    )
      owned.at(-1).push(...g)
    else owned.push([...g])
  }
  const complete = owned.filter((g) => g.filter((i) => i.text === 'X').length === 4)
  if (
    complete.length < 3 ||
    complete.some((g) => readSourceRow(g, cuts).slice(1).join('|') !== '|X||||X|X|X') ||
    !hasUniqueRecordTokens(body, owned)
  )
    return
  const rows = owned.map((g) => [left, union(g)[1], right, union(g)[3]]),
    spans = [
      { row: 0, column: 1, rowSpan: 1, colSpan: 8 },
      { row: 1, column: 1, rowSpan: 1, colSpan: 3 },
      ...[4, 5, 6, 7].map((column) => ({ row: 1, column, rowSpan: 2, colSpan: 1 })),
      { row: 1, column: 8, rowSpan: 3, colSpan: 1 },
      ...owned.flatMap((g, r) =>
        !g.some((i) => i.text === 'X') && Math.abs(union(g)[0] - anchors[0]) < height * 0.2
          ? [{ row: r + 4, column: 0, rowSpan: 1, colSpan: 9 }]
          : []
      )
    ]
  if (rows.some((r, n) => n && r[1] <= rows[n - 1][3])) return
  const paddedRight = Math.max(right, closing[2] + 0.5)
  // The closing rule proves an empty border, not ownership of additional ink.
  // Keep the existing grid and crop when any native text enters the new strip.
  const introducedInk = pageItems.some(
    (i) =>
      !source.includes(i) &&
      i.rect[0] < paddedRight &&
      i.rect[2] > right &&
      i.rect[1] < bottom &&
      i.rect[3] > top
  )
  return {
    cropRect: [left, top, introducedInk ? right : paddedRight, bottom],
    rows: [
      [left, top, right, global[0][1]],
      [left, global[0][1], right, subgroup[0][1]],
      [left, subgroup[0][1], right, union(final)[1] - height * 0.2],
      [left, union(final)[1] - height * 0.2, right, union(final)[3]],
      ...rows
    ],
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans,
    headerRows: [0, 1, 2, 3],
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Two matching phase underlines and repeated leaf names establish four data
// columns. A separate indented stub branch has two consecutive children; its
// single parent owns both rows while earlier full-width components span stubs.
function recoverComponents(table, source, lines, height, rules) {
  const [left, top, right, bottom] = table.cropRect,
    strokes = rules
      .filter((r) => r[1] === r[3] && r[0] > left + height * 5 && r[1] > top && r[1] < bottom)
      .sort((a, b) => a[1] - b[1] || a[0] - b[0])
  const pairs = []
  for (let n = 0; n < strokes.length; n++)
    for (let k = n + 1; k < strokes.length; k++)
      if (
        Math.abs(strokes[n][1] - strokes[k][1]) < height * 0.1 &&
        strokes[n][2] + height < strokes[k][0]
      )
        pairs.push([strokes[n], strokes[k]])
  if (pairs.length !== 1 || !closingRule(table, rules, source, height)) return
  const pair = pairs[0],
    split = Math.min(...pair.map((r) => r[1])),
    leafLines = lines.filter((g) => union(g)[1] > split && union(g)[1] - split < height * 0.4)
  if (leafLines.length !== 1) return
  const leaf = leafLines[0],
    groups = pair.map((r) =>
      clusters(
        leaf.filter((i) => i.rect[0] >= r[0] && i.rect[2] <= r[2]),
        height
      )
    )
  if (
    groups.some((g) => g.length !== 2) ||
    groups[0].some(
      (g, c) =>
        readSourceRow(g, [pair[0][0], pair[0][2]])[0] !==
        readSourceRow(groups[1][c], [pair[1][0], pair[1][2]])[0]
    )
  )
    return
  const headEnd = union(leaf)[3],
    body = source.filter((i) => i.rect[1] > headEnd),
    bodyLines = groupSourceRowsWithScripts(body, height, 0.2),
    dataStarts = groups.flat().map((g) => union(g)[0]),
    dataCuts = [
      pair[0][0] - height * 0.5,
      (union(groups[0][0])[2] + dataStarts[1]) / 2,
      (pair[0][2] + pair[1][0]) / 2,
      (union(groups[1][0])[2] + dataStarts[3]) / 2,
      right
    ]
  if (!bodyLines) return
  const records = []
  for (const g of bodyLines) {
    const data = g.filter((i) => i.rect[0] >= dataCuts[0]),
      stub = g.filter((i) => i.rect[2] < dataCuts[0])
    if (stub.length && readSourceRow(data, dataCuts)?.every(Boolean)) records.push([...g])
    else if (
      records.length &&
      g[0].baseline - Math.max(...records.at(-1).map((i) => i.baseline)) < height * 1.5 &&
      union(g)[1] - union(records.at(-1))[3] < height * 0.6 &&
      (!data.length || readSourceRow(data, dataCuts))
    )
      records.at(-1).push(...g)
    else return
  }
  if (records.length !== 4 || !hasUniqueRecordTokens(body, records)) return
  const stubs = records.map((g) => g.filter((i) => i.rect[2] < dataCuts[0])),
    branch = clusters(stubs[2], height),
    child = stubs[3]
  if (
    branch.length !== 2 ||
    child.length !== 1 ||
    Math.abs(union(branch[1])[0] - child[0].rect[0]) > height * 0.1 ||
    Math.abs(union(stubs[0])[0] - union(branch[0])[0]) > height * 0.1 ||
    Math.abs(union(stubs[1])[0] - union(branch[0])[0]) > height * 0.1
  )
    return
  const stubCut = (union(branch[0])[2] + union(branch[1])[0]) / 2,
    cuts = [left, stubCut, ...dataCuts],
    head = source.filter((i) => i.rect[3] <= headEnd),
    phases = pair.map((r) =>
      head.filter(
        (i) =>
          i.rect[3] < split && split - i.rect[3] < height && i.rect[0] >= r[0] && i.rect[2] <= r[2]
      )
    ),
    stubHead = leaf.filter((i) => i.rect[2] < dataCuts[0]),
    global = head.filter((i) => !leaf.includes(i) && !phases.flat().includes(i)),
    globalLines = groupSourceRowsWithScripts(global, height, 0.2)
  if (
    phases.some((g) => !g.length) ||
    !stubHead.length ||
    globalLines?.length !== 2 ||
    globalLines.some((g) => Math.abs(union(g)[0] - union(branch[0])[0]) > height * 0.1) ||
    !hasUniqueRecordTokens(head, [...globalLines, ...phases, leaf])
  )
    return
  const globalRule = joinHorizontalTableRules(rules).filter(
    (r) =>
      r[1] > union(globalLines[1])[3] &&
      r[1] < union(phases.flat())[1] &&
      Math.abs(r[0] - union(branch[0])[0]) < height &&
      Math.abs(r[2] - right) < height * 3
  )
  if (
    globalRule.length !== 1 ||
    !readSourceRow(
      leaf.filter((i) => !stubHead.includes(i)),
      cuts
    ) ||
    !readSourceRow([...branch.flat(), ...child], cuts, { multiline: true })
  )
    return
  const between = (union(globalLines[0])[3] + union(globalLines[1])[1]) / 2
  return {
    rows: [
      [left, top, right, between],
      [left, between, right, globalRule[0][1]],
      [left, globalRule[0][1], right, split],
      [left, split, right, headEnd],
      ...records.map((g) => [left, union(g)[1], right, union(g)[3]])
    ],
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans: [
      { row: 0, column: 0, rowSpan: 1, colSpan: 6 },
      { row: 1, column: 0, rowSpan: 1, colSpan: 6 },
      { row: 2, column: 0, rowSpan: 2, colSpan: 2 },
      { row: 2, column: 2, rowSpan: 1, colSpan: 2 },
      { row: 2, column: 4, rowSpan: 1, colSpan: 2 },
      { row: 4, column: 0, rowSpan: 1, colSpan: 2 },
      { row: 5, column: 0, rowSpan: 1, colSpan: 2 },
      { row: 6, column: 0, rowSpan: 2, colSpan: 1 }
    ],
    headerRows: [0, 1, 2, 3],
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}
