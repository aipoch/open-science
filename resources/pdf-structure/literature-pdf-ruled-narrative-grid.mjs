/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { union, isAdjacentTableScript } from './literature-pdf-table-geometry.mjs'
import { captionKind } from './literature-pdf-caption-group.mjs'
import {
  tableSourceItems,
  readSourceRow,
  hasUniqueRecordTokens
} from './literature-pdf-source-records.mjs'

// Dense two-column narrative tables print a separator below each paragraph.
// Use those native bands instead of model rows that split a long instruction.
// The right border must be consistent, and every glyph must have one owner.
export function recoverRuledNarrativeGrid(table, items, captions, rules, sourceRules = rules) {
  const checklist = recoverRuledChecklist(table, items, sourceRules)
  if (checklist) return checklist
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
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
              0.7
          )
    )
  const segmented = recoverSegmentedNarrativeColumns(table, items, predicted, sourceRules)
  if (segmented) return segmented
  const paragraphs = recoverParagraphColumns(table, items, predicted, sourceRules)
  if (paragraphs) return paragraphs
  const centered = recoverCenteredBulletedGroups(table, items, predicted)
  if (centered) return centered
  const parallelLists = recoverParallelNumberedLists(table, items, predicted, rules)
  if (parallelLists) return parallelLists
  // A captioned theme outline has nested indents, not independent columns.
  // Require complete, uniformly spaced native entries at three indent levels;
  // paragraph continuations and side-by-side text do not satisfy this layout.
  if (
    predicted.length <= 2 &&
    captions.some(
      (c) =>
        captionKind(c.lines[0]) === 'table' &&
        c.rect[3] <= top &&
        top - c.rect[3] < 30 &&
        c.rect[0] >= left - 4 &&
        c.rect[0] < right
    )
  ) {
    const source = tableSourceItems(items, table.cropRect)
    const indents = [...new Set(source.map((i) => Math.round(i.rect[0])))].sort((a, b) => a - b)
    if (
      source.length >= 12 &&
      indents.length === 3 &&
      indents[1] - indents[0] >= source[0].height * 0.5 &&
      Math.abs(indents[2] - indents[1] - (indents[1] - indents[0])) <= 1 &&
      indents.every((x) => source.filter((i) => Math.abs(i.rect[0] - x) <= 1).length >= 3) &&
      source.every(
        (i, n) =>
          /^\p{Lu}/u.test(i.text.trim()) &&
          !/[.;:]$/.test(i.text.trim()) &&
          i.text.split(/\s+/).length <= 16 &&
          Math.abs(i.height - source[0].height) < 0.5 &&
          (!n ||
            (i.rect[1] > source[n - 1].rect[3] &&
              i.baseline - source[n - 1].baseline < i.height * 1.5))
      )
    )
      return {
        rows: source.map((i) => [left, i.rect[1], right, i.rect[3]]),
        columns: [[left, top, right, bottom]],
        headerRows: [],
        spans: [],
        completeSpans: true,
        ownedTokens: new Set(source)
      }
  }
  // Native rules alternate unindented attribute headings with indented lists.
  // Keep one record per entry; only join a wrapped line within its ruled band.
  if (predicted.length === 1) {
    const borders = rules
      .filter(
        (r) =>
          r[1] === r[3] &&
          r[0] <= left + 2 &&
          r[2] >= right - 2 &&
          r[1] >= top - 2 &&
          r[1] <= bottom
      )
      .sort((a, b) => a[1] - b[1])
    const ys = borders.map((r) => r[1]).filter((y, n, all) => !n || y - all[n - 1] > 2)
    if (ys.length < 9) return
    const source = tableSourceItems(items, [
      left - 1,
      ys[0],
      Math.max(right, borders[0][2]),
      ys.at(-1)
    ])
    const groups = []
    for (let n = 0; n < ys.length - 1; n++) {
      const band = source.filter((i) => i.rect[1] > ys[n] && i.rect[3] < ys[n + 1])
      if (!band.length) return
      const rows = []
      for (const i of band) {
        const prior = rows.at(-1)
        if (prior && Math.abs(i.baseline - prior[0].baseline) < i.height * 0.3) prior.push(i)
        else if (
          prior &&
          (Math.max(...prior.map((i) => i.rect[2])) > right - i.height * 2 ||
            i.rect[0] > prior[0].rect[0] + i.height * 0.5) &&
          i.baseline - Math.max(...prior.map((i) => i.baseline)) < i.height * 1.6
        )
          prior.push(i)
        else rows.push([i])
      }
      groups.push(...rows)
    }
    if (!hasUniqueRecordTokens(source, groups) || groups.length < 12) return
    const indent = Math.min(...source.map((i) => i.rect[0]))
    if (
      groups.filter((g) => Math.abs(g[0].rect[0] - indent) < 1).length < 3 ||
      groups.filter((g) => g[0].rect[0] > indent + g[0].height * 0.5).length < 6
    )
      return
    const bounds = groups.map(union)
    return {
      rows: bounds.map((r) => [left, r[1], Math.max(right, borders[0][2]), r[3]]),
      columns: [[left, top, Math.max(right, borders[0][2]), bottom]],
      headerRows: [],
      spans: [],
      completeSpans: true,
      ownedTokens: new Set(source)
    }
  }
  if (predicted.length !== 2) return
  const sections = recoverParallelRecommendations(table, items, rules, predicted)
  if (sections) return sections
  const pairs = recoverBulletedPairs(table, items, rules, predicted)
  if (pairs) return pairs
  const list = recoverBulletedList(table, items, rules, predicted)
  if (list) return list
  const cut = left + (predicted[0].rect[2] + predicted[1].rect[0]) / 2
  const source = tableSourceItems(items, table.cropRect)
  const continuation = source.find((i) =>
    /^\(?continued on (?:following|next) page\)?$/i.test(i.text.trim())
  )
  const borders = rules
    .filter(
      (r) =>
        r[1] === r[3] &&
        r[1] >= top &&
        r[1] <= (continuation?.rect[1] ?? bottom) &&
        r[0] <= cut &&
        r[2] >= right - 12 &&
        r[2] <= right + 12
    )
    .sort((a, b) => a[1] - b[1])
  const ys = [...new Set(borders.map((r) => r[1]))]
  if (ys.length < 8 || borders.some((r) => Math.abs(r[2] - borders[0][2]) > 1)) return
  const body = source.filter(
    (i) => (i.rect[1] + i.rect[3]) / 2 >= ys[0] && (i.rect[1] + i.rect[3]) / 2 <= ys.at(-1)
  )
  const groups = ys
    .slice(1)
    .map((y, n) =>
      body.filter((i) => (i.rect[1] + i.rect[3]) / 2 >= ys[n] && (i.rect[1] + i.rect[3]) / 2 < y)
    )
  if (!hasUniqueRecordTokens(body, groups)) return
  for (const group of groups) {
    const stub = group.filter((i) => i.rect[0] < cut),
      lines = []
    for (const i of stub) {
      const last = lines.at(-1)
      if (last && Math.abs(last[0].baseline - i.baseline) < i.height * 0.5) last.push(i)
      else lines.push([i])
    }
    if (
      lines
        .slice(0, -1)
        .some(
          (line) =>
            Math.max(...line.map((i) => i.rect[2])) < cut - line[0].height * 2 &&
            line.map((i) => i.text).join('').length < 36
        )
    )
      return
  }
  const cells = groups.map(
    (g) =>
      readSourceRow(g, [left, cut, right]) ??
      (g.every((i) => i.rect[0] < cut && Math.abs(i.baseline - g[0].baseline) < i.height * 0.3)
        ? [g.map((i) => i.text).join(''), '']
        : undefined)
  )
  if (cells.some((r) => !r) || !cells[0].every((s) => /\p{L}/u.test(s) && s.length < 80)) return
  if (
    cells.filter((r) => r[1].length > 160).length < 3 ||
    cells.slice(1).some((r) => r[0].length > 90 || (r[0] && !/\p{L}/u.test(r[0])))
  )
    return
  const spans = cells.flatMap((r, n) =>
    n && r[0] && !r[1] ? [{ row: n, column: 0, rowSpan: 1, colSpan: 2 }] : []
  )
  return {
    rows: ys.slice(1).map((y, n) => [left, ys[n], right, y]),
    columns: [
      [left, top, cut, bottom],
      [cut, top, right, bottom]
    ],
    spans,
    completeSpans: true
  }
}

