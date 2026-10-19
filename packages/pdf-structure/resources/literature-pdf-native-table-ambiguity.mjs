/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Conservative review triggers under the approved ambiguity policy. These are
// not unique reconstruction proofs; callers preserve every original table field.
import {
  hasNativeMeasuredHeadingAmbiguity,
  hasNativeRepeatedLeafAmbiguity
} from './literature-pdf-table-column-conflicts.mjs'
import { classifyTableRuleEdge } from './literature-pdf-table-rules.mjs'
import { proveNativeUniqueWholeFonts } from './literature-pdf-table-evidence.mjs'
import { captionKind } from './literature-pdf-caption-group.mjs'

export function hasClippedNativeHeading(proof, table, inventory, captions) {
  if (
    !proof ||
    !rect(table.cropRect) ||
    !hasDisjointNativeTableSlots(table) ||
    table.grid.length < 3 ||
    table.grid[0].length < 3 ||
    table.cells.some((c) => c.rowSpan !== 1 || c.colSpan !== 1 || !c.text.trim()) ||
    proof.proved.length !== table.cells.length
  )
    return false
  const fonts = proof.proved.flatMap((p) => p.fonts),
    first = proof.proved.filter((p) => p.cell.row === 0)
  if (
    first.length !== table.grid[0].length ||
    table.grid.some((row) => !/^\d+$/u.test(row[0].trim())) ||
    !proveNativeUniqueWholeFonts(fonts, inventory)
  )
    return false
  const top = Math.min(...first.flatMap((p) => p.fonts).map((f) => f.rect[1])),
    crop = table.cropRect
  const headers = inventory.filter(
    (i) =>
      i.text?.trim() &&
      rect(i.rect) &&
      i.rect[0] < crop[2] &&
      i.rect[2] > crop[0] &&
      i.rect[1] < crop[1] &&
      i.rect[3] > crop[1] &&
      i.rect[3] < top
  )
  if (
    headers.length < 2 ||
    headers.some(
      (i) => !i.horizontal || fonts.includes(i) || i.rect[0] < crop[0] || i.rect[2] > crop[2]
    ) ||
    !headers.some((i) => /\p{L}/u.test(i.text)) ||
    !proveNativeUniqueWholeFonts(headers, inventory)
  )
    return false
  const h = headers[0].height
  if (
    !Number.isFinite(h) ||
    h <= 0 ||
    headers.some(
      (i) =>
        Math.abs(i.height - h) > h * 0.04 || Math.abs(i.baseline - headers[0].baseline) > h * 0.04
    )
  )
    return false
  const box = union(headers),
    domain = [crop[0], box[1], crop[2], top]
  if (
    inventory.some(
      (i) =>
        i.text?.trim() && (!rect(i.rect) || (!headers.includes(i) && intersects(i.rect, domain)))
    )
  )
    return false
  const above = (captions ?? []).filter(
    (c) =>
      captionKind(c.lines?.[0]) === 'table' &&
      rect(c.rect) &&
      c.rect[3] < box[1] &&
      box[1] - c.rect[3] < h * 2 &&
      c.rect[0] < crop[2] &&
      c.rect[2] > crop[0]
  )
  if (above.length !== 1) return false
  const cap = above[0],
    capFonts = inventory.filter(
      (i) => i.text?.trim() && rect(i.rect) && intersects(i.rect, cap.rect)
    )
  if (
    !capFonts.length ||
    !proveNativeUniqueWholeFonts(capFonts, inventory) ||
    capFonts.some(
      (i) =>
        !i.horizontal ||
        i.rect[0] < cap.rect[0] ||
        i.rect[1] < cap.rect[1] ||
        i.rect[2] > cap.rect[2] ||
        i.rect[3] > cap.rect[3]
    ) ||
    compact(capFonts.map((i) => i.text).join(' ')) !== compact(cap.lines.join(' '))
  )
    return false
  return true
}

// Distinct model rows inside a complete prose face do not establish distinct
// native records. Keep their literal/source payload and request conservative review.
export function hasNativeClosedFaceRowAmbiguity(proof, table, inventory, rules) {
  if (!proof || table.grid[0].length !== 2 || !hasDisjointNativeTableSlots(table)) return false
  for (let row = 0; row + 1 < table.grid.length; row++) {
    const cells = table.cells.filter((c) => c.row === row || c.row === row + 1)
    if (
      cells.length !== 4 ||
      cells.some((c) => c.rowSpan !== 1 || c.colSpan !== 1) ||
      !table.grid[row][0] ||
      table.grid[row + 1][0] ||
      ![table.grid[row][0], table.grid[row][1], table.grid[row + 1][1]].every((t) =>
        /\p{L}/u.test(t)
      )
    )
      continue
    const owners = proof.proved.filter((p) => cells.includes(p.cell))
    if (owners.length !== 3) continue
    const fonts = owners.flatMap((p) => p.fonts),
      box = union(fonts)
    const hs = horizontal(rules)
      .filter((r) => r[0] <= box[0] && r[2] >= box[2])
      .sort((a, b) => a[1] - b[1])
    const top = hs.filter((r) => r[1] < box[1]).at(-1),
      bottom = hs.find((r) => r[1] > box[3])
    if (!top || !bottom || hs.some((r) => r[1] > box[1] && r[1] < box[3])) continue
    const vs = rules.filter((r) => r[0] === r[2] && r[3] > r[1])
    const xs = [...new Set(vs.map((r) => r[0]))]
      .filter((x) => classifyTableRuleEdge(vs, 0, x, top[1], bottom[1]) === 1)
      .sort((a, b) => a - b)
    const left = xs.filter((x) => x < box[0]).at(-1),
      right = xs.find((x) => x > box[2])
    const middle = xs.filter((x) => x > box[0] && x < box[2])
    if (
      left === undefined ||
      right === undefined ||
      middle.length !== 1 ||
      [top[1], bottom[1]].some((y) => classifyTableRuleEdge(hs, 1, y, left, right) !== 1) ||
      owners.some((p) =>
        p.fonts.some((i) => (p.cell.column === 0 ? i.rect[2] >= middle[0] : i.rect[0] <= middle[0]))
      )
    )
      continue
    if (
      inventory.some(
        (i) =>
          i.text?.trim() &&
          (!rect(i.rect) ||
            (!fonts.includes(i) && intersects(i.rect, [left, top[1], right, bottom[1]])))
      )
    )
      continue
    return true
  }
  return false
}

// This proof concerns complete original records, not the downstream synthetic
// splitting of a fused ordinal/numerator font into columns. Such splits cannot
// serve as whole-cell evidence, so no cell geometry or reconstructed value is
// certified here: only an ambiguous many-records-to-one-row claim is blocked.
export function hasNativeMergedFractionRecords(table, inventory, rules) {
  if (table.grid[0]?.length !== 2 || !hasDisjointNativeTableSlots(table)) return false
  const key = (o) => `${o?.pageNumber}:${o?.index}`,
    claims = new Map()
  for (const cell of table.cells) {
    if (table.grid[cell.row][cell.column] !== cell.text || cell.rowSpan !== 1 || cell.colSpan !== 1)
      return false
    for (const source of cell.sourceItems ?? []) {
      const entries = claims.get(key(source)) ?? []
      if (entries.some((entry) => entry.cell === cell)) return false
      entries.push({ cell, source })
      claims.set(key(source), entries)
    }
  }
  const fonts = inventory
    .filter(
      (i) =>
        i.text?.trim() &&
        rect(i.rect) &&
        i.rect[0] >= table.cropRect[0] &&
        i.rect[2] <= table.cropRect[2] &&
        i.rect[1] >= table.cropRect[1] &&
        i.rect[3] <= table.cropRect[3]
    )
    .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
  const lines = []
  for (const font of fonts) {
    const last = lines.at(-1)
    if (last && Math.abs(last[0].baseline - font.baseline) <= 1e-6) last.push(font)
    else lines.push([font])
  }
  const records = lines.map((line) => {
    if (
      line.length !== 3 ||
      !/^\d+ \d+$/u.test(line[0].text) ||
      line[1].text !== '/' ||
      !/^\d+$/u.test(line[2].text) ||
      line.some(
        (i, n) =>
          !i.horizontal ||
          !Number.isFinite(i.height) ||
          i.height <= 0 ||
          Math.abs(i.height - line[0].height) > 1e-6 ||
          (n && Math.abs(i.rect[0] - line[n - 1].rect[2]) > 1e-6)
      )
    )
      return null
    const rows = new Set()
    for (const font of line) {
      const owners = claims.get(key(font.sourceItem))
      if (
        !owners?.length ||
        owners.some(({ cell, source }) => source.text !== font.text || cell.sourceSegments?.length)
      )
        return null
      owners.forEach(({ cell }) => rows.add(cell.row))
    }
    if (rows.size !== 1) return null
    return { line, row: [...rows][0], ordinal: BigInt(line[0].text.split(' ')[0]) }
  })
  for (let n = 3; n < records.length; n++) {
    const chain = records.slice(n - 3, n + 1)
    if (chain.some((r) => !r)) continue
    const [a, b, c, d] = chain,
      height = a.line[0].height,
      cadence = b.line[0].baseline - a.line[0].baseline
    if (
      !(a.row < b.row && b.row < c.row && c.row === d.row) ||
      cadence <= height ||
      cadence > height * 2 ||
      chain.some(
        (r, index) =>
          r.ordinal !== a.ordinal + BigInt(index) ||
          Math.abs(r.line[0].rect[0] - a.line[0].rect[0]) > 1e-6 ||
          Math.abs(r.line[0].height - height) > 1e-6 ||
          (index &&
            Math.abs(r.line[0].baseline - chain[index - 1].line[0].baseline - cadence) >
              height * 0.001)
      )
    )
      continue
    const selected = chain.flatMap((r) => r.line),
      box = union(selected)
    if (!proveNativeUniqueWholeFonts(selected, inventory) || !complete(selected, inventory))
      continue
    const hs = horizontal(rules)
        .filter((r) => r[0] <= box[0] && r[2] >= box[2])
        .sort((a, b) => a[1] - b[1]),
      top = hs.filter((r) => r[1] < box[1]).at(-1),
      bottom = hs.find((r) => r[1] > box[3])
    if (
      !top ||
      !bottom ||
      top[0] !== bottom[0] ||
      top[2] !== bottom[2] ||
      hs.some((r) => r[1] > box[1] && r[1] < box[3])
    )
      continue
    return true
  }
  return false
}

