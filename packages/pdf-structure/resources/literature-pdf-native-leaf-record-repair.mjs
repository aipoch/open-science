/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { isDeepStrictEqual as fencedGroupOpaqueEqual } from 'node:util'
import { OPS as fencedGroupOPS, Util as fencedGroupUtil } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { classifyTableRuleEdge, joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'
import { captionKind } from './literature-pdf-caption-group.mjs'
import { nativeMeasuredWordTokens } from './literature-pdf-native-scalar-record-grid.mjs'
import { isAdjacentTableScript, recoverOwnedTableCrop } from './literature-pdf-table-geometry.mjs'
import { collectTableRules } from './literature-pdf-graphics.mjs'
import {
  groupSourceRowsWithScripts,
  hasUniqueRecordTokens,
  readSourceRow
} from './literature-pdf-source-records.mjs'

// These late repairs need every old slot and whole native font, in addition to
// the existing complete page packet. A transport-exact grid is not this proof.
export function nativeWholeOwnerRepairPacket(table, items, rules, context) {
  const packet = nativeWholeOwnerSourcePacket(table, items, rules, context)
  if (!packet) return
  const { fonts, height } = packet,
    groups = groupSourceRowsWithScripts(
      [...fonts].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0]),
      height,
      0.2
    ),
    anchors = (g) => g.filter((f) => f.height >= height * 0.8)
  if (
    !groups ||
    groups.some(
      (g, n) =>
        !anchors(g).length ||
        (n &&
          Math.min(...anchors(g).map((f) => f.rect[1])) <=
            Math.max(...anchors(groups[n - 1]).map((f) => f.rect[3])))
    )
  )
    return
  return { ...packet, groups }
}

// The exported packet above still requires every adjacent native row anchor.
// A bounded centered-stub proof below uses the same complete source/slot
// bijection, then establishes record rows independently of its multiline stub.
function nativeWholeOwnerSourcePacket(table, items, rules, context) {
  const data = (value, seen = new Set()) => {
    if (value === null || typeof value !== 'object')
      return !['function', 'symbol'].includes(typeof value)
    if (seen.has(value)) return false
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return false
    seen.add(value)
    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === 'length') continue
      const d = Object.getOwnPropertyDescriptor(value, key)
      if (value === table?.unassigned && key === 'reconciliationItems') {
        if (
          !d ||
          !Object.hasOwn(d, 'value') ||
          !Array.isArray(d.value) ||
          d.value.some(
            (i) =>
              !data(i, seen) ||
              i.sourceToken ||
              items?.filter(
                (f) =>
                  fencedGroupSameFont(f, i) && fencedGroupOpaqueEqual(f.sourceItem, i.sourceItem)
              ).length !== 1
          )
        )
          return false
      } else if (
        typeof key !== 'string' ||
        !d?.enumerable ||
        !Object.hasOwn(d, 'value') ||
        !data(d.value, seen)
      )
        return false
    }
    seen.delete(value)
    return true
  }
  if (
    !table ||
    !data(table) ||
    !fencedGroupValidRect(table.cropRect) ||
    !Array.isArray(table.grid) ||
    !table.grid.length ||
    !Array.isArray(table.cells) ||
    !Number.isInteger(table.page) ||
    table.page < 1 ||
    !context?.viewport ||
    ['width', 'height', 'scale'].some((k) => table.sourceViewport?.[k] !== context.viewport[k]) ||
    (table.readingRotation !== undefined && table.readingRotation !== 0) ||
    table.captionIssue !== undefined ||
    ['parts', 'unassigned', 'notes'].some(
      (k) => table[k] !== undefined && (!Array.isArray(table[k]) || table[k].length)
    ) ||
    (table.clipped !== undefined && !Array.isArray(table.clipped)) ||
    !Array.isArray(items) ||
    !Array.isArray(rules)
  )
    return
  const fonts = items.filter(
      (i) => fencedGroupFiniteFont(i) && fencedGroupIntersects(i.rect, table.cropRect)
    ),
    origins = nativeWholeFontOrigins(fonts),
    columns = table.grid[0]?.length
  if (
    !columns ||
    !fonts.length ||
    !origins ||
    origins.length !== fonts.length ||
    origins.some((o) => o.pageNumber !== table.page) ||
    table.grid.some(
      (row) =>
        !Array.isArray(row) || row.length !== columns || row.some((t) => typeof t !== 'string')
    ) ||
    !proveNativeCompleteRuledSourcePacket(fonts, rules, context, table.cropRect)
  )
    return
  const owners = new Map(),
    claimed = new Set(),
    slots = new Set(),
    chars = (text) => [...text.normalize('NFKC').replace(/\s/gu, '')].sort().join('')
  for (const c of table.cells) {
    if (
      !c ||
      ![c.row, c.column, c.rowSpan, c.colSpan].every(Number.isInteger) ||
      c.row < 0 ||
      c.column < 0 ||
      c.rowSpan < 1 ||
      c.colSpan < 1 ||
      c.row + c.rowSpan > table.grid.length ||
      c.column + c.colSpan > columns ||
      typeof c.text !== 'string' ||
      table.grid[c.row][c.column] !== c.text ||
      (c.sourceRects !== undefined && !Array.isArray(c.sourceRects))
    )
      return
    for (let r = c.row; r < c.row + c.rowSpan; r++)
      for (let col = c.column; col < c.column + c.colSpan; col++) {
        const key = `${r}:${col}`
        if (slots.has(key) || ((r !== c.row || col !== c.column) && table.grid[r][col] !== ''))
          return
        slots.add(key)
      }
    const refs = c.sourceTokens ?? c.sourceItems ?? [],
      rects = c.sourceRects ?? []
    if (!Array.isArray(refs) || refs.length !== rects.length) return
    const owned = []
    for (let n = 0; n < refs.length; n++) {
      const ref = refs[n],
        matches = fonts.filter((f) =>
          c.sourceTokens
            ? !ref?.sourceToken && fencedGroupSameFont(f, ref)
            : fencedGroupOpaqueEqual(f.sourceItem, ref)
        )
      if (
        matches.length !== 1 ||
        claimed.has(matches[0]) ||
        (!c.sourceTokens && !fencedGroupExactRect(rects[n], matches[0].rect))
      )
        return
      claimed.add(matches[0])
      owned.push(matches[0])
    }
    if (
      chars(c.text) !== chars(owned.map((f) => f.text).join('')) ||
      rects.some((r) => owned.filter((f) => fencedGroupExactRect(r, f.rect)).length !== 1) ||
      owned.some((f) => rects.filter((r) => fencedGroupExactRect(r, f.rect)).length !== 1) ||
      (c.sourceItems && !fencedGroupOpaqueEqual(c.sourceItems, nativeWholeFontOrigins(owned)))
    )
      return
    owners.set(c, owned)
  }
  if (
    slots.size !== columns * table.grid.length ||
    claimed.size !== fonts.length ||
    table.clipped?.some(
      (c) =>
        fonts.filter((f) => f.text === c.text && fencedGroupExactRect(f.rect, c.rect)).length !== 1
    )
  )
    return
  return { fonts, owners, height: Math.max(...fonts.map((f) => f.height)), columns }
}

// Keep opaque donor payloads. Split only plain, whole source programs; rich
// donors require a separate source-run proof rather than slicing their text.
export function nativeWholeOwnerRepairCell(
  donor,
  fonts,
  row,
  column,
  rect,
  spans = {},
  donorFonts
) {
  if (!donor || !Array.isArray(fonts) || !fonts.length) return
  if (donor.textRuns?.length) {
    if (
      !Array.isArray(donorFonts) ||
      !donorFonts.length ||
      donor.textRuns.some(
        (r) =>
          !r ||
          Object.keys(r).some((k) => !['text', 'position'].includes(k)) ||
          typeof r.text !== 'string' ||
          !['normal', 'subscript', 'superscript'].includes(r.position)
      ) ||
      donor.textRuns.map((r) => r.text).join('') !== donor.text
    )
      return
    const h = Math.max(...donorFonts.map((f) => f.height)),
      rows = groupSourceRowsWithScripts(
        [...donorFonts].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0]),
        h,
        0.2
      ),
      chars = (text, position) =>
        [...text.normalize('NFKC').replace(/\s/gu, '')].map((char) => `${position}:${char}`)
    if (!rows) return
    const literal = []
    for (const group of rows)
      for (const f of [...group].sort((a, b) => a.rect[0] - b.rect[0])) {
        const bases = group.filter((b) => b !== f && isAdjacentTableScript(f, b))
        if (bases.length > 1) return
        literal.push(
          ...chars(
            f.text,
            bases.length ? (f.baseline < bases[0].baseline ? 'superscript' : 'subscript') : 'normal'
          )
        )
      }
    if (
      !fencedGroupOpaqueEqual(
        literal,
        donor.textRuns.flatMap((r) => chars(r.text, r.position))
      )
    )
      return
  }
  const ordered = [...fonts].sort((a, b) => a.rect[0] - b.rect[0]),
    runs = []
  let text = '',
    previous
  for (const f of ordered) {
    const bases = ordered.filter((b) => b !== f && isAdjacentTableScript(f, b))
    if (bases.length > 1) return
    const position = bases.length
        ? f.baseline < bases[0].baseline
          ? 'superscript'
          : 'subscript'
        : 'normal',
      space =
        previous &&
        position === 'normal' &&
        f.rect[0] - previous.rect[2] > Math.min(previous.height, f.height) * 0.15
          ? ' '
          : '',
      literal = space + f.text
    text += literal
    if (runs.at(-1)?.position === position) runs.at(-1).text += literal
    else runs.push({ text: literal, position })
    previous = f
  }
  const cell = {
    ...structuredClone(donor),
    row,
    column,
    ...spans,
    text,
    sourceRects: ordered.map((f) => [...f.rect])
  }
  if (Object.hasOwn(donor, 'sourceTokens')) {
    const originals = ordered.map((f) =>
      donor.sourceTokens.filter((t) => fencedGroupSameFont(t, f))
    )
    if (originals.some((a) => a.length !== 1)) return
    cell.sourceTokens = originals.map((a) => structuredClone(a[0]))
  }
  if (Object.hasOwn(donor, 'sourceItems')) cell.sourceItems = nativeWholeFontOrigins(ordered)
  if (Object.hasOwn(donor, 'rect')) {
    if (
      !fencedGroupValidRect(rect) ||
      ordered.some(
        (f) =>
          f.rect[0] < rect[0] || f.rect[1] < rect[1] || f.rect[2] > rect[2] || f.rect[3] > rect[3]
      )
    )
      return
    cell.rect = rect
  }
  if (runs.some((r) => r.position !== 'normal')) cell.textRuns = runs
  else if (Object.hasOwn(donor, 'textRuns')) cell.textRuns = [{ text, position: 'normal' }]
  return cell
}

// Four inset underlines can establish paired parents without changing any
// existing body leaf. This shape has two six-leaf blocks and three fenced
// record sections; it is separate from the smaller collapsed-record repairs.
function recoverRepeatedRuledParentOwners(table, items, rules, context) {
  if (
    table?.grid?.[0]?.length !== 12 ||
    table.grid.length < 8 ||
    table.grid.length > 32 ||
    !Array.isArray(table.repairs)
  )
    return
  const p = nativeWholeOwnerRepairPacket(table, items, rules, context)
  if (
    !p ||
    p.groups.length !== table.grid.length ||
    table.repairs.some((r) => typeof r !== 'string')
  )
    return
  const left = Math.min(...p.fonts.map((f) => f.rect[0])),
    right = Math.max(...p.fonts.map((f) => f.rect[2])),
    local = rules.filter((r) => r[1] >= table.cropRect[1] && r[3] <= table.cropRect[3]),
    full = local
      .filter((r) => r[1] === r[3] && r[0] <= left && r[2] >= right)
      .sort((a, b) => a[1] - b[1]),
    parents = local.filter((r) => !full.includes(r)).sort((a, b) => a[0] - b[0])
  if (
    full.length !== 5 ||
    parents.length !== 4 ||
    full.some(
      (r, n) => r[0] !== full[0][0] || r[2] !== full[0][2] || (n && r[1] <= full[n - 1][1])
    ) ||
    parents.some(
      (r, n) =>
        r[1] !== r[3] ||
        r[1] !== parents[0][1] ||
        r[1] <= full[0][1] ||
        r[1] >= full[1][1] ||
        r[0] <= full[0][0] ||
        r[2] >= full[0][2] ||
        (n && r[0] <= parents[n - 1][2])
    )
  )
    return
  const at = (r, c) => table.cells.find((x) => x.row === r && x.column === c),
    rowFonts = (r) => table.cells.filter((c) => c.row === r).flatMap((c) => p.owners.get(c)),
    between = (fs, top, bottom) =>
      fs.length && fs.every((f) => f.rect[1] > top && f.rect[3] < bottom),
    empty = (c) =>
      c && c.text === '' && c.rowSpan === 1 && c.colSpan === 1 && !p.owners.get(c).length,
    stubColumns = [0, 1, 6, 7],
    parentCells = table.cells.filter((c) => c.row === 0 && c.text),
    children = table.cells.filter((c) => c.row === 1 && c.text)
  if (
    parentCells.length !== 4 ||
    children.length !== 8 ||
    stubColumns.some((c) => !empty(at(0, c)) || !empty(at(1, c))) ||
    parentCells.some((c) => c.rowSpan !== 1 || ![1, 2].includes(c.colSpan)) ||
    children.some((c) => c.rowSpan !== 1 || c.colSpan !== 1 || p.owners.get(c).length !== 1) ||
    !between(rowFonts(0), full[0][1], parents[0][1]) ||
    !between(rowFonts(1), parents[0][1], full[1][1]) ||
    table.grid.some((_r, n) => !hasUniqueRecordTokens(p.groups[n], [rowFonts(n)]))
  )
    return
  const sections = [0, 0, 0]
  // Section strokes can cross the top of a font's metric box. Only complete
  // original baselines qualify these already-owned records; no box is clipped
  // and every body owner remains unchanged.
  for (let r = 2; r < table.grid.length; r++) {
    const cells = table.cells.filter((c) => c.row === r),
      matches = sections
        .map((_v, n) =>
          rowFonts(r).every((f) => f.baseline > full[n + 1][1] && f.baseline < full[n + 2][1])
            ? n
            : -1
        )
        .filter((n) => n >= 0)
    if (
      cells.length !== 12 ||
      cells.some((c) => !c.text || c.rowSpan !== 1 || c.colSpan !== 1) ||
      matches.length !== 1
    )
      return
    sections[matches[0]]++
  }
  if (sections[0] < 2 || sections.some((n) => n !== sections[0])) return
  const lanes = Array.from({ length: 12 }, (_v, c) =>
    table.cells.filter((x) => x.row > 0 && x.column === c).flatMap((x) => p.owners.get(x))
  )
  for (let c = 0; c < 11; c++) {
    const a = Math.max(...lanes[c].map((f) => f.rect[2])),
      b = Math.min(...lanes[c + 1].map((f) => f.rect[0]))
    if (!Number.isFinite(a) || !Number.isFinite(b) || a >= b) return
  }
  const intersects = (f, rule) => f.rect[0] < rule[2] && f.rect[2] > rule[0],
    moves = new Map(),
    removed = new Set(),
    usedParents = new Set(),
    usedChildren = new Set()
  for (const [n, rule] of parents.entries()) {
    const owners = parentCells.filter((c) =>
        p.owners.get(c).every((f) => f.rect[0] >= rule[0] && f.rect[2] <= rule[2])
      ),
      pair = children
        .filter((c) => p.owners.get(c).every((f) => intersects(f, rule)))
        .sort((a, b) => a.column - b.column),
      column = [2, 4, 8, 10][n]
    if (
      owners.length !== 1 ||
      pair.length !== 2 ||
      pair[0].column !== column ||
      pair[1].column !== column + 1 ||
      stubColumns.flatMap((c) => lanes[c]).some((f) => intersects(f, rule))
    )
      return
    const donor = owners[0],
      donorFonts = p.owners.get(donor),
      checkDonor = { ...donor }
    delete checkDonor.rect
    const literal = nativeWholeOwnerRepairCell(
      checkDonor,
      donorFonts,
      donor.row,
      donor.column,
      undefined,
      {},
      donorFonts
    )
    if (
      usedParents.has(donor) ||
      !literal ||
      literal.text !== donor.text ||
      (Object.hasOwn(donor, 'textRuns') &&
        !fencedGroupOpaqueEqual(literal.textRuns, donor.textRuns)) ||
      pair.some(
        (c) =>
          usedChildren.has(c) ||
          p.owners.get(c).some((f) => parents.filter((r) => intersects(f, r)).length !== 1)
      ) ||
      lanes
        .slice(column, column + 2)
        .flat()
        .some(
          (f) =>
            !intersects(f, rule) ||
            parents.filter((r) => intersects(f, r)).length !== 1 ||
            (f.rect[0] + f.rect[2]) / 2 <= rule[0] ||
            (f.rect[0] + f.rect[2]) / 2 >= rule[2]
        )
    )
      return
    usedParents.add(donor)
    pair.forEach((c) => usedChildren.add(c))
    if (donor.column === column && donor.colSpan === 2) continue
    const blank = at(0, column),
      blankFields = [
        'row',
        'column',
        'rowSpan',
        'colSpan',
        'text',
        'rect',
        'origin',
        'sourceRects',
        'sourceItems',
        'sourceTokens',
        'textRuns'
      ]
    if (
      donor.column !== column + 1 ||
      donor.colSpan !== 1 ||
      !empty(blank) ||
      Reflect.ownKeys(blank).some((k) => !blankFields.includes(k)) ||
      ['sourceRects', 'sourceItems', 'sourceTokens', 'textRuns'].some(
        (k) => blank[k] !== undefined && (!Array.isArray(blank[k]) || blank[k].length)
      ) ||
      (blank.origin !== undefined && blank.origin !== 'model-grid') ||
      Object.hasOwn(donor, 'rect') !== Object.hasOwn(blank, 'rect')
    )
      return
    const changed = { ...donor, column, colSpan: 2 }
    if (Object.hasOwn(donor, 'rect')) {
      if (
        !fencedGroupValidRect(donor.rect) ||
        !fencedGroupValidRect(blank.rect) ||
        blank.rect[2] !== donor.rect[0] ||
        blank.rect[1] !== donor.rect[1] ||
        blank.rect[3] !== donor.rect[3]
      )
        return
      changed.rect = [blank.rect[0], donor.rect[1], donor.rect[2], donor.rect[3]]
      if (
        donorFonts.some(
          (f) =>
            f.rect[0] < changed.rect[0] ||
            f.rect[2] > changed.rect[2] ||
            f.rect[1] < changed.rect[1] ||
            f.rect[3] > changed.rect[3]
        )
      )
        return
    }
    moves.set(donor, changed)
    removed.add(blank)
  }
  if (moves.size !== 3 || usedParents.size !== 4 || usedChildren.size !== 8) return
  const grid = table.grid.map((r) => [...r])
  for (const [old, changed] of moves) {
    grid[0][old.column] = ''
    grid[0][changed.column] = old.text
  }
  const out = {
    ...table,
    grid,
    cells: table.cells.filter((c) => !removed.has(c)).map((c) => moves.get(c) ?? c),
    repairs: [...table.repairs, 'native-repeated-parent-header-owners-recovered']
  }
  return nativeWholeOwnerRepairPacket(out, items, rules, context) ? out : undefined
}

// A section row is independently bounded by coextensive rules. Two peer
// sections, complete scalar lanes and a single double-owned baseline pair
// distinguish merged records from a wrapped label or one multiline record.
export function recoverNativeSectionedOrdinaryRecordOwners(
  table,
  items,
  _captions,
  rules,
  context
) {
  const residual = recoverResidualSectionedOrdinaryPairs(table, items, rules, context)
  if (residual) return residual
  if (table?.grid?.[0]?.length === 12)
    return recoverRepeatedRuledParentOwners(table, items, rules, context)
  if (table?.grid?.[0]?.length !== 4 || table.grid.length < 8 || table.grid.length > 28) return
  const p = nativeWholeOwnerRepairPacket(table, items, rules, context)
  if (!p || p.columns !== 4 || p.groups.length !== table.grid.length + 1) return
  const horizontal = rules.filter(
      (r) => r[1] === r[3] && r[1] >= table.cropRect[1] - 0.2 && r[1] <= table.cropRect[3] + 0.2
    ),
    full = horizontal
      .filter(
        (r) =>
          r[0] <= Math.min(...p.fonts.map((f) => f.rect[0])) &&
          r[2] >= Math.max(...p.fonts.map((f) => f.rect[2]))
      )
      .sort((a, b) => a[1] - b[1])
  if (
    full.length !== 6 ||
    horizontal.length !== 6 ||
    full.some((r) => Math.abs(r[0] - full[0][0]) > 0.02 || Math.abs(r[2] - full[0][2]) > 0.02) ||
    rules.some(
      (r) =>
        r[0] === r[2] &&
        r[0] > full[0][0] &&
        r[0] < full[0][2] &&
        r[1] < full.at(-1)[1] &&
        r[3] > full[0][1]
    )
  )
    return
  const between = (a, b) => p.groups.filter((g) => g.every((f) => f.rect[1] > a && f.rect[3] < b)),
    header = p.groups.filter((g) =>
      g.every((f) => (f.rect[1] + f.rect[3]) / 2 > full[0][1] && f.rect[3] < full[1][1])
    ),
    labels = [between(full[1][1], full[2][1]), between(full[3][1], full[4][1])],
    sections = [between(full[2][1], full[3][1]), between(full[4][1], full[5][1])]
  if (
    header.length !== 1 ||
    labels.some((g) => g.length !== 1) ||
    sections[0].length < 3 ||
    sections[0].length > 12 ||
    sections[0].length !== sections[1].length ||
    !hasUniqueRecordTokens(p.fonts, [...header, ...labels.flat(), ...sections.flat()])
  )
    return
  const normalCells = table.cells.filter(
      (c) =>
        c.row > 0 &&
        c.column > 0 &&
        c.colSpan === 1 &&
        c.rowSpan === 1 &&
        /^\d+(?:\.\d+)?$/.test(c.text.trim())
    ),
    lanes = [0, 1, 2, 3].map((col) =>
      normalCells.filter((c) => c.column === col).flatMap((c) => p.owners.get(c))
    )
  if (lanes.slice(1).some((a) => a.length < 3)) return
  lanes[0] = sections
    .flat()
    .flat()
    .filter((f) => !lanes.slice(1).flat().includes(f) && !/^\d+(?:\.\d+)?$/.test(f.text.trim()))
  // The complete scalar fields in old correct records calibrate one global
  // whitespace lane boundary; every font then has exactly one physical lane.
  const extremes = lanes.map((l) => [
      Math.min(...l.map((f) => f.rect[0])),
      Math.max(...l.map((f) => f.rect[2]))
    ]),
    cuts = [full[0][0], ...extremes.slice(1).map((e, n) => (extremes[n][1] + e[0]) / 2), full[0][2]]
  if (extremes.some((e, n) => !Number.isFinite(e[0]) || (n && e[0] <= extremes[n - 1][1]))) return
  const records = sections.flat().map((g) => {
    const fields = cuts
      .slice(1)
      .map((right, col) => g.filter((f) => f.rect[0] >= cuts[col] && f.rect[2] <= right))
    if (
      fields.some((f) => !f.length) ||
      !hasUniqueRecordTokens(g, fields) ||
      fields.slice(1).some((f) => f.length !== 1 || !/^\d+(?:\.\d+)?$/.test(f[0].text.trim())) ||
      !fields[0].some(
        (f) =>
          Math.abs(f.baseline - fields[1][0].baseline) < 0.02 &&
          Math.abs(f.height - fields[1][0].height) < 0.02
      ) ||
      fields[0].some(
        (f) =>
          Math.abs(f.baseline - fields[1][0].baseline) > 0.02 &&
          !fields[0].some((b) => b !== f && isAdjacentTableScript(f, b))
      ) ||
      fields.slice(1).some((f) => Math.abs(f[0].baseline - fields[1][0].baseline) > 0.02)
    )
      return
    const donors = fields.map((fs) =>
      table.cells.filter((c) => fs.every((f) => p.owners.get(c).includes(f)))
    )
    if (
      donors.some((d) => d.length !== 1) ||
      new Set(donors.map((d) => d[0].row)).size !== 1 ||
      donors.some((d, col) => d[0].column !== col || d[0].rowSpan !== 1 || d[0].colSpan !== 1)
    )
      return
    return { fields, donors: donors.map((d) => d[0]), row: donors[0][0].row }
  })
  if (records.some((r) => !r)) return
  const byRow = new Map()
  for (const r of records) {
    const a = byRow.get(r.row) ?? []
    a.push(r)
    byRow.set(r.row, a)
  }
  const merged = [...byRow.values()].filter((a) => a.length > 1)
  if (
    merged.length !== 1 ||
    merged[0].length !== 2 ||
    [...byRow.values()].some((a) => a.length > 2) ||
    [...byRow.values()]
      .filter((a) => a.length === 1)
      .some(([r]) => r.fields.some((f, c) => f.length !== p.owners.get(r.donors[c]).length))
  )
    return
  const pair = merged[0],
    row = pair[0].row,
    edges = [
      Math.min(...pair[0].fields.flat().map((f) => f.rect[1])),
      (Math.max(...pair[0].fields.flat().map((f) => f.rect[3])) +
        Math.min(...pair[1].fields.flat().map((f) => f.rect[1]))) /
        2,
      Math.max(...pair[1].fields.flat().map((f) => f.rect[3]))
    ]
  if (
    !sections.some((section) => pair.every((r) => section.some((g) => g.includes(r.fields[1][0]))))
  )
    return
  const replacements = pair.flatMap((r, n) =>
    r.fields.map((fs, c) =>
      nativeWholeOwnerRepairCell(r.donors[c], fs, row + n, c, [
        r.donors[c].rect?.[0] ?? cuts[c],
        edges[n],
        r.donors[c].rect?.[2] ?? cuts[c + 1],
        edges[n + 1]
      ])
    )
  )
  if (replacements.some((c) => !c)) return
  const out = {
    ...table,
    cells: table.cells
      .filter((c) => c.row !== row)
      .map((c) => (c.row > row ? { ...c, row: c.row + 1 } : c))
      .concat(replacements)
      .sort((a, b) => a.row - b.row || a.column - b.column),
    grid: table.grid.map((r) => [...r])
  }
  out.grid.splice(
    row,
    1,
    ...pair.map((_, n) => replacements.slice(n * 4, n * 4 + 4).map((c) => c.text))
  )
  if (table.rows)
    out.rows = table.rows.flatMap((r, n) =>
      n !== row
        ? [r]
        : pair.map((_, k) => ({ ...r, rect: [r.rect[0], edges[k], r.rect[2], edges[k + 1]] }))
    )
  return nativeWholeOwnerRepairPacket(out, items, rules, context) ? out : undefined
}

// Whole source coverage remains mandatory, including already owned symbolic
// cells. Only the two residual ordinary pairs and one displaced peer project;
// the global complete-owner packet continues to refuse unassigned sources.
function recoverResidualSectionedOrdinaryPairs(table, items, rules, context) {
  const witness = table && Object.getOwnPropertyDescriptor(table, 'unassigned')?.value
  const data = (x, seen = new Set()) => {
    if (x === null || typeof x !== 'object') return !['function', 'symbol'].includes(typeof x)
    if (seen.has(x) || (!Array.isArray(x) && Object.getPrototypeOf(x) !== Object.prototype))
      return false
    if (
      Array.isArray(x) &&
      Object.keys(x).filter((k) => /^(?:0|[1-9]\d*)$/.test(k)).length !== x.length
    )
      return false
    seen.add(x)
    const ok = Reflect.ownKeys(x).every((k) => {
      if (Array.isArray(x) && k === 'length') return true
      const d = Object.getOwnPropertyDescriptor(x, k)
      if (x === witness && k === 'reconciliationItems')
        return (
          d?.enumerable === false &&
          d.writable === false &&
          d.configurable === false &&
          Object.hasOwn(d, 'value') &&
          Array.isArray(d.value) &&
          data(d.value, seen)
        )
      return (
        typeof k === 'string' &&
        (!Array.isArray(x) || (/^(?:0|[1-9]\d*)$/.test(k) && Number(k) < x.length)) &&
        d?.enumerable &&
        Object.hasOwn(d, 'value') &&
        data(d.value, seen)
      )
    })
    seen.delete(x)
    return ok
  }
  if (
    !data(table) ||
    !Array.isArray(items) ||
    !data(items) ||
    !Array.isArray(rules) ||
    !data(rules)
  )
    return
  const crop = table?.cropRect,
    grid = table?.grid,
    cells = table?.cells,
    v = context?.viewport
  if (
    !fencedGroupValidRect(crop) ||
    !Array.isArray(grid) ||
    grid.length < 10 ||
    grid.length > 50 ||
    grid.some((r) => !Array.isArray(r) || r.length !== 2 || r.some((t) => typeof t !== 'string')) ||
    !Array.isArray(cells) ||
    !Number.isInteger(table.page) ||
    table.page < 1 ||
    table.readingRotation ||
    !v ||
    ['width', 'height', 'scale'].some((k) => table.sourceViewport?.[k] !== v[k]) ||
    ['notes', 'parts'].some(
      (k) => table[k] !== undefined && (!Array.isArray(table[k]) || table[k].length)
    ) ||
    !Array.isArray(table.clipped) ||
    !Array.isArray(witness) ||
    witness.length !== 4 ||
    witness.some((t) => typeof t !== 'string') ||
    !Array.isArray(table.issues) ||
    table.issues.some(
      (t) => !['unassigned-source-text', 'span-conflicts-with-source-columns'].includes(t)
    ) ||
    !table.issues.includes('unassigned-source-text') ||
    (table.repairs !== undefined &&
      (!Array.isArray(table.repairs) || table.repairs.some((t) => typeof t !== 'string'))) ||
    table.captionIssue !== undefined
  )
    return
  if (items.some((f) => !fencedGroupFiniteFont(f))) return
  const fonts = items.filter((f) => fencedGroupIntersects(f.rect, crop)),
    origins = nativeWholeFontOrigins(fonts)
  if (
    !origins ||
    origins.length !== fonts.length ||
    origins.some((o) => o.pageNumber !== table.page) ||
    !proveNativeCompleteRuledSourcePacket(fonts, rules, context, crop)
  )
    return
  const claimed = new Set(),
    owners = new Map(),
    slots = new Set(),
    chars = (t) => [...t.normalize('NFKC').replace(/\s/gu, '')].sort().join('')
  for (const c of cells) {
    if (
      !c ||
      ![c.row, c.column, c.rowSpan, c.colSpan].every(Number.isInteger) ||
      c.row < 0 ||
      c.column < 0 ||
      c.rowSpan < 1 ||
      c.colSpan < 1 ||
      c.row + c.rowSpan > grid.length ||
      c.column + c.colSpan > 2 ||
      typeof c.text !== 'string' ||
      grid[c.row][c.column] !== c.text ||
      !Array.isArray(c.sourceRects) ||
      (Object.hasOwn(c, 'sourceItems') && !Array.isArray(c.sourceItems)) ||
      (Object.hasOwn(c, 'sourceTokens') && !Array.isArray(c.sourceTokens))
    )
      return
    for (let r = c.row; r < c.row + c.rowSpan; r++)
      for (let col = c.column; col < c.column + c.colSpan; col++) {
        const k = `${r}:${col}`
        if (slots.has(k) || ((r !== c.row || col !== c.column) && grid[r][col] !== '')) return
        slots.add(k)
      }
    const refs =
        c.sourceItems ??
        c.sourceRects.map((rect) => {
          const matches = (c.sourceTokens ?? []).filter((f) => fencedGroupExactRect(f?.rect, rect))
          return matches.length === 1 ? matches[0].sourceItem : undefined
        }),
      fs = []
    if (!Array.isArray(refs) || refs.length !== c.sourceRects.length) return
    for (let n = 0; n < refs.length; n++) {
      const matches = fonts.filter((f) => fencedGroupOpaqueEqual(f.sourceItem, refs[n]))
      if (
        matches.length !== 1 ||
        claimed.has(matches[0]) ||
        !fencedGroupExactRect(matches[0].rect, c.sourceRects[n])
      )
        return
      const f = matches[0]
      claimed.add(f)
      fs.push(f)
    }
    // Runtime token order follows rendered rich text; sourceItems/sourceRects
    // retain original PDF order. Prove both complete sets without reordering.
    if (c.sourceTokens) {
      const tokenOwners = new Set()
      if (c.sourceTokens.length !== fs.length) return
      for (const ref of c.sourceTokens) {
        if (
          !ref ||
          ref.sourceToken ||
          Reflect.ownKeys(ref).some(
            (k) =>
              ![
                'text',
                'rect',
                'baseline',
                'height',
                'horizontal',
                'inlineSymbol',
                'fontDescent',
                'sourceItem'
              ].includes(k)
          )
        )
          return
        const matches = fs.filter(
          (f) =>
            fencedGroupSameFont(ref, f) &&
            ['horizontal', 'inlineSymbol', 'fontDescent', 'sourceItem'].every(
              (k) => !Object.hasOwn(ref, k) || fencedGroupOpaqueEqual(ref[k], f[k])
            )
        )
        if (matches.length !== 1 || tokenOwners.has(matches[0])) return
        tokenOwners.add(matches[0])
      }
    }
    if (
      (c.sourceTokens && (!Array.isArray(c.sourceTokens) || c.sourceTokens.length !== fs.length)) ||
      chars(c.text) !== chars(fs.map((f) => f.text).join(''))
    )
      return
    owners.set(c, fs)
  }
  const missing = fonts.filter((f) => !claimed.has(f))
  if (
    slots.size !== grid.length * 2 ||
    missing.length !== 4 ||
    !fencedGroupOpaqueEqual([...witness].sort(), missing.map((f) => f.text).sort())
  )
    return
  if (table.clipped.some((c) => !c || typeof c.text !== 'string' || !fencedGroupValidRect(c.rect)))
    return
  const clippedFonts = table.clipped.map((c) =>
    fonts.filter((f) => f.text === c.text && fencedGroupExactRect(f.rect, c.rect))
  )
  if (clippedFonts.some((fs) => fs.length !== 1 || !claimed.has(fs[0]))) return
  const reconciliation = Object.getOwnPropertyDescriptor(witness, 'reconciliationItems')
  if (
    reconciliation &&
    (reconciliation.value.length !== fonts.length ||
      reconciliation.value.some((item, index) => {
        const original = { ...fonts[index] }
        // The ordinary reconstruction provider omits this optional metric;
        // full glyph/paint qualification still uses the complete native fonts.
        if (!Object.hasOwn(item, 'fontDescent')) delete original.fontDescent
        return !fencedGroupOpaqueEqual(item, original)
      }))
  )
    return
  const full = rules
      .filter(
        (r) =>
          r[1] === r[3] &&
          r[1] > crop[1] &&
          r[1] < crop[3] &&
          r[0] <= Math.min(...fonts.map((f) => f.rect[0])) + 1e-7 &&
          r[2] >= Math.max(...fonts.map((f) => f.rect[2])) - 1e-7
      )
      .sort((a, b) => a[1] - b[1]),
    proposals = []
  const wholeBlank = (c) =>
    c &&
    c.text === '' &&
    c.rowSpan === 1 &&
    c.colSpan === 1 &&
    Object.keys(c).every((k) =>
      [
        'row',
        'column',
        'rowSpan',
        'colSpan',
        'text',
        'sourceRects',
        'sourceTokens',
        'sourceItems',
        'rect',
        'origin'
      ].includes(k)
    ) &&
    ['sourceRects', 'sourceTokens', 'sourceItems'].every(
      (k) => c[k] === undefined || (Array.isArray(c[k]) && !c[k].length)
    ) &&
    (c.origin === undefined || c.origin === 'model-grid') &&
    (c.rect === undefined ||
      (fencedGroupValidRect(c.rect) &&
        c.rect[0] >= crop[0] &&
        c.rect[2] <= crop[2] &&
        c.rect[1] >= crop[1] &&
        c.rect[3] <= crop[3]))
  for (let n = 0; n < full.length - 2; n++) {
    const [a, b, end] = full.slice(n, n + 3)
    if ([b, end].some((r) => Math.abs(r[0] - a[0]) > 0.02 || Math.abs(r[2] - a[2]) > 0.02)) continue
    const labels = fonts.filter((f) => f.rect[1] > a[1] && f.rect[3] < b[1]),
      source = fonts.filter((f) => f.rect[1] > b[1] && f.rect[3] < end[1])
    if (labels.length !== 1 || !source.some((f) => missing.includes(f))) continue
    if (
      clippedFonts.some((fs) => source.includes(fs[0])) ||
      rules.some(
        (r) =>
          Math.min(r[1], r[3]) > b[1] &&
          Math.max(r[1], r[3]) < end[1] &&
          Math.max(r[0], r[2]) > a[0] &&
          Math.min(r[0], r[2]) < a[2]
      )
    )
      return
    if (fonts.some((f) => f.rect[1] < end[1] && f.rect[3] > b[1] && !source.includes(f))) return
    const labelCells = cells.filter(
        (c) => owners.get(c).length === 1 && owners.get(c)[0] === labels[0] && c.column === 0
      ),
      label = labelCells[0]
    if (labelCells.length !== 1 || label.rowSpan !== 1) return
    const h = Math.max(...source.map((f) => f.height)),
      groups = groupSourceRowsWithScripts(
        [...source].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0]),
        h,
        0.2
      ),
      old = cells.filter((c) => owners.get(c).some((f) => source.includes(f)))
    if (
      !groups ||
      groups.length < 3 ||
      groups.length > 12 ||
      old.some(
        (c) => c.rowSpan !== 1 || c.colSpan !== 1 || owners.get(c).some((f) => !source.includes(f))
      )
    )
      return
    const byColumn = [0, 1].map((col) =>
        old.filter((c) => c.column === col).flatMap((c) => owners.get(c))
      ),
      extremes = byColumn.map((fs) => [
        Math.min(...fs.map((f) => f.rect[0])),
        Math.max(...fs.map((f) => f.rect[2]))
      ]),
      cut = (extremes[0][1] + extremes[1][0]) / 2
    if (byColumn.some((fs) => fs.length < 2) || extremes[1][0] - extremes[0][1] <= h * 2) return
    const rows = [],
      consumed = new Set()
    for (let r = 0; r < groups.length; r++) {
      const g = groups[r],
        anchors = g.filter((f) => f.height >= h * 0.8),
        band = [
          Math.min(...anchors.map((f) => f.rect[1])),
          Math.max(...anchors.map((f) => f.rect[3]))
        ],
        fields = [g.filter((f) => f.rect[2] < cut), g.filter((f) => f.rect[0] > cut)]
      if (
        !anchors.length ||
        (r && band[0] <= rows[r - 1].band[1]) ||
        fields.some((fs) => !fs.length) ||
        fields.flat().length !== g.length
      )
        return
      const donors = fields.map((fs) =>
        old.filter((c) => fencedGroupOpaqueEqual(owners.get(c), fs))
      )
      const absent = fields.every((fs) => fs.every((f) => missing.includes(f)))
      if (absent) {
        if (
          fields.some(
            (fs) =>
              fs.length !== 1 || fs[0].height !== h || fs[0].baseline !== fields[0][0].baseline
          ) ||
          !/^\p{L}[\p{L}\s-]*$/u.test(fields[0][0].text) ||
          !/^\d+$/u.test(fields[1][0].text)
        )
          return
      } else if (donors.some((ds) => ds.length !== 1) || donors[0][0].row !== donors[1][0].row)
        return
      g.forEach((f) => {
        if (consumed.has(f)) return
        consumed.add(f)
      })
      rows.push({ row: label.row + 1 + r, band, fields, absent, donors: donors.map((ds) => ds[0]) })
    }
    if (consumed.size !== source.length || rows.filter((r) => r.absent).length !== 1) return
    const oldRows = Array.from({ length: rows.length }, (_, k) => label.row + k + 1),
      localCells = cells.filter((c) => oldRows.includes(c.row))
    if (
      localCells.length !== rows.length * 2 ||
      localCells.some(
        (c) => c.rowSpan !== 1 || c.colSpan !== 1 || (owners.get(c).length && !old.includes(c))
      ) ||
      localCells.filter((c) => !owners.get(c).length).length !== 2 ||
      localCells.filter((c) => !owners.get(c).length).some((c) => !wholeBlank(c))
    )
      return
    proposals.push({ rows, localCells, source, bounds: [b[1], end[1]], cut })
  }
  if (
    proposals.length !== 2 ||
    new Set(proposals.flatMap((p) => p.source)).size !==
      proposals.reduce((n, p) => n + p.source.length, 0) ||
    missing.some((f) => proposals.filter((p) => p.source.includes(f)).length !== 1)
  )
    return
  const changed = proposals.flatMap((p) =>
    p.rows.filter((r) => !r.absent && r.donors[0].row !== r.row)
  )
  if (
    changed.length !== 1 ||
    Math.abs(changed[0].donors[0].row - changed[0].row) !== 1 ||
    changed[0].fields.some((fs) => fs.length !== 1) ||
    changed[0].donors.some(
      (c, col) =>
        c.text !== changed[0].fields[col][0].text ||
        (c.textRuns !== undefined &&
          (!Array.isArray(c.textRuns) ||
            c.textRuns.some((r) => r.position !== 'normal') ||
            c.textRuns.map((r) => r.text).join('') !== c.text))
    )
  )
    return
  const replacements = new Map(),
    gridNext = grid.map((r) => [...r])
  for (const p of proposals) {
    const blanks = p.localCells.filter((c) => !owners.get(c).length)
    for (const r of p.rows)
      for (let col = 0; col < 2; col++) {
        const current = p.localCells.find((c) => c.row === r.row && c.column === col),
          f = r.fields[col][0]
        let next
        if (r.absent) {
          const blank = blanks.find((c) => c.column === col)
          next = {
            ...blank,
            row: r.row,
            text: f.text,
            sourceRects: [f.rect],
            sourceItems: [f.sourceItem]
          }
          if (blank.sourceTokens) next.sourceTokens = [f]
          if (blank.rect) next.rect = [blank.rect[0], r.band[0], blank.rect[2], r.band[1]]
        } else {
          const donor = r.donors[col]
          next = donor.row === r.row ? donor : { ...donor, row: r.row }
        }
        if (next !== current) replacements.set(current, next)
        gridNext[r.row][col] = next.text
      }
  }
  const result = {
    ...table,
    cells: cells.map((c) => replacements.get(c) ?? c),
    grid: gridNext,
    unassigned: [],
    issues: table.issues.filter((s) => s !== 'unassigned-source-text'),
    repairs: [...(table.repairs ?? []), 'native-residual-section-record-owners']
  }
  if (reconciliation)
    Object.defineProperty(result.unassigned, 'reconciliationItems', reconciliation)
  return result
}

// The page-local ruled fallbacks below require the complete ordinary native
// packet. A font box alone cannot witness invisible paint or a Type3 program.
const closedRecordPacket = Symbol('closed-record-packet')
const intervalColumnPacket = Symbol('interval-column-packet')

// An interval field may coexist with colored links outside its closed domain.
// All paint state and all glyphs are still verified; only wholly exterior glyph
// boxes may use another opaque RGB fill. The general packet contract is unchanged.
export function proveNativeIntervalColumnSourcePacket(items, rules, context, crop) {
  if (!fencedGroupValidRect(crop)) return false
  return proveNativeCompleteRuledSourcePacket(items, rules, context, crop, intervalColumnPacket)
}

// Only the closed-record owner may use this scope. All page operators and
// visible text still participate in the proof; the original packet is untouched.
export function proveNativeClosedRecordSourcePacket(items, rules, context, crop) {
  if (!fencedGroupValidRect(crop)) return false
  return proveNativeCompleteRuledSourcePacket(items, rules, context, crop, closedRecordPacket)
}

export function proveNativeCompleteRuledSourcePacket(items, rules, context, crop, scope) {
  const localRecord = scope === closedRecordPacket
  const intervalColumns = scope === intervalColumnPacket
  const {
    operators: op,
    content,
    viewport,
    rulePaintBounds: paint,
    nativeEvidenceGraphics: graphics
  } = context ?? {}
  const valid = fencedGroupValidRect
  if (
    localRecord &&
    (!(viewport?.width > 0) ||
      !(viewport?.height > 0) ||
      !Number.isFinite(viewport.width) ||
      !Number.isFinite(viewport.height))
  )
    return false
  if (
    !Array.isArray(items) ||
    !items.length ||
    items.some((i) => !fencedGroupFiniteFont(i) || i.horizontal !== true) ||
    !Array.isArray(rules) ||
    rules.some((r) => !Array.isArray(r) || r.length !== 4 || !r.every(Number.isFinite)) ||
    !content ||
    !Array.isArray(content.items) ||
    !content.styles ||
    viewport?.rotation !== 0 ||
    !Number.isFinite(viewport.scale) ||
    viewport.scale <= 0 ||
    !Array.isArray(viewport.transform) ||
    viewport.transform.length !== 6 ||
    !viewport.transform.every(Number.isFinite) ||
    !op ||
    !Array.isArray(op.fnArray) ||
    !Array.isArray(op.argsArray) ||
    op.fnArray.length !== op.argsArray.length ||
    !Array.isArray(graphics) ||
    graphics.some((g) => g?.kind !== 'path' || !valid(g.rect))
  )
    return false
  const origins = nativeWholeFontOrigins(items)
  if (
    !origins ||
    origins.some(
      (o) =>
        o.pageNumber !== origins[0].pageNumber ||
        content.items[o.index]?.str !== o.text ||
        content.items[o.index]?.sourceItem?.pageNumber !== o.pageNumber
    )
  )
    return false
  const sourceFont = (raw) => {
    if (
      !Array.isArray(raw?.transform) ||
      raw.transform.length !== 6 ||
      !raw.transform.every(Number.isFinite) ||
      !(raw.height > 0) ||
      !(raw.width > 0)
    )
      return
    const point = [raw.transform[4], raw.transform[5]]
    fencedGroupUtil.applyTransform(point, viewport.transform)
    const h = raw.height * viewport.scale
    return {
      text: raw.str,
      baseline: point[1],
      height: h,
      rect: [point[0], point[1] - h, point[0] + raw.width * viewport.scale, point[1]]
    }
  }
  if (
    items.some((i) => {
      const o = i.sourceItem ?? i.sourceToken?.sourceItem,
        raw = content.items[o.index]
      const token = sourceFont(raw)
      return (
        !token ||
        i.text !== raw.str ||
        i.sourceToken ||
        !Array.isArray(raw.transform) ||
        raw.transform.length !== 6 ||
        !raw.transform.every(Number.isFinite) ||
        !(raw.height > 0) ||
        !(raw.width > 0) ||
        raw.transform[1] !== 0 ||
        raw.transform[2] !== 0 ||
        content.styles[raw.fontName]?.vertical !== false ||
        !fencedGroupSameFont(i, token)
      )
    })
  )
    return false
  if (crop !== undefined) {
    if (!valid(crop)) return false
    const original = content.items
      .filter((i) => typeof i.str === 'string' && i.str.trim())
      .map(sourceFont)
    if (original.some((i) => !i)) return false
    const insideOriginal = original.filter((i) => fencedGroupIntersects(i.rect, crop))
    const actual = items.filter((i) => fencedGroupIntersects(i.rect, crop))
    if (
      insideOriginal.length !== actual.length ||
      insideOriginal.some((i) => actual.filter((j) => fencedGroupSameFont(i, j)).length !== 1)
    )
      return false
  }
  const O = fencedGroupOPS,
    allowed = new Set([
      O.dependency,
      O.save,
      O.restore,
      O.transform,
      O.beginText,
      O.endText,
      O.setFont,
      O.setTextMatrix,
      O.moveText,
      O.showText,
      O.setFillRGBColor,
      O.setStrokeRGBColor,
      O.setDash,
      O.setLineCap,
      O.setLineWidth,
      O.constructPath
    ])
  const dependencies = new Set(),
    stack = []
  let fill = '#000000',
    stroke = '#000000',
    font,
    size,
    width = 1,
    cap = 0,
    dash = [],
    text = false,
    paths = 0,
    transform = [1, 0, 0, 1, 0, 0],
    textMatrix = [1, 0, 0, 1, 0, 0],
    lineMatrix = [1, 0, 0, 1, 0, 0]
  const glyphs = [],
    carriers = [],
    characters = (s) => s.normalize('NFKC').replace(/\s/gu, '')
  const numeric = (a, length) => Array.isArray(a) && a.length === length && a.every(Number.isFinite)
  for (let n = 0; n < op.fnArray.length; n++) {
    const code = op.fnArray[n],
      a = op.argsArray[n]
    if (!allowed.has(code) || (a !== null && !Array.isArray(a))) return false
    if (code === O.dependency) {
      if (!a?.length || a.some((x) => typeof x !== 'string')) return false
      for (const x of a) dependencies.add(x)
    } else if (code === O.save)
      stack.push({ fill, stroke, font, size, width, cap, dash, transform: [...transform] })
    else if (code === O.restore) {
      const previous = stack.pop()
      if (!previous) return false
      ;({ fill, stroke, font, size, width, cap, dash, transform } = previous)
    } else if (code === O.transform || code === O.setTextMatrix) {
      const matrix =
        code === O.setTextMatrix && a?.length === 1
          ? Array.isArray(a[0])
            ? a[0]
            : a[0] instanceof Float32Array
              ? [...a[0]]
              : undefined
          : a
      if (
        !numeric(matrix, 6) ||
        matrix[1] !== 0 ||
        matrix[2] !== 0 ||
        matrix[0] <= 0 ||
        matrix[3] <= 0
      )
        return false
      if (code === O.transform) transform = fencedGroupUtil.transform(transform, matrix)
      else {
        textMatrix = [...matrix]
        lineMatrix = [...matrix]
      }
    } else if (code === O.moveText) {
      if (!numeric(a, 2)) return false
      lineMatrix[4] += lineMatrix[0] * a[0] + lineMatrix[2] * a[1]
      lineMatrix[5] += lineMatrix[1] * a[0] + lineMatrix[3] * a[1]
      textMatrix = [...lineMatrix]
    } else if (code === O.beginText) {
      if (text) return false
      text = true
      textMatrix = [1, 0, 0, 1, 0, 0]
      lineMatrix = [1, 0, 0, 1, 0, 0]
    } else if (code === O.endText) {
      if (!text) return false
      text = false
    } else if (code === O.setFont) {
      if (
        !Array.isArray(a) ||
        a.length !== 2 ||
        typeof a[0] !== 'string' ||
        !dependencies.has(a[0]) ||
        !content.styles[a[0]] ||
        !Number.isFinite(a[1]) ||
        a[1] <= 0
      )
        return false
      font = a[0]
      size = a[1]
    } else if (code === O.setFillRGBColor || code === O.setStrokeRGBColor) {
      if (
        !Array.isArray(a) ||
        a.length !== 1 ||
        (a[0] !== '#000000' &&
          !(intervalColumns && typeof a[0] === 'string' && /^#[0-9a-f]{6}$/iu.test(a[0])))
      )
        return false
      if (code === O.setFillRGBColor) fill = a[0]
      else stroke = a[0]
    } else if (code === O.setLineWidth) {
      if (!numeric(a, 1) || a[0] <= 0) return false
      width = a[0]
    } else if (code === O.setLineCap) {
      if (!numeric(a, 1) || a[0] !== 0) return false
      cap = a[0]
    } else if (code === O.setDash) {
      if (!Array.isArray(a) || a.length !== 2 || !Array.isArray(a[0]) || a[0].length || a[1] !== 0)
        return false
      dash = a[0]
    } else if (code === O.showText) {
      if (
        !text ||
        !font ||
        (!intervalColumns && fill !== '#000000') ||
        !Array.isArray(a) ||
        a.length !== 1 ||
        !Array.isArray(a[0])
      )
        return false
      let advance = 0
      const paintedRun = []
      for (const glyph of a[0]) {
        if (typeof glyph === 'number') {
          if (!Number.isFinite(glyph)) return false
          advance -= (glyph * size) / 1000
          continue
        }
        if (
          !glyph ||
          typeof glyph.unicode !== 'string' ||
          typeof glyph.fontChar !== 'string' ||
          !Number.isFinite(glyph.width) ||
          glyph.width < 0 ||
          glyph.isInFont !== true ||
          glyph.accent != null ||
          glyph.operatorListId != null ||
          !Number.isInteger(glyph.originalCharCode)
        )
          return false
        const matrix = fencedGroupUtil.transform(transform, textMatrix),
          start = [advance, 0]
        fencedGroupUtil.applyTransform(start, matrix)
        const end = [advance + (glyph.width * size) / 1000, 0]
        fencedGroupUtil.applyTransform(end, matrix)
        for (const char of characters(glyph.unicode))
          paintedRun.push({
            char,
            font,
            start,
            end,
            sizeX: size * matrix[0],
            sizeY: size * matrix[3]
          })
        advance += (glyph.width * size) / 1000
      }
      textMatrix[4] += textMatrix[0] * advance
      textMatrix[5] += textMatrix[1] * advance
      if (intervalColumns && fill !== '#000000') {
        for (const glyph of paintedRun) {
          const points = [[...glyph.start], [glyph.end[0], glyph.end[1] + glyph.sizeY]]
          points.forEach((point) => fencedGroupUtil.applyTransform(point, viewport.transform))
          const bounds = [
            Math.min(points[0][0], points[1][0]),
            Math.min(points[0][1], points[1][1]),
            Math.max(points[0][0], points[1][0]),
            Math.max(points[0][1], points[1][1])
          ]
          if (!(
            bounds[2] < crop[0] ||
            bounds[0] > crop[2] ||
            bounds[3] < crop[1] ||
            bounds[1] > crop[3]
          ))
            return false
        }
      }
      if (localRecord && paintedRun.length) {
        const boxes = paintedRun.map((g) => {
          const points = [[...g.start], [g.end[0], g.end[1] + g.sizeY]]
          points.forEach((p) => fencedGroupUtil.applyTransform(p, viewport.transform))
          return [
            Math.min(points[0][0], points[1][0]),
            Math.min(points[0][1], points[1][1]),
            Math.max(points[0][0], points[1][0]),
            Math.max(points[0][1], points[1][1])
          ]
        })
        const outside =
          boxes.every((b) => b[2] < 0) ||
          boxes.every((b) => b[0] > viewport.width) ||
          boxes.every((b) => b[3] < 0) ||
          boxes.every((b) => b[1] > viewport.height)
        if (outside) continue
        if (
          boxes.some((b) => b[0] < 0 || b[1] < 0 || b[2] > viewport.width || b[3] > viewport.height)
        )
          return false
      }
      glyphs.push(...paintedRun)
    } else if (code === O.constructPath) {
      const program = Array.isArray(a?.[1]?.[0])
        ? a[1][0]
        : a?.[1]?.[0] instanceof Float32Array
          ? [...a[1][0]]
          : undefined
      const pathBounds = Array.isArray(a?.[2])
        ? a[2]
        : a?.[2] instanceof Float32Array
          ? [...a[2]]
          : undefined
      if (localRecord && a?.[0] === O.fill) {
        if (
          a.length !== 3 ||
          !program ||
          program.length !== 13 ||
          !program.every(Number.isFinite) ||
          !numeric(pathBounds, 4) ||
          fill !== '#000000'
        )
          return false
        const [left, bottom, right, top] = pathBounds
        if (
          !(left < right && bottom < top) ||
          !fencedGroupOpaqueEqual(program, [
            0,
            left,
            bottom,
            1,
            right,
            bottom,
            1,
            right,
            top,
            1,
            left,
            top,
            4
          ])
        )
          return false
        const matrix = fencedGroupUtil.transform(viewport.transform, transform),
          points = [
            [left, bottom],
            [right, top]
          ]
        points.forEach((p) => fencedGroupUtil.applyTransform(p, matrix))
        const bounds = [
          Math.min(points[0][0], points[1][0]),
          Math.min(points[0][1], points[1][1]),
          Math.max(points[0][0], points[1][0]),
          Math.max(points[0][1], points[1][1])
        ]
        if (!(
          bounds[2] < crop[0] ||
          bounds[0] > crop[2] ||
          bounds[3] < crop[1] ||
          bounds[1] > crop[3]
        ))
          return false
        const clipped = [
          Math.max(0, bounds[0]),
          Math.max(0, bounds[1]),
          Math.min(viewport.width, bounds[2]),
          Math.min(viewport.height, bounds[3])
        ]
        if (!fencedGroupValidRect(clipped)) return false
        carriers.push(
          clipped.map(
            (v, k) =>
              ((k < 2
                ? Math.floor((v / Math.ceil(k % 2 ? viewport.height : viewport.width)) * 256)
                : Math.ceil((v / Math.ceil(k % 2 ? viewport.height : viewport.width)) * 256) + 1) *
                (k % 2 ? viewport.height : viewport.width)) /
              256
          )
        )
        paths++
        continue
      }
      if (
        a?.length !== 3 ||
        a[0] !== O.stroke ||
        !program ||
        program.length !== 6 ||
        program[0] !== 0 ||
        program[3] !== 1 ||
        !program.every(Number.isFinite) ||
        !numeric(pathBounds, 4) ||
        pathBounds.some(
          (v, k) =>
            v !==
            [
              Math.min(program[1], program[4]),
              Math.min(program[2], program[5]),
              Math.max(program[1], program[4]),
              Math.max(program[2], program[5])
            ][k]
        ) ||
        stroke !== '#000000' ||
        cap !== 0 ||
        dash.length ||
        width <= 0
      )
        return false
      const matrix = fencedGroupUtil.transform(viewport.transform, transform),
        points = [
          [program[1], program[2]],
          [program[4], program[5]]
        ]
      points.forEach((p) => fencedGroupUtil.applyTransform(p, matrix))
      const radiusX = (width * Math.abs(matrix[0])) / 2,
        radiusY = (width * Math.abs(matrix[3])) / 2,
        bounds = [
          Math.min(...points.map((p) => p[0])) - radiusX,
          Math.min(...points.map((p) => p[1])) - radiusY,
          Math.max(...points.map((p) => p[0])) + radiusX,
          Math.max(...points.map((p) => p[1])) + radiusY
        ]
      carriers.push(
        bounds.map(
          (v, k) =>
            ((k < 2
              ? Math.floor((v / Math.ceil(k % 2 ? viewport.height : viewport.width)) * 256)
              : Math.ceil((v / Math.ceil(k % 2 ? viewport.height : viewport.width)) * 256) + 1) *
              (k % 2 ? viewport.height : viewport.width)) /
            256
        )
      )
      paths++
    }
  }
  if (stack.length || text || paths !== graphics.length) return false
  const remaining = [...graphics]
  for (const carrier of carriers) {
    const index = remaining.findIndex((g) => fencedGroupMachineRect(carrier, g.rect))
    if (index < 0) return false
    remaining.splice(index, 1)
  }
  if (remaining.length) return false
  let offset = 0
  const floatSame = (a, b) =>
    Number.isFinite(a) &&
    Number.isFinite(b) &&
    Math.abs(a - b) <= Math.max(1, Math.abs(a), Math.abs(b)) * 2 ** -23 * 16
  for (const raw of content.items.filter((i) => typeof i.str === 'string' && i.str.trim())) {
    const chars = [...characters(raw.str)],
      painted = glyphs.slice(offset, offset + chars.length)
    if (
      !chars.length ||
      painted.length !== chars.length ||
      painted.some((g, n) => g.char !== chars[n] || g.font !== raw.fontName) ||
      painted.some(
        (g) =>
          !floatSame(g.start[1], raw.transform[5]) ||
          !floatSame(g.end[1], raw.transform[5]) ||
          !floatSame(g.sizeX, raw.transform[0]) ||
          !floatSame(g.sizeY, raw.transform[3]) ||
          (g.start[0] < raw.transform[4] && !floatSame(g.start[0], raw.transform[4])) ||
          (g.end[0] > raw.transform[4] + raw.width &&
            !floatSame(g.end[0], raw.transform[4] + raw.width))
      ) ||
      !floatSame(painted[0].start[0], raw.transform[4]) ||
      !floatSame(painted[0].start[1], raw.transform[5]) ||
      !floatSame(painted[0].sizeX, raw.transform[0]) ||
      !floatSame(painted[0].sizeY, raw.transform[3]) ||
      !floatSame(painted.at(-1).end[0] - painted[0].start[0], raw.width) ||
      !floatSame(painted[0].sizeY, raw.height)
    )
      return false
    offset += chars.length
  }
  if (offset !== glyphs.length) return false
  const observed = new Map(),
    generated = collectTableRules(op, viewport, observed),
    supplied = paint instanceof Map ? paint : Array.isArray(paint) ? new Map(paint) : undefined
  return (
    !!supplied &&
    fencedGroupOpaqueEqual(generated, rules) &&
    fencedGroupOpaqueEqual(observed, supplied)
  )
}

// Rule centers own cells; the existing measured paint bounds own the crop.
// Enlarging to actual stroke ink must not admit an unrelated whole font.
export function nativeCompleteRuledPaintCrop(frame, boundaryRules, context, owned) {
  const paint =
    context?.rulePaintBounds instanceof Map
      ? context.rulePaintBounds
      : Array.isArray(context?.rulePaintBounds)
        ? new Map(context.rulePaintBounds)
        : undefined
  if (!paint || !boundaryRules.length) return
  const boxes = boundaryRules.map((r) => paint.get(r.join(',')))
  if (boxes.some((r) => !fencedGroupValidRect(r))) return
  const crop = [
    Math.min(frame[0], ...boxes.map((r) => r[0])),
    Math.min(frame[1], ...boxes.map((r) => r[1])),
    Math.max(frame[2], ...boxes.map((r) => r[2])),
    Math.max(frame[3], ...boxes.map((r) => r[3]))
  ]
  if (
    context.content.items
      .filter((i) => typeof i.str === 'string' && i.str.trim())
      .some((raw) => {
        const p = [raw.transform[4], raw.transform[5]]
        fencedGroupUtil.applyTransform(p, context.viewport.transform)
        const h = raw.height * context.viewport.scale,
          rect = [p[0], p[1] - h, p[0] + raw.width * context.viewport.scale, p[1]]
        return (
          fencedGroupIntersects(rect, crop) &&
          !owned.some((i) => i.text === raw.str && fencedGroupExactRect(i.rect, rect))
        )
      })
  )
    return
  return crop
}

// A record plan may use an inner double stroke as its logical closing while
// its image must retain the complete outer paint. Reuse the complete original
// path/state proof; unknown paint or clipping never authorizes a visual change.
export function nativeCompleteRuledRecordPaintCrop(frame, boundaryRules, rules, context, owned) {
  const v = context?.viewport,
    ops = context?.operators,
    paint = context?.rulePaintBounds,
    graphics = context?.nativeEvidenceGraphics,
    page = [0, 0, v?.width, v?.height],
    allowed = new Set([
      fencedGroupOPS.dependency,
      fencedGroupOPS.save,
      fencedGroupOPS.restore,
      fencedGroupOPS.transform,
      fencedGroupOPS.setDash,
      fencedGroupOPS.setLineWidth,
      fencedGroupOPS.setLineCap,
      fencedGroupOPS.setStrokeRGBColor,
      fencedGroupOPS.setFillRGBColor,
      fencedGroupOPS.constructPath,
      fencedGroupOPS.beginText,
      fencedGroupOPS.endText,
      fencedGroupOPS.setFont,
      fencedGroupOPS.setTextMatrix,
      fencedGroupOPS.moveText,
      fencedGroupOPS.showText
    ])
  if (
    !fencedGroupValidRect(page) ||
    v.rotation !== 0 ||
    !Array.isArray(v.transform) ||
    v.transform.length !== 6 ||
    !v.transform.every(Number.isFinite) ||
    !Array.isArray(ops?.fnArray) ||
    !Array.isArray(ops?.argsArray) ||
    ops.fnArray.length !== ops.argsArray.length ||
    ops.fnArray.some((op) => !allowed.has(op)) ||
    !(paint instanceof Map) ||
    !Array.isArray(rules) ||
    rules.some((r) => !Array.isArray(r) || r.length !== 4 || !r.every(Number.isFinite)) ||
    !Array.isArray(graphics) ||
    graphics.some((g) => g?.kind !== 'path' || !fencedGroupValidRect(g.rect)) ||
    !proveNativeFencedPaintClosure(
      rules,
      page,
      page,
      [],
      paint,
      graphics,
      context,
      context.nativePaintIdentityGraphics
    ).qualified
  )
    return
  return nativeCompleteRuledPaintCrop(frame, boundaryRules, context, owned)
}

const median = (values) => [...values].sort((a, b) => a - b)[values.length >> 1]
const sameRect = (a, b) => a.every((v, n) => Math.abs(v - b[n]) < 0.02)

// Origins are an existing optional worker field. Only complete, consistent
// native references may cross a repair; unknown payloads still fail closed.
export function nativeWholeFontOrigins(fonts) {
  if (!fonts.length) return []
  const origins = new Map()
  for (const font of fonts) {
    const origin = font.sourceItem ?? font.sourceToken?.sourceItem
    if (
      !origin ||
      Object.keys(origin).some((k) => !['pageNumber', 'index', 'text'].includes(k)) ||
      !Number.isInteger(origin.pageNumber) ||
      origin.pageNumber < 1 ||
      !Number.isSafeInteger(origin.index) ||
      origin.index < 0 ||
      typeof origin.text !== 'string' ||
      !origin.text.trim().length
    )
      return
    const key = `${origin.pageNumber}:${origin.index}`
    if (origins.has(key) && !fencedGroupOpaqueEqual(origins.get(key), origin)) return
    origins.set(key, origin)
  }
  return [...origins.values()]
    .sort((a, b) => a.pageNumber - b.pageNumber || a.index - b.index)
    .map((origin) => ({ ...origin }))
}

export function nativeCellOriginsMatch(cell, fonts) {
  if (!Object.hasOwn(cell, 'sourceItems')) return true
  if (
    !Array.isArray(cell.sourceItems) ||
    !cell.sourceItems.length ||
    cell.sourceItems.length > 8192
  )
    return false
  const origins = nativeWholeFontOrigins(fonts)
  return origins !== undefined && fencedGroupOpaqueEqual(cell.sourceItems, origins)
}

// A geometry-qualified projection must also conserve the existing native-item
// references. Match sanitized cell tokens back to whole source fonts; a TJ
// fragment retains its complete sourceToken owner rather than inventing an item.
export function nativeChangedCellOrigins(donors, items, nextTokens, establish = false) {
  if (!establish && !donors.some((cell) => Object.hasOwn(cell, 'sourceItems'))) return {}
  const wholeFonts = (tokens) => {
    if (!Array.isArray(tokens)) return
    const fonts = []
    for (const token of tokens) {
      const owner = token?.sourceToken ?? token
      if (
        !owner ||
        !Array.isArray(owner.rect) ||
        owner.rect.length !== 4 ||
        !owner.rect.every(Number.isFinite) ||
        !Number.isFinite(owner.baseline) ||
        !Number.isFinite(owner.height)
      )
        return
      const matches = items.filter(
        (font) =>
          font.text === owner.text &&
          font.baseline === owner.baseline &&
          font.height === owner.height &&
          Array.isArray(font.rect) &&
          font.rect.length === 4 &&
          sameRect(font.rect, owner.rect)
      )
      if (matches.length !== 1) return
      fonts.push(matches[0])
    }
    return fonts
  }
  const previous = donors.map((cell) => wholeFonts(cell.sourceTokens)),
    next = wholeFonts(nextTokens)
  if (
    previous.some((fonts, n) => !fonts || !nativeCellOriginsMatch(donors[n], fonts)) ||
    !next ||
    !nativeWholeFontOrigins([...previous.flat(), ...next])
  )
    return
  const sourceItems = nativeWholeFontOrigins(next)
  return sourceItems ? { sourceItems: sourceItems.length ? sourceItems : undefined } : undefined
}

// Rebuilding a source-qualified grid must not discard ordinary header origins.
// Preflight every existing reference before projecting any row or diagnostic.
export function nativeRecoveredCellOrigins(previousCells, nextCells, items) {
  if (!previousCells.some((cell) => Object.hasOwn(cell, 'sourceItems'))) return nextCells
  if ([...previousCells, ...nextCells].some((cell) => !Array.isArray(cell.sourceTokens ?? [])))
    return
  if (
    previousCells.some((cell) => !nativeChangedCellOrigins([cell], items, cell.sourceTokens ?? []))
  )
    return
  const whole = (token) => token?.sourceToken ?? token,
    same = (a, b) =>
      a &&
      b &&
      Array.isArray(a.rect) &&
      Array.isArray(b.rect) &&
      a.rect.length === 4 &&
      b.rect.length === 4 &&
      a.text === b.text &&
      a.baseline === b.baseline &&
      a.height === b.height &&
      sameRect(a.rect, b.rect),
    projected = []
  for (const cell of nextCells) {
    const fonts = (cell.sourceTokens ?? []).map(whole),
      donors = previousCells.filter((old) =>
        (old.sourceTokens ?? []).some((token) => fonts.some((font) => same(whole(token), font)))
      ),
      origins = nativeChangedCellOrigins(donors, items, cell.sourceTokens ?? [], true)
    if (!origins) return
    const next = { ...cell, ...origins }
    if (next.sourceItems === undefined) delete next.sourceItems
    projected.push(next)
  }
  return projected
}
const box = (items) => [
  Math.min(...items.map((i) => i.rect[0])),
  Math.min(...items.map((i) => i.rect[1])),
  Math.max(...items.map((i) => i.rect[2])),
  Math.max(...items.map((i) => i.rect[3]))
]
const physicalRows = (items, h) => {
  const rows = []
  for (const item of [...items].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    const row = rows.find((r) => Math.abs(r[0].baseline - item.baseline) < h * 0.3)
    if (row) row.push(item)
    else rows.push([item])
  }
  return rows
}

// These proofs use the whole native font boxes and a single closed painted
// frame. Detector row/column rectangles are predictions, not source owners.
function literalClosedFrame(table, items, captions, rules) {
  const crop = table.cropRect
  if (!crop?.every(Number.isFinite) || crop[2] <= crop[0] || crop[3] <= crop[1]) return
  const edges = joinHorizontalTableRules(rules, 0.01, 0)
    .filter(
      (r) =>
        r[1] > crop[1] &&
        r[1] < crop[3] &&
        r[0] >= crop[0] - 0.02 &&
        r[2] <= crop[2] + 0.02 &&
        r[2] - r[0] > (crop[2] - crop[0]) * 0.7
    )
    .sort((a, b) => a[1] - b[1])
  if (edges.length < 3) return
  const opening = edges[0],
    divider = edges[1],
    closing = edges.at(-1)
  if (edges.some((r) => Math.abs(r[0] - opening[0]) >= 0.02 || Math.abs(r[2] - opening[2]) >= 0.02))
    return
  const rect = [opening[0], opening[1], closing[2], closing[1]]
  const source = items.filter(
    (i) =>
      i.text.trim() &&
      i.rect[0] < rect[2] &&
      i.rect[2] > rect[0] &&
      i.rect[1] < rect[3] &&
      i.rect[3] > rect[1]
  )
  const contained = (r, i) => i.rect.every((v, n) => (n < 2 ? v >= r[n] - 0.02 : v <= r[n] + 0.02))
  if (
    !source.length ||
    source.some(
      (i) =>
        !i.horizontal ||
        !Number.isFinite(i.baseline) ||
        !(i.height > 0) ||
        !contained(rect, i) ||
        edges.some((r) => i.rect[1] < r[1] && i.rect[3] > r[1])
    )
  )
    return
  if (
    new Set(source.map((i) => JSON.stringify([i.text, i.rect, i.baseline, i.height]))).size !==
    source.length
  )
    return
  // A removed footer must not turn the last internal group fence into a frame.
  if (
    items.some(
      (i) =>
        i.text.trim() &&
        i.rect[0] >= rect[0] - 0.02 &&
        i.rect[2] <= rect[2] + 0.02 &&
        i.rect[1] > closing[1] &&
        i.baseline <= crop[3]
    )
  )
    return
  const h = Math.max(...source.map((i) => i.height))
  const titles = captions.filter(
    (c) =>
      captionKind(c.lines?.[0]) === 'table' &&
      c.rect[0] < rect[2] &&
      c.rect[2] > rect[0] &&
      ((c.rect[3] < rect[1] && rect[1] - c.rect[3] < h * 8) ||
        (c.rect[1] > rect[3] && c.rect[1] - rect[3] < h * 4))
  )
  if (titles.length !== 1) return
  return {
    opening,
    divider,
    closing,
    edges,
    rect,
    source,
    h,
    contained,
    header: source.filter((i) => i.rect[3] < divider[1]),
    body: source.filter((i) => i.rect[1] > divider[1])
  }
}

// Recover an unassigned ordinary continuation only after complete native record
// anchors and an already fully owned wrap in that same leaf prove its owner.
// Partial printed rules establish the closing edge, not body record boundaries.
export function proveNativeCalibratedWrappedLeafOwners(
  table,
  items,
  captions,
  rules,
  runs = [],
  recordText
) {
  const valid = (r) =>
      Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1],
    equalRect = (a, b) => valid(a) && valid(b) && a.every((v, n) => v === b[n]),
    fits = (r, b) => r[0] >= b[0] && r[1] >= b[1] && r[2] <= b[2] && r[3] <= b[3],
    intersection = (a, b) =>
      Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
      Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1])),
    same = (t, i) =>
      t.text === i.text &&
      equalRect(t.rect, i.rect) &&
      t.baseline === i.baseline &&
      t.height === i.height,
    crop = table?.cropRect,
    nr = table?.grid?.length,
    nc = table?.grid?.[0]?.length
  if (
    typeof recordText !== 'function' ||
    !Array.isArray(table?.grid) ||
    !(nr >= 4) ||
    !(nc >= 3) ||
    !table.grid.every((r) => Array.isArray(r) && r.length === nc) ||
    !Array.isArray(table.cells) ||
    !Array.isArray(table.unassigned) ||
    !table.unassigned.length ||
    !Array.isArray(table.clipped) ||
    !Array.isArray(table.issues) ||
    !Array.isArray(items) ||
    !Array.isArray(captions) ||
    !Array.isArray(rules) ||
    !Array.isArray(runs) ||
    table.cells.length !== nr * nc ||
    table.cells.some(
      (c) =>
        !c ||
        !Number.isInteger(c.row) ||
        c.row < 0 ||
        c.row >= nr ||
        !Number.isInteger(c.column) ||
        c.column < 0 ||
        c.column >= nc ||
        !Array.isArray(c.sourceTokens) ||
        !Array.isArray(c.sourceRects) ||
        typeof c.text !== 'string' ||
        c.sourceTokens.some(
          (t) =>
            !t ||
            typeof t.text !== 'string' ||
            !valid(t.rect) ||
            !Number.isFinite(t.baseline) ||
            !Number.isFinite(t.height)
        ) ||
        c.sourceRects.some((r) => !valid(r)) ||
        (c.textRuns !== undefined &&
          (!Array.isArray(c.textRuns) || c.textRuns.some((r) => !r || typeof r.text !== 'string')))
    ) ||
    new Set(table.cells.map((c) => JSON.stringify([c.row, c.column]))).size !==
      table.cells.length ||
    captions.some((c) => !c || !Array.isArray(c.lines) || typeof c.lines[0] !== 'string') ||
    items.some((i) => !i || typeof i.text !== 'string') ||
    runs.some((r) => !r || typeof r.text !== 'string') ||
    rules.some((r) => !Array.isArray(r) || r.length !== 4 || !r.every(Number.isFinite))
  )
    return
  if (!(!table.readingRotation && valid(crop))) return
  if (!(
    table.cells.length === nr * nc &&
    table.cells.every((c) => c.rowSpan === 1 && c.colSpan === 1 && valid(c.rect))
  ))
    return
  if (!(
    !table.clipped.length &&
    table.unassigned.length &&
    table.issues.every((i) => i === 'unassigned-source-text')
  ))
    return
  if (!(
    captions.length === 1 &&
    /^Table\s+[\dIVX]+[.:]/u.test(captions[0].lines[0]) &&
    valid(captions[0].rect) &&
    captions[0].rect[3] < crop[1]
  ))
    return
  if (
    !items
      .filter((i) => i.text.trim())
      .every(
        (i) =>
          valid(i.rect) && Number.isFinite(i.baseline) && i.height > 0 && Number.isFinite(i.height)
      )
  )
    return
  const source = items.filter((i) => i.text.trim() && intersection(i.rect, crop) > 0)
  if (!(source.length && source.every((i) => i.horizontal && fits(i.rect, crop)))) return
  const h = source[0].height
  if (!source.every((i) => i.height === h)) return
  if (!source.every((i) => source.filter((j) => same(i, j)).length === 1)) return
  for (const i of source) {
    const matches = runs.filter(
      (r) => r.text === i.text && valid(r.rect) && equalRect(r.rect, i.rect)
    )
    if (!(matches.length === 1)) return
    const r = matches[0]
    if (!(
      r.baseline === i.baseline &&
      r.height === i.height &&
      Array.isArray(r.glyphRuns) &&
      r.glyphRuns.length > 0 &&
      new Set(r.glyphRuns).size === 1 &&
      Array.isArray(r.literalGlyphs) &&
      r.literalGlyphs.join('').replace(/\s/gu, '') === i.text.replace(/\s/gu, '')
    ))
      return
  }
  const at = (r, c) => table.cells.find((x) => x.row === r && x.column === c)
  const cuts = [at(0, 0).rect[0], ...Array.from({ length: nc }, (_, c) => at(0, c).rect[2])]
  if (!(cuts.every(Number.isFinite) && cuts.every((x, n) => !n || x > cuts[n - 1]))) return
  if (!table.cells.every((c) => c.rect[0] === cuts[c.column] && c.rect[2] === cuts[c.column + 1]))
    return
  const lane = (i) =>
    Array.from({ length: nc }, (_, c) => c).filter(
      (c) => i.rect[0] >= cuts[c] && i.rect[2] <= cuts[c + 1]
    )
  if (!source.every((i) => lane(i).length === 1)) return
  const owners = new Map(),
    matched = new Map()
  for (const cell of table.cells) {
    if (!(
      !cell.textRuns?.some((r) => r.position !== 'normal') &&
      (!cell.textRuns?.length || cell.textRuns.map((r) => r.text).join('') === cell.text) &&
      cell.sourceTokens.length === cell.sourceRects.length &&
      cell.sourceTokens.length > 0
    ))
      return
    for (const t of cell.sourceTokens) {
      if (!(
        valid(t.rect) &&
        cell.sourceRects.filter((r) => valid(r) && equalRect(r, t.rect)).length === 1
      ))
        return
      const candidates = source.filter((i) => same(t, i))
      if (!(
        candidates.length === 1 &&
        !owners.has(candidates[0]) &&
        lane(candidates[0])[0] === cell.column
      ))
        return
      owners.set(candidates[0], cell)
    }
    for (const r of cell.sourceRects)
      if (
        !(
          cell.sourceTokens.filter((t) => valid(t.rect) && valid(r) && equalRect(t.rect, r))
            .length === 1
        )
      )
        return
    if (!(
      recordText(cell.sourceTokens) === cell.text && cell.text === table.grid[cell.row][cell.column]
    ))
      return
    matched.set(
      cell,
      source.filter((i) => owners.get(i) === cell)
    )
  }
  const header = source.filter((i) => owners.get(i)?.row === 0)
  const headerBottom = Math.max(...header.map((i) => i.rect[3]))
  const body = source.filter((i) => !header.includes(i))
  if (!(
    header.length &&
    header.every((i) => fits(i.rect, owners.get(i).rect)) &&
    body.every((i) => i.rect[1] > headerBottom)
  ))
    return
  const anchorColumns = Array.from({ length: nc }, (_, c) => c).filter((c) => {
    const all = body.filter((i) => lane(i)[0] === c)
    return (
      all.length === nr - 1 &&
      Array.from({ length: nr - 1 }, (_, n) => at(n + 1, c)).every(
        (cell) => cell.sourceTokens.length === 1 && all.some((i) => owners.get(i) === cell)
      )
    )
  })
  if (!(anchorColumns.length >= 3 && anchorColumns[0] === 0 && anchorColumns.at(-1) === nc - 1))
    return
  const anchors = Array.from({ length: nr - 1 }, (_, n) =>
    anchorColumns.map((c) => matched.get(at(n + 1, c))[0])
  )
  const bases = anchors.map((a) => Math.min(...a.map((i) => i.baseline)))
  if (!(
    anchors.every((a, n) => Math.max(...a.map((i) => i.baseline)) - bases[n] < h * 0.03) &&
    bases.every((b, n) => !n || b > bases[n - 1] + h * 1.8)
  ))
    return
  const fields = Array.from({ length: nr - 1 }, () => Array.from({ length: nc }, () => []))
  for (const i of body) {
    const candidates = bases
      .map((b, r) => ({ r, delta: i.baseline - b }))
      .filter((x) => x.delta >= -h * 0.03 && x.delta < h * 1.35)
    if (!(candidates.length === 1)) return
    fields[candidates[0].r][lane(i)[0]].push(i)
  }
  const envelopes = fields.map((row) => [
    Math.min(...row.flat().map((i) => i.rect[1])),
    Math.max(...row.flat().map((i) => i.rect[3]))
  ])
  if (!envelopes.every((e, n) => !n || e[0] > envelopes[n - 1][1])) return
  const closingY = [
    ...new Set(
      rules
        .filter(
          (r) =>
            valid([r[0], r[1] - 1, r[2], r[3] + 1]) &&
            r[1] === r[3] &&
            r[1] > envelopes.at(-1)[1] &&
            r[1] < envelopes.at(-1)[1] + h
        )
        .map((r) => r[1])
    )
  ]
  if (!(
    closingY.length === 1 &&
    Array.from({ length: nc }, (_, c) => c).every((c) =>
      rules.some(
        (r) =>
          r[1] === closingY[0] &&
          r[3] === r[1] &&
          r[0] <= Math.min(...source.filter((i) => lane(i)[0] === c).map((i) => i.rect[0])) &&
          r[2] >= Math.max(...source.filter((i) => lane(i)[0] === c).map((i) => i.rect[2]))
      )
    )
  ))
    return
  const replacements = [],
    missing = []
  for (const [n, row] of fields.entries())
    for (const [c, field] of row.entries()) {
      field.sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
      if (!(
        field.length >= 1 &&
        field.length <= 2 &&
        Math.abs(field[0].baseline - bases[n]) < h * 0.03
      ))
        return
      const cell = at(n + 1, c),
        own = matched.get(cell)
      if (!own.every((i) => field.includes(i))) return
      const absent = field.filter((i) => !owners.has(i))
      if (field.length === 2) {
        if (!(
          Math.abs(field[1].rect[0] - field[0].rect[0]) < h * 0.002 &&
          field[1].rect[1] > field[0].rect[3]
        ))
          return
        if (absent.length) {
          const calibration = fields.some(
            (cal, r) =>
              r !== n &&
              cal[c].length === 2 &&
              cal[c].every((i) => owners.get(i) === at(r + 1, c)) &&
              fits(cal[c][0].rect, at(r + 1, c).rect) &&
              fits(cal[c][1].rect, at(r + 1, c).rect) &&
              recordText(cal[c]) === at(r + 1, c).text &&
              Math.abs(
                cal[c][1].baseline - cal[c][0].baseline - (field[1].baseline - field[0].baseline)
              ) <
                h * 0.002 &&
              Math.abs(cal[c][1].rect[0] - cal[c][0].rect[0]) < h * 0.002
          )
          if (!calibration) return
        }
      }
      if (!absent.length) {
        if (!(own.length === field.length && cell.text === recordText(field))) return
        continue
      }
      if (!(
        absent.length === 1 &&
        field.length === 2 &&
        own.length === 1 &&
        own[0] === field[0] &&
        absent[0] === field[1]
      ))
        return
      if (cell.textRuns?.length) return
      const added = {
        text: absent[0].text,
        rect: absent[0].rect,
        baseline: absent[0].baseline,
        height: absent[0].height
      }
      const tokens = [...cell.sourceTokens, added]
      const origins = nativeChangedCellOrigins([cell], items, tokens)
      if (!origins) return
      replacements.push({
        cell,
        fonts: field,
        replacement: {
          ...cell,
          ...origins,
          rect: [
            cell.rect[0],
            Math.min(cell.rect[1], ...field.map((i) => i.rect[1])),
            cell.rect[2],
            Math.max(cell.rect[3], ...field.map((i) => i.rect[3]))
          ],
          text: recordText(tokens),
          sourceTokens: tokens,
          sourceRects: tokens.map((t) => t.rect)
        }
      })
      missing.push(absent[0])
    }
  if (!(
    replacements.length &&
    missing.length === table.unassigned.length &&
    missing.every((i) => table.unassigned.filter((t) => t === i.text).length === 1) &&
    table.unassigned.every((t) => missing.filter((i) => i.text === t).length === 1)
  ))
    return
  return { replacements, missing }
}

// A merged ordinary row is splittable only when complete native group fences
// and an already correct peer group independently prove every printed record.
// Existing headers and correct rich owners are preserved, not reconstructed.
export function proveNativeFencedMergedRecordOwners(table, items, captions, rules, runs = []) {
  const valid = (r) =>
      Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1],
    same = (a, b) =>
      a.text === b.text &&
      sameRect(a.rect, b.rect) &&
      a.baseline === b.baseline &&
      a.height === b.height,
    contains = (r, s) => s.every((v, n) => (n < 2 ? v >= r[n] - 0.02 : v <= r[n] + 0.02)),
    intersects = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
    { cells, grid, rows, cropRect: crop } = table,
    count = grid?.[0]?.length
  if (
    table.readingRotation ||
    table.unassigned?.length ||
    table.clipped?.length ||
    table.notes?.length ||
    !valid(crop) ||
    !(count >= 4 && count <= 12) ||
    rows?.length !== grid.length ||
    grid.some((r) => r.length !== count) ||
    !cells?.length ||
    items.some((i) => i.text?.trim() && !valid(i.rect)) ||
    runs.some((r) => r.text?.trim() && !valid(r.rect))
  )
    return
  const frame = nativeHeaderFrame(table, items, rules)
  if (!frame) return
  const { h, source, header, body, opening, divider, closing } = frame,
    fullFrame = [opening[0], opening[1], closing[2], closing[1]],
    ink = items.filter((i) => i.text?.trim() && intersects(i.rect, fullFrame)),
    fences = joinHorizontalTableRules(rules, 0.01, 0)
      .filter(
        (r) => r[1] >= opening[1] && r[1] <= closing[1] && r[2] > opening[0] && r[0] < opening[2]
      )
      .sort((a, b) => a[1] - b[1]),
    titles = captions.filter(
      (c) =>
        captionKind(c.lines?.[0]) === 'table' &&
        valid(c.rect) &&
        c.rect[3] < opening[1] &&
        opening[1] - c.rect[3] < h * 5 &&
        c.rect[0] < opening[2] &&
        c.rect[2] > opening[0]
    )
  if (
    titles.length !== 1 ||
    fences.length < 4 ||
    fences.length > 10 ||
    !sameRect(fences[0], opening) ||
    !sameRect(fences[1], divider) ||
    !sameRect(fences.at(-1), closing) ||
    fences.some(
      (r) => Math.abs(r[0] - opening[0]) >= 0.02 || Math.abs(r[2] - opening[2]) >= 0.02
    ) ||
    rules.some(
      (r) =>
        Math.abs(r[0] - r[2]) < 0.01 &&
        r[0] > opening[0] &&
        r[0] < opening[2] &&
        r[1] < closing[1] &&
        r[3] > opening[1]
    ) ||
    ink.length !== source.length ||
    ink.some((i) => !source.includes(i)) ||
    source.some(
      (i) =>
        !i.horizontal ||
        Math.abs(i.height - h) >= 0.02 ||
        !Number.isFinite(i.baseline) ||
        !contains(fullFrame, i.rect) ||
        fences.some((r) => i.rect[1] < r[1] && i.rect[3] > r[1]) ||
        !literalProgramMatches(i, runs)
    ) ||
    new Set(source.map((i) => JSON.stringify([i.text, i.rect, i.baseline, i.height]))).size !==
      source.length
  )
    return
  for (const font of source) {
    const programs = runs.filter((r) => r.text === font.text && sameRect(r.rect, font.rect))
    if (
      programs.length !== 1 ||
      programs[0].baseline !== font.baseline ||
      programs[0].height !== font.height ||
      !programs[0].glyphRuns?.length ||
      new Set(programs[0].glyphRuns).size !== 1
    )
      return
  }
  const headers = cells.filter((c) => c.row === 0).sort((a, b) => a.column - b.column)
  if (
    headers.length !== count ||
    header.length !== count ||
    physicalRows(header, h).length !== 1 ||
    headers.some((c, n) => c.column !== n || c.rowSpan !== 1 || c.colSpan !== 1 || !valid(c.rect))
  )
    return
  const cuts = [headers[0].rect[0], ...headers.map((c) => c.rect[2])]
  if (
    cuts[0] !== crop[0] ||
    cuts.at(-1) !== crop[2] ||
    headers.some((c, n) => n && Math.abs(c.rect[0] - cuts[n]) >= 0.02)
  )
    return
  const lane = (i) =>
    cuts.slice(1).flatMap((right, n) => (i.rect[0] >= cuts[n] && i.rect[2] <= right ? [n] : []))
  if (source.some((i) => lane(i).length !== 1)) return
  const domains = Array.from({ length: count }, (_, c) =>
    box(source.filter((i) => lane(i)[0] === c))
  )
  if (domains.slice(1).some((d, n) => d[0] - domains[n][2] <= h * 0.15)) return
  const owned = new Map(),
    original = new Map(),
    seen = new Set(),
    slots = new Set()
  for (const c of cells) {
    if (
      !Number.isInteger(c.row) ||
      !Number.isInteger(c.column) ||
      !Number.isInteger(c.rowSpan) ||
      c.row < 0 ||
      c.row + c.rowSpan > grid.length ||
      c.column < 0 ||
      c.column >= count ||
      c.rowSpan < 1 ||
      c.colSpan !== 1 ||
      (c.column && c.rowSpan !== 1) ||
      !valid(c.rect) ||
      !contains(crop, c.rect) ||
      c.textRuns?.length ||
      !Array.isArray(c.sourceTokens) ||
      !Array.isArray(c.sourceRects) ||
      c.sourceTokens.length !== c.sourceRects.length ||
      c.sourceTokens.some((t) => !valid(t.rect)) ||
      c.sourceRects.some((r) => !valid(r)) ||
      c.sourceTokens.some((t) => c.sourceRects.filter((r) => sameRect(r, t.rect)).length !== 1) ||
      c.sourceRects.some((r) => c.sourceTokens.filter((t) => sameRect(t.rect, r)).length !== 1)
    )
      return
    const natives = []
    for (const token of c.sourceTokens) {
      const matches = source.filter((i) => same(i, token))
      if (
        matches.length !== 1 ||
        seen.has(matches[0]) ||
        lane(matches[0])[0] !== c.column ||
        matches[0].rect[0] < c.rect[0] ||
        matches[0].rect[2] > c.rect[2]
      )
        return
      natives.push(matches[0])
      seen.add(matches[0])
      original.set(matches[0], token)
    }
    if (
      [...natives]
        .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
        .map((i) => i.text)
        .join(' ') !== c.text
    )
      return
    owned.set(c, natives)
    for (let row = c.row; row < c.row + c.rowSpan; row++) {
      const key = row + ':' + c.column
      if (slots.has(key) || grid[row][c.column] !== (row === c.row ? c.text : '')) return
      slots.add(key)
    }
  }
  if (
    seen.size !== source.length ||
    slots.size !== grid.length * count ||
    headers.some(
      (c, n) =>
        owned.get(c).length !== 1 ||
        !header.includes(owned.get(c)[0]) ||
        lane(owned.get(c)[0])[0] !== n
    )
  )
    return
  const groups = []
  let next = 1,
    calibration = 0
  const value = /^[+−-]?(?:\d+(?:[.,]\d+)*%?|(?:\p{Lu}\.){2,})$/u
  for (let n = 1; n < fences.length - 1; n++) {
    const top = fences[n][1],
      bottom = fences[n + 1][1],
      native = body.filter((i) => i.rect[1] > top && i.rect[3] < bottom),
      stub = native.filter((i) => lane(i)[0] === 0),
      fields = physicalRows(
        native.filter((i) => lane(i)[0] > 0),
        h
      )
    if (
      stub.length !== 1 ||
      fields.length < 2 ||
      fields.length > 8 ||
      fields.some(
        (g) => g.length !== count - 1 || g.some((i) => Math.abs(i.baseline - g[0].baseline) >= 0.02)
      ) ||
      fields.slice(1).some((g, k) => box(fields[k])[3] >= box(g)[1])
    )
      return
    const records = fields.map((g) =>
      Array.from({ length: count - 1 }, (_, c) => g.filter((i) => lane(i)[0] === c + 1))
    )
    if (
      records.some(
        (r) =>
          r.some((g) => g.length !== 1) ||
          !/\p{L}/u.test(r[0][0].text) ||
          r.slice(1).some((g) => !value.test(g[0].text.trim()))
      )
    )
      return
    const groupCells = cells.filter(
        (c) => c.row > 0 && owned.get(c).some((i) => native.includes(i))
      ),
      oldRows = [...new Set(groupCells.map((c) => c.row))].sort((a, b) => a - b),
      stubCell = groupCells.find((c) => c.column === 0)
    if (
      !stubCell ||
      groupCells.some((c) => owned.get(c).some((i) => !native.includes(i))) ||
      oldRows.some((r, k) => r !== next + k) ||
      !(oldRows.length === 1 || oldRows.length === records.length) ||
      !contains(stubCell.rect, stub[0].rect) ||
      !same(owned.get(stubCell)[0], stub[0]) ||
      owned.get(stubCell).length !== 1 ||
      stubCell.row !== next ||
      stubCell.rowSpan !== oldRows.length
    )
      return
    if (oldRows.length === records.length) {
      if (groupCells.length !== 1 + records.length * (count - 1)) return
      for (const [k, r] of records.entries())
        for (let col = 1; col < count; col++) {
          const peers = groupCells.filter((c) => c.row === oldRows[k] && c.column === col)
          if (
            peers.length !== 1 ||
            owned.get(peers[0]).length !== 1 ||
            owned.get(peers[0])[0] !== r[col - 1][0]
          )
            return
        }
      calibration++
      groups.push({ oldRows, stubCell, records, merged: false })
    } else {
      if (groupCells.length !== count || groupCells.some((c) => c.rowSpan !== 1)) return
      const donors = groupCells.sort((a, b) => a.column - b.column),
        oldRow = rows[next]
      if (!valid(oldRow.rect)) return
      for (let col = 1; col < count; col++)
        if (
          owned.get(donors[col]).length !== records.length ||
          records.some((r) => !owned.get(donors[col]).includes(r[col - 1][0]))
        )
          return
      const fonts = fields.flat(),
        ys = [
          Math.min(oldRow.rect[1], ...fonts.map((i) => i.rect[1])),
          ...fields.slice(1).map((g, k) => (box(fields[k])[3] + box(g)[1]) / 2),
          Math.max(oldRow.rect[3], ...fonts.map((i) => i.rect[3]))
        ]
      if (
        ys[0] <= top ||
        ys.at(-1) >= bottom ||
        fields.some((g, k) => g.some((i) => i.rect[1] < ys[k] || i.rect[3] > ys[k + 1])) ||
        donors
          .slice(1)
          .some(
            (c) =>
              Math.abs(c.rect[1] - oldRow.rect[1]) >= 0.02 ||
              Math.abs(c.rect[3] - oldRow.rect[3]) >= 0.02
          )
      )
        return
      groups.push({ oldRows, stubCell, records, merged: true, donors, ys })
    }
    next += oldRows.length
  }
  if (
    !calibration ||
    next !== grid.length ||
    !groups.some((g) => g.merged) ||
    groups.flatMap((g) => [...owned.get(g.stubCell), ...g.records.flat(2)]).length !== body.length
  )
    return
  if (
    groups.some(
      (group) =>
        group.merged &&
        group.donors
          .slice(1)
          .some((donor, column) =>
            group.records.some(
              (record) => !nativeChangedCellOrigins([donor], items, [record[column][0]])
            )
          )
    )
  )
    return
  return {
    groups: groups.map((g) => ({
      ...g,
      records: g.records.map((r) => r.map((f) => original.get(f[0])))
    }))
  }
}

function literalProgramMatches(item, runs) {
  const matches = runs.filter((r) => r.text === item.text && sameRect(r.rect, item.rect))
  return (
    matches.length === 1 &&
    Math.abs(matches[0].baseline - item.baseline) < 0.02 &&
    Math.abs(matches[0].height - item.height) < 0.02 &&
    matches[0].literalGlyphs?.join('') === item.text.replace(/\s/gu, '')
  )
}

// One ordinary record cannot borrow the repeated-record solver's calibration.
// A complete native header/body font partition, three painted edges and exact
// old source owners instead prove the one missing leaf without changing its minima.
export function proveNativeSingleOrdinaryRecordOwners(
  table,
  items,
  captions,
  rules,
  runs,
  rulePaintBounds
) {
  const valid = (r) =>
      Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1],
    contains = (r, s) => s.every((v, n) => (n < 2 ? v >= r[n] - 0.02 : v <= r[n] + 0.02)),
    overlap = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
    equal = (a, b) =>
      a.text === b.text &&
      sameRect(a.rect, b.rect) &&
      a.baseline === b.baseline &&
      a.height === b.height,
    crop = table.cropRect
  if (
    table.readingRotation ||
    !(rulePaintBounds instanceof Map) ||
    !valid(crop) ||
    table.grid?.length !== 2 ||
    table.rows?.length !== 2 ||
    table.unassigned?.length ||
    table.clipped?.length ||
    !Array.isArray(runs) ||
    items.some((i) => i.text?.trim() && !valid(i.rect))
  )
    return
  const nearby = items.filter((i) => i.text?.trim() && overlap(i.rect, crop))
  if (!nearby.length || nearby.some((i) => !Number.isFinite(i.height) || i.height <= 0)) return
  const h = Math.max(...nearby.map((i) => i.height)),
    edges = joinHorizontalTableRules(rules, 0.01, 0)
      .filter(
        (r) =>
          r.every(Number.isFinite) &&
          Math.abs(r[0] - crop[0]) < h &&
          Math.abs(r[2] - crop[2]) < h &&
          r[1] > crop[1] - h &&
          r[1] < crop[3] + h &&
          r[2] - r[0] > (crop[2] - crop[0]) * 0.7
      )
      .sort((a, b) => a[1] - b[1])
  if (
    edges.length !== 3 ||
    edges.some((r) => Math.abs(r[0] - edges[0][0]) >= 0.02 || Math.abs(r[2] - edges[0][2]) >= 0.02)
  )
    return
  const paint = edges.map((r) => rulePaintBounds.get(r.join(',')))
  if (
    paint.some(
      (p, n) =>
        !valid(p) ||
        p[0] > edges[n][0] ||
        p[2] < edges[n][2] ||
        p[1] > edges[n][1] ||
        p[3] < edges[n][1]
    )
  )
    return
  const frame = [edges[0][0], edges[0][1], edges[2][2], edges[2][1]],
    source = items.filter((i) => i.text?.trim() && overlap(i.rect, frame))
  if (
    !source.length ||
    source.some(
      (i) =>
        !i.horizontal ||
        !Number.isFinite(i.baseline) ||
        Math.abs(i.height - h) >= 0.02 ||
        !contains(frame, i.rect) ||
        paint.some((p) => overlap(p, i.rect))
    ) ||
    new Set(source.map((i) => JSON.stringify([i.text, i.rect, i.baseline, i.height]))).size !==
      source.length
  )
    return
  const titles = captions.filter(
    (c) =>
      valid(c.rect) &&
      captionKind(c.lines?.[0]) === 'table' &&
      c.rect[0] < frame[2] &&
      c.rect[2] > frame[0] &&
      c.rect[3] < paint[0][1] &&
      paint[0][1] - c.rect[3] < h * 8
  )
  if (titles.length !== 1) return
  const header = source
      .filter((i) => i.rect[3] < paint[1][1])
      .sort((a, b) => a.rect[0] - b.rect[0]),
    body = source.filter((i) => i.rect[1] > paint[1][3]).sort((a, b) => a.rect[0] - b.rect[0]),
    count = header.length,
    word = (s) => /^[\p{L}][\p{L} .-]*$/u.test(s)
  if (
    count < 3 ||
    count > 8 ||
    body.length !== count ||
    source.length !== count * 2 ||
    [header, body].some((g) => g.some((i) => Math.abs(i.baseline - g[0].baseline) >= 0.02)) ||
    header.some((i) => !word(i.text)) ||
    !word(body[0].text) ||
    body.slice(1).some((i) => !/^[+−-]?\d+(?:\.\d+)?$/u.test(i.text))
  )
    return
  for (const i of source) {
    const observed = runs.filter(
      (r) => r.text === i.text && valid(r.rect) && sameRect(r.rect, i.rect)
    )
    if (
      observed.length !== 1 ||
      observed[0].baseline !== i.baseline ||
      observed[0].height !== i.height ||
      observed[0].literalGlyphs?.join('') !== i.text.replace(/\s/gu, '') ||
      !observed[0].glyphRuns?.length ||
      new Set(observed[0].glyphRuns).size !== 1
    )
      return
  }
  const domains = header.map((i, n) => box([i, body[n]])),
    gutters = domains.slice(1).map((d, n) => [domains[n][2], d[0]])
  if (gutters.some((g) => g[1] - g[0] <= h * 0.3)) return
  const cuts = [frame[0], ...gutters.map((g) => (g[0] + g[1]) / 2), frame[2]],
    groups = [header, body]
  if (
    groups.some((g) =>
      g.some((i, c) => !contains([cuts[c], frame[1], cuts[c + 1], frame[3]], i.rect))
    )
  )
    return
  if (
    table.grid.some((r) => r.length !== count - 1) ||
    table.cells?.length !== 2 * (count - 1) ||
    table.rows.some((r) => !valid(r.rect))
  )
    return
  const consumed = new Set(),
    slots = new Set(),
    donors = [],
    merged = []
  for (const cell of table.cells) {
    if (
      !Number.isInteger(cell.row) ||
      cell.row < 0 ||
      cell.row > 1 ||
      !Number.isInteger(cell.column) ||
      cell.column < 0 ||
      cell.column >= count - 1 ||
      cell.rowSpan !== 1 ||
      cell.colSpan !== 1 ||
      !valid(cell.rect) ||
      !contains(crop, cell.rect) ||
      cell.textRuns?.length ||
      !cell.sourceTokens?.length ||
      cell.sourceRects?.length !== cell.sourceTokens.length ||
      cell.sourceRects.some((r) => !valid(r)) ||
      cell.sourceTokens.some(
        (t) => !valid(t.rect) || !Number.isFinite(t.baseline) || !Number.isFinite(t.height)
      ) ||
      table.grid[cell.row][cell.column] !== cell.text ||
      slots.has(cell.row + ':' + cell.column)
    )
      return
    slots.add(cell.row + ':' + cell.column)
    const matches = []
    for (const t of cell.sourceTokens) {
      const originals = groups[cell.row].filter((i) => equal(i, t))
      if (
        originals.length !== 1 ||
        consumed.has(originals[0]) ||
        cell.sourceRects.filter((r) => sameRect(r, t.rect)).length !== 1
      )
        return
      consumed.add(originals[0])
      matches.push({ token: t, column: groups[cell.row].indexOf(originals[0]) })
    }
    if (
      cell.sourceRects.some(
        (r) => !valid(r) || cell.sourceTokens.filter((t) => sameRect(r, t.rect)).length !== 1
      )
    )
      return
    matches.sort((a, b) => a.column - b.column)
    if (
      matches.length > 2 ||
      (matches.length === 2 && matches[1].column !== matches[0].column + 1) ||
      cell.text !== matches.map((m) => m.token.text).join(' ')
    )
      return
    if (matches.length === 2)
      merged.push({ row: cell.row, column: cell.column, leaf: matches[0].column })
    donors.push({ cell, matches })
  }
  if (
    consumed.size !== source.length ||
    merged.length !== 2 ||
    merged[0].row === merged[1].row ||
    merged[0].column !== merged[1].column ||
    merged[0].leaf !== merged[1].leaf ||
    donors.some(
      ({ cell, matches }) =>
        matches[0].column !== cell.column + (cell.column > merged[0].column ? 1 : 0)
    )
  )
    return
  const cropRect = crop.map((v, n) =>
    n < 2
      ? Math.min(v, ...paint.map((r) => r[n] - 0.5))
      : Math.max(v, ...paint.map((r) => r[n] + 0.5))
  )
  if (
    items.some((i) => i.text?.trim() && overlap(i.rect, cropRect) && !source.includes(i)) ||
    paint.some((p) => !contains(cropRect, p))
  )
    return
  if (
    donors.some(({ cell, matches }) =>
      matches.some(({ token }) => !nativeChangedCellOrigins([cell], items, [token]))
    )
  )
    return
  return { cuts, ys: edges.map((r) => r[1]), cropRect, donors }
}

// An already associated same-page References footer can calibrate its own
// raised flag in one closed header face without changing script adjacency.
export function proveNativeNoteCalibratedHeaderMarker(table, items, captions, rules, notes = []) {
  if (table.readingRotation || !table.cells?.length || table.grid?.length < 3) return
  const validRect = (r) =>
      r?.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1],
    equalRect = (a, b) => validRect(a) && validRect(b) && sameRect(a, b),
    same = (a, b) =>
      a.text === b.text &&
      equalRect(a.rect, b.rect) &&
      Number.isFinite(a.baseline) &&
      Number.isFinite(b.baseline) &&
      Math.abs(a.baseline - b.baseline) < 0.02 &&
      Math.abs(a.height - b.height) < 0.02,
    contained = (outer, inner) =>
      validRect(outer) &&
      validRect(inner) &&
      inner.every((v, n) => (n < 2 ? v >= outer[n] - 0.02 : v <= outer[n] + 0.02)),
    intersects = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
    matchingNotes = notes.filter((n) => /^([a-z]) References[:.]\s*\(1\)\s+\p{L}/u.test(n.text))
  if (matchingNotes.length !== 1 || !validRect(table.cropRect)) return
  const note = matchingNotes[0]
  if (!validRect(note.rect) || items.some((i) => i.text.trim() && !validRect(i.rect))) return
  const letter = note.text[0],
    targets = table.cells.filter(
      (c) =>
        c.row === 0 &&
        c.rowSpan === 1 &&
        c.colSpan === 1 &&
        c.sourceTokens?.length === 2 &&
        c.sourceTokens.some((t) => t.text === 'Ref.') &&
        c.sourceTokens.some((t) => t.text === letter)
    )
  if (targets.length !== 1) return
  const target = targets[0]
  if (
    target.text !== letter + ' Ref.' ||
    target.textRuns?.length ||
    target.column === 0 ||
    target.column !== table.grid[0].length - 1
  )
    return
  const owned = target.sourceTokens,
    source = owned.map((t) => items.filter((i) => same(i, t)))
  if (source.some((xs) => xs.length !== 1)) return
  const baseToken = owned.find((t) => t.text === 'Ref.'),
    markerToken = owned.find((t) => t.text === letter),
    base = source[owned.indexOf(baseToken)][0],
    mark = source[owned.indexOf(markerToken)][0],
    h = base.height
  if (
    !(h > 0) ||
    !Number.isFinite(h) ||
    !base.horizontal ||
    !mark.horizontal ||
    base.inlineSymbol ||
    mark.inlineSymbol ||
    target.sourceRects?.length !== 2 ||
    !owned.every((t) => target.sourceRects.filter((r) => equalRect(r, t.rect)).length === 1) ||
    !target.sourceRects.every((r) => owned.filter((t) => equalRect(t.rect, r)).length === 1) ||
    table.cells.some(
      (c) => c !== target && (c.sourceTokens ?? []).some((t) => same(t, base) || same(t, mark))
    )
  )
    return
  const edges = joinHorizontalTableRules(rules, 0.01, 0)
    .filter(
      (r) =>
        r[1] >= table.cropRect[1] - h &&
        r[1] <= table.cropRect[3] + h &&
        Math.abs(r[0] - table.cropRect[0]) < h &&
        Math.abs(r[2] - table.cropRect[2]) < h
    )
    .sort((a, b) => a[1] - b[1])
  if (
    edges.length !== 4 ||
    edges.some((r) => Math.abs(r[0] - edges[0][0]) > 0.02 || Math.abs(r[2] - edges[0][2]) > 0.02) ||
    edges[1][1] - edges[0][1] <= 0 ||
    edges[1][1] - edges[0][1] >= h * 0.25 ||
    edges[2][1] - edges[1][1] <= h ||
    edges[2][1] - edges[1][1] >= h * 5
  )
    return
  const frame = [edges[0][0], edges[0][1], edges[0][2], edges.at(-1)[1]],
    header = [frame[0], edges[1][1], frame[2], edges[2][1]]
  if (
    !contained(header, base.rect) ||
    !contained(header, mark.rect) ||
    !contained(target.rect, base.rect) ||
    !contained(target.rect, mark.rect)
  )
    return
  const titles = captions.filter(
    (c) =>
      captionKind(c.lines?.[0]) === 'table' &&
      c.rect[3] <= frame[1] &&
      frame[1] - c.rect[3] < h * 5 &&
      c.rect[0] < frame[2] &&
      c.rect[2] > frame[0]
  )
  if (titles.length !== 1) return
  const previous = table.cells
      .filter((c) => c.column === target.column - 1)
      .flatMap((c) => c.sourceRects ?? []),
    ownColumn = table.cells
      .filter((c) => c.column === target.column)
      .flatMap((c) => c.sourceRects ?? [])
  if (!previous.length || !ownColumn.length) return
  const left = Math.max(...previous.map((r) => r[2])),
    right = Math.min(...ownColumn.map((r) => r[0]))
  if (
    !(right - left > h * 0.2) ||
    !(target.rect[0] > left && target.rect[0] < right) ||
    base.rect[0] < right - 0.02 ||
    mark.rect[2] > frame[2]
  )
    return
  const face = [target.rect[0], header[1], frame[2], header[3]],
    ink = items.filter((i) => i.text.trim() && intersects(i.rect, face))
  if (ink.length !== 2 || !ink.every((i) => i.horizontal && [base, mark].includes(i))) return
  if (
    Math.abs(mark.height - h) > 0.02 ||
    Math.abs(mark.rect[0] - base.rect[2]) > h * 0.05 ||
    !(base.baseline > mark.baseline)
  )
    return
  const footer = items.filter((i) => i.text.trim() && intersects(i.rect, note.rect))
  if (
    footer.length < 4 ||
    footer.some(
      (i) =>
        !i.horizontal ||
        !Number.isFinite(i.baseline) ||
        !Number.isFinite(i.height) ||
        !(i.height > 0) ||
        !contained(note.rect, i.rect)
    )
  )
    return
  const firsts = footer.filter((i) => /^References[:.]\s*\(1\)\s+\p{L}/u.test(i.text)),
    markers = footer.filter((i) => i.text === letter)
  if (firsts.length !== 1 || markers.length !== 1) return
  const first = firsts[0],
    flag = markers[0]
  if (
    first.rect[1] <= frame[3] ||
    flag.rect[1] <= frame[3] ||
    flag.rect[1] - frame[3] >= h ||
    Math.abs(flag.height - mark.height) > 0.02 ||
    Math.abs(first.height - h) > 0.02 ||
    Math.abs(first.baseline - flag.baseline - (base.baseline - mark.baseline)) > 0.02 ||
    !(first.baseline > flag.baseline) ||
    first.rect[0] - flag.rect[2] < -0.02 ||
    first.rect[0] - flag.rect[2] > h * 0.4
  )
    return
  const literal = [...footer]
    .sort((a, b) =>
      Math.abs(a.baseline - b.baseline) > h * 0.65 ? a.baseline - b.baseline : a.rect[0] - b.rect[0]
    )
    .map((i) => i.text.trim())
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (literal !== note.text) return
  const keys = [...literal.matchAll(/\((\d{1,2})\)/gu)].map((m) => Number(m[1]))
  if (
    keys.length < 3 ||
    keys.length > 32 ||
    keys.some((key, n) => key !== n + 1) ||
    (literal.match(/\(\d{4}\)/gu) ?? []).length !== keys.length ||
    !/\(\d{4}\)\.$/u.test(literal)
  )
    return
  const wholeFrameInk = items.filter((i) => i.text.trim() && intersects(i.rect, frame))
  if (wholeFrameInk.some((i) => !i.horizontal || !contained(frame, i.rect))) return
  return { target, baseToken, markerToken, baselineHeight: h }
}

// A simple continued literal grid can have correct leaf predictions while
// its first record shares the header and other records lie in model gaps.
// Require every printed face independently, rather than deleting empty rows
// or treating an arbitrary prose baseline as a record.
function completeScriptRecordOwners(table, items, captions, rules, runs) {
  if (table.readingRotation || !table.cells?.length || !runs?.length) return
  const frame = literalClosedFrame(table, items, captions, rules)
  if (!frame || frame.edges.length !== 5) return
  const { edges, source, contained } = frame,
    header = source.filter((i) => i.rect[1] > edges[1][1] && i.rect[3] < edges[2][1]),
    body = source.filter((i) => i.rect[1] > edges[2][1]),
    h = Math.max(...header.map((i) => i.height)),
    validRect = (r) => r?.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1]
  if (
    !header.length ||
    !body.length ||
    header.length + body.length !== source.length ||
    !(h > 0) ||
    edges[1][1] - edges[0][1] >= h * 0.3 ||
    edges[2][1] - edges[1][1] <= h ||
    edges[2][1] - edges[1][1] >= h * 4 ||
    source.some(
      (i) =>
        !validRect(i.rect) ||
        !Number.isFinite(i.height) ||
        Math.abs(i.rect[3] - i.rect[1] - i.height) >= 0.02 ||
        Math.abs(i.rect[3] - i.baseline) >= 0.02 ||
        i.height > h + 0.02 ||
        !literalProgramMatches(i, runs)
    )
  )
    return
  const split = (fonts, gap) => {
      const groups = []
      for (const font of [...fonts].sort((a, b) => a.rect[0] - b.rect[0])) {
        if (!groups.length || font.rect[0] - box(groups.at(-1))[2] > gap) groups.push([])
        groups.at(-1).push(font)
      }
      return groups
    },
    headings = split(header, h * 0.65),
    ordinary = body.filter((i) => Math.abs(i.height - h) < 0.02),
    small = body.filter((i) => !ordinary.includes(i)),
    baselines = []
  for (const font of [...ordinary].sort(
    (a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0]
  )) {
    let group = baselines.find((g) => Math.abs(g[0].baseline - font.baseline) < 0.02)
    if (!group) baselines.push((group = []))
    group.push(font)
  }
  const records = baselines.map((g) => split(g, h * 0.65)),
    count = headings.length
  if (
    count < 4 ||
    count > 16 ||
    table.grid?.[0]?.length !== count ||
    records.length < 3 ||
    !small.length ||
    small.some((i) => i.height >= h * 0.8) ||
    records.some((r) => r.length !== count) ||
    headings.some((g) => !g.some((i) => /\p{L}/u.test(i.text))) ||
    records.some((r) => r.filter((g) => g.some((i) => /\d/u.test(i.text))).length < count / 2)
  )
    return
  const scriptGroups = []
  for (const font of [...small].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    let group = scriptGroups.find(
      (g) =>
        Math.abs(g[0].baseline - font.baseline) < h * 0.03 &&
        font.rect[0] >= box(g)[0] &&
        font.rect[0] - box(g)[2] < h * 0.1
    )
    if (!group) scriptGroups.push((group = []))
    group.push(font)
  }
  const children = records.map((r) => r.map(() => []))
  for (const group of scriptGroups) {
    const child = {
      text: group.map((i) => i.text).join(''),
      rect: box(group),
      baseline: group[0].baseline,
      height: group[0].height,
      horizontal: true
    }
    if (
      group.some(
        (i) =>
          Math.abs(i.height - child.height) >= 0.02 ||
          Math.abs(i.baseline - child.baseline) >= h * 0.03
      )
    )
      return
    const parents = records.flatMap((r, row) =>
      r.flatMap((fonts, column) => {
        const parent = {
          text: fonts.map((i) => i.text).join(''),
          rect: box(fonts),
          baseline: fonts[0].baseline,
          height: h,
          horizontal: true
        }
        return isAdjacentTableScript(child, parent) ? [{ row, column, parent, fonts }] : []
      })
    )
    if (
      parents.length !== 1 ||
      parents[0].fonts.filter((i) => isAdjacentTableScript(child, i)).length !== 1 ||
      !isAdjacentTableScript(child, parents[0].fonts.at(-1)) ||
      child.rect[0] < parents[0].fonts.at(-1).rect[0]
    )
      return
    const owner = parents[0],
      position = child.baseline < owner.parent.baseline ? 'superscript' : 'subscript'
    if (children[owner.row][owner.column].some((g) => g.position === position)) return
    children[owner.row][owner.column].push({
      source: group,
      text: child.text,
      position,
      baseline: child.baseline
    })
  }
  const fullGroups = records.map((r, row) =>
      r.map((fonts, column) => [...fonts, ...children[row][column].flatMap((g) => g.source)])
    ),
    domains = headings.map((g, c) => box([...g, ...fullGroups.flatMap((r) => r[c])])),
    headerCells = table.cells.filter((c) => c.row === 0).sort((a, b) => a.column - b.column)
  if (
    headerCells.length !== count ||
    headerCells.some(
      (c, n) => c.column !== n || c.rowSpan !== 1 || c.colSpan !== 1 || !validRect(c.rect)
    )
  )
    return
  const cuts = [headerCells[0].rect[0], ...headerCells.map((c) => c.rect[2])]
  if (
    Math.abs(cuts[0] - table.cropRect[0]) > h ||
    Math.abs(cuts.at(-1) - table.cropRect[2]) > h ||
    headerCells.some((c, n) => n && Math.abs(c.rect[0] - cuts[n]) > 0.02)
  )
    return
  for (let c = 1; c < count; c++) {
    if (
      domains[c][0] - domains[c - 1][2] <= h * 0.15 ||
      !(cuts[c] > domains[c - 1][2] && cuts[c] < domains[c][0])
    )
      return
  }
  const owners = new Map()
  for (const cell of table.cells) {
    const tokens = cell.sourceTokens ?? [],
      boxes = cell.sourceRects ?? []
    if (cell.rowSpan !== 1 || cell.colSpan !== 1 || tokens.length !== boxes.length) return
    for (const t of tokens) {
      const matches = source.filter(
        (i) =>
          i.text === t.text &&
          sameRect(i.rect, t.rect) &&
          Math.abs(i.baseline - t.baseline) < 0.02 &&
          Math.abs(i.height - t.height) < 0.02
      )
      if (
        matches.length !== 1 ||
        owners.has(matches[0]) ||
        boxes.filter((r) => sameRect(r, t.rect)).length !== 1
      )
        return
      owners.set(matches[0], t)
    }
    if (boxes.some((r) => tokens.filter((t) => sameRect(r, t.rect)).length !== 1)) return
  }
  if (
    headerCells.some(
      (c, n) =>
        c.sourceTokens.length !== headings[n].length ||
        headings[n].some((i) => !c.sourceTokens.includes(owners.get(i)) || !contained(c.rect, i))
    )
  )
    return
  const unassigned = [...(table.unassigned ?? [])]
  for (const i of source.filter((i) => !owners.has(i))) {
    const n = unassigned.indexOf(i.text)
    if (n < 0) return
    unassigned.splice(n, 1)
  }
  if (unassigned.length) return
  const envelopes = fullGroups.map((r) => box(r.flat()))
  if (envelopes.some((r, n) => n && r[1] <= envelopes[n - 1][3])) return
  const mid = edges[3][1],
    gaps = envelopes.slice(1).map((r, n) => [envelopes[n][3], r[1]])
  if (gaps.filter((g) => mid > g[0] && mid < g[1]).length !== 1) return
  const rowEdges = [
      edges[2][1],
      ...gaps.map((g) => (mid > g[0] && mid < g[1] ? mid : (g[0] + g[1]) / 2)),
      edges[4][1]
    ],
    projected = records.map((r, row) =>
      r.map((fonts, column) => {
        const ordered = [...fonts].sort((a, b) => a.rect[0] - b.rect[0]),
          normal = ordered
            .map(
              (i, n) => `${n && i.rect[0] - ordered[n - 1].rect[2] > h * 0.12 ? ' ' : ''}${i.text}`
            )
            .join(''),
          scripts = [...children[row][column]].sort((a, b) => a.baseline - b.baseline),
          textRuns = [
            { text: normal, position: 'normal' },
            ...scripts.map(({ text, position }) => ({ text, position }))
          ],
          sourceTokens = [...ordered, ...scripts.flatMap((g) => g.source)].map(
            (i) =>
              owners.get(i) ?? {
                text: i.text,
                rect: i.rect,
                baseline: i.baseline,
                height: i.height
              }
          ),
          cell = {
            row: row + 1,
            column,
            rowSpan: 1,
            colSpan: 1,
            rect: [cuts[column], rowEdges[row], cuts[column + 1], rowEdges[row + 1]],
            text: textRuns.map((r) => r.text).join(''),
            sourceTokens,
            sourceRects: sourceTokens.map((t) => t.rect)
          }
        if (scripts.length) cell.textRuns = textRuns
        return cell
      })
    )
  // Identity admission is about complete row, rich text and whole-font owners,
  // not a count match or a reason to churn already correct scientific tables.
  if (
    table.grid.length === records.length + 1 &&
    table.cells.length === (records.length + 1) * count &&
    projected.flat().every((p) => {
      const c = table.cells.find((c) => c.row === p.row && c.column === p.column)
      return (
        c?.text === p.text &&
        table.grid[p.row]?.[p.column] === p.text &&
        JSON.stringify(c.textRuns) === JSON.stringify(p.textRuns) &&
        c.sourceTokens.length === p.sourceTokens.length &&
        p.sourceTokens.every((t) => c.sourceTokens.includes(t)) &&
        p.sourceRects.every((r) => contained(c.rect, { rect: r }))
      )
    })
  )
    return
  return {
    cuts,
    groups: [headerCells, ...projected],
    rowRects: [
      [cuts[0], headerCells[0].rect[1], cuts.at(-1), headerCells[0].rect[3]],
      ...rowEdges.slice(1).map((bottom, n) => [cuts[0], rowEdges[n], cuts.at(-1), bottom])
    ],
    consumed: source
  }
}

export function proveNativeCompleteOrdinaryRecordOwners(table, items, captions, rules, runs = []) {
  const scripted = completeScriptRecordOwners(table, items, captions, rules, runs)
  if (scripted) return scripted
  const frame = literalClosedFrame(table, items, captions, rules)
  if (!frame || frame.edges.length !== 3) return
  const { header, body, source, h, rect, contained } = frame
  if (source.some((i) => Math.abs(i.height - h) >= 0.02)) return
  const headings = physicalRows(header, h),
    records = physicalRows(body, h)
  if (headings.length !== 1 || records.length < 3) return
  const count = headings[0].length
  if (count < 4 || count > 16 || table.grid?.[0]?.length !== count) return
  const groups = [headings[0], ...records].map((g) => [...g].sort((a, b) => a.rect[0] - b.rect[0]))
  if (
    groups.some(
      (g) => g.length !== count || g.some((i) => Math.abs(i.baseline - g[0].baseline) >= 0.02)
    ) ||
    groups[0].some((i) => !/\p{L}/u.test(i.text)) ||
    records.some(
      (g) =>
        g.filter((i) => /\p{L}/u.test(i.text)).length < 2 ||
        g.filter((i) => /^[−+]?\d[\d.,]*$/u.test(i.text.trim())).length < 2
    ) ||
    table.cells?.some(
      (c) => c.rowSpan !== 1 || c.colSpan !== 1 || c.textRuns?.some((r) => r.position !== 'normal')
    )
  )
    return
  const cuts = [rect[0]]
  for (let c = 1; c < count; c++) {
    const right = Math.max(...groups.map((g) => g[c - 1].rect[2])),
      left = Math.min(...groups.map((g) => g[c].rect[0]))
    if (left - right <= h * 0.2) return
    cuts.push((right + left) / 2)
  }
  cuts.push(rect[2])
  if (groups.some((g) => g.some((i, c) => !contained([cuts[c], rect[1], cuts[c + 1], rect[3]], i))))
    return
  const owners = new Map(),
    cells = table.cells ?? []
  for (const cell of cells) {
    const tokens = cell.sourceTokens ?? [],
      boxes = cell.sourceRects ?? []
    if (tokens.length !== boxes.length) return
    for (const t of tokens) {
      const matches = source.filter(
        (i) =>
          i.text === t.text &&
          sameRect(i.rect, t.rect) &&
          Math.abs(i.baseline - t.baseline) < 0.02 &&
          Math.abs(i.height - t.height) < 0.02
      )
      if (
        matches.length !== 1 ||
        owners.has(matches[0]) ||
        boxes.filter((r) => sameRect(r, t.rect)).length !== 1
      )
        return
      owners.set(matches[0], t)
    }
    if (boxes.some((r) => tokens.filter((t) => sameRect(r, t.rect)).length !== 1)) return
  }
  const missing = source.filter((i) => !owners.has(i)),
    unassigned = [...(table.unassigned ?? [])]
  for (const i of missing) {
    const index = unassigned.indexOf(i.text)
    if (index < 0) return
    unassigned.splice(index, 1)
  }
  const correctlyOwned =
    table.grid.length === groups.length &&
    cells.length === source.length &&
    cells.every(
      (c) =>
        c.sourceTokens.length === 1 &&
        c.row < groups.length &&
        groups[c.row]?.[c.column]?.text === c.text &&
        owners.get(groups[c.row]?.[c.column]) === c.sourceTokens[0]
    )
  if (unassigned.length || correctlyOwned) return
  // Native row bands must be disjoint complete font boxes. A wrapped face or
  // a genuine blank ruled record cannot supply this ordinary one-line proof.
  const rowRects = groups.map((g) => [
    cuts[0],
    Math.min(...g.map((i) => i.rect[1])),
    cuts.at(-1),
    Math.max(...g.map((i) => i.rect[3]))
  ])
  if (rowRects.some((r, n) => n && r[1] <= rowRects[n - 1][3])) return
  return {
    cuts,
    rowRects,
    groups: groups.map((g) =>
      g.map(
        (i) =>
          owners.get(i) ?? { text: i.text, rect: i.rect, baseline: i.baseline, height: i.height }
      )
    ),
    consumed: source
  }
}

// A double opening is distinct painted ink, not a second header divider.
// Two repeated ordinary label lines have existing complete record owners;
// merge only their two donors inside independently closed group fences.
export function proveNativeFencedTwoLineStubOwners(table, items, captions, rules) {
  const frame = nativeHeaderFrame(table, items, rules)
  if (!frame || table.unassigned?.length || table.readingRotation) return
  const { opening, divider, closing, source, header, body, h } = frame,
    { cells, grid } = table,
    count = grid?.[0]?.length,
    edges = joinHorizontalTableRules(rules, 0.01, 0)
      .filter(
        (r) => r[1] >= opening[1] && r[1] <= closing[1] && r[0] < opening[2] && r[2] > opening[0]
      )
      .sort((a, b) => a[1] - b[1]),
    ink = items.filter(
      (i) =>
        i.text.trim() &&
        i.rect[2] > opening[0] &&
        i.rect[0] < opening[2] &&
        i.rect[3] > opening[1] &&
        i.rect[1] < closing[1]
    ),
    titles = captions.filter(
      (c) =>
        captionKind(c.lines?.[0]) === 'table' &&
        c.rect[3] < opening[1] &&
        opening[1] - c.rect[3] < h * 5 &&
        c.rect[0] < opening[2] &&
        c.rect[2] > opening[0]
    )
  if (
    !cells?.length ||
    !(count >= 3) ||
    grid.some((r) => r.length !== count) ||
    titles.length !== 1 ||
    edges.length < 5 ||
    !sameRect(edges[0], opening) ||
    !sameRect(edges[2], divider) ||
    edges[1][1] - opening[1] >= h * 0.1 ||
    edges.some((r) => Math.abs(r[0] - opening[0]) >= 0.02 || Math.abs(r[2] - opening[2]) >= 0.02) ||
    ink.length !== source.length ||
    ink.some((i) => !source.includes(i)) ||
    new Set(source.map((i) => JSON.stringify([i.text, i.rect, i.baseline, i.height]))).size !==
      source.length ||
    source.some(
      (i) =>
        !i.horizontal ||
        !i.rect.every(Number.isFinite) ||
        i.rect[0] < opening[0] - 0.02 ||
        i.rect[2] > opening[2] + 0.02 ||
        i.rect[1] <= opening[1] ||
        i.rect[3] >= closing[1] ||
        edges.some((r) => i.rect[1] < r[1] && i.rect[3] > r[1])
    )
  )
    return
  const mapped = new Map(),
    found = new Set(),
    original = new Map()
  for (const cell of cells) {
    const tokens = cell.sourceTokens ?? [],
      boxes = cell.sourceRects ?? [],
      owned = []
    if (
      cell.colSpan !== 1 ||
      tokens.length !== boxes.length ||
      tokens.some((t) => boxes.filter((r) => sameRect(r, t.rect)).length !== 1) ||
      boxes.some((r) => tokens.filter((t) => sameRect(r, t.rect)).length !== 1)
    )
      return
    for (const token of tokens) {
      const matches = source.filter(
        (i) =>
          i.text === token.text &&
          sameRect(i.rect, token.rect) &&
          Math.abs(i.baseline - token.baseline) < 0.02 &&
          Math.abs(i.height - token.height) < 0.02
      )
      if (matches.length !== 1 || found.has(matches[0])) return
      found.add(matches[0])
      owned.push(matches[0])
      original.set(matches[0], token)
    }
    mapped.set(cell, owned)
  }
  if (found.size !== source.length) return
  const headerCells = cells.filter((c) => c.row === 0)
  if (
    headerCells.length !== count ||
    headerCells.some(
      (c) =>
        c.rowSpan !== 1 || !mapped.get(c).length || mapped.get(c).some((i) => !header.includes(i))
    ) ||
    header.some((i) => !headerCells.some((c) => mapped.get(c).includes(i)))
  )
    return
  const records = []
  for (let row = 1; row < grid.length; row++) {
    const peers = Array.from({ length: count - 1 }, (_, c) =>
      cells.filter((cell) => cell.row === row && cell.column === c + 1)
    )
    if (peers.some((g) => g.length !== 1 || g[0].rowSpan !== 1 || !mapped.get(g[0]).length)) return
    const ordinary = peers
      .slice(1)
      .flat()
      .flatMap((c) => mapped.get(c))
      .filter((i) => Math.abs(i.height - h) < 0.02)
    if (
      ordinary.length < count - 2 ||
      ordinary.some((i) => Math.abs(i.baseline - ordinary[0].baseline) >= 0.02) ||
      !mapped
        .get(peers[0][0])
        .some(
          (i) => Math.abs(i.height - h) < 0.02 && Math.abs(i.baseline - ordinary[0].baseline) < 0.02
        )
    )
      return
    records.push({ row, baseline: ordinary[0].baseline, peers: peers.flat() })
  }
  if (
    records.length < 4 ||
    records.some((r, n) => n && r.baseline - records[n - 1].baseline < h * 0.7)
  )
    return
  const domains = Array.from({ length: count - 1 }, (_, c) =>
    box(records.flatMap((r) => mapped.get(r.peers[c])))
  )
  if (domains.slice(1).some((d, c) => d[0] - domains[c][2] < h * 0.1)) return
  const fences = edges.slice(2),
    replacements = [],
    shapes = []
  let covered = 0
  for (let n = 1; n < fences.length; n++) {
    const top = fences[n - 1][1],
      bottom = fences[n][1],
      group = records.filter((r) => r.baseline > top && r.baseline < bottom),
      row = group[0]?.row,
      rowSpan = group.length,
      donors = cells
        .filter((c) => c.column === 0 && c.row >= row && c.row < row + rowSpan)
        .sort((a, b) => a.row - b.row)
    if (
      rowSpan < 2 ||
      row !== covered + 1 ||
      donors.length !== 2 ||
      donors[0].row !== row ||
      donors[0].rowSpan !== 1 ||
      donors[1].row !== row + 1 ||
      donors[1].rowSpan !== rowSpan - 1 ||
      donors.some((c) => c.textRuns?.some((r) => r.position !== 'normal')) ||
      group.some((r) =>
        r.peers.some((c) => mapped.get(c).some((i) => i.rect[1] <= top || i.rect[3] >= bottom))
      )
    )
      return
    const label = donors.flatMap((c) => mapped.get(c)),
      bands = physicalRows(label, h),
      union = box(donors)
    if (
      bands.length !== 2 ||
      bands[0].length < 1 ||
      bands[1].length !== 1 ||
      bands.some((g, k) =>
        g.some(
          (i) =>
            Math.abs(i.height - h) >= 0.02 ||
            Math.abs(i.baseline - group[k].baseline) >= 0.02 ||
            i.rect[1] <= top ||
            i.rect[3] >= bottom ||
            i.rect[2] >= domains[0][0] ||
            i.rect.some((v, j) => (j < 2 ? v < union[j] - 0.02 : v > union[j] + 0.02))
        )
      ) ||
      donors.some((c) => c.text !== joined(mapped.get(c))) ||
      mapped.get(donors[0]).length !== bands[0].length ||
      mapped.get(donors[1]).length !== 1
    )
      return
    const ordered = label.sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0]),
      shape = ordered.map((i) => [i.rect[0], i.rect[2], i.baseline - ordered[0].baseline])
    if (
      shapes.length &&
      (shape.length !== shapes[0].length ||
        shape.some((v, k) => v.some((x, j) => Math.abs(x - shapes[0][k][j]) >= 0.02)))
    )
      return
    shapes.push(shape)
    const sourceTokens = ordered.map((i) => original.get(i))
    if (!nativeChangedCellOrigins(donors, items, sourceTokens)) return
    replacements.push({
      row,
      rowSpan,
      donors,
      rect: union,
      sourceTokens,
      text: donors.map((c) => c.text).join(' ')
    })
    covered += rowSpan
  }
  if (
    replacements.length < 2 ||
    covered !== records.length ||
    body.some((i) => !cells.some((c) => c.row > 0 && mapped.get(c).includes(i)))
  )
    return
  return { replacements }
}

// Preserve an already correct wrapped/rich header and every complete record
// payload. Only extra empty predictions between those source-proved records
// are removed; a blank native face or an unowned glyph blocks the projection.
export function proveNativeCompleteRecordRowOwners(table, items, captions, rules) {
  const frame = nativeHeaderFrame(table, items, rules)
  if (!frame || table.unassigned?.length || table.readingRotation) return
  const { source, header, body, opening, divider, closing, h } = frame,
    { cells, grid, rows } = table,
    count = grid?.[0]?.length,
    titles = captions.filter(
      (c) =>
        captionKind(c.lines?.[0]) === 'table' &&
        c.rect[3] < opening[1] &&
        opening[1] - c.rect[3] < h * 5 &&
        c.rect[0] < opening[2] &&
        c.rect[2] > opening[0]
    ),
    ink = items.filter(
      (i) =>
        i.text.trim() &&
        i.rect[2] > opening[0] &&
        i.rect[0] < opening[2] &&
        i.rect[3] > opening[1] &&
        i.rect[1] < closing[1]
    )
  if (
    titles.length !== 1 ||
    !(count >= 4) ||
    !cells?.length ||
    rows?.length !== grid.length ||
    grid.some((r) => r.length !== count) ||
    cells.some((c) => c.rowSpan !== 1 || c.colSpan !== 1) ||
    source.length !== ink.length ||
    ink.some((i) => !source.includes(i)) ||
    source.some(
      (i) =>
        !i.horizontal ||
        !i.rect.every(Number.isFinite) ||
        i.rect[0] < opening[0] - 0.02 ||
        i.rect[2] > opening[2] + 0.02 ||
        i.rect[1] <= opening[1] ||
        i.rect[3] >= closing[1]
    )
  )
    return
  const mapped = new Map(),
    found = new Set()
  for (const cell of cells) {
    const tokens = cell.sourceTokens ?? [],
      boxes = cell.sourceRects ?? [],
      owned = []
    if (
      tokens.length !== boxes.length ||
      tokens.some((t) => boxes.filter((r) => sameRect(r, t.rect)).length !== 1) ||
      boxes.some((r) => tokens.filter((t) => sameRect(t.rect, r)).length !== 1)
    )
      return
    for (const token of tokens) {
      const matches = source.filter(
        (i) =>
          i.text === token.text &&
          sameRect(i.rect, token.rect) &&
          Math.abs(i.height - token.height) < 0.02 &&
          Math.abs(i.baseline - token.baseline) < 0.02
      )
      if (matches.length !== 1 || found.has(matches[0])) return
      found.add(matches[0])
      owned.push(matches[0])
    }
    mapped.set(cell, owned)
  }
  if (found.size !== source.length) return
  const keep = [],
    empty = [],
    records = []
  let bodyStarted = false
  for (let row = 0; row < grid.length; row++) {
    const owners = Array.from({ length: count }, (_, c) =>
      cells.filter((cell) => cell.row === row && cell.column === c)
    )
    if (owners.some((g) => g.length !== 1)) return
    const complete = owners.flat(),
      owned = complete.flatMap((c) => mapped.get(c))
    if (!owned.length) {
      if (!bodyStarted || complete.some((c) => c.text.trim()) || grid[row].some((s) => s.trim()))
        return
      empty.push(row)
      continue
    }
    if (owned.every((i) => header.includes(i))) {
      if (bodyStarted || complete.some((c) => !mapped.get(c).length)) return
      keep.push(row)
      continue
    }
    if (owned.some((i) => !body.includes(i)) || complete.some((c) => !mapped.get(c).length)) return
    bodyStarted = true
    const ordinary = complete.slice(1).flatMap((c) => mapped.get(c)),
      baseline = ordinary[0].baseline
    if (
      ordinary.length !== count - 1 ||
      ordinary.some(
        (i) =>
          Math.abs(i.height - h) >= 0.02 ||
          Math.abs(i.baseline - baseline) >= 0.02 ||
          !/^[−+]?\d[\d.,]*$/u.test(i.text.trim())
      ) ||
      !mapped
        .get(complete[0])
        .some((i) => Math.abs(i.height - h) < 0.02 && Math.abs(i.baseline - baseline) < 0.02) ||
      (records.length && baseline - records.at(-1).baseline < h * 0.6)
    )
      return
    records.push({ row, baseline, owners: complete })
    keep.push(row)
  }
  if (!empty.length || records.length < 3 || !header.length) return
  const domains = Array.from({ length: count }, (_, c) =>
    box(cells.filter((cell) => cell.column === c).flatMap((cell) => mapped.get(cell)))
  )
  if (domains.slice(1).some((d, c) => d[0] - domains[c][2] < h * 0.1)) return
  const fences = joinHorizontalTableRules(rules, 0.01, 0)
    .filter(
      (r) =>
        r[1] >= divider[1] &&
        r[1] <= closing[1] &&
        Math.abs(r[0] - opening[0]) < 0.02 &&
        Math.abs(r[2] - opening[2]) < 0.02
    )
    .sort((a, b) => a[1] - b[1])
  if (
    fences.length < 2 ||
    fences
      .slice(1)
      .some(
        (r, n) =>
          !records.some((record) => record.baseline > fences[n][1] && record.baseline < r[1])
      )
  )
    return
  return { keep }
}

// A repeated pair has two independently printed complete method/measurement
// records and one centered literal stub inside its own closed native fence.
// The empty method heading stays empty; no header span or group value is inferred.
export function recoverNativeFencedPairedLiteralPlan(table, items, captions, rules) {
  const frame = nativeHeaderFrame(table, items, rules)
  if (!frame || table.readingRotation) return
  const { h, opening, divider, closing, source, header, body } = frame,
    rect = [opening[0], opening[1], closing[2], closing[1]],
    edges = joinHorizontalTableRules(rules, 0.01, 0)
      .filter((r) => r[1] >= rect[1] && r[1] <= rect[3] && r[0] < rect[2] && r[2] > rect[0])
      .sort((a, b) => a[1] - b[1]),
    ink = items.filter(
      (i) =>
        i.text.trim() &&
        i.rect[0] < rect[2] &&
        i.rect[2] > rect[0] &&
        i.rect[1] < rect[3] &&
        i.rect[3] > rect[1]
    ),
    contains = (r, i) => i.rect.every((v, n) => (n < 2 ? v >= r[n] - 0.02 : v <= r[n] + 0.02)),
    ordinary = (i) => Math.abs(i.height - h) < 0.02,
    measurement = (i) => /^\d[\d.,]*\s+\([\d.,]+\)$/u.test(i.text.trim())
  if (
    !table.cropRect.every(Number.isFinite) ||
    edges.length < 4 ||
    !sameRect(edges[1], divider) ||
    edges.some((r) => Math.abs(r[0] - rect[0]) >= 0.02 || Math.abs(r[2] - rect[2]) >= 0.02) ||
    ink.length !== source.length ||
    ink.some((i) => !source.includes(i)) ||
    new Set(source.map((i) => JSON.stringify([i.text, i.rect, i.baseline, i.height]))).size !==
      source.length ||
    source.some(
      (i) =>
        !i.horizontal ||
        !Number.isFinite(i.baseline) ||
        !i.rect.every(Number.isFinite) ||
        !contains(rect, i) ||
        !contains(table.cropRect, i) ||
        edges.some((r) => i.rect[1] < r[1] && i.rect[3] > r[1])
    )
  )
    return
  const titles = captions.filter(
    (c) =>
      captionKind(c.lines?.[0]) === 'table' &&
      c.rect[1] > closing[1] &&
      c.rect[1] - closing[1] < h * 4 &&
      Math.min(c.rect[2], rect[2]) - Math.max(c.rect[0], rect[0]) > (rect[2] - rect[0]) * 0.7
  )
  if (
    titles.length !== 1 ||
    header.some((i) => !ordinary(i)) ||
    physicalRows(header, h).length !== 1
  )
    return
  const heading = []
  for (const i of [...header].sort((a, b) => a.rect[0] - b.rect[0])) {
    const prior = heading.at(-1)
    if (prior && i.rect[0] - box(prior)[2] < h * 0.6) prior.push(i)
    else heading.push([i])
  }
  const pairs = [],
    scriptParents = new Map()
  for (let n = 2; n < edges.length; n++) {
    const top = edges[n - 1][1],
      bottom = edges[n][1],
      group = body.filter((i) => i.rect[1] > top && i.rect[3] < bottom),
      peerBands = physicalRows(group.filter(ordinary), h).filter(
        (g) => g.filter(measurement).length >= 2
      )
    if (
      peerBands.length !== 2 ||
      peerBands.some(
        (g) =>
          g.length !== heading.length ||
          g.filter(measurement).length !== g.length - 1 ||
          !/^\p{L}[\p{L}\s-]*$/u.test(g[0].text.trim()) ||
          g.some((i) => Math.abs(i.baseline - g[0].baseline) >= 0.02)
      )
    )
      return
    const records = peerBands.map((g) => [...g].sort((a, b) => a.rect[0] - b.rect[0])),
      stub = group.filter((i) => !records.flat().includes(i)),
      normal = stub.filter(ordinary),
      small = stub.filter((i) => !ordinary(i)),
      center = (records[0][0].baseline + records[1][0].baseline) / 2
    if (
      normal.length < 2 ||
      small.length !== 1 ||
      normal.some((i) => Math.abs(i.baseline - center) >= 0.02) ||
      !normal.some((i) => /^\p{L}$/u.test(i.text)) ||
      !/^\d{1,3}$/u.test(small[0].text) ||
      small[0].height >= h * 0.8 ||
      small[0].baseline >= center ||
      stub.some((i) => i.rect[2] >= Math.min(...records.flat().map((i) => i.rect[0])))
    )
      return
    const parents = normal.filter((i) => isAdjacentTableScript(small[0], i))
    if (parents.length !== 1) return
    scriptParents.set(small[0], parents[0])
    if (
      pairs.length &&
      records.some(
        (g, r) =>
          g[0].text !== pairs[0].records[r][0].text ||
          Math.abs(g[0].baseline - top - (pairs[0].records[r][0].baseline - pairs[0].top)) >= 0.02
      )
    )
      return
    pairs.push({ top, bottom, records, stub })
  }
  if (pairs.length < 2 || heading.length < 3 || heading.length > 8) return
  const count = heading.length + 1,
    head = [heading[0], [], ...heading.slice(1)],
    domains = Array.from({ length: count }, (_, c) =>
      box([...head[c], ...pairs.flatMap((p) => (c ? p.records.map((r) => r[c - 1]) : p.stub))])
    ),
    cuts = [rect[0]]
  for (let c = 1; c < count; c++) {
    if (domains[c][0] - domains[c - 1][2] < h * 0.2) return
    cuts.push((domains[c][0] + domains[c - 1][2]) / 2)
  }
  cuts.push(rect[2])
  const groups = [header],
    spans = []
  for (const p of pairs) {
    const row = groups.length
    groups.push([...p.stub, ...p.records[0]], p.records[1])
    spans.push({ row, column: 0, rowSpan: 2, colSpan: 1, items: p.stub })
  }
  if (
    groups.flat().length !== source.length ||
    new Set(groups.flat()).size !== source.length ||
    head.some((g, c) => g.some((i) => !contains([cuts[c], rect[1], cuts[c + 1], rect[3]], i))) ||
    pairs.some(
      (p) =>
        p.stub.some((i) => !contains([cuts[0], p.top, cuts[1], p.bottom], i)) ||
        p.records.some((g) =>
          g.some((i, c) => !contains([cuts[c + 1], p.top, cuts[c + 2], p.bottom], i))
        )
    )
  )
    return
  const cropRect = [rect[0] - 0.5, rect[1] - 0.5, rect[2] + 0.5, rect[3] + 0.5]
  if (
    items.some(
      (i) =>
        i.text.trim() &&
        i.rect[0] < cropRect[2] &&
        i.rect[2] > cropRect[0] &&
        i.rect[1] < cropRect[3] &&
        i.rect[3] > cropRect[1] &&
        !source.includes(i)
    )
  )
    return
  return {
    cuts,
    groups,
    spans,
    scriptParents,
    baselineHeight: h,
    consumed: source,
    cropRect,
    repair: 'native-fenced-paired-literal-records-recovered'
  }
}

// Ordinary printed multiplier headings may have a separate touching sign.
// Independent complete decimal peers calibrate their right edges; the value
// of a multiplier is never parsed or used to establish its leaf.
export function recoverNativeAlignedLiteralLeafColumns(table, items, captions, rules, runs = []) {
  const common = recoverCommonFencedLeafGutter(table, items, captions, rules, runs)
  if (common) return common
  const frame = literalClosedFrame(table, items, captions, rules)
  if (!frame) return
  const { header, body, source, h, rect, edges, contained } = frame
  const columns = table.structure?.objects?.filter((o) => o.label === 'table column') ?? []
  if (
    columns.length < 3 ||
    columns.length >= 16 ||
    columns.some(
      (c) => !c.rect?.every(Number.isFinite) || c.rect[2] <= c.rect[0] || c.rect[3] <= c.rect[1]
    )
  )
    return
  if (
    header.some(
      (i) => Math.abs(i.baseline - header[0].baseline) >= 0.02 || Math.abs(i.height - h) >= 0.02
    )
  )
    return
  const heads = []
  for (const i of [...header].sort((a, b) => a.rect[0] - b.rect[0])) {
    const previous = heads.at(-1)
    if (previous && i.rect[0] - box(previous)[2] < 0.02) previous.push(i)
    else heads.push([i])
  }
  if (
    heads.length !== columns.length + 1 ||
    heads.some(
      (g) =>
        g.length > 2 ||
        (g.length === 2 && g[1].rect[0] < g[0].rect[2] - 0.02) ||
        (g.length === 1 && g[0].text === '×')
    ) ||
    !heads.some((g) => g.length === 2)
  )
    return
  if (source.some((i) => !literalProgramMatches(i, runs))) return
  const bounds = heads.map(box)
  const lane = (i) => {
    const head = heads.findIndex((g) => g.includes(i))
    if (head >= 0) return head
    if (i.rect[2] < bounds[1][0]) return 0
    if (i.rect[2] < bounds[2][0]) return 1
    const matching = bounds.flatMap((b, n) =>
      n >= 2 &&
      n < bounds.length - 1 &&
      Math.abs(b[2] - i.rect[2]) < 0.02 &&
      Math.abs(i.height - h) < 0.02 &&
      /^\d+\.\d+$/.test(i.text)
        ? [n]
        : []
    )
    if (matching.length === 1) return matching[0]
    if (i.rect[0] > bounds.at(-2)[2]) return bounds.length - 1
    return -1
  }
  if (source.some((i) => lane(i) < 0)) return
  const domains = heads.map((_, n) => box(source.filter((i) => lane(i) === n)))
  const gutters = domains.slice(1).map((b, n) => [domains[n][2], b[0]])
  if (gutters.some((g) => g[1] - g[0] <= h * 0.2)) return
  const cuts = [rect[0], ...gutters.map((g) => (g[0] + g[1]) / 2), rect[2]]
  if (source.some((i) => !contained([cuts[lane(i)], rect[1], cuts[lane(i) + 1], rect[3]], i)))
    return
  const keys = body.filter((i) => lane(i) >= 2 && lane(i) < heads.length - 1)
  const baselines = []
  for (const y of keys.map((i) => i.baseline).sort((a, b) => a - b))
    if (!baselines.some((v) => Math.abs(v - y) < 0.02)) baselines.push(y)
  const predictedRows = table.structure.objects.filter((o) => o.label === 'table row')
  if (
    baselines.length < 3 ||
    (predictedRows.length !== baselines.length && predictedRows.length !== baselines.length + 1) ||
    predictedRows.some(
      (r) => !r.rect?.every(Number.isFinite) || r.rect[2] <= r.rect[0] || r.rect[3] <= r.rect[1]
    )
  )
    return
  for (const y of baselines) {
    const peers = body.filter((i) => lane(i) > 0 && Math.abs(i.baseline - y) < h * 0.3)
    if (heads.slice(1).some((_, n) => !peers.some((i) => lane(i) === n + 1))) return
    if (heads.slice(2, -1).some((_, n) => peers.filter((i) => lane(i) === n + 2).length !== 1))
      return
    if (peers.some((i) => lane(i) > 1 && Math.abs(i.height - h) >= 0.02)) return
  }
  if (
    body.some(
      (i) => lane(i) > 0 && baselines.filter((y) => Math.abs(i.baseline - y) < h * 0.3).length !== 1
    )
  )
    return
  const partial = joinHorizontalTableRules(rules, 0.01, 0).filter(
    (r) =>
      r[1] > rect[1] &&
      r[1] < rect[3] &&
      r[0] < rect[2] &&
      r[2] > rect[0] &&
      !edges.some((e) => sameRect(e, r))
  )
  if (
    partial.some(
      (r) =>
        keys.filter(
          (i) =>
            Math.abs(i.rect[0] - r[0]) < 0.02 &&
            Math.abs(i.rect[2] - r[2]) < 0.02 &&
            r[1] > i.baseline &&
            r[1] - i.baseline < h * 0.3
        ).length !== 1
    )
  )
    return
  return { cuts }
}

// Independently printed headings constrain the corridor; all complete ruled
// records must agree on one measured glyph gap inside it. Do not select a
// convenient gap from a prefix of the records or parse a field's punctuation.
function recoverCommonFencedLeafGutter(table, items, captions, rules, runs) {
  const valid = (r) => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite)
  const crop = table.cropRect
  const columns = table.structure?.objects
    ?.filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (
    !valid(crop) ||
    crop[2] <= crop[0] ||
    crop[3] <= crop[1] ||
    table.readingRotation ||
    !columns ||
    columns.length < 3 ||
    columns.length > 12 ||
    columns.some((c) => !valid(c.rect) || c.rect[2] <= c.rect[0] || c.rect[3] <= c.rect[1]) ||
    !runs?.length ||
    rules.some((r) => !valid(r) || r[2] < r[0] || r[3] < r[1])
  )
    return
  const near = items.filter(
    (i) =>
      i.text?.trim() &&
      valid(i.rect) &&
      i.rect[0] < crop[2] &&
      i.rect[2] > crop[0] &&
      i.baseline > crop[1] &&
      i.baseline < crop[3]
  )
  const h = median(near.map((i) => i.height))
  if (
    !(h > 0) ||
    !Number.isFinite(h) ||
    !captions.some((c) => captionKind(c.lines?.[0]) === 'table')
  )
    return
  const edges = joinHorizontalTableRules(rules, 0.01, 0)
    .filter(
      (r) =>
        Math.abs(r[0] - crop[0]) < h &&
        Math.abs(r[2] - crop[2]) < h &&
        r[1] > crop[1] &&
        r[1] < crop[3] + h
    )
    .sort((a, b) => a[1] - b[1])
  if (
    edges.length < 4 ||
    edges.some(
      (r, n) =>
        Math.abs(r[0] - edges[0][0]) > 0.02 ||
        Math.abs(r[2] - edges[0][2]) > 0.02 ||
        (n && r[1] - edges[n - 1][1] < h)
    )
  )
    return
  const source = items.filter(
    (i) =>
      i.text?.trim() &&
      valid(i.rect) &&
      i.rect[0] < edges[0][2] &&
      i.rect[2] > edges[0][0] &&
      i.rect[3] > crop[1] - h &&
      i.rect[1] < edges.at(-1)[1] &&
      !(
        i.baseline > edges.at(-1)[1] &&
        captions.filter(
          (c) =>
            c.lines?.length === 1 &&
            c.lines[0] === i.text &&
            sameRect(c.rect, i.rect) &&
            captionKind(c.lines[0]) === 'table'
        ).length === 1
      )
  )
  if (
    !source.length ||
    source.some(
      (i) =>
        !i.horizontal ||
        i.rect[2] <= i.rect[0] ||
        i.rect[3] <= i.rect[1] ||
        !Number.isFinite(i.baseline) ||
        !Number.isFinite(i.height) ||
        Math.abs(i.height - h) > 0.02 ||
        Math.abs(i.rect[3] - i.baseline) > 0.02 ||
        Math.abs(i.rect[3] - i.rect[1] - h) > 0.02 ||
        i.rect[0] < edges[0][0] ||
        i.rect[2] > edges[0][2] ||
        i.rect[1] < crop[1] - h ||
        i.rect[3] > edges.at(-1)[1] ||
        edges.some((r) => i.rect[1] < r[1] && i.rect[3] > r[1]) ||
        !literalProgramMatches(i, runs)
    )
  )
    return
  const header = source.filter((i) => i.rect[3] < edges[0][1]).sort((a, b) => a.rect[0] - b.rect[0])
  if (
    header.length !== columns.length + 1 ||
    header.some(
      (i, n) =>
        !i.text.trim() ||
        Math.abs(i.baseline - header[0].baseline) > 0.02 ||
        (n && i.rect[0] - header[n - 1].rect[2] < h * 0.2)
    )
  )
    return
  const cuts = [
    crop[0],
    ...columns.slice(1).map((c, n) => crop[0] + (columns[n].rect[2] + c.rect[0]) / 2),
    crop[2]
  ]
  if (cuts.some((x, n) => !Number.isFinite(x) || (n && x <= cuts[n - 1]))) return
  const headLanes = columns.map((_, c) =>
    header.filter(
      (i) => (i.rect[0] + i.rect[2]) / 2 > cuts[c] && (i.rect[0] + i.rect[2]) / 2 < cuts[c + 1]
    )
  )
  const merged = headLanes.flatMap((g, n) => (g.length === 2 ? [n] : []))
  if (merged.length !== 1 || headLanes.some((g) => g.length !== 1 && g.length !== 2)) return
  const lane = merged[0],
    pair = headLanes[lane],
    corridor = [pair[0].rect[2], pair[1].rect[0]]
  if (
    lane === 0 ||
    lane === columns.length - 1 ||
    corridor[0] <= cuts[lane] ||
    corridor[1] >= cuts[lane + 1]
  )
    return
  const records = edges
    .slice(1)
    .map((r, n) =>
      source
        .filter((i) => i.rect[1] > edges[n][1] && i.rect[3] < r[1])
        .sort((a, b) => a.rect[0] - b.rect[0])
    )
  if (
    records.some(
      (g) =>
        !g.length ||
        g.some((i) => Math.abs(i.baseline - g[0].baseline) > 0.02) ||
        columns.some(
          (_, c) =>
            !g.some(
              (i) =>
                (i.rect[0] + i.rect[2]) / 2 > cuts[c] && (i.rect[0] + i.rect[2]) / 2 < cuts[c + 1]
            )
        )
    ) ||
    header.length + records.flat().length !== source.length
  )
    return
  let common = [corridor]
  for (const record of records) {
    const spaces = []
    for (let n = 1; n < record.length; n++)
      if (record[n].rect[0] > record[n - 1].rect[2])
        spaces.push([record[n - 1].rect[2], record[n].rect[0]])
    for (const item of record) {
      const run = runs.find((r) => r.text === item.text && sameRect(r.rect, item.rect))
      if (!run) return
      const glyphs = [...item.text.replace(/\s/gu, '')]
      if (
        !Array.isArray(run.gaps) ||
        !Array.isArray(run.glyphRuns) ||
        run.glyphRuns.length !== glyphs.length ||
        run.glyphRuns.some((n) => !Number.isInteger(n)) ||
        new Set(run.gaps.map((g) => g.index)).size !== run.gaps.length ||
        run.gaps.some(
          (g) =>
            !Number.isInteger(g.index) ||
            g.index <= 0 ||
            g.index >= glyphs.length ||
            !Number.isFinite(g.left) ||
            !Number.isFinite(g.right) ||
            g.left >= g.right ||
            g.left < item.rect[0] ||
            g.right > item.rect[2]
        )
      )
        return
      const orderedGaps = [...run.gaps].sort((a, b) => a.index - b.index)
      if (orderedGaps.some((g, n) => n && g.left < orderedGaps[n - 1].right)) return
      for (const gap of run.gaps) {
        if (run.glyphRuns[gap.index - 1] !== run.glyphRuns[gap.index]) continue
        spaces.push([gap.left, gap.right])
      }
    }
    common = common.flatMap((a) =>
      spaces.map((b) => [Math.max(a[0], b[0]), Math.min(a[1], b[1])]).filter((b) => b[1] > b[0])
    )
    common = common.filter(
      (a, n) =>
        !common
          .slice(0, n)
          .some((b) => Math.abs(a[0] - b[0]) < 0.002 && Math.abs(a[1] - b[1]) < 0.002)
    )
    if (!common.length) return
  }
  if (common.length !== 1 || common[0][1] - common[0][0] < h * 0.15) return
  if (
    rules.some(
      (r) =>
        r[0] === r[2] &&
        r[0] > corridor[0] &&
        r[0] < corridor[1] &&
        r[3] > edges[0][1] &&
        r[1] < edges.at(-1)[1] &&
        (r[0] < common[0][0] || r[0] > common[0][1])
    )
  )
    return
  const x = (common[0][0] + common[0][1]) / 2
  for (const record of records) {
    if (!record.some((i) => i.rect[0] < x) || !record.some((i) => i.rect[2] > x)) return
    for (const item of record.filter((i) => i.rect[0] < x && i.rect[2] > x)) {
      const run = runs.find((r) => r.text === item.text && sameRect(r.rect, item.rect))
      if (!run) return
      const gaps = run.gaps.filter((g) => g.left < x && g.right > x)
      if (gaps.length !== 1 || !splitObserved(item, runs, [[gaps[0].left, gaps[0].right]], h))
        return
    }
  }
  return { cuts: [...cuts.slice(0, lane + 1), x, ...cuts.slice(lane + 1)] }
}

// A rowless detector can still own one complete ordinary record. This is a
// separate proof, not a lowered minimum for the multi-record/native-math path.
export function recoverNativeClosedSingleRecord(table, items, captions, rules, runs = []) {
  if (table.rowCount || table.structure?.objects?.some((o) => o.label === 'table row')) return
  const frame = literalClosedFrame(table, items, captions, rules)
  if (!frame || frame.edges.length !== 3) return
  const { header, body, source, h, rect, contained } = frame
  if (header.length < 3 || header.length > 16 || body.length !== header.length) return
  const head = [...header].sort((a, b) => a.rect[0] - b.rect[0]),
    peer = [...body].sort((a, b) => a.rect[0] - b.rect[0])
  if (
    head.some(
      (i) => Math.abs(i.baseline - head[0].baseline) >= 0.02 || Math.abs(i.height - h) >= 0.02
    ) ||
    peer.some(
      (i, n) =>
        Math.abs(i.baseline - peer[0].baseline) >= 0.02 ||
        Math.abs(i.height - h) >= 0.02 ||
        Math.abs(i.rect[0] - head[n].rect[0]) >= 0.02 ||
        !/^[+−-]?\d+(?:\.\d+)?$/.test(i.text)
    )
  )
    return
  if (source.some((i) => !literalProgramMatches(i, runs))) return
  const domains = head.map((i, n) => box([i, peer[n]])),
    gutters = domains.slice(1).map((b, n) => [domains[n][2], b[0]])
  if (gutters.some((g) => g[1] - g[0] <= h * 0.3)) return
  const cuts = [rect[0], ...gutters.map((g) => (g[0] + g[1]) / 2), rect[2]]
  if (
    [head, peer].some((g) =>
      g.some((i, n) => !contained([cuts[n], rect[1], cuts[n + 1], rect[3]], i))
    )
  )
    return
  const cropRect = [
    rect[0] - 2,
    rect[1] - 2,
    Math.max(rect[2], ...source.map((i) => i.rect[2])) + 2,
    rect[3] + 2
  ]
  if (
    items.some(
      (i) =>
        i.text.trim() &&
        !source.includes(i) &&
        i.rect[0] < cropRect[2] &&
        i.rect[2] > cropRect[0] &&
        i.rect[1] < cropRect[3] &&
        i.rect[3] > cropRect[1]
    )
  )
    return
  return {
    cuts,
    groups: [head, peer],
    consumed: source,
    cropRect,
    closedSingleRecord: true,
    repair: 'native-closed-single-literal-record-recovered'
  }
}

// Retain opaque, already correct rich cells. Only a fully fenced stub donor
// partition with its own literal small-caps/ordinary label may change span.
export function proveNativeFencedCompositeStubOwners(table, items, captions, rules) {
  const frame = literalClosedFrame(table, items, captions, rules)
  const { cells, grid } = table
  if (!frame || !cells?.length || !grid?.length || table.unassigned?.length) return
  const { body, h, contained } = frame,
    count = grid[0].length
  const same = (a, b) =>
    a.text === b.text &&
    sameRect(a.rect, b.rect) &&
    Math.abs(a.baseline - b.baseline) < 0.02 &&
    Math.abs(a.height - b.height) < 0.02
  const mapped = new Map(),
    seen = new Set()
  for (const cell of cells.filter((c) => c.row > 0)) {
    const tokens = cell.sourceTokens ?? [],
      rects = cell.sourceRects ?? []
    if (
      tokens.length !== rects.length ||
      tokens.some((t) => rects.filter((r) => sameRect(t.rect, r)).length !== 1) ||
      rects.some((r) => tokens.filter((t) => sameRect(t.rect, r)).length !== 1)
    )
      return
    const native = tokens.map((t) => body.filter((i) => same(t, i)))
    if (native.some((g) => g.length !== 1)) return
    const owned = native.flat()
    if (owned.some((i) => seen.has(i))) return
    owned.forEach((i) => seen.add(i))
    mapped.set(cell, owned)
  }
  if (seen.size !== body.length) return
  const anchors = cells.filter((c) => c.row > 0 && c.column === 1).sort((a, b) => a.row - b.row)
  if (
    anchors.length !== grid.length - 1 ||
    anchors.some((c, n) => {
      const ordinary = (mapped.get(c) ?? []).filter((i) => Math.abs(i.height - h) < 0.02)
      return (
        c.row !== n + 1 ||
        c.rowSpan !== 1 ||
        c.colSpan !== 1 ||
        !ordinary.length ||
        ordinary.some((i) => Math.abs(i.baseline - ordinary[0].baseline) >= 0.02)
      )
    })
  )
    return
  const replacements = []
  let calibrated = false
  for (let n = 1; n < frame.edges.length - 1; n++) {
    const top = frame.edges[n][1],
      bottom = frame.edges[n + 1][1]
    const group = anchors.filter((c) =>
      mapped.get(c).every((i) => i.rect[1] > top && i.rect[3] < bottom)
    )
    if (group.length < 2 || group.some((c, k) => c.row !== group[0].row + k)) return
    const row = group[0].row,
      rowSpan = group.length
    const donors = cells.filter((c) => c.column === 0 && c.row >= row && c.row < row + rowSpan)
    const coverage = donors.flatMap((c) => Array.from({ length: c.rowSpan }, (_, k) => c.row + k))
    if (
      coverage.length !== rowSpan ||
      new Set(coverage).size !== rowSpan ||
      coverage.some((r) => r < row || r >= row + rowSpan) ||
      donors.some((c) => c.colSpan !== 1)
    )
      return
    const label = donors.flatMap((c) => mapped.get(c)),
      union = box(donors)
    if (
      !label.length ||
      label.some((i) => i.rect[1] <= top || i.rect[3] >= bottom || !contained(union, i))
    )
      return
    const peers = group.flatMap((a) =>
      Array.from({ length: count - 1 }, (_, k) =>
        cells.filter((c) => c.row === a.row && c.column === k + 1)
      ).flat()
    )
    if (
      peers.length !== group.length * (count - 1) ||
      peers.some((c) => {
        const key = anchors.find((a) => a.row === c.row),
          baseline = mapped.get(key).find((i) => Math.abs(i.height - h) < 0.02).baseline
        return (
          c.rowSpan !== 1 ||
          c.colSpan !== 1 ||
          !mapped.get(c)?.length ||
          mapped
            .get(c)
            .some(
              (i) =>
                i.rect[1] <= top ||
                i.rect[3] >= bottom ||
                (Math.abs(i.height - h) < 0.02 && Math.abs(i.baseline - baseline) >= h * 0.3)
            )
        )
      })
    )
      return
    const printed = donors.filter((c) => c.text.trim())
    if (printed.length !== 1) return
    label.sort((a, b) => a.rect[0] - b.rect[0])
    const boundedLiteral =
      !donors.some((c) => c.textRuns?.some((r) => r.position !== 'normal')) &&
      ((label.length === 1 &&
        Math.abs(label[0].height - h) < 0.02 &&
        printed[0].text === label[0].text) ||
        (label.length === 2 &&
          Math.abs(label[0].baseline - label[1].baseline) < 0.02 &&
          Math.abs(label[0].height - h) < 0.02 &&
          Math.abs(label[1].height - label[0].height * 0.8) < 0.02 &&
          label[1].rect[0] > label[0].rect[2] &&
          label[1].rect[0] - label[0].rect[2] < h * 0.1 &&
          printed[0].text === label.map((i) => i.text).join('')))
    const bodyStart = Math.min(...peers.flatMap((c) => mapped.get(c)).map((i) => i.rect[0]))
    if (label.some((i) => i.rect[2] >= bodyStart) || donors.some((c) => c.rect[2] >= bodyStart))
      return
    // A native fence can enclose deliberate blank stub records. Calibrate
    // group ownership only against an existing complete, correctly owned
    // literal label after the same font/source/record/gutter proof. Other
    // already correct rich labels stay opaque and cannot supply calibration.
    if (donors.length === 1 && donors[0].row === row && donors[0].rowSpan === rowSpan) {
      if (boundedLiteral) calibrated = true
      continue
    }
    if (!boundedLiteral) return
    replacements.push({ row, rowSpan, donors, rect: union, original: printed[0] })
  }
  if (!calibrated || !replacements.length) return
  return { replacements }
}

function nativeCellPartitionComplete(cells, source, groups, lane, count) {
  if (!cells.length) return false
  const memberships = new Map(
      source.map((i) => [i, groups.findIndex((g) => g.includes(i)) + ':' + lane(i)])
    ),
    found = new Set(),
    partitions = new Set()
  for (const cell of cells) {
    const owned = (cell.sourceTokens ?? []).flatMap((t) =>
        source.filter((i) => i.text === t.text && sameRect(i.rect, t.rect))
      ),
      targets = new Set(owned.map((i) => memberships.get(i)))
    if (targets.size > 1) return false
    if (targets.size === 1) {
      const target = [...targets][0]
      if (partitions.has(target)) return false
      partitions.add(target)
    }
    for (const i of owned) {
      if (found.has(i)) return false
      found.add(i)
    }
  }
  return found.size === source.length && partitions.size === groups.length * count
}

function nativeHeaderFrame(
  table,
  items,
  rules,
  cornerTolerance = 0,
  fontHeight,
  minimumHeaderItems = 3
) {
  const crop = table.cropRect
  const nearby = items.filter(
    (i) =>
      i.horizontal &&
      i.text.trim() &&
      i.rect[0] >= crop[0] - 25 &&
      i.rect[2] <= crop[2] + 25 &&
      i.baseline >= crop[1] &&
      i.baseline <= crop[3]
  )
  const h = fontHeight ?? median(nearby.map((i) => i.height).filter((v) => v > 0))
  if (!(h > 0)) return
  const edges = joinHorizontalTableRules(rules, 0.01, cornerTolerance)
    .filter(
      (r) =>
        Math.abs(r[0] - crop[0]) < h * 2 &&
        Math.abs(r[2] - crop[2]) < h * 2 &&
        r[1] >= crop[1] - h &&
        r[1] <= crop[3] + h
    )
    .sort((a, b) => a[1] - b[1])
  if (edges.length < 3) return
  const opening = edges[0],
    closing = edges.at(-1)
  if (edges.some((r) => Math.abs(r[0] - opening[0]) > 0.7 || Math.abs(r[2] - opening[2]) > 0.7))
    return
  const divider = edges.find((r) => r[1] - opening[1] > h * 0.5)
  if (!divider || divider === closing || divider[1] - opening[1] > h * 5) return
  // Removing the actual footer must not let an internal separator silently
  // discard the remaining detector-owned physical record.
  if (
    items.some(
      (i) =>
        i.horizontal &&
        i.text.trim() &&
        i.rect[0] >= opening[0] - h * 0.2 &&
        i.rect[2] <= opening[2] + h * 0.2 &&
        i.rect[1] > closing[1] &&
        i.baseline <= crop[3]
    )
  )
    return
  const source = items.filter(
    (i) =>
      i.horizontal &&
      i.text.trim() &&
      i.rect[0] >= opening[0] - h * 0.2 &&
      i.rect[2] <= opening[2] + h * 0.2 &&
      i.baseline > opening[1] &&
      i.baseline < closing[1]
  )
  const header = source.filter((i) => i.baseline <= divider[1]),
    body = source.filter((i) => i.baseline > divider[1])
  if (header.length < minimumHeaderItems || body.length < 6) return
  return { h, opening, divider, closing, source, header, body }
}

// A literal TJ gap is a glyph boundary, not a character-width estimate. Keep
// spaces inside a transition tuple or a thousands-grouped number unchanged.
function splitObserved(item, runs, gutters, h) {
  const matches = runs.filter((r) => r.text === item.text && sameRect(r.rect, item.rect))
  if (
    matches.length !== 1 ||
    !matches[0].glyphRuns?.length ||
    new Set(matches[0].glyphRuns).size !== 1 ||
    matches[0].literalGlyphs.join('') !== item.text.replace(/\s/gu, '')
  )
    return
  const gaps = []
  for (const gutter of gutters) {
    if (item.rect[0] >= gutter[1] || item.rect[2] <= gutter[0]) continue
    const selected = matches[0].gaps.filter(
      (g) =>
        g.left >= gutter[0] - 0.02 &&
        g.right <= gutter[1] + 0.02 &&
        g.right - g.left >= h * 0.15 &&
        (gutter[2] === undefined ||
          (gutter[2] >= g.left - h * 0.1 && gutter[2] <= g.right + h * 0.1))
    )
    if (selected.length === 1) gaps.push(selected[0])
  }
  gaps.sort((a, b) => a.index - b.index)
  if (!gaps.length || new Set(gaps.map((g) => g.index)).size !== gaps.length) return
  const characters = [...item.text],
    parts = []
  let start = 0,
    count = 0
  for (let n = 0; n < characters.length; n++) {
    if (/\s/u.test(characters[n])) continue
    if (gaps.some((g) => g.index === count)) {
      parts.push(characters.slice(start, n).join('').trim())
      start = n
    }
    count++
  }
  parts.push(characters.slice(start).join('').trim())
  if (parts.length !== gaps.length + 1 || parts.some((p) => !p)) return
  return parts.map((text, n) => ({
    ...item,
    text,
    sourceToken: item.sourceToken ?? item,
    nativeLaneSplit: true,
    rect: [
      n ? gaps[n - 1].right : item.rect[0],
      item.rect[1],
      n < gaps.length ? gaps[n].left : item.rect[2],
      item.rect[3]
    ]
  }))
}

export function recoverNativePrintedLaneTokens(table, items, captions, rules, runs = []) {
  if (!runs.length) return items
  const common = recoverCommonFencedLeafGutter(table, items, captions, rules, runs)
  if (common) {
    const columns = table.structure.objects
      .filter((o) => o.label === 'table column')
      .sort((a, b) => a.rect[0] - b.rect[0])
    const oldCuts = [
      table.cropRect[0],
      ...columns.slice(1).map((c, n) => table.cropRect[0] + (columns[n].rect[2] + c.rect[0]) / 2),
      table.cropRect[2]
    ]
    const x = common.cuts.find((c) => !oldCuts.includes(c))
    const replacements = new Map()
    for (const item of items) {
      if (!(
        item.baseline > table.cropRect[1] &&
        item.baseline < table.cropRect[3] &&
        item.rect[0] < x &&
        item.rect[2] > x
      ))
        continue
      const observed = runs.filter((r) => r.text === item.text && sameRect(r.rect, item.rect))
      const gaps =
        observed.length === 1 ? observed[0].gaps.filter((g) => g.left < x && g.right > x) : []
      if (gaps.length !== 1) return items
      const parts = splitObserved(item, runs, [[gaps[0].left, gaps[0].right]], item.height)
      if (!parts || parts.length !== 2) return items
      replacements.set(item, parts)
    }
    if (replacements.size) return items.flatMap((i) => replacements.get(i) ?? [i])
  }
  const frame = nativeHeaderFrame(table, items, rules)
  if (!frame) return items
  const { h, opening, closing, header, body } = frame
  const columns = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (
    columns.length < 3 ||
    columns.length > 16 ||
    !captions.some(
      (c) =>
        captionKind(c.lines[0]) === 'table' &&
        c.rect[0] < opening[2] &&
        c.rect[2] > opening[0] &&
        ((c.rect[3] <= opening[1] && opening[1] - c.rect[3] < h * 5) ||
          (c.rect[1] >= closing[1] && c.rect[1] - closing[1] < h * 5))
    )
  )
    return items
  const cuts = [
    opening[0],
    ...columns.slice(1).map((c, n) => table.cropRect[0] + (columns[n].rect[2] + c.rect[0]) / 2),
    opening[2]
  ]
  const heads = columns.map(() => [])
  for (const i of header) {
    const c = cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
    if (c >= 0) heads[c].push(i)
  }
  if (heads.some((g) => !g.length || !g.some((i) => /\p{L}/u.test(i.text)))) return items
  const gutters = heads
    .slice(1)
    .map((g, n) => [
      Math.max(...heads[n].map((i) => i.rect[2])),
      Math.min(...g.map((i) => i.rect[0])),
      cuts[n + 1]
    ])
  const allowed = gutters.filter(
    (g, n) => g[1] - g[0] >= h * 0.25 && cuts[n + 1] >= g[0] && cuts[n + 1] <= g[1]
  )
  if (!allowed.length) return items
  const records = physicalRows(
    body.filter((i) => i.height >= h * 0.85),
    h
  )
  if (records.length < 3) return items
  const replacements = new Map()
  for (const item of body) {
    if (!/[0-9]/u.test(item.text) || !/\s/u.test(item.text)) continue
    const parts = splitObserved(item, runs, allowed, h)
    if (!parts) continue
    // Every side must independently fit an existing printed lane. Literal
    // numeric fields may include scientific symbols; arbitrary prose is not
    // a scalar witness. One initial descriptive stub is allowed.
    if (
      parts.some(
        (p, n) =>
          n > 0 &&
          !/^[0-9−+<>≤≥.,()[\]*/×–—\s-]+$/u.test(p.text) &&
          !(
            n === parts.length - 1 &&
            /^[A-Z][A-Za-z]{0,7}$/u.test(p.text) &&
            p.rect[0] >= cuts.at(-2) - h * 0.1
          )
      )
    )
      continue
    if (
      parts.some(
        (p) =>
          !cuts.slice(1).some((r, c) => p.rect[0] >= cuts[c] - h * 0.1 && p.rect[2] <= r + h * 0.1)
      )
    )
      continue
    replacements.set(item, parts)
  }
  if (!replacements.size) return items
  for (const gutter of allowed) {
    const crossing = [...replacements].filter(([, parts]) =>
      parts.some(
        (p, n) =>
          n + 1 < parts.length &&
          p.rect[2] >= gutter[0] - 0.02 &&
          parts[n + 1].rect[0] <= gutter[1] + 0.02
      )
    )
    const peers = body.filter(
      (i) =>
        !replacements.has(i) &&
        /^[−+]?(?:\d+(?:\.\d+)?|\d{1,3}(?: \d{3})+(?:\.\d+)?)$/u.test(i.text) &&
        (Math.abs(i.rect[0] - gutter[1]) < h || Math.abs(i.rect[2] - gutter[0]) < h)
    )
    if (
      crossing.length &&
      new Set([...crossing.map(([i]) => i.baseline), ...peers.map((i) => i.baseline)]).size < 3
    )
      return items
  }
  return items.flatMap((i) => replacements.get(i) ?? [i])
}

const joined = (items) =>
  [...items]
    .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
    .map((i, n, all) =>
      n && i.rect[0] - all[n - 1].rect[2] > i.height * 0.12 ? ' ' + i.text : i.text
    )
    .join('')
    .trim()

function headerLeaves(group, h) {
  const leaves = []
  for (const i of [...group].sort((a, b) => a.rect[0] - b.rect[0])) {
    const prior = leaves.at(-1)
    if (prior && i.rect[0] - box(prior)[2] < h * 0.3) prior.push(i)
    else leaves.push([i])
  }
  return leaves
}

// These two finite literal shapes need independent body/header proof before
// changing an observed run or admitting a wider native rule. Neither relaxes
// the ordinary frame's raw-header or complete-peer requirements.
export function recoverNativeObservedLiteralHeaderRecords(
  table,
  items,
  captions,
  rules,
  runs = []
) {
  const crop = table.cropRect,
    nearby = items.filter(
      (i) =>
        i.horizontal &&
        i.text.trim() &&
        i.baseline >= crop[1] &&
        i.baseline <= crop[3] &&
        i.rect[0] > crop[0] - 25 &&
        i.rect[2] < crop[2] + 25
    ),
    h = median(nearby.map((i) => i.height).filter((v) => v > 0))
  if (!(h > 0)) return
  const edges = joinHorizontalTableRules(rules, 0.01, 0)
    .filter(
      (r) =>
        r[1] >= crop[1] - h &&
        r[1] <= crop[3] + h &&
        Math.abs(r[0] - crop[0]) < h * 2 &&
        r[2] > crop[2] - h * 2
    )
    .sort((a, b) => a[1] - b[1])
  if (
    edges.length !== 3 ||
    edges.some((r) => Math.abs(r[0] - edges[0][0]) >= 0.02 || Math.abs(r[2] - edges[0][2]) >= 0.02)
  )
    return
  const [opening, divider, closing] = edges,
    titles = captions.filter(
      (c) =>
        captionKind(c.lines?.[0]) === 'table' &&
        c.rect[0] < opening[2] &&
        c.rect[2] > opening[0] &&
        c.rect[3] <= opening[1] &&
        opening[1] - c.rect[3] < h * 5
    )
  if (titles.length !== 1 || divider[1] - opening[1] <= h || closing[1] - divider[1] <= h) return
  const source = items.filter(
    (i) =>
      i.horizontal &&
      i.text.trim() &&
      i.rect[3] > opening[1] &&
      i.rect[1] < closing[1] &&
      i.rect[2] > opening[0] &&
      i.rect[0] < opening[2]
  )
  if (
    !source.length ||
    source.some(
      (i) =>
        !i.rect.every(Number.isFinite) ||
        i.rect[0] < opening[0] - 0.02 ||
        i.rect[2] > opening[2] + 0.02 ||
        i.rect[1] < opening[1] ||
        i.baseline > closing[1] ||
        i.height < h * 0.85 ||
        i.height > h * 1.15
    ) ||
    new Set(source.map((i) => i.text + ':' + i.rect.join(':'))).size !== source.length ||
    items.some(
      (i) =>
        i.horizontal &&
        i.text.trim() &&
        i.rect[0] >= opening[0] &&
        i.rect[2] <= opening[2] &&
        i.rect[1] > closing[1] &&
        i.baseline <= crop[3]
    )
  )
    return
  const header = source.filter((i) => i.baseline < divider[1]),
    body = source.filter((i) => i.baseline > divider[1]),
    bands = physicalRows(header, h),
    records = physicalRows(body, h)
  if (header.length + body.length !== source.length) return
  const joint =
      bands.length === 1 && header.length === 2 && records.length >= 3 && records.length <= 40,
    wrapped = bands.length === 2 && records.length === 2
  if (!joint && !wrapped) return
  if (joint && Math.abs(opening[2] - crop[2]) >= h * 2) return
  // A two-record exception requires the true title width and every source ink
  // item already inside the detector; only the rule's blank tail may extend.
  if (
    wrapped &&
    (Math.abs(titles[0].rect[0] - opening[0]) > 0.5 ||
      Math.abs(titles[0].rect[2] - opening[2]) > 0.5 ||
      source.some((i) => i.rect[0] < crop[0] || i.rect[2] > crop[2]))
  )
    return
  const count = joint ? 3 : 4,
    fields = records.map((g) => headerLeaves(g, h))
  if (
    fields.some((r) => r.length !== count || r.some((g) => physicalRows(g, h).length !== 1)) ||
    fields.some((r) => r.slice(0, 2).some((g) => !/\p{L}/u.test(joined(g))))
  )
    return
  const domains = Array.from({ length: count }, (_, c) => box(fields.flatMap((r) => r[c]))),
    gutters = domains.slice(1).map((d, c) => [domains[c][2], d[0]])
  if (gutters.some((g) => g[1] - g[0] < h * 0.3)) return
  let preciseHeader = header,
    headings
  if (joint) {
    const first = [...header].sort((a, b) => a.rect[0] - b.rect[0])[0],
      observed = runs.filter((r) => r.text === first.text && sameRect(r.rect, first.rect))
    if (observed.length !== 1 || observed[0].gaps.length !== 1) return
    const parts = splitObserved(first, runs, [gutters[0]], h)
    if (!parts || parts.length !== 2 || parts.some((i) => !/\p{L}/u.test(i.text))) return
    preciseHeader = header.flatMap((i) => (i === first ? parts : [i]))
    headings = headerLeaves(preciseHeader, h)
  } else {
    const upper = headerLeaves(bands[0], h),
      lower = headerLeaves(bands[1], h)
    if (
      upper.length !== 4 ||
      lower.length !== 2 ||
      upper.some((g) => !/\p{L}/u.test(joined(g))) ||
      bands[1][0].baseline - bands[0][0].baseline < h ||
      bands[1][0].baseline - bands[0][0].baseline > h * 1.5
    )
      return
    headings = upper.map((g) => [...g])
    for (const g of lower) {
      const bounds = box(g),
        center = (bounds[0] + bounds[2]) / 2,
        targets = upper
          .map((head, c) => ({ c, bounds: box(head) }))
          .filter(({ bounds }) => Math.abs((bounds[0] + bounds[2]) / 2 - center) < h * 0.02)
      if (targets.length !== 1 || targets[0].c < 2) return
      headings[targets[0].c].push(...g)
    }
    if (headings.slice(2).some((g) => physicalRows(g, h).length !== 2)) return
  }
  if (headings.length !== count) return
  const full = domains.map((_, c) => box([...headings[c], ...fields.flatMap((r) => r[c])]))
  if (full.slice(1).some((d, c) => d[0] - full[c][2] < h * 0.2)) return
  const cuts = [opening[0], ...full.slice(1).map((d, c) => (full[c][2] + d[0]) / 2), opening[2]],
    groups = [headings.flat(), ...fields.map((r) => r.flat())],
    originalHeads = new Set(preciseHeader.map((i) => i.sourceToken ?? i))
  if (
    groups.some((g) =>
      g.some((i) => !cuts.slice(1).some((x, c) => i.rect[0] >= cuts[c] && i.rect[2] <= x))
    ) ||
    fields.flat(2).length !== body.length ||
    new Set(fields.flat(2)).size !== body.length ||
    originalHeads.size !== header.length ||
    [...originalHeads].some((i) => !header.includes(i))
  )
    return
  const cropRect = [
    joint ? Math.max(crop[0], opening[0] - 2) : Math.min(crop[0], opening[0] - 0.5),
    crop[1],
    joint ? Math.min(crop[2], opening[2] + 2) : Math.max(crop[2], opening[2] + 0.5),
    Math.min(crop[3], closing[1] + 0.5)
  ]
  if (
    source.some(
      (i) =>
        i.rect[0] < cropRect[0] ||
        i.rect[1] < cropRect[1] ||
        i.rect[2] > cropRect[2] ||
        i.rect[3] > cropRect[3]
    )
  )
    return
  return {
    cuts,
    groups,
    headerRows: 1,
    baselineHeight: h,
    consumed: [...source, ...preciseHeader],
    repair: 'native-observed-literal-header-records-recovered',
    cropRect
  }
}

// A rowless structure object cannot bound its missing header. Use only the
// detector-owned closed native frame, independent leaf gutters and complete
// repeated literal measurements; confidence or prose layout alone is not proof.
export function recoverNativeRowlessPrintedPlan(table, items, captions, rules) {
  if (table.structure.objects.some((o) => o.label === 'table row')) return
  const frame = nativeHeaderFrame(table, items, rules)
  if (!frame) return
  const { h, opening, closing, header, body, source } = frame
  if (
    opening[0] < table.cropRect[0] - 0.02 ||
    opening[2] > table.cropRect[2] + 0.02 ||
    opening[1] < table.cropRect[1] ||
    closing[1] > table.cropRect[3] ||
    new Set(source.map((i) => i.text + '|' + i.rect.join(','))).size !== source.length
  )
    return
  const owners = captions.filter(
    (c) =>
      captionKind(c.lines[0]) === 'table' &&
      c.rect[3] <= opening[1] &&
      opening[1] - c.rect[3] <= h * 5 &&
      (Math.min(opening[2], c.rect[2]) - Math.max(opening[0], c.rect[0]) >
        (opening[2] - opening[0]) * 0.7 ||
        (c.rect[0] >= opening[0] &&
          c.rect[2] <= opening[2] &&
          Math.abs(c.rect[0] + c.rect[2] - opening[0] - opening[2]) < h * 0.2))
  )
  if (owners.length !== 1 || body.some((i) => i.height < h * 0.85)) return
  const records = physicalRows(body, h)
  if (records.length < 2 || records.length > 50) return
  const fragments = (row) => {
    const groups = []
    for (const i of [...row].sort((a, b) => a.rect[0] - b.rect[0])) {
      const prior = groups.at(-1)
      if (prior && i.rect[0] - box(prior)[2] <= h * 0.6) prior.push(i)
      else groups.push([i])
    }
    return groups
  }
  const peers = records.map(fragments),
    complete = peers.find((g) => g.length === Math.max(...peers.map((g) => g.length)))
  const count = complete.length
  if (count < 3 || count > 16) return
  const initial = [
    opening[0],
    ...complete.slice(1).map((g, c) => (box(complete[c])[2] + box(g)[0]) / 2),
    opening[2]
  ]
  const lane = (i) => initial.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const headings = initial.slice(1).map(() => []),
    fields = initial.slice(1).map(() => [])
  for (const group of fragments(header)) {
    const c = lane({ rect: box(group) })
    if (c < 0) return
    headings[c].push(...group)
  }
  // A genuinely blank first heading needs the independently printed stub in
  // every record. Other unlabeled gaps cannot become invented leaf columns.
  if (
    headings.slice(1).some((g) => !g.length || !/\p{L}/u.test(joined(g))) ||
    (headings[0].length && !/\p{L}/u.test(joined(headings[0])))
  )
    return
  const assigned = peers.map((g) => {
    const row = initial.slice(1).map(() => [])
    for (const group of g) {
      const c = lane({ rect: box(group) })
      if (c < 0 || row[c].length) return
      row[c].push(...group)
      fields[c].push(...group)
    }
    return row
  })
  if (assigned.some((row) => !row) || fields.some((g) => !g.length)) return
  const measurement = (g) =>
    /^[−+<>≤≥]?\d[\d\s.,()[\]±%−+–/]*$/u.test(joined(g)) ||
    /^[−+]?\d+(?:\.\d+)?\s+to\s+[−+]?\d+(?:\.\d+)?$/u.test(joined(g))
  let stubCount = 0
  while (
    stubCount < count &&
    assigned.some((r) => r[stubCount].length && !measurement(r[stubCount]))
  )
    stubCount++
  if (
    stubCount < 1 ||
    stubCount > 2 ||
    count - stubCount < 2 ||
    assigned.some(
      (row) =>
        !row[0].some((i) => /\p{L}/u.test(i.text)) ||
        row.slice(stubCount).some((g) => !g.length || !measurement(g))
    )
  )
    return
  const cuts = [opening[0]]
  for (let c = 1; c < count; c++) {
    const a = Math.max(...[...fields[c - 1], ...headings[c - 1]].map((i) => i.rect[2])),
      b = Math.min(...[...fields[c], ...headings[c]].map((i) => i.rect[0]))
    if (b - a < h * 0.2) return
    cuts.push((a + b) / 2)
  }
  cuts.push(opening[2])
  for (const groups of [headings, ...assigned])
    if (
      groups.some((g, c) =>
        g.some((i) => i.rect[0] < cuts[c] - 0.02 || i.rect[2] > cuts[c + 1] + 0.02)
      )
    )
      return
  const all = [header, ...records]
  if (new Set(all.flat()).size !== source.length || all.flat().length !== source.length) return
  // A clipped source run or a second paragraph inside the detector's frame
  // cannot disappear just because all selected tokens fit the proposed lanes.
  if (
    items.some(
      (i) =>
        i.horizontal &&
        i.text.trim() &&
        i.baseline > opening[1] &&
        i.baseline < closing[1] &&
        i.rect[0] < opening[2] &&
        i.rect[2] > opening[0] &&
        !source.includes(i)
    )
  )
    return
  return {
    cuts,
    groups: all,
    consumed: source,
    baselineHeight: h,
    repair: 'native-rowless-closed-records-recovered',
    cropRect: [opening[0] - 0.5, opening[1] - 0.5, opening[2] + 0.5, closing[1] + 0.5]
  }
}

// A missing model leaf is repaired only from separately printed leaf labels,
// a native opening/header/footer and repeated physical records. The source
// must fit every resulting lane in full; scripts retain their literal tokens.
export function recoverNativePrintedLeafPlan(table, items, captions, rules, runs = []) {
  const frame = nativeHeaderFrame(table, items, rules)
  if (!frame) return
  const { h, opening, divider, closing } = frame
  let body = frame.body
  const lowerBaseline = Math.max(
    ...frame.header.filter((i) => i.height >= h * 0.85).map((i) => i.baseline)
  )
  const header = frame.header.flatMap((i) => {
    const observed = runs.filter((r) => r.text === i.text && sameRect(r.rect, i.rect))
    if (
      i.height >= h * 0.85 &&
      Math.abs(i.baseline - lowerBaseline) < h * 0.3 &&
      observed.length === 1 &&
      observed[0].gaps.length >= 2
    ) {
      const pieces = splitObserved(
        i,
        runs,
        observed[0].gaps.map((g) => [g.left, g.right]),
        h
      )
      // This is only a proposed lower-leaf split. Every resulting face must
      // subsequently own complete independent peer records and open gutters.
      // Ordinary words or arbitrary spaces alone never establish table leaves.
      if (pieces?.every((p) => /\p{L}/u.test(p.text) || /^\d+$/u.test(p.text))) return pieces
    }
    const underlines = rules
      .filter(
        (r) =>
          r[1] === r[3] &&
          r[1] >= i.rect[3] &&
          r[1] - i.rect[3] < h &&
          r[0] >= opening[0] &&
          r[2] <= opening[2] &&
          r[2] - r[0] < (opening[2] - opening[0]) * 0.8
      )
      .sort((a, b) => a[0] - b[0])
    if (underlines.length < 2 || underlines.some((r) => Math.abs(r[1] - underlines[0][1]) > 0.5))
      return [i]
    const gutters = underlines.slice(1).map((r, n) => [underlines[n][2] - h * 0.4, r[0] + h * 0.4])
    return splitObserved(i, runs, gutters, h) ?? [i]
  })
  const bands = physicalRows(
    header.filter((i) => i.height >= h * 0.85),
    h
  )
  const choices = bands.map((g) => headerLeaves(g, h)).sort((a, b) => b.length - a.length)
  let leaves = choices[0]
  const numberedLeaves = choices.filter(
    (g) => g.length === leaves?.length && g.length >= 3 && g.every((v) => /^\d+$/u.test(joined(v)))
  )
  if (numberedLeaves.length === 1) leaves = numberedLeaves[0]
  if (
    !leaves ||
    leaves.length < 3 ||
    leaves.length > 16 ||
    leaves.some(
      (g) =>
        !/\p{L}/u.test(joined(g)) &&
        !/^[∆Δ]\s*\(%\)$/u.test(joined(g)) &&
        !(
          /^\d+$/u.test(joined(g)) &&
          rules.some(
            (r) =>
              r[1] === r[3] &&
              r[1] < box(g)[1] &&
              box(g)[1] - r[1] < h &&
              r[0] < (box(g)[0] + box(g)[2]) / 2 &&
              r[2] > (box(g)[0] + box(g)[2]) / 2 &&
              r[2] - r[0] < (opening[2] - opening[0]) * 0.9 &&
              leaves.filter(
                (v) => (box(v)[0] + box(v)[2]) / 2 > r[0] && (box(v)[0] + box(v)[2]) / 2 < r[2]
              ).length >= 2
          )
        )
    )
  )
    return
  const first = box(leaves[0])[0]
  const prefix = headerLeaves(
    header.filter((i) => i.height >= h * 0.85 && i.rect[2] < first - 0.02),
    h
  )
  if (prefix.length > 2) return
  const vertical = rules.filter((r) => r[0] === r[2]),
    leafWalls = [...new Set(vertical.map((r) => r[0]))].filter(
      (x) => classifyTableRuleEdge(vertical, 0, x, divider[1], closing[1]) === 1
    )
  const last = box(leaves.at(-1))[2],
    suffixItems = header.filter((i) => i.height >= h * 0.85 && i.rect[0] > last + 0.02),
    suffixWalls = leafWalls.filter((x) => x > last && x < opening[2]).sort((a, b) => a - b),
    suffix = suffixWalls.length
      ? [last, ...suffixWalls, opening[2]]
          .slice(1)
          .map((right, n, all) =>
            suffixItems.filter((i) => {
              const center = (i.rect[0] + i.rect[2]) / 2,
                left = n ? all[n - 1] : last
              return center > left && center < right
            })
          )
          .filter((g) => g.length)
      : headerLeaves(suffixItems, h)
  if (suffix.length > 2) return
  leaves = [...prefix, ...leaves, ...suffix]
  const modelColumns = table.structure.objects
      .filter((o) => o.label === 'table column')
      .sort((a, b) => a.rect[0] - b.rect[0]),
    modelCuts = modelColumns
      .slice(1)
      .map((c, n) => table.cropRect[0] + (modelColumns[n].rect[2] + c.rect[0]) / 2)
  let initial = [
    opening[0],
    ...leaves.slice(1).map((g, n) => {
      const a = box(leaves[n])[2],
        b = box(g)[0],
        matches = modelCuts.filter((x) => x > a && x < b)
      const walls = leafWalls.filter(
        (x) =>
          x > (box(leaves[n])[0] + a) / 2 &&
          x < (b + box(g)[2]) / 2 &&
          x >= a - h * 0.3 &&
          x <= b + h * 0.3
      )
      const exactBodyWall =
        walls.length === 1 &&
        walls[0] >= a - 0.02 &&
        walls[0] <= b + 0.02 &&
        body
          .filter((i) => i.rect[0] < walls[0] && i.rect[2] > walls[0])
          .every((i) => {
            const observed = runs.filter((r) => r.text === i.text && sameRect(r.rect, i.rect))
            return (
              observed.length === 1 &&
              observed[0].glyphRuns?.length &&
              new Set(observed[0].glyphRuns).size === 1 &&
              observed[0].literalGlyphs.join('') === i.text.replace(/\s/gu, '') &&
              observed[0].gaps.filter(
                (g) => g.left <= walls[0] + 0.02 && g.right >= walls[0] - 0.02
              ).length === 1
            )
          })
      return (b - a < h * 0.2 || exactBodyWall) && walls.length === 1
        ? walls[0]
        : matches.length === 1
          ? matches[0]
          : b - h * 0.03
    }),
    opening[2]
  ]
  const literalScalar = (s) => /^[0-9−+<>≤≥.,()[\]*/×–—↑↓→\s%-]+$/u.test(s)
  body = body.flatMap((i) => {
    if (!/\d/u.test(i.text)) return [i]
    const parts = splitObserved(
      i,
      runs,
      initial.slice(1, -1).map((x) => [x - h, x + h, x]),
      h
    )
    return parts && parts.slice(1).every((p) => literalScalar(p.text)) ? parts : [i]
  })
  const fields = (group, cuts) =>
    cuts
      .slice(1)
      .map((r, c) =>
        group.filter(
          (i) => (i.rect[0] + i.rect[2]) / 2 >= cuts[c] && (i.rect[0] + i.rect[2]) / 2 < r
        )
      )
  // A printed blank leading header is still a leaf when two separately ruled
  // blocks place explicit group labels left of complete repeated records.
  const leading = body.filter((i) => i.rect[2] < box(leaves[0])[0] - h && /\p{L}{2}/u.test(i.text))
  const leadingRight = Math.max(-Infinity, ...leading.map((i) => i.rect[2])),
    firstMeasuredLeft = Math.min(
      Infinity,
      ...body.filter((i) => i.rect[0] > leadingRight && literalScalar(i.text)).map((i) => i.rect[0])
    ),
    leadingPeers = physicalRows(
      body.filter((i) => i.height >= h * 0.85),
      h
    ),
    blankStubPeers =
      new Set(leading.map((i) => i.baseline)).size >= 3 &&
      firstMeasuredLeft - leadingRight >= h * 0.2 &&
      leadingPeers.every(
        (g) =>
          g.some((i) => leading.includes(i)) &&
          fields(g, initial).filter((v) => v.some((i) => literalScalar(i.text))).length >=
            Math.ceil(leaves.length / 2)
      )
  if (
    leading.length &&
    (blankStubPeers ||
      rules.some(
        (r) =>
          r[1] === r[3] &&
          r[1] > divider[1] &&
          r[1] < closing[1] &&
          Math.abs(r[0] - opening[0]) < 0.7 &&
          Math.abs(r[2] - opening[2]) < 0.7
      )) &&
    new Set(leading.map((i) => i.baseline)).size >= 2
  ) {
    const right = Math.max(...leading.map((i) => i.rect[2]))
    if (right >= box(leaves[0])[0] - h * 0.5) return
    initial = [
      initial[0],
      (right + (blankStubPeers ? firstMeasuredLeft : box(leaves[0])[0])) / 2,
      ...initial.slice(1)
    ]
    leaves = [[], ...leaves]
  }
  const bodyGroups = physicalRows(
    body.filter((i) => i.height >= h * 0.85),
    h
  )
  if (bodyGroups.length < 3) return
  const sectionGroups = bodyGroups.filter((g, n) => {
    const ink = box(g),
      next = bodyGroups[n + 1]
    const fullRules = rules.filter(
        (r) =>
          r[1] === r[3] && Math.abs(r[0] - opening[0]) < 0.05 && Math.abs(r[2] - opening[2]) < 0.05
      ),
      top = Math.max(-Infinity, ...fullRules.filter((r) => r[1] < ink[3]).map((r) => r[1])),
      bottom = Math.min(Infinity, ...fullRules.filter((r) => r[1] > ink[3]).map((r) => r[1])),
      closedLeftLabel =
        next &&
        ink[0] - opening[0] < h &&
        ink[2] - ink[0] < (opening[2] - opening[0]) * 0.5 &&
        /^[\p{L}][\p{L}\p{N}\s.+()-]*$/u.test(joined(g)) &&
        ink[3] - top < h * 1.8 &&
        bottom - ink[3] < h &&
        bottom < next[0].baseline &&
        body.filter((i) => i.baseline > top && i.baseline < bottom).every((i) => g.includes(i))
    return (
      next &&
      (closedLeftLabel ||
        (/^[\p{L}][\p{L}\s-]+$/u.test(joined(g)) &&
          Math.abs(ink[0] + ink[2] - opening[0] - opening[2]) < h * 2)) &&
      rules.some(
        (r) =>
          r[1] === r[3] &&
          Math.abs(r[0] - opening[0]) < 0.05 &&
          Math.abs(r[2] - opening[2]) < 0.05 &&
          r[1] < ink[3] &&
          ink[3] - r[1] < h * 1.8
      ) &&
      next[0].baseline - g[0].baseline > h * 0.6 &&
      next[0].baseline - g[0].baseline < h * 1.8 &&
      fields(next, initial).filter((v) => v.length && literalScalar(joined(v))).length >=
        Math.ceil(leaves.length / 2)
    )
  })
  for (const section of sectionGroups) bodyGroups.splice(bodyGroups.indexOf(section), 1)
  body = body.filter((i) => !sectionGroups.some((g) => g.includes(i)))
  const fences = rules
    .filter(
      (r) =>
        r[1] === r[3] && Math.abs(r[0] - opening[0]) < 0.05 && Math.abs(r[2] - opening[2]) < 0.05
    )
    .map((r) => r[1])
  // Printed dashed separators are finite fences too. Require every measured
  // dash, a stable native height, and coverage of the same full table width;
  // short parent underlines or an arbitrary unpainted gap cannot lend closure.
  const dashBands = []
  for (const r of rules.filter(
    (r) =>
      r[1] === r[3] &&
      r[0] >= opening[0] &&
      r[2] <= opening[2] &&
      r[2] - r[0] > 0 &&
      r[2] - r[0] <= h * 1.2
  )) {
    const band = dashBands.find((g) => Math.abs(g[0][1] - r[1]) < 0.02)
    if (band) band.push(r)
    else dashBands.push([r])
  }
  for (const g of dashBands) {
    g.sort((a, b) => a[0] - b[0])
    const lengths = g.map((r) => r[2] - r[0]),
      dash = median(lengths)
    if (
      g.length >= 6 &&
      g[0][0] - opening[0] < h &&
      opening[2] - g.at(-1)[2] < h &&
      lengths.every((v) => Math.abs(v - dash) < 0.02) &&
      g.slice(1).every((r, n) => r[0] - g[n][2] > 0 && r[0] - g[n][2] <= dash * 1.2)
    )
      fences.push(g[0][1])
  }
  const centeredStubs = []
  for (let n = 1; n + 1 < bodyGroups.length; n++) {
    const g = bodyGroups[n],
      prior = bodyGroups[n - 1],
      next = bodyGroups[n + 1],
      lanes = fields(g, initial),
      before = fields(prior, initial),
      after = fields(next, initial),
      at = g[0].baseline
    if (!lanes[0].length || lanes.slice(1).some((v) => v.length) || !/\p{L}/u.test(joined(g)))
      continue
    const label = body
      .filter(
        (i) => Math.abs(i.baseline - at) < 0.02 && i.rect[0] >= initial[0] && i.rect[2] < initial[1]
      )
      .sort((a, b) => a.rect[0] - b.rect[0])
    if (
      g.some((i) => !label.includes(i)) ||
      label
        .slice(1)
        .some(
          (i, c) => i.rect[0] < label[c].rect[2] - 0.02 || i.rect[0] - label[c].rect[2] > h * 0.1
        )
    )
      return
    if (
      before[0].length ||
      after[0].length ||
      before.slice(Math.max(1, prefix.length)).some((v) => !v.length || !numericLiteral(v)) ||
      after.slice(Math.max(1, prefix.length)).some((v) => !v.length || !numericLiteral(v)) ||
      Math.abs(at - (prior[0].baseline + next[0].baseline) / 2) > h * 0.03 ||
      at - prior[0].baseline < h * 0.35 ||
      next[0].baseline - at < h * 0.35 ||
      next[0].baseline - prior[0].baseline > h * 1.7 ||
      !fences.some((y) => y < prior[0].baseline && prior[0].baseline - y < h * 3) ||
      !fences.some((y) => y > next[0].baseline && y - next[0].baseline < h * 3)
    )
      return
    centeredStubs.push({ items: label, prior, next })
    bodyGroups.splice(n--, 1)
  }
  function numericLiteral(group) {
    return literalScalar(joined(group))
  }
  body = body.filter((i) => !centeredStubs.some((g) => g.items.includes(i)))
  const source = [
    ...header,
    ...body,
    ...sectionGroups.flat(),
    ...centeredStubs.flatMap((g) => g.items)
  ]
  // Reject wrapped prose/table definitions: native baselines alone do not
  // establish their logical records. Numeric/mixed records need independent
  // measurements in at least half the printed leaves on every body baseline.
  const numeric = literalScalar
  for (let n = 0; n < bodyGroups.length; n++) {
    const g = bodyGroups[n],
      lanes = fields(g, initial)
    if (
      lanes.some((v) => {
        const parts = headerLeaves(v, h * (0.65 / 0.3))
        return (
          parts.length > 1 &&
          (numeric(joined(v)) ||
            (parts.some((g) => /\p{L}/u.test(joined(g))) && parts.some((g) => numeric(joined(g)))))
        )
      })
    )
      return
    if (lanes.filter((v) => v.length && numeric(joined(v))).length >= Math.floor(leaves.length / 2))
      continue
    const prior = bodyGroups[n - 1]
    if (
      !prior ||
      lanes.slice(0, -1).some((v) => v.length) ||
      !lanes.at(-1).some((i) => /\p{L}/u.test(i.text)) ||
      g[0].baseline - Math.max(...prior.map((i) => i.baseline)) > h * 1.7 ||
      rules.some(
        (r) =>
          r[1] === r[3] &&
          r[1] > Math.max(...prior.map((i) => i.baseline)) &&
          r[1] < g[0].baseline &&
          r[2] - r[0] > (opening[2] - opening[0]) * 0.9
      )
    )
      return
    prior.push(...g)
    bodyGroups.splice(n--, 1)
  }
  const completeKeyedPeer = (g) => {
      const lanes = fields(g, initial)
      return (
        lanes[1]?.length &&
        /\p{L}/u.test(joined(lanes[1])) &&
        lanes.slice(2).every((v) => v.length && literalScalar(joined(v)))
      )
    },
    explicitBlankLeading =
      leaves.length >= 4 &&
      leaves[0].length > 0 &&
      bodyGroups.some((g) => !fields(g, initial)[0].length) &&
      bodyGroups.filter(
        (g) => fields(g, initial)[0].some((i) => /\p{L}/u.test(i.text)) && completeKeyedPeer(g)
      ).length >= 2 &&
      bodyGroups.filter((g) => !fields(g, initial)[0].length).every(completeKeyedPeer)
  if (
    bodyGroups.some((g) =>
      fields(g, initial).some(
        (v, c) =>
          !v.length &&
          !(c === 0 && leaves[0].length === 0) &&
          !(c === 0 && explicitBlankLeading) &&
          !(c === 0 && centeredStubs.some((s) => s.prior === g || s.next === g)) &&
          !(
            centeredStubs.length &&
            c > 0 &&
            c < prefix.length &&
            fields(g, initial)[0].length &&
            fields(g, initial).slice(prefix.length).every(numericLiteral)
          )
      )
    )
  )
    return
  // A wide descriptive face must not erase another independently printed
  // stub. Touching small-cap fragments are one source label; two ordinary
  // literal islands with a real gutter are not a single record key.
  if (
    bodyGroups.some((g) =>
      fields(g, initial).some(
        (v) =>
          /^\p{L}/u.test(joined(v)) &&
          headerLeaves(
            v.filter((i) => i.height >= h * 0.85),
            h * (0.65 / 0.3)
          ).length > 1
      )
    )
  )
    return
  const allFields = leaves.map(() => [])
  for (const i of body) {
    const c = initial.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
    if (c < 0) return
    allFields[c].push(i)
  }
  if (allFields.some((g) => !g.length)) return
  const cuts = [opening[0]]
  for (let c = 1; c < leaves.length; c++) {
    const leftInk = Math.max(
        ...allFields[c - 1].map((i) => i.rect[2]),
        ...leaves[c - 1].map((i) => i.rect[2])
      ),
      rightInk = Math.min(...allFields[c].map((i) => i.rect[0]), ...leaves[c].map((i) => i.rect[0]))
    if (rightInk - leftInk < h * 0.2) {
      const leftBody = Math.max(...allFields[c - 1].map((i) => i.rect[2])),
        rightBody = Math.min(...allFields[c].map((i) => i.rect[0])),
        walls = leafWalls.filter(
          (x) =>
            x > leftBody + h * 0.1 &&
            x < rightBody - h * 0.1 &&
            x >= leftInk - h * 0.3 &&
            x <= rightInk + h * 0.3
        )
      if (walls.length !== 1) return
      cuts.push(walls[0])
    } else cuts.push((leftInk + rightInk) / 2)
  }
  cuts.push(opening[2])
  if (
    body.some(
      (i) =>
        !cuts.slice(1).some((r, c) => i.rect[0] >= cuts[c] - h * 0.2 && i.rect[2] <= r + h * 0.2)
    )
  )
    return
  // A split header/first record can be fixed while fraction fields remain
  // literal, but complete body reconstruction here deliberately excludes it.
  const headerRows = physicalRows(
    header.filter((i) => i.height >= h * 0.85),
    h
  )
  const spans = [],
    groupedHeader = [],
    stubHeader = []
  const headerPrefix = Math.max(
    prefix.length,
    bodyGroups.every((g) => {
      const lanes = fields(g, cuts)
      return (
        /\p{L}/u.test(joined(lanes[0])) &&
        !literalScalar(joined(lanes[0])) &&
        lanes.slice(1).every((v) => v.length && literalScalar(joined(v)))
      )
    })
      ? 1
      : 0
  )
  const headerColumn = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  let tiered = false
  for (const g of headerRows) {
    for (const i of g) {
      const covered = cuts
        .slice(1)
        .map((r, c) => c)
        .filter((c) => i.rect[0] < cuts[c + 1] && i.rect[2] > cuts[c])
      if (covered.length > 1 && /\p{L}/u.test(i.text)) tiered = true
    }
  }
  if (!tiered) groupedHeader.push(header)
  else {
    // Vertically centered stub labels do not create an empty header tier.
    // Only bands with an independently printed metric label establish tiers;
    // place a stub-only band at its nearest existing printed baseline.
    const isStub = (i) =>
      headerColumn(i) < headerPrefix || headerColumn(i) >= leaves.length - suffix.length
    const tiers = headerRows.map((g) => g.filter((i) => !isStub(i))).filter((g) => g.length)
    if (!tiers.length) return
    for (let column = 0; column < leaves.length; column++) {
      if (column >= headerPrefix && column < leaves.length - suffix.length) continue
      const group = header.filter((i) => headerColumn(i) === column),
        ordinary = physicalRows(
          group.filter((i) => i.height >= h * 0.85),
          h
        )
      if (!group.length) continue
      // Complete peer body gutters prove this single header face. Two
      // independent headings remain separate; only a literal hyphen chain
      // with aligned native baselines proves a wrapped word in that face.
      if (
        ordinary.some((g) => headerLeaves(g, h).length !== 1) ||
        group.some(
          (i) => i.rect[0] < cuts[column] - h * 0.3 || i.rect[2] > cuts[column + 1] + h * 0.3
        ) ||
        ordinary
          .slice(1)
          .some(
            (g, n) =>
              !/-\s*$/u.test(joined(ordinary[n])) ||
              !/^\p{L}[\p{L}\s-]*$/u.test(joined(g)) ||
              g[0].baseline - ordinary[n][0].baseline > h * 1.7 ||
              Math.abs(box(g)[0] - box(ordinary[n])[0]) > h * 0.1
          ) ||
        rules.some(
          (r) =>
            r[1] === r[3] &&
            r[1] > opening[1] &&
            r[1] < divider[1] &&
            ((r[0] <= cuts[column] + h * 0.1 && r[2] >= cuts[column + 1] - h * 0.1) ||
              (ordinary.length > 1 &&
                r[1] > ordinary[0][0].baseline &&
                r[1] < ordinary.at(-1)[0].baseline &&
                r[0] <= box(group)[0] &&
                r[2] >= box(group)[2]))
        )
      )
        return
      stubHeader.push({ column, items: group })
    }
    groupedHeader.push(...tiers)
  }
  for (let row = 0; row < groupedHeader.length; row++) {
    const g = groupedHeader[row]
    if (tiered) {
      // Attach raised/small header glyphs to the uniquely adjacent baseline.
      for (const i of header.filter(
        (i) => i.height < h * 0.85 && !stubHeader.some((s) => s.items.includes(i))
      )) {
        const nearest = groupedHeader.map((r) => Math.abs(r[0].baseline - i.baseline))
        if (nearest.indexOf(Math.min(...nearest)) === row) g.push(i)
      }
    }
    for (const group of headerLeaves(g, h)) {
      const ordinary = group
        .filter((i) => i.height >= h * 0.85)
        .sort((a, b) => a.rect[0] - b.rect[0])
      if (
        ordinary
          .slice(1)
          .some(
            (i, n) =>
              Math.abs(i.baseline - ordinary[n].baseline) < h * 0.3 &&
              i.rect[0] < ordinary[n].rect[2] - 0.02
          )
      )
        return
      const ink = box(group),
        center = (ink[0] + ink[2]) / 2
      let column = headerColumn({ rect: ink }),
        end = column + 1
      if (tiered && row < groupedHeader.length - 1) {
        const repeatedPairs =
          leaves.slice(prefix.length).length % 2 === 0 &&
          leaves.slice(prefix.length).every((g, n, all) => joined(g) === joined(all[n % 2]))
        const parentPeers = headerLeaves(g, h).filter((v) => box(v)[0] >= cuts[prefix.length])
        const pairCenters = cuts
          .slice(prefix.length, -1)
          .filter((_, n) => n % 2 === 0)
          .map((x, n) => (x + cuts[prefix.length + n * 2 + 2]) / 2)
        const peerMatches = parentPeers.map((v) => {
          const at = (box(v)[0] + box(v)[2]) / 2
          return pairCenters
            .map((x) => Math.abs(x - at))
            .indexOf(Math.min(...pairCenters.map((x) => Math.abs(x - at))))
        })
        const peerIndex = parentPeers.findIndex(
          (v) => v.length === group.length && v.every((i) => group.includes(i))
        )
        if (
          repeatedPairs &&
          parentPeers.length === pairCenters.length &&
          new Set(peerMatches).size === pairCenters.length &&
          peerIndex >= 0
        ) {
          column = prefix.length + peerMatches[peerIndex] * 2
          end = column + 2
        } else if (
          column < prefix.length ||
          column >= leaves.length - suffix.length ||
          (ink[0] >= cuts[column] - h * 0.05 &&
            ink[2] <= cuts[column + 1] + h * 0.05 &&
            !rules.some(
              (r) =>
                r[1] === r[3] &&
                r[1] >= ink[3] - h * 0.05 &&
                r[1] <= divider[1] &&
                r[0] <= center &&
                r[2] >= center &&
                cuts.slice(1, -1).some((x) => x > r[0] && x < r[2]) &&
                r[2] - r[0] < (opening[2] - opening[0]) * 0.9
            ))
        ) {
          end = column + 1
        } else {
          const vertical = rules.filter(
            (r) =>
              r[0] === r[2] && r[1] <= g[0].baseline && r[3] >= Math.min(...g.map((i) => i.rect[1]))
          )
          const left = Math.max(
              cuts[headerPrefix],
              ...vertical.filter((r) => r[0] < center).map((r) => r[0])
            ),
            right = Math.min(opening[2], ...vertical.filter((r) => r[0] > center).map((r) => r[0]))
          const underlines = rules.filter(
            (r) =>
              r[1] === r[3] &&
              r[1] >= ink[3] - h * 0.05 &&
              r[1] <= divider[1] &&
              r[0] <= center &&
              r[2] >= center &&
              r[2] - r[0] < (opening[2] - opening[0]) * 0.9
          )
          const boundary =
            underlines.length === 1
              ? [underlines[0][0], underlines[0][2]]
              : right - left < (opening[2] - opening[0]) * 0.9
                ? [left, right]
                : undefined
          if (!boundary) return
          const enclosed = cuts
            .slice(1)
            .map((r, c) => c)
            .filter(
              (c) =>
                (cuts[c] + cuts[c + 1]) / 2 > boundary[0] &&
                (cuts[c] + cuts[c + 1]) / 2 < boundary[1]
            )
          if (!enclosed.length) return
          column = enclosed[0]
          end = enclosed.at(-1) + 1
        }
      }
      const nativeFace = leafWalls.some(
        (x) => Math.abs(x - cuts[column]) < 0.02 || Math.abs(x - cuts[end]) < 0.02
      )
      const overhang =
        tiered && row < groupedHeader.length - 1 ? h * 0.6 : nativeFace ? h * 0.3 : h * 0.05
      if (
        column < 0 ||
        end <= column ||
        ink[0] < cuts[column] - overhang ||
        ink[2] > cuts[end] + overhang
      )
        return
      spans.push({
        row,
        column,
        rowSpan: 1,
        colSpan: end - column,
        items: group,
        rect: [Math.min(cuts[column], ink[0]), ink[1], Math.max(cuts[end], ink[2]), ink[3]]
      })
    }
  }
  // A complete upper peer tier bounded by actual vertical header segments
  // fixes short titles too. Native child/body gutters keep a Method stub out
  // of the first parent; merely centering a parent over one leaf is not proof.
  if (groupedHeader.length > 1) {
    const peers = spans.filter((s) => s.row === 0),
      band = groupedHeader[0],
      at = band[0].baseline,
      walls = [
        ...new Set(
          rules
            .filter((r) => r[0] === r[2] && r[1] <= at && r[3] >= at && r[3] - r[1] >= h * 0.5)
            .map((r) => r[0])
        )
      ]
        .filter((x) => x > cuts[headerPrefix] && x < cuts[leaves.length - suffix.length])
        .sort((a, b) => a - b),
      boundaries = [cuts[headerPrefix], ...walls, cuts[leaves.length - suffix.length]]
    if (
      walls.length >= 2 &&
      peers.length === boundaries.length - 1 &&
      walls.every((x) => body.every((i) => i.rect[2] <= x || i.rect[0] >= x))
    ) {
      const partitions = peers.map((s) => {
          const ink = box(s.items),
            range = boundaries
              .slice(1)
              .map((right, n) => [boundaries[n], right])
              .filter(([left, right]) => ink[0] >= left && ink[2] <= right)
          if (range.length !== 1) return
          return leaves
            .map((g, c) => ({ c, center: (box(g)[0] + box(g)[2]) / 2 }))
            .filter(
              ({ c, center }) =>
                c >= headerPrefix &&
                c < leaves.length - suffix.length &&
                center > range[0][0] &&
                center < range[0][1]
            )
            .map(({ c }) => c)
        }),
        covered = partitions.filter(Boolean).flat()
      if (
        partitions.every((g) => g?.length && g.every((c, n) => c === g[0] + n)) &&
        covered.length === leaves.length - headerPrefix - suffix.length &&
        new Set(covered).size === covered.length
      ) {
        for (const [n, s] of peers.entries()) {
          s.column = partitions[n][0]
          s.colSpan = partitions[n].length
          s.rect[0] = cuts[s.column]
          s.rect[2] = cuts[s.column + s.colSpan]
        }
      }
    }
  }
  // A complete printed peer partition inside an independently ruled upper
  // domain can bound an unequal intermediate parent. Its text must actually
  // cover every owned child center, and all peer children must be covered once.
  // An isolated centered/wide heading never lends a missing child or domain.
  for (let row = 1; row + 1 < groupedHeader.length; row++) {
    for (const domain of spans.filter((s) => s.row === row - 1 && s.colSpan > 1)) {
      const start = domain.column,
        end = start + domain.colSpan,
        peers = spans.filter(
          (s) =>
            s.row === row &&
            box(s.items)[0] >= cuts[start] - h * 0.2 &&
            box(s.items)[2] <= cuts[end] + h * 0.2
        ),
        occupied = peers.flatMap((s) => Array.from({ length: s.colSpan }, (_, n) => s.column + n))
      if (peers.length < 2 || new Set(occupied).size === occupied.length) continue
      const proposed = peers.map((s) => {
          const ink = box(s.items)
          return leaves
            .map((g, c) => ({ c, center: (box(g)[0] + box(g)[2]) / 2 }))
            .filter(
              ({ c, center }) => c >= start && c < end && center >= ink[0] && center <= ink[2]
            )
            .map(({ c }) => c)
        }),
        covered = proposed.flat()
      if (
        proposed.some((g) => !g.length || g.some((c, n) => c !== g[0] + n)) ||
        covered.length !== domain.colSpan ||
        new Set(covered).size !== domain.colSpan ||
        covered.some((c) => c < start || c >= end)
      )
        continue
      for (const [n, span] of peers.entries()) {
        span.column = proposed[n][0]
        span.colSpan = proposed[n].length
        span.rect[0] = Math.min(cuts[span.column], box(span.items)[0])
        span.rect[2] = Math.max(cuts[span.column + span.colSpan], box(span.items)[2])
      }
    }
  }
  for (const stub of stubHeader) {
    groupedHeader[0].push(...stub.items)
    spans.push({
      row: 0,
      column: stub.column,
      rowSpan: groupedHeader.length,
      colSpan: 1,
      items: stub.items,
      rect: [cuts[stub.column], opening[1], cuts[stub.column + 1], divider[1]]
    })
  }
  const slots = new Set()
  for (const span of spans)
    for (let c = span.column; c < span.column + span.colSpan; c++) {
      const key = span.row + ':' + c
      if (slots.has(key)) return
      slots.add(key)
    }
  const groups = [...groupedHeader]
  for (const bases of bodyGroups) {
    const distances = (i) =>
      bodyGroups.map((g) => Math.min(...g.map((base) => Math.abs(base.baseline - i.baseline))))
    groups.push(
      body.filter(
        (i) => distances(i).indexOf(Math.min(...distances(i))) === bodyGroups.indexOf(bases)
      )
    )
  }
  for (const stub of centeredStubs) {
    const row = groupedHeader.length + bodyGroups.indexOf(stub.prior)
    if (bodyGroups.indexOf(stub.next) !== bodyGroups.indexOf(stub.prior) + 1) return
    groups[row].push(...stub.items)
    spans.push({
      row,
      column: 0,
      rowSpan: 2,
      colSpan: 1,
      items: stub.items,
      rect: [
        cuts[0],
        Math.min(...stub.prior.map((i) => i.rect[1])),
        cuts[1],
        Math.max(...stub.next.map((i) => i.rect[3]))
      ]
    })
  }
  for (const section of sectionGroups) {
    const at = groups.findIndex(
      (g, n) => n >= groupedHeader.length && g[0].baseline > section[0].baseline
    )
    if (at < 0) return
    groups.splice(at, 0, section)
    for (const span of spans) if (span.row >= at) span.row++
    spans.push({
      row: at,
      column: 0,
      rowSpan: 1,
      colSpan: leaves.length,
      items: section,
      rect: box(section)
    })
  }
  if (new Set(groups.flat()).size !== source.length || groups.flat().length !== source.length)
    return
  const columns = table.structure.objects.filter((o) => o.label === 'table column').length
  if (
    cuts.length - 1 === columns &&
    !tiered &&
    !explicitBlankLeading &&
    !items.some((i) => i.nativeLaneSplit)
  )
    return
  return {
    cuts,
    groups,
    spans,
    headerRows: groupedHeader.length,
    consumed: [...source, ...source.map((i) => i.sourceToken).filter(Boolean)],
    repair: 'native-printed-leaf-records-recovered',
    cropRect: [
      Math.min(table.cropRect[0], opening[0] - 0.5),
      table.cropRect[1],
      Math.max(table.cropRect[2], opening[2] + 0.5),
      table.cropRect[3]
    ]
  }
}

// Dense literal statistics can have several native fragments inside one
// heading, while the detector collapses every body record into that header.
// Repeated complete native records establish the gutters; this proof neither
// parses the statistic nor changes a formula, script or printed blank.
export function recoverNativeCaptionWidthLiteralRecords(table, items, captions, rules) {
  const crop = table.cropRect,
    candidates = []
  const literalGlyphs = (s) => [...s.normalize('NFKC').replace(/\s/gu, '')].sort().join('')
  for (const title of captions.filter((c) => captionKind(c.lines?.[0]) === 'table')) {
    const titleSource = items.filter(
      (i) =>
        i.horizontal &&
        i.text.trim() &&
        i.rect[0] >= title.rect[0] - 0.02 &&
        i.rect[2] <= title.rect[2] + 0.02 &&
        i.baseline >= title.rect[1] &&
        i.baseline <= title.rect[3] + 0.02
    )
    if (
      !titleSource.length ||
      literalGlyphs(titleSource.map((i) => i.text).join('')) !== literalGlyphs(title.lines.join(''))
    )
      continue
    const titleHeight = median(titleSource.map((i) => i.height)),
      edges = joinHorizontalTableRules(rules, 0.01, 0)
        .filter(
          (r) =>
            Math.abs(r[0] - title.rect[0]) < 0.02 &&
            Math.abs(r[2] - title.rect[2]) < 0.02 &&
            r[1] >= crop[1] &&
            r[1] <= crop[3]
        )
        .sort((a, b) => a[1] - b[1])
    if (
      edges.length !== 3 ||
      title.rect[3] > edges[0][1] ||
      edges[0][1] - title.rect[3] > titleHeight * 2 ||
      crop[0] > edges[0][0] ||
      crop[2] >= edges[0][2] - 0.5
    )
      continue
    const proposed = { ...table, cropRect: [edges[0][0], crop[1], edges[0][2], crop[3]] },
      frame = nativeHeaderFrame(proposed, items, rules)
    if (
      !frame ||
      crop[0] < frame.opening[0] - frame.h * 3 ||
      Math.abs(frame.closing[1] - crop[3]) > frame.h * 2
    )
      continue
    candidates.push(frame)
  }
  if (candidates.length !== 1) return
  const { h, opening, closing, header, body, source } = candidates[0],
    ordinaryHeader = header.filter((i) => i.height >= h * 0.85),
    ordinary = body.filter((i) => i.height >= h * 0.85)
  if (physicalRows(ordinaryHeader, h).length !== 1) return
  // Two printed key lanes establish actual record baselines independently of
  // the model's compressed rows. Only header starts also witnessed by body
  // text can establish a leaf; unit/formula fragments cannot add a column.
  const starts = [
    ...new Set(
      ordinaryHeader
        .filter((i) => ordinary.some((a) => Math.abs(a.rect[0] - i.rect[0]) < 0.02))
        .map((i) => i.rect[0])
    )
  ].sort((a, b) => a - b)
  if (starts.length < 8 || starts.length > 16) return
  const keys = ordinary.filter((i) => Math.abs(i.rect[0] - starts[0]) < 0.02),
    bands = physicalRows(keys, h)
  if (
    bands.length < 10 ||
    bands.length > 50 ||
    bands.some((g) => g.length !== 1) ||
    bands.slice(1).some((g, n) => g[0].baseline - bands[n][0].baseline < h * 0.75)
  )
    return
  const recordOf = (i) => {
    const distances = bands.map((g) => Math.abs(g[0].baseline - i.baseline)),
      nearest = Math.min(...distances),
      matches = distances.map((d, n) => ({ d, n })).filter(({ d }) => Math.abs(d - nearest) < 0.02)
    return matches.length === 1 && nearest < h * (i.height < h * 0.85 ? 0.7 : 0.02)
      ? matches[0].n
      : -1
  }
  const lane = (i) => starts.findLastIndex((x) => i.rect[0] >= x - 0.02),
    fields = bands.map(() => starts.map(() => [])),
    headings = starts.map(() => [])
  for (const i of header) {
    const c = lane(i)
    if (c < 0 || i.rect[2] > (starts[c + 1] ?? opening[2]) + 0.02) return
    headings[c].push(i)
  }
  for (const i of body) {
    const r = recordOf(i),
      c = lane(i)
    if (r < 0 || c < 0 || i.rect[2] > (starts[c + 1] ?? opening[2]) + 0.02) return
    fields[r][c].push(i)
  }
  if (headings.some((g) => !g.length || !/\p{L}/u.test(joined(g)))) return
  const coreEnd = starts.length - 3,
    number = (g) => /^[−+-]?(?:\d|\[\s*[−+-]?\d)|^[<>≤≥]\s*\d/u.test(joined(g))
  if (
    fields.some(
      (row) =>
        row.slice(0, 2).some((g) => !g.length || !/\p{L}/u.test(joined(g))) ||
        row.slice(2, coreEnd).some((g) => !g.length || !number(g)) ||
        !row[coreEnd].length ||
        !/\p{L}/u.test(joined(row[coreEnd])) ||
        row.slice(0, coreEnd + 1).some((g) => box(g)[2] > crop[2] + 0.02)
    )
  )
    return
  // Both trailing optional leaves need their own printed heading AND positive
  // source witnesses. Blank primary fields stay blank beside a literal flag.
  if (
    fields.filter((row) => row[coreEnd + 1].length).length < 2 ||
    !fields.some((row) => row[coreEnd + 2].length)
  )
    return
  for (const i of body.filter((i) => i.height < h * 0.85)) {
    const r = recordOf(i),
      c = lane(i),
      peers = fields[r][c].filter(
        (a) =>
          a.height > i.height / 0.8 &&
          Math.abs(a.rect[2] - i.rect[0]) < i.height * 0.5 &&
          Math.abs(a.baseline - i.baseline) < a.height * 0.7
      )
    if (peers.length !== 1) return
  }
  const domains = starts.map((_, c) => box([...headings[c], ...fields.flatMap((row) => row[c])]))
  if (
    domains.slice(1).some((d, c) => d[0] - domains[c][2] < h * 0.2) ||
    items.some(
      (i) =>
        i.horizontal &&
        i.text.trim() &&
        i.baseline > opening[1] &&
        i.baseline < closing[1] &&
        i.rect[0] < opening[2] &&
        i.rect[2] > opening[0] &&
        !source.includes(i)
    ) ||
    new Set(source.map((i) => i.text + ':' + i.rect.join(':'))).size !== source.length
  )
    return
  return {
    cuts: [opening[0], ...domains.slice(1).map((d, c) => (domains[c][2] + d[0]) / 2), opening[2]],
    groups: [header, ...fields.map((row) => row.flat())],
    consumed: source,
    baselineHeight: h,
    repair: 'native-caption-width-literal-records-recovered',
    cropRect: [
      Math.min(crop[0], opening[0] - 0.5),
      crop[1],
      opening[2] + 0.5,
      Math.min(crop[3], closing[1] + 0.5)
    ]
  }
}

// Complete literal peers need their own native faces and first-line witnesses.
// Wrapped prose is admitted only when a printed sequential key independently
// starts every record; empty verdicts or unkeyed continuations remain ambiguous.
export function recoverNativeLiteralKeyedPeers(table, items, captions, rules, cells = []) {
  const frame = nativeHeaderFrame(table, items, rules)
  if (!frame) return
  const { h, opening, divider, closing, header, body, source } = frame
  const titles = captions.filter(
    (c) =>
      captionKind(c.lines?.[0]) === 'table' &&
      c.rect[0] < opening[2] &&
      c.rect[2] > opening[0] &&
      ((c.rect[3] <= opening[1] && opening[1] - c.rect[3] < h * 5) ||
        (c.rect[1] >= closing[1] && c.rect[1] - closing[1] < h * 5))
  )
  if (
    titles.length !== 1 ||
    header.some((i) => i.height < h * 0.85) ||
    physicalRows(header, h).length !== 1
  )
    return
  const headings = headerLeaves(header, h * (0.65 / 0.3))
  if (headings.length < 3 || headings.length > 6 || headings.some((g) => !/\p{L}/u.test(joined(g))))
    return
  const starts = headings.map((g) => box(g)[0]),
    lane = (i) => starts.findLastIndex((x) => i.rect[0] >= x - h * 0.02)
  if (source.some((i) => lane(i) < 0 || i.rect[2] > (starts[lane(i) + 1] ?? opening[2]) + 0.02))
    return
  const ordinary = body.filter((i) => i.height >= h * 0.85),
    bands = physicalRows(ordinary, h),
    key = (i) => /^([A-Z]{1,3})([1-9]\d*)(?:\s|$)/u.exec(i.text.trim()),
    keys = ordinary.filter((i) => lane(i) === 0 && key(i)).sort((a, b) => a.baseline - b.baseline),
    keyed =
      keys.length >= 3 &&
      keys.every(
        (i, n) =>
          key(i)[1] === key(keys[0])[1] &&
          Number(key(i)[2]) === n + 1 &&
          Math.abs(i.rect[0] - starts[0]) < h * 0.02
      ) &&
      keys.slice(1).every((i, n) => i.baseline - keys[n].baseline >= h * 0.75)
  const anchors = keyed ? keys : bands.map((g) => g[0])
  if (anchors.length < 3 || anchors.length > 50 || (!keyed && keys.length)) return
  // Complete ordinary baselines alone cannot subdivide a ruled record face:
  // every field may contain the same number of wrapped description lines.
  // Printed sequential keys remain an independent record witness.
  if (!keyed) {
    const fences = joinHorizontalTableRules(rules, 0.01).filter(
      (r) =>
        Math.abs(r[0] - opening[0]) < 0.7 &&
        Math.abs(r[2] - opening[2]) < 0.7 &&
        r[1] > divider[1] + 0.02 &&
        r[1] < closing[1] - 0.02
    )
    if (fences.length) {
      const faces = [divider[1], ...fences.map((r) => r[1]).sort((a, b) => a - b), closing[1]]
      if (
        faces
          .slice(1)
          .some(
            (end, n) => anchors.filter((i) => i.baseline > faces[n] && i.baseline < end).length > 1
          )
      )
        return
    }
  }
  const fields = anchors.map(() => headings.map(() => []))
  const recordOf = (i) => {
    if (keyed) return anchors.findLastIndex((a) => i.baseline >= a.baseline - h * 0.2)
    const matches = anchors
      .map((a, n) => ({ a, n }))
      .filter(({ a }) => Math.abs(i.baseline - a.baseline) < h * 0.02)
    return matches.length === 1 ? matches[0].n : -1
  }
  for (const i of ordinary) {
    const r = recordOf(i)
    if (r < 0) return
    fields[r][lane(i)].push(i)
  }
  if (
    fields.some((row, r) =>
      row.some(
        (g, c) =>
          !g.some(
            (i) =>
              Math.abs(i.baseline - anchors[r].baseline) < h * 0.02 &&
              Math.abs(i.rect[0] - starts[c]) < h * 0.02
          )
      )
    ) ||
    (!keyed && fields.some((row) => row.some((g) => physicalRows(g, h).length !== 1)))
  )
    return
  // A missing printed heading must not turn two independent first-line faces
  // into one glyph-conserving field. Each witnessed header start has exactly
  // one ordinary first-line island; wrapped keyed continuations stay literal.
  if (
    fields.some((row, r) =>
      row.some(
        (g) =>
          headerLeaves(
            g.filter((i) => Math.abs(i.baseline - anchors[r].baseline) < h * 0.02),
            h * (0.65 / 0.3)
          ).length !== 1
      )
    )
  )
    return
  const scriptParents = new Map()
  for (const i of body.filter((i) => i.height < h * 0.85)) {
    const r = recordOf(i),
      c = lane(i)
    if (r < 0) return
    const parents = fields[r][c].filter(
      (a) =>
        a.height > i.height / 0.8 &&
        Math.abs(a.baseline - i.baseline) < a.height * 0.7 &&
        Math.abs(a.rect[2] - i.rect[0]) < i.height * 0.5
    )
    if (parents.length !== 1) return
    scriptParents.set(i, parents[0])
    fields[r][c].push(i)
  }
  const domains = headings.map((g, c) => box([...g, ...fields.flatMap((row) => row[c])]))
  if (domains.slice(1).some((d, c) => d[0] - domains[c][2] < h * 0.2)) return
  const cuts = [
      opening[0],
      ...domains.slice(1).map((d, c) => (domains[c][2] + d[0]) / 2),
      opening[2]
    ],
    groups = [header, ...fields.map((row) => row.flat())]
  if (
    new Set(groups.flat()).size !== source.length ||
    groups.flat().length !== source.length ||
    new Set(source.map((i) => i.text + ':' + i.rect.join(':'))).size !== source.length ||
    items.some(
      (i) =>
        i.horizontal &&
        i.text.trim() &&
        i.baseline > opening[1] &&
        i.baseline < closing[1] &&
        i.rect[0] < opening[2] &&
        i.rect[2] > opening[0] &&
        !source.includes(i)
    )
  )
    return
  // A complete existing partition needs no reconstruction. This also retains
  // independently rich text when its actual native membership is already right.
  if (nativeCellPartitionComplete(cells, source, groups, lane, headings.length)) return
  return {
    cuts,
    groups,
    headerRows: 1,
    consumed: source,
    baselineHeight: h,
    scriptParents,
    repair: 'native-literal-keyed-peer-records-recovered',
    cropRect: [
      Math.min(table.cropRect[0], opening[0] - 0.5),
      table.cropRect[1],
      Math.max(table.cropRect[2], opening[2] + 0.5),
      Math.min(table.cropRect[3], closing[1] + 0.5)
    ]
  }
}

// Move an existing ordinary closing glyph only after the complete native
// ownership proves three disjoint column domains. The literal stub and scalar
// peer already belong to that same physical row; no script or value is inferred.
export function proveNativeStubClosingGlyphOwners(table, items, captions, rules, cells) {
  const frame = nativeHeaderFrame(table, items, rules)
  if (!frame) return
  const { h, opening, closing, source, header } = frame,
    first = cells.filter((c) => c.row === 0).sort((a, b) => a.column - b.column),
    titles = captions.filter(
      (c) =>
        captionKind(c.lines?.[0]) === 'table' &&
        c.rect[0] < opening[2] &&
        c.rect[2] > opening[0] &&
        ((c.rect[3] <= opening[1] && opening[1] - c.rect[3] < h * 5) ||
          (c.rect[1] >= closing[1] && c.rect[1] - closing[1] < h * 5))
    )
  if (
    titles.length !== 1 ||
    first.length !== 3 ||
    first.some((c, n) => c.column !== n || c.colSpan !== 1 || c.rowSpan !== 1) ||
    cells.some((c) => c.column + c.colSpan > 3) ||
    header.some((i) => i.height < h * 0.85)
  )
    return
  const matched = [],
    proposed = new Map(cells.map((c) => [c, [...(c.sourceTokens ?? [])]]))
  for (const cell of cells)
    for (const token of proposed.get(cell)) {
      const peers = source.filter((i) => i.text === token.text && sameRect(i.rect, token.rect))
      if (peers.length !== 1 || matched.includes(peers[0])) return
      matched.push(peers[0])
    }
  if (matched.length !== source.length) return
  const moves = []
  for (const donor of cells.filter(
    (c) => c.row > 0 && c.column === 1 && c.rowSpan === 1 && c.colSpan === 1
  )) {
    const tokens = proposed.get(donor),
      glyphs = tokens.filter((i) => i.text.trim() === ')' && i.height >= h * 0.85)
    if (
      glyphs.length !== 1 ||
      !/^[−+-]?\d+(?:\.\d+)?$/u.test(joined(tokens.filter((i) => i !== glyphs[0])))
    )
      continue
    const glyph = glyphs[0],
      targets = cells.filter(
        (c) => c.row === donor.row && c.column === 0 && c.rowSpan === 1 && c.colSpan === 1
      )
    if (targets.length !== 1) continue
    const target = targets[0],
      stub = proposed.get(target),
      scalar = tokens.filter((i) => i !== glyph)
    const ordinary = stub.filter(
      (i) => i.height >= h * 0.85 && Math.abs(i.baseline - glyph.baseline) < h * 0.02
    )
    if (
      !ordinary.length ||
      !ordinary.some((i) => i.text.includes('(')) ||
      !scalar.every((i) => Math.abs(i.baseline - glyph.baseline) < h * 0.02) ||
      glyph.rect[0] < Math.max(...stub.map((i) => i.rect[2])) - 0.02 ||
      glyph.rect[0] - Math.max(...stub.map((i) => i.rect[2])) > h * 0.5 ||
      Math.min(...scalar.map((i) => i.rect[0])) - glyph.rect[2] < h * 0.2
    )
      continue
    proposed.set(donor, scalar)
    proposed.set(target, [...stub, glyph])
    moves.push({ donor, target, glyph })
  }
  if (!moves.length) return
  const columns = first.map((_, n) =>
      cells.filter((c) => c.column === n && c.colSpan === 1).flatMap((c) => proposed.get(c))
    ),
    domains = columns.map(box)
  if (
    columns.some((g) => !g.length) ||
    domains.slice(1).some((d, n) => d[0] - domains[n][2] < h * 0.2)
  )
    return
  const cuts = [
    opening[0],
    ...domains.slice(1).map((d, n) => (domains[n][2] + d[0]) / 2),
    opening[2]
  ]
  if (
    cells.some(
      (c) =>
        c.colSpan === 1 &&
        proposed
          .get(c)
          .some((i) => i.rect[0] < cuts[c.column] - 0.02 || i.rect[2] > cuts[c.column + 1] + 0.02)
    )
  )
    return
  if (
    moves.some(
      ({ donor, target, glyph }) =>
        !nativeChangedCellOrigins(
          [donor],
          items,
          donor.sourceTokens.filter((i) => i !== glyph)
        ) || !nativeChangedCellOrigins([donor, target], items, [...target.sourceTokens, glyph])
    )
  )
    return
  return { moves, cuts, baselineHeight: h }
}

// Repair one already-owned descriptive run, not the table's row/leaf plan.
// Every native body token must already have one owner; repeated complete peer
// fields and the exact operator gap prove the only falsely empty recipient.
export function proveNativeDescriptiveRunOwners(table, items, captions, rules, runs, cells) {
  const frame = nativeHeaderFrame(table, items, rules)
  if (!frame) return
  const { h, header, body, source, opening, closing } = frame,
    same = (a, b) => a.text === b.text && sameRect(a.rect, b.rect),
    owned = cells.filter((c) => c.row > 0).flatMap((c) => c.sourceTokens ?? []),
    titles = captions.filter(
      (c) =>
        captionKind(c.lines?.[0]) === 'table' &&
        c.rect[0] < opening[2] &&
        c.rect[2] > opening[0] &&
        c.rect[3] <= opening[1] &&
        opening[1] - c.rect[3] < h * 5
    )
  if (
    titles.length !== 1 ||
    physicalRows(header, h).length !== 1 ||
    Math.max(...cells.map((c) => c.column + c.colSpan)) !== 7 ||
    owned.length !== body.length ||
    body.some((i) => owned.filter((t) => same(i, t)).length !== 1) ||
    owned.some((t) => body.filter((i) => same(i, t)).length !== 1) ||
    items.some(
      (i) =>
        i.horizontal &&
        i.text.trim() &&
        i.rect[3] > opening[1] &&
        i.rect[1] < closing[1] &&
        i.rect[2] > opening[0] &&
        i.rect[0] < opening[2] &&
        !source.includes(i)
    )
  )
    return
  const heads = cells.filter((c) => c.row === 0 && c.column < 2).sort((a, b) => a.column - b.column)
  if (
    heads.length !== 2 ||
    heads.some(
      (c, n) =>
        c.column !== n ||
        c.colSpan !== 1 ||
        c.rowSpan !== 1 ||
        c.sourceTokens?.length !== 1 ||
        header.filter((i) => same(i, c.sourceTokens[0])).length !== 1
    )
  )
    return
  const starts = heads.map((c) => c.sourceTokens[0].rect[0]),
    rowIds = [...new Set(cells.filter((c) => c.row > 0).map((c) => c.row))].sort((a, b) => a - b),
    first = (row) => cells.find((c) => c.row === row && c.column === 0),
    second = (row) => cells.find((c) => c.row === row && c.column === 1),
    peers = rowIds.filter(
      (row) =>
        [first(row), second(row)].every(
          (c, n) =>
            c &&
            c.rowSpan === 1 &&
            c.colSpan === 1 &&
            c.sourceTokens?.length === 1 &&
            c.sourceTokens[0].height >= h * 0.85 &&
            /\p{L}/u.test(c.text) &&
            Math.abs(c.sourceTokens[0].rect[0] - starts[n]) < 0.02
        ) &&
        Math.abs(first(row).sourceTokens[0].baseline - second(row).sourceTokens[0].baseline) < 0.02
    )
  if (peers.length < 3) return
  const gutter = [
    Math.max(...peers.map((r) => first(r).sourceTokens[0].rect[2])),
    Math.min(...peers.map((r) => second(r).sourceTokens[0].rect[0]))
  ]
  if (gutter[1] - gutter[0] < h * 0.3) return
  const candidates = rowIds.filter(
    (row) =>
      first(row)?.sourceTokens?.length === 0 &&
      !first(row).text &&
      first(row).rowSpan === 1 &&
      first(row).colSpan === 1 &&
      second(row)?.sourceTokens?.length === 1 &&
      second(row).rowSpan === 1 &&
      second(row).colSpan === 1
  )
  if (candidates.length !== 1 || candidates.length + peers.length !== rowIds.length) return
  const row = candidates[0],
    target = first(row),
    donor = second(row),
    native = donor.sourceTokens[0]
  if (
    Math.abs(native.rect[0] - starts[0]) > 0.02 ||
    cells.filter((c) => (c.sourceTokens ?? []).some((i) => same(i, native))).length !== 1
  )
    return
  const parts = splitObserved(native, runs, [gutter], h)
  if (
    !parts ||
    parts.length !== 2 ||
    parts.some((i, n) => !/\p{L}/u.test(i.text) || Math.abs(i.rect[0] - starts[n]) > 0.02)
  )
    return
  const scalarPeers = cells.filter((c) => c.row === row && c.column >= 2 && c.column <= 5)
  if (
    scalarPeers.length !== 4 ||
    scalarPeers.some(
      (c) =>
        c.rowSpan !== 1 ||
        c.colSpan !== 1 ||
        c.sourceTokens?.length !== 1 ||
        Math.abs(c.sourceTokens[0].baseline - native.baseline) > 0.02
    ) ||
    parts[1].rect[2] >= Math.min(...scalarPeers.map((c) => c.sourceTokens[0].rect[0]))
  )
    return
  return { target, donor, parts, cut: (parts[0].rect[2] + parts[1].rect[0]) / 2, baselineHeight: h }
}

// These final-owner repairs only inspect an isolated three-edge literal frame.
// They do not admit incomplete records or change the generic peer threshold.
function finalLiteralOwnerFrame(table, items, captions, rules, allowSmallScripts = false) {
  if (table.notes?.length || table.readingRotation) return
  const frame = nativeHeaderFrame(table, items, rules)
  if (!frame) return
  const { h, opening, divider, closing, source } = frame,
    edges = joinHorizontalTableRules(rules, 0.01, 0).filter(
      (r) =>
        r[1] >= table.cropRect[1] - h &&
        r[1] <= table.cropRect[3] + h &&
        Math.abs(r[0] - table.cropRect[0]) < h * 2 &&
        Math.abs(r[2] - table.cropRect[2]) < h * 2
    ),
    titles = captions.filter(
      (c) =>
        captionKind(c.lines?.[0]) === 'table' &&
        c.rect[3] <= opening[1] &&
        opening[1] - c.rect[3] < h * 5 &&
        c.rect[0] < opening[2] &&
        c.rect[2] > opening[0]
    ),
    ink = items.filter(
      (i) =>
        i.horizontal &&
        i.text.trim() &&
        i.rect[3] > opening[1] &&
        i.rect[1] < closing[1] &&
        i.rect[2] > opening[0] &&
        i.rect[0] < opening[2]
    )
  if (
    titles.length !== 1 ||
    edges.length !== 3 ||
    edges.some((r) => Math.abs(r[0] - opening[0]) > 0.02 || Math.abs(r[2] - opening[2]) > 0.02) ||
    rules.some(
      (r) =>
        Math.abs(r[0] - r[2]) < 0.01 &&
        r[0] > opening[0] + 0.02 &&
        r[0] < opening[2] - 0.02 &&
        Math.max(r[1], r[3]) > opening[1] &&
        Math.min(r[1], r[3]) < closing[1]
    ) ||
    source.length !== ink.length ||
    ink.some((i) => !source.includes(i)) ||
    new Set(source.map((i) => i.text + ':' + i.rect.join(':'))).size !== source.length ||
    source.some(
      (i) =>
        !i.rect.every(Number.isFinite) ||
        i.rect[0] < opening[0] - 0.02 ||
        i.rect[2] > opening[2] + 0.02 ||
        i.rect[1] < opening[1] ||
        i.rect[3] > closing[1] ||
        i.height <= 0 ||
        (!allowSmallScripts && i.height < h * 0.75) ||
        i.height > h * 1.05
    ) ||
    frame.header.length + frame.body.length !== source.length ||
    source.some((i) => i.rect[1] < divider[1] && i.rect[3] > divider[1])
  )
    return
  return frame
}

function literalOwnerMatches(cell, source) {
  const owned = cell?.sourceTokens ?? [],
    same = (a, b) =>
      a.text === b.text &&
      sameRect(a.rect, b.rect) &&
      Math.abs(a.baseline - b.baseline) < 0.02 &&
      Math.abs(a.height - b.height) < 0.02
  return (
    cell?.rowSpan === 1 &&
    cell.colSpan === 1 &&
    owned.length === source.length &&
    cell.sourceRects?.length === owned.length &&
    owned.every((t) => cell.sourceRects.filter((r) => sameRect(t.rect, r)).length === 1) &&
    source.every((i) => owned.filter((t) => same(i, t)).length === 1) &&
    owned.every((t) => source.filter((i) => same(i, t)).length === 1) &&
    cell.text === joined(source)
  )
}

// A separate original peer and heading starts can calibrate a TJ boundary
// where a broad heading gutter also contains spaces inside literal fields.
// The existing final owners prove conservation, not their faulty model boxes.
export function proveNativeTjAnchorLiteralLeaves(table, items, captions, rules, runs = []) {
  const { cells, grid, rows, cropRect: crop } = table,
    oldColumns = grid?.[0]?.length
  if (
    table.unassigned?.length ||
    !cells?.length ||
    !runs.length ||
    !(grid?.length > 3) ||
    grid.some((r) => r.length !== oldColumns) ||
    rows?.length !== grid.length ||
    cells.some(
      (c) =>
        !Number.isInteger(c.row) ||
        !Number.isInteger(c.column) ||
        c.row < 0 ||
        c.row >= grid.length ||
        c.column < 0 ||
        c.rowSpan !== 1 ||
        !Number.isInteger(c.colSpan) ||
        c.colSpan < 1 ||
        c.column + c.colSpan > oldColumns
    )
  )
    return
  const frame = finalLiteralOwnerFrame(table, items, captions, rules)
  if (!frame) return
  const { h, opening, divider, closing, source, header, body } = frame,
    ink = items.filter(
      (i) =>
        i.text.trim() &&
        i.rect[3] > opening[1] &&
        i.rect[1] < closing[1] &&
        i.rect[2] > opening[0] &&
        i.rect[0] < opening[2]
    ),
    headings = [...header].sort((a, b) => a.rect[0] - b.rect[0]),
    bands = physicalRows(body, h),
    columns = headings.length
  if (
    columns < 3 ||
    columns > 14 ||
    oldColumns <= columns ||
    bands.length + 1 !== grid.length ||
    source.length !== ink.length ||
    ink.some((i) => !source.includes(i)) ||
    source.some(
      (i) =>
        !i.horizontal ||
        i.inlineSymbol ||
        i.sourceToken ||
        i.nativeLaneSplit ||
        i.text !== i.text.trim() ||
        !Number.isFinite(i.baseline) ||
        !Number.isFinite(i.height) ||
        Math.abs(i.height - h) > 0.02 ||
        Math.abs(i.rect[3] - i.rect[1] - h) > 0.02 ||
        i.rect[0] < crop[0] ||
        i.rect[2] > crop[2] ||
        i.rect[1] < crop[1] ||
        i.rect[3] > crop[3]
    ) ||
    physicalRows(headings, h).length !== 1 ||
    headings.some((i) => Math.abs(i.baseline - headings[0].baseline) > 0.02) ||
    headings.some((i, c) => c && i.rect[0] - headings[c - 1].rect[2] < h * 0.2) ||
    bands.some((g) => g.some((i) => Math.abs(i.baseline - g[0].baseline) > 0.02))
  )
    return
  const originalGroups = [headings, ...bands],
    same = (a, b) =>
      a.text === b.text &&
      a.baseline === b.baseline &&
      a.height === b.height &&
      a.rect.every((v, n) => v === b.rect[n]),
    sameBox = (a, b) => a.every((v, n) => v === b[n]),
    owned = new Map(),
    coverage = new Set()
  for (const c of cells) {
    if (
      !Array.isArray(c.sourceTokens) ||
      !Array.isArray(c.sourceRects) ||
      c.sourceTokens.length > 1 ||
      c.sourceTokens.length !== c.sourceRects.length ||
      c.textRuns?.length ||
      c.sourceTokens.some(
        (t) =>
          t.rect?.length !== 4 ||
          !t.rect.every(Number.isFinite) ||
          t.sourceToken ||
          t.nativeLaneSplit
      ) ||
      c.sourceRects.some((r) => r?.length !== 4 || !r.every(Number.isFinite)) ||
      c.sourceTokens.some((t) => c.sourceRects.filter((r) => sameBox(t.rect, r)).length !== 1) ||
      c.sourceRects.some((r) => c.sourceTokens.filter((t) => sameBox(t.rect, r)).length !== 1) ||
      c.text !== c.sourceTokens.map((t) => t.text).join(' ')
    )
      return
    for (let column = c.column; column < c.column + c.colSpan; column++) {
      const slot = c.row + ':' + column
      if (coverage.has(slot) || grid[c.row][column] !== (column === c.column ? c.text : '')) return
      coverage.add(slot)
    }
    for (const token of c.sourceTokens) {
      const matches = source.filter((i) => same(i, token))
      if (
        matches.length !== 1 ||
        owned.has(matches[0]) ||
        !originalGroups[c.row].includes(matches[0])
      )
        return
      owned.set(matches[0], token)
    }
  }
  if (owned.size !== source.length || coverage.size !== grid.length * oldColumns) return
  const observed = new Map()
  for (const item of source) {
    const matches = runs.filter(
        (r) => r.text === item.text && r.rect?.length === 4 && sameBox(r.rect, item.rect)
      ),
      glyphs = [...item.text.replace(/\s/gu, '')]
    if (matches.length !== 1) return
    const r = matches[0]
    if (
      r.baseline !== item.baseline ||
      r.height !== item.height ||
      !Array.isArray(r.literalGlyphs) ||
      !Array.isArray(r.glyphRuns) ||
      !Array.isArray(r.gaps) ||
      r.literalGlyphs.length !== glyphs.length ||
      r.literalGlyphs.some((g, n) => g !== glyphs[n]) ||
      r.glyphRuns.length !== glyphs.length ||
      new Set(r.glyphRuns).size !== 1 ||
      r.glyphRuns.some((n) => !Number.isInteger(n)) ||
      r.gaps.some(
        (g) =>
          !Number.isInteger(g.index) ||
          g.index <= 0 ||
          g.index >= glyphs.length ||
          !Number.isFinite(g.left) ||
          !Number.isFinite(g.right) ||
          g.left >= g.right ||
          g.left < item.rect[0] ||
          g.right > item.rect[2]
      ) ||
      new Set(r.gaps.map((g) => g.index)).size !== r.gaps.length
    )
      return
    const ordered = [...r.gaps].sort((a, b) => a.index - b.index)
    if (ordered.some((g, n) => n && g.left < ordered[n - 1].right)) return
    observed.set(item, r)
  }
  const starts = headings.map((i) => i.rect[0]),
    peers = bands.filter(
      (g) =>
        g.length === columns &&
        [...g]
          .sort((a, b) => a.rect[0] - b.rect[0])
          .every((i, c) => Math.abs(i.rect[0] - starts[c]) < 0.02)
    )
  if (!peers.length) return
  const records = [],
    selectedGaps = []
  for (const band of bands) {
    const parts = []
    for (const item of [...band].sort((a, b) => a.rect[0] - b.rect[0])) {
      const targets = starts
          .slice(1)
          .filter((x) => item.rect[0] < x - 0.02 && item.rect[2] > x + 0.02),
        r = observed.get(item),
        chosen = []
      for (const x of targets) {
        const matches = r.gaps.filter((g) => Math.abs(g.right - x) < 0.02)
        if (matches.length !== 1 || matches[0].right - matches[0].left < h * 0.15) return
        chosen.push(matches[0])
      }
      if (!chosen.length) {
        parts.push(owned.get(item))
        continue
      }
      if (new Set(chosen.map((g) => g.index)).size !== chosen.length) return
      const characters = [...item.text],
        whitespace = new Set()
      let count = 0
      for (let n = 0; n < characters.length; n++) {
        if (/\s/u.test(characters[n])) continue
        if (n && /\s/u.test(characters[n - 1])) whitespace.add(count)
        count++
      }
      if (chosen.some((g) => !whitespace.has(g.index))) return
      chosen.sort((a, b) => a.index - b.index)
      const split = splitObserved(
        owned.get(item),
        runs,
        chosen.map((g) => [g.left, g.right]),
        h
      )
      if (
        !split ||
        split.length !== chosen.length + 1 ||
        split.map((p) => p.text.replace(/\s/gu, '')).join('') !== r.literalGlyphs.join('') ||
        split.some(
          (p, n) =>
            p.rect[0] !== (n ? chosen[n - 1].right : item.rect[0]) ||
            p.rect[2] !== (n < chosen.length ? chosen[n].left : item.rect[2]) ||
            p.rect[2] <= p.rect[0]
        )
      )
        return
      parts.push(...split)
      selectedGaps.push(...chosen)
    }
    const record = parts.sort((a, b) => a.rect[0] - b.rect[0])
    if (record.length !== columns || record.some((i, c) => Math.abs(i.rect[0] - starts[c]) >= 0.02))
      return
    records.push(record)
  }
  if (!selectedGaps.length) return
  const groups = [headings.map((i) => owned.get(i)), ...records],
    domains = Array.from({ length: columns }, (_, c) => box(groups.map((g) => g[c]))),
    cuts = [crop[0], ...domains.slice(1).map((d, c) => (domains[c][2] + d[0]) / 2), crop[2]],
    rowRects = groups.map((g) => [crop[0], box(g)[1], crop[2], box(g)[3]])
  if (
    domains.some((d, c) => c && d[0] - domains[c - 1][2] < h * 0.2) ||
    groups.some((g) => g.some((i, c) => i.rect[0] < cuts[c] || i.rect[2] > cuts[c + 1])) ||
    rowRects.some((r, n) => n && r[1] <= rowRects[n - 1][3]) ||
    rowRects[0][3] >= divider[1] ||
    rowRects[1][1] <= divider[1]
  )
    return
  return { cuts, groups, rowRects, baselineHeight: h }
}

// A correctly separated native pair can calibrate complete peer records in
// other closed groups. Split their coarse existing owners only at empty ink
// corridors, preserving the original token objects and correct row payloads.
export function proveNativeFencedPairedRecordOwners(table, items, captions, rules) {
  const { cells, grid, rows, cropRect: crop } = table,
    columns = grid?.[0]?.length
  if (
    table.notes?.length ||
    table.readingRotation ||
    table.unassigned?.length ||
    !(columns >= 4) ||
    !(grid?.length > 3) ||
    grid.some((r) => r.length !== columns) ||
    rows?.length !== grid.length ||
    !cells?.length ||
    rows.some(
      (r) => r.rect?.length !== 4 || !r.rect.every(Number.isFinite) || r.rect[3] <= r.rect[1]
    ) ||
    cells.some(
      (c) =>
        !Number.isInteger(c.row) ||
        !Number.isInteger(c.column) ||
        !Number.isInteger(c.rowSpan) ||
        !Number.isInteger(c.colSpan) ||
        c.row < 0 ||
        c.column < 0 ||
        c.rowSpan < 1 ||
        c.colSpan < 1 ||
        c.row + c.rowSpan > grid.length ||
        c.column + c.colSpan > columns ||
        c.rect?.length !== 4 ||
        !c.rect.every(Number.isFinite) ||
        c.rect[0] >= c.rect[2] ||
        c.rect[1] >= c.rect[3]
    )
  )
    return
  const frame = nativeHeaderFrame(table, items, rules)
  if (!frame) return
  const { h, opening, divider, closing, source, header, body } = frame,
    horizontal = joinHorizontalTableRules(rules, 0.01, 0),
    inside = horizontal.filter(
      (r) => r[1] >= opening[1] && r[1] <= closing[1] && r[2] > opening[0] && r[0] < opening[2]
    ),
    fences = inside
      .filter((r) => Math.abs(r[0] - opening[0]) < 0.02 && Math.abs(r[2] - opening[2]) < 0.02)
      .sort((a, b) => a[1] - b[1]),
    partials = inside.filter((r) => !fences.includes(r)),
    titles = captions.filter(
      (c) =>
        captionKind(c.lines?.[0]) === 'table' &&
        c.rect[3] <= opening[1] &&
        opening[1] - c.rect[3] < h * 5 &&
        c.rect[0] < opening[2] &&
        c.rect[2] > opening[0]
    ),
    ink = items.filter(
      (i) =>
        i.text.trim() &&
        i.rect[3] > opening[1] &&
        i.rect[1] < closing[1] &&
        i.rect[2] > opening[0] &&
        i.rect[0] < opening[2]
    )
  if (
    titles.length !== 1 ||
    fences.length < 4 ||
    !sameRect(fences[0], opening) ||
    !sameRect(fences[1], divider) ||
    !sameRect(fences.at(-1), closing) ||
    fences.some((r, n) => n && r[1] - fences[n - 1][1] < h) ||
    !partials.length ||
    partials.some(
      (r) => r[1] <= opening[1] || r[1] >= divider[1] || r[0] < opening[0] || r[2] > opening[2]
    ) ||
    rules.some(
      (r) =>
        Math.abs(r[0] - r[2]) < 0.01 &&
        r[0] > opening[0] &&
        r[0] < opening[2] &&
        Math.max(r[1], r[3]) > opening[1] &&
        Math.min(r[1], r[3]) < closing[1]
    ) ||
    source.length !== ink.length ||
    ink.some((i) => !source.includes(i)) ||
    source.some(
      (i) =>
        !i.horizontal ||
        !i.rect.every(Number.isFinite) ||
        !Number.isFinite(i.baseline) ||
        !Number.isFinite(i.height) ||
        Math.abs(i.height - h) > 0.02 ||
        Math.abs(i.rect[3] - i.rect[1] - i.height) > 0.02 ||
        i.rect[0] >= i.rect[2] ||
        i.rect[1] < opening[1] ||
        i.rect[3] > closing[1] ||
        i.rect[0] < crop[0] ||
        i.rect[2] > crop[2]
    )
  )
    return
  const same = (a, b) =>
      a.text === b.text &&
      a.baseline === b.baseline &&
      a.height === b.height &&
      a.rect.every((v, n) => v === b.rect[n]),
    sameBox = (a, b) => a.every((v, n) => v === b[n]),
    fullInside = (i, r) =>
      i.rect[0] >= r[0] && i.rect[2] <= r[2] && i.rect[1] >= r[1] && i.rect[3] <= r[3],
    owned = new Map(),
    used = new Set()
  // Both rectangle/token directions are necessary, including empty owners.
  for (const c of cells) {
    if (
      !Array.isArray(c.sourceTokens) ||
      !Array.isArray(c.sourceRects) ||
      c.sourceTokens.length !== c.sourceRects.length ||
      c.sourceTokens.some((t) => t.rect?.length !== 4 || !t.rect.every(Number.isFinite)) ||
      c.sourceRects.some((r) => r?.length !== 4 || !r.every(Number.isFinite)) ||
      c.sourceTokens.some((t) => c.sourceRects.filter((r) => sameBox(r, t.rect)).length !== 1) ||
      c.sourceRects.some((r) => c.sourceTokens.filter((t) => sameBox(r, t.rect)).length !== 1) ||
      c.textRuns?.some((r) => r.position !== 'normal') ||
      (c.textRuns && c.textRuns.map((r) => r.text).join('') !== c.text)
    )
      return
    for (const token of c.sourceTokens) {
      const matches = source.filter((i) => same(i, token))
      if (matches.length !== 1 || used.has(matches[0]) || !fullInside(matches[0], c.rect)) return
      used.add(matches[0])
      owned.set(matches[0], { cell: c, token })
    }
  }
  if (used.size !== source.length) return
  const levels = []
  for (const r of [...partials].sort((a, b) => a[1] - b[1]))
    if (!levels.some((y) => Math.abs(y - r[1]) < 0.02)) levels.push(r[1])
  const headerRows = levels.length + 1,
    headerCells = cells.filter((c) => c.row < headerRows),
    coverage = new Set()
  if (
    headerRows >= grid.length ||
    headerCells.some(
      (c) =>
        c.row + c.rowSpan > headerRows ||
        c.sourceTokens.some((t) => !header.some((i) => same(i, t))) ||
        joined(c.sourceTokens) !== c.text
    )
  )
    return
  for (const c of headerCells)
    for (let r = c.row; r < c.row + c.rowSpan; r++)
      for (let col = c.column; col < c.column + c.colSpan; col++) {
        const slot = r + ':' + col
        if (coverage.has(slot) || grid[r][col] !== (r === c.row && col === c.column ? c.text : ''))
          return
        coverage.add(slot)
      }
  if (
    coverage.size !== headerRows * columns ||
    header.some((i) => !headerCells.includes(owned.get(i)?.cell))
  )
    return
  for (const r of partials)
    if (
      headerCells.filter(
        (c) =>
          c.colSpan > 1 &&
          Math.abs(c.rect[3] - r[1]) < 0.02 &&
          c.rect[0] <= r[0] &&
          c.rect[2] >= r[2]
      ).length !== 1
    )
      return
  if (
    headerCells
      .filter((c) => c.colSpan > 1)
      .some(
        (c) =>
          partials.filter(
            (r) => Math.abs(c.rect[3] - r[1]) < 0.02 && c.rect[0] <= r[0] && c.rect[2] >= r[2]
          ).length !== 1
      )
  )
    return
  for (const [n, r] of rows.slice(0, headerRows).entries())
    if (Math.abs(r.rect[3] - (levels[n] ?? divider[1])) > 0.02) return
  const groups = []
  for (let n = 1; n < fences.length - 1; n++) {
    const top = fences[n][1],
      bottom = fences[n + 1][1],
      native = body.filter((i) => i.rect[1] > top && i.rect[3] < bottom),
      pair = physicalRows(native, h)
    if (
      pair.length !== 2 ||
      native.some((i) => Math.abs(i.baseline - pair.find((p) => p.includes(i))[0].baseline) > 0.02)
    )
      return
    const fields = pair.map((record) => {
      const result = []
      for (const i of [...record].sort((a, b) => a.rect[0] - b.rect[0])) {
        const last = result.at(-1)
        if (last && i.rect[0] - box(last)[2] < h * 0.5) last.push(i)
        else result.push([i])
      }
      return result
    })
    if (fields[0].length !== columns || fields[1].length !== columns - 1) return
    const inkBoxes = pair.map(box)
    if (!(inkBoxes[0][3] < inkBoxes[1][1])) return
    groups.push({ top, bottom, pair, fields, split: (inkBoxes[0][3] + inkBoxes[1][1]) / 2 })
  }
  if (groups.flatMap((g) => g.pair.flat()).length !== body.length) return
  const domains = Array.from({ length: columns }, (_, column) =>
      box(groups.flatMap((g) => g.fields[0][column]))
    ),
    cuts = [crop[0], ...domains.slice(1).map((d, n) => (domains[n][2] + d[0]) / 2), crop[2]]
  if (domains.some((d, n) => n && d[0] - domains[n - 1][2] < h * 0.3)) return
  const records = [],
    membership = new Map()
  for (const [n, g] of groups.entries())
    for (const [peer, fields] of g.fields.entries()) {
      const projected = Array.from({ length: columns }, () => [])
      for (const field of fields) {
        const r = box(field),
          lanes = cuts.slice(1).flatMap((right, c) => (r[0] >= cuts[c] && r[2] <= right ? [c] : []))
        if (lanes.length !== 1 || projected[lanes[0]].length) return
        projected[lanes[0]] = field
      }
      if (
        projected.slice(1).some((f) => !f.length) ||
        (peer === 0 ? !projected[0].length : projected[0].length)
      )
        return
      const index = records.length
      for (const [column, field] of projected.entries())
        for (const i of field) {
          if (membership.has(i) || owned.get(i)?.cell.column !== column) return
          membership.set(i, { index, column })
        }
      records.push({ group: n, peer, baseline: g.pair[peer][0].baseline, fields: projected })
    }
  const projections = []
  let next = 0
  for (let row = headerRows; row < grid.length; row++) {
    const donors = cells.filter((c) => c.row === row).sort((a, b) => a.column - b.column)
    if (
      donors.length !== columns ||
      donors.some(
        (c, n) =>
          c.column !== n ||
          c.rowSpan !== 1 ||
          c.colSpan !== 1 ||
          c.textRuns?.length ||
          Math.abs(c.rect[1] - rows[row].rect[1]) > 0.02 ||
          Math.abs(c.rect[3] - rows[row].rect[3]) > 0.02 ||
          grid[row][n] !== c.text
      )
    )
      return
    const native = source.filter((i) => donors.includes(owned.get(i)?.cell))
    if (native.some((i) => !membership.has(i))) return
    const indices = [...new Set(native.map((i) => membership.get(i).index))].sort((a, b) => a - b)
    if (
      !indices.length ||
      indices.length > 2 ||
      indices.some((index, n) => index !== next + n) ||
      indices.some((index) => records[index].group !== records[indices[0]].group)
    )
      return
    for (const [column, c] of donors.entries()) {
      const expected = indices.flatMap((index) => records[index].fields[column]),
        actual = source.filter((i) => owned.get(i)?.cell === c)
      if (
        expected.length !== actual.length ||
        expected.some((i) => !actual.includes(i)) ||
        indices
          .map((index) => joined(records[index].fields[column]))
          .filter(Boolean)
          .join(' ') !== c.text
      )
        return
    }
    const split = indices.length === 2 ? groups[records[indices[0]].group].split : undefined
    if (split !== undefined && (split <= rows[row].rect[1] || split >= rows[row].rect[3])) return
    projections.push({ oldRow: row, newRow: headerRows + next, indices, donors, split })
    next += indices.length
  }
  if (next !== records.length || !projections.some((p) => p.indices.length === 2)) return
  const correctGroup = groups.findIndex(
    (g, n) =>
      projections.filter((p) => p.indices.length === 1 && records[p.indices[0]].group === n)
        .length === 2
  )
  if (correctGroup < 0) return
  const calibration = groups[correctGroup],
    reference = records.filter((r) => r.group === correctGroup),
    keyTexts = reference.map((r) => joined(r.fields[1])),
    keyBoxes = reference.map((r) => box(r.fields[1])),
    offsets = reference.map((r) => r.baseline - calibration.top)
  if (keyTexts[0] === keyTexts[1]) return
  for (const [n, g] of groups.entries())
    for (const [peer, r] of records.filter((r) => r.group === n).entries())
      if (
        joined(r.fields[1]) !== keyTexts[peer] ||
        Math.abs(r.baseline - g.top - offsets[peer]) > 0.02 ||
        Math.abs(box(r.fields[1])[0] - keyBoxes[peer][0]) > 0.02 ||
        Math.abs(box(r.fields[1])[2] - keyBoxes[peer][2]) > 0.02
      )
        return
  for (const p of projections)
    if (p.split !== undefined)
      for (const [peer, index] of p.indices.entries())
        for (const [column, field] of records[index].fields.entries()) {
          const rect = [...p.donors[column].rect]
          rect[peer ? 1 : 3] = p.split
          if (
            field.some((i) => !fullInside(i, rect)) ||
            !nativeChangedCellOrigins([p.donors[column]], items, field)
          )
            return
        }
  return {
    headerRows,
    records: records.map((r) => r.fields.map((field) => field.map((i) => owned.get(i).token))),
    projections,
    baselineHeight: h
  }
}

// Centered literal scalar/interval pairs need their two physical baselines in
// one record. Native heading/body gutters prove the leaves before model cuts
// are checked; predicted rows do not establish record identity.
export function recoverNativePairedLiteralRowBands(table, items, captions, rules, runs = []) {
  if (table.readingRotation || !table.structure?.objects?.length || !runs.length) return
  const frame = nativeHeaderFrame(table, items, rules)
  if (!frame) return
  const { h, opening, divider, closing, source, header, body } = frame,
    horizontal = joinHorizontalTableRules(rules, 0.01, 0),
    ink = items.filter(
      (i) =>
        i.text.trim() &&
        i.rect[2] > opening[0] &&
        i.rect[0] < opening[2] &&
        i.rect[3] > opening[1] &&
        i.rect[1] < closing[1]
    ),
    titles = captions.filter(
      (c) =>
        captionKind(c.lines?.[0]) === 'table' &&
        c.rect[0] < opening[2] &&
        c.rect[2] > opening[0] &&
        ((c.rect[3] <= opening[1] && opening[1] - c.rect[3] < h * 8) ||
          (c.rect[1] >= closing[1] && c.rect[1] - closing[1] < h * 4))
    )
  if (
    titles.length !== 1 ||
    ink.length !== source.length ||
    ink.some((i) => !i.horizontal || !source.includes(i)) ||
    new Set(source.map((i) => i.text + ':' + i.rect.join(':'))).size !== source.length ||
    source.some(
      (i) =>
        !i.rect.every(Number.isFinite) ||
        !Number.isFinite(i.baseline) ||
        !(i.height > 0) ||
        i.rect[0] < opening[0] - 0.02 ||
        i.rect[2] > opening[2] + 0.02 ||
        i.rect[1] <= opening[1] ||
        i.rect[3] >= closing[1] ||
        i.rect.some((v, n) => (n < 2 ? v < table.cropRect[n] : v > table.cropRect[n]))
    ) ||
    rules.some(
      (r) =>
        Math.abs(r[0] - r[2]) < 0.01 &&
        r[0] > opening[0] &&
        r[0] < opening[2] &&
        Math.max(r[1], r[3]) > opening[1] &&
        Math.min(r[1], r[3]) < closing[1]
    )
  )
    return
  for (const item of source) {
    const matches = runs.filter((r) => r.text === item.text && sameRect(r.rect, item.rect))
    if (
      matches.length !== 1 ||
      matches[0].baseline !== item.baseline ||
      matches[0].height !== item.height ||
      !matches[0].glyphRuns?.length ||
      new Set(matches[0].glyphRuns).size !== 1 ||
      matches[0].literalGlyphs?.join('') !== item.text.replace(/\s/gu, '')
    )
      return
  }
  const marks = body.filter((i) => /^[†∗*]$/u.test(i.text)),
    ordinary = body.filter((i) => !marks.includes(i)),
    bands = physicalRows(ordinary, h),
    headBands = physicalRows(header, h)
  if (
    ordinary.some((i) => i.height < h - 0.02 || i.height > h * 1.5) ||
    bands.length < 6 ||
    bands.length % 2 ||
    headBands.length < 1 ||
    headBands.length > 2 ||
    [...bands, ...headBands].some((g) => g.some((i) => Math.abs(i.baseline - g[0].baseline) > 0.02))
  )
    return
  const firstLower = headerLeaves(bands[1], h),
    columns = firstLower.length,
    keyCount = columns - headerLeaves(bands[0], h).length,
    heads = headerLeaves(headBands.at(-1), h)
  if (columns < 3 || keyCount < 1 || keyCount > 2 || heads.length !== columns) return
  const records = []
  for (let band = 0; band < bands.length; band += 2) {
    const upper = headerLeaves(bands[band], h),
      lower = headerLeaves(bands[band + 1], h)
    if (
      upper.length !== columns - keyCount ||
      lower.length !== columns ||
      lower.slice(0, keyCount).some((g) => !/\p{L}/u.test(joined(g)))
    )
      return
    for (let column = 0; column < upper.length; column++) {
      const top = upper[column],
        bottom = lower[column + keyCount],
        a = box(top),
        b = box(bottom)
      if (
        !/^[+−-]?\d+(?:\.\d+)?$/u.test(joined(top)) ||
        !/^\[\s*[+−-]?\d+(?:\.\d+)?\s*,\s*[+−-]?\d+(?:\.\d+)?\s*\]$/u.test(joined(bottom)) ||
        Math.abs((a[0] + a[2] - b[0] - b[2]) / 2) >= Math.max(...top.map((i) => i.height)) * 0.02 ||
        a[3] >= b[1]
      )
        return
    }
    records.push({
      fields: lower.map((g, n) => (n < keyCount ? g : [...upper[n - keyCount], ...g]))
    })
  }
  for (const mark of marks) {
    const parents = records.flatMap((r, row) =>
      r.fields
        .slice(0, keyCount)
        .flatMap((g, column) =>
          g
            .filter(
              (i) =>
                isAdjacentTableScript(mark, i) &&
                mark.height >= i.height * 0.5 &&
                mark.height < i.height * 0.8
            )
            .map((parent) => ({ row, column, parent }))
        )
    )
    if (parents.length !== 1) return
    const { row, column } = parents[0]
    records[row].fields[column].push(mark)
  }
  const domains = Array.from({ length: columns }, (_, n) =>
      box([...heads[n], ...records.flatMap((r) => r.fields[n])])
    ),
    bodyDomains = Array.from({ length: columns }, (_, n) =>
      box(records.flatMap((r) => r.fields[n]))
    ),
    consumed = records.flatMap((r) => r.fields.flat())
  if (
    consumed.length !== body.length ||
    new Set(consumed).size !== body.length ||
    body.some((i) => !consumed.includes(i)) ||
    domains.slice(1).some((d, n) => d[0] - domains[n][2] < h * 0.3)
  )
    return
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (
    predicted.length !== columns ||
    predicted.some(
      (c) => !c.rect?.every(Number.isFinite) || c.rect[0] >= c.rect[2] || c.rect[1] >= c.rect[3]
    ) ||
    predicted.slice(1).some((c, n) => {
      const cut = table.cropRect[0] + (predicted[n].rect[2] + c.rect[0]) / 2
      // Header owners are already independently proved by their printed leaves
      // and partial rules. Their coarse model boxes do not bound body ownership.
      return cut <= bodyDomains[n][2] || cut >= bodyDomains[n + 1][0]
    })
  )
    return
  const partial = horizontal.filter(
      (r) => r[1] > opening[1] && r[1] < divider[1] && r[0] < opening[2] && r[2] > opening[0]
    ),
    parentWitnesses = []
  for (const group of headBands.slice(0, -1)) {
    for (const parent of headerLeaves(group, h)) {
      const p = box(parent),
        candidates = []
      for (const rule of partial) {
        const covered = heads.flatMap((g, n) => {
          const d = box(g)
          return d[0] >= rule[0] - 0.02 && d[2] <= rule[2] + 0.02 && d[1] > rule[1] ? [n] : []
        })
        if (
          p[0] >= rule[0] &&
          p[2] <= rule[2] &&
          p[3] < rule[1] &&
          covered.length >= 2 &&
          covered.every((n, i) => !i || n === covered[i - 1] + 1)
        )
          candidates.push(rule)
      }
      if (candidates.length !== 1 || parentWitnesses.includes(candidates[0])) return
      parentWitnesses.push(candidates[0])
    }
  }
  if (parentWitnesses.length !== partial.length) return
  const boxes = records.map((r) => box(r.fields.flat()))
  if (boxes.slice(1).some((r, n) => r[1] <= boxes[n][3]) || box(header)[3] >= boxes[0][1]) return
  for (const rule of horizontal.filter(
    (r) => r[1] > divider[1] && r[1] < closing[1] && r[0] < opening[2] && r[2] > opening[0]
  )) {
    if (
      Math.abs(rule[0] - opening[0]) > 0.02 ||
      Math.abs(rule[2] - opening[2]) > 0.02 ||
      !boxes.slice(1).some((r, n) => rule[1] > boxes[n][3] && rule[1] < r[1])
    )
      return
  }
  const crop = table.cropRect,
    headerCuts = [
      opening[1],
      ...headBands.slice(1).map((g, n) => (box(headBands[n])[3] + box(g)[1]) / 2),
      divider[1]
    ],
    recordCuts = [
      boxes[0][1],
      ...boxes.slice(1).map((b, n) => (boxes[n][3] + b[1]) / 2),
      boxes.at(-1)[3]
    ],
    rows = [
      ...headBands.map((_, n) => [crop[0], headerCuts[n], crop[2], headerCuts[n + 1]]),
      ...boxes.map((_, n) => [crop[0], recordCuts[n], crop[2], recordCuts[n + 1]])
    ],
    oldRows = table.structure.objects
      .filter((o) => o.label === 'table row')
      .map((o) => o.rect.map((v, n) => v + crop[n % 2]))
      .sort((a, b) => a[1] - b[1])
  if (oldRows.length === rows.length && oldRows.every((r, n) => sameRect(r, rows[n]))) return
  return { rows }
}

// A single printed label belongs to a complete native fenced record group.
// Short strokes count as underlines only when one exact ordinary field owns
// their full width; they cannot silently substitute for missing group fences.
export function proveNativeFencedSingleLineStubOwners(table, items, captions, rules) {
  return fencedSingleLineStubOwners(table, items, captions, rules)
}

function fencedSingleLineStubOwners(table, items, captions, rules, completePeerStart = false) {
  const { cells, grid, cropRect } = table,
    columns = grid?.[0]?.length
  if (
    table.notes?.length ||
    table.readingRotation ||
    !(grid?.length > 3) ||
    !(columns >= 3) ||
    grid.some((r) => r.length !== columns) ||
    !cells?.length ||
    cells.some(
      (c) =>
        !Number.isInteger(c.row) ||
        !Number.isInteger(c.column) ||
        c.row < 0 ||
        c.row >= grid.length ||
        c.column < 0 ||
        c.column >= columns ||
        c.colSpan !== 1 ||
        !Number.isInteger(c.rowSpan) ||
        c.rowSpan < 1 ||
        c.section ||
        !c.rect?.every(Number.isFinite) ||
        grid[c.row][c.column] !== c.text ||
        c.textRuns?.some((r) => r.position !== 'normal') ||
        (c.textRuns && c.textRuns.map((r) => r.text).join('') !== c.text)
    )
  )
    return
  const frame = nativeHeaderFrame(table, items, rules)
  if (!frame) return
  const { h, opening, divider, closing, source, header, body } = frame,
    horizontal = joinHorizontalTableRules(rules, 0.01, 0),
    fences = horizontal
      .filter(
        (r) =>
          r[1] >= opening[1] &&
          r[1] <= closing[1] &&
          Math.abs(r[0] - opening[0]) < 0.02 &&
          Math.abs(r[2] - opening[2]) < 0.02
      )
      .sort((a, b) => a[1] - b[1]),
    ink = items.filter(
      (i) =>
        i.text.trim() &&
        i.rect[2] > opening[0] &&
        i.rect[0] < opening[2] &&
        i.rect[3] > opening[1] &&
        i.rect[1] < closing[1]
    ),
    titles = captions.filter(
      (c) =>
        captionKind(c.lines?.[0]) === 'table' &&
        c.rect[0] < opening[2] &&
        c.rect[2] > opening[0] &&
        ((c.rect[1] >= closing[1] && c.rect[1] - closing[1] < h * 4) ||
          (c.rect[3] <= opening[1] && opening[1] - c.rect[3] < h * 8))
    )
  if (
    titles.length !== 1 ||
    fences.length < 4 ||
    !sameRect(fences[0], opening) ||
    !sameRect(fences[1], divider) ||
    !sameRect(fences.at(-1), closing) ||
    fences.some((r, n) => n && r[1] - fences[n - 1][1] < h) ||
    source.length !== ink.length ||
    ink.some((i) => !i.horizontal || !source.includes(i)) ||
    source.some(
      (i) =>
        !i.rect.every(Number.isFinite) ||
        !Number.isFinite(i.baseline) ||
        Math.abs(i.height - h) > 0.02 ||
        i.rect[0] < opening[0] - 0.02 ||
        i.rect[2] > opening[2] + 0.02 ||
        i.rect[1] <= opening[1] ||
        i.rect[3] >= closing[1] ||
        i.rect.some((v, n) => (n < 2 ? v < cropRect[n] : v > cropRect[n])) ||
        fences.some((r) => i.rect[1] < r[1] && i.rect[3] > r[1])
    ) ||
    physicalRows(header, h).length !== 1 ||
    rules.some(
      (r) =>
        Math.abs(r[0] - r[2]) < 0.01 &&
        r[0] > opening[0] &&
        r[0] < opening[2] &&
        Math.max(r[1], r[3]) > opening[1] &&
        Math.min(r[1], r[3]) < closing[1]
    )
  )
    return
  const same = (a, b) =>
      a.text === b.text &&
      sameRect(a.rect, b.rect) &&
      Math.abs(a.baseline - b.baseline) < 0.02 &&
      Math.abs(a.height - b.height) < 0.02,
    owned = new Map(),
    seen = new Set()
  for (const cell of cells) {
    if (
      !Array.isArray(cell.sourceTokens) ||
      !Array.isArray(cell.sourceRects) ||
      cell.sourceTokens.length !== cell.sourceRects.length ||
      cell.sourceTokens.some(
        (t) => cell.sourceRects.filter((r) => sameRect(r, t.rect)).length !== 1
      ) ||
      cell.sourceRects.some(
        (r) => cell.sourceTokens.filter((t) => sameRect(r, t.rect)).length !== 1
      )
    )
      return
    const natives = []
    for (const token of cell.sourceTokens) {
      const matches = source.filter((i) => same(i, token))
      if (matches.length !== 1 || seen.has(matches[0])) return
      seen.add(matches[0])
      natives.push(matches[0])
    }
    if (cell.text !== joined(natives)) return
    owned.set(cell, natives)
  }
  if (seen.size !== source.length) return
  const heads = headerLeaves(header, h)
  if (heads.length !== columns) return
  for (let column = 0; column < columns; column++) {
    const matches = cells.filter((c) => c.row === 0 && c.column === column)
    if (matches.length !== 1 || !literalOwnerMatches(matches[0], heads[column])) return
  }
  const leafStart = completePeerStart
      ? Math.min(
          box(heads[1])[0],
          ...cells
            .filter((c) => c.row > 0 && c.column === 1)
            .flatMap((c) => owned.get(c))
            .map((i) => i.rect[0])
        )
      : box(heads[1])[0],
    labels = body.filter((i) => i.rect[2] < leafStart),
    peers = body.filter((i) => i.rect[0] >= leafStart),
    groups = fences.slice(2).map((f, n) => ({
      top: fences[n + 1][1],
      bottom: f[1],
      label: labels.filter((i) => i.rect[1] > fences[n + 1][1] && i.rect[3] < f[1]),
      records: physicalRows(
        peers.filter((i) => i.rect[1] > fences[n + 1][1] && i.rect[3] < f[1]),
        h
      ).map((g) => g.sort((a, b) => a.rect[0] - b.rect[0]))
    }))
  if (
    labels.length !== groups.length ||
    labels.length + peers.length !== body.length ||
    groups.some(
      (g) =>
        g.label.length !== 1 ||
        g.records.length < 2 ||
        g.records.some(
          (r, n) =>
            r.length !== columns - 1 ||
            r.some((i) => Math.abs(i.baseline - r[0].baseline) > 0.02) ||
            (n && r[0].baseline - g.records[n - 1][0].baseline < h * 0.7)
        )
    )
  )
    return
  const records = groups.flatMap((g) => g.records),
    domains = Array.from({ length: columns }, (_, column) =>
      box([...heads[column], ...(column ? records.map((r) => r[column - 1]) : labels)])
    )
  if (
    records.length + 1 !== grid.length ||
    domains.slice(1).some((d, n) => d[0] - domains[n][2] < h * 0.3)
  )
    return
  for (let row = 1; row <= records.length; row++) {
    for (let column = 1; column < columns; column++) {
      const matches = cells.filter((c) => c.row === row && c.column === column),
        native = records[row - 1][column - 1]
      if (
        matches.length !== 1 ||
        !literalOwnerMatches(matches[0], [native]) ||
        native.rect[0] < matches[0].rect[0] ||
        native.rect[2] > matches[0].rect[2]
      )
        return
    }
  }
  const partial = horizontal.filter(
    (r) =>
      r[1] >= opening[1] &&
      r[1] <= closing[1] &&
      r[0] < opening[2] &&
      r[2] > opening[0] &&
      !fences.includes(r)
  )
  for (const rule of partial) {
    const witnesses = peers.filter(
      (i) =>
        Math.abs(i.rect[0] - rule[0]) < 0.02 &&
        Math.abs(i.rect[2] - rule[2]) < 0.02 &&
        rule[1] > i.baseline &&
        rule[1] - i.baseline < h * 0.3
    )
    if (witnesses.length !== 1) return
  }
  const replacements = []
  let row = 1
  for (const group of groups) {
    const rowSpan = group.records.length,
      donors = cells
        .filter((c) => c.column === 0 && c.row >= row && c.row < row + rowSpan)
        .sort((a, b) => a.row - b.row),
      coverage = donors.flatMap((c) => Array.from({ length: c.rowSpan }, (_, n) => c.row + n)),
      rect = box(donors),
      label = group.label[0]
    if (
      coverage.length !== rowSpan ||
      new Set(coverage).size !== rowSpan ||
      coverage.some((r) => r < row || r >= row + rowSpan) ||
      donors.flatMap((c) => owned.get(c)).length !== 1 ||
      !donors.some((c) => owned.get(c)[0] === label) ||
      label.rect.some((v, n) => (n < 2 ? v < rect[n] : v > rect[n])) ||
      donors.some((c) => c.rect[2] >= domains[1][0]) ||
      coverage.some((r) => !donors.some((c) => c.row === r) && grid[r][0] !== '')
    )
      return
    if (!(donors.length === 1 && donors[0].row === row && donors[0].rowSpan === rowSpan)) {
      const original = donors.find((c) => owned.get(c).includes(label))
      replacements.push({ row, rowSpan, donors, rect, sourceTokens: original.sourceTokens })
    }
    row += rowSpan
  }
  if (!replacements.length) return
  return { replacements }
}

// Complete horizontal group fences can prove multiline stub ownership without
// rebuilding any independently printed record or inheriting a blank label.
export function proveNativeFencedMultilineStubOwners(table, items, captions, rules) {
  const partial = provePartialRuleStubFaces(table, items, captions, rules)
  if (partial) return partial
  const { cells, grid } = table
  const columns = grid?.[0]?.length
  if (
    table.notes?.length ||
    table.readingRotation ||
    !(grid?.length > 2) ||
    !(columns >= 3) ||
    grid.some((r) => r.length !== columns) ||
    !cells?.length ||
    cells.some(
      (c) =>
        !Number.isInteger(c.row) ||
        !Number.isInteger(c.column) ||
        c.row < 0 ||
        c.row >= grid.length ||
        c.column < 0 ||
        c.column >= columns
    )
  )
    return
  const frame = nativeHeaderFrame(table, items, rules)
  if (!frame) return
  const { h, opening, divider, closing, source, header, body } = frame,
    horizontal = joinHorizontalTableRules(rules, 0.01, 0),
    fences = horizontal
      .filter(
        (r) =>
          r[1] >= table.cropRect[1] - h &&
          r[1] <= table.cropRect[3] + h &&
          Math.abs(r[0] - table.cropRect[0]) < h * 2 &&
          Math.abs(r[2] - table.cropRect[2]) < h * 2
      )
      .sort((a, b) => a[1] - b[1]),
    titles = captions.filter(
      (c) =>
        captionKind(c.lines?.[0]) === 'table' &&
        c.rect[3] <= opening[1] &&
        opening[1] - c.rect[3] < h * 5 &&
        c.rect[0] < opening[2] &&
        c.rect[2] > opening[0]
    ),
    ink = items.filter(
      (i) =>
        i.text.trim() &&
        i.rect[3] > opening[1] &&
        i.rect[1] < closing[1] &&
        i.rect[2] > opening[0] &&
        i.rect[0] < opening[2]
    )
  if (
    titles.length !== 1 ||
    fences.length < 4 ||
    !sameRect(fences[0], opening) ||
    !sameRect(fences[1], divider) ||
    !sameRect(fences.at(-1), closing) ||
    fences.some(
      (r, n) =>
        Math.abs(r[0] - opening[0]) > 0.02 ||
        Math.abs(r[2] - opening[2]) > 0.02 ||
        (n && r[1] - fences[n - 1][1] < h)
    ) ||
    horizontal.filter(
      (r) => r[1] >= opening[1] && r[1] <= closing[1] && r[2] > opening[0] && r[0] < opening[2]
    ).length !== fences.length ||
    rules.some(
      (r) =>
        Math.abs(r[0] - r[2]) < 0.01 &&
        r[0] > opening[0] &&
        r[0] < opening[2] &&
        Math.max(r[1], r[3]) > opening[1] &&
        Math.min(r[1], r[3]) < closing[1]
    ) ||
    source.length !== ink.length ||
    ink.some((i) => !source.includes(i)) ||
    new Set(source.map((i) => i.text + ':' + i.rect.join(':'))).size !== source.length ||
    source.some(
      (i) =>
        !i.rect.every(Number.isFinite) ||
        !Number.isFinite(i.baseline) ||
        !Number.isFinite(i.height) ||
        !(i.height > 0) ||
        i.rect[0] < opening[0] - 0.02 ||
        i.rect[2] > opening[2] + 0.02 ||
        i.rect[1] <= opening[1] ||
        i.rect[3] >= closing[1] ||
        fences.some((r) => i.rect[1] < r[1] && i.rect[3] > r[1])
    ) ||
    header.some((i) => Math.abs(i.height - h) > 0.02) ||
    physicalRows(header, h).length !== 1
  )
    return
  const heads = headerLeaves(header, h)
  if (heads.length !== columns) return
  for (let column = 0; column < columns; column++) {
    const owners = cells.filter((c) => c.row === 0 && c.column === column)
    if (
      owners.length !== 1 ||
      grid[0][column] !== owners[0].text ||
      !literalOwnerMatches(owners[0], heads[column])
    )
      return
  }
  const leafStart = box(heads[1])[0],
    labels = body.filter((i) => i.rect[2] < leafStart),
    peers = body.filter((i) => i.rect[0] >= leafStart - 0.02),
    labelRight = Math.max(...labels.map((i) => i.rect[2])),
    peerLeft = Math.min(...peers.map((i) => i.rect[0]))
  if (
    labels.length !== (fences.length - 2) * 4 ||
    labels.length + peers.length !== body.length ||
    peerLeft - labelRight < h * 0.3 ||
    peers.some((i) => Math.abs(i.height - h) > 0.02)
  )
    return
  const groups = fences.slice(2).map((f, n) => ({
    top: fences[n + 1][1],
    bottom: f[1],
    label: labels.filter((i) => i.rect[1] > fences[n + 1][1] && i.rect[3] < f[1]),
    records: physicalRows(
      peers.filter((i) => i.rect[1] > fences[n + 1][1] && i.rect[3] < f[1]),
      h
    ).map((g) => g.sort((a, b) => a.rect[0] - b.rect[0]))
  }))
  if (
    groups.some(
      (g) =>
        g.label.length !== 4 ||
        g.records.length < 2 ||
        g.records.length !== groups[0].records.length ||
        g.records.some(
          (r, n) =>
            r.length !== columns - 1 ||
            r.some((i) => Math.abs(i.baseline - r[0].baseline) > 0.02) ||
            (n && r[0].baseline - g.records[n - 1][0].baseline < h * 0.7)
        )
    )
  )
    return
  const records = groups.flatMap((g) => g.records),
    domains = Array.from({ length: columns - 1 }, (_, n) =>
      box([...heads[n + 1], ...records.map((r) => r[n])])
    )
  if (
    records.length + 1 !== grid.length ||
    domains.slice(1).some((d, n) => d[0] - domains[n][2] < h * 0.3)
  )
    return
  const cuts = [
    (labelRight + Math.min(peerLeft, leafStart)) / 2,
    ...domains.slice(1).map((d, n) => (domains[n][2] + d[0]) / 2),
    closing[2]
  ]
  for (let row = 1; row <= records.length; row++) {
    for (let column = 1; column < columns; column++) {
      const native = records[row - 1][column - 1],
        owners = cells.filter((c) => c.row === row && c.column === column)
      if (
        native.rect[0] < cuts[column - 1] ||
        native.rect[2] > cuts[column] ||
        owners.length !== 1 ||
        grid[row][column] !== owners[0].text ||
        !literalOwnerMatches(owners[0], [native])
      )
        return
    }
  }
  const same = (a, b) =>
      a.text === b.text &&
      sameRect(a.rect, b.rect) &&
      Math.abs(a.baseline - b.baseline) < 0.02 &&
      Math.abs(a.height - b.height) < 0.02,
    ownedByCell = new Map(),
    found = new Set(),
    strip = (text) => text.replace(/\s/gu, '')
  for (const cell of cells) {
    if (
      !Array.isArray(cell.sourceRects) ||
      !Array.isArray(cell.sourceTokens) ||
      cell.sourceRects?.length !== cell.sourceTokens?.length ||
      cell.sourceTokens.some(
        (i) => cell.sourceRects.filter((r) => sameRect(i.rect, r)).length !== 1
      ) ||
      cell.sourceRects.some(
        (r) => cell.sourceTokens.filter((i) => sameRect(i.rect, r)).length !== 1
      )
    )
      return
    const owned = []
    for (const token of cell.sourceTokens) {
      const matches = source.filter((i) => same(i, token))
      if (matches.length !== 1 || found.has(matches[0])) return
      found.add(matches[0])
      owned.push(matches[0])
    }
    ownedByCell.set(cell, owned)
  }
  if (found.size !== source.length) return
  const replacements = [],
    scriptParents = new Map()
  for (const [group, g] of groups.entries()) {
    const row = 1 + groups.slice(0, group).reduce((n, p) => n + p.records.length, 0),
      rowSpan = g.records.length,
      donors = cells
        .filter((c) => c.column === 0 && c.row >= row && c.row < row + rowSpan)
        .sort((a, b) => a.row - b.row),
      ordinary = g.label
        .filter((i) => Math.abs(i.height - h) < 0.02)
        .sort((a, b) => a.baseline - b.baseline),
      small = g.label.filter((i) => !ordinary.includes(i)),
      coverage = donors.flatMap((c) =>
        Number.isInteger(c.rowSpan) && c.rowSpan > 0
          ? Array.from({ length: c.rowSpan }, (_, n) => c.row + n)
          : []
      )
    if (
      ordinary.length !== 3 ||
      small.length !== 1 ||
      small[0].height < h * 0.5 ||
      small[0].height >= h * 0.8 ||
      ordinary.some(
        (i, n) =>
          Math.abs(i.rect[0] - ordinary[0].rect[0]) > 0.02 ||
          (n &&
            (i.baseline - ordinary[n - 1].baseline < h * 0.7 ||
              i.baseline - ordinary[n - 1].baseline > h * 2))
      ) ||
      coverage.length !== rowSpan ||
      new Set(coverage).size !== rowSpan ||
      coverage.some((r) => r < row || r >= row + rowSpan) ||
      donors.some(
        (c) =>
          c.colSpan !== 1 ||
          !Number.isInteger(c.rowSpan) ||
          c.rowSpan <= 0 ||
          grid[c.row][0] !== c.text ||
          !c.rect.every(Number.isFinite) ||
          c.rect[0] > Math.min(...g.label.map((i) => i.rect[0])) ||
          c.rect[2] >= peerLeft ||
          ownedByCell.get(c).some((i) => !g.label.includes(i))
      ) ||
      donors.flatMap((c) => ownedByCell.get(c)).length !== 4
    )
      return
    const unit = small[0],
      parents = ordinary.filter(
        (i) =>
          isAdjacentTableScript(unit, i) &&
          Math.abs(unit.rect[0] - i.rect[2]) < 0.02 &&
          i.baseline - unit.baseline > h * 0.2 &&
          i.baseline - unit.baseline < h * 0.6
      )
    if (parents.length !== 1 || parents[0] !== ordinary[1]) return
    scriptParents.set(unit, parents[0])
    const scriptOwners = donors.filter((c) => ownedByCell.get(c).includes(unit))
    if (
      scriptOwners.length !== 1 ||
      !ownedByCell.get(scriptOwners[0]).includes(parents[0]) ||
      scriptOwners[0].textRuns?.filter((r) => r.position !== 'normal').length !== 1 ||
      !scriptOwners[0].textRuns.some((r) => r.position === 'superscript' && r.text === unit.text)
    )
      return
    const ordered = [ordinary[0], ordinary[1], unit, ordinary[2]],
      sourceText = (owned) =>
        ordered
          .filter((i) => owned.includes(i))
          .map((i) => i.text)
          .join('')
    if (
      donors.some(
        (c) =>
          strip(c.text) !== strip(sourceText(ownedByCell.get(c))) ||
          (c.textRuns && c.textRuns.map((r) => r.text).join('') !== c.text) ||
          (c !== scriptOwners[0] && c.textRuns?.some((r) => r.position !== 'normal'))
      ) ||
      coverage.some((r) => !donors.some((c) => c.row === r) && grid[r][0] !== '')
    )
      return
    const rect = box(donors.map((c) => ({ rect: c.rect })))
    if (
      ordered.some(
        (i) =>
          i.rect[0] < rect[0] || i.rect[2] > rect[2] || i.rect[1] < rect[1] || i.rect[3] > rect[3]
      )
    )
      return
    const correct = donors.length === 1 && donors[0].row === row && donors[0].rowSpan === rowSpan
    if (!correct) {
      if (!nativeChangedCellOrigins(donors, items, ordered)) return
      replacements.push({ row, rowSpan, donors, sourceTokens: ordered, rect })
    }
  }
  if (!replacements.length) return
  return { replacements, baselineHeight: h, scriptParents }
}

// Peer-only separators leave a multiline stub in one physical group face.
// Reconcile only complete existing owners; peer records are never rebuilt.
function provePartialRuleStubFaces(table, items, captions, rules) {
  const { cells, grid, cropRect: crop } = table
  const valid = (r) => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite)
  if (
    !valid(crop) ||
    crop[2] <= crop[0] ||
    crop[3] <= crop[1] ||
    table.notes?.length ||
    table.unassigned?.length ||
    table.readingRotation ||
    !cells?.length ||
    !grid?.length ||
    grid[0].length < 3 ||
    grid.some((r) => r.length !== grid[0].length) ||
    rules.some((r) => !valid(r) || r[2] < r[0] || r[3] < r[1])
  )
    return
  const near = items.filter(
    (i) =>
      i.text?.trim() &&
      valid(i.rect) &&
      i.rect[0] >= crop[0] &&
      i.rect[2] <= crop[2] &&
      i.baseline > crop[1] &&
      i.baseline < crop[3]
  )
  const h = median(near.map((i) => i.height))
  if (
    !(h > 0) ||
    !Number.isFinite(h) ||
    !captions.some((c) => captionKind(c.lines?.[0]) === 'table')
  )
    return
  const sourceTop = Math.min(
    crop[1],
    ...cells
      .filter((c) => c.row === 0)
      .flatMap((c) => c.sourceRects ?? [])
      .map((r) => (valid(r) ? r[1] : NaN))
  )
  if (!Number.isFinite(sourceTop) || crop[1] - sourceTop >= h) return
  const hs = joinHorizontalTableRules(rules, 0.01, 0)
  const fences = hs
    .filter(
      (r) =>
        r[1] > crop[1] &&
        r[1] < crop[3] + h &&
        Math.abs(r[0] - crop[0]) < h &&
        Math.abs(r[2] - crop[2]) < h
    )
    .sort((a, b) => a[1] - b[1])
  if (
    fences.length < 3 ||
    fences.some(
      (r, n) =>
        Math.abs(r[0] - fences[0][0]) > 0.02 ||
        Math.abs(r[2] - fences[0][2]) > 0.02 ||
        (n && r[1] - fences[n - 1][1] < h * 2)
    )
  )
    return
  const source = items.filter(
    (i) =>
      i.text?.trim() &&
      valid(i.rect) &&
      i.rect[0] < fences[0][2] &&
      i.rect[2] > fences[0][0] &&
      i.rect[3] > sourceTop &&
      i.rect[1] < fences.at(-1)[1] &&
      !(
        i.baseline > fences.at(-1)[1] &&
        captions.filter(
          (c) =>
            c.lines?.length === 1 &&
            c.lines[0] === i.text &&
            sameRect(c.rect, i.rect) &&
            captionKind(c.lines[0]) === 'table'
        ).length === 1
      )
  )
  if (
    !source.length ||
    source.some(
      (i) =>
        !i.horizontal ||
        !valid(i.rect) ||
        i.rect[2] <= i.rect[0] ||
        i.rect[3] <= i.rect[1] ||
        !Number.isFinite(i.baseline) ||
        Math.abs(i.height - h) > 0.02 ||
        i.rect[0] < fences[0][0] ||
        i.rect[2] > fences[0][2] ||
        i.rect[1] < sourceTop ||
        i.rect[3] > fences.at(-1)[1] ||
        fences.some((r) => i.rect[1] < r[1] && i.rect[3] > r[1])
    )
  )
    return
  const owned = new Map(),
    seen = new Set()
  for (const cell of cells) {
    if (
      !valid(cell.rect) ||
      cell.rect[2] <= cell.rect[0] ||
      cell.rect[3] <= cell.rect[1] ||
      !Number.isInteger(cell.row) ||
      !Number.isInteger(cell.column) ||
      cell.row < 0 ||
      cell.row >= grid.length ||
      cell.column < 0 ||
      cell.column >= grid[0].length ||
      grid[cell.row][cell.column] !== cell.text ||
      cell.textRuns?.some((r) => r.position !== 'normal')
    )
      return
    const tokens = source.filter((i) =>
      cell.sourceTokens?.some((t) => t.text === i.text && sameRect(t.rect, i.rect))
    )
    if (!literalOwnerMatches(cell, tokens) || tokens.some((i) => seen.has(i))) return
    tokens.forEach((i) => seen.add(i))
    owned.set(cell, tokens)
  }
  if (seen.size !== source.length || cells.length !== grid.length * grid[0].length) return
  const header = source.filter((i) => i.rect[3] < fences[0][1])
  if (
    physicalRows(header, h).length !== 1 ||
    cells.filter((c) => c.row === 0).some((c) => owned.get(c).some((i) => !header.includes(i)))
  )
    return
  const replacements = []
  let nextRow = 1
  for (let g = 1; g < fences.length; g++) {
    const top = fences[g - 1][1],
      bottom = fences[g][1]
    const ink = source.filter((i) => i.rect[1] > top && i.rect[3] < bottom)
    const donors = cells
      .filter((c) => c.column === 0 && owned.get(c).some((i) => ink.includes(i)))
      .sort((a, b) => a.row - b.row)
    if (
      donors.length !== 2 ||
      donors.some((c, n) => c.row !== nextRow + n || owned.get(c).length !== 1)
    )
      return
    const labels = donors.flatMap((c) => owned.get(c)).sort((a, b) => a.baseline - b.baseline)
    if (
      labels.some((i) => !ink.includes(i)) ||
      Math.abs(labels[0].rect[0] - labels[1].rect[0]) > 0.02 ||
      labels[1].baseline - labels[0].baseline < h
    )
      return
    const peers = [nextRow, nextRow + 1].map((r) =>
      cells.filter((c) => c.row === r && c.column > 0).sort((a, b) => a.column - b.column)
    )
    if (
      peers.some(
        (row) =>
          row.length !== grid[0].length - 1 ||
          row.some((c) => !owned.get(c).length || owned.get(c).some((i) => !ink.includes(i)))
      )
    )
      return
    const peerInk = peers.map((row) => row.flatMap((c) => owned.get(c)))
    const gap = [
      Math.max(...peerInk[0].map((i) => i.rect[3])),
      Math.min(...peerInk[1].map((i) => i.rect[1]))
    ]
    if (gap[1] <= gap[0] || ink.length !== labels.length + peerInk.flat().length) return
    const walls = rules.filter(
      (r) =>
        r[0] === r[2] &&
        r[0] > Math.max(...labels.map((i) => i.rect[2])) &&
        r[0] < Math.min(...peerInk.flat().map((i) => i.rect[0])) &&
        r[1] <= Math.min(...labels.map((i) => i.rect[1])) &&
        r[3] >= Math.max(...labels.map((i) => i.rect[3])) &&
        r[1] > top &&
        r[3] < bottom
    )
    if (walls.length !== 1) return
    const separators = hs.filter(
      (r) => r[1] > top && r[1] < bottom && r[2] > fences[0][0] && r[0] < fences[0][2]
    )
    if (
      !separators.length ||
      separators.some(
        (r) =>
          r[1] <= gap[0] ||
          r[1] >= gap[1] ||
          r[0] <= walls[0][0] ||
          Math.abs(r[1] - separators[0][1]) > 0.02
      ) ||
      !labels.some((i) => i.rect[1] < separators[0][1] && i.rect[3] > separators[0][1])
    )
      return
    for (let c = 0; c < peers[0].length; c++) {
      const parts = [...owned.get(peers[0][c]), ...owned.get(peers[1][c])]
      if (
        separators.filter(
          (r) =>
            r[0] <= Math.min(...parts.map((i) => i.rect[0])) &&
            r[2] >= Math.max(...parts.map((i) => i.rect[2]))
        ).length !== 1
      )
        return
    }
    const rect = box(donors.map((c) => ({ rect: c.rect })))
    if (
      labels.some(
        (i) =>
          i.rect[0] < rect[0] || i.rect[1] < rect[1] || i.rect[2] > rect[2] || i.rect[3] > rect[3]
      ) ||
      !nativeChangedCellOrigins(donors, items, labels)
    )
      return
    replacements.push({ row: nextRow, rowSpan: 2, donors, sourceTokens: labels, rect })
    nextRow += 2
  }
  if (nextRow !== grid.length) return
  return { replacements, baselineHeight: h, scriptParents: new Map() }
}

// Three separate native underlines can prove two faulty upper parents without
// rebuilding the correct lower headings, body owners or the third parent.
export function proveNativePartialRuleParentOwners(table, items, captions, rules, runs = []) {
  const { cells, grid } = table
  if (grid?.length !== 5 || grid.some((r) => r.length !== 8) || cells?.length !== 39) return
  const frame = finalLiteralOwnerFrame(table, items, captions, rules)
  if (!frame) return
  const { h, header, body, source, opening, divider, closing } = frame,
    tiers = physicalRows(header, h),
    records = physicalRows(body, h)
  if (
    tiers.length !== 2 ||
    tiers[0].length !== 5 ||
    tiers[1].length !== 8 ||
    records.length !== 3 ||
    source.length !== 37 ||
    source.some((i) => Math.abs(i.height - h) > 0.02)
  )
    return
  const upper = tiers[0],
    groups = [tiers[1], ...records].map((g) => [...g].sort((a, b) => a.rect[0] - b.rect[0]))
  if (
    groups.some(
      (g) => g.length !== 8 || g.some((i) => Math.abs(i.baseline - g[0].baseline) > 0.02)
    ) ||
    upper.some((i) => Math.abs(i.baseline - upper[0].baseline) > 0.02)
  )
    return
  const domains = Array.from({ length: 8 }, (_, column) => box(groups.map((g) => g[column])))
  if (domains.slice(1).some((d, column) => d[0] - domains[column][2] < h * 0.3)) return
  const cuts = [
    opening[0],
    ...domains.slice(1).map((d, n) => (domains[n][2] + d[0]) / 2),
    closing[2]
  ]
  if (
    groups.some((g) =>
      g.some((i, c) => i.rect[0] < cuts[c] - 0.02 || i.rect[2] > cuts[c + 1] + 0.02)
    )
  )
    return
  for (let row = 1; row < 5; row++) {
    for (let column = 0; column < 8; column++) {
      const owned = cells.filter((c) => c.row === row && c.column === column)
      if (
        owned.length !== 1 ||
        grid[row][column] !== owned[0].text ||
        !literalOwnerMatches(owned[0], [groups[row - 1][column]])
      )
        return
    }
  }
  const horizontal = joinHorizontalTableRules(rules, 0.01, 0),
    partial = horizontal
      .filter(
        (r) =>
          r[1] > upper[0].baseline &&
          r[1] < groups[0][0].baseline &&
          r[0] > opening[0] &&
          r[2] < opening[2]
      )
      .sort((a, b) => a[0] - b[0]),
    inside = horizontal.filter(
      (r) =>
        r[1] >= opening[1] &&
        r[1] <= closing[1] &&
        r[0] >= opening[0] - 0.02 &&
        r[2] <= closing[2] + 0.02
    )
  if (
    partial.length !== 3 ||
    partial.some((r) => Math.abs(r[1] - partial[0][1]) > 0.02) ||
    inside.length !== 6 ||
    inside.some((r) => ![opening, divider, closing, ...partial].some((e) => sameRect(r, e)))
  )
    return
  const parents = partial.map((rule) => {
    const sourceTokens = upper.filter(
      (i) => (i.rect[0] + i.rect[2]) / 2 > rule[0] && (i.rect[0] + i.rect[2]) / 2 < rule[2]
    )
    if (!sourceTokens.length) return
    const bounds = box(sourceTokens),
      candidates = domains.flatMap((_, column) =>
        column < 7 &&
        groups.every((g) =>
          [g[column], g[column + 1]].every(
            (i) => (i.rect[0] + i.rect[2]) / 2 > rule[0] && (i.rect[0] + i.rect[2]) / 2 < rule[2]
          )
        )
          ? [column]
          : []
      )
    if (
      candidates.length !== 1 ||
      bounds[0] < rule[0] - h * 0.03 ||
      bounds[2] > rule[2] + h * 0.03 ||
      Math.abs((bounds[0] + bounds[2] - rule[0] - rule[2]) / 2) > h * 0.02
    )
      return
    const column = candidates[0]
    if (bounds[0] < cuts[column] || bounds[2] > cuts[column + 2]) return
    return { column, sourceTokens }
  })
  if (
    parents.some((p) => !p) ||
    parents.some((p, n) => p.column !== 2 + n * 2) ||
    new Set(parents.flatMap((p) => p.sourceTokens)).size !== upper.length
  )
    return
  const previous = cells.filter((c) => c.row === 0).sort((a, b) => a.column - b.column),
    schema = [
      [0, 1],
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 2],
      [6, 1],
      [7, 1]
    ],
    strip = (text) => text.replace(/\s/gu, '')
  if (
    previous.length !== schema.length ||
    previous.some(
      (c, n) =>
        c.column !== schema[n][0] ||
        c.colSpan !== schema[n][1] ||
        c.rowSpan !== 1 ||
        grid[0][c.column] !== c.text ||
        c.sourceRects?.length !== c.sourceTokens?.length ||
        c.sourceTokens.some((i) => c.sourceRects.filter((r) => sameRect(i.rect, r)).length !== 1) ||
        c.sourceRects.some((r) => c.sourceTokens.filter((i) => sameRect(i.rect, r)).length !== 1) ||
        strip(c.text) !== strip(c.sourceTokens.map((i) => i.text).join('')) ||
        c.textRuns?.some((r) => r.position !== 'normal')
    ) ||
    previous.slice(0, 2).some((c) => c.text || c.sourceTokens.length) ||
    grid[0][5] !== ''
  )
    return
  const donors = previous.flatMap((c) => c.sourceTokens),
    mapped = new Map(),
    found = new Set()
  // Old fragments must partition the complete original source item, and any
  // coarse boundary must fall in the same measured TJ whitespace gap.
  for (const original of upper) {
    const owned = donors
      .filter(
        (i) =>
          Math.abs(i.baseline - original.baseline) < 0.02 &&
          Math.abs(i.height - original.height) < 0.02 &&
          i.rect[0] >= original.rect[0] - 0.02 &&
          i.rect[2] <= original.rect[2] + 0.02 &&
          Math.abs(i.rect[1] - original.rect[1]) < 0.02 &&
          Math.abs(i.rect[3] - original.rect[3]) < 0.02
      )
      .sort((a, b) => a.rect[0] - b.rect[0])
    if (
      !owned.length ||
      Math.abs(owned[0].rect[0] - original.rect[0]) >= 0.02 ||
      Math.abs(owned.at(-1).rect[2] - original.rect[2]) >= 0.02 ||
      strip(owned.map((i) => i.text).join('')) !== strip(original.text) ||
      owned.some((i) => found.has(i)) ||
      owned.slice(1).some((i, n) => Math.abs(i.rect[0] - owned[n].rect[2]) >= 0.02)
    )
      return
    if (owned.length > 1) {
      const observed = runs.filter(
        (r) =>
          r.text === original.text &&
          sameRect(r.rect, original.rect) &&
          Math.abs(r.baseline - original.baseline) < 0.02 &&
          Math.abs(r.height - original.height) < 0.02
      )
      if (
        observed.length !== 1 ||
        !observed[0].glyphRuns?.length ||
        new Set(observed[0].glyphRuns).size !== 1 ||
        observed[0].literalGlyphs?.join('') !== strip(original.text) ||
        observed[0].gaps.length > 12
      )
        return
      let consumed = 0
      for (let n = 0; n < owned.length - 1; n++) {
        consumed += [...strip(owned[n].text)].length
        const cut = owned[n].rect[2]
        if (
          observed[0].gaps.filter((g) => g.index === consumed && g.left <= cut && cut <= g.right)
            .length !== 1
        )
          return
      }
    }
    owned.forEach((i) => found.add(i))
    mapped.set(original, owned)
  }
  if (found.size !== donors.length) return
  const replacements = []
  for (const parent of parents) {
    const old = previous.filter((c) => c.column >= parent.column && c.column < parent.column + 2),
      expected = parent.sourceTokens.flatMap((i) => mapped.get(i)),
      owned = old.flatMap((c) => c.sourceTokens),
      rect = box(old.map((c) => ({ rect: c.rect })))
    if (
      expected.length !== owned.length ||
      expected.some((i) => !owned.includes(i)) ||
      parent.sourceTokens.some(
        (i) =>
          i.rect[0] < rect[0] || i.rect[2] > rect[2] || i.rect[1] < rect[1] || i.rect[3] > rect[3]
      )
    )
      return
    if (parent.column === 4) {
      if (old.length !== 1 || old[0].text !== joined(parent.sourceTokens)) return
    } else replacements.push({ donors: old, sourceTokens: parent.sourceTokens, rect })
  }
  return { replacements, baselineHeight: h }
}

// Six independently printed headings and both complete records can prove a
// terminal two-face split even when there are only two body peers. The first
// four leaves must already have exact, separate final owners.
// Two terminal bands must each print every compact ordinary field. Existing
// complete peers calibrate the body gutters; a wrapped prose face or script
// has no admission through this donor-only repair.
export function proveNativeTerminalOrdinaryPeerRecords(table, items, captions, rules, runs = []) {
  const { cells, grid, rows, cropRect: crop } = table,
    valid = (r) => r?.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3],
    same = (a, b) =>
      a.text === b.text &&
      sameRect(a.rect, b.rect) &&
      Math.abs(a.baseline - b.baseline) < 0.02 &&
      Math.abs(a.height - b.height) < 0.02,
    overlaps = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
    count = grid?.[0]?.length,
    row = grid?.length - 1,
    measured = (i) => {
      const candidates = runs.filter((r) => r.text === i.text)
      if (candidates.some((r) => !valid(r.rect))) return false
      const matches = candidates.filter((r) => sameRect(r.rect, i.rect))
      // Programs may retain literal spaces in their glyph sequence. Their
      // complete text still matches exactly and is never normalized here.
      return (
        matches.length === 1 &&
        Math.abs(matches[0].baseline - i.baseline) < 0.02 &&
        Math.abs(matches[0].height - i.height) < 0.02 &&
        matches[0].literalGlyphs?.join('').replace(/\s/gu, '') === i.text.replace(/\s/gu, '')
      )
    }
  if (
    table.readingRotation ||
    !valid(crop) ||
    !(count >= 3 && count <= 16) ||
    row < 4 ||
    rows?.length !== grid.length ||
    grid.some((g) => g.length !== count) ||
    !runs.length ||
    !valid(rows?.[row]?.rect) ||
    items.some((i) => i.text.trim() && !valid(i.rect))
  )
    return
  const heads = cells.filter((c) => c.row === 0).sort((a, b) => a.column - b.column),
    donors = cells.filter((c) => c.row === row).sort((a, b) => a.column - b.column)
  if (
    heads.length !== count ||
    donors.length !== count ||
    heads.some(
      (c, n) =>
        c.column !== n ||
        c.rowSpan !== 1 ||
        c.colSpan !== 1 ||
        !c.text.trim() ||
        !c.sourceTokens?.length ||
        !valid(c.rect)
    ) ||
    donors.some(
      (c, n) =>
        c.column !== n ||
        c.rowSpan !== 1 ||
        c.colSpan !== 1 ||
        !valid(c.rect) ||
        c.sourceTokens?.length !== 2 ||
        c.sourceRects?.length !== 2 ||
        c.textRuns?.length ||
        c.rect[0] < crop[0] ||
        c.rect[1] < crop[1] ||
        c.rect[2] > crop[2] ||
        c.rect[3] > crop[3]
    )
  )
    return
  const native = [],
    originals = []
  for (const donor of donors) {
    const field = []
    for (const token of donor.sourceTokens) {
      if (!valid(token.rect)) return
      const matches = items.filter((i) => same(i, token))
      if (
        matches.length !== 1 ||
        !measured(matches[0]) ||
        cells.flatMap((c) => c.sourceTokens ?? []).filter((t) => same(t, token)).length !== 1 ||
        donor.sourceRects.filter((r) => sameRect(r, token.rect)).length !== 1
      )
        return
      field.push(matches[0])
      originals.push(token)
    }
    if (
      donor.sourceRects.some(
        (r) => donor.sourceTokens.filter((t) => sameRect(r, t.rect)).length !== 1
      )
    )
      return
    field.sort((a, b) => a.baseline - b.baseline)
    if (donor.text !== field.map((i) => i.text).join(' ')) return
    native.push(field)
  }
  const h = native[0][0].height,
    bands = [0, 1].map((n) => native.map((g) => g[n])),
    full = box(native.flat())
  if (
    !(h > 0) ||
    native
      .flat()
      .some(
        (i) =>
          !i.horizontal ||
          !Number.isFinite(i.baseline) ||
          Math.abs(i.height - h) >= 0.02 ||
          !/^[\p{L}\p{N}.,−+_-]+$/u.test(i.text)
      ) ||
    bands.some((g) => g.some((i) => Math.abs(i.baseline - g[0].baseline) >= 0.02)) ||
    native.some((g, column) =>
      g.some((i) => i.rect[0] < donors[column].rect[0] || i.rect[2] > donors[column].rect[2])
    ) ||
    full[1] < crop[1] ||
    full[3] > crop[3]
  )
    return
  const gap = [
      Math.max(...bands[0].map((i) => i.rect[3])),
      Math.min(...bands[1].map((i) => i.rect[1]))
    ],
    corridor = [donors[0].rect[0], full[1], donors.at(-1).rect[2], full[3]],
    ink = items.filter((i) => i.text.trim() && overlaps(i.rect, corridor))
  if (
    gap[1] <= gap[0] ||
    ink.length !== originals.length ||
    ink.some((i) => !native.flat().includes(i)) ||
    rules.some(
      (r) =>
        r[1] === r[3] && r[1] > gap[0] && r[1] < gap[1] && r[0] < corridor[2] && r[2] > corridor[0]
    )
  )
    return
  const edges = joinHorizontalTableRules(rules, 0.01, 0),
    covering = (y) =>
      native.every((g) =>
        edges.some(
          (r) =>
            r[1] === y &&
            r[0] <= Math.min(...g.map((i) => i.rect[0])) &&
            r[2] >= Math.max(...g.map((i) => i.rect[2]))
        )
      ),
    upper = [...new Set(edges.filter((r) => r[1] > crop[1] && r[1] < full[1]).map((r) => r[1]))]
      .filter(covering)
      .sort((a, b) => a - b),
    lower = [
      ...new Set(edges.filter((r) => r[1] > full[3] && r[1] < crop[3]).map((r) => r[1]))
    ].filter(covering)
  if (!upper.length || lower.length !== 1) return
  const opening = upper[0],
    closing = lower[0],
    titles = captions.filter(
      (c) =>
        captionKind(c.lines?.[0]) === 'table' &&
        valid(c.rect) &&
        c.rect[0] < crop[2] &&
        c.rect[2] > crop[0] &&
        c.rect[3] <= opening &&
        opening - c.rect[3] < h * 6
    )
  if (
    titles.length !== 1 ||
    heads
      .flatMap((c) => c.sourceTokens)
      .some((i) => !valid(i.rect) || i.rect[1] < opening || i.rect[3] > full[1]) ||
    items.some((i) => i.text.trim() && overlaps(i.rect, [crop[0], closing, crop[2], crop[3]]))
  )
    return
  const peers = []
  for (let r = 1; r < row; r++) {
    const cs = cells.filter((c) => c.row === r).sort((a, b) => a.column - b.column)
    if (
      cs.length !== count ||
      cs.some(
        (c, n) =>
          c.column !== n ||
          c.rowSpan !== 1 ||
          c.colSpan !== 1 ||
          c.sourceTokens?.length !== 1 ||
          c.sourceRects?.length !== 1 ||
          c.textRuns?.some((p) => p.position !== 'normal') ||
          c.text !== c.sourceTokens[0].text
      )
    )
      continue
    const sources = cs.map((c) => items.filter((i) => same(i, c.sourceTokens[0])))
    if (sources.some((g) => g.length !== 1)) continue
    const g = sources.flat()
    if (
      g.every(
        (i, n) =>
          i.horizontal &&
          Math.abs(i.height - h) < 0.02 &&
          Math.abs(i.baseline - g[0].baseline) < 0.02 &&
          measured(i) &&
          sameRect(cs[n].sourceRects[0], i.rect) &&
          i.rect[0] >= donors[n].rect[0] &&
          i.rect[2] <= donors[n].rect[2]
      )
    )
      peers.push(g)
  }
  if (peers.length < 3) return
  const all = [...bands, ...peers]
  for (let c = 1; c < count; c++) {
    const right = Math.max(...all.map((g) => g[c - 1].rect[2])),
      left = Math.min(...all.map((g) => g[c].rect[0]))
    if (left - right <= h * 0.2 || donors[c - 1].rect[2] > left || donors[c].rect[0] < right) return
  }
  if (
    donors.some((donor, column) =>
      native[column].some((font) => !nativeChangedCellOrigins([donor], items, [font]))
    )
  )
    return
  return {
    row,
    donors,
    split: (gap[0] + gap[1]) / 2,
    top: Math.min(full[1], ...donors.map((c) => c.rect[1])),
    bottom: Math.max(full[3], ...donors.map((c) => c.rect[3])),
    groups: bands.map((g) => g.map((i) => originals.find((t) => same(i, t))))
  }
}

// A merged ordinary donor may contain several complete same-baseline records
// followed by a wrapped literal face. Split only the independently witnessed
// prefix; the remaining source stays together without interpreting its label.
// The caller supplies its existing serializer, so qualification and projection
// agree without another text normalization or a circular module dependency.
export function proveNativeMiddleOrdinaryPeerRecords(
  table,
  items,
  captions,
  rules,
  runs = [],
  recordText
) {
  const { cells, grid, rows, cropRect: crop } = table,
    valid = (r) => r?.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3],
    same = (a, b) =>
      valid(a?.rect) &&
      valid(b?.rect) &&
      a.text === b.text &&
      sameRect(a.rect, b.rect) &&
      Number.isFinite(a.baseline) &&
      Number.isFinite(b.baseline) &&
      Number.isFinite(a.height) &&
      Number.isFinite(b.height) &&
      Math.abs(a.baseline - b.baseline) < 0.02 &&
      Math.abs(a.height - b.height) < 0.02,
    overlaps = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
    count = grid?.[0]?.length
  if (
    typeof recordText !== 'function' ||
    table.readingRotation ||
    !valid(crop) ||
    !(count >= 3 && count <= 16) ||
    !cells?.length ||
    rows?.length !== grid.length ||
    grid.some((g) => g.length !== count) ||
    !runs.length ||
    items.some((i) => i.text.trim() && !valid(i.rect)) ||
    cells.some(
      (c) =>
        !valid(c.rect) ||
        c.sourceTokens?.some(
          (i) =>
            !valid(i.rect) ||
            i.rect[0] < c.rect[0] ||
            i.rect[2] > c.rect[2] ||
            i.rect[1] < crop[1] ||
            i.rect[3] > crop[3]
        )
    )
  )
    return
  const measured = (i) => {
      const candidates = runs.filter((r) => r.text === i.text)
      if (candidates.some((r) => !valid(r.rect))) return false
      const matches = candidates.filter((r) => sameRect(r.rect, i.rect))
      return (
        matches.length === 1 &&
        Number.isFinite(matches[0].baseline) &&
        Number.isFinite(matches[0].height) &&
        Math.abs(matches[0].baseline - i.baseline) < 0.02 &&
        Math.abs(matches[0].height - i.height) < 0.02 &&
        matches[0].literalGlyphs?.join('').replace(/\s/gu, '') === i.text.replace(/\s/gu, '')
      )
    },
    owned = (c) =>
      Array.isArray(c.sourceTokens) &&
      Array.isArray(c.sourceRects) &&
      c.sourceTokens.length === c.sourceRects.length &&
      c.sourceTokens.every((token) => {
        if (!valid(token.rect)) return false
        const matches = items.filter((i) => same(i, token))
        return (
          matches.length === 1 &&
          measured(matches[0]) &&
          c.sourceRects.filter((r) => valid(r) && sameRect(r, token.rect)).length === 1
        )
      }) &&
      c.sourceRects.every(
        (r) => valid(r) && c.sourceTokens.filter((token) => sameRect(r, token.rect)).length === 1
      ),
    heads = cells.filter((c) => c.row === 0).sort((a, b) => a.column - b.column),
    compact = (field) => {
      const text = recordText(field)
      return (
        field.length &&
        /\d/u.test(text) &&
        /^[\p{L}\p{N}\s.,+−%()/-]+$/u.test(text) &&
        !/[\p{L}]{3}/u.test(text)
      )
    }
  if (
    heads.length !== count ||
    heads.some(
      (c, n) =>
        c.column !== n ||
        c.rowSpan !== 1 ||
        c.colSpan !== 1 ||
        !c.text.trim() ||
        !valid(c.rect) ||
        !c.sourceTokens?.length ||
        !owned(c) ||
        recordText(c.sourceTokens) !== c.text ||
        c.sourceTokens.some(
          (i) =>
            !items.find((native) => same(native, i))?.horizontal ||
            i.rect[0] < c.rect[0] ||
            i.rect[2] > c.rect[2] ||
            i.rect[1] < crop[1] ||
            i.rect[3] > crop[3]
        )
    )
  )
    return
  const candidates = [],
    allOwners = cells.flatMap((c) => c.sourceTokens ?? [])
  for (let row = 1; row < grid.length - 1; row++) {
    const donors = cells.filter((c) => c.row === row).sort((a, b) => a.column - b.column)
    if (
      !valid(rows[row]?.rect) ||
      donors.length !== count ||
      donors.some(
        (c, n) =>
          c.column !== n ||
          c.rowSpan !== 1 ||
          c.colSpan !== 1 ||
          !valid(c.rect) ||
          c.rect[0] < crop[0] ||
          c.rect[1] < crop[1] ||
          c.rect[2] > crop[2] ||
          c.rect[3] > crop[3] ||
          c.textRuns?.some((r) => r.position !== 'normal') ||
          !owned(c)
      )
    )
      continue
    const tokens = donors.flatMap((c) => c.sourceTokens),
      h = tokens[0]?.height,
      ordinary = (token) => {
        const native = items.find((i) => same(i, token))
        return native?.horizontal && Math.abs(native.height - h) < 0.02
      }
    if (
      !(h > 0) ||
      tokens.some((t) => !ordinary(t) || allOwners.filter((i) => same(i, t)).length !== 1)
    )
      continue
    const baselines = [...new Set(tokens.map((i) => i.baseline))].sort((a, b) => a - b),
      groups = []
    for (const baseline of baselines) {
      const fields = donors.map((c) =>
        c.sourceTokens.filter((i) => Math.abs(i.baseline - baseline) < 0.02)
      )
      if (fields[0].length !== 1 || fields.slice(1).some((f) => !compact(f))) break
      groups.push(fields)
    }
    if (groups.length < 2 || groups.flat(2).length === tokens.length) continue
    const selected = groups.flat(2),
      residual = donors.map((c) => c.sourceTokens.filter((i) => !selected.includes(i)))
    if (
      residual.some((f) => !f.length) ||
      residual
        .slice(1)
        .some((f) => f.length !== 1 || Math.abs(f[0].baseline - residual[1][0].baseline) >= 0.02) ||
      donors.some((c) => recordText(c.sourceTokens) !== c.text)
    )
      continue
    const remainder = box(residual.flat()),
      groupBoxes = groups.map((g) => box(g.flat())),
      top = groupBoxes[0][1],
      bottom = Math.max(...donors.map((c) => c.rect[3]))
    if (
      top < crop[1] ||
      bottom > crop[3] ||
      top >= bottom ||
      groupBoxes.some((b, n) => n && b[1] <= groupBoxes[n - 1][3]) ||
      remainder[1] <= groupBoxes.at(-1)[3] ||
      remainder[3] > bottom
    )
      continue
    // The insertion cannot silently change any previously covered owner. Full
    // source boxes, rather than a coarse predicted row, delimit wrapped peers.
    if (
      cells.some((c) => c.row !== row && c.row < row && c.row + c.rowSpan > row) ||
      cells
        .filter((c) => c.row < row)
        .flatMap((c) => c.sourceTokens ?? [])
        .some((i) => !valid(i.rect) || (i.rect[3] > top && i.rect[1] < bottom))
    )
      return
    const corridor = [crop[0], top, crop[2], bottom],
      ink = items.filter((i) => i.text.trim() && overlaps(i.rect, corridor))
    if (
      ink.length !== tokens.length ||
      ink.some((i) => !i.horizontal || tokens.filter((t) => same(t, i)).length !== 1) ||
      donors.some((c) => c.sourceTokens.some((i) => i.rect[0] < c.rect[0] || i.rect[2] > c.rect[2]))
    )
      return
    const peers = []
    for (let r = 1; r < grid.length; r++) {
      if (r === row) continue
      const cs = cells.filter((c) => c.row === r).sort((a, b) => a.column - b.column)
      if (
        cs.length !== count ||
        cs.some(
          (c, n) =>
            c.column !== n ||
            c.rowSpan !== 1 ||
            c.colSpan !== 1 ||
            c.sourceTokens?.length !== 1 ||
            c.textRuns?.some((p) => p.position !== 'normal') ||
            !owned(c) ||
            recordText(c.sourceTokens) !== c.text
        )
      )
        continue
      const fields = cs.map((c) => c.sourceTokens),
        all = fields.flat()
      if (all.every((i) => ordinary(i) && Math.abs(i.baseline - all[0].baseline) < 0.02)) {
        if (
          cs.some(
            (c) =>
              !valid(c.rect) ||
              c.sourceTokens.some(
                (i) =>
                  i.rect[0] < c.rect[0] ||
                  i.rect[2] > c.rect[2] ||
                  i.rect[1] < crop[1] ||
                  i.rect[3] > crop[3]
              )
          )
        )
          return
        if (fields.slice(1).every(compact)) peers.push(fields)
      }
    }
    if (peers.length < 3) return
    const fullFields = donors.map((c, n) => [...c.sourceTokens, ...peers.flatMap((p) => p[n])])
    if (box(fullFields.flat())[1] <= box(heads.flatMap((c) => c.sourceTokens))[3]) return
    for (let column = 1; column < count; column++) {
      const right = Math.max(...fullFields[column - 1].map((i) => i.rect[2])),
        left = Math.min(...fullFields[column].map((i) => i.rect[0]))
      if (
        left - right < h * 0.2 ||
        donors[column - 1].rect[2] > left ||
        donors[column].rect[0] < right
      )
        return
    }
    // Segmented edges count only when every full field has a painted native
    // opening and closing. No gap is bridged to manufacture a full-width rule.
    const edges = joinHorizontalTableRules(rules, 0.01, 0),
      covering = (y) =>
        fullFields.every((f) =>
          edges.some(
            (r) =>
              Math.abs(r[1] - y) < 0.01 &&
              r[0] <= Math.min(...f.map((i) => i.rect[0])) &&
              r[2] >= Math.max(...f.map((i) => i.rect[2]))
          )
        ),
      nativeY = [...new Set(edges.map((r) => r[1]))],
      headerTop = box(heads.flatMap((c) => c.sourceTokens))[1],
      sourceBottom = box(fullFields.flat())[3],
      above = nativeY.filter((y) => y < headerTop && y > crop[1] && covering(y)),
      below = nativeY.filter((y) => y > sourceBottom && y < crop[3] && covering(y))
    if (above.length !== 1 || below.length !== 1) return
    const titles = captions.filter(
      (c) =>
        valid(c.rect) &&
        captionKind(c.lines?.[0]) === 'table' &&
        c.rect[3] <= above[0] &&
        above[0] - c.rect[3] < h * 6 &&
        c.rect[0] < crop[2] &&
        c.rect[2] > crop[0]
    )
    if (
      titles.length !== 1 ||
      rules.some(
        (r) =>
          r[1] === r[3] &&
          r[1] > top &&
          r[1] < groupBoxes.at(-1)[3] &&
          r[0] < crop[2] &&
          r[2] > crop[0]
      )
    )
      return
    if (
      donors.some((donor, column) =>
        [...groups, residual].some(
          (fields) => !nativeChangedCellOrigins([donor], items, fields[column])
        )
      )
    )
      return
    candidates.push({
      row,
      donors,
      groups,
      residual,
      edges: [
        top,
        ...groupBoxes.slice(1).map((b, n) => (groupBoxes[n][3] + b[1]) / 2),
        (groupBoxes.at(-1)[3] + remainder[1]) / 2,
        bottom
      ]
    })
  }
  if (candidates.length === 1) return candidates[0]
}

export function proveNativeTerminalLiteralOwners(table, items, captions, rules) {
  const { cells, grid } = table
  if (grid?.length !== 3 || grid.some((r) => r.length !== 5) || cells?.length !== 15) return
  const frame = finalLiteralOwnerFrame(table, items, captions, rules)
  if (!frame) return
  const { h, header, body } = frame,
    heads = headerLeaves(header, h),
    records = physicalRows(body, h),
    fields = records.map((g) => headerLeaves(g, h))
  if (
    header.length !== 6 ||
    heads.length !== 6 ||
    physicalRows(header, h).length !== 1 ||
    records.length !== 2 ||
    fields.some((g) => g.length !== 6) ||
    heads.some((g) => !/\p{L}/u.test(joined(g))) ||
    fields.some((g) => g.slice(1).some((lane) => !/^[0-9−+.,–—\s-]+$/u.test(joined(lane))))
  )
    return
  const groups = [heads, ...fields],
    full = heads.map((g, c) => box([...g, ...fields.flatMap((r) => r[c])]))
  if (full.slice(1).some((d, c) => d[0] - full[c][2] < h * 0.3)) return
  const donors = []
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 5; column++) {
      const matches = cells.filter((c) => c.row === row && c.column === column),
        native = column < 4 ? groups[row][column] : groups[row].slice(4).flat()
      if (matches.length !== 1 || !literalOwnerMatches(matches[0], native)) return
      if (column === 4) donors.push(matches[0])
    }
  }
  const cut = (full[4][2] + full[5][0]) / 2
  if (
    donors.some(
      (c, row) => c.rect[0] >= box(groups[row][4])[0] || c.rect[2] < box(groups[row][5])[2]
    )
  )
    return
  if (
    donors.some((donor, row) =>
      groups[row].slice(4).some((fonts) => !nativeChangedCellOrigins([donor], items, fonts))
    )
  )
    return
  return { donors, groups: groups.map((g) => g.slice(4)), cut, baselineHeight: h }
}

// Body owners already prove six leaves. Only a bounded, unique partition of
// actual TJ header pieces may replace their incomplete heading owners.
export function proveNativeUniqueCenteredLiteralHeadings(table, items, captions, rules, runs = []) {
  const { cells, grid } = table
  if (
    grid?.length !== 5 ||
    grid.some((r) => r.length !== 6) ||
    cells?.length !== 30 ||
    !runs.length
  )
    return
  const frame = finalLiteralOwnerFrame(table, items, captions, rules)
  if (!frame) return
  const { h, header, body, opening, divider, closing } = frame,
    records = physicalRows(body, h),
    fields = records.map((g) => headerLeaves(g, h))
  if (
    physicalRows(header, h).length !== 1 ||
    header.length < 2 ||
    header.length > 16 ||
    header.some((i) => Math.abs(i.height - h) > 0.02) ||
    records.length !== 4 ||
    fields.some(
      (g) => g.length !== 6 || g.some((lane) => lane.some((t) => Math.abs(t.height - h) > 0.02))
    )
  )
    return
  const domains = Array.from({ length: 6 }, (_, c) => box(fields.flatMap((g) => g[c])))
  if (domains.slice(1).some((d, c) => d[0] - domains[c][2] < h * 0.3)) return
  for (let row = 1; row < 5; row++) {
    for (let column = 0; column < 6; column++) {
      const matches = cells.filter((c) => c.row === row && c.column === column)
      if (matches.length !== 1 || !literalOwnerMatches(matches[0], fields[row - 1][column])) return
    }
  }
  const previous = cells.filter((c) => c.row === 0)
  if (
    previous.length !== 6 ||
    previous.some((c) => c.rowSpan !== 1 || c.colSpan !== 1) ||
    !previous.some((c) => !c.text && !c.sourceTokens?.length)
  )
    return
  const parts = []
  let crossesFaces = false
  for (const original of header) {
    const matches = runs.filter((r) => r.text === original.text && sameRect(r.rect, original.rect))
    if (
      matches.length !== 1 ||
      !matches[0].glyphRuns?.length ||
      new Set(matches[0].glyphRuns).size !== 1 ||
      matches[0].literalGlyphs.join('') !== original.text.replace(/\s/gu, '') ||
      matches[0].gaps.length > 12
    )
      return
    const run = matches[0],
      split = run.gaps.length
        ? splitObserved(
            original,
            runs,
            run.gaps.map((g) => [g.left, g.right]),
            h
          )
        : [original]
    if (!split) return
    if (domains.filter((d) => original.rect[0] < d[2] && original.rect[2] > d[0]).length > 1)
      crossesFaces = true
    parts.push(...split)
  }
  // Twenty-four measured pieces and a fixed 5000-visit work budget bound this
  // search. A normal header with no measured cross-face TJ never enters.
  if (!crossesFaces || parts.length < 6 || parts.length > 24) return
  parts.sort((a, b) => a.rect[0] - b.rect[0])
  const choices = []
  let visits = 0
  function walk(start, lane, groups) {
    if (++visits > 5000 || choices.length > 1) return
    if (lane === 6) {
      if (start === parts.length) choices.push(groups)
      return
    }
    for (let stop = start + 1; stop <= parts.length - (5 - lane); stop++) {
      const group = parts.slice(start, stop),
        bounds = box(group)
      if (stop < parts.length && parts[stop].rect[0] - bounds[2] < h * 0.2) continue
      if (
        lane === 0
          ? group.length !== 1 ||
            group[0].sourceToken ||
            Math.abs(bounds[0] - domains[0][0]) > h * 0.02
          : Math.abs((bounds[0] + bounds[2] - domains[lane][0] - domains[lane][2]) / 2) > h * 0.02
      )
        continue
      walk(stop, lane + 1, [...groups, group])
    }
  }
  walk(0, 0, [])
  if (visits > 5000 || choices.length !== 1) return
  const headings = choices[0],
    full = headings.map((g, c) => box([...g, ...fields.flatMap((r) => r[c])]))
  if (full.slice(1).some((d, c) => d[0] - full[c][2] < h * 0.2)) return
  const cuts = [opening[0], ...full.slice(1).map((d, c) => (full[c][2] + d[0]) / 2), opening[2]]
  // Earlier character-width owners may end inside the very same measured TJ
  // blank gap. They must still match one unique contiguous glyph range; no
  // missing header piece or previous owner may contain foreign ink.
  const previouslyOwned = new Set()
  for (const token of previous.flatMap((c) => c.sourceTokens ?? [])) {
    const matches = []
    for (let start = 0; start < parts.length; start++) {
      const parent = parts[start].sourceToken ?? parts[start]
      for (let stop = start + 1; stop <= parts.length; stop++) {
        const group = parts.slice(start, stop)
        if (group.some((p) => (p.sourceToken ?? p) !== parent)) break
        const bounds = box(group),
          left =
            parts[start - 1]?.sourceToken === parent ? parts[start - 1].rect[2] : parent.rect[0],
          right = parts[stop]?.sourceToken === parent ? parts[stop].rect[0] : parent.rect[2]
        if (
          joined(group) === token.text &&
          Math.abs(token.baseline - parent.baseline) < 0.02 &&
          Math.abs(token.height - parent.height) < 0.02 &&
          Math.abs(token.rect[1] - bounds[1]) < 0.02 &&
          Math.abs(token.rect[3] - bounds[3]) < 0.02 &&
          token.rect[0] >= left - 0.02 &&
          token.rect[0] <= bounds[0] + 0.02 &&
          token.rect[2] >= bounds[2] - 0.02 &&
          token.rect[2] <= right + 0.02
        )
          matches.push(group)
      }
    }
    if (matches.length !== 1 || matches[0].some((p) => previouslyOwned.has(p))) return
    matches[0].forEach((p) => previouslyOwned.add(p))
  }
  if (
    headings.some((g, c) =>
      g.some((i) => i.rect[0] < cuts[c] - 0.02 || i.rect[2] > cuts[c + 1] + 0.02)
    ) ||
    fields.some((r) =>
      r.some((g, c) => g.some((i) => i.rect[0] < cuts[c] - 0.02 || i.rect[2] > cuts[c + 1] + 0.02))
    ) ||
    new Set(headings.flat()).size !== parts.length ||
    new Set(parts.map((i) => i.sourceToken ?? i)).size !== header.length ||
    parts.map((i) => i.text.replace(/\s/gu, '')).join('') !==
      [...header]
        .sort((a, b) => a.rect[0] - b.rect[0])
        .map((i) => i.text.replace(/\s/gu, ''))
        .join('')
  )
    return
  return {
    headings,
    original: header,
    cuts,
    top: opening[1],
    bottom: divider[1],
    baselineHeight: h,
    closing
  }
}

// A wide descriptive leaf may have a literal continuation only in the open
// source corridor before the next record's earliest ink, including scripts.
// The other four existing owners on every key baseline remain unchanged.
export function proveNativeWrappedLiteralDescriptionOwners(table, items, captions, rules) {
  const { cells, grid } = table
  if (
    grid?.length !== 5 ||
    grid.some((r) => r.length !== 7) ||
    cells?.length !== 35 ||
    cells.some((c) => c.rowSpan !== 1 || c.colSpan !== 1) ||
    new Set(cells.map((c) => c.row + ':' + c.column)).size !== cells.length
  )
    return
  const frame = finalLiteralOwnerFrame(table, items, captions, rules, true)
  if (!frame) return
  const { h, header, body, source, opening, closing, divider } = frame,
    headings = headerLeaves(header, h),
    same = (a, b) =>
      a.text === b.text &&
      sameRect(a.rect, b.rect) &&
      Math.abs(a.baseline - b.baseline) < 0.02 &&
      Math.abs(a.height - b.height) < 0.02
  if (
    header.length !== 5 ||
    headings.length !== 5 ||
    physicalRows(header, h).length !== 1 ||
    header.some((i) => Math.abs(i.height - h) > 0.02) ||
    cells
      .flatMap((c) => c.sourceTokens ?? [])
      .some((t) => source.filter((i) => same(i, t.sourceToken ?? t)).length !== 1)
  )
    return
  const starts = headings.map((g) => box(g)[0]),
    keys = body
      .filter((i) => Math.abs(i.height - h) < 0.02 && Math.abs(i.rect[0] - starts[0]) < h * 0.02)
      .sort((a, b) => a.baseline - b.baseline)
  if (keys.length !== 4 || keys.some((i, r) => r && i.baseline - keys[r - 1].baseline < h * 0.8))
    return
  const primary = keys.map(() => Array.from({ length: 5 }, () => [])),
    owned = new Set(),
    scriptParents = new Map(),
    retained = []
  for (let row = 0; row < 4; row++) {
    for (const [oldColumn, column] of [
      [0, 0],
      [4, 2],
      [5, 3],
      [6, 4]
    ]) {
      const matched = cells.filter((c) => c.row === row + 1 && c.column === oldColumn)
      if (matched.length !== 1) return
      const cell = matched[0],
        natives = (cell.sourceTokens ?? []).flatMap((t) => source.filter((i) => same(i, t)))
      if (
        !natives.length ||
        !literalOwnerMatches(cell, natives) ||
        natives.some(
          (i) =>
            Math.abs(i.height - h) > 0.02 ||
            Math.abs(i.baseline - keys[row].baseline) > 0.02 ||
            owned.has(i)
        ) ||
        Math.abs(box(natives)[0] - starts[column]) > h * 0.02
      )
        return
      primary[row][column] = natives
      natives.forEach((i) => owned.add(i))
      retained.push({ cell, column })
    }
  }
  const description = body.filter((i) => !owned.has(i)),
    ordinary = description.filter((i) => Math.abs(i.height - h) < 0.02),
    small = description.filter((i) => Math.abs(i.height - h) >= 0.02)
  for (const i of ordinary) {
    const matches = keys
      .map((k, row) => ({ row, distance: Math.abs(k.baseline - i.baseline) }))
      .filter((v) => v.distance < 0.02)
    if (matches.length === 1) {
      primary[matches[0].row][1].push(i)
      owned.add(i)
    }
  }
  if (primary.some((row) => !row[1].length || Math.abs(box(row[1])[0] - starts[1]) > h * 0.02))
    return
  for (const i of small) {
    if (!(i.height < h * 0.8)) return
    const parents = primary.flatMap((row, r) =>
      row[1]
        .filter((a) => Math.abs(a.height - h) < 0.02 && isAdjacentTableScript(i, a))
        .map((parent) => ({ parent, row: r }))
    )
    if (parents.length !== 1) return
    scriptParents.set(i, parents[0].parent)
    primary[parents[0].row][1].push(i)
    owned.add(i)
  }
  const continuations = physicalRows(
      ordinary.filter((i) => !owned.has(i)),
      h
    ),
    rowContinuations = keys.map(() => []),
    envelopes = primary.map((row) => box(row.flat()))
  for (const line of continuations) {
    const bounds = box(line),
      baseline = line[0].baseline
    if (Math.abs(bounds[0] - starts[1]) > h * 0.02) return
    const owners = keys
      .map((key, row) => ({ row, key }))
      .filter(
        ({ row, key }) =>
          baseline > key.baseline + 0.02 &&
          baseline - key.baseline < h * 1.25 &&
          bounds[1] > key.baseline + h * 0.05 &&
          bounds[3] < (envelopes[row + 1]?.[1] ?? closing[1]) - h * 0.05
      )
    if (owners.length !== 1 || rowContinuations[owners[0].row].length) return
    const row = owners[0].row
    rowContinuations[row] = line
    line.forEach((i) => owned.add(i))
  }
  if (owned.size !== body.length || !rowContinuations.some((g) => g.length)) return
  const records = primary.map((row, r) =>
      row.map((g, column) => (column === 1 ? [...g, ...rowContinuations[r]] : g))
    ),
    domains = headings.map((g, column) => box([...g, ...records.flatMap((row) => row[column])]))
  if (domains.slice(1).some((d, c) => d[0] - domains[c][2] < h * 0.2)) return
  const cuts = [
    opening[0],
    ...domains.slice(1).map((d, c) => (domains[c][2] + d[0]) / 2),
    opening[2]
  ]
  if (
    records.some((row) =>
      row.some((g, column) =>
        g.some((i) => i.rect[0] < cuts[column] - 0.02 || i.rect[2] > cuts[column + 1] + 0.02)
      )
    ) ||
    records.some((row, r) => r && box(row.flat())[1] <= box(records[r - 1].flat())[3] + h * 0.05) ||
    records.flat(2).length !== body.length ||
    new Set(records.flat(2)).size !== body.length
  )
    return
  const rowCuts = [
    divider[1],
    ...records.slice(1).map((r, n) => (box(records[n].flat())[3] + box(r.flat())[1]) / 2),
    closing[1]
  ]
  return {
    headings,
    records,
    retained,
    cuts,
    rowCuts,
    top: opening[1],
    divider: divider[1],
    source,
    scriptParents,
    baselineHeight: h
  }
}

// Keep the already proven records and rich glyph owners. Two empty model bands
// are not fields when complete native peers witness three contiguous faces.
export function proveNativeUnprintedSeparatorFaces(table, items, captions, rules) {
  const { grid, cells, cropRect } = table
  if (
    !grid?.length ||
    grid.length < 4 ||
    grid.some((r) => r.length !== 5) ||
    cells?.length !== grid.length * 5 ||
    table.notes?.length ||
    (table.readingRotation !== undefined && table.readingRotation !== 0) ||
    cells.some((c) => c.rowSpan !== 1 || c.colSpan !== 1) ||
    new Set(cells.map((c) => `${c.row}:${c.column}`)).size !== cells.length ||
    cells.some(
      (c) =>
        !Number.isInteger(c.row) ||
        !Number.isInteger(c.column) ||
        c.row < 0 ||
        c.row >= grid.length ||
        c.column < 0 ||
        c.column >= 5
    )
  )
    return
  const keep = [0, 2, 4],
    slot = (r, c) => cells.find((v) => v.row === r && v.column === c),
    empty = (c) =>
      !c.text.trim() && !c.sourceTokens?.length && !c.sourceRects?.length && !c.textRuns?.length
  if (
    !empty(slot(0, 0)) ||
    cells.some((c) => [1, 3].includes(c.column) && !empty(c)) ||
    cells.some(
      (c) =>
        c.text !== grid[c.row][c.column] ||
        !Array.isArray(c.sourceTokens) ||
        !Array.isArray(c.sourceRects) ||
        c.sourceTokens.length !== c.sourceRects.length ||
        c.sourceTokens.some((s) => c.sourceRects.filter((r) => sameRect(s.rect, r)).length !== 1)
    )
  )
    return
  // This proof-local two-heading entry cannot loosen other frame consumers.
  const frame = nativeHeaderFrame(table, items, rules, 0, undefined, 2)
  if (!frame) return
  const { h, source, header, body, opening, divider, closing } = frame,
    edges = joinHorizontalTableRules(rules, 0.01).filter(
      (r) => r[1] >= opening[1] && r[1] <= closing[1] && r[0] < closing[2] && r[2] > opening[0]
    ),
    titles = captions.filter(
      (c) =>
        captionKind(c.lines?.[0]) === 'table' &&
        c.rect[0] < opening[2] &&
        c.rect[2] > opening[0] &&
        c.rect[3] <= opening[1] &&
        opening[1] - c.rect[3] < h * 4
    ),
    owned = cells.flatMap((c) => c.sourceTokens),
    same = (a, b) => a.text === b.text && sameRect(a.rect, b.rect)
  if (
    titles.length !== 1 ||
    edges.length < 3 ||
    edges.length > 4 ||
    edges.some((r) => Math.abs(r[0] - opening[0]) > 0.02 || Math.abs(r[2] - opening[2]) > 0.02) ||
    edges.some((r) => r[1] < cropRect[1] || r[1] > cropRect[3]) ||
    rules.some(
      (r) =>
        r[0] === r[2] &&
        r[0] > opening[0] &&
        r[0] < opening[2] &&
        r[1] < closing[1] &&
        r[3] > opening[1]
    ) ||
    owned.length !== source.length ||
    source.some((s) => owned.filter((o) => same(o, s)).length !== 1) ||
    owned.some((o) => source.filter((s) => same(o, s)).length !== 1) ||
    items.some(
      (s) =>
        s.horizontal &&
        s.text.trim() &&
        s.rect[0] < opening[2] &&
        s.rect[2] > opening[0] &&
        s.rect[1] < closing[1] &&
        s.rect[3] > opening[1] &&
        !source.includes(s)
    ) ||
    source.some(
      (s) =>
        s.rect[0] < opening[0] - 0.02 ||
        s.rect[2] > opening[2] + 0.02 ||
        s.rect[1] < opening[1] ||
        s.rect[3] > closing[1] ||
        s.rect[0] < cropRect[0] ||
        s.rect[2] > cropRect[2]
    )
  )
    return
  const headings = [slot(0, 2), slot(0, 4)],
    ordinary = (s) => s.height >= h * 0.85 && s.height <= h * 1.15,
    scalar = (s) => /^[0-9−+<>≤≥.,()[\]*/×–—\s%-]+$/u.test(s)
  if (
    physicalRows(header.filter(ordinary), h).length !== 1 ||
    headings.some(
      (c) =>
        c.sourceTokens.filter(ordinary).length !== 1 ||
        !/\p{L}/u.test(c.text) ||
        c.sourceTokens.some((s) => !header.some((v) => same(v, s))) ||
        c.sourceTokens.some(
          (s) =>
            !ordinary(s) &&
            (!/^[†‡*]$/u.test(s.text) ||
              !c.textRuns?.some((r) => r.text === s.text && r.position === 'superscript'))
        )
    ) ||
    headings.flatMap((c) => c.sourceTokens).length !== header.length ||
    body.length !== (grid.length - 1) * 3
  )
    return
  const records = []
  for (let row = 1; row < grid.length; row++) {
    const faces = keep.map((c) => slot(row, c))
    if (
      faces.some((c) => c.sourceTokens.length !== 1 || !ordinary(c.sourceTokens[0])) ||
      !/\p{L}/u.test(faces[0].text) ||
      faces.slice(1).some((c) => !scalar(c.text))
    )
      return
    const tokens = faces.map((c) => c.sourceTokens[0])
    if (
      faces.some((c) => c.text !== c.sourceTokens[0].text) ||
      tokens.some((s) => Math.abs(s.baseline - tokens[0].baseline) >= h * 0.1) ||
      tokens.some((s) => s.baseline <= divider[1] || !body.some((b) => same(b, s))) ||
      (records.length && tokens[0].rect[1] <= Math.max(...records.at(-1).map((s) => s.rect[3]))) ||
      edges.some((r) => tokens.some((s) => r[1] > s.rect[1] && r[1] < s.rect[3]))
    )
      return
    records.push(tokens)
  }
  const domains = keep.map((col) =>
      box(cells.filter((c) => c.column === col).flatMap((c) => c.sourceTokens))
    ),
    gutters = domains.slice(1).map((d, n) => [domains[n][2], d[0]])
  if (gutters.some(([left, right]) => right - left < h * 0.3)) return
  const cuts = [
    Math.min(opening[0], domains[0][0]),
    ...gutters.map(([left, right]) => (left + right) / 2),
    Math.max(opening[2], domains[2][2])
  ]
  if (
    cells.some((c) => {
      const column = keep.indexOf(c.column)
      return c.sourceTokens.some(
        (s) => column < 0 || s.rect[0] < cuts[column] || s.rect[2] > cuts[column + 1]
      )
    })
  )
    return
  return { keep, cuts }
}

// Two independently centered literal keys establish each physical record.
// A one/two-line right field must have one nearest pair and its printed block
// center must coincide with that pair; a competing blank record is not filled.
export function recoverNativeCenteredLiteralPeers(table, items, captions, rules, cells = []) {
  const frame = nativeHeaderFrame(table, items, rules)
  if (!frame) return
  const { h, opening, closing, source, header, body } = frame,
    titles = captions.filter(
      (c) =>
        captionKind(c.lines?.[0]) === 'table' &&
        c.rect[0] < opening[2] &&
        c.rect[2] > opening[0] &&
        ((c.rect[3] <= opening[1] && opening[1] - c.rect[3] < h * 5) ||
          (c.rect[1] >= closing[1] && c.rect[1] - closing[1] < h * 5))
    )
  const full = joinHorizontalTableRules(rules, 0.01).filter(
    (r) =>
      Math.abs(r[0] - opening[0]) < 0.02 &&
      Math.abs(r[2] - opening[2]) < 0.02 &&
      r[1] >= opening[1] &&
      r[1] <= closing[1]
  )
  if (
    titles.length !== 1 ||
    full.length !== 3 ||
    header.length !== 3 ||
    physicalRows(header, h).length !== 1 ||
    source.some((i) => Math.abs(i.height - h) > h * 0.1) ||
    new Set(source.map((i) => i.text + ':' + i.rect.join(':'))).size !== source.length
  )
    return
  const heads = [...header].sort((a, b) => a.rect[0] - b.rect[0])
  if (heads.some((i) => !/\p{L}/u.test(i.text))) return
  const centers = heads.map((i) => (i.rect[0] + i.rect[2]) / 2),
    initial = [
      opening[0],
      (centers[0] + centers[1]) / 2,
      (centers[1] + centers[2]) / 2,
      opening[2]
    ],
    lane = (i) => initial.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  if (source.some((i) => lane(i) < 0)) return
  const pairs = physicalRows(
    body.filter((i) => lane(i) < 2),
    h
  )
  if (
    pairs.length < 5 ||
    pairs.length > 30 ||
    pairs.some((g) => [0, 1].some((c) => !g.some((i) => lane(i) === c && /\p{L}/u.test(i.text)))) ||
    pairs.slice(1).some((g, n) => g[0].baseline - pairs[n][0].baseline < h * 0.8) ||
    pairs.some(
      (g) =>
        Math.max(...g.map((i) => i.baseline)) - Math.min(...g.map((i) => i.baseline)) > h * 0.02
    )
  )
    return
  const groups = pairs.map((g) => [...g]),
    anchors = pairs.map((g) => g[0].baseline)
  for (const i of body.filter((i) => lane(i) === 2)) {
    const distances = anchors.map((y) => Math.abs(y - i.baseline)),
      nearest = Math.min(...distances),
      owners = distances.map((d, n) => ({ d, n })).filter((v) => Math.abs(v.d - nearest) < h * 0.02)
    if (owners.length !== 1 || nearest > h * 0.7) return
    groups[owners[0].n].push(i)
  }
  if (
    groups.some((g, n) => {
      const right = g.filter((i) => lane(i) === 2),
        ys = [...new Set(right.map((i) => i.baseline))].sort((a, b) => a - b)
      return (
        !right.length ||
        ys.length > 2 ||
        Math.abs((ys[0] + ys.at(-1)) / 2 - anchors[n]) > h * 0.01 ||
        ys.slice(1).some((y, k) => y - ys[k] < h * 0.8 || y - ys[k] > h * 1.4)
      )
    })
  )
    return
  for (let c = 0; c < 3; c++) {
    const nativeCenters = groups.map((g) => {
      const b = box(g.filter((i) => lane(i) === c))
      return (b[0] + b[2]) / 2
    })
    if (Math.max(...nativeCenters) - Math.min(...nativeCenters) > h * 0.03) return
  }
  const domains = heads.map((i, c) => box([i, ...body.filter((a) => lane(a) === c)])),
    rects = groups.map(box)
  if (
    domains.slice(1).some((d, c) => d[0] - domains[c][2] < h * 0.2) ||
    rects.slice(1).some((r, n) => r[1] <= rects[n][3]) ||
    groups.flat().length !== body.length ||
    new Set(groups.flat()).size !== body.length ||
    items.some(
      (i) =>
        i.horizontal &&
        i.text.trim() &&
        i.baseline > opening[1] &&
        i.baseline < closing[1] &&
        i.rect[0] < opening[2] &&
        i.rect[2] > opening[0] &&
        !source.includes(i)
    )
  )
    return
  const cuts = [
    opening[0],
    ...domains.slice(1).map((d, c) => (domains[c][2] + d[0]) / 2),
    opening[2]
  ]
  if (source.some((i) => i.rect[0] < cuts[lane(i)] - 0.02 || i.rect[2] > cuts[lane(i) + 1] + 0.02))
    return
  if (nativeCellPartitionComplete(cells, source, [header, ...groups], lane, 3)) return
  return {
    cuts,
    groups: [header, ...groups],
    headerRows: 1,
    consumed: source,
    baselineHeight: h,
    repair: 'native-centered-literal-peer-records-recovered',
    cropRect: [
      Math.min(table.cropRect[0], opening[0] - 0.5),
      table.cropRect[1],
      Math.max(table.cropRect[2], opening[2] + 0.5),
      Math.min(table.cropRect[3], closing[1] + 0.5)
    ]
  }
}

export function recoverNativeCompactLiteralRecords(table, items, captions, rules, runs = []) {
  const frame = nativeHeaderFrame(table, items, rules)
  if (!frame) return recoverNativeCaptionWidthLiteralRecords(table, items, captions, rules)
  const { h, opening, closing, header } = frame
  let body = frame.body
  const titles = captions.filter(
    (c) =>
      captionKind(c.lines?.[0]) === 'table' &&
      c.rect[0] < opening[2] &&
      c.rect[2] > opening[0] &&
      ((c.rect[3] <= opening[1] && opening[1] - c.rect[3] < h * 5) ||
        (c.rect[1] >= closing[1] && c.rect[1] - closing[1] < h * 5))
  )
  const ordinaryHeader = header.filter((i) => i.height >= h * 0.85)
  if (titles.length !== 1 || physicalRows(ordinaryHeader, h).length !== 1) return
  const headerFields = headerLeaves(header, h * (0.65 / 0.3))
  if (headerFields.length >= 3 && headerFields.length <= 14) {
    const gutters = headerFields.slice(1).map((g, n) => [box(headerFields[n])[2], box(g)[0]])
    body = body.flatMap((i) => {
      const parts = splitObserved(i, runs, gutters, h)
      // A heading gutter can overlap spaces inside a wide literal interval.
      // A TJ boundary must also end that complete printed field: an unmatched
      // opening delimiter or a dangling comma is not a record boundary.
      const complete = (s) =>
        !/[,;[(]\s*$/u.test(s) &&
        (s.match(/\[/gu)?.length ?? 0) === (s.match(/\]/gu)?.length ?? 0) &&
        (s.match(/\(/gu)?.length ?? 0) === (s.match(/\)/gu)?.length ?? 0)
      return parts &&
        parts.every(
          (p, n) =>
            complete(p.text) &&
            (n === 0 || /^[−+-]?(?:\d|\[\s*[−+-]?\d)|^[<>≤≥]\s*\d/u.test(p.text))
        )
        ? parts
        : [i]
    })
  }
  const ordinary = body.filter((i) => i.height >= h * 0.85),
    bands = physicalRows(ordinary, h)
  if (bands.length < 3 || bands.length > 50) return
  let fields = bands.map((g) => {
    const fields = []
    for (const i of [...g].sort((a, b) => a.rect[0] - b.rect[0])) {
      const prior = fields.at(-1),
        previous = prior?.at(-1),
        observedBoundary =
          previous &&
          previous.nativeLaneSplit &&
          i.nativeLaneSplit &&
          previous.sourceToken === i.sourceToken
      if (prior && !observedBoundary && i.rect[0] - box(prior)[2] < h * 0.65) prior.push(i)
      else fields.push([i])
    }
    return fields
  })
  // Complete independently printed header faces can retain literal method or
  // verdict leaves between measurements. Their repeated native gutters also
  // keep large spaces inside an interval in that same leaf. No missing field,
  // continuation baseline or spanning source is filled by this proof.
  const headerCuts = [
    opening[0],
    ...headerFields.slice(1).map((g, c) => (box(headerFields[c])[2] + box(g)[0]) / 2),
    opening[2]
  ]
  const headerFaces =
    headerFields.length >= 3 &&
    headerFields.length <= 14 &&
    headerFields.every((g) => /\p{L}/u.test(joined(g))) &&
    headerFields.slice(1).every((g, c) => box(g)[0] - box(headerFields[c])[2] >= h * 0.2) &&
    ordinary.every((i) =>
      headerCuts.slice(1).some((x, c) => i.rect[0] >= headerCuts[c] - 0.02 && i.rect[2] <= x + 0.02)
    )
  if (headerFaces) {
    const peers = bands.map((g) =>
      headerCuts
        .slice(1)
        .map((x, c) => g.filter((i) => i.rect[0] >= headerCuts[c] - 0.02 && i.rect[2] <= x + 0.02))
    )
    const independentAtoms = (g) => {
      const parts = headerLeaves(g, h * (0.65 / 0.3))
      return parts.length > 1 && parts.some((p) => /^[−+-]?\d+(?:\.\d+)?%?$/u.test(joined(p)))
    }
    if (peers.every((row) => row.every((g) => g.length && !independentAtoms(g)))) fields = peers
  }
  const count = Math.max(...fields.map((g) => g.length)),
    completeFields = fields.filter((g) => g.length === count),
    sparse = fields.map((g, n) => ({ g, n })).filter(({ g }) => g.length !== count)
  if (
    count < 3 ||
    count > 14 ||
    (sparse.length &&
      (sparse.length !== 1 ||
        completeFields.length < 3 ||
        sparse[0].n === 0 ||
        sparse[0].n === fields.length - 1))
  )
    return
  if (
    headerFields.length > count ||
    fields.some((row) =>
      row.some(
        (g) =>
          g.some((i) => i.text.trim() === '|') ||
          (/^\p{L}/u.test(joined(g)) &&
            (headerLeaves(
              g.filter((i) => i.height >= h * 0.85),
              h * (0.65 / 0.3)
            ).length > 1 ||
              g.some(
                (i) => i.height >= h * 0.85 && /^[−+-]?\d+(?:\.\d+)?(?:\s*±|$)/u.test(i.text.trim())
              )))
      )
    )
  )
    return
  const literalMeasurement = (g) =>
    /^[−+-]?(?:\d|\[\s*[−+-]?\d)|^[<>≤≥]\s*\d|^(?:True|False|Yes|No)$/u.test(joined(g))
  let prefix = 0
  while (prefix < count && completeFields.every((row) => !literalMeasurement(row[prefix]))) prefix++
  const exactMixedFaces =
    headerFields.length === count &&
    completeFields.every((row) => row.every((g) => g.length)) &&
    completeFields[0].filter((_, c) => completeFields.every((row) => literalMeasurement(row[c])))
      .length >= 2 &&
    completeFields.every((row) => !literalMeasurement(row[0]))
  if (
    !exactMixedFaces &&
    (prefix < 1 ||
      prefix > 2 ||
      count - prefix < 2 ||
      completeFields.some((row) => row.slice(prefix).some((g) => !literalMeasurement(g))))
  )
    return
  const domains = Array.from({ length: count }, (_, c) =>
    box(completeFields.flatMap((row) => row[c]))
  )
  if (headerFields.length === count)
    for (let c = 0; c < count; c++) {
      const ink = box(headerFields[c])
      domains[c][0] = Math.min(domains[c][0], ink[0])
      domains[c][2] = Math.max(domains[c][2], ink[2])
    }
  if (domains.slice(1).some((d, c) => d[0] - domains[c][2] < h * 0.2)) return
  const cuts = [
    opening[0],
    ...domains.slice(1).map((d, c) => (domains[c][2] + d[0]) / 2),
    opening[2]
  ]
  const lane = (i) =>
    cuts.slice(1).findIndex((x, c) => i.rect[0] >= cuts[c] - 0.02 && i.rect[2] <= x + 0.02)
  const headings = cuts.slice(1).map((_, c) => header.filter((i) => lane(i) === c))
  if (
    headings.some((g) => !g.length || !/\p{L}/u.test(joined(g))) ||
    header.some((i) => lane(i) < 0)
  )
    return
  // One interior explanatory record may print a literal reason followed by
  // empty metric leaves. The complete peers and independently printed headers
  // still settle every face; retain that source text and those actual blanks
  // without propagating a value or expanding a semantic span.
  for (const { g } of sparse) {
    if (
      g.length < 2 ||
      count - g.length < 2 ||
      literalMeasurement(g.at(-1)) ||
      !/^\p{L}+(?:[\s-]+\p{L}+)+$/u.test(joined(g.at(-1))) ||
      g.some((v, c) => v.some((i) => lane(i) !== c))
    )
      return
  }
  const records = bands.map(() => [])
  for (const i of body) {
    const distances = bands.map((g) => Math.abs(g[0].baseline - i.baseline)),
      nearest = Math.min(...distances),
      matches = distances.map((d, n) => ({ d, n })).filter(({ d }) => Math.abs(d - nearest) < 0.02)
    if (nearest > h * 0.65 || matches.length !== 1 || lane(i) < 0) return
    if (i.height < h * 0.85) {
      const anchors = bands[matches[0].n].filter(
        (a) =>
          lane(a) === lane(i) &&
          a.height > i.height / 0.8 &&
          Math.abs(a.rect[2] - i.rect[0]) < i.height * 0.5 &&
          Math.abs(a.baseline - i.baseline) < a.height * 0.7
      )
      if (anchors.length !== 1) return
    }
    records[matches[0].n].push(i)
  }
  const source = [...header, ...body]
  const assigned = [...header, ...records.flat()],
    identities = assigned.map((i) => i.text + ':' + i.rect.join(':'))
  if (
    assigned.length !== source.length ||
    new Set(assigned).size !== source.length ||
    new Set(identities).size !== identities.length ||
    items.some(
      (i) =>
        i.horizontal &&
        i.text.trim() &&
        i.baseline > opening[1] &&
        i.baseline < closing[1] &&
        i.rect[0] < opening[2] &&
        i.rect[2] > opening[0] &&
        !source.includes(i) &&
        !source.some((p) => p.sourceToken === i)
    )
  )
    return
  return {
    cuts,
    groups: [header, ...records],
    headerRows: 1,
    consumed: [...source, ...source.map((i) => i.sourceToken).filter(Boolean)],
    baselineHeight: h,
    repair: 'native-compact-literal-records-recovered',
    cropRect: [
      Math.min(table.cropRect[0], opening[0] - 0.5),
      table.cropRect[1],
      Math.max(table.cropRect[2], opening[2] + 0.5),
      Math.min(table.cropRect[3], closing[1] + 0.5)
    ]
  }
}

// Repair only the printed header ownership. Fraction/radical body fields keep
// their existing literal serialization and source rectangles unchanged.
export function recoverNativeIsolatedPrintedHeader(table, items, rules, cells, rows) {
  const frame = nativeHeaderFrame(table, items, rules, 1)
  if (!frame || !rows.length) return
  const { h, opening, divider, header } = frame
  const leafCount = Math.max(...cells.map((c) => c.column + c.colSpan))
  const firstCells = cells.filter((c) => c.row === 0).sort((a, b) => a.column - b.column)
  if (leafCount < 3 || leafCount > 16 || firstCells.some((c) => c.rowSpan !== 1)) return
  const cuts = [firstCells[0].rect[0]]
  for (let c = 1; c < leafCount; c++) {
    const prior = firstCells.find((v) => v.column + v.colSpan === c)
    const next = firstCells.find((v) => v.column === c)
    const body = cells.find((v) => v.row > 0 && v.column === c && v.colSpan === 1)
    const x = next?.rect[0] ?? prior?.rect[2] ?? body?.rect[0]
    if (!Number.isFinite(x)) return
    cuts.push(x)
  }
  cuts.push(firstCells.at(-1).rect[2])
  const firstTokens = firstCells.flatMap((c) => c.sourceTokens ?? [])
  const sameToken = (a, b) => a.text === b.text && sameRect(a.rect, b.rect)
  const bodyInFirst = firstTokens.filter((i) => i.baseline > divider[1])
  const headerInFirst = firstTokens.filter((i) => header.some((v) => sameToken(i, v)))
  if (
    !bodyInFirst.length &&
    firstCells.every((c) => c.colSpan === 1) &&
    rows.length >= 5 &&
    rows.length <= 41
  ) {
    const label = header.find((i) => /^Fig\.$/u.test(i.text.trim()))
    const firstLeaf = cells.filter((c) => c.column === 0).sort((a, b) => a.row - b.row)
    if (
      label &&
      firstLeaf.length === rows.length &&
      firstLeaf.every((c) => c.rowSpan === 1 && c.colSpan === 1)
    ) {
      const indices = firstLeaf
        .slice(1)
        .map((cell, n) =>
          (cell.sourceTokens ?? []).filter(
            (i) =>
              i.text.trim() === String(n + 1) &&
              i.rect[0] >= opening[0] - h * 0.02 &&
              i.rect[2] <= label.rect[2] &&
              i.baseline > divider[1]
          )
        )
      const titles = header.filter(
        (i) => i !== label && i.rect[0] > label.rect[2] && i.rect[2] < cuts[1]
      )
      if (
        indices.every((g) => g.length === 1) &&
        titles.length === 1 &&
        header.length === leafCount + 1 &&
        headerInFirst.length === header.length &&
        headerInFirst.length === firstTokens.length
      ) {
        const indexed = [label, ...indices.map((g) => g[0])]
        const inkLeft = Math.max(...indexed.map((i) => i.rect[2]))
        const content = firstLeaf.flatMap((c) =>
          (c.sourceTokens ?? []).filter((i) => !indexed.some((v) => sameToken(i, v)))
        )
        const inkRight = Math.min(...content.map((i) => i.rect[0]))
        if (
          inkRight - inkLeft >= h * 0.4 &&
          firstLeaf.every((c, n) => c.text.startsWith(indexed[n].text.trim() + ' '))
        )
          return {
            mode: 'leading-index',
            header: indexed,
            cuts: [opening[0], (inkLeft + inkRight) / 2, ...cuts.slice(1)],
            opening,
            divider,
            h
          }
      }
    }
  }
  if (bodyInFirst.length) {
    // One literal header per leaf, or a blank descriptive stub followed by
    // complete scalar peers, must be independently printed above the divider.
    if (firstCells.length !== leafCount || firstCells.some((c) => c.colSpan !== 1)) return
    // A closed native header face settles its own literal prefix even when
    // the detector puts a narrative first record in that same row. Existing
    // record text, scripts, blank fields and row membership remain untouched.
    const vertical = rules.filter((r) => r[0] === r[2]),
      walls = [...new Set(vertical.map((r) => r[0]))]
        .filter((x) => classifyTableRuleEdge(vertical, 0, x, opening[1], divider[1]) === 1)
        .sort((a, b) => a - b)
    if (
      walls.length === leafCount + 1 &&
      Math.abs(walls[0] - opening[0]) < 1 &&
      Math.abs(walls.at(-1) - opening[2]) < 1 &&
      headerInFirst.length === header.length &&
      header.every((i) => i.height >= h * 0.85)
    ) {
      const groups = walls
        .slice(1)
        .map((right, c) =>
          header.filter((i) => i.rect[0] >= walls[c] - 0.02 && i.rect[2] <= right + 0.02)
        )
      const prefixes = groups.map((g) =>
        [...g]
          .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
          .map((i, n, all) =>
            n &&
            (Math.abs(i.baseline - all[n - 1].baseline) > h * 0.65 ||
              i.rect[0] - all[n - 1].rect[2] > h * 0.12)
              ? ' ' + i.text.trim()
              : i.text.trim()
          )
          .join('')
      )
      const assigned = [],
        occupied = new Set()
      const complete = cells.every((cell) => {
        const key = cell.row + ':' + cell.column
        if (
          cell.colSpan !== 1 ||
          cell.rowSpan !== 1 ||
          !Number.isInteger(cell.row) ||
          cell.row < 0 ||
          cell.row >= rows.length ||
          !Number.isInteger(cell.column) ||
          cell.column < 0 ||
          cell.column >= leafCount ||
          occupied.has(key)
        )
          return false
        occupied.add(key)
        for (const token of cell.sourceTokens ?? []) {
          const source = frame.source.filter((i) => sameToken(i, token))
          if (
            source.length !== 1 ||
            assigned.includes(source[0]) ||
            token.rect[0] < walls[cell.column] - 0.02 ||
            token.rect[2] > walls[cell.column + 1] + 0.02 ||
            (cell.row > 0 && header.some((i) => sameToken(i, token)))
          )
            return false
          assigned.push(source[0])
        }
        if (cell.row === 0) {
          const prefix = prefixes[cell.column]
          if (!prefix || !cell.text.startsWith(prefix + ' ')) return false
          if (
            cell.textRuns?.length &&
            (cell.textRuns[0].position !== 'normal' ||
              !cell.textRuns[0].text.startsWith(prefix + ' '))
          )
            return false
        }
        return true
      })
      if (
        complete &&
        occupied.size === rows.length * leafCount &&
        assigned.length === frame.source.length &&
        groups.every((g) => g.length && /\p{L}/u.test(joined(g))) &&
        new Set(groups.flat()).size === header.length &&
        groups.flat().length === header.length
      )
        return { mode: 'insert', header, groups, cuts: walls, opening, divider, h, prefixes }
    }
    const groups = cuts
      .slice(1)
      .map((right, c) =>
        header.filter(
          (i) => (i.rect[0] + i.rect[2]) / 2 >= cuts[c] && (i.rect[0] + i.rect[2]) / 2 < right
        )
      )
    const repeated =
      groups.every((g) => g.length === 1 && /^\p{L}+$/u.test(g[0].text)) &&
      leafCount % 2 === 0 &&
      groups.every((g, n) => g[0].text === groups[n % 2][0].text)
    const blankStub =
      groups[0].length === 0 &&
      groups.slice(1).every((g) => g.length) &&
      cells.filter((c) => c.column > 0).every((c) => /^[−+-]?\d+(?:\.\d+)?$/u.test(c.text)) &&
      rows.length >= 2 &&
      rows.length <= 4 &&
      headerInFirst.length === 0
    if (!repeated && !blankStub) return
    if (new Set(groups.flat()).size !== header.length || groups.flat().length !== header.length)
      return
    // Move cuts into the measured open gutter, including all header and body
    // ink. No glyph or cell text is split to make an otherwise invalid fit.
    for (let c = 1; c < leafCount; c++) {
      const left = [
        ...groups[c - 1],
        ...cells
          .filter((v) => v.column === c - 1)
          .flatMap((v) =>
            (v.sourceTokens ?? []).filter((i) => !header.some((t) => sameToken(t, i)))
          )
      ]
      const right = [
        ...groups[c],
        ...cells
          .filter((v) => v.column === c)
          .flatMap((v) =>
            (v.sourceTokens ?? []).filter((i) => !header.some((t) => sameToken(t, i)))
          )
      ]
      if (!left.length || !right.length) return
      const a = Math.max(...left.map((i) => i.rect[2])),
        b = Math.min(...right.map((i) => i.rect[0]))
      if (b - a < h * 0.2) return
      cuts[c] = (a + b) / 2
    }
    if (headerInFirst.length && headerInFirst.length !== header.length) return
    return { mode: 'insert', header, groups, cuts, opening, divider, h }
  }
  if (headerInFirst.length !== firstTokens.length || headerInFirst.length !== header.length) return
  const walls = rules
    .filter(
      (r) =>
        r[0] === r[2] &&
        Math.abs(r[1] - opening[1]) < h * 0.06 &&
        Math.abs(r[3] - divider[1]) < h * 0.06
    )
    .map((r) => r[0])
    .sort((a, b) => a - b)
  if (
    walls.length < 3 ||
    walls.length > 9 ||
    walls.length - 1 !== leafCount / 2 ||
    Math.abs(walls[0] - opening[0]) > h * 0.06 ||
    Math.abs(walls.at(-1) - opening[2]) > h * 0.06
  )
    return
  const groups = walls
    .slice(1)
    .map((right, c) =>
      header.filter((i) => i.rect[0] >= walls[c] - h * 0.02 && i.rect[2] <= right + h * 0.02)
    )
  if (
    groups.some((g) => !g.length) ||
    new Set(groups.flat()).size !== header.length ||
    groups.flat().length !== header.length ||
    groups.some(
      (_, n) =>
        (cuts[n * 2] + cuts[n * 2 + 1]) / 2 < walls[n] ||
        (cuts[n * 2 + 1] + cuts[n * 2 + 2]) / 2 > walls[n + 1]
    )
  )
    return
  // The drawn faces settle only the header's column span. A discarded model
  // proposal is no longer a column conflict only if every final body slot and
  // literal source token independently belongs to its single printed leaf.
  const occupied = new Set(),
    assigned = []
  const columnOwnershipProved =
    cells
      .filter((c) => c.row > 0)
      .every((c) => {
        if (
          !Number.isInteger(c.row) ||
          !Number.isInteger(c.rowSpan) ||
          c.rowSpan < 1 ||
          c.row + c.rowSpan > rows.length ||
          !Number.isInteger(c.column) ||
          c.column < 0 ||
          c.column >= leafCount ||
          c.colSpan !== 1 ||
          ((c.sourceTokens?.length || c.text.trim()) && c.rowSpan !== 1)
        )
          return false
        for (let row = c.row; row < c.row + c.rowSpan; row++) {
          const key = row + ':' + c.column
          if (occupied.has(key)) return false
          occupied.add(key)
        }
        for (const token of c.sourceTokens ?? []) {
          const matches = frame.body.filter((i) => sameToken(i, token))
          if (
            matches.length !== 1 ||
            assigned.includes(matches[0]) ||
            token.rect[0] < cuts[c.column] - 0.02 ||
            token.rect[2] > cuts[c.column + 1] + 0.02
          )
            return false
          assigned.push(matches[0])
        }
        return true
      }) &&
    occupied.size === (rows.length - 1) * leafCount &&
    assigned.length === frame.body.length
  return { mode: 'replace-pairs', header, groups, cuts, opening, divider, h, columnOwnershipProved }
}

// A nested model band may discard the first printed record while retaining
// a following blank-stub continuation. Insert only that wholly unowned record;
// the remaining cells and scientific expressions keep their existing owners.
export function recoverNativeUnownedFirstRecord(
  table,
  items,
  captions,
  rules,
  cells,
  rows,
  unassigned
) {
  if (!unassigned.length || rows.length < 5 || rows.length > 50) return
  const firstCells = cells.filter((c) => c.row === 0).sort((a, b) => a.column - b.column)
  if (
    firstCells.length !== 4 ||
    firstCells.some((c, n) => c.column !== n || c.colSpan !== 1 || c.rowSpan !== 1)
  )
    return
  const cuts = [firstCells[0].rect[0], ...firstCells.map((c) => c.rect[2])]
  if (firstCells.some((c, n) => Math.abs(c.rect[0] - cuts[n]) > 0.02)) return
  const h = Math.max(
    0,
    ...items
      .filter(
        (i) =>
          i.horizontal &&
          i.rect[0] >= cuts[0] &&
          i.rect[2] <= cuts[4] &&
          i.baseline >= table.cropRect[1] &&
          i.baseline <= table.cropRect[3]
      )
      .map((i) => i.height)
  )
  const frame = nativeHeaderFrame(table, items, rules, 0, h)
  if (!frame) return
  const { opening, divider, closing, header, body } = frame
  const captioned = captions.filter(
    (c) =>
      captionKind(c.lines[0]) === 'table' &&
      c.rect[0] >= opening[0] - h &&
      c.rect[2] <= opening[2] + h &&
      c.rect[3] <= opening[1] &&
      opening[1] - c.rect[3] < h * 5
  )
  if (captioned.length !== 1) return
  const lane = (item) =>
    cuts
      .slice(1)
      .map((right, c) => ({
        c,
        inside: item.rect[0] >= cuts[c] - 0.02 && item.rect[2] <= right + 0.02
      }))
      .filter((v) => v.inside)
  if ([...header, ...body].some((i) => lane(i).length !== 1)) return
  if (
    cuts
      .slice(1)
      .some(
        (_, c) =>
          !header.some((i) => lane(i)[0].c === c && i.height >= h * 0.85 && /\p{L}/u.test(i.text))
      )
  )
    return
  const anchors = physicalRows(
    body.filter((i) => i.height >= h * 0.85),
    h
  )
  if (anchors.length < 4) return
  const baselines = anchors.map((g) => median(g.map((i) => i.baseline)))
  const groups = anchors.map(() => [])
  for (const item of body) {
    const distances = baselines.map((y) => Math.abs(y - item.baseline)),
      closest = Math.min(...distances),
      owners = distances.map((d, n) => ({ d, n })).filter((v) => Math.abs(v.d - closest) < 0.02)
    if (owners.length !== 1 || closest > h * 0.5) return
    groups[owners[0].n].push(item)
  }
  const first = groups[0],
    following = groups[1],
    missingLanes = cuts.slice(1).map((_, c) => first.filter((i) => lane(i)[0].c === c))
  if (missingLanes.some((g) => !g.some((i) => i.height >= h * 0.85))) return
  const peers = anchors
    .slice(1)
    .filter((g) => cuts.slice(1).every((_, c) => g.some((i) => lane(i)[0].c === c)))
  if (peers.length < 3) return
  // Every surviving native glyph must already have one literal cell owner.
  // Partial ownership or extra unassigned prose makes this a different case.
  const sameToken = (a, b) => a.text === b.text && sameRect(a.rect, b.rect)
  if (frame.source.some((i, n) => frame.source.some((v, j) => j !== n && sameToken(i, v)))) return
  const ownerOf = (token) =>
    cells.flatMap((c) => (c.sourceTokens ?? []).filter((i) => sameToken(i, token)).map(() => c))
  if (first.some((i) => ownerOf(i).length !== 0)) return
  if (
    body
      .filter((i) => !first.includes(i))
      .some((i) => {
        const owners = ownerOf(i)
        return owners.length !== 1 || owners[0].colSpan !== 1 || owners[0].column !== lane(i)[0].c
      })
  )
    return
  if (header.some((i) => ownerOf(i).length !== 1)) return
  if (JSON.stringify([...unassigned].sort()) !== JSON.stringify(first.map((i) => i.text).sort()))
    return
  const nextOwners = new Set(following.map((i) => ownerOf(i)[0]?.row))
  if (nextOwners.size !== 1 || nextOwners.has(undefined)) return
  const row = [...nextOwners][0]
  if (row < 1 || row >= rows.length || cells.some((c) => c.row < row && c.row + c.rowSpan > row))
    return
  const before = rows[row - 1],
    next = rows[row],
    ink = box(first),
    nextInk = box(following),
    boundary = (ink[3] + nextInk[1]) / 2
  if (
    before.rect[3] > ink[1] ||
    ink[1] < divider[1] ||
    nextInk[1] <= ink[3] ||
    boundary >= next.rect[3]
  )
    return
  if (
    rules.some(
      (r) =>
        r[1] === r[3] &&
        r[1] > divider[1] &&
        r[1] < nextInk[1] &&
        r[0] < opening[2] &&
        r[2] > opening[0]
    )
  )
    return
  if (
    items.some(
      (i) =>
        i.text.trim() &&
        i.rect[0] < opening[2] &&
        i.rect[2] > opening[0] &&
        i.rect[3] > divider[1] &&
        i.rect[1] < boundary &&
        !first.some((v) => sameToken(v, i))
    )
  )
    return
  if (
    cells
      .filter((c) => c.row === row)
      .some((c) => c.rowSpan !== 1 || (c.sourceTokens ?? []).some((i) => i.rect[1] < boundary))
  )
    return
  if (closing[1] <= nextInk[3]) return
  return {
    row,
    groups: missingLanes,
    rect: [cuts[0], divider[1], cuts[4], boundary],
    boundary,
    cuts
  }
}

// Independent closed panels retain separate literal records and source fonts.
export function proveNativeIndependentPanelSources(table, items, captions, rules, runs = []) {
  const valid = (r) => r?.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3],
    overlap = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
    contains = (a, b) =>
      b[0] >= a[0] - 0.02 && b[1] >= a[1] - 0.02 && b[2] <= a[2] + 0.02 && b[3] <= a[3] + 0.02,
    fail = () => undefined,
    programMatches = (i) => {
      const matched = runs.filter(
        (r) => r.text === i.text && valid(r.rect) && sameRect(r.rect, i.rect)
      )
      return (
        matched.length === 1 &&
        matched[0].baseline === i.baseline &&
        matched[0].height === i.height &&
        matched[0].literalGlyphs?.join('') === i.text.replace(/\s/gu, '') &&
        matched[0].glyphRuns?.length === [...i.text.replace(/\s/gu, '')].length &&
        new Set(matched[0].glyphRuns).size === 1
      )
    }
  if (!valid(table.cropRect) || table.parts) return fail('invalid-or-already-parted-input')
  const crop = table.cropRect,
    near = items.filter((i) => i.text?.trim() && valid(i.rect) && overlap(i.rect, crop))
  const h = median(near.map((i) => i.height).filter(Number.isFinite))
  if (!(h > 0)) return fail('missing-normal-font')
  const full = joinHorizontalTableRules(rules, 0.01, 1)
    .filter((r) => r[1] >= crop[1] - h && r[1] <= crop[3] && r[0] >= crop[0] && r[2] <= crop[2])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const frames = []
  for (const r of full) {
    if (
      frames.some(
        (f) => Math.abs(f.opening[0] - r[0]) < 0.02 && Math.abs(f.opening[2] - r[2]) < 0.02
      )
    )
      continue
    const edges = full
      .filter((x) => Math.abs(x[0] - r[0]) < 0.02 && Math.abs(x[2] - r[2]) < 0.02)
      .sort((a, b) => a[1] - b[1])
    if (edges.length === 3) frames.push({ opening: edges[0], divider: edges[1], closing: edges[2] })
  }
  if (frames.length !== 2) return fail('not-two-independent-three-edge-frames')
  frames.sort((a, b) => a.opening[0] - b.opening[0])
  if (
    frames[0].opening[2] >= frames[1].opening[0] ||
    Math.abs(frames[0].opening[1] - frames[1].opening[1]) > 0.02 ||
    Math.abs(frames[0].divider[1] - frames[1].divider[1]) > 0.02 ||
    Math.abs(frames[0].closing[1] - frames[1].closing[1]) > 0.05
  )
    return fail('non-independent-frame-topology')
  const whole = [
    frames[0].opening[0],
    frames[0].opening[1],
    frames[1].opening[2],
    Math.max(...frames.map((f) => f.closing[1]))
  ]
  const titles = captions.filter(
    (c) =>
      captionKind(c.lines?.[0] ?? '') === 'table' &&
      c.rect[3] < whole[1] &&
      whole[1] - c.rect[3] < h * 4 &&
      c.rect[0] < whole[2] &&
      c.rect[2] > whole[0]
  )
  if (titles.length !== 1) return fail('missing-or-competing-table-caption')
  const used = [],
    panels = []
  for (const [index, f] of frames.entries()) {
    const frame = [f.opening[0], f.opening[1], f.opening[2], f.closing[1]]
    const intersect = items.filter((i) => i.text?.trim() && overlap(i.rect, frame))
    if (
      !intersect.length ||
      intersect.some(
        (i) =>
          !i.horizontal ||
          !valid(i.rect) ||
          !contains(frame, i.rect) ||
          !Number.isFinite(i.baseline) ||
          !(i.height > 0)
      )
    )
      return fail('foreign-or-crossing-frame-font')
    if (
      intersect.some((i, n) =>
        intersect.some(
          (j, k) =>
            k !== n &&
            sameRect(i.rect, j.rect) &&
            i.text === j.text &&
            i.baseline === j.baseline &&
            i.height === j.height
        )
      )
    )
      return fail('duplicate-source-font')
    if (intersect.some((i) => !programMatches(i))) return
    const subtitle = items.filter(
      (i) =>
        i.text?.trim() &&
        i.horizontal &&
        i.rect[0] >= frame[0] &&
        i.rect[2] <= frame[2] &&
        i.rect[3] < frame[1] &&
        frame[1] - i.rect[3] < h * 1.5
    )
    if (
      subtitle.length !== 1 ||
      !new RegExp(`^\\(${String.fromCharCode(97 + index)}\\)\\s+\\p{L}`, 'u').test(
        subtitle[0].text
      ) ||
      Math.abs(subtitle[0].height - h) > h * 0.04
    )
      return fail('missing-independent-consecutive-subtitle')
    if (!programMatches(subtitle[0])) return
    const header = intersect.filter((i) => i.rect[3] < f.divider[1]),
      body = intersect.filter((i) => i.rect[1] > f.divider[1])
    if (header.length + body.length !== intersect.length) return fail('font-crosses-header-divider')
    const normal = (i) => Math.abs(i.height - h) < h * 0.04
    const parents = new Map()
    for (const script of intersect.filter((i) => !normal(i))) {
      const matches = intersect.filter((i) => normal(i) && isAdjacentTableScript(script, i))
      if (matches.length !== 1) return fail('non-unique-existing-adjacent-script-parent')
      parents.set(script, matches[0])
    }
    const heads = header
      .filter(normal)
      .flatMap((i) => {
        const parts = nativeMeasuredWordTokens(i, runs, h)
        return parts.length === 1
          ? parts
          : parts.map((p) => ({ ...p, sourceToken: i, nativeLaneSplit: true }))
      })
      .sort((a, b) => a.rect[0] - b.rect[0])
    if (heads.length < 3 || heads.length > 8 || heads.some((i) => !/[\p{L}]/u.test(i.text)))
      return fail('unproved-header-leaves')
    const headfields = heads.map((i) => [i, ...header.filter((s) => parents.get(s) === i)])
    const components = []
    for (const i of [...headfields.flat(), ...body].sort((a, b) => a.rect[0] - b.rect[0])) {
      const prior = components.at(-1)
      if (prior && i.rect[0] - box(prior)[2] < h * 0.1) prior.push(i)
      else components.push([i])
    }
    if (
      components.length !== heads.length ||
      components.some((g) => heads.filter((i) => g.includes(i)).length !== 1)
    )
      return fail('no-bijective-header-and-full-source-font-islands')
    const rough = [
      frame[0],
      ...components.slice(1).map((g, k) => (box(components[k])[2] + box(g)[0]) / 2),
      frame[2]
    ]
    if (rough.some((x, k) => k && x <= rough[k - 1])) return fail('non-increasing-header-cuts')
    const lane = (i) => {
      const all = rough
        .slice(1)
        .flatMap((right, k) =>
          i.rect[0] >= rough[k] - 0.02 && i.rect[2] <= right + 0.02 ? [k] : []
        )
      return all.length === 1 ? all[0] : undefined
    }
    const ordinary = body.filter(normal),
      bands = []
    for (const i of [...ordinary].sort(
      (a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0]
    )) {
      const b = bands.find((b) => Math.abs(b.baseline - i.baseline) < h * 0.01)
      if (b) b.items.push(i)
      else bands.push({ baseline: i.baseline, items: [i] })
    }
    // Ordinary first-leaf labels may be vertically centered. Independent record
    // anchors are complete fields in every other source face, never name semantics.
    const records = bands.filter((b) =>
      rough.slice(2).every((_x, k) => b.items.some((i) => lane(i) === k + 1))
    )
    if (records.length < 3 || records.length > 64)
      return fail('missing-complete-independent-records')
    const fields = records.map(() => heads.map(() => [])),
      stubSpans = []
    const internal = full.filter(
      (r) =>
        r[0] > frame[0] &&
        r[2] < frame[2] &&
        r[0] - frame[0] < h * 0.6 &&
        frame[2] - r[2] < h * 0.6 &&
        r[1] > f.divider[1] &&
        r[1] < f.closing[1]
    )
    if (internal.some((r) => body.some((i) => i.rect[1] < r[1] && i.rect[3] > r[1]))) return
    const fences = [f.divider[1], ...internal.map((r) => r[1]), f.closing[1]].sort((a, b) => a - b)
    for (const i of body) {
      const owner = parents.get(i) ?? i,
        column = lane(i)
      if (column === undefined) return fail('full-font-crosses-header-leaf-cut')
      const candidates = records.filter((r) => Math.abs(r.baseline - owner.baseline) < h * 0.01)
      if (column === 0 && internal.length) {
        const groups = fences
          .slice(1)
          .flatMap((bottom, k) => (i.rect[1] > fences[k] && i.rect[3] < bottom ? [k] : []))
        if (groups.length !== 1) return fail('stub-has-no-unique-native-fenced-group')
        const k = groups[0],
          group = records.filter((r) => r.baseline > fences[k] && r.baseline < fences[k + 1])
        if (!group.length || group.some((r) => fields[records.indexOf(r)][0].length))
          return fail('competing-native-fenced-stub')
        fields[records.indexOf(group[0])][0].push(i)
        stubSpans.push({ row: records.indexOf(group[0]) + 1, rowSpan: group.length, source: i })
      } else {
        if (candidates.length !== 1) return
        fields[records.indexOf(candidates[0])][column].push(i)
      }
    }
    if (fields.some((r) => r.slice(1).some((g) => !g.length))) return fail('missing-record-field')
    const allFields = [headfields, ...fields],
      gutters = []
    const projected = allFields.flat(2)
    if (projected.length !== new Set(projected).size) return
    for (const original of intersect) {
      const owners = projected.filter((i) => i === original || i.sourceToken === original)
      if (owners.length === 1 && owners[0] === original) continue
      if (
        owners.length < 2 ||
        owners.some((i) => !i.nativeLaneSplit || i.sourceToken !== original) ||
        owners
          .map((i) => i.text)
          .join('')
          .replace(/\s/gu, '') !== original.text.replace(/\s/gu, '')
      )
        return
    }
    for (let k = 1; k < heads.length; k++) {
      const left = Math.max(...allFields.flatMap((r) => r[k - 1]).map((i) => i.rect[2])),
        right = Math.min(...allFields.flatMap((r) => r[k]).map((i) => i.rect[0]))
      if (right - left < h * 0.1) return fail('no-complete-source-font-gutter')
      gutters.push([left, right])
    }
    const cuts = [frame[0], ...gutters.map((g) => (g[0] + g[1]) / 2), frame[2]]
    if (
      allFields.some((r) =>
        r.some((g, k) =>
          g.some((i) => i.rect[0] < cuts[k] - 0.02 || i.rect[2] > cuts[k + 1] + 0.02)
        )
      )
    )
      return fail('full-font-crosses-final-source-cut')
    used.push(...intersect, subtitle[0])
    panels.push({
      frame,
      opening: f.opening,
      divider: f.divider,
      closing: f.closing,
      subtitle: subtitle[0],
      header: headfields,
      records: fields,
      recordBaselines: records.map((r) => r.baseline),
      cuts,
      gutters,
      scriptParents: [...parents].map(([child, parent]) => ({ child, parent })),
      internalRules: internal,
      stubSpans
    })
  }
  const targetItems = items.filter(
    (i) =>
      i.text?.trim() &&
      overlap(i.rect, [
        crop[0],
        Math.min(...panels.map((p) => p.subtitle.rect[1])) - 1,
        crop[2],
        crop[3]
      ])
  )
  if (targetItems.some((i) => !used.includes(i)) || used.length !== new Set(used).size)
    return fail('foreign-unowned-font-in-composite-crop')
  return {
    qualified: true,
    h,
    panels,
    sourceItems: used,
    cropRect: [
      crop[0],
      Math.min(crop[1], ...panels.map((p) => p.subtitle.rect[1] - 1)),
      crop[2],
      crop[3]
    ],
    leftUnfencedStubPolicy: 'preserve-printed-singleton-and-true-empty-faces'
  }
}

// Only independently captioned native frames can separate an already owned
// detector grid. Whole source/rich donors are preserved, and each body is
// proved without borrowing record identity from its neighbouring table.
export function proveNativeIndependentCaptionedTableOwners(
  table,
  items,
  captions,
  rules,
  runs = [],
  rulePaintBounds,
  sourceGraphics
) {
  const valid = (r) =>
    Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3]
  const sameRect = (a, b) => valid(a) && valid(b) && a.every((v, n) => Math.abs(v - b[n]) < 0.02)
  const sameFont = (a, b) =>
    a.text === b.text &&
    a.baseline === b.baseline &&
    a.height === b.height &&
    sameRect(a.rect, b.rect)
  const contains = (a, b) => b.every((v, n) => (n < 2 ? v >= a[n] : v <= a[n]))
  const intersects = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
  const fontBox = (source) => [
    Math.min(...source.map((i) => i.rect[0])),
    Math.min(...source.map((i) => i.rect[1])),
    Math.max(...source.map((i) => i.rect[2])),
    Math.max(...source.map((i) => i.rect[3]))
  ]
  const bands = (source) => {
    const groups = []
    for (const i of [...source].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
      const g = groups.find((g) => Math.abs(g[0].baseline - i.baseline) < 0.02)
      if (g) g.push(i)
      else groups.push([i])
    }
    return groups.map((g) => g.sort((a, b) => a.rect[0] - b.rect[0]))
  }

  const refuse = () => undefined
  if (
    !table ||
    typeof table !== 'object' ||
    !Array.isArray(items) ||
    !Array.isArray(captions) ||
    !Array.isArray(rules) ||
    !Array.isArray(runs)
  )
    return
  if (
    typeof table.id !== 'string' ||
    !table.id ||
    !Number.isInteger(table.page) ||
    table.page < 1 ||
    table.parts != null
  )
    return
  if (
    items.some((i) => !i || typeof i.text !== 'string') ||
    captions.some(
      (c) =>
        !c ||
        !Array.isArray(c.lines) ||
        c.lines.some((s) => typeof s !== 'string') ||
        !valid(c.rect)
    ) ||
    runs.some((r) => !r || typeof r.text !== 'string' || !valid(r.rect))
  )
    return
  if (table.captionIssue != null && table.captionIssue !== 'ambiguous-table-caption') return
  if (
    ['notes', 'unassigned', 'clipped', 'issues'].some(
      (k) => table[k] != null && !Array.isArray(table[k])
    ) ||
    (table.readingRotation != null && table.readingRotation !== 0)
  )
    return
  if (
    !valid(table?.cropRect) ||
    !Array.isArray(table.cells) ||
    !Array.isArray(table.grid) ||
    !table.grid.length ||
    !Array.isArray(table.grid[0]) ||
    !table.grid[0].length ||
    table.grid.some((row) => !Array.isArray(row) || row.length !== table.grid[0].length) ||
    table.cells.length !== table.grid.length * table.grid[0].length ||
    table.parts ||
    table.readingRotation ||
    table.unassigned?.length ||
    table.clipped?.length ||
    table.issues?.length ||
    table.notes?.length
  )
    return refuse()
  if (!(rulePaintBounds instanceof Map)) return refuse()
  if (
    !Array.isArray(sourceGraphics) ||
    !sourceGraphics.length ||
    sourceGraphics.some((g) => !g || !valid(g.rect) || !['path', 'image'].includes(g.kind))
  )
    return refuse()
  const viewport = table.sourceViewport
  if (
    !viewport ||
    !Number.isInteger(viewport.width) ||
    !(viewport.width > 0) ||
    !Number.isInteger(viewport.height) ||
    !(viewport.height > 0)
  )
    return refuse()
  if (
    rules.some(
      (r) =>
        !Array.isArray(r) ||
        r.length !== 4 ||
        !r.every(Number.isFinite) ||
        r[0] > r[2] ||
        r[1] > r[3]
    )
  )
    return refuse()
  const meaningful = items.filter((i) => typeof i.text === 'string' && i.text.trim())
  if (
    meaningful.some(
      (i) =>
        !valid(i.rect) ||
        !Number.isFinite(i.baseline) ||
        !Number.isFinite(i.height) ||
        !(i.height > 0)
    )
  )
    return refuse()
  const old = table.cells
  if (
    old.some(
      (c) =>
        !c ||
        typeof c !== 'object' ||
        !Array.isArray(c.sourceTokens) ||
        !Array.isArray(c.sourceRects) ||
        (c.textRuns != null &&
          (!Array.isArray(c.textRuns) ||
            c.textRuns.some(
              (r) =>
                !r ||
                typeof r.text !== 'string' ||
                !['normal', 'superscript', 'subscript'].includes(r.position)
            )))
    )
  )
    return
  if (
    old.some(
      (c) =>
        !c ||
        typeof c.text !== 'string' ||
        !Number.isInteger(c.row) ||
        !Number.isInteger(c.column) ||
        c.row < 0 ||
        c.column < 0 ||
        c.row >= table.grid.length ||
        c.column >= table.grid[c.row]?.length ||
        c.rowSpan !== 1 ||
        c.colSpan !== 1 ||
        !valid(c.rect) ||
        !Array.isArray(c.sourceTokens) ||
        !Array.isArray(c.sourceRects) ||
        c.sourceTokens.length !== c.sourceRects.length ||
        table.grid[c.row][c.column] !== c.text ||
        c.sourceTokens.some(
          (t) =>
            !t ||
            typeof t.text !== 'string' ||
            !Number.isFinite(t.baseline) ||
            !Number.isFinite(t.height) ||
            !(t.height > 0) ||
            !valid(t.rect) ||
            c.sourceRects.filter((r) => sameRect(r, t.rect)).length !== 1
        ) ||
        c.sourceRects.some(
          (r) => !valid(r) || c.sourceTokens.filter((t) => sameRect(t.rect, r)).length !== 1
        )
    )
  )
    return refuse()
  const oldFonts = old.flatMap((c) => c.sourceTokens)
  if (
    new Set(old.map((c) => `${c.row},${c.column}`)).size !== old.length ||
    new Set(oldFonts.map((i) => JSON.stringify([i.text, i.rect, i.baseline, i.height]))).size !==
      oldFonts.length
  )
    return refuse()
  const horizontal = joinHorizontalTableRules(rules, 0.01, 0),
    candidates = []
  for (const caption of captions.filter(
    (c) => captionKind(c.lines?.[0]) === 'table' && valid(c.rect)
  )) {
    if (table.page != null && caption.page !== table.page) continue
    const edges = horizontal
      .filter(
        (r) =>
          Math.abs(r[0] - caption.rect[0]) < 0.02 &&
          Math.abs(r[2] - caption.rect[2]) < 0.02 &&
          r[1] > caption.rect[3] &&
          r[1] < table.cropRect[3]
      )
      .sort((a, b) => a[1] - b[1])
    if (edges.length !== 3) continue
    const [opening, , closing] = edges,
      frame = [opening[0], opening[1], opening[2], closing[1]]
    if (
      frame[2] <= table.cropRect[0] ||
      frame[0] >= table.cropRect[2] ||
      opening[1] - caption.rect[3] >= Math.min(...oldFonts.map((i) => i.height))
    )
      continue
    const captionFonts = meaningful.filter((i) => intersects(i.rect, caption.rect)),
      captionBands = bands(captionFonts)
    if (
      captionFonts.some(
        (i) =>
          !i.horizontal ||
          i.rect.some((v, axis) =>
            axis < 2 ? v < caption.rect[axis] - 0.02 : v > caption.rect[axis] + 0.02
          )
      ) ||
      captionBands.length !== caption.lines.length ||
      captionBands.some(
        (g, n) =>
          g
            .map((i) => i.text)
            .join('')
            .replace(/\s/gu, '') !== caption.lines[n].replace(/\s/gu, '')
      )
    )
      return refuse()
    const source = meaningful.filter((i) => intersects(i.rect, frame))
    if (
      !source.length ||
      source.some(
        (i) =>
          !i.horizontal ||
          !contains(frame, i.rect) ||
          edges.some((e) => i.rect[1] < e[1] && i.rect[3] > e[1])
      )
    )
      return refuse()
    const strokePieces = rules.filter(
      (r) =>
        r[1] === r[3] &&
        edges.some(
          (e) => Math.abs(e[1] - r[1]) < 0.01 && r[0] >= e[0] - 0.02 && r[2] <= e[2] + 0.02
        )
    )
    const paint = strokePieces.map((r) => rulePaintBounds.get(r.join(',')))
    if (paint.some((r) => !valid(r)) || strokePieces.length < edges.length) return refuse()
    const cropRect = fontBox([...paint.map((rect) => ({ rect })), ...source])
    if (intersects(cropRect, caption.rect)) return refuse()
    if (
      rules.some(
        (r) =>
          r[0] === r[2] && r[0] > frame[0] && r[0] < frame[2] && r[1] < frame[3] && r[3] > frame[1]
      )
    )
      return refuse()
    if (
      horizontal.some(
        (r) =>
          r[1] > frame[1] &&
          r[1] < frame[3] &&
          r[0] < frame[2] &&
          r[2] > frame[0] &&
          !edges.includes(r)
      )
    )
      return refuse()
    candidates.push({ caption, captionFonts, edges, frame, source, cropRect })
  }
  if (candidates.length !== 2) return refuse()
  candidates.sort((a, b) => a.frame[0] - b.frame[0])
  if (
    candidates[0].cropRect[2] >= candidates[1].cropRect[0] ||
    candidates[0].caption.page !== candidates[1].caption.page ||
    captions.some(
      (c) =>
        !candidates.some((p) => p.caption === c) &&
        valid(c.rect) &&
        candidates.some((p) => intersects(c.rect, p.cropRect))
    )
  )
    return refuse()
  const all = candidates.flatMap((p) => p.source),
    scope = [
      Math.min(table.cropRect[0], candidates[0].cropRect[0]),
      Math.min(table.cropRect[1], ...candidates.map((p) => p.cropRect[1])),
      Math.max(table.cropRect[2], candidates[1].cropRect[2]),
      Math.max(table.cropRect[3], ...candidates.map((p) => p.cropRect[3]))
    ]
  if (
    meaningful.some(
      (i) =>
        intersects(i.rect, scope) &&
        !all.includes(i) &&
        !candidates.some((p) => contains(p.caption.rect, i.rect))
    )
  )
    return refuse()
  if (
    oldFonts.length !== all.length ||
    all.some((i) => oldFonts.filter((t) => sameFont(i, t)).length !== 1) ||
    oldFonts.some((t) => all.filter((i) => sameFont(i, t)).length !== 1)
  )
    return refuse()
  for (const item of [...all, ...candidates.flatMap((p) => p.captionFonts)]) {
    const matching = runs.filter((r) => r.text === item.text && sameRect(r.rect, item.rect))
    if (matching.length !== 1) return refuse()
    const run = matching[0]
    if (
      run.baseline !== item.baseline ||
      run.height !== item.height ||
      !Array.isArray(run.glyphRuns) ||
      !run.glyphRuns.length ||
      run.glyphRuns.some((program) => !Number.isInteger(program) || program < 0) ||
      new Set(run.glyphRuns).size !== 1 ||
      !Array.isArray(run.literalGlyphs) ||
      !run.literalGlyphs.length ||
      run.literalGlyphs.some((glyph) => typeof glyph !== 'string' || !glyph) ||
      run.literalGlyphs.join('') !== item.text.replace(/\s/gu, '') ||
      run.glyphRuns.length !== [...run.literalGlyphs.join('')].length
    )
      return refuse()
  }
  // The recorded graphics carrier uses PDF.js BBoxReader's floor/ceil+1
  // quantization. It is not the painted edge. Require every carrier around
  // either full frame to match exactly one observed painted rule, so a native
  // image or icon in an otherwise empty predicted row cannot disappear.
  // This proof admits only integer viewports, where the renderer's ceil-sized
  // canvas exactly equals the source viewport used by the normalized carrier.
  const sameCarrier = (a, b) =>
    a.every(
      (value, axis) =>
        Math.abs(value - b[axis]) <=
        Number.EPSILON * Math.max(1, Math.abs(value), Math.abs(b[axis])) * 8
    )
  const carriers = candidates.flatMap((p) =>
    p.edges.map((edge) => {
      const paint = rulePaintBounds.get(edge.join(','))
      if (!valid(paint)) return undefined
      return paint.map((value, axis) => {
        const unit = (axis % 2 ? viewport.height : viewport.width) / 256
        return (axis < 2 ? Math.floor(value / unit) : Math.ceil(value / unit) + 1) * unit
      })
    })
  )
  if (carriers.some((r) => !valid(r))) return refuse()
  const paintedGraphics = sourceGraphics.filter((g) => intersects(g.rect, scope))
  if (
    paintedGraphics.length !== carriers.length ||
    paintedGraphics.some(
      (g) => g.kind !== 'path' || carriers.filter((r) => sameCarrier(g.rect, r)).length !== 1
    ) ||
    carriers.some((r) => paintedGraphics.filter((g) => sameCarrier(g.rect, r)).length !== 1)
  )
    return refuse()
  const kept = new Set(),
    panels = []
  for (const panel of candidates) {
    const [opening, divider, closing] = panel.edges,
      header = panel.source.filter((i) => i.rect[3] < divider[1]),
      body = panel.source.filter((i) => i.rect[1] > divider[1]),
      records = bands(body)
    if (
      header.length + body.length !== panel.source.length ||
      records.length < 3 ||
      !records[0]?.length ||
      records[0].length < 3
    )
      return refuse()
    const count = records[0].length,
      h = body[0]?.height
    const ordinaryHeader = header.filter((i) => i.height >= h * 0.8)
    if (!ordinaryHeader.length || bands(ordinaryHeader).length !== 1) return refuse()
    if (
      records.some(
        (g) =>
          g.length !== count ||
          g.some((i) => i.height !== h || Math.abs(i.rect[3] - i.baseline) > 0.02)
      ) ||
      records.some(
        (g, r) =>
          r &&
          Math.max(...records[r - 1].map((i) => i.rect[3])) >= Math.min(...g.map((i) => i.rect[1]))
      )
    )
      return refuse()
    const bodyGutters = records[0]
      .slice(1)
      .map((_, column) => [
        Math.max(...records.map((g) => g[column].rect[2])),
        Math.min(...records.map((g) => g[column + 1].rect[0]))
      ])
    if (bodyGutters.some(([a, b]) => a >= b)) return refuse()
    const bodyCuts = [opening[0], ...bodyGutters.map(([a, b]) => (a + b) / 2), opening[2]],
      headFields = bodyCuts
        .slice(1)
        .map((right, column) =>
          header.filter((i) => i.rect[0] >= bodyCuts[column] && i.rect[2] <= right)
        )
    if (headFields.some((g) => !g.length) || headFields.flat().length !== header.length)
      return refuse()
    const fields = [headFields, ...records.map((g) => g.map((i) => [i]))],
      nativeGutters = bodyGutters.map(([a, b], column) => [
        Math.max(a, ...headFields[column].map((i) => i.rect[2])),
        Math.min(b, ...headFields[column + 1].map((i) => i.rect[0]))
      ])
    if (nativeGutters.some(([a, b]) => a >= b)) return refuse()
    const cuts = [opening[0], ...nativeGutters.map(([a, b]) => (a + b) / 2), opening[2]],
      ys = [
        opening[1],
        divider[1],
        ...records
          .slice(1)
          .map(
            (g, n) =>
              (Math.max(...records[n].map((i) => i.rect[3])) +
                Math.min(...g.map((i) => i.rect[1]))) /
              2
          ),
        closing[1]
      ],
      cells = [],
      grid = []
    for (const [row, leaves] of fields.entries()) {
      grid.push([])
      for (const [column, fonts] of leaves.entries()) {
        const owners = old.filter(
          (c) =>
            c.sourceTokens.length === fonts.length &&
            c.sourceTokens.every((t) => fonts.filter((i) => sameFont(i, t)).length === 1) &&
            fonts.every((i) => c.sourceTokens.filter((t) => sameFont(i, t)).length === 1)
        )
        if (owners.length !== 1 || kept.has(owners[0])) return refuse()
        const donor = owners[0],
          ordered = [...fonts].sort((a, b) => a.rect[0] - b.rect[0]),
          small = ordered.filter((i) => i.height < h * 0.8)
        if (
          donor.text.replace(/\s/gu, '') !==
            ordered
              .map((i) => i.text)
              .join('')
              .replace(/\s/gu, '') ||
          (donor.textRuns && donor.textRuns.map((r) => r.text).join('') !== donor.text)
        )
          return refuse()
        for (const child of small) {
          const parents = fonts.filter(
            (i) => i.height >= h * 0.8 && isAdjacentTableScript(child, i)
          )
          const rich = donor.textRuns?.filter(
            (r) =>
              r.text === child.text &&
              r.position === (child.baseline > parents[0]?.baseline ? 'subscript' : 'superscript')
          )
          if (parents.length !== 1 || rich?.length !== 1) return refuse()
        }
        if (!small.length && donor.textRuns?.some((r) => r.position !== 'normal')) return refuse()
        const rect = [cuts[column], ys[row], cuts[column + 1], ys[row + 1]]
        if (fonts.some((i) => !contains(rect, i.rect))) return refuse()
        kept.add(donor)
        cells.push({ ...donor, row, column, rect })
        grid[row].push(donor.text)
      }
    }
    const rows = ys.slice(1).map((bottom, n) => ({
      rect: [cuts[0], ys[n], cuts.at(-1), bottom],
      origin: 'source-native-record'
    }))
    panels.push({
      ...panel,
      cuts,
      ys,
      nativeGutters,
      fields,
      cells,
      grid,
      rows
    })
  }
  const dropped = old.filter((c) => !kept.has(c))
  if (
    !dropped.length ||
    dropped.some(
      (c) => c.text !== '' || c.sourceTokens.length || c.sourceRects.length || c.textRuns?.length
    )
  )
    return refuse()
  // The empty predicted band's coarse rectangle overlaps the following
  // correctly owned font. It is not a native ownership fence. Remove only
  // complete empty model rows, after every independent source record and
  // every full original owner has already been proved above.
  const droppedRows = new Set(dropped.map((c) => c.row))
  if (
    [...droppedRows].some(
      (row) => row === 0 || old.filter((c) => c.row === row).some((c) => !dropped.includes(c))
    )
  )
    return refuse()
  return {
    qualified: true,
    panels,
    all,
    keptCells: [...kept],
    droppedEmptyCells: dropped,
    existingSourceObjectsPreserved: true
  }
}

const fencedGroupValidRect = (r) =>
  Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1]
const fencedGroupExactRect = (a, b) =>
  Array.isArray(a) &&
  Array.isArray(b) &&
  a.length === 4 &&
  b.length === 4 &&
  a.every((v, k) => v === b[k])
const fencedGroupSameFont = (a, b) =>
  a.text === b.text &&
  a.height === b.height &&
  a.baseline === b.baseline &&
  fencedGroupExactRect(a.rect, b.rect)
const fencedGroupIntersects = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
const fencedGroupContains = (a, b) => a.every((v, k) => (k < 2 ? v >= b[k] : v <= b[k]))
const fencedGroupCharacters = (t) => t.replace(/\s/g, '')
const fencedGroupFiniteFont = (i) =>
  i &&
  typeof i.text === 'string' &&
  fencedGroupValidRect(i.rect) &&
  Number.isFinite(i.baseline) &&
  Number.isFinite(i.height) &&
  i.height > 0
const fencedGroupMachineRect = (a, b) =>
  a.every(
    (v, k) => Math.abs(v - b[k]) <= Number.EPSILON * Math.max(1, Math.abs(v), Math.abs(b[k])) * 16
  )

function proveNativeExistingFencedGroupOwners(input) {
  const reject = (reason) => ({ qualified: false, reason })
  if (!input || typeof input !== 'object' || Array.isArray(input)) return reject('input-shape')
  const {
    table,
    items,
    captions,
    rules,
    runs,
    paint,
    graphics,
    viewport,
    stubColumn,
    invalidGraphicsBounds = 0
  } = input
  if (
    !table ||
    !Array.isArray(table.cells) ||
    !Array.isArray(table.grid) ||
    !fencedGroupValidRect(table.cropRect) ||
    (Object.hasOwn(table, 'readingRotation') && table.readingRotation !== 0) ||
    ['parts', 'notes', 'unassigned', 'issues', 'clipped'].some(
      (key) => Object.hasOwn(table, key) && (!Array.isArray(table[key]) || table[key].length)
    ) ||
    invalidGraphicsBounds
  )
    return reject('table-opaque-or-shape')
  if (
    !Array.isArray(items) ||
    items.some((i) => !fencedGroupFiniteFont(i)) ||
    !Array.isArray(captions) ||
    captions.some(
      (c) =>
        !c ||
        !fencedGroupValidRect(c.rect) ||
        !Array.isArray(c.lines) ||
        !c.lines.length ||
        c.lines.some((line) => typeof line !== 'string')
    ) ||
    !Array.isArray(rules) ||
    rules.some((r) => !Array.isArray(r) || r.length !== 4 || r.some((v) => !Number.isFinite(v))) ||
    !Array.isArray(runs) ||
    !(paint instanceof Map) ||
    !Array.isArray(graphics) ||
    !viewport ||
    ![viewport.width, viewport.height].every((v) => Number.isInteger(v) && v > 0)
  )
    return reject('complete-source-containers')
  const rows = table.grid.length,
    columns = table.grid[0]?.length
  if (
    !(rows > 3 && columns > 2) ||
    !Number.isInteger(stubColumn) ||
    stubColumn < 0 ||
    stubColumn >= columns ||
    table.grid.some(
      (r) => !Array.isArray(r) || r.length !== columns || r.some((text) => typeof text !== 'string')
    )
  )
    return reject('grid-or-stub')
  const slots = new Set(),
    cells = table.cells
  for (const c of cells) {
    if (
      !c ||
      !Number.isInteger(c.row) ||
      c.row < 0 ||
      c.row >= rows ||
      !Number.isInteger(c.column) ||
      c.column < 0 ||
      c.column >= columns ||
      c.colSpan !== 1 ||
      !Number.isInteger(c.rowSpan) ||
      c.rowSpan < 1 ||
      c.row + c.rowSpan > rows ||
      c.section ||
      !fencedGroupValidRect(c.rect) ||
      typeof c.text !== 'string' ||
      table.grid[c.row][c.column] !== c.text ||
      !Array.isArray(c.sourceTokens) ||
      !Array.isArray(c.sourceRects) ||
      c.sourceTokens.length !== c.sourceRects.length ||
      c.sourceTokens.some((t) => !fencedGroupFiniteFont(t)) ||
      c.sourceRects.some((r) => !fencedGroupValidRect(r)) ||
      c.sourceTokens.some(
        (t) => c.sourceRects.filter((r) => fencedGroupExactRect(r, t.rect)).length !== 1
      ) ||
      c.sourceRects.some(
        (r) => c.sourceTokens.filter((t) => fencedGroupExactRect(r, t.rect)).length !== 1
      ) ||
      (Object.hasOwn(c, 'textRuns') &&
        (!Array.isArray(c.textRuns) ||
          c.textRuns.some(
            (r) =>
              !r ||
              typeof r.text !== 'string' ||
              !['normal', 'subscript', 'superscript'].includes(r.position)
          ) ||
          c.textRuns.map((r) => r.text).join('') !== c.text))
    )
      return reject('old-cell-whole-owner')
    if (c.column !== stubColumn && c.rowSpan !== 1) return reject('non-stub-span')
    for (let row = c.row; row < c.row + c.rowSpan; row++) {
      const key = `${row}:${c.column}`
      if (slots.has(key)) return reject('duplicate-old-slot')
      slots.add(key)
    }
  }
  if (slots.size !== rows * columns) return reject('missing-old-slot')
  const crop = table.cropRect,
    horizontal = joinHorizontalTableRules(rules, 0.01, 0)
  const fences = horizontal
    .filter(
      (r) =>
        r[1] >= crop[1] &&
        r[1] <= crop[3] &&
        r[0] >= crop[0] &&
        r[2] <= crop[2] &&
        r[2] - r[0] >= crop[2] - crop[0] - 4.02
    )
    .sort((a, b) => a[1] - b[1])
  if (
    fences.length < 4 ||
    fences.some(
      (r) => Math.abs(r[0] - fences[0][0]) > 0.02 || Math.abs(r[2] - fences[0][2]) > 0.02
    ) ||
    fences.some((r, n) => n && r[1] <= fences[n - 1][1])
  )
    return reject('complete-fences')
  const opening = fences[0],
    divider = fences[1],
    closing = fences.at(-1),
    frame = [opening[0], opening[1], opening[2], closing[1]],
    source = items.filter((i) => i.text.trim() && fencedGroupIntersects(i.rect, frame))
  if (
    !source.length ||
    source.some(
      (i) =>
        !i.horizontal ||
        !fencedGroupContains(i.rect, frame) ||
        !fencedGroupContains(i.rect, crop) ||
        fences.some((r) => i.rect[1] < r[1] && i.rect[3] > r[1])
    )
  )
    return reject('whole-font-frame')
  const titles = captions.filter(
    (c) =>
      c &&
      fencedGroupValidRect(c.rect) &&
      Array.isArray(c.lines) &&
      /^Table\s+\S+/i.test(c.lines[0] ?? '') &&
      c.rect[0] < frame[2] &&
      c.rect[2] > frame[0] &&
      c.rect[3] < frame[1]
  )
  if (
    titles.length !== 1 ||
    titles[0].page !== input.page ||
    frame[1] - titles[0].rect[3] > Math.max(...source.map((i) => i.height)) * 8
  )
    return reject('unique-local-caption')
  const seen = new Set(),
    owned = new Map()
  for (const c of cells) {
    const own = []
    for (const t of c.sourceTokens) {
      const match = source.filter((i) => fencedGroupSameFont(i, t))
      if (match.length !== 1 || seen.has(match[0])) return reject('source-owner-bijection')
      seen.add(match[0])
      own.push(match[0])
    }
    if (fencedGroupCharacters(own.map((i) => i.text).join('')) !== fencedGroupCharacters(c.text))
      return reject('complete-literal')
    owned.set(c, own)
  }
  if (seen.size !== source.length) return reject('unowned-frame-font')
  for (const i of source) {
    const match = runs.filter((r) => r && r.text === i.text && fencedGroupExactRect(r.rect, i.rect))
    if (match.length !== 1) return reject('unique-observed-program')
    const r = match[0]
    if (
      r.height !== i.height ||
      r.baseline !== i.baseline ||
      !Array.isArray(r.literalGlyphs) ||
      r.literalGlyphs.some((g) => typeof g !== 'string' || !g) ||
      fencedGroupCharacters(r.literalGlyphs.join('')) !== fencedGroupCharacters(i.text) ||
      !Array.isArray(r.glyphRuns) ||
      r.glyphRuns.length !== [...r.literalGlyphs.join('')].length ||
      !r.glyphRuns.length ||
      r.glyphRuns.some((n) => !Number.isInteger(n) || n < 0) ||
      new Set(r.glyphRuns).size !== 1 ||
      !Array.isArray(r.gaps) ||
      r.gaps.some(
        (g, n) =>
          !g ||
          !Number.isInteger(g.index) ||
          g.index <= 0 ||
          g.index >= i.text.length ||
          !Number.isFinite(g.left) ||
          !Number.isFinite(g.right) ||
          g.left >= g.right ||
          g.left < i.rect[0] - 0.02 ||
          g.right > i.rect[2] + 0.02 ||
          (n && g.index <= r.gaps[n - 1].index)
      )
    )
      return reject('complete-observed-program')
  }
  const heads = cells.filter((c) => c.row === 0)
  if (
    heads.length !== columns ||
    heads.some(
      (c) =>
        c.rowSpan !== 1 || !owned.get(c).length || owned.get(c).some((i) => i.rect[3] >= divider[1])
    )
  )
    return reject('whole-independent-headers')
  const sourceColumns = Array.from({ length: columns }, (_, column) =>
    source.filter((i) => cells.some((c) => c.column === column && owned.get(c).includes(i)))
  )
  const domains = sourceColumns.map((col) => box(col)),
    gutters = domains.slice(1).map((d, n) => [domains[n][2], d[0]])
  if (gutters.some((g) => g[1] <= g[0])) return reject('full-font-leaf-gutters')
  for (const c of cells) {
    const font = owned.get(c)
    if (font.some((i) => i.rect[0] < c.rect[0] || i.rect[2] > c.rect[2]))
      return reject('font-in-existing-leaf')
  }
  const recordBands = []
  for (let row = 1; row < rows; row++) {
    const peers = cells.filter((c) => c.row === row && c.column !== stubColumn),
      fonts = peers.flatMap((c) => owned.get(c))
    if (
      peers.length !== columns - 1 ||
      peers.some((c) => !owned.get(c).length) ||
      fonts.some((i) => i.rect[1] <= divider[1])
    )
      return reject('complete-record-peers')
    const single = peers.filter((c) => owned.get(c).length === 1).map((c) => owned.get(c)[0])
    const clusters = []
    for (const i of single) {
      const group = clusters.find((g) => Math.abs(g[0].baseline - i.baseline) < 0.02)
      if (group) group.push(i)
      else clusters.push([i])
    }
    const common = clusters.filter((g) => g.length >= 2).sort((a, b) => b.length - a.length)
    if (!common.length || (common.length > 1 && common[0].length === common[1].length))
      return reject('unique-native-record-baseline')
    recordBands.push({ row, baseline: common[0][0].baseline, fonts, envelope: box(fonts) })
  }
  if (
    recordBands.some(
      (r, n) =>
        n &&
        (r.envelope[1] <= recordBands[n - 1].envelope[3] ||
          r.baseline <= recordBands[n - 1].baseline)
    )
  )
    return reject('native-record-corridors')
  const groups = fences.slice(2).map((f, n) => ({
    top: fences[n + 1][1],
    bottom: f[1],
    records: recordBands.filter((r) => r.envelope[1] > fences[n + 1][1] && r.envelope[3] < f[1])
  }))
  if (
    groups.some((g) => g.records.length < 2) ||
    groups.flatMap((g) => g.records).length !== recordBands.length
  )
    return reject('complete-fenced-records')
  const enclosedRules = rules.filter(
    (r) =>
      r.length === 4 &&
      r.every(Number.isFinite) &&
      ((r[0] === r[2] &&
        r[0] >= frame[0] &&
        r[0] <= frame[2] &&
        r[3] > frame[1] &&
        r[1] < frame[3]) ||
        (r[1] === r[3] &&
          r[0] < frame[2] &&
          r[2] > frame[0] &&
          r[1] >= frame[1] &&
          r[1] <= frame[3]))
  )
  const wallBindings = [],
    underlineBindings = []
  for (const r of enclosedRules) {
    const ink = paint.get(r.join(','))
    if (
      !fencedGroupValidRect(ink) ||
      !fencedGroupContains(ink, [0, 0, viewport.width, viewport.height])
    )
      return reject('complete-rule-paint')
    if (r[0] === r[2]) {
      const match = gutters
        .map((g, n) => ({ g, n }))
        .filter(({ g }) => ink[0] > g[0] && ink[2] < g[1])
      if (
        match.length !== 1 ||
        source.some((i) => fencedGroupIntersects(i.rect, ink)) ||
        r[1] < frame[1] ||
        r[3] > frame[3]
      )
        return reject('legal-full-font-wall')
      wallBindings.push({ rule: r, gutter: match[0].n })
    } else if (!fences.some((f) => fencedGroupExactRect(f, r))) {
      const match = source.filter(
        (i) =>
          Math.abs(i.rect[0] - r[0]) < 0.02 &&
          Math.abs(i.rect[2] - r[2]) < 0.02 &&
          r[1] >= i.baseline &&
          r[1] - i.baseline < i.height * 0.3
      )
      if (match.length !== 1) return reject('uniquely-owned-underline')
      underlineBindings.push({ rule: r, source: match[0] })
    }
  }
  const quantize = (p) =>
    p.map((v, k) => {
      const axis = k % 2 ? viewport.height : viewport.width
      return ((k < 2 ? Math.floor((v / axis) * 256) : Math.ceil((v / axis) * 256) + 1) * axis) / 256
    })
  const carriers = enclosedRules.map((r) => {
    const p = paint.get(r.join(',')),
      stroke = [...p]
    // Actual PDFjs getPathBoundingBox(STROKE) expands the whole path AABB,
    // even for a butt cap; this is a conservative renderer carrier, not ink.
    if (r[0] === r[2]) {
      const radius = (p[2] - p[0]) / 2
      stroke[1] -= radius
      stroke[3] += radius
    } else {
      const radius = (p[3] - p[1]) / 2
      stroke[0] -= radius
      stroke[2] += radius
    }
    return { rule: r, candidates: [quantize(p), quantize(stroke)] }
  })
  const nativeGraphics = graphics.filter(
    (g) => g && fencedGroupValidRect(g.rect) && fencedGroupIntersects(g.rect, frame)
  )
  if (
    graphics.some((g) => !g || !fencedGroupValidRect(g.rect)) ||
    nativeGraphics.some((g) => g.kind !== 'path') ||
    nativeGraphics.length !== carriers.length ||
    carriers.some(
      (c) =>
        nativeGraphics.filter((g) => c.candidates.some((r) => fencedGroupMachineRect(r, g.rect)))
          .length !== 1
    ) ||
    nativeGraphics.some(
      (g) =>
        carriers.filter((c) => c.candidates.some((r) => fencedGroupMachineRect(r, g.rect)))
          .length !== 1
    )
  )
    return reject('all-native-paint-carriers')
  let calibration = 0
  const replacements = [],
    labelGroups = []
  for (const g of groups) {
    const start = g.records[0].row,
      span = g.records.length,
      label = sourceColumns[stubColumn].filter((i) => i.rect[1] > g.top && i.rect[3] < g.bottom),
      donors = cells.filter(
        (c) => c.column === stubColumn && c.row >= start && c.row + c.rowSpan <= start + span
      )
    if (
      !label.length ||
      label.length > 3 ||
      label.some((i) => i.height !== label[0].height) ||
      donors.reduce((n, c) => n + c.rowSpan, 0) !== span ||
      donors.flatMap((c) => owned.get(c)).length !== label.length ||
      label.some((i) => donors.flatMap((c) => owned.get(c)).filter((j) => j === i).length !== 1)
    )
      return reject('complete-label-donors')
    const oldUnion = box(donors),
      labelBox = box(label)
    if (
      !fencedGroupContains(labelBox, oldUnion) ||
      label.some(
        (i) =>
          i.rect[0] <= domains[stubColumn][0] - 0.02 || i.rect[2] >= domains[stubColumn][2] + 0.02
      )
    )
      return reject('whole-label-donor-union')
    const complete = donors.length === 1 && donors[0].row === start && donors[0].rowSpan === span
    if (complete) calibration++
    else {
      const printed = donors.filter((c) => owned.get(c).length)
      if (
        !printed.length ||
        printed.some((c) =>
          c.textRuns?.some(
            (r) =>
              r.position !== 'normal' ||
              !fencedGroupOpaqueEqual(Object.keys(r).sort(), ['position', 'text'])
          )
        )
      )
        return reject('unsupported-label-rich')
      const mutable = ['row', 'rowSpan', 'rect', 'text', 'sourceTokens', 'sourceRects', 'textRuns'],
        opaque = (c) => Object.fromEntries(Object.entries(c).filter(([k]) => !mutable.includes(k)))
      if (
        donors.some((c) => {
          const value = opaque(c),
            expected = opaque(printed[0])
          // A proved zero-ink model-grid slot may be eliminated beside the
          // retained model-span owner. The printed origin is never rewritten.
          if (
            !owned.get(c).length &&
            c.text === '' &&
            c.origin === 'model-grid' &&
            printed[0].origin === 'model-span'
          )
            value.origin = expected.origin
          return !fencedGroupOpaqueEqual(value, expected)
        })
      )
        return reject('inconsistent-donor-opaque-fields')
      const tokens = donors
          .flatMap((c) => c.sourceTokens)
          .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0]),
        literal = tokens.map((i) => i.text).join(' ')
      replacements.push({
        row: start,
        column: stubColumn,
        rowSpan: span,
        rect: oldUnion,
        donors,
        text: literal,
        sourceTokens: tokens,
        sourceRects: tokens.map((t) => t.rect)
      })
    }
    labelGroups.push({
      top: g.top,
      bottom: g.bottom,
      rows: g.records.map((r) => r.row),
      label,
      oldDonors: donors,
      calibrated: complete
    })
  }
  if (!calibration) return reject('missing-source-complete-calibration')
  const correctGroups = labelGroups.filter((g) => g.calibrated),
    center = (i) => (i.rect[0] + i.rect[2]) / 2,
    headerCenter = center({ rect: box(owned.get(heads.find((c) => c.column === stubColumn))) })
  const lineSteps = (g) =>
    g.label
      .slice()
      .sort((a, b) => a.baseline - b.baseline)
      .slice(1)
      .map(
        (i, n) => i.baseline - g.label.slice().sort((a, b) => a.baseline - b.baseline)[n].baseline
      )
  const centerOffset = (g) => (box(g.label)[1] + box(g.label)[3] - g.top - g.bottom) / 2
  for (const g of labelGroups) {
    if (
      g.label.some((i) => Math.abs(center(i) - headerCenter) > 0.02) ||
      Math.max(...g.label.map(center)) - Math.min(...g.label.map(center)) > 0.02 ||
      !correctGroups.some(
        (c) => Math.abs(centerOffset(c) - centerOffset(g)) < g.label[0].height * 0.02
      )
    )
      return reject('source-calibrated-label-layout')
    const steps = lineSteps(g)
    if (
      steps.length &&
      (!correctGroups.some((c) => lineSteps(c).length) ||
        steps.some(
          (step) =>
            step <= 0 ||
            !correctGroups.some((c) => lineSteps(c).some((s) => Math.abs(s - step) < 0.02))
        ))
    )
      return reject('source-calibrated-multiline-paragraph')
  }
  if (!replacements.length) return reject('already-complete')
  return {
    qualified: true,
    replacements,
    calibration,
    source,
    heads,
    groups: labelGroups,
    recordBands,
    domains,
    gutters,
    wallBindings,
    underlineBindings,
    carriers,
    nativeGraphics,
    originalCropPaintExceptions: enclosedRules
      .filter((r) => !fencedGroupContains(paint.get(r.join(',')), crop))
      .map((r) => ({ rule: r, paint: paint.get(r.join(',')), crop }))
  }
}

function projectNativeExistingFencedGroupOwners(table, proof) {
  const out = structuredClone(table)
  const projections = new Map(),
    skip = new Set()
  for (const r of proof.replacements) {
    const indexes = r.donors.map((c) => table.cells.indexOf(c)),
      first = Math.min(...indexes),
      prototype = r.donors.find((c) => c.sourceTokens.length)
    const replacement = {
      ...structuredClone(prototype),
      row: r.row,
      column: r.column,
      rowSpan: r.rowSpan,
      rect: r.rect,
      text: r.text,
      sourceTokens: r.sourceTokens,
      sourceRects: r.sourceRects
    }
    if (prototype.textRuns) replacement.textRuns = [{ text: r.text, position: 'normal' }]
    projections.set(first, replacement)
    for (const index of indexes) skip.add(index)
    for (let row = r.row; row < r.row + r.rowSpan; row++)
      out.grid[row][r.column] = row === r.row ? r.text : ''
  }
  // Output contract preserves predecessor cell order at its first donor slot.
  out.cells = table.cells.flatMap((c, n) =>
    projections.has(n) ? [projections.get(n)] : skip.has(n) ? [] : [structuredClone(c)]
  )
  return out
}

// Complete original operators bind solid rule strokes and enclosed label fills.
// This finite family preserves all existing field owners and opaque diagnostics.

// The existing group and blank-domain proofs share the same original painted
// path closure. Callers establish their own font and ownership eligibility.
function proveNativeFencedPaintClosure(
  fences,
  frame,
  crop,
  groups,
  paint,
  graphics,
  operatorContext,
  operationGraphics
) {
  const fail = (reason) => ({ qualified: false, reason }),
    rect = fencedGroupValidRect,
    same = fencedGroupExactRect,
    contains = fencedGroupContains,
    intersects = fencedGroupIntersects,
    v = operatorContext.viewport,
    ops = operatorContext.operators
  // Operator paths are source evidence, not bounds inferred from the model.
  const paths = [],
    stack = []
  let transform = [1, 0, 0, 1, 0, 0],
    solid = false,
    alpha = 1,
    clip = false,
    width = 1,
    cap = 0,
    dash = [],
    dashPhase = 0,
    strokeColor = '#000000'
  const validDash = (value) =>
    Array.isArray(value) &&
    value.length === 2 &&
    Array.isArray(value[0]) &&
    Array.from(value[0]).every((n) => Number.isFinite(n) && n >= 0) &&
    Number.isFinite(value[1])
  for (let n = 0; n < ops.fnArray.length; n++) {
    const op = ops.fnArray[n],
      a = ops.argsArray[n]
    if (!Number.isInteger(op) || op < 0 || (a !== null && !Array.isArray(a)))
      return fail('operator-shape')
    if (op === fencedGroupOPS.save)
      stack.push({
        transform: [...transform],
        solid,
        alpha,
        clip,
        width,
        cap,
        dash: [...dash],
        dashPhase,
        strokeColor
      })
    else if (op === fencedGroupOPS.restore) {
      const x = stack.pop()
      if (!x) return fail('paint-state-underflow')
      ;({ transform, solid, alpha, clip, width, cap, dash, dashPhase, strokeColor } = x)
    } else if (op === fencedGroupOPS.setDash) {
      if (!validDash(a)) return fail('paint-dash-shape')
      ;[dash, dashPhase] = a
    } else if (op === fencedGroupOPS.transform) {
      if (!Array.isArray(a) || a.length !== 6 || a.some((x) => !Number.isFinite(x)))
        return fail('paint-transform')
      transform = fencedGroupUtil.transform(transform, a)
    } else if (op === fencedGroupOPS.setStrokeRGBColor) {
      if (
        !Array.isArray(a) ||
        a.length !== 1 ||
        typeof a[0] !== 'string' ||
        !/^#[0-9a-f]{6}$/i.test(a[0])
      )
        return fail('stroke-color-shape')
      strokeColor = a[0].toLowerCase()
    } else if (
      [
        fencedGroupOPS.setStrokeColorSpace,
        fencedGroupOPS.setStrokeColor,
        fencedGroupOPS.setStrokeColorN,
        fencedGroupOPS.setStrokeGray,
        fencedGroupOPS.setStrokeCMYKColor,
        fencedGroupOPS.setStrokeTransparent
      ].includes(op)
    )
      return fail('unsupported-stroke-color')
    else if (op === fencedGroupOPS.setFillRGBColor)
      solid =
        Array.isArray(a) &&
        a.length === 1 &&
        typeof a[0] === 'string' &&
        /^#[0-9a-f]{6}$/i.test(a[0])
    else if (
      [
        fencedGroupOPS.setFillColorN,
        fencedGroupOPS.setFillGray,
        fencedGroupOPS.setFillColor
      ].includes(op)
    )
      return fail('unsupported-fill-color')
    else if (op === fencedGroupOPS.setLineWidth) {
      if (!Array.isArray(a)) return fail('width-shape')
      width = a[0]
    } else if (op === fencedGroupOPS.setLineCap) {
      if (!Array.isArray(a)) return fail('cap-shape')
      cap = a[0]
    } else if (op === fencedGroupOPS.clip || op === fencedGroupOPS.eoClip) clip = true
    else if (op === fencedGroupOPS.setGState) {
      if (!Array.isArray(a?.[0])) return fail('paint-gstate')
      for (const e of a[0]) {
        if (!Array.isArray(e) || e.length !== 2) return fail('paint-gstate-entry')
        if (e[0] === 'ca') alpha = e[1]
        else if (e[0] === 'CA' && e[1] !== 1) return fail('stroke-alpha')
        else if (e[0] === 'BM' && e[1] !== 'Normal') return fail('blend')
        else if (e[0] === 'SMask' && e[1] !== 'None' && e[1] !== null) return fail('mask')
        else if (e[0] === 'LW') width = e[1]
        else if (e[0] === 'LC') cap = e[1]
        else if (e[0] === 'TR' && e[1] !== null) return fail('unsupported-transfer-map')
        else if (e[0] === 'D') {
          if (!validDash(e[1])) return fail('paint-dash-shape')
          ;[dash, dashPhase] = e[1]
        }
      }
    } else if (
      [
        fencedGroupOPS.paintImageXObject,
        fencedGroupOPS.paintInlineImageXObject,
        fencedGroupOPS.paintImageMaskXObject,
        fencedGroupOPS.paintFormXObjectBegin,
        fencedGroupOPS.shadingFill
      ].includes(op)
    )
      return fail('foreign-render-program')
    else if (op === fencedGroupOPS.constructPath) {
      if (
        clip ||
        alpha !== 1 ||
        !Array.isArray(a?.[1]) ||
        a[1].length !== 1 ||
        !(Array.isArray(a[1][0]) || a[1][0] instanceof Float32Array)
      )
        return fail('complete-paint-program')
      const p = a[1][0],
        fill = a[0] === fencedGroupOPS.fill,
        stroke = a[0] === fencedGroupOPS.stroke
      if (
        (!fill && !stroke) ||
        p.some((x) => !Number.isFinite(x)) ||
        (!fill && !(p.length === 6 && p[0] === 0 && p[3] === 1)) ||
        (fill &&
          !(
            solid &&
            p.length === 13 &&
            p[0] === 0 &&
            p[3] === 1 &&
            p[6] === 1 &&
            p[9] === 1 &&
            p[12] === 4
          ))
      )
        return fail('closed-native-paint-shape')
      const matrix = fencedGroupUtil.transform(v.transform, transform),
        points = []
      if (matrix[1] !== 0 || matrix[2] !== 0) return fail('axis-aligned-paint')
      for (let k = 0; k < (fill ? 12 : 6); k += 3) {
        const point = [p[k + 1], p[k + 2]]
        fencedGroupUtil.applyTransform(point, matrix)
        points.push(point)
      }
      const bounds = [
        Math.min(...points.map((p) => p[0])),
        Math.min(...points.map((p) => p[1])),
        Math.max(...points.map((p) => p[0])),
        Math.max(...points.map((p) => p[1]))
      ]
      if (
        fill &&
        (new Set(points.map((p) => p.join(','))).size !== 4 ||
          points.some((p, k) => p[0] !== points[(k + 1) % 4][0] && p[1] !== points[(k + 1) % 4][1]))
      )
        return fail('closed-native-rectangle')
      if (
        stroke &&
        (!Number.isFinite(width) ||
          width <= 0 ||
          cap !== 0 ||
          dash.length !== 0 ||
          strokeColor === '#ffffff' ||
          bounds[1] !== bounds[3])
      )
        return fail('solid-horizontal-stroke')
      paths.push({
        fill,
        bounds,
        matrix,
        width,
        ...(operationGraphics !== undefined ? { operationIndex: n } : {})
      })
    }
  }
  if (stack.length) return fail('unbalanced-paint-state')
  const strokes = paths.filter((p) => !p.fill),
    fills = paths.filter((p) => p.fill)
  if (
    strokes.length !== fences.length ||
    strokes.some((p) => fences.filter((f) => same(f, p.bounds)).length !== 1) ||
    fills.length !== groups.length
  )
    return fail('complete-paint-topology')
  for (const g of groups) {
    const matches = fills.filter(
      (p) =>
        p.bounds[0] === frame[0] &&
        p.bounds[2] < g.donor.rect[2] &&
        p.bounds[1] > g.top &&
        p.bounds[3] < g.bottom &&
        intersects(p.bounds, g.font.rect)
    )
    if (matches.length !== 1) return fail('unique-label-background')
    g.background = matches[0]
  }
  const quantize = (p) =>
    p.map(
      (x, k) =>
        ((k < 2
          ? Math.floor((x / Math.ceil(k % 2 ? v.height : v.width)) * 256)
          : Math.ceil((x / Math.ceil(k % 2 ? v.height : v.width)) * 256) + 1) *
          (k % 2 ? v.height : v.width)) /
        256
    )
  const carriers = []
  if (
    operationGraphics !== undefined &&
    (!Array.isArray(operationGraphics) ||
      operationGraphics.some((g) => !g || typeof g !== 'object' || !rect(g.rect)) ||
      operationGraphics.length !== graphics.length ||
      new Set(operationGraphics.map((g) => g.operationIndex)).size !== operationGraphics.length ||
      operationGraphics.some(
        (g, i) =>
          !Number.isInteger(g.operationIndex) ||
          g.operationIndex < 0 ||
          g.kind !== graphics[i].kind ||
          !same(g.rect, graphics[i].rect)
      ))
  )
    return fail('complete-operation-identity-inventory')
  for (const p of paths) {
    let ink = p.bounds,
      conservative = p.bounds
    if (!p.fill) {
      ink = paint.get(p.bounds.join(','))
      if (!rect(ink) || !contains(ink, crop)) return fail('complete-paint-map')
      const radius = (ink[3] - ink[1]) / 2
      conservative = [ink[0] - radius, ink[1], ink[2] + radius, ink[3]]
    }
    const carrier = quantize(conservative),
      matches = graphics.filter(
        (g, i) =>
          fencedGroupMachineRect(g.rect, carrier) &&
          (operationGraphics === undefined ||
            operationGraphics[i].operationIndex === p.operationIndex)
      )
    if (matches.length !== 1) return fail('exact-native-carrier')
    carriers.push(matches[0])
    if (p.fill) {
      const g = groups.find((g) => g.background === p)
      if (!g || !contains(g.font.rect, carrier)) return fail('whole-label-font-carrier')
    }
  }
  if (new Set(carriers).size !== graphics.length || carriers.length !== graphics.length)
    return fail('no-unowned-native-paint')
  return { qualified: true, carriers }
}

function proveNativeVariableFencedGroupOwners(
  table,
  items,
  captions,
  rules,
  runs,
  paint,
  graphics,
  operatorContext
) {
  const fail = (reason) => ({ qualified: false, reason })
  const rect = fencedGroupValidRect,
    same = fencedGroupExactRect,
    contains = fencedGroupContains,
    intersects = fencedGroupIntersects
  if (
    !table ||
    !operatorContext ||
    !Array.isArray(table.cells) ||
    !Array.isArray(table.grid) ||
    !rect(table.cropRect) ||
    !Number.isInteger(table.page) ||
    table.page < 1 ||
    (Object.hasOwn(table, 'readingRotation') && table.readingRotation !== 0)
  )
    return fail('table-shape')
  if (
    ['notes', 'parts', 'unassigned', 'clipped'].some(
      (k) => Object.hasOwn(table, k) && (!Array.isArray(table[k]) || table[k].length)
    )
  )
    return fail('unsupported-ownership')
  if (!Array.isArray(table.issues) || table.issues.some((i) => i !== 'conflicting-spanning-cells'))
    return fail('unrelated-diagnostic')
  const v = operatorContext.viewport,
    ops = operatorContext.operators
  if (
    !v ||
    !table.sourceViewport ||
    v.rotation !== 0 ||
    v.scale !== 1.5 ||
    v.width !== table.sourceViewport.width ||
    v.height !== table.sourceViewport.height ||
    v.scale !== table.sourceViewport.scale ||
    ![v.width, v.height].every((n) => Number.isFinite(n) && n > 0) ||
    !Array.isArray(v.transform) ||
    v.transform.length !== 6 ||
    v.transform.some((n, k) => n !== [1.5, 0, 0, -1.5, 0, v.height][k]) ||
    !Array.isArray(v.viewBox) ||
    v.viewBox.length !== 4 ||
    v.viewBox.some((n, k) => n !== [0, 0, v.width / 1.5, v.height / 1.5][k])
  )
    return fail('actual-native-viewport')
  if (
    !ops ||
    !Array.isArray(ops.fnArray) ||
    !Array.isArray(ops.argsArray) ||
    ops.fnArray.length !== ops.argsArray.length ||
    !Array.isArray(items) ||
    items.some((i) => !fencedGroupFiniteFont(i)) ||
    !Array.isArray(captions) ||
    !Array.isArray(rules) ||
    !Array.isArray(runs) ||
    !(paint instanceof Map) ||
    !Array.isArray(graphics) ||
    graphics.some((g) => !g || g.kind !== 'path' || !rect(g.rect))
  )
    return fail('complete-containers')
  const rows = table.grid.length,
    columns = table.grid[0]?.length,
    crop = table.cropRect
  if (
    !(rows > 3 && columns > 2) ||
    table.grid.some(
      (r) => !Array.isArray(r) || r.length !== columns || r.some((t) => typeof t !== 'string')
    )
  )
    return fail('grid-shape')
  const fences = rules
    .filter(
      (r) =>
        Array.isArray(r) &&
        r.length === 4 &&
        r.every(Number.isFinite) &&
        r[1] === r[3] &&
        r[1] > crop[1] &&
        r[1] < crop[3] &&
        r[0] > crop[0] &&
        r[2] < crop[2]
    )
    .sort((a, b) => a[1] - b[1])
  if (
    fences.length !== rules.length ||
    fences.length < 4 ||
    fences.some(
      (r, n) => r[0] !== fences[0][0] || r[2] !== fences[0][2] || (n && r[1] <= fences[n - 1][1])
    )
  )
    return fail('unique-full-fences')
  const frame = [fences[0][0], fences[0][1], fences[0][2], fences.at(-1)[1]],
    source = items.filter((i) => i.text.trim() && intersects(i.rect, frame))
  if (
    !source.length ||
    source.some(
      (i) =>
        !i.horizontal ||
        !contains(i.rect, frame) ||
        !contains(i.rect, crop) ||
        fences.some((r) => i.rect[1] < r[1] && i.rect[3] > r[1])
    )
  )
    return fail('whole-frame-fonts')
  const caption = table.caption,
    titles = captions.filter(
      (c) =>
        c &&
        c.page === table.page &&
        rect(c.rect) &&
        Array.isArray(c.lines) &&
        c.lines.length &&
        c.lines.every((l) => typeof l === 'string') &&
        /^Table\s+\S+/i.test(c.lines[0]) &&
        c.rect[0] < frame[2] &&
        c.rect[2] > frame[0] &&
        c.rect[1] > frame[3]
    )
  if (
    !caption ||
    !rect(caption.rect) ||
    !Array.isArray(caption.lines) ||
    titles.length !== 1 ||
    caption.page !== table.page ||
    !fencedGroupOpaqueEqual(caption.lines, titles[0].lines) ||
    !caption.rect.every((x, n) => x * 1.5 === titles[0].rect[n]) ||
    titles[0].rect[1] - frame[3] > Math.max(...source.map((i) => i.height)) * 4
  )
    return fail('unique-below-caption')
  const owned = new Map(),
    seen = new Set(),
    slots = new Set(),
    cells = table.cells
  for (const c of cells) {
    if (
      !c ||
      !Number.isInteger(c.row) ||
      c.row < 0 ||
      c.row >= rows ||
      !Number.isInteger(c.column) ||
      c.column < 0 ||
      c.column >= columns ||
      c.colSpan !== 1 ||
      !Number.isInteger(c.rowSpan) ||
      c.rowSpan < 1 ||
      c.row + c.rowSpan > rows ||
      c.section ||
      !rect(c.rect) ||
      typeof c.text !== 'string' ||
      !Array.isArray(c.sourceTokens) ||
      !Array.isArray(c.sourceRects) ||
      c.sourceTokens.length !== c.sourceRects.length ||
      c.sourceTokens.some((t) => !fencedGroupFiniteFont(t)) ||
      c.sourceRects.some((r) => !rect(r)) ||
      c.sourceTokens.some((t) => c.sourceRects.filter((r) => same(r, t.rect)).length !== 1) ||
      c.sourceRects.some((r) => c.sourceTokens.filter((t) => same(r, t.rect)).length !== 1) ||
      (Object.hasOwn(c, 'textRuns') &&
        (!Array.isArray(c.textRuns) ||
          c.textRuns.some(
            (r) =>
              !r ||
              typeof r.text !== 'string' ||
              !['normal', 'subscript', 'superscript'].includes(r.position)
          ) ||
          c.textRuns.map((r) => r.text).join('') !== c.text))
    )
      return fail('old-owner-shape')
    if (c.sourceTokens.length > 1 || table.grid[c.row][c.column] !== c.text)
      return fail('unsplit-whole-owner')
    if (c.sourceTokens.length) {
      const matches = source.filter((i) => fencedGroupSameFont(i, c.sourceTokens[0]))
      if (
        matches.length !== 1 ||
        seen.has(matches[0]) ||
        c.text !== matches[0].text ||
        matches[0].rect[0] < c.rect[0] ||
        matches[0].rect[2] > c.rect[2]
      )
        return fail('unique-full-owner')
      seen.add(matches[0])
      owned.set(c, matches[0])
    } else if (
      c.text !== '' ||
      c.rowSpan !== 1 ||
      c.origin !== 'model-grid' ||
      Object.keys(c).some(
        (k) =>
          ![
            'row',
            'column',
            'rowSpan',
            'colSpan',
            'rect',
            'origin',
            'text',
            'sourceTokens',
            'sourceRects'
          ].includes(k)
      )
    )
      return fail('unsupported-blank-owner')
    for (let r = c.row; r < c.row + c.rowSpan; r++) {
      const slot = r + ':' + c.column
      if (slots.has(slot)) return fail('duplicate-old-slot')
      slots.add(slot)
      if (table.grid[r][c.column] !== (r === c.row ? c.text : '')) return fail('old-covered-grid')
    }
  }
  if (seen.size !== source.length || slots.size !== rows * columns)
    return fail('whole-source-bijection')
  for (const i of source) {
    const matches = runs.filter((r) => r && r.text === i.text && same(r.rect, i.rect))
    if (matches.length !== 1) return fail('unique-observed-program')
    const r = matches[0]
    if (!Array.isArray(r.literalGlyphs) || !Array.isArray(r.glyphRuns) || !Array.isArray(r.gaps))
      return fail('observed-containers')
    const glyphs = [...r.literalGlyphs.join('')]
    if (
      r.height !== i.height ||
      r.baseline !== i.baseline ||
      !Array.isArray(r.literalGlyphs) ||
      r.literalGlyphs.some((g) => typeof g !== 'string' || !g) ||
      fencedGroupCharacters(r.literalGlyphs.join('')) !== fencedGroupCharacters(i.text) ||
      !Array.isArray(r.glyphRuns) ||
      r.glyphRuns.length !== glyphs.length ||
      r.glyphRuns.some((n) => !Number.isInteger(n) || n < 0) ||
      !Array.isArray(r.gaps) ||
      r.gaps.some(
        (g, n) =>
          !g ||
          !Number.isInteger(g.index) ||
          g.index <= 0 ||
          g.index >= glyphs.length ||
          !Number.isFinite(g.left) ||
          !Number.isFinite(g.right) ||
          g.left >= g.right ||
          g.left < i.rect[0] ||
          g.right > i.rect[2] ||
          (n && g.index <= r.gaps[n - 1].index)
      )
    )
      return fail('complete-observed-stream')
  }
  const headers = cells.filter((c) => c.row === 0)
  if (
    headers.length !== columns ||
    headers.some((c) => c.rowSpan !== 1 || !owned.has(c) || owned.get(c).rect[3] >= fences[1][1])
  )
    return fail('complete-header')
  const stubCandidates = [...new Set(cells.filter((c) => c.rowSpan > 1).map((c) => c.column))]
  if (stubCandidates.length !== 1) return fail('unique-stub-column')
  const stub = stubCandidates[0],
    domains = Array.from({ length: columns }, (_, c) =>
      box(cells.filter((x) => x.column === c && owned.has(x)).map((x) => owned.get(x)))
    )
  if (domains.some((d, n) => n && d[0] <= domains[n - 1][2])) return fail('whole-font-gutters')
  const records = []
  for (let row = 1; row < rows; row++) {
    const peers = cells.filter((c) => c.row === row && c.column !== stub)
    if (peers.length !== columns - 1 || peers.some((c) => c.rowSpan !== 1 || !owned.has(c)))
      return fail('complete-peer-record')
    const fonts = peers.map((c) => owned.get(c)),
      baseline = fonts[0].baseline
    if (
      fonts.some((i) => i.baseline !== baseline) ||
      fonts.some((i) => i.height !== fonts[0].height)
    )
      return fail('same-baseline-record')
    const envelope = box(fonts)
    if (
      records.length &&
      (envelope[1] <= records.at(-1).envelope[3] || baseline <= records.at(-1).baseline)
    )
      return fail('record-corridor')
    records.push({ row, baseline, envelope, fonts })
  }
  const labels = [],
    groups = []
  for (let n = 1; n < fences.length - 1; n++) {
    const top = fences[n][1],
      bottom = fences[n + 1][1],
      rec = records.filter((r) => r.envelope[1] > top && r.envelope[3] < bottom),
      labelCells = cells.filter(
        (c) =>
          c.column === stub &&
          c.row > 0 &&
          owned.has(c) &&
          owned.get(c).rect[1] > top &&
          owned.get(c).rect[3] < bottom
      )
    if (!rec.length || labelCells.length !== 1) return fail('unique-fenced-label')
    const donor = labelCells[0],
      font = owned.get(donor),
      row = rec[0].row,
      span = rec.length
    if (
      rec.some((r, k) => r.row !== row + k) ||
      font.height !== owned.get(headers.find((c) => c.column === stub)).height ||
      donor.textRuns?.some((r) => r.position !== 'normal')
    )
      return fail('literal-label-layout')
    const zeroDonors = cells.filter(
      (c) => c.column === stub && c.row >= row && c.row < row + span && !owned.has(c)
    )
    groups.push({
      top,
      bottom,
      records: rec,
      row,
      span,
      donor,
      font,
      zeroDonors,
      correct: donor.row === row && donor.rowSpan === span
    })
    labels.push(font)
  }
  if (
    groups.flatMap((g) => g.records).length !== records.length ||
    labels.length !== cells.filter((c) => c.column === stub && c.row > 0 && owned.has(c)).length ||
    !groups.some((g) => g.correct && contains(g.font.rect, g.donor.rect))
  )
    return fail('complete-calibrated-groups')
  const paintProof = proveNativeFencedPaintClosure(
    fences,
    frame,
    crop,
    groups,
    paint,
    graphics,
    operatorContext
  )
  if (!paintProof.qualified) return paintProof
  const out = structuredClone(table),
    updates = new Map(),
    skip = new Set()
  for (const g of groups) {
    for (let row = g.row; row < g.row + g.span; row++)
      out.grid[row][stub] = row === g.row ? g.donor.text : ''
    if (g.correct) continue
    const donors = [g.donor, ...g.zeroDonors],
      first = Math.min(...donors.map((c) => cells.indexOf(c)))
    updates.set(first, {
      ...structuredClone(g.donor),
      row: g.row,
      rowSpan: g.span,
      rect: [g.donor.rect[0], g.top, g.donor.rect[2], g.bottom]
    })
    donors.forEach((c) => skip.add(cells.indexOf(c)))
  }
  if (!updates.size) return fail('already-source-complete')
  out.cells = cells.flatMap((c, n) =>
    updates.has(n) ? [updates.get(n)] : skip.has(n) ? [] : [structuredClone(c)]
  )
  const resultSlots = new Set()
  for (const c of out.cells)
    for (let row = c.row; row < c.row + c.rowSpan; row++) {
      const slot = row + ':' + c.column
      if (resultSlots.has(slot)) return fail('projected-owner-conflict')
      resultSlots.add(slot)
    }
  if (resultSlots.size !== rows * columns) return fail('projected-owner-gap')
  return {
    qualified: true,
    result: out,
    source,
    groups: groups.map((g) => ({
      row: g.row,
      rowSpan: g.span,
      source: g.font,
      correct: g.correct
    })),
    carriers: paintProof.carriers
  }
}

// Complete closing ink supports ownership recovery; it is not a visible crop-defect claim.
function proveNativeCompleteClosingGroupOwners(...args) {
  const recover = proveNativeVariableFencedGroupOwners
  const current = recover(...args)
  if (current.qualified || current.reason !== 'complete-paint-map') return current
  const [table, items, captions, rules, , paint] = args
  const fail = (reason) => ({ qualified: false, reason })
  const valid = (r) =>
    Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1]
  if (
    !table ||
    !valid(table.cropRect) ||
    !Array.isArray(items) ||
    !Array.isArray(captions) ||
    !Array.isArray(rules) ||
    !(paint instanceof Map)
  )
    return fail('closing-containers')
  if (
    rules.some(
      (r) => !Array.isArray(r) || r.length !== 4 || !r.every(Number.isFinite) || r[1] !== r[3]
    )
  )
    return fail('closing-rules')
  const closing = [...rules].sort((a, b) => a[1] - b[1]).at(-1),
    ink = closing && paint.get(closing.join(',')),
    crop = table.cropRect
  if (
    !valid(ink) ||
    !(closing[1] < crop[3] && crop[3] < ink[3]) ||
    ink[0] < crop[0] ||
    ink[2] > crop[2] ||
    ink[1] < crop[1]
  )
    return fail('only-partial-closing-paint')
  const titles = captions.filter(
    (c) =>
      c &&
      c.page === table.page &&
      valid(c.rect) &&
      c.rect[0] < closing[2] &&
      c.rect[2] > closing[0] &&
      c.rect[1] > closing[1]
  )
  if (titles.length !== 1 || titles[0].rect[1] <= ink[3]) return fail('closing-caption-clearance')
  const top = ink[3],
    bottom = titles[0].rect[1]
  if (items.some((i) => !i || !valid(i.rect))) return fail('closing-font-containers')
  if (
    items.some(
      (i) =>
        typeof i.text !== 'string' ||
        (i.text.trim() &&
          i.rect[0] < crop[2] &&
          i.rect[2] > crop[0] &&
          i.rect[1] < bottom &&
          i.rect[3] > top)
    )
  )
    return fail('closing-foreign-font-corridor')
  const prepared = [...args],
    completed = structuredClone(table)
  completed.cropRect[3] = ink[3]
  prepared[0] = completed
  const result = recover(...prepared)
  if (!result.qualified) return result
  // The underlying proof binds ALL original operator paths to rules or enclosed
  // label fills and all native carriers. It admits no additional corridor paint.
  return result
}

// Complete existing field owners can calibrate an ordinary label group without
// rebuilding any header, wrapped field, rich script or detector row. This late
// consumer requires the existing page-local paint and native graphic evidence.
// Sparse centered stubs cannot set the number of physical records. Only two
// complete baseline peers and unequal, closed native scopes establish these
// rows. Keep the ordinary packet/frame guards and every whole-font owner.
function closedSparseBaselineGroupRecords(table, items, captions, rules, paint, graphics, context) {
  try {
    if (
      !table ||
      (table.readingRotation !== undefined && table.readingRotation !== 0) ||
      !fencedGroupValidRect(table.cropRect) ||
      !Array.isArray(table.cells) ||
      !Array.isArray(table.grid) ||
      table.grid.some((r) => !Array.isArray(r) || r.length !== 5) ||
      !Array.isArray(table.rows) ||
      table.rows.length !== table.grid.length ||
      table.rows
        .slice(1)
        .some((r) => !r || Reflect.ownKeys(r).some((k) => !['rect', 'origin'].includes(k))) ||
      !Array.isArray(table.issues) ||
      table.issues.some((i) => i !== 'unassigned-source-text') ||
      !Array.isArray(table.unassigned) ||
      table.unassigned.some((i) => typeof i !== 'string') ||
      !Array.isArray(table.clipped) ||
      table.clipped.length ||
      table.parts?.length ||
      !Array.isArray(items) ||
      items.some(
        (i) => !fencedGroupFiniteFont(i) || !i.horizontal || i.sourceToken || i.nativeLaneSplit
      ) ||
      !Array.isArray(captions) ||
      !(paint instanceof Map) ||
      !fencedGroupOpaqueEqual(paint, context?.rulePaintBounds) ||
      !fencedGroupOpaqueEqual(graphics, context?.nativeEvidenceGraphics) ||
      !Number.isInteger(table.page) ||
      !table.caption ||
      !Array.isArray(table.caption.lines) ||
      !table.caption.lines.length
    )
      return
    const frame = nativeHeaderFrame(table, items, rules)
    if (!frame) return
    const { h, opening, divider, closing, source, header, body } = frame
    if (!proveNativeCompleteRuledSourcePacket(source, rules, context, table.cropRect)) return
    const titles = captions.filter(
      (c) =>
        c?.page === table.page &&
        Array.isArray(c.lines) &&
        captionKind(c.lines.join(' ')) === 'table' &&
        fencedGroupValidRect(c.rect) &&
        c.rect[0] < closing[2] &&
        c.rect[2] > opening[0] &&
        (c.rect[3] < opening[1] || c.rect[1] > closing[1])
    )
    if (titles.length !== 1 || !fencedGroupOpaqueEqual(titles[0].lines, table.caption.lines)) return
    const heads = table.cells.filter((c) => c.row === 0).sort((a, b) => a.column - b.column)
    if (
      heads.length !== 5 ||
      heads.some(
        (c, n) =>
          c.column !== n || c.rowSpan !== 1 || c.colSpan !== 1 || !fencedGroupValidRect(c.rect)
      )
    )
      return
    const cuts = [heads[0].rect[0], ...heads.map((c) => c.rect[2])]
    if (
      Math.abs(cuts[0] - opening[0]) > 0.7 ||
      Math.abs(cuts.at(-1) - opening[2]) > 0.7 ||
      heads.some((c, n) => n && Math.abs(c.rect[0] - cuts[n]) > 0.02)
    )
      return
    const lane = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
    if (
      source.some((i) => lane(i) < 0 || i.rect[0] < cuts[lane(i)] || i.rect[2] > cuts[lane(i) + 1])
    )
      return
    for (let c = 1; c < 5; c++) {
      const left = source.filter((i) => lane(i) === c - 1),
        right = source.filter((i) => lane(i) === c)
      if (
        !left.length ||
        !right.length ||
        Math.min(...right.map((i) => i.rect[0])) - Math.max(...left.map((i) => i.rect[2])) <=
          h * 0.15
      )
        return
    }
    const ordered = (a) => [...a].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
    const owners = new Map(),
      donors = new Map()
    // The existing header is already a complete wrapped logical row. Never
    // turn its two physical baselines into an invented second logical header.
    for (const cell of table.cells) {
      if (
        !Array.isArray(cell.sourceTokens) ||
        !Array.isArray(cell.sourceRects) ||
        cell.sourceTokens.length !== cell.sourceRects.length ||
        typeof cell.text !== 'string'
      )
        return
      const fonts = []
      for (const [n, t] of cell.sourceTokens.entries()) {
        const matches = source.filter(
          (i) =>
            i.text === t.text &&
            i.height === t.height &&
            i.baseline === t.baseline &&
            sameRect(i.rect, t.rect)
        )
        if (
          matches.length !== 1 ||
          owners.has(matches[0]) ||
          !sameRect(cell.sourceRects[n], t.rect)
        )
          return
        fonts.push(matches[0])
        owners.set(matches[0], t)
        donors.set(matches[0], cell)
      }
      if (!nativeCellOriginsMatch(cell, fonts)) return
      if (
        cell.text.replace(/\s/gu, '') !==
        ordered(fonts)
          .map((i) => i.text.replace(/\s/gu, ''))
          .join('')
      )
        return
      if (
        cell.textRuns &&
        (!Array.isArray(cell.textRuns) ||
          cell.textRuns.some(
            (r) =>
              !r ||
              typeof r.text !== 'string' ||
              !['normal', 'subscript', 'superscript'].includes(r.position)
          ) ||
          cell.textRuns.map((r) => r.text).join('') !== cell.text)
      )
        return
    }
    if (
      heads.some(
        (c, n) =>
          c.sourceTokens.length !== header.filter((i) => lane(i) === n).length ||
          header.filter((i) => lane(i) === n).some((i) => donors.get(i) !== c)
      )
    )
      return
    if (
      !fencedGroupOpaqueEqual(
        [...table.unassigned].sort(),
        source
          .filter((i) => !owners.has(i))
          .map((i) => i.text)
          .sort()
      )
    )
      return
    const dense = ordered(body.filter((i) => lane(i) >= 3)),
      records = groupSourceRowsWithScripts(dense, h, 0.02)
    if (
      !records ||
      records.some(
        (r) =>
          r.some((i) => i.height < h * 0.8 || Math.abs(i.baseline - r[0].baseline) > 0.02) ||
          !readSourceRow(r, cuts)?.[3] ||
          r.filter((i) => lane(i) === 4).length !== 1 ||
          !/^\d+(?:\.\d+)?$/u.test(r.find((i) => lane(i) === 4).text)
      )
    )
      return
    const fences = joinHorizontalTableRules(rules, 0.01, 0)
      .filter(
        (r) =>
          r[1] >= divider[1] &&
          r[1] <= closing[1] &&
          Math.abs(r[0] - opening[0]) <= 0.02 &&
          Math.abs(r[2] - opening[2]) <= 0.02
      )
      .sort((a, b) => a[1] - b[1])
    if (fences.length < 4 || fences[0][1] !== divider[1] || fences.at(-1)[1] !== closing[1]) return
    const scopes = fences.slice(0, -1).map((edge, n) => ({
      top: edge[1],
      bottom: fences[n + 1][1],
      records: records.filter((r) => r[0].baseline > edge[1] && r[0].baseline < fences[n + 1][1])
    }))
    if (
      scopes.some((g) => g.records.length < 3) ||
      new Set(scopes.map((g) => g.records.length)).size < 3 ||
      scopes.flatMap((g) => g.records).length !== records.length
    )
      return
    const gaps = scopes.flatMap((g) =>
      g.records.slice(1).map((r, n) => r[0].baseline - g.records[n][0].baseline)
    )
    if (gaps.some((v) => v < h * 0.8 || v > h * 2 || Math.abs(v - gaps[0]) > 0.02)) return
    const partition = [header, ...records],
      plans = []
    for (const [n, g] of scopes.entries()) {
      const middle = (g.records[0][0].baseline + g.records.at(-1)[0].baseline) / 2
      for (let c = 0; c < 3; c++) {
        const fonts = ordered(
          body.filter((i) => lane(i) === c && i.baseline > g.top && i.baseline < g.bottom)
        )
        if (c === 1 && n === 0) {
          if (
            fonts.length !== g.records.length ||
            fonts.some(
              (i, j) => i.height < h * 0.8 || Math.abs(i.baseline - g.records[j][0].baseline) > 0.02
            )
          )
            return
          fonts.forEach((i, j) => {
            partition.push([i])
            plans.push({
              fonts: [i],
              column: c,
              row: 1 + records.indexOf(g.records[j]),
              rowSpan: 1
            })
          })
        } else {
          const main = fonts.filter((i) => i.height >= h * 0.8),
            small = fonts.filter((i) => i.height < h * 0.8)
          if (
            main.length !== 1 ||
            Math.abs(main[0].baseline - middle) > 0.02 ||
            (c !== 2 && small.length) ||
            small.length > 1 ||
            small.some((i) => !isAdjacentTableScript(i, main[0])) ||
            groupSourceRowsWithScripts(fonts, h, 0.02)?.length !== 1
          )
            return
          // Rich script semantics already belong to this exact existing donor.
          // A new guess from nominal boxes must not create or rewrite scripts.
          if (small.length) {
            const donor = donors.get(main[0])
            if (
              !donor ||
              donors.get(small[0]) !== donor ||
              donor.sourceTokens.length !== fonts.length ||
              donor.textRuns?.length !== 2 ||
              donor.textRuns[0].text !== main[0].text ||
              donor.textRuns[0].position !== 'normal' ||
              donor.textRuns[1].text !== small[0].text ||
              donor.textRuns[1].position !==
                (small[0].baseline > main[0].baseline ? 'subscript' : 'superscript')
            )
              return
          }
          partition.push(fonts)
          plans.push({
            fonts,
            column: c,
            row: 1 + records.indexOf(g.records[0]),
            rowSpan: g.records.length
          })
        }
      }
    }
    if (!hasUniqueRecordTokens(source, partition)) return
    const centers = records.map((r) => [
      Math.min(...r.map((i) => (i.rect[1] + i.rect[3]) / 2)),
      Math.max(...r.map((i) => (i.rect[1] + i.rect[3]) / 2))
    ])
    if (
      centers.some(
        (r, n) => r[0] <= divider[1] || r[1] >= closing[1] || (n && r[0] <= centers[n - 1][1])
      )
    )
      return
    const bounds = [
      divider[1],
      ...centers.slice(1).map((r, n) => (centers[n][1] + r[0]) / 2),
      closing[1]
    ]
    // Short rules separate only the two peer fields. They cannot create a new
    // sparse-owner group; require a clear physical center gap for every one.
    const inside = rules.filter(
      (r) => r[0] < closing[2] && r[2] > opening[0] && r[1] > opening[1] && r[1] < closing[1]
    )
    if (
      inside.some(
        (r) =>
          !fences.some((e) => sameRect(e, r)) &&
          r[1] !== divider[1] &&
          !(
            Math.abs(r[0] - cuts[3]) < h * 0.2 &&
            Math.abs(r[2] - opening[2]) <= 0.02 &&
            centers.slice(1).filter((v, n) => r[1] > centers[n][1] && r[1] < v[0]).length === 1
          )
      )
    )
      return
    records.forEach((r, n) => {
      for (let c = 3; c < 5; c++)
        plans.push({
          fonts: ordered(r.filter((i) => lane(i) === c)),
          column: c,
          row: n + 1,
          rowSpan: 1
        })
    })
    const mutable = new Set([
      'row',
      'column',
      'rowSpan',
      'colSpan',
      'rect',
      'text',
      'textRuns',
      'sourceTokens',
      'sourceRects',
      'sourceItems',
      'origin'
    ])
    const opaque = (c) =>
      Object.fromEntries(
        Reflect.ownKeys(c)
          .filter((k) => !mutable.has(k))
          .map((k) => [k, c[k]])
      )
    const cells = heads.map((c) => structuredClone(c)),
      grid = [heads.map((c) => c.text), ...records.map(() => Array(5).fill(''))]
    for (const p of plans) {
      const old = [...new Set(p.fonts.map((i) => donors.get(i)).filter(Boolean))],
        exact =
          old.length === 1 &&
          old[0].sourceTokens.length === p.fonts.length &&
          p.fonts.every((i) => donors.get(i) === old[0])
      let cell
      if (exact) cell = structuredClone(old[0])
      else {
        if (
          old.some(
            (c) =>
              Reflect.ownKeys(opaque(c)).length ||
              c.textRuns?.some(
                (r) =>
                  r.position !== 'normal' ||
                  Reflect.ownKeys(r).some((k) => !['text', 'position'].includes(k))
              )
          )
        )
          return
        cell = { origin: old[0]?.origin ?? heads[p.column].origin }
        cell.sourceTokens = p.fonts.map((i) =>
          structuredClone(
            owners.get(i) ?? { text: i.text, rect: i.rect, baseline: i.baseline, height: i.height }
          )
        )
        cell.sourceRects = cell.sourceTokens.map((t) => t.rect)
        cell.text = p.fonts
          .map(
            (i, n) => `${n && i.rect[0] - p.fonts[n - 1].rect[2] > h * 0.12 ? ' ' : ''}${i.text}`
          )
          .join('')
      }
      cell.row = p.row
      cell.column = p.column
      cell.rowSpan = p.rowSpan
      cell.colSpan = 1
      cell.rect = [
        cuts[p.column],
        Math.min(bounds[p.row - 1], ...p.fonts.map((i) => i.rect[1])),
        cuts[p.column + 1],
        Math.max(bounds[p.row - 1 + p.rowSpan], ...p.fonts.map((i) => i.rect[3]))
      ]
      const origins = nativeWholeFontOrigins(p.fonts)
      if (!origins) return
      cell.sourceItems = origins
      grid[p.row][p.column] = cell.text
      cells.push(cell)
    }
    if (
      !hasUniqueRecordTokens(
        source,
        cells.map((c) =>
          c.sourceTokens.map((t) =>
            source.find(
              (i) =>
                i.text === t.text &&
                i.height === t.height &&
                i.baseline === t.baseline &&
                sameRect(i.rect, t.rect)
            )
          )
        )
      )
    )
      return
    // An empty donor carrying opaque payload cannot silently disappear.
    if (
      table.cells.some(
        (c) => !c.sourceTokens.length && (Reflect.ownKeys(opaque(c)).length || c.textRuns?.length)
      )
    )
      return
    const rows = [
      structuredClone(table.rows[0]),
      ...bounds
        .slice(1)
        .map((y, n) => ({ rect: [cuts[0], bounds[n], cuts.at(-1), y], origin: 'source-text' }))
    ]
    return {
      ...structuredClone(table),
      grid,
      cells: cells.sort((a, b) => a.row - b.row || a.column - b.column),
      rows,
      unassigned: [],
      clipped: [],
      issues: []
    }
  } catch {
    return undefined
  }
}

export function recoverNativeFencedGroupLabels(
  table,
  items,
  captions,
  rules,
  observedRuns = [],
  rulePaintBounds,
  sourceGraphics,
  operatorContext
) {
  if (operatorContext) {
    const boundedCentered = recoverCompleteCenteredMultilineStub(
      table,
      items,
      captions,
      rules,
      operatorContext
    )
    if (boundedCentered) return boundedCentered
    const sections = recoverCompleteRuledSectionLabels(
      table,
      items,
      captions,
      rules,
      rulePaintBounds,
      sourceGraphics,
      operatorContext
    )
    if (sections) return sections
    const firstBaseline = recoverCompleteFirstBaselineGroupLabels(
      table,
      items,
      captions,
      rules,
      rulePaintBounds,
      sourceGraphics,
      operatorContext
    )
    if (firstBaseline) return firstBaseline
    const sparse = closedSparseBaselineGroupRecords(
      table,
      items,
      captions,
      rules,
      rulePaintBounds,
      sourceGraphics,
      operatorContext
    )
    if (sparse) return sparse
    const centered = recoverCompleteCenteredGroupLabels(
      table,
      items,
      captions,
      rules,
      rulePaintBounds,
      sourceGraphics,
      operatorContext
    )
    if (centered) return centered
    const proof = proveNativeCompleteClosingGroupOwners(
      table,
      items,
      captions,
      rules,
      observedRuns,
      rulePaintBounds,
      sourceGraphics,
      operatorContext
    )
    if (proof.qualified) return proof.result
    const ordinary = recoverCompleteBaselineOrdinaryRecords(
      table,
      items,
      captions,
      rules,
      rulePaintBounds,
      sourceGraphics,
      operatorContext
    )
    if (ordinary) return ordinary
  }
  const viewport = table?.sourceViewport,
    caption = table?.caption
  if (
    !table ||
    !Array.isArray(table.cells) ||
    !viewport ||
    viewport.scale !== 1.5 ||
    ![viewport.width, viewport.height].every((v) => Number.isInteger(v) && v > 0) ||
    !Number.isInteger(table.page) ||
    !caption ||
    !fencedGroupValidRect(caption.rect) ||
    !Array.isArray(caption.lines) ||
    !caption.lines.length ||
    caption.lines.some((line) => typeof line !== 'string') ||
    caption.page !== table.page ||
    !Array.isArray(captions)
  )
    return
  const captionMatches = captions.filter(
    (c) =>
      c &&
      fencedGroupValidRect(c.rect) &&
      Array.isArray(c.lines) &&
      c.lines.length === caption.lines.length &&
      c.page === table.page &&
      c.lines.every((line, n) => line === caption.lines[n]) &&
      c.rect.every((v, n) => v === caption.rect[n] * 1.5)
  )
  if (captionMatches.length !== 1) return
  const candidates = [
    ...new Set(
      table.cells
        .filter((c) => c && c.row > 0 && c.rowSpan > 1 && Number.isInteger(c.column))
        .map((c) => c.column)
    )
  ]
  if (candidates.length !== 1) return
  const proof = proveNativeExistingFencedGroupOwners({
    table,
    items,
    captions,
    rules,
    runs: observedRuns,
    paint: rulePaintBounds,
    graphics: sourceGraphics,
    viewport,
    stubColumn: candidates[0],
    page: table.page
  })
  if (!proof?.qualified || proof.originalCropPaintExceptions.length) return
  return projectNativeExistingFencedGroupOwners(table, proof)
}

// Two equal, fully fenced groups contain independently complete scalar rows.
// Canonical source references are a private proof view only: original header,
// body, rich and opaque payloads are never projected from that view.
function recoverCompleteCenteredMultilineStub(table, items, captions, rules, context) {
  const unassigned = table && Object.getOwnPropertyDescriptor(table, 'unassigned')?.value
  const data = (value, seen = new Set()) => {
    if (value === null || typeof value !== 'object')
      return !['function', 'symbol'].includes(typeof value)
    if (
      seen.has(value) ||
      (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)
    )
      return false
    if (
      Array.isArray(value) &&
      Object.keys(value).filter((k) => /^(?:0|[1-9]\d*)$/.test(k)).length !== value.length
    )
      return false
    seen.add(value)
    const valid = Reflect.ownKeys(value).every((key) => {
      if (Array.isArray(value) && key === 'length') return true
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (value === unassigned && key === 'reconciliationItems')
        return (
          Array.isArray(items) &&
          descriptor?.enumerable === false &&
          descriptor.writable === false &&
          descriptor.configurable === false &&
          Object.hasOwn(descriptor, 'value') &&
          Array.isArray(descriptor.value) &&
          descriptor.value.every(
            (f) =>
              !f.sourceToken &&
              data(f, seen) &&
              items.filter(
                (i) =>
                  fencedGroupSameFont(i, f) && fencedGroupOpaqueEqual(i.sourceItem, f.sourceItem)
              ).length === 1
          )
        )
      if (Array.isArray(value) && (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key)))
        return false
      return (
        typeof key === 'string' &&
        descriptor?.enumerable &&
        Object.hasOwn(descriptor, 'value') &&
        data(descriptor.value, seen)
      )
    })
    seen.delete(value)
    return valid
  }
  if (!data(table)) return
  const columns = table?.grid?.[0]?.length,
    rows = table?.grid?.length
  if (
    !(columns >= 3 && columns <= 10) ||
    !(rows >= 7 && rows <= 17) ||
    rows % 2 !== 1 ||
    !Array.isArray(table.cells) ||
    !Array.isArray(items) ||
    !Array.isArray(rules) ||
    (table.readingRotation !== undefined && table.readingRotation !== 0) ||
    ['notes', 'parts', 'unassigned', 'clipped', 'issues'].some(
      (k) => table[k] !== undefined && (!Array.isArray(table[k]) || table[k].length)
    )
  )
    return
  const canonical = []
  for (const c of table.cells) {
    if (!Array.isArray(c.sourceTokens) || !Array.isArray(c.sourceRects)) return
    const fonts = c.sourceTokens.map((ref) => {
      if (!fencedGroupFiniteFont(ref)) return
      const matches = items.filter((f) => fencedGroupSameFont(f, ref))
      if (matches.length !== 1) return
      const f = matches[0]
      if (ref.sourceToken) {
        const { sourceToken, ...wrapper } = ref
        if (
          c.row !== 0 ||
          !fencedGroupOpaqueEqual(sourceToken, f) ||
          !fencedGroupOpaqueEqual(wrapper, f)
        )
          return
      } else if (
        Reflect.ownKeys(ref).some(
          (k) =>
            ![
              'text',
              'rect',
              'baseline',
              'height',
              'horizontal',
              'fontDescent',
              'inlineSymbol',
              'sourceItem'
            ].includes(k)
        ) ||
        (ref.sourceItem && !fencedGroupOpaqueEqual(ref.sourceItem, f.sourceItem)) ||
        (!ref.sourceItem && !c.sourceItems) ||
        ['horizontal', 'fontDescent', 'inlineSymbol'].some(
          (k) => Object.hasOwn(ref, k) && !fencedGroupOpaqueEqual(ref[k], f[k])
        )
      )
        return
      return f
    })
    if (
      fonts.some((f) => !f) ||
      (c.sourceItems && !fencedGroupOpaqueEqual(c.sourceItems, nativeWholeFontOrigins(fonts)))
    )
      return
    canonical.push({ ...c, sourceTokens: fonts })
  }
  const p = nativeWholeOwnerSourcePacket({ ...table, cells: canonical }, items, rules, context)
  if (!p) return
  const local = rules
      .filter((r) => r[1] === r[3] && r[1] > table.cropRect[1] && r[1] < table.cropRect[3])
      .sort((a, b) => a[1] - b[1]),
    sourceBox = [
      Math.min(...p.fonts.map((f) => f.rect[0])),
      Math.max(...p.fonts.map((f) => f.rect[2]))
    ]
  if (
    local.length !== 4 ||
    local.some(
      (r) =>
        r[0] > sourceBox[0] ||
        r[2] < sourceBox[1] ||
        Math.abs(r[0] - local[0][0]) > 0.02 ||
        Math.abs(r[2] - local[0][2]) > 0.02
    ) ||
    rules.some(
      (r) =>
        r[0] === r[2] &&
        r[0] > local[0][0] &&
        r[0] < local[0][2] &&
        r[1] < local.at(-1)[1] &&
        r[3] > local[0][1]
    )
  )
    return
  const title = table.caption,
    titleMatches = captions.filter(
      (c) =>
        c.page === table.page &&
        fencedGroupOpaqueEqual(c.lines, title?.lines) &&
        title?.rect?.every((v, n) => v * context.viewport.scale === c.rect?.[n])
    )
  if (
    titleMatches.length !== 1 ||
    captionKind(titleMatches[0].lines?.[0]) !== 'table' ||
    titleMatches[0].rect[3] >= local[0][1]
  )
    return
  const count = (rows - 1) / 2,
    at = (r, c) => canonical.find((cell) => cell.row === r && cell.column === c),
    headers = Array.from({ length: columns }, (_, c) => at(0, c))
  if (
    headers.some(
      (c) =>
        !c ||
        c.rowSpan !== 1 ||
        c.colSpan !== 1 ||
        p.owners.get(c)?.length !== 1 ||
        p.owners.get(c)[0].rect[1] <= local[0][1] ||
        p.owners.get(c)[0].rect[3] >= local[1][1]
    )
  )
    return
  const groups = [0, 1].map((g) => {
    const first = 1 + g * count,
      band = [local[1 + g][1], local[2 + g][1]],
      donor = canonical.filter(
        (c) => c.column === 0 && c.row >= first && c.row < first + count && c.text
      ),
      records = Array.from({ length: count }, (_, n) =>
        Array.from({ length: columns - 1 }, (_, col) => at(first + n, col + 1))
      )
    if (
      donor.length !== 1 ||
      donor[0].colSpan !== 1 ||
      donor[0].rowSpan < 2 ||
      records.some((r) =>
        r.some((c) => !c || c.rowSpan !== 1 || c.colSpan !== 1 || p.owners.get(c).length !== 1)
      )
    )
      return
    const recordFonts = records.map((r) => r.map((c) => p.owners.get(c)[0])),
      stub = p.owners.get(donor[0])
    if (
      stub.length !== 2 ||
      stub.some(
        (f) =>
          !/\p{L}/u.test(f.text) ||
          f.rect[1] <= band[0] ||
          f.rect[3] >= band[1] ||
          Math.abs(f.height - p.height) > 0.02
      ) ||
      donor[0].text.replace(/\s/gu, '') !==
        stub
          .map((f) => f.text)
          .join('')
          .replace(/\s/gu, '') ||
      (donor[0].textRuns !== undefined &&
        (!Array.isArray(donor[0].textRuns) ||
          donor[0].textRuns.some(
            (r) =>
              !r ||
              r.position !== 'normal' ||
              typeof r.text !== 'string' ||
              Reflect.ownKeys(r).some((k) => !['text', 'position'].includes(k))
          ) ||
          donor[0].textRuns.map((r) => r.text).join('') !== donor[0].text)) ||
      stub[0].baseline >= stub[1].rect[1] ||
      recordFonts.some((fs, n) =>
        fs.some(
          (f, col) =>
            f.rect[1] <= band[0] ||
            f.rect[3] >= band[1] ||
            (col && !/^[+-]?\d+(?:\.\d+)?$/.test(f.text.trim())) ||
            Math.abs(f.baseline - fs[0].baseline) > 0.02 ||
            Math.abs(f.height - p.height) > 0.02 ||
            (col && f.rect[0] <= fs[col - 1].rect[2]) ||
            (n && f.rect[1] <= recordFonts[n - 1][col].rect[3])
        )
      ) ||
      Math.max(...stub.map((f) => f.rect[2])) >=
        Math.min(...recordFonts.flat().map((f) => f.rect[0])) ||
      Math.abs(
        (Math.min(...stub.map((f) => f.rect[1])) + Math.max(...stub.map((f) => f.rect[3]))) / 2 -
          (band[0] + band[1]) / 2
      ) > p.height ||
      donor[0].row + donor[0].rowSpan !== first + count
    )
      return
    return { first, donor: donor[0], records, stub }
  })
  if (
    groups.some((g) => !g) ||
    groups[0].donor.row !== 2 ||
    groups[0].donor.rowSpan !== count - 1 ||
    groups[1].donor.row !== 1 + count ||
    groups[1].donor.rowSpan !== count
  )
    return
  const lanes = Array.from({ length: columns }, (_, c) =>
      canonical.filter((cell) => cell.column === c).flatMap((cell) => p.owners.get(cell))
    ),
    extents = lanes.map((fs) => [
      Math.min(...fs.map((f) => f.rect[0])),
      Math.max(...fs.map((f) => f.rect[2]))
    ])
  if (extents.some((e, c) => !e.every(Number.isFinite) || (c && e[0] <= extents[c - 1][1]))) return
  if (
    !hasUniqueRecordTokens(p.fonts, [
      ...headers.map((c) => p.owners.get(c)),
      ...groups.flatMap((g) => [g.stub, ...g.records.flat().map((c) => p.owners.get(c))])
    ])
  )
    return
  const blank = table.cells.find((c) => c.row === 1 && c.column === 0),
    original = table.cells.find((c) => c.row === groups[0].donor.row && c.column === 0)
  if (
    !blank ||
    blank.text !== '' ||
    blank.rowSpan !== 1 ||
    blank.colSpan !== 1 ||
    !fencedGroupValidRect(blank.rect) ||
    blank.sourceTokens.length ||
    blank.sourceRects.length ||
    blank.sourceItems?.length ||
    Reflect.ownKeys(blank).some(
      (k) =>
        ![
          'row',
          'column',
          'rowSpan',
          'colSpan',
          'rect',
          'text',
          'sourceTokens',
          'sourceRects',
          'sourceItems',
          'origin'
        ].includes(k)
    ) ||
    !fencedGroupValidRect(original.rect) ||
    (Object.hasOwn(blank, 'origin') && blank.origin !== 'model-grid') ||
    blank.rect[0] !== original.rect[0] ||
    blank.rect[2] !== original.rect[2] ||
    blank.rect[1] <= local[1][1] ||
    blank.rect[3] >= local[2][1] ||
    blank.rect[1] >= original.rect[1] ||
    blank.rect[3] > original.rect[3] ||
    original.rect[1] <= local[1][1] ||
    original.rect[3] >= local[2][1]
  )
    return
  const cells = table.cells
      .filter((c) => c !== blank)
      .map((c) =>
        c === original
          ? {
              ...c,
              row: 1,
              rowSpan: count,
              rect: [c.rect[0], Math.min(c.rect[1], blank.rect[1]), c.rect[2], c.rect[3]]
            }
          : c
      ),
    grid = table.grid.map((r) => [...r])
  grid[1][0] = original.text
  grid[2][0] = ''
  return { ...table, cells, grid }
}

// A lone whole printed title between coextensive fences owns the complete
// physical row only after independent complete numeric rows establish its body.
// This changes title slots, never sparse body stub scope or header hierarchy.
function recoverCompleteRuledSectionLabels(
  table,
  items,
  captions,
  rules,
  paint,
  graphics,
  context
) {
  const plain = (v) =>
    v &&
    typeof v === 'object' &&
    Reflect.ownKeys(v).every((k) => {
      const d = Object.getOwnPropertyDescriptor(v, k)
      return typeof k === 'string' && d?.enumerable && Object.hasOwn(d, 'value')
    })
  const dataTree = (v, seen = new Set()) => {
    if (v === null || typeof v !== 'object') return typeof v !== 'function' && typeof v !== 'symbol'
    if (seen.has(v)) return true
    if (!Array.isArray(v) && ![Object.prototype, null].includes(Object.getPrototypeOf(v)))
      return false
    seen.add(v)
    return Reflect.ownKeys(v).every((k) => {
      if (Array.isArray(v) && k === 'length') return true
      const d = Object.getOwnPropertyDescriptor(v, k)
      if (v === table.unassigned && k === 'reconciliationItems') {
        return (
          d?.enumerable === false &&
          d.writable === false &&
          d.configurable === false &&
          Object.hasOwn(d, 'value') &&
          Array.isArray(d.value) &&
          d.value.every(
            (i) =>
              items.includes(i) &&
              !i.sourceToken &&
              i.sourceItem?.text === i.text &&
              dataTree(i, seen)
          )
        )
      }
      return (
        typeof k === 'string' &&
        d?.enumerable &&
        Object.hasOwn(d, 'value') &&
        dataTree(d.value, seen)
      )
    })
  }
  if (
    !plain(table) ||
    !dataTree(table) ||
    !context?.viewport ||
    !Number.isFinite(context.viewport.scale) ||
    context.viewport.scale <= 0 ||
    !Array.isArray(table.cells) ||
    table.cells.some((c) => !plain(c))
  )
    return
  if (
    table.cells.some(
      (c) =>
        !Array.isArray(c.sourceTokens) ||
        !Array.isArray(c.sourceRects) ||
        c.sourceTokens.length !== c.sourceRects.length ||
        c.sourceTokens.some((t) => !plain(t)) ||
        c.sourceRects.some((r) => !fencedGroupValidRect(r)) ||
        (Object.hasOwn(c, 'sourceItems') &&
          (!Array.isArray(c.sourceItems) || c.sourceItems.some((o) => !plain(o))))
    ) ||
    (Object.hasOwn(table, 'unassigned') &&
      (!Array.isArray(table.unassigned) || table.unassigned.some((t) => typeof t !== 'string')))
  )
    return
  const crop = table.cropRect,
    count = table.grid?.[0]?.length
  if (
    !fencedGroupValidRect(crop) ||
    table.readingRotation ||
    !Array.isArray(table.grid) ||
    !(count >= 3 && count <= 16) ||
    table.grid.some((r) => !Array.isArray(r) || r.length !== count) ||
    !Array.isArray(table.rows) ||
    table.rows.length !== table.grid.length ||
    !Array.isArray(items) ||
    !Array.isArray(rules) ||
    !Array.isArray(captions) ||
    !Number.isInteger(table.page) ||
    !table.caption ||
    !table.sourceViewport ||
    table.sourceViewport.scale !== context.viewport?.scale ||
    table.sourceViewport.width !== context.viewport?.width ||
    table.sourceViewport.height !== context.viewport?.height ||
    table.parts?.length ||
    table.clipped?.length
  )
    return
  let source = items.filter((i) => i.text?.trim() && fencedGroupIntersects(i.rect, crop))
  if (
    !source.length ||
    source.some(
      (i) =>
        !fencedGroupFiniteFont(i) ||
        i.horizontal !== true ||
        i.sourceToken ||
        i.sourceItem?.pageNumber !== table.page ||
        i.sourceItem.text !== i.text
    )
  )
    return
  const full = joinHorizontalTableRules(rules, 0.01, 0)
    .filter(
      (r) =>
        r[1] >= crop[1] - 0.02 && r[1] <= crop[3] + 0.02 && r[2] - r[0] >= (crop[2] - crop[0]) * 0.9
    )
    .sort((a, b) => a[1] - b[1])
  if (
    full.length < 5 ||
    full.some(
      (r, n) =>
        Math.abs(r[0] - full[0][0]) > 0.02 ||
        Math.abs(r[2] - full[0][2]) > 0.02 ||
        (n && r[1] - full[n - 1][1] <= 0)
    )
  )
    return
  const frame = [full[0][0], full[0][1], full[0][2], full.at(-1)[1]]
  const title = table.caption,
    scale = context.viewport.scale,
    matching = captions.filter(
      (c) =>
        c.page === table.page &&
        captionKind(c.lines?.[0]) === 'table' &&
        fencedGroupValidRect(c.rect) &&
        c.rect[3] < frame[1] &&
        c.rect[0] < frame[2] &&
        c.rect[2] > frame[0] &&
        fencedGroupOpaqueEqual(c.lines, title.lines) &&
        title.rect?.every((v, n) => Math.abs(v * scale - c.rect[n]) < 0.02)
    )
  if (matching.length !== 1) return
  const captionFonts = items.filter(
    (i) => i.text?.trim() && fencedGroupIntersects(i.rect, matching[0].rect)
  )
  if (
    !captionFonts.length ||
    captionFonts.some(
      (i) =>
        i.sourceToken ||
        i.sourceItem?.text !== i.text ||
        !fencedGroupContains(i.rect, matching[0].rect)
    ) ||
    captionFonts
      .map((i) => i.text)
      .join('')
      .replace(/\s/gu, '') !== title.lines.join('').replace(/\s/gu, '')
  )
    return
  source = source.filter((i) => !captionFonts.includes(i))
  if (
    source.some(
      (i) =>
        i.rect[0] < frame[0] - 0.02 ||
        i.rect[2] > frame[2] + 0.02 ||
        i.baseline <= frame[1] ||
        i.baseline >= frame[3]
    ) ||
    !proveNativeCompleteRuledSourcePacket(
      [...source, ...captionFonts],
      rules,
      { ...context, rulePaintBounds: paint, nativeEvidenceGraphics: graphics },
      crop
    )
  )
    return
  const bands = full.slice(1).map((r, n) => ({
    top: full[n][1],
    bottom: r[1],
    fonts: source.filter((i) => i.baseline > full[n][1] && i.baseline < r[1])
  }))
  if (bands.flatMap((b) => b.fonts).length !== source.length) return
  const numeric = (s) => /^[−+-]?\d+(?:[.,]\d+)*%?$/.test(s)
  const replacements = []
  for (const [n, band] of bands.entries()) {
    if (band.fonts.length !== 1 || !/\p{L}/u.test(band.fonts[0].text)) continue
    const font = band.fonts[0],
      peers = bands.slice(n + 1, n + 3)
    if (
      peers.length !== 2 ||
      peers.some((b) => b.fonts.length !== count || b.fonts.some((i) => !numeric(i.text))) ||
      rules.some((r) => {
        if (
          Math.abs(r[0] - r[2]) >= 0.02 ||
          Math.max(r[1], r[3]) <= band.top + 0.02 ||
          Math.min(r[1], r[3]) >= band.bottom - 0.02
        )
          return false
        const p = paint?.get(r.join(','))
        if (!fencedGroupValidRect(p)) return true
        const half = (p[2] - p[0]) / 2
        return Math.abs(r[0] - frame[0]) > half + 0.02 && Math.abs(r[0] - frame[2]) > half + 0.02
      })
    )
      continue
    const candidateRows = table.rows.flatMap((r, index) =>
      fencedGroupValidRect(r.rect) && font.baseline > r.rect[1] && font.baseline < r.rect[3]
        ? [index]
        : []
    )
    if (candidateRows.length !== 1) return
    const row = candidateRows[0],
      donors = table.cells.filter((c) => c.row === row).sort((a, b) => a.column - b.column)
    if (
      donors.length === 1 &&
      donors[0].column === 0 &&
      donors[0].colSpan === count &&
      donors[0].text === font.text
    )
      continue
    if (
      donors.length !== count ||
      donors.some(
        (c, col) =>
          c.column !== col || c.colSpan !== 1 || c.rowSpan !== 1 || !fencedGroupValidRect(c.rect)
      )
    )
      return
    const populated = donors.filter(
      (c) => c.text || c.sourceTokens?.length || c.sourceRects?.length || c.sourceItems
    )
    if (populated.length > 1) return
    const donor = populated[0] ?? donors[0]
    for (const c of donors) {
      if (c === donor && populated.length) {
        if (
          c.text !== font.text ||
          c.sourceTokens?.length !== 1 ||
          c.sourceRects?.length !== 1 ||
          Reflect.ownKeys(c.sourceTokens[0]).some(
            (k) => !['text', 'rect', 'baseline', 'height'].includes(k)
          ) ||
          !fencedGroupExactRect(c.sourceRects[0], font.rect) ||
          !nativeChangedCellOrigins([c], items, [font], true)
        )
          return
        if (
          c.textRuns &&
          (!Array.isArray(c.textRuns) ||
            c.textRuns.length !== 1 ||
            !plain(c.textRuns[0]) ||
            Reflect.ownKeys(c.textRuns[0]).some((k) => !['text', 'position'].includes(k)) ||
            c.textRuns[0].text !== font.text ||
            c.textRuns[0].position !== 'normal')
        )
          return
      } else if (
        c.text !== '' ||
        c.sourceTokens?.length ||
        c.sourceRects?.length ||
        Reflect.ownKeys(c).some(
          (k) =>
            ![
              'row',
              'column',
              'rowSpan',
              'colSpan',
              'rect',
              'text',
              'sourceTokens',
              'sourceRects',
              'origin'
            ].includes(k)
        )
      )
        return
    }
    // Complete body owners bind each peer font to its one physical leaf. Title
    // source cannot already be claimed by a foreign/header/neighboring cell.
    if (
      table.cells.some(
        (c) =>
          !donors.includes(c) &&
          ((c.sourceItems ?? []).some(
            (o) => o.pageNumber === font.sourceItem.pageNumber && o.index === font.sourceItem.index
          ) ||
            c.sourceTokens?.some(
              (t) =>
                t.text === font.text &&
                t.baseline === font.baseline &&
                fencedGroupExactRect(t.rect, font.rect)
            ))
      )
    )
      return
    for (const peer of peers) {
      const owners = peer.fonts.map((i) =>
        table.cells.filter(
          (c) =>
            c.row !== row &&
            c.sourceTokens?.some(
              (t) =>
                t.text === i.text &&
                t.baseline === i.baseline &&
                t.height === i.height &&
                fencedGroupExactRect(t.rect, i.rect)
            )
        )
      )
      if (
        owners.some((o) => o.length !== 1) ||
        new Set(owners.map((o) => o[0].column)).size !== count ||
        new Set(owners.map((o) => o[0].row)).size !== 1 ||
        owners.some(
          (o, index) =>
            o[0].rowSpan !== 1 ||
            o[0].colSpan !== 1 ||
            o[0].sourceTokens.length !== 1 ||
            o[0].text !== peer.fonts[index].text ||
            !nativeChangedCellOrigins([o[0]], items, [peer.fonts[index]], true)
        )
      )
        return
    }
    const matches = (table.unassigned ?? []).filter((t) => t === font.text)
    if ((!populated.length && matches.length !== 1) || (populated.length && matches.length)) return
    replacements.push({
      row,
      donors,
      donor,
      font,
      rect: [crop[0], Math.min(band.top, font.rect[1]), crop[2], band.bottom],
      unassigned: !populated.length
    })
  }
  if (!replacements.length) return
  let out
  try {
    out = structuredClone(table)
  } catch {
    return
  }
  if (!fencedGroupOpaqueEqual(out, table)) return
  for (const r of replacements) {
    const indexes = r.donors.map((c) => table.cells.indexOf(c)),
      first = Math.min(...indexes),
      cell = {
        ...structuredClone(r.donor),
        row: r.row,
        column: 0,
        rowSpan: 1,
        colSpan: count,
        rect: r.rect,
        text: r.font.text,
        sourceTokens: [
          { text: r.font.text, rect: r.font.rect, baseline: r.font.baseline, height: r.font.height }
        ],
        sourceRects: [r.font.rect],
        ...nativeChangedCellOrigins(r.unassigned ? [] : [r.donor], items, [r.font], true)
      }
    out.cells = out.cells.flatMap((c) => (c.row === r.row ? [] : [c]))
    const insertion =
      table.cells.slice(0, first).filter((c) => !replacements.some((p) => p.donors.includes(c)))
        .length + replacements.filter((p) => p.row < r.row).length
    out.cells.splice(insertion, 0, cell)
    out.grid[r.row] = Array.from({ length: count }, (_, c) => (c ? '' : r.font.text))
    if (r.unassigned) out.unassigned = out.unassigned.filter((t) => t !== r.font.text)
  }
  const reconciliation = Object.getOwnPropertyDescriptor(
    table.unassigned ?? [],
    'reconciliationItems'
  )
  if (reconciliation)
    Object.defineProperty(out.unassigned, 'reconciliationItems', {
      ...reconciliation,
      value: reconciliation.value.filter(
        (i) => !replacements.some((r) => r.unassigned && r.font === i)
      )
    })
  return out
}

// Two closed three-record scopes can establish a centered label without an
// already-correct donor span. A whole peer may begin slightly left of its
// header; bind the actual peer start only after complete original pen/paint
// closure, then reuse the existing source, gutter, row and ownership proof.
function recoverCompleteCenteredGroupLabels(
  table,
  items,
  captions,
  rules,
  paint,
  graphics,
  context
) {
  const columns = table?.grid?.[0]?.length,
    scale = context.viewport?.scale
  if (
    table?.readingRotation ||
    table?.grid?.length !== 7 ||
    !Number.isInteger(table.page) ||
    !(columns >= 3 && columns <= 16) ||
    !Array.isArray(table.cells) ||
    table.cells.length !== 7 * columns ||
    !table.sourceViewport ||
    table.sourceViewport.scale !== scale ||
    table.sourceViewport.width !== context.viewport?.width ||
    table.sourceViewport.height !== context.viewport?.height ||
    ['notes', 'parts', 'unassigned', 'clipped', 'issues'].some(
      (k) => Object.hasOwn(table, k) && (!Array.isArray(table[k]) || table[k].length)
    ) ||
    table.cells.some(
      (c) =>
        c.rowSpan !== 1 ||
        c.colSpan !== 1 ||
        !Array.isArray(c.sourceTokens) ||
        c.sourceTokens.length > 1 ||
        Reflect.ownKeys(c).some(
          (k) =>
            typeof k !== 'string' ||
            !Object.getOwnPropertyDescriptor(c, k)?.enumerable ||
            !Object.hasOwn(Object.getOwnPropertyDescriptor(c, k), 'value')
        )
    ) ||
    Reflect.ownKeys(table).some(
      (k) =>
        typeof k !== 'string' ||
        !Object.getOwnPropertyDescriptor(table, k)?.enumerable ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(table, k), 'value')
    )
  )
    return
  const frame = nativeHeaderFrame(table, items, rules)
  if (!frame) return
  const { opening, closing, source } = frame,
    bounds = [opening[0], opening[1], opening[2], closing[1]],
    title = table.caption,
    candidates = captions.filter(
      (c) =>
        c.page === table.page &&
        captionKind(c.lines?.[0]) === 'table' &&
        c.rect?.every(Number.isFinite) &&
        c.rect[0] < bounds[2] &&
        c.rect[2] > bounds[0] &&
        c.rect[3] < bounds[1] &&
        bounds[1] - c.rect[3] < frame.h * 8
    )
  if (
    candidates.length !== 1 ||
    !title ||
    title.page !== table.page ||
    !fencedGroupOpaqueEqual(title.lines, candidates[0].lines) ||
    !title.rect?.every((v, n) => Math.abs(v * scale - candidates[0].rect[n]) < 0.02)
  )
    return
  const caption = candidates[0],
    captionFonts = items.filter(
      (i) => i.text?.trim() && fencedGroupIntersects(i.rect, caption.rect)
    )
  if (
    !captionFonts.length ||
    captionFonts.some((i) =>
      i.rect.some((v, n) => (n < 2 ? v < caption.rect[n] - 0.02 : v > caption.rect[n] + 0.02))
    ) ||
    captionFonts
      .map((i) => i.text)
      .join('')
      .replace(/\s/gu, '') !== caption.lines.join('').replace(/\s/gu, '') ||
    !proveNativeCompleteRuledSourcePacket(
      [...source, ...captionFonts],
      rules,
      { ...context, rulePaintBounds: paint, nativeEvidenceGraphics: graphics },
      bounds
    )
  )
    return
  const proof = fencedSingleLineStubOwners(table, items, captions, rules, true)
  if (
    proof?.replacements.length !== 2 ||
    proof.replacements.some(
      (r) =>
        r.rowSpan !== 3 ||
        r.donors.length !== 3 ||
        r.sourceTokens.length !== 1 ||
        !/\p{L}/u.test(r.sourceTokens[0].text) ||
        r.donors.find((c) => c.sourceTokens.length)?.row !== r.row + 1 ||
        Math.abs(
          r.sourceTokens[0].baseline -
            table.cells.find((c) => c.row === r.row + 1 && c.column === 1)?.sourceTokens[0]
              ?.baseline
        ) > 0.02 ||
        r.donors
          .filter((c) => !c.sourceTokens.length)
          .some(
            (c) =>
              c.text !== '' ||
              Reflect.ownKeys(c).some(
                (k) =>
                  ![
                    'row',
                    'column',
                    'rowSpan',
                    'colSpan',
                    'rect',
                    'text',
                    'sourceTokens',
                    'sourceRects',
                    'origin'
                  ].includes(k)
              )
          )
    )
  )
    return
  let cloned
  try {
    cloned = structuredClone(table)
  } catch {
    return
  }
  if (!fencedGroupOpaqueEqual(cloned, table)) return
  return projectNativeExistingFencedGroupOwners(table, {
    replacements: proof.replacements.map((r) => ({
      ...r,
      column: 0,
      text: r.sourceTokens[0].text,
      sourceRects: r.sourceTokens.map((i) => i.rect)
    }))
  })
}

// Complete field owners and closed rules qualify first-baseline literal group
// labels independently of multiline headers or an existing detector span.
function recoverCompleteFirstBaselineGroupLabels(
  table,
  items,
  captions,
  rules,
  paint,
  graphics,
  context
) {
  const plainData = (value) =>
    value &&
    typeof value === 'object' &&
    Reflect.ownKeys(value).every((k) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, k)
      return typeof k === 'string' && descriptor?.enumerable && Object.hasOwn(descriptor, 'value')
    })
  if (!plainData(table) || !Array.isArray(table.cells) || table.cells.some((c) => !plainData(c)))
    return
  if (
    !context ||
    table?.readingRotation ||
    !Array.isArray(table.grid) ||
    table.grid.length < 5 ||
    table.grid.length > 33 ||
    !Array.isArray(table.grid[0]) ||
    table.grid[0].length < 3 ||
    table.grid[0].length > 16 ||
    table.grid.some((r) => !Array.isArray(r) || r.some((t) => typeof t !== 'string')) ||
    !Number.isInteger(table.page) ||
    !table.sourceViewport ||
    table.sourceViewport.scale !== context.viewport?.scale ||
    table.sourceViewport.width !== context.viewport?.width ||
    table.sourceViewport.height !== context.viewport?.height ||
    !Array.isArray(table.cells) ||
    table.grid.some((r) => r.length !== table.grid[0].length) ||
    table.cells.length !== table.grid.length * table.grid[0].length ||
    ['parts', 'unassigned', 'clipped', 'issues'].some((k) => table[k]?.length) ||
    table.cells.some((c) => c.rowSpan !== 1 || c.colSpan !== 1)
  )
    return
  const frame = nativeHeaderFrame(table, items, rules)
  if (!frame) return
  const { h, opening, divider, closing, source, header, body } = frame,
    bounds = [opening[0], opening[1], opening[2], closing[1]]
  const fences = joinHorizontalTableRules(rules, 0.01, 0).filter(
    (r) =>
      r[1] >= opening[1] &&
      r[1] <= closing[1] &&
      Math.abs(r[0] - opening[0]) < 0.02 &&
      Math.abs(r[2] - opening[2]) < 0.02
  )
  if (
    source.some(
      (i) =>
        !fencedGroupValidRect(i.rect) ||
        i.rect[0] < bounds[0] - 0.02 ||
        i.rect[2] > bounds[2] + 0.02 ||
        i.rect[1] <= bounds[1] ||
        i.rect[3] >= bounds[3] ||
        fences.some((r) => i.rect[1] < r[1] && i.rect[3] > r[1])
    )
  )
    return
  if (
    fences.length < 4 ||
    fences.length > 6 ||
    !sameRect(fences[1], divider) ||
    !sameRect(fences.at(-1), closing) ||
    fences.some((r, n) => n && r[1] - fences[n - 1][1] < h)
  )
    return
  if (
    rules.some(
      (r) =>
        Math.max(r[1], r[3]) > opening[1] &&
        Math.min(r[1], r[3]) < closing[1] &&
        r[0] > opening[0] &&
        r[2] < opening[2]
    )
  )
    return
  const title = table.caption,
    scale = context.viewport?.scale,
    candidates = captions.filter(
      (c) =>
        c.page === table.page &&
        captionKind(c.lines?.[0]) === 'table' &&
        fencedGroupValidRect(c.rect) &&
        c.rect[0] < bounds[2] &&
        c.rect[2] > bounds[0] &&
        c.rect[3] < bounds[1] &&
        bounds[1] - c.rect[3] < h * 8
    )
  if (
    candidates.length !== 1 ||
    !title ||
    title.page !== table.page ||
    !fencedGroupOpaqueEqual(title.lines, candidates[0].lines) ||
    !title.rect?.every((v, n) => Math.abs(v * scale - candidates[0].rect[n]) < 0.02)
  )
    return
  const caption = candidates[0],
    captionFonts = items.filter(
      (i) => i.text?.trim() && fencedGroupIntersects(i.rect, caption.rect)
    )
  if (
    !captionFonts.length ||
    captionFonts.some((i) =>
      i.rect.some((v, n) => (n < 2 ? v < caption.rect[n] - 0.02 : v > caption.rect[n] + 0.02))
    ) ||
    captionFonts
      .map((i) => i.text)
      .join('')
      .replace(/\s/gu, '') !== caption.lines.join('').replace(/\s/gu, '') ||
    !proveNativeCompleteRuledSourcePacket(
      [...source, ...captionFonts],
      rules,
      { ...context, rulePaintBounds: paint, nativeEvidenceGraphics: graphics },
      bounds
    )
  )
    return
  const owned = new Map(),
    seen = new Set(),
    slots = new Set(),
    heads = table.cells.filter((c) => c.row === 0).sort((a, b) => a.column - b.column),
    count = table.grid[0].length
  if (
    heads.length !== count ||
    heads.some((c, n) => c.column !== n) ||
    physicalRows(
      header.filter((i) => Math.abs(i.height - h) < 0.02),
      h
    ).length !== 2
  )
    return
  const cuts = [heads[0].rect[0], ...heads.map((c) => c.rect[2])]
  if (heads.some((c, n) => n && Math.abs(c.rect[0] - cuts[n]) > 0.02)) return
  for (const c of table.cells) {
    if (
      !Number.isInteger(c.row) ||
      !Number.isInteger(c.column) ||
      c.row < 0 ||
      c.row >= table.grid.length ||
      c.column < 0 ||
      c.column >= count ||
      slots.has(c.row + ':' + c.column) ||
      !fencedGroupValidRect(c.rect) ||
      table.grid[c.row][c.column] !== c.text ||
      (c.sourceTokens?.length && !Array.isArray(c.sourceItems)) ||
      c.text.replace(/\s/gu, '') !==
        c.sourceTokens
          ?.map((t) => t.text)
          .join('')
          .replace(/\s/gu, '') ||
      !Array.isArray(c.sourceTokens) ||
      !Array.isArray(c.sourceRects) ||
      c.sourceTokens.length !== c.sourceRects.length ||
      (c.textRuns && c.textRuns.map((r) => r.text).join('') !== c.text) ||
      !nativeChangedCellOrigins([c], items, c.sourceTokens)
    )
      return
    slots.add(c.row + ':' + c.column)
    const fonts = []
    for (const t of c.sourceTokens) {
      const matches = source.filter(
        (i) =>
          i.text === t.text &&
          sameRect(i.rect, t.rect) &&
          Math.abs(i.baseline - t.baseline) < 0.02 &&
          Math.abs(i.height - t.height) < 0.02
      )
      if (
        matches.length !== 1 ||
        seen.has(matches[0]) ||
        !c.sourceRects.some((r) => sameRect(r, t.rect)) ||
        t.rect[0] < cuts[c.column] ||
        t.rect[2] > cuts[c.column + 1]
      )
        return
      fonts.push(matches[0])
      seen.add(matches[0])
    }
    if (c.sourceRects.some((r) => c.sourceTokens.filter((t) => sameRect(t.rect, r)).length !== 1))
      return
    owned.set(c, fonts)
  }
  if (
    seen.size !== source.length ||
    heads.flatMap((c) => owned.get(c)).length !== header.length ||
    heads.some((c) => owned.get(c).some((i) => !header.includes(i)))
  )
    return
  const domains = heads.map((head) =>
    box(table.cells.filter((c) => c.column === head.column).flatMap((c) => owned.get(c)))
  )
  if (domains.slice(1).some((d, n) => d[0] - domains[n][2] < h * 0.15)) return
  const recordCells = [],
    bases = [],
    scriptColumns = new Set()
  for (let row = 1; row < table.grid.length; row++) {
    const cells = table.cells.filter((c) => c.row === row).sort((a, b) => a.column - b.column),
      normal = []
    for (const c of cells.slice(1)) {
      const fonts = owned.get(c),
        base = fonts.filter((i) => Math.abs(i.height - h) < 0.02),
        small = fonts.filter((i) => Math.abs(i.height - h) >= 0.02)
      if (
        base.length !== 1 ||
        !/^[-+−]?\d+(?:\.\d+)?$/u.test(base[0].text) ||
        small.length > 1 ||
        small.some(
          (i) =>
            !(i.height < h * 0.8 && i.height > h * 0.6) ||
            [...i.text].length !== 1 ||
            /[\p{L}\p{N}]/u.test(i.text) ||
            !isAdjacentTableScript(i, base[0]) ||
            Math.abs(i.baseline - base[0].baseline) > h * 0.7
        )
      )
        return
      if (small.length) {
        scriptColumns.add(c.column)
        if (
          !c.textRuns ||
          c.textRuns.length !== 2 ||
          c.textRuns[0].text !== base[0].text ||
          c.textRuns[0].position !== 'normal' ||
          c.textRuns[1].text !== small[0].text ||
          c.textRuns[1].position !== 'superscript'
        )
          return
      } else if (c.text !== base[0].text || c.textRuns?.some((r) => r.position !== 'normal')) return
      normal.push(base[0])
    }
    if (
      normal.length !== count - 1 ||
      normal.some((i) => Math.abs(i.baseline - normal[0].baseline) > 0.02) ||
      (row > 1 && normal[0].baseline - bases.at(-1) < h * 0.7)
    )
      return
    recordCells.push(cells)
    bases.push(normal[0].baseline)
  }
  if (scriptColumns.size !== 1) return
  const replacements = [],
    donorsAllowed = [
      'row',
      'column',
      'rowSpan',
      'colSpan',
      'rect',
      'text',
      'sourceTokens',
      'sourceRects',
      'origin'
    ]
  let next = 1
  for (let n = 1; n < fences.length - 1; n++) {
    const top = fences[n][1],
      bottom = fences[n + 1][1],
      group = recordCells.filter((cs) =>
        owned.get(cs[1]).every((i) => i.rect[1] > top && i.rect[3] < bottom)
      ),
      native = body.filter((i) => i.rect[1] > top && i.rect[3] < bottom),
      donors = group.map((cs) => cs[0]),
      labels = donors.flatMap((c) => owned.get(c))
    if (
      group.length < 2 ||
      group.length > 8 ||
      group.some(
        (cs, k) =>
          cs[0].row !== next + k ||
          cs.slice(1).some((c) => owned.get(c).some((i) => !native.includes(i)))
      ) ||
      labels.length !== 1 ||
      labels[0].height !== h ||
      !/[\p{L}]/u.test(labels[0].text) ||
      Math.abs(labels[0].baseline - bases[next - 1]) > 0.02 ||
      owned.get(donors[0])[0] !== labels[0] ||
      native.length !== group.flatMap((cs) => cs.flatMap((c) => owned.get(c))).length
    )
      return
    for (const c of donors.slice(1))
      if (
        c.text !== '' ||
        c.sourceTokens.length ||
        c.sourceRects.length ||
        Reflect.ownKeys(c).some((k) => !donorsAllowed.includes(k))
      )
        return
    const original = donors[0],
      rect = box(donors)
    if (
      original.textRuns &&
      (original.textRuns.length !== 1 ||
        original.textRuns[0].text !== original.text ||
        original.textRuns[0].position !== 'normal' ||
        !plainData(original.textRuns[0]) ||
        Reflect.ownKeys(original.textRuns[0]).some((k) => !['text', 'position'].includes(k)))
    )
      return
    if (
      !fencedGroupContains(labels[0].rect, rect) ||
      labels[0].rect[2] >= Math.min(...group.map((cs) => owned.get(cs[1])[0].rect[0]))
    )
      return
    replacements.push({
      row: next,
      column: 0,
      rowSpan: group.length,
      donors,
      rect,
      text: original.text,
      sourceTokens: original.sourceTokens,
      sourceRects: original.sourceRects
    })
    next += group.length
  }
  if (
    next !== table.grid.length ||
    body.some((i) => fences.some((r) => i.rect[1] < r[1] && i.rect[3] > r[1]))
  )
    return
  try {
    const cloned = structuredClone(table)
    if (!fencedGroupOpaqueEqual(cloned, table)) return
    return projectNativeExistingFencedGroupOwners(table, { replacements })
  } catch {
    return
  }
}

// A short first model band can strand simultaneous prose continuations. Bind
// every whole font and the complete raw page before appending any owner; the
// independent six-field records, not a lexical parameter name, bound the tail.
export function recoverNativeFirstRecordContinuations(table, items, captions, rules, context) {
  if (
    !context ||
    table.readingRotation ||
    !Array.isArray(table.grid) ||
    table.grid.length < 4 ||
    table.grid.length > 12 ||
    table.grid.some(
      (r) => !Array.isArray(r) || r.length !== 6 || r.some((t) => typeof t !== 'string')
    ) ||
    !Array.isArray(table.cells) ||
    table.cells.length !== table.grid.length * 6 ||
    table.unassigned?.length !== 3 ||
    table.notes?.length ||
    table.clipped?.length ||
    table.parts?.length ||
    new Set(table.cells.map((c) => `${c.row}:${c.column}`)).size !== table.cells.length ||
    table.cells.some(
      (c) =>
        !Number.isInteger(c.row) ||
        c.row < 0 ||
        c.row >= table.grid.length ||
        !Number.isInteger(c.column) ||
        c.column < 0 ||
        c.column >= 6 ||
        typeof c.text !== 'string' ||
        c.rowSpan !== 1 ||
        c.colSpan !== 1 ||
        !fencedGroupValidRect(c.rect) ||
        !Array.isArray(c.sourceTokens) ||
        !c.sourceTokens.length ||
        !Array.isArray(c.sourceRects)
    )
  )
    return
  const frame = nativeHeaderFrame(table, items, rules)
  if (!frame || frame.header.length !== 6) return
  const { opening, divider, closing, source, h } = frame,
    bounds = [opening[0], opening[1], closing[2], closing[1]],
    p = Number(/^page-(\d+)-/.exec(table.id ?? '')?.[1]),
    titles = captions.filter(
      (c) =>
        c.page === p &&
        captionKind(c.lines?.[0]) === 'table' &&
        c.rect?.every(Number.isFinite) &&
        c.rect[0] < bounds[2] &&
        c.rect[2] > bounds[0] &&
        c.rect[3] < opening[1] &&
        opening[1] - c.rect[3] < h * 4
    ),
    edges = rules.filter(
      (r) =>
        r[1] === r[3] &&
        r[0] < bounds[2] &&
        r[2] > bounds[0] &&
        r[1] >= opening[1] &&
        r[1] <= closing[1]
    )
  if (
    titles.length !== 1 ||
    edges.length !== 3 ||
    edges.some((r) => Math.abs(r[0] - opening[0]) > 0.02 || Math.abs(r[2] - opening[2]) > 0.02) ||
    source.some(
      (i) =>
        i.rect.some((v, n) => (n < 2 ? v < bounds[n] - 0.02 : v > bounds[n] + 0.02)) ||
        edges.some((r) => i.rect[1] < r[1] && i.rect[3] > r[1])
    )
  )
    return
  const title = titles[0],
    captionFonts = items.filter((i) => i.text?.trim() && fencedGroupIntersects(i.rect, title.rect))
  if (
    !captionFonts.length ||
    captionFonts.some((i) =>
      i.rect.some((v, n) => (n < 2 ? v < title.rect[n] - 0.02 : v > title.rect[n] + 0.02))
    ) ||
    captionFonts
      .map((i) => i.text)
      .join('')
      .replace(/\s/gu, '') !== title.lines.join('').replace(/\s/gu, '') ||
    !proveNativeCompleteRuledSourcePacket([...source, ...captionFonts], rules, context, bounds)
  )
    return
  const owned = new Set(),
    fonts = new Map(),
    at = (row, column) => table.cells.find((c) => c.row === row && c.column === column)
  for (const cell of table.cells) {
    const fs = cell.sourceTokens.map((token) => {
      const owner = token.sourceToken ?? token
      if (
        owner.sourceToken ||
        owner.text !== token.text ||
        owner.baseline !== token.baseline ||
        owner.height !== token.height ||
        !sameRect(owner.rect, token.rect)
      )
        return []
      return source.filter(
        (i) =>
          token.text === i.text &&
          token.baseline === i.baseline &&
          token.height === i.height &&
          sameRect(token.rect, i.rect) &&
          (!token.sourceItem || fencedGroupOpaqueEqual(token.sourceItem, i.sourceItem)) &&
          (!owner.sourceItem || fencedGroupOpaqueEqual(owner.sourceItem, i.sourceItem))
      )
    })
    if (
      fs.some((matches) => matches.length !== 1 || owned.has(matches[0])) ||
      new Set(fs.flat()).size !== fs.length ||
      !nativeCellOriginsMatch(cell, fs.flat()) ||
      cell.text.replace(/\s/gu, '') !==
        fs
          .flat()
          .map((i) => i.text)
          .join('')
          .replace(/\s/gu, '') ||
      !fencedGroupOpaqueEqual(
        cell.sourceRects,
        fs.flat().map((i) => i.rect)
      )
    )
      return
    fs.flat().forEach((i) => owned.add(i))
    fonts.set(cell, fs.flat())
  }
  const tails = source.filter((i) => !owned.has(i)),
    column = (i) =>
      [0, 1, 2, 3, 4, 5].filter((c) => {
        const head = at(0, c)
        return head && i.rect[0] >= head.rect[0] && i.rect[2] <= head.rect[2]
      })
  if (
    tails.length !== 3 ||
    new Set(tails.map((i) => i.text)).size !== 3 ||
    tails.some(
      (i) =>
        !table.unassigned.includes(i.text) ||
        column(i).length !== 1 ||
        !/\p{L}{2}/u.test(i.text) ||
        Math.abs(i.height - h) > h * 0.04
    ) ||
    new Set(tails.map((i) => column(i)[0])).size !== 3 ||
    tails.some((i) => column(i)[0] === 0)
  )
    return
  const baselines = [],
    records = []
  for (let row = 1; row < table.grid.length; row++) {
    const stub = fonts.get(at(row, 0)),
      normal = stub?.filter((i) => Math.abs(i.height - h) < h * 0.04)
    if (
      normal?.length !== 1 ||
      stub.length > 2 ||
      stub.some((i) => i !== normal[0] && !isAdjacentTableScript(i, normal[0]))
    )
      return
    const b = normal[0].baseline,
      record = []
    for (let c = 0; c < 6; c++) {
      const cell = at(row, c),
        fs = fonts.get(cell)
      if (
        !cell ||
        !fs?.length ||
        fs.some((i) => column(i)[0] !== c || column(i).length !== 1) ||
        (c && !fs.some((i) => Math.abs(i.baseline - b) < 0.02 && Math.abs(i.height - h) < h * 0.04))
      )
        return
      record.push(...fs)
    }
    baselines.push(b)
    records.push(row === 1 ? [...record, ...tails] : record)
  }
  if (
    baselines[0] <= divider[1] ||
    tails.some(
      (i) =>
        Math.abs(i.baseline - tails[0].baseline) > 0.02 ||
        i.baseline - baselines[0] < h * 0.9 ||
        i.baseline - baselines[0] > h * 1.6
    ) ||
    records.slice(1).some((r, n) => box(records[n])[3] >= box(r)[1]) ||
    !tails.some((i) => at(1, column(i)[0]).text.endsWith('-')) ||
    tails.some((i) => {
      const fs = fonts.get(at(1, column(i)[0]))
      return (
        fs.length !== 1 ||
        Math.abs(i.rect[0] - fs[0].rect[0]) > h * 0.2 ||
        i.rect[3] <= at(1, column(i)[0]).rect[3]
      )
    })
  )
    return
  // Preflight opaque payloads before changing any cell, grid or diagnostic.
  try {
    if (!fencedGroupOpaqueEqual(structuredClone(table), table)) return
  } catch {
    return
  }
  const replacements = []
  for (const tail of tails) {
    const cell = at(1, column(tail)[0]),
      sourceTokens = [...fonts.get(cell), tail],
      origins = nativeChangedCellOrigins([cell], items, sourceTokens, true)
    if (
      !origins ||
      cell.sourceTokens.some((t) =>
        Reflect.ownKeys(t).some(
          (k) =>
            ![
              'text',
              'rect',
              'height',
              'baseline',
              'horizontal',
              'sourceItem',
              'inlineSymbol',
              'sourceToken'
            ].includes(k)
        )
      ) ||
      (cell.textRuns &&
        (cell.textRuns.length !== 1 ||
          cell.textRuns[0].position !== 'normal' ||
          cell.textRuns[0].text !== cell.text ||
          Reflect.ownKeys(cell.textRuns[0]).some((k) => !['text', 'position'].includes(k))))
    )
      return
    const text = cell.text + (cell.text.endsWith('-') ? '' : ' ') + tail.text,
      replacement = {
        ...cell,
        ...origins,
        text,
        rect: [cell.rect[0], cell.rect[1], cell.rect[2], tail.rect[3]],
        sourceTokens,
        sourceRects: sourceTokens.map((i) => i.rect)
      }
    if (cell.textRuns) replacement.textRuns = [{ text, position: 'normal' }]
    replacements.push({ cell, replacement })
  }
  return { replacements }
}

// A complete native parent and its two children can share a printed header
// with four peers spanning both bands. Only this calibrated closed family
// repairs partial header ownership; existing body owners remain whole.
export function recoverNativePairedPrintedHeaderOwners(
  table,
  items,
  captions,
  rules,
  runs,
  refined,
  notes = []
) {
  if (!Array.isArray(notes) || notes.length) return
  const tolerance = 1e-5
  const sameRect = (a, b) =>
    Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === 4 &&
    b.length === 4 &&
    a.every(Number.isFinite) &&
    b.every(Number.isFinite) &&
    a.every((v, k) => Math.abs(v - b[k]) < tolerance)
  const box = (fonts) => [
    Math.min(...fonts.map((f) => f.rect[0])),
    Math.min(...fonts.map((f) => f.rect[1])),
    Math.max(...fonts.map((f) => f.rect[2])),
    Math.max(...fonts.map((f) => f.rect[3]))
  ]
  const meaningful = (item) => item && typeof item.text === 'string' && item.text.trim()
  const finiteRect = (rect) =>
    Array.isArray(rect) &&
    rect.length === 4 &&
    rect.every(Number.isFinite) &&
    rect[2] > rect[0] &&
    rect[3] > rect[1]
  const same = (a, b) => Math.abs(a - b) < tolerance
  const matchesProgram = (font, runs) => {
    const matches = runs.filter(
      (r) =>
        r &&
        r.text === font.text &&
        Array.isArray(r.rect) &&
        r.rect.length === 4 &&
        sameRect(r.rect, font.rect)
    )
    return (
      matches.length === 1 &&
      Number.isFinite(matches[0].height) &&
      Number.isFinite(matches[0].baseline) &&
      same(matches[0].height, font.height) &&
      same(matches[0].baseline, font.baseline) &&
      Array.isArray(matches[0].literalGlyphs) &&
      matches[0].literalGlyphs.every((g) => typeof g === 'string' && [...g].length > 0) &&
      matches[0].literalGlyphs.reduce((n, g) => n + [...g].length, 0) ===
        [...font.text.replace(/\s/gu, '')].length &&
      matches[0].literalGlyphs.join('') === font.text.replace(/\s/gu, '') &&
      Array.isArray(matches[0].glyphRuns) &&
      matches[0].glyphRuns.length ===
        matches[0].literalGlyphs.reduce((count, packet) => count + [...packet].length, 0) &&
      matches[0].glyphRuns.every((g) => Number.isInteger(g) && g >= 0) &&
      new Set(matches[0].glyphRuns).size === 1
    )
  }
  const refusal = (firstRefusal) => ({ qualified: false, firstRefusal })
  // An absent or explicitly undefined optional field preserves the existing contract.
  // A present null is unknown evidence, not an absent note/rotation/part.
  const definedOwn = (object, key) =>
    object && Object.hasOwn(object, key) && object[key] !== undefined
  const unsupportedOwn = (object, keys) =>
    Reflect.ownKeys(object).some((key) => typeof key !== 'string' || !keys.includes(key))
  const knownCellKeys = [
    'row',
    'column',
    'rowSpan',
    'colSpan',
    'rect',
    'origin',
    'text',
    'textRuns',
    'sourceTokens',
    'sourceRects'
  ]
  const knownTokenKeys = ['text', 'rect', 'baseline', 'height']
  const knownRunKeys = ['text', 'position']

  function qualifyPairedNativeHeader(table, items, captions, rules, runs, cells, refinedContext) {
    if (
      !refinedContext ||
      !finiteRect(refinedContext.cropRect) ||
      !sameRect(refinedContext.cropRect, table?.cropRect) ||
      refinedContext.cells !== cells ||
      !Array.isArray(refinedContext.grid) ||
      !refinedContext.grid.length ||
      refinedContext.grid.some(
        (row) =>
          !Array.isArray(row) || row.length !== 6 || row.some((text) => typeof text !== 'string')
      ) ||
      !Array.isArray(refinedContext.rows) ||
      refinedContext.rows.length !== refinedContext.grid.length ||
      refinedContext.rows.some((row) => !row || !finiteRect(row.rect)) ||
      ['unassigned', 'issues', 'repairs', 'excludedCaptionItems'].some(
        (key) =>
          !Array.isArray(refinedContext[key]) ||
          refinedContext[key].some((value) => typeof value !== 'string')
      ) ||
      !Array.isArray(refinedContext.clipped) ||
      refinedContext.clipped.length ||
      [table, refinedContext].some(
        (context) =>
          definedOwn(context, 'notes') && (!Array.isArray(context.notes) || context.notes.length)
      ) ||
      definedOwn(refinedContext, 'parts') ||
      definedOwn(table, 'parts') ||
      (definedOwn(table, 'readingRotation') && table.readingRotation !== 0) ||
      (definedOwn(refinedContext, 'readingRotation') && refinedContext.readingRotation !== 0) ||
      (definedOwn(refinedContext, 'reviewCandidate') &&
        typeof refinedContext.reviewCandidate !== 'boolean')
    )
      return refusal('complete-current-refined-context')
    if (refinedContext.issues.some((issue) => issue !== 'unassigned-source-text'))
      return refusal('unrelated-existing-diagnostic')
    if (
      !table ||
      !finiteRect(table.cropRect) ||
      !Array.isArray(items) ||
      !Array.isArray(captions) ||
      !Array.isArray(rules) ||
      !Array.isArray(runs) ||
      !Array.isArray(cells) ||
      items.some((i) => !i || typeof i.text !== 'string') ||
      cells.some(
        (c) =>
          !c ||
          typeof c.text !== 'string' ||
          !finiteRect(c.rect) ||
          !Array.isArray(c.sourceRects) ||
          c.sourceRects.some((r) => !finiteRect(r))
      )
    )
      return refusal('parameter-contract')
    if (
      rules.some(
        (r) =>
          !Array.isArray(r) ||
          r.length !== 4 ||
          !r.every(Number.isFinite) ||
          r[0] > r[2] ||
          r[1] > r[3]
      ) ||
      captions.some(
        (c) =>
          !c ||
          !Array.isArray(c.lines) ||
          !c.lines.length ||
          c.lines.some((line) => typeof line !== 'string') ||
          !finiteRect(c.rect)
      ) ||
      cells.some(
        (c) =>
          !Array.isArray(c.sourceTokens) ||
          c.sourceTokens.some(
            (token) => !token || typeof token.text !== 'string' || !finiteRect(token.rect)
          )
      )
    )
      return refusal('unknown-rule-caption-or-donor-program')
    if (
      refinedContext.grid.length !== 5 ||
      cells.length !== 30 ||
      new Set(cells.map((cell) => `${cell.row}:${cell.column}`)).size !== cells.length ||
      cells.some(
        (cell) =>
          !Number.isInteger(cell.row) ||
          !Number.isInteger(cell.column) ||
          cell.row < 0 ||
          cell.row >= 5 ||
          cell.column < 0 ||
          cell.column >= 6 ||
          cell.rowSpan !== 1 ||
          cell.colSpan !== 1 ||
          refinedContext.grid[cell.row][cell.column] !== cell.text ||
          cell.sourceRects.length !== cell.sourceTokens.length ||
          cell.sourceTokens.some(
            (token, index) =>
              !sameRect(token.rect, cell.sourceRects[index]) ||
              !Number.isFinite(token.height) ||
              !Number.isFinite(token.baseline) ||
              Math.abs(token.height - (token.rect[3] - token.rect[1])) > tolerance ||
              !same(token.baseline, token.rect[3])
          )
      )
    )
      return refusal('complete-current-cell-contract')
    const rebuiltRight = cells.filter((cell) => cell.row === 0 && cell.column >= 2)
    if (
      rebuiltRight.some(
        (cell) =>
          unsupportedOwn(cell, knownCellKeys) ||
          cell.sourceTokens.some((token) => unsupportedOwn(token, knownTokenKeys)) ||
          (definedOwn(cell, 'textRuns') &&
            (!Array.isArray(cell.textRuns) ||
              cell.textRuns.some(
                (run) =>
                  !run ||
                  typeof run !== 'object' ||
                  unsupportedOwn(run, knownRunKeys) ||
                  typeof run.text !== 'string' ||
                  !['normal', 'subscript', 'superscript'].includes(run.position)
              )))
      ) ||
      unsupportedOwn(refinedContext.rows[0], ['rect', 'origin'])
    )
      return refusal('unsupported-rebuilt-header-context')
    if (
      items.some(
        (i) =>
          meaningful(i) &&
          (!finiteRect(i.rect) ||
            !Number.isFinite(i.height) ||
            i.height <= 0 ||
            !Number.isFinite(i.baseline) ||
            Math.abs(i.height - (i.rect[3] - i.rect[1])) > tolerance ||
            !same(i.baseline, i.rect[3]))
      )
    )
      return refusal('unknown-whole-font')
    const near = items.filter(
      (i) =>
        meaningful(i) &&
        i.horizontal &&
        i.rect[0] >= table.cropRect[0] - 1 &&
        i.rect[2] <= table.cropRect[2] + 1 &&
        i.baseline > table.cropRect[1] &&
        i.baseline < table.cropRect[3]
    )
    if (!near.length) return refusal('source-empty')
    const heights = near.map((f) => f.height).sort((a, b) => a - b),
      h = heights[Math.floor(heights.length / 2)]
    const frameRules = rules
      .filter(
        (r) =>
          Array.isArray(r) &&
          r.length === 4 &&
          r.every(Number.isFinite) &&
          same(r[1], r[3]) &&
          r[2] > r[0] &&
          Math.abs(r[0] - table.cropRect[0]) < h &&
          Math.abs(r[2] - table.cropRect[2]) < h &&
          r[1] > table.cropRect[1] &&
          r[1] < table.cropRect[3]
      )
      .sort((a, b) => a[1] - b[1])
    if (
      frameRules.length !== 3 ||
      frameRules.some((r) => !same(r[0], frameRules[0][0]) || !same(r[2], frameRules[0][2]))
    )
      return refusal('complete-same-end-frame')
    const [opening, divider, closing] = frameRules
    const source = items.filter(
      (i) =>
        meaningful(i) &&
        i.rect[2] > opening[0] &&
        i.rect[0] < opening[2] &&
        i.rect[3] > opening[1] &&
        i.rect[1] < closing[1]
    )
    if (
      source.some(
        (f) =>
          !f.horizontal ||
          f.rect[0] < opening[0] ||
          f.rect[2] > opening[2] ||
          f.rect[1] < opening[1] ||
          f.rect[3] > closing[1] ||
          !matchesProgram(f, runs)
      )
    )
      return refusal('complete-native-program-frame-ownership')
    if (new Set(source.map((f) => f.text + ':' + f.rect.join(':'))).size !== source.length)
      return refusal('unique-complete-fonts')
    const header = source.filter((f) => f.rect[3] < divider[1]),
      body = source.filter((f) => f.rect[1] > divider[1])
    if (header.length + body.length !== source.length) return refusal('divider-crossing-whole-font')
    const bodyBands = []
    for (const f of [...body].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
      let band = bodyBands.find((r) => same(r[0].baseline, f.baseline))
      if (!band) bodyBands.push((band = []))
      band.push(f)
    }
    if (
      bodyBands.length !== 4 ||
      bodyBands.some(
        (b) =>
          b.length !== 6 ||
          b.some((f) => !same(f.height, h)) ||
          !b.slice(0, 2).every((f) => /^[✓×]$/u.test(f.text)) ||
          !b.slice(2).every((f) => /^\d+(?:\.\d+)?$/u.test(f.text))
      )
    )
      return refusal('complete-binary-scalar-records')
    if (
      new Set(
        bodyBands.map((b) =>
          b
            .slice(0, 2)
            .map((f) => f.text)
            .join('')
        )
      ).size !== 4
    )
      return refusal('independent-binary-record-calibration')
    const headBands = []
    for (const f of header
      .filter((f) => same(f.height, h))
      .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
      let band = headBands.find((r) => same(r[0].baseline, f.baseline))
      if (!band) headBands.push((band = []))
      band.push(f)
    }
    if (
      headBands.length !== 3 ||
      headBands[0].length !== 1 ||
      headBands[1].length !== 11 ||
      headBands[2].length !== 6
    )
      return refusal('three-complete-header-role-bands')
    const [parentBand, middle, lower] = headBands
    const parent = parentBand[0]
    if (!/^\p{L}+(?:\s+\p{L}+)+$/u.test(parent.text)) return refusal('independent-parent-label')
    const headerWall = rules.filter(
      (r) =>
        Array.isArray(r) &&
        r.length === 4 &&
        r.every(Number.isFinite) &&
        same(r[0], r[2]) &&
        r[1] > opening[1] &&
        r[3] < divider[1] &&
        r[3] > r[1]
    )
    if (headerWall.length !== 1) return refusal('unique-native-parent-divider')
    const wall = headerWall[0][0]
    if (
      parent.rect[2] >= wall ||
      lower.some((f) => f.rect[2] >= wall) ||
      middle.some((f) => f.rect[0] <= wall)
    )
      return refusal('complete-left-right-header-domain')
    const children = lower.slice(0, 5),
      childLabel = lower[5],
      compared = middle.slice(0, 5),
      direction = middle.slice(5, 8),
      labels = middle.slice(8)
    const formulaLiteral = (program) =>
      program.length === 5 &&
      program[0].text === '|' &&
      /^\p{L}$/u.test(program[1].text) &&
      program[2].text === '−' &&
      /^\d+$/u.test(program[3].text) &&
      program[4].text === '|'
    if (
      !formulaLiteral(children) ||
      !formulaLiteral(compared) ||
      !children.every((f, i) => f.text === compared[i].text) ||
      !/^[\p{L}\s]+$/u.test(childLabel.text) ||
      !labels.every((f) => /^[\p{L}\s]+$/u.test(f.text)) ||
      direction.map((f) => f.text).join('') !== '(↓)'
    )
      return refusal('calibrated-literal-header-programs')
    const scripts = header.filter((f) => f.height < h * 0.85)
    if (
      scripts.length !== 2 ||
      scripts.some((f) => !/^\p{L}+$/u.test(f.text)) ||
      scripts[0].text !== scripts[1].text ||
      !same(scripts[0].height, scripts[1].height)
    )
      return refusal('two-calibrated-native-subscript-programs')
    const scriptOwnership = []
    for (const script of scripts) {
      const anchors = header.filter(
        (f) =>
          same(f.height, h) &&
          script.baseline > f.baseline &&
          script.baseline - f.baseline < h * 0.2 &&
          Math.abs(script.rect[0] - f.rect[2]) < h * 0.02
      )
      if (anchors.length !== 1 || ![children[1], compared[1]].includes(anchors[0]))
        return refusal('unique-parent-relative-script')
      scriptOwnership.push({ script, parent: anchors[0] })
    }
    const lowerScript = scriptOwnership.find((o) => o.parent === children[1])?.script
    const rightScript = scriptOwnership.find((o) => o.parent === compared[1])?.script
    if (
      !lowerScript ||
      !rightScript ||
      Math.abs(
        lowerScript.baseline - children[1].baseline - (rightScript.baseline - compared[1].baseline)
      ) >
        h * 0.001 ||
      lowerScript.rect[2] >= children[2].rect[0] ||
      rightScript.rect[2] >= compared[2].rect[0]
    )
      return refusal('complete-parent-relative-calibration')
    const fields = [
      [...children, lowerScript],
      [childLabel],
      [...compared, ...direction, rightScript],
      ...labels.map((f) => [f])
    ]
    const upperBottom = parent.rect[3],
      lowerTop = Math.min(
        ...fields
          .slice(0, 2)
          .flat()
          .map((f) => f.rect[1])
      )
    if (!(lowerTop > upperBottom)) return refusal('complete-upper-lower-font-gap')
    const splitY = (upperBottom + lowerTop) / 2
    if (fields.slice(2).some((g) => !(box(g)[1] < splitY && box(g)[3] > splitY)))
      return refusal('right-field-spans-both-source-bands')
    const domains = fields.map((fonts, col) => box([...fonts, ...bodyBands.map((row) => row[col])]))
    if (domains.slice(1).some((d, col) => d[0] - domains[col][2] <= h * 0.2))
      return refusal('all-complete-field-gutters')
    if (
      parent.rect[0] >= domains[0][2] ||
      parent.rect[2] <= domains[1][0] ||
      !(wall > domains[1][2] && wall < domains[2][0])
    )
      return refusal('native-parent-spans-exact-two-fields')
    const sourceHeaderOwned = [parent, ...fields.flat()]
    if (
      sourceHeaderOwned.length !== header.length ||
      new Set(sourceHeaderOwned).size !== header.length
    )
      return refusal('all-header-fonts-exactly-owned')
    const ownedBody = []
    for (const [row, band] of bodyBands.entries()) {
      for (const [col, font] of band.entries()) {
        const donors = cells.filter(
          (c) =>
            c &&
            c.row === row + 1 &&
            c.column === col &&
            c.rowSpan === 1 &&
            c.colSpan === 1 &&
            c.text === font.text &&
            c.sourceRects?.length === 1 &&
            sameRect(c.sourceRects[0], font.rect) &&
            Array.isArray(c.sourceTokens) &&
            c.sourceTokens.length === 1 &&
            c.sourceTokens[0].text === font.text &&
            Array.isArray(c.sourceTokens[0].rect) &&
            sameRect(c.sourceTokens[0].rect, font.rect) &&
            (!c.textRuns ||
              (Array.isArray(c.textRuns) && c.textRuns.every((r) => r && r.position === 'normal')))
        )
        if (donors.length !== 1) return refusal('whole-correct-body-donor')
        ownedBody.push(donors[0])
      }
    }
    const oldHeader = cells.filter((c) => c && c.row === 0)
    const childDonors = fields
      .slice(0, 2)
      .map((fonts, col) =>
        oldHeader.filter(
          (c) =>
            c.column === col &&
            c.rowSpan === 1 &&
            c.colSpan === 1 &&
            c.sourceRects?.length === fonts.length &&
            fonts.every((f) => c.sourceRects.filter((rect) => sameRect(rect, f.rect)).length === 1)
        )
      )
    if (childDonors.some((g) => g.length !== 1))
      return refusal('complete-two-existing-child-donors')
    const caps = captions.filter(
      (c) =>
        c &&
        Array.isArray(c.lines) &&
        c.lines.length >= 1 &&
        /^Table\s+\d+[.:]/u.test(c.lines[0]) &&
        finiteRect(c.rect) &&
        c.rect[3] < opening[1] &&
        opening[1] - c.rect[3] < h * 2 &&
        c.rect[0] < opening[0] &&
        c.rect[2] > opening[2]
    )
    if (caps.length !== 1) return refusal('unique-independent-caption-barrier')
    const capFonts = items.filter(
      (f) =>
        meaningful(f) &&
        f.rect[2] > caps[0].rect[0] &&
        f.rect[0] < caps[0].rect[2] &&
        f.rect[3] > caps[0].rect[1] &&
        f.rect[1] < caps[0].rect[3]
    )
    if (
      capFonts.some(
        (f) =>
          f.rect[0] < caps[0].rect[0] - tolerance ||
          f.rect[2] > caps[0].rect[2] + tolerance ||
          f.rect[1] < caps[0].rect[1] - tolerance ||
          f.rect[3] > caps[0].rect[3] + tolerance
      )
    )
      return refusal('complete-caption-font-owner')
    const capBands = []
    for (const font of capFonts.sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
      let band = capBands.find((row) => same(row[0].baseline, font.baseline))
      if (!band) capBands.push((band = []))
      band.push(font)
    }
    if (
      capFonts.some((font) => !font.horizontal || !matchesProgram(font, runs)) ||
      JSON.stringify(capBands.map((row) => row.map((font) => font.text.trim()).join(' '))) !==
        JSON.stringify(caps[0].lines)
    )
      return refusal('complete-caption-literal-program')
    const barrier = items.filter(
      (f) =>
        meaningful(f) &&
        f.horizontal &&
        f.rect[0] < closing[2] &&
        f.rect[2] > closing[0] &&
        f.rect[1] >= closing[1] &&
        f.rect[1] < table.cropRect[3]
    )
    if (barrier.length) return refusal('closing-native-footer-barrier')
    const literalPrefix = children
      .slice(0, 2)
      .map((f) => f.text)
      .join('')
    const literalSuffix =
      ' ' +
      children
        .slice(2)
        .map((f) => (f.text === '−' ? '− ' : f.text))
        .join('')
    const leftRuns = [
      { text: literalPrefix, position: 'normal' },
      { text: lowerScript.text, position: 'subscript' },
      { text: literalSuffix, position: 'normal' }
    ]
    if (JSON.stringify(childDonors[0][0].textRuns) !== JSON.stringify(leftRuns))
      return refusal('calibrated-existing-rich-child-exact')
    const rightRuns = [
      { text: literalPrefix, position: 'normal' },
      { text: rightScript.text, position: 'subscript' },
      { text: literalSuffix + ' (↓)', position: 'normal' }
    ]
    const currentlyOwned = cells.flatMap((cell) => cell.sourceTokens)
    const missing = header.filter(
      (font) =>
        !currentlyOwned.some((old) => old.text === font.text && sameRect(old.rect, font.rect))
    )
    if (
      currentlyOwned.length + missing.length !== source.length ||
      new Set(currentlyOwned.map((font) => font.text + ':' + font.rect.join(':'))).size !==
        currentlyOwned.length ||
      currentlyOwned.some(
        (font) =>
          source.filter((f) => f.text === font.text && sameRect(f.rect, font.rect)).length !== 1
      ) ||
      JSON.stringify([...missing.map((font) => font.text)].sort()) !==
        JSON.stringify([...refinedContext.unassigned].sort()) ||
      refinedContext.selectedTextItems !== source.length
    )
      return refusal('complete-current-header-ownership-mismatch')
    return {
      qualified: true,
      missingHeaderFonts: missing,
      completeBodyDonors: ownedBody,
      existingChildDonors: childDonors.map((g) => g[0]),
      frameRules,
      splitY,
      domains,
      parent,
      fields,
      rightRuns
    }
  }

  const proof = qualifyPairedNativeHeader(
    table,
    items,
    captions,
    rules,
    runs,
    refined?.cells,
    refined
  )
  if (!proof.qualified) return
  const first = refined.cells.filter((c) => c.row === 0).sort((a, b) => a.column - b.column)
  const cuts = [...first.map((cell) => cell.rect[0]), first.at(-1).rect[2]]
  if (cuts.slice(1, -1).some((x, i) => !(x > proof.domains[i][2] && x < proof.domains[i + 1][0])))
    return
  const result = structuredClone(refined)
  const tokens = (fonts) =>
    [...fonts]
      .sort((a, b) => items.indexOf(a) - items.indexOf(b))
      .map((font) => ({
        text: font.text,
        rect: [...font.rect],
        baseline: font.baseline,
        height: font.height
      }))
  const headerCell = (column, fonts, rowSpan, colSpan, text, textRuns) => {
    const sourceTokens = tokens(fonts)
    return {
      row: 0,
      column,
      rowSpan,
      colSpan,
      rect: [
        cuts[column],
        proof.frameRules[0][1],
        cuts[column + colSpan],
        rowSpan === 2 ? proof.frameRules[1][1] : proof.splitY
      ],
      text,
      ...(textRuns ? { textRuns: structuredClone(textRuns) } : {}),
      sourceTokens,
      sourceRects: sourceTokens.map((font) => font.rect),
      origin: 'source-printed-header'
    }
  }
  const header = [headerCell(0, [proof.parent], 1, 2, proof.parent.text)]
  for (let column = 2; column < 6; column++) {
    const fonts = proof.fields[column]
    const rich = column === 2 ? proof.rightRuns : undefined
    header.push(
      headerCell(
        column,
        fonts,
        2,
        1,
        rich ? rich.map((run) => run.text).join('') : fonts[0].text,
        rich
      )
    )
  }
  const children = proof.existingChildDonors.map((donor) => ({
    ...structuredClone(donor),
    row: 1,
    rect: [cuts[donor.column], proof.splitY, cuts[donor.column + 1], proof.frameRules[1][1]]
  }))
  const body = proof.completeBodyDonors.map((donor) => ({
    ...structuredClone(donor),
    row: donor.row + 1
  }))
  result.cells = [...header, ...children, ...body]
  result.rows = [
    {
      rect: [proof.frameRules[0][0], proof.frameRules[0][1], proof.frameRules[0][2], proof.splitY],
      origin: 'source-printed-header'
    },
    {
      rect: [proof.frameRules[1][0], proof.splitY, proof.frameRules[1][2], proof.frameRules[1][1]],
      origin: 'source-printed-header'
    },
    ...structuredClone(refined.rows.slice(1))
  ]
  result.grid = Array.from({ length: 6 }, () => Array(6).fill(''))
  for (const cell of result.cells) result.grid[cell.row][cell.column] = cell.text
  for (const font of proof.missingHeaderFonts) {
    const index = result.unassigned.indexOf(font.text)
    if (index < 0) return
    result.unassigned.splice(index, 1)
  }
  if (result.unassigned.length) return
  result.issues = result.issues.filter((issue) => issue !== 'unassigned-source-text')
  result.repairs.push('native-isolated-printed-header-recovered')
  return result
}

export function recoverNativeCalibratedTerminalSymbolicRecords(
  table,
  items,
  captions,
  notes,
  rules,
  seed,
  rulePaintBounds
) {
  // Calibrate terminal ownership only from complete existing peer fields.
  // This is deliberately separate from the generic ordinary/scientific proofs.
  const validRect = (r) =>
    Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1]
  const close = (a, b) => Math.abs(a - b) < 0.02
  const sameRect = (a, b) => validRect(a) && validRect(b) && a.every((v, n) => close(v, b[n]))
  const contains = (a, b) => b.every((v, n) => (n < 2 ? v >= a[n] - 0.02 : v <= a[n] + 0.02))
  const intersects = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
  const key = (t) => JSON.stringify([t.text, t.rect, t.baseline, t.height])
  const fontValid = (t) =>
    t &&
    typeof t.text === 'string' &&
    t.text.trim() &&
    validRect(t.rect) &&
    Number.isFinite(t.baseline) &&
    Number.isFinite(t.height) &&
    t.height > 0 &&
    close(t.rect[3], t.baseline) &&
    close(t.rect[3] - t.rect[1], t.height)
  const box = (fonts) => [
    Math.min(...fonts.map((f) => f.rect[0])),
    Math.min(...fonts.map((f) => f.rect[1])),
    Math.max(...fonts.map((f) => f.rect[2])),
    Math.max(...fonts.map((f) => f.rect[3]))
  ]
  const emptyOptionalArray = (a) => a === undefined || (Array.isArray(a) && a.length === 0)
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  const splitCellKeys = new Set([
    'row',
    'column',
    'rowSpan',
    'colSpan',
    'rect',
    'origin',
    'text',
    'sourceTokens',
    'sourceRects',
    'textRuns'
  ])
  const splitRowKeys = new Set(['rect', 'origin'])
  const knownSplitCell = (c) =>
    object(c) &&
    Object.keys(c).every((k) => splitCellKeys.has(k)) &&
    (c.origin === undefined || typeof c.origin === 'string')
  const knownSplitRow = (r) =>
    object(r) &&
    Object.keys(r).every((k) => splitRowKeys.has(k)) &&
    (r.origin === undefined || typeof r.origin === 'string')

  function qualifyCalibratedTerminalSymbolicRecordOwners(
    table,
    items,
    captions,
    rules,
    seed,
    context
  ) {
    if (
      !object(table) ||
      !object(seed) ||
      !object(context) ||
      !Number.isInteger(context.pageNumber) ||
      context.pageNumber < 1 ||
      !(context.rulePaintBounds instanceof Map)
    )
      return
    if (
      !Array.isArray(items) ||
      !Array.isArray(captions) ||
      !Array.isArray(rules) ||
      rules.length > 81 ||
      !emptyOptionalArray(context.notes)
    )
      return
    if (
      !validRect(table.cropRect) ||
      !validRect(seed.cropRect) ||
      seed.readingRotation !== 0 ||
      (table.readingRotation !== undefined && table.readingRotation !== 0)
    )
      return
    if (
      !emptyOptionalArray(table.notes) ||
      !emptyOptionalArray(table.parts) ||
      !emptyOptionalArray(table.unassigned) ||
      !emptyOptionalArray(table.issues) ||
      !emptyOptionalArray(table.clipped)
    )
      return
    if (
      !Array.isArray(table.grid) ||
      table.grid.length < 4 ||
      !Array.isArray(table.rows) ||
      table.rows.length !== table.grid.length ||
      !Array.isArray(table.cells)
    )
      return
    const columns = table.grid[0]?.length,
      rows = table.grid.length
    if (
      !Number.isInteger(columns) ||
      columns < 4 ||
      columns > 16 ||
      table.grid.some(
        (r) => !Array.isArray(r) || r.length !== columns || r.some((t) => typeof t !== 'string')
      )
    )
      return
    if (
      table.cells.length !== rows * columns ||
      table.rows.some((r) => !object(r) || !validRect(r.rect))
    )
      return
    if (!knownSplitRow(table.rows.at(-1))) return
    if (
      table.rows.some(
        (r, n) =>
          !contains(seed.cropRect, r.rect) ||
          (n && (r.rect[1] <= table.rows[n - 1].rect[1] || r.rect[3] <= table.rows[n - 1].rect[3]))
      )
    )
      return
    if (
      items.some(
        (i) =>
          !fontValid(i) ||
          i.horizontal !== true ||
          (i.inlineSymbol !== undefined && typeof i.inlineSymbol !== 'boolean')
      )
    )
      return
    if (rules.some((r) => !Array.isArray(r) || r.length !== 4 || !r.every(Number.isFinite))) return
    const slots = new Set()
    for (const c of table.cells) {
      if (
        !c ||
        !Number.isInteger(c.row) ||
        !Number.isInteger(c.column) ||
        c.row < 0 ||
        c.row >= rows ||
        c.column < 0 ||
        c.column >= columns ||
        c.rowSpan !== 1 ||
        c.colSpan !== 1 ||
        !validRect(c.rect) ||
        typeof c.text !== 'string' ||
        !emptyOptionalArray(c.textRuns)
      )
        return
      if (
        !Array.isArray(c.sourceTokens) ||
        !Array.isArray(c.sourceRects) ||
        c.sourceTokens.length !== c.sourceRects.length ||
        c.sourceTokens.some((t) => !fontValid(t))
      )
        return
      if (
        c.sourceRects.some((r) => !validRect(r)) ||
        c.sourceTokens.some((t) => c.sourceRects.filter((r) => sameRect(r, t.rect)).length !== 1)
      )
        return
      const slot = `${c.row}:${c.column}`
      if (slots.has(slot) || c.text !== table.grid[c.row][c.column]) return
      slots.add(slot)
      if (
        !close(c.rect[1], table.rows[c.row].rect[1]) ||
        !close(c.rect[3], table.rows[c.row].rect[3])
      )
        return
      if (c.row === rows - 1 && !knownSplitCell(c)) return
    }
    const cell = (r, c) => table.cells.find((t) => t.row === r && t.column === c)
    const donorFaces = Array.from({ length: columns }, (_, n) => cell(rows - 1, n).rect)
    if (
      !close(donorFaces[0][0], table.cropRect[0]) ||
      !close(donorFaces.at(-1)[2], table.cropRect[2]) ||
      donorFaces.some((r, n) => n && !close(r[0], donorFaces[n - 1][2]))
    )
      return
    if (
      table.cells.some(
        (c) =>
          !close(c.rect[0], donorFaces[c.column][0]) || !close(c.rect[2], donorFaces[c.column][2])
      )
    )
      return
    const owners = table.cells.flatMap((c) => c.sourceTokens)
    const ownerKeys = owners.map(key)
    if (new Set(ownerKeys).size !== owners.length || table.selectedTextItems !== owners.length)
      return
    const sourceByKey = new Map()
    for (const t of owners) {
      const found = items.filter((i) => key(i) === key(t))
      if (found.length !== 1) return
      sourceByKey.set(key(t), found[0])
    }
    const full = rules
      .filter(
        (r) =>
          close(r[1], r[3]) &&
          r[1] > seed.cropRect[1] &&
          r[1] < seed.cropRect[3] &&
          r[0] >= seed.cropRect[0] - 0.02 &&
          r[2] <= seed.cropRect[2] + 0.02 &&
          r[2] - r[0] > (seed.cropRect[2] - seed.cropRect[0]) * 0.7
      )
      .sort((a, b) => a[1] - b[1])
    if (full.length !== 3 || full.some((r) => !close(r[0], full[0][0]) || !close(r[2], full[0][2])))
      return
    const outer = [full[0][0], full[0][1], full[0][2], full.at(-1)[1]]
    if (owners.some((f) => !contains(outer, f.rect))) return
    const h = cell(1, 0).sourceTokens[0]?.height
    if (!Number.isFinite(h) || h <= 0 || owners.some((f) => !close(f.height, h))) return
    const title = captions.filter(
      (c) =>
        c &&
        c.page === context.pageNumber &&
        Array.isArray(c.lines) &&
        c.lines.length &&
        c.lines.every((t) => typeof t === 'string') &&
        /^Table\s+\S/u.test(c.lines[0]) &&
        validRect(c.rect) &&
        c.rect[1] <= outer[3] + h * 4 &&
        c.rect[3] > outer[3] &&
        c.rect[0] < outer[2] &&
        c.rect[2] > outer[0]
    )
    if (title.length !== 1) return
    const overlapCaptionFont = items.filter(
      (f) =>
        f.text === title[0].lines[0] && contains(title[0].rect, f.rect) && f.baseline > outer[3]
    )
    if (overlapCaptionFont.length !== 1) return
    if (
      items.some(
        (f) =>
          intersects(f.rect, outer) && !sourceByKey.has(key(f)) && !overlapCaptionFont.includes(f)
      )
    )
      return
    if (cell(0, 0).text !== '' || cell(0, 0).sourceTokens.length !== 0) return
    const header = table.cells.filter((c) => c.row === 0).flatMap((c) => c.sourceTokens)
    if (
      header.some((t) => t.baseline >= full[1][1] || sourceByKey.get(key(t)).inlineSymbol) ||
      table.cells
        .filter((c) => c.row === 0 && c.column > 0)
        .some((c) => !c.text.trim() || c.sourceTokens.length < 1)
    )
      return
    // Calibrate all earlier complete records, with at least two independent peers.
    const peerRows = Array.from({ length: rows - 2 }, (_, n) => n + 1)
    const prototype = cell(peerRows[0], columns - 1)
    if (!prototype.text.trim() || prototype.sourceTokens.length < 2) return
    const protoStub = cell(peerRows[0], 0).sourceTokens[0]
    if (!protoStub) return
    const motif = prototype.sourceTokens.map((t) => ({
      text: t.text,
      left: t.rect[0],
      right: t.rect[2],
      top: t.rect[1] - protoStub.baseline,
      bottom: t.rect[3] - protoStub.baseline,
      height: t.height,
      inlineSymbol: sourceByKey.get(key(t)).inlineSymbol === true
    }))
    if (!motif.some((m) => m.inlineSymbol)) return
    const translated = (token, m, baseline) =>
      token.text === m.text &&
      close(token.rect[0], m.left) &&
      close(token.rect[2], m.right) &&
      close(token.rect[1] - baseline, m.top) &&
      close(token.rect[3] - baseline, m.bottom) &&
      close(token.height, m.height) &&
      (sourceByKey.get(key(token)).inlineSymbol === true) === m.inlineSymbol
    const glyphChoices = new Set()
    for (const row of peerRows) {
      const stub = cell(row, 0)
      if (
        stub.sourceTokens.length !== 1 ||
        !/\p{L}/u.test(stub.sourceTokens[0].text) ||
        stub.text !== stub.sourceTokens[0].text
      )
        return
      const b = stub.sourceTokens[0].baseline
      for (let col = 1; col < columns - 1; col++) {
        const c = cell(row, col),
          t = c.sourceTokens[0]
        if (
          c.sourceTokens.length !== 1 ||
          !/^[^\p{L}\p{N}\s]$/u.test(t?.text ?? '') ||
          c.text !== t.text ||
          !close(t.baseline, b) ||
          sourceByKey.get(key(t)).inlineSymbol
        )
          return
        glyphChoices.add(t.text)
      }
      const formula = cell(row, columns - 1)
      if (
        formula.text !== prototype.text ||
        formula.sourceTokens.length !== motif.length ||
        formula.sourceTokens.some((t, n) => !translated(t, motif[n], b))
      )
        return
    }
    const terminal = table.cells.filter((c) => c.row === rows - 1)
    const stubs = cell(rows - 1, 0).sourceTokens
    if (
      stubs.length !== 2 ||
      stubs.some((t) => !/\p{L}/u.test(t.text)) ||
      stubs[0].baseline >= stubs[1].baseline
    )
      return
    const allStubs = [...peerRows.map((r) => cell(r, 0).sourceTokens[0]), ...stubs]
    const spacing = allStubs[1].baseline - allStubs[0].baseline
    if (
      spacing <= h ||
      spacing >= h * 2 ||
      allStubs.some((t, n) => n && !close(t.baseline - allStubs[n - 1].baseline, spacing))
    )
      return
    const recordFonts = allStubs.map((stub) => {
      const record = [[stub]]
      for (let col = 1; col < columns - 1; col++) {
        const face = cell(rows - 1, col).rect
        record.push(
          owners.filter(
            (t) => t.rect[0] >= face[0] && t.rect[2] <= face[2] && close(t.baseline, stub.baseline)
          )
        )
      }
      const math = motif.map((m) => owners.filter((t) => translated(t, m, stub.baseline)))
      if (math.some((g) => g.length !== 1)) return
      record.push(math.map((g) => g[0]))
      if (
        record.slice(0, -1).some((g) => g.length !== 1) ||
        record.slice(1, -1).some((g) => !glyphChoices.has(g[0].text))
      )
        return
      return record
    })
    if (recordFonts.some((r) => !r)) return
    const body = recordFonts.flat(2)
    if (
      new Set(body.map(key)).size !== body.length ||
      body.length + header.length !== owners.length ||
      body.some((t) => header.includes(t))
    )
      return
    if (owners.some((t) => !body.includes(t) && !header.includes(t))) return
    for (const row of peerRows)
      if (
        table.cells
          .filter((c) => c.row === row)
          .some(
            (c) =>
              c.sourceTokens.length !== recordFonts[row - 1][c.column].length ||
              c.sourceTokens.some((t) => !recordFonts[row - 1][c.column].includes(t))
          )
      )
        return
    const terminalRecords = recordFonts.slice(-2)
    if (
      terminal.some(
        (c) =>
          c.sourceTokens.length !== terminalRecords.reduce((n, r) => n + r[c.column].length, 0) ||
          c.sourceTokens.some((t) => !terminalRecords.some((r) => r[c.column].includes(t)))
      )
    )
      return
    const terminalTexts = terminalRecords.map((r) =>
      r.map((g, col) => (col === columns - 1 ? prototype.text : g[0].text))
    )
    if (terminal.some((c) => c.text !== terminalTexts.map((r) => r[c.column]).join(' '))) return
    // Each peer independently calibrates the same complete short overbar rule.
    // It is a literal motif witness, never a vertical/body record fence.
    const internal = rules.filter(
      (r) =>
        close(r[1], r[3]) &&
        r[0] >= outer[0] &&
        r[2] <= outer[2] &&
        r[1] > outer[1] &&
        r[1] < outer[3] &&
        !full.includes(r)
    )
    const bars = recordFonts.map((r) => {
      const mathBox = box(r.at(-1))
      const matches = internal.filter((line) => contains(mathBox, line))
      return matches.length === 1 ? matches[0] : undefined
    })
    if (
      bars.some((r) => !r) ||
      new Set(bars).size !== bars.length ||
      bars.length !== internal.length
    )
      return
    const relativeRule = (r, index) => [
      r[0] - motif[0].left,
      r[1] - allStubs[index].baseline,
      r[2] - motif[0].left,
      r[3] - allStubs[index].baseline
    ]
    const barProfile = relativeRule(bars[0], 0)
    if (bars.some((r, n) => relativeRule(r, n).some((v, i) => !close(v, barProfile[i])))) return
    for (const r of [...full, ...bars]) {
      const painted = context.rulePaintBounds.get(r.join(','))
      if (!validRect(painted) || !contains(painted, r)) return
    }
    const ordinaryBottom = Math.max(
      ...terminalRecords[0]
        .slice(0, -1)
        .flat()
        .map((f) => f.rect[3])
    )
    const ordinaryTop = Math.min(
      ...terminalRecords[1]
        .slice(0, -1)
        .flat()
        .map((f) => f.rect[1])
    )
    if (
      !(ordinaryTop > ordinaryBottom) ||
      ordinaryTop >= table.rows.at(-1).rect[3] ||
      ordinaryBottom <= table.rows.at(-1).rect[1]
    )
      return
    return {
      recordFonts,
      terminalRecords,
      terminalTexts,
      splitY: (ordinaryBottom + ordinaryTop) / 2,
      protectedCells: table.cells.filter((c) => c.row < rows - 1),
      originalDonors: terminal,
      frame: outer,
      completePaint: [...full, ...bars].map((r) => ({
        rule: r,
        paint: context.rulePaintBounds.get(r.join(','))
      })),
      originalCaption: title[0]
    }
  }

  function projectCalibratedTerminalSymbolicRecords(table, proof) {
    if (
      !object(table) ||
      !object(proof) ||
      !Array.isArray(table.grid) ||
      !table.grid.length ||
      !Array.isArray(table.grid[0]) ||
      !Array.isArray(table.rows) ||
      table.rows.length !== table.grid.length ||
      !validRect(table.rows.at(-1)?.rect) ||
      !knownSplitRow(table.rows.at(-1))
    )
      return
    const columns = table.grid[0].length
    if (
      !Array.isArray(proof.originalDonors) ||
      proof.originalDonors.length !== columns ||
      proof.originalDonors.some(
        (c) =>
          !knownSplitCell(c) ||
          !Array.isArray(c.sourceTokens) ||
          c.sourceTokens.some((t) => !fontValid(t)) ||
          !Array.isArray(c.sourceRects) ||
          c.sourceRects.some((r) => !validRect(r))
      )
    )
      return
    if (
      !Array.isArray(proof.terminalRecords) ||
      proof.terminalRecords.length !== 2 ||
      proof.terminalRecords.some(
        (r) =>
          !Array.isArray(r) ||
          r.length !== columns ||
          r.some((g) => !Array.isArray(g) || !g.length || g.some((f) => !fontValid(f)))
      )
    )
      return
    if (
      !Array.isArray(proof.terminalTexts) ||
      proof.terminalTexts.length !== 2 ||
      proof.terminalTexts.some(
        (r) => !Array.isArray(r) || r.length !== columns || r.some((t) => typeof t !== 'string')
      )
    )
      return
    if (
      !Number.isFinite(proof.splitY) ||
      proof.splitY <= table.rows.at(-1).rect[1] ||
      proof.splitY >= table.rows.at(-1).rect[3]
    )
      return
    const result = structuredClone(table),
      oldRow = table.grid.length - 1
    const same = (a, b) => fencedGroupOpaqueEqual(a, b)
    const added = proof.terminalRecords.flatMap((r, n) =>
      proof.originalDonors.map((donor) => {
        const kept = donor.sourceTokens.filter((t) => r[donor.column].some((f) => same(f, t)))
        const sourceRects = donor.sourceRects.filter((rect) => kept.some((t) => same(rect, t.rect)))
        if (kept.length !== r[donor.column].length || sourceRects.length !== kept.length)
          return undefined
        return {
          ...structuredClone(donor),
          row: oldRow + n,
          text: proof.terminalTexts[n][donor.column],
          rect: [
            donor.rect[0],
            n ? proof.splitY : donor.rect[1],
            donor.rect[2],
            n ? donor.rect[3] : proof.splitY
          ],
          sourceTokens: structuredClone(kept),
          sourceRects: structuredClone(sourceRects)
        }
      })
    )
    if (added.some((c) => !c)) return
    result.cells = [...result.cells.filter((c) => c.row < oldRow), ...added]
    result.grid = [...result.grid.slice(0, oldRow), ...proof.terminalTexts]
    result.rows = [
      ...result.rows.slice(0, oldRow),
      ...[0, 1].map((n) => ({
        ...structuredClone(table.rows.at(-1)),
        rect: [
          table.rows.at(-1).rect[0],
          n ? proof.splitY : table.rows.at(-1).rect[1],
          table.rows.at(-1).rect[2],
          n ? table.rows.at(-1).rect[3] : proof.splitY
        ]
      }))
    ]
    return result
  }

  // Existing refine arguments already contain the whole seed, notes and Map.
  // The current page is derived from the finite unique same-page caption set.
  function proveCalibratedTerminalSymbolicRecordsAtExistingSeam(
    table,
    items,
    captions,
    notes,
    rules,
    seed,
    rulePaintBounds
  ) {
    if (
      !Array.isArray(captions) ||
      !captions.length ||
      captions.some((c) => !object(c) || !Number.isInteger(c.page) || c.page < 1)
    )
      return
    const pages = new Set(captions.map((c) => c.page))
    if (pages.size !== 1) return
    return qualifyCalibratedTerminalSymbolicRecordOwners(table, items, captions, rules, seed, {
      pageNumber: [...pages][0],
      notes,
      rulePaintBounds
    })
  }

  const proof = proveCalibratedTerminalSymbolicRecordsAtExistingSeam(
    table,
    items,
    captions,
    notes,
    rules,
    seed,
    rulePaintBounds
  )
  return proof && projectCalibratedTerminalSymbolicRecords(table, proof)
}

// Remove only source-proved false rows while retaining every existing font owner.

const recordRowRect = (r) =>
  Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1]
const recordRowExactRect = (a, b) =>
  Array.isArray(a) && Array.isArray(b) && a.every((v, n) => v === b[n])
const recordRowSame = (a, b) =>
  a.text === b.text &&
  a.baseline === b.baseline &&
  a.height === b.height &&
  recordRowExactRect(a.rect, b.rect)
const recordRowFont = (f) =>
  f &&
  typeof f.text === 'string' &&
  recordRowRect(f.rect) &&
  Number.isFinite(f.baseline) &&
  Number.isFinite(f.height) &&
  f.height > 0
const recordRowIntersect = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
const recordRowContains = (a, b) => a.every((v, n) => (n < 2 ? v >= b[n] : v <= b[n]))
const recordRowBox = (a) => [
  Math.min(...a.map((f) => f.rect[0])),
  Math.min(...a.map((f) => f.rect[1])),
  Math.max(...a.map((f) => f.rect[2])),
  Math.max(...a.map((f) => f.rect[3]))
]
const recordRowMachine = (a, b) =>
  a.every(
    (v, n) => Math.abs(v - b[n]) <= Number.EPSILON * Math.max(1, Math.abs(v), Math.abs(b[n])) * 16
  )
const recordRowChars = (s) => s.replace(/\s/g, '')
function recordRowQualifyExistingWholeRecordRowMap(input) {
  const refuse = (reason) => ({ qualified: false, reason })
  if (!input || typeof input !== 'object') return refuse('input')
  const {
    table,
    items,
    runs,
    rules,
    paint,
    graphics,
    viewport,
    crop,
    captions,
    readingRotation,
    invalidGraphicsBounds
  } = input
  if (
    !table ||
    readingRotation !== 0 ||
    invalidGraphicsBounds !== 0 ||
    !recordRowRect(crop) ||
    !Array.isArray(table.grid) ||
    !Array.isArray(table.cells) ||
    !Array.isArray(items) ||
    items.some((i) => !recordRowFont(i)) ||
    !Array.isArray(runs) ||
    !Array.isArray(rules) ||
    rules.some((r) => !Array.isArray(r) || r.length !== 4 || r.some((v) => !Number.isFinite(v))) ||
    !(paint instanceof Map) ||
    !Array.isArray(graphics) ||
    graphics.some((g) => !g || !recordRowRect(g.rect)) ||
    !viewport ||
    viewport.scale !== 1.5 ||
    ![viewport.width, viewport.height].every((v) => Number.isInteger(v) && v > 0)
  )
    return refuse('complete-input')
  const height = table.grid.length,
    width = table.grid[0]?.length
  if (
    height < 4 ||
    width < 3 ||
    table.grid.some(
      (r) => !Array.isArray(r) || r.length !== width || r.some((s) => typeof s !== 'string')
    ) ||
    !Array.isArray(table.rows) ||
    table.rows.length !== height ||
    table.rows.some((r) => !r || !recordRowRect(r.rect)) ||
    ['notes', 'parts', 'unassigned', 'clipped'].some(
      (k) => Object.hasOwn(table, k) && (!Array.isArray(table[k]) || table[k].length)
    )
  )
    return refuse('unsupported-table')
  if (
    !Array.isArray(captions) ||
    captions.length !== 1 ||
    !captions[0] ||
    !recordRowRect(captions[0].rect) ||
    !Array.isArray(captions[0].lines) ||
    !captions[0].lines.length ||
    captions[0].lines.some((s) => typeof s !== 'string') ||
    recordRowIntersect(captions[0].rect, crop)
  )
    return refuse('independent-caption')
  const slots = new Set(),
    owned = []
  for (const c of table.cells) {
    if (
      !c ||
      !Number.isInteger(c.row) ||
      c.row < 0 ||
      c.row >= height ||
      !Number.isInteger(c.column) ||
      c.column < 0 ||
      c.column >= width ||
      c.rowSpan !== 1 ||
      c.colSpan !== 1 ||
      c.section ||
      typeof c.text !== 'string' ||
      table.grid[c.row][c.column] !== c.text ||
      !recordRowRect(c.rect) ||
      !Array.isArray(c.sourceTokens) ||
      !Array.isArray(c.sourceRects) ||
      c.sourceTokens.length !== c.sourceRects.length ||
      c.sourceTokens.some((t) => !recordRowFont(t)) ||
      c.sourceRects.some((r) => !recordRowRect(r)) ||
      c.sourceTokens.some(
        (t) => c.sourceRects.filter((r) => recordRowExactRect(t.rect, r)).length !== 1
      ) ||
      c.sourceRects.some(
        (r) => c.sourceTokens.filter((t) => recordRowExactRect(t.rect, r)).length !== 1
      ) ||
      (Object.hasOwn(c, 'textRuns') &&
        (!Array.isArray(c.textRuns) ||
          c.textRuns.some((r) => !r || typeof r.text !== 'string') ||
          c.textRuns.map((r) => r.text).join('') !== c.text))
    )
      return refuse('whole-old-owner')
    const key = `${c.row}:${c.column}`
    if (slots.has(key)) return refuse('duplicate-slot')
    slots.add(key)
    if (recordRowChars(c.sourceTokens.map((t) => t.text).join('')) !== recordRowChars(c.text))
      return refuse('whole-literal')
    owned.push(...c.sourceTokens)
  }
  if (slots.size !== height * width) return refuse('missing-slot')
  const emptyRows = table.grid
    .map((_, row) => row)
    .filter(
      (row) =>
        row > 0 &&
        table.cells
          .filter((c) => c.row === row)
          .every(
            (c) => !c.text && !c.sourceTokens.length && !c.sourceRects.length && !c.textRuns?.length
          )
    )
  if (!emptyRows.length) return refuse('already-complete')
  if (table.selectedTextItems !== owned.length) return refuse('source-owner-count')
  const emptyCellKeys = new Set([
    'row',
    'column',
    'rowSpan',
    'colSpan',
    'rect',
    'origin',
    'text',
    'sourceTokens',
    'sourceRects',
    'textRuns'
  ])
  if (
    table.cells
      .filter((c) => emptyRows.includes(c.row))
      .some(
        (c) => c.origin !== 'model-grid' || Object.keys(c).some((k) => !emptyCellKeys.has(k))
      ) ||
    emptyRows.some(
      (row) =>
        Object.keys(table.rows[row]).some((k) => !['rect', 'origin'].includes(k)) ||
        !['model', 'source-text'].includes(table.rows[row].origin)
    )
  )
    return refuse('empty-owner-additional-state')
  const nativeRows = table.grid
    .map((_, row) => row)
    .filter((row) => row > 0 && !emptyRows.includes(row))
  const sparse = Array.from({ length: width }, (_, column) => column).filter((column) =>
    nativeRows.some(
      (row) => !table.cells.find((c) => c.row === row && c.column === column).sourceTokens.length
    )
  )
  if (sparse.length > 1) return refuse('multiple-incomplete-fields')
  const stubs = new Set(sparse),
    bands = []
  for (const row of nativeRows) {
    const peers = table.cells.filter((c) => c.row === row && !stubs.has(c.column))
    if (peers.length !== width - stubs.size || peers.some((c) => !c.sourceTokens.length))
      return refuse('incomplete-record')
    const singles = peers.filter((c) => c.sourceTokens.length === 1).map((c) => c.sourceTokens[0]),
      groups = []
    for (const f of singles) {
      const group = groups.find((g) => Math.abs(g[0].baseline - f.baseline) < 0.02)
      if (group) group.push(f)
      else groups.push([f])
    }
    groups.sort((a, b) => b.length - a.length)
    if (!groups.length || groups[0].length < 2 || groups[1]?.length === groups[0].length)
      return refuse('independent-record-anchor')
    bands.push({
      row,
      baseline: groups[0][0].baseline,
      envelope: recordRowBox(peers.flatMap((c) => c.sourceTokens))
    })
  }
  if (
    bands.length < 3 ||
    bands.some(
      (b, n) =>
        n && (b.baseline <= bands[n - 1].baseline || b.envelope[1] <= bands[n - 1].envelope[3])
    )
  )
    return refuse('independent-whole-font-records')
  // This family concerns false model/source segmentation of already-owned
  // printed records. A source-clean blank/spacer band is outside its scope.
  // Require every proposed removed row to intersect full fonts of at least
  // two independent non-stub fields, rather than using absence of owners.
  const falseRowWitnesses = emptyRows.map((row) => ({
    row,
    intersectingFields: table.cells
      .filter(
        (c) =>
          c.row > 0 &&
          !emptyRows.includes(c.row) &&
          !stubs.has(c.column) &&
          c.sourceTokens.some((t) => recordRowIntersect(t.rect, table.rows[row].rect))
      )
      .map((c) => ({
        row: c.row,
        column: c.column,
        fonts: c.sourceTokens.filter((t) => recordRowIntersect(t.rect, table.rows[row].rect))
      }))
  }))
  if (falseRowWitnesses.some((w) => new Set(w.intersectingFields.map((f) => f.column)).size < 2))
    return refuse('source-clean-spacer-or-blank-record')
  const domain = recordRowBox(owned),
    fences = rules
      .filter(
        (r) =>
          r[1] === r[3] &&
          r[0] <= domain[0] &&
          r[2] >= domain[2] &&
          r[1] >= crop[1] &&
          r[1] <= crop[3]
      )
      .sort((a, b) => a[1] - b[1])
  if (
    fences.length < 3 ||
    fences.some((r) => Math.abs(r[0] - fences[0][0]) > 0.02 || Math.abs(r[2] - fences[0][2]) > 0.02)
  )
    return refuse('complete-native-frame')
  const frame = [fences[0][0], fences[0][1], fences[0][2], fences.at(-1)[1]],
    all = items.filter((i) => i.text.trim() && recordRowIntersect(i.rect, frame))
  if (
    all.some((i) => !i.horizontal || !recordRowContains(i.rect, frame)) ||
    owned.length !== all.length ||
    owned.some((t) => all.filter((i) => recordRowSame(i, t)).length !== 1) ||
    all.some((i) => owned.filter((t) => recordRowSame(i, t)).length !== 1)
  )
    return refuse('all-native-font-bijection')
  if (fences.slice(1, -1).some((r) => owned.some((f) => f.rect[1] < r[1] && f.rect[3] > r[1])))
    return refuse('native-fence-crosses-whole-font')
  if (
    fences
      .slice(1)
      .some((r, n) => !owned.some((f) => f.rect[1] >= fences[n][1] && f.rect[3] <= r[1]))
  )
    return refuse('true-source-blank-ruled-face')
  for (const f of owned) {
    const match = runs.filter((r) => r && r.text === f.text && recordRowExactRect(r.rect, f.rect))
    if (
      match.length !== 1 ||
      !recordRowSame(match[0], f) ||
      !Array.isArray(match[0].literalGlyphs) ||
      match[0].literalGlyphs.some((s) => typeof s !== 'string' || !s.length) ||
      recordRowChars(match[0].literalGlyphs.join('')) !== recordRowChars(f.text) ||
      !Array.isArray(match[0].glyphRuns) ||
      match[0].glyphRuns.length !== Array.from(match[0].literalGlyphs.join('')).length ||
      match[0].glyphRuns.some((n) => !Number.isInteger(n) || n < 0)
    )
      return refuse('whole-observed-program')
  }
  const columns = Array.from({ length: width }, (_, column) =>
      recordRowBox(table.cells.filter((c) => c.column === column).flatMap((c) => c.sourceTokens))
    ),
    gutters = columns.slice(1).map((d, n) => [columns[n][2], d[0]])
  if (gutters.some((g) => g[0] >= g[1])) return refuse('full-header-body-gutters')
  const enclosed = rules.filter(
    (r) =>
      r[1] === r[3] && r[1] >= frame[1] && r[1] <= frame[3] && r[0] < frame[2] && r[2] > frame[0]
  )
  const carriers = []
  const quantize = (p) =>
    p.map((v, k) => {
      const axis = k % 2 ? viewport.height : viewport.width
      return ((k < 2 ? Math.floor((v / axis) * 256) : Math.ceil((v / axis) * 256) + 1) * axis) / 256
    })
  for (const r of enclosed) {
    const p = paint.get(r.join(','))
    if (!recordRowRect(p) || !recordRowContains(p, crop)) return refuse('whole-native-paint')
    if (
      !fences.includes(r) &&
      owned.filter(
        (f) =>
          Math.abs(f.rect[0] - r[0]) < 0.02 &&
          Math.abs(f.rect[2] - r[2]) < 0.02 &&
          r[1] >= f.baseline &&
          r[1] - f.baseline < f.height * 0.3
      ).length !== 1
    )
      return refuse('unowned-paint')
    const stroke = [...p],
      radius = (p[3] - p[1]) / 2
    stroke[0] -= radius
    stroke[2] += radius
    carriers.push([quantize(p), quantize(stroke)])
  }
  const inside = graphics.filter((g) => recordRowIntersect(g.rect, frame))
  if (
    inside.length !== carriers.length ||
    inside.some(
      (g) =>
        g.kind !== 'path' ||
        carriers.filter((c) => c.some((r) => recordRowMachine(r, g.rect))).length !== 1
    ) ||
    carriers.some(
      (c) => inside.filter((g) => c.some((r) => recordRowMachine(r, g.rect))).length !== 1
    )
  )
    return refuse('all-native-paint-closure')
  const rowMap = new Map([0, ...nativeRows].map((row, n) => [row, n]))
  return {
    qualified: true,
    emptyRows,
    nativeRows,
    bands,
    falseRowWitnesses,
    rowMap,
    owned,
    frame,
    enclosed,
    graphics: inside,
    retainedCells: table.cells.filter((c) => !emptyRows.includes(c.row))
  }
}
function recordRowProjectExistingWholeRecordRowMap(table, proof) {
  if (!proof?.qualified) return
  const result = structuredClone(table)
  result.cells = proof.retainedCells.map((c) => ({
    ...structuredClone(c),
    row: proof.rowMap.get(c.row)
  }))
  result.grid = table.grid.filter((_, row) => !proof.emptyRows.includes(row)).map((r) => [...r])
  if (table.rows)
    result.rows = table.rows
      .filter((_, row) => !proof.emptyRows.includes(row))
      .map((r) => structuredClone(r))
  const old = Object.fromEntries(
      Object.entries(table).filter(([k]) => !['cells', 'grid', 'rows'].includes(k))
    ),
    updated = Object.fromEntries(
      Object.entries(result).filter(([k]) => !['cells', 'grid', 'rows'].includes(k))
    )
  if (!fencedGroupOpaqueEqual(old, updated)) return
  return result
}
function recordRowQualifyLateWholeRecordRowMap(input) {
  const refused = (reason) => ({ qualified: false, reason })
  if (
    !input ||
    !input.table ||
    !Number.isInteger(input.table.page) ||
    input.table.page < 1 ||
    !fencedGroupOpaqueEqual(input.table.sourceViewport, input.viewport) ||
    !recordRowExactRect(input.table.cropRect, input.crop) ||
    !Array.isArray(input.table.issues) ||
    input.table.issues.some((s) => typeof s !== 'string') ||
    input.table.captionIssue !== undefined
  )
    return refused('late-page-owner-metadata')
  const c = input.table.caption
  if (
    !c ||
    typeof c.text !== 'string' ||
    !recordRowRect(c.rect) ||
    !Array.isArray(c.lines) ||
    !c.lines.length ||
    c.lines.some((s) => typeof s !== 'string') ||
    c.page !== input.table.page ||
    c.regions !== undefined
  )
    return refused('canonical-caption-owner')
  if (
    !Array.isArray(input.captions) ||
    input.captions.filter(
      (n) =>
        n &&
        n.page === c.page &&
        Array.isArray(n.lines) &&
        fencedGroupOpaqueEqual(n.lines, c.lines) &&
        recordRowRect(n.rect) &&
        recordRowMachine(
          n.rect,
          c.rect.map((v) => v * 1.5)
        )
    ).length !== 1
  )
    return refused('samepage-whole-caption-binding')
  return recordRowQualifyExistingWholeRecordRowMap(input)
}

export function recoverNativeExistingWholeRecordRows(
  table,
  items,
  captions,
  rules,
  observedRuns,
  rulePaintBounds,
  sourceGraphics
) {
  if (
    !table ||
    typeof table !== 'object' ||
    Array.isArray(table) ||
    (table.readingRotation !== undefined && table.readingRotation !== 0)
  )
    return
  const input = {
    table,
    items,
    captions,
    rules,
    runs: observedRuns,
    paint: rulePaintBounds,
    graphics: sourceGraphics,
    viewport: table.sourceViewport,
    crop: table.cropRect,
    readingRotation: 0,
    invalidGraphicsBounds: 0
  }
  const proof = recordRowQualifyLateWholeRecordRowMap(input)
  if (!proof.qualified) return
  try {
    return recordRowProjectExistingWholeRecordRowMap(table, proof)
  } catch (error) {
    if (error?.name === 'DataCloneError') return
    throw error
  }
}

// Recover only a completely printed heading domain whose body is genuinely
// blank, retaining the already-owned wrapped fields and all opaque metadata.
function proveNativeBlankFirstLeafOwners(input) {
  const fail = (reason) => ({ qualified: false, reason })
  const { table, items, captions, rules, runs, paint, graphics, operatorContext } = input ?? {}
  const rect = (r) =>
    Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3]
  const exact = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  const fits = (a, b) => a[0] >= b[0] && a[1] >= b[1] && a[2] <= b[2] && a[3] <= b[3]
  const hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
  const font = (i) =>
    i &&
    typeof i.text === 'string' &&
    i.text.trim() &&
    rect(i.rect) &&
    Number.isFinite(i.baseline) &&
    Number.isFinite(i.height) &&
    i.height > 0
  if (
    !table ||
    !rect(table.cropRect) ||
    !Number.isInteger(table.page) ||
    table.page < 1 ||
    !Array.isArray(table.cells) ||
    !Array.isArray(table.grid) ||
    !Array.isArray(table.rows)
  )
    return fail('table-shape')
  if (Object.hasOwn(table, 'readingRotation') && table.readingRotation !== 0)
    return fail('rotation')
  if (
    ['parts', 'notes', 'unassigned', 'clipped', 'issues'].some(
      (k) => Object.hasOwn(table, k) && (!Array.isArray(table[k]) || table[k].length)
    )
  )
    return fail('unsupported-evidence')
  const v = operatorContext?.viewport,
    ops = operatorContext?.operators,
    sv = table.sourceViewport
  if (
    !v ||
    !sv ||
    v.rotation !== 0 ||
    v.scale !== 1.5 ||
    v.offsetX !== 0 ||
    v.offsetY !== 0 ||
    v.userUnit !== 1 ||
    ![v.width, v.height].every((n) => Number.isFinite(n) && n > 0) ||
    v.width !== sv.width ||
    v.height !== sv.height ||
    v.scale !== sv.scale ||
    !exact(v.transform, [1.5, 0, 0, -1.5, 0, v.height]) ||
    !exact(v.viewBox, [0, 0, v.width / 1.5, v.height / 1.5])
  )
    return fail('original-viewport')
  if (
    !ops ||
    !Array.isArray(ops.fnArray) ||
    !Array.isArray(ops.argsArray) ||
    ops.fnArray.length !== ops.argsArray.length ||
    !Array.isArray(items) ||
    items.some((i) => !font(i)) ||
    !Array.isArray(runs) ||
    !Array.isArray(captions) ||
    !Array.isArray(rules) ||
    rules.some((r) => !Array.isArray(r) || r.length !== 4 || r.some((x) => !Number.isFinite(x))) ||
    !(paint instanceof Map) ||
    !Array.isArray(graphics) ||
    graphics.some((g) => !g || g.kind !== 'path' || !rect(g.rect))
  )
    return fail('complete-source-containers')
  const n = table.grid.length
  if (
    !(n > 2) ||
    table.grid.some(
      (r) => !Array.isArray(r) || r.length !== 2 || r.some((s) => typeof s !== 'string')
    ) ||
    table.cells.length !== n * 2 ||
    table.rows.length !== n
  )
    return fail('bounded-predecessor-shape')
  const cells = table.cells,
    slots = new Set()
  for (const c of cells) {
    if (
      !c ||
      !Number.isInteger(c.row) ||
      c.row < 0 ||
      c.row >= n ||
      ![0, 1].includes(c.column) ||
      c.rowSpan !== 1 ||
      c.colSpan !== 1 ||
      !rect(c.rect) ||
      typeof c.text !== 'string' ||
      !c.text.trim() ||
      table.grid[c.row][c.column] !== c.text ||
      !Array.isArray(c.sourceTokens) ||
      !c.sourceTokens.length ||
      !Array.isArray(c.sourceRects) ||
      c.sourceTokens.length !== c.sourceRects.length ||
      c.sourceTokens.some((t) => !font(t)) ||
      c.sourceRects.some((r) => !rect(r)) ||
      (Object.hasOwn(c, 'textRuns') &&
        (!Array.isArray(c.textRuns) ||
          !c.textRuns.length ||
          c.textRuns.some(
            (r) =>
              !r ||
              r.position !== 'normal' ||
              typeof r.text !== 'string' ||
              Object.keys(r).some((k) => !['text', 'position'].includes(k))
          )))
    )
      return fail('complete-old-cell')
    const slot = c.row + ':' + c.column
    if (slots.has(slot)) return fail('duplicate-slot')
    slots.add(slot)
    for (const t of c.sourceTokens)
      if (c.sourceRects.filter((r) => exact(r, t.rect)).length !== 1)
        return fail('token-rect-bijection')
    for (const r of c.sourceRects)
      if (c.sourceTokens.filter((t) => exact(t.rect, r)).length !== 1)
        return fail('rect-token-bijection')
  }
  const fs = rules
    .filter(
      (r) =>
        Array.isArray(r) &&
        r.length === 4 &&
        r.every(Number.isFinite) &&
        r[1] === r[3] &&
        r[0] > table.cropRect[0] &&
        r[2] < table.cropRect[2] &&
        r[1] > table.cropRect[1] &&
        r[1] < table.cropRect[3]
    )
    .sort((a, b) => a[1] - b[1])
  if (
    fs.length !== 3 ||
    rules.length !== fs.length ||
    paint.size !== fs.length ||
    new Set(fs.map((f) => f.join(','))).size !== 3 ||
    fs.some((f) => f[0] !== fs[0][0] || f[2] !== fs[0][2])
  )
    return fail('unique-three-source-fences')
  const frame = [fs[0][0], fs[0][1], fs[0][2], fs[2][1]],
    owned = items.filter((i) => hit(i.rect, frame))
  if (owned.some((i) => i.horizontal !== true || !fits(i.rect, frame)))
    return fail('whole-frame-font')
  const oldFonts = cells.flatMap((c) => c.sourceTokens)
  const matches = (t, i) =>
    t.text === i.text && exact(t.rect, i.rect) && t.baseline === i.baseline && t.height === i.height
  if (
    oldFonts.length !== owned.length ||
    oldFonts.some((t) => owned.filter((i) => matches(t, i)).length !== 1) ||
    owned.some((i) => oldFonts.filter((t) => matches(t, i)).length !== 1)
  )
    return fail('whole-font-owner-bijection')
  const programFonts = new Map()
  for (const i of owned) {
    const rs = runs.filter((r) => r && r.text === i.text && exact(r.rect, i.rect))
    if (rs.length !== 1) return fail('unique-measured-stream')
    const r = rs[0]
    if (
      r.baseline !== i.baseline ||
      r.height !== i.height ||
      !Array.isArray(r.literalGlyphs) ||
      !r.literalGlyphs.length ||
      r.literalGlyphs.some((s) => typeof s !== 'string' || !s.length) ||
      r.literalGlyphs.join('') !== i.text.replace(/\s/gu, '') ||
      !Array.isArray(r.glyphRuns) ||
      r.glyphRuns.length !== Array.from(r.literalGlyphs.join('')).length ||
      r.glyphRuns.some((p) => !Number.isInteger(p) || p < 0) ||
      new Set(r.glyphRuns).size !== 1 ||
      !Array.isArray(r.gaps) ||
      r.gaps.some(
        (g) =>
          !g ||
          !Number.isFinite(g.left) ||
          !Number.isFinite(g.right) ||
          g.left >= g.right ||
          !Number.isInteger(g.index) ||
          g.index < 0 ||
          g.index >= r.glyphRuns.length ||
          g.left < i.rect[0] ||
          g.right > i.rect[2]
      )
    )
      return fail('complete-literal-stream')
    const p = r.glyphRuns[0]
    if (!programFonts.has(p)) programFonts.set(p, [])
    programFonts.get(p).push({ i, r })
  }
  // The claimed heading/body fonts must have a complete visible ordinary text profile.
  const textStack = []
  let textFill = '#000000',
    textMode = 0
  for (let p = 0; p < ops.fnArray.length; p++) {
    const op = ops.fnArray[p],
      a = ops.argsArray[p]
    if ([fencedGroupOPS.clip, fencedGroupOPS.eoClip, fencedGroupOPS.setGState].includes(op))
      return fail('unsupported-clip-or-gstate-program')
    if (op === fencedGroupOPS.save) textStack.push({ textFill, textMode })
    else if (op === fencedGroupOPS.restore) {
      const state = textStack.pop()
      if (!state) return fail('text-state-underflow')
      ;({ textFill, textMode } = state)
    } else if (op === fencedGroupOPS.setFillRGBColor) {
      if (
        !Array.isArray(a) ||
        a.length !== 1 ||
        typeof a[0] !== 'string' ||
        !/^#[0-9a-f]{6}$/i.test(a[0])
      )
        return fail('text-fill-shape')
      textFill = a[0].toLowerCase()
    } else if (
      [
        fencedGroupOPS.setFillColorSpace,
        fencedGroupOPS.setFillColor,
        fencedGroupOPS.setFillColorN,
        fencedGroupOPS.setFillGray,
        fencedGroupOPS.setFillCMYKColor,
        fencedGroupOPS.setFillTransparent
      ].includes(op)
    )
      return fail('unsupported-text-color')
    else if (op === fencedGroupOPS.setTextRenderingMode) {
      if (!Array.isArray(a) || a.length !== 1 || !Number.isInteger(a[0]))
        return fail('text-mode-shape')
      textMode = a[0]
    }
    if (programFonts.has(p) && (textFill !== '#000000' || textMode !== 0))
      return fail('visible-complete-text-program')
  }
  if (textStack.length) return fail('text-state-balance')
  for (const [p, fragments] of programFonts) {
    // Actual installed showText opcode; complete program includes shared heading TJ islands.
    if (
      ops.fnArray[p] !== fencedGroupOPS.showText ||
      !Array.isArray(ops.argsArray[p]) ||
      !Array.isArray(ops.argsArray[p][0])
    )
      return fail('original-showtext-program')
    const glyphs = ops.argsArray[p][0]
    if (
      glyphs.some((g) =>
        typeof g === 'number'
          ? !Number.isFinite(g)
          : !g ||
            typeof g.unicode !== 'string' ||
            !Number.isFinite(g.width) ||
            (!g.isSpace && g.unicode.trim() && (g.width <= 0 || g.isInFont !== true)) ||
            g.operatorListId !== undefined
      )
    )
      return fail('complete-original-glyph')
    const source = glyphs
      .filter((g) => typeof g !== 'number')
      .map((g) => g.unicode)
      .join('')
      .replace(/\s/gu, '')
    const literal = fragments
      .sort((a, b) => a.i.baseline - b.i.baseline || a.i.rect[0] - b.i.rect[0])
      .map((f) => f.r.literalGlyphs.join(''))
      .join('')
    if (source !== literal) return fail('whole-original-program-bijection')
  }
  const hs = owned
      .filter((i) => i.rect[1] > fs[0][1] && i.rect[3] < fs[1][1])
      .sort((a, b) => a.rect[0] - b.rect[0]),
    body = owned.filter((i) => i.rect[1] > fs[1][1] && i.rect[3] < fs[2][1])
  if (
    hs.length !== 3 ||
    hs.some((i) => i.baseline !== hs[0].baseline || i.height !== hs[0].height) ||
    hs.length + body.length !== owned.length ||
    cells.filter((c) => c.row === 0).flatMap((c) => c.sourceTokens).length !== 3
  )
    return fail('independent-header-font-islands')
  const h0 = cells.find((c) => c.row === 0 && c.column === 0),
    h1 = cells.find((c) => c.row === 0 && c.column === 1)
  if (
    h0.sourceTokens.length !== 2 ||
    h1.sourceTokens.length !== 1 ||
    !matches(h0.sourceTokens[0], hs[0]) ||
    !matches(h0.sourceTokens[1], hs[1]) ||
    !matches(h1.sourceTokens[0], hs[2]) ||
    h0.text !== h0.sourceTokens.map((t) => t.text).join(' ')
  )
    return fail('source-header-donors')
  if (
    Object.hasOwn(h0, 'textRuns') ||
    Object.keys(h0).some(
      (k) =>
        ![
          'row',
          'column',
          'rowSpan',
          'colSpan',
          'rect',
          'origin',
          'text',
          'sourceTokens',
          'sourceRects'
        ].includes(k)
    )
  )
    return fail('unsupported-split-header-metadata')
  const middle = cells.filter((c) => c.row > 0 && c.column === 0),
    right = cells.filter((c) => c.row > 0 && c.column === 1)
  const midFonts = middle.flatMap((c) => c.sourceTokens),
    rightFonts = right.flatMap((c) => c.sourceTokens)
  if (body.length !== midFonts.length + rightFonts.length) return fail('complete-body-owners')
  const left = hs[0].rect[2],
    midStart = Math.min(hs[1].rect[0], ...midFonts.map((i) => i.rect[0])),
    midEnd = Math.max(hs[1].rect[2], ...midFonts.map((i) => i.rect[2])),
    rightStart = Math.min(hs[2].rect[0], ...rightFonts.map((i) => i.rect[0]))
  if (!(left < midStart && midEnd < rightStart)) return fail('shared-full-font-gutters')
  const cut = (left + midStart) / 2,
    oldCut = h0.rect[2]
  if (
    !(midEnd < oldCut && oldCut < rightStart) ||
    h1.rect[0] !== oldCut ||
    cells.some((c) =>
      c.column === 0
        ? c.rect[0] !== h0.rect[0] || c.rect[2] !== oldCut
        : c.rect[0] !== oldCut || c.rect[2] !== h1.rect[2]
    )
  )
    return fail('preserved-correct-lane-cut')
  let previous = -Infinity
  for (let row = 1; row < n; row++) {
    const a = middle.find((c) => c.row === row),
      b = right.find((c) => c.row === row)
    if (!a || !b) return fail('record-pair')
    const firstA = Math.min(...a.sourceTokens.map((i) => i.baseline)),
      firstB = Math.min(...b.sourceTokens.map((i) => i.baseline))
    if (firstA !== firstB || firstA <= previous) return fail('independent-record-starts')
    const group = [...a.sourceTokens, ...b.sourceTokens]
    if (
      group.some(
        (i) =>
          i.rect[1] <= fs[1][1] ||
          i.rect[3] >= fs[2][1] ||
          i.rect[0] < midStart ||
          i.rect[2] > frame[2]
      )
    )
      return fail('whole-body-font')
    if (row > 1) {
      const old = [
        ...middle.find((c) => c.row === row - 1).sourceTokens,
        ...right.find((c) => c.row === row - 1).sourceTokens
      ]
      if (Math.max(...old.map((i) => i.rect[3])) >= Math.min(...group.map((i) => i.rect[1])))
        return fail('empty-record-band-gap')
    }
    previous = firstA
  }
  const cap = table.caption
  if (
    !cap ||
    cap.page !== table.page ||
    !rect(cap.rect) ||
    !Array.isArray(cap.lines) ||
    !cap.lines.length ||
    cap.lines.some((l) => typeof l !== 'string') ||
    captions.filter(
      (c) =>
        c &&
        c.page === cap.page &&
        Array.isArray(c.lines) &&
        exact(c.lines, cap.lines) &&
        rect(c.rect) &&
        c.rect.every((x, k) => x === cap.rect[k] * 1.5)
    ).length !== 1 ||
    cap.rect[3] * 1.5 >= table.cropRect[1]
  )
    return fail('unique-current-caption')
  const paintProof = proveNativeFencedPaintClosure(
    fs,
    frame,
    table.cropRect,
    [],
    paint,
    graphics,
    operatorContext
  )
  if (!paintProof.qualified) return fail(paintProof.reason)
  const out = structuredClone(table)
  out.grid = [hs.map((i) => i.text), ...table.grid.slice(1).map((r) => ['', ...r])]
  const projected = []
  for (const c of cells) {
    if (c.row === 0 && c.column === 0) {
      projected.push({
        ...structuredClone(c),
        rect: [c.rect[0], c.rect[1], cut, c.rect[3]],
        text: hs[0].text,
        sourceTokens: [structuredClone(c.sourceTokens[0])],
        sourceRects: [structuredClone(c.sourceRects[0])]
      })
      projected.push({
        ...structuredClone(c),
        column: 1,
        rect: [cut, c.rect[1], c.rect[2], c.rect[3]],
        text: hs[1].text,
        sourceTokens: [structuredClone(c.sourceTokens[1])],
        sourceRects: [structuredClone(c.sourceRects[1])]
      })
    } else {
      if (c.row > 0 && c.column === 0)
        projected.push({
          row: c.row,
          column: 0,
          rowSpan: 1,
          colSpan: 1,
          rect: [c.rect[0], c.rect[1], cut, c.rect[3]],
          origin: 'model-grid',
          text: '',
          sourceTokens: [],
          sourceRects: []
        })
      const moved = structuredClone(c)
      moved.column++
      if (c.column === 0) moved.rect[0] = cut
      projected.push(moved)
    }
  }
  out.cells = projected
  return { qualified: true, result: out }
}

export function recoverNativeBlankFirstLeafOwners(
  table,
  items,
  captions,
  rules,
  observedRuns = [],
  rulePaintBounds,
  sourceGraphics,
  operatorContext
) {
  const proof = proveNativeBlankFirstLeafOwners({
    table,
    items,
    captions,
    rules,
    runs: observedRuns,
    paint: rulePaintBounds,
    graphics: sourceGraphics,
    operatorContext
  })
  return proof.qualified ? proof.result : undefined
}

// Complete ordinary anchors qualify a unique wrapped field and terminal pair.
// All other owners retain their existing serialization and opaque payloads.
export function recoverNativeFourFieldOrdinaryOwners(
  table,
  items,
  captions,
  rules,
  runs,
  paint,
  graphics,
  operatorContext,
  serialize
) {
  const rect = (r) =>
    Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1]
  const intersects = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
  const contains = (a, b) => a[0] <= b[0] && a[1] <= b[1] && a[2] >= b[2] && a[3] >= b[3]
  const bounds = (xs) => [
    Math.min(...xs.map((x) => x.rect[0])),
    Math.min(...xs.map((x) => x.rect[1])),
    Math.max(...xs.map((x) => x.rect[2])),
    Math.max(...xs.map((x) => x.rect[3]))
  ]
  const key = (x) => JSON.stringify([x.text, x.rect, x.baseline, x.height])
  const keys = (xs) => xs.map(key).sort()
  const codepoints = (t) => [...t].filter((c) => !/\s/u.test(c))
  const sourceArrays = (c) =>
    Array.isArray(c.sourceTokens) &&
    Array.isArray(c.sourceRects) &&
    c.sourceTokens.length === c.sourceRects.length &&
    c.sourceTokens.every(
      (t, n) =>
        t &&
        typeof t.text === 'string' &&
        rect(t.rect) &&
        Number.isFinite(t.baseline) &&
        Number.isFinite(t.height) &&
        t.height > 0 &&
        fencedGroupOpaqueEqual(t.rect, c.sourceRects[n])
    )
  const knownCell = new Set([
    'row',
    'column',
    'rowSpan',
    'colSpan',
    'rect',
    'origin',
    'text',
    'sourceTokens',
    'sourceRects',
    'textRuns'
  ])
  const supportedDonor = (c) =>
    Object.keys(c).every((k) => knownCell.has(k)) &&
    (!Object.hasOwn(c, 'textRuns') ||
      (Array.isArray(c.textRuns) &&
        c.textRuns.every(
          (r) =>
            r &&
            typeof r.text === 'string' &&
            r.position === 'normal' &&
            Object.keys(r).every((k) => k === 'text' || k === 'position')
        ) &&
        c.textRuns.map((r) => r.text).join('') === c.text))

  const provePaint = proveNativeFencedPaintClosure
  if (
    !table ||
    !rect(table.cropRect) ||
    !Array.isArray(table.cells) ||
    !Array.isArray(table.rows) ||
    !Array.isArray(table.grid) ||
    !Array.isArray(items) ||
    !Array.isArray(captions) ||
    !Array.isArray(rules) ||
    !Array.isArray(runs) ||
    !(paint instanceof Map) ||
    !Array.isArray(graphics) ||
    typeof serialize !== 'function' ||
    typeof provePaint !== 'function'
  )
    return
  if (
    !Number.isInteger(table.page) ||
    table.page < 1 ||
    !table.sourceViewport ||
    !operatorContext ||
    operatorContext.viewport?.width !== table.sourceViewport.width ||
    operatorContext.viewport?.height !== table.sourceViewport.height ||
    operatorContext.viewport?.scale !== table.sourceViewport.scale
  )
    return
  if (
    captions.some(
      (c) =>
        !c ||
        !rect(c.rect) ||
        !Array.isArray(c.lines) ||
        !c.lines.length ||
        c.lines.some((t) => typeof t !== 'string')
    ) ||
    rules.some((r) => !Array.isArray(r) || r.length !== 4 || !r.every(Number.isFinite))
  )
    return
  if (
    (table.parts !== undefined && (!Array.isArray(table.parts) || table.parts.length)) ||
    (table.notes !== undefined && (!Array.isArray(table.notes) || table.notes.length)) ||
    (table.readingRotation !== undefined && table.readingRotation !== 0)
  )
    return
  // An opening rule and header divider can precede two complete records at
  // the end of a native page. The empty page remainder supplies a boundary;
  // do not turn a divider into a closing fence or lower generic row thresholds.
  if (!table.rows.length && !table.grid.length && !table.cells.length) {
    const v = operatorContext.viewport,
      ops = operatorContext.operators,
      cap = table.caption,
      close = (a, b) => Math.abs(a - b) < 0.02,
      equalRect = (a, b) => a.every((n, k) => close(n, b[k])),
      plainArray = (a, internal = []) =>
        Array.isArray(a) &&
        Reflect.ownKeys(a).every(
          (k) =>
            k === 'length' ||
            internal.includes(k) ||
            (typeof k === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(k) && Number(k) < a.length)
        ),
      numeric = (s) => /^[+−-]?\d+(?:\.\d+)?$/u.test(s),
      allowedIssues = new Set([
        'missing-row-or-column',
        'overlapping-predicted-columns',
        'unassigned-source-text'
      ])
    if (
      !v ||
      v.scale !== 1.5 ||
      v.rotation !== 0 ||
      ![v.width, v.height].every((n) => Number.isFinite(n) && n > 0) ||
      !fencedGroupOpaqueEqual(v.transform, [1.5, 0, 0, -1.5, 0, v.height]) ||
      !ops ||
      !Array.isArray(ops.fnArray) ||
      !Array.isArray(ops.argsArray) ||
      ops.fnArray.length !== ops.argsArray.length ||
      !Array.isArray(table.issues) ||
      table.issues.length !== 3 ||
      new Set(table.issues).size !== 3 ||
      table.issues.some((i) => !allowedIssues.has(i)) ||
      !Array.isArray(table.unassigned) ||
      table.unassigned.some((s) => typeof s !== 'string') ||
      !Array.isArray(table.clipped) ||
      table.clipped.length ||
      !Array.isArray(table.repairs) ||
      table.repairs.some((s) => typeof s !== 'string') ||
      table.captionIssue !== undefined ||
      !cap ||
      cap.page !== table.page ||
      cap.regions !== undefined ||
      !rect(cap.rect) ||
      !Array.isArray(cap.lines) ||
      cap.lines.length !== 1 ||
      cap.text !== cap.lines[0] ||
      captionKind(cap.lines[0]) !== 'table' ||
      captions.length !== 1 ||
      captions[0].page !== table.page ||
      !fencedGroupOpaqueEqual(captions[0].lines, cap.lines) ||
      !equalRect(
        captions[0].rect,
        cap.rect.map((n) => n * v.scale)
      ) ||
      rules.length !== 2 ||
      paint.size !== 2 ||
      graphics.length !== 2 ||
      graphics.some((g) => !g || g.kind !== 'path' || !rect(g.rect)) ||
      items.some((f) => !f || typeof f.text !== 'string' || !rect(f.rect))
    )
      return
    if (
      [table.rows, table.grid, table.cells, table.issues, table.cropRect, cap.lines, cap.rect].some(
        (a) => !plainArray(a)
      )
    )
      return
    // The current cell-text reconciliation attaches whole native witnesses
    // without changing the legacy string-array shape. Qualify that existing
    // non-enumerable data property; unknown array payloads still refuse.
    const reconciliation = Object.getOwnPropertyDescriptor(table.unassigned, 'reconciliationItems')
    if (
      !plainArray(table.unassigned, ['reconciliationItems']) ||
      (reconciliation &&
        (reconciliation.enumerable !== false ||
          reconciliation.writable !== false ||
          reconciliation.configurable !== false ||
          !Object.hasOwn(reconciliation, 'value') ||
          !plainArray(reconciliation.value)))
    )
      return
    const fences = [...rules].sort((a, b) => a[1] - b[1]),
      opening = fences[0],
      divider = fences[1],
      openingInk = paint.get(opening.join(',')),
      dividerInk = paint.get(divider.join(','))
    if (
      fences.some((r) => r[1] !== r[3] || r[2] <= r[0]) ||
      !close(opening[0], divider[0]) ||
      !close(opening[2], divider[2]) ||
      !rect(openingInk) ||
      !rect(dividerInk) ||
      openingInk[3] >= dividerInk[1] ||
      opening[1] < v.height * 0.7 ||
      Math.abs(table.cropRect[1] - opening[1]) > 20 ||
      !intersects(table.cropRect, [opening[0], openingInk[1], opening[2], v.height])
    )
      return
    const fonts = items.filter((f) => f.rect[3] > openingInk[1]),
      h = fonts[0]?.height,
      whole = (f) =>
        Reflect.ownKeys(f).every((k) =>
          [
            'text',
            'rect',
            'baseline',
            'height',
            'horizontal',
            'inlineSymbol',
            'sourceItem'
          ].includes(k)
        ) &&
        plainArray(f.rect) &&
        f.horizontal === true &&
        f.inlineSymbol === false &&
        f.sourceToken === undefined &&
        Number.isFinite(f.height) &&
        f.height > 0 &&
        close(f.height, h) &&
        close(f.baseline, f.rect[3]) &&
        close(f.rect[3] - f.rect[1], f.height) &&
        f.sourceItem?.pageNumber === table.page &&
        Reflect.ownKeys(f.sourceItem).every((k) => ['pageNumber', 'index', 'text'].includes(k)) &&
        f.sourceItem.text === f.text &&
        nativeWholeFontOrigins([f])?.length === 1
    if (
      fonts.length !== 15 ||
      !Number.isFinite(h) ||
      fonts.some((f) => !whole(f)) ||
      new Set(fonts.map((f) => f.sourceItem.index)).size !== 15 ||
      !fencedGroupOpaqueEqual([...table.unassigned].sort(), fonts.map((f) => f.text).sort()) ||
      fonts.some((f) => f.rect[0] < opening[0] - 0.02 || f.rect[2] > opening[2] + 0.02)
    )
      return
    if (reconciliation && !fencedGroupOpaqueEqual(reconciliation.value, fonts)) return
    const baselines = [...new Set(fonts.map((f) => f.baseline))].sort((a, b) => a - b),
      groups = baselines.map((b) =>
        fonts.filter((f) => f.baseline === b).sort((a, b) => a.rect[0] - b.rect[0])
      )
    if (
      groups.length !== 3 ||
      groups.some((g) => g.length !== 5) ||
      groups[0].some(
        (f) => f.rect[1] <= openingInk[3] || f.rect[3] >= dividerInk[1] || numeric(f.text)
      ) ||
      groups[1].some((f) => f.rect[1] <= dividerInk[3]) ||
      groups
        .slice(1)
        .some(
          (g) =>
            g.slice(0, 2).some((f) => !/\p{L}/u.test(f.text) || numeric(f.text)) ||
            g.slice(2).some((f) => !numeric(f.text))
        ) ||
      groups.some((g) =>
        g.some((f, c) => Math.abs(f.rect[0] - groups[0][c].rect[0]) > h * 0.002)
      ) ||
      baselines[2] - baselines[1] <= h ||
      baselines[2] - baselines[1] >= h * 1.8 ||
      Math.max(...groups[1].map((f) => f.rect[3])) >= Math.min(...groups[2].map((f) => f.rect[1]))
    )
      return
    const gutters = groups[0]
        .slice(1)
        .map((_f, c) => [
          Math.max(...groups.map((g) => g[c].rect[2])),
          Math.min(...groups.map((g) => g[c + 1].rect[0]))
        ]),
      cuts = [
        Math.min(opening[0], ...fonts.map((f) => f.rect[0])),
        ...gutters.map(([a, b]) => (a + b) / 2),
        Math.max(opening[2], ...fonts.map((f) => f.rect[2]))
      ],
      bottom = Math.max(...fonts.map((f) => f.rect[3]))
    if (gutters.some(([a, b]) => b - a < h * 0.3) || bottom >= v.height - h * 3) return
    // All page fonts below the opening belong to these complete records. The
    // original operator packets below are checked too, including page furniture.
    const captionFonts = items
      .filter((f) => f.rect[3] > captions[0].rect[1] - 0.02 && f.rect[1] < openingInk[1])
      .sort((a, b) => a.baseline - b.baseline)
    if (
      captionFonts.length !== 2 ||
      captionFonts.some((f) => !whole(f)) ||
      captionFonts[0].text !== cap.lines[0] ||
      !equalRect(captionFonts[0].rect, captions[0].rect) ||
      codepoints(captionFonts[0].text).length < 40 ||
      /[.!?]\s*$/u.test(captionFonts[0].text) ||
      !/^[\p{Ll}][\p{L}\p{N}\s,;:()/-]*$/u.test(captionFonts[1].text) ||
      captionFonts[1].text.trim().split(/\s+/u).length < 2 ||
      captionFonts[1].text.trim().split(/\s+/u).length > 6 ||
      !close(captionFonts[1].rect[0], opening[0]) ||
      captionFonts[0].rect[0] < opening[0] ||
      captionFonts[0].rect[2] > opening[2] + h * 0.05 ||
      captionFonts[1].baseline - captionFonts[0].baseline <= h ||
      captionFonts[1].baseline - captionFonts[0].baseline >= h * 1.8 ||
      openingInk[1] - captionFonts[1].rect[3] <= 0 ||
      openingInk[1] - captionFonts[1].rect[3] >= h * 1.8
    )
      return
    const selected = [...captionFonts, ...fonts],
      programs = new Map(),
      packets = new Map(),
      allowed = new Set(
        [
          'dependency',
          'save',
          'restore',
          'transform',
          'beginText',
          'endText',
          'setFont',
          'setTextMatrix',
          'moveText',
          'showText',
          'setFillRGBColor',
          'setStrokeRGBColor',
          'constructPath',
          'setLineWidth'
        ].map((n) => fencedGroupOPS[n])
      ),
      states = [],
      dependencies = new Set()
    if (
      new Set(selected.map((f) => f.sourceItem.index)).size !== selected.length ||
      !nativeWholeFontOrigins(selected)
    )
      return
    let transform = [1, 0, 0, 1, 0, 0],
      size = 0,
      fill = '#000000',
      stroke = '#000000',
      width = 1,
      text = false,
      line = [0, 0],
      cursor = 0
    for (let n = 0; n < ops.fnArray.length; n++) {
      const op = ops.fnArray[n],
        a = ops.argsArray[n],
        finite = (count) => Array.isArray(a) && a.length === count && a.every(Number.isFinite)
      if (!allowed.has(op) || (a !== null && !Array.isArray(a))) return
      if (op === fencedGroupOPS.save) {
        if (text || a !== null) return
        states.push({ transform: [...transform], size, fill, stroke, width })
      } else if (op === fencedGroupOPS.restore) {
        if (text || a !== null || !states.length) return
        ;({ transform, size, fill, stroke, width } = states.pop())
      } else if (op === fencedGroupOPS.transform) {
        if (text || !finite(6) || !fencedGroupOpaqueEqual(a.slice(0, 4), [1, 0, 0, 1])) return
        transform = fencedGroupUtil.transform(transform, a)
      } else if (op === fencedGroupOPS.beginText) {
        if (text || a !== null) return
        text = true
        line = [0, 0]
        cursor = 0
      } else if (op === fencedGroupOPS.endText) {
        if (!text || a !== null) return
        text = false
      } else if (op === fencedGroupOPS.setFont) {
        if (
          !text ||
          !Array.isArray(a) ||
          a.length !== 2 ||
          typeof a[0] !== 'string' ||
          !a[0] ||
          !dependencies.has(a[0]) ||
          !Number.isFinite(a[1]) ||
          a[1] <= 0
        )
          return
        size = a[1]
      } else if (op === fencedGroupOPS.setTextMatrix) {
        if (!text || !finite(6) || !fencedGroupOpaqueEqual(a.slice(0, 4), [1, 0, 0, 1])) return
        line = a.slice(4)
        cursor = 0
      } else if (op === fencedGroupOPS.moveText) {
        if (!text || !finite(2)) return
        line = line.map((x, k) => x + a[k])
        cursor = 0
      } else if (op === fencedGroupOPS.setFillRGBColor || op === fencedGroupOPS.setStrokeRGBColor) {
        if (!Array.isArray(a) || a.length !== 1 || a[0] !== '#000000') return
        if (op === fencedGroupOPS.setFillRGBColor) fill = a[0]
        else stroke = a[0]
      } else if (op === fencedGroupOPS.setLineWidth) {
        if (text || !finite(1) || a[0] <= 0) return
        width = a[0]
      } else if (op === fencedGroupOPS.dependency) {
        if (!Array.isArray(a) || !a.length || a.some((x) => typeof x !== 'string' || !x)) return
        for (const id of a) dependencies.add(id)
      } else if (op === fencedGroupOPS.constructPath) {
        const p = a?.[1]?.[0],
          matrix = fencedGroupUtil.transform(v.transform, transform)
        if (
          text ||
          stroke !== '#000000' ||
          a?.[0] !== fencedGroupOPS.stroke ||
          a?.[1]?.length !== 1 ||
          !(Array.isArray(p) || p instanceof Float32Array) ||
          p.length !== 6 ||
          p[0] !== 0 ||
          p[3] !== 1 ||
          p.some((x) => !Number.isFinite(x))
        )
          return
        const start = [p[1], p[2]],
          end = [p[4], p[5]]
        fencedGroupUtil.applyTransform(start, matrix)
        fencedGroupUtil.applyTransform(end, matrix)
        const rule = [Math.min(start[0], end[0]), start[1], Math.max(start[0], end[0]), end[1]],
          ink = [rule[0], rule[1] - (width * v.scale) / 2, rule[2], rule[3] + (width * v.scale) / 2]
        if (
          start[1] !== end[1] ||
          fences.filter((r) => equalRect(r, rule)).length !== 1 ||
          !rect(paint.get(rule.join(','))) ||
          !equalRect(paint.get(rule.join(',')), ink)
        )
          return
      } else if (op === fencedGroupOPS.showText) {
        if (
          !text ||
          size <= 0 ||
          fill !== '#000000' ||
          !Array.isArray(a) ||
          a.length !== 1 ||
          !Array.isArray(a[0]) ||
          !a[0].length
        )
          return
        const spans = [],
          origin = [line[0], line[1]],
          matrix = fencedGroupUtil.transform(v.transform, transform)
        fencedGroupUtil.applyTransform(origin, matrix)
        for (const glyph of a[0]) {
          if (typeof glyph === 'number') {
            if (!Number.isFinite(glyph) || Math.abs(glyph) > 10000) return
            cursor -= (glyph * size) / 1000
          } else {
            if (
              !glyph ||
              typeof glyph.unicode !== 'string' ||
              !glyph.unicode ||
              !Number.isFinite(glyph.width) ||
              glyph.width <= 0 ||
              glyph.width > 5000 ||
              glyph.isInFont !== true ||
              glyph.operatorListId != null ||
              glyph.accent != null
            )
              return
            const start = origin[0] + cursor * v.scale
            cursor += (glyph.width * size) / 1000
            spans.push({ text: glyph.unicode, start, end: origin[0] + cursor * v.scale })
          }
        }
        if (
          !spans.length ||
          !spans.every((s) => Number.isFinite(s.start) && Number.isFinite(s.end))
        )
          return
        packets.set(n, { spans, baseline: origin[1], height: size * v.scale })
      }
    }
    if (
      text ||
      states.length ||
      !provePaint(
        fences,
        [opening[0], openingInk[1], opening[2], bottom],
        [0, 0, v.width, v.height],
        [],
        paint,
        graphics,
        operatorContext
      )?.qualified
    )
      return
    for (const f of selected) {
      const matches = runs.filter(
        (r) => r && r.text === f.text && rect(r.rect) && equalRect(r.rect, f.rect)
      )
      if (matches.length !== 1) return
      const r = matches[0]
      if (
        !close(r.baseline, f.baseline) ||
        !close(r.height, f.height) ||
        !Array.isArray(r.literalGlyphs) ||
        !Array.isArray(r.glyphRuns) ||
        !fencedGroupOpaqueEqual(
          r.literalGlyphs.flatMap((g) => (typeof g === 'string' ? codepoints(g) : [null])),
          codepoints(f.text)
        ) ||
        r.glyphRuns.length !== codepoints(f.text).length ||
        new Set(r.glyphRuns).size !== 1 ||
        !Number.isInteger(r.glyphRuns[0]) ||
        !packets.has(r.glyphRuns[0])
      )
        return
      const n = r.glyphRuns[0],
        fs = programs.get(n) ?? []
      fs.push(f)
      programs.set(n, fs)
    }
    for (const [n, packet] of packets) {
      const fs = (programs.get(n) ?? []).sort((a, b) => a.rect[0] - b.rect[0])
      // A raw source packet cannot hide below the final row, or anywhere in
      // the complete caption/body interval, by disappearing from text tokens.
      if (!fs.length) {
        if (packet.baseline > captionFonts[0].rect[1] - 0.02) return
        continue
      }
      const visible = packet.spans.filter((s) => codepoints(s.text).length),
        rawText = visible.flatMap((s) => codepoints(s.text))
      if (
        !fencedGroupOpaqueEqual(
          rawText,
          fs.flatMap((f) => codepoints(f.text))
        )
      )
        return
      let offset = 0
      for (const f of fs) {
        const count = codepoints(f.text).length,
          glyphs = []
        let length = 0
        while (offset < visible.length && length < count) {
          const s = visible[offset++]
          glyphs.push(s)
          length += codepoints(s.text).length
        }
        if (
          length !== count ||
          !glyphs.length ||
          !close(packet.baseline, f.baseline) ||
          !close(packet.height, f.height) ||
          !close(glyphs[0].start, f.rect[0]) ||
          !close(glyphs.at(-1).end, f.rect[2])
        )
          return
      }
      if (offset !== visible.length) return
    }
    // Nominal source rectangles stop at the baseline and omit descenders.
    // The proved empty original page remainder, rather than a guessed font
    // descent or synthetic fence, conserves the complete final printed ink.
    const band = [
      openingInk[3],
      dividerInk[3],
      (groups[1][0].rect[3] + groups[2][0].rect[1]) / 2,
      v.height
    ]
    try {
      const result = structuredClone(table),
        cells = [],
        captionRect = bounds(captionFonts).map((n) => n / v.scale)
      for (let row = 0; row < 3; row++)
        for (let column = 0; column < 5; column++) {
          const f = groups[row][column],
            token = { text: f.text, rect: [...f.rect], baseline: f.baseline, height: f.height },
            origins = nativeChangedCellOrigins([], items, [token], true),
            cell = {
              row,
              column,
              rowSpan: 1,
              colSpan: 1,
              rect: [cuts[column], band[row], cuts[column + 1], band[row + 1]],
              origin: row ? 'model-grid' : 'source-printed-header',
              text: serialize([token]),
              sourceTokens: [token],
              sourceRects: [[...f.rect]]
            }
          if (!origins?.sourceItems || !contains(cell.rect, f.rect)) return
          cell.sourceItems = origins.sourceItems
          cells.push(cell)
        }
      result.cropRect = [opening[0] - 0.5, openingInk[1] - 0.5, opening[2] + 0.5, v.height]
      result.rows = groups.map((_g, n) => ({
        rect: [cuts[0], band[n], cuts[5], band[n + 1]],
        origin: 'source-text'
      }))
      result.cells = cells
      result.grid = groups.map((g) => g.map((f) => f.text))
      result.caption = {
        ...structuredClone(cap),
        rect: captionRect,
        lines: captionFonts.map((f) => f.text),
        text: captionFonts.map((f) => f.text).join(' ')
      }
      result.unassigned = []
      result.issues = []
      result.selectedTextItems = fonts.length
      result.repairs.push('native-rowless-two-rule-records')
      return result
    } catch (error) {
      if (error?.name === 'DataCloneError') return
      throw error
    }
  }
  if (
    !['unassigned', 'clipped', 'issues'].every(
      (k) => Array.isArray(table[k]) && table[k].length === 0
    ) ||
    !Array.isArray(table.repairs)
  )
    return
  // Three printed fields can contain independent numbered lines inside a
  // sparse label group. Prove each complete native line; never repeat labels
  // into the genuinely blank middle field or relax the four-field proof below.
  if (table.grid[0]?.length === 3) {
    const v = operatorContext.viewport,
      ops = operatorContext.operators,
      caption = table.caption,
      old = table.cells,
      slots = new Set(),
      supported = new Set([...knownCell, 'sourceItems'])
    if (
      !v ||
      v.scale !== 1.5 ||
      v.rotation !== 0 ||
      ![v.width, v.height].every((n) => Number.isFinite(n) && n > 0) ||
      !fencedGroupOpaqueEqual(v.transform, [1.5, 0, 0, -1.5, 0, v.height]) ||
      !ops ||
      !Array.isArray(ops.fnArray) ||
      !Array.isArray(ops.argsArray) ||
      ops.fnArray.length !== ops.argsArray.length ||
      table.captionIssue !== undefined ||
      !caption ||
      caption.page !== table.page ||
      caption.regions !== undefined ||
      !rect(caption.rect) ||
      !Array.isArray(caption.lines) ||
      captionKind(caption.lines[0]) !== 'table' ||
      captions.length !== 1 ||
      captions[0].page !== table.page ||
      !fencedGroupOpaqueEqual(captions[0].lines, caption.lines) ||
      !fencedGroupMachineRect(
        captions[0].rect,
        caption.rect.map((n) => n * 1.5)
      ) ||
      table.grid.length !== table.rows.length ||
      table.grid.length < 3 ||
      table.grid.some(
        (r) => !Array.isArray(r) || r.length !== 3 || r.some((s) => typeof s !== 'string')
      ) ||
      table.rows.some((r) => !r || !rect(r.rect))
    )
      return
    for (const c of old) {
      if (
        !c ||
        !Number.isInteger(c.row) ||
        !Number.isInteger(c.column) ||
        c.row < 0 ||
        c.row >= table.rows.length ||
        c.column < 0 ||
        c.column >= 3 ||
        c.rowSpan !== 1 ||
        c.colSpan !== 1 ||
        !rect(c.rect) ||
        typeof c.text !== 'string' ||
        !sourceArrays(c) ||
        table.grid[c.row][c.column] !== c.text ||
        slots.has(`${c.row}:${c.column}`) ||
        (c.row > 0 && (c.origin !== 'model-grid' || Object.keys(c).some((k) => !supported.has(k))))
      )
        return
      // Origins are preflighted separately; rich payloads cannot be discarded.
      if (c.row > 0 && Object.hasOwn(c, 'textRuns')) {
        if (
          !Array.isArray(c.textRuns) ||
          c.textRuns.some(
            (r) =>
              !r ||
              r.position !== 'normal' ||
              typeof r.text !== 'string' ||
              Object.keys(r).some((k) => k !== 'text' && k !== 'position')
          ) ||
          c.textRuns.map((r) => r.text).join('') !== c.text
        )
          return
      }
      slots.add(`${c.row}:${c.column}`)
    }
    if (
      old.length !== table.rows.length * 3 ||
      table.rows.slice(1).some((r) => Object.keys(r).some((k) => k !== 'rect' && k !== 'origin'))
    )
      return
    const headers = old.filter((c) => c.row === 0).sort((a, b) => a.column - b.column)
    if (headers.some((c) => c.sourceTokens.length !== 1)) return
    const heads = headers.map((c) => c.sourceTokens[0]),
      h = heads[0].height
    if (
      !(h > 0) ||
      heads.some((f) => f.baseline !== heads[0].baseline || f.height !== h) ||
      heads.some((f, n) => n && heads[n - 1].rect[2] >= f.rect[0])
    )
      return
    const frameRules = rules
      .filter(
        (r) =>
          r[1] === r[3] &&
          r[0] < r[2] &&
          r[1] > table.cropRect[1] &&
          r[1] < table.cropRect[3] &&
          r[0] <= heads[0].rect[0] &&
          r[2] >= heads[2].rect[2]
      )
      .sort((a, b) => a[1] - b[1])
    if (
      frameRules.length !== 3 ||
      frameRules.some((r) => r[0] !== frameRules[0][0] || r[2] !== frameRules[0][2])
    )
      return
    const frame = [frameRules[0][0], frameRules[0][1], frameRules[0][2], frameRules[2][1]],
      fonts = items.filter(
        (i) =>
          i &&
          typeof i.text === 'string' &&
          i.text.trim() &&
          rect(i.rect) &&
          intersects(i.rect, frame)
      )
    if (
      !(captions[0].rect[3] < frame[1]) ||
      !(heads[0].rect[1] > frame[1] && heads[0].rect[3] < frameRules[1][1]) ||
      items.some((i) => !i || typeof i.text !== 'string' || !rect(i.rect)) ||
      fonts.some(
        (f) =>
          !contains(frame, f.rect) ||
          !contains(table.cropRect, f.rect) ||
          f.height !== h ||
          !Number.isFinite(f.baseline) ||
          f.baseline !== f.rect[3] ||
          f.horizontal !== true ||
          f.inlineSymbol !== false
      ) ||
      new Set(fonts.map(key)).size !== fonts.length
    )
      return
    const oldFonts = old.flatMap((c) => c.sourceTokens)
    if (
      table.selectedTextItems !== fonts.length ||
      new Set(oldFonts.map(key)).size !== oldFonts.length ||
      !fencedGroupOpaqueEqual(keys(oldFonts), keys(fonts))
    )
      return
    const ownerFonts = new Map()
    for (const c of old) {
      const fs = c.sourceTokens.map((t) => fonts.find((f) => key(f) === key(t)))
      if (
        fs.some((f) => !f) ||
        !nativeCellOriginsMatch(c, fs) ||
        c.text !== serialize(c.sourceTokens)
      )
        return
      ownerFonts.set(c, fs)
    }
    // Establish actual native gutters before using any model column boundary.
    const lane = (f) =>
        f.rect[0] >= heads[2].rect[0] - h * 0.002
          ? 2
          : f.rect[0] >= heads[1].rect[0] - h * 0.002
            ? 1
            : 0,
      columns = [0, 1, 2].map((n) => fonts.filter((f) => lane(f) === n)),
      cuts = [table.cropRect[0]]
    for (let n = 0; n < 2; n++) {
      const left = Math.max(...columns[n].map((f) => f.rect[2])),
        right = Math.min(...columns[n + 1].map((f) => f.rect[0]))
      if (!(left < right)) return
      cuts.push((left + right) / 2)
    }
    cuts.push(table.cropRect[2])
    if (
      fonts.some((f) => f.rect[0] < cuts[lane(f)] || f.rect[2] > cuts[lane(f) + 1]) ||
      old.some((c) => ownerFonts.get(c).some((f) => lane(f) !== c.column))
    )
      return
    const lines = []
    for (const f of [...fonts].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
      const prior = lines.at(-1)
      if (!prior || Math.abs(prior[0].baseline - f.baseline) > h * 0.001) lines.push([f])
      else prior.push(f)
    }
    if (!fencedGroupOpaqueEqual(keys(lines[0]), keys(heads))) return
    const body = lines.slice(1),
      labels = []
    if (body.length <= table.grid.length - 1) return
    for (let n = 0; n < body.length; n++) {
      const line = body[n],
        fields = [0, 1, 2].map((c) => line.filter((f) => lane(f) === c))
      if (
        fields[0].length !== 1 ||
        fields[2].length !== 1 ||
        fields[1].length > 1 ||
        !/^[1-9][0-9]*$/u.test(fields[0][0].text) ||
        (n &&
          Math.max(...body[n - 1].map((f) => f.rect[3])) >= Math.min(...line.map((f) => f.rect[1])))
      )
        return
      if (fields[1].length) labels.push(n)
    }
    if (
      new Set(body.map((line) => line.find((f) => lane(f) === 0).text)).size !== body.length ||
      labels.length < 2 ||
      labels[0] !== 0
    )
      return
    const step = Math.min(...body.slice(1).map((line, n) => line[0].baseline - body[n][0].baseline))
    if (!(step > h && step < h * 1.3)) return
    for (let n = 1; n < body.length; n++) {
      const gap = body[n][0].baseline - body[n - 1][0].baseline
      if (
        labels.includes(n)
          ? !(gap > step * 1.25 && gap < step * 1.75)
          : Math.abs(gap - step) > h * 0.002
      )
        return
    }
    if (labels.some((n, k) => (labels[k + 1] ?? body.length) - n < 2)) return
    const allowed = new Set(
        [
          'dependency',
          'save',
          'restore',
          'transform',
          'beginText',
          'endText',
          'setFont',
          'setTextMatrix',
          'moveText',
          'showText',
          'setFillRGBColor',
          'setStrokeRGBColor',
          'constructPath',
          'setLineWidth',
          'setLineCap',
          'setDash'
        ].map((n) => fencedGroupOPS[n])
      ),
      programs = new Map(),
      programSizes = new Map()
    let fill = '#000000',
      transform = [1, 0, 0, 1, 0, 0],
      width = 1,
      fontSize = 0
    const states = []
    for (let n = 0; n < ops.fnArray.length; n++) {
      const op = ops.fnArray[n],
        a = ops.argsArray[n]
      if (!allowed.has(op) || (a !== null && !Array.isArray(a))) return
      if (op === fencedGroupOPS.save)
        states.push({ fill, transform: [...transform], width, fontSize })
      else if (op === fencedGroupOPS.restore) {
        if (!states.length) return
        ;({ fill, transform, width, fontSize } = states.pop())
      } else if (op === fencedGroupOPS.setFillRGBColor) {
        if (
          !Array.isArray(a) ||
          a.length !== 1 ||
          typeof a[0] !== 'string' ||
          !/^#[0-9a-f]{6}$/i.test(a[0])
        )
          return
        fill = a[0].toLowerCase()
      } else if (op === fencedGroupOPS.setFont) {
        if (
          !Array.isArray(a) ||
          a.length !== 2 ||
          typeof a[0] !== 'string' ||
          !Number.isFinite(a[1]) ||
          a[1] <= 0
        )
          return
        fontSize = a[1]
      } else if (op === fencedGroupOPS.setTextMatrix) {
        if (
          !Array.isArray(a) ||
          a.length !== 6 ||
          a.some((n) => !Number.isFinite(n)) ||
          !fencedGroupOpaqueEqual(a.slice(0, 4), [1, 0, 0, 1])
        )
          return
      } else if (op === fencedGroupOPS.moveText) {
        if (!Array.isArray(a) || a.length !== 2 || a.some((n) => !Number.isFinite(n))) return
      } else if (op === fencedGroupOPS.showText) {
        if (fill === '#ffffff') return
        programSizes.set(n, { fontSize, transform: [...transform] })
      } else if (op === fencedGroupOPS.transform) {
        if (!Array.isArray(a) || a.length !== 6 || a.some((n) => !Number.isFinite(n))) return
        transform = fencedGroupUtil.transform(transform, a)
      } else if (op === fencedGroupOPS.setLineWidth) {
        if (!Array.isArray(a) || a.length !== 1 || !Number.isFinite(a[0]) || a[0] <= 0) return
        width = a[0]
      } else if (op === fencedGroupOPS.constructPath) {
        const p = a?.[1]?.[0],
          matrix = fencedGroupUtil.transform(v.transform, transform)
        if (
          a?.[0] !== fencedGroupOPS.stroke ||
          !(Array.isArray(p) || p instanceof Float32Array) ||
          p.length !== 6 ||
          p[0] !== 0 ||
          p[3] !== 1 ||
          p.some((n) => !Number.isFinite(n)) ||
          matrix[1] !== 0 ||
          matrix[2] !== 0
        )
          return
        const start = [p[1], p[2]],
          end = [p[4], p[5]]
        fencedGroupUtil.applyTransform(start, matrix)
        fencedGroupUtil.applyTransform(end, matrix)
        if (start[1] !== end[1]) return
        const rule = [Math.min(start[0], end[0]), start[1], Math.max(start[0], end[0]), end[1]],
          radius = Math.abs(matrix[3] * width) / 2,
          ink = [rule[0], rule[1] - radius, rule[2], rule[3] + radius]
        const carrier = paint.get(rule.join(','))
        if (
          rules.filter((r) => fencedGroupOpaqueEqual(r, rule)).length !== 1 ||
          !rect(carrier) ||
          !fencedGroupMachineRect(carrier, ink)
        )
          return
      }
    }
    if (states.length) return
    for (const f of fonts) {
      const matched = runs.filter(
        (r) => r && r.text === f.text && fencedGroupOpaqueEqual(r.rect, f.rect)
      )
      if (matched.length !== 1) return
      const r = matched[0]
      if (
        r.baseline !== f.baseline ||
        r.height !== f.height ||
        !Array.isArray(r.literalGlyphs) ||
        !Array.isArray(r.glyphRuns) ||
        r.literalGlyphs.some((g) => typeof g !== 'string') ||
        !fencedGroupOpaqueEqual(
          r.literalGlyphs.flatMap((g) => [...g]),
          codepoints(f.text)
        ) ||
        r.glyphRuns.length !== codepoints(f.text).length ||
        new Set(r.glyphRuns).size !== 1 ||
        r.glyphRuns.some((n) => !Number.isInteger(n) || ops.fnArray[n] !== fencedGroupOPS.showText)
      )
        return
      const n = r.glyphRuns[0],
        group = programs.get(n) ?? []
      group.push(f)
      programs.set(n, group)
    }
    for (const [n, fs] of programs) {
      const raw = ops.argsArray[n]?.[0]
      if (
        !Array.isArray(raw) ||
        raw.some((g) =>
          typeof g === 'number'
            ? !Number.isFinite(g)
            : !g ||
              typeof g.unicode !== 'string' ||
              (!/^\s*$/u.test(g.unicode) &&
                (!(g.width > 0) ||
                  !Number.isFinite(g.width) ||
                  g.isInFont !== true ||
                  g.operatorListId != null))
        ) ||
        !fencedGroupOpaqueEqual(
          raw.filter((g) => g && typeof g === 'object').flatMap((g) => codepoints(g.unicode)),
          fs.sort((a, b) => a.rect[0] - b.rect[0]).flatMap((f) => codepoints(f.text))
        )
      )
        return
      // A literal match alone is insufficient: bind each complete field's
      // width and inter-field advance to the original glyph/TJ program too.
      const metric = programSizes.get(n),
        ordered = [...fs].sort((a, b) => a.rect[0] - b.rect[0])
      if (
        !metric ||
        !fencedGroupOpaqueEqual(metric.transform, [1, 0, 0, 1, 0, 0]) ||
        ordered.some((f) => Math.abs(f.height - metric.fontSize * v.scale) > h * 0.002)
      )
        return
      const spans = [],
        counts = ordered.map((f) => codepoints(f.text).length)
      let advance = 0,
        field = 0,
        consumed = 0,
        start
      for (const g of raw) {
        if (typeof g === 'number') {
          advance -= (g * metric.fontSize) / 1000
          continue
        }
        const count = codepoints(g.unicode).length,
          end = advance + (g.width * metric.fontSize) / 1000
        if (!Number.isFinite(advance) || !Number.isFinite(end)) return
        if (count) {
          if (field >= ordered.length || consumed + count > counts[field]) return
          if (consumed === 0) start = advance
          consumed += count
          if (consumed === counts[field]) {
            spans.push([start, end])
            field++
            consumed = 0
          }
        }
        advance = end
      }
      if (
        field !== ordered.length ||
        consumed ||
        spans.some(
          (s, k) =>
            Math.abs((s[1] - s[0]) * v.scale - (ordered[k].rect[2] - ordered[k].rect[0])) >
              h * 0.002 ||
            Math.abs((s[0] - spans[0][0]) * v.scale - (ordered[k].rect[0] - ordered[0].rect[0])) >
              h * 0.002
        )
      )
        return
    }
    // Geometry deliberately excludes running furniture. Permit one complete
    // original margin rule only, and bind its native paint independently.
    const outside = rules.filter((r) => !frameRules.includes(r))
    if (
      outside.length > 1 ||
      outside.some(
        (r) =>
          r[0] !== frame[0] ||
          r[2] !== frame[2] ||
          r[1] !== r[3] ||
          !(r[1] > 0 && r[1] < v.height * 0.15 && r[1] < captions[0].rect[1])
      )
    )
      return
    if (
      graphics.some((g) => !g || g.kind !== 'path' || !rect(g.rect)) ||
      graphics.length !== 3 ||
      paint.size !== rules.length ||
      [...paint.values()].some((p) => !rect(p))
    )
      return
    const marginCarriers = outside.map((r) => {
      const ink = paint.get(r.join(','))
      if (!rect(ink)) return
      const radius = (ink[3] - ink[1]) / 2,
        conservative = [ink[0] - radius, ink[1], ink[2] + radius, ink[3]]
      return {
        kind: 'path',
        rect: conservative.map(
          (x, k) =>
            ((k < 2
              ? Math.floor((x / Math.ceil(k % 2 ? v.height : v.width)) * 256)
              : Math.ceil((x / Math.ceil(k % 2 ? v.height : v.width)) * 256) + 1) *
              (k % 2 ? v.height : v.width)) /
            256
        )
      }
    })
    if (
      marginCarriers.some((g) => !g) ||
      !provePaint(
        rules,
        frame,
        [0, 0, v.width, v.height],
        [],
        paint,
        [...graphics, ...marginCarriers],
        operatorContext
      )?.qualified
    )
      return
    const bands = [Math.max(heads[0].rect[3], paint.get(frameRules[1].join(','))[3])]
    for (let n = 1; n < body.length; n++)
      bands.push(
        (Math.max(...body[n - 1].map((f) => f.rect[3])) +
          Math.min(...body[n].map((f) => f.rect[1]))) /
          2
      )
    bands.push(paint.get(frameRules[2].join(','))[1])
    if (bands.some((y, n) => !Number.isFinite(y) || (n && y <= bands[n - 1]))) return
    // Preflight every donor before cloning/projecting. A failed branch cannot
    // partially mutate the table or duplicate opaque per-record metadata.
    try {
      const result = structuredClone(table),
        cells = result.cells.filter((c) => c.row === 0),
        rows = [result.rows[0]]
      for (let n = 0; n < body.length; n++) {
        rows.push({ rect: [cuts[0], bands[n], cuts[3], bands[n + 1]], origin: 'source-text' })
        for (let column = 0; column < 3; column++) {
          const fs = body[n].filter((f) => lane(f) === column),
            donors = old.filter(
              (c) =>
                c.row > 0 && c.column === column && ownerFonts.get(c).some((f) => fs.includes(f))
            ),
            tokens = fs.map((f) =>
              donors.flatMap((c) => c.sourceTokens).find((t) => key(t) === key(f))
            ),
            origins = nativeChangedCellOrigins(donors, items, tokens),
            cell = {
              row: n + 1,
              column,
              rowSpan: 1,
              colSpan: 1,
              rect: [cuts[column], bands[n], cuts[column + 1], bands[n + 1]],
              origin: 'model-grid',
              text: serialize(tokens),
              sourceTokens: structuredClone(tokens),
              sourceRects: tokens.map((t) => [...t.rect])
            }
          if (fs.length && (!origins || donors.length !== 1)) return
          if (origins?.sourceItems) cell.sourceItems = origins.sourceItems
          if (donors.some((c) => Object.hasOwn(c, 'textRuns')))
            cell.textRuns = [{ text: cell.text, position: 'normal' }]
          if (!tokens.every((t) => contains(cell.rect, t.rect))) return
          cells.push(cell)
        }
      }
      if (!fencedGroupOpaqueEqual(keys(cells.flatMap((c) => c.sourceTokens)), keys(oldFonts)))
        return
      result.cells = cells
      result.rows = rows
      result.grid = rows.map((_r, n) => cells.filter((c) => c.row === n).map((c) => c.text))
      return result
    } catch (error) {
      if (error?.name === 'DataCloneError') return
      throw error
    }
  }
  if (
    !table.rows.length ||
    table.grid.length !== table.rows.length ||
    table.grid.some(
      (r) => !Array.isArray(r) || r.length !== 4 || r.some((t) => typeof t !== 'string')
    ) ||
    table.rows.some((r) => !r || !rect(r.rect))
  )
    return
  const old = table.cells,
    slots = new Set()
  for (const c of old) {
    if (
      !c ||
      !Number.isInteger(c.row) ||
      !Number.isInteger(c.column) ||
      c.row < 0 ||
      c.row >= table.rows.length ||
      c.column < 0 ||
      c.column >= 4 ||
      c.rowSpan !== 1 ||
      c.colSpan !== 1 ||
      !rect(c.rect) ||
      typeof c.text !== 'string' ||
      !sourceArrays(c) ||
      table.grid[c.row][c.column] !== c.text ||
      slots.has(`${c.row}:${c.column}`)
    )
      return
    slots.add(`${c.row}:${c.column}`)
  }
  if (old.length !== table.rows.length * 4) return
  const headers = old.filter((c) => c.row === 0).sort((a, b) => a.column - b.column)
  if (
    headers.length !== 4 ||
    headers.some((c) => c.origin !== 'source-printed-header' || c.sourceTokens.length !== 1)
  )
    return
  const heads = headers.map((c) => c.sourceTokens[0]),
    h = heads[0].height
  if (
    !Number.isFinite(h) ||
    h <= 0 ||
    heads.some(
      (f) => f.baseline !== heads[0].baseline || Math.abs(f.height - h) > Number.EPSILON * h * 16
    )
  )
    return
  const cuts = [headers[0].rect[0], ...headers.map((c) => c.rect[2])]
  if (
    headers.some((c, n) => c.rect[0] !== cuts[n]) ||
    cuts.some((x, n) => !Number.isFinite(x) || (n && x <= cuts[n - 1]))
  )
    return
  const frameRules = rules
    .filter(
      (r) =>
        Array.isArray(r) &&
        r.length === 4 &&
        r.every(Number.isFinite) &&
        r[1] === r[3] &&
        r[0] < r[2] &&
        r[0] >= table.cropRect[0] &&
        r[0] < cuts[1] &&
        r[2] >= cuts.at(-1) &&
        r[1] > table.cropRect[1] &&
        r[1] < table.cropRect[3]
    )
    .sort((a, b) => a[1] - b[1])
  if (
    frameRules.length !== 3 ||
    frameRules.some((r) => r[0] !== frameRules[0][0] || r[2] !== frameRules[0][2])
  )
    return
  const frame = [frameRules[0][0], frameRules[0][1], frameRules[0][2], frameRules[2][1]]
  if (!(heads[0].rect[1] > frame[1] && heads[0].rect[3] < frameRules[1][1])) return
  if (items.some((i) => !i || typeof i.text !== 'string' || !rect(i.rect))) return
  const fonts = items.filter((i) => i.text.trim() && intersects(i.rect, frame))
  if (
    !fonts.length ||
    fonts.some(
      (f) =>
        !contains(frame, f.rect) ||
        !Number.isFinite(f.height) ||
        Math.abs(f.height - h) > Number.EPSILON * h * 16 ||
        !Number.isFinite(f.baseline) ||
        f.baseline !== f.rect[3] ||
        f.horizontal !== true ||
        f.inlineSymbol !== false
    ) ||
    new Set(fonts.map(key)).size !== fonts.length
  )
    return
  const lane = (f) =>
    cuts.slice(1).findIndex((right, c) => f.rect[0] >= cuts[c] && f.rect[2] <= right)
  if (fonts.some((f) => lane(f) < 0)) return
  const oldFonts = old.flatMap((c) => c.sourceTokens)
  if (
    new Set(oldFonts.map(key)).size !== oldFonts.length ||
    !fencedGroupOpaqueEqual(keys(oldFonts), keys(fonts))
  )
    return
  if (typeof captionKind !== 'function') return
  const matchingCaps = captions.filter(
    (c) =>
      rect(c?.rect) &&
      Array.isArray(c.lines) &&
      c.lines.every((x) => typeof x === 'string') &&
      captionKind(c.lines[0]) === 'table' &&
      c.rect[3] < frame[1] &&
      c.rect[2] > frame[0] &&
      c.rect[0] < frame[2]
  )
  if (matchingCaps.length !== 1) return
  const ops = operatorContext?.operators,
    v = operatorContext?.viewport
  if (
    !ops ||
    !Array.isArray(ops.fnArray) ||
    !Array.isArray(ops.argsArray) ||
    ops.fnArray.length !== ops.argsArray.length ||
    !v ||
    v.scale !== 1.5 ||
    v.rotation !== 0 ||
    ![v.width, v.height].every((x) => Number.isFinite(x) && x > 0) ||
    !Array.isArray(v.transform) ||
    v.transform.length !== 6 ||
    !v.transform.every(Number.isFinite)
  )
    return
  const names = Object.fromEntries(
    Object.entries(fencedGroupOPS).map(([name, value]) => [value, name])
  )
  if (
    ops.fnArray.some((n) =>
      [
        'clip',
        'eoClip',
        'setGState',
        'paintImageXObject',
        'paintInlineImageXObject',
        'paintImageMaskXObject',
        'paintFormXObjectBegin',
        'shadingFill'
      ].includes(names[n])
    )
  )
    return
  const programs = new Map()
  for (const f of fonts) {
    const matched = runs.filter(
      (r) => r && r.text === f.text && fencedGroupOpaqueEqual(r.rect, f.rect)
    )
    if (matched.length !== 1) return
    const r = matched[0]
    if (
      r.baseline !== f.baseline ||
      r.height !== f.height ||
      !Array.isArray(r.literalGlyphs) ||
      !Array.isArray(r.glyphRuns) ||
      r.literalGlyphs.some((g) => typeof g !== 'string') ||
      !fencedGroupOpaqueEqual(
        r.literalGlyphs.flatMap((g) => [...g]),
        codepoints(f.text)
      ) ||
      r.glyphRuns.length !== r.literalGlyphs.flatMap((g) => [...g]).length ||
      new Set(r.glyphRuns).size !== 1 ||
      r.glyphRuns.some((n) => !Number.isInteger(n) || n < 0 || names[ops.fnArray[n]] !== 'showText')
    )
      return
    const idx = r.glyphRuns[0],
      group = programs.get(idx) ?? []
    group.push({ font: f, run: r })
    programs.set(idx, group)
  }
  for (const [idx, group] of programs) {
    const raw = ops.argsArray[idx]?.[0],
      ordered = [...group].sort(
        (a, b) => a.font.baseline - b.font.baseline || a.font.rect[0] - b.font.rect[0]
      )
    if (
      !Array.isArray(raw) ||
      raw.some((g) =>
        typeof g === 'number'
          ? !Number.isFinite(g)
          : !g ||
            typeof g.unicode !== 'string' ||
            (!/^\s*$/u.test(g.unicode) &&
              (!Number.isFinite(g.width) ||
                g.width <= 0 ||
                g.isInFont !== true ||
                g.operatorListId != null))
      ) ||
      !fencedGroupOpaqueEqual(
        raw.filter((g) => g && typeof g === 'object').flatMap((g) => codepoints(g.unicode)),
        ordered.flatMap((x) => x.run.literalGlyphs.flatMap((g) => [...g]))
      )
    )
      return
  }
  let fill = '#000000',
    mode = 0
  const states = []
  for (let n = 0; n < ops.fnArray.length; n++) {
    const name = names[ops.fnArray[n]],
      a = ops.argsArray[n]
    if (name === 'save') states.push({ fill, mode })
    else if (name === 'restore') {
      const s = states.pop()
      if (!s) return
      ;({ fill, mode } = s)
    } else if (name === 'setFillRGBColor') {
      if (
        !Array.isArray(a) ||
        a.length !== 1 ||
        typeof a[0] !== 'string' ||
        !/^#[0-9a-f]{6}$/i.test(a[0])
      )
        return
      fill = a[0].toLowerCase()
    } else if (
      [
        'setFillColorSpace',
        'setFillColor',
        'setFillColorN',
        'setFillGray',
        'setFillCMYKColor',
        'setFillTransparent'
      ].includes(name)
    )
      return
    else if (name === 'setTextRenderingMode') {
      if (!Array.isArray(a) || a.length !== 1 || !Number.isInteger(a[0])) return
      mode = a[0]
    } else if (name === 'showText' && programs.has(n) && (fill === '#ffffff' || mode !== 0)) return
  }
  if (states.length) return
  if (graphics.some((g) => !g || g.kind !== 'path' || !rect(g.rect))) return
  // Full source frame proof; this does not change the old crop or hide its small right paint overhang.
  const sourcePaint = [...paint.values()]
  if (sourcePaint.some((p) => !rect(p))) return
  const paintCrop = [
    Math.min(frame[0], ...sourcePaint.map((p) => p[0])),
    Math.min(frame[1], ...sourcePaint.map((p) => p[1])),
    Math.max(frame[2], ...sourcePaint.map((p) => p[2])),
    Math.max(frame[3], ...sourcePaint.map((p) => p[3]))
  ]
  const painted = provePaint(frameRules, frame, paintCrop, [], paint, graphics, operatorContext)
  if (!painted?.qualified) return
  const lines = []
  for (const f of [...fonts].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    const prior = lines.at(-1)
    if (!prior || Math.abs(prior[0].baseline - f.baseline) > h * 0.01) lines.push([f])
    else prior.push(f)
  }
  if (lines[0].length !== 4 || !fencedGroupOpaqueEqual(keys(lines[0]), keys(heads))) return
  const body = lines.slice(1),
    step = Math.min(...body.slice(1).map((g, n) => g[0].baseline - body[n][0].baseline))
  if (
    !(step > h && step < h * 1.3) ||
    body.slice(1).some((g, n) => Math.abs(g[0].baseline - body[n][0].baseline - step) > h * 0.002)
  )
    return
  const records = [lines[0]]
  for (const line of body) {
    const occupied = [...new Set(line.map(lane))]
    if (occupied.length === 4) records.push([...line])
    else {
      const prior = records.at(-1)
      if (records.length < 2 || !occupied.length || occupied.length >= 4) return
      for (const c of occupied) {
        const child = line.filter((f) => lane(f) === c),
          parents = prior.filter((f) => lane(f) === c)
        const lastBase = Math.max(...parents.map((f) => f.baseline)),
          last = parents.filter((f) => Math.abs(f.baseline - lastBase) < h * 0.01)
        const pb = bounds(last),
          cb = bounds(child)
        if (
          Math.abs(cb[0] - pb[0]) > h * 0.002 ||
          Math.abs(child[0].baseline - lastBase - step) > h * 0.002 ||
          pb[2] + (cb[2] - cb[0]) <= cuts[c + 1]
        )
          return
      }
      prior.push(...line)
    }
  }
  const fields = records.flatMap((fs, row) =>
    cuts
      .slice(1)
      .map((_right, column) => ({ row, column, fonts: fs.filter((f) => lane(f) === column) }))
  )
  if (fields.some((f) => !f.fonts.length)) return
  const assignment = new Map(),
    donorsForField = new Map()
  for (const c of old) {
    const destinations = fields.filter(
      (f) =>
        f.column === c.column && f.fonts.some((t) => c.sourceTokens.some((o) => key(o) === key(t)))
    )
    if (!c.sourceTokens.length) {
      if (c.text !== '' || !supportedDonor(c) || c.origin !== 'model-grid') return
      assignment.set(c, [])
      continue
    }
    if (
      !destinations.length ||
      !fencedGroupOpaqueEqual(
        keys(c.sourceTokens),
        keys(
          destinations.flatMap((f) =>
            f.fonts.filter((t) => c.sourceTokens.some((o) => key(o) === key(t)))
          )
        )
      )
    )
      return
    assignment.set(c, destinations)
    for (const f of destinations) {
      const a = donorsForField.get(f) ?? []
      a.push(c)
      donorsForField.set(f, a)
    }
  }
  const changed = fields.filter((f) => {
    const ds = donorsForField.get(f) ?? []
    return ds.length !== 1 || !fencedGroupOpaqueEqual(keys(ds[0].sourceTokens), keys(f.fonts))
  })
  const merged = changed.filter((f) => (donorsForField.get(f)?.length ?? 0) > 1),
    split = [...assignment].filter(([, fs]) => fs.length > 1)
  if (
    merged.length !== 1 ||
    split.length !== 4 ||
    split.some(
      ([c, fs]) =>
        c.row !== split[0][0].row ||
        fs.length !== 2 ||
        fs[0].row !== records.length - 2 ||
        fs[1].row !== records.length - 1
    ) ||
    new Set(split.map(([c]) => c.column)).size !== 4
  )
    return
  const mergedField = merged[0],
    mergeDonors = donorsForField.get(mergedField),
    empty = old.filter((c) => !c.sourceTokens.length)
  const removedRow = Math.max(...mergeDonors.map((c) => c.row))
  if (
    mergeDonors.length !== 2 ||
    mergeDonors[1].row - mergeDonors[0].row !== 1 ||
    empty.length !== 3 ||
    empty.some((c) => c.row !== removedRow || c.column === mergedField.column) ||
    mergeDonors.some((c) => !supportedDonor(c))
  )
    return
  if (
    split.some(([c]) => !supportedDonor(c)) ||
    Object.keys(table.rows[removedRow]).some((k) => k !== 'rect' && k !== 'origin')
  )
    return
  const modifiedDonors = [...mergeDonors, ...split.map(([c]) => c)]
  if (
    modifiedDonors.some((c) => c.origin !== 'model-grid' || c.text !== serialize(c.sourceTokens)) ||
    Object.keys(table.rows[split[0][0].row]).some((k) => k !== 'rect' && k !== 'origin')
  )
    return
  if ([...mergeDonors, ...split.map(([c]) => c)].some((c) => !contains(table.cropRect, c.rect)))
    return
  const outCells = []
  const splitTop = records.at(-2),
    splitBottom = records.at(-1),
    midpoint =
      (Math.max(...splitTop.map((f) => f.rect[3])) +
        Math.min(...splitBottom.map((f) => f.rect[1]))) /
      2
  if (
    !(Math.max(...splitTop.map((f) => f.rect[3])) < Math.min(...splitBottom.map((f) => f.rect[1])))
  )
    return
  for (const f of fields) {
    const ds = donorsForField.get(f),
      d = ds[0]
    if (ds.length === 1 && fencedGroupOpaqueEqual(keys(d.sourceTokens), keys(f.fonts))) {
      outCells.push({ ...d, row: f.row })
      continue
    }
    const sourceTokens = f.fonts.map((t) => {
      const owner = ds.find((c) => c.sourceTokens.some((o) => key(o) === key(t)))
      return owner.sourceTokens.find((o) => key(o) === key(t))
    })
    const cell = {
      ...d,
      row: f.row,
      text: serialize(sourceTokens),
      sourceTokens,
      sourceRects: sourceTokens.map((t) => t.rect)
    }
    if (ds.length === 2)
      cell.rect = [
        d.rect[0],
        Math.min(...ds.map((c) => c.rect[1]), ...sourceTokens.map((t) => t.rect[1])),
        d.rect[2],
        Math.max(...ds.map((c) => c.rect[3]), ...sourceTokens.map((t) => t.rect[3]))
      ]
    else
      cell.rect = [
        d.rect[0],
        f.row === records.length - 2 ? d.rect[1] : midpoint,
        d.rect[2],
        f.row === records.length - 2 ? midpoint : d.rect[3]
      ]
    if (!sourceTokens.every((t) => contains(cell.rect, t.rect))) return
    if (Object.hasOwn(d, 'textRuns')) cell.textRuns = [{ text: cell.text, position: 'normal' }]
    outCells.push(cell)
  }
  const outRows = table.rows
    .filter((_r, n) => n !== removedRow)
    .map((r) => ({ ...r, rect: [...r.rect] }))
  const mergeRow = outRows[mergedField.row],
    mergedCell = outCells.find((c) => c.row === mergedField.row && c.column === mergedField.column)
  mergeRow.rect = [mergeRow.rect[0], mergedCell.rect[1], mergeRow.rect[2], mergedCell.rect[3]]
  const terminal = outRows.pop()
  outRows.push(
    { ...terminal, rect: [terminal.rect[0], terminal.rect[1], terminal.rect[2], midpoint] },
    { ...terminal, rect: [terminal.rect[0], midpoint, terminal.rect[2], terminal.rect[3]] }
  )
  const outGrid = records.map((_r, n) =>
    outCells
      .filter((c) => c.row === n)
      .sort((a, b) => a.column - b.column)
      .map((c) => c.text)
  )
  if (
    outRows.length !== outGrid.length ||
    !fencedGroupOpaqueEqual(keys(outCells.flatMap((c) => c.sourceTokens)), keys(oldFonts))
  )
    return
  const ordered = [],
    seen = new Set()
  for (const c of old)
    for (const f of assignment.get(c)) {
      const id = `${f.row}:${f.column}`
      if (!seen.has(id)) {
        ordered.push(outCells.find((x) => x.row === f.row && x.column === f.column))
        seen.add(id)
      }
    }
  return { ...table, rows: outRows, cells: ordered, grid: outGrid }
}

// Recover only two source-qualified horizontal rule triples explicitly named
// by one complete same-page caption. Existing refinements supply unchanged
// cell payloads; complete native programs establish their source ownership.
export function recoverNativeStackedSharedCaptionParts(
  table,
  items,
  captions,
  rules,
  runs,
  refined,
  sourceContext
) {
  const OPS = fencedGroupOPS
  const context = sourceContext && {
    operators: sourceContext.operators,
    content: sourceContext.content,
    viewport: sourceContext.viewport,
    paint: sourceContext.rulePaintBounds,
    graphics: sourceContext.nativeEvidenceGraphics,
    refined
  }
  const finite = (n) => typeof n === 'number' && Number.isFinite(n)
  const rect = (r) =>
    Array.isArray(r) && r.length === 4 && r.every(finite) && r[0] < r[2] && r[1] < r[3]
  const strip = (s) => s.replace(/\s/gu, '')
  const metricSame = (a, b) =>
    finite(a) &&
    finite(b) &&
    Math.abs(a - b) <= Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b)) * 4
  const sameRect = (a, b) => rect(a) && rect(b) && a.every((v, n) => v === b[n])
  const box = (a) => [
    Math.min(...a.map((i) => i.rect[0])),
    Math.min(...a.map((i) => i.rect[1])),
    Math.max(...a.map((i) => i.rect[2])),
    Math.max(...a.map((i) => i.rect[3]))
  ]
  const overlaps = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
  const vector = (v) => (Array.isArray(v) ? v : v instanceof Float32Array ? [...v] : undefined)
  class Refusal extends Error {}
  const requireProof = (test, stage) => {
    if (!test) throw new Refusal(stage)
  }
  const eps = (v) => Math.max(Math.abs(v - Math.fround(v)), Math.abs(v)) * 2 ** -23 * 16
  const floatSame = (a, b) =>
    finite(a) && finite(b) && Math.abs(a - b) <= Math.max(eps(a), eps(b), 1e-5)

  try {
    const { operators: op, content, viewport, paint, graphics } = context ?? {}
    requireProof(
      table &&
        typeof table === 'object' &&
        !table.parts &&
        rect(table.cropRect) &&
        Array.isArray(table.cells) &&
        table.cells.length &&
        Array.isArray(table.grid) &&
        table.grid.length &&
        table.grid.every((r) => Array.isArray(r) && r.every((v) => typeof v === 'string')),
      'table-shape'
    )
    requireProof(
      Array.isArray(table.issues) &&
        !table.issues.length &&
        Array.isArray(table.unassigned) &&
        !table.unassigned.length &&
        Array.isArray(table.clipped) &&
        !table.clipped.length &&
        Array.isArray(table.notes) &&
        !table.notes.length &&
        table.sourceViewport?.scale === viewport?.scale &&
        table.sourceViewport?.width === viewport?.width &&
        table.sourceViewport?.height === viewport?.height,
      'accepted-upper-context'
    )
    requireProof(
      Array.isArray(items) &&
        items.every(
          (i) =>
            i &&
            typeof i.text === 'string' &&
            rect(i.rect) &&
            finite(i.height) &&
            i.height > 0 &&
            finite(i.baseline) &&
            i.baseline === i.rect[3] &&
            Math.abs(i.rect[3] - i.rect[1] - i.height) <=
              Number.EPSILON * (Math.abs(i.rect[1]) + Math.abs(i.rect[3]) + i.height) * 2 &&
            i.horizontal === true
        ),
      'whole-font-input'
    )
    requireProof(
      Array.isArray(captions) &&
        captions.every(
          (c) =>
            c &&
            rect(c.rect) &&
            c.page === table.page &&
            Array.isArray(c.lines) &&
            c.lines.length &&
            c.lines.every((s) => typeof s === 'string')
        ),
      'caption-input'
    )
    requireProof(
      Array.isArray(rules) &&
        rules.length === 6 &&
        rules.every(
          (r) =>
            Array.isArray(r) && r.length === 4 && r.every(finite) && r[0] < r[2] && r[1] === r[3]
        ) &&
        Array.isArray(runs) &&
        runs.every(
          (r) =>
            r &&
            typeof r.text === 'string' &&
            rect(r.rect) &&
            finite(r.height) &&
            finite(r.baseline)
        ),
      'six-native-horizontal-rules'
    )
    requireProof(
      viewport &&
        finite(viewport.scale) &&
        viewport.scale > 0 &&
        viewport.rotation === 0 &&
        finite(viewport.width) &&
        finite(viewport.height) &&
        Array.isArray(viewport.viewBox) &&
        viewport.viewBox.length === 4 &&
        viewport.viewBox.every(finite) &&
        content &&
        Array.isArray(content.items),
      'upright-native-viewport'
    )
    requireProof(
      op &&
        Array.isArray(op.fnArray) &&
        Array.isArray(op.argsArray) &&
        op.fnArray.length === op.argsArray.length &&
        Array.isArray(graphics) &&
        graphics.length === 6 &&
        graphics.every((g) => g?.kind === 'path' && rect(g.rect)),
      'complete-native-operator-input'
    )
    const paintMap =
      paint instanceof Map ? paint : Array.isArray(paint) ? new Map(paint) : undefined
    requireProof(paintMap?.size === 6, 'native-paint-carriers')

    // Strict current family only: ordinary path/text/RGB operations, default
    // visible text and solid black rules. Unknown paint/effect/clip/Form is
    // refused rather than inferred from a human view or measured bounds.
    const allowed = new Set([
      OPS.dependency,
      OPS.save,
      OPS.restore,
      OPS.transform,
      OPS.beginText,
      OPS.endText,
      OPS.setFont,
      OPS.setTextMatrix,
      OPS.moveText,
      OPS.showText,
      OPS.setFillRGBColor,
      OPS.setStrokeRGBColor,
      OPS.constructPath,
      OPS.setLineWidth,
      OPS.setLineCap,
      OPS.setDash
    ])
    let stack = [],
      state = {
        transform: [1, 0, 0, 1, 0, 0],
        dash: [],
        phase: 0,
        width: 1,
        cap: 0,
        fill: '#000000',
        stroke: '#000000'
      },
      paths = []
    for (let n = 0; n < op.fnArray.length; n++) {
      const f = op.fnArray[n],
        raw = op.argsArray[n],
        a =
          raw === null && [OPS.save, OPS.restore, OPS.beginText, OPS.endText].includes(f) ? [] : raw
      requireProof(allowed.has(f) && Array.isArray(a), 'known-default-paint-profile')
      if (f === OPS.save) stack.push(structuredClone(state))
      else if (f === OPS.restore) {
        requireProof(stack.length, 'balanced-paint-state')
        state = stack.pop()
      } else if (f === OPS.transform) {
        const m = vector(a.length === 1 ? a[0] : a)
        requireProof(
          m?.length === 6 &&
            m.every(finite) &&
            m[0] === 1 &&
            m[1] === 0 &&
            m[2] === 0 &&
            m[3] === 1,
          'translation-only-rule-transform'
        )
        state.transform = [1, 0, 0, 1, state.transform[4] + m[4], state.transform[5] + m[5]]
      } else if (f === OPS.setDash) {
        requireProof(Array.isArray(a[0]) && !a[0].length && a[1] === 0, 'solid-native-rule')
        state.dash = a[0]
        state.phase = a[1]
      } else if (f === OPS.setLineWidth) {
        requireProof(a.length === 1 && finite(a[0]) && a[0] > 0, 'finite-rule-width')
        state.width = a[0]
      } else if (f === OPS.setLineCap) {
        requireProof(a.length === 1 && a[0] === 0, 'butt-rule-cap')
        state.cap = a[0]
      } else if (f === OPS.setStrokeRGBColor || f === OPS.setFillRGBColor) {
        requireProof(
          a.length === 1 &&
            typeof a[0] === 'string' &&
            /^#[0-9a-f]{6}$/iu.test(a[0]) &&
            a[0].toLowerCase() !== '#ffffff',
          'visible-rgb-text'
        )
        state[f === OPS.setStrokeRGBColor ? 'stroke' : 'fill'] = a[0].toLowerCase()
      } else if (f === OPS.setFont)
        requireProof(
          a.length === 2 && typeof a[0] === 'string' && finite(a[1]) && a[1] > 0,
          'native-font-state'
        )
      else if (f === OPS.setTextMatrix) {
        const m = vector(a.length === 1 ? a[0] : a)
        requireProof(
          m?.length === 6 && m.every(finite) && m[0] > 0 && m[1] === 0 && m[2] === 0 && m[3] > 0,
          'upright-text-matrix'
        )
      } else if (f === OPS.moveText)
        requireProof(a.length === 2 && a.every(finite), 'finite-text-motion')
      else if (f === OPS.showText)
        requireProof(
          a.length === 1 &&
            Array.isArray(a[0]) &&
            a[0].every((g) =>
              typeof g === 'number'
                ? finite(g)
                : g &&
                  typeof g.unicode === 'string' &&
                  g.unicode.length &&
                  finite(g.width) &&
                  g.width > 0 &&
                  g.isInFont === true &&
                  g.operatorListId == null &&
                  g.accent == null &&
                  typeof g.fontChar === 'string' &&
                  [...g.fontChar].length === 1 &&
                  Number.isInteger(g.originalCharCode) &&
                  g.originalCharCode >= 0 &&
                  typeof g.isSpace === 'boolean'
            ),
          'complete-literal-glyph-program'
        )
      else if (f === OPS.constructPath) {
        const p = Array.isArray(a[1]) && a[1].length === 1 ? vector(a[1][0]) : undefined
        requireProof(
          a.length === 3 &&
            a[0] === OPS.stroke &&
            p?.length === 6 &&
            p.every(finite) &&
            p[0] === 0 &&
            p[1] === 0 &&
            p[2] === 0 &&
            p[3] === 1 &&
            p[4] > 0 &&
            p[5] === 0 &&
            vector(a[2])?.length === 4 &&
            vector(a[2]).every((v, n) => v === [0, 0, p[4], 0][n]) &&
            state.stroke === '#000000' &&
            !state.dash.length &&
            state.phase === 0 &&
            state.cap === 0,
          'complete-solid-horizontal-rule'
        )
        const x = state.transform[4] * viewport.scale,
          y = (viewport.viewBox[3] - state.transform[5]) * viewport.scale,
          w = p[4] * viewport.scale,
          half = (state.width * viewport.scale) / 2
        paths.push({ rule: [x, y, x + w, y], paint: [x, y - half, x + w, y + half] })
      } else if (f === OPS.dependency)
        requireProof(
          a.every((x) => typeof x === 'string'),
          'font-dependency'
        )
      else requireProof(a.length === 0, 'default-text-block-state')
    }
    requireProof(!stack.length && paths.length === 6, 'all-source-paint-accounted')
    const sorted = rules.slice().sort((a, b) => a[1] - b[1])
    for (const rule of sorted) {
      const p = paths.filter((p) => p.rule.every((v, n) => floatSame(v, rule[n])))
      requireProof(p.length === 1, 'rule-program-unique-owner')
      const carrier = paintMap.get(rule.join(','))
      requireProof(
        rect(carrier) && carrier.every((v, n) => floatSame(v, p[0].paint[n])),
        'rule-whole-paint-carrier'
      )
    }
    const meaningful = items.filter((i) => i.text.trim())
    const observed = (font) => {
      const matches = runs.filter(
        (r) =>
          r &&
          r.text === font.text &&
          sameRect(r.rect, font.rect) &&
          r.height === font.height &&
          r.baseline === font.baseline
      )
      requireProof(matches.length === 1, 'unique-measured-whole-font')
      const r = matches[0]
      requireProof(
        Array.isArray(r.literalGlyphs) &&
          r.literalGlyphs.every((g) => typeof g === 'string' && g.length) &&
          r.literalGlyphs.join('') === strip(font.text) &&
          Array.isArray(r.glyphRuns) &&
          r.glyphRuns.length === r.literalGlyphs.reduce((v, g) => v + [...g].length, 0) &&
          r.glyphRuns.every((k) => Number.isInteger(k) && k >= 0 && op.fnArray[k] === OPS.showText),
        'full-measured-font-program'
      )
      return r
    }
    const composite = (font) => {
      const raw = content.items.filter(
        (c) =>
          c?.str === font.text &&
          c.hasEOL === true &&
          Array.isArray(c.transform) &&
          c.transform.length === 6 &&
          c.transform.every(finite) &&
          finite(c.width) &&
          finite(c.height) &&
          c.width > 0 &&
          c.height > 0
      )
      requireProof(raw.length === 1, 'complete-caption-content-parent')
      const parent = raw[0],
        blocks = []
      let fontId, size
      for (let start = 0; start < op.fnArray.length; start++) {
        if (op.fnArray[start] === OPS.setFont) [fontId, size] = op.argsArray[start]
        if (op.fnArray[start] !== OPS.setTextMatrix) continue
        const m = vector(
          op.argsArray[start].length === 1 ? op.argsArray[start][0] : op.argsArray[start]
        )
        if (!m) continue
        const packets = [],
          glyphRuns = [],
          indices = []
        let advance = 0,
          valid = true
        for (let n = start + 1; n < op.fnArray.length; n++) {
          const f = op.fnArray[n],
            a = op.argsArray[n]
          if (
            [OPS.setTextMatrix, OPS.moveText, OPS.setFont, OPS.endText, OPS.beginText].includes(f)
          )
            break
          if (f === OPS.showText) {
            indices.push(n)
            for (const g of a[0])
              if (typeof g === 'number') advance -= (g * size) / 1000
              else {
                packets.push(g.unicode)
                glyphRuns.push(...[...g.unicode].map(() => n))
                advance += (g.width * size) / 1000
              }
          } else if (![OPS.setStrokeRGBColor, OPS.setFillRGBColor].includes(f)) valid = false
        }
        if (
          !valid ||
          indices.length < 2 ||
          indices.length > 8 ||
          fontId !== parent.fontName ||
          packets.join('') !== strip(font.text)
        )
          continue
        if (
          !floatSame(size * m[0], parent.transform[0]) ||
          !floatSame(size * m[3], parent.transform[3]) ||
          !floatSame(m[4], parent.transform[4]) ||
          !floatSame(m[5], parent.transform[5]) ||
          !floatSame(advance * m[0], parent.width) ||
          !floatSame(parent.transform[4] * viewport.scale, font.rect[0]) ||
          !floatSame((viewport.viewBox[3] - parent.transform[5]) * viewport.scale, font.baseline) ||
          !floatSame(parent.width * viewport.scale, font.rect[2] - font.rect[0]) ||
          !floatSame(parent.height * viewport.scale, font.height)
        )
          continue
        blocks.push({
          font,
          rawShowTextIndices: indices,
          literalGlyphs: packets,
          glyphRuns,
          wholeAdvance: advance * m[0]
        })
      }
      requireProof(blocks.length === 1, 'unique-complete-color-separated-caption-program')
      return blocks[0]
    }
    const parts = []
    for (let p = 0; p < 2; p++) {
      const triple = sorted.slice(p * 3, p * 3 + 3),
        [open, divider, close] = triple
      requireProof(
        triple.every((r) => r[0] === open[0] && r[2] === open[2]) &&
          open[1] < divider[1] &&
          divider[1] < close[1] &&
          (p === 0 || sorted[2][1] < open[1]),
        'two-stacked-three-rule-bodies'
      )
      const near = meaningful.filter((i) => i.rect[1] > open[1] && i.rect[3] < close[1])
      const titles = near.filter((i) =>
        new RegExp(`^\\(${String.fromCharCode(97 + p)}\\)\\s+\\p{L}`, 'u').test(i.text)
      )
      requireProof(titles.length === 1, 'one-complete-consecutive-subtitle')
      const title = titles[0],
        h = title.height
      requireProof(
        title.rect[3] < divider[1] &&
          title.rect[0] === open[0] &&
          title.rect[2] < open[2] &&
          divider[1] - title.rect[3] > h * 0.5,
        'subtitle-header-separation'
      )
      const fields = near.filter((i) => i !== title)
      for (const i of near) observed(i)
      const islands = []
      for (const i of fields.slice().sort((a, b) => a.rect[0] - b.rect[0])) {
        const prev = islands.at(-1)
        if (prev && i.rect[0] - Math.max(...prev.map((i) => i.rect[2])) < h * 0.2) prev.push(i)
        else islands.push([i])
      }
      requireProof(islands.length === (p ? 4 : 3), 'complete-independent-field-islands')
      const cuts = [
        Math.min(open[0], ...islands[0].map((i) => i.rect[0])),
        ...islands
          .slice(1)
          .map(
            (group, n) =>
              (Math.max(...islands[n].map((i) => i.rect[2])) +
                Math.min(...group.map((i) => i.rect[0]))) /
              2
          ),
        Math.max(open[2], ...islands.at(-1).map((i) => i.rect[2]))
      ]
      requireProof(
        cuts.every((v, n) => finite(v) && (!n || v > cuts[n - 1])),
        'positive-full-font-gutters'
      )
      const lane = (i) => {
        const found = cuts
          .slice(1)
          .flatMap((right, n) => (i.rect[0] >= cuts[n] && i.rect[2] <= right ? [n] : []))
        requireProof(found.length === 1, 'unique-whole-field-owner')
        return found[0]
      }
      const header = fields.filter((i) => i.rect[3] < divider[1]),
        body = fields.filter((i) => i.rect[1] > divider[1])
      requireProof(
        header.length + body.length === fields.length && header.length && body.length,
        'no-crossing-divider-font'
      )
      const anchors = body
        .filter((i) => lane(i) === islands.length - 1)
        .sort((a, b) => a.baseline - b.baseline)
      requireProof(
        anchors.length > 3 &&
          anchors.every((i) => i.height === h && (p ? /^\d+$/u : /^[0-9, /]+$/u).test(i.text)) &&
          anchors.every((i, n) => !n || i.rect[1] > anchors[n - 1].rect[3]),
        'independent-whole-terminal-anchors'
      )
      const rows = [
        header,
        ...anchors.map((i, n) =>
          body.filter(
            (f) =>
              f.baseline >= i.baseline - h * 0.01 &&
              f.baseline < (anchors[n + 1]?.baseline ?? close[1]) - h * 0.01
          )
        )
      ]
      requireProof(
        rows.flat().length === fields.length && new Set(rows.flat()).size === fields.length,
        'complete-record-partition'
      )
      const groups = rows.map((row) =>
        islands.map((_g, col) =>
          row.filter((i) => lane(i) === col).sort((a, b) => items.indexOf(a) - items.indexOf(b))
        )
      )
      requireProof(
        groups.every((row) => row.every((g) => g.length)),
        'all-source-fields-populated'
      )
      if (p) {
        requireProof(
          body.every((i) => i.height === h),
          'ordinary-wrapped-body-only'
        )
        requireProof(
          groups
            .slice(1)
            .every((row, n) =>
              row.slice(2).every((g) => g.length === 1 && g[0].baseline === anchors[n].baseline)
            ),
          'two-complete-terminal-fields-per-record'
        )
        const scripts = header.filter((i) => i.height < h * 0.8),
          normal = header.filter((i) => i.height === h)
        requireProof(
          scripts.length === 1 && normal.length + 1 === header.length,
          'one-proved-header-script'
        )
        const s = scripts[0],
          parents = normal.filter((i) => lane(i) === lane(s))
        requireProof(
          parents.length === 1 &&
            s.baseline > parents[0].baseline &&
            s.baseline - parents[0].baseline < s.height * 0.3 &&
            Math.abs(s.rect[0] - parents[0].rect[2]) < 0.02,
          'unique-touching-native-header-parent'
        )
      }
      parts.push({ title, h, rules: triple, fonts: near, fields, cuts, groups, anchors })
    }
    const [upper, lower] = parts
    requireProof(
      upper.title.height === lower.title.height &&
        lower.rules[0][1] - upper.rules[2][1] > 0 &&
        lower.rules[0][1] - upper.rules[2][1] < upper.h,
      'adjacent-source-bodies'
    )
    requireProof(
      table.cropRect[1] >= upper.rules[0][1] - upper.h &&
        table.cropRect[3] > upper.rules[2][1] &&
        table.cropRect[3] < lower.rules[0][1] &&
        table.cropRect[0] <= upper.cuts[0] &&
        table.cropRect[2] >= upper.cuts.at(-1),
      'one-current-upper-body-owner'
    )
    const shared = captions.filter(
      (c) =>
        /^Table\s+\d+[.:]/u.test(c.lines[0]) &&
        c.rect[3] < upper.rules[0][1] &&
        upper.rules[0][1] - c.rect[3] < upper.h &&
        c.rect[0] < upper.rules[0][2] &&
        c.rect[2] > upper.rules[0][0]
    )
    requireProof(shared.length === 1, 'one-complete-shared-numbered-caption')
    const cap = shared[0],
      capFonts = meaningful.filter((i) => overlaps(i.rect, cap.rect))
    requireProof(
      capFonts.length &&
        capFonts.every(
          (i) =>
            (i.rect[0] >= cap.rect[0] || metricSame(i.rect[0], cap.rect[0])) &&
            (i.rect[2] <= cap.rect[2] || metricSame(i.rect[2], cap.rect[2])) &&
            (i.rect[1] >= cap.rect[1] || metricSame(i.rect[1], cap.rect[1])) &&
            (i.rect[3] <= cap.rect[3] || metricSame(i.rect[3], cap.rect[3]))
        ) &&
        strip(capFonts.map((i) => i.text).join('')) === strip(cap.lines.join('')),
      'caption-whole-font-bijection'
    )
    const full = cap.lines.join(' ').replace(/\s+/gu, ' '),
      clauses = parts.map((p) => p.title.text.split(/[,;]/u)[0])
    requireProof(
      clauses.every((s) => s.length > upper.h / 2 && full.includes(s)) &&
        full.indexOf(clauses[0]) < full.indexOf(clauses[1]) &&
        (full.match(/\(a\)/gu) ?? []).length === 1 &&
        (full.match(/\(b\)/gu) ?? []).length === 1,
      'explicit-consecutive-shared-caption-roles'
    )
    requireProof(
      table.caption?.page === cap.page &&
        rect(table.caption.rect) &&
        Array.isArray(table.caption.lines) &&
        table.caption.lines.length === cap.lines.length &&
        table.caption.lines.every((s, n) => s === cap.lines[n]) &&
        table.caption.rect.every((v, n) => metricSame(v * viewport.scale, cap.rect[n])),
      'existing-canonical-caption-whole'
    )
    for (const i of capFonts) {
      if (runs.filter((r) => r.text === i.text && sameRect(r.rect, i.rect)).length) observed(i)
      else composite(i)
    }
    const physicalEnvelope = (font) => {
      const raw = content.items.filter(
        (c) =>
          c?.str === font.text &&
          Array.isArray(c.transform) &&
          c.transform.length === 6 &&
          c.transform.every(finite) &&
          metricSame(c.transform[4] * viewport.scale, font.rect[0]) &&
          metricSame((viewport.viewBox[3] - c.transform[5]) * viewport.scale, font.baseline) &&
          metricSame((c.transform[4] + c.width) * viewport.scale, font.rect[2]) &&
          metricSame(c.height * viewport.scale, font.height)
      )
      requireProof(raw.length === 1, 'one-original-content-font-metric-parent')
      const style = content.styles?.[raw[0].fontName]
      requireProof(
        style &&
          finite(style.ascent) &&
          style.ascent > 0 &&
          style.ascent <= 1 &&
          finite(style.descent) &&
          style.descent <= 0 &&
          style.descent >= -1 &&
          style.vertical === false,
        'complete-original-font-ascent-descent'
      )
      return {
        top: font.baseline - style.ascent * font.height,
        bottom: font.baseline - style.descent * font.height,
        font: raw[0].fontName,
        ascent: style.ascent,
        descent: style.descent
      }
    }
    const captionPhysicalBottom = Math.max(...capFonts.map((i) => physicalEnvelope(i).bottom)),
      lowerPhysicalBottom = Math.max(...lower.fonts.map((i) => physicalEnvelope(i).bottom)),
      openingPaintTop = paintMap.get(upper.rules[0].join(','))[1]
    requireProof(
      captionPhysicalBottom < openingPaintTop &&
        lowerPhysicalBottom < paintMap.get(lower.rules[2].join(','))[1],
      'complete-native-descent-clearances'
    )
    const owned = new Set([...capFonts, ...upper.fonts, ...lower.fonts])
    const footers = meaningful.filter(
      (i) =>
        !owned.has(i) &&
        i.rect[1] > lower.rules[2][1] &&
        i.height < lower.h &&
        i.rect[0] >= table.cropRect[0] &&
        i.rect[2] <= viewport.width
    )
    requireProof(
      footers.length && footers.every((i) => i.rect[1] > paintMap.get(lower.rules[2].join(','))[3]),
      'footer-independent-outside-rule-paint'
    )
    for (const i of footers) observed(i)
    const outside = meaningful.filter((i) => !owned.has(i) && !footers.includes(i))

    const crop = [
      Math.min(table.cropRect[0], upper.cuts[0], lower.cuts[0]),
      (captionPhysicalBottom + openingPaintTop) / 2,
      Math.max(table.cropRect[2], upper.cuts.at(-1), lower.cuts.at(-1)),
      paintMap.get(lower.rules[2].join(','))[3] + 2
    ]
    requireProof(
      crop[1] > cap.rect[3] &&
        crop[3] < Math.min(...footers.map((i) => i.rect[1])) &&
        meaningful
          .filter((i) => overlaps(i.rect, crop))
          .every((i) => owned.has(i) && !capFonts.includes(i)),
      'complete-crop-and-foreign-font-barriers'
    )
    requireProof(
      outside.length === 1 &&
        outside[0].text === String(table.page) &&
        outside[0].rect[1] > Math.max(...footers.map((i) => i.rect[3])) &&
        outside[0].baseline > viewport.height * 0.8 &&
        Math.abs((outside[0].rect[0] + outside[0].rect[2]) / 2 - viewport.width / 2) < lower.h,
      'all-remaining-source-roles-accounted'
    )

    // Protect every current upper cell, source owner and opaque field. Only
    // the uniquely isolated complete subtitle leaves its first header cell.
    const cellFonts = table.cells.map((c) => {
      requireProof(
        c &&
          rect(c.rect) &&
          typeof c.text === 'string' &&
          Number.isInteger(c.row) &&
          Number.isInteger(c.column) &&
          c.rowSpan === 1 &&
          c.colSpan === 1 &&
          Array.isArray(c.sourceTokens) &&
          Array.isArray(c.sourceRects) &&
          c.sourceTokens.length === c.sourceRects.length &&
          c.sourceTokens.every(
            (t) =>
              t &&
              typeof t.text === 'string' &&
              rect(t.rect) &&
              finite(t.height) &&
              finite(t.baseline)
          ),
        'upper-whole-cell-contract'
      )
      return c.sourceTokens.map((t, n) => {
        const m = upper.fonts.filter(
          (i) =>
            i.text === t.text &&
            sameRect(i.rect, t.rect) &&
            t.height === i.height &&
            t.baseline === i.baseline &&
            sameRect(c.sourceRects[n], i.rect)
        )
        requireProof(m.length === 1, 'upper-current-unique-source-owner')
        return m[0]
      })
    })
    requireProof(
      table.cells.every((c, n) => nativeCellOriginsMatch(c, cellFonts[n])),
      'upper-existing-native-origins-exact'
    )
    requireProof(
      cellFonts.flat().length === upper.fonts.length &&
        new Set(cellFonts.flat()).size === upper.fonts.length,
      'upper-all-whole-fonts-once'
    )
    requireProof(
      table.cells.length === upper.groups.length * 3 &&
        table.cells.every((c, n) => c.row === Math.floor(n / 3) && c.column === n % 3),
      'upper-complete-current-grid'
    )
    for (let n = 0; n < table.cells.length; n++) {
      const c = table.cells[n],
        expected = upper.groups[c.row][c.column],
        source = cellFonts[n].filter((i) => i !== upper.title)
      requireProof(
        source.length === expected.length && source.every((i, k) => i === expected[k]),
        'upper17-headers-body-owners-whole'
      )
    }
    const titleOwners = table.cells.filter((_c, n) => cellFonts[n].includes(upper.title))
    requireProof(
      titleOwners.length === 1 &&
        titleOwners[0] === table.cells[0] &&
        cellFonts[0][0] === upper.title &&
        !Object.hasOwn(table.cells[0], 'textRuns') &&
        table.cells[0].text.startsWith(upper.title.text + ' '),
      'unique-subtitle-only-upper-header-delta'
    )
    const mutableHeaderKeys = new Set([
      'row',
      'column',
      'rowSpan',
      'colSpan',
      'rect',
      'origin',
      'header',
      'text',
      'sourceTokens',
      'sourceRects',
      'sourceItems'
    ])
    requireProof(
      Object.keys(table.cells[0]).every((k) => mutableHeaderKeys.has(k)) &&
        table.cells[0].sourceTokens.every((t) =>
          Object.keys(t).every((k) => ['text', 'rect', 'baseline', 'height'].includes(k))
        ),
      'only-supported-upper-mutable-header-payload'
    )
    const first = table.cells[0],
      firstCell = {
        ...first,
        text: first.text.slice(upper.title.text.length + 1),
        sourceTokens: first.sourceTokens.slice(1),
        sourceRects: first.sourceRects.slice(1)
      }
    if (Object.hasOwn(first, 'sourceItems'))
      firstCell.sourceItems = nativeWholeFontOrigins(cellFonts[0].slice(1))
    requireProof(
      strip(firstCell.text) === upper.groups[0][0].map((i) => strip(i.text)).join(''),
      'upper-real-header-literal-preserved'
    )
    const upperCells = [firstCell, ...table.cells.slice(1)],
      upperGrid = table.grid.map((r) => r.slice())
    upperGrid[0][0] = firstCell.text
    const upperPart = {
      title: upper.title.text,
      grid: upperGrid,
      cells: upperCells,
      unassigned: table.unassigned,
      issues: table.issues,
      notes: table.notes
    }

    const bands = lower.groups.map((row) => row.flat()),
      edges = [box(bands[0])[1]]
    for (let n = 1; n < bands.length; n++) {
      const a = box(bands[n - 1]),
        b = box(bands[n])
      requireProof(b[1] > a[3], 'nonoverlapping-whole-record-bands')
      edges.push((a[3] + b[1]) / 2)
    }
    edges.push(box(bands.at(-1))[3])
    // Reuse the already-computed lower refinement from this existing page
    // loop. It is evidence for payload preservation, never the source oracle.
    requireProof(
      Array.isArray(context.refined) &&
        context.refined.every((t) => t && typeof t === 'object' && rect(t.cropRect)),
      'existing-refined-context'
    )
    const lowerCandidates = context.refined.filter(
      (t) =>
        t !== table &&
        rect(t.cropRect) &&
        t.cropRect[1] > upper.rules[2][1] &&
        t.cropRect[1] < lower.rules[1][1] &&
        t.cropRect[3] > lower.rules[2][1] &&
        t.cropRect[0] <= lower.cuts[0] &&
        t.cropRect[2] >= lower.cuts.at(-1)
    )
    requireProof(lowerCandidates.length === 1, 'unique-existing-lower-refinement')
    const originalLower = lowerCandidates[0],
      old = originalLower.cells
    requireProof(
      Array.isArray(old) &&
        old.length === (lower.groups.length + 1) * 4 &&
        old.every(
          (c, n) =>
            c &&
            c.row === Math.floor(n / 4) &&
            c.column === n % 4 &&
            c.rowSpan === 1 &&
            c.colSpan === 1 &&
            rect(c.rect) &&
            typeof c.text === 'string' &&
            Array.isArray(c.sourceTokens) &&
            Array.isArray(c.sourceRects) &&
            c.sourceTokens.length === c.sourceRects.length &&
            c.sourceTokens.every(
              (t) =>
                t &&
                typeof t.text === 'string' &&
                rect(t.rect) &&
                finite(t.height) &&
                finite(t.baseline)
            )
        ),
      'lower-preserved-donor-contract'
    )
    const lowerOwners = old.map((c) =>
      c.sourceTokens.map((t, n) => {
        const m = lower.fonts.filter(
          (i) =>
            i.text === t.text &&
            sameRect(i.rect, t.rect) &&
            t.height === i.height &&
            t.baseline === i.baseline &&
            sameRect(c.sourceRects[n], i.rect)
        )
        requireProof(m.length === 1, 'lower-current-unique-source-owner')
        return m[0]
      })
    )
    requireProof(
      lowerOwners.flat().length === lower.fonts.length &&
        new Set(lowerOwners.flat()).size === lower.fonts.length,
      'lower-all-whole-fonts-once'
    )
    requireProof(
      old.every((c, n) => nativeCellOriginsMatch(c, lowerOwners[n])),
      'lower-existing-native-origins-exact'
    )
    const projected = old.filter((c) => c.row < lower.groups.length).slice()
    const titleCell = old.find(
      (c) => c.row === 0 && lowerOwners[old.indexOf(c)].includes(lower.title)
    )
    requireProof(
      titleCell === old[1] &&
        lowerOwners[1][0] === lower.title &&
        !Object.hasOwn(titleCell, 'textRuns') &&
        titleCell.text.startsWith(lower.title.text + ' '),
      'lower-subtitle-only-header-owner'
    )
    requireProof(
      Object.keys(titleCell).every((k) => mutableHeaderKeys.has(k)) &&
        titleCell.sourceTokens.every((t) =>
          Object.keys(t).every((k) => ['text', 'rect', 'baseline', 'height'].includes(k))
        ),
      'only-supported-lower-mutable-header-payload'
    )
    projected[1] = {
      ...titleCell,
      text: titleCell.text.slice(lower.title.text.length + 1),
      sourceTokens: titleCell.sourceTokens.slice(1),
      sourceRects: titleCell.sourceRects.slice(1)
    }
    if (Object.hasOwn(titleCell, 'sourceItems'))
      projected[1].sourceItems = nativeWholeFontOrigins(lowerOwners[1].slice(1))
    const terminal = lower.groups.length - 1,
      allowedCellKeys = new Set([
        'row',
        'column',
        'rowSpan',
        'colSpan',
        'rect',
        'origin',
        'text',
        'sourceTokens',
        'sourceRects',
        'sourceItems'
      ])
    for (let col = 0; col < 4; col++) {
      const primary = old.find((c) => c.row === terminal && c.column === col),
        continuation = old.find((c) => c.row === terminal + 1 && c.column === col)
      if (col < 2) {
        requireProof(
          primary.sourceTokens.length &&
            continuation.sourceTokens.length &&
            Object.keys(primary).every((k) => allowedCellKeys.has(k)) &&
            Object.keys(continuation).every((k) => allowedCellKeys.has(k)) &&
            !Object.hasOwn(primary, 'textRuns') &&
            !Object.hasOwn(continuation, 'textRuns') &&
            primary.origin === continuation.origin &&
            primary.rect[0] === continuation.rect[0] &&
            primary.rect[2] === continuation.rect[2] &&
            primary.rect[3] < continuation.rect[1],
          'only-supported-complete-wrapped-donors'
        )
        projected[terminal * 4 + col] = {
          ...primary,
          rect: [primary.rect[0], primary.rect[1], primary.rect[2], continuation.rect[3]],
          text: primary.text + ' ' + continuation.text,
          sourceTokens: [...primary.sourceTokens, ...continuation.sourceTokens],
          sourceRects: [...primary.sourceRects, ...continuation.sourceRects]
        }
        if (Object.hasOwn(primary, 'sourceItems') || Object.hasOwn(continuation, 'sourceItems')) {
          const origins = nativeWholeFontOrigins([
            ...lowerOwners[old.indexOf(primary)],
            ...lowerOwners[old.indexOf(continuation)]
          ])
          requireProof(origins !== undefined, 'wrapped-donor-native-origins-complete')
          projected[terminal * 4 + col].sourceItems = origins
        }
      } else
        requireProof(
          continuation.text === '' &&
            !continuation.sourceTokens.length &&
            !continuation.sourceRects.length &&
            Object.keys(continuation).every((k) => allowedCellKeys.has(k)),
          'only-two-source-free-terminal-scaffolds'
        )
    }
    requireProof(
      projected.every(
        (c) =>
          strip(c.text) === lower.groups[c.row][c.column].map((i) => strip(i.text)).join('') &&
          c.sourceRects.length === lower.groups[c.row][c.column].length &&
          c.sourceRects.every((r, n) => sameRect(r, lower.groups[c.row][c.column][n].rect))
      ),
      'all36-projected-source-cells-exact'
    )
    const lowerPart = {
      title: lower.title.text,
      grid: lower.groups.map((row, n) =>
        row.map((_g, col) => projected.find((c) => c.row === n && c.column === col).text)
      ),
      cells: projected,
      unassigned: [],
      issues: [],
      notes: table.notes
    }

    return { parts: [upperPart, lowerPart], cropRect: crop }
  } catch {
    return undefined
  }
}

// Recover only complete physical records whose one whole stub is printed on
// an exact peer baseline. Existing fenced and section branches retain priority.
function recoverCompleteBaselineOrdinaryRecords(
  table,
  items,
  captions,
  rules,
  paint,
  graphics,
  context
) {
  const plain = (x) =>
      x &&
      Object.getPrototypeOf(x) === Object.prototype &&
      Reflect.ownKeys(x).every((k) => {
        const d = Object.getOwnPropertyDescriptor(x, k)
        return typeof k === 'string' && d.enumerable && Object.hasOwn(d, 'value')
      }),
    safe = (x, seen = new Set()) => {
      if (x === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof x)) return true
      if (typeof x !== 'object' || seen.has(x) || (!Array.isArray(x) && !plain(x))) return false
      seen.add(x)
      for (const k of Reflect.ownKeys(x)) {
        if (Array.isArray(x) && k === 'length') continue
        const d = Object.getOwnPropertyDescriptor(x, k)
        if (x === table.unassigned && k === 'reconciliationItems') {
          if (
            d.enumerable !== false ||
            d.writable !== false ||
            d.configurable !== false ||
            !Object.hasOwn(d, 'value') ||
            !Array.isArray(d.value) ||
            d.value.some(
              (i) =>
                !items?.includes(i) ||
                i.sourceToken ||
                i.sourceItem?.text !== i.text ||
                !safe(i, seen)
            )
          )
            return false
          continue
        }
        if (
          typeof k !== 'string' ||
          !d.enumerable ||
          !Object.hasOwn(d, 'value') ||
          !safe(d.value, seen)
        )
          return false
      }
      seen.delete(x)
      return true
    },
    rect = (r) =>
      Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3],
    hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
    same = (a, b) =>
      a.text === b.text &&
      Math.abs(a.baseline - b.baseline) < 0.02 &&
      Math.abs(a.height - b.height) < 0.02 &&
      a.rect.every((v, n) => Math.abs(v - b.rect[n]) < 0.02),
    equal = (a, b) => fencedGroupOpaqueEqual(a, b)
  if (
    !plain(table) ||
    !safe(table) ||
    !rect(table.cropRect) ||
    !Array.isArray(table.cells) ||
    !Array.isArray(table.grid) ||
    !Array.isArray(table.rows) ||
    table.rows.length !== table.grid.length ||
    table.readingRotation ||
    !plain(context) ||
    !context.viewport ||
    !Array.isArray(context.nativeEvidenceGraphics) ||
    !Array.isArray(items) ||
    items.some((i) => !plain(i) || !safe(i)) ||
    !Array.isArray(rules) ||
    !Array.isArray(captions)
  )
    return
  if (
    table.grid.some(
      (r) => !Array.isArray(r) || r.length !== 6 || r.some((s) => typeof s !== 'string')
    ) ||
    ['notes', 'parts', 'unassigned', 'clipped', 'issues'].some(
      (k) => Object.hasOwn(table, k) && (!Array.isArray(table[k]) || table[k].length)
    )
  )
    return
  // Preserve the existing specific runtime-only reconciliation witness; unknown
  // non-enumerable arrays were rejected above instead of silently being cloned.
  const sv = table.sourceViewport,
    v = context.viewport,
    cap = table.caption
  if (
    !sv ||
    sv.scale !== v.scale ||
    sv.width !== v.width ||
    sv.height !== v.height ||
    !Number.isInteger(table.page) ||
    !cap ||
    cap.page !== table.page ||
    !Array.isArray(cap.lines) ||
    !rect(cap.rect)
  )
    return
  const title = captions.filter(
    (c) =>
      c.page === table.page &&
      equal(c.lines, cap.lines) &&
      rect(c.rect) &&
      c.rect.every((p, n) => p === cap.rect[n] * v.scale)
  )
  if (title.length !== 1 || title[0].rect[3] >= table.cropRect[1]) return
  const fonts = items.filter(
      (f) =>
        typeof f.text === 'string' && f.text.trim() && rect(f.rect) && hit(f.rect, table.cropRect)
    ),
    // Repeated margin filtering changes the positional graphic set used by
    // older branches. Complete packet closure binds the original source set
    // carried by the existing context instead.
    ctx = { ...context, rulePaintBounds: paint }
  if (!proveNativeCompleteRuledSourcePacket(fonts, rules, ctx, table.cropRect)) return
  const fences = rules
    .filter(
      (r) =>
        r[1] === r[3] &&
        r[1] >= table.cropRect[1] &&
        r[1] <= table.cropRect[3] &&
        r[0] < table.cropRect[2] &&
        r[2] > table.cropRect[0]
    )
    .sort((a, b) => a[1] - b[1])
  if (
    fences.length !== 3 ||
    fences.some(
      (r) => Math.abs(r[0] - fences[0][0]) > 0.02 || Math.abs(r[2] - fences[0][2]) > 0.02
    ) ||
    fonts.some(
      (f) =>
        f.rect[0] < fences[0][0] ||
        f.rect[2] > fences[0][2] ||
        f.rect[1] < fences[0][1] ||
        f.rect[3] > fences[2][1] ||
        fences.some((r) => f.rect[1] < r[1] && f.rect[3] > r[1])
    )
  )
    return
  const slots = new Set(),
    owned = [],
    known = new Set([
      'row',
      'column',
      'rowSpan',
      'colSpan',
      'rect',
      'origin',
      'text',
      'sourceTokens',
      'sourceRects',
      'sourceItems',
      'textRuns'
    ])
  for (const c of table.cells) {
    if (
      !plain(c) ||
      !Number.isInteger(c.row) ||
      !Number.isInteger(c.column) ||
      c.row < 0 ||
      c.row >= table.grid.length ||
      c.column < 0 ||
      c.column >= 6 ||
      c.rowSpan !== 1 ||
      c.colSpan !== 1 ||
      !rect(c.rect) ||
      typeof c.text !== 'string' ||
      table.grid[c.row][c.column] !== c.text ||
      !Array.isArray(c.sourceTokens) ||
      !Array.isArray(c.sourceRects) ||
      c.sourceTokens.length !== c.sourceRects.length ||
      c.sourceTokens.some(
        (t) =>
          !t ||
          (t.sourceToken && c.row !== 0) ||
          !rect(t.rect) ||
          typeof t.text !== 'string' ||
          !Number.isFinite(t.baseline) ||
          !Number.isFinite(t.height)
      )
    )
      return
    const slot = c.row + ':' + c.column
    if (slots.has(slot)) return
    slots.add(slot)
    const matched = c.sourceTokens.map((t) => fonts.filter((f) => same(f, t)))
    if (matched.some((m) => m.length !== 1)) return
    if (
      c.sourceTokens.some((t, n) => {
        if (Object.hasOwn(t, 'sourceItem') && !equal(t.sourceItem, matched[n][0].sourceItem))
          return true
        if (!t.sourceToken) return false
        const { sourceToken, ...outer } = t
        return !equal(sourceToken, matched[n][0]) || !equal(outer, matched[n][0])
      })
    )
      return
    if (
      c.sourceRects.some(
        (r) => !rect(r) || c.sourceTokens.filter((t) => equal(t.rect, r)).length !== 1
      ) ||
      c.sourceTokens.some((t) => c.sourceRects.filter((r) => equal(t.rect, r)).length !== 1)
    )
      return
    const originals = matched.flat()
    if (!nativeCellOriginsMatch(c, originals)) return
    owned.push(...originals)
  }
  if (
    slots.size !== table.grid.length * 6 ||
    owned.length !== fonts.length ||
    new Set(owned).size !== fonts.length
  )
    return
  const domains = Array.from({ length: 6 }, (_, column) =>
      table.cells.filter((c) => c.column === column).flatMap((c) => c.sourceTokens)
    ),
    gutters = domains
      .slice(1)
      .map((d, n) => [
        Math.max(...domains[n].map((f) => f.rect[2])),
        Math.min(...d.map((f) => f.rect[0]))
      ])
  if (domains.some((d) => !d.length) || gutters.some((g) => g[0] >= g[1])) return
  const candidates = []
  for (let row = 1; row < table.grid.length; row++) {
    const donors = table.cells.filter((c) => c.row === row).sort((a, b) => a.column - b.column)
    if (!donors.slice(1).some((c) => c.sourceTokens.length > 1)) continue
    if (
      !plain(table.rows[row]) ||
      !rect(table.rows[row].rect) ||
      Object.keys(table.rows[row]).some((k) => !['rect', 'origin'].includes(k))
    )
      return
    if (
      donors.some(
        (c) =>
          Object.keys(c).some((k) => !known.has(k)) ||
          (c.textRuns &&
            (!Array.isArray(c.textRuns) ||
              c.textRuns.length !== 1 ||
              !plain(c.textRuns[0]) ||
              Object.keys(c.textRuns[0]).some((k) => !['text', 'position'].includes(k)) ||
              c.textRuns[0].position !== 'normal' ||
              c.textRuns[0].text !== c.text))
      )
    )
      return
    const h = donors[0].sourceTokens[0]?.height,
      normal = (f) => f.height === h && f.horizontal !== false
    if (
      donors[0].sourceTokens.length !== 1 ||
      !/\p{L}/u.test(donors[0].text) ||
      donors.flatMap((c) => c.sourceTokens).some((f) => !normal(f))
    )
      return
    const baselines = donors[1].sourceTokens.map((f) => f.baseline).sort((a, b) => a - b)
    if (baselines.length !== 3 || baselines.some((b, n) => n && b - baselines[n - 1] <= h)) return
    const fields = baselines.map((b) =>
        donors.map((c) => c.sourceTokens.filter((f) => Math.abs(f.baseline - b) < 0.02))
      ),
      stub = baselines.flatMap((b, n) =>
        Math.abs(b - donors[0].sourceTokens[0].baseline) < 0.02 ? [n] : []
      )
    if (stub.length !== 1 || fields.some((r) => r.slice(1, 5).some((f) => f.length !== 1))) return
    const text = (f) =>
      [...f]
        .sort((a, b) => a.rect[0] - b.rect[0])
        .map((t, n, a) => (n && t.rect[0] - a[n - 1].rect[2] > 0.02 ? ' ' : '') + t.text)
        .join('')
    if (
      fields.some(
        (r) =>
          !r[5].length ||
          [...r[5]]
            .sort((a, b) => a.rect[0] - b.rect[0])
            .some((f, n, a) => n && Math.abs(f.rect[0] - a[n - 1].rect[2]) > 0.02)
      )
    )
      return
    if (
      donors.some(
        (c, n) =>
          fields
            .map((r) => text(r[n]))
            .filter(Boolean)
            .join(' ') !== c.text
      )
    )
      return
    const scalars = [1, 2, 3, 4, 5].filter(
      (c) =>
        fields.every((r) => /^(?:[+−-]?\d+(?:\.\d+)?%?|[–−-])$/u.test(text(r[c]))) &&
        fields.some((r) => /\d/u.test(text(r[c])))
    )
    if (scalars.length < 3) return
    const peers = table.grid.flatMap((_, r) => {
      if (r === 0 || r === row) return []
      const cs = table.cells.filter((c) => c.row === r).sort((a, b) => a.column - b.column),
        p = cs.slice(1).flatMap((c) => c.sourceTokens)
      return cs.slice(1).every((c) => c.sourceTokens.length === 1) &&
        p.every((f) => normal(f) && Math.abs(f.baseline - p[0]?.baseline) < 0.02)
        ? [r]
        : []
    })
    if (peers.length < 3) return
    const envelope = fields.map((r) => [
        Math.min(...r.flat().map((f) => f.rect[1])),
        Math.max(...r.flat().map((f) => f.rect[3]))
      ]),
      local = fonts.filter((f) =>
        hit(f.rect, [table.cropRect[0], donors[0].rect[1], table.cropRect[2], donors[0].rect[3]])
      ),
      all = donors.flatMap((c) => c.sourceTokens)
    const rowRect = table.rows[row].rect
    if (
      rowRect[0] < donors[0].rect[0] ||
      rowRect[2] > donors[5].rect[2] ||
      donors.some((c) => c.rect[1] !== rowRect[1] || c.rect[3] !== rowRect[3]) ||
      all.some(
        (f) =>
          f.rect[0] < donors[0].rect[0] ||
          f.rect[2] > donors[5].rect[2] ||
          f.rect[1] < rowRect[1] ||
          f.rect[3] > rowRect[3]
      )
    )
      return
    if (
      local.length !== all.length ||
      local.some((f) => all.filter((t) => same(f, t)).length !== 1) ||
      envelope.some((e, n) => n && e[0] <= envelope[n - 1][1]) ||
      envelope[0][0] < donors[0].rect[1] ||
      envelope.at(-1)[1] > donors[0].rect[3]
    )
      return
    candidates.push({
      row,
      donors,
      fields,
      stub: stub[0],
      text,
      edges: [
        donors[0].rect[1],
        ...envelope.slice(1).map((e, n) => (envelope[n][1] + e[0]) / 2),
        donors[0].rect[3]
      ]
    })
  }
  if (candidates.length !== 1) return
  const p = candidates[0]
  let out
  try {
    out = structuredClone(table)
  } catch {
    return
  }
  const replacements = p.fields.flatMap((record, n) =>
    record.map((f, column) => {
      const donor = p.donors[column],
        cell = {
          ...structuredClone(donor),
          row: p.row + n,
          rect: [donor.rect[0], p.edges[n], donor.rect[2], p.edges[n + 1]],
          text: p.text(f),
          sourceTokens: structuredClone(f),
          sourceRects: f.map((t) => [...t.rect])
        }
      const origin = nativeChangedCellOrigins([donor], items, f)
      if (origin === undefined) return undefined
      Object.assign(cell, origin)
      if (!f.length) delete cell.sourceItems
      if (donor.textRuns) cell.textRuns = f.length ? [{ text: cell.text, position: 'normal' }] : []
      return cell
    })
  )
  if (replacements.some((c) => !c)) return
  let emitted = false
  out.cells = out.cells.flatMap((c) => {
    if (c.row !== p.row) return [{ ...c, row: c.row > p.row ? c.row + 2 : c.row }]
    if (emitted) return []
    emitted = true
    return replacements
  })
  out.rows.splice(
    p.row,
    1,
    ...p.fields.map((_, n) => ({
      ...structuredClone(table.rows[p.row]),
      rect: [table.rows[p.row].rect[0], p.edges[n], table.rows[p.row].rect[2], p.edges[n + 1]]
    }))
  )
  out.grid.splice(p.row, 1, ...p.fields.map((r) => r.map(p.text)))
  // Independent output closure before returning: no origin or source font may
  // disappear or be duplicated, including the two new literal-empty stub slots.
  const next = out.cells.flatMap((c) => c.sourceTokens),
    current = table.cells.flatMap((c) => c.sourceTokens)
  if (
    next.length !== current.length ||
    current.some((f) => next.filter((t) => same(f, t)).length !== 1) ||
    out.cells.some(
      (c) =>
        Object.hasOwn(c, 'sourceItems') &&
        !nativeCellOriginsMatch(
          c,
          c.sourceTokens.map((t) => fonts.find((f) => same(f, t)))
        )
    )
  )
    return
  const witness = Object.getOwnPropertyDescriptor(table.unassigned ?? [], 'reconciliationItems')
  if (witness) Object.defineProperty(out.unassigned, 'reconciliationItems', witness)
  return out
}

// A native fraction can cross the existing model's semantic rows. This only
// completes its visual crop; every cell and original source stays untouched.
export function recoverNativeVisualFractionCrop(table, fonts, rules, context) {
  const d = table && Object.getOwnPropertyDescriptor(table, 'cropRect')
  if (
    !d ||
    !Object.hasOwn(d, 'value') ||
    !Array.isArray(d.value) ||
    d.value.length !== 4 ||
    Reflect.ownKeys(d.value).length !== 5 ||
    ![0, 1, 2, 3].every((n) => {
      const p = Object.getOwnPropertyDescriptor(d.value, String(n))
      return p && Object.hasOwn(p, 'value') && p.enumerable && Number.isFinite(p.value)
    })
  )
    return
  if (
    !['grid', 'cells', 'unassigned'].every((key) => {
      const p = Object.getOwnPropertyDescriptor(table, key)
      return p && Object.hasOwn(p, 'value') && Array.isArray(p.value)
    }) ||
    !context?.viewport
  )
    return
  const candidate = recoverOwnedTableCrop(
    table,
    rules,
    [context.viewport.width, context.viewport.height],
    fonts,
    context.rulePaintBounds,
    context.nativeEvidenceGraphics,
    fonts
  )
  return nativeVisualFractionCrop(table, fonts, rules, context, candidate)
}

function nativeVisualFractionCrop(table, fonts, rules, context, candidate) {
  const exact = fencedGroupOpaqueEqual,
    OPS = fencedGroupOPS,
    Util = fencedGroupUtil
  const finiteRect = (r) =>
    Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3]
  const overlaps = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
  const near = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-7
  const strip = (s) => s.replace(/\s/gu, '')
  const key = (o) => `${o?.pageNumber}:${o?.index}`

  const no = () => undefined
  const gd = table && Object.getOwnPropertyDescriptor(table, 'grid'),
    cd = table && Object.getOwnPropertyDescriptor(table, 'cells')
  if (!gd || !Object.hasOwn(gd, 'value') || !cd || !Object.hasOwn(cd, 'value'))
    return no('original-grid-cells-data')
  const grid = gd.value,
    sourceCells = cd.value
  if (
    !Array.isArray(grid) ||
    !grid.length ||
    !Array.isArray(grid[0]) ||
    !grid[0].length ||
    !Array.isArray(sourceCells) ||
    !sourceCells.length
  )
    return no('complete-rectangular-grid')
  const rowCount = grid.length,
    columnCount = grid[0].length
  for (let r = 0; r < rowCount; r++)
    if (
      !Object.hasOwn(grid, r) ||
      !Array.isArray(grid[r]) ||
      grid[r].length !== columnCount ||
      Array.from({ length: columnCount }, (_, c) => c).some(
        (c) => !Object.hasOwn(grid[r], c) || typeof grid[r][c] !== 'string'
      )
    )
      return no('complete-rectangular-grid')
  const covered = new Set()
  for (const c of sourceCells) {
    if (
      !c ||
      ![c.row, c.column, c.rowSpan, c.colSpan].every(Number.isSafeInteger) ||
      c.row < 0 ||
      c.column < 0 ||
      c.rowSpan < 1 ||
      c.colSpan < 1 ||
      c.row + c.rowSpan > rowCount ||
      c.column + c.colSpan > columnCount ||
      typeof c.text !== 'string' ||
      grid[c.row][c.column] !== c.text
    )
      return no('bounded-original-cell-grid-owner')
    for (let r = c.row; r < c.row + c.rowSpan; r++)
      for (let n = c.column; n < c.column + c.colSpan; n++) {
        const slot = r + ':' + n
        if (
          covered.has(slot) ||
          ((r !== c.row || n !== c.column) && grid[r][n] !== '' && grid[r][n] !== c.text)
        )
          return no('unique-original-cell-grid-owner')
        covered.add(slot)
      }
  }
  if (covered.size !== rowCount * columnCount) return no('whole-original-grid-covered')
  const cropDescriptor = table && Object.getOwnPropertyDescriptor(table, 'cropRect')
  const plainCrop = (r) =>
    Array.isArray(r) &&
    Object.getPrototypeOf(r) === Array.prototype &&
    r.length === 4 &&
    Reflect.ownKeys(r).length === 5 &&
    [0, 1, 2, 3].every((n) => {
      const d = Object.getOwnPropertyDescriptor(r, String(n))
      return !!d && Object.hasOwn(d, 'value') && d.enumerable && Number.isFinite(d.value)
    })
  if (
    !cropDescriptor ||
    !Object.hasOwn(cropDescriptor, 'value') ||
    !plainCrop(cropDescriptor.value) ||
    !plainCrop(candidate)
  )
    return no('plain-original-crop-payload')
  if (
    !finiteRect(table.cropRect) ||
    !finiteRect(candidate) ||
    candidate[0] !== table.cropRect[0] ||
    candidate[1] !== table.cropRect[1] ||
    candidate[3] !== table.cropRect[3] ||
    candidate[2] <= table.cropRect[2]
  )
    return no('right-only-candidate')
  if (!proveNativeCompleteRuledSourcePacket(fonts, rules, context, candidate))
    return no('complete-original-source-paint')
  const {
    content,
    operators: op,
    viewport,
    rulePaintBounds: paint,
    nativeEvidenceGraphics: graphics
  } = context
  const allRaw = content.items.filter((i) => typeof i.str === 'string' && i.str.trim()),
    byKey = new Map(fonts.map((f) => [key(f.sourceItem), f]))
  if (
    byKey.size !== fonts.length ||
    allRaw.length !== fonts.length ||
    allRaw.some((r) => !exact(byKey.get(key(r.sourceItem))?.sourceItem, r.sourceItem))
  )
    return no('whole-original-source-identity')
  const claims = new Map(),
    cells = table.cells
  if (
    !Array.isArray(cells) ||
    !cells.length ||
    !Array.isArray(table.unassigned) ||
    table.unassigned.length
  )
    return no('complete-existing-cells')
  for (const c of cells) {
    if (
      !Number.isInteger(c.column) ||
      !Number.isInteger(c.colSpan) ||
      c.colSpan < 1 ||
      !Array.isArray(c.sourceRects) ||
      !Array.isArray(c.sourceItems ?? []) ||
      (c.sourceItems ?? []).length !== c.sourceRects.length ||
      (!(c.sourceItems ?? []).length && c.text?.trim())
    )
      return no('complete-cell-source-payload')
    for (let n = 0; n < (c.sourceItems ?? []).length; n++) {
      const origin = c.sourceItems[n],
        f = byKey.get(key(origin))
      if (
        !f ||
        !exact(f.sourceItem, origin) ||
        claims.has(key(origin)) ||
        !finiteRect(c.sourceRects[n]) ||
        !c.sourceRects[n].every((v, k) => near(v, f.rect[k]))
      )
        return no('unique-unchanged-native-cell-claims')
      claims.set(key(origin), c)
    }
  }
  for (const c of cells) {
    if (c.sourceTokens === undefined) continue
    if (!Array.isArray(c.sourceTokens) || c.sourceTokens.length !== (c.sourceItems ?? []).length)
      return no('complete-internal-token-collection')
    const owned = (c.sourceItems ?? []).map((o) => byKey.get(key(o))),
      matched = new Set()
    for (const token of c.sourceTokens) {
      if (
        !token ||
        Reflect.ownKeys(token).some(
          (k) =>
            typeof k !== 'string' ||
            ![
              'text',
              'rect',
              'baseline',
              'height',
              'horizontal',
              'fontDescent',
              'inlineSymbol',
              'sourceItem'
            ].includes(k)
        )
      )
        return no('known-original-token-projection')
      const matches = owned.filter(
        (f) =>
          token.text === f.text &&
          finiteRect(token.rect) &&
          token.rect.every((v, k) => near(v, f.rect[k])) &&
          near(token.baseline, f.baseline) &&
          near(token.height, f.height) &&
          ['horizontal', 'fontDescent', 'inlineSymbol'].every(
            (k) => !(k in token) || exact(token[k], f[k])
          ) &&
          (!('sourceItem' in token) || exact(token.sourceItem, f.sourceItem))
      )
      if (matches.length !== 1 || matched.has(matches[0]))
        return no('independent-native-token-source-bijection')
      matched.add(matches[0])
    }
  }
  const reconciliation = Object.getOwnPropertyDescriptor(table.unassigned, 'reconciliationItems')
  if (reconciliation) {
    if (
      !Object.hasOwn(reconciliation, 'value') ||
      !Array.isArray(reconciliation.value) ||
      reconciliation.value.length !== claims.size
    )
      return no('complete-reconciliation-descriptor')
    const matched = new Set()
    for (const token of reconciliation.value) {
      if (
        !token ||
        Reflect.ownKeys(token).some(
          (k) =>
            typeof k !== 'string' ||
            ![
              'text',
              'rect',
              'baseline',
              'height',
              'horizontal',
              'fontDescent',
              'inlineSymbol',
              'sourceItem'
            ].includes(k)
        )
      )
        return no('known-reconciliation-provider-projection')
      const f = byKey.get(key(token.sourceItem))
      if (
        !f ||
        !claims.has(key(token.sourceItem)) ||
        matched.has(f) ||
        !exact(token.sourceItem, f.sourceItem) ||
        token.text !== f.text ||
        !finiteRect(token.rect) ||
        !token.rect.every((v, k) => near(v, f.rect[k])) ||
        !near(token.baseline, f.baseline) ||
        !near(token.height, f.height) ||
        !['horizontal', 'fontDescent', 'inlineSymbol'].every(
          (k) => !(k in token) || exact(token[k], f[k])
        )
      )
        return no('complete-independent-reconciliation-bijection')
      matched.add(f)
    }
  }
  const rightColumn = columnCount - 1,
    rightClaimed = fonts.filter(
      (f) =>
        claims.get(key(f.sourceItem))?.column === rightColumn &&
        claims.get(key(f.sourceItem))?.colSpan === 1
    ),
    leftClaimed = fonts.filter(
      (f) =>
        claims.has(key(f.sourceItem)) &&
        claims.get(key(f.sourceItem)).column !== rightColumn &&
        claims.get(key(f.sourceItem)).colSpan === 1
    )
  if (!rightClaimed.length || !leftClaimed.length) return no('two-native-leaf-owners')
  const leftRight = Math.max(...leftClaimed.map((f) => f.rect[2])),
    rightLeft = Math.min(...rightClaimed.map((f) => f.rect[0]))
  if (leftRight >= rightLeft) return no('native-column-isolation')
  const inside = fonts.filter((f) => overlaps(f.rect, candidate)),
    extra = inside.filter((f) => !claims.has(key(f.sourceItem)))
  if (
    !extra.length ||
    inside.length !== claims.size + extra.length ||
    fonts.some((f) => claims.has(key(f.sourceItem)) && !inside.includes(f)) ||
    extra.some((f) => f.rect[0] < rightLeft)
  )
    return no('complete-table-and-right-leaf')
  // The whole native verifier already proves all source char advances, matrices
  // and paint. Bind each original carrier to its complete operator sequence.
  const glyphs = [],
    nativePaths = [],
    stack = []
  let font,
    size,
    block,
    ctm = [1, 0, 0, 1, 0, 0]
  for (let n = 0; n < op.fnArray.length; n++) {
    const code = op.fnArray[n],
      args = op.argsArray[n]
    if (code === OPS.save) stack.push({ ctm: [...ctm], font, size })
    if (code === OPS.restore) {
      const old = stack.pop()
      if (!old) return no('native-stack')
      ;({ ctm, font, size } = old)
    }
    if (code === OPS.transform) ctm = Util.transform(ctm, args)
    if (code === OPS.constructPath) {
      const p = Array.from(args[1][0]),
        matrix = Util.transform(viewport.transform, ctm),
        a = [p[1], p[2]],
        b = [p[4], p[5]]
      Util.applyTransform(a, matrix)
      Util.applyTransform(b, matrix)
      nativePaths.push({
        operatorIndex: n,
        rule: [
          Math.min(a[0], b[0]),
          Math.min(a[1], b[1]),
          Math.max(a[0], b[0]),
          Math.max(a[1], b[1])
        ]
      })
    }
    if (op.fnArray[n] === OPS.setFont) [font, size] = op.argsArray[n]
    if (op.fnArray[n] === OPS.beginText) block = n
    if (op.fnArray[n] === OPS.showText)
      for (const g of op.argsArray[n][0])
        if (typeof g !== 'number')
          for (const char of strip(g.unicode))
            glyphs.push({ char, font, size, block, operatorIndex: n, glyph: g })
  }
  const binding = new Map()
  let offset = 0
  for (const raw of allRaw) {
    const chars = [...strip(raw.str)],
      gs = glyphs.slice(offset, offset + chars.length)
    if (
      gs.length !== chars.length ||
      gs.some((g, n) => g.char !== chars[n] || g.font !== raw.fontName)
    )
      return no('whole-glyph-source-bijection')
    binding.set(key(raw.sourceItem), { raw, glyphs: gs, font: byKey.get(key(raw.sourceItem)) })
    offset += chars.length
  }
  if (offset !== glyphs.length) return no('unowned-glyph-program')
  const ordered = inside
      .map((f) => binding.get(key(f.sourceItem)))
      .sort((a, b) => a.raw.sourceItem.index - b.raw.sourceItem.index),
    unclaimed = extra
      .map((f) => binding.get(key(f.sourceItem)))
      .sort((a, b) => a.raw.sourceItem.index - b.raw.sourceItem.index)
  if (
    !/^\)\d+\]$/u.test(unclaimed.map((f) => strip(f.raw.str)).join('')) ||
    unclaimed.some((b) => b.glyphs.some((g) => g.block !== unclaimed[0].glyphs[0].block))
  )
    return no('complete-original-nested-closing-sequence')
  const closes = [unclaimed[0], unclaimed.at(-1)]
  if (closes[0].raw.str !== ')' || closes[1].raw.str !== ']') return no('whole-closing-carriers')
  const pairs = []
  for (const [opening, closing] of [
    ['(', closes[0]],
    ['[', closes[1]]
  ]) {
    const opens = ordered.filter(
      (b) =>
        b.raw.str === opening &&
        b.raw.fontName === closing.raw.fontName &&
        b.raw.transform.slice(0, 4).every((v, k) => near(v, closing.raw.transform[k])) &&
        near(b.raw.transform[5], closing.raw.transform[5]) &&
        near(b.raw.width, closing.raw.width)
    )
    if (opens.length !== 1) return no('unique-native-delimiter-pair')
    const open = opens[0]
    if (
      open.raw.sourceItem.index >= closing.raw.sourceItem.index ||
      open.font.rect[2] >= closing.font.rect[0] ||
      claims.get(key(open.raw.sourceItem))?.column !== rightColumn
    )
      return no('paired-native-leaf-owner')
    pairs.push({ open, close: closing })
  }
  const inner = pairs[0],
    outer = pairs[1],
    delimiterFont = inner.open.raw.fontName
  if (
    outer.open.raw.fontName !== delimiterFont ||
    allRaw.filter((r) => r.fontName === delimiterFont).length !== pairs.length * 2 ||
    outer.open.raw.sourceItem.index >= inner.open.raw.sourceItem.index ||
    inner.close.raw.sourceItem.index >= outer.close.raw.sourceItem.index ||
    outer.open.font.rect[2] >= inner.open.font.rect[0] ||
    inner.close.font.rect[2] >= outer.close.font.rect[0]
  )
    return no('whole-unique-nested-pairs')
  const exponent = unclaimed.slice(1, -1)
  if (
    !exponent.length ||
    exponent.some(
      (b) =>
        !/^\d+$/u.test(b.raw.str) ||
        b.font.rect[0] < inner.close.font.rect[2] ||
        b.font.rect[2] > outer.close.font.rect[0] ||
        !(b.font.height < inner.close.font.height)
    )
  )
    return no('whole-known-exponent-sequence')
  const groups = []
  for (const rule of rules.filter(
    (r) => r[1] === r[3] && r[0] >= candidate[0] && r[2] <= candidate[2]
  )) {
    let group = groups.find((g) => near(g[0][0], rule[0]) && near(g[0][2], rule[2]))
    if (!group) groups.push((group = []))
    group.push(rule)
  }
  const domains = groups.filter(
    (g) =>
      g.length >= 3 &&
      inside.every(
        (f) =>
          (f.rect[0] >= g[0][0] || near(f.rect[0], g[0][0])) &&
          (f.rect[2] <= g[0][2] || near(f.rect[2], g[0][2])) &&
          f.rect[1] > Math.min(...g.map((r) => r[1])) &&
          f.rect[3] < Math.max(...g.map((r) => r[1]))
      )
  )
  if (domains.length !== 1) return no('unique-coextensive-table-domain')
  const domain = domains[0].sort((a, b) => a[1] - b[1]),
    frame = [domain[0][0], domain[0][1], domain[0][2], domain.at(-1)[1]]
  const internals = rules.filter(
    (r) =>
      r[1] === r[3] &&
      r[0] > inner.open.font.rect[2] &&
      r[2] < inner.close.font.rect[0] &&
      r[1] > frame[1] &&
      r[1] < frame[3]
  )
  if (internals.length !== 1) return no('unique-fraction-native-rule')
  const fraction = internals[0]
  const middle = ordered.filter(
      (b) =>
        b.raw.sourceItem.index > inner.open.raw.sourceItem.index &&
        b.raw.sourceItem.index < inner.close.raw.sourceItem.index
    ),
    fractionBindings = middle.filter(
      (b) => b.font.rect[0] >= fraction[0] && b.font.rect[2] <= fraction[2]
    )
  const numerator = fractionBindings.filter((b) => b.font.baseline < fraction[1]),
    denominator = fractionBindings.filter((b) => b.font.baseline > fraction[1])
  if (
    !numerator.length ||
    !denominator.length ||
    numerator.length + denominator.length !== fractionBindings.length
  )
    return no('complete-fraction-two-sided-advances')
  const fractionOwners = [
    ...new Set(fractionBindings.map((b) => claims.get(key(b.raw.sourceItem))))
  ]
  if (
    fractionOwners.length !== 1 ||
    !fractionOwners[0] ||
    fractionOwners[0].column !== rightColumn ||
    fractionOwners[0].colSpan !== 1 ||
    fractionBindings.some((b) => !claims.has(key(b.raw.sourceItem)))
  )
    return no('complete-fraction-claimed-anchor')
  const paths = nativePaths.filter((p) => p.rule.every((v, k) => near(v, fraction[k])))
  if (paths.length !== 1) return no('unique-fraction-whole-path-program')
  const fractionProgram = paths[0].operatorIndex,
    numeratorPrograms = numerator.flatMap((b) => b.glyphs),
    denominatorPrograms = denominator.flatMap((b) => b.glyphs),
    lastBefore = glyphs.filter((g) => g.operatorIndex < fractionProgram).at(-1),
    firstAfter = glyphs.find((g) => g.operatorIndex > fractionProgram)
  if (
    new Set(numeratorPrograms.map((g) => g.block)).size !== 1 ||
    new Set(denominatorPrograms.map((g) => g.block)).size !== 1 ||
    numeratorPrograms.some((g) => g.operatorIndex >= fractionProgram) ||
    denominatorPrograms.some((g) => g.operatorIndex <= fractionProgram) ||
    !numeratorPrograms.includes(lastBefore) ||
    !denominatorPrograms.includes(firstAfter)
  )
    return no('complete-cross-block-fraction-sequence')
  if (
    exponent.some(
      (b) =>
        b.font.baseline <= inner.close.font.baseline ||
        b.font.baseline >= Math.min(...numerator.map((b) => b.font.baseline))
    )
  )
    return no('native-exponent-component-band')
  const anchor = fractionOwners[0],
    anchorBindings = ordered.filter((b) => claims.get(key(b.raw.sourceItem)) === anchor),
    componentStart = Math.min(
      outer.open.raw.sourceItem.index,
      ...anchorBindings.map((b) => b.raw.sourceItem.index)
    ),
    component = ordered.filter(
      (b) =>
        b.raw.sourceItem.index >= componentStart &&
        b.raw.sourceItem.index <= outer.close.raw.sourceItem.index
    )
  if (
    component.some(
      (b) =>
        claims.has(key(b.raw.sourceItem)) &&
        claims.get(key(b.raw.sourceItem)).column !== rightColumn
    ) ||
    component.some((b) => !claims.has(key(b.raw.sourceItem)) && !unclaimed.includes(b)) ||
    anchorBindings.some((b) => !component.includes(b)) ||
    denominator.some((b) => b.glyphs.some((g) => g.block !== closes[0].glyphs[0].block))
  )
    return no('whole-component-native-claim-isolation')
  const componentMin = Math.min(...component.map((b) => b.font.baseline)),
    componentMax = Math.max(...component.map((b) => b.font.baseline))
  if (
    ordered.some(
      (b) =>
        !component.includes(b) &&
        claims.get(key(b.raw.sourceItem))?.column === rightColumn &&
        claims.get(key(b.raw.sourceItem))?.colSpan === 1 &&
        b.font.baseline >= componentMin &&
        b.font.baseline <= componentMax
    )
  )
    return no('ordinary-record-component-band-isolation')
  // No foreign original carrier or painted path is newly admitted. Existing
  // fonts in the strip must already have complete claims in this same table.
  const newStrip = [table.cropRect[2], candidate[1], candidate[2], candidate[3]],
    stripFonts = fonts.filter((f) => overlaps(f.rect, newStrip))
  if (
    extra.some((f) => !stripFonts.includes(f)) ||
    stripFonts.some((f) => !claims.has(key(f.sourceItem)) && !extra.includes(f))
  )
    return no('strip-whole-font-isolation')
  if (!(paint instanceof Map) || paint.size !== rules.length || graphics.length !== rules.length)
    return no('whole-path-rule-bijection')
  const allowed = new Set([...domain, fraction].map((r) => r.join(',')))
  if ([...paint].some(([k, b]) => overlaps(b, newStrip) && !allowed.has(k)))
    return no('strip-whole-path-isolation')
  // The complete visual owner above is sufficient for the right edge. Only a
  // sole native closing stroke immediately after the table's glyph program
  // may also complete the bottom; uncertain footer evidence keeps that crop.
  const closing = domain.filter((r) => r[1] >= candidate[3])
  if (
    closing.length !== 1 ||
    closing[0] !== domain.at(-1) ||
    domain[0][1] < candidate[1] ||
    inside.some((f) => f.rect[3] >= candidate[3])
  )
    return candidate
  const footer = closing[0],
    footerPaint = paint.get(footer.join(','))
  if (
    !finiteRect(footerPaint) ||
    footerPaint[0] < candidate[0] ||
    footerPaint[2] > candidate[2] ||
    footerPaint[1] <= candidate[3] ||
    footerPaint[3] > viewport.height
  )
    return candidate
  const footerPaths = nativePaths.filter((p) => p.rule.every((v, n) => near(v, footer[n]))),
    lastTableGlyph = Math.max(...ordered.flatMap((b) => b.glyphs.map((g) => g.operatorIndex)))
  if (footerPaths.length !== 1 || footerPaths[0].operatorIndex <= lastTableGlyph) return candidate
  const footerProgram = footerPaths[0].operatorIndex
  if (
    nativePaths.some((p) => p.operatorIndex > lastTableGlyph && p.operatorIndex < footerProgram) ||
    glyphs.some((g) => g.operatorIndex > lastTableGlyph && g.operatorIndex < footerProgram)
  )
    return candidate
  const footerCrop = nativeCompleteRuledPaintCrop(candidate, [footer], context, inside)
  if (
    !footerCrop ||
    ![0, 1, 2].every((n) => footerCrop[n] === candidate[n]) ||
    footerCrop[3] !== footerPaint[3] ||
    footerCrop[3] <= candidate[3]
  )
    return candidate
  const footerStrip = [candidate[0], candidate[3], candidate[2], footerCrop[3]],
    footerStripPaint = [...paint].filter(([, b]) => overlaps(b, footerStrip))
  if (
    fonts.some((f) => overlaps(f.rect, footerStrip)) ||
    footerStripPaint.length !== 1 ||
    footerStripPaint[0][0] !== footer.join(',') ||
    !exact(footerStripPaint[0][1], footerPaint) ||
    !proveNativeCompleteRuledSourcePacket(fonts, rules, context, footerCrop)
  )
    return candidate
  return footerCrop
}

// Tagged recovery has its own complete paint/source proof; the global guard remains unchanged.
const taggedOwnerKey = (source) => `${source.pageNumber}:${source.index}`
const taggedOwnerFail = (reason) => {
  throw new Error(reason)
}
const taggedOwnerDemand = (condition, reason) => {
  if (!condition) taggedOwnerFail(reason)
}
const taggedOwnerRect = (r) =>
  Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3]
const taggedOwnerInside = (r, outer) =>
  r[0] >= outer[0] && r[2] <= outer[2] && r[1] >= outer[1] && r[3] <= outer[3]
const taggedOwnerCover = (fonts) => [
  Math.min(...fonts.map((f) => f.rect[0])),
  Math.min(...fonts.map((f) => f.rect[1])),
  Math.max(...fonts.map((f) => f.rect[2])),
  Math.max(...fonts.map((f) => f.rect[3]))
]
const taggedOwnerRefs = (c) => c.sourceItems ?? []
const taggedOwnerSourceFree = (c, crop, donor, lane) => {
  const basic = ['row', 'column', 'rowSpan', 'colSpan', 'text', 'sourceRects']
  const runtime = [...basic, 'rect', 'origin', 'sourceTokens']
  const keys = Reflect.ownKeys(c)
  const transported = keys.every((k) => basic.includes(k))
  const modelSlot =
    keys.length === runtime.length &&
    keys.every((k) => runtime.includes(k)) &&
    c.origin === 'model-grid' &&
    taggedOwnerRect(c.rect) &&
    taggedOwnerInside(c.rect, crop) &&
    ((taggedOwnerRect(donor.rect) &&
      ['model-grid', 'model-span'].includes(donor.origin) &&
      c.rect[0] === donor.rect[0] &&
      c.rect[2] === donor.rect[2]) ||
      (c.rect[0] >= lane[0] && c.rect[2] <= lane[2])) &&
    Array.isArray(c.sourceTokens) &&
    c.sourceTokens.length === 0
  return (
    (transported || modelSlot) &&
    c.text === '' &&
    Array.isArray(c.sourceRects) &&
    c.sourceRects.length === 0 &&
    c.rowSpan === 1 &&
    c.colSpan === 1
  )
}
function taggedOwnerPlainData(
  value,
  active = new Set(),
  allowNullPrototype = false,
  budget = { nodes: 0 },
  depth = 0
) {
  if (depth > 64 || ++budget.nodes > (budget.limit ?? 2000000)) return false
  if (value === null || value === undefined || ['string', 'boolean'].includes(typeof value))
    return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (
    typeof value !== 'object' ||
    active.has(value) ||
    (!Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      !(allowNullPrototype && Object.getPrototypeOf(value) === null))
  )
    return false
  const keys = Reflect.ownKeys(value),
    array = Array.isArray(value)
  // JSON arrays have dense canonical indexes only. Named properties are opaque payload,
  // not evidence that an empty coordinate array is safe to discard.
  if (
    array &&
    (keys.length !== value.length + 1 ||
      keys.some(
        (k) =>
          k !== 'length' &&
          (typeof k !== 'string' ||
            !/^(?:0|[1-9]\d*)$/u.test(k) ||
            !Number.isSafeInteger(Number(k)) ||
            Number(k) >= value.length)
      ))
  )
    return false
  active.add(value)
  for (const taggedOwnerKey of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, taggedOwnerKey)
    if (Array.isArray(value) && taggedOwnerKey === 'length') continue
    if (
      typeof taggedOwnerKey !== 'string' ||
      !descriptor?.enumerable ||
      !Object.hasOwn(descriptor, 'value') ||
      !taggedOwnerPlainData(descriptor.value, active, allowNullPrototype, budget, depth + 1)
    )
      return false
  }
  active.delete(value)
  return true
}

// This plan is not authorization. Original paint visibility is independently gated below.
function taggedOwnerPlan(table, packet) {
  try {
    taggedOwnerDemand(
      taggedOwnerPlainData(table) && taggedOwnerPlainData(packet),
      'plain data evidence only'
    )
    taggedOwnerDemand(
      taggedOwnerRect(table.cropRect) && table.readingRotation === undefined,
      'table geometry'
    )
    const { structTreeRows: rows, fullSourceProgram: program } = packet
    taggedOwnerDemand(
      Array.isArray(rows) &&
        rows.length === table.grid.length + 1 &&
        rows.every((r, n) => r.row === n && r.role === 'TR'),
      'logical rows'
    )
    const columns = table.grid[0].length
    taggedOwnerDemand(
      table.grid.every((r) => r.length === columns),
      'rectangular grid'
    )
    const fonts = program.fonts.filter(
      (f) => taggedOwnerRect(f.rect) && taggedOwnerInside(f.rect, table.cropRect)
    )
    const bySource = new Map(),
      owners = new Map(),
      tagSources = new Set()
    const originalSlots = new Set()
    for (const f of fonts) {
      taggedOwnerDemand(
        f.sourceItem?.pageNumber === table.page &&
          f.text === f.sourceItem.text &&
          !bySource.has(taggedOwnerKey(f.sourceItem)),
        'native source identity'
      )
      bySource.set(taggedOwnerKey(f.sourceItem), f)
    }
    for (const cell of table.cells) {
      taggedOwnerDemand(
        [cell.row, cell.column, cell.rowSpan, cell.colSpan].every(Number.isInteger) &&
          cell.row >= 0 &&
          cell.column >= 0 &&
          cell.rowSpan > 0 &&
          cell.colSpan > 0 &&
          cell.row + cell.rowSpan <= table.grid.length &&
          cell.column + cell.colSpan <= columns &&
          table.grid[cell.row][cell.column] === cell.text,
        'original cell ownership'
      )
      for (let r = cell.row; r < cell.row + cell.rowSpan; r++)
        for (let c = cell.column; c < cell.column + cell.colSpan; c++) {
          const id = `${r}:${c}`
          taggedOwnerDemand(
            !originalSlots.has(id) &&
              ((r === cell.row && c === cell.column) || table.grid[r][c] === ''),
            'original slot collision'
          )
          originalSlots.add(id)
        }
      taggedOwnerDemand(
        taggedOwnerRefs(cell).length === (cell.sourceRects?.length ?? 0),
        'source taggedOwnerRect count'
      )
      for (const [n, source] of taggedOwnerRefs(cell).entries()) {
        const id = taggedOwnerKey(source),
          font = bySource.get(id)
        taggedOwnerDemand(
          font &&
            fencedGroupOpaqueEqual(source, font.sourceItem) &&
            fencedGroupOpaqueEqual(cell.sourceRects[n], font.rect) &&
            !owners.has(id),
          'competing source owner'
        )
        owners.set(id, cell)
      }
    }
    taggedOwnerDemand(
      originalSlots.size === columns * table.grid.length,
      'original full slot ownership'
    )
    const tagFonts = (cell) =>
      cell.carriers.map((carrier) => {
        const id = taggedOwnerKey(carrier.sourceItem),
          font = bySource.get(id)
        taggedOwnerDemand(
          font &&
            fencedGroupOpaqueEqual(font.sourceItem, carrier.sourceItem) &&
            !tagSources.has(id),
          'marked carrier ambiguity'
        )
        tagSources.add(id)
        return font
      })
    const logical = rows.map((row) => row.cells.map((cell) => ({ ...cell, fonts: tagFonts(cell) })))
    taggedOwnerDemand(
      tagSources.size === bySource.size && [...bySource.keys()].every((k) => tagSources.has(k)),
      'complete table source correspondence'
    )
    const top = logical[0].filter((c) => c.fonts.length)
    taggedOwnerDemand(
      top.length >= 2 &&
        top.every(
          (c) => c.role === 'TH' && c.fonts.every((f) => !owners.has(taggedOwnerKey(f.sourceItem)))
        ),
      'missing parent tier'
    )
    taggedOwnerDemand(
      table.unassigned.length === top.flatMap((c) => c.fonts).length &&
        fencedGroupOpaqueEqual(
          table.unassigned,
          top.flatMap((c) => c.fonts.map((f) => f.text))
        ),
      'exact unassigned parents'
    )
    const horizontal = program.rules.filter(
      (r) =>
        Array.isArray(r) &&
        r.length === 4 &&
        r.every(Number.isFinite) &&
        r[1] === r[3] &&
        r[0] < r[2] &&
        r[1] > table.cropRect[1] &&
        r[1] < table.cropRect[3]
    )
    const bands = new Map()
    for (const rule of horizontal) {
      if (!bands.has(rule[1])) bands.set(rule[1], [])
      bands.get(rule[1]).push(rule)
    }
    const ordered = [...bands]
      .map(([y, segments]) => ({ y, segments: segments.sort((a, b) => a[0] - b[0]) }))
      .sort((a, b) => a.y - b.y)
    const parentBounds = taggedOwnerCover(top.flatMap((c) => c.fonts))
    const header = logical[1].flatMap((c) => c.fonts)
    const subBounds = taggedOwnerCover(header)
    const laneBands = ordered.filter((b) => b.y > subBounds[3] && b.segments.length === columns)
    taggedOwnerDemand(laneBands.length >= 2, 'native full column fences')
    const lanes = laneBands[0].segments
    taggedOwnerDemand(
      lanes.every((r, n) => !n || lanes[n - 1][2] < r[0]) &&
        laneBands.every((b) =>
          b.segments.every(
            (r, n) => Math.abs(r[0] - lanes[n][0]) < 0.02 && Math.abs(r[2] - lanes[n][2]) < 0.02
          )
        ),
      'stable native lanes'
    )
    const topBands = ordered.filter((b) => b.y < parentBounds[1] && b.segments.length > 1)
    taggedOwnerDemand(topBands.length === 1, 'unique top fence')
    const topSegments = topBands[0].segments
    const parents = top.map((c) => {
      const bounds = taggedOwnerCover(c.fonts),
        matches = topSegments.filter((r) => bounds[0] >= r[0] && bounds[2] <= r[2])
      taggedOwnerDemand(matches.length === 1, 'unique parent segment')
      const segment = matches[0]
      const covered = lanes.flatMap((lane, n) =>
        lane[0] >= segment[0] - 0.02 && lane[2] <= segment[2] + 0.02 ? [n] : []
      )
      taggedOwnerDemand(
        covered.length &&
          Math.abs(lanes[covered[0]][0] - segment[0]) < 0.02 &&
          Math.abs(lanes[covered.at(-1)][2] - segment[2]) < 0.02 &&
          covered.every((n, i) => n === covered[0] + i),
        'parent span fence'
      )
      return nativeWholeOwnerRepairCell(
        { rowSpan: 1, colSpan: 1, sourceItems: [] },
        c.fonts,
        0,
        covered[0],
        undefined,
        { colSpan: covered.length }
      )
    })
    taggedOwnerDemand(parents.every(Boolean), 'native parent literal')
    const rowOwners = logical.slice(1).map((cells, n) => {
      const dataFonts = cells.filter((c) => c.role === 'TD').flatMap((c) => c.fonts)
      taggedOwnerDemand(dataFonts.length, 'native logical record anchor')
      const oldRows = new Set(dataFonts.map((f) => owners.get(taggedOwnerKey(f.sourceItem))?.row))
      taggedOwnerDemand(oldRows.size === 1 && oldRows.has(n), 'TR source record correspondence')
      for (const font of dataFonts) {
        const owner = owners.get(taggedOwnerKey(font.sourceItem)),
          lane = lanes[owner.column]
        taggedOwnerDemand(
          lane && font.rect[0] >= lane[0] && font.rect[2] <= lane[2],
          'native column owner'
        )
      }
      return { oldRow: n, bounds: taggedOwnerCover(dataFonts) }
    })
    const groups = []
    for (let logicalRow = 2; logicalRow < logical.length; logicalRow++) {
      for (const tagged of logical[logicalRow].filter((c) => c.role === 'TH' && c.fonts.length)) {
        const candidates = new Set(
          tagged.fonts.map((f) => owners.get(taggedOwnerKey(f.sourceItem)))
        )
        taggedOwnerDemand(
          candidates.size === 1 && !candidates.has(undefined),
          'unique existing group owner'
        )
        const donor = [...candidates][0],
          bounds = taggedOwnerCover(tagged.fonts),
          lane = lanes[donor.column]
        taggedOwnerDemand(
          donor.colSpan === 1 &&
            donor.column === 0 &&
            fencedGroupOpaqueEqual(
              taggedOwnerRefs(donor),
              tagged.fonts.map((f) => f.sourceItem)
            ) &&
            bounds[0] >= lane[0] &&
            bounds[2] <= lane[2],
          'complete group literal'
        )
        const fences = ordered.filter((b) =>
          b.segments.some((r) => Math.abs(r[0] - lane[0]) < 0.02 && Math.abs(r[2] - lane[2]) < 0.02)
        )
        const before = fences.filter((b) => b.y < bounds[1]).at(-1),
          after = fences.find((b) => b.y > bounds[3])
        taggedOwnerDemand(before && after, 'closed group section')
        const section = rowOwners.filter((r) => r.bounds[1] > before.y && r.bounds[3] < after.y)
        taggedOwnerDemand(
          section.length > 1 &&
            section[0].oldRow === logicalRow - 1 &&
            section.every((r, n) => r.oldRow === section[0].oldRow + n),
          'section TR start and extent'
        )
        taggedOwnerDemand(
          !rowOwners.some(
            (r) => r.bounds[1] < after.y && r.bounds[3] > before.y && !section.includes(r)
          ),
          'section intersects another logical row'
        )
        groups.push({ donor, row: logicalRow, rowSpan: section.length })
      }
    }
    taggedOwnerDemand(groups.length >= 1, 'existing group owners')
    const drops = [],
      next = []
    for (const cell of table.cells) {
      const group = groups.find((g) => g.donor === cell)
      if (group) next.push({ ...structuredClone(cell), row: group.row, rowSpan: group.rowSpan })
      else {
        const covering = groups.filter(
          (g) =>
            cell.column === g.donor.column &&
            cell.row + 1 >= g.row &&
            cell.row + 1 < g.row + g.rowSpan
        )
        if (covering.length) {
          taggedOwnerDemand(
            covering.length === 1 &&
              taggedOwnerSourceFree(cell, table.cropRect, covering[0].donor, lanes[cell.column]),
            'occupied group slot'
          )
          drops.push({ row: cell.row, column: cell.column })
        } else next.push({ ...structuredClone(cell), row: cell.row + 1 })
      }
    }
    next.push(...parents)
    const grid = Array.from({ length: rows.length }, () => Array(columns).fill('')),
      slots = new Set()
    for (const cell of next) {
      taggedOwnerDemand(
        Number.isInteger(cell.row) &&
          Number.isInteger(cell.column) &&
          cell.row >= 0 &&
          cell.column >= 0 &&
          cell.row + cell.rowSpan <= rows.length &&
          cell.column + cell.colSpan <= columns,
        'cell grid range'
      )
      for (let r = cell.row; r < cell.row + cell.rowSpan; r++)
        for (let c = cell.column; c < cell.column + cell.colSpan; c++) {
          const id = `${r}:${c}`
          taggedOwnerDemand(!slots.has(id), 'owner slot collision')
          slots.add(id)
        }
      grid[cell.row][cell.column] = cell.text
    }
    const claimed = next.flatMap(taggedOwnerRefs)
    taggedOwnerDemand(
      claimed.length === fonts.length &&
        new Set(claimed.map(taggedOwnerKey)).size === fonts.length &&
        claimed.every((s) =>
          fencedGroupOpaqueEqual(s, bySource.get(taggedOwnerKey(s))?.sourceItem)
        ),
      'full repaired carrier conservation'
    )
    return {
      qualified: true,
      cells: next,
      grid,
      parents: parents.map((c) => ({
        row: c.row,
        column: c.column,
        colSpan: c.colSpan,
        sourceItems: c.sourceItems
      })),
      groups: groups.map((g) => ({
        fromRow: g.donor.row,
        row: g.row,
        rowSpan: g.rowSpan,
        sourceItems: taggedOwnerRefs(g.donor)
      })),
      droppedEmptyPlaceholders: drops
    }
  } catch (error) {
    return { qualified: false, reason: error.message }
  }
}

const taggedVisibleArr = (v) =>
  Array.isArray(v) ? v : v instanceof Float32Array ? [...v] : undefined
const taggedVisibleNear = (a, b) =>
  Number.isFinite(a) &&
  Number.isFinite(b) &&
  Math.abs(a - b) <= Math.max(1, Math.abs(a), Math.abs(b)) * 2 ** -23 * 16
const taggedVisibleFinite = (a, n) => Array.isArray(a) && a.length === n && a.every(Number.isFinite)
const taggedVisibleChars = (s) => [...s].filter((c) => c.trim())
function taggedOwnerVisiblePacket(
  content,
  operators,
  viewport,
  fonts,
  graphics,
  target,
  loadedFonts,
  glyphPaths,
  parentDomains
) {
  const normalizedHulls = new Map(),
    closedOutlines = new Map(),
    inkRects = new Map()
  const inkRect = (glyph) => {
    if (inkRects.has(glyph)) return inkRects.get(glyph)
    const id = glyph.font + '_path_' + glyph.fontChar
    if (!normalizedHulls.has(id)) {
      const path = glyphPaths?.get(id)
      let hull = null,
        cursor = 0,
        open = false
      if (Array.isArray(path)) {
        hull = []
        while (cursor < path.length) {
          const op = path[cursor++],
            count = { 0: 2, 1: 2, 2: 6, 3: 4, 4: 0 }[op]
          if (count === undefined || cursor + count > path.length || (op !== 0 && !open)) {
            hull = null
            break
          }
          if (op === 0) open = true
          if (op === 4) open = false
          for (let k = 0; k < count; k += 2) {
            const x = path[cursor + k],
              y = path[cursor + k + 1]
            if (!Number.isFinite(x) || !Number.isFinite(y)) {
              hull = null
              break
            }
            if (!hull.length) hull = [x, y, x, y]
            else
              hull = [
                Math.min(hull[0], x),
                Math.min(hull[1], y),
                Math.max(hull[2], x),
                Math.max(hull[3], y)
              ]
          }
          if (!hull) break
          cursor += count
        }
      }
      normalizedHulls.set(id, hull)
    }
    const hull = normalizedHulls.get(id)
    let rect = hull
    if (hull?.length) {
      const a = [glyph.start[0] + hull[0] * glyph.width, glyph.start[1] + hull[1] * glyph.height],
        b = [glyph.start[0] + hull[2] * glyph.width, glyph.start[1] + hull[3] * glyph.height]
      fencedGroupUtil.applyTransform(a, viewport.transform)
      fencedGroupUtil.applyTransform(b, viewport.transform)
      rect = [...a, ...b].every(Number.isFinite)
        ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]
        : null
    }
    inkRects.set(glyph, rect)
    return rect
  }
  const inkInsideRect = (glyph, clip) => {
    const id = glyph.font + '_path_' + glyph.fontChar
    if (!closedOutlines.has(id))
      closedOutlines.set(id, taggedOwnerClosedOutline(glyphPaths?.get(id)))
    const rect = inkRect(glyph)
    // Cached Bezier control hull containment proves the whole outline is inside.
    return (
      closedOutlines.get(id) &&
      rect?.length === 4 &&
      rect.every((v, k) => (k < 2 ? v >= clip[k] : v <= clip[k]))
    )
  }
  const fail = (reason, details) => ({ qualified: false, reason, details }),
    stack = [],
    markers = [],
    dependencies = new Set(),
    painted = [],
    paths = [],
    outsideUnknown = []
  let state = {
      matrix: [1, 0, 0, 1, 0, 0],
      font: undefined,
      size: undefined,
      fill: '#000000',
      stroke: '#000000',
      charSpace: 0,
      clip: [0, 0, viewport.width, viewport.height]
    },
    text = false,
    tm = [1, 0, 0, 1, 0, 0],
    line = [...tm],
    pendingClip = false
  const rectTransform = (r, m) => {
    const a = [r[0], r[1]],
      b = [r[2], r[3]]
    fencedGroupUtil.applyTransform(a, m)
    fencedGroupUtil.applyTransform(b, m)
    return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]
  }
  const color = (a) =>
    Array.isArray(a) && a.length === 1 && typeof a[0] === 'string' && /^#[0-9a-f]{6}$/u.test(a[0])
  for (let n = 0; n < operators.fnArray.length; n++) {
    const code = operators.fnArray[n],
      a = operators.argsArray[n]
    if (pendingClip && code !== fencedGroupOPS.constructPath)
      return fail('clip-not-immediately-closed', { n })
    if (code === fencedGroupOPS.beginMarkedContentProps) {
      if (
        !Array.isArray(a) ||
        a.length !== 2 ||
        typeof a[0] !== 'string' ||
        !(
          (a[0] === 'Artifact' && (a[1] === null || a[1] === undefined)) ||
          (Number.isSafeInteger(a[1]) && a[1] >= 0)
        )
      )
        return fail('marker-shape', { n })
      markers.push(a[1] ?? null)
    } else if (code === fencedGroupOPS.beginMarkedContent) {
      if (!Array.isArray(a) || a.length !== 1 || typeof a[0]?.name !== 'string')
        return fail('marker-shape', { n })
      markers.push(null)
    } else if (code === fencedGroupOPS.endMarkedContent) {
      if (!markers.length) return fail('marker-stack', { n })
      markers.pop()
    } else if (code === fencedGroupOPS.dependency) {
      if (!Array.isArray(a) || !a.every((s) => typeof s === 'string'))
        return fail('dependency', { n })
      for (const s of a) dependencies.add(s)
    } else if (code === fencedGroupOPS.save) {
      stack.push({ ...state, matrix: [...state.matrix], clip: [...state.clip] })
    } else if (code === fencedGroupOPS.restore) {
      if (!stack.length || text) return fail('restore', { n })
      state = stack.pop()
    } else if (code === fencedGroupOPS.beginText) {
      if (text) return fail('nested-text', { n })
      text = true
      tm = [1, 0, 0, 1, 0, 0]
      line = [...tm]
    } else if (code === fencedGroupOPS.endText) {
      if (!text) return fail('end-text', { n })
      text = false
    } else if (code === fencedGroupOPS.setFont) {
      if (
        !Array.isArray(a) ||
        a.length !== 2 ||
        !dependencies.has(a[0]) ||
        !content.styles[a[0]] ||
        !(a[1] > 0 && Number.isFinite(a[1]))
      )
        return fail('font', { n })
      state.font = a[0]
      state.size = a[1]
    } else if (code === fencedGroupOPS.setTextMatrix || code === fencedGroupOPS.transform) {
      const m = a?.length === 1 ? taggedVisibleArr(a[0]) : a
      if (!taggedVisibleFinite(m, 6) || m[1] !== 0 || m[2] !== 0 || m[0] <= 0 || m[3] <= 0)
        return fail('matrix', { n })
      if (code === fencedGroupOPS.transform)
        state.matrix = fencedGroupUtil.transform(state.matrix, m)
      else {
        tm = [...m]
        line = [...m]
      }
    } else if (code === fencedGroupOPS.moveText) {
      if (!taggedVisibleFinite(a, 2)) return fail('move', { n })
      line[4] += line[0] * a[0] + line[2] * a[1]
      line[5] += line[1] * a[0] + line[3] * a[1]
      tm = [...line]
    } else if (
      code === fencedGroupOPS.setFillRGBColor ||
      code === fencedGroupOPS.setStrokeRGBColor
    ) {
      if (!color(a)) return fail('color', { n })
      state[code === fencedGroupOPS.setFillRGBColor ? 'fill' : 'stroke'] = a[0]
    } else if (code === fencedGroupOPS.setCharSpacing) {
      if (!taggedVisibleFinite(a, 1)) return fail('char-space', { n })
      state.charSpace = a[0]
    } else if (code === fencedGroupOPS.setGState) {
      if (
        !Array.isArray(a) ||
        a.length !== 1 ||
        !Array.isArray(a[0]) ||
        !a[0].length ||
        a[0].some(
          (e) =>
            !Array.isArray(e) ||
            e.length !== 2 ||
            !(
              (e[0] === 'BM' && e[1] === 'source-over') ||
              (['ca', 'CA'].includes(e[0]) && e[1] === 1)
            )
        )
      )
        return fail('opacity', { n })
    } else if (code === fencedGroupOPS.eoClip) {
      if (pendingClip || a !== null) return fail('clip', { n })
      pendingClip = true
    } else if (code === fencedGroupOPS.constructPath) {
      const p = taggedVisibleArr(a?.[1]?.[0]),
        bounds = taggedVisibleArr(a?.[2])
      if (
        a?.length !== 3 ||
        a[1]?.length !== 1 ||
        !p ||
        p.length !== 13 ||
        ![0, 1, 1, 1, 4].every((v, k) => p[[0, 3, 6, 9, 12][k]] === v) ||
        !p.every(Number.isFinite) ||
        !taggedVisibleFinite(bounds, 4) ||
        !(p[1] < p[4] && p[2] < p[8]) ||
        p[2] !== p[5] ||
        p[4] !== p[7] ||
        p[8] !== p[11] ||
        p[1] !== p[10] ||
        !bounds.every((v, k) => v === [p[1], p[2], p[4], p[8]][k])
      )
        return fail('rect-program', { n })
      const r = rectTransform(bounds, fencedGroupUtil.transform(viewport.transform, state.matrix))
      if (pendingClip) {
        if (a[0] !== fencedGroupOPS.endPath) return fail('clip-painted', { n })
        state.clip = [
          Math.max(state.clip[0], r[0]),
          Math.max(state.clip[1], r[1]),
          Math.min(state.clip[2], r[2]),
          Math.min(state.clip[3], r[3])
        ]
        if (!(state.clip[0] < state.clip[2] && state.clip[1] < state.clip[3]))
          return fail('empty-clip', { n })
        pendingClip = false
      } else {
        if (a[0] !== fencedGroupOPS.eoFill || text) return fail('paint-program', { n })
        if (r.some((v, k) => (k < 2 ? v < state.clip[k] : v > state.clip[k])))
          return fail('clipped-path', { n })
        paths.push({ rect: r, color: state.fill, n })
      }
    } else if (code === fencedGroupOPS.showText) {
      if (!text || !state.font || !Array.isArray(a) || a.length !== 1 || !Array.isArray(a[0]))
        return fail('show', { n })
      let advance = 0
      for (const g of a[0]) {
        if (typeof g === 'number') {
          if (!Number.isFinite(g)) return fail('kerning', { n })
          advance -= (g * state.size) / 1000
          continue
        }
        if (
          !g ||
          typeof g.unicode !== 'string' ||
          typeof g.fontChar !== 'string' ||
          !Number.isFinite(g.width) ||
          g.width < 0 ||
          g.accent != null ||
          g.operatorListId != null ||
          !Number.isInteger(g.originalCharCode) ||
          (g.isInFont !== true &&
            !(
              loadedFonts?.get(state.font)?.missingFile === false &&
              loadedFonts.get(state.font).isType3Font === false &&
              !g.unicode.trim()
            ) &&
            !(g.isSpace === true && g.fontChar === ' ' && !g.unicode.trim()) &&
            !(
              typeof g.unicode === 'string' &&
              !g.unicode.trim() &&
              taggedVisibleFinite(target, 4) &&
              (state.clip[2] <= target[0] ||
                state.clip[0] >= target[2] ||
                state.clip[3] <= target[1] ||
                state.clip[1] >= target[3])
            ))
        )
          return fail('glyph', {
            n,
            glyph: g,
            clip: state.clip,
            font: state.font,
            size: state.size,
            textMatrix: tm,
            target
          })
        // Unicode whitespace and isSpace only affect extraction/spacing. PDF.js
        // can still paint a different, nonempty native fontChar at this position.
        if (
          !g.unicode.trim() &&
          !(g.isInFont !== true && loadedFonts?.get(state.font)?.missingFile === false) &&
          !(
            state.clip[2] <= target[0] ||
            state.clip[0] >= target[2] ||
            state.clip[3] <= target[1] ||
            state.clip[1] >= target[3]
          )
        ) {
          const outline = glyphPaths.get(state.font + '_path_' + g.fontChar)
          // Only an actual empty path proves no paint; missing, cancelled or
          // otherwise unqualified outlines remain unknown rather than empty.
          if (!Array.isArray(outline) || outline.length) return fail('whitespace-ink', { n })
        }
        if (g.isInFont !== true && g.isSpace !== true)
          outsideUnknown.push({ n, glyph: g, clip: [...state.clip] })
        const matrix = fencedGroupUtil.transform(state.matrix, tm),
          start = [advance, 0],
          end = [advance + (g.width * state.size) / 1000, 0]
        fencedGroupUtil.applyTransform(start, matrix)
        fencedGroupUtil.applyTransform(end, matrix)
        for (const char of taggedVisibleChars(g.unicode))
          painted.push({
            char,
            fontChar: g.fontChar,
            font: state.font,
            start,
            end,
            height: state.size * matrix[3],
            width: state.size * matrix[0],
            clip: [...state.clip],
            fill: state.fill,
            mcid: markers.findLast((v) => v !== null) ?? null,
            n
          })
        advance += (g.width * state.size) / 1000 + state.charSpace
      }
      tm[4] += tm[0] * advance
      tm[5] += tm[1] * advance
    } else return fail('unknown-operator', { n, code })
  }
  if (stack.length || markers.length || text || pendingClip) return fail('unclosed-program')
  let offset = 0
  const owned = [],
    selectedGlyphs = []
  for (const raw of content.items.filter((i) => typeof i.str === 'string' && i.str.trim())) {
    const literal = taggedVisibleChars(raw.str),
      gs = painted.slice(offset, offset + literal.length)
    if (
      gs.length !== literal.length ||
      gs.some((g, k) => g.char !== literal[k] || g.font !== raw.fontName)
    )
      return fail('glyph-literal', {
        sourceItem: raw.sourceItem,
        offset,
        actual: gs.map((g) => g.char).join('')
      })
    if (
      gs.some(
        (g) =>
          !taggedVisibleNear(g.start[1], raw.transform[5]) ||
          !taggedVisibleNear(g.height, raw.height) ||
          !taggedVisibleNear(g.width, raw.transform[0])
      )
    )
      return fail('glyph-metric', { sourceItem: raw.sourceItem })
    const f = fonts.filter((f) => f.sourceItem?.index === raw.sourceItem.index)
    if (f.length !== 1) return fail('source-font', { sourceItem: raw.sourceItem })
    if (
      taggedOwnerInside(f[0].rect, target) &&
      gs.some((g) => !inkInsideRect(g, g.clip) || !inkInsideRect(g, target))
    )
      return fail('selected-glyph-outline', { sourceItem: raw.sourceItem })
    const parentDomain = parentDomains.get(taggedOwnerKey(raw.sourceItem))
    // Parent ownership follows the complete native span fence, rather than a
    // nominal text box or an individual leaf column inside a merged parent.
    if (
      parentDomain &&
      gs.some((g) => {
        const ink = inkRect(g)
        return !ink || ink.length !== 4 || ink[0] < parentDomain[0] || ink[2] > parentDomain[1]
      })
    )
      return fail('parent-glyph-domain', { sourceItem: raw.sourceItem })
    if (taggedOwnerInside(f[0].rect, target)) selectedGlyphs.push(...gs)
    const clip = gs[0].clip
    if (
      gs.some(
        (g) =>
          !g.clip.every((v, k) => v === clip[k]) || g.mcid !== gs[0].mcid || g.fill !== gs[0].fill
      )
    )
      return fail('carrier-state', { sourceItem: raw.sourceItem })
    if (
      f[0].rect.some((v, k) => (k < 2 ? v < clip[k] : v > clip[k])) &&
      !gs.every((g) => inkInsideRect(g, clip))
    )
      return fail('clipped-carrier', {
        sourceItem: raw.sourceItem,
        fontRect: f[0].rect,
        clip,
        glyphs: gs
      })
    const first = Math.min(...gs.map((g) => g.start[0])),
      last = Math.max(...gs.map((g) => g.end[0]))
    if (!taggedVisibleNear(first, raw.transform[4]) || !taggedVisibleNear(last - first, raw.width))
      return fail('glyph-advance', { sourceItem: raw.sourceItem, first, last, width: raw.width })
    owned.push({
      sourceItem: raw.sourceItem,
      mcid: gs[0].mcid,
      fill: gs[0].fill,
      clip,
      lastPaint: Math.max(...gs.map((g) => g.n))
    })
    offset += literal.length
  }
  if (offset !== painted.length) return fail('glyph-remainder', { offset, total: painted.length })
  const overlaps = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
    laterInk = (glyph, rect, n) => {
      if (glyph.n <= n || !overlaps(glyph.clip, rect)) return false
      const ink = inkRect(glyph)
      // Only a captured empty path proves no ink. Missing or malformed paths
      // cannot establish exclusion even when the nominal carrier lies outside.
      return ink === null || (ink.length === 4 && overlaps(ink, rect))
    }
  const hasBackgroundContrast = (rect, color, n) => {
    const background = paths
      .filter(
        (prior) => prior.n < n && prior.color === color && taggedOwnerInside(rect, prior.rect)
      )
      .at(-1)
    if (!background) return true
    const restoration = paths
      .filter((prior) => prior.n > background.n && prior.n < n && overlaps(prior.rect, rect))
      .at(-1)
    // Native ink on an identical opaque background adds no visible division or
    // character. Only a complete contrasting repaint restores the whole strip
    // and surroundings; partial marks or unknown later ink cannot do so.
    return (
      !!restoration &&
      restoration.color !== color &&
      taggedOwnerInside(background.rect, restoration.rect) &&
      !painted.some((glyph) => glyph.n < n && laterInk(glyph, rect, restoration.n))
    )
  }
  for (const glyph of selectedGlyphs) {
    const rect = inkRect(glyph)
    if (!hasBackgroundContrast(rect, glyph.fill, glyph.n))
      return fail('selected-glyph-hidden-on-same-fill', { n: glyph.n })
    if (
      painted.some((later) => laterInk(later, rect, glyph.n)) ||
      paths.some((p) => p.n > glyph.n && overlaps(p.rect, rect))
    )
      return fail('selected-glyph-overpaint', { n: glyph.n })
  }
  const thickness =
    1.1 *
    Math.max(
      Math.hypot(viewport.transform[0], viewport.transform[1]),
      Math.hypot(viewport.transform[2], viewport.transform[3])
    )
  for (const path of paths.filter(
    (p) =>
      p.color === '#000000' &&
      p.rect[3] - p.rect[1] <= thickness &&
      p.rect[2] - p.rect[0] >= 4 &&
      overlaps(p.rect, target)
  )) {
    if (!hasBackgroundContrast(path.rect, path.color, path.n))
      return fail('rule-hidden-on-same-fill', { n: path.n })
    if (painted.some((glyph) => laterInk(glyph, path.rect, path.n)))
      return fail('rule-glyph-overpaint', { n: path.n })
  }
  if (paths.length !== graphics.length)
    return fail('graphics-count', { paths: paths.length, graphics: graphics.length })
  return { qualified: true, owned, paths, outsideUnknown, allSourceGlyphs: painted.length }
}

function taggedOwnerClosedOutline(path) {
  if (!Array.isArray(path) || !path.length || path.length > 8192 || !path.every(Number.isFinite))
    return false
  let cursor = 0,
    open = false,
    points = 0,
    start,
    end,
    drawn = false,
    hull,
    origin,
    area = 0,
    magnitude = 0,
    terms = 0
  // Analytic integral of x dy - y dx for Bezier boundaries. A nonzero total
  // proves some nonzero winding fill; a zero total is conservatively unknown.
  const cross = (a, b, weight) => {
    const ax = a[0] - origin[0],
      ay = a[1] - origin[1],
      bx = b[0] - origin[0],
      by = b[1] - origin[1]
    area += weight * (ax * by - ay * bx)
    magnitude +=
      Math.abs(weight) *
      ((Math.abs(a[0]) + Math.abs(origin[0])) * (Math.abs(b[1]) + Math.abs(origin[1])) +
        (Math.abs(a[1]) + Math.abs(origin[1])) * (Math.abs(b[0]) + Math.abs(origin[0])))
    terms++
  }
  const segment = (ps) => {
    const weights =
      ps.length === 2
        ? [1]
        : ps.length === 3
          ? [2 / 3, 1 / 3, 2 / 3]
          : [0.6, 0.3, 0.1, 0.3, 0.3, 0.6]
    let at = 0
    for (let i = 0; i < ps.length - 1; i++)
      for (let j = i + 1; j < ps.length; j++) cross(ps[i], ps[j], weights[at++])
  }
  const positiveHull = () =>
    drawn &&
    Number.isFinite(hull[2] - hull[0]) &&
    Number.isFinite(hull[3] - hull[1]) &&
    hull[2] > hull[0] &&
    hull[3] > hull[1]
  const geometricallyClosed = () => positiveHull() && end[0] === start[0] && end[1] === start[1]
  while (cursor < path.length) {
    const op = path[cursor++],
      count = { 0: 2, 1: 2, 2: 6, 3: 4, 4: 0 }[op]
    if (
      count === undefined ||
      cursor + count > path.length ||
      (op === 0 ? open && !geometricallyClosed() : !open)
    )
      return false
    if (op === 0) {
      open = true
      start = [path[cursor], path[cursor + 1]]
      origin ??= start
      end = start
      drawn = false
      hull = [...start, ...start]
    } else if (op === 4) {
      if (!positiveHull()) return false
      segment([end, start])
      open = false
    } else {
      const ps = [end]
      for (let k = 0; k < count; k += 2) ps.push([path[cursor + k], path[cursor + k + 1]])
      segment(ps)
      end = [path[cursor + count - 2], path[cursor + count - 1]]
      drawn = true
      for (let k = 0; k < count; k += 2) {
        hull[0] = Math.min(hull[0], path[cursor + k])
        hull[1] = Math.min(hull[1], path[cursor + k + 1])
        hull[2] = Math.max(hull[2], path[cursor + k])
        hull[3] = Math.max(hull[3], path[cursor + k + 1])
      }
    }
    points += count / 2
    cursor += count
  }
  // PDF.js also emits closed TrueType contours as an explicit final segment
  // back to the initial point, followed by moveTo rather than closePath.
  // The envelope includes coordinate subtraction, products, coefficient
  // rounding and sequential accumulation. The operation-count margin also
  // bounds subnormal rounding; overflow or numerical cancellation refuses.
  const error = 64 * (terms + 1) * (Number.EPSILON * magnitude + Number.MIN_VALUE)
  return (
    points > 0 &&
    (!open || geometricallyClosed()) &&
    Number.isFinite(area) &&
    Number.isFinite(error) &&
    Math.abs(area) > error
  )
}

function taggedOwnerNativeData(value, active = new Set(), budget = { nodes: 0 }, depth = 0) {
  if (depth > 64 || ++budget.nodes > 2000000) return false
  if (value === null || value === undefined || ['string', 'boolean'].includes(typeof value))
    return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || active.has(value)) return false
  const typed = Object.getPrototypeOf(value) === Float32Array.prototype,
    array = Array.isArray(value),
    prototype = Object.getPrototypeOf(value)
  if (!typed && !array && prototype !== Object.prototype && prototype !== null) return false
  const keys = Reflect.ownKeys(value)
  if (
    (typed || array) &&
    (keys.length !== value.length + (array ? 1 : 0) ||
      keys.some(
        (k) =>
          !(array && k === 'length') &&
          (typeof k !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(k) || +k >= value.length)
      ))
  )
    return false
  active.add(value)
  for (const key of keys) {
    if (array && key === 'length') continue
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      typeof key !== 'string' ||
      !descriptor?.enumerable ||
      !Object.hasOwn(descriptor, 'value') ||
      !taggedOwnerNativeData(descriptor.value, active, budget, depth + 1)
    )
      return false
  }
  active.delete(value)
  return true
}

export function recoverNativeTaggedHeaderGroupOwners(table, items, rules, context) {
  try {
    // Untagged pages have no ownership witness; leave their existing repairs alone.
    const markedDescriptor =
      context && Object.getOwnPropertyDescriptor(context, 'nativeMarkedSource')
    if (
      !markedDescriptor ||
      !Object.hasOwn(markedDescriptor, 'value') ||
      !markedDescriptor.value ||
      typeof markedDescriptor.value !== 'object'
    )
      return
    if (!Array.isArray(items) || !taggedOwnerNativeData(items)) return
    const unassignedDescriptor = table && Object.getOwnPropertyDescriptor(table, 'unassigned')
    if (
      !unassignedDescriptor ||
      !Object.hasOwn(unassignedDescriptor, 'value') ||
      !Array.isArray(unassignedDescriptor.value)
    )
      return
    const unassigned = unassignedDescriptor.value,
      witness = Object.getOwnPropertyDescriptor(unassigned, 'reconciliationItems')
    if (witness) {
      if (
        !Object.hasOwn(witness, 'value') ||
        witness.enumerable ||
        !taggedOwnerPlainData(witness.value) ||
        !Array.isArray(witness.value)
      )
        return
      const cropDescriptor = Object.getOwnPropertyDescriptor(table, 'cropRect')
      if (
        !cropDescriptor ||
        !Object.hasOwn(cropDescriptor, 'value') ||
        !taggedOwnerPlainData(cropDescriptor.value) ||
        !taggedOwnerRect(cropDescriptor.value)
      )
        return
      const scoped = items.filter(
        (f) =>
          f.text?.trim() &&
          taggedOwnerRect(f.rect) &&
          taggedOwnerInside(f.rect, cropDescriptor.value)
      )
      if (scoped.length !== witness.value.length) return
      const witnessed = new Set()
      for (const original of witness.value) {
        const matches = scoped.filter(
          (f) =>
            f.sourceItem &&
            fencedGroupOpaqueEqual(f.sourceItem, original.sourceItem) &&
            fencedGroupSameFont(f, original)
        )
        if (matches.length !== 1 || witnessed.has(matches[0])) return
        witnessed.add(matches[0])
        const canonical = { ...matches[0] }
        if (!Object.hasOwn(original, 'fontDescent')) delete canonical.fontDescent
        if (!fencedGroupOpaqueEqual(original, canonical)) return
      }
      const keys = Reflect.ownKeys(unassigned)
      if (
        keys.length !== unassigned.length + 2 ||
        keys.some(
          (k) =>
            !['length', 'reconciliationItems'].includes(k) &&
            (typeof k !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(k) || +k >= unassigned.length)
        )
      )
        return
      const clean = []
      for (let n = 0; n < unassigned.length; n++) {
        const descriptor = Object.getOwnPropertyDescriptor(unassigned, String(n))
        if (
          !descriptor?.enumerable ||
          !Object.hasOwn(descriptor, 'value') ||
          typeof descriptor.value !== 'string'
        )
          return
        clean.push(descriptor.value)
      }
      const candidate = {}
      for (const key of Reflect.ownKeys(table)) {
        const descriptor = Object.getOwnPropertyDescriptor(table, key)
        if (
          typeof key !== 'string' ||
          !descriptor?.enumerable ||
          !Object.hasOwn(descriptor, 'value')
        )
          return
        Object.defineProperty(candidate, key, {
          ...descriptor,
          value: key === 'unassigned' ? clean : descriptor.value
        })
      }
      table = candidate
    }
    if (!context || typeof context !== 'object') return
    const evidence = new Map()
    for (const key of [
      'nativeMarkedSource',
      'sourceContent',
      'content',
      'operators',
      'viewport',
      'nativeEvidenceGraphics'
    ]) {
      const descriptor = Object.getOwnPropertyDescriptor(context, key)
      if (descriptor && !Object.hasOwn(descriptor, 'value')) return
      evidence.set(key, descriptor?.value)
    }
    const marked = evidence.get('nativeMarkedSource'),
      content = evidence.get('sourceContent') ?? evidence.get('content'),
      operators = evidence.get('operators'),
      viewport = evidence.get('viewport'),
      graphics = evidence.get('nativeEvidenceGraphics')
    if (
      !taggedOwnerNativeData(items) ||
      !taggedOwnerNativeData(rules) ||
      !taggedOwnerNativeData(content) ||
      !taggedOwnerNativeData(operators) ||
      !taggedOwnerNativeData(graphics)
    )
      return
    if (
      !taggedOwnerPlainData(table) ||
      !taggedOwnerPlainData(marked, new Set(), true) ||
      !Array.isArray(items) ||
      !Array.isArray(rules) ||
      !content?.items ||
      !content.styles ||
      !operators?.fnArray ||
      !operators.argsArray ||
      operators.fnArray.length !== operators.argsArray.length ||
      operators.fnArray.length > 100000 ||
      !viewport ||
      !(viewport.width > 0 && viewport.height > 0) ||
      !taggedVisibleFinite(viewport.transform, 6) ||
      !Array.isArray(graphics) ||
      graphics.length > 4096 ||
      !Array.isArray(marked.fonts) ||
      !Array.isArray(marked.glyphPaths) ||
      !marked.markedContent?.items ||
      !marked.structureTree
    )
      return
    if (
      Object.keys(marked).some(
        (k) => !['structureTree', 'markedContent', 'fonts', 'glyphPaths'].includes(k)
      ) ||
      marked.fonts.length > 64 ||
      marked.glyphPaths.length > 4096
    )
      return
    if (!taggedOwnerPlainData(marked.structureTree, new Set(), true, { nodes: 0, limit: 10000 }))
      return
    const loaded = new Map(),
      paths = new Map()
    for (const font of marked.fonts) {
      if (
        !font ||
        Object.keys(font).some(
          (k) => !['id', 'missingFile', 'isType3Font', 'vertical', 'remeasure'].includes(k)
        ) ||
        typeof font.id !== 'string' ||
        loaded.has(font.id) ||
        ['missingFile', 'isType3Font', 'vertical', 'remeasure'].some((k) => font[k] !== false) ||
        !content.styles[font.id] ||
        content.styles[font.id].vertical === true
      )
        return
      loaded.set(font.id, font)
    }
    if (loaded.size !== Object.keys(content.styles).length) return
    let outlinePoints = 0
    for (const outline of marked.glyphPaths) {
      if (
        Object.keys(outline).some((k) => !['id', 'path'].includes(k)) ||
        typeof outline.id !== 'string' ||
        paths.has(outline.id) ||
        !Array.isArray(outline.path) ||
        outline.path.length > 8192 ||
        !outline.path.every(Number.isFinite)
      )
        return
      outlinePoints += outline.path.length
      if (outlinePoints > 1000000) return
      paths.set(outline.id, outline.path)
    }
    const raw = content.items.filter((item) => typeof item.str === 'string'),
      markedStack = [],
      markerEvents = [],
      byId = new Map(),
      sourceMarked = new Map()
    let rawCursor = 0
    for (const item of marked.markedContent.items) {
      if (item.type === 'beginMarkedContent' || item.type === 'beginMarkedContentProps') {
        let numeric = null
        if (item.id != null) {
          const match = typeof item.id === 'string' && /^.+_mc(\d+)$/u.exec(item.id)
          if (!match || !Number.isSafeInteger(+match[1]) || byId.has(item.id)) return
          numeric = +match[1]
          byId.set(item.id, [])
        }
        if (
          typeof item.tag !== 'string' ||
          (item.type === 'beginMarkedContent' && numeric !== null) ||
          (numeric === null && item.tag !== 'Artifact')
        )
          return
        markedStack.push({ id: item.id ?? null, numeric })
        markerEvents.push({ type: item.type, tag: item.tag, numeric })
      } else if (item.type === 'endMarkedContent') {
        if (!markedStack.length) return
        markedStack.pop()
        markerEvents.push({ type: item.type })
      } else if (typeof item.str === 'string') {
        const current = raw[rawCursor++],
          { sourceItem, ...literal } = current ?? {}
        if (!current || !sourceItem || !fencedGroupOpaqueEqual(item, literal)) return
        const owner = markedStack.findLast((v) => v.id !== null) ?? { id: null, numeric: null }
        if (sourceMarked.has(taggedOwnerKey(sourceItem))) return
        sourceMarked.set(taggedOwnerKey(sourceItem), owner.numeric)
        if (owner.id !== null) byId.get(owner.id).push({ sourceItem })
      } else return
    }
    if (rawCursor !== raw.length || markedStack.length) return
    const operatorEvents = []
    for (let n = 0; n < operators.fnArray.length; n++) {
      const code = operators.fnArray[n],
        args = operators.argsArray[n]
      if (code === fencedGroupOPS.beginMarkedContentProps)
        operatorEvents.push({
          type: 'beginMarkedContentProps',
          tag: args?.[0],
          numeric: args?.[1] ?? null
        })
      else if (code === fencedGroupOPS.beginMarkedContent)
        operatorEvents.push({ type: 'beginMarkedContent', tag: args?.[0]?.name, numeric: null })
      else if (code === fencedGroupOPS.endMarkedContent)
        operatorEvents.push({ type: 'endMarkedContent' })
    }
    if (!fencedGroupOpaqueEqual(markerEvents, operatorEvents)) return
    const sourceFonts = items.filter((f) => f?.text?.trim()),
      claimed = new Set()
    for (const item of content.items) {
      if (typeof item.str !== 'string' || !item.str.trim()) continue
      const matches = sourceFonts.filter(
        (f) => f.sourceItem && fencedGroupOpaqueEqual(f.sourceItem, item.sourceItem)
      )
      if (
        matches.length !== 1 ||
        claimed.has(matches[0]) ||
        matches[0].text !== item.str ||
        !taggedOwnerRect(matches[0].rect) ||
        item.sourceItem.index !== content.items.indexOf(item) ||
        item.sourceItem.pageNumber !== table.page
      )
        return
      // Source identity does not prove a caller's token geometry. Reconstruct
      // the upright native box from the original text carrier and viewport.
      if (
        !taggedVisibleFinite(item.transform, 6) ||
        !(item.height > 0 && item.width > 0) ||
        item.dir !== 'ltr' ||
        Math.abs(item.transform[1]) >= 0.001 ||
        Math.abs(item.transform[2]) > Math.abs(item.transform[3]) * 0.5 ||
        item.transform[0] <= 0 ||
        viewport.transform[1] !== 0 ||
        viewport.transform[2] !== 0
      )
        return
      const baselinePoint = [item.transform[4], item.transform[5]]
      fencedGroupUtil.applyTransform(baselinePoint, viewport.transform)
      const scale = Math.hypot(viewport.transform[0], viewport.transform[1])
      const height = item.height * scale
      const rect = [
        baselinePoint[0],
        baselinePoint[1] - height,
        baselinePoint[0] + item.width * scale,
        baselinePoint[1]
      ]
      if (
        !fencedGroupOpaqueEqual(matches[0].rect, rect) ||
        matches[0].baseline !== baselinePoint[1] ||
        matches[0].height !== height ||
        matches[0].horizontal !== true
      )
        return
      claimed.add(matches[0])
    }
    if (claimed.size !== sourceFonts.length) return
    const tables = [],
      active = new Set()
    const walk = (node) => {
      if (!node || typeof node !== 'object' || active.has(node))
        throw new Error('invalid structure tree')
      active.add(node)
      if (node.role === 'Table') tables.push(node)
      for (const child of node.children ?? []) walk(child)
      active.delete(node)
    }
    walk(marked.structureTree)
    const selectedFonts = sourceFonts.filter((f) => taggedOwnerInside(f.rect, table.cropRect)),
      selectedIds = new Set(selectedFonts.map((f) => taggedOwnerKey(f.sourceItem))),
      candidates = []
    for (const tree of tables) {
      const ids = new Set(),
        rows = []
      if (!Array.isArray(tree.children) || tree.children.length < 4) continue
      let valid = true
      const gather = (node) => {
        if (node.role === 'Table') throw new Error('nested table')
        if (node.type === 'content') {
          if (typeof node.id !== 'string' || ids.has(node.id) || !byId.has(node.id))
            throw new Error('ambiguous table content')
          ids.add(node.id)
          return byId.get(node.id).filter((o) => o.sourceItem.text.trim())
        }
        if (node.type === 'object') throw new Error('foreign table object')
        return (node.children ?? []).flatMap(gather)
      }
      try {
        for (const [row, node] of tree.children.entries()) {
          if (node.role !== 'TR' || !Array.isArray(node.children)) throw new Error('table row role')
          const cells = node.children.map((cell) => {
            if (!['TH', 'TD'].includes(cell.role)) throw new Error('table cell role')
            return { role: cell.role, carriers: gather(cell) }
          })
          rows.push({ row, role: 'TR', cells })
        }
      } catch {
        valid = false
      }
      if (!valid) continue
      const origins = rows.flatMap((r) =>
        r.cells.flatMap((c) => c.carriers.map((o) => taggedOwnerKey(o.sourceItem)))
      )
      if (
        origins.length === selectedIds.size &&
        new Set(origins).size === origins.length &&
        origins.every((id) => selectedIds.has(id))
      )
        candidates.push(rows)
    }
    if (candidates.length !== 1) return
    const plan = taggedOwnerPlan(table, {
      structTreeRows: candidates[0],
      fullSourceProgram: { fonts: sourceFonts, rules }
    })
    if (!plan.qualified) return
    const parentFonts = new Map(),
      parentBands = new Map()
    for (const parent of plan.parents) {
      const fonts = parent.sourceItems.map((source) => {
        const matches = selectedFonts.filter((f) => fencedGroupOpaqueEqual(f.sourceItem, source))
        taggedOwnerDemand(matches.length === 1, 'exact parent source domain')
        return matches[0]
      })
      taggedOwnerDemand(fonts.length, 'nonempty parent source domain')
      parentFonts.set(parent, fonts)
    }
    const parentBounds = taggedOwnerCover([...parentFonts.values()].flat())
    for (const rule of rules.filter(
      (r) =>
        Array.isArray(r) &&
        r.length === 4 &&
        r.every(Number.isFinite) &&
        r[1] === r[3] &&
        r[0] < r[2] &&
        r[1] > table.cropRect[1] &&
        r[1] < parentBounds[1]
    )) {
      if (!parentBands.has(rule[1])) parentBands.set(rule[1], [])
      parentBands.get(rule[1]).push(rule)
    }
    const topBands = [...parentBands.values()].filter((segments) => segments.length > 1)
    if (topBands.length !== 1) return
    const parentDomains = new Map()
    for (const fonts of parentFonts.values()) {
      const bounds = taggedOwnerCover(fonts),
        segments = topBands[0].filter((r) => bounds[0] >= r[0] && bounds[2] <= r[2])
      if (segments.length !== 1) return
      // The planner has already proved this unique segment covers exactly the
      // parent's consecutive leaf lanes. Keep the same full span for every leaf.
      for (const font of fonts) {
        const id = taggedOwnerKey(font.sourceItem)
        if (parentDomains.has(id)) return
        parentDomains.set(id, [segments[0][0], segments[0][2]])
      }
    }
    const visibility = taggedOwnerVisiblePacket(
      content,
      operators,
      viewport,
      sourceFonts,
      graphics,
      table.cropRect,
      loaded,
      paths,
      parentDomains
    )
    if (!visibility.qualified) return
    const matchedGraphics = new Set()
    const quantize = (r) =>
      r.map((v, k) => {
        const size = Math.ceil(k % 2 ? viewport.height : viewport.width),
          byte = Math.max(
            0,
            Math.min(255, k < 2 ? Math.floor((v * 256) / size) : Math.ceil((v * 256) / size))
          )
        return ((byte + (k < 2 ? 0 : 1)) / 256) * size
      })
    for (const paint of visibility.paths) {
      const box = quantize(paint.rect),
        matches = graphics.flatMap((g, n) =>
          g.kind === 'path' && Array.isArray(g.rect) && g.rect.every((v, k) => v === box[k])
            ? [n]
            : []
        )
      if (matches.length !== 1 || matchedGraphics.has(matches[0])) return
      matchedGraphics.add(matches[0])
    }
    if (matchedGraphics.size !== graphics.length) return
    const collected = collectTableRules(operators, viewport),
      supporting = []
    const thickness =
      1.1 *
      Math.max(
        Math.hypot(viewport.transform[0], viewport.transform[1]),
        Math.hypot(viewport.transform[2], viewport.transform[3])
      )
    for (const rule of rules.filter(
      (r) =>
        Array.isArray(r) &&
        r.length === 4 &&
        r[1] === r[3] &&
        r[1] > table.cropRect[1] &&
        r[1] < table.cropRect[3]
    )) {
      if (collected.filter((r) => fencedGroupOpaqueEqual(r, rule)).length !== 1) return
      const matches = visibility.paths.filter(
        (p) =>
          p.color === '#000000' &&
          p.rect[3] - p.rect[1] <= thickness &&
          p.rect[2] - p.rect[0] >= 4 &&
          fencedGroupOpaqueEqual(
            [p.rect[0], (p.rect[1] + p.rect[3]) / 2, p.rect[2], (p.rect[1] + p.rect[3]) / 2],
            rule
          )
      )
      if (matches.length !== 1) return
      supporting.push(matches[0])
    }
    if (
      supporting.some((p) =>
        visibility.paths.some((later) => {
          if (!(
            later.n > p.n &&
            later.rect[0] < p.rect[2] &&
            later.rect[2] > p.rect[0] &&
            later.rect[1] < p.rect[3] &&
            later.rect[3] > p.rect[1]
          ))
            return false
          // Native rectangle borders may paint a thin endpoint over the preceding
          // black segment. Only an identical ink band and endpoint-sized overlap
          // proves that join preserves the supporting fence rather than occluding it.
          const overlap = Math.min(later.rect[2], p.rect[2]) - Math.max(later.rect[0], p.rect[0])
          const join =
            later.color === p.color &&
            later.rect[1] === p.rect[1] &&
            later.rect[3] === p.rect[3] &&
            overlap <= thickness &&
            ((later.rect[0] >= p.rect[2] - thickness && later.rect[2] > p.rect[2]) ||
              (later.rect[2] <= p.rect[0] + thickness && later.rect[0] < p.rect[0]))
          return !join
        })
      )
    )
      return
    if (visibility.owned.some((o) => sourceMarked.get(taggedOwnerKey(o.sourceItem)) !== o.mcid))
      return
    for (const font of selectedFonts) {
      const owners = visibility.owned.filter((o) =>
        fencedGroupOpaqueEqual(o.sourceItem, font.sourceItem)
      )
      if (
        owners.length !== 1 ||
        owners[0].fill === '#ffffff' ||
        visibility.paths.some(
          (p) =>
            p.n > owners[0].lastPaint &&
            p.rect[0] < font.rect[2] &&
            p.rect[2] > font.rect[0] &&
            p.rect[1] < font.rect[3] &&
            p.rect[3] > font.rect[1]
        )
      )
        return
    }
    const result = {
      ...structuredClone(table),
      grid: plan.grid,
      cells: plan.cells,
      unassigned: [],
      issues: (table.issues ?? []).filter((issue) => issue !== 'unassigned-source-text'),
      repairs: [...(table.repairs ?? []), 'native-tagged-header-group-owners-recovered']
    }
    if (witness) Object.defineProperty(result.unassigned, 'reconciliationItems', witness)
    return result
  } catch {
    return
  }
}