// A vertically centered stub can describe several complete bullet records.
// Require an exact, contiguous partition by native text centers, not proximity
// to individual rows. Every bullet, wrapped line and stub must have one owner.
function recoverCenteredBulletedGroups(table, items, predicted) {
  if (predicted.length !== 3) return
  const [left, top, right, bottom] = table.cropRect
  const cuts = [
    left,
    left + (predicted[0].rect[2] + predicted[1].rect[0]) / 2,
    left + (predicted[1].rect[2] + predicted[2].rect[0]) / 2,
    right
  ]
  const source = tableSourceItems(items, table.cropRect)
  const bullets = source.filter((i) => i.text === '•')
  if (bullets.length < 8) return
  const height = bullets[0].height
  if (
    !(height > 0) ||
    bullets.some(
      (i) =>
        i.rect[0] < cuts[1] ||
        i.rect[2] > cuts[2] ||
        Math.abs(i.rect[0] - bullets[0].rect[0]) > height * 0.15 ||
        Math.abs(i.height - height) > height * 0.05
    )
  )
    return
  const heads = source.filter((i) => i.rect[3] < bullets[0].rect[1])
  const header = readSourceRow(heads, [left, cuts[1], right])
  if (
    !header?.every((s) => /\p{L}/u.test(s) && s.length < 80) ||
    heads.some((i) => Math.abs(i.baseline - heads[0].baseline) > height * 0.2)
  )
    return
  const body = source.filter((i) => !heads.includes(i))
  const stubs = body.filter((i) => i.rect[2] <= cuts[1])
  if (
    stubs.length < 3 ||
    stubs.some(
      (i) =>
        !/^[\p{L} ]{3,60}$/u.test(i.text) ||
        Math.abs(i.height - height) > height * 0.05 ||
        Math.abs(i.rect[0] - stubs[0].rect[0]) > height * 0.1
    )
  )
    return
  const text = body.filter((i) => !stubs.includes(i))
  const records = bullets.map((bullet, n) =>
    text.filter(
      (i) =>
        i.rect[1] >= bullet.rect[1] - 0.05 && i.rect[1] < (bullets[n + 1]?.rect[1] ?? bottom) - 0.05
    )
  )
  if (!hasUniqueRecordTokens(text, records)) return
  for (const record of records) {
    const cells = readSourceRow(record, [cuts[1], cuts[2], right])
    const statement = record.filter((i) => i.rect[0] >= cuts[2])
    if (
      !cells ||
      cells[0] !== '•' ||
      cells[1].length < 20 ||
      !/\p{L}/u.test(cells[1]) ||
      !statement.length ||
      Math.abs(statement[0].baseline - record[0].baseline) > height * 0.2 ||
      statement.some((i, n) => n && i.baseline - statement[n - 1].baseline > height * 1.3)
    )
      return
  }
  const rects = records.map(union)
  if (rects.some((r, n) => n && r[1] <= rects[n - 1][3])) return
  const spans = [{ row: 0, column: 1, rowSpan: 1, colSpan: 2 }]
  let start = 0
  for (const stub of stubs) {
    if (start >= rects.length) return
    const ends = rects.flatMap((rect, n) =>
      n > start &&
      Math.abs((rects[start][1] + rect[3] - stub.rect[1] - stub.rect[3]) / 2) <= height * 0.03
        ? [n]
        : []
    )
    if (ends.length !== 1) return
    const end = ends[0]
    spans.push({ row: start + 1, column: 0, rowSpan: end - start + 1, colSpan: 1 })
    start = end + 1
  }
  if (start !== records.length || !hasUniqueRecordTokens(source, [heads, stubs, ...records])) return
  return {
    rows: [union(heads), ...rects].map((r) => [left, r[1], right, r[3]]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], top, x, bottom]),
    headerRows: [0],
    spans,
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Boxed recommendation comparisons have independent paragraphs on each side.
// Repeated outdented section headings establish comparable blocks; treating
// each printed line as a table row loses text when the paragraphs differ in length.
function recoverParallelRecommendations(table, items, rules, columns) {
  const [left, top, right, bottom] = table.cropRect
  const cut = left + (columns[0].rect[2] + columns[1].rect[0]) / 2
  if (Math.min(cut - left, right - cut) < (right - left) * 0.3) return
  const source = tableSourceItems(items, table.cropRect)
  const heads = source.filter((i) => /Recommendation$/.test(i.text))
  if (heads.length !== 2 || Math.abs(heads[0].baseline - heads[1].baseline) > 1) return
  const height = heads[0].height
  const footer = rules.find(
    (r) =>
      r[1] === r[3] &&
      Math.abs(r[0] - left) < 12 &&
      Math.abs(r[2] - right) < 12 &&
      r[1] > heads[0].baseline &&
      bottom - r[1] < height
  )
  const divider = rules.find(
    (r) =>
      r[1] === r[3] &&
      r[2] - r[0] > (right - left) * 0.9 &&
      r[1] > heads[0].baseline &&
      r[1] - heads[0].baseline < height
  )
  if (
    !footer ||
    !divider ||
    ![left, right].every((x) =>
      rules.some(
        (r) =>
          r[0] === r[2] && Math.abs(r[0] - x) < 12 && r[1] <= divider[1] && r[3] >= footer[1] - 1
      )
    )
  )
    return
  const body = source.filter((i) => i.rect[1] > divider[1] && i.rect[3] < footer[1])
  const lines = []
  for (const i of body) {
    const last = lines.at(-1)
    if (last && Math.abs(last[0].baseline - i.baseline) < height * 0.35) last.push(i)
    else lines.push([i])
  }
  const lhs = Math.min(...body.map((i) => i.rect[0])),
    rhs = Math.min(...body.filter((i) => i.rect[0] > cut).map((i) => i.rect[0]))
  const parallel = (g) => {
    const a = g.filter((i) => i.rect[0] < cut),
      b = g.filter((i) => i.rect[0] >= cut)
    const text = a.map((i) => i.text).join(' ')
    return (
      a.length &&
      b.length &&
      text.length < 90 &&
      Math.abs(a[0].rect[0] - lhs) < 1 &&
      Math.abs(b[0].rect[0] - rhs) < 1 &&
      b
        .map((i) => i.text)
        .join(' ')
        .startsWith(text) &&
      a.every((i) => i.rect[2] < cut)
    )
  }
  if (lines.filter(parallel).length < 2) return
  const groups = [],
    spanning = []
  for (const g of lines) {
    const question = /^Clinical Question \d+[.]/.test(g.map((i) => i.text).join(' '))
    const heading = parallel(g)
    if (question || heading) {
      groups.push([...g])
      spanning.push(Boolean(question))
      continue
    }
    const previous = groups.at(-1)
    if (
      previous &&
      spanning.at(-1) &&
      !/\?$/.test(
        previous
          .map((i) => i.text)
          .join(' ')
          .trim()
      ) &&
      g[0].baseline - previous.at(-1).baseline < height * 1.6 &&
      g.every((i) => i.rect[0] < cut)
    )
      previous.push(...g)
    else if (!previous || spanning.at(-1) || parallel(previous)) {
      groups.push([...g])
      spanning.push(false)
    } else previous.push(...g)
  }
  if (
    !hasUniqueRecordTokens(body, groups) ||
    groups.some((g, n) => !spanning[n] && !readSourceRow(g, [left, cut, right]))
  )
    return
  const bounds = groups.map(union)
  if (bounds.some((r, n) => n && r[1] <= bounds[n - 1][3])) return
  return {
    rows: [
      [left, union(heads)[1], right, divider[1]],
      ...bounds.map((r) => [left, r[1], right, r[3]])
    ],
    columns: [
      [left, top, cut, bottom],
      [cut, top, right, bottom]
    ],
    spans: spanning.flatMap((v, n) =>
      v ? [{ row: n + 1, column: 0, rowSpan: 1, colSpan: 2 }] : []
    ),
    headerRows: [0],
    completeSpans: true,
    ownedTokens: new Set([...heads, ...body])
  }
}