// A selected evidence component must not hide competing model faces elsewhere
// in the table. This checks expanded spans, not only their anchor slots.
export function hasDisjointNativeTableSlots(table) {
  const grid = table.grid,
    slots = new Set()
  if (!Array.isArray(grid) || !grid.length || !grid[0]?.length || !Array.isArray(table.cells))
    return false
  if (grid.some((row) => !Array.isArray(row) || row.length !== grid[0].length)) return false
  for (const cell of table.cells) {
    if (
      ![cell.row, cell.column, cell.rowSpan, cell.colSpan].every(Number.isInteger) ||
      cell.row < 0 ||
      cell.column < 0 ||
      cell.rowSpan < 1 ||
      cell.colSpan < 1 ||
      cell.row + cell.rowSpan > grid.length ||
      cell.column + cell.colSpan > grid[0].length
    )
      return false
    for (let row = cell.row; row < cell.row + cell.rowSpan; row++)
      for (let column = cell.column; column < cell.column + cell.colSpan; column++) {
        const key = `${row}:${column}`
        if (slots.has(key)) return false
        slots.add(key)
      }
  }
  return true
}
const rect = (r) =>
  Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1]
const union = (fonts) => [
  Math.min(...fonts.map((i) => i.rect[0])),
  Math.min(...fonts.map((i) => i.rect[1])),
  Math.max(...fonts.map((i) => i.rect[2])),
  Math.max(...fonts.map((i) => i.rect[3]))
]
const intersects = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
const compact = (s) => s.replace(/\s/gu, '')
const complete = (fonts, inventory) => {
  const domain = union(fonts)
  return !inventory.some(
    (i) => i.text?.trim() && (!rect(i.rect) || (!fonts.includes(i) && intersects(i.rect, domain)))
  )
}
const framedHeader = (fonts, inventory, rules, owners) => {
  const box = union(fonts)
  const full = rules
    .filter(
      (r) =>
        r.length === 4 &&
        r.every(Number.isFinite) &&
        r[1] === r[3] &&
        r[0] <= box[0] &&
        r[2] >= box[2]
    )
    .sort((a, b) => a[1] - b[1])
  const above = full.filter((r) => r[1] < box[1]).at(-1),
    below = full.find((r) => r[1] > box[3])
  if (!above || !below) return null
  const ink = inventory.filter(
    (i) =>
      i.text?.trim() &&
      rect(i.rect) &&
      intersects(i.rect, [
        Math.max(above[0], below[0]),
        above[1],
        Math.min(above[2], below[2]),
        below[1]
      ])
  )
  if (
    !ink.length ||
    ink.some((i) => !owners.has(i) || i.rect[1] <= above[1] || i.rect[3] >= below[1])
  )
    return null
  return { above, below }
}
export function detectNativeTableAmbiguity(proof, table, inventory, rules, runs = []) {
  if (!proof?.proved?.length || inventory.some((i) => i.text?.trim() && !rect(i.rect))) return []
  const ps = proof.proved,
    owners = new Map(ps.flatMap((p) => p.fonts.map((i) => [i, p])))
  const result = []
  if (hasCollapsedNumericLanes(proof, table, inventory, rules))
    result.push({ kind: 'collapsed-native-numeric-lanes', notErrorProof: true })
  if (hasNativeEquationBlock(proof, table, inventory, rules))
    result.push({ kind: 'native-equation-block', notErrorProof: true })
  if (hasTerminalNativeFieldDrift(proof, table, inventory, rules))
    result.push({ kind: 'terminal-native-field-drift', notErrorProof: true })
  if (hasMergedPairedRecords(proof, table, inventory, rules))
    result.push({ kind: 'merged-native-paired-records', notErrorProof: true })
  if (hasSparseSectionHeadingAmbiguity(proof, table, inventory, rules))
    result.push({ kind: 'sparse-section-heading-overhang', notErrorProof: true })
  if (hasMisassignedStubTail(proof, table, inventory, rules))
    result.push({ kind: 'misassigned-native-stub-tail', notErrorProof: true })
  if (hasEquationMatrixFields(proof, table, inventory, rules))
    result.push({ kind: 'equation-matrix-fields', notErrorProof: true })
  if (hasRepeatedBlankStubContinuations(proof, table, inventory, rules))
    result.push({ kind: 'repeated-blank-stub-continuations', notErrorProof: true })
  if (hasUnclaimedUnderlinedHeading(proof, table, inventory, rules))
    result.push({ kind: 'unclaimed-underlined-native-heading', notErrorProof: true })
  if (hasNativeRepeatedLeafAmbiguity(proof, table, inventory))
    result.push({ kind: 'merged-repeated-native-leaves', notErrorProof: true })
  if (hasUnclaimedCompleteNativeRecord(proof, table, inventory, rules))
    result.push({ kind: 'unclaimed-complete-native-record', notErrorProof: true })
  if (hasUnclaimedSharedSymbolRecord(proof, table, inventory, rules))
    result.push({ kind: 'unclaimed-shared-symbol-record', notErrorProof: true })
  if (hasMergedNativeDescriptorLanes(proof, table, inventory, rules))
    result.push({ kind: 'merged-native-descriptor-lanes', notErrorProof: true })
  if (hasNativeMeasuredHeadingAmbiguity(proof, table, inventory, rules, runs))
    result.push({ kind: 'measured-wrapped-heading-overhang', notErrorProof: true })
  if (firstRecordInHeader(proof, inventory, rules))
    result.push({ kind: 'first-record-in-heading', notErrorProof: true })
  if (sectionInRecord(proof, table, inventory, rules))
    result.push({ kind: 'section-title-in-record', notErrorProof: true })
  if (terminalWrappedRecord(proof, table, inventory, rules))
    result.push({ kind: 'terminal-wrapped-record', notErrorProof: true })
  for (const right of ps.filter(
    (p) =>
      p.cell.row === 0 &&
      p.cell.rowSpan === 1 &&
      p.cell.colSpan === 1 &&
      compact(p.cell.text).startsWith('/')
  )) {
    const left = ps.find(
      (p) =>
        p.cell.row === 0 &&
        p.cell.column === right.cell.column - 1 &&
        p.cell.rowSpan === 1 &&
        p.cell.colSpan === 1
    )
    if (!left) continue
    const rfont = [...right.fonts].sort((a, b) => a.rect[0] - b.rect[0])[0],
      h = rfont.height
    if (!rfont.text.trim().startsWith('/') || !/\p{L}|\p{N}/u.test(left.cell.text)) continue
    const baselineLeft = left.fonts
      .filter(
        (i) =>
          Math.abs(i.height - h) < h * 0.001 && Math.abs(i.baseline - rfont.baseline) < h * 0.001
      )
      .sort((a, b) => a.rect[0] - b.rect[0])
      .at(-1)
    const lb = union(left.fonts),
      rb = union(right.fonts)
    if (
      !baselineLeft ||
      rb[0] < lb[2] ||
      rb[0] - lb[2] > h * 0.8 ||
      !complete([...left.fonts, ...right.fonts], inventory)
    )
      continue
    const frame = framedHeader([...left.fonts, ...right.fonts], inventory, rules, owners)
    if (!frame) continue
    const numeric = (p) =>
      /^[+−–-]?(?:\d+(?:\.\d*)?|\.\d+)$/u.test(compact(p.cell.text)) &&
      p.cell.rowSpan === 1 &&
      p.cell.colSpan === 1 &&
      complete(p.fonts, inventory)
    const records = ps
      .filter((p) => p.cell.row > 0 && p.cell.column === left.cell.column && numeric(p))
      .flatMap((p) => {
        const q = ps.find(
          (q) => q.cell.row === p.cell.row && q.cell.column === right.cell.column && numeric(q)
        )
        return q && Math.abs(p.fonts[0].baseline - q.fonts[0].baseline) < h * 0.1
          ? [{ row: p.cell.row, left: p.cell.column, right: q.cell.column }]
          : []
      })
    if (records.length < 2) continue
    result.push({
      kind: 'mathematical-title-cross-leaf-ambiguity',
      row: 0,
      columns: [left.cell.column, right.cell.column],
      frame,
      records,
      sourceItems: [...left.fonts, ...right.fonts].map((i) => i.sourceItem),
      notErrorProof: true
    })
  }
  const parents = ps.filter((p) => p.cell.row === 0 && p.cell.rowSpan === 1 && p.cell.colSpan === 4)
  const middle = []
  for (const parent of parents) {
    const pairs = []
    for (let c = parent.cell.column; c < parent.cell.column + 4; c += 2) {
      const left = ps.find(
          (p) =>
            p.cell.row === 1 && p.cell.column === c && p.cell.rowSpan === 1 && p.cell.colSpan === 1
        ),
        right = ps.find(
          (p) =>
            p.cell.row === 1 &&
            p.cell.column === c + 1 &&
            p.cell.rowSpan === 1 &&
            p.cell.colSpan === 1
        )
      if (!left || !right) break
      const h = Math.max(...right.fonts.map((i) => i.height)),
        full = right.fonts.filter((i) => i.height === h),
        upperBaseline = Math.min(...full.map((i) => i.baseline)),
        lowerBaseline = Math.max(...full.map((i) => i.baseline))
      if (lowerBaseline - upperBaseline < h * 0.8) break
      const upper = right.fonts.filter((i) => i.baseline === upperBaseline && i.height === h),
        lower = right.fonts.filter((i) => !upper.includes(i))
      if (
        !upper.length ||
        !lower.length ||
        Math.max(...upper.map((i) => i.rect[3])) >= Math.min(...lower.map((i) => i.rect[1]))
      )
        break
      if (
        left.fonts.some((i) => i.rect[1] <= Math.max(...upper.map((i) => i.rect[3]))) ||
        !left.fonts.some(
          (i) =>
            Math.abs(i.height - h) < h * 0.001 && Math.abs(i.baseline - lowerBaseline) < h * 0.001
        )
      )
        break
      if (!complete([...left.fonts, ...right.fonts], inventory)) break
      if (
        rules.some(
          (r) =>
            r[1] === r[3] &&
            r[1] > Math.max(...upper.map((i) => i.rect[3])) &&
            r[1] < Math.min(...[...lower, ...left.fonts].map((i) => i.rect[1])) &&
            r[0] < union(upper)[2] &&
            r[2] > union(upper)[0]
        )
      )
        break
      pairs.push({ columns: [c, c + 1], upper, lower, left })
    }
    if (pairs.length === 2) {
      const fonts = [
          ...parent.fonts,
          ...pairs.flatMap((p) => [...p.upper, ...p.lower, ...p.left.fonts])
        ],
        frame = framedHeader(fonts, inventory, rules, owners)
      if (frame) middle.push({ parent, pairs, frame })
    }
  }
  if (middle.length >= 2) {
    const shape = (p) =>
      compact(
        [...p.left.fonts]
          .sort((a, b) => a.rect[0] - b.rect[0])
          .map((i) => i.text)
          .join('')
      ) +
      '|' +
      compact(
        [...p.lower]
          .sort((a, b) => a.rect[0] - b.rect[0])
          .map((i) => i.text)
          .join('')
      )
    if (middle.every((m) => m.pairs.every((p) => shape(p) === shape(middle[0].pairs[0]))))
      result.push({
        kind: 'unruled-middle-tier-heading-ambiguity',
        parents: middle.map((m) => ({
          column: m.parent.cell.column,
          pairs: m.pairs.map((p) => ({
            columns: p.columns,
            sourceItems: p.upper.map((i) => i.sourceItem)
          })),
          frame: m.frame
        })),
        notErrorProof: true
      })
  }
  return result
}

