/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { area, intersection as intersect, union } from './literature-pdf-page-geometry.mjs'
import { inside, isAdjacentTableScript } from './literature-pdf-table-geometry.mjs'
import { hasWitnessedLineEndHyphen, sourceWordSpellings } from './literature-pdf-caption-group.mjs'

const BACKSPACE = String.fromCharCode(8)

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
  rotatedContinuation = false,
  issues,
  repairs
}) {
  const columnOf = (item) => columnRects.findIndex((column) => inside(column, item))
  const assignments = new Map()
  const ambiguousAssignments = new Set()
  const numericContinuation = (text) =>
    /^[<>≤≥−+-]?(?:\d|\.\d)[\d\s.,()%±–—+/<>=-]*$/.test(text.trim())
  const sectionHeading = (text) => {
    const value = text.trim()
    return (
      value.length >= 12 &&
      /\p{L}/u.test(value) &&
      /\(/.test(value) &&
      /\d\s*[–−-]\s*\d/.test(value) &&
      !/[.!?]$/.test(value)
    )
  }
  for (const item of items) {
    const candidates = cells
      .map((cell) => ({ cell, overlap: intersect(cell.rect, item.rect) / area(item.rect) }))
      .filter((m) => m.overlap > 0.5)
      .sort((a, b) => b.overlap - a.overlap)
    if (!item.horizontal || !candidates.length) {
      continue
    }
    if (numericContinuation(item.text) && candidates.length) {
      const candidate = candidates[0].cell
      const column = candidate.column
      const previous = cells.find(
        (cell) => cell.row === candidate.row - 1 && cell.column === column
      )
      const previousAnchor =
        previous &&
        items
          .filter(
            (anchor) =>
              assignments.get(anchor) === previous &&
              anchor.rect[3] <= item.rect[1] + item.height * 0.4 &&
              /(?:\/|±)\s*$/.test(anchor.text.trim())
          )
          .sort((a, b) => b.baseline - a.baseline)[0]
      const futureStub = items.find(
        (stub) =>
          assignments.get(stub)?.row === candidate.row &&
          assignments.get(stub)?.column === 0 &&
          stub.baseline > item.baseline &&
          /\p{L}/u.test(stub.text)
      )
      const overlappingPrevious = candidates.find(({ cell }) => cell === previous)
      if (
        previousAnchor &&
        overlappingPrevious &&
        candidates[0].overlap - overlappingPrevious.overlap < 0.08 &&
        item.rect[1] - previousAnchor.rect[3] <= item.height * 2.5 &&
        (!futureStub || futureStub.rect[1] >= item.rect[3])
      ) {
        const row = rows[previous.row]
        const bottom = futureStub
          ? Math.min(item.rect[3] + 1, futureStub.rect[1] - 1)
          : item.rect[3] + 1
        row.rect[3] = Math.max(row.rect[3], bottom)
        for (const sibling of cells.filter((cell) => cell.row === previous.row))
          sibling.rect[3] = Math.max(sibling.rect[3], bottom)
        assignments.set(item, previous)
        ambiguousAssignments.add(item)
        continue
      }
    }
    if (candidates[1] && candidates[0].overlap - candidates[1].overlap < 0.1) {
      const preferred = candidates
        .filter(({ cell }) => {
          if (sectionHeading(item.text))
            return (
              cell.colSpan > 1 ||
              cells
                .filter((candidate) => candidate.row === cell.row)
                .every((candidate) => !candidate.items.length)
            )
          if (!numericContinuation(item.text) || cell.column <= 0) return false
          const sameRowAnchor = items.some(
            (anchor) =>
              anchor !== item &&
              assignments.get(anchor)?.row === cell.row &&
              assignments.get(anchor)?.column === cell.column &&
              anchor.rect[3] <= item.rect[1] + item.height * 0.4 &&
              /(?:\/|±)\s*$/.test(anchor.text.trim())
          )
          if (sameRowAnchor) return true
          const previousRowAnchor = items.some(
            (anchor) =>
              anchor !== item &&
              assignments.get(anchor)?.row === cell.row - 1 &&
              assignments.get(anchor)?.column === cell.column &&
              anchor.rect[3] <= item.rect[1] + item.height * 0.4 &&
              /(?:\/|±)\s*$/.test(anchor.text.trim())
          )
          return previousRowAnchor
        })
        .sort((a, b) => b.overlap - a.overlap)
      if (preferred.length) {
        assignments.set(item, preferred[0].cell)
        ambiguousAssignments.add(item)
        continue
      }
      issues.add('ambiguous-cell-assignment')
      ambiguousAssignments.add(item)
      continue
    }
    assignments.set(item, candidates[0].cell)
  }
  // Source-backed section spans can begin a few pixels below a wrapped label's
  // glyph box. Let only those explicit spans claim a descriptive heading when
  // the normal 50% overlap test would otherwise leave it unassigned.
  for (const item of items.filter(
    (candidate) =>
      !assignments.has(candidate) &&
      candidate.horizontal &&
      candidate.text.trim().length >= 18 &&
      /(?:well-being|subscale|score)/iu.test(candidate.text)
  )) {
    const match = cells
      .map((cell) => ({ cell, overlap: intersect(cell.rect, item.rect) / area(item.rect) }))
      .filter(
        ({ cell, overlap }) => cell.origin === 'source-section' && cell.colSpan > 1 && overlap > 0.2
      )
      .sort((a, b) => b.overlap - a.overlap)[0]
    if (!match) continue
    assignments.set(item, match.cell)
    match.cell.rect[1] = Math.min(match.cell.rect[1], item.rect[1])
    rows[match.cell.row].rect[1] = Math.min(rows[match.cell.row].rect[1], item.rect[1])
    repairs.push('statistical-section-label-recovered')
  }
  // A confidence interval may be split into three source baselines. The model
  // can place the closing token on the boundary between two overlapping rows;
  // an immediately preceding same-column token ending in `to` is stronger
  // evidence than the geometric overlap. Keep this recovery narrow so a
  // standalone negative value is never moved across a real record boundary.
  const intervalTail = (text) =>
    /^(?:[–−-]\s*\d[\d.,]*|to\s+[–−-]?\s*\d[\d.,]*)\)$/.test(text.trim())
  for (const item of items.filter(
    (candidate) => !assignments.has(candidate) && intervalTail(candidate.text)
  )) {
    const candidates = cells
      .map((cell) => ({ cell, overlap: intersect(cell.rect, item.rect) / area(item.rect) }))
      .filter(({ cell, overlap }) => cell.column > 0 && overlap > 0.2)
    let matches = candidates
      .map(({ cell }) => {
        const anchor = items
          .filter(
            (previous) =>
              assignments.get(previous) === cell &&
              previous.rect[3] <= item.rect[1] + item.height * 0.25 &&
              /\bto\s*$/u.test(previous.text.trim())
          )
          .sort((a, b) => b.baseline - a.baseline)[0]
        return { cell, anchor }
      })
      .filter(({ anchor }) => anchor)
      .sort((a, b) => b.anchor.baseline - a.anchor.baseline)
    if (!matches.length) {
      matches = cells
        .filter((cell) => cell.column > 0)
        .map((cell) => {
          const anchor = items
            .filter(
              (previous) =>
                assignments.get(previous) === cell &&
                previous.rect[3] <= item.rect[1] + item.height * 0.25 &&
                item.rect[1] - previous.rect[3] <= item.height * 1.2 &&
                /\bto\s*$/u.test(previous.text.trim())
            )
            .sort((a, b) => b.baseline - a.baseline)[0]
          return { cell, anchor }
        })
        .filter(({ anchor }) => anchor)
        .sort((a, b) => item.rect[1] - a.anchor.rect[3] - (item.rect[1] - b.anchor.rect[3]))
    }
    const match = matches[0]
    if (!match) continue
    const competing = matches.filter(({ cell }) => cell.row !== match.cell.row)
    if (
      competing.some(
        ({ anchor }) => Math.abs(anchor.baseline - match.anchor.baseline) < item.height * 0.35
      )
    )
      continue
    assignments.set(item, match.cell)
    const row = rows[match.cell.row]
    const bottom = item.rect[3] + 0.1
    row.rect[3] = Math.max(row.rect[3], bottom)
    for (const sibling of cells.filter((cell) => cell.row === match.cell.row))
      sibling.rect[3] = Math.max(sibling.rect[3], bottom)
    ambiguousAssignments.delete(item)
    repairs.push('confidence-interval-tail-recovered')
  }
  // Some statistical tables lose an entire time-point record from the model
  // grid while retaining a continuation fragment in the next model row. A
  // source baseline containing a T0/T1/T2 stub and several numeric peers can
  // be restored only when the target row is empty in column zero, follows the
  // preceding time-point row, and already owns the continuation fragment.
  const recordValue = (text) => /^(?:[<>≤≥−+-]?\d|\.\d)[\d\s.,()%±–—+/<>=-]*$/.test(text.trim())
  const recordGroups = []
  for (const item of items.filter(
    (candidate) => !assignments.has(candidate) && candidate.horizontal
  )) {
    const group = items.filter(
      (candidate) =>
        !assignments.has(candidate) &&
        candidate.horizontal &&
        Math.abs(candidate.baseline - item.baseline) <= item.height * 0.3
    )
    if (!recordGroups.some((existing) => existing.includes(item))) recordGroups.push(group)
  }
  for (const group of recordGroups) {
    const stub = group.find((item) => /^T[012](?:[a-z])?$/u.test(item.text.trim()))
    const values = group.filter((item) => columnOf(item) > 0 && recordValue(item.text))
    if (!stub || values.length < 3) continue
    const rowsByColumn = new Map()
    for (const item of [stub, ...values]) {
      const matches = cells
        .filter(
          (cell) =>
            cell.column === columnOf(item) &&
            intersect(cell.rect, item.rect) / area(item.rect) > 0.2
        )
        .map((cell) => cell.row)
      for (const row of matches) rowsByColumn.set(row, (rowsByColumn.get(row) ?? 0) + 1)
    }
    const targetRows = [...rowsByColumn.entries()]
      .filter(([, count]) => count >= Math.min(group.length, 4))
      .map(([row]) => row)
      .filter((row) => {
        const stubCell = cells.find((cell) => cell.row === row && cell.column === 0)
        const previousStubCell = cells.find((cell) => cell.row === row - 1 && cell.column === 0)
        const assignedStub =
          stubCell && [...assignments.entries()].some(([, cell]) => cell === stubCell)
        const previousText =
          previousStubCell &&
          items
            .filter((item) => assignments.get(item) === previousStubCell)
            .map((item) => item.text)
            .join('')
        const continuation = items.some(
          (item) =>
            assignments.get(item)?.row === row &&
            /(?:to|\bfrom)\s+[–−-]?\d[\d.]*\)$/u.test(item.text.trim())
        )
        return stubCell && !assignedStub && /^T[012]/u.test(previousText) && continuation
      })
    if (targetRows.length !== 1) continue
    const targetRow = targetRows[0]
    const targetCells = new Map(
      cells.filter((cell) => cell.row === targetRow).map((cell) => [cell.column, cell])
    )
    const targetTop = Math.min(...group.map((item) => item.rect[1]))
    const row = rows[targetRow]
    row.rect[1] = Math.min(row.rect[1], targetTop)
    for (const cell of targetCells.values()) cell.rect[1] = Math.min(cell.rect[1], targetTop)
    const previousRow = rows[targetRow - 1]
    const previousItems = previousRow
      ? items.filter((item) => assignments.get(item)?.row === targetRow - 1)
      : []
    if (previousRow && previousItems.length) {
      const boundary = (Math.max(...previousItems.map((item) => item.rect[3])) + targetTop) / 2
      previousRow.rect[3] = Math.min(previousRow.rect[3], boundary)
      for (const cell of cells.filter((candidate) => candidate.row === targetRow - 1))
        cell.rect[3] = Math.min(cell.rect[3], boundary)
    }
    for (const item of group) {
      const cell = targetCells.get(columnOf(item))
      if (!cell || intersect(cell.rect, item.rect) / area(item.rect) <= 0.05) continue
      assignments.set(item, cell)
      ambiguousAssignments.delete(item)
    }
    repairs.push('complete-statistical-record-recovered')
  }
  // Statistical glyphs can straddle a narrow empty model row beside the
  // section row that owns the statistic. Defer only math/stat fragments and
  // use the already populated row context to choose the owner.
  const deferredStatFragments = [...ambiguousAssignments].filter(
    (item) => !assignments.has(item) && /^(?:χ|\(|df|\)|=)/u.test(item.text.trim())
  )
  for (const item of deferredStatFragments) {
    const candidates = cells
      .map((cell) => ({ cell, overlap: intersect(cell.rect, item.rect) / area(item.rect) }))
      .filter((match) => match.overlap > 0.5)
    if (candidates.length < 2) continue
    const score = (cell) =>
      [...assignments.values()].filter((assigned) => assigned.row === cell.row).length
    const ranked = candidates
      .map((match) => ({ ...match, score: score(match.cell) }))
      .sort((a, b) => b.score - a.score || b.overlap - a.overlap)
    const best = ranked[0]
    const next = ranked[1]
    if (!best || best.score <= 0 || (next && best.score === next.score)) continue
    assignments.set(item, best.cell)
    repairs.push('statistical-fragment-reassigned')
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
  // A final narrative cell can continue below the model's last row. Require a
  // native closing rule, an already owned prefix and uninterrupted, aligned
  // lowercase continuations in the same column. A new record or a note below
  // the rule cannot extend this cell.
  const lastRow = rows.at(-1)
  if (lastRow && columnRects.length) {
    const closing = rules
      .filter(
        (r) =>
          r[1] === r[3] &&
          r[1] > lastRow.rect[3] &&
          r[1] <= bottom &&
          Math.abs(r[0] - columnRects[0][0]) < 16 &&
          Math.abs(r[2] - columnRects.at(-1)[2]) < 16
      )
      .sort((a, b) => a[1] - b[1])[0]
    const tails =
      closing &&
      items
        .filter(
          (i) =>
            i.horizontal && i.rect[1] >= lastRow.rect[3] - i.height * 0.1 && i.rect[3] < closing[1]
        )
        .sort((a, b) => a.baseline - b.baseline)
    if (tails?.length && tails.length <= 5) {
      const pending = new Map()
      for (const item of tails) {
        const previous = items
          .filter((anchor) => {
            const cell = pending.get(anchor) ?? assignments.get(anchor)
            return (
              cell?.row === rows.length - 1 &&
              cell.column > 0 &&
              /\p{L}/u.test(anchor.text) &&
              !/[.!?]$/u.test(anchor.text.trim()) &&
              item.rect[0] >= anchor.rect[0] - item.height * 0.1 &&
              item.rect[0] - anchor.rect[0] <= item.height * 1.05 &&
              Math.abs(anchor.height - item.height) < item.height * 0.1 &&
              item.baseline - anchor.baseline > item.height * 0.8 &&
              item.baseline - anchor.baseline < item.height * 1.7 &&
              item.rect[2] <= columnRects[cell.column][2] + item.height * 0.5
            )
          })
          .sort((a, b) => b.baseline - a.baseline)[0]
        if (assignments.has(item) || !/^[a-z]/u.test(item.text) || !previous) break
        pending.set(item, pending.get(previous) ?? assignments.get(previous))
      }
      if (pending.size === tails.length) {
        for (const [item, cell] of pending) {
          assignments.set(item, cell)
          cell.rect[3] = Math.max(cell.rect[3], item.rect[3])
        }
        lastRow.rect[3] = Math.max(lastRow.rect[3], ...tails.map((i) => i.rect[3]))
        repairs.push('wrapped-row-label-recovered')
      }
    }
  }
  // Small raised/lowered fragments may straddle a predicted row boundary. Attach only to an
  // adjacent larger source token with an assigned cell in the same column, never by text content.
  const anchors = new Map()
  // A predicted boundary may cut through a header or a footnoted body label.
  // Tight native adjacency can override that boundary, never a source rule.
  const crossesScriptBoundary = (item, anchor, cell) =>
    (headerRows.includes(cell.row) ||
      (/\p{L}/u.test(anchor.text) &&
        pageItems.some(
          (note) => note !== item && note.text === item.text && note.rect[1] > bottom
        ))) &&
    /^[a-zA-Z*†‡]$/.test(item.text) &&
    item.height < anchor.height * 0.8 &&
    item.baseline < anchor.baseline &&
    isAdjacentTableScript(item, anchor) &&
    Math.abs(item.rect[0] - anchor.rect[2]) < anchor.height * 0.1 &&
    item.rect[2] <= cell.rect[2] + anchor.height &&
    !rules.some(
      (r) =>
        r[0] === r[2] &&
        r[0] >= Math.min(cell.rect[2], anchor.rect[2]) &&
        r[0] <= item.rect[2] &&
        r[1] < anchor.baseline &&
        r[3] > item.rect[1]
    )
  // Some manuscript fonts report a full em for a raised footnote glyph.
  // Require an adjoining label and its independent note marker below the table.
  const raisedNoteMarkers = new Set()
  const letterNotes = new Set(
    items
      .filter(
        (item) =>
          /^[a-z]$/.test(item.text) &&
          pageItems.some(
            (note) => note !== item && note.text === item.text && note.rect[1] > bottom
          )
      )
      .map((item) => item.text)
  )
  const isRaisedNoteMarker = (item, anchor, cell) =>
    ((/^[a-z]$/.test(item.text) &&
      headerRows.includes(cell.row) &&
      /^(?:P|N\s*=\s*\d+)$/i.test(anchor.text.trim()) &&
      Math.abs(item.height - anchor.height) <= anchor.height * 0.02 &&
      Math.abs(item.rect[0] - anchor.rect[2]) <= anchor.height * 0.02) ||
      ((/^[†‡]$/.test(item.text) || (/^[a-z]$/.test(item.text) && letterNotes.size >= 2)) &&
        /\p{L}/u.test(anchor.text) &&
        item.height >= anchor.height * 0.8 &&
        item.height <= anchor.height * 1.1 &&
        item.rect[0] >= anchor.rect[2] &&
        item.rect[0] - anchor.rect[2] <= anchor.height * 0.35)) &&
    anchor.baseline - item.baseline > anchor.height * 0.5 &&
    anchor.baseline - item.baseline < anchor.height * 0.7 &&
    pageItems.some((note) => note !== item && note.text === item.text && note.rect[1] > bottom)
  // An author may print a third raised marker without its own note. A matching
  // dagger pair establishes the font's raised-marker geometry; keep the glyph.
  const raisedSymbols = items.filter(
    (item) =>
      /^[†‡]$/.test(item.text) &&
      items.some(
        (anchor) =>
          assignments.has(anchor) && isRaisedNoteMarker(item, anchor, assignments.get(anchor))
      )
  )
  const isRepeatedRaisedSymbol = (item, anchor, cell) =>
    item.text === '¥' &&
    cell.column === 0 &&
    /\p{L}/u.test(anchor.text) &&
    new Set(raisedSymbols.map((symbol) => symbol.text)).size === 2 &&
    item.rect[0] >= anchor.rect[2] &&
    item.rect[0] - anchor.rect[2] <= anchor.height * 0.35 &&
    raisedSymbols.every((symbol) => {
      const owner = items.find(
        (candidate) =>
          assignments.has(candidate) &&
          isRaisedNoteMarker(symbol, candidate, assignments.get(candidate))
      )
      return (
        Math.abs(symbol.height - item.height) < anchor.height * 0.02 &&
        Math.abs(owner.height - anchor.height) < anchor.height * 0.02 &&
        Math.abs(owner.baseline - symbol.baseline - (anchor.baseline - item.baseline)) <
          anchor.height * 0.02
      )
    })
  for (const item of items.filter((i) => i.horizontal).sort((a, b) => b.height - a.height)) {
    const matches = items
      .filter((anchor) => {
        const cell = assignments.get(anchor)
        return (
          cell &&
          anchor.horizontal &&
          (isRaisedNoteMarker(item, anchor, cell) ||
            isRepeatedRaisedSymbol(item, anchor, cell) ||
            isAdjacentTableScript(item, anchor)) &&
          (item.rect[0] + item.rect[2]) / 2 >= cell.rect[0] &&
          ((item.rect[0] + item.rect[2]) / 2 <= cell.rect[2] ||
            crossesScriptBoundary(item, anchor, cell))
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
    if (
      isRaisedNoteMarker(item, anchor, assignments.get(anchor)) ||
      isRepeatedRaisedSymbol(item, anchor, assignments.get(anchor))
    )
      raisedNoteMarkers.add(item)
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
    // Several adjacent fragments (a comma and the preceding letter, for
    // example) can all belong to the same script. Only conflicting anchors
    // are ambiguous; counting fragments would strand the final glyph.
    if (!previous.length || new Set(previous.map((i) => anchors.get(i))).size !== 1) continue
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
    for (const item of assignments.keys()) {
      const anchor = anchors.get(item)
      // Native row grouping can omit a raised header marker. Preserve the
      // independently verified adjacent script with its owned source anchor.
      if (
        !recordGrid.ownedTokens.has(item) &&
        !(anchor && recordGrid.ownedTokens.has(anchor) && isAdjacentTableScript(item, anchor))
      )
        assignments.delete(item)
    }
  // A footnote marker can share the same digit as a unit exponent. Native
  // record ownership intentionally drops the repeated marker, but the
  // adjacent small glyph is still part of the label (for example `mL−1`).
  // Reattach only a single digit immediately following an already anchored
  // mathematical sign; ordinary data values and standalone notes remain out.
  if (recordGrid?.ownedTokens) {
    for (const item of items.filter((candidate) => !assignments.has(candidate))) {
      if (!/^\d$/u.test(item.text)) continue
      const continuation = items
        .filter(
          (candidate) =>
            assignments.has(candidate) &&
            anchors.has(candidate) &&
            /^[−+±]$/u.test(candidate.text) &&
            candidate.rect[2] <= item.rect[0] + 0.2 &&
            item.rect[0] - candidate.rect[2] <= item.height * 0.6 &&
            Math.abs(candidate.baseline - item.baseline) <= item.height * 0.2 &&
            Math.abs(candidate.height - item.height) <= item.height * 0.25
        )
        .sort((a, b) => b.rect[2] - a.rect[2])[0]
      if (!continuation) continue
      assignments.set(item, assignments.get(continuation))
      anchors.set(item, continuation)
      repairs.push('multi-glyph-script-recovered')
    }
  }
  // A captionless continuation can be rasterized upright only after the page
  // is rotated. Its source boxes may still straddle two predicted columns by
  // a fraction of a glyph, leaving otherwise unambiguous numeric fragments
  // detached. Recover this bounded shape from the source centerline: require
  // a dense rectangular body and repeated numeric rows. Narrative text and
  // merged headers remain diagnostic; this path is limited to rotated pages.
  const continuationRows = rows.filter((row, index) => !headerRows.includes(index))
  const numericRows = continuationRows.filter((row) => {
    const source = items.filter(
      (item) =>
        item.horizontal &&
        intersect(row.rect, item.rect) / area(item.rect) > 0.5 &&
        /\d/.test(item.text)
    )
    return source.length >= 3
  })
  const denseUnmergedContinuation =
    rotatedContinuation &&
    !recordGrid &&
    continuationRows.length >= 8 &&
    columnRects.length >= 6 &&
    numericRows.length >= 5 &&
    cells.length >= continuationRows.length * columnRects.length * 0.5
  if (denseUnmergedContinuation) {
    const bodyRows = rows.map((row, rowIndex) => ({ row, rowIndex }))
    const sourceColumn = (item) => {
      const center = (item.rect[0] + item.rect[2]) / 2
      return columnRects.findIndex((column) => center >= column[0] && center <= column[2])
    }
    const sourceRow = (item) => {
      const center = (item.rect[1] + item.rect[3]) / 2
      return bodyRows.find(({ row }) => center >= row.rect[1] && center <= row.rect[3])?.row
    }
    const recoverable = items.filter(
      (item) =>
        !assignments.has(item) &&
        item.horizontal &&
        item.text.trim().length <= 36 &&
        (/\d/.test(item.text) ||
          /^[−+-]$/u.test(item.text.trim()) ||
          /^\p{L}[\p{L}\s-]{2,}$/u.test(item.text.trim()))
    )
    const recovered = []
    for (const item of recoverable) {
      const row = sourceRow(item)
      const column = sourceColumn(item)
      if (!row || column < 0) continue
      const cell = cells.find(
        (candidate) => candidate.row === rows.indexOf(row) && candidate.column === column
      )
      if (!cell) continue
      assignments.set(item, cell)
      recovered.push(item)
    }
    if (recovered.length) repairs.push('rotated-continuation-source-column-recovered')
  }
  // A confidence-interval tail can be split exactly at a predicted boundary
  // when the minus sign is a separate glyph. If the preceding cell already
  // ends in `to`, move the short numeric tail back into that interval cell.
  for (const row of rows) {
    for (let column = 1; column < columnRects.length; column++) {
      const previous = cells.find(
        (cell) => cell.row === rows.indexOf(row) && cell.column === column - 1
      )
      const current = cells.find((cell) => cell.row === rows.indexOf(row) && cell.column === column)
      if (!previous || !current) continue
      const priorItems = items
        .filter((item) => assignments.get(item) === previous)
        .sort((a, b) => a.rect[0] - b.rect[0])
      const currentItems = items
        .filter((item) => assignments.get(item) === current)
        .sort((a, b) => a.rect[0] - b.rect[0])
      if (
        !/\bto\s*$/u.test(
          priorItems
            .map((item) => item.text)
            .join('')
            .trim()
        )
      )
        continue
      let moving = true
      for (const item of currentItems) {
        if (
          moving &&
          (/^[−+-]$/u.test(item.text.trim()) || /^\d[\d.,]*\)?$/u.test(item.text.trim()))
        ) {
          assignments.set(item, previous)
          repairs.push('rotated-continuation-interval-tail-recovered')
          if (/\)$/.test(item.text.trim())) moving = false
        } else moving = false
      }
    }
  }

  // A repaired comparison glyph can straddle the predicted cut before a narrow
  // numeric column. Its close right operand and a larger left gap establish
  // prefix ownership; native vertical borders still take precedence.
  for (const operator of items.filter(
    (i) => i.inlineSymbol && /^[<>≤≥]$/.test(i.text) && !anchors.has(i)
  )) {
    const owner = assignments.get(operator)
    if (!owner || owner.rowSpan !== 1 || headerRows.includes(owner.row)) continue
    const candidates = items.filter(
      (i) =>
        i !== operator &&
        !i.inlineSymbol &&
        /^\d*(?:\.\d+)?$/.test(i.text.trim()) &&
        /\d/.test(i.text) &&
        Math.abs(i.baseline - operator.baseline) < operator.height * 0.2 &&
        i.rect[0] >= operator.rect[2] &&
        i.rect[0] - operator.rect[2] <= operator.height * 0.4 &&
        assignments.get(i)?.row === owner.row &&
        assignments.get(i)?.column === owner.column + owner.colSpan
    )
    if (candidates.length !== 1) continue
    const operand = candidates[0],
      target = assignments.get(operand),
      gap = operand.rect[0] - operator.rect[2]
    const left = items.filter(
      (i) =>
        i !== operator &&
        assignments.get(i) === owner &&
        Math.abs(i.baseline - operator.baseline) < operator.height * 0.2 &&
        i.rect[2] <= operator.rect[0]
    )
    if (
      !left.length ||
      operator.rect[0] - Math.max(...left.map((i) => i.rect[2])) <= gap + operator.height * 0.25 ||
      rules.some(
        (r) =>
          r[0] === r[2] &&
          r[0] >= operator.rect[2] &&
          r[0] <= operand.rect[0] &&
          r[1] < operator.baseline &&
          r[3] > operator.rect[1]
      )
    )
      continue
    assignments.set(operator, target)
    repairs.push('inline-fragment-reassigned')
  }
  const unassignedItems = items.filter((item) => !assignments.has(item))
  for (const [item, cell] of assignments) cell.items.push(item)
  if (unassignedItems.length) issues.add('unassigned-source-text')
  const pageWords = sourceWordSpellings(
    pageItems.filter((item) => item.horizontal).map((item) => item.text)
  )
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
    // Only a single continuous URL can join across wrapped lines. Require
    // source-aligned lines and URL separators at every wrap; preserve hyphens.
    const urlLines = lines.map((line) => line.slice().sort((a, b) => a.rect[0] - b.rect[0]))
    const urlText = urlLines.map((line) =>
      line
        .map((item) => item.text)
        .join('')
        .trim()
    )
    const joinedUrl =
      urlLines.length > 1 &&
      /^https?:\/\/[^/\s]+\//.test(urlText[0]) &&
      urlText.every(
        (text, index) =>
          /^[^\s<>"']+$/.test(text) &&
          (!index || (!/^https?:/i.test(text) && /[/._?&=#%~-]$/.test(urlText[index - 1])))
      ) &&
      urlLines.every(
        (line, index) =>
          line.every(
            (item, n) =>
              Math.abs(item.height - urlLines[0][0].height) < item.height * 0.15 &&
              (!n || item.rect[0] - line[n - 1].rect[2] < item.height * 0.6)
          ) &&
          (!index ||
            (Math.abs(line[0].rect[0] - urlLines[0][0].rect[0]) < line[0].height &&
              line[0].baseline - urlLines[index - 1][0].baseline < line[0].height * 1.8))
      )
    const runs = []
    const append = (text, position = 'normal') => {
      text = text.split(BACKSPACE).join(' ').replace(/\s+/g, ' ')
      if (!runs.length || runs.at(-1).text.endsWith(' ')) text = text.trimStart()
      if (!text) return
      if (runs.at(-1)?.position === position) runs.at(-1).text += text
      else runs.push({ text, position })
    }
    for (const [lineIndex, line] of lines.entries()) {
      line.sort((a, b) => a.rect[0] - b.rect[0] || a.baseline - b.baseline)
      const previous = lines[lineIndex - 1]
      // Reflow only tightly aligned lines owned by this cell, including a
      // separate terminal hyphen glyph. A source spelling is required to remove
      // the hyphen itself; otherwise preserve it without an inserted space.
      const wrappedWord =
        previous &&
        /\p{L}[-\u2010\u2011]$/u.test(previous.map((item) => item.text).join('')) &&
        /^\p{Ll}/u.test(line[0].text) &&
        (previous.length < 2 ||
          previous.at(-1).rect[0] - previous.at(-2).rect[2] <= previous[0].height * 0.25) &&
        !anchors.has(previous.at(-1)) &&
        !anchors.has(line[0]) &&
        Math.abs(previous.at(-1).height - previous[0].height) <= previous[0].height * 0.2 &&
        Math.abs(line[0].height - previous[0].height) <= previous[0].height * 0.2 &&
        line[0].baseline - previous[0].baseline <= previous[0].height * 1.6 &&
        Math.abs(line[0].rect[0] - previous[0].rect[0]) <= previous[0].height &&
        !rules.some(
          (rule) =>
            rule[1] === rule[3] &&
            rule[1] > previous[0].baseline &&
            rule[1] < line[0].baseline &&
            rule[0] < cell.rect[2] &&
            rule[2] > cell.rect[0]
        )
      if (
        wrappedWord &&
        !joinedUrl &&
        runs.at(-1)?.position === 'normal' &&
        hasWitnessedLineEndHyphen(runs.at(-1).text, line[0].text, pageWords)
      )
        runs.at(-1).text = runs.at(-1).text.slice(0, -1)
      if (
        lineIndex &&
        !joinedUrl &&
        !recordGrid?.joinedTokens?.has(line[0]) &&
        !wrappedWord &&
        (!(recordGrid || rows[cell.row].hyphenatedStub) ||
          !/[-\u2010\u2011]$/.test(runs.at(-1)?.text ?? ''))
      )
        if (/^[•⋄]$/.test(line[0].text) && lines.some((l) => /^[•⋄]$/.test(l[0].text))) {
          if (runs.at(-1)?.position === 'normal') runs.at(-1).text += '\n'
          else runs.push({ text: '\n', position: 'normal' })
        } else append(' ')
      for (const [index, item] of line.entries()) {
        // Compact count schedules use smaller inter-word spaces than the
        // regular table grid. Preserve those gaps after source-backed recovery.
        const gap = index ? item.rect[0] - line[index - 1].rect[2] : 0
        const prefixBeforeEquals = index
          ? line
              .slice(0, index - 1)
              .map((entry) => entry.text)
              .join('')
              .trim()
          : ''
        const tightSampleSize =
          index &&
          /=$/.test(line[index - 1].text) &&
          /^\d/u.test(item.text) &&
          /\(\s*[nN]$|,\s*n$/u.test(prefixBeforeEquals) &&
          gap <= item.height * 0.13
        if (
          index &&
          !joinedUrl &&
          ((!tightSampleSize &&
            item.rect[0] - line[index - 1].rect[2] > item.height * (scheduleGrid ? 0.08 : 0.15)) ||
            (/=$/.test(line[index - 1].text) &&
              prefixBeforeEquals === '(n' &&
              /^\d/u.test(item.text) &&
              gap > item.height * 0.08 &&
              gap <= item.height * 0.11))
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
          anchor &&
            (item.height < anchor.height * 0.8 ||
              (/^[a-z]$/.test(item.text) && item.height < anchor.height * 0.9) ||
              raisedNoteMarkers.has(item))
            ? item.baseline < anchor.baseline
              ? 'superscript'
              : 'subscript'
            : 'normal'
        )
      }
    }
    if (runs.length) runs.at(-1).text = runs.at(-1).text.trimEnd()
    // A superscript sign and its following digit can be emitted by different
    // PDF fonts. If the digit was kept in the source cell but did not join the
    // model script run, restore it only when the glyph boxes form one compact
    // exponent. This preserves labels such as `ng mL−1` beside footnote `1`.
    for (const sign of cell.items.filter((item) => /^[−+±]$/u.test(item.text))) {
      const digit = cell.items
        .filter(
          (item) =>
            /^\d$/u.test(item.text) &&
            item.rect[0] >= sign.rect[2] - 0.2 &&
            item.rect[0] - sign.rect[2] <= item.height * 0.6 &&
            Math.abs(item.baseline - sign.baseline) <= item.height * 0.2 &&
            Math.abs(item.height - sign.height) <= item.height * 0.25
        )
        .sort((a, b) => a.rect[0] - b.rect[0])[0]
      const run = runs.find(
        (candidate) => candidate.position === 'superscript' && candidate.text.endsWith(sign.text)
      )
      if (digit && !anchors.has(digit) && run && !run.text.endsWith(digit.text)) {
        run.text += digit.text
        repairs.push('multi-glyph-script-recovered')
      }
    }
    cell.text = runs.map((run) => run.text).join('')
    if (runs.some((run) => run.position !== 'normal')) cell.textRuns = runs
    cell.sourceTokens = lines
      .flat()
      .map(({ text, rect, baseline, height }) => ({ text, rect, baseline, height }))
    cell.sourceRects = cell.items.map((i) => i.rect)
    delete cell.items
  }
  // Ownership comes from the source-token assignments above. An overlapping
  // cell with equal text (or a matching substring) cannot account for a
  // different token that never acquired an owner.
  const unassigned = unassignedItems
    .filter((item) => item.text.split(BACKSPACE).join('').trim())
    .map((item) => item.text)
  if (!unassigned.length) issues.delete('unassigned-source-text')
  return unassigned
}

// A low-resolution model can split a repeated count header at the column
// boundary between its label and printed sample size. The child row remains a
// repeated `n / (%)` pair, so two or more adjacent pairs provide enough
// evidence to restore the parent spans without relying on proximity alone.
export function reconcileFragmentedCountHeaders({ cells, issues, repairs }) {
  const text = (cell) => cell?.text?.trim() ?? ''
  const parse = (first, second) => {
    const left = text(first),
      right = text(second)
    // Complete count headers such as `Total (n=124)` already have valid source
    // text and must not be reformatted merely because a model cell touches it.
    if (left !== '(n') return undefined
    const trailing = right.match(/^([\p{L}][\p{L}\d ./'’+-]*?)\s*=\s*(\d+)\s*\)$/u)
    return trailing ? `${trailing[1].trim()} (n = ${trailing[2]})` : undefined
  }
  const childIsCount = (cell) => /^n$/iu.test(text(cell))
  const childIsPercent = (cell) => /^\(\s*%\s*\)$/u.test(text(cell))
  const bySlot = (row, column) =>
    cells.find((cell) => cell.row === row && cell.column === column && cell.rowSpan === 1)
  const candidates = []
  const width = Math.max(-1, ...cells.filter((cell) => cell.row === 0).map((cell) => cell.column))
  for (let start = 0; start < width; start++) {
    const first = bySlot(0, start),
      second = bySlot(0, start + 1),
      childFirst = bySlot(1, start),
      childSecond = bySlot(1, start + 1)
    if (!first || !second || !childFirst || !childSecond) continue
    const heading = parse(first, second)
    if (!heading || !childIsCount(childFirst) || !childIsPercent(childSecond)) continue
    candidates.push({ first, second, heading })
  }
  if (candidates.length < 2) return 0
  candidates.sort((a, b) => a.first.column - b.first.column)
  if (
    candidates.some(
      (candidate, index) =>
        index && candidate.first.column !== candidates[index - 1].second.column + 1
    )
  )
    return 0
  const removed = new Set(candidates.flatMap(({ first, second }) => [first, second]))
  const merged = candidates.map(({ first, second, heading }) => ({
    ...first,
    colSpan: 2,
    origin: 'ruled-header-span',
    rect: union([first.rect, second.rect]),
    text: heading,
    sourceTokens: [...(first.sourceTokens ?? []), ...(second.sourceTokens ?? [])],
    sourceRects: [...(first.sourceRects ?? []), ...(second.sourceRects ?? [])]
  }))
  cells.splice(0, cells.length, ...cells.filter((cell) => !removed.has(cell)), ...merged)
  cells.sort((a, b) => a.row - b.row || a.column - b.column)
  // Keep the existing repair label for cached structure compatibility; the
  // recovery itself is generic across repeated count headers.
  repairs.push('fragmented-treatment-header-reconciled')
  if (!issues.has('span-conflicts-with-source-rows') && !issues.has('conflicting-spanning-cells'))
    issues.delete('span-conflicts-with-source-columns')
  return merged.length
}
