/* eslint-disable @typescript-eslint/explicit-function-return-type */
import {
  hasHorizontalTableRuleBetween,
  joinHorizontalTableRules
} from './literature-pdf-table-rules.mjs'
import {
  readSourceRow,
  groupSourceRowsWithScripts,
  splitOwnedSourceRow,
  splitOwnedSourceRows
} from './literature-pdf-source-records.mjs'
import { area, intersection } from './literature-pdf-page-geometry.mjs'
import { inside, union, isAdjacentTableScript } from './literature-pdf-table-geometry.mjs'

// An N/mean/median/range block has its own explicit native start. A predicted
// ancestor span can begin one category too early; do not move genuinely
// centered group labels, or infer a statistic block from ordinary prose.
export function reconcileStatisticStubStarts({ cells, baseCells, rows, rules, repairs }) {
  for (const cell of [...cells]) {
    if (
      cell.origin === 'model-span' &&
      cell.column === 0 &&
      cell.colSpan === 1 &&
      cell.rowSpan === 2 &&
      cell.sourceRects.length === 1
    ) {
      const headings = [1, 2, 3, 4].map((column) =>
        cells.find(
          (c) => c.row === cell.row && c.column === column && c.rowSpan === 1 && c.colSpan === 1
        )
      )
      const measured = [1, 2, 3, 4].map((column) =>
        cells.find(
          (c) => c.row === cell.row + 1 && c.column === column && c.rowSpan === 1 && c.colSpan === 1
        )
      )
      const native = cell.sourceRects[0],
        h = native[3] - native[1]
      const first = baseCells.find((c) => c.row === cell.row && c.column === 0)
      if (
        first &&
        h > 0 &&
        headings.every(Boolean) &&
        measured.every(Boolean) &&
        headings.map((c) => c.text.replace(/\s/g, '')).join('|') === 'M(SD)|M(SD)|t|p' &&
        measured.every(
          (c) =>
            /^[−–+-]?(?:\d|\.\d)[\d\s.,()%*−–+-]*$/.test(c.text) &&
            c.sourceRects.length &&
            c.sourceRects.every((r) => Math.abs(r[3] - native[3]) < h * 0.1)
        ) &&
        headings.every(
          (c) => c.sourceRects.length === 1 && native[3] - c.sourceRects[0][3] > h * 0.8
        ) &&
        !hasHorizontalTableRuleBetween(rules, native[1], native[3])
      ) {
        cells.push({ ...first, text: '', sourceRects: [], sourceTokens: [] })
        cell.row++
        cell.rowSpan = 1
        cell.rect = [cell.rect[0], rows[cell.row].rect[1], cell.rect[2], cell.rect[3]]
        repairs.push('source-stub-span-inferred')
      }
      continue
    }
    if (
      cell.origin !== 'model-span' ||
      cell.column !== 0 ||
      cell.colSpan !== 1 ||
      cell.rowSpan !== 5 ||
      cell.sourceRects.length !== 1
    )
      continue
    const leaves = [0, 1, 2, 3, 4].map((n) =>
      cells.find(
        (c) => c.row === cell.row + n && c.column === 1 && c.rowSpan === 1 && c.colSpan === 1
      )
    )
    if (
      leaves.some((c) => !c) ||
      /^N$/i.test(leaves[0].text) ||
      !/^N$/i.test(leaves[1].text) ||
      !/^Mean\s*\((?:SD|SE)\)$/i.test(leaves[2].text) ||
      !/^Median$/i.test(leaves[3].text) ||
      !/^(?:Range|Min\s*-\s*Max)$/i.test(leaves[4].text)
    )
      continue
    const native = cell.sourceRects[0],
      n = leaves[1].sourceRects
    const h = native[3] - native[1]
    if (
      n.length !== 1 ||
      h <= 0 ||
      Math.abs(native[3] - n[0][3]) > h * 0.1 ||
      leaves[0].sourceRects.some((r) => n[0][3] - r[3] < h * 0.8) ||
      hasHorizontalTableRuleBetween(rules, native[1], native[3])
    )
      continue
    const first = baseCells.find((c) => c.row === cell.row && c.column === 0)
    if (!first || !rows[cell.row + 1]) continue
    cells.push({ ...first, text: '', sourceRects: [], sourceTokens: [] })
    cell.row++
    cell.rowSpan--
    cell.rect = [cell.rect[0], rows[cell.row].rect[1], cell.rect[2], cell.rect[3]]
    repairs.push('source-stub-span-inferred')
  }
}