function completeFinalPacket(proof, table, inventory) {
  if (
    !proof?.proved?.length ||
    !Array.isArray(table?.cells) ||
    table.cells.some((c) => !c || typeof c.text !== 'string') ||
    !hasDisjointNativeTableSlots(table)
  )
    return null
  const nonempty = table.cells.filter((c) => c.text.trim()),
    fonts = proof.proved.flatMap((p) => p.fonts)
  if (
    proof.proved.length !== nonempty.length ||
    nonempty.some((c) => proof.proved.filter((p) => p.cell === c).length !== 1) ||
    table.cells.some((c) => table.grid[c.row][c.column] !== c.text) ||
    fonts.some(
      (f) =>
        !f.horizontal ||
        !rect(f.rect) ||
        !Number.isFinite(f.baseline) ||
        !Number.isFinite(f.height) ||
        !(f.height > 0)
    ) ||
    !proveNativeUniqueWholeFonts(fonts, inventory)
  )
    return null
  return fonts
}

export function hasNativeEquationBlock(proof, table, inventory, rules) {
  const fonts = completeFinalPacket(proof, table, inventory)
  if (!fonts || table.caption) return false
  const box = union(fonts),
    edges = horizontal(rules).filter((r) => r[0] <= box[0] && r[2] >= box[2])
  // Degenerate advances elsewhere on the page are not participating ink.
  // An unknown position, or even a zero-width foreign mark inside this domain,
  // still prevents the local equation proof.
  if (
    inventory.some(
      (f) =>
        f.text?.trim() &&
        (!Array.isArray(f.rect) ||
          f.rect.length !== 4 ||
          !f.rect.every(Number.isFinite) ||
          (!fonts.includes(f) &&
            f.rect[0] <= box[2] &&
            f.rect[2] >= box[0] &&
            f.rect[1] <= box[3] &&
            f.rect[3] >= box[1]))
    )
  )
    return false
  if (edges.some((r) => r[1] < box[1]) && edges.some((r) => r[1] > box[3])) return false
  const rows = [...new Set(proof.proved.map((p) => p.cell.row))].map((row) =>
    proof.proved.filter((p) => p.cell.row === row).sort((a, b) => a.cell.column - b.cell.column)
  )
  const labelled =
    rows.length >= 3 &&
    rows.every((row) => {
      const last = row.at(-1)
      return (
        row.length >= 2 &&
        /^\([\p{L}\p{N}_-]+\)$/u.test(compact(last.cell.text)) &&
        row.slice(0, -1).some((p) => /[:∶]=|∀.*∈/u.test(p.cell.text)) &&
        row
          .slice(0, -1)
          .every((p) => !p.fonts.some((f) => /^[A-Za-z]{3,}(?:\s|$)/u.test(f.text.trim())))
      )
    })
  if (labelled) return true
  // A single line of definitions may be spuriously split into columns while
  // its summation indices become another model row. No relation is rebuilt.
  const assignments = proof.proved.filter((p) => /[:∶]=/u.test(p.cell.text))
  return (
    assignments.length >= 2 &&
    new Set(assignments.map((p) => p.cell.row)).size === 1 &&
    fonts.every((f) => !/[A-Za-z]{3,}/u.test(f.text)) &&
    rows.every((row) => row.every((p) => p.cell.rowSpan === 1 && p.cell.colSpan === 1))
  )
}

function hasCollapsedNumericLanes(proof, table, inventory, rules) {
  const fonts = completeFinalPacket(proof, table, inventory)
  if (!fonts) return false
  const box = union(fonts),
    edges = horizontal(rules).filter((r) => r[0] <= box[0] && r[2] >= box[2])
  if (!edges.some((r) => r[1] < box[1]) || !edges.some((r) => r[1] > box[3])) return false
  const numeric = proof.proved.filter(
    (p) =>
      p.cell.rowSpan === 1 &&
      p.cell.colSpan === 1 &&
      p.fonts.length >= 2 &&
      p.fonts.every((f) => /^[+−-]?\d+(?:\.\d+)?$/u.test(f.text.trim())) &&
      complete(p.fonts, inventory)
  )
  for (const column of new Set(numeric.map((p) => p.cell.column))) {
    const records = numeric.filter((p) => p.cell.column === column),
      rows = records.map((p) => [...p.fonts].sort((a, b) => a.rect[0] - b.rect[0]))
    if (rows.length < 3 || new Set(records.map((p) => p.cell.row)).size !== rows.length) continue
    const h = rows[0][0].height,
      width = rows[0].length
    if (
      rows.some(
        (row) =>
          row.length !== width ||
          row.some(
            (f) =>
              Math.abs(f.height - h) > h * 0.001 ||
              Math.abs(f.baseline - row[0].baseline) > h * 0.001
          )
      )
    )
      continue
    const lanes = Array.from({ length: width }, (_, c) => union(rows.map((row) => row[c])))
    if (lanes.some((lane, c) => c && lane[0] - lanes[c - 1][2] < h * 0.5)) continue
    return true
  }
  return false
}

export function hasNativeFolioOnlyTable(proof, table, inventory, rules, context) {
  const fonts = completeFinalPacket(proof, table, inventory),
    v = context?.viewport
  if (
    !fonts ||
    fonts.length !== 1 ||
    table.caption ||
    table.grid.length < 2 ||
    !v ||
    v.rotation !== 0 ||
    ![v.width, v.height].every((n) => Number.isFinite(n) && n > 0)
  )
    return false
  const f = fonts[0],
    h = f.height
  if (
    !/^[1-9]\d*$/u.test(f.text) ||
    String(f.sourceItem.pageNumber) !== f.text ||
    f.rect[1] <= v.height * 0.93 ||
    f.rect[3] >= v.height ||
    Math.abs((f.rect[0] + f.rect[2] - v.width) / 2) > h / 1000
  )
    return false
  const body = inventory.filter((i) => i !== f && i.text?.trim())
  if (
    !body.some((i) => /\p{L}{3}/u.test(i.text)) ||
    body.some(
      (i) =>
        !rect(i.rect) ||
        i.sourceItem?.pageNumber !== f.sourceItem.pageNumber ||
        i.rect[3] >= f.rect[1] - 2 * h
    )
  )
    return false
  return !rules.some(
    (r) => r.length !== 4 || !r.every(Number.isFinite) || Math.max(r[1], r[3]) >= f.rect[1] - 2 * h
  )
}

