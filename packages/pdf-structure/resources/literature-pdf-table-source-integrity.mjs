/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { nativeTableLayoutConflicts } from './literature-pdf-table-layout-conflicts.mjs'
// These checks establish contradictions, not a replacement grid. Preserve the
// printed image and native owners when the available layout has two readings.
const compact = (s) => s.replace(/\s/gu, '')
const rect = (r) => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite)
const key = (o) => `${o.pageNumber}:${o.index}`
const box = (fonts) => [
  Math.min(...fonts.map((f) => f.rect[0])),
  Math.min(...fonts.map((f) => f.rect[1])),
  Math.max(...fonts.map((f) => f.rect[2])),
  Math.max(...fonts.map((f) => f.rect[3]))
]

export function nativeTableSourceConflicts(table, inventory, checkFinalCrop = false) {
  if (!table?.cells?.length || !table.grid?.length || !rect(table.cropRect)) return []
  const native = new Map(),
    counts = new Map()
  for (const font of inventory) {
    if (!font.sourceItem || !rect(font.rect) || !font.horizontal || !(font.height > 0)) continue
    const k = key(font.sourceItem)
    counts.set(k, (counts.get(k) ?? 0) + 1)
    native.set(k, font)
  }
  const owners = new Map()
  for (const cell of table.cells)
    for (const o of cell.sourceItems ?? []) {
      const k = key(o)
      owners.set(k, (owners.get(k) ?? 0) + 1)
    }
  const proved = []
  for (const cell of table.cells) {
    if (!cell.text?.trim() || cell.sourceSegments?.length || !cell.sourceItems?.length) continue
    const fonts = cell.sourceItems.map((o) => native.get(key(o)))
    if (
      fonts.some(
        (f, i) =>
          !f ||
          counts.get(key(f.sourceItem)) !== 1 ||
          owners.get(key(f.sourceItem)) !== 1 ||
          f.text !== cell.sourceItems[i].text ||
          f.sourceItem.text !== cell.sourceItems[i].text
      )
    )
      continue
    if (
      JSON.stringify(fonts.map((f) => JSON.stringify(f.rect)).sort()) !==
      JSON.stringify((cell.sourceRects ?? []).map((r) => JSON.stringify(r)).sort())
    )
      continue
    proved.push({ cell, fonts, box: box(fonts) })
  }
  const conflicts = new Set()
  // Earlier recovery may still enlarge the crop. At final publication, a whole
  // uniquely bound source extending more than an em past a side contradicts the
  // image presented for reviewing that cell. Small glyph overhangs and measured
  // source splits do not prove this conflict; preserve their existing handling.
  if (
    checkFinalCrop &&
    proved.some(
      ({ cell, fonts }) =>
        compact(cell.text) === compact(fonts.map((f) => f.text).join('')) &&
        fonts.some(
          (f) =>
            f.text === f.text.trim() &&
            f.rect[0] < f.rect[2] &&
            f.rect[1] < f.rect[3] &&
            (f.rect[0] < table.cropRect[0] - f.height || f.rect[2] > table.cropRect[2] + f.height)
        )
    )
  )
    conflicts.add('assigned-source-outside-final-crop')
  // Three independent numeric leaf columns repeating the same native baselines
  // contradict a single logical row. Wrapped prose, scripts and isolated
  // multiline values do not establish this evidence.
  const numericRows = new Map()
  for (const { cell, fonts } of proved) {
    if (cell.row < 1 || cell.rowSpan !== 1 || cell.colSpan !== 1 || fonts.length < 2) continue
    const h = Math.max(...fonts.map((f) => f.height)),
      lines = []
    for (const f of [...fonts].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
      const last = lines.at(-1)
      if (last && Math.abs(last.baseline - f.baseline) < h * 0.15) last.fonts.push(f)
      else lines.push({ baseline: f.baseline, fonts: [f] })
    }
    if (
      lines.length < 2 ||
      fonts.some((f) => f.height < h * 0.8) ||
      lines.slice(1).some((line, i) => line.baseline - lines[i].baseline < h * 0.9) ||
      lines.some((line) => {
        const ordered = line.fonts.sort((a, b) => a.rect[0] - b.rect[0])
        return (
          !/^[+−-]?\d+(?:[.,]\d+)?%?[*∗]*$/u.test(ordered.map((f) => f.text.trim()).join('')) ||
          ordered.slice(1).some((f, i) => f.rect[0] - ordered[i].rect[2] > h * 0.5)
        )
      })
    )
      continue
    const row = numericRows.get(cell.row) ?? []
    row.push({ column: cell.column, baselines: lines.map((line) => line.baseline), h })
    numericRows.set(cell.row, row)
  }
  for (const row of numericRows.values())
    if (
      row.some(
        (a) =>
          new Set(
            row
              .filter(
                (b) =>
                  b.baselines.length === a.baselines.length &&
                  b.baselines.every(
                    (y, i) => Math.abs(y - a.baselines[i]) < Math.min(a.h, b.h) * 0.15
                  )
              )
              .map((b) => b.column)
          ).size >= 3
      )
    )
      conflicts.add('collapsed-numeric-records')
  for (const { cell, fonts } of proved) {
    // A full-size numerator and denominator share x, while the surrounding
    // inequality has an intermediate baseline. This is not a superscript.
    if (!cell.text.includes('/') && fonts.some((f) => /[<>=≤≥]/u.test(f.text))) {
      for (const a of fonts)
        for (const b of fonts) {
          if (
            a === b ||
            !/^[\p{L}\p{N}]+$/u.test(a.text.trim()) ||
            !/^[\p{L}\p{N}]+$/u.test(b.text.trim())
          )
            continue
          const h = Math.max(a.height, b.height),
            overlap = Math.min(a.rect[2], b.rect[2]) - Math.max(a.rect[0], b.rect[0])
          if (
            Math.min(a.height, b.height) < h * 0.8 ||
            overlap < Math.min(a.rect[2] - a.rect[0], b.rect[2] - b.rect[0]) * 0.7 ||
            b.baseline - a.baseline < h ||
            b.baseline - a.baseline > h * 2.5
          )
            continue
          if (
            fonts.some(
              (f) =>
                /[<>=≤≥]/u.test(f.text) &&
                f.baseline > a.baseline + h * 0.25 &&
                f.baseline < b.baseline - h * 0.25
            )
          )
            conflicts.add('two-dimensional-math-cell')
        }
    }
    // A detached accent overlapping a larger native run cannot be faithfully
    // serialized by appending it after that run (possibly after an operator).
    if (
      fonts.some(
        (f) =>
          /^[˜ˆˉ¯]$/u.test(f.text.trim()) &&
          fonts.some(
            (g) =>
              g !== f &&
              /[\p{L}].*[<>=≤≥]/u.test(g.text) &&
              f.rect[0] < g.rect[2] &&
              g.rect[0] < f.rect[2]
          )
      )
    )
      conflicts.add('two-dimensional-math-cell')
  }
  // Complete header fonts extending over a proved neighbouring body column
  // contradict a single-column header whose neighbour contains only a marker.
  const header = proved.filter(
    (p) => p.cell.row === 0 && p.cell.rowSpan === 1 && p.cell.colSpan === 1
  )
  for (const a of header)
    for (const b of header) {
      if (a === b || b.cell.column !== a.cell.column + 1 || !/^[†‡*]+$/u.test(b.cell.text.trim()))
        continue
      const peer = proved.filter(
        (p) =>
          p.cell.row > 0 &&
          p.cell.column === b.cell.column &&
          p.cell.colSpan === 1 &&
          /^[+−-]?\d+(?:\.\d+)?$/u.test(p.cell.text.trim())
      )
      if (peer.length >= 2 && peer.every((p) => a.box[0] < p.box[0] && a.box[2] >= p.box[2]))
        conflicts.add('header-crosses-independent-column')
    }
  // One word/subscript split between adjacent leaf columns is still one
  // printed heading when both pieces sit above the actual leaf headings.
  for (const a of header)
    for (const b of header) {
      if (b.cell.column !== a.cell.column + 1) continue
      for (const f of a.fonts)
        for (const g of b.fonts) {
          if (!/^\p{L}+$/u.test(f.text.trim()) || !/^\p{L}+$/u.test(g.text.trim())) continue
          const h = Math.max(f.height, g.height)
          if (
            Math.abs(g.rect[0] - f.rect[2]) > h * 0.15 ||
            Math.abs(f.baseline - g.baseline) > h * 0.6
          )
            continue
          if (
            a.fonts.some((i) => i.rect[1] > Math.max(f.rect[3], g.rect[3]) + h * 0.3) &&
            b.fonts.some((i) => i.rect[1] > Math.max(f.rect[3], g.rect[3]) + h * 0.3)
          )
            conflicts.add('header-split-between-columns')
        }
    }
  // A wholly omitted native heading above the first body row is a structural
  // omission. Unassigned notes below the body do not satisfy this condition.
  const body = proved.filter((p) => p.cell.row > 0),
    unassigned = new Set((table.unassigned ?? []).map(compact))
  if (body.length && unassigned.size) {
    const top = Math.min(...body.map((p) => p.box[1]))
    for (const f of inventory)
      if (
        f.text?.trim() &&
        rect(f.rect) &&
        /\p{L}/u.test(f.text) &&
        unassigned.has(compact(f.text)) &&
        f.rect[0] >= table.cropRect[0] &&
        f.rect[2] <= table.cropRect[2] &&
        f.rect[1] >= table.cropRect[1] &&
        f.rect[3] < top &&
        counts.get(key(f.sourceItem ?? {})) === 1 &&
        !owners.has(key(f.sourceItem ?? {})) &&
        // A section title above complete headers is not a missing leaf heading.
        // Require an empty header slot and independently owned body in its lane.
        table.cells.some(
          (head) =>
            head.row === 0 &&
            head.rowSpan === 1 &&
            head.colSpan === 1 &&
            !head.text?.trim() &&
            !head.sourceItems?.length &&
            body.some(
              (p) =>
                p.cell.column === head.column &&
                p.cell.colSpan === 1 &&
                p.box[0] >= f.rect[0] &&
                p.box[2] <= f.rect[2]
            )
        )
      )
        conflicts.add('unassigned-printed-header')
  }
  const omittedHeaders = inventory.filter(
    (f) =>
      f.sourceItem &&
      f.horizontal &&
      f.height > 0 &&
      Number.isFinite(f.baseline) &&
      rect(f.rect) &&
      /\p{L}/u.test(f.text) &&
      unassigned.has(compact(f.text)) &&
      counts.get(key(f.sourceItem)) === 1 &&
      !owners.has(key(f.sourceItem)) &&
      f.rect[0] >= table.cropRect[0] &&
      f.rect[2] <= table.cropRect[2] &&
      f.rect[1] >= table.cropRect[1] &&
      f.rect[3] <= table.cropRect[3]
  )
  const laneRows = (f, column, afterRow) =>
    new Set(
      proved
        .filter(
          (p) =>
            p.cell.column === column &&
            p.cell.row > afterRow &&
            p.cell.colSpan === 1 &&
            p.box[1] > f.rect[3] &&
            p.box[0] >= f.rect[0] &&
            p.box[2] <= f.rect[2]
        )
        .map((p) => p.cell.row)
    ).size
  // A grouped header can occupy row zero while the missing leaf labels belong
  // to row one. Require two owned peers on the same baseline and repeated body
  // records in the omitted label's lane; mere nearby prose is insufficient.
  for (const f of omittedHeaders)
    for (const empty of table.cells.filter(
      (c) =>
        c.row <= 1 &&
        c.colSpan === 1 &&
        c.rowSpan === 1 &&
        !c.text?.trim() &&
        !c.sourceItems?.length &&
        !c.sourceSegments?.length
    )) {
      const peers = proved.filter(
        (p) =>
          p.cell.row === empty.row &&
          p.cell.colSpan === 1 &&
          p.fonts.length === 1 &&
          Math.abs(p.fonts[0].baseline - f.baseline) < f.height * 0.15
      )
      if (
        new Set(peers.map((p) => p.cell.column)).size >= 2 &&
        laneRows(f, empty.column, empty.row) >= 2
      )
        conflicts.add('unassigned-printed-header')
    }
  // Entire omitted headers need two separate native labels and repeated body
  // columns. A single title spanning the table must not trigger this proof.
  const firstRow = proved.filter((p) => p.cell.row === 0 && p.cell.colSpan === 1)
  if (firstRow.length >= 2) {
    const top = Math.min(...firstRow.map((p) => p.box[1]))
    const candidates = omittedHeaders.flatMap((f) => {
      if (f.rect[3] >= top || top - f.rect[3] > f.height * 3) return []
      const center = (f.rect[0] + f.rect[2]) / 2
      const lanes = firstRow.filter(
        (p) =>
          p.box[0] - f.height * 0.5 <= center &&
          p.box[2] + f.height * 0.5 >= center &&
          new Set(
            proved
              .filter(
                (q) =>
                  q.cell.column === p.cell.column &&
                  q.cell.colSpan === 1 &&
                  q.box[1] > f.rect[3] &&
                  q.box[0] - f.height * 0.5 <= center &&
                  q.box[2] + f.height * 0.5 >= center
              )
              .map((q) => q.cell.row)
          ).size >= 2
      )
      return lanes.length === 1 ? [{ f, column: lanes[0].cell.column }] : []
    })
    if (
      candidates.some((a) =>
        candidates.some(
          (b) =>
            a !== b &&
            a.column !== b.column &&
            (a.f.rect[2] < b.f.rect[0] || b.f.rect[2] < a.f.rect[0]) &&
            Math.abs(a.f.baseline - b.f.baseline) < Math.min(a.f.height, b.f.height) * 0.15
        )
      )
    )
      conflicts.add('unassigned-printed-header')
  }
  // Top-aligned record labels plus an aligned body line establish the next
  // record's start. A preceding full-size line in that same cell crosses it.
  const stubs = proved.filter(
    (p) => p.cell.column === 0 && p.cell.row > 0 && p.cell.rowSpan === 1 && p.cell.colSpan === 1
  )
  const displaced = []
  for (const stub of stubs) {
    const first = stub.fonts.reduce((a, b) => (a.baseline < b.baseline ? a : b)),
      h = first.height
    for (const p of proved.filter(
      (p) =>
        p.cell.row === stub.cell.row &&
        p.cell.column > 0 &&
        p.cell.rowSpan === 1 &&
        p.cell.colSpan === 1
    )) {
      const before = p.fonts.filter(
        (f) => f.rect[3] < first.rect[1] - h * 0.1 && Math.abs(f.height - h) < h * 0.1
      )
      if (
        before.length &&
        p.fonts.some((f) => Math.abs(f.baseline - first.baseline) < h * 0.1) &&
        stubs.some(
          (prev) =>
            prev.cell.row === stub.cell.row - 1 &&
            prev.box[3] < Math.min(...before.map((f) => f.rect[1]))
        )
      )
        displaced.push(stub.cell.row)
    }
  }
  if (new Set(displaced).size >= 2) conflicts.add('body-line-crosses-record-start')
  // A repeated detached numeric right edge, including its own header, is an
  // independent leaf lane, not prose embedded in a wide last column.
  const last = table.grid[0].length - 1,
    terminal = proved.filter(
      (p) => p.cell.column === last && p.cell.colSpan === 1 && p.cell.rowSpan === 1
    )
  const lanes = []
  for (const p of terminal) {
    const ordered = [...p.fonts].sort((a, b) => a.rect[0] - b.rect[0]),
      tail = ordered.at(-1),
      others = ordered.slice(0, -1)
    if (
      !tail ||
      !others.length ||
      !(p.cell.row === 0 ? /^[\p{L}\p{S}§]{1,3}$/u : /^\d{1,3}$/u).test(tail.text.trim())
    )
      continue
    const h = tail.height,
      right = Math.max(...others.map((f) => f.rect[2]))
    if (
      tail.rect[0] - right > h &&
      Math.abs(tail.baseline - Math.min(...others.map((f) => f.baseline))) < h * 0.15
    )
      lanes.push({ row: p.cell.row, x: tail.rect[0], h })
  }
  if (
    lanes.some((p) => p.row === 0) &&
    lanes.filter((p) => p.row > 0).length >= 3 &&
    Math.max(...lanes.map((p) => p.x)) - Math.min(...lanes.map((p) => p.x)) <
      Math.min(...lanes.map((p) => p.h))
  )
    conflicts.add('independent-terminal-column')
  return [...conflicts]
}