// A wrapped author/year record can retain its final citation below a short
// model row. The citation and repeated neighboring reference records bound a
// narrow tail, including multiline bullet results in independent columns.
export function recoverCitedRecordTails({ rows, items, columnRects, rules, repairs }) {
  if (columnRects.length < 5 || rows.length < 4) return
  const column = (i) => columnRects.findIndex((r) => inside(r, i))
  const height = Math.max(...items.filter((i) => column(i) === 0).map((i) => i.height))
  if (!(height > 0)) return
  const stub = items.filter((i) => column(i) === 0 && i.horizontal)
  const groups = groupSourceRowsWithScripts(
    [...stub].sort((a, b) => a.baseline - b.baseline),
    height,
    0.25
  )
  if (!groups) return
  const text = (g) =>
    [...g]
      .sort((a, b) => a.rect[0] - b.rect[0])
      .map((i) => i.text)
      .join(' ')
  const authors = groups.filter((g) => /^\p{Lu}[\p{L}’'.-]+\s+et al\.$/u.test(text(g)))
  if (authors.length < 3) return
  const borders = joinHorizontalTableRules(rules, height * 0.1).filter(
    (r) =>
      Math.abs(r[0] - columnRects[0][0]) < height && Math.abs(r[2] - columnRects.at(-1)[2]) < height
  )
  if (borders.length < 3) return
  for (let n = 1; n < authors.length - 1; n++) {
    const author = authors[n],
      next = authors[n + 1]
    const row = rows.find((r) => author.every((i) => inside(r.rect, i)))
    if (!row) continue
    const reference = groups.filter(
      (g) => g[0].baseline > author[0].baseline && g[0].baseline < next[0].baseline
    )
    if (
      reference.length !== 2 ||
      !/^\((?:19|20)\d{2}(?:,\s*(?:19|20)\d{2})*\)$/.test(text(reference[0])) ||
      !/^\[\d+(?:[,–-]\s*\d+)*\]$/.test(text(reference[1]))
    )
      continue
    const citation = reference[1],
      box = union(citation)
    if (
      box[3] <= row.rect[3] ||
      box[1] - row.rect[3] > height * 1.5 ||
      box[3] - row.rect[3] > height * 3 ||
      box[1] < row.rect[1]
    )
      continue
    const nextRow = rows[rows.indexOf(row) + 1]
    if (
      !nextRow ||
      box[3] + height * 0.02 >= nextRow.rect[1] ||
      hasHorizontalTableRuleBetween(rules, row.rect[3], box[3])
    )
      continue
    const tail = items.filter(
      (i) => i.rect[1] >= row.rect[1] && i.rect[3] <= box[3] && !inside(row.rect, i)
    )
    const columns = [...new Set(tail.map(column))].filter((c) => c !== 0)
    if (
      columns.length < 2 ||
      tail.some(
        (i) =>
          !i.horizontal ||
          column(i) < 0 ||
          Math.abs(i.height - height) > height * 0.15 ||
          rows.some((r) => r !== row && inside(r.rect, i))
      )
    )
      continue
    if (
      columns.some((c) => {
        const parts = tail
          .filter((i) => column(i) === c)
          .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
        const lines = groupSourceRowsWithScripts(parts, height, 0.25)
        return (
          !lines ||
          lines.length !== 2 ||
          !/^[-–—]\s+\p{L}/u.test(text(lines[0])) ||
          !/\d/.test(text(lines[0])) ||
          !/\d/.test(text(lines[1])) ||
          Math.abs(lines[1][0].baseline - lines[0][0].baseline) > height * 1.5
        )
      })
    )
      continue
    row.rect[3] = box[3] + height * 0.02
    repairs.push('wrapped-source-row-recovered')
  }
}

// Repeated complete section records can repair an unmerged title without a
// model span. Require several independently merged witnesses and native ownership.
export function reconcileRepeatedSectionHeadings({ cells, rows, items, rules, repairs }) {
  const width = Math.max(...cells.map((c) => c.column + c.colSpan))
  if (width < 3) return
  const at = (row) => cells.filter((c) => c.row === row).sort((a, b) => a.column - b.column)
  const normal = (cell) =>
    (cell.textRuns
      ? cell.textRuns
          .filter((r) => r.position === 'normal')
          .map((r) => r.text)
          .join('')
      : cell.text
    ).trim()
  const complete = (record) =>
    record.length === width &&
    record.every(
      (c, n) =>
        c.column === n &&
        c.colSpan === 1 &&
        c.rowSpan === 1 &&
        c.sourceRects.length &&
        (n ? /^[<>≤≥−+-]?\d[\d\s.,()%±–−+*/<>≤≥-]*$/.test(normal(c)) : /^\p{L}/u.test(c.text))
    )
  const children = (row) => [at(row + 1), at(row + 2)]
  const witnesses = cells.filter(
    (c) =>
      c.column === 0 &&
      c.colSpan === width &&
      c.rowSpan === 1 &&
      /^\p{L}/u.test(c.text) &&
      c.sourceRects.length &&
      at(c.row).length === 1 &&
      children(c.row).every(complete)
  )
  if (witnesses.length < 3) return
  const source = (c) =>
    items.filter((i) => c.sourceRects.some((r) => r.every((v, n) => v === i.rect[n])))
  for (let row = 1; row + 2 < rows.length; row++) {
    const record = at(row),
      heading = record[0]
    if (
      record.length !== width ||
      record.some(
        (c, n) =>
          c.column !== n ||
          c.colSpan !== 1 ||
          c.rowSpan !== 1 ||
          (n ? c.text || c.sourceRects.length : !/^\p{L}/u.test(c.text) || !c.sourceRects.length)
      ) ||
      !children(row).every(complete)
    )
      continue
    const parts = source(heading).sort((a, b) => a.rect[0] - b.rect[0])
    if (parts.length !== heading.sourceRects.length || !parts.every((i) => i.horizontal)) continue
    const h = Math.max(...parts.map((i) => i.height)),
      rect = union(parts)
    if (parts.some((i) => Math.abs(i.baseline - parts[0].baseline) > h * 0.2 || i.height < h * 0.8))
      continue
    const matching = witnesses.filter((c) => {
      const other = source(c)
      return (
        other.length === c.sourceRects.length &&
        other.every((i) => i.horizontal && Math.abs(i.height - h) <= h * 0.1) &&
        Math.abs(Math.min(...other.map((i) => i.rect[0])) - rect[0]) <= h * 0.2 &&
        children(c.row).every((r, n) => r[0].text === children(row)[n][0].text)
      )
    })
    if (matching.length < 3) continue
    const full = union(record),
      nextSource = at(row + 1).flatMap((c) => c.sourceRects)
    if (
      rules.some(
        (r) =>
          (r[1] === r[3] &&
            r[1] > rect[1] + h * 0.2 &&
            r[1] <
              Math.min(
                ...nextSource.filter((s) => s[3] - s[1] >= h * 0.8).map((s) => (s[1] + s[3]) / 2)
              ) &&
            r[0] < full[2] &&
            r[2] > full[0]) ||
          (r[0] === r[2] && r[0] > full[0] && r[0] < full[2] && r[1] < full[3] && r[3] > full[1])
      )
    )
      continue
    if (items.some((i) => intersection(full, i.rect) > 0 && !parts.includes(i))) continue
    heading.colSpan = width
    heading.rect = full
    for (const cell of record.slice(1)) cells.splice(cells.indexOf(cell), 1)
    repairs.push('section-heading-span-reconciled')
  }
}

// Resource records start with aligned name/source/identifier fields. Native
// section borders distinguish headings from wrapped labels; every other line
// must have exactly one preceding record owner before replacing model bands.
function recoverResourceRows({ rows, items, columnRects, rules, repairs }) {
  if (columnRects.length !== 3 || items.some((item) => !item.horizontal)) return
  const cuts = [columnRects[0][0], ...columnRects.map((rect) => rect[2])]
  const heights = items.map((item) => item.height).sort((a, b) => a - b)
  const height = heights[Math.floor(heights.length / 2)]
  const source = items.slice().sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
  const lines = groupSourceRowsWithScripts(source, height, 0.35)
  if (!lines || lines.length < 10) return
  const values = lines.map((line) => readSourceRow(line, cuts))
  if (
    values.some((value) => !value) ||
    !/^(?:REAGENTorRESOURCE|RESOURCE)$/i.test(values[0][0]) ||
    values[0][1] !== 'SOURCE' ||
    values[0][2] !== 'IDENTIFIER'
  )
    return
  const bounds = lines.map(union)
  const borders = rules.filter(
    (rule) =>
      rule[1] === rule[3] &&
      Math.abs(rule[0] - cuts[0]) < height * 1.5 &&
      Math.abs(rule[2] - cuts[3]) < height * 1.5
  )
  const bordered = (rect, below) =>
    borders.some((rule) => {
      const gap = below ? rule[1] - rect[3] : rect[1] - rule[1]
      return gap >= 0 && gap < height
    })
  if (!bordered(bounds[0], true) || !bordered(bounds.at(-1), true)) return
  const records = [{ members: [...lines[0]], section: false }]
  let sections = 0,
    complete = 0,
    wrapped = 0
  for (let n = 1; n < lines.length; n++) {
    const value = values[n],
      line = lines[n],
      rect = bounds[n]
    if (value.every(Boolean)) {
      if (!/\p{L}/u.test(value[0]) || !/\p{L}/u.test(value[1])) return
      records.push({ members: [...line], section: false })
      complete++
    } else if (
      value[0] &&
      !value[1] &&
      !value[2] &&
      bordered(rect, false) &&
      bordered(rect, true)
    ) {
      if (!/\p{L}/u.test(value[0])) return
      records.push({ members: [...line], section: true })
      sections++
    } else {
      const previous = records.at(-1)
      if (
        previous.section ||
        records.length === 1 ||
        // A fresh URL or catalog identifier is a record even if its source is blank.
        /^(?:https?:\/\/|N\/A$|[A-Z]*\d[\w./–−-]*$)/i.test(value[2]) ||
        rect[1] <= bounds[n - 1][3] ||
        line[0].baseline - lines[n - 1][0].baseline > height * 1.5 ||
        hasHorizontalTableRuleBetween(rules, bounds[n - 1][3], rect[1]) ||
        line.some((item) => {
          const column = columnRects.findIndex((r) => inside(r, item))
          if (column < 0) return true
          const anchors = previous.members.filter((anchor) => inside(columnRects[column], anchor))
          return (
            !anchors.length ||
            Math.abs(item.rect[0] - Math.min(...anchors.map((a) => a.rect[0]))) > height
          )
        })
      )
        return
      previous.members.push(...line)
      wrapped++
    }
  }
  if (sections < 2 || complete < 6 || wrapped < 2) return
  rows.splice(
    0,
    rows.length,
    ...records.map(({ members, section }) => {
      const rect = union(members)
      return { rect: [cuts[0], rect[1], cuts[3], rect[3]], origin: 'source-text', section }
    })
  )
  repairs.push('text-supported-wrapped-records-recovered')
  return true
}

// Mutates row bands and appends repair reasons before ruled-grid recovery.
// Some total records put the combined amount on a second, unlabelled line.
// The native amount must exactly sum the preceding decimal totals, align with
// their first column, and sit above a nearby closing rule. Never synthesize it.
function recoverTerminalAggregate({ rows, sourceRows, cuts, rules, repairs }) {
  const tail = sourceRows.at(-1),
    prior = sourceRows.at(-2)
  if (!tail || !prior || tail.length !== 1 || rows.length < 3) return
  const amount = tail[0]
  const decimal = (s) => /^(?:\d+|\d{1,3}(?:,\d{3})+)\.\d{2}$/.test(s)
  const cents = (s) => Number(s.replace(/[,.]/g, ''))
  const values = readSourceRow(prior, cuts)
  if (!values || !/^Total(?:costs?|expenses?|amount)?$/i.test(values[0])) return
  const totals = values.slice(1).flatMap((v, n) => (v ? [{ value: v, column: n + 1 }] : []))
  if (
    totals.length < 2 ||
    totals.some((t) => !decimal(t.value)) ||
    !decimal(amount.text) ||
    ![amount.text, ...totals.map((t) => t.value)].every((v) => Number.isSafeInteger(cents(v))) ||
    totals.reduce((sum, t) => sum + cents(t.value), 0) !== cents(amount.text)
  )
    return
  const preceding = rows.at(-1),
    first = prior.filter(
      (i) => i.rect[0] >= cuts[totals[0].column] && i.rect[2] <= cuts[totals[0].column + 1]
    )
  if (
    !prior.every((i) => inside(preceding.rect, i)) ||
    first.length !== 1 ||
    Math.abs(amount.rect[0] - first[0].rect[0]) > 1 ||
    Math.abs(amount.height - first[0].height) > 0.1 ||
    amount.rect[1] <= preceding.rect[3] ||
    amount.baseline - first[0].baseline > amount.height * 2.5 ||
    amount.rect[2] > cuts[totals[0].column + 1] ||
    hasHorizontalTableRuleBetween(rules, union(prior)[3], amount.rect[1]) ||
    !rules.some(
      (r) =>
        r[1] === r[3] &&
        r[1] >= amount.rect[3] &&
        r[1] - amount.rect[3] < amount.height &&
        Math.min(r[2], cuts.at(-1)) - Math.max(r[0], cuts[0]) > (cuts.at(-1) - cuts[0]) * 0.85
    )
  )
    return
  rows.push({
    rect: [cuts[0], amount.rect[1], cuts.at(-1), amount.rect[3]],
    origin: 'source-text',
    numericRecord: true
  })
  repairs.push('terminal-total-row-recovered')
}

// A terminal paired-comparison arm can fall below the last model band. Both
// arm names must already own complete measured records; the comparison syntax
// and the common column positions establish the sparse final row.
function recoverTerminalComparison({ rows, sourceRows, cuts, rules, repairs }) {
  const tail = sourceRows.at(-1),
    prior = sourceRows.at(-2),
    last = rows.at(-1)
  if (!tail || !prior || !last || cuts.length < 5) return
  const a = readSourceRow(prior, cuts),
    b = readSourceRow(tail, cuts)
  if (!a || !b || !/^Pairedcomparisons?$/i.test(a[0])) return
  const c = a.findIndex((v, n) => n > 0 && /\p{L}/u.test(v))
  const contrast = (v) => /^(?:[—–-]|\d+[<>]\d+(?:;\d+[<>]\d+)*)$/.test(v)
  if (
    c < 1 ||
    c + 1 >= a.length ||
    !/^\p{L}[\p{L}-]*$/u.test(b[c]) ||
    a[c] === b[c] ||
    !contrast(a[c + 1]) ||
    !contrast(b[c + 1]) ||
    a.some((v, n) => v && ![0, c, c + 1].includes(n)) ||
    b.some((v, n) => v && ![c, c + 1].includes(n))
  )
    return
  const witnesses = [a[c], b[c]].every((label) =>
    sourceRows.some((g) => {
      const v = readSourceRow(g, cuts)
      return (
        v?.[0] === label && v.filter((s) => /^\d+(?:\.\d+)?±\d+(?:\.\d+)?$/.test(s)).length >= 3
      )
    })
  )
  if (!witnesses) return
  appendUnownedTerminalRow({ rows, tail, prior, cuts, rules, repairs })
}

// A complete interaction follows its two independently owned main effects.
// Match the factor names and both numeric fields instead of guessing from a
// lone footer label or interpreting the statistic's numerical significance.
function recoverTerminalInteraction({ rows, sourceRows, cuts, rules, repairs }) {
  const groups = sourceRows.slice(-3)
  if (groups.length !== 3 || cuts.length < 4 || rows.length < 2) return
  const records = groups.map((g) => readSourceRow(g, cuts))
  const column = cuts.length - 4
  if (
    records.some(
      (r) =>
        !r ||
        r.slice(0, column).some(Boolean) ||
        !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(r[column + 1]) ||
        !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(r[column + 2])
    ) ||
    !records.slice(0, 2).every((r) => /^\p{L}+$/u.test(r[column])) ||
    records[0][column] === records[1][column] ||
    records[2][column] !== `${records[0][column]}×${records[1][column]}` ||
    !groups[0].every((i) => inside(rows.at(-2).rect, i))
  )
    return
  appendUnownedTerminalRow({ rows, tail: groups[2], prior: groups[1], cuts, rules, repairs })
}

function appendUnownedTerminalRow({ rows, tail, prior, cuts, rules, repairs }) {
  const last = rows.at(-1),
    bounds = union(tail),
    previous = union(prior),
    height = tail[0].height
  if (
    !prior.every((i) => inside(last.rect, i)) ||
    tail.some((i) => rows.some((r) => inside(r.rect, i))) ||
    bounds[1] <= last.rect[3] ||
    bounds[1] <= previous[3] ||
    bounds[3] - previous[3] > height * 2 ||
    hasHorizontalTableRuleBetween(rules, previous[3], bounds[1])
  )
    return
  rows.push({ rect: [cuts[0], bounds[1], cuts.at(-1), bounds[3]], origin: 'source-text' })
  repairs.push('unowned-repeated-record-recovered')
}

export function repairWrappedTableRows({
  rows,
  items,
  groups = [],
  columnRects,
  rules,
  right,
  repairs,
  captioned = false,
  headers = []
}) {
  if (recoverResourceRows({ rows, items, columnRects, rules, repairs })) return
  const columnOf = (item) => columnRects.findIndex((column) => inside(column, item))
  // Complete source records can fall between predicted bands, including a
  // final Total row whose only model-owned glyphs are superscripts. Require
  // repeated column signatures and preserve every neighboring source owner.
  const fontSizes = items.map((i) => i.height).sort((a, b) => a - b)
  const font = fontSizes[Math.floor(fontSizes.length / 2)]
  const sourceRows =
    groupSourceRowsWithScripts(
      [...items].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0]),
      font,
      0.35
    ) ?? []
  const sourceCuts = [columnRects[0]?.[0], ...columnRects.map((r) => r[2])]
  const inFullRow = (r, i) =>
    inside([columnRects[0][0], r.rect[1], columnRects.at(-1)[2], r.rect[3]], i)
  // A detector can invent a terminal row for the second half of a hyphenated
  // field. Several simultaneously continued lanes and one literal hyphen
  // witness the preceding record; an independent stub remains a new record.
  if (captioned && columnRects.length >= 3 && rows.length >= 3) {
    const tail = rows.at(-1),
      head = rows.at(-2),
      a = items.filter((i) => inFullRow(head, i)),
      b = items.filter((i) => inFullRow(tail, i)),
      h = Math.max(...b.map((i) => i.height)),
      cols = [...new Set(b.map(columnOf))]
    const unfinished = cols.some((c) => {
      const text = a
        .filter((i) => columnOf(i) === c)
        .map((i) => i.text)
        .join('')
      return (
        (text.match(/\(/g)?.length ?? 0) > (text.match(/\)/g)?.length ?? 0) &&
        b.filter((i) => columnOf(i) === c).some((i) => i.text.includes(')'))
      )
    })
    const parallelWrap =
      cols.length >= 2 &&
      cols.every(
        (c) =>
          new Set(
            a.filter((i) => columnOf(i) === c && /\p{L}{2}/u.test(i.text)).map((i) => i.baseline)
          ).size >= 2
      )
    const closedProseTail =
      (unfinished || parallelWrap) &&
      cols.every((c) => b.some((i) => columnOf(i) === c && /^[a-z]{2}/u.test(i.text))) &&
      b.every((i) => i.horizontal && Math.abs(i.height - h) < h * 0.1) &&
      rules.some(
        (r) =>
          r[1] === r[3] &&
          r[0] <= columnRects[0][0] + h &&
          r[2] >= right - h &&
          r[1] >= union(b)[3] &&
          r[1] - union(b)[3] < h
      ) &&
      rows
        .slice(1, -2)
        .filter(
          (r) =>
            new Set(
              items
                .filter((i) => inFullRow(r, i) && columnOf(i) > 0 && /\p{L}{2}/u.test(i.text))
                .map((i) => i.baseline)
            ).size >= 2
        ).length >= 2
    if (
      b.length &&
      cols.length >= 2 &&
      !cols.includes(0) &&
      cols.every((c) => c > 0) &&
      a.some((i) => columnOf(i) === 0 && /\p{L}/u.test(i.text)) &&
      !a.some((i) => b.includes(i)) &&
      (closedProseTail ||
        b.every(
          (i) => i.horizontal && /^[a-z]/.test(i.text) && Math.abs(i.height - h) < h * 0.1
        )) &&
      cols.every((c) => {
        const before = a
            .filter((i) => columnOf(i) === c)
            .sort((x, y) => x.baseline - y.baseline || x.rect[0] - y.rect[0]),
          after = b.filter((i) => columnOf(i) === c),
          last = before.at(-1)
        return (
          last &&
          Math.abs(union(after)[0] - Math.min(...before.map((i) => i.rect[0]))) < h * 0.3 &&
          after[0].baseline - last.baseline >= h * 0.9 &&
          after[0].baseline - last.baseline <= h * 1.6
        )
      }) &&
      (closedProseTail ||
        cols.some((c) =>
          a
            .filter((i) => columnOf(i) === c)
            .sort((x, y) => x.baseline - y.baseline || x.rect[0] - y.rect[0])
            .at(-1)
            ?.text.endsWith('-')
        )) &&
      !hasHorizontalTableRuleBetween(rules, union(a)[3], union(b)[1]) &&
      !items.some((i) => inside(union([head, tail]), i) && !a.includes(i) && !b.includes(i))
    ) {
      head.rect = union([head, tail])
      rows.pop()
      repairs.push('recovered-row-continuation-included')
    }
  }
  repairCountedIntervalTails({ rows, items, columnRects, rules, repairs, sourceRows })
  // A single wrapped measurement can split the cohort values from its
  // probability. Require complementary numeric columns and an unfinished
  // grammatical stub, or a hanging unit witnessed in another measured label.
  for (let n = 1; captioned && columnRects.length >= 3 && n < sourceRows.length; n++) {
    const a = sourceRows[n - 1],
      b = sourceRows[n],
      av = readSourceRow(a, sourceCuts),
      bv = readSourceRow(b, sourceCuts)
    if (!av || !bv || !av[0] || !bv[0]) continue
    const aStub = a.filter((i) => columnOf(i) === 0),
      bStub = b.filter((i) => columnOf(i) === 0)
    const numeric = (s) => /^[<>≤≥−+-]?\d[\d.,%()±–−+\-/]*$/.test(s)
    const complementary =
      av.slice(1, -1).every((s) => !s) &&
      numeric(av.at(-1)) &&
      bv.slice(1, -1).every(numeric) &&
      !bv.at(-1) &&
      /\b(?:a|an|of|in|or|with|and)$/.test(aStub.map((i) => i.text).join(' ')) &&
      /^[a-z]/.test(bv[0])
    const unit = /^[A-Z][a-z]+\s*\(([A-Za-zμ/%0-9-]+)\)$/.exec(bStub.map((i) => i.text).join(' '))
    const unitContinuation =
      unit &&
      av.slice(1).every(numeric) &&
      bv.slice(1).every((s) => !s) &&
      sourceRows.some(
        (g, j) =>
          g !== a &&
          g !== b &&
          g.some((i) => columnOf(i) === 0 && i.text.includes('(' + unit[1] + ')')) &&
          [sourceRows[j - 1], g, sourceRows[j + 1]].some(
            (peer) =>
              peer &&
              Math.abs(peer[0].baseline - g[0].baseline) < font * 1.7 &&
              readSourceRow(peer, sourceCuts)?.slice(1).every(numeric)
          )
      )
    if (!complementary && !unitContinuation) continue
    const x = union(aStub),
      y = union(bStub)
    if (
      y[0] < x[0] - 1 ||
      y[0] - x[0] > font * (unitContinuation ? 2 : 1.5) ||
      y[1] < x[3] - font * 0.1 ||
      b[0].baseline - a[0].baseline > font * (complementary ? 2.5 : 1.7) ||
      hasHorizontalTableRuleBetween(rules, x[3], y[1])
    )
      continue
    const first = rows.findIndex((r) => a.every((i) => inside(r.rect, i))),
      last = rows.findIndex((r) => b.every((i) => inside(r.rect, i)))
    if (
      first < 0 ||
      last !== first + 1 ||
      items.some(
        (i) =>
          (inside(rows[first].rect, i) || inside(rows[last].rect, i)) &&
          !a.includes(i) &&
          !b.includes(i)
      )
    )
      continue
    rows[first].rect[3] = rows[last].rect[3]
    rows.splice(last, 1)
    repairs.push('wrapped-comparison-record-recovered')
  }
  // A lower-case scale label can complete a stub ending in a linking word.
  // Require aligned ink, complete cohort measurements, and no intervening rule;
  // a standalone section title must not absorb the following numeric record.
  for (let n = 0; captioned && n + 1 < sourceRows.length; n++) {
    const head = sourceRows[n],
      tail = sourceRows[n + 1]
    const a = readSourceRow(head, sourceCuts),
      b = readSourceRow(tail, sourceCuts)
    if (
      !a ||
      !b ||
      !a[0] ||
      a.slice(1).some(Boolean) ||
      !/\b(?:of|with|for|towards?|in|from|to)\s*$/i.test(head.map((i) => i.text).join(' ')) ||
      !/^[a-z].*\(\d+[–−-]\d+\)$/.test(b[0]) ||
      b.slice(1).filter((s) => /^\d+(?:\.\d+)?\(\d+(?:\.\d+)?\)$/.test(s)).length < 3
    )
      continue
    const label = tail.filter((i) => columnOf(i) === 0),
      first = union(head),
      second = union(label)
    if (
      Math.abs(first[0] - second[0]) > font * 0.1 ||
      second[1] <= first[3] ||
      second[1] - first[3] > font * 0.5 ||
      hasHorizontalTableRuleBetween(rules, first[3], second[1])
    )
      continue
    const before = rows.find((r) => head.every((i) => inside(r.rect, i))),
      after = rows.find((r) => tail.every((i) => inside(r.rect, i)))
    if (
      !before ||
      !after ||
      before === after ||
      rows.indexOf(after) !== rows.indexOf(before) + 1 ||
      items.some((i) => inside(before.rect, i) && !head.includes(i))
    )
      continue
    after.rect[1] = Math.min(before.rect[1], first[1])
    rows.splice(rows.indexOf(before), 1)
    repairs.push('wrapped-comparison-record-recovered')
  }
  // A complete ordered category sequence distinguishes a section title from
  // the first category even if both landed in the same predicted row.
  for (let n = 0; n + 3 < sourceRows.length; n++) {
    const heading = sourceRows[n],
      records = sourceRows.slice(n + 1, n + 4)
    if (!heading.length || !heading.every((i) => columnOf(i) === 0 && /\p{L}/u.test(i.text)))
      continue
    const values = records.map((g) => readSourceRow(g, sourceCuts))
    if (
      values.some(
        (v) => !v || v.length < 3 || !v.slice(1).every((s) => /^\d+\(\d+(?:\.\d+)?%\)$/.test(s))
      ) ||
      !['I|II|III', '1|2|3'].includes(values.map((v) => v[0]).join('|'))
    )
      continue
    const h = union(heading),
      first = union(records[0])
    if (
      h[3] >= first[1] ||
      first[1] - h[3] > font ||
      first[0] - h[0] < font * 0.5 ||
      records.some((g) => Math.abs(union(g)[0] - first[0]) > font * 0.2)
    )
      continue
    const index = rows.findIndex((r) => [...heading, ...records[0]].every((i) => inside(r.rect, i)))
    if (index < 0 || records.slice(1).some((g) => g.some((i) => inside(rows[index].rect, i))))
      continue
    const original = rows[index],
      split = (h[3] + first[1]) / 2
    if (
      items.some((i) => inside(original.rect, i) && !heading.includes(i) && !records[0].includes(i))
    )
      continue
    rows.splice(
      index,
      1,
      {
        ...original,
        rect: [original.rect[0], original.rect[1], right, split],
        section: true,
        origin: 'source-text'
      },
      {
        ...original,
        rect: [original.rect[0], split, right, original.rect[3]],
        origin: 'source-text'
      }
    )
    repairs.push('wrapped-source-row-recovered')
  }
  // A printed scale range can be captured by the next measured record. Both
  // complete records and the intervening stub-only source line establish its
  // ownership; move the boundary without recreating or inferring any values.
  for (let n = 1; n + 1 < sourceRows.length; n++) {
    const tail = sourceRows[n],
      head = sourceRows[n - 1],
      next = sourceRows[n + 1]
    if (
      !tail.length ||
      tail.some((i) => columnOf(i) !== 0) ||
      !/^\(range\s*[−-]?\d+(?:\.\d+)?\s*[–−-]\s*\d+(?:\.\d+)?\)$/i.test(
        tail.map((i) => i.text).join('')
      )
    )
      continue
    const complete = (g) =>
      columnRects.length >= 3 &&
      g.some((i) => columnOf(i) === 0 && /\p{L}/u.test(i.text)) &&
      columnRects
        .slice(1)
        .every((_, c) => g.some((i) => columnOf(i) === c + 1 && /^[−-]?\d/.test(i.text)))
    if (
      !complete(head) ||
      !complete(next) ||
      union(head)[3] >= union(tail)[1] ||
      union(tail)[3] >= union(next)[1] ||
      tail[0].baseline - Math.max(...head.map((i) => i.baseline)) > tail[0].height * 1.6 ||
      hasHorizontalTableRuleBetween(rules, union(head)[3], union(tail)[1])
    )
      continue
    const before = rows.find((r) => head.every((i) => inside(r.rect, i))),
      after = rows.find((r) => next.every((i) => inside(r.rect, i)))
    if (!before || !after || before === after || !tail.every((i) => inside(after.rect, i))) continue
    const boundary = (union(tail)[3] + union(next)[1]) / 2
    if (
      items.some(
        (i) =>
          !head.includes(i) &&
          !tail.includes(i) &&
          !next.includes(i) &&
          i.rect[1] < boundary &&
          i.rect[3] > before.rect[3]
      )
    )
      continue
    before.rect[3] = boundary
    after.rect[1] = boundary
    repairs.push('wrapped-source-row-recovered')
  }
  if (captioned) recoverTerminalAggregate({ rows, sourceRows, cuts: sourceCuts, rules, repairs })
  recoverTerminalComparison({ rows, sourceRows, cuts: sourceCuts, rules, repairs })
  recoverTerminalInteraction({ rows, sourceRows, cuts: sourceCuts, rules, repairs })
  // Wrapped comparison records retain the numeric columns of their opening
  // line. Repeated, shorter line leading distinguishes label/statistic tails
  // from new records; an open bracket supplies independent continuation proof.
  const continuations = []
  const balance = (text) => (text.match(/[([]/g) ?? []).length - (text.match(/[)\]]/g) ?? []).length
  for (let r = 1; columnRects.length >= 3 && r < rows.length; r++) {
    const prior = items.filter((i) => inside(rows[r - 1].rect, i))
    const values = readSourceRow(prior, sourceCuts, { multiline: true })
    if (!values || values.slice(1).filter((v) => /^\d/.test(v)).length < 2) continue
    const members = [...prior]
    for (let n = r; n < rows.length; n++) {
      const tail = items.filter((i) => inside(rows[n].rect, i))
      const head = members.filter((i) => columnOf(i) === 0)
      const label = tail.filter((i) => columnOf(i) === 0)
      const a = readSourceRow(members, sourceCuts, { multiline: true })
      const b = readSourceRow(tail, sourceCuts, { multiline: true })
      if (!a || !b || !head.length || !label.length) break
      const gap =
        Math.min(...label.map((i) => i.baseline)) - Math.max(...head.map((i) => i.baseline))
      const bracketed = balance(a[0]) > 0 && balance(a[0] + b[0]) >= 0
      if (
        (!bracketed && !/^(?:[a-z]|\(?M±SD\))/.test(b[0])) ||
        gap < font * 0.9 ||
        gap > font * 1.6 ||
        Math.abs(
          Math.min(...label.map((i) => i.rect[0])) - Math.min(...head.map((i) => i.rect[0]))
        ) > font ||
        tail.some(
          (i) =>
            Math.abs(i.height - font) > font * 0.1 && !tail.some((j) => isAdjacentTableScript(i, j))
        ) ||
        b
          .slice(1)
          .some(
            (v, c) =>
              v &&
              !(
                /^\(\d+(?:\.\d+)?\)$/.test(v) &&
                /^\d[\d./]*$/.test(a[c + 1]) &&
                a.slice(1).some((s) => /^\d.*\(\d/.test(s))
              )
          ) ||
        hasHorizontalTableRuleBetween(
          rules,
          Math.max(...head.map((i) => i.rect[3])),
          Math.min(...label.map((i) => i.rect[1]))
        )
      )
        break
      const next =
        rows[n + 1] && items.filter((i) => inside(rows[n + 1].rect, i) && columnOf(i) === 0)
      const nextGap = next?.length
        ? Math.min(...next.map((i) => i.baseline)) - Math.max(...label.map((i) => i.baseline))
        : Infinity
      continuations.push({ index: n, gap, bracketed, separated: nextGap > gap + font * 0.2 })
      members.push(...tail)
      r = n + 1
    }
  }
  for (const candidate of continuations.reverse()) {
    if (
      !candidate.bracketed &&
      continuations.filter(
        (peer) => Math.abs(peer.gap - candidate.gap) < font * 0.05 && peer.separated
      ).length < 3
    )
      continue
    rows[candidate.index - 1].rect[3] = rows[candidate.index].rect[3]
    rows.splice(candidate.index, 1)
    repairs.push('wrapped-comparison-record-recovered')
  }
  // Wide repeated-measure tables may wrap every SD/SE and the stub together.
  // Repeated parenthesized-summary columns prove the continuation; a stub-only
  // tail also needs an identical complete label elsewhere in the same table.
  if (columnRects.length >= 9) {
    for (let n = 1; n < rows.length; n++) {
      const before = rows[n - 1],
        after = rows[n]
      const nextItems = rows[n + 1] ? items.filter((i) => inside(rows[n + 1].rect, i)) : []
      const nextScripts = items.filter((i) =>
        nextItems.some((anchor) => anchor !== i && isAdjacentTableScript(i, anchor))
      )
      const mergedBottom = Math.min(
        after.rect[3],
        rows[n + 1]?.rect[1] ?? after.rect[3],
        ...nextScripts.map((i) => i.rect[1])
      )
      const head = items.filter((i) => inside(before.rect, i)),
        tail = items.filter(
          (i) =>
            inside([after.rect[0], after.rect[1], after.rect[2], mergedBottom], i) &&
            !head.includes(i)
        )
      const a = readSourceRow(head, sourceCuts, { multiline: true }),
        b = readSourceRow(tail, sourceCuts, { multiline: true })
      if (
        !a ||
        !b ||
        !a[0] ||
        !b[0] ||
        !/^\p{Ll}/u.test(b[0]) ||
        a.slice(1).filter(Boolean).length < 8 ||
        union(tail)[1] - union(head)[3] > font * 1.4 ||
        hasHorizontalTableRuleBetween(rules, union(head)[3], union(tail)[1])
      )
        continue
      const continuations = b.slice(1).flatMap((v, c) => (v ? [c + 1] : []))
      const completeLabel = rows.some(
        (r) =>
          r !== before &&
          r !== after &&
          readSourceRow(
            items.filter((i) => inside(r.rect, i)),
            sourceCuts,
            { multiline: true }
          )?.[0] ===
            a[0] + b[0]
      )
      const wrapped =
        continuations.length >= 3 &&
        continuations.every(
          (c) =>
            /^\([−–-]?\d+(?:\.\d+)?\)$/.test(b[c]) &&
            /^[−–-]?\d+(?:\.\d+)?$/.test(a[c]) &&
            items.some((i) => inside(columnRects[c], i) && /\((?:SD|SE)\)/.test(i.text))
        )
      if (!wrapped && !(continuations.length === 0 && completeLabel)) continue
      if (
        head.some((i) => tail.includes(i)) ||
        items.some(
          (i) =>
            inside([sourceCuts[0], before.rect[1], right, mergedBottom], i) &&
            !head.includes(i) &&
            !tail.includes(i)
        )
      )
        continue
      before.rect[3] = mergedBottom
      rows.splice(n--, 1)
      repairs.push('overlapping-wrapped-summary-recovered')
    }
  }
  // Some journal tables print a single observation across two baselines when
  // a value contains a slash (for example mean/SD followed by a second
  // measure). The continuation has no stub, while every populated cell on
  // the first line ends in a slash. Require the next labelled numeric record,
  // adjacent owners, and no intervening rule before folding the bands.
  if (columnRects.length >= 3) {
    const compact = (value) => value?.replace(/\s+/g, '') ?? ''
    const numeric = (value) => /^[<>≤≥−+-]?(?:\d|\.\d)[\d.,()%±*–—−+\-/]*$/u.test(compact(value))
    for (let n = 0; n + 2 < sourceRows.length; n++) {
      const head = sourceRows[n],
        tail = sourceRows[n + 1],
        next = sourceRows[n + 2]
      const headValues = readSourceRow(head, sourceCuts),
        tailValues = readSourceRow(tail, sourceCuts),
        nextValues = readSourceRow(next, sourceCuts)
      if (
        !headValues ||
        !tailValues ||
        !nextValues ||
        !/\p{L}/u.test(headValues[0] ?? '') ||
        tailValues[0] ||
        !/\p{L}/u.test(nextValues[0] ?? '') ||
        headValues.slice(1).length < 2 ||
        !headValues.slice(1).every((value) => /\/$/.test(compact(value))) ||
        !tailValues.slice(1).every((value) => numeric(value)) ||
        nextValues.slice(1).filter((value) => numeric(value)).length < 2 ||
        union(tail)[1] < union(head)[3] ||
        union(next)[1] < union(tail)[3] ||
        tail[0].baseline - head[0].baseline > head[0].height * 1.8 ||
        next[0].baseline - tail[0].baseline > tail[0].height * 2.2 ||
        hasHorizontalTableRuleBetween(rules, union(head)[3], union(tail)[1])
      )
        continue
      // Detector rows can overlap around wrapped records. Pick the row whose
      // center is closest to each source baseline instead of discarding the
      // continuation whenever two model bands both touch the same glyphs.
      const owners = [head, tail, next].map((group) => {
        const center = (union(group)[1] + union(group)[3]) / 2
        return rows
          .map((row, index) => ({
            row,
            index,
            distance: Math.abs((row.rect[1] + row.rect[3]) / 2 - center)
          }))
          .sort((a, b) => a.distance - b.distance)
      })
      if (owners.some((matches) => !matches.length)) continue
      const [previous, continuation, following] = owners.map((matches) => matches[0].row)
      const [previousIndex, continuationIndex, followingIndex] = owners.map(
        (matches) => matches[0].index
      )
      if (
        previous === continuation ||
        continuation === following ||
        continuationIndex !== previousIndex + 1 ||
        followingIndex !== continuationIndex + 1 ||
        items.some(
          (item) =>
            !head.includes(item) &&
            !tail.includes(item) &&
            item.rect[1] < union(tail)[3] &&
            item.rect[3] > union(head)[1]
        )
      )
        continue
      previous.rect[3] = Math.max(previous.rect[3], union(tail)[3])
      rows.splice(continuationIndex, 1)
      repairs.push('wrapped-slash-values-recovered')
      break
    }
  }
  // A detector may label the first data record as the header and omit the
  // actual labels immediately above it. Require independent text-only labels
  // and a complete numeric record below, rather than borrowing caption prose.
  if (captioned && rows.length >= 3) {
    const first = rows[0]
    const owned = items.filter((i) => inside(first.rect, i))
    const values = readSourceRow(owned, sourceCuts)
    const leading = sourceRows.filter(
      (g) =>
        g.every((i) => (i.rect[1] + i.rect[3]) / 2 < first.rect[1]) &&
        first.rect[1] - union(g)[3] < font * 1.6
    )
    if (
      values?.filter((v) => /^[<>≤≥−+-]?(?:\d|\.\d)/.test(v)).length >= 2 &&
      leading.length === 1
    ) {
      const g = leading[0],
        labels = columnRects.map((_, c) =>
          g
            .filter((i) => columnOf(i) === c)
            .map((i) => i.text)
            .join(' ')
        )
      if (
        (rules.length || readSourceRow(g, sourceCuts)) &&
        labels &&
        labels.filter((v) => /\p{L}/u.test(v)).length >= 2 &&
        labels.every((v) => !v || /\p{L}/u.test(v)) &&
        g.every((i) => i.height >= font * 0.8 && i.height <= font * 1.2)
      ) {
        const b = union(g)
        const edge = (b[3] + first.rect[1]) / 2
        rows.unshift({ rect: [sourceCuts[0], b[1], right, edge], origin: 'source-native-header' })
        first.rect[1] = edge
        repairs.push('clipped-source-header-band-recovered')
      }
    }
  }
  const signature = (g) => {
    const values = readSourceRow(g, sourceCuts)
    if (!values) return
    const stub = values.findIndex(Boolean)
    if (stub < 0 || stub > 1 || !/\p{L}/u.test(values[stub])) return
    const populated = values.slice(stub + 1).flatMap((s, n) => (s ? [n + stub + 1] : []))
    if (
      populated.length < 2 ||
      populated.some(
        (c) =>
          !/^[<>≤≥−+,-]?(?:\d|\.\d)[\d.,()%±*–—−+\s/-]*[a-d*†‡§]*$/.test(values[c]) ||
          /[+±]\s*$/.test(values[c])
      )
    )
      return
    return stub + ':' + populated.join(',')
  }
  // A short last model band can miss a whole aligned count record while
  // retaining its centered comparison values. A native outer frame and
  // repeated source records prove the tail without requiring a same-page title.
  {
    const tail = sourceRows.at(-1),
      last = rows.at(-1),
      tailKey = tail && signature(tail)
    if (tailKey && last && columnRects.length >= 4) {
      const rect = union(tail),
        centers = tail.map((i) => (i.rect[1] + i.rect[3]) / 2),
        values = readSourceRow(tail, sourceCuts),
        owned = items.filter((i) => inside(last.rect, i)),
        tailColumns = new Set(tail.map(columnOf)),
        edges = joinHorizontalTableRules(rules, font * 0.1)
      const footer = edges.find(
        (r) =>
          r[0] <= sourceCuts[0] + font &&
          r[2] >= right - font &&
          r[1] >= rect[3] &&
          r[1] - rect[3] < font * 0.5
      )
      if (
        footer &&
        values?.slice(1).filter(Boolean).length >= 3 &&
        values.slice(1).every((s) => !s || /^\d+(?:\.\d+)?(?:\(\d+(?:\.\d+)?%\))?$/.test(s)) &&
        edges.some(
          (r) =>
            r[1] < rows[0].rect[1] &&
            rows[0].rect[1] - r[1] < font * 2 &&
            Math.abs(r[0] - footer[0]) < font * 0.1 &&
            Math.abs(r[2] - footer[2]) < font * 0.1
        ) &&
        tail.every((i) => i.horizontal && Math.abs(i.height - font) < font * 0.1) &&
        Math.max(...centers) - Math.min(...centers) < font * 0.05 &&
        Math.min(...centers) > last.rect[3] &&
        Math.max(...centers) - last.rect[3] < font * 0.5 &&
        !tail.some((i) => rows.some((r) => inside(r.rect, i))) &&
        owned.length &&
        owned.every(
          (i) =>
            !tailColumns.has(columnOf(i)) &&
            columnOf(i) > 0 &&
            /^[\d.,<>≤≥ -]+$/.test(i.text) &&
            Math.abs(i.height - font) < font * 0.1 &&
            Math.min(...centers) - (i.rect[1] + i.rect[3]) / 2 < font
        ) &&
        sourceRows.filter(
          (g) =>
            g !== tail &&
            signature(g) === tailKey &&
            g.every((i) => rows.some((r) => inside(r.rect, i)))
        ).length >= 3 &&
        sourceRows.some(
          (g) =>
            g !== tail &&
            signature(g) === tailKey &&
            tail[0].baseline - g[0].baseline > font &&
            tail[0].baseline - g[0].baseline < font * 1.5
        ) &&
        !items.some(
          (i) =>
            !tail.includes(i) &&
            !owned.includes(i) &&
            inside([sourceCuts[0], last.rect[1], right, footer[1]], i)
        ) &&
        !hasHorizontalTableRuleBetween(rules, last.rect[1], rect[3])
      ) {
        last.rect[3] = rect[3]
        repairs.push('source-record-boundary-restored')
      }
    }
  }
  // Repeated adjusted/unadjusted records provide complete native row ownership
  // even when several model bands overlap. Preserve the existing header bands;
  // every body line must be a complete record or an explicit left-side section.
  if (captioned && columnRects.length >= 5) {
    const values = sourceRows.map((g) => readSourceRow(g, sourceCuts))
    const record = (n) =>
      values[n] &&
      /^(?:Unadjusted|Adjusted)$/i.test(values[n][1]) &&
      values[n].slice(2).every((v) => /^[<>≤≥−+-]?(?:\d|\.\d)[\d.,()%±*–—−+\s/-]*[a-d*]*$/.test(v))
    const section = (g) =>
      g.every((i) => i.rect[2] <= sourceCuts[2] && /\p{L}/u.test(i.text) && !/\d/.test(i.text))
    let start = values.findIndex((_, n) => record(n))
    while (start > 0 && section(sourceRows[start - 1])) start--
    const body = start >= 0 ? sourceRows.slice(start) : []
    const records = body.flatMap((_, n) => (record(n + start) ? [values[n + start][1]] : []))
    if (
      records.length >= 6 &&
      records.every((s, n) => s.toLowerCase() === (n % 2 ? 'adjusted' : 'unadjusted')) &&
      body.filter(section).length >= 2 &&
      body.every((g, n) => section(g) || record(n + start))
    ) {
      const rects = body.map((g) =>
          union(g.filter((i) => !i.inlineSymbol || !/^\*+$/.test(i.text)))
        ),
        top = rects[0][1],
        bottom = rects.at(-1)[3]
      const headerItems = items.filter((i) => i.rect[3] < top)
      const headerBottom = Math.max(...headerItems.map((i) => i.rect[3]))
      const header = rows.filter(
        (r) => r.rect[1] < top && headerItems.some((i) => inside(r.rect, i))
      )
      if (
        header.length &&
        top > headerBottom &&
        rects.every((r, n) => !n || r[1] > rects[n - 1][3]) &&
        rules.some(
          (r) =>
            r[1] === r[3] &&
            r[0] <= sourceCuts[0] + font &&
            r[2] >= right - font &&
            r[1] >= bottom &&
            r[1] - bottom < font
        )
      ) {
        const edge = (headerBottom + top) / 2
        rows.splice(
          0,
          rows.length,
          ...header.map((r) => ({
            ...r,
            rect: [r.rect[0], r.rect[1], r.rect[2], Math.min(r.rect[3], edge)]
          })),
          ...rects.map((r, n) => ({
            rect: [sourceCuts[0], r[1], right, r[3]],
            origin: 'source-text',
            section: section(body[n]),
            numericRecord: !section(body[n])
          }))
        )
        repairs.push('source-record-boundary-restored')
      }
    }
  }
  for (const g of sourceRows) {
    const key = signature(g)
    const terminalRuledRecord =
      columnRects.length === 4 &&
      g === sourceRows.at(-1) &&
      rules.some(
        (r) =>
          r[1] === r[3] &&
          r[0] <= sourceCuts[0] + font &&
          r[2] >= right - font &&
          r[1] >= union(g)[3] &&
          r[1] - union(g)[3] < font
      )
    if (
      !captioned ||
      (columnRects.length < 5 && !terminalRuledRecord) ||
      !key ||
      g.some((i) => i.height >= font * 0.8 && rows.some((r) => inside(r.rect, i))) ||
      sourceRows.filter(
        (peer) =>
          peer !== g &&
          signature(peer) === key &&
          peer.every((i) => rows.some((r) => inside(r.rect, i)))
      ).length < (terminalRuledRecord ? 2 : 3)
    )
      continue
    const b = union(g)
    const overlapping = rows.filter((r) => r.rect[1] < b[3] && r.rect[3] > b[1])
    const adjustments = overlapping.map((row) => {
      const other = items.filter((i) => inside(row.rect, i) && !g.includes(i))
      if (!other.length) return { row, remove: true }
      const r = union(other)
      if (r[3] < b[1]) return { row, bottom: (r[3] + b[1]) / 2 }
      if (r[1] > b[3]) return { row, top: (b[3] + r[1]) / 2 }
      const ys = other.map((i) => (i.rect[1] + i.rect[3]) / 2)
      const gs = g.map((i) => (i.rect[1] + i.rect[3]) / 2)
      // A vertically centered shared stub can overlap the next glyph box;
      // its center still belongs unambiguously to the preceding record.
      if (Math.max(...ys) < Math.min(...gs))
        return { row, bottom: (Math.max(...ys) + Math.min(...gs)) / 2 }
      if (Math.min(...ys) > Math.max(...gs))
        return { row, top: (Math.min(...ys) + Math.max(...gs)) / 2 }
      return undefined
    })
    if (adjustments.some((a) => !a)) continue
    for (const a of adjustments) {
      if (a.remove) rows.splice(rows.indexOf(a.row), 1)
      else if (a.top !== undefined) a.row.rect[1] = a.top
      else a.row.rect[3] = a.bottom
    }
    rows.push({
      rect: [sourceCuts[0], b[1], right, b[3]],
      origin: 'source-text',
      numericRecord: true
    })
    rows.sort((a, b) => a.rect[1] - b.rect[1])
    repairs.push('unowned-repeated-record-recovered')
  }
  // Complete comparison records may share one model band. A stub-only
  // "versus" line belongs to the preceding record, not to its next estimate.
  if (captioned && columnRects.length >= 5)
    for (const row of [...rows]) {
      const lines = sourceRows.filter((g) => g.every((i) => inside(row.rect, i)))
      const records = lines.filter((g) => signature(g))
      if (
        records.length < 2 ||
        records.some((g) => signature(g) !== signature(records[0])) ||
        lines[0] !== records[0] ||
        lines.some(
          (g) =>
            !records.includes(g) &&
            (g.some((i) => columnOf(i) !== 0) || !/\bversus\b/.test(g.map((i) => i.text).join(' ')))
        )
      )
        continue
      const grouped = []
      for (const g of lines) {
        if (records.includes(g)) grouped.push([...g])
        else grouped.at(-1).push(...g)
      }
      const split = splitOwnedSourceRows(rows, items, grouped, [sourceCuts[0], right])
      if (split) {
        rows.splice(split.index, 1, ...split.rows)
        repairs.push('source-record-boundary-restored')
      }
    }
  // Three descriptive prefixes are not a numeric comparison signature. A
  // complete framed table and independent six-leaf peers can still prove two
  // records inside its first body band. Keep its native header and scripts.
  if (captioned && columnRects.length === 6 && headers.length) {
    const splitCompleteDescriptivePeers = () => {
      if (sourceCuts.some((x, n) => !Number.isFinite(x) || (n && x <= sourceCuts[n - 1]))) return
      const record = (g) => {
        const values = readSourceRow(g, sourceCuts)
        if (
          !values ||
          !values.slice(0, 3).every((v) => /\p{L}/u.test(v)) ||
          !values
            .slice(3)
            .every(
              (v) => /^[–—−-]$/.test(v) || /^[<>≤≥−+-]?(?:\d|\.\d)[\d.,()%±*–—−+\s/-]*$/.test(v)
            )
        )
          return
        // Native descriptive leaves provide the ordinary anchor. A smaller
        // annotation can be just above 0.8 of the ordinary font height.
        const prefix = g.filter((i) => i.rect[0] >= sourceCuts[0] && i.rect[2] <= sourceCuts[3])
        if (!prefix.length || prefix.some((i) => Math.abs(i.height - font) > font * 0.1)) return
        const anchors = prefix.map((i) => i.baseline)
        if (Math.max(...anchors) - Math.min(...anchors) > font * 0.05) return
        return { group: g, anchor: anchors[0], bounds: union(g) }
      }
      const records = sourceRows.map(record).filter(Boolean)
      if (records.length < 5) return
      const first = records[0],
        second = records[1],
        last = records.at(-1),
        headerItems = items.filter((i) => i.rect[3] < first.bounds[1])
      if (
        !headerItems.length ||
        sourceRows.some(
          (g) => !records.some((r) => r.group === g) && g.some((i) => i.rect[3] >= first.bounds[1])
        ) ||
        !headers.every((h) => h.rect[3] < first.bounds[1])
      )
        return
      const headerBox = union(headerItems),
        full = joinHorizontalTableRules(rules, font * 0.1).filter(
          (r) => r[0] <= sourceCuts[0] + font * 0.5 && r[2] >= right - font * 0.5
        ),
        opening = full.filter((r) => r[1] <= headerBox[1] && headerBox[1] - r[1] < font * 0.5),
        divider = full.filter((r) => r[1] > headerBox[3] && r[1] < first.bounds[1]),
        closing = full.filter((r) => r[1] >= last.bounds[3] && r[1] - last.bounds[3] < font * 0.5)
      if (
        opening.length !== 1 ||
        divider.length !== 1 ||
        closing.length !== 1 ||
        [divider[0], closing[0]].some(
          (r) =>
            Math.abs(r[0] - opening[0][0]) > font * 0.1 ||
            Math.abs(r[2] - opening[0][2]) > font * 0.1
        )
      )
        return
      // Every leaf must have its own native ink, separated by a common empty
      // gutter. Model column scores or a caption alone provide no ownership.
      for (let c = 1; c < sourceCuts.length - 1; c++) {
        const left = records.flatMap((r) =>
            r.group.filter((i) => i.rect[0] >= sourceCuts[c - 1] && i.rect[2] <= sourceCuts[c])
          ),
          next = records.flatMap((r) =>
            r.group.filter((i) => i.rect[0] >= sourceCuts[c] && i.rect[2] <= sourceCuts[c + 1])
          )
        if (
          !left.length ||
          !next.length ||
          Math.max(...left.map((i) => i.rect[2])) >= sourceCuts[c] ||
          Math.min(...next.map((i) => i.rect[0])) <= sourceCuts[c]
        )
          return
      }
      const contains = (row, g) =>
          g.every((i) => inside([sourceCuts[0], row.rect[1], right, row.rect[3]], i)),
        owners = rows.filter((row) => contains(row, first.group) && contains(row, second.group))
      if (owners.length !== 1) return
      const owner = owners[0],
        index = rows.indexOf(owner),
        peers = records.slice(2).filter((r) => {
          const matches = rows.filter((row) => contains(row, r.group))
          return (
            matches.length === 1 &&
            records.filter((candidate) => contains(matches[0], candidate.group)).length === 1
          )
        })
      if (
        index === 0 ||
        records.filter((r) => contains(owner, r.group)).length !== 2 ||
        peers.length < 3 ||
        second.bounds[1] <= first.bounds[3] ||
        second.anchor - first.anchor < font * 0.8 ||
        second.anchor - first.anchor > font * 1.6 ||
        headers.some((h) => h.rect[1] < second.bounds[3] && h.rect[3] > first.bounds[1])
      )
        return
      const split = splitOwnedSourceRows(
        rows,
        items,
        [first.group, second.group],
        [sourceCuts[0], right]
      )
      if (!split || split.index !== index) return
      rows.splice(index, 1, ...split.rows)
      repairs.push('source-record-boundary-restored')
    }
    splitCompleteDescriptivePeers()
  }
  if (captioned && rows.length >= 3) {
    const last = rows.at(-1)
    const tail = sourceRows.filter(
      (g) =>
        g.every((i) => !inside(last.rect, i)) &&
        union(g)[3] > last.rect[3] &&
        union(g)[1] - last.rect[3] < font &&
        g.every((i) => i.height >= font * 0.8)
    )
    if (tail.length === 1 && tail[0].every((i) => /^[a-z][\p{L}\s.]*$/u.test(i.text))) {
      const g = tail[0],
        columns = new Set(g.map(columnOf))
      const previous = items.filter((i) => inside(last.rect, i) && columns.has(columnOf(i)))
      if (
        columns.size === 1 &&
        !columns.has(-1) &&
        previous.some((i) => /\p{L}/u.test(i.text) && i.text.length > 20) &&
        !rules.some((r) => r[1] === r[3] && r[1] > last.rect[3] && r[1] < union(g)[1])
      ) {
        last.rect[3] = union(g)[3]
        repairs.push('wrapped-source-row-recovered')
      }
    }
  }
  // A clipped first band can retain the lower halves of several column
  // headings. Extend only to adjacent text-only header peers inside the crop.
  const first = rows[0]
  if (first && captioned) {
    const units = sourceRows.find(
      (g) =>
        g.length >= 2 &&
        g.every((i) => /^Mean\s*\(SD\)$/.test(i.text)) &&
        union(g)[1] > first.rect[1] &&
        union(g)[1] - first.rect[3] < font * 2
    )
    const edge =
      units &&
      rules.find(
        (r) =>
          r[1] === r[3] &&
          r[2] - r[0] > (right - sourceCuts[0]) * 0.9 &&
          r[1] > union(units)[3] &&
          r[1] - union(units)[3] < font
      )
    if (
      edge &&
      units.every((i) =>
        items.some(
          (h) => inside(first.rect, h) && columnOf(h) === columnOf(i) && /\p{L}/u.test(h.text)
        )
      ) &&
      !items.some((i) => i.rect[1] > first.rect[3] && i.rect[3] < edge[1] && !units.includes(i))
    ) {
      first.rect[3] = edge[1]
      for (let r = rows.length - 1; r > 0; r--) {
        if (rows[r].rect[3] <= edge[1]) rows.splice(r, 1)
        else rows[r].rect[1] = Math.max(rows[r].rect[1], edge[1])
      }
      repairs.push('clipped-source-header-band-recovered')
    }
  }
  if (first)
    for (const g of groups) {
      const b = union(g),
        values = columnRects.map((_, c) =>
          g
            .filter((i) => columnOf(i) === c)
            .map((i) => i.text)
            .join(' ')
        )
      if (
        !headers.length ||
        !g.some((i) => headers.some((h) => intersection(h.rect, i.rect) > area(i.rect) * 0.1)) ||
        g.some(
          (i) =>
            i.height < font * 0.8 ||
            columnOf(i) < 0 ||
            i.rect[0] < sourceCuts[columnOf(i)] - font * 0.15 ||
            i.rect[2] > sourceCuts[columnOf(i) + 1] + font * 0.15
        ) ||
        b[3] > first.rect[3] ||
        b[1] >= first.rect[1] ||
        first.rect[1] - b[1] > font * 1.5 ||
        !values ||
        values.filter((s) => /\p{L}/u.test(s)).length < 2 ||
        values.some((s) => /^[-+<>≤≥]?\d[\d.,()%±\s]*$/.test(s)) ||
        rules.some(
          (r) =>
            r[1] === r[3] &&
            r[1] > b[3] &&
            r[1] < first.rect[1] &&
            r[2] - r[0] > (right - sourceCuts[0]) * 0.8
        )
      )
        continue
      first.rect[1] = Math.min(first.rect[1], b[1])
      repairs.push('clipped-source-header-band-recovered')
    }
  // A separate ruled band of consecutive time headings may be excluded from
  // every model row. Join split glyphs for recognition only; keep source text.
  const head = groups[0]
  if (head?.length && columnRects.length >= 5) {
    const texts = columnRects.map((_, c) =>
      head
        .filter((i) => columnOf(i) === c)
        .map((i) => i.text)
        .join('')
        .replace(/\s/g, '')
    )
    const first = texts.findIndex(Boolean)
    const hs = union(head)
    const divider = rules.find(
      (r) =>
        r[1] === r[3] &&
        r[0] <= columnRects[0][0] + 12 &&
        r[2] >= right - 12 &&
        r[1] > hs[3] &&
        r[1] - hs[3] < head[0].height
    )
    if (
      first > 0 &&
      texts.length - first >= 3 &&
      texts.slice(first).every((s, n) => new RegExp(`^[tT]${n}$`).test(s)) &&
      divider &&
      head.every((i) => Math.abs(i.baseline - head[0].baseline) < 1) &&
      !items.some((i) => !head.includes(i) && i.rect[1] < divider[1])
    ) {
      for (let r = rows.length - 1; r >= 0; r--) {
        if (rows[r].rect[3] <= divider[1]) rows.splice(r, 1)
        else rows[r].rect[1] = Math.max(rows[r].rect[1], divider[1])
      }
      rows.unshift({
        rect: [columnRects[0][0], hs[1], right, divider[1]],
        origin: 'source-time-header'
      })
      repairs.push('ruled-time-header-recovered')
    }
  }
  // A complete labeled P-value record can fall in a gap between model bands.
  // Require two explicit P values, matching labeled peers, and native table
  // borders; a numeric continuation without its own label is not a record.
  const cuts = [columnRects[0]?.[0], ...columnRects.map((r) => r[2])]
  // Duplicate/overlapping bands can give a complete counted record two owners.
  // Rebuild only the intersecting bands when every contained source baseline
  // is itself a complete record or a sample-size heading.
  for (const group of groups) {
    const values = readSourceRow(group, cuts)
    const counted = (v) =>
      v && v.filter((s) => /^\d+(?:\/\d+)?\(\d+(?:\.\d+)?%\)$/.test(s)).length >= 2
    if (!counted(values)) continue
    const owners = rows.filter((r) => group.some((i) => inside(r.rect, i)))
    if (owners.length < 2) continue
    const members = items.filter((i) => owners.some((r) => inside(r.rect, i)))
    const bands = groups.filter((g) => g.some((i) => members.includes(i)))
    if (bands.length < 2 || bands.some((g) => g.some((i) => !members.includes(i)))) continue
    if (
      bands.some((g) => {
        const v = readSourceRow(g, cuts)
        return (
          !counted(v) &&
          !(v && /\p{L}/u.test(v[0]) && v.filter((x) => /^n=\d+$/.test(x)).length >= 2)
        )
      })
    )
      continue
    const boxes = bands.map(union)
    if (
      boxes.some((r, n) => n && r[1] <= boxes[n - 1][3]) ||
      rows.some((r) => !owners.includes(r) && members.some((i) => inside(r.rect, i)))
    )
      continue
    const start = rows.indexOf(owners[0])
    if (owners.some((r, n) => rows.indexOf(r) !== start + n)) continue
    rows.splice(
      start,
      owners.length,
      ...boxes.map((r) => ({ rect: [cuts[0], r[1], right, r[3]], origin: 'source-text' }))
    )
    repairs.push('counted-record-bands-restored')
  }

  // A final R-squared expression is a sparse in-table record, not a
  // coefficient continuation. Require coefficient headings, repeated paired
  // numeric rows, native enclosure and one uniquely anchored exponent.
  if (columnRects.length === 3 && rows.length >= 5) {
    const last = rows.at(-1)
    const tail = items.filter((i) => i.rect[1] >= last.rect[3])
    const label = tail.find((i) => i.text === 'R')
    const power = tail.find((i) => i.text === '2' && label && isAdjacentTableScript(i, label))
    const value = tail.find((i) => /^=\s*0?\.\d+\*{0,3}$/.test(i.text.trim()))
    const header = readSourceRow(groups[0] ?? [], cuts)
    if (
      tail.length === 3 &&
      label &&
      power &&
      value &&
      header?.[1] === 'B' &&
      header[2] === 'SEB' &&
      tail.every((i) => columnOf(i) === 1) &&
      Math.abs(label.baseline - value.baseline) < label.height * 0.2 &&
      value.rect[0] >= power.rect[2] &&
      value.rect[0] - power.rect[2] < label.height &&
      label.rect[1] - last.rect[3] < label.height &&
      groups.filter((g) => {
        const v = readSourceRow(g, cuts)
        return (
          v &&
          /\p{L}/u.test(v[0]) &&
          v.slice(1).every((s) => /^[<>−+-]?\d+(?:\.\d+)?\*{0,3}$/.test(s))
        )
      }).length >= 4 &&
      rules.some(
        (r) =>
          r[1] === r[3] &&
          r[0] <= cuts[0] + 4 &&
          r[2] >= right - 4 &&
          r[1] > Math.max(...tail.map((i) => i.rect[3])) &&
          r[1] - label.baseline < label.height * 2
      ) &&
      !hasHorizontalTableRuleBetween(rules, last.rect[3], label.rect[1])
    ) {
      const rect = union(tail)
      rows.push({ rect: [cuts[0], rect[1], right, rect[3]], origin: 'source-text' })
      repairs.push('trailing-regression-summary-recovered')
    }
  }
  // A labeled record can fall just above the model row holding its closing
  // brackets. Recover only repeated labels and paired, source-aligned values;
  // this joins physical lines without inferring displaced scientific pairings.
  for (let n = 1; n + 1 < groups.length; n++) {
    const head = groups[n],
      tail = groups[n + 1]
    const values = readSourceRow(head, cuts),
      endings = readSourceRow(tail, cuts)
    if (!values || !endings || !/^[A-Za-z][A-Za-z -]+$/.test(values[0])) continue
    const columns = values.slice(1).flatMap((v, c) => (v ? [c + 1] : []))
    const a = union(head),
      b = union(tail)
    if (
      columns.length < 2 ||
      endings[0] ||
      !columns.every((c) => /^\[\d+\(\d+(?:\.\d+)?\)$/.test(values[c]) && endings[c] === ']') ||
      endings.some((v, c) => v && !columns.includes(c)) ||
      head.some((i) => Math.abs(i.baseline - head[0].baseline) > i.height * 0.2) ||
      tail.some((i) => Math.abs(i.baseline - tail[0].baseline) > i.height * 0.2) ||
      b[1] < a[3] ||
      b[1] - a[3] > head[0].height * 0.5 ||
      rows.some((r) => head.some((i) => inside(r.rect, i))) ||
      hasHorizontalTableRuleBetween(rules, a[1], b[3]) ||
      groups.filter((g) => readSourceRow(g, cuts)?.[0] === values[0]).length < 3
    )
      continue
    const owners = rows.filter((r) => tail.every((i) => inside(r.rect, i)))
    if (owners.length !== 1) continue
    const owner = owners[0]
    const expanded = [cuts[0], a[1], right, owner.rect[3]]
    if (
      owner.rect[1] < a[3] - head[0].height * 0.5 ||
      items.some((i) => inside(expanded, i) && !head.includes(i) && !tail.includes(i)) ||
      rows.some((r) => r !== owner && r.rect[1] < a[3] && r.rect[3] > a[1])
    )
      continue
    owner.rect = expanded
    repairs.push('text-supported-wrapped-records-recovered')
  }
  // Repeated n (%) labels can occupy a gap between model rows. Require an
  // empty stub, every value column and two complete counted records below;
  // a sample size or a lone numeric continuation is not a header.
  for (let n = 1; n + 2 < groups.length; n++) {
    const header = groups[n],
      values = readSourceRow(header, cuts),
      rect = union(header)
    if (
      columnRects.length < 3 ||
      !values ||
      values[0] ||
      !values.slice(1).every((v) => /^n\(%\)$/i.test(v)) ||
      header.some((i) => Math.abs(i.baseline - header[0].baseline) > i.height * 0.2) ||
      rows.some((r) => r.rect[1] < rect[3] && r.rect[3] > rect[1]) ||
      !groups.slice(n + 1, n + 3).every((g) => {
        const v = readSourceRow(g, cuts)
        return v && /\p{L}/u.test(v[0]) && v.slice(1).every((s) => /^\d+\(\d+(?:\.\d+)?\)$/.test(s))
      }) ||
      union(groups[n - 1])[3] >= rect[1] ||
      rect[3] >= union(groups[n + 1])[1] ||
      groups[n + 1][0].baseline - header[0].baseline > header[0].height * 1.8 ||
      hasHorizontalTableRuleBetween(rules, rect[3], union(groups[n + 1])[1])
    )
      continue
    rows.push({ rect: [cuts[0], rect[1], right, rect[3]], origin: 'source-statistic-header' })
    rows.sort((a, b) => a.rect[1] - b.rect[1])
  }
  // A flush wrapped category can fall across the gap before the next model
  // row. Its lowercase tail has no values; matching counted records on both
  // sides establish the owning label column independently of the model span.
  for (let n = 2; n + 1 < groups.length; n++) {
    const head = groups[n - 1],
      tail = groups[n],
      next = groups[n + 1]
    const c = columnOf(tail[0]),
      label = head.filter((i) => columnOf(i) === c)
    if (c < 0 || !label.length || !tail.every((i) => columnOf(i) === c)) continue
    const a = union(label),
      b = union(tail),
      following = next.filter((i) => columnOf(i) === c)
    const counted = (g) => {
      const v = readSourceRow(g, cuts)
      return (
        v &&
        v.slice(c + 1).filter(Boolean).length >= 3 &&
        v.slice(c + 1).every((s) => !s || /^\d+\(\d+(?:\.\d+)?\)$/.test(s))
      )
    }
    if (
      !/^\p{Lu}/u.test(label[0].text) ||
      !/^\p{Ll}/u.test(tail[0].text) ||
      !following.length ||
      !/^\p{Lu}/u.test(following[0].text) ||
      ![groups[n - 2], head, next].every(counted) ||
      head.some((i) => columnOf(i) < c) ||
      a[2] - a[0] < (columnRects[c][2] - columnRects[c][0]) * 0.5 ||
      Math.abs(a[0] - b[0]) > label[0].height * 0.1 ||
      Math.abs(a[0] - following[0].rect[0]) > label[0].height * 0.1 ||
      tail.some((i) => Math.abs(i.height - label[0].height) > label[0].height * 0.1) ||
      b[1] <= a[3] ||
      b[3] >= union(next)[1] ||
      tail[0].baseline - label[0].baseline > label[0].height * 1.6 ||
      rules.some((r) => r[1] === r[3] && r[1] > a[3] && r[1] < b[3] && r[0] < b[2] && r[2] > b[0])
    )
      continue
    const owners = rows.filter((r) => head.every((i) => inside(r.rect, i)))
    const followingOwners = rows.filter((r) => following.every((i) => inside(r.rect, i)))
    if (owners.length !== 1 || followingOwners.length !== 1) continue
    const previous = owners[0],
      followingRow = followingOwners[0]
    if (
      rows.indexOf(followingRow) !== rows.indexOf(previous) + 1 ||
      items.some(
        (i) => !head.includes(i) && !tail.includes(i) && i.rect[1] < b[3] && i.rect[3] > a[1]
      )
    )
      continue
    const boundary = (b[3] + union(next)[1]) / 2
    previous.rect[3] = boundary
    followingRow.rect[1] = boundary
  }
  for (let n = 1; n < groups.length; n++) {
    const g = groups[n],
      rect = union(g),
      values = readSourceRow(g, cuts)
    const coefficient =
      values &&
      values.length >= 6 &&
      !values[0] &&
      /[A-Za-z].*×/.test(values[1]) &&
      values.slice(2).filter(Boolean).length >= 4 &&
      values
        .slice(2)
        .every(
          (v) =>
            !v || /^[−+-]?(?:\d*\.)?\d+(?:\([−+-]?(?:\d*\.)?\d+,[−+-]?(?:\d*\.)?\d+\))?$/.test(v)
        ) &&
      values.some((v) => /\(.*,/.test(v))
    const counted =
      values &&
      !values[0] &&
      /^\p{L}.*[<>≤≥]/u.test(values[1]) &&
      values.slice(2).filter(Boolean).length === 2 &&
      values.slice(2).every((v) => !v || /^\d+\/\d+\(\d+(?:\.\d+)?%\)$/.test(v)) &&
      groups.filter((other) => readSourceRow(other, cuts)?.[1] === values[1]).length >= 3
    const stub = coefficient || counted ? 1 : 0
    if (
      !values ||
      (!coefficient &&
        !counted &&
        (!/^[A-Za-z][A-Za-z -]*$/.test(values[0]) ||
          values.slice(1).filter(Boolean).length < 2 ||
          values.slice(1).some((v) => v && !/^p[=<>≤≥](?:0?\.\d+|1(?:\.0+)?)$/i.test(v)))) ||
      rows.some((r) => g.some((i) => inside(r.rect, i)))
    )
      continue
    const peers = groups.filter(
      (other) =>
        other !== g &&
        other.some(
          (i) =>
            columnOf(i) === stub && /\p{L}/u.test(i.text) && Math.abs(i.rect[0] - g[0].rect[0]) < 1
        ) &&
        rows.some((r) => other.every((i) => inside(r.rect, i)))
    )
    if (
      !peers.some((p) => union(p)[3] < rect[1]) ||
      (!peers.some((p) => union(p)[1] > rect[3]) &&
        !(counted && n === groups.length - 1 && peers.length >= 3)) ||
      !rules.some(
        (r) => r[1] === r[3] && r[0] <= cuts[0] + 12 && r[2] >= right - 12 && r[1] < rect[1]
      ) ||
      (!counted &&
        !rules.some(
          (r) => r[1] === r[3] && r[0] <= cuts[0] + 12 && r[2] >= right - 12 && r[1] > rect[3]
        ))
    )
      continue
    const overlap = rows.filter((r) => r.rect[1] < rect[3] && r.rect[3] > rect[1])
    if (
      overlap.some((r) =>
        items.some(
          (i) =>
            !g.includes(i) &&
            inside(r.rect, i) &&
            (i.rect[1] + i.rect[3]) / 2 >= rect[1] &&
            (i.rect[1] + i.rect[3]) / 2 <= rect[3]
        )
      )
    )
      continue
    for (const r of overlap) {
      if (r.rect[1] < rect[1]) r.rect[3] = rect[1]
      else r.rect[1] = rect[3]
    }
    rows.push({ rect: [cuts[0], rect[1], right, rect[3]], origin: 'source-p-record' })
    rows.sort((a, b) => a.rect[1] - b.rect[1])
    repairs.push(
      coefficient
        ? 'coefficient-record-recovered'
        : counted
          ? 'counted-record-recovered'
          : 'labeled-p-record-recovered'
    )
  }
  // A complete summary and its lowercase statistic-label continuation can
  // straddle overlapping model rows. Rebuild only bands owning these exact
  // tokens, with every numeric column present and no intervening native rule.
  for (let n = 0; n + 1 < groups.length; n++) {
    const head = groups[n],
      tail = groups[n + 1],
      values = readSourceRow(head, cuts)
    if (
      !values ||
      values.length < 3 ||
      !/^(?:Mean|Median)\p{L}/u.test(values[0]) ||
      !values
        .slice(1)
        .every((v) => /^[<>≤≥−+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:\([−+-]?\d+(?:\.\d+)?\))?$/.test(v)) ||
      tail.some((i) => columnOf(i) !== 0) ||
      !/^[a-z].*\((?:IQR|SD|range)\)$/.test(tail.map((i) => i.text).join(' ')) ||
      Math.abs(tail[0].rect[0] - head[0].rect[0]) > 1 ||
      tail[0].baseline - head[0].baseline > head[0].height * 1.6
    )
      continue
    const members = [...head, ...tail],
      rect = union(members)
    const owners = rows.filter((row) => members.some((i) => inside(row.rect, i)))
    if (
      owners.length < 2 ||
      owners.length > 3 ||
      items.some((i) => !members.includes(i) && owners.some((row) => inside(row.rect, i))) ||
      members.some((i) => !owners.some((row) => inside(row.rect, i))) ||
      hasHorizontalTableRuleBetween(rules, union(head)[3], union(tail)[1])
    )
      continue
    const rest = rows.filter((row) => !owners.includes(row))
    if (rest.some((row) => row.rect[1] < rect[3] && row.rect[3] > rect[1])) continue
    rows.splice(0, rows.length, ...rest, {
      rect: [cuts[0], rect[1], right, rect[3]],
      origin: 'source-summary'
    })
    rows.sort((a, b) => a.rect[1] - b.rect[1])
    repairs.push('overlapping-wrapped-summary-recovered')
  }
  recoverLeadingSampleSection({ rows, groups, items, columnRects, rules, repairs })
  // Short unit tails inside an unfinished stub belong to a complete dense
  // numeric record, including its final line on a continuation page.
  if (columnRects.length >= 9)
    for (let n = 1; n < sourceRows.length; n++) {
      const head = sourceRows[n - 1],
        tail = sourceRows[n],
        next = sourceRows[n + 1]
      const stub = head.filter((i) => columnOf(i) === 0)
      const compact = (g) =>
        [...g]
          .sort((a, b) => a.rect[0] - b.rect[0])
          .map((i) => i.text)
          .join('')
          .replace(/\s/g, '')
      const text = compact(stub),
        suffix = compact(tail)
      if (
        !stub.length ||
        !tail.every((i) => columnOf(i) === 0) ||
        !/\((?:\p{L}+\/|n)$/u.test(text) ||
        !/^\p{L}{1,8}[²³23]?\)$/u.test(suffix) ||
        (text.match(/\(/g)?.length ?? 0) !== (text.match(/\)/g)?.length ?? 0) + 1 ||
        new Set(head.map(columnOf).filter((c) => c > 0)).size < 8
      )
        continue
      const h = Math.max(...stub.map((i) => i.height)),
        a = union(stub),
        b = union(tail)
      if (
        b[1] < union(head)[3] ||
        tail[0].baseline - head[0].baseline > h * 1.8 ||
        b[0] < a[0] ||
        b[0] - a[0] > h * 2 ||
        b[2] > a[2] ||
        !tail.some((i) => Math.abs(i.height - h) < 0.1) ||
        rules.some(
          (r) =>
            r[1] === r[3] &&
            r[1] > union(head)[3] &&
            r[1] < b[1] &&
            r[0] <= columnRects[0][0] &&
            r[2] >= columnRects[0][2]
        )
      )
        continue
      const previous = rows.find((r) => stub.some((i) => inside(r.rect, i)))
      const trailing = rows.find((r) => tail.some((i) => inside(r.rect, i)))
      if (!previous || previous === trailing) continue
      const boundary = next ? (b[3] + union(next)[1]) / 2 : b[3] + 0.1
      if (next && boundary <= b[3]) continue
      previous.rect[3] = Math.max(previous.rect[3], boundary)
      if (
        trailing &&
        trailing !== previous &&
        items.filter((i) => inside(trailing.rect, i)).every((i) => tail.includes(i))
      )
        rows.splice(rows.indexOf(trailing), 1)
      repairs.push('recovered-row-continuation-included')
    }
  // An interval or an unfinished parenthetical stub can wrap into the next
  // predicted row. Matching delimiters and an otherwise empty native line
  // establish ownership before the next complete source record.
  for (let n = 1; n < groups.length - 1; n++) {
    const head = groups[n - 1],
      tail = groups[n],
      next = groups[n + 1]
    const c = columnOf(tail[0])
    if (c < 0 || !tail.every((i) => columnOf(i) === c)) continue
    const text = (g) =>
      g
        .filter((i) => columnOf(i) === c)
        .sort((a, b) => a.rect[0] - b.rect[0])
        .map((i) => i.text)
        .join('')
        .replace(/\s/g, '')
    const numericTail =
      c > 0 &&
      /^\([−+-]?\d+(?:\.\d+)?,?$/.test(text(head)) &&
      /^[−+-]?\d+(?:\.\d+)?\)$/.test(text(tail))
    const stubTail =
      c === 0 &&
      /^[\p{Ll}][\p{L}\s-]*\)$/u.test(text(tail)) &&
      (text(head).match(/\(/g)?.length ?? 0) === (text(head).match(/\)/g)?.length ?? 0) + 1 &&
      Math.abs(tail[0].rect[0] - head.find((i) => columnOf(i) === 0).rect[0]) <= 1 &&
      new Set(next.map(columnOf).filter((column) => column > 0)).size >= 3
    if (
      !(numericTail || stubTail) ||
      !head.some((i) => columnOf(i) === 0 && /\p{L}/u.test(i.text)) ||
      !next.some((i) => columnOf(i) === 0 && /\p{L}/u.test(i.text)) ||
      new Set(head.map(columnOf).filter((c) => c > 0)).size < 3 ||
      union(tail)[1] < union(head)[3] ||
      union(tail)[3] >= union(next)[1] ||
      tail[0].baseline - head[0].baseline > tail[0].height * 1.8
    )
      continue
    const previous = rows.find((r) => head.some((i) => columnOf(i) === 0 && inside(r.rect, i)))
    const following = rows.find((r) => next.some((i) => columnOf(i) === 0 && inside(r.rect, i)))
    if (
      !previous ||
      !following ||
      previous === following ||
      rules.some(
        (r) =>
          r[1] === r[3] &&
          r[1] > union(head)[3] &&
          r[1] < union(tail)[1] &&
          r[0] <= columnRects[c][0] &&
          r[2] >= columnRects[c][2]
      )
    )
      continue
    const boundary = (union(tail)[3] + union(next)[1]) / 2
    previous.rect[3] = boundary
    following.rect[1] = boundary
    repairs.push(
      stubTail ? 'recovered-row-continuation-included' : 'wrapped-numeric-interval-owned'
    )
  }
  // Some interval columns print their two endpoints on separate baselines.
  // Require repeated complete records followed only by CI endpoints; a blank
  // stub alone is not evidence that two rows describe the same observation.
  const intervalColumns = columnRects.flatMap((column, c) =>
    groups.some((group) =>
      /^95%\s*CI$/i.test(
        group
          .filter((item) => inside(column, item))
          .map((item) => item.text)
          .join(' ')
      )
    )
      ? [c]
      : []
  )
  if (intervalColumns.length >= 2 && !intervalColumns.includes(0)) {
    const numeric = (item) => /^[-−]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(item.text)
    const pairs = groups.flatMap((head, index) => {
      const tail = groups[index + 1]
      if (
        !tail ||
        !head.some((i) => columnOf(i) === 0 && /\p{L}/u.test(i.text)) ||
        !columnRects
          .slice(1)
          .every((_, c) => head.some((i) => columnOf(i) === c + 1 && numeric(i))) ||
        tail.length !== intervalColumns.length ||
        !intervalColumns.every((c) => tail.some((i) => columnOf(i) === c && numeric(i))) ||
        union(tail)[1] < union(head)[3] ||
        tail[0].baseline - head[0].baseline > tail[0].height * 1.8 ||
        rules.some(
          (r) =>
            r[1] === r[3] &&
            r[1] > union(head)[3] &&
            r[1] < union(tail)[1] &&
            r[0] <= columnRects[0][2] &&
            r[2] >= right - 4
        )
      )
        return []
      return [[...head, ...tail]]
    })
    if (pairs.length >= 2) {
      for (const pair of pairs) {
        const rect = union(pair)
        const replaced = rows.filter((row) => row.rect[1] < rect[3] && row.rect[3] > rect[1])
        if (
          !replaced.length ||
          items.some((i) => !pair.includes(i) && replaced.some((row) => inside(row.rect, i)))
        )
          continue
        rows.splice(0, rows.length, ...rows.filter((row) => !replaced.includes(row)), {
          rect: [columnRects[0][0], rect[1], right, rect[3]],
          origin: 'source-interval-record'
        })
        repairs.push('wrapped-interval-record-recovered')
      }
      rows.sort((a, b) => a.rect[1] - b.rect[1])
    }
  }
  // An explicit trailing plus sign establishes an unfinished treatment label.
  // Join its next stub-only line only when no source rule separates the pair.
  for (let r = 1; r < rows.length; r++) {
    const prior = items.filter((i) => inside(rows[r - 1].rect, i)),
      tail = items.filter((i) => inside(rows[r].rect, i))
    const stub = prior.filter((i) => columnOf(i) === 0).sort((a, b) => a.baseline - b.baseline)
    const narrativeTail =
      columnRects.length === 2 &&
      stub.length === 1 &&
      /\b(?:and|or)$/.test(stub[0].text) &&
      [0, 1].every((c) => tail.some((i) => columnOf(i) === c && /\p{L}/u.test(i.text))) &&
      prior
        .filter((i) => columnOf(i) === 1)
        .map((i) => i.text)
        .join(' ').length > 70 &&
      tail
        .filter((i) => columnOf(i) === 0)
        .every((i) => Math.abs(i.rect[0] - stub[0].rect[0]) < i.height * 1.1)
    const joinedTreatment =
      stub.length &&
      stub.some((i) => /\p{L}/u.test(i.text)) &&
      /\+$/.test(stub.at(-1).text) &&
      prior.filter((i) => columnOf(i) > 0 && /^\d/.test(i.text)).length >= 2 &&
      tail.every((i) => columnOf(i) === 0 && /^[A-Za-z]/.test(i.text))
    // A repeated statistic definition can wrap onto a stub-only line. Two
    // complete source peers with the same literal suffix establish ownership;
    // parentheses alone could instead introduce a new category.
    const ending = tail
      .map((i) => i.text)
      .join(' ')
      .trim()
    const statistic = /\b(mean|median)$/i.exec(
      stub
        .slice()
        .sort((a, b) => a.rect[0] - b.rect[0])
        .map((i) => i.text)
        .join(' ')
        .trim()
    )?.[0]
    const statisticTail =
      statistic &&
      tail.length === 1 &&
      columnOf(tail[0]) === 0 &&
      /^\([^()]+\)$/.test(ending) &&
      tail[0].rect[0] >= Math.min(...stub.map((i) => i.rect[0])) &&
      tail[0].rect[0] - Math.min(...stub.map((i) => i.rect[0])) <=
        Math.max(...stub.map((i) => i.height)) * 1.1 &&
      columnRects
        .slice(1)
        .every((_, c) => prior.some((i) => columnOf(i) === c + 1 && /^\d/.test(i.text))) &&
      groups.filter(
        (g) =>
          g.some((i) => columnOf(i) === 0 && i.text.endsWith(`${statistic} ${ending}`)) &&
          columnRects
            .slice(1)
            .every((_, c) => g.some((i) => columnOf(i) === c + 1 && /^\d/.test(i.text)))
      ).length >= 2
    const dosingTail =
      columnRects.length === 4 &&
      items.some((i) => i.text === 'Dosing recommendations') &&
      stub.some((i) => /substrates?$/.test(i.text)) &&
      !tail.some((i) => columnOf(i) === 0) &&
      [1, 2, 3].every((c) => tail.some((i) => columnOf(i) === c && /\p{L}/u.test(i.text)))
    const thresholdTail =
      stub.length === 1 &&
      /\p{L}/u.test(stub[0].text) &&
      tail.length > 0 &&
      tail.every((i) => columnOf(i) === 0) &&
      /^[<>≤≥]\s*\d+(?:\.\d+)?\s*\(%\)$/.test(tail.map((i) => i.text).join(' ')) &&
      Math.abs(Math.min(...tail.map((i) => i.rect[0])) - stub[0].rect[0]) < 1 &&
      [1, 2].every((c) =>
        /^\d+\s*\(\d+(?:\.\d+)?\)$/.test(
          prior
            .filter((i) => columnOf(i) === c)
            .map((i) => i.text)
            .join(' ')
        )
      )
    if (
      !tail.length ||
      !stub.length ||
      !(joinedTreatment || dosingTail || thresholdTail || statisticTail || narrativeTail) ||
      Math.min(...tail.map((i) => i.baseline)) - Math.max(...prior.map((i) => i.baseline)) >
        (statisticTail ? Math.max(...stub.map((i) => i.height)) : stub[0].height) * 1.8 ||
      rules.some(
        (rule) =>
          rule[1] === rule[3] &&
          rule[1] > Math.max(...prior.map((i) => i.baseline)) &&
          rule[1] < Math.min(...tail.map((i) => i.baseline))
      )
    )
      continue
    rows[r - 1].rect[3] = rows[r].rect[3]
    rows.splice(r--, 1)
    repairs.push(
      thresholdTail ? 'wrapped-threshold-label-recovered' : 'explicit-prose-continuation-recovered'
    )
  }
  // A hyphenated stub continuation has no measurements of its own. Keep
  // consecutive lowercase continuations with that record, stopping at a rule.
  for (let r = 1; r < rows.length; r++) {
    const previous = rows[r - 1],
      current = rows[r]
    const tail = items.filter((i) => inside(current.rect, i))
    const prior = items.filter((i) => inside(previous.rect, i))
    const stub = prior.filter((i) => columnOf(i) === 0).sort((a, b) => a.baseline - b.baseline)
    if (
      !tail.length ||
      !stub.length ||
      !tail.every((i) => columnOf(i) === 0 && /^[a-z]/.test(i.text)) ||
      !(previous.hyphenatedStub || /[-\u2010\u2011]$/.test(stub.at(-1).text)) ||
      prior.filter((i) => columnOf(i) > 0 && /^\d/.test(i.text)).length < 2 ||
      tail.some(
        (i) =>
          Math.abs(i.rect[0] - stub[0].rect[0]) > i.height ||
          i.baseline - stub.at(-1).baseline > i.height * 1.6
      ) ||
      rules.some(
        (rule) =>
          rule[1] === rule[3] &&
          rule[1] > stub.at(-1).baseline &&
          rule[1] < tail[0].baseline &&
          rule[0] <= stub[0].rect[0] &&
          rule[2] >= tail[0].rect[2]
      )
    )
      continue
    previous.rect[3] = current.rect[3]
    previous.hyphenatedStub = true
    rows.splice(r--, 1)
    repairs.push('hyphenated-stub-continuation-recovered')
  }
  // Dense tables can wrap labels flush left (or slightly outdent them).
  // Require repeated source line spacing and populated comparison columns;
  // an isolated lowercase line is not enough evidence to remove a boundary.
  const denseContinuations = []
  for (let r = 1; columnRects.length >= 4 && r < rows.length - 1; r++) {
    const prior = items.filter((i) => inside(rows[r - 1].rect, i))
    const tail = items.filter((i) => inside(rows[r].rect, i))
    const stub = prior.filter((i) => columnOf(i) === 0)
    const following = items.filter((i) => inside(rows[r + 1].rect, i))
    const head = stub[0],
      first = tail[0]
    const populated = (line) =>
      columnRects
        .slice(1, -1)
        .every((_, c) => line.some((i) => columnOf(i) === c + 1 && /^\d/.test(i.text)))
    const statistics = prior.filter((i) => columnOf(i) > 0)
    const category =
      statistics.length === 1 &&
      columnOf(statistics[0]) === columnRects.length - 1 &&
      /^0?\.\d+$/.test(statistics[0].text) &&
      populated(following)
    if (
      !head ||
      !first ||
      !/^[a-z]/.test(first.text) ||
      !tail.every((i) => columnOf(i) === 0) ||
      stub.map((i) => i.text).join(' ').length < 12 ||
      !stub.every((i) => Math.abs(i.baseline - head.baseline) < head.height * 0.2) ||
      !tail.every((i) => Math.abs(i.baseline - first.baseline) < first.height * 0.2) ||
      Math.abs(first.rect[0] - head.rect[0]) > head.height * 0.35 ||
      Math.abs(first.height - head.height) > head.height * 0.05 ||
      first.baseline - head.baseline < head.height * 0.95 ||
      first.baseline - head.baseline > head.height * 1.1 ||
      (!populated(prior) && !category) ||
      !following.some((i) => columnOf(i) === 0 && /^[A-Z]/.test(i.text)) ||
      rules.some(
        (rule) =>
          rule[1] === rule[3] &&
          rule[1] > head.baseline &&
          rule[1] < first.baseline &&
          rule[0] <= head.rect[0] &&
          rule[2] >= first.rect[2]
      )
    )
      continue
    denseContinuations.push({ index: r, height: head.height, gap: first.baseline - head.baseline })
  }
  for (const candidate of denseContinuations.reverse()) {
    if (
      denseContinuations.filter(
        (peer) =>
          Math.abs(peer.height - candidate.height) < candidate.height * 0.05 &&
          Math.abs(peer.gap - candidate.gap) < candidate.height * 0.05
      ).length < 3
    )
      continue
    rows[candidate.index - 1].rect[3] = rows[candidate.index].rect[3]
    rows.splice(candidate.index, 1)
    repairs.push('dense-stub-continuation-recovered')
  }
  // A hanging lowercase continuation has no data of its own. Keep it with
  // the preceding label, including raised footnote fragments. Require a
  // multi-column numeric table, close source baselines and a positive indent.
  for (let r = 1; columnRects.length >= 3 && r < rows.length - 1; r++) {
    const previous = rows[r - 1],
      current = rows[r]
    const prior = items.filter((i) => inside(previous.rect, i))
    const tail = items.filter((i) => inside(current.rect, i)).sort((a, b) => a.rect[0] - b.rect[0])
    const stub = prior.filter((i) => columnOf(i) === 0).sort((a, b) => a.rect[0] - b.rect[0])
    const head = stub[0],
      first = tail[0]
    // Category labels can wrap while only the final P-value column is filled.
    // Balanced parentheses and the following counted subrow supply evidence
    // for joining this otherwise empty line, including numeric category names.
    const label = stub.map((item) => item.text).join(' ')
    const ending = tail.map((item) => item.text).join(' ')
    const balance = (text) => (text.match(/\(/g) ?? []).length - (text.match(/\)/g) ?? []).length
    const statistics = prior.filter((item) => columnOf(item) !== 0)
    const categoryContinuation =
      columnRects.length >= 4 &&
      balance(label) === 1 &&
      balance(label + ending) === 0 &&
      statistics.length === 1 &&
      columnOf(statistics[0]) === columnRects.length - 1 &&
      /^0?\.\d+$/.test(statistics[0].text) &&
      items.some(
        (item) =>
          inside(rows[r + 1].rect, item) && columnOf(item) === 0 && /^[<>≤≥]?\d+$/.test(item.text)
      )
    const following = items.filter((item) => inside(rows[r + 1].rect, item))
    const repeatedBeforeSection =
      head &&
      first &&
      following.length > 0 &&
      following.every((item) => columnOf(item) === 0 && /\p{L}/u.test(item.text)) &&
      Math.min(...following.map((item) => item.rect[0])) < head.rect[0] - head.height * 0.25 &&
      new Set(statistics.filter((item) => /[0-9]/.test(item.text)).map(columnOf)).size >= 2 &&
      items.filter((item) => columnOf(item) === 0 && item.text === head.text).length >= 2 &&
      items.filter((item) => columnOf(item) === 0 && item.text === first.text).length >= 2
    // A section can follow the final wrapped record. Two already intact
    // records establish the table's hanging indent and line leading, including
    // indents slightly wider than a font em. A lowercase line alone is unsafe.
    const witnessedBeforeSection =
      head &&
      first &&
      following.length === 1 &&
      columnOf(following[0]) === 0 &&
      /:$/.test(following[0].text) &&
      Math.abs(following[0].rect[0] - head.rect[0]) < font * 0.1 &&
      new Set(statistics.filter((item) => /^\d/.test(item.text)).map(columnOf)).size >= 2 &&
      rows.filter((row) => {
        if (row === previous || row === current) return false
        const members = items.filter((i) => inside(row.rect, i))
        const label = members
          .filter((i) => columnOf(i) === 0)
          .sort((a, b) => a.baseline - b.baseline)
        return (
          label.length >= 2 &&
          /^[a-z]/.test(label[1].text) &&
          new Set(members.filter((i) => columnOf(i) > 0 && /^\d/.test(i.text)).map(columnOf))
            .size >= 2 &&
          Math.abs(label[0].rect[0] - head.rect[0]) < font * 0.1 &&
          Math.abs(label[1].rect[0] - first.rect[0]) < font * 0.1 &&
          Math.abs(label[1].baseline - label[0].baseline - (first.baseline - head.baseline)) <
            font * 0.1
        )
      }).length >= 2
    if (
      !head ||
      !first ||
      !/^[a-z]/.test(first.text) ||
      !tail.every((i) => columnOf(i) === 0) ||
      stub.map((i) => i.text).join(' ').length < 12 ||
      stub.some((i) => Math.abs(i.baseline - head.baseline) > head.height * 0.35) ||
      first.rect[0] - head.rect[0] < head.height * 0.25 ||
      first.rect[0] - head.rect[0] > head.height * (witnessedBeforeSection ? 1.5 : 1) ||
      Math.abs(first.height - head.height) > head.height * 0.1 ||
      first.baseline - head.baseline <= head.height ||
      first.baseline - head.baseline > head.height * (categoryContinuation ? 1.8 : 1.6) ||
      tail.some((i) => Math.abs(i.baseline - first.baseline) > first.height * 0.5) ||
      (!categoryContinuation &&
        !items.some(
          (i) => inside(rows[r + 1].rect, i) && columnOf(i) === 0 && /^[A-Z]/.test(i.text)
        )) ||
      (!repeatedBeforeSection &&
        !witnessedBeforeSection &&
        columnRects
          .slice(1, categoryContinuation ? -1 : undefined)
          .some(
            (_, c) =>
              !items.some(
                (i) => inside(rows[r + 1].rect, i) && columnOf(i) === c + 1 && /^\d/.test(i.text)
              )
          )) ||
      rules.some(
        (rule) =>
          rule[1] === rule[3] &&
          rule[1] > head.baseline &&
          rule[1] < first.baseline &&
          rule[0] <= head.rect[0] &&
          rule[2] >= first.rect[2]
      )
    )
      continue
    previous.rect[3] = current.rect[3]
    if (prior.every((i) => columnOf(i) === 0)) previous.section = true
    rows.splice(r--, 1)
    repairs.push('indented-stub-continuation-recovered')
  }
  // Repeated wrapped stubs can occupy an otherwise empty model row. Require
  // an indented lowercase continuation with values in every data column.
  for (let r = rows.length - 2; r >= 0; r--) {
    const head = items.filter((i) => inside(rows[r].rect, i))
    const tail = items.filter((i) => inside(rows[r + 1].rect, i))
    const label = tail.filter((i) => columnOf(i) === 0).sort((a, b) => a.rect[0] - b.rect[0])
    if (
      head.length !== 1 ||
      columnOf(head[0]) !== 0 ||
      !label.length ||
      !/^[a-z]/.test(label[0].text) ||
      label[0].rect[0] <= head[0].rect[0] ||
      label[0].rect[0] - head[0].rect[0] > head[0].height ||
      label[0].baseline - head[0].baseline > head[0].height * 1.6 ||
      items.filter((i) => i.text === head[0].text && columnOf(i) === 0).length < 2 ||
      columnRects
        .slice(1)
        .some((_, c) => !tail.some((i) => columnOf(i) === c + 1 && /^\d/.test(i.text))) ||
      rules.some(
        (rule) =>
          rule[1] === rule[3] &&
          rule[1] > head[0].baseline &&
          rule[1] < label[0].rect[1] &&
          rule[0] <= head[0].rect[0] &&
          rule[2] >= right - 2
      )
    )
      continue
    rows[r + 1].rect[1] = Math.min(rows[r].rect[1], head[0].rect[1])
    rows[r + 1].recoveredWrappedStub = true
    rows.splice(r, 1)
    repairs.push('repeated-wrapped-stub-recovered')
  }
  // The detector can stop one native baseline early. Recover a final numeric
  // suffix only when at least two earlier records have the same populated
  // columns and token forms. A paragraph or a partial numeric row is ineligible.
  const last = rows.at(-1)
  if (last && columnRects.length >= 4) {
    const cuts = [columnRects[0][0], ...columnRects.map((r) => r[2])]
    const signature = (g) => {
      const values = readSourceRow(g, cuts)
      if (!values) return
      const start = values.findIndex(Boolean)
      if (
        start < 0 ||
        values.length - start < 4 ||
        !/^(?:[A-Z]{1,3}\d+|[<>≤≥−+-]?(?:\d+(?:\.\d+)?|\.\d+))$/.test(values[start]) ||
        values
          .slice(start + 1)
          .some((s) => !/^[<>≤≥−+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:\/\d+(?:\.\d+)?)?\*{0,2}$/.test(s))
      )
        return
      return start + ':' + (/^[A-Z]/.test(values[start]) ? 'identifier' : 'numeric')
    }
    for (const g of groups.filter((g) => union(g)[1] >= last.rect[3])) {
      const b = union(g),
        key = signature(g)
      if (b[1] - rows.at(-1).rect[3] > g[0].height * 1.5) break
      if (
        !key ||
        groups.filter(
          (prior) =>
            prior !== g &&
            signature(prior) === key &&
            rows.some((row) => prior.every((i) => inside(row.rect, i)))
        ).length < 2
      )
        break
      if (hasHorizontalTableRuleBetween(rules, rows.at(-1).rect[3], b[1])) break
      rows.push({ rect: [columnRects[0][0], b[1], right, b[3]], origin: 'source-text' })
      repairs.push('trailing-numeric-record-recovered')
    }
    const tail = groups.find(
      (g) =>
        g.length === 1 &&
        columnOf(g[0]) === 0 &&
        /^[A-Z]{1,3}\d+$/.test(g[0].text) &&
        (g[0].rect[1] + g[0].rect[3]) / 2 >= last.rect[3] &&
        g[0].rect[1] - last.rect[3] < g[0].height
    )
    if (tail) {
      const matches = groups.filter((g, n) => {
        const next = groups[n + 1]
        return (
          next?.length === 1 &&
          columnOf(next[0]) === 0 &&
          /^[A-Z]{1,3}\d+$/.test(next[0].text) &&
          Math.abs(next[0].rect[0] - tail[0].rect[0]) < 1 &&
          g.some((i) => columnOf(i) === 0 && /^[A-Z]{1,3}\d+ vs$/.test(i.text)) &&
          columnRects
            .slice(1)
            .every((_, c) => g.some((i) => columnOf(i) === c + 1 && /^[<>]?\d/.test(i.text))) &&
          next[0].baseline - g[0].baseline < next[0].height * 1.2
        )
      })
      if (matches.length >= 3 && matches.at(-1).every((i) => inside(last.rect, i))) {
        last.rect[3] = tail[0].rect[3]
        repairs.push('trailing-wrapped-comparison-recovered')
      }
    }
  }
  // Repeated arm prefixes identify two physical lines of one outcome. Use the
  // source pair, not a shifted model band that puts control values in the next row.
  const prefix = (item) => /^([A-Z]):\s*[−-]?\d+(?:\.\d+)?$/.exec(item.text.trim())?.[1]
  const pairs = groups.flatMap((head, index) => {
    const tail = groups[index + 1]
    const values = head.filter(prefix)
    if (!tail || values.length < 2 || !head.some((i) => columnOf(i) === 0 && /\p{L}/u.test(i.text)))
      return []
    const first = prefix(values[0]),
      second = prefix(tail.find(prefix) ?? { text: '' })
    const columns = values.map(columnOf).sort((a, b) => a - b)
    if (
      !second ||
      first === second ||
      columns[0] < 1 ||
      values.some((i) => prefix(i) !== first) ||
      tail.some(
        (i) =>
          columnOf(i) === 0 ||
          (prefix(i) ? prefix(i) !== second : !/^[<>≤≥]?\s*\d+(?:\.\d+)?$/.test(i.text.trim()))
      ) ||
      JSON.stringify(
        tail
          .filter(prefix)
          .map(columnOf)
          .sort((a, b) => a - b)
      ) !== JSON.stringify(columns) ||
      union(tail)[1] < union(head)[3] ||
      union(tail)[1] - union(head)[3] > values[0].height ||
      hasHorizontalTableRuleBetween(rules, union(head)[3], union(tail)[1])
    )
      return []
    return [{ items: [...head, ...tail], first, second, columns }]
  })
  if (
    pairs.length < 3 ||
    pairs.some(
      (p) =>
        p.first !== pairs[0].first ||
        p.second !== pairs[0].second ||
        JSON.stringify(p.columns) !== JSON.stringify(pairs[0].columns)
    )
  )
    return
  const bounds = union(pairs.flatMap((p) => p.items))
  const members = new Set(pairs.flatMap((p) => p.items))
  const other = groups.filter((g) =>
    g.some((i) => !members.has(i) && i.rect[1] >= bounds[1] && i.rect[3] <= bounds[3])
  )
  if (
    other.some(
      (g) =>
        !g.every((i) => columnOf(i) === 0) ||
        !g
          .map((i) => i.text)
          .join(' ')
          .endsWith(':')
    )
  )
    return
  const left = columnRects[0][0]
  rows.splice(
    0,
    rows.length,
    ...rows.filter((r) => r.rect[3] <= bounds[1] || r.rect[1] >= bounds[3]),
    ...[...pairs.map((p) => p.items), ...other].map((g) => ({
      rect: [left, union(g)[1], right, union(g)[3]],
      origin: 'source-arm-record'
    }))
  )
  rows.sort((a, b) => a.rect[1] - b.rect[1])
  repairs.push('paired-arm-outcomes-recovered')
}

// Additive total/child counts in both cohorts witness bracketed interval
// tails. A tail may carry a wrapped stub, but cannot carry another count or P.
function repairCountedIntervalTails({ rows, items, columnRects, rules, repairs, sourceRows }) {
  if (columnRects.length !== 9) return
  const cuts = [columnRects[0][0], ...columnRects.map((r) => r[2])]
  const col = (i) => columnRects.findIndex((r) => i.rect[0] >= r[0] && i.rect[2] <= r[2])
  const role = (i) => (i.rect[0] < cuts[1] && /\p{L}/u.test(i.text) ? 0 : col(i))
  if (
    ![4, 8].every((c) =>
      sourceRows.some(
        (g) =>
          g
            .filter((i) => role(i) === c)
            .map((i) => i.text)
            .join('')
            .replace(/\s/g, '') === 'PValue'
      )
    )
  )
    return
  const pairs = []
  for (let n = 1; n < sourceRows.length; n++) {
    const head = sourceRows[n - 1],
      tail = sourceRows[n],
      h = head[0].height
    const values = readSourceRow(head, cuts)
    if (!values || !values[0]) continue
    const counts = [1, 2, 3, 5, 6, 7].map((c) => /^(\d+)\(\d+(?:\.\d+)?\)[*†‡§]*$/.exec(values[c]))
    if (
      counts.some((m) => !m) ||
      Number(counts[0][1]) !== Number(counts[1][1]) + Number(counts[2][1]) ||
      Number(counts[3][1]) !== Number(counts[4][1]) + Number(counts[5][1]) ||
      ![4, 8].every((c) => /^(?:…|0?\.\d+|1(?:\.0+)?)$/.test(values[c]))
    )
      continue
    const intervals = tail.filter((i) => role(i) > 0)
    const labels = tail.filter((i) => role(i) === 0)
    if (
      intervals.length < 3 ||
      !intervals.every(
        (i) => [2, 3, 6, 7].includes(role(i)) && /^\[[\d.]+,\s*[\d.]+\]$/.test(i.text)
      ) ||
      new Set(intervals.map(role)).size !== intervals.length ||
      tail.some((i) => role(i) < 0) ||
      labels.some(
        (i) =>
          Math.abs(i.rect[0] - head.find((j) => role(j) === 0)?.rect[0]) > h * 0.1 ||
          Math.abs(i.height - h) > h * 0.05
      ) ||
      union(tail)[1] < union(head)[3] ||
      union(tail)[3] - union(head)[3] > h * 1.6 ||
      hasHorizontalTableRuleBetween(rules, union(head)[3], union(tail)[1])
    )
      continue
    pairs.push([...head, ...tail])
  }
  if (pairs.length < 3) return
  for (const pair of pairs) {
    const box = union(pair),
      owners = rows.filter((r) => pair.some((i) => inside(r.rect, i)))
    if (
      owners.length < 2 ||
      items.some(
        (i) =>
          !pair.includes(i) &&
          owners.some((r) => inside(r.rect, i)) &&
          !rows.some((r) => !owners.includes(r) && inside(r.rect, i))
      )
    )
      continue
    const start = rows.indexOf(owners[0])
    if (owners.some((r, n) => rows.indexOf(r) !== start + n)) continue
    rows.splice(start, owners.length, {
      rect: [cuts[0], box[1], cuts.at(-1), box[3]],
      origin: 'source-text'
    })
    repairs.push('wrapped-interval-record-recovered')
  }
}

// A count/percentage table can start with a category total, whose percentage
// is intentionally blank. Repeated sparse category rows distinguish that total
// from a wrapped heading or a sample size belonging to the column heading.
export function separateCountedCategoryHeader({ rows, groups, columnRects, headers, repairs }) {
  if (columnRects.length !== 3 || groups.length < 5 || !rows.length) return
  const values = (group) =>
    columnRects.map((column) =>
      group
        .filter((item) => inside(column, item))
        .map((item) => item.text)
        .join(' ')
        .trim()
    )
  const sparse = (group) => {
    const [label, count, percent] = values(group)
    return /\p{L}/u.test(label) && /^\d+$/.test(count) && !percent
  }
  const [heading, category, record] = groups
  const [label, count, percent] = values(heading)
  if (
    !/\p{L}/u.test(label) ||
    !/^(?:Number|Count|No\.|N)$/i.test(count) ||
    !/^(?:%|Percent(?:age)?)$/i.test(percent) ||
    !sparse(category) ||
    !groups.slice(3).some(sparse) ||
    !values(record)
      .slice(1)
      .every((value) => /^\d+(?:\.\d+)?%?$/.test(value))
  )
    return
  const headRect = union(heading),
    categoryRect = union(category)
  const first = rows[0]
  if (
    !heading.every((item) => inside(first.rect, item)) ||
    !category.every((item) => inside(first.rect, item)) ||
    headRect[3] >= categoryRect[1] ||
    categoryRect[1] - headRect[3] > Math.max(...heading.map((item) => item.height)) ||
    !headers.some((header) => heading.every((item) => inside(header.rect, item)))
  )
    return
  const split = (headRect[3] + categoryRect[1]) / 2
  rows.splice(
    0,
    1,
    { ...first, rect: [first.rect[0], Math.min(first.rect[1], headRect[1]), first.rect[2], split] },
    {
      rect: [first.rect[0], split, first.rect[2], Math.max(first.rect[3], categoryRect[3])],
      origin: 'source-category'
    }
  )
  for (const header of headers.filter((header) =>
    heading.some((item) => inside(header.rect, item))
  ))
    header.rect[3] = Math.min(header.rect[3], split)
  repairs.push('counted-category-header-separated')
}

// A lowered/raised glyph can fall into an otherwise empty predicted row.
// Attach it only when the rest of its source baseline already has one owner;
// do not expand across any unrelated text.
export function repairInlineFragmentRows({ rows, groups, items, left, right, repairs }) {
  // A sample size can wrap below the first mean/CI heading while the other
  // sample sizes fit alongside it. Join only that complete three-group header.
  for (let n = 1; n < groups.length - 1; n++) {
    const tail = groups[n],
      head = groups[n - 1],
      following = groups[n + 1]
    const mean = head.find((i) => /^Mean \(95% CI\)$/.test(i.text))
    if (
      !mean ||
      !/^n=\d+$/.test(
        tail
          .map((i) => i.text)
          .join('')
          .replace(/\s/g, '')
      ) ||
      Math.abs(tail[0].rect[0] - mean.rect[0]) > 1 ||
      (
        [...head]
          .sort((a, b) => a.rect[0] - b.rect[0])
          .map((i) => i.text)
          .join('')
          .replace(/\s/g, '')
          .match(/n=\d+/g) ?? []
      ).length !== 2 ||
      following.filter((i) => /^\d+\.\d+ \(\d+\.\d+[–−-]\d+\.\d+\)$/.test(i.text)).length !== 3 ||
      union(tail)[1] - union(head)[3] > mean.height
    )
      continue
    const members = [...head, ...tail]
    const touched = rows.filter((r) =>
      members.some((i) => inside([left, r.rect[1], right, r.rect[3]], i))
    )
    if (touched.length !== 2) continue
    const first = rows.indexOf(touched[0]),
      second = rows.indexOf(touched[1])
    const rect = [
      left,
      Math.min(touched[0].rect[1], union(head)[1]),
      right,
      Math.max(touched[1].rect[3], union(tail)[3])
    ]
    if (
      second !== first + 1 ||
      items.some((i) => inside(rect, i) && !members.includes(i)) ||
      members.some((i) => !inside(rect, i))
    )
      continue
    rows[first].rect = rect
    rows.splice(second, 1)
    repairs.push('inline-fragment-row-recovered')
  }

  for (const group of groups) {
    const height = Math.max(...group.map((i) => i.height))
    const body = group.filter((i) => i.height >= height * 0.8)
    const small = group.filter((i) => i.height < height * 0.8)
    if (!body.length || !small.length) continue
    const owners = rows.filter((r) =>
      body.some((i) => inside([left, r.rect[1], right, r.rect[3]], i))
    )
    if (owners.length !== 1) continue
    const owner = owners[0]
    if (!body.every((i) => inside([left, owner.rect[1], right, owner.rect[3]], i))) continue
    const outside = small.filter((i) => !inside([left, owner.rect[1], right, owner.rect[3]], i))
    if (!outside.length) continue
    const centers = outside.map((i) => (i.rect[1] + i.rect[3]) / 2)
    const rect = [
      left,
      Math.min(owner.rect[1], ...centers) - 0.01,
      right,
      Math.max(owner.rect[3], ...centers) + 0.01
    ]
    if (
      items.some(
        (i) =>
          !group.includes(i) &&
          inside(rect, i) &&
          !inside([left, owner.rect[1], right, owner.rect[3]], i)
      )
    )
      continue
    const touched = rows.filter((r) => r !== owner && r.rect[1] < rect[3] && r.rect[3] > rect[1])
    if (
      touched.some((r) =>
        items.some((i) => inside([left, r.rect[1], right, r.rect[3]], i) && !small.includes(i))
      )
    )
      continue
    rows.splice(0, rows.length, ...rows.filter((r) => !touched.includes(r)))
    owner.rect = rect
    repairs.push('inline-fragment-row-recovered')
  }
}

// Repeated names followed by parenthesized sample sizes are wrapped leaf
// headings only when a native frame encloses both lines without a divider.
// Source ownership and complete body records independently confirm each column.
export function coalesceSampleSizeHeader({ rows, items, columnRects, headers, rules, repairs }) {
  if (rows.length < 5 || columnRects.length < 3 || columnRects.length > 12) return
  const left = columnRects[0][0],
    right = columnRects.at(-1)[2]
  // A sample-only detector header can omit the preceding names entirely.
  // Multiple same-column sample/name pairs and complete numeric records
  // establish ownership even when the publisher's frame is not a PDF stroke.
  const firstItems = items.filter((i) => i.horizontal && inside(rows[0].rect, i))
  const cuts = [left, ...columnRects.map((c) => c[2])]
  const sampleValues = readSourceRow(firstItems, cuts)
  if (
    columnRects.length >= 4 &&
    sampleValues &&
    !sampleValues[0] &&
    !sampleValues.at(-1) &&
    sampleValues.slice(1, -1).every((s) => /^\(n=\d+\)$/i.test(s)) &&
    headers.some((h) => firstItems.every((i) => inside(h.rect, i)))
  ) {
    const height = Math.max(...firstItems.map((i) => i.height))
    const leading = items.filter(
      (i) =>
        i.horizontal &&
        i.rect[1] >= rows[0].rect[1] - height * 4 &&
        i.rect[3] <= rows[0].rect[1] &&
        i.rect[0] >= left &&
        i.rect[2] <= right
    )
    const names = readSourceRow(leading, cuts)
    const bounds = leading.length ? union(leading) : undefined
    const body = rows.slice(1, 4).map((r) =>
      readSourceRow(
        items.filter((i) => i.horizontal && inside([left, r.rect[1], right, r.rect[3]], i)),
        cuts
      )
    )
    if (
      bounds &&
      names &&
      !names[0] &&
      /^p-?value$/i.test(names.at(-1)) &&
      names.slice(1, -1).every((s) => /^[\p{L}][\p{L}\d-]+$/u.test(s)) &&
      bounds[3] - bounds[1] < height * 1.3 &&
      rows[0].rect[1] - bounds[3] < height * 2 &&
      !hasHorizontalTableRuleBetween(rules, bounds[3], union(firstItems)[1]) &&
      body.every(
        (v) =>
          v &&
          /\p{L}/u.test(v[0]) &&
          v.slice(1, -1).every((s) => /^[−+-]?\d[\d.±()%−–+/-]*$/.test(s)) &&
          /^(?:[<>≤≥]?0?\.\d+|1(?:\.0+)?)$/.test(v.at(-1))
      )
    ) {
      rows[0].rect = [left, bounds[1], right, rows[0].rect[3]]
      repairs.push('inline-fragment-row-recovered')
      return
    }
  }
  // A detector row may contain only the names or only the sample sizes.
  // Recover the complete first ruled band when every sample has one textual
  // parent in the same column and none of those tokens belongs to a body row.
  const edges = joinHorizontalTableRules(rules).filter(
    (r) => r[0] <= left + 16 && r[2] >= right - 16
  )
  const first = rows[0].rect
  const bandAbove = edges.filter((r) => r[1] <= first[1]).at(-1)
  const bandBelow = edges.find((r) => r[1] >= first[3] && r[1] <= rows[1].rect[1] + 4)
  if (bandAbove && bandBelow) {
    const band = items.filter(
      (i) => i.horizontal && inside([left, bandAbove[1], right, bandBelow[1]], i)
    )
    const height = Math.max(...band.map((i) => i.height))
    const paired = columnRects.slice(1).map((c) => {
      const tokens = band.filter((i) => i.rect[0] >= c[0] && i.rect[2] <= c[2])
      const samples = tokens.filter((i) => /^(?:\(?n\s*=\s*\d+\)?|n|=|\d+)$/i.test(i.text.trim()))
      const names = tokens.filter((i) => !samples.includes(i))
      const text = samples
        .map((i) => i.text)
        .join('')
        .replace(/\s/g, '')
      return {
        tokens,
        samples,
        names,
        valid:
          /^\(?n=\d+\)?$/i.test(text) &&
          names.length > 0 &&
          names.every((i) => /\p{L}/u.test(i.text)) &&
          Math.max(...names.map((i) => i.rect[3])) <= Math.min(...samples.map((i) => i.rect[1])) &&
          Math.max(...tokens.map((i) => i.rect[3])) - Math.min(...tokens.map((i) => i.rect[1])) <
            height * 4
      }
    })
    if (
      band.length &&
      bandBelow[1] - bandAbove[1] < height * 5 &&
      paired.filter((p) => p.valid).length >= 2 &&
      paired.every((p) => p.valid || p.samples.length === 0) &&
      band.every((i) => columnRects.some((c) => i.rect[0] >= c[0] && i.rect[2] <= c[2])) &&
      band.some((i) => !inside(first, i)) &&
      !band.some((i) => rows.slice(1).some((r) => inside(r.rect, i)))
    ) {
      rows[0] = { rect: [left, bandAbove[1], right, bandBelow[1]], origin: 'source-native-header' }
      rows[1].rect[1] = Math.max(rows[1].rect[1], bandBelow[1])
      repairs.push('inline-fragment-row-recovered')
      return
    }
  }
  const parts = rows
    .slice(0, 2)
    .map((r) => items.filter((i) => inside([left, r.rect[1], right, r.rect[3]], i)))
  if (parts.some((p) => !p.length)) return
  const [names, samples] = parts,
    top = union(names),
    bottom = union(samples),
    height = Math.max(...parts.flat().map((i) => i.height)),
    members = new Set(parts.flat())
  // Raised scripts can enlarge the name line; the enclosing native frame below
  // must still prove that both lines belong to one undivided header band.
  if (
    members.size !== names.length + samples.length ||
    top[3] >= bottom[1] ||
    bottom[1] - top[3] > height ||
    bottom[3] - top[1] > height * 4 ||
    [...members].some((i) => !i.horizontal) ||
    items.some((i) => inside([left, top[1], right, bottom[3]], i) && !members.has(i))
  )
    return
  const withinColumn = (i, c) => i.rect[0] >= c[0] && i.rect[2] <= c[2]
  if ([...members].some((i) => columnRects.filter((c) => withinColumn(i, c)).length !== 1)) return
  const text = (tokens) =>
    tokens
      .map((i) => i.text)
      .join('')
      .replace(/\s/g, '')
  const flat =
    samples.every((i) => /^[a-z][a-z -]*$/.test(i.text)) &&
    [...members].every((i) => Math.abs(i.height - height) < height * 0.05)
  const qualifiedSamples = columnRects
    .slice(1)
    .map(
      (column) =>
        text(samples.filter((i) => withinColumn(i, column))).match(
          /^(\d+(?:\.\d+)?\p{L}[\p{L}\d./-]*)\(n=\d+\)$/iu
        )?.[1]
    )
  const qualifiers = qualifiedSamples.filter(Boolean)
  const repeatedQualifier = qualifiers.length >= 2 && new Set(qualifiers).size === 1
  if (flat && (bottom[1] - top[3] > height * 0.75 || bottom[3] - top[1] > height * 3)) return
  if (
    !flat &&
    !headers.some((h) => samples.every((i) => intersection(h.rect, i.rect) > area(i.rect) * 0.5))
  )
    return
  const paired = []
  for (let c = 0; c < columnRects.length; c++) {
    const name = names.filter((i) => withinColumn(i, columnRects[c])),
      sample = samples.filter((i) => withinColumn(i, columnRects[c]))
    if (name.length) {
      // A statistic column may have a standalone label beside repeated N pairs.
      if (
        !sample.length &&
        (flat || ((c === 0 || c === columnRects.length - 1) && /^\p{L}/u.test(text(name))))
      )
        continue
      if (
        !/^\p{L}/u.test(text(name)) ||
        !(flat
          ? /^[a-z]+$/.test(text(sample))
          : /^\(n=\d+\)$/i.test(text(sample)) || (repeatedQualifier && qualifiedSamples[c - 1])) ||
        (Math.abs(union(name)[0] - union(sample)[0]) > height * (flat ? 0.1 : 0.5) &&
          (flat ||
            Math.abs((union(name)[0] + union(name)[2] - union(sample)[0] - union(sample)[2]) / 2) >
              height * 0.5))
      )
        return
      paired.push(c)
    } else if (!sample.length && c === 0 && !flat) continue
    else if (flat || !/^\p{L}[\p{L}-]*$/u.test(text(sample))) return
  }
  if (paired.length < 2 || (!flat && paired.includes(0))) return
  const horizontal = joinHorizontalTableRules(rules)
  const frame = horizontal.filter(
    (r) => r[0] <= Math.min(top[0], bottom[0]) + 1 && r[2] >= Math.max(top[2], bottom[2]) - 1
  )
  const above = frame.find((r) => r[1] <= top[1] && top[1] - r[1] < height)
  let below = frame.find((r) => r[1] >= bottom[3] && r[1] - bottom[3] < height)
  // Some publishers shade rows instead of drawing a header divider. A
  // repeated numeric qualifier before N still belongs to the cohort name:
  // require a complete native outer frame, centered pairs, model header
  // support and complete body records before deriving the whitespace edge.
  let outerFrame = false
  if (!below && above && repeatedQualifier) {
    const body = items.filter((i) =>
      rows.slice(2).some((r) => inside([left, r.rect[1], right, r.rect[3]], i))
    )
    const closing =
      body.length && frame.find((r) => r[1] >= union(body)[3] && r[1] - union(body)[3] < height * 2)
    if (
      closing &&
      Math.abs(above[0] - closing[0]) < height * 0.2 &&
      Math.abs(above[2] - closing[2]) < height * 0.2 &&
      union(body)[1] > bottom[3] &&
      union(body)[1] - bottom[3] < height * 2 &&
      [...members].every((i) => Math.abs(i.height - height) < height * 0.05)
    ) {
      const edge = (bottom[3] + union(body)[1]) / 2
      below = [above[0], edge, above[2], edge]
      outerFrame = true
    }
  }
  if (
    !above ||
    !below ||
    Math.abs(above[0] - below[0]) > height * 0.2 ||
    Math.abs(above[2] - below[2]) > height * 0.2 ||
    horizontal.some((r) => r[1] > top[1] && r[1] < bottom[3] && r[2] > left && r[0] < right) ||
    rules.some(
      (r) =>
        r[0] === r[2] &&
        r[0] > left + (outerFrame ? height * 0.5 : 0) &&
        r[0] < right - (outerFrame ? height * 0.5 : 0) &&
        r[1] < bottom[3] &&
        r[3] > top[1]
    ) ||
    items.some((i) => inside([left, above[1], right, below[1]], i) && !members.has(i))
  )
    return
  const complete = rows.slice(2).filter((r) => {
    const source = items.filter((i) => inside([left, r.rect[1], right, r.rect[3]], i))
    return (
      source.length &&
      union(source)[1] > below[1] &&
      (flat
        ? columnRects.every((c) => source.some((i) => withinColumn(i, c)))
        : paired.every((c) =>
            /^\d[\d.,()–−+%\s/-]*$/.test(
              text(source.filter((i) => withinColumn(i, columnRects[c])))
            )
          ))
    )
  })
  if (complete.length < 3) return
  rows.splice(0, 2, { rect: [left, above[1], right, below[1]], origin: 'source-native-header' })
  repairs.push('inline-fragment-row-recovered')
}

// A projected section span can drift into the next numeric row. Source text
// ownership and a continuous label establish the actual section row.
export function recoverProjectedSectionRows({
  rows,
  items,
  groups = [],
  columnRects,
  headers,
  rules = [],
  repairs
}) {
  // A stub heading swallowed by the preceding count row has the same
  // outdent as independently owned sections with matching measurement lanes.
  // Blank comparison columns are retained; they need not repeat on every row.
  if (columnRects.length >= 3) {
    const cuts = [columnRects[0][0], ...columnRects.map((c) => c[2])]
    const countKey = (g) => {
      const values = g && readSourceRow(g, cuts)
      if (!values || !/\p{L}/u.test(values[0])) return
      const populated = values.slice(1).flatMap((s, n) => (s ? [n + 1] : []))
      if (
        populated.length < 2 ||
        populated.some((c) => !/^\d+(?:\(\d+(?:\.\d+)?%\))?$/.test(values[c]))
      )
        return
      return populated.join(',')
    }
    const headings = groups.flatMap((g, n) => {
      const label = g[0],
        key = countKey(groups[n + 1])
      if (
        !key ||
        !g.length ||
        !g.every(
          (i) =>
            i.horizontal && i.rect[0] >= cuts[0] && i.rect[2] <= cuts[1] && /\p{L}/u.test(i.text)
        ) ||
        !/^\p{Lu}/u.test(label.text) ||
        Math.min(...groups[n + 1].filter((i) => inside(columnRects[0], i)).map((i) => i.rect[0])) -
          label.rect[0] <
          label.height * 0.5 ||
        union(g)[3] > union(groups[n + 1])[1] ||
        groups[n + 1][0].baseline - label.baseline > label.height * 1.5
      )
        return []
      return [{ group: g, label, key, index: n }]
    })
    for (const h of headings) {
      const before = groups[h.index - 1]
      if (
        countKey(before) !== h.key ||
        h.label.baseline - before[0].baseline > h.label.height * 1.5 ||
        hasHorizontalTableRuleBetween(rules, before[0].baseline, h.label.baseline) ||
        headings.filter(
          (p) =>
            p !== h &&
            p.key === h.key &&
            Math.abs(p.label.rect[0] - h.label.rect[0]) < h.label.height * 0.1 &&
            Math.abs(p.label.height - h.label.height) < h.label.height * 0.1 &&
            rows.some(
              (r) =>
                p.group.every((i) => inside(r.rect, i)) &&
                items.filter((i) => inside(r.rect, i)).every((i) => p.group.includes(i))
            )
        ).length < 2
      )
        continue
      const split = splitOwnedSourceRow(rows, items, before, h.group, [cuts[0], cuts.at(-1)])
      if (!split) continue
      split.rows[0].numericRecord = true
      split.rows[1].section = true
      rows.splice(split.index, 1, ...split.rows)
      repairs.push('projected-section-record-separated')
    }
  }
  // In paired summary tables a section can be swallowed by the preceding
  // median/range line. Repeated outdented headings and complete numeric tails
  // establish both owners; a lone stub line is not sufficient evidence.
  if (columnRects.length >= 3) {
    const cuts = [columnRects[0][0], ...columnRects.map((c) => c[2])]
    const candidates = groups.flatMap((heading, n) => {
      if (n < 2 || !groups[n + 1] || heading.length !== 1) return []
      const label = heading[0],
        before = groups[n - 1],
        after = groups[n + 1]
      const tail = readSourceRow(before, cuts),
        next = readSourceRow(after, cuts)
      const head = readSourceRow(groups[n - 2], cuts)
      const stub = after.filter((i) => inside(columnRects[0], i))
      if (
        !inside(columnRects[0], label) ||
        !/^\p{Lu}/u.test(label.text) ||
        !tail ||
        tail[0] ||
        !head ||
        !/\p{L}/u.test(head[0]) ||
        !next ||
        !/\p{L}/u.test(next[0]) ||
        !stub.length ||
        Math.min(...stub.map((i) => i.rect[0])) - label.rect[0] < label.height * 0.5 ||
        !tail.slice(1).every((s) => /^[<>≤≥−+-]?\d[\d.,()–−+\-/]*$/.test(s)) ||
        head.slice(1).filter((s) => /^[-−]?\d+(?:\.\d+)?\([\d.]+\)$/.test(s)).length < 2 ||
        next.slice(1).filter((s) => /^[-−]?\d+(?:\.\d+)?\([\d.]+\)$/.test(s)).length < 2 ||
        label.baseline - before[0].baseline > label.height * 1.5 ||
        after[0].baseline - label.baseline > label.height * 1.5
      )
        return []
      return [{ heading, before, label }]
    })
    for (const candidate of candidates) {
      if (
        !candidates.some(
          (peer) =>
            peer !== candidate &&
            Math.abs(peer.label.rect[0] - candidate.label.rect[0]) < 1 &&
            Math.abs(peer.label.height - candidate.label.height) < 0.1
        )
      )
        continue
      const split = splitOwnedSourceRow(rows, items, candidate.before, candidate.heading, [
        cuts[0],
        cuts.at(-1)
      ])
      if (!split) continue
      split.rows[0].numericRecord = true
      split.rows[1].section = true
      rows.splice(split.index, 1, ...split.rows)
      repairs.push('projected-section-record-separated')
    }
  }
  // A demographic heading can share a model band with its first indented
  // count record. Independently owned peer headings establish the indentation;
  // split only when every token in the affected band has exactly one owner.
  if (columnRects.length >= 2 && columnRects.length <= 4) {
    const cuts = [columnRects[0][0], ...columnRects.map((c) => c[2])]
    const candidates = groups.flatMap((heading, n) => {
      const next = groups[n + 1]
      if (!next || !heading.length) return []
      const label = heading[0],
        values = readSourceRow(next, cuts)
      const stub = next.filter((i) => inside(columnRects[0], i))
      if (
        !heading.every((i) => inside(columnRects[0], i)) ||
        !/^\p{Lu}/u.test(label.text) ||
        heading.map((i) => i.text).join(' ').length > 70 ||
        !values ||
        !/\p{L}/u.test(values[0]) ||
        !values.slice(1).every((v) => /^\d+(?:\(\d+(?:\.\d+)?%?\))?$/.test(v)) ||
        !stub.length ||
        Math.min(...stub.map((i) => i.rect[0])) - label.rect[0] < label.height * 0.5 ||
        label.rect[3] - union(next)[1] > label.height * 0.1 ||
        union(next)[1] - label.rect[3] > label.height
      )
        return []
      return [{ heading, next, label }]
    })
    for (const candidate of candidates) {
      const peers = candidates.filter(
        (peer) =>
          peer !== candidate &&
          Math.abs(peer.label.rect[0] - candidate.label.rect[0]) < 1 &&
          rows.some(
            (row) =>
              inside(row.rect, peer.label) &&
              items.filter((i) => inside(row.rect, i)).every((i) => peer.heading.includes(i))
          )
      )
      if (peers.length < 2) continue
      const split = splitOwnedSourceRow(rows, items, candidate.heading, candidate.next, [
        cuts[0],
        cuts.at(-1)
      ])
      if (!split) continue
      split.rows[0].section = true
      split.rows[1].numericRecord = true
      rows.splice(split.index, 1, ...split.rows)
      repairs.push('projected-section-record-separated')
    }
  }
  // Two-column grading/definition lists can begin with an omitted section.
  // Require a later matching section style and repeated numbered labels.
  if (columnRects.length === 2 && rows.length >= 5 && groups.length) {
    const lead = groups[0]
    if (
      lead.length === 1 &&
      /:$/u.test(lead[0].text) &&
      /\p{L}/u.test(lead[0].text) &&
      lead[0].rect[3] < rows[0].rect[1] &&
      rows[0].rect[1] - lead[0].rect[3] < lead[0].height * 2 &&
      groups.some(
        (g) =>
          g !== lead &&
          g.length === 1 &&
          /:$/u.test(g[0].text) &&
          Math.abs(g[0].rect[0] - lead[0].rect[0]) < 2 &&
          rows.some((row) => inside(row.rect, g[0]))
      ) &&
      items.filter((i) => inside(columnRects[0], i) && /^[\p{L} ]+ \d+$/u.test(i.text)).length >= 4
    ) {
      rows.unshift({
        rect: [columnRects[0][0], lead[0].rect[1], columnRects[1][2], lead[0].rect[3]],
        origin: 'source-text',
        section: true
      })
      repairs.push('projected-section-row-recovered')
    }
  }
  // A complete count record followed by a projected section and another
  // complete record supplies both sides of a lost row boundary.
  if (columnRects.length >= 3 && rows.length) {
    const left = columnRects[0][0],
      right = columnRects.at(-1)[2]
    const col = (i) => columnRects.findIndex((c) => inside(c, i))
    const counts = (g) =>
      g.some((i) => col(i) === 0 && /\p{L}/u.test(i.text)) &&
      columnRects.slice(1, columnRects.length === 5 ? -1 : undefined).every((_, n) =>
        /^\d+\s*\(\d+(?:\.\d+)?%?\)$/.test(
          g
            .filter((i) => col(i) === n + 1)
            .map((i) => i.text)
            .join('')
        )
      )
    for (let n = 1; n < groups.length - 1; n++) {
      const heading = groups[n],
        before = groups[n - 1],
        after = groups[n + 1]
      if (
        heading.length !== 1 ||
        col(heading[0]) !== 0 ||
        !/^\p{Lu}/u.test(heading[0].text) ||
        !counts(before) ||
        !counts(after) ||
        !(
          headers.some(
            (h) => intersection(h.rect, heading[0].rect) / area(heading[0].rect) > 0.4
          ) ||
          (groups.filter(
            (g) =>
              g.length === 1 &&
              col(g[0]) === 0 &&
              Math.abs(g[0].rect[0] - heading[0].rect[0]) < 1 &&
              headers.some((h) => intersection(h.rect, g[0].rect) / area(g[0].rect) > 0.4)
          ).length >= 3 &&
            ([before, after].every((g) =>
              g
                .filter((i) => col(i) === 0)
                .every((i) => i.rect[0] - heading[0].rect[0] >= heading[0].height * 0.5)
            ) ||
              /\([^)]*(?:outcome|score|scale|status)\)/i.test(heading[0].text)))
        ) ||
        heading[0].baseline - before[0].baseline > heading[0].height * 1.8 ||
        after[0].baseline - heading[0].baseline > heading[0].height * 1.8
      )
        continue
      const split = splitOwnedSourceRow(rows, items, before, heading, [left, right])
      if (!split) continue
      split.rows[0].numericRecord = true
      split.rows[1].section = true
      rows.splice(split.index, 1, ...split.rows)
      repairs.push('projected-section-record-separated')
    }
  }
  if (columnRects.length < 4 || !rows.length) return
  const left = columnRects[0][0],
    right = columnRects.at(-1)[2]
  const columnOf = (item) => columnRects.findIndex((column) => inside(column, item))
  // An unowned section can sit in a clean gap before the same pair of arms
  // used by other projected sections. Require their repeated measurement
  // columns, indentation and two independently owned section witnesses.
  const cuts = [left, ...columnRects.map((r) => r[2])]
  const armSection = (n) => {
    const heading = groups[n]
    if (heading.length !== 1 || !/^\p{Lu}/u.test(heading[0].text) || columnOf(heading[0]) !== 0)
      return
    const arms = groups.slice(n + 1, n + 3)
    if (arms.length !== 2) return
    const values = arms.map((g) => readSourceRow(g, cuts))
    if (values.some((v) => !v || !/^\p{L}+$/u.test(v[0])) || values[0][0] === values[1][0]) return
    const columns = values.map((v) =>
      v.flatMap((s, c) => (/^\d+(?:\.\d+)?±\d+(?:\.\d+)?$/.test(s) ? [c] : []))
    )
    if (
      columns[0].length < 3 ||
      columns[0].join() !== columns[1].join() ||
      arms.some((g, k) => {
        const stub = g.find((i) => columnOf(i) === 0)
        const prior = k ? arms[0][0] : heading[0]
        return (
          !stub ||
          stub.rect[0] - heading[0].rect[0] < heading[0].height * 0.5 ||
          stub.baseline - prior.baseline > heading[0].height * 2 ||
          !rows.some((row) => g.every((i) => inside(row.rect, i)))
        )
      })
    )
      return
    return {
      label: heading[0],
      firstArm: arms[0],
      signature: `${values[0][0]}|${values[1][0]}|${columns[0].join()}`
    }
  }
  const sections = groups.flatMap((_, n) => {
    const section = armSection(n)
    return section ? [section] : []
  })
  for (const { label, firstArm, signature } of sections) {
    if (rows.some((row) => inside(row.rect, label))) continue
    const peers = sections.filter(
      (s) =>
        s.label !== label &&
        s.signature === signature &&
        Math.abs(s.label.rect[0] - label.rect[0]) < 1 &&
        rows.some((row) => inside(row.rect, s.label)) &&
        headers.some((h) => intersection(h.rect, s.label.rect) / area(s.label.rect) > 0.8)
    )
    const next = rows.findIndex((row) => firstArm.every((i) => inside(row.rect, i)))
    if (
      peers.length < 2 ||
      next <= 0 ||
      rows[next - 1].rect[3] >= label.rect[1] ||
      items.some((i) => inside(rows[next].rect, i) && i.rect[1] <= label.rect[3])
    )
      continue
    // Two detector bands may own exactly the same first arm. Consolidate only
    // those identical source owners; otherwise inserting the section can leave
    // a short empty band crossing the first record's glyphs.
    const duplicates = rows.flatMap((row, n) =>
      n >= next &&
      firstArm.every((i) => inside(row.rect, i)) &&
      items.filter((i) => inside(row.rect, i)).every((i) => firstArm.includes(i))
        ? [n]
        : []
    )
    if (duplicates[0] === next && duplicates.length > 1) {
      for (const n of duplicates.slice(1).reverse()) rows.splice(n, 1)
      rows[next] = {
        rect: [left, union(firstArm)[1], right, union(firstArm)[3]],
        origin: 'source-text'
      }
    }
    rows[next].rect[1] = Math.max(rows[next].rect[1], (label.rect[3] + union(firstArm)[1]) / 2)
    rows.splice(next, 0, {
      rect: [left, label.rect[1], right, label.rect[3]],
      origin: 'source-text',
      section: true
    })
    repairs.push('projected-section-row-recovered')
  }
  // A section title may be the last source line before a page break. The
  // repeated count-heading format and alignment establish its role even when
  // the model ends at the preceding data row; its records continue next page.
  const countHeading = (item) => /^\p{Lu}[\p{L} /-]+,\s*N\s*\(%\)$/u.test(item.text)
  const tail = items.filter((i) => i.horizontal && i.rect[1] > rows.at(-1).rect[3])
  if (tail.length === 1 && countHeading(tail[0])) {
    const label = tail[0]
    const peers = items.filter(
      (i) =>
        countHeading(i) &&
        Math.abs(i.rect[0] - label.rect[0]) < label.height * 0.2 &&
        rows.some((row) => inside(row.rect, i)) &&
        headers.some((h) => intersection(h.rect, i.rect) / area(i.rect) > 0.4)
    )
    if (
      peers.length >= 3 &&
      label.rect[1] - rows.at(-1).rect[3] < label.height &&
      label.rect[0] >= left - label.height &&
      label.rect[2] < columnRects[0][2]
    ) {
      rows.push({
        rect: [left, label.rect[1], right, label.rect[3]],
        origin: 'source-text',
        section: true
      })
      repairs.push('projected-section-row-recovered')
    }
  }
  // Repeated centered section labels can have a projected span but no row.
  // Matching literal wording, two existing section peers and consecutive
  // records on both sides establish the omitted band without guessing its text.
  const sectionKey = (text) => text.replace(/\d+(?:[.,]\d+)?/g, '#')
  const centeredSection = (group) =>
    group.length === 1 &&
    /\p{L}/u.test(group[0].text) &&
    group[0].rect[2] - group[0].rect[0] > (right - left) * 0.3 &&
    Math.abs((group[0].rect[0] + group[0].rect[2]) / 2 - (left + right) / 2) <
      (right - left) * 0.08 &&
    headers.some((header) => intersection(header.rect, group[0].rect) / area(group[0].rect) > 0.8)
  for (let n = 1; n < groups.length - 1; n++) {
    const group = groups[n],
      label = group[0]
    if (!centeredSection(group) || rows.some((row) => inside(row.rect, label))) continue
    const peers = groups.filter(
      (g) =>
        g !== group &&
        centeredSection(g) &&
        sectionKey(g[0].text) === sectionKey(label.text) &&
        rows.some((row) => inside(row.rect, g[0]))
    )
    if (peers.length < 2) continue
    const neighbors = [groups[n - 1], groups[n + 1]]
    const ids = neighbors.map((g) => g.filter((i) => columnOf(i) === 0))
    if (
      !neighbors.every((g) => new Set(g.map(columnOf)).size === columnRects.length) ||
      !ids.every((stub) => stub.length === 1 && /^[1-9]\d*$/.test(stub[0].text)) ||
      Number(ids[1][0].text) !== Number(ids[0][0].text) + 1 ||
      union(neighbors[0])[3] >= label.rect[1] ||
      label.rect[3] >= union(neighbors[1])[1] ||
      rows.some((row) => row.rect[1] < label.rect[3] && row.rect[3] > label.rect[1])
    )
      continue
    rows.push({
      rect: [left, label.rect[1], right, label.rect[3]],
      origin: 'source-text',
      section: true
    })
    rows.sort((a, b) => a.rect[1] - b.rect[1])
    repairs.push('repeated-centered-section-recovered')
  }
  // A shifted section band can contain both a short heading and the complete
  // first record. Repeated indented records and the projected-header evidence
  // distinguish this from a wrapped data label.
  for (let n = 0; n < groups.length - 2; n++) {
    const heading = groups[n],
      record = groups[n + 1],
      next = groups[n + 2]
    const label = heading[0]
    const stub = record.filter((item) => columnOf(item) === 0)
    const numeric = (group) =>
      columnRects.slice(1).every((_, c) =>
        /^[<>≤≥−+-]?\s*\d[\d\s.,()%±*–−+\-/]*$/.test(
          group
            .filter((item) => columnOf(item) === c + 1)
            .map((item) => item.text)
            .join(' ')
        )
      )
    if (
      heading.length !== 1 ||
      columnOf(label) !== 0 ||
      !/^\p{Lu}/u.test(label.text) ||
      stub.length !== 1 ||
      !/^\p{Lu}/u.test(stub[0].text) ||
      stub[0].rect[0] - label.rect[0] < label.height * 0.5 ||
      union(heading)[3] >= union(record)[1] ||
      union(record)[3] >= union(next)[1] ||
      record[0].baseline - label.baseline > label.height * 1.8 ||
      !numeric(record) ||
      !numeric(next) ||
      !next.some(
        (item) =>
          columnOf(item) === 0 && Math.abs(item.rect[0] - stub[0].rect[0]) < label.height * 0.1
      ) ||
      !headers.some((header) => intersection(header.rect, label.rect) / area(label.rect) > 0.4)
    )
      continue
    const split = splitOwnedSourceRow(rows, items, heading, record, [left, right])
    if (!split) continue
    split.rows[0].section = true
    split.rows[1].numericRecord = true
    rows.splice(split.index, 1, ...split.rows)
    repairs.push('projected-section-record-separated')
  }
  // A complete binary (+/-) record cannot wrap into an uppercase section
  // abbreviation on the next baseline. Require another binary count record
  // below it and unique model-row ownership before separating that heading.
  for (let n = 0; n < groups.length - 2; n++) {
    const record = groups[n],
      heading = groups[n + 1]
    let next = groups[n + 2]
    const following = groups[n + 3]
    if (
      following &&
      next.every((item) =>
        following.some(
          (anchor) => isAdjacentTableScript(item, anchor) && columnOf(item) === columnOf(anchor)
        )
      )
    )
      next = [...next, ...following]
    const label = heading[0]
    const binaryCounts = (group) => {
      const stub = group.filter((item) => columnOf(item) === 0)
      return (
        stub.length === 1 &&
        /^[+−-]$/.test(stub[0].text) &&
        [1, 2].every((c) => group.some((item) => columnOf(item) === c && /^\d+$/.test(item.text)))
      )
    }
    if (
      heading.length !== 1 ||
      columnOf(label) !== 0 ||
      !/^[A-Z][A-Z\d-]{1,12}$/.test(label.text) ||
      !binaryCounts(record) ||
      !binaryCounts(next) ||
      record.some((item) => columnOf(item) > 0 && !/^\d+$/.test(item.text)) ||
      union(record)[3] >= label.rect[1] ||
      label.rect[3] >= union(next)[1] ||
      label.baseline - record[0].baseline > label.height * 1.8 ||
      next[0].baseline - label.baseline > label.height * 1.8
    )
      continue
    const split = splitOwnedSourceRow(rows, items, record, heading, [left, right])
    if (!split) continue
    split.rows[1].section = true
    split.rows[0].numericRecord = true
    rows.splice(split.index, 1, ...split.rows)
    repairs.push('binary-record-section-separated')
  }
  // Short unit-bearing headings share the same section role when at least
  // three projected headings precede complete, equally indented summaries.
  // A standalone stub or a blank value row is insufficient on its own.
  const summaries = rows.flatMap((row, r) => {
    const owned = items.filter((i) => inside(row.rect, i))
    const label = owned[0]
    if (
      owned.length !== 1 ||
      !/^\p{Lu}[\p{L} -]+ \([a-z]{1,3}\)$/u.test(label.text) ||
      columnOf(label) !== 0 ||
      !rows[r + 1] ||
      !headers.some((h) => intersection(h.rect, label.rect) / area(label.rect) > 0.4)
    )
      return []
    const next = items.filter((i) => inside(rows[r + 1].rect, i))
    const stub = next.filter((i) => columnOf(i) === 0)
    if (
      stub.length !== 1 ||
      !/^(?:Median \(range\)|Mean \(SD\))$/.test(stub[0].text) ||
      stub[0].rect[0] - label.rect[0] < label.height * 0.5 ||
      stub[0].rect[0] - label.rect[0] > label.height * 1.5 ||
      label.rect[3] >= union(next)[1] ||
      columnRects.slice(1).some(
        (_, c) =>
          !/^[−-]?\d[\d\s.,()–−-]*$/.test(
            next
              .filter((i) => columnOf(i) === c + 1)
              .map((i) => i.text)
              .join(' ')
          )
      )
    )
      return []
    return [{ row, label, summary: stub[0].text }]
  })
  for (const candidate of summaries) {
    const peers = summaries.filter(
      (s) =>
        s.summary === candidate.summary &&
        Math.abs(s.label.rect[0] - candidate.label.rect[0]) < candidate.label.height * 0.2
    )
    if (new Set(peers.map((s) => s.label.text)).size < 3 || candidate.row.section) continue
    candidate.row.section = true
    repairs.push('repeated-summary-section-recovered')
  }
  for (let r = 1; r < rows.length - 1; r++) {
    if (rows[r].section) continue
    const owned = items
      .filter((i) => i.horizontal && inside([left, rows[r].rect[1], right, rows[r].rect[3]], i))
      .sort((a, b) => a.rect[0] - b.rect[0])
    const label = owned[0]
    // A complete treatment/section name ending in a sample size may be short
    // enough to cross only the first data column. It still spans the section
    // when the projected header and contiguous source fragments agree.
    const text = owned.map((item) => item.text).join(' ')
    const ink = owned.length ? union(owned) : undefined
    const centeredSampleSection =
      owned.length >= 2 &&
      /^(?:\p{L}|[↑↓])[\p{L}\d\s.,()%<>=≤≥+/-]+\(\s*n\s*=\s*[1-9]\d*\s*\)$/u.test(text) &&
      Math.abs((ink[0] + ink[2] - left - right) / 2) < label.height * 0.5 &&
      headers.some((h) => intersection(h.rect, ink) / area(ink) > 0.8)
    const sampleSection =
      centeredSampleSection || /^[A-Z][\p{L}\s+/-]{5,}\(\s*n\s*=\s*\d+\s*\)$/u.test(text)
    if (
      !label ||
      (!centeredSampleSection && !/^\p{L}/u.test(label.text)) ||
      rows.filter((row) => inside([left, row.rect[1], right, row.rect[3]], label)).length !== 1 ||
      (!sampleSection &&
        intersection([left, rows[r].rect[1], right, rows[r].rect[3]], label.rect) /
          area(label.rect) >=
          0.8) ||
      (!centeredSampleSection && label.rect[0] - left > label.height * 1.5) ||
      (!sampleSection && label.rect[2] - label.rect[0] < (columnRects[0][2] - left) * 2) ||
      !headers.some((h) => intersection(h.rect, label.rect) / area(label.rect) > 0.4) ||
      !owned.every(
        (item, index) =>
          Math.abs(item.baseline - label.baseline) < label.height * 0.5 &&
          (!index || item.rect[0] - owned[index - 1].rect[2] < label.height * 0.5)
      )
    )
      continue
    const populated = columnRects
      .slice(1)
      .filter((c) =>
        items.some(
          (i) =>
            inside([c[0], rows[r + 1].rect[1], c[2], rows[r + 1].rect[3]], i) && /^\d/.test(i.text)
        )
      )
    if (
      populated.length < 3 ||
      (centeredSampleSection && populated.length !== columnRects.length - 1)
    )
      continue
    rows[r].section = true
    repairs.push('projected-section-row-recovered')
  }
}

// Repeated full-width centered labels between complete numeric records are
// section bands, even when a short label fits entirely inside a data column.
function recoverCenteredCountSections({ rows, groups, items, columnRects, repairs }) {
  if (columnRects.length < 3) return
  const cuts = [columnRects[0][0], ...columnRects.map((column) => column[2])]
  const center = (cuts[0] + cuts.at(-1)) / 2
  const complete = (group) => {
    const values = readSourceRow(group, cuts)
    return values?.[0] && values.slice(1).every((v) => /^[<>≤≥−+-]?\d[\d.,()%±–−+\-/]*$/.test(v))
  }
  const candidates = groups.flatMap((group, n) => {
    const label = group[0],
      next = groups[n + 1],
      previous = groups[n - 1]
    if (
      group.length !== 1 ||
      !/^\p{Lu}/u.test(label.text) ||
      !previous ||
      !next ||
      !complete(previous) ||
      !complete(next) ||
      Math.abs((label.rect[0] + label.rect[2]) / 2 - center) > label.height * 0.25 ||
      union(previous)[3] >= label.rect[1] ||
      label.rect[3] >= union(next)[1] ||
      label.baseline - previous[0].baseline > label.height * 1.8 ||
      next[0].baseline - label.baseline > label.height * 1.8
    )
      return []
    const owners = rows.filter((row) => inside(row.rect, label))
    if (owners.length !== 1 || items.some((i) => i !== label && inside(owners[0].rect, i)))
      return []
    return [{ row: owners[0], label }]
  })
  if (new Set(candidates.map(({ label }) => label.text)).size < 3) return
  for (const { row } of candidates) {
    row.section = true
    row.centeredSection = true
  }
  repairs.push('centered-count-sections-recovered')
}

// Repeated measurement blocks establish a section boundary even when the
// detector combines the section name with its first measurement. Require a
// matching earlier section and three repetitions of the measured quantity.
export function recoverRepeatedMeasurementSections({ rows, groups, items, columnRects, repairs }) {
  recoverCenteredCountSections({ rows, groups, items, columnRects, repairs })
  recoverIndentedSummarySections({ rows, groups, items, columnRects, repairs })
  recoverRepeatedUnitSections({ rows, groups, items, columnRects, repairs })
  recoverRepeatedStatisticRows({ rows, groups, items, columnRects, repairs })
  recoverSectionedMeanCycles({ rows, groups, items, columnRects, repairs })
  recoverRepeatedRecordCycles({ rows, items, columnRects, repairs })
  if (columnRects.length < 4) return
  const left = columnRects[0][0],
    right = columnRects.at(-1)[2]
  const columnOf = (item) => columnRects.findIndex((column) => inside(column, item))
  const stub = (group) =>
    group
      .filter((item) => columnOf(item) === 0)
      .map((item) => item.text)
      .join('')
      .replace(/\s/g, '')
  const measured = (group) => {
    const values = group
      .filter((item) => columnOf(item) !== 0)
      .sort((a, b) => a.rect[0] - b.rect[0])
    return (
      values.length >= 3 &&
      values.every((item, index) => columnOf(item) === index + 1 && /^\d[\d .]*$/.test(item.text))
    )
  }
  for (let n = 1; n < groups.length - 1; n++) {
    const heading = groups[n],
      record = groups[n + 1],
      label = heading[0]
    if (
      heading.length !== 1 ||
      columnOf(label) !== 0 ||
      !/^[A-Z][a-z]+$/.test(label.text) ||
      !measured(record) ||
      !stub(record).startsWith(label.text)
    )
      continue
    const suffix = stub(record).slice(label.text.length)
    if (
      !/^[a-z]+\([^()]+\)$/.test(suffix) ||
      groups.filter((group) => stub(group) === stub(record) && measured(group)).length < 3 ||
      !groups
        .slice(0, n - 1)
        .some(
          (group, index) =>
            group.length === 1 &&
            columnOf(group[0]) === 0 &&
            /^[A-Z][a-z]+$/.test(group[0].text) &&
            group[0].text !== label.text &&
            stub(groups[index + 1]) === group[0].text + suffix &&
            measured(groups[index + 1]) &&
            rows.some(
              (row) =>
                items.filter((item) => inside([left, row.rect[1], right, row.rect[3]], item))
                  .length === 1 && inside(row.rect, group[0])
            )
        ) ||
      label.rect[3] >= union(record)[1] ||
      record[0].baseline - label.baseline > label.height * 1.8
    )
      continue
    const split = splitOwnedSourceRow(rows, items, heading, record, [left, right])
    if (!split) continue
    split.rows[0].section = true
    split.rows[1].numericRecord = true
    rows.splice(split.index, 1, ...split.rows)
    repairs.push('repeated-measurement-section-separated')
  }
  // A complete percentage record followed by a standalone title and three
  // measurements with the same explicit unit establishes a new section.
  for (let n = 1; n < groups.length - 3; n++) {
    const record = groups[n - 1],
      heading = groups[n],
      label = heading[0]
    const previousStub = record.filter((item) => columnOf(item) === 0)
    const values = (group, c) =>
      group
        .filter((i) => columnOf(i) === c)
        .map((i) => i.text)
        .join(' ')
    const filled = (group) =>
      columnRects
        .slice(1)
        .every((_, c) => /^[<>≤≥]?\s*\d[\d\s.,()%–−+-]*$/.test(values(group, c + 1)))
    if (
      heading.length !== 1 ||
      columnOf(label) !== 0 ||
      !/^(?:\p{Lu}\p{L}+\s+){1,3}\p{Lu}\p{L}+$/u.test(label.text) ||
      previousStub.length !== 1 ||
      !/\(%\)$/.test(previousStub[0].text) ||
      !filled(record) ||
      columnRects.filter((_, c) => c > 0 && /^\d+(?:\.\d+)?%$/.test(values(record, c))).length <
        2 ||
      union(record)[3] >= label.rect[1] ||
      label.baseline - record[0].baseline > label.height * 1.8
    )
      continue
    const measurements = []
    for (const group of groups.slice(n + 1)) {
      const stubs = group.filter((i) => columnOf(i) === 0)
      if (!stubs.length) {
        if (!measurements.length || group.some((i) => !/^[\d\s.,()–−-]+$/.test(i.text))) break
        continue
      }
      if (stubs.length !== 1 || !filled(group)) break
      const unit = /\(([a-zA-Z]+\/[a-zA-Z]+)\)$/.exec(stubs[0].text)?.[1]
      if (!unit || Math.abs(stubs[0].rect[0] - label.rect[0]) > label.height * 0.1) break
      measurements.push({ unit, group })
      if (measurements.length === 3) break
    }
    if (
      measurements.length !== 3 ||
      new Set(measurements.map((m) => m.unit)).size !== 1 ||
      label.rect[3] >= union(measurements[0].group)[1] ||
      measurements[0].group[0].baseline - label.baseline > label.height * 1.8
    )
      continue
    const split = splitOwnedSourceRow(rows, items, record, heading, [left, right])
    if (!split) continue
    split.rows[1].section = true
    split.rows[0].numericRecord = true
    rows.splice(split.index, 1, ...split.rows)
    repairs.push('unit-measurement-section-separated')
  }
}

// Two overlapping model bands can claim exactly the same source record. Merge
// only identical token ownership across a labelled, multi-value native baseline.
export function mergeDuplicateSourceRows({ rows, groups, items, columnRects, repairs }) {
  if (columnRects.length < 3) return
  const left = columnRects[0][0],
    right = columnRects.at(-1)[2]
  for (let n = 1; n < rows.length; n++) {
    const previous = rows[n - 1],
      current = rows[n]
    if (previous.rect[3] <= current.rect[1]) continue
    const before = items.filter((i) => inside([left, previous.rect[1], right, previous.rect[3]], i))
    const after = items.filter((i) => inside([left, current.rect[1], right, current.rect[3]], i))
    let shared = before.filter((i) => after.includes(i))
    if (shared.length < 3) continue
    if (
      !shared.some((item) => {
        const a =
          intersection([left, previous.rect[1], right, previous.rect[3]], item.rect) /
          area(item.rect)
        const b =
          intersection([left, current.rect[1], right, current.rect[3]], item.rect) / area(item.rect)
        return a > 0.5 && b > 0.5 && Math.abs(a - b) < 0.1
      })
    )
      continue
    const attachedScript = (item) =>
      shared.filter(
        (anchor) =>
          isAdjacentTableScript(item, anchor) &&
          columnRects.some((column) => inside(column, item) && inside(column, anchor))
      ).length === 1
    if (
      !groups.some(
        (g) =>
          shared.every((i) => g.includes(i) || attachedScript(i)) &&
          g.every((i) => shared.includes(i) || attachedScript(i))
      )
    )
      continue
    shared = [
      ...new Set([...shared, ...before.filter(attachedScript), ...after.filter(attachedScript)])
    ]
    const rect = union(shared)
    const extras = [...new Set([...before, ...after])].filter((i) => !shared.includes(i))
    const hasExternalOwner = (item) => {
      if (rows.some((r) => r !== previous && r !== current && inside(r.rect, item))) return true
      const anchors = items.filter(
        (anchor) =>
          isAdjacentTableScript(item, anchor) &&
          columnRects.some((c) => inside(c, item) && inside(c, anchor))
      )
      if (anchors.length !== 1) return false
      const owners = rows.filter((r) => inside(r.rect, anchors[0]))
      return owners.length === 1 && owners[0] !== previous && owners[0] !== current
    }
    const values = columnRects.map((c) =>
      shared
        .filter((i) => inside([c[0], -Infinity, c[2], Infinity], i) && !attachedScript(i))
        .map((i) => i.text)
        .join('')
        .replace(/\s/g, '')
    )
    const populated = values.filter(Boolean)
    const numeric = (value) => /^(?:[−+-]?(?:\d|\.\d)[\d.,·⋅()%±–−+*/-]*|[–—−-])$/.test(value)
    const labelledValues =
      /\p{L}/u.test(populated[0] ?? '') && populated.slice(1).filter(numeric).length >= 2
    if (!labelledValues) continue
    if (extras.some((i) => inside(rect, i))) continue
    const unowned = extras.filter((i) => !hasExternalOwner(i))
    if (unowned.length) {
      // A broad band may own two consecutive records while the next band owns
      // only the latter. Split at their proven native baselines, preserving the
      // earlier record rather than merging away its values.
      const preceding = groups.find(
        (g) => unowned.every((i) => g.includes(i)) && g.every((i) => unowned.includes(i))
      )
      const precedingValues =
        preceding &&
        columnRects.map((column) =>
          preceding
            .filter((item) => inside(column, item))
            .map((item) => item.text)
            .join('')
            .replace(/\s/g, '')
        )
      if (
        preceding &&
        union(preceding)[3] < rect[1] &&
        /\p{L}/u.test(precedingValues[0]) &&
        precedingValues.slice(1).filter(numeric).length >= 2 &&
        unowned.every((item) => before.includes(item) && !after.includes(item))
      ) {
        previous.rect = [left, union(preceding)[1], right, union(preceding)[3]]
        current.rect = [left, rect[1], right, rect[3]]
        repairs.push('overlapping-source-records-separated')
        continue
      }
      // Preserve a following count-section heading swallowed by the duplicate
      // band. Its n (%) label and the complete record below establish a split;
      // arbitrary extra prose or another numeric fragment cannot do so.
      const section = groups.find(
        (g) => unowned.every((i) => g.includes(i)) && g.every((i) => unowned.includes(i))
      )
      const next = section && groups[groups.indexOf(section) + 1]
      const nextValues =
        next &&
        columnRects.slice(1).map((column) =>
          next
            .filter((item) => inside(column, item))
            .map((item) => item.text)
            .join('')
            .replace(/\s/g, '')
        )
      if (
        !section ||
        !next ||
        !section.every((i) => inside(columnRects[0], i)) ||
        !/\bn\s*\(%\)$/.test(section.map((i) => i.text).join(' ')) ||
        union(section)[1] <= rect[3] ||
        union(section)[3] >= union(next)[1] ||
        nextValues.filter(numeric).length < 2 ||
        before.some((i) => unowned.includes(i)) ||
        !unowned.every((i) => after.includes(i))
      )
        continue
      previous.rect = [left, rect[1], right, rect[3]]
      current.rect = [left, union(section)[1], right, union(section)[3]]
      current.section = true
      repairs.push('duplicate-source-row-section-separated')
      continue
    }
    previous.rect = [left, rect[1], right, rect[3]]
    rows.splice(n--, 1)
    repairs.push('duplicate-source-row-merged')
  }
}

// Adjacent native enclosures prove that a crossed rule separates two populated
// records. A third boundary or unowned glyph may define a real blank row.
function shareRuledRecordBorder(records, empty, band, items, rules) {
  const sources = records.map((record) => record.flatMap((cell) => cell.sourceRects))
  if (sources.some((source) => !source.length)) return false
  const height = Math.min(...sources.flat().map((r) => r[3] - r[1]))
  if (height <= 0) return false
  const left = Math.min(...empty.map((c) => c.rect[0]))
  const right = Math.max(...empty.map((c) => c.rect[2]))
  const borders = joinHorizontalTableRules(rules).filter(
    (r) => Math.abs(r[0] - left) < height && Math.abs(r[2] - right) < height
  )
  const enclosures = sources.map((source) => {
    const top = Math.min(...source.map((r) => r[1]))
    const bottom = Math.max(...source.map((r) => r[3]))
    return [borders.findLast((r) => r[1] <= top)?.[1], borders.find((r) => r[1] >= bottom)?.[1]]
  })
  if (
    enclosures.some(
      ([top, bottom]) =>
        !Number.isFinite(top) || !Number.isFinite(bottom) || bottom - top > height * 3
    ) ||
    enclosures[0][1] !== enclosures[1][0]
  )
    return false
  const shared = enclosures[0][1]
  return (
    shared > band.rect[1] &&
    shared < band.rect[3] &&
    enclosures.every(
      ([top, bottom], n) =>
        !rules.some(
          (r) =>
            r[1] === r[3] &&
            r[1] > top + 0.01 &&
            r[1] < bottom - 0.01 &&
            r[0] < right &&
            r[2] > left
        ) &&
        !items.some(
          (i) =>
            i.rect[0] < right &&
            i.rect[2] > left &&
            i.rect[1] < bottom &&
            i.rect[3] > top &&
            !sources[n].some((r) => r.every((v, k) => v === i.rect[k]))
        )
    ) &&
    !rules.some(
      (r) =>
        r[1] === r[3] &&
        r[1] >= band.rect[1] &&
        r[1] <= band.rect[3] &&
        r[0] < right &&
        r[2] > left &&
        Math.abs(r[1] - shared) > 0.01
    )
  )
}

// An extra model band can straddle two complete source records without owning
// any text. Remove only that overlap, after assignment has proved ownership.
// Blank ruled rows and rows covered by vertical spans must remain intact.
export function removeEmptyOverlappingRows({ rows, cells, items, rules, repairs }) {
  const unitMetricTable =
    cells.some((c) => c.column === 1 && c.text === 'Dose parameters' && c.sourceRects.length) &&
    cells.filter(
      (c) => c.column === 1 && /^(?:D(?:mean|max)|V\d+)$/.test(c.text) && c.sourceRects.length
    ).length >= 3
  for (let row = rows.length - 2; row > 0; row--) {
    const band = rows[row]
    const empty = cells.filter((cell) => cell.row === row)
    const neighbors = [row - 1, row + 1].map((r) =>
      cells.filter((cell) => cell.row === r).sort((a, b) => a.column - b.column)
    )
    const spanningEmpty =
      empty.length === 1 &&
      empty[0].column === 0 &&
      empty[0].colSpan >= 3 &&
      empty[0].origin === 'model-span'
    const columnCount = spanningEmpty ? empty[0].colSpan : empty.length
    if (
      band.origin !== 'model' ||
      columnCount < 3 ||
      empty.some(
        (cell) =>
          cell.text ||
          cell.sourceRects.length ||
          cell.rowSpan !== 1 ||
          (!spanningEmpty && cell.colSpan !== 1)
      ) ||
      cells.some((cell) => cell.row < row && cell.row + cell.rowSpan > row)
    )
      continue
    const crossedRule = rules.some(
      (rule) =>
        rule[1] === rule[3] &&
        rule[1] >= band.rect[1] &&
        rule[1] <= band.rect[3] &&
        rule[2] > band.rect[0] &&
        rule[0] < band.rect[2]
    )
    const overlap = [rows[row - 1].rect[3] > band.rect[1], band.rect[3] > rows[row + 1].rect[1]]
    if (spanningEmpty && (crossedRule || !overlap.every(Boolean))) continue
    const ruledNeighbors =
      crossedRule &&
      overlap.every(Boolean) &&
      shareRuledRecordBorder(neighbors, empty, band, items, rules)
    if (crossedRule && !ruledNeighbors) continue
    const section = (record) =>
      (record.length === 1 ||
        (ruledNeighbors &&
          record.length === 2 &&
          record[1].column === columnCount - 1 &&
          record[1].colSpan === 1 &&
          record[1].rowSpan === 1 &&
          (record[1].text
            ? /^[.\d]+$/.test(record[1].text) && record[1].sourceRects.length === 1
            : !record[1].sourceRects.length))) &&
      record[0].column === 0 &&
      record[0].colSpan === columnCount - (record.length - 1) &&
      record[0].rowSpan === 1 &&
      record[0].sourceRects.length === 1 &&
      /^\p{L}/u.test(record[0].text)
    const complete = (record) =>
      record.length === columnCount &&
      record.every(
        (cell, c) =>
          cell.column === c &&
          cell.rowSpan === 1 &&
          cell.colSpan === 1 &&
          (unitMetricTable && c === 0 && !cell.text && !cell.sourceRects.length
            ? true
            : cell.text && cell.sourceRects.length
              ? c
                ? unitMetricTable
                  ? c === 1
                    ? /^(?:D(?:mean|max)|V\d+)$/.test(cell.text)
                    : /^[<>≤≥]?[−+-]?\d[\d\s.,()%±–−+*/<>≤≥-]*(?:\s*(?:Gy|cc))?$/.test(cell.text)
                  : /^[<>≤≥]?[−+-]?\d[\d\s.,()%±–−+*/<>≤≥-]*$/.test(cell.text)
                : /^(?:\p{L}|[<>≤≥]?\d)/u.test(cell.text)
              : c === record.length - 1 && !cell.text && !cell.sourceRects.length)
      ) &&
      record.filter((cell) => cell.sourceRects.length).length >= 3
    // A wholly empty model span can be displaced below a real section title.
    // Require two independently merged headings with the same two complete
    // child records; overlap and native source coverage are proved below.
    const displacedSection =
      spanningEmpty &&
      neighbors[0].length === columnCount &&
      neighbors[0].every(
        (cell, c) =>
          cell.column === c &&
          cell.colSpan === 1 &&
          cell.rowSpan === 1 &&
          (c === 0
            ? /^\p{L}/u.test(cell.text) && cell.sourceRects.length
            : !cell.text && !cell.sourceRects.length)
      ) &&
      [row + 1, row + 2].every((r) =>
        complete(cells.filter((cell) => cell.row === r).sort((a, b) => a.column - b.column))
      ) &&
      cells.filter(
        (cell) =>
          cell.column === 0 &&
          cell.colSpan === columnCount &&
          cell.rowSpan === 1 &&
          cell.text &&
          cell.sourceRects.length &&
          cell.row !== row &&
          cells.filter((other) => other.row === cell.row).length === 1 &&
          [1, 2].every((offset) => {
            const record = cells
              .filter((other) => other.row === cell.row + offset)
              .sort((a, b) => a.column - b.column)
            const target = cells.find((other) => other.row === row + offset && other.column === 0)
            return complete(record) && record[0].text === target?.text
          })
      ).length >= 2
    if (spanningEmpty && !displacedSection) continue
    let sources
    if (overlap.every(Boolean)) {
      if (
        !neighbors.every(
          (record, n) => complete(record) || section(record) || (!n && displacedSection)
        ) ||
        !neighbors.some(complete)
      )
        continue
      sources = neighbors.map((record) => record.flatMap((cell) => cell.sourceRects))
    } else {
      // A short duplicate band may lie wholly on one source baseline. It must
      // contain only glyphs already owned by that populated neighboring row.
      const neighbor = overlap[0] ? neighbors[0] : overlap[1] ? neighbors[1] : undefined
      if (
        !neighbor ||
        !complete(neighbor) ||
        (!unitMetricTable && !/\p{L}/u.test(neighbor[0].text))
      )
        continue
      sources = [neighbor.flatMap((cell) => cell.sourceRects)]
    }
    // A raised unit exponent belongs to its adjacent anchor's baseline. Keep
    // its rectangle in the ownership proof, but not in baseline alignment.
    const baselines = sources.map((record) => {
      const tokens = items.filter((i) => record.some((r) => r.every((v, n) => v === i.rect[n])))
      return record.filter(
        (rect) =>
          !tokens.some(
            (i) =>
              rect.every((v, n) => v === i.rect[n]) &&
              tokens.filter((anchor) => isAdjacentTableScript(i, anchor)).length === 1
          )
      )
    })
    const height = Math.min(...baselines.flat().map((rect) => rect[3] - rect[1]))
    if (
      height <= 0 ||
      baselines.some((record) =>
        record.some((rect) => Math.abs(rect[3] - record[0][3]) > height * 0.1)
      )
    )
      continue
    if (sources.length === 2) {
      if (
        baselines[1][0][1] <= baselines[0][0][3] ||
        (!ruledNeighbors && baselines[1][0][3] - baselines[0][0][3] > height * 1.8)
      )
        continue
    } else {
      const center = (band.rect[1] + band.rect[3]) / 2
      if (
        band.rect[3] - band.rect[1] > height * 1.3 ||
        center <= baselines[0][0][1] ||
        center >= baselines[0][0][3]
      )
        continue
    }
    if (
      items.some(
        (item) =>
          intersection(band.rect, item.rect) > 0 &&
          !sources.flat().some((rect) => rect.every((value, i) => value === item.rect[i]))
      )
    )
      continue
    if (displacedSection) {
      const heading = neighbors[0][0]
      heading.colSpan = columnCount
      heading.rect = union(neighbors[0])
      for (const sibling of neighbors[0].slice(1)) cells.splice(cells.indexOf(sibling), 1)
      repairs.push('section-heading-span-reconciled')
    }
    rows.splice(row, 1)
    for (let i = cells.length - 1; i >= 0; i--) {
      if (cells[i].row === row) cells.splice(i, 1)
      else if (cells[i].row > row) cells[i].row--
    }
    repairs.push('empty-overlapping-row-removed')
  }
}

// Separate parent/child text packed into one predicted header row. Native
// underlines must partition every value column, with repeated child labels.
export function splitRuledParentRow({ rows, items, columnRects, rules, repairs }) {
  if (rows.length < 2 || columnRects.length < 5) return
  // A comparison p-value sits outside two repeated four-column arms.
  // The arm underlines may cover only the centered title, while all eight
  // child labels and the separate between-groups label establish the spans.
  if (columnRects.length === 10 && rows.length >= 4) {
    const at = (r, c) => items.filter((i) => inside(rows[r].rect, i) && inside(columnRects[c], i))
    const text = (r, c) =>
      at(r, c)
        .map((i) => i.text)
        .join('')
        .replace(/\s/g, '')
    const labels = columnRects.slice(1).map((_, c) => text(1, c + 1))
    const parentTokens = items
      .filter((i) => inside(rows[0].rect, i))
      .sort((a, b) => a.rect[0] - b.rect[0])
    if (
      parentTokens.length === 2 &&
      parentTokens[0].text === 'Intervention' &&
      parentTokens[1].text === 'Control' &&
      labels.join('|').replace(/p-Value[a-z]/g, 'p-Value') ===
        'Baseline|Follow-up|Change|p-Value|Baseline|Follow-up|Change|p-Value|p-Value' &&
      text(2, 9) === 'Betweengroups' &&
      [4, 8].every((c) => text(2, c) === 'Withingroup') &&
      [1, 2, 3, 5, 6, 7].every((c) => text(2, c) === 'Mean(SD)') &&
      parentTokens.every((i) =>
        rules.some(
          (r) =>
            r[1] === r[3] &&
            r[1] >= i.rect[3] &&
            r[1] - i.rect[3] < i.height &&
            r[0] <= i.rect[0] + 1 &&
            r[2] >= i.rect[2] - 1
        )
      )
    )
      return [
        { row: 0, column: 1, rowSpan: 1, colSpan: 4 },
        { row: 0, column: 5, rowSpan: 1, colSpan: 4 }
      ]
  }
  if (columnRects.length === 5 && rows.length >= 5) {
    const text = (r, c) =>
      items
        .filter((i) => inside(rows[r].rect, i) && inside(columnRects[c], i))
        .map((i) => i.text)
        .join('')
        .replace(/\s/g, '')
    if (
      text(0, 1) === 'No.(%)' &&
      text(0, 2) === '' &&
      text(0, 3) === '' &&
      /^p-value$/i.test(text(0, 4)) &&
      [1, 2, 3].every((c) => /\(n=\d+\)$/.test(text(1, c))) &&
      rows
        .slice(2)
        .filter((_, n) => [1, 2, 3].every((c) => /^\d+\(\d+(?:\.\d+)?\)$/.test(text(n + 2, c))))
        .length >= 6
    )
      return [{ row: 0, column: 1, rowSpan: 1, colSpan: 3 }]
  }
  const first = [...rows[0].rect]
  // A missing child-header band can lie in the gap before the first data row.
  // The repeated labels and separate parent rules below must establish it.
  if (rows[1].rect[1] - first[3] <= (first[3] - first[1]) * 3)
    first[3] = Math.max(first[3], rows[1].rect[1])
  const existingChildren =
    columnRects.length === 5 &&
    [1, 2, 3, 4].every((c) => {
      const cell = items.filter((i) => inside(rows[1].rect, i) && inside(columnRects[c], i))
      return /^(?:Intervention|Control)\(n=\d+\)$/.test(
        cell
          .map((i) => i.text)
          .join('')
          .replace(/\s/g, '')
      )
    })
  if (existingChildren) first[3] = rows[1].rect[3]
  // Some ruled tables omit the parent underlines. Two repeated statistic/arm
  // pairs, with parents aligned at each pair's left edge, establish the tiers.
  if ([5, 7, 9].includes(columnRects.length)) {
    const source = items
      .filter((i) => i.horizontal && inside(first, i))
      .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
    const height = Math.max(...source.map((i) => i.height))
    const groups = groupSourceRowsWithScripts(source, height, 0.4)
    if (groups?.length >= 2 && groups.length <= 3) {
      const upper = groups[0],
        lower = groups.slice(1).flat()
      const children = columnRects.slice(1).map((c) => lower.filter((i) => inside(c, i)))
      const labels = children.map((g) =>
        g
          .map((i) => i.text)
          .join('')
          .replace(/\s/g, '')
      )
      const pair =
        labels.every(
          (v, n) =>
            /^(?:Intervention|Control)(?:\(n=\d+\))?$/.test(v) &&
            v.replace(/\d+/g, '') === labels[n % 2].replace(/\d+/g, '')
        ) || labels.join('|') === 'B(SE)|Pvalue|B(SE)|Pvalue'
      const quartet =
        labels.join('|') ===
        'Intervention,mean(SD)|Control,mean(SD)|Difference(SE)|Pvalue|Intervention,mean(SD)|Control,mean(SD)|Difference(SE)|Pvalue'
      const size = quartet ? 4 : 2,
        count = (columnRects.length - 1) / size
      if ((pair || quartet) && Number.isInteger(count) && count >= 2 && count <= 3) {
        const parents = Array.from({ length: count }, (_, n) =>
          upper.filter(
            (i) =>
              i.rect[0] >= columnRects[1 + n * size][0] &&
              i.rect[2] <= columnRects[(n + 1) * size][2]
          )
        )
        const fullRule = (a, b) =>
          rules.some(
            (r) =>
              r[1] === r[3] &&
              r[1] >= a &&
              r[1] <= b &&
              r[0] <= first[0] + height &&
              r[2] >= first[2] - height
          )
        if (
          union(upper)[3] < union(lower)[1] &&
          parents.every((g, n) => {
            const titles = g.filter((i) => i.height >= height * 0.9)
            return (
              titles.length === 1 &&
              /^\p{L}/u.test(titles[0].text) &&
              children[n * size].length &&
              Math.abs(titles[0].rect[0] - children[n * size][0].rect[0]) < height * 0.3 &&
              g.every((i) => i === titles[0] || isAdjacentTableScript(i, titles[0]))
            )
          }) &&
          upper.every((i) => parents.flat().includes(i) || inside(columnRects[0], i)) &&
          lower.every((i) => children.flat().includes(i) || inside(columnRects[0], i)) &&
          fullRule(first[1] - height, union(upper)[1]) &&
          fullRule(union(lower)[3], first[3] + height)
        ) {
          const y = (union(upper)[3] + union(lower)[1]) / 2
          rows.splice(
            0,
            existingChildren ? 2 : 1,
            { rect: [first[0], first[1], first[2], y], origin: 'source-header' },
            { rect: [first[0], y, first[2], first[3]], origin: 'source-header' }
          )
          repairs.push('ruled-parent-row-split')
          return [
            { row: 0, column: 0, rowSpan: 2, colSpan: 1 },
            ...parents.map((_, n) => ({ row: 0, column: 1 + n * size, rowSpan: 1, colSpan: size }))
          ]
        }
      }
    }
  }
  const levels = Map.groupBy(
    rules.filter((r) => r[1] === r[3] && r[1] > first[1] && r[1] < first[3]),
    (r) => Math.round(r[1])
  )
  for (const level of levels.values()) {
    const parents = level
      .map((rule) => ({
        rule,
        columns: columnRects.flatMap((c, n) => {
          const center = (c[0] + c[2]) / 2
          return n && center >= rule[0] && center <= rule[2] ? [n] : []
        })
      }))
      .filter((p) => p.columns.length >= 2)
      .sort((a, b) => a.rule[0] - b.rule[0])
    // A schedule can have one two-visit baseline parent beside independent
    // duration columns. Its underline and repeated duration labels establish
    // the exceptional header shape without interpreting the body markers.
    if (parents.length === 1 && parents[0].columns.length === 2) {
      const { rule, columns } = parents[0],
        y = rule[1]
      const head = items.filter(
        (i) =>
          i.horizontal &&
          i.rect[1] >= first[1] &&
          i.rect[3] <= y &&
          i.rect[0] >= rule[0] - 1 &&
          i.rect[2] <= rule[2] + 1
      )
      const times = items.filter(
        (i) =>
          i.horizontal &&
          /^\d+[MDWY]$/.test(i.text) &&
          i.rect[1] >= first[1] &&
          i.rect[3] <= first[3] &&
          i.rect[0] > rule[2]
      )
      const children = columns.map((c) =>
        items.filter(
          (i) =>
            i.horizontal && i.rect[1] >= y && i.rect[3] <= first[3] && inside(columnRects[c], i)
        )
      )
      if (
        head.length === 1 &&
        /\p{L}/u.test(head[0].text) &&
        times.length >= 2 &&
        Math.abs((head[0].rect[0] + head[0].rect[2] - rule[0] - rule[2]) / 2) < head[0].height &&
        children.every((g) => g.length && g.every((i) => /^[\p{L} ]+$/u.test(i.text))) &&
        times.every((i) => Math.abs(i.baseline - times[0].baseline) < i.height * 0.3)
      ) {
        rows.splice(
          0,
          1,
          { rect: [first[0], first[1], first[2], y], origin: 'source-header' },
          { rect: [first[0], y, first[2], first[3]], origin: 'source-header' }
        )
        repairs.push('ruled-schedule-parent-split')
        return [
          { row: 0, column: columns[0], rowSpan: 1, colSpan: 2 },
          ...columnRects.flatMap((_, c) =>
            columns.includes(c) ? [] : [{ row: 0, column: c, rowSpan: 2, colSpan: 1 }]
          )
        ]
      }
    }
    if (parents.length < 2 || parents.some((p) => p.columns.length !== parents[0].columns.length))
      continue
    const occupied = parents.flatMap((p) => p.columns)
    if (occupied.length !== columnRects.length - 1 || occupied.some((c, n) => c !== n + 1)) continue
    const y = level[0][1]
    const head = items.filter(
      (i) =>
        i.horizontal && i.rect[1] >= first[1] && i.rect[3] <= y && i.rect[0] >= columnRects[1][0]
    )
    if (
      !head.length ||
      head.some((i) => !/\p{L}/u.test(i.text) && !/^\([%\p{L} /]+\)$/u.test(i.text))
    )
      continue
    if (
      parents.some(
        (p) => !head.some((i) => i.rect[0] >= p.rule[0] - 1 && i.rect[2] <= p.rule[2] + 1)
      )
    )
      continue
    if (
      head.some(
        (i) => !parents.some((p) => i.rect[0] >= p.rule[0] - 1 && i.rect[2] <= p.rule[2] + 1)
      )
    )
      continue
    const child = columnRects.slice(1).map((c) =>
      items
        .filter(
          (i) => i.horizontal && i.rect[3] <= first[3] && inside([c[0], y, c[2], first[3]], i)
        )
        .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
        .map((i) => i.text)
        .join('')
        .replace(/\s/g, '')
    )
    const width = parents[0].columns.length
    if (child.some((s, n) => !/\p{L}/u.test(s) || s !== child[n % width])) continue
    rows.splice(
      0,
      1,
      { rect: [first[0], first[1], first[2], y], origin: 'source-header' },
      { rect: [first[0], y, first[2], first[3]], origin: 'source-header' }
    )
    repairs.push('ruled-parent-row-split')
    return [
      ...parents.map((p) => ({
        row: 0,
        column: p.columns[0],
        rowSpan: 1,
        colSpan: p.columns.length
      })),
      { row: 0, column: 0, rowSpan: 2, colSpan: 1 }
    ]
  }
}

// A stub-only sample section can be folded into an otherwise empty header
// stub. Repeated later sample sections and identical complete first records
// distinguish this from a wrapped column heading or a sample-size header.
function recoverLeadingSampleSection({ rows, groups, items, columnRects, rules, repairs }) {
  if (rows.length < 4 || groups.length < 7 || columnRects.length < 3) return
  const columnOf = (item) => columnRects.findIndex((column) => inside(column, item))
  const stub = (group) =>
    group
      .filter((i) => columnOf(i) === 0)
      .map((i) => i.text)
      .join('')
      .replace(/\s/g, '')
  const complete = (group) =>
    columnRects.slice(1).every((_, c) =>
      /^[<>≤≥−+-]?\d[\d\s.,()%±*–−+\-/]*$/.test(
        group
          .filter((i) => columnOf(i) === c + 1)
          .map((i) => i.text)
          .join(' ')
      )
    )
  const [heading, title, sample, record] = groups
  if (
    heading.length !== columnRects.length - 1 ||
    !heading.every((i, c) => columnOf(i) === c + 1 && /^\p{L}[\p{L} -]*$/u.test(i.text)) ||
    title.length !== 1 ||
    columnOf(title[0]) !== 0 ||
    !/^\p{L}.+,$/u.test(title[0].text) ||
    !sample.every((i) => columnOf(i) === 0) ||
    !/^n=\d+$/i.test(stub(sample)) ||
    !complete(record) ||
    !/^\p{L}/u.test(stub(record)) ||
    groups.filter(
      (g, n) =>
        n > 3 &&
        g.every((i) => columnOf(i) === 0) &&
        /^\p{L}.+,n=\d+$/u.test(stub(g)) &&
        groups[n + 1] &&
        stub(groups[n + 1]) === stub(record) &&
        complete(groups[n + 1])
    ).length < 2
  )
    return
  const headBounds = union(heading),
    bodyBounds = union([...title, ...sample])
  if (
    headBounds[3] >= bodyBounds[1] ||
    union(title)[3] >= union(sample)[1] ||
    union(sample)[1] - union(title)[3] > title[0].height ||
    headBounds[3] + title[0].height * 2 < bodyBounds[1] ||
    Math.min(...sample.map((i) => i.rect[0])) < title[0].rect[0] ||
    Math.min(...sample.map((i) => i.rect[0])) - title[0].rect[0] > title[0].height * 1.5 ||
    hasHorizontalTableRuleBetween(rules, union(title)[3], union(sample)[1])
  )
    return
  const firstRows = rows.slice(0, 2),
    members = [...heading, ...title, ...sample]
  if (
    members.some((i) => firstRows.filter((r) => inside(r.rect, i)).length !== 1) ||
    items.some((i) => !members.includes(i) && firstRows.some((r) => inside(r.rect, i))) ||
    rows.slice(2).some((r) => members.some((i) => inside(r.rect, i)))
  )
    return
  const left = columnRects[0][0],
    right = columnRects.at(-1)[2]
  const boundary = (headBounds[3] + bodyBounds[1]) / 2
  rows.splice(
    0,
    2,
    { rect: [left, headBounds[1], right, boundary], origin: 'source-header' },
    { rect: [left, boundary, right, bodyBounds[3]], origin: 'source-section', section: true }
  )
  repairs.push('leading-sample-section-separated')
}

// In two-column summaries, an outdented unit/count title followed by at least
// two complete indented records establishes a section. Split only the source
// groups uniquely owned by its model band; leave other records untouched.
function recoverIndentedSummarySections({ rows, groups, items, columnRects, repairs }) {
  if (columnRects.length !== 2) return
  const left = columnRects[0][0],
    right = columnRects[1][2]
  const cuts = [left, columnRects[0][2], right]
  for (let n = 0; n < groups.length - 2; n++) {
    const heading = groups[n],
      label = readSourceRow(heading, cuts)
    if (!label || label[1] || !/^\p{Lu}.*\([a-zA-Z/]+\)$/u.test(label[0])) continue
    const anchor = heading[0],
      indent = groups[n + 1][0].rect[0] - anchor.rect[0]
    if (indent < anchor.height * 0.5 || indent > anchor.height * 2) continue
    const records = []
    for (const group of groups.slice(n + 1)) {
      const text = readSourceRow(group, cuts),
        previous = records.at(-1) ?? heading
      if (
        !text ||
        !/^\p{Lu}/u.test(text[0]) ||
        !/^[−+-]?\d+(?:\.\d+)?(?:[±–−-]\d+(?:\.\d+)?)?$/.test(text[1]) ||
        Math.abs(group[0].rect[0] - anchor.rect[0] - indent) > anchor.height * 0.1 ||
        group.some((i) => Math.abs(i.height - anchor.height) > anchor.height * 0.1) ||
        union(previous)[3] >= union(group)[1] ||
        group[0].baseline - previous[0].baseline > anchor.height * 1.8
      )
        break
      records.push(group)
    }
    if (records.length < 2) continue
    for (let count = records.length; count >= 1; count--) {
      const split = splitOwnedSourceRows(
        rows,
        items,
        [heading, ...records.slice(0, count)],
        [left, right]
      )
      if (!split) continue
      split.rows[0].section = true
      for (const row of split.rows.slice(1)) row.numericRecord = true
      rows.splice(split.index, 1, ...split.rows)
      repairs.push('indented-summary-section-separated')
      break
    }
  }
}

// Repeated arm pairs beneath unit-bearing headings establish a section role.
// A fragmented heading may be swallowed by the preceding complete record.
function recoverRepeatedUnitSections({ rows, groups, items, columnRects, repairs }) {
  if (columnRects.length < 4) return
  const cuts = [columnRects[0][0], ...columnRects.map((c) => c[2])]
  const blocks = groups.flatMap((heading, n) => {
    const label = readSourceRow(heading, cuts)
    const arms = groups.slice(n + 1, n + 3)
    const values = arms.map((g) => readSourceRow(g, cuts))
    if (
      !label ||
      !/^\p{Lu}[\p{L}\d]*\([a-zA-Z]+\/[a-zA-Z]+\)$/u.test(label[0]) ||
      label.slice(1).some(Boolean) ||
      arms.length !== 2 ||
      values.some((v) => !v || !/^\p{Lu}\p{Ll}+$/u.test(v[0])) ||
      values[0][0] === values[1][0] ||
      arms.some(
        (g) =>
          g[0].rect[0] - heading[0].rect[0] < heading[0].height * 0.5 ||
          g[0].rect[0] - heading[0].rect[0] > heading[0].height * 1.5
      ) ||
      values.some((v) =>
        v.slice(1, 4).some((s) => !/^\d+(?:\.\d+)?\(\d+(?:\.\d+)?[–−-]\d+(?:\.\d+)?\)$/.test(s))
      ) ||
      union(heading)[3] >= union(arms[0])[1] ||
      union(arms[0])[3] >= union(arms[1])[1] ||
      arms[1][0].baseline - heading[0].baseline > heading[0].height * 3
    )
      return []
    return [{ heading, n, label: label[0], arms: values.map((v) => v[0]) }]
  })
  for (const block of blocks) {
    const peers = blocks.filter(
      (b) =>
        b.arms.every((arm, n) => arm === block.arms[n]) &&
        Math.abs(b.heading[0].rect[0] - block.heading[0].rect[0]) < block.heading[0].height * 0.1
    )
    if (new Set(peers.map((b) => b.label)).size < 3 || !block.n) continue
    const previous = groups[block.n - 1]
    if (readSourceRow(previous, cuts)?.[0] !== block.arms[1]) continue
    const split = splitOwnedSourceRow(rows, items, previous, block.heading, [cuts[0], cuts.at(-1)])
    if (!split) continue
    split.rows[0].numericRecord = true
    split.rows[1].section = true
    rows.splice(split.index, 1, ...split.rows)
    repairs.push('repeated-unit-section-separated')
  }
}

// Repeated explicit P expressions are separate records below count/interval
// pairs. Attach only geometrically adjacent scripts and preserve their tokens.
function recoverRepeatedStatisticRows({ rows, groups, items, columnRects, repairs }) {
  if (columnRects.length < 3) return
  const cuts = [columnRects[0][0], ...columnRects.map((c) => c[2])]
  const candidates = groups.flatMap((group, n) => {
    const values = readSourceRow(group, cuts)
    if (!values || values[0]) return []
    const columns = values.flatMap((v, c) => (v ? [c] : []))
    if (!columns.length || columns.some((c) => !/^P[=<>≤≥](?:0?\.\d+|1(?:\.0+)?)$/.test(values[c])))
      return []
    const scripts = groups[n - 1] ?? []
    const attached =
      scripts.length &&
      scripts.every(
        (i) =>
          /^[a-z]$/.test(i.text) &&
          group.filter((a) => a.text === 'P' && isAdjacentTableScript(i, a)).length === 1
      )
    const record = groups[n - (attached ? 2 : 1)]
    const previous = groups[n - (attached ? 3 : 2)]
    const paired = (g) => {
      const v = g && readSourceRow(g, cuts)
      return (
        v?.[0] &&
        columns.every(
          (c) =>
            c >= 2 &&
            /^\d+\/\d+$/.test(v[c - 1]) &&
            /^\d+(?:\.\d+)?\(\d+(?:\.\d+)?,\d+(?:\.\d+)?\)$/.test(v[c])
        )
      )
    }
    const tail = attached ? [...scripts, ...group] : group
    if (
      !paired(record) ||
      !paired(previous) ||
      union(record)[3] >= union(tail)[1] ||
      group[0].baseline - record[0].baseline > group[0].height * 1.6 ||
      columns.some((c) => {
        const anchor = group.find((i) => i.text === 'P' && inside(columnRects[c], i))
        const value = record.find((i) => inside(columnRects[c], i))
        return !anchor || !value || Math.abs(anchor.rect[0] - value.rect[0]) > anchor.height * 0.1
      })
    )
      return []
    return [{ record, tail }]
  })
  if (candidates.length < 3) return
  for (const { record, tail } of candidates) {
    const split = splitOwnedSourceRow(rows, items, record, tail, [cuts[0], cuts.at(-1)])
    if (!split) continue
    for (const row of split.rows) row.numericRecord = true
    rows.splice(split.index, 1, ...split.rows)
    repairs.push('repeated-statistic-row-separated')
  }
}

// Repeated outcome sections with two measured arms and a separate test line.
// A matching P/F pair belongs to the section's final column, not another arm.
function recoverSectionedMeanCycles({ rows, groups, items, columnRects, repairs }) {
  if (columnRects.length < 5 || columnRects.length > 10) return
  const cuts = [columnRects[0][0], ...columnRects.map((c) => c[2])]
  const values = groups.map((g) => readSourceRow(g, cuts))
  const probability = (s) => /^[<>≤≥]?(?:0?\.\d+|1(?:\.0+)?)[*†‡]*$/.test(s)
  const section = (v) =>
    v &&
    /\p{L}/u.test(v[0]) &&
    v.slice(1, -1).every((s) => !s) &&
    /^P[=<>≤≥](?:0?\.\d+|1(?:\.0+)?)[*†‡]*$/.test(v.at(-1))
  const starts = values.flatMap((v, n) => (section(v) ? [n] : []))
  if (
    starts.length < 3 ||
    starts.some((n, k) => k && n !== starts[k - 1] + 4) ||
    starts.at(-1) + 4 !== groups.length
  )
    return
  const labels = []
  for (const n of starts) {
    const [first, second, test] = values.slice(n + 1, n + 4)
    if (
      ![first, second, test].every((v) => v && /\p{L}/u.test(v[0])) ||
      ![first, second].every((v) =>
        v.slice(1, -1).every((s) => /^[−-]?\d+(?:\.\d+)?±\d+(?:\.\d+)?$/.test(s))
      ) ||
      !/^F=\d+(?:\.\d+)?$/.test(first.at(-1)) ||
      second.at(-1) ||
      test.at(-1) ||
      !test.slice(1, -1).every(probability)
    )
      return
    labels.push([first[0], second[0], test[0]].join('|'))
  }
  if (new Set(labels).size !== 1) return
  const body = groups.slice(starts[0]),
    bounds = body.map(union)
  if (bounds.some((b, n) => n && b[1] <= bounds[n - 1][3])) return
  const first = bounds[0][1],
    last = bounds.at(-1)[3]
  if (
    items.some(
      (i) => inside([cuts[0], first, cuts.at(-1), last], i) && !body.some((g) => g.includes(i))
    )
  )
    return
  const preceding = rows.filter((r) => r.rect[3] <= first)
  if (!preceding.length) return
  rows.splice(
    0,
    rows.length,
    ...preceding,
    ...bounds.map((b, n) => ({
      rect: [
        cuts[0],
        n ? (bounds[n - 1][3] + b[1]) / 2 : b[1],
        cuts.at(-1),
        n + 1 < bounds.length ? (b[3] + bounds[n + 1][1]) / 2 : b[3]
      ],
      origin: 'source-text'
    }))
  )
  repairs.push('repeated-measurement-section-separated')
}

// Recover complete native records that fall in a gap between predicted bands.
// A row is accepted only when every value has a unique column, adjacent source
// baselines bound it, and splitting the affected bands cannot discard text.
export function recoverUnownedSourceRows({ rows, groups, items, columnRects, repairs }) {
  if (columnRects.length < 2 || groups.length < 4) return
  const sizes = items.map((i) => i.height).sort((a, b) => a - b)
  const native = groupSourceRowsWithScripts(
    items.slice().sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0]),
    sizes[Math.floor(sizes.length / 2)],
    0.35
  )
  if (!native) return
  groups = native
  recoverSparseMeasuredSourceRows({ rows, groups, items, columnRects, repairs })
  const left = columnRects[0][0],
    right = columnRects.at(-1)[2]
  const columnOf = (item) => {
    const owners = columnRects.map((c, n) => (inside(c, item) ? n : -1)).filter((n) => n >= 0)
    return owners.length === 1 ? owners[0] : -1
  }
  const numeric = (text) =>
    /^(?:[<>≤≥−+-]?\s*(?:\d|\.\d)[\d\s.,()%±*–−+\-/]*|[–—−-])$/u.test(text.trim())
  // A missed stub-only section can sit wholly between model rows. An already
  // owned peer and complete indented numeric records establish its role.
  // Use baseline separation for the tiny overlap of native font ascent boxes.
  const section = (g) =>
    g.every((i) => i.horizontal && columnOf(i) === 0) &&
    /\p{L}/u.test(g.map((i) => i.text).join(' '))
  const indentedRecord = (g, title) => {
    const height = Math.max(...title.map((i) => i.height)),
      body = g.filter((i) => i.height >= height * 0.8),
      label = body.filter((i) => columnOf(i) === 0)
    return (
      label.length &&
      Math.min(...label.map((i) => i.rect[0])) - union(title)[0] >= height * 0.5 &&
      columnRects.slice(1).every((_, c) =>
        numeric(
          body
            .filter((i) => columnOf(i) === c + 1)
            .map((i) => i.text)
            .join(' ')
        )
      )
    )
  }
  const peers = groups.filter(
    (g, n) =>
      section(g) &&
      groups[n + 1] &&
      indentedRecord(groups[n + 1], g) &&
      rows.some(
        (row) =>
          g.every((i) => inside(row.rect, i)) &&
          items.filter((i) => inside(row.rect, i)).every((i) => g.includes(i))
      )
  )
  const duplicateSections = []
  for (let n = 1; n < groups.length - 1; n++) {
    const group = groups[n],
      height = Math.max(...group.map((i) => i.height))
    const owners = rows.filter((row) => group.some((i) => inside(row.rect, i)))
    const duplicateSection =
      owners.length > 1 &&
      owners.every(
        (row) =>
          group.every((i) => inside(row.rect, i)) &&
          items.filter((i) => inside(row.rect, i)).every((i) => group.includes(i))
      )
    if (
      !section(group) ||
      !indentedRecord(groups[n + 1], group) ||
      !peers.some(
        (peer) =>
          peer !== group &&
          Math.abs(union(peer)[0] - union(group)[0]) < height * 0.1 &&
          peer.every((i) => Math.abs(i.height - height) < height * 0.05)
      ) ||
      (owners.length && !duplicateSection)
    )
      continue
    const rect = union(group),
      previous = union(groups[n - 1]),
      next = union(groups[n + 1])
    if (
      previous[3] > rect[1] ||
      rect[3] - next[1] > height * 0.15 ||
      next[1] - rect[3] > height ||
      rect[1] - previous[3] > height ||
      Math.max(...groups[n + 1].map((i) => i.baseline)) -
        Math.max(...group.map((i) => i.baseline)) <
        height * 0.8
    )
      continue
    const band = [left, rect[1], right, rect[3]]
    if (items.some((i) => inside(band, i) && !group.includes(i))) continue
    // Recover neighboring records before replacing duplicate heading bands;
    // their padding can be the only model evidence crossing a missed record.
    if (duplicateSection) {
      duplicateSections.push({ group, band, owners })
      continue
    }
    const affected = rows.filter((row) => row.rect[1] < band[3] && row.rect[3] > band[1])
    if (
      affected.some((row) => {
        const owned = items.filter((i) => inside(row.rect, i))
        return (
          !owned.length ||
          !(
            owned.every((i) => i.baseline < rect[1]) ||
            owned.every((i) => (i.rect[1] + i.rect[3]) / 2 > rect[3])
          )
        )
      })
    )
      continue
    for (const row of affected) {
      if (row.rect[1] < band[1]) row.rect[3] = band[1]
      else row.rect[1] = band[3]
    }
    rows.push({ rect: band, origin: 'source-text' })
    rows.sort((a, b) => a.rect[1] - b.rect[1])
    repairs.push('text-supported-row-recovered')
  }
  for (let index = 1; index < groups.length - 1; index++) {
    const group = groups[index],
      before = groups[index - 1],
      after = groups[index + 1]
    const values = columnRects.map((_, c) =>
      group
        .filter((i) => columnOf(i) === c)
        .map((i) => i.text)
        .join(' ')
    )
    // A categorical heading may own only a shared probability; its indented
    // percentage records populate the intervening measurement columns.
    const sparseCategory =
      columnRects.length >= 4 &&
      /^\p{Lu}[\p{L} -]+$/u.test(values[0]) &&
      values.slice(1, -1).every((v) => !v) &&
      /^(?:0?(?:\.\d+)|1(?:\.0+)?)$/.test(values.at(-1)) &&
      items.some(
        (i) => columnOf(i) === columnRects.length - 1 && /^p(?:[- ]?value)?$/i.test(i.text)
      ) &&
      groups.slice(index + 1, index + 4).length === 3 &&
      groups.slice(index + 1, index + 4).every((g) => {
        const v = columnRects.map((_, c) =>
          g
            .filter((i) => columnOf(i) === c)
            .map((i) => i.text)
            .join('')
        )
        const stub = g.find((i) => columnOf(i) === 0),
          label = group.find((i) => columnOf(i) === 0)
        return (
          stub &&
          label &&
          stub.rect[0] > label.rect[0] + label.height * 0.3 &&
          /\p{L}/u.test(v[0]) &&
          !v.at(-1) &&
          v.slice(1, -1).every((s) => /^\d+(?:\.\d+)?%$/.test(s))
        )
      })
    if (
      !(
        /\p{L}/u.test(values[0]) ||
        (/^\d+(?:\.\d+)?$/.test(values[0]) &&
          [before, after].every((g) => {
            const v = g
              .filter((i) => columnOf(i) === 0)
              .map((i) => i.text)
              .join(' ')
            return (
              /^\d+(?:\.\d+)?$/.test(v) &&
              (g === before ? Number(v) < Number(values[0]) : Number(v) > Number(values[0]))
            )
          }))
      ) ||
      (!sparseCategory && values.slice(1).some((v) => !v || !numeric(v))) ||
      group.some((i) => !i.horizontal || columnOf(i) < 0) ||
      rows.filter((r) => group.every((i) => inside(r.rect, i))).length === 1
    )
      continue
    const rect = union(group),
      previous = union(before),
      next = union(after)
    if (rows.some((r) => rect[1] >= r.rect[1] && rect[3] <= r.rect[3])) continue
    const labelLeft = Math.min(...group.filter((i) => columnOf(i) === 0).map((i) => i.rect[0]))
    if (
      ![before, after].every((g) => g.some((i) => columnOf(i) === 0 && /\p{L}|\d/u.test(i.text))) ||
      ![before, after].some(
        (g) =>
          g.some((i) => columnOf(i) === 0 && Math.abs(i.rect[0] - labelLeft) < 1.5) &&
          columnRects
            .slice(1)
            .every((_, c) => g.some((i) => columnOf(i) === c + 1 && numeric(i.text)))
      )
    )
      continue
    const height = Math.max(...group.map((i) => i.height))
    const body = group.filter((i) => i.height >= height * 0.8)
    if (rows.filter((r) => body.every((i) => inside(r.rect, i))).length === 1) continue
    if (previous[3] > rect[1] || next[1] < rect[3] || next[1] - previous[3] > height * 5) continue
    const start = (previous[3] + rect[1]) / 2,
      end = (rect[3] + next[1]) / 2
    const band = [left, start, right, end],
      members = new Set(group)
    if (items.some((i) => inside(band, i) && !members.has(i))) continue
    const affected = rows.filter((r) => r.rect[1] < end && r.rect[3] > start)
    if (!affected.length) continue
    // A crossing source glyph must stay wholly on one side of each new cut.
    if (
      items.some(
        (i) =>
          !members.has(i) &&
          i.rect[0] < right &&
          i.rect[2] > left &&
          ((i.rect[1] < start && i.rect[3] > start) || (i.rect[1] < end && i.rect[3] > end))
      )
    )
      continue
    for (const row of affected) {
      const owned = items.filter((i) => inside(row.rect, i) && !members.has(i))
      const upper = owned.some((i) => i.rect[3] <= start),
        lower = owned.some((i) => i.rect[1] >= end)
      if (upper && lower) {
        rows.push({ ...row, rect: [left, end, right, row.rect[3]] })
        row.rect[3] = start
      } else if (upper) row.rect[3] = start
      else if (lower) row.rect[1] = end
      else rows.splice(rows.indexOf(row), 1)
    }
    for (const row of affected) {
      if (rows.includes(row) && !items.some((i) => inside(row.rect, i))) {
        rows.splice(rows.indexOf(row), 1)
        repairs.push('empty-overlapping-row-removed')
      }
    }
    rows.push({ rect: band, origin: 'source-text' })
    rows.sort((a, b) => a.rect[1] - b.rect[1])
    repairs.push('text-supported-row-recovered')
  }
  for (const { group, band, owners } of duplicateSections) {
    if (
      owners.some(
        (row) =>
          !rows.includes(row) ||
          !group.every((i) => inside(row.rect, i)) ||
          items.some((i) => inside(row.rect, i) && !group.includes(i))
      )
    )
      continue
    for (const row of owners) rows.splice(rows.indexOf(row), 1)
    rows.push({ rect: band, origin: 'source-text' })
    rows.sort((a, b) => a.rect[1] - b.rect[1])
    repairs.push('text-supported-row-recovered')
  }
}