function hasTerminalNativeFieldDrift(proof, table, inventory, rules) {
  const fonts = completeFinalPacket(proof, table, inventory)
  if (!fonts || table.grid[0].length !== 3 || table.grid.length < 5) return false
  const row = table.grid.length - 1,
    last = proof.proved
      .filter((p) => p.cell.row === row)
      .sort((a, b) => a.cell.column - b.cell.column)
  if (last.length !== 3 || last.some((p) => p.cell.rowSpan !== 1 || p.cell.colSpan !== 1))
    return false
  const [label, symbol, value] = last,
    selected = last.flatMap((p) => p.fonts)
  if (
    !/^\p{L}$/u.test(symbol.cell.text.trim()) ||
    !/\p{L}{3}/u.test(label.cell.text) ||
    !scalar(value.cell.text) ||
    !aligned(selected) ||
    !complete(selected, inventory)
  )
    return false
  const box = union(selected),
    h = symbol.fonts[0].height,
    edges = horizontal(rules).filter((r) => r[0] <= box[0] && r[2] >= box[2]),
    previous = proof.proved.filter((p) => p.cell.row === row - 1).flatMap((p) => p.fonts),
    top = edges.find((r) => r[1] < box[1] && previous.length && r[1] > union(previous)[3])
  if (!top || !edges.some((r) => r[1] > box[3])) return false
  const peers = proof.proved.filter(
    (p) => p.cell.column === 1 && p.cell.row > 0 && p.cell.row < row
  )
  if (
    peers.length < 3 ||
    peers.some((p) => p.cell.rowSpan !== 1 || p.cell.colSpan !== 1 || !scalar(p.cell.text))
  )
    return false
  const a = union(label.fonts),
    b = union(symbol.fonts)
  return (
    b[0] >= a[2] &&
    b[0] - a[2] < h &&
    b[2] < Math.min(...peers.flatMap((p) => p.fonts).map((f) => f.rect[0]))
  )
}

function hasMergedPairedRecords(proof, table, inventory, rules) {
  const fonts = completeFinalPacket(proof, table, inventory)
  if (!fonts || table.grid[0].length !== 2) return false
  const box = union(fonts),
    edges = horizontal(rules).filter((r) => r[0] <= box[0] && r[2] >= box[2])
  if (!edges.some((r) => r[1] < box[1]) || !edges.some((r) => r[1] > box[3])) return false
  const lines = (p) => {
    const h = Math.max(...p.fonts.map((f) => f.height)),
      rows = []
    for (const f of p.fonts
      .filter((f) => Math.abs(f.height - h) <= h * 0.001)
      .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
      const last = rows.at(-1)
      if (last && Math.abs(last[0].baseline - f.baseline) <= h * 0.001) last.push(f)
      else rows.push([f])
    }
    return rows
  }
  const pairs = Array.from({ length: table.grid.length }, (_, r) =>
    proof.proved.filter((p) => p.cell.row === r).sort((a, b) => a.cell.column - b.cell.column)
  ).filter((ps) => ps.length === 2 && ps.every((p) => p.cell.colSpan === 1 && p.cell.rowSpan === 1))
  const ordinary = pairs.filter(
    ([a, b]) =>
      lines(a).length === 1 &&
      lines(b).length === 1 &&
      Math.abs(lines(a)[0][0].baseline - lines(b)[0][0].baseline) < lines(a)[0][0].height * 0.001 &&
      /\d/u.test(b.cell.text)
  )
  if (ordinary.length < 2) return false
  for (const [a, b] of pairs) {
    const left = lines(a),
      right = lines(b)
    if (left.length !== 2 || right.length !== 2) continue
    const domain = union([...a.fonts, ...b.fonts])
    // Adjacent verified records can have script advance boxes touching this
    // band. They remain distinct whole owners; unclaimed/unknown ink cannot
    // participate in this paired-record evidence.
    if (
      inventory.some(
        (f) =>
          f.text?.trim() && (!rect(f.rect) || (!fonts.includes(f) && intersects(f.rect, domain)))
      )
    )
      continue
    if (
      left.some(
        (line, n) =>
          !line.some((f) => /\p{L}/u.test(f.text)) ||
          Math.abs(line[0].baseline - right[n][0].baseline) > line[0].height * 0.001 ||
          !/^[\d\s.,+−-]+$/u.test(right[n].map((f) => f.text).join(' ')) ||
          Math.max(...line.map((f) => f.rect[2])) >= Math.min(...right[n].map((f) => f.rect[0]))
      )
    )
      continue
    if (
      Math.max(...left[0].map((f) => f.rect[3]), ...right[0].map((f) => f.rect[3])) >=
      Math.min(...left[1].map((f) => f.rect[1]), ...right[1].map((f) => f.rect[1]))
    )
      continue
    return true
  }
  return false
}

const scalar = (text) => /^[+−–-]?(?:\d+(?:\.\d*)?|\.\d+)$/u.test(compact(text))
const textOf = (fonts) =>
  [...fonts]
    .sort((a, b) => a.rect[0] - b.rect[0])
    .map((i) => i.text)
    .join('')
const horizontal = (rules) =>
  rules.filter((r) => r?.length === 4 && r.every(Number.isFinite) && r[1] === r[3] && r[0] < r[2])
const aligned = (fonts) =>
  fonts.length > 0 &&
  fonts.every(
    (i) =>
      Math.abs(i.baseline - fonts[0].baseline) <= 1e-6 &&
      Math.abs(i.height - fonts[0].height) <= 1e-6
  )
const ordinaryLines = (fonts) => {
  const lines = []
  for (const font of [...fonts].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    let line = lines.find((l) => Math.abs(l[0].baseline - font.baseline) <= 1e-6)
    if (!line) {
      line = []
      lines.push(line)
    }
    line.push(font)
  }
  return lines.every(aligned) ? lines : null
}

// A complete native divider separates header baselines from a numeric record,
// while model header cells still own both. Em boxes may meet the divider: that
// is precisely why this is review-only, never a reconstructed row boundary.
function firstRecordInHeader({ proved }, inventory, rules) {
  for (const rule of horizontal(rules)) {
    const candidates = proved
      .filter((p) => p.cell.row <= 1 && p.cell.rowSpan === 1 && p.cell.colSpan === 1)
      .flatMap((p) => {
        const upper = p.fonts.filter((i) => i.baseline < rule[1]),
          lower = p.fonts.filter((i) => i.baseline > rule[1])
        if (
          !upper.length ||
          !aligned(lower) ||
          !scalar(textOf(lower)) ||
          !/[\p{L}↑↓]/u.test(textOf(upper)) ||
          upper.some((i) => i.rect[3] >= rule[1]) ||
          lower.some((i) => i.rect[0] < rule[0] || i.rect[2] > rule[2]) ||
          !complete(p.fonts, inventory)
        )
          return []
        return [{ ...p, upper, lower }]
      })
    for (const row of new Set(candidates.map((p) => p.cell.row))) {
      const fields = candidates.filter((p) => p.cell.row === row)
      if (fields.length < 2 || !aligned(fields.flatMap((p) => p.lower))) continue
      const box = union(fields.flatMap((p) => p.fonts))
      if (rule[0] > box[0] || rule[2] < box[2]) continue
      const peers = [
        ...new Set(proved.filter((p) => p.cell.row > row).map((p) => p.cell.row))
      ].filter((r) => {
        const cells = fields.map((p) =>
          proved.find((q) => q.cell.row === r && q.cell.column === p.cell.column)
        )
        return (
          cells.every(
            (p) =>
              p &&
              p.cell.rowSpan === 1 &&
              p.cell.colSpan === 1 &&
              scalar(p.cell.text) &&
              complete(p.fonts, inventory)
          ) && aligned(cells.flatMap((p) => p.fonts))
        )
      })
      if (peers.length < 2) continue
      const owners = new Map(proved.flatMap((p) => p.fonts.map((i) => [i, p])))
      if (
        framedHeader(
          fields.flatMap((p) => p.fonts),
          inventory,
          rules,
          owners
        )
      )
        return true
      // Some native em boxes extend across the printed divider despite distinct
      // baselines. Only this ambiguity branch may review that arrangement; every
      // intersecting font, including the adjacent body row, still needs an exact
      // whole owner. No claim about glyph outlines or corrected boundaries follows.
      const full = horizontal(rules)
        .filter((r) => r[0] <= box[0] && r[2] >= box[2])
        .sort((a, b) => a[1] - b[1])
      const top = full.filter((r) => r[1] < box[1]).at(-1),
        bottom = full.find(
          (r) => r[1] > Math.max(...fields.flatMap((p) => p.lower).map((i) => i.baseline))
        )
      if (!top || !bottom) continue
      const frame = [Math.max(top[0], bottom[0]), top[1], Math.min(top[2], bottom[2]), bottom[1]]
      const ink = inventory.filter(
        (i) => i.text?.trim() && rect(i.rect) && intersects(i.rect, frame)
      )
      if (
        ink.length &&
        ink.every((i) => {
          const owner = owners.get(i)
          return (
            owner &&
            i.baseline !== top[1] &&
            i.baseline !== bottom[1] &&
            (i.baseline > top[1] && i.baseline < bottom[1]
              ? owner.cell.row <= row
              : owner.cell.row > row)
          )
        })
      )
        return true
    }
  }
  return false
}

