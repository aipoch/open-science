/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { area, intersection as intersect } from './literature-pdf-page-geometry.mjs'
import { inside, union, isAdjacentTableScript } from './literature-pdf-table-geometry.mjs'

// Validate all proposals against source text before resolving overlaps. Slot identity
// is preserved; issues and repairs are appended to the caller's existing diagnostics.
export function resolveTableCellMerges({
  proposals,
  baseCells,
  items,
  rows,
  headerRows,
  headerRuns,
  rules,
  recordGrid,
  populatedColumns,
  issues,
  repairs
}) {
  if (!recordGrid?.completeSpans) {
    recoverCountPairSummaries({ proposals, baseCells, items, rows, rules, repairs })
    recoverRepeatedArmHeaders({ proposals, baseCells, items, rows, rules, repairs })
    recoverFollowupStubSpans({ proposals, baseCells, items, rows, rules, repairs })
    recoverClosedStatisticSpans({ proposals, baseCells, items, rows, rules, repairs })
  }
  const center = (item) => (item.rect[0] + item.rect[2]) / 2
  const unique = proposals.filter(
    (p, i) =>
      !proposals
        .slice(0, i)
        .some((q) => q.slots.length === p.slots.length && p.slots.every((s) => q.slots.includes(s)))
  )
  // Discard source-contradicted alternatives before resolving overlaps. Otherwise
  // one invalid prediction also destroys a valid horizontal or vertical merge.
  const supported = unique.filter((p) => {
    const rs = p.slots.map((s) => s.row),
      cs = p.slots.map((s) => s.column)
    const row = Math.min(...rs),
      column = Math.min(...cs),
      rowSpan = Math.max(...rs) - row + 1,
      colSpan = Math.max(...cs) - column + 1
    const spanRect = union(p.slots)
    const spanText = items
      .filter((item) => item.horizontal && intersect(spanRect, item.rect) / area(item.rect) > 0.8)
      .sort((a, b) => a.baseline - b.baseline)
    const textRect = spanText.length ? union(spanText) : undefined
    const touchingText = items.filter((i) => intersect(spanRect, i.rect) / area(i.rect) > 0.4)
    if (
      rowSpan === 1 &&
      colSpan > 1 &&
      touchingText.some((i) => /^(?:Mean|Median)$/.test(i.text)) &&
      touchingText.filter((i) => i.text === '±').length >= 3
    )
      return false
    // Text placement uses glyph centers. A row edge can cut off the glyph top
    // while independent column values still belong to this row. Reject that
    // numeric model merge using the same ownership rule as text placement.
    if (
      p.origin === 'model-span' &&
      row > 0 &&
      rowSpan === 1 &&
      colSpan > 1 &&
      !headerRows.includes(row)
    ) {
      const owned = touchingText.filter((item) => inside(spanRect, item))
      // Attached scripts belong to the anchor's line. They must not prevent
      // independent body values (for example chi-square and P) from rejecting
      // a predicted horizontal merge. Keep detached or cross-column glyphs.
      const baselineItems = owned.filter(
        (item) =>
          !owned.some(
            (anchor) =>
              isAdjacentTableScript(item, anchor) &&
              p.slots.some((slot) => inside(slot.rect, item) && inside(slot.rect, anchor))
          )
      )
      const values = baselineItems.filter((item) =>
        /^[<>≤≥−+-]?\d[\d.,]*(?:\s*\([\d.%]+\))?$/.test(item.text)
      )
      if (
        baselineItems.every(
          (item) => Math.abs(item.baseline - baselineItems[0].baseline) < item.height * 0.35
        ) &&
        values.some((value) =>
          baselineItems.some(
            (label) =>
              /\p{L}/u.test(label.text) &&
              Math.abs(value.baseline - label.baseline) < value.height * 0.35 &&
              value.rect[0] - label.rect[2] > value.height * 2 &&
              p.slots.some((slot) => inside(slot.rect, label) && !inside(slot.rect, value))
          )
        )
      ) {
        issues.add('span-conflicts-with-source-columns')
        return false
      }
    }
    const sampleTail = spanText.filter(
      (item) => item.baseline > (spanText[0]?.baseline ?? 0) + item.height * 0.6
    )
    const sampleTitle = spanText.filter((item) => !sampleTail.includes(item))
    const wrappedSampleHeader =
      p.origin === 'model-span' &&
      rowSpan === 1 &&
      colSpan > 1 &&
      headerRows.includes(row) &&
      sampleTitle.some((item) => /\p{L}/u.test(item.text)) &&
      sampleTail.length > 0 &&
      /^\(n=\d+\)$/i.test(
        sampleTail
          .slice()
          .sort((a, b) => a.rect[0] - b.rect[0])
          .map((item) => item.text)
          .join('')
          .replace(/\s/g, '')
      ) &&
      sampleTail.every(
        (item) => Math.abs(item.baseline - sampleTail[0].baseline) < item.height * 0.35
      ) &&
      union(sampleTail)[1] >= union(sampleTitle)[3] &&
      union(sampleTail)[1] - union(sampleTitle)[3] <=
        Math.max(...sampleTitle.map((i) => i.height)) &&
      Math.abs(center({ rect: union(sampleTail) }) - center({ rect: union(sampleTitle) })) <=
        sampleTail[0].height * 0.5 &&
      p.slots.every((slot) => populatedColumns(row + 1).includes(slot.column)) &&
      rules.some(
        (r) =>
          r[1] === r[3] &&
          r[1] >= textRect[3] &&
          r[1] <= rows[row + 1].rect[3] &&
          r[0] <= textRect[0] &&
          r[2] >= textRect[2]
      )
    const units = spanText.filter((i) => i.baseline > (spanText[0]?.baseline ?? 0) + i.height * 0.6)
    const wrappedHeaderUnits =
      p.origin === 'model-span' &&
      row === 0 &&
      column === 0 &&
      rowSpan === 2 &&
      colSpan === 1 &&
      headerRows.includes(0) &&
      headerRows.includes(1) &&
      /^\p{L}/u.test(spanText[0]?.text ?? '') &&
      units.length > 0 &&
      /^\([\p{L}\d\s/%µμ²³.^−+-]+\)$/u.test(
        units
          .sort((a, b) => a.rect[0] - b.rect[0])
          .map((i) => i.text)
          .join('')
      ) &&
      textRect[3] - textRect[1] <= Math.max(...spanText.map((i) => i.height)) * 3
    // A short centered wrapped label may cross a row boundary inside a valid
    // model rowspan. Independent records distributed over the rows still fail.
    const wrappedRowLabel =
      column === 0 &&
      spanText.every((item) => /\p{L}/u.test(item.text)) &&
      rowSpan > 1 &&
      colSpan === 1 &&
      spanText.length > 1 &&
      textRect &&
      textRect[3] - textRect[1] <= Math.min(...p.slots.map((s) => s.rect[3] - s.rect[1])) &&
      Math.abs(textRect[1] + textRect[3] - spanRect[1] - spanRect[3]) <=
        (textRect[3] - textRect[1]) * 0.5 &&
      spanText.every(
        (item, i) =>
          !i ||
          (item.baseline - spanText[i - 1].baseline <=
            Math.max(item.height, spanText[i - 1].height) * 1.5 &&
            Math.abs(item.rect[0] - spanText[i - 1].rect[0]) <= item.height)
      )
    // A count unit can wrap onto the second category row in a predicted
    // shared stub. Keep the unit with its label, not with the next category.
    const wrappedCountLabel =
      p.origin === 'model-span' &&
      column === 0 &&
      colSpan === 1 &&
      rowSpan === 2 &&
      sampleTitle.length === 1 &&
      sampleTail.length > 0 &&
      /^\p{L}[\p{L}\s-]*$/u.test(sampleTitle[0].text) &&
      /^\([Nn]\)$/.test(sampleTail.map((i) => i.text).join('')) &&
      sampleTail.every((i) => Math.abs(i.baseline - sampleTail[0].baseline) < i.height * 0.1) &&
      sampleTail[0].baseline - sampleTitle[0].baseline > sampleTitle[0].height &&
      sampleTail[0].baseline - sampleTitle[0].baseline <= sampleTitle[0].height * 1.6 &&
      Math.abs(sampleTail[0].rect[0] - sampleTitle[0].rect[0]) <= sampleTitle[0].height * 1.5 &&
      !rules.some(
        (r) =>
          r[1] === r[3] &&
          r[0] <= textRect[0] &&
          r[2] >= textRect[2] &&
          r[1] > spanText[0].rect[3] &&
          r[1] < spanText[1].rect[1]
      )
    if (
      rowSpan > 1 &&
      p.origin !== 'source-ruled-stub' &&
      p.origin !== 'source-graded-stub' &&
      p.origin !== 'text-supported-study-span' &&
      p.origin !== 'wrapped-interval-header' &&
      p.origin !== 'source-unit-header' &&
      !wrappedHeaderUnits &&
      !wrappedRowLabel &&
      !wrappedCountLabel &&
      new Set(
        items
          .filter((item) => item.horizontal)
          .flatMap((item) =>
            p.slots
              .filter((slot) => intersect(slot.rect, item.rect) / area(item.rect) > 0.8)
              .map((slot) => slot.row)
          )
      ).size > 1
    ) {
      const ruledSeparation =
        colSpan === 1 &&
        p.slots.every((s) => headerRows.includes(s.row)) &&
        rules.some(
          (r) =>
            r[1] === r[3] &&
            textRect &&
            r[0] <= textRect[0] + 1 &&
            r[2] >= textRect[2] - 1 &&
            r[1] > spanText[0].rect[3] &&
            r[1] < spanText.at(-1).rect[1]
        )
      if (ruledSeparation) return false
      issues.add('span-conflicts-with-source-rows')
      return false
    }
    if (
      colSpan > 1 &&
      !(recordGrid?.completeSpans && p.origin === 'text-supported-study-span') &&
      p.origin !== 'source-ruled-stub' &&
      !(
        (p.origin === 'source-section' ||
          (p.sectionHeader &&
            rowSpan === 1 &&
            column === 0 &&
            // Threshold prose and a treatment plus sign can be font-separated
            // inside a continuous section sentence. Standalone counts still conflict.
            spanText.every(
              (i) =>
                !/^[−+±\d]/.test(i.text.trim()) ||
                /^\+$/.test(i.text.trim()) ||
                /^\d+(?:\.\d+)?%\s+\p{L}/u.test(i.text.trim())
            ))) &&
        spanText.length > 1 &&
        spanText.some((i) => /\p{L}/u.test(i.text)) &&
        spanText
          .slice()
          .sort((a, b) => a.rect[0] - b.rect[0])
          .every((i, index, ordered) => {
            if (!index) return true
            const previous = ordered[index - 1]
            const gap = i.rect[0] - previous.rect[2]
            return (
              (Math.abs(i.baseline - previous.baseline) < i.height * 0.35 &&
                gap < i.height * 0.5) ||
              (index === ordered.length - 1 &&
                /^(?:[a-z]\)?|[*†‡])$/.test(i.text) &&
                i.height <= previous.height * 0.8 &&
                previous.baseline - i.baseline >= previous.height * 0.2 &&
                previous.baseline - i.baseline <= previous.height * 0.8 &&
                gap >= -previous.height * 0.1 &&
                gap <= previous.height * 0.35)
            )
          })
      ) &&
      p.origin !== 'source-schedule-note' &&
      !wrappedSampleHeader &&
      // A continuous source label crossing columns supports its trailing font fragments.
      // Proximity alone is insufficient: adjacent independent labels must still conflict.
      !(
        ['text-supported-header-span', 'ruled-header-span'].includes(p.origin) &&
        (p.wrappedLabel ||
          p.joinedLabel ||
          spanText.some(
            (item) =>
              item.rect[2] - item.rect[0] >=
                Math.min(...p.slots.map((s) => s.rect[2] - s.rect[0])) &&
              p.slots.filter((slot) => intersect(slot.rect, item.rect) / area(item.rect) > 0.05)
                .length > 1
          ) ||
          (spanText.length >= 3 &&
            headerRuns
              .get(row)
              ?.some(
                (run) =>
                  intersect(spanRect, run.rect) / area(run.rect) > 0.95 &&
                  p.slots.filter((slot) => intersect(slot.rect, run.rect) / area(run.rect) > 0.05)
                    .length > 1
              )))
      ) &&
      new Set(
        items
          .filter((item) => item.horizontal)
          .flatMap((item) =>
            p.slots
              .filter((slot) => intersect(slot.rect, item.rect) / area(item.rect) > 0.8)
              .map((slot) => slot.column)
          )
      ).size > 1
    ) {
      issues.add('span-conflicts-with-source-columns')
      return false
    }
    if (p.slots.length !== rowSpan * colSpan) {
      issues.add('nonrectangular-spanning-cell')
      return false
    }
    Object.assign(p, { row, column, rowSpan, colSpan, rect: union(p.slots) })
    return true
  })
  const merges = supported.filter((p) => {
    if (supported.some((q) => q !== p && q.slots.some((s) => p.slots.includes(s)))) {
      issues.add('conflicting-spanning-cells')
      return false
    }
    if (p.origin === 'text-supported-header-span') repairs.push('header-span-inferred')
    return true
  })
  const mergedSlots = new Set(merges.flatMap((p) => p.slots))
  const cells = [
    ...baseCells.filter((c) => !mergedSlots.has(c)),
    ...merges.map(({ row, column, rowSpan, colSpan, rect, origin }) => ({
      row,
      column,
      rowSpan,
      colSpan,
      rect,
      origin
    }))
  ]
    .sort((a, b) => a.row - b.row || a.column - b.column)
    .map((c) => ({ ...c, items: [] }))
  return cells
}