// A narrow detected bullet column is not a data column. Require native outer
// rules, repeated aligned bullets, outdented section titles and hanging indents;
// every source token must belong to exactly one complete list entry.
function recoverBulletedList(table, items, rules, predicted) {
  const [left, top, right, bottom] = table.cropRect
  const widths = predicted.map((o) => o.rect[2] - o.rect[0])
  if (Math.min(...widths) > (right - left) * 0.08 || Math.max(...widths) < (right - left) * 0.85)
    return
  const source = tableSourceItems(items, table.cropRect)
  if (!source.length) return
  const lines = []
  for (const item of source) {
    const last = lines.at(-1)
    if (last && Math.abs(last[0].baseline - item.baseline) < item.height * 0.2) last.push(item)
    else lines.push([item])
  }
  for (const line of lines) line.sort((a, b) => a.rect[0] - b.rect[0])
  const bullets = lines.filter((line) => /^[–•−-]\s+[\p{L}\d]/u.test(line[0].text))
  if (bullets.length < 8) return
  const indent = bullets[0][0].rect[0],
    height = bullets[0][0].height
  if (bullets.some((line) => Math.abs(line[0].rect[0] - indent) > 1)) return
  const border = rules
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
  if (
    border.length !== 3 ||
    border[0][1] > source[0].rect[1] ||
    border.at(-1)[1] < Math.max(...source.map((i) => i.rect[3]))
  )
    return
  const records = [],
    sections = []
  for (const line of lines) {
    const x = line[0].rect[0]
    if (x < indent - height * 0.5) {
      if (
        Math.abs(x - lines[0][0].rect[0]) > 1 ||
        !/^[\p{L} ]{3,60}$/u.test(line.map((i) => i.text).join(' '))
      )
        return
      sections.push(records.length)
      records.push([...line])
    } else if (bullets.includes(line)) records.push([...line])
    else {
      if (
        !records.length ||
        sections.includes(records.length - 1) ||
        x < indent + height * 0.4 ||
        x > indent + height * 1.5 ||
        line[0].baseline - records.at(-1).at(-1).baseline > height * 1.6
      )
        return
      records.at(-1).push(...line)
    }
  }
  if (
    sections.length < 2 ||
    sections[0] !== 0 ||
    sections.some((n, i) => (sections[i + 1] ?? records.length) - n < 3) ||
    border[1][1] <= union(records[0])[3] ||
    border[1][1] >= union(records[1])[1] ||
    !hasUniqueRecordTokens(source, records)
  )
    return
  const rects = records.map(union)
  if (rects.some((r, n) => n && r[1] <= rects[n - 1][3])) return
  return {
    rows: rects.map((r) => [left, r[1], right, r[3]]),
    columns: [[left, top, right, bottom]],
    spans: [],
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Parallel top-level bullets delimit narrative records. Right-column bullets
// may subdivide a rationale; only aligned left-column bullets start new rows.
function recoverBulletedPairs(table, items, rules, columns) {
  const [left, top, right, bottom] = table.cropRect,
    cut = left + (columns[0].rect[2] + columns[1].rect[0]) / 2
  const source = tableSourceItems(items, table.cropRect),
    bullets = source.filter((i) => i.text === '•' && i.rect[0] < cut)
  if (
    bullets.length < 3 ||
    bullets.length > 12 ||
    bullets.some((i) => Math.abs(i.rect[0] - bullets[0].rect[0]) > 1)
  )
    return
  const height = bullets[0].height
  const borders = rules
    .filter(
      (r) =>
        r[1] === r[3] && r[0] <= left + 12 && r[2] >= right - 12 && r[1] >= top && r[1] <= bottom
    )
    .sort((a, b) => a[1] - b[1])
  if (
    borders.length !== 3 ||
    borders[1][1] >= bullets[0].rect[1] ||
    bullets[0].rect[1] - borders[1][1] > height
  )
    return
  const ys = [
    borders[0][1],
    borders[1][1],
    ...bullets.slice(1).map((i) => i.rect[1] - 0.05),
    borders[2][1]
  ]
  const groups = ys
    .slice(1)
    .map((y, n) =>
      source.filter((i) => (i.rect[1] + i.rect[3]) / 2 >= ys[n] && (i.rect[1] + i.rect[3]) / 2 < y)
    )
  if (
    !hasUniqueRecordTokens(source, groups) ||
    groups.some((g) => !readSourceRow(g, [left, cut, right]))
  )
    return
  for (const g of groups.slice(1)) {
    const rhs = g.filter((i) => i.rect[0] >= cut)
    if (
      !rhs.some((i) => i.text === '•') ||
      !rhs.some((i) => /\p{L}/u.test(i.text)) ||
      g.some(
        (i) =>
          (i.rect[1] < ys[groups.indexOf(g)] || i.rect[3] > ys[groups.indexOf(g) + 1]) &&
          !g.some((a) => a !== i && isAdjacentTableScript(i, a))
      )
    )
      return
  }
  return {
    rows: ys.slice(1).map((y, n) => [left, ys[n], right, y]),
    columns: [
      [left, top, cut, bottom],
      [cut, top, right, bottom]
    ],
    headerRows: [0],
    spans: [],
    completeSpans: true,
    ownedTokens: new Set(source),
    repair: 'parallel-bullet-records-recovered'
  }
}

// A ruled narrative table has independent paragraph records, not one model row
// per printed line. Native column borders and aligned stub starts own each record.
function recoverParagraphColumns(table, items, predicted, rules) {
  if (predicted.length !== 3) return
  const [left, top, right, bottom] = table.cropRect
  const bands = []
  for (const r of rules
    .filter((r) => r[1] === r[3] && r[1] >= top && r[1] <= bottom)
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])) {
    let band = bands.find((b) => Math.abs(b.y - r[1]) < 0.02)
    if (!band) bands.push((band = { y: r[1], parts: [] }))
    band.parts.push(r)
  }
  const frames = bands.filter(
    (b) =>
      b.parts[0][0] < left + 16 &&
      b.parts.at(-1)[2] > right - 16 &&
      b.parts.every((r, n) => !n || Math.abs(r[0] - b.parts[n - 1][2]) < 0.5)
  )
  if (frames.length < 2 || frames.length > 3 || Math.abs(frames.at(-1).y - bottom) > 16) return
  const boundary = frames.find((b) => b.parts.length === 3)
  if (!boundary) return
  const cuts = [left, ...boundary.parts.slice(1).map((r) => r[0] - 0.1), right]
  const source = tableSourceItems(items, [left, frames[0].y, right, frames.at(-1).y])
  const header = frames.length === 3 ? source.filter((i) => i.rect[3] < frames[1].y) : []
  const body = source.filter((i) => !header.includes(i))
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  if (
    !body.length ||
    body.some((i) => col(i) < 0 || i.rect[0] < cuts[col(i)] || i.rect[2] > cuts[col(i) + 1])
  )
    return
  const height = body.map((i) => i.height).sort((a, b) => a - b)[Math.floor(body.length / 2)]
  const session = body.filter((i) => col(i) === 0 && /^Session \d+$/.test(i.text)).length >= 3
  const labels = (c) => {
    const groups = []
    for (const i of body.filter((i) => col(i) === c)) {
      const previous = groups.at(-1)
      if (
        previous &&
        !(c === 1 && /^[a-z]\.\s*\p{L}/u.test(i.text)) &&
        i.baseline - Math.max(...previous.map((i) => i.baseline)) < height * (session ? 0.3 : 1.6)
      )
        previous.push(i)
      else groups.push([i])
    }
    return groups
  }
  const primary = labels(0),
    secondary = session ? [] : labels(1)
  const starts = [...primary, ...secondary]
    .map((g) => Math.min(...g.map((i) => i.rect[1])))
    .sort((a, b) => a - b)
    .filter((y, n, all) => !n || y - all[n - 1] > height * 0.5)
  if (
    starts.length < 3 ||
    starts.length > 40 ||
    starts[0] - Math.min(...body.map((i) => i.rect[1])) > height
  )
    return
  const ys = [
    frames.length === 3 ? frames[1].y : frames[0].y,
    ...starts.slice(1).map((y) => y - 0.1),
    frames.at(-1).y
  ]
  const groups = ys
    .slice(1)
    .map((y, n) =>
      body.filter((i) => (i.rect[1] + i.rect[3]) / 2 >= ys[n] && (i.rect[1] + i.rect[3]) / 2 < y)
    )
  if (!hasUniqueRecordTokens(source, [...(header.length ? [header] : []), ...groups])) return
  if (
    groups.filter(
      (g) =>
        g
          .filter((i) => col(i) === 2)
          .map((i) => i.text)
          .join(' ').length > 80
    ).length < 3
  )
    return
  const spans = []
  for (const [n, g] of groups.entries()) {
    const label = g.filter((i) => col(i) === 0)
    if (session) {
      if (label.length === 1 && /^Session \d+$/.test(label[0].text)) {
        if (g.length !== 1) return
        spans.push({ row: n + Number(Boolean(header.length)), column: 0, rowSpan: 1, colSpan: 3 })
      }
    } else if (label.length) {
      const next = groups.findIndex((g, j) => j > n && g.some((i) => col(i) === 0))
      spans.push({
        row: n + Number(Boolean(header.length)),
        column: 0,
        rowSpan: (next < 0 ? groups.length : next) - n,
        colSpan: 1
      })
    }
  }
  return {
    rows: [
      ...(header.length ? [[left, frames[0].y, right, frames[1].y]] : []),
      ...ys.slice(1).map((y, n) => [left, ys[n], right, y])
    ],
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans,
    completeSpans: true,
    headerRows: header.length ? [0] : [],
    ownedTokens: new Set(source)
  }
}