// A sparse one-column title crossing established body lanes is ambiguous when
// this same table has an otherwise matching full-width section title. Native
// divider baselines support review, not a guessed replacement colSpan: font em
// boxes may overlap the dividers, so this is not a closed-glyph reconstruction.
function hasSparseSectionHeadingAmbiguity({ proved }, table, inventory, rules) {
  if (!hasDisjointNativeTableSlots(table) || table.grid[0].length < 3) return false
  const width = table.grid[0].length,
    nonempty = table.cells.filter((c) => c.text.trim()),
    fonts = proved.flatMap((p) => p.fonts)
  if (
    proved.length !== nonempty.length ||
    nonempty.some((c) => proved.filter((p) => p.cell === c).length !== 1) ||
    table.cells.some((c) => table.grid[c.row][c.column] !== c.text) ||
    fonts.some((f) => !f.horizontal || !Number.isFinite(f.baseline) || !(f.height > 0)) ||
    !proveNativeUniqueWholeFonts(fonts, inventory)
  )
    return false
  const records = (row) => {
    const rows = [row + 1, row + 2].map((r) =>
      proved.filter((p) => p.cell.row === r).sort((a, b) => a.cell.column - b.cell.column)
    )
    if (
      rows.some(
        (ps) =>
          ps.length !== width ||
          ps.some((p, c) => p.cell.column !== c || p.cell.colSpan !== 1 || p.cell.rowSpan !== 1) ||
          !aligned(ps.flatMap((p) => p.fonts))
      )
    )
      return null
    if (
      rows[0][0].fonts[0].baseline >=
      Math.min(...rows[1].flatMap((p) => p.fonts).map((f) => f.rect[1]))
    )
      return null
    const lanes = Array.from({ length: width }, (_, c) => union(rows.flatMap((ps) => ps[c].fonts)))
    if (lanes.some((r, c) => c > 0 && lanes[c - 1][2] >= r[0])) return null
    return { rows, lanes }
  }
  const section = (p, record) => {
    if (
      !record ||
      p.fonts.length !== 1 ||
      p.cell.rowSpan !== 1 ||
      p.cell.column !== 0 ||
      proved.filter((q) => q.cell.row === p.cell.row).length !== 1
    )
      return null
    const font = p.fonts[0],
      next = record.rows[0][0].fonts[0].baseline,
      domain = union([...p.fonts, ...record.rows.flatMap((ps) => ps.flatMap((q) => q.fonts))])
    if (
      font.baseline >= next ||
      Math.abs(font.rect[0] - record.lanes[0][0]) > 1e-6 ||
      font.rect[2] <= record.lanes[1][0]
    )
      return null
    const edges = horizontal(rules).filter((r) => r[0] <= domain[0] && r[2] >= domain[2]),
      top = edges.filter((r) => r[1] < font.baseline).at(-1),
      bottom = edges.find((r) => r[1] > font.rect[3] && r[1] < next)
    if (!top || !bottom) return null
    const allowed = new Set([...p.fonts, ...record.rows[0].flatMap((q) => q.fonts)]),
      band = [Math.max(top[0], bottom[0]), top[1], Math.min(top[2], bottom[2]), bottom[1]]
    if (
      inventory.some(
        (f) => f.text?.trim() && (!rect(f.rect) || (!allowed.has(f) && intersects(f.rect, band)))
      )
    )
      return null
    return font
  }
  const peers = proved.filter((p) => p.cell.column === 0 && p.cell.colSpan === width)
  for (const p of proved.filter(
    (p) => p.cell.row > 0 && p.cell.column === 0 && p.cell.colSpan === 1
  )) {
    const title = section(p, records(p.cell.row))
    if (!title) continue
    for (const peer of peers) {
      const other = section(peer, records(peer.cell.row))
      if (
        other &&
        Math.abs(title.height - other.height) <= 1e-6 &&
        Math.abs(title.rect[0] - other.rect[0]) <= 1e-6
      )
        return true
    }
  }
  return false
}

function sectionInRecord({ proved }, table, inventory, rules) {
  const width = table.grid[0].length
  const sections = proved.filter(
    (p) =>
      p.cell.column === 0 &&
      p.cell.colSpan === width &&
      p.cell.rowSpan === 1 &&
      ordinaryLines(p.fonts)?.length === 1
  )
  if (!sections.length || width < 3) return false
  for (const p of proved.filter(
    (p) => p.cell.column === 0 && p.cell.colSpan === 1 && p.cell.rowSpan === 1
  )) {
    const lines = ordinaryLines(p.fonts)
    if (
      lines?.length !== 2 ||
      !sections.some((s) => s.cell.row < p.cell.row) ||
      !aligned([...lines[0], ...sections[0].fonts].map((i) => ({ ...i, baseline: 0 })))
    )
      continue
    const [title, stub] = lines
    if (
      title
        .map((i) => i.text)
        .join(' ')
        .trim()
        .split(/\s+/u).length < 2 ||
      Math.abs(title[0].rect[0] - stub[0].rect[0]) > 1e-6 ||
      title[0].baseline >= stub[0].rect[1] ||
      !complete(p.fonts, inventory)
    )
      continue
    const fields = proved.filter((q) => q.cell.row === p.cell.row && q.cell.column > 0)
    if (
      fields.length !== width - 1 ||
      fields.some((q) => q.cell.colSpan !== 1 || q.cell.rowSpan !== 1) ||
      !aligned([...stub, ...fields.flatMap((q) => q.fonts)])
    )
      continue
    const all = [...p.fonts, ...fields.flatMap((q) => q.fonts)],
      domain = union(all)
    const opening = horizontal(rules)
      .filter(
        (r) =>
          r[1] < Math.min(...title.map((i) => i.rect[1])) && r[0] <= domain[0] && r[2] >= domain[2]
      )
      .at(-1)
    if (
      !opening ||
      horizontal(rules).some(
        (r) =>
          r[1] > title[0].baseline &&
          r[1] < stub[0].baseline &&
          r[0] < domain[2] &&
          r[2] > domain[0]
      )
    )
      continue
    const peers = [
      ...new Set(proved.filter((q) => q.cell.row > p.cell.row).map((q) => q.cell.row))
    ].filter((row) => {
      const cs = proved.filter((q) => q.cell.row === row)
      return (
        cs.length === width &&
        cs.every((q) => q.cell.colSpan === 1 && q.cell.rowSpan === 1) &&
        aligned(cs.flatMap((q) => q.fonts)) &&
        complete(
          cs.flatMap((q) => q.fonts),
          inventory
        )
      )
    })
    if (
      peers.length >= 2 &&
      framedHeader(
        all,
        inventory,
        rules,
        new Map(proved.flatMap((q) => q.fonts.map((i) => [i, q])))
      )
    )
      return true
  }
  return false
}

function terminalWrappedRecord({ proved }, table, inventory, rules) {
  const last = table.grid.length - 1,
    width = table.grid[0].length
  const tail = proved.filter((p) => p.cell.row === last),
    previous = proved.filter((p) => p.cell.row === last - 1)
  if (
    tail.length < 2 ||
    tail.length >= width ||
    previous.length !== width ||
    [...tail, ...previous].some((p) => p.cell.rowSpan !== 1 || p.cell.colSpan !== 1)
  )
    return false
  const start = Math.min(...tail.map((p) => p.cell.column))
  if (start < 1 || tail.length !== width - start || tail.some((p) => p.cell.column < start))
    return false
  const tailFonts = tail.flatMap((p) => p.fonts)
  if (
    !aligned(tailFonts) ||
    !complete([...tailFonts, ...previous.flatMap((p) => p.fonts)], inventory)
  )
    return false
  const h = tailFonts[0].height
  for (const q of tail) {
    const p = previous.find((p) => p.cell.column === q.cell.column),
      lines = ordinaryLines(p.fonts)
    if (
      !lines ||
      lines.length < 2 ||
      lines.some((line) => line.some((i) => Math.abs(i.height - h) > 1e-6))
    )
      return false
    const gap = lines.at(-1)[0].baseline - lines.at(-2)[0].baseline
    if (
      gap <= h ||
      gap > 2 * h ||
      Math.abs(q.fonts[0].baseline - lines.at(-1)[0].baseline - gap) > h * 0.001 ||
      Math.abs(
        Math.min(...q.fonts.map((i) => i.rect[0])) - Math.min(...lines.at(-1).map((i) => i.rect[0]))
      ) >
        h * 0.001
    )
      return false
  }
  const previousFirst = Math.min(...previous.flatMap((p) => p.fonts).map((i) => i.baseline))
  if (
    previous
      .filter((p) => p.cell.column < start)
      .some((p) => !aligned(p.fonts) || Math.abs(p.fonts[0].baseline - previousFirst) > 1e-6)
  )
    return false
  const box = union([...previous.flatMap((p) => p.fonts), ...tailFonts])
  if (
    horizontal(rules).some(
      (r) => r[1] > previousFirst && r[1] < tailFonts[0].baseline && r[0] < box[2] && r[2] > box[0]
    )
  )
    return false
  const peers = [
    ...new Set(proved.filter((p) => p.cell.row > 0 && p.cell.row < last - 1).map((p) => p.cell.row))
  ].filter((row) => {
    const cells = proved.filter((p) => p.cell.row === row)
    return (
      cells.length === width &&
      cells.every((p) => p.cell.rowSpan === 1 && p.cell.colSpan === 1) &&
      cells
        .filter((p) => p.cell.column >= start)
        .every((p) => ordinaryLines(p.fonts)?.length >= 2) &&
      complete(
        cells.flatMap((p) => p.fonts),
        inventory
      )
    )
  })
  if (peers.length < 2) return false
  const owners = new Map(proved.flatMap((p) => p.fonts.map((i) => [i, p])))
  // Native line coordinates can differ at machine precision after scaling.
  const frameRules = horizontal(rules).map((r) => [r[0] - 1e-6, r[1], r[2] + 1e-6, r[3]])
  return !!framedHeader(
    [...previous.flatMap((p) => p.fonts), ...tailFonts],
    inventory,
    frameRules,
    owners
  )
}