// Count/percent pairs sometimes share a centered mean. Require the complete
// repeated header pattern and one source value per pair on the summary line.
function recoverCountPairSummaries({ proposals, baseCells, items, rows, rules, repairs }) {
  const width = Math.max(...baseCells.map((c) => c.column)) + 1
  if (width < 7 || width % 2 !== 1) return
  const text = (slot) =>
    items
      .filter((i) => inside(slot.rect, i))
      .map((i) => i.text)
      .join('')
      .replace(/\s/g, '')
  const header = rows.findIndex((_, r) => {
    const slots = baseCells.filter((s) => s.row === r)
    return (
      slots.length === width &&
      slots.slice(1).every((s, n) => (n % 2 ? text(s) === '%' : /^(?:No\.?|n)$/.test(text(s))))
    )
  })
  if (header < 0) return
  for (let r = header + 1; r < rows.length; r++) {
    const slots = baseCells.filter((s) => s.row === r)
    if (slots.length !== width || !/^(?:Mean|Median)$/.test(text(slots[0]))) continue
    const values = items
      .filter((i) => inside(rows[r].rect, i) && !inside(slots[0].rect, i))
      .sort((a, b) => a.rect[0] - b.rect[0])
    if (values.length !== (width - 1) / 2) continue
    const pairs = values.map((_, n) => slots.slice(1 + n * 2, 3 + n * 2))
    if (
      !values.every((v, n) => {
        const b = union(pairs[n])
        return (
          /^\d+(?:\.\d+)?$/.test(v.text) &&
          v.rect[0] >= b[0] &&
          v.rect[2] <= b[2] &&
          Math.abs((v.rect[0] + v.rect[2] - b[0] - b[2]) / 2) < (b[2] - b[0]) * 0.1
        )
      })
    )
      continue
    removeOverlappingMergeProposals(proposals, slots.slice(1))
    for (const pair of pairs) proposals.push({ slots: pair, origin: 'source-centered-summary' })
    repairs.push('count-pair-summary-recovered')
  }
  const first = baseCells.filter((s) => s.row === 0)
  const owned = items.filter((i) => inside(rows[0].rect, i))
  const bounds = union(first)
  if (
    header >= 2 &&
    owned.length === 1 &&
    /\p{L}/u.test(owned[0].text) &&
    Math.abs((owned[0].rect[0] + owned[0].rect[2] - bounds[0] - bounds[2]) / 2) < owned[0].height &&
    [false, true].every((below) =>
      rules.some(
        (r) =>
          r[1] === r[3] &&
          r[0] <= bounds[0] + 4 &&
          r[2] >= bounds[2] - 6 &&
          (below
            ? r[1] >= bounds[3] && r[1] - bounds[3] < owned[0].height
            : r[1] <= bounds[1] && bounds[1] - r[1] < owned[0].height)
      )
    )
  ) {
    removeOverlappingMergeProposals(proposals, first)
    proposals.push({ slots: first, origin: 'source-centered-section' })
    repairs.push('ruled-count-table-title-recovered')
  }
}