export function reviewNativeTableSources(table, inventory) {
  // Let later native record recovery use its complete paint/source proof first.
  // Final review still rejects collapsed numeric records that remain unresolved.
  const conflicts = nativeTableSourceConflicts(table, inventory).filter(
    (conflict) => conflict !== 'collapsed-numeric-records'
  )
  return conflicts.length
    ? {
        ...table,
        issues: [...new Set([...(table.issues ?? []), 'native-table-structure-ambiguous'])],
        reviewCandidate: false
      }
    : table
}

// Run after measured source segments have been attached: a legitimate measured
// split must not be mistaken for an unsupported partial native owner.
export function reviewFinalNativeTableSources(table, inventory, rules) {
  if (table.parts)
    return {
      ...table,
      parts: table.parts.map((part) => {
        const checked = reviewFinalNativeTableSources(
          { ...part, cropRect: part.cropRect ?? table.cropRect },
          inventory,
          rules
        )
        return checked.issues === part.issues ? part : { ...part, issues: checked.issues }
      })
    }
  return nativeTableSourceConflicts(table, inventory, true).length ||
    nativeTableLayoutConflicts(table, inventory, rules).length
    ? {
        ...table,
        issues: [...new Set([...(table.issues ?? []), 'native-table-structure-ambiguous'])],
        reviewCandidate: false
      }
    : table
}

