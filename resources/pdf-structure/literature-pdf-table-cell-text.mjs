/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { area, intersection as intersect } from './literature-pdf-page-geometry.mjs'
import { inside, isAdjacentTableScript } from './literature-pdf-table-geometry.mjs'

// Mutates resolved cells and diagnostics, preserving source-token identity while
// assigning wrapped labels and scripts. Returns text that still has no owner.
export function populateTableCellText({
  cells,
  items,
  pageItems,
  rows,
  columnRects,
  headerRows,
  rules,
  bottom,
  recordGrid,
  scheduleGrid,
  issues,
  repairs
}) {
  const columnOf = (item) => columnRects.findIndex((column) => inside(column, item))
  const assignments = new Map()
  const ambiguousAssignments = new Set()
  for (const item of items) {
    const candidates = cells
      .map((cell) => ({ cell, overlap: intersect(cell.rect, item.rect) / area(item.rect) }))
      .filter((m) => m.overlap > 0.5)
      .sort((a, b) => b.overlap - a.overlap)
    if (!item.horizontal || !candidates.length) {
      continue
    }
    if (candidates[1] && candidates[0].overlap - candidates[1].overlap < 0.1) {
      issues.add('ambiguous-cell-assignment')
      ambiguousAssignments.add(item)
      continue
    }
    assignments.set(item, candidates[0].cell)
  }
  // Repeated mean/SD headings may overhang the empty stub. Require the same
  // heading over the next value column and several paired numeric body rows.
  for (const item of items.filter((i) => /^Mean\s*\(SD\)\s+\p{L}/u.test(i.text))) {
    const stub = assignments.get(item)
    if (!stub || stub.row !== 0 || stub.column !== 0 || stub.colSpan !== 1 || stub.rowSpan !== 1)
      continue
    const target = cells.find(
      (c) => c.row === 0 && c.column === 1 && c.colSpan === 1 && c.rowSpan === 1
    )
    const twin = items.find(
      (i) =>
        i !== item &&
        i.text === item.text &&
        assignments.get(i)?.row === 0 &&
        assignments.get(i)?.column === 2
    )
    if (
      !target ||
      !twin ||
      items.some(
        (i) => i !== item && (assignments.get(i) === stub || assignments.get(i) === target)
      )
    )
      continue
    if (
      intersect(item.rect, target.rect) / area(item.rect) < 0.25 ||
      Math.abs(item.baseline - twin.baseline) > 1
    )
      continue
    const valueRows = new Set(
      items
        .filter((i) => assignments.get(i)?.column === 1 && /^\d+(?:\.\d+)?\s*\(\d/.test(i.text))
        .map((i) => assignments.get(i).row)
    )
    const paired = items.filter(
      (i) =>
        assignments.get(i)?.column === 2 &&
        valueRows.has(assignments.get(i).row) &&
        /^\d+(?:\.\d+)?\s*\(\d/.test(i.text)
    )
    if (paired.length < 3) continue
    assignments.set(item, target)
    repairs.push('overhanging-repeated-statistic-header-recovered')
  }
  // A model column cut may bisect a single sample-size expression. Source
  // adjacency and the closing parenthesis identify its owner; a real vertical
  // rule or any intervening text prevents moving the header boundary.
  for (const suffix of items.filter((item) => /^\d+\)$/.test(item.text.trim()))) {
    const right = assignments.get(suffix)
    if (!right || right.colSpan !== 1 || right.rowSpan !== 1 || !headerRows.includes(right.row))
      continue
    const left = cells.find(
      (cell) =>
        cell.row === right.row &&
        cell.column === right.column - 1 &&
        cell.colSpan === 1 &&
        cell.rowSpan === 1
    )
    if (!left) continue
    const prefix = items
      .filter(
        (item) =>
          assignments.get(item) === left &&
          Math.abs(item.baseline - suffix.baseline) < suffix.height * 0.2 &&
          item.rect[2] <= suffix.rect[0] + 1
      )
      .sort((a, b) => a.rect[0] - b.rect[0])
    if (
      !prefix.length ||
      !/\p{L}.*\([Nn]\s*=\s*$/u.test(prefix.map((item) => item.text).join('')) ||
      prefix.some((item, i) => i && item.rect[0] - prefix[i - 1].rect[2] > item.height * 0.4) ||
      suffix.rect[0] - prefix.at(-1).rect[2] > suffix.height * 0.4
    )
      continue
    const remainder = items.filter((item) => assignments.get(item) === right && item !== suffix)
    if (
      !remainder.some((item) => /\p{L}/u.test(item.text)) ||
      remainder.some((item) => item.rect[0] <= suffix.rect[2]) ||
      rules.some(
        (rule) =>
          rule[0] === rule[2] &&
          rule[0] > prefix.at(-1).rect[2] &&
          rule[0] < suffix.rect[2] &&
          rule[1] < suffix.baseline &&
          rule[3] > suffix.rect[1]
      )
    )
      continue
    const split = (suffix.rect[2] + Math.min(...remainder.map((item) => item.rect[0]))) / 2
    if (items.some((item) => assignments.get(item) === left && item.rect[2] > split)) continue
    assignments.set(suffix, left)
    left.rect[2] = split
    right.rect[0] = split
    repairs.push('split-header-sample-size-recovered')
  }
  // A treatment or count-label prefix belongs to the following lowercase line.
  // Require separate numeric records on both sides before correcting a model
  // boundary that attached the prefix to the preceding treatment.
  for (const prefix of items.filter(
    (i) =>
      i.horizontal &&
      columnOf(i) === 0 &&
      /^(?:[\p{L}\s–-]{2,40}\s*\+|(?:No\.|Number)\s+of\s+[\p{L}\s-]+)$/u.test(i.text.trim())
  )) {
    const previousCell = assignments.get(prefix)
    const next = items
      .filter(
        (i) =>
          i.horizontal &&
          columnOf(i) === 0 &&
          /^[a-z]/.test(i.text) &&
          i.rect[1] >= prefix.rect[3] &&
          i.baseline - prefix.baseline <= prefix.height * 1.7 &&
          (/(?:No\.|Number)\s+of\s/.test(prefix.text)
            ? i.rect[0] >= prefix.rect[0] - 1 && i.rect[0] - prefix.rect[0] <= prefix.height
            : Math.abs(i.rect[0] - prefix.rect[0]) <= 1)
      )
      .sort((a, b) => a.baseline - b.baseline)[0]
    const nextCell = assignments.get(next)
    if (!previousCell || !nextCell || nextCell.row !== previousCell.row + 1) continue
    const previous = items.find(
      (i) =>
        i !== prefix &&
        assignments.get(i) === previousCell &&
        i.rect[3] <= prefix.rect[1] &&
        /\p{L}/u.test(i.text)
    )
    const numericPeers = (anchor) =>
      anchor &&
      new Set(
        items
          .filter(
            (i) =>
              columnOf(i) > 0 &&
              Math.abs(i.baseline - anchor.baseline) < anchor.height * 0.35 &&
              /^\d+(?:\.\d+)?\s*\([\d.]+(?:[–−-][\d.]+)?\)$/.test(i.text.trim())
          )
          .map(columnOf)
      ).size >= 2
    if (!numericPeers(previous) || !numericPeers(next)) continue
    assignments.set(prefix, nextCell)
    nextCell.rect[1] = Math.min(nextCell.rect[1], prefix.rect[1])
    previousCell.rect[3] = Math.min(previousCell.rect[3], (previous.rect[3] + prefix.rect[1]) / 2)
    repairs.push('forward-wrapped-label-recovered')
  }
  // A short wrapped row-label tail can fall into a model gap. Require a
  // neighbouring label in column zero, the same indentation, and an empty gap
  // before the next label. Never attach numeric values or arbitrary notes.
  const extendedCells = new Set()
  for (const item of items.filter(
    (i) =>
      !assignments.has(i) &&
      i.horizontal &&
      columnOf(i) === 0 &&
      /^(?:\(|[a-z]|[A-Z]{2,}\d)/.test(i.text.trim()) &&
      i.text.length < 60
  )) {
    const previous = items
      .filter(
        (i) =>
          assignments.get(i)?.column === 0 &&
          i !== item &&
          i.baseline < item.baseline &&
          item.baseline - i.baseline <= Math.max(i.height, item.height) * 1.7 &&
          (Math.abs(i.rect[0] - item.rect[0]) <= item.height ||
            (item.rect[0] >= i.rect[0] && item.rect[0] <= i.rect[2])) &&
          /\p{L}/u.test(i.text)
      )
      .sort((a, b) => b.baseline - a.baseline)[0]
    if (!previous) continue
    const cell = assignments.get(previous)
    if (/^[A-Z]/.test(item.text.trim())) {
      const line = items
        .filter(
          (i) =>
            assignments.get(i) === cell &&
            Math.abs(i.baseline - previous.baseline) <= i.height * 0.35
        )
        .sort((a, b) => a.rect[0] - b.rect[0])
      if (
        !/\b(?:and|or)\s*$/i.test(line.map((i) => i.text).join(' ')) ||
        item.rect[0] - line[0].rect[0] < item.height * 0.5 ||
        item.rect[0] - line[0].rect[0] > item.height * 1.5 ||
        rules.some(
          (r) =>
            r[1] === r[3] &&
            r[1] >= previous.baseline &&
            r[1] <= item.baseline &&
            r[0] <= line[0].rect[0] &&
            r[2] >= item.rect[2]
        )
      )
        continue
    }
    if (
      item.rect[2] > cell.rect[2] ||
      rules.some(
        (r) =>
          r[1] === r[3] &&
          r[1] >= previous.baseline &&
          r[1] <= item.rect[1] &&
          r[0] <= previous.rect[0] &&
          r[2] >= item.rect[2]
      ) ||
      items.some(
        (i) =>
          i !== previous &&
          columnOf(i) === 0 &&
          i.baseline > previous.baseline &&
          i.baseline < item.baseline - Math.max(i.height, item.height) * 0.6 &&
          assignments.get(i) !== cell
      )
    )
      continue
    cell.rect[3] = Math.max(cell.rect[3], item.rect[3])
    assignments.set(item, cell)
    extendedCells.add(cell)
    repairs.push('wrapped-row-label-recovered')
  }
  for (const item of items.filter((i) => !assignments.has(i) && i.horizontal)) {
    const matches = cells.filter((c) => intersect(c.rect, item.rect) / area(item.rect) > 0.5)
    if (matches.length === 1 && extendedCells.has(matches[0])) assignments.set(item, matches[0])
  }
  // Small raised/lowered fragments may straddle a predicted row boundary. Attach only to an
  // adjacent larger source token with an assigned cell in the same column, never by text content.
  const anchors = new Map()
  // Some manuscript fonts report a full em for a raised footnote glyph.
  // Require an adjoining statistical header and its independent note marker.
  const raisedHeaderMarkers = new Set()
  const isRaisedHeaderMarker = (item, anchor, cell) =>
    /^[a-z]$/.test(item.text) &&
    headerRows.includes(cell.row) &&
    /^(?:P|N\s*=\s*\d+)$/i.test(anchor.text.trim()) &&
    Math.abs(item.height - anchor.height) <= anchor.height * 0.02 &&
    Math.abs(item.rect[0] - anchor.rect[2]) <= anchor.height * 0.02 &&
    anchor.baseline - item.baseline > anchor.height * 0.5 &&
    anchor.baseline - item.baseline < anchor.height * 0.7 &&
    pageItems.some((note) => note !== item && note.text === item.text && note.rect[1] > bottom)
  for (const item of items.filter((i) => i.horizontal).sort((a, b) => b.height - a.height)) {
    const matches = items
      .filter((anchor) => {
        const cell = assignments.get(anchor)
        return (
          cell &&
          anchor.horizontal &&
          (isRaisedHeaderMarker(item, anchor, cell) || isAdjacentTableScript(item, anchor)) &&
          (item.rect[0] + item.rect[2]) / 2 >= cell.rect[0] &&
          (item.rect[0] + item.rect[2]) / 2 <= cell.rect[2]
        )
      })
      .sort((a, b) => Math.abs(item.rect[0] - a.rect[2]) - Math.abs(item.rect[0] - b.rect[2]))
    if (!matches.length) continue
    // Multiple plausible owners are unresolved even if the original box assignment looked clear.
    if (new Set(matches.map((anchor) => assignments.get(anchor))).size > 1) {
      assignments.delete(item)
      issues.add('ambiguous-script-anchor')
      continue
    }
    const anchor = matches[0]
    if (isRaisedHeaderMarker(item, anchor, assignments.get(anchor))) raisedHeaderMarkers.add(item)
    if (assignments.get(item) !== assignments.get(anchor))
      repairs.push('inline-fragment-reassigned')
    assignments.set(item, assignments.get(anchor))
    anchors.set(item, anchor)
  }
  // A multi-glyph exponent can be split across fonts (for example − and 1).
  // Continue an already anchored small script on the same baseline.
  for (const item of items
    .filter((i) => i.horizontal && !anchors.has(i))
    .sort((a, b) => a.rect[0] - b.rect[0])) {
    const previous = items.filter(
      (i) =>
        anchors.has(i) &&
        i.rect[2] <= item.rect[0] + 0.1 &&
        item.rect[0] - i.rect[2] < item.height * 0.6 &&
        Math.abs(i.height - item.height) < item.height * 0.1 &&
        Math.abs(i.baseline - item.baseline) < item.height * 0.2 &&
        i.height < anchors.get(i).height * 0.8
    )
    if (previous.length !== 1) continue
    anchors.set(item, anchors.get(previous[0]))
    assignments.set(item, assignments.get(previous[0]))
  }
  if ([...ambiguousAssignments].every((item) => assignments.has(item)))
    issues.delete('ambiguous-cell-assignment')
  if (
    items.length &&
    items.every((item) => {
      const cell = assignments.get(item)
      return cell && intersect(cell.rect, item.rect) / area(item.rect) > 0.8
    })
  )
    issues.delete('overlapping-predicted-columns')
  // A complete native record grid owns a verified token set. Padding may
  // contain the first raised footnote; leave it for review, not in a data cell.
  if (recordGrid?.ownedTokens)
    for (const item of assignments.keys())
      if (!recordGrid.ownedTokens.has(item)) assignments.delete(item)
  const unassigned = items.filter((item) => !assignments.has(item)).map((item) => item.text)
  for (const [item, cell] of assignments) cell.items.push(item)
  if (unassigned.length) issues.add('unassigned-source-text')
  for (const cell of cells) {
    const lines = []
    const lineOf = new Map()
    for (const item of cell.items
      .filter((item) => !anchors.has(item))
      .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
      let line = lines.find(
        (line) =>
          Math.abs(line[0].baseline - item.baseline) <= Math.max(line[0].height, item.height) * 0.35
      )
      if (!line) lines.push((line = []))
      line.push(item)
      lineOf.set(item, line)
    }
    for (const item of cell.items.filter((item) => anchors.has(item))) {
      // Resolve nested scripts to their text line. Equal-height repaired symbols
      // only anchor to ordinary text, never to another repaired symbol.
      let anchor = anchors.get(item)
      while (anchors.has(anchor)) anchor = anchors.get(anchor)
      lineOf.get(anchor).push(item)
    }
    const runs = []
    const append = (text, position = 'normal') => {
      text = text.replace(/\s+/g, ' ')
      if (!runs.length || runs.at(-1).text.endsWith(' ')) text = text.trimStart()
      if (!text) return
      if (runs.at(-1)?.position === position) runs.at(-1).text += text
      else runs.push({ text, position })
    }
    for (const [lineIndex, line] of lines.entries()) {
      line.sort((a, b) => a.rect[0] - b.rect[0] || a.baseline - b.baseline)
      const previous = lines[lineIndex - 1]
      // Suppress only the space introduced by a tightly wrapped stub word.
      // Keep the source hyphen; numeric ranges and separate entries stay apart.
      const wrappedStub =
        previous &&
        cell.column === 0 &&
        cell.colSpan === 1 &&
        /[a-zA-Z][-\u2010\u2011]$/.test(previous.at(-1).text) &&
        /^[a-z]/.test(line[0].text) &&
        Math.abs(line[0].height - previous[0].height) <= previous[0].height * 0.2 &&
        line[0].baseline - previous[0].baseline <= previous[0].height * 1.6 &&
        Math.abs(line[0].rect[0] - previous[0].rect[0]) <= previous[0].height
      if (
        lineIndex &&
        !recordGrid?.joinedTokens?.has(line[0]) &&
        (!(recordGrid || rows[cell.row].hyphenatedStub || wrappedStub) ||
          !/[-\u2010\u2011]$/.test(runs.at(-1)?.text ?? ''))
      )
        append(' ')
      for (const [index, item] of line.entries()) {
        // Compact treatment schedules use smaller inter-word spaces than the
        // regular table grid. Preserve those gaps after source-backed recovery.
        if (
          index &&
          item.rect[0] - line[index - 1].rect[2] > item.height * (scheduleGrid ? 0.08 : 0.15)
        )
          append(' ')
        const anchor = anchors.get(item)
        // Equal-height math glyphs can have an intrinsic baseline offset. They
        // belong to the same text line but are not smaller superscript markers.
        const joinedIdentifier =
          index &&
          /^(?:hsa|mmu|rno)-miR-\d[\w-]*$/.test(
            line
              .map((i) => i.text)
              .join('')
              .replace(/\s/g, '')
          ) &&
          Math.abs(item.rect[0] - line[index - 1].rect[2]) < item.height * 0.08
        append(
          joinedIdentifier ? item.text.trimStart() : item.text,
          anchor && (item.height < anchor.height * 0.8 || raisedHeaderMarkers.has(item))
            ? item.baseline < anchor.baseline
              ? 'superscript'
              : 'subscript'
            : 'normal'
        )
      }
    }
    if (runs.length) runs.at(-1).text = runs.at(-1).text.trimEnd()
    cell.text = runs.map((run) => run.text).join('')
    if (runs.some((run) => run.position !== 'normal')) cell.textRuns = runs
    cell.sourceTokens = lines
      .flat()
      .map(({ text, rect, baseline, height }) => ({ text, rect, baseline, height }))
    cell.sourceRects = cell.items.map((i) => i.rect)
    delete cell.items
  }
  return unassigned
}