// A model stub can straddle the end of one follow-up series and the start
// of the next. Repeated native time pairs establish the source label's scope.
function recoverFollowupStubSpans({ proposals, baseCells, items, rows, rules, repairs }) {
  const columns = baseCells.filter((cell) => cell.row === 0).length
  if (columns < 4) return
  const owned = (row, column) => {
    const cell = baseCells.find((cell) => cell.row === row && cell.column === column)
    return cell ? items.filter((item) => item.horizontal && inside(cell.rect, item)) : []
  }
  const text = (row, column) =>
    owned(row, column)
      .map((item) => item.text)
      .join(' ')
      .trim()
  const time = (row) => /^(\d+(?:\.\d+)?)\s+(days?|weeks?|months?|years?)$/i.exec(text(row, 1))
  const complete = (row) =>
    Array.from({ length: columns - 2 }, (_, c) => c + 2).every((column) =>
      /^[<>≤≥−+-]?(?:\d|\.\d)[\d\s.,±()–−+*/%-]*$/.test(text(row, column))
    )
  for (const proposal of proposals) {
    if (
      proposal.origin !== 'model-span' ||
      proposal.slots.length !== 2 ||
      !proposal.slots.every((cell) => cell.column === 0)
    )
      continue
    const [previous, first] = proposal.slots.slice().sort((a, b) => a.row - b.row)
    const row = first.row
    const label = owned(row, 0)
    const start = time(row),
      end = time(row + 1),
      preceding = time(previous.row)
    if (
      row !== previous.row + 1 ||
      !start ||
      !end ||
      !preceding ||
      start[2] !== end[2] ||
      end[0] !== preceding[0] ||
      Number(start[1]) >= Number(end[1]) ||
      label.length !== 1 ||
      !/^\p{L}/u.test(label[0].text) ||
      owned(previous.row, 0).length ||
      owned(row + 1, 0).length ||
      ![previous.row, row, row + 1].every(complete) ||
      owned(row, 1).length !== 1 ||
      Math.abs(label[0].baseline - owned(row, 1)[0].baseline) > label[0].height * 0.35
    )
      continue
    const peers = rows.filter(
      (_, index) =>
        time(index)?.[0] === start[0] &&
        time(index + 1)?.[0] === end[0] &&
        owned(index, 0).some((item) => /^\p{L}/u.test(item.text)) &&
        !owned(index + 1, 0).length &&
        complete(index) &&
        complete(index + 1)
    )
    const slots = baseCells.filter((cell) => cell.column === 0 && [row, row + 1].includes(cell.row))
    if (
      peers.length < 3 ||
      slots.length !== 2 ||
      proposals.some(
        (other) => other !== proposal && other.slots.some((cell) => slots.includes(cell))
      ) ||
      rules.some(
        (rule) =>
          rule[1] === rule[3] &&
          rule[0] <= label[0].rect[0] &&
          rule[2] >= label[0].rect[2] &&
          rule[1] > label[0].rect[3] &&
          rule[1] < rows[row + 1].rect[3]
      )
    )
      continue
    proposal.slots = slots
    proposal.origin = 'source-followup-stub'
    repairs.push('followup-stub-span-recovered')
  }
}