const nativeRecordBox = (fonts) => [
  Math.min(...fonts.map((f) => f.rect[0])),
  Math.min(...fonts.map((f) => f.rect[1])),
  Math.max(...fonts.map((f) => f.rect[2])),
  Math.max(...fonts.map((f) => f.rect[3]))
]
const nativeRecordOverlaps = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
const nativeRecordScalar = (t) => /^[+−-]?\d+(?:\.\d+)?$/u.test(t)
const nativeRecordLine = (fonts) =>
  fonts.length &&
  fonts.every(
    (f) =>
      f.horizontal &&
      Number.isFinite(f.baseline) &&
      f.height > 0 &&
      Math.abs(f.baseline - fonts[0].baseline) < 1e-6 &&
      Math.abs(f.height - fonts[0].height) < 1e-6
  )
function nativeRecordFrame(fonts, inventory, rules) {
  const b = nativeRecordBox(fonts),
    hs = rules
      .filter((r) => r[1] === r[3] && r[0] <= b[0] && r[2] >= b[2])
      .sort((a, b) => a[1] - b[1]),
    top = hs.filter((r) => r[1] < b[1]).at(-1),
    bottom = hs.find((r) => r[1] > b[3])
  return (
    !!top &&
    !!bottom &&
    top[0] === bottom[0] &&
    top[2] === bottom[2] &&
    !hs.some((r) => r[1] > b[1] && r[1] < b[3]) &&
    !inventory.some(
      (f) =>
        f.text?.trim() &&
        (!Array.isArray(f.rect) ||
          f.rect.length !== 4 ||
          !f.rect.every(Number.isFinite) ||
          (!fonts.includes(f) && nativeRecordOverlaps(f.rect, b)))
    )
  )
}
function hasUnclaimedCompleteNativeRecord(proof, table, inventory, rules) {
  if (!proof || !rect(table.cropRect) || !hasDisjointNativeTableSlots(table)) return false
  const columns = table.grid[0].length,
    headers = proof.proved
      .filter((p) => p.cell.row === 0)
      .sort((a, b) => a.cell.column - b.cell.column)
  if (
    columns < 3 ||
    headers.length !== columns ||
    headers.some((p, c) => p.cell.column !== c || p.cell.colSpan !== 1 || p.cell.rowSpan !== 1)
  )
    return false
  const ranges = headers.map((p) => [p.cell.rect[0], p.cell.rect[2]])
  if (ranges.some((r, c) => c && r[0] !== ranges[c - 1][1])) return false
  const claimed = new Set(proof.proved.flatMap((p) => p.fonts)),
    unclaimed = inventory.filter(
      (f) =>
        f.text?.trim() &&
        !claimed.has(f) &&
        f.horizontal &&
        f.rect?.[0] >= table.cropRect[0] &&
        f.rect[2] <= table.cropRect[2] &&
        f.rect[1] > Math.max(...headers.flatMap((p) => p.fonts.map((f) => f.rect[3]))) &&
        f.rect[3] < table.cropRect[3]
    )
  const groups = []
  for (const f of unclaimed.sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    const last = groups.at(-1)
    if (last && Math.abs(last[0].baseline - f.baseline) < 1e-6) last.push(f)
    else groups.push([f])
  }
  const peers = []
  for (let row = 1; row < table.grid.length; row++) {
    const ps = proof.proved
        .filter((p) => p.cell.row === row)
        .sort((a, b) => a.cell.column - b.cell.column),
      fonts = ps.flatMap((p) => p.fonts)
    if (
      ps.length === columns &&
      ps.every(
        (p, c) =>
          p.cell.column === c &&
          p.cell.rowSpan === 1 &&
          p.cell.colSpan === 1 &&
          p.fonts.every((f) => f.rect[0] >= ranges[c][0] && f.rect[2] <= ranges[c][1])
      ) &&
      nativeRecordLine(fonts)
    )
      peers.push({ ps, fonts, y: fonts[0].baseline })
  }
  for (const fonts of groups) {
    if (!nativeRecordLine(fonts) || !proveNativeUniqueWholeFonts(fonts, inventory)) continue
    const fields = ranges.map((r) =>
      fonts
        .filter((f) => f.rect[0] >= r[0] && f.rect[2] <= r[1])
        .sort((a, b) => a.rect[0] - b.rect[0])
    )
    if (fields.some((f) => !f.length) || fields.flat().length !== fonts.length) continue
    const texts = fields.map((fs) => fs.map((f) => f.text).join(''))
    if (texts.filter(nativeRecordScalar).length < 2) continue
    const before = peers.filter((p) => p.y < fonts[0].baseline).at(-1),
      after = peers.find((p) => p.y > fonts[0].baseline)
    if (!before || !after) continue
    const h = fonts[0].height,
      left = fonts[0].baseline - before.y,
      right = after.y - fonts[0].baseline
    if (
      left <= h ||
      right <= h ||
      left > h * 2 ||
      right > h * 2 ||
      Math.abs(left - right) > h * 0.001 ||
      [before, after].some(
        (p) =>
          Math.abs(p.fonts[0].height - h) > 1e-6 ||
          p.ps.some((v, c) => nativeRecordScalar(v.cell.text) !== nativeRecordScalar(texts[c]))
      )
    )
      continue
    const witness = [...before.fonts, ...fonts, ...after.fonts]
    if (
      !proveNativeUniqueWholeFonts(witness, inventory) ||
      !nativeRecordFrame(witness, inventory, rules)
    )
      continue
    return true
  }
  return false
}
function hasMergedNativeDescriptorLanes(proof, table, inventory, rules) {
  if (!proof) return false
  for (const head of proof.proved.filter(
    (p) => p.cell.row === 0 && p.cell.colSpan === 1 && p.cell.rowSpan === 1
  )) {
    const h = [...head.fonts].sort((a, b) => a.rect[0] - b.rect[0])
    if (
      h.length !== 2 ||
      !nativeRecordLine(h) ||
      h.some((f) => !/^\p{L}+$/u.test(f.text)) ||
      h[1].rect[0] - h[0].rect[2] < h[0].height
    )
      continue
    const cut = (h[0].rect[2] + h[1].rect[0]) / 2,
      peers = proof.proved
        .filter(
          (p) =>
            p.cell.row > 0 &&
            p.cell.column === head.cell.column &&
            p.cell.rowSpan === 1 &&
            p.cell.colSpan === 1
        )
        .map((p) => ({ p, fonts: [...p.fonts].sort((a, b) => a.rect[0] - b.rect[0]) }))
        .filter(
          ({ fonts: f }) =>
            f.length === 2 &&
            nativeRecordLine(f) &&
            /^\d+$/u.test(f[0].text) &&
            /^\p{L}+$/u.test(f[1].text) &&
            f[0].rect[2] < cut &&
            f[1].rect[0] > cut &&
            f[0].rect[0] <= h[0].rect[2] &&
            f[0].rect[2] >= h[0].rect[0] &&
            f[1].rect[0] <= h[1].rect[2] &&
            f[1].rect[2] >= h[1].rect[0]
        )
    if (peers.length < 3) continue
    const fonts = [...h, ...peers.slice(0, 3).flatMap((p) => p.fonts)],
      b = nativeRecordBox(fonts),
      hs = rules
        .filter((r) => r[1] === r[3] && r[0] <= b[0] && r[2] >= b[2])
        .sort((a, b) => a[1] - b[1]),
      top = hs.filter((r) => r[1] < b[1]).at(-1),
      divider = hs.find(
        (r) =>
          r[1] > Math.max(...h.map((f) => f.rect[3])) &&
          r[1] < Math.min(...peers.flatMap((p) => p.fonts.map((f) => f.rect[1])))
      ),
      bottom = hs.find((r) => r[1] > b[3])
    if (
      !top ||
      !divider ||
      !bottom ||
      top[0] !== divider[0] ||
      top[2] !== divider[2] ||
      bottom[0] !== top[0] ||
      bottom[2] !== top[2] ||
      !proveNativeUniqueWholeFonts(fonts, inventory)
    )
      continue
    if (
      inventory.some(
        (f) =>
          f.text?.trim() &&
          !fonts.includes(f) &&
          (!Array.isArray(f.rect) ||
            f.rect.length !== 4 ||
            !f.rect.every(Number.isFinite) ||
            nativeRecordOverlaps(f.rect, b))
      )
    )
      continue
    return true
  }
  return false
}