// A complete measured baseline can omit a shared P value and its ancestor
// stub. Require the same measurement columns on both neighboring baselines;
// only explicitly labelled probability columns may be empty. This does not
// turn a prose line or a partially populated scientific record into a row.
function recoverSparseMeasuredSourceRows({ rows, groups, items, columnRects, repairs }) {
  if (columnRects.length < 4 || columnRects.length > 12) return
  const col = (i) => {
    const owners = columnRects.flatMap((r, c) =>
      i.rect[0] >= r[0] && i.rect[2] <= r[2] && inside(r, i) ? [c] : []
    )
    return owners.length === 1 ? owners[0] : -1
  }
  const value = (g, c) =>
    g
      .filter((i) => col(i) === c)
      .map((i) => i.text)
      .join('')
  const numeric = (s) => /^(?:[<>≤≥−+–-]?(?:\d|\.\d)[\d\s.,()%±*†‡–−+\-/]*|[–—−-])$/u.test(s)
  const probability = new Set(
    columnRects.flatMap((_, c) => {
      const labelled = groups
        .slice(0, 8)
        .some((g) => /^P(?:-?Value)?[*†‡]?$/i.test(value(g, c).replace(/\s/g, '')))
      return labelled ? [c] : []
    })
  )
  if (!probability.size) return
  const sampleLeaves =
    columnRects.length === 6 &&
    groups.slice(0, 8).some((g) => [1, 2, 3, 4].map((c) => value(g, c)).join('|') === 'N|%|N|%')
  for (let n = 1; n < groups.length - 1; n++) {
    const g = groups[n],
      v = columnRects.map((_, c) => value(g, c))
    const first = v.findIndex(Boolean)
    const stub = first === 1 && /^\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?$/.test(v[1]) ? 1 : 0
    const qualifiedSample =
      sampleLeaves &&
      first === 0 &&
      /\p{L}/u.test(v[0]) &&
      [1, 3].every((c) => /^N\s*=\s*\d+$/.test(v[c])) &&
      !v[2] &&
      !v[4] &&
      numeric(v[5])
    if (
      first !== stub ||
      !(stub === 1 || /\p{L}/u.test(v[0])) ||
      g.some((i) => !i.horizontal || col(i) < 0) ||
      (!qualifiedSample &&
        !v.slice(stub + 1).every((s, c) => numeric(s) || (!s && probability.has(c + stub + 1))))
    )
      continue
    const measured = v.flatMap((s, c) => (c > stub && s && !probability.has(c) ? [c] : []))
    if (measured.length < 2) continue
    if (rows.filter((r) => g.every((i) => inside(r.rect, i))).length === 1) continue
    const before = groups[n - 1],
      after = groups[n + 1]
    const intervalTail = before.every(
      (i) => col(i) > stub && /^\[[\d.,+–−\s-]+\]$/.test(i.text.trim())
    )
    const previous = intervalTail && n > 1 ? groups[n - 2] : before
    if (
      ![previous, after].every(
        (peer) =>
          peer.every((i) => i.horizontal && col(i) >= 0) &&
          peer.some((i) => col(i) <= stub && /\p{L}|\d/u.test(i.text)) &&
          measured.every((c) => !value(peer, c) || numeric(value(peer, c))) &&
          measured.some((c) => numeric(value(peer, c)))
      ) ||
      ![previous, after].some((peer) => measured.every((c) => numeric(value(peer, c))))
    )
      continue
    const rect = union(g),
      prev = union(before),
      next = union(after)
    const h = Math.max(...g.map((i) => i.height))
    if (
      prev[3] > rect[1] ||
      next[1] < rect[3] ||
      next[1] - prev[3] > h * 5 ||
      [before, after].some((peer) =>
        peer.some(
          (i) =>
            Math.abs(i.height - h) > h * 0.15 &&
            !peer.some((anchor) => anchor !== i && isAdjacentTableScript(i, anchor))
        )
      )
    )
      continue
    const start = (prev[3] + rect[1]) / 2,
      end = (rect[3] + next[1]) / 2
    const left = columnRects[0][0],
      right = columnRects.at(-1)[2]
    const band = [left, start, right, end],
      members = new Set(g)
    if (items.some((i) => inside(band, i) && !members.has(i))) continue
    const affected = rows.filter((r) => r.rect[1] < end && r.rect[3] > start)
    if (
      affected.some((r) => {
        const own = items.filter((i) => inside(r.rect, i) && !members.has(i))
        return own.some((i) => i.rect[3] > start && i.rect[1] < end)
      })
    )
      continue
    for (const r of affected) {
      const own = items.filter((i) => inside(r.rect, i) && !members.has(i))
      const upper = own.some((i) => i.rect[3] <= start),
        lower = own.some((i) => i.rect[1] >= end)
      if (upper && lower) {
        rows.push({ ...r, rect: [left, end, right, r.rect[3]] })
        r.rect[3] = start
      } else if (upper) r.rect[3] = start
      else if (lower) r.rect[1] = end
      else rows.splice(rows.indexOf(r), 1)
    }
    rows.push({ rect: band, origin: 'source-text' })
    rows.sort((a, b) => a.rect[1] - b.rect[1])
    repairs.push('text-supported-row-recovered')
  }
}