// Two consecutive numbered lists share a ruled heading but have independent
// text columns. Native item numbers establish both records and their gutter.
function recoverParallelNumberedLists(table, items, predicted, rules) {
  if (predicted.length < 2 || predicted.length > 4) return
  const [left, top, right, bottom] = table.cropRect
  const source = tableSourceItems(items, table.cropRect)
  const markers = source.filter(
    (i) =>
      /^\d+$/.test(i.text) &&
      source.some(
        (p) =>
          p.text === '.' &&
          Math.abs(p.baseline - i.baseline) < 0.1 &&
          Math.abs(p.rect[0] - i.rect[2]) < 1
      )
  )
  const xs = [...new Set(markers.map((i) => Math.round(i.rect[0])))].sort((a, b) => a - b)
  if (xs.length !== 2) return
  const lists = xs.map((x) =>
    markers.filter((i) => Math.abs(i.rect[0] - x) < 1).sort((a, b) => a.baseline - b.baseline)
  )
  const count = lists[0].length
  if (
    count < 4 ||
    lists[1].length !== count ||
    lists.some((list, c) =>
      list.some(
        (i, n) =>
          Number(i.text) !== c * count + n + 1 ||
          Math.abs(i.baseline - lists[0][n].baseline) > i.height * 0.2
      )
    )
  )
    return
  const borders = rules.filter(
    (r) => r[1] === r[3] && r[0] <= xs[0] + 1 && r[2] >= right - 12 && r[1] >= top && r[1] <= bottom
  )
  const divider = borders.find(
    (r) => r[1] < lists[0][0].rect[1] && lists[0][0].rect[1] - r[1] < lists[0][0].height
  )
  const footer = borders.find((r) => r[1] > lists[0].at(-1).rect[3])
  if (!divider || !footer) return
  const head = source.filter((i) => i.rect[3] < divider[1]),
    body = source.filter((i) => i.rect[1] > divider[1] && i.rect[3] < footer[1])
  if (
    head.length !== 1 ||
    !/^\p{Lu}[\p{L} -]+$/u.test(head[0].text) ||
    !borders.some((r) => r[1] < head[0].rect[1])
  )
    return
  const leftText = body.filter((i) => i.rect[0] < xs[1] - 1)
  const gutter =
    (Math.max(...leftText.map((i) => i.rect[2])) + Math.min(...lists[1].map((i) => i.rect[0]))) / 2
  if (leftText.some((i) => i.rect[2] >= xs[1] - 1)) return
  const ys = [divider[1], ...lists[0].slice(1).map((i) => i.rect[1] - 0.1), footer[1]]
  const records = lists[0].map((_, n) =>
    body.filter((i) => i.rect[1] >= ys[n] && i.rect[3] <= ys[n + 1])
  )
  if (
    !hasUniqueRecordTokens(source, [head, ...records]) ||
    records.some((g, n) => {
      const values = readSourceRow(g, [left, gutter, right])
      return (
        !values ||
        values.some((v, c) => !v.startsWith(`${c * count + n + 1}.`) || !/\p{L}/u.test(v))
      )
    })
  )
    return
  return {
    rows: [
      [left, head[0].rect[1], right, divider[1]],
      ...records.map((_, n) => [left, ys[n], right, ys[n + 1]])
    ],
    columns: [
      [left, top, gutter, bottom],
      [gutter, top, right, bottom]
    ],
    headerRows: [0],
    spans: [{ row: 0, column: 0, rowSpan: 1, colSpan: 2 }],
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// A boxed checklist has repeated, adjoining header/footer rule segments and
// sign-only value columns. Its wrapped section headings span the whole matrix.
function recoverRuledChecklist(table, items, rules) {
  const [left, top, right, bottom] = table.cropRect
  if (
    !items.some(
      (i) =>
        /^Box\s+\d+$/.test(i.text.trim()) &&
        i.rect[3] <= top &&
        top - i.rect[3] < i.height &&
        Math.abs(i.rect[0] - left) < i.height
    )
  )
    return
  const horizontal = rules.filter(
    (r) => r[1] === r[3] && r[1] >= top && r[1] <= bottom && r[0] >= left && r[2] <= right + 1
  )
  const bands = []
  for (const rule of horizontal.sort((a, b) => a[1] - b[1] || a[0] - b[0])) {
    let band = bands.find((b) => Math.abs(b[0][1] - rule[1]) < 1)
    if (!band) bands.push((band = []))
    band.push(rule)
  }
  if (
    bands.length !== 3 ||
    bands.some(
      (b) =>
        b.length < 3 ||
        b.length > 6 ||
        b.length !== bands[0].length ||
        b.some((r, n) => n && Math.abs(r[0] - b[n - 1][2]) > 1)
    )
  )
    return
  const cuts = [left, ...bands[0].slice(1).map((r) => r[0] - 0.1), right]
  if (bands.some((b) => b.slice(1).some((r, n) => Math.abs(r[0] - cuts[n + 1]) > 1))) return
  const source = tableSourceItems(items, [left, bands[0][0][1], right, bands[2][0][1]])
  const header = source.filter((i) => i.rect[3] < bands[1][0][1])
  const values = readSourceRow(header, cuts)
  if (!values || values[0] || values.slice(1).some((v) => !/[a-z]/i.test(v))) return
  const body = source.filter((i) => !header.includes(i))
  const anchors = body.filter((i) => i.rect[0] >= cuts[1] && /^[✓✔−–/ -]+$/.test(i.text.trim()))
  const ys = [...new Set(anchors.map((i) => Math.round(i.baseline)))].sort((a, b) => a - b)
  if (ys.length < 4 || ys.length > 20) return
  const sections = body.filter((i) => i.rect[0] < cuts[1] && i.rect[2] > cuts[2])
  if (
    sections.length < 2 ||
    sections.some((i) => ys.some((y) => Math.abs(y - i.baseline) < i.height * 0.5))
  )
    return
  const starts = [
    ...ys.map((y) => ({ y, section: false })),
    ...sections.map((i) => ({ y: i.baseline, section: true }))
  ].sort((a, b) => a.y - b.y)
  const groups = starts.map((s, n) =>
    body.filter(
      (i) => i.baseline >= s.y - 1 && (n === starts.length - 1 || i.baseline < starts[n + 1].y - 1)
    )
  )
  if (!hasUniqueRecordTokens(body, groups)) return
  for (let n = 0; n < groups.length; n++) {
    if (starts[n].section) continue
    const v = readSourceRow(groups[n], cuts)
    if (!v || !/[a-z]/i.test(v[0]) || v.slice(1).some((x) => !x || !/^[✓✔−–/ -]+$/.test(x))) return
  }
  const rects = [union(header), ...groups.map(union)]
  if (rects.some((r, n) => n && r[1] <= rects[n - 1][3])) return
  return {
    rows: rects.map((r) => [left, r[1], right, r[3]]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], top, x, bottom]),
    headerRows: [0],
    spans: starts.flatMap((s, n) =>
      s.section ? [{ row: n + 1, column: 0, rowSpan: 1, colSpan: cuts.length - 1 }] : []
    ),
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Independently ruled narrative columns retain their own paragraph spans.
// A long paragraph can cross several week/test rows without being split.
function recoverSegmentedNarrativeColumns(table, items, predicted, rules) {
  if (![3, 4].includes(predicted.length)) return
  const [left, top, right, bottom] = table.cropRect
  const horizontal = rules.filter(
    (r) => r[1] === r[3] && r[1] > top && r[1] <= bottom + 10 && r[0] >= left && r[2] <= right + 20
  )
  const segments = []
  for (const r of horizontal) {
    let g = segments.find((g) => Math.abs(g[0][0] - r[0]) < 0.1 && Math.abs(g[0][2] - r[2]) < 0.1)
    if (!g) segments.push((g = []))
    g.push(r)
  }
  const regular = segments.filter((g) => g.length >= 3).sort((a, b) => a[0][0] - b[0][0])
  if (!regular.length) return
  // The second column supplies every row; a shorter first-column segment
  // marks groups. A three-column schedule may have no first-column rules.
  const modelSecond = left + predicted[1].rect[0]
  const primary = regular.find((g) => Math.abs(g[0][0] - modelSecond) < 40)
  if (!primary) return
  const chain = [primary]
  while (chain.length < predicted.length - 1) {
    const next = segments.find((g) => g.length >= 2 && Math.abs(g[0][0] - chain.at(-1)[0][2]) < 0.1)
    if (!next) return
    chain.push(next)
  }
  const cuts = [left, ...chain.map((g) => g[0][0] - 0.1), right]
  if (cuts.some((x, n) => n && x <= cuts[n - 1])) return
  const source = tableSourceItems(items, table.cropRect)
  const first = source[0],
    header = source.filter((i) => Math.abs(i.baseline - first.baseline) < first.height * 0.3)
  const head = readSourceRow(header, cuts)
  if (!head || head.some((v) => !/[a-z]/i.test(v))) return
  const body = source.filter((i) => !header.includes(i)),
    start = (union(header)[3] + Math.min(...body.map((i) => i.rect[1]))) / 2
  const ends = primary.map((r) => r[1]).sort((a, b) => a - b)
  if (ends.length < 4 || ends.length > 30 || body.some((i) => i.rect[3] > ends.at(-1))) return
  const edges = [start, ...ends]
  const stub = segments.find((g) => Math.abs(g[0][2] - primary[0][0]) < 0.1 && g[0][0] < left + 15)
  const columnBands = [stub ?? primary, ...chain]
  const spans = [],
    owned = []
  for (let c = 0; c < columnBands.length; c++) {
    const ys = [start, ...columnBands[c].map((r) => r[1]).sort((a, b) => a - b)]
    if (ys.at(-1) !== edges.at(-1) || ys.some((y) => !edges.some((e) => Math.abs(e - y) < 0.1)))
      return
    for (let n = 0; n < ys.length - 1; n++) {
      const g = body.filter(
        (i) =>
          i.rect[0] >= cuts[c] &&
          i.rect[2] <= cuts[c + 1] &&
          i.rect[1] >= ys[n] &&
          i.rect[3] <= ys[n + 1]
      )
      const row = edges.findIndex((y) => Math.abs(y - ys[n]) < 0.1) + 1,
        end = edges.findIndex((y) => Math.abs(y - ys[n + 1]) < 0.1) + 1
      if (c === 1 && !g.some((i) => /[a-z]/i.test(i.text))) return
      if (g.length) owned.push(g)
      if (end - row > 1) spans.push({ row, column: c, rowSpan: end - row, colSpan: 1 })
    }
  }
  if (!hasUniqueRecordTokens(body, owned) || !spans.length) return
  return {
    rows: [
      [left, union(header)[1], right, start],
      ...ends.map((y, n) => [left, edges[n], right, Math.min(y, bottom)])
    ],
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    headerRows: [0],
    spans,
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}