// Two left-aligned parent labels can head repeated treatment pairs plus an
// unlabelled difference column. Require the same source sample headers in both
// blocks, native upper borders and complete later value rows before merging.
function recoverRepeatedArmHeaders({ proposals, baseCells, items, rows, rules, repairs }) {
  const top = baseCells.filter((c) => c.row === 0)
  if (top.length !== 7 || rows.length < 5) return
  const owned = (row, column) => {
    const cell = baseCells.find((c) => c.row === row && c.column === column)
    return cell
      ? items
          .filter((i) => inside(cell.rect, i))
          .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
      : []
  }
  const titles = items.filter((i) => inside(rows[0].rect, i))
  if (titles.length !== 2 || titles[0].text === titles[1].text) return
  const groups = [1, 4].map((column) => ({
    column,
    parent: owned(0, column),
    arms: [owned(1, column), owned(1, column + 1)]
  }))
  const compact = (tokens) =>
    tokens
      .map((i) => i.text)
      .join('')
      .replace(/\s/g, '')
  if (
    groups.some(
      (g) =>
        g.parent.length !== 1 ||
        !/^\p{L}/u.test(g.parent[0].text) ||
        owned(1, g.column + 2).length ||
        g.arms.some((arm) => !/^\p{L}.+\(n=\d+\)$/iu.test(compact(arm))) ||
        compact(g.arms[0]) === compact(g.arms[1])
    )
  )
    return
  if (groups[0].arms.some((arm, n) => compact(arm) !== compact(groups[1].arms[n]))) return
  for (const g of groups) {
    const title = g.parent[0],
      height = title.height
    const groupSlots = top.filter((s) => s.column >= g.column && s.column < g.column + 3)
    if (
      Math.abs(title.baseline - groups[0].parent[0].baseline) > height * 0.35 ||
      rules.some(
        (r) =>
          r[0] === r[2] &&
          r[0] > groupSlots[0].rect[0] + height &&
          r[0] < groupSlots.at(-1).rect[2] - height &&
          r[1] < title.rect[3] &&
          r[3] > title.rect[1]
      )
    )
      return
    if (
      Math.abs(title.rect[0] - g.arms[0][0].rect[0]) > height * 0.3 ||
      union(g.arms.flat())[1] <= title.rect[3] ||
      union(g.arms.flat())[1] - title.rect[3] > height * 2
    )
      return
    for (let c = g.column; c < g.column + 3; c++) {
      const slot = top.find((s) => s.column === c),
        center = (slot.rect[0] + slot.rect[2]) / 2
      if (
        !rules.some(
          (r) =>
            r[1] === r[3] &&
            r[1] <= title.rect[1] &&
            r[1] >= title.rect[1] - height &&
            r[0] < center &&
            r[2] > center
        )
      )
        return
    }
  }
  const numericRows = rows
    .slice(2)
    .filter(
      (_, n) =>
        owned(n + 2, 0).some((i) => /\p{L}/u.test(i.text)) &&
        top.slice(1).every((slot) => /^[-−+<>≤≥]?\d/.test(compact(owned(n + 2, slot.column))))
    )
  if (numericRows.length < 2) return
  for (let i = proposals.length - 1; i >= 0; i--) {
    const slots = proposals[i].slots
    if (
      slots.some((s) => s.row === 0) ||
      (slots.some((s) => s.row === 1) && new Set(slots.map((s) => s.column)).size > 1)
    )
      proposals.splice(i, 1)
  }
  for (const g of groups)
    proposals.push({
      origin: 'source-ruled-stub',
      slots: top.filter((s) => s.column >= g.column && s.column < g.column + 3)
    })
  repairs.push('repeated-arm-parent-headers-recovered')
}