// The existing shared stub and every peer leaf remain intact. An additional
// complete native symbol row is review evidence, not permission to infer the
// group label's new span or assign rotated category labels.
function hasUnclaimedSharedSymbolRecord({ proved }, table, inventory, rules) {
  if (!hasDisjointNativeTableSlots(table) || table.grid[0].length < 4) return false
  const width = table.grid[0].length
  for (const stub of proved.filter(
    (p) => p.cell.column === 0 && p.cell.colSpan === 1 && p.cell.rowSpan >= 2
  )) {
    const cells = table.cells.filter(
      (c) => c.column > 0 && c.row >= stub.cell.row && c.row < stub.cell.row + stub.cell.rowSpan
    )
    const peers = proved.filter((p) => cells.includes(p.cell))
    if (
      cells.length !== stub.cell.rowSpan * (width - 1) ||
      peers.length !== cells.length ||
      peers.some((p) => p.cell.rowSpan !== 1 || p.cell.colSpan !== 1 || p.fonts.length !== 1)
    )
      continue
    const first = peers
      .filter((p) => p.cell.row === stub.cell.row)
      .sort((a, b) => a.cell.column - b.cell.column)
    if (first.some((p, n) => p.cell.column !== n + 1)) continue
    const ranges = first.map((p) => [p.cell.rect[0], p.cell.rect[2]])
    if (ranges.some((r, n) => n && r[0] !== ranges[n - 1][1])) continue
    const owned = peers.flatMap((p) => p.fonts),
      box = union(owned)
    const hs = horizontal(rules)
      .filter((r) => r[0] <= box[0] && r[2] >= box[2])
      .sort((a, b) => a[1] - b[1])
    const opening = hs.filter((r) => r[1] < box[1]).at(-1),
      closing = hs.find((r) => r[1] > box[3])
    if (!opening || !closing || hs.some((r) => r[1] > box[1] && r[1] < box[3])) continue
    const domain = [ranges[0][0], opening[1], ranges.at(-1)[1], closing[1]]
    const fonts = inventory.filter(
      (i) => i.text?.trim() && rect(i.rect) && intersects(i.rect, domain)
    )
    if (
      !fonts.length ||
      fonts.some(
        (i) =>
          !i.horizontal ||
          i.rect[0] < domain[0] ||
          i.rect[2] > domain[2] ||
          i.rect[1] <= domain[1] ||
          i.rect[3] >= domain[3]
      ) ||
      !proveNativeUniqueWholeFonts([...stub.fonts, ...fonts], inventory)
    )
      continue
    if (
      rules.some(
        (r) =>
          r[1] !== r[3] &&
          Math.min(r[0], r[2]) < domain[2] &&
          Math.max(r[0], r[2]) > domain[0] &&
          Math.min(r[1], r[3]) < domain[3] &&
          Math.max(r[1], r[3]) > domain[1]
      )
    )
      continue
    const h = Math.max(...fonts.map((i) => i.height)),
      lines = []
    for (const font of [...fonts].sort(
      (a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0]
    )) {
      const last = lines.at(-1)
      if (last && Math.abs(last[0].baseline - font.baseline) <= h * 0.2) last.push(font)
      else lines.push([font])
    }
    if (lines.length !== stub.cell.rowSpan + 1 || lines.length < 3) continue
    const records = lines.map((line) =>
      ranges.map((r) => line.filter((i) => i.rect[0] >= r[0] && i.rect[2] <= r[1]))
    )
    if (
      records.some(
        (fields, n) =>
          fields.some((f) => f.length !== 1) ||
          fields.flat().length !== lines[n].length ||
          !/^\p{L}/u.test(fields[0][0].text) ||
          fields.slice(1).some((f) => !/^\p{S}$/u.test(f[0].text)) ||
          lines[n].some((i) => Math.abs(i.height - h) > h * 0.2)
      )
    )
      continue
    if (lines.slice(1).some((line, n) => union(lines[n])[3] >= union(line)[1])) continue
    const owners = new Map(proved.flatMap((p) => p.fonts.map((i) => [i, p.cell])))
    const missing = lines.filter((line) => line.every((i) => !owners.has(i)))
    if (missing.length !== 1 || lines[0] === missing[0] || lines.at(-1) === missing[0]) continue
    const existing = lines.filter((line) => line !== missing[0])
    if (existing.some((line, n) => line.some((i) => owners.get(i)?.row !== stub.cell.row + n)))
      continue
    // Every assigned font in this group participates, and the extra row is
    // wholly unclaimed, rather than a split or partially owned native parent.
    if (owned.length !== existing.flat().length || owned.some((i) => !existing.flat().includes(i)))
      continue
    return true
  }
  return false
}

// A whole native parent in its own ruled band cannot silently disappear while
// its leaf fields are mapped. This does not assign overlapping accent fonts or
// infer the parent's text/span: those remain in the original source component.
export function hasUnclaimedUnderlinedHeading(proof, table, inventory, rules) {
  if (
    !proof ||
    inventory.some(
      (i) =>
        i.text?.trim() &&
        (!Array.isArray(i.rect) || i.rect.length !== 4 || !i.rect.every(Number.isFinite))
    )
  )
    return false
  const { proved } = proof
  if (!hasDisjointNativeTableSlots(table) || !rect(table.cropRect)) return false
  const heads = proved.filter((p) => p.cell.row === 0)
  if (
    heads.length !== table.grid[0].length ||
    heads.length < 3 ||
    heads.some((p) => p.cell.rowSpan !== 1 || p.cell.colSpan !== 1 || !p.fonts.length)
  )
    return false
  const hfonts = heads.flatMap((p) => p.fonts),
    hb = union(hfonts)
  const hs = horizontal(rules).sort((a, b) => a[1] - b[1])
  const divider = hs.find((r) => r[0] <= hb[0] && r[2] >= hb[2] && r[1] > hb[3])
  if (!divider) return false
  const opening = hs
    .filter((r) => r[0] === divider[0] && r[2] === divider[2] && r[1] < hb[1])
    .at(-1)
  if (!opening || opening[0] < table.cropRect[0] || opening[2] > table.cropRect[2]) return false
  const owned = new Set(proved.flatMap((p) => p.fonts))
  const candidates = hs.filter(
    (r) => r[1] > opening[1] && r[1] < hb[3] && r[0] > opening[0] && r[2] < opening[2]
  )
  for (const underline of candidates) {
    const leaves = heads.filter((p) =>
      p.fonts.every((f) => f.rect[0] >= underline[0] && f.rect[2] <= underline[2])
    )
    if (leaves.length < 2) continue
    const cols = leaves.map((p) => p.cell.column).sort((a, b) => a - b)
    if (cols.some((c, n) => n && c !== cols[n - 1] + 1)) continue
    const body = proved.filter((p) => p.cell.row > 0 && cols.includes(p.cell.column))
    if (
      body.length !== (table.grid.length - 1) * cols.length ||
      table.grid.length < 4 ||
      body.some(
        (p) =>
          p.cell.rowSpan !== 1 ||
          p.cell.colSpan !== 1 ||
          p.fonts.length !== 1 ||
          !/^[<>≤≥−+-]?\d[\d.,%]*$/u.test(p.fonts[0].text.trim())
      )
    )
      continue
    const domain = [opening[0], opening[1], opening[2], divider[1]]
    if (
      inventory.some(
        (i) =>
          i.text?.trim() &&
          !rect(i.rect) &&
          i.rect[0] <= domain[2] &&
          i.rect[2] >= domain[0] &&
          i.rect[1] <= domain[3] &&
          i.rect[3] >= domain[1]
      )
    )
      continue
    const fonts = inventory.filter(
      (i) => i.text?.trim() && rect(i.rect) && intersects(i.rect, domain)
    )
    if (
      fonts.some((i) => !i.horizontal || !containsNativeRect(domain, i.rect)) ||
      !proveNativeUniqueWholeFonts(fonts, inventory)
    )
      continue
    const parent = fonts.filter((i) => !owned.has(i) && i.rect[3] < underline[1])
    if (
      !parent.length ||
      parent.some(
        (i) =>
          owned.has(i) ||
          i.rect[0] < underline[0] ||
          i.rect[2] > underline[2] ||
          i.rect[1] <= opening[1]
      ) ||
      !parent.some((i) => /\p{L}/u.test(i.text))
    )
      continue
    if (
      fonts.length !== parent.length + hfonts.length ||
      hfonts.some(
        (i) =>
          !fonts.includes(i) ||
          (i.rect[0] < underline[2] && i.rect[2] > underline[0] && i.rect[1] <= underline[1])
      )
    )
      continue
    if (
      rules.some(
        (r) =>
          r[1] !== r[3] &&
          Math.min(r[0], r[2]) < domain[2] &&
          Math.max(r[0], r[2]) > domain[0] &&
          Math.min(r[1], r[3]) < domain[3] &&
          Math.max(r[1], r[3]) > domain[1]
      )
    )
      continue
    return true
  }
  return false
}
function containsNativeRect(a, b) {
  return b[0] >= a[0] && b[2] <= a[2] && b[1] > a[1] && b[3] < a[3]
}