export function trimNativeTablePageCounterCrop(table, inventory, rules, context) {
  if (
    !rect(table.cropRect) ||
    table.parts ||
    table.cropRects ||
    !Number.isInteger(context?.pageNumber) ||
    !Number.isInteger(context?.pageCount) ||
    !(context.height > 0)
  )
    return table
  const crop = table.cropRect,
    text = `${context.pageNumber}/${context.pageCount}`,
    folios = inventory.filter(
      (f) =>
        f.text?.trim() === text &&
        f.sourceItem?.text.trim() === text &&
        rect(f.rect) &&
        f.horizontal &&
        f.baseline > context.height * 0.85 &&
        f.rect[0] >= crop[0] &&
        f.rect[2] <= crop[2] &&
        f.rect[1] < crop[3]
    )
  if (folios.length !== 1) return table
  const folio = folios[0],
    owned = table.cells?.flatMap((c) => c.sourceItems ?? []) ?? []
  if (owned.some((o) => key(o) === key(folio.sourceItem))) return table
  const body = inventory.filter(
    (f) =>
      f !== folio &&
      f.text?.trim() &&
      rect(f.rect) &&
      f.rect[0] < crop[2] &&
      f.rect[2] > crop[0] &&
      f.rect[1] < crop[3] &&
      f.rect[3] > crop[1]
  )
  if (!body.length || body.some((f) => !f.horizontal || f.rect[0] < crop[0] || f.rect[2] > crop[2]))
    return table
  const bounds = box(body),
    closing = rules
      .filter(
        (r) =>
          rect(r) &&
          r[1] === r[3] &&
          r[0] <= bounds[0] &&
          r[2] >= bounds[2] &&
          r[1] > bounds[3] &&
          r[1] - bounds[3] < folio.height &&
          folio.baseline - r[1] > folio.height * 0.5 &&
          r[1] < crop[3]
      )
      .sort((a, b) => b[1] - a[1])[0]
  if (!closing) return table
  return {
    ...table,
    cropRect: [crop[0], crop[1], crop[2], closing[1] + 0.5],
    repairs: [...(table.repairs ?? []), 'native-page-counter-crop-trimmed']
  }
}