// A stub-only tail may be a wrapped label rather than a new section. Require
// lexical continuation or a repeated hanging-indent pattern, with shorter
// native leading than records; ruled boundaries and numeric tails stop the join.
function repairRaisedMarkerRows({ rows, items, left, right, repairs }) {
  // Some PDFs give raised note symbols the same em box as the body font.
  // Their near-touching advance and raised baseline still identify the owner.
  for (const marker of items.filter((i) => /^[*⁎†‡]$/.test(i.text))) {
    const anchors = items.filter(
      (a) =>
        a !== marker &&
        /\p{L}/u.test(a.text) &&
        a.horizontal &&
        marker.horizontal &&
        Math.abs(marker.rect[0] - a.rect[2]) < a.height * 0.05 &&
        marker.height <= a.height * 1.1 &&
        a.baseline - marker.baseline > a.height * 0.15 &&
        a.baseline - marker.baseline < a.height * 0.5
    )
    if (anchors.length !== 1) continue
    const touched = rows.filter((r) => inside(r.rect, anchors[0]) || inside(r.rect, marker))
    if (touched.length !== 2 || Math.abs(rows.indexOf(touched[0]) - rows.indexOf(touched[1])) !== 1)
      continue
    const rect = [
      left,
      Math.min(...touched.map((r) => r.rect[1])),
      right,
      Math.max(...touched.map((r) => r.rect[3]))
    ]
    if (items.some((i) => i !== marker && i !== anchors[0] && inside(rect, i))) continue
    touched[0].rect = rect
    rows.splice(rows.indexOf(touched[1]), 1)
    repairs.push('inline-fragment-row-recovered')
  }
}

