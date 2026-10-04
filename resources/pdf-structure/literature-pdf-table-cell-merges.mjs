/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { area, intersection as intersect } from './literature-pdf-page-geometry.mjs'
import { classifyTableRuleEdge, joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'
import { inside, union, isAdjacentTableScript } from './literature-pdf-table-geometry.mjs'

// Repeated probability columns can compare a complete indented categorical
// section. Require identical complete measurement lanes and native centering
// over the whole section; a probability centered over a subset stays separate.
export function reconcileCategoricalComparisons({
  cells,
  items,
  rules,
  headerRows,
  unassigned,
  repairs
}) {
  if (unassigned.length || !headerRows.length || items.some((i) => i.horizontal === false)) return
  const width = Math.max(...cells.map((c) => c.column + c.colSpan))
  const headers = cells.filter((c) => headerRows.includes(c.row))
  const probabilities = headers
    .filter((c) => c.colSpan === 1 && /^P-?value$/i.test(c.text.replace(/\s/g, '')))
    .map((c) => c.column)
  const probabilityColumns = [...new Set(probabilities)].sort((a, b) => a - b)
  if (probabilityColumns.length < 2 || probabilityColumns[0] < 2) return
  const parents = probabilityColumns.map((column) =>
    headers.filter((c) => c.colSpan >= 2 && c.column <= column && c.column + c.colSpan > column)
  )
  if (
    parents.some((p) => p.length !== 1) ||
    new Set(parents.map((p) => p[0])).size !== probabilityColumns.length
  )
    return
  const roles = parents.map(([p]) =>
    headers
      .filter(
        (c) =>
          c.row > p.row &&
          c.column >= p.column &&
          c.column < p.column + p.colSpan &&
          c.rowSpan === 1 &&
          c.colSpan === 1
      )
      .sort((a, b) => a.column - b.column)
      .map((c) => c.text.replace(/\s/g, ''))
  )
  if (
    roles.some(
      (r, n) =>
        r.length !== parents[n][0].colSpan ||
        r.some((s) => !s) ||
        JSON.stringify(r) !== JSON.stringify(roles[0])
    )
  )
    return
  const key = (i) => JSON.stringify([i.text, i.rect]),
    owned = cells.flatMap((c) => c.sourceTokens).map(key),
    ownership = new Set(owned)
  if (
    owned.length !== items.length ||
    ownership.size !== owned.length ||
    new Set(items.map(key)).size !== items.length ||
    items.some((i) => !ownership.has(key(i)))
  )
    return
  const atRow = (r) => cells.filter((c) => c.row === r)
  const sections = [...new Set(cells.map((c) => c.row))]
    .sort((a, b) => a - b)
    .flatMap((row) => {
      if (headerRows.includes(row)) return []
      const content = atRow(row).filter((c) => c.sourceTokens.length)
      if (
        content.length !== 1 ||
        content[0].column !== 0 ||
        content[0].rowSpan !== 1 ||
        !/\p{L}/u.test(content[0].text) ||
        /\d/u.test(content[0].text)
      )
        return []
      return [{ row, label: content[0] }]
    })
  const lastRow = Math.max(...cells.map((c) => c.row + c.rowSpan - 1)),
    candidates = []
  const measurements = Array.from({ length: width - 1 }, (_, n) => n + 1).filter(
    (c) => !probabilityColumns.includes(c)
  )
  if (measurements.length < 3) return
  for (const [n, section] of sections.entries()) {
    const start = section.row + 1,
      end = sections[n + 1]?.row ?? lastRow + 1
    if (end - start < 2 || end - start > 8) continue
    const records = Array.from({ length: end - start }, (_, i) =>
      atRow(start + i).sort((a, b) => a.column - b.column)
    )
    const labelTokens = section.label.sourceTokens,
      height = Math.max(...labelTokens.map((i) => i.height))
    if (
      !height ||
      records.some(
        (row) =>
          row.length !== width ||
          row.some((c, i) => c.column !== i || c.rowSpan !== 1 || c.colSpan !== 1) ||
          !/\p{L}/u.test(row[0].text) ||
          !row[0].sourceTokens.length ||
          Math.min(...row[0].sourceTokens.map((i) => i.rect[0])) -
            Math.min(...labelTokens.map((i) => i.rect[0])) <
            height * 0.5 ||
          measurements.some(
            (c) =>
              !/^\d+(?:\(\d+(?:\.\d+)?%\))?$/.test(row[c].text.replace(/\s/g, '')) ||
              !row[c].sourceTokens.length
          )
      )
    )
      continue
    const source = records.map((row) =>
      row.filter((c) => !probabilityColumns.includes(c.column)).flatMap((c) => c.sourceTokens)
    )
    if (
      source.some((g) =>
        g.some(
          (i) =>
            Math.abs(i.height - height) > height * 0.1 ||
            Math.abs(i.baseline - g[0].baseline) > height * 0.1
        )
      )
    )
      continue
    const centers = source.map((g) => g[0].baseline - g[0].height / 2)
    if (
      centers.some(
        (y, i) => i && (y - centers[i - 1] < height || y - centers[i - 1] > height * 1.6)
      )
    )
      continue
    const targets = probabilityColumns.map((column) => {
      const slots = records.map((r) => r[column]),
        values = slots.filter((c) => c.sourceTokens.length)
      if (
        values.length !== 1 ||
        !/^[<>≤≥]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(values[0].text.replace(/\s/g, ''))
      )
        return
      const value = values[0],
        ink = union(value.sourceTokens),
        rect = union(slots)
      if (
        value.sourceTokens.some(
          (i) =>
            Math.abs(i.height - height) > height * 0.1 ||
            Math.abs(i.baseline - value.sourceTokens[0].baseline) > height * 0.05
        ) ||
        Math.abs((ink[1] + ink[3] - centers[0] - centers.at(-1)) / 2) > height * 0.1 ||
        ink[0] < rect[0] ||
        ink[2] > rect[2] ||
        ink[1] < rect[1] ||
        ink[3] > rect[3] ||
        rules.some(
          (r) =>
            (r[1] === r[3] &&
              r[1] > rect[1] &&
              r[1] < rect[3] &&
              r[0] < rect[2] &&
              r[2] > rect[0]) ||
            (r[0] === r[2] && r[0] > rect[0] && r[0] < rect[2] && r[1] < rect[3] && r[3] > rect[1])
        )
      )
        return
      return { slots, value, rect }
    })
    if (targets.some((t) => !t)) continue
    candidates.push({ start, end, height, targets })
  }
  if (candidates.length < 3) return
  const headerInk = union(headers.flatMap((c) => c.sourceTokens)),
    bodyInk = union(
      cells.filter((c) => !headerRows.includes(c.row)).flatMap((c) => c.sourceTokens)
    ),
    frame = union(cells),
    height = candidates[0].height
  const edges = joinHorizontalTableRules(rules, height * 0.1).filter(
    (r) => Math.abs(r[0] - frame[0]) < height && Math.abs(r[2] - frame[2]) < height
  )
  if (
    !edges.some((r) => r[1] <= headerInk[1] + height * 0.1 && headerInk[1] - r[1] < height) ||
    !edges.some((r) => r[1] >= bodyInk[3] && r[1] - bodyInk[3] < height)
  )
    return
  for (const { start, end, targets } of candidates) {
    for (const { slots, value, rect } of targets) {
      const first = slots[0]
      Object.assign(first, {
        ...value,
        row: start,
        rowSpan: end - start,
        rect,
        origin: 'source-category-group'
      })
      for (const slot of slots.slice(1)) cells.splice(cells.indexOf(slot), 1)
    }
    repairs.push('categorical-group-spans-recovered')
  }
}

// Separate cited records can share centered study fields. An accepted model
// span in the neighboring study column, complete references and independent
// result columns prove the common record extent; empty slots alone do not.
export function reconcileSharedReferenceFields({
  cells,
  items,
  rules,
  headerRows,
  unassigned,
  repairs
}) {
  if (unassigned.length) return
  const width = Math.max(...cells.map((c) => c.column + c.colSpan))
  if (width < 6) return
  const references = cells.filter(
    (c) =>
      c.column === 0 &&
      c.rowSpan === 1 &&
      c.colSpan === 1 &&
      /^\p{Lu}[\p{L}’'.-]+ et al\. \((?:19|20)\d{2}(?:,\s*(?:19|20)\d{2})*\) \[\d+(?:[,–-]\s*\d+)*\]$/u.test(
        c.text
      )
  )
  if (references.length < 3) return
  const header = cells.filter((c) => headerRows.includes(c.row)).flatMap((c) => c.sourceTokens)
  const body = cells.filter((c) => !headerRows.includes(c.row)).flatMap((c) => c.sourceTokens)
  if (!header.length || !body.length) return
  const height = Math.max(...header.map((i) => i.height)),
    frame = union(cells)
  const borders = joinHorizontalTableRules(rules, height * 0.1).filter(
    (r) => Math.abs(r[0] - frame[0]) < height && Math.abs(r[2] - frame[2]) < height
  )
  const head = union(header),
    data = union(body)
  if (
    !borders.some((r) => r[1] <= head[1] + height * 0.1 && head[1] - r[1] < height) ||
    !borders.some((r) => r[1] >= head[3] && r[1] <= data[1]) ||
    !borders.some((r) => r[1] >= data[3] && r[1] - data[3] < height)
  )
    return
  const key = (i) => JSON.stringify([i.text, i.rect])
  const owned = cells.flatMap((c) => c.sourceTokens).map(key)
  const ownership = new Set(owned)
  if (
    owned.length !== ownership.size ||
    items.length !== ownership.size ||
    new Set(items.map(key)).size !== items.length ||
    items.some((i) => !ownership.has(key(i)))
  )
    return
  const contained = (rect, i, rounding = 0) =>
    i.rect[0] >= rect[0] &&
    i.rect[2] <= rect[2] &&
    i.rect[1] >= rect[1] - rounding &&
    i.rect[3] <= rect[3] + rounding
  for (const witness of cells.filter(
    (c) =>
      c.origin === 'model-span' &&
      c.rowSpan === 2 &&
      c.colSpan === 1 &&
      c.column > 0 &&
      c.column < width - 4 &&
      c.sourceTokens.length === 1
  )) {
    const anchor = witness.sourceTokens[0],
      h = anchor.height
    const rows = [witness.row, witness.row + 1]
    if (
      !/\p{L}/u.test(anchor.text) ||
      Math.abs(anchor.rect[1] + anchor.rect[3] - witness.rect[1] - witness.rect[3]) > h * 0.4 ||
      rows.some((row) => !references.some((c) => c.row === row))
    )
      continue
    const results = cells.filter((c) => rows.includes(c.row) && c.column >= width - 2)
    if (
      results.length !== 4 ||
      results.some(
        (c) =>
          c.rowSpan !== 1 ||
          c.colSpan !== 1 ||
          c.sourceTokens.length < 2 ||
          !/^[-–—]\s+\p{L}.*\d/u.test(c.text) ||
          // Native glyph bounds can overshoot a model edge by subpixel rounding.
          // Keep horizontal containment strict so neighboring columns stay separate.
          c.sourceTokens.some((i) => !contained(c.rect, i, i.height * 0.01))
      )
    )
      continue
    const changes = []
    for (let column = witness.column + 1; column < width - 2; column++) {
      const slots = cells.filter((c) => rows.includes(c.row) && c.column === column)
      if (slots.length !== 2 || slots.some((c) => c.rowSpan !== 1 || c.colSpan !== 1)) break
      const values = slots.filter((c) => c.sourceTokens.length)
      const rect = union(slots)
      if (
        values.length !== 1 ||
        !values[0].text ||
        values[0].sourceTokens.some(
          (i) =>
            !contained(rect, i) ||
            Math.abs(i.baseline - anchor.baseline) > h * 0.1 ||
            Math.abs(i.height - h) > h * 0.1
        ) ||
        items.filter((i) => inside(rect, i)).length !== values[0].sourceTokens.length ||
        rules.some(
          (r) =>
            (r[1] === r[3] &&
              r[2] > rect[0] &&
              r[0] < rect[2] &&
              r[1] > rect[1] + h * 0.2 &&
              r[1] < rect[3] - h * 0.2) ||
            (r[0] === r[2] &&
              r[0] > rect[0] + h * 0.1 &&
              r[0] < rect[2] - h * 0.1 &&
              r[1] < rect[3] &&
              r[3] > rect[1])
        )
      )
        break
      changes.push({ slots, value: values[0], rect })
    }
    if (changes.length < 3 || changes.length !== width - 3 - witness.column) continue
    for (const { slots, value, rect } of changes) {
      cells.splice(cells.indexOf(slots.find((c) => c !== value)), 1)
      value.row = witness.row
      value.rowSpan = 2
      value.rect = rect
      value.origin = 'source-ruled-stub'
    }
    repairs.push('source-record-boundary-restored')
  }
}

// Standalone leaves beside repeated three-level cohorts own the whole native
// header band. Prove the neighboring hierarchy before joining empty model slots.
export function reconcileRuledLeafHeaderSpans({ cells, rows, items, rules, repairs }) {
  if (rows.length < 5) return
  const at = (row) => cells.filter((c) => c.row === row).sort((a, b) => a.column - b.column)
  const roots = at(0).filter(
    (c) => c.rowSpan === 1 && c.colSpan >= 4 && /\(n\s*=\s*\d+\)$/i.test(c.text)
  )
  if (roots.length < 2) return
  const header = cells.filter((c) => c.row < 3)
  const height = Math.max(...header.flatMap((c) => c.sourceTokens.map((i) => i.height)))
  if (!Number.isFinite(height) || height <= 0) return
  const horizontal = joinHorizontalTableRules(rules)
  const underline = (cell, lower) => {
    const source = union(cell.sourceTokens),
      below = union(lower.flatMap((c) => c.sourceTokens))
    return horizontal.some(
      (r) =>
        r[1] >= source[3] &&
        r[1] <= below[1] &&
        Math.abs(r[0] - cell.rect[0]) <= height &&
        Math.abs(r[2] - cell.rect[2]) <= height
    )
  }
  const signatures = []
  for (const root of roots) {
    const end = root.column + root.colSpan
    const children = at(1).filter((c) => c.column >= root.column && c.column < end)
    if (
      children.length < 2 ||
      children.some(
        (c, n) =>
          c.rowSpan !== 1 ||
          c.colSpan < 2 ||
          !c.text ||
          !c.sourceTokens.length ||
          c.column !== (n ? children[n - 1].column + children[n - 1].colSpan : root.column)
      ) ||
      children.at(-1).column + children.at(-1).colSpan !== end ||
      !underline(root, children)
    )
      return
    let ruledChildren = 0
    const signature = []
    for (const child of children) {
      const leaves = at(2).filter(
        (c) => c.column >= child.column && c.column < child.column + child.colSpan
      )
      if (
        leaves.length !== child.colSpan ||
        leaves.some(
          (c, n) =>
            c.column !== child.column + n ||
            c.rowSpan !== 1 ||
            c.colSpan !== 1 ||
            !/^\p{L}/u.test(c.text) ||
            !c.sourceTokens.length
        )
      )
        return
      if (underline(child, leaves)) ruledChildren++
      signature.push([child.text, leaves.map((c) => c.text)])
    }
    if (!ruledChildren) return
    signatures.push(JSON.stringify(signature))
  }
  if (!signatures.every((s) => s === signatures[0])) return
  const bounds = union(header),
    topSource = Math.min(...header.flatMap((c) => c.sourceRects.map((r) => r[1])))
  const bottomSource = Math.max(...header.flatMap((c) => c.sourceRects.map((r) => r[3])))
  const top = horizontal.find(
    (r) =>
      r[1] <= topSource &&
      topSource - r[1] <= height &&
      Math.abs(r[0] - bounds[0]) <= height &&
      Math.abs(r[2] - bounds[2]) <= height
  )
  const bottom = horizontal.find(
    (r) =>
      r[1] >= bottomSource &&
      r[1] - bottomSource <= height &&
      Math.abs(r[0] - bounds[0]) <= height &&
      Math.abs(r[2] - bounds[2]) <= height
  )
  if (!top || !bottom) return
  const candidates = at(0).filter(
    (c) =>
      c.column > 0 &&
      c.rowSpan === 1 &&
      c.colSpan === 1 &&
      /^\p{L}+$/u.test(c.text) &&
      c.sourceTokens.length
  )
  if (candidates.length < 2) return
  for (const leaf of candidates) {
    const slots = header.filter((c) => c.column === leaf.column).sort((a, b) => a.row - b.row)
    let next = 0
    if (
      slots.some((c) => {
        const bad =
          c.row !== next ||
          c.colSpan !== 1 ||
          c.row + c.rowSpan > 3 ||
          (c !== leaf && (c.text || c.sourceRects.length || c.sourceTokens.length))
        next = c.row + c.rowSpan
        return bad
      }) ||
      next !== 3
    )
      continue
    const rect = union(slots)
    if (
      rules.some(
        (r) =>
          (r[1] === r[3] &&
            r[1] > top[1] + height * 0.1 &&
            r[1] < bottom[1] - height * 0.1 &&
            r[0] < rect[2] &&
            r[2] > rect[0]) ||
          (r[0] === r[2] && r[0] > rect[0] && r[0] < rect[2] && r[1] < bottom[1] && r[3] > top[1])
      )
    )
      continue
    const owned = (i) => leaf.sourceRects.some((r) => r.every((v, n) => v === i.rect[n]))
    if (items.some((i) => intersect(rect, i.rect) > 0 && !owned(i))) continue
    if (
      cells.filter(
        (c) =>
          c.row >= 3 &&
          c.column === leaf.column &&
          c.rowSpan === 1 &&
          c.colSpan === 1 &&
          /^[<>≤≥]?\s*(?:\d+(?:\.\d+)?|\.\d+)$/.test(c.text)
      ).length < 2
    )
      continue
    leaf.rowSpan = 3
    leaf.rect = rect
    for (const cell of slots) if (cell !== leaf) cells.splice(cells.indexOf(cell), 1)
    repairs.push('header-span-inferred')
  }
}

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
  recoverSampleQualifiedHeaders({
    proposals,
    baseCells,
    items,
    headerRows,
    rules,
    repairs,
    wrappedOnly: Boolean(recordGrid?.completeSpans)
  })
  recoverOrdinalGroupStatistics({ proposals, baseCells, items, rows, headerRows, rules, repairs })
  recoverLocalPercentageColumns({ proposals, baseCells, items, rows, rules })
  if (!recordGrid?.completeSpans) {
    recoverEnclosedSectionSpans({ proposals, baseCells, items, rows, rules, repairs })
    // A predicted first stub may include both the column heading and the
    // first body group. A complete native header rule separates their scopes.
    for (const proposal of proposals) {
      const slots = proposal.slots.slice().sort((a, b) => a.row - b.row)
      if (
        proposal.origin !== 'model-span' ||
        slots.length < 3 ||
        !slots.every((s) => s.column === 0) ||
        !headerRows.includes(slots[0].row) ||
        slots.slice(1).some((s) => headerRows.includes(s.row))
      )
        continue
      const upper = slots[0],
        lower = slots[1]
      const border = rules.find(
        (r) =>
          r[1] === r[3] &&
          r[1] >= upper.rect[3] &&
          r[1] <= lower.rect[1] &&
          r[0] <= upper.rect[0] + 16 &&
          r[2] >= upper.rect[2] &&
          r[2] - r[0] >= (upper.rect[2] - upper.rect[0]) * 0.9
      )
      if (
        !border ||
        !items.some((i) => inside(upper.rect, i)) ||
        !items.some((i) => inside(lower.rect, i)) ||
        slots.slice(2).some((s) => items.some((i) => inside(s.rect, i)))
      )
        continue
      proposal.slots = slots.slice(1)
      proposal.origin = 'source-ruled-stub'
      repairs.push('source-record-boundary-restored')
    }
    recoverCategoricalGroupSpans({ proposals, baseCells, items, rows, headerRows, repairs })
    recoverSubtotalStubSpans({ proposals, baseCells, items, rows, rules, repairs })
    recoverSummaryStatisticStubs({ proposals, baseCells, items, rows, headerRows, repairs })
    recoverPairedComparisonStubs({ proposals, baseCells, items, rows, rules, repairs })
    recoverThresholdSectionSpans({ proposals, baseCells, items, rows, headerRows, repairs })
    recoverProbabilitySectionStubs({ proposals, baseCells, items, rows, headerRows, repairs })
    recoverClinicalSectionSpans({ proposals, baseCells, items, rows, headerRows, repairs })
    recoverRuledSectionHeadings({ proposals, baseCells, items, rows, headerRows, rules, repairs })
    recoverRepeatedRecordSections({ proposals, baseCells, items, rows, headerRows, rules, repairs })
    recoverGroupedSummaries({ proposals, baseCells, items, rows, headerRows, rules, repairs })
    recoverRepeatedArmHeaders({ proposals, baseCells, items, rows, rules, repairs })
    recoverFollowupStubSpans({ proposals, baseCells, items, rows, rules, repairs })
    recoverClosedStatisticSpans({ proposals, baseCells, items, rows, rules, repairs })
    recoverRuledSectionStub({ proposals, baseCells, items, headerRows, rules, repairs })
    recoverRepeatedRuledStubs({ proposals, baseCells, items, headerRows, rules, repairs })
    recoverCenteredColumnStub({ proposals, baseCells, items, rows, headerRows, rules })
  }
  recoverRepeatedLeafParents({ proposals, baseCells, items, rows, headerRows, rules, repairs })
  const resourceColumns = baseCells
    .filter((cell) => cell.row === 0)
    .map((cell) =>
      items
        .filter((item) => inside(cell.rect, item))
        .map((item) => item.text)
        .join('')
        .replace(/\s/g, '')
        .toLowerCase()
    )
  const resourceGrid =
    resourceColumns.length === 3 &&
    resourceColumns[1] === 'source' &&
    resourceColumns[2] === 'identifier'
  const independentlyRebuilt = (slots) =>
    resourceGrid &&
    [...new Set(slots.map((s) => s.row))].every(
      (r) =>
        rows[r].origin === 'source-text' &&
        baseCells.filter((s) => s.row === r).every((s) => items.some((i) => inside(s.rect, i)))
    )
  const numericRecord = (row, numericCategory = false) => {
    if (headerRows.includes(row)) return false
    const slots = baseCells.filter((c) => c.row === row),
      rect = union(slots)
    const source = items.filter((i) => i.horizontal && inside(rect, i))
    if (slots.length < 2 || !source.length) return false
    const words = slots.map((slot) =>
      source.filter((i) => inside(slot.rect, i)).sort((a, b) => a.rect[0] - b.rect[0])
    )
    const populated = words.filter((g) => g.length)
    if (
      populated.length < 2 ||
      (words.some((g) => !g.length) && populated.length < 3) ||
      (numericCategory
        ? slots.length < 4 ||
          words.some((g) => !g.length) ||
          !/^[<>≤≥]?\d+(?:[.–−-]\d+)?$/.test(
            words[0]
              .map((i) => i.text)
              .join('')
              .replace(/\s/g, '')
          )
        : !/\p{L}/u.test(populated[0].map((i) => i.text).join('')))
    )
      return false
    if (
      source.some(
        (i) => !slots.some((slot) => i.rect[0] >= slot.rect[0] && i.rect[2] <= slot.rect[2])
      )
    )
      return false
    const baseline = source.filter(
      (i) => i.height >= Math.max(...source.map((i) => i.height)) * 0.8
    )
    if (baseline.some((i) => Math.abs(i.baseline - baseline[0].baseline) > i.height * 0.35))
      return false
    return populated.slice(1).every((g) =>
      /^(?:(?:RR|HR|MedianD)=)?[<>≤≥−+-]?\d[\d.,()%±–−+-]*(?:\(N=\d+\))?$/.test(
        g
          .map((i) => i.text)
          .join('')
          .replace(/\s/g, '')
          .replace(/to/g, '–')
      )
    )
  }
  const numericRows = rows.flatMap((_, r) => (numericRecord(r) ? [r] : []))
  const wideNumericBodyRecord = (slots) => {
    if (!slots.length || new Set(slots.map((slot) => slot.row)).size !== 1) return false
    const row = slots[0].row
    if (headerRows.includes(row) || slots.length < 8) return false
    const source = items
      .filter((item) => item.horizontal && inside(union(slots), item))
      .sort((a, b) => a.rect[0] - b.rect[0])
    const words = source.flatMap((item) => item.text.trim().split(/\s+/u))
    const numeric = (value) => /^[<>≤≥−+-]?\d+(?:[.,]\d+)?%?$/.test(value)
    const first = words.findIndex((value) => numeric(value))
    return (
      first > 0 &&
      words.length - first === slots.length - 1 &&
      words.slice(0, first).some((value) => /\p{L}/u.test(value)) &&
      words.slice(first).every(numeric)
    )
  }
  // A numeric category is not a section heading when every native field is
  // complete and at least three independent labelled peers prove the same lanes.
  // Keep incomplete categories on the ordinary diagnostic path.
  const completeCategoryRecord = (row) => {
    if (!numericRecord(row, true)) return false
    const slots = baseCells.filter((c) => c.row === row)
    const owned = (cells) => items.filter((i) => i.horizontal && inside(union(cells), i))
    const source = owned(slots),
      font = Math.max(...source.map((i) => i.height))
    const complete = (cells) => {
      const text = owned(cells)
      return (
        cells.every((c) => text.some((i) => inside(c.rect, i))) &&
        text.every(
          (i) =>
            baseCells.filter((c) => inside(c.rect, i)).length === 1 &&
            cells.some(
              (c) => inside(c.rect, i) && i.rect[0] >= c.rect[0] && i.rect[2] <= c.rect[2]
            ) &&
            Math.abs(i.height - font) < font * 0.2 &&
            Math.abs(i.baseline - text[0].baseline) < font * 0.35
        ) &&
        new Set(text.map((i) => JSON.stringify(i.rect))).size === text.length
      )
    }
    if (!complete(slots)) return false
    return (
      numericRows.filter((r) => {
        const peer = baseCells.filter((c) => c.row === r)
        return (
          peer.length === slots.length &&
          peer.every(
            (c, n) =>
              c.column === slots[n].column &&
              c.rect[0] === slots[n].rect[0] &&
              c.rect[2] === slots[n].rect[2]
          ) &&
          complete(peer)
        )
      }).length >= 3
    )
  }
  const sourceNumericRecord = (slots) =>
    new Set(slots.map((s) => s.row)).size === 1 &&
    ((numericRows.length >= 4 && numericRows.includes(slots[0].row)) ||
      completeCategoryRecord(slots[0].row))
  // This proves only that a model span crosses an independent native boundary.
  // It neither assigns a statistical parent nor authorizes a replacement span.
  const nativeHeaderBodySeparation = (p) => {
    if (p.origin !== 'model-span' || p.slots.length !== 2) return false
    const [upper, lower] = p.slots.slice().sort((a, b) => a.row - b.row)
    if (
      upper.column !== lower.column ||
      lower.row !== upper.row + 1 ||
      !headerRows.includes(upper.row) ||
      headerRows.includes(lower.row)
    )
      return false
    const groups = [upper, lower].map((c) => items.filter((i) => i.horizontal && inside(c.rect, i)))
    if (
      groups.some((g) => !g.length) ||
      !groups[0].some((i) => /\p{L}/u.test(i.text)) ||
      !/^[<>≤≥−+-]?\d[\d.,%]*$/.test(
        groups[1]
          .sort((a, b) => a.rect[0] - b.rect[0])
          .map((i) => i.text)
          .join('')
          .replace(/\s/g, '')
      )
    )
      return false
    if (
      groups.some((g, n) =>
        g.some(
          (i) =>
            baseCells.filter((c) => inside(c.rect, i)).length !== 1 ||
            i.rect[0] < [upper, lower][n].rect[0] ||
            i.rect[2] > [upper, lower][n].rect[2]
        )
      )
    )
      return false
    if (groups[1].some((i) => Math.abs(i.baseline - groups[1][0].baseline) >= i.height * 0.35))
      return false
    const top = Math.max(...groups[0].map((i) => i.rect[3])),
      bottom = Math.min(...groups[1].map((i) => i.rect[1])),
      frame = union(baseCells.filter((c) => c.row === upper.row)),
      font = Math.max(...groups.flat().map((i) => i.height))
    if (
      bottom <= top ||
      new Set(groups.flat().map((i) => JSON.stringify(i.rect))).size !== groups.flat().length
    )
      return false
    const dividers = joinHorizontalTableRules(rules).filter(
      (r) =>
        r[1] > top &&
        r[1] < bottom &&
        Math.abs(r[0] - frame[0]) <= font * 0.25 &&
        Math.abs(r[2] - frame[2]) <= font * 0.25
    )
    if (dividers.length !== 1) return false
    const y = dividers[0][1]
    return !items.some(
      (i) => i.rect[0] < frame[2] && i.rect[2] > frame[0] && i.rect[1] < y && i.rect[3] > y
    )
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
  let supported = unique.filter((p) => {
    const rs = p.slots.map((s) => s.row),
      cs = p.slots.map((s) => s.column)
    const row = Math.min(...rs),
      column = Math.min(...cs),
      rowSpan = Math.max(...rs) - row + 1,
      colSpan = Math.max(...cs) - column + 1
    if (p.origin === 'model-span' && rowSpan === 1 && wideNumericBodyRecord(p.slots)) {
      repairs.push('wide-numeric-row-span-discarded')
      return false
    }
    if (
      p.origin === 'model-span' &&
      p.sectionHeader &&
      colSpan > 1 &&
      sourceNumericRecord(p.slots)
    ) {
      repairs.push('source-record-boundary-restored')
      return false
    }
    if (
      p.origin === 'model-span' &&
      unique.some(
        (q) =>
          q.origin === 'source-section' &&
          new Set(q.slots.map((slot) => slot.row)).size === 1 &&
          q.slots[0]?.row === row &&
          q.slots.some((slot) => p.slots.includes(slot))
      )
    ) {
      repairs.push('model-section-span-discarded')
      return false
    }
    const spanRect = union(p.slots)
    const spanText = items
      .filter((item) => item.horizontal && intersect(spanRect, item.rect) / area(item.rect) > 0.8)
      .sort((a, b) => a.baseline - b.baseline)
    const textRect = spanText.length ? union(spanText) : undefined
    // A cohort heading must not absorb a separately populated time column.
    // Unlike an ordinary empty header, repeated explicit time units provide
    // evidence for that independent dimension beneath a single header tier.
    if (
      p.origin === 'model-span' &&
      rowSpan === 1 &&
      colSpan === 2 &&
      headerRows.length === 1 &&
      headerRows[0] === row &&
      textRect &&
      /\(N\s*=\s*\d+\)/i.test(spanText.map((i) => i.text).join(''))
    ) {
      const owner = p.slots.find((s) => spanText.every((i) => inside(s.rect, i)))
      const time = p.slots.find((s) => s !== owner)
      if (
        owner &&
        time &&
        time.column < owner.column &&
        spanText.every((i) => i.rect[0] >= owner.rect[0] && i.rect[2] <= owner.rect[2])
      ) {
        const labels = baseCells
          .filter((s) => s.column === time.column && !headerRows.includes(s.row))
          .map((s) =>
            items
              .filter((i) => i.horizontal && inside(s.rect, i))
              .map((i) => i.text)
              .join('')
              .replace(/\s/g, '')
          )
        if (
          labels.length >= 6 &&
          new Set(labels).size >= 2 &&
          labels.every((s) => /^\d+(?:W|M|Y|Weeks?|Months?|Years?)$/i.test(s))
        ) {
          repairs.push('source-header-span-discarded')
          return false
        }
      }
    }
    // A short native underline can prove a single-column parent even when
    // the detector merges it with an empty neighboring stub.
    if (
      ['model-span', 'text-supported-header-span'].includes(p.origin) &&
      rowSpan === 1 &&
      colSpan > 1 &&
      headerRows.includes(row) &&
      textRect
    ) {
      const owner = p.slots.find((s) => spanText.every((i) => inside(s.rect, i)))
      const h = Math.max(...spanText.map((i) => i.height))
      if (
        owner &&
        rules.some(
          (r) =>
            r[1] === r[3] &&
            r[1] >= textRect[3] &&
            r[1] - textRect[3] < h * 1.5 &&
            r[0] >= owner.rect[0] - h * 0.3 &&
            r[2] <= owner.rect[2] + h * 0.3 &&
            r[0] <= textRect[0] &&
            r[2] >= textRect[2] &&
            rules.filter(
              (q) => q[1] === q[3] && Math.abs(q[1] - r[1]) < 1 && (q[2] < r[0] || q[0] > r[2])
            ).length >= 2
        )
      ) {
        repairs.push('source-header-span-discarded')
        return false
      }
    }
    const sectionSpanText = p.sectionHeader
      ? spanText.filter(
          (item) =>
            !/^[a-z]$/u.test(item.text.trim()) ||
            !spanText.some(
              (anchor) =>
                anchor !== item &&
                anchor.text.length > item.text.length + 8 &&
                anchor.baseline - item.baseline > item.height * 0.15
            )
        )
      : spanText
    const isolatedSectionHeading =
      p.origin === 'source-section' &&
      sectionSpanText.length === 1 &&
      /(?:well-being|subscale|score)/iu.test(sectionSpanText[0]?.text ?? '') &&
      items.filter(
        (item) =>
          item.horizontal &&
          Math.abs(item.baseline - sectionSpanText[0].baseline) <= item.height * 1.6 &&
          item.rect[0] >= spanRect[2] - 1 &&
          /\d/.test(item.text)
      ).length >= 2
    const touchingText = items.filter((i) => intersect(spanRect, i.rect) / area(i.rect) > 0.4)
    const numericSpanText = spanText.filter((item) => /^[<>≤≥−+-]?\s*\d/.test(item.text.trim()))
    const sourceColumns = new Set(
      numericSpanText
        .map((item) => {
          const center = (item.rect[0] + item.rect[2]) / 2
          return p.slots.find((slot) => center >= slot.rect[0] && center <= slot.rect[2])?.column
        })
        .filter((column) => column !== undefined)
    )
    const sourceRows = new Set(
      spanText
        .map((item) => {
          const center = (item.rect[1] + item.rect[3]) / 2
          return p.slots.find((slot) => center >= slot.rect[1] && center <= slot.rect[3])?.row
        })
        .filter((sourceRow) => sourceRow !== undefined)
    )
    // A cohort's mean/deviation record does not own the following hypothesis
    // tests. Require an aligned label, several measured columns, and an
    // explicit factor/test label in a different column below it.
    if (
      p.origin === 'model-span' &&
      column === 0 &&
      colSpan === 1 &&
      rowSpan > 1 &&
      sourceRows.size === 1 &&
      spanText.length &&
      !headerRows.includes(row)
    ) {
      const rowTokens = (r) => items.filter((i) => i.horizontal && inside(rows[r].rect, i))
      const first = rowTokens(row)
      const means = baseCells
        .filter((c) => c.row === row && c.column > 0)
        .filter((c) =>
          /\d\s*±\s*\d/.test(
            first
              .filter((i) => inside(c.rect, i))
              .map((i) => i.text)
              .join('')
          )
        )
      if (
        means.length >= 2 &&
        spanText.every((i) => first.includes(i)) &&
        rs.slice(1).some((r) => {
          const tokens = rowTokens(r)
          return (
            tokens.some(
              (i) =>
                /^(?:Group|Time|Group\s*[×x]\s*Time|[tFp](?:[ab])?)$/.test(i.text.trim()) &&
                !inside(p.slots[0].rect, i)
            ) &&
            tokens.filter((i) => /^[.\d]+$/.test(i.text)).length >= 2 &&
            !tokens.some((i) => i.text.includes('±'))
          )
        })
      ) {
        repairs.push('source-numeric-span-discarded')
        return false
      }
    }
    // A probability for one complete regression estimate cannot extend into
    // records where that entire estimate/probability pair is absent. Require
    // another complete pair on every row and equally aligned independent stubs.
    if (
      p.origin === 'model-span' &&
      rowSpan > 1 &&
      colSpan === 1 &&
      column >= 4 &&
      spanText.length &&
      /^[<>≤≥]?\d+(?:\.\d+)?$/.test(
        spanText
          .map((i) => i.text)
          .join('')
          .replace(/\s/g, '')
      ) &&
      sourceRows.size === 1
    ) {
      const own = (r, c) => {
        const cell = baseCells.find((s) => s.row === r && s.column === c)
        return cell ? items.filter((i) => i.horizontal && inside(cell.rect, i)) : []
      }
      const label = (c) =>
        headerRows
          .flatMap((r) => own(r, c))
          .map((i) => i.text)
          .join('')
          .replace(/\s/g, '')
      const stubs = rs.map((r) => own(r, 0))
      const reference = stubs[0]
      const paired = (r, c) =>
        own(r, c).some((i) => /\d/.test(i.text)) && own(r, c + 1).some((i) => /\d/.test(i.text))
      if (
        /p-?value$/i.test(label(column)) &&
        /CI\)/.test(label(column - 1)) &&
        reference.length &&
        stubs.every(
          (s) =>
            s.length &&
            s.some((i) => /\p{L}/u.test(i.text)) &&
            Math.abs(
              Math.min(...s.map((i) => i.rect[0])) - Math.min(...reference.map((i) => i.rect[0]))
            ) <
              spanText[0].height * 0.2
        ) &&
        paired(row, column - 1) &&
        rs.every((r) => paired(r, 1)) &&
        rs
          .filter((r) => r !== row)
          .every((r) => !own(r, column - 1).length && !own(r, column).length) &&
        spanText.every((i) => Math.abs(i.baseline - reference[0].baseline) < i.height * 0.35)
      ) {
        repairs.push('source-numeric-span-discarded')
        return false
      }
    }
    if (
      p.origin === 'model-span' &&
      !headerRows.includes(row) &&
      numericSpanText.length === spanText.length &&
      numericSpanText.length &&
      sourceColumns.size < colSpan
    ) {
      repairs.push('source-numeric-span-discarded')
      return false
    }
    if (
      p.origin === 'model-span' &&
      !headerRows.includes(row) &&
      sourceRows.size > 1 &&
      spanText.some((item) => /^n\s*\(%\)$/i.test(item.text.trim())) &&
      numericSpanText.length
    ) {
      repairs.push('source-header-span-discarded')
      return false
    }
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
        if (sourceNumericRecord(p.slots)) repairs.push('source-record-boundary-restored')
        else issues.add('span-conflicts-with-source-columns')
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
    // A confidence-interval qualifier can wrap inside one native header face.
    // Require enclosing rules and no divider through that face; adjacent
    // treatment/Mean (SD) header tiers must remain independent.
    const wrappedIntervalQualifier =
      p.origin === 'model-span' &&
      row === 0 &&
      rowSpan === 2 &&
      colSpan === 1 &&
      headerRows.includes(0) &&
      headerRows.includes(1) &&
      spanText.length === 2 &&
      /^\p{L}[\p{L} -]*$/u.test(spanText[0].text) &&
      /^\d{2}%\s*CI$/.test(spanText[1].text) &&
      Math.abs(spanText[0].rect[0] - spanText[1].rect[0]) < spanText[0].height * 0.2 &&
      spanText[1].baseline - spanText[0].baseline > spanText[0].height &&
      spanText[1].baseline - spanText[0].baseline < spanText[0].height * 1.5 &&
      [true, false].every((above) =>
        rules.some(
          (r) =>
            r[1] === r[3] &&
            r[0] <= textRect[0] &&
            r[2] >= textRect[2] &&
            (above
              ? r[1] <= textRect[1] && textRect[1] - r[1] < spanText[0].height
              : r[1] >= textRect[3] && r[1] - textRect[3] < spanText[0].height)
        )
      ) &&
      !rules.some(
        (r) =>
          r[1] === r[3] &&
          r[1] > textRect[1] &&
          r[1] < textRect[3] &&
          r[0] < textRect[2] &&
          r[2] > textRect[0]
      )
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
    const verticalSampleHeader =
      p.origin === 'model-span' &&
      colSpan === 1 &&
      rowSpan >= 2 &&
      rowSpan <= 4 &&
      p.slots.every((s) => headerRows.includes(s.row)) &&
      spanText.length >= 2 &&
      spanText.length <= 5 &&
      spanText.slice(0, -1).every((i) => /\p{L}/u.test(i.text) && /^[\p{L}\d -]+$/u.test(i.text)) &&
      /^\(n\s*=\s*\d+\)$/i.test(spanText.at(-1).text.trim()) &&
      spanText.every(
        (i, n) =>
          Math.abs(i.rect[0] - spanText[0].rect[0]) < i.height * 0.2 &&
          (!n ||
            (i.baseline > spanText[n - 1].baseline &&
              i.baseline - spanText[n - 1].baseline < i.height * 2.5))
      ) &&
      items.filter(
        (i) =>
          /^\(n\s*=\s*\d+\)$/i.test(i.text.trim()) &&
          Math.abs(i.baseline - spanText.at(-1).baseline) < i.height * 0.2
      ).length >= 2 &&
      !rules.some(
        (r) =>
          r[1] === r[3] &&
          r[1] > spanText[0].rect[3] &&
          r[1] < spanText.at(-1).rect[1] &&
          r[0] < textRect[2] &&
          r[2] > textRect[0]
      )
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
      p.origin !== 'source-category-group' &&
      p.origin !== 'text-supported-study-span' &&
      p.origin !== 'wrapped-interval-header' &&
      p.origin !== 'source-unit-header' &&
      !wrappedHeaderUnits &&
      !verticalSampleHeader &&
      !wrappedIntervalQualifier &&
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
      if (
        p.origin === 'model-span' &&
        (independentlyRebuilt(p.slots) ||
          nativeHeaderBodySeparation(p) ||
          (colSpan === resourceColumns.length &&
            rows
              .slice(row + 1, row + rowSpan)
              .some((r) => r.section && r.origin === 'source-text')))
      )
        repairs.push('source-record-boundary-restored')
      else issues.add('span-conflicts-with-source-rows')
      return false
    }
    const sectionTextSupported =
      (p.origin === 'source-section' ||
        (p.sectionHeader &&
          rowSpan === 1 &&
          column === 0 &&
          // Threshold prose and a treatment plus sign can be font-separated
          // inside a continuous section sentence. Standalone counts still conflict.
          sectionSpanText.every(
            (i) =>
              !/^[−+±\d]/.test(i.text.trim()) ||
              /^\+$/.test(i.text.trim()) ||
              /^\d+(?:\.\d+)?%\s+\p{L}/u.test(i.text.trim())
          ))) &&
      (isolatedSectionHeading ||
        (sectionSpanText.length > 1 &&
          sectionSpanText.some((i) => /\p{L}/u.test(i.text)) &&
          sectionSpanText
            .slice()
            .sort((a, b) => a.rect[0] - b.rect[0])
            .every((i, index, ordered) => {
              if (!index) return true
              const previous = ordered[index - 1]
              const gap = i.rect[0] - previous.rect[2]
              // A raised inline marker occupies real horizontal advance
              // even after it is removed from the baseline comparison.
              const scriptWidth = spanText
                .filter(
                  (s) =>
                    !sectionSpanText.includes(s) &&
                    s.rect[0] >= previous.rect[2] - previous.height * 0.1 &&
                    s.rect[2] <= i.rect[0] &&
                    previous.baseline - s.baseline > previous.height * 0.2 &&
                    previous.baseline - s.baseline < previous.height * 0.8
                )
                .reduce((width, s) => width + s.rect[2] - s.rect[0], 0)
              return (
                (Math.abs(i.baseline - previous.baseline) < i.height * 0.35 &&
                  gap - scriptWidth < i.height * 0.5) ||
                (index === ordered.length - 1 &&
                  /^(?:[a-z]\)?|[*†‡])$/.test(i.text) &&
                  i.height <= previous.height * 0.8 &&
                  previous.baseline - i.baseline >= previous.height * 0.2 &&
                  previous.baseline - i.baseline <= previous.height * 0.8 &&
                  gap >= -previous.height * 0.1 &&
                  gap <= previous.height * 0.35)
              )
            })))
    if (
      colSpan > 1 &&
      !(recordGrid?.completeSpans && p.origin === 'text-supported-study-span') &&
      p.origin !== 'source-ruled-stub' &&
      !sectionTextSupported &&
      p.origin !== 'source-schedule-note' &&
      !wrappedSampleHeader &&
      // A continuous source label crossing columns supports its trailing font fragments.
      // Proximity alone is insufficient: adjacent independent labels must still conflict.
      !(
        ['text-supported-header-span', 'ruled-header-span'].includes(p.origin) &&
        (p.wrappedLabel ||
          p.joinedLabel ||
          (p.origin === 'ruled-header-span' &&
            spanText.length === 2 &&
            (() => {
              const [a, b] = spanText.slice().sort((a, b) => a.rect[0] - b.rect[0])
              return (
                /^\p{L}+$/u.test(a.text) &&
                /^-\d+$/.test(b.text) &&
                Math.abs(a.baseline - b.baseline) < a.height * 0.1 &&
                Math.abs(b.rect[0] - a.rect[2]) < a.height * 0.1
              )
            })()) ||
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
      if (
        p.origin === 'model-span' &&
        (independentlyRebuilt(p.slots) || sourceNumericRecord(p.slots))
      )
        repairs.push('source-record-boundary-restored')
      else issues.add('span-conflicts-with-source-columns')
      return false
    }
    if (p.slots.length !== rowSpan * colSpan) {
      // A partial model box can overlap complete section-heading spans. Once
      // every literal heading is owned by a rectangular single-row proposal,
      // the nonrectangular alternative contributes no additional structure.
      const headings = unique
        .filter(
          (q) =>
            q !== p &&
            q.slots.length >= 2 &&
            new Set(q.slots.map((s) => s.row)).size === 1 &&
            Math.max(...q.slots.map((s) => s.column)) -
              Math.min(...q.slots.map((s) => s.column)) +
              1 ===
              q.slots.length
        )
        .map((q) => union(q.slots))
        .filter((rect) => {
          const text = items.filter((i) => i.horizontal && inside(rect, i))
          return (
            text.length &&
            text
              .sort((a, b) => a.rect[0] - b.rect[0])
              .every(
                (i, n) =>
                  /\p{L}/u.test(i.text) &&
                  Math.abs(i.baseline - text[0].baseline) < i.height * 0.35 &&
                  (!n || i.rect[0] - text[n - 1].rect[2] < i.height * 0.5)
              )
          )
        })
      if (
        p.origin === 'model-span' &&
        spanText.length &&
        spanText.every((i) => headings.some((r) => inside(r, i)))
      ) {
        repairs.push('section-heading-span-reconciled')
        return false
      }
      issues.add('nonrectangular-spanning-cell')
      return false
    }
    Object.assign(p, { row, column, rowSpan, colSpan, rect: union(p.slots) })
    return true
  })
  const sourceHeaderSlots = supported
    .filter(
      (p) =>
        p.origin === 'source-ruled-stub' &&
        p.slots.length >= 4 &&
        p.slots.every((slot) => slot.row === 0)
    )
    .flatMap((p) => p.slots)
  if (sourceHeaderSlots.length) {
    supported = supported.filter((p) => {
      if (p.origin === 'model-span' && p.slots.some((slot) => sourceHeaderSlots.includes(slot))) {
        repairs.push('model-header-span-discarded')
        return false
      }
      return true
    })
  }
  // Nested projected headings can disagree only about empty trailing slots.
  // Resolve that duplication after source validation, and compare token ownership
  // rather than incidental glyph overlap with the next record.
  const distinct = supported.filter((p) => {
    if (p.origin !== 'model-span' || p.rowSpan !== 1 || p.column !== 0) return true
    const source = items.filter((item) => inside(p.rect, item))
    if (!source.length || !source.some((item) => /\p{L}/u.test(item.text))) return true
    const superseded = supported.some(
      (q) =>
        q !== p &&
        q.origin === 'model-span' &&
        (p.sectionHeader || q.sectionHeader) &&
        q.row === p.row &&
        q.rowSpan === 1 &&
        q.column === 0 &&
        q.colSpan > p.colSpan &&
        p.slots.every((slot) => q.slots.includes(slot)) &&
        items.filter((item) => inside(q.rect, item)).every((item) => source.includes(item))
    )
    if (superseded) repairs.push('duplicate-model-span-discarded')
    return !superseded
  })
  const merges = distinct.filter((p) => {
    if (distinct.some((q) => q !== p && q.slots.some((s) => p.slots.includes(s)))) {
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

// A repeated percent header changes the meaning of an existing mean/SD pair.
// Require a ruled unit band and complete single percentages in every following
// record before spanning that pair; a blank SD alone is not merge evidence.
function recoverLocalPercentageColumns({ proposals, baseCells, items, rows, rules }) {
  const at = (r) => baseCells.filter((c) => c.row === r).sort((a, b) => a.column - b.column)
  if (at(0).length !== 5) return
  const tokens = (c) => items.filter((i) => inside(c.rect, i))
  const text = (c) =>
    tokens(c)
      .map((i) => i.text)
      .join('')
      .replace(/\s/g, '')
  // Count/percentage leaves can also contain explicitly labelled mean or
  // median summaries. Those rows own one value across each cohort pair.
  const countLeaves = rows.slice(0, 3).some((_, r) => {
    const v = at(r).map(text)
    return v.length === 5 && /^No\.?$/i.test(v[1]) && v[2] === '%' && v[3] === v[1] && v[4] === '%'
  })
  if (countLeaves) {
    for (let r = 2; r < rows.length; r++) {
      const band = at(r)
      if (band.length !== 5) continue
      const label = text(band[0])
      const mean = /^Mean.*±SD/i.test(label),
        median = /^Median\p{L}/iu.test(label)
      if (!mean && !median) continue
      const pairs = [band.slice(1, 3), band.slice(3, 5)]
      const values = pairs.map((slots) => text({ rect: union(slots) }))
      if (
        !values.every((v) =>
          (mean ? /^[−+-]?\d+(?:\.\d+)?±\d+(?:\.\d+)?$/ : /^\d+(?:\.\d+)?$/).test(v)
        )
      )
        continue
      for (const slots of pairs) proposals.push({ slots, origin: 'source-ruled-stub' })
    }
  }
  for (let r = 2; r < rows.length - 4; r++) {
    const band = at(r),
      v = band.map(text)
    if (band.length !== 5 || !/\p{L}/u.test(v[0]) || v[1] || v[3] || v[2] !== '%' || v[4] !== '%')
      continue
    const before = baseCells.filter((c) => c.row < r)
    if (![2, 4].every((column) => before.some((c) => c.column === column && /^SD$/i.test(text(c)))))
      continue
    const ink = union(band.flatMap(tokens))
    if (
      !rules.some(
        (line) =>
          line[1] === line[3] &&
          line[0] <= band[0].rect[0] + 12 &&
          line[2] >= band[4].rect[2] - 12 &&
          line[1] > ink[3] &&
          line[1] - ink[3] < 16
      )
    )
      continue
    const pairs = [band.slice(1, 3), band.slice(3, 5)]
    let records = 0,
      valid = true
    for (let n = r + 1; n < rows.length; n++) {
      const slots = at(n),
        values = slots.map(text)
      if (slots.length !== 5 || !values[0]) {
        valid = false
        break
      }
      if (values.slice(1).every((s) => !s)) continue
      if (
        values[1] ||
        values[3] ||
        ![2, 4].every((c) => /^\d+(?:\.\d+)?$/.test(values[c]) && Number(values[c]) <= 100)
      ) {
        valid = false
        break
      }
      pairs.push(slots.slice(1, 3), slots.slice(3, 5))
      records++
    }
    if (!valid || records < 6) continue
    for (const slots of pairs) proposals.push({ slots, origin: 'source-centered-summary' })
  }
}

// Repeated sample qualifiers and native enclosing rules identify complete
// column headings even when the model merges only their last two lines.
function recoverSampleQualifiedHeaders({
  proposals,
  baseCells,
  items,
  headerRows,
  rules,
  repairs,
  wrappedOnly
}) {
  const rs = Array.from({ length: Math.max(...headerRows) + 1 }, (_, r) => r)
  if (rs.length < 2 || rs.length > 4 || rs.some((r, n) => r !== n)) return
  const width = baseCells.filter((c) => c.row === 0).length
  const groups = []
  for (let column = 0; column < width; column++) {
    const slots = baseCells.filter((c) => c.column === column && rs.includes(c.row)),
      rect = union(slots)
    const text = items
      .filter((i) => i.horizontal && inside(rect, i))
      .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
    // A sentence-case continuation ending in an inline sample count can be
    // centered across two header tiers. It is one label only when its native
    // face has enclosing rules and no separator through either text line.
    const tail = text.slice(1)
    const wrappedQualifier =
      rs.length === 2 &&
      text.length >= 2 &&
      text.length <= 5 &&
      /^[\p{L} -]+$/u.test(text[0].text) &&
      /^[a-z][\p{L} -]*,\s*n\s*=\s*\d+$/u.test(tail.map((i) => i.text).join(' ')) &&
      tail.every((i) => Math.abs(i.baseline - tail[0].baseline) < i.height * 0.2) &&
      tail[0].baseline > text[0].baseline + text[0].height * 0.8 &&
      tail[0].baseline < text[0].baseline + text[0].height * 1.5 &&
      Math.abs(union(tail)[0] + union(tail)[2] - text[0].rect[0] - text[0].rect[2]) <
        text[0].height * 0.5
    if (
      !wrappedQualifier &&
      (wrappedOnly ||
        text.length < 2 ||
        text.length > 5 ||
        !/^\(n\s*=\s*\d+\)$/i.test(text.at(-1).text.trim()) ||
        !text.slice(0, -1).every((i) => /\p{L}/u.test(i.text) && /^[\p{L}\d -]+$/u.test(i.text)) ||
        !text.every(
          (i, n) =>
            Math.abs(i.rect[0] - text[0].rect[0]) < i.height * 0.25 &&
            (!n ||
              (i.baseline > text[n - 1].baseline &&
                i.baseline - text[n - 1].baseline < i.height * 2.5))
        ))
    )
      continue
    const ink = union(text),
      font = text[0].height
    const edges = rules.filter((r) => r[1] === r[3] && r[0] <= ink[0] + 1 && r[2] >= ink[2] - 1)
    if (
      !edges.some((r) => r[1] <= ink[1] + font * 0.15 && ink[1] - r[1] < font * 3) ||
      !edges.some((r) => r[1] >= ink[3] && r[1] - ink[3] < font * 2) ||
      edges.some((r) => r[1] > ink[1] + font * 0.15 && r[1] < ink[3]) ||
      proposals.some(
        (p) => p.slots.some((c) => slots.includes(c)) && p.slots.some((c) => !rs.includes(c.row))
      )
    )
      continue
    if (wrappedQualifier) {
      removeOverlappingMergeProposals(proposals, slots, rs)
      proposals.push({ slots, origin: 'source-ruled-stub' })
      repairs.push('repeated-arm-parent-headers-recovered')
    } else groups.push({ slots, last: text.at(-1) })
  }
  if (
    groups.length < 2 ||
    groups.some((g) => Math.abs(g.last.baseline - groups[0].last.baseline) > g.last.height * 0.2)
  )
    return
  for (const { slots } of groups) {
    removeOverlappingMergeProposals(proposals, slots, rs)
    proposals.push({ slots, origin: 'source-ruled-stub' })
  }
  repairs.push('repeated-arm-parent-headers-recovered')
}

// A partial model stub may omit the first record of a ruled section. Native
// full-width separators, one centered label and complete category/value rows
// establish the extent; whitespace or the model proposal alone cannot do so.
function recoverRepeatedRuledStubs({ proposals, baseCells, items, headerRows, rules, repairs }) {
  const width = baseCells.filter((c) => c.row === 0).length
  if (width < 4) return
  const owned = (slots) => items.filter((i) => i.horizontal && inside(union(slots), i))
  const horizontal = rules.filter((r) => r[1] === r[3])
  const candidates = []
  for (const cell of baseCells.filter((c) => c.column === 0 && !headerRows.includes(c.row))) {
    const label = owned([cell])
    if (!label.length || !label.every((i) => /\p{L}/u.test(i.text))) continue
    const ink = union(label),
      height = Math.max(...label.map((i) => i.height))
    if (ink[3] - ink[1] > height * 1.3) continue
    const edges = horizontal.filter((r) => r[0] <= ink[0] + 1 && r[2] >= ink[2] - 1)
    const top = Math.max(...edges.filter((r) => r[1] < ink[1]).map((r) => r[1]))
    const bottom = Math.min(...edges.filter((r) => r[1] > ink[3]).map((r) => r[1]))
    const slots = baseCells.filter(
      (c) =>
        c.column === 0 &&
        !headerRows.includes(c.row) &&
        (c.rect[1] + c.rect[3]) / 2 > top &&
        (c.rect[1] + c.rect[3]) / 2 < bottom
    )
    if (
      !Number.isFinite(top) ||
      !Number.isFinite(bottom) ||
      slots.length < 2 ||
      slots.length > 6 ||
      slots.some((s, n) => n && s.row !== slots[n - 1].row + 1) ||
      owned(slots).some((i) => !label.includes(i))
    )
      continue
    const records = slots.map((s) => baseCells.filter((c) => c.row === s.row && c.column > 0))
    const primary = (c) =>
      owned([c]).filter((i, _, all) => !all.some((a) => a !== i && isAdjacentTableScript(i, a)))
    const values = records.map((cs) =>
      cs.map((c) =>
        primary(c)
          .map((i) => i.text)
          .join('')
      )
    )
    const signature = values.map((v) => v[0]).join('|')
    if (
      records.some((cs) => cs.length !== width - 1) ||
      values.some(
        (v) =>
          !/\p{L}/u.test(v[0]) ||
          v.slice(1).filter(Boolean).length < 2 ||
          v.slice(1).some((s) => s && !/^[−+-]?(?:\d+(?:\.\d+)?|\.\d+)[*#†‡]*$/.test(s))
      ) ||
      values.some((v) => v.map(Boolean).join() !== values[0].map(Boolean).join()) ||
      new Set(values.map((v) => v[0])).size !== slots.length
    )
      continue
    const text = records.flatMap((cs) => cs.flatMap(primary))
    const right = Math.max(...text.map((i) => i.rect[2]))
    if (
      text.some((i) => i.rect[1] <= top || i.rect[3] >= bottom) ||
      [top, bottom].some((y) => classifyTableRuleEdge(horizontal, 1, y, ink[0], right) !== 1) ||
      horizontal.some(
        (r) => r[1] > top + 1 && r[1] < bottom - 1 && r[0] < right && r[2] > ink[0]
      ) ||
      records.some((cs) => {
        const ts = cs.flatMap(primary)
        return ts.some((i) => Math.abs(i.baseline - ts[0].baseline) > height * 0.4)
      }) ||
      (Math.abs(ink[1] + ink[3] - top - bottom) > height * 1.5 &&
        Math.abs(label[0].baseline - primary(records[0][0])[0]?.baseline) > height * 0.4)
    )
      continue
    candidates.push({ slots, signature })
  }
  for (const c of candidates) {
    if (!candidates.some((p) => p !== c && p.signature === c.signature)) continue
    if (
      proposals.some(
        (p) => p.slots.some((s) => c.slots.includes(s)) && p.slots.some((s) => !c.slots.includes(s))
      )
    )
      continue
    removeOverlappingMergeProposals(proposals, c.slots)
    proposals.push({ slots: c.slots, origin: 'source-ruled-stub' })
    repairs.push('ruled-section-stub-recovered')
  }
}

function recoverRuledSectionStub({ proposals, baseCells, items, headerRows, rules, repairs }) {
  const width = baseCells.filter((c) => c.row === 0).length
  if (width < 5) return
  const horizontal = rules.filter((r) => r[1] === r[3])
  const owned = (rect) => items.filter((i) => i.horizontal && inside(rect, i))
  for (const proposal of proposals) {
    if (
      proposal.origin !== 'model-span' ||
      proposal.slots.length < 2 ||
      !proposal.slots.every((c) => c.column === 0 && !headerRows.includes(c.row))
    )
      continue
    const label = owned(union(proposal.slots))
    const words = label.filter((i) => /\p{L}/u.test(i.text))
    if (
      words.length !== 1 ||
      label.length > 2 ||
      label.some(
        (i) =>
          i !== words[0] &&
          (!/^[†‡¥*]$/.test(i.text) ||
            i.rect[0] < words[0].rect[2] ||
            i.rect[0] - words[0].rect[2] > words[0].height * 0.4 ||
            Math.abs(i.baseline - words[0].baseline) > words[0].height)
      )
    )
      continue
    const ink = union(label),
      font = words[0].height
    const edges = horizontal.filter((r) => r[0] <= ink[0] + 1 && r[2] >= ink[2] - 1)
    const top = Math.max(...edges.filter((r) => r[1] < ink[1]).map((r) => r[1]))
    const bottom = Math.min(...edges.filter((r) => r[1] > ink[3]).map((r) => r[1]))
    if (!Number.isFinite(top) || !Number.isFinite(bottom)) continue
    const slots = baseCells.filter(
      (c) =>
        c.column === 0 &&
        !headerRows.includes(c.row) &&
        (c.rect[1] + c.rect[3]) / 2 > top &&
        (c.rect[1] + c.rect[3]) / 2 < bottom
    )
    if (
      slots.length < 3 ||
      slots.length <= proposal.slots.length ||
      !proposal.slots.every((c) => slots.includes(c)) ||
      slots.some((c, n) => n && c.row !== slots[n - 1].row + 1)
    )
      continue
    const records = baseCells.filter((c) => c.column > 0 && slots.some((s) => s.row === c.row))
    const primary = (rect) =>
      owned(rect).filter((i) => !owned(rect).some((a) => a !== i && isAdjacentTableScript(i, a)))
    const recordItems = records.flatMap((c) => primary(c.rect))
    const first = records.find((c) => c.row === slots[0].row && c.column === 1)
    const aligned =
      first &&
      primary(first.rect).some((i) => Math.abs(i.baseline - words[0].baseline) < font * 0.35)
    if (Math.abs(ink[1] + ink[3] - top - bottom) > font * 1.5 && !aligned) continue
    if (
      records.length !== slots.length * (width - 1) ||
      records.some((c) => {
        const values = primary(c.rect)
        return (
          values.length !== 1 ||
          (c.column === 1
            ? !/\p{L}/u.test(values[0].text)
            : !/^[−+-]?\d+(?:\.\d+)?(?:\s*\((?:[\d., –−+-]+|Reference)\))?$/.test(values[0].text))
        )
      }) ||
      owned(union(slots)).some((i) => !label.includes(i)) ||
      recordItems.some((i) => i.rect[1] <= top || i.rect[3] >= bottom) ||
      slots.some((slot) => {
        const values = records.filter((c) => c.row === slot.row).flatMap((c) => primary(c.rect))
        return values.some((i) => Math.abs(i.baseline - values[0].baseline) > font * 0.7)
      })
    )
      continue
    const right = Math.max(...recordItems.map((i) => i.rect[2]))
    if (
      [top, bottom].some((y) => classifyTableRuleEdge(horizontal, 1, y, ink[0], right) !== 1) ||
      horizontal.some(
        (r) => r[1] > top + 1 && r[1] < bottom - 1 && r[2] > ink[0] && r[0] < right
      ) ||
      proposals.some((p) => p !== proposal && p.slots.some((c) => slots.includes(c)))
    )
      continue
    proposal.slots = slots
    proposal.origin = 'source-ruled-stub'
    repairs.push('ruled-section-stub-recovered')
  }
}

// A vertically centered multiline stub can describe the entire ruled body.
// Require a model span, symmetric empty space, centered source lines and
// complete independent records in every other column before extending it.
function recoverCenteredColumnStub({ proposals, baseCells, items, rows, headerRows, rules }) {
  if (!headerRows.includes(0) || headerRows.some((r) => r > 1) || rows.length < 8) return
  const slots = baseCells.filter((cell) => cell.row > 0 && cell.column === 0)
  if (slots.length !== rows.length - 1) return
  const rect = union(slots)
  const text = items
    .filter((i) => i.horizontal && inside(rect, i))
    .sort((a, b) => a.baseline - b.baseline)
  if (text.length < 3 || text.some((i) => !/\p{L}/u.test(i.text))) return
  const bounds = union(text),
    height = Math.max(...text.map((i) => i.height))
  if (
    bounds[3] - bounds[1] > (rect[3] - rect[1]) * 0.4 ||
    Math.abs(bounds[1] + bounds[3] - rect[1] - rect[3]) > height ||
    text.some(
      (i, n) =>
        Math.abs(i.rect[0] + i.rect[2] - bounds[0] - bounds[2]) > height * 0.2 ||
        (n &&
          (i.baseline - text[n - 1].baseline < height ||
            i.baseline - text[n - 1].baseline > height * 1.5))
    )
  )
    return
  const borders = rules.filter((r) => r[1] === r[3] && r[0] <= bounds[0] && r[2] >= bounds[2])
  if (
    !borders.some((r) => Math.abs(r[1] - rect[1]) < height) ||
    !borders.some((r) => Math.abs(r[1] - rect[3]) < height) ||
    borders.some((r) => r[1] > rect[1] + height && r[1] < rect[3] - height)
  )
    return
  const proposal = proposals.filter(
    (p) =>
      p.origin === 'model-span' &&
      p.slots.length >= slots.length * 0.7 &&
      p.slots.every((s) => slots.includes(s)) &&
      text.every((i) => inside(union(p.slots), i))
  )
  if (proposal.length !== 1) return
  for (const slot of baseCells.filter((c) => c.row > 0 && c.column > 0)) {
    const values = items.filter((i) => i.horizontal && inside(slot.rect, i))
    if (
      !values.length ||
      values.some((i) => Math.abs(i.baseline - values[0].baseline) > height * 0.3)
    )
      return
  }
  if (proposals.some((p) => p !== proposal[0] && p.slots.some((s) => slots.includes(s)))) return
  proposal[0].slots = slots
  proposal[0].origin = 'source-ruled-stub'
  // The native header divider excludes the detector's first data-row header.
  headerRows.splice(0, headerRows.length, 0)
}

// Repeated count/percent pairs or explicit group headers can share a centered
// summary. Require one native value centered under every proven parent group.
function recoverGroupedSummaries({
  proposals,
  baseCells,
  items,
  rows,
  headerRows,
  rules,
  repairs
}) {
  const width = Math.max(...baseCells.map((c) => c.column)) + 1
  if (width < 5) return
  const text = (slot) =>
    items
      .filter((i) => inside(slot.rect, i))
      .map((i) => i.text)
      .join('')
      .replace(/\s/g, '')
  let header = rows.findIndex((_, r) => {
    const slots = baseCells.filter((s) => s.row === r)
    return (
      width >= 7 &&
      width % 2 === 1 &&
      slots.length === width &&
      slots.slice(1).every((s, n) => (n % 2 ? text(s) === '%' : /^(?:No\.?|n)$/.test(text(s))))
    )
  })
  let groups =
    header < 0 ? [] : Array.from({ length: (width - 1) / 2 }, (_, n) => [1 + n * 2, 2 + n * 2])
  const countPairs = header >= 0
  if (!countPairs) {
    for (let r = 0; r < Math.min(3, rows.length); r++) {
      if (!headerRows.includes(r)) continue
      const parents = proposals
        .filter(
          (p) =>
            ['text-supported-header-span', 'ruled-header-span', 'source-ruled-stub'].includes(
              p.origin
            ) &&
            p.slots.length >= 2 &&
            p.slots.every((s) => s.row === r && s.column > 0) &&
            items.some((i) => inside(union(p.slots), i) && /\p{L}/u.test(i.text))
        )
        .map((p) => p.slots.map((s) => s.column).sort((a, b) => a - b))
        .sort((a, b) => a[0] - b[0])
      if (
        parents.length < 2 ||
        parents.flat().length !== width - 1 ||
        !parents.flat().every((c, n) => c === n + 1)
      )
        continue
      header = r
      groups = parents
      break
    }
  }
  if (header < 0) return
  for (let r = header + 1; r < rows.length; r++) {
    const slots = baseCells.filter((s) => s.row === r)
    if (
      slots.length !== width ||
      !/^(?:Mean|Median)(?:\((?:range|IQR|SD)\))?$/i.test(text(slots[0]))
    )
      continue
    const values = items
      .filter((i) => inside(rows[r].rect, i) && !inside(slots[0].rect, i))
      .sort((a, b) => a.rect[0] - b.rect[0])
    if (values.length !== groups.length) continue
    const pairs = groups.map((columns) => slots.filter((s) => columns.includes(s.column)))
    if (
      !values.every((v, n) => {
        const b = union(pairs[n])
        return (
          /^[−+-]?\d+(?:\.\d+)?(?:\s*\([−–+\d., -]+\))?$/.test(v.text) &&
          v.rect[0] >= b[0] &&
          v.rect[2] <= b[2] &&
          Math.abs((v.rect[0] + v.rect[2] - b[0] - b[2]) / 2) < (b[2] - b[0]) * 0.1
        )
      })
    )
      continue
    removeOverlappingMergeProposals(proposals, slots.slice(1))
    for (const pair of pairs) proposals.push({ slots: pair, origin: 'source-centered-summary' })
    repairs.push(countPairs ? 'count-pair-summary-recovered' : 'grouped-summary-span-recovered')
  }
  const first = baseCells.filter((s) => s.row === 0)
  const owned = items.filter((i) => inside(rows[0].rect, i))
  const bounds = union(first)
  if (
    countPairs &&
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

// Repeated category blocks with arithmetically verified totals establish a
// shared stub's extent, including a short wrapped continuation of its label.
function recoverSubtotalStubSpans({ proposals, baseCells, items, rows, rules, repairs }) {
  const width = baseCells.filter((c) => c.row === 0).length
  if (width < 4) return
  const owned = (row, column) => {
    const slot = baseCells.find((c) => c.row === row && c.column === column)
    return slot
      ? items
          .filter((i) => i.horizontal && inside(slot.rect, i))
          .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
      : []
  }
  const text = (r, c) =>
    owned(r, c)
      .map((i) => i.text)
      .join(' ')
      .trim()
  const blocks = []
  for (let row = 0; row + 2 < rows.length; row++) {
    const rs = [row, row + 1, row + 2]
    if (
      row === 0 ||
      !/^(?:All|Total)$/i.test(text(row + 2, 1)) ||
      !rs.every((r) => /^\d+$/.test(text(r, 2))) ||
      Number(text(row, 2)) + Number(text(row + 1, 2)) !== Number(text(row + 2, 2)) ||
      !rs.every((r) =>
        Array.from({ length: width - 3 }, (_, c) => c + 3).every((c) =>
          /^\d+(?:\.\d+)?%/.test(text(r, c))
        )
      )
    )
      continue
    const label = owned(row, 0),
      tail = owned(row + 1, 0)
    if (
      !label.length ||
      !/\p{L}/u.test(text(row, 0)) ||
      owned(row + 2, 0).length ||
      (tail.length &&
        (tail.length !== 1 ||
          !/^[a-z][a-z -]{0,20}$/u.test(tail[0].text) ||
          (Math.abs(tail[0].rect[0] - label[0].rect[0]) > label[0].height &&
            Math.abs(tail[0].rect[0] + tail[0].rect[2] - label[0].rect[0] - label[0].rect[2]) >
              label[0].height * 0.4) ||
          tail[0].baseline - label.at(-1).baseline > label[0].height * 2))
    )
      continue
    const slots = baseCells.filter((c) => c.column === 0 && rs.includes(c.row)),
      bounds = union(slots)
    if (
      !proposals.some(
        (p) =>
          p.origin === 'model-span' &&
          p.slots.length >= 2 &&
          p.slots.every((s) => slots.includes(s))
      ) ||
      rules.some(
        (r) =>
          r[1] === r[3] &&
          r[1] > label[0].baseline &&
          r[1] < bounds[3] &&
          r[0] <= label[0].rect[0] &&
          r[2] >= Math.max(...label.map((i) => i.rect[2]))
      )
    )
      continue
    blocks.push({ slots, key: rs.map((r) => text(r, 1)).join('|') })
    row += 2
  }
  for (const block of blocks) {
    if (blocks.filter((b) => b.key === block.key).length < 2) continue
    removeOverlappingMergeProposals(proposals, block.slots)
    proposals.push({ slots: block.slots, origin: 'source-category-group' })
    repairs.push('categorical-group-spans-recovered')
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
  const time = (row) => {
    const value = text(row, 1)
    if (/^(?:Pre|Post)$/i.test(value)) return [value, /^Pre$/i.test(value) ? '0' : '1', 'visit']
    return /^(\d+(?:\.\d+)?)\s+(days?|weeks?|months?|years?)$/i.exec(value)
  }
  const complete = (row) =>
    Array.from({ length: columns - 2 }, (_, c) => c + 2).every(
      (column) =>
        /^[<>≤≥−+-]?(?:\d|\.\d)[\d\s.,±()–−+*/%-]*$/.test(text(row, column)) ||
        (column === columns - 1 &&
          columns >= 5 &&
          /^P\s*value$/i.test(text(0, column)) &&
          /^(?:Group|Time)\s*[=<>≤≥]\s*\d/i.test(text(row, column)))
    )
  for (const proposal of proposals) {
    if (
      proposal.origin !== 'model-span' ||
      ![2, 3].includes(proposal.slots.length) ||
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

// Explicit comparison records share one heading across two measured cohorts.
function recoverPairedComparisonStubs({ proposals, baseCells, items, rows, rules, repairs }) {
  if (!items.some((i) => /^Paired\b/i.test(i.text))) return
  const width = Math.max(...baseCells.map((c) => c.column)) + 1
  if (width < 5) return
  const owned = baseCells.map((cell) => items.filter((i) => i.horizontal && inside(cell.rect, i)))
  const text = (r, c) =>
    owned[baseCells.findIndex((s) => s.row === r && s.column === c)]
      ?.map((i) => i.text)
      .join('')
      .replace(/\s/g, '') ?? ''
  const values = rows.map((_, r) => Array.from({ length: width }, (_, c) => text(r, c)))
  const comparison = (s) => /^(?:[—–-]|\d+[<>]\d+(?:;\d+[<>]\d+)*)$/.test(s)
  for (let r = 0; r + 1 < rows.length; r++) {
    const a = values[r],
      b = values[r + 1]
    if (!/^Pairedcomparisons?$/i.test(a[0]) || b[0]) continue
    const c = a.findIndex((s, n) => n > 0 && /^\p{L}+$/u.test(s))
    if (
      c < 1 ||
      c + 1 >= width ||
      !/^\p{L}+$/u.test(b[c]) ||
      a[c] === b[c] ||
      !comparison(a[c + 1]) ||
      !comparison(b[c + 1]) ||
      a.some((s, n) => s && ![0, c, c + 1].includes(n)) ||
      b.some((s, n) => s && ![c, c + 1].includes(n))
    )
      continue
    if (
      ![a[c], b[c]].every((label) =>
        values.some(
          (v) =>
            v[0] === label && v.filter((s) => /^\d+(?:\.\d+)?±\d+(?:\.\d+)?$/.test(s)).length >= 3
        )
      )
    )
      continue
    if (
      rules.some(
        (line) =>
          line[1] === line[3] &&
          line[1] >= rows[r].rect[3] &&
          line[1] <= rows[r + 1].rect[1] &&
          line[0] <= baseCells[0].rect[0] &&
          line[2] >= baseCells[0].rect[2]
      )
    )
      continue
    const slots = baseCells.filter((s) => s.column === 0 && (s.row === r || s.row === r + 1))
    removeOverlappingMergeProposals(proposals, slots)
    proposals.push({ slots, origin: 'text-supported-study-span' })
    repairs.push('source-cell-span-reconciled')
  }
}

// Repeated Mean/Median/IQR/Range blocks share one centered, possibly wrapped
// variable label. Require every statistic and paired value before merging stubs.
function recoverSummaryStatisticStubs({ proposals, baseCells, items, rows, headerRows, repairs }) {
  const width = Math.max(...baseCells.map((c) => c.column)) + 1
  if (width !== 5) return
  const owned = (r, c) => {
    const slot = baseCells.find((s) => s.row === r && s.column === c)
    return slot ? items.filter((i) => i.horizontal && inside(slot.rect, i)) : []
  }
  const text = (r, c) =>
    owned(r, c)
      .map((i) => i.text)
      .join('')
      .replace(/\s/g, '')
  const header = headerRows.find((r) => /^Statisticalmeasures$/i.test(text(r, 1)))
  if (header === undefined || (rows.length - header - 1) % 4) return
  const blocks = []
  for (let r = header + 1; r < rows.length; r += 4) {
    if (
      ['Mean', 'Median', 'IQR', 'Range'].some((label, n) => text(r + n, 1) !== label) ||
      [0, 1, 2, 3].some((n) =>
        [2, 3].some((c) => !/^[<>≤≥−+-]?(?:\d|\.\d)[\d.,–−+/-]*$/.test(text(r + n, c)))
      )
    )
      return
    const slots = baseCells.filter((s) => s.column === 0 && s.row >= r && s.row < r + 4)
    const rect = union(slots)
    const label = items
      .filter((i) => i.horizontal && inside(rect, i))
      .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
    if (
      !label.length ||
      !/\p{L}/u.test(label.map((i) => i.text).join('')) ||
      label.some((i) => !/^[\p{L}\s()+/−-]+$/u.test(i.text))
    )
      return
    const bounds = union(label),
      height = Math.max(...label.map((i) => i.height))
    if (
      bounds[3] - bounds[1] > height * 2.8 ||
      Math.abs(bounds[1] + bounds[3] - rect[1] - rect[3]) > height * 2 ||
      label.some((i, n) => n && i.baseline - label[n - 1].baseline > height * 1.6)
    )
      return
    blocks.push(slots)
  }
  if (blocks.length < 3) return
  for (const slots of blocks) {
    removeOverlappingMergeProposals(proposals, slots)
    proposals.push({ slots, origin: 'text-supported-study-span' })
  }
  repairs.push('source-cell-span-reconciled')
}

// Consecutive ordinal labels and sample-count totals establish a complete
// distribution. A single centered P value then belongs to that whole block,
// provided no native separator or competing value contradicts the span.
function recoverOrdinalGroupStatistics({
  proposals,
  baseCells,
  items,
  rows,
  headerRows,
  rules,
  repairs
}) {
  const width = baseCells.filter((c) => c.row === 0).length
  if (width < 4 || width > 8) return
  const owned = (r, c) => {
    const slot = baseCells.find((s) => s.row === r && s.column === c)
    return slot ? items.filter((i) => i.horizontal && inside(slot.rect, i)) : []
  }
  const text = (r, c) =>
    owned(r, c)
      .map((i) => i.text)
      .join('')
      .replace(/\s/g, '')
  const heading = (c) => headerRows.map((r) => text(r, c)).join('')
  if (!/^P(?:-?value)?[a-z]?$/i.test(heading(width - 1))) return
  const samples = Array.from({ length: width - 2 }, (_, n) =>
    Number(/n=(\d+)/i.exec(heading(n + 1))?.[1])
  )
  if (samples.some((n) => !Number.isInteger(n) || n <= 0)) return
  const ordinal = (r) => {
    const label = owned(r, 0)
      .map((i) => i.text)
      .join(' ')
      .trim()
    const m = /^([\p{L} -]+?)\s+(I|II|III|IV|V|VI|[1-6])(?:\s*\([^)]*\))?$/u.exec(label)
    if (!m) return undefined
    return {
      label: m[1],
      index: /^\d$/.test(m[2])
        ? Number(m[2])
        : ['I', 'II', 'III', 'IV', 'V', 'VI'].indexOf(m[2]) + 1
    }
  }
  for (let first = 0; first < rows.length; first++) {
    const start = ordinal(first)
    if (!start || start.index !== 1 || headerRows.includes(first)) continue
    let end = first + 1
    while (end < rows.length && !headerRows.includes(end)) {
      const next = ordinal(end)
      if (next?.label !== start.label || next.index !== end - first + 1) break
      end++
    }
    if (end - first < 3 || end - first > 6) continue
    const records = Array.from({ length: end - first }, (_, n) => n + first)
    const complete = samples.every((sample, n) => {
      const values = records.map((r) => /^(\d+)\((\d+(?:\.\d+)?)%\)$/.exec(text(r, n + 1)))
      return (
        values.every((v) => v && Math.abs(Number(v[2]) - (Number(v[1]) * 100) / sample) <= 1) &&
        values.reduce((sum, v) => sum + Number(v[1]), 0) === sample
      )
    })
    if (!complete) continue
    const slots = baseCells.filter((s) => s.column === width - 1 && records.includes(s.row))
    const rect = union(slots)
    const source = items.filter((i) => i.horizontal && inside(rect, i))
    const values = source.filter((i) => !source.some((a) => a !== i && isAdjacentTableScript(i, a)))
    if (values.length !== 1 || !/^(?:0?\.\d+|1(?:\.0+)?)$/.test(values[0].text.trim())) continue
    const value = values[0]
    const firstText = owned(first, 1),
      lastText = owned(end - 1, 1)
    if (!firstText.length || !lastText.length) continue
    if (
      Math.abs(value.baseline - (firstText[0].baseline + lastText[0].baseline) / 2) >
        value.height * 0.4 ||
      rules.some(
        (r) => r[1] === r[3] && r[1] > rect[1] && r[1] < rect[3] && r[0] < rect[2] && r[2] > rect[0]
      ) ||
      proposals.some((p) => p.slots.some((s) => slots.includes(s)))
    )
      continue
    proposals.push({ slots, origin: 'source-category-group' })
    repairs.push('grouped-summary-span-recovered')
  }
}

// A categorical block repeats complete count/percentage records under one
// top-aligned label. Blank value cells are not sufficient evidence for a span.
function recoverCategoricalGroupSpans({ proposals, baseCells, items, rows, headerRows, repairs }) {
  const width = Math.max(...baseCells.map((cell) => cell.column)) + 1
  if (width < 5) return
  const owned = (r, c) => {
    const slot = baseCells.find((cell) => cell.row === r && cell.column === c)
    return slot ? items.filter((item) => item.horizontal && inside(slot.rect, item)) : []
  }
  const text = (r, c) =>
    owned(r, c)
      .map((item) => item.text)
      .join('')
      .trim()
  const categoryHeader = rows.findIndex((_, r) => r < 3 && /^Category$/i.test(text(r, 1)))
  const pairedHeader = rows.findIndex(
    (_, r) =>
      r < 3 &&
      width === 7 &&
      [2, 4].every((c) => /^Count$/i.test(text(r, c)) && text(r, c + 1) === '%')
  )
  const cohortHeader = rows.findIndex(
    (_, r) =>
      r < 3 &&
      width === 5 &&
      !text(r, 0) &&
      !text(r, 1) &&
      [2, 3].every((c) => /\(n\s*=\s*\d+\)/i.test(text(r, c))) &&
      /^p-?value$/i.test(text(r, 4).replace(/\s/g, ''))
  )
  const measureHeader = rows.findIndex(
    (_, r) =>
      r < 2 &&
      /^(?:Cutoffvalue|Measure|Parameter)$/i.test(text(r, 1).replace(/\s/g, '')) &&
      rows
        .slice(r + 1)
        .filter((_, n) => /^(?:[A-Za-z]+)(?:max|mean|min)\s*\d/.test(text(r + n + 1, 1))).length >=
        4
  )
  const header = Math.max(categoryHeader, pairedHeader, cohortHeader, measureHeader)
  if (header < 0) return
  const recordColumns = (r) =>
    Array.from({ length: width - 2 }, (_, n) => n + 2).filter((c) =>
      /^\d+(?:\.\d+)?(?:%|\s*\(\d+(?:\.\d+)?%?\))$/.test(text(r, c))
    )
  for (let first = 0; first < rows.length; first++) {
    if (headerRows.includes(first) || !/\p{L}/u.test(text(first, 0)) || !text(first, 1)) continue
    const columns = recordColumns(first)
    if (columns.length < 2) continue
    let end = first + 1
    while (
      end < rows.length &&
      !headerRows.includes(end) &&
      (!text(end, 0) ||
        (categoryHeader >= 0 &&
          /^\([^)]*\)$/.test(text(end, 0)) &&
          proposals.some(
            (p) =>
              p.slots.every((s) => s.column === 0) &&
              p.slots.some((s) => s.row === first) &&
              p.slots.some((s) => s.row === end)
          ))) &&
      text(end, 1) &&
      columns.every((column) => recordColumns(end).includes(column))
    )
      end++
    if (end - first < 2 || end - first > 8) continue
    const label = owned(first, 0)
    if (
      !label.length ||
      label.some(
        (item) => item.baseline >= owned(first + 1, columns[0])[0].baseline - item.height * 0.35
      )
    )
      continue
    const targets = [0]
    // Only trailing columns explicitly headed as group statistics share the
    // block label's scope. Preserve independent numeric columns and row tests.
    for (let c = Math.max(...columns) + 1; c < width; c++) {
      const heading = rows
        .slice(0, header + 1)
        .map((_, r) => text(r, c))
        .join('')
        .replace(/\s/g, '')
      if (
        /^(?:P(?:-?value)?|F\/[Xχ]2)$/i.test(heading) &&
        Array.from({ length: end - first }, (_, n) => n + first).filter((r) => text(r, c))
          .length === 1
      )
        targets.push(c)
    }
    for (const column of targets) {
      const slots = baseCells.filter(
        (cell) => cell.column === column && cell.row >= first && cell.row < end
      )
      removeOverlappingMergeProposals(proposals, slots)
      proposals.push({ slots, origin: 'source-category-group' })
    }
    repairs.push('categorical-group-spans-recovered')
    first = end - 1
  }
}

// Outdented sections can occupy empty cohort columns while their statistics
// stay in explicitly headed P-value columns. Require repeated indented count
// records and matching section layouts before replacing the model's ownership.
function recoverProbabilitySectionStubs({
  proposals,
  baseCells,
  items,
  rows,
  headerRows,
  repairs
}) {
  const slotsAt = (r) => baseCells.filter((c) => c.row === r).sort((a, b) => a.column - b.column)
  const owned = (s) => items.filter((i) => i.horizontal && inside(s.rect, i))
  const text = (s) =>
    owned(s)
      .map((i) => i.text)
      .join('')
      .replace(/\s/g, '')
  const heading = slotsAt(headerRows.at(-1))
  const probabilities = heading
    .filter((s) => /^P-?value[a-z]?$/i.test(text(s)))
    .map((s) => s.column)
  const first = probabilities[0]
  if (probabilities.length < 2 || first < 2) return
  const candidates = []
  for (let r = 0; r < rows.length - 2; r++) {
    if ([r, r + 1, r + 2].some((n) => headerRows.includes(n))) continue
    const slots = slotsAt(r)
    if (slots.length !== heading.length) continue
    const labelSlots = slots.slice(0, first)
    const label = items
      .filter((i) => i.horizontal && inside(union(labelSlots), i))
      .sort((a, b) => a.rect[0] - b.rect[0])
    const anchor = label[0]
    if (
      !anchor ||
      !/\p{L}/u.test(anchor.text) ||
      anchor.rect[0] - slots[0].rect[0] > anchor.height ||
      label.some((i) => i.rect[2] >= slots[first].rect[0]) ||
      label.slice(1).some((i, n) => {
        const previous = label[n]
        return (
          !(
            Math.abs(i.baseline - previous.baseline) < anchor.height * 0.3 &&
            /\p{L}/u.test(i.text) &&
            i.rect[0] - previous.rect[2] < anchor.height * 0.4
          ) &&
          !(
            isAdjacentTableScript(i, previous) ||
            (/^[a-z]$/.test(i.text) &&
              i.height <= previous.height * 1.1 &&
              previous.baseline - i.baseline > previous.height * 0.5 &&
              previous.baseline - i.baseline < previous.height * 0.7 &&
              i.rect[0] - previous.rect[2] >= 0 &&
              i.rect[0] - previous.rect[2] < previous.height * 0.25)
          )
        )
      }) ||
      slots
        .slice(first)
        .some((s) =>
          probabilities.includes(s.column)
            ? !/^(?:[<>≤≥]?0?\.\d+|1(?:\.0+)?|N\/A)$/.test(text(s))
            : owned(s).length
        )
    )
      continue
    if (
      ![r + 1, r + 2].every((n) => {
        const next = slotsAt(n),
          stub = owned(next[0])
        return (
          next.length === slots.length &&
          stub.length &&
          /\p{L}/u.test(text(next[0])) &&
          Math.min(...stub.map((i) => i.rect[0])) - anchor.rect[0] >= anchor.height * 0.5 &&
          next
            .slice(1)
            .every((s) =>
              probabilities.includes(s.column)
                ? !owned(s).length
                : /^\d+\(\d+(?:\.\d+)?%?\)$/.test(text(s))
            )
        )
      })
    )
      continue
    candidates.push({ slots: labelSlots, left: anchor.rect[0], height: anchor.height })
  }
  if (
    candidates.length < 3 ||
    candidates.some((c) => Math.abs(c.left - candidates[0].left) > c.height * 0.3)
  )
    return
  for (const { slots } of candidates) {
    removeOverlappingMergeProposals(proposals, slots)
    proposals.push({ slots, origin: 'source-ruled-stub' })
  }
  repairs.push('source-cell-span-reconciled')
}

// Paired cohort summaries and effect intervals independently establish the
// scope of indented clinical sections, including attached footnote markers.
function recoverClinicalSectionSpans({ proposals, baseCells, items, rows, headerRows, repairs }) {
  const slotsAt = (r) => baseCells.filter((cell) => cell.row === r)
  const owned = (slot) => items.filter((i) => i.horizontal && inside(slot.rect, i))
  const text = (slot) =>
    owned(slot)
      .map((i) => i.text)
      .join('')
      .replace(/\s/g, '')
  const headings = slotsAt(headerRows[0]).map(text)
  if (headings.length !== 5 || !headings[3].includes('CI') || !/^P-?Value$/i.test(headings[4]))
    return
  const candidates = []
  for (let r = 0; r < rows.length - 2; r++) {
    if (headerRows.includes(r)) continue
    const slots = slotsAt(r),
      label = owned(slots[0])
    if (
      !label.length ||
      !/\p{L}/u.test(text(slots[0])) ||
      slots.slice(1).some((s) => owned(s).length)
    )
      continue
    const start = Math.min(...label.map((i) => i.rect[0])),
      height = Math.max(...label.map((i) => i.height))
    if (
      ![r + 1, r + 2].every((next) => {
        const cells = slotsAt(next),
          stub = owned(cells[0]),
          values = cells.map(text)
        return (
          !headerRows.includes(next) &&
          stub.length &&
          /\p{L}/u.test(values[0]) &&
          Math.min(...stub.map((i) => i.rect[0])) >= start + height * 0.5 &&
          values.slice(1, 3).every((s) => /^\d[\d.()%–−+\-/]*(?:\(N=\d+\))?$/i.test(s)) &&
          /^(?:RR|HR|MedianD)=[−+–-]?\d[\d.()%–−+\-/]*$/.test(values[3]) &&
          /^[<>≤≥]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(values[4])
        )
      })
    )
      continue
    candidates.push(slots)
  }
  if (candidates.length < 3) return
  for (const slots of candidates) {
    removeOverlappingMergeProposals(proposals, slots)
    proposals.push({ slots, origin: 'source-section' })
  }
  repairs.push('source-cell-span-reconciled')
}

// Native full-width borders and repeated outdented headings can establish a
// missing section span. Existing peer spans alone are insufficient: every
// candidate must precede a complete, indented numeric record with no divider.
function recoverRuledSectionHeadings({
  proposals,
  baseCells,
  items,
  rows,
  headerRows,
  rules,
  repairs
}) {
  const slotsAt = (r) => baseCells.filter((cell) => cell.row === r)
  const candidates = []
  for (let r = 0; r < rows.length - 1; r++) {
    if (headerRows.includes(r) || headerRows.includes(r + 1)) continue
    const slots = slotsAt(r),
      nextSlots = slotsAt(r + 1)
    if (slots.length < 3 || nextSlots.length !== slots.length) continue
    const label = items.filter((i) => inside(rows[r].rect, i)),
      next = items.filter((i) => inside(rows[r + 1].rect, i)),
      stub = next.filter((i) => inside(nextSlots[0].rect, i))
    if (
      !label.length ||
      !stub.length ||
      !label.every((i) => i.horizontal && inside(slots[0].rect, i)) ||
      !/^\p{L}[\p{L}\s,()/–-]*$/u.test(label.map((i) => i.text).join(' ')) ||
      !stub.some((i) => /\p{L}/u.test(i.text)) ||
      next.some((i) => !i.horizontal || !nextSlots.some((s) => inside(s.rect, i))) ||
      !nextSlots.slice(1).every((s) =>
        /^\d[\d.,()%±–−+\s/-]*$/.test(
          next
            .filter((i) => inside(s.rect, i))
            .map((i) => i.text)
            .join('')
        )
      )
    )
      continue
    const ink = union(label),
      child = union(stub),
      height = Math.max(...label.map((i) => i.height)),
      indent = child[0] - ink[0],
      left = slots[0].rect[0],
      right = slots.at(-1).rect[2]
    const ruled = rules.some(
      (rule) =>
        rule[1] === rule[3] &&
        rule[1] >= ink[3] &&
        rule[1] <= union(next)[1] &&
        Math.abs(rule[0] - left) < height &&
        Math.abs(rule[2] - right) < height
    )
    if (
      indent < height * 0.5 ||
      indent > height * 2 ||
      ink[3] - union(next)[1] > height * 0.05 ||
      union(next)[1] - ink[3] > height * 1.5 ||
      label.some((i) => Math.abs(i.baseline - label[0].baseline) > height * 0.2) ||
      rules.some(
        (rule) =>
          rule[0] === rule[2] &&
          rule[0] > ink[2] &&
          rule[0] < right &&
          rule[1] < ink[3] &&
          rule[3] > ink[1]
      )
    )
      continue
    const existing = proposals.some(
      (p) => p.slots.length === slots.length && slots.every((s) => p.slots.includes(s))
    )
    const partial = proposals.some(
      (p) => p.slots.length >= slots.length - 1 && p.slots.every((s) => slots.includes(s))
    )
    candidates.push({ slots, ink, height, indent, existing, partial, ruled })
  }
  for (const candidate of candidates) {
    if (candidate.existing) continue
    const peers = candidates.filter(
      (c) =>
        Math.abs(c.ink[0] - candidate.ink[0]) < candidate.height * 0.2 &&
        Math.abs(c.height - candidate.height) < candidate.height * 0.1 &&
        Math.abs(c.indent - candidate.indent) < candidate.height * 0.2
    )
    const left = candidate.slots[0].rect[0],
      right = candidate.slots.at(-1).rect[2]
    const frame = joinHorizontalTableRules(rules).filter(
      (r) => Math.abs(r[0] - left) < candidate.height && Math.abs(r[2] - right) < candidate.height
    )
    const enclosed =
      frame.some((r) => r[1] < candidate.ink[1]) && frame.some((r) => r[1] > candidate.ink[3])
    if (
      peers.length < 3 ||
      peers.filter((c) => c.existing || (enclosed && c.partial)).length < 2 ||
      (!candidate.ruled &&
        (!enclosed || peers.length < 5 || peers.filter((c) => c.partial).length < 3))
    )
      continue
    removeOverlappingMergeProposals(proposals, candidate.slots)
    proposals.push({ slots: candidate.slots, origin: 'source-section' })
    repairs.push('source-cell-span-reconciled')
  }
}

// An oversized model header can swallow the first group of a repeated body.
// Matching indented record labels and populated statistic columns identify its
// scope independently; a native header border is required for header overrides.
function recoverRepeatedRecordSections({
  proposals,
  baseCells,
  items,
  rows,
  headerRows,
  rules,
  repairs
}) {
  const slotsAt = (r) => baseCells.filter((s) => s.row === r)
  const tokensAt = (r) => items.filter((i) => inside(rows[r].rect, i))
  const compact = (tokens) =>
    tokens
      .map((i) => i.text)
      .join('')
      .replace(/\s/g, '')
  const candidates = []
  for (let r = 0; r < rows.length - 3; r++) {
    const slots = slotsAt(r),
      label = tokensAt(r)
    if (
      slots.length < 3 ||
      !label.length ||
      !label.every((i) => i.horizontal && inside(slots[0].rect, i)) ||
      !/^\p{L}[\p{L}\s,()/–-]*$/u.test(compact(label))
    )
      continue
    const ink = union(label),
      height = Math.max(...label.map((i) => i.height))
    if (label.some((i) => Math.abs(i.baseline - label[0].baseline) > height * 0.2)) continue
    if (
      rules.some(
        (rule) =>
          rule[0] === rule[2] &&
          rule[0] > ink[2] &&
          rule[0] < slots.at(-1).rect[2] &&
          rule[1] < ink[3] &&
          rule[3] > ink[1]
      )
    )
      continue
    const records = []
    for (let n = r + 1; n < rows.length; n++) {
      const cells = slotsAt(n),
        tokens = tokensAt(n)
      if (
        cells.length !== slots.length ||
        !tokens.length ||
        tokens.some((i) => !i.horizontal || cells.filter((c) => inside(c.rect, i)).length !== 1)
      )
        break
      const fields = cells.map((c) => tokens.filter((i) => inside(c.rect, i))),
        values = fields.map(compact)
      if (
        !/^\p{L}/u.test(values[0]) ||
        !values
          .slice(1)
          .every((v) =>
            /^(?:[<>≤≥−+-]?\d[\d.,·()%±–−+\s/=<>≤≥-]*(?:ref|p[=<>≤≥][\d.·]+)?\)?|[.·]{2,3})$/i.test(
              v
            )
          )
      )
        break
      const stub = union(fields[0]),
        indent = stub[0] - ink[0]
      if (
        indent < height * 0.5 ||
        indent > height * 2 ||
        tokens.some((i) => Math.abs(i.baseline - fields[0][0].baseline) > height * 0.2)
      )
        break
      records.push(values[0])
    }
    if (records.length < 3 || new Set(records).size !== records.length) continue
    const existing = proposals.some(
      (p) => p.slots.length === slots.length && slots.every((s) => p.slots.includes(s))
    )
    candidates.push({ slots, ink, height, signature: records.join('|'), existing })
  }
  for (const c of candidates) {
    if (c.existing) continue
    const peers = candidates.filter(
      (p) =>
        p.signature === c.signature &&
        Math.abs(p.ink[0] - c.ink[0]) < c.height * 0.2 &&
        Math.abs(p.height - c.height) < c.height * 0.1
    )
    if (peers.length < 3 || peers.filter((p) => p.existing).length < 2) continue
    if (headerRows.includes(c.slots[0].row)) {
      const border = joinHorizontalTableRules(rules).find(
        (rule) =>
          rule[1] < c.ink[1] &&
          c.ink[1] - rule[1] < c.height * 3 &&
          Math.abs(rule[0] - c.slots[0].rect[0]) < c.height &&
          Math.abs(rule[2] - c.slots.at(-1).rect[2]) < c.height
      )
      if (
        !border ||
        items.some(
          (i) =>
            i.rect[1] < border[1] &&
            i.rect[3] > border[1] &&
            inside([border[0], i.rect[1], border[2], i.rect[3]], i)
        )
      )
        continue
    }
    removeOverlappingMergeProposals(proposals, c.slots)
    proposals.push({ slots: c.slots, origin: 'source-section' })
    repairs.push('source-cell-span-reconciled')
  }
}

// A title enclosed by two complete native rules owns the whole band. All
// remaining cells must be empty and no internal vertical divider may cross
// the text. This includes opening titles as well as body section headings.
function recoverEnclosedSectionSpans({ proposals, baseCells, items, rows, rules, repairs }) {
  const horizontal = joinHorizontalTableRules(rules)
  for (let row = 0; row < rows.length; row++) {
    const slots = baseCells.filter((c) => c.row === row)
    if (slots.length < 3) continue
    const members = items.filter((i) => inside(rows[row].rect, i))
    if (!members.length || members.some((i) => !i.horizontal || !/\p{L}/u.test(i.text))) continue
    const ink = union(members),
      height = Math.max(...members.map((i) => i.height))
    if (members.some((i) => Math.abs(i.baseline - members[0].baseline) > height * 0.2)) continue
    if (!members.every((i) => inside(slots[0].rect, i))) continue
    const left = slots[0].rect[0],
      right = slots.at(-1).rect[2]
    const edges = horizontal.filter(
      (r) => Math.abs(r[0] - left) < height && Math.abs(r[2] - right) < height
    )
    const top = Math.max(...edges.filter((r) => r[1] <= ink[1]).map((r) => r[1]))
    const bottom = Math.min(...edges.filter((r) => r[1] >= ink[3]).map((r) => r[1]))
    if (
      !Number.isFinite(top) ||
      !Number.isFinite(bottom) ||
      ink[1] - top > height ||
      bottom - ink[3] > height ||
      items.some((i) => inside([left, top, right, bottom], i) && !members.includes(i)) ||
      rules.some(
        (r) => r[0] === r[2] && r[0] > left && r[0] < right && r[1] < ink[3] && r[3] > ink[1]
      ) ||
      proposals.some(
        (p) => p.slots.length === slots.length && slots.every((s) => p.slots.includes(s))
      )
    )
      continue
    removeOverlappingMergeProposals(proposals, slots)
    proposals.push({ slots, origin: 'source-section' })
    repairs.push('source-cell-span-reconciled')
  }
}

// Repeated indented threshold records identify otherwise identical section
// headings, even when the detector only proposed a subset of their colspans.
function recoverThresholdSectionSpans({ proposals, baseCells, items, rows, headerRows, repairs }) {
  const candidates = []
  const repeated = []
  for (let r = 0; r < rows.length - 1; r++) {
    if (headerRows.includes(r)) continue
    const slots = baseCells.filter((cell) => cell.row === r)
    const text = items.filter((item) => item.horizontal && inside(rows[r].rect, item))
    if (
      slots.length < 5 ||
      !text.length ||
      !text.every((item) => inside(slots[0].rect, item)) ||
      !text.some((item) => /\p{L}/u.test(item.text))
    )
      continue
    const nextSlots = baseCells.filter((cell) => cell.row === r + 1)
    const next = items.filter((item) => item.horizontal && inside(rows[r + 1].rect, item))
    const stub = next.filter(
      (item) =>
        inside(nextSlots[0].rect, item) &&
        !text.some((anchor) => isAdjacentTableScript(item, anchor))
    )
    const numericSequence = []
    for (let n = r + 1; n < rows.length; n++) {
      const cells = baseCells.filter((c) => c.row === n)
      const values = cells.map((c) =>
        items
          .filter((i) => i.horizontal && inside(c.rect, i))
          .map((i) => i.text)
          .join('')
          .replace(/\s/g, '')
      )
      if (cells.length !== slots.length || !values.every((v) => /^\d+(?:\.\d+)?%?$/.test(v))) break
      numericSequence.push(values[0])
    }
    if (
      numericSequence.length >= 3 &&
      new Set(numericSequence).size === numericSequence.length &&
      Math.min(...stub.map((i) => i.rect[0])) - Math.min(...text.map((i) => i.rect[0])) >
        text[0].height * 0.5
    ) {
      repeated.push({
        slots,
        signature: numericSequence.join('|'),
        existing: proposals.some(
          (p) => p.slots.length === slots.length && p.slots.every((s) => slots.includes(s))
        )
      })
    }
    if (
      !/^[<>≤≥]/.test(stub.map((item) => item.text).join('')) ||
      Math.min(...stub.map((item) => item.rect[0])) -
        Math.min(...text.map((item) => item.rect[0])) <
        text[0].height * 0.5 ||
      nextSlots
        .slice(1)
        .filter((cell) => next.some((item) => inside(cell.rect, item) && /^\d/.test(item.text)))
        .length < 2
    )
      continue
    candidates.push(slots)
  }
  const supported = repeated.filter((c) =>
    repeated.some((p) => p !== c && p.existing && p.signature === c.signature)
  )
  const selected = [...(candidates.length >= 3 ? candidates : []), ...supported.map((c) => c.slots)]
  if (!selected.length) return
  for (const slots of selected) {
    removeOverlappingMergeProposals(proposals, slots)
    proposals.push({ slots, origin: 'source-section' })
  }
  repairs.push('threshold-section-spans-recovered')
}

// Repeated n/mean(SD) and change(SE)/P pairs can prove columns independently
// of overlapping predictions. Every source token, header pair and complete
// record must agree; missing values or overlapping source rows stay unresolved.
export function reconcileSummaryRecordColumns({
  cells,
  rows,
  columns,
  headerRows,
  items,
  unassigned,
  issues,
  repairs
}) {
  if (
    unassigned.length ||
    headerRows.join(',') !== '0,1' ||
    columns.length < 7 ||
    columns.length % 2 !== 1 ||
    rows.length < 8
  )
    return
  if (
    [...issues].some(
      (s) => !['overlapping-predicted-columns', 'span-conflicts-with-source-columns'].includes(s)
    ) ||
    !issues.size
  )
    return
  const at = (r) => cells.filter((c) => c.row === r).sort((a, b) => a.column - b.column)
  const leaf = at(1),
    parents = at(0),
    roles = []
  if (leaf.length !== columns.length || cells.some((c) => c.rowSpan !== 1)) return
  const compact = (s) => s.replace(/\s/g, '')
  for (let c = 1; c < columns.length; c += 2) {
    const a = compact(leaf[c].text),
      b = compact(leaf[c + 1].text)
    if (a === 'n' && /^(?:Value,)?mean\(SD\)$/i.test(b)) roles.push('sample')
    else if (/^(?:Value,)?meanchange\(SE\)$/i.test(a) && /^P-?value$/i.test(b)) roles.push('change')
    else return
    if (!parents.some((p) => p.column === c && p.colSpan === 2 && /\p{L}/u.test(p.text))) return
  }
  if (roles.filter((r) => r === 'sample').length < 2 || !roles.includes('change')) return
  const summary = /^[−–+-]?\d+(?:\.\d+)?\([−–+-]?\d+(?:\.\d+)?\)$/
  const missing = /^N\/A[a-z]?$/
  let records = 0,
    sections = 0
  for (let r = 2; r < rows.length; r++) {
    const group = at(r)
    if (
      group.length === 1 &&
      group[0].column === 0 &&
      group[0].colSpan === columns.length &&
      /\p{L}/u.test(group[0].text)
    ) {
      sections++
      continue
    }
    if (
      group.length !== columns.length ||
      group.some((c) => c.colSpan !== 1) ||
      !/\p{L}/u.test(group[0].text)
    )
      return
    for (let n = 0; n < roles.length; n++) {
      const a = compact(group[1 + n * 2].text),
        b = compact(group[2 + n * 2].text)
      if (
        roles[n] === 'sample'
          ? !/^\d+$/.test(a) || !summary.test(b)
          : !(
              (summary.test(a) && /^[<>≤≥]?(?:0?\.\d+|1(?:\.0+)?)$/.test(b)) ||
              (missing.test(a) && missing.test(b))
            )
      )
        return
    }
    records++
  }
  if (records < 6 || sections < 2) return
  const tokens = cells.flatMap((c) => c.sourceTokens),
    key = (i) => JSON.stringify([i.text, i.rect])
  const owned = new Set(tokens.map(key))
  if (
    tokens.length !== items.length ||
    owned.size !== tokens.length ||
    items.some((i) => !owned.has(key(i)))
  )
    return
  if (cells.some((c) => c.sourceTokens.some((i) => i.rect[0] < c.rect[0] || i.rect[2] > c.rect[2])))
    return
  const bounds = rows.map((_, r) => union(at(r).flatMap((c) => c.sourceTokens)))
  if (bounds.some((b, r) => !Number.isFinite(b[1]) || (r && b[1] <= bounds[r - 1][3]))) return
  for (let r = 0; r < rows.length; r++) {
    rows[r].rect = [rows[r].rect[0], bounds[r][1], rows[r].rect[2], bounds[r][3]]
    for (const cell of at(r)) cell.rect = [cell.rect[0], bounds[r][1], cell.rect[2], bounds[r][3]]
  }
  issues.delete('overlapping-predicted-columns')
  issues.delete('span-conflicts-with-source-columns')
  repairs.push('source-record-boundary-restored')
}

// Validate predictions that missed the model grid against final source ownership.
// A repaired cell may span several model slots; empty separator predictions carry
// no content. Independent numeric records or a ruled header boundary forbid a merge.
export function reconcileUnresolvedTableSpans({
  spans,
  cells,
  items,
  rows,
  rules,
  issues,
  repairs
}) {
  for (const span of spans) {
    const source = items.filter((item) => intersect(span.rect, item.rect) > 0)
    const owners = source.map((item) =>
      cells.filter((cell) =>
        cell.sourceTokens.some((token) => token.rect === item.rect && token.text === item.text)
      )
    )
    if (source.length && owners.every((owner) => owner.length === 1)) {
      const unique = [...new Set(owners.flat())].sort(
        (a, b) => a.row - b.row || a.column - b.column
      )
      if (unique.length === 1) {
        repairs.push('source-cell-span-reconciled')
        continue
      }
      const numeric = unique.every(
        (cell) =>
          /^[()\s<>≤≥−–+-]*\d/.test(cell.text) && !/[\p{L}]/u.test(cell.text.replace(/\bto\b/g, ''))
      )
      const sectionRecord = (() => {
        const ownerRows = [...new Set(unique.map((cell) => cell.row))]
        if (ownerRows.length !== 2 || ownerRows[1] !== ownerRows[0] + 1) return false
        const section = unique.find(
          (cell) =>
            cell.row === ownerRows[0] &&
            cell.column === 0 &&
            /\p{L}/u.test(cell.text) &&
            !/^[<>≤≥−–+-]?(?:\d|\.\d)/.test(cell.text.trim())
        )
        const record = unique.filter((cell) => cell.row === ownerRows[1] && cell.column > 0)
        return (
          !!section &&
          record.length >= 2 &&
          record.every(
            (cell) => cell.column > 0 && /^[<>≤≥−–+-]?(?:\d|\.\d)/.test(cell.text.trim())
          )
        )
      })()
      const ruled = unique.every(
        (cell, index) =>
          !index ||
          rules.some(
            (r) =>
              r[1] === r[3] &&
              r[0] <= span.rect[0] &&
              r[2] >= span.rect[2] &&
              r[1] > Math.max(...unique[0].sourceTokens.map((t) => t.rect[3])) &&
              r[1] < Math.min(...cell.sourceTokens.map((t) => t.rect[1]))
          )
      )
      // A repeated, outdented sample heading starts a new analysis population.
      // Its two independent cohort counts distinguish it from a wrapped label.
      const last = unique.at(-1),
        first = unique[0]
      const sampleHeading =
        unique.length === 2 &&
        unique.every((c) => c.column === 0) &&
        first.text.length > 50 &&
        last.text.length < 40 &&
        last.row > first.row &&
        Math.min(...first.sourceTokens.map((t) => t.rect[0])) -
          Math.min(...last.sourceTokens.map((t) => t.rect[0])) >
          last.sourceTokens[0].height * 0.5 &&
        cells.filter(
          (c) =>
            c.column === 0 &&
            c.text === last.text &&
            cells.filter((v) => v.row === c.row && v.column > 0 && /^\d+$/.test(v.text)).length >= 2
        ).length >= 2
      // Complete source-rebuilt records own their stubs independently, even
      // where a model span crosses a section or two labelled follow-up rows.
      const rebuiltRecords =
        rows.filter((r) => r.origin === 'source-text' && r.numericRecord).length >= 6 &&
        unique.every(
          (c) =>
            c.column === 0 &&
            rows[c.row].origin === 'source-text' &&
            (rows[c.row].numericRecord || rows[c.row].section)
        )
      if (numeric || sectionRecord || ruled || sampleHeading || rebuiltRecords) {
        repairs.push('source-separated-model-span-discarded')
        continue
      }
    }
    if (
      !source.length &&
      rows.some((row) => row.rect[3] <= span.rect[1]) &&
      rows.some((row) => row.rect[1] >= span.rect[3])
    ) {
      repairs.push('empty-model-span-discarded')
      continue
    }
    issues.add('unresolved-spanning-cells')
  }
}

// Repeated native leaf labels establish equal parent groups even when the model
// omits a short last leaf or merges a parent vertically into one of its children.
function recoverRepeatedLeafParents({
  proposals,
  baseCells,
  items,
  rows,
  headerRows,
  rules,
  repairs
}) {
  const width = baseCells.filter((c) => c.row === 0).length
  const slots = (row, start, end) =>
    baseCells.filter((c) => c.row === row && c.column >= start && c.column < end)
  const owned = (cells) =>
    cells.length ? items.filter((i) => i.horizontal && inside(union(cells), i)) : []
  const text = (values) =>
    values
      .slice()
      .sort((a, b) =>
        Math.abs(a.rect[1] - b.rect[1]) < Math.min(a.height, b.height) * 0.4
          ? a.rect[0] - b.rect[0]
          : a.rect[1] - b.rect[1]
      )
      .map((i) => i.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
  const replace = (cells) => {
    removeOverlappingMergeProposals(proposals, cells)
    proposals.push({ slots: cells, origin: 'source-ruled-stub' })
  }
  for (let row = 0; row < Math.min(3, rows.length - 1); row++) {
    if (row > 0 && (!headerRows.includes(row) || !headerRows.includes(row + 1))) continue
    const leaves = Array.from({ length: width - 1 }, (_, n) =>
      text(owned(slots(row + 1, n + 1, n + 2)))
    )
    if (!leaves.every((t) => /\p{L}/u.test(t) || t === '%')) continue
    for (let size = 2; size <= Math.min(6, leaves.length / 2); size++) {
      if (leaves.length % size || !leaves.every((t, n) => t === leaves[n % size])) continue
      const groups = []
      for (let start = 1; start < width; start += size) {
        const parentSlots = slots(row, start, start + size),
          parent = owned(parentSlots)
        if (!parent.length || !/\p{L}/u.test(text(parent))) break
        const rect = union(parent),
          leaf = union(owned(slots(row + 1, start, start + size)))
        const h = Math.max(...parent.map((i) => i.height))
        const band = union(parentSlots)
        const sampleQualified = /\(n\s*=\s*\d+\)$/i.test(text(parent))
        if (
          rules.some(
            (r) =>
              r[0] === r[2] &&
              r[0] > band[0] + 1 &&
              r[0] < band[2] - 1 &&
              r[1] < band[3] &&
              r[3] > band[1]
          )
        )
          break
        if (
          rect[3] - rect[1] > h * (sampleQualified ? 2.8 : 1.6) ||
          rect[0] < parentSlots[0].rect[0] - h ||
          rect[2] > parentSlots.at(-1).rect[2] + h
        )
          break
        if (
          Math.abs((rect[0] + rect[2] - leaf[0] - leaf[2]) / 2) > h * 2.5 &&
          Math.abs(rect[0] - leaf[0]) > h
        )
          break
        if (
          !rules.some(
            (r) =>
              r[1] === r[3] &&
              r[1] >= rect[3] &&
              r[1] <= leaf[1] &&
              r[0] <= rect[0] + h &&
              r[2] >= rect[2] - h
          )
        )
          break
        groups.push({ start, parentSlots })
      }
      if (groups.length !== leaves.length / size) continue
      for (const group of groups) replace(group.parentSlots)
      for (const r of [row, row + 1]) if (!headerRows.includes(r)) headerRows.push(r)
      // Centered sample-size subheaders belong to those same paired/grouped
      // columns, rather than becoming unrelated fragments in each leaf column.
      if (headerRows.includes(row + 2)) {
        const samples = groups.map((g) => slots(row + 2, g.start, g.start + size))
        if (samples.every((cells) => /^n\s*=\s*\d+$/i.test(text(owned(cells))))) {
          for (const cells of samples) replace(cells)
        }
      }
      repairs.push('header-span-inferred')
      break
    }
  }
  // A ruled empty intermediate group with populated leaves is an unbranched
  // parent, provided exactly one source heading occupies the same upper group.
  for (const proposal of proposals.slice()) {
    const group = proposal.slots,
      row = group[0]?.row
    if (
      !row ||
      !group.every((c) => c.row === row) ||
      group.length < 2 ||
      owned(group).length ||
      ![row - 1, row, row + 1].every((r) => headerRows.includes(r))
    )
      continue
    const start = Math.min(...group.map((c) => c.column)),
      end = Math.max(...group.map((c) => c.column)) + 1
    if (start === 0 || group.length !== end - start) continue
    const parent = slots(row - 1, start, end),
      labels = owned(parent)
    const leaves = slots(row + 1, start, end)
    if (
      labels.length !== 1 ||
      !/\p{L}/u.test(labels[0].text) ||
      !leaves.every((c) => /\p{L}/u.test(text(owned([c]))))
    )
      continue
    const label = labels[0],
      leaf = union(owned(leaves))
    if (
      label.rect[0] < parent[0].rect[0] ||
      label.rect[2] > parent.at(-1).rect[2] ||
      !rules.some(
        (r) =>
          r[1] === r[3] &&
          r[1] >= group[0].rect[1] &&
          r[1] <= leaf[1] &&
          r[0] <= leaf[0] + label.height &&
          r[2] >= leaf[2] - label.height
      )
    )
      continue
    replace([...parent, ...group])
    repairs.push('header-span-inferred')
  }
}