// Remove only shared base-cell identities. When rows are supplied, a competing
// proposal must be wholly inside them; crossing spans retain their conflict guards.
export function removeOverlappingMergeProposals(proposals, slots, withinRows) {
  for (let i = proposals.length - 1; i >= 0; i--) {
    const candidate = proposals[i].slots
    if (
      (!withinRows || candidate.every((cell) => withinRows.includes(cell.row))) &&
      candidate.some((cell) => slots.includes(cell))
    )
      proposals.splice(i, 1)
  }
}

// A source-supported header owns its entire header band. Replace competing
// proposals there, including vertical spans crossing its edge, while leaving
// body proposals and base-cell identities intact.
export function applySourceHeaderSpans(proposals, baseCells, spans, headerRowCount) {
  for (let i = proposals.length - 1; i >= 0; i--)
    if (proposals[i].slots.some((cell) => cell.row < headerRowCount)) proposals.splice(i, 1)
  proposals.push(
    ...spans.map((span) => ({
      origin: 'source-ruled-stub',
      slots: baseCells.filter(
        (cell) =>
          cell.row >= span.row &&
          cell.row < span.row + span.rowSpan &&
          cell.column >= span.column &&
          cell.column < span.column + span.colSpan
      )
    }))
  )
}

// A locally closed statistic face can span records even when column dividers
// shift elsewhere in the table. Require two complete count records and all four
// native borders; an empty model cell alone is never evidence for a rowspan.
function recoverClosedStatisticSpans({ proposals, baseCells, items, rows, rules, repairs }) {
  const width = Math.max(...baseCells.map((c) => c.column)) + 1
  if (width < 4) return
  const horizontal = rules.filter((r) => r[1] === r[3])
  const vertical = rules.filter((r) => r[0] === r[2])
  const owned = (rect) => items.filter((i) => i.horizontal && inside(rect, i))
  const covers = (x, top, bottom) => {
    let end = top
    for (const r of vertical.filter((r) => Math.abs(r[0] - x) <= 1.2).sort((a, b) => a[1] - b[1])) {
      if (r[1] > end + 1.2) break
      end = Math.max(end, r[3])
    }
    return end >= bottom - 1.2
  }
  for (let row = 0; row < rows.length - 1; row++) {
    const records = [row, row + 1].map((n) => baseCells.filter((s) => s.row === n))
    if (
      !records.every(
        (slots) =>
          slots.length === width &&
          slots.every((slot) => {
            if (slot.column === width - 1) return true
            const text = owned(slot.rect)
              .map((i) => i.text)
              .join('')
              .replace(/\s/g, '')
            return slot.column === 0 ? /\p{L}/u.test(text) : /^\d+\(\d+(?:\.\d+)?%?\)$/.test(text)
          })
      )
    )
      continue
    const slots = records.map((r) => r.find((s) => s.column === width - 1))
    const values = owned(union(slots))
    if (values.length !== 1 || !/^[<>≤≥]?\s*(?:\d+(?:\.\d+)?|\.\d+)$/.test(values[0].text)) continue
    const value = values[0]
    const edges = horizontal.filter((r) => r[0] <= value.rect[0] && r[2] >= value.rect[2])
    const top = edges.filter((r) => r[1] < value.rect[1]).sort((a, b) => b[1] - a[1])[0]
    const bottom = edges.filter((r) => r[1] > value.rect[3]).sort((a, b) => a[1] - b[1])[0]
    if (!top || !bottom || Math.abs(top[0] - bottom[0]) > 1.2 || Math.abs(top[2] - bottom[2]) > 1.2)
      continue
    const face = [top[0], top[1], top[2], bottom[1]]
    const centers = slots.map((s) => (s.rect[1] + s.rect[3]) / 2)
    if (
      !centers.every((y) => y > face[1] && y < face[3]) ||
      baseCells.some(
        (s) =>
          s.column === width - 1 &&
          !slots.includes(s) &&
          (s.rect[1] + s.rect[3]) / 2 > face[1] &&
          (s.rect[1] + s.rect[3]) / 2 < face[3]
      ) ||
      owned(face).length !== 1 ||
      !covers(face[0], face[1], face[3]) ||
      !covers(face[2], face[1], face[3])
    )
      continue
    // Partial interior strokes contradict a single closed face too.
    if (
      horizontal.some(
        (r) =>
          r[1] > face[1] + 1.2 &&
          r[1] < face[3] - 1.2 &&
          r[2] > face[0] + 1.2 &&
          r[0] < face[2] - 1.2
      ) ||
      vertical.some(
        (r) =>
          r[0] > face[0] + 1.2 &&
          r[0] < face[2] - 1.2 &&
          r[3] > face[1] + 1.2 &&
          r[1] < face[3] - 1.2
      )
    )
      continue
    const neighbor = records[0].find((s) => s.column === width - 2)
    if (
      !horizontal.some(
        (r) =>
          r[1] > centers[0] &&
          r[1] < centers[1] &&
          r[0] <= neighbor.rect[0] + 1.2 &&
          Math.abs(r[2] - face[0]) <= 1.2
      )
    )
      continue
    if (proposals.some((p) => p.slots.some((s) => slots.includes(s)))) continue
    proposals.push({ slots, origin: 'source-closed-statistic' })
    repairs.push('closed-statistic-span-recovered')
  }
}