// Independent body prose can attest a label whose source indentation is
// inconsistent. Never build a witness across columns, paragraph gaps or the
// table itself. Matching word boundaries prevents partial-word evidence.
function proseRepeatsPhrase(phrase, items) {
  const words = (text) => text.toLowerCase().match(/\p{L}+/gu) ?? []
  const target = words(phrase)
  if (target.length < 3) return false
  const exact = new RegExp(`(?:^|[^\\p{L}])${target.join('\\s+')}(?=$|[^\\p{L}])`, 'iu')
  const contains = (text) => exact.test(text)
  const lines = items.filter(
    (item) => item.horizontal && item.height > 0 && words(item.text).length >= 4
  )
  return lines.some(
    (line) =>
      contains(line.text) ||
      lines.some(
        (next) =>
          next !== line &&
          Math.abs(line.height - next.height) <= line.height * 0.05 &&
          Math.abs(line.rect[0] - next.rect[0]) <= line.height * 0.2 &&
          next.baseline - line.baseline >= line.height &&
          next.baseline - line.baseline <= line.height * 1.5 &&
          contains(line.text + ' ' + next.text)
      )
  )
}

// A final source band may continue both the stub and a narrative value. Learn
// that wrapping from two intact cells, and require the native closing border.
function mergeTerminalNarrativeRecord({
  rows,
  items,
  columnRects: predictedColumns,
  rules,
  repairs
}) {
  let columnRects = predictedColumns
  if (rows.length < 5 || columnRects.length < 3 || rows.at(-1).origin !== 'source-text') return
  const owned = (row) => items.filter((i) => inside(row.rect, i))
  const upper = owned(rows.at(-2)),
    lower = owned(rows.at(-1)),
    all = [...upper, ...lower]
  if (!all.length || all.some((i) => !i.horizontal)) return
  const height = Math.max(...all.map((i) => i.height))
  if (all.some((i) => Math.abs(i.height - height) > height * 0.05)) return
  // A shared ancestor can precede the leaf label. At the closing border a
  // narrative value may cross the two parameter columns, with the same
  // hanging indent in its leaf label and continuation. Use a coarse view only
  // for recognizing that record; do not infer shared values elsewhere.
  const nested =
    columnRects.length === 4 &&
    all.every((i) => !inside(columnRects[0], i)) &&
    upper.some((i) => i.rect[0] < columnRects[2][2] && i.rect[2] > columnRects[2][2])
  if (nested)
    columnRects = [
      columnRects[0],
      columnRects[1],
      union(columnRects.slice(2).map((rect) => ({ rect })))
    ]
  const columnItems = (list, c) => list.filter((i) => inside(columnRects[c], i))
  const orderedText = (list) =>
    [...list]
      .sort((a, b) => a.rect[0] - b.rect[0])
      .map((i) => i.text)
      .join(' ')
  const active = columnRects.flatMap((_, c) => (columnItems(lower, c).length ? [c] : []))
  if (
    active.length < 2 ||
    active[0] !== (nested ? 1 : 0) ||
    active.length === columnRects.length ||
    !columnRects.every((_, c) => (nested && c === 0) || columnItems(upper, c).length) ||
    active.some((c) => !/^[a-z]/.test(orderedText(columnItems(lower, c))))
  )
    return
  const indent = union(columnItems(lower, active[0]))[0] - union(columnItems(upper, active[0]))[0]
  if (
    nested &&
    (indent < height * 0.4 ||
      indent > height * 2 ||
      !owned(rows.at(-3)).some(
        (i) =>
          inside(columnRects[1], i) && columnItems(upper, 1)[0].baseline - i.baseline > height * 1.8
      ))
  )
    return
  const gaps = []
  for (const c of active) {
    const head = columnItems(upper, c),
      tail = columnItems(lower, c)
    const gap = tail[0].baseline - head[0].baseline
    if (
      gap < height * 0.8 ||
      gap > height * 1.6 ||
      Math.abs(union(tail)[0] - union(head)[0] - (nested ? indent : 0)) > height * 0.1 ||
      [...head, ...tail].some((i) => i.rect[0] < columnRects[c][0] || i.rect[2] > columnRects[c][2])
    )
      return
    gaps.push(gap)
  }
  if (Math.max(...gaps) - Math.min(...gaps) > height * 0.1) return
  const witnessed = active.slice(1).some(
    (c) =>
      rows.slice(0, -2).filter((row) => {
        const tokens = columnItems(owned(row), c)
        const groups = groupSourceRowsWithScripts(
          [...tokens].sort((a, b) => a.baseline - b.baseline),
          height,
          0.3
        )
        return (
          groups?.length === 2 &&
          (nested
            ? /\p{L}/u.test(orderedText(groups[1]))
            : /^[a-z]/.test(orderedText(groups[1]))) &&
          Math.abs(union(groups[1])[0] - union(groups[0])[0] - (nested ? indent : 0)) <
            height * 0.1 &&
          Math.abs(groups[1][0].baseline - groups[0][0].baseline - gaps[0]) < height * 0.1
        )
      }).length >= 2
  )
  const rect = union(all),
    lowerRect = union(lower)
  if (
    !witnessed ||
    hasHorizontalTableRuleBetween(rules, union(upper)[3], lowerRect[1]) ||
    !joinHorizontalTableRules(rules).some(
      (r) =>
        r[1] >= lowerRect[3] &&
        r[1] - lowerRect[3] < height * 1.5 &&
        Math.abs(r[0] - columnRects[0][0]) < height * 1.5 &&
        Math.abs(r[2] - columnRects.at(-1)[2]) < height * 1.5
    ) ||
    items.some(
      (i) =>
        inside([columnRects[0][0], rect[1], columnRects.at(-1)[2], rect[3]], i) && !all.includes(i)
    )
  )
    return
  rows.at(-2).rect = union(rows.slice(-2))
  rows.pop()
  repairs.push('wrapped-comparison-record-recovered')
}