function hasRepeatedBlankStubContinuations({ proved }, table, inventory, rules) {
  if (
    table.grid[0].length !== 3 ||
    !rect(table.cropRect) ||
    !hasDisjointNativeTableSlots(table) ||
    table.cells.some((c) => c.rowSpan !== 1 || c.colSpan !== 1)
  )
    return false
  const nonempty = table.cells.filter((c) => c.text.trim()),
    ps = proved.filter((p) => p.fonts.length)
  if (nonempty.length !== ps.length || nonempty.some((c) => !ps.some((p) => p.cell === c)))
    return false
  const fonts = ps.flatMap((p) => p.fonts),
    heads = ps.filter((p) => p.cell.row === 0)
  if (heads.length !== 3 || !proveNativeUniqueWholeFonts(fonts, inventory)) return false
  const hb = union(heads.flatMap((p) => p.fonts)),
    box = union(fonts)
  const hs = horizontal(rules)
    .filter((r) => r[0] <= hb[0] && r[2] >= hb[2])
    .sort((a, b) => a[1] - b[1])
  const opening = hs.filter((r) => r[1] < hb[1]).at(-1),
    divider = hs.find((r) => r[1] > hb[3]),
    closing = hs.find((r) => r[1] > box[3])
  if (
    !opening ||
    !divider ||
    !closing ||
    divider === closing ||
    opening[0] !== divider[0] ||
    opening[2] !== divider[2] ||
    closing[0] !== opening[0] ||
    closing[2] !== opening[2] ||
    hs.some((r) => r[1] > divider[1] && r[1] < closing[1])
  )
    return false
  const domain = [table.cropRect[0], opening[1], table.cropRect[2], closing[1]]
  if (
    fonts.some((f) => !containsNativeRect(domain, f.rect)) ||
    inventory.some(
      (i) => i.text?.trim() && (!rect(i.rect) || (!fonts.includes(i) && intersects(i.rect, domain)))
    )
  )
    return false
  const prose = (p) => p && /\p{L}/u.test(p.fonts.map((f) => f.text).join(' '))
  let continuations = 0
  for (let row = 2; row < table.grid.length; row++) {
    if (table.grid[row][0].trim() || !table.grid[row - 1][0].trim()) continue
    const previous = ps.filter((p) => p.cell.row === row - 1),
      tail = ps.filter((p) => p.cell.row === row)
    if (
      previous.length !== 3 ||
      tail.length !== 2 ||
      tail.some((p) => p.cell.column === 0) ||
      previous.some((p) => !prose(p)) ||
      tail.some((p) => !prose(p))
    )
      continue
    if (
      tail.some(
        (p) =>
          Math.min(...p.fonts.map((f) => f.rect[1])) <=
          Math.max(
            ...previous.find((q) => q.cell.column === p.cell.column).fonts.map((f) => f.rect[3])
          )
      )
    )
      continue
    continuations++
  }
  return continuations >= 2
}

export function hasEquationMatrixFields(proof, table, inventory, rules) {
  if (!proof) return false
  const { proved } = proof
  if (
    !hasDisjointNativeTableSlots(table) ||
    table.cells.some((c) => c.rowSpan !== 1 || c.colSpan !== 1)
  )
    return false
  const fonts = proved.flatMap((p) => p.fonts)
  if (!fonts.length || !proveNativeUniqueWholeFonts(fonts, inventory)) return false
  const equal = fonts.filter((i) => i.text.trim() === '='),
    numbers = fonts.filter((i) => /^\d+$/u.test(i.text.trim()))
  if (
    equal.length !== 1 ||
    numbers.length < 9 ||
    fonts.some((i) => !numbers.includes(i) && i !== equal[0] && !/^[∗*.]$/u.test(i.text.trim()))
  )
    return false
  const h = numbers[0].height,
    rows = []
  if (
    !Number.isFinite(h) ||
    h <= 0 ||
    numbers.some((i) => !i.horizontal || Math.abs(i.height - h) > h * 0.001)
  )
    return false
  for (const i of [...numbers].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    const last = rows.at(-1)
    if (last && Math.abs(last[0].baseline - i.baseline) <= h * 0.001) last.push(i)
    else rows.push([i])
  }
  const width = rows[0].length
  if (rows.length < 3 || width < 3 || rows.some((row) => row.length !== width)) return false
  for (const row of rows) row.sort((a, b) => a.rect[0] - b.rect[0])
  if (
    rows.some((row, r) =>
      row.some(
        (i, c) =>
          Math.abs(i.rect[0] - rows[0][c].rect[0]) > h * 0.04 ||
          (c && i.rect[0] <= row[c - 1].rect[2]) ||
          (r && i.rect[1] <= rows[r - 1][c].rect[3])
      )
    )
  )
    return false
  const matrix = union(numbers),
    eq = equal[0]
  if (
    eq.rect[2] >= matrix[0] ||
    eq.baseline <= rows[0][0].baseline ||
    eq.baseline >= rows.at(-1)[0].baseline ||
    rows.filter((row) => eq.rect[1] < row[0].rect[3] && eq.rect[3] > row[0].rect[1]).length !== 1
  )
    return false
  const box = union(fonts)
  if (
    rules.some(
      (r) =>
        Math.min(r[0], r[2]) <= box[2] &&
        Math.max(r[0], r[2]) >= box[0] &&
        Math.min(r[1], r[3]) <= box[3] &&
        Math.max(r[1], r[3]) >= box[1]
    )
  )
    return false
  if (
    inventory.some(
      (i) =>
        i.text?.trim() &&
        (!Array.isArray(i.rect) ||
          i.rect.length !== 4 ||
          !i.rect.every(Number.isFinite) ||
          (!fonts.includes(i) &&
            i.rect[0] <= box[2] &&
            i.rect[2] >= box[0] &&
            i.rect[1] <= box[3] &&
            i.rect[3] >= box[1]))
    )
  )
    return false
  return true
}

function hasMisassignedStubTail({ proved }, table, inventory, rules) {
  if (!hasDisjointNativeTableSlots(table) || table.grid.length < 4 || table.grid[0].length < 3)
    return false
  const all = proved.flatMap((p) => p.fonts)
  if (!proveNativeUniqueWholeFonts(all, inventory)) return false
  const header = proved.filter((p) => p.cell.row === 0),
    hb = union(header.flatMap((p) => p.fonts))
  if (header.length !== table.grid[0].length) return false
  const hs = horizontal(rules)
    .filter((r) => r[0] <= hb[0] && r[2] >= hb[2])
    .sort((a, b) => a[1] - b[1])
  for (const next of proved.filter(
    (p) => p.cell.column === 0 && p.cell.row > 1 && p.cell.colSpan === 1 && p.cell.rowSpan === 1
  )) {
    const prev = proved.find(
      (p) =>
        p.cell.row === next.cell.row - 1 &&
        p.cell.column === 0 &&
        p.cell.rowSpan === 1 &&
        p.cell.colSpan === 1
    )
    if (!prev) continue
    const peers = proved.filter((p) => p.cell.row === next.cell.row && p.cell.column > 0)
    if (
      peers.length !== table.grid[0].length - 1 ||
      peers.some((p) => p.cell.rowSpan !== 1 || p.cell.colSpan !== 1 || p.fonts.length !== 1) ||
      peers.filter((p) => /^\d[\d.,]*$/u.test(p.fonts[0].text.trim())).length < 2
    )
      continue
    const normal = peers[0].fonts[0],
      h = normal.height
    if (peers.some((p) => Math.abs(p.fonts[0].baseline - normal.baseline) > h * 0.001)) continue
    const tail = next.fonts.filter((i) => i.rect[3] < normal.rect[1]),
      head = next.fonts.filter((i) => !tail.includes(i))
    if (
      !tail.length ||
      !head.length ||
      !head.some((i) => Math.abs(i.baseline - normal.baseline) <= h * 0.001) ||
      tail.some((i) => Math.abs(i.height - h) > h * 0.001) ||
      Math.max(...tail.map((i) => i.rect[3])) >= Math.min(...head.map((i) => i.rect[1]))
    )
      continue
    const ordered = (a) => [...a].sort((a, b) => a.sourceItem.index - b.sourceItem.index)
    const left = ordered(prev.fonts),
      right = ordered(tail)
    if (
      Math.max(...left.map((i) => i.sourceItem.index)) >=
        Math.min(...right.map((i) => i.sourceItem.index)) ||
      Math.max(...right.map((i) => i.sourceItem.index)) >=
        Math.min(...head.map((i) => i.sourceItem.index)) ||
      new Set([...left, ...right, ...head].map((i) => i.sourceItem.pageNumber)).size !== 1
    )
      continue
    const balance = (s) => {
      let n = 0
      for (const c of s) {
        if (c === '(') n++
        if (c === ')' && --n < 0) return null
      }
      return n
    }
    const a = left.map((i) => i.text).join(' '),
      b = right.map((i) => i.text).join(' ')
    if (balance(a) !== 1 || balance(a + ' ' + b) !== 0 || !b.trim().endsWith(')')) continue
    const last = Math.max(...left.map((i) => i.baseline)),
      first = Math.min(...right.map((i) => i.baseline))
    if (first <= last || first - last > h * 2 || first - last < h) continue
    const component = proved
        .filter((p) => p.cell.row === prev.cell.row || p.cell.row === next.cell.row)
        .flatMap((p) => p.fonts),
      box = union(component)
    const top = hs.filter((r) => r[1] < box[1]).at(-1),
      bottom = hs.find((r) => r[1] > box[3])
    if (
      !top ||
      !bottom ||
      hs.some((r) => r[1] > last && r[1] < normal.baseline) ||
      !complete(component, inventory)
    )
      continue
    return true
  }
  return false
}