export function mergeWrappedStubTails({
  rows,
  items,
  columnRects,
  rules,
  repairs,
  externalItems = []
}) {
  recoverRepeatedMeasuredHangingTails({ rows, items, columnRects, rules, repairs })
  mergeTerminalNarrativeRecord({ rows, items, columnRects, rules, repairs })
  repairRaisedMarkerRows({
    rows,
    items,
    left: columnRects[0]?.[0],
    right: columnRects.at(-1)?.[2],
    repairs
  })
  if (columnRects.length < 3) return
  const owned = (row) => items.filter((i) => inside(row.rect, i))
  const stub = (list) => list.filter((i) => inside(columnRects[0], i))
  const text = (list) =>
    list
      // Raised note letters must not turn a capitalized section heading into
      // a lowercase continuation. Keep their tokens for final cell rendering.
      .filter(
        (i) =>
          !/^[a-z]\)$/.test(i.text) ||
          !list.some((anchor) => anchor !== i && isAdjacentTableScript(i, anchor))
      )
      .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
      .map((i) => i.text)
      .join(' ')
      .trim()
  // Learn a value-on-second-line record from already intact peers. This is
  // stronger evidence than lowercase text alone, including at the table end.
  const signature = (labels, values) => {
    if (labels.length !== 2 || values.length === labels.length) return
    const [a, b] = [...labels].sort((a, b) => a.baseline - b.baseline),
      h = a.height
    if (
      !h ||
      !/\p{L}/u.test(a.text) ||
      !/^[a-z]/.test(b.text) ||
      values.some((i) => !i.horizontal || Math.abs(i.height - h) > h * 0.05) ||
      b.baseline - a.baseline < h * 0.8 ||
      b.baseline - a.baseline > h * 1.6 ||
      b.rect[0] - a.rect[0] < h * 0.5 ||
      b.rect[0] - a.rect[0] > h * 2.5 ||
      hasHorizontalTableRuleBetween(rules, a.rect[3], b.rect[1]) ||
      !columnRects
        .slice(1)
        .every((c) =>
          values.some(
            (i) =>
              inside(c, i) &&
              /^\d+(?:\.\d+)?$/.test(i.text) &&
              Math.abs(i.baseline - b.baseline) < h * 0.1
          )
        )
    )
      return
    return { indent: (b.rect[0] - a.rect[0]) / h, gap: (b.baseline - a.baseline) / h }
  }
  const intact = rows.flatMap((row) => {
    const values = owned(row),
      s = signature(stub(values), values)
    return s ? [s] : []
  })
  for (let n = 1; n < rows.length; n++) {
    const upper = owned(rows[n - 1]),
      lower = owned(rows[n])
    if (upper.length !== 1 || stub(upper).length !== 1) continue
    const values = [...upper, ...lower],
      s = signature(stub(values), values)
    if (
      !s ||
      intact.filter((p) => Math.abs(p.indent - s.indent) < 0.1 && Math.abs(p.gap - s.gap) < 0.1)
        .length < 2 ||
      upper.some((i) => lower.includes(i)) ||
      items.some((i) => inside(union([rows[n - 1], rows[n]]), i) && !values.includes(i))
    )
      continue
    rows[n - 1].rect = union([rows[n - 1], rows[n]])
    rows.splice(n--, 1)
    repairs.push('wrapped-comparison-record-recovered')
  }
  const lowerTails = rows.filter((row) => {
    const values = owned(row),
      labels = stub(values)
    return values.length === labels.length && /^[a-z]/.test(text(labels))
  }).length
  // Learn hanging leading only from several independently measured records.
  // This also covers capitals and final-row tails without a semantic word list.
  const hanging = []
  for (let n = 1; n < rows.length - 1; n++) {
    const upper = owned(rows[n - 1]),
      lower = owned(rows[n]),
      head = stub(upper),
      tail = stub(lower),
      next = stub(owned(rows[n + 1]))
    if (
      !head.length ||
      !tail.length ||
      !next.length ||
      lower.length !== tail.length ||
      upper.length === head.length
    )
      continue
    const h = Math.max(...head.map((i) => i.height), ...tail.map((i) => i.height)),
      indent = Math.min(...tail.map((i) => i.rect[0])) - Math.min(...head.map((i) => i.rect[0])),
      gap = Math.min(...tail.map((i) => i.baseline)) - Math.max(...head.map((i) => i.baseline))
    if (
      [...upper, ...lower].every((i) => i.horizontal) &&
      [...head, ...tail].every((i) => Math.abs(i.height - h) < h * 0.05) &&
      indent >= h * 0.25 &&
      indent <= h * 0.75 &&
      gap >= h * 0.8 &&
      gap <= h * 1.6 &&
      Math.min(...next.map((i) => i.baseline)) - Math.max(...tail.map((i) => i.baseline)) >=
        gap * 1.2 &&
      !hasHorizontalTableRuleBetween(rules, union(head)[3], union(tail)[1])
    )
      hanging.push({ indent: indent / h, gap: gap / h })
  }
  const pattern = hanging.find(
    (p) =>
      hanging.filter((q) => Math.abs(p.indent - q.indent) < 0.1 && Math.abs(p.gap - q.gap) < 0.1)
        .length >= 3
  )
  // Group headings can own only a terminal comparison value while their
  // indented categories own the intervening data columns. Learn that layout
  // from several intact groups before accepting a stub-only heading tail.
  const groupOwned = (row) =>
    items.filter((i) =>
      inside([columnRects[0][0], row.rect[1], columnRects.at(-1)[2], row.rect[3]], i)
    )
  const groupedHeading = (upper, children) => {
    const head = stub(upper),
      values = upper.filter((i) => !head.includes(i)),
      h = Math.max(...head.map((i) => i.height))
    if (
      columnRects.length < 5 ||
      !head.length ||
      values.length !== 1 ||
      !inside(columnRects.at(-1), values[0]) ||
      !/^\d+(?:\.\d+)?$/.test(values[0].text) ||
      Math.abs(values[0].baseline - head.at(-1).baseline) > h * 0.1 ||
      children.length !== 2
    )
      return
    const labels = children.map(stub),
      indents = labels.map((list) => union(list)[0] - union(head)[0])
    if (
      labels.some((list) => !list.length) ||
      indents.some((indent) => indent < h * 0.25 || indent > h * 1.5) ||
      Math.abs(indents[0] - indents[1]) > h * 0.1 ||
      [...head, ...children.flat()].some(
        (i) => !i.horizontal || Math.abs(i.height - h) > h * 0.05
      ) ||
      children.some(
        (list) =>
          list.some((i) => inside(columnRects.at(-1), i)) ||
          !columnRects
            .slice(1, -1)
            .every((column) =>
              list.some((i) => inside(column, i) && /^(?:\d+(?:\.\d+)?|[−–—-])$/.test(i.text))
            )
      ) ||
      text(labels[0]) === text(labels[1])
    )
      return
    return { head: text(head), labels: labels.map(text).join('\n'), indent: indents[0] / h }
  }
  const groupedPeers = rows.flatMap((row, n) => {
    const peer = groupedHeading(groupOwned(row), rows.slice(n + 1, n + 3).map(groupOwned))
    return peer ? [peer] : []
  })
  const measuredRecord = (content) =>
    columnRects
      .slice(1)
      .every((c) => content.some((i) => inside(c, i) && /^[<>≤≥−–—+-]?\d/.test(i.text)))
  // Parenthesized variable definitions can continue a measured label at the
  // same leading as records. Require repeated matching heads, a conjunction,
  // and independently populated value columns; a bare subgroup stays separate.
  const scriptedContinuations = rows.flatMap((row, n) => {
    if (!n) return []
    const upper = owned(rows[n - 1]),
      lower = owned(row),
      head = stub(upper),
      tail = stub(lower)
    const height = Math.max(...head.map((i) => i.height), ...tail.map((i) => i.height))
    const body = tail.filter((i) => i.height >= height * 0.8)
    const columns = columnRects
      .slice(1)
      .filter((c) => upper.some((i) => inside(c, i) && /^[−–—+\d.-]/.test(i.text)))
    if (
      !head.length ||
      !tail.length ||
      tail.length !== lower.length ||
      columns.length < 2 ||
      !upper.some((i) => !head.includes(i) && /\d/.test(i.text)) ||
      !/^\([a-z]\s*\)\s+(?:and|or)\b/.test(text(body)) ||
      Math.abs(union(head)[0] - union(tail)[0]) > height * 0.1
    )
      return []
    return [{ row, head: text(head) }]
  })
  for (let n = 1; n < rows.length; n++) {
    const upper = owned(rows[n - 1]),
      lower = owned(rows[n]),
      head = stub(upper),
      tail = stub(lower)
    if (
      !head.length ||
      !tail.length ||
      tail.length !== lower.length ||
      [...upper, ...lower].some((i) => !i.horizontal)
    )
      continue
    const a = text(head),
      b = text(tail),
      h = Math.max(...head.map((i) => i.height), ...tail.map((i) => i.height))
    const gap = Math.min(...tail.map((i) => i.baseline)) - Math.max(...head.map((i) => i.baseline))
    const next = rows[n + 1] ? stub(owned(rows[n + 1])) : []
    const indent = Math.min(...tail.map((i) => i.rect[0])) - Math.min(...head.map((i) => i.rect[0]))
    const scriptedTail = scriptedContinuations.some(
      (p) => p.row === rows[n] && scriptedContinuations.filter((q) => q.head === p.head).length >= 2
    )
    const witnessedSection =
      upper.length === head.length &&
      /^[\p{L}]+(?:\s+[\p{L}]+)+$/u.test(a) &&
      /^[\p{L}]+(?:\s+[\p{L}]+)?$/u.test(b) &&
      indent <= -h * 0.5 &&
      indent >= -h * 1.5 &&
      [...head, ...tail].every((i) => Math.abs(i.height - h) < h * 0.05) &&
      rows.slice(n + 1, n + 3).length === 2 &&
      rows.slice(n + 1, n + 3).every((row) => {
        const content = owned(row),
          labels = stub(content)
        return (
          labels.length &&
          Math.min(...labels.map((i) => i.rect[0])) >= union(head)[0] + h * 0.25 &&
          columnRects.slice(1).filter((c) => content.some((i) => inside(c, i) && /\d/.test(i.text)))
            .length >= 3
        )
      }) &&
      proseRepeatsPhrase(a + ' ' + b, externalItems)
    const hangingTail =
      pattern &&
      upper.length > head.length &&
      [...head, ...tail].every((i) => Math.abs(i.height - h) < h * 0.05) &&
      Math.abs(indent / h - pattern.indent) < 0.1 &&
      Math.abs(gap / h - pattern.gap) < 0.1
    const group = groupedHeading(groupOwned(rows[n - 1]), rows.slice(n + 1, n + 3).map(groupOwned))
    const groupedTail =
      group &&
      /^[a-z][\p{L}\s/-]*$/u.test(b) &&
      Math.abs(indent) < h * 0.1 &&
      [...head, ...tail].every((i) => Math.abs(i.height - h) < h * 0.05) &&
      new Set(
        groupedPeers
          .filter((p) => p.labels === group.labels && Math.abs(p.indent - group.indent) < 0.1)
          .map((p) => p.head)
      ).size >= 3
    const capitalCompoundTail =
      /^\p{Lu}[\p{L}]+\/\p{Lu}[\p{L}]+$/u.test(a) &&
      /^\p{Lu}[\p{Ll}]+$/u.test(b) &&
      Math.abs(indent) < h * 0.1 &&
      [...head, ...tail].every((i) => Math.abs(i.height - h) < h * 0.05) &&
      columnRects.slice(1).every((c) => upper.some((i) => inside(c, i) && /\d/.test(i.text))) &&
      rows[n + 1] &&
      measuredRecord(groupOwned(rows[n + 1]))
    if (
      !/[\p{L}]/u.test(a) ||
      !(
        witnessedSection ||
        capitalCompoundTail ||
        scriptedTail ||
        hangingTail ||
        /[/–-]$/.test(a) ||
        /^[a-z]/.test(b) ||
        /^\([^()]+\)$/.test(b)
      )
    )
      continue
    const range = /^\(\d+(?:[–−-]\d+)?\)$/.test(b) && upper.length > head.length
    const parenthetical =
      /^\([\p{L}][\p{L}\s/-]+\)$/u.test(b) &&
      indent < 0 &&
      indent >= -h * 1.5 &&
      columnRects.slice(1).every((c) => upper.some((i) => inside(c, i) && /^\d/.test(i.text)))
    const sectionTail = upper.length === head.length && /^[a-z]/.test(b) && lowerTails >= 3
    // Function-word continuations with measured records on both sides are
    // still one label in uniformly spaced tables; extra paragraph leading
    // is not required. Keep standalone subgroup labels out of this rule.
    const measuredTail =
      upper.length > head.length &&
      /^(?:per|as|of|with|and|or|in|for|at|to)\b/.test(b) &&
      upper.filter((i) => !head.includes(i) && /\d/.test(i.text)).length >= 2 &&
      rows[n + 1] &&
      owned(rows[n + 1]).filter((i) => !stub([i]).length && /\d/.test(i.text)).length >= 2 &&
      [...head, ...tail].every((i) => Math.abs(i.height - h) < h * 0.05)
    // A comma-delimited unit can hang below the value line. An intact measured
    // peer must use exactly the same suffix; lowercase text alone is not enough.
    // An unindented unit tail can use the same leading as the next record.
    // Two independently populated labels must already end with this exact
    // suffix; parentheses alone must not turn a subgroup into a continuation.
    const alignedUnitTail =
      Math.abs(indent) < h * 0.1 ||
      (indent >= h * 0.5 &&
        indent <= h * 1.5 &&
        new Set(
          rows
            .filter((row, index) => {
              if (index === n - 1 || index === n || !measuredRecord(groupOwned(row))) return false
              const labels = stub(groupOwned(row))
              if (labels.length < 2 || !text(labels).endsWith(' ' + b)) return false
              const first = Math.min(...labels.map((i) => i.baseline)),
                last = Math.max(...labels.map((i) => i.baseline)),
                head = labels.filter((i) => Math.abs(i.baseline - first) < h * 0.1),
                tail = labels.filter((i) => Math.abs(i.baseline - last) < h * 0.1)
              return (
                head.length + tail.length === labels.length &&
                last - first >= h * 0.8 &&
                last - first <= h * 1.6 &&
                Math.abs(last - first - gap) < h * 0.1 &&
                Math.abs(union(tail)[0] - union(head)[0] - indent) < h * 0.1 &&
                labels.every((i) => i.horizontal && Math.abs(i.height - h) < h * 0.05) &&
                !hasHorizontalTableRuleBetween(rules, union(head)[3], union(tail)[1])
              )
            })
            .map((row) => text(stub(groupOwned(row))))
        ).size >= 2)
    const parenthesizedUnit =
      /^\([\p{L}][\p{L}\d\s./^-]*\)$/u.test(b) &&
      alignedUnitTail &&
      measuredRecord(groupOwned(rows[n - 1])) &&
      rows[n + 1] &&
      measuredRecord(groupOwned(rows[n + 1])) &&
      [...head, ...tail].every((i) => Math.abs(i.height - h) < h * 0.05) &&
      new Set(
        rows
          .filter(
            (row, index) =>
              index !== n - 1 &&
              index !== n &&
              text(stub(groupOwned(row))).endsWith(' ' + b) &&
              measuredRecord(groupOwned(row))
          )
          .map((row) => text(stub(groupOwned(row))))
      ).size >= 2
    const witnessedUnit =
      parenthesizedUnit ||
      (/,$/.test(a) &&
        /^[a-z]+$/.test(b) &&
        indent >= h * 0.5 &&
        indent <= h * 1.5 &&
        columnRects.slice(1).every((c) => upper.some((i) => inside(c, i) && /\d/.test(i.text))) &&
        [...head, ...tail].every((i) => Math.abs(i.height - h) < h * 0.05) &&
        rows.some(
          (row, index) =>
            index !== n - 1 &&
            index !== n &&
            text(stub(owned(row))).endsWith(', ' + b) &&
            columnRects
              .slice(1)
              .every((c) => owned(row).some((i) => inside(c, i) && /\d/.test(i.text)))
        ))
    if (
      (!next.length && !hangingTail) ||
      gap < h * 0.8 ||
      gap > h * 1.6 ||
      (!range &&
        !sectionTail &&
        !parenthetical &&
        !hangingTail &&
        !groupedTail &&
        !witnessedSection &&
        !capitalCompoundTail &&
        !scriptedTail &&
        !measuredTail &&
        !witnessedUnit &&
        Math.min(...next.map((i) => i.baseline)) - Math.max(...tail.map((i) => i.baseline)) <
          gap * 1.2) ||
      Math.abs(Math.min(...head.map((i) => i.rect[0])) - Math.min(...tail.map((i) => i.rect[0]))) >
        h * (parenthetical || witnessedSection || witnessedUnit ? 1.5 : 0.75) ||
      hasHorizontalTableRuleBetween(rules, union(head)[3], union(tail)[1])
    )
      continue
    // Preserve independently owned source text if detector rows overlap.
    if (
      items.some((i) => inside(rows[n - 1].rect, i) && inside(rows[n].rect, i)) ||
      items.some(
        (i) => inside(union([rows[n - 1], rows[n]]), i) && !upper.includes(i) && !lower.includes(i)
      )
    )
      continue
    rows[n - 1].rect = union([rows[n - 1], rows[n]])
    rows.splice(n, 1)
    n--
    repairs.push('wrapped-comparison-record-recovered')
  }
}

// Repeated record cycles provide the boundaries of intervening stub
// sections, including wrapped titles and detached superscripts. Rebuild only
// when every body token belongs to the same repeated sequence or its section.
function recoverRepeatedRecordCycles({ rows, items, columnRects, repairs }) {
  if (columnRects.length < 4 || columnRects.length > 12 || items.some((i) => !i.horizontal)) return
  const sizes = items.map((i) => i.height).sort((a, b) => a - b),
    h = sizes[Math.floor(sizes.length / 2)]
  const groups = groupSourceRowsWithScripts(
    items.slice().sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0]),
    h,
    0.35
  )
  if (!groups) return
  const cuts = [columnRects[0][0], ...columnRects.map((c) => c[2])],
    values = groups.map((g) => readSourceRow(g, cuts))
  const numeric = (s) => /^\(?[<>≤≥−+–-]?(?:\d|\.\d)[\d.,()%/±–−+*†‡\s-]*$/.test(s)
  // Baselines can omit trailing comparison statistics that only change rows
  // report. Require a contiguous numeric prefix and the same occupancy in
  // every cycle; an internal hole cannot be inferred from neighboring rows.
  const record = (n) => {
    const v = values[n]
    if (!v || !/\p{L}/u.test(v[0])) return false
    // A printed zero/omitted coefficient, dash and reference label can close every
    // repeated group. Preserve the literal reference instead of demanding a
    // numeric P-value; the shared record signature is still checked below.
    if (
      /^Ref(?:erent|erence)?\.?$/i.test(v.at(-1)) &&
      /^(?:0|[–—−-])$/.test(v[1]) &&
      v.slice(2, -1).every((s) => /^[–—−-]$/.test(s))
    )
      return true
    const firstBlank = v.slice(1).findIndex((s) => !s),
      end = firstBlank < 0 ? v.length : firstBlank + 1
    return end >= 3 && v.slice(1, end).every(numeric) && v.slice(end).every((s) => !s)
  }
  const section = (n) => values[n] && values[n][0] && values[n].slice(1).every((v) => !v)
  let start = values.findIndex((_, n) => record(n))
  if (start < 1) return
  while (start > 0 && section(start - 1)) start--
  const blocks = []
  for (let n = start; n < groups.length;) {
    const title = []
    while (n < groups.length && section(n)) title.push(...groups[n++])
    if (!title.length || !/\p{L}/u.test(title.map((i) => i.text).join(' '))) return
    const records = []
    while (n < groups.length && record(n)) records.push(n++)
    if (records.length < 2 || records.length > 4) return
    blocks.push({ title, records })
  }
  if (blocks.length < 3) return
  const signature = (b) => b.records.map((n) => [values[n][0], values[n].slice(1).map(Boolean)])
  if (
    blocks.some((b) => JSON.stringify(signature(b)) !== JSON.stringify(signature(blocks[0]))) ||
    !blocks[0].records.some((n) => values[n].slice(1).every(Boolean))
  )
    return
  // A repeated label sequence alone does not establish a full-width section.
  // Require the intervening titles to outdent every record's stub label.
  if (
    blocks.some((b) => {
      const titleLeft = Math.min(...b.title.map((i) => i.rect[0]))
      const recordLeft = Math.min(
        ...b.records.flatMap((n) =>
          groups[n].filter((i) => (i.rect[0] + i.rect[2]) / 2 < cuts[1]).map((i) => i.rect[0])
        )
      )
      return recordLeft - titleLeft < h * 0.35
    })
  )
    return
  const bands = blocks.flatMap((b) => [
    { members: b.title, section: true },
    ...b.records.map((n) => ({ members: groups[n], section: false }))
  ])
  const bounds = bands.map((b) => union(b.members)),
    top = bounds[0][1]
  if (bounds.some((r, n) => n && r[1] <= bounds[n - 1][3])) return
  const header = rows.filter(
    (r) => r.rect[1] < top && items.some((i) => inside(r.rect, i) && i.rect[3] < top)
  )
  if (!header.length || items.some((i) => i.rect[1] < top && i.rect[3] > top)) return
  const members = new Set(bands.flatMap((b) => b.members))
  if (items.some((i) => i.rect[1] >= top && !members.has(i))) return
  rows.splice(
    0,
    rows.length,
    ...header.map((r) => ({
      ...r,
      rect: [r.rect[0], r.rect[1], r.rect[2], Math.min(r.rect[3], top)]
    })),
    ...bands.map((b, n) => ({
      rect: [cuts[0], bounds[n][1], cuts.at(-1), bounds[n][3]],
      origin: 'source-text',
      section: b.section,
      numericRecord: !b.section
    }))
  )
  repairs.push('repeated-measurement-section-separated')
}

// Source spans refer to row positions. Preserve surviving row identities after
// insertion or merging so a removed stub tail cannot move its span onto data.
export function remapSourceRowSpans(recordGrid, previousRows, rows) {
  if (!recordGrid) return
  recordGrid.spans = (recordGrid.spans ?? []).flatMap((span) => {
    const surviving = previousRows
      .slice(span.row, span.row + span.rowSpan)
      .map((row) => rows.indexOf(row))
      .filter((n) => n >= 0)
    return surviving.length ? [{ ...span, row: surviving[0], rowSpan: surviving.length }] : []
  })
  if (recordGrid.headerRows)
    recordGrid.headerRows = recordGrid.headerRows
      .map((n) => rows.indexOf(previousRows[n]))
      .filter((n) => n >= 0)
}

const measuredHangingBox = (xs) => [
  Math.min(...xs.map((i) => i.rect[0])),
  Math.min(...xs.map((i) => i.rect[1])),
  Math.max(...xs.map((i) => i.rect[2])),
  Math.max(...xs.map((i) => i.rect[3]))
]
const containsMeasuredHangingItem = (r, i) =>
  i.rect[0] >= r[0] && i.rect[2] <= r[2] && i.rect[1] >= r[1] && i.rect[3] <= r[3]
// Repeated complete numeric records establish a shared native hanging indent.
// It learns the native hanging pattern without changing old gap tests.
function recoverRepeatedMeasuredHangingTails({ rows, items, columnRects, rules, repairs }) {
  if (columnRects.length < 4 || columnRects.length > 6) return
  const heights = items
      .filter((i) => i.horizontal)
      .map((i) => i.height)
      .sort((a, b) => a - b),
    h = heights[heights.length >> 1]
  if (!(h > 0)) return
  const cuts = [columnRects[0][0], ...columnRects.map((c) => c[2])],
    groups = groupSourceRowsWithScripts(
      items.slice().sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0]),
      h,
      0.3
    )
  if (!groups) return
  const values = groups.map((g) => readSourceRow(g, cuts)),
    number = /^[−+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:\(\d+(?:\.\d+)?%?\))?[*†‡]?$/
  const anchors = groups.flatMap((g, n) =>
    values[n]?.[0] &&
    values[n].slice(1, 4).every((v) => number.test(v)) &&
    values[n].slice(4).every((v) => !v || number.test(v))
      ? [{ g, n }]
      : []
  )
  if (anchors.length < 3) return
  const gutter = measuredHangingBox(anchors[0].g.filter((i) => i.rect[2] <= cuts[1]))[0]
  if (
    anchors.some(({ g }) => {
      const stub = g.filter((i) => i.rect[2] <= cuts[1])
      return (
        !stub.length ||
        Math.abs(measuredHangingBox(stub)[0] - gutter) > h * 0.1 ||
        g.some(
          (i) =>
            Math.abs(i.height - h) > h * 0.05 || Math.abs(i.baseline - stub[0].baseline) > h * 0.1
        )
      )
    })
  )
    return
  const full = rules.filter(
    (r) =>
      r[1] === r[3] &&
      Math.abs(r[0] - gutter) < h * 0.1 &&
      r[2] >= cuts.at(-1) - h &&
      r[2] <= cuts.at(-1) + h
  )
  const closing = full.filter(
    (r) =>
      r[1] > measuredHangingBox(groups.at(-1))[3] && r[1] - measuredHangingBox(groups.at(-1))[3] < h
  )
  if (
    closing.length !== 1 ||
    !full.some(
      (r) => r[1] < measuredHangingBox(anchors[0].g)[1] && Math.abs(r[2] - closing[0][2]) < h * 0.1
    )
  )
    return
  const peers = []
  for (const { g, n } of anchors) {
    const tail = groups[n + 1],
      next = groups[n + 2]
    if (!tail || !values[n + 1] || values[n + 1].slice(1).some(Boolean)) continue
    const stub = g.filter((i) => i.rect[2] <= cuts[1]),
      a = measuredHangingBox(stub),
      b = measuredHangingBox(tail),
      indent = b[0] - a[0],
      gap = tail[0].baseline - stub[0].baseline
    if (
      tail.some(
        (i) => !containsMeasuredHangingItem(columnRects[0], i) || Math.abs(i.height - h) > h * 0.05
      ) ||
      indent < h * 0.5 ||
      indent > h * 0.75 ||
      gap < h * 0.9 ||
      gap > h * 1.6 ||
      b[1] < measuredHangingBox(g)[3]
    )
      continue
    if (
      next &&
      (Math.abs(measuredHangingBox(next)[0] - gutter) > h * 0.1 ||
        measuredHangingBox(next)[1] <= b[3])
    )
      continue
    if (
      rules.some((r) => r[1] === r[3] && r[1] > a[3] && r[1] < b[1] && r[0] <= a[0] && r[2] >= a[2])
    )
      continue
    peers.push({ head: g, tail, indent: indent / h, gap: gap / h })
  }
  const common = peers.find(
    (p) =>
      peers.filter((q) => Math.abs(q.indent - p.indent) < 0.05 && Math.abs(q.gap - p.gap) < 0.05)
        .length >= 3
  )
  if (!common) return
  for (const p of peers
    .filter((q) => Math.abs(q.indent - common.indent) < 0.05 && Math.abs(q.gap - common.gap) < 0.05)
    .reverse()) {
    const upper = rows.filter((r) => p.head.every((i) => containsMeasuredHangingItem(r.rect, i))),
      lower = rows.filter((r) => p.tail.every((i) => containsMeasuredHangingItem(r.rect, i)))
    if (
      upper.length !== 1 ||
      lower.length !== 1 ||
      upper[0] === lower[0] ||
      rows.indexOf(lower[0]) !== rows.indexOf(upper[0]) + 1
    )
      continue
    const ownedA = items.filter((i) => containsMeasuredHangingItem(upper[0].rect, i)),
      ownedB = items.filter((i) => containsMeasuredHangingItem(lower[0].rect, i))
    if (
      ownedB.some((i) => !p.tail.includes(i)) ||
      ownedA.some((i) => ownedB.includes(i)) ||
      ownedA.some((i) => !p.head.includes(i))
    )
      continue
    const frame = measuredHangingBox([...ownedA, ...ownedB])
    if (
      items.some(
        (i) => containsMeasuredHangingItem(frame, i) && !ownedA.includes(i) && !ownedB.includes(i)
      )
    )
      continue
    upper[0].rect = [upper[0].rect[0], upper[0].rect[1], upper[0].rect[2], lower[0].rect[3]]
    rows.splice(rows.indexOf(lower[0]), 1)
    repairs.push('wrapped-comparison-record-recovered')
  }
}
